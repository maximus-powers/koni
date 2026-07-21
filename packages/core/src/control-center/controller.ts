import { randomUUID } from "node:crypto";
import { AuthorityClientError } from "../authority/client.js";
import { CONFIG_DOCUMENT_DOMAINS } from "../authority/config-documents.js";
import {
  MAX_RUN_SUMMARY_PAGE_LIMIT,
  parseRunSummaryPage,
  projectRunSummary,
  type RunSummary,
} from "../authority/run-summary-page.js";
import type { JsonValue, RpcEvent, RpcSuccess } from "../authority/protocol.js";
import type { ConfigurationObject, ConfigurationValue } from "../contracts/configuration.js";
import type { GraphEdge, GraphNode } from "../graph/model.js";
import { sealedModelAdmissionIssue } from "../pi/model-catalog.js";
import { canonicalEncode } from "../shared/canonical.js";
import { assertRunRecord, type RunRecord } from "../state/run-record.js";
import {
  STAGE_ACTION_INVOCATION_PROTOCOL,
  type StageActionCapability,
  type StageActionFieldSchema,
  type StageActionValue,
  type StageCapabilityBinding,
  type StageCapabilityCatalog,
} from "../state/stage-capability.js";
import type { ControlCenterKeyAction, ControlCenterPanel } from "./input.js";
import {
  parseConfigCatalog,
  parseConfigDocumentCatalog,
  parseConfigDocumentMutation,
  parseConfigDocumentSource,
  parseConfigLegacyMigrationPreview,
  parseConfigLegacyMigrationResult,
  parseConfigRunTypeTemplates,
  parseConfigSnapshot,
  parseControlCatalog,
  parseControlProposalInspection,
  parseProfileConflictCatalog,
  parseProfileConflictInspection,
  parseRunDeletionPreview,
  parseRunAttemptLineage,
  parseRunMergePreview,
  parseStageCapabilityCatalog,
  THINKING_LEVELS,
  type ConfigCatalog,
  type ConfigDocumentCatalog,
  type ConfigDocumentDomain,
  type ConfigDocumentSource,
  type ConfigLegacyMigrationPreview,
  type ConfigResourceKind,
  type ConfigRunTypeTemplates,
  type ConfigFieldDefinition,
  type ConfigResourceCreateOption,
  type ConfigSnapshot,
  type ControlCatalog,
  type ControlProposalInspection,
  type ControlModelOption,
  type ControlIntakeField,
  type ControlRoleDefault,
  type ControlRunTypeOption,
  type ControlThinkingLevel,
  type ControlProfileConflictCatalog,
  type ControlProfileConflictInspection,
  type ControlRunDeletionPreview,
  type ControlRunAttemptLineage,
  type ControlRunMergePreview,
} from "./protocol.js";
import {
  parsePiTranscriptPage,
  TRANSCRIPT_PAGE_LIMIT,
  type TranscriptBlock,
  type TranscriptPageProjection,
} from "./transcript.js";
import {
  buildControlCenterView,
  type ControlCenterSelection,
  type ControlCenterViewModel,
  type DetailsTab,
  type ProvisionalRunView,
  type QuestionView,
  TICKET_TABS,
  type TicketTab,
} from "./view-model.js";
import {
  cockpitStringArrayOption,
  cockpitStringOption,
  cockpitView,
  parseCompiledCockpitViewCatalog,
  type CompiledCockpitViewCatalog,
  type ControlCenterCockpitCatalogResolver,
} from "./cockpit-config.js";

export interface ControlCenterAuthorityClient {
  readonly revision: number;
  request(
    method: string,
    params?: Parameters<import("../authority/client.js").AuthorityClient["request"]>[1],
    options?: Parameters<import("../authority/client.js").AuthorityClient["request"]>[2],
  ): Promise<RpcSuccess>;
  onEvent?(listener: (event: RpcEvent) => void): () => void;
  close?(): void;
}

export interface QuestionDraftState {
  questionId: string;
  selectedOptionId: string | undefined;
  notes: string;
  editingNotes: boolean;
}

export interface NewRunRoleSelection extends ControlRoleDefault {}

export interface NewRunModalState {
  kind: "new_run";
  objective: string;
  /** Character offset rather than a UTF-16 or byte offset. */
  objectiveCursor: number;
  intake: Record<string, ConfigurationValue>;
  intakeText: Record<string, string>;
  intakeCursors: Record<string, number>;
  intakeOptionIndexes: Record<string, number>;
  runTypeId: string;
  branches: readonly { label: string; reference: string }[];
  branchIndex: number;
  questionPolicy: "none" | "some" | "many";
  maxParallel: number;
  roles: readonly NewRunRoleSelection[];
  focus: string;
  stageScroll: number;
}

export interface PlanReviewModalState {
  kind: "plan_review";
  runId: string;
  sectionIndex: number;
  scroll: number;
  focus: "document" | "steering" | "action";
  steering: string;
  /** Character offset rather than a UTF-16 or byte offset. */
  steeringCursor: number;
}

export interface ProposalReviewModalState {
  kind: "proposal_review";
  proposal: ControlProposalInspection;
  scroll: number;
  focus: "document" | "message" | "choice" | "submit";
  decision: "approval" | "rejection" | undefined;
  message: string;
  /** Character offset rather than a UTF-16 or byte offset. */
  messageCursor: number;
}

export interface ConfigureModalState {
  kind: "configure";
  catalog: ConfigCatalog;
  snapshot: ConfigSnapshot;
  draft: Record<string, JsonValue>;
  sectionIndex: number;
  resourceIndex: number;
  fieldIndex: number;
  focus: "tree" | "field" | "actions" | "publish";
  actionIndex: number;
  editing: boolean;
  dirty: boolean;
  rebaseRequired: boolean;
  textEditor?: { key: string; value: string };
  resourceOperation?: ConfigResourceOperationState;
  upstreamConflicts: ControlProfileConflictCatalog;
}

export interface ProfileConflictsModalState {
  kind: "profile_conflicts";
  catalog: ControlProfileConflictCatalog;
  selectedIndex: number;
  inspection: ControlProfileConflictInspection;
  focus: "list" | "actions";
  actionIndex: number;
  scroll: number;
  returnTo: ConfigureModalState;
}

export interface ConfigureDocumentsModalState {
  kind: "configure_documents";
  catalog: ConfigDocumentCatalog;
  domainIndex: number;
  documentIndex: number;
  source?: ConfigDocumentSource;
  draft: string;
  cursor: number;
  scroll: number;
  focus: "domains" | "documents" | "editor";
  editing: boolean;
  dirty: boolean;
  returnTo: ConfigureModalState;
}

export interface ConfigDocumentCreateChoice {
  label: string;
  description: string;
  domain: ConfigDocumentDomain;
  kind: ConfigResourceKind;
  format: "yaml" | "toml" | "markdown";
}

export interface ConfigDocumentCreateModalState {
  kind: "config_document_create";
  returnTo: ConfigureDocumentsModalState;
  choices: readonly ConfigDocumentCreateChoice[];
  choiceIndex: number;
  title: string;
  cursor: number;
  focus: "choice" | "title" | "submit";
}

export interface ConfigDocumentRenameModalState {
  kind: "config_document_rename";
  returnTo: ConfigureDocumentsModalState;
  documentId: string;
  title: string;
  cursor: number;
  focus: "title" | "submit";
}

export interface ConfigDocumentDeleteModalState {
  kind: "config_document_delete";
  returnTo: ConfigureDocumentsModalState;
  documentId: string;
  title: string;
  canDelete: boolean;
  reason?: string;
  selected: "cancel" | "delete";
}

export interface ConfigRunTypeWizardModalState {
  kind: "config_run_type_wizard";
  returnTo: ConfigureDocumentsModalState;
  templates: ConfigRunTypeTemplates;
  templateIndex: number;
  title: string;
  slug: string;
  description: string;
  makeDefault: boolean;
  focus: "template" | "title" | "slug" | "description" | "default" | "submit";
  cursor: number;
}

export interface ConfigLegacyMigrationModalState {
  kind: "config_legacy_migration";
  returnTo: ConfigureDocumentsModalState;
  preview: ConfigLegacyMigrationPreview;
  selected: "cancel" | "apply";
}

export interface AnswerQuestionModalState {
  kind: "answer_question";
  questionId: string;
  focus: "choices" | "notes" | "submit";
}

export interface ActionPaletteModalState {
  kind: "action_palette";
  title: string;
  actions: readonly StageActionCapability[];
  selectedIndex: number;
}

export interface ActionFormModalState {
  kind: "action_form";
  binding: StageCapabilityBinding;
  action: StageActionCapability;
  values: Record<string, StageActionValue>;
  fieldIndex: number;
  focus: "fields" | "confirmation" | "submit";
  editing: boolean;
  cursor: number;
  confirmed: boolean;
  error?: string;
}

export interface EditScalarModalState {
  kind: "edit_scalar";
  field: ConfigFieldDefinition;
  value: string;
  /** Character offset rather than a UTF-16 or byte offset. */
  cursor: number;
  error?: string;
  returnTo: ConfigureModalState;
}

export interface DeleteRunModalState {
  kind: "delete";
  runId: string;
  title: string;
  objective: string;
  state: string;
  targetBranch: string;
  ownedWorktrees: number;
  ownedBranches: number;
  liveAgents: number;
  dirtyWorktreeWarnings: readonly string[];
  blockers: readonly string[];
  canPreserveBranches: boolean;
  canDeleteOwnedBranches: boolean;
  previewToken: ControlRunDeletionPreview["previewToken"];
  selected: "cancel" | "preserve_branches" | "delete_owned_branches";
}

export interface MergeRunModalState {
  kind: "merge";
  runId: string;
  title: string;
  targetBranch: string;
  state: string;
  completedTickets: number;
  totalTickets: number;
  targetAdvanced: boolean;
  resyncState: ControlRunMergePreview["resyncState"];
  blockers: readonly string[];
  canAuthorize: boolean;
  previewToken: ControlRunMergePreview["previewToken"];
  selected: "cancel" | "authorize";
}

export interface ConfigResourceOperationState {
  kind: "create" | "duplicate" | "delete";
  focus: "template" | "name" | "confirm";
  sectionId: string;
  resourceId?: string;
  resourceTitle?: string;
  parentResourceId?: string;
  options: readonly ConfigResourceCreateOption[];
  templateIndex: number;
  name: string;
}

export type ControlCenterHelpTopic = ControlCenterPanel | "new_run" | "plan_review" | "proposal_review" | "answer_question" | "action_palette" | "action_form" | "configure" | "configure_documents" | "config_document_create" | "config_document_rename" | "config_document_delete" | "config_run_type_wizard" | "config_legacy_migration" | "profile_conflicts" | "edit_scalar" | "chat";

export type ControlCenterModalState =
  | { kind: "help"; topic: ControlCenterHelpTopic }
  | DeleteRunModalState
  | MergeRunModalState
  | NewRunModalState
  | PlanReviewModalState
  | ProposalReviewModalState
  | AnswerQuestionModalState
  | ActionPaletteModalState
  | ActionFormModalState
  | EditScalarModalState
  | ConfigureModalState
  | ConfigureDocumentsModalState
  | ConfigDocumentCreateModalState
  | ConfigDocumentRenameModalState
  | ConfigDocumentDeleteModalState
  | ConfigRunTypeWizardModalState
  | ConfigLegacyMigrationModalState
  | ProfileConflictsModalState;

export type ConfigureSurfaceState = ConfigureModalState | ConfigureDocumentsModalState;

export interface ChatDraftState {
  attemptId: string;
  mode: "steer" | "follow_up";
  text: string;
  editing: boolean;
}

export interface ChatProjectionState {
  attemptId: string;
  status: "loading" | "ready" | "unavailable" | "error";
  blocks: readonly TranscriptBlock[];
  diagnostics: readonly string[];
  history: {
    startBlock: number;
    visibleBlocks: number;
    totalBlocks: number;
    hasOlder: boolean;
    hasNewer: boolean;
  };
  error?: string;
  draft: ChatDraftState;
}

export interface ControlCenterControllerSnapshot {
  view: ControlCenterViewModel;
  selection: ControlCenterSelection;
  focus: ControlCenterPanel;
  scroll: Readonly<Record<ControlCenterPanel, number>>;
  questionIndex: number;
  ticketTab: TicketTab;
  questionDraft?: QuestionDraftState;
  modal?: ControlCenterModalState;
  /** Configure remains the visual underlay while contextual Help owns the modal layer. */
  configureSurface?: ConfigureSurfaceState;
  chat?: ChatProjectionState;
  models: readonly ControlModelOption[];
  runTypes: readonly ControlRunTypeOption[];
  busy?: string;
  notice?: { kind: "info" | "error"; message: string };
  cockpitIssue?: string;
}

export interface ControlCenterControllerOptions {
  projectRoot: string;
  client: ControlCenterAuthorityClient;
  models?: readonly ControlModelOption[];
  now?: () => number;
  onQuit?: () => void;
  closeClientOnDispose?: boolean;
  /** Exact, hash-bound compiled cockpit catalogs. Never resolve ambient/current YAML here. */
  cockpitCatalogResolver?: ControlCenterCockpitCatalogResolver;
}

interface ProvisionalRun extends ProvisionalRunView {
  durableRunId?: string;
}

interface RunInventory {
  authorityRevision: number;
  summaries: RunSummary[];
  mode: "page" | "legacy";
  startIndex: number;
  totalRuns: number;
  previousCursor?: string;
  nextCursor?: string;
}

interface StagedRunSelection {
  summaries: RunSummary[];
  provisionals: ProvisionalRun[];
  selection: ControlCenterSelection;
  selectedSummary?: RunSummary;
}

interface TranscriptState {
  status: ChatProjectionState["status"];
  runId?: string;
  /** Monotonic controller-local ownership token for an in-flight window request. */
  requestId?: number;
  requestCursor?: string;
  sessionId?: string;
  snapshotSha256?: string;
  snapshotEntryCount?: number;
  snapshotLastEntryId?: string;
  startBlock: number;
  totalBlocks: number;
  previousCursor?: string;
  nextCursor?: string;
  blocks: TranscriptBlock[];
  diagnostics: string[];
  error?: string;
}

interface TranscriptWindowExpectation {
  state: TranscriptState;
  direction: "older" | "newer";
}

interface SavedConfigDraft {
  cas: JsonValue;
  base: Record<string, JsonValue>;
  values: Record<string, JsonValue>;
}

const EMPTY_SCROLL: Record<ControlCenterPanel, number> = {
  runs: 0,
  tickets: 0,
  details: 0,
  questions: 0,
  agents: 0,
  activity: 0,
  graph: 0,
};

const DOCUMENT_CREATE_CHOICES: readonly ConfigDocumentCreateChoice[] = [
  { label: "Native agent", description: "A Pi-native persona, model, reasoning, prompt, and authority policy.", domain: "agents", kind: "native_agent", format: "yaml" },
  { label: "Skill", description: "A reusable progressive-disclosure procedure available to configured attempts.", domain: "skills", kind: "skill", format: "markdown" },
  { label: "Prompt", description: "A reusable Markdown prompt resource selected by compiled configuration.", domain: "skills", kind: "markdown_prompt", format: "markdown" },
  { label: "Advanced YAML", description: "A project-authored YAML source for an advanced custom resource.", domain: "advanced", kind: "raw_source", format: "yaml" },
  { label: "Advanced TOML", description: "A project-authored TOML source for an advanced custom resource.", domain: "advanced", kind: "raw_source", format: "toml" },
  { label: "Advanced Markdown", description: "A project-authored Markdown source for an advanced custom resource.", domain: "advanced", kind: "raw_source", format: "markdown" },
];

const LEGACY_RUN_LIST_LIMIT = MAX_RUN_SUMMARY_PAGE_LIMIT;
const MAX_RUN_PAGE_RESTARTS = 3;
/** Retain a finite recent-agent working set; every entry contains at most one 64-block window. */
const MAX_TRANSCRIPT_WINDOWS = 4;

/** Shared, authority-backed controller for Pi `/koni` and manually invoked `koni tui`. */
export class ControlCenterController {
  readonly #projectRoot: string;
  readonly #client: ControlCenterAuthorityClient;
  readonly #models: ControlModelOption[];
  readonly #now: () => number;
  readonly #onQuit: (() => void) | undefined;
  readonly #closeClientOnDispose: boolean;
  readonly #cockpitCatalogResolver: ControlCenterCockpitCatalogResolver | undefined;
  readonly #cockpitCatalogs = new Map<string, CompiledCockpitViewCatalog>();
  readonly #listeners = new Set<(snapshot: ControlCenterControllerSnapshot) => void>();
  readonly #questionDrafts = new Map<string, QuestionDraftState>();
  readonly #chatDrafts = new Map<string, ChatDraftState>();
  readonly #transcripts = new Map<string, TranscriptState>();
  readonly #transcriptReloadPending = new Set<string>();
  readonly #approvalSeen = new Set<string>();
  #unsubscribeAuthority: (() => void) | undefined;
  #runSummaries: RunSummary[] = [];
  #selectedRun: RunRecord | undefined;
  #summaryAuthorityRevision: number | undefined;
  #runPageRpcAvailable: boolean | undefined;
  #runPageStartIndex = 0;
  #runTotalRuns = 0;
  #runPreviousCursor: string | undefined;
  #runNextCursor: string | undefined;
  #provisionals: ProvisionalRun[] = [];
  #controlCatalog: ControlCatalog | undefined;
  #graph: { nodes: GraphNode[]; edges: GraphEdge[] } | undefined;
  #graphRpcAvailable: boolean | undefined;
  #controls: StageCapabilityCatalog | undefined;
  #controlsRpcAvailable: boolean | undefined;
  #lineage: ControlRunAttemptLineage | undefined;
  #lineageRpcAvailable: boolean | undefined;
  #cockpit: CompiledCockpitViewCatalog | undefined;
  #cockpitIssue: string | undefined;
  #transcriptRpcAvailable: boolean | undefined;
  #transcriptRequestSequence = 0;
  #profileConflictRpcAvailable: boolean | undefined;
  #selection: ControlCenterSelection = { detailsTab: "overview", objectiveExpanded: false };
  #focus: ControlCenterPanel = "runs";
  #scroll = { ...EMPTY_SCROLL };
  #questionIndex = 0;
  #ticketTab: TicketTab = "all";
  #detailsTabBeforeChat: DetailsTab = "overview";
  #modal: ControlCenterModalState | undefined;
  #suspendedModal: ControlCenterModalState | undefined;
  #savedConfigDraft: SavedConfigDraft | undefined;
  #busy: string | undefined;
  #notice: ControlCenterControllerSnapshot["notice"];
  #refreshPromise: Promise<void> | undefined;
  #refreshAgain = false;
  #disposed = false;

