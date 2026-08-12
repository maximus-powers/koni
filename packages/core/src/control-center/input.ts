import { decodeKittyPrintable, Key, matchesKey } from "@earendil-works/pi-tui";

export type ControlCenterPanel =
  "runs" | "tickets" | "details" | "questions" | "agents" | "activity";

export type ControlCenterKeyAction =
  | { type: "move"; delta: -1 | 1 }
  | { type: "page"; delta: -1 | 1 }
  | { type: "scroll_home" }
  | { type: "scroll_end" }
  | { type: "focus"; delta: -1 | 1 }
  | { type: "focus_panel"; panel: ControlCenterPanel }
  | { type: "select_run"; runId: string }
  | { type: "select_ticket"; ticketId: string }
  | { type: "select_agent"; attemptId: string }
  | { type: "pointer_scroll"; panel: ControlCenterPanel; delta: -1 | 1 }
  | { type: "pointer_control"; target: string }
  | { type: "details_tab"; delta: -1 | 1 }
  /** Arrow-key horizontal movement; the controller resolves it per focus and details tab. */
  | { type: "move_horizontal"; delta: -1 | 1 }
  /** Jump straight to the Details panel's Graph feed (key 6, the old graph-panel hotkey). */
  | { type: "focus_graph" }
  | { type: "activate" }
  | { type: "cancel" }
  | { type: "context_toggle" }
  | { type: "toggle_pause" }
  | { type: "request_delete" }
  | { type: "merge" }
  | { type: "help" }
  | { type: "toggle_notes" }
  | { type: "backspace" }
  | { type: "delete_forward" }
  | { type: "append_text"; text: string }
  | { type: "open_new_run" }
  | { type: "open_config" }
  | { type: "open_config_documents" }
  | { type: "config_document_create" }
  | { type: "config_document_rename" }
  | { type: "config_document_delete" }
  | { type: "config_run_type_create" }
  | { type: "open_conflicts" }
  | { type: "review_plan" }
  | { type: "review_proposal" }
  | { type: "open_actions" }
  | { type: "open_question" }
  | { type: "refresh" }
  | { type: "save_draft" }
  | { type: "publish" }
  | { type: "discard_draft" }
  | { type: "rebase_draft" }
  | { type: "config_resource_create" }
  | { type: "config_resource_duplicate" }
  | { type: "config_resource_delete" }
  | { type: "submit" }
  | { type: "toggle_chat_composer" }
  | { type: "toggle_chat_mode" }
  | { type: "transcript_page"; delta: -1 | 1 }
  | { type: "quit" };

export interface ControlCenterInputContext {
  panel: ControlCenterPanel;
  editingNotes: boolean;
  modalOpen: boolean;
  /** Any modal/chat text editor that owns printable input. */
  editingText?: boolean;
  modalKind?:
    | "help"
    | "graph_node"
    | "delete"
    | "merge"
    | "new_run"
    | "plan_review"
    | "proposal_review"
    | "answer_question"
    | "action_palette"
    | "action_form"
    | "configure"
    | "configure_documents"
    | "config_document_create"
    | "config_document_rename"
    | "config_document_delete"
    | "config_run_type_wizard"
    | "profile_conflicts"
    | "edit_scalar";
  chatComposer?: boolean;
  chatOpen?: boolean;
}

export type ControlCenterPointerInput =
  | { kind: "press"; button: "left" | "middle" | "right"; x: number; y: number }
  | { kind: "release"; button: "left" | "middle" | "right"; x: number; y: number }
  | { kind: "wheel"; delta: -1 | 1; x: number; y: number };

