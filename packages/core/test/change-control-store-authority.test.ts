import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareRunActionExecution } from "../src/authority/action-execution.js";
import {
  resolveExecutionPolicyBinding,
  type ExecutionPolicyBinding,
} from "../src/authority/execution-policy.js";
import { ProjectAuthorityStore } from "../src/authority/project-store.js";
import { FileTransactionStore } from "../src/authority/file-journal.js";
import { MAX_RUN_BYTES, MAX_STATE_BYTES } from "../src/authority/durable-limits.js";
import { executeActionPlan } from "../src/compiler/action-recipes.js";
import {
  compileExecutionSemanticCatalog,
  type CompiledExecutionSemanticCatalog,
} from "../src/compiler/execution-semantics.js";
import type { CompiledConfiguration } from "../src/contracts/configuration.js";
import type { DerivedTicketDefinition, DerivedWorkflowStep } from "../src/contracts/rules.js";
import { canonicalHash, rawSha256, type Sha256Digest } from "../src/shared/canonical.js";
import {
  deriveApprovedChangeMaterialization,
  deriveChangeControlPublication,
  deriveTerminalResolverRetryRequest,
  deriveTerminalResolverReconciliation,
} from "../src/state/change-control.js";
import { newRunLifecycle } from "../src/state/run-lifecycle.js";
import type {
  AgentAttemptRecord,
  CompilerControlTicketAuthority,
  ControlTicketCausalAuthority,
  ControlTicketRole,
  RunActionExecutionArchiveRecord,
  RunActionExecutionRecord,
  RunActionTerminalArchiveAuthority,
  RunRecord,
  TerminalFailureSettlementProof,
  TerminalSuccessSettlementProof,
  TicketExecutionControlRecord,
  TicketRecord,
  TicketStatus,
} from "../src/state/run-record.js";
import {
  createCompilerControlTicketAuthority,
  createRunActionSettlement,
  createTerminalFailureSettlementProof,
  createTerminalSuccessSettlementProof,
  deriveRunActionExecutionArchive,
  deriveRunActionExecutionArchiveSegment,
  terminalFailureBindingFromProof,
  ticketImmutableProjection,
} from "../src/state/run-record.js";
import { runBehaviorSnapshotFixture } from "./fixtures/compiled-behavior.js";
import { attachFixtureTicketCycle, fixtureRunGit } from "./run-record-fixtures.js";

const roots: string[] = [];
const execFileAsync = promisify(execFile);
const CONTROL_AT = "2026-07-18T05:00:00.000Z";
const CONTROL_ROLES: readonly ControlTicketRole[] = [
  "proposal",
  "approved_application",
  "terminal_resolver",
];
const SUCCESS_PROOF_ATTACKS: ReadonlyArray<
  readonly [string, (proof: TerminalSuccessSettlementProof) => void]
> = [
  [
    "run",
    (proof) => {
      proof.runId = "run-foreign";
    },
  ],
  [
    "ticket",
    (proof) => {
      proof.ticketId = "ticket-foreign";
    },
  ],
  [
    "step",
    (proof) => {
      proof.stepId = "step-foreign";
    },
  ],
  [
    "attempt",
    (proof) => {
      proof.attemptId = "attempt-foreign";
    },
  ],
  [
    "action",
    (proof) => {
      proof.actionInvocationId = "action-foreign";
    },
  ],
  [
    "plan",
    (proof) => {
      proof.actionPlanSha256 = digest("foreign-success-plan");
    },
  ],
  [
    "settlement",
    (proof) => {
      proof.actionSettlementSha256 = digest("foreign-success-settlement");
    },
  ],
  [
    "policy",
    (proof) => {
      proof.terminalPolicySha256 = digest("foreign-success-policy");
    },
  ],
  [
    "output",
    (proof) => {
      proof.terminalOutputSha256 = digest("foreign-success-output");
    },
  ],
  [
    "semantic result",
    (proof) => {
      proof.semanticResult.summary = "Attacker-authored success";
    },
  ],
];
const TERMINAL_ARCHIVE_AUTHORITY_ATTACKS: ReadonlyArray<
  readonly [string, (authority: RunActionTerminalArchiveAuthority) => void]
> = [
  [
    "run",
    (authority) => {
      authority.runId = "run-foreign";
    },
  ],
  [
    "invocation",
    (authority) => {
      authority.invocationId = "action-foreign";
    },
  ],
  [
    "boundary",
    (authority) => {
      authority.boundarySha256 = digest("foreign-boundary");
    },
  ],
  [
    "ticket",
    (authority) => {
      authority.ticketId = "ticket-foreign";
    },
  ],
  [
    "step",
    (authority) => {
      authority.stepId = "step-foreign";
    },
  ],
  [
    "attempt",
    (authority) => {
      authority.attemptId = "attempt-foreign";
    },
  ],
  [
    "plan",
    (authority) => {
      authority.actionPlanSha256 = digest("foreign-archive-plan");
    },
  ],
  [
    "settlement",
    (authority) => {
      authority.actionSettlementSha256 = digest("foreign-archive-settlement");
    },
  ],
  [
    "disposition",
    (authority) => {
      authority.settlementDisposition = "failed";
    },
  ],
  [
    "output",
    (authority) => {
      authority.terminalOutputSha256 = digest("foreign-archive-output");
    },
  ],
  [
    "policy",
    (authority) => {
      authority.terminalPolicySha256 = digest("foreign-archive-policy");
    },
  ],
  [
    "proof",
    (authority) => {
      authority.terminalProofSha256 = digest("foreign-archive-proof");
    },
  ],
];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("durable canonical compiler control-ticket authority", () => {
  it.each(CONTROL_ROLES)(
    "accepts exact %s authority through restart and an unrelated store CAS",
    async (role) => {
      const fixture = await storedControlFixture(role);
      const reopened = await ProjectAuthorityStore.open({
        stateRoot: fixture.stateRoot,
        projectRoot: fixture.root,
        commonDirectory: path.join(fixture.root, ".git"),
      });
      const restarted = await reopened.getRun(fixture.run.id);
      expect(
        restarted.tickets[fixture.controlTicketId]?.executionControl?.controlTicketAuthority
          ?.sha256,
      ).toBe(
        fixture.run.tickets[fixture.controlTicketId]!.executionControl!.controlTicketAuthority!
          .sha256,
      );

      const unrelated = structuredClone(restarted);
      unrelated.revision += 1;
      unrelated.updatedAt = "2026-07-18T05:01:00.000Z";
      await expect(
        reopened.commit({
          expectedRevision: 1,
          runWrites: [{ record: unrelated, expectedRevision: 0 }],
        }),
      ).resolves.toMatchObject({ state: { revision: 2 } });
      await expect(reopened.getRun(unrelated.id)).resolves.toMatchObject({
        revision: 1,
        tickets: {
          [fixture.controlTicketId]: {
            executionControl: {
              controlTicketAuthority: { role },
            },
          },
        },
      });
    },
  );

  const cases = CONTROL_ROLES.flatMap((role) =>
    controlAuthorityAttacks().map((attack) => ({ role, attack })),
  );

  it.each(cases)(
    "rejects self-rehashed $role $attack.name substitution on raw store load",
    async ({ role, attack }) => {
      const fixture = await storedControlFixture(role);
      const attacked = structuredClone(fixture.run);
      const ticket = attacked.tickets[fixture.controlTicketId]!;
      const authority = ticket.executionControl!.controlTicketAuthority!;
      attack.mutate(attacked, ticket, authority);
      if (attack.reproject !== false) reprojectControlAuthority(ticket);
      else rehashControlAuthority(authority);

      await overwriteRunAndTrust(fixture, attacked);
      await expect(fixture.store.getRun(attacked.id)).rejects.toThrow();
    },
  );

  it.each(cases)(
    "rejects self-rehashed $role $attack.name substitution in one store CAS",
    async ({ role, attack }) => {
      const fixture = await storedControlFixture(role);
      const attacked = structuredClone(fixture.run);
      attacked.revision += 1;
      attacked.updatedAt = "2026-07-18T05:01:00.000Z";
      const ticket = attacked.tickets[fixture.controlTicketId]!;
      const authority = ticket.executionControl!.controlTicketAuthority!;
      attack.mutate(attacked, ticket, authority);
      if (attack.reproject !== false) reprojectControlAuthority(ticket);
      else rehashControlAuthority(authority);

      await expect(
        fixture.store.commit({
          expectedRevision: 1,
          runWrites: [{ record: attacked, expectedRevision: 0 }],
        }),
      ).rejects.toThrow();
    },
  );
});

describe("durable proposal-decision authority", () => {
  it("accepts an exact v2 event through raw load and one store CAS", async () => {
    const fixture = await proposalFixture(1);
    const proposalId = fixture.proposalIds[0]!;
    const event = proposalDecision(
      fixture.run,
      proposalId,
      "approval",
      "Approve the exact request",
    );
    const next = structuredClone(fixture.run);
    next.revision = 1;
    applyDecision(next.tickets[proposalId]!, event);

    await expect(
      fixture.store.commit({
        expectedRevision: 1,
        runWrites: [{ record: next, expectedRevision: 0 }],
      }),
    ).resolves.toMatchObject({ state: { revision: 2 } });
    await expect(fixture.store.getRun(next.id)).resolves.toMatchObject({
      tickets: {
        [proposalId]: {
          executionControl: {
            proposalDecision: { sha256: event.sha256 },
            proposalApprovalSha256: event.sha256,
          },
        },
      },
    });
  });

  it.each([
    [
      "foreign run",
      (event: ProposalDecisionEvent) => rehashDecision({ ...event, runId: "run-foreign" }),
    ],
    [
      "foreign proposal",
      (event: ProposalDecisionEvent) =>
        rehashDecision({ ...event, proposalTicketId: "proposal-foreign" }),
    ],
    [
      "changed request",
      (event: ProposalDecisionEvent) =>
        rehashDecision({ ...event, requestSha256: digest("foreign-request") }),
    ],
    [
      "non-operator actor",
      (event: ProposalDecisionEvent) => rehashDecision({ ...event, actor: "lead" }),
    ],
  ])("rejects a self-hashed %s substitution on raw load", async (_label, attack) => {
    const fixture = await proposalFixture(1);
    const proposalId = fixture.proposalIds[0]!;
    const attacked = structuredClone(fixture.run);
    const valid = proposalDecision(attacked, proposalId, "approval", "Exact reviewed request");
    applyDecision(attacked.tickets[proposalId]!, attack(valid));

    await overwriteRunAndTrust(fixture, attacked);
    await expect(fixture.store.getRun(attacked.id)).rejects.toThrow();
  });

  it("rejects copying one exact approval to a different proposal in a store CAS", async () => {
    const fixture = await proposalFixture(2);
    const copied = proposalDecision(
      fixture.run,
      fixture.proposalIds[0]!,
      "approval",
      "Approve only proposal one",
    );
    const next = structuredClone(fixture.run);
    next.revision = 1;
    applyDecision(next.tickets[fixture.proposalIds[1]!]!, copied);

    await expect(
      fixture.store.commit({
        expectedRevision: 1,
        runWrites: [{ record: next, expectedRevision: 0 }],
      }),
    ).rejects.toThrow(/proposal decision|decision authority|proposal/u);
  });

  it("rejects the portable legacy event shape and its promotion from history", async () => {
    const fixture = await proposalFixture(1);
    const proposalId = fixture.proposalIds[0]!;
    const valid = proposalDecision(fixture.run, proposalId, "approval", "Legacy-shaped approval");
    const legacyMaterial = {
      protocol: "koni.proposal-decision-authority.v1",
      eventId: valid.eventId,
      decision: valid.decision,
      actor: valid.actor,
      recordedAt: valid.recordedAt,
      message: valid.message,
    };
    const legacy = { ...legacyMaterial, sha256: canonicalHash(legacyMaterial) };
    const attacked = structuredClone(fixture.run) as unknown as {
      id: string;
      tickets: Record<string, { executionControl: Record<string, unknown> }>;
    };
    const control = attacked.tickets[proposalId]!.executionControl;
    control.proposalDecisionHistory = [legacy];
    control.proposalDecision = legacy;
    control.proposalApprovalSha256 = legacy.sha256;
    control.proposalDisposition = { kind: "approved", authoritySha256: legacy.sha256 };

    await overwriteRunAndTrust(fixture, attacked);
    await expect(fixture.store.getRun(attacked.id)).rejects.toThrow(/proposal decision/u);
  });
});

describe("approved-application Git publication authority", () => {
  const boundaries = ["raw load", "store CAS"] as const;
  const attacks: ReadonlyArray<
    Readonly<{
      name: string;
      mutate: (fixture: Awaited<ReturnType<typeof completedApplicationReleaseFixture>>) => void;
    }>
  > = [
    {
      name: "active unpublished cycle",
      mutate: ({ cycle }) => {
        cycle.status = "active";
        cycle.integratedRunOid = undefined;
        cycle.squashCommitOid = undefined;
        cycle.integratedAt = undefined;
        cycle.retiredAt = undefined;
      },
    },
    {
      name: "cycle owned by the wrong ticket",
      mutate: ({ cycle, proposal }) => {
        cycle.ticketId = proposal.id;
      },
    },
    {
      name: "superseded retired cycle",
      mutate: ({ cycle, run }) => {
        const supersessionSha256 = digest("unintegrated-application-supersession");
        cycle.status = "retired";
        cycle.integratedRunOid = undefined;
        cycle.squashCommitOid = undefined;
        cycle.integratedAt = undefined;
        cycle.retiredAt = "2026-07-18T05:02:01.000Z";
        cycle.supersededAt = cycle.retiredAt;
        cycle.supersessionSha256 = supersessionSha256;
        cycle.archiveRef = `refs/koni/archive/${run.id}/tickets/${cycle.ticketId}/cycles/${cycle.cycleId}/${supersessionSha256.slice("sha256:".length)}`;
      },
    },
    {
      name: "integrated but unretired cycle",
      mutate: ({ cycle }) => {
        cycle.status = "integrated";
        cycle.retiredAt = undefined;
      },
    },
    {
      name: "duplicate owned cycle",
      mutate: ({ cycle, run }) => {
        const duplicate = structuredClone(cycle);
        duplicate.cycleId = `${cycle.cycleId}-duplicate`;
        duplicate.ordinal += 1;
        duplicate.branchRef = `${cycle.branchRef}-duplicate`;
        duplicate.worktree = `${cycle.worktree}-duplicate`;
        run.git.ticketCycles[duplicate.cycleId] = duplicate;
        run.git.ticketCycleOrder.push(duplicate.cycleId);
      },
    },
    {
      name: "mismatched publication commit",
      mutate: ({ cycle }) => {
        cycle.squashCommitOid = "c".repeat(40);
      },
    },
  ];

  it.each(boundaries)(
    "accepts exact integrated and retired application release on %s",
    async (boundary) => {
      const fixture = await storedControlFixture("approved_application");
      const exact = await completedApplicationReleaseFixture(fixture);
      if (boundary === "raw load") {
        await overwriteRunAndTrust(fixture, exact.run);
        await expect(fixture.store.getRun(exact.run.id)).resolves.toMatchObject({
          tickets: { [exact.application.id]: { status: "completed" } },
        });
        return;
      }
      const state = await fixture.store.state();
      await expect(
        fixture.store.commit({
          expectedRevision: state.revision,
          runWrites: [{ record: exact.run, expectedRevision: fixture.run.revision }],
        }),
      ).resolves.toBeDefined();
    },
  );

  it.each(boundaries)(
    "accepts a retired no-change application integration on %s",
    async (boundary) => {
      const fixture = await storedControlFixture("approved_application");
      const exact = await completedApplicationReleaseFixture(fixture);
      exact.cycle.squashCommitOid = undefined;
      if (boundary === "raw load") {
        await overwriteRunAndTrust(fixture, exact.run);
        await expect(fixture.store.getRun(exact.run.id)).resolves.toBeDefined();
        return;
      }
      const state = await fixture.store.state();
      await expect(
        fixture.store.commit({
          expectedRevision: state.revision,
          runWrites: [{ record: exact.run, expectedRevision: fixture.run.revision }],
        }),
      ).resolves.toBeDefined();
    },
  );

  it.each(boundaries)(
    "accepts publication after one prior application cycle was superseded on %s",
    async (boundary) => {
      const fixture = await storedControlFixture("approved_application");
      const exact = await completedApplicationReleaseFixture(fixture);
      addSupersededApplicationCycle(exact);
      if (boundary === "raw load") {
        await overwriteRunAndTrust(fixture, exact.run);
        await expect(fixture.store.getRun(exact.run.id)).resolves.toBeDefined();
        return;
      }
      const state = await fixture.store.state();
      await expect(
        fixture.store.commit({
          expectedRevision: state.revision,
          runWrites: [{ record: exact.run, expectedRevision: fixture.run.revision }],
        }),
      ).resolves.toBeDefined();
    },
  );

  it.each(boundaries.flatMap((boundary) => attacks.map((attack) => ({ boundary, attack }))))(
    "rejects $attack.name application release on $boundary",
    async ({ boundary, attack }) => {
      const fixture = await storedControlFixture("approved_application");
      const attacked = await completedApplicationReleaseFixture(fixture);
      const authoritySha256 = attacked.application.executionControl!.controlTicketAuthority!.sha256;
      attack.mutate(attacked);
      expect(attacked.application.executionControl!.controlTicketAuthority!.sha256).toBe(
        authoritySha256,
      );
      if (boundary === "raw load") {
        await overwriteRunAndTrust(fixture, attacked.run);
        await expect(fixture.store.getRun(attacked.run.id)).rejects.toThrow(
          /approved application.*Git publication authority/iu,
        );
        return;
      }
      const state = await fixture.store.state();
      await expect(
        fixture.store.commit({
          expectedRevision: state.revision,
          runWrites: [{ record: attacked.run, expectedRevision: fixture.run.revision }],
        }),
      ).rejects.toThrow(/approved application.*Git publication authority/iu);
    },
  );
});

