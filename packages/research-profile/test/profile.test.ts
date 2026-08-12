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
    expect(normalizedAgentsReference).toContain(
      "A qualitative gate must not turn conservative, reversible uncertainty into an operator confirmation",
    );
    expect(normalizedAgentsReference).toContain(
      "Reserve a question for cases where multiple materially different interpretations remain supported, would change current safety, and the authoritative context selects none",
    );
    expect(normalized).not.toContain(
      "when at least one current operation advances an approved path",
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
    expect(normalizedReference).toContain(
      "Graph write authority does not make grant-affecting fields mutable within the current ticket",
    );
    expect(normalizedReference).toContain(
      "Every pre-existing repository input or mutation target must appear verbatim in accepted repository evidence",
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
    const mutationByStep = Object.fromEntries(
      (workflow?.steps ?? []).map(({ id, graph_mutation }) => [id, graph_mutation]),
    );
    const normalizedReference = executionReference.replace(/\s+/gu, " ");

    expect(mutationByStep).toEqual({
      implement: "forbidden",
      verify: "forbidden",
      integrate: "required",
      review: "forbidden",
    });
    expect(normalizedReference).toContain(
      "A filesystem-only step must declare graph mutation forbidden and omit the graph delta",
    );
    expect(normalizedReference).toContain(
      "Do not reconstruct or echo an existing node merely to report unchanged authored fields",
    );
    expect(normalizedReference).toContain(
      "A later semantic integration step owns the required graph mutation",
    );
  });

  it("keeps run-plan compilation behind directly linked asset work", async () => {
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
