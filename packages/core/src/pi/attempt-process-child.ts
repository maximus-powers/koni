import { randomUUID } from "node:crypto";
import type { TSchema } from "typebox";
import {
  BoundedJsonLineDecoder,
  PI_ATTEMPT_PROCESS_PROTOCOL,
  assertFrameBinding,
  encodePiAttemptProcessFrame,
  parseParentFrame,
  type LaunchAttemptFrame,
  type PiAttemptChildFrame,
  type PiAttemptParentFrame,
  type PiAuthorityRequest,
  type PiAuthorityResponseValue,
} from "./attempt-process-protocol.js";
import {
  type KoniAttemptRecoveryClaim,
  type KoniAuthorizedMessage,
  type KoniContextProvider,
} from "./compaction.js";
import type { SelectedDynamicGraphContext } from "../graph/context-selector.js";
import { rawSha256 } from "../shared/canonical.js";
import { validateAgentLaunchSpec, type AgentLaunchSpec } from "./launch-spec.js";
import { ManagedPiSession, type ManagedSessionOutcome } from "./managed-session.js";
import {
  KONI_TOOL_NAMES,
  createKoniAuthorityTools,
  type KoniToolName,
  type KoniToolReceipt,
} from "./tool-catalog.js";

const MAX_ERROR_BYTES = 64 * 1024;

/** Child entry: exactly one launch specification and exactly one managed Pi session. */
export async function runPiAttemptProcessChild(): Promise<void> {
  const transport = new ChildTransport();
  let session: ManagedPiSession | undefined;
  try {
    const launch = await transport.waitForLaunch();
    const spec = validateAgentLaunchSpec(launch.spec);
    transport.bind(spec);
    const names = exactKoniToolNames(spec);
    const contextProvider = remoteContextProvider(transport);
    const tools = createKoniAuthorityTools({
      names,
      terminalOutputSchema: structuredClone(launch.terminalOutputSchema),
      schemaHashes: Object.fromEntries(spec.tools.map((tool) => [tool.name, tool.schemaHash])),
      invoke: async (call) => {
        const result = await transport.request({
          operation: "invoke_tool",
          callId: call.callId,
          name: call.name,
          arguments: structuredClone(call.arguments),
        }, call.signal);
        return result as KoniToolReceipt;
      },
      reject: async (call, rejection) => {
        const result = await transport.request({
          operation: "reject_tool",
          callId: call.callId,
          name: call.name,
          arguments: structuredClone(call.arguments),
          rejection: structuredClone(rejection),
        }, call.signal);
        return result as Extract<KoniToolReceipt, { outcome: "rejected" }>;
      },
    });
    session = launch.mode === "fresh"
      ? await ManagedPiSession.create(spec, { tools, contextProvider })
      : await ManagedPiSession.recover(spec, { tools, contextProvider });
    transport.attachSession(session);
    session.subscribe((event) => {
      void transport.send({ type: "event", event: structuredClone(event) }).catch(() => undefined);
    });
    await transport.send({ type: "ready", sessionFile: session.sessionFile });
    await transport.waitForActivation();

    let outcome: ManagedSessionOutcome;
    if (transport.abortRequested !== undefined) {
      await session.abort(transport.abortRequested);
      outcome = { status: "aborted", reason: transport.abortRequested, usage: session.usage };
      await session.dispose();
    } else {
      outcome = await session.start();
      await session.releaseRuntime();
    }
    await transport.send({ type: "outcome", outcome: structuredClone(outcome) });
    await transport.close();
  } catch (error) {
    try {
      await session?.dispose();
    } catch {
      // The parent owns process-group escalation and will still terminate this process.
    }
    await transport.fatal(error).catch(() => undefined);
    await transport.close();
    process.exitCode = 1;
  }
}

class ChildTransport {
  readonly #decoder = new BoundedJsonLineDecoder();
  readonly #launch = deferred<LaunchAttemptFrame>();
  readonly #activation = deferred<void>();
  readonly #pending = new Map<string, Deferred<PiAuthorityResponseValue>>();
  readonly #cancelledRequests = new Set<string>();
  #spec: Readonly<AgentLaunchSpec> | undefined;
  #session: ManagedPiSession | undefined;
  #inboundSequence = 0;
  #outboundSequence = 0;
  #writeChain: Promise<void> = Promise.resolve();
  #messageChain: Promise<void> = Promise.resolve();
  #closed = false;
  #abortRequested: string | undefined;
  #lastAuthorizedMessageSequence = 0;

