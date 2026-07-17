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
import { authorityRequestHash } from "./project-store.js";
import {
  assertExecutingCoreRuntimeCurrent,
  executingCoreRuntimeIdentity,
} from "../runtime/identity.js";

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
  /** Invoked only after the successful response bytes have flushed to the client. */
  afterResponse?: () => void;
  /** Permanently close request/internal-mutation admission before responding. */
  beginQuiesce?: boolean;
}

export interface AuthorityMethod {
  mutating: boolean;
  handle(context: AuthorityRequestContext): Promise<AuthorityMethodResult> | AuthorityMethodResult;
}

export interface AuthorityInternalMutationContext {
  revision: number;
}

export interface AuthorityServerOptions {
  projectRoot: string;
  version: string;
  /** Exact test/embedding override; production hashes the executing Core tree before listening. */
  buildSha256?: string;
  initialRevision?: number;
  /** Durable replay lookup performed before revision CAS, so retries survive authority restart. */
  lookupIdempotent?: (request: RpcRequest) => Promise<{
    revision: number;
    result?: JsonValue;
  } | undefined>;
}

interface MemoryIdempotencyEntry {
  requestHash: string;
  response: RpcSuccess | RpcFailure;
}

interface ClientState {
  socket: Socket;
  decoder: FrameDecoder;
  handshake: ProtocolHandshake | undefined;
  compatibilityOnly: boolean;
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
  readonly #idempotency = new Map<string, MemoryIdempotencyEntry>();
  #endpoint: AuthorityEndpoint | undefined;
  #lease: AuthorityLease | undefined;
  #server: Server | undefined;
  #revision: number;
  #sequence = 0;
  #mutationTail: Promise<void> = Promise.resolve();
  #stopping = false;
  #quiescing = false;
  #buildSha256: string | undefined;

