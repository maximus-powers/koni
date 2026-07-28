import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectAuthorityStore } from "../src/authority/project-store.js";
import { RunAuthorityEngine, type RunCompilerProgram } from "../src/authority/run-engine.js";
import { GitClient } from "../src/git/client.js";
import { ManagedSessionSupervisor } from "../src/pi/supervisor.js";
import { rawSha256 } from "../src/shared/canonical.js";
import {
  newRunLifecycle,
  reduceRunLifecycle,
  type RunLifecycleState,
} from "../src/state/run-lifecycle.js";
import type { RunRecord, TicketRecord } from "../src/state/run-record.js";
import type { LegacyFlatRunGitRecord } from "../src/state/legacy-run-git-migration.js";
import {
  LegacyRunGitExecutor,
  type LegacyRunGitJournal,
  type LegacyRunGitSettlement,
} from "../src/state/legacy-run-git-executor.js";
import type { GitLifecycleIntent } from "../src/git/lifecycle.js";
import { fixtureRunGit } from "./run-record-fixtures.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("proof-gated legacy flat run Git migration", () => {
  it("upgrades an untouched planned run without creating any Git resource", async () => {
    const fixture = await repositoryFixture("planned");
    const refsBefore = await refs(fixture.root);
    const worktreesBefore = await new GitClient(fixture.root).worktrees();
    await persistLegacyRun(fixture, legacyGit(fixture, { namespaceStatus: "planned" }), "draft");

    const reopened = await openStore(fixture);
    const run = await reopened.getRun(fixture.runId);
    expect(run.revision).toBe(1);
    expect(run.git.planning.status).toBe("planned");
    expect(run.git.run.status).toBe("unmaterialized");
    expect(run.git.namespace.runWorktree).toBe(path.join(fixture.legacyWorktree, "integration"));
    expect(run.legacyGitMigration).toMatchObject({ status: "migrated" });
    expect(run.legacyGitMigration!.relocation).toBeUndefined();
    expect(await refs(fixture.root)).toEqual(refsBefore);
    expect(await new GitClient(fixture.root).worktrees()).toEqual(worktreesBefore);
    const migratedState = await reopened.state();
    expect(migratedState.revision).toBe(3);
    const migratedRunBytes = await readFile(
      path.join(fixture.stateRoot, "runs", fixture.runId, "run.json"),
    );
    expect(migratedState.runRecordSha256?.[fixture.runId]).toBe(rawSha256(migratedRunBytes));
    const reopenedAgain = await openStore(fixture);
    expect((await reopenedAgain.state()).revision).toBe(3);
    expect((await reopenedAgain.getRun(fixture.runId)).revision).toBe(1);
  }, 15_000);

  it("blocks a clean active checkout and emits an exact relocation plan without moving it", async () => {
    const fixture = await repositoryFixture("live");
    await createLegacyWorktree(fixture, fixture.runId);
    const ticket = ticketRecord("ticket-one", fixture.legacyWorktree, `koni/runs/${fixture.runId}`);
    await persistLegacyRun(
      fixture,
      legacyGit(fixture, { namespaceStatus: "ready", materializedAt: fixture.now }),
      "executing",
      { [ticket.id]: ticket },
    );
    const headBefore = await new GitClient(fixture.root).resolveRef(
      `refs/heads/koni/runs/${fixture.runId}`,
    );

    const reopened = await openStore(fixture);
    const run = await reopened.getRun(fixture.runId);
    expect(run.lifecycle.phase).toBe("blocked");
    expect(run.lifecycle.resumePhase).toBe("executing");
    expect(run.git.run).toMatchObject({ status: "preserved", headOid: headBefore });
    expect(run.git.namespace.runWorktree).toBe(path.join(fixture.legacyWorktree, "integration"));
    expect(run.git.run.worktree).toBe(path.join(fixture.legacyWorktree, "integration"));
    const migration = run.legacyGitMigration!;
    expect(migration.status).toBe("relocation_required");
    expect(migration.source.runWorktree).toBe(fixture.legacyWorktree);
    expect(migration.relocation).toMatchObject({
      source: {
        branchRef: `refs/heads/koni/runs/${fixture.runId}`,
        worktree: fixture.legacyWorktree,
        expectedHeadOid: headBefore,
        registered: true,
        clean: true,
      },
      destination: {
        namespaceRoot: fixture.legacyWorktree,
        runWorktree: path.join(fixture.legacyWorktree, "integration"),
        ticketRoot: path.join(fixture.legacyWorktree, "tickets"),
      },
      ticketProjectionIds: ["ticket-one"],
      priorPhase: "executing",
    });
    expect(await new GitClient(fixture.legacyWorktree).statusEntries()).toEqual([]);
    expect(
      await new GitClient(fixture.root).resolveRef(`refs/heads/koni/runs/${fixture.runId}`),
    ).toBe(headBefore);
    await expect(readFile(path.join(fixture.legacyWorktree, "README.md"), "utf8")).resolves.toBe(
      "base\n",
    );
  }, 15_000);

  it("preserves a dirty exact checkout and refuses to emit an executable relocation", async () => {
    const fixture = await repositoryFixture("dirty");
    await createLegacyWorktree(fixture, fixture.runId);
    await writeFile(path.join(fixture.legacyWorktree, "local-notes.txt"), "do not delete\n");
    await persistLegacyRun(
      fixture,
      legacyGit(fixture, { namespaceStatus: "ready", materializedAt: fixture.now }),
      "paused",
    );

    const run = await (await openStore(fixture)).getRun(fixture.runId);
    expect(run.legacyGitMigration).toMatchObject({
      status: "preserved",
    });
    expect(run.legacyGitMigration!.relocation).toBeUndefined();
    expect(run.legacyGitMigration!.reason).toContain("local changes");
    expect(run.git.run.status).toBe("preserved");
    expect(run.lifecycle.phase).toBe("blocked");
    expect(await readFile(path.join(fixture.legacyWorktree, "local-notes.txt"), "utf8")).toBe(
      "do not delete\n",
    );
  }, 15_000);

  it("retains a canonical snapshot but blocks when the selected commit no longer exists", async () => {
    const fixture = await repositoryFixture("missing-base");
    const missing = "f".repeat(40);
    await persistLegacyRun(
      fixture,
      { ...legacyGit(fixture, { namespaceStatus: "planned" }), targetBaseOid: missing },
      "draft",
    );

    const run = await (await openStore(fixture)).getRun(fixture.runId);
    expect(run.git.target.selectedOid).toBe(missing);
    expect(run.git.planning.status).toBe("preserved");
    expect(run.git.run.status).toBe("preserved");
    expect(run.lifecycle.phase).toBe("blocked");
    expect(run.legacyGitMigration).toMatchObject({
      status: "preserved",
      reason: "legacy selected target commit no longer resolves",
    });
  }, 15_000);

  it("upgrades an already-cleaned terminal namespace without recreating it", async () => {
    const fixture = await repositoryFixture("cleaned");
    await persistLegacyRun(
      fixture,
      legacyGit(fixture, { namespaceStatus: "cleaned", materializedAt: fixture.now }),
      "deleted",
    );

    const run = await (await openStore(fixture)).getRun(fixture.runId);
    expect(run.lifecycle.phase).toBe("deleted");
    expect(run.git.planning.status).toBe("retired");
    expect(run.git.run.status).toBe("retired");
    expect(run.legacyGitMigration).toMatchObject({ status: "migrated" });
    expect(
      await new GitClient(fixture.root).tryResolveRef(`refs/heads/koni/runs/${fixture.runId}`),
    ).toBeUndefined();
  }, 15_000);

  it("requires relocation before a live terminal checkout can use the canonical projection", async () => {
    for (const phase of ["failed", "completed"] as const) {
      const fixture = await repositoryFixture(`terminal-${phase}`);
      await createLegacyWorktree(fixture, fixture.runId);
      const publication =
        phase === "completed"
          ? {
              candidateOid: fixture.baseOid,
              promotionTargetOid: fixture.baseOid,
              mergeReadyAt: fixture.now,
              mergedOid: fixture.baseOid,
            }
          : {};
      await persistLegacyRun(
        fixture,
        legacyGit(fixture, {
          namespaceStatus: "ready",
          materializedAt: fixture.now,
          ...publication,
        }),
        phase,
      );

      const run = await (await openStore(fixture)).getRun(fixture.runId);
      expect(run.lifecycle.phase).toBe(phase);
      expect(run.legacyGitMigration).toMatchObject({ status: "relocation_required" });
      expect(run.legacyGitMigration?.relocation?.priorPhase).toBe(phase);
      expect(run.legacyGitMigration?.source.runWorktree).toBe(fixture.legacyWorktree);
      expect(run.git.run.worktree).toBe(path.join(fixture.legacyWorktree, "integration"));
      expect(
        (await new GitClient(fixture.root).worktrees()).some(
          (entry) => entry.path === fixture.legacyWorktree,
        ),
      ).toBe(true);
    }
  }, 30_000);

  it("relocates a published completed checkout without reopening its terminal lifecycle", async () => {
    const fixture = await repositoryFixture("authority-terminal-relocation", true);
    await createLegacyWorktree(fixture, fixture.runId);
    await persistLegacyRun(
      fixture,
      legacyGit(fixture, {
        namespaceStatus: "ready",
        materializedAt: fixture.now,
        candidateOid: fixture.baseOid,
        promotionTargetOid: fixture.baseOid,
        mergeReadyAt: fixture.now,
        mergedOid: fixture.baseOid,
      }),
      "completed",
    );
    const engine = await RunAuthorityEngine.open({
      projectRoot: fixture.root,
      version: "1.0.0",
      program: dormantProgram(),
      supervisor: new ManagedSessionSupervisor(),
      legacyGit: new LegacyRunGitExecutor({
        now: () => new Date("2026-07-16T19:35:30.000Z"),
        createId: () => "terminal-relocation",
      }),
      now: () => new Date("2026-07-16T19:35:30.000Z"),
    });
    try {
      await engine.start();
      const recovered = await engine.store.getRun(fixture.runId);
      const destination = path.join(fixture.legacyWorktree, "integration");
      expect(recovered.lifecycle.phase).toBe("completed");
      expect(recovered.legacyGitMigration).toMatchObject({
        status: "relocated",
        relocationIntentId: "git-terminal-relocation",
      });
      expect(recovered.git.run).toMatchObject({ status: "ready", worktree: destination });
      expect(
        (await new GitClient(fixture.root).worktrees()).find((entry) => entry.path === destination),
      ).toMatchObject({
        locked: true,
        lockReason: `Koni run ${fixture.runId}`,
      });
    } finally {
      await engine.stop();
    }
  }, 20_000);

  it("preserves a deleted record when its supposedly cleaned flat checkout is still live", async () => {
    const fixture = await repositoryFixture("deleted-live");
    await createLegacyWorktree(fixture, fixture.runId);
    await persistLegacyRun(
      fixture,
      legacyGit(fixture, { namespaceStatus: "ready", materializedAt: fixture.now }),
      "deleted",
    );

    const run = await (await openStore(fixture)).getRun(fixture.runId);
    expect(run.lifecycle.phase).toBe("deleted");
    expect(run.legacyGitMigration).toMatchObject({
      status: "preserved",
      reason: "deleted legacy run still owns a live checkout and requires operator recovery",
    });
    expect(run.legacyGitMigration?.source.runWorktree).toBe(fixture.legacyWorktree);
    expect(run.git.run.worktree).toBe(path.join(fixture.legacyWorktree, "integration"));
    expect(
      (await new GitClient(fixture.root).worktrees()).some(
        (entry) => entry.path === fixture.legacyWorktree,
      ),
    ).toBe(true);
  }, 15_000);

  it("does not reinterpret a malformed new lifecycle record as legacy state", async () => {
    const fixture = await repositoryFixture("strict-new");
    const record = runRecord(fixture, "draft", {});
    const store = await openStore(fixture);
    await store.commit({ expectedRevision: 0, runWrites: [{ record, expectedRevision: null }] });
    const file = path.join(fixture.stateRoot, "runs", fixture.runId, "run.json");
    const raw = structuredClone(record) as unknown as Record<string, unknown>;
    raw.git = { protocol: "koni.git-lifecycle.v1", runId: fixture.runId };
    await writeRunAndTrust(fixture, raw);

    await expect(openStore(fixture)).rejects.toThrow("Git lifecycle");
    const persisted = JSON.parse(await readFile(file, "utf8")) as { git: { protocol: string } };
    expect(persisted.git.protocol).toBe("koni.git-lifecycle.v1");
  }, 15_000);

  it("rejects an obsolete flat source path reintroduced into a migrated lifecycle", async () => {
    const fixture = await repositoryFixture("flat-projection-tamper");
    await createLegacyWorktree(fixture, fixture.runId);
    await persistLegacyRun(
      fixture,
      legacyGit(fixture, { namespaceStatus: "ready", materializedAt: fixture.now }),
      "executing",
    );

    const store = await openStore(fixture);
    const migrated = await store.getRun(fixture.runId);
    expect(migrated.legacyGitMigration?.source.runWorktree).toBe(fixture.legacyWorktree);
    expect(migrated.git.run.worktree).toBe(path.join(fixture.legacyWorktree, "integration"));

    const file = path.join(fixture.stateRoot, "runs", fixture.runId, "run.json");
    const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    const git = raw.git as {
      namespace: { runWorktree: string };
      run: { worktree: string };
    };
    git.namespace.runWorktree = fixture.legacyWorktree;
    git.run.worktree = fixture.legacyWorktree;
    await writeRunAndTrust(fixture, raw);

    await expect(openStore(fixture)).rejects.toThrow("outside its authority namespace");
    expect(await new GitClient(fixture.legacyWorktree).statusEntries()).toEqual([]);
    await expect(readFile(path.join(fixture.legacyWorktree, "README.md"), "utf8")).resolves.toBe(
      "base\n",
    );
  }, 15_000);

  it("relocates a clean legacy checkout through staging and returns compiler-owned projections", async () => {
    const fixture = await repositoryFixture("relocate-complete");
    await createLegacyWorktree(fixture, fixture.runId);
    const ticket = ticketRecord("ticket-one", fixture.legacyWorktree, `koni/runs/${fixture.runId}`);
    await persistLegacyRun(
      fixture,
      legacyGit(fixture, { namespaceStatus: "ready", materializedAt: fixture.now }),
      "executing",
      { [ticket.id]: ticket },
    );
    const run = await (await openStore(fixture)).getRun(fixture.runId);
    const journal = new MemoryLegacyJournal();
    const executor = new LegacyRunGitExecutor({
      now: () => new Date("2026-07-16T19:30:00.000Z"),
      createId: () => "relocate-complete",
    });
    const targetBefore = await new GitClient(fixture.root).resolveRef("refs/heads/main");

    const result = await executor.relocate(run, journal);

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error(result.reason);
    const final = path.join(fixture.legacyWorktree, "integration");
    expect(result.lifecycle.namespace.runWorktree).toBe(final);
    expect(result.lifecycle.run).toMatchObject({ status: "ready", worktree: final });
    expect(result.migration).toMatchObject({
      status: "relocated",
      relocationIntentId: "git-relocate-complete",
    });
    const registration = (await new GitClient(fixture.root).worktrees()).find(
      (entry) => entry.path === final,
    );
    expect(registration).toMatchObject({
      branch: `refs/heads/koni/runs/${fixture.runId}`,
      locked: true,
      lockReason: `Koni run ${fixture.runId}`,
    });
    expect(await readdir(fixture.legacyWorktree)).toEqual(["integration"]);
    expect(journal.settlements[0]?.clearTicketProjectionIds).toEqual(["ticket-one"]);
    expect(await new GitClient(fixture.root).resolveRef("refs/heads/main")).toBe(targetBefore);
    expect(journal.pending.size).toBe(0);
  }, 15_000);

  it("quiesces and relocates a paused legacy run during authority recovery", async () => {
    const fixture = await repositoryFixture("authority-relocation", true);
    await createLegacyWorktree(fixture, fixture.runId);
    const ticket = ticketRecord("ticket-one", fixture.legacyWorktree, `koni/runs/${fixture.runId}`);
    await persistLegacyRun(
      fixture,
      legacyGit(fixture, { namespaceStatus: "ready", materializedAt: fixture.now }),
      "paused",
      { [ticket.id]: ticket },
    );
    const engine = await RunAuthorityEngine.open({
      projectRoot: fixture.root,
      version: "1.0.0",
      program: dormantProgram(),
      supervisor: new ManagedSessionSupervisor(),
      legacyGit: new LegacyRunGitExecutor({
        now: () => new Date("2026-07-16T19:35:00.000Z"),
        createId: () => "authority-relocation",
      }),
      now: () => new Date("2026-07-16T19:35:00.000Z"),
    });
    try {
      await engine.start();
      const recovered = await engine.store.getRun(fixture.runId);
      expect(recovered.legacyGitMigration).toMatchObject({
        status: "relocated",
        relocationIntentId: "git-authority-relocation",
      });
      expect(recovered.lifecycle).toMatchObject({ phase: "paused", resumePhase: "executing" });
      expect(recovered.git.run).toMatchObject({
        status: "ready",
        worktree: path.join(fixture.legacyWorktree, "integration"),
      });
      expect(recovered.tickets["ticket-one"]?.worktreePath).toBeUndefined();
      expect(recovered.tickets["ticket-one"]?.branch).toBeUndefined();
      expect(recovered.tickets["ticket-one"]?.gitCycleId).toBeUndefined();
      expect(recovered.pendingGitIntents).toEqual({});
      expect(recovered.gitReceipts?.at(-1)).toMatchObject({
        kind: "legacy_run_relocate",
        status: "completed",
      });
      expect(
        recovered.activity.some((entry) => entry.message.includes("Quiesced legacy run")),
      ).toBe(true);
    } finally {
      await engine.stop();
    }
  }, 20_000);

  it("finishes an already-durable legacy deletion through the legacy source journal", async () => {
    const fixture = await repositoryFixture("authority-legacy-delete", true);
    await createLegacyWorktree(fixture, fixture.runId);
    await persistLegacyRun(
      fixture,
      legacyGit(fixture, { namespaceStatus: "ready", materializedAt: fixture.now }),
      "deleting",
    );
    const targetBefore = await new GitClient(fixture.root).resolveRef("refs/heads/main");
    const engine = await RunAuthorityEngine.open({
      projectRoot: fixture.root,
      version: "1.0.0",
      program: dormantProgram(),
      supervisor: new ManagedSessionSupervisor(),
      legacyGit: new LegacyRunGitExecutor({
        now: () => new Date("2026-07-16T19:36:00.000Z"),
        createId: () => "authority-delete",
      }),
      now: () => new Date("2026-07-16T19:36:00.000Z"),
    });
    try {
      await engine.start();
      const deleted = await engine.store.getRun(fixture.runId);
      expect(deleted.lifecycle.phase).toBe("deleted");
      expect(deleted.legacyGitMigration).toMatchObject({
        status: "retired",
        retirementIntentId: "git-authority-delete",
      });
      expect(deleted.gitReceipts?.at(-1)).toMatchObject({
        kind: "legacy_run_retire",
        status: "completed",
      });
      expect(
        await new GitClient(fixture.root).tryResolveRef(`refs/heads/koni/runs/${fixture.runId}`),
      ).toBeUndefined();
      expect(await new GitClient(fixture.root).resolveRef("refs/heads/main")).toBe(targetBefore);
    } finally {
      await engine.stop();
    }
  }, 20_000);

  it("recovers from both relocation move boundaries without repeating the first move", async () => {
    for (const fault of [
      "after_legacy_source_staged",
      "after_legacy_destination_moved",
      "after_legacy_destination_locked",
    ] as const) {
      const fixture = await repositoryFixture(`relocate-${fault}`);
      await createLegacyWorktree(fixture, fixture.runId);
      await persistLegacyRun(
        fixture,
        legacyGit(fixture, { namespaceStatus: "ready", materializedAt: fixture.now }),
        "executing",
      );
      const run = await (await openStore(fixture)).getRun(fixture.runId);
      const journal = new MemoryLegacyJournal();
      const crashing = new LegacyRunGitExecutor({
        now: () => new Date("2026-07-16T19:31:00.000Z"),
        createId: () => `crash-${fault}`,
        effectFault: (point) => {
          if (point === fault) throw new Error(`crash at ${fault}`);
        },
      });
      await expect(crashing.relocate(run, journal)).rejects.toThrow(`crash at ${fault}`);
      expect(journal.pending.size).toBe(1);
      const intent = [...journal.pending.values()][0]!;
      expect(intent.kind).toBe("legacy_run_relocate");

      const healthy = new LegacyRunGitExecutor({
        now: () => new Date("2026-07-16T19:32:00.000Z"),
        createId: () => "unused",
      });
      const recovered = await healthy.recover(run, intent, journal);
      if (recovered.status === "preserved") throw new Error(`${fault}: ${recovered.reason}`);
      expect(recovered.status).toBe("completed");
      const final = path.join(fixture.legacyWorktree, "integration");
      expect(
        (await new GitClient(fixture.root).worktrees()).find((entry) => entry.path === final),
      ).toMatchObject({ locked: true });
      expect(journal.pending.size).toBe(0);
    }

    const settlementFixture = await repositoryFixture("relocate-settlement-crash");
    await createLegacyWorktree(settlementFixture, settlementFixture.runId);
    await persistLegacyRun(
      settlementFixture,
      legacyGit(settlementFixture, {
        namespaceStatus: "ready",
        materializedAt: settlementFixture.now,
      }),
      "executing",
    );
    const settlementRun = await (
      await openStore(settlementFixture)
    ).getRun(settlementFixture.runId);
    const settlementJournal = new MemoryLegacyJournal();
    settlementJournal.failNextSettlement = true;
    await expect(
      new LegacyRunGitExecutor({ createId: () => "settlement-crash" }).relocate(
        settlementRun,
        settlementJournal,
      ),
    ).rejects.toThrow("settlement crash");
    const pendingSettlement = [...settlementJournal.pending.values()][0]!;
    const settlementRecovery = await new LegacyRunGitExecutor().recover(
      settlementRun,
      pendingSettlement,
      settlementJournal,
    );
    expect(settlementRecovery.status).toBe("completed");
    expect(settlementJournal.pending.size).toBe(0);
  }, 30_000);

  it("refuses relocation when the observed target changes before intent preparation", async () => {
    const fixture = await repositoryFixture("relocate-target-moved");
    await createLegacyWorktree(fixture, fixture.runId);
    await persistLegacyRun(
      fixture,
      legacyGit(fixture, { namespaceStatus: "ready", materializedAt: fixture.now }),
      "executing",
    );
    const run = await (await openStore(fixture)).getRun(fixture.runId);
    await writeFile(path.join(fixture.root, "target.txt"), "moved\n");
    await git(fixture.root, "add", "target.txt");
    await git(fixture.root, "commit", "-m", "move target");
    const journal = new MemoryLegacyJournal();

    const result = await new LegacyRunGitExecutor().relocate(run, journal);

    expect(result).toMatchObject({ status: "preserved", operation: "relocate" });
    expect(result.status === "preserved" ? result.reason : "").toContain("target evidence changed");
    expect(journal.pending.size).toBe(0);
    expect(
      (await new GitClient(fixture.root).worktrees()).find(
        (entry) => entry.path === fixture.legacyWorktree,
      ),
    ).toBeDefined();
  }, 15_000);

  it("retires an unrelocated legacy checkout with its own intent and never mutates the target", async () => {
    const fixture = await repositoryFixture("retire-legacy");
    await createLegacyWorktree(fixture, fixture.runId);
    await persistLegacyRun(
      fixture,
      legacyGit(fixture, { namespaceStatus: "ready", materializedAt: fixture.now }),
      "executing",
    );
    const run = await (await openStore(fixture)).getRun(fixture.runId);
    const targetBefore = await new GitClient(fixture.root).resolveRef("refs/heads/main");
    const journal = new MemoryLegacyJournal();
    const result = await new LegacyRunGitExecutor({
      now: () => new Date("2026-07-16T19:33:00.000Z"),
      createId: () => "retire-complete",
    }).retire(run, journal);

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error(result.reason);
    expect(result.migration).toMatchObject({
      status: "retired",
      retirementIntentId: "git-retire-complete",
    });
    expect(
      await new GitClient(fixture.root).tryResolveRef(`refs/heads/koni/runs/${fixture.runId}`),
    ).toBeUndefined();
    expect(
      (await new GitClient(fixture.root).worktrees()).some(
        (entry) => entry.path === fixture.legacyWorktree,
      ),
    ).toBe(false);
    expect(await new GitClient(fixture.root).resolveRef("refs/heads/main")).toBe(targetBefore);
    expect(journal.settlements[0]?.operation).toBe("retire");
  }, 15_000);

  it("recovers legacy deletion after worktree retirement and preserves dirty legacy work", async () => {
    const fixture = await repositoryFixture("retire-recovery");
    await createLegacyWorktree(fixture, fixture.runId);
    await persistLegacyRun(
      fixture,
      legacyGit(fixture, { namespaceStatus: "ready", materializedAt: fixture.now }),
      "executing",
    );
    const run = await (await openStore(fixture)).getRun(fixture.runId);
    const journal = new MemoryLegacyJournal();
    const crashing = new LegacyRunGitExecutor({
      createId: () => "retire-crash",
      effectFault: (point) => {
        if (point === "after_legacy_worktree_retired") throw new Error("retirement crash");
      },
    });
    await expect(crashing.retire(run, journal)).rejects.toThrow("retirement crash");
    const intent = [...journal.pending.values()][0]!;
    expect(intent.kind).toBe("legacy_run_retire");
    const recovered = await new LegacyRunGitExecutor().recover(run, intent, journal);
    expect(recovered.status).toBe("completed");
    expect(
      await new GitClient(fixture.root).tryResolveRef(`refs/heads/koni/runs/${fixture.runId}`),
    ).toBeUndefined();

    const dirty = await repositoryFixture("retire-dirty");
    await createLegacyWorktree(dirty, dirty.runId);
    await writeFile(path.join(dirty.legacyWorktree, "keep.txt"), "keep me\n");
    await persistLegacyRun(
      dirty,
      legacyGit(dirty, { namespaceStatus: "ready", materializedAt: dirty.now }),
      "paused",
    );
    const dirtyRun = await (await openStore(dirty)).getRun(dirty.runId);
    const dirtyJournal = new MemoryLegacyJournal();
    const preserved = await new LegacyRunGitExecutor().retire(dirtyRun, dirtyJournal);
    expect(preserved).toMatchObject({ status: "preserved", operation: "retire" });
    expect(dirtyJournal.pending.size).toBe(0);
    expect(await readFile(path.join(dirty.legacyWorktree, "keep.txt"), "utf8")).toBe("keep me\n");
    expect(
      await new GitClient(dirty.root).tryResolveRef(`refs/heads/koni/runs/${dirty.runId}`),
    ).toBe(dirty.baseOid);
  }, 30_000);
});

