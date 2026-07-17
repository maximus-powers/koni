import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { GitClient, type GitWorktreeEntry } from "../git/client.js";
import {
  GIT_INTENT_PROTOCOL,
  GitLifecycleError,
  assertGitLifecycleIntent,
  assertRunGitLifecycleRecord,
  type GitLifecycleIntent,
  type RunGitLifecycleRecord,
} from "../git/lifecycle.js";
import { canonicalHash } from "../shared/canonical.js";
import {
  assertLegacyRunGitMigrationRecord,
  type LegacyRunGitMigrationRecord,
  type LegacyRunRelocationPlan,
} from "./legacy-run-git-migration.js";
import type { RunRecord } from "./run-record.js";

type LegacyRelocationIntent = Extract<GitLifecycleIntent, { kind: "legacy_run_relocate" }>;
type LegacyRetirementIntent = Extract<GitLifecycleIntent, { kind: "legacy_run_retire" }>;
type LegacyIntent = LegacyRelocationIntent | LegacyRetirementIntent;

export type LegacyRunGitEffectFaultPoint =
  | "after_legacy_source_staged"
  | "after_legacy_namespace_prepared"
  | "after_legacy_destination_moved"
  | "after_legacy_destination_locked"
  | "after_legacy_worktree_retired"
  | "after_legacy_ref_retired";

export interface LegacyRunGitSettlement {
  status: "completed" | "blocked";
  operation: "relocate" | "retire";
  settledAt: string;
  lifecycle: RunGitLifecycleRecord;
  migration: LegacyRunGitMigrationRecord;
  clearTicketProjectionIds: string[];
  reason?: string;
}

export interface LegacyRunGitJournal {
  prepare(intent: GitLifecycleIntent): Promise<void>;
  settleLegacy(intentId: string, settlement: LegacyRunGitSettlement): Promise<void>;
}

export type LegacyRunGitExecutionResult =
  | {
      status: "completed";
      operation: "relocate" | "retire";
      lifecycle: RunGitLifecycleRecord;
      migration: LegacyRunGitMigrationRecord;
    }
  | {
      status: "preserved";
      operation: "relocate" | "retire";
      reason: string;
      /** Present when a prepared intent was durably settled as blocked. */
      lifecycle?: RunGitLifecycleRecord;
      migration?: LegacyRunGitMigrationRecord;
    };

export interface LegacyRunGitExecutorOptions {
  now?: () => Date;
  createId?: () => string;
  /** Test-only process-crash injection. A thrown fault deliberately leaves the intent pending. */
  effectFault?: (point: LegacyRunGitEffectFaultPoint, intent: LegacyIntent) => void;
}

class InjectedLegacyGitCrash extends Error {
  public constructor(public readonly faultCause: unknown) {
    super(faultCause instanceof Error ? faultCause.message : String(faultCause));
    this.name = "InjectedLegacyGitCrash";
  }
}

/**
 * Compatibility-only Git executor for the one pre-isolation worktree layout.
 *
 * New runs never pass through this class. It consumes the immutable proof plan
 * emitted by the startup adapter and uses the same authority journal as the
 * ordinary lifecycle without treating compatibility metadata as Git truth.
 */
export class LegacyRunGitExecutor {
  readonly #now: () => Date;
  readonly #createId: () => string;
  readonly #effectFault: LegacyRunGitExecutorOptions["effectFault"];

  public constructor(options: LegacyRunGitExecutorOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? randomUUID;
    this.#effectFault = options.effectFault;
  }

  public async relocate(
    run: RunRecord,
    journal: LegacyRunGitJournal,
  ): Promise<LegacyRunGitExecutionResult> {
    let intent: LegacyRelocationIntent;
    try {
      const plan = this.#requiredRelocation(run);
      intent = this.#relocationIntent(run, plan);
      await this.#inspectRelocation(run, intent, "source");
    } catch (error) {
      return { status: "preserved", operation: "relocate", reason: errorMessage(error) };
    }
    await journal.prepare(intent);
    return this.#applyRelocation(run, intent, journal);
  }

