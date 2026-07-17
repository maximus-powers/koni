import { randomUUID } from "node:crypto";
import path from "node:path";
import type { TSchema } from "typebox";
import type { TransactionWrite } from "./file-journal.js";
import type { JsonValue, RpcRequest } from "./protocol.js";
import {
  AuthorityRpcError,
  AuthorityServer,
  type AuthorityMethodResult,
} from "./server.js";
import {
  authorityRequestHash,
  ProjectAuthorityStore,
} from "./project-store.js";
import { discoverAuthorityEndpoint } from "./endpoint.js";
import {
  buildConfigSurfaceCatalog,
  buildConfigSurfaceSnapshot,
  createConfigSurfaceResource,
  deleteConfigSurfaceResource,
  duplicateConfigSurfaceResource,
  publishConfigSurfaceSnapshot,
  recoverConfigSurfaceResourceMutation,
} from "./config-surface.js";
import { canonicalEncode, canonicalHash, rawSha256, type Sha256Digest } from "../shared/canonical.js";
import type { AuthorityGrant } from "./grants.js";
import { WorktreePathAuthority } from "./path-policy.js";
import { runContainedProcess, snapshotContainedPaths } from "./process-runner.js";
import type { RuntimeExecutableIdentity } from "../runtime/executable.js";
import {
  IsolatedGitLifecycle,
  type GitIntentJournal,
  type GitLifecycleIntent,
  type GitPathScope,
  type GitIntentSettlement,
  type RunGitLifecycleRecord,
} from "../git/index.js";
import type { GraphEdge, GraphNode } from "../graph/model.js";
import { DynamicGraphContextBudgetError } from "../graph/context-selector.js";
import type { ControlCatalog } from "../control-center/protocol.js";
import type {
  AuthorityBackedTool,
  ManagedPiSessionFactory,
  ManagedSessionOutcome,
} from "../pi/managed-session.js";
import {
  createKoniAuthorityTools,
  KONI_TOOL_RECEIPT_PROTOCOL,
  validateKoniToolReceipt,
  validateKoniToolArguments,
  type KoniToolInvocation,
  type KoniToolName,
  type KoniRejectedToolReceipt,
  type KoniRuntimeToolRejection,
  type KoniToolReceipt,
} from "../pi/tool-catalog.js";
import type {
  KoniAuthorizedMessage,
  KoniCompactionSnapshot,
  KoniContextProvider,
} from "../pi/compaction.js";
import {
  validateAgentLaunchSpec,
  type AgentAttemptLineage,
  type AgentLaunchSpec,
} from "../pi/launch-spec.js";
import { readPiSession } from "../pi/session-transcript.js";
import {
  ManagedSessionSupervisor,
  type ManagedSessionHandle,
  type SupervisorEvent,
} from "../pi/supervisor.js";
import {
  PiAttemptProcessSupervisor,
  type PiAttemptProcessHandle,
  type PiAttemptProcessSupervisorEvent,
} from "../pi/attempt-process-pool.js";
import {
  newRunLifecycle,
  reduceRunLifecycle,
  type RunPhase,
  type ResumableRunPhase,
  type RunLifecycleEvent,
} from "../state/run-lifecycle.js";
import {
  LegacyRunGitExecutor,
  type LegacyRunGitJournal,
  type LegacyRunGitSettlement,
} from "../state/legacy-run-git-executor.js";
import type { LegacyRunAdoptionRecord } from "../state/legacy-run-adoption.js";
import {
  assessLegacyRunAdoption,
  legacyRunResumeVerificationSha256,
  loadLegacyRunMigrationEvidence,
  type LegacyRunAdoptionAssessment,
  type LegacyRunAdoptionBlocker,
  type LoadedLegacyRunMigrationEvidence,
} from "../profile/run-adoption.js";
import type {
  AgentAttemptRecord,
  AttemptStatus,
  PendingCheckIntentRecord,
  RunActivityRecord,
  RunExecutionConfig,
  RunPlanRecord,
  RunQuestionRecord,
  RunCheckRecord,
  RunGitReceiptRecord,
  RunReportRecord,
  RunRecord,
  TicketRecord,
  WorkspaceEffectIntentRecord,
} from "../state/run-record.js";
import {
  beginAssignment,
  deriveReadyAssignments,
  finishAssignment,
  type ReadyAssignment,
} from "../state/scheduler.js";

const REPOSITORY_DISCOVERY_TOOLS = new Set<KoniToolName>([
  "koni_read_file",
  "koni_list_files",
  "koni_search_files",
]);

export interface RunCreationRequest {
  runId: string;
  objective: string;
  runTypeId: string;
  targetRef: string;
  intake: Record<string, string>;
  overrides?: JsonValue;
}

export interface ResolvedRunDefinition {
  profile: RunRecord["profile"];
  compiledConfigHash: Sha256Digest;
  runTypeId: string;
  /** Exactly one managed persona, resolved and pinned before any run artifact is committed. */
  workingSpecOwnerId: string;
  /** Whether this run type requires a model planning pass before approval. */
  planningMode: "agent" | "direct";
  pipelineStageIds: string[];
  executionConfig: RunExecutionConfig;
  artifactWrites?: readonly TransactionWrite[];
}

export interface PreparedManagedAttempt {
  spec: AgentLaunchSpec;
  /** Test/compatibility seam. Production attempts use the authority plan below. */
  tools?: readonly AuthorityBackedTool[];
  authorityGrant?: AuthorityGrant;
  toolNames?: readonly KoniToolName[];
  terminalOutputSchema?: TSchema;
  /** Test/compatibility seam. Production providers are authority-owned below. */
  contextProvider?: KoniContextProvider;
  contextContent?: string;
  compactionSnapshot?: KoniCompactionSnapshot;
  factory?: ManagedPiSessionFactory;
  artifactWrites?: readonly TransactionWrite[];
}

export interface PlanningCompilation {
  plan: RunPlanRecord;
  graphHash?: Sha256Digest;
  graphRevision?: number;
  tickets?: Record<string, TicketRecord>;
  activity?: RunActivityRecord[];
  artifactWrites?: readonly TransactionWrite[];
}

export interface ApprovedPlanCompilation {
  graphHash: Sha256Digest;
  graphRevision: number;
  tickets: Record<string, TicketRecord>;
  activity?: RunActivityRecord[];
  artifactWrites?: readonly TransactionWrite[];
}

export interface AssignmentCompilation {
  outcome:
    | { status: "completed"; summary: string }
    | { status: "failed"; blocker: string };
  graphHash?: Sha256Digest;
  graphRevision?: number;
  tickets?: Record<string, TicketRecord>;
  activity?: RunActivityRecord[];
  artifactWrites?: readonly TransactionWrite[];
}

export interface VerificationCompilation {
  ok: boolean;
  reason?: string;
  report?: RunReportRecord;
  activity?: RunActivityRecord[];
  artifactWrites?: readonly TransactionWrite[];
}

export interface AgentToolCompilation {
  summary: string;
  value?: JsonValue;
  graphHash?: Sha256Digest;
  graphRevision?: number;
  tickets?: Record<string, TicketRecord>;
  activity?: RunActivityRecord[];
  artifactWrites?: readonly TransactionWrite[];
}

export interface ResolvedAgentCheckCommand {
  checkId: string;
  definitionHash: Sha256Digest;
  argv: string[];
  cwd: string;
  timeoutMs: number;
  effect: "read_only" | "workspace_write";
  networkAccess: boolean;
  environment: { inherit: string[]; set: Record<string, string> };
  expectedExitCodes: number[];
  allowNonpassingReceipt: boolean;
  receiptType: string;
  resultProtocol?: string;
  requiredResultFields: string[];
  resultSchema?: JsonValue;
  resultSource: { kind: "stdout" } | { kind: "file"; path: string };
  outputArtifactSelector?: {
    field: string;
    allowPathStrings: boolean;
    pathField: string;
  };
  inputPaths: string[];
  outputPaths: string[];
}

/**
 * One compiler-resolved validation request. Composite checks retain one public check identity while
 * expanding to an ordered set of command leaves; graph-only checks intentionally have no commands.
 */
export interface ResolvedAgentCheck {
  protocol: "koni.resolved-agent-check.v1";
  requestedCheckId: string;
  definitionHash: Sha256Digest;
  kind: "command" | "graph" | "composite";
  commands: ResolvedAgentCheckCommand[];
}

export interface AgentCheckExecution {
  checkId: string;
  definitionHash: Sha256Digest;
  startedAt: string;
  completedAt: string;
  resolvedExecutable: string;
  argv: string[];
  environmentSha256: Sha256Digest;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  stdoutSha256: Sha256Digest;
  stdoutSizeBytes: number;
  stderrSha256: Sha256Digest;
  stderrSizeBytes: number;
  preManifestSha256: Sha256Digest;
  postManifestSha256: Sha256Digest;
  sandboxKind: string;
  sandboxProfileSha256: Sha256Digest;
  /** Exact authority-startup authenticated sandbox bytes used for this execution. */
  sandboxExecutableSha256?: Sha256Digest;
  resultSource: {
    kind: "stdout" | "file";
    path?: string;
    bytesSha256: Sha256Digest;
    sizeBytes: number;
    value: JsonValue;
  };
  outputFiles: Array<{ path: string; sha256: Sha256Digest; sizeBytes: number }>;
}

export interface CompiledAgentCheckResult extends AgentToolCompilation {
  accepted: boolean;
  passed: boolean;
  evidence: JsonValue;
  /** Complete authenticated evidence envelope to use for the next compiler pass. */
  ruleAuthorityEvidence?: JsonValue;
}

export interface RunCompilerProgram {
  /** Future-run launch options projected from the current effective configuration. */
  controlCatalog?(): Promise<ControlCatalog>;
  resolveRun(request: RunCreationRequest): Promise<ResolvedRunDefinition>;
  /** Build the reviewable root-only plan for a run type with no planning stage. */
  initializeDirectApproval(run: RunRecord): Promise<PlanningCompilation>;
  prepareAttempt(input: {
    kind: "planning" | "ticket" | "verification" | "integration";
    run: RunRecord;
    assignment?: ReadyAssignment;
    attemptId: string;
    sessionId: string;
    nextAuthorityRevision: number;
    expectedAuthorityStateHash: Sha256Digest;
    lineage: AgentAttemptLineage;
  }): Promise<PreparedManagedAttempt>;
  recoverAttempt?(input: {
    run: RunRecord;
    attempt: AgentAttemptRecord;
    spec: Readonly<AgentLaunchSpec>;
  }): Promise<PreparedManagedAttempt>;
  selectDynamicGraphContext?(input: {
    run: RunRecord;
    attempt: AgentAttemptRecord;
    spec: Readonly<AgentLaunchSpec>;
  }): Promise<import("../graph/context-selector.js").SelectedDynamicGraphContext>;
  refreshCompactionSnapshot?(input: {
    run: RunRecord;
    attempt: AgentAttemptRecord;
    spec: Readonly<AgentLaunchSpec>;
  }): Promise<KoniCompactionSnapshot>;
  compilePlanningOutput(input: {
    run: RunRecord;
    attemptId: string;
    output: unknown;
  }): Promise<PlanningCompilation>;
  initializeApprovedPlan(run: RunRecord): Promise<ApprovedPlanCompilation>;
  compileAssignmentOutput(input: {
    run: RunRecord;
    assignment: ReadyAssignment;
    attemptId: string;
    output: unknown;
  }): Promise<AssignmentCompilation>;
  verifyRun(run: RunRecord): Promise<VerificationCompilation>;
  createIntegrationTicket(input: {
    run: RunRecord;
    conflictReport: string;
    targetOid: string;
  }): Promise<TicketRecord>;
  /** Pure/compiler-owned actions for graph context, notes, and profile-specific tools. */
  executeAgentTool?(input: {
    run: RunRecord;
    attempt: AgentAttemptRecord;
    grant: AuthorityGrant;
    spec?: Readonly<AgentLaunchSpec>;
    call: KoniToolInvocation;
  }): Promise<AgentToolCompilation>;
  projectGraph?(run: RunRecord, ticketId?: string): Promise<{
    nodes: GraphNode[];
    edges: GraphEdge[];
  }>;
  resolveAgentCheck?(input: {
    run: RunRecord;
    attempt: AgentAttemptRecord;
    checkId: string;
  }): Promise<ResolvedAgentCheck>;
  compileAgentCheckResult?(input: {
    run: RunRecord;
    attempt: AgentAttemptRecord;
    check: ResolvedAgentCheck;
    executions: AgentCheckExecution[];
  }): Promise<CompiledAgentCheckResult>;
}

export interface RunAuthorityEngineOptions {
  projectRoot: string;
  version: string;
  program: RunCompilerProgram;
  /** Explicit test seam; production defaults to one killable child process per attempt. */
  supervisor?: ManagedSessionSupervisor | PiAttemptProcessSupervisor;
  /**
   * Provider-free release evidence may hold an admitted production child before activation.
   * Production authorities always leave this enabled.
   */
  activateProviderAttempts?: boolean;
  /** Exact executable-closure guard checked before any attempt is made durable or spawned. */
  runtimeGuard?: () => Promise<void>;
  /** Complete closure identity persisted into effect receipts for later audit. */
  runtimeClosureSha256?: Sha256Digest;
  /** Exact authority-startup authenticated Git bytes persisted into Git receipts. */
  gitExecutableSha256?: Sha256Digest;
  /** Exact authority-startup authenticated sandbox launcher. */
  sandboxExecutable?: RuntimeExecutableIdentity;
  /** Production daemon hook; invoked only after a successful quiesce response is flushed. */
  requestAuthorityShutdown?: () => void;
  git?: IsolatedGitLifecycle;
  /** Compatibility-only executor for proof-gated pre-isolation worktrees. */
  legacyGit?: LegacyRunGitExecutor;
  /** Current verified profile package root; reloaded per request so upgrades affect only future runs. */
  profilePackageRootLoader?: () => Promise<string>;
  now?: () => Date;
  createId?: (kind: "run" | "attempt" | "session" | "question" | "activity") => string;
  /** Provider-free crash-boundary injection used only by authority durability tests. */
  effectFault?: (
    point: "after_prepare" | "after_apply",
    intent: Readonly<WorkspaceEffectIntentRecord>,
  ) => Promise<void> | void;
}

/**
 * Compiler-authoritative run coordinator. Models never select ready work or mutate lifecycle/Git;
 * they execute only immutable attempts issued here after deterministic compilation.
 */