describe("durable configured-action archive authority", () => {
  it("accepts the exact live-to-archive projection with its artifact in one CAS", async () => {
    const fixture = await actionFixture();
    const transition = archiveTransition(fixture.run, fixture.action);

    await expect(
      fixture.store.commit({
        expectedRevision: 1,
        runWrites: [{ record: transition.next, expectedRevision: 0 }],
        writes: [transition.write],
      }),
    ).resolves.toMatchObject({ state: { revision: 2 } });
    await expect(fixture.store.readArtifact(transition.row.artifactPath)).resolves.toEqual(
      transition.bytes,
    );
  });

  it.each<[string, (row: RunActionExecutionArchiveRecord) => void]>([
    [
      "boundary kind",
      (row) => {
        row.kind = "post_orchestration_report";
      },
    ],
    [
      "action identity",
      (row) => {
        row.actionId = "report";
      },
    ],
    [
      "plan authority",
      (row) => {
        row.planSha256 = digest("foreign-plan");
      },
    ],
    [
      "journal status",
      (row) => {
        row.journalStatus = "failed";
      },
    ],
    [
      "settlement identity",
      (row) => {
        row.settlementSha256 = digest("foreign-settlement");
      },
    ],
    [
      "settlement disposition",
      (row) => {
        row.settlementDisposition = "failed";
      },
    ],
    [
      "artifact path",
      (row) => {
        row.artifactPath = `runs/${row.invocationId}/attacker.json`;
      },
    ],
    [
      "artifact digest",
      (row) => {
        row.artifactSha256 = digest("foreign-artifact");
      },
    ],
    [
      "artifact size",
      (row) => {
        row.artifactSizeBytes += 1;
      },
    ],
  ])("rejects a live-to-archive %s substitution", async (_label, attack) => {
    const fixture = await actionFixture();
    const transition = archiveTransition(fixture.run, fixture.action);
    attack(transition.row);

    await expect(
      fixture.store.commit({
        expectedRevision: 1,
        runWrites: [{ record: transition.next, expectedRevision: 0 }],
        writes: [transition.write],
      }),
    ).rejects.toThrow(/archive|action authority|artifact|projection/u);
  });

  it("rejects arbitrary archive insertion and live/archive identity overlap", async () => {
    const insertedFixture = await actionFixture();
    const insertion = archiveTransition(insertedFixture.run, insertedFixture.action);
    insertion.next.actionExecutions = structuredClone(insertedFixture.run.actionExecutions!);
    insertion.row.invocationId = "action-attacker-insertion";
    insertion.row.artifactPath = `runs/${insertion.next.id}/actions/archive/action-attacker-insertion.json`;

    await expect(
      insertedFixture.store.commit({
        expectedRevision: 1,
        runWrites: [{ record: insertion.next, expectedRevision: 0 }],
        writes: [insertion.write],
      }),
    ).rejects.toThrow(/archive|action authority|overlap|insertion/u);

    const overlapFixture = await actionFixture();
    const overlap = archiveTransition(overlapFixture.run, overlapFixture.action);
    overlap.next.actionExecutions = structuredClone(overlapFixture.run.actionExecutions!);
    await expect(
      overlapFixture.store.commit({
        expectedRevision: 1,
        runWrites: [{ record: overlap.next, expectedRevision: 0 }],
        writes: [overlap.write],
      }),
    ).rejects.toThrow(/archive|action authority|overlap/u);
  });

  it("rejects an arbitrary archive segment that has no exact removed prefix", async () => {
    const fixture = await actionFixture();
    const next = structuredClone(fixture.run);
    next.revision = 1;
    next.actionExecutionArchiveSegments = [
      {
        protocol: "koni.run-action-archive-segment.v1",
        firstInvocationId: "action-first",
        lastInvocationId: "action-last",
        count: 2,
        artifactPath: `runs/${next.id}/actions/archive-index/attacker.json`,
        artifactSha256: digest("attacker-segment"),
        artifactSizeBytes: 2,
        archivedAt: "2026-07-18T00:03:00.000Z",
      },
    ];

    await expect(
      fixture.store.commit({
        expectedRevision: 1,
        runWrites: [{ record: next, expectedRevision: 0 }],
      }),
    ).rejects.toThrow(/archive|segment|prefix|artifact/u);
  });

  it("keeps exact-anchored cold action artifacts lazy until an effect selects them", async () => {
    const fixture = await actionFixture();
    const transition = archiveTransition(fixture.run, fixture.action);
    await fixture.store.commit({
      expectedRevision: 1,
      runWrites: [{ record: transition.next, expectedRevision: 0 }],
      writes: [transition.write],
    });
    await writeFile(path.join(fixture.stateRoot, transition.row.artifactPath), "{}\n");

    await expect(fixture.store.getRun(fixture.run.id)).resolves.toMatchObject({
      actionExecutionArchive: [
        expect.objectContaining({
          invocationId: transition.row.invocationId,
        }),
      ],
    });
  });

  it("loads an exact artifact-bound v1 row read-only, but never permits a new v1 emission", async () => {
    const rejectedFixture = await actionFixture();
    const rejected = archiveTransition(rejectedFixture.run, rejectedFixture.action);
    rejected.row.protocol = "koni.run-action-archive.v1";
    rejected.row.archivedAt = "2026-07-17T23:59:00.000Z";
    await expect(
      rejectedFixture.store.commit({
        expectedRevision: 1,
        runWrites: [{ record: rejected.next, expectedRevision: 0 }],
        writes: [rejected.write],
      }),
    ).rejects.toThrow(/archive|projection/u);

    const legacyFixture = await actionFixture();
    const legacy = archiveTransition(legacyFixture.run, legacyFixture.action);
    legacy.row.protocol = "koni.run-action-archive.v1";
    legacy.row.archivedAt = "2026-07-17T23:59:00.000Z";
    const legacyArtifact = path.join(legacyFixture.stateRoot, legacy.row.artifactPath);
    await mkdir(path.dirname(legacyArtifact), { recursive: true });
    await writeFile(legacyArtifact, legacy.bytes);
    await overwriteRunAndTrust(legacyFixture, legacy.next);
    await expect(legacyFixture.store.getRun(legacyFixture.run.id)).resolves.toMatchObject({
      actionExecutionArchive: [{ protocol: "koni.run-action-archive.v1" }],
    });
  });

  it("preserves append order when an older action settles after one archive-pressure eviction", async () => {
    const fixture = await actionFixture();
    const seeded = structuredClone(fixture.run);
    seeded.revision = 1;
    const [olderSettled, ...newerSettled] = await settledApprovedActions(
      seeded,
      1_025,
      Date.UTC(2026, 6, 17, 23, 0, 0),
    );
    const older = structuredClone(olderSettled!);
    delete older.settlement;
    delete older.settledAt;
    seeded.actionExecutions ??= {};
    seeded.actionExecutions[older.invocationId] = older;
    for (const action of newerSettled) seeded.actionExecutions[action.invocationId] = action;
    await fixture.store.commit({
      expectedRevision: 1,
      runWrites: [{ record: seeded, expectedRevision: 0 }],
    });

    const removable = Object.values(seeded.actionExecutions)
      .filter((action) => action.settlement !== undefined)
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.invocationId.localeCompare(right.invocationId),
      );
    expect(removable).toHaveLength(1_025);
    const initialProjections = removable
      .slice(0, 1_024)
      .map((action) => deriveRunActionExecutionArchive(seeded, action));
    const initiallyArchived = structuredClone(seeded);
    initiallyArchived.revision = 2;
    initiallyArchived.actionExecutions = {
      [older.invocationId]: older,
      [removable[1_024]!.invocationId]: removable[1_024]!,
    };
    initiallyArchived.actionExecutionArchive = initialProjections.map(({ row }) => row);
    await fixture.store.commit({
      expectedRevision: 2,
      runWrites: [{ record: initiallyArchived, expectedRevision: 1 }],
      writes: initialProjections.map(({ row, bytes }) => ({
        path: row.artifactPath,
        bytes,
        expectedSha256: null,
      })),
    });

    const pressureAction = removable[1_024]!;
    const pressureProjection = deriveRunActionExecutionArchive(initiallyArchived, pressureAction);
    const combined = [...initiallyArchived.actionExecutionArchive, pressureProjection.row];
    const compactedPrefix = combined.slice(0, combined.length - 256);
    const retained = combined.slice(compactedPrefix.length);
    const segment = deriveRunActionExecutionArchiveSegment(seeded.id, compactedPrefix);
    const pressured = structuredClone(initiallyArchived);
    pressured.revision = 3;
    pressured.actionExecutions = { [older.invocationId]: older };
    pressured.actionExecutionArchive = retained;
    pressured.actionExecutionArchiveSegments = [segment.segment];
    await fixture.store.commit({
      expectedRevision: 3,
      runWrites: [{ record: pressured, expectedRevision: 2 }],
      writes: [
        {
          path: pressureProjection.row.artifactPath,
          bytes: pressureProjection.bytes,
          expectedSha256: null,
        },
        { path: segment.segment.artifactPath, bytes: segment.bytes, expectedSha256: null },
      ],
    });

    const settled = structuredClone(pressured);
    settled.revision = 4;
    const settledOlder = settled.actionExecutions![older.invocationId]!;
    settledOlder.updatedAt = "2026-07-18T02:00:00.000Z";
    settledOlder.settlement = createRunActionSettlement(
      settledOlder,
      "completed",
      "older action settled after archive pressure",
      settledOlder.updatedAt,
    );
    settledOlder.settledAt = settledOlder.settlement.settledAt;
    await fixture.store.commit({
      expectedRevision: 4,
      runWrites: [{ record: settled, expectedRevision: 3 }],
    });

    const olderProjection = deriveRunActionExecutionArchive(settled, settledOlder);
    const appended = structuredClone(settled);
    appended.revision = 5;
    appended.actionExecutions = {};
    appended.actionExecutionArchive!.push(olderProjection.row);
    await fixture.store.commit({
      expectedRevision: 5,
      runWrites: [{ record: appended, expectedRevision: 4 }],
      writes: [
        {
          path: olderProjection.row.artifactPath,
          bytes: olderProjection.bytes,
          expectedSha256: null,
        },
      ],
    });

    await expect(fixture.store.getRun(appended.id)).resolves.toMatchObject({
      revision: 5,
      actionExecutionArchive: [
        ...Array.from({ length: 256 }, () => expect.any(Object)),
        expect.objectContaining({ invocationId: older.invocationId }),
      ],
      actionExecutionArchiveSegments: [expect.objectContaining({ count: 769 })],
    });
    const reopened = await ProjectAuthorityStore.open({
      stateRoot: fixture.stateRoot,
      projectRoot: fixture.root,
      commonDirectory: path.join(fixture.root, ".git"),
    });
    await expect(reopened.getRun(appended.id)).resolves.toMatchObject({ revision: 5 });
  }, 90_000);

  it.each(["getRun", "guarded open"] as const)(
    "rejects coordinated archive-row descriptor and artifact deletion at %s",
    async (boundary) => {
      const archived = await persistedMultiRowArchiveFixture();
      const attacked = structuredClone(archived.run);
      const [removed] = attacked.actionExecutionArchive!.splice(1, 1);
      await rm(path.join(archived.fixture.stateRoot, removed!.artifactPath));
      await overwriteRun(archived.fixture, attacked);

      const operation =
        boundary === "getRun"
          ? archived.fixture.store.getRun(attacked.id)
          : ProjectAuthorityStore.open({
              stateRoot: archived.fixture.stateRoot,
              projectRoot: archived.fixture.root,
              commonDirectory: path.join(archived.fixture.root, ".git"),
            });
      await expect(operation).rejects.toThrow(/anchor|authority|digest|run bytes/u);
    },
  );

  it.each(["getRun", "guarded open"] as const)(
    "rejects coordinated archive-segment descriptor and exact artifact deletion at %s",
    async (boundary) => {
      const archived = await indexedMultiSegmentArchiveFixture();
      const attacked = structuredClone(archived.run);
      const [removed] = attacked.actionExecutionArchiveSegments!.splice(0, 1);
      const segmentBytes = await readFile(
        path.join(archived.fixture.stateRoot, removed!.artifactPath),
      );
      const rows = JSON.parse(segmentBytes.toString("utf8")) as RunActionExecutionArchiveRecord[];
      await rm(path.join(archived.fixture.stateRoot, removed!.artifactPath));
      await Promise.all(
        rows.map((row) => rm(path.join(archived.fixture.stateRoot, row.artifactPath))),
      );
      await overwriteRun(archived.fixture, attacked);

      const operation =
        boundary === "getRun"
          ? archived.fixture.store.getRun(attacked.id)
          : ProjectAuthorityStore.open({
              stateRoot: archived.fixture.stateRoot,
              projectRoot: archived.fixture.root,
              commonDirectory: path.join(archived.fixture.root, ".git"),
            });
      await expect(operation).rejects.toThrow(/anchor|authority|digest|run bytes/u);
    },
  );

  it.each(["raw load", "store CAS"] as const)(
    "rejects archive-row deletion, reordering, and duplicate indices on %s",
    async (boundary) => {
      const archived = await persistedMultiRowArchiveFixture();
      const attacks: ReadonlyArray<readonly [string, (run: RunRecord) => void]> = [
        [
          "row deletion",
          (run) => {
            run.actionExecutionArchive!.splice(1, 1);
          },
        ],
        [
          "row reordering",
          (run) => {
            run.actionExecutionArchive!.reverse();
          },
        ],
        [
          "duplicate row index",
          (run) => {
            run.actionExecutionArchive!.splice(
              1,
              0,
              structuredClone(run.actionExecutionArchive![0]!),
            );
          },
        ],
      ];
      for (const [name, attack] of attacks) {
        const malformed = structuredClone(archived.run);
        attack(malformed);
        await expectMalformedRunRejected(
          archived,
          malformed,
          boundary,
          `${name} (${boundary})`,
          /anchor|archive|action authority|append-only|identity|projection/u,
          false,
        );
      }
    },
  );

  it.each(["raw load", "store CAS"] as const)(
    "rejects archive-segment deletion, reordering, boundary mutation, and duplicate indices on %s",
    async (boundary) => {
      const archived = await indexedMultiSegmentArchiveFixture();
      const attacks: ReadonlyArray<readonly [string, (run: RunRecord) => void]> = [
        [
          "segment deletion",
          (run) => {
            run.actionExecutionArchiveSegments!.splice(0, 1);
          },
        ],
        [
          "segment reordering",
          (run) => {
            run.actionExecutionArchiveSegments!.reverse();
          },
        ],
        [
          "segment count",
          (run) => {
            run.actionExecutionArchiveSegments![0]!.count += 1;
          },
        ],
        [
          "segment first invocation",
          (run) => {
            run.actionExecutionArchiveSegments![0]!.firstInvocationId = "action-foreign-first";
          },
        ],
        [
          "segment last invocation",
          (run) => {
            run.actionExecutionArchiveSegments![0]!.lastInvocationId = "action-foreign-last";
          },
        ],
        [
          "duplicate segment index",
          (run) => {
            run.actionExecutionArchiveSegments!.push(
              structuredClone(run.actionExecutionArchiveSegments![0]!),
            );
          },
        ],
      ];
      for (const [name, attack] of attacks) {
        const malformed = structuredClone(archived.run);
        attack(malformed);
        await expectMalformedRunRejected(
          archived,
          malformed,
          boundary,
          `${name} (${boundary})`,
          /anchor|archive|segment|append-only|artifact|index|projection/u,
          false,
        );
      }
    },
  );
});