class MemoryLegacyJournal implements LegacyRunGitJournal {
  public readonly pending = new Map<string, GitLifecycleIntent>();
  public readonly settlements: LegacyRunGitSettlement[] = [];
  public failNextSettlement = false;

  public async prepare(intent: GitLifecycleIntent): Promise<void> {
    this.pending.set(intent.id, structuredClone(intent));
  }

  public async settleLegacy(intentId: string, settlement: LegacyRunGitSettlement): Promise<void> {
    if (!this.pending.has(intentId)) throw new Error(`missing pending intent ${intentId}`);
    if (this.failNextSettlement) {
      this.failNextSettlement = false;
      throw new Error("settlement crash");
    }
    this.pending.delete(intentId);
    this.settlements.push(structuredClone(settlement));
  }
}

interface Fixture {
  root: string;
  stateRoot: string;
  commonDirectory: string;
  runId: string;
  baseOid: string;
  legacyWorktree: string;
  now: string;
}

type LegacyFixturePhase =
  "draft" | "executing" | "paused" | "completed" | "failed" | "deleting" | "deleted";

async function repositoryFixture(label: string, productionState = false): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), `koni-legacy-git-${label}-`));
  roots.push(root);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "Koni Test");
  await git(root, "config", "user.email", "koni@example.invalid");
  await writeFile(path.join(root, "README.md"), "base\n");
  await git(root, "add", "README.md");
  await git(root, "commit", "-m", "base");
  const identity = await GitClient.discover(root);
  const runId = "run-one";
  return {
    root: identity.worktreeRoot,
    stateRoot: path.join(identity.commonDirectory, "koni", productionState ? "" : "test-authority"),
    commonDirectory: identity.commonDirectory,
    runId,
    baseOid: await new GitClient(root).resolveRef("refs/heads/main"),
    legacyWorktree: path.join(identity.commonDirectory, "koni", "worktrees", "runs", runId),
    now: "2026-07-16T19:15:00.000Z",
  };
}

