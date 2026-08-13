import { Type } from "typebox";
import { Value } from "typebox/value";
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

  it("forwards nested discriminated planning drafts to the exact compiler boundary", () => {
    const terminalOutputSchema = Type.Object(
      {
        graphSeed: Type.Object({
          nodes: Type.Array(
            Type.Union([
              Type.Object(
                {
                  key: Type.String(),
                  type: Type.Literal("contract"),
                  title: Type.String(),
                  spec: Type.Object(
                    {
                      invariant: Type.String(),
                      enforcement_point: Type.String(),
                    },
                    { additionalProperties: false },
                  ),
                },
                { additionalProperties: false },
              ),
              Type.Object(
                {
                  key: Type.String(),
                  type: Type.Literal("proof"),
                  title: Type.String(),
                  spec: Type.Object(
                    {
                      claim: Type.String(),
                      command: Type.Array(Type.String()),
                    },
                    { additionalProperties: false },
                  ),
                },
                { additionalProperties: false },
              ),
            ]),
          ),
        }),
      },
      { additionalProperties: false },
    );
    const [tool] = createKoniAuthorityTools({
      names: ["koni_submit_output"],
      terminalOutputSchema,
      async invoke() {
        return accepted("receipt-planning-draft");
      },
      reject,
    });
    const invalidDraft = {
      graphSeed: {
        nodes: [
          {
            key: "analysis-guide-change",
            type: "change",
            title: "Add analysis guide",
            spec: { target_state: "The guide is available." },
          },
        ],
      },
    };

    expect(Value.Check(tool!.definition.parameters, invalidDraft)).toBe(true);
    expect(Value.Check(tool!.terminalOutputSchema!, invalidDraft)).toBe(false);
    expect(() =>
      validateKoniToolArguments(
        "koni_submit_output",
        invalidDraft,
        terminalOutputSchema,
        tool!.schemaHash,
      ),
    ).toThrow(/compiler-issued schema/u);
    expect(tool!.definition.description).toContain(
      'type "contract" allows only spec { enforcement_point, invariant }',
    );
    expect(tool!.definition.description).toContain(
      'type "proof" allows only spec { claim, command }',
    );
  });

  it("forwards malformed outer terminal shapes to bounded authority rejection", async () => {
    const terminalOutputSchema = Type.Object(
      {
        full: Type.Object({ architecture: Type.String() }, { additionalProperties: false }),
        concise: Type.Object(
          { architecture: Type.Array(Type.String()) },
          { additionalProperties: false },
        ),
        graphSeed: Type.Object({ nodes: Type.Array(Type.Unknown()) }),
      },
      { additionalProperties: false },
    );
    let invocation: KoniToolInvocation | undefined;
    const [tool] = createKoniAuthorityTools({
      names: ["koni_submit_output"],
      terminalOutputSchema,
      async invoke(call) {
        invocation = call;
        return {
          protocol: KONI_TOOL_RECEIPT_PROTOCOL,
          receiptId: "receipt-malformed-outer-shape",
          outcome: "rejected",
          code: "tool_arguments",
          summary: "concise and graphSeed must be top-level fields",
        };
      },
      reject,
    });
    const malformedDraft = {
      full: {
        architecture: "Use the existing seam.",
        concise: { architecture: ["Reuse the owner."] },
        graphSeed: { nodes: [] },
      },
    };

    expect(Value.Check(tool!.definition.parameters, malformedDraft)).toBe(true);
    expect(Value.Check(tool!.terminalOutputSchema!, malformedDraft)).toBe(false);
    const result = await tool!.definition.execute(
      "submit-malformed-outer-shape",
      malformedDraft,
      undefined,
      undefined,
      {} as never,
    );
    expect(invocation).toMatchObject({
      name: "koni_submit_output",
      arguments: malformedDraft,
    });
    expect(result.terminate).toBeUndefined();
    expect(result.details).toMatchObject({ outcome: "rejected", code: "tool_arguments" });
  });

  it.each([
    {
      name: "koni_write_file" as const,
      strictSchemaHash:
        "sha256:98801c362bd663b62e52944813583d51d57fbb6edeb32e5fccd8d0cd1e689ffd" as const,
      malformed: { path: "src/large.ts", content: "x".repeat(96 * 1024) },
    },
    {
      name: "koni_edit_file" as const,
      strictSchemaHash:
        "sha256:31e306203c0db585ff13bb8acb8dd3255a6dabf82c100fb49ca6e8cb19bc5fc8" as const,
      malformed: {
        path: "src/large.ts",
        oldText: "x".repeat(48 * 1024),
        newText: "y".repeat(48 * 1024),
      },
    },
  ])(
    "forwards malformed large-payload $name calls to bounded authority rejection",
    async ({ name, strictSchemaHash, malformed }) => {
      let invocation: KoniToolInvocation | undefined;
      const [current] = createKoniAuthorityTools({
        names: [name],
        async invoke(call) {
          invocation = call;
          return {
            protocol: KONI_TOOL_RECEIPT_PROTOCOL,
            receiptId: `receipt-malformed-${name}`,
            outcome: "rejected",
            code: "tool_arguments",
            summary: "expectedSha256 is required by the exact authority contract",
          };
        },
        reject,
      });

      expect(Value.Check(current!.definition.parameters, malformed)).toBe(true);
      expect(() =>
        validateKoniToolArguments(name, malformed, undefined, current!.schemaHash),
      ).toThrow(/compiler-issued schema/u);
      const result = await current!.definition.execute(
        `malformed-${name}`,
        malformed,
        undefined,
        undefined,
        {} as never,
      );
      expect(invocation).toEqual({
        callId: `malformed-${name}`,
        name,
        arguments: malformed,
      });
      expect(result.details).toMatchObject({ outcome: "rejected", code: "tool_arguments" });

      const [historical] = createKoniAuthorityTools({
        names: [name],
        schemaHashes: { [name]: strictSchemaHash },
        async invoke() {
          return accepted(`receipt-historical-${name}`);
        },
        reject,
      });
      expect(historical!.schemaHash).toBe(strictSchemaHash);
      expect(Value.Check(historical!.definition.parameters, malformed)).toBe(false);
    },
  );

  it("reconstructs a pre-relaxation flattened terminal transport by its issued hash", () => {
    const graphSeedSchema = Type.Object({
      nodes: Type.Array(
        Type.Union([
          Type.Object(
            {
              type: Type.Literal("contract"),
              spec: Type.Object({ invariant: Type.String() }),
            },
            { additionalProperties: false },
          ),
          Type.Object(
            {
              type: Type.Literal("proof"),
              spec: Type.Object({ claim: Type.String() }),
            },
            { additionalProperties: false },
          ),
        ]),
      ),
    });
    const terminalOutputSchema = Type.Union([
      Type.Object(
        { status: Type.Literal("completed"), graphSeed: graphSeedSchema },
        { additionalProperties: false },
      ),
      Type.Object(
        { status: Type.Literal("checkpointed"), graphSeed: graphSeedSchema },
        { additionalProperties: false },
      ),
    ]);
    const legacyParameters = Type.Object(
      {
        status: Type.Union([Type.Literal("completed"), Type.Literal("checkpointed")]),
        graphSeed: graphSeedSchema,
      },
      {
        additionalProperties: false,
        description:
          'Send exactly one of these shapes, omitting every other branch\'s fields: { status: "completed", graphSeed: object }  OR  { status: "checkpointed", graphSeed: object }',
      },
    );
    const legacySchemaHash = canonicalHash(legacyParameters);
    const current = createKoniAuthorityTools({
      names: ["koni_submit_output"],
      terminalOutputSchema,
      async invoke() {
        return accepted("receipt-current");
      },
      reject,
    })[0]!;
    const legacy = createKoniAuthorityTools({
      names: ["koni_submit_output"],
      terminalOutputSchema,
      schemaHashes: { koni_submit_output: legacySchemaHash },
      async invoke() {
        return accepted("receipt-legacy");
      },
      reject,
    })[0]!;
    const historicalInvalidDraft = {
      status: "completed",
      graphSeed: { nodes: [{ type: "change", spec: { target_state: "available" } }] },
    };

    expect(current.schemaHash).not.toBe(legacySchemaHash);
    expect(legacy.schemaHash).toBe(legacySchemaHash);
    expect(canonicalHash(legacy.definition.parameters)).toBe(legacySchemaHash);
    expect(Value.Check(current.definition.parameters, historicalInvalidDraft)).toBe(true);
    expect(Value.Check(legacy.definition.parameters, historicalInvalidDraft)).toBe(false);
    expect(() =>
      validateKoniToolArguments(
        "koni_submit_output",
        historicalInvalidDraft,
        terminalOutputSchema,
        legacySchemaHash,
      ),
    ).toThrow(/compiler-issued schema/u);
  });

  it("reconstructs the prior strict outer transport for an in-flight planning attempt", () => {
    const terminalOutputSchema = Type.Object(
      {
        graphSeed: Type.Object({
          nodes: Type.Array(
            Type.Union([
              Type.Object(
                {
                  type: Type.Literal("contract"),
                  spec: Type.Object({ invariant: Type.String() }),
                },
                { additionalProperties: false },
              ),
              Type.Object(
                {
                  type: Type.Literal("proof"),
                  spec: Type.Object({ claim: Type.String() }),
                },
                { additionalProperties: false },
              ),
            ]),
          ),
        }),
      },
      { additionalProperties: false },
    );
    const priorParameters = Type.Object(
      {
        graphSeed: Type.Object({
          nodes: Type.Array(
            Type.Object(
              {
                spec: Type.Object({}, { additionalProperties: true }),
                type: Type.String({
                  minLength: 1,
                  description: 'Exact allowed literals: "contract", "proof"',
                }),
              },
              {
                additionalProperties: false,
                description:
                  'Presentation envelope only. type must be one of "contract", "proof"; authority validates the exact branch-owned spec.',
              },
            ),
          ),
        }),
      },
      { additionalProperties: false },
    );
    const priorSchemaHash = canonicalHash(priorParameters);
    const [tool] = createKoniAuthorityTools({
      names: ["koni_submit_output"],
      terminalOutputSchema,
      schemaHashes: { koni_submit_output: priorSchemaHash },
      async invoke() {
        return accepted("receipt-prior-strict-outer");
      },
      reject,
    });

    expect(tool!.schemaHash).toBe(priorSchemaHash);
    expect(canonicalHash(tool!.definition.parameters)).toBe(priorSchemaHash);
    expect(Value.Check(tool!.definition.parameters, { graphSeed: { nodes: [] } })).toBe(true);
    expect(
      Value.Check(tool!.definition.parameters, {
        graphSeed: { nodes: [{ type: "change", spec: {} }] },
      }),
    ).toBe(true);
  });

  it("derives an exact unique hash-bound inventory from one canonical schema catalog", () => {
    const terminalOutputSchema = Type.Object(
      { summary: Type.String() },
      { additionalProperties: false },
    );
    const tools = createKoniAuthorityTools({
      names: ["koni_read_file", "koni_edit_file", "koni_submit_output"],
      terminalOutputSchema,
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
    expect(tools[2]!.schemaHash).toBe(
      koniToolSchemaHash("koni_submit_output", terminalOutputSchema),
    );
    expect(tools[2]!.terminalOutputSchemaHash).toBe(canonicalHash(tools[2]!.terminalOutputSchema));
    expect(tools[2]!.terminalOutputSchemaHash).not.toBe(tools[2]!.schemaHash);
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
