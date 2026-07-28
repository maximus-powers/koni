import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import {
  GitClient,
  GitCommandError,
  type GitCommitIdentity,
  type GitTreeMergeResult,
} from "./client.js";
import {
  inspectGitPathScope,
  type GitPathScope,
  type GitPathScopeInspection,
} from "./path-scope.js";
import {
  assertGitBehaviorPolicy,
  assertGitRunTemplateContext,
  assertGitTicketTemplateContext,
  renderConfiguredCommitTrailers,
  renderRunRef,
  renderTicketCommitSubject,
  renderTicketRef,
  resolveLegacyPolicyWorktreeRoot,
  resolvePolicyWorktreeRoot,
  resolveRepositoryWorktreeNamespaceRoot,
  type GitBehaviorPolicy,
  type GitRunAdmission,
  type GitRunTemplateContext,
  type GitTicketTemplateContext,
} from "./behavior-policy.js";

export const GIT_LIFECYCLE_PROTOCOL = "koni.git-lifecycle.v1" as const;
export const GIT_INTENT_PROTOCOL = "koni.git-intent.v1" as const;

export interface RunGitLifecycleRecord {
  protocol: typeof GIT_LIFECYCLE_PROTOCOL;
  runId: string;
  projectRoot: string;
  commonDirectory: string;
  target: {
    ref: string;
    selectedOid: string;
  };
  /** Absent only on pre-policy lifecycle records, which retain the exact historical namespace. */
  policy?: GitBehaviorPolicy;
  /** Immutable values used to resolve this run's policy templates. */
  runTemplate?: GitRunTemplateContext;
  namespace: {
    root: string;
    runRef: string;
    planningWorktree: string;
    runWorktree: string;
    ticketRoot: string;
  };
  planning: {
    status: "planned" | "ready" | "retired" | "preserved";
    baseOid: string;
    worktree: string;
    createdAt: string | undefined;
    retiredAt: string | undefined;
    blocker: string | undefined;
  };
  run: {
    status: "unmaterialized" | "ready" | "retired" | "preserved";
    branchRef: string;
    worktree: string;
    headOid: string | undefined;
    materializedAt: string | undefined;
    retiredAt: string | undefined;
    blocker: string | undefined;
  };
  ticketCycles: Record<string, TicketGitCycleRecord>;
  ticketCycleOrder: string[];
  targetSynchronization?: TargetSynchronizationRecord | undefined;
  promotion: TargetPromotionRecord | undefined;
}

export interface TicketGitCycleRecord {
  cycleId: string;
  ticketId: string;
  ordinal: number;
  status:
    "materializing" | "active" | "candidate" | "integrated" | "conflict" | "preserved" | "retired";
  baseRunOid: string;
  branchRef: string;
  worktree: string;
  ticketHeadOid: string;
  integratedRunOid: string | undefined;
  squashCommitOid: string | undefined;
  createdAt: string;
  integratedAt: string | undefined;
  retiredAt: string | undefined;
  blocker: string | undefined;
  /** Exact immutable archive retained when change control supersedes this unintegrated cycle. */
  archiveRef?: string;
  supersessionSha256?: string;
  supersededAt?: string;
  /** Required on policy-backed records; absent on legacy cycles. */
  templateContext?: GitTicketTemplateContext;
}

export interface TargetSynchronizationRecord {
  status: "synchronized" | "integration_required" | "preserved";
  priorRunOid: string;
  targetOid: string;
  runOid: string | undefined;
  synchronizedAt: string;
  blocker: string | undefined;
}

export interface GitConflictReport {
  baseOid: string;
  runOid: string;
  candidateOid: string;
  paths: string[];
  message: string;
}

export type TicketPublicationResult =
  | { status: "integrated"; lifecycle: RunGitLifecycleRecord; cycle: TicketGitCycleRecord }
  | { status: "conflict"; lifecycle: RunGitLifecycleRecord; conflict: GitConflictReport };

export type TargetSynchronizationResult =
  | {
      status: "synchronized";
      lifecycle: RunGitLifecycleRecord;
      synchronization: TargetSynchronizationRecord;
    }
  | {
      status: "integration_required";
      lifecycle: RunGitLifecycleRecord;
      conflict: GitConflictReport;
    };

export type TargetPromotionPreparation =
  | {
      status: "ready";
      expectedTargetOid: string;
      runOid: string;
      candidateOid: string;
      targetCheckout: string | undefined;
      replayed: boolean;
    }
  | {
      status: "integration_required";
      expectedTargetOid: string;
      runOid: string;
      conflict: GitConflictReport;
    };

export interface TargetPromotionRecord {
  status: "ready" | "publishing" | "published" | "integration_required" | "preserved";
  expectedTargetOid: string;
  runOid: string;
  candidateOid: string | undefined;
  targetCheckout: string | undefined;
  preparedAt: string;
  publishedAt: string | undefined;
  blocker: string | undefined;
}

export interface GitIntentSettlement {
  status: "completed" | "blocked";
  settledAt: string;
  lifecycle: RunGitLifecycleRecord;
  reason?: string;
  compensation?: GitCompensationEvidence;
}

/** Causal evidence retained by both the failed publication and its compensation receipt. */
export interface GitCompensationEvidence {
  originalIntentId: string;
  priorOid: string;
  candidateOid: string;
  compensationOid?: string;
}

/**
 * The authority adapter must persist `prepare` before returning, and must
 * atomically remove the intent while storing the supplied lifecycle on
 * `settle`. That makes Git's unavoidable ref/checkout gap crash-forward.
 */
export interface GitIntentJournal {
  prepare(intent: GitLifecycleIntent): Promise<void>;
  settle(intentId: string, settlement: GitIntentSettlement): Promise<void>;
  /** Atomically retain the failed receipt and replace it with its forward compensation intent. */
  supersedeWithCompensation(
    failedIntentId: string,
    failedSettlement: GitIntentSettlement,
    compensation: Extract<GitLifecycleIntent, { kind: "forward_compensation" }>,
  ): Promise<void>;
}

interface GitIntentBase {
  protocol: typeof GIT_INTENT_PROTOCOL;
  id: string;
  runId: string;
  projectRoot: string;
  commonDirectory: string;
  preparedAt: string;
}

export type GitLifecycleIntent =
  | (GitIntentBase & {
      kind: "planning_create";
      baseOid: string;
      worktree: string;
    })
  | (GitIntentBase & {
      kind: "run_materialize";
      baseOid: string;
      runRef: string;
      runWorktree: string;
      planningWorktree: string;
    })
  | (GitIntentBase & {
      kind: "ticket_materialize";
      cycleId: string;
      ticketId: string;
      baseRunOid: string;
      ticketRef: string;
      ticketWorktree: string;
      templateContext?: GitTicketTemplateContext;
    })
  | (GitIntentBase & {
      kind: "ticket_checkpoint";
      cycleId: string;
      expectedTicketOid: string;
      candidateOid: string;
      ticketRef: string;
      ticketWorktree: string;
    })
  | (GitIntentBase & {
      kind: "ticket_publish";
      cycleId: string;
      expectedRunOid: string;
      ticketOid: string;
      squashCommitOid: string;
      runRef: string;
      runWorktree: string;
    })
  | (GitIntentBase & {
      kind: "target_sync";
      expectedRunOid: string;
      observedTargetOid: string;
      synchronizedRunOid: string;
      runRef: string;
      runWorktree: string;
    })
  | (GitIntentBase & {
      kind: "target_publish";
      expectedTargetOid: string;
      runOid: string;
      candidateOid: string;
      targetRef: string;
      targetCheckout: string | undefined;
    })
  | (GitIntentBase & {
      kind: "forward_compensation";
      originalIntentId: string;
      originalKind: "ticket_publish" | "target_sync" | "target_publish";
      priorOid: string;
      candidateOid: string;
      reference: string;
      checkout: string | undefined;
      cycleId: string | undefined;
      observedTargetOid?: string;
      repairError: string;
      identity: { name: string; email: string };
    })
  | (GitIntentBase & {
      kind: "ticket_retire";
      cycleId: string;
      expectedTicketOid: string;
      ticketRef: string;
      ticketWorktree: string;
    })
  | (GitIntentBase & {
      kind: "ticket_supersede";
      cycleId: string;
      ticketId: string;
      expectedTicketOid: string;
      ticketRef: string;
      ticketWorktree: string;
      archiveRef: string;
      supersessionSha256: string;
    })
  | (GitIntentBase & {
      kind: "run_retire";
      expectedRunOid: string;
      runRef: string;
      runWorktree: string;
    })
  | (GitIntentBase & {
      kind: "abandoned_run_retire";
      planning: { baseOid: string; worktree: string } | undefined;
      run: { expectedOid: string; ref: string; worktree: string } | undefined;
      tickets: Array<{
        cycleId: string;
        expectedOid: string;
        ref: string;
        worktree: string;
      }>;
    })
  | (GitIntentBase & {
      kind: "legacy_run_relocate";
      sourceGitSha256: string;
      relocationPlanSha256: string;
      targetRef: string;
      selectedTargetOid: string;
      observedTargetOid: string;
      expectedRunOid: string;
      runRef: string;
      sourceWorktree: string;
      stagingWorktree: string;
      destinationWorktree: string;
      namespaceRoot: string;
      planningWorktree: string;
      ticketRoot: string;
      ticketProjectionIds: string[];
    })
  | (GitIntentBase & {
      kind: "legacy_run_retire";
      sourceGitSha256: string;
      expectedRunOid: string;
      runRef: string;
      sourceWorktree: string;
      namespaceRoot: string;
    });

export interface GitRecoveryResult {
  status: "completed" | "preserved";
  lifecycle: RunGitLifecycleRecord;
  reason?: string;
}

export type AbandonedRunRetirementResult =
  | { status: "retired"; lifecycle: RunGitLifecycleRecord }
  | { status: "preserved"; lifecycle: RunGitLifecycleRecord; reason: string };

export const GIT_ABANDONED_RUN_INSPECTION_PROTOCOL =
  "koni.git-abandoned-run-inspection.v1" as const;
export const GIT_TARGET_REF_OBSERVATION_PROTOCOL = "koni.git-target-ref-observation.v1" as const;

export type AbandonedRunResourceKind = "planning" | "run" | "ticket";
export type AbandonedRunRefState = "not_applicable" | "absent" | "matches" | "moved" | "unreadable";
export type AbandonedRunWorktreeState =
  | "absent"
  | "owned_clean"
  | "owned_dirty"
  | "unregistered_present"
  | "ownership_mismatch"
  | "unreadable";

/**
 * One read-only retirement candidate. Paths are returned to the calling authority for operator
 * review; they are never persisted as a new source of ownership authority.
 */
export interface AbandonedRunResourceInspection {
  kind: AbandonedRunResourceKind;
  id: string;
  expectedOid: string;
  ref: string | undefined;
  worktree: string;
  refState: AbandonedRunRefState;
  observedRefOid: string | undefined;
  worktreeState: AbandonedRunWorktreeState;
  registered: boolean;
  dirtyPaths: string[];
  safeToDelete: boolean;
  warnings: string[];
}

/** A deterministic, non-mutating preview of exactly what delete-owned would attempt to retire. */
export interface AbandonedRunInspection {
  protocol: typeof GIT_ABANDONED_RUN_INSPECTION_PROTOCOL;
  runId: string;
  target: {
    ref: string;
    selectedOid: string;
  };
  resources: AbandonedRunResourceInspection[];
  deleteOwnedSafe: boolean;
  warnings: string[];
}

/** Exact read-only target-ref evidence suitable for binding a guarded merge preview. */
export interface TargetRefObservation {
  protocol: typeof GIT_TARGET_REF_OBSERVATION_PROTOCOL;
  runId: string;
  ref: string;
  selectedOid: string;
  observedOid: string;
  changedSinceSelection: boolean;
}

export function assertRunGitLifecycleRecord(
  value: unknown,
): asserts value is RunGitLifecycleRecord {
  if (!isObject(value) || value.protocol !== GIT_LIFECYCLE_PROTOCOL) {
    throw new Error("Git lifecycle protocol is missing or unsupported");
  }
  if (typeof value.runId !== "string") throw new Error("Git lifecycle run ID is missing");
  assertNamespaceId(value.runId, "run ID");
  for (const field of ["projectRoot", "commonDirectory"] as const) {
    if (typeof value[field] !== "string" || !path.isAbsolute(value[field])) {
      throw new Error(`Git lifecycle ${field} must be an absolute path`);
    }
  }
  if (!isObject(value.target) || typeof value.target.ref !== "string") {
    throw new Error("Git lifecycle target is invalid");
  }
  assertUserTargetRef(value.target.ref);
  assertOidValue(value.target.selectedOid, "selected target OID");
  const policyBacked = value.policy !== undefined || value.runTemplate !== undefined;
  if (policyBacked) {
    if (value.policy === undefined || value.runTemplate === undefined) {
      throw new Error("Git lifecycle policy and run template must be stored together");
    }
    assertGitBehaviorPolicy(value.policy);
    assertGitRunTemplateContext(value.runTemplate);
    if (value.runTemplate.id !== value.runId)
      throw new Error("Git lifecycle run template ID disagrees with the run");
    // Rendering validates every persisted context field as well as the resulting ref.
    renderRunRef(value.policy, value.runTemplate);
  }
  if (!isObject(value.namespace)) throw new Error("Git lifecycle namespace is invalid");
  for (const field of ["root", "planningWorktree", "runWorktree", "ticketRoot"] as const) {
    if (typeof value.namespace[field] !== "string" || !path.isAbsolute(value.namespace[field])) {
      throw new Error(`Git lifecycle namespace ${field} must be absolute`);
    }
  }
  const ticketRoot = value.namespace.ticketRoot as string;
  const expectedNamespace = policyBacked
    ? persistedPolicyRunNamespace(
        value.commonDirectory as string,
        value.policy as GitBehaviorPolicy,
        value.runTemplate as GitRunTemplateContext,
        value.namespace as unknown as RunGitNamespace,
      )
    : legacyRunNamespace(value.commonDirectory as string, value.runId);
  if (
    value.namespace.root !== expectedNamespace.root ||
    value.namespace.runRef !== expectedNamespace.runRef ||
    value.namespace.planningWorktree !== expectedNamespace.planningWorktree ||
    value.namespace.runWorktree !== expectedNamespace.runWorktree ||
    value.namespace.ticketRoot !== expectedNamespace.ticketRoot
  ) {
    throw new Error("Git lifecycle run ref is outside its authority namespace");
  }
  if (!isObject(value.planning) || !isObject(value.run)) {
    throw new Error("Git lifecycle planning/run checkout state is invalid");
  }
  if (!new Set(["planned", "ready", "retired", "preserved"]).has(String(value.planning.status))) {
    throw new Error("Git lifecycle planning status is invalid");
  }
  assertOidValue(value.planning.baseOid, "planning base OID");
  assertOptionalStrings(value.planning, ["createdAt", "retiredAt", "blocker"]);
  if (value.planning.worktree !== value.namespace.planningWorktree) {
    throw new Error("Git lifecycle planning path disagrees with its namespace");
  }
  if (!new Set(["unmaterialized", "ready", "retired", "preserved"]).has(String(value.run.status))) {
    throw new Error("Git lifecycle run status is invalid");
  }
  if (
    value.run.branchRef !== value.namespace.runRef ||
    value.run.worktree !== value.namespace.runWorktree
  ) {
    throw new Error("Git lifecycle run checkout disagrees with its namespace");
  }
  if (value.run.headOid !== undefined) assertOidValue(value.run.headOid, "run head OID");
  assertOptionalStrings(value.run, ["materializedAt", "retiredAt", "blocker"]);
  if (!isObject(value.ticketCycles) || !Array.isArray(value.ticketCycleOrder)) {
    throw new Error("Git lifecycle ticket cycles are invalid");
  }
  const cycleIds = Object.keys(value.ticketCycles);
  if (cycleIds.length > 100_000 || value.ticketCycleOrder.length !== cycleIds.length) {
    throw new Error("Git lifecycle ticket cycle cardinality is invalid");
  }
  const ordered = new Set<string>();
  for (const id of value.ticketCycleOrder) {
    if (typeof id !== "string" || ordered.has(id) || !(id in value.ticketCycles)) {
      throw new Error("Git lifecycle ticket cycle order is invalid");
    }
    ordered.add(id);
  }
  for (const [id, unknownCycle] of Object.entries(value.ticketCycles)) {
    assertNamespaceId(id, "ticket cycle ID");
    if (
      !isObject(unknownCycle) ||
      unknownCycle.cycleId !== id ||
      typeof unknownCycle.ticketId !== "string"
    ) {
      throw new Error(`Git lifecycle ticket cycle is invalid: ${id}`);
    }
    assertNamespaceId(unknownCycle.ticketId, "ticket ID");
    if (!Number.isSafeInteger(unknownCycle.ordinal) || Number(unknownCycle.ordinal) < 1) {
      throw new Error(`Git lifecycle ticket cycle ordinal is invalid: ${id}`);
    }
    if (
      !new Set([
        "materializing",
        "active",
        "candidate",
        "integrated",
        "conflict",
        "preserved",
        "retired",
      ]).has(String(unknownCycle.status))
    ) {
      throw new Error(`Git lifecycle ticket cycle status is invalid: ${id}`);
    }
    for (const field of ["baseRunOid", "ticketHeadOid"] as const) {
      assertOidValue(unknownCycle[field], `ticket cycle ${field}`);
    }
    if (unknownCycle.integratedRunOid !== undefined) {
      assertOidValue(unknownCycle.integratedRunOid, "integrated run OID");
    }
    if (unknownCycle.squashCommitOid !== undefined) {
      assertOidValue(unknownCycle.squashCommitOid, "squash commit OID");
    }
    let expectedCycleRef: string | undefined;
    let expectedCycleWorktree: string | undefined;
    if (policyBacked) {
      if (!isObject(unknownCycle.templateContext)) {
        throw new Error(`policy-backed Git lifecycle ticket context is missing: ${id}`);
      }
      assertGitTicketTemplateContext(unknownCycle.templateContext);
      const templateContext = unknownCycle.templateContext;
      if (templateContext.id !== unknownCycle.ticketId || templateContext.cycleId !== id) {
        throw new Error(`Git lifecycle ticket context disagrees with its cycle: ${id}`);
      }
      expectedCycleRef = renderTicketRef(
        value.policy as GitBehaviorPolicy,
        value.runTemplate as GitRunTemplateContext,
        templateContext,
      );
      expectedCycleWorktree = policyTicketWorktree(ticketRoot, expectedCycleRef);
    }
    if (
      typeof unknownCycle.branchRef !== "string" ||
      (policyBacked
        ? unknownCycle.branchRef !== expectedCycleRef ||
          unknownCycle.worktree !== expectedCycleWorktree
        : !unknownCycle.branchRef.startsWith(`refs/heads/koni/tickets/${value.runId}/`)) ||
      typeof unknownCycle.worktree !== "string" ||
      !isInside(ticketRoot, unknownCycle.worktree)
    ) {
      throw new Error(`Git lifecycle ticket cycle namespace is invalid: ${id}`);
    }
    if (typeof unknownCycle.createdAt !== "string")
      throw new Error(`ticket cycle creation time is invalid: ${id}`);
    assertOptionalStrings(unknownCycle, [
      "integratedAt",
      "retiredAt",
      "blocker",
      "archiveRef",
      "supersessionSha256",
      "supersededAt",
    ]);
    const hasSupersession =
      unknownCycle.archiveRef !== undefined ||
      unknownCycle.supersessionSha256 !== undefined ||
      unknownCycle.supersededAt !== undefined;
    if (hasSupersession) {
      if (
        unknownCycle.status !== "retired" ||
        typeof unknownCycle.archiveRef !== "string" ||
        typeof unknownCycle.supersessionSha256 !== "string" ||
        !isSha256Value(unknownCycle.supersessionSha256) ||
        typeof unknownCycle.supersededAt !== "string" ||
        unknownCycle.retiredAt !== unknownCycle.supersededAt ||
        unknownCycle.integratedRunOid !== undefined ||
        unknownCycle.archiveRef !==
          supersessionArchiveRef(
            value.runId,
            unknownCycle.ticketId,
            id,
            unknownCycle.supersessionSha256,
          )
      ) {
        throw new Error(`Git lifecycle ticket supersession is invalid: ${id}`);
      }
    }
  }
  if (value.targetSynchronization !== undefined) {
    if (!isObject(value.targetSynchronization))
      throw new Error("target synchronization is invalid");
    if (
      !new Set(["synchronized", "integration_required", "preserved"]).has(
        String(value.targetSynchronization.status),
      )
    ) {
      throw new Error("target synchronization status is invalid");
    }
    assertOidValue(value.targetSynchronization.priorRunOid, "target synchronization prior run OID");
    assertOidValue(value.targetSynchronization.targetOid, "target synchronization target OID");
    if (value.targetSynchronization.runOid !== undefined) {
      assertOidValue(value.targetSynchronization.runOid, "target synchronization run OID");
    }
    if (typeof value.targetSynchronization.synchronizedAt !== "string") {
      throw new Error("target synchronization timestamp is invalid");
    }
    assertOptionalStrings(value.targetSynchronization, ["blocker"]);
    if (
      value.targetSynchronization.status === "synchronized" &&
      value.targetSynchronization.runOid === undefined
    ) {
      throw new Error("successful target synchronization has no run OID");
    }
  }
  if (value.promotion !== undefined) {
    if (!isObject(value.promotion)) throw new Error("Git lifecycle promotion is invalid");
    if (
      !new Set(["ready", "publishing", "published", "integration_required", "preserved"]).has(
        String(value.promotion.status),
      )
    ) {
      throw new Error("Git lifecycle promotion status is invalid");
    }
    assertOidValue(value.promotion.expectedTargetOid, "promotion target OID");
    assertOidValue(value.promotion.runOid, "promotion run OID");
    if (value.promotion.candidateOid !== undefined) {
      assertOidValue(value.promotion.candidateOid, "promotion candidate OID");
    }
    if (
      value.promotion.targetCheckout !== undefined &&
      (typeof value.promotion.targetCheckout !== "string" ||
        !path.isAbsolute(value.promotion.targetCheckout))
    ) {
      throw new Error("Git lifecycle target checkout is invalid");
    }
    if (typeof value.promotion.preparedAt !== "string")
      throw new Error("promotion preparation time is invalid");
    assertOptionalStrings(value.promotion, ["publishedAt", "blocker"]);
  }
}

