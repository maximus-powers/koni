/**
 * Shared new-run target selection, driven by both the pi `/koni-run` intake
 * (`monitor/run-intake.ts`) and the koni tui new-run modal (`control-center/controller.ts`)
 * so the "use an existing branch's head" vs "branch a new target" choice behaves and reads
 * identically on both surfaces. Resolves to the exact `run.create` target parameters the
 * authority understands: `targetRef`, plus `createTarget`/`baseRef` when provisioning a new
 * branch. See IsolatedGitLifecycle.planRun / TargetProvisioning.
 */

export interface RunTargetBranch {
  label: string;
  reference: string;
}

export interface RunTargetDraft {
  branches: readonly RunTargetBranch[];
  /** 0..branches.length; the trailing index (=== branches.length) selects "New branch…". */
  index: number;
  newName: string;
  /** Code-point cursor into newName, matching the text editors on both surfaces. */
  newNameCursor: number;
}

export const NEW_TARGET_LABEL = "New branch…";

export function createRunTargetDraft(branches: readonly RunTargetBranch[]): RunTargetDraft {
  return { branches, index: 0, newName: "", newNameCursor: 0 };
}

/** Every existing branch plus the trailing "New branch…" entry. */
export function runTargetOptionCount(draft: RunTargetDraft): number {
  return draft.branches.length + 1;
}

export function isCreatingNewTarget(draft: RunTargetDraft): boolean {
  return draft.index >= draft.branches.length;
}

/** The label shown in the target selector for the current choice. */
export function runTargetSelectedLabel(draft: RunTargetDraft): string {
  return isCreatingNewTarget(draft) ? NEW_TARGET_LABEL : draft.branches[draft.index]!.label;
}

/** Cycle the selector across existing branches and the "New branch…" entry. */
export function cycleRunTarget(draft: RunTargetDraft, delta: number): RunTargetDraft {
  const count = runTargetOptionCount(draft);
  const index = (((draft.index + delta) % count) + count) % count;
  return { ...draft, index };
}

export type ResolvedRunTarget =
  | { ok: true; targetRef: string; createTarget?: true; baseRef?: string }
  | { ok: false; error: string };

/**
 * Map the draft to `run.create` target params. An existing selection targets that branch's
 * head; the "New branch…" selection provisions `refs/heads/<name>` from the run checkout's
 * current branch (the authority's default base when `baseRef` is omitted).
 */
export function resolveRunTarget(draft: RunTargetDraft): ResolvedRunTarget {
  if (!isCreatingNewTarget(draft)) {
    const branch = draft.branches[draft.index];
    if (branch === undefined) return { ok: false, error: "Target branch is required." };
    return { ok: true, targetRef: branch.reference };
  }
  const error = validateNewBranchName(draft.newName, draft.branches);
  if (error !== undefined) return { ok: false, error };
  return { ok: true, targetRef: `refs/heads/${draft.newName.trim()}`, createTarget: true };
}

/**
 * Conservative client-side check for immediate feedback. Intentionally an allowlist subset of
 * what the authority's assertUserTargetRef accepts; the authority remains the source of truth
 * and rejects anything unsafe this misses.
 */
export function validateNewBranchName(
  rawName: string,
  branches: readonly RunTargetBranch[],
): string | undefined {
  const name = rawName.trim();
  if (name.length === 0) return "New branch name is required.";
  if (name.length > 200) return "New branch name is too long.";
  if (!/^[A-Za-z0-9._/-]+$/u.test(name)) {
    return "Use letters, digits, and . _ / - only.";
  }
  if (
    name.includes("..") || name.startsWith("/") || name.endsWith("/") || name.endsWith(".") ||
    name.split("/").some((part) => part.length === 0 || part === "." || part.endsWith(".lock"))
  ) return "New branch name is malformed.";
  if (name === "koni" || name.startsWith("koni/")) return "Branch names under koni/ are reserved.";
  const ref = `refs/heads/${name}`;
  if (branches.some((branch) => branch.reference === ref || branch.label === name)) {
    return "A branch with that name already exists — select it above to reuse its head.";
  }
  return undefined;
}
