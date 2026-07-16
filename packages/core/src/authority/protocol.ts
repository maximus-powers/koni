import { Buffer } from "node:buffer";

export const AUTHORITY_PROTOCOL = "koni.authority.v1" as const;
export const MAX_AUTHORITY_FRAME_BYTES = 16 * 1024 * 1024;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface ProtocolHandshake {
  protocol: typeof AUTHORITY_PROTOCOL;
  client: "cli" | "pi-extension" | "managed-session" | "tui";
  clientVersion: string;
  projectRoot: string;
  nonce: string;
}

export interface RpcRequest {
  type: "request";
  id: string;
  method: string;
  params?: JsonValue;
  expectedRevision?: number;
  idempotencyKey?: string;
}

export interface RpcSuccess {
  type: "response";
  id: string;
  ok: true;
  revision: number;
  result?: JsonValue;
}

export interface RpcFailure {
  type: "response";
  id: string;
  ok: false;
  revision: number;
  error: {
    code: string;
    message: string;
    retryable: boolean;
    details?: JsonValue;
  };
}

export interface RpcEvent {
  type: "event";
  sequence: number;
  revision: number;
  topic: string;
  payload?: JsonValue;
}

export type RpcEnvelope = ProtocolHandshake | RpcRequest | RpcSuccess | RpcFailure | RpcEvent;

export class AuthorityProtocolError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "AuthorityProtocolError";
    this.code = code;
  }
}

export function encodeFrame(envelope: RpcEnvelope): Buffer {
  const payload = Buffer.from(JSON.stringify(envelope), "utf8");
  if (payload.byteLength === 0 || payload.byteLength > MAX_AUTHORITY_FRAME_BYTES) {
    throw new AuthorityProtocolError(
      "frame_size",
      `authority frame must contain between 1 and ${MAX_AUTHORITY_FRAME_BYTES} bytes`,
    );
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(payload.byteLength, 0);
  return Buffer.concat([header, payload]);
}

export class FrameDecoder {
  readonly #maxFrameBytes: number;
  #buffer = Buffer.alloc(0);

  public constructor(maxFrameBytes = MAX_AUTHORITY_FRAME_BYTES) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) {
      throw new AuthorityProtocolError("frame_limit", "frame limit must be a positive safe integer");
    }
    this.#maxFrameBytes = maxFrameBytes;
  }

  public push(chunk: Uint8Array): RpcEnvelope[] {
    if (chunk.byteLength > 0) {
      this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);
    }
    const frames: RpcEnvelope[] = [];
    while (this.#buffer.byteLength >= 4) {
      const length = this.#buffer.readUInt32BE(0);
      if (length === 0 || length > this.#maxFrameBytes) {
        this.#buffer = Buffer.alloc(0);
        throw new AuthorityProtocolError(
          "frame_size",
          `received authority frame length ${length}, limit ${this.#maxFrameBytes}`,
        );
      }
      if (this.#buffer.byteLength < length + 4) {
        break;
      }
      const payload = this.#buffer.subarray(4, length + 4);
      this.#buffer = this.#buffer.subarray(length + 4);
      frames.push(parseEnvelope(payload));
    }
    return frames;
  }

  public finish(): void {
    if (this.#buffer.byteLength !== 0) {
      const remaining = this.#buffer.byteLength;
      this.#buffer = Buffer.alloc(0);
      throw new AuthorityProtocolError(
        "truncated_frame",
        `authority stream ended with ${remaining} unconsumed bytes`,
      );
    }
  }
}

function parseEnvelope(payload: Buffer): RpcEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(payload.toString("utf8"));
  } catch {
    throw new AuthorityProtocolError("invalid_json", "authority frame is not valid UTF-8 JSON");
  }
  if (!isRecord(value) || typeof value.type !== "string" && typeof value.protocol !== "string") {
    throw new AuthorityProtocolError("invalid_envelope", "authority frame is not a protocol object");
  }
  if ("protocol" in value) {
    if (value.protocol !== AUTHORITY_PROTOCOL) {
      throw new AuthorityProtocolError(
        "protocol_version",
        `unsupported authority protocol ${String(value.protocol)}`,
      );
    }
    return value as unknown as ProtocolHandshake;
  }
  if (!new Set(["request", "response", "event"]).has(String(value.type))) {
    throw new AuthorityProtocolError("invalid_envelope", `unknown authority frame type ${String(value.type)}`);
  }
  return value as unknown as RpcEnvelope;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