export class RunAuthorityEngine {
  readonly #projectRoot: string;
  readonly #stateRoot: string;
  readonly #version: string;
  readonly #program: RunCompilerProgram;
  readonly #store: ProjectAuthorityStore;
  readonly #server: AuthorityServer;
  readonly #supervisor: ManagedSessionSupervisor | PiAttemptProcessSupervisor;
  readonly #activateProviderAttempts: boolean;
  readonly #git: IsolatedGitLifecycle;
  readonly #legacyGit: LegacyRunGitExecutor;
  readonly #now: () => Date;
  readonly #createId: NonNullable<RunAuthorityEngineOptions["createId"]>;
  readonly #effectFault: RunAuthorityEngineOptions["effectFault"];
  readonly #profilePackageRootLoader: RunAuthorityEngineOptions["profilePackageRootLoader"];
  readonly #runtimeGuard: RunAuthorityEngineOptions["runtimeGuard"];
  readonly #runtimeClosureSha256: RunAuthorityEngineOptions["runtimeClosureSha256"];
  readonly #gitExecutableSha256: RunAuthorityEngineOptions["gitExecutableSha256"];
  readonly #sandboxExecutable: RunAuthorityEngineOptions["sandboxExecutable"];
  readonly #requestAuthorityShutdown: () => void;
  readonly #attachedOutcomes = new Set<string>();
  readonly #backgroundTasks = new Set<Promise<unknown>>();
  readonly #gitTails = new Map<string, Promise<void>>();
  // The repository-wide AuthorityLease guarantees one production engine per Git common dir.
  // This map then provides exclusive recovery ownership within that leased process.
  readonly #recoveryClaims = new Map<string, string>();
  readonly #questionWaiters = new Map<string, {
    resolve: (answer: { label: string; selectedOptionId?: string; notes?: string }) => void;
    reject: (error: Error) => void;
  }>();
  #unsubscribeSupervisor: (() => void) | undefined;

  private constructor(
    options: RunAuthorityEngineOptions & { stateRoot: string },
    store: ProjectAuthorityStore,
    server: AuthorityServer,
  ) {
    this.#projectRoot = options.projectRoot;
    this.#stateRoot = options.stateRoot;
    this.#version = options.version;
    this.#program = options.program;
    this.#store = store;
    this.#server = server;
    this.#supervisor = options.supervisor ?? new PiAttemptProcessSupervisor({
      deferActivationUntilAuthorityCommit: true,
    });
    this.#activateProviderAttempts = options.activateProviderAttempts ?? true;
    this.#git = options.git ?? new IsolatedGitLifecycle(options.projectRoot);
    this.#legacyGit = options.legacyGit ?? new LegacyRunGitExecutor();
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? defaultId;
    this.#effectFault = options.effectFault;
    this.#profilePackageRootLoader = options.profilePackageRootLoader;
    this.#runtimeGuard = options.runtimeGuard;
    this.#runtimeClosureSha256 = options.runtimeClosureSha256;
    this.#gitExecutableSha256 = options.gitExecutableSha256;
    this.#sandboxExecutable = options.sandboxExecutable;
    this.#requestAuthorityShutdown = options.requestAuthorityShutdown ?? (() => undefined);
    this.#registerMethods();
    const observe = (event: SupervisorEvent | PiAttemptProcessSupervisorEvent) => {
      if (event.event.type !== "outcome") void this.#recordSupervisorEvent(event).catch(() => undefined);
    };
    this.#unsubscribeSupervisor = this.#supervisor instanceof PiAttemptProcessSupervisor
      ? this.#supervisor.subscribe(observe)
      : this.#supervisor.subscribe(observe);
  }

  public static async open(options: RunAuthorityEngineOptions): Promise<RunAuthorityEngine> {
    const endpoint = await discoverAuthorityEndpoint(options.projectRoot);
    const store = await ProjectAuthorityStore.open({
      stateRoot: endpoint.stateRoot,
      projectRoot: endpoint.identity.worktreeRoot,
      commonDirectory: endpoint.identity.commonDirectory,
    });
    const state = await store.state();
    const server = new AuthorityServer({
      projectRoot: endpoint.identity.worktreeRoot,
      version: options.version,
      initialRevision: state.revision,
      lookupIdempotent: async (request) => {
        if (request.idempotencyKey === undefined) return undefined;
        return store.findReceipt(
          request.method,
          request.idempotencyKey,
          authorityRequestHash(request.method, request.params),
        );
      },
    });
    return new RunAuthorityEngine(
      { ...options, projectRoot: endpoint.identity.worktreeRoot, stateRoot: endpoint.stateRoot },
      store,
      server,
    );
  }

  public get server(): AuthorityServer {
    return this.#server;
  }

  public get store(): ProjectAuthorityStore {
    return this.#store;
  }

  public async start(): Promise<void> {
    await this.#server.start();
    await this.recover();
  }

  public async stop(): Promise<void> {
    this.#unsubscribeSupervisor?.();
    this.#unsubscribeSupervisor = undefined;
    await this.#supervisor.dispose();
    while (this.#backgroundTasks.size > 0) {
      await Promise.allSettled([...this.#backgroundTasks]);
    }
    await this.#server.stop();
  }

  /** Resume every persisted two-phase intent without inventing new semantic state. */
  public async recover(): Promise<void> {
    const runs = await this.#store.listRuns({ includeDeleted: true });
    for (const persisted of runs) {
      await this.#recoverGitIntents(persisted.id);
      const compatibility = await this.#store.getRun(persisted.id);
      if (
        compatibility.legacyGitMigration?.status === "relocation_required" &&
        compatibility.lifecycle.phase !== "deleting" &&
        compatibility.lifecycle.phase !== "deleted"
      ) {
        await this.#relocateLegacyRun(compatibility.id);
      }
      await this.#recoverWorkspaceEffects(persisted.id);
      await this.#recoverPendingChecks(persisted.id);
      const run = await this.#store.getRun(persisted.id);
      if (run.lifecycle.phase === "deleted") {
        await this.#supervisor.deleteRun(run.id);
        continue;
      }
      if (run.lifecycle.phase === "draft") {
        await this.#initializeRun(run.id);
      } else if (run.lifecycle.phase === "approving") {
        await this.#settleApprove(run.id);
      } else if (run.lifecycle.phase === "pausing") {
        await this.#settlePause(run.id);
      } else if (run.lifecycle.phase === "deleting") {
        await this.#settleDelete(run.id);
      } else if (run.lifecycle.phase === "merging") {
        await this.#settleMerge(run.id);
      } else if (run.lifecycle.phase === "planning") {
        this.#supervisor.resumeRun(run.id);
        await this.#recoverInFlight(run.id);
        const current = await this.#store.getRun(run.id);
        if (!hasLiveAttempt(current, "planning")) await this.#launchPlanning(run.id);
      } else if (run.lifecycle.phase === "executing" || run.lifecycle.phase === "verifying") {
        this.#supervisor.resumeRun(run.id);
        await this.#recoverInFlight(run.id);
        await this.#tick(run.id);
      }
    }
  }

  /** Recover Git before workspace/session effects so every attempt sees its exact owned checkout. */
  async #recoverGitIntents(runId: string): Promise<void> {
    let run = await this.#store.getRun(runId);
    for (const intentId of Object.keys(run.pendingGitIntents ?? {}).sort()) {
      run = await this.#store.getRun(runId);
      const intent = run.pendingGitIntents?.[intentId];
      if (intent === undefined) continue;
      let recovered: { status: "completed" | "preserved"; reason?: string };
      if (intent.kind === "legacy_run_relocate" || intent.kind === "legacy_run_retire") {
        const compatibility = await this.#withGit(runId, () =>
          this.#legacyGit.recover(run, intent, this.#legacyGitJournal(runId)));
        recovered = compatibility.status === "preserved"
          ? { status: "preserved", reason: compatibility.reason }
          : { status: "completed" };
      } else {
        recovered = await this.#withGit(runId, () =>
          this.#git.recoverIntent(run.git, intent, this.#gitJournal(runId)));
      }
      if (
        recovered.status === "preserved" &&
        !new Set(["blocked", "deleting", "deleted", "completed"]).has(run.lifecycle.phase)
      ) {
        await this.#recordRunBlocker(
          runId,
          `Git recovery preserved owned data for operator inspection: ${recovered.reason ?? intent.kind}`,
        );
        return;
      }
    }
  }

  /**
   * Quiesce the compatibility run before the first relocation effect. The
   * migrated lifecycle is already blocked, but aborting the supervisor and
   * durably interrupting any stale attempts closes the old admission path too.
   */
  async #relocateLegacyRun(runId: string): Promise<void> {
    await this.#supervisor.abortByRun(runId, "legacy Git workspace relocation");
    await this.#server.mutateInternal(async ({ revision }) => {
      const run = await this.#store.getRun(runId);
      if (run.legacyGitMigration?.status !== "relocation_required") {
        return this.#noOpInternal(revision);
      }
      const draft = nextRun(run, this.#timestamp());
      interruptRunningAttempts(draft, "Interrupted for legacy Git workspace relocation", draft.updatedAt);
      draft.activity.push(activity(
        this.#createId("activity"),
        draft.updatedAt,
        "git",
        "Quiesced legacy run before workspace relocation",
      ));
      const committed = await this.#store.commit({
        expectedRevision: revision,
        runWrites: [{ record: draft, expectedRevision: run.revision }],
      });
      return { revision: committed.state.revision };
    });
    const result = await this.#withGit(runId, async () => {
      const current = await this.#store.getRun(runId);
      return this.#legacyGit.relocate(current, this.#legacyGitJournal(runId));
    });
    if (result.status === "preserved" && result.lifecycle === undefined) {
      await this.#preserveLegacyMigration(runId, result.reason);
      return;
    }
    const current = await this.#store.getRun(runId);
    if (
      result.status === "completed" &&
      !new Set<RunPhase>(["paused", "blocked", "deleting", "deleted", "failed", "completed"])
        .has(current.lifecycle.phase)
    ) {
      this.#supervisor.resumeRun(runId);
    }
  }

  async #preserveLegacyMigration(runId: string, reason: string): Promise<void> {
    await this.#server.mutateInternal(async ({ revision }) => {
      const run = await this.#store.getRun(runId);
      const migration = run.legacyGitMigration;
      if (
        migration === undefined ||
        (migration.status !== "relocation_required" && migration.status !== "preserved")
      ) {
        return this.#noOpInternal(revision);
      }
      const draft = nextRun(run, this.#timestamp());
      draft.legacyGitMigration = {
        ...structuredClone(migration),
        status: "preserved",
        reason,
        relocationIntentId: undefined,
        relocatedAt: undefined,
        retirementIntentId: undefined,
        retiredAt: undefined,
      };
      draft.git.run.status = "preserved";
      draft.git.run.blocker = reason;
      draft.lifecycle.blocker = reason;
      draft.lifecycle.runningIntent = false;
      draft.lifecycle.activeSinceMs = undefined;
      draft.activity.push(activity(
        this.#createId("activity"),
        draft.updatedAt,
        "git",
        `Legacy Git relocation preserved: ${reason}`,
      ));
      const committed = await this.#store.commit({
        expectedRevision: revision,
        runWrites: [{ record: draft, expectedRevision: run.revision }],
      });
      return {
        revision: committed.state.revision,
        events: [{ topic: "run.git.preserved", payload: { runId, reason } }],
      };
    });
  }

  /**
   * Each prepare and settle is serialized through the same authority lane as RPCs and sessions.
   * The external Git effect happens between those durable commits inside IsolatedGitLifecycle.
   */
  #gitJournal(runId: string): GitIntentJournal {
    return {
      prepare: async (intent) => {
        await this.#server.mutateInternal(async ({ revision }) =>
          this.#prepareGitIntent(runId, intent, revision));
      },
      settle: async (intentId, settlement) => {
        await this.#server.mutateInternal(async ({ revision }) =>
          this.#settleGitIntent(runId, intentId, settlement, revision));
      },
      supersedeWithCompensation: async (failedIntentId, failedSettlement, compensation) => {
        await this.#server.mutateInternal(async ({ revision }) =>
          this.#supersedeGitIntentWithCompensation(
            runId,
            failedIntentId,
            failedSettlement,
            compensation,
            revision,
          ));
      },
    };
  }

  async #prepareGitIntent(
    runId: string,
    intent: GitLifecycleIntent,
    revision: number,
  ): Promise<AuthorityMethodResult> {
    const run = await this.#store.getRun(runId);
    if (
      intent.runId !== run.id ||
      intent.projectRoot !== run.git.projectRoot ||
      intent.commonDirectory !== run.git.commonDirectory
    ) {
      throw new AuthorityRpcError("git_intent_identity", "Git intent belongs to another run or repository");
    }
    const prior = run.pendingGitIntents?.[intent.id];
    if (prior !== undefined) {
      if (canonicalJsonHash(prior) !== canonicalJsonHash(intent)) {
        throw new AuthorityRpcError("git_intent_reuse", "Git intent ID was reused with different bytes");
      }
      return this.#noOpInternal(revision);
    }
    const draft = nextRun(run, this.#timestamp());
    draft.pendingGitIntents ??= {};
    draft.pendingGitIntents[intent.id] = structuredClone(intent);
    const committed = await this.#store.commit({
      expectedRevision: revision,
      runWrites: [{ record: draft, expectedRevision: run.revision }],
    });
    return { revision: committed.state.revision };
  }

  async #settleGitIntent(
    runId: string,
    intentId: string,
    settlement: GitIntentSettlement,
    revision: number,
  ): Promise<AuthorityMethodResult> {
    const run = await this.#store.getRun(runId);
    const intent = run.pendingGitIntents?.[intentId];
    if (intent === undefined) return this.#noOpInternal(revision);
    if (
      settlement.lifecycle.runId !== run.id ||
      settlement.lifecycle.projectRoot !== run.git.projectRoot ||
      settlement.lifecycle.commonDirectory !== run.git.commonDirectory
    ) {
      throw new AuthorityRpcError("git_settlement_identity", "Git settlement belongs to another run or repository");
    }
    const draft = nextRun(run, settlement.settledAt);
    draft.git = structuredClone(settlement.lifecycle);
    draft.pendingGitIntents ??= {};
    delete draft.pendingGitIntents[intentId];
    draft.gitReceipts ??= [];
    draft.gitReceipts.push({
      intentId,
      kind: intent.kind,
      status: settlement.status,
      lifecycleSha256: canonicalJsonHash(settlement.lifecycle),
      ...this.#gitReceiptRuntimeIdentity(),
      settledAt: settlement.settledAt,
      ...(settlement.reason === undefined ? {} : { reason: settlement.reason }),
      ...(settlement.compensation === undefined
        ? {}
        : { compensation: structuredClone(settlement.compensation) }),
    });
    draft.activity.push(activity(
      this.#createId("activity"),
      settlement.settledAt,
      "git",
      settlement.status === "completed"
        ? gitActivityMessage(intent.kind)
        : `Git ${intent.kind.replaceAll("_", " ")} preserved: ${settlement.reason ?? "manual inspection required"}`,
    ));
    const committed = await this.#store.commit({
      expectedRevision: revision,
      runWrites: [{ record: draft, expectedRevision: run.revision }],
    });
    return {
      revision: committed.state.revision,
      events: [{
        topic: settlement.status === "completed" ? "run.git.updated" : "run.git.preserved",
        payload: { runId, intentId, kind: intent.kind },
      }],
    };
  }

  async #supersedeGitIntentWithCompensation(
    runId: string,
    failedIntentId: string,
    failedSettlement: GitIntentSettlement,
    compensation: Extract<GitLifecycleIntent, { kind: "forward_compensation" }>,
    revision: number,
  ): Promise<AuthorityMethodResult> {
    const run = await this.#store.getRun(runId);
    const failed = run.pendingGitIntents?.[failedIntentId];
    if (failed === undefined) {
      const existing = run.pendingGitIntents?.[compensation.id];
      if (existing !== undefined && canonicalJsonHash(existing) === canonicalJsonHash(compensation) &&
        run.gitReceipts?.some((receipt) => receipt.intentId === failedIntentId)) {
        return this.#noOpInternal(revision);
      }
      throw new AuthorityRpcError("git_intent_missing", "failed Git intent is not pending");
    }
    if (
      (failed.kind !== "ticket_publish" && failed.kind !== "target_publish") ||
      compensation.originalIntentId !== failedIntentId ||
      compensation.originalKind !== failed.kind ||
      compensation.runId !== run.id ||
      compensation.projectRoot !== run.git.projectRoot ||
      compensation.commonDirectory !== run.git.commonDirectory ||
      failedSettlement.lifecycle.runId !== run.id ||
      failedSettlement.lifecycle.projectRoot !== run.git.projectRoot ||
      failedSettlement.lifecycle.commonDirectory !== run.git.commonDirectory
    ) {
      throw new AuthorityRpcError(
        "git_compensation_identity",
        "Git compensation does not exactly supersede its failed publication",
      );
    }
    const expectedPriorOid = failed.kind === "ticket_publish"
      ? failed.expectedRunOid
      : failed.expectedTargetOid;
    const expectedCandidateOid = failed.kind === "ticket_publish"
      ? failed.squashCommitOid
      : failed.candidateOid;
    const expectedReference = failed.kind === "ticket_publish" ? failed.runRef : failed.targetRef;
    const expectedCheckout = failed.kind === "ticket_publish"
      ? failed.runWorktree
      : failed.targetCheckout;
    if (
      failedSettlement.status !== "blocked" ||
      compensation.priorOid !== expectedPriorOid ||
      compensation.candidateOid !== expectedCandidateOid ||
      compensation.reference !== expectedReference ||
      compensation.checkout !== expectedCheckout ||
      compensation.cycleId !== (failed.kind === "ticket_publish" ? failed.cycleId : undefined) ||
      failedSettlement.compensation?.originalIntentId !== failedIntentId ||
      failedSettlement.compensation.priorOid !== expectedPriorOid ||
      failedSettlement.compensation.candidateOid !== expectedCandidateOid ||
      failedSettlement.compensation.compensationOid !== undefined
    ) {
      throw new AuthorityRpcError(
        "git_compensation_contract",
        "Git compensation causal evidence does not match the failed publication",
      );
    }
    const collision = run.pendingGitIntents?.[compensation.id];
    if (collision !== undefined && canonicalJsonHash(collision) !== canonicalJsonHash(compensation)) {
      throw new AuthorityRpcError("git_intent_reuse", "Git compensation intent ID was reused");
    }
    const draft = nextRun(run, failedSettlement.settledAt);
    draft.git = structuredClone(failedSettlement.lifecycle);
    draft.pendingGitIntents ??= {};
    delete draft.pendingGitIntents[failedIntentId];
    draft.pendingGitIntents[compensation.id] = structuredClone(compensation);
    draft.gitReceipts ??= [];
    draft.gitReceipts.push({
      intentId: failedIntentId,
      kind: failed.kind,
      status: failedSettlement.status,
      lifecycleSha256: canonicalJsonHash(failedSettlement.lifecycle),
      ...this.#gitReceiptRuntimeIdentity(),
      settledAt: failedSettlement.settledAt,
      ...(failedSettlement.reason === undefined ? {} : { reason: failedSettlement.reason }),
      ...(failedSettlement.compensation === undefined
        ? {}
        : { compensation: structuredClone(failedSettlement.compensation) }),
    });
    draft.activity.push(activity(
      this.#createId("activity"),
      failedSettlement.settledAt,
      "git",
      `Git ${failed.kind.replaceAll("_", " ")} failed; forward compensation prepared`,
    ));
    const committed = await this.#store.commit({
      expectedRevision: revision,
      runWrites: [{ record: draft, expectedRevision: run.revision }],
    });
    return {
      revision: committed.state.revision,
      events: [{
        topic: "run.git.compensation.prepared",
        payload: { runId, failedIntentId, compensationIntentId: compensation.id },
      }],
    };
  }

  #legacyGitJournal(runId: string): LegacyRunGitJournal {
    return {
      prepare: async (intent) => {
        await this.#server.mutateInternal(async ({ revision }) =>
          this.#prepareGitIntent(runId, intent, revision));
      },
      settleLegacy: async (intentId, settlement) => {
        await this.#server.mutateInternal(async ({ revision }) =>
          this.#settleLegacyGitIntent(runId, intentId, settlement, revision));
      },
    };
  }

  async #settleLegacyGitIntent(
    runId: string,
    intentId: string,
    settlement: LegacyRunGitSettlement,
    revision: number,
  ): Promise<AuthorityMethodResult> {
    const run = await this.#store.getRun(runId);
    const intent = run.pendingGitIntents?.[intentId];
    if (intent === undefined) return this.#noOpInternal(revision);
    if (intent.kind !== "legacy_run_relocate" && intent.kind !== "legacy_run_retire") {
      throw new AuthorityRpcError("git_settlement_kind", "legacy settlement names a non-legacy Git intent");
    }
    if (
      settlement.lifecycle.runId !== run.id ||
      settlement.lifecycle.projectRoot !== run.git.projectRoot ||
      settlement.lifecycle.commonDirectory !== run.git.commonDirectory ||
      settlement.migration.sourceGitSha256 !== run.legacyGitMigration?.sourceGitSha256 ||
      (settlement.operation === "relocate") !== (intent.kind === "legacy_run_relocate")
    ) {
      throw new AuthorityRpcError(
        "git_settlement_identity",
        "legacy Git settlement belongs to another run, source, or operation",
      );
    }
    const draft = nextRun(run, settlement.settledAt);
    draft.git = structuredClone(settlement.lifecycle);
    draft.legacyGitMigration = structuredClone(settlement.migration);
    draft.pendingGitIntents ??= {};
    delete draft.pendingGitIntents[intentId];
    if (settlement.status === "completed" && settlement.operation === "relocate") {
      for (const ticketId of settlement.clearTicketProjectionIds) {
        const ticket = draft.tickets[ticketId];
        if (ticket === undefined) {
          throw new AuthorityRpcError(
            "legacy_ticket_projection",
            `legacy relocation ticket projection disappeared: ${ticketId}`,
          );
        }
        ticket.worktreePath = undefined;
        ticket.branch = undefined;
        delete ticket.gitCycleId;
        ticket.updatedAt = settlement.settledAt;
      }
      if (draft.lifecycle.phase === "blocked") {
        restoreLegacyLifecycle(draft, settlement.settledAt);
      }
    } else if (
      settlement.status === "blocked" &&
      draft.lifecycle.phase !== "deleting" &&
      draft.lifecycle.phase !== "deleted"
    ) {
      draft.lifecycle.blocker = settlement.reason ?? "Legacy Git resources require operator inspection";
      draft.lifecycle.runningIntent = false;
      draft.lifecycle.activeSinceMs = undefined;
    }
    draft.gitReceipts ??= [];
    draft.gitReceipts.push({
      intentId,
      kind: intent.kind,
      status: settlement.status,
      lifecycleSha256: canonicalJsonHash(settlement.lifecycle),
      ...this.#gitReceiptRuntimeIdentity(),
      settledAt: settlement.settledAt,
      ...(settlement.reason === undefined ? {} : { reason: settlement.reason }),
    });
    draft.activity.push(activity(
      this.#createId("activity"),
      settlement.settledAt,
      "git",
      settlement.status === "completed"
        ? gitActivityMessage(intent.kind)
        : `Git ${intent.kind.replaceAll("_", " ")} preserved: ${settlement.reason ?? "manual inspection required"}`,
    ));
    const committed = await this.#store.commit({
      expectedRevision: revision,
      runWrites: [{ record: draft, expectedRevision: run.revision }],
    });
    return {
      revision: committed.state.revision,
      events: [{
        topic: settlement.status === "completed" ? "run.git.updated" : "run.git.preserved",
        payload: { runId, intentId, kind: intent.kind },
      }],
    };
  }

  async #recoverPendingChecks(runId: string): Promise<void> {
    const run = await this.#store.getRun(runId);
    const pending = Object.values(run.pendingChecks ?? {}).sort((left, right) => left.id.localeCompare(right.id));
    if (pending.length === 0 || run.lifecycle.phase === "deleting" || run.lifecycle.phase === "deleted") return;
    // External commands are deliberately never replayed from a mere intent: a prior process may
    // have produced workspace effects before the authority crashed. The run remains resumable only
    // after the compiler/operator reconciles that exact intent.
    await this.#recordRunBlocker(
      runId,
      `Configured check ${pending[0]!.requestedCheckId} was interrupted before an authenticated result; reconcile intent ${pending[0]!.id}`,
    );
  }

  async #recoverWorkspaceEffects(runId: string): Promise<void> {
    let run = await this.#store.getRun(runId);
    const effectIds = Object.keys(run.pendingEffects ?? {}).sort();
    for (const effectId of effectIds) {
      run = await this.#store.getRun(runId);
      const intent = run.pendingEffects?.[effectId];
      if (intent === undefined) continue;
      if (run.lifecycle.phase === "deleting" || run.lifecycle.phase === "deleted") continue;
      const attempt = run.attempts[intent.attemptId];
      if (attempt === undefined || this.#program.recoverAttempt === undefined) {
        await this.#recordRunBlocker(runId, `Cannot recover workspace effect ${effectId}: attempt compiler state is unavailable`);
        return;
      }
      try {
        const spec = await this.#loadStoredLaunchSpec(run, attempt);
        const prepared = await this.#program.recoverAttempt({ run, attempt, spec });
        assertRecoveredAuthorityPlan(prepared, spec, this.#projectRoot, this.#stateRoot);
        const grant = prepared.authorityGrant;
        if (
          grant === undefined ||
          spec.specHash !== intent.specHash ||
          spec.authority.grantHash !== intent.grantHash ||
          canonicalHash(grant) !== intent.grantHash ||
          grant.attemptId !== attempt.id ||
          !grant.allowedTools.includes(intent.toolName)
        ) {
          throw new AuthorityRpcError("effect_grant", "pending workspace effect differs from its launch grant");
        }
        const bytes = await this.#store.readArtifact(
          intent.contentArtifactPath,
          Math.max(1, intent.contentSizeBytes + 1),
        );
        if (bytes.byteLength !== intent.contentSizeBytes || rawSha256(bytes) !== intent.desiredSha256) {
          throw new AuthorityRpcError("effect_content", "pending workspace effect content changed");
        }
        const paths = await WorktreePathAuthority.create(spec.workspace.cwd, {
          readPaths: grant.readPaths,
          writePaths: grant.writePaths,
        });
        await applyWorkspaceEffect(paths, intent, bytes);
        await this.#finalizeRecoveredWorkspaceEffect(runId, effectId, intent);
      } catch (error) {
        await this.#recordRunBlocker(
          runId,
          `Workspace effect ${effectId} requires reconciliation: ${errorMessage(error)}`,
        );
        return;
      }
    }
  }

  async #finalizeRecoveredWorkspaceEffect(
    runId: string,
    effectId: string,
    expected: WorkspaceEffectIntentRecord,
  ): Promise<void> {
    await this.#server.mutateInternal(async ({ revision }) => {
      const run = await this.#store.getRun(runId);
      const intent = run.pendingEffects?.[effectId];
      if (intent === undefined) return this.#noOpInternal(revision);
      if (canonicalHash(intent) !== canonicalHash(expected)) {
        throw new AuthorityRpcError("effect_intent", "pending workspace effect changed during recovery");
      }
      const attempt = run.attempts[intent.attemptId];
      if (attempt === undefined) throw new AuthorityRpcError("effect_attempt", "pending effect attempt is missing");
      const receipt = workspaceEffectReceipt(intent);
      const receiptPath = toolReceiptPath(run.id, attempt.id, intent.callId);
      const receiptBytes = encodeJsonArtifact(receipt);
      const draft = nextRun(run, this.#timestamp());
      authorizeToolResultFromDigests(
        draft.attempts[attempt.id]!,
        intent.callId,
        intent.toolName,
        intent.argumentsSha256,
        intent.argumentsSizeBytes,
        receipt,
        receiptPath,
        draft.updatedAt,
      );
      delete (draft.pendingEffects ?? {})[effectId];
      const committed = await this.#store.commit({
        expectedRevision: revision,
        runWrites: [{ record: draft, expectedRevision: run.revision }],
        writes: [{ path: receiptPath, bytes: receiptBytes, expectedSha256: null }],
        receipt: {
          method: intent.method,
          idempotencyKey: intent.idempotencyKey,
          requestHash: intent.requestHash,
          result: { artifact: receiptPath, sha256: rawSha256(receiptBytes) },
        },
      });
      return {
        revision: committed.state.revision,
        events: [{
          topic: "agent.tool.recovered",
          payload: {
            runId,
            attemptId: attempt.id,
            tool: intent.toolName,
            callId: intent.callId,
          },
        }],
      };
    });
  }

  /** Called by the authority-backed question tool after its compiler validation. */
  public async openQuestion(input: {
    runId: string;
    attemptId: string;
    prompt: string;
    options: RunQuestionRecord["options"];
    allowsNotes: boolean;
  }): Promise<RunQuestionRecord> {
    const questionId = this.#createId("question");
    const askedAt = this.#timestamp();
    let created: RunQuestionRecord | undefined;
    await this.#server.mutateInternal(async ({ revision }) => {
      const run = await this.#store.getRun(input.runId);
      const attempt = run.attempts[input.attemptId];
      if (attempt === undefined || attempt.status !== "running") {
        throw new AuthorityRpcError("attempt_inactive", "question attempt is not active");
      }
      const draft = nextRun(run, askedAt);
      created = {
        id: questionId,
        attemptId: input.attemptId,
        prompt: boundedText(input.prompt, "question prompt", 1024 * 1024),
        options: validateQuestionOptions(input.options),
        allowsNotes: input.allowsNotes,
        askedAt,
        answeredAt: undefined,
        selectedOptionId: undefined,
        notes: undefined,
      };
      draft.questions[questionId] = created;
      applyLifecycle(draft, {
        type: "question_opened",
        atMs: this.#now().getTime(),
        question: { id: questionId, attemptId: input.attemptId },
      });
      draft.attempts[input.attemptId]!.status = "waiting_question";
      const committed = await this.#store.commit({
        expectedRevision: revision,
        runWrites: [{ record: draft, expectedRevision: run.revision }],
      });
      return {
        revision: committed.state.revision,
        events: [{ topic: "run.question.opened", payload: { runId: run.id, questionId } }],
      };
    });
    return structuredClone(created!);
  }

  #registerMethods(): void {
    this.#server.register("project.status", {
      mutating: false,
      handle: async () => {
        const state = await this.#store.state();
        return {
          result: {
            projectRoot: this.#projectRoot,
            version: this.#version,
            revision: state.revision,
            runCount: state.runIds.length,
          },
        };
      },
    });
    this.#server.register("authority.quiesce", {
      mutating: true,
      handle: async ({ request, revision }) => this.#quiesceAuthority(request, revision),
    });
    this.#server.register("branches.list", {
      mutating: false,
      handle: async ({ request }) => ({
        result: await this.#withGit("$project", () =>
          this.#git.recentTargetBranches(optionalPositiveInt(request.params, "limit", 20))),
      }),
    });
    this.#server.register("control.catalog", {
      mutating: false,
      handle: async () => {
        if (this.#program.controlCatalog === undefined) {
          throw new AuthorityRpcError("control_catalog_unavailable", "compiler does not expose launch options");
        }
        return { result: await this.#program.controlCatalog() as unknown as JsonValue };
      },
    });
    this.#server.register("config.catalog", {
      mutating: false,
      handle: async () => {
        const packageRoot = await this.#currentProfilePackageRoot();
        return {
          result: await buildConfigSurfaceCatalog(this.#projectRoot, packageRoot) as unknown as JsonValue,
        };
      },
    });
    this.#server.register("config.get", {
      mutating: false,
      handle: async () => {
        const packageRoot = await this.#currentProfilePackageRoot();
        return {
          result: await buildConfigSurfaceSnapshot(this.#projectRoot, packageRoot) as unknown as JsonValue,
        };
      },
    });
    this.#server.register("config.update", {
      mutating: true,
      handle: async ({ request, revision }) => this.#updateConfiguration(request, revision),
    });
    for (const kind of ["create", "duplicate", "delete"] as const) {
      this.#server.register(`config.resource.${kind}`, {
        mutating: true,
        handle: async ({ request, revision }) => this.#mutateConfigurationResource(request, revision, kind),
      });
    }
    this.#server.register("run.list", {
      mutating: false,
      handle: async () => ({ result: await this.#store.listRuns() as unknown as JsonValue }),
    });
    this.#server.register("run.get", {
      mutating: false,
      handle: async ({ request }) => ({
        result: await this.#store.getRun(requiredString(request.params, "runId")) as unknown as JsonValue,
      }),
    });
    this.#server.register("run.graph", {
      mutating: false,
      handle: async ({ request }) => {
        const run = await this.#store.getRun(requiredString(request.params, "runId"));
        const ticketId = optionalString(request.params, "ticketId");
        if (ticketId !== undefined && run.tickets[ticketId] === undefined) {
          throw new AuthorityRpcError("ticket_missing", "graph projection ticket does not exist");
        }
        const graph = this.#program.projectGraph === undefined
          ? { nodes: [], edges: [] }
          : await this.#program.projectGraph(run, ticketId);
        return { result: graph as unknown as JsonValue };
      },
    });
    this.#server.register("run.transcript", {
      mutating: false,
      handle: async ({ request }) => {
        const run = await this.#store.getRun(requiredString(request.params, "runId"));
        const attemptId = requiredString(request.params, "attemptId");
        const attempt = run.attempts[attemptId];
        if (attempt === undefined || attempt.sessionFile === undefined) {
          throw new AuthorityRpcError("transcript_missing", "attempt has no persisted Pi transcript");
        }
        const spec = await this.#loadStoredLaunchSpec(run, attempt);
        const expectedSessionFile = path.join(spec.workspace.sessionDirectory, `${attempt.sessionId}.jsonl`);
        if (path.resolve(attempt.sessionFile) !== path.resolve(expectedSessionFile)) {
          throw new AuthorityRpcError("transcript_path", "attempt transcript path differs from its launch spec");
        }
        const session = await readPiSession(expectedSessionFile, { allowTruncatedTail: true });
        if (session.header.id !== attempt.sessionId) {
          throw new AuthorityRpcError("transcript_identity", "Pi transcript belongs to another session");
        }
        return {
          result: {
            header: session.header,
            entries: session.entries,
            diagnostics: session.diagnostics,
          } as unknown as JsonValue,
        };
      },
    });
    this.#server.register("migration.legacy.preview", {
      mutating: false,
      handle: async ({ request }) => ({
        result: await this.#previewLegacyRunAdoption(request),
      }),
    });
    this.#server.register("migration.legacy.adopt", {
      mutating: true,
      handle: async ({ request, revision }) => this.#adoptLegacyRun(request, revision),
    });
    this.#server.register("run.create", {
      mutating: true,
      handle: async ({ request, revision }) => this.#createRun(request, revision),
    });
    this.#server.register("run.pause", {
      mutating: true,
      handle: async ({ request, revision }) => this.#pauseRun(request, revision),
    });
    this.#server.register("run.resume", {
      mutating: true,
      handle: async ({ request, revision }) => this.#resumeRun(request, revision),
    });
    this.#server.register("run.delete", {
      mutating: true,
      handle: async ({ request, revision }) => this.#deleteRun(request, revision),
    });
    this.#server.register("plan.approve", {
      mutating: true,
      handle: async ({ request, revision }) => this.#approvePlan(request, revision),
    });
    this.#server.register("plan.revise", {
      mutating: true,
      handle: async ({ request, revision }) => this.#revisePlan(request, revision),
    });
    this.#server.register("question.answer", {
      mutating: true,
      handle: async ({ request, revision }) => this.#answerQuestion(request, revision),
    });
    this.#server.register("run.merge", {
      mutating: true,
      handle: async ({ request, revision }) => this.#mergeRun(request, revision),
    });
    this.#server.register("agent.steer", {
      mutating: true,
      handle: async ({ request, revision }) => this.#steerAttempt(request, revision, false),
    });
    this.#server.register("agent.follow_up", {
      mutating: true,
      handle: async ({ request, revision }) => this.#steerAttempt(request, revision, true),
    });
    this.#server.register("authority.tick", {
      mutating: true,
      handle: async ({ request, revision }) => {
        const runId = requiredString(request.params, "runId");
        await this.#commitReceiptOnly(request, revision, { runId, accepted: true });
        this.#background(() => this.#tick(runId), runId);
        return { result: { runId, accepted: true }, revision: revision + 1 };
      },
    });
  }

  async #previewLegacyRunAdoption(request: RpcRequest): Promise<JsonValue> {
    const migrationId = requiredString(request.params, "migrationId");
    const selectedRunId = optionalString(request.params, "runId");
    let evidence: LoadedLegacyRunMigrationEvidence;
    try {
      evidence = await loadLegacyRunMigrationEvidence(this.#projectRoot, migrationId);
    } catch (error) {
      throw new AuthorityRpcError(errorCode(error) ?? "legacy_migration_evidence", errorMessage(error));
    }
    const indexed = selectedRunId === undefined
      ? evidence.compatibility.runs
      : evidence.compatibility.runs.filter((run) => run.id === selectedRunId);
    if (selectedRunId !== undefined && indexed.length === 0) {
      throw new AuthorityRpcError("legacy_run_missing", `legacy run is not indexed: ${selectedRunId}`);
    }
    const current = await this.#store.listRuns({ includeDeleted: true });
    const runs: JsonValue[] = [];
    for (const source of indexed) {
      const existing = current.find((run) =>
        run.legacyRunAdoption?.migrationId === migrationId &&
        run.legacyRunAdoption.sourceRunId === source.id);
      if (existing !== undefined) {
        runs.push({
          protocol: "koni.legacy-run-adoption-preview.v1",
          migrationId,
          runId: source.id,
          sourceStatus: source.status,
          objective: source.goal,
          disposition: "adopted",
          successorRunId: existing.id,
          successorPhase: existing.lifecycle.phase,
        });
        continue;
      }
      const assessed = await assessLegacyRunAdoption(evidence, source.id);
      runs.push(await this.#withCurrentRunCompatibility(assessed) as unknown as JsonValue);
    }
    return {
      protocol: "koni.legacy-run-adoption-catalog.v1",
      migrationId,
      projectRoot: this.#projectRoot,
      sourceRetained: true,
      runs,
    };
  }

  async #withCurrentRunCompatibility(
    assessment: LegacyRunAdoptionAssessment,
  ): Promise<LegacyRunAdoptionAssessment> {
    if (assessment.disposition !== "ready" || assessment.start === undefined) {
      return structuredClone(assessment);
    }
    const runTypeId = assessment.runTypeId;
    if (runTypeId === undefined) return structuredClone(assessment);
    const blockers: LegacyRunAdoptionBlocker[] = [];
    try {
      const definition = await this.#program.resolveRun({
        runId: `legacy-preview-${canonicalHash({
          migrationId: assessment.migrationId,
          runId: assessment.runId,
        }).slice("sha256:".length, "sha256:".length + 24)}`,
        objective: assessment.objective,
        runTypeId,
        targetRef: assessment.start.targetRef,
        intake: { goal: assessment.objective },
      });
      if (definition.planningMode !== "agent") {
        blockers.push({
          code: "fresh_successor_unavailable",
          message: "current run type has no planner and cannot issue the required fresh recovery attempt",
        });
      }
    } catch (error) {
      blockers.push({
        code: "current_run_type_incompatible",
        message: `current profile cannot compile this legacy run type: ${errorMessage(error)}`,
      });
    }
    if (blockers.length === 0) return structuredClone(assessment);
    return {
      ...structuredClone(assessment),
      disposition: "blocked",
      blockers,
      start: undefined,
    };
  }

  async #adoptLegacyRun(
    request: RpcRequest,
    revision: number,
  ): Promise<AuthorityMethodResult> {
    requireIdempotency(request);
    const migrationId = requiredString(request.params, "migrationId");
    const sourceRunId = requiredString(request.params, "runId");
    const existing = (await this.#store.listRuns({ includeDeleted: true })).find((run) =>
      run.legacyRunAdoption?.migrationId === migrationId &&
      run.legacyRunAdoption.sourceRunId === sourceRunId);
    if (existing !== undefined) {
      const result: JsonValue = {
        migrationId,
        sourceRunId,
        successorRunId: existing.id,
        status: "already_adopted",
        phase: existing.lifecycle.phase,
        sourceRetained: true,
      };
      const committed = await this.#store.commit({
        expectedRevision: revision,
        receipt: receiptFor(request, result),
      });
      return { result, revision: committed.state.revision };
    }

    let evidence: LoadedLegacyRunMigrationEvidence;
    let assessed: LegacyRunAdoptionAssessment;
    try {
      evidence = await loadLegacyRunMigrationEvidence(this.#projectRoot, migrationId);
      assessed = await assessLegacyRunAdoption(evidence, sourceRunId);
      assessed = await this.#withCurrentRunCompatibility(assessed);
    } catch (error) {
      throw new AuthorityRpcError(errorCode(error) ?? "legacy_migration_evidence", errorMessage(error));
    }
    if (assessed.disposition !== "ready" || assessed.start === undefined) {
      throw new AuthorityRpcError(
        "legacy_adoption_blocked",
        `legacy run ${sourceRunId} cannot be adopted safely`,
        { details: { blockers: assessed.blockers } as unknown as JsonValue },
      );
    }
    if (
      assessed.runTypeId === undefined ||
      evidence.compatibility.sourceRegistrySha256 === null ||
      evidence.compatibility.barrierEvidenceSha256 === undefined
    ) {
      throw new AuthorityRpcError(
        "legacy_adoption_blocked",
        "legacy run lacks a pinned run type, source registry, or quiescence barrier",
      );
    }

    const successorRunId = this.#createId("run");
    let definition: ResolvedRunDefinition;
    try {
      definition = await this.#program.resolveRun({
        runId: successorRunId,
        objective: assessed.objective,
        runTypeId: assessed.runTypeId,
        targetRef: assessed.start.targetRef,
        intake: { goal: assessed.objective },
      });
    } catch (error) {
      throw new AuthorityRpcError(
        "current_run_type_incompatible",
        `current profile cannot compile this legacy run type: ${errorMessage(error)}`,
      );
    }
    if (definition.planningMode !== "agent") {
      throw new AuthorityRpcError(
        "fresh_successor_unavailable",
        "current run type has no planner and cannot issue the required fresh recovery attempt",
      );
    }
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(definition.workingSpecOwnerId) ||
      definition.executionConfig.agents[definition.workingSpecOwnerId] === undefined
    ) {
      throw new AuthorityRpcError(
        "working_spec_owner",
        "compiler did not resolve exactly one configured managed working-spec owner",
      );
    }
    const git = await this.#withGit(successorRunId, () => this.#git.planAdoptedRun(
      successorRunId,
      {
        targetRef: assessed.start!.targetRef,
        targetSelectedOid: assessed.start!.targetSelectedOid,
        planningBaseOid: assessed.start!.planningBaseOid,
      },
    ));

    // Re-hash and re-prove after current configuration/Git planning, immediately before the one
    // durable admission transaction. A changed source never produces a partial successor.
    const finalAssessment = await assessLegacyRunAdoption(evidence, sourceRunId);
    if (
      finalAssessment.disposition !== "ready" ||
      finalAssessment.start === undefined ||
      canonicalHash(finalAssessment.start) !== canonicalHash(assessed.start)
    ) {
      const blockers = finalAssessment.blockers.length === 0
        ? [{
            code: "legacy_run_changed" as const,
            message: "legacy run adoption inputs changed before authority admission",
          }]
        : finalAssessment.blockers;
      throw new AuthorityRpcError(
        "legacy_adoption_blocked",
        `legacy run ${sourceRunId} changed before adoption`,
        { details: { blockers } as unknown as JsonValue },
      );
    }

    const now = this.#timestamp();
    const lifecycle = newRunLifecycle(successorRunId);
    lifecycle.revision = 1;
    lifecycle.phase = "paused";
    lifecycle.resumePhase = "draft";
    const legacyRunAdoption: LegacyRunAdoptionRecord = {
      protocol: "koni.legacy-run-adoption.v1",
      migrationId,
      sourceRunId,
      sourceStatus: finalAssessment.sourceStatus as LegacyRunAdoptionRecord["sourceStatus"],
      sourceTreeSha256: evidence.compatibility.runs.find((run) => run.id === sourceRunId)!.treeSha256,
      sourceRegistrySha256: evidence.compatibility.sourceRegistrySha256,
      migrationPlanBytesSha256: evidence.planBytesSha256,
      migrationPlanSha256: evidence.plan.planSha256,
      compatibilityIndexSha256: evidence.compatibilityIndexSha256,
      migrationReceiptSha256: evidence.receiptSha256,
      barrierEvidenceSha256: evidence.compatibility.barrierEvidenceSha256,
      targetRef: finalAssessment.start.targetRef,
      targetSelectedOid: finalAssessment.start.targetSelectedOid,
      planningBaseOid: finalAssessment.start.planningBaseOid,
      sourceGit: structuredClone(finalAssessment.start.sourceGit),
      sessionLineage: {
        kind: "fresh_successor",
        reason: "Rust-era transport logs are retained as evidence; a new Pi session owns recovery",
      },
      adoptedAt: now,
      sourceRetained: true,
    };
    const run: RunRecord = {
      protocol: "koni.run-record.v1",
      id: successorRunId,
      revision: 0,
      generation: 0,
      projectRoot: git.projectRoot,
      profile: structuredClone(definition.profile),
      compiledConfigHash: definition.compiledConfigHash,
      runTypeId: definition.runTypeId,
      workingSpecOwnerId: definition.workingSpecOwnerId,
      planningMode: definition.planningMode,
      objective: assessed.objective,
      intake: { goal: assessed.objective },
      executionConfig: structuredClone(definition.executionConfig),
      createdAt: now,
      updatedAt: now,
      lifecycle,
      pipelineStageIds: [...definition.pipelineStageIds],
      currentPipelineStageId: definition.pipelineStageIds[0],
      plan: undefined,
      graphRevision: 0,
      graphHash: undefined,
      tickets: {},
      attempts: {},
      checks: [],
      pendingEffects: {},
      pendingChecks: {},
      questions: {},
      activity: [activity(
        this.#createId("activity"),
        now,
        "compiler",
        `Adopted legacy run ${sourceRunId}; paused before fresh Pi recovery planning`,
      )],
      git,
      legacyRunAdoption,
      pendingGitIntents: {},
      gitReceipts: [],
    };
    const result: JsonValue = {
      migrationId,
      sourceRunId,
      successorRunId,
      status: "adopted_paused",
      phase: "paused",
      sessionLineage: "fresh_successor",
      sourceRetained: true,
    };
    const adoptionBytes = Buffer.from(`${JSON.stringify(legacyRunAdoption)}\n`, "utf8");
    const committed = await this.#store.commit({
      expectedRevision: revision,
      runWrites: [{ record: run, expectedRevision: null }],
      writes: [
        ...(definition.artifactWrites ?? []),
        {
          path: `runs/${successorRunId}/legacy-adoption.json`,
          bytes: adoptionBytes,
          expectedSha256: null,
        },
      ],
      receipt: receiptFor(request, result),
    });
    return {
      result,
      revision: committed.state.revision,
      events: [{
        topic: "migration.legacy.adopted",
        payload: { migrationId, sourceRunId, successorRunId },
      }],
    };
  }

  async #createRun(request: RpcRequest, revision: number): Promise<AuthorityMethodResult> {
    requireIdempotency(request);
    const params = requiredObject(request.params);
    const objective = boundedText(requiredString(params, "objective"), "objective", 4 * 1024 * 1024);
    const runTypeId = requiredString(params, "runTypeId");
    const targetRef = requiredString(params, "targetRef");
    const intake = stringRecord(params.intake ?? { goal: objective }, "intake");
    const runId = this.#createId("run");
    const definition = await this.#program.resolveRun({
      runId,
      objective,
      runTypeId,
      targetRef,
      intake,
      ...(params.overrides === undefined ? {} : { overrides: params.overrides as JsonValue }),
    });
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(definition.workingSpecOwnerId) ||
      definition.executionConfig.agents[definition.workingSpecOwnerId] === undefined
    ) {
      throw new AuthorityRpcError(
        "working_spec_owner",
        "compiler did not resolve exactly one configured managed working-spec owner",
      );
    }
    const git = await this.#withGit(runId, () => this.#git.planRun(runId, targetRef));
    const now = this.#timestamp();
    const run: RunRecord = {
      protocol: "koni.run-record.v1",
      id: runId,
      revision: 0,
      generation: 0,
      projectRoot: git.projectRoot,
      profile: structuredClone(definition.profile),
      compiledConfigHash: definition.compiledConfigHash,
      runTypeId: definition.runTypeId,
      workingSpecOwnerId: definition.workingSpecOwnerId,
      objective,
      intake,
      executionConfig: structuredClone(definition.executionConfig),
      planningMode: definition.planningMode,
      createdAt: now,
      updatedAt: now,
      lifecycle: newRunLifecycle(runId),
      pipelineStageIds: [...definition.pipelineStageIds],
      currentPipelineStageId: definition.pipelineStageIds[0],
      plan: undefined,
      graphRevision: 0,
      graphHash: undefined,
      tickets: {},
      attempts: {},
      checks: [],
      pendingEffects: {},
      pendingChecks: {},
      questions: {},
      activity: [activity(this.#createId("activity"), now, "compiler", "Run created")],
      git,
      pendingGitIntents: {},
      gitReceipts: [],
    };
    const result: JsonValue = { runId, status: "starting" };
    const committed = await this.#store.commit({
      expectedRevision: revision,
      runWrites: [{ record: run, expectedRevision: null }],
      receipt: receiptFor(request, result),
      ...(definition.artifactWrites === undefined ? {} : { writes: definition.artifactWrites }),
    });
    this.#background(() => this.#initializeRun(runId), runId);
    return {
      result,
      revision: committed.state.revision,
      events: [{ topic: "run.created", payload: { runId } }],
    };
  }

  async #currentProfilePackageRoot(): Promise<string> {
    if (this.#profilePackageRootLoader === undefined) {
      throw new AuthorityRpcError(
        "config_unavailable",
        "authority was not started with a verified profile package source",
      );
    }
    return this.#profilePackageRootLoader();
  }

  async #updateConfiguration(request: RpcRequest, revision: number): Promise<AuthorityMethodResult> {
    requireIdempotency(request);
    const params = requiredObject(request.params);
    if (params.cas === undefined) throw new AuthorityRpcError("params", "configuration CAS is required");
    const values = requiredObject(params.values);
    const packageRoot = await this.#currentProfilePackageRoot();
    let changedDocuments = 0;
    let snapshot: Awaited<ReturnType<typeof buildConfigSurfaceSnapshot>>;
    try {
      const published = await publishConfigSurfaceSnapshot({
        projectRoot: this.#projectRoot,
        profilePackageRoot: packageRoot,
        cas: params.cas,
        values,
      });
      changedDocuments = published.changedDocuments;
      snapshot = published.snapshot;
    } catch (error) {
      const code = errorCode(error);
      if (code !== "config_source_changed" && code !== "config_fields_changed" && code !== "lifecycle_changed") {
        const details = errorDetails(error);
        throw new AuthorityRpcError(
          code ?? "config_update",
          errorMessage(error),
          details === undefined ? {} : { details },
        );
      }
      // If the profile transaction committed before an authority crash, an exact retry is a
      // success even though its old CAS is stale. Different current values still fail closed.
      const current = await buildConfigSurfaceSnapshot(this.#projectRoot, packageRoot);
      if (canonicalJsonHash(current.values) !== canonicalJsonHash(values)) {
        throw new AuthorityRpcError(code, errorMessage(error), { retryable: true });
      }
      snapshot = current;
    }
    const result: JsonValue = {
      protocol: "koni.config-update-result.v1",
      changedDocuments,
      snapshot: snapshot as unknown as JsonValue,
    };
    const committed = await this.#store.commit({
      expectedRevision: revision,
      receipt: receiptFor(request, result),
    });
    return {
      result,
      revision: committed.state.revision,
      events: [{ topic: "config.updated", payload: { changedDocuments } }],
    };
  }

  async #mutateConfigurationResource(
    request: RpcRequest,
    revision: number,
    kind: "create" | "duplicate" | "delete",
  ): Promise<AuthorityMethodResult> {
    requireIdempotency(request);
    const params = requiredObject(request.params);
    if (params.cas === undefined) throw new AuthorityRpcError("params", "configuration CAS is required");
    const requestSha256 = authorityRequestHash(request.method, request.params);
    const mutationMarker = {
      // The exact semantic request, rather than the transport idempotency key, identifies the
      // same-filesystem witness. A control center restarted after publication can therefore
      // safely recognize the already-applied action even if it allocates a fresh RPC key.
      id: requestSha256.slice("sha256:".length),
      requestSha256,
    };
    const packageRoot = await this.#currentProfilePackageRoot();
    let recovered = false;
    let published = await recoverConfigSurfaceResourceMutation({
      projectRoot: this.#projectRoot,
      profilePackageRoot: packageRoot,
      mutationMarker,
    });
    try {
      if (published === undefined) {
        if (kind === "create") {
          const parentResourceId = optionalString(request.params, "parentResourceId");
          published = await createConfigSurfaceResource({
            projectRoot: this.#projectRoot,
            profilePackageRoot: packageRoot,
            cas: params.cas,
            sectionId: requiredString(request.params, "sectionId"),
            templateId: requiredString(request.params, "templateId"),
            name: requiredString(request.params, "name"),
            ...(parentResourceId === undefined ? {} : { parentResourceId }),
            mutationMarker,
          });
        } else if (kind === "duplicate") {
          published = await duplicateConfigSurfaceResource({
            projectRoot: this.#projectRoot,
            profilePackageRoot: packageRoot,
            cas: params.cas,
            resourceId: requiredString(request.params, "resourceId"),
            name: requiredString(request.params, "name"),
            mutationMarker,
          });
        } else {
          published = await deleteConfigSurfaceResource({
            projectRoot: this.#projectRoot,
            profilePackageRoot: packageRoot,
            cas: params.cas,
            resourceId: requiredString(request.params, "resourceId"),
            mutationMarker,
          });
        }
      } else {
        recovered = true;
      }
    } catch (error) {
      const code = errorCode(error) ?? "config_resource_mutation";
      const details = errorDetails(error);
      throw new AuthorityRpcError(
        code,
        errorMessage(error),
        details === undefined ? {} : { details },
      );
    }
    const result: JsonValue = {
      protocol: "koni.config-resource-mutation-result.v1",
      kind,
      changedDocuments: published.changedDocuments,
      recovered,
      catalog: published.catalog as unknown as JsonValue,
      snapshot: published.snapshot as unknown as JsonValue,
    };
    const committed = await this.#store.commit({
      expectedRevision: revision,
      receipt: receiptFor(request, result),
    });
    return {
      result,
      revision: committed.state.revision,
      events: [{ topic: "config.updated", payload: { changedDocuments: published.changedDocuments } }],
    };
  }

  async #initializeRun(runId: string): Promise<void> {
    let run = await this.#store.getRun(runId);
    if (run.lifecycle.phase !== "draft") return;
    await this.#withGit(runId, () =>
      this.#git.materializePlanning(run.git, this.#gitJournal(runId)));
    await this.#server.mutateInternal(async ({ revision }) => {
      run = await this.#store.getRun(runId);
      if (run.lifecycle.phase !== "draft") return this.#noOpInternal(revision);
      const direct = run.planningMode === "direct"
        ? await this.#program.initializeDirectApproval(run)
        : undefined;
      const draft = nextRun(run, this.#timestamp());
      applyLifecycle(draft, { type: "planning_started", atMs: this.#now().getTime() });
      if (direct === undefined) {
        draft.currentPipelineStageId = firstPlanningStage(draft);
      } else {
        draft.plan = { ...structuredClone(direct.plan), status: "awaiting_approval" };
        if (direct.graphHash !== undefined) draft.graphHash = direct.graphHash;
        if (direct.graphRevision !== undefined) draft.graphRevision = direct.graphRevision;
        if (direct.tickets !== undefined) draft.tickets = structuredClone(direct.tickets);
        draft.activity.push(...structuredClone(direct.activity ?? []));
        draft.currentPipelineStageId = approvalStage(draft);
        applyLifecycle(draft, { type: "plan_submitted", atMs: this.#now().getTime() });
      }
      const committed = await this.#store.commit({
        expectedRevision: revision,
        runWrites: [{ record: draft, expectedRevision: run.revision }],
        ...(direct?.artifactWrites === undefined ? {} : { writes: direct.artifactWrites }),
      });
      return {
        revision: committed.state.revision,
        events: [{
          topic: direct === undefined ? "run.planning.started" : "run.plan.ready",
          payload: direct === undefined ? { runId } : { runId, directApproval: true },
        }],
      };
    });
    const initialized = await this.#store.getRun(runId);
    if (initialized.lifecycle.phase === "planning") await this.#launchPlanning(runId);
  }

  async #pauseRun(request: RpcRequest, revision: number): Promise<AuthorityMethodResult> {
    requireIdempotency(request);
    const runId = requiredString(request.params, "runId");
    const run = await this.#store.getRun(runId);
    const draft = nextRun(run, this.#timestamp());
    applyLifecycle(draft, { type: "pause_requested", atMs: this.#now().getTime() });
    const result: JsonValue = { runId, status: "pausing" };
    const committed = await this.#store.commit({
      expectedRevision: revision,
      runWrites: [{ record: draft, expectedRevision: run.revision }],
      receipt: receiptFor(request, result),
    });
    // abortByRun installs its admission tombstone synchronously before returning its promise.
    const aborted = this.#supervisor.abortByRun(runId, "run paused by operator");
    this.#background(async () => { await aborted; await this.#settlePause(runId); }, runId);
    return { result, revision: committed.state.revision };
  }

  /**
   * Stable cross-build shutdown boundary used by `koni stop/restart`.
   *
   * The compatibility client cannot invoke any other method. This operation
   * durably pauses every pausable run, waits for its contained sessions to
   * abort, records interrupted attempts, and only then asks the daemon to exit.
   * Transient Git/delete windows are retried rather than being interrupted in
   * an ambiguous external-effect phase.
   */
  async #quiesceAuthority(request: RpcRequest, revision: number): Promise<AuthorityMethodResult> {
    requireIdempotency(request);
    const runs = await this.#store.listRuns({ includeDeleted: true });
    const busy = runs.filter((run) =>
      new Set<RunPhase>(["draft", "merging", "deleting"]).has(run.lifecycle.phase)
    );
    if (busy.length > 0) {
      throw new AuthorityRpcError(
        "authority_quiesce_busy",
        "authority is settling a non-interruptible lifecycle transition; retry restart shortly",
        {
          retryable: true,
          details: {
            runs: busy.map((run) => ({ runId: run.id, phase: run.lifecycle.phase })),
          },
        },
      );
    }

    const pausable = new Set<RunPhase>([
      "planning",
      "awaiting_questions",
      "awaiting_approval",
      "approving",
      "executing",
      "verifying",
      "merge_ready",
    ]);
    const newlyPaused = runs.filter((run) => pausable.has(run.lifecycle.phase));
    const settlingIds = [...new Set([
      ...newlyPaused.map((run) => run.id),
      ...runs.filter((run) => run.lifecycle.phase === "pausing").map((run) => run.id),
    ])].sort();

    let currentRevision = revision;
    if (newlyPaused.length > 0) {
      const atMs = this.#now().getTime();
      const at = this.#timestamp();
      const first = await this.#store.commit({
        expectedRevision: currentRevision,
        runWrites: newlyPaused.map((run) => {
          const draft = nextRun(run, at);
          applyLifecycle(draft, { type: "pause_requested", atMs });
          draft.activity.push(activity(
            this.#createId("activity"),
            at,
            "compiler",
            "Pausing for authority restart",
          ));
          return { record: draft, expectedRevision: run.revision };
        }),
      });
      currentRevision = first.state.revision;
    }

    await Promise.all(settlingIds.map((runId) =>
      this.#supervisor.abortByRun(runId, "authority restart")));

    const settledAtMs = this.#now().getTime();
    const settledAt = this.#timestamp();
    const settledWrites = [];
    for (const runId of settlingIds) {
      const run = await this.#store.getRun(runId);
      if (run.lifecycle.phase !== "pausing") continue;
      const draft = nextRun(run, settledAt);
      interruptRunningAttempts(draft, "Interrupted for authority restart", settledAt);
      applyLifecycle(draft, { type: "pause_settled", atMs: settledAtMs });
      settledWrites.push({ record: draft, expectedRevision: run.revision });
    }
    const result: JsonValue = {
      status: "quiesced",
      pausedRunIds: settlingIds,
      runCount: runs.length,
    };
    const committed = await this.#store.commit({
      expectedRevision: currentRevision,
      runWrites: settledWrites,
      receipt: receiptFor(request, result),
    });
    return {
      result,
      revision: committed.state.revision,
      beginQuiesce: true,
      afterResponse: this.#requestAuthorityShutdown,
    };
  }

  async #settlePause(runId: string): Promise<void> {
    await this.#supervisor.abortByRun(runId, "run paused by operator");
    await this.#server.mutateInternal(async ({ revision }) => {
      const run = await this.#store.getRun(runId);
      if (run.lifecycle.phase !== "pausing") return this.#noOpInternal(revision);
      const draft = nextRun(run, this.#timestamp());
      interruptRunningAttempts(draft, "Run paused", draft.updatedAt);
      applyLifecycle(draft, { type: "pause_settled", atMs: this.#now().getTime() });
      const committed = await this.#store.commit({
        expectedRevision: revision,
        runWrites: [{ record: draft, expectedRevision: run.revision }],
      });
      return {
        revision: committed.state.revision,
        events: [{ topic: "run.paused", payload: { runId } }],
      };
    });
  }

  async #resumeRun(request: RpcRequest, revision: number): Promise<AuthorityMethodResult> {
    requireIdempotency(request);
    const runId = requiredString(request.params, "runId");
    const run = await this.#store.getRun(runId);
    const resumedAt = this.#timestamp();
    let adoptionVerificationSha256: Sha256Digest | undefined;
    if (run.legacyRunAdoption !== undefined && run.legacyRunAdoption.resumeVerifiedAt === undefined) {
      adoptionVerificationSha256 = await this.#verifyLegacySuccessorResume(run, resumedAt);
    }
    const draft = nextRun(run, resumedAt);
    applyLifecycle(draft, { type: "resume_requested", atMs: this.#now().getTime() });
    if (adoptionVerificationSha256 !== undefined && draft.legacyRunAdoption !== undefined) {
      draft.legacyRunAdoption.resumeVerifiedAt = resumedAt;
      draft.legacyRunAdoption.resumeVerificationSha256 = adoptionVerificationSha256;
      draft.activity.push(activity(
        this.#createId("activity"),
        resumedAt,
        "compiler",
        "Reverified immutable legacy source before fresh Pi recovery",
      ));
    }
    const result: JsonValue = { runId, status: draft.lifecycle.phase };
    const committed = await this.#store.commit({
      expectedRevision: revision,
      runWrites: [{ record: draft, expectedRevision: run.revision }],
      receipt: receiptFor(request, result),
    });
    this.#supervisor.resumeRun(runId);
    if (draft.lifecycle.phase === "draft") {
      this.#background(() => this.#initializeRun(runId), runId);
    } else if (draft.lifecycle.phase === "planning") {
      this.#background(() => this.#launchPlanning(runId), runId);
    } else if (draft.lifecycle.phase === "approving") {
      this.#background(() => this.#settleApprove(runId), runId);
    } else if (draft.lifecycle.phase === "executing" || draft.lifecycle.phase === "verifying") {
      this.#background(() => this.#tick(runId), runId);
    }
    return { result, revision: committed.state.revision };
  }

  async #verifyLegacySuccessorResume(
    run: RunRecord,
    verifiedAt: string,
  ): Promise<Sha256Digest> {
    const adoption = run.legacyRunAdoption;
    if (adoption === undefined) {
      throw new AuthorityRpcError("legacy_adoption_missing", "run has no legacy adoption evidence");
    }
    if (run.lifecycle.phase !== "paused" || run.lifecycle.resumePhase !== "draft") {
      throw new AuthorityRpcError(
        "legacy_adoption_phase",
        "first legacy successor resume must begin from its paused draft boundary",
      );
    }
    let evidence: LoadedLegacyRunMigrationEvidence;
    let assessed: LegacyRunAdoptionAssessment;
    try {
      evidence = await loadLegacyRunMigrationEvidence(this.#projectRoot, adoption.migrationId);
      assessed = await assessLegacyRunAdoption(evidence, adoption.sourceRunId);
    } catch (error) {
      throw new AuthorityRpcError(errorCode(error) ?? "legacy_resume_evidence", errorMessage(error));
    }
    if (assessed.disposition !== "ready" || assessed.start === undefined) {
      throw new AuthorityRpcError(
        "legacy_resume_blocked",
        "legacy source no longer satisfies its adoption proof",
        { details: { blockers: assessed.blockers } as unknown as JsonValue },
      );
    }
    const source = evidence.compatibility.runs.find((candidate) => candidate.id === adoption.sourceRunId);
    if (
      source === undefined ||
      source.treeSha256 !== adoption.sourceTreeSha256 ||
      evidence.compatibility.sourceRegistrySha256 !== adoption.sourceRegistrySha256 ||
      evidence.planBytesSha256 !== adoption.migrationPlanBytesSha256 ||
      evidence.plan.planSha256 !== adoption.migrationPlanSha256 ||
      evidence.compatibilityIndexSha256 !== adoption.compatibilityIndexSha256 ||
      evidence.receiptSha256 !== adoption.migrationReceiptSha256 ||
      evidence.compatibility.barrierEvidenceSha256 !== adoption.barrierEvidenceSha256 ||
      assessed.sourceStatus !== adoption.sourceStatus ||
      canonicalHash(assessed.start.sourceGit) !== canonicalHash(adoption.sourceGit) ||
      assessed.start.targetRef !== adoption.targetRef ||
      assessed.start.targetSelectedOid !== adoption.targetSelectedOid ||
      assessed.start.planningBaseOid !== adoption.planningBaseOid ||
      run.git.target.ref !== adoption.targetRef ||
      run.git.target.selectedOid !== adoption.targetSelectedOid ||
      run.git.planning.baseOid !== adoption.planningBaseOid
    ) {
      throw new AuthorityRpcError(
        "legacy_resume_evidence_changed",
        "legacy adoption evidence or pinned successor Git state changed before resume",
      );
    }
    return legacyRunResumeVerificationSha256(evidence, assessed, verifiedAt);
  }

  async #deleteRun(request: RpcRequest, revision: number): Promise<AuthorityMethodResult> {
    requireIdempotency(request);
    const runId = requiredString(request.params, "runId");
    const run = await this.#store.getRun(runId);
    const draft = nextRun(run, this.#timestamp());
    applyLifecycle(draft, { type: "delete_requested", atMs: this.#now().getTime() });
    draft.generation = draft.lifecycle.generation;
    const result: JsonValue = { runId, status: "deleting" };
    const committed = await this.#store.commit({
      expectedRevision: revision,
      runWrites: [{ record: draft, expectedRevision: run.revision }],
      receipt: receiptFor(request, result),
    });
    // deleteRun installs an irreversible in-process tombstone synchronously, so no new prompt
    // can start after this accepted mutation even while cleanup is still in progress.
    const deleted = this.#supervisor.deleteRun(runId);
    this.#background(async () => { await deleted; await this.#settleDelete(runId); }, runId);
    return { result, revision: committed.state.revision };
  }

  async #settleDelete(runId: string): Promise<void> {
    await this.#supervisor.deleteRun(runId);
    const retired = await this.#withGit(runId, async () => {
      // Read under the Git lane. A relocation accepted just before deletion
      // must not let cleanup act on the stale pre-relocation path projection.
      const current = await this.#store.getRun(runId);
      if (
        current.legacyGitMigration?.status === "relocation_required" ||
        current.legacyGitMigration?.status === "preserved"
      ) {
        const result = await this.#legacyGit.retire(current, this.#legacyGitJournal(runId));
        return {
          legacy: true as const,
          status: result.status === "completed" ? "retired" as const : "preserved" as const,
          lifecycle: result.lifecycle ?? current.git,
          ...(result.status === "preserved" ? { reason: result.reason } : {}),
          settledWithoutIntent: result.status === "preserved" && result.lifecycle === undefined,
        };
      }
      const result = await this.#git.retireAbandonedRun(current.git, this.#gitJournal(runId));
      return { legacy: false as const, ...result, settledWithoutIntent: false };
    });
    if (!retired.legacy) await this.#persistGitLifecycle(runId, retired.lifecycle);
    if (retired.legacy && retired.settledWithoutIntent && retired.reason !== undefined) {
      await this.#preserveLegacyMigration(runId, retired.reason);
    }
    await this.#server.mutateInternal(async ({ revision }) => {
      const run = await this.#store.getRun(runId);
      if (run.lifecycle.phase !== "deleting") return this.#noOpInternal(revision);
      const draft = nextRun(run, this.#timestamp());
      interruptRunningAttempts(draft, "Run deleted", draft.updatedAt);
      if (retired.status === "preserved") {
        draft.activity.push(activity(
          this.#createId("activity"),
          draft.updatedAt,
          "git",
          `Preserved run workspace during deletion: ${retired.reason}`,
        ));
      }
      applyLifecycle(draft, { type: "delete_settled", atMs: this.#now().getTime() });
      const committed = await this.#store.commit({
        expectedRevision: revision,
        runWrites: [{ record: draft, expectedRevision: run.revision }],
      });
      return {
        revision: committed.state.revision,
        events: [{ topic: "run.deleted", payload: { runId } }],
      };
    });
  }

  async #approvePlan(request: RpcRequest, revision: number): Promise<AuthorityMethodResult> {
    requireIdempotency(request);
    const runId = requiredString(request.params, "runId");
    const run = await this.#store.getRun(runId);
    if (run.plan === undefined || run.plan.status !== "awaiting_approval") {
      throw new AuthorityRpcError("plan_state", "run does not have an approval-ready plan");
    }
    const initialized = await this.#program.initializeApprovedPlan(run);
    const draft = nextRun(run, this.#timestamp());
    draft.plan = { ...draft.plan!, status: "approving" };
    draft.graphHash = initialized.graphHash;
    draft.graphRevision = initialized.graphRevision;
    draft.tickets = structuredClone(initialized.tickets);
    draft.activity.push(...structuredClone(initialized.activity ?? []));
    for (const ticket of Object.values(draft.tickets)) {
      delete ticket.gitCycleId;
      ticket.worktreePath = undefined;
      ticket.branch = undefined;
    }
    applyLifecycle(draft, { type: "plan_approval_requested", atMs: this.#now().getTime() });
    const result: JsonValue = { runId, status: "approving", ticketCount: Object.keys(draft.tickets).length };
    const committed = await this.#store.commit({
      expectedRevision: revision,
      runWrites: [{ record: draft, expectedRevision: run.revision }],
      ...(initialized.artifactWrites === undefined ? {} : { writes: initialized.artifactWrites }),
      receipt: receiptFor(request, result),
    });
    this.#background(() => this.#settleApprove(runId), runId);
    return { result, revision: committed.state.revision };
  }

  async #settleApprove(runId: string): Promise<void> {
    let run = await this.#store.getRun(runId);
    if (run.lifecycle.phase !== "approving") return;
    try {
      await this.#withGit(runId, () => this.#git.approveRun(run.git, this.#gitJournal(runId)));
      await this.#server.mutateInternal(async ({ revision }) => {
        run = await this.#store.getRun(runId);
        if (run.lifecycle.phase !== "approving") return this.#noOpInternal(revision);
        const draft = nextRun(run, this.#timestamp());
        draft.plan = draft.plan === undefined ? undefined : { ...draft.plan, status: "approved" };
        draft.currentPipelineStageId = orchestrationStage(draft);
        applyLifecycle(draft, { type: "plan_approved", atMs: this.#now().getTime() });
        const committed = await this.#store.commit({
          expectedRevision: revision,
          runWrites: [{ record: draft, expectedRevision: run.revision }],
        });
        return {
          revision: committed.state.revision,
          events: [{ topic: "run.execution.started", payload: { runId } }],
        };
      });
      await this.#tick(runId);
    } catch (error) {
      await this.#recordRunBlocker(runId, `Run workspace approval failed: ${errorMessage(error)}`);
    }
  }

  async #revisePlan(request: RpcRequest, revision: number): Promise<AuthorityMethodResult> {
    requireIdempotency(request);
    const runId = requiredString(request.params, "runId");
    const instructions = boundedText(requiredString(request.params, "instructions"), "steering instructions", 1024 * 1024);
    const run = await this.#store.getRun(runId);
    if (run.plan === undefined) throw new AuthorityRpcError("plan_missing", "run has no plan to revise");
    if (run.planningMode === "direct") {
      throw new AuthorityRpcError(
        "plan_revision_unavailable",
        "this run type has no planning agent; edit the objective or choose a planned run type instead",
      );
    }
    const draft = nextRun(run, this.#timestamp());
    draft.plan!.status = "revising";
    draft.plan!.steeringHistory.push({ at: draft.updatedAt, instructions });
    applyLifecycle(draft, { type: "plan_revision_requested", atMs: this.#now().getTime() });
    draft.plan!.status = "planning";
    // A plan revision is a new immutable attempt, never an in-session steering
    // message. This keeps the accepted predecessor transcript intact, gives the
    // replacement a fresh grant/session/context budget, and lets lineage bind it
    // explicitly to the exact plan it supersedes.
    const supersededAttemptIds: string[] = [];
    for (const attempt of Object.values(draft.attempts)) {
      if (
        attempt.kind !== "planning" ||
        !new Set<AttemptStatus>(["queued", "running", "waiting_question", "terminal_accepted"])
          .has(attempt.status)
      ) continue;
      attempt.status = "interrupted";
      attempt.error = "Superseded by an operator-requested plan revision";
      attempt.endedAt = draft.updatedAt;
      attempt.terminalSummary = "Superseded by a fresh revision attempt";
      supersededAttemptIds.push(attempt.id);
    }
    const result: JsonValue = { runId, status: "planning", planRevision: draft.lifecycle.planRevision };
    const committed = await this.#store.commit({
      expectedRevision: revision,
      runWrites: [{ record: draft, expectedRevision: run.revision }],
      receipt: receiptFor(request, result),
    });
    this.#background(async () => {
      for (const attemptId of supersededAttemptIds) {
        const handle = this.#supervisor.get(attemptId);
        if (handle !== undefined) {
          await handle.session.abort("plan revision moved to a fresh immutable attempt");
        }
      }
      await this.#launchPlanning(runId);
    }, runId);
    return { result, revision: committed.state.revision };
  }

  async #answerQuestion(request: RpcRequest, revision: number): Promise<AuthorityMethodResult> {
    requireIdempotency(request);
    const runId = requiredString(request.params, "runId");
    const questionId = requiredString(request.params, "questionId");
    const selectedOptionId = optionalString(request.params, "selectedOptionId");
    const notes = optionalString(request.params, "notes");
    const run = await this.#store.getRun(runId);
    const question = run.questions[questionId];
    if (question === undefined || question.answeredAt !== undefined) {
      throw new AuthorityRpcError("question_state", "question is missing or already answered");
    }
    if (
      selectedOptionId !== undefined &&
      !question.options.some((option) => option.id === selectedOptionId)
    ) throw new AuthorityRpcError("question_option", "selected question option does not exist");
    if (selectedOptionId === undefined && (notes === undefined || notes.trim().length === 0)) {
      throw new AuthorityRpcError("question_answer", "choose an option or provide notes");
    }
    const liveWaiter = this.#questionWaiters.get(questionId);
    const draft = nextRun(run, this.#timestamp());
    const answer = draft.questions[questionId]!;
    answer.selectedOptionId = selectedOptionId;
    answer.notes = notes;
    answer.answeredAt = draft.updatedAt;
    const label = selectedOptionId === undefined
      ? "None of the listed options"
      : question.options.find((option) => option.id === selectedOptionId)!.label;
    applyLifecycle(draft, {
      type: "question_answered",
      atMs: this.#now().getTime(),
      questionId,
      answer: label,
      ...(notes === undefined ? {} : { notes }),
    });
    const attempt = draft.attempts[question.attemptId];
    if (attempt !== undefined && attempt.status === "waiting_question") {
      if (liveWaiter !== undefined) {
        attempt.status = "running";
      } else {
        interruptAttemptForContinuation(draft, attempt, draft.updatedAt);
      }
    }
    const result: JsonValue = { runId, questionId, status: "answered" };
    const committed = await this.#store.commit({
      expectedRevision: revision,
      runWrites: [{ record: draft, expectedRevision: run.revision }],
      receipt: receiptFor(request, result),
    });
    if (liveWaiter !== undefined) {
      liveWaiter.resolve({
        label,
        ...(selectedOptionId === undefined ? {} : { selectedOptionId }),
        ...(notes === undefined ? {} : { notes }),
      });
    } else if (attempt !== undefined) {
      this.#background(async () => {
        const handle = this.#supervisor.get(attempt.id);
        if (handle !== undefined) await handle.session.abort("question continuation moved to a fresh attempt");
        const current = await this.#store.getRun(runId);
        if (current.lifecycle.phase === "planning") await this.#launchPlanning(runId);
        else if (current.lifecycle.phase === "executing" || current.lifecycle.phase === "verifying") await this.#tick(runId);
      }, runId);
    }
    return { result, revision: committed.state.revision };
  }

  async #mergeRun(request: RpcRequest, revision: number): Promise<AuthorityMethodResult> {
    requireIdempotency(request);
    const runId = requiredString(request.params, "runId");
    const run = await this.#store.getRun(runId);
    const draft = nextRun(run, this.#timestamp());
    applyLifecycle(draft, { type: "merge_started", atMs: this.#now().getTime() });
    const result: JsonValue = { runId, status: "merging", targetRef: run.git.target.ref };
    const committed = await this.#store.commit({
      expectedRevision: revision,
      runWrites: [{ record: draft, expectedRevision: run.revision }],
      receipt: receiptFor(request, result),
    });
    this.#background(() => this.#settleMerge(runId), runId);
    return { result, revision: committed.state.revision };
  }

  async #settleMerge(runId: string, retry = 0): Promise<void> {
    const run = await this.#store.getRun(runId);
    if (run.lifecycle.phase !== "merging") return;
    try {
      const { published, cleanup } = await this.#withGit(runId, async () => {
        await this.#git.publishTargetPromotion(run.git, this.#gitJournal(runId));
        const durable = await this.#store.getRun(runId);
        const retired = await this.#git.retireAbandonedRun(durable.git, this.#gitJournal(runId));
        return { published: durable, cleanup: retired };
      });
      const mergedOid = published.git.promotion?.candidateOid;
      if (mergedOid === undefined || published.git.promotion?.status !== "published") {
        throw new AuthorityRpcError("git_promotion", "target publication did not settle durably");
      }
      await this.#persistGitLifecycle(runId, cleanup.lifecycle);
      await this.#server.mutateInternal(async ({ revision }) => {
        const current = await this.#store.getRun(runId);
        if (current.lifecycle.phase !== "merging") return this.#noOpInternal(revision);
        const draft = nextRun(current, this.#timestamp());
        applyLifecycle(draft, { type: "merge_completed", atMs: this.#now().getTime() });
        const committed = await this.#store.commit({
          expectedRevision: revision,
          runWrites: [{ record: draft, expectedRevision: current.revision }],
        });
        return {
          revision: committed.state.revision,
          events: [{ topic: "run.completed", payload: { runId, mergedOid } }],
        };
      });
    } catch (error) {
      if (retry >= 1) {
        await this.#recordRunBlocker(runId, `Target publication failed: ${errorMessage(error)}`);
      } else {
        await this.#preparePromotion(runId, true);
      }
    }
  }

  async #steerAttempt(request: RpcRequest, revision: number, followUp: boolean): Promise<AuthorityMethodResult> {
    requireIdempotency(request);
    const attemptId = requiredString(request.params, "attemptId");
    const text = boundedText(requiredString(request.params, "text"), "agent message", 1024 * 1024);
    const located = await this.#findAttempt(attemptId);
    const run = located.run;
    const attempt = located.attempt;
    if (
      attempt.status !== "running" ||
      !new Set(["planning", "executing", "verifying"]).has(run.lifecycle.phase)
    ) {
      throw new AuthorityRpcError("attempt_inactive", "operator messages require an active model attempt");
    }
    const mode = followUp ? "follow_up" as const : "steer" as const;
    const bytes = Buffer.from(text, "utf8");
    const sha256 = rawSha256(bytes);
    const draft = nextRun(run, this.#timestamp());
    const mutable = draft.attempts[attemptId]!;
    mutable.authorityMessages ??= [];
    const sequence = mutable.authorityMessages.length + 1;
    const artifactPath = authorityMessagePath(run.id, attemptId, sequence, sha256);
    mutable.authorityMessages.push({
      sequence,
      mode,
      sha256,
      sizeBytes: bytes.byteLength,
      artifactPath,
      recordedAt: draft.updatedAt,
    });
    const authorizedMessage: KoniAuthorizedMessage = {
      sequence,
      mode,
      sha256,
      sizeBytes: bytes.byteLength,
      content: text,
    };
    const result: JsonValue = { attemptId, accepted: true, mode, sequence };
    const committed = await this.#store.commit({
      expectedRevision: revision,
      runWrites: [{ record: draft, expectedRevision: run.revision }],
      writes: [{ path: artifactPath, bytes, expectedSha256: null }],
      receipt: receiptFor(request, result),
    });
    this.#background(
      () => followUp
        ? this.#supervisor.followUp(attemptId, authorizedMessage)
        : this.#supervisor.steer(attemptId, authorizedMessage),
    );
    return { result, revision: committed.state.revision };
  }

  async #findAttempt(attemptId: string): Promise<{ run: RunRecord; attempt: AgentAttemptRecord }> {
    const matches = (await this.#store.listRuns({ includeDeleted: true }))
      .flatMap((run) => run.attempts[attemptId] === undefined ? [] : [{ run, attempt: run.attempts[attemptId]! }]);
    if (matches.length !== 1) {
      throw new AuthorityRpcError(
        matches.length === 0 ? "attempt_missing" : "attempt_identity",
        matches.length === 0 ? "agent attempt does not exist" : "agent attempt id is not project-unique",
      );
    }
    return matches[0]!;
  }

  async #commitReceiptOnly(request: RpcRequest, revision: number, result: JsonValue): Promise<void> {
    requireIdempotency(request);
    await this.#store.commit({
      expectedRevision: revision,
      receipt: receiptFor(request, result),
    });
  }

  async #launchPlanning(runId: string): Promise<void> {
    const run = await this.#store.getRun(runId);
    if (run.lifecycle.phase !== "planning" || hasLiveAttempt(run, "planning")) return;
    await this.#launchAttempt(run, "planning");
  }

  async #launchAssignment(run: RunRecord, assignment: ReadyAssignment): Promise<void> {
    const ticket = run.tickets[assignment.ticketId];
    const kind = ticket?.integrationForTicketId !== undefined || ticket?.id.startsWith("TK-integration-") === true
      ? "integration"
      : "ticket";
    await this.#launchAttempt(run, kind, assignment);
  }

  async #launchAttempt(
    run: RunRecord,
    kind: "planning" | "ticket" | "verification" | "integration",
    assignment?: ReadyAssignment,
  ): Promise<void> {
    if (this.#runtimeGuard !== undefined) {
      try {
        await this.#runtimeGuard();
      } catch (error) {
        await this.#recordRunBlocker(run.id, errorMessage(error));
        return;
      }
    }
    const attemptId = this.#createId("attempt");
    const sessionId = this.#createId("session");
    let prepared: PreparedManagedAttempt | undefined;
    await this.#server.mutateInternal(async ({ revision }) => {
      const current = await this.#store.getRun(run.id);
      if (current.generation !== run.generation) {
        throw new AuthorityRpcError("launch_generation", "run generation changed before attempt admission");
      }
      if (assignment !== undefined) {
        const ready = deriveReadyAssignments(current, current.executionConfig?.maxParallel ?? 1).ready.some(
          (candidate) => candidate.ticketId === assignment?.ticketId && candidate.stepId === assignment?.stepId,
        );
        if (!ready) return this.#noOpInternal(revision);
      }
      const nextRevision = revision + 1;
      const lineage = await this.#deriveAttemptLineage(current, kind, assignment);
      prepared = await this.#program.prepareAttempt({
        kind,
        run: current,
        ...(assignment === undefined ? {} : { assignment }),
        attemptId,
        sessionId,
        nextAuthorityRevision: nextRevision,
        expectedAuthorityStateHash: authorityRevisionStateHash(this.#projectRoot, nextRevision),
        lineage,
      });
      assertPreparedIdentity(prepared, current.id, attemptId, sessionId, assignment);
      if (canonicalHash(prepared.spec.lineage) !== canonicalHash(lineage)) {
        throw new AuthorityRpcError("launch_lineage", "compiler changed the authority-issued attempt lineage");
      }
      assertPreparedAuthorityPlan(prepared, nextRevision, this.#projectRoot, this.#stateRoot);
      const draft = nextRun(current, this.#timestamp());
      if (assignment !== undefined) beginAssignment(draft, assignment, attemptId, draft.updatedAt);
      const attempt: AgentAttemptRecord = {
        id: attemptId,
        sessionId,
        ticketId: prepared.spec.identity.ticketId,
        stepId: prepared.spec.identity.stepId,
        personaId: prepared.spec.persona.id,
        modelProvider: prepared.spec.model.provider,
        modelId: prepared.spec.model.id,
        thinkingLevel: prepared.spec.model.thinkingLevel,
        status: "running",
        launchSpecHash: prepared.spec.specHash,
        sessionFile: undefined,
        startedAt: draft.updatedAt,
        endedAt: undefined,
        terminalSummary: undefined,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        lineage: structuredClone(lineage),
        authorityMessages: [],
        authorityToolResults: [],
        authorityCompactions: [],
        kind,
      };
      draft.attempts[attemptId] = attempt;
      const launchBytes = Buffer.from(`${JSON.stringify(prepared.spec)}\n`, "utf8");
      const writes: TransactionWrite[] = [
        ...(prepared.artifactWrites ?? []),
        {
          path: `runs/${run.id}/attempts/${attemptId}/launch-spec.json`,
          bytes: launchBytes,
          expectedSha256: null,
        },
      ];
      const committed = await this.#store.commit({
        expectedRevision: revision,
        runWrites: [{ record: draft, expectedRevision: current.revision }],
        writes,
      });
      return {
        revision: committed.state.revision,
        events: [{ topic: "agent.queued", payload: { runId: run.id, attemptId, kind } }],
      };
    });
    if (prepared === undefined) return;
    try {
      const handle = await this.#launchPreparedSession(prepared, "fresh");
      await this.#markAttemptRunning(run.id, attemptId, handle);
      this.#attachOutcome(run.id, attemptId, assignment, handle);
      await this.#activatePreparedSession(handle);
    } catch (error) {
      await this.#failLaunch(run.id, attemptId, assignment, errorMessage(error));
    }
  }

  async #launchPreparedSession(
    prepared: PreparedManagedAttempt,
    mode: "fresh" | "recover",
  ): Promise<ManagedSessionHandle | PiAttemptProcessHandle> {
    const contextProvider = prepared.contextProvider ?? this.#createContextProvider(prepared);
    if (this.#supervisor instanceof PiAttemptProcessSupervisor) {
      if (prepared.terminalOutputSchema === undefined) {
        throw new AuthorityRpcError("tool_authority", "process-contained attempt has no terminal schema");
      }
      const options = {
        terminalOutputSchema: prepared.terminalOutputSchema,
        authority: {
          invokeTool: (call: KoniToolInvocation) => this.#invokeAgentTool(prepared, call),
          rejectTool: (call: KoniToolInvocation, rejection: KoniRuntimeToolRejection) =>
            this.#rejectAgentTool(prepared, call, rejection),
          contextProvider,
        },
      };
      return mode === "fresh"
        ? this.#supervisor.launch(prepared.spec, options)
        : this.#supervisor.recover(prepared.spec, options);
    }
    const tools = resolvePreparedTools(
      prepared,
      (call) => this.#invokeAgentTool(prepared, call),
      (call, rejection) => this.#rejectAgentTool(prepared, call, rejection),
    );
    const options = {
      tools,
      contextProvider,
      ...(prepared.factory === undefined ? {} : { factory: prepared.factory }),
    };
    return mode === "fresh"
      ? this.#supervisor.launch(prepared.spec, options)
      : this.#supervisor.recover(prepared.spec, options);
  }

  async #activatePreparedSession(
    handle: ManagedSessionHandle | PiAttemptProcessHandle,
  ): Promise<void> {
    if (!this.#activateProviderAttempts || !(this.#supervisor instanceof PiAttemptProcessSupervisor)) return;
    await (handle as PiAttemptProcessHandle).session.activate();
  }

  async #deriveAttemptLineage(
    run: RunRecord,
    kind: "planning" | "ticket" | "verification" | "integration",
    assignment: ReadyAssignment | undefined,
  ): Promise<AgentAttemptLineage> {
    const candidates = Object.values(run.attempts)
      .filter((attempt) => {
        if (attempt.kind !== kind) return false;
        if (kind === "planning") return true;
        return attempt.ticketId === assignment?.ticketId && attempt.stepId === assignment?.stepId;
      })
      .sort((left, right) =>
        (right.startedAt ?? right.endedAt ?? "").localeCompare(left.startedAt ?? left.endedAt ?? "") ||
        right.id.localeCompare(left.id)
      );
    const parent = candidates[0];
    if (parent === undefined) {
      return {
        branchEpoch: 0,
        reason: run.legacyRunAdoption?.sessionLineage.kind === "fresh_successor"
          ? "recovery"
          : "initial",
      };
    }

    const reason: AgentAttemptLineage["reason"] = kind === "integration"
      ? "integration"
      : parent.status === "failed"
        ? "retry"
        : parent.status === "interrupted" || parent.status === "aborted"
          ? "recovery"
          : kind === "planning"
            ? "rework"
            : "rework";
    const parentEntryId = await this.#lastAttemptEntry(run, parent);
    return {
      branchEpoch: (parent.lineage?.branchEpoch ?? Math.max(0, candidates.length - 1)) + 1,
      reason,
      parentAttemptId: parent.id,
      parentSessionId: parent.sessionId,
      ...(parentEntryId === undefined ? {} : { parentEntryId }),
    };
  }

  async #lastAttemptEntry(run: RunRecord, attempt: AgentAttemptRecord): Promise<string | undefined> {
    if (attempt.sessionFile === undefined) return undefined;
    try {
      const launchBytes = await this.#store.readArtifact(
        `runs/${run.id}/attempts/${attempt.id}/launch-spec.json`,
        16 * 1024 * 1024,
      );
      const spec = validateAgentLaunchSpec(JSON.parse(launchBytes.toString("utf8")) as AgentLaunchSpec);
      const expected = path.join(spec.workspace.sessionDirectory, `${attempt.sessionId}.jsonl`);
      if (
        spec.specHash !== attempt.launchSpecHash ||
        spec.identity.attemptId !== attempt.id ||
        spec.identity.sessionId !== attempt.sessionId ||
        path.resolve(attempt.sessionFile) !== path.resolve(expected)
      ) return undefined;
      const transcript = await readPiSession(expected, { allowTruncatedTail: true });
      if (transcript.header.id !== attempt.sessionId || transcript.header.cwd !== spec.workspace.cwd) return undefined;
      return transcript.lastEntryId;
    } catch {
      // Parent-entry anchoring is optional. Attempt/session identity remains hash-bound even when a
      // legacy or torn transcript cannot safely supply a leaf entry.
      return undefined;
    }
  }

  async #loadStoredLaunchSpec(
    run: RunRecord,
    attempt: AgentAttemptRecord,
  ): Promise<Readonly<AgentLaunchSpec>> {
    const bytes = await this.#store.readArtifact(
      `runs/${run.id}/attempts/${attempt.id}/launch-spec.json`,
      16 * 1024 * 1024,
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new AuthorityRpcError("launch_spec_json", "stored launch specification is not JSON");
    }
    const spec = validateAgentLaunchSpec(parsed as AgentLaunchSpec);
    if (
      spec.specHash !== attempt.launchSpecHash ||
      spec.identity.runId !== run.id ||
      spec.identity.attemptId !== attempt.id ||
      spec.identity.sessionId !== attempt.sessionId
    ) {
      throw new AuthorityRpcError("launch_spec_identity", "stored launch specification differs from its attempt");
    }
    return spec;
  }

  #createContextProvider(prepared: PreparedManagedAttempt): KoniContextProvider {
    const content = prepared.contextContent;
    const snapshot = prepared.compactionSnapshot;
    if (content === undefined || snapshot === undefined) {
      throw new AuthorityRpcError(
        "launch_context",
        "production attempt is missing compiler-issued context and compaction state",
      );
    }
    const spec = prepared.spec;
    if (rawSha256(content) !== spec.authority.authoritativeContextHash) {
      throw new AuthorityRpcError("launch_context", "compiler-issued context hash does not match launch spec");
    }
    return {
      loadBoundContext: async (requested) => {
        assertSameLaunchSpec(spec, requested);
        const run = await this.#store.getRun(spec.identity.runId);
        assertLiveAttempt(run, spec);
        return {
          ...spec.identity,
          grantId: spec.authority.grantId,
          generation: spec.authority.generation,
          epoch: spec.authority.epoch,
          stateHash: spec.authority.expectedStateHash,
          contextHash: spec.authority.authoritativeContextHash,
          content,
        };
      },
      loadDynamicGraphContext: async (requested) => {
        assertSameLaunchSpec(spec, requested);
        const run = await this.#store.getRun(spec.identity.runId);
        const attempt = assertLiveAttempt(run, spec);
        if (this.#program.selectDynamicGraphContext === undefined) {
          throw new AuthorityRpcError("dynamic_context_unavailable", "profile compiler does not implement dynamic graph context");
        }
        try {
          return await this.#program.selectDynamicGraphContext({ run, attempt, spec });
        } catch (error) {
          if (error instanceof DynamicGraphContextBudgetError) {
            throw new AuthorityRpcError("dynamic_context_budget", error.message);
          }
          throw error;
        }
      },
      loadCompactionSnapshot: async (requested) => {
        assertSameLaunchSpec(spec, requested);
        const run = await this.#store.getRun(spec.identity.runId);
        const attempt = assertLiveAttempt(run, spec);
        return this.#program.refreshCompactionSnapshot === undefined
          ? structuredClone(snapshot)
          : this.#program.refreshCompactionSnapshot({ run, attempt, spec });
      },
      authorizeCompaction: async (requested, record) => {
        assertSameLaunchSpec(spec, requested);
        const authorizationId = `compact-${randomUUID()}`;
        await this.#server.mutateInternal(async ({ revision }) => {
          const run = await this.#store.getRun(spec.identity.runId);
          const attempt = assertLiveAttempt(run, spec);
          const draft = nextRun(run, this.#timestamp());
          const mutable = draft.attempts[attempt.id]!;
          mutable.authorityCompactions ??= [];
          mutable.authorityCompactions.push({
            sequence: mutable.authorityCompactions.length + 1,
            authorizationId,
            summaryHash: record.summaryHash,
            summaryBytes: record.summaryBytes,
            firstKeptEntryId: record.firstKeptEntryId,
            tokensBefore: record.tokensBefore,
            recordedAt: draft.updatedAt,
          });
          const committed = await this.#store.commit({
            expectedRevision: revision,
            runWrites: [{ record: draft, expectedRevision: run.revision }],
          });
          return { revision: committed.state.revision };
        });
        return { authorizationId };
      },
      acquireRecoveryClaim: async (requested) => {
        assertSameLaunchSpec(spec, requested);
        const claimId = `recovery-${randomUUID()}`;
        let state: Awaited<ReturnType<KoniContextProvider["acquireRecoveryClaim"]>>["state"] | undefined;
        await this.#server.mutateInternal(async ({ revision }) => {
          if (this.#recoveryClaims.has(spec.identity.attemptId)) {
            throw new AuthorityRpcError("recovery_claimed", "attempt already has an active recovery owner");
          }
          const run = await this.#store.getRun(spec.identity.runId);
          const attempt = run.attempts[spec.identity.attemptId];
          if (attempt === undefined || attempt.launchSpecHash !== spec.specHash) {
            throw new AuthorityRpcError("recovery_identity", "durable attempt does not match launch spec");
          }
          this.#recoveryClaims.set(spec.identity.attemptId, claimId);
          const active = new Set(["queued", "running", "waiting_question"]).has(attempt.status) &&
            !new Set(["pausing", "paused", "deleting", "deleted", "failed", "completed"]).has(run.lifecycle.phase);
          const acceptedTerminal = await this.#readTerminalOutput(spec, attempt);
          const authorizedMessages = await this.#loadAuthorizedMessages(attempt);
          state = {
            protocol: "koni.attempt-recovery.v1",
            specHash: spec.specHash,
            ...spec.identity,
            grantHash: spec.authority.grantHash,
            generation: spec.authority.generation,
            epoch: spec.authority.epoch,
            stateHash: spec.authority.expectedStateHash,
            usage: {
              input: attempt.inputTokens,
              output: attempt.outputTokens,
              cacheRead: attempt.cacheReadTokens,
              cacheWrite: attempt.cacheWriteTokens,
              newTokens: attempt.inputTokens + attempt.outputTokens,
              allTokens: attempt.inputTokens + attempt.outputTokens +
                attempt.cacheReadTokens + attempt.cacheWriteTokens,
            },
            status: acceptedTerminal === undefined
              ? active ? "continue" : "revoked"
              : "terminal_accepted",
            authorizedMessages,
            authorizedToolResults: await this.#loadAuthorizedToolResults(attempt),
            authorizedCompactions: (attempt.authorityCompactions ?? []).map((record) => ({
              sequence: record.sequence,
              authorizationId: record.authorizationId,
              summaryHash: record.summaryHash,
              summaryBytes: record.summaryBytes,
              firstKeptEntryId: record.firstKeptEntryId,
              tokensBefore: record.tokensBefore,
            })),
            ...(acceptedTerminal === undefined ? {} : { terminalOutput: acceptedTerminal }),
            ...(active ? {} : { reason: `attempt is ${attempt.status} while run is ${run.lifecycle.phase}` }),
          };
          return this.#noOpInternal(revision);
        });
        return {
          protocol: "koni.attempt-recovery-claim.v1",
          claimId,
          state: state!,
          release: async () => {
            if (this.#recoveryClaims.get(spec.identity.attemptId) === claimId) {
              this.#recoveryClaims.delete(spec.identity.attemptId);
            }
          },
        };
      },
    };
  }

  async #loadAuthorizedMessages(attempt: AgentAttemptRecord): Promise<Array<{
    sequence: number;
    mode: "steer" | "follow_up";
    sha256: Sha256Digest;
    sizeBytes: number;
    content: string;
  }>> {
    const output = [];
    for (const record of attempt.authorityMessages ?? []) {
      const bytes = await this.#store.readArtifact(record.artifactPath, record.sizeBytes + 1);
      if (bytes.byteLength !== record.sizeBytes || rawSha256(bytes) !== record.sha256) {
        throw new AuthorityRpcError("recovery_message", "authority message artifact changed after admission");
      }
      const content = bytes.toString("utf8");
      if (!Buffer.from(content, "utf8").equals(bytes)) {
        throw new AuthorityRpcError("recovery_message", "authority message artifact is not exact UTF-8");
      }
      output.push({
        sequence: record.sequence,
        mode: record.mode,
        sha256: record.sha256,
        sizeBytes: record.sizeBytes,
        content,
      });
    }
    return output;
  }

  async #loadAuthorizedToolResults(attempt: AgentAttemptRecord): Promise<Array<{
    sequence: number;
    callId: string;
    toolName: string;
    outcome: "accepted" | "rejected";
    argumentsSha256: Sha256Digest;
    argumentsSizeBytes: number;
    receiptSha256: Sha256Digest;
    receiptSizeBytes: number;
    receipt: KoniToolReceipt;
  }>> {
    const output = [];
    for (const record of attempt.authorityToolResults ?? []) {
      const bytes = await this.#store.readArtifact(record.artifactPath, 16 * 1024 * 1024 + 1);
      let receipt: unknown;
      try {
        receipt = JSON.parse(bytes.toString("utf8"));
      } catch {
        throw new AuthorityRpcError("recovery_tool_result", "authority tool-result artifact is not JSON");
      }
      if (!isKoniToolReceipt(receipt)) {
        throw new AuthorityRpcError("recovery_tool_result", "authority tool-result artifact is malformed");
      }
      if (receipt.outcome !== record.outcome) {
        throw new AuthorityRpcError("recovery_tool_result", "authority tool-result outcome changed after admission");
      }
      const canonical = canonicalEncode(receipt);
      if (
        Buffer.byteLength(canonical, "utf8") !== record.receiptSizeBytes ||
        rawSha256(canonical) !== record.receiptSha256
      ) {
        throw new AuthorityRpcError(
          "recovery_tool_result",
          "authority tool-result artifact changed after acceptance",
        );
      }
      output.push({
        sequence: record.sequence,
        callId: record.callId,
        toolName: record.toolName,
        outcome: record.outcome,
        argumentsSha256: record.argumentsSha256,
        argumentsSizeBytes: record.argumentsSizeBytes,
        receiptSha256: record.receiptSha256,
        receiptSizeBytes: record.receiptSizeBytes,
        receipt: structuredClone(receipt),
      });
    }
    return output;
  }

  async #readTerminalOutput(
    spec: Readonly<AgentLaunchSpec>,
    attempt: AgentAttemptRecord,
  ): Promise<unknown | undefined> {
    if (
      attempt.terminalOutputSha256 === undefined ||
      attempt.terminalOutputSizeBytes === undefined ||
      attempt.terminalAcceptedAt === undefined
    ) return undefined;
    try {
      const bytes = await this.#store.readArtifact(
        terminalOutputPath(spec.identity.runId, spec.identity.attemptId),
        Math.min(spec.terminal.maxOutputBytes + 1, 16 * 1024 * 1024),
      );
      if (
        bytes.byteLength !== attempt.terminalOutputSizeBytes ||
        rawSha256(bytes) !== attempt.terminalOutputSha256
      ) {
        throw new AuthorityRpcError("terminal_artifact", "accepted terminal output bytes changed");
      }
      return JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        throw new AuthorityRpcError("terminal_artifact", "accepted terminal output artifact is missing");
      }
      throw error;
    }
  }

  async #invokeAgentTool(
    prepared: PreparedManagedAttempt,
    rawCall: KoniToolInvocation,
  ): Promise<KoniToolReceipt> {
    const grant = prepared.authorityGrant;
    const terminalSchema = prepared.terminalOutputSchema;
    if (grant === undefined || prepared.toolNames === undefined || terminalSchema === undefined) {
      throw new AuthorityRpcError("tool_authority", "attempt did not carry a production authority plan");
    }
    const call: KoniToolInvocation = {
      ...rawCall,
      arguments: validateKoniToolArguments(
        rawCall.name,
        rawCall.arguments,
        terminalSchema,
        prepared.spec.tools.find((tool) => tool.name === rawCall.name)?.schemaHash,
      ),
    };
    if (call.signal?.aborted === true) throw new AuthorityRpcError("tool_aborted", "tool call was aborted");
    const method = `agent.${call.name}`;
    const idempotencyKey = canonicalHash({
      grantId: grant.grantId,
      epoch: grant.epoch,
      generation: grant.generation,
      callId: call.callId,
    });
    const requestHash = canonicalHash({
      specHash: prepared.spec.specHash,
      name: call.name,
      arguments: call.arguments,
    });
    const prior = await this.#store.findReceipt(method, idempotencyKey, requestHash);
    if (prior !== undefined) return this.#readToolReceipt(prior.result);
    if (call.name === "koni_ask_question") {
      return this.#invokeQuestionTool(prepared, grant, call, method, idempotencyKey, requestHash);
    }
    if (call.name === "koni_run_check") {
      return this.#invokeAgentCheckTool(prepared, grant, call, method, idempotencyKey, requestHash);
    }
    if (call.name === "koni_write_file" || call.name === "koni_edit_file") {
      return this.#invokeWorkspaceMutationTool(
        prepared,
        grant,
        call as KoniToolInvocation & { name: "koni_write_file" | "koni_edit_file" },
        method,
        idempotencyKey,
        requestHash,
      );
    }
    if (call.name === "koni_submit_output") {
      return this.#invokeTerminalTool(prepared, grant, call, method, idempotencyKey, requestHash);
    }

    let receipt: KoniToolReceipt | undefined;
    await this.#server.mutateInternal(async ({ revision }) => {
      const run = await this.#store.getRun(grant.runId);
      const attempt = validateAgentToolGrant(run, prepared.spec, grant, call, revision, this.#projectRoot);
      enforceRepositoryCallBudget(prepared.spec, attempt, call);
      const draft = nextRun(run, this.#timestamp());
      const compiled = await this.#executeAgentToolEffect(draft, attempt, grant, prepared, call);
      if (compiled.graphHash !== undefined) draft.graphHash = compiled.graphHash;
      if (compiled.graphRevision !== undefined) draft.graphRevision = compiled.graphRevision;
      if (compiled.tickets !== undefined) draft.tickets = structuredClone(compiled.tickets);
      draft.activity.push(...structuredClone(compiled.activity ?? []));
      receipt = {
        protocol: KONI_TOOL_RECEIPT_PROTOCOL,
        receiptId: canonicalHash({ method, idempotencyKey, requestHash }),
        outcome: "accepted",
        summary: boundedText(compiled.summary, "tool receipt summary", 64 * 1024),
        ...(compiled.value === undefined ? {} : { value: structuredClone(compiled.value) }),
      };
      const receiptPath = toolReceiptPath(run.id, attempt.id, call.callId);
      const receiptBytes = encodeJsonArtifact(receipt);
      authorizeToolResult(draft.attempts[attempt.id]!, call, receipt!, receiptPath, draft.updatedAt);
      const writes: TransactionWrite[] = [
        ...(compiled.artifactWrites ?? []),
        {
          path: receiptPath,
          bytes: receiptBytes,
          expectedSha256: null,
        },
      ];
      const pointer: JsonValue = {
        artifact: receiptPath,
        sha256: rawSha256(receiptBytes),
      };
      const committed = await this.#store.commit({
        expectedRevision: revision,
        runWrites: [{ record: draft, expectedRevision: run.revision }],
        writes,
        receipt: { method, idempotencyKey, requestHash, result: pointer },
      });
      return {
        revision: committed.state.revision,
        events: [{
          topic: "agent.tool.accepted",
          payload: { runId: run.id, attemptId: attempt.id, tool: call.name, callId: call.callId },
        }],
      };
    });
    return receipt!;
  }

  async #rejectAgentTool(
    prepared: PreparedManagedAttempt,
    rawCall: KoniToolInvocation,
    rejection: KoniRuntimeToolRejection,
  ): Promise<KoniRejectedToolReceipt> {
    const grant = prepared.authorityGrant;
    const terminalSchema = prepared.terminalOutputSchema;
    if (grant === undefined || prepared.toolNames === undefined || terminalSchema === undefined) {
      throw new AuthorityRpcError("tool_authority", "attempt did not carry a production authority plan");
    }
    if (rejection.code !== "transcript_result_budget") {
      throw new AuthorityRpcError("tool_rejection", "runtime requested an unsupported tool rejection");
    }
    const call: KoniToolInvocation = {
      ...rawCall,
      arguments: validateKoniToolArguments(
        rawCall.name,
        rawCall.arguments,
        terminalSchema,
        prepared.spec.tools.find((tool) => tool.name === rawCall.name)?.schemaHash,
      ),
    };
    const method = `agent.${call.name}`;
    const idempotencyKey = canonicalHash({
      grantId: grant.grantId,
      epoch: grant.epoch,
      generation: grant.generation,
      callId: call.callId,
    });
    const requestHash = canonicalHash({
      specHash: prepared.spec.specHash,
      name: call.name,
      arguments: call.arguments,
    });
    const prior = await this.#store.findReceipt(method, idempotencyKey, requestHash);
    if (prior !== undefined) {
      const receipt = await this.#readToolReceipt(prior.result);
      if (receipt.outcome !== "rejected") {
        throw new AuthorityRpcError("tool_rejection", "tool call was already accepted and cannot be rejected");
      }
      return receipt;
    }
    let receipt: KoniRejectedToolReceipt | undefined;
    await this.#server.mutateInternal(async ({ revision }) => {
      const run = await this.#store.getRun(grant.runId);
      const attempt = validateAgentToolGrant(run, prepared.spec, grant, call, revision, this.#projectRoot);
      const draft = nextRun(run, this.#timestamp());
      receipt = {
        protocol: KONI_TOOL_RECEIPT_PROTOCOL,
        receiptId: canonicalHash({ method, idempotencyKey, requestHash }),
        outcome: "rejected",
        code: rejection.code,
        summary: boundedText(rejection.summary, "tool rejection summary", 64 * 1024),
      };
      const receiptPath = toolReceiptPath(run.id, attempt.id, call.callId);
      const receiptBytes = encodeJsonArtifact(receipt);
      authorizeToolResult(draft.attempts[attempt.id]!, call, receipt, receiptPath, draft.updatedAt);
      const committed = await this.#store.commit({
        expectedRevision: revision,
        runWrites: [{ record: draft, expectedRevision: run.revision }],
        writes: [{ path: receiptPath, bytes: receiptBytes, expectedSha256: null }],
        receipt: {
          method,
          idempotencyKey,
          requestHash,
          result: { artifact: receiptPath, sha256: rawSha256(receiptBytes) },
        },
      });
      return {
        revision: committed.state.revision,
        events: [{
          topic: "agent.tool.rejected",
          payload: {
            runId: run.id,
            attemptId: attempt.id,
            tool: call.name,
            callId: call.callId,
            code: rejection.code,
          },
        }],
      };
    });
    return receipt!;
  }

  async #invokeAgentCheckTool(
    prepared: PreparedManagedAttempt,
    grant: AuthorityGrant,
    call: KoniToolInvocation,
    method: string,
    idempotencyKey: string,
    requestHash: Sha256Digest,
  ): Promise<KoniToolReceipt> {
    if (this.#program.resolveAgentCheck === undefined || this.#program.compileAgentCheckResult === undefined) {
      throw new AuthorityRpcError("check_unsupported", "this compiler does not implement configured checks");
    }
    const requestedCheckId = toolString(call.arguments, "checkId");
    const configured = grant.configuredChecks;
    if (configured === undefined || !configured.ids.includes(requestedCheckId)) {
      throw new AuthorityRpcError("check_scope", `check ${requestedCheckId} is outside the immutable attempt grant`);
    }

    let check!: ResolvedAgentCheck;
    let intent!: PendingCheckIntentRecord;
    await this.#server.mutateInternal(async ({ revision }) => {
      const run = await this.#store.getRun(grant.runId);
      const attempt = validateAgentToolGrant(run, prepared.spec, grant, call, revision, this.#projectRoot);
      check = await this.#program.resolveAgentCheck!({ run, attempt, checkId: requestedCheckId });
      assertResolvedAgentCheck(check, requestedCheckId, configured);
      const serialized = canonicalEncode(check);
      const argumentsCanonical = canonicalEncode(call.arguments);
      const id = configuredCheckIntentId(grant, call.callId);
      intent = {
        id,
        attemptId: attempt.id,
        specHash: prepared.spec.specHash,
        grantHash: prepared.spec.authority.grantHash,
        callId: call.callId,
        method,
        idempotencyKey,
        requestHash,
        argumentsSha256: rawSha256(argumentsCanonical),
        argumentsSizeBytes: Buffer.byteLength(argumentsCanonical, "utf8"),
        requestedCheckId,
        resolvedCheckSha256: rawSha256(serialized),
        resolvedCheck: JSON.parse(serialized) as JsonValue,
        preparedAt: this.#timestamp(),
      };
      const draft = nextRun(run, intent.preparedAt);
      draft.pendingChecks ??= {};
      if (draft.pendingChecks[id] !== undefined) {
        throw new AuthorityRpcError("check_duplicate", "configured check identity is already pending");
      }
      draft.pendingChecks[id] = intent;
      const committed = await this.#store.commit({
        expectedRevision: revision,
        runWrites: [{ record: draft, expectedRevision: run.revision }],
      });
      return {
        revision: committed.state.revision,
        events: [{
          topic: "agent.check.started",
          payload: { runId: run.id, attemptId: attempt.id, callId: call.callId, checkId: requestedCheckId },
        }],
      };
    });

    const executions: AgentCheckExecution[] = [];
    const commandArtifacts: TransactionWrite[] = [];
    let externalCommandStarted = false;
    try {
      for (const [index, command] of check.commands.entries()) {
        if (call.signal?.aborted === true) {
          throw new AuthorityRpcError("check_aborted", "configured check was aborted before execution");
        }
        const manifestRoots = [...new Set([...command.inputPaths, ...command.outputPaths])].sort();
        const pre = await snapshotContainedPaths(prepared.spec.workspace.cwd, manifestRoots);
        const startedAt = this.#timestamp();
        await this.#assertRuntimeCurrent();
        externalCommandStarted = true;
        const processResult = await runContainedProcess({
          projectRoot: prepared.spec.workspace.cwd,
          stateRoot: this.#stateRoot,
          check: command,
          readPaths: grant.readPaths,
          writePaths: grant.writePaths,
          ...(this.#sandboxExecutable === undefined
            ? {}
            : { sandboxExecutable: this.#sandboxExecutable }),
          ...(call.signal === undefined ? {} : { signal: call.signal }),
        });
        const completedAt = this.#timestamp();
        const post = await snapshotContainedPaths(prepared.spec.workspace.cwd, manifestRoots);
        const resultSource = await readConfiguredCheckResult(
          prepared.spec.workspace.cwd,
          grant,
          command,
          processResult.stdout,
        );
        const stdoutText = exactUtf8CheckStream(processResult.stdout, "stdout");
        const stderrText = exactUtf8CheckStream(processResult.stderr, "stderr");
        const outputFiles = await readConfiguredOutputFiles(
          prepared.spec.workspace.cwd,
          grant,
          command,
          resultSource.value,
        );
        const stdoutArtifactPath = configuredCheckStreamPath(
          grant.runId,
          grant.attemptId,
          call.callId,
          index,
          "stdout",
        );
        const stderrArtifactPath = configuredCheckStreamPath(
          grant.runId,
          grant.attemptId,
          call.callId,
          index,
          "stderr",
        );
        commandArtifacts.push(
          { path: stdoutArtifactPath, bytes: processResult.stdout, expectedSha256: null },
          { path: stderrArtifactPath, bytes: processResult.stderr, expectedSha256: null },
        );
        executions.push({
          checkId: command.checkId,
          definitionHash: command.definitionHash,
          startedAt,
          completedAt,
          resolvedExecutable: processResult.resolvedExecutable,
          argv: [...processResult.argv],
          environmentSha256: processResult.environmentSha256,
          exitCode: processResult.exitCode,
          signal: processResult.signal,
          stdout: stdoutText,
          stderr: stderrText,
          stdoutSha256: rawSha256(processResult.stdout),
          stdoutSizeBytes: processResult.stdout.byteLength,
          stderrSha256: rawSha256(processResult.stderr),
          stderrSizeBytes: processResult.stderr.byteLength,
          preManifestSha256: pre.manifestSha256,
          postManifestSha256: post.manifestSha256,
          sandboxKind: processResult.sandbox.kind,
          sandboxProfileSha256: processResult.sandbox.profileSha256,
          sandboxExecutableSha256: processResult.sandbox.executableSha256,
          resultSource,
          outputFiles,
        });
      }
    } catch (error) {
      if (!externalCommandStarted) {
        await this.#discardPendingCheck(grant.runId, intent.id, intent);
      } else {
        // Once a command has crossed the process boundary it may have produced workspace or
        // external effects even when timeout, abort, result parsing, or output collection fails.
        // Retain the exact intent and stop the run for explicit reconciliation; deleting it here
        // would make a later replay indistinguishable from a duplicate side effect.
        await this.#recordRunBlocker(
          grant.runId,
          `Configured check ${requestedCheckId} ended without an authenticated result; reconcile intent ${intent.id}`,
        );
      }
      throw error;
    }

    let receipt: KoniToolReceipt | undefined;
    await this.#server.mutateInternal(async ({ revision }) => {
      const run = await this.#store.getRun(grant.runId);
      const pending = run.pendingChecks?.[intent.id];
      if (pending === undefined || canonicalHash(pending) !== canonicalHash(intent)) {
        throw new AuthorityRpcError("check_intent", "durable configured check intent changed before finalization");
      }
      const attempt = validateAgentToolGrant(run, prepared.spec, grant, call, revision, this.#projectRoot);
      const compiled = await this.#program.compileAgentCheckResult!({ run, attempt, check, executions });
      const evidenceBytes = encodeJsonArtifact(compiled.evidence);
      const evidenceArtifactPath = configuredCheckEvidencePath(run.id, attempt.id, call.callId);
      const checkRecord: RunCheckRecord = {
        id: `check-${rawSha256(`${run.id}\0${attempt.id}\0${call.callId}`).slice(7, 39)}`,
        attemptId: attempt.id,
        callId: call.callId,
        requestedCheckId,
        definitionHash: check.definitionHash,
        kind: check.kind,
        accepted: compiled.accepted,
        passed: compiled.passed,
        summary: boundedText(compiled.summary, "configured check summary", 64 * 1024),
        commands: executions.map((execution, index) => ({
          checkId: execution.checkId,
          definitionHash: execution.definitionHash,
          startedAt: execution.startedAt,
          completedAt: execution.completedAt,
          resolvedExecutable: execution.resolvedExecutable,
          argv: [...execution.argv],
          environmentSha256: execution.environmentSha256,
          exitCode: execution.exitCode,
          signal: execution.signal,
          stdoutSha256: execution.stdoutSha256,
          stdoutSizeBytes: execution.stdoutSizeBytes,
          stdoutArtifactPath: configuredCheckStreamPath(run.id, attempt.id, call.callId, index, "stdout"),
          stderrSha256: execution.stderrSha256,
          stderrSizeBytes: execution.stderrSizeBytes,
          stderrArtifactPath: configuredCheckStreamPath(run.id, attempt.id, call.callId, index, "stderr"),
          preManifestSha256: execution.preManifestSha256,
          postManifestSha256: execution.postManifestSha256,
          sandboxKind: execution.sandboxKind,
          sandboxProfileSha256: execution.sandboxProfileSha256,
          ...(execution.sandboxExecutableSha256 === undefined
            ? {}
            : { sandboxExecutableSha256: execution.sandboxExecutableSha256 }),
          resultSource: {
            kind: execution.resultSource.kind,
            ...(execution.resultSource.path === undefined ? {} : { path: execution.resultSource.path }),
            bytesSha256: execution.resultSource.bytesSha256,
            sizeBytes: execution.resultSource.sizeBytes,
          },
          outputFiles: execution.outputFiles.map((file) => ({ ...file })),
        })),
        evidenceSha256: rawSha256(evidenceBytes),
        evidenceSizeBytes: evidenceBytes.byteLength,
        evidenceArtifactPath,
        recordedAt: this.#timestamp(),
      };
      const draft = nextRun(run, checkRecord.recordedAt);
      draft.checks ??= [];
      draft.checks.push(checkRecord);
      if (compiled.ruleAuthorityEvidence !== undefined) {
        draft.ruleAuthorityEvidence = structuredClone(compiled.ruleAuthorityEvidence);
      }
      if (compiled.graphHash !== undefined) draft.graphHash = compiled.graphHash;
      if (compiled.graphRevision !== undefined) draft.graphRevision = compiled.graphRevision;
      if (compiled.tickets !== undefined) draft.tickets = structuredClone(compiled.tickets);
      draft.activity.push(...structuredClone(compiled.activity ?? []));
      delete (draft.pendingChecks ?? {})[intent.id];
      receipt = {
        protocol: KONI_TOOL_RECEIPT_PROTOCOL,
        receiptId: canonicalHash({ method, idempotencyKey, requestHash }),
        outcome: "accepted",
        summary: checkRecord.summary,
        value: {
          checkId: requestedCheckId,
          accepted: compiled.accepted,
          evidenceSha256: checkRecord.evidenceSha256,
        },
      };
      const receiptPath = toolReceiptPath(run.id, attempt.id, call.callId);
      const receiptBytes = encodeJsonArtifact(receipt);
      authorizeToolResult(draft.attempts[attempt.id]!, call, receipt!, receiptPath, draft.updatedAt);
      const committed = await this.#store.commit({
        expectedRevision: revision,
        runWrites: [{ record: draft, expectedRevision: run.revision }],
        writes: [
          ...commandArtifacts,
          ...(compiled.artifactWrites ?? []),
          { path: evidenceArtifactPath, bytes: evidenceBytes, expectedSha256: null },
          { path: receiptPath, bytes: receiptBytes, expectedSha256: null },
        ],
        receipt: {
          method,
          idempotencyKey,
          requestHash,
          result: { artifact: receiptPath, sha256: rawSha256(receiptBytes) },
        },
      });
      return {
        revision: committed.state.revision,
        events: [{
          topic: "agent.check.completed",
          payload: {
            runId: run.id,
            attemptId: attempt.id,
            callId: call.callId,
            checkId: requestedCheckId,
            accepted: compiled.accepted,
          },
        }],
      };
    });
    return receipt!;
  }

  async #discardPendingCheck(
    runId: string,
    intentId: string,
    expected: PendingCheckIntentRecord,
  ): Promise<void> {
    await this.#server.mutateInternal(async ({ revision }) => {
      const run = await this.#store.getRun(runId);
      const pending = run.pendingChecks?.[intentId];
      if (pending === undefined) return this.#noOpInternal(revision);
      if (canonicalHash(pending) !== canonicalHash(expected)) {
        throw new AuthorityRpcError("check_intent", "pending configured check changed during cleanup");
      }
      const draft = nextRun(run, this.#timestamp());
      delete (draft.pendingChecks ?? {})[intentId];
      const committed = await this.#store.commit({
        expectedRevision: revision,
        runWrites: [{ record: draft, expectedRevision: run.revision }],
      });
      return { revision: committed.state.revision };
    });
  }

  async #invokeWorkspaceMutationTool(
    prepared: PreparedManagedAttempt,
    grant: AuthorityGrant,
    call: KoniToolInvocation & { name: "koni_write_file" | "koni_edit_file" },
    method: string,
    idempotencyKey: string,
    requestHash: Sha256Digest,
  ): Promise<KoniToolReceipt> {
    let receipt: KoniToolReceipt | undefined;
    let rejected: unknown;
    await this.#server.mutateInternal(async ({ revision }) => {
      const run = await this.#store.getRun(grant.runId);
      const attempt = validateAgentToolGrant(run, prepared.spec, grant, call, revision, this.#projectRoot);
      const paths = await WorktreePathAuthority.create(prepared.spec.workspace.cwd, {
        readPaths: grant.readPaths,
        writePaths: grant.writePaths,
      });
      const planned = await planWorkspaceEffect(paths, call);
      const argumentsCanonical = canonicalEncode(call.arguments);
      const effectId = workspaceEffectId(grant, call.callId);
      const contentArtifactPath = workspaceEffectContentPath(run.id, attempt.id, effectId);
      const intent: WorkspaceEffectIntentRecord = {
        id: effectId,
        attemptId: attempt.id,
        specHash: prepared.spec.specHash,
        grantHash: prepared.spec.authority.grantHash,
        callId: call.callId,
        toolName: call.name,
        method,
        idempotencyKey,
        requestHash,
        argumentsSha256: rawSha256(argumentsCanonical),
        argumentsSizeBytes: Buffer.byteLength(argumentsCanonical, "utf8"),
        path: planned.path,
        expectedSha256: planned.expectedSha256,
        desiredSha256: rawSha256(planned.bytes),
        contentSizeBytes: planned.bytes.byteLength,
        contentArtifactPath,
        preparedAt: this.#timestamp(),
      };
      const preparedRun = nextRun(run, intent.preparedAt);
      preparedRun.pendingEffects ??= {};
      if (preparedRun.pendingEffects[effectId] !== undefined) {
        throw new AuthorityRpcError("effect_duplicate", "workspace effect identity is already pending");
      }
      preparedRun.pendingEffects[effectId] = intent;
      const intentCommit = await this.#store.commit({
        expectedRevision: revision,
        runWrites: [{ record: preparedRun, expectedRevision: run.revision }],
        writes: [{ path: contentArtifactPath, bytes: planned.bytes, expectedSha256: null }],
      });
      await this.#effectFault?.("after_prepare", structuredClone(intent));

      try {
        await applyWorkspaceEffect(paths, intent, planned.bytes);
      } catch (error) {
        const current = await this.#store.getRun(run.id);
        const rolledBack = nextRun(current, this.#timestamp());
        delete (rolledBack.pendingEffects ?? {})[effectId];
        const rollback = await this.#store.commit({
          expectedRevision: intentCommit.state.revision,
          runWrites: [{ record: rolledBack, expectedRevision: current.revision }],
        });
        rejected = error;
        return { revision: rollback.state.revision };
      }
      await this.#effectFault?.("after_apply", structuredClone(intent));

      const current = await this.#store.getRun(run.id);
      const currentIntent = current.pendingEffects?.[effectId];
      if (currentIntent === undefined || canonicalHash(currentIntent) !== canonicalHash(intent)) {
        throw new AuthorityRpcError("effect_intent", "durable workspace effect intent changed before finalization");
      }
      const draft = nextRun(current, this.#timestamp());
      const mutable = draft.attempts[attempt.id];
      if (mutable === undefined) throw new AuthorityRpcError("effect_attempt", "workspace effect attempt disappeared");
      receipt = workspaceEffectReceipt(intent);
      const receiptPath = toolReceiptPath(run.id, attempt.id, call.callId);
      const receiptBytes = encodeJsonArtifact(receipt);
      authorizeToolResultFromDigests(
        mutable,
        intent.callId,
        intent.toolName,
        intent.argumentsSha256,
        intent.argumentsSizeBytes,
        receipt,
        receiptPath,
        draft.updatedAt,
      );
      delete (draft.pendingEffects ?? {})[effectId];
      const committed = await this.#store.commit({
        expectedRevision: intentCommit.state.revision,
        runWrites: [{ record: draft, expectedRevision: current.revision }],
        writes: [{ path: receiptPath, bytes: receiptBytes, expectedSha256: null }],
        receipt: {
          method,
          idempotencyKey,
          requestHash,
          result: { artifact: receiptPath, sha256: rawSha256(receiptBytes) },
        },
      });
      return {
        revision: committed.state.revision,
        events: [{
          topic: "agent.tool.accepted",
          payload: { runId: run.id, attemptId: attempt.id, tool: call.name, callId: call.callId },
        }],
      };
    });
    if (rejected !== undefined) throw rejected;
    return receipt!;
  }

  async #invokeTerminalTool(
    prepared: PreparedManagedAttempt,
    grant: AuthorityGrant,
    call: KoniToolInvocation,
    method: string,
    idempotencyKey: string,
    requestHash: Sha256Digest,
  ): Promise<KoniToolReceipt> {
    let receipt: KoniToolReceipt | undefined;
    await this.#server.mutateInternal(async ({ revision }) => {
      const run = await this.#store.getRun(grant.runId);
      const attempt = validateAgentToolGrant(run, prepared.spec, grant, call, revision, this.#projectRoot);
      const outputBytes = encodeJsonArtifact(call.arguments);
      if (outputBytes.byteLength > prepared.spec.terminal.maxOutputBytes) {
        throw new AuthorityRpcError("terminal_size", "terminal output exceeds its immutable launch bound");
      }

      const draft = nextRun(run, this.#timestamp());
      let compilerWrites: readonly TransactionWrite[] = [];
      let terminalSummary: string;
      if (attempt.kind === "planning") {
        const compiled = await this.#program.compilePlanningOutput({
          run,
          attemptId: attempt.id,
          output: call.arguments,
        });
        draft.plan = {
          ...structuredClone(compiled.plan),
          // Steering is operator-authored authority state. A planner may consume
          // it, but its terminal payload cannot erase or rewrite that history.
          steeringHistory: structuredClone(run.plan?.steeringHistory ?? compiled.plan.steeringHistory),
          status: "awaiting_approval",
        };
        if (compiled.graphHash !== undefined) draft.graphHash = compiled.graphHash;
        if (compiled.graphRevision !== undefined) draft.graphRevision = compiled.graphRevision;
        if (compiled.tickets !== undefined) draft.tickets = structuredClone(compiled.tickets);
        draft.activity.push(...structuredClone(compiled.activity ?? []));
        draft.currentPipelineStageId = approvalStage(draft);
        applyLifecycle(draft, { type: "plan_submitted", atMs: this.#now().getTime() });
        compilerWrites = compiled.artifactWrites ?? [];
        terminalSummary = "Plan compiled";
      } else {
        const assignment = assignmentForAttempt(run, attempt);
        if (assignment === undefined) {
          throw new AuthorityRpcError("terminal_assignment", "work submission lost its compiler assignment");
        }
        const compiled = await this.#program.compileAssignmentOutput({
          run,
          assignment,
          attemptId: attempt.id,
          output: call.arguments,
        });
        if (compiled.tickets !== undefined) draft.tickets = structuredClone(compiled.tickets);
        finishAssignment(draft, assignment, compiled.outcome, draft.updatedAt);
        if (compiled.graphHash !== undefined) draft.graphHash = compiled.graphHash;
        if (compiled.graphRevision !== undefined) draft.graphRevision = compiled.graphRevision;
        draft.activity.push(...structuredClone(compiled.activity ?? []));
        compilerWrites = compiled.artifactWrites ?? [];
        terminalSummary = compiled.outcome.status === "completed"
          ? compiled.outcome.summary
          : compiled.outcome.blocker;
        if (compiled.outcome.status === "failed") {
          applyLifecycle(draft, {
            type: "blocked",
            atMs: this.#now().getTime(),
            reason: compiled.outcome.blocker,
          });
        }
      }

      receipt = {
        protocol: KONI_TOOL_RECEIPT_PROTOCOL,
        receiptId: canonicalHash({ method, idempotencyKey, requestHash }),
        outcome: "accepted",
        summary: "Structured output compiled and accepted",
        value: { accepted: true },
      };
      const receiptPath = toolReceiptPath(run.id, attempt.id, call.callId);
      const receiptBytes = encodeJsonArtifact(receipt);
      const mutable = draft.attempts[attempt.id]!;
      authorizeToolResult(mutable, call, receipt, receiptPath, draft.updatedAt);
      mutable.status = "terminal_accepted";
      mutable.terminalSummary = boundedText(terminalSummary, "terminal summary", 64 * 1024);
      mutable.terminalOutputSha256 = rawSha256(outputBytes);
      mutable.terminalOutputSizeBytes = outputBytes.byteLength;
      mutable.terminalAcceptedAt = draft.updatedAt;

      const pointer: JsonValue = {
        artifact: receiptPath,
        sha256: rawSha256(receiptBytes),
      };
      const committed = await this.#store.commit({
        expectedRevision: revision,
        runWrites: [{ record: draft, expectedRevision: run.revision }],
        writes: [
          ...compilerWrites,
          { path: receiptPath, bytes: receiptBytes, expectedSha256: null },
          {
            path: terminalOutputPath(run.id, attempt.id),
            bytes: outputBytes,
            expectedSha256: null,
          },
        ],
        receipt: { method, idempotencyKey, requestHash, result: pointer },
      });
      return {
        revision: committed.state.revision,
        events: [{
          topic: "agent.terminal.accepted",
          payload: { runId: run.id, attemptId: attempt.id, callId: call.callId },
        }],
      };
    });
    return receipt!;
  }

  async #invokeQuestionTool(
    prepared: PreparedManagedAttempt,
    grant: AuthorityGrant,
    call: KoniToolInvocation,
    method: string,
    idempotencyKey: string,
    requestHash: Sha256Digest,
  ): Promise<KoniToolReceipt> {
    const questionId = this.#createId("question");
    let resolveAnswer!: (answer: { label: string; selectedOptionId?: string; notes?: string }) => void;
    let rejectAnswer!: (error: Error) => void;
    const answer = new Promise<{ label: string; selectedOptionId?: string; notes?: string }>((resolve, reject) => {
      resolveAnswer = resolve;
      rejectAnswer = reject;
    });
    if (this.#questionWaiters.has(questionId)) throw new Error(`duplicate question waiter ${questionId}`);
    this.#questionWaiters.set(questionId, { resolve: resolveAnswer, reject: rejectAnswer });
    const abort = () => rejectAnswer(new AuthorityRpcError("question_aborted", "question wait was aborted"));
    call.signal?.addEventListener("abort", abort, { once: true });
    try {
      await this.#server.mutateInternal(async ({ revision }) => {
        const run = await this.#store.getRun(grant.runId);
        const attempt = validateAgentToolGrant(run, prepared.spec, grant, call, revision, this.#projectRoot);
        const draft = nextRun(run, this.#timestamp());
        const question: RunQuestionRecord = {
          id: questionId,
          attemptId: attempt.id,
          prompt: toolString(call.arguments, "prompt"),
          options: validateQuestionOptions(call.arguments.options as RunQuestionRecord["options"]),
          allowsNotes: call.arguments.allowsNotes !== false,
          askedAt: draft.updatedAt,
          answeredAt: undefined,
          selectedOptionId: undefined,
          notes: undefined,
        };
        draft.questions[questionId] = question;
        applyLifecycle(draft, {
          type: "question_opened",
          atMs: this.#now().getTime(),
          question: { id: questionId, attemptId: attempt.id },
        });
        draft.attempts[attempt.id]!.status = "waiting_question";
        const committed = await this.#store.commit({
          expectedRevision: revision,
          runWrites: [{ record: draft, expectedRevision: run.revision }],
        });
        return {
          revision: committed.state.revision,
          events: [{ topic: "run.question.opened", payload: { runId: run.id, questionId } }],
        };
      });

      const answered = await answer;
      let receipt: KoniToolReceipt | undefined;
      await this.#server.mutateInternal(async ({ revision }) => {
        const run = await this.#store.getRun(grant.runId);
        const attempt = validateAgentToolGrant(run, prepared.spec, grant, call, revision, this.#projectRoot);
        const question = run.questions[questionId];
        if (question?.answeredAt === undefined) {
          throw new AuthorityRpcError("question_state", "question resumed without a durable answer");
        }
        receipt = {
          protocol: KONI_TOOL_RECEIPT_PROTOCOL,
          receiptId: canonicalHash({ method, idempotencyKey, requestHash }),
          outcome: "accepted",
          summary: "Question answered",
          value: {
            questionId,
            label: answered.label,
            ...(answered.selectedOptionId === undefined ? {} : { selectedOptionId: answered.selectedOptionId }),
            ...(answered.notes === undefined ? {} : { notes: answered.notes }),
          },
        };
        const receiptPath = toolReceiptPath(run.id, attempt.id, call.callId);
        const bytes = encodeJsonArtifact(receipt);
        const draft = nextRun(run, this.#timestamp());
        authorizeToolResult(draft.attempts[attempt.id]!, call, receipt!, receiptPath, draft.updatedAt);
        const committed = await this.#store.commit({
          expectedRevision: revision,
          runWrites: [{ record: draft, expectedRevision: run.revision }],
          writes: [{ path: receiptPath, bytes, expectedSha256: null }],
          receipt: {
            method,
            idempotencyKey,
            requestHash,
            result: { artifact: receiptPath, sha256: rawSha256(bytes) },
          },
        });
        return {
          revision: committed.state.revision,
          events: [{ topic: "agent.question.resumed", payload: { runId: run.id, attemptId: attempt.id, questionId } }],
        };
      });
      return receipt!;
    } finally {
      call.signal?.removeEventListener("abort", abort);
      this.#questionWaiters.delete(questionId);
    }
  }

  async #readToolReceipt(pointer: JsonValue | undefined): Promise<KoniToolReceipt> {
    const object = requiredObject(pointer);
    const artifact = requiredString(object, "artifact");
    const expected = requiredString(object, "sha256");
    const bytes = await this.#store.readArtifact(artifact);
    if (rawSha256(bytes) !== expected) {
      throw new AuthorityRpcError("tool_receipt_hash", "durable tool receipt bytes changed");
    }
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!isKoniToolReceipt(value)) {
      throw new AuthorityRpcError("tool_receipt_shape", "durable tool receipt is malformed");
    }
    // Pi transcript details are authenticated against the originally accepted receipt. Replays
    // therefore return the exact same semantic object; replay annotations belong in RPC/UI events,
    // never inside the hash-bound tool result.
    return structuredClone(value);
  }

  async #executeAgentToolEffect(
    run: RunRecord,
    attempt: AgentAttemptRecord,
    grant: AuthorityGrant,
    prepared: PreparedManagedAttempt,
    call: KoniToolInvocation,
  ): Promise<AgentToolCompilation> {
    const args = call.arguments;
    if (call.name === "koni_context") {
      const content = prepared.contextContent ?? "";
      const dynamic = this.#program.selectDynamicGraphContext === undefined
        ? undefined
        : await this.#program.selectDynamicGraphContext({ run, attempt, spec: prepared.spec });
      return {
        summary: "Compiler assignment and current dynamic graph context returned",
        value: {
          ...(textPage(
            content,
            toolInteger(args, "offsetChars", 0),
            toolInteger(args, "maxChars", 131_072),
            { contextHash: prepared.spec.authority.authoritativeContextHash },
          ) as Record<string, JsonValue>),
          ...(dynamic === undefined ? {} : {
            dynamicContextRefresh: {
              envelopeHash: dynamic.envelopeHash,
              semanticRevision: dynamic.envelope.binding.semanticRevision,
              semanticHash: dynamic.envelope.binding.semanticHash,
              contextualRevision: dynamic.envelope.binding.contextualRevision,
              contextualHash: dynamic.envelope.binding.contextualHash,
              selected: dynamic.envelope.selection.selected,
              candidateCount: dynamic.envelope.selection.candidateCount,
              filteredCount: dynamic.envelope.selection.filteredCount,
              budgetOmissionCount: dynamic.envelope.selection.budgetOmissionCount,
            },
          }),
        } as unknown as JsonValue,
      };
    }
    if (call.name === "koni_read_resource") {
      const resourceId = toolString(args, "resourceId");
      const resource = prepared.spec.resources.entries.find((entry) => entry.id === resourceId);
      if (resource === undefined) {
        throw new AuthorityRpcError("resource_scope", "resource is outside the immutable launch inventory");
      }
      if (
        Buffer.byteLength(resource.content, "utf8") !== resource.sizeBytes ||
        rawSha256(resource.content) !== resource.sha256
      ) {
        throw new AuthorityRpcError("resource_hash", "compiler-issued resource bytes changed");
      }
      return {
        summary: `Read resource ${resourceId}`,
        value: textPage(
          resource.content,
          toolInteger(args, "offsetChars", 0),
          toolInteger(args, "maxChars", 131_072),
          {
            resourceId,
            relativePath: resource.relativePath,
            sha256: resource.sha256,
          },
        ),
      };
    }
    const paths = await WorktreePathAuthority.create(prepared.spec.workspace.cwd, {
      readPaths: grant.readPaths,
      writePaths: grant.writePaths,
    });
    if (call.name === "koni_read_file") {
      const path = toolString(args, "path");
      const file = await paths.read(path);
      const offset = toolInteger(args, "offset", 0);
      const maxBytes = toolInteger(args, "maxBytes", 1024 * 1024);
      if (offset > file.bytes.byteLength) throw new AuthorityRpcError("read_offset", "read offset exceeds file size");
      const end = Math.min(file.bytes.byteLength, offset + maxBytes);
      return {
        summary: `Read ${path}`,
        value: {
          path,
          sha256: file.sha256,
          offset,
          nextOffset: end,
          eof: end === file.bytes.byteLength,
          content: file.bytes.subarray(offset, end).toString("utf8"),
        },
      };
    }
    if (call.name === "koni_list_files") {
      const root = typeof args.path === "string" ? args.path : ".";
      return {
        summary: `Listed ${root}`,
        value: {
          entries: (await paths.list(root, {
            recursive: args.recursive === true,
            limit: toolInteger(args, "limit", 1_000),
          })).map((entry) => ({ ...entry })),
        },
      };
    }
    if (call.name === "koni_search_files") {
      const roots = Array.isArray(args.roots) ? args.roots as string[] : undefined;
      return {
        summary: `Searched for ${toolString(args, "query")}`,
        value: {
          matches: await paths.search(toolString(args, "query"), {
            ...(roots === undefined ? {} : { roots }),
            caseSensitive: args.caseSensitive !== false,
            limit: toolInteger(args, "limit", 200),
          }).then((matches) => matches.map((match) => ({ ...match }))),
        },
      };
    }
    if (this.#program.executeAgentTool === undefined) {
      throw new AuthorityRpcError("tool_unsupported", `${call.name} is not implemented by this profile compiler`);
    }
    return this.#program.executeAgentTool({ run, attempt, grant, spec: prepared.spec, call });
  }

  async #markAttemptRunning(
    runId: string,
    attemptId: string,
    handle: ManagedSessionHandle | PiAttemptProcessHandle,
  ): Promise<void> {
    await this.#server.mutateInternal(async ({ revision }) => {
      const run = await this.#store.getRun(runId);
      const attempt = run.attempts[attemptId];
      if (attempt === undefined || (attempt.status !== "queued" && attempt.status !== "running")) {
        return this.#noOpInternal(revision);
      }
      const draft = nextRun(run, this.#timestamp());
      const mutable = draft.attempts[attemptId]!;
      mutable.status = "running";
      mutable.startedAt ??= draft.updatedAt;
      mutable.sessionFile = handle.session.sessionFile;
      const committed = await this.#store.commit({
        expectedRevision: revision,
        runWrites: [{ record: draft, expectedRevision: run.revision }],
      });
      return {
        revision: committed.state.revision,
        events: [{ topic: "agent.started", payload: { runId, attemptId } }],
      };
    });
  }

  #attachOutcome(
    runId: string,
    attemptId: string,
    assignment: ReadyAssignment | undefined,
    handle: ManagedSessionHandle | PiAttemptProcessHandle,
  ): void {
    if (this.#attachedOutcomes.has(attemptId)) return;
    this.#attachedOutcomes.add(attemptId);
    const completion = handle.outcome.then(
      (outcome) => this.#finishAttempt(runId, attemptId, assignment, outcome),
      (error) => this.#failLaunch(runId, attemptId, assignment, errorMessage(error)),
    ).finally(() => this.#attachedOutcomes.delete(attemptId));
    this.#trackBackground(completion);
  }

  async #finishAttempt(
    runId: string,
    attemptId: string,
    assignment: ReadyAssignment | undefined,
    outcome: ManagedSessionOutcome,
  ): Promise<void> {
    const observed = await this.#store.getRun(runId);
    const observedAttempt = observed.attempts[attemptId];
    if (observedAttempt?.status === "terminal_accepted") {
      if (outcome.status === "completed") {
        const accepted = await this.#readTerminalOutput(
          await this.#loadStoredLaunchSpec(observed, observedAttempt),
          observedAttempt,
        );
        if (canonicalHash(accepted) !== canonicalHash(outcome.terminalOutput)) {
          await this.#recordRunBlocker(runId, "Pi terminal output differs from the authority-accepted artifact");
          return;
        }
      }
      await this.#finalizeAcceptedAttempt(runId, attemptId, outcome);
      return;
    }
    if (outcome.status !== "completed") {
      await this.#failLaunch(
        runId,
        attemptId,
        assignment,
        outcome.status === "failed" ? outcome.error : outcome.reason,
        outcome,
      );
      return;
    }
    const run = observed;
    const attempt = run.attempts[attemptId];
    if (attempt === undefined || !new Set(["queued", "running", "waiting_question"]).has(attempt.status)) return;
    if (attempt.kind === "planning") {
      const compiled = await this.#program.compilePlanningOutput({
        run,
        attemptId,
        output: outcome.terminalOutput,
      });
      await this.#server.mutateInternal(async ({ revision }) => {
        const current = await this.#store.getRun(runId);
        const currentAttempt = current.attempts[attemptId];
        if (currentAttempt === undefined || isTerminalAttempt(currentAttempt.status)) return this.#noOpInternal(revision);
        const draft = nextRun(current, this.#timestamp());
        finishAttemptRecord(draft.attempts[attemptId]!, outcome, draft.updatedAt, "Plan compiled");
        draft.plan = {
          ...structuredClone(compiled.plan),
          steeringHistory: structuredClone(current.plan?.steeringHistory ?? compiled.plan.steeringHistory),
          status: "awaiting_approval",
        };
        if (compiled.graphHash !== undefined) draft.graphHash = compiled.graphHash;
        if (compiled.graphRevision !== undefined) draft.graphRevision = compiled.graphRevision;
        if (compiled.tickets !== undefined) draft.tickets = structuredClone(compiled.tickets);
        draft.activity.push(...structuredClone(compiled.activity ?? []));
        draft.currentPipelineStageId = approvalStage(draft);
        applyLifecycle(draft, { type: "plan_submitted", atMs: this.#now().getTime() });
        const committed = await this.#store.commit({
          expectedRevision: revision,
          runWrites: [{ record: draft, expectedRevision: current.revision }],
          ...(compiled.artifactWrites === undefined ? {} : { writes: compiled.artifactWrites }),
        });
        return {
          revision: committed.state.revision,
          events: [{ topic: "run.plan.ready", payload: { runId, attemptId } }],
        };
      });
      return;
    }
    if (assignment === undefined) {
      await this.#failLaunch(runId, attemptId, undefined, "completed work attempt lost its assignment", outcome);
      return;
    }
    const compiled = await this.#program.compileAssignmentOutput({
      run,
      assignment,
      attemptId,
      output: outcome.terminalOutput,
    });
    let publishTicket = false;
    let finishDisposition: ReturnType<typeof finishAssignment>["disposition"] | undefined;
    await this.#server.mutateInternal(async ({ revision }) => {
      const current = await this.#store.getRun(runId);
      const currentAttempt = current.attempts[attemptId];
      if (currentAttempt === undefined || isTerminalAttempt(currentAttempt.status)) return this.#noOpInternal(revision);
      const draft = nextRun(current, this.#timestamp());
      if (compiled.tickets !== undefined) {
        draft.tickets = retainTicketAuthorityFields(current.tickets, structuredClone(compiled.tickets));
      }
      finishAttemptRecord(
        draft.attempts[attemptId]!,
        outcome,
        draft.updatedAt,
        compiled.outcome.status === "completed" ? compiled.outcome.summary : compiled.outcome.blocker,
      );
      finishDisposition = finishAssignment(draft, assignment, compiled.outcome, draft.updatedAt).disposition;
      const completedTicket = draft.tickets[assignment.ticketId];
      if (compiled.outcome.status === "completed" && completedTicket?.status === "completed") {
        completedTicket.status = "review";
        publishTicket = true;
      }
      if (compiled.graphHash !== undefined) draft.graphHash = compiled.graphHash;
      if (compiled.graphRevision !== undefined) draft.graphRevision = compiled.graphRevision;
      draft.activity.push(...structuredClone(compiled.activity ?? []));
      const committed = await this.#store.commit({
        expectedRevision: revision,
        runWrites: [{ record: draft, expectedRevision: current.revision }],
        ...(compiled.artifactWrites === undefined ? {} : { writes: compiled.artifactWrites }),
      });
      return {
        revision: committed.state.revision,
        events: [{ topic: "agent.completed", payload: { runId, attemptId, ticketId: assignment.ticketId } }],
      };
    });
    if (compiled.outcome.status === "failed") {
      if (finishDisposition === "review_rework") {
        await this.#tick(runId);
        return;
      }
      await this.#recordRunBlocker(runId, compiled.outcome.blocker);
      return;
    }
    if (publishTicket) {
      await this.#integrateTicket(runId, assignment.ticketId);
      return;
    }
    await this.#tick(runId);
  }

  async #finalizeAcceptedAttempt(
    runId: string,
    attemptId: string,
    outcome: ManagedSessionOutcome,
  ): Promise<void> {
    let shouldTick = false;
    await this.#server.mutateInternal(async ({ revision }) => {
      const run = await this.#store.getRun(runId);
      const attempt = run.attempts[attemptId];
      if (attempt === undefined || attempt.status !== "terminal_accepted") {
        return this.#noOpInternal(revision);
      }
      const draft = nextRun(run, this.#timestamp());
      const mutable = draft.attempts[attemptId]!;
      mutable.status = "completed";
      mutable.endedAt = draft.updatedAt;
      applyUsage(mutable, outcome.usage);
      shouldTick = draft.lifecycle.phase === "executing";
      const committed = await this.#store.commit({
        expectedRevision: revision,
        runWrites: [{ record: draft, expectedRevision: run.revision }],
      });
      return {
        revision: committed.state.revision,
        events: [{ topic: "agent.completed", payload: { runId, attemptId } }],
      };
    });
    if (shouldTick) await this.#tick(runId);
  }

  async #failLaunch(
    runId: string,
    attemptId: string,
    assignment: ReadyAssignment | undefined,
    error: string,
    outcome?: ManagedSessionOutcome,
  ): Promise<void> {
    await this.#server.mutateInternal(async ({ revision }) => {
      const run = await this.#store.getRun(runId);
      const attempt = run.attempts[attemptId];
      if (attempt === undefined || isTerminalAttempt(attempt.status)) return this.#noOpInternal(revision);
      const draft = nextRun(run, this.#timestamp());
      const mutable = draft.attempts[attemptId]!;
      mutable.status = outcome?.status === "aborted" ? "aborted" : "failed";
      mutable.error = error;
      mutable.endedAt = draft.updatedAt;
      mutable.terminalSummary = error;
      if (outcome !== undefined) applyUsage(mutable, outcome.usage);
      const lifecycleCancellation = new Set(["pausing", "paused", "deleting", "deleted"]).has(
        draft.lifecycle.phase,
      );
      if (assignment !== undefined && lifecycleCancellation) {
        resetAssignmentAfterInterruption(draft, assignment, draft.updatedAt);
      } else if (assignment !== undefined) {
        finishAssignment(draft, assignment, { status: "failed", blocker: error }, draft.updatedAt);
      } else if (draft.lifecycle.phase === "planning") {
        applyLifecycle(draft, { type: "blocked", atMs: this.#now().getTime(), reason: error });
      }
      const committed = await this.#store.commit({
        expectedRevision: revision,
        runWrites: [{ record: draft, expectedRevision: run.revision }],
      });
      return {
        revision: committed.state.revision,
        events: [{ topic: "agent.failed", payload: { runId, attemptId, error } }],
      };
    });
  }

  async #tick(runId: string): Promise<void> {
    let run = await this.#store.getRun(runId);
    if (run.lifecycle.phase !== "executing" && run.lifecycle.phase !== "verifying") return;
    if (run.lifecycle.phase === "verifying") {
      await this.#verify(runId);
      return;
    }
    const awaitingPublication = Object.values(run.tickets)
      .filter((ticket) => ticket.status === "review")
      .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id))[0];
    if (awaitingPublication !== undefined) {
      await this.#integrateTicket(runId, awaitingPublication.id);
      return;
    }
    const maxParallel = run.executionConfig?.maxParallel ?? 1;
    const projection = deriveReadyAssignments(run, maxParallel);
    for (const assignment of projection.ready) {
      await this.#ensureTicketCycle(runId, assignment.ticketId);
      run = await this.#store.getRun(runId);
      const stillReady = deriveReadyAssignments(run, maxParallel).ready.find(
        (candidate) => candidate.ticketId === assignment.ticketId && candidate.stepId === assignment.stepId,
      );
      if (stillReady !== undefined) await this.#launchAssignment(run, stillReady);
    }
    run = await this.#store.getRun(runId);
    if (
      Object.keys(run.tickets).length > 0 &&
      Object.values(run.tickets).every((ticket) => ticket.status === "completed") &&
      !Object.values(run.attempts).some((attempt) =>
        attempt.status === "running" || attempt.status === "queued" || attempt.status === "terminal_accepted"
      )
    ) {
      await this.#server.mutateInternal(async ({ revision }) => {
        const current = await this.#store.getRun(runId);
        if (current.lifecycle.phase !== "executing") return this.#noOpInternal(revision);
        const draft = nextRun(current, this.#timestamp());
        draft.currentPipelineStageId = verificationStage(draft);
        applyLifecycle(draft, { type: "verification_started", atMs: this.#now().getTime() });
        const committed = await this.#store.commit({
          expectedRevision: revision,
          runWrites: [{ record: draft, expectedRevision: current.revision }],
        });
        return { revision: committed.state.revision };
      });
      await this.#verify(runId);
    }
  }

  /** Reserve, recover, and materialize one durable ticket checkout before compiling an attempt. */
  async #ensureTicketCycle(runId: string, ticketId: string): Promise<void> {
    let run = await this.#store.getRun(runId);
    const ticket = run.tickets[ticketId];
    if (ticket === undefined) throw new AuthorityRpcError("ticket_missing", `ticket does not exist: ${ticketId}`);
    let cycleId = ticket.gitCycleId;
    const recorded = cycleId === undefined ? undefined : run.git.ticketCycles[cycleId];
    if (recorded !== undefined && new Set(["active", "candidate"]).has(recorded.status)) {
      if (ticket.worktreePath === recorded.worktree && ticket.branch === recorded.branchRef) return;
    } else if (cycleId !== undefined && recorded === undefined) {
      // A crash may leave the compiler reservation just ahead of the Git intent. Reuse it exactly.
    } else if (cycleId !== undefined) {
      cycleId = undefined;
    }

    if (cycleId === undefined) {
      const allocated = `cycle-${randomUUID()}`;
      await this.#server.mutateInternal(async ({ revision }) => {
        run = await this.#store.getRun(runId);
        const current = run.tickets[ticketId];
        if (current === undefined) throw new AuthorityRpcError("ticket_missing", `ticket does not exist: ${ticketId}`);
        const existing = current.gitCycleId;
        if (existing !== undefined) {
          const existingCycle = run.git.ticketCycles[existing];
          if (existingCycle === undefined || new Set(["active", "candidate"]).has(existingCycle.status)) {
            cycleId = existing;
            return this.#noOpInternal(revision);
          }
        }
        const draft = nextRun(run, this.#timestamp());
        const mutable = draft.tickets[ticketId]!;
        mutable.gitCycleId = allocated;
        mutable.worktreePath = undefined;
        mutable.branch = undefined;
        cycleId = allocated;
        const committed = await this.#store.commit({
          expectedRevision: revision,
          runWrites: [{ record: draft, expectedRevision: run.revision }],
        });
        return { revision: committed.state.revision };
      });
    }
    if (cycleId === undefined) throw new AuthorityRpcError("git_cycle", "ticket Git cycle was not reserved");
    run = await this.#store.getRun(runId);
    if (run.git.ticketCycles[cycleId] === undefined) {
      await this.#withGit(runId, async () => {
        const current = await this.#store.getRun(runId);
        if (current.git.ticketCycles[cycleId!] !== undefined) return;
        await this.#git.openTicketCycle(
          current.git,
          { ticketId, cycleId: cycleId! },
          this.#gitJournal(runId),
        );
      });
    }
    await this.#server.mutateInternal(async ({ revision }) => {
      run = await this.#store.getRun(runId);
      const current = run.tickets[ticketId];
      const cycle = run.git.ticketCycles[cycleId!];
      if (current === undefined || cycle === undefined || cycle.ticketId !== ticketId) {
        throw new AuthorityRpcError("git_cycle", "materialized ticket cycle does not match compiler ticket");
      }
      if (
        current.gitCycleId === cycleId &&
        current.worktreePath === cycle.worktree &&
        current.branch === cycle.branchRef
      ) return this.#noOpInternal(revision);
      const draft = nextRun(run, this.#timestamp());
      const mutable = draft.tickets[ticketId]!;
      mutable.gitCycleId = cycle.cycleId;
      mutable.worktreePath = cycle.worktree;
      mutable.branch = cycle.branchRef;
      const committed = await this.#store.commit({
        expectedRevision: revision,
        runWrites: [{ record: draft, expectedRevision: run.revision }],
      });
      return { revision: committed.state.revision };
    });
  }

  /** Scope-check, checkpoint, and compose one completed semantic ticket into the run branch. */
  async #integrateTicket(runId: string, ticketId: string): Promise<void> {
    await this.#withGit(runId, () => this.#integrateTicketLocked(runId, ticketId));
  }

  async #integrateTicketLocked(runId: string, ticketId: string): Promise<void> {
    try {
      let run = await this.#store.getRun(runId);
      const ticket = run.tickets[ticketId];
      if (ticket === undefined || ticket.status !== "review") return;
      const cycleId = ticket.gitCycleId;
      if (cycleId === undefined) throw new AuthorityRpcError("git_cycle", "completed ticket has no Git cycle");
      let cycle = run.git.ticketCycles[cycleId];
      if (cycle === undefined) throw new AuthorityRpcError("git_cycle", "completed ticket Git cycle is missing");
      const scope = ticketGitScope(ticket);

      if (cycle.status === "active" || cycle.status === "candidate") {
        const checkpointed = await this.#git.commitTicketCandidate(run.git, {
          cycleId,
          scope,
          subject: `Koni ticket: ${ticket.title}`,
          body: `Run ${run.id}\nTicket ${ticket.id}`,
        }, this.#gitJournal(runId));
        await this.#persistGitLifecycle(runId, checkpointed);
        run = await this.#store.getRun(runId);
        const publication = await this.#git.publishTicketCandidate(run.git, {
          cycleId,
          scope,
          subject: `Integrate Koni ticket: ${ticket.title}`,
          body: `Run ${run.id}\nTicket ${ticket.id}`,
        }, this.#gitJournal(runId));
        await this.#persistGitLifecycle(runId, publication.lifecycle);
        if (publication.status === "conflict") {
          await this.#createTicketIntegrationWork(
            runId,
            ticketId,
            publication.conflict.message,
            publication.conflict.candidateOid,
          );
          this.#background(() => this.#tick(runId), runId);
          return;
        }
        run = await this.#store.getRun(runId);
        cycle = run.git.ticketCycles[cycleId]!;
      }

      if (cycle.status === "conflict") {
        await this.#createTicketIntegrationWork(
          runId,
          ticketId,
          cycle.blocker ?? "Ticket candidate conflicts with the current run tree",
          cycle.ticketHeadOid,
        );
        this.#background(() => this.#tick(runId), runId);
        return;
      }
      if (cycle.status !== "integrated" && cycle.status !== "retired") {
        throw new AuthorityRpcError("git_cycle", `ticket cycle cannot settle from ${cycle.status}`);
      }
      if (cycle.status === "integrated") {
        const retired = await this.#git.retireTicketCycle(run.git, cycleId, this.#gitJournal(runId));
        await this.#persistGitLifecycle(runId, retired);
      }
      await this.#server.mutateInternal(async ({ revision }) => {
        const current = await this.#store.getRun(runId);
        const currentTicket = current.tickets[ticketId];
        if (currentTicket === undefined || currentTicket.status !== "review") {
          return this.#noOpInternal(revision);
        }
        const draft = nextRun(current, this.#timestamp());
        const mutable = draft.tickets[ticketId]!;
        mutable.status = "completed";
        mutable.blocker = undefined;
        mutable.updatedAt = draft.updatedAt;
        if (mutable.integrationForTicketId !== undefined) {
          const predecessor = draft.tickets[mutable.integrationForTicketId];
          if (predecessor !== undefined) {
            predecessor.status = "completed";
            predecessor.blocker = undefined;
            predecessor.updatedAt = draft.updatedAt;
          }
        }
        draft.activity.push(activity(
          this.#createId("activity"),
          draft.updatedAt,
          "git",
          `Integrated ticket: ${mutable.title}`,
        ));
        const committed = await this.#store.commit({
          expectedRevision: revision,
          runWrites: [{ record: draft, expectedRevision: current.revision }],
        });
        return {
          revision: committed.state.revision,
          events: [{ topic: "ticket.integrated", payload: { runId, ticketId } }],
        };
      });
      this.#background(() => this.#tick(runId), runId);
    } catch (error) {
      await this.#recordRunBlocker(runId, `Ticket publication failed: ${errorMessage(error)}`);
    }
  }

  async #createTicketIntegrationWork(
    runId: string,
    conflictedTicketId: string,
    conflictReport: string,
    candidateOid: string,
  ): Promise<void> {
    const run = await this.#store.getRun(runId);
    const existing = Object.values(run.tickets).find(
      (ticket) => ticket.integrationForTicketId === conflictedTicketId && ticket.status !== "cancelled",
    );
    const integration = existing ?? await this.#program.createIntegrationTicket({
      run,
      conflictReport,
      targetOid: candidateOid,
    });
    await this.#server.mutateInternal(async ({ revision }) => {
      const current = await this.#store.getRun(runId);
      const source = current.tickets[conflictedTicketId];
      if (source === undefined) throw new AuthorityRpcError("ticket_missing", "conflicted ticket disappeared");
      if (Object.values(current.tickets).some(
        (ticket) => ticket.integrationForTicketId === conflictedTicketId && ticket.status !== "cancelled",
      )) return this.#noOpInternal(revision);
      const draft = nextRun(current, this.#timestamp());
      const mutableSource = draft.tickets[conflictedTicketId]!;
      mutableSource.status = "blocked";
      mutableSource.blocker = conflictReport;
      const prepared = structuredClone(integration);
      prepared.integrationForTicketId = conflictedTicketId;
      delete prepared.gitCycleId;
      prepared.worktreePath = undefined;
      prepared.branch = undefined;
      draft.tickets[prepared.id] = prepared;
      draft.activity.push(activity(
        this.#createId("activity"),
        draft.updatedAt,
        "git",
        `Created integration work for ticket: ${mutableSource.title}`,
      ));
      const committed = await this.#store.commit({
        expectedRevision: revision,
        runWrites: [{ record: draft, expectedRevision: current.revision }],
      });
      return {
        revision: committed.state.revision,
        events: [{ topic: "ticket.integration.required", payload: { runId, ticketId: prepared.id } }],
      };
    });
  }

  /** Persist lifecycle-only projections for deterministic/no-op Git operations with no intent. */
  async #persistGitLifecycle(runId: string, lifecycle: RunGitLifecycleRecord): Promise<void> {
    await this.#server.mutateInternal(async ({ revision }) => {
      const run = await this.#store.getRun(runId);
      if (canonicalJsonHash(run.git) === canonicalJsonHash(lifecycle)) return this.#noOpInternal(revision);
      if (
        lifecycle.runId !== run.id ||
        lifecycle.projectRoot !== run.git.projectRoot ||
        lifecycle.commonDirectory !== run.git.commonDirectory
      ) throw new AuthorityRpcError("git_lifecycle_identity", "Git projection belongs to another run");
      const draft = nextRun(run, this.#timestamp());
      draft.git = structuredClone(lifecycle);
      const committed = await this.#store.commit({
        expectedRevision: revision,
        runWrites: [{ record: draft, expectedRevision: run.revision }],
      });
      return { revision: committed.state.revision };
    });
  }

  async #verify(runId: string): Promise<void> {
    const run = await this.#store.getRun(runId);
    if (run.lifecycle.phase !== "verifying") return;
    const verification = await this.#program.verifyRun(run);
    if (!verification.ok) {
      await this.#recordRunBlocker(runId, verification.reason ?? "Verification failed");
      return;
    }
    await this.#preparePromotion(runId, false, verification);
  }

  async #preparePromotion(
    runId: string,
    fromFailedPublish: boolean,
    verification?: VerificationCompilation,
  ): Promise<void> {
    const run = await this.#store.getRun(runId);
    const prepared = await this.#withGit(runId, () => this.#git.prepareTargetPromotion(run.git, {
      subject: `Merge Koni run ${run.id}`,
    }));
    await this.#persistGitLifecycle(runId, prepared.lifecycle);
    if (prepared.preparation.status === "ready") {
      await this.#server.mutateInternal(async ({ revision }) => {
        const current = await this.#store.getRun(runId);
        if (!fromFailedPublish && current.lifecycle.phase !== "verifying") {
          return this.#noOpInternal(revision);
        }
        const draft = nextRun(current, this.#timestamp());
        draft.activity.push(...structuredClone(verification?.activity ?? []));
        appendReportPublication(draft, verification?.report);
        if (!fromFailedPublish) {
          applyLifecycle(draft, { type: "verification_passed", atMs: this.#now().getTime() });
        }
        const committed = await this.#store.commit({
          expectedRevision: revision,
          runWrites: [{ record: draft, expectedRevision: current.revision }],
          ...(verification?.artifactWrites === undefined ? {} : { writes: verification.artifactWrites }),
        });
        return {
          revision: committed.state.revision,
          events: [{ topic: "run.merge.ready", payload: { runId, targetRef: draft.git.target.ref } }],
        };
      });
      if (fromFailedPublish) {
        const refreshed = await this.#store.getRun(runId);
        if (refreshed.lifecycle.phase === "merging") await this.#settleMerge(runId, 1);
      }
      return;
    }
    const ticket = await this.#program.createIntegrationTicket({
      run,
      conflictReport: prepared.preparation.conflict.message,
      targetOid: prepared.preparation.expectedTargetOid,
    });
    await this.#server.mutateInternal(async ({ revision }) => {
      const current = await this.#store.getRun(runId);
      const draft = nextRun(current, this.#timestamp());
      draft.activity.push(...structuredClone(verification?.activity ?? []));
      appendReportPublication(draft, verification?.report);
      const preparedTicket = structuredClone(ticket);
      delete preparedTicket.gitCycleId;
      preparedTicket.worktreePath = undefined;
      preparedTicket.branch = undefined;
      draft.tickets[ticket.id] = preparedTicket;
      applyLifecycle(draft, {
        type: "integration_required",
        atMs: this.#now().getTime(),
        reason: "Target branch changed and requires conflict integration",
      });
      const committed = await this.#store.commit({
        expectedRevision: revision,
        runWrites: [{ record: draft, expectedRevision: current.revision }],
        ...(verification?.artifactWrites === undefined ? {} : { writes: verification.artifactWrites }),
      });
      return {
        revision: committed.state.revision,
        events: [{ topic: "run.integration.required", payload: { runId, ticketId: ticket.id } }],
      };
    });
    await this.#tick(runId);
  }

  async #recoverInFlight(runId: string): Promise<void> {
    const run = await this.#store.getRun(runId);
    const stale = Object.values(run.attempts).filter((attempt) =>
      attempt.status === "queued" || attempt.status === "running" || attempt.status === "waiting_question" ||
      attempt.status === "terminal_accepted"
    );
    if (stale.length === 0) return;
    if (this.#program.recoverAttempt === undefined) {
      await this.#interruptUnrecoverableAttempts(runId, "Runtime does not support authenticated Pi session recovery");
      return;
    }
    for (const attempt of stale) {
      if (attempt.status === "waiting_question") continue;
      try {
        const bytes = await this.#store.readArtifact(
          `runs/${run.id}/attempts/${attempt.id}/launch-spec.json`,
          16 * 1024 * 1024,
        );
        const parsed: unknown = JSON.parse(bytes.toString("utf8"));
        const spec = validateAgentLaunchSpec(parsed as AgentLaunchSpec);
        if (spec.specHash !== attempt.launchSpecHash) {
          throw new AuthorityRpcError("recovery_spec", "stored launch spec does not match attempt record");
        }
        const current = await this.#store.getRun(runId);
        const currentAttempt = current.attempts[attempt.id];
        if (currentAttempt === undefined || isTerminalAttempt(currentAttempt.status)) continue;
        const prepared = await this.#program.recoverAttempt({ run: current, attempt: currentAttempt, spec });
        assertPreparedIdentity(
          prepared,
          runId,
          attempt.id,
          attempt.sessionId,
          assignmentForAttempt(current, currentAttempt),
        );
        assertRecoveredAuthorityPlan(prepared, spec, this.#projectRoot, this.#stateRoot);
        const handle = await this.#launchPreparedSession(prepared, "recover");
        await this.#markAttemptRunning(runId, attempt.id, handle);
        this.#attachOutcome(runId, attempt.id, assignmentForAttempt(current, currentAttempt), handle);
        await this.#activatePreparedSession(handle);
      } catch (error) {
        await this.#failLaunch(
          runId,
          attempt.id,
          assignmentForAttempt(run, attempt),
          `Authenticated session recovery failed: ${errorMessage(error)}`,
        );
      }
    }
  }

  async #interruptUnrecoverableAttempts(runId: string, reason: string): Promise<void> {
    await this.#server.mutateInternal(async ({ revision }) => {
      const current = await this.#store.getRun(runId);
      const draft = nextRun(current, this.#timestamp());
      interruptRunningAttempts(draft, reason, draft.updatedAt);
      const committed = await this.#store.commit({
        expectedRevision: revision,
        runWrites: [{ record: draft, expectedRevision: current.revision }],
      });
      return { revision: committed.state.revision };
    });
  }

  async #recordSupervisorEvent(
    envelope: SupervisorEvent | PiAttemptProcessSupervisorEvent,
  ): Promise<void> {
    if (envelope.event.type === "outcome") return;
    if (envelope.event.type !== "usage") return;
    const usage = envelope.event.usage;
    await this.#server.mutateInternal(async ({ revision }) => {
      const run = await this.#store.getRun(envelope.runId);
      const attempt = run.attempts[envelope.attemptId];
      if (attempt === undefined || isTerminalAttempt(attempt.status)) return this.#noOpInternal(revision);
      const draft = nextRun(run, this.#timestamp());
      applyUsage(draft.attempts[envelope.attemptId]!, usage);
      const committed = await this.#store.commit({
        expectedRevision: revision,
        runWrites: [{ record: draft, expectedRevision: run.revision }],
      });
      return {
        revision: committed.state.revision,
        events: [{ topic: "agent.usage", payload: { runId: envelope.runId, attemptId: envelope.attemptId } }],
      };
    });
  }

  async #recordRunBlocker(runId: string, reason: string): Promise<void> {
    await this.#server.mutateInternal(async ({ revision }) => {
      const run = await this.#store.getRun(runId);
      if (run.lifecycle.phase === "blocked" || run.lifecycle.phase === "deleted") return this.#noOpInternal(revision);
      const draft = nextRun(run, this.#timestamp());
      if (new Set([
        "draft",
        "planning",
        "awaiting_approval",
        "approving",
        "executing",
        "verifying",
        "merge_ready",
        "merging",
      ]).has(draft.lifecycle.phase)) {
        applyLifecycle(draft, { type: "blocked", atMs: this.#now().getTime(), reason });
      } else {
        draft.lifecycle.blocker = reason;
      }
      draft.activity.push(activity(
        this.#createId("activity"),
        draft.updatedAt,
        "compiler",
        reason,
      ));
      const committed = await this.#store.commit({
        expectedRevision: revision,
        runWrites: [{ record: draft, expectedRevision: run.revision }],
      });
      return {
        revision: committed.state.revision,
        events: [{ topic: "run.blocked", payload: { runId, reason } }],
      };
    });
  }

  #noOpInternal(revision: number): AuthorityMethodResult {
    // Internal callers only invoke this while a concurrent terminal event may have won the race.
    return { revision };
  }

  async #withGit<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.#gitTails.get(runId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = prior.then(() => gate, () => gate);
    this.#gitTails.set(runId, tail);
    await prior.catch(() => undefined);
    try {
      await this.#assertRuntimeCurrent();
      return await operation();
    } finally {
      release();
      if (this.#gitTails.get(runId) === tail) this.#gitTails.delete(runId);
    }
  }

  async #assertRuntimeCurrent(): Promise<void> {
    if (this.#runtimeGuard !== undefined) await this.#runtimeGuard();
  }

  #gitReceiptRuntimeIdentity(): Partial<Pick<
    RunGitReceiptRecord,
    "runtimeClosureSha256" | "gitExecutableSha256"
  >> {
    return {
      ...(this.#runtimeClosureSha256 === undefined
        ? {}
        : { runtimeClosureSha256: this.#runtimeClosureSha256 }),
      ...(this.#gitExecutableSha256 === undefined
        ? {}
        : { gitExecutableSha256: this.#gitExecutableSha256 }),
    };
  }

  #background(task: () => Promise<unknown>, runId?: string): void {
    const pending = Promise.resolve().then(task).catch(async (error) => {
      if (runId !== undefined) {
        try {
          await this.#recordRunBlocker(runId, errorMessage(error));
        } catch {
          // The durable two-phase intent remains recoverable even if recording its diagnostic races.
        }
      }
    });
    this.#trackBackground(pending);
  }

  #trackBackground(pending: Promise<unknown>): void {
    this.#backgroundTasks.add(pending);
    void pending.finally(() => this.#backgroundTasks.delete(pending)).catch(() => undefined);
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }
}

function receiptFor(request: RpcRequest, result: JsonValue) {
  return {
    method: request.method,
    idempotencyKey: request.idempotencyKey!,
    requestHash: authorityRequestHash(request.method, request.params),
    result,
  };
}

function requireIdempotency(request: RpcRequest): void {
  if (request.idempotencyKey === undefined) {
    throw new AuthorityRpcError("idempotency_required", "mutating Koni methods require an idempotency key");
  }
}

function requiredObject(value: JsonValue | undefined): Record<string, JsonValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AuthorityRpcError("params", "request params must be an object");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: JsonValue | undefined, key: string): string {
  const object = requiredObject(value);
  const field = object[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new AuthorityRpcError("params", `${key} must be a nonempty string`);
  }
  return field;
}

function optionalString(value: JsonValue | undefined, key: string): string | undefined {
  const object = requiredObject(value);
  const field = object[key];
  if (field === undefined || field === null) return undefined;
  if (typeof field !== "string") throw new AuthorityRpcError("params", `${key} must be a string`);
  return field;
}

function optionalPositiveInt(value: JsonValue | undefined, key: string, fallback: number): number {
  if (value === undefined) return fallback;
  const object = requiredObject(value);
  const field = object[key];
  if (field === undefined) return fallback;
  if (!Number.isSafeInteger(field) || typeof field !== "number" || field < 1) {
    throw new AuthorityRpcError("params", `${key} must be a positive integer`);
  }
  return field;
}

function stringRecord(value: JsonValue, label: string): Record<string, string> {
  const object = requiredObject(value);
  const output: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, field] of Object.entries(object)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(key) || typeof field !== "string") {
      throw new AuthorityRpcError("params", `${label} must map safe keys to strings`);
    }
    output[key] = field;
  }
  return output;
}