  public constructor() {
    process.stdin.on("data", (chunk: Buffer) => this.#onInput(chunk));
    process.stdin.once("end", () => this.#onParentDisconnect());
    process.stdin.once("error", () => this.#onParentDisconnect());
    process.stdin.resume();
  }

  public get abortRequested(): string | undefined {
    return this.#abortRequested;
  }

  public waitForLaunch(): Promise<LaunchAttemptFrame> {
    return this.#launch.promise;
  }

  /**
   * Production launches stop here until the authority has durably recorded the exact session
   * path. Abort also releases the wait so a paused/deleted run can exit without a provider turn.
   */
  public waitForActivation(): Promise<void> {
    const launch = this.#launch.value;
    if (launch === undefined) return Promise.reject(new Error("attempt is not bound to a launch"));
    if (!launch.deferActivation || this.#abortRequested !== undefined) return Promise.resolve();
    return this.#activation.promise;
  }

  public bind(spec: Readonly<AgentLaunchSpec>): void {
    const launch = this.#launch.value;
    if (launch === undefined || launch.specHash !== spec.specHash || launch.attemptId !== spec.identity.attemptId) {
      throw new Error("launch frame does not match its validated immutable specification");
    }
    this.#spec = spec;
  }

  public attachSession(session: ManagedPiSession): void {
    this.#session = session;
  }

  public request(request: PiAuthorityRequest, signal?: AbortSignal): Promise<PiAuthorityResponseValue> {
    if (this.#closed) return Promise.reject(new Error("authority channel is closed"));
    const requestId = randomUUID();
    const pending = deferred<PiAuthorityResponseValue>();
    this.#pending.set(requestId, pending);
    const onAbort = () => {
      if (this.#cancelledRequests.size >= 1024) {
        pending.reject(new Error("too many cancelled authority requests remain unsettled"));
        return;
      }
      this.#cancelledRequests.add(requestId);
      void this.send({ type: "authority_cancel", requestId }).catch(() => undefined);
      pending.reject(new Error("authority request aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    void this.send({ type: "authority_request", requestId, request })
      .catch((error) => pending.reject(asError(error)));
    return pending.promise.finally(() => {
      signal?.removeEventListener("abort", onAbort);
      this.#pending.delete(requestId);
    });
  }

  public send(frame: ChildFramePayload): Promise<void> {
    const spec = this.#spec;
    const launch = this.#launch.value;
    const attemptId = spec?.identity.attemptId ?? launch?.attemptId;
    const specHash = spec?.specHash ?? launch?.specHash;
    if (attemptId === undefined || specHash === undefined) {
      return Promise.reject(new Error("child cannot send before a launch frame is bound"));
    }
    const envelope = {
      ...frame,
      protocol: PI_ATTEMPT_PROCESS_PROTOCOL,
      attemptId,
      specHash,
      sequence: ++this.#outboundSequence,
    } as PiAttemptChildFrame;
    const bytes = encodePiAttemptProcessFrame(envelope);
    this.#writeChain = this.#writeChain.then(() => new Promise<void>((resolve, reject) => {
      process.stdout.write(bytes, (error) => error === null ? resolve() : reject(error));
    }));
    return this.#writeChain;
  }

  public async fatal(error: unknown): Promise<void> {
    if (this.#launch.value === undefined) {
      process.stderr.write(`${sanitizeError(error)}\n`);
      return;
    }
    await this.send({ type: "fatal", error: sanitizeError(error) });
  }

  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) pending.reject(new Error("authority channel closed"));
    this.#pending.clear();
    await this.#writeChain.catch(() => undefined);
    process.stdin.removeAllListeners();
    process.stdin.pause();
    process.stdin.destroy();
  }

  #onInput(chunk: Buffer): void {
    if (this.#closed) return;
    try {
      for (const value of this.#decoder.push(chunk)) {
        const frame = parseParentFrame(value);
        if (this.#launch.value === undefined) {
          if (frame.type !== "launch") throw new Error("first attempt-process frame must be launch");
          if (frame.sequence !== 1) throw new Error("launch frame sequence must be one");
          this.#inboundSequence = 1;
          this.#launch.resolve(validateLaunchFrame(frame));
          continue;
        }
        const launch = this.#launch.value;
        assertFrameBinding(frame, {
          attemptId: launch.attemptId,
          specHash: launch.specHash,
          nextSequence: this.#inboundSequence + 1,
        });
        this.#inboundSequence = frame.sequence;
        if (frame.type === "launch") throw new Error("launch may only be sent once");
        this.#onFrame(frame);
      }
    } catch (error) {
      this.#launch.reject(asError(error));
      this.#abortRequested ??= "invalid authority process protocol";
      this.#activation.resolve(undefined);
      void this.#session?.abort(this.#abortRequested).finally(() => this.#session?.dispose()).catch(() => undefined);
      void this.fatal(error).finally(() => {
        process.exitCode = 1;
        void this.close();
      });
    }
  }

  #onFrame(frame: Exclude<PiAttemptParentFrame, LaunchAttemptFrame>): void {
    if (frame.type === "authority_response") {
      const pending = this.#pending.get(frame.requestId);
      if (pending === undefined) {
        if (this.#cancelledRequests.delete(frame.requestId)) return;
        throw new Error("authority response has no matching request");
      }
      this.#cancelledRequests.delete(frame.requestId);
      if (frame.ok) pending.resolve(frame.value as PiAuthorityResponseValue);
      else pending.reject(new Error(sanitizeText(frame.error ?? "authority request failed", MAX_ERROR_BYTES)));
      return;
    }
    if (frame.type === "control") {
      if (frame.action === "abort" || frame.action === "activate") {
        void this.#handleControl(frame);
      } else {
        const operation = this.#messageChain.then(() => this.#handleControl(frame));
        this.#messageChain = operation.catch(() => undefined);
      }
      return;
    }
    throw new Error("launch may only be sent once");
  }

  async #handleControl(frame: Extract<PiAttemptParentFrame, { type: "control" }>): Promise<void> {
    try {
      if (frame.action === "abort") {
        this.#abortRequested ??= sanitizeText(frame.reason, MAX_ERROR_BYTES);
        this.#activation.resolve(undefined);
        await this.#session?.abort(this.#abortRequested);
      } else if (frame.action === "activate") {
        if (this.#launch.value?.deferActivation !== true) {
          throw new Error("attempt launch did not request deferred activation");
        }
        if (this.#session === undefined) throw new Error("Pi session is not ready for activation");
        if (this.#abortRequested !== undefined) throw new Error("attempt was aborted before activation");
        // Idempotent resolution makes a retried control harmless while frame identities still
        // prevent replay across attempts.
        this.#activation.resolve(undefined);
      } else {
        if (this.#session === undefined) throw new Error("Pi session is not ready for messages");
        validateAuthorizedMessage(frame.message);
        if (frame.message.sequence <= this.#lastAuthorizedMessageSequence) {
          throw new Error("authorized message sequence did not increase");
        }
        if (frame.message.mode === "steer") await this.#session.steer(frame.message);
        else await this.#session.followUp(frame.message);
        this.#lastAuthorizedMessageSequence = frame.message.sequence;
      }
      await this.send({ type: "control_result", controlId: frame.controlId, ok: true });
    } catch (error) {
      await this.send({ type: "control_result", controlId: frame.controlId, ok: false, error: sanitizeError(error) });
    }
  }

  #onParentDisconnect(): void {
    if (this.#closed) return;
    this.#abortRequested ??= "authority process disconnected";
    this.#activation.resolve(undefined);
    for (const pending of this.#pending.values()) pending.reject(new Error(this.#abortRequested));
    this.#pending.clear();
    const watchdog = setTimeout(() => process.exit(1), 5_000);
    watchdog.unref();
    void (async () => {
      try {
        await this.#session?.abort(this.#abortRequested);
        await this.#session?.dispose();
      } finally {
        await this.close();
        clearTimeout(watchdog);
        process.exitCode = 1;
      }
    })().catch(() => undefined);
  }
}

function remoteContextProvider(transport: ChildTransport): KoniContextProvider {
  return {
    async loadBoundContext() {
      return await transport.request({ operation: "load_bound_context" }) as Awaited<ReturnType<KoniContextProvider["loadBoundContext"]>>;
    },
    async loadDynamicGraphContext() {
      return await transport.request({ operation: "load_dynamic_graph_context" }) as SelectedDynamicGraphContext;
    },
    async loadCompactionSnapshot() {
      return await transport.request({ operation: "load_compaction_snapshot" }) as Awaited<ReturnType<KoniContextProvider["loadCompactionSnapshot"]>>;
    },
    async authorizeCompaction(_spec, record) {
      return await transport.request({ operation: "authorize_compaction", record: structuredClone(record) }) as { authorizationId: string };
    },
    async acquireRecoveryClaim() {
      const response = await transport.request({ operation: "acquire_recovery_claim" }) as {
        claimToken: string;
        claimId: string;
        state: KoniAttemptRecoveryClaim["state"];
      };
      let released = false;
      return {
        protocol: "koni.attempt-recovery-claim.v1",
        claimId: response.claimId,
        state: structuredClone(response.state),
        async release() {
          if (released) return;
          released = true;
          await transport.request({ operation: "release_recovery_claim", claimToken: response.claimToken });
        },
      };
    },
  };
}

function exactKoniToolNames(spec: Readonly<AgentLaunchSpec>): KoniToolName[] {
  const known = new Set<string>(KONI_TOOL_NAMES);
  return spec.tools.map((tool) => {
    if (!known.has(tool.name)) throw new Error(`launch tool ${tool.name} is not a sealed Koni authority tool`);
    return tool.name as KoniToolName;
  });
}

function validateLaunchFrame(frame: LaunchAttemptFrame): LaunchAttemptFrame {
  if (frame.mode !== "fresh" && frame.mode !== "recover") throw new Error("invalid attempt launch mode");
  if (typeof frame.deferActivation !== "boolean") throw new Error("invalid attempt activation policy");
  if (typeof frame.spec !== "object" || frame.spec === null) throw new Error("launch specification is missing");
  if (typeof frame.terminalOutputSchema !== "object" || frame.terminalOutputSchema === null) {
    throw new Error("terminal output schema is missing");
  }
  return frame;
}

function validateAuthorizedMessage(message: KoniAuthorizedMessage): void {
  const bytes = Buffer.byteLength(message.content, "utf8");
  if (
    !Number.isSafeInteger(message.sequence) ||
    message.sequence < 1 ||
    (message.mode !== "steer" && message.mode !== "follow_up") ||
    bytes === 0 ||
    bytes > 1024 * 1024 ||
    message.content.includes("\u0000") ||
    message.sizeBytes !== bytes ||
    message.sha256 !== rawSha256(message.content)
  ) {
    throw new Error("authorized message record has invalid bytes, digest, mode, or sequence");
  }
}

type ChildFramePayload =
  | { type: "ready"; sessionFile: string }
  | { type: "event"; event: import("./managed-session.js").ManagedSessionEvent }
  | { type: "outcome"; outcome: ManagedSessionOutcome }
  | { type: "control_result"; controlId: string; ok: boolean; error?: string }
  | { type: "authority_request"; requestId: string; request: PiAuthorityRequest }
  | { type: "authority_cancel"; requestId: string }
  | { type: "fatal"; error: string };

interface Deferred<T> {
  promise: Promise<T>;
  value: T | undefined;
  settled: boolean;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: Error) => void;
  const result: Deferred<T> = {
    promise: new Promise<T>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    }),
    value: undefined,
    settled: false,
    resolve(value) {
      if (result.settled) return;
      result.settled = true;
      result.value = value;
      resolvePromise(value);
    },
    reject(error) {
      if (result.settled) return;
      result.settled = true;
      rejectPromise(error);
    },
  };
  void result.promise.catch(() => undefined);
  return result;
}

function sanitizeError(error: unknown): string {
  return sanitizeText(error instanceof Error ? error.message : String(error), MAX_ERROR_BYTES);
}

function sanitizeText(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(String(value).replaceAll("\u0000", "�"), "utf8");
  return (bytes.byteLength <= maximumBytes ? bytes : bytes.subarray(0, maximumBytes)).toString("utf8");
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