  public constructor(options: ControlCenterControllerOptions) {
    this.#projectRoot = options.projectRoot;
    this.#client = options.client;
    this.#models = normalizeModels(options.models ?? []);
    this.#now = options.now ?? Date.now;
    this.#onQuit = options.onQuit;
    this.#closeClientOnDispose = options.closeClientOnDispose ?? false;
    this.#cockpitCatalogResolver = options.cockpitCatalogResolver;
    this.#unsubscribeAuthority = this.#client.onEvent?.((event) => {
      if (event.topic === "authority.ready") return;
      if (event.topic.startsWith("agent.")) {
        const attemptId = this.#selection.attemptId;
        const attempt = attemptId === undefined ? undefined : this.#selectedRunRecord()?.attempts[attemptId];
        if (attemptId !== undefined && attempt !== undefined && isActiveAttempt(attempt.status)) {
          this.#reloadTranscript(attemptId);
        }
      }
      void this.refresh();
    });
  }

  public get snapshot(): ControlCenterControllerSnapshot {
    const view = this.#buildView();
    const currentQuestion = this.#currentQuestion(view);
    const chat = this.#chatProjection();
    const configureSurface = this.#configureSurface();
    return {
      view,
      selection: { ...this.#selection },
      focus: this.#focus,
      scroll: { ...this.#scroll },
      questionIndex: this.#questionIndex,
      ticketTab: this.#ticketTab,
      ...(currentQuestion === undefined ? {} : { questionDraft: { ...this.#draftFor(currentQuestion) } }),
      ...(this.#modal === undefined ? {} : { modal: cloneModal(this.#modal) }),
      ...(configureSurface === undefined ? {} : { configureSurface: structuredClone(configureSurface) }),
      ...(chat === undefined ? {} : { chat }),
      models: this.#models.map((model) => ({ ...model })),
      runTypes: this.#controlCatalog?.runTypes.map((runType) => structuredClone(runType)) ?? [],
      ...(this.#busy === undefined ? {} : { busy: this.#busy }),
      ...(this.#notice === undefined ? {} : { notice: { ...this.#notice } }),
      ...(this.#cockpitIssue === undefined ? {} : { cockpitIssue: this.#cockpitIssue }),
    };
  }

  #configureSurface(): ConfigureSurfaceState | undefined {
    const candidate = this.#modal?.kind === "help" ? this.#suspendedModal : this.#modal;
    if (candidate?.kind === "configure" || candidate?.kind === "configure_documents") return candidate;
    if (candidate?.kind === "edit_scalar") return candidate.returnTo;
    if (candidate?.kind === "profile_conflicts") return candidate.returnTo;
    if (candidate?.kind === "config_document_create" || candidate?.kind === "config_document_rename" ||
        candidate?.kind === "config_document_delete" || candidate?.kind === "config_run_type_wizard" ||
        candidate?.kind === "config_legacy_migration") return candidate.returnTo;
    return undefined;
  }

  public subscribe(listener: (snapshot: ControlCenterControllerSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public async initialize(): Promise<void> {
    await this.refresh();
  }

  public async refresh(): Promise<void> {
    if (this.#disposed) return;
    if (this.#refreshPromise !== undefined) {
      this.#refreshAgain = true;
      return this.#refreshPromise;
    }
    const operation = this.#refreshLoop();
    this.#refreshPromise = operation;
    try {
      await operation;
    } finally {
      this.#refreshPromise = undefined;
    }
  }

  public async handle(action: ControlCenterKeyAction): Promise<void> {
    if (this.#disposed) return;
    if (action.type === "quit") {
      const configure = this.#configureSurface();
      if (configure?.dirty === true) {
        this.#notice = {
          kind: "error",
          message: configure.kind === "configure" && configure.rebaseRequired
            ? "This saved draft is stale. Rebase, publish, or discard it before closing Koni."
            : configure.kind === "configure_documents"
              ? "Save or discard the raw source edit before closing Koni."
              : "Publish or discard the configuration draft before closing Koni; unpublished edits were not discarded.",
        };
        this.#emit();
        return;
      }
      this.#onQuit?.();
      return;
    }
    if (action.type === "cancel") {
      this.#cancel();
      return;
    }
    if (this.#modal !== undefined) {
      await this.#handleModal(action);
      return;
    }
    switch (action.type) {
      case "focus": {
        const question = this.#currentQuestion(this.#buildView());
        if (question !== undefined) this.#draftFor(question).editingNotes = false;
        this.#moveFocus(action.delta);
        break;
      }
      case "focus_panel": this.#setFocus(action.panel); break;
      case "select_run": await this.#selectRun(action.runId); break;
      case "select_ticket": await this.#selectTicket(action.ticketId); break;
      case "select_agent": this.#selectAgent(action.attemptId); break;
      case "pointer_scroll": this.#pointerScroll(action.panel, action.delta); break;
      case "pointer_control": this.#handlePointerControl(action.target); break;
      case "move": await this.#move(action.delta); break;
      case "page": this.#scrollBy(action.delta * 8); break;
      case "scroll_home": this.#scrollToBoundary(false); break;
      case "scroll_end": this.#scrollToBoundary(true); break;
      case "details_tab": this.#moveHorizontal(action.delta); break;
      case "activate": await this.#activate(); break;
      case "toggle_objective": this.#toggleObjective(); break;
      case "toggle_pause": await this.#togglePause(); break;
      case "request_delete": await this.#requestDelete(); break;
      case "merge": await this.#requestMerge(); break;
      case "help": this.#openHelp(this.#focus === "details" && this.#selection.detailsTab === "chat" ? "chat" : this.#focus); break;
      case "toggle_notes": this.#toggleNotes(); break;
      case "backspace": this.#editActiveText((value) => removeLastCharacter(value)); break;
      case "delete_forward": break;
      case "append_text": this.#editActiveText((value) => `${value}${action.text}`); break;
      case "open_new_run": await this.#openNewRun(); break;
      case "open_config": await this.#openConfigure(); break;
      case "open_config_documents": break;
      case "config_document_create":
      case "config_document_rename":
      case "config_document_delete":
      case "config_run_type_create":
      case "config_legacy_migration":
        break;
      case "open_conflicts": break;
      case "review_plan": this.#openPlanReview(false); break;
      case "review_proposal": await this.#openSelectedProposal(); break;
      case "open_actions": this.#openActions(); break;
      case "open_question": this.#openSelectedQuestion(); break;
      case "refresh": {
        const chatAttemptId = this.#selection.detailsTab === "chat" ? this.#selection.attemptId : undefined;
        await this.refresh();
        if (chatAttemptId !== undefined && this.#selection.attemptId === chatAttemptId &&
            this.#transcriptRpcAvailable !== false) {
          this.#transcripts.delete(chatAttemptId);
          await this.#replaceTranscriptWindow(chatAttemptId);
        }
        break;
      }
      case "toggle_chat_composer": this.#toggleChatComposer(); break;
      case "toggle_chat_mode": this.#toggleChatMode(); break;
      case "transcript_page": await this.#moveTranscriptWindow(action.delta); break;
      case "submit": await this.#sendChat(); break;
      case "save_draft":
      case "publish":
      case "discard_draft":
      case "rebase_draft":
      case "config_resource_create":
      case "config_resource_duplicate":
      case "config_resource_delete":
        break;
    }
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribeAuthority?.();
    this.#unsubscribeAuthority = undefined;
    this.#listeners.clear();
    if (this.#closeClientOnDispose) this.#client.close?.();
  }

  async #refreshLoop(): Promise<void> {
    do {
      this.#refreshAgain = false;
      try {
        await this.#refreshRunInventory();
        await this.#refreshSelectionProjections();
        this.#maybeOpenApproval();
        this.#notice = undefined;
      } catch (error) {
        this.#notice = { kind: "error", message: errorMessage(error) };
      }
      this.#emit();
    } while (this.#refreshAgain && !this.#disposed);
  }

  async #refreshRunInventory(): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_RUN_PAGE_RESTARTS; attempt += 1) {
      try {
        const inventory = await this.#loadRunInventory(this.#preferredDurableRunId());
        const staged = this.#stageRunSelection(inventory.summaries);
        const selectedRun = staged.selectedSummary === undefined
          ? undefined
          : await this.#hydrateRun(staged.selectedSummary, inventory.authorityRevision, inventory.mode);
        this.#commitRunInventory(inventory, staged, selectedRun);
        return;
      } catch (error) {
        lastError = error;
        if (!isRunPageStale(error) || attempt + 1 >= MAX_RUN_PAGE_RESTARTS) throw error;
      }
    }
    throw lastError;
  }

  async #loadRunInventory(preferredRunId?: string): Promise<RunInventory> {
    if (this.#runPageRpcAvailable === false) return this.#loadLegacyRunInventory();
    try {
      let inventory: RunInventory;
      try {
        inventory = await this.#loadRunWindow(preferredRunId);
      } catch (error) {
        // A selected run can be deleted between local selection and the next refresh. Recover to
        // the canonical first page once; ordinary refreshes remain one bounded page request.
        if (preferredRunId === undefined || !isRunPageTarget(error)) throw error;
        inventory = await this.#loadRunWindow();
      }
      this.#runPageRpcAvailable = true;
      return inventory;
    } catch (error) {
      if (!isMissingMethod(error)) throw error;
      this.#runPageRpcAvailable = false;
      return this.#loadLegacyRunInventory();
    }
  }

  async #loadRunWindow(preferredRunId?: string): Promise<RunInventory> {
    const { page, responseRevision } = await this.#requestRunPage(
      preferredRunId === undefined ? {} : { aroundRunId: preferredRunId },
    );
    if (page.includeDeleted || responseRevision !== page.revision) {
      throw new RunPageRefreshError("run summary page response revision does not match its anchor");
    }
    if (preferredRunId !== undefined && page.runs[0]?.id !== preferredRunId) {
      throw new Error("authority returned a run summary page that does not begin at its selected target");
    }
    return this.#inventoryFromPage(page);
  }

  async #requestRunPage(options: { cursor?: string; aroundRunId?: string } = {}): Promise<{
    page: ReturnType<typeof parseRunSummaryPage>;
    responseRevision: number;
  }> {
    const response = await this.#client.request("run.page", {
      limit: MAX_RUN_SUMMARY_PAGE_LIMIT,
      includeDeleted: false,
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      ...(options.aroundRunId === undefined ? {} : { aroundRunId: options.aroundRunId }),
    });
    return { page: parseRunSummaryPage(response.result), responseRevision: response.revision };
  }

  #inventoryFromPage(page: ReturnType<typeof parseRunSummaryPage>): RunInventory {
    return {
      authorityRevision: page.revision,
      summaries: page.runs.map((run) => structuredClone(run)),
      mode: "page",
      startIndex: page.startIndex,
      totalRuns: page.totalRuns,
      ...(page.previousCursor === undefined ? {} : { previousCursor: page.previousCursor }),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    };
  }

  async #loadLegacyRunInventory(): Promise<RunInventory> {
    const response = await this.#client.request("run.list");
    if (!Array.isArray(response.result)) throw new Error("authority returned an invalid legacy run list");
    if (response.result.length > LEGACY_RUN_LIST_LIMIT) {
      throw new Error(
        `This older Koni authority returned more than ${LEGACY_RUN_LIST_LIMIT} full runs. Restart it with run.page support before opening the control center.`,
      );
    }
    const summaries = response.result.map((value) => {
      assertRunRecord(value);
      return projectRunSummary(value);
    }).filter((run) => run.phase !== "deleted").sort(compareRunSummaryOrder);
    return {
      authorityRevision: response.revision,
      summaries,
      mode: "legacy",
      startIndex: 0,
      totalRuns: summaries.length,
    };
  }

  #preferredDurableRunId(): string | undefined {
    const selected = this.#selection.runId;
    if (selected === undefined) return undefined;
    const provisional = this.#provisionals.find((run) => run.id === selected);
    return provisional?.durableRunId ?? (provisional === undefined ? selected : undefined);
  }

  #commitRunInventory(
    inventory: RunInventory,
    staged: StagedRunSelection,
    selectedRun: RunRecord | undefined,
  ): void {
    this.#runSummaries = staged.summaries;
    this.#provisionals = staged.provisionals;
    this.#selection = staged.selection;
    this.#selectedRun = selectedRun;
    this.#summaryAuthorityRevision = inventory.authorityRevision;
    this.#runPageStartIndex = inventory.startIndex;
    this.#runTotalRuns = inventory.totalRuns;
    this.#runPreviousCursor = inventory.previousCursor;
    this.#runNextCursor = inventory.nextCursor;
    this.#reconcileSelectedDetail();
  }

  #stageRunSelection(summaries: readonly RunSummary[]): StagedRunSelection {
    let selection = { ...this.#selection };
    const durableIds = new Set(summaries.map((run) => run.id));
    for (const provisional of this.#provisionals) {
      if (provisional.durableRunId !== undefined && durableIds.has(provisional.durableRunId) &&
          selection.runId === provisional.id) {
        selection = { ...selection, runId: provisional.durableRunId };
      }
    }
    const provisionals = this.#provisionals
      .filter((row) => row.durableRunId === undefined || !durableIds.has(row.durableRunId))
      .map((row) => ({ ...row }));
    if (selection.runId !== undefined && provisionals.some((run) => run.id === selection.runId)) {
      return { summaries: summaries.map((run) => structuredClone(run)), provisionals, selection };
    }
    const selectedSummary = summaries.find((run) => run.id === selection.runId) ?? summaries[0];
    if (selectedSummary === undefined) {
      selection = provisionals.length > 0
        ? { runId: provisionals[0]!.id, detailsTab: "overview", objectiveExpanded: false }
        : { detailsTab: "overview", objectiveExpanded: false };
      return { summaries: summaries.map((run) => structuredClone(run)), provisionals, selection };
    }
    if (selection.runId !== selectedSummary.id) {
      selection = { runId: selectedSummary.id, detailsTab: "overview", objectiveExpanded: false };
    }
    return {
      summaries: summaries.map((run) => structuredClone(run)),
      provisionals,
      selection,
      selectedSummary,
    };
  }

  async #hydrateRun(
    summary: RunSummary,
    authorityRevision: number,
    mode: RunInventory["mode"],
  ): Promise<RunRecord> {
    const response = await this.#client.request("run.get", mode === "page"
      ? { runId: summary.id, authorityRevision, runRevision: summary.runRevision }
      : { runId: summary.id });
    const run = parseRunRecord(response.result);
    if (run.id !== summary.id || run.revision !== summary.runRevision) {
      throw new Error("authority returned selected run details for a different summary revision");
    }
    if (mode === "page" && !sameRunSummary(projectRunSummary(run), summary)) {
      throw new Error("authority returned selected run details that do not match the compact summary");
    }
    return run;
  }

  #reconcileSelectedDetail(): void {
    const selected = this.#selectedRunRecord();
    if (selected === undefined) {
      delete this.#selection.ticketId;
      delete this.#selection.attemptId;
      this.#questionIndex = 0;
      if (this.#focus === "questions") this.#focus = "details";
      return;
    }
    if (this.#selection.ticketId !== undefined && selected.tickets[this.#selection.ticketId] === undefined) {
      delete this.#selection.ticketId;
    }
    if (this.#selection.attemptId !== undefined && selected.attempts[this.#selection.attemptId] === undefined) {
      delete this.#selection.attemptId;
    }
    if (this.#focus === "questions" &&
        !Object.values(selected.questions).some((question) => question.answeredAt === undefined)) {
      this.#focus = "details";
    }
  }

  async #refreshGraph(): Promise<void> {
    const runId = this.#selection.runId;
    if (runId === undefined || this.#selectedRunRecord() === undefined || this.#isProvisional(runId) || this.#graphRpcAvailable === false) {
      this.#graph = undefined;
      return;
    }
    try {
      const response = await this.#client.request("run.graph", {
        runId,
        ...(this.#selection.ticketId === undefined ? {} : { ticketId: this.#selection.ticketId }),
      });
      this.#graph = parseGraph(response.result);
      this.#graphRpcAvailable = true;
    } catch (error) {
      if (isMissingMethod(error)) {
        this.#graphRpcAvailable = false;
        this.#graph = undefined;
        return;
      }
      throw error;
    }
  }

  async #refreshControls(): Promise<void> {
    const runId = this.#selection.runId;
    if (runId === undefined || this.#selectedRunRecord() === undefined || this.#isProvisional(runId) || this.#controlsRpcAvailable === false) {
      this.#controls = undefined;
      return;
    }
    try {
      const response = await this.#client.request("run.controls", { runId });
      const controls = parseStageCapabilityCatalog(response.result);
      const selected = this.#selectedRunRecord();
      if (controls.binding.runId !== runId || selected === undefined || controls.binding.runRevision !== selected.revision) {
        throw new Error("authority returned stage controls for stale run state");
      }
      if (this.#selection.runId === runId) this.#controls = controls;
      this.#controlsRpcAvailable = true;
    } catch (error) {
      if (isMissingMethod(error)) {
        this.#controlsRpcAvailable = false;
        this.#controls = undefined;
        return;
      }
      throw error;
    }
  }

  async #refreshLineage(): Promise<void> {
    const runId = this.#selection.runId;
    const ticketId = this.#selection.ticketId;
    if (runId === undefined || this.#selectedRunRecord() === undefined || this.#isProvisional(runId) || this.#lineageRpcAvailable === false) {
      this.#lineage = undefined;
      return;
    }
    try {
      const response = await this.#client.request("run.lineage", {
        runId,
        ...(ticketId === undefined ? {} : { ticketId }),
      });
      const lineage = parseRunAttemptLineage(response.result);
      const selected = this.#selectedRunRecord();
      if (lineage.runId !== runId || selected === undefined || lineage.runRevision !== selected.revision) {
        throw new Error("authority returned attempt lineage for stale run state");
      }
      if (this.#selection.runId === runId && this.#selection.ticketId === ticketId) this.#lineage = lineage;
      this.#lineageRpcAvailable = true;
    } catch (error) {
      if (isMissingMethod(error)) {
        this.#lineageRpcAvailable = false;
        this.#lineage = undefined;
        return;
      }
      throw error;
    }
  }

  async #refreshSelectionProjections(): Promise<void> {
    await Promise.all([this.#refreshGraph(), this.#refreshControls(), this.#refreshLineage(), this.#refreshCockpit()]);
  }

  async #refreshCockpit(): Promise<void> {
    const runId = this.#selection.runId;
    const run = runId === undefined ? undefined : this.#selectedRunRecord();
    if (run === undefined || this.#isProvisional(runId!) || this.#cockpitCatalogResolver === undefined) {
      this.#cockpit = undefined;
      this.#cockpitIssue = undefined;
      return;
    }
    const resolvedRunId = run.id;
    const configurationSha256 = run.compiledConfigHash;
    const cached = this.#cockpitCatalogs.get(configurationSha256);
    if (cached !== undefined) {
      this.#cockpit = cached;
      this.#cockpitIssue = undefined;
      this.#adoptCockpitTicketDefault(cached);
      return;
    }
    try {
      const projected = await this.#cockpitCatalogResolver.resolve({ runId: resolvedRunId, configurationSha256 });
      const catalog = parseCompiledCockpitViewCatalog(projected, configurationSha256);
      this.#cockpitCatalogs.set(configurationSha256, catalog);
      const selected = this.#selectedRunRecord();
      if (selected?.id === resolvedRunId && selected.compiledConfigHash === configurationSha256) {
        this.#cockpit = catalog;
        this.#cockpitIssue = undefined;
        this.#adoptCockpitTicketDefault(catalog);
      }
    } catch (error) {
      if (this.#selection.runId === resolvedRunId) {
        this.#cockpit = undefined;
        this.#cockpitIssue = `Cockpit configuration unavailable: ${errorMessage(error)}`;
      }
    }
  }

  #adoptCockpitTicketDefault(catalog: CompiledCockpitViewCatalog): void {
    const view = cockpitView(catalog, ["tabbed_table", "kanban"]);
    const tabs = cockpitStringArrayOption(view, "tabs")
      ?.filter((tab): tab is TicketTab => (TICKET_TABS as readonly string[]).includes(tab));
    if (tabs === undefined || tabs.length === 0 || tabs.includes(this.#ticketTab)) return;
    const configured = cockpitStringOption(view, "default_tab") as TicketTab | undefined;
    this.#ticketTab = configured !== undefined && tabs.includes(configured) ? configured : tabs[0]!;
    delete this.#selection.ticketId;
    delete this.#selection.attemptId;
  }

  #buildView(): ControlCenterViewModel {
    return buildControlCenterView({
      projectRoot: this.#projectRoot,
      authorityRevision: this.#summaryAuthorityRevision ?? this.#client.revision,
      runSummaries: this.#runSummaries,
      ...(this.#selectedRun === undefined ? {} : { selectedRun: this.#selectedRun }),
      runPage: {
        startIndex: this.#runPageStartIndex,
        totalRuns: this.#runTotalRuns,
        hasPrevious: this.#runPreviousCursor !== undefined,
        hasNext: this.#runNextCursor !== undefined,
      },
      provisionalRuns: this.#provisionals,
      selection: this.#selection,
      ...(this.#graph === undefined ? {} : { graph: this.#graph }),
      ...(this.#controls === undefined ? {} : { controls: this.#controls }),
      ...(this.#lineage === undefined ? {} : { lineage: this.#lineage }),
      ...(this.#cockpit === undefined ? {} : { cockpit: this.#cockpit }),
      nowMs: this.#now(),
      ticketTab: this.#ticketTab,
    });
  }

  #maybeOpenApproval(): void {
    if (this.#modal !== undefined) return;
    const run = this.#selectedRunRecord();
    if (run?.lifecycle.phase !== "awaiting_approval" || run.plan === undefined) return;
    const key = `${run.id}:${run.plan.revision}`;
    if (this.#approvalSeen.has(key)) return;
    this.#approvalSeen.add(key);
    this.#modal = {
      kind: "plan_review",
      runId: run.id,
      sectionIndex: 0,
      scroll: 0,
      focus: "document",
      steering: "",
      steeringCursor: 0,
    };
  }

  #moveFocus(delta: -1 | 1): void {
    const panels = this.#focusOrder();
    const current = Math.max(0, panels.indexOf(this.#focus));
    this.#focus = panels[(current + delta + panels.length) % panels.length]!;
    this.#emit();
  }

  #setFocus(panel: ControlCenterPanel): void {
    if (panel === "questions" && this.#buildView().selectedRun?.questions === undefined) return;
    this.#focus = panel;
    this.#emit();
  }

  #focusOrder(): ControlCenterPanel[] {
    const panels: ControlCenterPanel[] = ["runs", "tickets", "agents", "details"];
    if (this.#buildView().selectedRun?.questions !== undefined) panels.push("questions");
    panels.push("activity", "graph");
    return panels;
  }

  async #selectRun(runId: string): Promise<void> {
    if (!this.#buildView().runs.some((run) => run.id === runId)) return;
    this.#focus = "runs";
    if (this.#selection.runId === runId) {
      this.#emit();
      return;
    }
    this.#selection = { runId, detailsTab: "overview", objectiveExpanded: false };
    this.#questionIndex = 0;
    this.#scroll = { ...EMPTY_SCROLL };
    await this.#hydrateCurrentSelection();
    this.#emit();
  }

  async #hydrateCurrentSelection(): Promise<void> {
    const runId = this.#selection.runId;
    if (runId === undefined || this.#isProvisional(runId)) {
      this.#selectedRun = undefined;
      this.#clearSelectionProjections();
      return;
    }
    const summary = this.#runSummaries.find((run) => run.id === runId);
    const authorityRevision = this.#summaryAuthorityRevision;
    if (summary === undefined || authorityRevision === undefined) {
      await this.refresh();
      return;
    }
    try {
      const mode: RunInventory["mode"] = this.#runPageRpcAvailable === false ? "legacy" : "page";
      this.#selectedRun = await this.#hydrateRun(summary, authorityRevision, mode);
      this.#reconcileSelectedDetail();
      await this.#refreshSelectionProjections();
      this.#maybeOpenApproval();
      this.#notice = undefined;
    } catch (error) {
      if (isRunPageStale(error)) {
        await this.refresh();
        return;
      }
      this.#selectedRun = undefined;
      this.#clearSelectionProjections();
      this.#notice = { kind: "error", message: errorMessage(error) };
    }
  }

  #clearSelectionProjections(): void {
    this.#graph = undefined;
    this.#controls = undefined;
    this.#lineage = undefined;
    this.#cockpit = undefined;
    this.#cockpitIssue = undefined;
  }

  async #selectTicket(ticketId: string): Promise<void> {
    if (!this.#buildView().selectedRun?.tickets.some((ticket) => ticket.id === ticketId)) return;
    this.#focus = "tickets";
    this.#selection.ticketId = ticketId;
    delete this.#selection.attemptId;
    this.#scroll.agents = 0;
    await this.#refreshSelectionProjections();
    this.#emit();
  }

  #selectAgent(attemptId: string): void {
    if (!this.#buildView().selectedRun?.agents.some((agent) => agent.id === attemptId)) return;
    this.#focus = "agents";
    if (this.#selection.detailsTab !== "chat") this.#detailsTabBeforeChat = this.#selection.detailsTab;
    this.#selection.attemptId = attemptId;
    this.#selection.detailsTab = "chat";
    this.#scroll.details = 0;
    void this.#loadTranscript(attemptId);
    this.#emit();
  }

  #pointerScroll(panel: ControlCenterPanel, delta: -1 | 1): void {
    if (panel === "questions" && this.#buildView().selectedRun?.questions === undefined) return;
    this.#focus = panel;
    this.#scroll[panel] = Math.max(0, this.#scroll[panel] + delta * 3);
    this.#emit();
  }

  async #move(delta: -1 | 1): Promise<void> {
    const view = this.#buildView();
    switch (this.#focus) {
      case "runs": {
        if (await this.#moveRunWindowAtBoundary(delta)) {
          this.#emit();
          return;
        }
        const id = moveSelection(view.runs.map((run) => run.id), this.#selection.runId, delta);
        if (id !== undefined && id !== this.#selection.runId) {
          this.#selection = { runId: id, detailsTab: "overview", objectiveExpanded: false };
          this.#questionIndex = 0;
          this.#scroll = { ...EMPTY_SCROLL };
          await this.#hydrateCurrentSelection();
          this.#emit();
        }
        return;
      }
      case "tickets": {
        const id = moveSelection(view.selectedRun?.tickets.map((ticket) => ticket.id) ?? [], this.#selection.ticketId, delta);
        if (id !== undefined) {
          this.#selection.ticketId = id;
          delete this.#selection.attemptId;
          this.#scroll.agents = 0;
          await this.#refreshSelectionProjections();
          this.#emit();
        }
        return;
      }
      case "agents": {
        const id = moveSelection(view.selectedRun?.agents.map((agent) => agent.id) ?? [], this.#selection.attemptId, delta);
        if (id !== undefined) {
          if (this.#selection.detailsTab !== "chat") this.#detailsTabBeforeChat = this.#selection.detailsTab;
          this.#selection.attemptId = id;
          this.#selection.detailsTab = "chat";
          this.#scroll.details = 0;
          void this.#loadTranscript(id);
          this.#emit();
        }
        return;
      }
      case "questions": this.#moveQuestionOption(delta); return;
      case "details":
      case "activity":
      case "graph": this.#scrollBy(delta); return;
    }
  }

  async #moveRunWindowAtBoundary(delta: -1 | 1): Promise<boolean> {
    const selectedId = this.#selection.runId;
    if (selectedId === undefined || this.#isProvisional(selectedId) || this.#runPageRpcAvailable === false) {
      return false;
    }
    const boundary = delta > 0 ? this.#runSummaries.at(-1) : this.#runSummaries[0];
    const cursor = delta > 0 ? this.#runNextCursor : this.#runPreviousCursor;
    if (boundary?.id !== selectedId) return false;
    // Arrow navigation clamps at the global inventory edges. Wrapping within only the currently
    // loaded window would silently jump by up to 199 rows and misrepresent the canonical order.
    if (cursor === undefined) return true;

    for (let attempt = 0; attempt < MAX_RUN_PAGE_RESTARTS; attempt += 1) {
      try {
        const activeCursor = delta > 0 ? this.#runNextCursor : this.#runPreviousCursor;
        if (activeCursor === undefined) return true;
        const { page, responseRevision } = await this.#requestRunPage({ cursor: activeCursor });
        const expectedStart = delta > 0
          ? this.#runPageStartIndex + this.#runSummaries.length
          : this.#runPageStartIndex - page.runs.length;
        if (responseRevision !== page.revision || page.revision !== this.#summaryAuthorityRevision ||
            page.totalRuns !== this.#runTotalRuns || page.startIndex !== expectedStart) {
          throw new RunPageRefreshError("adjacent run page no longer matches the selected window");
        }
        const selectedSummary = delta > 0 ? page.runs[0] : page.runs.at(-1);
        if (selectedSummary === undefined) throw new Error("authority returned an empty adjacent run page");
        const inventory = this.#inventoryFromPage(page);
        const staged: StagedRunSelection = {
          summaries: inventory.summaries,
          provisionals: this.#provisionals.map((run) => ({ ...run })),
          selection: {
            runId: selectedSummary.id,
            detailsTab: "overview",
            objectiveExpanded: false,
          },
          selectedSummary,
        };
        const selectedRun = await this.#hydrateRun(selectedSummary, inventory.authorityRevision, "page");
        this.#commitRunInventory(inventory, staged, selectedRun);
        this.#questionIndex = 0;
        this.#scroll = { ...EMPTY_SCROLL };
        await this.#refreshSelectionProjections();
        this.#maybeOpenApproval();
        this.#notice = undefined;
        return true;
      } catch (error) {
        if (!isRunPageStale(error) || attempt + 1 >= MAX_RUN_PAGE_RESTARTS) {
          this.#notice = { kind: "error", message: errorMessage(error) };
          return true;
        }
        await this.refresh();
        const refreshedIndex = this.#runSummaries.findIndex((run) => run.id === selectedId);
        const refreshedTarget = this.#runSummaries[refreshedIndex + delta];
        if (refreshedIndex >= 0 && refreshedTarget !== undefined) {
          this.#selection = { runId: refreshedTarget.id, detailsTab: "overview", objectiveExpanded: false };
          this.#questionIndex = 0;
          this.#scroll = { ...EMPTY_SCROLL };
          await this.#hydrateCurrentSelection();
          return true;
        }
      }
    }
    return true;
  }

  #moveHorizontal(delta: -1 | 1): void {
    const view = this.#buildView();
    if (this.#focus === "tickets") {
      const available = view.selectedRun?.ticketTabs.map((tab) => tab.id) ?? [...TICKET_TABS];
      if (available.length === 0) return;
      const index = Math.max(0, available.indexOf(this.#ticketTab));
      this.#ticketTab = available[(index + delta + available.length) % available.length]!;
      const visible = this.#buildView().selectedRun?.tickets ?? [];
      if (!visible.some((ticket) => ticket.id === this.#selection.ticketId)) {
        if (visible[0] === undefined) delete this.#selection.ticketId;
        else this.#selection.ticketId = visible[0].id;
        delete this.#selection.attemptId;
        void this.#refreshSelectionProjections().then(() => this.#emit());
      }
      this.#scroll.tickets = 0;
      this.#emit();
      return;
    }
    if (this.#focus === "questions") {
      const questions = view.selectedRun?.questions ?? [];
      if (questions.length > 0) {
        this.#questionIndex = (this.#questionIndex + delta + questions.length) % questions.length;
        this.#scroll.questions = 0;
        this.#emit();
      }
      return;
    }
    if (this.#focus !== "details") return;
    if (this.#selection.detailsTab === "chat") return;
    const tabs: DetailsTab[] = ["overview", "plan", "stages"];
    const index = Math.max(0, tabs.indexOf(this.#selection.detailsTab));
    this.#selection.detailsTab = tabs[(index + delta + tabs.length) % tabs.length]!;
    this.#scroll.details = 0;
    this.#emit();
  }

  async #activate(): Promise<void> {
    if (this.#focus === "tickets") {
      const ticketId = this.#selection.ticketId;
      const ticket = ticketId === undefined ? undefined : this.#selectedRunRecord()?.tickets[ticketId];
      if (ticket?.status === "proposed") await this.#openSelectedProposal();
      return;
    }
    if (this.#focus === "details" && this.#selection.detailsTab === "overview") {
      this.#toggleObjective();
      return;
    }
    if (this.#focus === "details" && this.#selection.detailsTab === "stages") {
      const stage = this.#controls?.stages.find((candidate) => candidate.current);
      const action = stage?.actions.find((candidate) => candidate.id === stage.interaction.primaryActionId);
      if (action === undefined) {
        this.#notice = {
          kind: "info",
          message: stage?.interaction.reason ?? "No compiler-authorized action is currently available for this stage.",
        };
        this.#emit();
      } else await this.#activateCapability(action);
      return;
    }
    if (this.#focus === "details" && this.#selection.detailsTab === "chat") {
      this.#toggleChatComposer();
      return;
    }
    if (this.#focus === "agents" && this.#selection.attemptId !== undefined) {
      if (this.#selection.detailsTab !== "chat") this.#detailsTabBeforeChat = this.#selection.detailsTab;
      this.#selection.detailsTab = "chat";
      this.#focus = "details";
      void this.#loadTranscript(this.#selection.attemptId);
      this.#emit();
      return;
    }
    if (this.#focus === "questions") {
      const question = this.#currentQuestion(this.#buildView());
      if (question !== undefined) {
        const draft = this.#draftFor(question);
        this.#modal = {
          kind: "answer_question",
          questionId: question.id,
          focus: draft.editingNotes ? "notes" : "choices",
        };
        this.#emit();
      }
    }
  }

  #cancel(): void {
    if (this.#modal?.kind === "help" && this.#suspendedModal !== undefined) {
      this.#modal = this.#suspendedModal;
      this.#suspendedModal = undefined;
      this.#emit();
      return;
    }
    if (this.#modal !== undefined) {
      if (this.#modal.kind === "configure" && this.#modal.resourceOperation !== undefined) {
        delete this.#modal.resourceOperation;
      } else if (this.#modal.kind === "configure" && this.#modal.editing) this.#modal.editing = false;
      else if (this.#modal.kind === "configure_documents" && this.#modal.editing) this.#modal.editing = false;
      else if (this.#modal.kind === "configure_documents" && this.#modal.dirty) {
        this.#notice = { kind: "error", message: "Save or discard the raw source edit before leaving Configure resources." };
      }
      else if (this.#modal.kind === "configure_documents") this.#modal = this.#modal.returnTo;
      else if (this.#modal.kind === "edit_scalar") this.#modal = this.#modal.returnTo;
      else if (this.#modal.kind === "profile_conflicts") this.#modal = this.#modal.returnTo;
      else if (this.#modal.kind === "config_document_create" || this.#modal.kind === "config_document_rename" ||
          this.#modal.kind === "config_document_delete" || this.#modal.kind === "config_run_type_wizard" ||
          this.#modal.kind === "config_legacy_migration") this.#modal = this.#modal.returnTo;
      else this.#modal = undefined;
      this.#emit();
      return;
    }
    const chat = this.#selectedChatDraft();
    if (chat?.editing === true) {
      chat.editing = false;
    } else {
      const question = this.#currentQuestion(this.#buildView());
      const draft = question === undefined ? undefined : this.#draftFor(question);
      if (draft?.editingNotes === true) draft.editingNotes = false;
      else if (this.#selection.attemptId !== undefined) {
        delete this.#selection.attemptId;
        this.#selection.detailsTab = this.#detailsTabBeforeChat;
      } else if (this.#selection.ticketId !== undefined) {
        delete this.#selection.ticketId;
        void this.#refreshSelectionProjections().then(() => this.#emit());
      }
    }
    this.#emit();
  }

  #scrollBy(delta: number): void {
    this.#scroll[this.#focus] = Math.max(0, this.#scroll[this.#focus] + delta);
    this.#emit();
  }

  #scrollToBoundary(end: boolean): void {
    this.#scroll[this.#focus] = end ? Number.MAX_SAFE_INTEGER : 0;
    this.#emit();
  }

  #toggleObjective(): void {
    this.#selection.objectiveExpanded = !this.#selection.objectiveExpanded;
    this.#scroll.details = 0;
    this.#emit();
  }

  async #togglePause(): Promise<void> {
    const run = this.#selectedRunRecord();
    if (run === undefined) return;
    const resolverRetry = run.lifecycle.phase === "blocked"
      ? this.#findCapability("retry_terminal_resolver")
      : undefined;
    const reviewedBlockerRetry = run.lifecycle.phase === "blocked"
      ? this.#findCapability("retry_supervised_stage")
      : undefined;
    const intent = run.lifecycle.phase === "paused" ? "resume_run"
      : run.lifecycle.phase === "blocked" ? "retry_blocked" : "pause_run";
    const capability = resolverRetry ?? reviewedBlockerRetry ?? this.#findCapability(intent);
    if (capability !== undefined) {
      await this.#activateCapability(capability);
      return;
    }
    if (run.lifecycle.phase === "blocked" && this.#controls !== undefined) {
      this.#notice = {
        kind: "info",
        message: "This blocked run has no compiler-authorized retry available. Open Run actions to inspect its recovery controls.",
      };
      this.#emit();
      return;
    }
    if (run.lifecycle.phase === "paused" || run.lifecycle.phase === "blocked") {
      await this.#mutate(
        "run.resume",
        { runId: run.id },
        run.lifecycle.phase === "blocked" ? "Retrying run…" : "Resuming run…",
      );
    }
    else if (run.lifecycle.phase === "pausing") {
      this.#notice = { kind: "info", message: "Pause is still settling" };
      this.#emit();
    } else await this.#mutate("run.pause", { runId: run.id }, "Pausing run…");
  }

  async #requestDelete(): Promise<void> {
    const row = this.#selectedRunRow();
    const run = this.#selectedRunRecord();
    if (row === undefined || row.provisional || run === undefined || this.#busy !== undefined) return;
    this.#busy = "Inspecting deletion safety…";
    this.#notice = undefined;
    this.#emit();
    try {
      const response = await this.#client.request("run.deletion.inspect", { runId: run.id });
      const preview = parseRunDeletionPreview(response.result);
      if (preview.runId !== run.id) throw new Error("authority returned a deletion preview for another run");
      this.#modal = {
        kind: "delete",
        runId: preview.runId,
        title: row.title,
        objective: preview.objective,
        state: titleCaseForOperator(preview.phase),
        targetBranch: shortBranchForOperator(preview.targetRef),
        ownedWorktrees: preview.ownedWorktrees,
        ownedBranches: preview.ownedBranches,
        liveAgents: preview.liveAgents,
        dirtyWorktreeWarnings: preview.dirtyWorktreeWarnings.map(conciseOperatorReason),
        blockers: preview.blockers.map(conciseOperatorReason),
        canPreserveBranches: preview.canPreserveBranches,
        canDeleteOwnedBranches: preview.canDeleteOwnedBranches,
        previewToken: preview.previewToken,
        selected: "cancel",
      };
    } catch (error) {
      this.#notice = { kind: "error", message: errorMessage(error) };
    } finally {
      this.#busy = undefined;
      this.#emit();
    }
  }

  async #requestMerge(): Promise<void> {
    const row = this.#selectedRunRow();
    const run = this.#selectedRunRecord();
    if (row === undefined || row.provisional || run === undefined || this.#busy !== undefined) return;
    this.#busy = "Inspecting merge readiness…";
    this.#notice = undefined;
    this.#emit();
    try {
      const response = await this.#client.request("run.merge.inspect", { runId: run.id });
      const preview = parseRunMergePreview(response.result);
      if (preview.runId !== run.id) throw new Error("authority returned a merge preview for another run");
      this.#modal = {
        kind: "merge",
        runId: preview.runId,
        title: row.title,
        targetBranch: shortBranchForOperator(preview.targetRef),
        state: titleCaseForOperator(preview.phase),
        completedTickets: preview.completedTickets,
        totalTickets: preview.totalTickets,
        targetAdvanced: preview.targetAdvanced,
        resyncState: preview.resyncState,
        blockers: preview.blockers.map(conciseOperatorReason),
        canAuthorize: preview.canAuthorize,
        previewToken: preview.previewToken,
        selected: "cancel",
      };
    } catch (error) {
      this.#notice = { kind: "error", message: errorMessage(error) };
    } finally {
      this.#busy = undefined;
      this.#emit();
    }
  }

  #openHelp(topic: ControlCenterHelpTopic): void {
    if (this.#modal !== undefined && this.#modal.kind !== "help") this.#suspendedModal = cloneModal(this.#modal);
    this.#modal = { kind: "help", topic };
    this.#emit();
  }

  #openActions(): void {
    const controls = this.#controls;
    if (controls === undefined) {
      this.#notice = { kind: "info", message: "Compiler-authored actions are not available for this run." };
      this.#emit();
      return;
    }
    const current = controls.stages.find((stage) => stage.current);
    const stageFirst = this.#focus === "details" && this.#selection.detailsTab === "stages";
    const ordered = stageFirst
      ? [...(current?.actions ?? []), ...controls.runActions]
      : [...controls.runActions, ...(current?.actions ?? [])];
    const seen = new Set<string>();
    const authorityActions = ordered.filter((action) => {
      // A few singleton run controls are projected both at the current semantic stage and at run
      // scope. Present one operator action; ordering still lets the stage explanation win while
      // Stages is focused. Ticket-scoped retries deliberately retain one row per exact binding.
      const singletonIntent = action.intent === "retry_blocked" || action.intent === "inspect_run_merge";
      const key = singletonIntent ? `intent:${action.intent}` : `id:${action.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const configuredView = this.#configuredActionView();
    const configured = configuredView?.actions ?? [];
    const byId = new Map(authorityActions.map((action) => [action.id, action]));
    // Cockpit slots without a compiled capability are pure presentation debris: showing eight
    // disabled placeholder rows ahead of the real run controls buries every actionable item.
    const actions = configured.length === 0
      ? authorityActions
      : [
        ...configured.flatMap((actionId) => {
          const capability = byId.get(actionId);
          return capability === undefined ? [] : [capability];
        }),
        ...authorityActions.filter((action) => !configured.includes(action.id)),
      ];
    if (actions.length === 0) {
      this.#notice = { kind: "info", message: current?.interaction.reason ?? "No actions are available for this run." };
      this.#emit();
      return;
    }
    const firstAvailable = actions.findIndex((action) => action.availability.state === "available");
    this.#modal = {
      kind: "action_palette",
      title: configuredView?.title === undefined
        ? stageFirst && current !== undefined ? `${current.title} actions` : "Run actions"
        : `${configuredView.title} actions`,
      actions,
      selectedIndex: firstAvailable < 0 ? 0 : firstAvailable,
    };
    this.#emit();
  }

  #configuredActionView() {
    const catalog = this.#cockpit;
    if (this.#focus === "tickets") return cockpitView(catalog, ["tabbed_table", "kanban"]);
    if (this.#focus === "agents") return cockpitView(catalog, ["status_overlay"]);
    if (this.#focus === "graph") return cockpitView(catalog, ["typed_tree", "graph", "table"]);
    if (this.#focus === "details") return cockpitView(catalog, ["nested_detail"]);
    if (this.#focus === "activity" || this.#focus === "runs") return cockpitView(catalog, ["controls", "summary"]);
    return undefined;
  }

  async #activateCapability(action: StageActionCapability): Promise<void> {
    if (action.availability.state !== "available") {
      this.#notice = { kind: "info", message: action.availability.reason };
      this.#emit();
      return;
    }
    if (action.intent === "inspect_run_deletion" || action.surface === "delete_dialog") {
      this.#modal = undefined;
      await this.#requestDelete();
      return;
    }
    if (action.intent === "inspect_run_merge" || action.surface === "merge_dialog") {
      this.#modal = undefined;
      await this.#requestMerge();
      return;
    }
    if (action.surface === "plan_review") {
      this.#modal = undefined;
      this.#openPlanReview(true);
      return;
    }
    if (action.surface === "question_dialog") {
      this.#modal = undefined;
      this.#openSelectedQuestion();
      return;
    }
    if (action.form !== undefined || action.surface === "action_form" || action.confirmation.required) {
      this.#openActionForm(action);
      return;
    }
    await this.#executeCapability(action, {}, false);
  }

  #openActionForm(action: StageActionCapability): void {
    const binding = this.#controls?.binding;
    if (binding === undefined) return;
    const fields = action.form?.fields ?? [];
    const values: Record<string, StageActionValue> = {};
    for (const field of fields) values[field.key] = initialActionFieldValue(field);
    this.#modal = {
      kind: "action_form",
      binding: structuredClone(binding),
      action: structuredClone(action),
      values,
      fieldIndex: Math.max(0, fields.findIndex((field) => !field.locked && field.visibility !== "hidden")),
      focus: fields.some((field) => !field.locked && field.visibility !== "hidden")
        ? "fields" : action.confirmation.required ? "confirmation" : "submit",
      editing: false,
      cursor: 0,
      confirmed: false,
    };
    this.#emit();
  }

  #findCapability(intent: StageActionCapability["intent"]): StageActionCapability | undefined {
    if (this.#controls === undefined) return undefined;
    return [...this.#controls.runActions, ...this.#controls.stages.flatMap((stage) => stage.actions)]
      .find((action) => action.intent === intent && action.availability.state === "available");
  }

  async #executeCapability(
    action: StageActionCapability,
    values: Readonly<Record<string, StageActionValue>>,
    confirmed: boolean,
    binding = this.#controls?.binding,
  ): Promise<RpcSuccess | undefined> {
    if (binding === undefined) {
      this.#notice = { kind: "error", message: "Run action authority is unavailable; refresh and try again." };
      this.#emit();
      return undefined;
    }
    return this.#mutate("run.action.execute", {
      protocol: STAGE_ACTION_INVOCATION_PROTOCOL,
      runId: binding.runId,
      runRevision: binding.runRevision,
      generation: binding.generation,
      capabilityId: action.id,
      confirmed,
      values: structuredClone(values),
    }, `${action.title}…`);
  }

  #moveQuestionOption(delta: -1 | 1): void {
    const question = this.#currentQuestion(this.#buildView());
    if (question === undefined) return;
    const draft = this.#draftFor(question);
    if (draft.editingNotes) return;
    const ids: (string | undefined)[] = [...question.options.map((option) => option.id), undefined];
    const current = ids.findIndex((id) => id === draft.selectedOptionId);
    draft.selectedOptionId = ids[(Math.max(0, current) + delta + ids.length) % ids.length];
    this.#emit();
  }

  #toggleNotes(): void {
    const question = this.#currentQuestion(this.#buildView());
    if (question === undefined) return;
    const draft = this.#draftFor(question);
    draft.editingNotes = !draft.editingNotes;
    this.#emit();
  }

  #openSelectedQuestion(): void {
    const question = this.#currentQuestion(this.#buildView());
    if (question === undefined) {
      this.#notice = { kind: "info", message: "The selected run has no pending questions" };
      this.#emit();
      return;
    }
    this.#focus = "questions";
    const draft = this.#draftFor(question);
    this.#modal = {
      kind: "answer_question",
      questionId: question.id,
      focus: draft.editingNotes ? "notes" : "choices",
    };
    this.#emit();
  }

  async #openSelectedProposal(): Promise<void> {
    const run = this.#selectedRunRecord();
    const ticketId = this.#selection.ticketId;
    if (run === undefined || ticketId === undefined || run.tickets[ticketId]?.status !== "proposed") {
      this.#notice = { kind: "info", message: "Select a proposed ticket that is awaiting your decision" };
      this.#emit();
      return;
    }
    if (this.#busy !== undefined) return;
    this.#busy = "Inspecting change proposal…";
    this.#notice = undefined;
    this.#emit();
    try {
      const proposal = parseControlProposalInspection((await this.#client.request("proposal.inspect", {
        runId: run.id,
        ticketId,
      })).result);
      if (proposal.runId !== run.id || proposal.ticketId !== ticketId) {
        throw new Error("authority returned a different change proposal");
      }
      if (proposal.status !== "proposed" || proposal.disposition.kind !== "pending") {
        await this.refresh();
        this.#notice = { kind: "info", message: "This change proposal no longer needs a decision" };
        return;
      }
      this.#modal = {
        kind: "proposal_review",
        proposal,
        scroll: 0,
        focus: "document",
        decision: undefined,
        message: "",
        messageCursor: 0,
      };
    } catch (error) {
      this.#notice = { kind: "error", message: errorMessage(error) };
    } finally {
      this.#busy = undefined;
      this.#emit();
    }
  }

  #editActiveText(edit: (value: string) => string): void {
    const question = this.#currentQuestion(this.#buildView());
    const questionDraft = question === undefined ? undefined : this.#draftFor(question);
    if (questionDraft?.editingNotes === true) {
      questionDraft.notes = edit(questionDraft.notes).slice(0, 1024 * 1024);
      this.#emit();
      return;
    }
    const chat = this.#selectedChatDraft();
    if (chat?.editing === true) {
      chat.text = edit(chat.text).slice(0, 1024 * 1024);
      this.#emit();
    }
  }

  async #submitQuestion(): Promise<boolean> {
    const question = this.#currentQuestion(this.#buildView());
    if (question === undefined) return false;
    const draft = this.#draftFor(question);
    const notes = draft.notes.trim();
    if (draft.selectedOptionId === undefined && notes.length === 0) {
      this.#notice = { kind: "info", message: "Choose an option or add notes" };
      this.#emit();
      return false;
    }
    const batchQuestionIds = (this.#buildView().selectedRun?.questions ?? [])
      .filter((candidate) => candidate.batchId === question.batchId)
      .map((candidate) => candidate.id);
    if (
      question.batchId !== undefined &&
      question.batchVersion !== undefined &&
      question.answerSaved &&
      question.batchReadyToResolve &&
      questionDraftMatchesSaved(question, draft)
    ) {
      return this.#resolveQuestionBatch(
        question.batchId,
        question.batchVersion,
        batchQuestionIds,
      );
    }
    const batchParams = question.batchId === undefined || question.batchVersion === undefined
      ? {}
      : { batchId: question.batchId, expectedVersion: question.batchVersion };
    const saved = await this.#mutate(question.answerSaved ? "question.revise" : "question.answer", {
      runId: this.#selection.runId!,
      questionId: question.id,
      ...batchParams,
      ...(draft.selectedOptionId === undefined ? {} : { selectedOptionId: draft.selectedOptionId }),
      ...(notes.length === 0 ? {} : { notes }),
    }, question.answerSaved ? "Revising answer…" : "Saving answer…");
    if (saved === undefined) return false;
    const result = asRecord(saved.result) ?? {};
    const batchVersion = typeof result.batchVersion === "number" ? result.batchVersion : undefined;
    if (question.batchId === undefined) {
      this.#questionDrafts.delete(question.id);
      this.#questionIndex = 0;
      return true;
    }
    if (question.batchId !== undefined && batchVersion !== undefined && question.resolvesBatchOnSubmit) {
      return this.#resolveQuestionBatch(question.batchId, batchVersion, batchQuestionIds);
    }
    const questions = this.#buildView().selectedRun?.questions ?? [];
    const next = questions.find((candidate) =>
      candidate.batchId === question.batchId && !candidate.answerSaved);
    if (next !== undefined) {
      this.#questionIndex = questions.indexOf(next);
      if (this.#modal?.kind === "answer_question") this.#modal.questionId = next.id;
    }
    return false;
  }

  async #resolveQuestionBatch(
    batchId: string,
    expectedVersion: number,
    questionIds: readonly string[],
  ): Promise<boolean> {
    const capability = this.#findCapability("resolve_questions");
    const resolved = capability === undefined
      ? await this.#mutate("question.resolve", {
          runId: this.#selection.runId!,
          batchId,
          expectedVersion,
        }, "Submitting answers…")
      : await this.#executeCapability(
          capability,
          actionFieldValues(capability),
          false,
        );
    if (resolved === undefined) return false;
    for (const questionId of questionIds) this.#questionDrafts.delete(questionId);
    this.#questionIndex = 0;
    return true;
  }

  async #openNewRun(): Promise<void> {
    if (this.#busy !== undefined) return;
    this.#busy = "Loading run options…";
    this.#notice = undefined;
    this.#emit();
    try {
      const [catalogResponse, branchesResponse] = await Promise.all([
        this.#client.request("control.catalog"),
        this.#client.request("branches.list", { limit: 30 }),
      ]);
      this.#controlCatalog = parseControlCatalog(catalogResponse.result);
      const branches = parseBranches(branchesResponse.result);
      if (branches.length === 0) throw new Error("repository has no local target branches");
      const runType = this.#controlCatalog.runTypes.find(
        (candidate) => candidate.id === this.#controlCatalog!.defaultRunTypeId,
      )!;
      this.#modal = newRunModal(runType, branches, this.#models);
    } catch (error) {
      this.#notice = { kind: "error", message: errorMessage(error) };
    } finally {
      this.#busy = undefined;
      this.#emit();
    }
  }

  async #openConfigure(): Promise<void> {
    if (this.#busy !== undefined) return;
    this.#busy = "Loading project configuration…";
    this.#notice = undefined;
    this.#emit();
    try {
      const [catalogResponse, snapshotResponse, upstreamConflicts] = await Promise.all([
        this.#client.request("config.catalog"),
        this.#client.request("config.get"),
        this.#loadProfileConflicts(),
      ]);
      const catalog = parseConfigCatalog(catalogResponse.result);
      const snapshot = parseConfigSnapshot(snapshotResponse.result);
      const saved = this.#savedConfigDraft;
      const rebaseRequired = saved !== undefined && !jsonEqual(saved.cas, snapshot.cas);
      this.#modal = {
        kind: "configure",
        catalog,
        snapshot,
        draft: structuredClone(saved?.values ?? snapshot.values) as Record<string, JsonValue>,
        sectionIndex: 0,
        resourceIndex: 0,
        fieldIndex: 0,
        focus: "tree",
        actionIndex: 0,
        editing: false,
        dirty: !jsonEqual(saved?.values ?? snapshot.values, snapshot.values),
        rebaseRequired,
        upstreamConflicts,
      };
      if (rebaseRequired) {
        this.#notice = { kind: "error", message: "The saved draft predates newer project configuration. Rebase or discard it before publishing." };
      }
    } catch (error) {
      this.#notice = { kind: "error", message: errorMessage(error) };
    } finally {
      this.#busy = undefined;
      this.#emit();
    }
  }

  async #openConfigDocuments(returnTo: ConfigureModalState): Promise<void> {
    if (returnTo.dirty) {
      this.#notice = { kind: "error", message: "Publish or discard the guided configuration draft before opening raw resources." };
      this.#emit();
      return;
    }
    this.#busy = "Loading project resources…";
    this.#notice = undefined;
    this.#emit();
    try {
      const response = await this.#client.request("config.documents.list", {});
      const catalog = parseConfigDocumentCatalog(response.result);
      const firstDomain = firstDocumentDomain(catalog);
      const modal: ConfigureDocumentsModalState = {
        kind: "configure_documents",
        catalog,
        domainIndex: firstDomain,
        documentIndex: 0,
        draft: "",
        cursor: 0,
        scroll: 0,
        focus: "documents",
        editing: false,
        dirty: false,
        returnTo: cloneModal(returnTo) as ConfigureModalState,
      };
      this.#modal = modal;
      await this.#readSelectedConfigDocument(modal);
    } catch (error) {
      this.#notice = { kind: "error", message: errorMessage(error) };
    } finally {
      this.#busy = undefined;
      this.#emit();
    }
  }

  async #readSelectedConfigDocument(modal: ConfigureDocumentsModalState): Promise<void> {
    const document = selectedConfigDocument(modal);
    if (document === undefined) {
      delete modal.source;
      modal.draft = "";
      modal.cursor = 0;
      modal.dirty = false;
      return;
    }
    const response = await this.#client.request("config.documents.read", {
      documentId: document.id,
      catalogToken: modal.catalog.catalogToken,
    });
    const source = parseConfigDocumentSource(response.result);
    if (source.catalogToken !== modal.catalog.catalogToken || source.document.id !== document.id) {
      throw new Error("authority returned another configuration document");
    }
    modal.source = source;
    modal.draft = source.source;
    modal.cursor = characterCount(source.source);
    modal.scroll = 0;
    modal.editing = false;
    modal.dirty = false;
  }

  async #handleConfigureDocuments(
    modal: ConfigureDocumentsModalState,
    action: ControlCenterKeyAction,
  ): Promise<void> {
    if (action.type === "config_document_create") {
      if (!this.#requireCleanDocumentSurface(modal)) return;
      this.#modal = {
        kind: "config_document_create",
        returnTo: modal,
        choices: DOCUMENT_CREATE_CHOICES,
        choiceIndex: 0,
        title: "",
        cursor: 0,
        focus: "choice",
      };
    } else if (action.type === "config_document_rename") {
      if (!this.#requireCleanDocumentSurface(modal)) return;
      const document = selectedConfigDocument(modal);
      if (document === undefined) this.#notice = { kind: "info", message: "Select a resource to rename." };
      else if (!document.capabilities.rename) this.#notice = { kind: "info", message: document.capabilities.reason ?? "This resource cannot be renamed." };
      else this.#modal = {
        kind: "config_document_rename",
        returnTo: modal,
        documentId: document.id,
        title: document.title,
        cursor: characterCount(document.title),
        focus: "title",
      };
    } else if (action.type === "config_document_delete") {
      if (!this.#requireCleanDocumentSurface(modal)) return;
      const document = selectedConfigDocument(modal);
      if (document === undefined) this.#notice = { kind: "info", message: "Select a resource to delete." };
      else this.#modal = {
        kind: "config_document_delete",
        returnTo: modal,
        documentId: document.id,
        title: document.title,
        canDelete: document.capabilities.delete,
        ...(document.capabilities.reason === undefined ? {} : { reason: document.capabilities.reason }),
        selected: "cancel",
      };
    } else if (action.type === "config_run_type_create") {
      if (!this.#requireCleanDocumentSurface(modal)) return;
      await this.#openConfigRunTypeWizard(modal);
      return;
    } else if (action.type === "config_legacy_migration") {
      if (!this.#requireCleanDocumentSurface(modal)) return;
      await this.#openConfigLegacyMigration(modal);
      return;
    } else if (action.type === "focus") {
      modal.editing = false;
      modal.focus = moveString(["domains", "documents", "editor"] as const, modal.focus, action.delta);
    } else if (action.type === "move" && !modal.editing) {
      if (modal.focus === "domains") await this.#moveConfigDocumentDomain(modal, action.delta);
      else if (modal.focus === "documents") await this.#moveConfigDocument(modal, action.delta);
      else modal.scroll = Math.max(0, modal.scroll + action.delta);
    } else if (action.type === "page" && modal.focus === "editor") {
      modal.scroll = Math.max(0, modal.scroll + action.delta * 8);
    } else if (action.type === "details_tab" && modal.editing) {
      modal.cursor = clampCharacterOffset(modal.draft, modal.cursor + action.delta);
    } else if (action.type === "details_tab" && modal.focus === "domains") {
      await this.#moveConfigDocumentDomain(modal, action.delta);
    } else if (action.type === "scroll_home") {
      if (modal.editing) modal.cursor = 0;
      else modal.scroll = 0;
    } else if (action.type === "scroll_end") {
      if (modal.editing) modal.cursor = characterCount(modal.draft);
      else modal.scroll = Number.MAX_SAFE_INTEGER;
    } else if (action.type === "append_text" && modal.editing) {
      const edit = insertBoundedAtCharacter(modal.draft, modal.cursor, action.text, 16 * 1024 * 1024);
      modal.draft = edit.value;
      modal.cursor = edit.cursor;
      modal.dirty = modal.source !== undefined && modal.draft !== modal.source.source;
    } else if (action.type === "backspace" && modal.editing) {
      const edit = removeCharacterBefore(modal.draft, modal.cursor);
      modal.draft = edit.value;
      modal.cursor = edit.cursor;
      modal.dirty = modal.source !== undefined && modal.draft !== modal.source.source;
    } else if (action.type === "delete_forward" && modal.editing) {
      modal.draft = removeCharacterAt(modal.draft, modal.cursor);
      modal.dirty = modal.source !== undefined && modal.draft !== modal.source.source;
    } else if (action.type === "activate") {
      if (modal.focus === "domains") modal.focus = "documents";
      else if (modal.focus === "documents") modal.focus = "editor";
      else if (modal.editing) {
        const edit = insertBoundedAtCharacter(modal.draft, modal.cursor, "\n", 16 * 1024 * 1024);
        modal.draft = edit.value;
        modal.cursor = edit.cursor;
        modal.dirty = modal.source !== undefined && modal.draft !== modal.source.source;
      } else {
        modal.editing = true;
        modal.cursor = characterCount(modal.draft);
      }
    } else if (action.type === "save_draft" || action.type === "publish" || action.type === "submit") {
      await this.#publishConfigDocument(modal);
      return;
    } else if (action.type === "discard_draft") {
      if (modal.source !== undefined) {
        modal.draft = modal.source.source;
        modal.cursor = characterCount(modal.draft);
        modal.dirty = false;
        modal.editing = false;
        this.#notice = { kind: "info", message: "Raw source edit discarded." };
      }
    }
    this.#emit();
  }

  #requireCleanDocumentSurface(modal: ConfigureDocumentsModalState): boolean {
    if (!modal.dirty) return true;
    this.#notice = { kind: "error", message: "Save or discard the current raw source edit first." };
    this.#emit();
    return false;
  }

  async #moveConfigDocumentDomain(modal: ConfigureDocumentsModalState, delta: -1 | 1): Promise<void> {
    if (!this.#requireCleanDocumentSurface(modal)) return;
    modal.domainIndex = cycleIndex(modal.domainIndex, CONFIG_DOCUMENT_DOMAINS.length, delta);
    modal.documentIndex = 0;
    await this.#readSelectedConfigDocument(modal);
  }

  async #moveConfigDocument(modal: ConfigureDocumentsModalState, delta: -1 | 1): Promise<void> {
    if (!this.#requireCleanDocumentSurface(modal)) return;
    const documents = configDocumentsInSelectedDomain(modal);
    if (documents.length === 0) return;
    modal.documentIndex = cycleIndex(modal.documentIndex, documents.length, delta);
    await this.#readSelectedConfigDocument(modal);
  }

  async #publishConfigDocument(modal: ConfigureDocumentsModalState): Promise<void> {
    const source = modal.source;
    if (source === undefined) return;
    if (!modal.dirty) {
      this.#notice = { kind: "info", message: "The selected resource has no unpublished source changes." };
      this.#emit();
      return;
    }
    if (!source.document.capabilities.update) {
      this.#notice = { kind: "error", message: source.document.capabilities.reason ?? "This resource is read-only." };
      this.#emit();
      return;
    }
    const response = await this.#mutate("config.documents.update", {
      documentId: source.document.id,
      catalogToken: source.catalogToken,
      sourceToken: source.document.sourceToken,
      source: modal.draft,
    }, "Validating and saving resource…");
    if (response === undefined) return;
    const result = parseConfigDocumentMutation(response.result);
    await this.#applyConfigCatalogToSurface(modal, result.catalog, source.document.id);
    this.#notice = { kind: "info", message: `${result.changedDocuments} configuration ${result.changedDocuments === 1 ? "document" : "documents"} saved.` };
    this.#emit();
  }

  async #applyConfigCatalogToSurface(
    modal: ConfigureDocumentsModalState,
    catalog: ConfigDocumentCatalog,
    preferredDocumentId?: string,
  ): Promise<void> {
    modal.catalog = catalog;
    const preferred = preferredDocumentId === undefined
      ? undefined : catalog.documents.find((document) => document.id === preferredDocumentId);
    if (preferred !== undefined) modal.domainIndex = CONFIG_DOCUMENT_DOMAINS.indexOf(preferred.domain);
    const documents = configDocumentsInSelectedDomain(modal);
    modal.documentIndex = Math.max(0, preferred === undefined ? 0 : documents.findIndex((document) => document.id === preferred.id));
    await this.#readSelectedConfigDocument(modal);
  }

  async #handleConfigDocumentCreate(
    modal: ConfigDocumentCreateModalState,
    action: ControlCenterKeyAction,
  ): Promise<void> {
    if (action.type === "focus") {
      modal.focus = moveString(["choice", "title", "submit"] as const, modal.focus, action.delta);
    } else if ((action.type === "move" || action.type === "details_tab") && modal.focus === "choice") {
      modal.choiceIndex = cycleIndex(modal.choiceIndex, modal.choices.length, action.delta);
    } else if (action.type === "details_tab" && modal.focus === "title") {
      modal.cursor = clampCharacterOffset(modal.title, modal.cursor + action.delta);
    } else if (action.type === "append_text" && modal.focus === "title") {
      const edit = insertBoundedAtCharacter(modal.title, modal.cursor, action.text.replace(/\r?\n/gu, " "), 200);
      modal.title = edit.value;
      modal.cursor = edit.cursor;
    } else if (action.type === "backspace" && modal.focus === "title") {
      const edit = removeCharacterBefore(modal.title, modal.cursor);
      modal.title = edit.value;
      modal.cursor = edit.cursor;
    } else if (action.type === "delete_forward" && modal.focus === "title") {
      modal.title = removeCharacterAt(modal.title, modal.cursor);
    } else if (action.type === "activate") {
      if (modal.focus === "choice") modal.focus = "title";
      else if (modal.focus === "title") modal.focus = "submit";
      else await this.#submitConfigDocumentCreate(modal);
    } else if (action.type === "submit") await this.#submitConfigDocumentCreate(modal);
    this.#emit();
  }

  async #submitConfigDocumentCreate(modal: ConfigDocumentCreateModalState): Promise<void> {
    const title = modal.title.trim();
    const choice = modal.choices[modal.choiceIndex];
    if (choice === undefined || title.length === 0) {
      this.#notice = { kind: "error", message: "Choose a resource type and enter a title." };
      return;
    }
    const response = await this.#mutate("config.documents.create", {
      catalogToken: modal.returnTo.catalog.catalogToken,
      domain: choice.domain,
      kind: choice.kind,
      format: choice.format,
      title,
    }, "Creating configuration resource…");
    if (response === undefined) return;
    const result = parseConfigDocumentMutation(response.result);
    const surface = modal.returnTo;
    this.#modal = surface;
    const created = result.catalog.documents.find((document) => document.title === title && document.kind === choice.kind);
    await this.#applyConfigCatalogToSurface(surface, result.catalog, created?.id);
  }

  async #handleConfigDocumentRename(
    modal: ConfigDocumentRenameModalState,
    action: ControlCenterKeyAction,
  ): Promise<void> {
    if (action.type === "focus") modal.focus = modal.focus === "title" ? "submit" : "title";
    else if (action.type === "details_tab" && modal.focus === "title") modal.cursor = clampCharacterOffset(modal.title, modal.cursor + action.delta);
    else if (action.type === "append_text" && modal.focus === "title") {
      const edit = insertBoundedAtCharacter(modal.title, modal.cursor, action.text.replace(/\r?\n/gu, " "), 200);
      modal.title = edit.value;
      modal.cursor = edit.cursor;
    } else if (action.type === "backspace" && modal.focus === "title") {
      const edit = removeCharacterBefore(modal.title, modal.cursor);
      modal.title = edit.value;
      modal.cursor = edit.cursor;
    } else if (action.type === "delete_forward" && modal.focus === "title") modal.title = removeCharacterAt(modal.title, modal.cursor);
    else if (action.type === "activate") {
      if (modal.focus === "title") modal.focus = "submit";
      else await this.#submitConfigDocumentRename(modal);
    } else if (action.type === "submit") await this.#submitConfigDocumentRename(modal);
    this.#emit();
  }

  async #submitConfigDocumentRename(modal: ConfigDocumentRenameModalState): Promise<void> {
    const document = modal.returnTo.catalog.documents.find((candidate) => candidate.id === modal.documentId);
    const title = modal.title.trim();
    if (document === undefined || title.length === 0) {
      this.#notice = { kind: "error", message: "Enter a new resource title." };
      return;
    }
    const response = await this.#mutate("config.documents.rename", {
      documentId: document.id,
      catalogToken: modal.returnTo.catalog.catalogToken,
      sourceToken: document.sourceToken,
      title,
    }, "Renaming configuration resource…");
    if (response === undefined) return;
    const result = parseConfigDocumentMutation(response.result);
    const surface = modal.returnTo;
    this.#modal = surface;
    const renamed = result.catalog.documents.find((candidate) => candidate.title === title && candidate.kind === document.kind);
    await this.#applyConfigCatalogToSurface(surface, result.catalog, renamed?.id);
  }

  async #handleConfigDocumentDelete(
    modal: ConfigDocumentDeleteModalState,
    action: ControlCenterKeyAction,
  ): Promise<void> {
    if (action.type === "move" || action.type === "details_tab" || action.type === "focus") {
      modal.selected = modal.selected === "cancel" ? "delete" : "cancel";
    } else if (action.type === "activate" || action.type === "submit") {
      if (modal.selected === "cancel") this.#modal = modal.returnTo;
      else await this.#submitConfigDocumentDelete(modal);
    }
    this.#emit();
  }

  async #submitConfigDocumentDelete(modal: ConfigDocumentDeleteModalState): Promise<void> {
    const document = modal.returnTo.catalog.documents.find((candidate) => candidate.id === modal.documentId);
    if (document === undefined || !document.capabilities.delete) {
      this.#notice = { kind: "error", message: document?.capabilities.reason ?? modal.reason ?? "This resource cannot be deleted." };
      return;
    }
    const response = await this.#mutate("config.documents.delete", {
      documentId: document.id,
      catalogToken: modal.returnTo.catalog.catalogToken,
      sourceToken: document.sourceToken,
    }, "Deleting configuration resource…");
    if (response === undefined) return;
    const result = parseConfigDocumentMutation(response.result);
    const surface = modal.returnTo;
    this.#modal = surface;
    await this.#applyConfigCatalogToSurface(surface, result.catalog);
  }

  async #openConfigRunTypeWizard(returnTo: ConfigureDocumentsModalState): Promise<void> {
    this.#busy = "Loading run type templates…";
    this.#emit();
    try {
      const response = await this.#client.request("config.run-types.templates", {});
      const templates = parseConfigRunTypeTemplates(response.result);
      if (templates.templates.length === 0) throw new Error("No compiler-valid run type templates are available.");
      this.#modal = {
        kind: "config_run_type_wizard",
        returnTo,
        templates,
        templateIndex: 0,
        title: "",
        slug: "",
        description: "",
        makeDefault: false,
        focus: "template",
        cursor: 0,
      };
    } catch (error) {
      this.#notice = { kind: "error", message: errorMessage(error) };
    } finally {
      this.#busy = undefined;
      this.#emit();
    }
  }

  async #handleConfigRunTypeWizard(
    modal: ConfigRunTypeWizardModalState,
    action: ControlCenterKeyAction,
  ): Promise<void> {
    const textFocus = modal.focus === "title" || modal.focus === "slug" || modal.focus === "description";
    if (action.type === "focus") {
      modal.focus = moveString(["template", "title", "slug", "description", "default", "submit"] as const, modal.focus, action.delta);
      modal.cursor = characterCount(runTypeWizardText(modal));
    } else if ((action.type === "move" || action.type === "details_tab") && modal.focus === "template") {
      modal.templateIndex = cycleIndex(modal.templateIndex, modal.templates.templates.length, action.delta);
    } else if (action.type === "details_tab" && textFocus) {
      modal.cursor = clampCharacterOffset(runTypeWizardText(modal), modal.cursor + action.delta);
    } else if (action.type === "details_tab" && modal.focus === "default") modal.makeDefault = !modal.makeDefault;
    else if (action.type === "append_text" && textFocus) {
      const source = runTypeWizardText(modal);
      const inserted = modal.focus === "description" ? action.text : action.text.replace(/\r?\n/gu, " ");
      const edit = insertBoundedAtCharacter(source, modal.cursor, inserted, modal.focus === "description" ? 64 * 1024 : 200);
      setRunTypeWizardText(modal, edit.value);
      modal.cursor = edit.cursor;
    } else if (action.type === "backspace" && textFocus) {
      const edit = removeCharacterBefore(runTypeWizardText(modal), modal.cursor);
      setRunTypeWizardText(modal, edit.value);
      modal.cursor = edit.cursor;
    } else if (action.type === "delete_forward" && textFocus) {
      setRunTypeWizardText(modal, removeCharacterAt(runTypeWizardText(modal), modal.cursor));
    } else if (action.type === "activate") {
      if (modal.focus === "description") {
        const edit = insertBoundedAtCharacter(modal.description, modal.cursor, "\n", 64 * 1024);
        modal.description = edit.value;
        modal.cursor = edit.cursor;
      } else if (modal.focus === "default") modal.makeDefault = !modal.makeDefault;
      else if (modal.focus === "submit") await this.#submitConfigRunTypeWizard(modal);
      else modal.focus = moveString(["template", "title", "slug", "description", "default", "submit"] as const, modal.focus, 1);
    } else if (action.type === "submit") await this.#submitConfigRunTypeWizard(modal);
    this.#emit();
  }

  async #submitConfigRunTypeWizard(modal: ConfigRunTypeWizardModalState): Promise<void> {
    const template = modal.templates.templates[modal.templateIndex];
    const title = modal.title.trim();
    if (template === undefined || title.length === 0) {
      this.#notice = { kind: "error", message: "Choose a template and enter a run type title." };
      return;
    }
    const response = await this.#mutate("config.run-types.create", {
      catalogToken: modal.templates.catalogToken,
      templateId: template.id,
      title,
      ...(modal.slug.trim().length === 0 ? {} : { slug: modal.slug.trim() }),
      ...(modal.description.trim().length === 0 ? {} : { description: modal.description.trim() }),
      makeDefault: modal.makeDefault,
    }, "Creating run type…");
    if (response === undefined) return;
    const result = parseConfigDocumentMutation(response.result);
    const surface = modal.returnTo;
    this.#modal = surface;
    const created = result.catalog.documents.find((document) => document.kind === "run_type" && document.title === title);
    await this.#applyConfigCatalogToSurface(surface, result.catalog, created?.id);
  }

  async #openConfigLegacyMigration(returnTo: ConfigureDocumentsModalState): Promise<void> {
    this.#busy = "Inspecting legacy project state…";
    this.#emit();
    try {
      const response = await this.#client.request("config.legacy-migration.preview", { inspectRuns: true });
      this.#modal = {
        kind: "config_legacy_migration",
        returnTo,
        preview: parseConfigLegacyMigrationPreview(response.result),
        selected: "cancel",
      };
    } catch (error) {
      this.#notice = { kind: "error", message: errorMessage(error) };
    } finally {
      this.#busy = undefined;
      this.#emit();
    }
  }

  async #handleConfigLegacyMigration(
    modal: ConfigLegacyMigrationModalState,
    action: ControlCenterKeyAction,
  ): Promise<void> {
    if (action.type === "move" || action.type === "details_tab" || action.type === "focus") {
      modal.selected = modal.selected === "cancel" ? "apply" : "cancel";
    } else if (action.type === "activate" || action.type === "submit") {
      if (modal.selected === "cancel") this.#modal = modal.returnTo;
      else {
        const response = await this.#mutate("config.legacy-migration.apply", {
          previewToken: modal.preview.previewToken,
        }, "Migrating legacy project state…");
        if (response === undefined) return;
        const result = parseConfigLegacyMigrationResult(response.result);
        const surface = modal.returnTo;
        this.#modal = surface;
        await this.#applyConfigCatalogToSurface(surface, result.catalog);
        this.#notice = { kind: "info", message: "Legacy project state migrated; the original source was retained." };
      }
    }
    this.#emit();
  }

  #openPlanReview(manual: boolean): void {
    const run = this.#selectedRunRecord();
    if (run?.lifecycle.phase !== "awaiting_approval" || run.plan === undefined) {
      if (manual) this.#notice = { kind: "info", message: "The selected run has no plan awaiting review" };
      this.#emit();
      return;
    }
    this.#approvalSeen.add(`${run.id}:${run.plan.revision}`);
    this.#modal = {
      kind: "plan_review",
      runId: run.id,
      sectionIndex: 0,
      scroll: 0,
      focus: "document",
      steering: "",
      steeringCursor: 0,
    };
    this.#emit();
  }

  async #handleModal(action: ControlCenterKeyAction): Promise<void> {
    const modal = this.#modal!;
    if (action.type === "pointer_control") {
      await this.#handleModalPointer(modal, action.target);
      return;
    }
    if (action.type === "help") {
      if (modal.kind === "help") this.#restoreSuspendedModal();
      else this.#openHelp(modal.kind === "delete" || modal.kind === "merge" ? "runs" : modal.kind);
      return;
    }
    if (modal.kind === "help") {
      if (action.type === "activate") this.#restoreSuspendedModal();
      return;
    }
    if (modal.kind === "delete") {
      if (action.type === "details_tab" || action.type === "move" || action.type === "focus") {
        modal.selected = moveString(
          ["cancel", "preserve_branches", "delete_owned_branches"] as const,
          modal.selected,
          action.delta,
        );
        this.#emit();
      } else if (action.type === "activate" || action.type === "submit") {
        if (modal.selected === "cancel") {
          this.#modal = undefined;
          this.#emit();
          return;
        }
        const allowed = modal.selected === "preserve_branches"
          ? modal.canPreserveBranches
          : modal.canDeleteOwnedBranches;
        if (!allowed) {
          this.#notice = {
            kind: "info",
            message: modal.blockers[0] ?? modal.dirtyWorktreeWarnings[0] ?? "This deletion mode is not currently safe",
          };
          this.#emit();
          return;
        }
        const { runId, selected: mode, previewToken } = modal;
        this.#modal = undefined;
        await this.#mutate("run.delete", { runId, mode, previewToken }, "Deleting run…");
      }
      return;
    }
    if (modal.kind === "merge") {
      if (action.type === "details_tab" || action.type === "move" || action.type === "focus") {
        modal.selected = modal.selected === "cancel" ? "authorize" : "cancel";
        this.#emit();
      } else if (action.type === "activate" || action.type === "submit") {
        if (modal.selected === "cancel") {
          this.#modal = undefined;
          this.#emit();
          return;
        }
        if (!modal.canAuthorize) {
          this.#notice = { kind: "info", message: modal.blockers[0] ?? "This run is not ready to merge" };
          this.#emit();
          return;
        }
        const { runId, targetBranch, previewToken } = modal;
        this.#modal = undefined;
        await this.#mutate("run.merge.authorize", { runId, previewToken }, `Merging into ${targetBranch}…`);
      }
      return;
    }
    if (modal.kind === "action_palette") await this.#handleActionPalette(modal, action);
    else if (modal.kind === "action_form") await this.#handleActionForm(modal, action);
    else if (modal.kind === "new_run") await this.#handleNewRun(modal, action);
    else if (modal.kind === "plan_review") await this.#handlePlanReview(modal, action);
    else if (modal.kind === "proposal_review") await this.#handleProposalReview(modal, action);
    else if (modal.kind === "answer_question") await this.#handleAnswerQuestion(modal, action);
    else if (modal.kind === "edit_scalar") this.#handleEditScalar(modal, action);
    else if (modal.kind === "configure") await this.#handleConfigure(modal, action);
    else if (modal.kind === "configure_documents") await this.#handleConfigureDocuments(modal, action);
    else if (modal.kind === "config_document_create") await this.#handleConfigDocumentCreate(modal, action);
    else if (modal.kind === "config_document_rename") await this.#handleConfigDocumentRename(modal, action);
    else if (modal.kind === "config_document_delete") await this.#handleConfigDocumentDelete(modal, action);
    else if (modal.kind === "config_run_type_wizard") await this.#handleConfigRunTypeWizard(modal, action);
    else if (modal.kind === "config_legacy_migration") await this.#handleConfigLegacyMigration(modal, action);
    else await this.#handleProfileConflicts(modal, action);
  }

  #handlePointerControl(target: string): void {
    if (target.startsWith("details-tab:")) {
      const tab = target.slice("details-tab:".length);
      if (tab === "overview" || tab === "plan" || tab === "stages") {
        this.#selection.detailsTab = tab;
        this.#focus = "details";
        this.#scroll.details = 0;
      }
    } else if (target === "ticket-tab:previous" || target === "ticket-tab:next") {
      this.#focus = "tickets";
      this.#moveHorizontal(target.endsWith("previous") ? -1 : 1);
      return;
    } else if (target.startsWith("question-option:")) {
      const question = this.#currentQuestion(this.#buildView());
      const raw = target.slice("question-option:".length);
      if (question !== undefined) {
        const option = raw === "none" ? undefined : question.options[Number.parseInt(raw, 10)]?.id;
        if (raw === "none" || option !== undefined) {
          this.#draftFor(question).selectedOptionId = option;
          this.#focus = "questions";
        }
      }
    } else if (target === "question:open") {
      this.#focus = "questions";
      void this.#activate();
      return;
    }
    this.#emit();
  }

  async #handleModalPointer(modal: ControlCenterModalState, target: string): Promise<void> {
    if (modal.kind === "help") {
      if (target === "modal:close") this.#restoreSuspendedModal();
      return;
    }
    if (modal.kind === "delete") {
      if (target === "delete:cancel") modal.selected = "cancel";
      else if (target === "delete:preserve") modal.selected = "preserve_branches";
      else if (target === "delete:owned") modal.selected = "delete_owned_branches";
      this.#emit();
      return;
    }
    if (modal.kind === "merge") {
      if (target === "merge:cancel") modal.selected = "cancel";
      else if (target === "merge:authorize") modal.selected = "authorize";
      this.#emit();
      return;
    }
    if (modal.kind === "action_palette") {
      if (target.startsWith("action-palette:")) {
        const index = Number.parseInt(target.slice("action-palette:".length), 10);
        if (modal.actions[index] !== undefined) {
          modal.selectedIndex = index;
          await this.#activateCapability(modal.actions[index]!);
          return;
        }
      }
      this.#emit();
      return;
    }
    if (modal.kind === "action_form") {
      if (target.startsWith("action-field:")) {
        const index = Number.parseInt(target.slice("action-field:".length), 10);
        const field = modal.action.form?.fields[index];
        if (field !== undefined && field.visibility !== "hidden") {
          modal.fieldIndex = index;
          modal.focus = "fields";
          modal.editing = false;
        }
      } else if (target === "action-confirm") {
        modal.focus = "confirmation";
        modal.confirmed = !modal.confirmed;
      } else if (target === "action-submit") {
        modal.focus = "submit";
        await this.#submitActionForm(modal);
        return;
      }
      this.#emit();
      return;
    }
    if (modal.kind === "new_run") {
      if (target.startsWith("new-run:type:")) {
        const index = Number.parseInt(target.slice("new-run:type:".length), 10);
        const runType = this.#controlCatalog?.runTypes[index];
        if (runType !== undefined) {
          modal.runTypeId = runType.id;
          applyRunTypeDefaults(modal, runType, this.#models);
        }
      } else if (target.startsWith("new-run:questions:")) {
        const policy = target.slice("new-run:questions:".length);
        if (policy === "none" || policy === "some" || policy === "many") modal.questionPolicy = policy;
      } else if (target === "new-run:branch") modal.focus = "branch";
      else if (target === "new-run:parallel") modal.focus = "parallel";
      else if (target === "new-run:objective") modal.focus = "objective";
      else if (target === "new-run:start") {
        modal.focus = "start";
        await this.#startRun(modal);
        return;
      }
      this.#emit();
      return;
    }
    if (modal.kind === "plan_review") {
      if (target.startsWith("plan:section:")) {
        modal.sectionIndex = Math.max(0, Number.parseInt(target.slice("plan:section:".length), 10) || 0);
        modal.scroll = 0;
        modal.focus = "document";
      } else if (target === "plan:steering") {
        modal.focus = "steering";
        modal.steeringCursor = characterCount(modal.steering);
      }
      else if (target === "plan:action") {
        modal.focus = "action";
        await this.#submitPlanReview(modal);
        return;
      }
      this.#emit();
      return;
    }
    if (modal.kind === "proposal_review") {
      if (target === "proposal:message") {
        modal.focus = "message";
        modal.messageCursor = characterCount(modal.message);
      } else if (target === "proposal:approve") {
        modal.focus = "choice";
        modal.decision = "approval";
      } else if (target === "proposal:reject") {
        modal.focus = "choice";
        modal.decision = "rejection";
      } else if (target === "proposal:submit") {
        modal.focus = "submit";
        await this.#decideProposal(modal);
        return;
      }
      this.#emit();
      return;
    }
    if (modal.kind === "answer_question") {
      const question = this.#currentQuestion(this.#buildView());
      if (target.startsWith("answer:option:") && question !== undefined) {
        const raw = target.slice("answer:option:".length);
        const option = raw === "none" ? undefined : question.options[Number.parseInt(raw, 10)]?.id;
        if (raw === "none" || option !== undefined) this.#draftFor(question).selectedOptionId = option;
        modal.focus = "choices";
      } else if (target === "answer:notes") modal.focus = "notes";
      else if (target === "answer:submit") {
        modal.focus = "submit";
        await this.#submitQuestion();
        if (this.#currentQuestion(this.#buildView()) === undefined) this.#modal = undefined;
      }
      this.#emit();
      return;
    }
    if (modal.kind === "configure_documents") {
      if (target.startsWith("config-doc:domain:")) {
        const index = Number.parseInt(target.slice("config-doc:domain:".length), 10);
        if (CONFIG_DOCUMENT_DOMAINS[index] !== undefined && this.#requireCleanDocumentSurface(modal)) {
          modal.domainIndex = index;
          modal.documentIndex = 0;
          modal.focus = "domains";
          await this.#readSelectedConfigDocument(modal);
        }
      } else if (target.startsWith("config-doc:document:")) {
        const index = Number.parseInt(target.slice("config-doc:document:".length), 10);
        const documents = configDocumentsInSelectedDomain(modal);
        if (documents[index] !== undefined && this.#requireCleanDocumentSurface(modal)) {
          modal.documentIndex = index;
          modal.focus = "documents";
          await this.#readSelectedConfigDocument(modal);
        }
      } else if (target === "config-doc:editor") {
        modal.focus = "editor";
      } else if (target === "config-doc:save") {
        await this.#handleConfigureDocuments(modal, { type: "save_draft" });
        return;
      } else if (target === "config-doc:discard") {
        await this.#handleConfigureDocuments(modal, { type: "discard_draft" });
        return;
      } else if (target === "config-doc:create") {
        await this.#handleConfigureDocuments(modal, { type: "config_document_create" });
        return;
      } else if (target === "config-doc:rename") {
        await this.#handleConfigureDocuments(modal, { type: "config_document_rename" });
        return;
      } else if (target === "config-doc:delete") {
        await this.#handleConfigureDocuments(modal, { type: "config_document_delete" });
        return;
      } else if (target === "config-doc:run-type") {
        await this.#handleConfigureDocuments(modal, { type: "config_run_type_create" });
        return;
      } else if (target === "config-doc:migration") {
        await this.#handleConfigureDocuments(modal, { type: "config_legacy_migration" });
        return;
      } else if (target === "config-doc:guided") {
        this.#modal = modal.returnTo;
      }
      this.#emit();
      return;
    }
    if (modal.kind === "config_document_create") {
      if (target.startsWith("config-create:choice:")) {
        const index = Number.parseInt(target.slice("config-create:choice:".length), 10);
        if (modal.choices[index] !== undefined) modal.choiceIndex = index;
        modal.focus = "choice";
      } else if (target === "config-create:title") {
        modal.focus = "title";
        modal.cursor = characterCount(modal.title);
      } else if (target === "config-create:submit") {
        modal.focus = "submit";
        await this.#submitConfigDocumentCreate(modal);
      }
      this.#emit();
      return;
    }
    if (modal.kind === "config_document_rename") {
      if (target === "config-rename:title") {
        modal.focus = "title";
        modal.cursor = characterCount(modal.title);
      } else if (target === "config-rename:submit") {
        modal.focus = "submit";
        await this.#submitConfigDocumentRename(modal);
      }
      this.#emit();
      return;
    }
    if (modal.kind === "config_document_delete") {
      if (target === "config-delete:cancel") modal.selected = "cancel";
      else if (target === "config-delete:confirm") modal.selected = "delete";
      this.#emit();
      return;
    }
    if (modal.kind === "config_run_type_wizard") {
      if (target.startsWith("config-run-type:template:")) {
        const index = Number.parseInt(target.slice("config-run-type:template:".length), 10);
        if (modal.templates.templates[index] !== undefined) modal.templateIndex = index;
        modal.focus = "template";
      } else if (target === "config-run-type:title" || target === "config-run-type:slug" ||
          target === "config-run-type:description") {
        modal.focus = target.slice("config-run-type:".length) as "title" | "slug" | "description";
        modal.cursor = characterCount(runTypeWizardText(modal));
      } else if (target === "config-run-type:default") {
        modal.focus = "default";
        modal.makeDefault = !modal.makeDefault;
      } else if (target === "config-run-type:submit") {
        modal.focus = "submit";
        await this.#submitConfigRunTypeWizard(modal);
      }
      this.#emit();
      return;
    }
    if (modal.kind === "config_legacy_migration") {
      if (target === "config-migration:cancel") modal.selected = "cancel";
      else if (target === "config-migration:apply") modal.selected = "apply";
      this.#emit();
      return;
    }
    if (modal.kind === "edit_scalar") return;
    if (modal.kind === "configure") {
      if (target.startsWith("config:domain:")) {
        modal.sectionIndex = Math.max(0, Math.min(modal.catalog.sections.length - 1, Number.parseInt(target.slice("config:domain:".length), 10) || 0));
        modal.resourceIndex = 0;
        modal.fieldIndex = 0;
        modal.focus = "tree";
      } else if (target.startsWith("config:resource:")) {
        const resources = selectedConfigSection(modal)?.resources ?? [];
        modal.resourceIndex = Math.max(0, Math.min(resources.length - 1, Number.parseInt(target.slice("config:resource:".length), 10) || 0));
        modal.fieldIndex = 0;
        modal.focus = "tree";
      } else if (target.startsWith("config:field:")) {
        const fields = selectedConfigResource(modal)?.fields ?? [];
        modal.fieldIndex = Math.max(0, Math.min(fields.length - 1, Number.parseInt(target.slice("config:field:".length), 10) || 0));
        modal.focus = "field";
      } else if (target === "config:publish") {
        modal.focus = "publish";
        await this.#publishConfiguration(modal);
        return;
      } else if (target === "config:resource-operation" && modal.resourceOperation !== undefined) {
        modal.resourceOperation.focus = "confirm";
        await this.#applyConfigResourceOperation(modal, modal.resourceOperation);
        return;
      }
      this.#emit();
      return;
    }
    if (modal.kind === "profile_conflicts" && target.startsWith("conflict:action:")) {
      modal.actionIndex = target.endsWith("upstream") ? 1 : 0;
      modal.focus = "actions";
      this.#emit();
    }
  }

  async #handleAnswerQuestion(
    modal: AnswerQuestionModalState,
    action: ControlCenterKeyAction,
  ): Promise<void> {
    const questions = this.#buildView().selectedRun?.questions ?? [];
    const current = Math.max(0, questions.findIndex((question) => question.id === modal.questionId));
    if (action.type === "details_tab" && questions.length > 0) {
      const next = questions[(current + action.delta + questions.length) % questions.length]!;
      this.#questionIndex = questions.indexOf(next);
      modal.questionId = next.id;
      this.#draftFor(next).editingNotes = modal.focus === "notes";
    } else if (action.type === "move" && modal.focus === "choices") {
      this.#moveQuestionOption(action.delta);
    } else if (action.type === "append_text" && modal.focus === "notes") {
      const question = questions[current];
      if (question !== undefined) {
        const draft = this.#draftFor(question);
        draft.notes = `${draft.notes}${action.text}`.slice(0, 1024 * 1024);
      }
    } else if (action.type === "backspace" && modal.focus === "notes") {
      const question = questions[current];
      if (question !== undefined) {
        const draft = this.#draftFor(question);
        draft.notes = removeLastCharacter(draft.notes);
      }
    } else if (action.type === "toggle_notes" && modal.focus === "notes") {
      modal.focus = "submit";
    } else if (action.type === "focus") {
      const fields = ["choices", "notes", "submit"] as const;
      const index = fields.indexOf(modal.focus);
      modal.focus = fields[(index + action.delta + fields.length) % fields.length]!;
    } else if (action.type === "activate") {
      if (modal.focus === "choices") modal.focus = "notes";
      else if (modal.focus === "notes") modal.focus = "submit";
      else {
        if (await this.#submitQuestion()) this.#modal = undefined;
      }
    } else if (action.type === "submit") {
      if (await this.#submitQuestion()) this.#modal = undefined;
    }
    const question = this.#currentQuestion(this.#buildView());
    if (question !== undefined) this.#draftFor(question).editingNotes = modal.focus === "notes";
    this.#emit();
  }

  async #handleActionPalette(
    modal: ActionPaletteModalState,
    action: ControlCenterKeyAction,
  ): Promise<void> {
    if (action.type === "move" || action.type === "details_tab" || action.type === "focus") {
      modal.selectedIndex = cycleIndex(modal.selectedIndex, Math.max(1, modal.actions.length), action.delta);
    } else if (action.type === "activate" || action.type === "submit") {
      const selected = modal.actions[modal.selectedIndex];
      if (selected !== undefined) await this.#activateCapability(selected);
      return;
    }
    this.#emit();
  }

  async #handleActionForm(
    modal: ActionFormModalState,
    action: ControlCenterKeyAction,
  ): Promise<void> {
    const fields = modal.action.form?.fields ?? [];
    const shown = fields.map((field, index) => ({ field, index }))
      .filter(({ field }) => field.visibility !== "hidden");
    const selected = fields[modal.fieldIndex];
    if (action.type === "focus") {
      modal.editing = false;
      const zones = [
        ...(shown.length === 0 ? [] : ["fields" as const]),
        ...(modal.action.confirmation.required ? ["confirmation" as const] : []),
        "submit" as const,
      ];
      modal.focus = moveString(zones, modal.focus, action.delta);
    } else if (action.type === "move" && modal.focus === "fields" && shown.length > 0 && !modal.editing) {
      const current = Math.max(0, shown.findIndex((item) => item.index === modal.fieldIndex));
      modal.fieldIndex = shown[cycleIndex(current, shown.length, action.delta)]!.index;
      modal.cursor = characterCount(actionFieldText(fields[modal.fieldIndex], modal.values));
      delete modal.error;
    } else if (action.type === "details_tab" && modal.focus === "fields" && selected !== undefined) {
      if (modal.editing && isTextActionField(selected)) {
        modal.cursor = clampCharacterOffset(actionFieldText(selected, modal.values), modal.cursor + action.delta);
      } else if (!selected.locked) {
        cycleActionFieldValue(selected, modal.values, action.delta);
        delete modal.error;
      }
    } else if (action.type === "scroll_home" && modal.editing && selected !== undefined) {
      modal.cursor = 0;
    } else if (action.type === "scroll_end" && modal.editing && selected !== undefined) {
      modal.cursor = characterCount(actionFieldText(selected, modal.values));
    } else if (action.type === "append_text" && modal.editing && selected !== undefined && isTextActionField(selected)) {
      const edit = insertBoundedAtCharacter(
        actionFieldText(selected, modal.values),
        modal.cursor,
        action.text,
        selected.maxBytes ?? 1024 * 1024,
      );
      setActionFieldText(selected, modal.values, edit.value);
      modal.cursor = edit.cursor;
      delete modal.error;
    } else if (action.type === "backspace" && modal.editing && selected !== undefined && isTextActionField(selected)) {
      const edit = removeCharacterBefore(actionFieldText(selected, modal.values), modal.cursor);
      setActionFieldText(selected, modal.values, edit.value);
      modal.cursor = edit.cursor;
      delete modal.error;
    } else if (action.type === "delete_forward" && modal.editing && selected !== undefined && isTextActionField(selected)) {
      setActionFieldText(selected, modal.values, removeCharacterAt(actionFieldText(selected, modal.values), modal.cursor));
      delete modal.error;
    } else if (action.type === "activate") {
      if (modal.focus === "fields" && selected !== undefined) {
        if (selected.locked) modal.error = `${selected.label} is bound by the compiler and cannot be changed.`;
        else if (isTextActionField(selected)) {
          if (modal.editing && selected.kind === "multiline") {
            const edit = insertBoundedAtCharacter(actionFieldText(selected, modal.values), modal.cursor, "\n", selected.maxBytes ?? 1024 * 1024);
            setActionFieldText(selected, modal.values, edit.value);
            modal.cursor = edit.cursor;
          } else {
            modal.editing = !modal.editing;
            modal.cursor = characterCount(actionFieldText(selected, modal.values));
          }
        } else cycleActionFieldValue(selected, modal.values, 1);
      } else if (modal.focus === "confirmation") modal.confirmed = !modal.confirmed;
      else if (modal.focus === "submit") await this.#submitActionForm(modal);
    } else if (action.type === "submit") {
      await this.#submitActionForm(modal);
    }
    this.#emit();
  }

  async #submitActionForm(modal: ActionFormModalState): Promise<void> {
    if (modal.action.confirmation.required && !modal.confirmed) {
      modal.error = `Select “${modal.action.confirmation.confirmLabel}” before continuing.`;
      modal.focus = "confirmation";
      this.#emit();
      return;
    }
    for (const field of modal.action.form?.fields ?? []) {
      if (field.kind === "string_list" && Array.isArray(modal.values[field.key])) {
        modal.values[field.key] = (modal.values[field.key] as string[])
          .map((item) => item.trim())
          .filter((item) => item.length > 0);
      }
      const value = modal.values[field.key];
      if (field.required && (value === undefined || value === "" || Array.isArray(value) && value.length === 0)) {
        modal.error = `${field.label} is required.`;
        modal.fieldIndex = (modal.action.form?.fields ?? []).indexOf(field);
        modal.focus = "fields";
        this.#emit();
        return;
      }
    }
    const { action, values, confirmed, binding } = modal;
    this.#modal = undefined;
    await this.#executeCapability(action, values, confirmed, binding);
  }

  #handleEditScalar(modal: EditScalarModalState, action: ControlCenterKeyAction): void {
    if (action.type === "details_tab") {
      modal.cursor = clampCharacterOffset(modal.value, modal.cursor + action.delta);
    } else if (action.type === "scroll_home") {
      modal.cursor = 0;
    } else if (action.type === "scroll_end") {
      modal.cursor = characterCount(modal.value);
    } else if (action.type === "append_text") {
      modal.value = insertAtCharacter(modal.value, modal.cursor, action.text).slice(0, 4 * 1024 * 1024);
      modal.cursor = Math.min(characterCount(modal.value), modal.cursor + characterCount(action.text));
      delete modal.error;
    } else if (action.type === "backspace") {
      const edit = removeCharacterBefore(modal.value, modal.cursor);
      modal.value = edit.value;
      modal.cursor = edit.cursor;
      delete modal.error;
    } else if (action.type === "delete_forward") {
      modal.value = removeCharacterAt(modal.value, modal.cursor);
      delete modal.error;
    } else if (action.type === "activate") {
      if (modal.field.kind === "multiline" || modal.field.kind === "string_list") {
        modal.value = insertAtCharacter(modal.value, modal.cursor, "\n").slice(0, 4 * 1024 * 1024);
        modal.cursor += 1;
        delete modal.error;
      } else {
        this.#applyScalarEdit(modal);
      }
    } else if (action.type === "submit") {
      this.#applyScalarEdit(modal);
    }
    this.#emit();
  }

  #applyScalarEdit(modal: EditScalarModalState): void {
    const parsed = parseConfigScalar(modal.field, modal.value);
    if (typeof parsed === "string") {
      modal.error = parsed;
      return;
    }
    modal.returnTo.draft[modal.field.key] = parsed.value;
    modal.returnTo.dirty = !jsonEqual(modal.returnTo.draft, modal.returnTo.snapshot.values);
    modal.returnTo.editing = false;
    delete modal.returnTo.textEditor;
    this.#modal = modal.returnTo;
  }

  #restoreSuspendedModal(): void {
    this.#modal = this.#suspendedModal;
    this.#suspendedModal = undefined;
    this.#emit();
  }

  async #handleNewRun(modal: NewRunModalState, action: ControlCenterKeyAction): Promise<void> {
    const intakeField = selectedNewRunIntakeField(modal, this.#controlCatalog);
    const textField = intakeField !== undefined && isTextEditableIntake(intakeField.kind) ? intakeField : undefined;
    const textValue = textField === undefined ? "" : modal.intakeText[textField.id] ?? "";
    const textCursor = textField === undefined ? 0 : modal.intakeCursors[textField.id] ?? 0;
    if (action.type === "focus" || action.type === "move") {
      modal.focus = moveString(newRunControls(modal, this.#controlCatalog), modal.focus, action.delta);
      this.#emit();
      return;
    }
    if (action.type === "page") {
      modal.stageScroll = Math.max(0, modal.stageScroll + action.delta * 6);
      this.#emit();
      return;
    }
    if (action.type === "details_tab" && textField !== undefined) {
      setNewRunIntakeText(modal, this.#controlCatalog, textField.id, textValue, clampCharacterOffset(textValue, textCursor + action.delta));
      this.#emit();
      return;
    }
    if (action.type === "scroll_home" && textField !== undefined) {
      setNewRunIntakeText(modal, this.#controlCatalog, textField.id, textValue, 0);
      this.#emit();
      return;
    }
    if (action.type === "scroll_end" && textField !== undefined) {
      setNewRunIntakeText(modal, this.#controlCatalog, textField.id, textValue, characterCount(textValue));
      this.#emit();
      return;
    }
    if (action.type === "details_tab") {
      this.#adjustNewRun(modal, action.delta);
      this.#emit();
      return;
    }
    if (action.type === "backspace" && textField !== undefined) {
      const edit = removeCharacterBefore(textValue, textCursor);
      setNewRunIntakeText(modal, this.#controlCatalog, textField.id, edit.value, edit.cursor);
      this.#emit();
      return;
    }
    if (action.type === "delete_forward" && textField !== undefined) {
      setNewRunIntakeText(modal, this.#controlCatalog, textField.id, removeCharacterAt(textValue, textCursor), textCursor);
      this.#emit();
      return;
    }
    if (action.type === "append_text" && textField !== undefined) {
      const edit = insertBoundedAtCharacter(textValue, textCursor, action.text, 4 * 1024 * 1024);
      setNewRunIntakeText(modal, this.#controlCatalog, textField.id, edit.value, edit.cursor);
      this.#emit();
      return;
    }
    if (action.type === "activate") {
      if (textField !== undefined) {
        if (textField.kind === "text" || textField.kind === "json") {
          const edit = insertBoundedAtCharacter(textValue, textCursor, "\n", 4 * 1024 * 1024);
          setNewRunIntakeText(modal, this.#controlCatalog, textField.id, edit.value, edit.cursor);
        } else {
          modal.focus = moveString(newRunControls(modal, this.#controlCatalog), modal.focus, 1);
        }
      }
      else if (modal.focus === "start") await this.#startRun(modal);
      else if (intakeField?.kind === "multi_choice" || intakeField?.kind === "boolean") toggleNewRunIntake(modal, intakeField);
      else this.#adjustNewRun(modal, 1);
      this.#emit();
      return;
    }
    if (action.type === "submit" && modal.focus === "start") await this.#startRun(modal);
  }

  #adjustNewRun(modal: NewRunModalState, delta: -1 | 1): void {
    const catalog = this.#controlCatalog;
    if (catalog === undefined) return;
    if (modal.focus === "run_type") {
      const ids = catalog.runTypes.map((item) => item.id);
      const selected = moveString(ids, modal.runTypeId, delta);
      const runType = catalog.runTypes.find((item) => item.id === selected)!;
      applyRunTypeDefaults(modal, runType, this.#models);
    } else if (modal.focus === "branch") {
      modal.branchIndex = cycleIndex(modal.branchIndex, modal.branches.length, delta);
    } else if (modal.focus === "questions") {
      const values = ["none", "some", "many"] as const;
      modal.questionPolicy = moveString(values, modal.questionPolicy, delta);
    } else if (modal.focus === "parallel") {
      modal.maxParallel = Math.max(1, modal.maxParallel + delta);
    } else if (modal.focus.startsWith("intake:")) {
      const field = selectedNewRunIntakeField(modal, catalog);
      if (field !== undefined) adjustNewRunIntake(modal, field, delta);
    } else if (modal.focus.startsWith("role:")) {
      const [, roleId, column] = modal.focus.split(":");
      const role = modal.roles.find((item) => item.id === roleId);
      if (role === undefined) return;
      if (column === "model") {
        const models = selectableModels(this.#models, role.provider, role.model);
        if (models.length === 0) return;
        const current = Math.max(0, models.findIndex((model) => model.provider === role.provider && model.id === role.model));
        const selected = models[cycleIndex(current, models.length, delta)]!;
        role.provider = selected.provider;
        role.model = selected.id;
        role.thinkingLevel = nearestThinkingLevel(selected.thinkingLevels, role.thinkingLevel);
      } else {
        const model = this.#models.find((candidate) =>
          candidate.provider === role.provider && candidate.id === role.model);
        const levels = model?.thinkingLevels ?? [];
        if (levels.length === 0) return;
        role.thinkingLevel = moveOptionalString(levels, role.thinkingLevel, delta);
      }
    }
  }

  async #startRun(modal: NewRunModalState): Promise<void> {
    const branch = modal.branches[modal.branchIndex];
    if (branch === undefined) {
      this.#notice = { kind: "error", message: "Target branch is required" };
      return;
    }
    const runType = this.#controlCatalog?.runTypes.find((item) => item.id === modal.runTypeId);
    if (runType === undefined) {
      this.#notice = { kind: "error", message: "Selected run type is no longer available" };
      return;
    }
    let intake: ConfigurationObject;
    try {
      intake = buildNewRunTypedIntake(modal, runType);
    } catch (error) {
      this.#notice = { kind: "error", message: errorMessage(error) };
      return;
    }
    const objectiveValue = intake[runType.objectiveFieldId];
    const objective = typeof objectiveValue === "string" ? objectiveValue.trim() : "";
    if (objective.length === 0) {
      this.#notice = { kind: "error", message: "Objective is required" };
      return;
    }
    const admissionIssue = sealedModelAdmissionIssue(modal.roles, this.#models);
    if (admissionIssue !== undefined) {
      this.#notice = {
        kind: "error",
        message: admissionIssue.message,
      };
      return;
    }
    const provisionalId = `provisional:${randomUUID()}`;
    this.#provisionals.unshift({
      id: provisionalId,
      objective,
      runType: runType.title,
      targetBranch: branch.reference,
      createdAt: new Date(this.#now()).toISOString(),
    });
    this.#selection = { runId: provisionalId, detailsTab: "overview", objectiveExpanded: false };
    this.#modal = undefined;
    this.#busy = runType.startMode === "planning" ? "Starting planning…" : "Starting work…";
    this.#notice = undefined;
    this.#emit();
    try {
      const roles = Object.fromEntries(modal.roles.map((role) => [role.id, {
        provider: role.provider,
        model: role.model,
        thinkingLevel: role.thinkingLevel,
      }]));
      const response = await this.#client.request("run.create", {
        objective,
        runTypeId: modal.runTypeId,
        targetRef: branch.reference,
        intake: configurationObjectToJsonObject(intake),
        overrides: {
          questionPolicy: modal.questionPolicy,
          maxParallel: modal.maxParallel,
          roles,
        },
      }, {
        expectedRevision: this.#client.revision,
        idempotencyKey: `run.create:${randomUUID()}`,
      });
      const result = asRecord(response.result);
      if (typeof result?.runId !== "string") throw new Error("authority returned an invalid run creation response");
      const provisional = this.#provisionals.find((item) => item.id === provisionalId);
      if (provisional !== undefined) provisional.durableRunId = result.runId;
      await this.refresh();
    } catch (error) {
      this.#provisionals = this.#provisionals.filter((item) => item.id !== provisionalId);
      this.#modal = modal;
      this.#notice = { kind: "error", message: errorMessage(error) };
    } finally {
      this.#busy = undefined;
      this.#emit();
    }
  }

  async #handlePlanReview(modal: PlanReviewModalState, action: ControlCenterKeyAction): Promise<void> {
    if (action.type === "focus") {
      const values = ["document", "steering", "action"] as const;
      modal.focus = moveString(values, modal.focus, action.delta);
    } else if (action.type === "move" || action.type === "page") {
      const amount = action.type === "page" ? action.delta * 8 : action.delta;
      if (modal.focus === "document") modal.scroll = Math.max(0, modal.scroll + amount);
    } else if (action.type === "details_tab" && modal.focus === "steering") {
      modal.steeringCursor = clampCharacterOffset(modal.steering, modal.steeringCursor + action.delta);
    } else if (action.type === "scroll_home" && modal.focus === "steering") {
      modal.steeringCursor = 0;
    } else if (action.type === "scroll_end" && modal.focus === "steering") {
      modal.steeringCursor = characterCount(modal.steering);
    } else if (action.type === "details_tab") {
      const count = this.#selectedApproval()?.sections.length ?? 4;
      modal.sectionIndex = cycleIndex(modal.sectionIndex, Math.max(1, count), action.delta);
      modal.scroll = 0;
    } else if (action.type === "append_text" && modal.focus === "steering") {
      const edit = insertBoundedAtCharacter(modal.steering, modal.steeringCursor, action.text, 1024 * 1024);
      modal.steering = edit.value;
      modal.steeringCursor = edit.cursor;
    } else if (action.type === "backspace" && modal.focus === "steering") {
      const edit = removeCharacterBefore(modal.steering, modal.steeringCursor);
      modal.steering = edit.value;
      modal.steeringCursor = edit.cursor;
    } else if (action.type === "delete_forward" && modal.focus === "steering") {
      modal.steering = removeCharacterAt(modal.steering, modal.steeringCursor);
    } else if (action.type === "activate") {
      if (modal.focus === "steering") {
        const edit = insertBoundedAtCharacter(modal.steering, modal.steeringCursor, "\n", 1024 * 1024);
        modal.steering = edit.value;
        modal.steeringCursor = edit.cursor;
      }
      else if (modal.focus === "action") await this.#submitPlanReview(modal);
    } else if (action.type === "submit") await this.#submitPlanReview(modal);
    this.#emit();
  }

  async #handleProposalReview(
    modal: ProposalReviewModalState,
    action: ControlCenterKeyAction,
  ): Promise<void> {
    if (action.type === "focus") {
      modal.focus = moveString(["document", "message", "choice", "submit"] as const, modal.focus, action.delta);
    } else if ((action.type === "move" || action.type === "page") && modal.focus === "document") {
      const amount = action.type === "page" ? action.delta * 8 : action.delta;
      modal.scroll = Math.max(0, modal.scroll + amount);
    } else if ((action.type === "move" || action.type === "details_tab") && modal.focus === "choice") {
      modal.decision = modal.decision === "approval" ? "rejection" : "approval";
    } else if (action.type === "details_tab" && modal.focus === "message") {
      modal.messageCursor = clampCharacterOffset(modal.message, modal.messageCursor + action.delta);
    } else if (action.type === "scroll_home" && modal.focus === "message") {
      modal.messageCursor = 0;
    } else if (action.type === "scroll_end" && modal.focus === "message") {
      modal.messageCursor = characterCount(modal.message);
    } else if (action.type === "scroll_home" && modal.focus === "document") {
      modal.scroll = 0;
    } else if (action.type === "scroll_end" && modal.focus === "document") {
      modal.scroll = Number.MAX_SAFE_INTEGER;
    } else if (action.type === "append_text" && modal.focus === "message") {
      const edit = insertBoundedAtCharacter(modal.message, modal.messageCursor, action.text, 8_000);
      modal.message = edit.value;
      modal.messageCursor = edit.cursor;
    } else if (action.type === "backspace" && modal.focus === "message") {
      const edit = removeCharacterBefore(modal.message, modal.messageCursor);
      modal.message = edit.value;
      modal.messageCursor = edit.cursor;
    } else if (action.type === "delete_forward" && modal.focus === "message") {
      modal.message = removeCharacterAt(modal.message, modal.messageCursor);
    } else if (action.type === "activate") {
      if (modal.focus === "document") modal.focus = "message";
      else if (modal.focus === "message") {
        const edit = insertBoundedAtCharacter(modal.message, modal.messageCursor, "\n", 8_000);
        modal.message = edit.value;
        modal.messageCursor = edit.cursor;
      } else if (modal.focus === "choice") modal.focus = "submit";
      else this.#notice = { kind: "info", message: "Use Ctrl-Enter to record this decision" };
    } else if (action.type === "submit") {
      if (modal.focus === "submit") {
        await this.#decideProposal(modal);
        return;
      }
      this.#notice = { kind: "info", message: "Move to Record decision, then use Ctrl-Enter" };
    }
    this.#emit();
  }

  async #decideProposal(modal: ProposalReviewModalState): Promise<void> {
    if (modal.decision === undefined) {
      this.#notice = { kind: "info", message: "Choose Approve proposal or Reject proposal first" };
      this.#emit();
      return;
    }
    if (this.#busy !== undefined) return;
    const message = modal.message.trim();
    this.#busy = modal.decision === "approval" ? "Approving change proposal…" : "Rejecting change proposal…";
    this.#notice = undefined;
    this.#emit();
    try {
      const response = await this.#client.request("proposal.decide", {
        runId: modal.proposal.runId,
        ticketId: modal.proposal.ticketId,
        decision: modal.decision,
        ...(message.length === 0 ? {} : { message }),
      }, {
        expectedRevision: this.#client.revision,
        idempotencyKey: `proposal.decide:${randomUUID()}`,
      });
      const decided = parseControlProposalInspection(response.result);
      if (decided.runId !== modal.proposal.runId || decided.ticketId !== modal.proposal.ticketId) {
        throw new Error("authority recorded a decision for a different proposal");
      }
      this.#modal = undefined;
      await this.refresh();
      this.#notice = {
        kind: "info",
        message: modal.decision === "approval" ? "Change proposal approved" : "Change proposal rejected",
      };
    } catch (error) {
      if (isRevisionConflictError(error)) {
        await this.refresh();
        const ticket = this.#selectedRunRecord()?.tickets[modal.proposal.ticketId];
        if (ticket?.status === "proposed") {
          try {
            modal.proposal = parseControlProposalInspection((await this.#client.request("proposal.inspect", {
              runId: modal.proposal.runId,
              ticketId: modal.proposal.ticketId,
            })).result);
            modal.decision = undefined;
            modal.focus = "document";
            modal.scroll = 0;
          } catch {
            this.#modal = undefined;
          }
        } else this.#modal = undefined;
        this.#notice = {
          kind: "error",
          message: "Koni changed while this proposal was open. Review the refreshed proposal and confirm again.",
        };
      } else {
        this.#notice = { kind: "error", message: errorMessage(error) };
      }
    } finally {
      this.#busy = undefined;
      this.#emit();
    }
  }

  async #submitPlanReview(modal: PlanReviewModalState): Promise<void> {
    const instructions = modal.steering.trim();
    const capability = this.#findCapability(instructions.length === 0 ? "approve_run" : "revise_run_plan");
    this.#modal = undefined;
    if (capability !== undefined) {
      await this.#executeCapability(
        capability,
        instructions.length === 0 ? {} : { instructions },
        false,
      );
      return;
    }
    const method = instructions.length === 0 ? "plan.approve" : "plan.revise";
    await this.#mutate(method, { runId: modal.runId, ...(instructions.length === 0 ? {} : { instructions }) },
      instructions.length === 0 ? "Approving plan…" : "Requesting revised plan…");
  }

  async #handleConfigure(modal: ConfigureModalState, action: ControlCenterKeyAction): Promise<void> {
    if (action.type === "open_config_documents") {
      await this.#openConfigDocuments(modal);
      return;
    }
    if (modal.resourceOperation !== undefined) {
      await this.#handleConfigResourceOperation(modal, modal.resourceOperation, action);
      this.#emit();
      return;
    }
    if (action.type === "open_conflicts") {
      await this.#openProfileConflicts(modal);
    } else if (action.type === "config_resource_create") {
      this.#openConfigResourceOperation(modal, "create");
    } else if (action.type === "config_resource_duplicate") {
      this.#openConfigResourceOperation(modal, "duplicate");
    } else if (action.type === "config_resource_delete") {
      this.#openConfigResourceOperation(modal, "delete");
    } else if (action.type === "save_draft") {
      if (modal.rebaseRequired) {
        this.#notice = { kind: "error", message: "Rebase or discard this stale draft before saving it again" };
      } else {
        this.#savedConfigDraft = {
          cas: structuredClone(modal.snapshot.cas),
          base: structuredClone(modal.snapshot.values) as Record<string, JsonValue>,
          values: structuredClone(modal.draft),
        };
        this.#notice = { kind: "info", message: "Draft saved in this control center" };
      }
    } else if (action.type === "discard_draft") {
      modal.draft = structuredClone(modal.snapshot.values) as Record<string, JsonValue>;
      modal.dirty = false;
      modal.editing = false;
      modal.rebaseRequired = false;
      delete modal.textEditor;
      this.#savedConfigDraft = undefined;
      this.#notice = { kind: "info", message: "Draft restored to active configuration" };
    } else if (action.type === "rebase_draft") {
      this.#rebaseConfigurationDraft(modal);
    } else if (action.type === "publish" || action.type === "submit" || (action.type === "activate" && modal.focus === "publish")) {
      await this.#publishConfiguration(modal);
    } else if (action.type === "focus") {
      modal.focus = moveString(configFocuses(modal), modal.focus, action.delta);
      modal.editing = false;
      delete modal.textEditor;
    } else if (action.type === "move") {
      if (modal.focus === "tree") moveConfigResource(modal, action.delta);
      else if (modal.focus === "field") moveConfigField(modal, action.delta);
      else if (modal.focus === "actions") modal.actionIndex = cycleIndex(modal.actionIndex, configResourceActions(modal).length, action.delta);
    } else if (action.type === "details_tab") {
      if (modal.focus === "tree") moveConfigSection(modal, action.delta);
      else if (modal.focus === "field" && !modal.editing) adjustConfigField(modal, action.delta, this.#models);
      else if (modal.focus === "actions") modal.actionIndex = cycleIndex(modal.actionIndex, configResourceActions(modal).length, action.delta);
    } else if (action.type === "activate" && modal.focus === "field") {
      const field = selectedConfigField(modal);
      if (field !== undefined) {
        if (field.kind === "select" || field.kind === "model" || field.kind === "thinking") {
          adjustConfigField(modal, 1, this.#models);
          this.#emit();
          return;
        }
        const value = configEditableScalar(field, modal.draft[field.key]);
        this.#modal = {
          kind: "edit_scalar",
          field: structuredClone(field),
          value,
          cursor: characterCount(value),
          returnTo: modal,
        };
      }
    } else if (action.type === "activate" && modal.focus === "actions") {
      const selected = configResourceActions(modal)[modal.actionIndex];
      if (selected !== undefined) this.#openConfigResourceOperation(modal, selected);
    } else if (action.type === "append_text" && modal.editing) {
      editConfigText(modal, (value) => `${value}${action.text}`);
    } else if (action.type === "backspace" && modal.editing) {
      editConfigText(modal, removeLastCharacter);
    }
    this.#emit();
  }

  async #loadProfileConflicts(): Promise<ControlProfileConflictCatalog> {
    if (this.#profileConflictRpcAvailable === false) return emptyProfileConflictCatalog();
    try {
      const catalog = parseProfileConflictCatalog((await this.#client.request("profile.conflicts.list")).result);
      this.#profileConflictRpcAvailable = true;
      return catalog;
    } catch (error) {
      if (isMissingMethod(error) || /unexpected RPC profile\.conflicts\.list/iu.test(errorMessage(error))) {
        this.#profileConflictRpcAvailable = false;
        return emptyProfileConflictCatalog();
      }
      throw error;
    }
  }

  async #openProfileConflicts(configure: ConfigureModalState): Promise<void> {
    if (this.#profileConflictRpcAvailable === false) {
      this.#notice = { kind: "info", message: "This authority build does not expose upstream profile review" };
      return;
    }
    if (configure.upstreamConflicts.conflicts.length === 0) {
      this.#notice = { kind: "info", message: "No upstream profile changes need review" };
      return;
    }
    this.#busy = "Loading upstream comparison…";
    this.#emit();
    try {
      const selected = configure.upstreamConflicts.conflicts[0]!;
      const inspection = parseProfileConflictInspection((await this.#client.request(
        "profile.conflicts.inspect",
        { path: selected.path },
      )).result);
      this.#modal = {
        kind: "profile_conflicts",
        catalog: configure.upstreamConflicts,
        selectedIndex: 0,
        inspection,
        focus: "list",
        actionIndex: 0,
        scroll: 0,
        returnTo: configure,
      };
    } catch (error) {
      this.#notice = { kind: "error", message: errorMessage(error) };
    } finally {
      this.#busy = undefined;
      this.#emit();
    }
  }

  async #handleProfileConflicts(
    modal: ProfileConflictsModalState,
    action: ControlCenterKeyAction,
  ): Promise<void> {
    if (action.type === "focus") {
      modal.focus = modal.focus === "list" ? "actions" : "list";
    } else if (action.type === "move" && modal.focus === "list") {
      const targetIndex = cycleIndex(modal.selectedIndex, modal.catalog.conflicts.length, action.delta);
      await this.#reloadProfileConflictInspection(modal, targetIndex);
    } else if (action.type === "details_tab" && modal.focus === "actions") {
      modal.actionIndex = cycleIndex(modal.actionIndex, 2, action.delta);
    } else if (action.type === "page") {
      modal.scroll = Math.max(0, modal.scroll + action.delta * 8);
    } else if (action.type === "activate" || action.type === "submit") {
      if (modal.focus === "list") modal.focus = "actions";
      else await this.#resolveProfileConflict(modal);
    }
    this.#emit();
  }

  async #reloadProfileConflictInspection(
    modal: ProfileConflictsModalState,
    targetIndex = modal.selectedIndex,
  ): Promise<void> {
    const selected = modal.catalog.conflicts[targetIndex];
    if (selected === undefined) return;
    this.#busy = "Loading upstream comparison…";
    this.#emit();
    try {
      const inspection = parseProfileConflictInspection((await this.#client.request(
        "profile.conflicts.inspect",
        { path: selected.path },
      )).result);
      modal.selectedIndex = targetIndex;
      modal.inspection = inspection;
      modal.scroll = 0;
    } catch (error) {
      this.#notice = { kind: "error", message: errorMessage(error) };
    } finally {
      this.#busy = undefined;
    }
  }

  async #resolveProfileConflict(modal: ProfileConflictsModalState): Promise<void> {
    const selected = modal.catalog.conflicts[modal.selectedIndex];
    if (selected === undefined) return;
    const resolution = modal.actionIndex === 0 ? "keep_project" : "accept_upstream";
    this.#busy = resolution === "keep_project" ? "Keeping project version…" : "Applying upstream version…";
    this.#notice = undefined;
    this.#emit();
    try {
      await this.#client.request("profile.conflicts.resolve", {
        path: selected.path,
        expectedLifecycleGeneration: modal.inspection.lifecycleGeneration,
        expectedProjectSha256: modal.inspection.conflict.currentSha256,
        resolution,
      }, {
        expectedRevision: this.#client.revision,
        idempotencyKey: `profile.conflicts.resolve:${randomUUID()}`,
      });
      const catalog = await this.#loadProfileConflicts();
      modal.returnTo.upstreamConflicts = catalog;
      if (catalog.conflicts.length === 0) {
        this.#modal = modal.returnTo;
        this.#notice = { kind: "info", message: "All upstream profile changes are resolved" };
      } else {
        modal.catalog = catalog;
        modal.selectedIndex = Math.min(modal.selectedIndex, catalog.conflicts.length - 1);
        modal.actionIndex = 0;
        modal.focus = "list";
        modal.scroll = 0;
        await this.#reloadProfileConflictInspection(modal);
        this.#notice = {
          kind: "info",
          message: resolution === "keep_project" ? "Kept the project version" : "Applied the upstream version",
        };
      }
      this.#controlCatalog = undefined;
    } catch (error) {
      try {
        const catalog = await this.#loadProfileConflicts();
        modal.catalog = catalog;
        modal.returnTo.upstreamConflicts = catalog;
        if (catalog.conflicts.length > 0) {
          modal.selectedIndex = Math.min(modal.selectedIndex, catalog.conflicts.length - 1);
          await this.#reloadProfileConflictInspection(modal);
        }
      } catch {}
      this.#notice = { kind: "error", message: errorMessage(error) };
    } finally {
      this.#busy = undefined;
      this.#emit();
    }
  }

  #openConfigResourceOperation(
    modal: ConfigureModalState,
    kind: "create" | "duplicate" | "delete",
  ): void {
    if (modal.rebaseRequired) {
      this.#notice = { kind: "error", message: "Rebase or discard the stale draft before changing whole resources" };
      return;
    }
    if (modal.dirty) {
      this.#notice = { kind: "info", message: "Publish or discard field edits before changing whole resources" };
      return;
    }
    const section = selectedConfigSection(modal);
    const resource = selectedConfigResource(modal);
    if (section === undefined) return;
    if (kind === "create") {
      const resourceOptions = resource?.createOptions ?? [];
      const options = resourceOptions.length > 0 ? resourceOptions : section.createOptions ?? [];
      if (options.length === 0) {
        this.#notice = { kind: "info", message: "This configuration domain has no addable resource types" };
        return;
      }
      modal.resourceOperation = {
        kind,
        focus: options.length > 1 ? "template" : "name",
        sectionId: section.id,
        ...(resourceOptions.length > 0 && resource !== undefined ? { parentResourceId: resource.id } : {}),
        options,
        templateIndex: 0,
        name: options[0]!.suggestedName,
      };
      return;
    }
    if (resource === undefined || (kind === "duplicate" ? resource.canDuplicate !== true : resource.canDelete !== true)) {
      this.#notice = { kind: "info", message: `The selected resource cannot be ${kind === "duplicate" ? "duplicated" : "deleted"}` };
      return;
    }
    modal.resourceOperation = {
      kind,
      focus: kind === "delete" ? "confirm" : "name",
      sectionId: section.id,
      resourceId: resource.id,
      resourceTitle: resource.title,
      options: [],
      templateIndex: 0,
      name: kind === "duplicate" ? `${resource.title} copy` : "",
    };
  }

  async #handleConfigResourceOperation(
    modal: ConfigureModalState,
    operation: ConfigResourceOperationState,
    action: ControlCenterKeyAction,
  ): Promise<void> {
    const focuses = operation.kind === "create"
      ? operation.options.length > 1 ? ["template", "name", "confirm"] as const : ["name", "confirm"] as const
      : operation.kind === "duplicate" ? ["name", "confirm"] as const : ["confirm"] as const;
    if (action.type === "focus" || action.type === "move") {
      operation.focus = moveString(focuses, operation.focus, action.delta);
    } else if (action.type === "details_tab" && operation.focus === "template") {
      operation.templateIndex = cycleIndex(operation.templateIndex, operation.options.length, action.delta);
      operation.name = operation.options[operation.templateIndex]?.suggestedName ?? operation.name;
    } else if (action.type === "append_text" && operation.focus === "name") {
      operation.name = `${operation.name}${action.text.replace(/[\r\n]+/gu, " ")}`.slice(0, 512);
    } else if (action.type === "backspace" && operation.focus === "name") {
      operation.name = removeLastCharacter(operation.name);
    } else if (action.type === "activate") {
      if (operation.focus === "template") operation.focus = "name";
      else if (operation.focus === "name") operation.focus = "confirm";
      else await this.#applyConfigResourceOperation(modal, operation);
    } else if (action.type === "submit" && operation.focus === "confirm") {
      await this.#applyConfigResourceOperation(modal, operation);
    }
  }

  async #applyConfigResourceOperation(
    modal: ConfigureModalState,
    operation: ConfigResourceOperationState,
  ): Promise<void> {
    const name = operation.name.trim();
    if (operation.kind !== "delete" && name.length === 0) {
      operation.focus = "name";
      this.#notice = { kind: "error", message: "A resource name is required" };
      return;
    }
    const method = `config.resource.${operation.kind}`;
    const params: Record<string, JsonValue> = { cas: modal.snapshot.cas };
    if (operation.kind === "create") {
      const option = operation.options[operation.templateIndex];
      if (option === undefined) return;
      params.sectionId = operation.sectionId;
      params.templateId = option.id;
      params.name = name;
      if (operation.parentResourceId !== undefined) params.parentResourceId = operation.parentResourceId;
    } else {
      if (operation.resourceId === undefined) return;
      params.resourceId = operation.resourceId;
      if (operation.kind === "duplicate") params.name = name;
    }
    this.#busy = operation.kind === "create" ? "Creating resource…"
      : operation.kind === "duplicate" ? "Duplicating resource…" : "Deleting resource…";
    this.#notice = undefined;
    this.#emit();
    try {
      await this.#client.request(method, params, {
        expectedRevision: this.#client.revision,
        idempotencyKey: `${method}:${randomUUID()}`,
      });
      await this.#reloadConfigurationModal(modal, name);
      this.#notice = { kind: "info", message: operation.kind === "create" ? "Resource created"
        : operation.kind === "duplicate" ? "Resource duplicated" : "Resource deleted" };
    } catch (error) {
      if (isStaleConfiguration(error)) {
        try {
          await this.#reloadConfigurationModal(modal);
          this.#notice = { kind: "error", message: "Configuration changed elsewhere. The resource action was not applied." };
        } catch (refreshError) {
          this.#notice = { kind: "error", message: errorMessage(refreshError) };
        }
      } else this.#notice = { kind: "error", message: errorMessage(error) };
    } finally {
      this.#busy = undefined;
      this.#emit();
    }
  }

  async #reloadConfigurationModal(modal: ConfigureModalState, preferredTitle?: string): Promise<void> {
    const [catalogResponse, snapshotResponse, upstreamConflicts] = await Promise.all([
      this.#client.request("config.catalog"),
      this.#client.request("config.get"),
      this.#loadProfileConflicts(),
    ]);
    modal.catalog = parseConfigCatalog(catalogResponse.result);
    modal.snapshot = parseConfigSnapshot(snapshotResponse.result);
    modal.upstreamConflicts = upstreamConflicts;
    modal.draft = structuredClone(modal.snapshot.values) as Record<string, JsonValue>;
    modal.dirty = false;
    modal.rebaseRequired = false;
    modal.editing = false;
    modal.focus = "tree";
    modal.actionIndex = 0;
    delete modal.textEditor;
    delete modal.resourceOperation;
    this.#savedConfigDraft = undefined;
    this.#controlCatalog = undefined;
    modal.sectionIndex = Math.min(modal.sectionIndex, Math.max(0, modal.catalog.sections.length - 1));
    const resources = selectedConfigSection(modal)?.resources ?? [];
    const preferredIndex = preferredTitle === undefined ? -1 : resources.findIndex((resource) => resource.title === preferredTitle);
    modal.resourceIndex = preferredIndex >= 0 ? preferredIndex : Math.min(modal.resourceIndex, Math.max(0, resources.length - 1));
    modal.fieldIndex = 0;
  }

  async #publishConfiguration(modal: ConfigureModalState): Promise<void> {
    if (modal.rebaseRequired) {
      this.#notice = { kind: "error", message: "Rebase or discard the stale draft before publishing" };
      return;
    }
    if (!modal.dirty) {
      this.#notice = { kind: "info", message: "Configuration already matches the active project" };
      return;
    }
    this.#busy = "Validating and publishing configuration…";
    this.#emit();
    try {
      await this.#client.request("config.update", {
        cas: modal.snapshot.cas,
        values: modal.draft,
      }, {
        expectedRevision: this.#client.revision,
        idempotencyKey: `config.update:${randomUUID()}`,
      });
      const refreshed = parseConfigSnapshot((await this.#client.request("config.get")).result);
      modal.snapshot = refreshed;
      modal.draft = structuredClone(refreshed.values) as Record<string, JsonValue>;
      modal.dirty = false;
      modal.rebaseRequired = false;
      modal.editing = false;
      delete modal.textEditor;
      this.#savedConfigDraft = undefined;
      this.#notice = { kind: "info", message: "Configuration published for future runs" };
      this.#controlCatalog = undefined;
    } catch (error) {
      if (isStaleConfiguration(error)) {
        try {
          const origin = modal.snapshot;
          this.#savedConfigDraft = {
            cas: structuredClone(origin.cas),
            base: structuredClone(origin.values) as Record<string, JsonValue>,
            values: structuredClone(modal.draft),
          };
          modal.snapshot = parseConfigSnapshot((await this.#client.request("config.get")).result);
          modal.dirty = !jsonEqual(modal.draft, modal.snapshot.values);
          modal.rebaseRequired = true;
          this.#notice = { kind: "error", message: "Configuration changed elsewhere. Your draft was kept; rebase or discard it before publishing." };
        } catch (refreshError) {
          this.#notice = { kind: "error", message: errorMessage(refreshError) };
        }
      } else this.#notice = { kind: "error", message: errorMessage(error) };
    } finally {
      this.#busy = undefined;
      this.#emit();
    }
  }

  #rebaseConfigurationDraft(modal: ConfigureModalState): void {
    if (!modal.rebaseRequired) {
      this.#notice = { kind: "info", message: "Draft already uses the current project configuration" };
      return;
    }
    const saved = this.#savedConfigDraft;
    if (saved === undefined) {
      modal.rebaseRequired = false;
      return;
    }
    const rebased = rebaseConfigValues(saved.base, modal.draft, modal.snapshot.values);
    modal.draft = rebased.values;
    modal.dirty = !jsonEqual(modal.draft, modal.snapshot.values);
    modal.rebaseRequired = false;
    modal.editing = false;
    delete modal.textEditor;
    this.#savedConfigDraft = {
      cas: structuredClone(modal.snapshot.cas),
      base: structuredClone(modal.snapshot.values) as Record<string, JsonValue>,
      values: structuredClone(modal.draft),
    };
    this.#notice = {
      kind: rebased.conflicts > 0 ? "error" : "info",
      message: rebased.conflicts > 0
        ? `Rebased with ${rebased.conflicts} overlapping ${rebased.conflicts === 1 ? "field" : "fields"}; your draft values were kept. Review before publishing.`
        : "Draft rebased onto the current project configuration. Review before publishing.",
    };
  }

  async #loadTranscript(attemptId: string): Promise<void> {
    if (this.#transcriptRpcAvailable === false) {
      const runId = this.#selection.runId;
      if (runId !== undefined) {
        this.#rememberTranscript(attemptId, {
          status: "unavailable",
          runId,
          startBlock: 0,
          totalBlocks: 0,
          blocks: [],
          diagnostics: [],
        });
        this.#emit();
      }
      return;
    }
    const existing = this.#transcripts.get(attemptId);
    if (existing?.status === "ready" && existing.runId === this.#selection.runId) {
      this.#rememberTranscript(attemptId, existing);
      return;
    }
    if (existing?.status === "loading" && existing.runId === this.#selection.runId) {
      this.#transcriptReloadPending.add(attemptId);
      return;
    }
    await this.#replaceTranscriptWindow(attemptId);
  }

  async #replaceTranscriptWindow(
    attemptId: string,
    cursor?: string,
    expectation?: TranscriptWindowExpectation,
  ): Promise<void> {
    const run = this.#selectedRunRecord();
    const attempt = run?.attempts[attemptId];
    if (run === undefined || attempt === undefined) return;
    const previous = this.#transcripts.get(attemptId);
    if (previous?.status === "loading" && previous.runId === run.id) {
      this.#transcriptReloadPending.add(attemptId);
      return;
    }
    if (previous?.runId !== run.id) this.#transcriptReloadPending.delete(attemptId);
    const previousForRun = previous?.runId === run.id ? previous : undefined;
    const requestId = ++this.#transcriptRequestSequence;
    this.#rememberTranscript(attemptId, {
      status: "loading",
      runId: run.id,
      requestId,
      startBlock: previousForRun?.startBlock ?? 0,
      totalBlocks: previousForRun?.totalBlocks ?? 0,
      blocks: previousForRun?.blocks.map(cloneTranscriptBlock) ?? [],
      diagnostics: previousForRun === undefined ? [] : [...previousForRun.diagnostics],
    });
    this.#emit();
    let ownsRequest = true;
    try {
      const projection = await this.#requestTranscriptWindow(run.id, attemptId, attempt.sessionId, cursor);
      ownsRequest = this.#transcripts.get(attemptId)?.requestId === requestId;
      if (!ownsRequest) return;
      if (expectation !== undefined) this.#validateAdjacentTranscriptWindow(expectation, projection);
      this.#transcriptRpcAvailable = true;
      this.#rememberTranscript(attemptId, projection);
    } catch (error) {
      ownsRequest = this.#transcripts.get(attemptId)?.requestId === requestId;
      if (!ownsRequest) return;
      if (isMissingMethod(error)) {
        this.#transcriptRpcAvailable = false;
        this.#rememberTranscript(attemptId, {
          status: "unavailable",
          runId: run.id,
          startBlock: 0,
          totalBlocks: 0,
          blocks: [],
          diagnostics: [],
        });
      } else if (expectation !== undefined && previousForRun?.status === "ready") {
        this.#rememberTranscript(attemptId, previousForRun);
        this.#notice = { kind: "error", message: errorMessage(error) };
      } else {
        this.#rememberTranscript(attemptId, {
          status: "error",
          runId: run.id,
          startBlock: 0,
          totalBlocks: 0,
          blocks: [],
          diagnostics: [],
          error: errorMessage(error),
        });
      }
    }
    this.#emit();
    if (ownsRequest && this.#transcriptReloadPending.delete(attemptId) && !this.#disposed) {
      this.#reloadTranscript(attemptId);
    }
  }

  async #requestTranscriptWindow(
    runId: string,
    attemptId: string,
    expectedSessionId: string,
    cursor?: string,
  ): Promise<TranscriptState> {
    const response = await this.#client.request("run.transcript", {
      runId,
      attemptId,
      ...(cursor === undefined ? {} : { cursor }),
      limit: TRANSCRIPT_PAGE_LIMIT,
    });
    const page = parsePiTranscriptPage(response.result);
    if (page.sessionId !== expectedSessionId) {
      throw new Error("authority returned a Pi transcript page for a different agent session");
    }
    return {
      status: "ready",
      runId,
      ...(cursor === undefined ? {} : { requestCursor: cursor }),
      sessionId: page.sessionId,
      snapshotSha256: page.snapshot.sha256,
      snapshotEntryCount: page.snapshot.entryCount,
      ...(page.snapshot.lastEntryId === undefined ? {} : {
        snapshotLastEntryId: page.snapshot.lastEntryId,
      }),
      startBlock: page.startBlock,
      totalBlocks: page.totalBlocks,
      ...(page.previousCursor === undefined ? {} : { previousCursor: page.previousCursor }),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      blocks: page.blocks.map(cloneTranscriptBlock),
      diagnostics: [...page.diagnostics],
    };
  }

  #validateAdjacentTranscriptWindow(
    expectation: TranscriptWindowExpectation,
    next: TranscriptState,
  ): void {
    const current = expectation.state;
    if (next.status !== "ready" || current.status !== "ready" ||
        next.sessionId !== current.sessionId || next.snapshotSha256 !== current.snapshotSha256 ||
        next.snapshotEntryCount !== current.snapshotEntryCount ||
        next.snapshotLastEntryId !== current.snapshotLastEntryId ||
        next.totalBlocks !== current.totalBlocks) {
      throw new Error("adjacent Pi transcript page does not belong to the selected stable snapshot");
    }
    const currentEnd = current.startBlock + current.blocks.length;
    const nextEnd = next.startBlock + next.blocks.length;
    if (expectation.direction === "older" ? nextEnd !== current.startBlock : next.startBlock !== currentEnd) {
      throw new Error("authority returned a non-adjacent Pi transcript history window");
    }
  }

  async #moveTranscriptWindow(delta: -1 | 1): Promise<void> {
    const attemptId = this.#selection.attemptId;
    const current = attemptId === undefined ? undefined : this.#transcripts.get(attemptId);
    if (attemptId === undefined || current?.status !== "ready") return;
    const cursor = delta < 0 ? current.nextCursor : current.previousCursor;
    if (cursor === undefined) return;
    await this.#replaceTranscriptWindow(attemptId, cursor, {
      state: current,
      direction: delta < 0 ? "older" : "newer",
    });
    if (this.#transcripts.get(attemptId)?.status === "ready") this.#scroll.details = 0;
    this.#emit();
  }

  #reloadTranscript(attemptId: string): void {
    if (this.#transcriptRpcAvailable === false) {
      void this.#loadTranscript(attemptId);
      return;
    }
    const current = this.#transcripts.get(attemptId);
    if (current?.status === "loading") {
      this.#transcriptReloadPending.add(attemptId);
      return;
    }
    // Appends cannot change a cursor-pinned older prefix. Preserve the operator's reading place;
    // moving back to the head or explicitly reloading will pick up current live output.
    if (current?.status === "ready" && current.runId === this.#selection.runId &&
        current.previousCursor !== undefined) return;
    this.#transcripts.delete(attemptId);
    void this.#replaceTranscriptWindow(attemptId);
  }

  #chatProjection(): ChatProjectionState | undefined {
    const attemptId = this.#selection.attemptId;
    if (attemptId === undefined) return undefined;
    const cached = this.#transcripts.get(attemptId);
    const transcript = cached !== undefined && cached.runId === this.#selection.runId ? cached : {
      status: "loading" as const,
      startBlock: 0,
      totalBlocks: 0,
      blocks: [],
      diagnostics: [],
    };
    return {
      attemptId,
      status: transcript.status,
      blocks: transcript.blocks.map(cloneTranscriptBlock),
      diagnostics: [...transcript.diagnostics],
      history: {
        startBlock: transcript.startBlock,
        visibleBlocks: transcript.blocks.length,
        totalBlocks: transcript.totalBlocks,
        hasOlder: transcript.nextCursor !== undefined,
        hasNewer: transcript.previousCursor !== undefined,
      },
      ...(transcript.error === undefined ? {} : { error: transcript.error }),
      draft: { ...this.#chatDraft(attemptId) },
    };
  }

  #rememberTranscript(attemptId: string, state: TranscriptState): void {
    this.#transcripts.delete(attemptId);
    this.#transcripts.set(attemptId, state);
    while (this.#transcripts.size > MAX_TRANSCRIPT_WINDOWS) {
      let oldest = this.#transcripts.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      if (oldest === this.#selection.attemptId && this.#transcripts.size > 1) {
        const selected = this.#transcripts.get(oldest)!;
        this.#transcripts.delete(oldest);
        this.#transcripts.set(oldest, selected);
        oldest = this.#transcripts.keys().next().value as string | undefined;
        if (oldest === undefined) break;
      }
      this.#transcripts.delete(oldest);
      this.#transcriptReloadPending.delete(oldest);
    }
  }

  #chatDraft(attemptId: string): ChatDraftState {
    const key = `${this.#selection.runId ?? ""}\u0000${attemptId}`;
    let draft = this.#chatDrafts.get(key);
    if (draft === undefined) {
      draft = { attemptId, mode: "steer", text: "", editing: false };
      this.#chatDrafts.set(key, draft);
    }
    return draft;
  }

  #selectedChatDraft(): ChatDraftState | undefined {
    return this.#selection.attemptId === undefined ? undefined : this.#chatDraft(this.#selection.attemptId);
  }

  #toggleChatComposer(): void {
    if (this.#selection.detailsTab !== "chat") return;
    // A send remains authority-owned until its mutation and refresh settle. Keep the composer
    // closed during that boundary so fast terminal input cannot edit (and then lose) the draft
    // that is currently being committed.
    if (this.#busy !== undefined) return;
    const draft = this.#selectedChatDraft();
    if (draft === undefined) return;
    const attempt = this.#selectedRunRecord()?.attempts[draft.attemptId];
    if (attempt === undefined || !isActiveAttempt(attempt.status)) {
      this.#notice = { kind: "info", message: "Historical agent sessions are read-only" };
      this.#emit();
      return;
    }
    draft.editing = !draft.editing;
    this.#emit();
  }

  #toggleChatMode(): void {
    const draft = this.#selectedChatDraft();
    if (draft === undefined) return;
    draft.mode = draft.mode === "steer" ? "follow_up" : "steer";
    this.#emit();
  }

  async #sendChat(): Promise<void> {
    const draft = this.#selectedChatDraft();
    if (draft === undefined || !draft.editing || this.#busy !== undefined) return;
    const attempt = this.#selectedRunRecord()?.attempts[draft.attemptId];
    if (attempt === undefined || !isActiveAttempt(attempt.status)) {
      draft.editing = false;
      this.#notice = { kind: "info", message: "Historical agent sessions are read-only" };
      this.#emit();
      return;
    }
    const text = draft.text.trim();
    if (text.length === 0) {
      this.#notice = { kind: "info", message: "Write a message before sending" };
      this.#emit();
      return;
    }
    const mode = draft.mode;
    // Close and clear synchronously before the first await. ControlCenterComponent intentionally
    // dispatches terminal actions without awaiting them, so leaving this editor live would let a
    // second Ctrl-Enter race the in-flight mutation and silently clear an unsent message.
    draft.text = "";
    draft.editing = false;
    this.#emit();
    const response = await this.#mutate(mode === "steer" ? "agent.steer" : "agent.follow_up", {
      attemptId: draft.attemptId,
      text,
    }, mode === "steer" ? "Steering agent…" : "Sending follow-up…");
    if (response === undefined) {
      draft.mode = mode;
      draft.text = text;
      draft.editing = true;
      this.#emit();
      return;
    }
    this.#transcripts.delete(draft.attemptId);
    await this.#loadTranscript(draft.attemptId);
  }

  async #mutate(method: string, params: JsonValue, label: string): Promise<RpcSuccess | undefined> {
    if (this.#busy !== undefined) return undefined;
    this.#busy = label;
    this.#notice = undefined;
    this.#emit();
    try {
      const response = await this.#client.request(method, params, {
        expectedRevision: this.#client.revision,
        idempotencyKey: `${method}:${randomUUID()}`,
      });
      await this.refresh();
      return response;
    } catch (error) {
      this.#notice = { kind: "error", message: errorMessage(error) };
      return undefined;
    } finally {
      this.#busy = undefined;
      this.#emit();
    }
  }

  #selectedRunRecord(): RunRecord | undefined {
    return this.#selectedRun?.id === this.#selection.runId ? this.#selectedRun : undefined;
  }

  #selectedRunRow(): ControlCenterViewModel["runs"][number] | undefined {
    return this.#buildView().runs.find((run) => run.id === this.#selection.runId);
  }

  #selectedApproval(): NonNullable<ControlCenterViewModel["selectedRun"]>["approval"] | undefined {
    return this.#buildView().selectedRun?.approval;
  }

  #isProvisional(id: string): boolean {
    return this.#provisionals.some((run) => run.id === id);
  }

  #currentQuestion(view: ControlCenterViewModel): QuestionView | undefined {
    const questions = view.selectedRun?.questions ?? [];
    if (questions.length === 0) return undefined;
    this.#questionIndex = Math.min(this.#questionIndex, questions.length - 1);
    return questions[this.#questionIndex];
  }

  #draftFor(question: QuestionView): QuestionDraftState {
    let draft = this.#questionDrafts.get(question.id);
    if (draft === undefined) {
      draft = {
        questionId: question.id,
        selectedOptionId: question.savedSelectedOptionId ?? question.selectedOptionId ??
          question.recommendationOptionId ??
          question.options[0]?.id,
        notes: question.savedNotes ?? question.notes ?? "",
        editingNotes: false,
      };
      this.#questionDrafts.set(question.id, draft);
    }
    return draft;
  }

  #emit(): void {
    if (this.#disposed) return;
    const snapshot = this.snapshot;
    for (const listener of this.#listeners) listener(snapshot);
  }
}

