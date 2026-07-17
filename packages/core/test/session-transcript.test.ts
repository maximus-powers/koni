import { describe, expect, it } from "vitest";
import {
  parsePiSession,
  SessionTranscriptError,
  summarizeUsage,
  transcriptPath,
} from "../src/pi/session-transcript.js";

const header = { type: "session", version: 3, id: "session-one", cwd: "/repo" };
const first = { type: "message", id: "a1", parentId: null, message: { role: "user" } };
const second = {
  type: "message",
  id: "a2",
  parentId: "a1",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "Complete response" }],
    usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 3 },
  },
};

function jsonl(...values: unknown[]): string {
  return `${values.map((value) => JSON.stringify(value)).join("\n")}\n`;
}

describe("Pi session transcript", () => {
  it("preserves complete entries and follows the selected path", () => {
    const branch = { type: "message", id: "b2", parentId: "a1", message: { role: "assistant" } };
    const session = parsePiSession(jsonl(header, first, second, branch));
    expect(transcriptPath(session, "a2").map((entry) => entry.id)).toEqual(["a1", "a2"]);
    expect(transcriptPath(session, "b2").map((entry) => entry.id)).toEqual(["a1", "b2"]);
  });

  it("keeps cache-inclusive and new-token totals separate", () => {
    const session = parsePiSession(jsonl(header, first, second));
    expect(summarizeUsage(session.entries)).toEqual({
      input: 10n,
      output: 5n,
      cacheRead: 100n,
      cacheWrite: 3n,
      newTokens: 15n,
      allTokens: 118n,
    });
  });

  it.each([
    ["duplicate_entry", jsonl(header, first, first)],
    ["orphan_entry", jsonl(header, { ...second, parentId: "missing" })],
    [
      "parent_cycle",
      jsonl(header, { ...first, parentId: "a2" }, { ...second, parentId: "a1" }),
    ],
  ])("fails closed on %s", (code, bytes) => {
    try {
      parsePiSession(bytes);
      throw new Error("expected transcript rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(SessionTranscriptError);
      expect((error as SessionTranscriptError).code).toBe(code);
    }
  });

  it("can retain prior records while flagging a crash-truncated tail", () => {
    const input = `${jsonl(header, first)}{"type":"message"`;
    const parsed = parsePiSession(input, { allowTruncatedTail: true });
    expect(parsed.entries).toEqual([first]);
    expect(parsed.diagnostics).toEqual([
      {
        code: "truncated_tail",
        line: 3,
        message: "Ignored an unterminated final Pi session record",
      },
    ]);
  });

  it("treats valid JSON without its commit newline as an uncommitted tail", () => {
    const parsed = parsePiSession(`${jsonl(header, first)}${JSON.stringify(second)}`, {
      allowTruncatedTail: true,
    });
    expect(parsed.entries).toEqual([first]);
    expect(parsed.diagnostics).toEqual([
      {
        code: "truncated_tail",
        line: 3,
        message: "Ignored an unterminated final Pi session record",
      },
    ]);
  });
});