export function assertGitLifecycleIntent(value: unknown): asserts value is GitLifecycleIntent {
  if (
    !isObject(value) ||
    value.protocol !== GIT_INTENT_PROTOCOL ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.runId !== "string" ||
    typeof value.projectRoot !== "string" ||
    typeof value.commonDirectory !== "string" ||
    typeof value.preparedAt !== "string"
  ) {
    throw new Error("Git lifecycle intent envelope is invalid");
  }
  assertNamespaceId(value.runId, "run ID");
  if (!path.isAbsolute(value.projectRoot) || !path.isAbsolute(value.commonDirectory)) {
    throw new Error("Git lifecycle intent repository paths must be absolute");
  }
  const kind = String(value.kind);
  const supported = new Set([
    "planning_create",
    "run_materialize",
    "ticket_materialize",
    "ticket_checkpoint",
    "ticket_publish",
    "target_sync",
    "target_publish",
    "forward_compensation",
    "ticket_retire",
    "ticket_supersede",
    "run_retire",
    "abandoned_run_retire",
    "legacy_run_relocate",
    "legacy_run_retire",
  ]);
  if (!supported.has(kind)) throw new Error(`unsupported Git lifecycle intent: ${kind}`);
  const requireString = (field: string) => {
    if (typeof value[field] !== "string" || value[field].length === 0) {
      throw new Error(`Git lifecycle intent ${kind}.${field} is missing`);
    }
  };
  const requiredByKind: Record<string, readonly string[]> = {
    planning_create: ["baseOid", "worktree"],
    run_materialize: ["baseOid", "runRef", "runWorktree", "planningWorktree"],
    ticket_materialize: ["cycleId", "ticketId", "baseRunOid", "ticketRef", "ticketWorktree"],
    ticket_checkpoint: [
      "cycleId",
      "expectedTicketOid",
      "candidateOid",
      "ticketRef",
      "ticketWorktree",
    ],
    ticket_publish: [
      "cycleId",
      "expectedRunOid",
      "ticketOid",
      "squashCommitOid",
      "runRef",
      "runWorktree",
    ],
    target_sync: [
      "expectedRunOid",
      "observedTargetOid",
      "synchronizedRunOid",
      "runRef",
      "runWorktree",
    ],
    target_publish: ["expectedTargetOid", "runOid", "candidateOid", "targetRef"],
    forward_compensation: [
      "originalIntentId",
      "originalKind",
      "priorOid",
      "candidateOid",
      "reference",
      "repairError",
      "identity",
    ],
    ticket_retire: ["cycleId", "expectedTicketOid", "ticketRef", "ticketWorktree"],
    ticket_supersede: [
      "cycleId",
      "ticketId",
      "expectedTicketOid",
      "ticketRef",
      "ticketWorktree",
      "archiveRef",
      "supersessionSha256",
    ],
    run_retire: ["expectedRunOid", "runRef", "runWorktree"],
    abandoned_run_retire: ["tickets"],
    legacy_run_relocate: [
      "sourceGitSha256",
      "relocationPlanSha256",
      "targetRef",
      "selectedTargetOid",
      "observedTargetOid",
      "expectedRunOid",
      "runRef",
      "sourceWorktree",
      "stagingWorktree",
      "destinationWorktree",
      "namespaceRoot",
      "planningWorktree",
      "ticketRoot",
      "ticketProjectionIds",
    ],
    legacy_run_retire: [
      "sourceGitSha256",
      "expectedRunOid",
      "runRef",
      "sourceWorktree",
      "namespaceRoot",
    ],
  };
  for (const field of requiredByKind[kind]!) {
    if (kind === "abandoned_run_retire" && field === "tickets") {
      if (!Array.isArray(value.tickets))
        throw new Error("abandoned-run ticket resources are invalid");
    } else if (kind === "legacy_run_relocate" && field === "ticketProjectionIds") {
      if (!Array.isArray(value.ticketProjectionIds)) {
        throw new Error("legacy relocation ticket projections are invalid");
      }
    } else if (kind === "forward_compensation" && field === "identity") {
      if (!isObject(value.identity)) throw new Error("forward compensation identity is invalid");
    } else {
      requireString(field);
    }
  }
  for (const field of ["cycleId", "ticketId"] as const) {
    if (value[field] !== undefined) assertNamespaceId(String(value[field]), field);
  }
  for (const [key, field] of Object.entries(value)) {
    if (key.endsWith("Oid")) assertOidValue(field, `intent ${key}`);
    if (key.endsWith("Worktree") || key === "worktree" || key === "targetCheckout") {
      if (field !== undefined && (typeof field !== "string" || !path.isAbsolute(field))) {
        throw new Error(`Git lifecycle intent ${key} must be absolute`);
      }
    }
  }
  if (kind === "forward_compensation") {
    if (
      value.originalKind !== "ticket_publish" &&
      value.originalKind !== "target_sync" &&
      value.originalKind !== "target_publish"
    ) {
      throw new Error("forward compensation original kind is invalid");
    }
    if (
      !isObject(value.identity) ||
      typeof value.identity.name !== "string" ||
      typeof value.identity.email !== "string"
    ) {
      throw new Error("forward compensation identity is invalid");
    }
    if (value.originalKind === "target_sync") {
      assertOidValue(value.observedTargetOid, "forward compensation observed target OID");
    }
    if (
      value.checkout !== undefined &&
      (typeof value.checkout !== "string" || !path.isAbsolute(value.checkout))
    ) {
      throw new Error("forward compensation checkout must be absolute");
    }
    if (value.cycleId !== undefined) assertNamespaceId(String(value.cycleId), "ticket cycle ID");
  }
  if (kind === "ticket_supersede") {
    if (!isSha256Value(value.supersessionSha256)) {
      throw new Error("ticket supersession authority hash is invalid");
    }
    if (
      value.archiveRef !==
      supersessionArchiveRef(
        value.runId,
        value.ticketId as string,
        value.cycleId as string,
        value.supersessionSha256,
      )
    ) {
      throw new Error("ticket supersession archive ref is invalid");
    }
    if (
      typeof value.archiveRef !== "string" ||
      !value.archiveRef.startsWith("refs/koni/archive/")
    ) {
      throw new Error("ticket supersession archive ref is outside its authority namespace");
    }
  }
  if (kind === "ticket_materialize" && value.templateContext !== undefined) {
    assertGitTicketTemplateContext(value.templateContext);
    const context = value.templateContext;
    if (context.id !== value.ticketId || context.cycleId !== value.cycleId) {
      throw new Error("ticket materialization context disagrees with its intent");
    }
  }
  if (kind === "abandoned_run_retire") {
    for (const resource of value.tickets as unknown[]) {
      if (!isObject(resource)) throw new Error("abandoned ticket resource is invalid");
      for (const field of ["cycleId", "expectedOid", "ref", "worktree"] as const) {
        if (typeof resource[field] !== "string" || resource[field].length === 0) {
          throw new Error(`abandoned ticket resource ${field} is invalid`);
        }
      }
      assertNamespaceId(resource.cycleId as string, "ticket cycle ID");
      assertOidValue(resource.expectedOid, "abandoned ticket OID");
      if (!path.isAbsolute(resource.worktree as string)) {
        throw new Error("abandoned ticket worktree must be absolute");
      }
    }
    for (const [label, resource] of [
      ["planning", value.planning],
      ["run", value.run],
    ] as const) {
      if (resource !== undefined && !isObject(resource)) {
        throw new Error(`abandoned ${label} resource is invalid`);
      }
    }
    if (isObject(value.planning)) {
      assertOidValue(value.planning.baseOid, "abandoned planning OID");
      if (
        typeof value.planning.worktree !== "string" ||
        !path.isAbsolute(value.planning.worktree)
      ) {
        throw new Error("abandoned planning worktree is invalid");
      }
    }
    if (isObject(value.run)) {
      assertOidValue(value.run.expectedOid, "abandoned run OID");
      if (
        typeof value.run.ref !== "string" ||
        value.run.ref.length === 0 ||
        typeof value.run.worktree !== "string" ||
        !path.isAbsolute(value.run.worktree)
      ) {
        throw new Error("abandoned run resource is invalid");
      }
    }
  }
  if (kind === "legacy_run_relocate" || kind === "legacy_run_retire") {
    if (!/^sha256:[0-9a-f]{64}$/u.test(String(value.sourceGitSha256))) {
      throw new Error("legacy Git source hash is invalid");
    }
    for (const field of ["sourceWorktree", "namespaceRoot"] as const) {
      if (typeof value[field] !== "string" || !path.isAbsolute(value[field])) {
        throw new Error(`legacy Git intent ${field} must be absolute`);
      }
    }
  }
  if (kind === "legacy_run_relocate") {
    if (!/^sha256:[0-9a-f]{64}$/u.test(String(value.relocationPlanSha256))) {
      throw new Error("legacy relocation plan hash is invalid");
    }
    if (!Array.isArray(value.ticketProjectionIds)) {
      throw new Error("legacy relocation ticket projections are invalid");
    }
    for (const id of value.ticketProjectionIds)
      assertNamespaceId(String(id), "ticket projection ID");
    for (const field of [
      "stagingWorktree",
      "destinationWorktree",
      "planningWorktree",
      "ticketRoot",
    ] as const) {
      if (typeof value[field] !== "string" || !path.isAbsolute(value[field])) {
        throw new Error(`legacy relocation ${field} must be absolute`);
      }
    }
  }
}

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

export interface IsolatedGitLifecycleOptions {
  identity?: GitCommitIdentity;
  now?: () => Date;
  createId?: () => string;
  /** Tests may inject a process crash after an external boundary. */
  effectFault?: (point: GitEffectFaultPoint, intent: GitLifecycleIntent) => void;
}

export type GitEffectFaultPoint =
  | "after_planning_checkout"
  | "after_run_ref"
  | "after_run_worktree"
  | "after_planning_retired"
  | "after_ticket_ref"
  | "after_ticket_worktree"
  | "after_ticket_checkpoint_ref"
  | "after_run_publish_ref"
  | "before_run_checkout_repair"
  | "after_run_checkout"
  | "after_target_sync_ref"
  | "before_target_sync_checkout_repair"
  | "after_target_sync_checkout"
  | "after_target_publish_ref"
  | "before_target_checkout_repair"
  | "after_target_checkout"
  | "after_forward_compensation_ref"
  | "after_forward_compensation_checkout"
  | "after_ticket_supersession_archive"
  | "after_ticket_supersession_worktree_retired"
  | "after_ticket_supersession_ref_retired"
  | "after_ticket_worktree_retired"
  | "after_ticket_ref_retired"
  | "after_run_worktree_retired"
  | "after_run_ref_retired"
  | "after_abandoned_worktrees_retired"
  | "after_abandoned_refs_retired"
  | "after_legacy_source_staged"
  | "after_legacy_namespace_prepared"
  | "after_legacy_destination_moved"
  | "after_legacy_destination_locked"
  | "after_legacy_worktree_retired"
  | "after_legacy_ref_retired";

export class IsolatedGitLifecycle {
  readonly #projectRoot: string;
  readonly #identity: GitCommitIdentity;
  readonly #now: () => Date;
  readonly #createId: () => string;
  readonly #effectFault: IsolatedGitLifecycleOptions["effectFault"];

