import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  RULE_AUTHORITY_EVIDENCE_PROTOCOL,
  createProductionRuleDomainAdapter,
  createRuleAuthorityEvidence,
  ruleInputGraphSha256,
  rulePredicateEvidenceKey,
} from "../src/compiler/domain-adapter.js";
import { projectGraphSchemaDefinition } from "../src/compiler/graph-schema.js";
import { compileProfileConfiguration } from "../src/compiler/configuration.js";
import {
  computeProfileBundleSha256,
  parseProfilePackageManifest,
  type VerifiedProfileBaseline,
} from "../src/compiler/profile-package.js";
import {
  authorizeStateTransition,
  compileStateMachineCatalog,
  evaluateConfiguredRules,
} from "../src/compiler/rules.js";
import { rebindRuleEvidenceAcrossNonInterferingGraphChange } from "../src/compiler/run-program.js";
import type {
  CompiledConfiguration,
  CompiledConfigurationRegistries,
  ConfigurationObject,
} from "../src/contracts/configuration.js";
import type { CompilerGraphProjection } from "../src/contracts/rules.js";
import { DynamicGraphContextSelector } from "../src/graph/context-selector.js";
import {
  GraphSchema,
  GraphValidationError,
  TypedGraph,
  createGraphContextualState,
  type GraphNode,
} from "../src/graph/model.js";
import {
  canonicalHash,
  compareUtf8,
  rawSha256,
  type Sha256Digest,
} from "../src/shared/canonical.js";

