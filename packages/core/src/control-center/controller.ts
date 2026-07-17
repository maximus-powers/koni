import { randomUUID } from "node:crypto";
import { AuthorityClientError } from "../authority/client.js";
import type { JsonValue, RpcEvent, RpcSuccess } from "../authority/protocol.js";
import type { GraphEdge, GraphNode } from "../graph/model.js";
import { sealedModelAdmissionIssue } from "../pi/model-catalog.js";
import { assertRunRecord, type RunRecord } from "../state/run-record.js";
import type { ControlCenterKeyAction, ControlCenterPanel } from "./input.js";
import {
  parseConfigCatalog,
  parseConfigSnapshot,
  parseControlCatalog,
  THINKING_LEVELS,
  type ConfigCatalog,
  type ConfigFieldDefinition,
  type ConfigResourceCreateOption,
  type ConfigSnapshot,
  type ControlCatalog,
  type ControlModelOption,
  type ControlRoleDefault,
  type ControlRunTypeOption,
  type ControlThinkingLevel,
} from "./protocol.js";
import { projectPiTranscript, type TranscriptBlock } from "./transcript.js";
import {
  buildControlCenterView,
  type ControlCenterSelection,
  type ControlCenterViewModel,
  type DetailsTab,
  type ProvisionalRunView,
  type QuestionView,
} from "./view-model.js";

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

export type ControlCenterHelpTopic = ControlCenterPanel | "new_run" | "plan_review" | "configure" | "chat";

export type ControlCenterModalState =
  | { kind: "help"; topic: ControlCenterHelpTopic }
  | { kind: "delete"; runId: string; title: string }
  | NewRunModalState
  | PlanReviewModalState
  | ConfigureModalState;

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
  error?: string;
  draft: ChatDraftState;
}

export interface ControlCenterControllerSnapshot {
  view: ControlCenterViewModel;
  selection: ControlCenterSelection;
  focus: ControlCenterPanel;
  scroll: Readonly<Record<ControlCenterPanel, number>>;
  questionIndex: number;
  questionDraft?: QuestionDraftState;
  modal?: ControlCenterModalState;
  chat?: ChatProjectionState;
  models: readonly ControlModelOption[];
  runTypes: readonly ControlRunTypeOption[];
  busy?: string;
  notice?: { kind: "info" | "error"; message: string };
}

export interface ControlCenterControllerOptions {
  projectRoot: string;
  client: ControlCenterAuthorityClient;
  models?: readonly ControlModelOption[];
  now?: () => number;
  onQuit?: () => void;
  closeClientOnDispose?: boolean;
}

interface ProvisionalRun extends ProvisionalRunView {
  durableRunId?: string;
}

