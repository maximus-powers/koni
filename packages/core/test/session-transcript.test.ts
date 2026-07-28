import { chmod, link, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertAutonomousPiSession,
  parsePiSession,
  readPiSessionDurably,
  SessionTranscriptError,
  summarizeUsage,
  transcriptPath,
} from "../src/pi/session-transcript.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((entry) => rm(entry, { recursive: true, force: true })),
  );
});

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

  it("keeps Pi's native interactive branch tree while rejecting it for an autonomous attempt", () => {
    const branch = { type: "message", id: "b2", parentId: "a1", message: { role: "assistant" } };
    const interactive = parsePiSession(
      jsonl({ ...header, parentSession: "/sessions/parent.jsonl" }, first, second, branch),
    );
    expect(transcriptPath(interactive, "b2").map((entry) => entry.id)).toEqual(["a1", "b2"]);
    expect(() =>
      assertAutonomousPiSession(interactive, {
        sessionId: header.id,
        cwd: header.cwd,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<SessionTranscriptError>>({
        code: "autonomous_parent_session",
      }),
    );

    const inFileBranch = parsePiSession(jsonl(header, first, second, branch));
    expect(() =>
      assertAutonomousPiSession(inFileBranch, {
        sessionId: header.id,
        cwd: header.cwd,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<SessionTranscriptError>>({
        code: "autonomous_branch",
      }),
    );
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
    ["parent_cycle", jsonl(header, { ...first, parentId: "a2" }, { ...second, parentId: "a1" })],
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

  it("rejects non-UTF-8 bytes instead of replacement-decoding changed transcript meaning", () => {
    const bytes = Buffer.concat([
      Buffer.from(jsonl(header, first), "utf8"),
      Buffer.from([0xff, 0x0a]),
    ]);
    expect(() => parsePiSession(bytes)).toThrowError(
      expect.objectContaining<Partial<SessionTranscriptError>>({ code: "session_encoding" }),
    );
  });

  it("rejects malformed optional header and entry metadata", () => {
    expect(() => parsePiSession(jsonl({ ...header, cwd: 42 }, first))).toThrowError(
      expect.objectContaining<Partial<SessionTranscriptError>>({
        code: "invalid_metadata",
        line: 1,
      }),
    );
    expect(() =>
      parsePiSession(jsonl(header, { ...first, timestamp: { forged: true } })),
    ).toThrowError(
      expect.objectContaining<Partial<SessionTranscriptError>>({
        code: "invalid_metadata",
        line: 2,
      }),
    );
  });

  it("fsyncs and parses one private owner-bound file identity", async () => {
    const file = await durableFixture();
    expect((await readPiSessionDurably(file)).lastEntryId).toBe("a2");
  });

  it("rejects weak permissions, hard links, and symlink paths", async () => {
    const weak = await durableFixture();
    await chmod(weak, 0o644);
    await expect(readPiSessionDurably(weak)).rejects.toMatchObject({ code: "session_identity" });

    const hard = await durableFixture();
    await link(hard, `${hard}.link`);
    await expect(readPiSessionDurably(hard)).rejects.toMatchObject({ code: "session_identity" });

    const target = await durableFixture();
    const alias = `${target}.symlink`;
    await symlink(target, alias);
    await expect(readPiSessionDurably(alias)).rejects.toMatchObject({ code: "session_durability" });
  });
});

async function durableFixture(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "koni-durable-session-"));
  temporary.push(directory);
  const file = path.join(directory, "session.jsonl");
  await writeFile(file, jsonl(header, first, second), { mode: 0o600 });
  await chmod(file, 0o600);
  return file;
}