const temporaryRoots: string[] = [];
const NOW = "2026-07-18T12:00:00.000Z";
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("graph and rules semantic closure", () => {
  it("keeps passing gate evidence across unrelated graph motion but drops it on gate-context drift", () => {
    const configuration = fixtureConfiguration({ withGatePolicy: true });
    const schema = projectedSchema(configuration);
    const claim = claimNode();
    const gate = gateNode({ applies_to: [claim.id] });
    const verifier = assetNode("1.0.0", { validates: [gate.id] });
    const unrelated = experimentNode("active", "An unrelated bounded observation");
    const before = new TypedGraph(schema, [claim, gate, verifier, unrelated]);
    const leaf: ConfigurationObject = {
      op: "gate_policy_satisfied",
      gate_policy: "research-gates",
      gate_subject: "$target",
    };
    const bindings = { target: [gate.id] };
    const beforeSha256 = ruleInputGraphSha256(configuration, before);
    const key = rulePredicateEvidenceKey({
      configurationSha256: configuration.configuration_sha256,
      inputGraphSha256: beforeSha256,
      leaf,
      subjectNodeId: gate.id,
      bindings,
    });
    const evidence = createRuleAuthorityEvidence({
      protocol: RULE_AUTHORITY_EVIDENCE_PROTOCOL,
      configurationSha256: configuration.configuration_sha256,
      inputGraphSha256: beforeSha256,
      predicates: {
        [key]: {
          key,
          result: true,
          receiptStatus: "passed",
          recordedAt: NOW,
          sourceReceiptIds: ["receipt-gate-a"],
          leaf,
          subjectNodeId: gate.id,
          bindings,
        },
      },
    });
    const unrelatedAfter = new TypedGraph(schema, [
      claim,
      gate,
      verifier,
      { ...unrelated, title: "Unrelated observation revised" },
    ]);
    expect(
      Object.values(
        rebindRuleEvidenceAcrossNonInterferingGraphChange({
          configuration,
          before,
          after: unrelatedAfter,
          evidence,
        })?.predicates ?? {},
      ),
    ).toEqual([
      expect.objectContaining({ result: true, receiptStatus: "passed", subjectNodeId: gate.id }),
    ]);

    const changedVerifier = {
      ...verifier,
      spec: { ...verifier.spec, root: "tools/verifier-v2" },
    };
    expect(
      rebindRuleEvidenceAcrossNonInterferingGraphChange({
        configuration,
        before,
        after: new TypedGraph(schema, [claim, gate, changedVerifier, unrelated]),
        evidence,
      }),
    ).toBeUndefined();
  });

  it("compiles the current Coding and Research baselines through every new semantic catalog", () => {
    const coding = compileCurrentProfile("coding-profile");
    const research = compileCurrentProfile("research-profile");
    const codingCatalog = compileStateMachineCatalog(coding);
    const researchCatalog = compileStateMachineCatalog(research);
    expect(codingCatalog).toMatchObject({ ok: true });
    expect(researchCatalog).toMatchObject({ ok: true });
    if (codingCatalog.ok && researchCatalog.ok) {
      expect(Object.keys(codingCatalog.value.machines).sort()).toEqual(["run", "ticket"]);
      expect(Object.keys(researchCatalog.value.machines).sort()).toEqual(["run", "ticket"]);
      expect(
        authorizeStateTransition(codingCatalog.value, {
          machineId: "run",
          from: "active",
          to: "failed",
          actor: "compiler",
        }),
      ).toMatchObject({ allowed: true, transition: { id: "fail" } });
      expect(
        authorizeStateTransition(codingCatalog.value, {
          machineId: "ticket",
          from: "in_progress",
          to: "queued",
          actor: "compiler",
        }),
      ).toMatchObject({ allowed: true, transition: { id: "interrupt-active" } });
      expect(
        authorizeStateTransition(codingCatalog.value, {
          machineId: "ticket",
          from: "blocked",
          to: "closed",
          actor: "compiler",
        }),
      ).toMatchObject({ allowed: true, transition: { id: "resolve-blocked" } });
      expect(
        authorizeStateTransition(codingCatalog.value, {
          machineId: "ticket",
          from: "closed",
          to: "queued",
          actor: "compiler",
        }),
      ).toMatchObject({ allowed: true, transition: { id: "reopen-stale-obligation" } });
      expect(
        authorizeStateTransition(researchCatalog.value, {
          machineId: "ticket",
          from: "closed",
          to: "queued",
          actor: "compiler",
        }),
      ).toMatchObject({ allowed: true, transition: { id: "reopen-stale-obligation" } });
      expect(
        authorizeStateTransition(researchCatalog.value, {
          machineId: "run",
          from: "failed",
          to: "stopped",
          actor: "human",
        }),
      ).toMatchObject({ allowed: true, transition: { id: "cleanup-failed" } });
    }
    const projected = projectGraphSchemaDefinition(research);
    expect(projected.ok, diagnostics(projected)).toBe(true);
    if (!projected.ok) return;
    expect(
      projected.value.nodeTypes.find((node) => node.id === "experiment")?.annotations,
    ).toMatchObject({ ontology_contract: { category: "empirical_execution" } });
    expect(
      projected.value.nodeTypes
        .filter((node) => node.gate_required)
        .map((node) => node.id)
        .sort(),
    ).toEqual(["ablation", "claim", "experiment", "method", "metric", "prerequisite"]);
    expect(
      projected.value.edgeTypes.find((edge) => edge.relation === "validates")?.when,
    ).toMatchObject({ op: "gate_policy_compatible", gate_policy: "research-capability-gates" });
  });

  it("projects ontology annotations and Rust-compatible semantic identity into bounded agent context", () => {
    const configuration = fixtureConfiguration();
    const schema = projectedSchema(configuration);
    const original = new TypedGraph(schema, [experimentNode("draft", "Measure recall")]);
    const statusOnly = new TypedGraph(schema, [experimentNode("active", "Measure recall")]);
    const semanticChange = new TypedGraph(schema, [experimentNode("active", "Measure precision")]);

    expect(original.semanticHash("experiment-a")).toBe(statusOnly.semanticHash("experiment-a"));
    expect(original.semanticHash("experiment-a")).not.toBe(
      semanticChange.semanticHash("experiment-a"),
    );
    expect(original.semanticProjection("experiment-a")).toEqual({
      schema_version: "1.0",
      id: "experiment-a",
      type: "experiment",
      title: "Experiment A",
      spec: { objective: "Measure recall" },
      edges: {},
    });

    const contextual = createGraphContextualState("run-root");
    const selected = new DynamicGraphContextSelector().select({
      cacheKey: "ignored",
      identity: {
        runId: "run-a",
        ticketId: "ticket-a",
        stepId: "step-a",
        attemptId: "attempt-a",
        sessionId: "session-a",
        personaId: "worker",
        grantHash: digest("grant"),
        launchSpecHash: digest("launch"),
        generation: 0,
      },
      objective: "Measure recall",
      runUpdatedAt: NOW,
      semanticRevision: 0,
      semanticHash: original.hash,
      contextual,
      graph: original,
      nodePaths: { "experiment-a": [] },
      ticketTargetIds: ["experiment-a"],
      stepTargetIds: ["experiment-a"],
      scopedPaths: [],
      compatibleAttemptIds: new Set(["attempt-a"]),
      abandonedAttemptIds: new Set(),
      maxInputTokens: 20_000,
    });
    const record = selected.envelope.records.find(
      (candidate) => candidate.kind === "semantic_node",
    );
    expect(record).toMatchObject({
      kind: "semantic_node",
      semanticSha256: original.semanticHash("experiment-a"),
      nodeTypeContract: {
        description: "An executable empirical observation.",
        gateRequired: false,
        annotations: { ontology_contract: { category: "empirical_execution" } },
      },
    });
    expect(selected.envelope.binding.schemaHash).toBe(original.schemaHash);
  });

  it("enforces capability-compatible edge predicates and stores reciprocal gate edges once", () => {
    const configuration = fixtureConfiguration({ withGatePolicy: true });
    const schema = projectedSchema(configuration);
    const compatible = new TypedGraph(schema, [
      claimNode(),
      gateNode({ applies_to: ["claim-a"] }),
      assetNode("1.2.0", { validates: ["gate-a"] }),
    ]);
    expect(compatible.neighbors("claim-a", "gates").map((node) => node.id)).toEqual(["gate-a"]);
    expect(compatible.node("claim-a")?.edges).toEqual({});
    expect(compatible.node("gate-a")?.edges.applies_to).toEqual(["claim-a"]);

    expect(
      () =>
        new TypedGraph(schema, [
          claimNode(),
          gateNode({ applies_to: ["claim-a"] }),
          assetNode("2.0.0", { validates: ["gate-a"] }),
        ]),
    ).toThrowError(GraphValidationError);

    const invalid = rehashed(configuration, {
      edge_types: configuration.edge_types.map((edge) =>
        edge.relation === "validates" ? { ...edge, when: { op: "always" } } : edge,
      ),
    });
    const projected = projectGraphSchemaDefinition(invalid);
    expect(projected.ok).toBe(false);
    expect(projected.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "graph_schema.edge_predicate",
    );
  });

  it("materializes missing/unsatisfied gate obligations, exact context, templates, and receipt statuses", async () => {
    const root = await mkdtemp(join(tmpdir(), "koni-gate-closure-"));
    temporaryRoots.push(root);
    const configuration = fixtureConfiguration({ withGatePolicy: true, withStateMachines: true });
    const missingGraph = projection([claimNode()]);
    const missingAdapter = await createProductionRuleDomainAdapter({
      configuration,
      graph: missingGraph,
      projectRoot: root,
    });
    const missing = evaluateConfiguredRules(
      { configuration, graph: missingGraph },
      { adapter: missingAdapter },
    );
    expect(missing.ok, diagnostics(missing)).toBe(true);
    if (!missing.ok) return;
    expect(missing.value.facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "obligation", key: "required.claim-a" }),
        expect.objectContaining({ kind: "readiness", value: "blocked" }),
      ]),
    );

    const nodes = [
      claimNode(),
      gateNode({ applies_to: ["claim-a"] }),
      assetNode("1.2.0", { validates: ["gate-a"] }),
    ];
    const graph = projection(nodes);
    const leaf: ConfigurationObject = {
      op: "gate_policy_satisfied",
      gate_policy: "research-gates",
      gate_subject: "$gate",
    };
    const inputGraphSha256 = ruleInputGraphSha256(configuration, graph);
    const key = rulePredicateEvidenceKey({
      configurationSha256: configuration.configuration_sha256,
      inputGraphSha256,
      leaf,
      subjectNodeId: "gate-a",
      bindings: { gate: ["gate-a"], target: ["gate-a"] },
    });
    const acceptedReceipt = createRuleAuthorityEvidence({
      protocol: RULE_AUTHORITY_EVIDENCE_PROTOCOL,
      configurationSha256: configuration.configuration_sha256,
      inputGraphSha256,
      predicates: {
        [key]: {
          key,
          result: true,
          receiptStatus: "accepted",
          recordedAt: NOW,
          sourceReceiptIds: ["receipt-gate-a"],
        },
      },
    });
    const blockedAdapter = await createProductionRuleDomainAdapter({
      configuration,
      graph,
      projectRoot: root,
      evidence: acceptedReceipt,
    });
    const blocked = evaluateConfiguredRules({ configuration, graph }, { adapter: blockedAdapter });
    expect(blocked.ok, diagnostics(blocked)).toBe(true);
    if (!blocked.ok) return;
    expect(blocked.value.facts).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "obligation", key: "gate.gate-a" })]),
    );
    expect(blocked.value.gate_policy_contexts).toEqual([
      expect.objectContaining({
        policy_id: "research-gates",
        gate_node_id: "gate-a",
        winner_node_id: "asset-a",
        evaluation_target_node_ids: ["claim-a"],
        context_node_ids: ["asset-a", "claim-a", "gate-a"],
        read_paths: ["tools/verifier"],
      }),
    ]);

    const acceptsAccepted = withPassingStatuses(configuration, ["accepted"]);
    const acceptedGraphSha = ruleInputGraphSha256(acceptsAccepted, graph);
    const acceptedKey = rulePredicateEvidenceKey({
      configurationSha256: acceptsAccepted.configuration_sha256,
      inputGraphSha256: acceptedGraphSha,
      leaf,
      subjectNodeId: "gate-a",
      bindings: { gate: ["gate-a"], target: ["gate-a"] },
    });
    const evidence = createRuleAuthorityEvidence({
      protocol: RULE_AUTHORITY_EVIDENCE_PROTOCOL,
      configurationSha256: acceptsAccepted.configuration_sha256,
      inputGraphSha256: acceptedGraphSha,
      predicates: {
        [acceptedKey]: {
          key: acceptedKey,
          result: true,
          receiptStatus: "accepted",
          recordedAt: NOW,
          sourceReceiptIds: ["receipt-gate-a"],
        },
      },
    });
    const passingAdapter = await createProductionRuleDomainAdapter({
      configuration: acceptsAccepted,
      graph,
      projectRoot: root,
      evidence,
    });
    const passing = evaluateConfiguredRules(
      { configuration: acceptsAccepted, graph },
      { adapter: passingAdapter },
    );
    expect(passing.ok, diagnostics(passing)).toBe(true);
    if (passing.ok)
      expect(passing.value.facts.filter((fact) => fact.anchor_node_id === "claim-a")).toEqual([]);
  });

  it("compiles exact finite lifecycle catalogs and authorizes only configured actor transitions", () => {
    const configuration = fixtureConfiguration({ withStateMachines: true });
    const result = compileStateMachineCatalog(configuration);
    expect(result.ok, diagnostics(result)).toBe(true);
    if (!result.ok) return;
    expect(
      authorizeStateTransition(result.value, {
        machineId: "ticket",
        from: "queued",
        to: "in_progress",
        actor: "compiler",
      }),
    ).toMatchObject({ allowed: true, transition: { id: "start" } });
    expect(
      authorizeStateTransition(result.value, {
        machineId: "ticket",
        from: "queued",
        to: "in_progress",
        actor: "human",
      }),
    ).toEqual({ allowed: false, reason: "actor_not_allowed" });
    expect(
      authorizeStateTransition(result.value, {
        machineId: "research",
        from: "reporting",
        to: "active",
        actor: "compiler",
      }),
    ).toMatchObject({ allowed: true, transition: { id: "invalidate" } });

    for (const transitionPatch of [
      { guard: { op: "always" } },
      { from: ["missing"] },
      { actors: ["unconfigured-persona"] },
    ]) {
      const invalid = mutateFirstTicketTransition(configuration, transitionPatch);
      expect(compileStateMachineCatalog(invalid).ok).toBe(false);
    }

    const ticket = configuration.registries.state_machines.ticket!;
    const unreachable = rehashed(configuration, {
      registries: {
        ...configuration.registries,
        state_machines: {
          ...configuration.registries.state_machines,
          ticket: {
            ...ticket,
            states: [...(ticket.states as readonly string[]), "orphaned"],
          },
        },
      },
    });
    const unreachableResult = compileStateMachineCatalog(unreachable);
    expect(unreachableResult.ok).toBe(false);
    expect(unreachableResult.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "state_machine.unreachable_state",
    );
  });

  it("requires gate_required to equal the required-subject union", () => {
    const configuration = fixtureConfiguration({ withGatePolicy: true });
    const claim = { ...configuration.registries.node_types.claim, gate_required: false };
    const invalid = rehashed(configuration, {
      registries: {
        ...configuration.registries,
        node_types: { ...configuration.registries.node_types, claim },
      },
    });
    const result = projectGraphSchemaDefinition(invalid);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "graph_schema.gate_required",
    );
  });
});

