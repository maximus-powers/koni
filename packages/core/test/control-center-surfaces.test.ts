import { describe, expect, it } from "vitest";
import { visibleWidth, type Terminal } from "@earendil-works/pi-tui";
import { AuthorityClientError } from "../src/authority/client.js";
import { RunSummaryPageCollector } from "../src/authority/run-summary-page.js";
import type { JsonValue, RpcEvent, RpcSuccess } from "../src/authority/protocol.js";
import { ControlCenterComponent, renderGraphLines } from "../src/control-center/component.js";
import type { CellGrid } from "../src/control-center/cell-grid.js";
import {
  ControlCenterController,
  type ControlCenterAuthorityClient,
} from "../src/control-center/controller.js";
import {
  decodeControlCenterInput,
  decodeControlCenterPointer,
} from "../src/control-center/input.js";
import { ansiKoniPalette, plainKoniPalette } from "../src/control-center/markdown.js";
import { createStandaloneControlCenter } from "../src/control-center/standalone.js";
import {
  assemblePiTranscriptPages,
  MAX_PROJECTED_TRANSCRIPT_BLOCK_CHARACTERS,
  parsePiTranscriptPage,
  TRANSCRIPT_PAGE_LIMIT,
} from "../src/control-center/transcript.js";
import {
  parseControlCatalog,
  type ConfigDocumentCatalog,
  type ConfigDocumentSummary,
  type ControlModelOption,
  type ControlProfileConflictCatalog,
  type ControlProfileConflictInspection,
} from "../src/control-center/protocol.js";
import { newRunLifecycle, reduceRunLifecycle } from "../src/state/run-lifecycle.js";
import type { RunRecord } from "../src/state/run-record.js";
import { projectControlProposalInspection } from "../src/authority/monitor-projection.js";
import { canonicalHash } from "../src/shared/canonical.js";
import {
  createQuestionBatch,
  queueQuestionBatchResume,
  resolveQuestionBatch,
  reviseQuestionBatchAnswer,
  saveQuestionBatchAnswer,
} from "../src/state/question-batch.js";
import {
  defineBuiltInStageAction,
  defineStageCapabilityCatalog,
  defineStageInteraction,
  type StageActionCapability,
} from "../src/state/stage-capability.js";
import { attachCanonicalProposalFixture } from "./fixtures/canonical-control-ticket.js";
import { buildControlCenterView } from "../src/control-center/view-model.js";

