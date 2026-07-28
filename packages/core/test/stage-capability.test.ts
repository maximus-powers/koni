import { describe, expect, it } from "vitest";
import {
  STAGE_ACTION_INTENTS,
  STAGE_ACTION_INVOCATION_PROTOCOL,
  STAGE_CAPABILITY_CATALOG_PROTOCOL,
  StageActionInvocationError,
  StageCapabilityValidationError,
  assertStageCapabilityCatalog,
  defineBuiltInStageAction,
  defineStageCapabilityCatalog,
  defineStageInteraction,
  findStageActionCapability,
  validateStageActionInvocation,
  type StageActionCapability,
  type StageActionFormSchema,
  type StageCapability,
  type StageCapabilityCatalog,
} from "../src/state/stage-capability.js";

describe("compiler-authored stage capability authority", () => {
  it("represents every native lifecycle action without inferring availability", () => {
    const actions = STAGE_ACTION_INTENTS.map((intent, index) =>
      defineBuiltInStageAction({
        id: `action-${index + 1}`,
        intent,
        available: index % 2 === 0,
        reason:
          index % 2 === 0
            ? "Compiler preconditions are satisfied."
            : "Compiler preconditions are not satisfied.",
        ...(intent === "execute_action" ||
        intent === "update_orchestration" ||
        intent === "retry_terminal_resolver"
          ? { form: simpleForm() }
          : {}),
      }),
    );

    expect(actions.map(({ intent }) => intent)).toEqual(STAGE_ACTION_INTENTS);
    expect(actions[0]!.availability).toEqual({
      state: "available",
      reason: "Compiler preconditions are satisfied.",
    });
    expect(actions[1]!.availability).toEqual({
      state: "disabled",
      reason: "Compiler preconditions are not satisfied.",
    });
    for (const intent of ["authorize_promotion", "delete_run", "authorize_merge"] as const) {
      expect(actions.find((action) => action.intent === intent)?.confirmation.required).toBe(true);
    }
    expect(actions.find((action) => action.intent === "answer_question")?.surface).toBe(
      "question_dialog",
    );
    expect(actions.find((action) => action.intent === "inspect_run_deletion")?.surface).toBe(
      "delete_dialog",
    );
    expect(actions.find((action) => action.intent === "inspect_run_merge")?.surface).toBe(
      "merge_dialog",
    );
  });

  it("models automatic, operator, and explicitly actionless stages", () => {
    const drive = defineBuiltInStageAction({
      id: "drive-checkpoint",
      intent: "drive_stage",
      available: true,
      reason: "The checkpoint is ready for operator input.",
    });
    const stages: StageCapability[] = [
      stage({
        id: "compiled-plan",
        position: 0,
        status: "succeeded",
        current: false,
        interaction: defineStageInteraction({
          mode: "none",
          reason: "This stage is complete and has no operator control.",
          actions: [],
        }),
      }),
      stage({
        id: "automatic-work",
        position: 1,
        status: "active",
        current: true,
        interaction: defineStageInteraction({
          mode: "automatic",
          reason: "Compiler scheduling is advancing this stage automatically.",
          actions: [],
        }),
      }),
      stage({
        id: "manual-checkpoint",
        position: 2,
        status: "pending",
        current: false,
        actions: [
          {
            ...drive,
            availability: { state: "disabled", reason: "An earlier stage is still active." },
          },
        ],
        interaction: defineStageInteraction({
          mode: "operator",
          reason: "This checkpoint becomes actionable after automatic work completes.",
          actions: [
            {
              ...drive,
              availability: { state: "disabled", reason: "An earlier stage is still active." },
            },
          ],
          primaryActionId: drive.id,
        }),
      }),
    ];
    const catalog = defineStageCapabilityCatalog(catalogWith({ stages }));

    expect(catalog.protocol).toBe(STAGE_CAPABILITY_CATALOG_PROTOCOL);
    expect(catalog.stages.map(({ interaction }) => interaction.mode)).toEqual([
      "none",
      "automatic",
      "operator",
    ]);
    expect(catalog.stages[2]!.interaction.primaryActionId).toBe("drive-checkpoint");
  });

  it("validates an available form action and injects immutable compiler-bound context", () => {
    const action = configuredAction();
    const catalog = defineStageCapabilityCatalog(catalogWith({ runActions: [action] }));
    const validated = validateStageActionInvocation(
      catalog,
      invocation(action.id, {
        mode: "safe",
        instructions: "Preserve the existing behavior.\nRun the focused verifier.",
        retries: 2,
        tags: ["compiler", "focused"],
        dryRun: false,
      }),
    );

    expect(validated.binding).toEqual(catalog.binding);
    expect(validated.capability.intent).toBe("execute_action");
    expect(validated.values).toEqual({
      ticket: "ticket-private-1",
      mode: "safe",
      instructions: "Preserve the existing behavior.\nRun the focused verifier.",
      retries: 2,
      tags: ["compiler", "focused"],
      dryRun: false,
    });
    expect(action.form?.fields[0]).toMatchObject({
      locked: true,
      visibility: "summary",
      displayValue: "Selected ticket",
    });
  });

  it("rejects changed locked context, unknown inputs, missing required fields, and invalid choices", () => {
    const action = configuredAction();
    const catalog = catalogWith({ runActions: [action] });
    expectInvocationCode(
      () =>
        validateStageActionInvocation(
          catalog,
          invocation(action.id, {
            ticket: "another-ticket",
            mode: "safe",
            instructions: "Do the work.",
          }),
        ),
      "locked_field",
    );
    expectInvocationCode(
      () =>
        validateStageActionInvocation(
          catalog,
          invocation(action.id, {
            mode: "safe",
            instructions: "Do the work.",
            invented: true,
          }),
        ),
      "unknown_field",
    );
    expectInvocationCode(
      () =>
        validateStageActionInvocation(
          catalog,
          invocation(action.id, {
            mode: "safe",
          }),
        ),
      "required_field",
    );
    expectInvocationCode(
      () =>
        validateStageActionInvocation(
          catalog,
          invocation(action.id, {
            mode: "unsafe",
            instructions: "Do the work.",
          }),
        ),
      "invalid_field",
    );
    expectInvocationCode(
      () =>
        validateStageActionInvocation(
          catalog,
          invocation(action.id, {
            mode: "safe",
            instructions: "Do the work.",
            retries: 9,
          }),
        ),
      "invalid_field",
    );
  });

  it("fails closed for stale, cross-run, unknown, disabled, and unconfirmed actions", () => {
    const disabled = defineBuiltInStageAction({
      id: "retry-run",
      intent: "retry_blocked",
      available: false,
      reason: "The failure is terminal and has no compiler-authored retry path.",
    });
    const destructive = defineBuiltInStageAction({
      id: "delete-run",
      intent: "delete_run",
      available: true,
      reason: "Deletion preview is current and every session is stopped.",
    });
    const catalog = catalogWith({ runActions: [disabled, destructive] });

    expectInvocationCode(
      () => validateStageActionInvocation(catalog, invocation(disabled.id)),
      "disabled",
    );
    expectInvocationCode(
      () => validateStageActionInvocation(catalog, invocation(destructive.id)),
      "confirmation_required",
    );
    expectInvocationCode(
      () =>
        validateStageActionInvocation(catalog, {
          ...invocation(destructive.id, {}, true),
          runId: "run-other",
        }),
      "wrong_run",
    );
    expectInvocationCode(
      () =>
        validateStageActionInvocation(catalog, {
          ...invocation(destructive.id, {}, true),
          runRevision: 42,
        }),
      "stale_revision",
    );
    expectInvocationCode(
      () =>
        validateStageActionInvocation(catalog, {
          ...invocation(destructive.id, {}, true),
          generation: 3,
        }),
      "stale_generation",
    );
    expectInvocationCode(
      () => validateStageActionInvocation(catalog, invocation("gone", {}, true)),
      "unknown_capability",
    );

    expect(
      validateStageActionInvocation(catalog, invocation(destructive.id, {}, true)).capability
        .intent,
    ).toBe("delete_run");
  });

  it("does not authorize an action by its title or description", () => {
    const action = defineBuiltInStageAction({
      id: "approve-revision-7",
      intent: "approve_run",
      available: true,
      reason: "The exact current plan revision is reviewable.",
      title: "looks-safe",
      description: "Presentation copy is not an identifier.",
    });
    const catalog = catalogWith({ runActions: [action] });

    expect(findStageActionCapability(catalog, "approve-revision-7")?.intent).toBe("approve_run");
    expect(findStageActionCapability(catalog, "looks-safe")).toBeUndefined();
    expectInvocationCode(
      () => validateStageActionInvocation(catalog, invocation("looks-safe")),
      "unknown_capability",
    );
  });

  it("rejects destructive actions without an explicit confirmation contract", () => {
    expect(() =>
      defineBuiltInStageAction({
        id: "unsafe-delete",
        intent: "delete_run",
        available: true,
        reason: "Preview is current.",
        confirmation: { required: false },
      }),
    ).toThrow(/requires explicit confirmation/u);
  });

  it("rejects duplicate identities, ambiguous pipeline positions, and multiple current stages", () => {
    const first = stage({ id: "first", position: 0, current: true, status: "active" });
    const second = stage({ id: "second", position: 1, current: true, status: "waiting" });
    expect(() => assertStageCapabilityCatalog(catalogWith({ stages: [first, second] }))).toThrow(
      /at most one current stage/u,
    );
    expect(() =>
      assertStageCapabilityCatalog(
        catalogWith({
          stages: [first, stage({ id: "first", position: 1, current: false })],
        }),
      ),
    ).toThrow(/duplicates stage/u);
    expect(() =>
      assertStageCapabilityCatalog(
        catalogWith({
          stages: [first, stage({ id: "second", position: 0, current: false })],
        }),
      ),
    ).toThrow(/increase strictly/u);

    const action = defineBuiltInStageAction({
      id: "same-action",
      intent: "pause_run",
      available: true,
      reason: "Run can pause.",
    });
    expect(() =>
      assertStageCapabilityCatalog(catalogWith({ runActions: [action, action] })),
    ).toThrow(/duplicates action/u);
  });

  it("rejects available controls on historical stages and incoherent interaction modes", () => {
    const drive = defineBuiltInStageAction({
      id: "drive-old-stage",
      intent: "drive_stage",
      available: true,
      reason: "Incorrectly claimed as actionable.",
    });
    expect(() =>
      assertStageCapabilityCatalog(
        catalogWith({
          stages: [stage({ id: "old", position: 0, current: false, actions: [drive] })],
        }),
      ),
    ).toThrow(/non-current stage/u);
    expect(() =>
      defineStageInteraction({
        mode: "none",
        reason: "No controls.",
        actions: [drive],
      }),
    ).toThrow(/no-action stage/u);
    expect(() =>
      defineStageInteraction({
        mode: "operator",
        reason: "Needs operator input.",
        actions: [drive],
      }),
    ).toThrow(/requires a primary action/u);
    expect(() =>
      defineStageInteraction({
        mode: "operator",
        reason: "Needs operator input.",
        actions: [drive],
        primaryActionId: "missing",
      }),
    ).toThrow(/must identify an action/u);
  });

  it("strictly rejects unknown protocol fields and unsafe terminal text", () => {
    const catalog = catalogWith({});
    expect(() => assertStageCapabilityCatalog({ ...catalog, ambientPermission: true })).toThrow(
      /not part of this protocol/u,
    );
    const unsafe = structuredClone(catalog) as unknown as Record<string, unknown>;
    (unsafe.runActions as unknown[]) = [
      {
        ...defineBuiltInStageAction({
          id: "pause",
          intent: "pause_run",
          available: true,
          reason: "Run can pause.",
        }),
        title: "Pause\u001b[31m",
      },
    ];
    expect(() => assertStageCapabilityCatalog(unsafe)).toThrow(/terminal control/u);
    expect(() =>
      assertStageCapabilityCatalog({ ...catalog, protocol: "koni.stage-capability-catalog.v2" }),
    ).toThrow(/must equal/u);
  });

  it("validates summary-only and hidden compiler-bound fields without exposing them as editable", () => {
    const form = simpleForm();
    form.fields = [
      {
        key: "checkout",
        label: "Checkout",
        description: "Compiler-selected ticket checkout.",
        kind: "text",
        required: true,
        locked: true,
        visibility: "hidden",
        lockedValue: "/opaque/compiler/context",
      },
      {
        key: "ticket",
        label: "Ticket",
        description: "Current ticket context.",
        kind: "text",
        required: true,
        locked: true,
        visibility: "summary",
        lockedValue: "ticket-private-1",
        displayValue: "Selected ticket",
      },
    ];
    const action = defineBuiltInStageAction({
      id: "configured-action",
      intent: "execute_action",
      available: true,
      reason: "Compiler context is bound.",
      form,
    });
    const result = validateStageActionInvocation(
      catalogWith({ runActions: [action] }),
      invocation(action.id),
    );
    expect(result.values).toEqual({
      checkout: "/opaque/compiler/context",
      ticket: "ticket-private-1",
    });
  });

  it("returns defensive clones so callers cannot rewrite the compiler document through a view", () => {
    const source = catalogWith({ runActions: [configuredAction()] });
    const defined = defineStageCapabilityCatalog(source);
    source.runActions[0]!.availability.reason = "mutated";
    expect(defined.runActions[0]!.availability.reason).toBe(
      "The configured action is compiler-authorized.",
    );

    const validated = validateStageActionInvocation(
      defined,
      invocation("configured-action", {
        mode: "safe",
        instructions: "Apply the compiler-owned recipe.",
      }),
    );
    validated.capability.availability.reason = "changed";
    expect(defined.runActions[0]!.availability.reason).toBe(
      "The configured action is compiler-authorized.",
    );
  });
});