function fixtureConfiguration(
  options: { withGatePolicy?: boolean; withStateMachines?: boolean } = {},
): CompiledConfiguration {
  const experiment: ConfigurationObject = {
    id: "experiment",
    description: "An executable empirical observation.",
    statuses: ["draft", "active"],
    initial_status: "draft",
    semantic_fields: ["schema_version", "id", "type", "title", "spec", "edges"],
    compiler_owned_fields: ["status", "readiness"],
    gate_required: false,
    annotations: { ontology_contract: { category: "empirical_execution" } },
    required_any: [["objective"]],
    fields: { objective: { type: "string", required: true } },
  };
  const claim: ConfigurationObject = {
    id: "claim",
    description: "A bounded claim.",
    statuses: ["active", "archived", "superseded"],
    initial_status: "active",
    semantic_fields: ["schema_version", "id", "type", "title", "spec", "edges"],
    compiler_owned_fields: ["status", "readiness", "obligations"],
    gate_required: options.withGatePolicy ?? false,
    fields: { statement: { type: "string" } },
  };
  const gate: ConfigurationObject = {
    id: "gate",
    description: "A configured verifier gate.",
    statuses: ["active"],
    initial_status: "active",
    gate_required: false,
    fields: { capability: { type: "json", required: true } },
  };
  const asset: ConfigurationObject = {
    id: "asset",
    description: "An executable verifier asset.",
    statuses: ["active"],
    initial_status: "active",
    gate_required: false,
    fields: {
      capabilities: { type: "json", required: true },
      root: { type: "path", required: true },
    },
  };
  const gatePolicy: ConfigurationObject = {
    id: "research-gates",
    description: "Select one capability-compatible verifier.",
    gate_node_types: ["gate"],
    gate_subjects: { nodes: { node_types: ["gate"], statuses: ["active"] } },
    candidate_node_types: ["asset"],
    candidate_pool: { nodes: { node_types: ["asset"], statuses: ["active"] } },
    evaluation_targets: {
      select: {
        traverse: {
          from: "$gate",
          relation: "applies_to",
          direction: "outgoing",
          min_depth: 1,
          max_depth: 1,
        },
      },
      cardinality: "exactly_one",
    },
    capability: {
      required_name_fields: ["spec.capability.name"],
      required_version_req_fields: ["spec.capability.protocol_range"],
      provider_collection_fields: ["spec.capabilities"],
      provider_name_fields: ["name"],
      provider_version_fields: ["protocol_version"],
    },
    selection: {
      mode: "ranked_first",
      ranks: [{ id: "compatible", kind: "compatible" }],
      tie_break: { field: "id", direction: "ascending" },
    },
    passing_receipt_statuses: ["passed"],
    obligation_key_template: "gate.{{ gate.id }}",
    missing_gate_obligation_key_template: "required.{{ subject.id }}",
    applicability: {
      subject_node_types: ["claim"],
      required_subject_node_types: ["claim"],
      context_class_order: ["claim"],
      direct_gates: {
        traverse: {
          from: "$subject",
          relation: "applies_to",
          direction: "incoming",
          min_depth: 1,
          max_depth: 1,
          node_types: ["gate"],
        },
      },
      inherited_gates: {
        traverse: {
          from: "$ancestors",
          relation: "applies_to",
          direction: "incoming",
          min_depth: 1,
          max_depth: 1,
          node_types: ["gate"],
        },
      },
      context: { union: ["$subject", "$ancestors"] },
      context_classes: { claim: { nodes: { node_types: ["claim"] } } },
    },
    context: {
      select: { union: ["$gate", "$evaluation_targets", "$winner"] },
      read_paths: [{ select: "$winner", field: "spec.root" }],
    },
  };
  const empty = Object.freeze(Object.create(null) as Record<string, ConfigurationObject>);
  const stateMachines = options.withStateMachines
    ? {
        ticket: {
          id: "ticket",
          initial: "queued",
          states: ["queued", "in_progress", "closed"],
          terminal_states: ["closed"],
          transitions: [
            { id: "start", from: ["queued"], to: "in_progress", actors: ["compiler", "lead"] },
            { id: "finish", from: ["in_progress"], to: "closed", actors: ["compiler"] },
          ],
        },
        run: {
          id: "run",
          initial: "active",
          states: ["active", "paused", "concluded"],
          terminal_states: ["concluded"],
          transitions: [
            { id: "pause", from: ["active"], to: "paused", actors: ["human"] },
            { id: "conclude", from: ["active", "paused"], to: "concluded", actors: ["compiler"] },
          ],
        },
        gate: {
          id: "gate",
          initial: "pending",
          states: ["pending", "ready", "running", "complete"],
          terminal_states: ["complete"],
          transitions: [
            { id: "ready", from: ["pending"], to: "ready", actors: ["compiler"] },
            { id: "begin", from: ["ready"], to: "running", actors: ["compiler"] },
            { id: "complete", from: ["running"], to: "complete", actors: ["compiler"] },
          ],
        },
        research: {
          id: "research",
          initial: "active",
          states: ["active", "reporting", "concluded"],
          terminal_states: ["concluded"],
          transitions: [
            { id: "report", from: ["active"], to: "reporting", actors: ["compiler"] },
            { id: "conclude", from: ["reporting"], to: "concluded", actors: ["compiler"] },
            {
              id: "invalidate",
              from: ["reporting", "concluded"],
              to: "active",
              actors: ["compiler"],
            },
          ],
        },
      }
    : empty;
  const registries: CompiledConfigurationRegistries = {
    node_types: { experiment, claim, gate, asset },
    queries: empty,
    graph_constraints: empty,
    gate_policies: options.withGatePolicy ? { "research-gates": gatePolicy } : empty,
    rules: empty,
    operations: empty,
    workflows: empty,
    actions: empty,
    checks: empty,
    personas: { lead: { id: "lead" }, reviewer: { id: "reviewer" } },
    reports: empty,
    views: empty,
    state_machines: stateMachines,
    agents: { lead: { id: "lead" }, reviewer: { id: "reviewer" } },
  };
  const edgeTypes: ConfigurationObject[] = options.withGatePolicy
    ? [
        {
          source: "asset",
          relation: "validates",
          targets: ["gate"],
          when: {
            op: "gate_policy_compatible",
            gate_policy: "research-gates",
            subject: "$source",
            gate_subject: "$target",
          },
        },
        {
          source: "gate",
          relation: "applies_to",
          targets: ["claim"],
          bidirectional: true,
          inverse: "gates",
        },
      ]
    : [];
  const material = {
    protocol: "koni.compiled-configuration.v1" as const,
    schema_version: "3.0" as const,
    package: {
      name: "@koni/semantic-closure-fixture",
      version: "1.0.0",
      profile_id: "semantic-closure",
      profile_version: "1.0.0",
      profile_lineage: "semantic-closure@1",
    },
    baseline_bundle_sha256: digest("baseline"),
    effective_bundle_sha256: digest("effective"),
    profile: {},
    project: {},
    modules: {
      graph: [],
      rules: [],
      operations: [],
      workflows: [],
      actions: [],
      checks: [],
      reports: [],
      cockpit: [],
      lifecycles: [],
    },
    run_type_order: [],
    run_types: {},
    agents: {
      lead: {
        id: "lead",
        path: "agents/lead.yaml",
        source_sha256: digest("lead-agent"),
        document: { id: "lead" },
      },
      reviewer: {
        id: "reviewer",
        path: "agents/reviewer.yaml",
        source_sha256: digest("reviewer-agent"),
        document: { id: "reviewer" },
      },
    },
    edge_types: edgeTypes,
    registries,
    behavior: {} as CompiledConfiguration["behavior"],
  };
  return Object.freeze({ ...material, configuration_sha256: canonicalHash(material) });
}