function boundedText(value: string, label: string, maximum: number): string {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes === 0 || bytes > maximum || value.includes("\u0000")) {
    throw new AuthorityRpcError("params", `${label} is empty, oversized, or contains NUL`);
  }
  return value;
}

function validateQuestionOptions(options: RunQuestionRecord["options"]): RunQuestionRecord["options"] {
  if (!Array.isArray(options) || options.length < 2 || options.length > 8) {
    throw new AuthorityRpcError("question_options", "a question requires two to eight options");
  }
  const ids = new Set<string>();
  return options.map((option) => {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(option.id) ||
      ids.has(option.id)
    ) throw new AuthorityRpcError("question_options", "question option ids must be unique and safe");
    ids.add(option.id);
    return {
      id: option.id,
      label: boundedText(option.label, "option label", 16 * 1024),
      description: boundedText(option.description, "option description", 64 * 1024),
    };
  });
}

function nextRun(run: RunRecord, updatedAt: string): RunRecord {
  const draft = structuredClone(run);
  draft.revision = run.revision + 1;
  draft.updatedAt = updatedAt;
  return draft;
}

function applyLifecycle(run: RunRecord, event: RunLifecycleEvent): void {
  run.lifecycle = reduceRunLifecycle(run.lifecycle, event).state;
  run.generation = run.lifecycle.generation;
}

