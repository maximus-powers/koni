import path from "node:path";
import {
  renderRunRef,
  resolveLegacyPolicyWorktreeRoot,
  resolvePolicyWorktreeRoot,
  type GitBehaviorPolicy,
  type GitRunTemplateContext,
} from "./behavior-policy.js";

export function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export interface RunGitNamespace {
  root: string;
  runRef: string;
  planningWorktree: string;
  runWorktree: string;
  ticketRoot: string;
}

export function legacyRunNamespace(commonDirectory: string, runId: string): RunGitNamespace {
  const root = path.join(commonDirectory, "koni", "worktrees", "runs", runId);
  return {
    root,
    runRef: `refs/heads/koni/runs/${runId}`,
    planningWorktree: path.join(root, "planning"),
    runWorktree: path.join(root, "integration"),
    ticketRoot: path.join(root, "tickets"),
  };
}

export function policyRunNamespace(
  commonDirectory: string,
  policy: GitBehaviorPolicy,
  run: GitRunTemplateContext,
): RunGitNamespace {
  const runRef = renderRunRef(policy, run);
  const branch = runRef.slice("refs/heads/".length);
  const root = path.join(
    resolvePolicyWorktreeRoot(commonDirectory, policy),
    "runs",
    ...branch.split("/"),
  );
  return {
    root,
    runRef,
    planningWorktree: path.join(root, "planning"),
    runWorktree: path.join(root, "integration"),
    ticketRoot: path.join(root, "tickets"),
  };
}

/** Exact former layout, used only to authenticate already-issued policy-backed records. */
export function legacyPolicyRunNamespace(
  commonDirectory: string,
  policy: GitBehaviorPolicy,
  run: GitRunTemplateContext,
): RunGitNamespace {
  const runRef = renderRunRef(policy, run);
  const branch = runRef.slice("refs/heads/".length);
  const root = path.join(
    resolveLegacyPolicyWorktreeRoot(commonDirectory, policy),
    "runs",
    ...branch.split("/"),
  );
  return {
    root,
    runRef,
    planningWorktree: path.join(root, "planning"),
    runWorktree: path.join(root, "integration"),
    ticketRoot: path.join(root, "tickets"),
  };
}

export function persistedPolicyRunNamespace(
  commonDirectory: string,
  policy: GitBehaviorPolicy,
  run: GitRunTemplateContext,
  persisted: RunGitNamespace,
): RunGitNamespace {
  const current = policyRunNamespace(commonDirectory, policy, run);
  if (sameRunNamespace(persisted, current)) return current;
  const legacy = legacyPolicyRunNamespace(commonDirectory, policy, run);
  if (sameRunNamespace(persisted, legacy)) return legacy;
  throw new Error("Git lifecycle run ref is outside its authority namespace");
}

export function sameRunNamespace(left: RunGitNamespace, right: RunGitNamespace): boolean {
  return (
    left.root === right.root &&
    left.runRef === right.runRef &&
    left.planningWorktree === right.planningWorktree &&
    left.runWorktree === right.runWorktree &&
    left.ticketRoot === right.ticketRoot
  );
}

export function policyTicketWorktree(ticketRoot: string, ticketRef: string): string {
  if (!ticketRef.startsWith("refs/heads/")) throw new Error("ticket ref is not a local branch");
  return path.join(ticketRoot, ...ticketRef.slice("refs/heads/".length).split("/"));
}