describe("non-evictable terminal settlement proof authority", () => {
  it.each<[string, (proof: TerminalFailureSettlementProof) => void]>([
    [
      "run",
      (proof) => {
        proof.runId = "run-foreign";
      },
    ],
    [
      "ticket",
      (proof) => {
        proof.ticketId = "ticket-foreign";
      },
    ],
    [
      "step",
      (proof) => {
        proof.stepId = "step-foreign";
      },
    ],
    [
      "attempt",
      (proof) => {
        proof.attemptId = "attempt-foreign";
      },
    ],
    [
      "action",
      (proof) => {
        proof.actionInvocationId = "action-foreign";
      },
    ],
    [
      "plan",
      (proof) => {
        proof.actionPlanSha256 = digest("foreign-action-plan");
      },
    ],
    [
      "settlement",
      (proof) => {
        proof.actionSettlementSha256 = digest("foreign-action-settlement");
      },
    ],
    [
      "policy",
      (proof) => {
        proof.terminalPolicySha256 = digest("foreign-terminal-policy");
      },
    ],
    [
      "output",
      (proof) => {
        proof.terminalOutputSha256 = digest("foreign-terminal-output");
      },
    ],
  ])("rejects a self-hashed live failure-proof %s substitution", async (_label, attack) => {
    const fixture = await assignmentActionFixture("failed");
    const attacked = structuredClone(fixture.run);
    const exact = Object.values(attacked.terminalFailureProofs!)[0]!;
    const forged = structuredClone(exact);
    attack(forged);
    rehashFailureProof(forged);
    attacked.terminalFailureProofs = { [forged.sha256]: forged };

    await overwriteRunAndTrust(fixture, attacked);
    await expect(fixture.store.getRun(attacked.id)).rejects.toThrow(
      /failure proof|settlement|attempt/u,
    );
  });

  it("rejects a self-hashed semantic-result substitution against the live settlement", async () => {
    const fixture = await assignmentActionFixture("failed");
    const attacked = structuredClone(fixture.run);
    const forged = structuredClone(Object.values(attacked.terminalFailureProofs!)[0]!);
    forged.semanticResult.blocker = "Attacker-authored semantic failure";
    rehashFailureProof(forged);
    attacked.terminalFailureProofs = { [forged.sha256]: forged };

    await overwriteRunAndTrust(fixture, attacked);
    await expect(fixture.store.getRun(attacked.id)).rejects.toThrow(/failure proof|settlement/u);
  });

  it.each(SUCCESS_PROOF_ATTACKS)(
    "rejects a self-hashed live success-proof %s substitution on raw load",
    async (_label, attack) => {
      const fixture = await assignmentActionFixture("completed");
      const attacked = structuredClone(fixture.run);
      const forged = structuredClone(Object.values(attacked.terminalSuccessProofs!)[0]!);
      attack(forged);
      rehashSuccessProof(forged);
      attacked.terminalSuccessProofs = { [forged.sha256]: forged };

      await overwriteRunAndTrust(fixture, attacked);
      await expect(fixture.store.getRun(attacked.id)).rejects.toThrow(
        /success proof|settlement|attempt|terminal acceptance/u,
      );
    },
  );

  it.each(SUCCESS_PROOF_ATTACKS)(
    "rejects a self-hashed live success-proof %s substitution in one store CAS",
    async (_label, attack) => {
      const fixture = await assignmentActionFixture("completed");
      const attacked = structuredClone(fixture.run);
      attacked.revision += 1;
      attacked.updatedAt = "2026-07-18T00:03:00.000Z";
      const forged = structuredClone(Object.values(attacked.terminalSuccessProofs!)[0]!);
      attack(forged);
      rehashSuccessProof(forged);
      attacked.terminalSuccessProofs = { [forged.sha256]: forged };

      await expect(
        fixture.store.commit({
          expectedRevision: 1,
          runWrites: [{ record: attacked, expectedRevision: 0 }],
        }),
      ).rejects.toThrow(/success proof|settlement|attempt|terminal acceptance/u);
    },
  );

  it.each(["raw load", "store CAS"] as const)(
    "rejects removing exact terminal-success proof authority on %s",
    async (boundary) => {
      const fixture = await assignmentActionFixture("completed");
      const attacked = structuredClone(fixture.run);
      attacked.terminalSuccessProofs = {};
      if (boundary === "raw load") {
        await overwriteRunAndTrust(fixture, attacked);
        await expect(fixture.store.getRun(attacked.id)).rejects.toThrow(
          /semantic proof|success proof|terminal acceptance/u,
        );
        return;
      }
      attacked.revision += 1;
      attacked.updatedAt = "2026-07-18T00:03:00.000Z";
      await expect(
        fixture.store.commit({
          expectedRevision: 1,
          runWrites: [{ record: attacked, expectedRevision: 0 }],
        }),
      ).rejects.toThrow(/semantic proof|success proof|terminal acceptance/u);
    },
  );

  it.each(["raw load", "store CAS"] as const)(
    "rejects adding a self-hashed terminal-success proof over a failed action on %s",
    async (boundary) => {
      const fixture = await assignmentActionFixture("failed");
      const attacked = structuredClone(fixture.run);
      const action = Object.values(attacked.actionExecutions!)[0]!;
      const attempt = attacked.attempts[action.boundary.attemptId!]!;
      const semanticResult = {
        kind: "assignment" as const,
        status: "completed" as const,
        summary: "Forged success over failed settlement",
      };
      const material = {
        protocol: "koni.terminal-success-settlement.v1" as const,
        runId: attacked.id,
        ticketId: action.boundary.ticketId!,
        stepId: action.boundary.stepId!,
        attemptId: attempt.id,
        actionInvocationId: action.invocationId,
        actionPlanSha256: action.plan.sha256,
        actionSettlementSha256: action.settlement!.sha256,
        semanticResult,
        semanticResultSha256: canonicalHash(semanticResult),
        terminalPolicySha256: attempt.terminalPolicy!.sha256,
        terminalOutputSha256: attempt.terminalOutputSha256!,
      };
      const forged = { ...material, sha256: canonicalHash(material) };
      attacked.terminalSuccessProofs = { [forged.sha256]: forged };
      if (boundary === "raw load") {
        await overwriteRunAndTrust(fixture, attacked);
        await expect(fixture.store.getRun(attacked.id)).rejects.toThrow(
          /success proof|settlement|semantic proof|terminal acceptance/u,
        );
        return;
      }
      attacked.revision += 1;
      attacked.updatedAt = "2026-07-18T00:03:00.000Z";
      await expect(
        fixture.store.commit({
          expectedRevision: 1,
          runWrites: [{ record: attacked, expectedRevision: 0 }],
        }),
      ).rejects.toThrow(/success proof|settlement|semantic proof|terminal acceptance/u);
    },
  );

  const archiveBoundaries = ["raw load", "store CAS"] as const;
  const archivedSuccessSubstitutions = archiveBoundaries.flatMap((boundary) =>
    SUCCESS_PROOF_ATTACKS.map(([name, attack]) => ({ boundary, name, attack })),
  );

  it.each(archivedSuccessSubstitutions)(
    "rejects archived terminal-success $name substitution on $boundary",
    async ({ boundary, attack }) => {
      const archived = await persistedAssignmentArchiveFixture("completed");
      const attacked = structuredClone(archived.run);
      const forged = structuredClone(Object.values(attacked.terminalSuccessProofs!)[0]!);
      attack(forged);
      rehashSuccessProof(forged);
      attacked.terminalSuccessProofs = { [forged.sha256]: forged };

      await expectMalformedRunRejected(
        archived,
        attacked,
        boundary,
        `archived terminal-success substitution (${boundary})`,
        /archive|success proof|settlement|terminal acceptance/u,
      );
    },
  );

  it.each(archiveBoundaries)(
    "rejects removing archived terminal-success authority on %s",
    async (boundary) => {
      const archived = await persistedAssignmentArchiveFixture("completed");
      const attacked = structuredClone(archived.run);
      attacked.terminalSuccessProofs = {};

      await expectMalformedRunRejected(
        archived,
        attacked,
        boundary,
        `removed archived terminal-success proof (${boundary})`,
        /archive|semantic proof|success proof|terminal acceptance/u,
      );
    },
  );

  it.each(archiveBoundaries)(
    "rejects adding a detached terminal-success index beside exact archived authority on %s",
    async (boundary) => {
      const archived = await persistedAssignmentArchiveFixture("completed");
      const attacked = structuredClone(archived.run);
      const exact = Object.values(attacked.terminalSuccessProofs!)[0]!;
      const extra = structuredClone(exact);
      extra.attemptId = "attempt-detached-success";
      extra.actionInvocationId = "action-detached-success";
      rehashSuccessProof(extra);
      attacked.terminalSuccessProofs![extra.sha256] = extra;

      await expectMalformedRunRejected(
        archived,
        attacked,
        boundary,
        `extra archived terminal-success proof (${boundary})`,
        /archive|success proof|settlement|attempt|terminal acceptance/u,
      );
    },
  );

  it.each(archiveBoundaries)(
    "rejects adding success authority over an archived failed action on %s",
    async (boundary) => {
      const archived = await persistedAssignmentArchiveFixture("failed");
      const attacked = structuredClone(archived.run);
      const forged = forgedSuccessProof(archived.fixture.run, archived.fixture.action);
      attacked.terminalSuccessProofs = { [forged.sha256]: forged };

      await expectMalformedRunRejected(
        archived,
        attacked,
        boundary,
        `success proof over archived failure (${boundary})`,
        /archive|success proof|settlement|semantic proof|terminal acceptance/u,
      );
    },
  );

  it("keeps one exact failure proof valid after archival, but rejects an index/archive disagreement", async () => {
    const exactFixture = await assignmentActionFixture("failed");
    const exactTransition = archiveTransition(exactFixture.run, exactFixture.action);
    await exactFixture.store.commit({
      expectedRevision: 1,
      runWrites: [{ record: exactTransition.next, expectedRevision: 0 }],
      writes: [exactTransition.write],
    });
    await expect(exactFixture.store.getRun(exactFixture.run.id)).resolves.toBeDefined();

    const attackedFixture = await assignmentActionFixture("failed");
    const attackedTransition = archiveTransition(attackedFixture.run, attackedFixture.action);
    const indexed = structuredClone(
      Object.values(attackedTransition.next.terminalFailureProofs!)[0]!,
    );
    indexed.actionInvocationId = "action-detached-from-archive";
    rehashFailureProof(indexed);
    attackedTransition.next.terminalFailureProofs = { [indexed.sha256]: indexed };
    await overwriteRunAndTrust(attackedFixture, attackedTransition.next);
    await expect(attackedFixture.store.getRun(attackedFixture.run.id)).rejects.toThrow(
      /failure proof|archive|action authority/u,
    );
  });

  it("rejects interpreting one archived successful action as a failed settlement", async () => {
    const fixture = await assignmentActionFixture("completed");
    const transition = archiveTransition(fixture.run, fixture.action);
    const semanticResult = {
      kind: "assignment" as const,
      status: "failed" as const,
      blocker: "Forged failure over a successful settlement",
    };
    const attempt = fixture.run.attempts[fixture.action.boundary.attemptId!]!;
    const material = {
      protocol: "koni.terminal-failure-settlement.v1" as const,
      runId: fixture.run.id,
      ticketId: fixture.action.boundary.ticketId!,
      stepId: fixture.action.boundary.stepId!,
      attemptId: attempt.id,
      actionInvocationId: fixture.action.invocationId,
      actionPlanSha256: fixture.action.plan.sha256,
      actionSettlementSha256: fixture.action.settlement!.sha256,
      semanticResult,
      semanticResultSha256: canonicalHash(semanticResult),
      terminalPolicySha256: attempt.terminalPolicy!.sha256,
      terminalOutputSha256: attempt.terminalOutputSha256!,
    };
    const forged = { ...material, sha256: canonicalHash(material) };
    transition.row.terminalFailureProof = forged;
    transition.next.terminalFailureProofs = { [forged.sha256]: forged };

    await overwriteRunAndTrust(fixture, transition.next);
    await expect(fixture.store.getRun(fixture.run.id)).rejects.toThrow(
      /failure proof|archive|settlement disposition/u,
    );
  });

  it("rejects a missing v2 row terminal-authority projection", async () => {
    const fixture = await assignmentActionFixture("completed");
    const transition = archiveTransition(fixture.run, fixture.action);
    expect(transition.row.protocol).toBe("koni.run-action-archive.v2");
    expect(transition.row.terminalAuthority).toBeDefined();
    delete transition.row.terminalAuthority;
    const artifact = path.join(fixture.stateRoot, transition.row.artifactPath);
    await mkdir(path.dirname(artifact), { recursive: true });
    await writeFile(artifact, transition.bytes);
    await overwriteRunAndTrust(fixture, transition.next);

    await expect(fixture.store.getRun(fixture.run.id)).rejects.toThrow(
      /archive|terminal|projection|validation action/u,
    );
  });

  it.each(TERMINAL_ARCHIVE_AUTHORITY_ATTACKS)(
    "keeps a self-hashed cold v2 row terminal-authority %s substitution lazy",
    async (_label, attack) => {
      const fixture = await assignmentActionFixture("completed");
      const transition = archiveTransition(fixture.run, fixture.action);
      expect(transition.row.protocol).toBe("koni.run-action-archive.v2");
      const authority = transition.row.terminalAuthority;
      if (authority === undefined)
        throw new Error("completed archive fixture lacks terminal authority");
      attack(authority);
      rehashTerminalArchiveAuthority(authority);
      const artifact = path.join(fixture.stateRoot, transition.row.artifactPath);
      await mkdir(path.dirname(artifact), { recursive: true });
      await writeFile(artifact, transition.bytes);
      await overwriteRunAndTrust(fixture, transition.next);

      if (_label === "boundary") {
        await expect(fixture.store.getRun(fixture.run.id)).resolves.toMatchObject({
          actionExecutionArchive: [
            expect.objectContaining({ invocationId: transition.row.invocationId }),
          ],
        });
      } else {
        await expect(fixture.store.getRun(fixture.run.id)).rejects.toThrow(
          /archive|terminal|projection|validation action/u,
        );
      }
    },
  );

  it("rejects a missing v2 segment terminal-authority projection", async () => {
    const fixture = await assignmentActionFixture("completed");
    const transition = archiveTransition(fixture.run, fixture.action);
    const projection = deriveRunActionExecutionArchiveSegment(fixture.run.id, [transition.row]);
    expect(projection.segment.protocol).toBe("koni.run-action-archive-segment.v2");
    expect(projection.segment.terminalAuthorities).toHaveLength(1);
    delete projection.segment.terminalAuthorities;
    const next = transition.next;
    next.actionExecutionArchive = [];
    next.actionExecutionArchiveSegments = [projection.segment];
    const actionArtifact = path.join(fixture.stateRoot, transition.row.artifactPath);
    const segmentArtifact = path.join(fixture.stateRoot, projection.segment.artifactPath);
    await mkdir(path.dirname(actionArtifact), { recursive: true });
    await mkdir(path.dirname(segmentArtifact), { recursive: true });
    await writeFile(actionArtifact, transition.bytes);
    await writeFile(segmentArtifact, projection.bytes);
    await overwriteRunAndTrust(fixture, next);

    await expect(fixture.store.getRun(fixture.run.id)).rejects.toThrow(
      /archive|terminal|projection|validation action/u,
    );
  });

  it.each(TERMINAL_ARCHIVE_AUTHORITY_ATTACKS)(
    "keeps a self-hashed cold v2 segment terminal-authority %s substitution lazy",
    async (_label, attack) => {
      const fixture = await assignmentActionFixture("completed");
      const transition = archiveTransition(fixture.run, fixture.action);
      const projection = deriveRunActionExecutionArchiveSegment(fixture.run.id, [transition.row]);
      expect(projection.segment.protocol).toBe("koni.run-action-archive-segment.v2");
      const authority = projection.segment.terminalAuthorities?.[0];
      if (authority === undefined)
        throw new Error("completed segment fixture lacks terminal authority");
      attack(authority);
      rehashTerminalArchiveAuthority(authority);
      const next = transition.next;
      next.actionExecutionArchive = [];
      next.actionExecutionArchiveSegments = [projection.segment];
      const actionArtifact = path.join(fixture.stateRoot, transition.row.artifactPath);
      const segmentArtifact = path.join(fixture.stateRoot, projection.segment.artifactPath);
      await mkdir(path.dirname(actionArtifact), { recursive: true });
      await mkdir(path.dirname(segmentArtifact), { recursive: true });
      await writeFile(actionArtifact, transition.bytes);
      await writeFile(segmentArtifact, projection.bytes);
      await overwriteRunAndTrust(fixture, next);

      if (_label === "boundary") {
        await expect(fixture.store.getRun(fixture.run.id)).resolves.toMatchObject({
          actionExecutionArchiveSegments: [expect.objectContaining({ count: 1 })],
        });
      } else {
        await expect(fixture.store.getRun(fixture.run.id)).rejects.toThrow(
          /archive|terminal|projection|validation action/u,
        );
      }
    },
  );

  it("admits an exact resolver retry after its failed action moved to an authenticated v2 row", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "koni-archived-resolver-retry-"));
    roots.push(root);
    const stateRoot = path.join(root, "state");
    const store = await ProjectAuthorityStore.open({
      stateRoot,
      projectRoot: root,
      commonDirectory: path.join(root, ".git"),
    });
    const fixture = await controlFixture("terminal_resolver", root);
    const resolver = fixture.run.tickets[fixture.controlTicketId]!;
    const failureProof = await addControlFailureAttempt(
      fixture.run,
      resolver,
      0,
      "attempt-resolver-failure",
    );
    resolver.status = "blocked";
    resolver.blocker = "Configured resolver validation failed";
    const failedAction = fixture.run.actionExecutions![failureProof.actionInvocationId]!;
    await store.commit({
      expectedRevision: 0,
      runWrites: [{ record: fixture.run, expectedRevision: null }],
    });

    const archived = archiveTransition(fixture.run, failedAction);
    expect(archived.row.protocol).toBe("koni.run-action-archive.v2");
    expect(archived.row.terminalFailureProof?.sha256).toBe(failureProof.sha256);
    await store.commit({
      expectedRevision: 1,
      runWrites: [{ record: archived.next, expectedRevision: 0 }],
      writes: [archived.write],
    });

    const reopened = await ProjectAuthorityStore.open({
      stateRoot,
      projectRoot: root,
      commonDirectory: path.join(root, ".git"),
    });
    const prior = await reopened.getRun(fixture.run.id);
    expect(prior.actionExecutions?.[failureProof.actionInvocationId]).toBeUndefined();
    expect(prior.actionExecutionArchive).toEqual([
      expect.objectContaining({
        protocol: "koni.run-action-archive.v2",
        invocationId: failureProof.actionInvocationId,
        terminalFailureProof: expect.objectContaining({ sha256: failureProof.sha256 }),
      }),
    ]);
    expect(prior.terminalFailureProofs?.[failureProof.sha256]).toEqual(failureProof);

    const priorResolver = prior.tickets[fixture.controlTicketId]!;
    const recovery = priorResolver.executionControl!.terminalRecovery!;
    const source = prior.tickets[recovery.sourceTicketId]!;
    const sourceFailure = terminalFailureBindingFromProof(
      prior,
      source,
      recovery.sourceFailureProof,
    );
    const resolverFailure = terminalFailureBindingFromProof(prior, priorResolver, failureProof);
    if (
      sourceFailure === undefined ||
      resolverFailure === undefined ||
      priorResolver.executionPolicyBinding === undefined
    ) {
      throw new Error("archived retry fixture lost exact terminal failure binding");
    }
    const retry = deriveTerminalResolverRetryRequest(fixture.catalog, {
      runId: prior.id,
      resolverTicketId: priorResolver.id,
      resolverBinding: priorResolver.executionPolicyBinding,
      sourceTicketId: source.id,
      sourceFailureBindingSha256: sourceFailure.sha256,
      resolverFailure: {
        sha256: resolverFailure.sha256,
        attemptId: resolverFailure.attemptId,
        launchSpecHash: resolverFailure.launchSpecHash,
        terminalPolicySha256: resolverFailure.terminalPolicySha256,
        terminalOutputSha256: resolverFailure.terminalOutputSha256,
        failureSettlementSha256: resolverFailure.failureSettlementSha256,
        failureProof: resolverFailure.failureProof,
      },
      priorRetries: [],
      event: {
        eventId: "retry-after-v2-archive",
        actor: "operator",
        message: "Retry from the exact archived failed settlement",
        recordedAt: "2026-07-18T05:10:00.000Z",
      },
    });
    const withRetry = structuredClone(prior);
    withRetry.revision += 1;
    withRetry.updatedAt = retry.recordedAt;
    withRetry.tickets[priorResolver.id]!.executionControl!.terminalResolverRetryRequests = [retry];

    await reopened.commit({
      expectedRevision: 2,
      runWrites: [{ record: withRetry, expectedRevision: 1 }],
    });
    const afterRetry = await reopened.getRun(withRetry.id);
    expect(
      afterRetry.tickets[priorResolver.id]!.executionControl!.terminalResolverRetryRequests,
    ).toEqual([retry]);

    const unrelated = structuredClone(afterRetry);
    unrelated.revision += 1;
    unrelated.updatedAt = "2026-07-18T05:11:00.000Z";
    await reopened.commit({
      expectedRevision: 3,
      runWrites: [{ record: unrelated, expectedRevision: 2 }],
    });
    await expect(reopened.getRun(unrelated.id)).resolves.toMatchObject({
      tickets: {
        [priorResolver.id]: {
          executionControl: {
            terminalResolverRetryRequests: [{ sha256: retry.sha256 }],
          },
        },
      },
    });
  });

  it("migrates a genuine v1 failure row projection but keeps it read-only for new retries", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "koni-v1-row-resolver-retry-"));
    roots.push(root);
    const stateRoot = path.join(root, "state");
    const store = await ProjectAuthorityStore.open({
      stateRoot,
      projectRoot: root,
      commonDirectory: path.join(root, ".git"),
    });
    const fixture = await controlFixture("terminal_resolver", root);
    const resolver = fixture.run.tickets[fixture.controlTicketId]!;
    const failureProof = await addControlFailureAttempt(
      fixture.run,
      resolver,
      0,
      "attempt-resolver-v1-row-failure",
    );
    resolver.status = "blocked";
    resolver.blocker = "Configured resolver validation failed";
    const failedAction = fixture.run.actionExecutions![failureProof.actionInvocationId]!;
    await store.commit({
      expectedRevision: 0,
      runWrites: [{ record: fixture.run, expectedRevision: null }],
    });

    const legacy = archiveTransition(fixture.run, failedAction);
    legacy.row.protocol = "koni.run-action-archive.v1";
    legacy.row.archivedAt = "2026-07-17T23:59:00.000Z";
    delete legacy.row.terminalAuthority;
    expect(legacy.next.actionExecutionArchive![0]!.terminalAuthority).toBeUndefined();
    const artifact = path.join(stateRoot, legacy.row.artifactPath);
    await mkdir(path.dirname(artifact), { recursive: true });
    await writeFile(artifact, legacy.bytes);
    const immutableArtifactBytes = await readFile(artifact);
    const stateBeforeMigration = await store.state();
    await overwritePreAnchorRun(
      {
        root,
        stateRoot,
        store,
        run: fixture.run,
        proposalIds: [],
      },
      legacy.next,
    );

    const reopened = await ProjectAuthorityStore.open({
      stateRoot,
      projectRoot: root,
      commonDirectory: path.join(root, ".git"),
    });
    const prior = await reopened.getRun(fixture.run.id);
    const stateAfterMigration = await reopened.state();
    expect(stateAfterMigration.revision).toBe(stateBeforeMigration.revision + 2);
    expect(prior.revision).toBe(legacy.next.revision);
    expect(await readFile(artifact)).toEqual(immutableArtifactBytes);
    expect(prior.actionExecutionArchive).toEqual([
      expect.objectContaining({
        protocol: "koni.run-action-archive.v1",
        invocationId: failureProof.actionInvocationId,
        terminalAuthority: expect.objectContaining({
          invocationId: failureProof.actionInvocationId,
          terminalProofSha256: failureProof.sha256,
        }),
      }),
    ]);
    const persisted = JSON.parse(
      await readFile(path.join(stateRoot, "runs", fixture.run.id, "run.json"), "utf8"),
    ) as RunRecord;
    expect(persisted.actionExecutionArchive?.[0]?.terminalAuthority).toEqual(
      prior.actionExecutionArchive?.[0]?.terminalAuthority,
    );
    const reopenedAgain = await ProjectAuthorityStore.open({
      stateRoot,
      projectRoot: root,
      commonDirectory: path.join(root, ".git"),
    });
    expect((await reopenedAgain.state()).revision).toBe(stateAfterMigration.revision);
    expect(await readFile(artifact)).toEqual(immutableArtifactBytes);
    await expect(reopenedAgain.getRun(fixture.run.id)).resolves.toMatchObject({
      revision: legacy.next.revision,
      actionExecutionArchive: [
        expect.objectContaining({
          terminalAuthority: expect.objectContaining({
            invocationId: failureProof.actionInvocationId,
          }),
        }),
      ],
    });
    const retry = exactResolverRetry(
      prior,
      fixture.catalog,
      fixture.controlTicketId,
      failureProof,
      "retry-from-read-only-v1-row",
      "2026-07-18T05:12:00.000Z",
    );
    const attacked = structuredClone(prior);
    attacked.revision += 1;
    attacked.updatedAt = retry.recordedAt;
    attacked.tickets[fixture.controlTicketId]!.executionControl!.terminalResolverRetryRequests = [
      retry,
    ];
    const migratedState = await reopened.state();
    await expect(
      reopened.commit({
        expectedRevision: migratedState.revision,
        runWrites: [{ record: attacked, expectedRevision: prior.revision }],
      }),
    ).rejects.toThrow(/prior failed settlement|resolver retry|current mutation authority/u);
  });

  it("admits an exact resolver retry after its failed action moved into an authenticated v2 segment", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "koni-segmented-resolver-retry-"));
    roots.push(root);
    const stateRoot = path.join(root, "state");
    const store = await ProjectAuthorityStore.open({
      stateRoot,
      projectRoot: root,
      commonDirectory: path.join(root, ".git"),
    });
    const fixture = await controlFixture("terminal_resolver", root);
    const resolver = fixture.run.tickets[fixture.controlTicketId]!;
    const failureProof = await addControlFailureAttempt(
      fixture.run,
      resolver,
      0,
      "attempt-resolver-segment-failure",
    );
    resolver.status = "blocked";
    resolver.blocker = "Configured resolver validation failed";
    fixture.run.graphHash = digest("segmented-resolver-graph");
    const extra = await settledApprovedActions(fixture.run, 1_023, Date.UTC(2026, 6, 18, 6, 0, 0));
    fixture.run.actionExecutions ??= {};
    for (const action of extra) fixture.run.actionExecutions[action.invocationId] = action;
    expect(Object.keys(fixture.run.actionExecutions)).toHaveLength(1_025);
    await store.commit({
      expectedRevision: 0,
      runWrites: [{ record: fixture.run, expectedRevision: null }],
    });

    const ordered = Object.values(fixture.run.actionExecutions).sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.invocationId.localeCompare(right.invocationId),
    );
    const projections = ordered.map((action) =>
      deriveRunActionExecutionArchive(fixture.run, action),
    );
    const compactedCount = projections.length - 256;
    const segmentProjection = deriveRunActionExecutionArchiveSegment(
      fixture.run.id,
      projections.slice(0, compactedCount).map(({ row }) => row),
    );
    expect(
      projections
        .slice(0, compactedCount)
        .some(({ row }) => row.invocationId === failureProof.actionInvocationId),
    ).toBe(true);
    const archived = structuredClone(fixture.run);
    archived.revision = 1;
    archived.actionExecutions = {};
    archived.actionExecutionArchive = projections.map(({ row }) => row);
    await store.commit({
      expectedRevision: 1,
      runWrites: [{ record: archived, expectedRevision: 0 }],
      writes: projections.map(({ row, bytes }) => ({
        path: row.artifactPath,
        bytes,
        expectedSha256: null,
      })),
    });
    const compacted = structuredClone(archived);
    compacted.revision = 2;
    compacted.actionExecutionArchive = projections.slice(compactedCount).map(({ row }) => row);
    compacted.actionExecutionArchiveSegments = [segmentProjection.segment];
    await store.commit({
      expectedRevision: 2,
      runWrites: [{ record: compacted, expectedRevision: 1 }],
      writes: [
        {
          path: segmentProjection.segment.artifactPath,
          bytes: segmentProjection.bytes,
          expectedSha256: null,
        },
      ],
    });

    const reopened = await ProjectAuthorityStore.open({
      stateRoot,
      projectRoot: root,
      commonDirectory: path.join(root, ".git"),
    });
    const prior = await reopened.getRun(fixture.run.id);
    expect(prior.actionExecutions?.[failureProof.actionInvocationId]).toBeUndefined();
    expect(
      prior.actionExecutionArchive?.some(
        (row) => row.invocationId === failureProof.actionInvocationId,
      ),
    ).toBe(false);
    expect(prior.actionExecutionArchiveSegments).toEqual([
      expect.objectContaining({ protocol: "koni.run-action-archive-segment.v2", count: 769 }),
    ]);
    expect(prior.terminalFailureProofs?.[failureProof.sha256]).toEqual(failureProof);

    const legacyRows = projections.slice(0, compactedCount).map(({ row }) => {
      const legacyRow = structuredClone(row);
      legacyRow.protocol = "koni.run-action-archive.v1";
      legacyRow.archivedAt = "2026-07-17T23:59:00.000Z";
      delete legacyRow.terminalAuthority;
      return legacyRow;
    });
    const legacyProjection = deriveRunActionExecutionArchiveSegment(fixture.run.id, legacyRows);
    legacyProjection.segment.protocol = "koni.run-action-archive-segment.v1";
    legacyProjection.segment.archivedAt = "2026-07-17T23:59:00.000Z";
    delete legacyProjection.segment.terminalAuthorities;
    // This is a synthetic predecessor image, not a store transition: replace the previously
    // installed v2 index artifact so the on-disk inventory exactly matches the historical v1
    // descriptor that would have existed before guarded migration.
    await rm(path.join(stateRoot, segmentProjection.segment.artifactPath), { force: true });
    const legacySegmentArtifact = path.join(stateRoot, legacyProjection.segment.artifactPath);
    await mkdir(path.dirname(legacySegmentArtifact), { recursive: true });
    await writeFile(legacySegmentArtifact, legacyProjection.bytes);
    const immutableLegacySegmentBytes = await readFile(legacySegmentArtifact);
    const legacyPrior = structuredClone(prior);
    legacyPrior.actionExecutionArchiveSegments = [legacyProjection.segment];
    const stateBeforeLegacyMigration = await reopened.state();
    await overwritePreAnchorRun(
      {
        root,
        stateRoot,
        store,
        run: fixture.run,
        proposalIds: [],
      },
      legacyPrior,
    );
    const legacyStore = await ProjectAuthorityStore.open({
      stateRoot,
      projectRoot: root,
      commonDirectory: path.join(root, ".git"),
    });
    const legacyLoaded = await legacyStore.getRun(fixture.run.id);
    const stateAfterLegacyMigration = await legacyStore.state();
    expect(stateAfterLegacyMigration.revision).toBe(stateBeforeLegacyMigration.revision + 2);
    expect(legacyLoaded.revision).toBe(legacyPrior.revision);
    expect(await readFile(legacySegmentArtifact)).toEqual(immutableLegacySegmentBytes);
    expect(legacyLoaded.actionExecutionArchiveSegments).toEqual([
      expect.objectContaining({
        protocol: "koni.run-action-archive-segment.v1",
        count: 769,
        terminalAuthorities: expect.arrayContaining([
          expect.objectContaining({
            invocationId: failureProof.actionInvocationId,
            terminalProofSha256: failureProof.sha256,
          }),
        ]),
      }),
    ]);
    const persistedLegacy = JSON.parse(
      await readFile(path.join(stateRoot, "runs", fixture.run.id, "run.json"), "utf8"),
    ) as RunRecord;
    expect(persistedLegacy.actionExecutionArchiveSegments?.[0]?.terminalAuthorities).toEqual(
      legacyLoaded.actionExecutionArchiveSegments?.[0]?.terminalAuthorities,
    );
    const legacyReopenedAgain = await ProjectAuthorityStore.open({
      stateRoot,
      projectRoot: root,
      commonDirectory: path.join(root, ".git"),
    });
    expect((await legacyReopenedAgain.state()).revision).toBe(stateAfterLegacyMigration.revision);
    expect(await readFile(legacySegmentArtifact)).toEqual(immutableLegacySegmentBytes);
    await expect(legacyReopenedAgain.getRun(fixture.run.id)).resolves.toMatchObject({
      revision: legacyPrior.revision,
      actionExecutionArchiveSegments: [
        expect.objectContaining({
          terminalAuthorities: expect.arrayContaining([
            expect.objectContaining({ invocationId: failureProof.actionInvocationId }),
          ]),
        }),
      ],
    });
    const legacyRetry = exactResolverRetry(
      legacyLoaded,
      fixture.catalog,
      fixture.controlTicketId,
      failureProof,
      "retry-from-read-only-v1-segment",
      "2026-07-18T06:59:00.000Z",
    );
    const legacyAttacked = structuredClone(legacyLoaded);
    legacyAttacked.revision += 1;
    legacyAttacked.updatedAt = legacyRetry.recordedAt;
    legacyAttacked.tickets[
      fixture.controlTicketId
    ]!.executionControl!.terminalResolverRetryRequests = [legacyRetry];
    const migratedLegacyState = await legacyStore.state();
    await expect(
      legacyStore.commit({
        expectedRevision: migratedLegacyState.revision,
        runWrites: [{ record: legacyAttacked, expectedRevision: legacyLoaded.revision }],
      }),
    ).rejects.toThrow(/prior failed settlement|resolver retry|current mutation authority/u);

    // Restore the exact v2 predecessor image for the independent retry-positive half below.
    await rm(legacySegmentArtifact, { force: true });
    const restoredSegmentArtifact = path.join(stateRoot, segmentProjection.segment.artifactPath);
    await mkdir(path.dirname(restoredSegmentArtifact), { recursive: true });
    await writeFile(restoredSegmentArtifact, segmentProjection.bytes);
    await overwriteRunAndTrust(
      {
        root,
        stateRoot,
        store,
        run: fixture.run,
        proposalIds: [],
      },
      prior,
    );
    const restored = await ProjectAuthorityStore.open({
      stateRoot,
      projectRoot: root,
      commonDirectory: path.join(root, ".git"),
    });

    const priorResolver = prior.tickets[fixture.controlTicketId]!;
    const recovery = priorResolver.executionControl!.terminalRecovery!;
    const source = prior.tickets[recovery.sourceTicketId]!;
    const sourceFailure = terminalFailureBindingFromProof(
      prior,
      source,
      recovery.sourceFailureProof,
    );
    const resolverFailure = terminalFailureBindingFromProof(prior, priorResolver, failureProof);
    if (
      sourceFailure === undefined ||
      resolverFailure === undefined ||
      priorResolver.executionPolicyBinding === undefined
    ) {
      throw new Error("segmented retry fixture lost exact terminal failure binding");
    }
    const retry = deriveTerminalResolverRetryRequest(fixture.catalog, {
      runId: prior.id,
      resolverTicketId: priorResolver.id,
      resolverBinding: priorResolver.executionPolicyBinding,
      sourceTicketId: source.id,
      sourceFailureBindingSha256: sourceFailure.sha256,
      resolverFailure: {
        sha256: resolverFailure.sha256,
        attemptId: resolverFailure.attemptId,
        launchSpecHash: resolverFailure.launchSpecHash,
        terminalPolicySha256: resolverFailure.terminalPolicySha256,
        terminalOutputSha256: resolverFailure.terminalOutputSha256,
        failureSettlementSha256: resolverFailure.failureSettlementSha256,
        failureProof: resolverFailure.failureProof,
      },
      priorRetries: [],
      event: {
        eventId: "retry-after-v2-segment",
        actor: "operator",
        message: "Retry from the exact segmented failed settlement",
        recordedAt: "2026-07-18T07:00:00.000Z",
      },
    });
    const withRetry = structuredClone(prior);
    withRetry.revision += 1;
    withRetry.updatedAt = retry.recordedAt;
    withRetry.tickets[priorResolver.id]!.executionControl!.terminalResolverRetryRequests = [retry];
    const restoredState = await restored.state();
    const selectedSegmentArtifact = path.join(stateRoot, segmentProjection.segment.artifactPath);
    const selectedSegmentBytes = await readFile(selectedSegmentArtifact);
    await writeFile(selectedSegmentArtifact, "{}\n");
    await expect(restored.getRun(prior.id)).resolves.toMatchObject({ revision: prior.revision });
    await expect(
      restored.commit({
        expectedRevision: restoredState.revision,
        runWrites: [{ record: withRetry, expectedRevision: prior.revision }],
      }),
    ).rejects.toThrow(/archive segment|digest|canonical|artifact/u);
    expect((await restored.state()).revision).toBe(restoredState.revision);
    await rm(selectedSegmentArtifact);
    await expect(
      restored.commit({
        expectedRevision: restoredState.revision,
        runWrites: [{ record: withRetry, expectedRevision: prior.revision }],
      }),
    ).rejects.toThrow(/ENOENT|no such file|archive segment|artifact/iu);
    expect((await restored.state()).revision).toBe(restoredState.revision);
    await writeFile(selectedSegmentArtifact, selectedSegmentBytes);

    const selectedProjection = projections.find(
      ({ row }) => row.invocationId === failureProof.actionInvocationId,
    );
    if (selectedProjection === undefined)
      throw new Error("selected segmented action fixture is missing");
    const selectedArtifact = path.join(stateRoot, selectedProjection.row.artifactPath);
    const selectedArtifactBytes = await readFile(selectedArtifact);
    await writeFile(selectedArtifact, "{}\n");
    await expect(restored.getRun(prior.id)).resolves.toMatchObject({ revision: prior.revision });
    await expect(
      restored.commit({
        expectedRevision: restoredState.revision,
        runWrites: [{ record: withRetry, expectedRevision: prior.revision }],
      }),
    ).rejects.toThrow(/archive artifact|digest|canonical action/u);
    expect((await restored.state()).revision).toBe(restoredState.revision);
    await writeFile(selectedArtifact, selectedArtifactBytes);
    const unselectedProjection = projections
      .slice(0, compactedCount)
      .find(({ row }) => row.invocationId !== failureProof.actionInvocationId);
    if (unselectedProjection === undefined) {
      throw new Error("selected segmented action fixture lacks an unselected sibling");
    }
    const unselectedArtifact = path.join(stateRoot, unselectedProjection.row.artifactPath);
    const unselectedArtifactBytes = await readFile(unselectedArtifact);
    await writeFile(unselectedArtifact, "{}\n");
    await restored.commit({
      expectedRevision: restoredState.revision,
      runWrites: [{ record: withRetry, expectedRevision: prior.revision }],
    });
    await writeFile(unselectedArtifact, unselectedArtifactBytes);

    const afterRetry = await restored.getRun(withRetry.id);
    const unrelated = structuredClone(afterRetry);
    unrelated.revision += 1;
    unrelated.updatedAt = "2026-07-18T07:01:00.000Z";
    const afterRetryState = await restored.state();
    await restored.commit({
      expectedRevision: afterRetryState.revision,
      runWrites: [{ record: unrelated, expectedRevision: afterRetry.revision }],
    });
    await expect(restored.getRun(unrelated.id)).resolves.toMatchObject({
      actionExecutionArchiveSegments: [expect.objectContaining({ count: 769 })],
      tickets: {
        [priorResolver.id]: {
          executionControl: {
            terminalResolverRetryRequests: [{ sha256: retry.sha256 }],
          },
        },
      },
    });
  }, 60_000);

  it("retains exact failure authority through >1024 compaction, restart, and an unrelated CAS", async () => {
    const fixture = await assignmentActionFixture("failed");
    const seeded = structuredClone(fixture.run);
    seeded.revision = 1;
    const additional = await settledApprovedActions(seeded, 1_024);
    seeded.actionExecutions ??= {};
    for (const action of additional) seeded.actionExecutions[action.invocationId] = action;
    await fixture.store.commit({
      expectedRevision: 1,
      runWrites: [{ record: seeded, expectedRevision: 0 }],
    });

    const ordered = Object.values(seeded.actionExecutions).sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.invocationId.localeCompare(right.invocationId),
    );
    const firstBatch = ordered.slice(0, 1_024);
    const archived = structuredClone(seeded);
    archived.revision = 2;
    archived.actionExecutionArchive = [];
    const firstWrites: Array<{ path: string; bytes: Buffer; expectedSha256: null }> = [];
    for (const action of firstBatch) {
      const projection = deriveRunActionExecutionArchive(seeded, action);
      archived.actionExecutionArchive.push(projection.row);
      delete archived.actionExecutions![action.invocationId];
      firstWrites.push({
        path: projection.row.artifactPath,
        bytes: projection.bytes,
        expectedSha256: null,
      });
    }
    await fixture.store.commit({
      expectedRevision: 2,
      runWrites: [{ record: archived, expectedRevision: 1 }],
      writes: firstWrites,
    });

    const remaining = Object.values(archived.actionExecutions!);
    expect(remaining).toHaveLength(1);
    const finalProjection = deriveRunActionExecutionArchive(archived, remaining[0]!);
    const combined = [...archived.actionExecutionArchive, finalProjection.row];
    const compactedPrefix = combined.slice(0, combined.length - 256);
    const segmentProjection = deriveRunActionExecutionArchiveSegment(archived.id, compactedPrefix);
    const compacted = structuredClone(archived);
    compacted.revision = 3;
    compacted.actionExecutionArchive = combined.slice(compactedPrefix.length);
    compacted.actionExecutionArchiveSegments = [segmentProjection.segment];
    delete compacted.actionExecutions![remaining[0]!.invocationId];
    await fixture.store.commit({
      expectedRevision: 3,
      runWrites: [{ record: compacted, expectedRevision: 2 }],
      writes: [
        {
          path: finalProjection.row.artifactPath,
          bytes: finalProjection.bytes,
          expectedSha256: null,
        },
        {
          path: segmentProjection.segment.artifactPath,
          bytes: segmentProjection.bytes,
          expectedSha256: null,
        },
      ],
    });

    const reopened = await ProjectAuthorityStore.open({
      stateRoot: fixture.stateRoot,
      projectRoot: fixture.root,
      commonDirectory: path.join(fixture.root, ".git"),
    });
    const afterRestart = await reopened.getRun(compacted.id);
    expect(afterRestart.actionExecutionArchive).toHaveLength(256);
    expect(afterRestart.actionExecutionArchiveSegments).toEqual([
      expect.objectContaining({ count: 769 }),
    ]);
    expect(Object.values(afterRestart.terminalFailureProofs ?? {})).toHaveLength(1);

    const unrelated = structuredClone(afterRestart);
    unrelated.revision += 1;
    unrelated.updatedAt = "2026-07-18T02:00:00.000Z";
    await reopened.commit({
      expectedRevision: 4,
      runWrites: [{ record: unrelated, expectedRevision: 3 }],
    });
    await expect(reopened.getRun(unrelated.id)).resolves.toMatchObject({
      terminalFailureProofs: afterRestart.terminalFailureProofs,
      actionExecutionArchiveSegments: [expect.objectContaining({ count: 769 })],
    });
  }, 60_000);

  it("retains exact success authority through >1024 compaction, restart, and an unrelated CAS", async () => {
    const pressure = await terminalArchivePressureFixture("completed");
    const proof = Object.values(pressure.afterRestart.terminalSuccessProofs ?? {})[0];
    expect(proof).toBeDefined();
    expect(pressure.afterRestart.actionExecutionArchive).toHaveLength(256);
    expect(pressure.afterRestart.actionExecutionArchiveSegments).toEqual([
      expect.objectContaining({
        protocol: "koni.run-action-archive-segment.v2",
        count: 769,
        terminalAuthorities: [
          expect.objectContaining({
            settlementDisposition: "completed",
            terminalProofSha256: proof!.sha256,
          }),
        ],
      }),
    ]);
    expect(pressure.afterUnrelated.terminalSuccessProofs).toEqual(
      pressure.afterRestart.terminalSuccessProofs,
    );
    expect(pressure.afterUnrelated.actionExecutionArchiveSegments).toEqual(
      pressure.afterRestart.actionExecutionArchiveSegments,
    );
  }, 60_000);

  it.each(["row", "segment"] as const)(
    "normalizes an audited-empty v1 %s exactly once across reopen",
    async (kind) => {
      const fixture = await actionFixture();
      const transition = archiveTransition(fixture.run, fixture.action);
      const legacyRow = transition.row;
      legacyRow.protocol = "koni.run-action-archive.v1";
      legacyRow.archivedAt = "2026-07-17T23:59:00.000Z";
      delete legacyRow.terminalAuthority;
      const actionArtifact = path.join(fixture.stateRoot, legacyRow.artifactPath);
      await mkdir(path.dirname(actionArtifact), { recursive: true });
      await writeFile(actionArtifact, transition.bytes);
      const immutableArtifacts: Array<{ path: string; sha256: Sha256Digest }> = [
        {
          path: actionArtifact,
          sha256: rawSha256(await readFile(actionArtifact)),
        },
      ];

      if (kind === "segment") {
        const projection = deriveRunActionExecutionArchiveSegment(fixture.run.id, [legacyRow]);
        projection.segment.protocol = "koni.run-action-archive-segment.v1";
        projection.segment.archivedAt = "2026-07-17T23:59:00.000Z";
        delete projection.segment.terminalAuthorities;
        transition.next.actionExecutionArchive = [];
        transition.next.actionExecutionArchiveSegments = [projection.segment];
        const segmentArtifact = path.join(fixture.stateRoot, projection.segment.artifactPath);
        await mkdir(path.dirname(segmentArtifact), { recursive: true });
        await writeFile(segmentArtifact, projection.bytes);
        immutableArtifacts.push({
          path: segmentArtifact,
          sha256: rawSha256(await readFile(segmentArtifact)),
        });
      }

      const stateBefore = await fixture.store.state();
      await overwritePreAnchorRun(fixture, transition.next);
      const reopened = await ProjectAuthorityStore.open({
        stateRoot: fixture.stateRoot,
        projectRoot: fixture.root,
        commonDirectory: path.join(fixture.root, ".git"),
      });
      const migrated = await reopened.getRun(fixture.run.id);
      const migratedState = await reopened.state();
      expect(migratedState.revision).toBe(stateBefore.revision + 2);
      if (kind === "row") {
        expect(migrated.actionExecutionArchive).toEqual([
          expect.objectContaining({
            protocol: "koni.run-action-archive.v2",
            invocationId: fixture.action.invocationId,
          }),
        ]);
      } else {
        expect(migrated.actionExecutionArchiveSegments).toEqual([
          expect.objectContaining({
            protocol: "koni.run-action-archive-segment.v1",
            terminalAuthorities: [],
          }),
        ]);
      }
      for (const artifact of immutableArtifacts) {
        expect(rawSha256(await readFile(artifact.path))).toBe(artifact.sha256);
      }

      const reopenedAgain = await ProjectAuthorityStore.open({
        stateRoot: fixture.stateRoot,
        projectRoot: fixture.root,
        commonDirectory: path.join(fixture.root, ".git"),
      });
      expect((await reopenedAgain.state()).revision).toBe(migratedState.revision);
      expect(await reopenedAgain.getRun(fixture.run.id)).toEqual(migrated);
    },
    30_000,
  );

  it("streams 513 one-row segments once, then keeps unrelated anchored mutations lazy", async () => {
    const fixture = await actionFixture();
    const archivedActions = await settledApprovedActions(
      fixture.run,
      513,
      Date.UTC(2026, 6, 18, 8, 0, 0),
    );
    const projections = archivedActions.map((action) =>
      deriveRunActionExecutionArchive(fixture.run, action),
    );
    const segments = projections.map(({ row }) =>
      deriveRunActionExecutionArchiveSegment(fixture.run.id, [row]),
    );
    const artifacts = projections.flatMap(({ row, bytes }, index) => [
      { path: row.artifactPath, bytes },
      { path: segments[index]!.segment.artifactPath, bytes: segments[index]!.bytes },
    ]);
    for (let start = 0; start < artifacts.length; start += 32) {
      await Promise.all(
        artifacts.slice(start, start + 32).map(async (artifact) => {
          const file = path.join(fixture.stateRoot, artifact.path);
          await mkdir(path.dirname(file), { recursive: true });
          await writeFile(file, artifact.bytes);
        }),
      );
    }

    const predecessor = structuredClone(fixture.run);
    predecessor.actionExecutionArchive = [];
    predecessor.actionExecutionArchiveSegments = segments.map(({ segment }) => segment);
    const stateBefore = await fixture.store.state();
    await overwritePreAnchorRun(fixture, predecessor);
    const reopened = await ProjectAuthorityStore.open({
      stateRoot: fixture.stateRoot,
      projectRoot: fixture.root,
      commonDirectory: path.join(fixture.root, ".git"),
    });
    const anchored = await reopened.getRun(fixture.run.id);
    const anchoredState = await reopened.state();
    expect(anchoredState.revision).toBe(stateBefore.revision + 1);
    expect(anchored.actionExecutionArchiveSegments).toHaveLength(513);
    expect(anchored.actionExecutionArchiveSegments).toEqual(
      expect.arrayContaining([expect.objectContaining({ count: 1 })]),
    );

    const reopenedAgain = await ProjectAuthorityStore.open({
      stateRoot: fixture.stateRoot,
      projectRoot: fixture.root,
      commonDirectory: path.join(fixture.root, ".git"),
    });
    expect((await reopenedAgain.state()).revision).toBe(anchoredState.revision);
    const unrelatedColdSegment = path.join(fixture.stateRoot, segments[0]!.segment.artifactPath);
    await writeFile(unrelatedColdSegment, "{}\n");
    await expect(reopenedAgain.getRun(fixture.run.id)).resolves.toMatchObject({
      actionExecutionArchiveSegments: expect.arrayContaining([
        expect.objectContaining({ count: 1 }),
      ]),
    });
    await expect(reopenedAgain.listRuns()).resolves.toEqual([
      expect.objectContaining({
        id: fixture.run.id,
        actionExecutionArchiveSegments: expect.arrayContaining([
          expect.objectContaining({ count: 1 }),
        ]),
      }),
    ]);

    const unrelated = structuredClone(anchored);
    unrelated.revision += 1;
    unrelated.updatedAt = "2026-07-18T08:10:00.000Z";
    unrelated.objective = "Unrelated anchored mutation ignores unselected cold history";
    await reopenedAgain.commit({
      expectedRevision: anchoredState.revision,
      runWrites: [{ record: unrelated, expectedRevision: anchored.revision }],
    });
    const afterUnrelatedState = await reopenedAgain.state();
    const liveAction = unrelated.actionExecutions?.[fixture.action.invocationId];
    if (liveAction === undefined)
      throw new Error("513-segment fixture lost its live append action");
    const append = archiveTransition(unrelated, liveAction);
    await reopenedAgain.commit({
      expectedRevision: afterUnrelatedState.revision,
      runWrites: [{ record: append.next, expectedRevision: unrelated.revision }],
      writes: [append.write],
    });
    await expect(reopenedAgain.getRun(fixture.run.id)).resolves.toMatchObject({
      revision: append.next.revision,
      actionExecutionArchive: [
        expect.objectContaining({
          invocationId: fixture.action.invocationId,
        }),
      ],
      actionExecutionArchiveSegments: expect.arrayContaining([
        expect.objectContaining({ count: 1 }),
      ]),
    });
  }, 90_000);

  it("leaves run, state, and action bytes unchanged when v1 projection exceeds run capacity", async () => {
    const fixture = await assignmentActionFixture("failed");
    const transition = archiveTransition(fixture.run, fixture.action);
    transition.row.protocol = "koni.run-action-archive.v1";
    transition.row.archivedAt = "2026-07-17T23:59:00.000Z";
    delete transition.row.terminalAuthority;
    const artifact = path.join(fixture.stateRoot, transition.row.artifactPath);
    await mkdir(path.dirname(artifact), { recursive: true });
    await writeFile(artifact, transition.bytes);

    transition.next.objective = "";
    const baseBytes = encodeTestJson(transition.next).byteLength;
    const targetBytes = MAX_RUN_BYTES - 8;
    if (baseBytes >= targetBytes)
      throw new Error("projection-capacity fixture base is unexpectedly large");
    transition.next.objective = "x".repeat(targetBytes - baseBytes);
    expect(encodeTestJson(transition.next).byteLength).toBe(targetBytes);
    await overwritePreAnchorRun(fixture, transition.next);
    const runFile = path.join(fixture.stateRoot, "runs", fixture.run.id, "run.json");
    const stateFile = path.join(fixture.stateRoot, "authority", "state.json");
    const before = {
      run: rawSha256(await readFile(runFile)),
      state: rawSha256(await readFile(stateFile)),
      artifact: rawSha256(await readFile(artifact)),
    };

    await expect(
      ProjectAuthorityStore.open({
        stateRoot: fixture.stateRoot,
        projectRoot: fixture.root,
        commonDirectory: path.join(fixture.root, ".git"),
      }),
    ).rejects.toMatchObject({ code: "legacy_archive_projection_capacity" });
    expect(rawSha256(await readFile(runFile))).toBe(before.run);
    expect(rawSha256(await readFile(stateFile))).toBe(before.state);
    expect(rawSha256(await readFile(artifact))).toBe(before.artifact);
    const unchangedState = JSON.parse(await readFile(stateFile, "utf8")) as Record<string, unknown>;
    expect(unchangedState.runRecordSha256).toBeUndefined();
  }, 90_000);

  it("leaves state, run, and archive bytes unchanged when exact anchors exceed state capacity", async () => {
    const archived = await persistedAssignmentArchiveFixture("failed");
    const { fixture } = archived;
    await overwritePreAnchorRun(fixture, archived.run);
    const stateFile = path.join(fixture.stateRoot, "authority", "state.json");
    const state = JSON.parse(await readFile(stateFile, "utf8")) as {
      receipts: Record<string, unknown>;
      runRecordSha256?: Record<string, Sha256Digest>;
    };
    const receiptId = digest("anchor-capacity-receipt");
    state.receipts[receiptId] = {
      id: receiptId,
      method: "run.pause",
      idempotencyKey: "anchor-capacity",
      requestHash: digest("anchor-capacity-request"),
      revision: 1,
      result: "",
      recordedAt: "2026-07-18T08:20:00.000Z",
    };
    const baseBytes = encodeTestJson(state).byteLength;
    const targetBytes = MAX_STATE_BYTES - 8;
    if (baseBytes >= targetBytes)
      throw new Error("anchor-capacity fixture base is unexpectedly large");
    (state.receipts[receiptId] as { result: string }).result = "x".repeat(targetBytes - baseBytes);
    const stateBytes = encodeTestJson(state);
    expect(stateBytes.byteLength).toBe(targetBytes);
    await writeFile(stateFile, stateBytes);
    const runFile = path.join(fixture.stateRoot, "runs", fixture.run.id, "run.json");
    const archivePath = archived.run.actionExecutionArchive?.[0]?.artifactPath;
    if (archivePath === undefined)
      throw new Error("anchor-capacity fixture lacks archive evidence");
    const artifact = path.join(fixture.stateRoot, archivePath);
    const before = {
      state: rawSha256(await readFile(stateFile)),
      run: rawSha256(await readFile(runFile)),
      artifact: rawSha256(await readFile(artifact)),
    };

    await expect(
      ProjectAuthorityStore.open({
        stateRoot: fixture.stateRoot,
        projectRoot: fixture.root,
        commonDirectory: path.join(fixture.root, ".git"),
      }),
    ).rejects.toMatchObject({ code: "legacy_run_anchor_capacity" });
    expect(rawSha256(await readFile(stateFile))).toBe(before.state);
    expect(rawSha256(await readFile(runFile))).toBe(before.run);
    expect(rawSha256(await readFile(artifact))).toBe(before.artifact);
    const unchangedState = JSON.parse(await readFile(stateFile, "utf8")) as Record<string, unknown>;
    expect(unchangedState.runRecordSha256).toBeUndefined();
  }, 90_000);

  it.each(["row", "segment"] as const)(
    "composes flat-Git and field-absent v1 %s normalization into one final migration",
    async (kind) => {
      const fixture = await assignmentActionFixture("failed");
      await execFileAsync("git", ["init", "-b", "main"], { cwd: fixture.root });
      await execFileAsync("git", ["config", "user.email", "koni@example.invalid"], {
        cwd: fixture.root,
      });
      await execFileAsync("git", ["config", "user.name", "Koni Test"], { cwd: fixture.root });
      await writeFile(path.join(fixture.root, "README.md"), "base\n");
      await execFileAsync("git", ["add", "README.md"], { cwd: fixture.root });
      await execFileAsync("git", ["commit", "-m", "base"], { cwd: fixture.root });
      const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: fixture.root });
      const baseOid = stdout.trim();
      const projectRoot = await realpath(fixture.root);

      const transition = archiveTransition(fixture.run, fixture.action);
      const legacyRow = structuredClone(transition.row);
      legacyRow.protocol = "koni.run-action-archive.v1";
      legacyRow.archivedAt = "2026-07-17T23:59:00.000Z";
      delete legacyRow.terminalAuthority;
      const actionArtifact = path.join(fixture.stateRoot, legacyRow.artifactPath);
      await mkdir(path.dirname(actionArtifact), { recursive: true });
      await writeFile(actionArtifact, transition.bytes);
      const artifactSnapshots: Array<{ file: string; bytes: Buffer }> = [
        { file: actionArtifact, bytes: await readFile(actionArtifact) },
      ];

      const legacy = structuredClone(transition.next) as unknown as Record<string, unknown>;
      legacy.projectRoot = projectRoot;
      if (kind === "row") {
        legacy.actionExecutionArchive = [legacyRow];
      } else {
        const projection = deriveRunActionExecutionArchiveSegment(fixture.run.id, [legacyRow]);
        projection.segment.protocol = "koni.run-action-archive-segment.v1";
        projection.segment.archivedAt = "2026-07-17T23:59:00.000Z";
        delete projection.segment.terminalAuthorities;
        legacy.actionExecutionArchive = [];
        legacy.actionExecutionArchiveSegments = [projection.segment];
        const segmentArtifact = path.join(fixture.stateRoot, projection.segment.artifactPath);
        await mkdir(path.dirname(segmentArtifact), { recursive: true });
        await writeFile(segmentArtifact, projection.bytes);
        artifactSnapshots.push({ file: segmentArtifact, bytes: await readFile(segmentArtifact) });
      }
      legacy.git = {
        targetRef: "refs/heads/main",
        targetBaseOid: baseOid,
        runBranch: `koni/runs/${fixture.run.id}`,
        runWorktree: path.join(fixture.root, ".git", "koni", "worktrees", "runs", fixture.run.id),
        namespaceStatus: "planned",
      };
      delete legacy.pendingGitIntents;
      delete legacy.gitReceipts;

      const stateBefore = await fixture.store.state();
      await overwritePreAnchorRun(fixture, legacy);
      const stateFile = path.join(fixture.stateRoot, "authority", "state.json");
      const preAnchorState = JSON.parse(await readFile(stateFile, "utf8")) as Record<
        string,
        unknown
      >;
      preAnchorState.projectRoot = projectRoot;
      preAnchorState.commonDirectory = path.join(projectRoot, ".git");
      await writeFile(stateFile, encodeTestJson(preAnchorState));
      const reopened = await ProjectAuthorityStore.open({
        stateRoot: fixture.stateRoot,
        projectRoot,
        commonDirectory: path.join(projectRoot, ".git"),
      });
      const migrated = await reopened.getRun(fixture.run.id);
      const migratedState = await reopened.state();
      expect(migratedState.revision).toBe(stateBefore.revision + 2);
      expect(migrated.revision).toBe((legacy.revision as number) + 1);
      expect(migrated.git).toMatchObject({
        protocol: "koni.git-lifecycle.v1",
        target: { ref: "refs/heads/main", selectedOid: baseOid },
      });
      expect(migrated.legacyGitMigration).toMatchObject({ status: "migrated" });
      if (kind === "row") {
        expect(migrated.actionExecutionArchive).toEqual([
          expect.objectContaining({
            protocol: "koni.run-action-archive.v1",
            terminalAuthority: expect.objectContaining({
              invocationId: fixture.action.invocationId,
            }),
          }),
        ]);
      } else {
        expect(migrated.actionExecutionArchiveSegments).toEqual([
          expect.objectContaining({
            protocol: "koni.run-action-archive-segment.v1",
            terminalAuthorities: [
              expect.objectContaining({
                invocationId: fixture.action.invocationId,
              }),
            ],
          }),
        ]);
      }
      for (const snapshot of artifactSnapshots) {
        expect((await readFile(snapshot.file)).equals(snapshot.bytes)).toBe(true);
      }
      const persistedRun = await readFile(
        path.join(fixture.stateRoot, "runs", fixture.run.id, "run.json"),
      );
      expect(migratedState.runRecordSha256?.[fixture.run.id]).toBe(rawSha256(persistedRun));
      const reopenedAgain = await ProjectAuthorityStore.open({
        stateRoot: fixture.stateRoot,
        projectRoot,
        commonDirectory: path.join(projectRoot, ".git"),
      });
      expect((await reopenedAgain.state()).revision).toBe(migratedState.revision);
      expect((await reopenedAgain.getRun(fixture.run.id)).revision).toBe(migrated.revision);
    },
    30_000,
  );

  it.each(["prepared", "run_published", "state_published"] as const)(
    "recovers an interrupted composed legacy migration from the %s prefix exactly once",
    async (prefix) => {
      const fixture = await assignmentActionFixture("failed");
      const transition = archiveTransition(fixture.run, fixture.action);
      const legacyRow = structuredClone(transition.row);
      legacyRow.protocol = "koni.run-action-archive.v1";
      legacyRow.archivedAt = "2026-07-17T23:59:00.000Z";
      delete legacyRow.terminalAuthority;
      transition.next.actionExecutionArchive = [legacyRow];
      const artifact = path.join(fixture.stateRoot, legacyRow.artifactPath);
      await mkdir(path.dirname(artifact), { recursive: true });
      await writeFile(artifact, transition.bytes);
      const artifactBefore = await readFile(artifact);
      const stateBefore = await fixture.store.state();
      await overwritePreAnchorRun(fixture, transition.next);

      const originalCommit = FileTransactionStore.prototype.commit;
      const commit = vi
        .spyOn(FileTransactionStore.prototype, "commit")
        .mockImplementation(function (this: FileTransactionStore, id: string) {
          if (id.startsWith("legacy-run-migration-")) {
            return Promise.reject(new Error("simulated migration crash"));
          }
          return originalCommit.call(this, id);
        });
      try {
        await expect(
          ProjectAuthorityStore.open({
            stateRoot: fixture.stateRoot,
            projectRoot: fixture.root,
            commonDirectory: path.join(fixture.root, ".git"),
          }),
        ).rejects.toThrow("simulated migration crash");
      } finally {
        commit.mockRestore();
      }

      const transactionRoot = path.join(fixture.stateRoot, ".transactions");
      const transactions = (await readdir(transactionRoot)).filter((id) =>
        id.startsWith("legacy-run-migration-"),
      );
      expect(transactions).toHaveLength(1);
      const transaction = path.join(transactionRoot, transactions[0]!);
      if (prefix !== "prepared") {
        await copyFile(
          path.join(transaction, "stage", "000000"),
          path.join(fixture.stateRoot, "runs", fixture.run.id, "run.json"),
        );
      }
      if (prefix === "state_published") {
        await copyFile(
          path.join(transaction, "stage", "000001"),
          path.join(fixture.stateRoot, "authority", "state.json"),
        );
      }

      const recovered = await ProjectAuthorityStore.open({
        stateRoot: fixture.stateRoot,
        projectRoot: fixture.root,
        commonDirectory: path.join(fixture.root, ".git"),
      });
      const migrated = await recovered.getRun(fixture.run.id);
      const recoveredState = await recovered.state();
      expect(recoveredState.revision).toBe(stateBefore.revision + 2);
      expect(migrated.actionExecutionArchive).toEqual([
        expect.objectContaining({
          protocol: "koni.run-action-archive.v1",
          terminalAuthority: expect.objectContaining({ invocationId: fixture.action.invocationId }),
        }),
      ]);
      expect((await readFile(artifact)).equals(artifactBefore)).toBe(true);
      expect(await readdir(transactionRoot)).toEqual([]);

      const reopenedAgain = await ProjectAuthorityStore.open({
        stateRoot: fixture.stateRoot,
        projectRoot: fixture.root,
        commonDirectory: path.join(fixture.root, ".git"),
      });
      expect((await reopenedAgain.state()).revision).toBe(recoveredState.revision);
      expect((await reopenedAgain.getRun(fixture.run.id)).revision).toBe(migrated.revision);
    },
    30_000,
  );
});

