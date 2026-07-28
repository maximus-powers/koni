import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { JsonValue, RpcSuccess } from "../src/authority/protocol.js";
import { AuthorityClientError } from "../src/authority/client.js";
import { RunSummaryPageCollector } from "../src/authority/run-summary-page.js";
import type { CompiledConfiguration } from "../src/contracts/configuration.js";
import { rawSha256 } from "../src/shared/canonical.js";
import YAML from "yaml";
import { ControlCenterComponent } from "../src/control-center/component.js";
import {
  ControlCenterController,
  type ControlCenterAuthorityClient,
} from "../src/control-center/controller.js";
import { newRunLifecycle, reduceRunLifecycle } from "../src/state/run-lifecycle.js";
import type { RunRecord } from "../src/state/run-record.js";
import {
  defineBuiltInStageAction,
  defineStageCapabilityCatalog,
  defineStageInteraction,
} from "../src/state/stage-capability.js";
import { fixtureRunGit } from "./run-record-fixtures.js";
import {
  CockpitConfigurationError,
  cockpitView,
  parseCompiledCockpitViewCatalog,
  projectCompiledCockpitViewCatalog,
} from "../src/control-center/cockpit-config.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe("compiled cockpit presentation", () => {
  it.each([
    ["coding-profile", "Delivery Board", "Evidence-Guided Delivery Graph"],
    ["research-profile", "Tickets", "Project Graph"],
  ])(
    "projects every shipped %s view into a hash-bound, frozen catalog",
    (packageDirectory, ticketsTitle, graphTitle) => {
      const configuration = compiledProfile(packageDirectory);
      const catalog = projectCompiledCockpitViewCatalog(configuration);
      expect(catalog.configurationSha256).toBe(configuration.configuration_sha256);
      expect(catalog.catalogSha256).toMatch(/^sha256:[0-9a-f]{64}$/u);
      expect(cockpitView(catalog, ["tabbed_table", "kanban"])?.title).toBe(ticketsTitle);
      expect(cockpitView(catalog, ["typed_tree", "graph"])?.title).toBe(graphTitle);
      expect(Object.isFrozen(catalog)).toBe(true);
      expect(
        parseCompiledCockpitViewCatalog(
          structuredClone(catalog),
          configuration.configuration_sha256,
        ),
      ).toEqual(catalog);
    },
  );

  it("rejects a catalog from any configuration other than the one pinned by the run", () => {
    const coding = projectCompiledCockpitViewCatalog(compiledProfile("coding-profile"));
    const research = compiledProfile("research-profile");
    expect(() => parseCompiledCockpitViewCatalog(coding, research.configuration_sha256)).toThrow(
      /not bound to the selected run configuration/u,
    );
  });

  it("fails closed on fields and options for which the native cockpit has no consumer", () => {
    const configuration = structuredClone(compiledProfile("coding-profile"));
    const board = configuration.registries.views.board as Record<string, unknown>;
    board.unconsumed = true;
    expect(() => projectCompiledCockpitViewCatalog(configuration)).toThrowError(
      CockpitConfigurationError,
    );

    delete board.unconsumed;
    (board.options as Record<string, unknown>).unconsumed = true;
    expect(() => projectCompiledCockpitViewCatalog(configuration)).toThrow(
      /unknown field is not consumed/u,
    );
  });

  it("detects a self-consistent-looking DTO whose content changed after projection", () => {
    const configuration = compiledProfile("research-profile");
    const catalog = structuredClone(projectCompiledCockpitViewCatalog(configuration));
    (catalog.views[0] as { title: string }).title = "Forged title";
    expect(() =>
      parseCompiledCockpitViewCatalog(catalog, configuration.configuration_sha256),
    ).toThrow(/does not match its digest/u);
  });

  it("lets authored source, actions, columns, and options materially change authority-backed frames", async () => {
    const run = fixtureRun();
    const catalog = projectedCatalog(run.compiledConfigHash, {
      status: {
        id: "status",
        title: "Configured Activity",
        kind: "summary",
        source: { state: ["recent_events"] },
        columns: [],
        actions: [],
        options: { event_limit: 1 },
      },
      delivery: {
        id: "delivery",
        title: "Configured Tickets",
        kind: "tabbed_table",
        source: { tickets: "all" },
        columns: [{ id: "operation", value: "$row.operation" }],
        actions: ["authority-go", "legacy-start"],
        options: { tabs: ["active"], default_tab: "active" },
      },
      topology: {
        id: "topology",
        title: "Configured Graph",
        kind: "typed_tree",
        source: { graph: "main_checkout" },
        columns: [],
        actions: [],
        options: { hierarchy: ["objective", "claim"], show_titles: false },
      },
    });
    const controller = new ControlCenterController({
      projectRoot: "/project",
      client: new CockpitAuthority(run),
      cockpitCatalogResolver: { resolve: async () => catalog },
    });
    await controller.initialize();
    expect(controller.snapshot.notice).toBeUndefined();
    expect(controller.snapshot.cockpitIssue).toBeUndefined();
    expect(controller.snapshot.view.cockpit?.catalogSha256).toBe(catalog.catalogSha256);
    const component = new ControlCenterComponent({ controller, viewportRows: () => 40 });
    const frame = component.renderFrame(120, 40);
    const tickets = frameRegionText(frame, "tickets");
    const activity = frameRegionText(frame, "activity");
    const graph = frameRegionText(frame, "graph");
    expect(tickets).toContain("Configured Tickets");
    expect(tickets).toContain("Running");
    expect(tickets).not.toContain("◉");
    expect(controller.snapshot.ticketTab).toBe("active");
    expect(activity).toContain("Configured Activity");
    expect(activity).toContain("Newest configured event");
    expect(activity).not.toContain("Older event hidden by limit");
    expect(graph).toContain("Configured Graph · main checkout");
    expect(graph).not.toContain("Configured objective title");

    await controller.handle({ type: "focus_panel", panel: "tickets" });
    await controller.handle({ type: "open_actions" });
    // Configured slots without a compiled capability are hidden entirely: disabled placeholder
    // rows buried the real controls behind presentation debris.
    expect(controller.snapshot.modal).toMatchObject({
      kind: "action_palette",
      title: "Configured Tickets actions",
      actions: [{ id: "authority-go", availability: { state: "available" } }],
    });
    const modalFrame = component.renderFrame(120, 40).toPlainLines().join("\n");
    expect(modalFrame).toContain("Configured Tickets actions");
    expect(modalFrame).not.toContain("Legacy Start");
    component.dispose();
    controller.dispose();
  });
});

