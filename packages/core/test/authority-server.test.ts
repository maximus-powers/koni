import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthorityClient, type AuthorityClientError } from "../src/authority/client.js";
import {
  AuthorityLease,
  type AuthorityLeaseError,
  discoverAuthorityEndpoint,
} from "../src/authority/endpoint.js";
import { authorityRequestHash, ProjectAuthorityStore } from "../src/authority/project-store.js";
import { AuthorityRpcError, AuthorityServer } from "../src/authority/server.js";

const roots: string[] = [];
const servers: AuthorityServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("repository authority service", () => {
  it("serializes CAS mutations, publishes events, and replays idempotent results", async () => {
    const root = await repository();
    const server = new AuthorityServer({ projectRoot: root, version: "1.0.0" });
    servers.push(server);
    let value = 0;
    server.register("counter.increment", {
      mutating: true,
      handle: () => {
        value += 1;
        return { result: { value }, events: [{ topic: "counter.changed", payload: { value } }] };
      },
    });
    await server.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "cli",
      version: "1.0.0",
    });
    const events: string[] = [];
    client.onEvent((event) => events.push(event.topic));
    const first = await client.request("counter.increment", undefined, {
      expectedRevision: 0,
      idempotencyKey: "same-action",
    });
    expect(first.result).toEqual({ value: 1 });
    const replay = await client.request("counter.increment", undefined, {
      expectedRevision: 0,
      idempotencyKey: "same-action",
    });
    expect(replay.result).toEqual({ value: 1 });
    expect(value).toBe(1);
    await expect(
      client.request("counter.increment", undefined, { expectedRevision: 0 }),
    ).rejects.toMatchObject({
      code: "revision_conflict",
      retryable: true,
    } satisfies Partial<AuthorityClientError>);
    expect(events).toContain("counter.changed");
    client.close();
  });

  it("joins only successful idempotent continuations after replay response flush", async () => {
    const root = await repository();
    const server = new AuthorityServer({ projectRoot: root, version: "1.0.0" });
    servers.push(server);
    let successJoins = 0;
    let failedJoins = 0;
    server.register("continuation.accept", {
      mutating: true,
      handle: () => ({ result: { accepted: true } }),
      afterIdempotentReplay: () => {
        successJoins += 1;
      },
    });
    server.register("continuation.reject", {
      mutating: true,
      handle: () => {
        throw new AuthorityRpcError("rejected", "not authorized");
      },
      afterIdempotentReplay: () => {
        failedJoins += 1;
      },
    });
    await server.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "cli",
      version: "1.0.0",
    });
    await client.request("continuation.accept", undefined, {
      expectedRevision: 0,
      idempotencyKey: "accepted-once",
    });
    await client.request("continuation.accept", undefined, {
      expectedRevision: 0,
      idempotencyKey: "accepted-once",
    });
    await expect(
      client.request("continuation.reject", undefined, {
        expectedRevision: 1,
        idempotencyKey: "rejected-once",
      }),
    ).rejects.toMatchObject({ code: "rejected" });
    await expect(
      client.request("continuation.reject", undefined, {
        expectedRevision: 1,
        idempotencyKey: "rejected-once",
      }),
    ).rejects.toMatchObject({ code: "rejected" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(successJoins).toBe(1);
    expect(failedJoins).toBe(0);
    client.close();
  });

  it("allows only one authority owner for a Git common directory", async () => {
    const root = await repository();
    const first = new AuthorityServer({ projectRoot: root, version: "1.0.0" });
    const second = new AuthorityServer({ projectRoot: root, version: "1.0.0" });
    servers.push(first);
    await first.start();
    await expect(second.start()).rejects.toMatchObject({
      code: "authority_running",
    } satisfies Partial<AuthorityLeaseError>);
  });

  it("serializes concurrent reclamation of the same stale startup lock and lease", async () => {
    const root = await repository();
    const endpoint = await discoverAuthorityEndpoint(root);
    const deadPid = 2_147_483_647;
    await mkdir(path.dirname(endpoint.leasePath), { recursive: true, mode: 0o700 });
    await writeFile(
      endpoint.leasePath,
      `${JSON.stringify({
        protocol: "koni.authority-lease.v1",
        pid: deadPid,
        nonce: "stale-main-lease",
        endpoint: endpoint.endpoint,
        commonDirectory: endpoint.identity.commonDirectory,
        startedAt: "2000-01-01T00:00:00.000Z",
      })}\n`,
      { mode: 0o600 },
    );
    const startupPath = `${endpoint.leasePath}.startup-lock`;
    await mkdir(startupPath, { mode: 0o700 });
    await writeFile(
      path.join(startupPath, "owner.json"),
      `${JSON.stringify({
        protocol: "koni.authority-startup-lock.v1",
        pid: deadPid,
        nonce: "stale-startup-lock",
        createdAt: "2000-01-01T00:00:00.000Z",
      })}\n`,
      { mode: 0o600 },
    );

    const results = await Promise.allSettled([
      AuthorityLease.acquire(endpoint),
      AuthorityLease.acquire(endpoint),
    ]);
    const winners = results.filter(
      (result): result is PromiseFulfilledResult<AuthorityLease> => result.status === "fulfilled",
    );
    const losers = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]!.reason).toMatchObject({ code: "authority_running" });
    await winners[0]!.value.completeStartup();
    const record = JSON.parse(await readFile(endpoint.leasePath, "utf8")) as {
      pid: number;
      nonce: string;
    };
    expect(record).toMatchObject({ pid: process.pid, nonce: winners[0]!.value.nonce });
    await winners[0]!.value.release();
  });

  it("rejects unknown methods without changing revision", async () => {
    const root = await repository();
    const server = new AuthorityServer({ projectRoot: root, version: "1.0.0" });
    servers.push(server);
    await server.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    await expect(client.request("run.missing")).rejects.toMatchObject({
      code: "method_not_found",
      revision: 0,
    } satisfies Partial<AuthorityClientError>);
    client.close();
  });

  it("rejects stale daemons by exact version and same-version Core build identity", async () => {
    const root = await repository();
    const oldBuild = `sha256:${"a".repeat(64)}`;
    const newBuild = `sha256:${"b".repeat(64)}`;
    const server = new AuthorityServer({
      projectRoot: root,
      version: "1.0.0",
      buildSha256: oldBuild,
    });
    servers.push(server);
    await server.start();
    await expect(
      AuthorityClient.connect({
        projectRoot: root,
        client: "cli",
        version: "1.0.1",
        buildSha256: oldBuild,
      }),
    ).rejects.toMatchObject({ code: "runtime_mismatch" } satisfies Partial<AuthorityClientError>);
    await expect(
      AuthorityClient.connect({
        projectRoot: root,
        client: "pi-extension",
        version: "1.0.0",
        buildSha256: newBuild,
      }),
    ).rejects.toMatchObject({ code: "runtime_mismatch" } satisfies Partial<AuthorityClientError>);
    const current = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
      buildSha256: oldBuild,
    });
    current.close();
  });

  it("admits a mismatched build only to the stable quiesce control method", async () => {
    const root = await repository();
    const oldBuild = `sha256:${"a".repeat(64)}`;
    const newBuild = `sha256:${"b".repeat(64)}`;
    let responseFlushed = false;
    const server = new AuthorityServer({
      projectRoot: root,
      version: "1.0.0",
      buildSha256: oldBuild,
    });
    servers.push(server);
    server.register("authority.quiesce", {
      mutating: true,
      handle: () => ({
        result: { status: "quiesced", pausedRunIds: [] },
        afterResponse: () => {
          responseFlushed = true;
        },
      }),
    });
    await server.start();
    const control = await AuthorityClient.connect({
      projectRoot: root,
      client: "compat-control",
      version: "9.0.0",
      buildSha256: newBuild,
      compatibilityControl: true,
    });
    await expect(control.request("authority.ping")).rejects.toMatchObject({
      code: "compatibility_control_only",
    } satisfies Partial<AuthorityClientError>);
    const response = await control.request("authority.quiesce", undefined, {
      expectedRevision: control.revision,
      idempotencyKey: "quiesce-old-build",
    });
    expect(response.result).toEqual({ status: "quiesced", pausedRunIds: [] });
    await new Promise((resolve) => setImmediate(resolve));
    expect(responseFlushed).toBe(true);
    control.close();
  });

  it("rejects work already queued behind the quiesce mutation", async () => {
    const root = await repository();
    let begin!: () => void;
    let release!: () => void;
    const began = new Promise<void>((resolve) => {
      begin = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let mutations = 0;
    const server = new AuthorityServer({ projectRoot: root, version: "1.0.0" });
    servers.push(server);
    server.register("authority.quiesce", {
      mutating: true,
      handle: async () => {
        begin();
        await released;
        return { result: { status: "quiesced" }, beginQuiesce: true };
      },
    });
    server.register("run.resume", {
      mutating: true,
      handle: () => {
        mutations += 1;
        return { result: { resumed: true } };
      },
    });
    await server.start();
    const control = await AuthorityClient.connect({
      projectRoot: root,
      client: "compat-control",
      version: "9.0.0",
      buildSha256: `sha256:${"e".repeat(64)}`,
      compatibilityControl: true,
    });
    const ordinary = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const quiesce = control.request("authority.quiesce", undefined, {
      expectedRevision: 0,
      idempotencyKey: "queue-quiesce",
    });
    await began;
    const queued = ordinary.request(
      "run.resume",
      { runId: "run-one" },
      {
        expectedRevision: 0,
        idempotencyKey: "queued-resume",
      },
    );
    release();
    await expect(quiesce).resolves.toMatchObject({ result: { status: "quiesced" } });
    await expect(queued).rejects.toMatchObject({
      code: "authority_quiescing",
    } satisfies Partial<AuthorityClientError>);
    expect(mutations).toBe(0);
    control.close();
    ordinary.close();
  });

  it("admits only async-scoped internal settlement after external quiesce admission closes", async () => {
    const root = await repository();
    const server = new AuthorityServer({ projectRoot: root, version: "1.0.0" });
    servers.push(server);
    let settle!: () => void;
    let fail!: (error: unknown) => void;
    const settled = new Promise<void>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    let internalRevision = 0;
    server.register("authority.quiesce", {
      mutating: true,
      handle: () => ({
        result: { status: "quiescing" },
        beginQuiesce: true,
        afterResponse: () => {
          void server
            .runQuiesceSettlement(async () => {
              await new Promise((resolve) => setImmediate(resolve));
              const result = await server.mutateInternal(({ revision }) => {
                internalRevision = revision + 1;
                return { revision: internalRevision };
              });
              expect(result.revision).toBe(internalRevision);
            })
            .then(settle, fail);
        },
      }),
    });
    await server.start();
    const control = await AuthorityClient.connect({
      projectRoot: root,
      client: "compat-control",
      version: "9.0.0",
      buildSha256: `sha256:${"e".repeat(64)}`,
      compatibilityControl: true,
    });
    const ordinary = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    await expect(
      control.request("authority.quiesce", undefined, {
        expectedRevision: 0,
        idempotencyKey: "scoped-quiesce-settlement",
      }),
    ).resolves.toMatchObject({ result: { status: "quiescing" } });
    await expect(ordinary.request("authority.ping")).rejects.toMatchObject({
      code: "authority_quiescing",
    });
    await expect(
      server.mutateInternal(({ revision }) => ({ revision: revision + 1 })),
    ).rejects.toMatchObject({ code: "authority_quiescing" });
    await settled;
    expect(internalRevision).toBe(2);
    control.close();
    ordinary.close();
  });

  it("reopens only a freshly recovered quiesce from inside its privileged settlement scope", async () => {
    const root = await repository();
    const server = new AuthorityServer({
      projectRoot: root,
      version: "1.0.0",
      initialQuiescing: true,
    });
    servers.push(server);
    let resumes = 0;
    server.register("run.resume", {
      mutating: true,
      handle: ({ revision }) => {
        resumes += 1;
        return { revision: revision + 1, result: { resumed: true } };
      },
    });
    server.register("authority.quiesce", {
      mutating: true,
      handle: () => ({ result: { status: "quiescing" }, beginQuiesce: true }),
    });
    await server.start();
    await expect(
      AuthorityClient.connect({ projectRoot: root, client: "tui", version: "1.0.0" }),
    ).rejects.toMatchObject({ code: "authority_starting" });
    expect(() => server.completeRecoveredQuiesce()).toThrowError(
      expect.objectContaining({ code: "authority_quiesce_recovery" }),
    );
    let releaseDetached!: () => void;
    const detachedGate = new Promise<void>((resolve) => {
      releaseDetached = resolve;
    });
    let detached!: Promise<unknown>;
    await server.runQuiesceSettlement(async () => {
      await server.mutateInternal(({ revision }) => ({ revision: revision + 1 }));
      detached = (async () => {
        await detachedGate;
        return server.mutateInternal(({ revision }) => ({ revision: revision + 1 }));
      })();
      server.completeRecoveredQuiesce();
    });
    const ordinary = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    await expect(ordinary.request("authority.ping")).resolves.toMatchObject({
      ok: true,
      revision: 1,
    });
    await expect(
      ordinary.request("run.resume", undefined, {
        expectedRevision: 1,
        idempotencyKey: "resume-after-recovered-quiesce",
      }),
    ).resolves.toMatchObject({ result: { resumed: true }, revision: 2 });
    expect(resumes).toBe(1);
    const control = await AuthorityClient.connect({
      projectRoot: root,
      client: "compat-control",
      version: "9.0.0",
      buildSha256: `sha256:${"9".repeat(64)}`,
      compatibilityControl: true,
    });
    await control.request("authority.quiesce", undefined, {
      expectedRevision: 2,
      idempotencyKey: "later-live-quiesce",
    });
    releaseDetached();
    await expect(detached).rejects.toMatchObject({ code: "authority_quiescing" });
    await server.runQuiesceSettlement(async () => {
      expect(() => server.completeRecoveredQuiesce()).toThrowError(
        expect.objectContaining({ code: "authority_quiesce_recovery" }),
      );
    });
    control.close();
    ordinary.close();
  });

  it("keeps an ordinary engine-owned startup undiscoverable until recovery publishes readiness", async () => {
    const root = await repository();
    const server = new AuthorityServer({
      projectRoot: root,
      version: "1.0.0",
      deferReadyUntilRecovery: true,
    });
    servers.push(server);
    server.register("project.status", {
      mutating: false,
      handle: () => ({ result: { projectRoot: root, version: "1.0.0", revision: 0, runCount: 0 } }),
    });
    await server.start();
    await expect(
      AuthorityClient.connect({ projectRoot: root, client: "tui", version: "1.0.0" }),
    ).rejects.toMatchObject({ code: "authority_starting", retryable: true });
    server.completeStartupRecovery();
    expect(() => server.completeStartupRecovery()).toThrowError(
      expect.objectContaining({ code: "authority_startup_recovery" }),
    );
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    await expect(client.request("project.status")).resolves.toMatchObject({ ok: true });
    client.close();
  });

  it("rebinds startup state exactly once after bind and never permits a backward revision", async () => {
    const root = await repository();
    const server = new AuthorityServer({
      projectRoot: root,
      version: "1.0.0",
      initialRevision: 1,
      deferReadyUntilRecovery: true,
    });
    servers.push(server);
    await server.start();
    server.configureStartupState(2, false);
    expect(() => server.configureStartupState(3, false)).toThrowError(
      expect.objectContaining({ code: "authority_startup_configuration" }),
    );
    server.completeStartupRecovery();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "cli",
      version: "1.0.0",
    });
    await expect(client.request("authority.ping")).resolves.toMatchObject({ revision: 2 });
    client.close();

    await server.stop();
    servers.splice(servers.indexOf(server), 1);
    const backward = new AuthorityServer({
      projectRoot: root,
      version: "1.0.0",
      initialRevision: 3,
      deferReadyUntilRecovery: true,
    });
    servers.push(backward);
    await backward.start();
    expect(() => backward.configureStartupState(2, false)).toThrowError(
      expect.objectContaining({ code: "authority_startup_configuration" }),
    );
  });

  it("drains internal mutations admitted before shutdown and rejects calls admitted afterward", async () => {
    const root = await repository();
    const server = new AuthorityServer({ projectRoot: root, version: "1.0.0" });
    servers.push(server);
    await server.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "cli",
      version: "1.0.0",
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = server.mutateInternal(async ({ revision }) => {
      await gate;
      return { revision: revision + 1 };
    });
    const second = server.mutateInternal(({ revision }) => ({ revision: revision + 1 }));
    server.closeExternalAdmission();
    await expect(client.request("authority.ping")).rejects.toMatchObject({
      code: "authority_stopping",
    });
    server.closeInternalAdmission();
    await expect(
      server.mutateInternal(({ revision }) => ({ revision: revision + 1 })),
    ).rejects.toMatchObject({ code: "authority_stopping" });
    release();
    await expect(first).resolves.toMatchObject({ revision: 1 });
    await expect(second).resolves.toMatchObject({ revision: 2 });
    client.close();
  });

  it("shares one stop settlement until mutation drain and lease release complete", async () => {
    const root = await repository();
    const server = new AuthorityServer({ projectRoot: root, version: "1.0.0" });
    servers.push(server);
    await server.start();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mutation = server.mutateInternal(async ({ revision }) => {
      await gate;
      return { revision: revision + 1 };
    });
    const first = server.stop();
    const second = server.stop();
    expect(second).toBe(first);
    let secondSettled = false;
    void second
      .finally(() => {
        secondSettled = true;
      })
      .catch(() => undefined);
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    release();
    await mutation;
    await Promise.all([first, second]);
    servers.splice(servers.indexOf(server), 1);
    const endpoint = await discoverAuthorityEndpoint(root);
    const successor = await AuthorityLease.acquire(endpoint);
    await successor.release();
  });

  it("makes a server object terminal after stop instead of leaking a restarted listener", async () => {
    const root = await repository();
    const server = new AuthorityServer({ projectRoot: root, version: "1.0.0" });
    servers.push(server);
    await server.start();
    await server.stop();

    await expect(server.start()).rejects.toThrowError(/lifecycle is terminal/);

    // A fresh object may acquire the released lease, proving the rejected restart did not bind.
    const successor = new AuthorityServer({ projectRoot: root, version: "1.0.0" });
    servers.push(successor);
    await successor.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "cli",
      version: "1.0.0",
    });
    await expect(client.request("authority.ping")).resolves.toMatchObject({ ok: true });
    client.close();
  });

  it("joins an in-flight bind before stop and never publishes its late listener or lease", async () => {
    const root = await repository();
    const server = new AuthorityServer({ projectRoot: root, version: "1.0.0" });
    servers.push(server);
    let entered!: () => void;
    let release!: () => void;
    const atStartupCommit = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = AuthorityLease.prototype.completeStartup;
    const complete = vi
      .spyOn(AuthorityLease.prototype, "completeStartup")
      .mockImplementation(async function (this: AuthorityLease) {
        entered();
        await gate;
        await original.call(this);
      });

    const starting = server.start();
    await atStartupCommit;
    const stopping = server.stop();
    release();
    await expect(starting).rejects.toMatchObject({ code: "authority_stopping" });
    await stopping;
    complete.mockRestore();

    const successor = new AuthorityServer({ projectRoot: root, version: "1.0.0" });
    servers.push(successor);
    await successor.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    await expect(client.request("authority.ping")).resolves.toMatchObject({ ok: true });
    client.close();
  });

  it("shares the same stop cleanup failure with every concurrent caller", async () => {
    const root = await repository();
    const server = new AuthorityServer({ projectRoot: root, version: "1.0.0" });
    await server.start();
    const release = vi
      .spyOn(AuthorityLease.prototype, "release")
      .mockRejectedValueOnce(new Error("injected lease release failure"));
    const first = server.stop();
    const second = server.stop();
    expect(second).toBe(first);
    await expect(first).rejects.toThrowError(/injected lease release failure/);
    await expect(second).rejects.toThrowError(/injected lease release failure/);
    release.mockRestore();
  });

  it("replays a committed mutation after authority restart before applying revision CAS", async () => {
    const root = await repository();
    const endpoint = await discoverAuthorityEndpoint(root);
    const store = await ProjectAuthorityStore.open({
      stateRoot: endpoint.stateRoot,
      projectRoot: endpoint.identity.worktreeRoot,
      commonDirectory: endpoint.identity.commonDirectory,
    });
    let executions = 0;
    const lookup = async (request: {
      method: string;
      params?: import("../src/authority/protocol.js").JsonValue;
      idempotencyKey?: string;
    }) => {
      if (request.idempotencyKey === undefined) return undefined;
      return store.findReceipt(
        request.method,
        request.idempotencyKey,
        authorityRequestHash(request.method, request.params),
      );
    };
    const first = new AuthorityServer({
      projectRoot: root,
      version: "1.0.0",
      initialRevision: 0,
      lookupIdempotent: lookup,
    });
    servers.push(first);
    first.register("run.mark", {
      mutating: true,
      handle: async ({ request, revision }) => {
        executions += 1;
        const committed = await store.commit({
          expectedRevision: revision,
          receipt: {
            method: request.method,
            idempotencyKey: request.idempotencyKey!,
            requestHash: authorityRequestHash(request.method, request.params),
            result: { marked: true },
          },
        });
        return { result: { marked: true }, revision: committed.state.revision };
      },
    });
    await first.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "cli",
      version: "1.0.0",
    });
    await client.request(
      "run.mark",
      { runId: "run-one" },
      {
        expectedRevision: 0,
        idempotencyKey: "mark-once",
      },
    );
    client.close();
    await first.stop();
    servers.splice(servers.indexOf(first), 1);

    const persisted = await store.state();
    const second = new AuthorityServer({
      projectRoot: root,
      version: "1.0.0",
      initialRevision: persisted.revision,
      lookupIdempotent: lookup,
    });
    servers.push(second);
    second.register("run.mark", {
      mutating: true,
      handle: () => {
        executions += 1;
        return {};
      },
    });
    await second.start();
    const retry = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const replay = await retry.request(
      "run.mark",
      { runId: "run-one" },
      {
        expectedRevision: 0,
        idempotencyKey: "mark-once",
      },
    );
    expect(replay.result).toEqual({ marked: true });
    expect(replay.revision).toBe(1);
    expect(executions).toBe(1);
    retry.close();
  });
});

async function repository(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "koni-authority-"));
  roots.push(root);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "koni@example.invalid");
  await git(root, "config", "user.name", "Koni Test");
  await writeFile(path.join(root, "README.md"), "authority\n");
  await git(root, "add", "README.md");
  await git(root, "commit", "-m", "initial");
  return root;
}

function git(cwd: string, ...argv: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, ...argv], { stdio: ["ignore", "ignore", "pipe"] });
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(Buffer.concat(stderr).toString("utf8")));
      }
    });
  });
}
