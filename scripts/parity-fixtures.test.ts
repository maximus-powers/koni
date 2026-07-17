import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  GrantLedger,
  GrantRejectedError,
  type AuthorityGrant,
  type AuthoritySnapshot,
  type ToolCallBinding,
} from "../packages/core/src/authority/grants.js";
import { computeProfileBundleSha256 } from "../packages/core/src/compiler/profile-package.js";
import type {
  ProfileBaselineFile,
  ProfilePackageManifest,
} from "../packages/core/src/contracts/profile-package.js";
import { installProfile, readProfileLifecycle } from "../packages/core/src/profile/install.js";
import { rawSha256 } from "../packages/core/src/shared/canonical.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("parity-only composed fixtures", () => {
  it("preserves authority run state byte-for-byte across a signed baseline upgrade", async () => {
    const project = await temporary("upgrade-project");
    const v1 = await syntheticProfile("1.0.0", "value: one\n");
    const v2 = await syntheticProfile("1.1.0", "value: two\n");
    await installProfile(project, v1);

    const runState = path.join(project, ".git", "koni", "runs", "run-one", "record.json");
    const before = Buffer.from('{"protocol":"koni.run-record.v1","revision":7}\n', "utf8");
    await mkdir(path.dirname(runState), { recursive: true });
    await writeFile(runState, before);

    await installProfile(project, v2);
    expect(await readFile(runState)).toEqual(before);
    const lifecycle = await readProfileLifecycle(project);
    expect(lifecycle?.installedProfileVersion).toBe("1.1.0");
    expect(lifecycle?.immutableBaselines).toHaveLength(2);
  });

  it("rejects the exact grant and call replay after terminal revocation", () => {
    const grant: AuthorityGrant = {
      protocol: "koni.authority-grant.v1",
      grantId: "grant-terminal",
      runId: "run-terminal",
      ticketId: "ticket-terminal",
      stepId: "implement",
      attemptId: "attempt-terminal",
      sessionId: "session-terminal",
      epoch: 1,
      generation: 0,
      allowedTools: ["koni_record_note"],
      readPaths: [],
      writePaths: [],
      expectedRevision: 3,
      expectedStateHash: "state-three",
    };
    const call: ToolCallBinding = {
      grantId: grant.grantId,
      runId: grant.runId,
      ticketId: grant.ticketId,
      stepId: grant.stepId,
      attemptId: grant.attemptId,
      sessionId: grant.sessionId,
      epoch: grant.epoch,
      generation: grant.generation,
      callId: "same-call",
      tool: "koni_record_note",
      requestHash: "same-request",
      expectedRevision: 3,
      expectedStateHash: "state-three",
    };
    const snapshot: AuthoritySnapshot = {
      revision: 3,
      stateHash: "state-three",
      generation: 0,
      activeEpoch: 1,
    };
    const ledger = new GrantLedger<string>();
    expect(ledger.authorize(grant, call, snapshot, 1)).toMatchObject({ kind: "accepted" });
    ledger.commit(call, "recorded-once");

    const terminalGrant = { ...grant, revokedAtMs: 2 };
    expect(() => ledger.authorize(terminalGrant, call, snapshot, 3)).toThrowError(
      expect.objectContaining<Partial<GrantRejectedError>>({ code: "grant_revoked" }),
    );
    expect(ledger.records()).toHaveLength(1);
  });
});

async function temporary(label: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `koni-parity-${label}-`));
  roots.push(root);
  return root;
}

async function syntheticProfile(version: string, projectSource: string): Promise<string> {
  const root = await temporary(`profile-${version}`);
  const baseline = path.join(root, "koni", "baseline");
  await mkdir(baseline, { recursive: true });
  const sources = {
    "profile.yaml": "schema_version: '2.0'\nprofile:\n  id: parity\n  title: Parity\n  version: 1.0.0\n",
    "project.yaml": projectSource,
  };
  const files: ProfileBaselineFile[] = [];
  for (const [relative, source] of Object.entries(sources).sort(([left], [right]) => left.localeCompare(right))) {
    const bytes = Buffer.from(source, "utf8");
    await writeFile(path.join(baseline, relative), bytes);
    files.push({ path: relative, sha256: rawSha256(bytes), size_bytes: bytes.byteLength, kind: "config" });
  }
  const manifest: ProfilePackageManifest = {
    protocol: "koni.profile-package.v1",
    package: { name: "@koni/parity-profile", version },
    profile: { id: "parity", display_name: "Parity", version, lineage: "koni.parity" },
    compatibility: {
      core_api_range: ">=1.0.0 <2.0.0",
      profile_schema_range: ">=2.0.0 <3.0.0",
      pi_range: ">=0.80.10 <0.81.0",
    },
    baseline: { root: "./baseline", files },
    bundle_sha256: computeProfileBundleSha256(files),
  };
  await writeFile(path.join(root, "koni", "profile-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return root;
}
