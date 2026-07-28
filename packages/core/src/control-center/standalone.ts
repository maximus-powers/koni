import { ProcessTerminal, TUI, type Terminal } from "@earendil-works/pi-tui";
import { AuthorityClient } from "../authority/client.js";
import { loadSealedPiModelCatalog } from "../pi/model-catalog.js";
import { ControlCenterComponent } from "./component.js";
import { ControlCenterController, type ControlCenterAuthorityClient } from "./controller.js";
import type { ControlCenterCockpitCatalogResolver } from "./cockpit-config.js";
import { createAuthorityCockpitCatalogResolver } from "./authority-cockpit-resolver.js";
import { ResilientControlCenterClient } from "./resilient-client.js";
import type { ControlModelOption } from "./protocol.js";
import { ansiKoniPalette, type KoniPalette } from "./markdown.js";

export interface StandaloneControlCenterOptions {
  projectRoot: string;
  version: string;
  client?: ControlCenterAuthorityClient;
  /** Reopen the same repository authority after an idle or process transport loss. */
  reconnectClient?: () => Promise<ControlCenterAuthorityClient>;
  terminal?: Terminal;
  palette?: KoniPalette;
  /** Tests and embedding hosts may inject a frozen read-only Pi model projection. */
  models?: readonly ControlModelOption[];
  /** Read-only exact-artifact resolver shared with the Pi-hosted surface. */
  cockpitCatalogResolver?: ControlCenterCockpitCatalogResolver;
}

export interface StandaloneControlCenterHandle {
  readonly controller: ControlCenterController;
  readonly component: ControlCenterComponent;
  readonly tui: TUI;
  readonly closed: Promise<void>;
  readonly started: boolean;
  start(): void;
  stop(): Promise<void>;
}

/**
 * Construct a standalone Koni control center without starting terminal/raw mode.
 *
 * The caller must explicitly invoke `start()`. Nothing here opens another terminal, cmux/tmux
 * pane, or background TUI; `koni tui` simply mounts this in the terminal where it was called.
 */
export async function createStandaloneControlCenter(
  options: StandaloneControlCenterOptions,
): Promise<StandaloneControlCenterHandle> {
  const ownsClient = options.client === undefined;
  const initialClient =
    options.client ??
    (await AuthorityClient.connect({
      projectRoot: options.projectRoot,
      client: "tui",
      version: options.version,
    }));
  const client =
    options.reconnectClient === undefined
      ? initialClient
      : new ResilientControlCenterClient({
          client: initialClient,
          reconnect: options.reconnectClient,
        });
  const terminal = options.terminal ?? new ProcessTerminal();
  // Authority-client ownership is unrelated to Pi model discovery. The CLI deliberately injects
  // its already-leased authority client, but New Run must still see the ordinary Pi catalog.
  const models = options.models ?? (await loadStandaloneModels());
  const tui = new TUI(terminal);
  let started = false;
  let stopped = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let component: ControlCenterComponent;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (started) {
      tui.stop();
      await terminal.drainInput(250, 25);
    }
    component.dispose();
    controller.dispose();
    resolveClosed();
  };
  const controller = new ControlCenterController({
    projectRoot: options.projectRoot,
    client,
    models,
    cockpitCatalogResolver:
      options.cockpitCatalogResolver ?? createAuthorityCockpitCatalogResolver(client),
    closeClientOnDispose: ownsClient || options.reconnectClient !== undefined,
    onQuit: () => void stop(),
  });
  component = new ControlCenterComponent({
    controller,
    palette: options.palette ?? ansiKoniPalette(),
    viewportRows: () => terminal.rows,
    requestRender: () => tui.requestRender(),
  });
  try {
    await controller.initialize();
  } catch (error) {
    component.dispose();
    controller.dispose();
    throw error;
  }
  return {
    controller,
    component,
    tui,
    closed,
    get started() {
      return started;
    },
    start(): void {
      if (started || stopped) return;
      started = true;
      tui.addChild(component);
      tui.setFocus(component);
      tui.start();
    },
    stop,
  };
}

async function loadStandaloneModels(): Promise<ControlModelOption[]> {
  return loadSealedPiModelCatalog();
}

/** Explicit blocking host used by the `koni tui` command. */
export async function runStandaloneControlCenter(
  options: StandaloneControlCenterOptions,
): Promise<void> {
  const handle = await createStandaloneControlCenter(options);
  handle.start();
  await handle.closed;
}