type ProposalDecisionEvent = NonNullable<TicketExecutionControlRecord["proposalDecision"]>;

interface ProposalFixture {
  root: string;
  stateRoot: string;
  store: ProjectAuthorityStore;
  run: RunRecord;
  proposalIds: string[];
}

interface ActionFixture extends ProposalFixture {
  action: RunActionExecutionRecord;
}

interface PersistedRunAuthorityFixture {
  fixture: ProposalFixture;
  run: RunRecord;
  stateRevision: number;
}

interface PersistedAssignmentArchiveFixture extends PersistedRunAuthorityFixture {
  fixture: ActionFixture;
}

interface StoredControlFixture extends ProposalFixture {
  catalog: CompiledExecutionSemanticCatalog;
  controlTicketId: string;
}

interface ControlFixture {
  run: RunRecord;
  catalog: CompiledExecutionSemanticCatalog;
  controlTicketId: string;
}

type ControlAuthorityAttack = Readonly<{
  name: string;
  mutate: (run: RunRecord, ticket: TicketRecord, authority: CompilerControlTicketAuthority) => void;
  reproject?: boolean;
}>;

async function proposalFixture(count: number): Promise<ProposalFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "koni-change-control-store-"));
  roots.push(root);
  const stateRoot = path.join(root, "state");
  const store = await ProjectAuthorityStore.open({
    stateRoot,
    projectRoot: root,
    commonDirectory: path.join(root, ".git"),
  });
  const catalog = buildControlCatalog();
  const run = controlBaseRun(root, catalog);
  const proposalIds: string[] = [];
  for (let index = 1; index <= count; index += 1) {
    proposalIds.push((await controlProposalTicket(run, catalog, index)).id);
  }
  await store.commit({
    expectedRevision: 0,
    runWrites: [{ record: run, expectedRevision: null }],
  });
  return { root, stateRoot, store, run, proposalIds };
}

