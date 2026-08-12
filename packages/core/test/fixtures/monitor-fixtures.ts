import {
  MONITOR_ATTENTION_PROTOCOL,
  MONITOR_SNAPSHOT_PROTOCOL,
} from "../../src/monitor/protocol.js";
import type {
  ControlModelOption,
  ControlRunTypeOption,
} from "../../src/control-center/protocol.js";

export function monitorSnapshotFixture(): any {
  return {
    protocol: MONITOR_SNAPSHOT_PROTOCOL,
    revision: 14,
    eventCursor: 8,
    totalRuns: 1,
    truncated: false,
    runs: [
      {
        id: "run-a",
        runRevision: 4,
        objectivePreview: "Build notes",
        runType: "Medium",
        phase: "awaiting_approval",
        stage: "Plan review",
        updatedAt: "2026-07-17T12:00:00.000Z",
        tickets: { completed: 1, total: 4 },
        agents: { active: 0, total: 1 },
        tokens: { new: 1_500, cache: 8_000, total: 9_500 },
        questionCount: 1,
        proposalCount: 0,
        planApproval: true,
        blocker: null,
        failure: null,
        mergeReady: false,
      },
    ],
  };
}

export function monitorAttentionFixture(): any {
  const item = (title: string, description: string) => [{ title, description }];
  return {
    protocol: MONITOR_ATTENTION_PROTOCOL,
    runId: "run-a",
    runRevision: 4,
    questions: [
      {
        id: "question-a",
        prompt: "Where should notes live?",
        options: [
          {
            id: "database",
            label: "Database",
            description: "Persist notes in the project database.",
          },
        ],
        allowsNotes: true,
        askedAt: "2026-07-17T11:59:00.000Z",
      },
    ],
    proposals: [],
    plan: {
      revision: 2,
      planningSessionId: "session-planner",
      planningAttemptId: "attempt-planner",
      revisionUsage: {
        cumulative: { new: 1_500, cache: 8_000, total: 9_500 },
        currentRevision: { new: 400, cache: 2_000, total: 2_400 },
      },
      sections: {
        architecture: item(
          "Stable boundary",
          "Keep note persistence behind the existing repository interface.",
        ),
        decisions: item(
          "Reuse editor",
          "Extend the current editor rather than creating a parallel form.",
        ),
        risk: item("Migration", "Preserve existing note bytes while moving the presentation."),
        verification: item("Focused checks", "Run the notes route and repository tests."),
      },
      graphSeedCounts: { change: 1, verification: 2 },
    },
  };
}

export function monitorProposalFixture(): any {
  return {
    runId: "run-a",
    ticketId: "proposal-a",
    sourceTicketId: "ticket-source",
    requestSha256: `sha256:${"7".repeat(64)}`,
    status: "proposed",
    title: "Revise the storage contract",
    summary: "Allow the notes repository to retain encrypted drafts before final publication.",
    targetNodeIds: ["claim-storage", "constraint-encryption"],
    createdAt: "2026-07-17T11:58:00.000Z",
    disposition: { kind: "pending" },
  };
}

export function monitorRunTypesFixture(): ControlRunTypeOption[] {
  const intake = [
    {
      id: "goal",
      label: "Goal",
      description: "Describe the outcome Koni should deliver.",
      kind: "text" as const,
      required: true,
      options: [],
    },
  ];
  const stages = [
    { id: "intake", title: "Validate intake", kind: "planning", included: true },
    { id: "architecture", title: "Plan architecture", kind: "planning", included: true },
    { id: "risk", title: "Plan risk controls", kind: "planning", included: false },
    { id: "verification-plan", title: "Plan verification", kind: "planning", included: true },
    { id: "approval", title: "Approve the plans", kind: "approval", included: true },
    { id: "initialize", title: "Initialize the run", kind: "execution", included: true },
    { id: "work", title: "Execute compiled work", kind: "execution", included: true },
    {
      id: "target-sync",
      title: "Synchronize the target branch",
      kind: "execution",
      included: true,
    },
    { id: "verification", title: "Verify the completed run", kind: "verification", included: true },
    { id: "review", title: "Independently review the run", kind: "verification", included: true },
    { id: "report", title: "Compile final report", kind: "execution", included: true },
    { id: "promotion", title: "Merge the completed run", kind: "promotion", included: true },
  ];
  const role = (id: string, title: string, model: string, thinkingLevel: any) => ({
    id,
    title,
    provider: "openai-codex",
    model,
    thinkingLevel,
  });
  return [
    {
      id: "small",
      title: "Small",
      description: "Small change",
      questionPolicy: "none",
      maxParallel: 1,
      questionDefaultScope: "run",
      objectiveFieldId: "goal",
      intake,
      autoStart: true,
      runCardSections: ["goal", "pipeline", "graph", "tickets", "checks", "report"],
      startMode: "planning",
      stages: stages.map((stage, index) => ({ ...stage, included: index !== 1 && index !== 3 })),
      roles: [
        role("planner", "Planner", "gpt-terra", "xhigh"),
        role("lead", "Lead", "gpt-terra", "high"),
        role("worker", "Worker", "gpt-luna", "medium"),
        role("reviewer", "Reviewer", "gpt-terra", "max"),
      ],
    },
    {
      id: "medium",
      title: "Medium",
      description: "Medium change",
      questionPolicy: "some",
      maxParallel: 3,
      questionDefaultScope: "run",
      objectiveFieldId: "goal",
      intake,
      autoStart: true,
      runCardSections: ["goal", "pipeline", "graph", "tickets", "checks", "report"],
      startMode: "planning",
      stages,
      roles: [
        role("planner", "Planner", "gpt-sol", "max"),
        role("lead", "Lead", "gpt-sol", "xhigh"),
        role("worker", "Worker", "gpt-terra", "high"),
        role("reviewer", "Reviewer", "gpt-sol", "max"),
      ],
    },
    {
      id: "large",
      title: "Large",
      description: "Large change",
      questionPolicy: "many",
      maxParallel: 5,
      questionDefaultScope: "run",
      objectiveFieldId: "goal",
      intake,
      autoStart: true,
      runCardSections: ["goal", "pipeline", "graph", "tickets", "checks", "report"],
      startMode: "planning",
      stages: stages.map((stage) => ({ ...stage, included: true })),
      roles: [
        role("planner", "Planner", "gpt-sol", "max"),
        role("lead", "Lead", "gpt-sol", "max"),
        role("worker", "Worker", "gpt-sol", "xhigh"),
        role("reviewer", "Reviewer", "gpt-sol", "max"),
      ],
    },
  ];
}

export function monitorModelsFixture(): ControlModelOption[] {
  return [
    {
      provider: "openai-codex",
      id: "gpt-luna",
      name: "Luna",
      reasoning: true,
      thinkingLevels: ["off", "low", "medium"],
      available: true,
    },
    {
      provider: "openai-codex",
      id: "gpt-terra",
      name: "Terra",
      reasoning: true,
      thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
      available: true,
    },
    {
      provider: "openai-codex",
      id: "gpt-sol",
      name: "Sol",
      reasoning: true,
      thinkingLevels: ["medium", "high", "xhigh", "max"],
      available: true,
    },
    {
      provider: "ambient",
      id: "custom",
      name: "Ambient",
      reasoning: true,
      thinkingLevels: ["high"],
      available: false,
      unavailableReason: "Ambient extension only",
    },
  ];
}
