import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compileProfileConfiguration } from "../src/compiler/configuration.js";
import { projectGraphSchemaDefinition } from "../src/compiler/graph-schema.js";
import {
  ExpressionEvaluationError,
  GraphExpressionEvaluator,
  type RuleDomainAdapter,
} from "../src/compiler/expressions.js";
import {
  parseProfilePackageManifest,
  type VerifiedProfileBaseline,
} from "../src/compiler/profile-package.js";
import {
  deterministicTicketId,
  evaluateConfiguredRules,
  expandPythonPackageReadPaths,
} from "../src/compiler/rules.js";
import { researchConstitutionRunPlanFallback } from "../src/compiler/run-program.js";
import { resolveCompiledAgent, resolveCompiledRunType } from "../src/compiler/resolution.js";
import type { CompiledConfiguration, ConfigurationObject } from "../src/contracts/configuration.js";
import type { CompilerGraphNode, CompilerGraphProjection } from "../src/contracts/rules.js";
import { GraphSchema, TypedGraph, type GraphNode } from "../src/graph/model.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe("deterministic graph expression and rule compiler", () => {
  it("projects both frozen profile registries into directly consumable graph schemas", () => {
    for (const packageDirectory of ["coding-profile", "research-profile"]) {
      const result = projectGraphSchemaDefinition(compileProfile(packageDirectory));
      expect(result.ok, diagnostics(result)).toBe(true);
      if (!result.ok) continue;
      expect(() => new GraphSchema(result.value)).not.toThrow();
      expect(result.value.nodeTypes.length).toBeGreaterThan(0);
      expect(result.value.nodeTypes.every((nodeType) => nodeType.description.length > 0)).toBe(
        true,
      );
      if (packageDirectory === "coding-profile") {
        expect(result.value.nodeTypes.find((nodeType) => nodeType.id === "delivery")).toMatchObject(
          {
            compiler_owned_fields: expect.arrayContaining(["spec.target_branch"]),
            agent_visible_compiler_owned_fields: expect.arrayContaining(["spec.target_branch"]),
            compiler_field_sources: { "spec.target_branch": "run.git.target.ref" },
          },
        );
      }
      expect(Object.isFrozen(result.value)).toBe(true);
    }
  });

  it("fails graph-schema projection before consumers receive a semantically invalid definition", () => {
    const configuration = compileProfile("coding-profile");
    const invalid: CompiledConfiguration = {
      ...configuration,
      edge_types: [
        ...configuration.edge_types,
        { source: "missing-node-type", relation: "breaks", targets: ["objective"] },
      ],
    };
    const result = projectGraphSchemaDefinition(invalid);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "graph_schema.semantic",
    );
  });

  it("resolves default run types and effective persona settings without launch-time duplication", () => {
    const configuration = compileProfile("coding-profile");
    const defaultRunType = resolveCompiledRunType(configuration);
    expect(defaultRunType.ok).toBe(true);
    if (defaultRunType.ok) expect(defaultRunType.value.id).toBe("continuous-improvement");

    const planner = resolveCompiledAgent(configuration, "run-planner", { runTypeId: "small" });
    expect(planner.ok, diagnostics(planner)).toBe(true);
    if (!planner.ok) return;
    expect(planner.value.id).toBe("run-planner");
    expect(planner.value.provider).toBe("openai-codex");
    expect(planner.value.model).toBe("gpt-5.6-terra");
    expect(planner.value.thinking_level).toBe("xhigh");
    expect(planner.value.instructions).toContain("Work only in the read-only planning checkout");
    expect(planner.value.capabilities.workspace_access).toBe("read_only");
    expect(Object.isFrozen(planner.value)).toBe(true);

    const stageOverride = resolveCompiledAgent(configuration, "run-planner", {
      runTypeId: "small",
      model: "stage-model",
      thinkingLevel: "max",
    });
    expect(stageOverride.ok).toBe(true);
    if (stageOverride.ok) {
      expect(stageOverride.value.model).toBe("stage-model");
      expect(stageOverride.value.thinking_level).toBe("max");
    }
  });

  it("compiles a coding architecture ticket with operation, workflow, scope, and stable identity", () => {
    const configuration = compileProfile("coding-profile");
    const objective = node("objective-a", "objective", "Build notes", "active", {
      outcome: "Users can keep notes",
    });
    const first = evaluateConfiguredRules(
      { configuration, graph: projection([objective]) },
      { ruleIds: ["objective.map-architecture"] },
    );
    expect(first.ok, diagnostics(first)).toBe(true);
    if (!first.ok) return;
    expect(first.value.tickets).toHaveLength(1);
    const ticket = first.value.tickets[0]!;
    expect(ticket.id).toBe(
      deterministicTicketId(
        "objective.map-architecture",
        ["objective-a"],
        "objective-without-affected-boundary",
        configuration.configuration_sha256,
      ),
    );
    expect(ticket.operation_registry_id).toBe("architecture.objective.map");
    expect(ticket.workflow_id).toBe("architecture-map");
    expect(ticket.review_failure_reopen_from).toBe("map-affected-boundary");
    expect(ticket.scope.read_paths).toEqual(["."]);
    expect(ticket.workflow.map((step) => [step.id, step.persona_id, step.kind])).toEqual([
      ["map-affected-boundary", "architecture-mapper", "production"],
      ["review", "reviewer", "review"],
    ]);
    expect(ticket.title).toBe("Ground the affected boundary for Build notes");
    expect(Object.isFrozen(first.value)).toBe(true);
    expect(Object.isFrozen(ticket.workflow)).toBe(true);

    const reordered = evaluateConfiguredRules(
      { configuration, graph: projection([objective]) },
      { ruleIds: ["objective.map-architecture"] },
    );
    expect(reordered.ok).toBe(true);
    if (reordered.ok) expect(reordered.value.evaluation_sha256).toBe(first.value.evaluation_sha256);
  });

  it("rejects review rework routes whose owner cannot durably repair the finding", () => {
    const configuration = compileProfile("coding-profile");
    const workflow = structuredClone(configuration.registries.workflows["architecture-map"]!);
    const steps = workflow.steps as ConfigurationObject[];
    steps[0] = {
      ...steps[0]!,
      graph_mutation: "forbidden",
      write_paths: [],
    };
    const invalid: CompiledConfiguration = {
      ...configuration,
      registries: {
        ...configuration.registries,
        workflows: {
          ...configuration.registries.workflows,
          "architecture-map": workflow,
        },
      },
    };
    const result = evaluateConfiguredRules(
      {
        configuration: invalid,
        graph: projection([
          node("objective-a", "objective", "Build notes", "active", {
            outcome: "Users can keep notes",
          }),
        ]),
      },
      { ruleIds: ["objective.map-architecture"] },
    );
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toContain("rule.review_rework_no_effect");
  });

  it("suppresses an architecture ticket after the bidirectional semantic boundary exists", () => {
    const configuration = compileProfile("coding-profile");
    const objective = node(
      "objective-a",
      "objective",
      "Build notes",
      "active",
      { outcome: "Notes" },
      {
        systems: ["system-a"],
      },
    );
    const system = node("system-a", "system", "Notes app", "active", {
      kind: "app",
      responsibility: "Store notes",
      contract_required: false,
      contract_reason: "Local behavior",
      owned_paths: ["src"],
    });
    const result = evaluateConfiguredRules(
      { configuration, graph: projection([system, objective]) },
      { ruleIds: ["objective.map-architecture"] },
    );
    expect(result.ok, diagnostics(result)).toBe(true);
    if (result.ok) expect(result.value.tickets).toEqual([]);
  });

  it("compiles a run plan from a complete constitution before research gates pass", () => {
    const configuration = compileProfile("research-profile");
    const experiment = node(
      "experiment-a",
      "experiment",
      "Run A",
      "draft",
      { ablation_requirement: "required" },
      {
        methods: ["method-a"],
        metrics: ["metric-a"],
        ablations: ["ablation-a"],
        requires: ["prerequisite-a"],
      },
    );
    const graph = projection([
      experiment,
      node("method-a", "method", "Method", "draft"),
      node("metric-a", "metric", "Metric", "draft"),
      node("ablation-a", "ablation", "Ablation", "draft"),
      node("prerequisite-a", "prerequisite", "Prerequisite", "draft"),
    ]);
    const adapter: RuleDomainAdapter = {
      evaluatePredicate: () => false,
      selectPolicy: () => [],
    };
    const result = evaluateConfiguredRules(
      { configuration, graph },
      {
        ruleIds: ["readiness.experiment-constitution", "ticket.compile-run-plan"],
        includeGatePolicyFacts: true,
        adapter,
      },
    );
    expect(result.ok, diagnostics(result)).toBe(true);
    if (!result.ok) return;
    expect(result.value.facts).toContainEqual(
      expect.objectContaining({
        kind: "readiness",
        anchor_node_id: "experiment-a",
        value: "blocked",
      }),
    );
    expect(result.value.input_graph_sha256).not.toBe(result.value.derived_graph_sha256);
    expect(result.value.tickets).toHaveLength(1);
    expect(result.value.tickets[0]?.operation_registry_id).toBe("execution.node.compile-run-plan");
  });

  it("compiles an observation plan when its experiment records that ablation is not applicable", () => {
    const configuration = compileProfile("research-profile");
    const experiment = node(
      "experiment-observation",
      "experiment",
      "Bounded observation",
      "draft",
      { ablation_requirement: "not_applicable" },
      {
        methods: ["method-observation"],
        metrics: ["metric-observation"],
        requires: ["prerequisite-observation"],
      },
    );
    const graph = projection([
      experiment,
      node("method-observation", "method", "Method", "draft"),
      node("metric-observation", "metric", "Metric", "draft"),
      node("prerequisite-observation", "prerequisite", "Prerequisite", "draft"),
    ]);
    const adapter: RuleDomainAdapter = {
      evaluatePredicate: () => false,
      selectPolicy: () => [],
    };
    const result = evaluateConfiguredRules(
      { configuration, graph },
      {
        ruleIds: [
          "readiness.experiment-constitution",
          "ticket.experiment-constitution",
          "ticket.compile-run-plan",
        ],
        includeGatePolicyFacts: true,
        adapter,
      },
    );

    expect(result.ok, diagnostics(result)).toBe(true);
    if (!result.ok) return;
    expect(result.value.tickets).toHaveLength(1);
    expect(result.value.tickets[0]?.operation_registry_id).toBe("execution.node.compile-run-plan");
  });

  it("routes every ablation disposition state to constitution repair or run planning", () => {
    const configuration = compileProfile("research-profile");
    const adapter: RuleDomainAdapter = {
      evaluatePredicate: () => false,
      selectPolicy: () => [],
    };
    const cases = [
      { name: "missing disposition", disposition: undefined, hasAblation: false, ready: false },
      {
        name: "required without ablation",
        disposition: "required",
        hasAblation: false,
        ready: false,
      },
      {
        name: "not applicable with dangling ablation",
        disposition: "not_applicable",
        hasAblation: true,
        ready: false,
      },
      { name: "required with ablation", disposition: "required", hasAblation: true, ready: true },
      {
        name: "not applicable without ablation",
        disposition: "not_applicable",
        hasAblation: false,
        ready: true,
      },
    ] as const;

    for (const testCase of cases) {
      const suffix = testCase.name.replaceAll(" ", "-");
      const methodId = `method-${suffix}`;
      const metricId = `metric-${suffix}`;
      const prerequisiteId = `prerequisite-${suffix}`;
      const ablationId = `ablation-${suffix}`;
      const graph = projection([
        node(
          `experiment-${suffix}`,
          "experiment",
          testCase.name,
          "draft",
          testCase.disposition === undefined ? {} : { ablation_requirement: testCase.disposition },
          {
            methods: [methodId],
            metrics: [metricId],
            requires: [prerequisiteId],
            ...(testCase.hasAblation ? { ablations: [ablationId] } : {}),
          },
        ),
        node(methodId, "method", "Method", "draft"),
        node(metricId, "metric", "Metric", "draft"),
        node(prerequisiteId, "prerequisite", "Prerequisite", "draft"),
        ...(testCase.hasAblation ? [node(ablationId, "ablation", "Ablation", "draft")] : []),
      ]);
      const result = evaluateConfiguredRules(
        { configuration, graph },
        {
          ruleIds: [
            "readiness.experiment-constitution",
            "ticket.experiment-constitution",
            "ticket.compile-run-plan",
          ],
          includeGatePolicyFacts: true,
          adapter,
        },
      );

      expect(result.ok, `${testCase.name}: ${diagnostics(result)}`).toBe(true);
      if (!result.ok) continue;
      expect(result.value.tickets, testCase.name).toHaveLength(1);
      expect(result.value.tickets[0]?.operation_registry_id, testCase.name).toBe(
        testCase.ready
          ? "execution.node.compile-run-plan"
          : "preparation.experiment.design-experiment",
      );
    }
  });

  it("repairs pinned research rules that gate run planning on final readiness", () => {
    const configuration = withQueries(compileProfile("research-profile"), {
      "run-plan-targets": {
        id: "run-plan-targets",
        node_types: ["experiment", "ablation"],
        status_excluding: ["satisfied", "archived", "superseded"],
        where: {
          op: "field_equals",
          field: "readiness.state",
          value: "ready",
        },
      },
    });
    const experiment = node(
      "experiment-legacy",
      "experiment",
      "Legacy complete experiment",
      "draft",
      {
        objective: "Measure one bounded outcome",
        target_claim_summary: "Discriminate the bounded claim",
        empirical_mode: "observation",
        execution_protocol: "Run the bounded fixture",
        observable_outcome: "One measured score",
      },
      {
        methods: ["method-a"],
        metrics: ["metric-a"],
        ablations: ["ablation-a"],
        requires: ["prerequisite-a"],
      },
    );
    const graph = projection([
      experiment,
      node("method-a", "method", "Method", "draft", { approach: "Bounded method" }),
      node("metric-a", "metric", "Metric", "draft", {
        name: "score",
        definition: "The bounded score",
      }),
      node("ablation-a", "ablation", "Ablation", "draft", {
        controlled_difference: "One controlled difference",
        decision_key: "fixture_difference",
        summary: "A bounded ablation",
      }),
      node("prerequisite-a", "prerequisite", "Prerequisite", "draft", {
        required_asset_type: "fixture",
        validation_approach: "Check the fixture",
      }),
    ]);
    const adapter: RuleDomainAdapter = {
      evaluatePredicate: () => false,
      selectPolicy: () => [],
    };
    const evaluated = evaluateConfiguredRules(
      { configuration, graph },
      {
        ruleIds: ["readiness.experiment-constitution", "ticket.compile-run-plan"],
        includeGatePolicyFacts: true,
        adapter,
      },
    );
    expect(evaluated.ok, diagnostics(evaluated)).toBe(true);
    if (!evaluated.ok) return;
    expect(evaluated.value.tickets).toEqual([]);

    const repaired = researchConstitutionRunPlanFallback(
      configuration,
      typedGraph(configuration, graph.nodes()),
      evaluated.value,
    );

    expect(repaired.tickets).toHaveLength(1);
    expect(repaired.tickets[0]).toMatchObject({
      operation_registry_id: "execution.node.compile-run-plan",
      target_node_ids: ["experiment-legacy"],
    });
  });

  it("compiles the research formulation ticket once and independently of graph input order", () => {
    const configuration = compileProfile("research-profile");
    const hypothesis = node("hypothesis-a", "hypothesis", "Sparse notes improve recall", "active", {
      hypothesis: "Sparse notes improve recall",
    });
    const context = node("context-a", "literature", "Unrelated context", "archived");
    const left = evaluateConfiguredRules(
      { configuration, graph: projection([hypothesis, context]) },
      { ruleIds: ["ticket.formulation"] },
    );
    const right = evaluateConfiguredRules(
      { configuration, graph: projection([context, hypothesis]) },
      { ruleIds: ["ticket.formulation"] },
    );
    expect(left.ok, diagnostics(left)).toBe(true);
    expect(right.ok, diagnostics(right)).toBe(true);
    if (!left.ok || !right.ok) return;
    expect(left.value.tickets).toHaveLength(1);
    expect(left.value.tickets[0]?.operation_registry_id).toBe(
      "formulation.hypothesis.drill-hypothesis",
    );
    expect(left.value.tickets[0]?.workflow.map((step) => step.id)).toEqual([
      "drill-claims",
      "map-related-work",
      "integrate",
      "review",
    ]);
    expect(right.value.evaluation_sha256).toBe(left.value.evaluation_sha256);
  });

  it("projects safe graph paths and fails closed on escaping path authority", () => {
    const configuration = compileProfile("coding-profile");
    const system = node("system-a", "system", "API", "active", {
      kind: "service",
      responsibility: "Serve notes",
      contract_required: true,
      contract_reason: "Public API",
      owned_paths: ["packages/api", "packages/api/src"],
    });
    const good = evaluateConfiguredRules(
      { configuration, graph: projection([system]) },
      { ruleIds: ["system.specify-contracts"] },
    );
    expect(good.ok, diagnostics(good)).toBe(true);
    if (good.ok)
      expect(good.value.tickets[0]?.scope.read_paths).toEqual(["packages/api", "packages/api/src"]);

    const unsafe = { ...system, spec: { ...system.spec, owned_paths: ["../secrets"] } };
    const bad = evaluateConfiguredRules(
      { configuration, graph: projection([unsafe]) },
      { ruleIds: ["system.specify-contracts"] },
    );
    expect(bad.ok).toBe(false);
    expect(bad.diagnostics.map((item) => item.code)).toContain("rule.path_scope");
  });

  it("grants Python package initializers needed to import an exact read-scoped module", () => {
    expect(
      expandPythonPackageReadPaths([
        "model_zoo/hypernet/paired_contrast.py",
        "program/assets/signature_analysis",
      ]),
    ).toEqual([
      "model_zoo/__init__.py",
      "model_zoo/hypernet/__init__.py",
      "model_zoo/hypernet/paired_contrast.py",
      "program/assets/signature_analysis",
    ]);
  });

  it("normalizes inverse edges, set algebra, vacuous quantifiers, and recursive query errors", () => {
    const configuration = compileProfile("research-profile");
    const claim = node("claim-a", "claim", "Claim", "active");
    const experiment = node(
      "experiment-a",
      "experiment",
      "Experiment",
      "draft",
      {},
      {
        target_claims: ["claim-a"],
      },
    );
    const evaluator = new GraphExpressionEvaluator(configuration, projection([experiment, claim]));
    evaluator.bind("target", ["claim-a"]);
    expect(
      evaluator.select({
        traverse: {
          from: "$target",
          relation: "tested_by",
          max_depth: 1,
          node_types: ["experiment"],
        },
      }),
    ).toEqual(["experiment-a"]);
    expect(
      evaluator.select({
        difference: {
          left: { union: ["claim", "experiment"] },
          right: { intersection: ["experiment", { ids: ["experiment-a"] }] },
        },
      }),
    ).toEqual(["claim-a"]);
    expect(
      evaluator.evaluate({
        for_all: {
          select: { nodes: { node_types: ["asset"] } },
          bind: "asset",
          satisfies: { op: "field_present", subject: "$asset", field: "spec.root" },
        },
      }),
    ).toBe(true);

    const recursive = withQueries(configuration, {
      "recursive-a": { id: "recursive-a", select: "recursive-b" },
      "recursive-b": { id: "recursive-b", select: "recursive-a" },
    });
    expect(() =>
      new GraphExpressionEvaluator(recursive, projection([claim])).select("recursive-a"),
    ).toThrowError(/recursive query/);
  });

  it("requires explicit domain adapters and validates their selected nodes", () => {
    const configuration = compileProfile("research-profile");
    const claim = node("claim-a", "claim", "Claim", "active");
    const evaluator = new GraphExpressionEvaluator(configuration, projection([claim]));
    evaluator.bind("target", ["claim-a"]);
    expect(() => evaluator.evaluate({ op: "check_passed", check: "gate-verifier" })).toThrowError(
      ExpressionEvaluationError,
    );

    const adapter: RuleDomainAdapter = {
      evaluatePredicate: (leaf, context) =>
        leaf.op === "check_passed" && context.subject?.id === "claim-a",
      selectPolicy: () => ["missing-node"],
    };
    const adapted = new GraphExpressionEvaluator(configuration, projection([claim]), adapter);
    adapted.bind("target", ["claim-a"]);
    expect(adapted.evaluate({ op: "check_passed", check: "gate-verifier" })).toBe(true);
    expect(() =>
      adapted.select({
        policy_applicability: { policy: "research-capability-gates", subject: "$target" },
      }),
    ).toThrow(/missing node/);
  });

  it("fails closed when operation resolution is ambiguous", () => {
    const configuration = compileProfile("coding-profile");
    const duplicate: ConfigurationObject = {
      ...configuration.registries.operations["architecture.objective.map"]!,
      id: "architecture.objective.map-copy",
    };
    const ambiguous = withOperations(configuration, {
      "architecture.objective.map-copy": duplicate,
    });
    const result = evaluateConfiguredRules(
      {
        configuration: ambiguous,
        graph: projection([
          node("objective-a", "objective", "Objective", "active", { outcome: "Done" }),
        ]),
      },
      { ruleIds: ["objective.map-architecture"] },
    );
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toContain("rule.ambiguous_operation");
  });
});

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
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile())
        files.set(relative(root, path).split(sep).join("/"), readFileSync(path));
    }
  };
  visit(root);
  return files;
}