  public constructor(projectRoot: string, options: IsolatedGitLifecycleOptions = {}) {
    this.#projectRoot = path.resolve(projectRoot);
    this.#identity = options.identity ?? {
      name: "Koni Authority",
      email: "koni@example.invalid",
    };
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? randomUUID;
    this.#effectFault = options.effectFault;
  }

  public async recentTargetBranches(
    limit = 20,
  ): Promise<Array<{ ref: string; name: string; oid: string }>> {
    const identity = await GitClient.discover(this.#projectRoot);
    return (await new GitClient(identity.worktreeRoot).recentBranches(limit)).map((branch) => ({
      ref: `refs/heads/${branch.name}`,
      name: branch.name,
      oid: branch.oid,
    }));
  }

  /** Read the exact selected target ref without preparing a merge or writing a Git object. */
  public async observeTargetRef(lifecycle: RunGitLifecycleRecord): Promise<TargetRefObservation> {
    await this.#assertLifecycle(lifecycle);
    const observedOid = await new GitClient(lifecycle.projectRoot).resolveRef(lifecycle.target.ref);
    return {
      protocol: GIT_TARGET_REF_OBSERVATION_PROTOCOL,
      runId: lifecycle.runId,
      ref: lifecycle.target.ref,
      selectedOid: lifecycle.target.selectedOid,
      observedOid,
      changedSinceSelection: observedOid !== lifecycle.target.selectedOid,
    };
  }

  /**
   * Locate uncommitted work in the unique checkout of an operator-selected target ref. This is
   * purely advisory: run creation proceeds regardless, because planning always materializes from
   * the committed tip and promotion re-proves target-checkout cleanliness with full authority
   * before any target mutation. Never throws — advice must not block or fail run admission.
   */
  public async inspectDirtyTargetCheckout(
    targetRef: string,
  ): Promise<{ worktree: string; paths: string[] } | undefined> {
    try {
      const repository = await GitClient.discover(this.#projectRoot);
      const targetCheckout = await uniqueCheckoutForRef(
        new GitClient(repository.worktreeRoot),
        targetRef,
      );
      if (targetCheckout === undefined) return undefined;
      // Koni's own project configuration and install bookkeeping are not operator work product:
      // warning about `.koni/` bytes Koni itself materialized would make every first run in a
      // repository that has not committed the configuration noisy, while promotion never merges
      // those paths. Everything else in the target checkout is the operator's work.
      const dirty = (await new GitClient(targetCheckout).statusEntries()).filter(
        (entry) => entry.path !== ".koni" && !entry.path.startsWith(".koni/"),
      );
      if (dirty.length === 0) return undefined;
      return { worktree: targetCheckout, paths: dirty.slice(0, 32).map((entry) => entry.path) };
    } catch {
      return undefined;
    }
  }

  /**
   * Inspect the exact clean Koni-owned resources that `retireAbandonedRun` would remove. This is a
   * preview only: it creates no intent, changes no ref, unlocks no worktree, and removes no path.
   * Retirement performs the complete ownership/cleanliness proof again immediately before its
   * first effect, so this projection is safe to bind into an operator confirmation token without
   * becoming a time-of-check authorization bypass.
   */
  public async inspectAbandonedRun(
    lifecycle: RunGitLifecycleRecord,
  ): Promise<AbandonedRunInspection> {
    await this.#assertLifecycle(lifecycle);
    const resources = await this.#abandonedResources(lifecycle);
    const inspections: AbandonedRunResourceInspection[] = [];
    if (resources.planning !== undefined) {
      inspections.push(
        await this.#inspectAbandonedResource(lifecycle, {
          kind: "planning",
          id: "planning",
          expectedOid: resources.planning.baseOid,
          ref: undefined,
          worktree: resources.planning.worktree,
        }),
      );
    }
    if (resources.run !== undefined) {
      inspections.push(
        await this.#inspectAbandonedResource(lifecycle, {
          kind: "run",
          id: "run",
          expectedOid: resources.run.expectedOid,
          ref: resources.run.ref,
          worktree: resources.run.worktree,
        }),
      );
    }
    for (const ticket of resources.tickets) {
      inspections.push(
        await this.#inspectAbandonedResource(lifecycle, {
          kind: "ticket",
          id: ticket.cycleId,
          expectedOid: ticket.expectedOid,
          ref: ticket.ref,
          worktree: ticket.worktree,
        }),
      );
    }
    const warnings = inspections.flatMap((resource) =>
      resource.warnings.map((warning) => `${resource.kind}:${resource.id}: ${warning}`),
    );
    return {
      protocol: GIT_ABANDONED_RUN_INSPECTION_PROTOCOL,
      runId: lifecycle.runId,
      target: {
        ref: lifecycle.target.ref,
        selectedOid: lifecycle.target.selectedOid,
      },
      resources: inspections,
      deleteOwnedSafe: inspections.every((resource) => resource.safeToDelete),
      warnings,
    };
  }

  /** Pin the operator-selected user branch without creating any permanent Koni ref. */
  public async planRun(
    runId: string,
    targetRef: string,
    admission?: GitRunAdmission,
    targetProvisioning?: TargetProvisioning,
  ): Promise<RunGitLifecycleRecord> {
    assertNamespaceId(runId, "run ID");
    assertUserTargetRef(targetRef);
    assertNewRunAdmission(admission, runId);
    const repository = await GitClient.discover(this.#projectRoot);
    const client = new GitClient(repository.worktreeRoot);
    const existingOid = await client.tryResolveRef(targetRef);
    if (existingOid === undefined && targetProvisioning?.create !== true) {
      throw new GitLifecycleError(
        "target_missing",
        `target branch ${shortTargetBranch(targetRef)} does not exist; create it first, or start the run with --new-target [--from <ref>] to branch it automatically`,
        { target: targetRef },
      );
    }
    const namespace = policyRunNamespace(
      repository.commonDirectory,
      admission.policy,
      admission.run,
    );
    await assertNewRefNamespace(client, namespace.runRef, targetRef);
    await assertNewWorktreeNamespace(repository, namespace.root);
    // Resolve the base and validate every namespace/collision constraint before creating any ref,
    // so a rejected plan never leaves a half-provisioned target branch behind.
    const baseOid =
      existingOid ?? (await resolveNewTargetBase(client, targetProvisioning?.baseRef));
    if (existingOid === undefined) {
      await client.createRef(targetRef, baseOid);
    }
    const selectedOid = baseOid;
    return {
      protocol: GIT_LIFECYCLE_PROTOCOL,
      runId,
      projectRoot: repository.worktreeRoot,
      commonDirectory: repository.commonDirectory,
      target: { ref: targetRef, selectedOid },
      policy: structuredClone(admission.policy),
      runTemplate: structuredClone(admission.run),
      namespace,
      planning: {
        status: "planned",
        baseOid: selectedOid,
        worktree: namespace.planningWorktree,
        createdAt: undefined,
        retiredAt: undefined,
        blocker: undefined,
      },
      run: {
        status: "unmaterialized",
        branchRef: namespace.runRef,
        worktree: namespace.runWorktree,
        headOid: undefined,
        materializedAt: undefined,
        retiredAt: undefined,
        blocker: undefined,
      },
      ticketCycles: {},
      ticketCycleOrder: [],
      targetSynchronization: undefined,
      promotion: undefined,
    };
  }

  /**
   * Plan a distinct current namespace from an authenticated historical commit. No ref or worktree
   * is created here; the first explicit resume materializes the detached planning checkout through
   * the ordinary journal. The selected target OID remains the Rust run's immutable base while the
   * planning base may include clean, committed legacy implementation work.
   */
  public async planAdoptedRun(
    runId: string,
    input: {
      targetRef: string;
      targetSelectedOid: string;
      planningBaseOid: string;
    },
    admission?: GitRunAdmission,
  ): Promise<RunGitLifecycleRecord> {
    assertNamespaceId(runId, "run ID");
    assertUserTargetRef(input.targetRef);
    assertOidValue(input.targetSelectedOid, "adopted target OID");
    assertOidValue(input.planningBaseOid, "adopted planning OID");
    assertNewRunAdmission(admission, runId);
    const repository = await GitClient.discover(this.#projectRoot);
    const client = new GitClient(repository.worktreeRoot);
    const [currentTarget, selectedObject, planningObject] = await Promise.all([
      client.resolveRef(input.targetRef),
      client.tryResolveRef(input.targetSelectedOid),
      client.tryResolveRef(input.planningBaseOid),
    ]);
    if (selectedObject !== input.targetSelectedOid || planningObject !== input.planningBaseOid) {
      throw invalidState("adopted legacy base commit no longer resolves");
    }
    if (!(await client.isAncestor(input.targetSelectedOid, currentTarget))) {
      throw invalidState("adopted target history no longer contains the legacy base commit");
    }
    if (!(await client.isAncestor(input.targetSelectedOid, input.planningBaseOid))) {
      throw invalidState("adopted planning commit is not descended from the legacy base commit");
    }
    const namespace = policyRunNamespace(
      repository.commonDirectory,
      admission.policy,
      admission.run,
    );
    await assertNewRefNamespace(client, namespace.runRef, input.targetRef);
    await assertNewWorktreeNamespace(repository, namespace.root);
    return {
      protocol: GIT_LIFECYCLE_PROTOCOL,
      runId,
      projectRoot: repository.worktreeRoot,
      commonDirectory: repository.commonDirectory,
      target: { ref: input.targetRef, selectedOid: input.targetSelectedOid },
      policy: structuredClone(admission.policy),
      runTemplate: structuredClone(admission.run),
      namespace,
      planning: {
        status: "planned",
        baseOid: input.planningBaseOid,
        worktree: namespace.planningWorktree,
        createdAt: undefined,
        retiredAt: undefined,
        blocker: undefined,
      },
      run: {
        status: "unmaterialized",
        branchRef: namespace.runRef,
        worktree: namespace.runWorktree,
        headOid: undefined,
        materializedAt: undefined,
        retiredAt: undefined,
        blocker: undefined,
      },
      ticketCycles: {},
      ticketCycleOrder: [],
      targetSynchronization: undefined,
      promotion: undefined,
    };
  }

  public async materializePlanning(
    lifecycle: RunGitLifecycleRecord,
    journal: GitIntentJournal,
  ): Promise<RunGitLifecycleRecord> {
    await this.#assertLifecycle(lifecycle);
    if (lifecycle.planning.status === "ready") {
      await this.#assertCheckout({
        lifecycle,
        worktree: lifecycle.planning.worktree,
        headOid: lifecycle.planning.baseOid,
        branchRef: undefined,
        requireClean: true,
        label: "planning checkout",
      });
      return cloneLifecycle(lifecycle);
    }
    if (lifecycle.planning.status !== "planned") {
      throw invalidState(`planning checkout is ${lifecycle.planning.status}, not planned`);
    }
    const intent: GitLifecycleIntent = {
      ...this.#intentBase(lifecycle),
      kind: "planning_create",
      baseOid: lifecycle.planning.baseOid,
      worktree: lifecycle.planning.worktree,
    };
    await journal.prepare(intent);
    await ensureOwnedDirectory(path.dirname(intent.worktree), lifecycle.commonDirectory);
    const repository = new GitClient(lifecycle.projectRoot);
    const registered = await this.#registeredWorktree(repository, intent.worktree);
    if (registered === undefined) {
      if (await pathExists(intent.worktree)) {
        throw namespaceCollision(
          `unregistered path occupies planning namespace ${intent.worktree}`,
        );
      }
      await repository.createDetachedWorktree(
        intent.worktree,
        intent.baseOid,
        `Koni planning ${lifecycle.runId}`,
      );
      this.#fault("after_planning_checkout", intent);
    }
    await this.#assertCheckout({
      lifecycle,
      worktree: intent.worktree,
      headOid: intent.baseOid,
      branchRef: undefined,
      requireClean: true,
      label: "planning checkout",
    });
    const next = cloneLifecycle(lifecycle);
    next.planning.status = "ready";
    next.planning.createdAt ??= this.#timestamp();
    next.planning.blocker = undefined;
    await this.#settle(journal, intent, next);
    return next;
  }

  /**
   * Approval is the first operation allowed to create a permanent run ref.
   * A durable intent spans ref creation, worktree creation, and retirement of
   * the detached planning checkout so recovery can finish idempotently.
   */
  public async approveRun(
    lifecycle: RunGitLifecycleRecord,
    journal: GitIntentJournal,
  ): Promise<RunGitLifecycleRecord> {
    await this.#assertLifecycle(lifecycle);
    if (lifecycle.run.status === "ready") {
      await this.#assertCheckout({
        lifecycle,
        worktree: lifecycle.run.worktree,
        headOid: lifecycle.run.headOid!,
        branchRef: lifecycle.run.branchRef,
        requireClean: false,
        label: "run checkout",
      });
      return cloneLifecycle(lifecycle);
    }
    if (lifecycle.run.status !== "unmaterialized" || lifecycle.planning.status !== "ready") {
      throw invalidState("run approval requires a ready planning checkout and no run namespace");
    }
    await this.#assertCheckout({
      lifecycle,
      worktree: lifecycle.planning.worktree,
      headOid: lifecycle.planning.baseOid,
      branchRef: undefined,
      requireClean: true,
      label: "planning checkout",
    });
    const repository = new GitClient(lifecycle.projectRoot);
    const existingRunRef = await repository.tryResolveRef(lifecycle.run.branchRef);
    if (existingRunRef !== undefined && existingRunRef !== lifecycle.planning.baseOid) {
      throw namespaceCollision(
        `run ref ${lifecycle.run.branchRef} already exists at ${existingRunRef}`,
      );
    }
    const intent: GitLifecycleIntent = {
      ...this.#intentBase(lifecycle),
      kind: "run_materialize",
      baseOid: lifecycle.planning.baseOid,
      runRef: lifecycle.run.branchRef,
      runWorktree: lifecycle.run.worktree,
      planningWorktree: lifecycle.planning.worktree,
    };
    await journal.prepare(intent);
    if (existingRunRef === undefined) {
      await repository.createRef(intent.runRef, intent.baseOid);
      this.#fault("after_run_ref", intent);
    }
    await ensureOwnedDirectory(path.dirname(intent.runWorktree), lifecycle.commonDirectory);
    const registered = await this.#registeredWorktree(repository, intent.runWorktree);
    if (registered === undefined) {
      if (await pathExists(intent.runWorktree)) {
        throw namespaceCollision(`unregistered path occupies run namespace ${intent.runWorktree}`);
      }
      await repository.addExistingBranchWorktree(
        intent.runWorktree,
        intent.runRef,
        `Koni run ${lifecycle.runId}`,
      );
      this.#fault("after_run_worktree", intent);
    }
    await this.#assertCheckout({
      lifecycle,
      worktree: intent.runWorktree,
      headOid: intent.baseOid,
      branchRef: intent.runRef,
      requireClean: true,
      label: "run checkout",
    });
    await this.#retirePlanningCheckout(lifecycle, intent);
    this.#fault("after_planning_retired", intent);
    const next = cloneLifecycle(lifecycle);
    next.planning.status = "retired";
    next.planning.retiredAt ??= this.#timestamp();
    next.planning.blocker = undefined;
    next.run.status = "ready";
    next.run.headOid = intent.baseOid;
    next.run.materializedAt ??= this.#timestamp();
    next.run.blocker = undefined;
    await this.#settle(journal, intent, next);
    return next;
  }

  /** Allocate a fresh auditable Git cycle for one semantic ticket. */
  public async openTicketCycle(
    lifecycle: RunGitLifecycleRecord,
    input: {
      ticketId: string;
      cycleId: string;
      /** Required for policy-backed runs and persisted for commit/ref rendering. */
      templateContext?: GitTicketTemplateContext;
    },
    journal: GitIntentJournal,
  ): Promise<RunGitLifecycleRecord> {
    await this.#assertReadyRun(lifecycle);
    assertNamespaceId(input.ticketId, "ticket ID");
    assertNamespaceId(input.cycleId, "ticket cycle ID");
    const policyBacked = lifecycle.policy !== undefined;
    if (policyBacked) {
      if (
        input.templateContext === undefined ||
        input.templateContext.id !== input.ticketId ||
        input.templateContext.cycleId !== input.cycleId
      ) {
        throw invalidState(
          "policy-backed ticket cycle requires matching immutable template context",
        );
      }
      // Rendering validates the complete ticket context before any Git effect is journaled.
      renderTicketRef(lifecycle.policy!, lifecycle.runTemplate!, input.templateContext);
    }
    if (lifecycle.ticketCycles[input.cycleId] !== undefined) {
      const existing = lifecycle.ticketCycles[input.cycleId]!;
      if (existing.ticketId !== input.ticketId) {
        throw namespaceCollision(`cycle ${input.cycleId} belongs to another ticket`);
      }
      if (
        policyBacked &&
        canonicalTemplateContext(existing.templateContext) !==
          canonicalTemplateContext(input.templateContext)
      ) {
        throw invalidState(
          `ticket cycle ${input.cycleId} template context changed after allocation`,
        );
      }
      await this.#assertCheckout({
        lifecycle,
        worktree: existing.worktree,
        headOid: existing.ticketHeadOid,
        branchRef: existing.branchRef,
        requireClean: false,
        label: `ticket cycle ${input.cycleId}`,
      });
      return cloneLifecycle(lifecycle);
    }
    const repository = new GitClient(lifecycle.projectRoot);
    const runHead = await repository.resolveRef(lifecycle.run.branchRef);
    if (runHead !== lifecycle.run.headOid) {
      throw refMoved(
        "run ref moved before ticket cycle allocation",
        lifecycle.run.headOid!,
        runHead,
      );
    }
    const ordinal =
      lifecycle.ticketCycleOrder
        .map((id) => lifecycle.ticketCycles[id]!)
        .filter((cycle) => cycle.ticketId === input.ticketId).length + 1;
    const branchRef = policyBacked
      ? renderTicketRef(lifecycle.policy!, lifecycle.runTemplate!, input.templateContext!)
      : `refs/heads/koni/tickets/${lifecycle.runId}/${input.ticketId}/cycles/${input.cycleId}`;
    const worktree = policyBacked
      ? policyTicketWorktree(lifecycle.namespace.ticketRoot, branchRef)
      : path.join(lifecycle.namespace.ticketRoot, input.ticketId, "cycles", input.cycleId);
    await assertNewRefNamespace(repository, branchRef, lifecycle.target.ref);
    await assertNewWorktreePath(
      { worktreeRoot: lifecycle.projectRoot, commonDirectory: lifecycle.commonDirectory },
      worktree,
      lifecycle.namespace.root,
    );
    const intent: GitLifecycleIntent = {
      ...this.#intentBase(lifecycle),
      kind: "ticket_materialize",
      cycleId: input.cycleId,
      ticketId: input.ticketId,
      baseRunOid: runHead,
      ticketRef: branchRef,
      ticketWorktree: worktree,
      ...(input.templateContext === undefined
        ? {}
        : { templateContext: structuredClone(input.templateContext) }),
    };
    await journal.prepare(intent);
    await repository.createRef(branchRef, runHead);
    this.#fault("after_ticket_ref", intent);
    await ensureOwnedDirectory(path.dirname(worktree), lifecycle.commonDirectory);
    if (await pathExists(worktree)) {
      throw namespaceCollision(`path occupies new ticket cycle namespace: ${worktree}`);
    }
    await repository.addExistingBranchWorktree(
      worktree,
      branchRef,
      `Koni ticket ${input.ticketId} cycle ${input.cycleId}`,
    );
    this.#fault("after_ticket_worktree", intent);
    const createdAt = this.#timestamp();
    const next = cloneLifecycle(lifecycle);
    next.ticketCycles[input.cycleId] = {
      cycleId: input.cycleId,
      ticketId: input.ticketId,
      ordinal,
      status: "active",
      baseRunOid: runHead,
      branchRef,
      worktree,
      ticketHeadOid: runHead,
      integratedRunOid: undefined,
      squashCommitOid: undefined,
      createdAt,
      integratedAt: undefined,
      retiredAt: undefined,
      blocker: undefined,
      ...(input.templateContext === undefined
        ? {}
        : { templateContext: structuredClone(input.templateContext) }),
    };
    next.ticketCycleOrder.push(input.cycleId);
    await this.#settle(journal, intent, next);
    return next;
  }

  public async inspectTicketScope(
    lifecycle: RunGitLifecycleRecord,
    cycleId: string,
    scope: GitPathScope,
  ): Promise<GitPathScopeInspection> {
    await this.#assertLifecycle(lifecycle);
    const cycle = requiredCycle(lifecycle, cycleId);
    const checkout = new GitClient(cycle.worktree);
    const branchHead = await new GitClient(lifecycle.projectRoot).resolveRef(cycle.branchRef);
    const paths = new Set<string>(await checkout.changedPaths());
    for (const candidate of await checkout.diffPaths(cycle.baseRunOid, branchHead)) {
      paths.add(candidate);
    }
    return inspectGitPathScope([...paths], scope);
  }

  /** Commit the exact in-scope ticket tree without publishing it to the run. */
  public async commitTicketCandidate(
    lifecycle: RunGitLifecycleRecord,
    input: { cycleId: string; scope: GitPathScope; subject: string; body?: string },
    journal: GitIntentJournal,
  ): Promise<RunGitLifecycleRecord> {
    await this.#assertReadyRun(lifecycle);
    const cycle = requiredCycle(lifecycle, input.cycleId);
    if (cycle.status !== "active" && cycle.status !== "candidate") {
      throw invalidState(`ticket cycle ${cycle.cycleId} is ${cycle.status}`);
    }
    const commitSubject =
      lifecycle.policy === undefined
        ? input.subject
        : renderTicketCommitSubject(
            lifecycle.policy,
            lifecycle.runTemplate!,
            cycle.templateContext!,
          );
    assertCommitSubject(commitSubject);
    const repository = new GitClient(lifecycle.projectRoot);
    const checkout = new GitClient(cycle.worktree);
    const actualTicketHead = await repository.resolveRef(cycle.branchRef);
    if (actualTicketHead !== cycle.ticketHeadOid) {
      throw refMoved(
        `ticket ref moved before checkpoint for ${cycle.cycleId}`,
        cycle.ticketHeadOid,
        actualTicketHead,
      );
    }
    const initialScope = await this.inspectTicketScope(lifecycle, cycle.cycleId, input.scope);
    assertAcceptedScope(initialScope, cycle.cycleId);
    const liveChanges = await checkout.changedPaths();
    if (liveChanges.length === 0) {
      const next = cloneLifecycle(lifecycle);
      next.ticketCycles[cycle.cycleId]!.status = "candidate";
      return next;
    }
    await checkout.assertNoFilteredPaths(liveChanges);
    await checkout.stageAll();
    const stagedStatus = await checkout.statusEntries();
    const raced = stagedStatus
      .filter((entry) => entry.code === "??" || entry.code[1] !== " ")
      .flatMap((entry) => [
        entry.path,
        ...(entry.originalPath === undefined ? [] : [entry.originalPath]),
      ]);
    if (raced.length > 0) {
      throw new GitLifecycleError(
        "dirty_checkout",
        `ticket checkout changed while checkpointing: ${[...new Set(raced)].sort().join(", ")}`,
        { paths: [...new Set(raced)].sort() },
      );
    }
    const treeOid = await checkout.indexTree();
    if (treeOid === (await repository.treeOfCommit(actualTicketHead))) {
      const next = cloneLifecycle(lifecycle);
      next.ticketCycles[cycle.cycleId]!.status = "candidate";
      return next;
    }
    const timestamp = this.#timestamp();
    const candidateOid = await repository.commitTree(
      treeOid,
      [actualTicketHead],
      commitMessage(commitSubject, input.body, {
        "Koni-Run": lifecycle.runId,
        "Koni-Ticket": cycle.ticketId,
        "Koni-Cycle": cycle.cycleId,
      }),
      { ...this.#identity, timestamp },
    );
    const candidateScope = inspectGitPathScope(
      await repository.diffPaths(cycle.baseRunOid, candidateOid),
      input.scope,
    );
    assertAcceptedScope(candidateScope, cycle.cycleId);
    const intent: GitLifecycleIntent = {
      ...this.#intentBase(lifecycle, timestamp),
      kind: "ticket_checkpoint",
      cycleId: cycle.cycleId,
      expectedTicketOid: actualTicketHead,
      candidateOid,
      ticketRef: cycle.branchRef,
      ticketWorktree: cycle.worktree,
    };
    await journal.prepare(intent);
    try {
      await repository.updateRef(cycle.branchRef, candidateOid, actualTicketHead);
    } catch (error) {
      throw translateCasError(error, `ticket ref moved while checkpointing ${cycle.cycleId}`);
    }
    this.#fault("after_ticket_checkpoint_ref", intent);
    if ((await checkout.statusEntries()).length !== 0) {
      throw new GitLifecycleError(
        "recovery_ambiguous",
        `ticket ref advanced but checkout ${cycle.worktree} is not clean; recovery must preserve it`,
      );
    }
    const next = cloneLifecycle(lifecycle);
    const mutable = next.ticketCycles[cycle.cycleId]!;
    mutable.ticketHeadOid = candidateOid;
    mutable.status = "candidate";
    mutable.blocker = undefined;
    await this.#settle(journal, intent, next);
    return next;
  }

  /**
   * Compose one ticket candidate into the current run tree and publish one policy-shaped commit
   * under CAS. Squash uses one parent; merge preserves run and ticket parents. `merge-tree` never
   * writes conflict markers into either checkout.
   */
  public async publishTicketCandidate(
    lifecycle: RunGitLifecycleRecord,
    input: {
      cycleId: string;
      scope: GitPathScope;
      subject: string;
      body?: string;
      /** Optional; a configured review.id trailer is omitted when no independent review exists. */
      reviewId?: string;
    },
    journal: GitIntentJournal,
  ): Promise<TicketPublicationResult> {
    await this.#assertReadyRun(lifecycle);
    const cycle = requiredCycle(lifecycle, input.cycleId);
    if (cycle.status === "integrated") {
      return {
        status: "integrated",
        lifecycle: cloneLifecycle(lifecycle),
        cycle: structuredClone(cycle),
      };
    }
    if (cycle.status !== "candidate") {
      throw invalidState(`ticket cycle ${cycle.cycleId} must be checkpointed before publication`);
    }
    const ticketContext =
      lifecycle.policy === undefined
        ? undefined
        : {
            ...cycle.templateContext!,
            ...(input.reviewId === undefined ? {} : { reviewId: input.reviewId }),
          };
    const commitSubject =
      lifecycle.policy === undefined
        ? input.subject
        : renderTicketCommitSubject(lifecycle.policy, lifecycle.runTemplate!, ticketContext!);
    assertCommitSubject(commitSubject);
    const repository = new GitClient(lifecycle.projectRoot);
    const ticketCheckout = new GitClient(cycle.worktree);
    const runCheckout = new GitClient(lifecycle.run.worktree);
    const [ticketHead, runHead] = await Promise.all([
      repository.resolveRef(cycle.branchRef),
      repository.resolveRef(lifecycle.run.branchRef),
    ]);
    if (ticketHead !== cycle.ticketHeadOid) {
      throw refMoved("ticket ref moved before publication", cycle.ticketHeadOid, ticketHead);
    }
    if (runHead !== lifecycle.run.headOid) {
      throw refMoved("run ref moved before ticket publication", lifecycle.run.headOid!, runHead);
    }
    const scope = await this.inspectTicketScope(lifecycle, cycle.cycleId, input.scope);
    assertAcceptedScope(scope, cycle.cycleId);
    if ((await ticketCheckout.statusEntries()).length !== 0) {
      throw dirtyCheckout("ticket checkout", cycle.worktree);
    }
    await this.#assertCheckout({
      lifecycle,
      worktree: lifecycle.run.worktree,
      headOid: runHead,
      branchRef: lifecycle.run.branchRef,
      requireClean: true,
      label: "run checkout",
    });
    if (
      (await repository.treeOfCommit(ticketHead)) ===
      (await repository.treeOfCommit(cycle.baseRunOid))
    ) {
      const next = cloneLifecycle(lifecycle);
      const mutable = next.ticketCycles[cycle.cycleId]!;
      mutable.status = "integrated";
      mutable.integratedRunOid = runHead;
      mutable.squashCommitOid = undefined;
      mutable.integratedAt = this.#timestamp();
      return { status: "integrated", lifecycle: next, cycle: structuredClone(mutable) };
    }
    const merged = await repository.mergeTreeDetailed(runHead, ticketHead);
    if (merged.conflictPaths.length > 0 || merged.treeOid === undefined) {
      const conflict = await conflictReport(repository, runHead, ticketHead, merged);
      const next = cloneLifecycle(lifecycle);
      const mutable = next.ticketCycles[cycle.cycleId]!;
      mutable.status = "conflict";
      mutable.blocker = conflict.message;
      return { status: "conflict", lifecycle: next, conflict };
    }
    const runTree = await repository.treeOfCommit(runHead);
    if (merged.treeOid === runTree) {
      const next = cloneLifecycle(lifecycle);
      const mutable = next.ticketCycles[cycle.cycleId]!;
      mutable.status = "integrated";
      mutable.integratedRunOid = runHead;
      mutable.integratedAt = this.#timestamp();
      return { status: "integrated", lifecycle: next, cycle: structuredClone(mutable) };
    }
    const timestamp = this.#timestamp();
    const configuredTrailers =
      lifecycle.policy === undefined
        ? {}
        : renderConfiguredCommitTrailers(lifecycle.policy, lifecycle.runTemplate!, ticketContext!);
    const squashCommitOid = await repository.commitTree(
      merged.treeOid,
      lifecycle.policy?.integration.strategy === "merge" ? [runHead, ticketHead] : [runHead],
      commitMessage(commitSubject, input.body, {
        ...configuredTrailers,
        "Koni-Run": lifecycle.runId,
        "Koni-Ticket": cycle.ticketId,
        "Koni-Cycle": cycle.cycleId,
        "Koni-Ticket-Head": ticketHead,
      }),
      { ...this.#identity, timestamp },
    );
    const intent: GitLifecycleIntent = {
      ...this.#intentBase(lifecycle, timestamp),
      kind: "ticket_publish",
      cycleId: cycle.cycleId,
      expectedRunOid: runHead,
      ticketOid: ticketHead,
      squashCommitOid,
      runRef: lifecycle.run.branchRef,
      runWorktree: lifecycle.run.worktree,
    };
    await journal.prepare(intent);
    try {
      await repository.updateRef(intent.runRef, squashCommitOid, runHead);
    } catch (error) {
      throw translateCasError(error, `run ref moved while publishing ${cycle.cycleId}`);
    }
    this.#fault("after_run_publish_ref", intent);
    try {
      this.#fault("before_run_checkout_repair", intent);
      await repairAdvancedCheckout(runCheckout, runHead, squashCommitOid);
    } catch (error) {
      const compensation = await this.#forwardCompensatePublication(
        lifecycle,
        intent,
        journal,
        error,
      );
      throw new GitLifecycleError(
        compensation.compensated ? "dirty_checkout" : "recovery_ambiguous",
        compensation.reason,
        compensation.compensationOid === undefined
          ? {}
          : { compensationOid: compensation.compensationOid },
      );
    }
    this.#fault("after_run_checkout", intent);
    const next = cloneLifecycle(lifecycle);
    next.run.headOid = squashCommitOid;
    next.targetSynchronization = undefined;
    next.promotion = undefined;
    const mutable = next.ticketCycles[cycle.cycleId]!;
    mutable.status = "integrated";
    mutable.integratedRunOid = squashCommitOid;
    mutable.squashCommitOid = squashCommitOid;
    mutable.integratedAt = timestamp;
    mutable.blocker = undefined;
    await this.#settle(journal, intent, next);
    return { status: "integrated", lifecycle: next, cycle: structuredClone(mutable) };
  }

  /**
   * Compose the current operator-selected target into the owned run head before checkpoint/review.
   * A conflict is reported from `merge-tree` without changing either ref or checkout. A successful
   * ref advance is journaled and recovered under exact CAS just like ticket publication.
   */
  public async synchronizeTargetIntoRun(
    lifecycle: RunGitLifecycleRecord,
    input: { subject: string; body?: string },
    journal: GitIntentJournal,
  ): Promise<TargetSynchronizationResult> {
    await this.#assertReadyRun(lifecycle);
    assertCommitSubject(input.subject);
    const repository = new GitClient(lifecycle.projectRoot);
    const [runOid, targetOid] = await Promise.all([
      repository.resolveRef(lifecycle.run.branchRef),
      repository.resolveRef(lifecycle.target.ref),
    ]);
    if (runOid !== lifecycle.run.headOid) {
      throw refMoved("run ref moved before target synchronization", lifecycle.run.headOid!, runOid);
    }
    const prior = lifecycle.targetSynchronization;
    if (
      prior?.status === "synchronized" &&
      prior.targetOid === targetOid &&
      prior.runOid === runOid
    ) {
      return {
        status: "synchronized",
        lifecycle: cloneLifecycle(lifecycle),
        synchronization: structuredClone(prior),
      };
    }

    let synchronizedRunOid = runOid;
    if (runOid !== targetOid && !(await repository.isAncestor(targetOid, runOid))) {
      if (await repository.isAncestor(runOid, targetOid)) {
        synchronizedRunOid = targetOid;
      } else {
        const merged = await repository.mergeTreeDetailed(runOid, targetOid);
        if (merged.conflictPaths.length > 0 || merged.treeOid === undefined) {
          const conflict = await conflictReport(repository, runOid, targetOid, merged);
          const next = cloneLifecycle(lifecycle);
          next.targetSynchronization = {
            status: "integration_required",
            priorRunOid: runOid,
            targetOid,
            runOid: undefined,
            synchronizedAt: this.#timestamp(),
            blocker: conflict.message,
          };
          next.promotion = undefined;
          return { status: "integration_required", lifecycle: next, conflict };
        }
        const timestamp = this.#timestamp();
        synchronizedRunOid = await repository.commitTree(
          merged.treeOid,
          [runOid, targetOid],
          commitMessage(input.subject, input.body, {
            "Koni-Run": lifecycle.runId,
            "Koni-Target": lifecycle.target.ref,
            "Koni-Target-Oid": targetOid,
          }),
          { ...this.#identity, timestamp },
        );
      }
    }

    const synchronizedAt = this.#timestamp();
    if (synchronizedRunOid === runOid) {
      const next = cloneLifecycle(lifecycle);
      next.targetSynchronization = {
        status: "synchronized",
        priorRunOid: runOid,
        targetOid,
        runOid,
        synchronizedAt,
        blocker: undefined,
      };
      next.promotion = undefined;
      return {
        status: "synchronized",
        lifecycle: next,
        synchronization: structuredClone(next.targetSynchronization),
      };
    }

    const intent: Extract<GitLifecycleIntent, { kind: "target_sync" }> = {
      ...this.#intentBase(lifecycle, synchronizedAt),
      kind: "target_sync",
      expectedRunOid: runOid,
      observedTargetOid: targetOid,
      synchronizedRunOid,
      runRef: lifecycle.run.branchRef,
      runWorktree: lifecycle.run.worktree,
    };
    await journal.prepare(intent);
    try {
      await repository.updateRef(intent.runRef, synchronizedRunOid, runOid);
    } catch (error) {
      throw translateCasError(error, "run ref moved while synchronizing target");
    }
    this.#fault("after_target_sync_ref", intent);
    try {
      this.#fault("before_target_sync_checkout_repair", intent);
      await repairAdvancedCheckout(new GitClient(intent.runWorktree), runOid, synchronizedRunOid);
    } catch (error) {
      const compensation = await this.#forwardCompensatePublication(
        lifecycle,
        intent,
        journal,
        error,
      );
      throw new GitLifecycleError(
        compensation.compensated ? "dirty_checkout" : "recovery_ambiguous",
        compensation.reason,
        compensation.compensationOid === undefined
          ? {}
          : { compensationOid: compensation.compensationOid },
      );
    }
    this.#fault("after_target_sync_checkout", intent);
    const next = cloneLifecycle(lifecycle);
    next.run.headOid = synchronizedRunOid;
    next.targetSynchronization = {
      status: "synchronized",
      priorRunOid: runOid,
      targetOid,
      runOid: synchronizedRunOid,
      synchronizedAt,
      blocker: undefined,
    };
    next.promotion = undefined;
    await this.#settle(journal, intent, next);
    return {
      status: "synchronized",
      lifecycle: next,
      synchronization: structuredClone(next.targetSynchronization),
    };
  }

  /** Build an immutable promotion candidate; this never updates the target ref. */
  public async prepareTargetPromotion(
    lifecycle: RunGitLifecycleRecord,
    input: { subject: string; body?: string },
  ): Promise<{ lifecycle: RunGitLifecycleRecord; preparation: TargetPromotionPreparation }> {
    await this.#assertReadyRun(lifecycle);
    assertCommitSubject(input.subject);
    const repository = new GitClient(lifecycle.projectRoot);
    const [runOid, targetOid] = await Promise.all([
      repository.resolveRef(lifecycle.run.branchRef),
      repository.resolveRef(lifecycle.target.ref),
    ]);
    if (runOid !== lifecycle.run.headOid) {
      throw refMoved("run ref moved before promotion preparation", lifecycle.run.headOid!, runOid);
    }
    if (lifecycle.policy !== undefined) {
      const synchronization = lifecycle.targetSynchronization;
      if (synchronization?.status !== "synchronized" || synchronization.runOid !== runOid) {
        throw invalidState("target_sync must bind the exact run head before promotion");
      }
      if (synchronization.targetOid !== targetOid) {
        throw invalidState(
          "selected target advanced after target_sync; synchronize and verify the new head",
        );
      }
    }
    const targetCheckout = await uniqueCheckoutForRef(repository, lifecycle.target.ref);
    let candidateOid: string;
    if (lifecycle.policy?.integration.strategy === "squash" && runOid !== targetOid) {
      const timestamp = this.#timestamp();
      candidateOid = await repository.commitTree(
        await repository.treeOfCommit(runOid),
        [targetOid],
        commitMessage(input.subject, input.body, {
          "Koni-Run": lifecycle.runId,
          "Koni-Target": lifecycle.target.ref,
          "Koni-Synchronized-Target": lifecycle.targetSynchronization!.targetOid,
        }),
        { ...this.#identity, timestamp },
      );
    } else if (runOid === targetOid || (await repository.isAncestor(targetOid, runOid))) {
      candidateOid = runOid;
    } else {
      const merged = await repository.mergeTreeDetailed(targetOid, runOid);
      if (merged.conflictPaths.length > 0 || merged.treeOid === undefined) {
        const conflict = await conflictReport(repository, targetOid, runOid, merged);
        const next = cloneLifecycle(lifecycle);
        next.promotion = {
          status: "integration_required",
          expectedTargetOid: targetOid,
          runOid,
          candidateOid: undefined,
          targetCheckout,
          preparedAt: this.#timestamp(),
          publishedAt: undefined,
          blocker: conflict.message,
        };
        return {
          lifecycle: next,
          preparation: {
            status: "integration_required",
            expectedTargetOid: targetOid,
            runOid,
            conflict,
          },
        };
      }
      const timestamp = this.#timestamp();
      candidateOid = await repository.commitTree(
        merged.treeOid,
        [targetOid, runOid],
        commitMessage(input.subject, input.body, {
          "Koni-Run": lifecycle.runId,
          "Koni-Target": lifecycle.target.ref,
        }),
        { ...this.#identity, timestamp },
      );
    }
    const preparedAt = this.#timestamp();
    const next = cloneLifecycle(lifecycle);
    next.promotion = {
      status: "ready",
      expectedTargetOid: targetOid,
      runOid,
      candidateOid,
      targetCheckout,
      preparedAt,
      publishedAt: undefined,
      blocker: undefined,
    };
    return {
      lifecycle: next,
      preparation: {
        status: "ready",
        expectedTargetOid: targetOid,
        runOid,
        candidateOid,
        targetCheckout,
        replayed: targetOid === candidateOid,
      },
    };
  }

  /** Explicit operator-triggered compare-and-swap of the selected target. */
  public async publishTargetPromotion(
    lifecycle: RunGitLifecycleRecord,
    journal: GitIntentJournal,
  ): Promise<RunGitLifecycleRecord> {
    await this.#assertReadyRun(lifecycle);
    const promotion = lifecycle.promotion;
    if (promotion?.status === "published") return cloneLifecycle(lifecycle);
    if (promotion?.status !== "ready" || promotion.candidateOid === undefined) {
      throw invalidState("target promotion has not been prepared or requires integration work");
    }
    const repository = new GitClient(lifecycle.projectRoot);
    const currentRun = await repository.resolveRef(lifecycle.run.branchRef);
    if (currentRun !== promotion.runOid || currentRun !== lifecycle.run.headOid) {
      throw refMoved("run ref moved after promotion preparation", promotion.runOid, currentRun);
    }
    const currentCheckout = await uniqueCheckoutForRef(repository, lifecycle.target.ref);
    if (currentCheckout !== promotion.targetCheckout) {
      throw new GitLifecycleError(
        "ownership_mismatch",
        "target checkout placement changed after promotion preparation",
        { expected: promotion.targetCheckout, actual: currentCheckout },
      );
    }
    const observedTarget = await repository.resolveRef(lifecycle.target.ref);
    if (currentCheckout !== undefined && observedTarget !== promotion.candidateOid) {
      const checkout = new GitClient(currentCheckout);
      const dirty = await checkout.statusEntries();
      if (dirty.length !== 0) {
        throw dirtyCheckout("operator target checkout", currentCheckout);
      }
    }
    const intent: GitLifecycleIntent = {
      ...this.#intentBase(lifecycle),
      kind: "target_publish",
      expectedTargetOid: promotion.expectedTargetOid,
      runOid: promotion.runOid,
      candidateOid: promotion.candidateOid,
      targetRef: lifecycle.target.ref,
      targetCheckout: promotion.targetCheckout,
    };
    await journal.prepare(intent);
    const currentTarget = await repository.resolveRef(intent.targetRef);
    if (currentTarget !== intent.candidateOid) {
      if (currentTarget !== intent.expectedTargetOid) {
        throw refMoved(
          "target ref moved after promotion preparation",
          intent.expectedTargetOid,
          currentTarget,
        );
      }
      try {
        await repository.updateRef(intent.targetRef, intent.candidateOid, intent.expectedTargetOid);
      } catch (error) {
        throw translateCasError(error, "target ref moved during explicit promotion");
      }
      this.#fault("after_target_publish_ref", intent);
    }
    if (intent.targetCheckout !== undefined) {
      try {
        this.#fault("before_target_checkout_repair", intent);
        await repairAdvancedCheckout(
          new GitClient(intent.targetCheckout),
          intent.expectedTargetOid,
          intent.candidateOid,
          true,
        );
      } catch (error) {
        const compensation = await this.#forwardCompensatePublication(
          lifecycle,
          intent,
          journal,
          error,
        );
        throw new GitLifecycleError(
          compensation.compensated ? "dirty_checkout" : "recovery_ambiguous",
          compensation.reason,
          compensation.compensationOid === undefined
            ? {}
            : { compensationOid: compensation.compensationOid },
        );
      }
      this.#fault("after_target_checkout", intent);
    }
    const next = cloneLifecycle(lifecycle);
    next.promotion = {
      ...promotion,
      status: "published",
      publishedAt: this.#timestamp(),
      blocker: undefined,
    };
    await this.#settle(journal, intent, next);
    return next;
  }

  /**
   * Archive and retire one unintegrated ticket cycle after compiler-authorized change control.
   *
   * This is deliberately not a metadata reset. Any in-scope working bytes are checkpointed first,
   * the exact resulting ticket head is retained under an immutable archive ref, and only then are
   * the active worktree and branch removed. The journal makes every external boundary crash-forward
   * so an approved upstream change can start a fresh cycle without losing or silently composing the
   * superseded attempt.
   */
  public async supersedeTicketCycle(
    lifecycle: RunGitLifecycleRecord,
    input: {
      cycleId: string;
      scope: GitPathScope;
      subject: string;
      body?: string;
      supersessionSha256: string;
    },
    journal: GitIntentJournal,
  ): Promise<RunGitLifecycleRecord> {
    await this.#assertReadyRun(lifecycle);
    assertNamespaceId(input.cycleId, "ticket cycle ID");
    if (!isSha256Value(input.supersessionSha256)) {
      throw invalidState("ticket supersession requires an exact sha256 authority binding");
    }
    const original = requiredCycle(lifecycle, input.cycleId);
    const archiveRef = supersessionArchiveRef(
      lifecycle.runId,
      original.ticketId,
      original.cycleId,
      input.supersessionSha256,
    );
    if (original.status === "retired") {
      if (
        original.archiveRef !== archiveRef ||
        original.supersessionSha256 !== input.supersessionSha256 ||
        original.supersededAt === undefined ||
        original.retiredAt !== original.supersededAt
      ) {
        throw invalidState(`ticket cycle ${original.cycleId} was retired by another authority`);
      }
      const repository = new GitClient(lifecycle.projectRoot);
      const [archivedOid, activeOid, registered] = await Promise.all([
        repository.tryResolveRef(archiveRef),
        repository.tryResolveRef(original.branchRef),
        this.#registeredWorktree(repository, original.worktree),
      ]);
      if (
        archivedOid !== original.ticketHeadOid ||
        activeOid !== undefined ||
        registered !== undefined ||
        (await pathExists(original.worktree))
      ) {
        throw new GitLifecycleError(
          "ownership_mismatch",
          `retired ticket cycle ${original.cycleId} no longer matches its supersession record`,
        );
      }
      return cloneLifecycle(lifecycle);
    }
    if (original.status !== "active" && original.status !== "candidate") {
      throw invalidState(
        `ticket cycle ${original.cycleId} is ${original.status}, not supersedable`,
      );
    }

    const checkpointed = await this.commitTicketCandidate(
      lifecycle,
      {
        cycleId: input.cycleId,
        scope: input.scope,
        subject: input.subject,
        ...(input.body === undefined ? {} : { body: input.body }),
      },
      journal,
    );
    const cycle = requiredCycle(checkpointed, input.cycleId);
    const repository = new GitClient(checkpointed.projectRoot);
    const [ticketOid, existingArchive] = await Promise.all([
      repository.resolveRef(cycle.branchRef),
      repository.tryResolveRef(archiveRef),
    ]);
    if (ticketOid !== cycle.ticketHeadOid) {
      throw refMoved(
        `ticket ref moved before superseding ${cycle.cycleId}`,
        cycle.ticketHeadOid,
        ticketOid,
      );
    }
    if (existingArchive !== undefined && existingArchive !== ticketOid) {
      throw namespaceCollision(
        `ticket supersession archive ${archiveRef} already points at ${existingArchive}`,
      );
    }
    await this.#assertCheckout({
      lifecycle: checkpointed,
      worktree: cycle.worktree,
      headOid: ticketOid,
      branchRef: cycle.branchRef,
      requireClean: true,
      label: `ticket cycle ${cycle.cycleId}`,
    });
    const intent: Extract<GitLifecycleIntent, { kind: "ticket_supersede" }> = {
      ...this.#intentBase(checkpointed),
      kind: "ticket_supersede",
      cycleId: cycle.cycleId,
      ticketId: cycle.ticketId,
      expectedTicketOid: ticketOid,
      ticketRef: cycle.branchRef,
      ticketWorktree: cycle.worktree,
      archiveRef,
      supersessionSha256: input.supersessionSha256,
    };
    await journal.prepare(intent);
    if (existingArchive === undefined) {
      try {
        await repository.createRef(intent.archiveRef, intent.expectedTicketOid);
      } catch (error) {
        const racedArchive = await repository.tryResolveRef(intent.archiveRef);
        if (racedArchive !== intent.expectedTicketOid) throw error;
      }
      this.#fault("after_ticket_supersession_archive", intent);
    }
    await repository.unlockWorktree(intent.ticketWorktree);
    await repository.removeWorktree(intent.ticketWorktree);
    this.#fault("after_ticket_supersession_worktree_retired", intent);
    try {
      await repository.deleteRef(intent.ticketRef, intent.expectedTicketOid);
    } catch (error) {
      throw translateCasError(error, `ticket ref moved while superseding ${cycle.cycleId}`);
    }
    this.#fault("after_ticket_supersession_ref_retired", intent);
    const next = supersededTicketLifecycle(checkpointed, intent);
    await this.#settle(journal, intent, next);
    return next;
  }

  /**
   * Retire a completed ticket cycle only after proving its exact ref,
   * checkout, cleanliness, integration, and compiler-owned namespace.
   */
  public async retireTicketCycle(
    lifecycle: RunGitLifecycleRecord,
    cycleId: string,
    journal: GitIntentJournal,
  ): Promise<RunGitLifecycleRecord> {
    await this.#assertLifecycle(lifecycle);
    const cycle = requiredCycle(lifecycle, cycleId);
    if (cycle.status === "retired") return cloneLifecycle(lifecycle);
    if (
      (cycle.status !== "integrated" && cycle.status !== "preserved") ||
      cycle.integratedRunOid === undefined
    ) {
      return preserveCycle(
        lifecycle,
        cycleId,
        "only a proven integrated ticket cycle may be retired",
      );
    }
    const repository = new GitClient(lifecycle.projectRoot);
    const refOid = await repository.tryResolveRef(cycle.branchRef);
    const registered = await this.#registeredWorktree(repository, cycle.worktree);
    if (refOid === undefined && registered === undefined && !(await pathExists(cycle.worktree))) {
      const next = cloneLifecycle(lifecycle);
      const mutable = next.ticketCycles[cycleId]!;
      mutable.status = "retired";
      mutable.retiredAt ??= this.#timestamp();
      mutable.blocker = undefined;
      return next;
    }
    if (refOid !== cycle.ticketHeadOid) {
      return preserveCycle(
        lifecycle,
        cycleId,
        `ticket ref does not match its recorded head (${refOid ?? "missing"})`,
      );
    }
    if (registered === undefined) {
      if (await pathExists(cycle.worktree)) {
        return preserveCycle(
          lifecycle,
          cycleId,
          "unregistered data remains at ticket worktree path",
        );
      }
    } else {
      try {
        await this.#assertCheckout({
          lifecycle,
          worktree: cycle.worktree,
          headOid: cycle.ticketHeadOid,
          branchRef: cycle.branchRef,
          requireClean: true,
          label: `ticket cycle ${cycleId}`,
        });
      } catch (error) {
        return preserveCycle(lifecycle, cycleId, errorMessage(error));
      }
    }
    const intent: GitLifecycleIntent = {
      ...this.#intentBase(lifecycle),
      kind: "ticket_retire",
      cycleId,
      expectedTicketOid: cycle.ticketHeadOid,
      ticketRef: cycle.branchRef,
      ticketWorktree: cycle.worktree,
    };
    await journal.prepare(intent);
    if (registered !== undefined) {
      await repository.unlockWorktree(intent.ticketWorktree);
      await repository.removeWorktree(intent.ticketWorktree);
      this.#fault("after_ticket_worktree_retired", intent);
    }
    if ((await repository.tryResolveRef(intent.ticketRef)) !== undefined) {
      await repository.deleteRef(intent.ticketRef, intent.expectedTicketOid);
      this.#fault("after_ticket_ref_retired", intent);
    }
    const next = cloneLifecycle(lifecycle);
    const mutable = next.ticketCycles[cycleId]!;
    mutable.status = "retired";
    mutable.retiredAt = this.#timestamp();
    mutable.blocker = undefined;
    await this.#settle(journal, intent, next);
    return next;
  }

  /** Retire the run namespace only after a successful target publication. */
  public async retireRunNamespace(
    lifecycle: RunGitLifecycleRecord,
    journal: GitIntentJournal,
  ): Promise<RunGitLifecycleRecord> {
    await this.#assertReadyRun(lifecycle);
    if (
      lifecycle.promotion?.status !== "published" ||
      lifecycle.promotion.candidateOid === undefined
    ) {
      throw invalidState("run cleanup requires a published target promotion");
    }
    const remaining = Object.values(lifecycle.ticketCycles).filter(
      (cycle) => cycle.status !== "retired",
    );
    if (remaining.length > 0) {
      throw invalidState(
        `run cleanup requires retired ticket cycles: ${remaining.map((c) => c.cycleId).join(", ")}`,
      );
    }
    const repository = new GitClient(lifecycle.projectRoot);
    const targetHead = await repository.resolveRef(lifecycle.target.ref);
    if (targetHead !== lifecycle.promotion.candidateOid) {
      throw refMoved(
        "target ref moved before run cleanup",
        lifecycle.promotion.candidateOid,
        targetHead,
      );
    }
    const runHead = await repository.resolveRef(lifecycle.run.branchRef);
    const publishedContainsRun =
      lifecycle.policy?.integration.strategy === "squash"
        ? (await repository.treeOfCommit(runHead)) === (await repository.treeOfCommit(targetHead))
        : await repository.isAncestor(runHead, targetHead);
    if (runHead !== lifecycle.run.headOid || !publishedContainsRun) {
      throw new GitLifecycleError(
        "ownership_mismatch",
        "published target does not contain the exact recorded run head",
      );
    }
    await this.#assertCheckout({
      lifecycle,
      worktree: lifecycle.run.worktree,
      headOid: runHead,
      branchRef: lifecycle.run.branchRef,
      requireClean: true,
      label: "run checkout",
    });
    const intent: GitLifecycleIntent = {
      ...this.#intentBase(lifecycle),
      kind: "run_retire",
      expectedRunOid: runHead,
      runRef: lifecycle.run.branchRef,
      runWorktree: lifecycle.run.worktree,
    };
    await journal.prepare(intent);
    await repository.unlockWorktree(intent.runWorktree);
    await repository.removeWorktree(intent.runWorktree);
    this.#fault("after_run_worktree_retired", intent);
    await repository.deleteRef(intent.runRef, intent.expectedRunOid);
    this.#fault("after_run_ref_retired", intent);
    const next = cloneLifecycle(lifecycle);
    next.run.status = "retired";
    next.run.retiredAt = this.#timestamp();
    next.run.blocker = undefined;
    await this.#settle(journal, intent, next);
    return next;
  }

  /**
   * Explicit run deletion before publication. Unlike normal cleanup this may
   * retire clean, unintegrated ticket/run refs, but only inside the exact
   * recorded Koni namespace. The selected target ref is never readied for
   * mutation and is never passed to an update/delete command.
   */
  public async retireAbandonedRun(
    lifecycle: RunGitLifecycleRecord,
    journal: GitIntentJournal,
  ): Promise<AbandonedRunRetirementResult> {
    await this.#assertLifecycle(lifecycle);
    let resources: Omit<
      Extract<GitLifecycleIntent, { kind: "abandoned_run_retire" }>,
      keyof GitIntentBase | "kind"
    >;
    try {
      resources = await this.#abandonedResources(lifecycle);
      await this.#assertAbandonedResources(lifecycle, resources);
    } catch (error) {
      const reason = errorMessage(error);
      return {
        status: "preserved",
        lifecycle: preserveAbandonedLifecycle(lifecycle, reason),
        reason,
      };
    }
    if (
      resources.planning === undefined &&
      resources.run === undefined &&
      resources.tickets.length === 0
    ) {
      return {
        status: "retired",
        lifecycle: retiredAbandonedLifecycle(lifecycle, this.#timestamp()),
      };
    }
    const intent: Extract<GitLifecycleIntent, { kind: "abandoned_run_retire" }> = {
      ...this.#intentBase(lifecycle),
      kind: "abandoned_run_retire",
      ...resources,
    };
    await journal.prepare(intent);
    await this.#applyAbandonedRetirement(lifecycle, intent);
    const next = retiredAbandonedLifecycle(lifecycle, this.#timestamp());
    await this.#settle(journal, intent, next);
    return { status: "retired", lifecycle: next };
  }

  /** Reconcile one durable intent after authority restart without guessing. */
  public async recoverIntent(
    lifecycle: RunGitLifecycleRecord,
    intent: GitLifecycleIntent,
    journal: GitIntentJournal,
  ): Promise<GitRecoveryResult> {
    await this.#assertLifecycle(lifecycle);
    assertGitLifecycleIntent(intent);
    this.#assertIntent(lifecycle, intent);
    try {
      switch (intent.kind) {
        case "planning_create": {
          const repository = new GitClient(lifecycle.projectRoot);
          const registered = await this.#registeredWorktree(repository, intent.worktree);
          if (registered === undefined) {
            if (await pathExists(intent.worktree)) {
              return this.#preserveRecovery(
                lifecycle,
                intent,
                journal,
                "unregistered planning path exists",
              );
            }
            await ensureOwnedDirectory(path.dirname(intent.worktree), lifecycle.commonDirectory);
            await repository.createDetachedWorktree(
              intent.worktree,
              intent.baseOid,
              `Koni planning ${lifecycle.runId}`,
            );
          }
          await this.#assertCheckout({
            lifecycle,
            worktree: intent.worktree,
            headOid: intent.baseOid,
            branchRef: undefined,
            requireClean: true,
            label: "planning checkout",
          });
          const next = cloneLifecycle(lifecycle);
          next.planning.status = "ready";
          next.planning.createdAt ??= this.#timestamp();
          next.planning.blocker = undefined;
          await this.#settle(journal, intent, next);
          return { status: "completed", lifecycle: next };
        }
        case "run_materialize": {
          const repository = new GitClient(lifecycle.projectRoot);
          const ref = await repository.tryResolveRef(intent.runRef);
          if (ref === undefined) await repository.createRef(intent.runRef, intent.baseOid);
          else if (ref !== intent.baseOid) {
            return this.#preserveRecovery(
              lifecycle,
              intent,
              journal,
              "run ref differs from approval base",
            );
          }
          const registered = await this.#registeredWorktree(repository, intent.runWorktree);
          if (registered === undefined) {
            if (await pathExists(intent.runWorktree)) {
              return this.#preserveRecovery(
                lifecycle,
                intent,
                journal,
                "unregistered run path exists",
              );
            }
            await ensureOwnedDirectory(path.dirname(intent.runWorktree), lifecycle.commonDirectory);
            await repository.addExistingBranchWorktree(
              intent.runWorktree,
              intent.runRef,
              `Koni run ${lifecycle.runId}`,
            );
          }
          await this.#assertCheckout({
            lifecycle,
            worktree: intent.runWorktree,
            headOid: intent.baseOid,
            branchRef: intent.runRef,
            requireClean: true,
            label: "run checkout",
          });
          const planning = await this.#registeredWorktree(repository, intent.planningWorktree);
          if (planning !== undefined) await this.#retirePlanningCheckout(lifecycle, intent);
          else if (await pathExists(intent.planningWorktree)) {
            return this.#preserveRecovery(
              lifecycle,
              intent,
              journal,
              "unregistered planning data remains",
            );
          }
          const next = cloneLifecycle(lifecycle);
          next.planning.status = "retired";
          next.planning.retiredAt ??= this.#timestamp();
          next.run.status = "ready";
          next.run.headOid = intent.baseOid;
          next.run.materializedAt ??= this.#timestamp();
          await this.#settle(journal, intent, next);
          return { status: "completed", lifecycle: next };
        }
        case "ticket_materialize": {
          const repository = new GitClient(lifecycle.projectRoot);
          const ref = await repository.tryResolveRef(intent.ticketRef);
          if (ref === undefined) await repository.createRef(intent.ticketRef, intent.baseRunOid);
          else if (ref !== intent.baseRunOid) {
            return this.#preserveRecovery(
              lifecycle,
              intent,
              journal,
              "ticket ref differs from its leased run head",
            );
          }
          const registered = await this.#registeredWorktree(repository, intent.ticketWorktree);
          if (registered === undefined) {
            if (await pathExists(intent.ticketWorktree)) {
              return this.#preserveRecovery(
                lifecycle,
                intent,
                journal,
                "unregistered ticket path exists",
              );
            }
            await ensureOwnedDirectory(
              path.dirname(intent.ticketWorktree),
              lifecycle.commonDirectory,
            );
            await repository.addExistingBranchWorktree(
              intent.ticketWorktree,
              intent.ticketRef,
              `Koni ticket ${intent.ticketId} cycle ${intent.cycleId}`,
            );
          }
          const next = cloneLifecycle(lifecycle);
          if (next.ticketCycles[intent.cycleId] === undefined) {
            const ordinal =
              Object.values(next.ticketCycles).filter((cycle) => cycle.ticketId === intent.ticketId)
                .length + 1;
            next.ticketCycles[intent.cycleId] = {
              cycleId: intent.cycleId,
              ticketId: intent.ticketId,
              ordinal,
              status: "active",
              baseRunOid: intent.baseRunOid,
              branchRef: intent.ticketRef,
              worktree: intent.ticketWorktree,
              ticketHeadOid: intent.baseRunOid,
              integratedRunOid: undefined,
              squashCommitOid: undefined,
              createdAt: intent.preparedAt,
              integratedAt: undefined,
              retiredAt: undefined,
              blocker: undefined,
              ...(intent.templateContext === undefined
                ? {}
                : { templateContext: structuredClone(intent.templateContext) }),
            };
            next.ticketCycleOrder.push(intent.cycleId);
          }
          await this.#settle(journal, intent, next);
          return { status: "completed", lifecycle: next };
        }
        case "ticket_checkpoint": {
          const repository = new GitClient(lifecycle.projectRoot);
          const current = await repository.resolveRef(intent.ticketRef);
          if (current === intent.expectedTicketOid) {
            await repository.updateRef(
              intent.ticketRef,
              intent.candidateOid,
              intent.expectedTicketOid,
            );
          } else if (current !== intent.candidateOid) {
            return this.#preserveRecovery(
              lifecycle,
              intent,
              journal,
              "ticket ref moved during checkpoint recovery",
            );
          }
          const checkout = new GitClient(intent.ticketWorktree);
          if ((await checkout.statusEntries()).length !== 0) {
            return this.#preserveRecovery(
              lifecycle,
              intent,
              journal,
              "ticket checkpoint checkout is dirty",
            );
          }
          const next = cloneLifecycle(lifecycle);
          const cycle = requiredCycle(next, intent.cycleId);
          cycle.ticketHeadOid = intent.candidateOid;
          cycle.status = "candidate";
          cycle.blocker = undefined;
          await this.#settle(journal, intent, next);
          return { status: "completed", lifecycle: next };
        }
        case "ticket_publish": {
          const repository = new GitClient(lifecycle.projectRoot);
          const current = await repository.resolveRef(intent.runRef);
          if (current === intent.expectedRunOid) {
            await this.#assertCheckout({
              lifecycle,
              worktree: intent.runWorktree,
              headOid: current,
              branchRef: intent.runRef,
              requireClean: true,
              label: "run checkout",
            });
            await repository.updateRef(
              intent.runRef,
              intent.squashCommitOid,
              intent.expectedRunOid,
            );
          } else if (current !== intent.squashCommitOid) {
            return this.#preserveRecovery(
              lifecycle,
              intent,
              journal,
              "run ref moved during ticket publication",
            );
          }
          try {
            this.#fault("before_run_checkout_repair", intent);
            await repairAdvancedCheckout(
              new GitClient(intent.runWorktree),
              intent.expectedRunOid,
              intent.squashCommitOid,
            );
          } catch (error) {
            const compensation = await this.#forwardCompensatePublication(
              lifecycle,
              intent,
              journal,
              error,
            );
            return {
              status: "preserved",
              lifecycle: compensation.lifecycle,
              reason: compensation.reason,
            };
          }
          const next = cloneLifecycle(lifecycle);
          next.run.headOid = intent.squashCommitOid;
          next.targetSynchronization = undefined;
          next.promotion = undefined;
          const cycle = requiredCycle(next, intent.cycleId);
          cycle.status = "integrated";
          cycle.ticketHeadOid = intent.ticketOid;
          cycle.integratedRunOid = intent.squashCommitOid;
          cycle.squashCommitOid = intent.squashCommitOid;
          cycle.integratedAt ??= this.#timestamp();
          cycle.blocker = undefined;
          await this.#settle(journal, intent, next);
          return { status: "completed", lifecycle: next };
        }
        case "target_sync": {
          const repository = new GitClient(lifecycle.projectRoot);
          const [target, current] = await Promise.all([
            repository.resolveRef(lifecycle.target.ref),
            repository.resolveRef(intent.runRef),
          ]);
          if (current === intent.expectedRunOid) {
            if (target !== intent.observedTargetOid) {
              // No ref effect happened yet. Settle the obsolete intent without inventing a sync;
              // the stage driver will immediately issue a fresh sync against the new target OID.
              await this.#settle(journal, intent, lifecycle);
              return { status: "completed", lifecycle: cloneLifecycle(lifecycle) };
            }
            await this.#assertCheckout({
              lifecycle,
              worktree: intent.runWorktree,
              headOid: current,
              branchRef: intent.runRef,
              requireClean: true,
              label: "run checkout",
            });
            await repository.updateRef(
              intent.runRef,
              intent.synchronizedRunOid,
              intent.expectedRunOid,
            );
          } else if (current !== intent.synchronizedRunOid) {
            return this.#preserveRecovery(
              lifecycle,
              intent,
              journal,
              "run ref moved during target synchronization",
            );
          }
          try {
            this.#fault("before_target_sync_checkout_repair", intent);
            await repairAdvancedCheckout(
              new GitClient(intent.runWorktree),
              intent.expectedRunOid,
              intent.synchronizedRunOid,
            );
          } catch (error) {
            const compensation = await this.#forwardCompensatePublication(
              lifecycle,
              intent,
              journal,
              error,
            );
            return {
              status: "preserved",
              lifecycle: compensation.lifecycle,
              reason: compensation.reason,
            };
          }
          const next = cloneLifecycle(lifecycle);
          next.run.headOid = intent.synchronizedRunOid;
          next.targetSynchronization = {
            status: "synchronized",
            priorRunOid: intent.expectedRunOid,
            targetOid: intent.observedTargetOid,
            runOid: intent.synchronizedRunOid,
            synchronizedAt: intent.preparedAt,
            blocker: undefined,
          };
          next.promotion = undefined;
          await this.#settle(journal, intent, next);
          return { status: "completed", lifecycle: next };
        }
        case "target_publish": {
          const repository = new GitClient(lifecycle.projectRoot);
          const current = await repository.resolveRef(intent.targetRef);
          if (current === intent.expectedTargetOid) {
            await repository.updateRef(
              intent.targetRef,
              intent.candidateOid,
              intent.expectedTargetOid,
            );
          } else if (current !== intent.candidateOid) {
            return this.#preserveRecovery(
              lifecycle,
              intent,
              journal,
              "target ref moved during promotion recovery",
            );
          }
          if (intent.targetCheckout !== undefined) {
            try {
              this.#fault("before_target_checkout_repair", intent);
              await repairAdvancedCheckout(
                new GitClient(intent.targetCheckout),
                intent.expectedTargetOid,
                intent.candidateOid,
                true,
              );
            } catch (error) {
              const compensation = await this.#forwardCompensatePublication(
                lifecycle,
                intent,
                journal,
                error,
              );
              return {
                status: "preserved",
                lifecycle: compensation.lifecycle,
                reason: compensation.reason,
              };
            }
          }
          const next = cloneLifecycle(lifecycle);
          next.promotion = {
            status: "published",
            expectedTargetOid: intent.expectedTargetOid,
            runOid: intent.runOid,
            candidateOid: intent.candidateOid,
            targetCheckout: intent.targetCheckout,
            preparedAt: intent.preparedAt,
            publishedAt: this.#timestamp(),
            blocker: undefined,
          };
          await this.#settle(journal, intent, next);
          return { status: "completed", lifecycle: next };
        }
        case "forward_compensation": {
          const next = await this.#applyForwardCompensation(lifecycle, intent, journal);
          return { status: "completed", lifecycle: next.lifecycle };
        }
        case "ticket_supersede": {
          const cycle = requiredCycle(lifecycle, intent.cycleId);
          if (
            cycle.ticketId !== intent.ticketId ||
            cycle.branchRef !== intent.ticketRef ||
            cycle.worktree !== intent.ticketWorktree ||
            cycle.ticketHeadOid !== intent.expectedTicketOid ||
            intent.archiveRef !==
              supersessionArchiveRef(
                lifecycle.runId,
                cycle.ticketId,
                cycle.cycleId,
                intent.supersessionSha256,
              )
          ) {
            return this.#preserveRecovery(
              lifecycle,
              intent,
              journal,
              "ticket supersession intent disagrees with its durable cycle",
            );
          }
          const repository = new GitClient(lifecycle.projectRoot);
          let archivedOid = await repository.tryResolveRef(intent.archiveRef);
          let ticketOid = await repository.tryResolveRef(intent.ticketRef);
          if (archivedOid === undefined) {
            if (ticketOid !== intent.expectedTicketOid) {
              return this.#preserveRecovery(
                lifecycle,
                intent,
                journal,
                "ticket supersession has neither its exact source ref nor its archive",
              );
            }
            try {
              await repository.createRef(intent.archiveRef, intent.expectedTicketOid);
            } catch (error) {
              archivedOid = await repository.tryResolveRef(intent.archiveRef);
              if (archivedOid !== intent.expectedTicketOid) throw error;
            }
            archivedOid = intent.expectedTicketOid;
          }
          if (archivedOid !== intent.expectedTicketOid) {
            return this.#preserveRecovery(
              lifecycle,
              intent,
              journal,
              "ticket supersession archive points at another object",
            );
          }
          const registered = await this.#registeredWorktree(repository, intent.ticketWorktree);
          if (registered !== undefined) {
            try {
              await this.#assertCheckout({
                lifecycle,
                worktree: intent.ticketWorktree,
                headOid: intent.expectedTicketOid,
                branchRef: intent.ticketRef,
                requireClean: true,
                label: `ticket cycle ${intent.cycleId}`,
              });
            } catch (error) {
              return this.#preserveRecovery(lifecycle, intent, journal, errorMessage(error));
            }
            await repository.unlockWorktree(intent.ticketWorktree);
            await repository.removeWorktree(intent.ticketWorktree);
          } else if (await pathExists(intent.ticketWorktree)) {
            return this.#preserveRecovery(
              lifecycle,
              intent,
              journal,
              "unregistered ticket data remains during supersession",
            );
          }
          ticketOid = await repository.tryResolveRef(intent.ticketRef);
          if (ticketOid === intent.expectedTicketOid) {
            await repository.deleteRef(intent.ticketRef, ticketOid);
          } else if (ticketOid !== undefined) {
            return this.#preserveRecovery(
              lifecycle,
              intent,
              journal,
              "ticket ref moved before supersession retirement",
            );
          }
          const next = supersededTicketLifecycle(lifecycle, intent);
          await this.#settle(journal, intent, next);
          return { status: "completed", lifecycle: next };
        }
        case "ticket_retire": {
          const repository = new GitClient(lifecycle.projectRoot);
          const registered = await this.#registeredWorktree(repository, intent.ticketWorktree);
          if (registered !== undefined) {
            try {
              await this.#assertCheckout({
                lifecycle,
                worktree: intent.ticketWorktree,
                headOid: intent.expectedTicketOid,
                branchRef: intent.ticketRef,
                requireClean: true,
                label: `ticket cycle ${intent.cycleId}`,
              });
            } catch (error) {
              return this.#preserveRecovery(lifecycle, intent, journal, errorMessage(error));
            }
            await repository.unlockWorktree(intent.ticketWorktree);
            await repository.removeWorktree(intent.ticketWorktree);
          } else if (await pathExists(intent.ticketWorktree)) {
            return this.#preserveRecovery(
              lifecycle,
              intent,
              journal,
              "unregistered ticket data remains",
            );
          }
          const ref = await repository.tryResolveRef(intent.ticketRef);
          if (ref === intent.expectedTicketOid) await repository.deleteRef(intent.ticketRef, ref);
          else if (ref !== undefined) {
            return this.#preserveRecovery(
              lifecycle,
              intent,
              journal,
              "ticket ref moved before retirement",
            );
          }
          const next = cloneLifecycle(lifecycle);
          const cycle = requiredCycle(next, intent.cycleId);
          cycle.status = "retired";
          cycle.retiredAt ??= this.#timestamp();
          cycle.blocker = undefined;
          await this.#settle(journal, intent, next);
          return { status: "completed", lifecycle: next };
        }
        case "run_retire": {
          const repository = new GitClient(lifecycle.projectRoot);
          const registered = await this.#registeredWorktree(repository, intent.runWorktree);
          if (registered !== undefined) {
            try {
              await this.#assertCheckout({
                lifecycle,
                worktree: intent.runWorktree,
                headOid: intent.expectedRunOid,
                branchRef: intent.runRef,
                requireClean: true,
                label: "run checkout",
              });
            } catch (error) {
              return this.#preserveRecovery(lifecycle, intent, journal, errorMessage(error));
            }
            await repository.unlockWorktree(intent.runWorktree);
            await repository.removeWorktree(intent.runWorktree);
          } else if (await pathExists(intent.runWorktree)) {
            return this.#preserveRecovery(
              lifecycle,
              intent,
              journal,
              "unregistered run data remains",
            );
          }
          const ref = await repository.tryResolveRef(intent.runRef);
          if (ref === intent.expectedRunOid) await repository.deleteRef(intent.runRef, ref);
          else if (ref !== undefined) {
            return this.#preserveRecovery(
              lifecycle,
              intent,
              journal,
              "run ref moved before retirement",
            );
          }
          const next = cloneLifecycle(lifecycle);
          next.run.status = "retired";
          next.run.retiredAt ??= this.#timestamp();
          next.run.blocker = undefined;
          await this.#settle(journal, intent, next);
          return { status: "completed", lifecycle: next };
        }
        case "abandoned_run_retire": {
          await this.#assertAbandonedResources(lifecycle, intent);
          await this.#applyAbandonedRetirement(lifecycle, intent);
          const next = retiredAbandonedLifecycle(lifecycle, this.#timestamp());
          await this.#settle(journal, intent, next);
          return { status: "completed", lifecycle: next };
        }
        case "legacy_run_relocate":
        case "legacy_run_retire":
          throw invalidState(
            `legacy compatibility intent requires the legacy Git executor: ${intent.kind}`,
          );
      }
    } catch (error) {
      if (error instanceof GitLifecycleError) {
        return this.#preserveRecovery(lifecycle, intent, journal, error.message);
      }
      throw new GitLifecycleError("recovery_ambiguous", errorMessage(error));
    }
  }

  async #assertLifecycle(lifecycle: RunGitLifecycleRecord): Promise<void> {
    assertRunGitLifecycleRecord(lifecycle);
    assertNamespaceId(lifecycle.runId, "run ID");
    assertUserTargetRef(lifecycle.target.ref);
    const identity = await GitClient.discover(this.#projectRoot);
    const [actualRoot, expectedRoot, actualCommon, expectedCommon] = await Promise.all([
      realpath(identity.worktreeRoot),
      realpath(lifecycle.projectRoot),
      realpath(identity.commonDirectory),
      realpath(lifecycle.commonDirectory),
    ]);
    if (actualRoot !== expectedRoot || actualCommon !== expectedCommon) {
      throw new GitLifecycleError(
        "ownership_mismatch",
        "Git lifecycle belongs to another repository",
      );
    }
    const expected =
      lifecycle.policy === undefined
        ? legacyRunNamespace(actualCommon, lifecycle.runId)
        : persistedPolicyRunNamespace(
            actualCommon,
            lifecycle.policy,
            lifecycle.runTemplate!,
            lifecycle.namespace,
          );
    if (
      path.resolve(lifecycle.namespace.root) !== expected.root ||
      !isInside(expected.root, lifecycle.planning.worktree) ||
      !isInside(expected.root, lifecycle.run.worktree) ||
      !isInside(expected.root, lifecycle.namespace.ticketRoot)
    ) {
      throw new GitLifecycleError(
        "ownership_mismatch",
        "Git lifecycle paths escape the compiler namespace",
      );
    }
    if (
      lifecycle.namespace.runRef !== expected.runRef ||
      lifecycle.run.branchRef !== lifecycle.namespace.runRef
    ) {
      throw new GitLifecycleError(
        "ownership_mismatch",
        "run ref is outside its compiler namespace",
      );
    }
  }

  async #assertReadyRun(lifecycle: RunGitLifecycleRecord): Promise<void> {
    await this.#assertLifecycle(lifecycle);
    if (lifecycle.run.status !== "ready" || lifecycle.run.headOid === undefined) {
      throw invalidState(`run checkout is ${lifecycle.run.status}`);
    }
  }

  async #assertCheckout(input: {
    lifecycle: RunGitLifecycleRecord;
    worktree: string;
    headOid: string;
    branchRef: string | undefined;
    requireClean: boolean;
    label: string;
  }): Promise<void> {
    if (!isInside(input.lifecycle.namespace.root, input.worktree)) {
      throw new GitLifecycleError("ownership_mismatch", `${input.label} escapes the run namespace`);
    }
    const repository = new GitClient(input.lifecycle.projectRoot);
    const registered = await this.#registeredWorktree(repository, input.worktree);
    if (registered === undefined) {
      throw new GitLifecycleError(
        "ownership_mismatch",
        `${input.label} is not a registered worktree`,
      );
    }
    if (registered.head !== input.headOid || registered.branch !== input.branchRef) {
      throw new GitLifecycleError(
        "ownership_mismatch",
        `${input.label} identity differs from its compiler record`,
        { registered, expectedHead: input.headOid, expectedBranch: input.branchRef },
      );
    }
    const discovered = await GitClient.discover(input.worktree);
    if (
      (await realpath(discovered.commonDirectory)) !==
      (await realpath(input.lifecycle.commonDirectory))
    ) {
      throw new GitLifecycleError(
        "ownership_mismatch",
        `${input.label} belongs to another repository`,
      );
    }
    const worktreeStat = await lstat(input.worktree);
    const [realNamespace, realWorktree] = await Promise.all([
      realpath(input.lifecycle.namespace.root),
      realpath(input.worktree),
    ]);
    if (worktreeStat.isSymbolicLink() || !isInside(realNamespace, realWorktree)) {
      throw new GitLifecycleError(
        "ownership_mismatch",
        `${input.label} resolves outside its namespace`,
      );
    }
    if (input.requireClean && (await new GitClient(input.worktree).statusEntries()).length !== 0) {
      throw dirtyCheckout(input.label, input.worktree);
    }
  }

  async #registeredWorktree(repository: GitClient, expectedPath: string) {
    const normalized = path.resolve(expectedPath);
    return (await repository.worktrees()).find((entry) => path.resolve(entry.path) === normalized);
  }

  async #retirePlanningCheckout(
    lifecycle: RunGitLifecycleRecord,
    _intent: Extract<GitLifecycleIntent, { kind: "run_materialize" }>,
  ): Promise<void> {
    const repository = new GitClient(lifecycle.projectRoot);
    const registered = await this.#registeredWorktree(repository, lifecycle.planning.worktree);
    if (registered === undefined) {
      if (await pathExists(lifecycle.planning.worktree)) {
        throw new GitLifecycleError(
          "ownership_mismatch",
          "unregistered planning data cannot be removed",
        );
      }
      return;
    }
    await this.#assertCheckout({
      lifecycle,
      worktree: lifecycle.planning.worktree,
      headOid: lifecycle.planning.baseOid,
      branchRef: undefined,
      requireClean: true,
      label: "planning checkout",
    });
    await repository.unlockWorktree(lifecycle.planning.worktree);
    await repository.removeWorktree(lifecycle.planning.worktree);
  }

  async #abandonedResources(
    lifecycle: RunGitLifecycleRecord,
  ): Promise<
    Omit<
      Extract<GitLifecycleIntent, { kind: "abandoned_run_retire" }>,
      keyof GitIntentBase | "kind"
    >
  > {
    return {
      planning:
        lifecycle.planning.status === "planned" || lifecycle.planning.status === "retired"
          ? undefined
          : { baseOid: lifecycle.planning.baseOid, worktree: lifecycle.planning.worktree },
      run:
        lifecycle.run.status === "unmaterialized" || lifecycle.run.status === "retired"
          ? undefined
          : lifecycle.run.headOid === undefined
            ? undefined
            : {
                expectedOid: lifecycle.run.headOid,
                ref: lifecycle.run.branchRef,
                worktree: lifecycle.run.worktree,
              },
      tickets: lifecycle.ticketCycleOrder
        .map((cycleId) => lifecycle.ticketCycles[cycleId]!)
        .filter((cycle) => cycle.status !== "retired")
        .map((cycle) => ({
          cycleId: cycle.cycleId,
          expectedOid: cycle.ticketHeadOid,
          ref: cycle.branchRef,
          worktree: cycle.worktree,
        })),
    };
  }

  async #inspectAbandonedResource(
    lifecycle: RunGitLifecycleRecord,
    input: {
      kind: AbandonedRunResourceKind;
      id: string;
      expectedOid: string;
      ref: string | undefined;
      worktree: string;
    },
  ): Promise<AbandonedRunResourceInspection> {
    const repository = new GitClient(lifecycle.projectRoot);
    const warnings: string[] = [];
    let observedRefOid: string | undefined;
    let refState: AbandonedRunRefState = input.ref === undefined ? "not_applicable" : "unreadable";
    if (input.ref !== undefined) {
      try {
        observedRefOid = await repository.tryResolveRef(input.ref);
        refState =
          observedRefOid === undefined
            ? "absent"
            : observedRefOid === input.expectedOid
              ? "matches"
              : "moved";
        if (refState === "moved") {
          warnings.push("recorded ref no longer points at its compiler-issued OID");
        }
      } catch (error) {
        warnings.push(`ref could not be inspected: ${errorMessage(error).slice(0, 1_024)}`);
      }
    }

    let registered = false;
    let worktreeState: AbandonedRunWorktreeState = "unreadable";
    let dirtyPaths: string[] = [];
    try {
      const entry = await this.#registeredWorktree(repository, input.worktree);
      registered = entry !== undefined;
      if (entry === undefined) {
        if (await pathExists(input.worktree)) {
          worktreeState = "unregistered_present";
          warnings.push("data exists at the recorded path but is not a registered Git worktree");
        } else {
          worktreeState = "absent";
        }
      } else if (input.ref !== undefined && refState !== "matches") {
        worktreeState = "ownership_mismatch";
        warnings.push("registered worktree does not have its matching recorded ref");
      } else {
        try {
          await this.#assertCheckout({
            lifecycle,
            worktree: input.worktree,
            headOid: input.expectedOid,
            branchRef: input.ref,
            requireClean: false,
            label: `abandoned ${input.kind} ${input.id}`,
          });
          const statuses = await new GitClient(input.worktree).statusEntries();
          dirtyPaths = [
            ...new Set(
              statuses.flatMap((entry) =>
                entry.originalPath === undefined ? [entry.path] : [entry.path, entry.originalPath],
              ),
            ),
          ].sort();
          worktreeState = dirtyPaths.length === 0 ? "owned_clean" : "owned_dirty";
          if (dirtyPaths.length > 0) warnings.push("worktree has uncommitted changes");
        } catch (error) {
          worktreeState =
            error instanceof GitLifecycleError && error.code === "dirty_checkout"
              ? "owned_dirty"
              : "ownership_mismatch";
          warnings.push(
            `worktree ownership could not be proven: ${errorMessage(error).slice(0, 1_024)}`,
          );
        }
      }
    } catch (error) {
      warnings.push(`worktree could not be inspected: ${errorMessage(error).slice(0, 1_024)}`);
    }

    const refSafe =
      refState === "not_applicable" || refState === "absent" || refState === "matches";
    const worktreeSafe = worktreeState === "absent" || worktreeState === "owned_clean";
    return {
      kind: input.kind,
      id: input.id,
      expectedOid: input.expectedOid,
      ref: input.ref,
      worktree: input.worktree,
      refState,
      observedRefOid,
      worktreeState,
      registered,
      dirtyPaths,
      safeToDelete: refSafe && worktreeSafe,
      warnings,
    };
  }

  async #assertAbandonedResources(
    lifecycle: RunGitLifecycleRecord,
    resources: Pick<
      Extract<GitLifecycleIntent, { kind: "abandoned_run_retire" }>,
      "planning" | "run" | "tickets"
    >,
  ): Promise<void> {
    const repository = new GitClient(lifecycle.projectRoot);
    for (const ticket of resources.tickets) {
      const recorded = lifecycle.ticketCycles[ticket.cycleId];
      if (
        recorded === undefined ||
        recorded.branchRef !== ticket.ref ||
        recorded.worktree !== ticket.worktree ||
        recorded.ticketHeadOid !== ticket.expectedOid
      ) {
        throw new GitLifecycleError(
          "ownership_mismatch",
          `abandoned ticket ${ticket.cycleId} changed identity`,
        );
      }
      await this.#assertAbandonedBranchResource(
        lifecycle,
        repository,
        ticket.ref,
        ticket.expectedOid,
        ticket.worktree,
        `abandoned ticket ${ticket.cycleId}`,
      );
    }
    if (resources.planning !== undefined) {
      const registered = await this.#registeredWorktree(repository, resources.planning.worktree);
      if (registered !== undefined) {
        await this.#assertCheckout({
          lifecycle,
          worktree: resources.planning.worktree,
          headOid: resources.planning.baseOid,
          branchRef: undefined,
          requireClean: true,
          label: "abandoned planning checkout",
        });
      } else if (await pathExists(resources.planning.worktree)) {
        throw new GitLifecycleError(
          "ownership_mismatch",
          "unregistered planning data must be preserved",
        );
      }
    }
    if (resources.run !== undefined) {
      await this.#assertAbandonedBranchResource(
        lifecycle,
        repository,
        resources.run.ref,
        resources.run.expectedOid,
        resources.run.worktree,
        "abandoned run checkout",
      );
    }
  }

  async #assertAbandonedBranchResource(
    lifecycle: RunGitLifecycleRecord,
    repository: GitClient,
    reference: string,
    expectedOid: string,
    worktree: string,
    label: string,
  ): Promise<void> {
    const ref = await repository.tryResolveRef(reference);
    if (ref !== undefined && ref !== expectedOid) {
      throw refMoved(`${label} ref moved`, expectedOid, ref);
    }
    const registered = await this.#registeredWorktree(repository, worktree);
    if (registered !== undefined) {
      if (ref === undefined) {
        throw new GitLifecycleError(
          "ownership_mismatch",
          `${label} is registered without its recorded ref`,
        );
      }
      await this.#assertCheckout({
        lifecycle,
        worktree,
        headOid: expectedOid,
        branchRef: reference,
        requireClean: true,
        label,
      });
    } else if (await pathExists(worktree)) {
      throw new GitLifecycleError(
        "ownership_mismatch",
        `unregistered ${label} data must be preserved`,
      );
    }
  }

  async #applyAbandonedRetirement(
    lifecycle: RunGitLifecycleRecord,
    intent: Extract<GitLifecycleIntent, { kind: "abandoned_run_retire" }>,
  ): Promise<void> {
    // Recheck every resource immediately before the first deletion so a
    // newly dirty sibling cannot cause partial cleanup.
    await this.#assertAbandonedResources(lifecycle, intent);
    const repository = new GitClient(lifecycle.projectRoot);
    for (const resource of intent.tickets) {
      if ((await this.#registeredWorktree(repository, resource.worktree)) !== undefined) {
        await repository.unlockWorktree(resource.worktree);
        await repository.removeWorktree(resource.worktree);
      }
    }
    if (
      intent.planning !== undefined &&
      (await this.#registeredWorktree(repository, intent.planning.worktree)) !== undefined
    ) {
      await repository.unlockWorktree(intent.planning.worktree);
      await repository.removeWorktree(intent.planning.worktree);
    }
    if (
      intent.run !== undefined &&
      (await this.#registeredWorktree(repository, intent.run.worktree)) !== undefined
    ) {
      await repository.unlockWorktree(intent.run.worktree);
      await repository.removeWorktree(intent.run.worktree);
    }
    this.#fault("after_abandoned_worktrees_retired", intent);
    for (const resource of intent.tickets) {
      const oid = await repository.tryResolveRef(resource.ref);
      if (oid === resource.expectedOid) await repository.deleteRef(resource.ref, oid);
      else if (oid !== undefined)
        throw refMoved("abandoned ticket ref moved", resource.expectedOid, oid);
    }
    if (intent.run !== undefined) {
      const oid = await repository.tryResolveRef(intent.run.ref);
      if (oid === intent.run.expectedOid) await repository.deleteRef(intent.run.ref, oid);
      else if (oid !== undefined)
        throw refMoved("abandoned run ref moved", intent.run.expectedOid, oid);
    }
    this.#fault("after_abandoned_refs_retired", intent);
  }

  async #forwardCompensatePublication(
    lifecycle: RunGitLifecycleRecord,
    original: Extract<
      GitLifecycleIntent,
      { kind: "ticket_publish" | "target_sync" | "target_publish" }
    >,
    journal: GitIntentJournal,
    cause: unknown,
  ): Promise<{
    compensated: boolean;
    lifecycle: RunGitLifecycleRecord;
    reason: string;
    compensationOid?: string;
  }> {
    const priorOid =
      original.kind === "ticket_publish" || original.kind === "target_sync"
        ? original.expectedRunOid
        : original.expectedTargetOid;
    const candidateOid =
      original.kind === "ticket_publish"
        ? original.squashCommitOid
        : original.kind === "target_sync"
          ? original.synchronizedRunOid
          : original.candidateOid;
    const reference =
      original.kind === "ticket_publish" || original.kind === "target_sync"
        ? original.runRef
        : original.targetRef;
    const checkout =
      original.kind === "ticket_publish" || original.kind === "target_sync"
        ? original.runWorktree
        : original.targetCheckout;
    const repairError = errorMessage(cause).slice(0, 4_096);
    const failureReason = `checkout repair failed after ${reference} advanced to ${candidateOid}: ${repairError}`;
    const failureLifecycle = failedPublicationLifecycle(
      lifecycle,
      original,
      candidateOid,
      failureReason,
    );
    const evidence: GitCompensationEvidence = {
      originalIntentId: original.id,
      priorOid,
      candidateOid,
    };

    if (checkout !== undefined) {
      try {
        await assertCheckoutProvesPriorTree(new GitClient(checkout), priorOid, candidateOid);
      } catch (error) {
        const reason = `${failureReason}; compensation refused because checkout state is ambiguous: ${errorMessage(error)}`;
        const preserved = failedPublicationLifecycle(lifecycle, original, candidateOid, reason);
        await journal.settle(original.id, {
          status: "blocked",
          settledAt: this.#timestamp(),
          lifecycle: preserved,
          reason,
          compensation: evidence,
        });
        return { compensated: false, lifecycle: preserved, reason };
      }
    }

    const compensation: Extract<GitLifecycleIntent, { kind: "forward_compensation" }> = {
      protocol: GIT_INTENT_PROTOCOL,
      id: `${original.id}:forward-compensation`,
      runId: original.runId,
      projectRoot: original.projectRoot,
      commonDirectory: original.commonDirectory,
      preparedAt: this.#timestamp(),
      kind: "forward_compensation",
      originalIntentId: original.id,
      originalKind: original.kind,
      priorOid,
      candidateOid,
      reference,
      checkout,
      cycleId: original.kind === "ticket_publish" ? original.cycleId : undefined,
      ...(original.kind === "target_sync" ? { observedTargetOid: original.observedTargetOid } : {}),
      repairError,
      identity: { name: this.#identity.name, email: this.#identity.email },
    };
    await journal.supersedeWithCompensation(
      original.id,
      {
        status: "blocked",
        settledAt: compensation.preparedAt,
        lifecycle: failureLifecycle,
        reason: failureReason,
        compensation: evidence,
      },
      compensation,
    );
    let applied: { lifecycle: RunGitLifecycleRecord; compensationOid: string };
    try {
      applied = await this.#applyForwardCompensation(failureLifecycle, compensation, journal);
    } catch (error) {
      if (!(error instanceof GitLifecycleError)) throw error;
      const reason = `${failureReason}; forward compensation was preserved: ${error.message}`;
      const preserved = await this.#preserveRecovery(
        failureLifecycle,
        compensation,
        journal,
        reason,
      );
      return {
        compensated: false,
        lifecycle: preserved.lifecycle,
        reason,
      };
    }
    return {
      compensated: true,
      lifecycle: applied.lifecycle,
      reason: `checkout repair failed; ${reference} advanced through an auditable compensation commit`,
      compensationOid: applied.compensationOid,
    };
  }

  async #applyForwardCompensation(
    lifecycle: RunGitLifecycleRecord,
    intent: Extract<GitLifecycleIntent, { kind: "forward_compensation" }>,
    journal: GitIntentJournal,
  ): Promise<{ lifecycle: RunGitLifecycleRecord; compensationOid: string }> {
    const repository = new GitClient(lifecycle.projectRoot);
    const priorTree = await repository.treeOfCommit(intent.priorOid);
    const compensationOid = await repository.commitTree(
      priorTree,
      [intent.candidateOid],
      commitMessage("koni: compensate failed publication", undefined, {
        "Koni-Run": lifecycle.runId,
        "Koni-Compensates": intent.originalIntentId,
        "Koni-Prior": intent.priorOid,
        "Koni-Candidate": intent.candidateOid,
      }),
      { ...intent.identity, timestamp: intent.preparedAt },
    );
    const current = await repository.resolveRef(intent.reference);
    if (current === intent.candidateOid) {
      if (intent.checkout !== undefined) {
        await assertCheckoutProvesPriorTree(
          new GitClient(intent.checkout),
          intent.priorOid,
          intent.candidateOid,
        );
      }
      try {
        await repository.updateRef(intent.reference, compensationOid, intent.candidateOid);
      } catch (error) {
        throw translateCasError(
          error,
          `ref moved during compensation of ${intent.originalIntentId}`,
        );
      }
      this.#fault("after_forward_compensation_ref", intent);
    } else if (current !== compensationOid) {
      throw refMoved(
        `ref moved during compensation of ${intent.originalIntentId}`,
        intent.candidateOid,
        current,
      );
    }
    if (intent.checkout !== undefined) {
      await assertCompensatedCheckout(new GitClient(intent.checkout), compensationOid, priorTree);
      this.#fault("after_forward_compensation_checkout", intent);
    }
    const reason = `publication ${intent.originalIntentId} was preserved by forward compensation ${compensationOid}`;
    const next = compensatedPublicationLifecycle(lifecycle, intent, compensationOid, reason);
    await journal.settle(intent.id, {
      status: "completed",
      settledAt: this.#timestamp(),
      lifecycle: next,
      reason,
      compensation: {
        originalIntentId: intent.originalIntentId,
        priorOid: intent.priorOid,
        candidateOid: intent.candidateOid,
        compensationOid,
      },
    });
    return { lifecycle: next, compensationOid };
  }

  #intentBase(lifecycle: RunGitLifecycleRecord, preparedAt = this.#timestamp()): GitIntentBase {
    return {
      protocol: GIT_INTENT_PROTOCOL,
      id: `git-${this.#createId()}`,
      runId: lifecycle.runId,
      projectRoot: lifecycle.projectRoot,
      commonDirectory: lifecycle.commonDirectory,
      preparedAt,
    };
  }

  #assertIntent(lifecycle: RunGitLifecycleRecord, intent: GitLifecycleIntent): void {
    if (
      intent.protocol !== GIT_INTENT_PROTOCOL ||
      intent.runId !== lifecycle.runId ||
      path.resolve(intent.projectRoot) !== path.resolve(lifecycle.projectRoot) ||
      path.resolve(intent.commonDirectory) !== path.resolve(lifecycle.commonDirectory)
    ) {
      throw new GitLifecycleError(
        "ownership_mismatch",
        "Git intent does not belong to this run authority",
      );
    }
  }

  async #settle(
    journal: GitIntentJournal,
    intent: GitLifecycleIntent,
    lifecycle: RunGitLifecycleRecord,
  ): Promise<void> {
    await journal.settle(intent.id, {
      status: "completed",
      settledAt: this.#timestamp(),
      lifecycle: cloneLifecycle(lifecycle),
    });
  }

  async #preserveRecovery(
    lifecycle: RunGitLifecycleRecord,
    intent: GitLifecycleIntent,
    journal: GitIntentJournal,
    reason: string,
  ): Promise<GitRecoveryResult> {
    let next = cloneLifecycle(lifecycle);
    if (
      "cycleId" in intent &&
      intent.cycleId !== undefined &&
      next.ticketCycles[intent.cycleId] !== undefined
    ) {
      next.ticketCycles[intent.cycleId]!.status = "preserved";
      next.ticketCycles[intent.cycleId]!.blocker = reason;
    } else if (intent.kind === "planning_create") {
      next.planning.status = "preserved";
      next.planning.blocker = reason;
    } else if (intent.kind === "run_materialize" || intent.kind === "run_retire") {
      next.run.status = "preserved";
      next.run.blocker = reason;
    } else if (intent.kind === "target_sync") {
      next.run.status = "preserved";
      next.run.blocker = reason;
      next.targetSynchronization = {
        status: "preserved",
        priorRunOid: intent.expectedRunOid,
        targetOid: intent.observedTargetOid,
        runOid: intent.synchronizedRunOid,
        synchronizedAt: intent.preparedAt,
        blocker: reason,
      };
    } else if (intent.kind === "target_publish" && next.promotion !== undefined) {
      next.promotion.status = "preserved";
      next.promotion.blocker = reason;
    } else if (intent.kind === "abandoned_run_retire") {
      next = preserveAbandonedLifecycle(lifecycle, reason);
    }
    await journal.settle(intent.id, {
      status: "blocked",
      settledAt: this.#timestamp(),
      lifecycle: next,
      reason,
    });
    return { status: "preserved", lifecycle: next, reason };
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }

  #fault(point: GitEffectFaultPoint, intent: GitLifecycleIntent): void {
    this.#effectFault?.(point, intent);
  }
}

