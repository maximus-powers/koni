import { describe, expect, it } from "vitest";
import {
  assertRunActionCurrent,
  createRunActionEffectReceipt,
  prepareRunActionExecution,
  replayRunActionEffect,
  RunActionAuthorityError,
} from "../src/authority/action-execution.js";
import type { RunRecord } from "../src/state/run-record.js";
import { runBehaviorSnapshotFixture } from "./fixtures/compiled-behavior.js";

describe("configured action authority", () => {
  it("admits only the exact compiler-selected action and protects its authority context", () => {
    const run = fixtureRun();
    const accepted = prepareRunActionExecution(run, {
      kind: "approved_plan_compile",
      stageId: "approval",
      selector: "compile",
      checkout: "none",
      at: "2026-07-18T00:00:00.000Z",
    });
    expect(accepted.plan.actionId).toBe("compile");
    expect(accepted.invocationId).toMatch(/^action-[0-9a-f]{64}$/u);

    expect(() =>
      prepareRunActionExecution(run, {
        kind: "approved_plan_compile",
        stageId: "approval",
        selector: "report",
        checkout: "main",
        at: "2026-07-18T00:00:00.000Z",
      }),
    ).toThrowError(expect.objectContaining({ code: "selector_authority" }));

    expect(() =>
      prepareRunActionExecution(run, {
        kind: "approved_plan_compile",
        stageId: "approval",
        selector: "compile",
        checkout: "none",
        values: { authority: { forged: true } },
        at: "2026-07-18T00:00:00.000Z",
      }),
    ).toThrowError(expect.objectContaining({ code: "authority_context_override" }));
  });

  it("replays one exact effect receipt and rejects effect-key substitution", () => {
    const execution = prepareRunActionExecution(fixtureRun(), {
      kind: "approved_plan_compile",
      stageId: "approval",
      selector: "compile",
      checkout: "none",
      at: "2026-07-18T00:00:00.000Z",
    });
    const step = execution.plan.recipe[0]!;
    const input = {
      invocationId: execution.invocationId,
      planSha256: execution.plan.sha256,
      effectKey: `${execution.invocationId}:recipe:${step.id}:${execution.plan.sha256}`,
      actionId: execution.plan.actionId,
      actor: execution.plan.actor,
      phase: "recipe" as const,
      step,
      context: execution.plan.context,
    };
    const receipt = createRunActionEffectReceipt(
      input,
      { valid: true },
      "2026-07-18T00:00:01.000Z",
    );
    expect(replayRunActionEffect(receipt, input)).toEqual({ valid: true });
    expect(() =>
      replayRunActionEffect(receipt, {
        ...input,
        step: { ...step, arguments: { forged: true } },
      }),
    ).toThrowError(expect.objectContaining({ code: "effect_replay_mismatch" }));
  });

  it("fails closed after revision, generation, pause, or deletion drift", () => {
    const source = fixtureRun();
    const execution = prepareRunActionExecution(source, {
      kind: "approved_plan_compile",
      stageId: "approval",
      selector: "compile",
      checkout: "none",
      at: "2026-07-18T00:00:00.000Z",
    });
    const admitted = { ...source, revision: execution.expectedRunRevision } as RunRecord;
    expect(() => assertRunActionCurrent(admitted, execution)).not.toThrow();

    expectAuthorityCode(
      { ...admitted, revision: admitted.revision + 1 },
      execution,
      "stale_revision",
    );
    expectAuthorityCode({ ...admitted, generation: 1 }, execution, "stale_generation");
    expectAuthorityCode(
      {
        ...admitted,
        lifecycle: { ...admitted.lifecycle, phase: "paused" },
      },
      execution,
      "run_paused",
    );
    expectAuthorityCode(
      {
        ...admitted,
        lifecycle: { ...admitted.lifecycle, phase: "deleted" },
      },
      execution,
      "run_deleted",
    );
  });

  it("revalidates action ticket state through the pinned lifecycle projection", () => {
    const source = fixtureRun();
    source.tickets["ticket-one"] = {
      id: "ticket-one",
      status: "running",
      steps: [],
    } as unknown as RunRecord["tickets"][string];
    source.lifecycleCatalog = {
      machines: {
        ticket: {
          id: "ticket",
          states: ["todo", "in_progress", "integrating", "blocked", "closed"],
        },
      },
    } as unknown as NonNullable<RunRecord["lifecycleCatalog"]>;
    const execution = prepareRunActionExecution(source, {
      kind: "approved_plan_compile",
      stageId: "approval",
      selector: "compile",
      checkout: "none",
      ticketId: "ticket-one",
      ticketState: "in_progress",
      at: "2026-07-18T00:00:00.000Z",
    });
    const admitted = { ...source, revision: execution.expectedRunRevision } as RunRecord;
    expect(() => assertRunActionCurrent(admitted, execution)).not.toThrow();
    expectAuthorityCode(
      {
        ...admitted,
        tickets: {
          ...admitted.tickets,
          "ticket-one": { ...admitted.tickets["ticket-one"]!, status: "review" },
        },
      },
      execution,
      "ticket_state",
    );
  });
});

function expectAuthorityCode(
  run: RunRecord,
  execution: ReturnType<typeof prepareRunActionExecution>,
  code: string,
): void {
  try {
    assertRunActionCurrent(run, execution);
    throw new Error("expected authority rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(RunActionAuthorityError);
    expect((error as RunActionAuthorityError).code).toBe(code);
  }
}

function fixtureRun(): RunRecord {
  const behavior = runBehaviorSnapshotFixture("small", "software");
  return {
    id: "run-action-fixture",
    revision: 7,
    generation: 0,
    compiledConfigHash: `sha256:${"b".repeat(64)}`,
    behavior,
    currentPipelineStageId: "approval",
    tickets: {},
    lifecycle: { phase: "approving", generation: 0 },
  } as RunRecord;
}