function projectedSchema(configuration: CompiledConfiguration): GraphSchema {
  const result = projectGraphSchemaDefinition(configuration);
  expect(result.ok, diagnostics(result)).toBe(true);
  if (!result.ok) throw new Error("graph schema fixture did not compile");
  return new GraphSchema(result.value);
}

function experimentNode(status: "draft" | "active", objective: string): GraphNode {
  return {
    schema_version: "1.0",
    id: "experiment-a",
    type: "experiment",
    title: "Experiment A",
    status,
    spec: { objective },
    edges: {},
    annotations: {},
  };
}

function claimNode(): GraphNode {
  return {
    schema_version: "1.0",
    id: "claim-a",
    type: "claim",
    title: "Claim A",
    status: "active",
    spec: { statement: "Recall improves" },
    edges: {},
    annotations: {},
  };
}

function gateNode(edges: GraphNode["edges"]): GraphNode {
  return {
    schema_version: "1.0",
    id: "gate-a",
    type: "gate",
    title: "Gate A",
    status: "active",
    spec: { capability: { name: "verifier", protocol_range: ">=1.0.0 <2.0.0" } },
    edges,
    annotations: {},
  };
}

function assetNode(version: string, edges: GraphNode["edges"]): GraphNode {
  return {
    schema_version: "1.0",
    id: "asset-a",
    type: "asset",
    title: "Verifier",
    status: "active",
    spec: {
      capabilities: [{ name: "verifier", protocol_version: version }],
      root: "tools/verifier",
    },
    edges,
    annotations: {},
  };
}