function cloneLifecycle(lifecycle: RunGitLifecycleRecord): RunGitLifecycleRecord {
  return structuredClone(lifecycle);
}

function supersededTicketLifecycle(
  lifecycle: RunGitLifecycleRecord,
  intent: Extract<GitLifecycleIntent, { kind: "ticket_supersede" }>,
): RunGitLifecycleRecord {
  const next = cloneLifecycle(lifecycle);
  const cycle = requiredCycle(next, intent.cycleId);
  cycle.status = "retired";
  cycle.ticketHeadOid = intent.expectedTicketOid;
  cycle.retiredAt = intent.preparedAt;
  cycle.blocker = undefined;
  cycle.archiveRef = intent.archiveRef;
  cycle.supersessionSha256 = intent.supersessionSha256;
  cycle.supersededAt = intent.preparedAt;
  return next;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSha256Value(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function supersessionArchiveRef(
  runId: string,
  ticketId: string,
  cycleId: string,
  supersessionSha256: string,
): string {
  assertNamespaceId(runId, "run ID");
  assertNamespaceId(ticketId, "ticket ID");
  assertNamespaceId(cycleId, "ticket cycle ID");
  if (!isSha256Value(supersessionSha256)) {
    throw new Error("ticket supersession authority hash is invalid");
  }
  return `refs/koni/archive/${runId}/tickets/${ticketId}/cycles/${cycleId}/${supersessionSha256.slice("sha256:".length)}`;
}

function assertOidValue(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{40,64}$/u.test(value)) {
    throw new Error(`${label} is not a valid Git object ID`);
  }
}

function assertOptionalStrings(value: Record<string, unknown>, fields: readonly string[]): void {
  for (const field of fields) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      throw new Error(`${field} must be a string when present`);
    }
  }
}