function dormantProgram(): RunCompilerProgram {
  const unexpected = (): never => {
    throw new Error("paused legacy recovery must not launch compiler work");
  };
  return {
    resolveRun: async () => unexpected(),
    initializeDirectApproval: async () => unexpected(),
    prepareAttempt: async () => unexpected(),
    compilePlanningOutput: async () => unexpected(),
    initializeApprovedPlan: async () => unexpected(),
    compileAssignmentOutput: async () => unexpected(),
    verifyRun: async () => unexpected(),
    createIntegrationTicket: async () => unexpected(),
  };
}

async function openStore(fixture: Fixture): Promise<ProjectAuthorityStore> {
  return ProjectAuthorityStore.open({
    stateRoot: fixture.stateRoot,
    projectRoot: fixture.root,
    commonDirectory: fixture.commonDirectory,
  });
}

async function persistLegacyRun(
  fixture: Fixture,
  legacy: LegacyFlatRunGitRecord,
  phase: LegacyFixturePhase,
  tickets: Record<string, TicketRecord> = {},
): Promise<void> {
  const store = await openStore(fixture);
  const record = runRecord(fixture, phase, tickets);
  await store.commit({ expectedRevision: 0, runWrites: [{ record, expectedRevision: null }] });
  const raw = structuredClone(record) as unknown as Record<string, unknown>;
  raw.git = legacy;
  delete raw.pendingGitIntents;
  delete raw.gitReceipts;
  await writeFile(
    path.join(fixture.stateRoot, "runs", fixture.runId, "run.json"),
    `${JSON.stringify(raw)}\n`,
  );
  const stateFile = path.join(fixture.stateRoot, "authority", "state.json");
  const state = JSON.parse(await readFile(stateFile, "utf8")) as Record<string, unknown>;
  delete state.runRecordSha256;
  await writeFile(stateFile, `${JSON.stringify(state)}\n`);
}