function projection(nodes: readonly GraphNode[]): CompilerGraphProjection {
  return { nodes: () => nodes, node: (id) => nodes.find((node) => node.id === id) };
}

function withPassingStatuses(
  configuration: CompiledConfiguration,
  statuses: readonly string[],
): CompiledConfiguration {
  const policy = {
    ...configuration.registries.gate_policies["research-gates"]!,
    passing_receipt_statuses: [...statuses],
  };
  return rehashed(configuration, {
    registries: {
      ...configuration.registries,
      gate_policies: { ...configuration.registries.gate_policies, "research-gates": policy },
    },
  });
}

function mutateFirstTicketTransition(
  configuration: CompiledConfiguration,
  patch: ConfigurationObject,
): CompiledConfiguration {
  const ticket = configuration.registries.state_machines.ticket!;
  const transitions = ticket.transitions as readonly ConfigurationObject[];
  return rehashed(configuration, {
    registries: {
      ...configuration.registries,
      state_machines: {
        ...configuration.registries.state_machines,
        ticket: {
          ...ticket,
          transitions: [{ ...transitions[0], ...patch }, ...transitions.slice(1)],
        },
      },
    },
  });
}

function rehashed(
  configuration: CompiledConfiguration,
  patch: Partial<Omit<CompiledConfiguration, "configuration_sha256">>,
): CompiledConfiguration {
  const { configuration_sha256: _hash, ...base } = configuration;
  const material = { ...base, ...patch };
  return Object.freeze({ ...material, configuration_sha256: canonicalHash(material) });
}

