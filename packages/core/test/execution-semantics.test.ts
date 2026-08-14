import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import {
  ExecutionSemanticCompilationError,
  compileExecutionSemanticCatalog,
} from "../src/compiler/execution-semantics.js";
import type { CompiledConfiguration, ConfigurationObject } from "../src/contracts/configuration.js";
import { canonicalHash } from "../src/shared/canonical.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const EXPECTED_CATALOG_SHA256 = {
  "coding-profile": "sha256:1d330c894b236f7f478fdb43217fc903cdf7646c0f9ce4f83573e139b6dd9eca",
  "research-profile": "sha256:178d191c1263d04f95286f3682cb346bef891a881561be1af5231dbe845f1521",
} as const;

describe("operation/workflow/check semantic catalog", () => {
  it.each(["coding-profile", "research-profile"])(
    "compiles every shipped %s policy into one frozen hash-bound catalog",
    (packageDirectory) => {
      const configuration = compileBaseline(packageDirectory);
      const catalog = compileExecutionSemanticCatalog(configuration);
      expect(catalog.sha256).toBe(
        EXPECTED_CATALOG_SHA256[packageDirectory as keyof typeof EXPECTED_CATALOG_SHA256],
      );
      expect(catalog.configurationSha256).toBe(configuration.configuration_sha256);
      expect(Object.keys(catalog.operations)).toEqual(
        Object.keys(configuration.registries.operations).sort(),
      );
      expect(Object.keys(catalog.workflows)).toEqual(
        Object.keys(configuration.registries.workflows).sort(),
      );
      expect(Object.keys(catalog.checks)).toEqual(
        Object.keys(configuration.registries.checks).sort(),
      );
      expect(Object.isFrozen(catalog)).toBe(true);
      expect(Object.isFrozen(Object.values(catalog.workflows)[0]?.steps)).toBe(true);
      if (packageDirectory === "research-profile") {
        expect(
          configuration.registries.operations["lifecycle.apply-change-request"]
            ?.allowed_existing_node_types,
        ).toContain("asset");
        expect(
          configuration.registries.operations["asset-resolution.prerequisite.plan-build-asset"],
        ).toMatchObject({
          max_new_nodes: 1,
          allowed_new_node_types: ["asset"],
        });
        expect(catalog.operations["lifecycle.change-request"]?.changeControl).toMatchObject({
          role: "proposal",
          decisionPolicy: "operator",
        });
      } else {
        expect(catalog.operations["lifecycle.change-request"]?.changeControl).toMatchObject({
          role: "proposal",
          decisionPolicy: "automatic",
        });
      }
      for (const workflow of Object.values(catalog.workflows)) {
        expect(workflow.version).toMatch(/^\d+\.\d+\.\d+$/u);
        expect(workflow.steps.every((step) => step.required)).toBe(true);
      }
    },
  );

  it("binds operation contracts, workflow versions, and check policy into semantic hashes", () => {
    const configuration = compileBaseline("coding-profile");
    const original = compileExecutionSemanticCatalog(configuration);
    const operationId = Object.keys(configuration.registries.operations).find(
      (id) => typeof configuration.registries.operations[id]?.output_contract === "string",
    )!;
    const workflowId = Object.keys(configuration.registries.workflows)[0]!;
    const checkId = Object.keys(configuration.registries.checks)[0]!;
    const effectCheckId = Object.keys(configuration.registries.checks).find((id) => {
      const source = configuration.registries.checks[id];
      return source?.kind === "command" && source.receipt_freshness !== "historical";
    })!;

    const contractEdit = editRegistry(configuration, "operations", operationId, (source) => {
      source.output_contract = `${String(source.output_contract ?? "")} changed`;
    });
    const versionEdit = editRegistry(configuration, "workflows", workflowId, (source) => {
      source.version = "99.0.0";
    });
    const policyEdit = editRegistry(configuration, "checks", checkId, (source) => {
      source.retry_policy = { max_attempts: 2, transient_exit_codes: [75], backoff_seconds: [1] };
    });
    const effectEdit = editRegistry(configuration, "checks", effectCheckId, (source) => {
      source.effect = "external";
    });

    expect(compileExecutionSemanticCatalog(contractEdit).operations[operationId]!.sha256).not.toBe(
      original.operations[operationId]!.sha256,
    );
    expect(compileExecutionSemanticCatalog(versionEdit).workflows[workflowId]!.sha256).not.toBe(
      original.workflows[workflowId]!.sha256,
    );
    expect(compileExecutionSemanticCatalog(policyEdit).checks[checkId]!.sha256).not.toBe(
      original.checks[checkId]!.sha256,
    );
    expect(compileExecutionSemanticCatalog(effectEdit).checks[effectCheckId]!.sha256).not.toBe(
      original.checks[effectCheckId]!.sha256,
    );
  });

  it("fails closed for optional steps without a compiler skip predicate", () => {
    const configuration = compileBaseline("coding-profile");
    const workflowId = Object.keys(configuration.registries.workflows)[0]!;
    const edited = editRegistry(configuration, "workflows", workflowId, (source) => {
      const steps = structuredClone(source.steps) as ConfigurationObject[];
      steps[0] = { ...steps[0]!, required: false };
      source.steps = steps;
    });
    expectCompilationError(
      () => compileExecutionSemanticCatalog(edited),
      "execution.optional_step_unsupported",
    );
  });

  it("reopens only the exact unreferenced retired stock browser check", () => {
    const configuration = compileBaseline("coding-profile");
    const retired = structuredClone(configuration) as unknown as Record<string, unknown>;
    const registries = retired.registries as Record<string, Record<string, ConfigurationObject>>;
    registries.checks!["browser-smoke"] = {
      id: "browser-smoke",
      kind: "agent",
      applies_to: ["establish-proof"],
      timeout_seconds: 900,
      receipt_type: "browser_smoke",
      effect: "external",
    };

    const catalog = compileExecutionSemanticCatalog(retired as unknown as CompiledConfiguration);
    expect(catalog.checks["browser-smoke"]).toBeUndefined();

    const customized = structuredClone(retired);
    const customizedRegistries = customized.registries as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    customizedRegistries.checks!["browser-smoke"]!.receipt_type = "project_browser_smoke";
    expectCompilationError(
      () => compileExecutionSemanticCatalog(customized as unknown as CompiledConfiguration),
      "execution.check_kind",
    );

    const referenced = structuredClone(retired);
    const referencedRegistries = referenced.registries as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const workflow = Object.values(referencedRegistries.workflows!)[0]!;
    const steps = workflow.steps as Record<string, unknown>[];
    steps[0]!.checks = [...((steps[0]!.checks as string[] | undefined) ?? []), "browser-smoke"];
    expectCompilationError(
      () => compileExecutionSemanticCatalog(referenced as unknown as CompiledConfiguration),
      "execution.workflow_check",
    );
  });

  it("rejects retry ambiguity and unbounded backoff before authority execution", () => {
    const configuration = compileBaseline("research-profile");
    const checkId = Object.keys(configuration.registries.checks).find(
      (id) => configuration.registries.checks[id]?.kind === "command",
    )!;
    const overlapping = editRegistry(configuration, "checks", checkId, (source) => {
      source.expected_exit_codes = [75];
      source.retry_policy = { max_attempts: 2, transient_exit_codes: [75], backoff_seconds: [0] };
    });
    const excessBackoff = editRegistry(configuration, "checks", checkId, (source) => {
      source.retry_policy = {
        max_attempts: 2,
        transient_exit_codes: [75],
        backoff_seconds: [0, 1],
      };
    });
    expectCompilationError(
      () => compileExecutionSemanticCatalog(overlapping),
      "execution.retry_exit_overlap",
    );
    expectCompilationError(
      () => compileExecutionSemanticCatalog(excessBackoff),
      "execution.retry_backoff_count",
    );
  });

  it("rejects undeclared edge-only authority and malformed portfolio guidance", () => {
    const configuration = compileBaseline("research-profile");
    const operationId = Object.keys(configuration.registries.operations).find(
      (id) =>
        configuration.registries.operations[id]?.existing_node_edge_additions_only !== undefined,
    )!;
    const invalidEdge = editRegistry(configuration, "operations", operationId, (source) => {
      const restricted = structuredClone(source.existing_node_edge_additions_only) as Record<
        string,
        unknown
      >;
      const nodeType = Object.keys(restricted)[0]!;
      restricted[nodeType] = ["not-a-declared-relation"];
      source.existing_node_edge_additions_only = restricted;
    });
    const invalidGuidance = editRegistry(configuration, "operations", operationId, (source) => {
      source.portfolio_guidance = {
        preferred_count: 2,
        unit: "program",
        group_when: "shared setup",
        split_when: "different subjects",
        avoid: "atomization",
        typo: true,
      };
    });
    expectCompilationError(
      () => compileExecutionSemanticCatalog(invalidEdge),
      "execution.edge_only_relation",
    );
    expectCompilationError(
      () => compileExecutionSemanticCatalog(invalidGuidance),
      "execution.unknown_field",
    );
  });
});

