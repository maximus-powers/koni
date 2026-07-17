import { readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { compileProfileConfiguration } from "../src/compiler/configuration.js";
import {
  RULE_AUTHORITY_EVIDENCE_PROTOCOL,
  createProductionRuleDomainAdapter,
  createRuleAuthorityEvidence,
  ruleInputGraphSha256,
  rulePredicateEvidenceKey,
} from "../src/compiler/domain-adapter.js";
import { GraphExpressionEvaluator } from "../src/compiler/expressions.js";
import { parseProfilePackageManifest, type VerifiedProfileBaseline } from "../src/compiler/profile-package.js";
import type { CompiledConfiguration, ConfigurationObject } from "../src/contracts/configuration.js";
import type { CompilerGraphNode, CompilerGraphProjection } from "../src/contracts/rules.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const temporaryRoots: string[] = [];
const NOW = "2026-07-16T20:00:00.000Z";

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("production compiler rule-domain adapter", () => {
  it("evaluates graph checks recursively and fails closed on receipt-backed checks", async () => {
    const root = await temporaryRoot();
    const configuration = compileProfile("research-profile");
    const hypothesis = node("hypothesis-a", "hypothesis", "Retrieval helps", "active");
    const emptyGraph = projection([hypothesis]);
    const emptyAdapter = await createProductionRuleDomainAdapter({ configuration, graph: emptyGraph, projectRoot: root });
    const empty = new GraphExpressionEvaluator(configuration, emptyGraph, emptyAdapter);
    empty.bind("target", [hypothesis.id]);
    expect(empty.evaluate({ op: "check_passed", check: "gap.hypothesis-formulation" })).toBe(true);
    expect(empty.evaluate({ op: "check_passed", check: "scoped-operational-probe" })).toBe(false);

    const groundedHypothesis = node(
      hypothesis.id,
      hypothesis.type,
      hypothesis.title,
      hypothesis.status,
      hypothesis.spec,
      { claims: ["claim-a"], literature: ["literature-a"] },
    );
    const groundedGraph = projection([
      groundedHypothesis,
      node("claim-a", "claim", "Bounded claim", "active"),
      node("literature-a", "literature", "Prior work", "active"),
    ]);
    const groundedAdapter = await createProductionRuleDomainAdapter({
      configuration,
      graph: groundedGraph,
      projectRoot: root,
    });
    const grounded = new GraphExpressionEvaluator(configuration, groundedGraph, groundedAdapter);
    grounded.bind("target", [hypothesis.id]);
    expect(grounded.evaluate({ op: "check_passed", check: "gap.hypothesis-formulation" })).toBe(false);
  });

  it("accepts dynamic predicates only through an exact authenticated snapshot key", async () => {
    const root = await temporaryRoot();
    const configuration = compileProfile("research-profile");
    const claim = node("claim-a", "claim", "Claim", "active");
    const graph = projection([claim]);
    const leaf: ConfigurationObject = { op: "current_receipt", receipt_type: "runtime.receipt" };
    const inputGraphSha256 = ruleInputGraphSha256(configuration, graph);
    const key = rulePredicateEvidenceKey({
      configurationSha256: configuration.configuration_sha256,
      inputGraphSha256,
      leaf,
      subjectNodeId: claim.id,
      bindings: { target: [claim.id] },
    });
    const evidence = createRuleAuthorityEvidence({
      protocol: RULE_AUTHORITY_EVIDENCE_PROTOCOL,
      configurationSha256: configuration.configuration_sha256,
      inputGraphSha256,
      predicates: {
        [key]: {
          key,
          result: true,
          recordedAt: NOW,
          sourceReceiptIds: ["receipt-runtime-a"],
        },
      },
    });
    const adapter = await createProductionRuleDomainAdapter({ configuration, graph, projectRoot: root, evidence });
    const evaluator = new GraphExpressionEvaluator(configuration, graph, adapter);
    evaluator.bind("target", [claim.id]);
    expect(evaluator.evaluate(leaf)).toBe(true);
    expect(evaluator.evaluate({ ...leaf, receipt_type: "different.receipt" })).toBe(false);

    const wrongGraph = projection([claim, node("claim-b", "claim", "Different epoch", "active")]);
    await expect(createProductionRuleDomainAdapter({
      configuration,
      graph: wrongGraph,
      projectRoot: root,
      evidence,
    })).rejects.toThrow(/does not match this compiler graph\/configuration snapshot/);
  });

  it("snapshots configured paths inside the canonical project root and rejects escapes or symlinks", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "notes.ts"), "export const notes = [];\n");
    const base = compileProfile("coding-profile");
    const configuration: CompiledConfiguration = {
      ...base,
      registries: {
        ...base.registries,
        checks: {
          ...base.registries.checks,
          "test.paths": {
            id: "test.paths",
            kind: "graph",
            predicate: {
              all: [
                { op: "path_exists", path: "src/notes.ts" },
                { not: { op: "path_exists", path: "../outside" } },
              ],
            },
          },
        },
      },
    };
    const objective = node("objective-a", "objective", "Notes", "active", { outcome: "Notes work" });
    const graph = projection([objective]);
    const adapter = await createProductionRuleDomainAdapter({ configuration, graph, projectRoot: root });
    const evaluator = new GraphExpressionEvaluator(configuration, graph, adapter);
    evaluator.bind("target", [objective.id]);
    expect(evaluator.evaluate({ op: "check_passed", check: "test.paths" })).toBe(true);
    expect(evaluator.evaluate({ op: "path_exists", path: "../outside" })).toBe(false);
  });

  it("uses configured gate applicability and ranked-first capability selection deterministically", async () => {
    const root = await temporaryRoot();
    const configuration = compileProfile("research-profile");
    const gate = node("gate-a", "gate", "Gate", "active", {
      assertion: "Verifier passes",
      applicability: "Claim A",
      capability: { name: "verifier", protocol_range: ">=1.0.0 <2.0.0" },
    }, { applies_to: ["claim-a"] });
    const preferred = node("asset-preferred", "asset", "Preferred verifier", "active", {
      capabilities: [{ name: "verifier", protocol_version: "1.3.0" }],
      gate_contracts: { "gate-a": { command: ["node", "verify.mjs"] } },
    });
    const fallback = node("asset-fallback", "asset", "Fallback verifier", "active", {
      capabilities: [{ name: "verifier", protocol_version: "1.4.0" }],
    });
    const claim = node("claim-a", "claim", "Claim A", "active");
    const graph = projection([fallback, claim, preferred, gate]);
    const adapter = await createProductionRuleDomainAdapter({ configuration, graph, projectRoot: root });
    const evaluator = new GraphExpressionEvaluator(configuration, graph, adapter);
    evaluator.bind("target", [claim.id]);
    expect(evaluator.select({
      policy_applicability: {
        policy: "research-capability-gates",
        subject: "$target",
        result: "direct_gates",
      },
    })).toEqual([gate.id]);
    evaluator.bind("gate", [gate.id]);
    expect(evaluator.select({
      policy_selection: {
        policy: "research-capability-gates",
        gate: "$gate",
        result: "selected",
      },
    })).toEqual([preferred.id]);
    evaluator.bind("target", [preferred.id]);
    expect(evaluator.evaluate({
      op: "gate_policy_selected",
      gate_policy: "research-capability-gates",
      gate_subject: "$gate",
    })).toBe(true);
    expect(evaluator.evaluate({
      op: "gate_policy_command_available",
      gate_policy: "research-capability-gates",
      gate_subject: "$gate",
    })).toBe(true);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "koni-rule-adapter-"));
  temporaryRoots.push(root);
  return root;
}

