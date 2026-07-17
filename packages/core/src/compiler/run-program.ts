import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { constants } from "node:fs";
import { lstat, open, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import type { AuthorityGrant } from "../authority/grants.js";
import { discoverAuthorityEndpoint } from "../authority/endpoint.js";
import type { TransactionWrite } from "../authority/file-journal.js";
import type {
  ApprovedPlanCompilation,
  AgentCheckExecution,
  AgentToolCompilation,
  AssignmentCompilation,
  CompiledAgentCheckResult,
  PlanningCompilation,
  PreparedManagedAttempt,
  ResolvedAgentCheck,
  ResolvedAgentCheckCommand,
  ResolvedRunDefinition,
  RunCompilerProgram,
  RunCreationRequest,
  VerificationCompilation,
} from "../authority/run-engine.js";
import type { JsonValue } from "../authority/protocol.js";
import type {
  ControlCatalog,
  ControlRoleDefault,
  ControlStageOption,
  ControlThinkingLevel,
} from "../control-center/protocol.js";
import type {
  CompiledConfiguration,
  ConfigurationObject,
  ConfigurationValue,
} from "../contracts/configuration.js";
import type {
  CompiledRuleEvaluation,
  DerivedTicketDefinition,
  DerivedWorkflowStep,
} from "../contracts/rules.js";
import {
  GRAPH_CHANGE_NOTE_PROTOCOL,
  WORKING_SPEC_PROTOCOL,
  GraphSchema,
  GraphValidationError,
  TypedGraph,
  createGraphContextualState,
  sealGraphContextualState,
  validateGraphContextualState,
  workingSpecDigest,
  type ContextualRecordProvenance,
  type GraphChangeNoteRecord,
  type GraphContextualLink,
  type GraphContextualRecord,
  type GraphContextualState,
  type GraphDelta,
  type GraphEdge,
  type GraphNode,
  type WorkingSpecBaseline,
  type WorkingSpecVersionRecord,
} from "../graph/model.js";
import {
  DynamicGraphContextSelector,
  type DynamicGraphSelectionRequest,
  type LegacyGraphNoteRecord,
  type SelectedDynamicGraphContext,
} from "../graph/context-selector.js";
import type { KoniCompactionSnapshot } from "../pi/compaction.js";
import {
  AGENT_LAUNCH_SPEC_PROTOCOL,
  computeLaunchResourceSetHash,
  createAgentLaunchSpec,
  type AgentLaunchSpec,
  type LaunchResource,
} from "../pi/launch-spec.js";
import {
  KONI_TOOL_NAMES,
  isSupportedKoniToolSchemaHash,
  koniToolMaxResultBytes,
  koniToolSchemaHash,
  type KoniToolInvocation,
  type KoniToolName,
} from "../pi/tool-catalog.js";
import { canonicalEncode, canonicalHash, isSha256Digest, rawSha256, type Sha256Digest } from "../shared/canonical.js";
import type { CompilerDiagnostic, ValidationResult } from "../shared/diagnostics.js";
import type {
  AgentAttemptRecord,
  AttemptStatus,
  RunActivityRecord,
  RunPlanRecord,
  RunRecord,
  TicketRecord,
} from "../state/run-record.js";
import type { ReadyAssignment } from "../state/scheduler.js";
import type { VerifiedProfileBaseline } from "./profile-package.js";
import {
  pinCommunityResourceBundle,
  selectCommunityAttemptResources,
  validatePinnedCommunityResourceBundle,
  type CommunityToolAdapterDefinition,
  type PinnedCommunityResourceBundle,
  type SelectedCommunityAttemptResources,
} from "./community-resources.js";
import { projectGraphSchemaDefinition } from "./graph-schema.js";
import { GraphExpressionEvaluator } from "./expressions.js";
import { compileProjectDirectory } from "./project-directory.js";
import { resolveCompiledPersona, resolveCompiledRunType } from "./resolution.js";
import { evaluateConfiguredRules } from "./rules.js";
import { compileConfiguredReports, type PreparedReportArtifact } from "./reports.js";
import {
  RULE_AUTHORITY_EVIDENCE_PROTOCOL,
  createProductionRuleDomainAdapter,
  createRuleAuthorityEvidence,
  ruleInputGraphSha256,
  rulePredicateBindingNames,
  rulePredicateEvidenceKey,
  type RuleAuthorityEvidence,
} from "./domain-adapter.js";
import {
  discoverInstalledPiPackageReferences,
  type InstalledPiPackageReference,
} from "../profile/resource-bindings.js";

const PINNED_CONFIGURATION_PROTOCOL = "koni.pinned-run-configuration.v1" as const;
const GRAPH_ARTIFACT_PROTOCOL = "koni.run-graph.v1" as const;
const TICKET_ARTIFACT_PROTOCOL = "koni.ticket-definitions.v1" as const;
const PLAN_ARTIFACT_PROTOCOL = "koni.planning-compilation.v1" as const;
const LEGACY_GRAPH_NOTE_PROTOCOL = "koni.graph-note.v1" as const;
const SAFE_LOCAL_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PI_THINKING_LEVELS = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const PLAN_DOMAINS = ["architecture", "decisions", "risk", "verification"] as const;
const MAX_PLAN_CHARS = 24_000;
const MAX_CONTEXT_BYTES = 4 * 1024 * 1024;
const MAX_SKILL_FILE_BYTES = 1024 * 1024;
const MAX_PINNED_SKILL_BYTES = 3 * 1024 * 1024;
const MAX_SKILL_FILES = 128;
const ATTEMPT_TRANSCRIPT_MAX_BYTES = 64 * 1024 * 1024;
const MAX_GRAPH_CONTEXT_BYTES = 2 * 1024 * 1024;
const MAX_GRAPH_NOTES = 4_096;
const MAX_WORKING_SPEC_BYTES = 1024 * 1024;
const MAX_BASELINE_SPEC_BYTES = 8 * 1024 * 1024;
const MAX_RUN_GRAPH_BYTES = 64 * 1024 * 1024;

type PlanDomain = (typeof PLAN_DOMAINS)[number];

interface PinnedSkillFile {
  relativePath: string;
  content: string;
  sha256: Sha256Digest;
  sizeBytes: number;
}

interface PinnedSkill {
  id: string;
  files: Record<string, PinnedSkillFile>;
}

interface PinnedConfigurationMaterial {
  protocol: typeof PINNED_CONFIGURATION_PROTOCOL;
  runId: string;
  configuration: CompiledConfiguration;
  skills: Record<string, PinnedSkill>;
  /** Optional for compatibility with already-issued pre-community run artifacts. */
  community?: PinnedCommunityResourceBundle;
}

interface PinnedConfigurationArtifact extends PinnedConfigurationMaterial {
  artifactSha256: Sha256Digest;
}

interface GraphArtifact {
  protocol: typeof GRAPH_ARTIFACT_PROTOCOL;
  runId: string;
  /** Semantic revision; retained under its legacy field name for read compatibility. */
  revision: number;
  /** Explicit aliases are emitted by contextual-era artifacts; absent on legacy artifacts. */
  semanticRevision?: number;
  configurationSha256: Sha256Digest;
  /** Semantic graph hash only. Context records have an independent hash below. */
  graphSha256: Sha256Digest;
  semanticSha256?: Sha256Digest;
  nodes: Record<string, GraphNode>;
  /** Absent on legacy graph artifacts and synthesized read-only until the next contextual write. */
  contextual?: GraphContextualState;
  contextualRevision?: number;
  contextualSha256?: Sha256Digest;
}

interface TicketDefinitionsArtifact {
  protocol: typeof TICKET_ARTIFACT_PROTOCOL;
  runId: string;
  graphRevision: number;
  evaluation: CompiledRuleEvaluation;
}

interface PreparedAttemptArtifact {
  protocol: "koni.prepared-attempt.v1";
  specHash: Sha256Digest;
  grant: AuthorityGrant;
  contextHash: Sha256Digest;
  contextContent: string;
  terminalSchemaHash: Sha256Digest;
}

interface GraphNoteArtifact {
  protocol: typeof LEGACY_GRAPH_NOTE_PROTOCOL;
  id: string;
  runId: string;
  ticketId: string;
  stepId: string;
  attemptId: string;
  personaId: string;
  nodeId: string;
  kind: "observation" | "implementation_detail" | "rationale" | "nit" | "open_question";
  body: string;
  status: "working";
  supersedes?: string;
  graphSha256: Sha256Digest;
  nodeSha256: Sha256Digest;
  contextSha256: Sha256Digest;
  launchSpecSha256: Sha256Digest;
  recordedAt: string;
}

interface PlanningOutput {
  full: Record<PlanDomain, string>;
  concise: Record<PlanDomain, { title: string; description: string }[]>;
  graphSeed: PlanningGraphSeed;
}

interface PlanningGraphSeed {
  rootSpec: Record<string, JsonValue>;
  nodes: Array<{ key: string; type: string; title: string; spec: Record<string, JsonValue> }>;
  edges: Array<{ source: string; relation: string; target: string }>;
}

interface AssignmentOutput {
  status: "completed" | "failed";
  summary?: string;
  blocker?: string;
  graphDelta?: GraphDelta | null;
}

interface AttemptDescriptor {
  ticketId: string;
  stepId: string;
  personaId: string;
  readPaths: string[];
  writePaths: string[];
  readNodeIds: string[];
  writeNodeIds: string[];
  graphMutation: "allowed" | "forbidden" | "required";
  initialPrompt: string;
  context: Record<string, unknown>;
  terminalSchema: TSchema;
  definition?: DerivedTicketDefinition;
  step?: DerivedWorkflowStep;
  graph?: TypedGraph;
}

interface AttemptDescriptorInput {
  kind: "planning" | "ticket" | "verification" | "integration";
  run: RunRecord;
  assignment?: ReadyAssignment;
}

export interface NativeRunCompilerProgramOptions {
  projectRoot: string;
  packageBaseline: VerifiedProfileBaseline;
  /** Re-resolve the verified installed-package cache for future runs without touching pinned runs. */
  packageBaselineLoader?: () => Promise<VerifiedProfileBaseline>;
  /** Read-only Pi package inventory. Missing packages must never be installed by this callback. */
  installedPiPackagesLoader?: () => Promise<readonly InstalledPiPackageReference[]>;
  /** Koni-owned adapters only; community extension exports are never accepted here. */
  communityToolAdapters?: readonly CommunityToolAdapterDefinition[];
  now?: () => Date;
  /**
   * Supplies authenticated, snapshot-bound assertions for receipt/review/command predicates.
   * Local graph, gate-selection, and contained-filesystem predicates never consume assertions.
   */
  ruleAuthorityEvidence?: (request: NativeRuleAuthorityEvidenceRequest) =>
    Promise<RuleAuthorityEvidence | undefined>;
}

export interface NativeRuleAuthorityEvidenceRequest {
  run: Readonly<RunRecord>;
  configuration: Readonly<CompiledConfiguration>;
  inputGraphSha256: Sha256Digest;
  graphNodes: readonly Readonly<GraphNode>[];
}

export class NativeRunProgramError extends Error {
  public readonly code: string;
  public readonly details: readonly string[];

  public constructor(code: string, message: string, details: readonly string[] = []) {
    super(details.length === 0 ? message : `${message}\n${details.join("\n")}`);
    this.name = "NativeRunProgramError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Pure TypeScript implementation of the compiler-facing run program.
 *
 * It consumes only an authenticated package baseline plus the project overlay, freezes that
 * result into the run transaction, and thereafter derives every model attempt from that immutable
 * snapshot. Effects and durable recovery ownership stay in RunAuthorityEngine.
 */
export class NativeRunCompilerProgram implements RunCompilerProgram {
  readonly #projectRoot: string;
  #packageBaseline: VerifiedProfileBaseline;
  readonly #packageBaselineLoader: (() => Promise<VerifiedProfileBaseline>) | undefined;
  readonly #installedPiPackagesLoader: () => Promise<readonly InstalledPiPackageReference[]>;
  readonly #communityToolAdapters: readonly CommunityToolAdapterDefinition[];
  readonly #stateRoot: string;
  readonly #now: () => Date;
  readonly #ruleAuthorityEvidence: NativeRunCompilerProgramOptions["ruleAuthorityEvidence"];
  readonly #pinned = new Map<string, PinnedConfigurationArtifact>();
  readonly #issuedSpecs = new Map<string, Readonly<AgentLaunchSpec>>();
  readonly #dynamicContextSelector = new DynamicGraphContextSelector();

  private constructor(
    options: NativeRunCompilerProgramOptions,
    stateRoot: string,
  ) {
    this.#projectRoot = path.resolve(options.projectRoot);
    this.#packageBaseline = options.packageBaseline;
    this.#packageBaselineLoader = options.packageBaselineLoader;
    this.#installedPiPackagesLoader = options.installedPiPackagesLoader ?? (() =>
      discoverInstalledPiPackageReferences({ projectRoot: this.#projectRoot }));
    this.#communityToolAdapters = structuredClone(options.communityToolAdapters ?? []);
    this.#stateRoot = stateRoot;
    this.#now = options.now ?? (() => new Date());
    this.#ruleAuthorityEvidence = options.ruleAuthorityEvidence;
  }

  public static async create(options: NativeRunCompilerProgramOptions): Promise<NativeRunCompilerProgram> {
    const endpoint = await discoverAuthorityEndpoint(options.projectRoot);
    return new NativeRunCompilerProgram(options, endpoint.stateRoot);
  }

  public async controlCatalog(): Promise<ControlCatalog> {
    if (this.#packageBaselineLoader !== undefined) {
      this.#packageBaseline = await this.#packageBaselineLoader();
    }
    const compiled = requireValidation(
      await compileProjectDirectory(this.#projectRoot, this.#packageBaseline),
      "configuration_invalid",
      "project configuration did not compile",
    );
    const resolved = compiled.run_type_order.map((runTypeId) => requireValidation(
      resolveCompiledRunType(compiled, runTypeId),
      "run_type_invalid",
      `run type ${runTypeId} is not executable`,
    ));
    const stageOrder: string[] = [];
    const sharedStages = new Map<string, { title: string; kind: string }>();
    for (const runType of resolved) {
      const pipeline = pipelineDefinition(runType.document);
      for (const stageId of pipeline.order) {
        const stage = requiredRecord(pipeline.stages[stageId], `pipeline stage ${stageId}`);
        if (!sharedStages.has(stageId)) {
          stageOrder.push(stageId);
          sharedStages.set(stageId, {
            title: optionalString(stage.title) ?? humanize(stageId),
            kind: requiredNonempty(stage.kind, `pipeline stage ${stageId} kind`),
          });
        }
      }
    }
    const roleTitles: Record<string, string> = {
      planner: "Planner",
      lead: "Lead",
      ticket_worker: "Worker",
      reviewer: "Reviewer",
    };
    return {
      protocol: "koni.control-catalog.v1",
      runTypes: resolved.map((runType) => {
        const pipeline = pipelineDefinition(runType.document);
        const included = new Set(pipeline.order);
        const stages: ControlStageOption[] = stageOrder.map((stageId) => {
          const configured = included.has(stageId)
            ? requiredRecord(pipeline.stages[stageId], `pipeline stage ${stageId}`)
            : undefined;
          const shared = sharedStages.get(stageId)!;
          return {
            id: stageId,
            title: configured === undefined ? shared.title : optionalString(configured.title) ?? shared.title,
            kind: configured === undefined ? shared.kind : requiredNonempty(configured.kind, `pipeline stage ${stageId} kind`),
            included: configured !== undefined,
          };
        });
        const agentConfig = requiredRecord(runType.document.agents, `run type ${runType.id} agents`);
        const roleConfig = requiredRecord(agentConfig.roles, `run type ${runType.id} agent roles`);
        const roles: ControlRoleDefault[] = ["planner", "lead", "ticket_worker", "reviewer"].map((roleId) => {
          const configured = requiredRecord(roleConfig[roleId], `run type ${runType.id} role ${roleId}`);
          return {
            id: roleId,
            title: roleTitles[roleId]!,
            provider: optionalString(configured.provider) ?? "openai-codex",
            model: requiredNonempty(configured.model, `run type ${runType.id} role ${roleId} model`),
            thinkingLevel: requireThinkingLevel(
              configured.thinking_level,
              `run type ${runType.id} role ${roleId}`,
            ) as ControlThinkingLevel,
          };
        });
        return {
          id: runType.id,
          title: optionalString(runType.document.title) ?? humanize(runType.id),
          description: optionalString(runType.document.description) ?? "Configured Koni run",
          questionPolicy: configuredQuestionPolicy(runType.document),
          maxParallel: configuredMaxParallel(runType.document),
          startMode: pipeline.order.some((stageId) =>
            requiredRecord(pipeline.stages[stageId], `pipeline stage ${stageId}`).kind === "planning"
          ) ? "planning" : "work",
          stages,
          roles,
        };
      }),
    };
  }

  public async resolveRun(request: RunCreationRequest): Promise<ResolvedRunDefinition> {
    if (this.#packageBaselineLoader !== undefined) {
      this.#packageBaseline = await this.#packageBaselineLoader();
    }
    const compiled = requireValidation(
      await compileProjectDirectory(this.#projectRoot, this.#packageBaseline),
      "configuration_invalid",
      "project configuration did not compile",
    );
    const runType = requireValidation(
      resolveCompiledRunType(compiled, request.runTypeId),
      "run_type_invalid",
      `run type ${request.runTypeId} is not executable`,
    );
    const overrides = parseRunOverrides(request.overrides, compiled);
    const workingSpecOwnerId = resolveWorkingSpecOwner(compiled, runType.document, overrides.workingSpecOwner);
    const pipeline = pipelineDefinition(runType.document);
    const planningMode = pipeline.order.some((id) =>
      requiredRecord(pipeline.stages[id], `pipeline stage ${id}`).kind === "planning"
    ) ? "agent" : "direct";
    const agents: ResolvedRunDefinition["executionConfig"]["agents"] = Object.create(null) as ResolvedRunDefinition["executionConfig"]["agents"];
    for (const personaId of Object.keys(compiled.registries.personas).sort(compareText)) {
      const personaDefinition = requiredRecord(
        compiled.registries.personas[personaId],
        `persona ${personaId}`,
      );
      const roleId = optionalString(personaDefinition.model_role);
      const roleSelection = roleId === undefined ? undefined : overrides.roles[roleId];
      const personaSelection = overrides.agents[personaId];
      const selected = mergeAgentSelection(roleSelection, personaSelection);
      const persona = requireValidation(
        resolveCompiledPersona(compiled, personaId, {
          runTypeId: runType.id,
          ...(selected?.model === undefined ? {} : { model: selected.model }),
          ...(selected?.thinkingLevel === undefined ? {} : { thinkingLevel: selected.thinkingLevel }),
        }),
        "persona_invalid",
        `persona ${personaId} is not executable`,
      );
      const provider = selected?.provider ?? persona.provider ?? "openai-codex";
      const model = requiredNonempty(persona.model, `persona ${personaId} model`);
      const thinkingLevel = requireThinkingLevel(persona.thinking_level, `persona ${personaId}`);
      agents[personaId] = { provider, model, thinkingLevel };
    }
    const skills = await pinConfiguredSkills(compiled, this.#projectRoot);
    const needsCommunityInventory = compiled.pi_resource_bindings?.bindings.some(({ enabled, integration }) =>
      enabled && integration !== "interactive_only" && integration !== "not_recommended") === true;
    let installedPiPackages: readonly InstalledPiPackageReference[] = [];
    if (needsCommunityInventory) {
      try {
        installedPiPackages = await this.#installedPiPackagesLoader();
      } catch (error) {
        fail(
          "community_inventory",
          `Pi's installed-package inventory could not be read without mutation: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    let community: PinnedCommunityResourceBundle;
    try {
      community = await pinCommunityResourceBundle({
        catalog: compiled.pi_resource_bindings,
        installed: installedPiPackages,
        adapters: this.#communityToolAdapters,
      });
    } catch (error) {
      fail(
        "community_resource_unavailable",
        error instanceof Error ? error.message : String(error),
      );
    }
    const pinned = createPinnedArtifact(request.runId, compiled, skills, community);
    this.#pinned.set(request.runId, pinned);
    const bytes = encodeArtifact(pinned);
    const questionPolicy = overrides.questionPolicy ?? configuredQuestionPolicy(runType.document);
    const runInstructions = [configuredPlanningInstructions(runType.document), overrides.instructions]
      .filter((item): item is string => item !== undefined && item.trim().length > 0)
      .join("\n\n");
    return {
      profile: {
        packageName: compiled.package.name,
        packageVersion: compiled.package.version,
        lineage: compiled.package.profile_lineage,
        bundleHash: compiled.baseline_bundle_sha256,
      },
      compiledConfigHash: compiled.configuration_sha256,
      runTypeId: runType.id,
      workingSpecOwnerId,
      planningMode,
      pipelineStageIds: pipeline.order,
      executionConfig: {
        maxParallel: overrides.maxParallel ?? configuredMaxParallel(runType.document),
        questionPolicy,
        instructions: runInstructions,
        agents,
      },
      artifactWrites: [
        {
          path: pinnedConfigurationPath(request.runId),
          bytes,
          expectedSha256: null,
        },
        {
          path: graphArtifactPath(request.runId),
          bytes: encodeRunGraphArtifact(initialGraphArtifact(request.runId, compiled, workingSpecOwnerId)),
          expectedSha256: null,
        },
      ],
    };
  }

  public async initializeDirectApproval(run: RunRecord): Promise<PlanningCompilation> {
    const pinned = await this.#loadPinned(run);
    const runType = requireValidation(
      resolveCompiledRunType(pinned.configuration, run.runTypeId),
      "run_type_invalid",
      `pinned run type ${run.runTypeId} is unavailable`,
    );
    const pipeline = pipelineDefinition(runType.document);
    if (pipeline.order.some((id) =>
      requiredRecord(pipeline.stages[id], `pipeline stage ${id}`).kind === "planning"
    )) {
      fail("direct_approval_planning_stage", "a run type with a planning stage cannot use direct approval");
    }
    const graph = compileDirectInitialGraph(pinned.configuration, run);
    const plan: RunPlanRecord = {
      revision: (run.plan?.revision ?? 0) + 1,
      status: "planning",
      full: {},
      concise: {},
      graphSeed: undefined,
      steeringHistory: structuredClone(run.plan?.steeringHistory ?? []),
    };
    const compiledArtifact = {
      protocol: PLAN_ARTIFACT_PROTOCOL,
      runId: run.id,
      directApproval: true,
      plan,
      graphSha256: graph.hash,
    };
    return {
      plan,
      graphHash: graph.hash,
      graphRevision: 0,
      activity: [compilerActivity(run, "Direct-approval root graph validated", "plan")],
      artifactWrites: [
        {
          path: `runs/${run.id}/direct-approval.json`,
          bytes: encodeArtifact(compiledArtifact),
          expectedSha256: null,
        },
        {
          path: `runs/${run.id}/direct-approval-graph.json`,
          bytes: encodeRunGraphArtifact(graphArtifact(run, pinned.configuration, graph, 0)),
          expectedSha256: null,
        },
      ],
    };
  }

  public async prepareAttempt(input: {
    kind: "planning" | "ticket" | "verification" | "integration";
    run: RunRecord;
    assignment?: ReadyAssignment;
    attemptId: string;
    sessionId: string;
    nextAuthorityRevision: number;
    expectedAuthorityStateHash: Sha256Digest;
    lineage: AgentLaunchSpec["lineage"];
  }): Promise<PreparedManagedAttempt> {
    const pinned = await this.#loadPinned(input.run);
    const runType = requireValidation(
      resolveCompiledRunType(pinned.configuration, input.run.runTypeId),
      "run_type_invalid",
      `pinned run type ${input.run.runTypeId} is unavailable`,
    );
    const descriptor = await this.#attemptDescriptor(input, pinned.configuration, runType.document);
    const persona = requireValidation(
      resolveCompiledPersona(pinned.configuration, descriptor.personaId, { runTypeId: input.run.runTypeId }),
      "persona_invalid",
      `persona ${descriptor.personaId} is not executable`,
    );
    const selection = input.run.executionConfig?.agents[descriptor.personaId];
    const provider = selection?.provider ?? persona.provider ?? "openai-codex";
    const model = requiredNonempty(selection?.model ?? persona.model, `persona ${descriptor.personaId} model`);
    const thinkingLevel = requireThinkingLevel(
      selection?.thinkingLevel ?? persona.thinking_level,
      `persona ${descriptor.personaId}`,
    );
    const configuredChecks = await this.#configuredCheckGrant(
      input.run,
      pinned.configuration,
      descriptor,
      persona.capabilities,
    );
    let communitySelection: SelectedCommunityAttemptResources;
    try {
      communitySelection = selectCommunityAttemptResources({
        bundle: pinned.community,
        personaId: descriptor.personaId,
        stageIds: communityAttemptStageIds(input.kind, descriptor, pinned.configuration, runType.document),
        networkAccess: configuredChecks?.networkAccess === true,
      });
    } catch (error) {
      fail("community_attempt_unavailable", error instanceof Error ? error.message : String(error));
    }
    const resources = launchResources(
      pinned,
      persona.skills,
      input.run.executionConfig?.instructions ?? "",
      communitySelection.resources,
    );
    const toolNames = toolInventory(input.run, descriptor, resources, communitySelection.toolNames);
    const contextContent = boundedContext(descriptor.context);
    const contextHash = rawSha256(contextContent);
    const authorityGrant: AuthorityGrant = {
      protocol: "koni.authority-grant.v1",
      grantId: `grant-${input.attemptId}`,
      runId: input.run.id,
      ticketId: descriptor.ticketId,
      stepId: descriptor.stepId,
      attemptId: input.attemptId,
      sessionId: input.sessionId,
      epoch: input.run.lifecycle.revision + 1,
      generation: input.run.generation,
      allowedTools: toolNames,
      readPaths: descriptor.readPaths,
      writePaths: descriptor.writePaths,
      ...(configuredChecks === undefined ? {} : { configuredChecks }),
      expectedRevision: input.nextAuthorityRevision,
      expectedStateHash: input.expectedAuthorityStateHash,
    };
    const grantHash = canonicalHash(authorityGrant);
    const repositoryCallBudget = attemptRepositoryCallBudget(runType.document, input.kind);
    const systemPrompt = [
      persona.instructions.trim(),
      "You are executing one immutable compiler-issued Koni attempt. Use only the Koni tools present in this session. Never use ambient filesystem, shell, Git, network, extension, subagent, or lifecycle authority. The authority injects your exact bound context automatically; use koni_context only when you need an explicit refresh. Stay inside the exact semantic and path grant, and finish with exactly one koni_submit_output call matching its schema.",
      ...(repositoryCallBudget === undefined ? [] : [
        `Repository discovery is bounded to ${repositoryCallBudget} total koni_read_file, koni_list_files, and koni_search_files calls for this planning attempt. Reuse compiler context, prioritize high-value reads, and synthesize before the authority ceiling is exhausted.`,
      ]),
    ].join("\n\n");
    const tokenBudget = attemptTokenBudget(runType.document, input.kind);
    const workspace = attemptWorkspace(input.run, input.kind, descriptor.ticketId);
    const spec = createAgentLaunchSpec({
      protocol: AGENT_LAUNCH_SPEC_PROTOCOL,
      issuedAt: this.#now().toISOString(),
      identity: {
        runId: input.run.id,
        ticketId: descriptor.ticketId,
        stepId: descriptor.stepId,
        attemptId: input.attemptId,
        sessionId: input.sessionId,
      },
      lineage: structuredClone(input.lineage),
      authority: {
        grantId: authorityGrant.grantId,
        grantHash,
        generation: authorityGrant.generation,
        epoch: authorityGrant.epoch,
        expectedRevision: authorityGrant.expectedRevision,
        expectedStateHash: input.expectedAuthorityStateHash,
        authoritativeContextHash: contextHash,
      },
      workspace: {
        cwd: workspace,
        sessionDirectory: path.join(this.#stateRoot, "runs", input.run.id, "sessions", input.attemptId),
      },
      persona: {
        id: descriptor.personaId,
        systemPrompt,
        systemPromptHash: rawSha256(systemPrompt),
        initialPrompt: descriptor.initialPrompt,
        initialPromptHash: rawSha256(descriptor.initialPrompt),
      },
      model: { provider, id: model, thinkingLevel },
      tools: toolNames.map((name) => ({
        name,
        schemaHash: koniToolSchemaHash(name, descriptor.terminalSchema),
        executionMode: toolExecutionMode(name),
        maxResultBytes: koniToolMaxResultBytes(name),
      })),
      resources: {
        setHash: computeLaunchResourceSetHash(resources),
        entries: resources,
      },
      budgets: {
        tokens: tokenBudget,
        retries: { maxProviderRetries: 2, baseDelayMs: 500 },
        transcript: { maxBytes: ATTEMPT_TRANSCRIPT_MAX_BYTES },
        ...(repositoryCallBudget === undefined ? {} : {
          repositoryCalls: { max: repositoryCallBudget },
        }),
      },
      terminal: {
        toolName: "koni_submit_output",
        outputSchemaHash: koniToolSchemaHash("koni_submit_output", descriptor.terminalSchema),
        maxOutputBytes: 4 * 1024 * 1024,
      },
    });
    const snapshot = compactionSnapshot(input.run, descriptor);
    const attemptArtifact: PreparedAttemptArtifact = {
      protocol: "koni.prepared-attempt.v1",
      specHash: spec.specHash,
      grant: authorityGrant,
      contextHash,
      contextContent,
      terminalSchemaHash: spec.terminal.outputSchemaHash,
    };
    this.#issuedSpecs.set(input.attemptId, spec);
    return {
      spec: spec as AgentLaunchSpec,
      authorityGrant,
      toolNames,
      terminalOutputSchema: descriptor.terminalSchema,
      contextContent,
      compactionSnapshot: snapshot,
      artifactWrites: [{
        path: `runs/${input.run.id}/attempts/${input.attemptId}/compiler-input.json`,
        bytes: encodeArtifact(attemptArtifact),
        expectedSha256: null,
      }],
    };
  }

  public async recoverAttempt(input: {
    run: RunRecord;
    attempt: AgentAttemptRecord;
    spec: Readonly<AgentLaunchSpec>;
  }): Promise<PreparedManagedAttempt> {
    const { run, attempt, spec } = input;
    assertRecoveryIdentity(run, attempt, spec);
    const kind = recoveredAttemptKind(run, attempt);
    if (
      spec.workspace.cwd !== attemptWorkspace(run, kind, attempt.ticketId) ||
      spec.workspace.sessionDirectory !== path.join(this.#stateRoot, "runs", run.id, "sessions", attempt.id) ||
      spec.authority.generation !== run.generation
    ) fail("recovery_workspace_drift", "stored launch workspace or generation no longer matches the run");
    const pinned = await this.#loadPinned(run);
    const runType = requireValidation(
      resolveCompiledRunType(pinned.configuration, run.runTypeId),
      "run_type_invalid",
      `pinned run type ${run.runTypeId} is unavailable`,
    );
    const assignment = kind === "planning" || kind === "verification"
      ? undefined
      : assignmentFromAttempt(run, attempt);
    const descriptor = await this.#attemptDescriptor({
      kind,
      run,
      ...(assignment === undefined ? {} : { assignment }),
    }, pinned.configuration, runType.document);
    if (
      descriptor.ticketId !== spec.identity.ticketId ||
      descriptor.stepId !== spec.identity.stepId ||
      descriptor.personaId !== spec.persona.id
    ) {
      fail("recovery_assignment_drift", "stored launch identity no longer matches its pinned compiler assignment");
    }

    const persona = requireValidation(
      resolveCompiledPersona(pinned.configuration, descriptor.personaId, { runTypeId: run.runTypeId }),
      "persona_invalid",
      `persona ${descriptor.personaId} is not executable`,
    );
    const configuredChecks = await this.#configuredCheckGrant(
      run,
      pinned.configuration,
      descriptor,
      persona.capabilities,
    );
    let communitySelection: SelectedCommunityAttemptResources;
    try {
      communitySelection = selectCommunityAttemptResources({
        bundle: pinned.community,
        personaId: descriptor.personaId,
        stageIds: communityAttemptStageIds(kind, descriptor, pinned.configuration, runType.document),
        networkAccess: configuredChecks?.networkAccess === true,
      });
    } catch (error) {
      fail("recovery_community_resource", error instanceof Error ? error.message : String(error));
    }
    const expectedResources = launchResources(
      pinned,
      persona.skills,
      run.executionConfig?.instructions ?? "",
      communitySelection.resources,
    );
    if (
      computeLaunchResourceSetHash(expectedResources) !== spec.resources.setHash ||
      canonicalHash(expectedResources) !== canonicalHash(spec.resources.entries)
    ) {
      fail("recovery_resource_drift", "stored launch resources no longer match pinned compiler state");
    }
    const compiledTools = toolInventory(run, descriptor, expectedResources, communitySelection.toolNames);
    const storedTools = spec.tools.map((tool) => tool.name);
    // Contextual tools added after a launch was issued never rewrite a legacy launch inventory.
    const expectedTools = run.workingSpecOwnerId === undefined
      ? compiledTools.filter((name) =>
          (name !== "koni_record_note" && name !== "koni_update_working_spec") || storedTools.includes(name))
      : compiledTools;
    if (
      JSON.stringify(storedTools) !== JSON.stringify(expectedTools) ||
      spec.terminal.toolName !== "koni_submit_output" ||
      spec.terminal.outputSchemaHash !== canonicalHash(descriptor.terminalSchema)
    ) {
      fail("recovery_tool_drift", "stored launch tools or terminal contract no longer match pinned compiler state");
    }
    for (const tool of spec.tools) {
      const name = requireKoniToolName(tool.name);
      if (
        !isSupportedKoniToolSchemaHash(name, tool.schemaHash, descriptor.terminalSchema) ||
        tool.executionMode !== toolExecutionMode(name) ||
        tool.maxResultBytes !== koniToolMaxResultBytes(name)
      ) fail("recovery_tool_drift", `stored tool binding ${tool.name} no longer matches its compiler contract`);
    }

    const compilerInput = await this.#readPreparedAttemptArtifact(run, attempt, spec);
    if (
      rawSha256(compilerInput.contextContent) !== spec.authority.authoritativeContextHash
    ) fail("recovery_context", "stored launch spec has no valid authoritative assignment context");
    const authorityGrant: AuthorityGrant = {
      protocol: "koni.authority-grant.v1",
      grantId: spec.authority.grantId,
      runId: run.id,
      ticketId: descriptor.ticketId,
      stepId: descriptor.stepId,
      attemptId: attempt.id,
      sessionId: attempt.sessionId,
      epoch: spec.authority.epoch,
      generation: spec.authority.generation,
      allowedTools: expectedTools,
      readPaths: descriptor.readPaths,
      writePaths: descriptor.writePaths,
      ...(configuredChecks === undefined ? {} : { configuredChecks }),
      expectedRevision: spec.authority.expectedRevision,
      expectedStateHash: spec.authority.expectedStateHash,
    };
    if (canonicalHash(authorityGrant) !== spec.authority.grantHash) {
      fail("recovery_grant_drift", "stored launch authority no longer matches pinned compiler scope");
    }
    this.#issuedSpecs.set(attempt.id, spec);
    return {
      spec,
      authorityGrant,
      toolNames: expectedTools,
      terminalOutputSchema: descriptor.terminalSchema,
      contextContent: compilerInput.contextContent,
      compactionSnapshot: compactionSnapshot(run, descriptor),
      artifactWrites: [],
    };
  }

  public async selectDynamicGraphContext(input: {
    run: RunRecord;
    attempt: AgentAttemptRecord;
    spec: Readonly<AgentLaunchSpec>;
    request?: DynamicGraphSelectionRequest;
  }): Promise<SelectedDynamicGraphContext> {
    const { run, attempt, spec } = input;
    assertRecoveryIdentity(run, attempt, spec);
    const pinned = await this.#loadPinned(run);
    const descriptor = await this.#descriptorForRecordedAttempt(run, attempt, pinned.configuration);
    let graphRead: { graph: TypedGraph; artifact: GraphArtifact; bytesSha256: Sha256Digest };
    try {
      graphRead = await this.#readContextGraph(run, pinned.configuration);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // Pre-contextual pinned planning attempts legitimately predate the canonical graph shell.
      const graph = new TypedGraph(requireGraphSchema(pinned.configuration), []);
      const artifact: GraphArtifact = {
        protocol: GRAPH_ARTIFACT_PROTOCOL,
        runId: run.id,
        revision: 0,
        configurationSha256: run.compiledConfigHash,
        graphSha256: graph.hash,
        nodes: graph.toJSON(),
      };
      graphRead = { graph, artifact, bytesSha256: rawSha256(encodeArtifact(artifact)) };
    }
    const contextual = this.#contextualState(run, graphRead.artifact);
    const request = input.request;
    if (request?.anchors !== undefined) {
      const visible = new Set([...descriptor.readNodeIds, ...descriptor.writeNodeIds]);
      for (const anchor of request.anchors) {
        if (!visible.has(anchor) || graphRead.graph.node(anchor) === undefined) {
          fail("graph_context_anchor", `graph context anchor ${anchor} is outside this step's compiler-visible scope`);
        }
      }
    }
    if (request?.relations !== undefined) {
      const relations = new Set<string>();
      for (const edge of pinned.configuration.edge_types) {
        if (typeof edge.relation === "string") relations.add(edge.relation);
        if (edge.bidirectional === true && typeof edge.inverse === "string") relations.add(edge.inverse);
      }
      for (const relation of request.relations) {
        if (!relations.has(relation)) fail("graph_context_relation", `unknown configured graph relation ${relation}`);
      }
    }
    if (request?.nodeTypes !== undefined) {
      for (const type of request.nodeTypes) {
        if (pinned.configuration.registries.node_types[type] === undefined) {
          fail("graph_context_node_type", `unknown configured graph node type ${type}`);
        }
      }
    }
    const lineage = compatibleAttemptLineage(run, attempt);
    const { touchedFiles } = await this.#readAttemptReceiptContext(run, attempt);
    const nodePaths = Object.fromEntries(graphRead.graph.nodes().map((node) => [
      node.id,
      graphRead.graph.repositoryPaths(node.id),
    ]));
    const ticket = run.tickets[attempt.ticketId];
    const cacheKey = canonicalHash({
      runId: run.id,
      generation: run.generation,
      semanticRevision: graphRead.artifact.revision,
      semanticHash: graphRead.graph.hash,
      contextualRevision: contextual.revision,
      contextualHash: contextual.hash,
    });
    return this.#dynamicContextSelector.select({
      cacheKey,
      identity: {
        runId: run.id,
        ticketId: attempt.ticketId,
        stepId: attempt.stepId,
        attemptId: attempt.id,
        sessionId: attempt.sessionId,
        personaId: attempt.personaId,
        grantHash: spec.authority.grantHash,
        launchSpecHash: spec.specHash,
        generation: spec.authority.generation,
      },
      objective: run.objective,
      runUpdatedAt: run.updatedAt,
      semanticRevision: graphRead.artifact.revision,
      semanticHash: graphRead.graph.hash,
      contextual,
      graph: graphRead.graph,
      arcs: dynamicRelationArcs(pinned.configuration, graphRead.graph),
      nodePaths,
      legacyNotes: await this.#readGraphNotes(run),
      ticketTargetIds: ticket?.targetNodeIds ?? descriptor.definition?.target_node_ids ?? [],
      stepTargetIds: [...new Set([...descriptor.writeNodeIds, ...descriptor.readNodeIds])].sort(compareText),
      scopedPaths: [...new Set([...descriptor.readPaths, ...descriptor.writePaths])].sort(compareText),
      touchedPaths: touchedFiles,
      graphActivity: run.activity.map((activity) => ({
        at: activity.at,
        ...(activity.nodeId === undefined ? {} : { nodeId: activity.nodeId }),
      })),
      compatibleAttemptIds: lineage.compatible,
      abandonedAttemptIds: lineage.abandoned,
      maxInputTokens: spec.budgets.tokens.maxInput,
      ...(request === undefined ? {} : { request }),
    });
  }

  public dynamicContextCacheStats(): { selections: number; indexBuilds: number; cachedIndexes: number } {
    return this.#dynamicContextSelector.stats();
  }

  public async refreshCompactionSnapshot(input: {
    run: RunRecord;
    attempt: AgentAttemptRecord;
    spec: Readonly<AgentLaunchSpec>;
  }): Promise<KoniCompactionSnapshot> {
    const { run, attempt, spec } = input;
    assertRecoveryIdentity(run, attempt, spec);
    const pinned = await this.#loadPinned(run);
    const runType = requireValidation(
      resolveCompiledRunType(pinned.configuration, run.runTypeId),
      "run_type_invalid",
      `pinned run type ${run.runTypeId} is unavailable`,
    );
    const kind = recoveredAttemptKind(run, attempt);
    const assignment = kind === "planning" || kind === "verification"
      ? undefined
      : assignmentFromAttempt(run, attempt);
    const descriptor = await this.#attemptDescriptor({
      kind,
      run,
      ...(assignment === undefined ? {} : { assignment }),
    }, pinned.configuration, runType.document);
    const snapshot = compactionSnapshot(run, descriptor);
    const durable = await this.#readAttemptReceiptContext(run, attempt);
    const dynamic = await this.selectDynamicGraphContext({ run, attempt, spec });
    snapshot.receiptIds = durable.receiptIds;
    snapshot.touchedFiles = durable.touchedFiles;
    snapshot.graphRefs = dynamic.envelope.selection.selected.map((entry) => `${entry.id} (${entry.reason})`);
    snapshot.dynamicGraphContext = {
      envelopeHash: dynamic.envelopeHash,
      semanticRevision: dynamic.envelope.binding.semanticRevision,
      semanticHash: dynamic.envelope.binding.semanticHash,
      contextualRevision: dynamic.envelope.binding.contextualRevision,
      contextualHash: dynamic.envelope.binding.contextualHash,
      selectedIds: dynamic.envelope.selection.selected.map((entry) => entry.id),
    };
    const workingSpec = dynamic.envelope.records.find((record) => record.kind === "working_spec");
    if (workingSpec?.kind === "working_spec") {
      snapshot.workingSpec = {
        id: workingSpec.id,
        version: workingSpec.value.version,
        digest: workingSpec.value.digest,
        guidance: workingSpec.value.guidance,
      };
    }
    return snapshot;
  }

  public async compilePlanningOutput(input: {
    run: RunRecord;
    attemptId: string;
    output: unknown;
  }): Promise<PlanningCompilation> {
    const pinned = await this.#loadPinned(input.run);
    const parsed = parsePlanningOutput(input.output);
    const graph = compilePlanningSeed(pinned.configuration, input.run, parsed.graphSeed, parsed.full);
    const revision = (input.run.plan?.revision ?? 0) + 1;
    const plan: RunPlanRecord = {
      revision,
      status: "planning",
      full: parsed.full,
      concise: parsed.concise,
      graphSeed: structuredClone(parsed.graphSeed) as unknown as JsonValue,
      steeringHistory: structuredClone(input.run.plan?.steeringHistory ?? []),
    };
    const pendingGraphArtifact: GraphArtifact = graphArtifact(input.run, pinned.configuration, graph, 0);
    const compiledArtifact = {
      protocol: PLAN_ARTIFACT_PROTOCOL,
      runId: input.run.id,
      attemptId: input.attemptId,
      plan,
      graphSha256: graph.hash,
    };
    return {
      plan,
      graphHash: graph.hash,
      graphRevision: 0,
      activity: [compilerActivity(input.run, `Planning graph validated (${graph.nodes().length} nodes)`, "plan")],
      artifactWrites: [
        {
          path: `runs/${input.run.id}/attempts/${input.attemptId}/planning-output.json`,
          bytes: encodeArtifact(compiledArtifact),
          expectedSha256: null,
        },
        {
          path: `runs/${input.run.id}/attempts/${input.attemptId}/planning-graph.json`,
          bytes: encodeRunGraphArtifact(pendingGraphArtifact),
          expectedSha256: null,
        },
      ],
    };
  }

  public async initializeApprovedPlan(run: RunRecord): Promise<ApprovedPlanCompilation> {
    const pinned = await this.#loadPinned(run);
    if (run.plan === undefined) fail("plan_missing", "run has no compiler-validated approval artifact");
    const runType = requireValidation(
      resolveCompiledRunType(pinned.configuration, run.runTypeId),
      "run_type_invalid",
      `pinned run type ${run.runTypeId} is unavailable`,
    );
    const pipeline = pipelineDefinition(runType.document);
    const hasPlanningStage = pipeline.order.some((id) =>
      requiredRecord(pipeline.stages[id], `pipeline stage ${id}`).kind === "planning"
    );
    const graph = run.plan.graphSeed === undefined
      ? (() => {
          if (hasPlanningStage) fail("plan_missing", "approved plan has no compiler-validated graph seed");
          return compileDirectInitialGraph(pinned.configuration, run);
        })()
      : compilePlanningSeed(
          pinned.configuration,
          run,
          parsePlanningSeed(run.plan.graphSeed),
          parsePlanTextRecord(run.plan.full, "approved full plan"),
        );
    if (run.graphHash !== undefined && run.graphHash !== graph.hash) {
      fail("approved_graph_drift", "approved graph seed no longer matches the reviewed planning graph");
    }
    const evaluation = requireValidation(
      await this.#evaluateRules(run, pinned.configuration, graph),
      "rule_compilation_failed",
      "approved graph did not compile into tickets",
    );
    const tickets = reconcileTickets(run, evaluation.tickets, this.#now().toISOString());
    const graphRevision = 1;
    let priorGraph: { graph: TypedGraph; artifact: GraphArtifact; bytesSha256: Sha256Digest } | undefined;
    try {
      priorGraph = await this.#readContextGraph(run, pinned.configuration);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const priorContext = priorGraph === undefined
      ? createGraphContextualState(runRootContextId(run.id), run.workingSpecOwnerId)
      : this.#contextualState(run, priorGraph.artifact);
    const contextual = run.workingSpecOwnerId === undefined
      ? priorContext
      : await this.#materializeWorkingSpecBaseline(run, graph, graphRevision, priorContext);
    const graphBytes = encodeRunGraphArtifact(graphArtifact(
      run,
      pinned.configuration,
      graph,
      graphRevision,
      contextual,
    ));
    const definitions = ticketArtifact(run, graphRevision, evaluation);
    this.#dynamicContextSelector.clear();
    return {
      graphHash: graph.hash,
      graphRevision,
      tickets,
      activity: [
        ...graph.nodes().map((node) => graphActivity(run, "graph_added", node, "approved")),
        compilerActivity(run, `Compiled ${evaluation.tickets.length} deterministic tickets`, "initialize"),
      ],
      artifactWrites: [
        {
          path: graphArtifactPath(run.id),
          bytes: graphBytes,
          expectedSha256: priorGraph?.bytesSha256 ?? null,
        },
        {
          path: ticketDefinitionsPath(run.id),
          bytes: encodeArtifact(definitions),
          expectedSha256: null,
        },
        {
          path: evaluationPath(run.id, graphRevision),
          bytes: encodeArtifact(evaluation),
          expectedSha256: null,
        },
      ],
    };
  }

  public async compileAssignmentOutput(input: {
    run: RunRecord;
    assignment: ReadyAssignment;
    attemptId: string;
    output: unknown;
  }): Promise<AssignmentCompilation> {
    const pinned = await this.#loadPinned(input.run);
    const definitionsRead = await this.#readTicketDefinitions(input.run);
    const definition = definitionsRead.value.evaluation.tickets.find((item) => item.id === input.assignment.ticketId);
    const synthetic = definition ?? integrationDefinition(input.run, input.assignment, pinned.configuration);
    const step = synthetic.workflow.find((item) => item.id === input.assignment.stepId);
    if (step === undefined || step.persona_id !== input.assignment.personaId) {
      fail("assignment_drift", "assignment no longer matches its pinned compiler definition");
    }
    const result = parseAssignmentOutput(input.output, step.graph_mutation);
    if (result.status === "failed") {
      return { outcome: { status: "failed", blocker: result.blocker! } };
    }
    assertCurrentAssignmentChecks(input.run, input.assignment, input.attemptId, step);
    const graphRead = await this.#readGraph(input.run, pinned.configuration);
    let graph = graphRead.graph;
    const changes: Array<{ kind: "added" | "modified" | "deleted"; nodeId: string; nodeType: string; title: string }> = [];
    if (result.graphDelta !== undefined && result.graphDelta !== null) {
      validateAgentGraphDelta(pinned.configuration, graph, synthetic, step, result.graphDelta);
      const applied = graph.apply(result.graphDelta);
      graph = applied.graph;
      changes.push(...applied.changes);
    }
    const reviewCandidates = step.kind === "review"
      ? await this.#reviewCandidateNodeIds(input.run, synthetic)
      : [];
    const reviewEvidence = runRuleEvidence(
      input.run,
      pinned.configuration.configuration_sha256,
      ruleInputGraphSha256(pinned.configuration, graph),
    );
    const effected = await applyReviewEffects({
      configuration: pinned.configuration,
      graph,
      ticket: synthetic,
      step,
      reviewId: input.attemptId,
      actor: step.persona_id,
      candidateNodeIds: reviewCandidates,
      projectRoot: attemptWorkspace(input.run, "ticket", input.assignment.ticketId),
      ...(reviewEvidence === undefined ? {} : { evidence: reviewEvidence }),
    });
    graph = effected.graph;
    changes.push(...effected.changes);
    if (step.graph_mutation === "required" && changes.length === 0) {
      fail("graph_mutation_required", "this compiler step completed without its required graph change");
    }
    if (changes.length === 0) {
      return { outcome: { status: "completed", summary: result.summary! } };
    }
    const evaluation = requireValidation(
      await this.#evaluateRules(input.run, pinned.configuration, graph),
      "rule_compilation_failed",
      "agent graph output did not compile into a valid ticket board",
    );
    const graphRevision = input.run.graphRevision + 1;
    const tickets = reconcileTickets(input.run, evaluation.tickets, this.#now().toISOString());
    const graphBytes = encodeRunGraphArtifact(graphArtifact(
      input.run,
      pinned.configuration,
      graph,
      graphRevision,
      this.#contextualState(input.run, graphRead.artifact),
    ));
    const definitions = ticketArtifact(input.run, graphRevision, evaluation);
    this.#dynamicContextSelector.clear();
    return {
      outcome: { status: "completed", summary: result.summary! },
      graphHash: graph.hash,
      graphRevision,
      tickets,
      activity: changes.map((change) => graphActivity(
        input.run,
        change.kind === "added" ? "graph_added" : change.kind === "deleted" ? "graph_deleted" : "graph_modified",
        { id: change.nodeId, type: change.nodeType, title: change.title },
        input.assignment.ticketId,
      )),
      artifactWrites: [
        {
          path: graphArtifactPath(input.run.id),
          bytes: graphBytes,
          expectedSha256: graphRead.bytesSha256,
        },
        {
          path: ticketDefinitionsPath(input.run.id),
          bytes: encodeArtifact(definitions),
          expectedSha256: definitionsRead.bytesSha256,
        },
        {
          path: evaluationPath(input.run.id, graphRevision),
          bytes: encodeArtifact(evaluation),
          expectedSha256: null,
        },
      ],
    };
  }

  public async verifyRun(run: RunRecord): Promise<VerificationCompilation> {
    const pinned = await this.#loadPinned(run);
    const graphRead = await this.#readGraph(run, pinned.configuration);
    if (run.graphHash !== graphRead.graph.hash) {
      return { ok: false, reason: "The durable graph hash does not match the run record." };
    }
    const evaluation = requireValidation(
      await this.#evaluateRules(run, pinned.configuration, graphRead.graph),
      "rule_compilation_failed",
      "verification could not compile the current graph",
    );
    if (evaluation.tickets.length > 0) {
      return {
        ok: false,
        reason: `Verification found ${evaluation.tickets.length} still-applicable compiler tickets: ${evaluation.tickets.map((item) => item.title).join("; ")}`,
      };
    }
    if (Object.values(run.tickets).some((ticket) => ticket.status !== "completed")) {
      return { ok: false, reason: "Verification found a ticket that is not complete." };
    }
    const compiledAt = this.#now().toISOString();
    const reports = compileConfiguredReports({
      configuration: pinned.configuration,
      graph: graphRead.graph,
      run,
      compiledAt,
    });
    const reportWrites = await this.#prepareReportWrites(reports.artifacts);
    return {
      ok: true,
      report: reports.report,
      activity: [compilerActivity(run, "Typed graph and deterministic ticket fixpoint verified", "verify")],
      artifactWrites: [
        {
          path: `runs/${run.id}/program/verification-${run.revision}.json`,
          bytes: encodeArtifact({
            protocol: "koni.verification-compilation.v1",
            runId: run.id,
            graphSha256: graphRead.graph.hash,
            evaluationSha256: evaluation.evaluation_sha256,
            reportId: reports.report.reportId,
            reportBundleSha256: reports.report.bundleHash,
            verifiedAt: compiledAt,
          }),
          expectedSha256: null,
        },
        ...reportWrites,
      ],
    };
  }

  async #prepareReportWrites(artifacts: readonly PreparedReportArtifact[]): Promise<TransactionWrite[]> {
    const writes: TransactionWrite[] = [];
    for (const artifact of artifacts) {
      const absolute = path.join(this.#stateRoot, artifact.path);
      let current: Buffer | undefined;
      try {
        current = await readFile(absolute);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (current === undefined) {
        writes.push({ path: artifact.path, bytes: artifact.bytes, expectedSha256: null });
      } else if (rawSha256(current) !== rawSha256(artifact.bytes)) {
        fail("report_artifact_drift", `deterministic report artifact changed at ${artifact.path}`);
      }
    }
    return writes;
  }

  public async createIntegrationTicket(input: {
    run: RunRecord;
    conflictReport: string;
    targetOid: string;
  }): Promise<TicketRecord> {
    const pinned = await this.#loadPinned(input.run);
    const runType = requireValidation(resolveCompiledRunType(pinned.configuration, input.run.runTypeId), "run_type_invalid", "run type disappeared");
    const promotion = optionalRecord(runType.document.promotion);
    const operationId = optionalString(promotion?.conflict_operation) ?? "resolve-target-integration";
    const id = `TK-integration-${digestBody(canonicalHash([input.run.id, input.targetOid, input.conflictReport])).slice(0, 16)}`;
    const at = this.#now().toISOString();
    return {
      id,
      operationId,
      title: `Integrate target ${shortOid(input.targetOid)}`,
      summary: boundedText(input.conflictReport, "conflict report", 64 * 1024),
      status: "ready",
      priority: -1_000_000,
      dependencyIds: [],
      targetNodeIds: [],
      readPaths: ["."],
      writePaths: ["."],
      steps: [{
        id: "resolve-conflicts",
        title: "Resolve target conflicts",
        personaId: "integrator",
        status: "pending",
        attemptIds: [],
        summary: undefined,
        startedAt: undefined,
        completedAt: undefined,
      }],
      worktreePath: undefined,
      branch: undefined,
      blocker: undefined,
      createdAt: at,
      updatedAt: at,
    };
  }

  async #materializeWorkingSpecBaseline(
    run: RunRecord,
    graph: TypedGraph,
    semanticRevision: number,
    prior: GraphContextualState,
  ): Promise<GraphContextualState> {
    const ownerPersonaId = run.workingSpecOwnerId;
    if (ownerPersonaId === undefined) return prior;
    if (prior.canonicalWorkingSpecId !== undefined) {
      fail("working_spec_baseline_exists", "approved run graph already has a canonical working-spec baseline");
    }
    if (prior.ownerPersonaId !== undefined && prior.ownerPersonaId !== ownerPersonaId) {
      fail("working_spec_owner_drift", "durable graph owner differs from the owner pinned at run creation");
    }
    const source = await this.#workingSpecBaselineSource(run);
    const full = run.plan?.full ?? {};
    const planned = source.kind === "approved_plan";
    const baseline: WorkingSpecBaseline = {
      objective: run.objective,
      intake: Object.fromEntries(Object.entries(run.intake).sort(([left], [right]) => compareText(left, right))),
      acceptedPlan: planned ? {
        architecture: full.architecture ?? "",
        decisions: full.decisions ?? "",
        risk: full.risk ?? "",
        verification: full.verification ?? "",
      } : null,
      resolvedDecisions: planned ? full.decisions ?? "" : "Direct approval preserves the objective and intake as the decision baseline.",
      verificationIntent: planned
        ? full.verification ?? ""
        : `Verify the approved objective against its intake: ${Object.values(run.intake).join("; ")}`,
      source,
    };
    const guidance = JSON.stringify({
      objective: baseline.objective,
      intake: baseline.intake,
      acceptedPlan: baseline.acceptedPlan,
      resolvedDecisions: baseline.resolvedDecisions,
      verificationIntent: baseline.verificationIntent,
    }, null, 2);
    if (Buffer.byteLength(guidance, "utf8") > MAX_BASELINE_SPEC_BYTES || guidance.includes("\u0000")) {
      fail("working_spec_baseline_size", "canonical working-spec baseline is oversized or unsafe");
    }
    const rootNodes = graph.nodes().filter((node) =>
      node.annotations.run_root === true || node.title === run.objective);
    const affectedNodeIds = rootNodes.map((node) => node.id).sort(compareText);
    const repositoryPaths = [...new Set(graph.nodes().flatMap((node) => graph.repositoryPaths(node.id)))].sort(compareText);
    const baselineDigest = canonicalHash(baseline);
    const digest = workingSpecDigest({ baselineDigest, guidance, affectedNodeIds, repositoryPaths });
    const id = `spec-${digestBody(canonicalHash([run.id, 1, digest, source.artifactSha256])).slice(0, 24)}`;
    const record: WorkingSpecVersionRecord = {
      protocol: WORKING_SPEC_PROTOCOL,
      recordType: "working_spec",
      id,
      runId: run.id,
      generation: run.generation,
      ownerPersonaId,
      version: 1,
      digest,
      baselineDigest,
      baseline,
      guidance,
      affectedNodeIds,
      repositoryPaths,
      provenance: {
        kind: "baseline",
        runId: run.id,
        generation: run.generation,
        personaId: ownerPersonaId,
        semanticRevision,
        semanticHash: graph.hash,
        contextualRevision: prior.revision,
        contextualHash: prior.hash,
        recordedAt: this.#now().toISOString(),
      },
    };
    return appendContextualRecord(prior, record, [
      { sourceId: id, relation: "context_for", targetKind: "run_root", targetId: prior.runRootId },
      ...affectedNodeIds.map((targetId): GraphContextualLink => ({
        sourceId: id,
        relation: "affects",
        targetKind: "semantic_node",
        targetId,
      })),
      ...repositoryPaths.map((targetId): GraphContextualLink => ({
        sourceId: id,
        relation: "references_path",
        targetKind: "repository_path",
        targetId,
      })),
    ], { canonicalWorkingSpecId: id, ownerPersonaId });
  }

  async #workingSpecBaselineSource(run: RunRecord): Promise<WorkingSpecBaseline["source"]> {
    if (run.plan === undefined) fail("working_spec_source", "working-spec baseline has no approved plan source");
    if (run.planningMode === "direct") {
      const artifactPath = `runs/${run.id}/direct-approval.json`;
      const bytes = await readFile(path.join(this.#stateRoot, artifactPath));
      if (bytes.byteLength === 0 || bytes.byteLength > 16 * 1024 * 1024 || bytes.includes(0)) {
        fail("working_spec_source", "direct-approval source artifact is missing or unsafe");
      }
      let value: unknown;
      try {
        value = JSON.parse(bytes.toString("utf8"));
      } catch {
        fail("working_spec_source", "direct-approval source artifact is not valid JSON");
      }
      const sourcePlan = isRecord(value) && isRecord(value.plan) ? value.plan : undefined;
      if (
        !isRecord(value) ||
        value.protocol !== PLAN_ARTIFACT_PROTOCOL ||
        value.runId !== run.id ||
        value.directApproval !== true ||
        value.graphSha256 !== run.graphHash ||
        sourcePlan === undefined ||
        !isRecord(sourcePlan.full) ||
        !isRecord(sourcePlan.concise) ||
        sourcePlan.revision !== run.plan.revision ||
        canonicalHash(sourcePlan.full) !== canonicalHash(run.plan.full) ||
        canonicalHash(sourcePlan.concise) !== canonicalHash(run.plan.concise)
      ) fail("working_spec_source", "direct-approval source artifact failed its immutable compiler binding");
      return {
        kind: "direct_approval",
        artifactPath,
        artifactSha256: rawSha256(bytes),
        planRevision: run.plan.revision,
      };
    }
    const candidates = Object.values(run.attempts)
      .filter((attempt) => attempt.kind === "planning" && attempt.terminalAcceptedAt !== undefined)
      .sort((left, right) =>
        (right.terminalAcceptedAt ?? "").localeCompare(left.terminalAcceptedAt ?? "") || compareText(left.id, right.id));
    for (const attempt of candidates) {
      const artifactPath = `runs/${run.id}/attempts/${attempt.id}/planning-output.json`;
      let bytes: Buffer;
      try {
        bytes = await readFile(path.join(this.#stateRoot, artifactPath));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (bytes.byteLength === 0 || bytes.byteLength > 16 * 1024 * 1024 || bytes.includes(0)) continue;
      let value: unknown;
      try {
        value = JSON.parse(bytes.toString("utf8"));
      } catch {
        continue;
      }
      const plan = isRecord(value) && isRecord(value.plan) ? value.plan : undefined;
      if (
        plan === undefined ||
        !isRecord(plan.full) ||
        !isRecord(plan.concise) ||
        plan.revision !== run.plan.revision ||
        canonicalHash(plan.full) !== canonicalHash(run.plan.full) ||
        canonicalHash(plan.concise) !== canonicalHash(run.plan.concise) ||
        canonicalHash(plan.graphSeed ?? null) !== canonicalHash(run.plan.graphSeed ?? null)
      ) continue;
      return {
        kind: "approved_plan",
        artifactPath,
        artifactSha256: rawSha256(bytes),
        planRevision: run.plan.revision,
        attemptId: attempt.id,
      };
    }
    fail("working_spec_source", "final compiler-accepted planning source artifact is unavailable");
  }

  public async executeAgentTool(input: {
    run: RunRecord;
    attempt: AgentAttemptRecord;
    grant: AuthorityGrant;
    spec?: Readonly<AgentLaunchSpec>;
    call: KoniToolInvocation;
  }): Promise<AgentToolCompilation> {
    const { run, attempt, grant, call } = input;
    const spec = input.spec ?? this.#issuedSpecs.get(attempt.id);
    if (spec === undefined) fail("agent_tool_spec", "agent tool request has no authenticated launch specification");
    assertAgentToolIdentity(run, attempt, grant);
    assertRecoveryIdentity(run, attempt, spec);
    const pinned = await this.#loadPinned(run);
    const descriptor = await this.#descriptorForRecordedAttempt(run, attempt, pinned.configuration);
    const graphRead = await this.#readContextGraph(run, pinned.configuration);
    const contextual = this.#contextualState(run, graphRead.artifact);
    if (call.name === "koni_graph_context") {
      if (!grant.allowedTools.includes(call.name)) {
        fail("graph_context_scope", "this attempt has no compiler-issued graph context authority");
      }
      const request = parseDynamicGraphSelectionRequest(call.arguments);
      const dynamic = await this.selectDynamicGraphContext({ run, attempt, spec, request });
      const semantic = dynamic.envelope.records.filter((record) => record.kind === "semantic_node");
      const ids = new Set(semantic.map((record) => record.id));
      const value = {
        protocol: "koni.graph-context.v1" as const,
        graphSha256: dynamic.envelope.binding.semanticHash,
        graphRevision: dynamic.envelope.binding.semanticRevision,
        contextualSha256: dynamic.envelope.binding.contextualHash,
        contextualRevision: dynamic.envelope.binding.contextualRevision,
        anchors: [...new Set(request.anchors ?? descriptor.definition?.target_node_ids ?? descriptor.readNodeIds)].sort(compareText),
        nodes: semantic.map((record) => record.node),
        edges: graphRead.graph.edges().filter((edge) => ids.has(edge.source) && ids.has(edge.target)),
        contextualRecords: dynamic.envelope.records.filter((record) => record.kind !== "semantic_node"),
        dynamicEnvelopeHash: dynamic.envelopeHash,
        selection: dynamic.envelope.selection,
        budget: dynamic.envelope.budget,
      };
      if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_GRAPH_CONTEXT_BYTES) {
        fail("graph_context_size", "graph context response exceeds its compiler result bound");
      }
      return {
        summary: `Returned ${value.nodes.length} scoped graph nodes and current contextual guidance`,
        value: value as unknown as JsonValue,
      };
    }
    if (call.name === "koni_update_working_spec") {
      if (attempt.personaId !== run.workingSpecOwnerId || contextual.ownerPersonaId !== run.workingSpecOwnerId) {
        fail("working_spec_owner", "only the working-spec owner pinned at run creation may update the canonical version");
      }
      const canonicalId = contextual.canonicalWorkingSpecId;
      const current = canonicalId === undefined ? undefined : contextual.records[canonicalId];
      if (current?.recordType !== "working_spec") {
        fail("working_spec_missing", "run has no initialized canonical working-spec baseline");
      }
      const expectedRevision = requiredToolInteger(call.arguments, "expectedContextualRevision");
      const expectedDigest = requireDigest(call.arguments.expectedCanonicalDigest, "expected canonical working-spec digest");
      if (expectedRevision !== contextual.revision || expectedDigest !== current.digest) {
        fail("working_spec_cas", "working-spec contextual revision or canonical digest is stale");
      }
      const guidanceArg = optionalToolString(call.arguments, "guidance");
      const contentArg = optionalToolString(call.arguments, "content");
      if ((guidanceArg === undefined) === (contentArg === undefined)) {
        fail("working_spec_shape", "working-spec update requires exactly one guidance/content field");
      }
      const guidance = boundedText(guidanceArg ?? contentArg, "working-spec guidance", MAX_WORKING_SPEC_BYTES);
      const requestedNodeIds = optionalToolStringArray(call.arguments, "affectedNodeIds");
      const affectedNodeIds = [...new Set(requestedNodeIds ?? current.affectedNodeIds)].sort(compareText);
      if (requestedNodeIds !== undefined) {
        const visibleNodes = new Set([...descriptor.readNodeIds, ...descriptor.writeNodeIds]);
        for (const nodeId of requestedNodeIds) {
          if (!visibleNodes.has(nodeId) || graphRead.graph.node(nodeId) === undefined) {
            fail("working_spec_scope", `working-spec update expands beyond compiler-visible node ${nodeId}`);
          }
        }
      }
      const requestedPaths = optionalToolStringArray(call.arguments, "paths");
      const repositoryPaths = requestedPaths === undefined
        ? [...current.repositoryPaths]
        : normalizeReferencedPaths(requestedPaths, grant, "working-spec");
      const baselineDigest = current.baselineDigest;
      const digest = workingSpecDigest({ baselineDigest, guidance, affectedNodeIds, repositoryPaths });
      const version = current.version + 1;
      const recordedAt = this.#now().toISOString();
      const id = `spec-${digestBody(canonicalHash([run.id, version, digest, attempt.id, call.callId])).slice(0, 24)}`;
      const record: WorkingSpecVersionRecord = {
        protocol: WORKING_SPEC_PROTOCOL,
        recordType: "working_spec",
        id,
        runId: run.id,
        generation: run.generation,
        ownerPersonaId: attempt.personaId,
        version,
        digest,
        baselineDigest,
        baseline: structuredClone(current.baseline),
        guidance,
        affectedNodeIds: [...affectedNodeIds],
        repositoryPaths,
        supersedes: current.id,
        provenance: contextualProvenance(
          "owner_update",
          run,
          attempt,
          spec,
          graphRead.artifact.revision,
          graphRead.graph.hash,
          contextual,
          recordedAt,
        ),
      };
      const nextContext = appendContextualRecord(contextual, record, [
        { sourceId: id, relation: "context_for", targetKind: "run_root", targetId: contextual.runRootId },
        { sourceId: id, relation: "supersedes", targetKind: "context_record", targetId: current.id },
        ...affectedNodeIds.map((targetId): GraphContextualLink => ({ sourceId: id, relation: "affects", targetKind: "semantic_node", targetId })),
        ...repositoryPaths.map((targetId): GraphContextualLink => ({ sourceId: id, relation: "references_path", targetKind: "repository_path", targetId })),
      ], { canonicalWorkingSpecId: id, ownerPersonaId: attempt.personaId });
      this.#dynamicContextSelector.clear();
      return {
        summary: `Working specification advanced to version ${version}`,
        value: {
          workingSpecId: id,
          version,
          digest,
          contextualRevision: nextContext.revision,
          contextualHash: nextContext.hash,
          supersedes: current.id,
        },
        artifactWrites: [{
          path: graphArtifactPath(run.id),
          bytes: encodeRunGraphArtifact(graphArtifact(run, pinned.configuration, graphRead.graph, graphRead.artifact.revision, nextContext)),
          expectedSha256: graphRead.bytesSha256,
        }],
      };
    }
    if (call.name === "koni_record_note") {
      if (!grant.allowedTools.includes(call.name)) {
        fail("graph_note_scope", "this attempt has no compiler-issued graph note authority");
      }
      const targetId = requiredToolString(call.arguments, "nodeId");
      const isRunRoot = targetId === contextual.runRootId;
      const visibleNodes = new Set([...descriptor.readNodeIds, ...descriptor.writeNodeIds]);
      const node = isRunRoot ? undefined : graphRead.graph.node(targetId);
      if (!isRunRoot && (node === undefined || !visibleNodes.has(targetId))) {
        fail("graph_note_scope", `node ${targetId} is not compiler-visible to this attempt`);
      }
      const kind = requiredToolString(call.arguments, "kind");
      if (!isGraphNoteKind(kind)) fail("graph_note_kind", `unsupported advisory note kind ${kind}`);
      const body = boundedText(requiredToolString(call.arguments, "body"), "graph note body", 1024 * 1024);
      const repositoryPaths = normalizeReferencedPaths(
        optionalToolStringArray(call.arguments, "paths") ?? [],
        grant,
        "graph note",
      );
      const supersedes = optionalToolString(call.arguments, "supersedes");
      const existingNativeNotes = Object.values(contextual.records)
        .filter((record): record is GraphChangeNoteRecord => record.recordType === "change_note");
      const legacyNotes = await this.#readGraphNotes(run);
      if (supersedes !== undefined) {
        const prior = existingNativeNotes.find((note) => note.id === supersedes)
          ?? legacyNotes.find((note) => note.id === supersedes);
        if (prior === undefined) fail("graph_note_lineage", `superseded graph note ${supersedes} is missing`);
        const priorTarget = prior.protocol === LEGACY_GRAPH_NOTE_PROTOCOL ? prior.nodeId : prior.subject.id;
        if (priorTarget !== targetId) fail("graph_note_lineage", "a graph note may supersede only the same node/run-root subject");
        if ([...existingNativeNotes, ...legacyNotes].some((note) => note.supersedes === prior.id)) {
          fail("graph_note_lineage", `graph note ${prior.id} already has a superseding successor`);
        }
      }
      const recordedAt = this.#now().toISOString();
      const id = `note-${digestBody(canonicalHash([
        run.id,
        run.generation,
        attempt.id,
        call.callId,
        targetId,
        kind,
        body,
        repositoryPaths,
        supersedes ?? null,
        graphRead.graph.hash,
        contextual.hash,
      ])).slice(0, 24)}`;
      const note: GraphChangeNoteRecord = {
        protocol: GRAPH_CHANGE_NOTE_PROTOCOL,
        recordType: "change_note",
        id,
        runId: run.id,
        generation: run.generation,
        subject: { kind: isRunRoot ? "run_root" : "semantic_node", id: targetId },
        kind,
        body,
        repositoryPaths,
        targetNodeHashes: node === undefined ? {} : { [node.id]: canonicalHash(node) },
        ...(supersedes === undefined ? {} : { supersedes }),
        provenance: contextualProvenance(
          "change_note",
          run,
          attempt,
          spec,
          graphRead.artifact.revision,
          graphRead.graph.hash,
          contextual,
          recordedAt,
        ),
      };
      const nextContext = appendContextualRecord(contextual, note, [
        {
          sourceId: id,
          relation: "context_for",
          targetKind: isRunRoot ? "run_root" : "semantic_node",
          targetId,
        },
        ...repositoryPaths.map((path): GraphContextualLink => ({
          sourceId: id,
          relation: "references_path",
          targetKind: "repository_path",
          targetId: path,
        })),
        ...(supersedes === undefined ? [] : [{
          sourceId: id,
          relation: "supersedes" as const,
          targetKind: "context_record" as const,
          targetId: supersedes,
        }]),
      ]);
      this.#dynamicContextSelector.clear();
      return {
        summary: `Recorded ${kind} on ${node?.title ?? "run root"}`,
        value: {
          noteId: id,
          nodeId: targetId,
          kind,
          status: "working",
          contextualRevision: nextContext.revision,
          contextualHash: nextContext.hash,
        },
        activity: [{
          id: `activity-${digestBody(canonicalHash([run.id, run.revision, id])).slice(0, 20)}`,
          at: recordedAt,
          kind: "agent",
          message: `${attempt.personaId} noted ${node === undefined ? "run root" : `${node.type}: ${node.title}`}`,
          ticketId: attempt.ticketId,
          nodeId: node?.id,
        }],
        artifactWrites: [{
          path: graphArtifactPath(run.id),
          bytes: encodeRunGraphArtifact(graphArtifact(run, pinned.configuration, graphRead.graph, graphRead.artifact.revision, nextContext)),
          expectedSha256: graphRead.bytesSha256,
        }],
      };
    }
    fail("tool_unsupported", `${call.name} is not a compiler-owned graph tool`);
  }

  public async resolveAgentCheck(input: {
    run: RunRecord;
    attempt: AgentAttemptRecord;
    checkId: string;
  }): Promise<ResolvedAgentCheck> {
    const pinned = await this.#loadPinned(input.run);
    const descriptor = await this.#descriptorForRecordedAttempt(input.run, input.attempt, pinned.configuration);
    if (descriptor.step === undefined || !descriptor.step.validation_checks.includes(input.checkId)) {
      fail("check_scope", `check ${input.checkId} is outside this step's exact configured validation checks`);
    }
    if (descriptor.graph === undefined) fail("check_graph", "configured checks require a compiler-bound graph epoch");
    return resolveConfiguredAgentCheck({
      configuration: pinned.configuration,
      graph: descriptor.graph,
      descriptor,
      projectRoot: attemptWorkspace(input.run, input.attempt.kind ?? "ticket", input.attempt.ticketId),
      requestedCheckId: input.checkId,
    });
  }

  public async compileAgentCheckResult(input: {
    run: RunRecord;
    attempt: AgentAttemptRecord;
    check: ResolvedAgentCheck;
    executions: AgentCheckExecution[];
  }): Promise<CompiledAgentCheckResult> {
    const pinned = await this.#loadPinned(input.run);
    const descriptor = await this.#descriptorForRecordedAttempt(input.run, input.attempt, pinned.configuration);
    if (descriptor.step === undefined || !descriptor.step.validation_checks.includes(input.check.requestedCheckId)) {
      fail("check_scope", `check ${input.check.requestedCheckId} is outside this step's exact configured validation checks`);
    }
    if (descriptor.graph === undefined) fail("check_graph", "configured checks require a compiler-bound graph epoch");
    const resolved = await resolveConfiguredAgentCheck({
      configuration: pinned.configuration,
      graph: descriptor.graph,
      descriptor,
      projectRoot: attemptWorkspace(input.run, input.attempt.kind ?? "ticket", input.attempt.ticketId),
      requestedCheckId: input.check.requestedCheckId,
    });
    if (canonicalHash(resolved) !== canonicalHash(input.check)) {
      fail("check_resolution_drift", "configured check resolution changed before its result was compiled");
    }
    if (input.executions.length !== resolved.commands.length) {
      fail("check_execution_count", "configured check execution count does not match its compiler plan");
    }
    const compiled = resolved.commands.map((command, index) =>
      compileCheckCommandExecution(
        command,
        input.executions[index]!,
        index,
        pinned.configuration,
        descriptor,
      ));
    const accepted = compiled.every((result) => result.accepted);
    let passed = compiled.every((result) => result.passed);
    if (resolved.kind === "graph") {
      passed = await evaluateRequestedGraphCheck(
        pinned.configuration,
        descriptor.graph,
        attemptWorkspace(input.run, input.attempt.kind ?? "ticket", input.attempt.ticketId),
        resolved.requestedCheckId,
        descriptor.definition?.target_node_ids ?? descriptor.readNodeIds,
      );
    }
    const inputGraphSha256 = ruleInputGraphSha256(pinned.configuration, descriptor.graph);
    const evidenceId = `check-evidence-${digestBody(canonicalHash([
      input.run.id,
      input.attempt.id,
      resolved,
      input.executions,
      inputGraphSha256,
    ])).slice(0, 24)}`;
    const evidenceArtifact = {
      protocol: "koni.agent-check-execution-evidence.v1",
      id: evidenceId,
      configurationSha256: pinned.configuration.configuration_sha256,
      inputGraphSha256,
      graphRevision: input.run.graphRevision,
      graphSha256: descriptor.graph.hash,
      runId: input.run.id,
      ticketId: input.attempt.ticketId,
      stepId: input.attempt.stepId,
      attemptId: input.attempt.id,
      requestedCheckId: resolved.requestedCheckId,
      resolvedCheckSha256: canonicalHash(resolved),
      accepted,
      passed,
      commands: compiled.map((result) => result.evidence),
      recordedAt: this.#now().toISOString(),
    };
    const envelope = mergeCheckRuleEvidence({
      prior: runRuleEvidence(
        input.run,
        pinned.configuration.configuration_sha256,
        inputGraphSha256,
      ),
      configuration: pinned.configuration,
      graph: descriptor.graph,
      descriptor,
      resolved,
      accepted,
      passed,
      evidenceId,
      recordedAt: evidenceArtifact.recordedAt,
    });
    const evidenceRun = structuredClone(input.run);
    evidenceRun.ruleAuthorityEvidence = envelope as unknown as JsonValue;
    const evaluation = requireValidation(
      await this.#evaluateRules(evidenceRun, pinned.configuration, descriptor.graph),
      "rule_compilation_failed",
      "accepted check evidence did not compile into a valid ticket board",
    );
    const definitionsRead = await this.#readTicketDefinitions(input.run);
    const tickets = reconcileTickets(input.run, evaluation.tickets, this.#now().toISOString());
    const definitions = ticketArtifact(input.run, input.run.graphRevision, evaluation);
    return {
      accepted,
      passed,
      summary: accepted
        ? `${resolved.requestedCheckId} ${passed ? "passed" : "recorded a nonpassing result"}`
        : `${resolved.requestedCheckId} failed its configured result contract`,
      value: {
        requestedCheckId: resolved.requestedCheckId,
        accepted,
        passed,
        evidenceId,
        commands: compiled.map((result) => result.value),
      },
      evidence: evidenceArtifact as unknown as JsonValue,
      ruleAuthorityEvidence: envelope as unknown as JsonValue,
      tickets,
      activity: [{
        id: `activity-${digestBody(canonicalHash([input.run.id, input.run.revision, evidenceId])).slice(0, 20)}`,
        at: evidenceArtifact.recordedAt,
        kind: "compiler",
        message: `${resolved.requestedCheckId} ${passed ? "passed" : accepted ? "recorded a nonpassing result" : "failed validation"}`,
        ticketId: input.attempt.ticketId,
        nodeId: undefined,
      }],
      artifactWrites: [{
        path: ticketDefinitionsPath(input.run.id),
        bytes: encodeArtifact(definitions),
        expectedSha256: definitionsRead.bytesSha256,
      }],
    };
  }

  public async projectGraph(run: RunRecord, ticketId?: string): Promise<{
    nodes: GraphNode[];
    edges: GraphEdge[];
  }> {
    const pinned = await this.#loadPinned(run);
    const graph = (await this.#readGraph(run, pinned.configuration)).graph;
    if (ticketId === undefined) return { nodes: graph.nodes(), edges: graph.edges() };
    const ticket = run.tickets[ticketId];
    if (ticket === undefined) fail("ticket_missing", `ticket ${ticketId} does not exist in run ${run.id}`);
    const selected = new Set<string>();
    for (const nodeId of [...ticket.targetNodeIds].sort(compareText)) {
      if (graph.node(nodeId) === undefined) continue;
      selected.add(nodeId);
      for (const neighbor of graph.neighbors(nodeId)) selected.add(neighbor.id);
    }
    const ids = [...selected].sort(compareText).slice(0, 256);
    const bounded = new Set(ids);
    return {
      nodes: ids.flatMap((id) => {
        const node = graph.node(id);
        return node === undefined ? [] : [node];
      }),
      edges: graph.edges().filter((edge) => bounded.has(edge.source) && bounded.has(edge.target)),
    };
  }

  async #evaluateRules(
    run: RunRecord,
    configuration: CompiledConfiguration,
    graph: TypedGraph,
  ): Promise<ValidationResult<CompiledRuleEvaluation>> {
    const inputGraphSha256 = ruleInputGraphSha256(configuration, graph);
    const durableEvidence = runRuleEvidence(run, configuration.configuration_sha256, inputGraphSha256);
    const injectedEvidence = this.#ruleAuthorityEvidence === undefined
      ? undefined
      : await this.#ruleAuthorityEvidence(deepFreeze({
          run: structuredClone(run),
          configuration,
          inputGraphSha256,
          graphNodes: graph.nodes(),
        }));
    if (durableEvidence !== undefined && injectedEvidence !== undefined &&
        canonicalHash(durableEvidence) !== canonicalHash(injectedEvidence)) {
      fail("rule_evidence_conflict", "durable and injected rule-authority evidence disagree");
    }
    const evidence = durableEvidence ?? injectedEvidence;
    const adapter = await createProductionRuleDomainAdapter({
      configuration,
      graph,
      projectRoot: path.resolve(run.git.run.worktree),
      ...(evidence === undefined ? {} : { evidence }),
    });
    return evaluateConfiguredRules({ configuration, graph }, { adapter });
  }

  async #configuredCheckGrant(
    run: RunRecord,
    configuration: CompiledConfiguration,
    descriptor: AttemptDescriptor,
    capabilities: ConfigurationObject,
  ): Promise<AuthorityGrant["configuredChecks"] | undefined> {
    const ids = [...new Set(descriptor.step?.validation_checks ?? [])];
    if (ids.length === 0) return undefined;
    if (descriptor.graph === undefined) fail("check_graph", "configured checks require a compiler-bound graph epoch");
    const plans = await Promise.all(ids.map((requestedCheckId) => resolveConfiguredAgentCheck({
      configuration,
      graph: descriptor.graph!,
      descriptor,
      projectRoot: attemptWorkspace(run, "ticket", descriptor.ticketId),
      requestedCheckId,
    })));
    const commands = plans.flatMap((plan) => plan.commands);
    const commandCapability = optionalString(capabilities.commands) ?? "none";
    const personaNetwork = capabilities.network_access === true;
    for (const command of commands) {
      if (command.effect === "workspace_write" && commandCapability !== "workspace_write") {
        fail("check_capability", `persona ${descriptor.personaId} cannot execute workspace-writing check ${command.checkId}`);
      }
      if (command.networkAccess && !personaNetwork) {
        fail("check_capability", `persona ${descriptor.personaId} cannot execute networked check ${command.checkId}`);
      }
    }
    return {
      ids,
      networkAccess: commands.some((command) => command.networkAccess),
      maxTimeoutMs: Math.max(1, ...commands.map((command) => command.timeoutMs)),
    };
  }

  async #descriptorForRecordedAttempt(
    run: RunRecord,
    attempt: AgentAttemptRecord,
    configuration: CompiledConfiguration,
  ): Promise<AttemptDescriptor> {
    const runType = requireValidation(
      resolveCompiledRunType(configuration, run.runTypeId),
      "run_type_invalid",
      `pinned run type ${run.runTypeId} is unavailable`,
    );
    const kind = recoveredAttemptKind(run, attempt);
    const assignment = kind === "planning" || kind === "verification"
      ? undefined
      : assignmentFromAttempt(run, attempt);
    const descriptor = await this.#attemptDescriptor({
      kind,
      run,
      ...(assignment === undefined ? {} : { assignment }),
    }, configuration, runType.document);
    if (
      descriptor.ticketId !== attempt.ticketId ||
      descriptor.stepId !== attempt.stepId ||
      descriptor.personaId !== attempt.personaId
    ) fail("attempt_assignment_drift", "durable attempt no longer matches its pinned compiler assignment");
    return descriptor;
  }

  async #readGraphNote(run: RunRecord, id: string): Promise<GraphNoteArtifact> {
    if (!/^note-[0-9a-f]{24}$/u.test(id)) fail("graph_note_id", "superseded graph note id is malformed");
    const bytes = await readFile(path.join(this.#stateRoot, graphNotePath(run.id, id))).catch(() => undefined);
    if (bytes === undefined || bytes.byteLength > 2 * 1024 * 1024 || bytes.includes(0)) {
      fail("graph_note_lineage", `superseded graph note ${id} is missing or unsafe`);
    }
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      fail("graph_note_lineage", `superseded graph note ${id} is malformed`);
    }
    if (
      !isRecord(value) ||
      value.protocol !== LEGACY_GRAPH_NOTE_PROTOCOL ||
      value.id !== id ||
      value.runId !== run.id ||
      typeof value.nodeId !== "string" ||
      typeof value.body !== "string" ||
      !isGraphNoteKind(value.kind)
    ) fail("graph_note_lineage", `superseded graph note ${id} failed its identity binding`);
    return value as unknown as GraphNoteArtifact;
  }

  async #readGraphNotes(run: RunRecord): Promise<GraphNoteArtifact[]> {
    const directory = path.join(this.#stateRoot, `runs/${run.id}/program/notes`);
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    if (entries.length > MAX_GRAPH_NOTES) fail("graph_note_limit", "run graph note inventory exceeds its compiler bound");
    const output: GraphNoteArtifact[] = [];
    for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
      if (!entry.isFile() || !/^note-[0-9a-f]{24}\.json$/u.test(entry.name)) continue;
      output.push(await this.#readGraphNote(run, entry.name.slice(0, -5)));
    }
    return output;
  }

  async #attemptDescriptor(
    input: AttemptDescriptorInput,
    configuration: CompiledConfiguration,
    runType: ConfigurationObject,
  ): Promise<AttemptDescriptor> {
    if (input.kind === "planning") return planningAttempt(input.run, runType);
    if (input.kind === "verification") {
      const graph = (await this.#readGraph(input.run, configuration)).graph;
      return verificationAttempt(input.run, runType, graph);
    }
    if (input.assignment === undefined) fail("assignment_missing", `${input.kind} attempt has no assignment`);
    const definitions = await this.#readTicketDefinitions(input.run);
    const definition = definitions.value.evaluation.tickets.find((item) => item.id === input.assignment!.ticketId)
      ?? integrationDefinition(input.run, input.assignment, configuration);
    const step = definition.workflow.find((item) => item.id === input.assignment!.stepId);
    if (step === undefined || step.persona_id !== input.assignment.personaId) {
      fail("assignment_drift", "scheduler assignment does not match the compiler definition");
    }
    const graph = (await this.#readGraph(input.run, configuration)).graph;
    return ticketAttempt(input.run, definition, step, graph);
  }

  async #loadPinned(run: RunRecord): Promise<PinnedConfigurationArtifact> {
    const cached = this.#pinned.get(run.id);
    if (cached !== undefined) {
      assertPinnedMatchesRun(cached, run);
      return cached;
    }
    const bytes = await readFile(path.join(this.#stateRoot, pinnedConfigurationPath(run.id)));
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      fail("pinned_configuration_json", "pinned run configuration is not valid JSON");
    }
    const artifact = validatePinnedArtifact(value);
    assertPinnedMatchesRun(artifact, run);
    this.#pinned.set(run.id, artifact);
    return artifact;
  }

  async #readGraph(
    run: RunRecord,
    configuration: CompiledConfiguration,
  ): Promise<{ graph: TypedGraph; artifact: GraphArtifact; bytesSha256: Sha256Digest }> {
    const read = await this.#readContextGraph(run, configuration);
    if (read.artifact.revision !== run.graphRevision) {
      fail("graph_artifact_drift", "durable graph semantic revision does not match the run record");
    }
    if (run.graphHash !== undefined && run.graphHash !== read.graph.hash) {
      fail("graph_artifact_hash", "durable graph bytes do not match their compiler hash");
    }
    return read;
  }

  async #readContextGraph(
    run: RunRecord,
    configuration: CompiledConfiguration,
  ): Promise<{ graph: TypedGraph; artifact: GraphArtifact; bytesSha256: Sha256Digest }> {
    const bytes = await readFile(path.join(this.#stateRoot, graphArtifactPath(run.id)));
    const artifact = parseGraphArtifact(bytes);
    if (artifact.runId !== run.id || artifact.configurationSha256 !== run.compiledConfigHash) {
      fail("graph_artifact_drift", "durable graph artifact does not match the run identity");
    }
    const graph = new TypedGraph(requireGraphSchema(configuration), Object.values(artifact.nodes));
    if (graph.hash !== artifact.graphSha256) {
      fail("graph_artifact_hash", "durable semantic graph bytes do not match their compiler hash");
    }
    return { graph, artifact, bytesSha256: rawSha256(bytes) };
  }

  #contextualState(run: RunRecord, artifact: GraphArtifact): GraphContextualState {
    if (artifact.contextual !== undefined) return structuredClone(artifact.contextual);
    return createGraphContextualState(runRootContextId(run.id), run.workingSpecOwnerId);
  }

  async #readTicketDefinitions(run: RunRecord): Promise<{
    value: TicketDefinitionsArtifact;
    bytesSha256: Sha256Digest;
  }> {
    const bytes = await readFile(path.join(this.#stateRoot, ticketDefinitionsPath(run.id)));
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      fail("ticket_artifact_json", "ticket definition artifact is not valid JSON");
    }
    if (!isRecord(value) || value.protocol !== TICKET_ARTIFACT_PROTOCOL || value.runId !== run.id) {
      fail("ticket_artifact_shape", "ticket definition artifact has the wrong identity or protocol");
    }
    const artifact = value as unknown as TicketDefinitionsArtifact;
    if (
      artifact.graphRevision !== run.graphRevision ||
      artifact.evaluation.configuration_sha256 !== run.compiledConfigHash ||
      canonicalHash(withoutField(artifact.evaluation, "evaluation_sha256")) !== artifact.evaluation.evaluation_sha256
    ) fail("ticket_artifact_hash", "ticket definition artifact failed its compiler binding");
    return { value: artifact, bytesSha256: rawSha256(bytes) };
  }

  async #readPreparedAttemptArtifact(
    run: RunRecord,
    attempt: AgentAttemptRecord,
    spec: Readonly<AgentLaunchSpec>,
  ): Promise<PreparedAttemptArtifact> {
    const bytes = await readFile(path.join(
      this.#stateRoot,
      `runs/${run.id}/attempts/${attempt.id}/compiler-input.json`,
    ));
    if (bytes.byteLength > MAX_CONTEXT_BYTES + 1024 * 1024 || bytes.includes(0)) {
      fail("recovery_compiler_input", "stored compiler input is oversized or unsafe");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      fail("recovery_compiler_input", "stored compiler input is not valid JSON");
    }
    if (
      !isRecord(parsed) ||
      parsed.protocol !== "koni.prepared-attempt.v1" ||
      parsed.specHash !== spec.specHash ||
      parsed.contextHash !== spec.authority.authoritativeContextHash ||
      parsed.terminalSchemaHash !== spec.terminal.outputSchemaHash ||
      typeof parsed.contextContent !== "string" ||
      !isRecord(parsed.grant)
    ) fail("recovery_compiler_input", "stored compiler input does not match the immutable launch spec");
    const artifact = parsed as unknown as PreparedAttemptArtifact;
    if (
      rawSha256(artifact.contextContent) !== artifact.contextHash ||
      canonicalHash(artifact.grant) !== spec.authority.grantHash
    ) fail("recovery_compiler_input", "stored compiler input failed its content or grant binding");
    return artifact;
  }

  async #reviewCandidateNodeIds(
    run: RunRecord,
    ticket: DerivedTicketDefinition,
  ): Promise<string[]> {
    const candidates = new Set<string>();
    const priorAttempts = Object.values(run.attempts)
      .filter((attempt) => attempt.ticketId === ticket.id && attempt.terminalOutputSha256 !== undefined)
      .sort((left, right) => compareText(left.id, right.id));
    for (const attempt of priorAttempts) {
      const step = ticket.workflow.find((candidate) => candidate.id === attempt.stepId);
      if (step === undefined || step.kind === "review") continue;
      const bytes = await readFile(path.join(
        this.#stateRoot,
        `runs/${run.id}/attempts/${attempt.id}/terminal-output.json`,
      ));
      if (
        bytes.byteLength !== attempt.terminalOutputSizeBytes ||
        rawSha256(bytes) !== attempt.terminalOutputSha256 ||
        bytes.byteLength > MAX_CONTEXT_BYTES ||
        bytes.includes(0)
      ) fail("review_effect_provenance", `terminal output for ${attempt.id} failed its authority binding`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(bytes.toString("utf8"));
      } catch {
        fail("review_effect_provenance", `terminal output for ${attempt.id} is not valid JSON`);
      }
      const output = parseAssignmentOutput(parsed, step.graph_mutation);
      if (output.status !== "completed" || output.graphDelta === undefined || output.graphDelta === null) continue;
      for (const mutation of output.graphDelta.upsertNodes) candidates.add(mutation.node.id);
      for (const edge of output.graphDelta.addEdges) candidates.add(edge.source);
    }
    if (candidates.size === 0) {
      for (const id of ticket.target_node_ids) candidates.add(id);
    }
    return [...candidates].sort(compareText);
  }

  async #readAttemptReceiptContext(
    run: RunRecord,
    attempt: AgentAttemptRecord,
  ): Promise<{ receiptIds: string[]; touchedFiles: string[] }> {
    const receiptIds = new Set<string>();
    const touchedFiles = new Set<string>();
    const expectedPrefix = `runs/${run.id}/attempts/${attempt.id}/tool-receipts/`;
    for (const record of [...(attempt.authorityToolResults ?? [])].sort((left, right) => left.sequence - right.sequence)) {
      if (
        !record.artifactPath.startsWith(expectedPrefix) ||
        path.posix.normalize(record.artifactPath) !== record.artifactPath
      ) fail("compaction_receipt_path", "authority tool result points outside its attempt receipt directory");
      const bytes = await readFile(path.join(this.#stateRoot, record.artifactPath));
      if (
        bytes.byteLength !== record.receiptSizeBytes ||
        rawSha256(bytes) !== record.receiptSha256 ||
        bytes.byteLength > 16 * 1024 * 1024 ||
        bytes.includes(0)
      ) fail("compaction_receipt_hash", "authority tool receipt bytes do not match their durable record");
      let parsed: unknown;
      try {
        parsed = JSON.parse(bytes.toString("utf8"));
      } catch {
        fail("compaction_receipt_json", "authority tool receipt is not valid JSON");
      }
      if (!isRecord(parsed) || typeof parsed.receiptId !== "string") {
        fail("compaction_receipt_shape", "authority tool receipt has an invalid shape");
      }
      receiptIds.add(parsed.receiptId);
      if (record.toolName === "koni_write_file" || record.toolName === "koni_edit_file") {
        const value = optionalRecord(parsed.value);
        if (typeof value?.path === "string" && value.path.trim().length > 0) touchedFiles.add(value.path);
      }
    }
    return {
      receiptIds: [...receiptIds].sort(compareText),
      touchedFiles: [...touchedFiles].sort(compareText),
    };
  }
}

function createPinnedArtifact(
  runId: string,
  configuration: CompiledConfiguration,
  skills: Record<string, PinnedSkill>,
  community: PinnedCommunityResourceBundle,
): PinnedConfigurationArtifact {
  const material: PinnedConfigurationMaterial = {
    protocol: PINNED_CONFIGURATION_PROTOCOL,
    runId,
    configuration,
    skills,
    community,
  };
  return deepFreeze({ ...structuredClone(material), artifactSha256: canonicalHash(material) });
}

function validatePinnedArtifact(value: unknown): PinnedConfigurationArtifact {
  if (!isRecord(value) || value.protocol !== PINNED_CONFIGURATION_PROTOCOL || !isRecord(value.configuration) || !isRecord(value.skills)) {
    fail("pinned_configuration_shape", "pinned run configuration has an invalid shape");
  }
  const artifact = value as unknown as PinnedConfigurationArtifact;
  if (canonicalHash(withoutField(artifact, "artifactSha256")) !== artifact.artifactSha256) {
    fail("pinned_configuration_hash", "pinned run configuration artifact hash does not match its bytes");
  }
  const configuration = artifact.configuration;
  if (canonicalHash(withoutField(configuration, "configuration_sha256")) !== configuration.configuration_sha256) {
    fail("configuration_hash", "pinned compiled configuration hash does not match its content");
  }
  for (const [id, skill] of Object.entries(artifact.skills)) {
    if (!isRecord(skill) || skill.id !== id || !isRecord(skill.files) || !Object.hasOwn(skill.files, "SKILL.md")) {
      fail("skill_hash", `pinned skill ${id} has an invalid package inventory`);
    }
    for (const [relativePath, rawFile] of Object.entries(skill.files)) {
      if (!isRecord(rawFile)) fail("skill_hash", `pinned skill ${id}/${relativePath} has invalid metadata`);
      const file = rawFile as unknown as PinnedSkillFile;
      if (
        file.relativePath !== relativePath ||
        normalizeResourcePath(relativePath) !== relativePath ||
        typeof file.content !== "string" ||
        file.sizeBytes !== Buffer.byteLength(file.content, "utf8") ||
        rawSha256(file.content) !== file.sha256
      ) {
        fail("skill_hash", `pinned skill ${id}/${relativePath} does not match its content hash`);
      }
    }
  }
  if (artifact.community !== undefined) {
    validatePinnedCommunityResourceBundle(artifact.community);
  }
  return deepFreeze(structuredClone(artifact)) as PinnedConfigurationArtifact;
}

function assertPinnedMatchesRun(artifact: PinnedConfigurationArtifact, run: RunRecord): void {
  if (artifact.runId !== run.id || artifact.configuration.configuration_sha256 !== run.compiledConfigHash) {
    fail("pinned_configuration_identity", "pinned configuration belongs to another run or compiler snapshot");
  }
}

async function pinConfiguredSkills(
  configuration: CompiledConfiguration,
  projectRoot: string,
): Promise<Record<string, PinnedSkill>> {
  const requested = new Set<string>();
  for (const persona of Object.values(configuration.registries.personas)) {
    const skills = persona.skills;
    if (skills === undefined) continue;
    if (!Array.isArray(skills) || skills.some((item) => typeof item !== "string" || !SAFE_LOCAL_KEY.test(item))) {
      fail("skill_configuration", "persona skills must be safe string identifiers");
    }
    for (const item of skills) requested.add(item as string);
  }
  const output: Record<string, PinnedSkill> = Object.create(null) as Record<string, PinnedSkill>;
  const configRoot = await realpath(path.join(projectRoot, ".koni"));
  let totalFiles = 0;
  let totalBytes = 0;
  for (const id of [...requested].sort(compareText)) {
    const skillRoot = path.join(configRoot, "resources", "skills", id);
    const metadata = await lstat(skillRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail("skill_directory", `skill ${id} is not a regular directory`);
    const canonical = await realpath(skillRoot);
    if (!isWithinDirectory(configRoot, canonical)) fail("skill_escape", `skill ${id} escapes .koni`);
    const files = await readSkillPackage(canonical, id);
    if (!Object.hasOwn(files, "SKILL.md")) fail("skill_file", `skill ${id} has no root SKILL.md`);
    totalFiles += Object.keys(files).length;
    totalBytes += Object.values(files).reduce((sum, file) => sum + file.sizeBytes, 0);
    if (totalFiles > MAX_SKILL_FILES || totalBytes > MAX_PINNED_SKILL_BYTES) {
      fail("skill_package_limit", "selected skill packages exceed the launch resource budget");
    }
    output[id] = { id, files };
  }
  return output;
}

async function readSkillPackage(
  skillRoot: string,
  skillId: string,
): Promise<Record<string, PinnedSkillFile>> {
  const output: Record<string, PinnedSkillFile> = Object.create(null) as Record<string, PinnedSkillFile>;
  const walk = async (directory: string, segments: string[]): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      if (
        entry.name.length === 0 ||
        entry.name === "." ||
        entry.name === ".." ||
        entry.name.includes("\u0000") ||
        entry.name.includes("/") ||
        entry.name.includes("\\")
      ) fail("skill_path", `skill ${skillId} contains an unsafe resource name`);
      const source = path.join(directory, entry.name);
      const metadata = await lstat(source);
      if (metadata.isSymbolicLink()) fail("skill_symlink", `skill ${skillId} contains a symbolic link`);
      if (metadata.isDirectory()) {
        await walk(source, [...segments, entry.name]);
        continue;
      }
      if (!metadata.isFile() || metadata.size < 1 || metadata.size > MAX_SKILL_FILE_BYTES) {
        fail("skill_file", `skill ${skillId} contains an empty, oversized, or non-regular resource`);
      }
      const canonical = await realpath(source);
      if (!isWithinDirectory(skillRoot, canonical)) fail("skill_escape", `skill ${skillId} resource escapes its package`);
      const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes: Buffer;
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
          fail("skill_race", `skill ${skillId} changed while it was pinned`);
        }
        bytes = await handle.readFile();
      } finally {
        await handle.close();
      }
      if (bytes.byteLength !== metadata.size) fail("skill_race", `skill ${skillId} changed while it was pinned`);
      const content = bytes.toString("utf8");
      if (!Buffer.from(content, "utf8").equals(bytes) || content.includes("\u0000")) {
        fail("skill_encoding", `skill ${skillId} resources must be non-NUL UTF-8 text`);
      }
      const relativePath = normalizeResourcePath([...segments, entry.name].join("/"));
      output[relativePath] = {
        relativePath,
        content,
        sha256: rawSha256(content),
        sizeBytes: bytes.byteLength,
      };
    }
  };
  await walk(skillRoot, []);
  return output;
}

