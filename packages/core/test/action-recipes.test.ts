import { describe, expect, it } from "vitest";
import {
  ActionRecipeError,
  compileActionCatalog,
  executeActionPlan,
  prepareActionInvocation,
  validateActionExecutionJournal,
} from "../src/compiler/action-recipes.js";
import type { ActionExecutionJournal, ActionPrimitiveHost } from "../src/contracts/behavior.js";
import type { ConfigurationObject, ConfigurationValue } from "../src/contracts/configuration.js";
import { canonicalHash } from "../src/shared/canonical.js";

describe("compiled action recipes", () => {
  it("compiles exact typed recipes, resolves aliases and parameters, and binds actor/context", () => {
    const catalog = fixtureCatalog();
    const plan = prepareActionInvocation({
      catalog,
      selector: "perform",
      invocationId: "invocation-1",
      actor: "compiler",
      parameters: { message: "hello" },
      context: { checkout: "main", values: { run: { id: "run-1" } } },
    });
    expect(plan).toMatchObject({
      actionId: "perform-work",
      actor: "compiler",
      parameters: { message: "hello" },
    });
    expect(plan.recipe[1]!.arguments).toEqual({
      type: "work.recorded",
      data: { message: "hello" },
    });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(() =>
      prepareActionInvocation({
        catalog,
        selector: "perform",
        invocationId: "invocation-2",
        actor: "lead",
        parameters: { message: "hello" },
        context: { checkout: "main" },
      }),
    ).toThrowError(expect.objectContaining({ code: "action_actor" }));
  });

  it.each([
    [
      "unknown primitive",
      [{ primitive: "ambient.shell", command: "rm" }],
      "configuration.action_primitive",
    ],
    [
      "unknown argument",
      [{ primitive: "project.validate", surprise: true }],
      "configuration.action_primitive_argument",
    ],
    [
      "missing required argument",
      [{ primitive: "event.append" }],
      "configuration.action_primitive_argument",
    ],
    [
      "wrong argument type",
      [{ primitive: "event.append", type: true }],
      "configuration.action_primitive_argument_type",
    ],
    [
      "unknown parameter template",
      [{ primitive: "event.append", type: "${params.missing}" }],
      "configuration.action_template",
    ],
    [
      "retired fixpoint source",
      [{ primitive: "rules.evaluate", max_passes_from: "orchestration.max_fixpoint_passes" }],
      "configuration.action_primitive_argument",
    ],
  ])("rejects %s before a run", (_name, recipe, code) => {
    const result = compileActionCatalog([source("bad", { id: "bad", recipe })]);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toContain(code);
  });

  it("executes a recipe once and returns a hash-bound terminal journal", async () => {
    const plan = fixturePlan();
    const calls: string[] = [];
    const journal = await executeActionPlan(
      plan,
      host(async (input) => {
        calls.push(input.effectKey);
        return { primitive: input.step.primitive };
      }),
    );
    expect(journal.status).toBe("completed");
    expect(calls).toHaveLength(plan.recipe.length);
    expect(canonicalHash(withoutJournalSha(journal))).toBe(journal.sha256);
    const replay = await executeActionPlan(
      plan,
      host(async () => {
        throw new Error("terminal replay called host");
      }),
      { journal },
    );
    expect(replay).toEqual(journal);
  });

  it("compensates an ordered recipe failure and never replays a compensated invocation", async () => {
    const plan = fixturePlan();
    const phases: string[] = [];
    const journal = await executeActionPlan(
      plan,
      host(async (input) => {
        phases.push(`${input.phase}:${input.step.primitive}`);
        if (input.phase === "recipe" && input.step.primitive === "event.append")
          throw new Error("write failed");
        return null;
      }),
    );
    expect(journal.status).toBe("compensated");
    expect(phases).toEqual([
      "recipe:project.validate",
      "recipe:event.append",
      "compensation:recovery.dispatch",
    ]);
    const replay = await executeActionPlan(
      plan,
      host(async () => {
        throw new Error("must not replay");
      }),
      { journal },
    );
    expect(replay).toEqual(journal);
  });

  it("surfaces configured recovery as a separate authoritative action after uncompensated failure", async () => {
    const catalog = fixtureCatalog();
    const plan = prepareActionInvocation({
      catalog,
      selector: "requires-recovery",
      invocationId: "invocation-recovery",
      actor: "compiler",
      context: { checkout: "main" },
    });
    const journal = await executeActionPlan(
      plan,
      host(async () => {
        throw new Error("effect failed");
      }),
    );
    expect(journal).toMatchObject({ status: "recovery_required", recoveryActionId: "recover" });
    await expect(
      executeActionPlan(
        plan,
        host(async () => {
          throw new Error("must not replay");
        }),
        { journal },
      ),
    ).resolves.toEqual(journal);
  });

  it("makes primitive replay safe across the effect-before-journal crash gap", async () => {
    const plan = fixturePlan();
    let durable: ActionExecutionJournal | undefined;
    let transitions = 0;
    const effects = new Map<string, ConfigurationValue>();
    let actualEffects = 0;
    const deduplicatingHost = host(async (input) => {
      const existing = effects.get(input.effectKey);
      if (existing !== undefined) return existing;
      actualEffects += 1;
      effects.set(input.effectKey, { ok: true });
      return { ok: true };
    });
    await expect(
      executeActionPlan(plan, deduplicatingHost, {
        persist: async (journal) => {
          transitions += 1;
          if (transitions === 2)
            throw new Error("crash before completed step journal became durable");
          durable = journal;
        },
      }),
    ).rejects.toThrow("crash before");
    expect(durable?.status).toBe("running");
    const resumed = await executeActionPlan(plan, deduplicatingHost, { journal: durable! });
    expect(resumed.status).toBe("completed");
    expect(actualEffects).toBe(plan.recipe.length);
  });

  it("fails closed for malformed, foreign, duplicated, reordered and impossible journals", async () => {
    const plan = fixturePlan();
    const terminal = await executeActionPlan(
      plan,
      host(async () => null),
    );
    const adversaries: ActionExecutionJournal[] = [
      rehash({ ...terminal, invocationId: "foreign" }),
      rehash({ ...terminal, steps: [terminal.steps[1]!, terminal.steps[0]!] }),
      rehash({ ...terminal, steps: [terminal.steps[0]!, terminal.steps[0]!, terminal.steps[1]!] }),
      rehash({
        ...terminal,
        steps: [{ ...terminal.steps[0]!, stepId: "unknown" }, terminal.steps[1]!],
      }),
      rehash({ ...terminal, status: "compensated" }),
    ];
    for (const candidate of adversaries) {
      expect(() => validateActionExecutionJournal(plan, candidate)).toThrow(ActionRecipeError);
    }
    expect(() =>
      validateActionExecutionJournal(plan, { ...terminal, sha256: `sha256:${"0".repeat(64)}` }),
    ).toThrowError(expect.objectContaining({ code: "journal_hash" }));
  });

  it("makes compensation failure terminal and rejects noncanonical primitive output", async () => {
    const plan = fixturePlan();
    const failed = await executeActionPlan(
      plan,
      host(async (input) => {
        if (input.phase === "recipe" && input.step.primitive === "event.append")
          throw new Error("recipe");
        if (input.phase === "compensation") throw new Error("compensation");
        return null;
      }),
    );
    expect(failed.status).toBe("recovery_required");
    expect(failed.steps.at(-1)).toMatchObject({ phase: "compensation", status: "failed" });

    const noncanonical = await executeActionPlan(
      fixturePlan("noncanonical"),
      host(async (input) =>
        input.phase === "recipe" ? (undefined as unknown as ConfigurationValue) : null,
      ),
    );
    expect(noncanonical.status).toBe("compensated");
    expect(noncanonical.steps.some((step) => step.error?.includes("noncanonical"))).toBe(true);
  });
});

