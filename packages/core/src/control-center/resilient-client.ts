import { AuthorityClientError } from "../authority/client.js";
import type { RpcEvent } from "../authority/protocol.js";
import type { ControlCenterAuthorityClient } from "./controller.js";

export interface ResilientControlCenterClock {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ResilientControlCenterClientOptions {
  client: ControlCenterAuthorityClient;
  reconnect: () => Promise<ControlCenterAuthorityClient>;
  heartbeatMs?: number;
  reconnectDelaysMs?: readonly number[];
  clock?: ResilientControlCenterClock;
}

const DEFAULT_HEARTBEAT_MS = 20_000;
const DEFAULT_RECONNECT_DELAYS = [250, 1_000, 2_000, 5_000] as const;

/**
 * Keep the long-lived full control center attached without weakening mutation semantics.
 *
 * A failed request is never replayed: its write outcome may be unknown. The wrapper only obtains
 * a fresh transport for later requests, then emits a synthetic read-side event so the controller
 * reprojects durable state. The periodic request is deliberately read-only and arrives well
 * before the authority's idle-connection retirement boundary.
 */
export class ResilientControlCenterClient implements ControlCenterAuthorityClient {
  readonly #connect: () => Promise<ControlCenterAuthorityClient>;
  readonly #heartbeatMs: number;
  readonly #reconnectDelaysMs: readonly number[];
  readonly #clock: ResilientControlCenterClock;
  readonly #listeners = new Set<(event: RpcEvent) => void>();
  #client: ControlCenterAuthorityClient;
  #unsubscribe: (() => void) | undefined;
  #heartbeatTimer: unknown;
  #reconnectTimer: unknown;
  #reconnectPromise: Promise<void> | undefined;
  #reconnectAttempt = 0;
  #closed = false;

  public constructor(options: ResilientControlCenterClientOptions) {
    this.#client = options.client;
    this.#connect = options.reconnect;
    this.#heartbeatMs = positiveInteger(options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS, "heartbeat");
    const reconnectDelays = options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS;
    if (reconnectDelays.length === 0) throw new Error("reconnect delays must not be empty");
    for (const delay of reconnectDelays) positiveInteger(delay, "reconnect delay");
    this.#reconnectDelaysMs = [...reconnectDelays];
    this.#clock = options.clock ?? nodeClock();
    this.#attach();
    this.#scheduleHeartbeat();
  }

  public get revision(): number {
    return this.#client.revision;
  }

  public async request(
    method: string,
    params?: Parameters<ControlCenterAuthorityClient["request"]>[1],
    options?: Parameters<ControlCenterAuthorityClient["request"]>[2],
  ): Promise<Awaited<ReturnType<ControlCenterAuthorityClient["request"]>>> {
    if (this.#closed) throw new AuthorityClientError("closed", "control-center connection is closed");
    const client = this.#client;
    try {
      return await client.request(method, params, options);
    } catch (error) {
      if (client === this.#client && recoverableTransportFailure(error)) void this.#reconnect();
      throw error;
    }
  }

  public onEvent(listener: (event: RpcEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#cancelTimers();
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#client.close?.();
    this.#listeners.clear();
  }

  #attach(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = this.#client.onEvent?.((event) => {
      for (const listener of this.#listeners) listener(event);
    });
  }

  #scheduleHeartbeat(): void {
    if (this.#closed || this.#heartbeatTimer !== undefined || this.#reconnectPromise !== undefined) return;
    this.#heartbeatTimer = this.#clock.setTimeout(() => {
      this.#heartbeatTimer = undefined;
      void this.#heartbeat();
    }, this.#heartbeatMs);
  }

  async #heartbeat(): Promise<void> {
    if (this.#closed) return;
    const client = this.#client;
    try {
      await client.request("project.status");
      if (client === this.#client) {
        this.#reconnectAttempt = 0;
        this.#scheduleHeartbeat();
      }
    } catch (error) {
      if (client === this.#client && recoverableTransportFailure(error)) await this.#reconnect();
      else this.#scheduleHeartbeat();
    }
  }

  async #reconnect(): Promise<void> {
    if (this.#closed) return;
    if (this.#reconnectPromise !== undefined) return this.#reconnectPromise;
    this.#clearHeartbeat();
    this.#reconnectPromise = (async () => {
      try {
        const previous = this.#client;
        const next = await this.#connect();
        if (this.#closed) {
          next.close?.();
          return;
        }
        this.#unsubscribe?.();
        this.#unsubscribe = undefined;
        previous.close?.();
        this.#client = next;
        this.#attach();
        this.#reconnectAttempt = 0;
        const event: RpcEvent = {
          type: "event",
          sequence: 0,
          revision: next.revision,
          topic: "authority.reconnected",
        };
        for (const listener of this.#listeners) listener(event);
      } catch {
        if (!this.#closed) this.#scheduleReconnect();
      }
    })();
    try {
      await this.#reconnectPromise;
    } finally {
      this.#reconnectPromise = undefined;
      if (!this.#closed && this.#reconnectTimer === undefined) this.#scheduleHeartbeat();
    }
  }

  #scheduleReconnect(): void {
    if (this.#closed || this.#reconnectTimer !== undefined) return;
    const delay = this.#reconnectDelaysMs[Math.min(this.#reconnectAttempt, this.#reconnectDelaysMs.length - 1)]!;
    this.#reconnectAttempt += 1;
    this.#reconnectTimer = this.#clock.setTimeout(() => {
      this.#reconnectTimer = undefined;
      void this.#reconnect();
    }, delay);
  }

  #clearHeartbeat(): void {
    if (this.#heartbeatTimer !== undefined) this.#clock.clearTimeout(this.#heartbeatTimer);
    this.#heartbeatTimer = undefined;
  }

  #cancelTimers(): void {
    for (const timer of [this.#heartbeatTimer, this.#reconnectTimer]) {
      if (timer !== undefined) this.#clock.clearTimeout(timer);
    }
    this.#heartbeatTimer = undefined;
    this.#reconnectTimer = undefined;
  }
}

function recoverableTransportFailure(error: unknown): boolean {
  if (error instanceof AuthorityClientError) return error.code === "closed" || error.retryable;
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ECONNRESET" || code === "ECONNREFUSED" || code === "EPIPE" || code === "ENOENT" ||
    /connection (?:is )?closed|socket (?:is )?closed/iu.test(error.message);
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive safe integer`);
  return value;
}

function nodeClock(): ResilientControlCenterClock {
  return {
    setTimeout(callback, delayMs) {
      const handle = setTimeout(callback, delayMs);
      handle.unref();
      return handle;
    },
    clearTimeout(handle) {
      clearTimeout(handle as NodeJS.Timeout);
    },
  };
}