async function actionFixture(): Promise<ActionFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "koni-action-store-"));
  roots.push(root);
  const stateRoot = path.join(root, "state");
  const store = await ProjectAuthorityStore.open({
    stateRoot,
    projectRoot: root,
    commonDirectory: path.join(root, ".git"),
  });
  const run = baseRun(root);
  run.behavior = runBehaviorSnapshotFixture("small", "store-authority");
  run.pipelineStageIds = run.behavior.runType.pipeline.map((stage) => stage.id);
  run.currentPipelineStageId = "approval";
  run.graphHash = digest("graph");
  const prepared = prepareRunActionExecution(run, {
    kind: "approved_plan_compile",
    stageId: "approval",
    selector: run.behavior.runType.actionSelectors.compile,
    checkout: "none",
    at: "2026-07-18T00:01:00.000Z",
  });
  const journal = await executeActionPlan(prepared.plan, { execute: async () => null });
  const action: RunActionExecutionRecord = {
    ...structuredClone(prepared),
    journal,
    semanticResult: {
      kind: "approved_plan",
      ticketCount: 0,
      graphHash: run.graphHash,
      graphRevision: run.graphRevision,
    },
    updatedAt: "2026-07-18T00:02:00.000Z",
  };
  action.settlement = createRunActionSettlement(
    action,
    "completed",
    "approved plan compiled",
    "2026-07-18T00:02:00.000Z",
  );
  action.settledAt = action.settlement.settledAt;
  run.actionExecutions = { [action.invocationId]: action };
  await store.commit({
    expectedRevision: 0,
    runWrites: [{ record: run, expectedRevision: null }],
  });
  return { root, stateRoot, store, run, proposalIds: [], action };
}

async function assignmentActionFixture(outcome: "completed" | "failed"): Promise<ActionFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "koni-assignment-store-"));
  roots.push(root);
  const stateRoot = path.join(root, "state");
  const store = await ProjectAuthorityStore.open({
    stateRoot,
    projectRoot: root,
    commonDirectory: path.join(root, ".git"),
  });
  const run = baseRun(root);
  run.behavior = runBehaviorSnapshotFixture("small", "store-authority");
  run.pipelineStageIds = run.behavior.runType.pipeline.map((stage) => stage.id);
  run.currentPipelineStageId = "orchestrate";
  run.graphHash = digest("assignment-graph");
  const ticketBinding = executionBinding(run.compiledConfigHash, "ordinary", "ordinary-work");
  const stepBinding = executionBinding(run.compiledConfigHash, "ordinary", "ordinary-work", "work");
  const source = ticket("source", "ordinary", outcome === "failed" ? "blocked" : "review", {});
  source.executionPolicyBinding = ticketBinding;
  source.steps[0]!.validationAction = "compile";
  source.steps[0]!.executionPolicyBinding = stepBinding;
  source.steps[0]!.status = outcome === "failed" ? "failed" : "completed";
  source.steps[0]!.startedAt = "2026-07-18T00:01:00.000Z";
  source.steps[0]!.completedAt = "2026-07-18T00:02:00.000Z";
  run.tickets[source.id] = source;

  const acceptedAt = "2026-07-18T00:01:30.000Z";
  const policyMaterial = {
    protocol: "koni.agent-terminal-policy.v1" as const,
    mode: "legacy_pre_execution_policy" as const,
    acceptedAt,
  };
  const attempt: AgentAttemptRecord = {
    id: "attempt-source-work",
    sessionId: "session-source-work",
    ticketId: source.id,
    stepId: source.steps[0]!.id,
    personaId: "worker",
    modelProvider: "fixture",
    modelId: "fixture-model",
    thinkingLevel: "off",
    status: "completed",
    launchSpecHash: digest("launch-spec"),
    sessionFile: undefined,
    startedAt: "2026-07-18T00:01:00.000Z",
    endedAt: "2026-07-18T00:02:00.000Z",
    terminalSummary: outcome === "failed" ? "Failed validation" : "Completed validation",
    terminalOutputSha256: digest(`terminal-output-${outcome}`),
    terminalOutputSizeBytes: 16,
    terminalAcceptedAt: acceptedAt,
    terminalPolicy: { ...policyMaterial, sha256: canonicalHash(policyMaterial) },
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    kind: "ticket",
  };
  source.steps[0]!.attemptIds = [attempt.id];
  run.attempts[attempt.id] = attempt;
  const prepared = prepareRunActionExecution(run, {
    kind: "assignment_validation",
    stageId: "orchestrate",
    selector: "compile",
    checkout: "none",
    ticketId: source.id,
    ticketState: source.status,
    stepId: source.steps[0]!.id,
    attemptId: attempt.id,
    at: "2026-07-18T00:01:30.000Z",
  });
  const journal = await executeActionPlan(prepared.plan, { execute: async () => null });
  const semanticResult =
    outcome === "failed"
      ? {
          kind: "assignment" as const,
          status: "failed" as const,
          blocker: "Compiler rejected the assignment",
        }
      : {
          kind: "assignment" as const,
          status: "completed" as const,
          summary: "Compiler accepted the assignment",
        };
  const action: RunActionExecutionRecord = {
    ...structuredClone(prepared),
    journal,
    semanticResult,
    updatedAt: "2026-07-18T00:02:00.000Z",
  };
  action.settlement = createRunActionSettlement(
    action,
    outcome,
    outcome === "failed" ? "assignment validation failed" : "assignment validation completed",
    "2026-07-18T00:02:00.000Z",
  );
  action.settledAt = action.settlement.settledAt;
  run.actionExecutions = { [action.invocationId]: action };
  const successProof = createTerminalSuccessSettlementProof(run, action);
  if (successProof !== undefined)
    run.terminalSuccessProofs = { [successProof.sha256]: successProof };
  const failureProof = createTerminalFailureSettlementProof(run, action);
  if (failureProof !== undefined)
    run.terminalFailureProofs = { [failureProof.sha256]: failureProof };
  await store.commit({
    expectedRevision: 0,
    runWrites: [{ record: run, expectedRevision: null }],
  });
  return { root, stateRoot, store, run, proposalIds: [], action };
}

