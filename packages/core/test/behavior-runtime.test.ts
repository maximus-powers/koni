import { describe, expect, it } from "vitest";
import {
  BehaviorInputError,
  parseLeadJudgmentOutput,
  planningTokenDisposition,
  shouldIssueLeadJudgment,
} from "../src/compiler/behavior.js";
import { runBehaviorSnapshotFixture } from "./fixtures/compiled-behavior.js";

describe("compiled behavior runtime helpers", () => {
  it("admits each configured Lead judgment trigger exactly once", () => {
    const behavior = runBehaviorSnapshotFixture("medium").runType;
    expect(shouldIssueLeadJudgment(behavior, "orchestration_entry", [])).toBe(true);
    expect(shouldIssueLeadJudgment(behavior, "orchestration_entry", ["orchestration_entry"])).toBe(
      false,
    );
    expect(shouldIssueLeadJudgment(behavior, "compiler_deadlock", ["orchestration_entry"])).toBe(
      true,
    );
    expect(() =>
      shouldIssueLeadJudgment(behavior, "compiler_deadlock", [
        "compiler_deadlock",
        "compiler_deadlock",
      ]),
    ).toThrowError(BehaviorInputError);
  });

  it("treats an explicitly disabled automatic Lead trigger as deterministic compiler work", () => {
    const original = runBehaviorSnapshotFixture("medium").runType;
    const fixture = {
      ...structuredClone(original),
      leadJudgment: { ...structuredClone(original.leadJudgment), triggers: [] },
    };
    expect(shouldIssueLeadJudgment(fixture, "orchestration_entry", [])).toBe(false);
    expect(shouldIssueLeadJudgment(fixture, "compiler_deadlock", [])).toBe(false);
  });

  it("strictly decodes one bounded Lead terminal object", () => {
    expect(
      parseLeadJudgmentOutput({
        protocol: "koni.lead-judgment-output.v1",
        disposition: "proceed",
        summary: "The approved graph is ready for deterministic scheduling.",
      }),
    ).toEqual({
      protocol: "koni.lead-judgment-output.v1",
      disposition: "proceed",
      summary: "The approved graph is ready for deterministic scheduling.",
    });
    for (const value of [
      {
        protocol: "koni.lead-judgment-output.v1",
        disposition: "proceed",
        summary: "ok",
        schedule: ["TK-1"],
      },
      { protocol: "koni.lead-judgment-output.v1", disposition: "retry", summary: "try again" },
      {
        protocol: "koni.lead-judgment-output.v1",
        disposition: "blocked",
        summary: "x".repeat(4_097),
      },
    ]) {
      expect(() => parseLeadJudgmentOutput(value)).toThrowError(BehaviorInputError);
    }
  });

  it("projects the planning synthesis boundary independently of the terminal limit", () => {
    const behavior = runBehaviorSnapshotFixture("medium").runType;
    expect(planningTokenDisposition(behavior, 79_999)).toBe("continue");
    expect(planningTokenDisposition(behavior, 80_000)).toBe("force_synthesis");
    expect(planningTokenDisposition(behavior, 100_000)).toBe("exhausted");
  });
});