function parseRunOverrides(
  value: JsonValue | undefined,
  configuration: CompiledConfiguration,
): {
  maxParallel?: number;
  questionPolicy?: "none" | "some" | "many";
  instructions?: string;
  workingSpecOwner?: string;
  agents: Record<string, { provider?: string; model?: string; thinkingLevel?: string }>;
  roles: Record<string, { provider?: string; model?: string; thinkingLevel?: string }>;
} {
  const output: {
    maxParallel?: number;
    questionPolicy?: "none" | "some" | "many";
    instructions?: string;
    workingSpecOwner?: string;
    agents: Record<string, { provider?: string; model?: string; thinkingLevel?: string }>;
    roles: Record<string, { provider?: string; model?: string; thinkingLevel?: string }>;
  } = {
    agents: Object.create(null) as Record<string, { provider?: string; model?: string; thinkingLevel?: string }>,
    roles: Object.create(null) as Record<string, { provider?: string; model?: string; thinkingLevel?: string }>,
  };
  if (value === undefined || value === null) return output;
  const source = requiredRecord(value, "run overrides");
  assertAllowedFields(source, ["maxParallel", "questionPolicy", "instructions", "workingSpecOwner", "agents", "roles"], "run overrides");
  if (source.maxParallel !== undefined) {
    if (!Number.isSafeInteger(source.maxParallel) || (source.maxParallel as number) < 1) fail("override_parallel", "maxParallel must be at least one");
    output.maxParallel = source.maxParallel as number;
  }
  if (source.questionPolicy !== undefined) {
    if (!["none", "some", "many"].includes(String(source.questionPolicy))) fail("override_questions", "questionPolicy must be none, some, or many");
    output.questionPolicy = source.questionPolicy as "none" | "some" | "many";
  }
  if (source.instructions !== undefined) output.instructions = boundedText(source.instructions, "run instructions", 1024 * 1024);
  if (source.workingSpecOwner !== undefined) {
    output.workingSpecOwner = requiredNonempty(source.workingSpecOwner, "working-spec owner override");
  }
  if (source.roles !== undefined) {
    const roles = requiredRecord(source.roles, "role overrides");
    const configuredRoles = new Set(Object.values(configuration.registries.personas)
      .map((persona) => optionalString(persona.model_role))
      .filter((role): role is string => role !== undefined));
    for (const [roleId, raw] of Object.entries(roles)) {
      if (!configuredRoles.has(roleId)) fail("override_role", `unknown override role ${roleId}`);
      output.roles[roleId] = parseAgentSelection(raw, `role override ${roleId}`, roleId);
    }
  }
  if (source.agents !== undefined) {
    const agents = requiredRecord(source.agents, "agent overrides");
    for (const [personaId, raw] of Object.entries(agents)) {
      if (configuration.registries.personas[personaId] === undefined) fail("override_persona", `unknown override persona ${personaId}`);
      output.agents[personaId] = parseAgentSelection(raw, `agent override ${personaId}`, personaId);
    }
  }
  return output;
}

