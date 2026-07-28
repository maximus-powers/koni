import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";
import { stream as streamOpenAICodex } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAgentLaunchSpec } from "../src/pi/launch-spec.js";
import { ManagedPiSession, ManagedSessionError } from "../src/pi/managed-session.js";
import { sealPiModelDescriptor } from "../src/pi/model-catalog.js";
import { readPiSession } from "../src/pi/session-transcript.js";
import type {
  KoniContextProvider,
  KoniProviderRequestReservationInput,
  KoniProviderRequestSettlementInput,
} from "../src/pi/compaction.js";
import {
  createKoniAuthorityTools,
  KONI_TOOL_RECEIPT_PROTOCOL,
  koniToolMaxResultBytes,
  koniToolSchemaHash,
} from "../src/pi/tool-catalog.js";
import { fixtureLaunchSpec, fixtureTool, TERMINAL_OUTPUT_SCHEMA } from "./pi-managed-fixtures.js";

const temporary: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporary.splice(0).map((entry) => rm(entry, { recursive: true, force: true })),
  );
});

describe("durable Pi provider request admission", () => {
  it("sends Pi's actual Codex SSE body without inventing max_output_tokens", async () => {
    const model = codexModel("gpt-5.6-terra", 128_000);
    let transportBody: unknown;
    let transportHeaders: Headers | undefined;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      transportHeaders = new Headers(init?.headers);
      transportBody = init?.body;
      return new Response("provider-free rejection", { status: 400 });
    });
    const events = streamOpenAICodex(
      model,
      {
        systemPrompt: "contained",
        messages: [{ role: "user", content: "inspect the exact body", timestamp: Date.now() }],
        tools: [],
      },
      {
        apiKey: fakeCodexToken(),
        transport: "sse",
        maxRetries: 0,
      },
    );
    for await (const _event of events) {
      // Fully consume the pinned transport so its mocked fetch body is authoritative evidence.
    }

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = await decodeCodexTransportBody(transportBody, transportHeaders);
    expect(body).toEqual(
      expect.objectContaining({
        model: model.id,
        store: false,
        stream: true,
      }),
    );
    expect(body).not.toHaveProperty("max_output_tokens");
  });

  it("runs a real two-round Pi session as reserve, transport, settle, then repeat", async () => {
    const harness = await twoRoundHarness();
    const session = await ManagedPiSession.create(harness.spec, {
      tools: harness.tools,
      modelRuntime: harness.modelRuntime,
      contextProvider: harness.contextProvider,
    });

    const outcome = await session.start();

    expect(outcome).toEqual({
      status: "completed",
      terminalOutput: { result: "done" },
      usage: {
        input: 30,
        output: 12,
        cacheRead: 5,
        cacheWrite: 3,
        newTokens: 42,
        allTokens: 50,
      },
    });
    expect(harness.order).toEqual([
      "reserve:1",
      "transport:1",
      "settle:1",
      "reserve:2",
      "transport:2",
      "settle:2",
    ]);
    expect(harness.reservations).toHaveLength(2);
    for (const request of harness.reservations) {
      expect(request).toEqual(
        expect.objectContaining({
          api: "openai-codex-responses",
          modelId: harness.spec.model.id,
          reservedOutputTokens: 128_000,
        }),
      );
      expect(request).not.toHaveProperty("serializedOutputCap");
    }
    expect(harness.payloads).toHaveLength(2);
    for (const payload of harness.payloads) {
      expect(payload).not.toHaveProperty("max_output_tokens");
    }
  });

  it.each([
    [
      "provider_input_exposure",
      "prospective provider input plus reserved output exceeds the authenticated model context window",
    ],
    ["provider_token_exposure", "compiler-issued hard provider exposure ceiling was exceeded"],
  ] as const)(
    "uses provider-free compaction when typed authority exposure %s has arbitrary wording",
    async (exposureCode, exposureMessage) => {
      const harness = await twoRoundHarness({
        compactOnInputPressure: true,
        exposureCode,
        exposureMessage,
      });
      const session = await ManagedPiSession.create(harness.spec, {
        tools: harness.tools,
        modelRuntime: harness.modelRuntime,
        contextProvider: harness.contextProvider,
      });

      const outcome = await session.start();

      expect(outcome).toEqual({
        status: "completed",
        terminalOutput: { result: "done" },
        usage: {
          input: 30,
          output: 12,
          cacheRead: 5,
          cacheWrite: 3,
          newTokens: 42,
          allTokens: 50,
        },
      });
      expect(harness.order).toEqual([
        "reserve:1",
        "transport:1",
        "settle:1",
        "reserve:2",
        "compact:1",
        "reserve:2",
        "transport:3",
        "settle:2",
      ]);
      expect(harness.payloads).toHaveLength(2);
      expect(harness.reservations.map((request) => request.sequence)).toEqual([1, 2, 2]);
    },
  );

  it("never enters transport when the final durable reservation rejects", async () => {
    const harness = await twoRoundHarness({ rejectReservation: true });
    const session = await ManagedPiSession.create(harness.spec, {
      tools: harness.tools,
      modelRuntime: harness.modelRuntime,
      contextProvider: harness.contextProvider,
    });

    await expect(session.start()).resolves.toEqual(
      expect.objectContaining({
        status: "failed",
        code: "provider_admission",
        error: expect.stringContaining("reservation rejected by test authority"),
      }),
    );
    expect(harness.order).toEqual(["reserve:1"]);
    expect(harness.payloads).toEqual([]);
  });

  it("never performs a second transport after a persisted provider error", async () => {
    const harness = await twoRoundHarness({ providerError: true });
    const session = await ManagedPiSession.create(harness.spec, {
      tools: harness.tools,
      modelRuntime: harness.modelRuntime,
      contextProvider: harness.contextProvider,
    });

    await expect(session.start()).resolves.toMatchObject({ status: "failed" });
    expect(harness.order).toEqual(["reserve:1", "transport:1"]);
    expect(harness.payloads).toHaveLength(1);
    expect(harness.reservations).toHaveLength(1);
  });

  it("preserves Google's live AbortSignal while reserving Pi's exact context-clamped wire cap", async () => {
    const harness = await cappedHarness("google-generative-ai");
    const session = await ManagedPiSession.create(harness.spec, {
      tools: [fixtureTool()],
      modelRuntime: harness.modelRuntime,
      contextProvider: harness.contextProvider,
    });

    await expect(session.start()).resolves.toMatchObject({ status: "failed" });
    expect(harness.transportCount()).toBe(1);
    expect(harness.preservedAbortSignal()).toBe(true);
    expect(harness.reservations).toHaveLength(1);
    const reservation = harness.reservations[0]!;
    expect(reservation.serializedOutputCap).toEqual({
      path: "/config/maxOutputTokens",
      value: expect.any(Number),
    });
    expect(reservation.serializedOutputCap!.value).toBeLessThan(
      harness.spec.model.catalogMaxTokens,
    );
    expect(reservation.reservedOutputTokens).toBe(reservation.serializedOutputCap!.value);
  });

  it("rejects a selected-model alias that raises the output cap before reservation or transport", async () => {
    const harness = await cappedHarness("openai-responses", true);
    const session = await ManagedPiSession.create(harness.spec, {
      tools: [fixtureTool()],
      modelRuntime: harness.modelRuntime,
      contextProvider: harness.contextProvider,
    });

    await expect(session.start()).resolves.toMatchObject({ status: "failed" });
    expect(harness.transportCount()).toBe(0);
    expect(harness.reservations).toEqual([]);
  });
});

