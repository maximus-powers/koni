import { describe, expect, it } from "vitest";
import { visibleWidth, type Terminal } from "@earendil-works/pi-tui";
import type { JsonValue, RpcEvent, RpcSuccess } from "../src/authority/protocol.js";
import { ControlCenterComponent, renderGraphLines } from "../src/control-center/component.js";
import {
  ControlCenterController,
  type ControlCenterAuthorityClient,
} from "../src/control-center/controller.js";
import { decodeControlCenterInput } from "../src/control-center/input.js";
import { plainKoniPalette } from "../src/control-center/markdown.js";
import { createStandaloneControlCenter } from "../src/control-center/standalone.js";
import { projectPiTranscript } from "../src/control-center/transcript.js";
import type { ControlModelOption } from "../src/control-center/protocol.js";
import { newRunLifecycle, reduceRunLifecycle } from "../src/state/run-lifecycle.js";
import type { RunRecord } from "../src/state/run-record.js";

describe("control center controller", () => {
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
    expect(controller.snapshot.selection.ticketId).toBe("ticket-one");
    expect(client.calls.at(-1)).toMatchObject({
      method: "run.graph",
      params: { runId: "run-one", ticketId: "ticket-one" },
    });

    await controller.handle({ type: "toggle_pause" });
    const pause = client.calls.find((call) => call.method === "run.pause");
    expect(pause).toMatchObject({ params: { runId: "run-one" }, expectedRevision: 7 });
    expect(pause?.idempotencyKey).toMatch(/^run\.pause:/u);

    await controller.handle({ type: "request_delete" });
    expect(controller.snapshot.modal).toMatchObject({ kind: "delete", runId: "run-one" });
    expect(client.calls.some((call) => call.method === "run.delete")).toBe(false);
    await controller.handle({ type: "activate" });
    expect(client.calls.find((call) => call.method === "run.delete")?.idempotencyKey).toMatch(/^run\.delete:/u);

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

    const answer = client.calls.find((call) => call.method === "question.answer");
    expect(answer?.params).toEqual({
      runId: "run-one",
      questionId: "question-one",
      notes: "Keep the legacy behavior",
    });
    expect(controller.snapshot.view.selectedRun?.questions).toBeUndefined();
    expect(controller.snapshot.focus).toBe("details");
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
    const component = new ControlCenterComponent({ controller, palette: plainKoniPalette, viewportRows: () => 48 });
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
    await controller.handle({ type: "submit" });
    expect(controller.snapshot.modal).toMatchObject({ kind: "new_run", focus: "objective" });
    expect(client.calls.some((call) => call.method === "run.create")).toBe(false);
    for (let index = 0; index < 20 && controller.snapshot.modal?.kind === "new_run" && controller.snapshot.modal.focus !== "start"; index += 1) {
      await controller.handle({ type: "focus", delta: 1 });
    }
    expect(controller.snapshot.modal).toMatchObject({ kind: "new_run", focus: "start" });
    const pending = controller.handle({ type: "submit" });
    await Promise.resolve();
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
      runTypeId: "small",
      targetRef: "refs/heads/main",
      overrides: {
        questionPolicy: "none",
        maxParallel: 1,
        roles: {
          planner: { model: "gpt-small", thinkingLevel: "high" },
          lead: { model: "gpt-small", thinkingLevel: "high" },
          ticket_worker: { model: "gpt-worker", thinkingLevel: "medium" },
          reviewer: { model: "gpt-review", thinkingLevel: "max" },
        },
      },
    });
    release();
    await pending;
    expect(controller.snapshot.view.runs[0]?.provisional).toBe(false);
    component.dispose();
    controller.dispose();
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
    expect(controller.snapshot.modal).toMatchObject({ kind: "new_run", focus: "role:planner:model" });

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

  it("explains and refuses a configured model that the contained Pi runtime cannot execute", async () => {
    const models = fixtureModels();
    models[0]!.available = false;
    models[0]!.unavailableReason = "This provider comes from an ambient Pi extension.";
    const client = new FakeAuthority([]);
    const controller = new ControlCenterController({ projectRoot: "/project", client, models });
    await controller.initialize();
    await controller.handle({ type: "open_new_run" });
    await controller.handle({ type: "append_text", text: "Build the notes route" });
    for (let index = 0; index < 14; index += 1) await controller.handle({ type: "focus", delta: 1 });

    const component = new ControlCenterComponent({
      controller,
      palette: plainKoniPalette,
      viewportRows: () => 40,
    });
    expect(component.render(120).join("\n")).toContain("ambient Pi extension");
    await controller.handle({ type: "activate" });
    expect(controller.snapshot.notice).toEqual(expect.objectContaining({
      kind: "error",
      message: expect.stringContaining("Planner: openai-codex/gpt-small is unavailable"),
    }));
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
    for (let index = 0; index < 14; index += 1) await controller.handle({ type: "focus", delta: 1 });

    const component = new ControlCenterComponent({
      controller,
      palette: plainKoniPalette,
      viewportRows: () => 40,
    });
    expect(component.render(120).join("\n")).toContain("does not support high reasoning");
    await controller.handle({ type: "activate" });
    expect(controller.snapshot.notice).toEqual(expect.objectContaining({
      kind: "error",
      message: expect.stringContaining("does not support high reasoning"),
    }));
    expect(client.calls.some((call) => call.method === "run.create")).toBe(false);
    component.dispose();
    controller.dispose();
  });

  it("reviews agent-authored mini plans with one adaptive Approve or Revise action", async () => {
    const client = new FakeAuthority([awaitingApprovalRun()]);
    const controller = new ControlCenterController({ projectRoot: "/project", client });
    await controller.initialize();
    expect(controller.snapshot.modal?.kind).toBe("plan_review");
    const component = new ControlCenterComponent({ controller, palette: plainKoniPalette, viewportRows: () => 42 });
    const initial = component.render(120).join("\n");
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
    await controller.handle({ type: "append_text", text: "Keep the legacy field readable while migrating." });
    await controller.handle({ type: "focus", delta: 1 });
    const revised = component.render(120).join("\n");
    expect(revised).toContain("Revise plan");
    expect(revised).not.toContain("Approve run");
    await controller.handle({ type: "activate" });
    expect(client.calls.find((call) => call.method === "plan.revise")?.params).toEqual({
      runId: "run-one",
      instructions: "Keep the legacy field readable while migrating.",
    });
    expect(client.calls.some((call) => call.method === "plan.approve")).toBe(false);
    component.dispose();
    controller.dispose();
  });

  it("submits multiline plan steering and returns review to visible planning without approval", async () => {
    const client = new FakeAuthority([awaitingApprovalRun()]);
    const controller = new ControlCenterController({ projectRoot: "/project", client });
    await controller.initialize();
    const component = new ControlCenterComponent({ controller, palette: plainKoniPalette, viewportRows: () => 30 });

    await controller.handle({ type: "focus", delta: 1 });
    await controller.handle({ type: "append_text", text: "Keep API compatibility." });
    await controller.handle({ type: "activate" });
    await controller.handle({ type: "append_text", text: "Add a rollback check that covers both storage shapes." });
    const editor = component.render(76).join("\n");
    expect(editor).toContain("Keep API compatibility.");
    expect(editor).toContain("Add a rollback check");
    expect(controller.snapshot.modal).toMatchObject({
      kind: "plan_review",
      steering: "Keep API compatibility.\nAdd a rollback check that covers both storage shapes.",
    });

    await controller.handle({ type: "focus", delta: 1 });
    await controller.handle({ type: "activate" });
    expect(client.calls.find((call) => call.method === "plan.revise")?.params).toEqual({
      runId: "run-one",
      instructions: "Keep API compatibility.\nAdd a rollback check that covers both storage shapes.",
    });
    expect(client.calls.some((call) => call.method === "plan.approve")).toBe(false);
    expect(controller.snapshot.modal).toBeUndefined();
    expect(controller.snapshot.view.selectedRun?.plan.mode).toBe("activity");
    await controller.handle({ type: "focus_panel", panel: "details" });
    await controller.handle({ type: "details_tab", delta: 1 });
    expect(component.render(120).join("\n")).toContain("Planning activity");
    component.dispose();
    controller.dispose();
  });

  it("keeps active and historical agents with concise ticket-aware work titles", async () => {
    const run = fixtureRun();
    run.tickets["ticket-one"]!.steps[0]!.title = "Execute compiled work";
    run.attempts["attempt-lead"]!.terminalSummary = undefined;
    run.attempts["attempt-lead"]!.kind = "planning";
    run.attempts["attempt-worker"]!.kind = "ticket";
    const controller = new ControlCenterController({ projectRoot: "/project", client: new FakeAuthority([run]) });
    await controller.initialize();

    const unfiltered = controller.snapshot.view.selectedRun!.agents;
    expect(unfiltered.map((agent) => agent.label)).toEqual([
      "Implement feature · Implementer",
      "Lead",
    ]);
    expect(unfiltered.map((agent) => agent.work)).toEqual(["Coordinating tickets", "Planned run"]);
    expect(unfiltered.some((agent) => agent.work === "Execute compiled work")).toBe(false);
    expect(unfiltered.find((agent) => agent.label === "Lead")).toMatchObject({ active: false, status: "completed" });

    await controller.handle({ type: "focus_panel", panel: "tickets" });
    await controller.handle({ type: "move", delta: 1 });
    expect(controller.snapshot.view.selectedRun!.agents.map((agent) => agent.label)).toEqual(["Implementer"]);
    controller.dispose();
  });

  it("edits semantic configuration as an in-memory draft and publishes it with hidden CAS", async () => {
    const client = new FakeAuthority([]);
    const controller = new ControlCenterController({ projectRoot: "/project", client, models: fixtureModels() });
    await controller.initialize();
    await controller.handle({ type: "open_config" });
    const component = new ControlCenterComponent({ controller, palette: plainKoniPalette, viewportRows: () => 44 });
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
    await controller.handle({ type: "append_text", text: " Studio" });
    await controller.handle({ type: "save_draft" });
    expect(controller.snapshot.notice?.message).toContain("Draft saved");
    expect(component.render(82).join("\n")).toContain("Notes Studio");
    await controller.handle({ type: "publish" });
    const update = client.calls.find((call) => call.method === "config.update");
    expect(update?.params).toMatchObject({
      cas: { effective: "baseline-1" },
      values: { "project.name": "Notes Studio" },
    });
    expect(update?.expectedRevision).toBeDefined();
    component.dispose();
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

  it("creates, duplicates, and deletes whole semantic resources through opaque authority actions", async () => {
    const client = new FakeAuthority([]);
    const controller = new ControlCenterController({ projectRoot: "/project", client });
    await controller.initialize();
    await controller.handle({ type: "open_config" });
    const component = new ControlCenterComponent({ controller, palette: plainKoniPalette, viewportRows: () => 40 });
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
    expect(client.calls.find((call) => call.method === "config.resource.duplicate")?.params).toEqual({
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
    const controller = new ControlCenterController({ projectRoot: "/project", client: new FakeAuthority([]) });
    await controller.initialize();
    await controller.handle({ type: "open_config" });
    for (let index = 0; index < 7; index += 1) await controller.handle({ type: "details_tab", delta: 1 });
    const component = new ControlCenterComponent({ controller, palette: plainKoniPalette, viewportRows: () => 28 });
    const compact = component.render(82).join("\n");
    expect(compact).toContain("Advanced settings");
    expect(compact).toContain("Advanced");
    expect(compact.split("\n").every((line) => visibleWidth(line) === 82)).toBe(true);
    component.dispose();
    controller.dispose();
  });

  it("renders the complete native Pi transcript and sends composer text through agent authority", async () => {
    const client = new FakeAuthority([fixtureRun()]);
    const controller = new ControlCenterController({ projectRoot: "/project", client });
    await controller.initialize();
    await controller.handle({ type: "focus_panel", panel: "agents" });
    await controller.handle({ type: "move", delta: 1 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await controller.handle({ type: "activate" });
    const component = new ControlCenterComponent({ controller, palette: plainKoniPalette, viewportRows: () => 48 });
    const transcript = component.render(88).join("\n");
    expect(transcript).toContain("I inspected the existing notes route.");
    expect(transcript).toContain("Reasoning");
    expect(transcript).toContain("Need to preserve the storage seam.");
    expect(transcript).toContain("Read File");
    expect(transcript).toContain("Loaded the existing component.");
    expect(transcript).toContain("Alternative branch summary.");
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
});

describe("control center component", () => {
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
    const lines = component.render(150);
    const text = lines.join("\n");

    expect(lines).toHaveLength(48);
    expect(lines.every((line) => visibleWidth(line) === 150)).toBe(true);
    const columnTop = lines.find((line) => line.includes("Runs") && line.includes("Details:") && line.includes("Agents"));
    expect(columnTop).toBeDefined();
    expect(columnTop!.slice(0, 50)).toContain("Runs");
    expect(columnTop!.slice(50, 100)).toContain("Details: Overview - Plan - Stages");
    expect(columnTop!.slice(100, 150)).toContain("Agents");
    expect(text).toContain("Objective");
    expect(text).toContain("Goal");
    expect(text).toContain("Run");
    expect(text).toContain("Evidence");
    expect(text).toContain("Recent Activity · 17s active");
    expect(text).toContain("Lead");
    expect(text).toContain("Architecture boundary mapped");
    expect(text).toContain("Claim result");
    expect(text).not.toContain("claim-one");
    expect(text).toContain("Graph · Run integration");

    await controller.handle({ type: "focus_panel", panel: "questions" });
    const questionText = component.render(84).join("\n");
    expect(questionText).toContain("How should existing notes transition to the new form?");
    expect(questionText).toContain("Preserve existing content and expose it in the first field.");
    expect(questionText).toContain("None of these");
    expect(questionText).toContain("[n/Tab] notes");

    await controller.handle({ type: "focus_panel", panel: "details" });
    await controller.handle({ type: "details_tab", delta: 1 });
    const plan = component.render(84).join("\n");
    expect(plan).toContain("Architecture");
    expect(plan).toContain("Use the existing seam.");

    await controller.handle({ type: "focus_panel", panel: "tickets" });
    await controller.handle({ type: "move", delta: 1 });
    expect(component.render(120).join("\n")).toContain("Graph · Ticket checkout");

    component.dispose();
    controller.dispose();
  });

  it("draws relationship lines first and overlays concise node markers and titles", () => {
    const lines = renderGraphLines(
      [
        { id: "claim", type: "claim", marker: "C", label: "Claim result", muted: false },
        { id: "experiment", type: "experiment", marker: "E", label: "Test claim", muted: false },
        { id: "gate", type: "gate", marker: "G", label: "Verify output", muted: true },
      ],
      [
        { source: "claim", target: "experiment" },
        { source: "experiment", target: "gate" },
      ],
      42,
      plainKoniPalette,
    );
    expect(lines.join("\n")).toContain("C Claim result");
    expect(lines.join("\n")).toContain("E Test claim");
    expect(lines.join("\n")).toContain("G Verify output");
    expect(lines.join("\n")).toMatch(/[─│┼]/u);
  });

  it("keeps a software-sized graph scannable inside one equal-width dashboard column", () => {
    const nodes = Array.from({ length: 15 }, (_, index) => ({
      id: `internal-node-${index}`,
      type: index % 3 === 0 ? "gate" : index % 2 === 0 ? "change" : "claim",
      marker: index % 3 === 0 ? "G" : index % 2 === 0 ? "C" : "A",
      label: `Boundary ${index + 1}`,
      muted: index % 4 === 0,
    }));
    const edges = nodes.slice(1).map((node, index) => ({ source: nodes[index]!.id, target: node.id }));
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
    const controller = new ControlCenterController({ projectRoot: "/project", client, models: fixtureModels() });
    await controller.initialize();
    await controller.handle({ type: "open_new_run" });
    const component = new ControlCenterComponent({ controller, palette: plainKoniPalette, viewportRows: () => 20 });
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
    const controller = new ControlCenterController({ projectRoot: "/project", client: new FakeAuthority([run]) });
    await controller.initialize();
    await controller.handle({ type: "focus_panel", panel: "details" });
    const component = new ControlCenterComponent({ controller, palette: plainKoniPalette, viewportRows: () => 32 });
    expect(component.render(150).join("\n")).toContain("MIDPOINT-SENTINEL");
    component.dispose();
    controller.dispose();
  });

  it("keeps the Notes editor visible for long question options", async () => {
    const run = fixtureRun();
    run.questions["question-one"]!.options[0]!.description = "Long option context ".repeat(80);
    const controller = new ControlCenterController({ projectRoot: "/project", client: new FakeAuthority([run]) });
    await controller.initialize();
    await controller.handle({ type: "focus_panel", panel: "questions" });
    await controller.handle({ type: "toggle_notes" });
    await controller.handle({ type: "append_text", text: "Visible operator note" });
    const component = new ControlCenterComponent({ controller, palette: plainKoniPalette, viewportRows: () => 24 });
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
    await new Promise<void>((resolve) => setImmediate(resolve));
    const component = new ControlCenterComponent({ controller, palette: plainKoniPalette, viewportRows: () => 44 });
    expect(component.render(100).join("\n")).toContain("I inspected the existing notes");
    client.setTranscriptAssistantText("I applied the live transcript update.");
    client.emit("agent.usage");
    await new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));
    expect(component.render(100).join("\n")).toContain("I applied the live transcript");
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
    const component = new ControlCenterComponent({ controller, palette: plainKoniPalette, viewportRows: () => 40 });
    expect(component.render(100).join("\n")).toContain("Historical session · read-only");
    await controller.handle({ type: "toggle_chat_composer" });
    expect(controller.snapshot.chat?.draft.editing).toBe(false);
    await controller.handle({ type: "help" });
    expect(controller.snapshot.modal).toEqual({ kind: "help", topic: "chat" });
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
    const component = new ControlCenterComponent({ controller, palette: plainKoniPalette, viewportRows: () => 14 });
    const resource = component.render(82).join("\n");
    expect(resource).toContain("Create resource");
    expect(resource).toContain("Esc cancel");
    expect(resource.split("\n").every((line) => visibleWidth(line) === 82)).toBe(true);
    component.dispose();
    controller.dispose();
  });
});

describe("control center input and standalone host", () => {
  it("keeps complete Pi tool arguments and results instead of transport-event summaries", () => {
    const argument = `ARGUMENT-START-${"a".repeat(500)}-ARGUMENT-END`;
    const result = `RESULT-START-${"b".repeat(3_000)}-RESULT-END`;
    const projection = projectPiTranscript({
      entries: [
        {
          type: "message",
          id: "assistant",
          parentId: null,
          message: { role: "assistant", content: [{ type: "toolCall", name: "koni_check", arguments: { command: argument } }] },
        },
        {
          type: "message",
          id: "result",
          parentId: "assistant",
          message: { role: "toolResult", toolName: "koni_check", content: [], details: { output: result } },
        },
      ],
      diagnostics: [],
    });
    const text = projection.blocks.map((block) => block.markdown).join("\n");
    expect(text).toContain("ARGUMENT-END");
    expect(text).toContain("RESULT-END");
    expect(text).not.toContain("Pi event");
  });

  it("reserves h for panel help but accepts it as notes text while editing", () => {
    expect(decodeControlCenterInput("h", { panel: "details", editingNotes: false, modalOpen: false })).toEqual({ type: "help" });
    expect(decodeControlCenterInput("h", { panel: "questions", editingNotes: true, modalOpen: false })).toEqual({ type: "append_text", text: "h" });
    expect(decodeControlCenterInput("n", { panel: "questions", editingNotes: false, modalOpen: false })).toEqual({ type: "toggle_notes" });
    expect(decodeControlCenterInput("n", { panel: "runs", editingNotes: false, modalOpen: false })).toEqual({ type: "open_new_run" });
    expect(decodeControlCenterInput("\u001b[B", { panel: "runs", editingNotes: false, modalOpen: false })).toEqual({ type: "move", delta: 1 });
    expect(decodeControlCenterInput("a", { panel: "runs", editingNotes: false, modalOpen: true, modalKind: "configure" })).toEqual({ type: "config_resource_create" });
    expect(decodeControlCenterInput("d", { panel: "runs", editingNotes: false, modalOpen: true, modalKind: "configure" })).toEqual({ type: "config_resource_duplicate" });
    expect(decodeControlCenterInput("x", { panel: "runs", editingNotes: false, modalOpen: true, modalKind: "configure" })).toEqual({ type: "config_resource_delete" });
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

class FakeAuthority implements ControlCenterAuthorityClient {
  public revision = 7;
  public readonly calls: RecordedCall[] = [];
  readonly #runs: RunRecord[];
  readonly #listeners = new Set<(event: RpcEvent) => void>();
  #runCreateGate: Promise<void> | undefined;
  #releaseRunCreate: (() => void) | undefined;
  #configValues: Record<string, JsonValue> = { "project.name": "Notes" };
  #configCas = "baseline-1";
  #transcriptAssistantText = "I inspected the existing notes route.";

  public constructor(runs: RunRecord[]) {
    this.#runs = structuredClone(runs);
  }

  public onEvent(listener: (event: RpcEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public deferRunCreate(): () => void {
    this.#runCreateGate = new Promise<void>((resolve) => { this.#releaseRunCreate = resolve; });
    return () => this.#releaseRunCreate?.();
  }

  public simulateExternalConfiguration(values: Record<string, JsonValue>, cas: string): void {
    this.#configValues = structuredClone(values);
    this.#configCas = cas;
  }

  public setTranscriptAssistantText(value: string): void {
    this.#transcriptAssistantText = value;
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
    let result: JsonValue | undefined;
    if (method === "run.list") result = structuredClone(this.#runs) as unknown as JsonValue;
    else if (method === "run.graph") result = fixtureGraph() as unknown as JsonValue;
    else if (method === "control.catalog") result = fixtureControlCatalog() as unknown as JsonValue;
    else if (method === "branches.list") result = [{ ref: "refs/heads/main", name: "main", oid: "a".repeat(40) }];
    else if (method === "config.catalog") result = fixtureConfigCatalog() as unknown as JsonValue;
    else if (method === "config.get") result = {
      protocol: "koni.config-snapshot.v1",
      cas: { effective: this.#configCas },
      values: structuredClone(this.#configValues),
    };
    else if (method === "run.transcript") result = fixtureTranscript(this.#transcriptAssistantText) as unknown as JsonValue;
    else if (method === "run.create") {
      await this.#runCreateGate;
      this.revision += 1;
      const run = fixtureRun();
      run.id = "run-created";
      run.lifecycle.runId = run.id;
      run.git.runId = run.id;
      run.git.namespace.runRef = `refs/heads/koni/runs/${run.id}`;
      run.git.run.branchRef = run.git.namespace.runRef;
      if (isRecord(params) && typeof params.objective === "string") run.objective = params.objective;
      if (isRecord(params) && typeof params.runTypeId === "string") run.runTypeId = params.runTypeId;
      this.#runs.push(run);
      result = { runId: run.id, status: "starting" };
    }
    else if (new Set([
      "question.answer",
      "config.update",
      "config.resource.create",
      "config.resource.duplicate",
      "config.resource.delete",
      "plan.revise",
      "plan.approve",
      "run.pause",
      "run.resume",
      "run.delete",
      "run.merge",
      "agent.steer",
      "agent.follow_up",
    ]).has(method)) {
      this.revision += 1;
      if (method === "question.answer" && isRecord(params)) {
        const run = this.#runs.find((candidate) => candidate.id === params.runId);
        const question = run?.questions[String(params.questionId)];
        if (question !== undefined) question.answeredAt = "2026-07-16T00:00:20.000Z";
      }
      if (method === "config.update" && isRecord(params) && isRecord(params.values)) {
        this.#configValues = structuredClone(params.values);
      }
      if (method === "plan.revise") {
        const run = this.#runs.find((candidate) => candidate.id === (isRecord(params) ? params.runId : undefined));
        if (run?.plan !== undefined) {
          run.plan.status = "planning";
          run.lifecycle.phase = "planning";
        }
      }
      if (method === "plan.approve") {
        const run = this.#runs.find((candidate) => candidate.id === (isRecord(params) ? params.runId : undefined));
        if (run?.plan !== undefined) {
          run.plan.status = "approved";
          run.lifecycle.phase = "approving";
        }
      }
      result = { accepted: true };
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
  public get columns(): number { return 120; }
  public get rows(): number { return 40; }
  public get kittyProtocolActive(): boolean { return false; }
  public start(): void { this.starts += 1; }
  public stop(): void { this.stops += 1; }
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
    objective: "Build a carefully scoped feature using the existing architecture and verify the observable behavior without changing unrelated systems.",
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
        steps: [{
          id: "implement",
          title: "Implement feature",
          personaId: "implementer",
          status: "running",
          attemptIds: ["attempt-worker"],
          summary: undefined,
          startedAt: "2026-07-16T00:00:03.000Z",
          completedAt: undefined,
        }],
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
          { id: "preserve", label: "Preserve notes", description: "Preserve existing content and expose it in the first field." },
          { id: "replace", label: "Replace notes", description: "Start with an empty structured form." },
        ],
        allowsNotes: true,
        askedAt: "2026-07-16T00:00:03.000Z",
        answeredAt: undefined,
        selectedOptionId: undefined,
        notes: undefined,
      },
    },
    activity: [{
      id: "event-one",
      at: "2026-07-16T00:00:01.000Z",
      kind: "graph_added",
      message: "Architecture boundary mapped",
      ticketId: "ticket-one",
      nodeId: "claim-one",
    }],
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
      planning: { status: "retired", baseOid: "a".repeat(40), worktree: "/planning", createdAt: undefined, retiredAt: undefined, blocker: undefined },
      run: { status: "ready", branchRef: "refs/heads/koni/runs/run-one", worktree: "/worktree", headOid: "a".repeat(40), materializedAt: "2026-07-16T00:00:03.000Z", retiredAt: undefined, blocker: undefined },
      ticketCycles: {},
      ticketCycleOrder: [],
      promotion: undefined,
    },
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
        spec: {},
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
    { provider: "openai-codex", id: "gpt-small", name: "GPT Small", reasoning: true, thinkingLevels: ["off", "minimal", "low", "medium", "high"], available: true },
    { provider: "openai-codex", id: "gpt-worker", name: "GPT Worker", reasoning: true, thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh"], available: true },
    { provider: "openai-codex", id: "gpt-review", name: "GPT Review", reasoning: true, thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], available: true },
    { provider: "community", id: "custom-one", name: "Community Custom", reasoning: true, thinkingLevels: ["off", "high"], available: true },
  ];
}

function fixtureControlCatalog() {
  const stages = [
    { id: "intake", title: "Validate intake", kind: "action", included: true },
    { id: "plan", title: "Plan architecture and implementation", kind: "planning", included: true },
    { id: "risk", title: "Plan risk controls", kind: "planning", included: false },
    { id: "orchestrate", title: "Execute compiled work", kind: "orchestration", included: true },
    { id: "review", title: "Independent review", kind: "agent_review", included: false },
    { id: "promotion", title: "Merge the completed run", kind: "promotion", included: true },
  ];
  const roles = [
    { id: "planner", title: "Planner", provider: "openai-codex", model: "gpt-small", thinkingLevel: "high" },
    { id: "lead", title: "Lead", provider: "openai-codex", model: "gpt-small", thinkingLevel: "high" },
    { id: "ticket_worker", title: "Worker", provider: "openai-codex", model: "gpt-worker", thinkingLevel: "medium" },
    { id: "reviewer", title: "Reviewer", provider: "openai-codex", model: "gpt-review", thinkingLevel: "max" },
  ];
  return {
    protocol: "koni.control-catalog.v1",
    runTypes: [
      { id: "small", title: "Small", description: "small", questionPolicy: "none", maxParallel: 1, startMode: "planning", stages, roles },
      { id: "medium", title: "Medium", description: "medium", questionPolicy: "some", maxParallel: 3, startMode: "planning", stages: stages.map((stage) => ({ ...stage, included: true })), roles },
      { id: "large", title: "Large", description: "large", questionPolicy: "many", maxParallel: 5, startMode: "planning", stages: stages.map((stage) => ({ ...stage, included: true })), roles },
    ],
  };
}

function fixtureConfigCatalog() {
  const section = (id: string, title: string, resourceTitle: string) => ({
    id,
    title,
    description: `Configure ${title.toLowerCase()}.`,
    createOptions: id === "project" ? [{
      id: "template-project",
      title: "Project preset",
      description: "Add another semantic project preset with inherited defaults and a fully validated configuration boundary. ".repeat(12),
      nameLabel: "Preset name",
      suggestedName: "New project preset",
    }] : [],
    resources: [{
      id: `${id}-resource`,
      title: resourceTitle,
      description: `Guided settings for ${resourceTitle.toLowerCase()}.`,
      canDuplicate: id === "project",
      canDelete: id === "project",
      fields: id === "project" ? [{
        key: "project.name",
        label: "Display name",
        description: "The human-readable project name shown to operators.",
        kind: "text",
      }] : [],
    }],
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

function fixtureTranscript(assistantText = "I inspected the existing notes route.") {
  const at = Date.parse("2026-07-16T00:00:03.000Z");
  return {
    header: { type: "session", version: 3, id: "session-worker" },
    entries: [
      { type: "message", id: "user-one", parentId: null, message: { role: "user", content: "Inspect the notes flow.", timestamp: at } },
      {
        type: "message",
        id: "assistant-one",
        parentId: "user-one",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Need to preserve the storage seam." },
            { type: "text", text: assistantText },
            { type: "toolCall", id: "read-one", name: "koni_read_file", arguments: { path: "app/notes.tsx" } },
          ],
          timestamp: at + 1,
        },
      },
      {
        type: "message",
        id: "result-one",
        parentId: "assistant-one",
        message: {
          role: "toolResult",
          toolCallId: "read-one",
          toolName: "koni_read_file",
          content: [{ type: "text", text: "Loaded the existing component." }],
          isError: false,
          timestamp: at + 2,
        },
      },
      {
        type: "message",
        id: "assistant-branch",
        parentId: "user-one",
        message: { role: "assistant", content: [{ type: "text", text: "Alternative branch summary." }], timestamp: at + 3 },
      },
    ],
    diagnostics: [],
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
      architecture: [{ title: "Existing seam", description: "Reuse the stable boundary without a parallel abstraction." }],
      decisions: [{ title: "Preserve contract", description: "Keep existing notes readable during migration." }],
      risk: [{ title: "Low migration risk", description: "Use additive parsing and a focused regression proof." }],
      verification: [{ title: "Prove both paths", description: "Exercise existing and newly structured notes." }],
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

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
