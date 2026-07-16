import { Duplex, PassThrough } from "node:stream";
import {
  InMemoryCredentialStore,
  createProvider,
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { PrivateCredentialChannel } from "../src/credential-channel.js";
import { KoniPiHost } from "../src/host.js";
import { PiProtocolPeer, PROTOCOL_VERSION } from "../src/protocol.js";
import { SecretRedactor } from "../src/redaction.js";
import type { PiFrame } from "../src/wire-types.js";

class OutputCollector {
  readonly messages: PiFrame[] = [];
  private buffer = "";

  constructor(stream: PassThrough) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      this.buffer += chunk;
      let newline = this.buffer.indexOf("\n");
      while (newline >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        this.messages.push(JSON.parse(line) as PiFrame);
        newline = this.buffer.indexOf("\n");
      }
    });
  }

  async waitFor(predicate: (message: PiFrame) => boolean): Promise<PiFrame> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const found = this.messages.find(predicate);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    throw new Error(`timed out; saw ${JSON.stringify(this.messages)}`);
  }
}

function send(stream: PassThrough, frame: PiFrame): void {
  stream.write(`${JSON.stringify(frame)}\n`);
}

describe("Rust-compatible public PiFrame protocol", () => {
  const streams: PassThrough[] = [];
  afterEach(() => {
    for (const stream of streams) stream.destroy();
    streams.length = 0;
  });

  it("uses exact tags and independent monotonic sequences", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    streams.push(input, output);
    const faux = fauxProvider({ provider: "faux-host" });
    const host = new KoniPiHost(input, output, {
      credentialStore: new InMemoryCredentialStore(),
      provider: faux.provider,
      allowedProviderId: "faux-host",
    });
    const collector = new OutputCollector(output);
    const running = host.run();

    send(input, {
      frame: "request",
      protocol_version: PROTOCOL_VERSION,
      session_id: "session-1",
      sequence: 1,
      request_id: "start-1",
      command: {
        command: "start_session",
        request: {
          session_id: "session-1",
          run_id: "run-1",
          agent_id: "agent-1",
          attempt: 1,
          model: {
            provider: "faux-host",
            model: faux.getModel().id,
            thinking_level: "off",
            input_capabilities: ["text"],
            context_window: faux.getModel().contextWindow,
          },
          instructions: "No ambient resources.",
          tools: [],
          credential_lease: "lease-1",
        },
      },
    });
    expect(await collector.waitFor((frame) => frame.frame === "response" && frame.request_id === "start-1")).toMatchObject({
      frame: "response",
      protocol_version: 1,
      session_id: "session-1",
      sequence: 1,
      response: { kind: "session_started" },
    });

    input.end();
    await running;
  });

  it("discovers models and host metadata before a runtime session exists", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    streams.push(input, output);
    const faux = fauxProvider({ provider: "faux-host" });
    const host = new KoniPiHost(input, output, {
      credentialStore: new InMemoryCredentialStore(),
      provider: faux.provider,
      allowedProviderId: "faux-host",
    });
    const collector = new OutputCollector(output);
    const running = host.run();

    send(input, {
      frame: "request",
      protocol_version: 1,
      session_id: "discovery-1",
      sequence: 1,
      request_id: "models-1",
      command: { command: "list_models" },
    });
    expect(await collector.waitFor((frame) => frame.frame === "response" && frame.request_id === "models-1")).toMatchObject({
      frame: "response",
      sequence: 1,
      response: {
        kind: "models",
        models: [
          {
            provider: "faux-host",
            id: faux.getModel().id,
            name: faux.getModel().name,
            api: faux.getModel().api,
            reasoning: faux.getModel().reasoning,
            input: faux.getModel().input,
            context_window: faux.getModel().contextWindow,
            max_tokens: faux.getModel().maxTokens,
          },
        ],
      },
    });

    send(input, {
      frame: "request",
      protocol_version: 1,
      session_id: "discovery-1",
      sequence: 2,
      request_id: "metadata-1",
      command: { command: "metadata" },
    });
    expect(await collector.waitFor((frame) => frame.frame === "response" && frame.request_id === "metadata-1")).toMatchObject({
      frame: "response",
      sequence: 2,
      response: {
        kind: "metadata",
        metadata: {
          host_version: "0.1.0",
          pi_sdk_version: "0.80.7",
          provider: "faux-host",
          ambient_resources: false,
          ambient_credentials: false,
          tools: "compiler-brokered-only",
        },
      },
    });

    input.end();
    await running;
  });

  it("never serializes an upstream OAuth response body onto the public transport", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    streams.push(input, output);
    const faux = fauxProvider({ provider: "oauth-test" });
    const secrets = ["access-leak", "refresh-leak", "authorization-leak", "verifier-leak", "device-leak"];
    const provider = createProvider({
      id: "oauth-test",
      auth: {
        oauth: {
          name: "Test OAuth",
          login: async () => {
            throw new Error(
              `{"access_token":"${secrets[0]}","refresh_token":"${secrets[1]}",` +
                `"authorization_code":"${secrets[2]}","code_verifier":"${secrets[3]}",` +
                `"device_auth_id":"${secrets[4]}"}`,
            );
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
    const host = new KoniPiHost(input, output, {
      credentialStore: new InMemoryCredentialStore(),
      provider,
      allowedProviderId: "oauth-test",
    });
    const collector = new OutputCollector(output);
    const running = host.run();

    send(input, {
      frame: "request",
      protocol_version: 1,
      session_id: "auth-1",
      sequence: 1,
      request_id: "login-1",
      command: {
        command: "authenticate",
        credential_lease: "lease-1",
        request: { request: "begin_login", provider: "open-ai-codex", preferred_flow: "device_code" },
      },
    });
    const response = await collector.waitFor((frame) => frame.frame === "response" && frame.request_id === "login-1");
    expect(response).toMatchObject({
      response: {
        kind: "rejected",
        code: "authentication_failed",
        message: "OpenAI Codex sign-in did not complete; try signing in again",
      },
    });
    const publicBytes = JSON.stringify(collector.messages);
    for (const secret of secrets) expect(publicBytes).not.toContain(secret);

    input.end();
    await running;
  });

  it("projects a provider rejection before it crosses the real public peer", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    streams.push(input, output);
    const secrets = [
      "provider-access-secret",
      "provider-refresh-secret",
      "provider-arbitrary-secret",
    ];
    const faux = fauxProvider({ provider: "faux-host" });
    faux.setResponses([
      fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage: `HTTP status 429 too many requests ${JSON.stringify({
          access_token: secrets[0],
          refresh_token: secrets[1],
          unknown: secrets[2],
        })}`,
      }),
    ]);
    const host = new KoniPiHost(input, output, {
      credentialStore: new InMemoryCredentialStore(),
      provider: faux.provider,
      allowedProviderId: "faux-host",
    });
    const collector = new OutputCollector(output);
    const running = host.run();

    send(input, {
      frame: "request",
      protocol_version: 1,
      session_id: "session-provider-error",
      sequence: 1,
      request_id: "start-provider-error",
      command: {
        command: "start_session",
        request: {
          session_id: "session-provider-error",
          run_id: "run-provider-error",
          agent_id: "agent-provider-error",
          attempt: 1,
          model: {
            provider: "faux-host",
            model: faux.getModel().id,
            thinking_level: "off",
            input_capabilities: ["text"],
            context_window: faux.getModel().contextWindow,
          },
          instructions: "No ambient resources.",
          tools: [],
          credential_lease: "lease-provider-error",
        },
      },
    });
    await collector.waitFor(
      (frame) => frame.frame === "response" && frame.request_id === "start-provider-error",
    );
    send(input, {
      frame: "request",
      protocol_version: 1,
      session_id: "session-provider-error",
      sequence: 2,
      request_id: "turn-provider-error",
      command: {
        command: "start_turn",
        request: {
          turn_id: "turn-provider-error",
          input: [{ kind: "text", text: "fail safely" }],
          output_schema: null,
          output_token_budget: null,
        },
      },
    });
    const runtimeError = await collector.waitFor(
      (frame) => frame.frame === "event" && frame.event.event === "runtime_error",
    );
    expect(runtimeError).toMatchObject({
      frame: "event",
      event: {
        event: "runtime_error",
        turn_id: "turn-provider-error",
        code: "provider_rate_limited",
        message: "OpenAI Codex is temporarily rate-limiting requests. Retry after a short delay.",
        retryable: true,
      },
    });
    await collector.waitFor(
      (frame) => frame.frame === "event" && frame.event.event === "turn_completed",
    );
    const publicBytes = JSON.stringify(collector.messages);
    for (const secret of secrets) expect(publicBytes).not.toContain(secret);

    input.end();
    await running;
  });

  it("round-trips only compiler-owned tools and keeps public frames credential-free", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    streams.push(input, output);
    const faux = fauxProvider({ provider: "faux-host" });
    faux.setResponses([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "submit-1", name: "submit_result", arguments: { answer: 42 } }],
        api: faux.api,
        provider: "faux-host",
        model: faux.getModel().id,
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: Date.now(),
      },
    ]);
    const host = new KoniPiHost(input, output, {
      credentialStore: new InMemoryCredentialStore(),
      provider: faux.provider,
      allowedProviderId: "faux-host",
    });
    const collector = new OutputCollector(output);
    const running = host.run();
    send(input, {
      frame: "request",
      protocol_version: 1,
      session_id: "session-1",
      sequence: 1,
      request_id: "start-1",
      command: {
        command: "start_session",
        request: {
          session_id: "session-1",
          run_id: "run-1",
          agent_id: "agent-1",
          attempt: 1,
          model: {
            provider: "faux-host",
            model: faux.getModel().id,
            thinking_level: "off",
            input_capabilities: ["text"],
            context_window: faux.getModel().contextWindow,
          },
          instructions: "Use submit_result.",
          tools: [
            {
              name: "submit_result",
              description: "Submit the final answer",
              input_schema: {
                type: "object",
                properties: { answer: { type: "number" } },
                required: ["answer"],
                additionalProperties: false,
              },
            },
          ],
          credential_lease: "lease-1",
        },
      },
    });
    await collector.waitFor((frame) => frame.frame === "response" && frame.request_id === "start-1");
    send(input, {
      frame: "request",
      protocol_version: 1,
      session_id: "session-1",
      sequence: 2,
      request_id: "turn-1",
      command: {
        command: "start_turn",
        request: {
          turn_id: "turn-1",
          input: [{ kind: "text", text: "answer" }],
          output_schema: null,
          output_token_budget: null,
        },
      },
    });
    const turnAccepted = await collector.waitFor(
      (frame) => frame.frame === "response" && frame.request_id === "turn-1",
    );
    const turnStarted = await collector.waitFor(
      (frame) => frame.frame === "event" && frame.event.event === "turn_started",
    );
    expect(turnAccepted).toMatchObject({ frame: "response", response: { kind: "accepted" } });
    expect(collector.messages.indexOf(turnAccepted)).toBeLessThan(collector.messages.indexOf(turnStarted));
    expect(turnAccepted.sequence).toBeLessThan(turnStarted.sequence);
    const toolCall = await collector.waitFor((frame) => frame.frame === "tool_call");
    expect(toolCall).toMatchObject({
      frame: "tool_call",
      session_id: "session-1",
      call: { call_id: "submit-1", name: "submit_result", arguments: { answer: 42 } },
    });
    send(input, {
      frame: "tool_result",
      protocol_version: 1,
      session_id: "session-1",
      sequence: 3,
      call_id: "submit-1",
      outcome: { status: "terminate", value: { accepted: true } },
    });
    await collector.waitFor((frame) => frame.frame === "event" && frame.event.event === "turn_completed");

    for (const frame of collector.messages) {
      const encoded = JSON.stringify(frame);
      expect(encoded).not.toContain("access_token");
      expect(encoded).not.toContain("refresh_token");
      expect(encoded).not.toContain("credential-secret");
    }
    const sequences = collector.messages.map((frame) => frame.sequence);
    expect(sequences).toEqual(sequences.map((_value, index) => index + 1));

    input.end();
    await running;
  });

  it("ACKs cancellation before the terminal event and rejects a post-terminal control as terminal_race", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    streams.push(input, output);
    const faux = fauxProvider({ provider: "faux-host", tokensPerSecond: 100 });
    faux.setResponses([fauxAssistantMessage("x".repeat(400))]);
    const host = new KoniPiHost(input, output, {
      credentialStore: new InMemoryCredentialStore(),
      provider: faux.provider,
      allowedProviderId: "faux-host",
    });
    const collector = new OutputCollector(output);
    const running = host.run();

    send(input, {
      frame: "request",
      protocol_version: 1,
      session_id: "session-cancel-order",
      sequence: 1,
      request_id: "start-cancel-order",
      command: {
        command: "start_session",
        request: {
          session_id: "session-cancel-order",
          run_id: "run-cancel-order",
          agent_id: "agent-cancel-order",
          attempt: 1,
          model: {
            provider: "faux-host",
            model: faux.getModel().id,
            thinking_level: "off",
            input_capabilities: ["text"],
            context_window: faux.getModel().contextWindow,
          },
          instructions: "No ambient resources.",
          tools: [],
          credential_lease: "lease-cancel-order",
        },
      },
    });
    await collector.waitFor(
      (frame) => frame.frame === "response" && frame.request_id === "start-cancel-order",
    );
    send(input, {
      frame: "request",
      protocol_version: 1,
      session_id: "session-cancel-order",
      sequence: 2,
      request_id: "turn-cancel-order",
      command: {
        command: "start_turn",
        request: {
          turn_id: "turn-cancel-order",
          input: [{ kind: "text", text: "start slowly" }],
          output_schema: null,
          output_token_budget: null,
        },
      },
    });
    await collector.waitFor(
      (frame) => frame.frame === "event" && frame.event.event === "turn_started",
    );
    send(input, {
      frame: "request",
      protocol_version: 1,
      session_id: "session-cancel-order",
      sequence: 3,
      request_id: "cancel-control",
      command: { command: "control", control: { control: "cancel", reason: "operator" } },
    });
    const cancelAccepted = await collector.waitFor(
      (frame) => frame.frame === "response" && frame.request_id === "cancel-control",
    );
    const terminal = await collector.waitFor(
      (frame) => frame.frame === "event" && frame.event.event === "turn_completed",
    );
    expect(cancelAccepted).toMatchObject({ response: { kind: "accepted" } });
    expect(collector.messages.indexOf(cancelAccepted)).toBeLessThan(collector.messages.indexOf(terminal));
    expect(cancelAccepted.sequence).toBeLessThan(terminal.sequence);
    expect(terminal).toMatchObject({ event: { stop_reason: "aborted" } });

    send(input, {
      frame: "request",
      protocol_version: 1,
      session_id: "session-cancel-order",
      sequence: 4,
      request_id: "late-control",
      command: { command: "control", control: { control: "steer", text: "too late" } },
    });
    expect(
      await collector.waitFor((frame) => frame.frame === "response" && frame.request_id === "late-control"),
    ).toMatchObject({ response: { kind: "rejected", code: "terminal_race" } });

    const sequences = collector.messages.map((frame) => frame.sequence);
    expect(sequences).toEqual(sequences.map((_value, index) => index + 1));
    input.end();
    await running;
  });

  it("fails closed on replayed sequence numbers and oversized frames", async () => {
    const replayInput = new PassThrough();
    const replayOutput = new PassThrough();
    streams.push(replayInput, replayOutput);
    const peer = new PiProtocolPeer(replayInput, replayOutput, new SecretRedactor());
    const running = peer.run(async () => ({ kind: "accepted" }));
    const frame: PiFrame = {
      frame: "request",
      protocol_version: 1,
      session_id: "session-1",
      sequence: 1,
      request_id: "one",
      command: { command: "shutdown" },
    };
    send(replayInput, frame);
    send(replayInput, { ...frame, request_id: "replay" });
    await expect(running).rejects.toThrow("expected sequence 2, received 1");

    const largeInput = new PassThrough();
    const largeOutput = new PassThrough();
    streams.push(largeInput, largeOutput);
    const bounded = new PiProtocolPeer(largeInput, largeOutput, new SecretRedactor(), { maxFrameBytes: 64 });
    const boundedRun = bounded.run(async () => ({ kind: "accepted" }));
    largeInput.end("x".repeat(65));
    await expect(boundedRun).rejects.toThrow("exceeds 64 bytes");
  });

  it("serializes compiler requests while resolving tool results re-entrantly", async () => {
    const orderedInput = new PassThrough();
    const orderedOutput = new PassThrough();
    streams.push(orderedInput, orderedOutput);
    const orderedCollector = new OutputCollector(orderedOutput);
    const orderedPeer = new PiProtocolPeer(orderedInput, orderedOutput, new SecretRedactor());
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const order: string[] = [];
    const orderedRun = orderedPeer.run(async (frame) => {
      order.push(`${frame.request_id}:start`);
      if (frame.request_id === "first") await firstGate;
      order.push(`${frame.request_id}:end`);
      return { kind: "accepted" };
    });
    send(orderedInput, {
      frame: "request",
      protocol_version: 1,
      session_id: "session-order",
      sequence: 1,
      request_id: "first",
      command: { command: "shutdown" },
    });
    send(orderedInput, {
      frame: "request",
      protocol_version: 1,
      session_id: "session-order",
      sequence: 2,
      request_id: "second",
      command: { command: "shutdown" },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(order).toEqual(["first:start"]);
    releaseFirst();
    await orderedCollector.waitFor((frame) => frame.frame === "response" && frame.request_id === "second");
    orderedInput.end();
    await orderedRun;
    expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);

    const toolInput = new PassThrough();
    const toolOutput = new PassThrough();
    streams.push(toolInput, toolOutput);
    const toolCollector = new OutputCollector(toolOutput);
    const toolPeer = new PiProtocolPeer(toolInput, toolOutput, new SecretRedactor());
    const toolRun = toolPeer.run(async () => {
      const outcome = await toolPeer.executeTool({ call_id: "call-1", name: "context", arguments: {} });
      expect(outcome).toEqual({ status: "success", value: { context: "bounded" } });
      return { kind: "accepted" };
    });
    send(toolInput, {
      frame: "request",
      protocol_version: 1,
      session_id: "session-tool",
      sequence: 1,
      request_id: "work",
      command: { command: "shutdown" },
    });
    await toolCollector.waitFor((frame) => frame.frame === "tool_call" && frame.call.call_id === "call-1");
    send(toolInput, {
      frame: "tool_result",
      protocol_version: 1,
      session_id: "session-tool",
      sequence: 2,
      call_id: "call-1",
      outcome: { status: "success", value: { context: "bounded" } },
    });
    await toolCollector.waitFor((frame) => frame.frame === "response" && frame.request_id === "work");
    toolInput.end();
    await toolRun;
  });

  it("does not consume an outbound sequence when an oversized event fails before write", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    streams.push(input, output);
    const collector = new OutputCollector(output);
    const peer = new PiProtocolPeer(input, output, new SecretRedactor(), { maxFrameBytes: 512 });
    let recovery: Promise<void> | undefined;
    const running = peer.run(() => ({
      response: { kind: "accepted" },
      afterResponse: () => {
        recovery = (async () => {
          await peer.sendEvent({ event: "turn_started", turn_id: "turn-oversized" });
          try {
            await peer.sendEvent({
              event: "message_completed",
              turn_id: "turn-oversized",
              message_id: "message-oversized",
              role: "assistant",
              content: "x".repeat(4096),
            });
            throw new Error("oversized frame unexpectedly fit");
          } catch {
            await peer.sendEvent({
              event: "runtime_error",
              turn_id: "turn-oversized",
              code: "runtime_internal",
              message:
                "The Pi runtime failed internally. Retry manually; if it repeats, inspect Koni diagnostics.",
              retryable: false,
            });
            await peer.sendEvent({
              event: "turn_completed",
              turn_id: "turn-oversized",
              stop_reason: "error",
              usage: {
                input_tokens: 0,
                cached_input_tokens: 0,
                output_tokens: 0,
                reasoning_tokens: 0,
                total_tokens: 0,
              },
            });
          }
        })();
        void recovery.catch(() => undefined);
      },
    }));
    send(input, {
      frame: "request",
      protocol_version: 1,
      session_id: "session-oversized",
      sequence: 1,
      request_id: "turn-request",
      command: { command: "shutdown" },
    });

    await collector.waitFor(
      (frame) => frame.frame === "event" && frame.event.event === "turn_completed",
    );
    await recovery;
    expect(collector.messages.map((frame) => frame.sequence)).toEqual([1, 2, 3, 4]);
    expect(collector.messages.map((frame) => (frame.frame === "event" ? frame.event.event : frame.frame))).toEqual([
      "response",
      "turn_started",
      "runtime_error",
      "turn_completed",
    ]);

    input.end();
    await running;
  });
});

