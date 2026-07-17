import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { canonicalHash } from "../src/shared/canonical.js";
import {
  KONI_TOOL_RECEIPT_PROTOCOL,
  createKoniAuthorityTools,
  koniToolMaxResultBytes,
  koniToolSchemaHash,
  renderKoniToolReceipt,
  type KoniToolInvocation,
  type KoniToolReceipt,
} from "../src/pi/tool-catalog.js";

const accepted = (receiptId: string, summary = "accepted", value?: unknown): KoniToolReceipt => ({
  protocol: KONI_TOOL_RECEIPT_PROTOCOL,
  receiptId,
  outcome: "accepted",
  summary,
  ...(value === undefined ? {} : { value }),
});

const reject = async (_call: KoniToolInvocation, rejection: { code: "transcript_result_budget"; summary: string }) => ({
  protocol: KONI_TOOL_RECEIPT_PROTOCOL,
  receiptId: "receipt-rejected",
  outcome: "rejected" as const,
  code: rejection.code,
  summary: rejection.summary,
});

describe("Koni authority-backed Pi tool catalog", () => {
  it("derives an exact unique hash-bound inventory from one canonical schema catalog", () => {
    const tools = createKoniAuthorityTools({
      names: ["koni_read_file", "koni_edit_file", "koni_submit_output"],
      terminalOutputSchema: Type.Object({ summary: Type.String() }, { additionalProperties: false }),
      async invoke() { return accepted("receipt-one"); },
      reject,
    });
    expect(tools.map((tool) => tool.name)).toEqual([
      "koni_read_file",
      "koni_edit_file",
      "koni_submit_output",
    ]);
    expect(tools[0]!.schemaHash).toBe(koniToolSchemaHash("koni_read_file"));
    expect(tools[0]!.maxResultBytes).toBe(koniToolMaxResultBytes("koni_read_file"));
    expect(tools[2]!.schemaHash).toBe(canonicalHash(tools[2]!.terminalOutputSchema));
    expect(tools[2]!.terminalOutputSchemaHash).toBe(tools[2]!.schemaHash);
    expect(() => createKoniAuthorityTools({
      names: ["koni_context", "koni_context"],
      async invoke() { return accepted("receipt"); },
      reject,
    })).toThrow(/duplicate Koni tool/u);
  });

  it("routes execution through the authority invoker and terminates only on submission", async () => {
    const calls: KoniToolInvocation[] = [];
    const invoke = vi.fn(async (call: KoniToolInvocation) => {
      calls.push(call);
      return accepted(`receipt-${call.callId}`, `${call.name} accepted`, { ok: true });
    });
    const tools = createKoniAuthorityTools({
      names: ["koni_read_file", "koni_submit_output"],
      terminalOutputSchema: Type.Object({ summary: Type.String() }, { additionalProperties: false }),
      invoke,
      reject,
    });
    const read = await tools[0]!.definition.execute(
      "read-one",
      { path: "src/app.ts" },
      undefined,
      undefined,
      {} as never,
    );
    const terminal = await tools[1]!.definition.execute(
      "submit-one",
      { summary: "Implemented feature" },
      undefined,
      undefined,
      {} as never,
    );
    expect(calls).toEqual([
      { callId: "read-one", name: "koni_read_file", arguments: { path: "src/app.ts" } },
      { callId: "submit-one", name: "koni_submit_output", arguments: { summary: "Implemented feature" } },
    ]);
    expect(read.terminate).toBeUndefined();
    expect(terminal.terminate).toBe(true);
    expect(terminal.details).toEqual({
      protocol: KONI_TOOL_RECEIPT_PROTOCOL,
      receiptId: "receipt-submit-one",
      outcome: "accepted",
      summary: "koni_submit_output accepted",
      value: { ok: true },
    });
  });

  it("renders a durable rejected outcome as an error-ready non-terminal result", async () => {
    const tools = createKoniAuthorityTools({
      names: ["koni_submit_output"],
      terminalOutputSchema: Type.Object({ summary: Type.String() }, { additionalProperties: false }),
      async invoke() { return accepted("unused"); },
      reject,
    });
    const result = await tools[0]!.reject(
      "submit-rejected",
      { summary: "not ready" },
      { code: "transcript_result_budget", summary: "result cannot fit" },
    );
    expect(result.terminate).toBeUndefined();
    expect(result.details).toMatchObject({
      protocol: KONI_TOOL_RECEIPT_PROTOCOL,
      outcome: "rejected",
      code: "transcript_result_budget",
    });
    expect(result.content).toEqual([{
      type: "text",
      text: renderKoniToolReceipt(result.details as KoniToolReceipt),
    }]);
  });
});