  public async retire(
    run: RunRecord,
    journal: LegacyRunGitJournal,
  ): Promise<LegacyRunGitExecutionResult> {
    let inspected: { worktree: string; expectedOid: string };
    try {
      this.#assertRetirable(run);
      inspected = await this.#inspectRetirement(run);
    } catch (error) {
      return { status: "preserved", operation: "retire", reason: errorMessage(error) };
    }
    const migration = run.legacyGitMigration!;
    const intent: LegacyRetirementIntent = {
      ...this.#intentBase(run.git),
      kind: "legacy_run_retire",
      sourceGitSha256: migration.sourceGitSha256,
      expectedRunOid: inspected.expectedOid,
      runRef: `refs/heads/${migration.source.runBranch}`,
      sourceWorktree: inspected.worktree,
      namespaceRoot: legacyNamespaceRoot(run),
    };
    await journal.prepare(intent);
    return this.#applyRetirement(run, intent, journal);
  }

  public async recover(
    run: RunRecord,
    intent: GitLifecycleIntent,
    journal: LegacyRunGitJournal,
  ): Promise<LegacyRunGitExecutionResult> {
    assertGitLifecycleIntent(intent);
    if (intent.kind !== "legacy_run_relocate" && intent.kind !== "legacy_run_retire") {
      throw new GitLifecycleError("invalid_state", `not a legacy Git intent: ${intent.kind}`);
    }
    this.#assertIntentOwner(run, intent);
    if (intent.kind === "legacy_run_relocate") {
      return this.#applyRelocation(run, intent, journal);
    }
    return this.#applyRetirement(run, intent, journal);
  }