interface TranscriptState {
  status: ChatProjectionState["status"];
  blocks: TranscriptBlock[];
  diagnostics: string[];
  error?: string;
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

/** Shared, authority-backed controller for Pi `/koni` and manually invoked `koni tui`. */
export class ControlCenterController {
  readonly #projectRoot: string;
  readonly #client: ControlCenterAuthorityClient;
  readonly #models: ControlModelOption[];
  readonly #now: () => number;
  readonly #onQuit: (() => void) | undefined;
  readonly #closeClientOnDispose: boolean;
  readonly #listeners = new Set<(snapshot: ControlCenterControllerSnapshot) => void>();
  readonly #questionDrafts = new Map<string, QuestionDraftState>();
  readonly #chatDrafts = new Map<string, ChatDraftState>();
  readonly #transcripts = new Map<string, TranscriptState>();
  readonly #transcriptReloadPending = new Set<string>();
  readonly #approvalSeen = new Set<string>();
  #unsubscribeAuthority: (() => void) | undefined;
  #runs: RunRecord[] = [];
  #provisionals: ProvisionalRun[] = [];
  #controlCatalog: ControlCatalog | undefined;
  #graph: { nodes: GraphNode[]; edges: GraphEdge[] } | undefined;
  #graphRpcAvailable: boolean | undefined;
  #transcriptRpcAvailable: boolean | undefined;
  #selection: ControlCenterSelection = { detailsTab: "overview", objectiveExpanded: false };
  #focus: ControlCenterPanel = "runs";
  #scroll = { ...EMPTY_SCROLL };
  #questionIndex = 0;
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
    return {
      view,
      selection: { ...this.#selection },
      focus: this.#focus,
      scroll: { ...this.#scroll },
      questionIndex: this.#questionIndex,
      ...(currentQuestion === undefined ? {} : { questionDraft: { ...this.#draftFor(currentQuestion) } }),
      ...(this.#modal === undefined ? {} : { modal: cloneModal(this.#modal) }),
      ...(chat === undefined ? {} : { chat }),
      models: this.#models.map((model) => ({ ...model })),
      runTypes: this.#controlCatalog?.runTypes.map((runType) => structuredClone(runType)) ?? [],
      ...(this.#busy === undefined ? {} : { busy: this.#busy }),
      ...(this.#notice === undefined ? {} : { notice: { ...this.#notice } }),
    };
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
      case "focus": this.#moveFocus(action.delta); break;
      case "focus_panel": this.#setFocus(action.panel); break;
      case "move": await this.#move(action.delta); break;
      case "page": this.#scrollBy(action.delta * 8); break;
      case "details_tab": this.#moveHorizontal(action.delta); break;
      case "activate": await this.#activate(); break;
      case "toggle_objective": this.#toggleObjective(); break;
      case "toggle_pause": await this.#togglePause(); break;
      case "request_delete": this.#requestDelete(); break;
      case "merge": await this.#merge(); break;
      case "help": this.#openHelp(this.#focus === "details" && this.#selection.detailsTab === "chat" ? "chat" : this.#focus); break;
      case "toggle_notes": this.#toggleNotes(); break;
      case "backspace": this.#editActiveText((value) => removeLastCharacter(value)); break;
      case "append_text": this.#editActiveText((value) => `${value}${action.text}`); break;
      case "open_new_run": await this.#openNewRun(); break;
      case "open_config": await this.#openConfigure(); break;
      case "review_plan": this.#openPlanReview(false); break;
      case "toggle_chat_composer": this.#toggleChatComposer(); break;
      case "toggle_chat_mode": this.#toggleChatMode(); break;
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
        const response = await this.#client.request("run.list");
        if (!Array.isArray(response.result)) throw new Error("authority returned an invalid run list");
        this.#runs = response.result.map((value) => {
          assertRunRecord(value);
          return structuredClone(value);
        });
        this.#reconcileProvisionals();
        this.#reconcileSelection();
        await this.#refreshGraph();
        this.#maybeOpenApproval();
        this.#notice = undefined;
      } catch (error) {
        this.#notice = { kind: "error", message: errorMessage(error) };
      }
      this.#emit();
    } while (this.#refreshAgain && !this.#disposed);
  }

  async #refreshGraph(): Promise<void> {
    const runId = this.#selection.runId;
    if (runId === undefined || this.#isProvisional(runId) || this.#graphRpcAvailable === false) {
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

  #buildView(): ControlCenterViewModel {
    return buildControlCenterView({
      projectRoot: this.#projectRoot,
      authorityRevision: this.#client.revision,
      runs: this.#runs,
      provisionalRuns: this.#provisionals,
      selection: this.#selection,
      ...(this.#graph === undefined ? {} : { graph: this.#graph }),
      nowMs: this.#now(),
    });
  }

  #reconcileProvisionals(): void {
    const durableIds = new Set(this.#runs.map((run) => run.id));
    for (const row of this.#provisionals) {
      if (row.durableRunId !== undefined && durableIds.has(row.durableRunId) && this.#selection.runId === row.id) {
        this.#selection.runId = row.durableRunId;
      }
    }
    this.#provisionals = this.#provisionals.filter((row) => row.durableRunId === undefined || !durableIds.has(row.durableRunId));
  }

  #reconcileSelection(): void {
    if (this.#selection.runId !== undefined && this.#isProvisional(this.#selection.runId)) return;
    const visible = this.#runs.filter((run) => run.lifecycle.phase !== "deleted");
    const selected = visible.find((run) => run.id === this.#selection.runId) ?? visible[0];
    if (selected === undefined) {
      if (this.#provisionals.length > 0) this.#selection = { runId: this.#provisionals[0]!.id, detailsTab: "overview", objectiveExpanded: false };
      else this.#selection = { detailsTab: "overview", objectiveExpanded: false };
      this.#questionIndex = 0;
      return;
    }
    if (this.#selection.runId !== selected.id) {
      this.#selection = { runId: selected.id, detailsTab: "overview", objectiveExpanded: false };
      this.#questionIndex = 0;
    }
    if (this.#selection.ticketId !== undefined && selected.tickets[this.#selection.ticketId] === undefined) delete this.#selection.ticketId;
    if (this.#selection.attemptId !== undefined && selected.attempts[this.#selection.attemptId] === undefined) delete this.#selection.attemptId;
    if (this.#focus === "questions" && !Object.values(selected.questions).some((question) => question.answeredAt === undefined)) this.#focus = "details";
  }

  #maybeOpenApproval(): void {
    if (this.#modal !== undefined) return;
    const run = this.#selectedRunRecord();
    if (run?.lifecycle.phase !== "awaiting_approval" || run.plan === undefined) return;
    const key = `${run.id}:${run.plan.revision}`;
    if (this.#approvalSeen.has(key)) return;
    this.#approvalSeen.add(key);
    this.#modal = { kind: "plan_review", runId: run.id, sectionIndex: 0, scroll: 0, focus: "document", steering: "" };
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
    const panels: ControlCenterPanel[] = ["runs", "tickets", "details"];
    if (this.#buildView().selectedRun?.questions !== undefined) panels.push("questions");
    panels.push("agents", "activity", "graph");
    return panels;
  }

  async #move(delta: -1 | 1): Promise<void> {
    const view = this.#buildView();
    switch (this.#focus) {
      case "runs": {
        const id = moveSelection(view.runs.map((run) => run.id), this.#selection.runId, delta);
        if (id !== undefined && id !== this.#selection.runId) {
          this.#selection = { runId: id, detailsTab: "overview", objectiveExpanded: false };
          this.#questionIndex = 0;
          this.#scroll = { ...EMPTY_SCROLL };
          await this.#refreshGraph();
          this.#maybeOpenApproval();
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
          await this.#refreshGraph();
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

  #moveHorizontal(delta: -1 | 1): void {
    const view = this.#buildView();
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
    const tabs: DetailsTab[] = ["overview", "plan", "stages"];
    if (this.#selection.attemptId !== undefined) tabs.push("chat");
    const index = Math.max(0, tabs.indexOf(this.#selection.detailsTab));
    this.#selection.detailsTab = tabs[(index + delta + tabs.length) % tabs.length]!;
    this.#scroll.details = 0;
    this.#emit();
  }

  async #activate(): Promise<void> {
    if (this.#focus === "details" && this.#selection.detailsTab === "overview") {
      this.#toggleObjective();
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
    if (this.#focus === "questions") await this.#submitQuestion();
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
        void this.#refreshGraph().then(() => this.#emit());
      }
    }
    this.#emit();
  }

  #scrollBy(delta: number): void {
    this.#scroll[this.#focus] = Math.max(0, this.#scroll[this.#focus] + delta);
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
    if (run.lifecycle.phase === "paused") await this.#mutate("run.resume", { runId: run.id }, "Resuming run…");
    else if (run.lifecycle.phase === "pausing") {
      this.#notice = { kind: "info", message: "Pause is still settling" };
      this.#emit();
    } else await this.#mutate("run.pause", { runId: run.id }, "Pausing run…");
  }

  #requestDelete(): void {
    const row = this.#selectedRunRow();
    if (row === undefined || row.provisional) return;
    this.#modal = { kind: "delete", runId: row.id, title: row.title };
    this.#emit();
  }

  async #merge(): Promise<void> {
    const row = this.#selectedRunRow();
    if (row === undefined || row.provisional) return;
    if (!row.mergeReady) {
      this.#notice = { kind: "info", message: "This run is not ready to merge" };
      this.#emit();
      return;
    }
    await this.#mutate("run.merge", { runId: row.id }, `Merging into ${row.targetBranch}…`);
  }

  #openHelp(topic: ControlCenterHelpTopic): void {
    if (this.#modal !== undefined && this.#modal.kind !== "help") this.#suspendedModal = cloneModal(this.#modal);
    this.#modal = { kind: "help", topic };
    this.#emit();
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

  async #submitQuestion(): Promise<void> {
    const question = this.#currentQuestion(this.#buildView());
    if (question === undefined) return;
    const draft = this.#draftFor(question);
    const notes = draft.notes.trim();
    if (draft.selectedOptionId === undefined && notes.length === 0) {
      this.#notice = { kind: "info", message: "Choose an option or add notes" };
      this.#emit();
      return;
    }
    await this.#mutate("question.answer", {
      runId: this.#selection.runId!,
      questionId: question.id,
      ...(draft.selectedOptionId === undefined ? {} : { selectedOptionId: draft.selectedOptionId }),
      ...(notes.length === 0 ? {} : { notes }),
    }, "Sending answer…");
    this.#questionDrafts.delete(question.id);
    this.#questionIndex = 0;
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
      const runType = this.#controlCatalog.runTypes[0]!;
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
      const [catalogResponse, snapshotResponse] = await Promise.all([
        this.#client.request("config.catalog"),
        this.#client.request("config.get"),
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

  #openPlanReview(manual: boolean): void {
    const run = this.#selectedRunRecord();
    if (run?.lifecycle.phase !== "awaiting_approval" || run.plan === undefined) {
      if (manual) this.#notice = { kind: "info", message: "The selected run has no plan awaiting review" };
      this.#emit();
      return;
    }
    this.#approvalSeen.add(`${run.id}:${run.plan.revision}`);
    this.#modal = { kind: "plan_review", runId: run.id, sectionIndex: 0, scroll: 0, focus: "document", steering: "" };
    this.#emit();
  }

  async #handleModal(action: ControlCenterKeyAction): Promise<void> {
    const modal = this.#modal!;
    if (action.type === "help") {
      if (modal.kind === "help") this.#restoreSuspendedModal();
      else this.#openHelp(modal.kind === "delete" ? "runs" : modal.kind);
      return;
    }
    if (modal.kind === "help") {
      if (action.type === "activate") this.#restoreSuspendedModal();
      return;
    }
    if (modal.kind === "delete") {
      if (action.type === "activate" || action.type === "submit") {
        const runId = modal.runId;
        this.#modal = undefined;
        await this.#mutate("run.delete", { runId }, "Deleting run…");
      }
      return;
    }
    if (modal.kind === "new_run") await this.#handleNewRun(modal, action);
    else if (modal.kind === "plan_review") await this.#handlePlanReview(modal, action);
    else await this.#handleConfigure(modal, action);
  }

  #restoreSuspendedModal(): void {
    this.#modal = this.#suspendedModal;
    this.#suspendedModal = undefined;
    this.#emit();
  }

  async #handleNewRun(modal: NewRunModalState, action: ControlCenterKeyAction): Promise<void> {
    if (action.type === "focus" || action.type === "move") {
      modal.focus = moveString(newRunControls(modal), modal.focus, action.delta);
      this.#emit();
      return;
    }
    if (action.type === "page") {
      modal.stageScroll = Math.max(0, modal.stageScroll + action.delta * 6);
      this.#emit();
      return;
    }
    if (action.type === "details_tab") {
      this.#adjustNewRun(modal, action.delta);
      this.#emit();
      return;
    }
    if (action.type === "backspace" && modal.focus === "objective") {
      modal.objective = removeLastCharacter(modal.objective);
      this.#emit();
      return;
    }
    if (action.type === "append_text" && modal.focus === "objective") {
      modal.objective = `${modal.objective}${action.text}`.slice(0, 4 * 1024 * 1024);
      this.#emit();
      return;
    }
    if (action.type === "activate") {
      if (modal.focus === "objective") modal.objective = `${modal.objective}\n`.slice(0, 4 * 1024 * 1024);
      else if (modal.focus === "start") await this.#startRun(modal);
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
    const objective = modal.objective.trim();
    const branch = modal.branches[modal.branchIndex];
    if (objective.length === 0) {
      this.#notice = { kind: "error", message: "Objective is required" };
      return;
    }
    if (branch === undefined) {
      this.#notice = { kind: "error", message: "Target branch is required" };
      return;
    }
    const runType = this.#controlCatalog?.runTypes.find((item) => item.id === modal.runTypeId);
    if (runType === undefined) {
      this.#notice = { kind: "error", message: "Selected run type is no longer available" };
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
        intake: { goal: objective },
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
    } else if (action.type === "details_tab") {
      const count = this.#selectedApproval()?.sections.length ?? 4;
      modal.sectionIndex = cycleIndex(modal.sectionIndex, Math.max(1, count), action.delta);
      modal.scroll = 0;
    } else if (action.type === "append_text" && modal.focus === "steering") {
      modal.steering = `${modal.steering}${action.text}`.slice(0, 1024 * 1024);
    } else if (action.type === "backspace" && modal.focus === "steering") {
      modal.steering = removeLastCharacter(modal.steering);
    } else if (action.type === "activate") {
      if (modal.focus === "steering") modal.steering = `${modal.steering}\n`.slice(0, 1024 * 1024);
      else if (modal.focus === "action") await this.#submitPlanReview(modal);
    } else if (action.type === "submit") await this.#submitPlanReview(modal);
    this.#emit();
  }

  async #submitPlanReview(modal: PlanReviewModalState): Promise<void> {
    const instructions = modal.steering.trim();
    const method = instructions.length === 0 ? "plan.approve" : "plan.revise";
    this.#modal = undefined;
    await this.#mutate(method, {
      runId: modal.runId,
      ...(instructions.length === 0 ? {} : { instructions }),
    }, instructions.length === 0 ? "Approving plan…" : "Requesting revised plan…");
  }

  async #handleConfigure(modal: ConfigureModalState, action: ControlCenterKeyAction): Promise<void> {
    if (modal.resourceOperation !== undefined) {
      await this.#handleConfigResourceOperation(modal, modal.resourceOperation, action);
      this.#emit();
      return;
    }
    if (action.type === "config_resource_create") {
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
      if (field !== undefined && isTextField(field)) {
        if (modal.editing) {
          modal.editing = false;
          delete modal.textEditor;
        } else {
          modal.editing = true;
          modal.textEditor = { key: field.key, value: configEditableText(field, modal.draft[field.key]) };
        }
      }
      else adjustConfigField(modal, 1, this.#models);
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
    const [catalogResponse, snapshotResponse] = await Promise.all([
      this.#client.request("config.catalog"),
      this.#client.request("config.get"),
    ]);
    modal.catalog = parseConfigCatalog(catalogResponse.result);
    modal.snapshot = parseConfigSnapshot(snapshotResponse.result);
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
    if (this.#transcriptRpcAvailable === false) return;
    if (this.#transcripts.get(attemptId)?.status === "loading") {
      this.#transcriptReloadPending.add(attemptId);
      return;
    }
    this.#transcripts.set(attemptId, { status: "loading", blocks: [], diagnostics: [] });
    this.#emit();
    try {
      const response = await this.#client.request("run.transcript", { runId: this.#selection.runId!, attemptId });
      const projection = projectPiTranscript(response.result);
      this.#transcriptRpcAvailable = true;
      this.#transcripts.set(attemptId, { status: "ready", ...projection });
    } catch (error) {
      if (isMissingMethod(error)) {
        this.#transcriptRpcAvailable = false;
        this.#transcripts.set(attemptId, { status: "unavailable", blocks: [], diagnostics: [] });
      } else this.#transcripts.set(attemptId, { status: "error", blocks: [], diagnostics: [], error: errorMessage(error) });
    }
    this.#emit();
    if (this.#transcriptReloadPending.delete(attemptId) && !this.#disposed) {
      this.#transcripts.delete(attemptId);
      void this.#loadTranscript(attemptId);
    }
  }

  #reloadTranscript(attemptId: string): void {
    if (this.#transcripts.get(attemptId)?.status === "loading") {
      this.#transcriptReloadPending.add(attemptId);
      return;
    }
    this.#transcripts.delete(attemptId);
    void this.#loadTranscript(attemptId);
  }

  #chatProjection(): ChatProjectionState | undefined {
    const attemptId = this.#selection.attemptId;
    if (attemptId === undefined) return undefined;
    const transcript = this.#transcripts.get(attemptId) ?? { status: "loading" as const, blocks: [], diagnostics: [] };
    return {
      attemptId,
      status: transcript.status,
      blocks: transcript.blocks.map((block) => ({ ...block })),
      diagnostics: [...transcript.diagnostics],
      ...(transcript.error === undefined ? {} : { error: transcript.error }),
      draft: { ...this.#chatDraft(attemptId) },
    };
  }

  #chatDraft(attemptId: string): ChatDraftState {
    let draft = this.#chatDrafts.get(attemptId);
    if (draft === undefined) {
      draft = { attemptId, mode: "steer", text: "", editing: false };
      this.#chatDrafts.set(attemptId, draft);
    }
    return draft;
  }

  #selectedChatDraft(): ChatDraftState | undefined {
    return this.#selection.attemptId === undefined ? undefined : this.#chatDraft(this.#selection.attemptId);
  }

  #toggleChatComposer(): void {
    if (this.#selection.detailsTab !== "chat") return;
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
    if (draft === undefined || !draft.editing) return;
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
    await this.#mutate(draft.mode === "steer" ? "agent.steer" : "agent.follow_up", {
      attemptId: draft.attemptId,
      text,
    }, draft.mode === "steer" ? "Steering agent…" : "Sending follow-up…");
    draft.text = "";
    draft.editing = false;
    this.#transcripts.delete(draft.attemptId);
    await this.#loadTranscript(draft.attemptId);
  }

  async #mutate(method: string, params: JsonValue, label: string): Promise<void> {
    if (this.#busy !== undefined) return;
    this.#busy = label;
    this.#notice = undefined;
    this.#emit();
    try {
      await this.#client.request(method, params, {
        expectedRevision: this.#client.revision,
        idempotencyKey: `${method}:${randomUUID()}`,
      });
      await this.refresh();
    } catch (error) {
      this.#notice = { kind: "error", message: errorMessage(error) };
    } finally {
      this.#busy = undefined;
      this.#emit();
    }
  }

  #selectedRunRecord(): RunRecord | undefined {
    return this.#runs.find((run) => run.id === this.#selection.runId);
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
      draft = { questionId: question.id, selectedOptionId: question.options[0]?.id, notes: "", editingNotes: false };
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
}

function newRunControls(modal: NewRunModalState): string[] {
  return [
    "objective",
    "run_type",
    "branch",
    "stages",
    "questions",
    "parallel",
    ...modal.roles.flatMap((role) => [`role:${role.id}:model`, `role:${role.id}:thinking`]),
    "start",
  ];
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

function isTextField(field: ConfigFieldDefinition): boolean {
  return field.kind === "text" || field.kind === "multiline" || field.kind === "string_list";
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function removeLastCharacter(value: string): string {
  return Array.from(value).slice(0, -1).join("");
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

function isStaleConfiguration(error: unknown): boolean {
  return error instanceof AuthorityClientError && /stale|revision|conflict|cas/iu.test(error.code);
}

function isActiveAttempt(status: RunRecord["attempts"][string]["status"]): boolean {
  return new Set(["queued", "running", "waiting_question", "terminal_accepted"]).has(status);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