function newRunModal(
  runType: ControlRunTypeOption,
  branches: readonly { label: string; reference: string }[],
  models: readonly ControlModelOption[],
): NewRunModalState {
  const modal: NewRunModalState = {
    kind: "new_run",
    objective: "",
    objectiveCursor: 0,
    intake: {},
    intakeText: {},
    intakeCursors: {},
    intakeOptionIndexes: {},
    runTypeId: runType.id,
    branches,
    branchIndex: 0,
    questionPolicy: runType.questionPolicy,
    maxParallel: runType.maxParallel,
    roles: [],
    focus: "objective",
    stageScroll: 0,
  };
  applyRunTypeDefaults(modal, runType, models);
  return modal;
}

function applyRunTypeDefaults(
  modal: NewRunModalState,
  runType: ControlRunTypeOption,
  models: readonly ControlModelOption[],
): void {
  modal.runTypeId = runType.id;
  modal.questionPolicy = runType.questionPolicy;
  modal.maxParallel = runType.maxParallel;
  modal.stageScroll = 0;
  modal.roles = runType.roles.map((role) => {
    const configured = models.find((model) => model.provider === role.provider && model.id === role.model);
    return { ...role, ...(configured === undefined ? {} : { provider: configured.provider, model: configured.id }) };
  });
  const previousText = modal.intakeText;
  const previousValues = modal.intake;
  modal.intake = {};
  modal.intakeText = {};
  modal.intakeCursors = {};
  modal.intakeOptionIndexes = {};
  for (const field of runType.intake) {
    const previous = previousValues[field.id];
    const initial = previous ?? field.default ?? initialControlIntakeValue(field);
    if (initial !== undefined) modal.intake[field.id] = structuredClone(initial);
    const source = previousText[field.id] ?? editableControlIntakeText(initial, field);
    modal.intakeText[field.id] = source;
    modal.intakeCursors[field.id] = characterCount(source);
    modal.intakeOptionIndexes[field.id] = Math.max(0, field.options.findIndex((option) => option.value === initial));
  }
  modal.objective = modal.intakeText[runType.objectiveFieldId] ?? "";
  modal.objectiveCursor = modal.intakeCursors[runType.objectiveFieldId] ?? 0;
}

