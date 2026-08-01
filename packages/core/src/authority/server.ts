import { chmod, rm } from "node:fs/promises";
import { AsyncLocalStorage } from "node:async_hooks";
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
import { AuthorityLease, discoverAuthorityEndpoint, type AuthorityEndpoint } from "./endpoint.js";
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
  /**
   * Global CAS is the default. Semantic-CAS mutations bind authority to an exact resource digest
   * in their request and validate that digest in the handler, so unrelated authority revisions
   * must not make an already-reviewed operator action stale while it waits in the mutation lane.
   */
  revisionPolicy?: "global" | "semantic";
  handle(context: AuthorityRequestContext): Promise<AuthorityMethodResult> | AuthorityMethodResult;
  /** Join an already-authorized continuation after an exact cached response is flushed. */
  afterIdempotentReplay?(context: AuthorityRequestContext, response: RpcSuccess): void;
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
  /** Recovered durable quiesce tombstone; only scoped settlement and compatibility control start. */
  initialQuiescing?: boolean;
  /** Keep the listener discoverable but reject handshakes until engine recovery completes. */
  deferReadyUntilRecovery?: boolean;
  /** Durable replay lookup performed before revision CAS, so retries survive authority restart. */
  lookupIdempotent?: (request: RpcRequest) => Promise<
    | {
        revision: number;
        result?: JsonValue;
      }
    | undefined
  >;
  /** Engine-owned lease acquired before opening/recovering authority storage. */
  preacquiredAuthority?: { endpoint: AuthorityEndpoint; lease: AuthorityLease };
}

interface MemoryIdempotencyEntry {
  requestHash: string;
  response: RpcSuccess | RpcFailure;
}

interface QuiesceSettlementLease {
  active: boolean;
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
  #startAttempted = false;
  #startPromise: Promise<AuthorityEndpoint> | undefined;
  #revision: number;
  #sequence = 0;
  #mutationTail: Promise<void> = Promise.resolve();
  #stopPromise: Promise<void> | undefined;
  #externalAdmissionClosed = false;
  #internalAdmissionClosed = false;
  #quiescing = false;
  #ready = true;
  #startupRecoveryPending = false;
  #startupQuiesceRecoveryPending = false;
  #startupStateConfigured = false;
  #bound = false;
  #internalMutationAdmitted = false;
  readonly #quiesceSettlementContext = new AsyncLocalStorage<QuiesceSettlementLease>();
  #buildSha256: string | undefined;