  async #applyRelocation(
    run: RunRecord,
    intent: LegacyRelocationIntent,
    journal: LegacyRunGitJournal,
  ): Promise<LegacyRunGitExecutionResult> {
    try {
      this.#assertRelocationIntentBinding(run, intent);
      let location = await this.#inspectRelocation(run, intent, undefined, false);
      const repository = new GitClient(intent.projectRoot);
      if (location === "source") {
        await ensureOwnedDirectory(path.dirname(intent.stagingWorktree), intent.commonDirectory);
        await this.#inspectRelocation(run, intent, "source");
        await repository.moveWorktree(intent.sourceWorktree, intent.stagingWorktree);
        this.#fault("after_legacy_source_staged", intent);
        location = await this.#inspectRelocation(run, intent, "staging");
      }
      if (location === "staging") {
        await ensureOwnedDirectory(intent.namespaceRoot, intent.commonDirectory);
        await assertDirectoryEntries(intent.namespaceRoot, []);
        this.#fault("after_legacy_namespace_prepared", intent);
        await this.#inspectRelocation(run, intent, "staging");
        await repository.moveWorktree(intent.stagingWorktree, intent.destinationWorktree);
        this.#fault("after_legacy_destination_moved", intent);
        location = await this.#inspectRelocation(run, intent, "destination", false);
      }
      if (location !== "destination") {
        throw new GitLifecycleError("recovery_ambiguous", "legacy relocation has no authoritative checkout");
      }
      let destination = await this.#registeredAt(repository, intent.destinationWorktree);
      const expectedLockReason = relocationLockReason(intent.runId);
      if (!destination.locked) {
        await repository.lockWorktree(intent.destinationWorktree, expectedLockReason);
        this.#fault("after_legacy_destination_locked", intent);
        destination = await this.#registeredAt(repository, intent.destinationWorktree);
      }
      if (!destination.locked || destination.lockReason !== expectedLockReason) {
        throw new GitLifecycleError(
          "ownership_mismatch",
          "relocated checkout does not carry the compiler worktree lock",
        );
      }
      await this.#inspectRelocation(run, intent, "destination", true);
      const settledAt = this.#timestamp();
      const lifecycle = relocatedLifecycle(run.git, intent, settledAt);
      const migration = relocatedMigration(run.legacyGitMigration!, intent, settledAt);
      await this.#settleCompleted(journal, intent.id, {
        status: "completed",
        operation: "relocate",
        settledAt,
        lifecycle,
        migration,
        clearTicketProjectionIds: [...intent.ticketProjectionIds],
      });
      return { status: "completed", operation: "relocate", lifecycle, migration };
    } catch (error) {
      if (error instanceof InjectedLegacyGitCrash) throw error.faultCause;
      return this.#settlePreserved(run, intent, journal, errorMessage(error));
    }
  }

  async #applyRetirement(
    run: RunRecord,
    intent: LegacyRetirementIntent,
    journal: LegacyRunGitJournal,
  ): Promise<LegacyRunGitExecutionResult> {
    try {
      this.#assertRetirementIntentBinding(run, intent);
      const repository = new GitClient(intent.projectRoot);
      let registration = await this.#optionalRegisteredAt(repository, intent.sourceWorktree);
      if (registration !== undefined) {
        const preflight = await this.#inspectRetirement(run);
        if (
          path.resolve(preflight.worktree) !== path.resolve(intent.sourceWorktree) ||
          preflight.expectedOid !== intent.expectedRunOid
        ) {
          throw new GitLifecycleError("ownership_mismatch", "legacy deletion proof changed after preparation");
        }
        registration = await this.#registeredAt(repository, intent.sourceWorktree);
        await this.#assertLegacyCheckout(
          intent,
          registration,
          intent.sourceWorktree,
          intent.expectedRunOid,
        );
        if (registration.locked) {
          if (registration.lockReason !== relocationLockReason(intent.runId)) {
            throw new GitLifecycleError("ownership_mismatch", "legacy checkout has an unrecognized lock");
          }
          await repository.unlockWorktree(intent.sourceWorktree);
        }
        await repository.removeWorktree(intent.sourceWorktree);
        this.#fault("after_legacy_worktree_retired", intent);
      } else if (await pathExists(intent.sourceWorktree)) {
        throw new GitLifecycleError(
          "ownership_mismatch",
          "unregistered legacy worktree data remains and will not be deleted",
        );
      }
      const current = await repository.tryResolveRef(intent.runRef);
      if (current === intent.expectedRunOid) {
        await repository.deleteRef(intent.runRef, intent.expectedRunOid);
        this.#fault("after_legacy_ref_retired", intent);
      } else if (current !== undefined) {
        throw new GitLifecycleError("ref_moved", "legacy run ref moved before explicit deletion");
      }
      const settledAt = this.#timestamp();
      const lifecycle = retiredLegacyLifecycle(run.git, settledAt);
      const migration = retiredMigration(run.legacyGitMigration!, intent, settledAt);
      await this.#settleCompleted(journal, intent.id, {
        status: "completed",
        operation: "retire",
        settledAt,
        lifecycle,
        migration,
        clearTicketProjectionIds: [],
      });
      return { status: "completed", operation: "retire", lifecycle, migration };
    } catch (error) {
      if (error instanceof InjectedLegacyGitCrash) throw error.faultCause;
      return this.#settlePreserved(run, intent, journal, errorMessage(error));
    }
  }

  async #settlePreserved(
    run: RunRecord,
    intent: LegacyIntent,
    journal: LegacyRunGitJournal,
    reason: string,
  ): Promise<LegacyRunGitExecutionResult> {
    const settledAt = this.#timestamp();
    const lifecycle = preservedLegacyLifecycle(run.git, intent, reason);
    const migration = preservedMigration(run.legacyGitMigration!, reason);
    await journal.settleLegacy(intent.id, {
      status: "blocked",
      operation: intent.kind === "legacy_run_relocate" ? "relocate" : "retire",
      settledAt,
      lifecycle,
      migration,
      clearTicketProjectionIds: [],
      reason,
    });
    return {
      status: "preserved",
      operation: intent.kind === "legacy_run_relocate" ? "relocate" : "retire",
      reason,
      lifecycle,
      migration,
    };
  }

  async #settleCompleted(
    journal: LegacyRunGitJournal,
    intentId: string,
    settlement: LegacyRunGitSettlement,
  ): Promise<void> {
    try {
      await journal.settleLegacy(intentId, settlement);
    } catch (error) {
      // Publication is itself a crash boundary. Do not reinterpret an
      // unavailable/ambiguous authority commit as a Git mismatch and replace
      // the completed projection with a blocked settlement.
      throw new InjectedLegacyGitCrash(error);
    }
  }

  #requiredRelocation(run: RunRecord): LegacyRunRelocationPlan {
    const migration = run.legacyGitMigration;
    if (migration === undefined || migration.status !== "relocation_required" || migration.relocation === undefined) {
      throw new GitLifecycleError("invalid_state", "run does not require legacy Git relocation");
    }
    assertLegacyRunGitMigrationRecord(migration, run.id, run.projectRoot, run.git);
    return migration.relocation;
  }

  #assertRetirable(run: RunRecord): void {
    const migration = run.legacyGitMigration;
    if (
      migration === undefined ||
      (migration.status !== "relocation_required" && migration.status !== "preserved")
    ) {
      throw new GitLifecycleError("invalid_state", "run has no unrelocated legacy Git namespace");
    }
    assertLegacyRunGitMigrationRecord(migration, run.id, run.projectRoot, run.git);
    if (Object.keys(run.git.ticketCycles).length !== 0 || run.git.ticketCycleOrder.length !== 0) {
      throw new GitLifecycleError("ownership_mismatch", "legacy deletion found new-layout ticket resources");
    }
  }

  #relocationIntent(run: RunRecord, plan: LegacyRunRelocationPlan): LegacyRelocationIntent {
    if (plan.target.observedOid === undefined) {
      throw new GitLifecycleError("ownership_mismatch", "legacy target observation is missing");
    }
    return {
      ...this.#intentBase(run.git),
      kind: "legacy_run_relocate",
      sourceGitSha256: plan.sourceGitSha256,
      relocationPlanSha256: canonicalHash(plan),
      targetRef: plan.target.ref,
      selectedTargetOid: plan.target.selectedOid,
      observedTargetOid: plan.target.observedOid,
      expectedRunOid: plan.source.expectedHeadOid,
      runRef: plan.source.branchRef,
      sourceWorktree: plan.source.worktree,
      stagingWorktree: plan.destination.stagingWorktree,
      destinationWorktree: plan.destination.runWorktree,
      namespaceRoot: plan.destination.namespaceRoot,
      planningWorktree: plan.destination.planningWorktree,
      ticketRoot: plan.destination.ticketRoot,
      ticketProjectionIds: [...plan.ticketProjectionIds],
    };
  }

  #intentBase(lifecycle: RunGitLifecycleRecord) {
    return {
      protocol: GIT_INTENT_PROTOCOL,
      id: `git-${this.#createId()}`,
      runId: lifecycle.runId,
      projectRoot: lifecycle.projectRoot,
      commonDirectory: lifecycle.commonDirectory,
      preparedAt: this.#timestamp(),
    } as const;
  }

  #assertIntentOwner(run: RunRecord, intent: LegacyIntent): void {
    if (
      intent.runId !== run.id ||
      path.resolve(intent.projectRoot) !== path.resolve(run.git.projectRoot) ||
      path.resolve(intent.commonDirectory) !== path.resolve(run.git.commonDirectory)
    ) {
      throw new GitLifecycleError("ownership_mismatch", "legacy Git intent belongs to another authority");
    }
  }

  #assertRelocationIntentBinding(run: RunRecord, intent: LegacyRelocationIntent): void {
    this.#assertIntentOwner(run, intent);
    const migration = run.legacyGitMigration;
    if (migration === undefined || migration.relocation === undefined) {
      throw new GitLifecycleError("invalid_state", "legacy relocation proof is no longer present");
    }
    if (
      migration.sourceGitSha256 !== intent.sourceGitSha256 ||
      canonicalHash(migration.source) !== intent.sourceGitSha256 ||
      canonicalHash(migration.relocation) !== intent.relocationPlanSha256 ||
      migration.relocation.source.branchRef !== intent.runRef ||
      migration.relocation.source.expectedHeadOid !== intent.expectedRunOid ||
      migration.relocation.source.worktree !== intent.sourceWorktree ||
      migration.relocation.destination.stagingWorktree !== intent.stagingWorktree ||
      migration.relocation.destination.runWorktree !== intent.destinationWorktree ||
      migration.relocation.destination.namespaceRoot !== intent.namespaceRoot ||
      migration.relocation.destination.planningWorktree !== intent.planningWorktree ||
      migration.relocation.destination.ticketRoot !== intent.ticketRoot ||
      canonicalHash(migration.relocation.ticketProjectionIds) !== canonicalHash(intent.ticketProjectionIds)
    ) {
      throw new GitLifecycleError("ownership_mismatch", "legacy relocation intent no longer matches its proof plan");
    }
  }

  #assertRetirementIntentBinding(run: RunRecord, intent: LegacyRetirementIntent): void {
    this.#assertIntentOwner(run, intent);
    const migration = run.legacyGitMigration;
    if (
      migration === undefined ||
      migration.sourceGitSha256 !== intent.sourceGitSha256 ||
      canonicalHash(migration.source) !== intent.sourceGitSha256 ||
      `refs/heads/${migration.source.runBranch}` !== intent.runRef ||
      legacyNamespaceRoot(run) !== intent.namespaceRoot
    ) {
      throw new GitLifecycleError("ownership_mismatch", "legacy deletion intent no longer matches its source proof");
    }
  }

  async #inspectRelocation(
    run: RunRecord,
    intent: LegacyRelocationIntent,
    expectedLocation?: "source" | "staging" | "destination",
    requireDestinationLock = true,
  ): Promise<"source" | "staging" | "destination"> {
    this.#assertRelocationIntentBinding(run, intent);
    const identity = await GitClient.discover(intent.projectRoot);
    await assertRepositoryIdentity(identity, intent.projectRoot, intent.commonDirectory);
    const repository = new GitClient(intent.projectRoot);
    const [target, selected, runHead, worktrees] = await Promise.all([
      repository.tryResolveRef(intent.targetRef),
      repository.tryResolveRef(intent.selectedTargetOid),
      repository.tryResolveRef(intent.runRef),
      repository.worktrees(),
    ]);
    if (target !== intent.observedTargetOid || selected !== intent.selectedTargetOid) {
      throw new GitLifecycleError("ref_moved", "legacy target evidence changed before relocation settled");
    }
    if (runHead !== intent.expectedRunOid) {
      throw new GitLifecycleError("ref_moved", "legacy run ref changed before relocation settled");
    }
    const branchEntries = worktrees.filter((entry) => entry.branch === intent.runRef);
    if (branchEntries.length !== 1) {
      throw new GitLifecycleError("ownership_mismatch", "legacy run ref registration is ambiguous");
    }
    const registered = branchEntries[0]!;
    const locations = new Map<string, "source" | "staging" | "destination">([
      [path.resolve(intent.sourceWorktree), "source"],
      [path.resolve(intent.stagingWorktree), "staging"],
      [path.resolve(intent.destinationWorktree), "destination"],
    ]);
    const location = locations.get(path.resolve(registered.path));
    if (location === undefined || (expectedLocation !== undefined && location !== expectedLocation)) {
      throw new GitLifecycleError("ownership_mismatch", "legacy checkout is registered at an unexpected path");
    }
    await this.#assertLegacyCheckout(intent, registered, registered.path, intent.expectedRunOid);
    if (location === "source") {
      if (registered.locked) {
        throw new GitLifecycleError("ownership_mismatch", "legacy source checkout is unexpectedly locked");
      }
      await assertPathsAbsent([
        intent.stagingWorktree,
        intent.destinationWorktree,
        intent.planningWorktree,
        intent.ticketRoot,
      ]);
    } else if (location === "staging") {
      if (registered.locked) {
        throw new GitLifecycleError("ownership_mismatch", "legacy staging checkout is unexpectedly locked");
      }
      await assertPathsAbsent([intent.destinationWorktree, intent.planningWorktree, intent.ticketRoot]);
      if (await pathExists(intent.namespaceRoot)) await assertDirectoryEntries(intent.namespaceRoot, []);
    } else {
      await assertPathsAbsent([intent.stagingWorktree, intent.planningWorktree, intent.ticketRoot]);
      await assertDirectoryEntries(intent.namespaceRoot, [path.basename(intent.destinationWorktree)]);
      if (
        requireDestinationLock &&
        (!registered.locked || registered.lockReason !== relocationLockReason(intent.runId))
      ) {
        throw new GitLifecycleError("ownership_mismatch", "relocated checkout lock is absent or foreign");
      }
    }
    return location;
  }

  async #inspectRetirement(run: RunRecord): Promise<{ worktree: string; expectedOid: string }> {
    const migration = run.legacyGitMigration!;
    const identity = await GitClient.discover(run.git.projectRoot);
    await assertRepositoryIdentity(identity, run.git.projectRoot, run.git.commonDirectory);
    const repository = new GitClient(run.git.projectRoot);
    const runRef = `refs/heads/${migration.source.runBranch}`;
    const [runHead, worktrees] = await Promise.all([
      repository.tryResolveRef(runRef),
      repository.worktrees(),
    ]);
    if (runHead === undefined || (run.git.run.headOid !== undefined && runHead !== run.git.run.headOid)) {
      throw new GitLifecycleError("ref_moved", "legacy run ref is missing or differs from its durable head");
    }
    const branchEntries = worktrees.filter((entry) => entry.branch === runRef);
    if (branchEntries.length !== 1) {
      throw new GitLifecycleError("ownership_mismatch", "legacy deletion requires one exact run checkout");
    }
    const registered = branchEntries[0]!;
    const root = legacyNamespaceRoot(run);
    const allowed = new Set<string>([path.resolve(migration.source.runWorktree)]);
    const relocation = migration.relocation;
    if (relocation !== undefined) {
      allowed.add(path.resolve(relocation.destination.stagingWorktree));
      allowed.add(path.resolve(relocation.destination.runWorktree));
    }
    if (!allowed.has(path.resolve(registered.path))) {
      throw new GitLifecycleError("ownership_mismatch", "legacy checkout moved outside every proof-owned location");
    }
    await this.#assertLegacyCheckout({
      projectRoot: run.git.projectRoot,
      commonDirectory: run.git.commonDirectory,
      runRef,
    }, registered, registered.path, runHead);
    if (registered.locked && registered.lockReason !== relocationLockReason(run.id)) {
      throw new GitLifecycleError("ownership_mismatch", "legacy deletion found an unrecognized worktree lock");
    }
    const planning = relocation?.destination.planningWorktree ?? path.join(root, "planning");
    const destination = relocation?.destination.runWorktree ?? path.join(root, "integration");
    const staging = relocation?.destination.stagingWorktree ?? stagingPath(run.git.commonDirectory, run.id);
    const tickets = relocation?.destination.ticketRoot ?? path.join(root, "tickets");
    const occupiedCandidates = [planning, destination, staging, tickets].filter(
      (candidate) => path.resolve(candidate) !== path.resolve(registered.path),
    );
    await assertPathsAbsent(occupiedCandidates);
    return { worktree: registered.path, expectedOid: runHead };
  }

  async #assertLegacyCheckout(
    intent: Pick<LegacyIntent, "projectRoot" | "commonDirectory" | "runRef">,
    registered: GitWorktreeEntry,
    worktree: string,
    expectedOid: string,
  ): Promise<void> {
    if (path.resolve(registered.path) !== path.resolve(worktree)) {
      throw new GitLifecycleError("ownership_mismatch", "legacy worktree registration path changed");
    }
    if (registered.branch !== intent.runRef || registered.head !== expectedOid || registered.detached) {
      throw new GitLifecycleError("ownership_mismatch", "legacy worktree branch or HEAD changed");
    }
    const stat = await lstat(worktree);
    if (stat.isSymbolicLink() || !stat.isDirectory() || await realpath(worktree) !== path.resolve(worktree)) {
      throw new GitLifecycleError("ownership_mismatch", "legacy worktree path is not one real directory");
    }
    const discovered = await GitClient.discover(worktree);
    await assertRepositoryIdentity(discovered, intent.projectRoot, intent.commonDirectory, false);
    if ((await new GitClient(worktree).statusEntries()).length !== 0) {
      throw new GitLifecycleError("dirty_checkout", `legacy worktree has local changes: ${worktree}`);
    }
  }

  async #registeredAt(repository: GitClient, expectedPath: string): Promise<GitWorktreeEntry> {
    const found = await this.#optionalRegisteredAt(repository, expectedPath);
    if (found === undefined) {
      throw new GitLifecycleError("ownership_mismatch", `worktree is not registered: ${expectedPath}`);
    }
    return found;
  }

  async #optionalRegisteredAt(repository: GitClient, expectedPath: string): Promise<GitWorktreeEntry | undefined> {
    const normalized = path.resolve(expectedPath);
    return (await repository.worktrees()).find((entry) => path.resolve(entry.path) === normalized);
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }

  #fault(point: LegacyRunGitEffectFaultPoint, intent: LegacyIntent): void {
    if (this.#effectFault === undefined) return;
    try {
      this.#effectFault(point, intent);
    } catch (error) {
      throw new InjectedLegacyGitCrash(error);
    }
  }
}

