import type { Sha256Digest } from "../shared/canonical.js";
import type { CompilerDiagnostic } from "../shared/diagnostics.js";

export const COMPILER_SNAPSHOT_PROTOCOL = "koni.compiler-snapshot.v1" as const;
export const COMPILER_MUTATION_PLAN_PROTOCOL = "koni.compiler-mutation-plan.v1" as const;

export interface CompilerStateExpectation {
  revision: number;
  generation: number;
  stateHash: Sha256Digest;
}

/** Immutable, fully hashed input handed from the authority to the pure compiler. */
export interface CompilerSnapshot {
  protocol: typeof COMPILER_SNAPSHOT_PROTOCOL;
  projectId: string;
  runId: string;
  profileLineage: string;
  profileVersion: string;
  profileBundleHash: Sha256Digest;
  configurationHash: Sha256Digest;
  graphHash: Sha256Digest;
  ticketsHash: Sha256Digest;
  expected: CompilerStateExpectation;
  inputHash: Sha256Digest;
}

export interface PlannedFileWrite {
  path: string;
  contentHash: Sha256Digest;
  sizeBytes: number;
  mode: number;
}

export interface PlannedFileDelete {
  path: string;
  expectedHash: Sha256Digest;
}

export interface PlannedCompilerEvent {
  type: string;
  payloadHash: Sha256Digest;
}

/**
 * The compiler describes effects but never applies them. The authority must
 * revalidate `expected`, journal the plan, and bind actual bytes to every hash.
 */
export interface CompilerMutationPlan {
  protocol: typeof COMPILER_MUTATION_PLAN_PROTOCOL;
  operationId: string;
  idempotencyKey: string;
  expected: CompilerStateExpectation;
  compilerInputHash: Sha256Digest;
  compilerOutputHash: Sha256Digest;
  nextStateHash: Sha256Digest;
  writes: readonly PlannedFileWrite[];
  deletes: readonly PlannedFileDelete[];
  events: readonly PlannedCompilerEvent[];
}

export type CompilerResult =
  | { ok: true; plan: CompilerMutationPlan; diagnostics: readonly CompilerDiagnostic[] }
  | { ok: false; diagnostics: readonly CompilerDiagnostic[] };
