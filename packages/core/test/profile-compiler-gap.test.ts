import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { compileProfileConfiguration } from "../src/compiler/configuration.js";
import { createProductionRuleDomainAdapter } from "../src/compiler/domain-adapter.js";
import { GraphExpressionEvaluator } from "../src/compiler/expressions.js";
import { parseProfilePackageManifest, type VerifiedProfileBaseline } from "../src/compiler/profile-package.js";
import { evaluateConfiguredRules } from "../src/compiler/rules.js";
import type { CompiledConfiguration, ConfigurationObject } from "../src/contracts/configuration.js";
import type { CompilerGraphNode, CompilerGraphProjection } from "../src/contracts/rules.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("shipped profile compiler production seams", () => {
  it("binds a Bug Fix objective query locally before emitting ground-defect work", async () => {
    const projectRoot = await temporaryRoot();
    const configuration = compileProfile("coding-profile");
    const objective = node("objective-bug", "objective", "Repair note pinning", "active", {
      outcome: "Pinned notes remain pinned after reload.",
      work_kind: "bug_fix",
    });
    const graph = projection([objective]);
    const adapter = await createProductionRuleDomainAdapter({ configuration, graph, projectRoot });

    const result = evaluateConfiguredRules(
      { configuration, graph },
      { ruleIds: ["objective.ground-defect"], adapter },
    );

    expect(result.ok, diagnostics(result)).toBe(true);
    if (!result.ok) return;
    expect(result.value.tickets).toEqual([
      expect.objectContaining({
        rule_id: "objective.ground-defect",
        operation: "ground-defect",
        anchor_node_id: objective.id,
        target_node_ids: [objective.id],
      }),
    ]);
  });

  it("evaluates Research graph checks through the production adapter and keeps receipt checks false", async () => {
    const projectRoot = await temporaryRoot();
    const configuration = compileProfile("research-profile");
    const hypothesis = node("hypothesis-a", "hypothesis", "Retrieval improves recall", "active");
    const graph = projection([hypothesis]);

    const missingAdapter = evaluateConfiguredRules(
      { configuration, graph },
      { ruleIds: ["stage.formulation"] },
    );
    expect(missingAdapter).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: "expression.domain_adapter_required" })],
    });

    const adapter = await createProductionRuleDomainAdapter({ configuration, graph, projectRoot });
    const compiled = evaluateConfiguredRules(
      { configuration, graph },
      { ruleIds: ["stage.formulation"], adapter },
    );
    expect(compiled.ok, diagnostics(compiled)).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.value.program_state).toMatchObject({
      active_stage: "formulation",
      constitution_state: "building",
    });

    const receiptBacked = configuration.registries.checks["scoped-operational-probe"];
    expect(receiptBacked?.kind).not.toBe("graph");
    const evaluator = new GraphExpressionEvaluator(configuration, graph, adapter);
    evaluator.bind("target", [hypothesis.id]);
    expect(evaluator.evaluate({ op: "check_passed", check: "scoped-operational-probe" })).toBe(false);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "koni-profile-gap-"));
  temporaryRoots.push(root);
  return root;
}

function compileProfile(packageDirectory: "coding-profile" | "research-profile"): CompiledConfiguration {
  const result = compileProfileConfiguration(readBaseline(packageDirectory));
  if (!result.ok) throw new Error(diagnostics(result));
  return result.value;
}

function readBaseline(packageDirectory: "coding-profile" | "research-profile"): VerifiedProfileBaseline {
  const packageRoot = resolve(repositoryRoot, "packages", packageDirectory, "koni");
  const manifest = parseProfilePackageManifest(readFileSync(join(packageRoot, "profile-manifest.json"), "utf8"));
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
  return { nodes: () => nodes, node: (id) => nodes.find((candidate) => candidate.id === id) };
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