function simpleForm(): StageActionFormSchema {
  return {
    title: "Configured action",
    description: "Provide compiler-validated action input.",
    submitLabel: "Run action",
    fields: [],
  };
}

function configuredAction(): StageActionCapability {
  return defineBuiltInStageAction({
    id: "configured-action",
    intent: "execute_action",
    available: true,
    reason: "The configured action is compiler-authorized.",
    title: "Apply focused change",
    description: "Apply the configured recipe to the selected ticket.",
    form: {
      title: "Apply focused change",
      description: "Context is bound by the compiler; only unlocked values are operator-editable.",
      submitLabel: "Run action",
      fields: [
        {
          key: "ticket",
          label: "Ticket",
          description: "Compiler-selected ticket context.",
          kind: "text",
          required: true,
          locked: true,
          visibility: "summary",
          lockedValue: "ticket-private-1",
          displayValue: "Selected ticket",
        },
        {
          key: "mode",
          label: "Mode",
          description: "Execution mode.",
          kind: "select",
          required: true,
          locked: false,
          visibility: "shown",
          options: [
            { value: "safe", label: "Safe", description: "Use the compiler-owned safety checks." },
            { value: "audit", label: "Audit", description: "Inspect without a workspace effect." },
          ],
        },
        {
          key: "instructions",
          label: "Instructions",
          description: "Additional bounded operator guidance.",
          kind: "multiline",
          required: true,
          locked: false,
          visibility: "shown",
          maxBytes: 4096,
        },
        {
          key: "retries",
          label: "Retries",
          description: "Maximum action attempts.",
          kind: "integer",
          required: false,
          locked: false,
          visibility: "shown",
          defaultValue: 1,
          minimum: 0,
          maximum: 3,
        },
        {
          key: "tags",
          label: "Tags",
          description: "Optional semantic tags.",
          kind: "string_list",
          required: false,
          locked: false,
          visibility: "shown",
          minItems: 0,
          maxItems: 4,
        },
        {
          key: "dryRun",
          label: "Dry run",
          description: "Request a dry run when the configured action supports it.",
          kind: "boolean",
          required: false,
          locked: false,
          visibility: "shown",
          defaultValue: true,
        },
      ],
    },
  });
}

