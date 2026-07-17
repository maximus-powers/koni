import { randomUUID } from "node:crypto";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { JsonValue } from "../authority/protocol.js";
import { createPiControlCenterComponent, type ControlCenterComponent } from "../control-center/component.js";
import { ControlCenterController } from "../control-center/controller.js";
import { parseControlCatalog, type ControlModelOption } from "../control-center/protocol.js";
import {
  assertSealedModelAdmission,
  loadSealedPiModelCatalog,
} from "../pi/model-catalog.js";
import { ensureProjectAuthority } from "./authority-bootstrap.js";

export interface PiControlCenterHostOptions {
  context: ExtensionCommandContext;
  version: string;
}

export interface PiRunHostDependencies {
  ensure?: typeof ensureProjectAuthority;
  loadModels?: typeof projectPiModels;
}

/** Mount the exact same controller/component used by `koni tui` in Pi's current terminal. */
export async function openPiControlCenter(options: PiControlCenterHostOptions): Promise<void> {
  if (options.context.mode !== "tui") {
    options.context.ui.notify("Koni's control center is available in Pi TUI mode or through `koni tui`.", "warning");
    return;
  }
  const client = await ensureProjectAuthority({
    projectRoot: options.context.cwd,
    version: options.version,
    client: "pi-extension",
  });
  const models = await projectPiModels(options.context);
  let close: (() => void) | undefined;
  const controller = new ControlCenterController({
    projectRoot: options.context.cwd,
    client,
    models,
    closeClientOnDispose: true,
    onQuit: () => close?.(),
  });
  let component: ControlCenterComponent | undefined;
  try {
    await controller.initialize();
    await options.context.ui.custom<void>((tui, theme, _keybindings, done) => {
      close = () => done();
      component = createPiControlCenterComponent({ tui, theme, controller });
      component.focused = true;
      return component;
    });
  } finally {
    component?.dispose();
    controller.dispose();
  }
}

/**
 * Project the same Pi-native inventory as standalone, retaining ambient-only entries as disabled
 * explanations instead of pretending the contained attempt can execute their provider code.
 */
export function projectPiModels(
  context: Pick<ExtensionCommandContext, "modelRegistry">,
  options: Omit<Parameters<typeof loadSealedPiModelCatalog>[0], "ambientRegistry"> = {},
): Promise<ControlModelOption[]> {
  return loadSealedPiModelCatalog({ ...options, ambientRegistry: context.modelRegistry });
}

/** Pi-native guided run intake. The resulting mutation still crosses authority CAS/idempotency. */
export async function createRunFromPi(options: PiControlCenterHostOptions & {
  requestedRunType?: string;
}, dependencies: PiRunHostDependencies = {}): Promise<{ runId: string } | undefined> {
  if (!options.context.hasUI) {
    options.context.ui.notify("Run intake requires an interactive Pi UI.", "warning");
    return undefined;
  }
  const client = await (dependencies.ensure ?? ensureProjectAuthority)({
    projectRoot: options.context.cwd,
    version: options.version,
    client: "pi-extension",
  });
  try {
    const objective = await options.context.ui.editor("Goal Prompt");
    if (objective === undefined || objective.trim().length === 0) return undefined;
    const catalogResponse = await client.request("control.catalog");
    const catalog = parseControlCatalog(catalogResponse.result);
    const runTypes = catalog.runTypes.map((runType) => runType.id);
    const selectedRunType = options.requestedRunType !== undefined && runTypes.includes(options.requestedRunType)
      ? options.requestedRunType
      : await options.context.ui.select("Run type", runTypes);
    if (selectedRunType === undefined) return undefined;
    const runType = catalog.runTypes.find((candidate) => candidate.id === selectedRunType)!;
    const models = await (dependencies.loadModels ?? projectPiModels)(options.context);
    assertSealedModelAdmission(runType.roles, models);

    const branchesResponse = await client.request("branches.list", { limit: 30 });
    const branches = parseBranches(branchesResponse.result);
    if (branches.length === 0) throw new Error("repository has no local target branches");
    const selectedBranch = await options.context.ui.select("Target branch", branches.map((branch) => branch.label));
    if (selectedBranch === undefined) return undefined;
    const target = branches.find((branch) => branch.label === selectedBranch)!;
    const response = await client.request(
      "run.create",
      {
        objective: objective.trim(),
        runTypeId: selectedRunType,
        targetRef: target.reference,
        intake: { goal: objective.trim() },
      },
      {
        expectedRevision: client.revision,
        idempotencyKey: `pi-run-create:${randomUUID()}`,
      },
    );
    if (!isRecord(response.result) || typeof response.result.runId !== "string") {
      throw new Error("authority returned an invalid run creation response");
    }
    options.context.ui.notify(`Started ${selectedRunType} run`, "info");
    return { runId: response.result.runId };
  } finally {
    client.close();
  }
}

function parseBranches(value: JsonValue | undefined): Array<{ label: string; reference: string }> {
  if (!Array.isArray(value)) throw new Error("authority returned an invalid branch list");
  return value.map((item) => {
    if (!isRecord(item)) throw new Error("authority returned an invalid branch entry");
    const reference = typeof item.ref === "string"
      ? item.ref
      : typeof item.name === "string" ? item.name : undefined;
    if (reference === undefined) throw new Error("authority branch entry has no reference");
    const label = reference.replace(/^refs\/heads\//u, "");
    return { label, reference: reference.startsWith("refs/heads/") ? reference : `refs/heads/${reference}` };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