function newRunControls(modal: NewRunModalState, catalog: ControlCatalog | undefined): string[] {
  const runType = catalog?.runTypes.find((candidate) => candidate.id === modal.runTypeId);
  return [
    "objective",
    ...(runType?.intake.filter((field) => field.id !== runType.objectiveFieldId).map((field) => `intake:${field.id}`) ?? []),
    "run_type",
    "branch",
    "stages",
    "questions",
    "parallel",
    ...modal.roles.flatMap((role) => [`role:${role.id}:model`, `role:${role.id}:thinking`]),
    "start",
  ];
}

function selectedNewRunIntakeField(
  modal: NewRunModalState,
  catalog: ControlCatalog | undefined,
): ControlIntakeField | undefined {
  const runType = catalog?.runTypes.find((candidate) => candidate.id === modal.runTypeId);
  if (runType === undefined) return undefined;
  const id = modal.focus === "objective"
    ? runType.objectiveFieldId
    : modal.focus.startsWith("intake:") ? modal.focus.slice("intake:".length) : undefined;
  return id === undefined ? undefined : runType.intake.find((field) => field.id === id);
}

function setNewRunIntakeText(
  modal: NewRunModalState,
  catalog: ControlCatalog | undefined,
  fieldId: string,
  value: string,
  cursor: number,
): void {
  modal.intakeText[fieldId] = value;
  modal.intakeCursors[fieldId] = Math.max(0, Math.min(characterCount(value), cursor));
  const runType = catalog?.runTypes.find((candidate) => candidate.id === modal.runTypeId);
  if (runType?.objectiveFieldId === fieldId) {
    modal.objective = value;
    modal.objectiveCursor = modal.intakeCursors[fieldId]!;
  }
}