function restoreLegacyLifecycle(run: RunRecord, at: string): void {
  const prior = run.legacyGitMigration?.relocation?.priorPhase;
  if (prior === undefined) throw new Error("legacy relocation settlement lost its prior lifecycle phase");
  if (prior === "completed" || prior === "failed" || prior === "deleting" || prior === "deleted") {
    throw new Error(`legacy relocation cannot resume terminal lifecycle phase ${prior}`);
  }
  if (prior === "blocked") {
    run.lifecycle.blocker = "Legacy workspace relocated; the run remains in its prior blocked state";
    run.lifecycle.runningIntent = false;
    run.lifecycle.activeSinceMs = undefined;
    return;
  }
  const atMs = Date.parse(at);
  if (!Number.isFinite(atMs)) throw new Error("legacy relocation settlement timestamp is invalid");
  if (prior === "paused" || prior === "pausing") {
    const resumePhase = run.lifecycle.resumePhase ?? "executing";
    applyLifecycle(run, { type: "retry_requested", atMs, phase: resumePhase });
    applyLifecycle(run, { type: "pause_requested", atMs });
    applyLifecycle(run, { type: "pause_settled", atMs });
    return;
  }
  applyLifecycle(run, {
    type: "retry_requested",
    atMs,
    phase: prior as ResumableRunPhase,
  });
}

