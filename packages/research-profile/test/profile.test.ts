import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import registerProfile, {
  KONI_PROFILE_AVAILABLE_EVENT,
  KONI_PROFILE_DISCOVER_EVENT,
  PROFILE_DESCRIPTOR,
} from "../extensions/profile.js";

describe("research profile registrar", () => {
  it("reserves a bounded Research Medium correction envelope after synthesis begins", async () => {
    const [source, largeSource] = await Promise.all([
      readFile(path.resolve(import.meta.dirname, "../koni/baseline/run-types/medium.yaml"), "utf8"),
      readFile(path.resolve(import.meta.dirname, "../koni/baseline/run-types/large.yaml"), "utf8"),
    ]);
    const document = YAML.parse(source) as {
      planning: {
        token_budget: {
          limit: number;
          synthesis_reserve: number;
          on_exhausted: string;
        };
      };
    };
    const tokenBudget = document.planning.token_budget;

    expect(tokenBudget).toEqual({
      metric: "new_tokens",
      limit: 350_000,
      synthesis_reserve: 260_000,
      on_exhausted: "force_synthesis",
    });
    expect(tokenBudget.limit - tokenBudget.synthesis_reserve).toBe(90_000);
    expect({
      ticketAndVerification: tokenBudget.limit * 3,
      leadAndIntegration: Math.floor(tokenBudget.limit / 2),
    }).toEqual({ ticketAndVerification: 1_050_000, leadAndIntegration: 175_000 });
    expect(YAML.parse(largeSource).planning.token_budget).toEqual({
      metric: "new_tokens",
      limit: 1_060_000,
      synthesis_reserve: 260_000,
      on_exhausted: "force_synthesis",
    });
  });

  it("keeps negative constraints on the operation, resource, or effect they regulate", async () => {
    const sources = await Promise.all(
      ["run-planner", "gate-designer", "asset-builder", "reviewer"].map((agent) =>
        readFile(
          path.resolve(import.meta.dirname, `../koni/baseline/agents/${agent}.yaml`),
          "utf8",
        ),
      ),
    );
    const sharedGuidance = await readFile(
      path.resolve(
        import.meta.dirname,
        "../../core/skills/model-koni-work/references/execution-contracts.md",
      ),
      "utf8",
    );
    const normalized = [...sources, sharedGuidance].map((source) => source.replace(/\s+/gu, " "));

    for (const source of normalized) {
      expect(source).toContain(
        "Do not convert a prohibition on an operation or resource into a lexical scan over arbitrary authorized content",
      );
      expect(source).toContain(
        "An artifact may name or describe a prohibited concept without performing that operation or accessing that resource",
      );
    }
    expect(normalized.at(-1)).toContain(
      "A lexical rule is valid only when the content itself is the regulated input and the contract states that semantic explicitly",
    );
  });

  it("keeps post-execution evidence out of prerequisite authority", async () => {
    const [plannerSource, sharedGuidance] = await Promise.all([
      readFile(
        path.resolve(import.meta.dirname, "../koni/baseline/agents/run-planner.yaml"),
        "utf8",
      ),
      readFile(
        path.resolve(
          import.meta.dirname,
          "../../core/skills/model-koni-work/references/empirical-research.md",
        ),
        "utf8",
      ),
    ]);
    const normalizedPlanner = plannerSource.replace(/\s+/gu, " ");
    const normalizedGuidance = sharedGuidance.replace(/\s+/gu, " ");
    const invariant =
      "Never model a receipt, review, report, promotion decision, or other product that the dependent experiment or run is supposed to produce as a prerequisite or as that experiment's `requires` edge";

    expect(normalizedPlanner).toContain(invariant);
    expect(normalizedGuidance).toContain(invariant);
    expect(normalizedPlanner).toContain(
      "Prerequisites are antecedent readiness only; downstream evidence and reporting must materialize from the run, evidence, review, and report lifecycle after execution",
    );
    expect(normalizedGuidance).toContain(
      "An authenticated product of already-completed work may be an antecedent input only when it exists before the dependent execution",
    );
  });

  it("keeps every planned asset file and entrypoint inside one materialization root", async () => {
    const [nodeSource, plannerSource, sharedGuidance] = await Promise.all([
      readFile(path.resolve(import.meta.dirname, "../koni/baseline/graph/nodes.yaml"), "utf8"),
      readFile(
        path.resolve(import.meta.dirname, "../koni/baseline/agents/run-planner.yaml"),
        "utf8",
      ),
      readFile(
        path.resolve(
          import.meta.dirname,
          "../../core/skills/model-koni-work/references/empirical-research.md",
        ),
        "utf8",
      ),
    ]);
    const nodeDocument = YAML.parse(nodeSource) as {
      node_types: Array<{
        id: string;
        fields?: Record<
          string,
          {
            properties?: Record<string, { description?: string }>;
            items?: { properties?: Record<string, { description?: string }> };
          }
        >;
      }>;
    };
    const assetFields = nodeDocument.node_types.find(({ id }) => id === "asset")?.fields;
    const normalizedPlanner = plannerSource.replace(/\s+/gu, " ");
    const normalizedGuidance = sharedGuidance.replace(/\s+/gu, " ");

    expect(normalizedPlanner).toContain(
      "Normalize `implementation_plan.root` as a directory boundary and require every `implementation_plan.files` path beneath it",
    );
    expect(normalizedPlanner).toContain(
      "`implementation.entrypoints` and every `capabilities[].entrypoints` value must identify a planned file beneath that same root",
    );
    expect(normalizedGuidance).toContain(
      "Treat an asset implementation plan as one filesystem authority boundary",
    );
    expect(normalizedGuidance).toContain(
      "Never serialize a file or entrypoint outside that root and rely on a later worker to reconcile it",
    );
    expect(assetFields?.implementation_plan?.properties?.files?.description).toContain(
      "contained beneath implementation_plan.root",
    );
    expect(assetFields?.implementation?.properties?.entrypoints?.description).toContain(
      "also listed in implementation_plan.files",
    );
    expect(assetFields?.capabilities?.items?.properties?.entrypoints?.description).toContain(
      "also listed in implementation_plan.files",
    );
  });

  it("provisions post-result verification with each planned scientific runtime", async () => {
    const [plannerSource, assetBuilderSource, sharedGuidance] = await Promise.all([
      readFile(
        path.resolve(import.meta.dirname, "../koni/baseline/agents/run-planner.yaml"),
        "utf8",
      ),
      readFile(
        path.resolve(import.meta.dirname, "../koni/baseline/agents/asset-builder.yaml"),
        "utf8",
      ),
      readFile(
        path.resolve(
          import.meta.dirname,
          "../../core/skills/model-koni-work/references/empirical-research.md",
        ),
        "utf8",
      ),
    ]);
    const normalizedPlanner = plannerSource.replace(/\s+/gu, " ");
    const normalizedAssetBuilder = assetBuilderSource.replace(/\s+/gu, " ");
    const normalizedGuidance = sharedGuidance.replace(/\s+/gu, " ");

    expect(normalizedPlanner).toContain(
      "Every planned scientific runtime asset must provision both its empirical command and a distinct repository-owned, read-only post-result verification argv inside the same authenticated implementation boundary",
    );
    expect(normalizedAssetBuilder).toContain(
      "For a scientific runtime asset, implement both the typed empirical result producer and a distinct read-only post-result verifier",
    );
    expect(normalizedGuidance).toContain(
      "A planned scientific runtime asset must provide both the empirical result producer and a distinct repository-owned, read-only post-result verifier before run-plan compilation",
    );
    for (const source of [normalizedPlanner, normalizedAssetBuilder, normalizedGuidance]) {
      expect(source).toContain(
        "The verifier may reuse the same executable through a separate mode or subcommand",
      );
      expect(source).toContain(
        "verify the durable result without rerunning the empirical operation",
      );
    }
  });

  it("keeps every automatic review-rework workflow bounded to two corrections", async () => {
    const source = await readFile(
      path.resolve(import.meta.dirname, "../koni/baseline/workflows/research.yaml"),
      "utf8",
    );
    const document = YAML.parse(source) as {
      workflows: Array<{
        review_failure_reopen_from?: string;
        review_rework_limit?: number;
      }>;
    };
    const reworking = document.workflows.filter(
      (workflow) => workflow.review_failure_reopen_from !== undefined,
    );

    expect(reworking.length).toBeGreaterThan(0);
    expect(reworking.every((workflow) => workflow.review_rework_limit === 2)).toBe(true);
  });

  it("automatically closes its bounded reviewed change-control route", async () => {
    const [operationsSource, workflowsSource] = await Promise.all([
      readFile(
        path.resolve(import.meta.dirname, "../koni/baseline/operations/research.yaml"),
        "utf8",
      ),
      readFile(
        path.resolve(import.meta.dirname, "../koni/baseline/workflows/research.yaml"),
        "utf8",
      ),
    ]);
    const operations = YAML.parse(operationsSource) as {
      operations: Array<{ id: string; change_control?: Record<string, unknown> }>;
    };
    const workflows = YAML.parse(workflowsSource) as {
      workflows: Array<{ id: string; review_rework_limit?: number }>;
    };

    expect(
      operations.operations.find(({ id }) => id === "lifecycle.change-request")?.change_control,
    ).toMatchObject({
      role: "proposal",
      proposal_step: "propose-graph-delta",
      decision_policy: "automatic",
      application_operations: ["apply-change-request", "no-op"],
    });
    expect(workflows.workflows.find(({ id }) => id === "change-request")).toMatchObject({
      review_rework_limit: 2,
    });
    expect(workflows.workflows.find(({ id }) => id === "apply-change-request")).toMatchObject({
      review_rework_limit: 2,
    });
  });

  it("exposes an exact provider-version contract for capability-backed assets", async () => {
    const [nodeSource, edgeSource] = await Promise.all([
      readFile(path.resolve(import.meta.dirname, "../koni/baseline/graph/nodes.yaml"), "utf8"),
      readFile(path.resolve(import.meta.dirname, "../koni/baseline/graph/edges.yaml"), "utf8"),
    ]);
    const nodeDocument = YAML.parse(nodeSource) as {
      node_types: Array<{
        id: string;
        fields?: Record<
          string,
          {
            items?: {
              additional_properties?: boolean;
              properties?: Record<string, { required?: boolean; pattern?: string }>;
            };
          }
        >;
      }>;
    };
    const edgeDocument = YAML.parse(edgeSource) as {
      gate_policies: Array<{
        id: string;
        capability: { provider_version_fields: string[] };
      }>;
    };
    const capabilityItem = nodeDocument.node_types.find(({ id }) => id === "asset")?.fields
      ?.capabilities?.items;
    const providerVersionFields = edgeDocument.gate_policies.find(
      ({ id }) => id === "research-capability-gates",
    )?.capability.provider_version_fields;

    expect(capabilityItem?.additional_properties).toBe(false);
    expect(capabilityItem?.properties?.name?.required).toBe(true);
    expect(capabilityItem?.properties?.protocol_version).toMatchObject({
      required: true,
      pattern: expect.stringContaining("[0-9]+\\.[0-9]+\\.[0-9]+"),
    });
    expect(capabilityItem?.properties).not.toHaveProperty("protocol_range");
    expect(providerVersionFields).toEqual(["protocol_version"]);
  });

  it("ships one queued ticket waiting state across every lifecycle return path", async () => {
    const source = await readFile(
      path.resolve(import.meta.dirname, "../koni/baseline/rules/lifecycle.yaml"),
      "utf8",
    );
    const document = YAML.parse(source) as {
      state_machines: Array<{
        id: string;
        initial: string;
        states: string[];
        transitions: Array<{ id: string; from: string[]; to: string }>;
      }>;
    };
    const ticket = document.state_machines.find(({ id }) => id === "ticket");

    expect(ticket?.initial).toBe("queued");
    expect(ticket?.states).not.toEqual(expect.arrayContaining(["todo", "ready", "failed"]));
    expect(ticket?.transitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "approve-change-request",
          from: ["proposed"],
          to: "queued",
        }),
        expect.objectContaining({ id: "start", from: ["queued"], to: "in_progress" }),
        expect.objectContaining({
          id: "release-blocker",
          from: ["blocked"],
          to: "queued",
        }),
        expect.objectContaining({
          id: "interrupt-active",
          from: ["in_progress"],
          to: "queued",
        }),
        expect.objectContaining({
          id: "reopen-stale-obligation",
          from: ["closed"],
          to: "queued",
        }),
        expect.objectContaining({ id: "retire-queued", from: ["queued"], to: "closed" }),
      ]),
    );
  });

  it("announces the immutable descriptor on discovery and session start", () => {
    const extensionHandlers = new Map<string, (...arguments_: unknown[]) => unknown>();
    const eventHandlers = new Map<string, (...arguments_: unknown[]) => unknown>();
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const pi = {
      events: {
        on(event: string, handler: (...arguments_: unknown[]) => unknown) {
          eventHandlers.set(event, handler);
          return () => eventHandlers.delete(event);
        },
        emit(event: string, payload: unknown) {
          emitted.push({ event, payload });
        },
      },
      on(event: string, handler: (...arguments_: unknown[]) => unknown) {
        extensionHandlers.set(event, handler);
      },
    } as unknown as ExtensionAPI;

    registerProfile(pi);
    expect([...eventHandlers]).toHaveLength(1);
    expect([...extensionHandlers]).toHaveLength(2);
    eventHandlers.get(KONI_PROFILE_DISCOVER_EVENT)?.();
    extensionHandlers.get("session_start")?.();

    expect(emitted).toEqual([
      { event: KONI_PROFILE_AVAILABLE_EVENT, payload: PROFILE_DESCRIPTOR },
      { event: KONI_PROFILE_AVAILABLE_EVENT, payload: PROFILE_DESCRIPTOR },
    ]);
    expect(PROFILE_DESCRIPTOR.package).toBe("@koni/research-profile");
    expect(PROFILE_DESCRIPTOR.manifest_url).toMatch(/\/koni\/profile-manifest\.json$/);
    extensionHandlers.get("session_shutdown")?.();
    expect(eventHandlers.size).toBe(0);
  });

  it("defines every node for agents with a nonempty semantic description", async () => {
    const source = await readFile(
      path.resolve(import.meta.dirname, "../koni/baseline/graph/nodes.yaml"),
      "utf8",
    );
    const document = YAML.parse(source) as {
      node_types: Array<{ id: string; description?: string }>;
    };
    expect(document.node_types.length).toBeGreaterThan(0);
    expect(
      document.node_types.filter(
        ({ description }) => typeof description !== "string" || description.trim() === "",
      ),
    ).toEqual([]);
  });

  it("stores each reciprocal research fact once through canonical bidirectional edges", async () => {
    const source = await readFile(
      path.resolve(import.meta.dirname, "../koni/baseline/graph/edges.yaml"),
      "utf8",
    );
    const document = YAML.parse(source) as {
      edge_types: Array<{
        source: string;
        relation: string;
        targets: string[];
        bidirectional?: boolean;
        inverse?: string;
      }>;
    };
    expect(document.edge_types).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "experiment",
          relation: "target_claims",
          targets: ["claim"],
          bidirectional: true,
          inverse: "tested_by",
        }),
        expect.objectContaining({
          source: "ablation",
          relation: "target_claims",
          targets: ["claim"],
          bidirectional: true,
          inverse: "tested_by",
        }),
        expect.objectContaining({
          source: "gate",
          relation: "applies_to",
          bidirectional: true,
          inverse: "gates",
        }),
      ]),
    );
    expect(
      document.edge_types.some(({ relation }) => relation === "tested_by" || relation === "gates"),
    ).toBe(false);

    const instructions = await readFile(
      path.resolve(
        import.meta.dirname,
        "../../core/skills/model-koni-work/references/empirical-research.md",
      ),
      "utf8",
    );
    const normalizedInstructions = instructions.replace(/\s+/gu, " ");
    expect(normalizedInstructions).toContain(
      "Store one canonical `target_claims` fact with inverse `tested_by`",
    );
    expect(normalizedInstructions).toContain(
      "one canonical `gate.applies_to` fact with inverse `gates`",
    );
  });

  it("does not ship a parallel Pi resource registry", async () => {
    await expect(
      readFile(path.resolve(import.meta.dirname, "../koni/baseline/resources/pi-packages.yaml")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("gives missing-gate asset planning deterministic access to the active asset portfolio", async () => {
    const source = await readFile(
      path.resolve(import.meta.dirname, "../koni/baseline/rules/research.yaml"),
      "utf8",
    );
    const document = YAML.parse(source) as {
      rules: Array<{
        id: string;
        emit?: {
          target_nodes?: unknown;
          read_scope?: unknown;
          write_scope?: unknown;
        };
      }>;
    };
    const rule = document.rules.find(({ id }) => id === "ticket.plan-build-asset");

    expect(rule?.emit).toMatchObject({
      target_nodes: { union: ["$target", "active-assets"] },
      read_scope: { union: ["$target", "active-assets"] },
      write_scope: { union: ["$target", "active-assets"] },
    });
  });

  it("keeps approved asset resolution inside the autonomous closure chain", async () => {
    const source = await readFile(
      path.resolve(import.meta.dirname, "../koni/baseline/operations/research.yaml"),
      "utf8",
    );
    const document = YAML.parse(source) as {
      operations: Array<{
        id: string;
        change_control?: {
          role?: string;
          allow_upstream_requests?: boolean;
        };
      }>;
    };
    const assetResolutionOperations = [
      "asset-resolution.prerequisite.resolve-assets",
      "asset-resolution.prerequisite.plan-build-asset",
    ].map((id) => document.operations.find((operation) => operation.id === id));

    for (const operation of assetResolutionOperations) {
      expect(operation?.change_control).toEqual({
        role: "ordinary",
        allow_upstream_requests: false,
      });
    }
  });

  it("judges orchestration from the progressive executable frontier", async () => {
    const [leadSource, plannerSource, agentsReference] = await Promise.all([
      readFile(path.resolve(import.meta.dirname, "../koni/baseline/agents/lead.yaml"), "utf8"),
      readFile(
        path.resolve(import.meta.dirname, "../koni/baseline/agents/run-planner.yaml"),
        "utf8",
      ),
      readFile(
        path.resolve(
          import.meta.dirname,
          "../../core/skills/configure-koni/references/agents-and-skills.md",
        ),
        "utf8",
      ),
    ]);
    const lead = YAML.parse(leadSource) as { instructions: string };
    const planner = YAML.parse(plannerSource) as { instructions: string };
    const normalized = lead.instructions.replace(/\s+/gu, " ");
    const normalizedPlanner = planner.instructions.replace(/\s+/gu, " ");
    const normalizedAgentsReference = agentsReference.replace(/\s+/gu, " ");

    expect(normalizedPlanner).toContain("State one compact progressive closure chain in the plan");
    expect(normalizedPlanner).toContain(
      "initial compiler-emittable work through each accepted effect and newly eligible downstream operation to the terminal objective",
    );
    expect(normalizedPlanner).toContain(
      "Express ordering only when the submitted graph models the corresponding dependency",
    );
    expect(normalizedPlanner).toContain(
      "Treat independent safe preparation obligations as one concurrent frontier",
    );
    expect(normalizedPlanner).toContain(
      "Do not turn a prose list or shared downstream requirement into a sequence",
    );
    expect(normalized).toContain(
      "Treat only the plan, ticket board, resolved questions, receipts, and lifecycle facts supplied to this attempt as authoritative",
    );
    expect(normalized).toContain("approved plan's stated closure chain");
    expect(normalized).toContain("Never invent hidden graph, rule, scheduler, or operation facts");
    expect(normalized).toContain(
      "Proceed only when at least one potentially dispatchable current operation advances",
    );
    expect(normalized).toContain(
      "Treat as potentially dispatchable every running ticket and every queued ticket whose supplied status and ticket dependencies do not establish that it must wait",
    );
    expect(normalized).toContain(
      "When the supplied facts leave dispatchability uncertain, include it",
    );
    expect(normalized).toContain(
      "Use the supplied `settledDependencyIds` and `waitingOnDependencyIds` as the compiler-authoritative dependency settlement projection",
    );
    expect(normalized).toContain(
      "Treat each nonterminal ticket in the supplied current board as a compiler-derived current obligation",
    );
    expect(normalized).toContain(
      "Do not infer that it is stale or redundant merely because a completed or cancelled ticket overlaps its target or scope",
    );
    expect(normalized).toContain(
      "All existing plan, dependency, evidence, interaction, reachability, and safety criteria still apply",
    );
    expect(normalized).toContain(
      "Judge a queued recovery or repair ticket from its own current objective, dependencies, scope, and compiler-issued creation authority",
    );
    expect(normalized).toContain(
      "A blocked source is the input to that closure path; it does not prove the current recovery or repair ticket is itself unreachable",
    );
    expect(normalized).toContain(
      "Treat a ticket in `review` whose required steps are completed and whose supplied review has no blocker as a compiler-managed publication frontier",
    );
    expect(normalized).toContain(
      "Do not treat its dependents as dispatchable before publication, and do not block merely because the ticket is not yet `completed`",
    );
    expect(normalized).toContain("An incomplete or blocked review is not a publication frontier");
    expect(normalized).toContain(
      "every other operation that deterministic authority could dispatch now is also supported, safe, and within that plan",
    );
    expect(normalized).toContain(
      "Use supplied ticket dependencies as the ordering authority for the current executable frontier",
    );
    expect(normalized).toContain(
      "Narrative words such as first, then, or later describe closure milestones, not exclusive sequencing",
    );
    expect(normalized).toContain(
      "Do not block solely because one safe independent preparation operation can run before or alongside another",
    );
    expect(normalized).toContain(
      "An eventual ticket absent from the current board is downstream work, not a missing path",
    );
    expect(normalized).toContain(
      "Block when every stated closure chain is structurally unreachable, or when any potentially dispatchable current operation is materially ambiguous, unsafe, or outside the approved plan",
    );
    expect(normalized).toContain(
      "Do not ask the operator to restate a choice already entailed by the supplied authoritative facts",
    );
    expect(normalized).toContain(
      "preserves every unresolved downstream effect behind its existing gate",
    );
    expect(normalized).toContain(
      "Ask only when at least two materially different interpretations remain supported, would change current dispatch safety, and the authoritative context selects none",
    );
    expect(normalized).toContain(
      "A comparison-based blocker requires two materially incompatible authoritative values for the same required contract, the exact supplied source of each value, and the material dispatch-safety consequence of their difference",
    );
    expect(normalized).toContain(
      "Exact equality or a compatible refinement supports consistency; it is not evidence of a mismatch",
    );
    expect(normalized).toContain(
      "When that comparison proof is absent, apply the remaining safety criteria and preserve any residual uncertainty in the summary",
    );
    expect(normalizedAgentsReference).toContain(
      "A qualitative gate must not turn conservative, reversible uncertainty into an operator confirmation",
    );
    expect(normalizedAgentsReference).toContain(
      "Reserve a question for cases where multiple materially different interpretations remain supported, would change current safety, and the authoritative context selects none",
    );
    expect(normalizedAgentsReference).toContain(
      "A qualitative gate must consume the compiler-projected dependency settlement",
    );
    expect(normalizedAgentsReference).toContain(
      "Require a comparison-based blocker to identify two materially incompatible authoritative values for the same required contract, the supplied source of each value, and the material safety consequence of their difference",
    );
    expect(normalizedAgentsReference).toContain(
      "Exact equality or a compatible refinement establishes consistency rather than a mismatch",
    );
    expect(normalizedAgentsReference).toContain(
      "If this comparison proof is absent, keep every other safety criterion and have the persona preserve residual uncertainty in its summary instead of manufacturing a conflict",
    );
    expect(normalizedAgentsReference).toContain(
      "Configure the Lead to treat each nonterminal ticket in the supplied current board as a compiler-derived current obligation",
    );
    expect(normalizedAgentsReference).toContain(
      "Historical overlap alone does not make that current ticket stale or redundant",
    );
    expect(normalizedAgentsReference).toContain(
      "Preserve every existing plan, dependency, evidence, interaction, reachability, and safety criterion",
    );
    expect(normalizedAgentsReference).toContain(
      "Judge a current queued recovery or repair ticket from its own supplied objective, dependencies, scope, and compiler-issued creation authority",
    );
    expect(normalized).not.toContain(
      "when at least one current operation advances an approved path",
    );
  });

  it("reviews each rework cycle against its current authenticated predecessor", async () => {
    const [reviewerSource, executionReference] = await Promise.all([
      readFile(path.resolve(import.meta.dirname, "../koni/baseline/agents/reviewer.yaml"), "utf8"),
      readFile(
        path.resolve(
          import.meta.dirname,
          "../../core/skills/model-koni-work/references/execution-contracts.md",
        ),
        "utf8",
      ),
    ]);
    const normalizedReviewer = reviewerSource.replace(/\s+/gu, " ");
    const normalizedExecutionReference = executionReference.replace(/\s+/gu, " ");

    expect(normalizedReviewer).toContain(
      "Treat the current authenticated predecessor execution as the evidence authority for the current review cycle",
    );
    expect(normalizedReviewer).toContain(
      "Re-evaluate each earlier finding against the current candidate and current receipts",
    );
    expect(normalizedExecutionReference).toContain(
      "A prior failed-review blocker is repair history, not current execution evidence",
    );
    expect(normalizedReviewer).toContain(
      "Before reopening the producer, complete one bounded pass over the full issued review contract",
    );
    expect(normalizedReviewer).toContain(
      "Return every material finding that the current authorized evidence already supports and that the same producer can repair",
    );
    expect(normalizedReviewer).toContain(
      "Do not deliberately defer an inspectable finding to spend another rework cycle",
    );
    expect(normalizedExecutionReference).toContain(
      "A nonpassing review should return every material finding already supported by the current authorized evidence and repairable by the same reopened producer",
    );
    expect(normalizedExecutionReference).toContain(
      "Do not widen discovery or speculate merely to fill the batch",
    );
    expect(normalizedReviewer).toContain(
      "At a downstream composition boundary, treat a compiler-current upstream artifact with completed independent review as authoritative for the claims that review accepted",
    );
    expect(normalizedReviewer).toContain(
      "Do not repeat that upstream semantic review from the same evidence",
    );
    expect(normalizedExecutionReference).toContain(
      "Validate currentness, exact membership, and downstream interactions; do not repeat that upstream semantic review from the same evidence",
    );
    expect(normalizedReviewer).toContain(
      "Before approving a scientific runtime or its post-result verifier, build one closed validation ledger over every material issued contract field",
    );
    expect(normalizedReviewer).toContain(
      "Do not approve from representative spot checks while any material ledger entry is undisposed",
    );
    expect(normalizedReviewer).toContain(
      "Return every currently supported unsatisfied entry in one repair request",
    );
  });

  it("authenticates planned paths and routes grant-changing repairs", async () => {
    const [plannerSource, executionReference] = await Promise.all([
      readFile(
        path.resolve(import.meta.dirname, "../koni/baseline/agents/run-planner.yaml"),
        "utf8",
      ),
      readFile(
        path.resolve(
          import.meta.dirname,
          "../../core/skills/model-koni-work/references/execution-contracts.md",
        ),
        "utf8",
      ),
    ]);
    const planner = YAML.parse(plannerSource) as { instructions: string };
    const normalizedPlanner = planner.instructions.replace(/\s+/gu, " ");
    const normalizedReference = executionReference.replace(/\s+/gu, " ");

    expect(normalizedPlanner).toContain(
      "A pre-existing repository input or mutation target is authenticated only when it appears verbatim in an accepted repository tool result",
    );
    expect(normalizedPlanner).toContain(
      "Declare a planned new output path as new beneath an authenticated ownership or implementation root",
    );
    expect(normalizedPlanner).toContain(
      "Before submission, reconcile every path-bearing graph field against that evidence ledger and new-output distinction",
    );
    expect(normalizedPlanner).toContain("A failed lookup never authenticates the attempted path");
    expect(normalizedPlanner).toContain(
      "Materialize every discovered dependency in the exact graph field from which the downstream operation derives its authority",
    );
    expect(normalizedPlanner).toContain(
      "record every consumed pre-existing repository file in `spec.support_paths` and link each resolved prerequisite through canonical `satisfied_by` before approval",
    );
    expect(normalizedReference).toContain(
      "Graph write authority does not make grant-affecting fields mutable within the current ticket",
    );
    expect(normalizedReference).toContain(
      "Every pre-existing repository input or mutation target must appear verbatim in accepted repository evidence",
    );
    expect(normalizedReference).toContain(
      "Planning must materialize each discovered dependency in the exact graph field from which downstream authority is projected",
    );
    expect(normalizedReference).toContain(
      "A prose promise to resolve an already-discovered input later is not an authority binding",
    );
  });

  it("keeps contract-defined absence distinct from missing authority", async () => {
    const [assetBuilderSource, reviewerSource, executionReference, agentsReference] =
      await Promise.all([
        readFile(
          path.resolve(import.meta.dirname, "../koni/baseline/agents/asset-builder.yaml"),
          "utf8",
        ),
        readFile(
          path.resolve(import.meta.dirname, "../koni/baseline/agents/reviewer.yaml"),
          "utf8",
        ),
        readFile(
          path.resolve(
            import.meta.dirname,
            "../../core/skills/model-koni-work/references/execution-contracts.md",
          ),
          "utf8",
        ),
        readFile(
          path.resolve(
            import.meta.dirname,
            "../../core/skills/configure-koni/references/agents-and-skills.md",
          ),
          "utf8",
        ),
      ]);
    const assetBuilder = YAML.parse(assetBuilderSource) as { instructions: string };
    const reviewer = YAML.parse(reviewerSource) as { instructions: string };
    const normalizedAssetBuilder = assetBuilder.instructions.replace(/\s+/gu, " ");
    const normalizedReviewer = reviewer.instructions.replace(/\s+/gu, " ");
    const normalizedExecutionReference = executionReference.replace(/\s+/gu, " ");
    const normalizedAgentsReference = agentsReference.replace(/\s+/gu, " ");

    expect(normalizedAssetBuilder).toContain(
      "Classify an absent input against the issued result contract",
    );
    expect(normalizedAssetBuilder).toContain(
      "When that contract admits absence as a negative, incomplete, or inconclusive result, emit the typed result within current authority",
    );
    expect(normalizedReviewer).toContain(
      "If the approved input boundary and result contract admit structured absence, require the producer to encode that result rather than obtain the unavailable resource",
    );
    expect(normalizedExecutionReference).toContain(
      "Classify a missing resource against the owning result contract before requesting authority",
    );
    expect(normalizedExecutionReference).toContain(
      "A lookup that establishes nonexistence supports absence only at its authenticated boundary",
    );
    expect(normalizedExecutionReference).toContain(
      "A permission, scope, or transient failure establishes neither absence nor that wider authority contains the resource",
    );
    expect(normalizedAgentsReference).toContain(
      "Preserve the distinction between a required dependency and contract-defined absence",
    );
    expect(normalizedAgentsReference).toContain(
      "configure its producer to emit that result and its reviewer to preserve it",
    );
  });

  it("binds executable contracts to an authenticated launcher", async () => {
    const [
      assetBuilderSource,
      integratorSource,
      plannerSource,
      executionReference,
      empiricalReference,
    ] = await Promise.all([
      readFile(
        path.resolve(import.meta.dirname, "../koni/baseline/agents/asset-builder.yaml"),
        "utf8",
      ),
      readFile(
        path.resolve(import.meta.dirname, "../koni/baseline/agents/integrator.yaml"),
        "utf8",
      ),
      readFile(
        path.resolve(import.meta.dirname, "../koni/baseline/agents/run-planner.yaml"),
        "utf8",
      ),
      readFile(
        path.resolve(
          import.meta.dirname,
          "../../core/skills/model-koni-work/references/execution-contracts.md",
        ),
        "utf8",
      ),
      readFile(
        path.resolve(
          import.meta.dirname,
          "../../core/skills/model-koni-work/references/empirical-research.md",
        ),
        "utf8",
      ),
    ]);
    const normalizedAssetBuilder = assetBuilderSource.replace(/\s+/gu, " ");
    const normalizedIntegrator = integratorSource.replace(/\s+/gu, " ");
    const normalizedPlanner = plannerSource.replace(/\s+/gu, " ");
    const normalizedExecutionReference = executionReference.replace(/\s+/gu, " ");
    const normalizedEmpiricalReference = empiricalReference.replace(/\s+/gu, " ");

    expect(normalizedAssetBuilder).toContain(
      "Bind every executable contract to a launcher established by accepted repository or runtime evidence",
    );
    expect(normalizedAssetBuilder).toContain(
      "Keep the entrypoint declaration, executable header or manifest, documentation examples, verifier contract, and runtime command consistent",
    );
    expect(normalizedIntegrator).toContain(
      "Reject a composed executable contract whose launcher differs from the authenticated predecessor entrypoint contract",
    );
    expect(normalizedExecutionReference).toContain(
      "A familiar command name is not evidence that an executable exists",
    );
    for (const source of [
      normalizedPlanner,
      normalizedExecutionReference,
      normalizedEmpiricalReference,
    ]) {
      expect(source).toContain(
        "A read, listing, or planned-file declaration authenticates a path or content, not authority to invoke that path as `argv[0]`",
      );
      expect(source).toContain("Authenticate `argv[0]` itself as an executable launcher");
      expect(source).toContain(
        "place an authenticated runner at `argv[0]` and the planned source path in a later argument",
      );
    }
  });

  it("separates filesystem materialization from semantic graph publication", async () => {
    const [workflowSource, executionReference] = await Promise.all([
      readFile(
        path.resolve(import.meta.dirname, "../koni/baseline/workflows/research.yaml"),
        "utf8",
      ),
      readFile(
        path.resolve(
          import.meta.dirname,
          "../../core/skills/model-koni-work/references/execution-contracts.md",
        ),
        "utf8",
      ),
    ]);
    const document = YAML.parse(workflowSource) as {
      workflows: Array<{
        id: string;
        steps: Array<{ id: string; graph_mutation?: string; expected_output?: string }>;
      }>;
    };
    const workflow = document.workflows.find(({ id }) => id === "implement-asset");
    const integrationStep = workflow?.steps.find(({ id }) => id === "integrate");
    const mutationByStep = Object.fromEntries(
      (workflow?.steps ?? []).map(({ id, graph_mutation }) => [id, graph_mutation]),
    );
    const normalizedReference = executionReference.replace(/\s+/gu, " ");

    expect(mutationByStep).toEqual({
      implement: "forbidden",
      verify: "forbidden",
      integrate: "allowed",
      review: "forbidden",
    });
    expect(normalizedReference).toContain(
      "A filesystem-only step must declare graph mutation forbidden and omit the graph delta",
    );
    expect(normalizedReference).toContain(
      "Do not reconstruct or echo an existing node merely to report unchanged authored fields",
    );
    expect(normalizedReference).toContain(
      "A later semantic integration step owns any required graph mutation",
    );
    expect(normalizedReference).toContain(
      "When verified repository work does not change the authored semantic contract, that integration step may submit an empty candidate",
    );
    expect(integrationStep?.expected_output).toContain(
      "empty candidate when verified repository-only repair leaves that contract exact",
    );
  });

  it("keeps run-plan compilation behind directly linked asset and prerequisite work", async () => {
    const source = await readFile(
      path.resolve(import.meta.dirname, "../koni/baseline/rules/research.yaml"),
      "utf8",
    );
    const document = YAML.parse(source) as {
      rules: Array<{
        id: string;
        emit?: { read_scope?: unknown; write_scope?: unknown };
      }>;
    };
    const rule = document.rules.find(({ id }) => id === "ticket.compile-run-plan");

    expect(rule?.emit).toMatchObject({
      read_scope: {
        union: [
          "$target",
          {
            traverse: {
              from: "$target",
              relations: ["assets", "requires", "baseline", "variant"],
              direction: "outgoing",
              min_depth: 1,
              max_depth: 1,
              node_types: ["asset"],
            },
          },
          {
            traverse: {
              from: "$target",
              relation: "requires",
              direction: "outgoing",
              min_depth: 1,
              max_depth: 1,
              node_types: ["prerequisite"],
            },
          },
        ],
      },
      write_scope: "$target",
    });
  });

  it("treats the operation new-node budget as current ticket authority", async () => {
    const source = await readFile(
      path.resolve(import.meta.dirname, "../koni/baseline/agents/experiment-designer.yaml"),
      "utf8",
    );
    const document = YAML.parse(source) as { instructions: string };
    const normalized = document.instructions.replace(/\s+/gu, " ");

    expect(normalized).toContain(
      "Existing-node write scope does not prohibit a new node type explicitly granted by the issued operation",
    );
    expect(normalized).toContain(
      "Do not request change control merely because an authorized new node does not exist yet",
    );
  });

  it("waits for a complete gate inventory before implementing capability assets", async () => {
    const source = await readFile(
      path.resolve(import.meta.dirname, "../koni/baseline/rules/research.yaml"),
      "utf8",
    );
    const document = YAML.parse(source) as {
      rules: Array<{
        id: string;
        when?: unknown;
        emit?: {
          read_scope?: unknown;
          write_scope?: unknown;
        };
      }>;
    };
    const rule = document.rules.find(({ id }) => id === "ticket.implement-asset");
    const conditions = (rule?.when as { all?: unknown[] } | undefined)?.all ?? [];
    const inventoryCondition = conditions.find(
      (condition) =>
        typeof condition === "object" &&
        condition !== null &&
        "any" in condition &&
        Array.isArray(condition.any) &&
        condition.any.some(
          (candidate) =>
            typeof candidate === "object" &&
            candidate !== null &&
            "for_all" in candidate &&
            (candidate.for_all as { select?: unknown }).select === "gate-required-nodes",
        ),
    ) as
      | {
          any: Array<{
            not?: unknown;
            for_all?: {
              select?: unknown;
              bind?: unknown;
              satisfies?: unknown;
            };
          }>;
        }
      | undefined;

    expect(inventoryCondition?.any[0]).toEqual({
      not: {
        op: "field_present",
        field: "spec.capabilities",
      },
    });
    expect(inventoryCondition?.any[1]?.for_all).toMatchObject({
      select: "gate-required-nodes",
      bind: "gate_subject",
      satisfies: {
        all: expect.any(Array),
      },
    });
    expect(rule?.emit).toMatchObject({
      read_scope: {
        union: ["$target", "gate-evaluation-subjects"],
      },
      write_scope: "$target",
    });
  });

  it("keeps a new gate capability contract inside gate definition", async () => {
    const [agentSource, operationSource, sharedSource] = await Promise.all([
      readFile(
        path.resolve(import.meta.dirname, "../koni/baseline/agents/gate-designer.yaml"),
        "utf8",
      ),
      readFile(
        path.resolve(import.meta.dirname, "../koni/baseline/operations/research.yaml"),
        "utf8",
      ),
      readFile(
        path.resolve(
          import.meta.dirname,
          "../../core/skills/model-koni-work/references/empirical-research.md",
        ),
        "utf8",
      ),
    ]);
    const agent = YAML.parse(agentSource) as { instructions: string };
    const operations = YAML.parse(operationSource) as {
      operations: Array<{ id: string; output_contract?: string }>;
    };
    const normalizedAgent = agent.instructions.replace(/\s+/gu, " ");
    const normalizedShared = sharedSource.replace(/\s+/gu, " ");
    const contract = operations.operations.find(
      ({ id }) => id === "graph-compilation.node.define-gates",
    )?.output_contract;

    expect(normalizedAgent).toContain(
      "Declare the new interface directly in the gate's embedded `spec.capability` object",
    );
    expect(normalizedAgent).toContain(
      "This does not require a separate capability node, provider asset, or upstream change request",
    );
    expect(contract).toContain("embedded gate spec.capability");
    expect(contract).toContain("does not require a capability node or upstream change request");
    expect(normalizedShared).toContain(
      "A new reusable gate interface is an embedded `gate.spec.capability` contract, not a separate capability node",
    );
    expect(normalizedShared).toContain("Later asset resolution owns the provider implementation");
  });

  it("does not reopen an unselected compatible asset only because it owns no gate contracts", async () => {
    const source = await readFile(
      path.resolve(import.meta.dirname, "../koni/baseline/rules/research.yaml"),
      "utf8",
    );
    const document = YAML.parse(source) as {
      rules: Array<{ id: string; when?: unknown }>;
    };
    const rule = document.rules.find(({ id }) => id === "ticket.implement-asset");

    expect(JSON.stringify(rule?.when)).not.toContain('"field":"spec.gate_contracts"');
  });

  it("limits synthesized gates to experiment boundaries with the reusable verifier inventory", async () => {
    const ruleSource = await readFile(
      path.resolve(import.meta.dirname, "../koni/baseline/rules/research.yaml"),
      "utf8",
    );
    const ruleDocument = YAML.parse(ruleSource) as {
      queries: Array<{
        id: string;
        node_types?: string[];
      }>;
      rules: Array<{
        id: string;
        emit?: {
          read_scope?: unknown;
          write_scope?: unknown;
        };
      }>;
    };
    const rule = ruleDocument.rules.find(({ id }) => id === "ticket.define-gate");
    const gateRequiredNodes = ruleDocument.queries.find(({ id }) => id === "gate-required-nodes");

    expect(gateRequiredNodes?.node_types).toEqual(["experiment"]);
    expect(rule?.emit).toMatchObject({
      read_scope: {
        union: ["$target", "active-assets", "gate-evaluation-subjects"],
      },
      write_scope: {
        union: [
          "$target",
          {
            traverse: {
              from: "$target",
              relation: "requires",
              direction: "outgoing",
              min_depth: 1,
              max_depth: 1,
              node_types: ["gate"],
            },
          },
        ],
      },
    });
  });

  it("keeps asset payload mutation under one implementation owner", async () => {
    const workflowSource = await readFile(
      path.resolve(import.meta.dirname, "../koni/baseline/workflows/research.yaml"),
      "utf8",
    );
    const workflowDocument = YAML.parse(workflowSource) as {
      workflows: Array<{
        id: string;
        steps: Array<{
          id: string;
          agent: string;
          depends_on: string[];
        }>;
      }>;
    };
    const workflow = workflowDocument.workflows.find(({ id }) => id === "implement-asset");

    expect(workflow?.steps.map(({ id }) => id)).not.toContain("inspect-contracts");
    expect(workflow?.steps[0]).toMatchObject({
      id: "implement",
      agent: "asset-builder",
      depends_on: [],
    });
    expect(workflow?.steps.find(({ id }) => id === "verify")?.agent).toBe("asset-builder");

    const integratorSource = await readFile(
      path.resolve(import.meta.dirname, "../koni/baseline/agents/integrator.yaml"),
      "utf8",
    );
    const integrator = YAML.parse(integratorSource) as {
      instructions: string;
      koni: {
        capabilities: {
          workspace_access: string;
          commands: string;
        };
      };
    };
    expect(integrator.koni.capabilities).toMatchObject({
      workspace_access: "workspace_write",
      commands: "workspace_write",
    });
  });

  it("gives every node-creating operation an explicit positive bound", async () => {
    const operationSource = await readFile(
      path.resolve(import.meta.dirname, "../koni/baseline/operations/research.yaml"),
      "utf8",
    );
    const document = YAML.parse(operationSource) as {
      operations: Array<{
        id: string;
        allowed_new_node_types?: string[];
        max_new_nodes?: number;
      }>;
    };
    const unbounded = document.operations
      .filter((operation) => (operation.allowed_new_node_types?.length ?? 0) > 0)
      .filter((operation) => operation.max_new_nodes === undefined || operation.max_new_nodes < 1)
      .map((operation) => operation.id);

    expect(unbounded).toEqual([]);
  });

  it("keeps the automatic report action inside the compiler-owned report boundary", async () => {
    const actionSource = await readFile(
      path.resolve(import.meta.dirname, "../koni/baseline/actions/research.yaml"),
      "utf8",
    );
    const document = YAML.parse(actionSource) as {
      actions: Array<{
        id: string;
        params?: Record<string, { required?: boolean }>;
        recipe: Array<{ primitive: string }>;
      }>;
    };
    const report = document.actions.find(({ id }) => id === "report");

    expect(Object.values(report?.params ?? {}).some(({ required }) => required === true)).toBe(
      false,
    );
    expect(report?.recipe.map(({ primitive }) => primitive)).toEqual([
      "project.validate",
      "report.render",
    ]);
  });

  it("does not make optional related work a deterministic formulation barrier", async () => {
    const ruleSource = await readFile(
      path.resolve(import.meta.dirname, "../koni/baseline/rules/research.yaml"),
      "utf8",
    );
    const ruleDocument = YAML.parse(ruleSource) as {
      rules: Array<{
        id: string;
        when?: unknown;
        emit?: { obligations?: string[] };
      }>;
    };
    const formulation = ruleDocument.rules.find(({ id }) => id === "ticket.formulation");
    const experimentPortfolio = ruleDocument.rules.find(
      ({ id }) => id === "ticket.experiment-portfolio",
    );

    expect(formulation?.when).toEqual({
      op: "edge_count",
      relation: "claims",
      exact: 0,
    });
    expect(formulation?.emit?.obligations).toEqual(["hypothesis.claims"]);
    expect(JSON.stringify(experimentPortfolio?.when)).not.toContain('"literature"');

    const workflowSource = await readFile(
      path.resolve(import.meta.dirname, "../koni/baseline/workflows/research.yaml"),
      "utf8",
    );
    const workflowDocument = YAML.parse(workflowSource) as {
      workflows: Array<{
        id: string;
        steps: Array<{ id: string; expected_output: string }>;
      }>;
    };
    const drill = workflowDocument.workflows.find(({ id }) => id === "drill-hypothesis");
    expect(drill?.steps.find(({ id }) => id === "map-related-work")?.expected_output).toContain(
      "bounded no-op",
    );
    expect(drill?.steps.find(({ id }) => id === "integrate")?.expected_output).toContain(
      "optional",
    );
  });

  it("records ablation applicability without forcing scientifically redundant work", async () => {
    const [nodeSource, ruleSource, checkSource, workflowSource, operationSource] =
      await Promise.all([
        readFile(path.resolve(import.meta.dirname, "../koni/baseline/graph/nodes.yaml"), "utf8"),
        readFile(path.resolve(import.meta.dirname, "../koni/baseline/rules/research.yaml"), "utf8"),
        readFile(
          path.resolve(import.meta.dirname, "../koni/baseline/checks/research.yaml"),
          "utf8",
        ),
        readFile(
          path.resolve(import.meta.dirname, "../koni/baseline/workflows/research.yaml"),
          "utf8",
        ),
        readFile(
          path.resolve(import.meta.dirname, "../koni/baseline/operations/research.yaml"),
          "utf8",
        ),
      ]);
    const nodeDocument = YAML.parse(nodeSource) as {
      node_types: Array<{
        id: string;
        fields?: Record<string, { type: string; required?: boolean; enum?: string[] }>;
      }>;
    };
    const ruleDocument = YAML.parse(ruleSource) as {
      rules: Array<{
        id: string;
        when?: unknown;
        emit?: { obligations?: string[] };
      }>;
    };
    const checkDocument = YAML.parse(checkSource) as {
      checks: Array<{ id: string; predicate?: unknown }>;
    };
    const workflowDocument = YAML.parse(workflowSource) as {
      workflows: Array<{
        id: string;
        steps: Array<{ id: string; expected_output: string }>;
      }>;
    };
    const operationDocument = YAML.parse(operationSource) as {
      operations: Array<{ id: string; output_contract?: string }>;
    };

    expect(
      nodeDocument.node_types.find(({ id }) => id === "experiment")?.fields?.ablation_requirement,
    ).toMatchObject({
      type: "string",
      required: false,
      enum: ["required", "not_applicable"],
    });

    const readiness = ruleDocument.rules.find(
      ({ id }) => id === "readiness.experiment-constitution",
    );
    const ticket = ruleDocument.rules.find(({ id }) => id === "ticket.experiment-constitution");
    const gapCheck = checkDocument.checks.find(({ id }) => id === "gap.experiment-constitution");
    const serializedReadiness = JSON.stringify(readiness?.when);
    const serializedGap = JSON.stringify(ticket?.when);

    expect(serializedReadiness).toContain(
      '"field":"spec.ablation_requirement","value":"not_applicable"',
    );
    expect(serializedReadiness).toContain('"field":"spec.ablation_requirement","value":"required"');
    expect(serializedGap).toContain('"field":"spec.ablation_requirement"');
    expect(gapCheck?.predicate).toEqual(ticket?.when);
    expect(ticket?.emit?.obligations).toContain("experiment.ablation-disposition");
    expect(ticket?.emit?.obligations).not.toContain("experiment.ablations");

    const workflow = workflowDocument.workflows.find(
      ({ id }) => id === "design-experiment-constitution",
    );
    expect(workflow?.steps.find(({ id }) => id === "plan-ablations")?.expected_output).toContain(
      "not-applicable disposition",
    );
    expect(
      operationDocument.operations.find(
        ({ id }) => id === "preparation.experiment.design-experiment",
      )?.output_contract,
    ).toContain("ablation requirement disposition");

    const sharedGuidance = await readFile(
      path.resolve(
        import.meta.dirname,
        "../../core/skills/model-koni-work/references/empirical-research.md",
      ),
      "utf8",
    );
    expect(sharedGuidance).toContain("explicit applicability disposition");
    expect(sharedGuidance).toContain("Do not fabricate an ablation");
  });

  it("authorizes only the authenticated 1.0.11 release for inert-semantics retirement", async () => {
    const source = await readFile(
      path.resolve(import.meta.dirname, "../koni/profile-manifest.json"),
      "utf8",
    );
    const manifest = JSON.parse(source) as {
      migrations: Array<{ id: string; from_bundle_sha256: string[] }>;
    };
    const retirement = manifest.migrations.find(({ id }) => id === "retire-inert-semantics-v1");

    expect(retirement?.from_bundle_sha256).toEqual([
      "sha256:1bc8bdb64934ccd475f50acad5b22a7b1b6f7e168a748ecd91e234be76126c60",
    ]);
  });
});
