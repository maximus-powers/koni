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

describe("coding profile registrar", () => {
  it("keeps the medium planning frontier while reserving correction headroom", async () => {
    const source = await readFile(
      path.resolve(import.meta.dirname, "../koni/baseline/run-types/medium.yaml"),
      "utf8",
    );
    const document = YAML.parse(source) as {
      planning: {
        token_budget: {
          metric: string;
          limit: number;
          synthesis_reserve: number;
          on_exhausted: string;
        };
      };
    };
    const budget = document.planning.token_budget;

    expect(budget).toEqual({
      metric: "new_tokens",
      limit: 210_000,
      synthesis_reserve: 120_000,
      on_exhausted: "force_synthesis",
    });
    expect(budget.limit - budget.synthesis_reserve).toBe(90_000);
  });

  it("routes proof-spec defects through bounded native change control", async () => {
    const [operationsSource, workflowsSource, executionReference] = await Promise.all([
      readFile(path.resolve(import.meta.dirname, "../koni/baseline/operations.yaml"), "utf8"),
      readFile(path.resolve(import.meta.dirname, "../koni/baseline/workflows.yaml"), "utf8"),
      readFile(
        path.resolve(
          import.meta.dirname,
          "../../core/skills/model-koni-work/references/execution-contracts.md",
        ),
        "utf8",
      ),
    ]);
    const operations = YAML.parse(operationsSource) as {
      operations: Array<{
        id: string;
        operation: string;
        target_types?: string[];
        allowed_existing_node_types?: string[];
        output_contract?: string;
        change_control?: Record<string, unknown>;
      }>;
    };
    const workflows = YAML.parse(workflowsSource) as {
      workflows: Array<{ id: string; applies_to: string[]; review_rework_limit?: number }>;
    };

    expect(
      operations.operations.find(({ id }) => id === "assurance.proof.prepare")?.change_control,
    ).toEqual({
      role: "ordinary",
      allow_upstream_requests: true,
      proposal_operation: "change-request",
    });
    expect(
      operations.operations.find(({ id }) => id === "lifecycle.change-request")?.change_control,
    ).toMatchObject({
      role: "proposal",
      proposal_step: "propose-graph-delta",
      decision_policy: "automatic",
      application_operations: ["apply-change-request", "no-op"],
    });
    expect(
      operations.operations.find(({ id }) => id === "lifecycle.apply-change-request")
        ?.change_control,
    ).toEqual({ role: "application" });
    const proposal = operations.operations.find(({ id }) => id === "lifecycle.change-request");
    const application = operations.operations.find(
      ({ id }) => id === "lifecycle.apply-change-request",
    );
    const proofClosureNodeTypes = ["proof", "contract", "flow", "defect", "risk"];
    expect(proposal?.target_types).toEqual(proofClosureNodeTypes);
    expect(application?.target_types).toEqual(proofClosureNodeTypes);
    expect(application?.allowed_existing_node_types).toEqual(proofClosureNodeTypes);
    expect(proposal?.output_contract).toContain("complete bounded semantic correction set");
    expect(executionReference.replace(/\s+/gu, " ")).toContain(
      "Target every existing causal node whose authored fields must change together for one internally consistent correction",
    );
    expect(workflows.workflows.find(({ id }) => id === "change-request")).toMatchObject({
      applies_to: ["change-request", "no-op"],
      review_rework_limit: 2,
    });
    expect(workflows.workflows.find(({ id }) => id === "apply-change-request")).toMatchObject({
      applies_to: ["apply-change-request"],
      review_rework_limit: 2,
    });
  });

  it("keeps every automatic review-rework workflow bounded to two corrections", async () => {
    const source = await readFile(
      path.resolve(import.meta.dirname, "../koni/baseline/workflows.yaml"),
      "utf8",
    );
    const document = YAML.parse(source) as {
      workflows: Array<{
        review_failure_reopen_from?: string;
        review_failure_routes?: Record<string, unknown>;
        review_rework_limit?: number;
      }>;
    };
    const reworking = document.workflows.filter(
      (workflow) =>
        workflow.review_failure_reopen_from !== undefined ||
        workflow.review_failure_routes !== undefined,
    );

    expect(reworking.length).toBeGreaterThan(0);
    expect(reworking.every((workflow) => workflow.review_rework_limit === 2)).toBe(true);
  });

  it("ships one queued ticket waiting state across every lifecycle return path", async () => {
    const source = await readFile(
      path.resolve(import.meta.dirname, "../koni/baseline/lifecycle.yaml"),
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
        expect.objectContaining({ id: "approve", from: ["proposed"], to: "queued" }),
        expect.objectContaining({ id: "start", from: ["queued"], to: "in_progress" }),
        expect.objectContaining({ id: "release", from: ["blocked"], to: "queued" }),
        expect.objectContaining({
          id: "interrupt-active",
          from: ["in_progress"],
          to: "queued",
        }),
        expect.objectContaining({
          id: "reopen-stale-obligation",
          from: ["closed", "retired"],
          to: "queued",
        }),
        expect.objectContaining({ id: "retire", from: ["proposed", "queued", "blocked"] }),
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
    expect(PROFILE_DESCRIPTOR.package).toBe("@koni/coding-profile");
    expect(PROFILE_DESCRIPTOR.manifest_url).toMatch(/\/koni\/profile-manifest\.json$/);
    extensionHandlers.get("session_shutdown")?.();
    expect(eventHandlers.size).toBe(0);
  });

  it("does not ship a parallel Pi resource registry", async () => {
    await expect(
      readFile(path.resolve(import.meta.dirname, "../koni/baseline/resources/pi-packages.yaml")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps obligation reasons complete instead of parsing prose as null YAML keys", async () => {
    const source = await readFile(
      path.resolve(import.meta.dirname, "../koni/baseline/rules.yaml"),
      "utf8",
    );
    const document = YAML.parse(source) as {
      rules: Array<{ id: string; derive?: Array<Record<string, unknown>> }>;
    };
    const obligations = document.rules.flatMap((rule) =>
      (rule.derive ?? [])
        .filter((entry) => entry.kind === "obligation")
        .map((entry) => ({ ruleId: rule.id, entry })),
    );

    expect(obligations.length).toBeGreaterThan(0);
    for (const { entry } of obligations) {
      expect(Object.keys(entry).sort()).toEqual(["key", "kind", "reason", "severity"]);
      expect(typeof entry.reason).toBe("string");
    }
    expect(obligations.find(({ ruleId }) => ruleId === "objective.plan-change")?.entry.reason).toBe(
      "Objective lacks a classified, proof-bound, risk-appropriate vertical change plan",
    );
    expect(obligations.find(({ ruleId }) => ruleId === "defect.diagnose")?.entry.reason).toBe(
      "Defect lacks confirmed root cause, causal chain, or ruled-out alternatives",
    );
  });

  it("keeps the shared Medium authoring example aligned with the shipped Coding defaults", async () => {
    const [runTypeSource, referenceSource] = await Promise.all([
      readFile(path.resolve(import.meta.dirname, "../koni/baseline/run-types/medium.yaml"), "utf8"),
      readFile(
        path.resolve(
          import.meta.dirname,
          "../../core/skills/configure-koni/references/run-types.md",
        ),
        "utf8",
      ),
    ]);
    const codeFence = referenceSource.match(/```yaml\n([\s\S]*?)\n```/);
    expect(codeFence?.[1]).toBeDefined();

    const canonicalRoles = {
      planner: { model: "gpt-5.6-sol", thinking_level: "max" },
      lead: { model: "gpt-5.6-sol", thinking_level: "xhigh" },
      ticket_worker: { model: "gpt-5.6-terra", thinking_level: "high" },
      reviewer: { model: "gpt-5.6-sol", thinking_level: "max" },
    };
    const runType = YAML.parse(runTypeSource) as { agents: { roles: unknown } };
    const example = YAML.parse(codeFence![1]!) as { agents: { roles: unknown } };

    expect(runType.agents.roles).toEqual(canonicalRoles);
    expect(example.agents.roles).toEqual(canonicalRoles);
  });

  it("lets the compiler schedule default coding runs without automatic Lead provider gates", async () => {
    const runTypes = await Promise.all(
      ["small", "medium", "large"].map(async (id) => {
        const source = await readFile(
          path.resolve(import.meta.dirname, `../koni/baseline/run-types/${id}.yaml`),
          "utf8",
        );
        return YAML.parse(source) as {
          orchestration: { lead_action: string; lead_triggers: string[] };
        };
      }),
    );

    for (const runType of runTypes) {
      expect(runType.orchestration.lead_action).toBe("spawn-lead");
      expect(runType.orchestration.lead_triggers).toEqual([]);
    }
  });

  it("uses Medium as the general-purpose default while keeping intent presets explicit", async () => {
    const projectSource = await readFile(
      path.resolve(import.meta.dirname, "../koni/baseline/project.yaml"),
      "utf8",
    );
    const project = YAML.parse(projectSource) as {
      default_run_type: string;
      run_types: Array<{ id: string }>;
    };

    expect(project.default_run_type).toBe("medium");
    expect(project.run_types.map((runType) => runType.id)).toContain("continuous-improvement");
  });

  it("judges orchestration from the progressive executable frontier", async () => {
    const [leadSource, plannerSource, runTypesReference, rulesReference, agentsReference] =
      await Promise.all([
        readFile(path.resolve(import.meta.dirname, "../koni/baseline/agents/lead.yaml"), "utf8"),
        readFile(
          path.resolve(import.meta.dirname, "../koni/baseline/agents/run-planner.yaml"),
          "utf8",
        ),
        readFile(
          path.resolve(
            import.meta.dirname,
            "../../core/skills/configure-koni/references/run-types.md",
          ),
          "utf8",
        ),
        readFile(
          path.resolve(
            import.meta.dirname,
            "../../core/skills/model-koni-work/references/rules-and-tickets.md",
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
    const lead = YAML.parse(leadSource) as { instructions: string };
    const planner = YAML.parse(plannerSource) as { instructions: string };
    const normalized = lead.instructions.replace(/\s+/gu, " ");
    const normalizedPlanner = planner.instructions.replace(/\s+/gu, " ");
    const normalizedRunTypesReference = runTypesReference.replace(/\s+/gu, " ");
    const normalizedRulesReference = rulesReference.replace(/\s+/gu, " ");
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
    expect(normalized).not.toContain(
      "when at least one current operation advances an approved path",
    );
    expect(normalizedRunTypesReference).toContain(
      "A reviewed ticket with all required steps complete and no supplied blocker is a compiler-managed publication frontier",
    );
    expect(normalizedRulesReference).toContain(
      "A ticket in review with every required step complete and no supplied blocker can advance closure through publication",
    );
    expect(normalizedRulesReference).toContain(
      "An incomplete or blocked review remains nonpassing",
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
      "Judge a current queued recovery or repair ticket from its own supplied objective, dependencies, scope, and compiler-issued creation authority",
    );
  });

  it("grounds proof authority before planning and re-evaluates rework against current evidence", async () => {
    const [plannerSource, reviewerSource, softwareReference, executionReference] =
      await Promise.all([
        readFile(
          path.resolve(import.meta.dirname, "../koni/baseline/agents/run-planner.yaml"),
          "utf8",
        ),
        readFile(
          path.resolve(import.meta.dirname, "../koni/baseline/agents/reviewer.yaml"),
          "utf8",
        ),
        readFile(
          path.resolve(
            import.meta.dirname,
            "../../core/skills/model-koni-work/references/software-projects.md",
          ),
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
    const normalizedPlanner = plannerSource.replace(/\s+/gu, " ");
    const normalizedReviewer = reviewerSource.replace(/\s+/gu, " ");
    const normalizedSoftwareReference = softwareReference.replace(/\s+/gu, " ");
    const normalizedExecutionReference = executionReference.replace(/\s+/gu, " ");

    expect(normalizedPlanner).toContain(
      "Complete the skill's proof-construction ledger before serializing any proof node",
    );
    expect(normalizedPlanner).toContain(
      "A filename in a listing or search result authenticates identity, not the file's command, environment, or convention semantics",
    );
    expect(normalizedPlanner).toContain(
      "Record every material proof-construction boundary in one closed ledger",
    );
    expect(normalizedPlanner).toContain(
      "an authenticated repository path in its exact proof field or an evidence-backed `not applicable` disposition",
    );
    expect(normalizedPlanner).toContain(
      "`source_paths` and `covered_paths` cannot substitute for missing read-only support evidence",
    );
    expect(normalizedPlanner).toContain(
      "Reconcile the closed ledger against the downstream proof-preparation contract before submission",
    );
    expect(normalizedSoftwareReference).toContain(
      "Place every repository input relied on by the selected proof in exactly the proof field matching its authority role",
    );
    expect(normalizedSoftwareReference).toContain(
      "A proof-construction ledger is closed only when every material boundary has either an authenticated repository input in its exact authority field or an evidence-backed `not applicable` disposition",
    );
    expect(normalizedSoftwareReference).toContain(
      "Proof source or covered product paths never stand in for missing support evidence",
    );
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
  });

  it("keeps downstream composition review within its own authority boundary", async () => {
    const [reviewerSource, workflowSource, executionReference] = await Promise.all([
      readFile(path.resolve(import.meta.dirname, "../koni/baseline/agents/reviewer.yaml"), "utf8"),
      readFile(path.resolve(import.meta.dirname, "../koni/baseline/workflows.yaml"), "utf8"),
      readFile(
        path.resolve(
          import.meta.dirname,
          "../../core/skills/model-koni-work/references/execution-contracts.md",
        ),
        "utf8",
      ),
    ]);
    const normalizedReviewer = reviewerSource.replace(/\s+/gu, " ");
    const normalizedWorkflow = workflowSource.replace(/\s+/gu, " ");
    const normalizedExecutionReference = executionReference.replace(/\s+/gu, " ");

    expect(normalizedReviewer).toContain(
      "At a downstream composition boundary, treat a compiler-current upstream artifact with completed independent review as authoritative for the claims that review accepted",
    );
    expect(normalizedReviewer).toContain(
      "Do not repeat that upstream semantic review from the same evidence",
    );
    expect(normalizedWorkflow).toContain(
      "rely on each included proof's completed independent semantic review unless current downstream evidence proves drift, contradiction, or an interaction defect",
    );
    expect(normalizedExecutionReference).toContain(
      "Validate currentness, exact membership, and downstream interactions; do not repeat that upstream semantic review from the same evidence",
    );
  });

  it("plans repository paths only from accepted evidence", async () => {
    const [plannerSource, softwareReference, executionReference] = await Promise.all([
      readFile(
        path.resolve(import.meta.dirname, "../koni/baseline/agents/run-planner.yaml"),
        "utf8",
      ),
      readFile(
        path.resolve(
          import.meta.dirname,
          "../../core/skills/model-koni-work/references/software-projects.md",
        ),
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
    const normalizedSoftwareReference = softwareReference.replace(/\s+/gu, " ");
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
      "A package, directory, or generic shared component name identifies only a candidate owner",
    );
    expect(normalizedPlanner).toContain(
      "If a broad search is rejected or truncated, enumerate the plausible first-party roots and search them with bounded objective-specific terms",
    );
    expect(normalizedPlanner).toContain(
      "A bounded search with no objective-specific match is evidence against that candidate, not authority to model its generic seams",
    );
    expect(normalizedPlanner).toContain(
      "Do not inspect or serialize a candidate's generic implementation seams until positive objective-specific evidence selects it as the owner",
    );
    expect(normalizedPlanner).toContain(
      "continue bounded owner discovery across the remaining plausible first-party roots",
    );
    expect(normalizedSoftwareReference).toContain(
      "Require positive first-party evidence that binds the named surface to its selected owner",
    );
    expect(normalizedSoftwareReference).toContain(
      "Do not stop at the first lexically plausible package or directory",
    );
    expect(normalizedSoftwareReference).toContain(
      "Do not inspect or serialize that candidate's generic implementation seams until positive objective-specific evidence selects it",
    );
    expect(normalizedSoftwareReference).toContain(
      "continue bounded owner discovery across the remaining plausible first-party roots",
    );
    expect(normalizedReference).toContain(
      "Every pre-existing repository input or mutation target must appear verbatim in accepted repository evidence",
    );
  });

  it("gives Medium planning enough bounded discovery to load its Software modeling method", async () => {
    const [runTypeSource, plannerSource] = await Promise.all([
      readFile(path.resolve(import.meta.dirname, "../koni/baseline/run-types/medium.yaml"), "utf8"),
      readFile(
        path.resolve(import.meta.dirname, "../koni/baseline/agents/run-planner.yaml"),
        "utf8",
      ),
    ]);
    const runType = YAML.parse(runTypeSource) as {
      planning: { max_repository_tool_calls: number };
    };
    const planner = YAML.parse(plannerSource) as {
      schema_version: string;
      instructions: string;
      pi: { settings: { skills: string[] } };
      koni: { role: string; capabilities: { workspace_access: string } };
    };
    const normalizedInstructions = planner.instructions.replace(/\s+/gu, " ");

    expect(runType.planning.max_repository_tool_calls).toBe(32);
    expect(planner).toMatchObject({
      schema_version: "3.0",
      pi: { settings: { skills: expect.arrayContaining(["dist/skills/model-koni-work/**"]) } },
      koni: { role: "planner", capabilities: { workspace_access: "read_only" } },
    });
    expect(normalizedInstructions).toContain(
      "Load `model-koni-work` and its `software-projects` reference before repository discovery",
    );
  });

  it("requires historically executable proof contracts at the application-owned seam", async () => {
    const [plannerSource, referenceSource] = await Promise.all([
      readFile(
        path.resolve(import.meta.dirname, "../koni/baseline/agents/run-planner.yaml"),
        "utf8",
      ),
      readFile(
        path.resolve(
          import.meta.dirname,
          "../../core/skills/model-koni-work/references/software-projects.md",
        ),
        "utf8",
      ),
    ]);
    const planner = YAML.parse(plannerSource) as { instructions: string };
    const normalizedPlanner = planner.instructions.replace(/\s+/gu, " ");
    const normalizedReference = referenceSource.replace(/\s+/gu, " ");

    expect(normalizedPlanner).toContain(
      "Perform the shared historical-executability audit before selecting a proof strategy",
    );
    expect(normalizedPlanner).toContain(
      "Bind each case to the transition or observation the application actually owns",
    );
    expect(normalizedPlanner).toContain(
      "keep fixture setup and every unchanged or preservation route executable without the missing target",
    );
    expect(normalizedPlanner).toContain(
      "allow that target invocation itself to be the isolated red at its real application seam",
    );
    expect(normalizedReference).toContain(
      "Only the intended target assertion may be absent or red before implementation",
    );
  });

  it("separates proof support evidence from product coverage and writable proof source", async () => {
    const [graphSource, rulesSource, workflowsSource, checksSource] = await Promise.all([
      readFile(path.resolve(import.meta.dirname, "../koni/baseline/graph.yaml"), "utf8"),
      readFile(path.resolve(import.meta.dirname, "../koni/baseline/rules.yaml"), "utf8"),
      readFile(path.resolve(import.meta.dirname, "../koni/baseline/workflows.yaml"), "utf8"),
      readFile(path.resolve(import.meta.dirname, "../koni/baseline/checks.yaml"), "utf8"),
    ]);
    const graph = YAML.parse(graphSource) as {
      node_types: Array<{
        id: string;
        fields: Record<string, { type: string; description?: string }>;
      }>;
    };
    const rules = YAML.parse(rulesSource) as {
      rules: Array<{
        id: string;
        emit?: { read_paths?: Array<{ field?: string }>; write_paths?: Array<{ field?: string }> };
      }>;
    };
    const workflows = YAML.parse(workflowsSource) as {
      workflows: Array<{
        id: string;
        steps: Array<{
          id: string;
          read_paths?: Array<{ field?: string }>;
          write_paths?: Array<{ field?: string }>;
          validation_action?: string;
        }>;
      }>;
    };
    const checks = YAML.parse(checksSource) as {
      checks: Array<{ id: string; graph_set?: Record<string, unknown> }>;
    };
    const proof = graph.node_types.find(({ id }) => id === "proof");
    expect(proof?.fields.support_paths).toMatchObject({ type: "list" });
    expect(proof?.fields.support_paths?.description).toContain("read-only repository files");

    const rule = rules.rules.find(({ id }) => id === "proof.prepare")?.emit;
    expect(rule?.read_paths?.map(({ field }) => field)).toContain("spec.support_paths");
    expect(rule?.write_paths?.map(({ field }) => field)).not.toContain("spec.support_paths");
    const step = workflows.workflows
      .find(({ id }) => id === "proof-preparation")
      ?.steps.find(({ id }) => id === "author-historical-baseline");
    expect(step?.read_paths?.map(({ field }) => field)).toContain("spec.support_paths");
    expect(step?.write_paths?.map(({ field }) => field)).not.toContain("spec.support_paths");
    expect(step?.validation_action).toBe("compile-ticket");

    for (const checkId of ["baseline-proof-set", "promotion-proof-set"]) {
      expect(checks.checks.find(({ id }) => id === checkId)?.graph_set?.support_paths_field).toBe(
        "spec.support_paths",
      );
    }
  });

  it("authorizes only the authenticated 0.7 release for inert-semantics retirement", async () => {
    const source = await readFile(
      path.resolve(import.meta.dirname, "../koni/profile-manifest.json"),
      "utf8",
    );
    const manifest = JSON.parse(source) as {
      migrations: Array<{ id: string; from_bundle_sha256: string[] }>;
    };
    const retirement = manifest.migrations.find(({ id }) => id === "retire-inert-semantics-v1");

    expect(retirement?.from_bundle_sha256).toEqual([
      "sha256:4e955f7fb5a6bbd58542f395471d2e3f1c87364840abd218f973b8f62a5c0c7e",
    ]);
  });
});