function parseAgentSelection(
  value: unknown,
  label: string,
  identity: string,
): { provider?: string; model?: string; thinkingLevel?: string } {
  const item = requiredRecord(value, label);
  assertAllowedFields(item, ["provider", "model", "thinkingLevel"], label);
  const selected: { provider?: string; model?: string; thinkingLevel?: string } = {};
  if (item.provider !== undefined) selected.provider = boundedText(item.provider, `${identity} provider`, 256);
  if (item.model !== undefined) selected.model = boundedText(item.model, `${identity} model`, 512);
  if (item.thinkingLevel !== undefined) {
    selected.thinkingLevel = requireThinkingLevel(item.thinkingLevel, label);
  }
  return selected;
}

function mergeAgentSelection(
  role: { provider?: string; model?: string; thinkingLevel?: string } | undefined,
  persona: { provider?: string; model?: string; thinkingLevel?: string } | undefined,
): { provider?: string; model?: string; thinkingLevel?: string } | undefined {
  if (role === undefined) return persona;
  if (persona === undefined) return role;
  return { ...role, ...persona };
}

function resolveWorkingSpecOwner(
  configuration: CompiledConfiguration,
  runType: ConfigurationObject,
  explicitOverride: string | undefined,
): string {
  const runTypeOwner = optionalString(optionalRecord(runType.working_spec)?.owner);
  const changeControl = optionalRecord(configuration.profile.change_control);
  const profileOwner = optionalString(changeControl?.working_spec_owner);
  const explicit = [...new Set([explicitOverride, runTypeOwner, profileOwner].filter((value): value is string => value !== undefined))];
  if (explicit.length > 1) {
    fail("working_spec_owner_ambiguous", "working-spec owner configuration resolves to conflicting personas");
  }
  if (explicit.length === 1) {
    const owner = explicit[0]!;
    if (configuration.registries.personas[owner] === undefined) {
      fail("working_spec_owner_invalid", `configured working-spec owner ${owner} is not exactly one managed persona`);
    }
    return owner;
  }
  const leads = Object.entries(configuration.registries.personas)
    .filter(([, persona]) => optionalString(persona.model_role) === "lead")
    .map(([id]) => id)
    .sort(compareText);
  if (leads.length !== 1) {
    fail(
      "working_spec_owner_resolution",
      leads.length === 0
        ? "run creation requires exactly one managed persona with model_role lead"
        : `run creation found multiple managed lead personas: ${leads.join(", ")}`,
    );
  }
  return leads[0]!;
}

