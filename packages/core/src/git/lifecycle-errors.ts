import { GitCommandError } from "./client.js";

export class GitLifecycleError extends Error {
  public constructor(
    public readonly code:
      | "ownership_mismatch"
      | "dirty_checkout"
      | "scope_violation"
      | "ref_moved"
      | "namespace_collision"
      | "invalid_state"
      | "recovery_ambiguous"
      | "target_missing"
      | "base_unresolved",
    message: string,
    public readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "GitLifecycleError";
  }
}

export function invalidState(message: string): GitLifecycleError {
  return new GitLifecycleError("invalid_state", message);
}

export function namespaceCollision(message: string): GitLifecycleError {
  return new GitLifecycleError("namespace_collision", message);
}

export function refMoved(message: string, expected: string, actual: string): GitLifecycleError {
  return new GitLifecycleError("ref_moved", message, { expected, actual });
}

export function dirtyCheckout(label: string, worktree: string): GitLifecycleError {
  return new GitLifecycleError("dirty_checkout", `${label} is dirty: ${worktree}`, { worktree });
}

export function translateCasError(error: unknown, message: string): Error {
  if (error instanceof GitCommandError) {
    return new GitLifecycleError("ref_moved", message, {
      stderr: error.stderr,
      argv: error.argv,
    });
  }
  return error instanceof Error ? error : new Error(String(error));
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
