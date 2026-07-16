import { chmod, rm } from "node:fs/promises";
import net, { type Server, type Socket } from "node:net";
import {
  AUTHORITY_PROTOCOL,
  AuthorityProtocolError,
  encodeFrame,
  FrameDecoder,
  type JsonValue,
  type ProtocolHandshake,
  type RpcEvent,
  type RpcFailure,
  type RpcRequest,
  type RpcSuccess,
} from "./protocol.js";
import {
  AuthorityLease,
  discoverAuthorityEndpoint,
  type AuthorityEndpoint,
} from "./endpoint.js";

const MAX_CLIENTS = 128;
const MAX_IDEMPOTENCY_ENTRIES = 10_000;

export interface AuthorityRequestContext {
  handshake: ProtocolHandshake;
  request: RpcRequest;
  revision: number;
}

export interface AuthorityMethodResult {
  result?: JsonValue;
  revision?: number;
  events?: readonly { topic: string; payload?: JsonValue }[];
}

export interface AuthorityMethod {
  mutating: boolean;
  handle(context: AuthorityRequestContext): Promise<AuthorityMethodResult> | AuthorityMethodResult;
}

export interface AuthorityServerOptions {
  projectRoot: string;
  version: string;
  initialRevision?: number;
}

interface ClientState {
  socket: Socket;
  decoder: FrameDecoder;
  handshake: ProtocolHandshake | undefined;
}

export class AuthorityRpcError extends Error {
  public readonly code: string;
  public readonly retryable: boolean;
  public readonly details: JsonValue | undefined;

  public constructor(
    code: string,
    message: string,
    options: { retryable?: boolean; details?: JsonValue } = {},
  ) {
    super(message);
    this.name = "AuthorityRpcError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export class AuthorityServer {
  readonly #options: AuthorityServerOptions;
  readonly #methods = new Map<string, AuthorityMethod>();
  readonly #clients = new Set<ClientState>();
  readonly #idempotency = new Map<string, RpcSuccess | RpcFailure>();
  #endpoint: AuthorityEndpoint | undefined;
  #lease: AuthorityLease | undefined;
  #server: Server | undefined;
  #revision: number;
  #sequence = 0;
  #mutationTail: Promise<void> = Promise.resolve();
  #stopping = false;

  public constructor(options: AuthorityServerOptions) {
    this.#options = options;
    this.#revision = options.initialRevision ?? 0;
    this.register("authority.ping", {
      mutating: false,
      handle: () => ({
        result: {
          protocol: AUTHORITY_PROTOCOL,
          version: this.#options.version,
          revision: this.#revision,
        },
      }),
    });
  }

  public get revision(): number {
    return this.#revision;
  }

  public get endpoint(): AuthorityEndpoint | undefined {
    return this.#endpoint;
  }

  public register(method: string, definition: AuthorityMethod): void {
    if (!/^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/u.test(method)) {
      throw new Error(`invalid authority method name: ${method}`);
    }
    if (this.#methods.has(method)) {
      throw new Error(`authority method is already registered: ${method}`);
    }
    this.#methods.set(method, definition);
  }

  public async start(): Promise<AuthorityEndpoint> {
    if (this.#server !== undefined) {
      throw new Error("authority server is already started");
    }
    const endpoint = await discoverAuthorityEndpoint(this.#options.projectRoot);
    const lease = await AuthorityLease.acquire(endpoint);
    if (process.platform !== "win32") {
      await rm(endpoint.endpoint, { force: true });
    }
    const server = net.createServer((socket) => this.#accept(socket));
    server.maxConnections = MAX_CLIENTS;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(endpoint.endpoint);
      });
      if (process.platform !== "win32") {
        await chmod(endpoint.endpoint, 0o600);
      }
    } catch (error) {
      server.close();
      await lease.release();
      throw error;
    }
    this.#endpoint = endpoint;
    this.#lease = lease;
    this.#server = server;
    return endpoint;
  }

  public publish(topic: string, payload?: JsonValue): void {
    this.#sequence += 1;
    const event: RpcEvent = {
      type: "event",
      sequence: this.#sequence,
      revision: this.#revision,
      topic,
      ...(payload === undefined ? {} : { payload }),
    };
    const bytes = encodeFrame(event);
    for (const client of this.#clients) {
      if (client.handshake !== undefined && !client.socket.destroyed) {
        client.socket.write(bytes);
      }
    }
  }