describe("control center controller", () => {
  it("presents a compiler-held source as waiting without hiding ordinary blockers", () => {
    const run = fixtureRun();
    const held = run.tickets["ticket-one"]!;
    held.status = "blocked";
    held.blocker = "Awaiting upstream change proposal proposal-one";
    held.steps[0]!.status = "completed";
    held.executionControl = {
      sourceHold: {
        proposalTicketId: "proposal-one",
        requestSha256: canonicalHash("proposal request"),
      },
    };
    const waiting = buildControlCenterView({
      projectRoot: run.projectRoot,
      authorityRevision: 1,
      runs: [run],
      selection: { runId: run.id, detailsTab: "overview", objectiveExpanded: false },
      nowMs: 20_000,
    });

    expect(waiting.selectedRun?.tickets[0]).toMatchObject({
      status: "Waiting for compiler grant",
      recovery: false,
    });
    expect(
      waiting.selectedRun?.overviewSections.find((section) => section.title === "Evidence"),
    ).not.toMatchObject({ tone: "error" });
    expect(waiting.selectedRun?.ticketTabs.find((tab) => tab.id === "blocked")?.count).toBe(0);
    expect(waiting.selectedRun?.ticketTabs.find((tab) => tab.id === "queued")?.count).toBe(1);
    expect(waiting.selectedRun?.ticketTabs.some((tab) => String(tab.id) === "todo")).toBe(false);

    const ordinary = structuredClone(held);
    ordinary.id = "ticket-ordinary-blocker";
    ordinary.title = "Ordinary blocker";
    delete ordinary.executionControl;
    run.tickets[ordinary.id] = ordinary;
    const withFailure = buildControlCenterView({
      projectRoot: run.projectRoot,
      authorityRevision: 1,
      runs: [run],
      selection: { runId: run.id, detailsTab: "overview", objectiveExpanded: false },
      nowMs: 20_000,
    });

    expect(
      withFailure.selectedRun?.overviewSections.find((section) => section.title === "Evidence"),
    ).toMatchObject({ tone: "error", lines: ["Attention", "1 blocked ticket"] });
    expect(withFailure.selectedRun?.ticketTabs.find((tab) => tab.id === "blocked")?.count).toBe(1);
  });

  it("recovers ticket activation when stage controls race a run revision", async () => {
    const client = new FakeAuthority([fixtureRun()]);
    const controller = new ControlCenterController({ projectRoot: "/project", client });
    client.returnStaleControlsOnce();
    await controller.initialize();

    await controller.handle({ type: "focus_panel", panel: "tickets" });
    await controller.handle({ type: "move", delta: 1 });
    await controller.handle({ type: "activate" });

    expect(controller.snapshot.selection.ticketId).toBe("ticket-one");
    expect(client.calls.filter((call) => call.method === "run.controls")).toHaveLength(2);
    expect(controller.snapshot.notice).toBeUndefined();
  });

  it("selects through the shared view model and sends effects only over revisioned RPC", async () => {
    const client = new FakeAuthority([fixtureRun()]);
    const controller = new ControlCenterController({
      projectRoot: "/project",
      client,
      now: () => 20_000,
    });
    await controller.initialize();

    expect(controller.snapshot.view.selectedRun?.id).toBe("run-one");
    expect(client.calls.some((call) => call.method === "run.graph")).toBe(true);

    await controller.handle({ type: "focus_panel", panel: "tickets" });
    await controller.handle({ type: "move", delta: 1 });
    // Arrow movement only highlights; Enter commits the ticket selection.
    expect(controller.snapshot.selection.ticketId).toBeUndefined();
    expect(controller.snapshot.cursor.ticketId).toBe("ticket-one");
    await controller.handle({ type: "activate" });
    expect(controller.snapshot.selection.ticketId).toBe("ticket-one");
    // The graph projection stays run-wide after a ticket commit: the Graph feed narrows the
    // committed ticket visually, never through the RPC.
    expect(
      client.calls.filter((call) => call.method === "run.graph").map((call) => call.params),
    ).not.toContainEqual(expect.objectContaining({ ticketId: expect.anything() }));
    expect(client.calls.filter((call) => call.method === "run.graph").at(-1)?.params).toEqual({
      runId: "run-one",
    });

    await controller.handle({ type: "focus_panel", panel: "details" });
    // Tabs stay reachable with a committed ticket: Overview wraps around to the Graph feed.
    await controller.handle({ type: "details_tab", delta: 1 });
    expect(controller.snapshot.selection).toMatchObject({
      ticketId: "ticket-one",
      detailsTab: "graph",
    });
    await controller.handle({ type: "details_tab", delta: -1 });
    expect(controller.snapshot.selection.detailsTab).toBe("overview");

    await controller.handle({ type: "toggle_pause" });
    const pause = client.calls.find(
      (call) =>
        call.method === "run.action.execute" &&
        isRecord(call.params) &&
        call.params.capabilityId === "run:pause",
    );
    expect(pause).toMatchObject({
      params: {
        protocol: "koni.stage-action-invocation.v1",
        runId: "run-one",
        runRevision: 4,
        generation: 0,
        capabilityId: "run:pause",
        confirmed: false,
        values: {},
      },
      expectedRevision: 7,
    });
    expect(pause?.idempotencyKey).toMatch(/^run\.action\.execute:/u);

    await controller.handle({ type: "request_delete" });
    expect(controller.snapshot.modal).toMatchObject({
      kind: "delete",
      runId: "run-one",
      selected: "cancel",
      liveAgents: 1,
    });
    expect(client.calls.some((call) => call.method === "run.delete")).toBe(false);
    await controller.handle({ type: "details_tab", delta: 1 });
    await controller.handle({ type: "activate" });
    expect(client.calls.find((call) => call.method === "run.delete")).toMatchObject({
      params: {
        runId: "run-one",
        mode: "preserve_branches",
        previewToken: `sha256:${"d".repeat(64)}`,
      },
      idempotencyKey: expect.stringMatching(/^run\.delete:/u),
    });

    controller.dispose();
  });

  it("requires explicit confirmation for delete and merge while keeping mutations exact", async () => {
    const run = fixtureRun();
    run.lifecycle.phase = "merge_ready";
    run.tickets["ticket-one"]!.status = "completed";
    run.tickets["ticket-one"]!.steps[0]!.status = "completed";
    run.attempts["attempt-worker"]!.status = "completed";
    run.git.promotion = {
      status: "ready",
      expectedTargetOid: "a".repeat(40),
      runOid: "b".repeat(40),
      candidateOid: "c".repeat(40),
      targetCheckout: "/project",
      preparedAt: "2026-07-16T00:00:10.000Z",
      publishedAt: undefined,
      blocker: undefined,
    };
    const client = new FakeAuthority([run]);
    const controller = new ControlCenterController({ projectRoot: "/project", client });
    await controller.initialize();

    await controller.handle({ type: "request_delete" });
    await controller.handle({ type: "activate" });
    expect(client.calls.some((call) => call.method === "run.delete")).toBe(false);

    await controller.handle({ type: "merge" });
    expect(controller.snapshot.modal).toMatchObject({
      kind: "merge",
      selected: "cancel",
      canAuthorize: true,
      targetBranch: "main",
    });
    await controller.handle({ type: "details_tab", delta: 1 });
    await controller.handle({ type: "activate" });
    expect(client.calls.find((call) => call.method === "run.merge.authorize")).toMatchObject({
      params: { runId: "run-one", previewToken: `sha256:${"e".repeat(64)}` },
      expectedRevision: 7,
    });
    controller.dispose();
  });

  it("opens the exact compiler-bound resolver retry instead of generically resuming a blocked run", async () => {
    const run = fixtureRun();
    run.lifecycle = reduceRunLifecycle(run.lifecycle, {
      type: "blocked",
      atMs: 4_000,
      reason: "The configured terminal resolver needs an exact retry decision.",
      remedy: "resume",
    }).state;
    const client = new FakeAuthority([run]);
    const controller = new ControlCenterController({ projectRoot: "/project", client });
    await controller.initialize();

    await controller.handle({ type: "toggle_pause" });

    expect(controller.snapshot.modal).toMatchObject({
      kind: "action_form",
      action: {
        id: "run:terminal-resolver:retry:resolver-one",
        intent: "retry_terminal_resolver",
      },
      values: {
        resolverTicketId: "resolver-one",
        sourceTicketId: "ticket-one",
        failedAttemptId: "attempt-resolver-one",
        message: "",
      },
    });
    expect(client.calls.some((call) => call.method === "run.resume")).toBe(false);
    expect(client.calls.some((call) => call.method === "run.action.execute")).toBe(false);
    controller.dispose();
  });

  it("answers None of these with free-form notes from the conditional question panel", async () => {
    const client = new FakeAuthority([fixtureRun()]);
    const controller = new ControlCenterController({ projectRoot: "/project", client });
    await controller.initialize();
    await controller.handle({ type: "focus_panel", panel: "questions" });
    await controller.handle({ type: "move", delta: 1 });
    await controller.handle({ type: "move", delta: 1 });
    expect(controller.snapshot.questionDraft?.selectedOptionId).toBeUndefined();
    await controller.handle({ type: "toggle_notes" });
    await controller.handle({ type: "append_text", text: "Keep the legacy behavior" });
    await controller.handle({ type: "activate" });
    expect(controller.snapshot.modal).toMatchObject({ kind: "answer_question", focus: "notes" });
    await controller.handle({ type: "append_text", text: " plus modal context" });
    await controller.handle({ type: "toggle_notes" });
    await controller.handle({ type: "activate" });

    const answer = client.calls.find((call) => call.method === "question.answer");
    expect(answer?.params).toEqual({
      runId: "run-one",
      questionId: "question-one",
      notes: "Keep the legacy behavior plus modal context",
    });
    expect(controller.snapshot.view.selectedRun?.questions).toBeUndefined();
    expect(controller.snapshot.focus).toBe("details");
    controller.dispose();
  });

  it("opens the selected pending question directly and refreshes on the documented keys", async () => {
    const client = new FakeAuthority([fixtureRun()]);
    const controller = new ControlCenterController({ projectRoot: "/project", client });
    await controller.initialize();
    const before = client.calls.filter((call) => call.method === "run.page").length;
    await controller.handle({ type: "open_question" });
    expect(controller.snapshot.modal).toMatchObject({
      kind: "answer_question",
      questionId: "question-one",
      focus: "choices",
    });
    await controller.handle({ type: "cancel" });
    await controller.handle({ type: "refresh" });
    expect(client.calls.filter((call) => call.method === "run.page")).toHaveLength(before + 1);
    controller.dispose();
  });

  it("reviews a proposed ticket read-only and records only an explicit CAS-bound decision", async () => {
    const run = fixtureRun();
    run.questions = {};
    const proposalId = await attachFixtureProposal(run);
    const client = new FakeAuthority([run]);
    const controller = new ControlCenterController({ projectRoot: "/project", client });
    await controller.initialize();
    await controller.handle({ type: "focus_panel", panel: "tickets" });
    for (
      let index = 0;
      index < 3 && controller.snapshot.cursor.ticketId !== proposalId;
      index += 1
    ) {
      await controller.handle({ type: "move", delta: 1 });
    }
    expect(controller.snapshot.cursor.ticketId).toBe(proposalId);

    // Enter commits the highlighted proposal and opens its guarded review directly.
    await controller.handle({ type: "activate" });
    expect(controller.snapshot.selection.ticketId).toBe(proposalId);
    expect(client.calls.find((call) => call.method === "proposal.inspect")).toMatchObject({
      params: { runId: "run-one", ticketId: proposalId },
      expectedRevision: undefined,
      idempotencyKey: undefined,
    });
    expect(client.calls.some((call) => call.method === "proposal.decide")).toBe(false);
    expect(controller.snapshot.modal).toMatchObject({
      kind: "proposal_review",
      focus: "document",
      decision: undefined,
      message: "",
    });
    await controller.handle({ type: "submit" });
    expect(client.calls.some((call) => call.method === "proposal.decide")).toBe(false);
    expect(controller.snapshot.notice?.message).toContain("Record decision");
    const component = new ControlCenterComponent({
      controller,
      palette: plainKoniPalette,
      viewportRows: () => 34,
    });
    const initial = component.render(94).join("\n");
    expect(initial).toContain("Review change proposal");
    expect(initial).toContain("Revise the storage contract");
    expect(initial).toContain("Awaiting your decision");
    expect(initial).toContain("Approve proposal");
    expect(initial).toContain("Reject proposal");
    expect(initial).not.toContain(proposalId);
    expect(initial).not.toContain("ticket-one");

    await controller.handle({ type: "activate" });
    await controller.handle({ type: "append_text", text: "Keep the public API stable." });
    await controller.handle({ type: "focus", delta: 1 });
    await controller.handle({ type: "details_tab", delta: 1 });
    await controller.handle({ type: "details_tab", delta: 1 });
    await controller.handle({ type: "focus", delta: 1 });
    await controller.handle({ type: "activate" });
    expect(client.calls.some((call) => call.method === "proposal.decide")).toBe(false);
    expect(controller.snapshot.notice?.message).toContain("Ctrl-Enter");

    await controller.handle({ type: "submit" });
    const decision = client.calls.find((call) => call.method === "proposal.decide");
    const requestSha256 = run.tickets[proposalId]!.executionControl!.proposalRequest!.requestSha256;
    expect(decision).toMatchObject({
      params: {
        runId: "run-one",
        ticketId: proposalId,
        requestSha256,
        decision: "rejection",
        message: "Keep the public API stable.",
      },
      expectedRevision: undefined,
      idempotencyKey: expect.stringMatching(/^proposal\.decide:/u),
    });
    expect(decision?.params).not.toHaveProperty("actor");
    component.dispose();
    controller.dispose();
  });

  it("retries an unchanged proposal once after a CAS conflict", async () => {
    const run = fixtureRun();
    run.questions = {};
    const proposalId = await attachFixtureProposal(run);
    const client = new FakeAuthority([run]);
    const controller = new ControlCenterController({ projectRoot: "/project", client });
    await controller.initialize();
    await controller.handle({ type: "focus_panel", panel: "tickets" });
    for (
      let index = 0;
      index < 3 && controller.snapshot.cursor.ticketId !== proposalId;
      index += 1
    ) {
      await controller.handle({ type: "move", delta: 1 });
    }
    await controller.handle({ type: "activate" });
    await controller.handle({ type: "focus", delta: 1 });
    await controller.handle({ type: "focus", delta: 1 });
    await controller.handle({ type: "move", delta: 1 });
    await controller.handle({ type: "focus", delta: 1 });

    client.failNextProposalDecisionWithRevisionConflict();
    await controller.handle({ type: "submit" });

    expect(client.calls.filter((call) => call.method === "proposal.decide")).toHaveLength(2);
    expect(client.calls.filter((call) => call.method === "proposal.inspect")).toHaveLength(2);
    expect(controller.snapshot.modal).toBeUndefined();
    expect(controller.snapshot.notice?.message).toContain("Change proposal approved");
    controller.dispose();
  });

  it("finishes a proposal decision after one coalesced refresh under continuous authority churn", async () => {
    const run = fixtureRun();
    run.questions = {};
    const proposalId = await attachFixtureProposal(run);
    const client = new FakeAuthority([run]);
    const controller = new ControlCenterController({ projectRoot: "/project", client });
    await controller.initialize();
    await controller.handle({ type: "focus_panel", panel: "tickets" });
    for (
      let index = 0;
      index < 3 && controller.snapshot.cursor.ticketId !== proposalId;
      index += 1
    ) {
      await controller.handle({ type: "move", delta: 1 });
    }
    await controller.handle({ type: "activate" });
    await controller.handle({ type: "focus", delta: 1 });
    await controller.handle({ type: "focus", delta: 1 });
    await controller.handle({ type: "move", delta: 1 });
    await controller.handle({ type: "focus", delta: 1 });
    const pagesBeforeDecision = client.calls.filter((call) => call.method === "run.page").length;
    client.churnRunPages(10);

    await controller.handle({ type: "submit" });

    const decisionPages =
      client.calls.filter((call) => call.method === "run.page").length - pagesBeforeDecision;
    expect(decisionPages).toBeLessThanOrEqual(2);
    expect(client.calls.filter((call) => call.method === "proposal.decide")).toHaveLength(1);
    expect(controller.snapshot.busy).toBeUndefined();
    expect(controller.snapshot.modal).toBeUndefined();
    controller.dispose();
  });

  it("opens the complete guided New Run form and inserts a provisional row before authority answers", async () => {
    const client = new FakeAuthority([]);
    const release = client.deferRunCreate();
    const controller = new ControlCenterController({
      projectRoot: "/project",
      client,
      models: fixtureModels(),
      now: () => Date.parse("2026-07-16T00:00:30.000Z"),
    });
    await controller.initialize();
    await controller.handle({ type: "open_new_run" });
    const component = new ControlCenterComponent({
      controller,
      palette: plainKoniPalette,
      viewportRows: () => 48,
    });
    const form = component.render(122).join("\n");
    expect(form).toContain("Goal Prompt");
    expect(form).toContain("Run Config");
    expect(form).toContain("Small");
    expect(form).toContain("Medium");
    expect(form).toContain("Large");
    expect(form).toContain("Validate intake");
    expect(form).toContain("Independent review");
    expect(form).toContain("no");
    expect(form).not.toContain(" none ");
    expect(form).toContain("some");
    expect(form).toContain("many");
    expect(form).toContain("Max parallel agents");
    expect(form).toContain("Model");
    expect(form).toContain("Reasoning");
    expect(form).toContain("Planner");
    expect(form).toContain("Lead");
    expect(form).toContain("Worker");
    expect(form).toContain("Reviewer");
    expect(form).toContain("Start Planning");
    expect(form).not.toContain("guided intake");
    expect(form).not.toContain("What should Koni build?");

    await controller.handle({ type: "append_text", text: "Build a note editor" });
    expect(controller.snapshot.modal).toMatchObject({ kind: "new_run", focus: "objective" });
    expect(client.calls.some((call) => call.method === "run.create")).toBe(false);
    for (
      let index = 0;
      index < 20 &&
      controller.snapshot.modal?.kind === "new_run" &&
      controller.snapshot.modal.focus !== "start";
      index += 1
    ) {
      await controller.handle({ type: "focus", delta: 1 });
    }
    expect(controller.snapshot.modal).toMatchObject({ kind: "new_run", focus: "start" });
    const pending = controller.handle({ type: "submit" });
    await Promise.resolve();
    try {
      expect(controller.snapshot.modal).toBeUndefined();
      expect(controller.snapshot.view.runs[0]).toMatchObject({
        state: "Starting",
        title: "Build a note editor",
        targetBranch: "main",
        provisional: true,
      });
      const create = client.calls.find((call) => call.method === "run.create");
      expect(create?.params).toMatchObject({
        objective: "Build a note editor",
        runTypeId: "medium",
        targetRef: "refs/heads/main",
        overrides: {
          questionPolicy: "some",
          maxParallel: 3,
          roles: {
            planner: { model: "gpt-small", thinkingLevel: "high" },
            lead: { model: "gpt-small", thinkingLevel: "high" },
            ticket_worker: { model: "gpt-worker", thinkingLevel: "medium" },
            reviewer: { model: "gpt-review", thinkingLevel: "max" },
          },
        },
      });
    } finally {
      release();
    }
    await pending;
    expect(controller.snapshot.view.runs[0]?.provisional).toBe(false);
    component.dispose();
    controller.dispose();
  });

  it("surfaces the authority's dirty-target warning as an info notice after the run starts", async () => {
    const client = new FakeAuthority([]);
    client.runCreateWarning =
      "target checkout has uncommitted changes (scratch.txt); the run starts from the branch's last commit and does not include them";
    const controller = new ControlCenterController({
      projectRoot: "/project",
      client,
      models: fixtureModels(),
      now: () => Date.parse("2026-07-16T00:00:30.000Z"),
    });
    await controller.initialize();
    await controller.handle({ type: "open_new_run" });
    await controller.handle({ type: "append_text", text: "Build a note editor" });
    for (
      let index = 0;
      index < 20 &&
      controller.snapshot.modal?.kind === "new_run" &&
      controller.snapshot.modal.focus !== "start";
      index += 1
    ) {
      await controller.handle({ type: "focus", delta: 1 });
    }
    await controller.handle({ type: "submit" });
    expect(controller.snapshot.modal).toBeUndefined();
    expect(controller.snapshot.notice).toEqual({
      kind: "info",
      message:
        "target checkout has uncommitted changes (scratch.txt); the run starts from the branch's last commit and does not include them",
    });
    controller.dispose();
  });

  it("opens New Run on the compiled default even when the profile has no small run type", async () => {
    const client = new FakeAuthority([]);
    const catalog = fixtureControlCatalog();
    client.setControlCatalog({
      ...catalog,
      runTypes: catalog.runTypes.filter((runType) => runType.id !== "small"),
    });
    const controller = new ControlCenterController({
      projectRoot: "/project",
      client,
      models: fixtureModels(),
    });
    await controller.initialize();
    await controller.handle({ type: "open_new_run" });
    expect(controller.snapshot.runTypes.map((runType) => runType.id)).toEqual(["medium", "large"]);
    expect(controller.snapshot.modal).toMatchObject({
      kind: "new_run",
      runTypeId: "medium",
      questionPolicy: "some",
      maxParallel: 3,
    });
    controller.dispose();
  });

  it("edits the New Run objective with a Unicode caret instead of append-only text", async () => {
    const controller = new ControlCenterController({
      projectRoot: "/project",
      client: new FakeAuthority([]),
      models: fixtureModels(),
    });
    await controller.initialize();
    await controller.handle({ type: "open_new_run" });
    await controller.handle({ type: "append_text", text: "A🙂B" });
    await controller.handle({ type: "details_tab", delta: -1 });
    await controller.handle({ type: "details_tab", delta: -1 });
    await controller.handle({ type: "append_text", text: "Ω" });
    await controller.handle({ type: "delete_forward" });
    await controller.handle({ type: "activate" });
    expect(controller.snapshot.modal).toMatchObject({
      kind: "new_run",
      objective: "AΩ\nB",
      objectiveCursor: 3,
    });
    const component = new ControlCenterComponent({
      controller,
      palette: plainKoniPalette,
      viewportRows: () => 30,
    });
    expect(component.render(82).join("\n")).toContain("▌");
    component.dispose();
    controller.dispose();
  });

  it("rejects an authority catalog whose compiled default is not runnable", () => {
    expect(() =>
      parseControlCatalog({
        ...fixtureControlCatalog(),
        defaultRunTypeId: "missing",
      }),
    ).toThrow(/default run type missing is not in the compiled run type catalog/u);
  });

  it("cycles every Pi-available model and only the selected model's supported reasoning levels", async () => {
    const models = fixtureModels();
    models.at(-1)!.available = false;
    const controller = new ControlCenterController({
      projectRoot: "/project",
      client: new FakeAuthority([]),
      models,
    });
    await controller.initialize();
    await controller.handle({ type: "open_new_run" });
    for (let index = 0; index < 6; index += 1) await controller.handle({ type: "focus", delta: 1 });
    expect(controller.snapshot.modal).toMatchObject({
      kind: "new_run",
      focus: "role:planner:model",
    });

    const selectedModels = new Set<string>();
    for (let index = 0; index < 3; index += 1) {
      const modal = controller.snapshot.modal;
      if (modal?.kind === "new_run") selectedModels.add(modal.roles[0]!.model);
      await controller.handle({ type: "details_tab", delta: 1 });
    }
    expect(selectedModels).toEqual(new Set(["gpt-small", "gpt-worker", "gpt-review"]));
    expect(selectedModels.has("custom-one")).toBe(false);

    await controller.handle({ type: "focus", delta: 1 });
    const levels = new Set<string>();
    for (let index = 0; index < 5; index += 1) {
      const modal = controller.snapshot.modal;
      if (modal?.kind === "new_run") levels.add(modal.roles[0]!.thinkingLevel);
      await controller.handle({ type: "details_tab", delta: 1 });
    }
    expect(levels).toEqual(new Set(["off", "minimal", "low", "medium", "high"]));
    controller.dispose();
  });

  it("substitutes an authenticated model for a configured default this Pi installation cannot execute", async () => {
    const models = fixtureModels();
    models[0]!.available = false;
    models[0]!.unavailableReason = "This provider comes from an ambient Pi extension.";
    const client = new FakeAuthority([]);
    const controller = new ControlCenterController({ projectRoot: "/project", client, models });
    await controller.initialize();
    await controller.handle({ type: "open_new_run" });
    await controller.handle({ type: "append_text", text: "Build the notes route" });

    const modal = controller.snapshot.modal;
    expect(modal?.kind).toBe("new_run");
    if (modal?.kind !== "new_run") throw new Error("expected the new-run modal");
    // Planner and Lead are configured on the unavailable model; both move to an executable one.
    expect(modal.roles.map((role) => role.model)).toEqual([
      "gpt-review",
      "gpt-review",
      "gpt-worker",
      "gpt-review",
    ]);
    const component = new ControlCenterComponent({
      controller,
      palette: plainKoniPalette,
      viewportRows: () => 40,
    });
    expect(component.render(120).join("\n")).toContain("openai-codex/gpt-small → openai-codex");
    component.dispose();
    controller.dispose();
  });

  it("explains and refuses a configured model when Pi can execute no model at all", async () => {
    const models = fixtureModels().map((model) => ({
      ...model,
      available: false,
      unavailableReason: "This provider comes from an ambient Pi extension.",
    }));
    const client = new FakeAuthority([]);
    const controller = new ControlCenterController({ projectRoot: "/project", client, models });
    await controller.initialize();
    await controller.handle({ type: "open_new_run" });
    await controller.handle({ type: "append_text", text: "Build the notes route" });
    for (let index = 0; index < 14; index += 1)
      await controller.handle({ type: "focus", delta: 1 });

    const component = new ControlCenterComponent({
      controller,
      palette: plainKoniPalette,
      viewportRows: () => 40,
    });
    expect(component.render(120).join("\n")).toContain("ambient Pi extension");
    await controller.handle({ type: "activate" });
    expect(controller.snapshot.notice).toEqual(
      expect.objectContaining({
        kind: "error",
        message: expect.stringContaining("Planner: openai-codex/gpt-small is unavailable"),
      }),
    );
    expect(client.calls.some((call) => call.method === "run.create")).toBe(false);
    component.dispose();
    controller.dispose();
  });

  it("keeps an invalid configured reasoning default visible but blocks it before run.create", async () => {
    const models = fixtureModels();
    models[0]!.thinkingLevels = ["off", "minimal", "low", "medium"];
    const client = new FakeAuthority([]);
    const controller = new ControlCenterController({ projectRoot: "/project", client, models });
    await controller.initialize();
    await controller.handle({ type: "open_new_run" });
    await controller.handle({ type: "append_text", text: "Build the notes route" });
    for (let index = 0; index < 14; index += 1)
      await controller.handle({ type: "focus", delta: 1 });

    const component = new ControlCenterComponent({
      controller,
      palette: plainKoniPalette,
      viewportRows: () => 40,
    });
    expect(component.render(120).join("\n")).toContain("does not support high reasoning");
    await controller.handle({ type: "activate" });
    expect(controller.snapshot.notice).toEqual(
      expect.objectContaining({
        kind: "error",
        message: expect.stringContaining("does not support high reasoning"),
      }),
    );
    expect(client.calls.some((call) => call.method === "run.create")).toBe(false);
    component.dispose();
    controller.dispose();
  });

  it("reviews agent-authored mini plans with one adaptive Approve or Revise action", async () => {
    const client = new FakeAuthority([awaitingApprovalRun()]);
    const controller = new ControlCenterController({ projectRoot: "/project", client });
    await controller.initialize();
    expect(controller.snapshot.modal?.kind).toBe("plan_review");
    const component = new ControlCenterComponent({
      controller,
      palette: plainKoniPalette,
      viewportRows: () => 42,
    });
    const initial = component.render(120).join("\n");
    expect(initial).toContain("Objective");
    expect(initial).toContain("Build a carefully scoped feature");
    expect(initial).toContain("Run type Medium");
    expect(initial).toContain("Architecture");
    expect(initial).toContain("Decisions");
    expect(initial).toContain("Risk");
    expect(initial).toContain("Verification");
    expect(initial).toContain("Existing seam");
    expect(initial).toContain("Reuse the stable boundary without a parallel abstraction.");
    expect(initial).toContain("Approve run");
    expect(initial).not.toContain("Revise plan");
    expect(initial).not.toContain("FULL-ONLY");

    await controller.handle({ type: "details_tab", delta: 1 });
    await controller.handle({ type: "details_tab", delta: 1 });
    await controller.handle({ type: "details_tab", delta: 1 });
    const verification = component.render(120).join("\n");
    expect(verification).toContain("Graph Seed");
    expect(verification).toContain("Change: Migrate note fields");
    expect(verification).not.toContain("key: change");

    await controller.handle({ type: "focus", delta: 1 });
    await controller.handle({
      type: "append_text",
      text: "Keep the legacy field readable while migrating.",
    });
    await controller.handle({ type: "focus", delta: 1 });
    const revised = component.render(120).join("\n");
    expect(revised).toContain("Revise plan");
    expect(revised).not.toContain("Approve run");
    await controller.handle({ type: "activate" });
    expect(client.calls.find((call) => call.method === "run.action.execute")?.params).toMatchObject(
      {
        protocol: "koni.stage-action-invocation.v1",
        runId: "run-one",
        capabilityId: "stage:approval:revise",
        confirmed: false,
        values: { instructions: "Keep the legacy field readable while migrating." },
      },
    );
    expect(client.calls.some((call) => call.method === "plan.approve")).toBe(false);
    component.dispose();
    controller.dispose();
  });

  it("submits multiline plan steering and returns review to visible planning without approval", async () => {
    const client = new FakeAuthority([awaitingApprovalRun()]);
    const controller = new ControlCenterController({ projectRoot: "/project", client });
    await controller.initialize();
    const component = new ControlCenterComponent({
      controller,
      palette: plainKoniPalette,
      viewportRows: () => 30,
    });

    await controller.handle({ type: "focus", delta: 1 });
    await controller.handle({ type: "append_text", text: "Keep API compatibility." });
    await controller.handle({ type: "activate" });
    await controller.handle({
      type: "append_text",
      text: "Add a rollback check that covers both storage shapes.",
    });
    const editor = component.render(82).join("\n");
    expect(editor).toContain("Keep API compatibility.");
    expect(editor).toContain("Add a rollback check");
    expect(controller.snapshot.modal).toMatchObject({
      kind: "plan_review",
      steering: "Keep API compatibility.\nAdd a rollback check that covers both storage shapes.",
    });

    await controller.handle({ type: "focus", delta: 1 });
    await controller.handle({ type: "activate" });
    expect(client.calls.find((call) => call.method === "run.action.execute")?.params).toMatchObject(
      {
        protocol: "koni.stage-action-invocation.v1",
        runId: "run-one",
        capabilityId: "stage:approval:revise",
        values: {
          instructions:
            "Keep API compatibility.\nAdd a rollback check that covers both storage shapes.",
        },
      },
    );
    expect(client.calls.some((call) => call.method === "plan.approve")).toBe(false);
    expect(controller.snapshot.modal).toBeUndefined();
    expect(controller.snapshot.view.selectedRun?.plan.mode).toBe("activity");
    await controller.handle({ type: "focus_panel", panel: "details" });
    await controller.handle({ type: "details_tab", delta: 1 });
    expect(component.render(120).join("\n")).toContain("Planning activity");
    component.dispose();
    controller.dispose();
  });

  it("edits plan steering at a Unicode caret and keeps the caret visible in wrapped text", async () => {
    const controller = new ControlCenterController({
      projectRoot: "/project",
      client: new FakeAuthority([awaitingApprovalRun()]),
    });
    await controller.initialize();
    await controller.handle({ type: "focus", delta: 1 });
    await controller.handle({ type: "append_text", text: "A🙂B" });
    await controller.handle({ type: "details_tab", delta: -1 });
    await controller.handle({ type: "details_tab", delta: -1 });
    await controller.handle({ type: "append_text", text: "Ω" });
    await controller.handle({ type: "delete_forward" });
    await controller.handle({ type: "activate" });
    expect(controller.snapshot.modal).toMatchObject({
      kind: "plan_review",
      steering: "AΩ\nB",
      steeringCursor: 3,
    });
    const component = new ControlCenterComponent({
      controller,
      palette: plainKoniPalette,
      viewportRows: () => 30,
    });
    expect(component.render(82).join("\n")).toContain("▌");
    component.dispose();
    controller.dispose();
  });

  it("keeps active and historical agents with concise ticket-aware work titles", async () => {
    const run = fixtureRun();
    run.tickets["ticket-one"]!.steps[0]!.title = "Execute compiled work";
    run.attempts["attempt-lead"]!.terminalSummary = undefined;
    run.attempts["attempt-lead"]!.kind = "planning";
    run.attempts["attempt-worker"]!.kind = "ticket";
    const controller = new ControlCenterController({
      projectRoot: "/project",
      client: new FakeAuthority([run]),
    });
    await controller.initialize();

    const unfiltered = controller.snapshot.view.selectedRun!.agents;
    expect(unfiltered.map((agent) => agent.label)).toEqual([
      "Implement feature · Implementer",
      "Lead",
    ]);
    expect(unfiltered.map((agent) => agent.work)).toEqual(["Coordinating tickets", "Planned run"]);
    expect(unfiltered.some((agent) => agent.work === "Execute compiled work")).toBe(false);
    expect(unfiltered.find((agent) => agent.label === "Lead")).toMatchObject({
      active: false,
      status: "completed",
    });

    await controller.handle({ type: "focus_panel", panel: "tickets" });
    await controller.handle({ type: "move", delta: 1 });
    // Passing through the tickets panel never re-scopes the agents list; Enter commits.
    expect(controller.snapshot.view.selectedRun!.agents.map((agent) => agent.label)).toEqual([
      "Implement feature · Implementer",
      "Lead",
    ]);
    await controller.handle({ type: "activate" });
    expect(controller.snapshot.view.selectedRun!.agents.map((agent) => agent.label)).toEqual([
      "Implementer",
    ]);
    controller.dispose();
  });

  it("edits semantic configuration as an in-memory draft and publishes it with hidden CAS", async () => {
    const client = new FakeAuthority([]);
    const controller = new ControlCenterController({
      projectRoot: "/project",
      client,
      models: fixtureModels(),
    });
    await controller.initialize();
    await controller.handle({ type: "open_config" });
    const component = new ControlCenterComponent({
      controller,
      palette: plainKoniPalette,
      viewportRows: () => 44,
    });
    const configured = component.render(122).join("\n");
    expect(configured).toContain("Project");
    expect(configured).toContain("Run Types");
    expect(configured).toContain("Agents");
    expect(configured).toContain("Project identity");
    expect(configured).toContain("Display name");
    expect(configured).not.toContain("project.yaml");
    expect(configured).not.toContain("sha256:");

    await controller.handle({ type: "focus", delta: 1 });
    await controller.handle({ type: "activate" });
    expect(controller.snapshot.modal).toMatchObject({
      kind: "edit_scalar",
      field: { label: "Display name" },
    });
    await controller.handle({ type: "append_text", text: " Studio" });
    await controller.handle({ type: "submit" });
    expect(controller.snapshot.modal).toMatchObject({ kind: "configure" });
    await controller.handle({ type: "save_draft" });
    expect(controller.snapshot.notice?.message).toContain("Draft saved");
    expect(component.render(82).join("\n")).toContain("Notes Studio");
    await controller.handle({ type: "publish" });
    const update = client.calls.find((call) => call.method === "config.update");
    expect(update?.params).toMatchObject({
      cas: { effective: "baseline-1" },
      values: {
        "project.name": "Notes Studio",
        "project.parallel": 3,
        "project.enabled": true,
      },
    });
    expect(update?.expectedRevision).toBeDefined();
    component.dispose();
    controller.dispose();
  });

  it("edits exact project resources through semantic document authority and protects dirty source", async () => {
    let quitCount = 0;
    const client = new FakeAuthority([]);
    const controller = new ControlCenterController({
      projectRoot: "/project",
      client,
      onQuit: () => {
        quitCount += 1;
      },
    });
    await controller.initialize();
    await controller.handle({ type: "open_config" });
    await controller.handle({ type: "open_config_documents" });
    expect(controller.snapshot.modal).toMatchObject({
      kind: "configure_documents",
      focus: "documents",
      dirty: false,
      source: { document: { title: "Project Settings" } },
    });

    const component = new ControlCenterComponent({
      controller,
      palette: plainKoniPalette,
      viewportRows: () => 36,
    });
    const roomy = component.render(120).join("\n");
    expect(roomy).toContain("PROJECT RESOURCES");
    expect(roomy).toContain("Source Editor");
    expect(roomy).toContain("Project Settings");
    expect(roomy).toContain("schema_version");
    expect(roomy).not.toContain("document-project");
    expect(roomy).not.toContain("sha256:");
    expect(roomy).not.toContain(".koni/");
    const compact = component.render(82).join("\n");
    expect(compact.split("\n").every((line) => visibleWidth(line) === 82)).toBe(true);
    await controller.handle({ type: "help" });
    expect(controller.snapshot.modal).toMatchObject({ kind: "help", topic: "configure_documents" });
    expect(component.render(110).join("\n")).toContain("filesystem paths");
    await controller.handle({ type: "cancel" });
    expect(controller.snapshot.modal).toMatchObject({ kind: "configure_documents" });

    await controller.handle({ type: "config_document_delete" });
    expect(controller.snapshot.modal).toMatchObject({
      kind: "config_document_delete",
      canDelete: false,
      reason: expect.stringContaining("required project resource"),
    });
    expect(component.render(110).join("\n")).toContain("required project resource");
    await controller.handle({ type: "details_tab", delta: 1 });
    await controller.handle({ type: "activate" });
    expect(client.calls.some((call) => call.method === "config.documents.delete")).toBe(false);
    await controller.handle({ type: "cancel" });

    await controller.handle({ type: "focus", delta: 1 });
    await controller.handle({ type: "activate" });
    await controller.handle({
      type: "append_text",
      text: "description: Updated in Project Resources\n",
    });
    expect(controller.snapshot.modal).toMatchObject({
      kind: "configure_documents",
      editing: true,
      dirty: true,
    });
    await controller.handle({ type: "cancel" });
    await controller.handle({ type: "cancel" });
    expect(controller.snapshot.modal).toMatchObject({ kind: "configure_documents", dirty: true });
    expect(controller.snapshot.notice?.message).toContain("Save or discard");
    await controller.handle({ type: "config_document_create" });
    expect(controller.snapshot.modal).toMatchObject({ kind: "configure_documents", dirty: true });
    await controller.handle({ type: "quit" });
    expect(quitCount).toBe(0);

    await controller.handle({ type: "save_draft" });
    const update = client.calls.find((call) => call.method === "config.documents.update");
    expect(update).toMatchObject({
      params: {
        documentId: "document-project",
        catalogToken: `sha256:${"1".repeat(64)}`,
        sourceToken: `sha256:${"2".repeat(64)}`,
        source: expect.stringContaining("Updated in Project Resources"),
      },
      expectedRevision: 7,
      idempotencyKey: expect.stringMatching(/^config\.documents\.update:/u),
    });
    expect(controller.snapshot.modal).toMatchObject({
      kind: "configure_documents",
      dirty: false,
      editing: false,
    });
    component.dispose();
    controller.dispose();
  });

  it("creates, renames, and deletes project resources with exact catalog and source tokens", async () => {
    const client = new FakeAuthority([]);
    const controller = new ControlCenterController({ projectRoot: "/project", client });
    await controller.initialize();
    await controller.handle({ type: "open_config" });
    await controller.handle({ type: "open_config_documents" });

    await controller.handle({ type: "config_document_create" });
    expect(controller.snapshot.modal).toMatchObject({
      kind: "config_document_create",
      focus: "choice",
    });
    await controller.handle({ type: "activate" });
    await controller.handle({ type: "append_text", text: "Auditor" });
    await controller.handle({ type: "activate" });
    await controller.handle({ type: "activate" });
    expect(client.calls.find((call) => call.method === "config.documents.create")).toMatchObject({
      params: {
        catalogToken: `sha256:${"1".repeat(64)}`,
        domain: "agents",
        kind: "native_agent",
        format: "yaml",
        title: "Auditor",
      },
      expectedRevision: 7,
    });
    expect(controller.snapshot.modal).toMatchObject({
      kind: "configure_documents",
      source: { document: { title: "Auditor", kind: "native_agent" } },
    });

    const beforeRename = controller.snapshot.modal;
    if (beforeRename?.kind !== "configure_documents" || beforeRename.source === undefined)
      throw new Error("created resource was not selected");
    const renamedDocument = beforeRename.source.document;
    const renameCatalogToken = beforeRename.catalog.catalogToken;
    await controller.handle({ type: "config_document_rename" });
    await controller.handle({ type: "append_text", text: " Prime" });
    await controller.handle({ type: "focus", delta: 1 });
    await controller.handle({ type: "activate" });
    expect(client.calls.find((call) => call.method === "config.documents.rename")).toMatchObject({
      params: {
        documentId: renamedDocument.id,
        catalogToken: renameCatalogToken,
        sourceToken: renamedDocument.sourceToken,
        title: "Auditor Prime",
      },
    });

    const beforeDelete = controller.snapshot.modal;
    if (beforeDelete?.kind !== "configure_documents" || beforeDelete.source === undefined)
      throw new Error("renamed resource was not selected");
    const deletedDocument = beforeDelete.source.document;
    const deleteCatalogToken = beforeDelete.catalog.catalogToken;
    await controller.handle({ type: "config_document_delete" });
    expect(controller.snapshot.modal).toMatchObject({
      kind: "config_document_delete",
      canDelete: true,
      selected: "cancel",
    });
    await controller.handle({ type: "details_tab", delta: 1 });
    await controller.handle({ type: "activate" });
    expect(client.calls.find((call) => call.method === "config.documents.delete")).toMatchObject({
      params: {
        documentId: deletedDocument.id,
        catalogToken: deleteCatalogToken,
        sourceToken: deletedDocument.sourceToken,
      },
    });
    expect(controller.snapshot.modal).toMatchObject({ kind: "configure_documents" });
    const afterDelete = controller.snapshot.configureSurface;
    if (afterDelete?.kind !== "configure_documents")
      throw new Error("Project Resources did not remain open");
    expect(
      afterDelete.catalog.documents.some((document) => document.title === "Auditor Prime"),
    ).toBe(false);
    controller.dispose();
  });

  it("creates run types from compiled templates", async () => {
    const client = new FakeAuthority([]);
    const controller = new ControlCenterController({ projectRoot: "/project", client });
    await controller.initialize();
    await controller.handle({ type: "open_config" });
    await controller.handle({ type: "open_config_documents" });
    await controller.handle({ type: "config_run_type_create" });
    expect(
      client.calls.find((call) => call.method === "config.run-types.templates")?.params,
    ).toEqual({});
    expect(controller.snapshot.modal).toMatchObject({
      kind: "config_run_type_wizard",
      focus: "template",
    });
    const component = new ControlCenterComponent({
      controller,
      palette: plainKoniPalette,
      viewportRows: () => 34,
    });
    const wizard = component.render(112).join("\n");
    expect(wizard).toContain("New run type");
    expect(wizard).toContain("Medium");
    expect(wizard).toContain("Make this the project default");

    await controller.handle({ type: "pointer_control", target: "config-run-type:title" });
    await controller.handle({ type: "append_text", text: "UI Feature" });
    await controller.handle({ type: "pointer_control", target: "config-run-type:slug" });
    await controller.handle({ type: "append_text", text: "ui-feature" });
    await controller.handle({ type: "pointer_control", target: "config-run-type:description" });
    await controller.handle({ type: "append_text", text: "A focused UI delivery workflow." });
    await controller.handle({ type: "pointer_control", target: "config-run-type:default" });
    await controller.handle({ type: "pointer_control", target: "config-run-type:submit" });
    expect(client.calls.find((call) => call.method === "config.run-types.create")).toMatchObject({
      params: {
        catalogToken: `sha256:${"1".repeat(64)}`,
        templateId: "template-medium",
        title: "UI Feature",
        slug: "ui-feature",
        description: "A focused UI delivery workflow.",
        makeDefault: true,
      },
      expectedRevision: 7,
    });
    expect(controller.snapshot.modal).toMatchObject({
      kind: "configure_documents",
      source: { document: { title: "UI Feature", kind: "run_type" } },
    });
    component.dispose();
    controller.dispose();
  });

  it("never discards an unpublished Configure draft when the operator closes Koni", async () => {
    let quitCount = 0;
    const controller = new ControlCenterController({
      projectRoot: "/project",
      client: new FakeAuthority([]),
      onQuit: () => {
        quitCount += 1;
      },
    });
    await controller.initialize();
    await controller.handle({ type: "open_config" });
    await controller.handle({ type: "focus", delta: 1 });
    await controller.handle({ type: "activate" });
    await controller.handle({ type: "append_text", text: " Studio" });
    await controller.handle({ type: "submit" });
    await controller.handle({ type: "quit" });
    expect(quitCount).toBe(0);
    expect(controller.snapshot.notice).toMatchObject({
      kind: "error",
      message: expect.stringContaining("unpublished edits were not discarded"),
    });
    await controller.handle({ type: "discard_draft" });
    await controller.handle({ type: "quit" });
    expect(quitCount).toBe(1);
    controller.dispose();
  });

  it("keeps saved drafts bound to their originating CAS until an explicit rebase", async () => {
    const client = new FakeAuthority([]);
    const controller = new ControlCenterController({ projectRoot: "/project", client });
    await controller.initialize();
    await controller.handle({ type: "open_config" });
    await controller.handle({ type: "focus", delta: 1 });
    await controller.handle({ type: "activate" });
    await controller.handle({ type: "append_text", text: " Studio" });
    await controller.handle({ type: "submit" });
    await controller.handle({ type: "save_draft" });
    await controller.handle({ type: "cancel" });
    await controller.handle({ type: "cancel" });
    client.simulateExternalConfiguration({ "project.name": "External change" }, "baseline-2");

    await controller.handle({ type: "open_config" });
    expect(controller.snapshot.modal).toMatchObject({ kind: "configure", rebaseRequired: true });
    await controller.handle({ type: "publish" });
    expect(client.calls.some((call) => call.method === "config.update")).toBe(false);
    await controller.handle({ type: "rebase_draft" });
    expect(controller.snapshot.modal).toMatchObject({ kind: "configure", rebaseRequired: false });
    expect(controller.snapshot.notice?.message).toContain("overlapping field");
    await controller.handle({ type: "publish" });
    expect(client.calls.find((call) => call.method === "config.update")?.params).toEqual({
      cas: { effective: "baseline-2" },
      values: { "project.name": "Notes Studio" },
    });
    controller.dispose();
  });

  it("edits scalar drafts with a Unicode caret and validates typed values before returning", async () => {
    const controller = new ControlCenterController({
      projectRoot: "/project",
      client: new FakeAuthority([]),
    });
    await controller.initialize();
    await controller.handle({ type: "open_config" });
    await controller.handle({ type: "focus", delta: 1 });
    await controller.handle({ type: "activate" });
    await controller.handle({ type: "scroll_home" });
    await controller.handle({ type: "details_tab", delta: 1 });
    await controller.handle({ type: "append_text", text: "🧪" });
    expect(controller.snapshot.modal).toMatchObject({
      kind: "edit_scalar",
      value: "N🧪otes",
      cursor: 2,
    });
    await controller.handle({ type: "cancel" });

    await controller.handle({ type: "move", delta: 1 });
    await controller.handle({ type: "activate" });
    await controller.handle({ type: "scroll_end" });
    await controller.handle({ type: "backspace" });
    await controller.handle({ type: "append_text", text: "0" });
    await controller.handle({ type: "submit" });
    expect(controller.snapshot.modal).toMatchObject({
      kind: "edit_scalar",
      error: "Max parallel must be at least 1.",
    });
    await controller.handle({ type: "backspace" });
    await controller.handle({ type: "append_text", text: "4" });
    await controller.handle({ type: "submit" });
    expect(controller.snapshot.modal).toMatchObject({
      kind: "configure",
      draft: { "project.parallel": 4 },
    });

    await controller.handle({ type: "move", delta: 1 });
    await controller.handle({ type: "activate" });
    await controller.handle({ type: "scroll_home" });
    for (let index = 0; index < 4; index += 1) await controller.handle({ type: "delete_forward" });
    await controller.handle({ type: "append_text", text: "false" });
    await controller.handle({ type: "submit" });
    expect(controller.snapshot.modal).toMatchObject({
      kind: "configure",
      draft: { "project.enabled": false },
    });
    controller.dispose();
  });

  it("creates, duplicates, and deletes whole semantic resources through opaque authority actions", async () => {
    const client = new FakeAuthority([]);
    const controller = new ControlCenterController({ projectRoot: "/project", client });
    await controller.initialize();
    await controller.handle({ type: "open_config" });
    const component = new ControlCenterComponent({
      controller,
      palette: plainKoniPalette,
      viewportRows: () => 40,
    });
    const configured = component.render(110).join("\n");
    expect(configured).toContain("[a] Add");
    expect(configured).toContain("[d] Duplicate");
    expect(configured).toContain("[x] Delete");
    expect(configured).not.toContain("template-project");

    await controller.handle({ type: "config_resource_create" });
    expect(component.render(110).join("\n")).toContain("Add resource");
    expect(component.render(110).join("\n")).toContain("Project preset");
    await controller.handle({ type: "activate" });
    await controller.handle({ type: "activate" });
    expect(client.calls.find((call) => call.method === "config.resource.create")).toMatchObject({
      params: {
        cas: { effective: "baseline-1" },
        sectionId: "project",
        templateId: "template-project",
        name: "New project preset",
      },
      expectedRevision: 7,
    });

    await controller.handle({ type: "config_resource_duplicate" });
    expect(component.render(110).join("\n")).toContain("Duplicate resource");
    await controller.handle({ type: "activate" });
    await controller.handle({ type: "activate" });
    expect(
      client.calls.find((call) => call.method === "config.resource.duplicate")?.params,
    ).toEqual({
      cas: { effective: "baseline-1" },
      resourceId: "project-resource",
      name: "Project identity copy",
    });

    await controller.handle({ type: "config_resource_delete" });
    const confirmation = component.render(110).join("\n");
    expect(confirmation).toContain("Delete resource");
    expect(confirmation).toContain("project configuration remain valid");
    await controller.handle({ type: "activate" });
    expect(client.calls.find((call) => call.method === "config.resource.delete")?.params).toEqual({
      cas: { effective: "baseline-1" },
      resourceId: "project-resource",
    });
    component.dispose();
    controller.dispose();
  });

  it("keeps the selected semantic configuration domain visible at compact width", async () => {
    const controller = new ControlCenterController({
      projectRoot: "/project",
      client: new FakeAuthority([]),
    });
    await controller.initialize();
    await controller.handle({ type: "open_config" });
    for (let index = 0; index < 7; index += 1)
      await controller.handle({ type: "details_tab", delta: 1 });
    const component = new ControlCenterComponent({
      controller,
      palette: plainKoniPalette,
      viewportRows: () => 28,
    });
    const compact = component.render(82).join("\n");
    expect(compact).toContain("Advanced settings");
    expect(compact).toContain("Advanced");
    expect(compact.split("\n").every((line) => visibleWidth(line) === 82)).toBe(true);
    component.dispose();
    controller.dispose();
  });

  it("compares and resolves pending upstream profile changes without exposing lifecycle hashes", async () => {
    const client = new FakeAuthority([]);
    client.setProfileConflicts(fixtureProfileConflictCatalog());
    const controller = new ControlCenterController({ projectRoot: "/project", client });
    await controller.initialize();
    await controller.handle({ type: "open_config" });
    const component = new ControlCenterComponent({
      controller,
      palette: plainKoniPalette,
      viewportRows: () => 36,
    });
    const configured = component.render(112).join("\n");
    expect(configured).toContain("1 upstream change needs review");
    expect(configured).toContain("[u] Open comparison");

    await controller.handle({ type: "open_conflicts" });
    const comparison = component.render(112).join("\n");
    expect(comparison).toContain("Upstream changes");
    expect(comparison).toContain("Pi Packages");
    expect(comparison).toContain("Project version");
    expect(comparison).toContain("Upstream update");
    expect(comparison).toContain("project-tool");
    expect(comparison).toContain("upstream-tool");
    expect(comparison).toContain("Keep project");
    expect(comparison).toContain("Use update");
    expect(comparison).not.toContain("sha256:");

    await controller.handle({ type: "focus", delta: 1 });
    await controller.handle({ type: "details_tab", delta: 1 });
    await controller.handle({ type: "activate" });
    const resolution = client.calls.find((call) => call.method === "profile.conflicts.resolve");
    expect(resolution).toMatchObject({
      params: {
        path: "resources/pi-packages.yaml",
        expectedLifecycleGeneration: 3,
        expectedProjectSha256: `sha256:${"c".repeat(64)}`,
        resolution: "accept_upstream",
      },
      expectedRevision: 7,
    });
    expect(resolution?.idempotencyKey).toMatch(/^profile\.conflicts\.resolve:/u);
    expect(controller.snapshot.modal).toMatchObject({ kind: "configure" });
    expect(controller.snapshot.notice?.message).toContain(
      "All upstream profile changes are resolved",
    );
    component.dispose();
    controller.dispose();
  });

  it("keeps the selected conflict and documents atomic when another inspection fails", async () => {
    const client = new FakeAuthority([]);
    client.setProfileConflicts(fixtureProfileConflictCatalog(true));
    client.failConflictInspection("agents/reviewer.yaml");
    const controller = new ControlCenterController({ projectRoot: "/project", client });
    await controller.initialize();
    await controller.handle({ type: "open_config" });
    await controller.handle({ type: "open_conflicts" });
    expect(controller.snapshot.modal).toMatchObject({
      kind: "profile_conflicts",
      selectedIndex: 0,
      inspection: { conflict: { path: "resources/pi-packages.yaml" } },
    });

    await controller.handle({ type: "move", delta: 1 });
    expect(controller.snapshot.modal).toMatchObject({
      kind: "profile_conflicts",
      selectedIndex: 0,
      inspection: {
        conflict: { path: "resources/pi-packages.yaml" },
        currentText: expect.stringContaining("project-tool"),
      },
    });
    expect(controller.snapshot.notice?.message).toContain("inspection fixture failed");
    controller.dispose();
  });

  it("renders the complete native Pi transcript and sends composer text through agent authority", async () => {
    const client = new FakeAuthority([fixtureRun()]);
    const controller = new ControlCenterController({ projectRoot: "/project", client });
    await controller.initialize();
    await controller.handle({ type: "focus_panel", panel: "agents" });
    await controller.handle({ type: "move", delta: 1 });
    await controller.handle({ type: "activate" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const component = new ControlCenterComponent({
      controller,
      palette: plainKoniPalette,
      viewportRows: () => 48,
    });
    const collapsed = component.render(150).join("\n");
    expect(collapsed).toContain("I inspected the existing notes route.");
    expect(collapsed).toContain("Reasoning");
    expect(collapsed).toContain("Need to preserve the storage seam.");
    // Tool activity folds away by default; Ctrl-O reveals the exact receipts.
    expect(collapsed).not.toContain("Loaded the existing component.");
    expect(collapsed).toContain("tool event");
    await controller.handle({ type: "context_toggle" });
    const transcript = component.render(150).join("\n");
    expect(transcript).toContain("Read File");
    expect(transcript).toContain("Loaded the existing component.");
    expect(
      controller.snapshot.chat?.blocks.some(
        (block) => block.markdown === "Alternative branch summary." && block.branch,
      ),
    ).toBe(true);
    expect(transcript).not.toContain("Pi event");

    await controller.handle({ type: "toggle_chat_composer" });
    await controller.handle({ type: "append_text", text: "Keep the public route stable." });
    await controller.handle({ type: "submit" });
    expect(client.calls.find((call) => call.method === "agent.steer")?.params).toEqual({
      attemptId: "attempt-worker",
      text: "Keep the public route stable.",
    });
    component.dispose();
    controller.dispose();
  });

  it("closes an in-flight chat draft and preserves the next follow-up boundary", async () => {
    const client = new FakeAuthority([fixtureRun()]);
    const controller = new ControlCenterController({ projectRoot: "/project", client });
    await controller.initialize();
    await controller.handle({ type: "focus_panel", panel: "agents" });
    await controller.handle({ type: "move", delta: 1 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await controller.handle({ type: "activate" });
    await controller.handle({ type: "toggle_chat_composer" });
    await controller.handle({ type: "append_text", text: "Keep the public route stable." });

    const release = client.deferRequest("agent.steer");
    const firstSend = controller.handle({ type: "submit" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(controller.snapshot.chat?.draft).toMatchObject({ editing: false, text: "" });
    expect(controller.snapshot.busy).toBe("Steering agent…");

    await controller.handle({ type: "toggle_chat_composer" });
    expect(controller.snapshot.chat?.draft.editing).toBe(false);
    release();
    await firstSend;

    await controller.handle({ type: "toggle_chat_composer" });
    await controller.handle({ type: "toggle_chat_mode" });
    await controller.handle({ type: "append_text", text: "Queue this after the current turn." });
    await controller.handle({ type: "submit" });
    expect(client.calls.find((call) => call.method === "agent.follow_up")?.params).toEqual({
      attemptId: "attempt-worker",
      text: "Queue this after the current turn.",
    });
    controller.dispose();
  });

  it("navigates every bounded history window in both directions and reloads live head output", async () => {
    const client = new FakeAuthority([fixtureRun()]);
    client.setTranscriptBlocks(
      Array.from({ length: TRANSCRIPT_PAGE_LIMIT * 2 + 7 }, (_, index) =>
        fixtureTranscriptBlock(`entry-${index}`, `Assistant message ${index}`),
      ),
    );
    const controller = new ControlCenterController({ projectRoot: "/project", client });
    await controller.initialize();
    await controller.handle({ type: "focus_panel", panel: "agents" });
    await controller.handle({ type: "move", delta: 1 });
    await controller.handle({ type: "activate" });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const expectWindow = (start: number, length: number, first: number, last: number): void => {
      const chat = controller.snapshot.chat!;
      expect(chat.history).toMatchObject({
        startBlock: start,
        visibleBlocks: length,
        totalBlocks: 135,
      });
      expect(chat.blocks).toHaveLength(length);
      expect(chat.blocks[0]?.markdown).toBe(`Assistant message ${first}`);
      expect(chat.blocks.at(-1)?.markdown).toBe(`Assistant message ${last}`);
      expect(chat.blocks.length).toBeLessThanOrEqual(TRANSCRIPT_PAGE_LIMIT);
    };
    expectWindow(71, 64, 71, 134);
    await controller.handle({ type: "transcript_page", delta: -1 });
    expectWindow(7, 64, 7, 70);
    await controller.handle({ type: "transcript_page", delta: -1 });
    expectWindow(0, 7, 0, 6);
    await controller.handle({ type: "transcript_page", delta: 1 });
    expectWindow(7, 64, 7, 70);
    await controller.handle({ type: "transcript_page", delta: 1 });
    expectWindow(71, 64, 71, 134);
    await controller.handle({ type: "transcript_page", delta: -1 });
    await controller.handle({ type: "transcript_page", delta: -1 });
    expectWindow(0, 7, 0, 6);

    client.appendTranscriptBlock(fixtureTranscriptBlock("entry-live", "New live output"));
    client.emit("agent.usage");
    await new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));
    expectWindow(0, 7, 0, 6);

    await controller.handle({ type: "refresh" });
    const latest = controller.snapshot.chat!;
    expect(latest.history).toEqual({
      startBlock: 72,
      visibleBlocks: 64,
      totalBlocks: 136,
      hasOlder: true,
      hasNewer: false,
    });
    expect(latest.blocks.at(-1)?.markdown).toBe("New live output");

    const transcriptCalls = client.calls.filter((call) => call.method === "run.transcript");
    expect(transcriptCalls[0]?.params).toEqual({
      runId: "run-one",
      attemptId: "attempt-worker",
      limit: TRANSCRIPT_PAGE_LIMIT,
    });
    expect(
      transcriptCalls.filter((call) => isRecord(call.params) && call.params.cursor === undefined),
    ).toHaveLength(2);
    expect(
      transcriptCalls
        .slice(1, -1)
        .every(
          (call) =>
            isRecord(call.params) &&
            typeof call.params.cursor === "string" &&
            call.params.limit === TRANSCRIPT_PAGE_LIMIT,
        ),
    ).toBe(true);
    controller.dispose();
  });

  it("rejects silent oversized blocks and contains terminal controls before Markdown", () => {
    const prefix = `start\u001b]2;hostile-title\u0007\u001b[2J\u001bPhostile-dcs\u001b\\\u202e`;
    const body = "x".repeat(MAX_PROJECTED_TRANSCRIPT_BLOCK_CHARACTERS + 8_192);
    expect(() =>
      parsePiTranscriptPage(
        fixtureTranscriptPage([
          {
            ...fixtureTranscriptBlock("large-result", `${prefix}${body}tail`),
            kind: "tool_result",
            title: "Read File",
          },
        ]),
      ),
    ).toThrow("oversized Pi transcript block");

    const safe = parsePiTranscriptPage(
      fixtureTranscriptPage([fixtureTranscriptBlock("safe-result", `${prefix}visible tail`)]),
    ).blocks[0]!.markdown;
    expect(safe).toContain("startvisible tail");
    expect(safe).not.toContain("hostile-title");
    expect(safe).not.toContain("hostile-dcs");
    expect(safe).not.toContain("\u001b");
    expect(safe).not.toContain("\u202e");
  });

  it("fails closed on snapshot drift while preserving the selected transcript window", async () => {
    const client = new FakeAuthority([fixtureRun()]);
    client.setTranscriptBlocks(
      Array.from({ length: TRANSCRIPT_PAGE_LIMIT + 5 }, (_, index) =>
        fixtureTranscriptBlock(`entry-${index}`, `Assistant message ${index}`),
      ),
    );
    const controller = new ControlCenterController({ projectRoot: "/project", client });
    await controller.initialize();
    await controller.handle({ type: "select_agent", attemptId: "attempt-worker" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const before = structuredClone(controller.snapshot.chat);

    client.driftTranscriptSnapshotOnce();
    await controller.handle({ type: "transcript_page", delta: -1 });

    expect(controller.snapshot.chat).toEqual(before);
    expect(controller.snapshot.notice?.message).toContain("stable snapshot");
    controller.dispose();
  });

  it("preserves per-agent history and ignores a stale response after switching agents", async () => {
    const client = new FakeAuthority([fixtureRun()]);
    client.setTranscriptBlocks(
      Array.from({ length: TRANSCRIPT_PAGE_LIMIT + 2 }, (_, index) =>
        fixtureTranscriptBlock(`worker-${index}`, `Worker message ${index}`),
      ),
    );
    client.setTranscriptBlocks(
      [fixtureTranscriptBlock("lead-message", "Lead planning transcript")],
      "attempt-lead",
    );
    const controller = new ControlCenterController({ projectRoot: "/project", client });
    await controller.initialize();
    await controller.handle({ type: "select_agent", attemptId: "attempt-worker" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await controller.handle({ type: "transcript_page", delta: -1 });
    expect(controller.snapshot.chat?.history.startBlock).toBe(0);

    await controller.handle({ type: "select_agent", attemptId: "attempt-lead" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(controller.snapshot.chat?.blocks[0]?.markdown).toBe("Lead planning transcript");
    await controller.handle({ type: "select_agent", attemptId: "attempt-worker" });
    expect(controller.snapshot.chat?.history.startBlock).toBe(0);
    expect(controller.snapshot.chat?.blocks[0]?.markdown).toBe("Worker message 0");

    const delayed = new FakeAuthority([fixtureRun()]);
    delayed.setTranscriptBlocks([fixtureTranscriptBlock("worker-stale", "Stale worker result")]);
    delayed.setTranscriptBlocks(
      [fixtureTranscriptBlock("lead-current", "Current lead result")],
      "attempt-lead",
    );
    const release = delayed.deferTranscript("attempt-worker");
    const switched = new ControlCenterController({ projectRoot: "/project", client: delayed });
    await switched.initialize();
    await switched.handle({ type: "select_agent", attemptId: "attempt-worker" });
    await switched.handle({ type: "select_agent", attemptId: "attempt-lead" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(switched.snapshot.chat?.blocks[0]?.markdown).toBe("Current lead result");
    release();
    await new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));
    expect(switched.snapshot.selection.attemptId).toBe("attempt-lead");
    expect(switched.snapshot.chat?.blocks[0]?.markdown).toBe("Current lead result");
    switched.dispose();
    controller.dispose();
  });

  it("does not let the same attempt id share loading state, transcript, or composer text across runs", async () => {
    const first = fixtureRun();
    const second = fixtureRunWithId("run-two");
    const client = new FakeAuthority([first, second]);
    client.setTranscriptBlocks(
      [fixtureTranscriptBlock("first-run", "First run transcript")],
      "attempt-worker",
      "run-one",
    );
    client.setTranscriptBlocks(
      [fixtureTranscriptBlock("second-run", "Second run transcript")],
      "attempt-worker",
      "run-two",
    );
    const releaseFirst = client.deferTranscript("attempt-worker", "run-one");
    const controller = new ControlCenterController({ projectRoot: "/project", client });
    await controller.initialize();
    expect(controller.snapshot.selection.runId).toBe("run-one");
    await controller.handle({ type: "select_agent", attemptId: "attempt-worker" });
    await controller.handle({ type: "toggle_chat_composer" });
    await controller.handle({ type: "append_text", text: "First run steering draft" });

    await controller.handle({ type: "select_run", runId: "run-two" });
    await controller.handle({ type: "select_agent", attemptId: "attempt-worker" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(controller.snapshot.chat?.status).toBe("ready");
    expect(controller.snapshot.chat?.blocks[0]?.markdown).toBe("Second run transcript");
    expect(controller.snapshot.chat?.draft.text).toBe("");

    releaseFirst();
    await new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));
    expect(controller.snapshot.selection).toMatchObject({
      runId: "run-two",
      attemptId: "attempt-worker",
    });
    expect(controller.snapshot.chat?.blocks[0]?.markdown).toBe("Second run transcript");

    await controller.handle({ type: "select_run", runId: "run-one" });
    await controller.handle({ type: "select_agent", attemptId: "attempt-worker" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(controller.snapshot.chat?.blocks[0]?.markdown).toBe("First run transcript");
    expect(controller.snapshot.chat?.draft.text).toBe("First run steering draft");
    controller.dispose();
  });

  it("rejects malformed transcript snapshot, cursor, identity, and chunk metadata", () => {
    const valid = fixtureTranscriptPage([fixtureTranscriptBlock("entry", "complete")]);
    const rejects = (mutate: (page: ReturnType<typeof fixtureTranscriptPage>) => void): void => {
      const page = structuredClone(valid);
      mutate(page);
      expect(() => parsePiTranscriptPage(page)).toThrow(/transcript/u);
    };
    rejects((page) => {
      delete page.snapshot.lastEntryId;
    });
    rejects((page) => {
      page.previousCursor = "unexpected";
    });
    rejects((page) => {
      page.previousCursor = "x".repeat(4 * 1024 + 1);
    });
    rejects((page) => {
      (page as { diagnostics: string[] }).diagnostics = Array.from(
        { length: 33 },
        () => "diagnostic",
      );
    });
    rejects((page) => {
      page.blocks[0]!.id = "";
    });
    rejects((page) => {
      page.blocks[0]!.truncated = true;
      page.blocks[0]!.chunk = { index: 1, total: 2, totalBytes: 8 };
      page.blocks[0]!.id = "entry:chunk-2";
    });
    rejects((page) => {
      page.blocks.push({ ...page.blocks[0]! });
      page.totalBlocks = 2;
      page.snapshot.entryCount = 2;
    });
    const empty = fixtureTranscriptPage([]);
    empty.snapshot.lastEntryId = "unexpected";
    expect(() => parsePiTranscriptPage(empty)).toThrow(/terminal entry identity/u);

    const completeChunks = fixtureTranscriptPage([
      {
        ...fixtureTranscriptBlock("chunked:chunk-1", "a"),
        truncated: true,
        chunk: { index: 1, total: 2, totalBytes: 2 },
      },
      {
        ...fixtureTranscriptBlock("chunked:chunk-2", "b"),
        truncated: true,
        chunk: { index: 2, total: 2, totalBytes: 2 },
      },
    ]);
    expect(
      parsePiTranscriptPage(completeChunks)
        .blocks.map((block) => block.markdown)
        .join(""),
    ).toBe("ab");
    completeChunks.blocks[1]!.chunk!.totalBytes = 3;
    expect(() => parsePiTranscriptPage(completeChunks)).toThrow(/chunks disagree/u);
  });

  it("treats bracketed paste as literal multiline editor input and decodes SGR pointers", async () => {
    const client = new FakeAuthority([awaitingApprovalRun()]);
    const controller = new ControlCenterController({ projectRoot: "/project", client });
    await controller.initialize();
    const component = new ControlCenterComponent({
      controller,
      palette: plainKoniPalette,
      viewportRows: () => 36,
    });
    await controller.handle({ type: "focus", delta: 1 });
    component.handleInput("\u001b[200~nqhd\nKeep every command letter literal.\u001b[201~");
    await Promise.resolve();
    expect(controller.snapshot.modal).toMatchObject({
      kind: "plan_review",
      steering: "nqhd\nKeep every command letter literal.",
    });
    expect(decodeControlCenterPointer("\u001b[<0;12;7M")).toEqual({
      kind: "press",
      button: "left",
      x: 11,
      y: 6,
    });
    expect(decodeControlCenterPointer("\u001b[<64;12;7M")).toEqual({
      kind: "wheel",
      delta: -1,
      x: 11,
      y: 6,
    });
    component.dispose();
    controller.dispose();
  });

  it("opens compiler-authored actions, explains disabled rows, and submits a typed form", async () => {
    const client = new FakeAuthority([orchestrationRun()]);
    const controller = new ControlCenterController({ projectRoot: "/project", client });
    await controller.initialize();
    await controller.handle({ type: "open_actions" });
    expect(controller.snapshot.modal).toMatchObject({
      kind: "action_palette",
      title: "Run actions",
    });
    const component = new ControlCenterComponent({
      controller,
      palette: plainKoniPalette,
      viewportRows: () => 20,
    });
    const palette = component.renderFrame(82, 20).toPlainLines().join("\n");
    expect(palette).toContain("Run actions");
    expect(palette).toContain("Resume is not available now");

    await controller.handle({ type: "move", delta: 1 });
    await controller.handle({ type: "move", delta: 1 });
    await controller.handle({ type: "activate" });
    expect(controller.snapshot.modal).toMatchObject({
      kind: "action_form",
      values: { maxParallel: 2 },
      focus: "fields",
    });
    const form = component.renderFrame(140, 42);
    expect(form.toPlainLines().join("\n")).toContain("Max parallel agents");
    expect(findHitTarget(form, "action-field:0")).toBeDefined();
    expect(findHitTarget(form, "action-submit")).toBeDefined();
    await controller.handle({ type: "details_tab", delta: 1 });
    await controller.handle({ type: "focus", delta: 1 });
    await controller.handle({ type: "activate" });
    expect(
      client.calls.find(
        (call) =>
          call.method === "run.action.execute" &&
          isRecord(call.params) &&
          call.params.capabilityId === "run:orchestration",
      ),
    ).toMatchObject({
      params: {
        protocol: "koni.stage-action-invocation.v1",
        runId: "run-one",
        runRevision: 4,
        generation: 0,
        capabilityId: "run:orchestration",
        confirmed: false,
        values: { maxParallel: 3 },
      },
    });
    component.dispose();
    controller.dispose();
  });

  it("shows one merge review when run and promotion stage project the same capability", async () => {
    const run = fixtureRun();
    run.lifecycle.phase = "merge_ready";
    run.currentPipelineStageId = "promotion";
    const client = new FakeAuthority([run]);
    const controller = new ControlCenterController({ projectRoot: "/project", client });
    await controller.initialize();
    await controller.handle({ type: "open_actions" });
    const modal = controller.snapshot.modal;
    expect(modal?.kind).toBe("action_palette");
    expect(
      modal?.kind === "action_palette"
        ? modal.actions.filter((action) => action.intent === "inspect_run_merge")
        : [],
    ).toHaveLength(1);
    controller.dispose();
  });

  it("keeps a durable question batch saved, revisable, navigable, recommended, and explicitly resolvable", async () => {
    const client = new FakeAuthority([questionBatchRun()]);
    const controller = new ControlCenterController({ projectRoot: "/project", client });
    await controller.initialize();
    expect(controller.snapshot.notice, JSON.stringify(controller.snapshot.notice)).toBeUndefined();
    await controller.handle({ type: "open_question" });
    expect(controller.snapshot.questionDraft?.selectedOptionId).toBe("additive");
    const component = new ControlCenterComponent({
      controller,
      palette: plainKoniPalette,
      viewportRows: () => 36,
    });
    expect(component.render(120).join("\n")).toContain("★ Recommended");

    await controller.handle({ type: "submit" });
    expect(controller.snapshot.modal).toMatchObject({
      kind: "answer_question",
      questionId: "question-rollout",
    });
    expect(
      client.calls.some(
        (call) =>
          call.method === "question.answer" &&
          isRecord(call.params) &&
          call.params.questionId === "question-storage",
      ),
    ).toBe(true);

    await controller.handle({ type: "details_tab", delta: -1 });
    await controller.handle({ type: "move", delta: 1 });
    await controller.handle({ type: "submit" });
    expect(
      client.calls.some(
        (call) =>
          call.method === "question.revise" &&
          isRecord(call.params) &&
          call.params.questionId === "question-storage",
      ),
    ).toBe(true);
    expect(controller.snapshot.modal).toMatchObject({
      kind: "answer_question",
      questionId: "question-rollout",
    });

    await controller.handle({ type: "focus", delta: 1 });
    await controller.handle({
      type: "append_text",
      text: "Keep the first rollout narrowly scoped.",
    });
    await controller.handle({ type: "focus", delta: 1 });
    await controller.handle({ type: "activate" });
    expect(
      client.calls.some(
        (call) =>
          call.method === "run.action.execute" &&
          isRecord(call.params) &&
          call.params.capabilityId === "run:questions:resolve",
      ),
    ).toBe(true);
    expect(controller.snapshot.modal).toBeUndefined();
    expect(controller.snapshot.view.selectedRun?.questions).toBeUndefined();
    component.dispose();
    controller.dispose();
  });

  it("projects semantic attempt lineage into Agents and Chat without rendering opaque IDs", async () => {
    const client = new FakeAuthority([lineageRun()]);
    const controller = new ControlCenterController({ projectRoot: "/project", client });
    await controller.initialize();
    expect(controller.snapshot.notice, JSON.stringify(controller.snapshot.notice)).toBeUndefined();
    const retry = controller.snapshot.view.selectedRun?.agents.find(
      (agent) => agent.id === "attempt-worker-retry",
    );
    expect(retry?.lineage).toMatchObject({
      reason: "Retry",
      branch: "Branch 2",
      parent: "Implementer · Implement feature",
      activeLeaf: true,
    });
    const parent = controller.snapshot.view.selectedRun?.agents.find(
      (agent) => agent.id === "attempt-worker",
    );
    expect(parent?.lineage?.children).toContain("Implementer · Implement feature");
    // Lineage renders as nesting: the retry indents under its parent attempt.
    const ordered = controller.snapshot.view.selectedRun!.agents;
    const parentIndex = ordered.findIndex((agent) => agent.id === "attempt-worker");
    const retryIndex = ordered.findIndex((agent) => agent.id === "attempt-worker-retry");
    expect(retryIndex).toBe(parentIndex + 1);
    expect(ordered[retryIndex]?.depth).toBe((ordered[parentIndex]?.depth ?? 0) + 1);
    await controller.handle({ type: "select_agent", attemptId: "attempt-worker-retry" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const component = new ControlCenterComponent({
      controller,
      palette: plainKoniPalette,
      viewportRows: () => 42,
    });
    const chat = component.render(140).join("\n");
    // The agents panel shows the branch as an indented row with a leaf marker; the chat panel
    // no longer repeats lineage metadata as text and never exposes opaque ids.
    expect(chat).toContain("└ ");
    expect(chat).toContain("· leaf");
    expect(chat).not.toContain("Lineage Retry");
    expect(chat).not.toContain("attempt-worker-retry");
    component.dispose();
    controller.dispose();
  });
});

describe("control center component", () => {
  it("uses the rendered cell geometry for pointer selection and wheel routing", async () => {
    const controller = new ControlCenterController({
      projectRoot: "/project",
      client: new FakeAuthority([fixtureRun()]),
    });
    await controller.initialize();
    const component = new ControlCenterComponent({
      controller,
      palette: plainKoniPalette,
      viewportRows: () => 40,
    });
    const frame = component.renderFrame(122, 40);
    const agentCell = findHitTarget(frame, "agent:attempt-worker");
    expect(agentCell).toBeDefined();
    component.handleInput(`\u001b[<0;${agentCell!.x + 1};${agentCell!.y + 1}M`);
    await Promise.resolve();
    expect(controller.snapshot.selection).toMatchObject({
      attemptId: "attempt-worker",
      detailsTab: "chat",
    });

    const activity = frame.regions.find((region) => region.name === "activity")!.rect;
    component.handleInput(`\u001b[<65;${activity.x + 2};${activity.y + 2}M`);
    await Promise.resolve();
    expect(controller.snapshot.focus).toBe("activity");
    expect(controller.snapshot.scroll.activity).toBe(3);
    component.dispose();
    controller.dispose();
  });

  it("uses semantic hit regions throughout Project Resources", async () => {
    const controller = new ControlCenterController({
      projectRoot: "/project",
      client: new FakeAuthority([]),
    });
    await controller.initialize();
    await controller.handle({ type: "open_config" });
    await controller.handle({ type: "open_config_documents" });
    const component = new ControlCenterComponent({
      controller,
      palette: plainKoniPalette,
      viewportRows: () => 36,
    });

    let frame = component.renderFrame(120, 36);
    const agents = findHitTarget(frame, "config-doc:domain:2");
    expect(agents).toBeDefined();
    component.handleInput(`\u001b[<0;${agents!.x + 1};${agents!.y + 1}M`);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(controller.snapshot.modal).toMatchObject({
      kind: "configure_documents",
      domainIndex: 2,
      source: { document: { title: "Implementer" } },
    });

    frame = component.renderFrame(120, 36);
    const create = findHitTarget(frame, "config-doc:create");
    expect(create).toBeDefined();
    component.handleInput(`\u001b[<0;${create!.x + 1};${create!.y + 1}M`);
    await Promise.resolve();
    expect(controller.snapshot.modal).toMatchObject({ kind: "config_document_create" });
    component.dispose();
    controller.dispose();
  });

  it("renders equal wide columns and the requested overview, activity, agents, questions, and graph semantics", async () => {
    const client = new FakeAuthority([fixtureRun()]);
    const controller = new ControlCenterController({
      projectRoot: "/project",
      client,
      now: () => 20_000,
    });
    await controller.initialize();
    const component = new ControlCenterComponent({
      controller,
      palette: plainKoniPalette,
      viewportRows: () => 48,
    });
    // The details panel opens on the Graph feed with its run-scope header line and node rows.
    const feedText = component.render(150).join("\n");
    expect(feedText).toContain("Graph · Run integration");
    expect(feedText).toContain("Claim result");
    expect(feedText).not.toContain("claim-one");
    // Overview is one bracket-step to the left of the default Graph tab.
    await controller.handle({ type: "focus_panel", panel: "details" });
    await controller.handle({ type: "details_tab", delta: -1 });
    const lines = component.render(150);
    const text = lines.join("\n");

    expect(lines).toHaveLength(48);
    expect(lines.every((line) => visibleWidth(line) === 150)).toBe(true);
    const columnTop = lines.find((line) => line.includes("Runs") && line.includes("Details:"));
    expect(columnTop).toBeDefined();
    expect(columnTop!.slice(0, 51)).toContain("Runs");
    expect(columnTop!.slice(51, 150)).toContain("Details: Graph - Plan - Overview");
    // Activity now closes out the left column, under the squished Agents panel.
    const activityTop = lines.find((line) => line.includes("Activity"));
    expect(activityTop).toBeDefined();
    expect(activityTop!.slice(0, 51)).toContain("Activity");
    expect(text).toContain("Agents");
    expect(text).toContain("Objective");
    expect(text).not.toContain("Goal");
    expect(text).toContain("Run");
    expect(text).toContain("Evidence");
    expect(text).toContain("Stages");
    expect(text).toContain("Activity · 17s active");
    expect(text).toContain("Lead");
    expect(text).toContain("Architecture boundary mapped");

    await controller.handle({ type: "focus_panel", panel: "questions" });
    const questionText = component.render(84).join("\n");
    expect(questionText).toContain("How should existing notes");
    expect(questionText).toContain("transition to the new");
    expect(questionText).toContain("Preserve existing");
    // The merged right section widens Questions, so the description wraps later than before.
    expect(questionText).toContain("expose it in the");
    expect(questionText).toContain("first field.");
    expect(questionText).toContain("←→/[] · ↑↓/jk · Enter · [n] notes");
    await controller.handle({ type: "activate" });
    const answerModal = component.render(84).join("\n");
    expect(answerModal).toContain("None of the above");
    expect(answerModal).toContain("Notes (optional)");
    expect(answerModal).toContain("Submit answer");
    await controller.handle({ type: "cancel" });

    await controller.handle({ type: "focus_panel", panel: "details" });
    await controller.handle({ type: "details_tab", delta: -1 });
    const plan = component.render(84).join("\n");
    expect(plan).toContain("Architecture");
    // The Plan tab shows only the concise operator plan; this fixture recorded none.
    expect(plan).toContain("No concise items");
    expect(plan).not.toContain("Use the existing seam.");

    await controller.handle({ type: "focus_panel", panel: "tickets" });
    await controller.handle({ type: "move", delta: 1 });
    await controller.handle({ type: "activate" });
    const ticketView = component.render(120).join("\n");
    // The full tab strip stays reachable while a ticket is committed.
    expect(ticketView).toContain("Details: Graph - Plan - Overview");
    expect(ticketView).toContain("1 attempt");
    // Stepping back to the Graph tab shows the committed ticket's checkout scope label.
    await controller.handle({ type: "focus_panel", panel: "details" });
    await controller.handle({ type: "details_tab", delta: 1 });
    expect(component.render(120).join("\n")).toContain("Graph · Ticket checkout");

    component.dispose();
    controller.dispose();
  });

  it("freezes normalized populated glyph, style, region, and compact-control evidence at every supported scale", async () => {
    const run = fixtureRun();
    run.activity.push(
      {
        id: "event-two",
        at: "2026-07-16T00:00:02.000Z",
        kind: "graph_modified",
        message: "Verification boundary refined",
        ticketId: "ticket-one",
        nodeId: "claim-one",
      },
      {
        id: "event-three",
        at: "2026-07-16T00:00:03.000Z",
        kind: "graph_deleted",
        message: "Obsolete assumption removed",
        ticketId: "ticket-one",
        nodeId: "claim-one",
      },
      {
        id: "event-four",
        at: "2026-07-16T00:00:04.000Z",
        kind: "compiler",
        message: "Ticket verification accepted",
        ticketId: "ticket-one",
        nodeId: "claim-one",
      },
    );
    const client = new FakeAuthority([run]);
    const controller = new ControlCenterController({
      projectRoot: "/project",
      client,
      now: () => 20_000,
    });
    await controller.initialize();
    expect(client.calls.some((call) => call.method === "run.list")).toBe(false);
    expect(client.calls.find((call) => call.method === "run.page")?.params).toEqual({
      limit: 200,
      includeDeleted: false,
    });
    expect(client.calls.find((call) => call.method === "run.get")?.params).toEqual({
      runId: run.id,
      authorityRevision: client.revision,
      runRevision: run.revision,
    });
    const component = new ControlCenterComponent({
      controller,
      palette: ansiKoniPalette(true),
      viewportRows: () => 52,
    });

    const minimum = component.renderFrame(82, 20);
    const normal = component.renderFrame(122, 40);
    const roomy = component.renderFrame(180, 52);
    const minimumLines = minimum.toPlainLines();
    const normalText = normal.toPlainLines().join("\n");
    const roomyText = roomy.toPlainLines().join("\n");
    const regions = Object.fromEntries(minimum.regions.map((region) => [region.name, region.rect]));

    expect(regions).toMatchObject({
      runs: { x: 0, y: 0, width: 28, height: 5 },
      tickets: { x: 0, y: 5, width: 28, height: 6 },
      agents: { x: 0, y: 11, width: 28, height: 4 },
      activity: { x: 0, y: 15, width: 28, height: 4 },
      details: { x: 28, y: 0, width: 54, height: 12 },
      questions: { x: 28, y: 12, width: 54, height: 7 },
    });
    expect(regions).not.toHaveProperty("graph");
    expect(minimumLines.every((line) => visibleWidth(line) === 82)).toBe(true);
    expect(minimumLines[15]).toContain("Activity · 17s");
    // Row 1 is the runs filter tab line; the selected run's detail row follows its title row.
    expect(minimumLines[1]).toContain("‹ Active");
    expect(minimumLines[3]).toContain("main");
    expect(minimumLines[3]).toContain("Orchestrate");
    // The merged right section is twice as wide, so the questions footer fits its full hints.
    expect(minimumLines[17]).toContain("←→/[] · ↑↓/jk · Enter · [n] notes");
    expect(minimumLines[17]).not.toContain("…");

    expect(normalText).toContain("Details: Graph - Plan - Overview");
    expect(normalText).toContain("Questions");
    expect(normalText).toContain("Implement feature · Implementer");
    expect(normalText).toContain("Lead");
    expect(normalText).toContain("Graph · Run integration");
    expect(normalText).toContain("main");
    expect(roomyText).toContain("1.1K new tks");
    expect(normalText).not.toContain("claim-one");
    expect(normalText).not.toContain("attempt-worker");
    expect(roomyText).toContain("Activity · 17s active");
    expect(roomyText).toContain("Added: Architecture boundary mapped");
    expect(roomyText).toContain("Modified: Verification boundary refined");
    expect(roomyText).toContain("Obsolete assumption removed");

    // Graph is the default (active) tab; the other tab labels stay muted.
    expect(styleAtText(normal, "Graph", "details")).toMatchObject({ foreground: "ansi-37" });
    expect(styleAtText(normal, "Plan", "details")).toMatchObject({ foreground: "ansi-90" });
    expect(styleAtText(normal, "Overview", "details")).toMatchObject({ foreground: "ansi-90" });
    expect(styleAtText(roomy, "Added: Architecture boundary mapped", "activity")).toMatchObject({
      foreground: "ansi-32",
    });
    expect(styleAtText(roomy, "Modified: Verification boundary refined", "activity")).toMatchObject(
      { foreground: "ansi-33" },
    );
    expect(styleAtText(roomy, "Obsolete assumption removed", "activity")).toMatchObject({
      foreground: "ansi-31",
    });
    expect(styleAtText(roomy, "Claim result", "details")).toMatchObject({ foreground: "ansi-90" });
    expect(styleAtText(normal, "Lead", "agents")).toMatchObject({ foreground: "ansi-90" });

    await controller.handle({ type: "focus_panel", panel: "questions" });
    await controller.handle({ type: "help" });
    const help = component.renderFrame(122, 40).toPlainLines().join("\n");
    expect(help).toContain("open the answer dialog");
    expect(help).toContain("←/→ or [ ]");

    component.dispose();
    controller.dispose();
  });

  it("filters the Runs panel with tabs while pinning the selected run", async () => {
    const working = fixtureRun();
    const concluded = fixtureRun();
    concluded.id = "run-two";
    concluded.lifecycle.runId = concluded.id;
    concluded.git.runId = concluded.id;
    concluded.createdAt = "2026-07-15T00:00:00.000Z";
    concluded.lifecycle.phase = "completed";
    const client = new FakeAuthority([working, concluded]);
    const controller = new ControlCenterController({
      projectRoot: "/project",
      client,
      now: () => 20_000,
    });
    await controller.initialize();

    // Active is the default working set: the concluded run stays one tab away.
    expect(controller.snapshot.runTab).toBe("active");
    expect(controller.snapshot.view.runs.map((run) => run.id)).toEqual(["run-one"]);
    expect(
      Object.fromEntries(controller.snapshot.view.runTabs.map((tab) => [tab.id, tab.count])),
    ).toMatchObject({ active: 1, done: 1, all: 2 });

    await controller.handle({ type: "focus_panel", panel: "runs" });
    await controller.handle({ type: "details_tab", delta: -1 });
    expect(controller.snapshot.runTab).toBe("all");
    expect(controller.snapshot.view.runs.map((run) => run.id)).toEqual(["run-one", "run-two"]);

    await controller.handle({ type: "details_tab", delta: -1 });
    expect(controller.snapshot.runTab).toBe("done");
    // The selected run stays pinned even though it does not match the Done filter.
    expect(controller.snapshot.view.runs.map((run) => run.id)).toEqual(["run-one", "run-two"]);
    expect(controller.snapshot.selection.runId).toBe("run-one");

    const component = new ControlCenterComponent({
      controller,
      palette: plainKoniPalette,
      viewportRows: () => 40,
    });
    expect(component.render(122).join("\n")).toContain("‹ Done 1 ›");
    component.dispose();
    controller.dispose();
  });

  it("opens the focused graph node's card with Enter and closes it with Esc", async () => {
    const client = new FakeAuthority([fixtureRun()]);
    const controller = new ControlCenterController({
      projectRoot: "/project",
      client,
      now: () => 20_000,
    });
    await controller.initialize();
    const component = new ControlCenterComponent({
      controller,
      palette: plainKoniPalette,
      viewportRows: () => 40,
    });

    // The Graph feed is the details panel's default tab; key 6 focuses it directly.
    await controller.handle({ type: "focus_graph" });
    expect(controller.snapshot.cursor.graphFeed.column).toBe("graph");
    await controller.handle({ type: "activate" });
    expect(controller.snapshot.modal).toMatchObject({
      kind: "graph_node",
      nodeId: "claim-one",
      scroll: 0,
    });
    const card = component.render(122).join("\n");
    expect(card).toContain("Graph node · claim");
    expect(card).toContain("Claim result supports architecture boundary");
    expect(card).toContain("Status");
    expect(card).toContain("Active");
    expect(card).toContain("Purpose");
    expect(card).toContain("Verify the architecture boundary");
    expect(card).toContain("tests");
    expect(card).toContain("Test claim result");
    expect(card).not.toContain("claim-one");
    expect(card).not.toContain("experiment-one");

    await controller.handle({ type: "cancel" });
    expect(controller.snapshot.modal).toBeUndefined();
    component.dispose();
    controller.dispose();
  });

  it("drives the Graph feed: key 6 jump, arrow column focus, bracket tabs, Enter commit", async () => {
    const client = new FakeAuthority([fixtureRun()]);
    const controller = new ControlCenterController({
      projectRoot: "/project",
      client,
      now: () => 20_000,
    });
    await controller.initialize();

    await controller.handle({ type: "focus_panel", panel: "runs" });
    await controller.handle({ type: "focus_graph" });
    expect(controller.snapshot.focus).toBe("details");
    expect(controller.snapshot.selection.detailsTab).toBe("graph");

    // Arrows move the feed's column focus; brackets keep cycling the tabs.
    await controller.handle({ type: "move_horizontal", delta: 1 });
    expect(controller.snapshot.cursor.graphFeed).toEqual({
      column: "tickets",
      ticketId: "ticket-one",
    });
    await controller.handle({ type: "move_horizontal", delta: -1 });
    expect(controller.snapshot.cursor.graphFeed.column).toBe("graph");
    await controller.handle({ type: "details_tab", delta: 1 });
    expect(controller.snapshot.selection.detailsTab).toBe("plan");
    await controller.handle({ type: "details_tab", delta: -1 });
    expect(controller.snapshot.selection.detailsTab).toBe("graph");

    // Enter on the tickets column commits the hovered ticket — Overview takeover included.
    await controller.handle({ type: "move_horizontal", delta: 1 });
    await controller.handle({ type: "activate" });
    expect(controller.snapshot.selection).toMatchObject({
      ticketId: "ticket-one",
      detailsTab: "overview",
    });
    controller.dispose();
  });

  it("keeps the Graph feed up while arrowing runs and resets its cursors per selection", async () => {
    const client = new FakeAuthority([fixtureRun(), fixtureRunWithId("run-two")]);
    const controller = new ControlCenterController({
      projectRoot: "/project",
      client,
      now: () => 20_000,
    });
    await controller.initialize();
    expect(controller.snapshot.selection).toMatchObject({ runId: "run-one", detailsTab: "graph" });

    // Move the node cursor off zero, then browse to the next run: the tab survives while
    // both feed cursors reset for the new selection.
    await controller.handle({ type: "focus_graph" });
    await controller.handle({ type: "move", delta: 1 });
    expect(controller.snapshot.cursor.graphIndex).toBe(1);
    await controller.handle({ type: "focus_panel", panel: "runs" });
    await controller.handle({ type: "move", delta: 1 });
    expect(controller.snapshot.selection).toMatchObject({ runId: "run-two", detailsTab: "graph" });
    expect(controller.snapshot.cursor.graphIndex).toBe(0);
    expect(controller.snapshot.cursor.graphFeed).toEqual({ column: "graph" });

    // An explicit Enter on the run row commits to its Overview.
    await controller.handle({ type: "activate" });
    expect(controller.snapshot.selection.detailsTab).toBe("overview");
    controller.dispose();
  });

  it("renders contextual help as scrollable docs with diagrams and philosophy", async () => {
    const client = new FakeAuthority([fixtureRun()]);
    const controller = new ControlCenterController({
      projectRoot: "/project",
      client,
      now: () => 20_000,
    });
    await controller.initialize();
    const component = new ControlCenterComponent({
      controller,
      palette: plainKoniPalette,
      viewportRows: () => 44,
    });

    await controller.handle({ type: "help" });
    const help = component.render(150).join("\n");
    expect(help).toContain("Help · Runs");
    expect(help).toContain("How it fits");
    expect(help).toContain("merge ready");
    expect(help).toContain("Why it works this way");
    expect(help).toContain("worktree");
    expect(help).toContain("Available here");
    expect(help).toContain("↑↓ scroll");

    await controller.handle({ type: "move", delta: 1 });
    expect(controller.snapshot.modal).toMatchObject({ kind: "help", scroll: 1 });
    component.dispose();
    controller.dispose();
  });

  it("draws relationship lines first and overlays concise node markers and titles", () => {
    const lines = renderGraphLines(
      [
        {
          id: "claim",
          type: "claim",
          marker: "C",
          label: "Claim result",
          fullTitle: "Claim result",
          muted: false,
        },
        {
          id: "experiment",
          type: "experiment",
          marker: "E",
          label: "Test claim",
          fullTitle: "Test claim",
          muted: false,
        },
        {
          id: "gate",
          type: "gate",
          marker: "G",
          label: "Verify output",
          fullTitle: "Verify output",
          muted: true,
        },
      ],
      [
        { source: "claim", target: "experiment" },
        { source: "experiment", target: "gate" },
      ],
      42,
      plainKoniPalette,
    );
    expect(lines.join("\n")).toContain("[cl] Claim result");
    expect(lines.join("\n")).toContain("[ex] Test claim");
    expect(lines.join("\n")).toContain("[gt] Verify output");
    expect(lines.join("\n")).toContain("<related>");
    expect(lines.join("\n")).toMatch(/[─│┼]/u);
  });

  it("renders secondary and reciprocal relationships once in autoresearch-style lanes", () => {
    const nodes = [
      {
        id: "claim",
        type: "claim",
        marker: "C",
        label: "Cache policy",
        fullTitle: "Cache policy",
        muted: false,
      },
      {
        id: "experiment",
        type: "experiment",
        marker: "E",
        label: "Measure cache",
        fullTitle: "Measure cache",
        muted: false,
      },
      {
        id: "gate",
        type: "gate",
        marker: "G",
        label: "Bound regression",
        fullTitle: "Bound regression",
        muted: false,
      },
    ];
    const lines = renderGraphLines(
      nodes,
      [
        { source: "claim", relation: "tested_by", target: "experiment" },
        { source: "experiment", relation: "tests", target: "claim" },
        { source: "experiment", relation: "verified_by", target: "gate" },
        { source: "claim", relation: "constrains", target: "gate" },
      ],
      46,
      plainKoniPalette,
    );
    const text = lines.join("\n");
    expect(text.match(/\[cl\]/gu)).toHaveLength(1);
    expect(text.match(/\[ex\]/gu)).toHaveLength(1);
    expect(text.match(/\[gt\]/gu)).toHaveLength(1);
    expect(text).toContain("<constrains>");
    expect(text).toMatch(/[│┼]/u);
    expect(text).not.toContain("claim");
  });

  it("keeps a software-sized graph scannable inside one equal-width dashboard column", () => {
    const nodes = Array.from({ length: 15 }, (_, index) => ({
      id: `internal-node-${index}`,
      type: index % 3 === 0 ? "gate" : index % 2 === 0 ? "change" : "claim",
      marker: index % 3 === 0 ? "G" : index % 2 === 0 ? "C" : "A",
      label: `Boundary ${index + 1}`,
      fullTitle: `Boundary ${index + 1}`,
      muted: index % 4 === 0,
    }));
    const edges = nodes
      .slice(1)
      .map((node, index) => ({ source: nodes[index]!.id, target: node.id }));
    const lines = renderGraphLines(nodes, edges, 40, plainKoniPalette);
    const text = lines.join("\n");
    expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
    expect(text).toContain("Boundary 1");
    expect(text).toContain("Boundary 15");
    expect(text).not.toContain("internal-node");
    expect(text).not.toContain("source");
  });

  it("keeps Start and the footer visible while every compact New Run stage is reachable", async () => {
    const client = new FakeAuthority([]);
    const controller = new ControlCenterController({
      projectRoot: "/project",
      client,
      models: fixtureModels(),
    });
    await controller.initialize();
    await controller.handle({ type: "open_new_run" });
    const component = new ControlCenterComponent({
      controller,
      palette: plainKoniPalette,
      viewportRows: () => 20,
    });
    const first = component.render(82).join("\n");
    expect(first).toContain("Validate intake");
    expect(first).toContain("Start Planning");
    expect(first).toContain("Esc close");
    expect(first.split("\n").every((line) => visibleWidth(line) === 82)).toBe(true);
    await controller.handle({ type: "page", delta: 1 });
    const last = component.render(82).join("\n");
    expect(last).toContain("Merge the completed run");
    expect(last).toContain("Start Planning");
    expect(last).toContain("Esc close");
    component.dispose();
    controller.dispose();
  });

  it("wraps the focused Objective at the actual equal-column width without losing middle text", async () => {
    const run = fixtureRun();
    run.objective = `${"scope ".repeat(11)}MIDPOINT-SENTINEL ${"verification ".repeat(8)}`;
    const controller = new ControlCenterController({
      projectRoot: "/project",
      client: new FakeAuthority([run]),
    });
    await controller.initialize();
    await controller.handle({ type: "focus_panel", panel: "details" });
    // The Objective renders on the Overview tab (one bracket-step left of the default Graph).
    await controller.handle({ type: "details_tab", delta: -1 });
    const component = new ControlCenterComponent({
      controller,
      palette: plainKoniPalette,
      viewportRows: () => 32,
    });
    expect(component.render(150).join("\n")).toContain("MIDPOINT-SENTINEL");
    component.dispose();
    controller.dispose();
  });

  it("keeps the Notes editor visible for long question options", async () => {
    const run = fixtureRun();
    run.questions["question-one"]!.options[0]!.description = "Long option context ".repeat(80);
    const controller = new ControlCenterController({
      projectRoot: "/project",
      client: new FakeAuthority([run]),
    });
    await controller.initialize();
    await controller.handle({ type: "focus_panel", panel: "questions" });
    await controller.handle({ type: "toggle_notes" });
    await controller.handle({ type: "append_text", text: "Visible operator note" });
    await controller.handle({ type: "activate" });
    const component = new ControlCenterComponent({
      controller,
      palette: plainKoniPalette,
      viewportRows: () => 24,
    });
    const text = component.render(120).join("\n");
    expect(text).toContain("Notes");
    expect(text).toContain("Visible operator note");
    component.dispose();
    controller.dispose();
  });

  it("refreshes an active persisted Pi transcript after authority agent events", async () => {
    const client = new FakeAuthority([fixtureRun()]);
    const controller = new ControlCenterController({ projectRoot: "/project", client });
    await controller.initialize();
    await controller.handle({ type: "focus_panel", panel: "agents" });
    await controller.handle({ type: "move", delta: 1 });
    await controller.handle({ type: "activate" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const component = new ControlCenterComponent({
      controller,
      palette: plainKoniPalette,
      viewportRows: () => 44,
    });
    expect(component.render(100).join("\n")).toContain("I inspected the existing");
    client.setTranscriptAssistantText("I applied the live transcript update.");
    client.emit("agent.usage");
    await new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));
    expect(component.render(100).join("\n")).toContain("I applied the live");
    component.dispose();
    controller.dispose();
  });

  it("keeps historical chats read-only, opens Chat help, and restores the previous Details tab", async () => {
    const client = new FakeAuthority([fixtureRun()]);
    const controller = new ControlCenterController({ projectRoot: "/project", client });
    await controller.initialize();
    await controller.handle({ type: "focus_panel", panel: "details" });
    await controller.handle({ type: "details_tab", delta: 1 });
    await controller.handle({ type: "focus_panel", panel: "agents" });
    await controller.handle({ type: "move", delta: -1 });
    await controller.handle({ type: "activate" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const component = new ControlCenterComponent({
      controller,
      palette: plainKoniPalette,
      viewportRows: () => 40,
    });
    expect(component.render(100).join("\n")).toContain("Historical session · read-only");
    await controller.handle({ type: "toggle_chat_composer" });
    expect(controller.snapshot.chat?.draft.editing).toBe(false);
    await controller.handle({ type: "help" });
    expect(controller.snapshot.modal).toEqual({ kind: "help", topic: "chat", scroll: 0 });
    await controller.handle({ type: "cancel" });
    await controller.handle({ type: "cancel" });
    expect(controller.snapshot.selection).toMatchObject({ detailsTab: "plan" });
    expect(controller.snapshot.selection.attemptId).toBeUndefined();
    component.dispose();
    controller.dispose();
  });

  it("keeps compact resource confirmation controls visible", async () => {
    const client = new FakeAuthority([]);
    const controller = new ControlCenterController({ projectRoot: "/project", client });
    await controller.initialize();
    await controller.handle({ type: "open_config" });
    await controller.handle({ type: "config_resource_create" });
    await controller.handle({ type: "activate" });
    const component = new ControlCenterComponent({
      controller,
      palette: plainKoniPalette,
      viewportRows: () => 20,
    });
    const resource = component.render(82).join("\n");
    expect(resource).toContain("Create resource");
    expect(resource).toContain("Esc cancel");
    expect(resource.split("\n").every((line) => visibleWidth(line) === 82)).toBe(true);
    component.dispose();
    controller.dispose();
  });
});

describe("control center input and standalone host", () => {
  it("keeps complete authority-projected tool arguments and results instead of transport-event summaries", () => {
    const argument = `ARGUMENT-START-${"a".repeat(500)}-ARGUMENT-END`;
    const result = `RESULT-START-${"b".repeat(3_000)}-RESULT-END`;
    const projection = assemblePiTranscriptPages([
      parsePiTranscriptPage(
        fixtureTranscriptPage([
          {
            ...fixtureTranscriptBlock("assistant", `- **Command:** ${argument}`),
            kind: "tool_call",
            title: "Check",
          },
          {
            ...fixtureTranscriptBlock("result", result),
            kind: "tool_result",
            title: "Check",
          },
        ]),
      ),
    ]);
    const text = projection.blocks.map((block) => block.markdown).join("\n");
    expect(text).toContain("ARGUMENT-END");
    expect(text).toContain("RESULT-END");
    expect(text).not.toContain("Pi event");
  });

  it("reserves h for panel help but accepts it as notes text while editing", () => {
    expect(
      decodeControlCenterInput("h", { panel: "details", editingNotes: false, modalOpen: false }),
    ).toEqual({ type: "help" });
    expect(
      decodeControlCenterInput("h", { panel: "questions", editingNotes: true, modalOpen: false }),
    ).toEqual({ type: "append_text", text: "h" });
    expect(
      decodeControlCenterInput("n", { panel: "questions", editingNotes: false, modalOpen: false }),
    ).toEqual({ type: "toggle_notes" });
    expect(
      decodeControlCenterInput("n", { panel: "runs", editingNotes: false, modalOpen: false }),
    ).toEqual({ type: "open_new_run" });
    expect(
      decodeControlCenterInput("\u001b[B", {
        panel: "runs",
        editingNotes: false,
        modalOpen: false,
      }),
    ).toEqual({ type: "move", delta: 1 });
    expect(
      decodeControlCenterInput("a", {
        panel: "runs",
        editingNotes: false,
        modalOpen: true,
        modalKind: "configure",
      }),
    ).toEqual({ type: "config_resource_create" });
    expect(
      decodeControlCenterInput("d", {
        panel: "runs",
        editingNotes: false,
        modalOpen: true,
        modalKind: "configure",
      }),
    ).toEqual({ type: "config_resource_duplicate" });
    expect(
      decodeControlCenterInput("x", {
        panel: "runs",
        editingNotes: false,
        modalOpen: true,
        modalKind: "configure",
      }),
    ).toEqual({ type: "config_resource_delete" });
    expect(
      decodeControlCenterInput("u", {
        panel: "runs",
        editingNotes: false,
        modalOpen: true,
        modalKind: "configure",
      }),
    ).toEqual({ type: "open_conflicts" });
    expect(
      decodeControlCenterInput("r", {
        panel: "runs",
        editingNotes: false,
        modalOpen: true,
        modalKind: "configure",
      }),
    ).toEqual({ type: "open_config_documents" });
    expect(
      decodeControlCenterInput("a", {
        panel: "runs",
        editingNotes: false,
        modalOpen: true,
        modalKind: "configure_documents",
      }),
    ).toEqual({ type: "config_document_create" });
    expect(
      decodeControlCenterInput("e", {
        panel: "runs",
        editingNotes: false,
        modalOpen: true,
        modalKind: "configure_documents",
      }),
    ).toEqual({ type: "config_document_rename" });
    expect(
      decodeControlCenterInput("x", {
        panel: "runs",
        editingNotes: false,
        modalOpen: true,
        modalKind: "configure_documents",
      }),
    ).toEqual({ type: "config_document_delete" });
    expect(
      decodeControlCenterInput("t", {
        panel: "runs",
        editingNotes: false,
        modalOpen: true,
        modalKind: "configure_documents",
      }),
    ).toEqual({ type: "config_run_type_create" });
    expect(
      decodeControlCenterInput("\u001b[B", {
        panel: "runs",
        editingNotes: false,
        editingText: true,
        modalOpen: true,
        modalKind: "config_run_type_wizard",
      }),
    ).toEqual({ type: "focus", delta: 1 });
    expect(
      decodeControlCenterInput("q", {
        panel: "runs",
        editingNotes: false,
        modalOpen: true,
        modalKind: "configure",
      }),
    ).toEqual({ type: "quit" });
    expect(
      decodeControlCenterInput("?", { panel: "runs", editingNotes: false, modalOpen: false }),
    ).toEqual({ type: "open_question" });
    expect(
      decodeControlCenterInput("r", { panel: "runs", editingNotes: false, modalOpen: false }),
    ).toEqual({ type: "refresh" });
    expect(
      decodeControlCenterInput("[", {
        panel: "details",
        editingNotes: false,
        modalOpen: false,
        chatOpen: true,
      }),
    ).toEqual({ type: "transcript_page", delta: -1 });
    expect(
      decodeControlCenterInput("]", {
        panel: "details",
        editingNotes: false,
        modalOpen: false,
        chatOpen: true,
      }),
    ).toEqual({ type: "transcript_page", delta: 1 });
    expect(
      decodeControlCenterInput("[", {
        panel: "details",
        editingNotes: false,
        modalOpen: false,
        chatOpen: true,
        chatComposer: true,
      }),
    ).toEqual({ type: "append_text", text: "[" });
    expect(
      decodeControlCenterInput("\u001b", {
        panel: "details",
        editingNotes: false,
        modalOpen: false,
        chatOpen: true,
      }),
    ).toEqual({ type: "cancel" });
  });

  it("does not enter raw mode until the caller explicitly starts the TUI", async () => {
    const terminal = new FakeTerminal();
    const handle = await createStandaloneControlCenter({
      projectRoot: "/project",
      version: "1.0.0",
      client: new FakeAuthority([]),
      terminal,
      palette: plainKoniPalette,
      models: [],
    });
    expect(handle.started).toBe(false);
    expect(terminal.starts).toBe(0);
    handle.start();
    expect(handle.started).toBe(true);
    expect(terminal.starts).toBe(1);
    await handle.stop();
    expect(terminal.stops).toBe(1);
  });
});

interface RecordedCall {
  method: string;
  params: JsonValue | undefined;
  expectedRevision: number | undefined;
  idempotencyKey: string | undefined;
}

function findHitTarget(frame: CellGrid, target: string): { x: number; y: number } | undefined {
  for (let y = 0; y < frame.height; y += 1) {
    for (let x = 0; x < frame.width; x += 1) {
      if (frame.hitTargetAt(x, y) === target) return { x, y };
    }
  }
  return undefined;
}

function styleAtText(frame: CellGrid, text: string, region: string) {
  for (let y = 0; y < frame.height; y += 1) {
    const plain = frame.cells[y]!.map((cell) => (cell.continuation ? "" : cell.glyph)).join("");
    let offset = plain.indexOf(text);
    while (offset >= 0) {
      const cell = frame.cells[y]![offset];
      if (cell?.region === region) return cell.style;
      offset = plain.indexOf(text, offset + 1);
    }
  }
  throw new Error(`frame did not contain ${JSON.stringify(text)} in ${region}`);
}

class FakeAuthority implements ControlCenterAuthorityClient {
  public revision = 7;
  public readonly calls: RecordedCall[] = [];
  readonly #runs: RunRecord[];
  readonly #listeners = new Set<(event: RpcEvent) => void>();
  #runCreateGate: Promise<void> | undefined;
  public runCreateWarning: string | undefined;
  #releaseRunCreate: (() => void) | undefined;
  #configValues: Record<string, JsonValue> = {
    "project.name": "Notes",
    "project.parallel": 3,
    "project.enabled": true,
  };
  #configCas = "baseline-1";
  #transcriptAssistantText = "I inspected the existing notes route.";
  readonly #transcriptBlocks = new Map<string, FixtureTranscriptBlock[]>();
  readonly #transcriptGates = new Map<string, Promise<void>>();
  readonly #requestGates = new Map<string, Promise<void>>();
  #driftTranscriptSnapshotOnce = false;
  #profileConflicts: ControlProfileConflictCatalog = fixtureProfileConflictCatalog(false, true);
  #controlCatalog = fixtureControlCatalog();
  #configDocumentCatalog: ConfigDocumentCatalog = fixtureConfigDocumentCatalog();
  readonly #configDocumentSources = new Map<string, string>([
    ["document-project", 'schema_version: "2.0"\nname: Notes\n'],
    ["document-agent", 'schema_version: "2.0"\nid: implementer\nprompt: Implement the ticket.\n'],
  ]);
  #configDocumentMutation = 0;
  #failedConflictInspectionPath: string | undefined;
  #failNextProposalDecision = false;
  #returnStaleControlsOnce = false;
  #runPageChurnRemaining = 0;

  public constructor(runs: RunRecord[]) {
    this.#runs = structuredClone(runs);
  }

  public onEvent(listener: (event: RpcEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public deferRunCreate(): () => void {
    this.#runCreateGate = new Promise<void>((resolve) => {
      this.#releaseRunCreate = resolve;
    });
    return () => this.#releaseRunCreate?.();
  }

  public simulateExternalConfiguration(values: Record<string, JsonValue>, cas: string): void {
    this.#configValues = structuredClone(values);
    this.#configCas = cas;
  }

  public setTranscriptAssistantText(value: string): void {
    this.#transcriptAssistantText = value;
  }

  public setTranscriptBlocks(
    value: FixtureTranscriptBlock[],
    attemptId = "attempt-worker",
    runId?: string,
  ): void {
    this.#transcriptBlocks.set(transcriptFixtureKey(attemptId, runId), structuredClone(value));
  }

  public appendTranscriptBlock(
    value: FixtureTranscriptBlock,
    attemptId = "attempt-worker",
    runId?: string,
  ): void {
    const key = transcriptFixtureKey(attemptId, runId);
    const current =
      this.#transcriptBlocks.get(key) ?? fixtureTranscriptBlocks(this.#transcriptAssistantText);
    this.#transcriptBlocks.set(key, [...structuredClone(current), structuredClone(value)]);
  }

  public deferTranscript(attemptId: string, runId?: string): () => void {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const key = transcriptFixtureKey(attemptId, runId);
    this.#transcriptGates.set(key, gate);
    return () => {
      this.#transcriptGates.delete(key);
      release();
    };
  }

  public deferRequest(method: string): () => void {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#requestGates.set(method, gate);
    return () => {
      this.#requestGates.delete(method);
      release();
    };
  }

  public driftTranscriptSnapshotOnce(): void {
    this.#driftTranscriptSnapshotOnce = true;
  }

  public setProfileConflicts(value: ControlProfileConflictCatalog): void {
    this.#profileConflicts = structuredClone(value);
  }

  public setControlCatalog(value: ReturnType<typeof fixtureControlCatalog>): void {
    this.#controlCatalog = structuredClone(value);
  }

  public failConflictInspection(path: string): void {
    this.#failedConflictInspectionPath = path;
  }

  public failNextProposalDecisionWithRevisionConflict(): void {
    this.#failNextProposalDecision = true;
  }

  public returnStaleControlsOnce(): void {
    this.#returnStaleControlsOnce = true;
  }

  public churnRunPages(count: number): void {
    this.#runPageChurnRemaining = count;
  }

  public emit(topic: string): void {
    const event: RpcEvent = {
      type: "event",
      sequence: this.calls.length + 1,
      revision: this.revision,
      topic,
    };
    for (const listener of this.#listeners) listener(event);
  }

  #nextConfigDigest(): `sha256:${string}` {
    const hex = "3456789abcdef";
    const character = hex[this.#configDocumentMutation % hex.length]!;
    this.#configDocumentMutation += 1;
    return `sha256:${character.repeat(64)}`;
  }

  #publishConfigDocuments(
    documents: readonly ConfigDocumentSummary[],
    changedDocumentId?: string,
  ): ConfigDocumentCatalog {
    const sourceToken = changedDocumentId === undefined ? undefined : this.#nextConfigDigest();
    this.#configDocumentCatalog = {
      ...this.#configDocumentCatalog,
      catalogToken: this.#nextConfigDigest(),
      documents: documents.map((document) =>
        document.id === changedDocumentId && sourceToken !== undefined
          ? {
              ...document,
              sourceToken,
              sizeBytes: this.#configDocumentSources.get(document.id)?.length ?? document.sizeBytes,
            }
          : structuredClone(document),
      ),
    };
    return structuredClone(this.#configDocumentCatalog);
  }

  #configMutationResult(
    documents: readonly ConfigDocumentSummary[],
    changedDocumentId?: string,
    changedDocuments = 1,
  ): JsonValue {
    return {
      protocol: "koni.config-document-mutation.v1",
      changedDocuments,
      catalog: this.#publishConfigDocuments(documents, changedDocumentId),
    } as unknown as JsonValue;
  }

  public async request(
    method: string,
    params?: JsonValue,
    options: { expectedRevision?: number; idempotencyKey?: string } = {},
  ): Promise<RpcSuccess> {
    this.calls.push({
      method,
      params,
      expectedRevision: options.expectedRevision,
      idempotencyKey: options.idempotencyKey,
    });
    await this.#requestGates.get(method);
    let result: JsonValue | undefined;
    if (method === "run.page") {
      if (this.#runPageChurnRemaining > 0) {
        this.#runPageChurnRemaining -= 1;
        this.emit("run.updated");
      }
      const request = isRecord(params) ? params : {};
      const aroundRunId = typeof request.aroundRunId === "string" ? request.aroundRunId : undefined;
      const aroundRun =
        aroundRunId === undefined
          ? undefined
          : this.#runs.find(
              (candidate) =>
                candidate.id === aroundRunId && candidate.lifecycle.phase !== "deleted",
            );
      if (aroundRunId !== undefined && aroundRun === undefined) {
        throw new AuthorityClientError("run_page_target", "selected run fixture is missing");
      }
      const collector = new RunSummaryPageCollector({
        revision: this.revision,
        limit: typeof request.limit === "number" ? request.limit : 50,
        includeDeleted: request.includeDeleted === true,
        ...(typeof request.cursor === "string" ? { cursor: request.cursor } : {}),
        ...(aroundRun === undefined
          ? {}
          : {
              around: {
                id: aroundRun.id,
                createdAt: aroundRun.createdAt,
                runRevision: aroundRun.revision,
              },
            }),
      });
      for (const run of this.#runs) collector.accept(run);
      result = collector.finish() as unknown as JsonValue;
    } else if (method === "run.get") {
      const run = this.#runs.find(
        (candidate) => candidate.id === (isRecord(params) ? params.runId : undefined),
      );
      if (run === undefined) throw new Error("selected run fixture is missing");
      result = structuredClone(run) as unknown as JsonValue;
    } else if (method === "run.list") result = structuredClone(this.#runs) as unknown as JsonValue;
    else if (method === "run.graph") result = fixtureGraph();
    else if (method === "run.controls") {
      const run = this.#runs.find(
        (candidate) => candidate.id === (isRecord(params) ? params.runId : undefined),
      );
      if (run === undefined) throw new Error("stage control run fixture is missing");
      const controls = fixtureStageControls(run);
      if (this.#returnStaleControlsOnce) {
        this.#returnStaleControlsOnce = false;
        result = {
          ...controls,
          binding: { ...controls.binding, runRevision: controls.binding.runRevision + 1 },
        } as unknown as JsonValue;
      } else result = controls as unknown as JsonValue;
    } else if (method === "run.lineage") {
      const run = this.#runs.find(
        (candidate) => candidate.id === (isRecord(params) ? params.runId : undefined),
      );
      if (run === undefined) throw new Error("lineage run fixture is missing");
      result = fixtureLineage(
        run,
        isRecord(params) && typeof params.ticketId === "string" ? params.ticketId : undefined,
      );
    } else if (method === "run.deletion.inspect") {
      const run = this.#runs.find(
        (candidate) => candidate.id === (isRecord(params) ? params.runId : undefined),
      );
      if (run === undefined) throw new Error("deletion preview run fixture is missing");
      result = {
        protocol: "koni.run-deletion-preview.v1",
        runId: run.id,
        objective: run.objective,
        phase: run.lifecycle.phase,
        targetRef: run.git.target.ref,
        ownedWorktrees: 3,
        ownedBranches: 2,
        liveAgents: Object.values(run.attempts).filter((attempt) => attempt.status === "running")
          .length,
        dirtyWorktreeWarnings: [],
        blockers: [],
        canPreserveBranches: true,
        canDeleteOwnedBranches: true,
        previewToken: `sha256:${"d".repeat(64)}`,
      };
    } else if (method === "run.merge.inspect") {
      const run = this.#runs.find(
        (candidate) => candidate.id === (isRecord(params) ? params.runId : undefined),
      );
      if (run === undefined) throw new Error("merge preview run fixture is missing");
      const tickets = Object.values(run.tickets);
      const ready = run.lifecycle.phase === "merge_ready" && run.git.promotion?.status === "ready";
      result = {
        protocol: "koni.run-merge-preview.v1",
        runId: run.id,
        objective: run.objective,
        phase: run.lifecycle.phase,
        targetRef: run.git.target.ref,
        expectedTargetOid: run.git.target.selectedOid,
        observedTargetOid: run.git.target.selectedOid,
        targetAdvanced: false,
        resyncState: "current",
        completedTickets: tickets.filter((ticket) => ticket.status === "completed").length,
        totalTickets: tickets.length,
        blockers: ready ? [] : ["The compiler has not prepared this run for promotion yet."],
        canAuthorize: ready,
        previewToken: `sha256:${"e".repeat(64)}`,
      };
    } else if (method === "proposal.inspect") {
      const run = this.#runs.find(
        (candidate) => candidate.id === (isRecord(params) ? params.runId : undefined),
      );
      const ticket =
        run?.tickets[
          isRecord(params) && typeof params.ticketId === "string" ? params.ticketId : ""
        ];
      if (run === undefined || ticket === undefined)
        throw new Error("proposal inspection fixture is missing");
      result = projectControlProposalInspection(run, ticket) as unknown as JsonValue;
    } else if (method === "proposal.decide") {
      if (this.#failNextProposalDecision) {
        this.#failNextProposalDecision = false;
        this.revision += 1;
        throw new AuthorityClientError("revision_conflict", "fixture proposal revision changed", {
          revision: this.revision,
        });
      }
      const row = isRecord(params) ? params : undefined;
      const run = this.#runs.find((candidate) => candidate.id === row?.runId);
      const ticket = run?.tickets[typeof row?.ticketId === "string" ? row.ticketId : ""];
      const decision =
        row?.decision === "approval"
          ? ("approval" as const)
          : row?.decision === "rejection"
            ? ("rejection" as const)
            : undefined;
      if (run === undefined || ticket === undefined || decision === undefined) {
        throw new Error("proposal decision fixture is incomplete");
      }
      const message = typeof row?.message === "string" ? row.message : undefined;
      const now = "2026-07-16T00:00:20.000Z";
      const requestSha256 = ticket.executionControl?.proposalRequest?.requestSha256;
      if (requestSha256 === undefined)
        throw new Error("proposal decision fixture has no exact request authority");
      const authorityMaterial = {
        protocol: "koni.proposal-decision-authority.v2" as const,
        runId: run.id,
        proposalTicketId: ticket.id,
        requestSha256,
        eventId: "operator-decision",
        decision,
        actor: "operator" as const,
        recordedAt: now,
        message: message ?? "",
      } as const;
      const authority = { ...authorityMaterial, sha256: canonicalHash(authorityMaterial) };
      ticket.status = decision === "approval" ? "queued" : "completed";
      ticket.executionControl = {
        ...ticket.executionControl,
        proposalDecision: authority,
        proposalDecisionHistory: [
          ...(ticket.executionControl?.proposalDecisionHistory ?? []),
          authority,
        ],
        ...(decision === "approval" ? { proposalApprovalSha256: authority.sha256 } : {}),
        proposalDisposition: {
          kind: decision === "approval" ? "approved" : "rejected",
          authoritySha256: authority.sha256,
        },
      };
      this.revision += 1;
      result = projectControlProposalInspection(run, ticket) as unknown as JsonValue;
    } else if (method === "control.catalog") result = structuredClone(this.#controlCatalog);
    else if (method === "branches.list")
      result = [{ ref: "refs/heads/main", name: "main", oid: "a".repeat(40) }];
    else if (method === "config.documents.list") {
      result = structuredClone(this.#configDocumentCatalog) as unknown as JsonValue;
    } else if (method === "config.documents.read") {
      const documentId =
        isRecord(params) && typeof params.documentId === "string" ? params.documentId : undefined;
      const catalogToken =
        isRecord(params) && typeof params.catalogToken === "string"
          ? params.catalogToken
          : undefined;
      const document = this.#configDocumentCatalog.documents.find(
        (candidate) => candidate.id === documentId,
      );
      const source =
        documentId === undefined ? undefined : this.#configDocumentSources.get(documentId);
      if (
        document === undefined ||
        source === undefined ||
        catalogToken !== this.#configDocumentCatalog.catalogToken
      ) {
        throw new Error("configuration document read fixture rejected stale semantic identity");
      }
      result = {
        protocol: "koni.config-document-source.v1",
        catalogToken,
        document: structuredClone(document),
        source,
      } as unknown as JsonValue;
    } else if (method === "config.run-types.templates") {
      result = {
        protocol: "koni.config-run-type-templates.v1",
        catalogToken: this.#configDocumentCatalog.catalogToken,
        templates: [
          {
            id: "template-medium",
            title: "Medium",
            description: "A balanced compiler-authored workflow.",
          },
        ],
      };
    } else if (method === "config.catalog") result = fixtureConfigCatalog();
    else if (method === "config.get")
      result = {
        protocol: "koni.config-snapshot.v1",
        cas: { effective: this.#configCas },
        values: structuredClone(this.#configValues),
      };
    else if (method === "profile.conflicts.list") {
      result = structuredClone(this.#profileConflicts) as unknown as JsonValue;
    } else if (method === "profile.conflicts.inspect") {
      const selectedPath =
        isRecord(params) && typeof params.path === "string" ? params.path : undefined;
      if (selectedPath === this.#failedConflictInspectionPath) {
        throw new Error(`inspection fixture failed for ${selectedPath}`);
      }
      const selected = this.#profileConflicts.conflicts.find(
        (conflict) => conflict.path === selectedPath,
      );
      if (selected === undefined)
        throw new Error(`no fixture conflict for ${selectedPath ?? "missing path"}`);
      result = fixtureProfileConflictInspection(
        this.#profileConflicts,
        selected.path,
      ) as unknown as JsonValue;
    } else if (method === "run.transcript") {
      const request = isRecord(params) ? params : {};
      const attemptId =
        typeof request.attemptId === "string" ? request.attemptId : "attempt-worker";
      const runId = typeof request.runId === "string" ? request.runId : "run-one";
      const attempt = this.#runs.find((run) => run.id === runId)?.attempts[attemptId];
      const exactKey = transcriptFixtureKey(attemptId, runId);
      const fallbackKey = transcriptFixtureKey(attemptId);
      const blocks =
        this.#transcriptBlocks.get(exactKey) ??
        this.#transcriptBlocks.get(fallbackKey) ??
        (attemptId === "attempt-worker"
          ? fixtureTranscriptBlocks(this.#transcriptAssistantText)
          : [fixtureTranscriptBlock(`${attemptId}:assistant`, "Agent transcript available.")]);
      const gate = this.#transcriptGates.get(exactKey) ?? this.#transcriptGates.get(fallbackKey);
      if (gate !== undefined) await gate;
      const page = fixtureTranscriptPage(
        blocks,
        params,
        attempt?.sessionId ?? `session-${attemptId}`,
      );
      if (
        this.#driftTranscriptSnapshotOnce &&
        isRecord(params) &&
        typeof params.cursor === "string"
      ) {
        this.#driftTranscriptSnapshotOnce = false;
        page.snapshot.sha256 = `sha256:${"b".repeat(64)}`;
      }
      result = page as unknown as JsonValue;
    } else if (method === "run.create") {
      await this.#runCreateGate;
      this.revision += 1;
      const run = fixtureRun();
      run.id = "run-created";
      run.lifecycle.runId = run.id;
      run.git.runId = run.id;
      run.git.namespace.root = `/project/.git/koni/worktrees/runs/${run.id}`;
      run.git.namespace.runRef = `refs/heads/koni/runs/${run.id}`;
      run.git.namespace.planningWorktree = `${run.git.namespace.root}/planning`;
      run.git.namespace.runWorktree = `${run.git.namespace.root}/integration`;
      run.git.namespace.ticketRoot = `${run.git.namespace.root}/tickets`;
      run.git.planning.worktree = run.git.namespace.planningWorktree;
      run.git.run.branchRef = run.git.namespace.runRef;
      run.git.run.worktree = run.git.namespace.runWorktree;
      if (isRecord(params) && typeof params.objective === "string")
        run.objective = params.objective;
      if (isRecord(params) && typeof params.runTypeId === "string")
        run.runTypeId = params.runTypeId;
      this.#runs.push(run);
      result = {
        runId: run.id,
        status: "starting",
        ...(this.runCreateWarning === undefined ? {} : { warning: this.runCreateWarning }),
      };
    } else if (method === "config.documents.update") {
      const documentId =
        isRecord(params) && typeof params.documentId === "string" ? params.documentId : undefined;
      const source =
        isRecord(params) && typeof params.source === "string" ? params.source : undefined;
      const document = this.#configDocumentCatalog.documents.find(
        (candidate) => candidate.id === documentId,
      );
      if (document === undefined || source === undefined)
        throw new Error("configuration update fixture is incomplete");
      this.#configDocumentSources.set(document.id, source);
      this.revision += 1;
      result = this.#configMutationResult(this.#configDocumentCatalog.documents, document.id);
    } else if (method === "config.documents.create") {
      if (
        !isRecord(params) ||
        typeof params.title !== "string" ||
        typeof params.domain !== "string" ||
        typeof params.kind !== "string" ||
        typeof params.format !== "string"
      ) {
        throw new Error("configuration create fixture is incomplete");
      }
      const id = `document-created-${this.#configDocumentMutation}`;
      const source =
        params.format === "markdown"
          ? `# ${params.title}\n`
          : `schema_version: \"2.0\"\ntitle: ${params.title}\n`;
      this.#configDocumentSources.set(id, source);
      const document = {
        id,
        title: params.title,
        domain: params.domain,
        kind: params.kind,
        resourceKinds: [params.kind],
        format: params.format,
        sizeBytes: source.length,
        sourceToken: this.#nextConfigDigest(),
        capabilities: { read: true, update: true, rename: true, delete: true },
      } as ConfigDocumentSummary;
      this.revision += 1;
      result = this.#configMutationResult(
        [...this.#configDocumentCatalog.documents, document],
        document.id,
      );
    } else if (method === "config.documents.rename") {
      if (
        !isRecord(params) ||
        typeof params.documentId !== "string" ||
        typeof params.title !== "string"
      ) {
        throw new Error("configuration rename fixture is incomplete");
      }
      const documents = this.#configDocumentCatalog.documents.map((document) =>
        document.id === params.documentId
          ? { ...document, title: params.title as string }
          : document,
      );
      this.revision += 1;
      result = this.#configMutationResult(documents, params.documentId);
    } else if (method === "config.documents.delete") {
      if (!isRecord(params) || typeof params.documentId !== "string")
        throw new Error("configuration delete fixture is incomplete");
      this.#configDocumentSources.delete(params.documentId);
      this.revision += 1;
      result = this.#configMutationResult(
        this.#configDocumentCatalog.documents.filter(
          (document) => document.id !== params.documentId,
        ),
      );
    } else if (method === "config.run-types.create") {
      if (!isRecord(params) || typeof params.title !== "string")
        throw new Error("run type create fixture is incomplete");
      const id = `document-run-type-${this.#configDocumentMutation}`;
      const source = `schema_version: \"2.0\"\nid: ${params.title.toLowerCase().replace(/\s+/gu, "-")}\n`;
      this.#configDocumentSources.set(id, source);
      const document: ConfigDocumentSummary = {
        id,
        title: params.title,
        domain: "run_types",
        kind: "run_type",
        resourceKinds: ["run_type"],
        format: "yaml",
        sizeBytes: source.length,
        sourceToken: this.#nextConfigDigest(),
        capabilities: { read: true, update: true, rename: true, delete: true },
      };
      this.revision += 1;
      result = this.#configMutationResult(
        [...this.#configDocumentCatalog.documents, document],
        document.id,
        2,
      );
    } else if (
      new Set([
        "question.answer",
        "question.revise",
        "question.resolve",
        "config.update",
        "config.resource.create",
        "config.resource.duplicate",
        "config.resource.delete",
        "plan.revise",
        "plan.approve",
        "run.pause",
        "run.resume",
        "run.action.execute",
        "run.delete",
        "run.merge",
        "run.merge.authorize",
        "agent.steer",
        "agent.follow_up",
        "profile.conflicts.resolve",
      ]).has(method)
    ) {
      this.revision += 1;
      if ((method === "question.answer" || method === "question.revise") && isRecord(params)) {
        const run = this.#runs.find((candidate) => candidate.id === params.runId);
        const question = run?.questions[String(params.questionId)];
        const batch =
          run === undefined || typeof params.batchId !== "string"
            ? undefined
            : run.questionBatches?.[params.batchId];
        if (
          run !== undefined &&
          question !== undefined &&
          batch !== undefined &&
          typeof params.expectedVersion === "number"
        ) {
          const updated =
            method === "question.revise"
              ? reviseQuestionBatchAnswer(batch, {
                  expectedVersion: params.expectedVersion,
                  questionId: question.id,
                  ...(typeof params.selectedOptionId === "string"
                    ? { selectedOptionId: params.selectedOptionId }
                    : {}),
                  ...(typeof params.notes === "string" ? { notes: params.notes } : {}),
                  savedAt: "2026-07-16T00:00:20.000Z",
                })
              : saveQuestionBatchAnswer(batch, {
                  expectedVersion: params.expectedVersion,
                  questionId: question.id,
                  ...(typeof params.selectedOptionId === "string"
                    ? { selectedOptionId: params.selectedOptionId }
                    : {}),
                  ...(typeof params.notes === "string" ? { notes: params.notes } : {}),
                  savedAt: "2026-07-16T00:00:20.000Z",
                });
          run.questionBatches![batch.id] = updated;
          const answer = updated.revisions.find(
            (candidate) => candidate.revision === updated.currentRevision,
          )!.answers[question.id]!;
          question.selectedOptionId = answer.selectedOptionId;
          question.notes = answer.notes;
          question.answerRevision = answer.revision;
          result = {
            runId: run.id,
            batchId: batch.id,
            questionId: question.id,
            batchVersion: updated.version,
          };
        } else if (question !== undefined) {
          question.answeredAt = "2026-07-16T00:00:20.000Z";
          question.selectedOptionId =
            typeof params.selectedOptionId === "string" ? params.selectedOptionId : undefined;
          question.notes = typeof params.notes === "string" ? params.notes : undefined;
        }
      }
      if (method === "question.resolve" && isRecord(params)) {
        const run = this.#runs.find((candidate) => candidate.id === params.runId);
        if (
          run !== undefined &&
          typeof params.batchId === "string" &&
          typeof params.expectedVersion === "number"
        ) {
          result = resolveFixtureQuestionBatch(run, params.batchId, params.expectedVersion);
        }
      }
      if (method === "run.action.execute" && isRecord(params)) {
        const run = this.#runs.find((candidate) => candidate.id === params.runId);
        const capabilityId = typeof params.capabilityId === "string" ? params.capabilityId : "";
        const values = isRecord(params.values) ? params.values : {};
        if (run?.plan !== undefined && capabilityId.endsWith(":revise")) {
          run.plan.status = "planning";
          run.lifecycle.phase = "planning";
        } else if (run?.plan !== undefined && capabilityId.endsWith(":approve")) {
          run.plan.status = "approved";
          run.lifecycle.phase = "approving";
        } else if (run !== undefined && capabilityId === "run:pause") {
          run.lifecycle.phase = "pausing";
        } else if (run !== undefined && capabilityId === "run:resume") {
          run.lifecycle.phase = "executing";
        } else if (
          run?.executionConfig !== undefined &&
          capabilityId === "run:orchestration" &&
          typeof values.maxParallel === "number"
        ) {
          run.executionConfig.maxParallel = values.maxParallel;
        } else if (
          run !== undefined &&
          capabilityId === "run:questions:resolve" &&
          typeof values.batchId === "string" &&
          typeof values.expectedVersion === "number"
        ) {
          result = resolveFixtureQuestionBatch(run, values.batchId, values.expectedVersion);
        }
      }
      if (method === "config.update" && isRecord(params) && isRecord(params.values)) {
        this.#configValues = structuredClone(params.values);
      }
      if (method === "plan.revise") {
        const run = this.#runs.find(
          (candidate) => candidate.id === (isRecord(params) ? params.runId : undefined),
        );
        if (run?.plan !== undefined) {
          run.plan.status = "planning";
          run.lifecycle.phase = "planning";
        }
      }
      if (method === "plan.approve") {
        const run = this.#runs.find(
          (candidate) => candidate.id === (isRecord(params) ? params.runId : undefined),
        );
        if (run?.plan !== undefined) {
          run.plan.status = "approved";
          run.lifecycle.phase = "approving";
        }
      }
      if (
        method === "profile.conflicts.resolve" &&
        isRecord(params) &&
        typeof params.path === "string"
      ) {
        this.#profileConflicts = {
          ...this.#profileConflicts,
          lifecycleGeneration: this.#profileConflicts.lifecycleGeneration + 1,
          conflicts: this.#profileConflicts.conflicts.filter(
            (conflict) => conflict.path !== params.path,
          ),
        };
      }
      if (result === undefined) result = { accepted: true };
    } else throw new Error(`FakeAuthority has no RPC fixture for ${method}`);
    return {
      type: "response",
      id: `response-${this.calls.length}`,
      ok: true,
      revision: this.revision,
      ...(result === undefined ? {} : { result }),
    };
  }
}

class FakeTerminal implements Terminal {
  public starts = 0;
  public stops = 0;
  public get columns(): number {
    return 120;
  }
  public get rows(): number {
    return 40;
  }
  public get kittyProtocolActive(): boolean {
    return false;
  }
  public start(): void {
    this.starts += 1;
  }
  public stop(): void {
    this.stops += 1;
  }
  public async drainInput(): Promise<void> {}
  public write(): void {}
  public moveBy(): void {}
  public hideCursor(): void {}
  public showCursor(): void {}
  public clearLine(): void {}
  public clearFromCursor(): void {}
  public clearScreen(): void {}
  public setTitle(): void {}
  public setProgress(): void {}
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
        decisions: "## Decisions\nPreserve the existing contract.",
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
        targetNodeIds: ["claim-one"],
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
    questions: {
      "question-one": {
        id: "question-one",
        attemptId: "attempt-worker",
        prompt: "How should existing notes transition to the new form?",
        options: [
          {
            id: "preserve",
            label: "Preserve notes",
            description: "Preserve existing content and expose it in the first field.",
          },
          {
            id: "replace",
            label: "Replace notes",
            description: "Start with an empty structured form.",
          },
        ],
        allowsNotes: true,
        askedAt: "2026-07-16T00:00:03.000Z",
        answeredAt: undefined,
        selectedOptionId: undefined,
        notes: undefined,
      },
    },
    activity: [
      {
        id: "event-one",
        at: "2026-07-16T00:00:01.000Z",
        kind: "graph_added",
        message: "Architecture boundary mapped",
        ticketId: "ticket-one",
        nodeId: "claim-one",
      },
    ],
    git: {
      protocol: "koni.git-lifecycle.v1",
      runId: "run-one",
      projectRoot: "/project",
      commonDirectory: "/project/.git",
      target: { ref: "refs/heads/main", selectedOid: "a".repeat(40) },
      namespace: {
        root: "/project/.git/koni/worktrees/runs/run-one",
        runRef: "refs/heads/koni/runs/run-one",
        planningWorktree: "/project/.git/koni/worktrees/runs/run-one/planning",
        runWorktree: "/project/.git/koni/worktrees/runs/run-one/integration",
        ticketRoot: "/project/.git/koni/worktrees/runs/run-one/tickets",
      },
      planning: {
        status: "retired",
        baseOid: "a".repeat(40),
        worktree: "/project/.git/koni/worktrees/runs/run-one/planning",
        createdAt: undefined,
        retiredAt: undefined,
        blocker: undefined,
      },
      run: {
        status: "ready",
        branchRef: "refs/heads/koni/runs/run-one",
        worktree: "/project/.git/koni/worktrees/runs/run-one/integration",
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

function fixtureRunWithId(id: string): RunRecord {
  const run = fixtureRun();
  run.id = id;
  run.lifecycle.runId = id;
  run.createdAt = "2026-07-15T00:00:00.000Z";
  run.updatedAt = "2026-07-15T00:00:04.000Z";
  run.git.runId = id;
  run.git.namespace.root = `/project/.git/koni/worktrees/runs/${id}`;
  run.git.namespace.runRef = `refs/heads/koni/runs/${id}`;
  run.git.namespace.planningWorktree = `${run.git.namespace.root}/planning`;
  run.git.namespace.runWorktree = `${run.git.namespace.root}/integration`;
  run.git.namespace.ticketRoot = `${run.git.namespace.root}/tickets`;
  run.git.planning.worktree = run.git.namespace.planningWorktree;
  run.git.run.branchRef = run.git.namespace.runRef;
  run.git.run.worktree = run.git.namespace.runWorktree;
  return run;
}

async function attachFixtureProposal(run: RunRecord): Promise<string> {
  return (await attachCanonicalProposalFixture(run)).id;
}

function fixtureStageControls(run: RunRecord) {
  const currentIndex =
    run.currentPipelineStageId === undefined
      ? -1
      : run.pipelineStageIds.indexOf(run.currentPipelineStageId);
  const stages = run.pipelineStageIds.map((id, position) => {
    const current = position === currentIndex;
    const actions: StageActionCapability[] = [];
    if (id === "approval") {
      const available = current && run.lifecycle.phase === "awaiting_approval";
      actions.push(
        defineBuiltInStageAction({
          id: `stage:${id}:approve`,
          intent: "approve_run",
          available,
          reason: available ? "The plan is ready for approval." : "Approval is not current.",
        }),
        defineBuiltInStageAction({
          id: `stage:${id}:revise`,
          intent: "revise_run_plan",
          available,
          reason: available ? "The plan can be revised with steering." : "Revision is not current.",
          form: {
            title: "Revise plan",
            description: "Give the planner durable steering.",
            submitLabel: "Revise plan",
            fields: [
              {
                key: "instructions",
                label: "Steering instructions",
                description: "Exact revision guidance.",
                kind: "multiline",
                required: true,
                locked: false,
                visibility: "shown",
              },
            ],
          },
        }),
      );
    }
    if (id === "promotion") {
      const available = current && run.lifecycle.phase === "merge_ready";
      actions.push(
        defineBuiltInStageAction({
          id: `stage:${id}:merge-review`,
          intent: "inspect_run_merge",
          available,
          reason: available
            ? "The verified candidate is ready for review."
            : "Merge review is not ready.",
        }),
      );
    }
    const primary =
      actions.find((action) => action.availability.state === "available") ?? actions[0];
    return {
      id,
      title: id.replace(/[-_]/gu, " ").replace(/\b\w/gu, (letter) => letter.toUpperCase()),
      kind: id === "approval" ? "approval" : id === "promotion" ? "promotion" : "automatic",
      category: id === "approval" || id === "promotion" ? "operator_gate" : "compiler_work",
      position,
      status:
        run.lifecycle.phase === "completed" || position < currentIndex
          ? ("succeeded" as const)
          : current
            ? run.lifecycle.phase === "blocked"
              ? ("blocked" as const)
              : run.lifecycle.phase === "awaiting_approval"
                ? ("waiting" as const)
                : ("active" as const)
            : ("pending" as const),
      current,
      interaction:
        actions.length === 0
          ? defineStageInteraction({
              mode: "automatic",
              reason: "The compiler advances this stage.",
              actions,
            })
          : defineStageInteraction({
              mode: "operator",
              reason: primary?.availability.reason ?? "Operator action available.",
              actions,
              ...(primary === undefined ? {} : { primaryActionId: primary.id }),
            }),
      actions,
    };
  });
  const terminalResolverRetry =
    run.lifecycle.phase === "blocked" &&
    run.lifecycle.blocker?.includes("configured terminal resolver") === true;
  const pausable = new Set([
    "planning",
    "awaiting_questions",
    "awaiting_approval",
    "approving",
    "executing",
    "verifying",
    "merge_ready",
  ]).has(run.lifecycle.phase);
  const runActions: StageActionCapability[] = [
    defineBuiltInStageAction({
      id: "run:pause",
      intent: "pause_run",
      available: pausable,
      reason: pausable ? "The run can be paused." : "Pause is not available now.",
    }),
    defineBuiltInStageAction({
      id: "run:resume",
      intent: run.lifecycle.phase === "blocked" ? "retry_blocked" : "resume_run",
      available:
        run.lifecycle.phase === "paused" ||
        (run.lifecycle.phase === "blocked" && !terminalResolverRetry),
      reason:
        run.lifecycle.phase === "paused" || run.lifecycle.phase === "blocked"
          ? terminalResolverRetry
            ? "The exact terminal resolver retry control is required."
            : "The run can continue from durable state."
          : "Resume is not available now.",
    }),
    defineBuiltInStageAction({
      id: "run:orchestration",
      intent: "update_orchestration",
      available: run.executionConfig !== undefined,
      reason:
        run.executionConfig === undefined
          ? "This fixture has no execution config."
          : "Future admissions can change.",
      form: {
        title: "Orchestration",
        description: "Change future admission only.",
        submitLabel: "Update orchestration",
        fields: [
          {
            key: "maxParallel",
            label: "Max parallel agents",
            description: "Positive whole number.",
            kind: "integer",
            required: true,
            locked: false,
            visibility: "shown",
            defaultValue: run.executionConfig?.maxParallel ?? 1,
            minimum: 1,
            maximum: Number.MAX_SAFE_INTEGER,
          },
        ],
      },
    }),
    defineBuiltInStageAction({
      id: "run:delete-review",
      intent: "inspect_run_deletion",
      available: run.lifecycle.phase !== "deleted" && run.lifecycle.phase !== "deleting",
      reason: "Review owned resources before deletion.",
    }),
    defineBuiltInStageAction({
      id: "run:merge-review",
      intent: "inspect_run_merge",
      available: run.lifecycle.phase === "merge_ready",
      reason:
        run.lifecycle.phase === "merge_ready"
          ? "Review the prepared merge."
          : "The run is not merge ready.",
    }),
  ];
  if (terminalResolverRetry) {
    runActions.push(
      defineBuiltInStageAction({
        id: "run:terminal-resolver:retry:resolver-one",
        intent: "retry_terminal_resolver",
        available: true,
        reason:
          "The failed configured resolver can be retried only through this exact compiler-bound control.",
        form: {
          title: "Retry terminal resolver",
          description: "Archive the failed resolver cycle and issue a fresh cycle.",
          submitLabel: "Retry resolver",
          fields: [
            {
              key: "resolverTicketId",
              label: "Resolver",
              description: "Exact resolver ticket",
              kind: "text",
              required: true,
              locked: true,
              visibility: "shown",
              lockedValue: "resolver-one",
            },
            {
              key: "sourceTicketId",
              label: "Failed source",
              description: "Exact failed source ticket",
              kind: "text",
              required: true,
              locked: true,
              visibility: "shown",
              lockedValue: "ticket-one",
            },
            {
              key: "failedAttemptId",
              label: "Failed attempt",
              description: "Exact terminal failure evidence",
              kind: "text",
              required: true,
              locked: true,
              visibility: "shown",
              lockedValue: "attempt-resolver-one",
            },
            {
              key: "message",
              label: "Retry reason",
              description: "Why this exact retry is appropriate",
              kind: "multiline",
              required: true,
              locked: false,
              visibility: "shown",
            },
          ],
        },
      }),
    );
  }
  const openBatch = Object.values(run.questionBatches ?? {}).find(
    (batch) => batch.status !== "resolved",
  );
  if (openBatch !== undefined) {
    const revision = openBatch.revisions.find(
      (candidate) => candidate.revision === openBatch.currentRevision,
    )!;
    const ready = revision.questions.every(
      (question) => revision.answers[question.id] !== undefined,
    );
    runActions.push(
      defineBuiltInStageAction({
        id: "run:questions:resolve",
        intent: "resolve_questions",
        available: openBatch.status === "pending_answers" && ready,
        reason: ready
          ? "All answers are saved and may be submitted."
          : "Save every answer before submitting the batch.",
        form: {
          title: "Submit answers",
          description: "Seal the durable batch and resume its attempt.",
          submitLabel: "Submit answers",
          fields: [
            {
              key: "batchId",
              label: "Question batch",
              description: "Current durable batch.",
              kind: "text",
              required: true,
              locked: true,
              visibility: "summary",
              lockedValue: openBatch.id,
              displayValue: "Current question set",
            },
            {
              key: "expectedVersion",
              label: "Batch version",
              description: "Current answer-set version.",
              kind: "integer",
              required: true,
              locked: true,
              visibility: "summary",
              lockedValue: openBatch.version,
              displayValue: "Latest saved answers",
            },
          ],
        },
      }),
    );
  }
  return defineStageCapabilityCatalog({
    protocol: "koni.stage-capability-catalog.v1",
    binding: {
      runId: run.id,
      runRevision: run.revision,
      generation: run.generation,
      phase: run.lifecycle.phase,
    },
    stages,
    runActions,
  });
}

function resolveFixtureQuestionBatch(
  run: RunRecord,
  batchId: string,
  expectedVersion: number,
): JsonValue {
  const batch = run.questionBatches?.[batchId];
  if (batch === undefined) throw new Error("question batch fixture is missing");
  const queued = queueQuestionBatchResume(batch, {
    expectedVersion,
    at: "2026-07-16T00:00:21.000Z",
  });
  const resolved = resolveQuestionBatch(queued, {
    expectedVersion: queued.version,
    at: "2026-07-16T00:00:22.000Z",
  });
  run.questionBatches![batchId] = resolved;
  const revision = resolved.revisions.find(
    (candidate) => candidate.revision === resolved.currentRevision,
  )!;
  for (const question of revision.questions) {
    const projection = run.questions[question.id];
    if (projection !== undefined) projection.answeredAt = "2026-07-16T00:00:22.000Z";
  }
  return { runId: run.id, batchId, status: "resolved", batchVersion: resolved.version };
}

function fixtureLineage(run: RunRecord, ticketId?: string) {
  const all = Object.values(run.attempts);
  const children = new Map<string, string[]>();
  for (const attempt of all) {
    const parent = attempt.lineage?.parentAttemptId;
    if (parent === undefined) continue;
    children.set(parent, [...(children.get(parent) ?? []), attempt.id]);
  }
  return {
    protocol: "koni.run-attempt-lineage.v1",
    runId: run.id,
    runRevision: run.revision,
    attempts: all
      .filter((attempt) => ticketId === undefined || attempt.ticketId === ticketId)
      .map((attempt) => {
        const ticket = run.tickets[attempt.ticketId];
        const step = ticket?.steps.find((candidate) => candidate.id === attempt.stepId);
        const childAttemptIds = children.get(attempt.id) ?? [];
        return {
          attemptId: attempt.id,
          persona: attempt.personaId
            .replace(/[-_]/gu, " ")
            .replace(/\b\w/gu, (letter) => letter.toUpperCase()),
          ticket: ticket?.title ?? "Run planning",
          step: step?.title ?? attempt.stepId.replace(/[-_]/gu, " "),
          status: attempt.status,
          reason: attempt.lineage?.reason ?? "initial",
          branchEpoch: attempt.lineage?.branchEpoch ?? 0,
          ...(attempt.lineage?.parentAttemptId === undefined
            ? {}
            : { parentAttemptId: attempt.lineage.parentAttemptId }),
          childAttemptIds,
          activeLeaf:
            childAttemptIds.length === 0 &&
            new Set(["queued", "running", "waiting_question", "terminal_accepted"]).has(
              attempt.status,
            ),
        };
      }),
  };
}

function fixtureGraph(): { nodes: JsonValue[]; edges: JsonValue[] } {
  return {
    nodes: [
      {
        schema_version: "1.0",
        id: "claim-one",
        type: "claim",
        title: "Claim result supports architecture boundary",
        status: "active",
        spec: { purpose: "Verify the architecture boundary end to end" },
        edges: { tested_by: ["experiment-one"] },
        annotations: {},
      },
      {
        schema_version: "1.0",
        id: "experiment-one",
        type: "experiment",
        title: "Test claim result",
        status: "planned",
        spec: {},
        edges: {},
        annotations: {},
      },
    ],
    edges: [{ source: "claim-one", relation: "tested_by", target: "experiment-one" }],
  };
}

function fixtureModels(): ControlModelOption[] {
  return [
    {
      provider: "openai-codex",
      id: "gpt-small",
      name: "GPT Small",
      reasoning: true,
      thinkingLevels: ["off", "minimal", "low", "medium", "high"],
      available: true,
    },
    {
      provider: "openai-codex",
      id: "gpt-worker",
      name: "GPT Worker",
      reasoning: true,
      thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh"],
      available: true,
    },
    {
      provider: "openai-codex",
      id: "gpt-review",
      name: "GPT Review",
      reasoning: true,
      thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
      available: true,
    },
    {
      provider: "community",
      id: "custom-one",
      name: "Community Custom",
      reasoning: true,
      thinkingLevels: ["off", "high"],
      available: true,
    },
  ];
}

function fixtureControlCatalog() {
  const intake = [
    {
      id: "goal",
      label: "Goal",
      description: "Describe the outcome Koni should deliver.",
      kind: "text",
      required: true,
      options: [],
    },
  ];
  const stages = [
    { id: "intake", title: "Validate intake", kind: "action", included: true },
    { id: "plan", title: "Plan architecture and implementation", kind: "planning", included: true },
    { id: "risk", title: "Plan risk controls", kind: "planning", included: false },
    { id: "orchestrate", title: "Execute compiled work", kind: "orchestration", included: true },
    { id: "review", title: "Independent review", kind: "agent_review", included: false },
    { id: "promotion", title: "Merge the completed run", kind: "promotion", included: true },
  ];
  const roles = [
    {
      id: "planner",
      title: "Planner",
      provider: "openai-codex",
      model: "gpt-small",
      thinkingLevel: "high",
    },
    {
      id: "lead",
      title: "Lead",
      provider: "openai-codex",
      model: "gpt-small",
      thinkingLevel: "high",
    },
    {
      id: "ticket_worker",
      title: "Worker",
      provider: "openai-codex",
      model: "gpt-worker",
      thinkingLevel: "medium",
    },
    {
      id: "reviewer",
      title: "Reviewer",
      provider: "openai-codex",
      model: "gpt-review",
      thinkingLevel: "max",
    },
  ];
  const launchDefaults = {
    objectiveFieldId: "goal",
    intake,
    questionDefaultScope: "run",
    autoStart: true,
    runCardSections: ["goal", "pipeline", "graph", "tickets", "checks", "report"],
  };
  return {
    protocol: "koni.control-catalog.v1",
    defaultRunTypeId: "medium",
    runTypes: [
      {
        id: "small",
        title: "Small",
        description: "small",
        questionPolicy: "none",
        maxParallel: 1,
        startMode: "planning",
        stages,
        roles,
        ...launchDefaults,
      },
      {
        id: "medium",
        title: "Medium",
        description: "medium",
        questionPolicy: "some",
        maxParallel: 3,
        startMode: "planning",
        stages: stages.map((stage) => ({ ...stage, included: true })),
        roles,
        ...launchDefaults,
      },
      {
        id: "large",
        title: "Large",
        description: "large",
        questionPolicy: "many",
        maxParallel: 5,
        startMode: "planning",
        stages: stages.map((stage) => ({ ...stage, included: true })),
        roles,
        ...launchDefaults,
      },
    ],
  };
}

function fixtureConfigCatalog() {
  const section = (id: string, title: string, resourceTitle: string) => ({
    id,
    title,
    description: `Configure ${title.toLowerCase()}.`,
    createOptions:
      id === "project"
        ? [
            {
              id: "template-project",
              title: "Project preset",
              description:
                "Add another semantic project preset with inherited defaults and a fully validated configuration boundary. ".repeat(
                  12,
                ),
              nameLabel: "Preset name",
              suggestedName: "New project preset",
            },
          ]
        : [],
    resources: [
      {
        id: `${id}-resource`,
        title: resourceTitle,
        description: `Guided settings for ${resourceTitle.toLowerCase()}.`,
        canDuplicate: id === "project",
        canDelete: id === "project",
        fields:
          id === "project"
            ? [
                {
                  key: "project.name",
                  label: "Display name",
                  description: "The human-readable project name shown to operators.",
                  kind: "text",
                },
                {
                  key: "project.parallel",
                  label: "Max parallel",
                  description: "Maximum number of concurrently admitted assignments.",
                  kind: "integer",
                  minimum: 1,
                },
                {
                  key: "project.enabled",
                  label: "Enabled",
                  description: "Whether this project capability is enabled.",
                  kind: "boolean",
                },
              ]
            : [],
      },
    ],
  });
  return {
    protocol: "koni.config-catalog.v1",
    sections: [
      section("project", "Project", "Project identity"),
      section("run-types", "Run Types", "Complexity presets"),
      section("agents", "Agents", "Persona cards"),
      section("workflows", "Workflows & Tickets", "Workflow catalog"),
      section("graph", "Graph Model & Rules", "Graph vocabulary"),
      section("actions", "Actions & Checks", "Executable checks"),
      section("reports", "Reports & Views", "Operator reports"),
      section("advanced", "Advanced", "Advanced settings"),
    ],
  };
}

function fixtureConfigDocumentCatalog(): ConfigDocumentCatalog {
  const projectSource = 'schema_version: "2.0"\nname: Notes\n';
  const agentSource = 'schema_version: "2.0"\nid: implementer\nprompt: Implement the ticket.\n';
  return {
    protocol: "koni.config-document-catalog.v1",
    catalogToken: `sha256:${"1".repeat(64)}`,
    profile: { id: "software", version: "1.0.0" },
    valid: true,
    diagnostics: [],
    documents: [
      {
        id: "document-project",
        title: "Project Settings",
        domain: "project",
        kind: "project",
        resourceKinds: ["project"],
        format: "yaml",
        sizeBytes: projectSource.length,
        sourceToken: `sha256:${"2".repeat(64)}`,
        capabilities: {
          read: true,
          update: true,
          rename: false,
          delete: false,
          reason: "This required project resource cannot be renamed or deleted.",
        },
      },
      {
        id: "document-agent",
        title: "Implementer",
        domain: "agents",
        kind: "native_agent",
        resourceKinds: ["native_agent", "persona", "agent_policy"],
        format: "yaml",
        sizeBytes: agentSource.length,
        sourceToken: `sha256:${"3".repeat(64)}`,
        capabilities: { read: true, update: true, rename: true, delete: true },
      },
    ],
  };
}

function fixtureProfileConflictCatalog(
  includeSecond = false,
  empty = false,
): ControlProfileConflictCatalog {
  const conflicts: ControlProfileConflictCatalog["conflicts"] = empty
    ? []
    : [
        {
          path: "resources/pi-packages.yaml",
          title: "Pi Packages",
          domain: "resources",
          reason: "modified",
          currentSha256: `sha256:${"c".repeat(64)}`,
          upstreamSha256: `sha256:${"d".repeat(64)}`,
        },
        ...(includeSecond
          ? [
              {
                path: "agents/reviewer.yaml",
                title: "Reviewer",
                domain: "agents",
                reason: "modified" as const,
                currentSha256: `sha256:${"e".repeat(64)}` as const,
                upstreamSha256: `sha256:${"f".repeat(64)}` as const,
              },
            ]
          : []),
      ];
  return {
    protocol: "koni.profile-upstream-conflict-catalog.v1",
    lifecycleGeneration: 3,
    profileVersion: "0.8.0",
    conflicts,
  };
}

function fixtureProfileConflictInspection(
  catalog: ControlProfileConflictCatalog,
  selectedPath: string,
): ControlProfileConflictInspection {
  const conflict = catalog.conflicts.find((candidate) => candidate.path === selectedPath);
  if (conflict === undefined) throw new Error(`missing conflict fixture for ${selectedPath}`);
  const packages = selectedPath === "resources/pi-packages.yaml";
  return {
    protocol: "koni.profile-upstream-conflict-inspection.v1",
    lifecycleGeneration: catalog.lifecycleGeneration,
    conflict,
    currentText: packages ? "packages:\n  - project-tool\n" : "prompt: Project reviewer\n",
    upstreamText: packages ? "packages:\n  - upstream-tool\n" : "prompt: Upstream reviewer\n",
  };
}

interface FixtureTranscriptBlock {
  id: string;
  kind: "user" | "assistant" | "thinking" | "tool_call" | "tool_result" | "compaction" | "notice";
  title: string;
  markdown: string;
  timestamp?: string;
  branch: boolean;
  error: boolean;
  truncated: boolean;
  chunk?: { index: number; total: number; totalBytes: number };
}

function transcriptFixtureKey(attemptId: string, runId?: string): string {
  return `${runId ?? "*"}\u0000${attemptId}`;
}

function fixtureTranscriptBlock(id: string, markdown: string): FixtureTranscriptBlock {
  return {
    id,
    kind: "assistant",
    title: "Assistant",
    markdown,
    timestamp: "2026-07-16T00:00:03.000Z",
    branch: false,
    error: false,
    truncated: false,
  };
}

function fixtureTranscriptBlocks(
  assistantText = "I inspected the existing notes route.",
): FixtureTranscriptBlock[] {
  const at = Date.parse("2026-07-16T00:00:03.000Z");
  const timestamp = (offset: number): string => new Date(at + offset).toISOString();
  return [
    {
      ...fixtureTranscriptBlock("user-one:user", "Inspect the notes flow."),
      kind: "user",
      title: "You",
      timestamp: timestamp(0),
    },
    {
      ...fixtureTranscriptBlock("assistant-one:thinking-0", "Need to preserve the storage seam."),
      kind: "thinking",
      title: "Reasoning",
      timestamp: timestamp(1),
    },
    {
      ...fixtureTranscriptBlock("assistant-one:assistant-1", assistantText),
      timestamp: timestamp(1),
    },
    {
      ...fixtureTranscriptBlock("assistant-one:tool-2", "- **Path:** app/notes.tsx"),
      kind: "tool_call",
      title: "Read File",
      timestamp: timestamp(1),
    },
    {
      ...fixtureTranscriptBlock("result-one:result", "Loaded the existing component."),
      kind: "tool_result",
      title: "Read File",
      timestamp: timestamp(2),
    },
    {
      ...fixtureTranscriptBlock("assistant-branch:assistant-0", "Alternative branch summary."),
      timestamp: timestamp(3),
      branch: true,
    },
  ];
}

function fixtureTranscriptPage(
  blocks: FixtureTranscriptBlock[],
  params?: JsonValue,
  sessionId = "session-worker",
) {
  const request = isRecord(params) ? params : {};
  const limit = typeof request.limit === "number" ? request.limit : TRANSCRIPT_PAGE_LIMIT;
  const cursor = typeof request.cursor === "string" ? request.cursor : undefined;
  const before =
    cursor === undefined ? blocks.length : Number.parseInt(cursor.replace(/^before:/u, ""), 10);
  if (!Number.isSafeInteger(before) || before < 0 || before > blocks.length) {
    throw new Error(`invalid transcript fixture cursor: ${cursor ?? "missing"}`);
  }
  const start = Math.max(0, before - limit);
  return {
    protocol: "koni.pi-transcript-page.v1",
    session: { id: sessionId, version: 3 },
    snapshot: {
      entryCount: blocks.length,
      ...(blocks.length === 0 ? {} : { lastEntryId: blocks.at(-1)!.id }),
      sha256: `sha256:${"a".repeat(64)}`,
    },
    totalBlocks: blocks.length,
    startBlock: start,
    blocks: structuredClone(blocks.slice(start, before)),
    usage: {
      input: "0",
      output: "0",
      cacheRead: "0",
      cacheWrite: "0",
      newTokens: "0",
      allTokens: "0",
    },
    diagnostics: [],
    ...(before >= blocks.length
      ? {}
      : { previousCursor: `before:${Math.min(blocks.length, before + limit)}` }),
    ...(start === 0 ? {} : { nextCursor: `before:${start}` }),
  };
}

function awaitingApprovalRun(): RunRecord {
  const run = fixtureRun();
  let lifecycle = newRunLifecycle(run.id);
  lifecycle = reduceRunLifecycle(lifecycle, { type: "planning_started", atMs: 1_000 }).state;
  lifecycle = reduceRunLifecycle(lifecycle, { type: "plan_submitted", atMs: 2_000 }).state;
  run.lifecycle = lifecycle;
  run.currentPipelineStageId = "approval";
  run.plan = {
    revision: 2,
    status: "awaiting_approval",
    full: {
      architecture: "## FULL-ONLY\nComplete architecture details for agents.",
      decisions: "## Complete decisions",
      risk: "## Complete risk",
      verification: "## Complete verification",
    },
    concise: {
      architecture: [
        {
          title: "Existing seam",
          description: "Reuse the stable boundary without a parallel abstraction.",
        },
      ],
      decisions: [
        {
          title: "Preserve contract",
          description: "Keep existing notes readable during migration.",
        },
      ],
      risk: [
        {
          title: "Low migration risk",
          description: "Use additive parsing and a focused regression proof.",
        },
      ],
      verification: [
        { title: "Prove both paths", description: "Exercise existing and newly structured notes." },
      ],
    },
    graphSeed: {
      rootSpec: {},
      nodes: [{ key: "change", type: "change", title: "Migrate note fields", spec: {} }],
      edges: [],
    },
    steeringHistory: [],
  };
  return run;
}

function questionBatchRun(): RunRecord {
  const run = fixtureRun();
  run.lifecycle.phase = "awaiting_questions";
  run.attempts["attempt-worker"]!.status = "waiting_question";
  const batch = createQuestionBatch({
    id: "batch-notes",
    attemptId: "attempt-worker",
    createdAt: "2026-07-16T00:00:10.000Z",
    questions: [
      {
        id: "question-storage",
        prompt:
          "Which storage transition should preserve existing notes while adding structured fields?",
        options: [
          {
            id: "additive",
            label: "Additive migration",
            description: "Read both shapes and write the new structure.",
          },
          {
            id: "replace",
            label: "Replace immediately",
            description: "Require every note to use the new shape at once.",
          },
        ],
        allowsNotes: true,
        recommendedOptionId: "additive",
      },
      {
        id: "question-rollout",
        prompt: "How broadly should the first rollout apply?",
        options: [
          {
            id: "focused",
            label: "Focused rollout",
            description: "Change only the requested notes surface.",
          },
          {
            id: "global",
            label: "Global rollout",
            description: "Migrate every notes surface in the repository.",
          },
        ],
        allowsNotes: true,
        recommendedOptionId: "focused",
      },
    ],
  });
  run.questionBatches = { [batch.id]: batch };
  run.questions = Object.fromEntries(
    batch.revisions[0]!.questions.map((question, index) => [
      question.id,
      {
        id: question.id,
        attemptId: batch.attemptId,
        prompt: question.prompt,
        options: structuredClone(question.options),
        allowsNotes: question.allowsNotes,
        askedAt: batch.createdAt,
        answeredAt: undefined,
        selectedOptionId: undefined,
        notes: undefined,
        batchId: batch.id,
        batchPosition: index + 1,
        batchSize: batch.revisions[0]!.questions.length,
        ...(question.recommendedOptionId === undefined
          ? {}
          : { recommendationOptionId: question.recommendedOptionId }),
      },
    ]),
  );
  return run;
}

function orchestrationRun(): RunRecord {
  const run = fixtureRun();
  run.executionConfig = {
    maxParallel: 2,
    questionPolicy: "some",
    instructions: "Keep work bounded.",
    agents: {},
  };
  return run;
}

function lineageRun(): RunRecord {
  const run = fixtureRun();
  const parent = run.attempts["attempt-worker"]!;
  parent.status = "completed";
  parent.endedAt = "2026-07-16T00:00:08.000Z";
  parent.lineage = { branchEpoch: 0, reason: "initial" };
  const child = structuredClone(parent);
  child.id = "attempt-worker-retry";
  child.sessionId = "session-worker-retry";
  child.status = "running";
  child.startedAt = "2026-07-16T00:00:09.000Z";
  child.endedAt = undefined;
  child.terminalSummary = undefined;
  child.lineage = {
    branchEpoch: 1,
    reason: "retry",
    parentAttemptId: parent.id,
    parentSessionId: parent.sessionId,
  };
  run.attempts[child.id] = child;
  run.tickets["ticket-one"]!.steps[0]!.attemptIds.push(child.id);
  return run;
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