function pipelineDefinition(document: ConfigurationObject): { order: string[]; stages: ConfigurationObject } {
  const pipeline = requiredRecord(document.pipeline, "run pipeline");
  const stages = requiredRecord(pipeline.stages, "run pipeline stages");
  if (!Array.isArray(pipeline.order) || pipeline.order.length === 0) fail("pipeline_order", "run pipeline order is empty or invalid");
  const order = pipeline.order.map((item) => requiredNonempty(item, "pipeline stage id"));
  if (new Set(order).size !== order.length) fail("pipeline_order", "run pipeline contains duplicate stages");
  for (const id of order) if (!isRecord(stages[id])) fail("pipeline_stage", `run pipeline stage ${id} is missing`);
  return { order, stages: stages as ConfigurationObject };
}

function planningAttempt(run: RunRecord, runType: ConfigurationObject): AttemptDescriptor {
  const pipeline = pipelineDefinition(runType);
  const planning = pipeline.order.flatMap((id) => {
    const stage = requiredRecord(pipeline.stages[id], `pipeline stage ${id}`);
    if (stage.kind !== "planning") return [];
    const config = optionalRecord(stage.config) ?? {};
    return [{
      id,
      title: optionalString(stage.title) ?? id,
      persona: optionalString(config.persona) ?? "run-planner",
      prompt: optionalString(config.prompt) ?? "Produce the implementation-ready plan for this stage.",
    }];
  });
  if (planning.length === 0) {
    fail("planning_stage_missing", "this run type has no planning stage; the authority must use its direct-approval fast path");
  }
  const personas = new Set(planning.map((stage) => stage.persona));
  if (personas.size !== 1) fail("planning_persona", "one managed planning session cannot impersonate multiple personas");
  const stageId = planning.at(-1)!.id;
  const context = {
    protocol: "koni.attempt-context.v1",
    kind: "planning",
    run: { id: run.id, objective: run.objective, intake: run.intake, runTypeId: run.runTypeId },
    questionPolicy: run.executionConfig?.questionPolicy ?? "some",
    resolvedQuestions: answeredQuestionContext(run),
    stages: planning,
    instructions: run.executionConfig?.instructions ?? "",
    requiredOutput: {
      full: PLAN_DOMAINS,
      concise: "Each domain is an independently authored list of {title, description} items.",
      graphSeed: "Smallest valid root-connected typed semantic graph seed.",
    },
  };
  return {
    ticketId: "run-planning",
    stepId: stageId,
    personaId: planning[0]!.persona,
    readPaths: ["."],
    writePaths: [],
    readNodeIds: [],
    writeNodeIds: [],
    graphMutation: "forbidden",
    initialPrompt: [
      `Plan this ${run.runTypeId} run: ${run.objective}`,
      "Complete every configured planning concern in one bounded shared session.",
      "The final output must contain four complete Markdown plans (architecture, decisions, risk, verification), four separately written concise title/description item lists for human approval, and the exact typed graph seed. Do not derive mini-plan headings by truncating the full prose.",
    ].join("\n\n"),
    context,
    terminalSchema: planningTerminalSchema(),
  };
}

function ticketAttempt(
  run: RunRecord,
  definition: DerivedTicketDefinition,
  step: DerivedWorkflowStep,
  graph: TypedGraph,
): AttemptDescriptor {
  const readPaths = [...(step.read_paths ?? definition.scope.read_paths)];
  const writePaths = [...(step.write_paths ?? definition.scope.write_paths)];
  const readNodeIds = [...(step.read_node_ids ?? definition.scope.read_node_ids)];
  const writeNodeIds = [...(step.write_node_ids ?? definition.scope.write_node_ids)];
  const contextNodes = graph.nodes().filter((node) => new Set([...readNodeIds, ...writeNodeIds]).has(node.id));
  const durableTicket = run.tickets[definition.id];
  const reviewRework = durableTicket?.reviewReworks?.at(-1);
  const reopenIndex = definition.review_failure_reopen_from === undefined
    ? -1
    : definition.workflow.findIndex((candidate) => candidate.id === definition.review_failure_reopen_from);
  const stepIndex = definition.workflow.findIndex((candidate) => candidate.id === step.id);
  const activeReviewRework = reviewRework !== undefined && reopenIndex >= 0 && stepIndex >= reopenIndex
    ? reviewRework
    : undefined;
  return {
    ticketId: definition.id,
    stepId: step.id,
    personaId: step.persona_id,
    readPaths,
    writePaths,
    readNodeIds,
    writeNodeIds,
    graphMutation: step.graph_mutation,
    initialPrompt: [
      `Execute ${definition.title}.`,
      `Current step: ${step.id}.`,
      ...(step.expected_outputs.length === 0 ? [] : [`Expected result: ${step.expected_outputs.join("; ")}`]),
      ...(activeReviewRework === undefined
        ? []
        : [`This is bounded review rework ${activeReviewRework.ordinal}: ${activeReviewRework.blocker}`]),
      "Use the automatically injected authority context. Return a short outcome summary and only the graph delta permitted by this step. Do not author compiler-owned state.",
    ].join("\n\n"),
    context: {
      protocol: "koni.attempt-context.v1",
      kind: "ticket",
      run: { id: run.id, objective: run.objective, runTypeId: run.runTypeId },
      plan: run.plan?.full ?? {},
      resolvedQuestions: answeredQuestionContext(run),
      ticket: definition,
      step,
      ...(activeReviewRework === undefined ? {} : { reviewRework: activeReviewRework }),
      graph: contextNodes,
      scope: { readPaths, writePaths, readNodeIds, writeNodeIds },
    },
    terminalSchema: assignmentTerminalSchema(step.graph_mutation),
    definition,
    step,
    graph,
  };
}

