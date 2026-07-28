import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { CompactMonitorWidget, RunsOverlayComponent } from "../src/monitor/component.js";
import type { MonitorController, MonitorControllerSnapshot } from "../src/monitor/controller.js";
import { parseMonitorAttention, parseMonitorSnapshot } from "../src/monitor/protocol.js";
import { plainMonitorPalette } from "../src/monitor/presentation.js";
import {
  monitorAttentionFixture,
  monitorProposalFixture,
  monitorSnapshotFixture,
} from "./fixtures/monitor-fixtures.js";

describe("compact Pi companion components", () => {
  it("renders stable stopped, no-runs, narrow, and populated widget frames", () => {
    const fake = new FakeComponentController(stoppedSnapshot());
    const widget = new CompactMonitorWidget({
      controller: fake as unknown as MonitorController,
      palette: plainMonitorPalette,
    });
    expect(widget.render(42).join("\n")).toContain("Koni · stopped · /koni-run");

    fake.publish({
      ...stoppedSnapshot(),
      connection: "connected",
      monitor: {
        ...parseMonitorSnapshot({ ...monitorSnapshotFixture(), totalRuns: 0, runs: [] }),
      },
    });
    expect(widget.render(42).join("\n")).toContain("Koni · no runs · /koni-run");

    fake.publish(activeSnapshot());
    const narrow = widget.render(28);
    const wide = widget.render(112);
    expect(narrow).toHaveLength(1);
    expect(wide).toHaveLength(2);
    expect(wide.join("\n")).toContain("1.5K new tks");
    expect(wide.join("\n")).not.toContain("9.5K tks");
    expect(wide.join("\n")).toContain("Q1 P1");
    expect(
      [...narrow, ...wide].every((line, index) => visibleWidth(line) <= (index === 0 ? 28 : 112)),
    ).toBe(true);
    widget.dispose();
  });

  it("shows wrapped options, None of these, optional notes, and an explicit Send action", () => {
    const fake = new FakeComponentController(activeSnapshot());
    const done = vi.fn();
    const component = new RunsOverlayComponent({
      controller: fake as unknown as MonitorController,
      done,
      palette: plainMonitorPalette,
      viewportRows: () => 34,
    });
    component.handleInput("\r");
    const frame = component.render(64).join("\n");
    expect(frame).toContain("Where should notes live?");
    expect(frame).toContain("Database");
    expect(frame).toContain("Persist notes in the project database.");
    expect(frame).toContain("None of the above");
    expect(frame).toContain("Notes");
    expect(frame).toContain("Send answer");
    expect(frame).not.toContain("question-a");
    expect(component.render(34).every((line) => visibleWidth(line) <= 34)).toBe(true);
    component.dispose();
  });

  it("moves between options, accepts multiline notes, and submits the selected question once", async () => {
    const fake = new FakeComponentController(activeSnapshot());
    const component = new RunsOverlayComponent({
      controller: fake as unknown as MonitorController,
      done: vi.fn(),
      palette: plainMonitorPalette,
      viewportRows: () => 24,
    });
    component.handleInput("\r");
    component.handleInput("\x1b[B");
    expect(component.mode).toMatchObject({ kind: "question", optionIndex: 1 });
    component.handleInput("\t");
    component.handleInput("Keep the existing notes");
    component.handleInput("\r");
    component.handleInput("visible during migration.");
    component.handleInput("\x1b[13;5u");
    await flushAsync();
    expect(fake.answerQuestion).toHaveBeenCalledOnce();
    expect(fake.answerQuestion).toHaveBeenCalledWith({
      runId: "run-a",
      questionId: "question-a",
      notes: "Keep the existing notes\nvisible during migration.",
    });
    expect(component.mode).toEqual({ kind: "runs" });
    component.dispose();
  });

  it("supports authored plan review, multiline revision, approval, Later, open-full, and Escape traces", async () => {
    const snapshot = activeSnapshot();
    snapshot.attentions = { "run-a": { ...snapshot.attentions["run-a"]!, questions: [] } };
    snapshot.monitor = {
      ...snapshot.monitor!,
      runs: snapshot.monitor!.runs.map((run) => ({ ...run, questionCount: 0 })),
    };
    const fake = new FakeComponentController(snapshot);

    const revise = new RunsOverlayComponent({
      controller: fake as unknown as MonitorController,
      done: vi.fn(),
      palette: plainMonitorPalette,
      viewportRows: () => 30,
    });
    revise.handleInput("\r");
    const initialPlan = revise.render(72).join("\n");
    expect(initialPlan).toContain("Stable boundary");
    expect(initialPlan).toContain("Approve");
    expect(initialPlan).not.toContain("Revise plan");
    revise.handleInput("\t");
    revise.handleInput("Keep old notes readable.");
    revise.handleInput("\r");
    revise.handleInput("Migrate in one transaction.");
    expect(revise.render(72).join("\n")).toContain("Revise plan");
    revise.handleInput("\x1b[13;5u");
    await flushAsync();
    expect(fake.revisePlan).toHaveBeenCalledWith(
      "run-a",
      "Keep old notes readable.\nMigrate in one transaction.",
    );
    revise.dispose();

    const approve = new RunsOverlayComponent({
      controller: fake as unknown as MonitorController,
      done: vi.fn(),
      palette: plainMonitorPalette,
    });
    approve.handleInput("\r");
    approve.handleInput("\t");
    approve.handleInput("\t");
    approve.handleInput("\r");
    await flushAsync();
    expect(fake.approvePlan).toHaveBeenCalledWith("run-a");
    approve.dispose();

    const opened = vi.fn();
    const navigation = new RunsOverlayComponent({
      controller: fake as unknown as MonitorController,
      done: opened,
      palette: plainMonitorPalette,
    });
    navigation.handleInput("o");
    expect(opened).toHaveBeenCalledWith({ kind: "open_full" });
    navigation.dispose();

    const closed = vi.fn();
    const escape = new RunsOverlayComponent({
      controller: fake as unknown as MonitorController,
      done: closed,
      palette: plainMonitorPalette,
    });
    escape.handleInput("\x1b");
    expect(closed).toHaveBeenCalledWith({ kind: "close" });
    escape.dispose();
  });

  it("renders proposal review without identities and requires an explicit recorded decision", async () => {
    const snapshot = activeSnapshot();
    snapshot.attentions = {
      "run-a": {
        ...snapshot.attentions["run-a"]!,
        questions: [],
        plan: undefined,
        proposals: [
          parseMonitorAttention({
            ...monitorAttentionFixture(),
            questions: [],
            plan: undefined,
            proposals: [monitorProposalFixture()],
          }).proposals[0]!,
        ],
      },
    };
    snapshot.monitor = {
      ...snapshot.monitor!,
      runs: snapshot.monitor!.runs.map((run) => ({
        ...run,
        questionCount: 0,
        planApproval: false,
        proposalCount: 1,
      })),
    };
    const fake = new FakeComponentController(snapshot);
    const component = new RunsOverlayComponent({
      controller: fake as unknown as MonitorController,
      done: vi.fn(),
      palette: plainMonitorPalette,
      viewportRows: () => 30,
    });

    component.handleInput("\r");
    const frame = component.render(70).join("\n");
    expect(frame).toContain("Revise the storage contract");
    expect(frame).toContain("Approve");
    expect(frame).toContain("Reject");
    expect(frame).toContain("Enter never decides");
    expect(frame).not.toContain("proposal-a");
    expect(frame).not.toContain("ticket-source");

    component.handleInput("\r");
    component.handleInput("Preserve the current API.");
    component.handleInput("\t");
    component.handleInput("\x1b[C");
    component.handleInput("\t");
    component.handleInput("\r");
    await flushAsync();
    expect(fake.decideProposal).not.toHaveBeenCalled();
    expect(component.render(70).join("\n")).toContain("Use Ctrl+Enter");

    component.handleInput("\x1b[13;5u");
    await flushAsync();
    expect(fake.decideProposal).toHaveBeenCalledOnce();
    expect(fake.decideProposal).toHaveBeenCalledWith({
      runId: "run-a",
      ticketId: "proposal-a",
      decision: "rejection",
      message: "Preserve the current API.",
    });
    component.dispose();
  });

  it("routes blocked recovery attention into the full compiler-authoritative control center", () => {
    const snapshot = activeSnapshot();
    snapshot.attentions = {
      "run-a": {
        ...snapshot.attentions["run-a"]!,
        questions: [],
        proposals: [],
        plan: undefined,
      },
    };
    snapshot.monitor = {
      ...snapshot.monitor!,
      runs: snapshot.monitor!.runs.map((run) => ({
        ...run,
        phase: "blocked" as const,
        questionCount: 0,
        proposalCount: 0,
        planApproval: false,
        blocker: "The configured terminal resolver needs an exact retry decision.",
      })),
    };
    const opened = vi.fn();
    const component = new RunsOverlayComponent({
      controller: new FakeComponentController(snapshot) as unknown as MonitorController,
      done: opened,
      palette: plainMonitorPalette,
    });

    component.handleInput("\r");

    expect(opened).toHaveBeenCalledOnce();
    expect(opened).toHaveBeenCalledWith({ kind: "open_full" });
    component.dispose();
  });

  it("keeps hostile ANSI/OSC, combining, CJK, and emoji content terminal-safe at narrow widths", () => {
    const raw = monitorSnapshotFixture();
    raw.runs[0].objectivePreview =
      "\u001b]0;pwned\u0007迁移 e\u0301 notes 🧪\u001b[31m red\u001b[0m";
    const snapshot = activeSnapshot();
    snapshot.monitor = parseMonitorSnapshot(raw);
    snapshot.selectedRunId = "run-a";
    const fake = new FakeComponentController(snapshot);
    const widget = new CompactMonitorWidget({
      controller: fake as unknown as MonitorController,
      palette: plainMonitorPalette,
    });
    const frame = widget.render(80);
    expect(frame.join("\n")).not.toContain("\u001b]0");
    expect(frame.join("\n")).toContain("迁移 é notes 🧪 red");
    expect(frame.every((line) => visibleWidth(line) <= 80)).toBe(true);
    widget.dispose();
  });
});