function requiredCycle(lifecycle: RunGitLifecycleRecord, cycleId: string): TicketGitCycleRecord {
  const cycle = lifecycle.ticketCycles[cycleId];
  if (cycle === undefined) throw invalidState(`unknown ticket cycle: ${cycleId}`);
  return cycle;
}

function preserveCycle(
  lifecycle: RunGitLifecycleRecord,
  cycleId: string,
  reason: string,
): RunGitLifecycleRecord {
  const next = cloneLifecycle(lifecycle);
  const cycle = requiredCycle(next, cycleId);
  cycle.status = "preserved";
  cycle.blocker = reason;
  return next;
}

function preserveAbandonedLifecycle(
  lifecycle: RunGitLifecycleRecord,
  reason: string,
): RunGitLifecycleRecord {
  const next = cloneLifecycle(lifecycle);
  if (next.planning.status !== "retired") {
    next.planning.status = "preserved";
    next.planning.blocker = reason;
  }
  if (next.run.status !== "retired") {
    next.run.status = "preserved";
    next.run.blocker = reason;
  }
  for (const cycle of Object.values(next.ticketCycles)) {
    if (cycle.status === "retired") continue;
    cycle.status = "preserved";
    cycle.blocker = reason;
  }
  return next;
}

function retiredAbandonedLifecycle(
  lifecycle: RunGitLifecycleRecord,
  retiredAt: string,
): RunGitLifecycleRecord {
  const next = cloneLifecycle(lifecycle);
  next.planning.status = "retired";
  next.planning.retiredAt ??= retiredAt;
  next.planning.blocker = undefined;
  next.run.status = "retired";
  next.run.retiredAt ??= retiredAt;
  next.run.blocker = undefined;
  for (const cycle of Object.values(next.ticketCycles)) {
    cycle.status = "retired";
    cycle.retiredAt ??= retiredAt;
    cycle.blocker = undefined;
  }
  return next;
}

