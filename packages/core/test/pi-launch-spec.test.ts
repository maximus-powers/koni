import { describe, expect, it } from "vitest";
import { rawSha256 } from "../src/shared/canonical.js";
import {
  type AgentLaunchSpecError,
  createAgentLaunchSpec,
  validateAgentAttemptLineageForest,
  validateAgentLaunchSpec,
  type AgentAttemptLineageBinding,
} from "../src/pi/launch-spec.js";
import { fixtureLaunchSpec, fixtureResource } from "./pi-managed-fixtures.js";

describe("immutable AgentLaunchSpec", () => {
  it("hashes every authority, model, budget, terminal, and resource binding", () => {
    const resource = fixtureResource(
      "context",
      "ticket-context",
      "context/ticket.md",
      "bound context",
    );
    const spec = fixtureLaunchSpec({
      cwd: "/tmp/koni-workspace",
      sessionDirectory: "/tmp/koni-sessions/attempt-one",
      resources: [resource],
    });
    expect(Object.isFrozen(spec)).toBe(true);
    expect(Object.isFrozen(spec.identity)).toBe(true);
    expect(Object.isFrozen(spec.lineage)).toBe(true);
    expect(Object.isFrozen(spec.resources.entries)).toBe(true);
    expect(validateAgentLaunchSpec(structuredClone(spec))).toEqual(spec);

    const drifted = structuredClone(spec);
    drifted.model.id = "different-model";
    expect(() => validateAgentLaunchSpec(drifted)).toThrowError(
      expect.objectContaining<Partial<AgentLaunchSpecError>>({
        code: "spec_hash",
        path: "/specHash",
      }),
    );
  });

  it("requires an authenticated catalog seal and full Codex provider exposure headroom", () => {
    const valid = fixtureLaunchSpec({
      cwd: "/tmp/koni-workspace",
      sessionDirectory: "/tmp/koni-sessions/attempt-one",
    });
    const { specHash: _hash, ...shortReservation } = structuredClone(valid);
    shortReservation.budgets.tokens.providerOutputHeadroom -= 1;
    expect(() => createAgentLaunchSpec(shortReservation)).toThrowError(
      expect.objectContaining<Partial<AgentLaunchSpecError>>({
        code: "token_budget",
        path: "/budgets/tokens/providerOutputHeadroom",
      }),
    );

    const { specHash: _hash2, ...invalidCatalog } = structuredClone(valid);
    invalidCatalog.model.catalogSha256 = "sha256:not-a-digest";
    expect(() => createAgentLaunchSpec(invalidCatalog)).toThrowError(
      expect.objectContaining<Partial<AgentLaunchSpecError>>({
        code: "digest",
        path: "/model/catalogSha256",
      }),
    );
  });

  it("rejects provider retries so one reservation authorizes one transport", () => {
    const valid = fixtureLaunchSpec({
      cwd: "/tmp/koni-workspace",
      sessionDirectory: "/tmp/koni-sessions/attempt-one",
    });
    const { specHash: _hash, ...retrying } = structuredClone(valid);
    retrying.budgets.retries.maxProviderRetries = 1;
    expect(() => createAgentLaunchSpec(retrying)).toThrowError(
      expect.objectContaining<Partial<AgentLaunchSpecError>>({
        code: "provider_retry_policy",
        path: "/budgets/retries/maxProviderRetries",
      }),
    );
  });

  it("rejects resource content drift and terminal tools outside the allowlist", () => {
    const valid = fixtureLaunchSpec({
      cwd: "/tmp/koni-workspace",
      sessionDirectory: "/tmp/koni-sessions/attempt-one",
    });
    const { specHash: _, ...draft } = structuredClone(valid);
    draft.resources.entries = [
      {
        kind: "context",
        id: "ticket-context",
        relativePath: "context/ticket.md",
        content: "changed bytes",
        sha256: rawSha256("different bytes"),
        sizeBytes: 13,
      },
    ];
    expect(() => createAgentLaunchSpec(draft)).toThrowError(
      expect.objectContaining<Partial<AgentLaunchSpecError>>({ code: "content_hash" }),
    );

    const invalidTerminal = structuredClone(draft);
    invalidTerminal.resources.entries = [];
    invalidTerminal.resources.setHash = valid.resources.setHash;
    invalidTerminal.terminal.toolName = "ambient_bash";
    expect(() => createAgentLaunchSpec(invalidTerminal)).toThrowError(
      expect.objectContaining<Partial<AgentLaunchSpecError>>({ code: "terminal_tool" }),
    );

    const { specHash: _hash, ...parallelTerminal } = structuredClone(valid);
    parallelTerminal.tools[0]!.executionMode = "parallel";
    expect(() => createAgentLaunchSpec(parallelTerminal)).toThrowError(
      expect.objectContaining<Partial<AgentLaunchSpecError>>({ code: "terminal_tool" }),
    );
  });

  it("rejects unsafe resource paths before anything is materialized", () => {
    const valid = fixtureLaunchSpec({
      cwd: "/tmp/koni-workspace",
      sessionDirectory: "/tmp/koni-sessions/attempt-one",
    });
    const { specHash: _, ...draft } = structuredClone(valid);
    const content = "unsafe";
    draft.resources.entries = [
      {
        kind: "skill",
        id: "unsafe-skill",
        relativePath: "../SKILL.md",
        content,
        sha256: rawSha256(content),
        sizeBytes: Buffer.byteLength(content),
      },
    ];
    expect(() => createAgentLaunchSpec(draft)).toThrowError(
      expect.objectContaining<Partial<AgentLaunchSpecError>>({ code: "relative_path" }),
    );
  });

  it("accepts Pi model identifiers with namespaces and rejects non-canonical workspace paths", () => {
    const valid = fixtureLaunchSpec({
      cwd: "/tmp/koni-workspace",
      sessionDirectory: "/tmp/koni-sessions/attempt-one",
    });
    const { specHash: _, ...draft } = structuredClone(valid);
    draft.model.id = "provider/model-family:model";
    expect(createAgentLaunchSpec(draft).model.id).toBe("provider/model-family:model");

    draft.workspace.cwd = "/tmp/koni-workspace/../koni-workspace";
    expect(() => createAgentLaunchSpec(draft)).toThrowError(
      expect.objectContaining<Partial<AgentLaunchSpecError>>({ code: "absolute_path" }),
    );
  });

  it("hash-binds an authenticated same-scope Pi conversation fork", () => {
    const branched = fixtureLaunchSpec({
      cwd: "/tmp/koni-workspace",
      sessionDirectory: "/tmp/koni-sessions/attempt-rework",
      attemptId: "attempt-rework",
      sessionId: "session-rework",
      lineage: {
        branchEpoch: 2,
        reason: "rework",
        parentAttemptId: "attempt-worker",
        parentSessionId: "session-worker",
        parentEntryId: "2a32e686-9c65-4b58-a0aa-1641cfb1796f",
        conversationFork: {
          parentLaunchSpecHash: rawSha256("parent launch"),
          parentTranscriptSha256: rawSha256("parent transcript"),
        },
      },
    });
    expect(branched.lineage).toEqual(
      expect.objectContaining({
        branchEpoch: 2,
        reason: "rework",
        parentAttemptId: "attempt-worker",
        parentSessionId: "session-worker",
        conversationFork: branched.lineage.conversationFork,
      }),
    );

    const { specHash: _hash, ...unpaired } = structuredClone(branched);
    delete unpaired.lineage.parentSessionId;
    expect(() => createAgentLaunchSpec(unpaired)).toThrowError(
      expect.objectContaining<Partial<AgentLaunchSpecError>>({ code: "lineage_parent" }),
    );
  });

  it("authenticates a later planning revision without a conversation fork", () => {
    const original = fixtureLaunchSpec({
      cwd: "/tmp/koni-workspace",
      sessionDirectory: "/tmp/koni-sessions/attempt-plan",
      ticketId: "run-planning",
      stepId: "planning",
      attemptId: "attempt-plan",
      sessionId: "session-plan",
      lineage: { branchEpoch: 0, reason: "initial" },
    });
    const { specHash: _hash, ...draft } = structuredClone(original);
    const spec = createAgentLaunchSpec({
      ...draft,
      planningRevision: {
        revision: 1,
        baseRevision: 0,
        priorCheckpointSha256: rawSha256("planning-checkpoint-0"),
        steeringSha256: rawSha256("planning-steering-1"),
        budgetBaseline: {
          inputTokens: 80_000,
          outputTokens: 10_000,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      },
    });

    expect(validateAgentLaunchSpec(structuredClone(spec)).identity.attemptId).toBe("attempt-plan");
    expect(spec.identity.sessionId).toBe("session-plan");
    expect(spec.lineage.conversationFork).toBeUndefined();
    expect(spec.planningRevision).toMatchObject({ revision: 1, baseRevision: 0 });
  });

  it.each([
    [
      "missing prior checkpoint",
      {
        revision: 1,
        baseRevision: 0,
        priorCheckpointSha256: null,
        steeringSha256: rawSha256("planning-steering-1"),
      },
    ],
    [
      "noncontiguous base revision",
      {
        revision: 2,
        baseRevision: 0,
        priorCheckpointSha256: rawSha256("planning-checkpoint-0"),
        steeringSha256: rawSha256("planning-steering-2"),
      },
    ],
    [
      "missing steering hash",
      {
        revision: 1,
        baseRevision: 0,
        priorCheckpointSha256: rawSha256("planning-checkpoint-0"),
        steeringSha256: null,
      },
    ],
  ])("rejects a planning revision with %s", (_label, revision) => {
    const original = fixtureLaunchSpec({
      cwd: "/tmp/koni-workspace",
      sessionDirectory: "/tmp/koni-sessions/attempt-plan",
      ticketId: "run-planning",
      stepId: "planning",
      attemptId: "attempt-plan",
      sessionId: "session-plan",
      lineage: { branchEpoch: 0, reason: "initial" },
    });
    const { specHash: _hash, ...draft } = structuredClone(original);
    expect(() =>
      createAgentLaunchSpec({
        ...draft,
        planningRevision: {
          ...revision,
          budgetBaseline: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        },
      }),
    ).toThrowError(
      expect.objectContaining<Partial<AgentLaunchSpecError>>({ code: "planning_revision" }),
    );
  });

  it("rejects a planning revision binding on a forked or non-planning launch", () => {
    const forked = fixtureLaunchSpec({
      cwd: "/tmp/koni-workspace",
      sessionDirectory: "/tmp/koni-sessions/attempt-plan",
      ticketId: "run-planning",
      stepId: "planning",
      attemptId: "attempt-plan",
      sessionId: "session-plan",
      lineage: {
        branchEpoch: 1,
        reason: "rework",
        parentAttemptId: "attempt-parent",
        parentSessionId: "session-parent",
        parentEntryId: "entry-parent",
        conversationFork: {
          parentLaunchSpecHash: rawSha256("parent launch"),
          parentTranscriptSha256: rawSha256("parent transcript"),
        },
      },
    });
    const { specHash: _hash, ...forkedDraft } = structuredClone(forked);
    const planningRevision = {
      revision: 1,
      baseRevision: 0,
      priorCheckpointSha256: rawSha256("planning-checkpoint-0"),
      steeringSha256: rawSha256("planning-steering-1"),
      budgetBaseline: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    };
    expect(() => createAgentLaunchSpec({ ...forkedDraft, planningRevision })).toThrowError(
      expect.objectContaining<Partial<AgentLaunchSpecError>>({ code: "planning_revision" }),
    );

    const ordinary = fixtureLaunchSpec({
      cwd: "/tmp/koni-workspace",
      sessionDirectory: "/tmp/koni-sessions/attempt-ticket",
      ticketId: "ticket-one",
    });
    const { specHash: _ordinaryHash, ...ordinaryDraft } = structuredClone(ordinary);
    expect(() => createAgentLaunchSpec({ ...ordinaryDraft, planningRevision })).toThrowError(
      expect.objectContaining<Partial<AgentLaunchSpecError>>({ code: "planning_revision" }),
    );
  });

  it("validates fresh review roots and an authenticated same-scope conversation fork", () => {
    const parentLaunchSpecHash = rawSha256("worker launch");
    const parentTranscriptSha256 = rawSha256("worker transcript");
    const roots: AgentAttemptLineageBinding[] = [
      lineageBinding("attempt-plan", "session-plan", 0, "initial"),
      lineageBinding("attempt-worker", "session-worker", 0, "initial", {
        ticketId: "ticket-worker",
        stepId: "implement",
        sessionLeafEntryId: "entry-worker-final",
        launchSpecHash: parentLaunchSpecHash,
        sessionSnapshotSha256: parentTranscriptSha256,
      }),
    ];
    const values = [
      ...roots,
      lineageBinding("attempt-plan-rework", "session-plan-rework", 1, "rework", {
        parentAttemptId: "attempt-plan",
        parentSessionId: "session-plan",
      }),
      lineageBinding("attempt-worker-rework", "session-worker-rework", 1, "rework", {
        ticketId: "ticket-worker",
        stepId: "implement",
        parentAttemptId: "attempt-worker",
        parentSessionId: "session-worker",
        parentEntryId: "entry-worker-final",
        conversationFork: { parentLaunchSpecHash, parentTranscriptSha256 },
      }),
      lineageBinding("attempt-review", "session-review", 1, "review", {
        ticketId: "ticket-worker",
        stepId: "review",
        parentAttemptId: "attempt-worker",
        parentSessionId: "session-worker",
        parentEntryId: "entry-worker-final",
      }),
    ];

    expect(() => validateAgentAttemptLineageForest(values)).not.toThrow();
  });

  it.each([
    [
      "lineage_parent_entry_unverified",
      [
        lineageBinding("attempt-root", "session-root", 0, "initial"),
        lineageBinding("attempt-review", "session-review", 1, "review", {
          parentAttemptId: "attempt-root",
          parentSessionId: "session-root",
          parentEntryId: "entry-root-final",
        }),
      ],
    ],
    [
      "lineage_parent_entry",
      [
        lineageBinding("attempt-root", "session-root", 0, "initial", {
          sessionLeafEntryId: "entry-root-final",
        }),
        lineageBinding("attempt-review", "session-review", 1, "review", {
          parentAttemptId: "attempt-root",
          parentSessionId: "session-root",
          parentEntryId: "entry-root-earlier",
        }),
      ],
    ],
  ] satisfies readonly [string, AgentAttemptLineageBinding[]][])(
    "rejects an unauthenticated parent transcript anchor with %s",
    (code, values) => {
      expect(() => validateAgentAttemptLineageForest(values)).toThrowError(
        expect.objectContaining<Partial<AgentLaunchSpecError>>({ code }),
      );
    },
  );

  it.each([
    [
      "lineage_parent_missing",
      [
        lineageBinding("attempt-retry", "session-retry", 1, "retry", {
          parentAttemptId: "attempt-missing",
          parentSessionId: "session-missing",
        }),
      ],
    ],
    [
      "lineage_parent_session",
      [
        lineageBinding("attempt-root", "session-root", 0, "initial"),
        lineageBinding("attempt-retry", "session-retry", 1, "retry", {
          parentAttemptId: "attempt-root",
          parentSessionId: "session-wrong",
        }),
      ],
    ],
    [
      "lineage_epoch_sequence",
      [
        lineageBinding("attempt-root", "session-root", 0, "initial"),
        lineageBinding("attempt-retry", "session-retry", 2, "retry", {
          parentAttemptId: "attempt-root",
          parentSessionId: "session-root",
        }),
      ],
    ],
    [
      "lineage_duplicate_session",
      [
        lineageBinding("attempt-one", "session-shared", 0, "initial"),
        lineageBinding("attempt-two", "session-shared", 0, "initial"),
      ],
    ],
    [
      "lineage_parent_scope",
      [
        lineageBinding("attempt-worker", "session-worker", 0, "initial", {
          ticketId: "ticket-worker",
          stepId: "implement",
        }),
        lineageBinding("attempt-review", "session-review", 1, "review", {
          ticketId: "ticket-other",
          stepId: "review",
          parentAttemptId: "attempt-worker",
          parentSessionId: "session-worker",
        }),
      ],
    ],
    [
      "lineage_cycle",
      [
        lineageBinding("attempt-a", "session-a", 1, "retry", {
          parentAttemptId: "attempt-b",
          parentSessionId: "session-b",
        }),
        lineageBinding("attempt-b", "session-b", 2, "recovery", {
          parentAttemptId: "attempt-a",
          parentSessionId: "session-a",
        }),
      ],
    ],
  ] satisfies readonly [string, AgentAttemptLineageBinding[]][])(
    "rejects invalid cross-attempt lineage with %s",
    (code, values) => {
      expect(() => validateAgentAttemptLineageForest(values)).toThrowError(
        expect.objectContaining<Partial<AgentLaunchSpecError>>({ code }),
      );
    },
  );

  it("rejects a missing lineage with a typed launch-spec error", () => {
    const valid = fixtureLaunchSpec({
      cwd: "/tmp/koni-workspace",
      sessionDirectory: "/tmp/koni-sessions/attempt-one",
    });
    const { specHash: _hash, lineage: _lineage, ...missingLineage } = structuredClone(valid);
    expect(() => createAgentLaunchSpec(missingLineage as never)).toThrowError(
      expect.objectContaining<Partial<AgentLaunchSpecError>>({ code: "lineage", path: "/lineage" }),
    );
  });

  it("requires a bounded attempt transcript budget", () => {
    const valid = fixtureLaunchSpec({
      cwd: "/tmp/koni-workspace",
      sessionDirectory: "/tmp/koni-sessions/attempt-one",
    });
    const { specHash: _hash, ...draft } = structuredClone(valid);
    draft.budgets.transcript.maxBytes = 1024;
    expect(() => createAgentLaunchSpec(draft)).toThrowError(
      expect.objectContaining<Partial<AgentLaunchSpecError>>({
        code: "transcript_budget",
        path: "/budgets/transcript/maxBytes",
      }),
    );
  });

  it("hash-binds a positive repository-call budget when the compiler issues one", () => {
    const valid = fixtureLaunchSpec({
      cwd: "/tmp/koni-workspace",
      sessionDirectory: "/tmp/koni-sessions/attempt-one",
    });
    const { specHash: _hash, ...draft } = structuredClone(valid);
    draft.budgets.repositoryCalls = { max: 16 };
    const bounded = createAgentLaunchSpec(draft);
    expect(bounded.budgets.repositoryCalls).toEqual({ max: 16 });

    const { specHash: _boundedHash, ...invalid } = structuredClone(bounded);
    invalid.budgets.repositoryCalls = { max: 0 };
    expect(() => createAgentLaunchSpec(invalid)).toThrowError(
      expect.objectContaining<Partial<AgentLaunchSpecError>>({
        code: "integer",
        path: "/budgets/repositoryCalls/max",
      }),
    );
  });

  it("hash-binds a bounded worst-case result size for every authority tool", () => {
    const valid = fixtureLaunchSpec({
      cwd: "/tmp/koni-workspace",
      sessionDirectory: "/tmp/koni-sessions/attempt-one",
    });
    const { specHash: _hash, ...draft } = structuredClone(valid);
    draft.tools[0]!.maxResultBytes = 1024;
    expect(() => createAgentLaunchSpec(draft)).toThrowError(
      expect.objectContaining<Partial<AgentLaunchSpecError>>({
        code: "tool_result_budget",
        path: "/tools/0/maxResultBytes",
      }),
    );
  });
});

function lineageBinding(
  attemptId: string,
  sessionId: string,
  branchEpoch: number,
  reason: AgentAttemptLineageBinding["lineage"]["reason"],
  overrides: Partial<AgentAttemptLineageBinding> &
    Partial<AgentAttemptLineageBinding["lineage"]> = {},
): AgentAttemptLineageBinding {
  return {
    runId: overrides.runId ?? "run-one",
    ticketId: overrides.ticketId ?? "run-planning",
    stepId: overrides.stepId ?? "plan",
    attemptId,
    sessionId,
    ...(overrides.sessionLeafEntryId === undefined
      ? {}
      : { sessionLeafEntryId: overrides.sessionLeafEntryId }),
    ...(overrides.launchSpecHash === undefined ? {} : { launchSpecHash: overrides.launchSpecHash }),
    ...(overrides.sessionSnapshotSha256 === undefined
      ? {}
      : { sessionSnapshotSha256: overrides.sessionSnapshotSha256 }),
    lineage: {
      branchEpoch,
      reason,
      ...(overrides.parentAttemptId === undefined
        ? {}
        : { parentAttemptId: overrides.parentAttemptId }),
      ...(overrides.parentSessionId === undefined
        ? {}
        : { parentSessionId: overrides.parentSessionId }),
      ...(overrides.parentEntryId === undefined ? {} : { parentEntryId: overrides.parentEntryId }),
      ...(overrides.conversationFork === undefined
        ? {}
        : { conversationFork: overrides.conversationFork }),
    },
  };
}
