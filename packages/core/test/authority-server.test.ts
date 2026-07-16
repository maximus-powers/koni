import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { AuthorityClient, AuthorityClientError } from "../src/authority/client.js";
import { AuthorityLeaseError } from "../src/authority/endpoint.js";
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