function fixtureCatalog() {
  const result = compileActionCatalog([
    source("recover", { id: "recover", recipe: [{ primitive: "project.validate" }] }),
    source("perform-work", {
      id: "perform-work",
      aliases: ["perform"],
      params: { message: { type: "string", required: true } },
      requires_main_checkout: true,
      recipe: [
        { primitive: "project.validate" },
        {
          primitive: "event.append",
          type: "work.recorded",
          data: { message: "${params.message}" },
        },
      ],
      compensation: [{ primitive: "recovery.dispatch", mode: "remove_uncommitted_output" }],
      recovery: "recover",
    }),
    source("requires-recovery", {
      id: "requires-recovery",
      requires_main_checkout: true,
      recipe: [{ primitive: "event.append", type: "will.fail" }],
      recovery: "recover",
    }),
  ]);
  if (!result.ok)
    throw new Error(result.diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n"));
  return result.value;
}

function fixturePlan(suffix = "default") {
  return prepareActionInvocation({
    catalog: fixtureCatalog(),
    selector: "perform",
    invocationId: `invocation-${suffix}`,
    actor: "compiler",
    parameters: { message: "hello" },
    context: { checkout: "main" },
  });
}

function source(id: string, document: Record<string, unknown>) {
  return { id, path: `/actions/${id}`, document: document as ConfigurationObject };
}

function host(execute: ActionPrimitiveHost["execute"]): ActionPrimitiveHost {
  return { execute };
}

function withoutJournalSha(
  journal: ActionExecutionJournal,
): Omit<ActionExecutionJournal, "sha256"> {
  const { sha256: _sha256, ...material } = journal;
  return material;
}

function rehash(
  journal: Omit<ActionExecutionJournal, "sha256"> | ActionExecutionJournal,
): ActionExecutionJournal {
  const material = "sha256" in journal ? withoutJournalSha(journal) : journal;
  return { ...material, sha256: canonicalHash(material) };
}