  public constructor(options: AuthorityServerOptions) {
    this.#options = options;
    this.#revision = options.initialRevision ?? 0;
    this.register("authority.ping", {
      mutating: false,
      handle: () => ({
        result: {
          protocol: AUTHORITY_PROTOCOL,
          version: this.#options.version,
          buildSha256: this.#buildSha256 ?? this.#options.buildSha256 ?? "starting",
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
    this.#quiescing = false;
    if (this.#options.buildSha256 === undefined) {
      await assertExecutingCoreRuntimeCurrent();
      this.#buildSha256 = (await executingCoreRuntimeIdentity()).buildSha256;
    } else {
      this.#buildSha256 = this.#options.buildSha256;
    }
    const endpoint = await discoverAuthorityEndpoint(this.#options.projectRoot);
    const lease = await AuthorityLease.acquire(endpoint);
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
      // Keep the cross-process startup transaction through socket bind and permissions. Only now
      // may another starter observe the live lease/listener pair and fail as a duplicate.
      await lease.completeStartup();
    } catch (error) {
      for (const client of this.#clients) client.socket.destroy();
      this.#clients.clear();
      await closeServer(server);
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

  /**
   * Serialize a scheduler/session/recovery mutation through the same revision lane as RPC work.
   * The callback must durably commit its returned revision before it resolves.
   */
  public mutateInternal(
    handle: (context: AuthorityInternalMutationContext) => Promise<AuthorityMethodResult> | AuthorityMethodResult,
  ): Promise<AuthorityMethodResult> {
    const execute = async (): Promise<AuthorityMethodResult> => {
      if (this.#quiescing) {
        throw new AuthorityRpcError("authority_quiescing", "authority is quiescing for restart");
      }
      const result = await handle({ revision: this.#revision });
      const nextRevision = result.revision ?? this.#revision + 1;
      if (!Number.isSafeInteger(nextRevision) || nextRevision < this.#revision) {
        throw new AuthorityRpcError("invalid_revision", "internal mutation moved authority revision backwards");
      }
      if (nextRevision === this.#revision && (result.events?.length ?? 0) > 0) {
        throw new AuthorityRpcError("invalid_revision", "internal no-op attempted to publish mutation events");
      }
      this.#revision = nextRevision;
      for (const event of result.events ?? []) this.publish(event.topic, event.payload);
      return result;
    };
    const pending = this.#mutationTail.then(execute, execute);
    this.#mutationTail = pending.then(() => undefined, () => undefined);
    return pending;
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
    await this.#mutationTail;
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
    const client: ClientState = {
      socket,
      decoder: new FrameDecoder(),
      handshake: undefined,
      compatibilityOnly: false,
    };
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
    if (envelope.client === "compat-control") {
      client.handshake = envelope;
      client.compatibilityOnly = true;
      this.#sequence += 1;
      client.socket.write(encodeFrame({
        type: "event",
        sequence: this.#sequence,
        revision: this.#revision,
        topic: "authority.compatibility_control_ready",
        payload: {
          version: this.#options.version,
          buildSha256: this.#buildSha256 ?? "unavailable",
        },
      }));
      return;
    }
    if (
      envelope.clientVersion !== this.#options.version ||
      envelope.clientBuildSha256 !== this.#buildSha256
    ) {
      this.#sequence += 1;
      client.socket.end(encodeFrame({
        type: "event",
        sequence: this.#sequence,
        revision: this.#revision,
        topic: "authority.incompatible",
        payload: {
          version: this.#options.version,
          buildSha256: this.#buildSha256 ?? "unavailable",
          clientVersion: envelope.clientVersion,
          clientBuildSha256: envelope.clientBuildSha256,
        },
      }));
      return;
    }
    client.handshake = envelope;
    this.#sequence += 1;
    client.socket.write(
      encodeFrame({
        type: "event",
        sequence: this.#sequence,
        revision: this.#revision,
        topic: "authority.ready",
        payload: { version: this.#options.version, buildSha256: this.#buildSha256! },
      }),
    );
  }

  async #dispatch(client: ClientState, request: RpcRequest): Promise<void> {
    if (client.compatibilityOnly && request.method !== "authority.quiesce") {
      this.#writeFailure(
        client,
        request.id,
        "compatibility_control_only",
        "cross-build control clients may only quiesce the running authority",
        false,
      );
      return;
    }
    const method = this.#methods.get(request.method);
    if (method === undefined) {
      this.#writeFailure(client, request.id, "method_not_found", `unknown method: ${request.method}`, false);
      return;
    }
    const execute = async () => {
      if (this.#quiescing && request.method !== "authority.quiesce") {
        this.#writeFailure(
          client,
          request.id,
          "authority_quiescing",
          "authority is quiescing for restart and accepts no further work",
          true,
        );
        return;
      }
      const requestHash = authorityRequestHash(request.method, request.params);
      const cached = request.idempotencyKey === undefined
        ? undefined
        : this.#idempotency.get(`${request.method}\0${request.idempotencyKey}`);
      if (cached !== undefined) {
        if (cached.requestHash !== requestHash) {
          this.#writeFailure(
            client,
            request.id,
            "idempotency_reuse",
            "idempotency key was already used with a different request",
            false,
          );
          return;
        }
        client.socket.write(encodeFrame({ ...cached.response, id: request.id, revision: this.#revision }));
        return;
      }
      if (request.idempotencyKey !== undefined && this.#options.lookupIdempotent !== undefined) {
        try {
          const durable = await this.#options.lookupIdempotent(request);
          if (durable !== undefined) {
            if (durable.revision > this.#revision) {
              throw new AuthorityRpcError(
                "revision_desync",
                "durable replay is newer than the running authority revision",
              );
            }
            const response: RpcSuccess = {
              type: "response",
              id: request.id,
              ok: true,
              revision: this.#revision,
              ...(durable.result === undefined ? {} : { result: durable.result }),
            };
            this.#remember(request, response);
            client.socket.write(encodeFrame(response));
            return;
          }
        } catch (error) {
          const rpcError = error instanceof AuthorityRpcError
            ? error
            : new AuthorityRpcError(
              error instanceof Error && "code" in error && typeof error.code === "string"
                ? error.code
                : "idempotency_lookup",
              error instanceof Error ? error.message : String(error),
            );
          this.#writeFailure(
            client,
            request.id,
            rpcError.code,
            rpcError.message,
            rpcError.retryable,
            rpcError.details,
          );
          return;
        }
      }
      // Quiesce is the emergency compatibility mutation: a provider may be
      // emitting usage while a new build connects, so requiring a client-side
      // revision snapshot could starve shutdown forever. It still executes in
      // this serialized lane and receives the exact current revision.
      if (method.mutating && request.method !== "authority.quiesce" &&
          request.expectedRevision !== this.#revision) {
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
        if (result.beginQuiesce === true) this.#quiescing = true;
        const response: RpcSuccess = {
          type: "response",
          id: request.id,
          ok: true,
          revision: this.#revision,
          ...(result.result === undefined ? {} : { result: result.result }),
        };
        this.#remember(request, response);
        client.socket.write(encodeFrame(response), () => result.afterResponse?.());
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
    // Reads share the same lane so their revision and projected bytes cannot straddle a commit.
    const pending = this.#mutationTail.then(execute, execute);
    this.#mutationTail = pending.then(() => undefined, () => undefined);
    await pending;
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
    this.#idempotency.set(`${request.method}\0${request.idempotencyKey}`, {
      requestHash: authorityRequestHash(request.method, request.params),
      response,
    });
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      try {
        server.close();
      } catch {
        // A listen failure may leave an unstarted Server that has nothing to close.
      }
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

function isHandshake(value: unknown): value is ProtocolHandshake {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.protocol === AUTHORITY_PROTOCOL &&
    new Set(["cli", "pi-extension", "managed-session", "tui", "compat-control"]).has(String(value.client)) &&
    typeof value.clientVersion === "string" &&
    typeof value.clientBuildSha256 === "string" &&
    /^sha256:[0-9a-f]{64}$/u.test(value.clientBuildSha256) &&
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