function relocatedLifecycle(
  current: RunGitLifecycleRecord,
  intent: LegacyRelocationIntent,
  settledAt: string,
): RunGitLifecycleRecord {
  const next = structuredClone(current);
  next.namespace.root = intent.namespaceRoot;
  next.namespace.planningWorktree = intent.planningWorktree;
  next.namespace.runWorktree = intent.destinationWorktree;
  next.namespace.ticketRoot = intent.ticketRoot;
  next.planning.status = "retired";
  next.planning.worktree = intent.planningWorktree;
  next.planning.retiredAt ??= settledAt;
  next.planning.blocker = undefined;
  next.run.status = "ready";
  next.run.branchRef = intent.runRef;
  next.run.worktree = intent.destinationWorktree;
  next.run.headOid = intent.expectedRunOid;
  next.run.materializedAt ??= settledAt;
  next.run.retiredAt = undefined;
  next.run.blocker = undefined;
  next.ticketCycles = {};
  next.ticketCycleOrder = [];
  assertRunGitLifecycleRecord(next);
  return next;
}

function preservedLegacyLifecycle(
  current: RunGitLifecycleRecord,
  intent: LegacyIntent,
  reason: string,
): RunGitLifecycleRecord {
  const next = structuredClone(current);
  if (intent.kind === "legacy_run_relocate") {
    next.run.status = "preserved";
    next.run.blocker = reason;
  } else {
    if (next.planning.status !== "retired") {
      next.planning.status = "preserved";
      next.planning.blocker = reason;
    }
    if (next.run.status !== "retired") {
      next.run.status = "preserved";
      next.run.blocker = reason;
    }
  }
  return next;
}