class FakeComponentController {
  public answerQuestion = vi.fn(async () => undefined);
  public approvePlan = vi.fn(async () => undefined);
  public revisePlan = vi.fn(async () => undefined);
  public decideProposal = vi.fn(async () => undefined);
  readonly #listeners = new Set<(snapshot: MonitorControllerSnapshot) => void>();
  #snapshot: MonitorControllerSnapshot;

  public constructor(snapshot: MonitorControllerSnapshot) {
    this.#snapshot = structuredClone(snapshot);
  }

  public get snapshot(): MonitorControllerSnapshot {
    return structuredClone(this.#snapshot);
  }

  public subscribe(listener: (snapshot: MonitorControllerSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public publish(snapshot: MonitorControllerSnapshot): void {
    this.#snapshot = structuredClone(snapshot);
    for (const listener of this.#listeners) listener(this.snapshot);
  }

  public moveSelection(delta: -1 | 1): void {
    const runs = this.#snapshot.monitor?.runs ?? [];
    if (runs.length === 0) return;
    const current = Math.max(
      0,
      runs.findIndex((run) => run.id === this.#snapshot.selectedRunId),
    );
    this.#snapshot.selectedRunId = runs[(current + delta + runs.length) % runs.length]!.id;
    this.publish(this.#snapshot);
  }
}

function stoppedSnapshot(): MonitorControllerSnapshot {
  return {
    eligibility: { trusted: true, initialized: true },
    connection: "stopped",
    monitor: undefined,
    attentions: {},
    selectedRunId: undefined,
    eventCursor: 0,
    recentEvents: [],
    lastError: undefined,
    busy: false,
  };
}

function activeSnapshot(): MonitorControllerSnapshot {
  const monitor = parseMonitorSnapshot(monitorSnapshotFixture());
  const attention = parseMonitorAttention(monitorAttentionFixture());
  return {
    eligibility: { trusted: true, initialized: true },
    connection: "connected",
    monitor: structuredClone(monitor),
    attentions: { "run-a": attention },
    selectedRunId: "run-a",
    eventCursor: monitor.eventCursor,
    recentEvents: [],
    lastError: undefined,
    busy: false,
  };
}

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
