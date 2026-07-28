import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parsePiSession } from "../src/pi/session-transcript.js";
import {
  type PiTranscriptPageError,
  projectPiTranscriptPage,
  readAutonomousPiTranscriptPage,
} from "../src/pi/transcript-page.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((entry) => rm(entry, { recursive: true, force: true })),
  );
});

const header = {
  type: "session",
  version: 3,
  id: "session-page",
  timestamp: "2026-07-17T00:00:00.000Z",
  cwd: "/repo",
};

const mapping = {
  type: "custom",
  id: "map",
  parentId: null,
  timestamp: "2026-07-17T00:00:01.000Z",
  customType: "koni.attempt-session-map",
  data: { protocol: "koni.attempt-session-map.v1" },
};

const user = {
  type: "message",
  id: "user",
  parentId: "map",
  timestamp: "2026-07-17T00:00:02.000Z",
  message: { role: "user", content: [{ type: "text", text: "Implement the ticket." }] },
};

const assistant = {
  type: "message",
  id: "assistant",
  parentId: "user",
  timestamp: "2026-07-17T00:00:03.000Z",
  message: {
    role: "assistant",
    content: [
      {
        type: "thinking",
        thinking: "Inspect the compiler invariant first.",
        thinkingSignature: "opaque",
      },
      { type: "text", text: "I found the relevant invariant." },
      {
        type: "toolCall",
        id: "call-one",
        name: "koni_read_file",
        arguments: { path: "src/core.ts" },
      },
    ],
    usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 3 },
    stopReason: "toolUse",
  },
};

const toolResult = {
  type: "message",
  id: "result",
  parentId: "assistant",
  timestamp: "2026-07-17T00:00:04.000Z",
  message: {
    role: "toolResult",
    toolCallId: "call-one",
    toolName: "koni_read_file",
    content: [{ type: "text", text: "export const invariant = true;" }],
    details: { protocol: "koni.tool-receipt.v1" },
    isError: false,
  },
};

const compaction = {
  type: "compaction",
  id: "compact",
  parentId: "result",
  timestamp: "2026-07-17T00:00:05.000Z",
  summary: "# Koni attempt checkpoint\n\nAuthoritative context will be reissued.",
  firstKeptEntryId: "user",
  tokensBefore: 118,
  details: { protocol: "koni.compaction.v1", contextReissueRequired: true },
};

function jsonl(...values: unknown[]): string {
  return `${values.map((value) => JSON.stringify(value)).join("\n")}\n`;
}