function digest(value: unknown): Sha256Digest {
  return canonicalHash(value);
}

function diagnostics(result: {
  diagnostics: readonly { path: string; code: string; message: string }[];
}): string {
  return result.diagnostics.map((item) => `${item.path}:${item.code}:${item.message}`).join("\n");
}

function compileCurrentProfile(
  packageDirectory: "coding-profile" | "research-profile",
): CompiledConfiguration {
  const result = compileProfileConfiguration(currentBaseline(packageDirectory));
  if (!result.ok) throw new Error(diagnostics(result));
  return result.value;
}

function currentBaseline(
  packageDirectory: "coding-profile" | "research-profile",
): VerifiedProfileBaseline {
  const packageRoot = resolve(repositoryRoot, "packages", packageDirectory, "koni");
  const parsed = parseProfilePackageManifest(
    readFileSync(join(packageRoot, "profile-manifest.json"), "utf8"),
  );
  if (!parsed.ok) throw new Error(diagnostics(parsed));
  const files = readTree(join(packageRoot, "baseline"));
  const priorKinds = new Map(
    parsed.value.baseline.files.map((entry) => [entry.path, entry.kind] as const),
  );
  const inventory = [...files.entries()]
    .map(([path, bytes]) => ({
      path,
      sha256: rawSha256(bytes),
      size_bytes: bytes.byteLength,
      kind:
        priorKinds.get(path) ?? (path.endsWith(".yaml") ? ("config" as const) : ("other" as const)),
    }))
    .sort((left, right) => compareUtf8(left.path, right.path));
  const manifest = {
    ...parsed.value,
    baseline: { ...parsed.value.baseline, files: inventory },
    bundle_sha256: computeProfileBundleSha256(inventory, parsed.value.migrations ?? []),
  };
  return { manifest, files };
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
