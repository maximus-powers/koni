import { describe, expect, it } from "vitest";
import {
  createRunTargetDraft,
  cycleRunTarget,
  isCreatingNewTarget,
  NEW_TARGET_LABEL,
  resolveRunTarget,
  runTargetSelectedLabel,
  validateNewBranchName,
  type RunTargetBranch,
} from "../src/control-center/run-target.js";

const branches: readonly RunTargetBranch[] = [
  { label: "development", reference: "refs/heads/development" },
  { label: "main", reference: "refs/heads/main" },
];

describe("shared run-target selection", () => {
  it("defaults to the first existing branch and targets its head", () => {
    const draft = createRunTargetDraft(branches);
    expect(isCreatingNewTarget(draft)).toBe(false);
    expect(runTargetSelectedLabel(draft)).toBe("development");
    expect(resolveRunTarget(draft)).toEqual({ ok: true, targetRef: "refs/heads/development" });
  });

  it("cycles through existing branches then the New branch… entry, and wraps", () => {
    let draft = createRunTargetDraft(branches);
    draft = cycleRunTarget(draft, 1);
    expect(runTargetSelectedLabel(draft)).toBe("main");
    draft = cycleRunTarget(draft, 1);
    expect(runTargetSelectedLabel(draft)).toBe(NEW_TARGET_LABEL);
    expect(isCreatingNewTarget(draft)).toBe(true);
    draft = cycleRunTarget(draft, 1);
    expect(runTargetSelectedLabel(draft)).toBe("development");
    draft = cycleRunTarget(draft, -1);
    expect(runTargetSelectedLabel(draft)).toBe(NEW_TARGET_LABEL);
  });

  it("provisions a new target from a valid name", () => {
    let draft = createRunTargetDraft(branches);
    draft = cycleRunTarget(draft, 2); // to New branch…
    draft = { ...draft, newName: "feat/notes" };
    expect(resolveRunTarget(draft)).toEqual({
      ok: true,
      targetRef: "refs/heads/feat/notes",
      createTarget: true,
    });
  });

  it("rejects empty, reserved, malformed, and duplicate new-branch names", () => {
    const draft = { ...createRunTargetDraft(branches), index: branches.length };
    expect(resolveRunTarget({ ...draft, newName: "" }).ok).toBe(false);
    expect(validateNewBranchName("koni/x", branches)).toMatch(/reserved/);
    expect(validateNewBranchName("bad name!", branches)).toMatch(/letters/);
    expect(validateNewBranchName("a..b", branches)).toMatch(/malformed/);
    expect(validateNewBranchName("main", branches)).toMatch(/already exists/);
    expect(validateNewBranchName("feat/ok-1", branches)).toBeUndefined();
  });
});