function activity(
  id: string,
  at: string,
  kind: RunActivityRecord["kind"],
  message: string,
): RunActivityRecord {
  return { id, at, kind, message, ticketId: undefined, nodeId: undefined };
}

function gitActivityMessage(kind: GitLifecycleIntent["kind"]): string {
  const labels: Record<GitLifecycleIntent["kind"], string> = {
    planning_create: "Prepared planning checkout",
    run_materialize: "Prepared isolated run workspace",
    ticket_materialize: "Prepared ticket worktree",
    ticket_checkpoint: "Checkpointed ticket candidate",
    ticket_publish: "Integrated ticket candidate",
    target_publish: "Published run to target branch",
    forward_compensation: "Recorded forward Git compensation",
    ticket_retire: "Retired ticket worktree",
    run_retire: "Retired run workspace",
    abandoned_run_retire: "Retired abandoned Koni workspaces",
    legacy_run_relocate: "Relocated legacy run workspace",
    legacy_run_retire: "Retired legacy run workspace",
  };
  return labels[kind];
}

function canonicalJsonHash(value: unknown): Sha256Digest {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Git authority value is not JSON serializable");
  return canonicalHash(JSON.parse(encoded) as JsonValue);
}

function ticketGitScope(ticket: TicketRecord): GitPathScope {
  const allowed: GitPathScope["allowed"] = [...new Set(ticket.writePaths)]
    .sort()
    .map((configured) => configured === "."
      ? { kind: "glob" as const, pattern: "**" }
      : { kind: "prefix" as const, path: configured.replace(/^\.\//u, "").replace(/\/$/u, "") });
  return { allowed };
}

function retainTicketAuthorityFields(
  previous: Readonly<Record<string, TicketRecord>>,
  compiled: Record<string, TicketRecord>,
): Record<string, TicketRecord> {
  for (const [ticketId, ticket] of Object.entries(compiled)) {
    const prior = previous[ticketId];
    if (prior === undefined) continue;
    if (prior.gitCycleId === undefined) delete ticket.gitCycleId;
    else ticket.gitCycleId = prior.gitCycleId;
    ticket.worktreePath = prior.worktreePath;
    ticket.branch = prior.branch;
    if (prior.integrationForTicketId === undefined) delete ticket.integrationForTicketId;
    else ticket.integrationForTicketId = prior.integrationForTicketId;
  }
  return compiled;
}

function appendReportPublication(run: RunRecord, report: RunReportRecord | undefined): void {
  if (report === undefined) return;
  run.reports ??= [];
  const existing = run.reports.find((candidate) => candidate.reportId === report.reportId);
  if (existing !== undefined) {
    if (canonicalJsonHash(reportPublicationMaterial(existing)) !== canonicalJsonHash(reportPublicationMaterial(report))) {
      throw new AuthorityRpcError("report_identity", "report publication identity collided with different content");
    }
    return;
  }
  run.reports.push(structuredClone(report));
}

function reportPublicationMaterial(report: RunReportRecord): Omit<RunReportRecord, "compiledAt"> {
  const { compiledAt: _compiledAt, ...material } = report;
  return material;
}

function hasLiveAttempt(run: RunRecord, kind: AgentAttemptRecord["kind"]): boolean {
  return Object.values(run.attempts).some((attempt) =>
    attempt.kind === kind && new Set(["queued", "running", "waiting_question", "terminal_accepted"]).has(attempt.status)
  );
}

function latestAttempt(run: RunRecord, kind: AgentAttemptRecord["kind"]): AgentAttemptRecord | undefined {
  return Object.values(run.attempts)
    .filter((attempt) => attempt.kind === kind)
    .sort((left, right) => (right.startedAt ?? "").localeCompare(left.startedAt ?? "") || right.id.localeCompare(left.id))[0];
}

function interruptRunningAttempts(run: RunRecord, reason: string, at: string): void {
  for (const attempt of Object.values(run.attempts)) {
    if (!new Set(["queued", "running", "waiting_question"]).has(attempt.status)) continue;
    attempt.status = "interrupted";
    attempt.error = reason;
    attempt.endedAt = at;
    attempt.terminalSummary = reason;
    const ticket = run.tickets[attempt.ticketId];
    const step = ticket?.steps.find((candidate) => candidate.id === attempt.stepId);
    if (step?.status === "running") {
      step.status = "pending";
      step.startedAt = undefined;
      step.completedAt = undefined;
      ticket!.status = "ready";
      ticket!.blocker = undefined;
      ticket!.updatedAt = at;
    }
  }
}

function interruptAttemptForContinuation(
  run: RunRecord,
  attempt: AgentAttemptRecord,
  at: string,
): void {
  attempt.status = "interrupted";
  attempt.error = "Question was answered after the original Pi session disconnected";
  attempt.endedAt = at;
  attempt.terminalSummary = "Continued in a fresh answer-linked attempt";
  const ticket = run.tickets[attempt.ticketId];
  const step = ticket?.steps.find((candidate) => candidate.id === attempt.stepId);
  if (ticket !== undefined && step?.status === "running") {
    step.status = "pending";
    step.startedAt = undefined;
    step.completedAt = undefined;
    ticket.status = "ready";
    ticket.blocker = undefined;
    ticket.updatedAt = at;
  }
}

function resetAssignmentAfterInterruption(
  run: RunRecord,
  assignment: ReadyAssignment,
  at: string,
): void {
  const ticket = run.tickets[assignment.ticketId];
  const step = ticket?.steps.find((candidate) => candidate.id === assignment.stepId);
  if (step === undefined || ticket === undefined) return;
  if (step.status === "running") {
    step.status = "pending";
    step.startedAt = undefined;
    step.completedAt = undefined;
    ticket.status = "ready";
    ticket.blocker = undefined;
    ticket.updatedAt = at;
  }
}

function finishAttemptRecord(
  attempt: AgentAttemptRecord,
  outcome: Extract<ManagedSessionOutcome, { status: "completed" }>,
  at: string,
  summary: string,
): void {
  attempt.status = "completed";
  attempt.endedAt = at;
  attempt.terminalSummary = summary;
  applyUsage(attempt, outcome.usage);
}

function applyUsage(
  attempt: AgentAttemptRecord,
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number },
): void {
  attempt.inputTokens = usage.input;
  attempt.outputTokens = usage.output;
  attempt.cacheReadTokens = usage.cacheRead;
  attempt.cacheWriteTokens = usage.cacheWrite;
}

function isTerminalAttempt(status: AgentAttemptRecord["status"]): boolean {
  return new Set(["completed", "failed", "aborted", "interrupted"]).has(status);
}

function assertPreparedIdentity(
  prepared: PreparedManagedAttempt,
  runId: string,
  attemptId: string,
  sessionId: string,
  assignment: ReadyAssignment | undefined,
): void {
  const identity = prepared.spec.identity;
  if (
    identity.runId !== runId ||
    identity.attemptId !== attemptId ||
    identity.sessionId !== sessionId ||
    (assignment !== undefined && (
      identity.ticketId !== assignment.ticketId || identity.stepId !== assignment.stepId
    ))
  ) throw new AuthorityRpcError("launch_identity", "compiler returned a launch spec for another assignment");
}

function firstPlanningStage(run: RunRecord): string | undefined {
  return run.pipelineStageIds.find((id) => id.includes("plan")) ?? run.pipelineStageIds[0];
}

function approvalStage(run: RunRecord): string | undefined {
  return run.pipelineStageIds.find((id) => id.includes("approval")) ?? run.currentPipelineStageId;
}

function orchestrationStage(run: RunRecord): string | undefined {
  return run.pipelineStageIds.find((id) => id.includes("orchestrat")) ?? run.currentPipelineStageId;
}

function verificationStage(run: RunRecord): string | undefined {
  return run.pipelineStageIds.find((id) => id.includes("verification")) ?? run.currentPipelineStageId;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
}

function errorDetails(error: unknown): JsonValue | undefined {
  if (typeof error !== "object" || error === null || !("diagnostics" in error)) return undefined;
  const diagnostics = (error as { diagnostics?: unknown }).diagnostics;
  return Array.isArray(diagnostics) && diagnostics.every((item) => typeof item === "string")
    ? { diagnostics }
    : undefined;
}

function defaultId(kind: "run" | "attempt" | "session" | "question" | "activity"): string {
  return `${kind}-${randomUUID()}`;
}

export function runStateHash(run: RunRecord): Sha256Digest {
  return canonicalHash(run);
}

export function authorityRevisionStateHash(projectRoot: string, revision: number): Sha256Digest {
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("authority revision is invalid");
  return canonicalHash({ protocol: "koni.authority-state-anchor.v1", projectRoot, revision });
}

function resolvePreparedTools(
  prepared: PreparedManagedAttempt,
  invoke: (call: KoniToolInvocation) => Promise<KoniToolReceipt>,
  reject: (
    call: KoniToolInvocation,
    rejection: KoniRuntimeToolRejection,
  ) => Promise<KoniRejectedToolReceipt>,
): readonly AuthorityBackedTool[] {
  if (prepared.tools !== undefined) return prepared.tools;
  if (
    prepared.authorityGrant === undefined ||
    prepared.toolNames === undefined ||
    prepared.terminalOutputSchema === undefined
  ) {
    throw new AuthorityRpcError("tool_authority", "production attempt has no compiler-issued tool authority plan");
  }
  return createKoniAuthorityTools({
    names: prepared.toolNames,
    terminalOutputSchema: prepared.terminalOutputSchema,
    schemaHashes: Object.fromEntries(prepared.spec.tools.map((tool) => [tool.name, tool.schemaHash])),
    invoke,
    reject,
  });
}

function assertPreparedAuthorityPlan(
  prepared: PreparedManagedAttempt,
  nextRevision: number,
  projectRoot: string,
  stateRoot: string,
): void {
  if (prepared.tools !== undefined) return;
  const grant = prepared.authorityGrant;
  if (
    grant === undefined ||
    prepared.toolNames === undefined ||
    prepared.terminalOutputSchema === undefined ||
    prepared.contextContent === undefined ||
    prepared.compactionSnapshot === undefined
  ) {
    throw new AuthorityRpcError("launch_authority", "compiler returned an incomplete production authority plan");
  }
  const spec = prepared.spec;
  if (
    grant.protocol !== "koni.authority-grant.v1" ||
    canonicalHash(grant) !== spec.authority.grantHash ||
    grant.grantId !== spec.authority.grantId ||
    grant.runId !== spec.identity.runId ||
    grant.ticketId !== spec.identity.ticketId ||
    grant.stepId !== spec.identity.stepId ||
    grant.attemptId !== spec.identity.attemptId ||
    grant.sessionId !== spec.identity.sessionId ||
    grant.generation !== spec.authority.generation ||
    grant.epoch !== spec.authority.epoch ||
    grant.expectedRevision !== nextRevision ||
    spec.authority.expectedRevision !== nextRevision ||
    grant.expectedStateHash !== authorityRevisionStateHash(projectRoot, nextRevision) ||
    spec.authority.expectedStateHash !== grant.expectedStateHash
  ) {
    throw new AuthorityRpcError("launch_authority", "grant does not match immutable launch authority bytes");
  }
  if (prepared.factory === undefined) assertProductionSessionDirectory(spec, stateRoot);
  const grantedTools = [...grant.allowedTools];
  const namedTools = [...prepared.toolNames];
  const specTools = spec.tools.map((tool) => tool.name);
  if (
    new Set(grantedTools).size !== grantedTools.length ||
    JSON.stringify(grantedTools) !== JSON.stringify(namedTools) ||
    JSON.stringify(namedTools) !== JSON.stringify(specTools)
  ) {
    throw new AuthorityRpcError("launch_tools", "grant, tool plan, and launch inventory differ");
  }
  if (
    rawSha256(prepared.contextContent) !== spec.authority.authoritativeContextHash ||
    canonicalHash(prepared.terminalOutputSchema) !== spec.terminal.outputSchemaHash
  ) {
    throw new AuthorityRpcError("launch_hash", "launch context or terminal schema hash differs");
  }
}

function assertRecoveredAuthorityPlan(
  prepared: PreparedManagedAttempt,
  storedSpec: Readonly<AgentLaunchSpec>,
  projectRoot: string,
  stateRoot: string,
): void {
  if (prepared.spec.specHash !== storedSpec.specHash) {
    throw new AuthorityRpcError("recovery_spec", "recovery changed immutable launch spec bytes");
  }
  if (prepared.tools !== undefined) return;
  const grant = prepared.authorityGrant;
  if (
    grant === undefined ||
    prepared.toolNames === undefined ||
    prepared.terminalOutputSchema === undefined ||
    prepared.contextContent === undefined ||
    prepared.compactionSnapshot === undefined ||
    canonicalHash(grant) !== storedSpec.authority.grantHash ||
    grant.expectedRevision !== storedSpec.authority.expectedRevision ||
    grant.expectedStateHash !== storedSpec.authority.expectedStateHash ||
    grant.expectedStateHash !== authorityRevisionStateHash(projectRoot, grant.expectedRevision) ||
    rawSha256(prepared.contextContent) !== storedSpec.authority.authoritativeContextHash ||
    canonicalHash(prepared.terminalOutputSchema) !== storedSpec.terminal.outputSchemaHash ||
    JSON.stringify(prepared.toolNames) !== JSON.stringify(storedSpec.tools.map((tool) => tool.name))
  ) {
    throw new AuthorityRpcError("recovery_authority", "recovered authority plan differs from stored launch spec");
  }
  if (prepared.factory === undefined) assertProductionSessionDirectory(storedSpec, stateRoot);
}

function assertProductionSessionDirectory(
  spec: Readonly<AgentLaunchSpec>,
  stateRoot: string,
): void {
  const expected = path.join(
    stateRoot,
    "runs",
    spec.identity.runId,
    "sessions",
    spec.identity.attemptId,
  );
  if (path.resolve(spec.workspace.sessionDirectory) !== path.resolve(expected)) {
    throw new AuthorityRpcError(
      "launch_session_path",
      "production Pi session directory is outside its authority-owned attempt path",
    );
  }
}

function validateAgentToolGrant(
  run: RunRecord,
  spec: AgentLaunchSpec,
  grant: AuthorityGrant,
  call: KoniToolInvocation,
  authorityRevision: number,
  projectRoot: string,
): AgentAttemptRecord {
  const attempt = run.attempts[spec.identity.attemptId];
  if (
    canonicalHash(grant) !== spec.authority.grantHash ||
    attempt === undefined ||
    attempt.launchSpecHash !== spec.specHash ||
    grant.runId !== run.id ||
    grant.attemptId !== attempt.id ||
    grant.sessionId !== attempt.sessionId ||
    grant.ticketId !== attempt.ticketId ||
    grant.stepId !== attempt.stepId ||
    grant.generation !== run.generation ||
    grant.generation !== spec.authority.generation ||
    grant.epoch !== spec.authority.epoch
  ) {
    throw new AuthorityRpcError("tool_identity", "tool call does not match its active immutable grant");
  }
  if (attempt.status !== "running" || !new Set(["planning", "executing", "verifying"]).has(run.lifecycle.phase)) {
    throw new AuthorityRpcError("attempt_inactive", "tool attempt is not active in a provider-capable run phase");
  }
  if (!grant.allowedTools.includes(call.name)) {
    throw new AuthorityRpcError("tool_scope", `${call.name} is outside the compiler-issued grant`);
  }
  if (
    grant.expectedRevision > authorityRevision ||
    grant.expectedStateHash !== authorityRevisionStateHash(projectRoot, grant.expectedRevision)
  ) {
    throw new AuthorityRpcError("tool_state", "tool grant is stale or has an invalid authority anchor");
  }
  if (grant.revokedAtMs !== undefined || (grant.expiresAtMs !== undefined && Date.now() >= grant.expiresAtMs)) {
    throw new AuthorityRpcError("tool_revoked", "tool grant is revoked or expired");
  }
  return attempt;
}

function enforceRepositoryCallBudget(
  spec: AgentLaunchSpec,
  attempt: AgentAttemptRecord,
  call: KoniToolInvocation,
): void {
  const limit = spec.budgets.repositoryCalls?.max;
  if (limit === undefined || !REPOSITORY_DISCOVERY_TOOLS.has(call.name)) return;
  const used = (attempt.authorityToolResults ?? []).filter((result) =>
    result.outcome === "accepted" && REPOSITORY_DISCOVERY_TOOLS.has(result.toolName as KoniToolName)
  ).length;
  if (used >= limit) {
    throw new AuthorityRpcError(
      "repository_call_budget",
      `planning repository-call budget exhausted (${used}/${limit})`,
      { details: { limit, used } },
    );
  }
}

function assertSameLaunchSpec(expected: AgentLaunchSpec, actual: Readonly<AgentLaunchSpec>): void {
  if (expected.specHash !== actual.specHash || expected.identity.attemptId !== actual.identity.attemptId) {
    throw new AuthorityRpcError("launch_identity", "context request uses a different launch specification");
  }
}

function assertLiveAttempt(run: RunRecord, spec: AgentLaunchSpec): AgentAttemptRecord {
  const attempt = run.attempts[spec.identity.attemptId];
  if (
    attempt === undefined ||
    attempt.launchSpecHash !== spec.specHash ||
    !new Set(["queued", "running", "waiting_question"]).has(attempt.status) ||
    new Set(["pausing", "paused", "deleting", "deleted", "failed", "completed"]).has(run.lifecycle.phase)
  ) {
    throw new AuthorityRpcError("attempt_inactive", "attempt no longer owns authoritative context");
  }
  return attempt;
}

function assignmentForAttempt(
  run: RunRecord,
  attempt: AgentAttemptRecord,
): ReadyAssignment | undefined {
  if (attempt.kind === "planning") return undefined;
  const ticket = run.tickets[attempt.ticketId];
  const step = ticket?.steps.find((candidate) => candidate.id === attempt.stepId);
  if (ticket === undefined || step === undefined) return undefined;
  return {
    runId: run.id,
    ticketId: ticket.id,
    stepId: step.id,
    personaId: step.personaId,
    priority: ticket.priority,
  };
}

function toolReceiptPath(runId: string, attemptId: string, callId: string): string {
  return `runs/${runId}/attempts/${attemptId}/tool-receipts/${rawSha256(callId).slice(7)}.json`;
}

function authorityMessagePath(
  runId: string,
  attemptId: string,
  sequence: number,
  digest: Sha256Digest,
): string {
  return `runs/${runId}/attempts/${attemptId}/authority-messages/${String(sequence).padStart(6, "0")}-${digest.slice(7)}.txt`;
}

function terminalOutputPath(runId: string, attemptId: string): string {
  return `runs/${runId}/attempts/${attemptId}/terminal-output.json`;
}

function configuredCheckIntentId(grant: AuthorityGrant, callId: string): string {
  return `check-${rawSha256(`${grant.grantId}\0${grant.epoch}\0${grant.generation}\0${callId}`).slice(7, 39)}`;
}

function configuredCheckStreamPath(
  runId: string,
  attemptId: string,
  callId: string,
  index: number,
  stream: "stdout" | "stderr",
): string {
  return `runs/${runId}/attempts/${attemptId}/checks/${rawSha256(callId).slice(7)}/${String(index).padStart(4, "0")}-${stream}.bin`;
}

function configuredCheckEvidencePath(runId: string, attemptId: string, callId: string): string {
  return `runs/${runId}/attempts/${attemptId}/checks/${rawSha256(callId).slice(7)}/evidence.json`;
}

function assertResolvedAgentCheck(
  check: ResolvedAgentCheck,
  requestedCheckId: string,
  configured: NonNullable<AuthorityGrant["configuredChecks"]>,
): void {
  if (
    check.protocol !== "koni.resolved-agent-check.v1" ||
    check.requestedCheckId !== requestedCheckId ||
    !/^sha256:[0-9a-f]{64}$/u.test(check.definitionHash) ||
    !["command", "graph", "composite"].includes(check.kind) ||
    !Array.isArray(check.commands) ||
    check.commands.length > 256 ||
    (check.kind === "graph" && check.commands.length !== 0) ||
    (check.kind === "command" && check.commands.length !== 1) ||
    (check.kind === "composite" && check.commands.length === 0)
  ) throw new AuthorityRpcError("check_contract", "compiler returned an invalid configured check plan");
  for (const command of check.commands) {
    if (
      typeof command.checkId !== "string" || command.checkId.length === 0 ||
      !/^sha256:[0-9a-f]{64}$/u.test(command.definitionHash) ||
      !Array.isArray(command.argv) || command.argv.length === 0 ||
      !Number.isSafeInteger(command.timeoutMs) || command.timeoutMs < 1 ||
      command.timeoutMs > configured.maxTimeoutMs ||
      !["read_only", "workspace_write"].includes(command.effect) ||
      (command.networkAccess && !configured.networkAccess) ||
      !isRecord(command.resultSource) ||
      (command.resultSource.kind !== "stdout" && command.resultSource.kind !== "file") ||
      (command.resultSource.kind === "file" && command.resultSource.path.length === 0) ||
      !Array.isArray(command.inputPaths) || !Array.isArray(command.outputPaths)
    ) throw new AuthorityRpcError("check_contract", `compiler returned an invalid command for ${requestedCheckId}`);
  }
}

async function readConfiguredCheckResult(
  worktree: string,
  grant: AuthorityGrant,
  command: ResolvedAgentCheckCommand,
  stdout: Buffer,
): Promise<AgentCheckExecution["resultSource"]> {
  let bytes: Buffer;
  let sourcePath: string | undefined;
  if (command.resultSource.kind === "stdout") {
    bytes = stdout;
  } else {
    sourcePath = command.resultSource.path;
    const paths = await WorktreePathAuthority.create(worktree, {
      readPaths: grant.readPaths,
      writePaths: grant.writePaths,
    });
    if (pathWithinGrant(sourcePath, grant.writePaths)) {
      const file = await paths.inspectWritable(sourcePath);
      if (file === undefined) {
        throw new AuthorityRpcError("check_result_missing", `configured result file is missing: ${sourcePath}`);
      }
      bytes = file.bytes;
    } else {
      bytes = (await paths.read(sourcePath)).bytes;
    }
  }
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes) || text.includes("\0")) {
    throw new AuthorityRpcError("check_result_encoding", "configured check result is not exact non-NUL UTF-8");
  }
  const structured = command.resultProtocol !== undefined ||
    command.requiredResultFields.length > 0 || command.resultSchema !== undefined ||
    command.outputArtifactSelector !== undefined;
  let value: JsonValue = null;
  if (text.trim().length > 0) {
    try {
      value = JSON.parse(text) as JsonValue;
    } catch (error) {
      if (structured) {
        throw new AuthorityRpcError("check_result_json", `configured check result is not JSON: ${errorMessage(error)}`);
      }
    }
  } else if (structured) {
    throw new AuthorityRpcError("check_result_json", "configured check result is empty");
  }
  return {
    kind: command.resultSource.kind,
    ...(sourcePath === undefined ? {} : { path: sourcePath }),
    bytesSha256: rawSha256(bytes),
    sizeBytes: bytes.byteLength,
    value,
  };
}

