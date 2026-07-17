import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { AuthorityClient, AuthorityClientError } from "../src/authority/client.js";
import { AuthorityLease, AuthorityLeaseError, discoverAuthorityEndpoint } from "../src/authority/endpoint.js";
import {
  authorityRequestHash,
  ProjectAuthorityStore,
} from "../src/authority/project-store.js";
import { AuthorityServer } from "../src/authority/server.js";

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
    const client = await AuthorityClient.connect({ projectRoot: root, client: "cli", version: "1.0.0" });
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
    ).rejects.toMatchObject({ code: "revision_conflict", retryable: true } satisfies Partial<AuthorityClientError>);
    expect(events).toContain("counter.changed");
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
    await writeFile(endpoint.leasePath, `${JSON.stringify({
      protocol: "koni.authority-lease.v1",
      pid: deadPid,
      nonce: "stale-main-lease",
      endpoint: endpoint.endpoint,
      commonDirectory: endpoint.identity.commonDirectory,
      startedAt: "2000-01-01T00:00:00.000Z",
    })}\n`, { mode: 0o600 });
    const startupPath = `${endpoint.leasePath}.startup-lock`;
    await mkdir(startupPath, { mode: 0o700 });
    await writeFile(path.join(startupPath, "owner.json"), `${JSON.stringify({
      protocol: "koni.authority-startup-lock.v1",
      pid: deadPid,
      nonce: "stale-startup-lock",
      createdAt: "2000-01-01T00:00:00.000Z",
    })}\n`, { mode: 0o600 });

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
    const record = JSON.parse(await readFile(endpoint.leasePath, "utf8")) as { pid: number; nonce: string };
    expect(record).toMatchObject({ pid: process.pid, nonce: winners[0]!.value.nonce });
    await winners[0]!.value.release();
  });

  it("rejects unknown methods without changing revision", async () => {
    const root = await repository();
    const server = new AuthorityServer({ projectRoot: root, version: "1.0.0" });
    servers.push(server);
    await server.start();
    const client = await AuthorityClient.connect({ projectRoot: root, client: "tui", version: "1.0.0" });
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
    await expect(AuthorityClient.connect({
      projectRoot: root,
      client: "cli",
      version: "1.0.1",
      buildSha256: oldBuild,
    })).rejects.toMatchObject({ code: "runtime_mismatch" } satisfies Partial<AuthorityClientError>);
    await expect(AuthorityClient.connect({
      projectRoot: root,
      client: "pi-extension",
      version: "1.0.0",
      buildSha256: newBuild,
    })).rejects.toMatchObject({ code: "runtime_mismatch" } satisfies Partial<AuthorityClientError>);
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
        afterResponse: () => { responseFlushed = true; },
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
    const began = new Promise<void>((resolve) => { begin = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
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
      handle: () => { mutations += 1; return { result: { resumed: true } }; },
    });
    await server.start();
    const control = await AuthorityClient.connect({
      projectRoot: root,
      client: "compat-control",
      version: "9.0.0",
      buildSha256: `sha256:${"e".repeat(64)}`,
      compatibilityControl: true,
    });
    const ordinary = await AuthorityClient.connect({ projectRoot: root, client: "tui", version: "1.0.0" });
    const quiesce = control.request("authority.quiesce", undefined, {
      expectedRevision: 0,
      idempotencyKey: "queue-quiesce",
    });
    await began;
    const queued = ordinary.request("run.resume", { runId: "run-one" }, {
      expectedRevision: 0,
      idempotencyKey: "queued-resume",
    });
    release();
    await expect(quiesce).resolves.toMatchObject({ result: { status: "quiesced" } });
    await expect(queued).rejects.toMatchObject({
      code: "authority_quiescing",
    } satisfies Partial<AuthorityClientError>);
    expect(mutations).toBe(0);
    control.close();
    ordinary.close();
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
    const lookup = async (request: { method: string; params?: import("../src/authority/protocol.js").JsonValue; idempotencyKey?: string }) => {
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
    const client = await AuthorityClient.connect({ projectRoot: root, client: "cli", version: "1.0.0" });
    await client.request("run.mark", { runId: "run-one" }, {
      expectedRevision: 0,
      idempotencyKey: "mark-once",
    });
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
    second.register("run.mark", { mutating: true, handle: () => { executions += 1; return {}; } });
    await second.start();
    const retry = await AuthorityClient.connect({ projectRoot: root, client: "tui", version: "1.0.0" });
    const replay = await retry.request("run.mark", { runId: "run-one" }, {
      expectedRevision: 0,
      idempotencyKey: "mark-once",
    });
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