async function settledApprovedActions(
  run: Readonly<RunRecord>,
  count: number,
  startAtMs = Date.UTC(2026, 6, 18, 1, 0, 0),
): Promise<RunActionExecutionRecord[]> {
  return Promise.all(
    Array.from({ length: count }, async (_unused, index) => {
      const identityRun: RunRecord = structuredClone(run);
      identityRun.revision = 10_000 + index;
      const at = new Date(startAtMs + index * 1_000).toISOString();
      const prepared = prepareRunActionExecution(identityRun, {
        kind: "approved_plan_compile",
        stageId: "approval",
        selector: identityRun.behavior!.runType.actionSelectors.compile,
        checkout: "none",
        at,
      });
      const journal = await executeActionPlan(prepared.plan, { execute: async () => null });
      const action: RunActionExecutionRecord = {
        ...structuredClone(prepared),
        journal,
        semanticResult: {
          kind: "approved_plan",
          ticketCount: 0,
          graphHash: identityRun.graphHash!,
          graphRevision: identityRun.graphRevision,
        },
        updatedAt: at,
      };
      action.settlement = createRunActionSettlement(
        action,
        "completed",
        `approved plan retention fixture ${index}`,
        at,
      );
      action.settledAt = action.settlement.settledAt;
      return action;
    }),
  );
}

function archiveTransition(
  run: RunRecord,
  action: RunActionExecutionRecord,
): {
  next: RunRecord;
  row: RunActionExecutionArchiveRecord;
  bytes: Buffer;
  write: { path: string; bytes: Buffer; expectedSha256: null };
} {
  const next = structuredClone(run);
  next.revision = run.revision + 1;
  delete next.actionExecutions![action.invocationId];
  const archived = deriveRunActionExecutionArchive(run, action);
  const row = structuredClone(archived.row);
  const bytes = archived.bytes;
  next.actionExecutionArchive = [row];
  return {
    next,
    row,
    bytes,
    write: { path: row.artifactPath, bytes, expectedSha256: null },
  };
}

async function persistedAssignmentArchiveFixture(
  outcome: "completed" | "failed",
): Promise<PersistedAssignmentArchiveFixture> {
  const fixture = await assignmentActionFixture(outcome);
  const transition = archiveTransition(fixture.run, fixture.action);
  await fixture.store.commit({
    expectedRevision: 1,
    runWrites: [{ record: transition.next, expectedRevision: 0 }],
    writes: [transition.write],
  });
  return {
    fixture,
    run: await fixture.store.getRun(fixture.run.id),
    stateRevision: 2,
  };
}

async function persistedMultiRowArchiveFixture(): Promise<PersistedRunAuthorityFixture> {
  const fixture = await actionFixture();
  const seeded = structuredClone(fixture.run);
  seeded.revision = 1;
  const additional = await settledApprovedActions(seeded, 2, Date.UTC(2026, 6, 18, 1, 0, 0));
  seeded.actionExecutions ??= {};
  for (const action of additional) seeded.actionExecutions[action.invocationId] = action;
  await fixture.store.commit({
    expectedRevision: 1,
    runWrites: [{ record: seeded, expectedRevision: 0 }],
  });

  const ordered = Object.values(seeded.actionExecutions).sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.invocationId.localeCompare(right.invocationId),
  );
  const projections = ordered.map((action) => deriveRunActionExecutionArchive(seeded, action));
  const archived = structuredClone(seeded);
  archived.revision = 2;
  archived.actionExecutions = {};
  archived.actionExecutionArchive = projections.map(({ row }) => row);
  await fixture.store.commit({
    expectedRevision: 2,
    runWrites: [{ record: archived, expectedRevision: 1 }],
    writes: projections.map(({ row, bytes }) => ({
      path: row.artifactPath,
      bytes,
      expectedSha256: null,
    })),
  });
  return {
    fixture,
    run: await fixture.store.getRun(fixture.run.id),
    stateRevision: 3,
  };
}

async function indexedMultiSegmentArchiveFixture(): Promise<PersistedRunAuthorityFixture> {
  const fixture = await actionFixture();
  const seeded = structuredClone(fixture.run);
  seeded.revision = 1;
  const additional = await settledApprovedActions(seeded, 3, Date.UTC(2026, 6, 18, 1, 0, 0));
  seeded.actionExecutions ??= {};
  for (const action of additional) seeded.actionExecutions[action.invocationId] = action;
  await fixture.store.commit({
    expectedRevision: 1,
    runWrites: [{ record: seeded, expectedRevision: 0 }],
  });

  const ordered = Object.values(seeded.actionExecutions).sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.invocationId.localeCompare(right.invocationId),
  );
  const projections = ordered.map((action) => deriveRunActionExecutionArchive(seeded, action));
  const first = deriveRunActionExecutionArchiveSegment(
    seeded.id,
    projections.slice(0, 2).map(({ row }) => row),
  );
  const second = deriveRunActionExecutionArchiveSegment(
    seeded.id,
    projections.slice(2).map(({ row }) => row),
  );
  for (const { row, bytes } of projections) {
    const artifact = path.join(fixture.stateRoot, row.artifactPath);
    await mkdir(path.dirname(artifact), { recursive: true });
    await writeFile(artifact, bytes);
  }
  for (const segment of [first, second]) {
    const artifact = path.join(fixture.stateRoot, segment.segment.artifactPath);
    await mkdir(path.dirname(artifact), { recursive: true });
    await writeFile(artifact, segment.bytes);
  }
  const indexed = structuredClone(seeded);
  indexed.actionExecutions = {};
  indexed.actionExecutionArchive = [];
  indexed.actionExecutionArchiveSegments = [first.segment, second.segment];
  await overwriteRunAndTrust(fixture, indexed);
  await expect(fixture.store.getRun(indexed.id)).resolves.toBeDefined();
  return { fixture, run: indexed, stateRevision: 2 };
}

async function expectMalformedRunRejected(
  authority: PersistedRunAuthorityFixture,
  malformed: RunRecord,
  boundary: "raw load" | "store CAS",
  label: string,
  message: RegExp,
  trustRaw = true,
): Promise<void> {
  let rejection: unknown;
  if (boundary === "raw load") {
    if (trustRaw) await overwriteRunAndTrust(authority.fixture, malformed);
    else await overwriteRun(authority.fixture, malformed);
    try {
      await authority.fixture.store.getRun(authority.run.id);
    } catch (error) {
      rejection = error;
    } finally {
      await overwriteRunAndTrust(authority.fixture, authority.run);
    }
  } else {
    const successor = structuredClone(malformed);
    successor.revision = authority.run.revision + 1;
    successor.updatedAt = "2026-07-18T09:00:00.000Z";
    try {
      await authority.fixture.store.commit({
        expectedRevision: authority.stateRevision,
        runWrites: [{ record: successor, expectedRevision: authority.run.revision }],
      });
    } catch (error) {
      rejection = error;
    }
  }
  if (rejection === undefined) {
    throw new Error(`authority accepted malformed state: ${label}`);
  }
  expect(rejection instanceof Error ? rejection.message : String(rejection)).toMatch(message);
}

function forgedSuccessProof(
  run: Readonly<RunRecord>,
  action: Readonly<RunActionExecutionRecord>,
): TerminalSuccessSettlementProof {
  const attemptId = action.boundary.attemptId;
  if (
    attemptId === undefined ||
    action.boundary.ticketId === undefined ||
    action.boundary.stepId === undefined ||
    action.settlement === undefined
  ) {
    throw new Error("failed-action fixture lacks terminal settlement authority");
  }
  const attempt = run.attempts[attemptId];
  if (attempt?.terminalPolicy === undefined || attempt.terminalOutputSha256 === undefined) {
    throw new Error("failed-action fixture lacks terminal attempt authority");
  }
  const semanticResult = {
    kind: "assignment" as const,
    status: "completed" as const,
    summary: "Forged success over archived failed settlement",
  };
  const material = {
    protocol: "koni.terminal-success-settlement.v1" as const,
    runId: run.id,
    ticketId: action.boundary.ticketId,
    stepId: action.boundary.stepId,
    attemptId,
    actionInvocationId: action.invocationId,
    actionPlanSha256: action.plan.sha256,
    actionSettlementSha256: action.settlement.sha256,
    semanticResult,
    semanticResultSha256: canonicalHash(semanticResult),
    terminalPolicySha256: attempt.terminalPolicy.sha256,
    terminalOutputSha256: attempt.terminalOutputSha256,
  };
  return { ...material, sha256: canonicalHash(material) };
}

async function terminalArchivePressureFixture(outcome: "completed" | "failed"): Promise<{
  afterRestart: RunRecord;
  afterUnrelated: RunRecord;
}> {
  const fixture = await assignmentActionFixture(outcome);
  const seeded = structuredClone(fixture.run);
  seeded.revision = 1;
  const additional = await settledApprovedActions(seeded, 1_024);
  seeded.actionExecutions ??= {};
  for (const action of additional) seeded.actionExecutions[action.invocationId] = action;
  await fixture.store.commit({
    expectedRevision: 1,
    runWrites: [{ record: seeded, expectedRevision: 0 }],
  });

  const ordered = Object.values(seeded.actionExecutions).sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.invocationId.localeCompare(right.invocationId),
  );
  const firstBatch = ordered.slice(0, 1_024);
  const archived = structuredClone(seeded);
  archived.revision = 2;
  archived.actionExecutionArchive = [];
  const firstWrites: Array<{ path: string; bytes: Buffer; expectedSha256: null }> = [];
  for (const action of firstBatch) {
    const projection = deriveRunActionExecutionArchive(seeded, action);
    archived.actionExecutionArchive.push(projection.row);
    delete archived.actionExecutions![action.invocationId];
    firstWrites.push({
      path: projection.row.artifactPath,
      bytes: projection.bytes,
      expectedSha256: null,
    });
  }
  await fixture.store.commit({
    expectedRevision: 2,
    runWrites: [{ record: archived, expectedRevision: 1 }],
    writes: firstWrites,
  });

  const remaining = Object.values(archived.actionExecutions!);
  if (remaining.length !== 1)
    throw new Error("archive-pressure fixture retained the wrong action count");
  const finalProjection = deriveRunActionExecutionArchive(archived, remaining[0]!);
  const combined = [...archived.actionExecutionArchive, finalProjection.row];
  const compactedPrefix = combined.slice(0, combined.length - 256);
  const segmentProjection = deriveRunActionExecutionArchiveSegment(archived.id, compactedPrefix);
  const compacted = structuredClone(archived);
  compacted.revision = 3;
  compacted.actionExecutionArchive = combined.slice(compactedPrefix.length);
  compacted.actionExecutionArchiveSegments = [segmentProjection.segment];
  delete compacted.actionExecutions![remaining[0]!.invocationId];
  await fixture.store.commit({
    expectedRevision: 3,
    runWrites: [{ record: compacted, expectedRevision: 2 }],
    writes: [
      {
        path: finalProjection.row.artifactPath,
        bytes: finalProjection.bytes,
        expectedSha256: null,
      },
      {
        path: segmentProjection.segment.artifactPath,
        bytes: segmentProjection.bytes,
        expectedSha256: null,
      },
    ],
  });

  const reopened = await ProjectAuthorityStore.open({
    stateRoot: fixture.stateRoot,
    projectRoot: fixture.root,
    commonDirectory: path.join(fixture.root, ".git"),
  });
  const afterRestart = await reopened.getRun(compacted.id);
  const unrelated = structuredClone(afterRestart);
  unrelated.revision += 1;
  unrelated.updatedAt = "2026-07-18T09:30:00.000Z";
  await reopened.commit({
    expectedRevision: 4,
    runWrites: [{ record: unrelated, expectedRevision: 3 }],
  });
  return { afterRestart, afterUnrelated: await reopened.getRun(unrelated.id) };
}

function exactResolverRetry(
  run: Readonly<RunRecord>,
  catalog: CompiledExecutionSemanticCatalog,
  resolverTicketId: string,
  failureProof: TerminalFailureSettlementProof,
  eventId: string,
  recordedAt: string,
): ReturnType<typeof deriveTerminalResolverRetryRequest> {
  const resolver = run.tickets[resolverTicketId]!;
  const recovery = resolver.executionControl!.terminalRecovery!;
  const source = run.tickets[recovery.sourceTicketId]!;
  const sourceFailure = terminalFailureBindingFromProof(run, source, recovery.sourceFailureProof);
  const resolverFailure = terminalFailureBindingFromProof(run, resolver, failureProof);
  if (
    sourceFailure === undefined ||
    resolverFailure === undefined ||
    resolver.executionPolicyBinding === undefined
  ) {
    throw new Error("resolver retry fixture lost exact terminal failure binding");
  }
  return deriveTerminalResolverRetryRequest(catalog, {
    runId: run.id,
    resolverTicketId: resolver.id,
    resolverBinding: resolver.executionPolicyBinding,
    sourceTicketId: source.id,
    sourceFailureBindingSha256: sourceFailure.sha256,
    resolverFailure: {
      sha256: resolverFailure.sha256,
      attemptId: resolverFailure.attemptId,
      launchSpecHash: resolverFailure.launchSpecHash,
      terminalPolicySha256: resolverFailure.terminalPolicySha256,
      terminalOutputSha256: resolverFailure.terminalOutputSha256,
      failureSettlementSha256: resolverFailure.failureSettlementSha256,
      failureProof: resolverFailure.failureProof,
    },
    priorRetries: resolver.executionControl?.terminalResolverRetryRequests ?? [],
    event: {
      eventId,
      actor: "operator",
      message: `Retry exact resolver failure ${eventId}`,
      recordedAt,
    },
  });
}

function executionBinding(
  configurationSha256: Sha256Digest,
  operationId: string,
  publicOperation: string,
  stepId?: string,
): ExecutionPolicyBinding {
  const text = (value: string) => ({ text: value, sha256: canonicalHash(value) });
  const values = (items: string[]) => ({ values: items, sha256: canonicalHash(items) });
  const contextMaterial = {
    outputContract: text("Return one bounded result."),
    reviewContract: text("Review the bounded result."),
    escalationTriggers: values([]),
    stopConditions: values([]),
  };
  const context = { ...contextMaterial, sha256: canonicalHash(contextMaterial) };
  const material = {
    protocol: "koni.execution-policy-binding.v1" as const,
    configurationSha256,
    catalogSha256: digest("execution-catalog"),
    operationId,
    operationSha256: digest(`${operationId}-operation`),
    publicOperation,
    workflowId: `${operationId}-workflow`,
    workflowVersion: "1.0.0",
    workflowSha256: digest(`${operationId}-workflow`),
    ...(stepId === undefined ? {} : { stepId, stepSha256: digest(`${operationId}-${stepId}`) }),
    context,
  };
  return { ...material, sha256: canonicalHash(material) };
}

function rehashFailureProof(proof: TerminalFailureSettlementProof): void {
  proof.semanticResultSha256 = canonicalHash(proof.semanticResult);
  const { sha256: _ignored, ...material } = proof;
  proof.sha256 = canonicalHash(material);
}

function rehashSuccessProof(proof: TerminalSuccessSettlementProof): void {
  proof.semanticResultSha256 = canonicalHash(proof.semanticResult);
  const { sha256: _ignored, ...material } = proof;
  proof.sha256 = canonicalHash(material);
}

function rehashTerminalArchiveAuthority(authority: RunActionTerminalArchiveAuthority): void {
  const { sha256: _ignored, ...material } = authority;
  authority.sha256 = canonicalHash(material);
}

function baseRun(root: string): RunRecord {
  const now = "2026-07-18T00:00:00.000Z";
  return {
    protocol: "koni.run-record.v1",
    id: "run-store-authority",
    revision: 0,
    generation: 0,
    projectRoot: root,
    profile: {
      packageName: "@koni/research-profile",
      packageVersion: "1.1.0",
      lineage: "koni.research",
      bundleHash: digest("profile"),
    },
    compiledConfigHash: digest("configuration"),
    runTypeId: "small",
    objective: "Exercise durable change-control authority",
    intake: { goal: "Exercise durable change-control authority" },
    createdAt: now,
    updatedAt: now,
    lifecycle: newRunLifecycle("run-store-authority"),
    pipelineStageIds: [],
    currentPipelineStageId: undefined,
    plan: undefined,
    graphRevision: 0,
    graphHash: undefined,
    tickets: {},
    attempts: {},
    questions: {},
    activity: [],
    git: fixtureRunGit(root, "run-store-authority"),
  };
}

function ticket(
  id: string,
  operationId: string,
  status: TicketRecord["status"],
  executionControl: TicketExecutionControlRecord,
): TicketRecord {
  const now = "2026-07-18T00:00:00.000Z";
  return {
    id,
    operationId,
    title: id,
    summary: `Fixture ${id}`,
    status,
    executionControl,
    priority: 0,
    dependencyIds: [],
    targetNodeIds: [],
    readNodeIds: [],
    writeNodeIds: [],
    readPaths: [],
    writePaths: [],
    steps: [
      {
        id: "work",
        title: "Work",
        personaId: "worker",
        kind: "production",
        dependsOn: [],
        readNodeIds: [],
        writeNodeIds: [],
        readPaths: [],
        writePaths: [],
        status: "pending",
        attemptIds: [],
        summary: undefined,
        startedAt: undefined,
        completedAt: undefined,
      },
    ],
    worktreePath: undefined,
    branch: undefined,
    blocker: undefined,
    createdAt: now,
    updatedAt: now,
  };
}

async function storedControlFixture(role: ControlTicketRole): Promise<StoredControlFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "koni-control-ticket-store-"));
  roots.push(root);
  const stateRoot = path.join(root, "state");
  const store = await ProjectAuthorityStore.open({
    stateRoot,
    projectRoot: root,
    commonDirectory: path.join(root, ".git"),
  });
  const fixture = await controlFixture(role, root);
  await store.commit({
    expectedRevision: 0,
    runWrites: [{ record: fixture.run, expectedRevision: null }],
  });
  const proposalIds = Object.values(fixture.run.tickets)
    .filter((candidate) => candidate.executionControl?.controlTicketAuthority?.role === "proposal")
    .map((candidate) => candidate.id);
  return { root, stateRoot, store, proposalIds, ...fixture };
}

async function completedApplicationReleaseFixture(fixture: StoredControlFixture) {
  const run = structuredClone(fixture.run);
  run.revision += 1;
  run.updatedAt = "2026-07-18T05:02:00.000Z";
  const application = run.tickets[fixture.controlTicketId]!;
  const cycle = attachFixtureTicketCycle(run, application);
  for (const [index] of application.steps.entries()) {
    await addControlSuccessAttempt(
      run,
      application,
      index,
      `attempt-application-publication-${index + 1}`,
      {},
    );
  }
  application.status = "completed";
  application.updatedAt = run.updatedAt;
  const proposal = run.tickets[application.executionControl!.sourceProposalTicketId!]!;
  const source = run.tickets[proposal.executionControl!.proposalRequest!.sourceTicketId]!;
  delete source.executionControl!.sourceHold;
  const integratedRunOid = "b".repeat(40);
  run.git.run.headOid = integratedRunOid;
  cycle.status = "retired";
  cycle.integratedRunOid = integratedRunOid;
  cycle.squashCommitOid = integratedRunOid;
  cycle.integratedAt = "2026-07-18T05:02:00.000Z";
  cycle.retiredAt = "2026-07-18T05:02:01.000Z";
  cycle.blocker = undefined;
  return { run, application, proposal, source, cycle };
}