function verificationAttempt(run: RunRecord, runType: ConfigurationObject, graph: TypedGraph): AttemptDescriptor {
  const pipeline = pipelineDefinition(runType);
  const review = pipeline.order.map((id) => ({ id, stage: requiredRecord(pipeline.stages[id], `stage ${id}`) }))
    .find(({ stage }) => stage.kind === "agent_review");
  const config = review === undefined ? undefined : optionalRecord(review.stage.config);
  const personaId = optionalString(config?.persona) ?? (run.executionConfig?.agents.verifier === undefined ? "reviewer" : "verifier");
  return {
    ticketId: "run-verification",
    stepId: review?.id ?? "verification",
    personaId,
    readPaths: ["."],
    writePaths: [],
    readNodeIds: graph.nodes().map((node) => node.id),
    writeNodeIds: [],
    graphMutation: "forbidden",
    initialPrompt: optionalString(config?.prompt) ?? "Independently verify the completed run against its approved plan and current evidence. Do not repair it.",
    context: {
      protocol: "koni.attempt-context.v1",
      kind: "verification",
      run: { id: run.id, objective: run.objective, runTypeId: run.runTypeId },
      plan: run.plan?.full ?? {},
      resolvedQuestions: answeredQuestionContext(run),
      graph: graph.nodes(),
      tickets: run.tickets,
    },
    terminalSchema: assignmentTerminalSchema("forbidden"),
    graph,
  };
}

function integrationDefinition(
  run: RunRecord,
  assignment: ReadyAssignment,
  configuration: CompiledConfiguration,
): DerivedTicketDefinition {
  const ticket = run.tickets[assignment.ticketId];
  if (ticket === undefined || ticket.operationId !== integrationOperation(configuration, run.runTypeId)) {
    fail("ticket_definition_missing", `ticket ${assignment.ticketId} has no pinned compiler definition`);
  }
  const material = {
    protocol: "koni.derived-ticket.v1" as const,
    id: ticket.id,
    rule_id: "compiler.target-integration",
    rule_phase: "promotion",
    rule_priority: 1_000,
    anchor_node_id: "target-ref",
    operation: ticket.operationId,
    operation_registry_id: ticket.operationId,
    operation_dispatch_priority: 1_000,
    ranking_hints: ["target-conflict"],
    title: ticket.title,
    target_node_ids: [],
    scope: { read_node_ids: [], write_node_ids: [], read_paths: ["."], write_paths: ["."] },
    source_state_key: "target-conflicted",
    target_state_key: "target-integrated",
    obligation_keys: ["target.integration"],
    workflow_id: "target-integration",
    workflow: [{
      id: assignment.stepId,
      kind: "integration" as const,
      persona_id: assignment.personaId,
      depends_on: [],
      required: true,
      read_paths: ["."],
      write_paths: ["."],
      expected_outputs: ["Conflict-free preservation of both target and run behavior"],
      graph_mutation: "forbidden" as const,
      required_receipts: [],
      escalation_triggers: [],
      stop_conditions: [],
      validation_checks: [],
      context_sha256: canonicalHash([ticket.id, assignment.stepId, run.compiledConfigHash]),
    }],
    configuration_sha256: configuration.configuration_sha256,
  };
  return deepFreeze({ ...material, definition_sha256: canonicalHash(material) });
}

function integrationOperation(configuration: CompiledConfiguration, runTypeId: string): string {
  const runType = requireValidation(resolveCompiledRunType(configuration, runTypeId), "run_type_invalid", "run type disappeared");
  return optionalString(optionalRecord(runType.document.promotion)?.conflict_operation) ?? "resolve-target-integration";
}

function planningTerminalSchema(): TSchema {
  const miniItem = Type.Object({
    title: Type.String({ minLength: 1, maxLength: 160 }),
    description: Type.String({ minLength: 1, maxLength: 1_200 }),
  }, { additionalProperties: false });
  const domains = Object.fromEntries(PLAN_DOMAINS.map((domain) => [domain, Type.String({ minLength: 1, maxLength: MAX_PLAN_CHARS })]));
  const concise = Object.fromEntries(PLAN_DOMAINS.map((domain) => [domain, Type.Array(miniItem, { minItems: 1, maxItems: 7 })]));
  return Type.Object({
    full: Type.Object(domains, { additionalProperties: false }),
    concise: Type.Object(concise, { additionalProperties: false }),
    graphSeed: graphSeedSchema(),
  }, { additionalProperties: false });
}

function graphSeedSchema(): TSchema {
  return Type.Object({
    rootSpec: Type.Record(Type.String({ minLength: 1, maxLength: 256 }), Type.Unknown()),
    nodes: Type.Array(Type.Object({
      key: Type.String({ minLength: 1, maxLength: 128 }),
      type: Type.String({ minLength: 1, maxLength: 128 }),
      title: Type.String({ minLength: 1, maxLength: 16_384 }),
      spec: Type.Record(Type.String({ minLength: 1, maxLength: 256 }), Type.Unknown()),
    }, { additionalProperties: false }), { maxItems: 1_024 }),
    edges: Type.Array(Type.Object({
      source: Type.String({ minLength: 1, maxLength: 128 }),
      relation: Type.String({ minLength: 1, maxLength: 128 }),
      target: Type.String({ minLength: 1, maxLength: 128 }),
    }, { additionalProperties: false }), { maxItems: 4_096 }),
  }, { additionalProperties: false });
}

function assignmentTerminalSchema(policy: DerivedWorkflowStep["graph_mutation"]): TSchema {
  const graphDelta = Type.Object({
    protocol: Type.Literal("koni.graph-delta.v1"),
    expectedGraphHash: Type.String({ pattern: "^sha256:[0-9a-f]{64}$" }),
    upsertNodes: Type.Array(Type.Object({
      node: Type.Object({
        schema_version: Type.Literal("1.0"),
        id: Type.String({ minLength: 1, maxLength: 128 }),
        type: Type.String({ minLength: 1, maxLength: 128 }),
        title: Type.String({ minLength: 1, maxLength: 16_384 }),
        status: Type.String({ minLength: 1, maxLength: 128 }),
        spec: Type.Record(Type.String({ minLength: 1, maxLength: 256 }), Type.Unknown()),
        edges: Type.Record(Type.String({ minLength: 1, maxLength: 128 }), Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { uniqueItems: true })),
        annotations: Type.Record(Type.String({ minLength: 1, maxLength: 256 }), Type.Unknown()),
      }, { additionalProperties: false }),
      expectedNodeHash: Type.Union([Type.String({ pattern: "^sha256:[0-9a-f]{64}$" }), Type.Null()]),
    }, { additionalProperties: false }), { maxItems: 1_024 }),
    deleteNodes: Type.Array(Type.Object({
      id: Type.String({ minLength: 1, maxLength: 128 }),
      expectedNodeHash: Type.String({ pattern: "^sha256:[0-9a-f]{64}$" }),
    }, { additionalProperties: false }), { maxItems: 1_024 }),
    addEdges: Type.Array(edgeSchema(), { maxItems: 4_096 }),
    removeEdges: Type.Array(edgeSchema(), { maxItems: 4_096 }),
  }, { additionalProperties: false });
  const completeFields: Record<string, TSchema> = {
    status: Type.Literal("completed"),
    summary: Type.String({ minLength: 1, maxLength: 1_024 }),
  };
  if (policy === "required") completeFields.graphDelta = graphDelta;
  else if (policy === "allowed") completeFields.graphDelta = Type.Optional(Type.Union([graphDelta, Type.Null()]));
  const complete = Type.Object(completeFields, { additionalProperties: false });
  const failed = Type.Object({
    status: Type.Literal("failed"),
    blocker: Type.String({ minLength: 1, maxLength: 64 * 1024 }),
  }, { additionalProperties: false });
  return Type.Union([complete, failed]);
}

function edgeSchema(): TSchema {
  return Type.Object({
    source: Type.String({ minLength: 1, maxLength: 128 }),
    relation: Type.String({ minLength: 1, maxLength: 128 }),
    target: Type.String({ minLength: 1, maxLength: 128 }),
  }, { additionalProperties: false });
}

function parsePlanningOutput(value: unknown): PlanningOutput {
  const root = requiredRecord(value, "planning output");
  assertExactFields(root, ["full", "concise", "graphSeed"], "planning output");
  const full = parsePlanTextRecord(requiredRecord(root.full, "full plans"), "full plans");
  const conciseSource = requiredRecord(root.concise, "concise plans");
  assertExactFields(conciseSource, PLAN_DOMAINS, "concise plans");
  const concise = Object.create(null) as Record<PlanDomain, { title: string; description: string }[]>;
  for (const domain of PLAN_DOMAINS) {
    const raw = conciseSource[domain];
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 7) fail("plan_concise_items", `${domain} requires one to seven concise items`);
    const titles = new Set<string>();
    concise[domain] = raw.map((item, index) => {
      const record = requiredRecord(item, `${domain} concise item ${index}`);
      assertExactFields(record, ["title", "description"], `${domain} concise item ${index}`);
      const title = boundedText(record.title, `${domain} concise title`, 160).trim();
      const description = boundedText(record.description, `${domain} concise description`, 1_200).trim();
      const key = title.toLocaleLowerCase("en-US");
      if (titles.has(key)) fail("plan_concise_duplicate", `${domain} contains duplicate concise title ${title}`);
      titles.add(key);
      return { title, description };
    });
  }
  return { full, concise, graphSeed: parsePlanningSeed(root.graphSeed) };
}

function parsePlanTextRecord(value: unknown, label: string): Record<PlanDomain, string> {
  const root = requiredRecord(value, label);
  assertExactFields(root, PLAN_DOMAINS, label);
  const output = Object.create(null) as Record<PlanDomain, string>;
  let total = 0;
  for (const domain of PLAN_DOMAINS) {
    const text = boundedText(root[domain], `${label}.${domain}`, MAX_PLAN_CHARS).trim();
    total += text.length;
    output[domain] = text;
  }
  if (total > 4 * MAX_PLAN_CHARS) fail("plan_size", "combined full plans exceed their bounded allowance");
  return output;
}

function parsePlanningSeed(value: unknown): PlanningGraphSeed {
  const root = requiredRecord(value, "graph seed");
  assertExactFields(root, ["rootSpec", "nodes", "edges"], "graph seed");
  const rootSpec = jsonRecord(root.rootSpec, "graph seed rootSpec");
  if (!Array.isArray(root.nodes) || root.nodes.length > 1_024) fail("graph_seed_nodes", "graph seed nodes are invalid or oversized");
  if (!Array.isArray(root.edges) || root.edges.length > 4_096) fail("graph_seed_edges", "graph seed edges are invalid or oversized");
  const keys = new Set<string>();
  const nodes = root.nodes.map((item, index) => {
    const node = requiredRecord(item, `graph seed node ${index}`);
    assertExactFields(node, ["key", "type", "title", "spec"], `graph seed node ${index}`);
    const key = requiredNonempty(node.key, "graph seed node key");
    if (!SAFE_LOCAL_KEY.test(key) || key === "$root" || keys.has(key)) fail("graph_seed_key", `invalid or duplicate graph seed key ${key}`);
    keys.add(key);
    return {
      key,
      type: requiredNonempty(node.type, `graph seed node ${key} type`),
      title: boundedText(node.title, `graph seed node ${key} title`, 16_384),
      spec: jsonRecord(node.spec, `graph seed node ${key} spec`),
    };
  });
  const edgeKeys = new Set<string>();
  const edges = root.edges.map((item, index) => {
    const edge = requiredRecord(item, `graph seed edge ${index}`);
    assertExactFields(edge, ["source", "relation", "target"], `graph seed edge ${index}`);
    const parsed = {
      source: requiredNonempty(edge.source, "graph seed edge source"),
      relation: requiredNonempty(edge.relation, "graph seed edge relation"),
      target: requiredNonempty(edge.target, "graph seed edge target"),
    };
    if ((parsed.source !== "$root" && !keys.has(parsed.source)) || (parsed.target !== "$root" && !keys.has(parsed.target))) {
      fail("graph_seed_edge_key", "graph seed edge references an unknown local key");
    }
    if (parsed.source === parsed.target) fail("graph_seed_self_edge", "graph seed edge may not self-reference");
    const identity = `${parsed.source}\u0000${parsed.relation}\u0000${parsed.target}`;
    if (edgeKeys.has(identity)) fail("graph_seed_edge_duplicate", "graph seed contains a duplicate relationship");
    edgeKeys.add(identity);
    return parsed;
  });
  if (Object.keys(rootSpec).length === 0 && nodes.length === 0) fail("graph_seed_empty", "graph seed must enrich the root or add at least one typed node");
  ensureSeedConnected(keys, edges);
  return { rootSpec, nodes, edges };
}

function compilePlanningSeed(
  configuration: CompiledConfiguration,
  run: RunRecord,
  seed: PlanningGraphSeed,
  fullPlan: Record<PlanDomain, string>,
): TypedGraph {
  const schema = requireGraphSchema(configuration);
  const initialization = requiredRecord(configuration.profile.initialization, "profile initialization");
  const rootType = requiredNonempty(initialization.root_node_type, "initialization root node type");
  const goalField = requiredNonempty(initialization.goal_field, "initialization goal field").replace(/^spec\./u, "");
  const contextField = (optionalString(initialization.planning_context_field) ?? "planning_context").replace(/^spec\./u, "");
  if (Object.hasOwn(seed.rootSpec, goalField) || Object.hasOwn(seed.rootSpec, contextField)) {
    fail("graph_seed_protected_root", "graph seed rootSpec may not replace the run goal or compiler planning context");
  }
  const operationId = requiredNonempty(initialization.planning_seed_operation, "planning seed operation");
  const operation = configuration.registries.operations[operationId];
  if (operation === undefined) fail("graph_seed_operation", `planning seed operation ${operationId} is missing`);
  const allowedTypes = new Set(stringArray(operation.allowed_new_node_types, "planning seed allowed node types"));
  const maximum = optionalSafeInteger(operation.max_new_nodes) ?? 1_024;
  if (seed.nodes.length > maximum) fail("graph_seed_node_limit", `graph seed exceeds operation limit ${maximum}`);
  const rootDefinition = schema.nodeTypes.get(rootType);
  if (rootDefinition === undefined) fail("graph_seed_root_type", `unknown root node type ${rootType}`);
  const rootId = `root-${digestBody(canonicalHash([run.id, rootType])).slice(0, 20)}`;
  const ids = new Map<string, string>([["$root", rootId]]);
  for (const node of seed.nodes) {
    if (!allowedTypes.has(node.type)) fail("graph_seed_node_type", `planning seed operation does not allow ${node.type}`);
    ids.set(node.key, `${node.type}-${digestBody(canonicalHash([run.id, node.key, node.type])).slice(0, 20)}`);
  }
  const nodes: GraphNode[] = [{
    schema_version: "1.0",
    id: rootId,
    type: rootType,
    title: run.objective,
    status: optionalString(initialization.root_status) ?? rootDefinition.initial_status,
    spec: {
      [goalField]: run.objective,
      ...structuredClone(seed.rootSpec),
      [contextField]: {
        protocol: "koni.approved-planning-context.v1",
        fullPlanSha256: canonicalHash(fullPlan),
        runTypeId: run.runTypeId,
      },
    },
    edges: {},
    annotations: {},
  }];
  for (const source of seed.nodes) {
    const definition = schema.nodeTypes.get(source.type)!;
    rejectCompilerOwnedSpec(definition.compiler_owned_fields ?? [], source.spec, `graph seed node ${source.key}`);
    nodes.push({
      schema_version: "1.0",
      id: ids.get(source.key)!,
      type: source.type,
      title: source.title,
      status: definition.initial_status,
      spec: structuredClone(source.spec),
      edges: {},
      annotations: {},
    });
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const edge of seed.edges) {
    const source = byId.get(ids.get(edge.source)!)!;
    const target = byId.get(ids.get(edge.target)!)!;
    const resolved = schema.resolveEdge(source.type, edge.relation, target.type);
    const canonicalSource = resolved.reversed ? target : source;
    const canonicalTarget = resolved.reversed ? source : target;
    const targets = canonicalSource.edges[resolved.definition.relation] ?? [];
    if (!targets.includes(canonicalTarget.id)) targets.push(canonicalTarget.id);
    targets.sort(compareText);
    canonicalSource.edges[resolved.definition.relation] = targets;
  }
  try {
    return new TypedGraph(schema, nodes);
  } catch (error) {
    if (error instanceof GraphValidationError) fail("graph_seed_invalid", "planning graph seed violates its typed schema", error.diagnostics);
    throw error;
  }
}

/**
 * Rust-era direct-approval runs intentionally approved the objective itself: no model plan and no
 * approved planning context were invented. The root-only graph is still fully schema validated so
 * the normal rule compiler can deterministically derive the first research/formulation tickets.
 */
function compileDirectInitialGraph(
  configuration: CompiledConfiguration,
  run: RunRecord,
): TypedGraph {
  const schema = requireGraphSchema(configuration);
  const initialization = requiredRecord(configuration.profile.initialization, "profile initialization");
  const rootType = requiredNonempty(initialization.root_node_type, "initialization root node type");
  const goalField = requiredNonempty(initialization.goal_field, "initialization goal field").replace(/^spec\./u, "");
  const rootDefinition = schema.nodeTypes.get(rootType);
  if (rootDefinition === undefined) fail("direct_approval_root_type", `unknown root node type ${rootType}`);
  const rootId = `root-${digestBody(canonicalHash([run.id, rootType])).slice(0, 20)}`;
  try {
    return new TypedGraph(schema, [{
      schema_version: "1.0",
      id: rootId,
      type: rootType,
      title: run.objective,
      status: optionalString(initialization.root_status) ?? rootDefinition.initial_status,
      spec: { [goalField]: run.objective },
      edges: {},
      annotations: { run_root: true },
    }]);
  } catch (error) {
    if (error instanceof GraphValidationError) {
      fail("direct_approval_graph_invalid", "direct-approval root violates its typed schema", error.diagnostics);
    }
    throw error;
  }
}

function validateAgentGraphDelta(
  configuration: CompiledConfiguration,
  graph: TypedGraph,
  ticket: DerivedTicketDefinition,
  step: DerivedWorkflowStep,
  delta: GraphDelta,
): void {
  if (delta.expectedGraphHash !== graph.hash) fail("graph_delta_cas", "agent graph delta targets a stale graph hash");
  const operation = configuration.registries.operations[ticket.operation_registry_id];
  if (operation === undefined && !ticket.rule_id.startsWith("compiler.")) fail("operation_missing", "ticket operation disappeared from pinned config");
  const writable = new Set(step.write_node_ids ?? ticket.scope.write_node_ids);
  const allowedNew = new Set(stringArray(operation?.allowed_new_node_types, "allowed new node types"));
  const allowedExisting = new Set(stringArray(operation?.allowed_existing_node_types, "allowed existing node types"));
  const schema = requireGraphSchema(configuration);
  let added = 0;
  for (const mutation of delta.upsertNodes) {
    const existing = graph.node(mutation.node.id);
    if (existing === undefined) {
      added += 1;
      if (!allowedNew.has(mutation.node.type)) fail("graph_delta_new_type", `operation cannot add ${mutation.node.type}`);
      const definition = schema.nodeTypes.get(mutation.node.type);
      if (definition === undefined || mutation.node.status !== definition.initial_status) {
        fail("graph_delta_new_status", "new graph nodes must carry the compiler-declared initial status");
      }
      rejectCompilerOwnedSpec(definition.compiler_owned_fields ?? [], mutation.node.spec, `new node ${mutation.node.id}`);
      if (Object.keys(mutation.node.edges).length > 0 || Object.keys(mutation.node.annotations).length > 0) {
        fail("graph_delta_embedded_state", "new node relationships and annotations must use dedicated authority tools/edge mutations");
      }
    } else {
      if (!writable.has(existing.id)) fail("graph_delta_write_scope", `node ${existing.id} is outside the step write scope`);
      if (allowedExisting.size > 0 && !allowedExisting.has(existing.type)) fail("graph_delta_existing_type", `operation cannot update ${existing.type}`);
      if (mutation.node.type !== existing.type || mutation.node.status !== existing.status) {
        fail("graph_delta_compiler_state", "agent graph deltas may not change node type or status");
      }
      if (canonicalHash(mutation.node.edges) !== canonicalHash(existing.edges) || canonicalHash(mutation.node.annotations) !== canonicalHash(existing.annotations)) {
        fail("graph_delta_embedded_state", "relationships and annotations must not be smuggled through a node upsert");
      }
      preserveCompilerOwnedSpec(schema.nodeTypes.get(existing.type)?.compiler_owned_fields ?? [], existing, mutation.node);
    }
  }
  const maximum = optionalSafeInteger(operation?.max_new_nodes) ?? 0;
  if (added > maximum) fail("graph_delta_new_limit", `operation permits at most ${maximum} new nodes`);
  if (delta.deleteNodes.length > 0 && operation?.allow_node_deletion !== true) fail("graph_delta_delete", "operation does not allow node deletion");
  for (const deletion of delta.deleteNodes) if (!writable.has(deletion.id)) fail("graph_delta_write_scope", `node ${deletion.id} is outside the step write scope`);
  if (delta.removeEdges.length > 0 && operation?.allow_edge_deletion !== true) fail("graph_delta_edge_delete", "operation does not allow relationship deletion");
  const addedIds = new Set(delta.upsertNodes.filter((item) => item.expectedNodeHash === null).map((item) => item.node.id));
  const projected = new Map(graph.nodes().map((node) => [node.id, node]));
  for (const item of delta.upsertNodes) projected.set(item.node.id, item.node);
  for (const edge of [...delta.addEdges, ...delta.removeEdges]) {
    const source = projected.get(edge.source);
    const target = projected.get(edge.target);
    if (source === undefined || target === undefined) fail("graph_delta_edge_node", "graph edge references a missing node");
    const resolved = schema.resolveEdge(source.type, edge.relation, target.type);
    const canonicalSourceId = resolved.reversed ? target.id : source.id;
    if (!writable.has(canonicalSourceId) && !addedIds.has(canonicalSourceId)) {
      fail("graph_delta_edge_scope", `relationship source ${canonicalSourceId} is outside the write scope`);
    }
  }
}

export async function applyReviewEffects(input: {
  configuration: CompiledConfiguration,
  graph: TypedGraph,
  ticket: DerivedTicketDefinition,
  step: DerivedWorkflowStep,
  reviewId: string,
  actor: string,
  candidateNodeIds: readonly string[],
  projectRoot: string,
  evidence?: RuleAuthorityEvidence,
}): Promise<{ graph: TypedGraph; changes: Array<{ kind: "modified"; nodeId: string; nodeType: string; title: string }> }> {
  const { configuration, graph, ticket, step } = input;
  if (step.kind !== "review") return { graph, changes: [] };
  const operation = configuration.registries.operations[ticket.operation_registry_id];
  if (operation === undefined || !Array.isArray(operation.review_effects)) return { graph, changes: [] };
  let current = graph;
  const changes: Array<{ kind: "modified"; nodeId: string; nodeType: string; title: string }> = [];
  for (const rawEffect of operation.review_effects) {
    const effect = requiredRecord(rawEffect, `review effect for ${ticket.id}`) as ConfigurationObject;
    if (effect.verdict !== "passed") continue;
    const select = requiredRecord(effect.select, "review effect selector");
    const nodeTypes = new Set(stringArray(select.node_types, "review effect node types"));
    const candidates = input.candidateNodeIds.map((id) => current.node(id)).filter((node): node is GraphNode =>
      node !== undefined && (nodeTypes.size === 0 || nodeTypes.has(node.type)) && predicateMatches(node, optionalRecord(select.predicate))
    );
    validateEffectCount(candidates.length, optionalRecord(effect.count));
    const preconditions = Array.isArray(effect.preconditions) ? effect.preconditions : [];
    for (const node of candidates) {
      for (const precondition of preconditions) {
        if (!predicateMatches(node, requiredRecord(precondition, "review effect precondition"))) {
          fail("review_effect_precondition", `review effect precondition failed for ${node.id}`);
        }
      }
    }
    await validateOperationReceiptCoverage({
      configuration,
      graph: current,
      operationId: ticket.operation_registry_id,
      operation,
      candidates,
      projectRoot: input.projectRoot,
      ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
    });
    await validateReviewEffectCoverage({
      configuration,
      graph: current,
      ticket,
      effect,
      candidates,
      projectRoot: input.projectRoot,
      ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
    });
    const set = requiredRecord(effect.set, "review effect set");
    for (const node of candidates) {
      const updated = structuredClone(node);
      for (const [field, value] of Object.entries(set)) {
        const resolved = resolveReviewEffectTokens(value, input.reviewId, input.actor);
        if (field === "status") updated.status = requiredNonempty(resolved, "review effect status");
        else if (field.startsWith("spec.")) setNestedSpec(updated.spec, field.slice("spec.".length), resolved);
        else fail("review_effect_field", `unsupported compiler review effect field ${field}`);
      }
      const applied = current.apply({
        protocol: "koni.graph-delta.v1",
        expectedGraphHash: current.hash,
        upsertNodes: [{ node: updated, expectedNodeHash: canonicalHash(node) }],
        deleteNodes: [],
        addEdges: [],
        removeEdges: [],
      });
      current = applied.graph;
      changes.push({ kind: "modified", nodeId: node.id, nodeType: node.type, title: node.title });
    }
  }
  return { graph: current, changes };
}

async function validateOperationReceiptCoverage(input: {
  configuration: CompiledConfiguration;
  graph: TypedGraph;
  operationId: string;
  operation: ConfigurationObject;
  candidates: readonly GraphNode[];
  projectRoot: string;
  evidence?: RuleAuthorityEvidence;
}): Promise<void> {
  if (input.operation.receipt_coverage === undefined) return;
  const leaves: ConfigurationObject[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isRecord(value)) return;
    if (value.op === "receipt_coverage_current" && value.receipt_coverage === input.operationId) {
      leaves.push(structuredClone(value) as ConfigurationObject);
    }
    for (const item of Object.values(value)) visit(item);
  };
  for (const query of Object.values(input.configuration.registries.queries)) visit(query);
  if (leaves.length !== 1) {
    fail(
      "review_effect_receipt_coverage",
      `operation ${input.operationId} must have exactly one configured current receipt-coverage predicate`,
    );
  }
  const adapter = await createProductionRuleDomainAdapter({
    configuration: input.configuration,
    graph: input.graph,
    projectRoot: input.projectRoot,
    ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
  });
  const evaluator = new GraphExpressionEvaluator(input.configuration, input.graph, adapter);
  for (const candidate of input.candidates) {
    const current = evaluator.withBinding("node", [candidate.id], () => evaluator.evaluate(leaves[0]!));
    if (!current) {
      fail(
        "review_effect_receipt_coverage",
        `review effect cannot promote ${candidate.id} without exact current authenticated receipt coverage`,
      );
    }
  }
}