function exactUtf8CheckStream(bytes: Buffer, label: string): string {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes) || text.includes("\0")) {
    throw new AuthorityRpcError("check_stream_encoding", `configured check ${label} is not exact non-NUL UTF-8`);
  }
  return text;
}

async function readConfiguredOutputFiles(
  worktree: string,
  grant: AuthorityGrant,
  command: ResolvedAgentCheckCommand,
  result: JsonValue,
): Promise<Array<{ path: string; sha256: Sha256Digest; sizeBytes: number }>> {
  const selector = command.outputArtifactSelector;
  if (selector === undefined) return [];
  if (!isRecord(result)) {
    throw new AuthorityRpcError("check_artifacts", "configured artifact result must be an object");
  }
  const raw = result[selector.field];
  if (!Array.isArray(raw) || raw.length > 4_096) {
    throw new AuthorityRpcError("check_artifacts", "configured artifact result is missing or oversized");
  }
  const names = raw.map((entry, index) => {
    if (selector.allowPathStrings && typeof entry === "string") return entry;
    if (isRecord(entry) && typeof entry[selector.pathField] === "string") {
      return entry[selector.pathField] as string;
    }
    throw new AuthorityRpcError("check_artifacts", `configured artifact ${index} has no valid path`);
  });
  const unique = [...new Set(names)].sort();
  const output = [];
  for (const file of unique) {
    if (!pathWithinGrant(file, grant.writePaths)) {
      throw new AuthorityRpcError("check_artifacts", `produced artifact is outside the write grant: ${file}`);
    }
    const manifest = await snapshotContainedPaths(worktree, [file]);
    const entry = manifest.entries.find((candidate) => candidate.path === file && candidate.kind === "file");
    if (entry?.sha256 === undefined || entry.sizeBytes === undefined) {
      throw new AuthorityRpcError("check_artifacts", `produced artifact is not a regular file: ${file}`);
    }
    output.push({ path: file, sha256: entry.sha256, sizeBytes: entry.sizeBytes });
  }
  return output;
}