function compileBaseline(packageDirectory: string): CompiledConfiguration {
  // Bundle manifests are intentionally regenerated only after the shared source tree freezes.
  // This focused semantic test reads the current checked-in YAML directly so concurrent profile
  // work cannot turn a policy test into a stale-manifest failure.
  const baselineRoot = resolve(repositoryRoot, "packages", packageDirectory, "koni", "baseline");
  const registries = Object.fromEntries(
    [
      "node_types",
      "queries",
      "graph_constraints",
      "gate_policies",
      "rules",
      "operations",
      "workflows",
      "actions",
      "checks",
      "personas",
      "reports",
      "views",
      "state_machines",
      "agents",
    ].map((key) => [key, Object.create(null)]),
  ) as unknown as CompiledConfiguration["registries"];
  const edgeTypes: ConfigurationObject[] = [];
  for (const [path, bytes] of readTree(baselineRoot)) {
    if (!path.endsWith(".yaml")) continue;
    const document = YAML.parse(Buffer.from(bytes).toString("utf8")) as Record<string, unknown>;
    for (const registry of ["operations", "workflows", "checks"] as const) {
      const entries = document[registry];
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const value = entry as ConfigurationObject;
        if (typeof value.id === "string") {
          (registries[registry] as Record<string, ConfigurationObject>)[value.id] = value;
        }
      }
    }
    const edges = document.edge_types;
    if (Array.isArray(edges)) edgeTypes.push(...(edges as ConfigurationObject[]));
  }
  const material = { registries, edge_types: edgeTypes };
  return {
    configuration_sha256: canonicalHash(material),
    registries,
    edge_types: edgeTypes,
  } as unknown as CompiledConfiguration;
}

function readTree(root: string): ReadonlyMap<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) {
        files.set(relative(root, absolute).split(sep).join("/"), readFileSync(absolute));
      }
    }
  };
  visit(root);
  return files;
}

function editRegistry(
  configuration: CompiledConfiguration,
  registry: "operations" | "workflows" | "checks",
  id: string,
  edit: (source: Record<string, unknown>) => void,
): CompiledConfiguration {
  const clone = structuredClone(configuration) as unknown as Record<string, unknown>;
  const registries = clone.registries as Record<string, Record<string, Record<string, unknown>>>;
  edit(registries[registry]![id]!);
  return clone as unknown as CompiledConfiguration;
}

function expectCompilationError(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("expected semantic compilation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ExecutionSemanticCompilationError);
    expect((error as ExecutionSemanticCompilationError).code).toBe(code);
  }
}
