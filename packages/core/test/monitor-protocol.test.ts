import { describe, expect, it } from "vitest";
import {
  MONITOR_EVENTS_PROTOCOL,
  parseMonitorAttention,
  parseMonitorEvents,
  parseMonitorSnapshot,
} from "../src/monitor/protocol.js";
import { terminalSafeLines, terminalSafeText } from "../src/monitor/terminal.js";
import { parseControlProposalInspection } from "../src/control-center/protocol.js";
import {
  monitorAttentionFixture,
  monitorProposalFixture,
  monitorSnapshotFixture,
} from "./fixtures/monitor-fixtures.js";

describe("monitor bounded protocols", () => {
  it("projects only bounded monitor fields and strips hostile terminal controls", () => {
    const value = monitorSnapshotFixture();
    (value.runs[0] as Record<string, unknown>).objectivePreview =
      "Notes\u001b]8;;https://evil.test\u0007 trap\u001b]8;;\u0007\n迁移 e\u0301 🧪";
    (value.runs[0] as Record<string, unknown>).transcript = "must not escape";
    (value.runs[0] as Record<string, unknown>).checks = [{ secret: true }];
    const snapshot = parseMonitorSnapshot(value);
    expect(snapshot.runs[0]?.objectivePreview).toBe("Notes trap 迁移 é 🧪");
    expect(snapshot.runs[0]).not.toHaveProperty("transcript");
    expect(snapshot.runs[0]).not.toHaveProperty("checks");
    expect(JSON.stringify(snapshot)).not.toContain("must not escape");
  });

  it("rejects inconsistent counts, totals, phases, and oversized pages", () => {
    const tokens = monitorSnapshotFixture();
    tokens.runs[0].tokens.total = 999;
    expect(() => parseMonitorSnapshot(tokens)).toThrow(/token totals/u);

    const deleted = monitorSnapshotFixture();
    deleted.runs[0].phase = "deleted";
    expect(() => parseMonitorSnapshot(deleted)).toThrow(/invalid phase/u);

    const tooMany = monitorSnapshotFixture();
    tooMany.runs = Array.from({ length: 201 }, () => monitorSnapshotFixture().runs[0]!);
    expect(() => parseMonitorSnapshot(tooMany)).toThrow(/exceeds 200/u);

    const preparingMerge = monitorSnapshotFixture();
    preparingMerge.runs[0].phase = "merge_ready";
    preparingMerge.runs[0].planApproval = false;
    preparingMerge.runs[0].questionCount = 0;
    preparingMerge.runs[0].mergeReady = false;
    expect(parseMonitorSnapshot(preparingMerge).runs[0]).toMatchObject({
      phase: "merge_ready",
      mergeReady: false,
    });
  });

  it("requires ordered event cursors and preserves semantic event types", () => {
    const events = parseMonitorEvents({
      protocol: MONITOR_EVENTS_PROTOCOL,
      fromCursor: 8,
      nextCursor: 10,
      truncated: false,
      events: [
        {
          sequence: 9,
          at: "2026-07-17T12:00:00.000Z",
          kind: "stage_changed",
          runId: "run-a",
          runRevision: 3,
          title: "Executing",
          detail: "Run entered execution",
          ticketId: null,
        },
        {
          sequence: 10,
          at: "2026-07-17T12:00:01.000Z",
          kind: "ticket_completed",
          runId: "run-a",
          runRevision: 4,
          title: "Notes form",
          detail: "Ticket completed",
          ticketId: "ticket-a",
        },
      ],
    });
    expect(events.events.map((event) => event.kind)).toEqual(["stage_changed", "ticket_completed"]);

    expect(() =>
      parseMonitorEvents({
        ...events,
        events: [events.events[1], events.events[0]],
      }),
    ).toThrow(/strictly ordered/u);
  });

  it("parses exact unanswered questions and all four authored concise plan sections", () => {
    const attention = parseMonitorAttention(monitorAttentionFixture());
    expect(attention.questions[0]).toMatchObject({
      prompt: "Where should notes live?",
      allowsNotes: true,
      options: [{ label: "Database", description: "Persist notes in the project database." }],
    });
    expect(Object.keys(attention.plan!.sections)).toEqual([
      "architecture",
      "decisions",
      "risk",
      "verification",
    ]);
    expect(attention.plan!.sections.architecture[0]).toEqual({
      title: "Stable boundary",
      description: "Keep note persistence behind the existing repository interface.",
    });
  });

  it("accepts only bounded actionable proposal attention from the same run", () => {
    const value = monitorAttentionFixture();
    value.proposals = [monitorProposalFixture()];
    const attention = parseMonitorAttention(value);
    expect(attention.proposals).toEqual([
      expect.objectContaining({
        ticketId: "proposal-a",
        status: "proposed",
        disposition: { kind: "pending" },
        targetNodeIds: ["claim-storage", "constraint-encryption"],
      }),
    ]);

    const crossRun = monitorAttentionFixture();
    crossRun.proposals = [{ ...monitorProposalFixture(), runId: "run-b" }];
    expect(() => parseMonitorAttention(crossRun)).toThrow(/cross-run/u);

    const resolved = monitorAttentionFixture();
    resolved.proposals = [
      {
        ...monitorProposalFixture(),
        status: "cancelled",
        decision: {
          decision: "rejection",
          authoritySha256: `sha256:${"a".repeat(64)}`,
          actor: "operator",
          decidedAt: "2026-07-17T12:00:00.000Z",
        },
        disposition: { kind: "rejected" },
      },
    ];
    expect(() => parseMonitorAttention(resolved)).toThrow(/non-actionable/u);

    const duplicate = monitorAttentionFixture();
    duplicate.proposals = [monitorProposalFixture(), monitorProposalFixture()];
    expect(() => parseMonitorAttention(duplicate)).toThrow(/duplicate proposals/u);
  });

  it("rejects invented proposal fields and inconsistent durable decisions", () => {
    expect(() =>
      parseControlProposalInspection({
        ...monitorProposalFixture(),
        actor: "operator",
      }),
    ).toThrow(/unsupported proposal inspection field/u);

    expect(() =>
      parseControlProposalInspection({
        ...monitorProposalFixture(),
        decision: {
          decision: "rejection",
          authoritySha256: `sha256:${"a".repeat(64)}`,
          actor: "operator",
          decidedAt: "2026-07-17T12:00:00.000Z",
        },
      }),
    ).toThrow(/rejected proposal decision/u);
  });

  it("bounds and wraps normalized Unicode without emitting control bytes", () => {
    const safe = terminalSafeText("A\u001b[31m red\u001b[0m\u202E\n界e\u0301🧪", {
      maxCodePoints: 20,
    });
    expect(safe).toBe("A red 界é🧪");
    const lines = terminalSafeLines("界界界界 and emoji 🧪🧪", 8, { maxLines: 5 });
    expect(lines.length).toBeGreaterThan(1);
    expect(
      lines.every((line) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(line)),
    ).toBe(true);
  });
});
