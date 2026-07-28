import { AuthorityClientError } from "../src/authority/client.js";
import type { JsonValue, RpcEvent, RpcSuccess } from "../src/authority/protocol.js";
import type { ControlCenterAuthorityClient } from "../src/control-center/controller.js";
import {
  ResilientControlCenterClient,
  type ResilientControlCenterClock,
} from "../src/control-center/resilient-client.js";
import { describe, expect, it, vi } from "vitest";

describe("resilient full control-center connection", () => {
  it("keeps a long-lived dashboard below the authority idle boundary", async () => {
    const clock = new ManualClock();
    const client = new FakeClient();
    const reconnect = vi.fn(async () => new FakeClient());
    const resilient = new ResilientControlCenterClient({
      client,
      reconnect,
      heartbeatMs: 20_000,
      clock,
    });

    expect(clock.delays).toEqual([20_000]);
    await clock.runNext();

    expect(client.calls).toEqual(["project.status"]);
    expect(reconnect).not.toHaveBeenCalled();
    expect(clock.delays).toEqual([20_000]);
    resilient.close();
  });

  it("reconnects and requests a fresh projection after transport loss", async () => {
    const clock = new ManualClock();
    const first = new FakeClient();
    first.failure = new AuthorityClientError("closed", "authority connection is closed");
    const second = new FakeClient(23);
    const reconnect = vi.fn(async () => second);
    const resilient = new ResilientControlCenterClient({
      client: first,
      reconnect,
      heartbeatMs: 20_000,
      clock,
    });
    const topics: string[] = [];
    resilient.onEvent((event) => topics.push(event.topic));

    await clock.runNext();

    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(first.closed).toBe(true);
    expect(resilient.revision).toBe(23);
    expect(topics).toEqual(["authority.reconnected"]);
    expect(clock.delays).toEqual([20_000]);
    resilient.close();
    expect(second.closed).toBe(true);
  });

  it("never replays a mutation whose outcome may be unknown", async () => {
    const clock = new ManualClock();
    const first = new FakeClient();
    first.failure = new AuthorityClientError("closed", "authority connection closed");
    const second = new FakeClient(24);
    const resilient = new ResilientControlCenterClient({
      client: first,
      reconnect: async () => second,
      clock,
    });

    await expect(
      resilient.request(
        "plan.approve",
        { runId: "run-a" },
        {
          expectedRevision: 12,
          idempotencyKey: "approve-once",
        },
      ),
    ).rejects.toMatchObject({ code: "closed" });
    await flushPromises();

    expect(first.calls).toEqual(["plan.approve"]);
    expect(second.calls).toEqual([]);
    expect(resilient.revision).toBe(24);
    resilient.close();
  });
});

class FakeClient implements ControlCenterAuthorityClient {
  public failure: Error | undefined;
  public closed = false;
  public readonly calls: string[] = [];
  readonly #listeners = new Set<(event: RpcEvent) => void>();

  public constructor(public revision = 12) {}

  public async request(
    method: string,
    _params?: JsonValue,
    _options?: { expectedRevision?: number; idempotencyKey?: string },
  ): Promise<RpcSuccess> {
    this.calls.push(method);
    if (this.failure !== undefined) throw this.failure;
    return { type: "response", id: method, ok: true, revision: this.revision, result: {} };
  }

  public onEvent(listener: (event: RpcEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public close(): void {
    this.closed = true;
  }
}

class ManualClock implements ResilientControlCenterClock {
  public readonly delays: number[] = [];
  readonly #callbacks: Array<() => void> = [];

  public setTimeout(callback: () => void, delayMs: number): unknown {
    this.#callbacks.push(callback);
    this.delays.push(delayMs);
    return callback;
  }

  public clearTimeout(handle: unknown): void {
    const index = this.#callbacks.indexOf(handle as () => void);
    if (index >= 0) {
      this.#callbacks.splice(index, 1);
      this.delays.splice(index, 1);
    }
  }

  public async runNext(): Promise<void> {
    const callback = this.#callbacks.shift();
    this.delays.shift();
    if (callback === undefined) throw new Error("no scheduled timer");
    callback();
    await flushPromises();
  }
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