describe("bounded native Pi transcript pages", () => {
  it("reads a bounded autonomous page through one durable private file identity", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "koni-transcript-page-"));
    temporary.push(root);
    const file = path.join(root, "session.jsonl");
    await writeFile(file, jsonl(header, mapping, user, assistant), { mode: 0o600 });
    await chmod(file, 0o600);

    const page = await readAutonomousPiTranscriptPage(
      file,
      {
        sessionId: header.id,
        cwd: header.cwd,
      },
      { limit: 2 },
    );
    expect(page.blocks).toHaveLength(2);
    expect(page.totalBlocks).toBe(4);
    expect(page.startBlock).toBe(2);
    expect(page.previousCursor).toBeUndefined();
    expect(page.nextCursor).toBeDefined();
  });

  it("pages complete semantic blocks while retaining native reasoning, tools, compaction, and usage", () => {
    const session = parsePiSession(jsonl(header, mapping, user, assistant, toolResult, compaction));
    const latest = projectPiTranscriptPage(session, { limit: 3 });

    expect(latest.blocks.map((block) => block.kind)).toEqual([
      "tool_call",
      "tool_result",
      "compaction",
    ]);
    expect(latest.blocks[0]).toMatchObject({
      title: "Read File",
      markdown: expect.stringContaining("src/core.ts"),
    });
    expect(latest.usage).toEqual({
      input: "10",
      output: "5",
      cacheRead: "100",
      cacheWrite: "3",
      newTokens: "15",
      allTokens: "118",
    });
    expect(latest.totalBlocks).toBe(6);
    expect(latest.startBlock).toBe(3);
    expect(latest.previousCursor).toBeUndefined();
    expect(latest.nextCursor).toBeDefined();

    const older = projectPiTranscriptPage(session, { cursor: latest.nextCursor!, limit: 3 });
    expect(older.blocks.map((block) => block.kind)).toEqual(["user", "thinking", "assistant"]);
    expect(older.blocks.find((block) => block.kind === "thinking")?.markdown).toBe(
      "Inspect the compiler invariant first.",
    );
    expect(older.startBlock).toBe(0);
    expect(older.previousCursor).toBeDefined();
    expect(older.nextCursor).toBeUndefined();
    const newer = projectPiTranscriptPage(session, { cursor: older.previousCursor!, limit: 3 });
    expect(newer.blocks.map((block) => block.id)).toEqual(latest.blocks.map((block) => block.id));
    expect(JSON.stringify(latest).length).toBeLessThan(16 * 1024 * 1024);
  });

  it("pins a cursor to its original prefix while allowing later append-only Pi entries", () => {
    const original = parsePiSession(
      jsonl(header, mapping, user, assistant, toolResult, compaction),
    );
    const latest = projectPiTranscriptPage(original, { limit: 2 });
    const appended = {
      type: "message",
      id: "after-cursor",
      parentId: "compact",
      message: { role: "assistant", content: [{ type: "text", text: "New live output" }] },
    };
    const grown = parsePiSession(
      jsonl(header, mapping, user, assistant, toolResult, compaction, appended),
    );

    const older = projectPiTranscriptPage(grown, { cursor: latest.nextCursor!, limit: 2 });
    expect(older.snapshot.entryCount).toBe(original.entries.length);
    expect(older.totalBlocks).toBe(latest.totalBlocks);
    expect(older.blocks.some((block) => block.markdown === "New live output")).toBe(false);
  });

  it("rejects a cursor when any byte-bearing semantic record in its prefix changes", () => {
    const original = parsePiSession(
      jsonl(header, mapping, user, assistant, toolResult, compaction),
    );
    const latest = projectPiTranscriptPage(original, { limit: 2 });
    const changedUser = {
      ...user,
      message: { role: "user", content: [{ type: "text", text: "Tampered objective" }] },
    };
    const drifted = parsePiSession(
      jsonl(header, mapping, changedUser, assistant, toolResult, compaction),
    );

    expect(() =>
      projectPiTranscriptPage(drifted, { cursor: latest.nextCursor!, limit: 2 }),
    ).toThrowError(
      expect.objectContaining<Partial<PiTranscriptPageError>>({ code: "cursor_snapshot" }),
    );
  });

  it("shows provider-redacted reasoning without exposing its opaque continuation signature", () => {
    const redacted = {
      ...assistant,
      message: {
        ...assistant.message,
        content: [
          {
            type: "thinking",
            thinking: "",
            redacted: true,
            thinkingSignature: "secret-opaque-bytes",
          },
        ],
      },
    };
    const session = parsePiSession(jsonl(header, mapping, user, redacted));
    const page = projectPiTranscriptPage(session);
    expect(page.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "thinking",
          markdown: expect.stringContaining("redacted by the provider"),
        }),
      ]),
    );
    expect(JSON.stringify(page)).not.toContain("secret-opaque-bytes");
  });

  it("preserves ordered image attachments as bounded type-and-size rows without exposing base64", () => {
    const privateImage = Buffer.from("private-image", "utf8").toString("base64");
    const imageUser = {
      type: "message",
      id: "image-user",
      parentId: "map",
      message: {
        role: "user",
        content: [
          { type: "image", data: privateImage, mimeType: "image/png" },
          { type: "text", text: "Please inspect this image." },
          { type: "image", data: "AQ==", mimeType: "image/webp" },
        ],
      },
    };
    const imageResult = {
      type: "message",
      id: "image-result",
      parentId: "image-user",
      message: {
        role: "toolResult",
        toolCallId: "image-call",
        toolName: "browser_screenshot",
        content: [{ type: "image", data: privateImage, mimeType: "image/png" }],
        isError: false,
      },
    };
    const page = projectPiTranscriptPage(
      parsePiSession(jsonl(header, mapping, imageUser, imageResult)),
    );
    expect(page.blocks.find((block) => block.kind === "user")?.markdown).toBe(
      [
        "Image attachment · image/png · 13 bytes",
        "Please inspect this image.",
        "Image attachment · image/webp · 1 byte",
      ].join("\n\n"),
    );
    expect(page.blocks.find((block) => block.kind === "tool_result")?.markdown).toBe(
      "Image attachment · image/png · 13 bytes",
    );
    expect(JSON.stringify(page)).not.toContain(privateImage);
  });

  it("falls back to the entry timestamp when provider message time is outside the ISO range", () => {
    const invalidTime = {
      ...assistant,
      message: { ...assistant.message, timestamp: Number.MAX_SAFE_INTEGER },
    };
    const session = parsePiSession(jsonl(header, mapping, user, invalidTime));
    const page = projectPiTranscriptPage(session);
    expect(page.blocks.find((block) => block.kind === "assistant")?.timestamp).toBe(
      assistant.timestamp,
    );
  });

  it("reconstructs one giant safe UTF-8 block exactly across multiple bounded history windows", () => {
    const prefix = "λ🙂".repeat(20_000);
    const middle = "終".repeat(50_000);
    const suffix = "tail🙂".repeat(10_000);
    const largeText = `${prefix}\u001b]2;hostile title\u0007${middle}\u202e${suffix}`;
    const safeText = `${prefix}${middle}${suffix}`;
    const large = {
      ...assistant,
      message: { ...assistant.message, content: [{ type: "text", text: largeText }] },
    };
    const session = parsePiSession(jsonl(header, mapping, user, large));
    const pages = [projectPiTranscriptPage(session, { limit: 2 })];
    while (pages.at(-1)!.nextCursor !== undefined) {
      const current = pages.at(-1)!;
      const older = projectPiTranscriptPage(session, { cursor: current.nextCursor!, limit: 2 });
      expect(older.startBlock + older.blocks.length).toBe(current.startBlock);
      pages.push(older);
    }
    expect(pages.length).toBeGreaterThan(2);
    expect(pages.at(-1)!.startBlock).toBe(0);

    const chronological = [...pages].reverse().flatMap((page) => page.blocks);
    const chunks = chronological.filter((block) => block.kind === "assistant");
    expect(chunks.length).toBeGreaterThan(2);
    expect(new Set(chunks.map((block) => block.id)).size).toBe(chunks.length);
    expect(chunks.map((block) => block.chunk?.index)).toEqual(
      Array.from({ length: chunks.length }, (_, index) => index + 1),
    );
    expect(
      chunks.every(
        (block) =>
          block.truncated &&
          block.chunk?.total === chunks.length &&
          block.chunk.totalBytes === Buffer.byteLength(safeText, "utf8") &&
          block.id.endsWith(`:chunk-${String(block.chunk.index)}`) &&
          Buffer.byteLength(block.markdown, "utf8") <= 64 * 1024,
      ),
    ).toBe(true);
    expect(chunks.map((block) => block.markdown).join("")).toBe(safeText);
    expect(JSON.stringify(pages)).not.toContain("hostile title");
    expect(JSON.stringify(pages)).not.toContain("\u001b");
    expect(JSON.stringify(pages)).not.toContain("\u202e");

    let current = pages.at(-1)!;
    while (current.previousCursor !== undefined) {
      const newer = projectPiTranscriptPage(session, { cursor: current.previousCursor, limit: 2 });
      expect(newer.startBlock).toBe(current.startBlock + current.blocks.length);
      current = newer;
    }
    expect(current.blocks.map((block) => block.id)).toEqual(
      pages[0]!.blocks.map((block) => block.id),
    );
    expect(large.message.content[0]!.text).toBe(largeText);
  });

  it("rejects malformed, cross-session, and out-of-range cursors", () => {
    const session = parsePiSession(jsonl(header, mapping, user, assistant));
    expect(() => projectPiTranscriptPage(session, { cursor: "not+base64" })).toThrowError(
      expect.objectContaining<Partial<PiTranscriptPageError>>({ code: "cursor_shape" }),
    );
    const page = projectPiTranscriptPage(session, { limit: 1 });
    const other = parsePiSession(
      jsonl({ ...header, id: "other-session" }, mapping, user, assistant),
    );
    expect(() => projectPiTranscriptPage(other, { cursor: page.nextCursor! })).toThrowError(
      expect.objectContaining<Partial<PiTranscriptPageError>>({ code: "cursor_session" }),
    );
  });
});
