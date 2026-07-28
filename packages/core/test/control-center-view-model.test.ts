import { describe, expect, it } from "vitest";
import { buildControlCenterView, formatTokens } from "../src/control-center/view-model.js";
import { newRunLifecycle, reduceRunLifecycle } from "../src/state/run-lifecycle.js";
import type { RunRecord } from "../src/state/run-record.js";

describe("control center view model", () => {
  it("keeps Goal, Run, and Evidence together and labels cached token totals explicitly", () => {
    const run = fixtureRun();
    const view = buildControlCenterView({
      projectRoot: "/project",
      authorityRevision: 9,
      runs: [run],
      selection: { runId: run.id, detailsTab: "overview", objectiveExpanded: false },
      nowMs: 20_000,
    });
    expect(view.selectedRun?.overviewSections.map((section) => section.title)).toEqual([
      "Run",
      "Evidence",
    ]);
    expect(view.runs[0]).toMatchObject({ newTokens: "1.1K new tks", allTokens: "11.1K all" });
    expect(view.selectedRun?.header.allTokens).toBe("11.1K incl. cache");
    expect(view.selectedRun?.objective.preview.length).toBeLessThanOrEqual(4);
  });

  it("shows operator-retired provider exposure separately from exact token totals", () => {
    const run = fixtureRun();
    run.attempts["attempt-worker"]!.authorityProviderRequests = [
      {
        sequence: 1,
        reservationId: "provider-reservation-one",
        api: "openai-codex-responses",
        modelId: "gpt-5.6-terra",
        payloadSha256: `sha256:${"1".repeat(64)}`,
        payloadSizeBytes: 1_024,
        baselineEntryId: "baseline-entry",
        prospectiveInputTokens: 12_000,
        reservedOutputTokens: 8_000,
        reservedAt: "2026-07-16T00:00:03.000Z",
        retirement: {
          protocol: "koni.provider-exposure-retirement.v1",
          disposition: "operator_acknowledged_canonical_abort",
          assistantEntryId: "assistant-aborted",
          assistantEntrySha256: `sha256:${"2".repeat(64)}`,
          responseId: "resp_aborted",
          authorizationSha256: `sha256:${"3".repeat(64)}`,
          retiredAt: "2026-07-16T00:00:04.000Z",
          sha256: `sha256:${"4".repeat(64)}`,
        },
      },
    ];

    const view = viewFor(run);
    expect(view.runs[0]).toMatchObject({ newTokens: "1.1K new tks", allTokens: "11.1K all" });
    expect(
      view.selectedRun?.overviewSections.find((section) => section.title === "Run")?.lines,
    ).toContain("Uncertain exposure: ≤20K retired by operator");
  });

  it("keeps inactive Lead attempts visible and filters agents only when a ticket is selected", () => {
    const run = fixtureRun();
    const all = buildControlCenterView({
      projectRoot: "/project",
      authorityRevision: 9,
      runs: [run],
      selection: { runId: run.id, detailsTab: "overview", objectiveExpanded: false },
    });
    expect(all.selectedRun?.agents.map((agent) => agent.label)).toContain("Lead");
    expect(
      all.selectedRun?.agents.some((agent) => agent.label.startsWith("Implement feature ·")),
    ).toBe(true);

    const ticketOnly = buildControlCenterView({
      projectRoot: "/project",
      authorityRevision: 9,
      runs: [run],
      selection: {
        runId: run.id,
        ticketId: "ticket-one",
        detailsTab: "overview",
        objectiveExpanded: false,
      },
    });
    expect(ticketOnly.selectedRun?.agents).toHaveLength(1);
    expect(ticketOnly.selectedRun?.agents[0]?.label).toBe("Implementer");
  });

  it("keeps the orchestrating Lead visible even when the agents list is filtered to a ticket", () => {
    const run = fixtureRun();
    run.attempts["attempt-lead"]!.kind = "lead";
    const ticketOnly = buildControlCenterView({
      projectRoot: "/project",
      authorityRevision: 9,
      runs: [run],
      selection: {
        runId: run.id,
        ticketId: "ticket-one",
        detailsTab: "overview",
        objectiveExpanded: false,
      },
    });
    // Active-first ordering keeps the running worker on top; the Lead stays listed.
    expect(ticketOnly.selectedRun?.agents.map((agent) => agent.label)).toEqual([
      "Implementer",
      "Lead",
    ]);
  });

  it("nests lineage children under their parent attempt with increasing depth", () => {
    const run = fixtureRun();
    const view = buildControlCenterView({
      projectRoot: "/project",
      authorityRevision: 9,
      runs: [run],
      selection: { runId: run.id, detailsTab: "overview", objectiveExpanded: false },
      lineage: {
        protocol: "koni.run-attempt-lineage.v1",
        runId: run.id,
        runRevision: run.revision,
        attempts: [
          {
            attemptId: "attempt-lead",
            persona: "Lead",
            ticket: "Run planning",
            step: "Plan",
            status: "completed",
            reason: "initial",
            branchEpoch: 0,
            childAttemptIds: ["attempt-worker"],
            activeLeaf: false,
          },
          {
            attemptId: "attempt-worker",
            persona: "Implementer",
            ticket: "Implement feature",
            step: "Implement",
            status: "running",
            reason: "retry",
            branchEpoch: 1,
            parentAttemptId: "attempt-lead",
            childAttemptIds: [],
            activeLeaf: true,
          },
        ],
      },
    });
    expect(view.selectedRun?.agents.map((agent) => [agent.id, agent.depth])).toEqual([
      ["attempt-lead", 0],
      ["attempt-worker", 1],
    ]);
  });

  it("prefers the planner-authored run title and reports a scheduled pause", () => {
    const run = fixtureRun();
    run.plan!.title = "Note Storage Migration";
    run.pendingPause = { requestedAt: run.updatedAt };
    const row = viewFor(run).runs[0];
    expect(row?.title).toBe("Note Storage Migration");
    expect(row?.pausePending).toBe(true);

    const untitled = fixtureRun();
    expect(viewFor(untitled).runs[0]?.title).toBe(untitled.objective.split("\n")[0]);
  });

  it("animates run work only for attempts that can presently spend tokens", () => {
    const run = fixtureRun();
    run.attempts["attempt-worker"]!.status = "waiting_question";
    expect(viewFor(run).runs[0]?.activeAgentCount).toBe(0);

    run.attempts["attempt-worker"]!.status = "running";
    expect(viewFor(run).runs[0]?.activeAgentCount).toBe(1);
  });

  it("shows planning activity only while planning, then the approved human-readable plan", () => {
    const planning = fixtureRun();
    planning.plan = undefined;
    planning.lifecycle.phase = "planning";
    expect(
      buildControlCenterView({
        projectRoot: "/project",
        authorityRevision: 1,
        runs: [planning],
        selection: { detailsTab: "plan", objectiveExpanded: false },
      }).selectedRun?.plan.mode,
    ).toBe("activity");

    const approved = fixtureRun();
    approved.plan!.concise.architecture = [
      { title: "Stable seam", description: "Use the existing seam." },
    ];
    const plan = buildControlCenterView({
      projectRoot: "/project",
      authorityRevision: 1,
      runs: [approved],
      selection: { detailsTab: "plan", objectiveExpanded: false },
    }).selectedRun?.plan;
    expect(plan?.mode).toBe("approved");
    expect(plan?.sections[0]).toEqual({
      title: "Architecture",
      markdown: "### Stable seam\nUse the existing seam.",
    });
    // The full agent-facing Markdown never renders in the Plan tab, even after approval.
    expect(plan?.sections.map((section) => section.markdown).join("\n")).not.toContain(
      "## Architecture",
    );
  });

  it("deduplicates planning noise and never exposes full agent plans before approval", () => {
    const planning = fixtureRun();
    planning.lifecycle.phase = "planning";
    planning.plan!.status = "planning";
    planning.activity = [
      {
        id: "one",
        at: planning.createdAt,
        kind: "agent",
        message: "Planning agent event",
        ticketId: undefined,
        nodeId: undefined,
      },
      {
        id: "two",
        at: planning.createdAt,
        kind: "agent",
        message: "Architecture boundary mapped",
        ticketId: undefined,
        nodeId: undefined,
      },
      {
        id: "three",
        at: planning.createdAt,
        kind: "agent",
        message: "Architecture boundary mapped",
        ticketId: undefined,
        nodeId: undefined,
      },
    ];
    const activity = viewFor(planning).selectedRun?.plan;
    expect(activity?.mode).toBe("activity");
    expect(activity?.sections[0]?.markdown).not.toContain("Planning agent event");
    expect(activity?.sections[0]?.markdown.match(/Architecture boundary mapped/gu)).toHaveLength(1);

    const awaiting = fixtureRun();
    awaiting.lifecycle.phase = "awaiting_approval";
    awaiting.plan!.status = "awaiting_approval";
    awaiting.plan!.full.architecture = "SECRET FULL AGENT PLAN";
    awaiting.plan!.concise.architecture = [
      { title: "Stable seam", description: "Reuse the existing boundary." },
    ];
    const review = viewFor(awaiting).selectedRun?.plan;
    expect(review?.mode).toBe("review");
    expect(review?.sections[0]?.markdown).toContain("Stable seam");
    expect(review?.sections[0]?.markdown).not.toContain("SECRET FULL AGENT PLAN");
  });

  it("deduplicates semantic activity, drops generic agent noise, and contains internal labels", () => {
    const run = fixtureRun();
    run.activity = [
      {
        id: "one",
        at: "2026-07-16T00:00:04.000Z",
        kind: "agent",
        message: "Planning agent event",
        ticketId: undefined,
        nodeId: undefined,
      },
      {
        id: "two",
        at: "2026-07-16T00:00:05.000Z",
        kind: "graph_added",
        message: "Cache boundary",
        ticketId: undefined,
        nodeId: undefined,
      },
      {
        id: "three",
        at: "2026-07-16T00:00:06.000Z",
        kind: "graph_added",
        message: "Cache boundary",
        ticketId: undefined,
        nodeId: undefined,
      },
      {
        id: "four",
        at: "2026-07-16T00:00:07.000Z",
        kind: "compiler",
        message: "retry_supervised_stage",
        ticketId: undefined,
        nodeId: undefined,
      },
    ];
    expect(viewFor(run).selectedRun?.activity.map((event) => event.message)).toEqual([
      "Compiler recorded an internal state transition",
      "Added: Cache boundary ×2",
    ]);
  });

  it("presents nominally running tickets as interrupted while the run is blocked", () => {
    const blocked = fixtureRun();
    blocked.lifecycle.phase = "blocked";
    blocked.lifecycle.blocker =
      "ticket validation action did not complete with its exact accepted assignment (compensated)";
    const view = buildControlCenterView({
      projectRoot: "/project",
      authorityRevision: 1,
      runs: [blocked],
      selection: {
        runId: blocked.id,
        ticketId: "ticket-one",
        detailsTab: "overview",
        objectiveExpanded: false,
      },
    });
    const row = view.selectedRun?.tickets.find((ticket) => ticket.id === "ticket-one");
    expect(row?.status).toBe("Interrupted — run blocked");
    expect(row?.active).toBe(false);
    expect(row?.recovery).toBe(true);
    expect(row?.rail).toBe("◌");
    expect(view.selectedRun?.ticketDetails?.status).toBe("Interrupted — run blocked");
    expect(view.selectedRun?.ticketDetails?.steps[0]?.status).toBe("Interrupted — run blocked");
    const tabs = Object.fromEntries(
      (view.selectedRun?.ticketTabs ?? []).map((tab) => [tab.id, tab.count]),
    );
    expect(tabs.active).toBe(0);
    expect(tabs.blocked).toBe(1);

    const running = fixtureRun();
    const healthy = viewFor(running).selectedRun?.tickets.find(
      (ticket) => ticket.id === "ticket-one",
    );
    expect(healthy?.status).toBe("Running");
    expect(healthy?.active).toBe(true);
  });

  it("marks every pipeline stage done after the run completes", () => {
    const completed = fixtureRun();
    completed.lifecycle.phase = "completed";
    completed.currentPipelineStageId = "promotion";
    expect(viewFor(completed).selectedRun?.stages.every((stage) => stage.state === "done")).toBe(
      true,
    );
  });

  it("formats abbreviated token counts", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(1_100_000)).toBe("1.1M");
    expect(formatTokens(12_345)).toBe("12.3K");
  });

  it("keeps Evidence fail-closed, gives failures precedence, and names durable positive proof", () => {
    const pending = fixtureRun();
    expect(viewFor(pending).selectedRun?.overviewSections.at(-1)).toMatchObject({
      tone: "neutral",
      lines: ["No recorded issues", "Evidence pending"],
    });

    const proven = fixtureRun();
    proven.tickets["ticket-one"]!.status = "completed";
    proven.tickets["ticket-one"]!.steps[0]!.status = "completed";
    proven.tickets["ticket-one"]!.steps[0]!.summary = "Implemented the stable seam";
    expect(viewFor(proven).selectedRun?.overviewSections.at(-1)).toMatchObject({
      tone: "success",
      lines: ["Evidence recorded", "1 completed ticket"],
    });

    proven.lifecycle.phase = "blocked";
    proven.lifecycle.blocker = "Verification failed";
    const blockedView = viewFor(proven).selectedRun;
    // The run-level blocker renders in the Overview banner; Evidence keeps the durable proof.
    expect(blockedView?.blockedBanner).toMatchObject({ reason: "Verification failed" });
    expect(blockedView?.overviewSections.at(-1)).toMatchObject({
      tone: "success",
      lines: ["Evidence recorded", "1 completed ticket"],
    });

    proven.tickets["ticket-one"]!.status = "failed";
    expect(viewFor(proven).selectedRun?.overviewSections.at(-1)).toMatchObject({
      tone: "error",
      lines: ["Attention", "1 failed ticket"],
    });
  });

  it("does not present historical expected-red or repaired check receipts as unresolved", () => {
    const run = fixtureRun();
    const digest = `sha256:${"f".repeat(64)}` as const;
    run.checks = [
      {
        id: "historical-red",
        attemptId: "attempt-worker",
        callId: "call-one",
        requestedCheckId: "focused-proof",
        definitionHash: digest,
        kind: "command",
        accepted: false,
        passed: false,
        summary: "Expected red baseline",
        commands: [],
        evidenceSha256: digest,
        evidenceSizeBytes: 1,
        evidenceArtifactPath: "/evidence/red.json",
        recordedAt: "2026-07-16T00:00:03.100Z",
      },
      {
        id: "repaired-green",
        attemptId: "attempt-worker",
        callId: "call-two",
        requestedCheckId: "focused-proof",
        definitionHash: digest,
        kind: "command",
        accepted: true,
        passed: true,
        summary: "Focused proof passed",
        commands: [],
        evidenceSha256: digest,
        evidenceSizeBytes: 1,
        evidenceArtifactPath: "/evidence/green.json",
        recordedAt: "2026-07-16T00:00:03.200Z",
      },
    ];
    expect(viewFor(run).selectedRun?.overviewSections.at(-1)).toMatchObject({
      tone: "success",
      lines: ["Evidence recorded", "1 accepted check"],
    });

    run.tickets["ticket-one"]!.status = "completed";
    run.tickets["ticket-one"]!.steps[0]!.status = "completed";
    run.checks.push({
      ...run.checks[0]!,
      id: "completed-ticket-red",
      recordedAt: "2026-07-16T00:00:03.300Z",
    });
    expect(viewFor(run).selectedRun?.overviewSections.at(-1)?.lines).not.toContain(
      "1 failed check",
    );
  });

  it("keeps full approved plans distinct from a bounded semantic Graph Seed projection", () => {
    const run = fixtureRun();
    run.plan!.concise.architecture = [
      { title: "Stable seam", description: "Use the existing seam." },
    ];
    run.plan!.graphSeed = {
      rootSpec: { work_kind: "interface migration", secret_path: "/private/project/file.ts" },
      nodes: [
        {
          key: "local-change-key",
          type: "change",
          title: "Migrate note storage contract",
          spec: { purpose: "Preserve existing notes while adding structured fields" },
        },
      ],
      edges: [{ source: "$root", relation: "requires", target: "local-change-key" }],
    };
    const plan = viewFor(run).selectedRun?.plan;
    expect(plan?.sections[0]?.markdown).toContain("Use the existing seam");
    expect(plan?.sections.at(-1)).toMatchObject({ title: "Graph Seed" });
    expect(plan?.sections.at(-1)?.markdown).toContain(
      "Run goal requires Migrate note storage contract",
    );
    expect(plan?.sections.at(-1)?.markdown).not.toContain("local-change-key");
    expect(plan?.sections.at(-1)?.markdown).not.toContain("/private/project");
  });

  it("redacts control metadata from the selected ticket blocker", () => {
    const run = fixtureRun();
    run.tickets["ticket-one"]!.blocker =
      `Ticket ticket-secret failed at /Users/max/private.ts with sha256:${"f".repeat(64)} \u001b[31mred\u001b[0m`;
    const details = buildControlCenterView({
      projectRoot: "/project",
      authorityRevision: 1,
      runs: [run],
      selection: {
        runId: run.id,
        ticketId: "ticket-one",
        detailsTab: "overview",
        objectiveExpanded: false,
      },
    }).selectedRun?.ticketDetails;
    expect(details?.blocker).toContain("the ticket");
    expect(details?.blocker).toContain("[local path]");
    expect(details?.blocker).not.toContain("ticket-secret");
    expect(details?.blocker).not.toContain("/Users/max");
    expect(details?.blocker).not.toContain("sha256:");
    expect(details?.blocker).not.toContain("\u001b");
  });
});

