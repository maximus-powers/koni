import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createServer, type AddressInfo } from "node:net";
import {
  InMemoryCredentialStore,
  createAssistantMessageEventStream,
  createProvider,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Model,
  type OAuthCredential,
  type Provider,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { CredentialClient } from "../src/credential-channel.js";
import { IpcCredentialStore } from "../src/credential-store.js";
import {
  HostError,
  projectProviderFailure,
  projectRuntimeFailure,
} from "../src/errors.js";
import { formatFatalError } from "../src/main.js";
import { koniOpenAICodexProvider } from "../src/openai-codex-provider.js";
import { SecretRedactor } from "../src/redaction.js";
import {
  assertOAuthCallbackAvailable,
  MAX_BROKER_TOOL_ARGUMENT_JSON_BYTES,
  OAUTH_CALLBACK_UNAVAILABLE_MESSAGE,
  PiRuntimeManager,
  toolArgumentsFitPublicFrame,
} from "../src/runtime.js";
import { parseRuntimeCommand } from "../src/validation.js";
import type { AgentToolCallWire, AgentToolOutcome, RuntimeEvent, RuntimeSessionStart } from "../src/wire-types.js";

class FakeProtocol {
  readonly events: RuntimeEvent[] = [];
  readonly calls: AgentToolCallWire[] = [];

  constructor(
    private readonly outcome:
      | AgentToolOutcome
      | ((call: AgentToolCallWire) => AgentToolOutcome | Promise<AgentToolOutcome>) = {
      status: "success",
      value: { ok: true },
    },
  ) {}

  async sendEvent(event: RuntimeEvent): Promise<void> {
    this.events.push(event);
  }

  async executeTool(call: AgentToolCallWire): Promise<AgentToolOutcome> {
    this.calls.push(call);
    return typeof this.outcome === "function" ? this.outcome(call) : this.outcome;
  }
}

function sessionRequest(faux: ReturnType<typeof fauxProvider>, tools = true): RuntimeSessionStart {
  return {
    session_id: "session-1",
    run_id: "run-1",
    agent_id: "worker-1",
    attempt: 1,
    model: {
      provider: faux.provider.id,
      model: faux.getModel().id,
      thinking_level: "off",
      input_capabilities: ["text"],
      context_window: faux.getModel().contextWindow,
    },
    instructions: "Use only compiler-declared tools.",
    tools: tools
      ? [
          {
            name: "record_note",
            description: "Record a bounded note",
            input_schema: {
              type: "object",
              properties: { note: { type: "string" } },
              required: ["note"],
              additionalProperties: false,
            },
          },
        ]
      : [],
    credential_lease: "lease-1",
  };
}

function terminalSessionRequest(faux: ReturnType<typeof fauxProvider>): RuntimeSessionStart {
  const request = sessionRequest(faux);
  request.tools = [
    {
      name: "submit_and_compile",
      description: "Submit the assignment and cross the compiler boundary",
      input_schema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  ];
  request.terminal_boundary_tools = ["submit_and_compile"];
  return request;
}

function contextSessionRequest(faux: ReturnType<typeof fauxProvider>): RuntimeSessionStart {
  const request = sessionRequest(faux);
  request.context_completion_required = true;
  request.tools = [
    {
      name: "context",
      description: "Read compiler context",
      input_schema: { type: "object", additionalProperties: false },
    },
    {
      name: "read_file",
      description: "Read compiler context or one product file",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string" },
          offset: { type: "integer" },
          max_bytes: { type: "integer" },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  ];
  return request;
}

describe("PiRuntimeManager", () => {
  it("defaults an absent terminal policy to empty and rejects forged or ambiguous policy names", () => {
    const faux = fauxProvider({ provider: "faux-runtime" });
    const request = sessionRequest(faux);
    const parsed = parseRuntimeCommand({ command: "start_session", request });
    expect(parsed.command === "start_session" ? parsed.request.terminal_boundary_tools : undefined).toEqual([]);

    expect(() =>
      parseRuntimeCommand({
        command: "start_session",
        request: { ...request, terminal_boundary_tools: ["record_note", "record_note"] },
      }),
    ).toThrow("duplicate terminal boundary tool record_note");
    expect(() =>
      parseRuntimeCommand({
        command: "start_session",
        request: { ...request, terminal_boundary_tools: ["submit_and_compile"] },
      }),
    ).toThrow("is not declared in start_session.tools");
    expect(() =>
      parseRuntimeCommand({
        command: "start_session",
        request: {
          ...request,
          terminal_boundary_tools: Array.from({ length: 9 }, (_, index) => `tool_${index}`),
        },
      }),
    ).toThrow("must have at most 8 entries");
  });

  it("corrects one prose-only finish and preserves one cumulative runtime turn through its terminal tool", async () => {
    const faux = fauxProvider({ provider: "faux-runtime" });
    faux.setResponses([
      fauxAssistantMessage("I finished the work."),
      (context) => {
        expect(JSON.stringify(context.messages)).toContain("Koni compiler correction");
        expect(JSON.stringify(context.messages)).toContain("submit_and_compile");
        expect(JSON.stringify(context.messages)).toContain("Do not repeat effects already accepted");
        return fauxAssistantMessage(
          fauxToolCall("submit_and_compile", {}, { id: "tool-terminal-correction" }),
          { stopReason: "toolUse" },
        );
      },
    ]);
    const protocol = new FakeProtocol({ status: "terminate", value: { accepted: true } });
    const runtime = new PiRuntimeManager({
      protocol,
      credentialStore: new InMemoryCredentialStore(),
      redactor: new SecretRedactor(),
      provider: faux.provider,
      allowedProviderId: "faux-runtime",
    });
    runtime.startSession(terminalSessionRequest(faux), "session-1");
    runtime.startTurn({
      turn_id: "turn-terminal-correction",
      input: [{ kind: "text", text: "finish through the compiler" }],
      output_schema: null,
      output_token_budget: null,
    });
    await runtime.waitForIdle();

    expect(faux.state.callCount).toBe(2);
    expect(protocol.calls).toEqual([
      { call_id: "tool-terminal-correction", name: "submit_and_compile", arguments: {} },
    ]);
    expect(protocol.events.filter((event) => event.event === "turn_started")).toHaveLength(1);
    expect(protocol.events.filter((event) => event.event === "turn_completed")).toHaveLength(1);
    expect(protocol.events.filter((event) => event.event === "usage")).toHaveLength(2);
    const snapshot = runtime.snapshot() as { messages: AgentMessage[] };
    expect(
      snapshot.messages.filter(
        (message) =>
          message.role === "user" &&
          Array.isArray(message.content) &&
          message.content.some((block) =>
            block.type === "text" && block.text.includes("Koni compiler correction")
          ),
      ),
    ).toHaveLength(1);
  });

  it("injects at most one correction when the second assistant message is also prose", async () => {
    const faux = fauxProvider({ provider: "faux-runtime" });
    faux.setResponses([
      fauxAssistantMessage("First prose-only finish."),
      fauxAssistantMessage("Second prose-only finish."),
      () => {
        throw new Error("a third provider prompt must never be injected");
      },
    ]);
    const protocol = new FakeProtocol();
    const runtime = new PiRuntimeManager({
      protocol,
      credentialStore: new InMemoryCredentialStore(),
      redactor: new SecretRedactor(),
      provider: faux.provider,
      allowedProviderId: "faux-runtime",
    });
    runtime.startSession(terminalSessionRequest(faux), "session-1");
    runtime.startTurn({
      turn_id: "turn-one-correction-only",
      input: [{ kind: "text", text: "finish" }],
      output_schema: null,
      output_token_budget: null,
    });
    await runtime.waitForIdle();

    expect(faux.state.callCount).toBe(2);
    expect(protocol.calls).toEqual([]);
    expect(protocol.events.filter((event) => event.event === "turn_completed")).toHaveLength(1);
  });

  it("does not correct prose when the compiler issued no terminal-boundary policy", async () => {
    const faux = fauxProvider({ provider: "faux-runtime" });
    faux.setResponses([fauxAssistantMessage("Read-only planning artifact.")]);
    const runtime = new PiRuntimeManager({
      protocol: new FakeProtocol(),
      credentialStore: new InMemoryCredentialStore(),
      redactor: new SecretRedactor(),
      provider: faux.provider,
      allowedProviderId: "faux-runtime",
    });
    runtime.startSession(sessionRequest(faux, false), "session-1");
    runtime.startTurn({
      turn_id: "turn-no-terminal-policy",
      input: [{ kind: "text", text: "return an artifact" }],
      output_schema: null,
      output_token_budget: null,
    });
    await runtime.waitForIdle();
    expect(faux.state.callCount).toBe(1);
  });

  it.each([
    ["length", fauxAssistantMessage("Truncated prose.", { stopReason: "length" })],
    ["error", fauxAssistantMessage([], { stopReason: "error", errorMessage: "provider unavailable" })],
    ["empty prose", fauxAssistantMessage("   ")],
  ] as const)("does not correct an ineligible %s finish", async (_name, response) => {
    const faux = fauxProvider({ provider: "faux-runtime" });
    faux.setResponses([response]);
    const runtime = new PiRuntimeManager({
      protocol: new FakeProtocol(),
      credentialStore: new InMemoryCredentialStore(),
      redactor: new SecretRedactor(),
      provider: faux.provider,
      allowedProviderId: "faux-runtime",
    });
    runtime.startSession(terminalSessionRequest(faux), "session-1");
    runtime.startTurn({
      turn_id: `turn-ineligible-${_name.replace(" ", "-")}`,
      input: [{ kind: "text", text: "finish" }],
      output_schema: null,
      output_token_budget: null,
    });
    await runtime.waitForIdle();
    expect(faux.state.callCount).toBe(1);
  });

  it("does not inject a correction after the first response exhausts its output budget", async () => {
    const faux = fauxProvider({ provider: "faux-runtime" });
    const responseText = "Budget exactly consumed.";
    const response = fauxAssistantMessage(responseText);
    faux.setResponses([response]);
    const protocol = new FakeProtocol();
    const runtime = new PiRuntimeManager({
      protocol,
      credentialStore: new InMemoryCredentialStore(),
      redactor: new SecretRedactor(),
      provider: faux.provider,
      allowedProviderId: "faux-runtime",
    });
    runtime.startSession(terminalSessionRequest(faux), "session-1");
    runtime.startTurn({
      turn_id: "turn-correction-budget-exhausted",
      input: [{ kind: "text", text: "finish" }],
      output_schema: null,
      output_token_budget: Math.ceil(responseText.length / 4),
    });
    await runtime.waitForIdle();

    expect(faux.state.callCount).toBe(1);
    expect(protocol.events.at(-1)).toMatchObject({
      event: "turn_completed",
      stop_reason: "output_token_budget",
    });
  });

  it("preserves provider error classification when no correction is eligible and budget is nearly spent", async () => {
    const faux = fauxProvider({ provider: "openai-codex", api: "openai-codex-responses" });
    faux.setResponses([
      fauxAssistantMessage("failed", {
        stopReason: "error",
        errorMessage: "upstream service unavailable HTTP 503",
      }),
    ]);
    const protocol = new FakeProtocol();
    const runtime = new PiRuntimeManager({
      protocol,
      credentialStore: new InMemoryCredentialStore(),
      redactor: new SecretRedactor(),
      provider: faux.provider,
    });
    runtime.startSession(terminalSessionRequest(faux), "session-1");
    runtime.startTurn({
      turn_id: "turn-error-near-budget",
      input: [{ kind: "text", text: "finish" }],
      output_schema: null,
      output_token_budget: 16,
    });
    await runtime.waitForIdle();

    expect(faux.state.callCount).toBe(1);
    expect(protocol.events.at(-1)).toMatchObject({
      event: "turn_completed",
      stop_reason: "error",
    });
  });

  it.each([
    [
      "usage limit before generic 429",
      "HTTP 429 usage_limit_reached: ChatGPT usage limit",
      "provider_usage_limit",
      "Your ChatGPT Codex usage limit has been reached. Wait for it to reset, then resume the run.",
      false,
    ],
    [
      "authentication",
      "HTTP status 401 unauthorized: expired access token",
      "provider_authentication",
      "OpenAI Codex rejected the stored sign-in. Run koni auth login, then resume the run.",
      false,
    ],
    [
      "access denied",
      "HTTP status 403 forbidden model entitlement denied",
      "provider_access_denied",
      "OpenAI Codex denied this account or model. Check ChatGPT subscription and model access, then retry.",
      false,
    ],
    [
      "request rejection",
      "HTTP status 400 unknown parameter max_output_tokens",
      "provider_request_rejected",
      "OpenAI Codex rejected the request. Check the selected model and Koni runtime compatibility before retrying.",
      false,
    ],
    [
      "rate limiting",
      "HTTP status 429 too many requests",
      "provider_rate_limited",
      "OpenAI Codex is temporarily rate-limiting requests. Retry after a short delay.",
      true,
    ],
    [
      "provider unavailable",
      "HTTP status 503 upstream service unavailable; retry again",
      "provider_unavailable",
      "OpenAI Codex is temporarily unavailable. Retry this turn.",
      true,
    ],
    [
      "unknown",
      "unexpected opaque provider failure",
      "provider_error",
      "OpenAI Codex failed for an unclassified reason. Retry manually; if it repeats, reauthenticate and check service status.",
      false,
    ],
  ] as const)("projects $name onto one exact public tuple", (_name, raw, code, message, retryable) => {
    expect(projectProviderFailure(raw)).toEqual({ code, message, retryable });
  });

  it("classifies malformed and hostile values without throwing or exposing them", () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("arbitrary-unknown-secret");
        },
      },
    );
    const throwing = {
      toString() {
        throw new Error("another-arbitrary-secret");
      },
    };
    expect(projectProviderFailure(hostile)).toEqual({
      code: "provider_error",
      message:
        "OpenAI Codex failed for an unclassified reason. Retry manually; if it repeats, reauthenticate and check service status.",
      retryable: false,
    });
    expect(projectProviderFailure(throwing)).toEqual(projectProviderFailure(undefined));
    expect(projectProviderFailure(`${"x".repeat(8192)} HTTP status 429`)).toEqual(
      projectProviderFailure(undefined),
    );
    expect(projectProviderFailure({ status: 401 })).toMatchObject({
      code: "provider_authentication",
      retryable: false,
    });
  });

  it("projects host-authored failures onto fixed stderr-safe tuples", () => {
    expect(projectRuntimeFailure(new HostError("BROKER_TIMEOUT", "secret broker detail"))).toEqual({
      code: "runtime_broker_timeout",
      message: "The compiler tool broker did not respond in time. Inspect the run state, then resume safely.",
      retryable: false,
    });
    expect(projectRuntimeFailure(new HostError("PROTOCOL_ERROR", "secret frame"))).toEqual({
      code: "runtime_protocol_error",
      message: "The Pi runtime protocol failed closed. Restart Koni before resuming the run.",
      retryable: false,
    });
    expect(projectRuntimeFailure(new HostError("OUTPUT_LIMIT", "secret oversized output"))).toEqual({
      code: "runtime_output_limit",
      message:
        "The agent response was too large for this run's output allowance. Its transcript was preserved; start a larger run or revise the run-type limits before retrying.",
      retryable: false,
    });
    expect(projectRuntimeFailure({ code: "ENOTTY", message: "secret fd detail" })).toEqual({
      code: "runtime_credential_channel",
      message: "The Pi runtime private credential channel is unavailable.",
      retryable: false,
    });
    expect(projectRuntimeFailure(new Error("arbitrary-unknown-secret"))).toEqual({
      code: "runtime_internal",
      message: "The Pi runtime failed internally. Retry manually; if it repeats, inspect Koni diagnostics.",
      retryable: false,
    });
    expect(formatFatalError(new Error("arbitrary-unknown-secret"))).not.toContain(
      "arbitrary-unknown-secret",
    );
  });

  it.each([
    ["usage_limit_reached HTTP 429", "provider_usage_limit", false],
    ["expired access token HTTP 401", "provider_authentication", false],
    ["model entitlement denied HTTP 403", "provider_access_denied", false],
    ["unknown parameter HTTP 400", "provider_request_rejected", false],
    ["too many requests HTTP 429", "provider_rate_limited", true],
    ["upstream service unavailable HTTP 503", "provider_unavailable", true],
    ["opaque-provider-failure", "provider_error", false],
  ] as const)("publishes only the projected provider failure for %s", async (classification, code, retryable) => {
    const secrets = [
      "bearer-secret",
      "jwt-secret",
      "access-secret",
      "refresh-secret",
      "id-secret",
      "authorization-secret",
      "verifier-secret",
      "device-secret",
      "client-secret",
      "cookie-secret",
      "person@example.invalid",
      "prompt-secret",
      "arbitrary-unknown-secret",
    ];
    const raw = `${classification} ${JSON.stringify({
      authorization: `Bearer ${secrets[0]}`,
      jwt: secrets[1],
      access_token: secrets[2],
      refresh_token: secrets[3],
      id_token: secrets[4],
      authorization_code: secrets[5],
      code_verifier: secrets[6],
      device_auth_id: secrets[7],
      client_secret: secrets[8],
      cookie: secrets[9],
      email: secrets[10],
      url: `https://provider.invalid/callback?prompt=${secrets[11]}`,
      unknown: secrets[12],
    })}`;
    const faux = fauxProvider({ provider: "faux-runtime" });
    faux.setResponses([
      fauxAssistantMessage([], { stopReason: "error", errorMessage: raw }),
    ]);
    const protocol = new FakeProtocol();
    const runtime = new PiRuntimeManager({
      protocol,
      credentialStore: new InMemoryCredentialStore(),
      redactor: new SecretRedactor(),
      provider: faux.provider,
      allowedProviderId: "faux-runtime",
    });
    runtime.startSession(sessionRequest(faux, false), "session-1");
    runtime.startTurn({
      turn_id: `turn-${code}`,
      input: [{ kind: "text", text: "fail safely" }],
      output_schema: null,
      output_token_budget: null,
    });
    await runtime.waitForIdle();

    expect(protocol.events.filter((event) => event.event === "runtime_error")).toEqual([
      expect.objectContaining({ event: "runtime_error", code, retryable }),
    ]);
    expect(protocol.events.filter((event) => event.event === "turn_completed")).toEqual([
      expect.objectContaining({ event: "turn_completed", stop_reason: "error" }),
    ]);
    const publicProjection = `${JSON.stringify(protocol.events)}\n${JSON.stringify(runtime.snapshot())}\n${formatFatalError(
      new Error(raw),
    )}`;
    for (const secret of secrets) expect(publicProjection).not.toContain(secret);
    expect(publicProjection).not.toContain("provider.invalid");
  });

  it("advertises and accepts Pi's max thinking level when the selected model supports it", async () => {
    const runtime = new PiRuntimeManager({
      protocol: new FakeProtocol(),
      credentialStore: new InMemoryCredentialStore(),
      redactor: new SecretRedactor(),
    });
    const model = runtime.listModels().find((candidate) => candidate.thinking_levels.includes("max"));
    expect(model).toBeDefined();
    expect(
      runtime.startSession(
        {
          session_id: "session-max",
          run_id: "run-max",
          agent_id: "worker-max",
          attempt: 1,
          model: {
            provider: "openai-codex",
            model: model?.id ?? "missing",
            thinking_level: "max",
            input_capabilities: model?.input ?? [],
            context_window: model?.context_window ?? null,
          },
          instructions: "Use compiler-owned tools only.",
          tools: [],
          credential_lease: "lease-max",
        },
        "session-max",
      ),
    ).toMatchObject({ kind: "session_started", session: { provider: "openai-codex" } });
    expect(() =>
      runtime.startTurn({
        turn_id: "turn-too-small",
        input: [{ kind: "text", text: "must fail before acceptance" }],
        output_schema: null,
        output_token_budget: 15,
      }),
    ).toThrow("must be at least 16");
    await runtime.shutdown();
  });

  it("uses the direct Pi agent with compiler-brokered tools and normalized events", async () => {
    const faux = fauxProvider({ provider: "faux-runtime" });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("record_note", { note: "bounded" }, { id: "tool-1" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done"),
    ]);
    const protocol = new FakeProtocol({ status: "success", value: { receipt: "receipt-1" } });
    const runtime = new PiRuntimeManager({
      protocol,
      credentialStore: new InMemoryCredentialStore(),
      redactor: new SecretRedactor(),
      provider: faux.provider,
      allowedProviderId: "faux-runtime",
    });

    expect(runtime.startSession(sessionRequest(faux), "session-1")).toMatchObject({
      kind: "session_started",
      session: { runtime: "pi-sdk", provider: "faux-runtime" },
    });
    expect(
      runtime.startTurn({
        turn_id: "turn-1",
        input: [{ kind: "text", text: "work" }],
        output_schema: null,
        output_token_budget: null,
      }),
    ).toEqual({ kind: "accepted" });
    await runtime.waitForIdle();

    expect(protocol.calls).toEqual([
      { call_id: "tool-1", name: "record_note", arguments: { note: "bounded" } },
    ]);
    expect(protocol.events.some((event) => event.event === "tool_started")).toBe(true);
    expect(protocol.events.some((event) => event.event === "tool_completed")).toBe(true);
    expect(protocol.events.filter((event) => event.event === "usage")).toHaveLength(2);
    expect(protocol.events.at(-1)).toMatchObject({
      event: "turn_completed",
      turn_id: "turn-1",
      stop_reason: "stop",
    });
  });

  it("admits the compiler-bounded worst-case write argument below the public frame ceiling", () => {
    const content = "\"\\\n\t".repeat((384 * 1024) / 4);
    const arguments_ = {
      path: "src/lib.rs",
      expected_sha256: `sha256:${"a".repeat(64)}`,
      content,
    };
    const encodedBytes = Buffer.byteLength(JSON.stringify(arguments_), "utf8");
    expect(encodedBytes).toBeGreaterThan(640 * 1024);
    expect(encodedBytes).toBeLessThan(MAX_BROKER_TOOL_ARGUMENT_JSON_BYTES);
    expect(toolArgumentsFitPublicFrame(arguments_)).toBe(true);
  });

  it("rejects pathologically escaped tool arguments locally before broker dispatch", async () => {
    const pathological = '"\\\u0001'.repeat(220_000);
    expect(Buffer.byteLength(JSON.stringify({ note: pathological }), "utf8")).toBeGreaterThan(
      MAX_BROKER_TOOL_ARGUMENT_JSON_BYTES,
    );
    expect(toolArgumentsFitPublicFrame({ note: pathological })).toBe(false);

    const faux = fauxProvider({ provider: "faux-runtime" });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("record_note", { note: pathological }, { id: "tool-oversized" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(fauxToolCall("record_note", { note: "bounded retry" }, { id: "tool-retry" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done"),
    ]);
    const protocol = new FakeProtocol();
    const runtime = new PiRuntimeManager({
      protocol,
      credentialStore: new InMemoryCredentialStore(),
      redactor: new SecretRedactor(),
      provider: faux.provider,
      allowedProviderId: "faux-runtime",
    });
    runtime.startSession(sessionRequest(faux), "session-1");
    runtime.startTurn({
      turn_id: "turn-oversized-tool",
      input: [{ kind: "text", text: "work" }],
      output_schema: null,
      output_token_budget: null,
    });
    await runtime.waitForIdle();

    expect(protocol.calls.map((call) => call.call_id)).toEqual(["tool-retry"]);
    expect(protocol.events).toContainEqual(
      expect.objectContaining({
        event: "tool_rejected",
        call_id: "tool-oversized",
        code: "pi_tool_arguments_too_large",
      }),
    );
    expect(protocol.events.at(-1)).toMatchObject({ event: "turn_completed", stop_reason: "stop" });
  });

  it("honors a compiler terminating outcome without making another model request", async () => {
    const faux = fauxProvider({ provider: "faux-runtime" });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("record_note", { note: "final" }, { id: "tool-final" }), {
        stopReason: "toolUse",
      }),
    ]);
    const protocol = new FakeProtocol({ status: "terminate", value: { accepted: true } });
    const runtime = new PiRuntimeManager({
      protocol,
      credentialStore: new InMemoryCredentialStore(),
      redactor: new SecretRedactor(),
      provider: faux.provider,
      allowedProviderId: "faux-runtime",
    });
    runtime.startSession(sessionRequest(faux), "session-1");
    runtime.startTurn({
      turn_id: "turn-final",
      input: [{ kind: "text", text: "finish" }],
      output_schema: null,
      output_token_budget: null,
    });
    await runtime.waitForIdle();

    expect(faux.state.callCount).toBe(1);
    const snapshot = runtime.snapshot() as { messages: AgentMessage[] };
    expect(snapshot.messages.at(-1)?.role).toBe("toolResult");
  });

  it("treats a non-retryable compiler tool error as a terminal boundary", async () => {
    const faux = fauxProvider({ provider: "faux-runtime" });
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("record_note", { note: "must stop" }, { id: "tool-stop" }),
          fauxToolCall("record_note", { note: "must not run" }, { id: "tool-late" }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("must not request another model turn"),
    ]);
    const protocol = new FakeProtocol({
      status: "error",
      code: "internal_stop",
      message: "Stop and inspect the compiler-owned diagnostics.",
      retryable: false,
    });
    const runtime = new PiRuntimeManager({
      protocol,
      credentialStore: new InMemoryCredentialStore(),
      redactor: new SecretRedactor(),
      provider: faux.provider,
      allowedProviderId: "faux-runtime",
    });
    runtime.startSession(sessionRequest(faux), "session-1");
    runtime.startTurn({
      turn_id: "turn-non-retryable-tool-error",
      input: [{ kind: "text", text: "stop at the compiler boundary" }],
      output_schema: null,
      output_token_budget: null,
    });
    await runtime.waitForIdle();

    expect(protocol.calls.map((call) => call.call_id)).toEqual(["tool-stop"]);
    expect(faux.state.callCount).toBe(1);
    expect(protocol.events.filter((event) => event.event === "turn_completed")).toHaveLength(1);
  });

  it("skips stale sibling calls after a retryable error and lets the model correct once", async () => {
    const faux = fauxProvider({ provider: "faux-runtime" });
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("record_note", { note: "needs correction" }, { id: "tool-retryable" }),
          fauxToolCall("record_note", { note: "stale sibling one" }, { id: "tool-stale-one" }),
          fauxToolCall("record_note", { note: "stale sibling two" }, { id: "tool-stale-two" }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        fauxToolCall("record_note", { note: "informed correction" }, { id: "tool-corrected" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("done"),
    ]);
    const protocol = new FakeProtocol((call) =>
      call.call_id === "tool-retryable"
        ? {
            status: "error",
            code: "file_scope_retry",
            message: "Use one exact issued path.",
            retryable: true,
          }
        : { status: "success", value: { accepted: true } },
    );
    const runtime = new PiRuntimeManager({
      protocol,
      credentialStore: new InMemoryCredentialStore(),
      redactor: new SecretRedactor(),
      provider: faux.provider,
      allowedProviderId: "faux-runtime",
    });
    runtime.startSession(sessionRequest(faux), "session-1");
    runtime.startTurn({
      turn_id: "turn-retryable-tool-batch",
      input: [{ kind: "text", text: "correct the compiler-scoped call" }],
      output_schema: null,
      output_token_budget: null,
    });
    await runtime.waitForIdle();

    expect(protocol.calls.map((call) => call.call_id)).toEqual(["tool-retryable", "tool-corrected"]);
    expect(faux.state.callCount).toBe(3);
    expect(
      protocol.events
        .filter((event) => event.event === "tool_rejected")
        .map((event) => ("call_id" in event ? event.call_id : undefined)),
    ).toEqual(["tool-stale-one", "tool-stale-two"]);
    expect(
      protocol.events
        .filter((event) => event.event === "tool_rejected")
        .every((event) => "code" in event && event.code === "pi_tool_stale_after_retryable_error"),
    ).toBe(true);
    expect(protocol.events.at(-1)).toMatchObject({ event: "turn_completed", stop_reason: "stop" });
  });

  it("makes a successful full context result an observation boundary before product work", async () => {
    const faux = fauxProvider({ provider: "faux-runtime" });
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("context", {}, { id: "tool-context" }),
          fauxToolCall("read_file", { path: "src/product.ts" }, { id: "tool-stale-product" }),
        ],
        { stopReason: "toolUse" },
      ),
      (context) => {
        expect(JSON.stringify(context.messages)).toContain("complete compiler context");
        return fauxAssistantMessage(
          fauxToolCall("read_file", { path: "src/product.ts" }, { id: "tool-informed-product" }),
          { stopReason: "toolUse" },
        );
      },
      fauxAssistantMessage("done"),
    ]);
    const protocol = new FakeProtocol((call) =>
      call.name === "context"
        ? { status: "success", value: { document: "complete compiler context" } }
        : { status: "success", value: { path: "src/product.ts", content: "ready", eof: true } },
    );
    const runtime = new PiRuntimeManager({
      protocol,
      credentialStore: new InMemoryCredentialStore(),
      redactor: new SecretRedactor(),
      provider: faux.provider,
      allowedProviderId: "faux-runtime",
    });
    runtime.startSession(contextSessionRequest(faux), "session-1");
    runtime.startTurn({
      turn_id: "turn-context-observation",
      input: [{ kind: "text", text: "read context before product work" }],
      output_schema: null,
      output_token_budget: null,
    });
    await runtime.waitForIdle();

    expect(protocol.calls.map((call) => call.call_id)).toEqual([
      "tool-context",
      "tool-informed-product",
    ]);
    expect(
      protocol.events
        .filter((event) => event.event === "tool_rejected")
        .map((event) => ("code" in event ? event.code : undefined)),
    ).toEqual(["pi_tool_stale_after_context_delivery"]);
    expect(faux.state.callCount).toBe(3);
  });

  it("preserves policy-absent context plus product siblings and never latches a Lead", async () => {
    const faux = fauxProvider({ provider: "faux-runtime" });
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("context", {}, { id: "legacy-context" }),
          fauxToolCall("read_file", { path: "src/product.ts" }, { id: "legacy-product" }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("done"),
    ]);
    const protocol = new FakeProtocol((call) =>
      call.name === "context"
        ? { status: "success", value: { document: "legacy context" } }
        : { status: "success", value: { path: "src/product.ts", content: "ready", eof: true } },
    );
    const runtime = new PiRuntimeManager({
      protocol,
      credentialStore: new InMemoryCredentialStore(),
      redactor: new SecretRedactor(),
      provider: faux.provider,
      allowedProviderId: "faux-runtime",
    });
    const legacy = contextSessionRequest(faux);
    delete legacy.context_completion_required;
    runtime.startSession(legacy, "session-1");
    runtime.startTurn({
      turn_id: "turn-legacy-context",
      input: [{ kind: "text", text: "preserve the historical tool batch" }],
      output_schema: null,
      output_token_budget: null,
    });
    await runtime.waitForIdle();
    expect(protocol.calls.map((call) => call.call_id)).toEqual(["legacy-context", "legacy-product"]);
    expect(
      protocol.events.filter(
        (event) => event.event === "tool_rejected" && "code" in event && event.code.includes("context"),
      ),
    ).toEqual([]);

    const leadFaux = fauxProvider({ provider: "faux-runtime" });
    leadFaux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("record_note", { note: "lead first" }, { id: "lead-first" }),
          fauxToolCall("record_note", { note: "lead second" }, { id: "lead-second" }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("done"),
    ]);
    const leadProtocol = new FakeProtocol();
    const leadRuntime = new PiRuntimeManager({
      protocol: leadProtocol,
      credentialStore: new InMemoryCredentialStore(),
      redactor: new SecretRedactor(),
      provider: leadFaux.provider,
      allowedProviderId: "faux-runtime",
    });
    leadRuntime.startSession(sessionRequest(leadFaux), "session-1");
    leadRuntime.startTurn({
      turn_id: "turn-lead-no-context-policy",
      input: [{ kind: "text", text: "run one bounded Lead batch" }],
      output_schema: null,
      output_token_budget: null,
    });
    await leadRuntime.waitForIdle();
    expect(leadProtocol.calls.map((call) => call.call_id)).toEqual(["lead-first", "lead-second"]);
  });

  it("rejects repeated context locally without rewinding a policy-enabled cursor", async () => {
    const faux = fauxProvider({ provider: "faux-runtime" });
    const contextPath = "/compiler/context.md";
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("context", {}, { id: "context-first" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(fauxToolCall("context", {}, { id: "context-repeat" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(
        fauxToolCall(
          "read_file",
          { path: contextPath, offset: 32768, max_bytes: 32768 },
          { id: "context-page" },
        ),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("done"),
    ]);
    const protocol = new FakeProtocol((call) =>
      call.name === "context"
        ? {
            status: "success",
            value: {
              status: "paged",
              document: "preview",
              document_path: contextPath,
              next_offset: 32768,
              eof: false,
            },
          }
        : {
            status: "success",
            value: {
              path: contextPath,
              offset: 32768,
              next_offset: 65536,
              eof: false,
            },
          },
    );
    const runtime = new PiRuntimeManager({
      protocol,
      credentialStore: new InMemoryCredentialStore(),
      redactor: new SecretRedactor(),
      provider: faux.provider,
      allowedProviderId: "faux-runtime",
    });
    runtime.startSession(contextSessionRequest(faux), "session-1");
    runtime.startTurn({
      turn_id: "turn-one-shot-context",
      input: [{ kind: "text", text: "do not rewind compiler context" }],
      output_schema: null,
      output_token_budget: null,
    });
    await runtime.waitForIdle();
    expect(protocol.calls.map((call) => call.call_id)).toEqual(["context-first", "context-page"]);
    expect(
      protocol.events
        .filter((event) => event.event === "tool_rejected")
        .map((event) => ("code" in event ? event.code : undefined)),
    ).toContain("pi_tool_context_already_issued");
  });

  it("terminates a policy-enabled session after a second repeated context call", async () => {
    const faux = fauxProvider({ provider: "faux-runtime" });
    const contextPath = "/compiler/context.md";
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("context", {}, { id: "context-first" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(fauxToolCall("context", {}, { id: "context-repeat-one" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(fauxToolCall("context", {}, { id: "context-repeat-two" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("must not request another provider turn"),
    ]);
    const protocol = new FakeProtocol({
      status: "success",
      value: {
        status: "paged",
        document: "preview",
        document_path: contextPath,
        next_offset: 32768,
        eof: false,
      },
    });
    const runtime = new PiRuntimeManager({
      protocol,
      credentialStore: new InMemoryCredentialStore(),
      redactor: new SecretRedactor(),
      provider: faux.provider,
      allowedProviderId: "faux-runtime",
    });
    runtime.startSession(contextSessionRequest(faux), "session-1");
    runtime.startTurn({
      turn_id: "turn-context-repeat-limit",
      input: [{ kind: "text", text: "stop after one context correction" }],
      output_schema: null,
      output_token_budget: null,
    });
    await runtime.waitForIdle();

    expect(protocol.calls.map((call) => call.call_id)).toEqual(["context-first"]);
    expect(faux.state.callCount).toBe(3);
    expect(
      protocol.events.filter(
        (event) => event.event === "tool_rejected" && "code" in event && event.code === "pi_tool_context_already_issued",
      ),
    ).toHaveLength(2);
    expect(protocol.events.filter((event) => event.event === "turn_completed")).toHaveLength(1);
  });

  it("makes every paged context continuation including EOF an observation boundary", async () => {
    const faux = fauxProvider({ provider: "faux-runtime" });
    const contextPath = "/compiler/context.md";
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("context", {}, { id: "tool-context-paged" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(
        [
          fauxToolCall(
            "read_file",
            { path: contextPath, offset: 32768, max_bytes: 32768 },
            { id: "tool-context-middle" },
          ),
          fauxToolCall("read_file", { path: "src/product.ts" }, { id: "tool-stale-middle" }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        [
          fauxToolCall(
            "read_file",
            { path: contextPath, offset: 65536, max_bytes: 32768 },
            { id: "tool-context-eof" },
          ),
          fauxToolCall("read_file", { path: "src/product.ts" }, { id: "tool-stale-after-eof" }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        fauxToolCall("read_file", { path: "src/product.ts" }, { id: "tool-product-after-observation" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("done"),
    ]);
    const protocol = new FakeProtocol((call) => {
      if (call.name === "context") {
        return {
          status: "success",
          value: {
            status: "paged",
            document: "preview",
            document_path: contextPath,
            next_offset: 32768,
            eof: false,
          },
        };
      }
      const arguments_ = call.arguments as { path: string; offset?: number };
      if (arguments_.path === contextPath && arguments_.offset === 32768) {
        return {
          status: "success",
          value: { path: contextPath, offset: 32768, next_offset: 65536, eof: false },
        };
      }
      if (arguments_.path === contextPath && arguments_.offset === 65536) {
        return {
          status: "success",
          value: { path: contextPath, offset: 65536, next_offset: 70000, eof: true },
        };
      }
      return { status: "success", value: { path: "src/product.ts", content: "ready", eof: true } };
    });
    const runtime = new PiRuntimeManager({
      protocol,
      credentialStore: new InMemoryCredentialStore(),
      redactor: new SecretRedactor(),
      provider: faux.provider,
      allowedProviderId: "faux-runtime",
    });
    runtime.startSession(contextSessionRequest(faux), "session-1");
    runtime.startTurn({
      turn_id: "turn-paged-context-observation",
      input: [{ kind: "text", text: "observe every context page" }],
      output_schema: null,
      output_token_budget: null,
    });
    await runtime.waitForIdle();

    expect(protocol.calls.map((call) => call.call_id)).toEqual([
      "tool-context-paged",
      "tool-context-middle",
      "tool-context-eof",
      "tool-product-after-observation",
    ]);
    expect(
      protocol.events
        .filter((event) => event.event === "tool_rejected")
        .map((event) => ("code" in event ? event.code : undefined)),
    ).toEqual([
      "pi_tool_stale_after_context_delivery",
      "pi_tool_stale_after_context_delivery",
    ]);
    expect(faux.state.callCount).toBe(5);
  });

  it.each([
    {
      name: "terminal tool first",
      toolCalls: [
        fauxToolCall("record_note", { note: "terminal" }, { id: "tool-terminal" }),
        fauxToolCall("record_note", { note: "must-not-run" }, { id: "tool-late" }),
      ],
      expectedBrokerCalls: ["tool-terminal"],
    },
    {
      name: "terminal tool after a normal tool",
      toolCalls: [
        fauxToolCall("record_note", { note: "normal" }, { id: "tool-normal" }),
        fauxToolCall("record_note", { note: "terminal" }, { id: "tool-terminal" }),
      ],
      expectedBrokerCalls: ["tool-normal", "tool-terminal"],
    },
  ])("latches the first terminating outcome in a mixed batch ($name)", async ({ toolCalls, expectedBrokerCalls }) => {
    const faux = fauxProvider({ provider: "faux-runtime" });
    faux.setResponses([fauxAssistantMessage(toolCalls, { stopReason: "toolUse" })]);
    const protocol = new FakeProtocol((call) =>
      call.call_id === "tool-terminal"
        ? { status: "terminate", value: { accepted: true } }
        : { status: "success", value: { accepted: true } },
    );
    const runtime = new PiRuntimeManager({
      protocol,
      credentialStore: new InMemoryCredentialStore(),
      redactor: new SecretRedactor(),
      provider: faux.provider,
      allowedProviderId: "faux-runtime",
    });
    runtime.startSession(sessionRequest(faux), "session-1");
    runtime.startTurn({
      turn_id: "turn-mixed-terminal",
      input: [{ kind: "text", text: "finish with the compiler" }],
      output_schema: null,
      output_token_budget: null,
    });
    await runtime.waitForIdle();

    expect(protocol.calls.map((call) => call.call_id)).toEqual(expectedBrokerCalls);
    expect(faux.state.callCount).toBe(1);
    const terminalToolEvent = protocol.events.findIndex(
      (event) => event.event === "tool_completed" && event.call_id === "tool-terminal",
    );
    expect(terminalToolEvent).toBeGreaterThanOrEqual(0);
    expect(
      protocol.events.slice(terminalToolEvent + 1).filter((event) => event.event !== "turn_completed"),
    ).toEqual([]);
    expect(protocol.events.filter((event) => event.event === "turn_completed")).toHaveLength(1);
  });

  it.each([
    {
      name: "schema-invalid arguments",
      firstResponse: fauxAssistantMessage(
        fauxToolCall("record_note", {}, { id: "tool-invalid" }),
        { stopReason: "toolUse" },
      ),
      expectedCode: "pi_tool_validation",
      callId: "tool-invalid",
    },
    {
      name: "truncated tool arguments",
      firstResponse: fauxAssistantMessage(
        fauxToolCall("record_note", { note: "cut off" }, { id: "tool-truncated" }),
        { stopReason: "length" },
      ),
      expectedCode: "pi_tool_truncated",
      callId: "tool-truncated",
    },
  ])("reports $name as a host-local rejection without a compiler result", async ({
    firstResponse,
    expectedCode,
    callId,
  }) => {
    const faux = fauxProvider({ provider: "faux-runtime" });
    faux.setResponses([firstResponse, fauxAssistantMessage("recovered without broker dispatch")]);
    const protocol = new FakeProtocol();
    const runtime = new PiRuntimeManager({
      protocol,
      credentialStore: new InMemoryCredentialStore(),
      redactor: new SecretRedactor(),
      provider: faux.provider,
      allowedProviderId: "faux-runtime",
    });
    runtime.startSession(sessionRequest(faux), "session-1");
    runtime.startTurn({
      turn_id: "turn-local-tool-rejection",
      input: [{ kind: "text", text: "attempt a tool call" }],
      output_schema: null,
      output_token_budget: null,
    });
    await runtime.waitForIdle();

    expect(faux.state.callCount).toBe(2);
    expect(protocol.calls).toEqual([]);
    expect(protocol.events.filter((event) => event.event === "tool_completed")).toEqual([]);
    expect(protocol.events.filter((event) => event.event === "tool_rejected")).toEqual([
      {
        event: "tool_rejected",
        turn_id: "turn-local-tool-rejection",
        call_id: callId,
        name: "record_note",
        code: expectedCode,
        message:
          expectedCode === "pi_tool_truncated"
            ? "Pi rejected a tool call because its model response was truncated"
            : "Pi rejected a tool call before compiler dispatch",
      },
    ]);
    expect(
      protocol.events.filter((event) => event.event === "message_completed" && event.role === "toolResult"),
    ).toEqual([]);
    expect(protocol.events.at(-1)).toMatchObject({ event: "turn_completed", stop_reason: "stop" });
  });

  it("queues steering while exposing no ambient Pi tools or resources", async () => {
    const faux = fauxProvider({ provider: "faux-runtime" });
    faux.setResponses([
      (context) => {
        expect(context.tools ?? []).toEqual([]);
        expect(context.messages.filter((message) => message.role === "user")).toHaveLength(2);
        return fauxAssistantMessage("first");
      },
    ]);
    const store = new InMemoryCredentialStore();
    const runtime = new PiRuntimeManager({
      protocol: new FakeProtocol(),
      credentialStore: store,
      redactor: new SecretRedactor(),
      provider: faux.provider,
      allowedProviderId: "faux-runtime",
    });
    runtime.startSession(sessionRequest(faux, false), "session-1");
    runtime.startTurn({
      turn_id: "turn-steer",
      input: [{ kind: "text", text: "begin" }],
      output_schema: null,
      output_token_budget: null,
    });
    runtime.control({ control: "steer", text: "change direction" });
    await runtime.waitForIdle();
    expect(faux.state.callCount).toBe(1);
  });

  it("drops a deferred control side effect when its captured turn finishes before the response", async () => {
    const faux = fauxProvider({ provider: "faux-runtime" });
    faux.setResponses([fauxAssistantMessage("first turn finished")]);
    const runtime = new PiRuntimeManager({
      protocol: new FakeProtocol(),
      credentialStore: new InMemoryCredentialStore(),
      redactor: new SecretRedactor(),
      provider: faux.provider,
      allowedProviderId: "faux-runtime",
    });
    runtime.startSession(sessionRequest(faux, false), "session-1");
    runtime.startTurn({
      turn_id: "turn-before-blocked-control",
      input: [{ kind: "text", text: "finish while the control response is blocked" }],
      output_schema: null,
      output_token_budget: null,
    });
    const deferred = runtime.prepareControl({ control: "steer", text: "stale steering must not leak" });
    await runtime.waitForIdle();

    // Models dispatchRequest waiting on a backpressured response write. The ACK
    // eventually succeeds, but its turn-bound side effect is now intentionally inert.
    deferred.afterResponse();
    faux.setResponses([
      (context) => {
        expect(JSON.stringify(context.messages)).not.toContain("stale steering must not leak");
        return fauxAssistantMessage("second turn stayed clean");
      },
    ]);
    runtime.startTurn({
      turn_id: "turn-after-blocked-control",
      input: [{ kind: "text", text: "start the next turn" }],
      output_schema: null,
      output_token_budget: null,
    });
    await runtime.waitForIdle();
    expect(faux.state.callCount).toBe(2);
  });

  it("drains the per-session event chain before publishing turn completion", async () => {
    const faux = fauxProvider({ provider: "faux-runtime" });
    faux.setResponses([fauxAssistantMessage("ordered")]);
    const events: RuntimeEvent[] = [];
    let messageBlocked = false;
    let releaseMessage: () => void = () => {};
    const messageGate = new Promise<void>((resolve) => {
      releaseMessage = resolve;
    });
    const protocol = {
      executeTool: async () => ({ status: "success" as const, value: {} }),
      sendEvent: async (event: RuntimeEvent) => {
        events.push(event);
        if (event.event === "message_completed" && event.role === "assistant") {
          messageBlocked = true;
          await messageGate;
        }
      },
    };
    const runtime = new PiRuntimeManager({
      protocol,
      credentialStore: new InMemoryCredentialStore(),
      redactor: new SecretRedactor(),
      provider: faux.provider,
      allowedProviderId: "faux-runtime",
    });
    runtime.startSession(sessionRequest(faux, false), "session-1");
    runtime.startTurn({
      turn_id: "turn-order",
      input: [{ kind: "text", text: "go" }],
      output_schema: null,
      output_token_budget: null,
    });
    const deadline = Date.now() + 1_000;
    while (!messageBlocked && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(messageBlocked).toBe(true);
    expect(events.some((event) => event.event === "turn_completed")).toBe(false);
    releaseMessage();
    await runtime.waitForIdle();
    expect(events.at(-1)?.event).toBe("turn_completed");
    expect(events.some((event) => event.event === "message_delta")).toBe(false);
  });

  it("passes the remaining cumulative output-token budget to every provider request", async () => {
    const faux = fauxProvider({ provider: "faux-runtime" });
    faux.setResponses([
      (_context, options) => {
        expect(options?.maxTokens).toBe(200);
        return fauxAssistantMessage(fauxToolCall("record_note", { note: "continue" }, { id: "budget-tool" }), {
          stopReason: "toolUse",
        });
      },
      (context, options) => {
        const priorOutput = context.messages
          .filter(
            (message): message is Extract<AgentMessage, { role: "assistant" }> => message.role === "assistant",
          )
          .reduce((total, message) => total + message.usage.output, 0);
        expect(options?.maxTokens).toBe(200 - priorOutput);
        return fauxAssistantMessage("bounded");
      },
    ]);
    const runtime = new PiRuntimeManager({
      protocol: new FakeProtocol({ status: "success", value: { accepted: true } }),
      credentialStore: new InMemoryCredentialStore(),
      redactor: new SecretRedactor(),
      provider: faux.provider,
      allowedProviderId: "faux-runtime",
    });
    runtime.startSession(sessionRequest(faux), "session-1");
    runtime.startTurn({
      turn_id: "turn-budget",
      input: [{ kind: "text", text: "bounded request" }],
      output_schema: null,
      output_token_budget: 200,
    });
    await runtime.waitForIdle();
    expect(faux.state.callCount).toBe(2);
  });

  it("stops before a second Codex request when only 1..15 output tokens remain", async () => {
    const faux = fauxProvider({ provider: "openai-codex", api: "openai-codex-responses" });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("record_note", { note: "continue" }, { id: "budget-floor-tool" }), {
        stopReason: "toolUse",
      }),
    ]);
    const protocol = new FakeProtocol({ status: "success", value: { accepted: true } });
    const runtime = new PiRuntimeManager({
      protocol,
      credentialStore: new InMemoryCredentialStore(),
      redactor: new SecretRedactor(),
      provider: faux.provider,
    });
    runtime.startSession(sessionRequest(faux), "session-1");
    runtime.startTurn({
      turn_id: "turn-codex-budget-floor",
      input: [{ kind: "text", text: "use one tool and then stop at the provider minimum" }],
      output_schema: null,
      output_token_budget: 20,
    });
    await runtime.waitForIdle();

    expect(faux.state.callCount).toBe(1);
    expect(protocol.calls.map((call) => call.call_id)).toEqual(["budget-floor-tool"]);
    const usage = protocol.events.find((event) => event.event === "usage");
    expect(usage?.event === "usage" ? usage.usage.output_tokens : 0).toBeGreaterThan(4);
    expect(usage?.event === "usage" ? 20 - usage.usage.output_tokens : 20).toBeLessThan(16);
    expect(protocol.events.at(-1)).toMatchObject({
      event: "turn_completed",
      stop_reason: "output_token_budget",
    });
  });

  it("keeps the unsupported max_output_tokens field out of ChatGPT Codex payloads", async () => {
    const codex = koniOpenAICodexProvider();
    let serializedPayload: unknown;
    const provider = createProvider<"openai-codex-responses">({
      id: codex.id,
      name: codex.name,
      ...(codex.baseUrl === undefined ? {} : { baseUrl: codex.baseUrl }),
      auth: codex.auth,
      models: codex.getModels(),
      api: {
        stream: (model, context, options) =>
          codex.stream(model as Model<"openai-codex-responses">, context, {
            ...options,
            onPayload: async (payload, payloadModel) => {
              serializedPayload = (await options?.onPayload?.(payload, payloadModel)) ?? payload;
              throw new Error("captured bounded Codex request before network dispatch");
            },
          }),
        streamSimple: (model, context, options) =>
          codex.streamSimple(model as Model<"openai-codex-responses">, context, {
            ...options,
            onPayload: async (payload, payloadModel) => {
              serializedPayload = (await options?.onPayload?.(payload, payloadModel)) ?? payload;
              throw new Error("captured bounded Codex request before network dispatch");
            },
          }),
      },
    });
    const credentialStore = new InMemoryCredentialStore();
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-test" } }),
    ).toString("base64url");
    await credentialStore.modify("openai-codex", async () => ({
      type: "oauth",
      access: `${header}.${payload}.signature`,
      refresh: "private-test-refresh",
      expires: Date.now() + 60_000,
    }));
    const runtime = new PiRuntimeManager({
      protocol: new FakeProtocol(),
      credentialStore,
      redactor: new SecretRedactor(),
      provider,
    });
    const model = runtime.listModels()[0];
    expect(model).toBeDefined();
    runtime.startSession(
      {
        session_id: "session-codex-payload",
        run_id: "run-codex-payload",
        agent_id: "worker-codex-payload",
        attempt: 1,
        model: {
          provider: "openai-codex",
          model: model?.id ?? "missing",
          thinking_level: "off",
          input_capabilities: model?.input ?? [],
          context_window: model?.context_window ?? null,
        },
        instructions: "No ambient resources.",
        tools: [],
        credential_lease: "lease-codex-payload",
      },
      "session-codex-payload",
    );
    runtime.startTurn({
      turn_id: "turn-codex-payload",
      input: [{ kind: "text", text: "bounded request" }],
      output_schema: null,
      output_token_budget: 23,
    });
    await runtime.waitForIdle();

    expect(serializedPayload).toMatchObject({ model: model?.id });
    expect(serializedPayload).not.toHaveProperty("max_output_tokens");
  });

  it("preserves the completed message and exact usage when a provider overruns the output cap", async () => {
    const faux = fauxProvider({ provider: "faux-runtime" });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("record_note", { note: "continue" }, { id: "budget-first" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("x".repeat(400)),
    ]);
    const protocol = new FakeProtocol({ status: "success", value: { accepted: true } });
    const runtime = new PiRuntimeManager({
      protocol,
      credentialStore: new InMemoryCredentialStore(),
      redactor: new SecretRedactor(),
      provider: faux.provider,
      allowedProviderId: "faux-runtime",
    });
    runtime.startSession(sessionRequest(faux), "session-1");
    runtime.startTurn({
      turn_id: "turn-output-overrun",
      input: [{ kind: "text", text: "provider ignores the requested output cap" }],
      output_schema: null,
      output_token_budget: 20,
    });
    await runtime.waitForIdle();

    expect(faux.state.callCount).toBe(2);
    expect(protocol.calls.map((call) => call.call_id)).toEqual(["budget-first"]);
    expect(
      protocol.events.filter((event) => event.event === "message_completed" && event.role === "assistant"),
    ).toHaveLength(2);
    const publishedUsage = protocol.events.filter((event) => event.event === "usage");
    expect(publishedUsage).toHaveLength(2);
    expect(protocol.events.filter((event) => event.event === "runtime_error")).toEqual([
      {
        event: "runtime_error",
        turn_id: "turn-output-overrun",
        code: "runtime_output_limit",
        message:
          "The agent response was too large for this run's output allowance. Its transcript was preserved; start a larger run or revise the run-type limits before retrying.",
        retryable: false,
      },
    ]);
    const terminal = protocol.events.filter((event) => event.event === "turn_completed");
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({ stop_reason: "error" });
    const summedUsage = publishedUsage.reduce(
      (total, event) => {
        if (event.event !== "usage") return total;
        return {
          input_tokens: total.input_tokens + event.usage.input_tokens,
          cached_input_tokens: total.cached_input_tokens + event.usage.cached_input_tokens,
          output_tokens: total.output_tokens + event.usage.output_tokens,
          reasoning_tokens: total.reasoning_tokens + event.usage.reasoning_tokens,
          total_tokens: total.total_tokens + event.usage.total_tokens,
        };
      },
      { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, total_tokens: 0 },
    );
    expect(terminal[0]?.event === "turn_completed" ? terminal[0].usage : undefined).toEqual(
      summedUsage,
    );
    expect(terminal[0]?.event === "turn_completed" && terminal[0].usage.output_tokens).toBeGreaterThan(20);
  });

  it("fails malformed provider usage closed and terminates the accepted turn exactly once", async () => {
    const faux = fauxProvider({ provider: "usage-test" });
    const malformed = fauxAssistantMessage("bad usage");
    malformed.usage = {
      ...malformed.usage,
      input: Number.NaN,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 1,
    };
    const streamMalformed = () => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "start", partial: { ...malformed, content: [] } });
        stream.push({ type: "done", reason: "stop", message: malformed });
        stream.end(malformed);
      });
      return stream;
    };
    const provider: Provider = createProvider({
      id: "usage-test",
      auth: faux.provider.auth,
      models: faux.provider.getModels(),
      api: {
        stream: streamMalformed,
        streamSimple: streamMalformed,
      },
    });
    const protocol = new FakeProtocol();
    const runtime = new PiRuntimeManager({
      protocol,
      credentialStore: new InMemoryCredentialStore(),
      redactor: new SecretRedactor(),
      provider,
      allowedProviderId: "usage-test",
    });
    runtime.startSession(sessionRequest(faux, false), "session-1");
    runtime.startTurn({
      turn_id: "turn-usage",
      input: [{ kind: "text", text: "go" }],
      output_schema: null,
      output_token_budget: 100,
    });
    await runtime.waitForIdle();

    expect(protocol.events.filter((event) => event.event === "usage")).toHaveLength(0);
    expect(protocol.events.filter((event) => event.event === "runtime_error")).toHaveLength(1);
    expect(protocol.events.filter((event) => event.event === "turn_completed")).toEqual([
      {
        event: "turn_completed",
        turn_id: "turn-usage",
        stop_reason: "error",
        usage: {
          input_tokens: 0,
          cached_input_tokens: 0,
          output_tokens: 0,
          reasoning_tokens: 0,
          total_tokens: 0,
        },
      },
    ]);
  });

  it("reconciles a listener failure and cancellation with one terminal event each", async () => {
    const faux = fauxProvider({ provider: "faux-runtime" });
    faux.setResponses([fauxAssistantMessage("listener event")]);
    const events: RuntimeEvent[] = [];
    let failed = false;
    const protocol = {
      executeTool: async () => ({ status: "success" as const, value: {} }),
      sendEvent: async (event: RuntimeEvent) => {
        if (!failed && event.event === "message_completed") {
          failed = true;
          throw new Error("synthetic listener failure");
        }
        events.push(event);
      },
    };
    const runtime = new PiRuntimeManager({
      protocol,
      credentialStore: new InMemoryCredentialStore(),
      redactor: new SecretRedactor(),
      provider: faux.provider,
      allowedProviderId: "faux-runtime",
    });
    runtime.startSession(sessionRequest(faux, false), "session-1");
    runtime.startTurn({
      turn_id: "turn-listener",
      input: [{ kind: "text", text: "go" }],
      output_schema: null,
      output_token_budget: null,
    });
    await runtime.waitForIdle();
    expect(events.filter((event) => event.event === "runtime_error")).toHaveLength(1);
    expect(events.filter((event) => event.event === "turn_completed")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ event: "turn_completed", stop_reason: "error" });

    faux.setResponses([fauxAssistantMessage("never requested")]);
    runtime.startTurn({
      turn_id: "turn-cancel",
      input: [{ kind: "text", text: "cancel" }],
      output_schema: null,
      output_token_budget: null,
    });
    runtime.control({ control: "cancel", reason: "operator" });
    await runtime.waitForIdle();
    expect(
      events.filter((event) => event.event === "turn_completed" && event.turn_id === "turn-cancel"),
    ).toEqual([
      expect.objectContaining({ event: "turn_completed", stop_reason: "aborted" }),
    ]);
  });

  it("poisons the session when the terminal event itself cannot be written", async () => {
    const faux = fauxProvider({ provider: "faux-runtime" });
    faux.setResponses([fauxAssistantMessage("terminal write")]);
    const protocol = {
      executeTool: async () => ({ status: "success" as const, value: {} }),
      sendEvent: async (event: RuntimeEvent) => {
        if (event.event === "turn_completed") throw new Error("terminal transport unavailable");
      },
    };
    const runtime = new PiRuntimeManager({
      protocol,
      credentialStore: new InMemoryCredentialStore(),
      redactor: new SecretRedactor(),
      provider: faux.provider,
      allowedProviderId: "faux-runtime",
    });
    runtime.startSession(sessionRequest(faux, false), "session-1");
    runtime.startTurn({
      turn_id: "turn-terminal-write",
      input: [{ kind: "text", text: "go" }],
      output_schema: null,
      output_token_budget: null,
    });
    await expect(runtime.waitForIdle()).rejects.toThrow("terminal transport unavailable");
    expect(() =>
      runtime.startTurn({
        turn_id: "turn-after-fatal",
        input: [{ kind: "text", text: "go again" }],
        output_schema: null,
        output_token_budget: null,
      }),
    ).toThrow("failed before terminal reconciliation");
  });

  it("rejects invalid media before accepting a turn", () => {
    const faux = fauxProvider({ provider: "faux-runtime" });
    const protocol = new FakeProtocol();
    const runtime = new PiRuntimeManager({
      protocol,
      credentialStore: new InMemoryCredentialStore(),
      redactor: new SecretRedactor(),
      provider: faux.provider,
      allowedProviderId: "faux-runtime",
    });
    runtime.startSession(sessionRequest(faux, false), "session-1");
    expect(() =>
      runtime.startTurn({
        turn_id: "turn-invalid-image",
        input: [{ kind: "image", media_type: "image/png", sha256: "0".repeat(64), data_base64: "aA==" }],
        output_schema: null,
        output_token_budget: null,
      }),
    ).toThrow("image sha256 does not match");
    expect(protocol.events).toHaveLength(0);
  });
});

describe("private CredentialStore adapter", () => {
  it("holds a broker transaction through Pi's asynchronous modify callback", async () => {
    let current: OAuthCredential | undefined = {
      type: "oauth",
      access: "original-access-secret",
      refresh: "original-refresh-secret",
      expires: 100,
      accountId: "account-1",
    };
    const calls: string[] = [];
    const client: CredentialClient = {
      read: async () => current,
      beginModify: async () => {
        calls.push("begin");
        return current === undefined
          ? { transactionId: "transaction-1" }
          : { transactionId: "transaction-1", current };
      },
      commitModify: async (_lease, _transaction, credential) => {
        calls.push("commit");
        current = credential;
        return credential;
      },
      abortModify: async () => {
        calls.push("abort");
      },
      delete: async () => {
        calls.push("delete");
        current = undefined;
      },
    };
    const redactor = new SecretRedactor();
    const store = new IpcCredentialStore(client, redactor);
    store.setLease("lease-1");

    const rotated = await store.modify("openai-codex", async (credential) => {
      expect((credential as OAuthCredential).accountId).toBe("account-1");
      return {
        type: "oauth",
        access: "rotated-access-secret",
        refresh: "rotated-refresh-secret",
        expires: 200,
        accountId: "account-1",
      };
    });

    expect(rotated).toEqual(current);
    expect(calls).toEqual(["begin", "commit"]);
    expect(redactor.redact("original-access-secret rotated-refresh-secret")).toBe("[REDACTED] [REDACTED]");
  });
});

describe("OAuth public/private boundary", () => {
  it("proves callback availability with the OS rather than prompt timing", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
    });
    const address = blocker.address() as AddressInfo;
    try {
      await expect(
        assertOAuthCallbackAvailable(undefined, address.address, address.port),
      ).rejects.toThrow(OAUTH_CALLBACK_UNAVAILABLE_MESSAGE);
    } finally {
      await new Promise<void>((resolve, reject) =>
        blocker.close((error) => (error ? reject(error) : resolve())),
      );
    }

    await expect(
      assertOAuthCallbackAvailable(undefined, address.address, address.port),
    ).resolves.toBeUndefined();
  });

  it("fails browser login before Pi starts when the callback is unavailable and then recovers", async () => {
    const faux = fauxProvider({ provider: "oauth-test" });
    let unavailable = true;
    let probeCalls = 0;
    let loginCalls = 0;
    const provider: Provider = createProvider({
      id: "oauth-test",
      auth: {
        oauth: {
          name: "Test OAuth",
          login: async () => {
            loginCalls += 1;
            return {
              type: "oauth",
              access: "recovered-access-secret",
              refresh: "recovered-refresh-secret",
              expires: Date.now() + 60_000,
            };
          },
          refresh: async (credential) => credential,
          toAuth: async (credential) => ({ apiKey: credential.access }),
        },
      },
      models: faux.provider.getModels(),
      api: {
        stream: (model, context, options) => faux.provider.stream(model, context, options),
        streamSimple: (model, context, options) => faux.provider.streamSimple(model, context, options),
      },
    });
    const store = new InMemoryCredentialStore();
    const runtime = new PiRuntimeManager({
      protocol: new FakeProtocol(),
      credentialStore: store,
      redactor: new SecretRedactor(),
      provider,
      allowedProviderId: "oauth-test",
      oauthCallbackProbe: async () => {
        probeCalls += 1;
        if (unavailable) {
          throw new HostError("AUTHENTICATION_FAILED", OAUTH_CALLBACK_UNAVAILABLE_MESSAGE);
        }
      },
    });

    await expect(
      runtime.authenticate("lease", {
        request: "begin_login",
        provider: "open-ai-codex",
        preferred_flow: "browser_pkce",
      }),
    ).rejects.toThrow(OAUTH_CALLBACK_UNAVAILABLE_MESSAGE);
    expect(loginCalls).toBe(0);
    expect(await store.read("oauth-test")).toBeUndefined();

    unavailable = false;
    await expect(
      runtime.authenticate("lease", {
        request: "begin_login",
        provider: "open-ai-codex",
        preferred_flow: "browser_pkce",
      }),
    ).resolves.toMatchObject({ kind: "authentication", response: { response: "login_started" } });
    expect(probeCalls).toBe(2);
    expect(loginCalls).toBe(1);
  });

  it("emits only token-free interactions while persistence stays in CredentialStore", async () => {
    const faux = fauxProvider({ provider: "oauth-test" });
    const provider: Provider = createProvider({
      id: "oauth-test",
      auth: {
        oauth: {
          name: "Test OAuth",
          login: async (callbacks) => {
            expect(await callbacks.prompt({
              type: "select",
              message: "method",
              options: [{ id: "device_code", label: "Device code" }],
            })).toBe("device_code");
            callbacks.notify({
              type: "device_code",
              userCode: "VISIBLE-CODE",
              verificationUri: "https://auth.invalid/device",
            });
            return {
              type: "oauth",
              access: "never-public-access-secret",
              refresh: "never-public-refresh-secret",
              expires: Date.now() + 60_000,
            };
          },
          refresh: async (credential) => credential,
          toAuth: async (credential) => ({ apiKey: credential.access }),
        },
      },
      models: faux.provider.getModels(),
      api: {
        stream: (model, context, options) => faux.provider.stream(model, context, options),
        streamSimple: (model, context, options) => faux.provider.streamSimple(model, context, options),
      },
    });
    const protocol = new FakeProtocol();
    const store = new InMemoryCredentialStore();
    const runtime = new PiRuntimeManager({
      protocol,
      credentialStore: store,
      redactor: new SecretRedactor(),
      provider,
      allowedProviderId: "oauth-test",
    });

    const response = await runtime.authenticate("lease-unused-by-memory-store", {
      request: "begin_login",
      provider: "open-ai-codex",
      preferred_flow: "device_code",
    });

    expect(response).toMatchObject({ kind: "authentication", response: { response: "login_started" } });
    expect((await store.read("oauth-test"))?.type).toBe("oauth");
    expect(protocol.events).toContainEqual({
      event: "authentication",
      interaction: {
        interaction: "device_code",
        user_code: "VISIBLE-CODE",
        verification_uri: "https://auth.invalid/device",
        interval_seconds: null,
        expires_in_seconds: null,
      },
    });
    expect(JSON.stringify(protocol.events)).not.toContain("never-public");
  });

  it("fails closed when Pi does not offer the requested pinned flow id", async () => {
    const faux = fauxProvider({ provider: "oauth-test" });
    const provider: Provider = createProvider({
      id: "oauth-test",
      auth: {
        oauth: {
          name: "Test OAuth",
          login: async (callbacks) => {
            await callbacks.prompt({
              type: "select",
              message: "method",
              options: [{ id: "unexpected-flow", label: "Unexpected" }],
            });
            throw new Error("unreachable");
          },
          refresh: async (credential) => credential,
          toAuth: async (credential) => ({ apiKey: credential.access }),
        },
      },
      models: faux.provider.getModels(),
      api: {
        stream: (model, context, options) => faux.provider.stream(model, context, options),
        streamSimple: (model, context, options) => faux.provider.streamSimple(model, context, options),
      },
    });
    const store = new InMemoryCredentialStore();
    const runtime = new PiRuntimeManager({
      protocol: new FakeProtocol(),
      credentialStore: store,
      redactor: new SecretRedactor(),
      provider,
      allowedProviderId: "oauth-test",
    });

    await expect(
      runtime.authenticate("lease-unused-by-memory-store", {
        request: "begin_login",
        provider: "open-ai-codex",
        preferred_flow: "device_code",
      }),
    ).rejects.toThrow("sign-in did not complete; try signing in again");
    expect(await store.read("oauth-test")).toBeUndefined();
  });

  it("maps malformed OAuth failures to a stable secret-free error and stderr line", async () => {
    const faux = fauxProvider({ provider: "oauth-test" });
    const secrets = [
      "access-secret-value",
      "refresh-secret-value",
      "authorization-secret-value",
      "verifier-secret-value",
      "device-secret-value",
    ];
    const upstream = new Error(
      JSON.stringify({
        access_token: secrets[0],
        refresh_token: secrets[1],
        authorization_code: secrets[2],
        code_verifier: secrets[3],
        device_auth_id: secrets[4],
      }),
    );
    const provider: Provider = createProvider({
      id: "oauth-test",
      auth: {
        oauth: {
          name: "Test OAuth",
          login: async (callbacks) => {
            callbacks.notify({ type: "progress", message: upstream.message });
            throw upstream;
          },
          refresh: async (credential) => credential,
          toAuth: async (credential) => ({ apiKey: credential.access }),
        },
      },
      models: faux.provider.getModels(),
      api: {
        stream: (model, context, options) => faux.provider.stream(model, context, options),
        streamSimple: (model, context, options) => faux.provider.streamSimple(model, context, options),
      },
    });
    const protocol = new FakeProtocol();
    const redactor = new SecretRedactor();
    const runtime = new PiRuntimeManager({
      protocol,
      credentialStore: new InMemoryCredentialStore(),
      redactor,
      provider,
      allowedProviderId: "oauth-test",
    });

    let failure: unknown;
    try {
      await runtime.authenticate("lease", {
        request: "begin_login",
        provider: "open-ai-codex",
        preferred_flow: "device_code",
      });
    } catch (error) {
      failure = error;
    }
    expect(String(failure)).toContain("sign-in did not complete");
    const captured = `${String(failure)}\n${JSON.stringify(protocol.events)}\n${formatFatalError(upstream, redactor)}`;
    for (const secret of secrets) expect(captured).not.toContain(secret);
  });

  it("keeps Pi's manual-code alternative pending while browser login wins and bounds an uncooperative login", async () => {
    const faux = fauxProvider({ provider: "oauth-test" });
    let mode: "browser" | "hang" | "success" = "browser";
    const provider: Provider = createProvider({
      id: "oauth-test",
      auth: {
        oauth: {
          name: "Test OAuth",
          login: async (callbacks) => {
            if (mode === "hang") return await new Promise<OAuthCredential>(() => undefined);
            if (mode === "success") {
              return {
                type: "oauth",
                access: "recovered-access-secret",
                refresh: "recovered-refresh-secret",
                expires: Date.now() + 60_000,
              };
            }
            expect(await callbacks.prompt({
              type: "select",
              message: "method",
              options: [{ id: "browser", label: "Browser" }],
            })).toBe("browser");
            const manualAbort = new AbortController();
            let manualPromptSettled = false;
            const manualPrompt = callbacks
              .prompt({ type: "manual_code", message: "paste code", signal: manualAbort.signal })
              .then(
                () => {
                  manualPromptSettled = true;
                  return "resolved";
                },
                () => {
                  manualPromptSettled = true;
                  return "cancelled";
                },
              );
            await Promise.resolve();
            expect(manualPromptSettled).toBe(false);
            callbacks.notify({
              type: "auth_url",
              url: "https://auth.openai.com/oauth/authorize?client_id=test",
            });
            manualAbort.abort();
            expect(await manualPrompt).toBe("cancelled");
            return {
              type: "oauth",
              access: "browser-access-secret",
              refresh: "browser-refresh-secret",
              expires: Date.now() + 60_000,
            };
          },
          refresh: async (credential) => credential,
          toAuth: async (credential) => ({ apiKey: credential.access }),
        },
      },
      models: faux.provider.getModels(),
      api: {
        stream: (model, context, options) => faux.provider.stream(model, context, options),
        streamSimple: (model, context, options) => faux.provider.streamSimple(model, context, options),
      },
    });
    const runtime = new PiRuntimeManager({
      protocol: new FakeProtocol(),
      credentialStore: new InMemoryCredentialStore(),
      redactor: new SecretRedactor(),
      provider,
      allowedProviderId: "oauth-test",
      oauthLoginTimeoutMs: 20,
    });

    await expect(
      runtime.authenticate("lease", {
        request: "begin_login",
        provider: "open-ai-codex",
        preferred_flow: "browser_pkce",
      }),
    ).resolves.toMatchObject({ kind: "authentication", response: { response: "login_started" } });

    mode = "hang";
    await expect(
      runtime.authenticate("lease", {
        request: "begin_login",
        provider: "open-ai-codex",
        preferred_flow: "device_code",
      }),
    ).rejects.toThrow("cancelled or timed out");

    mode = "success";
    await expect(
      runtime.authenticate("lease", {
        request: "begin_login",
        provider: "open-ai-codex",
        preferred_flow: "device_code",
      }),
    ).resolves.toMatchObject({ kind: "authentication", response: { response: "login_started" } });
  });

  it("aborts a pending OAuth provider when the host shuts down", async () => {
    const faux = fauxProvider({ provider: "oauth-test" });
    let providerObservedAbort = false;
    const provider: Provider = createProvider({
      id: "oauth-test",
      auth: {
        oauth: {
          name: "Test OAuth",
          login: async (callbacks) =>
            await new Promise<OAuthCredential>((_resolve, reject) => {
              callbacks.signal?.addEventListener(
                "abort",
                () => {
                  providerObservedAbort = true;
                  reject(new Error("provider cancelled"));
                },
                { once: true },
              );
            }),
          refresh: async (credential) => credential,
          toAuth: async (credential) => ({ apiKey: credential.access }),
        },
      },
      models: faux.provider.getModels(),
      api: {
        stream: (model, context, options) => faux.provider.stream(model, context, options),
        streamSimple: (model, context, options) => faux.provider.streamSimple(model, context, options),
      },
    });
    const runtime = new PiRuntimeManager({
      protocol: new FakeProtocol(),
      credentialStore: new InMemoryCredentialStore(),
      redactor: new SecretRedactor(),
      provider,
      allowedProviderId: "oauth-test",
    });
    const authentication = runtime.authenticate("lease", {
      request: "begin_login",
      provider: "open-ai-codex",
      preferred_flow: "device_code",
    });
    const rejected = expect(authentication).rejects.toThrow("cancelled or timed out");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await runtime.shutdown();
    await rejected;
    expect(providerObservedAbort).toBe(true);
  });
});