function predicateMatches(node: GraphNode, predicate: Readonly<Record<string, unknown>> | undefined): boolean {
  if (predicate === undefined) return true;
  const field = requiredNonempty(predicate.field, "effect predicate field");
  const operation = requiredNonempty(predicate.op, "effect predicate op");
  const value = graphField(node, field);
  if (operation === "equals") return canonicalHash(value ?? null) === canonicalHash(predicate.value ?? null);
  if (operation === "present") return value !== undefined;
  if (operation === "absent") return value === undefined;
  if (operation === "non_empty") return isNonemptyConfigurationValue(value);
  fail("review_effect_predicate", `unsupported review effect predicate ${operation}`);
}

async function validateReviewEffectCoverage(input: {
  configuration: CompiledConfiguration;
  graph: TypedGraph;
  ticket: DerivedTicketDefinition;
  effect: ConfigurationObject;
  candidates: readonly GraphNode[];
  projectRoot: string;
  evidence?: RuleAuthorityEvidence;
}): Promise<void> {
  if (!Array.isArray(input.effect.coverage) || input.effect.coverage.length === 0) return;
  const adapter = await createProductionRuleDomainAdapter({
    configuration: input.configuration,
    graph: input.graph,
    projectRoot: input.projectRoot,
    ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
  });
  const evaluator = new GraphExpressionEvaluator(input.configuration, input.graph, adapter);
  evaluator.bind("target", input.ticket.target_node_ids);
  for (const candidate of input.candidates) {
    evaluator.withBinding("candidate", [candidate.id], () => {
      for (const rawCoverage of input.effect.coverage as ConfigurationValue[]) {
        const coverage = requiredRecord(rawCoverage, "review effect coverage") as ConfigurationObject;
        const coverageId = requiredNonempty(coverage.id, "review effect coverage id");
        const requiredSelector = coverage.required;
        if (requiredSelector === undefined) {
          fail("review_effect_coverage", `review effect coverage ${coverageId} has no required selector`);
        }
        const requiredIds = new Set(evaluator.select(requiredSelector!));
        const actual = requiredRecord(coverage.actual, `review effect coverage ${coverageId} actual`) as ConfigurationObject;
        const actualIds = reviewEffectActualIds(candidate, actual, coverageId);
        const missing = [...requiredIds].filter((id) => !actualIds.has(id)).sort(compareText);
        const extra = [...actualIds].filter((id) => !requiredIds.has(id)).sort(compareText);
        if (missing.length > 0 || extra.length > 0) {
          fail(
            "review_effect_coverage",
            `review effect coverage ${coverageId} is not exact; missing [${missing.join(", ")}], extra [${extra.join(", ")}]`,
          );
        }
      }
    });
  }
}

function reviewEffectActualIds(
  candidate: GraphNode,
  actual: ConfigurationObject,
  coverageId: string,
): Set<string> {
  const kind = requiredNonempty(actual.kind, `review effect coverage ${coverageId} actual kind`);
  if (kind === "outgoing_relation") {
    const relation = requiredNonempty(actual.relation, `review effect coverage ${coverageId} relation`);
    return strictReviewIdSet(candidate.edges[relation] ?? [], coverageId);
  }
  const field = requiredNonempty(actual.field, `review effect coverage ${coverageId} field`);
  const value = graphField(candidate, field);
  if (kind === "field_value") {
    return strictReviewIdSet([requiredNonempty(value, `review effect coverage ${coverageId} field ${field}`)], coverageId);
  }
  if (kind === "field_values") {
    if (!Array.isArray(value)) fail("review_effect_coverage", `review effect coverage ${coverageId} field ${field} is not a list`);
    return strictReviewIdSet(value.map((item) => requiredNonempty(item, `review effect coverage ${coverageId} field ${field}`)), coverageId);
  }
  if (kind === "object_keys") {
    if (!isRecord(value)) fail("review_effect_coverage", `review effect coverage ${coverageId} field ${field} is not an object`);
    const allowed = Array.isArray(actual.allowed_values) ? actual.allowed_values : [];
    if (allowed.length > 0) {
      for (const [id, disposition] of Object.entries(value)) {
        if (!allowed.some((item) => canonicalHash(item) === canonicalHash(disposition))) {
          fail("review_effect_coverage", `review effect coverage ${coverageId} has an invalid disposition for ${id}`);
        }
      }
    }
    return strictReviewIdSet(Object.keys(value), coverageId);
  }
  fail("review_effect_coverage", `review effect coverage ${coverageId} has unsupported actual kind ${kind}`);
}

function strictReviewIdSet(values: readonly string[], coverageId: string): Set<string> {
  if (values.some((value) => value.trim().length === 0)) {
    fail("review_effect_coverage", `review effect coverage ${coverageId} contains an empty node id`);
  }
  const output = new Set(values);
  if (output.size !== values.length) {
    fail("review_effect_coverage", `review effect coverage ${coverageId} contains duplicate node ids`);
  }
  return output;
}

function resolveReviewEffectTokens(value: unknown, reviewId: string, actor: string): JsonValue {
  if (value === "$review.id") return reviewId;
  if (value === "$actor") return actor;
  if (typeof value === "string" && value.startsWith("$")) {
    fail("review_effect_token", `unknown review effect compiler token ${value}`);
  }
  if (Array.isArray(value)) return value.map((item) => resolveReviewEffectTokens(item, reviewId, actor));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveReviewEffectTokens(item, reviewId, actor)]));
  }
  assertJsonValue(value, "review effect value");
  return value as JsonValue;
}

function isNonemptyConfigurationValue(value: JsonValue | undefined): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return value !== undefined && value !== null;
}

function validateEffectCount(actual: number, count: ConfigurationObject | undefined): void {
  if (count === undefined) return;
  const exact = optionalSafeInteger(count.exact);
  const min = optionalSafeInteger(count.min);
  const max = optionalSafeInteger(count.max);
  if ((exact !== undefined && actual !== exact) || (min !== undefined && actual < min) || (max !== undefined && actual > max)) {
    fail("review_effect_count", `review effect selected ${actual} nodes outside its configured count`);
  }
}

function graphField(node: GraphNode, field: string): JsonValue | undefined {
  if (field === "status") return node.status;
  const segments = field.replace(/^spec\./u, "").split(".");
  let value: unknown = node.spec;
  for (const segment of segments) {
    if (!isRecord(value)) return undefined;
    value = value[segment];
  }
  return value as JsonValue | undefined;
}

function setNestedSpec(spec: Record<string, JsonValue>, field: string, value: JsonValue): void {
  const segments = field.split(".");
  let cursor: Record<string, JsonValue> = spec;
  for (const segment of segments.slice(0, -1)) {
    const child = cursor[segment];
    if (!isRecord(child)) cursor[segment] = {};
    cursor = cursor[segment] as Record<string, JsonValue>;
  }
  cursor[segments.at(-1)!] = structuredClone(value);
}

function parseAssignmentOutput(value: unknown, policy: DerivedWorkflowStep["graph_mutation"]): AssignmentOutput {
  const root = requiredRecord(value, "assignment output");
  if (root.status === "failed") {
    assertExactFields(root, ["status", "blocker"], "failed assignment output");
    return { status: "failed", blocker: boundedText(root.blocker, "assignment blocker", 64 * 1024) };
  }
  if (root.status !== "completed") fail("assignment_status", "assignment status must be completed or failed");
  const allowed = policy === "forbidden" ? ["status", "summary"] : ["status", "summary", "graphDelta"];
  assertAllowedFields(root, allowed, "completed assignment output");
  const summary = boundedText(root.summary, "assignment summary", 1_024).trim();
  const graphDelta = root.graphDelta === undefined || root.graphDelta === null
    ? root.graphDelta as undefined | null
    : parseGraphDelta(root.graphDelta);
  if (policy === "required" && (graphDelta === undefined || graphDelta === null)) fail("graph_delta_required", "assignment requires a graph delta");
  if (policy === "forbidden" && graphDelta !== undefined) fail("graph_delta_forbidden", "assignment forbids graph mutation");
  return { status: "completed", summary, ...(graphDelta === undefined ? {} : { graphDelta }) };
}

function assertCurrentAssignmentChecks(
  run: RunRecord,
  assignment: ReadyAssignment,
  attemptId: string,
  step: DerivedWorkflowStep,
): void {
  if (step.validation_checks.length === 0) return;
  const attempt = run.attempts[attemptId];
  if (
    attempt === undefined ||
    attempt.ticketId !== assignment.ticketId ||
    attempt.stepId !== assignment.stepId ||
    attempt.personaId !== assignment.personaId
  ) {
    fail("assignment_check_provenance", "configured checks are not bound to the current assignment attempt");
  }
  const missing = step.validation_checks.filter((checkId) => !(run.checks ?? []).some((check) =>
    check.attemptId === attemptId &&
    check.requestedCheckId === checkId &&
    check.accepted &&
    check.passed === true
  ));
  if (missing.length > 0) {
    fail(
      "assignment_checks_incomplete",
      `assignment cannot complete without current passing configured checks: ${missing.join(", ")}`,
    );
  }
}

function parseGraphDelta(value: unknown): GraphDelta {
  const root = requiredRecord(value, "graph delta");
  assertExactFields(root, ["protocol", "expectedGraphHash", "upsertNodes", "deleteNodes", "addEdges", "removeEdges"], "graph delta");
  if (root.protocol !== "koni.graph-delta.v1") fail("graph_delta_protocol", "unsupported graph delta protocol");
  const expectedGraphHash = requireDigest(root.expectedGraphHash, "graph delta expectedGraphHash");
  if (!Array.isArray(root.upsertNodes) || !Array.isArray(root.deleteNodes) || !Array.isArray(root.addEdges) || !Array.isArray(root.removeEdges)) {
    fail("graph_delta_shape", "graph delta mutation collections must be arrays");
  }
  const upsertNodes = root.upsertNodes.map((item, index) => {
    const mutation = requiredRecord(item, `graph upsert ${index}`);
    assertExactFields(mutation, ["node", "expectedNodeHash"], `graph upsert ${index}`);
    return {
      node: parseGraphNode(mutation.node),
      expectedNodeHash: mutation.expectedNodeHash === null ? null : requireDigest(mutation.expectedNodeHash, "expected node hash"),
    };
  });
  const deleteNodes = root.deleteNodes.map((item, index) => {
    const deletion = requiredRecord(item, `graph deletion ${index}`);
    assertExactFields(deletion, ["id", "expectedNodeHash"], `graph deletion ${index}`);
    return { id: requiredNonempty(deletion.id, "graph deletion id"), expectedNodeHash: requireDigest(deletion.expectedNodeHash, "expected node hash") };
  });
  return {
    protocol: "koni.graph-delta.v1",
    expectedGraphHash,
    upsertNodes,
    deleteNodes,
    addEdges: root.addEdges.map(parseGraphEdge),
    removeEdges: root.removeEdges.map(parseGraphEdge),
  };
}

function parseGraphNode(value: unknown): GraphNode {
  const node = requiredRecord(value, "graph node");
  assertExactFields(node, ["schema_version", "id", "type", "title", "status", "spec", "edges", "annotations"], "graph node");
  if (node.schema_version !== "1.0") fail("graph_node_schema", "graph node schema_version must be 1.0");
  const edgesSource = requiredRecord(node.edges, "graph node edges");
  const edges: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  for (const [relation, targets] of Object.entries(edgesSource)) {
    if (!Array.isArray(targets) || targets.some((target) => typeof target !== "string")) fail("graph_node_edges", `graph relation ${relation} must contain string ids`);
    edges[relation] = [...new Set(targets as string[])].sort(compareText);
  }
  return {
    schema_version: "1.0",
    id: requiredNonempty(node.id, "graph node id"),
    type: requiredNonempty(node.type, "graph node type"),
    title: boundedText(node.title, "graph node title", 16_384),
    status: requiredNonempty(node.status, "graph node status"),
    spec: jsonRecord(node.spec, "graph node spec"),
    edges,
    annotations: jsonRecord(node.annotations, "graph node annotations"),
  };
}

function parseGraphEdge(value: unknown): { source: string; relation: string; target: string } {
  const edge = requiredRecord(value, "graph edge");
  assertExactFields(edge, ["source", "relation", "target"], "graph edge");
  return {
    source: requiredNonempty(edge.source, "graph edge source"),
    relation: requiredNonempty(edge.relation, "graph edge relation"),
    target: requiredNonempty(edge.target, "graph edge target"),
  };
}

function reconcileTickets(
  run: RunRecord,
  definitions: readonly DerivedTicketDefinition[],
  at: string,
): Record<string, TicketRecord> {
  const tickets = structuredClone(run.tickets);
  for (const definition of definitions) {
    const existing = tickets[definition.id];
    if (existing !== undefined) {
      assertTicketDefinitionStable(existing, definition);
      for (const [index, step] of existing.steps.entries()) {
        step.kind ??= definition.workflow[index]!.kind;
      }
      if (definition.review_failure_reopen_from !== undefined) {
        existing.reviewFailureReopenFrom ??= definition.review_failure_reopen_from;
        existing.reviewReworkLimit ??= 1;
        existing.reviewReworkCount ??= 0;
        existing.reviewReworks ??= [];
      }
      continue;
    }
    if (definition.workflow.length === 0) fail("ticket_workflow", `derived ticket ${definition.id} has no executable workflow`);
    tickets[definition.id] = {
      id: definition.id,
      operationId: definition.operation_registry_id,
      title: definition.title,
      summary: `${definition.operation}: ${definition.title}`,
      status: "ready",
      priority: -(definition.rule_priority * 1_000 + definition.operation_dispatch_priority),
      dependencyIds: [],
      targetNodeIds: [...definition.target_node_ids],
      readPaths: [...definition.scope.read_paths],
      writePaths: [...definition.scope.write_paths],
      steps: definition.workflow.map((step) => ({
        id: step.id,
        title: humanize(step.id),
        personaId: step.persona_id,
        kind: step.kind,
        status: "pending",
        attemptIds: [],
        summary: undefined,
        startedAt: undefined,
        completedAt: undefined,
      })),
      ...(definition.review_failure_reopen_from === undefined
        ? {}
        : {
            reviewFailureReopenFrom: definition.review_failure_reopen_from,
            reviewReworkLimit: 1,
            reviewReworkCount: 0,
            reviewReworks: [],
          }),
      worktreePath: undefined,
      branch: undefined,
      blocker: undefined,
      createdAt: at,
      updatedAt: at,
    };
  }
  return Object.fromEntries(Object.entries(tickets).sort(([left], [right]) => compareText(left, right)));
}

function assertTicketDefinitionStable(ticket: TicketRecord, definition: DerivedTicketDefinition): void {
  if (
    ticket.operationId !== definition.operation_registry_id ||
    ticket.title !== definition.title ||
    canonicalHash(ticket.targetNodeIds) !== canonicalHash(definition.target_node_ids) ||
    canonicalHash(ticket.readPaths) !== canonicalHash(definition.scope.read_paths) ||
    canonicalHash(ticket.writePaths) !== canonicalHash(definition.scope.write_paths) ||
    canonicalHash(ticket.steps.map((step) => [step.id, step.personaId])) !== canonicalHash(definition.workflow.map((step) => [step.id, step.persona_id])) ||
    ticket.steps.some((step, index) =>
      step.kind !== undefined && step.kind !== definition.workflow[index]!.kind) ||
    (ticket.reviewFailureReopenFrom !== undefined &&
      ticket.reviewFailureReopenFrom !== definition.review_failure_reopen_from)
  ) fail("ticket_definition_drift", `ticket ${ticket.id} changed under the same deterministic identity`);
}

function runRootContextId(runId: string): string {
  return `run-root-${digestBody(canonicalHash(runId)).slice(0, 20)}`;
}

function initialGraphArtifact(
  runId: string,
  configuration: CompiledConfiguration,
  ownerPersonaId: string,
): GraphArtifact {
  const graph = new TypedGraph(requireGraphSchema(configuration), []);
  return {
    protocol: GRAPH_ARTIFACT_PROTOCOL,
    runId,
    revision: 0,
    semanticRevision: 0,
    configurationSha256: configuration.configuration_sha256,
    graphSha256: graph.hash,
    semanticSha256: graph.hash,
    nodes: graph.toJSON(),
    ...contextualArtifactFields(createGraphContextualState(runRootContextId(runId), ownerPersonaId)),
  };
}

function appendContextualRecord(
  prior: GraphContextualState,
  record: GraphContextualRecord,
  links: readonly GraphContextualLink[],
  update: { canonicalWorkingSpecId?: string; ownerPersonaId?: string } = {},
): GraphContextualState {
  if (prior.records[record.id] !== undefined) {
    fail("contextual_record_exists", `contextual graph record ${record.id} already exists`);
  }
  const records = structuredClone(prior.records);
  records[record.id] = structuredClone(record);
  if (Object.keys(records).length > MAX_GRAPH_NOTES) {
    fail("contextual_record_limit", `run contextual record inventory exceeds ${MAX_GRAPH_NOTES}`);
  }
  const allLinks = [...structuredClone(prior.links), ...structuredClone(links)]
    .sort((left, right) =>
      compareText(left.sourceId, right.sourceId) ||
      compareText(left.relation, right.relation) ||
      compareText(left.targetKind, right.targetKind) ||
      compareText(left.targetId, right.targetId));
  const next = sealGraphContextualState({
    protocol: prior.protocol,
    revision: prior.revision + 1,
    runRootId: prior.runRootId,
    ...((update.ownerPersonaId ?? prior.ownerPersonaId) === undefined
      ? {}
      : { ownerPersonaId: update.ownerPersonaId ?? prior.ownerPersonaId }),
    ...((update.canonicalWorkingSpecId ?? prior.canonicalWorkingSpecId) === undefined
      ? {}
      : { canonicalWorkingSpecId: update.canonicalWorkingSpecId ?? prior.canonicalWorkingSpecId }),
    records,
    links: allLinks,
  });
  if (Buffer.byteLength(canonicalEncode(next), "utf8") > MAX_RUN_GRAPH_BYTES - 1024 * 1024) {
    fail("contextual_graph_size", "contextual graph state exceeds its durable artifact bound");
  }
  return next;
}

function graphArtifact(
  run: RunRecord,
  configuration: CompiledConfiguration,
  graph: TypedGraph,
  revision: number,
  contextual?: GraphContextualState,
): GraphArtifact {
  return {
    protocol: GRAPH_ARTIFACT_PROTOCOL,
    runId: run.id,
    revision,
    semanticRevision: revision,
    configurationSha256: configuration.configuration_sha256,
    graphSha256: graph.hash,
    semanticSha256: graph.hash,
    nodes: graph.toJSON(),
    ...(contextual === undefined ? {} : contextualArtifactFields(contextual)),
  };
}

function contextualArtifactFields(contextual: GraphContextualState): {
  contextual: GraphContextualState;
  contextualRevision: number;
  contextualSha256: Sha256Digest;
} {
  return {
    contextual: structuredClone(contextual),
    contextualRevision: contextual.revision,
    contextualSha256: contextual.hash,
  };
}

function parseGraphArtifact(bytes: Buffer): GraphArtifact {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_RUN_GRAPH_BYTES || bytes.includes(0)) {
    fail("graph_artifact_size", "graph artifact is empty, oversized, or contains NUL");
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("graph_artifact_json", "graph artifact is not valid JSON");
  }
  if (
    !isRecord(value) ||
    value.protocol !== GRAPH_ARTIFACT_PROTOCOL ||
    typeof value.runId !== "string" ||
    !Number.isSafeInteger(value.revision) ||
    !isSha256Digest(value.configurationSha256) ||
    !isSha256Digest(value.graphSha256) ||
    !isRecord(value.nodes)
  ) {
    fail("graph_artifact_shape", "graph artifact has an unsupported shape");
  }
  const artifact = value as unknown as GraphArtifact;
  if (
    (artifact.semanticRevision !== undefined && artifact.semanticRevision !== artifact.revision) ||
    (artifact.semanticSha256 !== undefined && artifact.semanticSha256 !== artifact.graphSha256)
  ) fail("graph_artifact_semantic_alias", "graph artifact semantic aliases disagree with legacy fields");
  if (
    artifact.contextual === undefined
      ? artifact.contextualRevision !== undefined || artifact.contextualSha256 !== undefined
      : (artifact.contextualRevision !== undefined || artifact.contextualSha256 !== undefined) &&
        (artifact.contextualRevision !== artifact.contextual.revision || artifact.contextualSha256 !== artifact.contextual.hash)
  ) fail("graph_artifact_contextual_alias", "graph artifact contextual aliases disagree with contextual state");
  if (artifact.contextual !== undefined) {
    try {
      validateGraphContextualState(artifact.contextual);
    } catch (error) {
      fail("graph_contextual_state", error instanceof Error ? error.message : String(error));
    }
  }
  return artifact;
}

function ticketArtifact(run: RunRecord, graphRevision: number, evaluation: CompiledRuleEvaluation): TicketDefinitionsArtifact {
  return { protocol: TICKET_ARTIFACT_PROTOCOL, runId: run.id, graphRevision, evaluation };
}

function requireGraphSchema(configuration: CompiledConfiguration): GraphSchema {
  const definition = requireValidation(
    projectGraphSchemaDefinition(configuration),
    "graph_schema_invalid",
    "compiled profile graph schema is invalid",
  );
  return new GraphSchema(definition);
}

function launchResources(
  pinned: PinnedConfigurationArtifact,
  skillIds: readonly string[],
  runInstructions: string,
  communityResources: readonly LaunchResource[] = [],
): LaunchResource[] {
  const resources: LaunchResource[] = [];
  for (const id of [...new Set(skillIds)].sort(compareText)) {
    const skill = pinned.skills[id];
    if (skill === undefined) fail("skill_unpinned", `persona requested unpinned skill ${id}`);
    for (const [relativePath, file] of Object.entries(skill.files).sort(([left], [right]) => compareText(left, right))) {
      const resourceId = relativePath === "SKILL.md"
        ? `skill-${id}`
        : `skill-${id}-${digestBody(rawSha256(relativePath)).slice(0, 16)}`;
      resources.push(resource("skill", resourceId, `skills/${id}/${relativePath}`, file.content));
    }
  }
  if (runInstructions.trim().length > 0) {
    resources.push(resource("append_system_prompt", "run-instructions", "prompts/run-instructions.md", runInstructions.trim()));
  }
  resources.push(...structuredClone(communityResources));
  return resources.sort((left, right) => compareText(`${left.id}\0${left.relativePath}`, `${right.id}\0${right.relativePath}`));
}

function resource(kind: LaunchResource["kind"], id: string, relativePath: string, content: string): LaunchResource {
  return { kind, id, relativePath, content, sha256: rawSha256(content), sizeBytes: Buffer.byteLength(content, "utf8") };
}

function toolInventory(
  run: RunRecord,
  descriptor: AttemptDescriptor,
  resources: readonly LaunchResource[],
  communityTools: readonly KoniToolName[] = [],
): KoniToolName[] {
  const names = new Set<KoniToolName>(["koni_context"]);
  if (resources.some((entry) =>
    entry.kind === "prompt" ||
    (entry.kind === "skill" && path.posix.basename(entry.relativePath) !== "SKILL.md"))) {
    names.add("koni_read_resource");
  }
  if (descriptor.graph !== undefined) names.add("koni_graph_context");
  if ((descriptor.step?.validation_checks.length ?? 0) > 0) names.add("koni_run_check");
  if (descriptor.readPaths.length > 0) {
    names.add("koni_read_file");
    names.add("koni_list_files");
    names.add("koni_search_files");
  }
  if (descriptor.writePaths.length > 0) {
    names.add("koni_write_file");
    names.add("koni_edit_file");
  }
  // Contextual notes do not grant semantic graph authority; every managed persona may append one
  // to a compiler-visible node or the stable run root.
  names.add("koni_record_note");
  if (run.workingSpecOwnerId === descriptor.personaId) names.add("koni_update_working_spec");
  if ((run.executionConfig?.questionPolicy ?? "some") !== "none") names.add("koni_ask_question");
  for (const name of communityTools) {
    if (name === "koni_submit_output") fail("community_terminal_tool", "community adapters cannot select the terminal tool");
    names.add(name);
  }
  names.add("koni_submit_output");
  return KONI_TOOL_NAMES.filter((name) => names.has(name));
}

function communityAttemptStageIds(
  kind: "planning" | "ticket" | "verification" | "integration",
  descriptor: AttemptDescriptor,
  configuration: CompiledConfiguration,
  runType: ConfigurationObject,
): string[] {
  const stages = new Set<string>([kind, descriptor.stepId]);
  if (kind === "planning") {
    const pipeline = pipelineDefinition(runType);
    for (const stageId of pipeline.order) {
      const stage = requiredRecord(pipeline.stages[stageId], `pipeline stage ${stageId}`);
      if (stage.kind === "planning") stages.add(stageId);
    }
  } else if (kind === "ticket") {
    stages.add("orchestrate");
    const operationId = descriptor.definition?.operation_registry_id;
    const operation = operationId === undefined ? undefined : configuration.registries.operations[operationId];
    const configuredStage = operation === undefined ? undefined : optionalString(operation.stage);
    if (configuredStage !== undefined) stages.add(configuredStage.replaceAll("_", "-"));
  } else if (kind === "verification") {
    stages.add("verification");
  } else {
    stages.add("orchestrate");
    stages.add("integration");
  }
  return [...stages].sort(compareText);
}

function requireKoniToolName(value: string): KoniToolName {
  if (!(KONI_TOOL_NAMES as readonly string[]).includes(value)) {
    fail("recovery_tool", `stored launch spec names unknown Koni tool ${value}`);
  }
  return value as KoniToolName;
}

function assertRecoveryIdentity(
  run: RunRecord,
  attempt: AgentAttemptRecord,
  spec: Readonly<AgentLaunchSpec>,
): void {
  if (
    attempt.launchSpecHash !== spec.specHash ||
    spec.identity.runId !== run.id ||
    spec.identity.attemptId !== attempt.id ||
    spec.identity.sessionId !== attempt.sessionId ||
    spec.identity.ticketId !== attempt.ticketId ||
    spec.identity.stepId !== attempt.stepId ||
    spec.persona.id !== attempt.personaId ||
    spec.authority.generation !== run.generation
  ) fail("recovery_identity", "stored launch spec does not match its durable attempt record");
}

function recoveredAttemptKind(
  run: RunRecord,
  attempt: AgentAttemptRecord,
): "planning" | "ticket" | "verification" | "integration" {
  if (attempt.kind !== undefined) return attempt.kind;
  if (attempt.ticketId === "run-planning") return "planning";
  if (attempt.ticketId === "run-verification") return "verification";
  if (run.tickets[attempt.ticketId]?.id.startsWith("TK-integration-") === true) return "integration";
  return "ticket";
}

function assignmentFromAttempt(run: RunRecord, attempt: AgentAttemptRecord): ReadyAssignment {
  const ticket = run.tickets[attempt.ticketId];
  const step = ticket?.steps.find((candidate) => candidate.id === attempt.stepId);
  if (ticket === undefined || step === undefined || step.personaId !== attempt.personaId) {
    fail("recovery_assignment", "durable attempt no longer has its exact ticket assignment");
  }
  return {
    runId: run.id,
    ticketId: ticket.id,
    stepId: step.id,
    personaId: step.personaId,
    priority: ticket.priority,
  };
}

function toolExecutionMode(name: KoniToolName): "sequential" | "parallel" {
  return new Set<KoniToolName>([
    "koni_context",
    "koni_read_resource",
    "koni_graph_context",
    "koni_read_file",
    "koni_list_files",
    "koni_search_files",
  ]).has(name)
    ? "parallel"
    : "sequential";
}

function compactionSnapshot(run: RunRecord, descriptor: AttemptDescriptor): KoniCompactionSnapshot {
  const full = run.plan?.full ?? {};
  return {
    objective: run.objective,
    plan: {
      architecture: full.architecture ?? "Planning is still in progress.",
      decisions: full.decisions ?? "Planning is still in progress.",
      risk: full.risk ?? "Planning is still in progress.",
      verification: full.verification ?? "Planning is still in progress.",
    },
    graphRefs: descriptor.graph?.nodes().map((node) => `${node.type}: ${node.title}`) ?? [],
    touchedFiles: [],
    receiptIds: [],
    checkIds: descriptor.step?.validation_checks ?? [],
    unresolvedQuestions: Object.values(run.questions).filter((question) => question.answeredAt === undefined).map((question) => question.prompt),
    nextAction: descriptor.initialPrompt,
  };
}