function isTextEditableIntake(kind: ControlIntakeField["kind"]): boolean {
  return kind === "string" || kind === "text" || kind === "path" || kind === "integer" || kind === "number" || kind === "json";
}

function adjustNewRunIntake(modal: NewRunModalState, field: ControlIntakeField, delta: -1 | 1): void {
  if (field.kind === "boolean") {
    modal.intake[field.id] = !(modal.intake[field.id] === true);
    return;
  }
  if (field.kind !== "choice" && field.kind !== "multi_choice" || field.options.length === 0) return;
  const index = cycleIndex(modal.intakeOptionIndexes[field.id] ?? 0, field.options.length, delta);
  modal.intakeOptionIndexes[field.id] = index;
  if (field.kind === "choice") modal.intake[field.id] = field.options[index]!.value;
}

function toggleNewRunIntake(modal: NewRunModalState, field: ControlIntakeField): void {
  if (field.kind === "boolean") {
    modal.intake[field.id] = !(modal.intake[field.id] === true);
    return;
  }
  if (field.kind !== "multi_choice" || field.options.length === 0) return;
  const value = field.options[modal.intakeOptionIndexes[field.id] ?? 0]?.value;
  if (value === undefined) return;
  const current = Array.isArray(modal.intake[field.id])
    ? (modal.intake[field.id] as readonly ConfigurationValue[]).filter((item): item is string => typeof item === "string")
    : [];
  modal.intake[field.id] = current.includes(value) ? current.filter((item) => item !== value) : [...current, value];
}

