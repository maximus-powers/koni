import type { Duplex } from "node:stream";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { HostError } from "./errors.js";
import type { SecretRedactor } from "./redaction.js";

export const CREDENTIAL_PROTOCOL_VERSION = 1 as const;
export const MAX_CREDENTIAL_FRAME_BYTES = 64 * 1024;

interface CredentialFrameBase {
  protocol_version: typeof CREDENTIAL_PROTOCOL_VERSION;
  request_id: string;
}

type CredentialRequestFrame =
  | (CredentialFrameBase & { frame: "read"; lease_id: string })
  | (CredentialFrameBase & { frame: "modify_begin"; lease_id: string })
  | (CredentialFrameBase & {
      frame: "modify_commit";
      lease_id: string;
      transaction_id: string;
      credential: OAuthCredential;
    })
  | (CredentialFrameBase & {
      frame: "modify_abort";
      lease_id: string;
      transaction_id: string;
      reason: string;
    })
  | (CredentialFrameBase & { frame: "delete"; lease_id: string });

type CredentialResponseFrame =
  | (CredentialFrameBase & {
      frame: "read_result";
      lease_id: string;
      revision: number;
      credential: OAuthCredential | null;
    })
  | (CredentialFrameBase & {
      frame: "modify_begin_result";
      lease_id: string;
      transaction_id: string;
      current: OAuthCredential | null;
    })
  | (CredentialFrameBase & {
      frame: "modify_commit_result";
      lease_id: string;
      transaction_id: string;
      credential: OAuthCredential;
    })
  | (CredentialFrameBase & {
      frame: "modify_abort_result";
      lease_id: string;
      transaction_id: string;
    })
  | (CredentialFrameBase & { frame: "delete_result"; lease_id: string })
  | (CredentialFrameBase & {
      frame: "error";
      code: string;
      message: string;
      retryable: boolean;
    });

type CredentialRequestFields = CredentialRequestFrame extends infer T
  ? T extends CredentialRequestFrame
    ? Omit<T, "protocol_version" | "request_id">
    : never
  : never;

interface PendingCredentialRequest {
  resolve(frame: CredentialResponseFrame): void;
  reject(error: unknown): void;
  timeout: NodeJS.Timeout;
}

export interface CredentialModifyTransaction {
  transactionId: string;
  current?: OAuthCredential;
}

export interface CredentialClient {
  read(leaseId: string): Promise<OAuthCredential | undefined>;
  beginModify(leaseId: string): Promise<CredentialModifyTransaction>;
  commitModify(leaseId: string, transactionId: string, credential: OAuthCredential): Promise<OAuthCredential>;
  abortModify(leaseId: string, transactionId: string, reason: string): Promise<void>;
  delete(leaseId: string): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateId(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new HostError("PROTOCOL_ERROR", `${name} is invalid`);
  }
  return value;
}

function parseCredential(value: unknown): OAuthCredential | undefined {
  if (value === null || value === undefined) return undefined;
  if (
    !isRecord(value) ||
    value["type"] !== "oauth" ||
    typeof value["access"] !== "string" ||
    value["access"].length === 0 ||
    typeof value["refresh"] !== "string" ||
    value["refresh"].length === 0 ||
    typeof value["expires"] !== "number" ||
    !Number.isFinite(value["expires"])
  ) {
    throw new HostError("PROTOCOL_ERROR", "private broker returned an invalid OAuth credential");
  }
  return structuredClone(value) as OAuthCredential;
}