class MemoryCredentialSocket extends Duplex {
  readonly writes: string[] = [];

  override _read(): void {}

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.writes.push(chunk.toString("utf8"));
    callback();
  }

  receive(frame: unknown): void {
    this.push(`${JSON.stringify(frame)}\n`);
  }

  finishInput(): void {
    this.push(null);
  }
}

describe("private fd3 credential protocol", () => {
  it("uses transactional snake_case frames that cannot parse as public PiFrame", async () => {
    const socket = new MemoryCredentialSocket();
    const redactor = new SecretRedactor();
    const channel = new PrivateCredentialChannel(socket, redactor);
    const running = channel.run();

    const reading = channel.read("lease-1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const readFrame = JSON.parse(socket.writes[0] ?? "{}") as { request_id: string };
    expect(readFrame).toMatchObject({
      frame: "read",
      protocol_version: 1,
      lease_id: "lease-1",
    });
    expect(() => {
      const publicFrame = readFrame as unknown as PiFrame;
      if (!("session_id" in publicFrame)) throw new Error("not public");
    }).toThrow("not public");
    socket.receive({
      frame: "read_result",
      protocol_version: 1,
      request_id: readFrame.request_id,
      lease_id: "lease-1",
      revision: 3,
      credential: {
        type: "oauth",
        access: "private-access-secret",
        refresh: "private-refresh-secret",
        expires: 1234,
        accountId: "account-1",
      },
    });
    expect(await reading).toMatchObject({ type: "oauth", accountId: "account-1" });
    expect(redactor.redact("private-access-secret private-refresh-secret")).toBe("[REDACTED] [REDACTED]");

    const beginning = channel.beginModify("lease-1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const beginFrame = JSON.parse(socket.writes[1] ?? "{}") as { request_id: string };
    expect(beginFrame).toMatchObject({ frame: "modify_begin", lease_id: "lease-1" });
    socket.receive({
      frame: "modify_begin_result",
      protocol_version: 1,
      request_id: beginFrame.request_id,
      lease_id: "lease-1",
      transaction_id: "transaction-1",
      current: null,
    });
    expect(await beginning).toEqual({ transactionId: "transaction-1" });

    const credential = {
      type: "oauth" as const,
      access: "committed-access-secret",
      refresh: "committed-refresh-secret",
      expires: 5678,
      accountId: "account-1",
    };
    const committing = channel.commitModify("lease-1", "transaction-1", credential);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const commitFrame = JSON.parse(socket.writes[2] ?? "{}") as { request_id: string };
    expect(commitFrame).toMatchObject({
      frame: "modify_commit",
      lease_id: "lease-1",
      transaction_id: "transaction-1",
      credential,
    });
    socket.receive({
      frame: "modify_commit_result",
      protocol_version: 1,
      request_id: commitFrame.request_id,
      lease_id: "lease-1",
      transaction_id: "transaction-1",
      credential,
    });
    expect(await committing).toEqual(credential);

    const deleting = channel.delete("lease-1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const deleteFrame = JSON.parse(socket.writes[3] ?? "{}") as { request_id: string };
    expect(deleteFrame).toMatchObject({ frame: "delete", lease_id: "lease-1" });
    socket.receive({
      frame: "delete_result",
      protocol_version: 1,
      request_id: deleteFrame.request_id,
      lease_id: "lease-1",
    });
    await deleting;

    const publicInput = new PassThrough();
    const publicOutput = new PassThrough();
    const publicPeer = new PiProtocolPeer(publicInput, publicOutput, new SecretRedactor());
    const publicRun = publicPeer.run(async () => ({ kind: "accepted" }));
    publicInput.end(`${JSON.stringify(readFrame)}\n`);
    await expect(publicRun).rejects.toThrow("session_id");

    socket.finishInput();
    await running;
  });
});