function buildNewRunTypedIntake(modal: NewRunModalState, runType: ControlRunTypeOption): ConfigurationObject {
  const output: Record<string, ConfigurationValue> = Object.create(null) as Record<string, ConfigurationValue>;
  for (const field of runType.intake) {
    let value: ConfigurationValue | undefined;
    if (field.kind === "string" || field.kind === "text" || field.kind === "path") value = modal.intakeText[field.id] ?? "";
    else if (field.kind === "integer" || field.kind === "number") {
      const source = (modal.intakeText[field.id] ?? "").trim();
      if (source.length > 0) {
        const parsed = Number(source);
        if (!Number.isFinite(parsed) || field.kind === "integer" && !Number.isSafeInteger(parsed)) throw new Error(`${field.label} must be ${field.kind === "integer" ? "an integer" : "a number"}`);
        value = parsed;
      }
    } else if (field.kind === "json") {
      const source = (modal.intakeText[field.id] ?? "").trim();
      if (source.length > 0) {
        try { value = JSON.parse(source) as ConfigurationValue; }
        catch { throw new Error(`${field.label} must be valid JSON`); }
      }
    } else value = modal.intake[field.id];
    const empty = value === undefined || value === null || value === "" || Array.isArray(value) && value.length === 0;
    if (empty) {
      if (field.required) throw new Error(`${field.label} is required`);
      continue;
    }
    if (value === undefined) continue;
    if (field.kind === "choice" && (typeof value !== "string" || !field.options.some((option) => option.value === value))) throw new Error(`${field.label} contains an unavailable option`);
    if (field.kind === "multi_choice" && (!Array.isArray(value) || !value.every((item) => typeof item === "string" && field.options.some((option) => option.value === item)))) throw new Error(`${field.label} contains an unavailable option`);
    output[field.id] = structuredClone(value);
  }
  return output;
}

