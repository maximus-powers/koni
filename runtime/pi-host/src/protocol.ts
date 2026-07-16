import type { Readable, Writable } from "node:stream";
import { HostError, toHostError } from "./errors.js";
import type { SecretRedactor } from "./redaction.js";
import type { AgentToolCallWire, AgentToolOutcome, PiFrame, RuntimeEvent, RuntimeResponse } from "./wire-types.js";

export const PROTOCOL_VERSION = 1 as const;
export const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
export const DEFAULT_TOOL_TIMEOUT_MS = 5 * 60 * 1000;

export type CompilerRequestFrame = Extract<PiFrame, { frame: "request" }>;
export type CompilerToolResultFrame = Extract<PiFrame, { frame: "tool_result" }>;
export type HostFrame = Extract<PiFrame, { frame: "response" | "event" | "tool_call" }>;
type HostFrameFields = HostFrame extends infer T
  ? T extends HostFrame
    ? Omit<T, "protocol_version" | "session_id" | "sequence">
    : never
  : never;
export interface DeferredRuntimeResponse {
  response: RuntimeResponse;
  afterResponse: () => void;
}

export type RequestHandlerResult = RuntimeResponse | DeferredRuntimeResponse;
export type RequestHandler = (frame: CompilerRequestFrame) => Promise<RequestHandlerResult> | RequestHandlerResult;

interface PendingToolCall {
  resolve(outcome: AgentToolOutcome): void;
  reject(error: unknown): void;
  timeout: NodeJS.Timeout;
  signal?: AbortSignal;
  abortListener?: () => void;
}

export interface PiProtocolOptions {
  maxFrameBytes?: number;
  toolTimeoutMs?: number;
  onFatal?: (error: HostError) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateIdentifier(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 128 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new HostError("PROTOCOL_ERROR", `${name} must be 1..=128 bytes without surrounding whitespace or controls`);
  }
  return value;
}

function validateOutcome(value: unknown): AgentToolOutcome {
  if (!isRecord(value)) throw new HostError("PROTOCOL_ERROR", "tool outcome must be an object");
  if (value["status"] === "success" || value["status"] === "terminate") {
    return value as unknown as AgentToolOutcome;
  }
  if (
    value["status"] === "error" &&
    typeof value["code"] === "string" &&
    typeof value["message"] === "string" &&
    typeof value["retryable"] === "boolean"
  ) {
    return value as unknown as AgentToolOutcome;
  }
  throw new HostError("PROTOCOL_ERROR", "tool outcome has an invalid status or error shape");
}

function parseFrame(line: Buffer): PiFrame {
  let value: unknown;
  try {
    value = JSON.parse(line.toString("utf8"));
  } catch {
    throw new HostError("PROTOCOL_ERROR", "invalid public protocol JSON");
  }
  if (!isRecord(value)) throw new HostError("PROTOCOL_ERROR", "public frame must be an object");
  if (value["protocol_version"] !== PROTOCOL_VERSION) {
    throw new HostError("PROTOCOL_ERROR", `unsupported protocol version ${String(value["protocol_version"])}`);
  }
  validateIdentifier(value["session_id"], "session_id");
  if (typeof value["sequence"] !== "number" || !Number.isSafeInteger(value["sequence"]) || value["sequence"] <= 0) {
    throw new HostError("PROTOCOL_ERROR", "sequence must be a positive safe integer");
  }
  if (value["frame"] === "request") {
    validateIdentifier(value["request_id"], "request_id");
    if (!isRecord(value["command"]) || typeof value["command"]["command"] !== "string") {
      throw new HostError("PROTOCOL_ERROR", "request command is invalid");
    }
    return value as unknown as PiFrame;
  }
  if (value["frame"] === "tool_result") {
    validateIdentifier(value["call_id"], "call_id");
    validateOutcome(value["outcome"]);
    return value as unknown as PiFrame;
  }
  if (value["frame"] === "response" || value["frame"] === "event" || value["frame"] === "tool_call") {
    return value as unknown as PiFrame;
  }
  throw new HostError("PROTOCOL_ERROR", "unknown public frame type");
}

