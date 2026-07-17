import {
  decodeKittyPrintable,
  Key,
  matchesKey,
} from "@earendil-works/pi-tui";

export type ControlCenterPanel =
  | "runs"
  | "tickets"
  | "details"
  | "questions"
  | "agents"
  | "activity"
  | "graph";

export type ControlCenterKeyAction =
  | { type: "move"; delta: -1 | 1 }
  | { type: "page"; delta: -1 | 1 }
  | { type: "focus"; delta: -1 | 1 }
  | { type: "focus_panel"; panel: ControlCenterPanel }
  | { type: "details_tab"; delta: -1 | 1 }
  | { type: "activate" }
  | { type: "cancel" }
  | { type: "toggle_objective" }
  | { type: "toggle_pause" }
  | { type: "request_delete" }
  | { type: "merge" }
  | { type: "help" }
  | { type: "toggle_notes" }
  | { type: "backspace" }
  | { type: "append_text"; text: string }
  | { type: "open_new_run" }
  | { type: "open_config" }
  | { type: "review_plan" }
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
  | { type: "quit" };

export interface ControlCenterInputContext {
  panel: ControlCenterPanel;
  editingNotes: boolean;
  modalOpen: boolean;
  /** Any modal/chat text editor that owns printable input. */
  editingText?: boolean;
  modalKind?: "help" | "delete" | "new_run" | "plan_review" | "configure";
  chatComposer?: boolean;
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
  if (matchesKey(data, Key.ctrl("c"))) return { type: "quit" };
  if (matchesKey(data, Key.ctrl("s"))) return { type: "save_draft" };
  if (matchesKey(data, Key.ctrl("p"))) return { type: "publish" };
  if (matchesKey(data, Key.ctrl("d"))) return { type: "discard_draft" };
  if (matchesKey(data, Key.ctrl("r"))) return { type: "rebase_draft" };
  if (matchesKey(data, Key.ctrl(Key.enter))) return { type: "submit" };
  if (matchesKey(data, Key.escape)) return { type: "cancel" };

  if (context.editingNotes || context.editingText === true || context.chatComposer === true) {
    if (context.editingNotes && matchesKey(data, Key.tab)) return { type: "toggle_notes" };
    if (context.chatComposer === true && matchesKey(data, Key.tab)) return { type: "toggle_chat_mode" };
    if (context.modalKind === "configure" && matchesKey(data, Key.up)) return { type: "focus", delta: -1 };
    if (context.modalKind === "configure" && matchesKey(data, Key.down)) return { type: "focus", delta: 1 };
    if (context.editingText === true && matchesKey(data, Key.shift(Key.tab))) return { type: "focus", delta: -1 };
    if (context.editingText === true && matchesKey(data, Key.tab)) return { type: "focus", delta: 1 };
    if (matchesKey(data, Key.shift(Key.enter)) || matchesKey(data, Key.alt(Key.enter))) {
      return { type: "append_text", text: "\n" };
    }
    if (matchesKey(data, Key.enter)) return { type: "activate" };
    if (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) {
      return { type: "backspace" };
    }
    const printable = decodeKittyPrintable(data) ?? plainPrintable(data);
    return printable === undefined ? undefined : { type: "append_text", text: printable };
  }

  if (context.modalOpen) {
    if (data === "h" || matchesKey(data, Key.f1)) return { type: "help" };
    if (context.modalKind === "configure" && data === "a") return { type: "config_resource_create" };
    if (context.modalKind === "configure" && data === "d") return { type: "config_resource_duplicate" };
    if (context.modalKind === "configure" && data === "x") return { type: "config_resource_delete" };
    if (matchesKey(data, Key.shift(Key.tab))) return { type: "focus", delta: -1 };
    if (matchesKey(data, Key.tab)) return { type: "focus", delta: 1 };
    if (matchesKey(data, Key.up) || data === "k") return { type: "move", delta: -1 };
    if (matchesKey(data, Key.down) || data === "j") return { type: "move", delta: 1 };
    if (matchesKey(data, Key.pageUp)) return { type: "page", delta: -1 };
    if (matchesKey(data, Key.pageDown)) return { type: "page", delta: 1 };
    if (matchesKey(data, Key.left) || data === "[") return { type: "details_tab", delta: -1 };
    if (matchesKey(data, Key.right) || data === "]") return { type: "details_tab", delta: 1 };
    if (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) return { type: "backspace" };
    if (matchesKey(data, Key.enter)) return { type: "activate" };
    return undefined;
  }

  if (matchesKey(data, Key.shift(Key.tab))) return { type: "focus", delta: -1 };
  if (context.panel === "questions" && matchesKey(data, Key.tab)) return { type: "toggle_notes" };
  if (matchesKey(data, Key.tab)) return { type: "focus", delta: 1 };
  if (matchesKey(data, Key.up) || data === "k") return { type: "move", delta: -1 };
  if (matchesKey(data, Key.down) || data === "j") return { type: "move", delta: 1 };
  if (matchesKey(data, Key.pageUp)) return { type: "page", delta: -1 };
  if (matchesKey(data, Key.pageDown)) return { type: "page", delta: 1 };
  if (matchesKey(data, Key.left) || data === "[") return { type: "details_tab", delta: -1 };
  if (matchesKey(data, Key.right) || data === "]") return { type: "details_tab", delta: 1 };
  if (matchesKey(data, Key.enter)) return { type: "activate" };
  if (matchesKey(data, Key.space)) return { type: "toggle_pause" };
  if (data === "d") return { type: "request_delete" };
  if (data === "m") return { type: "merge" };
  if (context.panel === "questions" && data === "n") return { type: "toggle_notes" };
  if (data === "n") return { type: "open_new_run" };
  if (data === "c") return { type: "open_config" };
  if (data === "v") return { type: "review_plan" };
  if (data === "h" || matchesKey(data, Key.f1)) return { type: "help" };
  if (data === "o") return { type: "toggle_objective" };
  if (context.panel === "details" && data === "s") return { type: "toggle_chat_composer" };
  if (data === "q") return { type: "quit" };

  const panel = PANEL_KEYS[data];
  return panel === undefined ? undefined : { type: "focus_panel", panel };
}

const PANEL_KEYS: Readonly<Record<string, ControlCenterPanel | undefined>> = {
  "1": "runs",
  "2": "tickets",
  "3": "details",
  "4": "agents",
  "5": "activity",
  "6": "graph",
  "7": "questions",
};

function plainPrintable(data: string): string | undefined {
  return data.length > 0 && !/[\p{Control}]/u.test(data) ? data : undefined;
}