function configurationObjectToJsonObject(value: ConfigurationObject): { [key: string]: JsonValue } {
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, configurationValueToJsonValue(entry)]));
}

function configurationValueToJsonValue(value: ConfigurationValue): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("run intake contains a non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => configurationValueToJsonValue(entry));
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, configurationValueToJsonValue(entry)]));
}

function initialControlIntakeValue(field: ControlIntakeField): ConfigurationValue | undefined {
  if (field.kind === "boolean") return false;
  if (field.kind === "choice") return field.options[0]?.value;
  if (field.kind === "multi_choice") return [];
  return undefined;
}

function editableControlIntakeText(value: ConfigurationValue | undefined, field: ControlIntakeField): string {
  if (value === undefined || value === null) return "";
  if (field.kind === "json") return JSON.stringify(value, null, 2);
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function parseBranches(value: unknown): Array<{ label: string; reference: string }> {
  if (!Array.isArray(value)) throw new Error("authority returned an invalid branch list");
  return value.map((item) => {
    const row = asRecord(item);
    const reference = typeof row?.ref === "string" ? row.ref : typeof row?.name === "string" ? row.name : undefined;
    if (reference === undefined) throw new Error("authority branch entry has no reference");
    const normalized = reference.startsWith("refs/heads/") ? reference : `refs/heads/${reference}`;
    return { label: normalized.replace(/^refs\/heads\//u, ""), reference: normalized };
  });
}

function selectedConfigSection(modal: ConfigureModalState) {
  return modal.catalog.sections[modal.sectionIndex];
}

function selectedConfigResource(modal: ConfigureModalState) {
  return selectedConfigSection(modal)?.resources[modal.resourceIndex];
}

export function configResourceActions(
  modal: ConfigureModalState,
): Array<"create" | "duplicate" | "delete"> {
  const section = selectedConfigSection(modal);
  const resource = selectedConfigResource(modal);
  const canCreate = (resource?.createOptions?.length ?? 0) > 0 || (section?.createOptions?.length ?? 0) > 0;
  return [
    ...(canCreate ? ["create" as const] : []),
    ...(resource?.canDuplicate === true ? ["duplicate" as const] : []),
    ...(resource?.canDelete === true ? ["delete" as const] : []),
  ];
}

function configFocuses(
  modal: ConfigureModalState,
): Array<"tree" | "field" | "actions" | "publish"> {
  return [
    "tree",
    ...((selectedConfigResource(modal)?.fields.length ?? 0) > 0 ? ["field" as const] : []),
    ...(configResourceActions(modal).length > 0 ? ["actions" as const] : []),
    "publish",
  ];
}

export function selectedConfigField(modal: ConfigureModalState): ConfigFieldDefinition | undefined {
  return selectedConfigResource(modal)?.fields[modal.fieldIndex];
}

function moveConfigSection(modal: ConfigureModalState, delta: -1 | 1): void {
  modal.sectionIndex = cycleIndex(modal.sectionIndex, modal.catalog.sections.length, delta);
  modal.resourceIndex = 0;
  modal.fieldIndex = 0;
  modal.editing = false;
  modal.actionIndex = 0;
  delete modal.textEditor;
}

function moveConfigResource(modal: ConfigureModalState, delta: -1 | 1): void {
  const resources = selectedConfigSection(modal)?.resources ?? [];
  modal.resourceIndex = cycleIndex(modal.resourceIndex, resources.length, delta);
  modal.fieldIndex = 0;
  modal.editing = false;
  modal.actionIndex = 0;
  delete modal.textEditor;
}

function moveConfigField(modal: ConfigureModalState, delta: -1 | 1): void {
  const fields = selectedConfigResource(modal)?.fields ?? [];
  modal.fieldIndex = cycleIndex(modal.fieldIndex, fields.length, delta);
  modal.editing = false;
  delete modal.textEditor;
}

function adjustConfigField(modal: ConfigureModalState, delta: -1 | 1, models: readonly ControlModelOption[]): void {
  const field = selectedConfigField(modal);
  if (field === undefined) return;
  const current = modal.draft[field.key];
  if (field.kind === "boolean") modal.draft[field.key] = current !== true;
  else if (field.kind === "integer") {
    const value = typeof current === "number" && Number.isSafeInteger(current) ? current : field.minimum ?? 1;
    modal.draft[field.key] = Math.max(field.minimum ?? Number.MIN_SAFE_INTEGER, Math.min(field.maximum ?? Number.MAX_SAFE_INTEGER, value + delta));
  } else {
    const modelOptions = field.kind === "model"
      ? selectableModelsForConfig(models, typeof current === "string" ? current : undefined)
      : [];
    const options = field.kind === "model"
      ? modelOptions.map((model) => ({ value: `${model.provider}/${model.id}` }))
      : field.kind === "thinking"
        ? configuredResourceModel(modal, models)?.thinkingLevels.map((value) => ({ value })) ?? []
        : field.options ?? [];
    if (options.length === 0) return;
    const value = typeof current === "string" ? current : options[0]!.value;
    const values = options.map((option) => option.value);
    modal.draft[field.key] = field.kind === "thinking"
      ? moveOptionalString(values, value, delta)
      : moveString(values, value, delta);
    if (field.kind === "model") {
      const resource = selectedConfigResource(modal);
      const thinkingField = resource?.fields.find((candidate) => candidate.kind === "thinking");
      const selectedValue = modal.draft[field.key];
      const selectedModel = typeof selectedValue === "string"
        ? configuredModel(models, selectedValue)
        : undefined;
      const currentThinking = thinkingField === undefined ? undefined : modal.draft[thinkingField.key];
      if (
        thinkingField !== undefined &&
        selectedModel !== undefined &&
        typeof currentThinking === "string" &&
        THINKING_LEVELS.includes(currentThinking as ControlThinkingLevel) &&
        !selectedModel.thinkingLevels.includes(currentThinking as ControlThinkingLevel)
      ) {
        modal.draft[thinkingField.key] = nearestThinkingLevel(
          selectedModel.thinkingLevels,
          currentThinking as ControlThinkingLevel,
        );
      }
    }
  }
  modal.dirty = !jsonEqual(modal.draft, modal.snapshot.values);
}

function editConfigText(modal: ConfigureModalState, edit: (value: string) => string): void {
  const field = selectedConfigField(modal);
  if (field === undefined || !isTextField(field)) return;
  const current = modal.textEditor?.key === field.key
    ? modal.textEditor.value
    : configEditableText(field, modal.draft[field.key]);
  const value = edit(current).slice(0, 4 * 1024 * 1024);
  modal.textEditor = { key: field.key, value };
  modal.draft[field.key] = field.kind === "string_list"
    ? value.split("\n").map((item) => item.trim()).filter((item) => item.length > 0)
    : value;
  modal.dirty = !jsonEqual(modal.draft, modal.snapshot.values);
}

function configEditableText(field: ConfigFieldDefinition, value: JsonValue | undefined): string {
  if (typeof value === "string") return value;
  if (field.kind === "string_list" && Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string").join("\n");
  }
  return "";
}

function configEditableScalar(field: ConfigFieldDefinition, value: JsonValue | undefined): string {
  if (field.kind === "string_list") return configEditableText(field, value);
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (field.kind === "boolean") return "false";
  if (field.kind === "integer") return String(field.minimum ?? 0);
  return "";
}

function parseConfigScalar(
  field: ConfigFieldDefinition,
  source: string,
): { value: JsonValue } | string {
  if (field.kind === "integer") {
    if (!/^-?\d+$/u.test(source.trim())) return `${field.label} must be a whole number.`;
    const value = Number(source.trim());
    if (!Number.isSafeInteger(value)) return `${field.label} is outside the supported integer range.`;
    if (field.minimum !== undefined && value < field.minimum) return `${field.label} must be at least ${field.minimum}.`;
    if (field.maximum !== undefined && value > field.maximum) return `${field.label} must be at most ${field.maximum}.`;
    return { value };
  }
  if (field.kind === "boolean") {
    const normalized = source.trim().toLocaleLowerCase("en-US");
    if (normalized !== "true" && normalized !== "false") return `${field.label} must be true or false.`;
    return { value: normalized === "true" };
  }
  if (field.kind === "string_list") {
    return { value: source.split("\n").map((item) => item.trim()).filter((item) => item.length > 0) };
  }
  if (field.kind === "select" || field.kind === "model" || field.kind === "thinking") {
    const options = field.options?.map((option) => option.value) ?? [];
    if (options.length > 0 && !options.includes(source)) return `${field.label} must use one of the configured choices.`;
  }
  return { value: source };
}

function isTextField(field: ConfigFieldDefinition): boolean {
  return field.kind === "text" || field.kind === "multiline" || field.kind === "string_list";
}

function firstDocumentDomain(catalog: ConfigDocumentCatalog): number {
  const first = CONFIG_DOCUMENT_DOMAINS.findIndex((domain) =>
    catalog.documents.some((document) => document.domain === domain));
  return first < 0 ? 0 : first;
}

function configDocumentsInSelectedDomain(
  modal: ConfigureDocumentsModalState,
): ConfigDocumentCatalog["documents"] {
  const domain = CONFIG_DOCUMENT_DOMAINS[modal.domainIndex] ?? CONFIG_DOCUMENT_DOMAINS[0];
  return modal.catalog.documents.filter((document) => document.domain === domain);
}

function selectedConfigDocument(
  modal: ConfigureDocumentsModalState,
): ConfigDocumentCatalog["documents"][number] | undefined {
  return configDocumentsInSelectedDomain(modal)[modal.documentIndex];
}

function runTypeWizardText(modal: ConfigRunTypeWizardModalState): string {
  if (modal.focus === "title") return modal.title;
  if (modal.focus === "slug") return modal.slug;
  if (modal.focus === "description") return modal.description;
  return "";
}

function setRunTypeWizardText(modal: ConfigRunTypeWizardModalState, value: string): void {
  if (modal.focus === "title") modal.title = value;
  else if (modal.focus === "slug") modal.slug = value;
  else if (modal.focus === "description") modal.description = value;
}

function initialActionFieldValue(field: StageActionFieldSchema): StageActionValue {
  const defined = field.lockedValue ?? field.defaultValue;
  if (defined !== undefined) return structuredClone(defined);
  if (field.kind === "boolean") return false;
  if (field.kind === "integer" || field.kind === "number") return field.minimum ?? 0;
  if (field.kind === "string_list") return [];
  if (field.kind === "select") return field.options?.[0]?.value ?? "";
  return "";
}

function actionFieldValues(action: StageActionCapability): Record<string, StageActionValue> {
  return Object.fromEntries((action.form?.fields ?? []).map((field) => [
    field.key,
    initialActionFieldValue(field),
  ]));
}

function isTextActionField(field: StageActionFieldSchema): boolean {
  return field.kind === "text" || field.kind === "multiline" || field.kind === "string_list";
}

function actionFieldText(
  field: StageActionFieldSchema | undefined,
  values: Readonly<Record<string, StageActionValue>>,
): string {
  if (field === undefined) return "";
  const value = values[field.key];
  if (Array.isArray(value)) return value.join("\n");
  return typeof value === "string" ? value : value === undefined ? "" : String(value);
}

function setActionFieldText(
  field: StageActionFieldSchema,
  values: Record<string, StageActionValue>,
  value: string,
): void {
  values[field.key] = field.kind === "string_list" ? value.split("\n") : value;
}

function cycleActionFieldValue(
  field: StageActionFieldSchema,
  values: Record<string, StageActionValue>,
  delta: -1 | 1,
): void {
  if (field.kind === "boolean") {
    values[field.key] = values[field.key] !== true;
    return;
  }
  if (field.kind === "select") {
    const options = field.options?.map((option) => option.value) ?? [];
    if (options.length > 0) values[field.key] = moveOptionalString(options, String(values[field.key] ?? ""), delta);
    return;
  }
  if (field.kind === "integer" || field.kind === "number") {
    const current = typeof values[field.key] === "number" ? values[field.key] as number : field.minimum ?? 0;
    const minimum = field.minimum ?? (field.kind === "integer" ? Number.MIN_SAFE_INTEGER : -Number.MAX_VALUE);
    const maximum = field.maximum ?? (field.kind === "integer" ? Number.MAX_SAFE_INTEGER : Number.MAX_VALUE);
    values[field.key] = Math.min(maximum, Math.max(minimum, current + delta));
  }
}

function questionDraftMatchesSaved(question: QuestionView, draft: QuestionDraftState): boolean {
  return draft.selectedOptionId === question.savedSelectedOptionId &&
    draft.notes.trim() === (question.savedNotes ?? "").trim();
}

function normalizeModels(models: readonly ControlModelOption[]): ControlModelOption[] {
  const seen = new Set<string>();
  return models.filter((model) => {
    const key = `${model.provider}/${model.id}`;
    if (seen.has(key) || model.provider.trim().length === 0 || model.id.trim().length === 0) return false;
    seen.add(key);
    return true;
  }).map((model) => ({
    ...model,
    thinkingLevels: THINKING_LEVELS.filter((level) => model.thinkingLevels.includes(level)),
  })).sort((left, right) =>
    Number(right.available) - Number(left.available) || left.provider.localeCompare(right.provider) || left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
  );
}

function selectableModels(
  models: readonly ControlModelOption[],
  currentProvider: string,
  currentModel: string,
): Array<Pick<ControlModelOption, "provider" | "id" | "thinkingLevels">> {
  const available = models.filter((model) => model.available);
  const current = models.find((model) => model.provider === currentProvider && model.id === currentModel);
  if (available.length > 0) return [...available];
  // Keep a configured unavailable value visible when no executable alternative exists, but there
  // is no cycle that can select any other unavailable catalog entry.
  if (current !== undefined) return [current];
  return currentProvider.length > 0 && currentModel.length > 0
    ? [{ provider: currentProvider, id: currentModel, thinkingLevels: [] }]
    : [];
}

function nearestThinkingLevel(
  supported: readonly ControlThinkingLevel[],
  requested: ControlThinkingLevel,
): ControlThinkingLevel {
  if (supported.includes(requested)) return requested;
  const requestedIndex = THINKING_LEVELS.indexOf(requested);
  for (let index = requestedIndex; index < THINKING_LEVELS.length; index += 1) {
    const candidate = THINKING_LEVELS[index]!;
    if (supported.includes(candidate)) return candidate;
  }
  for (let index = requestedIndex - 1; index >= 0; index -= 1) {
    const candidate = THINKING_LEVELS[index]!;
    if (supported.includes(candidate)) return candidate;
  }
  return supported[0] ?? "off";
}

function moveOptionalString<T extends string>(
  values: readonly T[],
  selected: string,
  delta: -1 | 1,
): T {
  if (values.length === 0) throw new Error("cannot move through an empty selection");
  const index = values.indexOf(selected as T);
  if (index < 0) return values[delta > 0 ? 0 : values.length - 1]!;
  return values[cycleIndex(index, values.length, delta)]!;
}

function selectableModelsForConfig(
  models: readonly ControlModelOption[],
  current: string | undefined,
): Array<Pick<ControlModelOption, "provider" | "id" | "thinkingLevels">> {
  if (models.length === 0) return [];
  const split = current?.indexOf("/") ?? -1;
  const provider = split < 0 ? undefined : current!.slice(0, split);
  const id = split < 0 ? undefined : current!.slice(split + 1);
  if (provider === undefined || id === undefined) return selectableModels(models, "", "");
  return selectableModels(models, provider, id);
}

function configuredResourceModel(
  modal: ConfigureModalState,
  models: readonly ControlModelOption[],
): ControlModelOption | undefined {
  const modelField = selectedConfigResource(modal)?.fields.find((field) => field.kind === "model");
  const value = modelField === undefined ? undefined : modal.draft[modelField.key];
  return typeof value === "string" ? configuredModel(models, value) : undefined;
}

function configuredModel(
  models: readonly ControlModelOption[],
  value: string,
): ControlModelOption | undefined {
  const split = value.indexOf("/");
  if (split < 0) return undefined;
  return models.find((model) =>
    model.provider === value.slice(0, split) && model.id === value.slice(split + 1));
}

function moveSelection<T>(values: readonly T[], selected: T | undefined, delta: -1 | 1): T | undefined {
  if (values.length === 0) return undefined;
  const index = selected === undefined ? (delta > 0 ? -1 : 0) : values.indexOf(selected);
  return values[(Math.max(-1, index) + delta + values.length) % values.length];
}

function moveString<T extends string>(values: readonly T[], selected: string, delta: -1 | 1): T {
  if (values.length === 0) throw new Error("cannot move through an empty selection");
  const index = Math.max(0, values.indexOf(selected as T));
  return values[cycleIndex(index, values.length, delta)]!;
}

function cycleIndex(index: number, length: number, delta: -1 | 1): number {
  return length <= 0 ? 0 : (Math.max(0, index) + delta + length) % length;
}

function parseGraph(value: unknown): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const root = asRecord(value);
  if (root === undefined || !Array.isArray(root.nodes) || !Array.isArray(root.edges)) throw new Error("authority returned an invalid graph projection");
  return {
    nodes: root.nodes.map((node) => {
      const row = asRecord(node);
      if (typeof row?.id !== "string" || typeof row.type !== "string" || typeof row.title !== "string") throw new Error("authority returned an invalid graph node");
      return row as unknown as GraphNode;
    }),
    edges: root.edges.map((edge) => {
      const row = asRecord(edge);
      if (typeof row?.source !== "string" || typeof row.relation !== "string" || typeof row.target !== "string") throw new Error("authority returned an invalid graph edge");
      return row as unknown as GraphEdge;
    }),
  };
}

function cloneModal(modal: ControlCenterModalState): ControlCenterModalState {
  return structuredClone(modal);
}

function cloneTranscriptBlock(block: TranscriptBlock): TranscriptBlock {
  return {
    ...block,
    ...(block.chunk === undefined ? {} : { chunk: { ...block.chunk } }),
  };
}

function emptyProfileConflictCatalog(): ControlProfileConflictCatalog {
  return {
    protocol: "koni.profile-upstream-conflict-catalog.v1",
    lifecycleGeneration: 0,
    profileVersion: "Unavailable",
    conflicts: [],
  };
}

function runBlockers(run: RunRecord): string[] {
  const values = [
    run.lifecycle.blocker,
    run.lifecycle.terminalReason,
    run.git.planning.blocker,
    run.git.run.blocker,
    run.git.promotion?.blocker,
    ...Object.values(run.git.ticketCycles).map((cycle) => cycle.blocker),
    ...Object.values(run.tickets).map((ticket) => ticket.blocker),
  ];
  const seen = new Set<string>();
  return values.flatMap((value) => {
    if (value === undefined) return [];
    const safe = conciseOperatorReason(value);
    const normalized = safe.toLocaleLowerCase("en-US");
    if (safe.length === 0 || seen.has(normalized)) return [];
    seen.add(normalized);
    return [safe];
  }).slice(0, 6);
}

function conciseOperatorReason(value: string): string {
  const safe = value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\b(?:sha256:)?[a-f0-9]{40,64}\b/giu, "[digest]")
    .replace(/\b[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*/gu, "[local checkout]")
    .replace(/(^|[\s(])\/(?:[^\s/]+\/)*[^\s,;:)]*/gu, "$1[local checkout]")
    .replace(/(?:\.\.?\/)[^\s,;:)]+/gu, "[local checkout]")
    .replace(/\s+/gu, " ")
    .trim();
  const words = safe.split(/\s+/u);
  return words.length > 24 ? `${words.slice(0, 24).join(" ")}…` : safe;
}

function shortBranchForOperator(reference: string): string {
  return reference.replace(/^refs\/heads\//u, "");
}

function titleCaseForOperator(value: string): string {
  return value.replace(/[-_]+/gu, " ").replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function removeLastCharacter(value: string): string {
  return Array.from(value).slice(0, -1).join("");
}

function characterCount(value: string): number {
  return Array.from(value).length;
}

function clampCharacterOffset(value: string, offset: number): number {
  return Math.max(0, Math.min(characterCount(value), offset));
}

function insertAtCharacter(value: string, offset: number, inserted: string): string {
  const characters = Array.from(value);
  characters.splice(clampCharacterOffset(value, offset), 0, inserted);
  return characters.join("");
}

function insertBoundedAtCharacter(
  value: string,
  offset: number,
  inserted: string,
  maximumCharacters: number,
): { value: string; cursor: number } {
  const characters = Array.from(value);
  const cursor = clampCharacterOffset(value, offset);
  const admitted = Array.from(inserted).slice(0, Math.max(0, maximumCharacters - characters.length));
  characters.splice(cursor, 0, ...admitted);
  return { value: characters.join(""), cursor: cursor + admitted.length };
}

function removeCharacterBefore(value: string, offset: number): { value: string; cursor: number } {
  const characters = Array.from(value);
  const cursor = clampCharacterOffset(value, offset);
  if (cursor === 0) return { value, cursor };
  characters.splice(cursor - 1, 1);
  return { value: characters.join(""), cursor: cursor - 1 };
}

function removeCharacterAt(value: string, offset: number): string {
  const characters = Array.from(value);
  const cursor = clampCharacterOffset(value, offset);
  if (cursor < characters.length) characters.splice(cursor, 1);
  return characters.join("");
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function rebaseConfigValues(
  base: Readonly<Record<string, JsonValue>>,
  draft: Readonly<Record<string, JsonValue>>,
  current: Readonly<Record<string, JsonValue>>,
): { values: Record<string, JsonValue>; conflicts: number } {
  const values: Record<string, JsonValue> = {};
  let conflicts = 0;
  for (const [key, currentValue] of Object.entries(current)) {
    const baseValue = base[key];
    const draftValue = draft[key];
    const locallyEdited = draftValue !== undefined && !jsonEqual(draftValue, baseValue);
    if (!locallyEdited) {
      values[key] = structuredClone(currentValue);
      continue;
    }
    if (!jsonEqual(currentValue, baseValue) && !jsonEqual(currentValue, draftValue)) conflicts += 1;
    values[key] = structuredClone(draftValue);
  }
  return { values, conflicts };
}

function isMissingMethod(error: unknown): boolean {
  return error instanceof AuthorityClientError && error.code === "method_not_found";
}

class RunPageRefreshError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RunPageRefreshError";
  }
}

function isRunPageStale(error: unknown): boolean {
  return error instanceof RunPageRefreshError ||
    error instanceof AuthorityClientError && error.code === "run_page_stale";
}

function isRunPageTarget(error: unknown): boolean {
  return error instanceof AuthorityClientError && error.code === "run_page_target";
}

function parseRunRecord(value: unknown): RunRecord {
  assertRunRecord(value);
  return structuredClone(value);
}

function sameRunSummary(left: RunSummary, right: RunSummary): boolean {
  return canonicalEncode(left) === canonicalEncode(right);
}

function compareRunSummaryOrder(left: RunSummary, right: RunSummary): number {
  if (left.createdAt !== right.createdAt) return left.createdAt > right.createdAt ? -1 : 1;
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

function isStaleConfiguration(error: unknown): boolean {
  return error instanceof AuthorityClientError && /stale|revision|conflict|cas/iu.test(error.code);
}

function isRevisionConflictError(error: unknown): boolean {
  return error instanceof AuthorityClientError && /stale|revision|conflict|cas/iu.test(error.code);
}

function isActiveAttempt(status: RunRecord["attempts"][string]["status"]): boolean {
  return new Set(["queued", "running", "waiting_question", "terminal_accepted"]).has(status);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