async function cappedHarness(
  api: "google-generative-ai" | "openai-responses",
  mutateAlias = false,
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "koni-provider-cap-"));
  temporary.push(root);
  const cwd = path.join(root, "worktree");
  const sessionDirectory = path.join(root, "sessions");
  await mkdir(cwd);
  const provider = `koni-cap-${api}`;
  const modelId = "context-clamped";
  const modelRuntime = await ModelRuntime.create({
    allowModelNetwork: false,
    authPath: path.join(root, "isolated-auth.json"),
    modelsPath: null,
  });
  let transports = 0;
  let signalPreserved = false;
  modelRuntime.registerProvider(provider, {
    name: "Contained cap fixture",
    baseUrl: "https://provider-cap.invalid",
    apiKey: "disposable-test-key",
    api,
    streamSimple: ((_model: Model<Api>, context: Context, streamOptions: any) => {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        try {
          const authorityLimit = _model.maxTokens;
          const cap = clampMaxTokensToContext(_model, context, authorityLimit);
          if (mutateAlias) _model.maxTokens = authorityLimit + 1;
          const payload =
            api === "google-generative-ai"
              ? {
                  model: _model.id,
                  contents: [{ role: "user", parts: [{ text: "work" }] }],
                  config: { maxOutputTokens: cap, abortSignal: streamOptions.signal },
                }
              : {
                  model: _model.id,
                  input: [{ role: "user", content: "work" }],
                  max_output_tokens: cap,
                };
          const admitted = (await streamOptions.onPayload(payload, _model)) as Record<
            string,
            unknown
          >;
          transports += 1;
          if (api === "google-generative-ai") {
            signalPreserved =
              (admitted.config as Record<string, unknown>).abortSignal === streamOptions.signal &&
              streamOptions.signal instanceof AbortSignal;
          }
          const failed = failedAssistant(_model, "provider-free stop after payload admission");
          stream.push({ type: "error", reason: "error", error: failed });
          stream.end();
        } catch (error) {
          const failed = failedAssistant(
            _model,
            error instanceof Error ? error.message : String(error),
          );
          stream.push({ type: "error", reason: "error", error: failed });
          stream.end();
        }
      })();
      return stream;
    }) as never,
    models: [
      {
        id: modelId,
        name: "Context-clamped fixture",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 6_000,
        maxTokens: 4_096,
      },
    ],
  });
  const sealed = sealPiModelDescriptor(modelRuntime.getModel(provider, modelId)!);
  const base = fixtureLaunchSpec({ cwd, sessionDirectory, maxAllTokens: 300_000 });
  const { specHash: _hash, ...draft } = structuredClone(base);
  draft.model = { ...sealed, thinkingLevel: "off" };
  draft.budgets.tokens.providerOutputHeadroom = sealed.catalogMaxTokens;
  const spec = createAgentLaunchSpec(draft);
  const reservations: KoniProviderRequestReservationInput[] = [];
  const contextProvider: KoniContextProvider = {
    async loadBoundContext() {
      return {
        ...spec.identity,
        grantId: spec.authority.grantId,
        generation: spec.authority.generation,
        epoch: spec.authority.epoch,
        stateHash: spec.authority.expectedStateHash,
        contextHash: spec.authority.authoritativeContextHash,
        content: "authoritative context",
      };
    },
    async loadCompactionSnapshot() {
      throw new Error("compaction is not expected");
    },
    async authorizeCompaction() {
      throw new Error("compaction is not expected");
    },
    async acquireRecoveryClaim() {
      throw new Error("recovery is not expected");
    },
    async reserveProviderRequest(_spec, request) {
      reservations.push(structuredClone(request));
      const transcript = await readPiSession(
        path.join(spec.workspace.sessionDirectory, `${spec.identity.sessionId}.jsonl`),
      );
      return {
        protocol: "koni.provider-request-reservation.v1",
        sequence: request.sequence,
        reservationId: `provider-${request.sequence}`,
        baselineEntryId: transcript.lastEntryId!,
      };
    },
    async reconcileProviderRequest() {
      throw new Error("an error assistant must remain unsettled");
    },
  };
  return {
    spec,
    modelRuntime,
    contextProvider,
    reservations,
    transportCount: () => transports,
    preservedAbortSignal: () => signalPreserved,
  };
}