/** Decode the SGR mouse protocol Pi's stdin buffer already preserves as one input sequence. */
export function decodeControlCenterPointer(data: string): ControlCenterPointerInput | undefined {
  const match = /^\u001b\[<(\d+);(\d+);(\d+)([Mm])$/u.exec(data);
  if (match === null) return undefined;
  const code = Number.parseInt(match[1]!, 10);
  const x = Number.parseInt(match[2]!, 10) - 1;
  const y = Number.parseInt(match[3]!, 10) - 1;
  if (!Number.isSafeInteger(code) || x < 0 || y < 0 || (code & 32) !== 0) return undefined;
  if ((code & 64) !== 0) return { kind: "wheel", delta: (code & 1) === 0 ? -1 : 1, x, y };
  const button = (["left", "middle", "right"] as const)[code & 3];
  if (button === undefined) return undefined;
  return { kind: match[4] === "m" ? "release" : "press", button, x, y };
}

/**
 * Translate Pi TUI's raw terminal input into Koni semantic actions.
 *
 * Text is accepted only while the question notes editor is active. This prevents ordinary
 * command keys from ever becoming an accidental mutation or hidden input.
 */
export function decodeControlCenterInput(
  data: string,
  context: ControlCenterInputContext,
): ControlCenterKeyAction | undefined {
  const paste = bracketedPaste(data);
  if (paste !== undefined) {
    return context.editingNotes || context.editingText === true || context.chatComposer === true
      ? { type: "append_text", text: paste }
      : undefined;
  }
  if (matchesKey(data, Key.ctrl("c"))) return { type: "quit" };
  if (matchesKey(data, Key.ctrl("s"))) return { type: "save_draft" };
  if (matchesKey(data, Key.ctrl("p"))) return { type: "publish" };
  if (matchesKey(data, Key.ctrl("d"))) return { type: "discard_draft" };
  if (matchesKey(data, Key.ctrl("r"))) return { type: "rebase_draft" };
  if (matchesKey(data, Key.ctrl(Key.enter))) return { type: "submit" };
  if (matchesKey(data, Key.escape)) return { type: "cancel" };

  if (context.editingNotes || context.editingText === true || context.chatComposer === true) {
    if (context.editingNotes && matchesKey(data, Key.shift(Key.tab)))
      return { type: "focus", delta: -1 };
    if (context.editingNotes && matchesKey(data, Key.tab)) return { type: "focus", delta: 1 };
    if (context.chatComposer === true && matchesKey(data, Key.tab))
      return { type: "toggle_chat_mode" };
    if (context.modalKind === "configure" && matchesKey(data, Key.up))
      return { type: "focus", delta: -1 };
    if (context.modalKind === "configure" && matchesKey(data, Key.down))
      return { type: "focus", delta: 1 };
    if (
      (context.modalKind === "config_document_create" ||
        context.modalKind === "config_document_rename" ||
        context.modalKind === "config_run_type_wizard") &&
      matchesKey(data, Key.up)
    ) {
      return { type: "focus", delta: -1 };
    }
    if (
      (context.modalKind === "config_document_create" ||
        context.modalKind === "config_document_rename" ||
        context.modalKind === "config_run_type_wizard") &&
      matchesKey(data, Key.down)
    ) {
      return { type: "focus", delta: 1 };
    }
    if (context.editingText === true && matchesKey(data, Key.shift(Key.tab)))
      return { type: "focus", delta: -1 };
    if (context.editingText === true && matchesKey(data, Key.tab))
      return { type: "focus", delta: 1 };
    if (context.editingText === true && matchesKey(data, Key.left))
      return { type: "details_tab", delta: -1 };
    if (context.editingText === true && matchesKey(data, Key.right))
      return { type: "details_tab", delta: 1 };
    if (context.editingText === true && matchesKey(data, Key.home)) return { type: "scroll_home" };
    if (context.editingText === true && matchesKey(data, Key.end)) return { type: "scroll_end" };
    if (matchesKey(data, Key.shift(Key.enter)) || matchesKey(data, Key.alt(Key.enter))) {
      return { type: "append_text", text: "\n" };
    }
    if (matchesKey(data, Key.enter)) return { type: "activate" };
    if (matchesKey(data, Key.backspace)) return { type: "backspace" };
    if (matchesKey(data, Key.delete)) return { type: "delete_forward" };
    const printable = decodeKittyPrintable(data) ?? plainPrintable(data);
    return printable === undefined ? undefined : { type: "append_text", text: printable };
  }

  if (context.modalOpen) {
    if (context.modalKind === "help" && data === "q") return { type: "cancel" };
    if (context.modalKind === "configure" && data === "q") return { type: "quit" };
    if (data === "h" || matchesKey(data, Key.f1)) return { type: "help" };
    if (context.modalKind === "configure" && data === "a")
      return { type: "config_resource_create" };
    if (context.modalKind === "configure" && data === "d")
      return { type: "config_resource_duplicate" };
    if (context.modalKind === "configure" && data === "x")
      return { type: "config_resource_delete" };
    if (context.modalKind === "configure" && data === "u") return { type: "open_conflicts" };
    if (context.modalKind === "configure" && data === "r") return { type: "open_config_documents" };
    if (context.modalKind === "configure_documents" && data === "a")
      return { type: "config_document_create" };
    if (context.modalKind === "configure_documents" && data === "e")
      return { type: "config_document_rename" };
    if (context.modalKind === "configure_documents" && data === "x")
      return { type: "config_document_delete" };
    if (context.modalKind === "configure_documents" && data === "t")
      return { type: "config_run_type_create" };
    if (matchesKey(data, Key.shift(Key.tab))) return { type: "focus", delta: -1 };
    if (matchesKey(data, Key.tab)) return { type: "focus", delta: 1 };
    if (matchesKey(data, Key.up) || data === "k") return { type: "move", delta: -1 };
    if (matchesKey(data, Key.down) || data === "j") return { type: "move", delta: 1 };
    if (matchesKey(data, Key.pageUp)) return { type: "page", delta: -1 };
    if (matchesKey(data, Key.pageDown)) return { type: "page", delta: 1 };
    if (matchesKey(data, Key.home)) return { type: "scroll_home" };
    if (matchesKey(data, Key.end)) return { type: "scroll_end" };
    if (matchesKey(data, Key.left) || data === "[") return { type: "details_tab", delta: -1 };
    if (matchesKey(data, Key.right) || data === "]") return { type: "details_tab", delta: 1 };
    if (matchesKey(data, Key.backspace)) return { type: "backspace" };
    if (matchesKey(data, Key.delete)) return { type: "delete_forward" };
    if (matchesKey(data, Key.enter)) return { type: "activate" };
    return undefined;
  }

  if (matchesKey(data, Key.shift(Key.tab))) return { type: "focus", delta: -1 };
  if (matchesKey(data, Key.tab)) return { type: "focus", delta: 1 };
  if (matchesKey(data, Key.up) || data === "k") return { type: "move", delta: -1 };
  if (matchesKey(data, Key.down) || data === "j") return { type: "move", delta: 1 };
  if (matchesKey(data, Key.pageUp)) return { type: "page", delta: -1 };
  if (matchesKey(data, Key.pageDown)) return { type: "page", delta: 1 };
  if (matchesKey(data, Key.home)) return { type: "scroll_home" };
  if (matchesKey(data, Key.end)) return { type: "scroll_end" };
  if (
    context.chatOpen === true &&
    context.panel === "details" &&
    (matchesKey(data, Key.left) || data === "[")
  )
    return { type: "transcript_page", delta: -1 };
  if (
    context.chatOpen === true &&
    context.panel === "details" &&
    (matchesKey(data, Key.right) || data === "]")
  )
    return { type: "transcript_page", delta: 1 };
  // Arrows and brackets split on the Graph feed: arrows move the feed's column focus while
  // brackets always cycle the details tabs. Everywhere else the controller treats them alike.
  if (matchesKey(data, Key.left)) return { type: "move_horizontal", delta: -1 };
  if (matchesKey(data, Key.right)) return { type: "move_horizontal", delta: 1 };
  if (data === "[") return { type: "details_tab", delta: -1 };
  if (data === "]") return { type: "details_tab", delta: 1 };
  if (matchesKey(data, Key.enter)) return { type: "activate" };
  if (matchesKey(data, Key.space)) return { type: "toggle_pause" };
  if (data === "d") return { type: "request_delete" };
  if (data === "m") return { type: "merge" };
  if (context.panel === "questions" && data === "n") return { type: "toggle_notes" };
  if (data === "n") return { type: "open_new_run" };
  if (data === "c") return { type: "open_config" };
  if (data === "v") return { type: "review_plan" };
  if (data === "p") return { type: "review_proposal" };
  if (data === "a") return { type: "open_actions" };
  if (data === "?") return { type: "open_question" };
  if (data === "r") return { type: "refresh" };
  if (data === "h" || matchesKey(data, Key.f1)) return { type: "help" };
  if (matchesKey(data, Key.ctrl("o")) || data === "o") return { type: "context_toggle" };
  if (context.panel === "details" && data === "s") return { type: "toggle_chat_composer" };
  if (data === "q") return { type: "quit" };
  // The old graph-panel hotkey keeps its meaning: take me to the graph.
  if (data === "6") return { type: "focus_graph" };

  const panel = PANEL_KEYS[data];
  return panel === undefined ? undefined : { type: "focus_panel", panel };
}

function bracketedPaste(data: string): string | undefined {
  const start = "\u001b[200~";
  const end = "\u001b[201~";
  return data.startsWith(start) && data.endsWith(end)
    ? data.slice(start.length, -end.length)
    : undefined;
}

const PANEL_KEYS: Readonly<Record<string, ControlCenterPanel | undefined>> = {
  "1": "runs",
  "2": "tickets",
  "3": "agents",
  "4": "details",
  "5": "activity",
};

function plainPrintable(data: string): string | undefined {
  return data.length > 0 && !/[\p{Control}]/u.test(data) ? data : undefined;
}