async function writeRunAndTrust(fixture: Fixture, run: unknown): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(run)}\n`, "utf8");
  await writeFile(path.join(fixture.stateRoot, "runs", fixture.runId, "run.json"), bytes);
  const stateFile = path.join(fixture.stateRoot, "authority", "state.json");
  const state = JSON.parse(await readFile(stateFile, "utf8")) as {
    runRecordSha256?: Record<string, string>;
  };
  state.runRecordSha256 ??= {};
  state.runRecordSha256[fixture.runId] = rawSha256(bytes);
  await writeFile(stateFile, `${JSON.stringify(state)}\n`);
}

function runRecord(
  fixture: Fixture,
  phase: LegacyFixturePhase,
  tickets: Record<string, TicketRecord>,
): RunRecord {
  return {
    protocol: "koni.run-record.v1",
    id: fixture.runId,
    revision: 0,
    generation: 0,
    projectRoot: fixture.root,
    profile: {
      packageName: "@koni/coding-profile",
      packageVersion: "0.7.0",
      lineage: "koni.software",
      bundleHash: rawSha256("profile"),
    },
    compiledConfigHash: rawSha256("config"),
    runTypeId: "medium",
    objective: "Preserve this run",
    intake: { goal: "Preserve this run" },
    createdAt: fixture.now,
    updatedAt: fixture.now,
    lifecycle: lifecycle(phase),
    pipelineStageIds: ["planning", "approval", "orchestrate", "promotion"],
    currentPipelineStageId: phase === "draft" ? "planning" : "orchestrate",
    plan: undefined,
    graphRevision: 0,
    graphHash: undefined,
    tickets,
    attempts: {},
    questions: {},
    activity: [],
    git: fixtureRunGit(fixture.root, fixture.runId, phase === "draft" ? "planning" : "approved"),
  };
}

function lifecycle(phase: LegacyFixturePhase): RunLifecycleState {
  let state = newRunLifecycle("run-one");
  if (phase === "draft") return state;
  if (phase === "deleting" || phase === "deleted") {
    state = reduceRunLifecycle(state, { type: "planning_started", atMs: 1 }).state;
    state = reduceRunLifecycle(state, { type: "delete_requested", atMs: 2 }).state;
    return phase === "deleted"
      ? reduceRunLifecycle(state, { type: "delete_settled", atMs: 3 }).state
      : state;
  }
  for (const event of [
    { type: "planning_started", atMs: 1 },
    { type: "plan_submitted", atMs: 2 },
    { type: "plan_approval_requested", atMs: 3 },
    { type: "plan_approved", atMs: 4 },
  ] as const)
    state = reduceRunLifecycle(state, event).state;
  if (phase === "completed") {
    state = reduceRunLifecycle(state, { type: "verification_started", atMs: 5 }).state;
    state = reduceRunLifecycle(state, { type: "verification_passed", atMs: 6 }).state;
    state = reduceRunLifecycle(state, { type: "merge_started", atMs: 7 }).state;
    return reduceRunLifecycle(state, { type: "merge_completed", atMs: 8 }).state;
  }
  if (phase === "failed") {
    return reduceRunLifecycle(state, { type: "failed", atMs: 5, reason: "legacy failure" }).state;
  }
  if (phase === "paused") {
    state = reduceRunLifecycle(state, { type: "pause_requested", atMs: 5 }).state;
    state = reduceRunLifecycle(state, { type: "pause_settled", atMs: 6 }).state;
  }
  return state;
}

function legacyGit(
  fixture: Fixture,
  extra: Partial<LegacyFlatRunGitRecord>,
): LegacyFlatRunGitRecord {
  return {
    targetRef: "refs/heads/main",
    targetBaseOid: fixture.baseOid,
    runBranch: `koni/runs/${fixture.runId}`,
    runWorktree: fixture.legacyWorktree,
    ...extra,
  };
}

async function createLegacyWorktree(fixture: Fixture, branchRunId: string): Promise<void> {
  await mkdir(path.dirname(fixture.legacyWorktree), { recursive: true });
  await new GitClient(fixture.root).createWorktree(
    fixture.legacyWorktree,
    `koni/runs/${branchRunId}`,
    fixture.baseOid,
  );
}

function ticketRecord(id: string, worktreePath: string, branch: string): TicketRecord {
  return {
    id,
    operationId: "implement-change",
    title: "Legacy ticket",
    summary: "Legacy ticket",
    status: "ready",
    priority: 1,
    dependencyIds: [],
    targetNodeIds: [],
    readPaths: [],
    writePaths: ["src"],
    steps: [
      {
        id: "implement",
        title: "Implement",
        personaId: "worker",
        status: "pending",
        attemptIds: [],
        summary: undefined,
        startedAt: undefined,
        completedAt: undefined,
      },
    ],
    worktreePath,
    branch,
    blocker: undefined,
    createdAt: "2026-07-16T19:00:00.000Z",
    updatedAt: "2026-07-16T19:00:00.000Z",
  };
}

async function refs(root: string): Promise<string[]> {
  const output = await gitOutput(
    root,
    "for-each-ref",
    "--format=%(refname):%(objectname)",
    "refs/heads",
  );
  return output.split("\n").filter(Boolean).sort();
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await gitOutput(cwd, ...args);
}

function gitOutput(cwd: string, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8").trim());
      else reject(new Error(Buffer.concat(stderr).toString("utf8")));
    });
  });
}