function retiredLegacyLifecycle(
  current: RunGitLifecycleRecord,
  settledAt: string,
): RunGitLifecycleRecord {
  const next = structuredClone(current);
  next.planning.status = "retired";
  next.planning.retiredAt ??= settledAt;
  next.planning.blocker = undefined;
  next.run.status = "retired";
  next.run.retiredAt ??= settledAt;
  next.run.blocker = undefined;
  for (const cycle of Object.values(next.ticketCycles)) {
    cycle.status = "retired";
    cycle.retiredAt ??= settledAt;
    cycle.blocker = undefined;
  }
  assertRunGitLifecycleRecord(next);
  return next;
}

function relocatedMigration(
  current: LegacyRunGitMigrationRecord,
  intent: LegacyRelocationIntent,
  settledAt: string,
): LegacyRunGitMigrationRecord {
  return {
    ...structuredClone(current),
    status: "relocated",
    reason: undefined,
    relocationIntentId: intent.id,
    relocatedAt: settledAt,
    retirementIntentId: undefined,
    retiredAt: undefined,
  };
}

function retiredMigration(
  current: LegacyRunGitMigrationRecord,
  intent: LegacyRetirementIntent,
  settledAt: string,
): LegacyRunGitMigrationRecord {
  return {
    ...structuredClone(current),
    status: "retired",
    reason: undefined,
    relocationIntentId: undefined,
    relocatedAt: undefined,
    retirementIntentId: intent.id,
    retiredAt: settledAt,
  };
}