function answeredQuestionContext(run: RunRecord): Array<{
  questionId: string;
  prompt: string;
  selectedOptionId?: string;
  selectedOption?: string;
  notes?: string;
  answeredAt: string;
}> {
  return Object.values(run.questions)
    .filter((question): question is typeof question & { answeredAt: string } => question.answeredAt !== undefined)
    .sort((left, right) => left.answeredAt.localeCompare(right.answeredAt) || compareText(left.id, right.id))
    .map((question) => {
      const selected = question.selectedOptionId === undefined
        ? undefined
        : question.options.find((option) => option.id === question.selectedOptionId);
      return {
        questionId: question.id,
        prompt: question.prompt,
        ...(selected === undefined ? {} : {
          selectedOptionId: selected.id,
          selectedOption: selected.label,
        }),
        ...(question.notes === undefined ? {} : { notes: question.notes }),
        answeredAt: question.answeredAt,
      };
    });
}

function attemptTokenBudget(
  runType: ConfigurationObject,
  kind: "planning" | "ticket" | "verification" | "integration",
): AgentLaunchSpec["budgets"]["tokens"] {
  const planning = optionalRecord(runType.planning);
  const configured = optionalSafeInteger(optionalRecord(planning?.token_budget)?.limit);
  const sizeDefault = runType.id === "small" ? 120_000 : runType.id === "large" ? 480_000 : 240_000;
  const maxNew = kind === "planning" ? configured ?? sizeDefault : Math.max(32_000, Math.floor(sizeDefault / 2));
  const maxAll = Math.min(Number.MAX_SAFE_INTEGER, maxNew * 16);
  return {
    maxInput: maxNew,
    maxOutput: maxNew,
    maxCacheRead: maxAll,
    maxCacheWrite: maxAll,
    maxNew,
    maxAll,
  };
}

function attemptRepositoryCallBudget(
  runType: ConfigurationObject,
  kind: "planning" | "ticket" | "verification" | "integration",
): number | undefined {
  if (kind !== "planning") return undefined;
  const configured = optionalSafeInteger(optionalRecord(runType.planning)?.max_repository_tool_calls);
  if (configured !== undefined && configured < 1) {
    fail("planning_repository_budget", "planning max_repository_tool_calls must be a positive integer");
  }
  // Profiles should state this explicitly. The fallback keeps custom/legacy agent-planning
  // run types bounded rather than silently restoring unmetered repository discovery.
  return configured ?? 24;
}

function configuredMaxParallel(runType: ConfigurationObject): number {
  const value = optionalSafeInteger(optionalRecord(runType.orchestration)?.max_parallel);
  if (value === undefined || value < 1) fail("run_parallelism", "run type max_parallel must be a positive integer");
  return value;
}

function configuredQuestionPolicy(runType: ConfigurationObject): "none" | "some" | "many" {
  const policy = optionalString(optionalRecord(runType.questions)?.policy) ?? "high_impact_only";
  if (policy === "autonomous") return "none";
  if (policy === "high_impact_only") return "some";
  if (policy === "interactive") return "many";
  fail("question_policy", `unsupported question policy ${policy}`);
}

function configuredPlanningInstructions(runType: ConfigurationObject): string {
  return optionalString(optionalRecord(runType.instructions)?.planning) ?? "";
}

function requireThinkingLevel(value: unknown, label: string): ThinkingLevel {
  if (value === "ultra") {
    fail("legacy_thinking_level", `${label} still uses legacy ultra; migrate it explicitly to Pi max before execution`);
  }
  if (!PI_THINKING_LEVELS.has(value as ThinkingLevel)) fail("thinking_level", `${label} has unsupported Pi thinking level ${String(value)}`);
  return value as ThinkingLevel;
}

function ensureSeedConnected(keys: Set<string>, edges: PlanningGraphSeed["edges"]): void {
  if (keys.size === 0) return;
  const neighbors = new Map<string, Set<string>>();
  for (const edge of edges) {
    const left = neighbors.get(edge.source) ?? new Set<string>();
    left.add(edge.target);
    neighbors.set(edge.source, left);
    const right = neighbors.get(edge.target) ?? new Set<string>();
    right.add(edge.source);
    neighbors.set(edge.target, right);
  }
  const seen = new Set<string>(["$root"]);
  const queue = ["$root"];
  while (queue.length > 0) {
    for (const next of neighbors.get(queue.shift()!) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  const missing = [...keys].filter((key) => !seen.has(key));
  if (missing.length > 0) fail("graph_seed_disconnected", `graph seed nodes are not connected to $root: ${missing.join(", ")}`);
}

function rejectCompilerOwnedSpec(fields: readonly string[], spec: Record<string, JsonValue>, label: string): void {
  for (const field of fields) {
    const normalized = field.replace(/^spec\./u, "");
    if (!field.startsWith("spec.")) continue;
    if (graphField({ schema_version: "1.0", id: "x", type: "x", title: "x", status: "x", spec, edges: {}, annotations: {} }, normalized) !== undefined) {
      fail("compiler_owned_field", `${label} may not author compiler-owned spec.${normalized}`);
    }
  }
}

function preserveCompilerOwnedSpec(fields: readonly string[], existing: GraphNode, updated: GraphNode): void {
  for (const field of fields) {
    if (!field.startsWith("spec.")) continue;
    if (canonicalHash(graphField(existing, field) ?? null) !== canonicalHash(graphField(updated, field) ?? null)) {
      fail("compiler_owned_field", `agent may not change compiler-owned ${field}`);
    }
  }
}

function assertAgentToolIdentity(
  run: RunRecord,
  attempt: AgentAttemptRecord,
  grant: AuthorityGrant,
): void {
  if (
    grant.runId !== run.id ||
    grant.attemptId !== attempt.id ||
    grant.sessionId !== attempt.sessionId ||
    grant.ticketId !== attempt.ticketId ||
    grant.stepId !== attempt.stepId ||
    grant.generation !== run.generation ||
    grant.grantId !== `grant-${attempt.id}`
  ) fail("agent_tool_identity", "agent tool request does not match its immutable run assignment");
}

interface ResolveConfiguredCheckInput {
  configuration: CompiledConfiguration;
  graph: TypedGraph;
  descriptor: AttemptDescriptor;
  projectRoot: string;
  requestedCheckId: string;
}

interface CompositeMemberBinding {
  nodeId: string;
  cwd?: string;
  inputPaths: string[];
}

async function resolveConfiguredAgentCheck(input: ResolveConfiguredCheckInput): Promise<ResolvedAgentCheck> {
  const adapter = await createProductionRuleDomainAdapter({
    configuration: input.configuration,
    graph: input.graph,
    projectRoot: input.projectRoot,
  });
  const evaluator = new GraphExpressionEvaluator(
    input.configuration,
    input.graph,
    adapter,
  );
  const targetIds = input.descriptor.definition?.target_node_ids ?? input.descriptor.readNodeIds;
  const resolved = await resolveCheckRecursive({ ...input, evaluator }, input.requestedCheckId, targetIds, [], undefined);
  return deepFreeze({
    protocol: "koni.resolved-agent-check.v1",
    requestedCheckId: input.requestedCheckId,
    definitionHash: resolved.definitionHash,
    kind: resolved.kind,
    commands: resolved.commands,
  });
}

async function resolveCheckRecursive(
  input: ResolveConfiguredCheckInput & { evaluator: GraphExpressionEvaluator },
  checkId: string,
  subjectIds: readonly string[],
  stack: readonly string[],
  member: CompositeMemberBinding | undefined,
): Promise<{ kind: ResolvedAgentCheck["kind"]; definitionHash: Sha256Digest; commands: ResolvedAgentCheckCommand[] }> {
  if (stack.includes(checkId)) fail("check_recursive", `configured check recursion is cyclic: ${[...stack, checkId].join(" -> ")}`);
  const definition = input.configuration.registries.checks[checkId];
  if (definition === undefined) fail("check_missing", `configured check ${checkId} does not exist`);
  assertCheckApplies(definition, input.descriptor, checkId);
  const kind = optionalString(definition.kind);
  const definitionHash = canonicalHash(definition);
  if (kind === "graph") return { kind, definitionHash, commands: [] };
  if (kind === "command") {
    return {
      kind,
      definitionHash,
      commands: await resolveCommandCheck(input, checkId, definition, subjectIds, member),
    };
  }
  if (kind !== "composite") fail("check_kind", `configured check ${checkId} has unsupported kind ${kind ?? ""}`);
  const set = optionalRecord(definition.graph_set);
  if (set === undefined) fail("check_composite", `composite check ${checkId} has no graph_set contract`);
  const selector = set.members as ConfigurationValue | undefined;
  if (selector === undefined) fail("check_composite", `composite check ${checkId} has no member selector`);
  const selected = input.evaluator.withBinding("target", subjectIds, () => input.evaluator.select(selector));
  const memberTypes = new Set(stringArray(set.member_node_types, `${checkId} member node types`));
  const excluded = new Set(stringArray(set.status_excluding, `${checkId} excluded statuses`));
  const members = selected.flatMap((id) => {
    const node = input.graph.node(id);
    if (node === undefined || (memberTypes.size > 0 && !memberTypes.has(node.type)) || excluded.has(node.status)) return [];
    return [node];
  }).sort((left, right) => compareText(left.id, right.id));
  const minimum = optionalSafeInteger(set.min_members) ?? 0;
  if (members.length < minimum) {
    fail("check_composite_coverage", `composite check ${checkId} selected ${members.length} members, below ${minimum}`);
  }
  const commands: ResolvedAgentCheckCommand[] = [];
  for (const node of members) {
    const configuredChild = optionalString(set.member_check);
    const field = optionalString(set.member_check_field);
    const childId = configuredChild ?? (field === undefined ? undefined : optionalString(graphNodeField(node, field)));
    if (childId === undefined) fail("check_composite_member", `composite check ${checkId} member ${node.id} has no check id`);
    const sourcePaths = configuredNodePaths(node, optionalString(set.source_paths_field));
    const coveredPaths = configuredNodePaths(node, optionalString(set.covered_paths_field));
    const workingDirectory = optionalString(set.working_directory_field);
    const cwd = workingDirectory === undefined ? undefined : optionalString(graphNodeField(node, workingDirectory));
    const resolved = await resolveCheckRecursive(
      input,
      childId,
      [node.id],
      [...stack, checkId],
      { nodeId: node.id, ...(cwd === undefined ? {} : { cwd }), inputPaths: [...new Set([...sourcePaths, ...coveredPaths])].sort(compareText) },
    );
    commands.push(...resolved.commands);
  }
  return { kind, definitionHash, commands };
}

async function resolveCommandCheck(
  input: ResolveConfiguredCheckInput & { evaluator: GraphExpressionEvaluator },
  checkId: string,
  definition: ConfigurationObject,
  subjectIds: readonly string[],
  member: CompositeMemberBinding | undefined,
): Promise<ResolvedAgentCheckCommand[]> {
  const staticArgv = Array.isArray(definition.argv) ? exactArgv(definition.argv, checkId) : undefined;
  const source = optionalRecord(definition.command_source);
  if ((staticArgv === undefined) === (source === undefined)) {
    fail("check_command_source", `command check ${checkId} must have exactly one static or dynamic command source`);
  }
  const bindings: Array<{ argv: string[]; root?: ConfigurationValue; variables: Record<string, string> }> = [];
  if (staticArgv !== undefined) {
    bindings.push({ argv: staticArgv, variables: {} });
  } else {
    const sourceKind = optionalString(source!.kind);
    const field = requiredNonempty(source!.field, `${checkId} command source field`);
    if (sourceKind === "node") {
      const allowedTypes = new Set(stringArray(source!.node_types, `${checkId} command source node types`));
      const gatePolicy = optionalString(source!.gate_policy);
      if (gatePolicy !== undefined) {
        for (const gateId of [...new Set(subjectIds)].sort(compareText)) {
          const winners = input.evaluator.select({
            policy_selection: { policy: gatePolicy, gate: { ids: [gateId] }, result: "winner" },
          });
          if (winners.length !== 1) fail("check_command_source", `check ${checkId} gate ${gateId} has no unique policy winner`);
          const winner = input.graph.node(winners[0]!)!;
          if (allowedTypes.size > 0 && !allowedTypes.has(winner.type)) {
            fail("check_command_source", `check ${checkId} selected unauthorized ${winner.type} command node ${winner.id}`);
          }
          const variables = {
            "gate.id": gateId,
            "target.id": gateId,
            [`${optionalString(source!.role) ?? winner.type}.id`]: winner.id,
            [`${winner.type}.id`]: winner.id,
          };
          bindings.push({
            argv: exactArgv(dynamicValuePath(graphNodeRoot(winner), field, variables), checkId),
            root: winner.spec,
            variables,
          });
        }
      } else {
        const candidates = [...new Set(subjectIds)].flatMap((id) => {
          const node = input.graph.node(id);
          return node !== undefined && (allowedTypes.size === 0 || allowedTypes.has(node.type)) ? [node] : [];
        }).sort((left, right) => compareText(left.id, right.id));
        if (candidates.length !== 1) {
          fail("check_command_source", `check ${checkId} resolved ${candidates.length} target command nodes, expected exactly one`);
        }
        const candidate = candidates[0]!;
        const variables = {
          "target.id": candidate.id,
          [`${optionalString(source!.role) ?? candidate.type}.id`]: candidate.id,
          [`${candidate.type}.id`]: candidate.id,
        };
        bindings.push({
          argv: exactArgv(dynamicValuePath(graphNodeRoot(candidate), field, variables), checkId),
          root: candidate.spec,
          variables,
        });
      }
    } else if (sourceKind === "ticket") {
      const candidates = [...new Set(subjectIds)].flatMap((id) => {
        const node = input.graph.node(id);
        return node === undefined ? [] : [node];
      }).sort((left, right) => compareText(left.id, right.id));
      if (candidates.length !== 1) {
        fail("check_command_source", `check ${checkId} resolved ${candidates.length} ticket command nodes, expected exactly one`);
      }
      const target = candidates[0]!;
      const variables = { "target.id": target.id, "ticket.id": input.descriptor.ticketId };
      bindings.push({
        argv: exactArgv(dynamicValuePath(target.spec, field, variables), checkId),
        root: target.spec,
        variables,
      });
    } else {
      fail("check_command_source", `check ${checkId} has unsupported dynamic source kind ${sourceKind ?? ""}`);
    }
  }
  const effect = optionalString(definition.effect) ?? "read_only";
  if (effect !== "read_only" && effect !== "workspace_write") fail("check_effect", `check ${checkId} has unsupported effect ${effect}`);
  const timeoutSeconds = optionalSafeInteger(definition.timeout_seconds);
  if (timeoutSeconds === undefined || timeoutSeconds < 1 || timeoutSeconds > 86_400) {
    fail("check_timeout", `check ${checkId} timeout must be between 1 and 86400 seconds`);
  }
  const environment = optionalRecord(definition.environment) ?? {};
  const inherit = stringArray(environment.inherit, `${checkId} inherited environment`);
  const set = optionalRecord(environment.set) ?? {};
  const environmentSet: Record<string, string> = {};
  for (const [name, value] of Object.entries(set).sort(([left], [right]) => compareText(left, right))) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || typeof value !== "string" || value.includes("\u0000")) {
      fail("check_environment", `check ${checkId} has an invalid fixed environment entry`);
    }
    environmentSet[name] = value;
  }
  const expectedExitCodes = stringOrNumberArray(definition.expected_exit_codes, [0], checkId);
  const cwd = normalizeCheckPath(member?.cwd ?? optionalString(definition.cwd) ?? ".", `${checkId} cwd`);
  return Promise.all(bindings.map(async (binding) => {
    const boundInputPaths = await resolveCheckInputBindings(
      definition,
      binding.root,
      binding.argv,
      checkId,
      input.projectRoot,
    );
    const inputPaths = [...new Set([...(member?.inputPaths ?? []), ...boundInputPaths])]
      .map((value) => normalizeCheckPath(value, `${checkId} input path`))
      .sort(compareText);
    for (const value of inputPaths) assertPathInScopes(value, input.descriptor.readPaths, `${checkId} input path`);
    const dynamicResult = optionalRecord(definition.dynamic_result);
    const resultPath = resolveDynamicResultPath(dynamicResult, binding.root, binding.variables, checkId);
    if (resultPath !== undefined) assertPathInScopes(resultPath, input.descriptor.writePaths, `${checkId} result path`);
    const outputPaths = effect === "workspace_write"
      ? [...new Set(input.descriptor.writePaths)].sort(compareText)
      : [];
    const artifactDefinition = optionalRecord(dynamicResult?.artifacts);
    const outputArtifactSelector = artifactDefinition === undefined ? undefined : {
      field: requiredNonempty(artifactDefinition.field, `${checkId} artifact field`),
      allowPathStrings: artifactDefinition.allow_path_strings === true,
      pathField: optionalString(artifactDefinition.path_field) ?? "path",
    };
    return {
      checkId,
      definitionHash: canonicalHash(definition),
      argv: binding.argv,
      cwd,
      timeoutMs: timeoutSeconds * 1_000,
      effect,
      networkAccess: definition.network_access === true,
      environment: { inherit, set: environmentSet },
      expectedExitCodes,
      allowNonpassingReceipt: definition.allow_nonpassing_receipt === true,
      receiptType: requiredNonempty(definition.receipt_type, `${checkId} receipt type`),
      ...(optionalString(definition.result_protocol) === undefined ? {} : { resultProtocol: optionalString(definition.result_protocol)! }),
      requiredResultFields: stringArray(definition.required_result_fields, `${checkId} required result fields`),
      ...(definition.result_schema === undefined ? {} : { resultSchema: structuredClone(definition.result_schema) as JsonValue }),
      resultSource: resultPath === undefined ? { kind: "stdout" as const } : { kind: "file" as const, path: resultPath },
      ...(outputArtifactSelector === undefined ? {} : { outputArtifactSelector }),
      inputPaths,
      outputPaths,
    };
  }));
}

function assertCheckApplies(definition: ConfigurationObject, descriptor: AttemptDescriptor, checkId: string): void {
  const applies = stringArray(definition.applies_to, `${checkId} applies_to`);
  const operation = descriptor.definition?.operation;
  if (operation !== undefined && applies.length > 0 && !applies.includes(operation)) {
    fail("check_operation", `check ${checkId} does not apply to operation ${operation}`);
  }
}

function configuredNodePaths(node: GraphNode, field: string | undefined): string[] {
  if (field === undefined) return [];
  const value = graphNodeField(node, field);
  const values = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  if (values.some((item) => typeof item !== "string")) fail("check_composite_path", `${node.id}.${field} contains a non-string path`);
  return (values as string[]).map((item) => normalizeCheckPath(item, `${node.id}.${field}`));
}

function graphNodeRoot(node: GraphNode): ConfigurationObject {
  return {
    schema_version: node.schema_version,
    id: node.id,
    type: node.type,
    title: node.title,
    status: node.status,
    spec: node.spec,
    edges: node.edges,
    annotations: node.annotations,
  };
}

function graphNodeField(node: GraphNode, field: string): ConfigurationValue | undefined {
  return dynamicValuePath(graphNodeRoot(node), field, {});
}

function dynamicValuePath(
  root: ConfigurationValue,
  field: string,
  variables: Readonly<Record<string, string>>,
): ConfigurationValue | undefined {
  const segments = field.replace(/^\$?\./u, "").match(/[^.[\]]+|\[[^\]]+\]/gu) ?? [];
  let current: ConfigurationValue | undefined = root;
  for (const raw of segments) {
    const bracket = raw.startsWith("[");
    let key = bracket ? raw.slice(1, -1).trim() : raw;
    if (key.startsWith("$")) key = variables[key.slice(1)] ?? "";
    else key = key.replace(/^(?:'|")|(?:'|")$/gu, "");
    if (key.length === 0) return undefined;
    if (Array.isArray(current)) {
      const index = Number(key);
      if (!Number.isSafeInteger(index) || index < 0) return undefined;
      current = current[index];
    } else if (isRecord(current)) {
      current = current[key] as ConfigurationValue | undefined;
    } else return undefined;
  }
  return current;
}

function exactArgv(value: unknown, checkId: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) =>
    typeof item !== "string" || item.trim().length === 0 || item.includes("\u0000") || item.includes("\n") || item.includes("\r"))) {
    fail("check_argv", `check ${checkId} command must be one exact nonempty argv array`);
  }
  const argv = value as string[];
  if (/\s/u.test(argv[0]!)) fail("check_argv", `check ${checkId} executable argv element may not contain whitespace`);
  if (argv.length > 4_096 || argv.some((item) => Buffer.byteLength(item, "utf8") > 1024 * 1024)) {
    fail("check_argv", `check ${checkId} argv exceeds its compiler bound`);
  }
  return [...argv];
}

function stringOrNumberArray(value: unknown, fallback: number[], checkId: string): number[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => !Number.isSafeInteger(item) || (item as number) < 0 || (item as number) > 255)) {
    fail("check_exit_codes", `check ${checkId} expected exit codes are invalid`);
  }
  return [...new Set(value as number[])].sort((left, right) => left - right);
}

async function resolveCheckInputBindings(
  definition: ConfigurationObject,
  root: ConfigurationValue | undefined,
  argv: readonly string[],
  checkId: string,
  projectRoot: string,
): Promise<string[]> {
  const configured = optionalRecord(definition.argv_input_bindings);
  if (configured === undefined) return [];
  if (root === undefined) fail("check_input_binding", `check ${checkId} has no dynamic root for argv input bindings`);
  const from = requiredNonempty(configured.from, `${checkId} argv input source`);
  const rows = dynamicValuePath(root, from, {});
  if (!Array.isArray(rows) || (configured.require_nonempty === true && rows.length === 0)) {
    fail("check_input_binding", `check ${checkId} argv input source is not a permitted nonempty list`);
  }
  const pathField = optionalString(configured.path_field) ?? "path";
  const requiredFields = stringArray(configured.required_fields, `${checkId} required input fields`);
  const paths: string[] = [];
  for (const [index, row] of rows.entries()) {
    if (!isRecord(row)) fail("check_input_binding", `check ${checkId} input binding ${index} is not an object`);
    for (const field of requiredFields) if (row[field] === undefined) {
      fail("check_input_binding", `check ${checkId} input binding ${index} is missing ${field}`);
    }
    const value = requiredNonempty(row[pathField], `${checkId} input binding path`);
    const normalized = normalizeCheckPath(value, `${checkId} input binding path`);
    if (configured.require_exact_argument === true && !argv.includes(normalized) && !argv.includes(value)) {
      fail("check_input_binding", `check ${checkId} input path ${normalized} is not an exact argv element`);
    }
    if (configured.require_project_file === true) {
      await assertExistingProjectFile(projectRoot, normalized, checkId);
    }
    paths.push(normalized);
  }
  return paths;
}

async function assertExistingProjectFile(
  projectRoot: string,
  relativePath: string,
  checkId: string,
): Promise<void> {
  let canonicalRoot: string;
  let canonicalFile: string;
  try {
    canonicalRoot = await realpath(projectRoot);
    canonicalFile = await realpath(path.join(canonicalRoot, relativePath));
  } catch {
    fail("check_input_binding", `check ${checkId} input path ${relativePath} does not exist as a project file`);
  }
  if (!isWithinDirectory(canonicalRoot!, canonicalFile!)) {
    fail("check_input_binding", `check ${checkId} input path ${relativePath} escapes the project root`);
  }
  let metadata;
  try {
    metadata = await lstat(canonicalFile!);
  } catch {
    fail("check_input_binding", `check ${checkId} input path ${relativePath} does not exist as a project file`);
  }
  if (!metadata!.isFile()) {
    fail("check_input_binding", `check ${checkId} input path ${relativePath} is not a project file`);
  }
}

function resolveDynamicResultPath(
  dynamicResult: ConfigurationObject | undefined,
  root: ConfigurationValue | undefined,
  variables: Readonly<Record<string, string>>,
  checkId: string,
): string | undefined {
  const source = optionalRecord(dynamicResult?.result_path);
  if (source === undefined) return undefined;
  if (root === undefined) fail("check_result_path", `check ${checkId} has no dynamic root for its result path`);
  const field = requiredNonempty(source.field, `${checkId} result path field`);
  const value = dynamicValuePath(root, field, variables);
  if (value === undefined || value === null) return undefined;
  return normalizeCheckPath(requiredNonempty(value, `${checkId} result path`), `${checkId} result path`);
}

function normalizeCheckPath(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed === ".") return ".";
  if (
    trimmed.length === 0 || trimmed.includes("\u0000") || trimmed.includes("\\") ||
    trimmed.startsWith("/") || path.posix.normalize(trimmed) !== trimmed ||
    trimmed.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) fail("check_path", `${label} must be a normalized project-relative path`);
  return trimmed;
}

function assertPathInScopes(value: string, scopes: readonly string[], label: string): void {
  const normalizedScopes = scopes.map((scope) => normalizeCheckPath(scope, `${label} scope`));
  if (!normalizedScopes.some((scope) => scope === "." || value === scope || value.startsWith(`${scope}/`))) {
    fail("check_path_scope", `${label} ${value} is outside the exact compiler-issued path scope`);
  }
}

interface CompiledCheckCommandExecution {
  accepted: boolean;
  passed: boolean;
  value: JsonValue;
  evidence: ConfigurationObject;
}