function parseResponse(value: unknown): CredentialResponseFrame {
  if (!isRecord(value) || value["protocol_version"] !== CREDENTIAL_PROTOCOL_VERSION) {
    throw new HostError("PROTOCOL_ERROR", "invalid private credential protocol version");
  }
  validateId(value["request_id"], "credential request_id");
  const frame = value["frame"];
  if (
    frame !== "read_result" &&
    frame !== "modify_begin_result" &&
    frame !== "modify_commit_result" &&
    frame !== "modify_abort_result" &&
    frame !== "delete_result" &&
    frame !== "error"
  ) {
    throw new HostError("PROTOCOL_ERROR", "private credential channel received a host-only or unknown frame");
  }
  if (frame !== "error") validateId(value["lease_id"], "credential lease_id");
  if (frame === "modify_begin_result" || frame === "modify_commit_result" || frame === "modify_abort_result") {
    validateId(value["transaction_id"], "credential transaction_id");
  }
  if (frame === "read_result") {
    if (typeof value["revision"] !== "number" || !Number.isSafeInteger(value["revision"]) || value["revision"] < 0) {
      throw new HostError("PROTOCOL_ERROR", "credential revision is invalid");
    }
    parseCredential(value["credential"]);
  }
  if (frame === "modify_begin_result") parseCredential(value["current"]);
  if (frame === "modify_commit_result") parseCredential(value["credential"]);
  if (frame === "error") {
    if (typeof value["code"] !== "string" || typeof value["message"] !== "string" || typeof value["retryable"] !== "boolean") {
      throw new HostError("PROTOCOL_ERROR", "private credential error frame is invalid");
    }
  }
  return value as unknown as CredentialResponseFrame;
}

export class PrivateCredentialChannel implements CredentialClient {
  private readonly pending = new Map<string, PendingCredentialRequest>();
  private writeChain: Promise<void> = Promise.resolve();
  private nextRequestId = 1;
  private closed = false;

  constructor(
    private readonly socket: Duplex,
    private readonly redactor: SecretRedactor,
  ) {}