  public async stop(): Promise<void> {
    if (this.#stopping) {
      return;
    }
    this.#stopping = true;
    const server = this.#server;
    this.#server = undefined;
    for (const client of this.#clients) {
      client.socket.destroy();
    }
    this.#clients.clear();
    if (server !== undefined) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (this.#endpoint !== undefined && process.platform !== "win32") {
      await rm(this.#endpoint.endpoint, { force: true });
    }
    if (this.#lease !== undefined) {
      await this.#lease.release();
    }
    this.#lease = undefined;
    this.#endpoint = undefined;
    this.#stopping = false;
  }

  #accept(socket: Socket): void {
    socket.setNoDelay(true);
    socket.setTimeout(60_000);
    const client: ClientState = { socket, decoder: new FrameDecoder(), handshake: undefined };
    this.#clients.add(client);
    socket.on("timeout", () => socket.destroy());
    socket.on("data", (chunk: Buffer) => {
      try {
        for (const envelope of client.decoder.push(chunk)) {
          if (client.handshake === undefined) {
            this.#acceptHandshake(client, envelope);
          } else if (isRequest(envelope)) {
            void this.#dispatch(client, envelope);
          } else {
            throw new AuthorityProtocolError("unexpected_envelope", "client sent a non-request envelope");
          }
        }
      } catch (error) {
        socket.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once("close", () => this.#clients.delete(client));
    socket.once("error", () => this.#clients.delete(client));
  }

  #acceptHandshake(client: ClientState, envelope: unknown): void {
    if (!isHandshake(envelope)) {
      throw new AuthorityProtocolError("handshake_required", "first authority frame must be a handshake");
    }
    const expectedRoot = this.#endpoint?.identity.worktreeRoot;
    if (expectedRoot === undefined || envelope.projectRoot !== expectedRoot) {
      throw new AuthorityProtocolError("project_mismatch", "client connected for a different project root");
    }
    client.handshake = envelope;
    this.#sequence += 1;
    client.socket.write(
      encodeFrame({
        type: "event",
        sequence: this.#sequence,
        revision: this.#revision,
        topic: "authority.ready",
        payload: { version: this.#options.version },
      }),
    );
  }

  async #dispatch(client: ClientState, request: RpcRequest): Promise<void> {
    const method = this.#methods.get(request.method);
    if (method === undefined) {
      this.#writeFailure(client, request.id, "method_not_found", `unknown method: ${request.method}`, false);
      return;
    }
    const execute = async () => {
      const cached = request.idempotencyKey === undefined
        ? undefined
        : this.#idempotency.get(`${request.method}\0${request.idempotencyKey}`);
      if (cached !== undefined) {
        client.socket.write(encodeFrame({ ...cached, id: request.id }));
        return;
      }
      if (method.mutating && request.expectedRevision !== this.#revision) {
        this.#writeFailure(
          client,
          request.id,
          "revision_conflict",
          `expected revision ${String(request.expectedRevision)}, current revision ${this.#revision}`,
          true,
        );
        return;
      }
      try {
        const result = await method.handle({
          handshake: client.handshake!,
          request,
          revision: this.#revision,
        });
        if (method.mutating) {
          const nextRevision = result.revision ?? this.#revision + 1;
          if (!Number.isSafeInteger(nextRevision) || nextRevision <= this.#revision) {
            throw new AuthorityRpcError("invalid_revision", "mutation did not advance authority revision");
          }
          this.#revision = nextRevision;
        } else if (result.revision !== undefined && result.revision !== this.#revision) {
          throw new AuthorityRpcError("invalid_revision", "read-only method attempted to change revision");
        }
        const response: RpcSuccess = {
          type: "response",
          id: request.id,
          ok: true,
          revision: this.#revision,
          ...(result.result === undefined ? {} : { result: result.result }),
        };
        this.#remember(request, response);
        client.socket.write(encodeFrame(response));
        for (const event of result.events ?? []) {
          this.publish(event.topic, event.payload);
        }
      } catch (error) {
        const rpcError = error instanceof AuthorityRpcError
          ? error
          : new AuthorityRpcError("internal", error instanceof Error ? error.message : String(error));
        this.#writeFailure(client, request.id, rpcError.code, rpcError.message, rpcError.retryable, rpcError.details, request);
      }
    };
    if (method.mutating) {
      const pending = this.#mutationTail.then(execute, execute);
      this.#mutationTail = pending.then(() => undefined, () => undefined);
      await pending;
    } else {
      await execute();
    }
  }

  #writeFailure(
    client: ClientState,
    id: string,
    code: string,
    message: string,
    retryable: boolean,
    details?: JsonValue,
    request?: RpcRequest,
  ): void {
    const response: RpcFailure = {
      type: "response",
      id,
      ok: false,
      revision: this.#revision,
      error: { code, message, retryable, ...(details === undefined ? {} : { details }) },
    };
    if (request !== undefined) {
      this.#remember(request, response);
    }
    client.socket.write(encodeFrame(response));
  }

  #remember(request: RpcRequest, response: RpcSuccess | RpcFailure): void {
    if (request.idempotencyKey === undefined) {
      return;
    }
    if (this.#idempotency.size >= MAX_IDEMPOTENCY_ENTRIES) {
      const oldest = this.#idempotency.keys().next().value as string | undefined;
      if (oldest !== undefined) {
        this.#idempotency.delete(oldest);
      }
    }
    this.#idempotency.set(`${request.method}\0${request.idempotencyKey}`, response);
  }
}

function isHandshake(value: unknown): value is ProtocolHandshake {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.protocol === AUTHORITY_PROTOCOL &&
    new Set(["cli", "pi-extension", "managed-session", "tui"]).has(String(value.client)) &&
    typeof value.clientVersion === "string" &&
    typeof value.projectRoot === "string" &&
    typeof value.nonce === "string" &&
    value.nonce.length >= 8
  );
}

function isRequest(value: unknown): value is RpcRequest {
  return (
    isRecord(value) &&
    value.type === "request" &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.method === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