function addSupersededApplicationCycle(
  fixture: Awaited<ReturnType<typeof completedApplicationReleaseFixture>>,
): void {
  const prior = structuredClone(fixture.cycle);
  prior.cycleId = `${fixture.cycle.cycleId}-prior`;
  prior.ordinal = fixture.cycle.ordinal;
  prior.status = "retired";
  prior.branchRef = `${fixture.cycle.branchRef}-prior`;
  prior.worktree = `${fixture.cycle.worktree}-prior`;
  prior.integratedRunOid = undefined;
  prior.squashCommitOid = undefined;
  prior.integratedAt = undefined;
  prior.retiredAt = "2026-07-18T05:01:59.000Z";
  prior.supersededAt = prior.retiredAt;
  prior.supersessionSha256 = digest("prior-application-cycle-supersession");
  prior.archiveRef = `refs/koni/archive/${fixture.run.id}/tickets/${fixture.application.id}/cycles/${prior.cycleId}/${prior.supersessionSha256.slice("sha256:".length)}`;
  fixture.cycle.ordinal += 1;
  fixture.run.git.ticketCycles[prior.cycleId] = prior;
  fixture.run.git.ticketCycleOrder.unshift(prior.cycleId);
}

async function controlFixture(role: ControlTicketRole, root: string): Promise<ControlFixture> {
  const catalog = buildControlCatalog();
  const run = controlBaseRun(root, catalog);
  if (role === "terminal_resolver") return controlResolverFixture(run, catalog);
  const proposal = await controlProposalTicket(run, catalog, 1);
  if (role === "proposal") return { run, catalog, controlTicketId: proposal.id };
  const application = await controlApplicationTicket(run, catalog, proposal);
  return { run, catalog, controlTicketId: application.id };
}

async function controlProposalTicket(
  run: RunRecord,
  catalog: CompiledExecutionSemanticCatalog,
  ordinal: number,
): Promise<TicketRecord> {
  const nodeId = `claim-${ordinal}`;
  const source = controlOrdinaryTicket(
    catalog,
    `source-proposal-${ordinal}`,
    "blocked",
    [nodeId],
    [],
    [],
  );
  run.tickets[source.id] = source;
  const sourceBinding = source.steps[0]!.executionPolicyBinding!;
  const publication = deriveChangeControlPublication(catalog, {
    runId: run.id,
    sourceTicketId: source.id,
    sourceStepId: source.steps[0]!.id,
    sourceOutputSha256: digest(`source-proposal-${ordinal}-output`),
    sourceBinding,
    targetNodeIds: [nodeId],
    summary: `Adjust exact claim ${ordinal} contract`,
    reason: "The compiled work exposed a bounded mismatch",
  });
  const sourceCompilation = {
    protocol: "koni.assignment-change-control.v1" as const,
    kind: "upstream_request" as const,
    sourceTicketId: source.id,
    sourceStepId: source.steps[0]!.id,
    sourceBindingSha256: sourceBinding.sha256,
    sourceOutputSha256: publication.sourceOutputSha256,
    targetNodeIds: publication.targetNodeIds,
    summary: publication.summary,
    reason: publication.reason,
    publication,
  };
  const sourceProof = await addControlSuccessAttempt(
    run,
    source,
    0,
    `attempt-source-proposal-${ordinal}`,
    { changeControlSha256: canonicalHash(sourceCompilation) },
  );
  const sourceHold = {
    proposalTicketId: publication.proposalTicketId,
    requestSha256: publication.requestSha256,
  };
  source.executionControl = { sourceHold };

  const definition = controlDefinition(catalog, {
    id: publication.proposalTicketId,
    operationId: "proposal",
    title: controlTitle("Change request", publication.summary),
    targetNodeIds: [nodeId],
    readNodeIds: [nodeId],
    writeNodeIds: [],
    readPaths: [],
    writePaths: [],
    ruleId: "compiler.change-control.proposal",
  });
  const executionControl: TicketExecutionControlRecord = {
    changeControlScopeNodeIds: [nodeId],
    proposalRequest: {
      requestSha256: publication.requestSha256,
      sourceTicketId: source.id,
      sourceStepId: source.steps[0]!.id,
      sourceOutputSha256: publication.sourceOutputSha256,
    },
  };
  const proposal = controlTicketFromDefinition(
    catalog,
    definition,
    "proposed",
    `${publication.summary}\n\nReason: ${publication.reason}`,
    executionControl,
  );
  attachControlAuthority(run, catalog, proposal, definition, "proposal", {
    role: "proposal",
    publication,
    sourceTicketProjection: ticketImmutableProjection(source),
    sourceTerminalProof: sourceProof,
    sourceHold,
  });
  run.tickets[proposal.id] = proposal;
  return proposal;
}

async function controlApplicationTicket(
  run: RunRecord,
  catalog: CompiledExecutionSemanticCatalog,
  proposal: TicketRecord,
): Promise<TicketRecord> {
  proposal.status = "completed";
  const request = proposal.executionControl!.proposalRequest!;
  const approvalMaterial = {
    protocol: "koni.proposal-decision-authority.v2" as const,
    runId: run.id,
    proposalTicketId: proposal.id,
    requestSha256: request.requestSha256,
    eventId: "decision-approve-proposal",
    decision: "approval" as const,
    actor: "operator" as const,
    message: "Approve exact application",
    recordedAt: CONTROL_AT,
  };
  const approval = { ...approvalMaterial, sha256: canonicalHash(approvalMaterial) };
  const applicationBinding = controlBind(catalog, "application");
  const proposalOutputSha256 = digest("proposal-selection-output");
  const selectionSummary = "Apply the bounded claim change";
  const selectionMaterial = {
    protocol: "koni.assignment-change-control.v1" as const,
    kind: "proposal_application" as const,
    configurationSha256: catalog.configurationSha256,
    catalogSha256: catalog.sha256,
    proposalBindingSha256: proposal.executionPolicyBinding!.sha256,
    applicationBinding,
    proposalOutputSha256,
    proposalTicketId: proposal.id,
    proposalStepId: proposal.steps[0]!.id,
    applicationPublicOperation: catalog.operations.application!.publicOperation,
    applicationOperationId: "application",
    targetNodeIds: ["claim-1"],
    summary: selectionSummary,
    scope: {
      readNodeIds: ["claim-1"],
      writeNodeIds: ["claim-1"],
      readPaths: [],
      writePaths: [],
    },
  };
  const selectionSha256 = canonicalHash(selectionMaterial);
  const proposalProof = await addControlSuccessAttempt(
    run,
    proposal,
    0,
    "attempt-proposal-selection",
    { changeControlSha256: selectionSha256 },
  );
  const reviewProof = await addControlSuccessAttempt(
    run,
    proposal,
    1,
    "attempt-proposal-review",
    {},
  );
  const reviewAttempt = run.attempts[reviewProof.attemptId]!;
  const reviewSha256 = canonicalHash({
    protocol: "koni.proposal-review-authority.v1",
    attemptId: reviewAttempt.id,
    launchSpecHash: reviewAttempt.launchSpecHash,
    approvalSha256: approval.sha256,
    terminalPolicySha256: reviewAttempt.terminalPolicy!.sha256,
    terminalOutputSha256: reviewAttempt.terminalOutputSha256!,
    terminalAcceptedAt: reviewAttempt.terminalAcceptedAt,
  });
  const materialization = deriveApprovedChangeMaterialization(catalog, {
    runId: run.id,
    proposalTicketId: proposal.id,
    proposalBinding: proposal.executionPolicyBinding!,
    requestSha256: request.requestSha256,
    approvalSha256: approval.sha256,
    proposalOutputSha256,
    proposalStepId: proposal.steps[0]!.id,
    proposalSelectionSha256: selectionSha256,
    selectionSummary,
    proposalTerminalProof: proposalProof,
    reviewSha256,
    reviewTerminalProof: reviewProof,
    applicationPublicOperation: catalog.operations.application!.publicOperation,
    targetNodeIds: ["claim-1"],
    scope: selectionMaterial.scope,
  });
  if (materialization.kind !== "application") {
    throw new Error("fixture expected application materialization");
  }
  proposal.executionControl = {
    ...proposal.executionControl!,
    proposalDecision: approval,
    proposalDecisionHistory: [approval],
    proposalApprovalSha256: approval.sha256,
    proposalDisposition: {
      kind: "application",
      authoritySha256: materialization.authoritySha256,
      applicationTicketId: materialization.applicationTicketId,
    },
    approvedApplicationSha256: materialization.authoritySha256,
    approvedMaterialization: materialization,
  };
  const definition = controlDefinition(catalog, {
    id: materialization.applicationTicketId,
    operationId: "application",
    title: controlTitle("Apply change", selectionSummary),
    targetNodeIds: ["claim-1"],
    readNodeIds: ["claim-1"],
    writeNodeIds: ["claim-1"],
    readPaths: [],
    writePaths: [],
    ruleId: "compiler.change-control.application",
  });
  const executionControl: TicketExecutionControlRecord = {
    changeControlScopeNodeIds: ["claim-1"],
    sourceProposalTicketId: proposal.id,
    approvedApplicationSha256: materialization.authoritySha256,
  };
  const application = controlTicketFromDefinition(
    catalog,
    definition,
    "ready",
    selectionSummary,
    executionControl,
    [proposal.id],
  );
  attachControlAuthority(run, catalog, application, definition, "approved_application", {
    role: "approved_application",
    materialization,
    proposalTicketAuthoritySha256: proposal.executionControl.controlTicketAuthority!.sha256,
    proposalTicketProjectionSha256:
      proposal.executionControl.controlTicketAuthority!.projectionSha256,
  });
  run.tickets[application.id] = application;
  return application;
}

async function controlResolverFixture(
  run: RunRecord,
  catalog: CompiledExecutionSemanticCatalog,
): Promise<ControlFixture> {
  const source = controlOrdinaryTicket(
    catalog,
    "source-failure",
    "blocked",
    ["claim-1"],
    ["src/failure.ts"],
    ["src/failure.ts"],
  );
  run.tickets[source.id] = source;
  const failureProof = await addControlFailureAttempt(run, source, 0, "attempt-source-failure");
  const failure = terminalFailureBindingFromProof(run, source, failureProof);
  if (failure === undefined) throw new Error("fixture failed to derive terminal failure binding");
  const reconciliation = deriveTerminalResolverReconciliation(catalog, {
    runId: run.id,
    sourceTicketId: source.id,
    sourceBinding: source.executionPolicyBinding!,
    failureBindingSha256: failure.sha256,
    existingResolvers: [],
  });
  if (reconciliation.chainSuppressed) throw new Error("fixture unexpectedly suppressed resolver");
  const recoveryMaterial = {
    protocol: "koni.terminal-recovery-authority.v2" as const,
    configurationSha256: catalog.configurationSha256,
    catalogSha256: catalog.sha256,
    resolverOperationId: reconciliation.resolverOperationId,
    resolverTicketId: reconciliation.resolverTicketId,
    resolverBinding: reconciliation.resolverBinding,
    resolverOperation: catalog.operations.resolver!,
    sourceTicketId: source.id,
    failureBindingSha256s: [...reconciliation.failureBindingSha256s],
    sourceFailureProof: failureProof,
    reconciliationDisposition: reconciliation.disposition,
    sourceLink: reconciliation.sourceLink,
    chainSuppressed: false as const,
    reconciliationSha256: reconciliation.sha256,
  };
  const recovery = { ...recoveryMaterial, sha256: canonicalHash(recoveryMaterial) };
  const readNodes = [
    ...new Set([...(source.readNodeIds ?? []), ...(source.writeNodeIds ?? [])]),
  ].sort();
  const definition = controlDefinition(catalog, {
    id: reconciliation.resolverTicketId,
    operationId: "resolver",
    title: `Resolve terminal failure: ${source.title}`,
    targetNodeIds: source.targetNodeIds,
    readNodeIds: readNodes,
    writeNodeIds: source.writeNodeIds ?? [],
    readPaths: source.readPaths,
    writePaths: source.writePaths,
    ruleId: "compiler.change-control.terminal-resolver",
  });
  const executionControl: TicketExecutionControlRecord = {
    changeControlScopeNodeIds: [...new Set([...readNodes, ...(source.writeNodeIds ?? [])])].sort(),
    terminalRecovery: recovery,
  };
  const resolver = controlTicketFromDefinition(
    catalog,
    definition,
    "ready",
    `Recover terminal ticket ${source.id} from 1 authenticated failure binding(s).`,
    executionControl,
  );
  attachControlAuthority(run, catalog, resolver, definition, "terminal_resolver", {
    role: "terminal_resolver",
    reconciliation,
    sourceTicketProjection: ticketImmutableProjection(source),
    sourceFailureProof: failureProof,
  });
  run.tickets[resolver.id] = resolver;
  return { run, catalog, controlTicketId: resolver.id };
}

function attachControlAuthority(
  run: RunRecord,
  catalog: CompiledExecutionSemanticCatalog,
  ticketRecord: TicketRecord,
  definition: DerivedTicketDefinition,
  role: ControlTicketRole,
  causal: ControlTicketCausalAuthority,
): void {
  const operation = catalog.operations[ticketRecord.operationId]!;
  const workflowRecord = catalog.workflows[operation.workflowId!]!;
  ticketRecord.executionControl!.controlTicketAuthority = createCompilerControlTicketAuthority({
    runId: run.id,
    role,
    ticket: ticketRecord,
    operation,
    workflow: workflowRecord,
    definition,
    causal,
  });
}

function controlTicketFromDefinition(
  catalog: CompiledExecutionSemanticCatalog,
  definition: DerivedTicketDefinition,
  status: TicketStatus,
  summary: string,
  executionControl: TicketExecutionControlRecord,
  dependencyIds: string[] = [],
): TicketRecord {
  return {
    id: definition.id,
    operationId: definition.operation_registry_id,
    title: definition.title,
    summary,
    status,
    executionPolicyBinding: controlBind(catalog, definition.operation_registry_id),
    executionControl,
    priority: -(definition.rule_priority * 1_000 + definition.operation_dispatch_priority),
    dependencyIds,
    targetNodeIds: [...definition.target_node_ids],
    readNodeIds: [...definition.scope.read_node_ids],
    writeNodeIds: [...definition.scope.write_node_ids],
    readPaths: [...definition.scope.read_paths],
    writePaths: [...definition.scope.write_paths],
    steps: definition.workflow.map((step) => ({
      id: step.id,
      title: controlStepTitle(step.id),
      personaId: step.persona_id,
      kind: step.kind,
      dependsOn: [...step.depends_on],
      ...(step.read_node_ids === undefined ? {} : { readNodeIds: [...step.read_node_ids] }),
      ...(step.write_node_ids === undefined ? {} : { writeNodeIds: [...step.write_node_ids] }),
      ...(step.read_paths === undefined ? {} : { readPaths: [...step.read_paths] }),
      ...(step.write_paths === undefined ? {} : { writePaths: [...step.write_paths] }),
      ...(step.validation_action === undefined ? {} : { validationAction: step.validation_action }),
      executionPolicyBinding: controlBind(catalog, definition.operation_registry_id, step.id),
      status: "pending",
      attemptIds: [],
      summary: undefined,
      startedAt: undefined,
      completedAt: undefined,
    })),
    ...(definition.review_failure_reopen_from === undefined
      ? {}
      : {
          reviewFailureReopenFrom: definition.review_failure_reopen_from,
          reviewReworkLimit: 1,
          reviewReworkCount: 0,
          reviewReworks: [],
        }),
    worktreePath: undefined,
    branch: undefined,
    blocker: undefined,
    createdAt: CONTROL_AT,
    updatedAt: CONTROL_AT,
  };
}

function controlOrdinaryTicket(
  catalog: CompiledExecutionSemanticCatalog,
  id: string,
  status: TicketStatus,
  nodes: string[],
  readPaths: string[],
  writePaths: string[],
): TicketRecord {
  return {
    id,
    operationId: "ordinary",
    title: id,
    summary: `Ordinary source ${id}`,
    status,
    executionPolicyBinding: controlBind(catalog, "ordinary"),
    executionControl: {},
    priority: 0,
    dependencyIds: [],
    targetNodeIds: [...nodes],
    readNodeIds: [...nodes],
    writeNodeIds: [...nodes],
    readPaths: [...readPaths],
    writePaths: [...writePaths],
    steps: [
      {
        id: "work",
        title: "Work",
        personaId: "worker",
        kind: "production",
        dependsOn: [],
        readNodeIds: [...nodes],
        writeNodeIds: [...nodes],
        readPaths: [...readPaths],
        writePaths: [...writePaths],
        validationAction: "compile",
        executionPolicyBinding: controlBind(catalog, "ordinary", "work"),
        status: "pending",
        attemptIds: [],
        summary: undefined,
        startedAt: undefined,
        completedAt: undefined,
      },
    ],
    worktreePath: undefined,
    branch: undefined,
    blocker: undefined,
    createdAt: CONTROL_AT,
    updatedAt: CONTROL_AT,
  };
}

function controlDefinition(
  catalog: CompiledExecutionSemanticCatalog,
  input: Readonly<{
    id: string;
    operationId: string;
    title: string;
    targetNodeIds: string[];
    readNodeIds: string[];
    writeNodeIds: string[];
    readPaths: string[];
    writePaths: string[];
    ruleId: string;
  }>,
): DerivedTicketDefinition {
  const operation = catalog.operations[input.operationId]!;
  const workflowRecord = catalog.workflows[operation.workflowId!]!;
  const steps: DerivedWorkflowStep[] = workflowRecord.steps.map((semantic, index) => ({
    id: semantic.id,
    kind: index === workflowRecord.steps.length - 1 ? "review" : "production",
    persona_id: index === workflowRecord.steps.length - 1 ? "reviewer" : "worker",
    depends_on: index === 0 ? [] : [workflowRecord.steps[index - 1]!.id],
    required: true,
    read_node_ids: [...input.readNodeIds],
    write_node_ids: [...input.writeNodeIds],
    read_paths: [...input.readPaths],
    write_paths: [...input.writePaths],
    expected_outputs: [
      index === workflowRecord.steps.length - 1 ? "Reviewed result" : "Prepared result",
    ],
    graph_mutation: input.writeNodeIds.length === 0 ? "forbidden" : "allowed",
    validation_action: "compile",
    required_receipts: [...semantic.requiredReceipts],
    escalation_triggers: [...semantic.escalationTriggers],
    stop_conditions: [...semantic.stopConditions],
    validation_checks: [...semantic.validationChecks],
    context_sha256: digest(`${input.id}-${semantic.id}-context`),
  }));
  const material = {
    protocol: "koni.derived-ticket.v1" as const,
    id: input.id,
    rule_id: input.ruleId,
    rule_phase: operation.stage,
    rule_priority: 0,
    anchor_node_id: input.targetNodeIds[0] ?? input.id,
    operation: operation.publicOperation,
    operation_registry_id: operation.id,
    operation_dispatch_priority: 0,
    ranking_hints: [] as string[],
    title: input.title,
    target_node_ids: [...input.targetNodeIds],
    scope: {
      read_node_ids: [...input.readNodeIds],
      write_node_ids: [...input.writeNodeIds],
      read_paths: [...input.readPaths],
      write_paths: [...input.writePaths],
    },
    source_state_key: "control-source",
    target_state_key: "control-target",
    obligation_keys: [digest(`${input.id}-obligation`)],
    workflow_id: workflowRecord.id,
    review_failure_reopen_from: steps[0]!.id,
    workflow: steps,
    configuration_sha256: catalog.configurationSha256,
  };
  return { ...material, definition_sha256: canonicalHash(material) };
}