  async run(): Promise<void> {
    let pendingBytes: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    try {
      for await (const rawChunk of this.socket) {
        const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk as Uint8Array);
        pendingBytes = pendingBytes.length === 0 ? chunk : Buffer.concat([pendingBytes, chunk]);
        let newline = pendingBytes.indexOf(0x0a);
        while (newline >= 0) {
          const line = Buffer.from(pendingBytes.subarray(0, newline));
          pendingBytes = pendingBytes.subarray(newline + 1);
          if (line.length === 0 || line.length > MAX_CREDENTIAL_FRAME_BYTES) {
            line.fill(0);
            throw new HostError("PROTOCOL_ERROR", "private credential frame is blank or oversized");
          }
          let decoded: unknown;
          try {
            decoded = JSON.parse(line.toString("utf8"));
          } catch {
            throw new HostError("PROTOCOL_ERROR", "private credential frame contains malformed JSON");
          } finally {
            line.fill(0);
          }
          this.receive(parseResponse(decoded));
          newline = pendingBytes.indexOf(0x0a);
        }
        if (pendingBytes.length > MAX_CREDENTIAL_FRAME_BYTES) {
          pendingBytes.fill(0);
          throw new HostError("PROTOCOL_ERROR", "private credential frame exceeds 65536 bytes");
        }
      }
      if (pendingBytes.length !== 0) throw new HostError("PROTOCOL_ERROR", "private credential frame ended before newline");
    } finally {
      pendingBytes.fill(0);
      this.close();
    }
  }

  async read(leaseId: string): Promise<OAuthCredential | undefined> {
    const response = await this.request({ frame: "read", lease_id: validateId(leaseId, "credential lease_id") });
    if (response.frame !== "read_result") throw this.unexpected("read_result", response.frame);
    const credential = parseCredential(response.credential);
    this.redactor.addCredential(credential);
    return credential;
  }

  async beginModify(leaseId: string): Promise<CredentialModifyTransaction> {
    const response = await this.request({
      frame: "modify_begin",
      lease_id: validateId(leaseId, "credential lease_id"),
    });
    if (response.frame !== "modify_begin_result") throw this.unexpected("modify_begin_result", response.frame);
    const current = parseCredential(response.current);
    this.redactor.addCredential(current);
    const result: CredentialModifyTransaction = { transactionId: response.transaction_id };
    if (current !== undefined) result.current = current;
    return result;
  }

  async commitModify(
    leaseId: string,
    transactionId: string,
    credential: OAuthCredential,
  ): Promise<OAuthCredential> {
    this.redactor.addCredential(credential);
    const response = await this.request({
      frame: "modify_commit",
      lease_id: validateId(leaseId, "credential lease_id"),
      transaction_id: validateId(transactionId, "credential transaction_id"),
      credential,
    });
    if (response.frame !== "modify_commit_result") throw this.unexpected("modify_commit_result", response.frame);
    const committed = parseCredential(response.credential);
    if (!committed) throw new HostError("PROTOCOL_ERROR", "modify_commit_result omitted its credential");
    this.redactor.addCredential(committed);
    return committed;
  }

  async abortModify(leaseId: string, transactionId: string, reason: string): Promise<void> {
    const response = await this.request({
      frame: "modify_abort",
      lease_id: validateId(leaseId, "credential lease_id"),
      transaction_id: validateId(transactionId, "credential transaction_id"),
      reason: reason.slice(0, 256),
    });
    if (response.frame !== "modify_abort_result") throw this.unexpected("modify_abort_result", response.frame);
  }

  async delete(leaseId: string): Promise<void> {
    const response = await this.request({ frame: "delete", lease_id: validateId(leaseId, "credential lease_id") });
    if (response.frame !== "delete_result") throw this.unexpected("delete_result", response.frame);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const error = new HostError("PROTOCOL_ERROR", "private credential channel closed");
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private async request(
    fields: CredentialRequestFields,
  ): Promise<CredentialResponseFrame> {
    if (this.closed) throw new HostError("PROTOCOL_ERROR", "private credential channel is closed");
    const requestId = `credential-${this.nextRequestId++}`;
    const frame = {
      ...fields,
      protocol_version: CREDENTIAL_PROTOCOL_VERSION,
      request_id: requestId,
    } as CredentialRequestFrame;
    const response = new Promise<CredentialResponseFrame>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new HostError("BROKER_TIMEOUT", "private credential broker timed out", { retryable: true }));
      }, 60_000);
      this.pending.set(requestId, { resolve, reject, timeout });
    });
    try {
      await this.send(frame);
    } catch (error) {
      const pending = this.pending.get(requestId);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pending.delete(requestId);
        pending.reject(error);
      }
      throw error;
    }
    return response;
  }

  private receive(frame: CredentialResponseFrame): void {
    const pending = this.pending.get(frame.request_id);
    if (!pending) throw new HostError("PROTOCOL_ERROR", `unexpected private response ${frame.request_id}`);
    this.pending.delete(frame.request_id);
    clearTimeout(pending.timeout);
    if (frame.frame === "error") {
      pending.reject(
        new HostError("PROVIDER_ERROR", this.redactor.redact(frame.message), {
          retryable: frame.retryable,
          details: frame.code,
        }),
      );
      return;
    }
    pending.resolve(frame);
  }

  private send(frame: CredentialRequestFrame): Promise<void> {
    const encoded = `${JSON.stringify(frame)}\n`;
    if (Buffer.byteLength(encoded, "utf8") > MAX_CREDENTIAL_FRAME_BYTES) {
      throw new HostError("PROTOCOL_ERROR", "outgoing private credential frame exceeds 65536 bytes");
    }
    const write = this.writeChain.then(
      () =>
        new Promise<void>((resolve, reject) => {
          this.socket.write(encoded, "utf8", (error) => (error ? reject(error) : resolve()));
        }),
    );
    this.writeChain = write.catch(() => undefined);
    return write;
  }

  private unexpected(expected: string, actual: string): HostError {
    return new HostError("PROTOCOL_ERROR", `private credential broker returned ${actual}; expected ${expected}`);
  }
}