function compileCheckCommandExecution(
  command: ResolvedAgentCheckCommand,
  execution: AgentCheckExecution,
  index: number,
  configuration: CompiledConfiguration,
  descriptor: AttemptDescriptor,
): CompiledCheckCommandExecution {
  if (
    execution.checkId !== command.checkId ||
    execution.definitionHash !== command.definitionHash ||
    execution.argv.length !== command.argv.length ||
    execution.argv[0] !== execution.resolvedExecutable ||
    canonicalHash(execution.argv.slice(1)) !== canonicalHash(command.argv.slice(1))
  ) fail("check_execution_identity", `check execution ${index} does not match its compiler-resolved command`);
  if (!isIsoTimestamp(execution.startedAt) || !isIsoTimestamp(execution.completedAt) ||
      Date.parse(execution.completedAt) < Date.parse(execution.startedAt)) {
    fail("check_execution_time", `check execution ${index} has invalid authority timestamps`);
  }
  if (
    typeof execution.resolvedExecutable !== "string" || !path.isAbsolute(execution.resolvedExecutable) ||
    execution.resolvedExecutable.includes("\u0000") || !isSha256Digest(execution.environmentSha256) ||
    !isSha256Digest(execution.preManifestSha256) || !isSha256Digest(execution.postManifestSha256) ||
    !isSha256Digest(execution.sandboxProfileSha256) ||
    typeof execution.sandboxKind !== "string" || execution.sandboxKind.trim().length === 0
  ) fail("check_execution_authority", `check execution ${index} has invalid sandbox or environment provenance`);
  if (Buffer.byteLength(execution.stdout, "utf8") > 16 * 1024 * 1024 ||
      Buffer.byteLength(execution.stderr, "utf8") > 16 * 1024 * 1024 ||
      execution.stdoutSizeBytes !== Buffer.byteLength(execution.stdout, "utf8") ||
      execution.stderrSizeBytes !== Buffer.byteLength(execution.stderr, "utf8") ||
      rawSha256(execution.stdout) !== execution.stdoutSha256 ||
      rawSha256(execution.stderr) !== execution.stderrSha256) {
    fail("check_execution_stream", `check execution ${index} stream bytes do not match their authority hashes`);
  }
  const errors: string[] = [];
  const exitAccepted = execution.signal === null && execution.exitCode !== null &&
    command.expectedExitCodes.includes(execution.exitCode);
  if (!exitAccepted) errors.push(`exit ${execution.exitCode ?? execution.signal ?? "unknown"} is outside the configured contract`);
  if (command.effect === "read_only" && execution.preManifestSha256 !== execution.postManifestSha256) {
    errors.push("read-only check changed the workspace manifest");
  }
  if (
    execution.resultSource.kind !== command.resultSource.kind ||
    (command.resultSource.kind === "file" && execution.resultSource.path !== command.resultSource.path) ||
    !isSha256Digest(execution.resultSource.bytesSha256) ||
    !Number.isSafeInteger(execution.resultSource.sizeBytes) || execution.resultSource.sizeBytes < 0
  ) fail("check_result_source", `check execution ${index} result source is not the compiler-resolved source`);
  if (command.resultSource.kind === "stdout" && (
    execution.resultSource.bytesSha256 !== execution.stdoutSha256 ||
    execution.resultSource.sizeBytes !== Buffer.byteLength(execution.stdout, "utf8")
  )) fail("check_result_source", `check execution ${index} stdout result bytes are not authority-bound`);
  const resultRequired = command.resultProtocol !== undefined || command.resultSchema !== undefined ||
    command.requiredResultFields.length > 0 || command.outputArtifactSelector !== undefined;
  let result = execution.resultSource.value;
  if (resultRequired && command.resultSource.kind === "stdout") {
    try {
      const parsed = JSON.parse(execution.stdout) as unknown;
      assertJsonValue(parsed, `${command.checkId} stdout result`);
      if (canonicalHash(parsed) !== canonicalHash(result)) errors.push("authority-parsed stdout result differs from stdout bytes");
      result = parsed as JsonValue;
    } catch {
      errors.push("stdout is not one complete JSON result");
    }
  }
  const resultObject = isRecord(result) ? result : undefined;
  if (resultRequired && resultObject === undefined) errors.push("configured result must be an object");
  if (command.resultProtocol !== undefined && resultObject?.protocol !== command.resultProtocol) {
    errors.push(`result protocol is not ${command.resultProtocol}`);
  }
  for (const field of command.requiredResultFields) {
    if (resultObject?.[field] === undefined) errors.push(`result is missing ${field}`);
  }
  if (command.resultSchema !== undefined) {
    try {
      if (!Value.Check(command.resultSchema as TSchema, result)) errors.push("result does not match the configured schema");
    } catch {
      fail("check_result_schema", `compiled result schema for ${command.checkId} is not executable`);
    }
  }
  const definition = configuration.registries.checks[command.checkId];
  if (definition === undefined || canonicalHash(definition) !== command.definitionHash) {
    fail("check_definition_drift", `check ${command.checkId} definition changed during result compilation`);
  }
  validateDynamicCheckResult(definition, resultObject, descriptor, command, errors);
  const acceptance = optionalRecord(definition.result_acceptance);
  let semanticPassing = true;
  if (acceptance !== undefined) {
    const field = requiredNonempty(acceptance.field, `${command.checkId} result acceptance field`);
    const values = Array.isArray(acceptance.values) ? acceptance.values : [];
    semanticPassing = resultObject !== undefined && values.some((value) =>
      canonicalHash(value) === canonicalHash(resultObject[field] ?? null));
  }
  const outputFiles = validateCheckOutputFiles(execution.outputFiles, command, resultObject, errors);
  const contractValid = errors.length === 0;
  const passed = contractValid && exitAccepted && semanticPassing;
  const accepted = contractValid && exitAccepted && (semanticPassing || command.allowNonpassingReceipt);
  const value: JsonValue = {
    checkId: command.checkId,
    accepted,
    passed,
    exitCode: execution.exitCode,
    signal: execution.signal,
    result,
    outputFiles,
    errors,
  };
  return {
    accepted,
    passed,
    value,
    evidence: {
      checkId: command.checkId,
      definitionHash: command.definitionHash,
      commandSha256: canonicalHash(command),
      argvSha256: canonicalHash(command.argv),
      resolvedExecutable: execution.resolvedExecutable,
      environmentSha256: execution.environmentSha256,
      sandboxKind: execution.sandboxKind,
      sandboxProfileSha256: execution.sandboxProfileSha256,
      startedAt: execution.startedAt,
      completedAt: execution.completedAt,
      exitCode: execution.exitCode,
      signal: execution.signal,
      stdoutSha256: execution.stdoutSha256,
      stderrSha256: execution.stderrSha256,
      preManifestSha256: execution.preManifestSha256,
      postManifestSha256: execution.postManifestSha256,
      resultSource: execution.resultSource as unknown as ConfigurationValue,
      outputFiles: outputFiles as unknown as ConfigurationValue,
      accepted,
      passed,
      errors,
    },
  };
}

function validateDynamicCheckResult(
  definition: ConfigurationObject,
  result: Record<string, unknown> | undefined,
  descriptor: AttemptDescriptor,
  command: ResolvedAgentCheckCommand,
  errors: string[],
): void {
  if (result === undefined) return;
  const identityField = optionalString(definition.result_identity_field);
  if (identityField !== undefined) {
    const targets = descriptor.definition?.target_node_ids ?? [];
    if (targets.length !== 1 || result[identityField] !== targets[0]) {
      errors.push(`result ${identityField} is not the exact compiler target identity`);
    }
  }
  const dynamic = optionalRecord(definition.dynamic_result);
  const requiredKeys = optionalRecord(dynamic?.required_keys);
  if (requiredKeys !== undefined) {
    const source = optionalRecord(requiredKeys.source);
    const actualField = requiredNonempty(requiredKeys.actual_field, `${command.checkId} dynamic actual field`);
    const root = descriptor.graph === undefined ? undefined : ticketCommandRoot(descriptor);
    const expected = source === undefined || root === undefined
      ? undefined
      : dynamicValuePath(root, requiredNonempty(source.field, `${command.checkId} required key source`), {});
    const actual = result[actualField];
    if (!Array.isArray(expected) || expected.some((item) => typeof item !== "string") || !isRecord(actual)) {
      errors.push("dynamic required-key contract could not be resolved");
    } else if ((expected as string[]).some((key) => actual[key] === undefined)) {
      errors.push(`result ${actualField} does not contain every compiler-required key`);
    }
  }
}

function validateCheckOutputFiles(
  files: AgentCheckExecution["outputFiles"],
  command: ResolvedAgentCheckCommand,
  result: Record<string, unknown> | undefined,
  errors: string[],
): Array<{ path: string; sha256: Sha256Digest; sizeBytes: number }> {
  const output = files.map((file) => {
    const normalized = normalizeCheckPath(file.path, `${command.checkId} output artifact`);
    if (!isSha256Digest(file.sha256) || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0) {
      fail("check_output_file", `check ${command.checkId} has invalid authority output-file metadata`);
    }
    if (command.effect !== "workspace_write") errors.push("read-only check reported output files");
    else assertPathInScopes(normalized, command.outputPaths, `${command.checkId} output artifact`);
    return { path: normalized, sha256: file.sha256, sizeBytes: file.sizeBytes };
  }).sort((left, right) => compareText(left.path, right.path));
  if (new Set(output.map((file) => file.path)).size !== output.length) {
    fail("check_output_file", `check ${command.checkId} reported duplicate output files`);
  }
  const selector = command.outputArtifactSelector;
  if (selector !== undefined) {
    const raw = result?.[selector.field];
    if (!Array.isArray(raw)) {
      errors.push(`result ${selector.field} is not an artifact list`);
    } else {
      const expected: string[] = [];
      for (const item of raw) {
        const pathValue = typeof item === "string" && selector.allowPathStrings
          ? item
          : isRecord(item) ? item[selector.pathField] : undefined;
        if (typeof pathValue !== "string") {
          errors.push(`result ${selector.field} contains an invalid artifact path`);
          continue;
        }
        expected.push(normalizeCheckPath(pathValue, `${command.checkId} result artifact`));
      }
      if (canonicalHash([...new Set(expected)].sort(compareText)) !== canonicalHash(output.map((file) => file.path))) {
        errors.push("authority output-file inventory differs from the typed result artifacts");
      }
    }
  }
  return output;
}

function ticketCommandRoot(descriptor: AttemptDescriptor): ConfigurationValue | undefined {
  if (descriptor.graph === undefined) return undefined;
  const ids = descriptor.definition?.target_node_ids ?? [];
  if (ids.length !== 1) return undefined;
  return descriptor.graph.node(ids[0]!)?.spec;
}

async function evaluateRequestedGraphCheck(
  configuration: CompiledConfiguration,
  graph: TypedGraph,
  projectRoot: string,
  checkId: string,
  targetIds: readonly string[],
): Promise<boolean> {
  const definition = configuration.registries.checks[checkId];
  if (definition === undefined || definition.kind !== "graph" || definition.predicate === undefined || targetIds.length === 0) {
    return false;
  }
  const adapter = await createProductionRuleDomainAdapter({ configuration, graph, projectRoot });
  const evaluator = new GraphExpressionEvaluator(configuration, graph, adapter);
  return [...new Set(targetIds)].every((id) =>
    evaluator.withBinding("target", [id], () => evaluator.evaluate(definition.predicate!)));
}

function mergeCheckRuleEvidence(input: {
  prior: RuleAuthorityEvidence | undefined;
  configuration: CompiledConfiguration;
  graph: TypedGraph;
  descriptor: AttemptDescriptor;
  resolved: ResolvedAgentCheck;
  accepted: boolean;
  passed: boolean;
  evidenceId: string;
  recordedAt: string;
}): RuleAuthorityEvidence {
  const inputGraphSha256 = ruleInputGraphSha256(input.configuration, input.graph);
  const predicates = structuredClone(input.prior?.predicates ?? {}) as Record<Sha256Digest, import("./domain-adapter.js").RulePredicateEvidence>;
  const receiptTypes = new Set(input.resolved.commands.map((command) => command.receiptType));
  const gatePolicies = new Set(input.resolved.commands.flatMap((command) => {
    const source = optionalRecord(input.configuration.registries.checks[command.checkId]?.command_source);
    const policy = optionalString(source?.gate_policy);
    return policy === undefined ? [] : [policy];
  }));
  const leaves: Array<{ leaf: ConfigurationObject; result: boolean }> = [];
  collectEvidenceLeaves(
    input.configuration.registries,
    input.resolved,
    receiptTypes,
    gatePolicies,
    input.accepted,
    input.passed,
    leaves,
  );
  if (!leaves.some((item) => item.leaf.op === "check_passed" && item.leaf.check === input.resolved.requestedCheckId)) {
    leaves.push({ leaf: { op: "check_passed", check: input.resolved.requestedCheckId }, result: input.passed });
  }
  const targets = evidenceSubjectNodeIds(
    input.configuration,
    input.graph,
    input.descriptor,
    input.resolved.requestedCheckId,
  );
  for (const subjectNodeId of [...new Set(targets)].sort(compareText)) {
    for (const { leaf, result } of leaves) {
      const bindings = Object.fromEntries([...rulePredicateBindingNames(leaf)]
        .sort(compareText)
        .map((name) => [name, [subjectNodeId]]));
      const key = rulePredicateEvidenceKey({
        configurationSha256: input.configuration.configuration_sha256,
        inputGraphSha256,
        leaf,
        subjectNodeId,
        bindings,
      });
      predicates[key] = {
        key,
        result,
        recordedAt: input.recordedAt,
        sourceReceiptIds: [input.evidenceId],
        leaf: structuredClone(leaf),
        subjectNodeId,
        bindings,
      };
    }
  }
  return createRuleAuthorityEvidence({
    protocol: RULE_AUTHORITY_EVIDENCE_PROTOCOL,
    configurationSha256: input.configuration.configuration_sha256,
    inputGraphSha256,
    predicates,
  });
}

function evidenceSubjectNodeIds(
  configuration: CompiledConfiguration,
  graph: TypedGraph,
  descriptor: AttemptDescriptor,
  requestedCheckId: string,
): string[] {
  const targets = descriptor.definition?.target_node_ids ?? descriptor.readNodeIds;
  const definition = configuration.registries.checks[requestedCheckId];
  const graphSet = optionalRecord(definition?.graph_set);
  if (definition?.kind !== "composite" || graphSet?.members === undefined) {
    return [...new Set(targets)].filter((id) => graph.node(id) !== undefined).sort(compareText);
  }
  const evaluator = new GraphExpressionEvaluator(configuration, graph);
  const memberTypes = new Set(stringArray(graphSet.member_node_types, `${requestedCheckId} member node types`));
  const excluded = new Set(stringArray(graphSet.status_excluding, `${requestedCheckId} excluded statuses`));
  return evaluator.withBinding("target", targets, () => evaluator.select(graphSet.members!))
    .filter((id) => {
      const node = graph.node(id);
      return node !== undefined && (memberTypes.size === 0 || memberTypes.has(node.type)) && !excluded.has(node.status);
    })
    .filter((id, index, values) => values.indexOf(id) === index)
    .sort(compareText);
}

function collectEvidenceLeaves(
  value: unknown,
  resolved: ResolvedAgentCheck,
  receiptTypes: ReadonlySet<string>,
  gatePolicies: ReadonlySet<string>,
  accepted: boolean,
  passed: boolean,
  output: Array<{ leaf: ConfigurationObject; result: boolean }>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) collectEvidenceLeaves(
      item,
      resolved,
      receiptTypes,
      gatePolicies,
      accepted,
      passed,
      output,
    );
    return;
  }
  if (!isRecord(value)) return;
  const op = value.op;
  if (op === "check_passed" && value.check === resolved.requestedCheckId) {
    output.push({ leaf: structuredClone(value) as ConfigurationObject, result: passed });
  } else if (op === "check_has_current_terminal" && value.check === resolved.requestedCheckId) {
    output.push({ leaf: structuredClone(value) as ConfigurationObject, result: accepted });
  } else if (op === "current_receipt" && typeof value.receipt_type === "string" && receiptTypes.has(value.receipt_type)) {
    output.push({ leaf: structuredClone(value) as ConfigurationObject, result: accepted });
  } else if (
    (op === "gate_policy_has_current_terminal" || op === "gate_policy_satisfied") &&
    typeof value.gate_policy === "string" && gatePolicies.has(value.gate_policy)
  ) {
    output.push({
      leaf: structuredClone(value) as ConfigurationObject,
      result: op === "gate_policy_satisfied" ? passed : accepted,
    });
  }
  for (const child of Object.values(value)) collectEvidenceLeaves(
    child,
    resolved,
    receiptTypes,
    gatePolicies,
    accepted,
    passed,
    output,
  );
}

function runRuleEvidence(
  run: RunRecord,
  configurationSha256: Sha256Digest,
  inputGraphSha256: Sha256Digest,
): RuleAuthorityEvidence | undefined {
  const value = run.ruleAuthorityEvidence;
  if (value === undefined) return undefined;
  if (!isRecord(value) || value.protocol !== RULE_AUTHORITY_EVIDENCE_PROTOCOL ||
      !isSha256Digest(value.configurationSha256) || !isSha256Digest(value.inputGraphSha256) ||
      !isSha256Digest(value.evidenceSha256) || !isRecord(value.predicates)) {
    fail("rule_evidence_shape", "durable rule-authority evidence is malformed");
  }
  const { evidenceSha256, ...material } = structuredClone(value);
  if (canonicalHash(material) !== evidenceSha256) fail("rule_evidence_hash", "durable rule-authority evidence failed its integrity hash");
  if (value.configurationSha256 !== configurationSha256 || value.inputGraphSha256 !== inputGraphSha256) return undefined;
  return value as unknown as RuleAuthorityEvidence;
}

function isIsoTimestamp(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function requiredToolString(args: Record<string, unknown>, field: string): string {
  const value = args[field];
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\u0000")) {
    fail("tool_arguments", `${field} must be a nonempty safe string`);
  }
  return value;
}

function optionalToolString(args: Record<string, unknown>, field: string): string | undefined {
  return args[field] === undefined ? undefined : requiredToolString(args, field);
}

function optionalToolStringArray(args: Record<string, unknown>, field: string): string[] | undefined {
  const value = args[field];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    fail("tool_arguments", `${field} must be an array of nonempty strings`);
  }
  return value as string[];
}

function optionalToolInteger(args: Record<string, unknown>, field: string): number | undefined {
  const value = args[field];
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value)) fail("tool_arguments", `${field} must be an integer`);
  return value as number;
}

function requiredToolInteger(args: Record<string, unknown>, field: string): number {
  const value = optionalToolInteger(args, field);
  if (value === undefined) fail("tool_arguments", `${field} is required`);
  return value;
}

function dynamicRelationArcs(
  configuration: CompiledConfiguration,
  graph: TypedGraph,
): Array<{ from: string; relation: string; to: string }> {
  const arcs: Array<{ from: string; relation: string; to: string }> = [];
  for (const edge of graph.edges()) {
    arcs.push({ from: edge.source, relation: edge.relation, to: edge.target });
    const source = graph.node(edge.source);
    const target = graph.node(edge.target);
    const definition = source === undefined || target === undefined ? undefined : configuration.edge_types.find((candidate) =>
      candidate.source === source.type &&
      candidate.relation === edge.relation &&
      Array.isArray(candidate.targets) &&
      candidate.targets.includes(target.type));
    if (definition?.bidirectional === true && typeof definition.inverse === "string") {
      arcs.push({ from: edge.target, relation: definition.inverse, to: edge.source });
    }
  }
  return arcs.sort((left, right) =>
    compareText(left.from, right.from) || compareText(left.relation, right.relation) || compareText(left.to, right.to));
}

function parseDynamicGraphSelectionRequest(args: Record<string, unknown>): DynamicGraphSelectionRequest {
  const anchors = optionalToolStringArray(args, "anchors");
  const relations = optionalToolStringArray(args, "relations");
  const nodeTypes = optionalToolStringArray(args, "nodeTypes");
  const direction = optionalToolString(args, "direction");
  if (direction !== undefined && direction !== "outgoing" && direction !== "incoming" && direction !== "both") {
    fail("graph_context_direction", `unsupported graph context direction ${direction}`);
  }
  const maxDepth = optionalToolInteger(args, "maxDepth") ?? 1;
  if (maxDepth < 0 || maxDepth > 16) {
    fail("graph_context_depth", "graph context depth must be between zero and sixteen");
  }
  return {
    ...(anchors === undefined ? {} : { anchors }),
    ...(relations === undefined ? {} : { relations }),
    ...(direction === undefined ? {} : { direction }),
    maxDepth,
    ...(nodeTypes === undefined ? {} : { nodeTypes }),
  };
}

function normalizeReferencedPaths(
  values: readonly string[],
  grant: AuthorityGrant,
  label: string,
): string[] {
  const scopes = [...new Set([...grant.readPaths, ...grant.writePaths])];
  const output = new Set<string>();
  for (const value of values) {
    if (
      value !== "." &&
      (value.length === 0 || value.length > 16 * 1024 || value.startsWith("/") || /^[A-Za-z]:\//u.test(value) || value.includes("\\") ||
        value.includes("\u0000") || value.split("/").some((part) => part === "" || part === "." || part === ".."))
    ) fail(`${label.replaceAll(" ", "_")}_path`, `${label} path ${value} is not normalized and repository-relative`);
    if (!scopes.some((scope) => scope === "." || value === scope || value.startsWith(`${scope}/`))) {
      fail(`${label.replaceAll(" ", "_")}_scope`, `${label} path ${value} is outside this attempt's read/write scope`);
    }
    output.add(value);
  }
  return [...output].sort(compareText);
}

function contextualProvenance<Kind extends "owner_update" | "change_note">(
  kind: Kind,
  run: RunRecord,
  attempt: AgentAttemptRecord,
  spec: Readonly<AgentLaunchSpec>,
  semanticRevision: number,
  semanticHash: Sha256Digest,
  contextual: GraphContextualState,
  recordedAt: string,
): ContextualRecordProvenance & { kind: Kind } {
  return {
    kind,
    runId: run.id,
    generation: run.generation,
    ticketId: attempt.ticketId,
    stepId: attempt.stepId,
    attemptId: attempt.id,
    sessionId: attempt.sessionId,
    personaId: attempt.personaId,
    authorityGrantHash: spec.authority.grantHash,
    launchSpecHash: spec.specHash,
    authoritativeContextHash: spec.authority.authoritativeContextHash,
    semanticRevision,
    semanticHash,
    contextualRevision: contextual.revision,
    contextualHash: contextual.hash,
    lineage: structuredClone(spec.lineage),
    recordedAt,
  };
}

function compatibleAttemptLineage(
  run: RunRecord,
  active: AgentAttemptRecord,
): { compatible: Set<string>; abandoned: Set<string> } {
  const abandoned = new Set(Object.values(run.attempts)
    .filter((attempt) => new Set<AttemptStatus>(["failed", "aborted", "interrupted"]).has(attempt.status))
    .map((attempt) => attempt.id));
  const ancestors = new Set<string>([active.id]);
  let cursor: AgentAttemptRecord | undefined = active;
  while (cursor?.lineage?.parentAttemptId !== undefined && !ancestors.has(cursor.lineage.parentAttemptId)) {
    ancestors.add(cursor.lineage.parentAttemptId);
    cursor = run.attempts[cursor.lineage.parentAttemptId];
  }
  const compatible = new Set<string>();
  for (const attempt of Object.values(run.attempts)) {
    if (abandoned.has(attempt.id)) continue;
    if (ancestors.has(attempt.id) || attempt.lineage === undefined || attempt.lineage.branchEpoch === 0) {
      compatible.add(attempt.id);
    }
  }
  compatible.add(active.id);
  return { compatible, abandoned };
}

function isGraphNoteKind(value: unknown): value is GraphNoteArtifact["kind"] {
  return value === "observation" || value === "implementation_detail" || value === "rationale" ||
    value === "nit" || value === "open_question";
}

function compilerActivity(run: RunRecord, message: string, salt: string): RunActivityRecord {
  const at = new Date().toISOString();
  return {
    id: `activity-${digestBody(canonicalHash([run.id, run.revision, salt, message])).slice(0, 20)}`,
    at,
    kind: "compiler",
    message,
    ticketId: undefined,
    nodeId: undefined,
  };
}

function graphActivity(
  run: RunRecord,
  kind: Extract<RunActivityRecord["kind"], "graph_added" | "graph_modified" | "graph_deleted">,
  node: Pick<GraphNode, "id" | "type" | "title">,
  salt: string,
): RunActivityRecord {
  const verb = kind === "graph_added" ? "Added" : kind === "graph_deleted" ? "Deleted" : "Modified";
  return {
    id: `activity-${digestBody(canonicalHash([run.id, run.revision, salt, kind, node.id])).slice(0, 20)}`,
    at: new Date().toISOString(),
    kind,
    message: `${verb} ${node.type}: ${node.title}`,
    ticketId: salt.startsWith("TK-") ? salt : undefined,
    nodeId: node.id,
  };
}

function boundedContext(value: unknown): string {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(content, "utf8") > MAX_CONTEXT_BYTES || content.includes("\u0000")) fail("context_size", "compiler-issued context is oversized or unsafe");
  return content;
}

function graphArtifactPath(runId: string): string { return `runs/${runId}/program/graph.json`; }
function ticketDefinitionsPath(runId: string): string { return `runs/${runId}/program/ticket-definitions.json`; }
function pinnedConfigurationPath(runId: string): string { return `runs/${runId}/configuration/compiled.json`; }
function evaluationPath(runId: string, revision: number): string { return `runs/${runId}/program/evaluations/${revision}.json`; }
function graphNotePath(runId: string, noteId: string): string { return `runs/${runId}/program/notes/${noteId}.json`; }

function encodeRunGraphArtifact(value: GraphArtifact): Buffer {
  const bytes = encodeArtifact(value);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_RUN_GRAPH_BYTES || bytes.includes(0)) {
    fail("graph_artifact_size", "completed run-graph artifact exceeds its durable byte bound");
  }
  return bytes;
}

function encodeArtifact(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function requireValidation<Value>(
  result: ValidationResult<Value>,
  code: string,
  message: string,
): Value {
  if (!result.ok) throw new NativeRunProgramError(code, message, diagnosticLines(result.diagnostics));
  return result.value;
}

function diagnosticLines(diagnostics: readonly CompilerDiagnostic[]): string[] {
  return diagnostics.map((item) => `${item.code} ${item.path}: ${item.message}`);
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) fail("shape", `${label} must be an object`);
  return value;
}

function optionalRecord(value: unknown): ConfigurationObject | undefined {
  return value === undefined || value === null || !isRecord(value) ? undefined : value as ConfigurationObject;
}

function jsonRecord(value: unknown, label: string): Record<string, JsonValue> {
  const record = requiredRecord(value, label);
  assertJsonValue(record, label);
  return structuredClone(record) as Record<string, JsonValue>;
}

function assertJsonValue(value: unknown, label: string): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return;
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item, label);
    return;
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (key.length === 0 || key.includes("\u0000")) fail("json_key", `${label} contains an invalid key`);
      assertJsonValue(item, label);
    }
    return;
  }
  fail("json_value", `${label} contains a non-JSON value`);
}

function assertExactFields(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  assertAllowedFields(record, allowed, label);
  for (const key of allowed) if (!Object.hasOwn(record, key)) fail("missing_field", `${label} is missing ${key}`);
}

function assertAllowedFields(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const accepted = new Set(allowed);
  for (const key of Object.keys(record)) if (!accepted.has(key)) fail("unknown_field", `${label} contains unknown field ${key}`);
}

function requiredNonempty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\u0000")) fail("string", `${label} must be a nonempty safe string`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredNonempty(value, "configured string");
}

function boundedText(value: unknown, label: string, maximum: number): string {
  const text = requiredNonempty(value, label);
  if (Buffer.byteLength(text, "utf8") > maximum) fail("text_size", `${label} exceeds ${maximum} UTF-8 bytes`);
  return text;
}

function stringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) fail("string_array", `${label} must contain strings`);
  return [...new Set(value as string[])].sort(compareText);
}

function optionalSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function requireDigest(value: unknown, label: string): Sha256Digest {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) fail("digest", `${label} must be a sha256 digest`);
  return value as Sha256Digest;
}

function withoutField(value: object, field: string): Record<string, unknown> {
  const cloned = structuredClone(value) as Record<string, unknown>;
  delete cloned[field];
  return cloned;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareText(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}

function normalizeResourcePath(value: string): string {
  if (
    value.length === 0 ||
    value.includes("\u0000") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    path.posix.normalize(value) !== value ||
    value.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) fail("resource_path", `resource path ${value} is not a safe normalized relative path`);
  return value;
}

function isWithinDirectory(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function digestBody(value: Sha256Digest): string { return value.slice("sha256:".length); }

function humanize(value: string): string {
  return value.split(/[-_]/u).filter(Boolean).map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join(" ");
}

function shortOid(value: string): string { return value.slice(0, 12); }

function attemptWorkspace(
  run: RunRecord,
  kind: "planning" | "ticket" | "verification" | "integration",
  ticketId: string,
): string {
  if (kind === "planning") {
    // Legacy flat-layout runs already planned in their permanent checkout. Once the
    // authority has proof-settled relocation, that locked checkout is their only
    // resumable workspace. Native runs still require the detached planner below.
    if (
      run.legacyGitMigration?.status === "relocated" &&
      run.git.run.status === "ready" &&
      run.git.run.headOid !== undefined
    ) {
      return path.resolve(run.git.run.worktree);
    }
    if (run.git.planning.status !== "ready") {
      fail("planning_workspace", "planning attempt has no ready detached checkout");
    }
    return path.resolve(run.git.planning.worktree);
  }
  if (kind === "verification") {
    if (run.git.run.status !== "ready" || run.git.run.headOid === undefined) {
      fail("run_workspace", "verification attempt has no approved run checkout");
    }
    return path.resolve(run.git.run.worktree);
  }
  const ticket = run.tickets[ticketId];
  if (ticket === undefined || ticket.gitCycleId === undefined) {
    fail("ticket_workspace", `ticket ${ticketId} has no authority-issued Git cycle`);
  }
  const cycle = run.git.ticketCycles[ticket.gitCycleId];
  if (
    cycle === undefined ||
    cycle.ticketId !== ticketId ||
    ticket.worktreePath !== cycle.worktree ||
    ticket.branch !== cycle.branchRef ||
    (cycle.status !== "active" && cycle.status !== "candidate")
  ) {
    fail("ticket_workspace", `ticket ${ticketId} Git cycle is missing, stale, or not executable`);
  }
  return path.resolve(cycle.worktree);
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function fail(code: string, message: string, details: readonly string[] = []): never {
  throw new NativeRunProgramError(code, message, details);
}