function viewFor(run: RunRecord) {
  return buildControlCenterView({
    projectRoot: "/project",
    authorityRevision: 1,
    runs: [run],
    selection: { runId: run.id, detailsTab: "overview", objectiveExpanded: false },
  });
}

function fixtureRun(): RunRecord {
  let lifecycle = newRunLifecycle("run-one");
  lifecycle = reduceRunLifecycle(lifecycle, { type: "planning_started", atMs: 1_000 }).state;
  lifecycle = reduceRunLifecycle(lifecycle, { type: "plan_submitted", atMs: 2_000 }).state;
  lifecycle = reduceRunLifecycle(lifecycle, { type: "plan_approval_requested", atMs: 2_500 }).state;
  lifecycle = reduceRunLifecycle(lifecycle, { type: "plan_approved", atMs: 3_000 }).state;
  return {
    protocol: "koni.run-record.v1",
    id: "run-one",
    revision: 4,
    generation: 0,
    projectRoot: "/project",
    profile: {
      packageName: "@koni/coding-profile",
      packageVersion: "0.6.0",
      lineage: "koni.software",
      bundleHash: `sha256:${"a".repeat(64)}`,
    },
    compiledConfigHash: `sha256:${"b".repeat(64)}`,
    runTypeId: "medium",
    objective:
      "Build a carefully scoped feature using the existing architecture and verify the observable behavior without changing unrelated systems.",
    intake: { goal: "Build feature" },
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:04.000Z",
    lifecycle,
    pipelineStageIds: ["combined-plan", "approval", "orchestrate", "verification", "promotion"],
    currentPipelineStageId: "orchestrate",
    plan: {
      revision: 1,
      status: "approved",
      full: {
        architecture: "## Architecture\nUse the existing seam.",
        decisions: "## Decisions\nNo new platform.",
        risk: "## Risk\nRoutine.",
        verification: "## Verification\nRun the proof.",
      },
      concise: {},
      graphSeed: undefined,
      steeringHistory: [],
    },
    graphRevision: 2,
    graphHash: `sha256:${"c".repeat(64)}`,
    tickets: {
      "ticket-one": {
        id: "ticket-one",
        operationId: "implement-change",
        title: "Implement feature",
        summary: "Implement feature",
        status: "running",
        priority: 0,
        dependencyIds: [],
        targetNodeIds: [],
        readPaths: [],
        writePaths: [],
        steps: [
          {
            id: "implement",
            title: "Implement feature",
            personaId: "implementer",
            status: "running",
            attemptIds: ["attempt-worker"],
            summary: undefined,
            startedAt: "2026-07-16T00:00:03.000Z",
            completedAt: undefined,
          },
        ],
        worktreePath: undefined,
        branch: undefined,
        blocker: undefined,
        createdAt: "2026-07-16T00:00:02.000Z",
        updatedAt: "2026-07-16T00:00:03.000Z",
      },
    },
    attempts: {
      "attempt-lead": {
        id: "attempt-lead",
        sessionId: "session-lead",
        ticketId: "run-planning",
        stepId: "lead",
        personaId: "lead",
        modelProvider: "openai-codex",
        modelId: "gpt-5.6-sol",
        thinkingLevel: "xhigh",
        status: "completed",
        launchSpecHash: `sha256:${"d".repeat(64)}`,
        sessionFile: "/sessions/lead.jsonl",
        startedAt: "2026-07-16T00:00:01.000Z",
        endedAt: "2026-07-16T00:00:02.000Z",
        terminalSummary: "Planned run",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 1_000,
        cacheWriteTokens: 0,
      },
      "attempt-worker": {
        id: "attempt-worker",
        sessionId: "session-worker",
        ticketId: "ticket-one",
        stepId: "implement",
        personaId: "implementer",
        modelProvider: "openai-codex",
        modelId: "gpt-5.6-terra",
        thinkingLevel: "high",
        status: "running",
        launchSpecHash: `sha256:${"e".repeat(64)}`,
        sessionFile: "/sessions/worker.jsonl",
        startedAt: "2026-07-16T00:00:03.000Z",
        endedAt: undefined,
        terminalSummary: undefined,
        inputTokens: 800,
        outputTokens: 150,
        cacheReadTokens: 9_000,
        cacheWriteTokens: 0,
      },
    },
    questions: {},
    activity: [
      {
        id: "event-one",
        at: "2026-07-16T00:00:01.000Z",
        kind: "agent",
        message: "Mapped architecture boundary",
        ticketId: undefined,
        nodeId: undefined,
      },
    ],
    git: {
      protocol: "koni.git-lifecycle.v1",
      runId: "run-one",
      projectRoot: "/project",
      commonDirectory: "/project/.git",
      target: { ref: "refs/heads/main", selectedOid: "a".repeat(40) },
      namespace: {
        root: "/project/.git/koni",
        runRef: "refs/heads/koni/runs/run-one",
        planningWorktree: "/planning",
        runWorktree: "/worktree",
        ticketRoot: "/tickets",
      },
      planning: {
        status: "retired",
        baseOid: "a".repeat(40),
        worktree: "/planning",
        createdAt: undefined,
        retiredAt: undefined,
        blocker: undefined,
      },
      run: {
        status: "ready",
        branchRef: "refs/heads/koni/runs/run-one",
        worktree: "/worktree",
        headOid: "a".repeat(40),
        materializedAt: "2026-07-16T00:00:03.000Z",
        retiredAt: undefined,
        blocker: undefined,
      },
      ticketCycles: {},
      ticketCycleOrder: [],
      promotion: undefined,
    },
  };
}