function stage(
  overrides: Partial<StageCapability> & Pick<StageCapability, "id" | "position">,
): StageCapability {
  const actions = overrides.actions ?? [];
  return {
    id: overrides.id,
    title: overrides.title ?? overrides.id.replaceAll("-", " "),
    kind: overrides.kind ?? "checkpoint",
    category: overrides.category ?? "workflow",
    position: overrides.position,
    status: overrides.status ?? "pending",
    current: overrides.current ?? false,
    interaction:
      overrides.interaction ??
      defineStageInteraction({
        mode: actions.length === 0 ? "none" : "operator",
        reason:
          actions.length === 0
            ? "No operator action is available."
            : "Operator input is available.",
        actions,
        ...(actions[0] === undefined ? {} : { primaryActionId: actions[0].id }),
      }),
    actions,
    ...(overrides.summary === undefined ? {} : { summary: overrides.summary }),
  };
}

function catalogWith(overrides: Partial<StageCapabilityCatalog>): StageCapabilityCatalog {
  return {
    protocol: STAGE_CAPABILITY_CATALOG_PROTOCOL,
    binding: {
      runId: "run-one",
      runRevision: 7,
      generation: 2,
      phase: "executing",
    },
    stages: [],
    runActions: [],
    ...overrides,
  };
}

function invocation(
  capabilityId: string,
  values: Record<string, string | number | boolean | string[]> = {},
  confirmed = false,
) {
  return {
    protocol: STAGE_ACTION_INVOCATION_PROTOCOL,
    runId: "run-one",
    runRevision: 7,
    generation: 2,
    capabilityId,
    confirmed,
    values,
  } as const;
}

function expectInvocationCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(StageActionInvocationError);
    expect((error as StageActionInvocationError).code).toBe(code);
  }
}

void StageCapabilityValidationError;