function assertAcceptedScope(inspection: GitPathScopeInspection, cycleId: string): void {
  if (inspection.accepted) return;
  throw new GitLifecycleError(
    "scope_violation",
    `ticket cycle ${cycleId} changed unauthorized paths`,
    {
      outOfScopePaths: inspection.outOfScopePaths,
      compilerOwnedPaths: inspection.compilerOwnedPaths,
      changedPaths: inspection.changedPaths,
    },
  );
}

async function conflictReport(
  repository: GitClient,
  runOid: string,
  candidateOid: string,
  merge: GitTreeMergeResult,
): Promise<GitConflictReport> {
  let baseOid: string;
  try {
    baseOid = await repository.mergeBase(runOid, candidateOid);
  } catch {
    baseOid = "0".repeat(runOid.length);
  }
  return {
    baseOid,
    runOid,
    candidateOid,
    paths: [...merge.conflictPaths].sort(),
    message: merge.messages || "Git tree composition requires integration work",
  };
}

function failedPublicationLifecycle(
  lifecycle: RunGitLifecycleRecord,
  intent: Extract<
    GitLifecycleIntent,
    { kind: "ticket_publish" | "target_sync" | "target_publish" }
  >,
  candidateOid: string,
  reason: string,
): RunGitLifecycleRecord {
  const next = cloneLifecycle(lifecycle);
  if (intent.kind === "ticket_publish") {
    next.run.status = "preserved";
    next.run.headOid = candidateOid;
    next.run.blocker = reason;
    const cycle = requiredCycle(next, intent.cycleId);
    cycle.status = "preserved";
    cycle.squashCommitOid = candidateOid;
    cycle.blocker = reason;
  } else if (intent.kind === "target_sync") {
    next.run.status = "preserved";
    next.run.headOid = candidateOid;
    next.run.blocker = reason;
    next.targetSynchronization = {
      status: "preserved",
      priorRunOid: intent.expectedRunOid,
      targetOid: intent.observedTargetOid,
      runOid: candidateOid,
      synchronizedAt: intent.preparedAt,
      blocker: reason,
    };
  } else if (next.promotion !== undefined) {
    next.promotion.status = "preserved";
    next.promotion.blocker = reason;
  }
  return next;
}