function encodeFrame(frame: HostFrame, maxFrameBytes: number): string {
  const encoded = JSON.stringify(frame);
  if (Buffer.byteLength(encoded, "utf8") > maxFrameBytes) {
    throw new HostError("PROTOCOL_ERROR", `outgoing public frame exceeds ${maxFrameBytes} bytes`);
  }
  return `${encoded}\n`;
}

/** Exact TypeScript peer for `crates/koni-core/src/pi_protocol.rs`. */
export class PiProtocolPeer {
  private readonly maxFrameBytes: number;
  private readonly toolTimeoutMs: number;
  private readonly onFatal: ((error: HostError) => void) | undefined;
  private readonly pendingTools = new Map<string, PendingToolCall>();
  private readonly ignoredToolResults = new Set<string>();
  private writeChain: Promise<void> = Promise.resolve();
  private requestChain: Promise<void> = Promise.resolve();
  private requestFailure: HostError | undefined;
  private sessionId: string | undefined;
  private inboundSequence = 1;
  private outboundSequence = 1;
  private closed = false;

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly redactor: SecretRedactor,
    options: PiProtocolOptions = {},
  ) {
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.toolTimeoutMs = options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    this.onFatal = options.onFatal;
  }

  async run(handler: RequestHandler): Promise<void> {
    let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    try {
      for await (const rawChunk of this.input) {
        const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk as Uint8Array);
        pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
        let newline = pending.indexOf(0x0a);
        while (newline >= 0) {
          let line = pending.subarray(0, newline);
          pending = pending.subarray(newline + 1);
          if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
          if (line.length === 0) throw new HostError("PROTOCOL_ERROR", "blank public protocol frame");
          if (line.length > this.maxFrameBytes) {
            throw new HostError("PROTOCOL_ERROR", `public frame exceeds ${this.maxFrameBytes} bytes`);
          }
          this.receive(parseFrame(line), handler);
          newline = pending.indexOf(0x0a);
        }
        if (pending.length > this.maxFrameBytes) {
          throw new HostError("PROTOCOL_ERROR", `public frame exceeds ${this.maxFrameBytes} bytes`);
        }
      }
      if (pending.length !== 0) throw new HostError("PROTOCOL_ERROR", "unterminated public frame at EOF");
      await this.requestChain;
      if (this.requestFailure) throw this.requestFailure;
    } catch (error) {
      const fatal = toHostError(error);
      this.onFatal?.(fatal);
      throw fatal;
    } finally {
      this.close();
    }
  }

  async sendEvent(event: RuntimeEvent): Promise<void> {
    await this.sendWithHeader({ frame: "event", event });
  }

  async executeTool(call: AgentToolCallWire, signal?: AbortSignal): Promise<AgentToolOutcome> {
    validateIdentifier(call.call_id, "call_id");
    validateIdentifier(call.name, "tool name");
    if (this.pendingTools.has(call.call_id) || this.ignoredToolResults.has(call.call_id)) {
      throw new HostError("CONFLICT", `duplicate tool call id ${call.call_id}`);
    }
    if (signal?.aborted) throw new HostError("CANCELLED", `tool call ${call.call_id} was cancelled`);
    const result = new Promise<AgentToolOutcome>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.removePendingTool(call.call_id);
        this.ignoredToolResults.add(call.call_id);
        reject(new HostError("BROKER_TIMEOUT", `tool call ${call.call_id} timed out`, { retryable: true }));
      }, this.toolTimeoutMs);
      const pending: PendingToolCall = { resolve, reject, timeout };
      if (signal) {
        const abortListener = () => {
          this.removePendingTool(call.call_id);
          this.ignoredToolResults.add(call.call_id);
          reject(new HostError("CANCELLED", `tool call ${call.call_id} was cancelled`));
        };
        signal.addEventListener("abort", abortListener, { once: true });
        pending.signal = signal;
        pending.abortListener = abortListener;
      }
      this.pendingTools.set(call.call_id, pending);
    });
    try {
      await this.sendWithHeader({ frame: "tool_call", call });
    } catch (error) {
      this.removePendingTool(call.call_id)?.reject(error);
      throw error;
    }
    return result;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const error = new HostError("PROTOCOL_ERROR", "public protocol closed");
    for (const id of [...this.pendingTools.keys()]) this.removePendingTool(id)?.reject(error);
  }

  abort(error: unknown): void {
    const fatal = toHostError(error);
    if (!this.requestFailure) this.requestFailure = fatal;
    this.input.destroy(fatal);
    this.close();
  }

  private receive(frame: PiFrame, handler: RequestHandler): void {
    this.validateInboundHeader(frame);
    if (frame.frame === "request") {
      this.requestChain = this.requestChain.then(async () => {
        if (this.requestFailure) return;
        try {
          await this.dispatchRequest(frame, handler);
        } catch (error) {
          this.requestFailure = toHostError(error);
          this.input.destroy(this.requestFailure);
        }
      });
      return;
    }
    if (frame.frame === "tool_result") {
      if (this.ignoredToolResults.delete(frame.call_id)) return;
      const pending = this.removePendingTool(frame.call_id);
      if (!pending) throw new HostError("PROTOCOL_ERROR", `unexpected tool result ${frame.call_id}`);
      pending.resolve(validateOutcome(frame.outcome));
      return;
    }
    throw new HostError("PROTOCOL_ERROR", "compiler sent a host-only public frame");
  }

  private validateInboundHeader(frame: PiFrame): void {
    if (this.sessionId === undefined) this.sessionId = frame.session_id;
    if (frame.session_id !== this.sessionId) {
      throw new HostError("PROTOCOL_ERROR", `cross-session frame: expected ${this.sessionId}, received ${frame.session_id}`);
    }
    if (frame.sequence !== this.inboundSequence) {
      throw new HostError(
        "PROTOCOL_ERROR",
        `out-of-order frame for ${this.sessionId}: expected sequence ${this.inboundSequence}, received ${frame.sequence}`,
      );
    }
    this.inboundSequence += 1;
  }

  private async dispatchRequest(frame: CompilerRequestFrame, handler: RequestHandler): Promise<void> {
    let response: RuntimeResponse;
    let afterResponse: (() => void) | undefined;
    try {
      const result = await handler(frame);
      if ("afterResponse" in result) {
        response = result.response;
        afterResponse = result.afterResponse;
      } else {
        response = result;
      }
    } catch (error) {
      const hostError = toHostError(error);
      response = {
        kind: "rejected",
        code: hostError.code.toLowerCase(),
        message: this.redactor.redact(hostError.message),
        retryable: hostError.retryable,
      };
    }
    await this.sendWithHeader({ frame: "response", request_id: frame.request_id, response });
    afterResponse?.();
  }

  private sendWithHeader(frame: HostFrameFields): Promise<void> {
    if (this.closed) return Promise.reject(new HostError("PROTOCOL_ERROR", "public protocol is closed"));
    if (!this.sessionId) return Promise.reject(new HostError("NOT_INITIALIZED", "public session id is not established"));
    const sequence = this.outboundSequence;
    const full = {
      ...frame,
      protocol_version: PROTOCOL_VERSION,
      session_id: this.sessionId,
      sequence,
    } as HostFrame;
    const encoded = encodeFrame(full, this.maxFrameBytes);
    this.outboundSequence += 1;
    const write = this.writeChain.then(
      () =>
        new Promise<void>((resolve, reject) => {
          this.output.write(encoded, "utf8", (error) => (error ? reject(error) : resolve()));
        }),
    );
    this.writeChain = write.catch(() => undefined);
    return write;
  }

  private removePendingTool(id: string): PendingToolCall | undefined {
    const pending = this.pendingTools.get(id);
    if (!pending) return undefined;
    this.pendingTools.delete(id);
    clearTimeout(pending.timeout);
    if (pending.signal && pending.abortListener) pending.signal.removeEventListener("abort", pending.abortListener);
    return pending;
  }
}
