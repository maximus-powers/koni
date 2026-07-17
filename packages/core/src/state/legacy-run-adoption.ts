import { isSha256Digest, type Sha256Digest } from "../shared/canonical.js";
import path from "node:path";
import type { LegacyRunStatus } from "../profile/migration.js";

export const LEGACY_RUN_ADOPTION_PROTOCOL = "koni.legacy-run-adoption.v1" as const;

/**
 * Immutable source binding plus the one mutable resume-proof boundary for a Rust-era run.
 * The source tree remains outside current authority state and is never rewritten in place.
 */
export interface LegacyRunAdoptionRecord {
  protocol: typeof LEGACY_RUN_ADOPTION_PROTOCOL;
  migrationId: string;
  sourceRunId: string;
  sourceStatus: Extract<LegacyRunStatus, "planning" | "approved" | "active" | "paused">;
  sourceTreeSha256: Sha256Digest;
  sourceRegistrySha256: Sha256Digest;
  /** Exact archived plan.json bytes, including non-semantic audit metadata. */
  migrationPlanBytesSha256: Sha256Digest;
  migrationPlanSha256: Sha256Digest;
  compatibilityIndexSha256: Sha256Digest;
  /** Exact archived receipt.json bytes, including its applied-at audit boundary. */
  migrationReceiptSha256: Sha256Digest;
  barrierEvidenceSha256: Sha256Digest;
  targetRef: string;
  targetSelectedOid: string;
  planningBaseOid: string;
  sourceGit:
    | { kind: "legacy_base"; headOid: string }
    | {
        kind: "legacy_integration";
        branchRef: string;
        worktree: string;
        headOid: string;
      };
  sessionLineage: {
    kind: "fresh_successor";
    reason: string;
  };
  adoptedAt: string;
  sourceRetained: true;
  resumeVerifiedAt?: string;
  resumeVerificationSha256?: Sha256Digest;
}

export function assertLegacyRunAdoptionRecord(
  value: unknown,
): asserts value is LegacyRunAdoptionRecord {
  if (
    !isRecord(value) ||
    value.protocol !== LEGACY_RUN_ADOPTION_PROTOCOL ||
    !isId(value.migrationId) ||
    !isId(value.sourceRunId) ||
    !new Set(["planning", "approved", "active", "paused"])
      .has(String(value.sourceStatus)) ||
    !isSha256Digest(value.sourceTreeSha256) ||
    !isSha256Digest(value.sourceRegistrySha256) ||
    !isSha256Digest(value.migrationPlanBytesSha256) ||
    !isSha256Digest(value.migrationPlanSha256) ||
    !isSha256Digest(value.compatibilityIndexSha256) ||
    !isSha256Digest(value.migrationReceiptSha256) ||
    !isSha256Digest(value.barrierEvidenceSha256) ||
    !isUserTargetRef(value.targetRef) ||
    !isOid(value.targetSelectedOid) ||
    !isOid(value.planningBaseOid) ||
    !isRecord(value.sourceGit) ||
    !isRecord(value.sessionLineage) ||
    value.sessionLineage.kind !== "fresh_successor" ||
    typeof value.sessionLineage.reason !== "string" ||
    value.sessionLineage.reason.length === 0 ||
    typeof value.adoptedAt !== "string" ||
    value.adoptedAt.length === 0 ||
    value.sourceRetained !== true
  ) {
    throw new Error("legacy run adoption record is invalid");
  }
  if (value.sourceGit.kind === "legacy_base") {
    if (!isOid(value.sourceGit.headOid) || value.sourceGit.headOid !== value.planningBaseOid) {
      throw new Error("legacy base adoption does not bind its planning commit");
    }
  } else if (value.sourceGit.kind === "legacy_integration") {
    if (
      !isKoniRunRef(value.sourceGit.branchRef) ||
      typeof value.sourceGit.worktree !== "string" ||
      !path.isAbsolute(value.sourceGit.worktree) ||
      !isOid(value.sourceGit.headOid) ||
      value.sourceGit.headOid !== value.planningBaseOid
    ) {
      throw new Error("legacy integration adoption source is invalid");
    }
  } else {
    throw new Error("legacy run adoption source kind is invalid");
  }
  const hasResumeTime = value.resumeVerifiedAt !== undefined;
  const hasResumeDigest = value.resumeVerificationSha256 !== undefined;
  if (
    hasResumeTime !== hasResumeDigest ||
    (hasResumeTime && (
      typeof value.resumeVerifiedAt !== "string" ||
      value.resumeVerifiedAt.length === 0 ||
      !isSha256Digest(value.resumeVerificationSha256)
    ))
  ) {
    throw new Error("legacy run adoption resume proof is incomplete");
  }
}

function isId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
}

function isOid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40,64}$/u.test(value);
}

function isUserTargetRef(value: unknown): value is string {
  return typeof value === "string" &&
    value.startsWith("refs/heads/") &&
    !value.startsWith("refs/heads/koni/") &&
    value.length <= 1_024 &&
    !/[\u0000-\u0020~^:?*\\[\]]/u.test(value);
}

function isKoniRunRef(value: unknown): value is string {
  return typeof value === "string" &&
    value.startsWith("refs/heads/koni/runs/") &&
    value.length <= 1_024 &&
    !/[\u0000-\u0020~^:?*\\[\]]/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