function compiledProfile(packageDirectory: string): CompiledConfiguration {
  const path =
    packageDirectory === "coding-profile"
      ? resolve(repositoryRoot, "packages", packageDirectory, "koni", "baseline", "cockpit.yaml")
      : resolve(
          repositoryRoot,
          "packages",
          packageDirectory,
          "koni",
          "baseline",
          "cockpit",
          "research.yaml",
        );
  const document = YAML.parse(readFileSync(path, "utf8")) as {
    views: Array<Record<string, unknown>>;
  };
  const views = Object.fromEntries(document.views.map((view) => [String(view.id), view]));
  return {
    configuration_sha256: rawSha256(packageDirectory),
    registries: { views },
  } as unknown as CompiledConfiguration;
}

function projectedCatalog(
  configurationSha256: RunRecord["compiledConfigHash"],
  views: Record<string, Record<string, unknown>>,
) {
  return projectCompiledCockpitViewCatalog({
    configuration_sha256: configurationSha256,
    registries: { views },
  } as unknown as CompiledConfiguration);
}

function frameRegionText(
  frame: ReturnType<ControlCenterComponent["renderFrame"]>,
  name: string,
): string {
  const region = frame.regions.find((candidate) => candidate.name === name);
  if (region === undefined) throw new Error(`missing frame region ${name}`);
  const lines: string[] = [];
  for (let y = region.rect.y; y < region.rect.y + region.rect.height; y += 1) {
    lines.push(
      frame.cells[y]!.slice(region.rect.x, region.rect.x + region.rect.width)
        .filter((cell) => !cell.continuation)
        .map((cell) => cell.glyph)
        .join(""),
    );
  }
  return lines.join("\n");
}

class CockpitAuthority implements ControlCenterAuthorityClient {
  public revision = 4;

  public constructor(private readonly run: RunRecord) {}

  public async request(method: string, params?: JsonValue): Promise<RpcSuccess> {
    let result: unknown;
    if (method === "run.page") {
      const request =
        typeof params === "object" && params !== null && !Array.isArray(params)
          ? (params as Record<string, JsonValue>)
          : {};
      const collector = new RunSummaryPageCollector({
        revision: this.revision,
        limit: typeof request.limit === "number" ? request.limit : 50,
        includeDeleted: request.includeDeleted === true,
        ...(request.aroundRunId === this.run.id
          ? {
              around: {
                id: this.run.id,
                createdAt: this.run.createdAt,
                runRevision: this.run.revision,
              },
            }
          : {}),
      });
      collector.accept(this.run);
      result = collector.finish();
    } else if (method === "run.get") result = structuredClone(this.run);
    else if (method === "run.graph") {
      result = {
        nodes: [
          { id: "objective-one", type: "objective", title: "Configured objective title", spec: {} },
          { id: "claim-one", type: "claim", title: "Configured claim title", spec: {} },
        ],
        edges: [{ source: "objective-one", relation: "supports", target: "claim-one" }],
      };
    } else if (method === "run.controls") {
      const action = defineBuiltInStageAction({
        id: "authority-go",
        intent: "drive_stage",
        available: true,
        reason: "The compiler authorized this exact capability.",
        title: "Authority go",
      });
      result = defineStageCapabilityCatalog({
        protocol: "koni.stage-capability-catalog.v1",
        binding: {
          runId: this.run.id,
          runRevision: this.run.revision,
          generation: this.run.generation,
          phase: this.run.lifecycle.phase,
        },
        stages: [
          {
            id: "orchestrate",
            title: "Orchestrate",
            kind: "orchestration",
            category: "execution",
            position: 0,
            status: "active",
            current: true,
            interaction: defineStageInteraction({
              mode: "operator",
              reason: action.availability.reason,
              actions: [action],
              primaryActionId: action.id,
            }),
            actions: [action],
          },
        ],
        runActions: [],
      });
    } else if (method === "run.lineage") {
      throw new AuthorityClientError("method_not_found", "lineage fixture omitted");
    } else throw new Error(`unexpected RPC ${method}`);
    return {
      type: "response",
      id: "cockpit-fixture",
      ok: true,
      revision: this.revision,
      result: result as never,
    };
  }
}