function pathWithinGrant(value: string, roots: readonly string[]): boolean {
  if (
    value.length === 0 || value === "." || path.isAbsolute(value) || value.includes("\\") ||
    value.includes("\0") || value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) return false;
  return roots.some((root) => root === "." || value === root || value.startsWith(`${root}/`));
}

function authorizeToolResult(
  attempt: AgentAttemptRecord,
  call: KoniToolInvocation,
  receipt: KoniToolReceipt,
  artifactPath: string,
  recordedAt: string,
): void {
  const canonicalArguments = canonicalEncode(call.arguments);
  authorizeToolResultFromDigests(
    attempt,
    call.callId,
    call.name,
    rawSha256(canonicalArguments),
    Buffer.byteLength(canonicalArguments, "utf8"),
    receipt,
    artifactPath,
    recordedAt,
  );
}

function authorizeToolResultFromDigests(
  attempt: AgentAttemptRecord,
  callId: string,
  toolName: string,
  argumentsSha256: Sha256Digest,
  argumentsSizeBytes: number,
  receipt: KoniToolReceipt,
  artifactPath: string,
  recordedAt: string,
): void {
  const canonical = canonicalEncode(receipt);
  attempt.authorityToolResults ??= [];
  attempt.authorityToolResults.push({
    sequence: attempt.authorityToolResults.length + 1,
    callId,
    toolName,
    outcome: receipt.outcome,
    argumentsSha256,
    argumentsSizeBytes,
    receiptSha256: rawSha256(canonical),
    receiptSizeBytes: Buffer.byteLength(canonical, "utf8"),
    artifactPath,
    recordedAt,
  });
}

