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
import {
  parseProfilePackageManifest,
  type VerifiedProfileBaseline,
} from "../src/compiler/profile-package.js";
import type { CompiledConfiguration, ConfigurationObject } from "../src/contracts/configuration.js";
import type { CompilerGraphNode, CompilerGraphProjection } from "../src/contracts/rules.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const temporaryRoots: string[] = [];
const NOW = "2026-07-16T20:00:00.000Z";

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("production compiler rule-domain adapter", () => {
  it("evaluates graph checks recursively and fails closed on receipt-backed checks", async () => {
    const root = await temporaryRoot();
    const configuration = compileProfile("research-profile");
    const hypothesis = node("hypothesis-a", "hypothesis", "Retrieval helps", "active");
    const emptyGraph = projection([hypothesis]);
    const emptyAdapter = await createProductionRuleDomainAdapter({
      configuration,
      graph: emptyGraph,
      projectRoot: root,
    });
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
    expect(grounded.evaluate({ op: "check_passed", check: "gap.hypothesis-formulation" })).toBe(
      false,
    );
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
    const adapter = await createProductionRuleDomainAdapter({
      configuration,
      graph,
      projectRoot: root,
      evidence,
    });
    const evaluator = new GraphExpressionEvaluator(configuration, graph, adapter);
    evaluator.bind("target", [claim.id]);
    expect(evaluator.evaluate(leaf)).toBe(true);
    expect(evaluator.evaluate({ ...leaf, receipt_type: "different.receipt" })).toBe(false);

    const wrongGraph = projection([claim, node("claim-b", "claim", "Different epoch", "active")]);
    await expect(
      createProductionRuleDomainAdapter({
        configuration,
        graph: wrongGraph,
        projectRoot: root,
        evidence,
      }),
    ).rejects.toThrow(/does not match this compiler graph\/configuration snapshot/);
  });

  it("recognizes a current gate terminal from its authenticated configured receipt", async () => {
    const root = await temporaryRoot();
    const configuration = compileProfile("research-profile");
    const gate = node(
      "gate-a",
      "gate",
      "Expected-red gate",
      "active",
      {
        assertion: "Verifier executes",
        applicability: "Claim A",
        capability: { name: "verifier", protocol_range: ">=1.0.0 <2.0.0" },
      },
      { applies_to: ["claim-a"] },
    );
    const asset = node("asset-a", "asset", "Verifier", "active", {
      capabilities: [{ name: "verifier", protocol_version: "1.0.0" }],
      gate_contracts: { "gate-a": { argv: ["node", "verify.mjs"] } },
    });
    const graph = projection([gate, asset, node("claim-a", "claim", "Claim A", "active")]);
    const inputGraphSha256 = ruleInputGraphSha256(configuration, graph);
    const receiptLeaf: ConfigurationObject = {
      op: "current_receipt",
      receipt_type: "gate.receipt",
    };
    const receiptKey = rulePredicateEvidenceKey({
      configurationSha256: configuration.configuration_sha256,
      inputGraphSha256,
      leaf: receiptLeaf,
      subjectNodeId: gate.id,
      bindings: {},
    });
    const evidence = createRuleAuthorityEvidence({
      protocol: RULE_AUTHORITY_EVIDENCE_PROTOCOL,
      configurationSha256: configuration.configuration_sha256,
      inputGraphSha256,
      predicates: {
        [receiptKey]: {
          key: receiptKey,
          result: true,
          recordedAt: NOW,
          sourceReceiptIds: ["receipt-gate-a"],
          leaf: receiptLeaf,
          subjectNodeId: gate.id,
          bindings: {},
        },
      },
    });
    const adapter = await createProductionRuleDomainAdapter({
      configuration,
      graph,
      projectRoot: root,
      evidence,
    });
    const evaluator = new GraphExpressionEvaluator(configuration, graph, adapter);
    evaluator.bind("target", [gate.id]);

    expect(
      evaluator.evaluate({
        op: "gate_policy_has_current_terminal",
        gate_policy: "research-capability-gates",
        gate_subject: "$target",
      }),
    ).toBe(true);
  });

  it("reads refused gate receipts from recorder-canonical keys regardless of caller context", async () => {
    const root = await temporaryRoot();
    const configuration = compileProfile("research-profile");
    const gate = node("gate-a", "gate", "Expected-red gate", "active");
    const asset = node("asset-a", "asset", "Verifier-owning asset", "active");
    const graph = projection([gate, asset]);
    const inputGraphSha256 = ruleInputGraphSha256(configuration, graph);
    // Two leaf shapes reference the same gate: run-gate reaches it as $target, the asset-reopen
    // block in ticket.implement-asset reaches it as $candidate_gate. The recorder stores one entry
    // per configured leaf, keyed by the gate with every referenced binding mapped to the gate id.
    const gateLeaf: ConfigurationObject = {
      op: "gate_policy_receipt_refused",
      gate_policy: "research-capability-gates",
      gate_subject: "$target",
    };
    const assetContextLeaf: ConfigurationObject = {
      op: "gate_policy_receipt_refused",
      gate_policy: "research-capability-gates",
      gate_subject: "$candidate_gate",
    };
    const predicates = Object.fromEntries(
      [gateLeaf, assetContextLeaf].map((leaf) => {
        const binding = String(leaf.gate_subject).slice(1);
        const key = rulePredicateEvidenceKey({
          configurationSha256: configuration.configuration_sha256,
          inputGraphSha256,
          leaf,
          subjectNodeId: gate.id,
          bindings: { [binding]: [gate.id] },
        });
        return [key, { key, result: true, recordedAt: NOW, sourceReceiptIds: ["receipt-gate-a"] }];
      }),
    );
    const evidence = createRuleAuthorityEvidence({
      protocol: RULE_AUTHORITY_EVIDENCE_PROTOCOL,
      configurationSha256: configuration.configuration_sha256,
      inputGraphSha256,
      predicates,
    });
    const adapter = await createProductionRuleDomainAdapter({
      configuration,
      graph,
      projectRoot: root,
      evidence,
    });
    const evaluator = new GraphExpressionEvaluator(configuration, graph, adapter);

    // From the gate's own context (ticket.run-gate).
    evaluator.bind("target", [gate.id]);
    expect(evaluator.evaluate(gateLeaf)).toBe(true);

    // From a foreign subject (ticket.implement-asset iterating gates from an asset target): the
    // ambient subject is the asset, and only the bound name reaches the gate. Ambient-context
    // keying would miss here, which is exactly how the accepted-but-nonpassing reopen logic went
    // dead in the field; the refused predicate must not repeat that.
    const foreign = new GraphExpressionEvaluator(configuration, graph, adapter);
    foreign.bind("target", [asset.id]);
    foreign.bind("candidate_gate", [gate.id]);
    expect(foreign.evaluate(assetContextLeaf)).toBe(true);

    // No evidence for the current snapshot means "never ran", which must stay false so the gate
    // still dispatches for its first execution.
    const emptyAdapter = await createProductionRuleDomainAdapter({
      configuration,
      graph,
      projectRoot: root,
    });
    const fresh = new GraphExpressionEvaluator(configuration, graph, emptyAdapter);
    fresh.bind("target", [gate.id]);
    expect(fresh.evaluate(gateLeaf)).toBe(false);
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
    const objective = node("objective-a", "objective", "Notes", "active", {
      outcome: "Notes work",
    });
    const graph = projection([objective]);
    const adapter = await createProductionRuleDomainAdapter({
      configuration,
      graph,
      projectRoot: root,
    });
    const evaluator = new GraphExpressionEvaluator(configuration, graph, adapter);
    evaluator.bind("target", [objective.id]);
    expect(evaluator.evaluate({ op: "check_passed", check: "test.paths" })).toBe(true);
    expect(evaluator.evaluate({ op: "path_exists", path: "../outside" })).toBe(false);
  });

  it("uses configured gate applicability and ranked-first capability selection deterministically", async () => {
    const root = await temporaryRoot();
    const configuration = compileProfile("research-profile");
    const gate = node(
      "gate-a",
      "gate",
      "Gate",
      "active",
      {
        assertion: "Verifier passes",
        applicability: "Claim A",
        capability: { name: "verifier", protocol_range: ">=1.0.0 <2.0.0" },
      },
      { applies_to: ["claim-a"] },
    );
    const preferred = node("asset-preferred", "asset", "Preferred verifier", "active", {
      capabilities: [{ name: "verifier", protocol_version: "1.3.0" }],
      gate_contracts: { "gate-a": { argv: ["node", "verify.mjs"] } },
    });
    const fallback = node("asset-fallback", "asset", "Fallback verifier", "active", {
      capabilities: [{ name: "verifier", protocol_version: "1.4.0" }],
    });
    const claim = node("claim-a", "claim", "Claim A", "active");
    const graph = projection([fallback, claim, preferred, gate]);
    const adapter = await createProductionRuleDomainAdapter({
      configuration,
      graph,
      projectRoot: root,
    });
    const evaluator = new GraphExpressionEvaluator(configuration, graph, adapter);
    evaluator.bind("target", [claim.id]);
    expect(
      evaluator.select({
        policy_applicability: {
          policy: "research-capability-gates",
          subject: "$target",
          result: "direct_gates",
        },
      }),
    ).toEqual([gate.id]);
    evaluator.bind("gate", [gate.id]);
    expect(
      evaluator.select({
        policy_selection: {
          policy: "research-capability-gates",
          gate: "$gate",
          result: "selected",
        },
      }),
    ).toEqual([preferred.id]);
    evaluator.bind("target", [preferred.id]);
    expect(
      evaluator.evaluate({
        op: "gate_policy_selected",
        gate_policy: "research-capability-gates",
        gate_subject: "$gate",
      }),
    ).toBe(true);
    expect(
      evaluator.evaluate({
        op: "gate_policy_command_available",
        gate_policy: "research-capability-gates",
        gate_subject: "$gate",
      }),
    ).toBe(true);
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
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const candidate = join(directory, entry.name);
      if (entry.isDirectory()) visit(candidate);
      else if (entry.isFile())
        files.set(relative(root, candidate).split(sep).join("/"), readFileSync(candidate));
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

function diagnostics(result: {
  diagnostics: readonly { path: string; code: string; message: string }[];
}): string {
  return result.diagnostics.map((item) => `${item.path}:${item.code}:${item.message}`).join("\n");
}