  public constructor(options: AuthorityServerOptions) {
    this.#options = options;
    this.#revision = options.initialRevision ?? 0;
    this.#quiescing = options.initialQuiescing === true;
    this.#startupRecoveryPending =
      options.deferReadyUntilRecovery === true || options.initialQuiescing === true;
    this.#ready = !this.#startupRecoveryPending;
    this.#startupQuiesceRecoveryPending = options.initialQuiescing === true;
    this.#endpoint = options.preacquiredAuthority?.endpoint;
    this.#lease = options.preacquiredAuthority?.lease;
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

  public start(): Promise<AuthorityEndpoint> {
    if (this.#startAttempted || this.#stopPromise !== undefined) {
      return Promise.reject(
        new Error("authority server lifecycle is terminal after its first start or stop attempt"),
      );
    }
    // Install the lifecycle tombstone synchronously, before endpoint discovery or lease acquisition.
    // A failed or concurrent start must never leave a reusable half-started server object.
    this.#startAttempted = true;
    this.#startPromise = this.#settleStart();
    return this.#startPromise;
  }

  async #settleStart(): Promise<AuthorityEndpoint> {
    this.#quiescing = this.#startupQuiesceRecoveryPending;
    this.#ready = !this.#startupRecoveryPending;
    this.#internalAdmissionClosed = false;
    this.#externalAdmissionClosed = false;
    const endpoint = this.#endpoint ?? (await discoverAuthorityEndpoint(this.#options.projectRoot));
    this.#assertStartNotStopping();
    const lease = this.#lease ?? (await AuthorityLease.acquire(endpoint));
    const server = net.createServer((socket) => this.#accept(socket));
    server.maxConnections = MAX_CLIENTS;
    try {
      if (this.#options.buildSha256 === undefined) {
        await assertExecutingCoreRuntimeCurrent();
        this.#buildSha256 = (await executingCoreRuntimeIdentity()).buildSha256;
      } else {
        this.#buildSha256 = this.#options.buildSha256;
      }
      this.#assertStartNotStopping();
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
      this.#assertStartNotStopping();
      // Keep the cross-process startup transaction through socket bind and permissions. Only now
      // may another starter observe the live lease/listener pair and fail as a duplicate.
      await lease.completeStartup();
      this.#assertStartNotStopping();
    } catch (error) {
      for (const client of this.#clients) client.socket.destroy();
      this.#clients.clear();
      await closeServer(server);
      await lease.release();
      this.#endpoint = undefined;
      this.#lease = undefined;
      throw error;
    }
    this.#endpoint = endpoint;
    this.#lease = lease;
    this.#server = server;
    this.#bound = true;
    return endpoint;
  }

  #assertStartNotStopping(): void {
    if (
      this.#stopPromise !== undefined ||
      this.#externalAdmissionClosed ||
      this.#internalAdmissionClosed
    ) {
      throw new AuthorityRpcError("authority_stopping", "authority stopped during startup", {
        retryable: true,
      });
    }
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
    handle: (
      context: AuthorityInternalMutationContext,
    ) => Promise<AuthorityMethodResult> | AuthorityMethodResult,
  ): Promise<AuthorityMethodResult> {
    if (this.#internalAdmissionClosed) {
      return Promise.reject(
        new AuthorityRpcError(
          "authority_stopping",
          "authority has closed internal mutation admission",
        ),
      );
    }
    this.#internalMutationAdmitted = true;
    const execute = async (): Promise<AuthorityMethodResult> => {
      if (this.#quiescing && this.#quiesceSettlementContext.getStore()?.active !== true) {
        throw new AuthorityRpcError("authority_quiescing", "authority is quiescing for restart");
      }
      const result = await handle({ revision: this.#revision });
      const nextRevision = result.revision ?? this.#revision + 1;
      if (!Number.isSafeInteger(nextRevision) || nextRevision < this.#revision) {
        throw new AuthorityRpcError(
          "invalid_revision",
          "internal mutation moved authority revision backwards",
        );
      }
      if (nextRevision === this.#revision && (result.events?.length ?? 0) > 0) {
        throw new AuthorityRpcError(
          "invalid_revision",
          "internal no-op attempted to publish mutation events",
        );
      }
      this.#revision = nextRevision;
      for (const event of result.events ?? []) this.publish(event.topic, event.payload);
      return result;
    };
    const pending = this.#mutationTail.then(execute, execute);
    this.#mutationTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  /** Synchronous shutdown tombstone installed while the process still owns the endpoint lease. */
  public closeExternalAdmission(): void {
    this.#externalAdmissionClosed = true;
  }

  /** Synchronous shutdown tombstone installed while the process still owns the endpoint lease. */
  public closeInternalAdmission(): void {
    this.#externalAdmissionClosed = true;
    this.#internalAdmissionClosed = true;
  }

  /** Await every mutation already admitted into the serialized authority lane. */
  public async drainMutationLane(): Promise<void> {
    await this.#mutationTail;
  }

  /**
   * Complete only the already-authorized quiesce transaction after its response has closed the
   * external mutation surface. Async-local scope prevents unrelated background work from using
   * this privilege while pause/Git/provider settlement drains through ordinary internal methods.
   */
  public async runQuiesceSettlement<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.#quiescing) {
      throw new AuthorityRpcError(
        "authority_not_quiescing",
        "quiesce settlement authority is available only after external admission is closed",
      );
    }
    const lease: QuiesceSettlementLease = { active: true };
    try {
      return await this.#quiesceSettlementContext.run(lease, operation);
    } finally {
      // Detached descendants inherit only this object; flipping it closes their privilege even
      // when their AsyncLocal context outlives the awaited settlement callback.
      lease.active = false;
    }
  }

  /** Rebind constructor-time state from the fresh snapshot read after acquiring the endpoint lease. */
  public configureStartupState(revision: number, quiescing: boolean): void {
    if (
      !this.#bound ||
      this.#startupStateConfigured ||
      this.#internalMutationAdmitted ||
      !this.#startupRecoveryPending ||
      this.#ready ||
      this.#internalAdmissionClosed ||
      !Number.isSafeInteger(revision) ||
      revision < this.#revision
    ) {
      throw new AuthorityRpcError(
        "authority_startup_configuration",
        "startup state may be configured only while the bound authority remains unready",
      );
    }
    this.#revision = revision;
    this.#startupStateConfigured = true;
    this.#startupQuiesceRecoveryPending = quiescing;
    this.#quiescing = quiescing;
  }

  /** Publish readiness exactly once after ordinary engine-owned startup recovery. */
  public completeStartupRecovery(): void {
    if (!this.#startupRecoveryPending || this.#startupQuiesceRecoveryPending || this.#quiescing) {
      throw new AuthorityRpcError(
        "authority_startup_recovery",
        "ordinary startup readiness may be published only after its pending recovery completes",
      );
    }
    this.#startupRecoveryPending = false;
    this.#ready = true;
  }

  /** Convert a failed, still-unready startup into a privileged fail-closed quiesce settlement. */
  public beginStartupFailureQuiesce(): void {
    if (!this.#startupRecoveryPending || this.#ready || this.#internalAdmissionClosed) {
      throw new AuthorityRpcError(
        "authority_startup_failure",
        "startup-failure settlement is available only while recovery remains unready",
      );
    }
    this.#quiescing = true;
  }

  /**
   * Reopen a freshly started authority only after its durable inherited quiesce has fully settled.
   * A live authority that initiated quiesce can never use this seam to cancel shutdown.
   */
  public completeRecoveredQuiesce(): void {
    if (
      !this.#startupRecoveryPending ||
      !this.#startupQuiesceRecoveryPending ||
      !this.#quiescing ||
      this.#quiesceSettlementContext.getStore()?.active !== true
    ) {
      throw new AuthorityRpcError(
        "authority_quiesce_recovery",
        "only privileged startup recovery may reopen authority admission",
      );
    }
    this.#startupRecoveryPending = false;
    this.#startupQuiesceRecoveryPending = false;
    this.#quiescing = false;
    this.#ready = true;
  }

  public stop(): Promise<void> {
    if (this.#stopPromise !== undefined) return this.#stopPromise;
    this.#stopPromise = this.#settleStop();
    return this.#stopPromise;
  }

  async #settleStop(): Promise<void> {
    this.#externalAdmissionClosed = true;
    this.#internalAdmissionClosed = true;
    // Startup owns listener/lease locals until it either publishes them together or cleans them up.
    // Join that attempt before snapshotting fields so shutdown cannot miss a late publication.
    if (this.#startPromise !== undefined) {
      try {
        await this.#startPromise;
      } catch {
        /* The start caller observes its own failure; shutdown still completes cleanup. */
      }
    }
    const server = this.#server;
    this.#server = undefined;
    for (const client of this.#clients) {
      client.socket.destroy();
    }
    this.#clients.clear();
    const endpoint = this.#endpoint;
    const lease = this.#lease;
    let failure: unknown;
    try {
      await this.#mutationTail;
    } catch (error) {
      failure ??= error;
    }
    if (server !== undefined) {
      try {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      } catch (error) {
        failure ??= error;
      }
    }
    if (endpoint !== undefined && process.platform !== "win32") {
      try {
        await rm(endpoint.endpoint, { force: true });
      } catch (error) {
        failure ??= error;
      }
    }
    if (lease !== undefined) {
      try {
        await lease.release();
      } catch (error) {
        failure ??= error;
      }
    }
    this.#lease = undefined;
    this.#endpoint = undefined;
    this.#bound = false;
    if (failure !== undefined) throw failure;
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
            throw new AuthorityProtocolError(
              "unexpected_envelope",
              "client sent a non-request envelope",
            );
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
      throw new AuthorityProtocolError(
        "handshake_required",
        "first authority frame must be a handshake",
      );
    }
    if (this.#externalAdmissionClosed) {
      throw new AuthorityProtocolError("authority_stopping", "authority is stopping");
    }
    const expectedRoot = this.#endpoint?.identity.worktreeRoot;
    if (expectedRoot === undefined || envelope.projectRoot !== expectedRoot) {
      throw new AuthorityProtocolError(
        "project_mismatch",
        "client connected for a different project root",
      );
    }
    if (!this.#ready) {
      this.#sequence += 1;
      client.socket.end(
        encodeFrame({
          type: "event",
          sequence: this.#sequence,
          revision: this.#revision,
          topic: "authority.starting",
          payload: {
            version: this.#options.version,
            buildSha256: this.#buildSha256 ?? "unavailable",
          },
        }),
      );
      return;
    }
    if (envelope.client === "compat-control") {
      client.handshake = envelope;
      client.compatibilityOnly = true;
      this.#sequence += 1;
      client.socket.write(
        encodeFrame({
          type: "event",
          sequence: this.#sequence,
          revision: this.#revision,
          topic: "authority.compatibility_control_ready",
          payload: {
            version: this.#options.version,
            buildSha256: this.#buildSha256 ?? "unavailable",
          },
        }),
      );
      return;
    }
    if (
      envelope.clientVersion !== this.#options.version ||
      envelope.clientBuildSha256 !== this.#buildSha256
    ) {
      this.#sequence += 1;
      client.socket.end(
        encodeFrame({
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
        }),
      );
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
        payload: { version: this.#options.version, buildSha256: this.#buildSha256 },
      }),
    );
  }