function compensatedPublicationLifecycle(
  lifecycle: RunGitLifecycleRecord,
  intent: Extract<GitLifecycleIntent, { kind: "forward_compensation" }>,
  compensationOid: string,
  reason: string,
): RunGitLifecycleRecord {
  const next = cloneLifecycle(lifecycle);
  if (intent.originalKind === "ticket_publish") {
    next.run.status = "preserved";
    next.run.headOid = compensationOid;
    next.run.blocker = reason;
    if (intent.cycleId === undefined) {
      throw invalidState("ticket publication compensation has no cycle ID");
    }
    const cycle = requiredCycle(next, intent.cycleId);
    cycle.status = "preserved";
    cycle.squashCommitOid = intent.candidateOid;
    cycle.blocker = reason;
  } else if (intent.originalKind === "target_sync") {
    next.run.status = "preserved";
    next.run.headOid = compensationOid;
    next.run.blocker = reason;
    next.targetSynchronization = {
      status: "preserved",
      priorRunOid: intent.priorOid,
      targetOid:
        intent.observedTargetOid ?? lifecycle.targetSynchronization?.targetOid ?? intent.priorOid,
      runOid: compensationOid,
      synchronizedAt: intent.preparedAt,
      blocker: reason,
    };
  } else if (next.promotion !== undefined) {
    next.promotion.status = "preserved";
    next.promotion.blocker = reason;
  }
  return next;
}

