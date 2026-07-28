import { randomBytes, randomUUID } from "node:crypto";
import net, { type Socket } from "node:net";
import {
  AUTHORITY_PROTOCOL,
  encodeFrame,
  FrameDecoder,
  type JsonValue,
  type ProtocolHandshake,
  type RpcEnvelope,
  type RpcEvent,
  type RpcFailure,
  type RpcRequest,
  type RpcSuccess,
} from "./protocol.js";
import { discoverAuthorityEndpoint } from "./endpoint.js";
import {
  assertExecutingCoreRuntimeCurrent,
  executingCoreRuntimeIdentity,
} from "../runtime/identity.js";

export interface AuthorityClientOptions {
  projectRoot: string;
  client: ProtocolHandshake["client"];
  version: string;
  /** Exact test/embedding override; normal clients hash their executing Core tree. */
  buildSha256?: string;
  /** Stable local control path used only to quiesce an older/newer Core build. */
  compatibilityControl?: boolean;
  connectTimeoutMs?: number;
}

export class AuthorityClientError extends Error {
  public readonly code: string;
  public readonly retryable: boolean;
  public readonly revision: number | undefined;
  public readonly details: JsonValue | undefined;

  public constructor(
    code: string,
    message: string,
    options: { retryable?: boolean; revision?: number; details?: JsonValue } = {},
  ) {
    super(message);
    this.name = "AuthorityClientError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.revision = options.revision;
    this.details = options.details;
  }
}

export class AuthorityClient {
  readonly #socket: Socket;
  readonly #decoder = new FrameDecoder();
  readonly #pending = new Map<
    string,
    {
      resolve(value: RpcSuccess): void;
      reject(error: Error): void;
    }
  >();
  readonly #listeners = new Set<(event: RpcEvent) => void>();
  #revision = 0;
  #closed = false;

  private constructor(socket: Socket) {
    this.#socket = socket;
    socket.on("data", (chunk: Buffer) => this.#receive(chunk));
    socket.once("close", () =>
      this.#closePending(new AuthorityClientError("closed", "authority connection closed")),
    );
    socket.once("error", (error) => this.#closePending(error));
  }

  public get revision(): number {
    return this.#revision;
  }

  public static async connect(options: AuthorityClientOptions): Promise<AuthorityClient> {
    const target = await discoverAuthorityEndpoint(options.projectRoot);
    let buildSha256 = options.buildSha256;
    if (buildSha256 === undefined) {
      const executing = await executingCoreRuntimeIdentity();
      // Compatibility control is intentionally able to quiesce an old authority after an
      // in-place update. Every ordinary operation requires the loaded JS and disk to agree.
      if (options.compatibilityControl !== true) await assertExecutingCoreRuntimeCurrent();
      buildSha256 = executing.buildSha256;
    }
    const socket = net.createConnection(target.endpoint);
    socket.setNoDelay(true);
    const client = new AuthorityClient(socket);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(
          new AuthorityClientError("connect_timeout", "timed out connecting to Koni authority"),
        );
      }, options.connectTimeoutMs ?? 5_000);
      timer.unref();
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(
          new AuthorityClientError("handshake_timeout", "authority did not accept the handshake"),
        );
      }, options.connectTimeoutMs ?? 5_000);
      timer.unref();
      const unsubscribe = client.onEvent((event) => {
        if (event.topic === "authority.compatibility_control_ready") {
          if (options.compatibilityControl !== true) return;
          clearTimeout(timer);
          unsubscribe();
          resolve();
        } else if (event.topic === "authority.ready") {
          clearTimeout(timer);
          unsubscribe();
          if (
            !isRecord(event.payload) ||
            event.payload.version !== options.version ||
            event.payload.buildSha256 !== buildSha256
          ) {
            reject(
              new AuthorityClientError(
                "runtime_mismatch",
                "running Koni authority does not match this Core version/build; preserve or pause runs, restart the authority, then reconnect",
                isRecord(event.payload) ? { details: event.payload } : {},
              ),
            );
          } else {
            resolve();
          }
        } else if (event.topic === "authority.incompatible") {
          clearTimeout(timer);
          unsubscribe();
          reject(
            new AuthorityClientError(
              "runtime_mismatch",
              "running Koni authority does not match this Core version/build; preserve or pause runs, restart the authority, then reconnect",
              isRecord(event.payload) ? { details: event.payload } : {},
            ),
          );
        } else if (event.topic === "authority.starting") {
          clearTimeout(timer);
          unsubscribe();
          reject(
            new AuthorityClientError(
              "authority_starting",
              "Koni authority is completing durable startup recovery",
              { retryable: true },
            ),
          );
        }
      });
    });
    const handshake: ProtocolHandshake = {
      protocol: AUTHORITY_PROTOCOL,
      client: options.compatibilityControl === true ? "compat-control" : options.client,
      clientVersion: options.version,
      clientBuildSha256: buildSha256,
      projectRoot: target.identity.worktreeRoot,
      nonce: randomBytes(24).toString("base64url"),
    };
    socket.write(encodeFrame(handshake));
    try {
      await ready;
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  public onEvent(listener: (event: RpcEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public async request(
    method: string,
    params?: JsonValue,
    options: { expectedRevision?: number; idempotencyKey?: string } = {},
  ): Promise<RpcSuccess> {
    if (this.#closed) {
      throw new AuthorityClientError("closed", "authority connection is closed");
    }
    const id = randomUUID();
    const request: RpcRequest = {
      type: "request",
      id,
      method,
      ...(params === undefined ? {} : { params }),
      ...(options.expectedRevision === undefined
        ? {}
        : { expectedRevision: options.expectedRevision }),
      ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
    };
    const response = new Promise<RpcSuccess>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    this.#socket.write(encodeFrame(request));
    return response;
  }

  public close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#socket.end();
    this.#closePending(new AuthorityClientError("closed", "authority client closed"));
  }

  #receive(chunk: Buffer): void {
    try {
      for (const envelope of this.#decoder.push(chunk)) {
        this.#handle(envelope);
      }
    } catch (error) {
      this.#socket.destroy();
      this.#closePending(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #handle(envelope: RpcEnvelope): void {
    if (isEvent(envelope)) {
      this.#revision = Math.max(this.#revision, envelope.revision);
      for (const listener of this.#listeners) {
        listener(envelope);
      }
      return;
    }
    if (!isResponse(envelope)) {
      throw new AuthorityClientError(
        "unexpected_envelope",
        "authority sent an unexpected envelope",
      );
    }
    this.#revision = Math.max(this.#revision, envelope.revision);
    const pending = this.#pending.get(envelope.id);
    if (pending === undefined) {
      throw new AuthorityClientError(
        "unknown_response",
        `authority responded to unknown request ${envelope.id}`,
      );
    }
    this.#pending.delete(envelope.id);
    if (envelope.ok) {
      pending.resolve(envelope);
    } else {
      pending.reject(
        new AuthorityClientError(envelope.error.code, envelope.error.message, {
          retryable: envelope.error.retryable,
          revision: envelope.revision,
          ...(envelope.error.details === undefined ? {} : { details: envelope.error.details }),
        }),
      );
    }
  }

  #closePending(error: Error): void {
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

function isEvent(value: RpcEnvelope): value is RpcEvent {
  return "type" in value && value.type === "event";
}

function isResponse(value: RpcEnvelope): value is RpcSuccess | RpcFailure {
  return "type" in value && value.type === "response";
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