function projection(nodes: readonly CompilerGraphNode[]): CompilerGraphProjection {
  return {
    nodes: () => nodes,
    node: (id) => nodes.find((node) => node.id === id),
  };
}

function typedGraph(
  configuration: CompiledConfiguration,
  nodes: readonly CompilerGraphNode[],
): TypedGraph {
  const projected = projectGraphSchemaDefinition(configuration);
  if (!projected.ok) throw new Error(diagnostics(projected));
  return new TypedGraph(
    new GraphSchema(projected.value),
    nodes.map((value): GraphNode => ({
      schema_version: "1.0",
      id: value.id,
      type: value.type,
      title: value.title,
      status: value.status,
      spec: structuredClone(value.spec) as GraphNode["spec"],
      edges: Object.fromEntries(
        Object.entries(value.edges).map(([relation, targets]) => [relation, [...targets]]),
      ),
      annotations: structuredClone(value.annotations ?? {}) as GraphNode["annotations"],
    })),
  );
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

function withQueries(
  configuration: CompiledConfiguration,
  additions: Readonly<Record<string, ConfigurationObject>>,
): CompiledConfiguration {
  return {
    ...configuration,
    registries: {
      ...configuration.registries,
      queries: { ...configuration.registries.queries, ...additions },
    },
  };
}

function withOperations(
  configuration: CompiledConfiguration,
  additions: Readonly<Record<string, ConfigurationObject>>,
): CompiledConfiguration {
  return {
    ...configuration,
    registries: {
      ...configuration.registries,
      operations: { ...configuration.registries.operations, ...additions },
    },
  };
}

function diagnostics(result: {
  diagnostics: readonly { path: string; code: string; message: string }[];
}): string {
  return result.diagnostics.map((item) => `${item.path}:${item.code}:${item.message}`).join("\n");
}