async function planWorkspaceEffect(
  paths: WorktreePathAuthority,
  call: KoniToolInvocation & { name: "koni_write_file" | "koni_edit_file" },
): Promise<{ path: string; expectedSha256: Sha256Digest | null; bytes: Buffer }> {
  const target = toolString(call.arguments, "path");
  if (call.name === "koni_write_file") {
    return {
      path: target,
      expectedSha256: call.arguments.expectedSha256 as Sha256Digest | null,
      bytes: Buffer.from(toolStringAllowEmpty(call.arguments, "content"), "utf8"),
    };
  }
  const expectedSha256 = toolString(call.arguments, "expectedSha256") as Sha256Digest;
  const current = await paths.inspectWritable(target);
  if (current === undefined || current.sha256 !== expectedSha256) {
    throw new AuthorityRpcError("write_cas", `edit target changed: ${target}`);
  }
  const text = current.bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(current.bytes)) {
    throw new AuthorityRpcError("edit_encoding", "edit target is not exact UTF-8 text");
  }
  const oldText = toolString(call.arguments, "oldText");
  const first = text.indexOf(oldText);
  if (first < 0 || text.indexOf(oldText, first + oldText.length) >= 0) {
    throw new AuthorityRpcError("edit_match", "edit text must match exactly once");
  }
  const next = text.slice(0, first) +
    toolStringAllowEmpty(call.arguments, "newText") +
    text.slice(first + oldText.length);
  return { path: target, expectedSha256, bytes: Buffer.from(next, "utf8") };
}

async function applyWorkspaceEffect(
  paths: WorktreePathAuthority,
  intent: WorkspaceEffectIntentRecord,
  bytes: Buffer,
): Promise<void> {
  if (bytes.byteLength !== intent.contentSizeBytes || rawSha256(bytes) !== intent.desiredSha256) {
    throw new AuthorityRpcError("effect_content", "workspace effect content differs from its intent");
  }
  try {
    const applied = await paths.write(intent.path, bytes, intent.expectedSha256);
    if (applied !== intent.desiredSha256) {
      throw new AuthorityRpcError("effect_hash", "workspace effect produced an unexpected file hash");
    }
  } catch (error) {
    const current = await paths.inspectWritable(intent.path);
    if (current?.sha256 === intent.desiredSha256) return;
    throw error;
  }
}

function workspaceEffectId(grant: AuthorityGrant, callId: string): string {
  return `effect-${canonicalHash({
    grantId: grant.grantId,
    epoch: grant.epoch,
    generation: grant.generation,
    callId,
  }).slice(7, 39)}`;
}

function workspaceEffectContentPath(runId: string, attemptId: string, effectId: string): string {
  return `runs/${runId}/attempts/${attemptId}/workspace-effects/${effectId}.bin`;
}

function workspaceEffectReceipt(intent: WorkspaceEffectIntentRecord): KoniToolReceipt {
  return {
    protocol: KONI_TOOL_RECEIPT_PROTOCOL,
    receiptId: canonicalHash({
      method: intent.method,
      idempotencyKey: intent.idempotencyKey,
      requestHash: intent.requestHash,
    }),
    outcome: "accepted",
    summary: `${intent.toolName === "koni_write_file" ? "Wrote" : "Edited"} ${intent.path}`,
    value: { path: intent.path, sha256: intent.desiredSha256 },
  };
}

function encodeJsonArtifact(value: unknown): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (bytes.byteLength === 0 || bytes.byteLength > 16 * 1024 * 1024 || bytes.includes(0)) {
    throw new AuthorityRpcError("artifact_size", "agent artifact is empty, oversized, or contains NUL");
  }
  return bytes;
}

function isKoniToolReceipt(value: unknown): value is KoniToolReceipt {
  try {
    validateKoniToolReceipt(value);
    return true;
  } catch {
    return false;
  }
}

function toolString(object: Record<string, unknown>, key: string): string {
  const value = object[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new AuthorityRpcError("tool_arguments", `${key} must be a nonempty string`);
  }
  return value;
}

function toolStringAllowEmpty(object: Record<string, unknown>, key: string): string {
  const value = object[key];
  if (typeof value !== "string") throw new AuthorityRpcError("tool_arguments", `${key} must be a string`);
  return value;
}

function toolInteger(object: Record<string, unknown>, key: string, fallback: number): number {
  const value = object[key];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new AuthorityRpcError("tool_arguments", `${key} must be a non-negative integer`);
  }
  return value;
}

function textPage(
  content: string,
  offsetChars: number,
  maxChars: number,
  metadata: Record<string, JsonValue>,
): JsonValue {
  const characters = Array.from(content);
  if (offsetChars > characters.length) {
    throw new AuthorityRpcError("text_offset", "text page offset exceeds content length");
  }
  const end = Math.min(characters.length, offsetChars + maxChars);
  return {
    ...metadata,
    offsetChars,
    nextOffsetChars: end,
    totalChars: characters.length,
    eof: end === characters.length,
    content: characters.slice(offsetChars, end).join(""),
  };
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}