async function addControlSuccessAttempt(
  run: RunRecord,
  ticketRecord: TicketRecord,
  stepIndex: number,
  attemptId: string,
  input: Readonly<{ changeControlSha256?: Sha256Digest }>,
): Promise<TerminalSuccessSettlementProof> {
  const step = ticketRecord.steps[stepIndex]!;
  const terminalPolicy = controlTerminalPolicy();
  const terminalOutputSha256 = digest(`${attemptId}-output`);
  run.attempts[attemptId] = controlAttemptRecord(
    ticketRecord,
    step.id,
    attemptId,
    terminalPolicy,
    terminalOutputSha256,
  );
  step.status = "completed";
  step.attemptIds = [attemptId];
  step.summary = "Completed exact compiler-authorized work";
  step.startedAt = CONTROL_AT;
  step.completedAt = CONTROL_AT;
  const semanticResult = {
    kind: "assignment" as const,
    status: "completed" as const,
    summary: "Completed exact compiler-authorized work",
    ...(input.changeControlSha256 === undefined
      ? {}
      : { changeControlSha256: input.changeControlSha256 }),
  };
  const prepared = prepareRunActionExecution(run, {
    kind: "assignment_validation",
    stageId: "orchestrate",
    selector: "compile",
    checkout: "none",
    ticketId: ticketRecord.id,
    ticketState: ticketRecord.status,
    stepId: step.id,
    attemptId,
    at: CONTROL_AT,
  });
  const journal = await executeActionPlan(prepared.plan, { execute: async () => null });
  const action: RunActionExecutionRecord = {
    ...structuredClone(prepared),
    journal,
    semanticResult,
    updatedAt: CONTROL_AT,
  };
  action.settlement = createRunActionSettlement(
    action,
    "completed",
    "compiler accepted exact assignment",
    CONTROL_AT,
  );
  action.settledAt = action.settlement.settledAt;
  run.actionExecutions ??= {};
  run.actionExecutions[action.invocationId] = action;
  const proof = createTerminalSuccessSettlementProof(run, action);
  if (proof === undefined) throw new Error("fixture failed to derive terminal success proof");
  run.terminalSuccessProofs ??= {};
  run.terminalSuccessProofs[proof.sha256] = proof;
  return proof;
}

async function addControlFailureAttempt(
  run: RunRecord,
  ticketRecord: TicketRecord,
  stepIndex: number,
  attemptId: string,
): Promise<TerminalFailureSettlementProof> {
  const step = ticketRecord.steps[stepIndex]!;
  const terminalPolicy = controlTerminalPolicy();
  const terminalOutputSha256 = digest(`${attemptId}-output`);
  run.attempts[attemptId] = controlAttemptRecord(
    ticketRecord,
    step.id,
    attemptId,
    terminalPolicy,
    terminalOutputSha256,
  );
  step.status = "failed";
  step.attemptIds = [attemptId];
  step.summary = "Configured validation failed";
  step.startedAt = CONTROL_AT;
  step.completedAt = CONTROL_AT;
  const semanticResult = {
    kind: "assignment" as const,
    status: "failed" as const,
    blocker: "Configured validation failed",
  };
  const prepared = prepareRunActionExecution(run, {
    kind: "assignment_validation",
    stageId: "orchestrate",
    selector: "compile",
    checkout: "none",
    ticketId: ticketRecord.id,
    ticketState: ticketRecord.status,
    stepId: step.id,
    attemptId,
    at: CONTROL_AT,
  });
  const journal = await executeActionPlan(prepared.plan, { execute: async () => null });
  const action: RunActionExecutionRecord = {
    ...structuredClone(prepared),
    journal,
    semanticResult,
    updatedAt: CONTROL_AT,
  };
  action.settlement = createRunActionSettlement(
    action,
    "failed",
    "compiler rejected exact assignment",
    CONTROL_AT,
  );
  action.settledAt = action.settlement.settledAt;
  run.actionExecutions ??= {};
  run.actionExecutions[action.invocationId] = action;
  const proof = createTerminalFailureSettlementProof(run, action);
  if (proof === undefined) throw new Error("fixture failed to derive terminal failure proof");
  run.terminalFailureProofs ??= {};
  run.terminalFailureProofs[proof.sha256] = proof;
  return proof;
}

function controlAttemptRecord(
  ticketRecord: TicketRecord,
  stepId: string,
  attemptId: string,
  terminalPolicy: ReturnType<typeof controlTerminalPolicy>,
  terminalOutputSha256: Sha256Digest,
): AgentAttemptRecord {
  return {
    id: attemptId,
    sessionId: `session-${attemptId}`,
    sessionFile: `/tmp/koni-control-ticket-authority/${attemptId}.jsonl`,
    ticketId: ticketRecord.id,
    stepId,
    personaId: ticketRecord.steps.find((step) => step.id === stepId)!.personaId,
    modelProvider: "fixture",
    modelId: "fixture-model",
    thinkingLevel: "off",
    status: "completed",
    launchSpecHash: digest(`${attemptId}-launch`),
    startedAt: CONTROL_AT,
    endedAt: CONTROL_AT,
    terminalSummary: "Fixture terminal result",
    terminalOutputSha256,
    terminalOutputSizeBytes: 32,
    terminalAcceptedAt: terminalPolicy.acceptedAt,
    terminalPolicy,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    kind: "ticket",
  };
}

function controlTerminalPolicy() {
  const material = {
    protocol: "koni.agent-terminal-policy.v1" as const,
    mode: "legacy_pre_execution_policy" as const,
    acceptedAt: CONTROL_AT,
  };
  return { ...material, sha256: canonicalHash(material) };
}

function controlBaseRun(root: string, catalog: CompiledExecutionSemanticCatalog): RunRecord {
  const behavior = runBehaviorSnapshotFixture("large", "control-ticket-store-authority");
  return {
    protocol: "koni.run-record.v1",
    id: "run-control-authority",
    revision: 0,
    generation: 0,
    projectRoot: root,
    profile: {
      packageName: "@koni/research-profile",
      packageVersion: "1.1.0",
      lineage: "koni.research",
      bundleHash: digest("bundle"),
    },
    compiledConfigHash: catalog.configurationSha256,
    runTypeId: "large",
    objective: "Prove canonical control-ticket authority",
    intake: { goal: "Prove canonical control-ticket authority" },
    behavior,
    createdAt: CONTROL_AT,
    updatedAt: CONTROL_AT,
    lifecycle: newRunLifecycle("run-control-authority"),
    pipelineStageIds: behavior.runType.pipeline.map((stage) => stage.id),
    currentPipelineStageId: "orchestrate",
    plan: undefined,
    graphRevision: 0,
    graphHash: undefined,
    tickets: {},
    attempts: {},
    terminalFailureProofs: {},
    terminalSuccessProofs: {},
    questions: {},
    activity: [],
    git: fixtureRunGit(root, "run-control-authority", "approved"),
  };
}

function buildControlCatalog(): CompiledExecutionSemanticCatalog {
  const registries = {
    operations: {
      ordinary: {
        id: "ordinary",
        operation: "ordinary-work",
        stage: "execution",
        workflow: "ordinary-flow",
        change_control: {
          role: "ordinary",
          allow_upstream_requests: true,
          proposal_operation: "propose-change",
        },
      },
      proposal: {
        id: "proposal",
        operation: "propose-change",
        stage: "change-control",
        workflow: "proposal-flow",
        change_control: {
          role: "proposal",
          proposal_step: "prepare",
          application_operations: ["apply-change"],
        },
      },
      application: {
        id: "application",
        operation: "apply-change",
        stage: "change-control",
        workflow: "application-flow",
        change_control: { role: "application" },
      },
      resolver: {
        id: "resolver",
        operation: "resolve-failure",
        stage: "recovery",
        workflow: "resolver-flow",
        gate_blocking_exempt: true,
        single_flight_group: "recovery",
        terminal_resolver: true,
        change_control: { role: "ordinary", allow_upstream_requests: false },
      },
    },
    workflows: {
      "ordinary-flow": controlWorkflow("ordinary-flow", "ordinary-work", ["work"]),
      "proposal-flow": controlWorkflow("proposal-flow", "propose-change", ["prepare", "review"]),
      "application-flow": controlWorkflow("application-flow", "apply-change", [
        "prepare",
        "review",
      ]),
      "resolver-flow": controlWorkflow("resolver-flow", "resolve-failure", ["prepare", "review"]),
    },
    checks: {},
  };
  const material = { registries, edge_types: [] };
  return compileExecutionSemanticCatalog({
    configuration_sha256: canonicalHash(material),
    registries: {
      ...Object.fromEntries(
        [
          "node_types",
          "queries",
          "graph_constraints",
          "gate_policies",
          "rules",
          "actions",
          "personas",
          "reports",
          "views",
          "state_machines",
          "agents",
        ].map((key) => [key, Object.create(null)]),
      ),
      ...registries,
    },
    edge_types: [],
  } as unknown as CompiledConfiguration);
}

function controlWorkflow(id: string, operation: string, steps: string[]) {
  return {
    id,
    version: "1.0.0",
    applies_to: [operation],
    steps: steps.map((step) => ({ id: step, required: true })),
  };
}

function controlBind(
  catalog: CompiledExecutionSemanticCatalog,
  operationId: string,
  stepId?: string,
): ExecutionPolicyBinding {
  const operation = catalog.operations[operationId]!;
  return resolveExecutionPolicyBinding(catalog, {
    configurationSha256: catalog.configurationSha256,
    operationId,
    workflowId: operation.workflowId!,
    ...(stepId === undefined ? {} : { stepId }),
  });
}

function controlTitle(prefix: string, summary: string): string {
  return `${prefix}: ${summary.trim().split(/\r?\n/u)[0] ?? summary.trim()}`.slice(0, 240);
}

function controlStepTitle(value: string): string {
  return value
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function controlAuthorityAttacks(): readonly ControlAuthorityAttack[] {
  return [
    {
      name: "ticket identity",
      mutate: (run, ticketRecord, authority) => {
        const priorId = ticketRecord.id;
        const replacementId = `${priorId}-attacker`;
        delete run.tickets[priorId];
        ticketRecord.id = replacementId;
        run.tickets[replacementId] = ticketRecord;
        (authority as unknown as Record<string, unknown>).ticketId = replacementId;
        const definition = authority.definition as unknown as Record<string, unknown>;
        definition.id = replacementId;
        rehashNestedControl(definition, "definition_sha256");
      },
    },
    {
      name: "operation",
      reproject: false,
      mutate: (_run, _ticket, authority) => {
        const operation = authority.operation as unknown as Record<string, unknown>;
        operation.publicOperation = `${String(operation.publicOperation)}-attacker`;
        rehashNestedControl(operation, "sha256");
      },
    },
    {
      name: "ticket operation identity",
      mutate: (_run, ticketRecord, authority) => {
        const operation = authority.operation as unknown as Record<string, unknown>;
        const replacementId = `${String(operation.id)}-attacker`;
        operation.id = replacementId;
        rehashNestedControl(operation, "sha256");
        ticketRecord.operationId = replacementId;
        const definition = authority.definition as unknown as Record<string, unknown>;
        definition.operation_registry_id = replacementId;
        rehashNestedControl(definition, "definition_sha256");
        const bindings = [
          ticketRecord.executionPolicyBinding!,
          ...ticketRecord.steps.map((step) => step.executionPolicyBinding!),
        ];
        for (const rawBinding of bindings) {
          const binding = rawBinding as unknown as Record<string, unknown>;
          binding.operationId = replacementId;
          binding.operationSha256 = operation.sha256;
          rehashNestedControl(binding, "sha256");
        }
      },
    },
    {
      name: "workflow",
      reproject: false,
      mutate: (_run, _ticket, authority) => {
        const workflowRecord = authority.workflow as unknown as Record<string, unknown>;
        workflowRecord.version = "999.0.0";
        rehashNestedControl(workflowRecord, "sha256");
      },
    },
    {
      name: "ticket binding",
      mutate: (_run, ticketRecord) => {
        const binding = ticketRecord.executionPolicyBinding! as unknown as Record<string, unknown>;
        binding.publicOperation = `${String(binding.publicOperation)}-attacker`;
        rehashNestedControl(binding, "sha256");
      },
    },
    {
      name: "title",
      mutate: (_run, ticketRecord) => {
        ticketRecord.title = `${ticketRecord.title} attacker`;
      },
    },
    {
      name: "summary",
      mutate: (_run, ticketRecord) => {
        ticketRecord.summary = `${ticketRecord.summary} attacker`;
      },
    },
    {
      name: "persona",
      mutate: (_run, ticketRecord) => {
        ticketRecord.steps[0]!.personaId = "attacker";
      },
    },
    {
      name: "step order",
      mutate: (_run, ticketRecord) => {
        ticketRecord.steps.reverse();
      },
    },
    {
      name: "step identity",
      mutate: (_run, ticketRecord, authority) => {
        const priorId = ticketRecord.steps[0]!.id;
        const replacementId = `${priorId}-attacker`;
        ticketRecord.steps[0]!.id = replacementId;
        for (const step of ticketRecord.steps) {
          step.dependsOn = (step.dependsOn ?? []).map((dependency) =>
            dependency === priorId ? replacementId : dependency,
          );
        }

        const definition = authority.definition as unknown as Record<string, unknown>;
        const definitionSteps = definition.workflow as Array<Record<string, unknown>>;
        definitionSteps[0]!.id = replacementId;
        for (const step of definitionSteps) {
          step.depends_on = (step.depends_on as string[]).map((dependency) =>
            dependency === priorId ? replacementId : dependency,
          );
        }
        rehashNestedControl(definition, "definition_sha256");

        const workflowRecord = authority.workflow as unknown as Record<string, unknown>;
        const semanticSteps = workflowRecord.steps as Array<Record<string, unknown>>;
        semanticSteps[0]!.id = replacementId;
        rehashNestedControl(semanticSteps[0]!, "sha256");
        rehashNestedControl(workflowRecord, "sha256");

        const ticketBinding = ticketRecord.executionPolicyBinding! as unknown as Record<
          string,
          unknown
        >;
        ticketBinding.workflowSha256 = workflowRecord.sha256;
        rehashNestedControl(ticketBinding, "sha256");
        for (const [index, step] of ticketRecord.steps.entries()) {
          const binding = step.executionPolicyBinding! as unknown as Record<string, unknown>;
          binding.workflowSha256 = workflowRecord.sha256;
          if (index === 0) {
            binding.stepId = replacementId;
            binding.stepSha256 = semanticSteps[0]!.sha256;
          }
          rehashNestedControl(binding, "sha256");
        }
      },
    },
    {
      name: "step dependency",
      mutate: (_run, ticketRecord) => {
        ticketRecord.steps[1]!.dependsOn = [];
      },
    },
    {
      name: "step binding",
      mutate: (_run, ticketRecord) => {
        const binding = ticketRecord.steps[0]!.executionPolicyBinding! as unknown as Record<
          string,
          unknown
        >;
        binding.stepId = ticketRecord.steps[1]!.id;
        rehashNestedControl(binding, "sha256");
      },
    },
    {
      name: "read node scope",
      mutate: (_run, ticketRecord) => {
        ticketRecord.readNodeIds = [...(ticketRecord.readNodeIds ?? []), "claim-attacker"].sort();
      },
    },
    {
      name: "write node scope",
      mutate: (_run, ticketRecord) => {
        ticketRecord.writeNodeIds = [...(ticketRecord.writeNodeIds ?? []), "claim-attacker"].sort();
      },
    },
    {
      name: "read path scope",
      mutate: (_run, ticketRecord) => {
        ticketRecord.readPaths = [...ticketRecord.readPaths, "attacker/read.ts"].sort();
      },
    },
    {
      name: "write path scope",
      mutate: (_run, ticketRecord) => {
        ticketRecord.writePaths = [...ticketRecord.writePaths, "attacker/write.ts"].sort();
      },
    },
    {
      name: "validation action",
      mutate: (_run, ticketRecord) => {
        ticketRecord.steps[0]!.validationAction = "attacker-check";
      },
    },
    {
      name: "priority",
      mutate: (_run, ticketRecord) => {
        ticketRecord.priority += 1;
      },
    },
    {
      name: "ticket dependency",
      mutate: (_run, ticketRecord) => {
        ticketRecord.dependencyIds = [...ticketRecord.dependencyIds, "ticket-attacker"].sort();
      },
    },
    {
      name: "target",
      mutate: (_run, ticketRecord) => {
        ticketRecord.targetNodeIds = [...ticketRecord.targetNodeIds, "claim-attacker"].sort();
      },
    },
    {
      name: "control link",
      mutate: (_run, ticketRecord, authority) => {
        const control = ticketRecord.executionControl!;
        if (authority.role === "proposal")
          control.proposalRequest!.sourceTicketId = "source-attacker";
        else if (authority.role === "approved_application") {
          control.sourceProposalTicketId = "proposal-attacker";
        } else control.terminalRecovery!.sourceTicketId = "source-attacker";
      },
    },
    {
      name: "control scope",
      mutate: (_run, ticketRecord) => {
        ticketRecord.executionControl!.changeControlScopeNodeIds = [
          ...(ticketRecord.executionControl!.changeControlScopeNodeIds ?? []),
          "claim-attacker",
        ].sort();
      },
    },
    {
      name: "review configuration",
      mutate: (_run, ticketRecord) => {
        ticketRecord.reviewReworkLimit = (ticketRecord.reviewReworkLimit ?? 1) + 1;
      },
    },
    {
      name: "causal preimage",
      reproject: false,
      mutate: (_run, _ticket, authority) => {
        const causal = authority.causal;
        if (causal.role === "proposal") {
          const publication = causal.publication as unknown as Record<string, unknown>;
          publication.summary = `${String(publication.summary)} attacker`;
          rehashNestedControl(publication, "sha256");
        } else if (causal.role === "approved_application") {
          (causal as unknown as Record<string, unknown>).proposalTicketAuthoritySha256 =
            digest("attacker-proposal");
        } else {
          const reconciliation = causal.reconciliation as unknown as Record<string, unknown>;
          reconciliation.sourceTicketId = "source-attacker";
          rehashNestedControl(reconciliation, "sha256");
        }
      },
    },
  ];
}

function reprojectControlAuthority(ticketRecord: TicketRecord): void {
  const authority = ticketRecord.executionControl!.controlTicketAuthority!;
  const projection = ticketImmutableProjection(ticketRecord);
  (authority as unknown as Record<string, unknown>).projection = projection;
  (authority as unknown as Record<string, unknown>).projectionSha256 = projection.sha256;
  rehashControlAuthority(authority);
}

function rehashControlAuthority(authority: CompilerControlTicketAuthority): void {
  rehashNestedControl(authority as unknown as Record<string, unknown>, "sha256");
}

function rehashNestedControl(value: Record<string, unknown>, field: string): void {
  const material = { ...value };
  delete material[field];
  value[field] = canonicalHash(material);
}

function proposalDecision(
  run: Readonly<RunRecord>,
  proposalTicketId: string,
  decision: "approval" | "rejection",
  message: string,
): ProposalDecisionEvent {
  const requestSha256 =
    run.tickets[proposalTicketId]!.executionControl!.proposalRequest!.requestSha256;
  return rehashDecision({
    protocol: "koni.proposal-decision-authority.v2",
    runId: run.id,
    proposalTicketId,
    requestSha256,
    eventId: `decision-${proposalTicketId}`,
    decision,
    actor: "operator",
    recordedAt: "2026-07-18T00:01:00.000Z",
    message,
    sha256: digest("placeholder"),
  });
}

function rehashDecision(
  event: Omit<ProposalDecisionEvent, "sha256"> & { sha256?: Sha256Digest; actor: string },
): ProposalDecisionEvent {
  const { sha256: _ignored, ...material } = event;
  return { ...material, sha256: canonicalHash(material) };
}

function applyDecision(ticket: TicketRecord, event: ProposalDecisionEvent): void {
  ticket.executionControl!.proposalDecision = event;
  ticket.executionControl!.proposalDecisionHistory = [event];
  if (event.decision === "approval") {
    ticket.executionControl!.proposalApprovalSha256 = event.sha256;
    ticket.executionControl!.proposalDisposition = {
      kind: "approved",
      authoritySha256: event.sha256,
    };
  } else {
    ticket.executionControl!.proposalDisposition = {
      kind: "rejected",
      authoritySha256: event.sha256,
    };
    ticket.status = "completed";
    for (const step of ticket.steps) {
      step.status = "skipped";
      step.completedAt = event.recordedAt;
    }
  }
}

async function overwriteRun(fixture: ProposalFixture, run: unknown): Promise<void> {
  await writeFile(
    path.join(fixture.stateRoot, "runs", fixture.run.id, "run.json"),
    encodeTestJson(run),
  );
}

/** Install one synthetic semantic predecessor together with its local test trust-root anchor. */
async function overwriteRunAndTrust(fixture: ProposalFixture, run: unknown): Promise<void> {
  const bytes = encodeTestJson(run);
  await writeFile(path.join(fixture.stateRoot, "runs", fixture.run.id, "run.json"), bytes);
  const stateFile = path.join(fixture.stateRoot, "authority", "state.json");
  const state = JSON.parse(await readFile(stateFile, "utf8")) as {
    runRecordSha256?: Record<string, Sha256Digest>;
  };
  state.runRecordSha256 ??= {};
  state.runRecordSha256[fixture.run.id] = rawSha256(bytes);
  await writeFile(stateFile, encodeTestJson(state));
}

/** Reconstruct a genuine project state from before run-byte anchors existed. */
async function overwritePreAnchorRun(fixture: ProposalFixture, run: unknown): Promise<void> {
  await overwriteRun(fixture, run);
  const stateFile = path.join(fixture.stateRoot, "authority", "state.json");
  const state = JSON.parse(await readFile(stateFile, "utf8")) as Record<string, unknown>;
  delete state.runRecordSha256;
  await writeFile(stateFile, encodeTestJson(state));
}

function encodeTestJson(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function digest(label: string): Sha256Digest {
  return rawSha256(label);
}