  async #dispatch(client: ClientState, request: RpcRequest): Promise<void> {
    // Reject work submitted after the shutdown tombstone without joining the serialized mutation
    // lane. Otherwise an already-admitted internal mutation can indefinitely delay the rejection
    // while the caller reasonably believes external admission is closed.
    if (this.#externalAdmissionClosed) {
      this.#writeFailure(client, request.id, "authority_stopping", "authority is stopping", true);
      return;
    }
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
      this.#writeFailure(
        client,
        request.id,
        "method_not_found",
        `unknown method: ${request.method}`,
        false,
      );
      return;
    }
    const execute = async () => {
      if (this.#externalAdmissionClosed) {
        this.#writeFailure(client, request.id, "authority_stopping", "authority is stopping", true);
        return;
      }
      if (this.#internalAdmissionClosed) {
        this.#writeFailure(
          client,
          request.id,
          "authority_stopping",
          "authority is stopping and accepts no further work",
          true,
        );
        return;
      }
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
      const cached =
        request.idempotencyKey === undefined
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
        const replayResponse = { ...cached.response, id: request.id, revision: this.#revision };
        client.socket.write(
          encodeFrame(replayResponse),
          replayResponse.ok
            ? () =>
                method.afterIdempotentReplay?.(
                  {
                    handshake: client.handshake!,
                    request,
                    revision: this.#revision,
                  },
                  replayResponse,
                )
            : undefined,
        );
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
            client.socket.write(encodeFrame(response), () =>
              method.afterIdempotentReplay?.(
                {
                  handshake: client.handshake!,
                  request,
                  revision: this.#revision,
                },
                response,
              ),
            );
            return;
          }
        } catch (error) {
          const rpcError =
            error instanceof AuthorityRpcError
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
      if (
        method.mutating &&
        method.revisionPolicy !== "semantic" &&
        request.method !== "authority.quiesce" &&
        request.expectedRevision !== this.#revision
      ) {
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
            throw new AuthorityRpcError(
              "invalid_revision",
              "mutation did not advance authority revision",
            );
          }
          this.#revision = nextRevision;
        } else if (result.revision !== undefined && result.revision !== this.#revision) {
          throw new AuthorityRpcError(
            "invalid_revision",
            "read-only method attempted to change revision",
          );
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
        const rpcError =
          error instanceof AuthorityRpcError
            ? error
            : new AuthorityRpcError(
                "internal",
                error instanceof Error ? error.message : String(error),
              );
        this.#writeFailure(
          client,
          request.id,
          rpcError.code,
          rpcError.message,
          rpcError.retryable,
          rpcError.details,
          request,
        );
      }
    };
    // Reads share the same lane so their revision and projected bytes cannot straddle a commit.
    const pending = this.#mutationTail.then(execute, execute);
    this.#mutationTail = pending.then(
      () => undefined,
      () => undefined,
    );
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
      const oldest = this.#idempotency.keys().next().value;
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
    new Set(["cli", "pi-extension", "managed-session", "tui", "compat-control"]).has(
      String(value.client),
    ) &&
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