function preservedMigration(
  current: LegacyRunGitMigrationRecord,
  reason: string,
): LegacyRunGitMigrationRecord {
  return {
    ...structuredClone(current),
    status: "preserved",
    reason,
    relocationIntentId: undefined,
    relocatedAt: undefined,
    retirementIntentId: undefined,
    retiredAt: undefined,
  };
}

function legacyNamespaceRoot(run: RunRecord): string {
  return path.join(run.git.commonDirectory, "koni", "worktrees", "runs", run.id);
}

function stagingPath(commonDirectory: string, runId: string): string {
  return path.join(commonDirectory, "koni", "worktrees", "migrations", runId, "integration");
}

function relocationLockReason(runId: string): string {
  return `Koni run ${runId}`;
}

async function assertRepositoryIdentity(
  actual: { worktreeRoot: string; commonDirectory: string },
  expectedRoot: string,
  expectedCommon: string,
  compareRoot = true,
): Promise<void> {
  const [actualCommon, durableCommon] = await Promise.all([
    realpath(actual.commonDirectory),
    realpath(expectedCommon),
  ]);
  if (actualCommon !== durableCommon) {
    throw new GitLifecycleError("ownership_mismatch", "legacy checkout belongs to another repository");
  }
  if (compareRoot) {
    const [actualRoot, durableRoot] = await Promise.all([
      realpath(actual.worktreeRoot),
      realpath(expectedRoot),
    ]);
    if (actualRoot !== durableRoot) {
      throw new GitLifecycleError("ownership_mismatch", "legacy authority project root changed");
    }
  }
}