function compileProfile(packageDirectory: string): CompiledConfiguration {
  const result = compileProfileConfiguration(readBaseline(packageDirectory));
  if (!result.ok) throw new Error(diagnostics(result));
  return result.value;
}

function readBaseline(packageDirectory: string): VerifiedProfileBaseline {
  const packageRoot = resolve(repositoryRoot, "packages", packageDirectory, "koni");
  const manifest = parseProfilePackageManifest(
    readFileSync(join(packageRoot, "profile-manifest.json"), "utf8"),
  );
  if (!manifest.ok) throw new Error(diagnostics(manifest));
  return { manifest: manifest.value, files: readTree(join(packageRoot, "baseline")) };
}

function readTree(root: string): ReadonlyMap<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const candidate = join(directory, entry.name);
      if (entry.isDirectory()) visit(candidate);
      else if (entry.isFile()) files.set(relative(root, candidate).split(sep).join("/"), readFileSync(candidate));
    }
  };
  visit(root);
  return files;
}

function projection(nodes: readonly CompilerGraphNode[]): CompilerGraphProjection {
  return {
    nodes: () => nodes,
    node: (id) => nodes.find((candidate) => candidate.id === id),
  };
}

function node(
  id: string,
  type: string,
  title: string,
  status: string,
  spec: ConfigurationObject = {},
  edges: Readonly<Record<string, readonly string[]>> = {},
): CompilerGraphNode {
  return { id, type, title, status, spec, edges };
}

function diagnostics(result: { diagnostics: readonly { path: string; code: string; message: string }[] }): string {
  return result.diagnostics.map((item) => `${item.path}:${item.code}:${item.message}`).join("\n");
}