async function repairAdvancedCheckout(
  checkout: GitClient,
  priorOid: string,
  advancedOid: string,
  allowDirtyOnAdvancedIndex = false,
): Promise<void> {
  const head = await checkout.resolveRef("HEAD");
  if (head !== advancedOid) {
    throw new GitLifecycleError(
      "recovery_ambiguous",
      `checkout HEAD is ${head}, expected advanced ref ${advancedOid}`,
    );
  }
  const entries = await checkout.statusEntries();
  if (entries.length === 0) return;
  const [indexTree, priorTree, advancedTree, matchesIndex, untracked] = await Promise.all([
    checkout.indexTree(),
    checkout.treeOfCommit(priorOid),
    checkout.treeOfCommit(advancedOid),
    checkout.worktreeMatchesIndex(),
    checkout.untrackedPaths(),
  ]);
  if (allowDirtyOnAdvancedIndex && indexTree === advancedTree) {
    // The target checkout was already synchronized before the operator added
    // new work. Publication is complete; leave that new work untouched.
    return;
  }
  if (indexTree !== priorTree || !matchesIndex || untracked.length > 0) {
    throw new GitLifecycleError(
      "recovery_ambiguous",
      "checkout contains work beyond the proven pre-publication tree; preserving it",
      { indexTree, priorTree, matchesIndex, untracked },
    );
  }
  await checkout.resetHard(advancedOid);
  if ((await checkout.statusEntries()).length !== 0) {
    throw new GitLifecycleError("recovery_ambiguous", "checkout remained dirty after exact repair");
  }
}

async function assertCheckoutProvesPriorTree(
  checkout: GitClient,
  priorOid: string,
  candidateOid: string,
): Promise<void> {
  const head = await checkout.resolveRef("HEAD");
  if (head !== candidateOid) {
    throw new GitLifecycleError(
      "recovery_ambiguous",
      `checkout HEAD is ${head}, expected failed candidate ${candidateOid}`,
    );
  }
  const [indexTree, priorTree, matchesIndex, untracked] = await Promise.all([
    checkout.indexTree(),
    checkout.treeOfCommit(priorOid),
    checkout.worktreeMatchesIndex(),
    checkout.untrackedPaths(),
  ]);
  if (indexTree !== priorTree || !matchesIndex || untracked.length > 0) {
    throw new GitLifecycleError(
      "recovery_ambiguous",
      "checkout contains work beyond the exact pre-publication tree",
      { indexTree, priorTree, matchesIndex, untracked },
    );
  }
}

async function assertCompensatedCheckout(
  checkout: GitClient,
  compensationOid: string,
  priorTree: string,
): Promise<void> {
  const [head, indexTree, matchesIndex, untracked] = await Promise.all([
    checkout.resolveRef("HEAD"),
    checkout.indexTree(),
    checkout.worktreeMatchesIndex(),
    checkout.untrackedPaths(),
  ]);
  if (
    head !== compensationOid ||
    indexTree !== priorTree ||
    !matchesIndex ||
    untracked.length > 0
  ) {
    throw new GitLifecycleError(
      "recovery_ambiguous",
      "checkout contains work beyond the exact compensated tree; preserving it without reset",
      { head, compensationOid, indexTree, priorTree, matchesIndex, untracked },
    );
  }
}

async function uniqueCheckoutForRef(
  repository: GitClient,
  reference: string,
): Promise<string | undefined> {
  const matches = (await repository.worktrees()).filter((entry) => entry.branch === reference);
  if (matches.length > 1) {
    throw new GitLifecycleError(
      "ownership_mismatch",
      `target ref ${reference} is checked out more than once`,
      { paths: matches.map((entry) => entry.path) },
    );
  }
  return matches[0]?.path;
}

function commitMessage(
  subject: string,
  body: string | undefined,
  trailers: Readonly<Record<string, string>>,
): string {
  assertCommitSubject(subject);
  if (body?.includes("\0")) throw new Error("commit body contains NUL");
  const sections = [subject.trim()];
  if (body?.trim()) sections.push(body.trim());
  sections.push(
    Object.entries(trailers)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([token, value]) => {
        if (!/^[A-Za-z0-9-]+$/u.test(token) || /[\0\r\n]/u.test(value)) {
          throw new Error("commit trailer is malformed");
        }
        return `${token}: ${value.trim()}`;
      })
      .join("\n"),
  );
  return `${sections.join("\n\n")}\n`;
}

function assertCommitSubject(value: string): void {
  if (value.trim().length === 0 || value.length > 8 * 1024 || /[\0\r\n]/u.test(value)) {
    throw new Error("commit subject must be one bounded non-empty line");
  }
}

function assertNamespaceId(value: string, label: string): void {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u.test(value) ||
    value.includes("..") ||
    value.endsWith(".") ||
    value.endsWith(".lock")
  ) {
    throw new Error(`${label} is not safe for a compiler-owned Git namespace: ${value}`);
  }
}

/**
 * How a run acquires its target branch when the branch does not already exist. Absent (or
 * `create: false`), a missing target is a hard error — this preserves typo safety, since a
 * mistyped `--target` must not silently manufacture a branch. `baseRef` names the commit the
 * new branch starts from; when omitted it defaults to the launch checkout's current branch.
 */
export interface TargetProvisioning {
  create: boolean;
  baseRef?: string;
}

function shortTargetBranch(ref: string): string {
  return ref.replace(/^refs\/heads\//u, "");
}

/**
 * Resolve the commit a newly provisioned target branch should start from. An explicit base must
 * exist; the implicit default is the launch checkout's current branch (like `git checkout -b`),
 * falling back to the most recently committed branch when HEAD is detached.
 */
async function resolveNewTargetBase(client: GitClient, baseRef?: string): Promise<string> {
  if (baseRef !== undefined) {
    const oid = await client.tryResolveRef(baseRef);
    if (oid === undefined) {
      throw new GitLifecycleError(
        "base_unresolved",
        `base ref for the new target does not exist: ${baseRef}`,
        { baseRef },
      );
    }
    return oid;
  }
  const head = await client.symbolicHead();
  if (head !== undefined) {
    const oid = await client.tryResolveRef(head);
    if (oid !== undefined) return oid;
  }
  const [recent] = await client.recentBranches(1);
  if (recent !== undefined) return recent.oid;
  throw new GitLifecycleError(
    "base_unresolved",
    "cannot determine a base commit for the new target branch; pass an explicit --from <ref>",
  );
}

function assertUserTargetRef(value: string): void {
  if (
    !value.startsWith("refs/heads/") ||
    value.length > 1_024 ||
    /[\u0000-\u0020~^:?*\\[\]]/u.test(value)
  ) {
    throw new Error(`target must be a safe local branch ref: ${value}`);
  }
  const branch = value.slice("refs/heads/".length);
  if (
    branch.includes("..") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch
      .split("/")
      .some(
        (component) => component.length === 0 || component === "." || component.endsWith(".lock"),
      )
  ) {
    throw new Error(`target branch ref is malformed: ${value}`);
  }
  if (branch === "koni" || branch.startsWith("koni/")) {
    throw new Error(`compiler-owned branch cannot be selected as a target: ${value}`);
  }
}

function invalidState(message: string): GitLifecycleError {
  return new GitLifecycleError("invalid_state", message);
}

function namespaceCollision(message: string): GitLifecycleError {
  return new GitLifecycleError("namespace_collision", message);
}

function refMoved(message: string, expected: string, actual: string): GitLifecycleError {
  return new GitLifecycleError("ref_moved", message, { expected, actual });
}

function dirtyCheckout(label: string, worktree: string): GitLifecycleError {
  return new GitLifecycleError("dirty_checkout", `${label} is dirty: ${worktree}`, { worktree });
}

function translateCasError(error: unknown, message: string): Error {
  if (error instanceof GitCommandError) {
    return new GitLifecycleError("ref_moved", message, {
      stderr: error.stderr,
      argv: error.argv,
    });
  }
  return error instanceof Error ? error : new Error(String(error));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

interface RunGitNamespace {
  root: string;
  runRef: string;
  planningWorktree: string;
  runWorktree: string;
  ticketRoot: string;
}

function legacyRunNamespace(commonDirectory: string, runId: string): RunGitNamespace {
  const root = path.join(commonDirectory, "koni", "worktrees", "runs", runId);
  return {
    root,
    runRef: `refs/heads/koni/runs/${runId}`,
    planningWorktree: path.join(root, "planning"),
    runWorktree: path.join(root, "integration"),
    ticketRoot: path.join(root, "tickets"),
  };
}

function policyRunNamespace(
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
function legacyPolicyRunNamespace(
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

function persistedPolicyRunNamespace(
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

function sameRunNamespace(left: RunGitNamespace, right: RunGitNamespace): boolean {
  return (
    left.root === right.root &&
    left.runRef === right.runRef &&
    left.planningWorktree === right.planningWorktree &&
    left.runWorktree === right.runWorktree &&
    left.ticketRoot === right.ticketRoot
  );
}

function policyTicketWorktree(ticketRoot: string, ticketRef: string): string {
  if (!ticketRef.startsWith("refs/heads/")) throw new Error("ticket ref is not a local branch");
  return path.join(ticketRoot, ...ticketRef.slice("refs/heads/".length).split("/"));
}

function assertNewRunAdmission(
  admission: GitRunAdmission | undefined,
  runId: string,
): asserts admission is GitRunAdmission {
  if (admission === undefined) {
    throw invalidState("new Git run admission requires a compiler-supplied immutable Git policy");
  }
  assertGitBehaviorPolicy(admission.policy);
  if (admission.run.id !== runId) {
    throw invalidState("Git run template context disagrees with the admitted run ID");
  }
  renderRunRef(admission.policy, admission.run);
}

async function assertNewRefNamespace(
  repository: GitClient,
  requested: string,
  targetRef: string,
): Promise<void> {
  if (requested === targetRef) {
    throw namespaceCollision(`compiler-owned ref collides with selected target: ${requested}`);
  }
  for (const existing of await repository.branchRefs()) {
    if (
      existing.ref === requested ||
      existing.ref.startsWith(`${requested}/`) ||
      requested.startsWith(`${existing.ref}/`)
    ) {
      throw namespaceCollision(
        `Git ref namespace collision: ${requested} conflicts with ${existing.ref}`,
      );
    }
  }
}

async function assertNewWorktreeNamespace(
  repository: { worktreeRoot: string; commonDirectory: string },
  namespaceRoot: string,
): Promise<void> {
  const client = new GitClient(repository.worktreeRoot);
  for (const worktree of await client.worktrees()) {
    if (
      worktree.path.endsWith(`${path.sep}planning`) ||
      worktree.path.endsWith(`${path.sep}integration`)
    ) {
      const existingNamespace = path.dirname(worktree.path);
      if (
        isInside(namespaceRoot, existingNamespace) ||
        isInside(existingNamespace, namespaceRoot)
      ) {
        throw namespaceCollision(
          `owned run namespace collision: ${namespaceRoot} conflicts with ${existingNamespace}`,
        );
      }
    }
  }
  await assertNewWorktreePath(repository, namespaceRoot, namespaceRoot);
}

async function assertNewWorktreePath(
  repository: { worktreeRoot: string; commonDirectory: string },
  candidate: string,
  ownerRoot: string,
): Promise<void> {
  const common = await realpath(repository.commonDirectory);
  const resolved = path.resolve(candidate);
  const external = resolveRepositoryWorktreeNamespaceRoot(common);
  const placementRoot = isInside(common, resolved)
    ? common
    : isInside(external, resolved)
      ? external
      : undefined;
  if (placementRoot === undefined || !isInside(ownerRoot, resolved)) {
    throw new GitLifecycleError(
      "ownership_mismatch",
      `configured worktree path escapes its owned namespace: ${resolved}`,
    );
  }
  await assertNoFollowExistingAncestors(
    placementRoot === common ? common : path.dirname(path.dirname(external)),
    resolved,
  );
  if (await pathExists(resolved)) {
    throw namespaceCollision(`path occupies new worktree namespace: ${resolved}`);
  }
  const client = new GitClient(repository.worktreeRoot);
  for (const worktree of await client.worktrees()) {
    // The primary checkout necessarily contains its own `.git` common directory; that containment
    // is not an overlap with a linked worktree rooted beneath the common-dir policy namespace.
    // When Koni is invoked from a linked checkout, `repository.worktreeRoot` names that linked
    // checkout rather than the primary one, so identify the primary checkout by its ownership of
    // the common directory instead of assuming the caller is running there.
    const worktreeRoot = path.resolve(worktree.path);
    if (worktreeRoot === path.resolve(repository.worktreeRoot) || isInside(worktreeRoot, common))
      continue;
    if (isInside(resolved, worktree.path) || isInside(worktree.path, resolved)) {
      throw namespaceCollision(
        `worktree namespace collision: ${resolved} conflicts with ${worktree.path}`,
      );
    }
  }
}

async function assertNoFollowExistingAncestors(common: string, candidate: string): Promise<void> {
  const relative = path.relative(common, candidate);
  let cursor = common;
  for (const component of relative.split(path.sep).filter((item) => item.length > 0)) {
    cursor = path.join(cursor, component);
    let stat;
    try {
      stat = await lstat(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new GitLifecycleError(
        "ownership_mismatch",
        `configured worktree ancestor is not a real directory: ${cursor}`,
      );
    }
    if (!isInside(common, await realpath(cursor))) {
      throw new GitLifecycleError(
        "ownership_mismatch",
        `configured worktree ancestor escapes its ownership root: ${cursor}`,
      );
    }
  }
}

function canonicalTemplateContext(value: GitTicketTemplateContext | undefined): string {
  if (value === undefined) return "";
  return JSON.stringify({
    id: value.id,
    cycleId: value.cycleId,
    operation: value.operation,
    title: value.title,
    reviewId: value.reviewId ?? null,
  });
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function ensureOwnedDirectory(candidate: string, commonDirectory: string): Promise<void> {
  const common = await realpath(commonDirectory);
  const target = path.resolve(candidate);
  const external = resolveRepositoryWorktreeNamespaceRoot(common);
  const placementRoot = isInside(common, target)
    ? common
    : isInside(external, target)
      ? external
      : undefined;
  if (placementRoot === undefined) {
    throw new GitLifecycleError(
      "ownership_mismatch",
      `directory escapes its managed-worktree namespace: ${target}`,
    );
  }
  const traversalRoot = placementRoot === common ? common : path.dirname(path.dirname(external));
  const relative = path.relative(traversalRoot, target);
  let cursor = traversalRoot;
  for (const component of relative.split(path.sep).filter((part) => part.length > 0)) {
    cursor = path.join(cursor, component);
    try {
      await mkdir(cursor, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stat = await lstat(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new GitLifecycleError(
        "ownership_mismatch",
        `compiler namespace component is not a real directory: ${cursor}`,
      );
    }
    if (!isInside(traversalRoot, await realpath(cursor))) {
      throw new GitLifecycleError(
        "ownership_mismatch",
        `compiler namespace component resolves outside its ownership root: ${cursor}`,
      );
    }
  }
}