async function assertPathsAbsent(paths: readonly string[]): Promise<void> {
  for (const candidate of paths) {
    if (await pathExists(candidate)) {
      throw new GitLifecycleError("namespace_collision", `legacy migration destination is occupied: ${candidate}`);
    }
  }
}

async function assertDirectoryEntries(directory: string, expected: readonly string[]): Promise<void> {
  const stat = await lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory() || await realpath(directory) !== path.resolve(directory)) {
    throw new GitLifecycleError("ownership_mismatch", `compiler namespace is not one real directory: ${directory}`);
  }
  const actual = (await readdir(directory)).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new GitLifecycleError("namespace_collision", `compiler namespace contains unexpected entries: ${directory}`);
  }
}

async function ensureOwnedDirectory(candidate: string, commonDirectory: string): Promise<void> {
  const common = await realpath(commonDirectory);
  const target = path.resolve(candidate);
  if (!isInside(common, target)) {
    throw new GitLifecycleError("ownership_mismatch", `directory escapes Git common dir: ${target}`);
  }
  const relative = path.relative(common, target);
  let cursor = common;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    try {
      await mkdir(cursor, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stat = await lstat(cursor);
    if (stat.isSymbolicLink() || !stat.isDirectory() || !isInside(common, await realpath(cursor))) {
      throw new GitLifecycleError("ownership_mismatch", `namespace component is unsafe: ${cursor}`);
    }
  }
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

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