async function twoRoundHarness(
  options: {
    rejectReservation?: boolean;
    providerError?: boolean;
    compactOnInputPressure?: boolean;
    exposureCode?: "provider_input_exposure" | "provider_token_exposure";
    exposureMessage?: string;
  } = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "koni-provider-reservation-"));
  temporary.push(root);
  const cwd = path.join(root, "worktree");
  const sessionDirectory = path.join(root, "sessions");
  await mkdir(cwd);
  const provider = "koni-provider-reservation-test";
  const modelId = "contained-codex";
  const modelRuntime = await ModelRuntime.create({
    allowModelNetwork: false,
    authPath: path.join(root, "isolated-auth.json"),
    modelsPath: null,
  });
  const order: string[] = [];
  const payloads: Array<Record<string, unknown>> = [];
  let call = 0;
  modelRuntime.registerProvider(provider, {
    name: "Contained reservation test",
    baseUrl: "https://provider-reservation.invalid",
    apiKey: "disposable-test-key",
    api: "openai-codex-responses",
    streamSimple: ((
      _model: Model<"openai-codex-responses">,
      _context: Context,
      streamOptions: any,
    ) => {
      const stream = createAssistantMessageEventStream();
      const round = ++call;
      void (async () => {
        try {
          const admitted = await streamOptions.onPayload(codexPayload(modelId), _model);
          order.push(`transport:${round}`);
          payloads.push(structuredClone(admitted) as Record<string, unknown>);
          if (options.providerError === true) {
            const failed = failedAssistant(_model, "simulated provider transport failure");
            stream.push({ type: "error", reason: "error", error: failed });
            stream.end();
            return;
          }
          const message =
            round === 1
              ? assistant(_model, {
                  content: [
                    {
                      type: "toolCall",
                      id: "record-note-one",
                      name: "koni_record_note",
                      arguments: {
                        nodeId: "node-one",
                        kind: "observation",
                        body:
                          options.compactOnInputPressure === true
                            ? "x".repeat(100_000)
                            : "round one",
                      },
                    },
                  ],
                  input: 10,
                  output: 5,
                  cacheRead: 2,
                  cacheWrite: 1,
                })
              : assistant(_model, {
                  content: [
                    {
                      type: "toolCall",
                      id: "submit-output-two",
                      name: "koni_submit_output",
                      arguments: { result: "done" },
                    },
                  ],
                  input: 20,
                  output: 7,
                  cacheRead: 3,
                  cacheWrite: 2,
                });
          stream.push({ type: "start", partial: structuredClone(message) });
          stream.push({ type: "done", reason: "toolUse", message });
          stream.end();
        } catch (error) {
          const failed = failedAssistant(
            _model,
            error instanceof Error ? error.message : String(error),
          );
          stream.push({ type: "error", reason: "error", error: failed });
          stream.end();
        }
      })();
      return stream;
    }) as never,
    models: [
      {
        id: modelId,
        name: "Contained Codex reservation fixture",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 300_000,
        maxTokens: 128_000,
      },
    ],
  });
  const executableModel = modelRuntime.getModel(provider, modelId)!;
  const seal = sealPiModelDescriptor(executableModel);
  const base = fixtureLaunchSpec({
    cwd,
    sessionDirectory,
    maxAllTokens: 300_000,
  });
  const { specHash: _hash, ...draft } = structuredClone(base);
  draft.model = {
    ...seal,
    thinkingLevel: "off",
  };
  draft.budgets.tokens.providerOutputHeadroom = seal.catalogMaxTokens;
  draft.tools = [
    {
      name: "koni_record_note",
      schemaHash: koniToolSchemaHash("koni_record_note"),
      executionMode: "sequential",
      maxResultBytes: koniToolMaxResultBytes("koni_record_note"),
    },
    {
      name: "koni_submit_output",
      schemaHash: koniToolSchemaHash("koni_submit_output", TERMINAL_OUTPUT_SCHEMA),
      executionMode: "sequential",
      maxResultBytes: koniToolMaxResultBytes("koni_submit_output"),
    },
  ];
  draft.terminal.outputSchemaHash = koniToolSchemaHash(
    "koni_submit_output",
    TERMINAL_OUTPUT_SCHEMA,
  );
  const spec = createAgentLaunchSpec(draft);
  const tools = createKoniAuthorityTools({
    names: ["koni_record_note", "koni_submit_output"],
    terminalOutputSchema: TERMINAL_OUTPUT_SCHEMA,
    async invoke(callInput) {
      return {
        protocol: KONI_TOOL_RECEIPT_PROTOCOL,
        receiptId: `receipt-${callInput.callId}`,
        outcome: "accepted",
        summary: callInput.name === "koni_submit_output" ? "submitted" : "noted",
      };
    },
    async reject(_callInput, rejection) {
      return {
        protocol: KONI_TOOL_RECEIPT_PROTOCOL,
        receiptId: "receipt-rejected",
        outcome: "rejected",
        code: rejection.code,
        summary: rejection.summary,
      };
    },
  });
  const reservations: KoniProviderRequestReservationInput[] = [];
  let pressureRejected = false;
  let compactionSequence = 0;
  const contextProvider: KoniContextProvider = {
    async loadBoundContext() {
      return {
        ...spec.identity,
        grantId: spec.authority.grantId,
        generation: spec.authority.generation,
        epoch: spec.authority.epoch,
        stateHash: spec.authority.expectedStateHash,
        contextHash: spec.authority.authoritativeContextHash,
        content: "authoritative context",
      };
    },
    async loadCompactionSnapshot() {
      if (options.compactOnInputPressure !== true) {
        throw new Error("compaction is not expected in provider reservation tests");
      }
      return {
        objective: "Prove bounded provider admission",
        plan: {
          architecture: "Planning is still in progress.",
          decisions: "Planning is still in progress.",
          risk: "Planning is still in progress.",
          verification: "Planning is still in progress.",
        },
        graphRefs: [],
        touchedFiles: ["large-context.fixture"],
        receiptIds: ["receipt-record-note-one"],
        checkIds: [],
        unresolvedQuestions: [],
        nextAction: "Retry the same provider turn after provider-free compaction.",
      };
    },
    async authorizeCompaction() {
      if (options.compactOnInputPressure !== true) {
        throw new Error("compaction is not expected in provider reservation tests");
      }
      compactionSequence += 1;
      order.push(`compact:${compactionSequence}`);
      return { authorizationId: `compaction-${compactionSequence}` };
    },
    async acquireRecoveryClaim() {
      throw new Error("recovery is not expected in fresh provider reservation tests");
    },
    async reserveProviderRequest(_spec, request) {
      order.push(`reserve:${request.sequence}`);
      reservations.push(structuredClone(request));
      if (options.rejectReservation === true) {
        throw new Error("reservation rejected by test authority");
      }
      if (options.compactOnInputPressure === true && request.sequence === 2 && !pressureRejected) {
        pressureRejected = true;
        throw new ManagedSessionError(
          options.exposureCode ?? "provider_input_exposure",
          options.exposureMessage ??
            "prospective provider input plus reserved output exceeds the authenticated model context window",
        );
      }
      const transcript = await readPiSession(
        path.join(spec.workspace.sessionDirectory, `${spec.identity.sessionId}.jsonl`),
      );
      return {
        protocol: "koni.provider-request-reservation.v1",
        sequence: request.sequence,
        reservationId: `provider-${request.sequence}`,
        baselineEntryId: transcript.lastEntryId!,
      };
    },
    async reconcileProviderRequest(_spec, settlement: KoniProviderRequestSettlementInput) {
      order.push(`settle:${settlement.sequence}`);
      return {
        protocol: "koni.provider-request-settlement.v1",
        ...structuredClone(settlement),
      };
    },
  };
  return { spec, tools, modelRuntime, contextProvider, order, payloads, reservations };
}

