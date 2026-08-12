import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { canonicalHash } from "../src/shared/canonical.js";
import {
  KONI_TOOL_RECEIPT_PROTOCOL,
  createKoniAuthorityTools,
  koniToolMaxResultBytes,
  koniToolSchemaHash,
  renderKoniToolReceipt,
  validateKoniToolArguments,
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

const reject = async (
  _call: KoniToolInvocation,
  rejection: { code: "transcript_result_budget"; summary: string },
) => ({
  protocol: KONI_TOOL_RECEIPT_PROTOCOL,
  receiptId: "receipt-rejected",
  outcome: "rejected" as const,
  code: rejection.code,
  summary: rejection.summary,
});

describe("Koni authority-backed Pi tool catalog", () => {
  it("describes the exact complete terminal shape without inventing status fields", () => {
    const [tool] = createKoniAuthorityTools({
      names: ["koni_submit_output"],
      terminalOutputSchema: Type.Object(
        {
          title: Type.Optional(Type.String()),
          full: Type.Object({ architecture: Type.String() }),
          concise: Type.Object({ architecture: Type.Array(Type.String()) }),
          graphSeed: Type.Object({
            nodes: Type.Array(
              Type.Union([
                Type.Object({
                  key: Type.String(),
                  type: Type.Literal("experiment"),
                  title: Type.String(),
                  spec: Type.Object(
                    {
                      objective: Type.String(),
                      empirical_mode: Type.Union([
                        Type.Literal("intervention"),
                        Type.Literal("observation"),
                      ]),
                    },
                    { additionalProperties: false },
                  ),
                }),
                Type.Object({
                  key: Type.String(),
                  type: Type.Literal("metric"),
                  title: Type.String(),
                  spec: Type.Object({}, { additionalProperties: false }),
                }),
              ]),
            ),
          }),
        },
        { additionalProperties: false },
      ),
      async invoke() {
        return accepted("receipt-planning");
      },
      reject,
    });

    expect(tool!.definition.description).toContain(
      "On every validation retry, resubmit the complete object",
    );
    expect(tool!.definition.description).toContain("title: string");
    expect(tool!.definition.description).toContain("full: object");
    expect(tool!.definition.description).toContain("concise: object");
    expect(tool!.definition.description).toContain("graphSeed: object");
    expect(tool!.definition.description).toContain(
      'graphSeed.nodes[] uses these exact type/spec contracts: type "experiment" allows only spec { empirical_mode, objective }; type "metric" allows only spec {}',
    );
    expect(tool!.definition.description).toContain(
      "Never add status, summary, or any other field unless it appears in that exact shape",
    );
    expect(tool!.definition.description).not.toContain('"status":"completed"');
    expect(tool!.definition.promptSnippet).toBe(tool!.definition.description);
  });

  it("derives an exact unique hash-bound inventory from one canonical schema catalog", () => {
    const tools = createKoniAuthorityTools({
      names: ["koni_read_file", "koni_edit_file", "koni_submit_output"],
      terminalOutputSchema: Type.Object(
        { summary: Type.String() },
        { additionalProperties: false },
      ),
      async invoke() {
        return accepted("receipt-one");
      },
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
    expect(() =>
      createKoniAuthorityTools({
        names: ["koni_context", "koni_context"],
        async invoke() {
          return accepted("receipt");
        },
        reject,
      }),
    ).toThrow(/duplicate Koni tool/u);
  });

  it("routes execution through the authority invoker and terminates only on submission", async () => {
    const calls: KoniToolInvocation[] = [];
    const invoke = vi.fn(async (call: KoniToolInvocation) => {
      calls.push(call);
      return accepted(`receipt-${call.callId}`, `${call.name} accepted`, { ok: true });
    });
    const tools = createKoniAuthorityTools({
      names: ["koni_read_file", "koni_submit_output"],
      terminalOutputSchema: Type.Object(
        { summary: Type.String() },
        { additionalProperties: false },
      ),
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
      {
        callId: "submit-one",
        name: "koni_submit_output",
        arguments: { summary: "Implemented feature" },
      },
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

  it("honors the immutable tool result bound instead of imposing a hidden 64 KiB cap", async () => {
    const context = "x".repeat(40 * 1024);
    const [tool] = createKoniAuthorityTools({
      names: ["koni_context"],
      async invoke() {
        return accepted("receipt-large-context", "Compiler context returned", { content: context });
      },
      reject,
    });

    const result = await tool!.definition.execute(
      "context-one",
      { offsetChars: 0, maxChars: 40 * 1024 },
      undefined,
      undefined,
      {} as never,
    );

    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeGreaterThan(64 * 1024);
    expect(result.details).toMatchObject({ value: { content: context } });
  });

  it("requires one recommendation and an impact class on current question calls", () => {
    const base = {
      prompt: "Which compatibility behavior should the run preserve?",
      options: [
        { id: "preserve", label: "Preserve", description: "Keep the current public behavior." },
        { id: "replace", label: "Replace", description: "Adopt the new behavior immediately." },
      ],
    };
    expect(() => validateKoniToolArguments("koni_ask_question", base)).toThrow(
      /compiler-issued schema/u,
    );
    expect(
      validateKoniToolArguments("koni_ask_question", {
        ...base,
        recommendedOptionId: "preserve",
        impact: "high_impact",
      }),
    ).toEqual({
      ...base,
      recommendedOptionId: "preserve",
      impact: "high_impact",
    });
  });

  it("accepts every exact terminal-union branch through the flattened Pi transport schema", () => {
    const schema = Type.Union([
      Type.Object(
        { status: Type.Literal("completed"), summary: Type.String() },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          status: Type.Literal("failed"),
          summary: Type.Optional(Type.String()),
          blocker: Type.String(),
        },
        { additionalProperties: false },
      ),
    ]);

    expect(
      validateKoniToolArguments(
        "koni_submit_output",
        {
          status: "failed",
          blocker: "The bounded assignment could not complete.",
        },
        schema,
      ),
    ).toEqual({
      status: "failed",
      blocker: "The bounded assignment could not complete.",
    });
  });

  it("renders a durable rejected outcome as an error-ready non-terminal result", async () => {
    const tools = createKoniAuthorityTools({
      names: ["koni_submit_output"],
      terminalOutputSchema: Type.Object(
        { summary: Type.String() },
        { additionalProperties: false },
      ),
      async invoke() {
        return accepted("unused");
      },
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
    expect(result.content).toEqual([
      {
        type: "text",
        text: renderKoniToolReceipt(result.details as KoniToolReceipt),
      },
    ]);
  });
});
