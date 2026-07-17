import type { JsonValue } from "../authority/protocol.js";

export type TranscriptBlockKind =
  | "user"
  | "assistant"
  | "thinking"
  | "tool_call"
  | "tool_result"
  | "compaction"
  | "notice";

export interface TranscriptBlock {
  id: string;
  kind: TranscriptBlockKind;
  title: string;
  markdown: string;
  timestamp?: string;
  branch: boolean;
  error: boolean;
}

export interface TranscriptProjection {
  blocks: TranscriptBlock[];
  diagnostics: string[];
}

/** Project complete persisted Pi entries into semantic chat blocks without reconstructing events. */
export function projectPiTranscript(value: unknown): TranscriptProjection {
  const root = record(value);
  if (root === undefined || !Array.isArray(root.entries)) {
    throw new Error("authority returned an invalid Pi transcript");
  }
  const blocks: TranscriptBlock[] = [];
  let previousId: string | undefined;
  for (const [index, unknownEntry] of root.entries.entries()) {
    const entry = record(unknownEntry);
    if (entry === undefined || typeof entry.id !== "string" || typeof entry.type !== "string") continue;
    const branch = index > 0 && entry.parentId !== previousId;
    previousId = entry.id;
    const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : undefined;
    if (entry.type === "message") {
      projectMessage(entry.id, entry.message, branch, timestamp, blocks);
      continue;
    }
    if (entry.type === "compaction") {
      const summary = textValue(entry.summary) ?? textValue(entry.content) ?? "Pi compacted older session context.";
      blocks.push({ id: entry.id, kind: "compaction", title: "Context compacted", markdown: summary, branch, error: false, ...(timestamp === undefined ? {} : { timestamp }) });
      continue;
    }
    if (entry.type === "branch_summary") {
      const summary = textValue(entry.summary) ?? "Pi summarized the abandoned branch.";
      blocks.push({ id: entry.id, kind: "compaction", title: "Branch summarized", markdown: summary, branch: true, error: false, ...(timestamp === undefined ? {} : { timestamp }) });
      continue;
    }
    if (entry.type === "model_change" && typeof entry.modelId === "string") {
      const provider = typeof entry.provider === "string" ? `${entry.provider}/` : "";
      blocks.push({ id: entry.id, kind: "notice", title: "Model changed", markdown: `${provider}${entry.modelId}`, branch, error: false, ...(timestamp === undefined ? {} : { timestamp }) });
      continue;
    }
    if (entry.type === "thinking_level_change" && typeof entry.thinkingLevel === "string") {
      blocks.push({ id: entry.id, kind: "notice", title: "Reasoning changed", markdown: entry.thinkingLevel, branch, error: false, ...(timestamp === undefined ? {} : { timestamp }) });
      continue;
    }
    if (entry.type === "label" && typeof entry.label === "string") {
      blocks.push({ id: entry.id, kind: "notice", title: "Session label", markdown: entry.label, branch, error: false, ...(timestamp === undefined ? {} : { timestamp }) });
      continue;
    }
    if (entry.type === "session_info" && typeof entry.name === "string") {
      blocks.push({ id: entry.id, kind: "notice", title: "Session name", markdown: entry.name, branch, error: false, ...(timestamp === undefined ? {} : { timestamp }) });
      continue;
    }
    if (entry.type === "custom_message" && entry.display !== false) {
      const visible = contentText(entry.content);
      const content = visible.length === 0 ? textValue(entry.message) : visible;
      if (content !== undefined) blocks.push({ id: entry.id, kind: "notice", title: "Session note", markdown: content, branch, error: false, ...(timestamp === undefined ? {} : { timestamp }) });
    }
  }
  const diagnostics = Array.isArray(root.diagnostics)
    ? root.diagnostics.map((item) => record(item)?.message).filter((item): item is string => typeof item === "string")
    : [];
  return { blocks, diagnostics };
}

function projectMessage(
  entryId: string,
  unknownMessage: unknown,
  branch: boolean,
  entryTimestamp: string | undefined,
  output: TranscriptBlock[],
): void {
  const message = record(unknownMessage);
  if (message === undefined || typeof message.role !== "string") return;
  const timestamp = typeof message.timestamp === "number"
    ? new Date(message.timestamp).toISOString()
    : entryTimestamp;
  const add = (block: Omit<TranscriptBlock, "id" | "branch" | "timestamp">, suffix: string): void => {
    output.push({ id: `${entryId}:${suffix}`, branch, ...block, ...(timestamp === undefined ? {} : { timestamp }) });
  };
  if (message.role === "user") {
    const text = contentText(message.content);
    if (text.length > 0) add({ kind: "user", title: "You", markdown: text, error: false }, "user");
    return;
  }
  if (message.role === "toolResult") {
    const tool = typeof message.toolName === "string" ? humanToolName(message.toolName) : "Tool result";
    const text = contentText(message.content) || summarizeObject(message.details);
    add({ kind: "tool_result", title: tool, markdown: text || "Tool completed.", error: message.isError === true }, "result");
    return;
  }
  if (message.role !== "assistant") return;
  if (typeof message.content === "string" && message.content.trim().length > 0) {
    add({ kind: "assistant", title: "Assistant", markdown: message.content, error: false }, "assistant");
  } else if (Array.isArray(message.content)) {
    for (const [index, unknownBlock] of message.content.entries()) {
      const block = record(unknownBlock);
      if (block === undefined || typeof block.type !== "string") continue;
      if (block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0) {
        add({ kind: "assistant", title: "Assistant", markdown: block.text, error: false }, `assistant-${index}`);
      } else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim().length > 0) {
        add({ kind: "thinking", title: "Reasoning", markdown: block.thinking, error: false }, `thinking-${index}`);
      } else if (block.type === "toolCall" && typeof block.name === "string") {
        add({
          kind: "tool_call",
          title: humanToolName(block.name),
          markdown: summarizeArguments(block.arguments),
          error: false,
        }, `tool-${index}`);
      }
    }
  }
  if (typeof message.errorMessage === "string" && message.errorMessage.trim().length > 0) {
    add({ kind: "notice", title: "Agent error", markdown: message.errorMessage, error: true }, "error");
  }
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((item) => {
    const block = record(item);
    return block?.type === "text" && typeof block.text === "string" ? block.text : "";
  }).filter(Boolean).join("\n\n");
}

function textValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) return value;
  const nested = record(value);
  return nested === undefined ? undefined : textValue(nested.text) ?? textValue(nested.summary);
}

function humanToolName(value: string): string {
  return value
    .replace(/^koni_/u, "")
    .replace(/[_-]+/gu, " ")
    .replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
}

function summarizeArguments(value: unknown): string {
  const source = record(value);
  if (source === undefined) return "Called tool.";
  const safe = Object.entries(source).map(([key, item]) => {
    const rendered = typeof item === "string" ? item : JSON.stringify(item, null, 2);
    return typeof item === "string"
      ? `- **${humanToolName(key)}:** ${rendered}`
      : `- **${humanToolName(key)}:**\n\n\`\`\`json\n${rendered ?? "null"}\n\`\`\``;
  });
  return safe.length === 0 ? "Called tool." : safe.join("\n");
}

function summarizeObject(value: unknown): string {
  const source = record(value);
  if (source === undefined) return "";
  const summary = typeof source.summary === "string" ? source.summary : undefined;
  if (summary !== undefined) return summary;
  return JSON.stringify(source, null, 2) ?? "";
}

function record(value: unknown): Record<string, JsonValue | unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, JsonValue | unknown>
    : undefined;
}