function codexModel(id: string, maxTokens: number): Model<"openai-codex-responses"> {
  return {
    id,
    name: "Pinned Codex admission fixture",
    api: "openai-codex-responses",
    provider: "openai-codex",
    baseUrl: "https://chatgpt.com/backend-api",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens,
  };
}

function codexPayload(model: string): Record<string, unknown> {
  return {
    model,
    store: false,
    stream: true,
    instructions: "contained",
    input: [{ role: "user", content: [{ type: "input_text", text: "work" }] }],
    text: { verbosity: "low" },
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: "koni-test",
    tool_choice: "auto",
    parallel_tool_calls: true,
  };
}

function assistant(
  model: Model<"openai-codex-responses">,
  options: {
    content: AssistantMessage["content"];
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  },
): AssistantMessage {
  return {
    role: "assistant",
    content: options.content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: options.input,
      output: options.output,
      cacheRead: options.cacheRead,
      cacheWrite: options.cacheWrite,
      totalTokens: options.input + options.output + options.cacheRead + options.cacheWrite,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

function failedAssistant(model: Model<Api>, message: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: message,
    timestamp: Date.now(),
  };
}

function fakeCodexToken(): string {
  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "koni-test-account" },
    }),
    "utf8",
  ).toString("base64url");
  return `header.${payload}.signature`;
}

async function decodeCodexTransportBody(
  body: unknown,
  headers: Headers | undefined,
): Promise<Record<string, unknown>> {
  if (typeof body === "string") return JSON.parse(body) as Record<string, unknown>;
  if (!(body instanceof Uint8Array))
    throw new Error("Codex test transport body is not bytes or text");
  let bytes = Buffer.from(body);
  if (headers?.get("content-encoding") === "zstd") {
    const zlib = await import("node:zlib");
    if (typeof zlib.zstdDecompressSync !== "function")
      throw new Error("Node zstd support is unavailable");
    bytes = zlib.zstdDecompressSync(bytes);
  }
  return JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
}