function fixtureRun(): RunRecord {
  let lifecycle = newRunLifecycle("run-cockpit");
  lifecycle = reduceRunLifecycle(lifecycle, { type: "planning_started", atMs: 1_000 }).state;
  lifecycle = reduceRunLifecycle(lifecycle, { type: "plan_submitted", atMs: 2_000 }).state;
  lifecycle = reduceRunLifecycle(lifecycle, { type: "plan_approval_requested", atMs: 2_500 }).state;
  lifecycle = reduceRunLifecycle(lifecycle, { type: "plan_approved", atMs: 3_000 }).state;
  const git = fixtureRunGit("/project", "run-cockpit", "approved");
  const namespaceRoot = "/project/.git/koni/worktrees/runs/run-cockpit";
  git.namespace.root = namespaceRoot;
  git.namespace.planningWorktree = `${namespaceRoot}/planning`;
  git.namespace.runWorktree = `${namespaceRoot}/integration`;
  git.namespace.ticketRoot = `${namespaceRoot}/tickets`;
  git.planning.worktree = git.namespace.planningWorktree;
  git.run.worktree = git.namespace.runWorktree;
  return {
    protocol: "koni.run-record.v1",
    id: "run-cockpit",
    revision: 4,
    generation: 0,
    projectRoot: "/project",
    profile: {
      packageName: "@koni/coding-profile",
      packageVersion: "1.0.0",
      lineage: "koni.software",
      bundleHash: rawSha256("bundle"),
    },
    compiledConfigHash: rawSha256("cockpit-config"),
    runTypeId: "medium",
    objective: "Exercise compiled cockpit presentation",
    intake: { goal: "Exercise compiled cockpit presentation" },
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:05.000Z",
    lifecycle,
    pipelineStageIds: ["orchestrate"],
    currentPipelineStageId: "orchestrate",
    plan: {
      revision: 1,
      status: "approved",
      full: {
        architecture: "Architecture",
        decisions: "Decisions",
        risk: "Risk",
        verification: "Verification",
      },
      concise: {},
      graphSeed: undefined,
      steeringHistory: [],
    },
    graphRevision: 1,
    graphHash: rawSha256("graph"),
    tickets: {
      delivery: {
        id: "delivery",
        operationId: "deliver",
        title: "Deliver configured view",
        summary: "Deliver configured view",
        status: "running",
        priority: 0,
        dependencyIds: [],
        targetNodeIds: [],
        readPaths: [],
        writePaths: [],
        steps: [
          {
            id: "work",
            title: "Work",
            personaId: "worker",
            status: "running",
            attemptIds: ["worker-attempt"],
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
      "worker-attempt": {
        id: "worker-attempt",
        sessionId: "worker-session",
        ticketId: "delivery",
        stepId: "work",
        personaId: "worker",
        modelProvider: "openai-codex",
        modelId: "gpt-5.6-terra",
        thinkingLevel: "high",
        status: "running",
        launchSpecHash: rawSha256("launch"),
        sessionFile: "/sessions/worker.jsonl",
        startedAt: "2026-07-16T00:00:03.000Z",
        endedAt: undefined,
        terminalSummary: undefined,
        inputTokens: 5,
        outputTokens: 3,
        cacheReadTokens: 20,
        cacheWriteTokens: 0,
      },
    },
    questions: {},
    activity: [
      {
        id: "old",
        at: "2026-07-16T00:00:03.000Z",
        kind: "compiler",
        message: "Older event hidden by limit",
        ticketId: undefined,
        nodeId: undefined,
      },
      {
        id: "new",
        at: "2026-07-16T00:00:04.000Z",
        kind: "compiler",
        message: "Newest configured event",
        ticketId: undefined,
        nodeId: undefined,
      },
    ],
    git,
  };
}
