import { describe, expect, it } from "vitest";
import type { RpcSuccess } from "../src/authority/protocol.js";
import { CellGrid } from "../src/control-center/cell-grid.js";
import { ControlCenterComponent } from "../src/control-center/component.js";
import {
  ControlCenterController,
  type ControlCenterAuthorityClient,
} from "../src/control-center/controller.js";
import { decodeControlCenterInput } from "../src/control-center/input.js";
import {
  CONTROL_CENTER_MIN_HEIGHT,
  CONTROL_CENTER_MIN_WIDTH,
  configureLayout,
  operateLayout,
} from "../src/control-center/layout.js";

describe("control-center geometry", () => {
  it.each([
    [82, 20],
    [82, 24],
    [100, 30],
    [122, 40],
    [180, 52],
  ])(
    "keeps the third-width left column and the merged details section at %dx%d",
    (width, height) => {
      const layout = operateLayout(width, height, true);
      expect(layout.kind).toBe("operate");
      if (layout.kind !== "operate") return;
      // Left column takes a third (plus the division remainder); details takes the rest.
      expect(layout.runs.width).toBe(Math.floor(width / 3) + (width % 3 > 0 ? 1 : 0));
      expect(layout.details.width).toBe(width - layout.runs.width);
      expect(layout.footer).toEqual({ x: 0, y: height - 1, width, height: 1 });
      expect(layout.runs).toMatchObject({ x: 0, y: 0 });
      expect(
        layout.runs.height + layout.tickets.height + layout.agents.height + layout.activity.height,
      ).toBe(height - 1);
      expect(layout.details.height + layout.questions!.height).toBe(height - 1);
      expect(layout.agents.x).toBe(0);
      // Activity is the left column's fourth panel, directly under the squished Agents panel.
      expect(layout.activity.x).toBe(0);
      expect(layout.activity.y).toBe(layout.agents.y + layout.agents.height);
      expect(layout).not.toHaveProperty("graph");
    },
  );

  it("uses the explicit viewport minimum instead of silently changing information architecture", () => {
    expect(operateLayout(CONTROL_CENTER_MIN_WIDTH - 1, CONTROL_CENTER_MIN_HEIGHT, false).kind).toBe(
      "resize",
    );
    expect(operateLayout(CONTROL_CENTER_MIN_WIDTH, CONTROL_CENTER_MIN_HEIGHT - 1, false).kind).toBe(
      "resize",
    );
    expect(operateLayout(CONTROL_CENTER_MIN_WIDTH, CONTROL_CENTER_MIN_HEIGHT, false).kind).toBe(
      "operate",
    );
  });

  it("keeps Configure's 25-cell domain lane, 30-percent resources, and three-row draft bar", () => {
    const layout = configureLayout(122, 40);
    expect(layout.kind).toBe("configure");
    if (layout.kind !== "configure") return;
    expect(layout.domains.width).toBe(25);
    expect(layout.resources.width).toBe(36);
    expect(layout.editor.width).toBe(61);
    expect(layout.draftBar.height).toBe(3);
    expect(layout.domains.height).toBe(layout.resources.height);
    expect(layout.resources.height).toBe(layout.editor.height);
  });
});

describe("deterministic CellGrid frame contract", () => {
  it("normalizes styles, Unicode display cells, regions, and hostile terminal controls", () => {
    const source = "\u001b[31;1mA界e\u0301\u001b[0m\u001b]2;not-a-title\u0007Z\u001b[2J";
    const grid = CellGrid.fromAnsiLines([source], 8, 1)
      .addRegion("content", { x: 0, y: 0, width: 8, height: 1 }, "panel:content")
      .addHitTarget("choice:one", { x: 1, y: 0, width: 2, height: 1 });
    expect(grid.cells[0]).toHaveLength(8);
    expect(grid.cells[0]![0]).toMatchObject({ glyph: "A", continuation: false });
    expect(grid.cells[0]![1]).toMatchObject({ glyph: "界", continuation: false });
    expect(grid.cells[0]![2]).toMatchObject({ glyph: "", continuation: true });
    expect(grid.cells[0]![3]!.glyph.normalize("NFC")).toBe("é");
    expect(grid.cells[0]![0]!.style).toMatchObject({ foreground: "ansi-31", bold: true });
    expect(grid.hitTargetAt(1, 0)).toBe("choice:one");
    expect(grid.serialize().rows[0]![0]).toMatchObject({
      region: "content",
      hitTarget: "panel:content",
    });
    expect(grid.toAnsiLines()[0]).not.toContain("not-a-title");
    expect(grid.toAnsiLines()[0]).not.toContain("\u001b[2J");
  });

  it("renders the full no-run cockpit into exact semantic regions at 82x20", async () => {
    const controller = new ControlCenterController({
      projectRoot: "/project",
      client: new EmptyAuthority(),
    });
    await controller.initialize();
    const component = new ControlCenterComponent({ controller, viewportRows: () => 20 });
    const frame = component.renderFrame(82, 20);
    const regions = Object.fromEntries(frame.regions.map((region) => [region.name, region.rect]));
    expect(regions).toMatchObject({
      runs: { x: 0, y: 0, width: 28, height: 5 },
      tickets: { x: 0, y: 5, width: 28, height: 6 },
      agents: { x: 0, y: 11, width: 28, height: 4 },
      activity: { x: 0, y: 15, width: 28, height: 4 },
      details: { x: 28, y: 0, width: 54, height: 19 },
      footer: { x: 0, y: 19, width: 82, height: 1 },
    });
    expect(regions).not.toHaveProperty("header");
    expect(regions).not.toHaveProperty("graph");
    expect(frame.toPlainLines()[0]).toContain("Runs");
    expect(frame.toPlainLines()[0]).toContain("Details:");
    expect(frame.toPlainLines()[15]).toContain("Activity");
    expect(frame.toPlainLines()[11]).toContain("Agents");
    expect(frame.toAnsiLines()).toEqual(component.render(82));
    expect(frame.toAnsiLines().every((line) => line.length > 0)).toBe(true);
    component.dispose();
    controller.dispose();
  });

  it("renders a bordered resize explanation below 82x20", async () => {
    const controller = new ControlCenterController({
      projectRoot: "/project",
      client: new EmptyAuthority(),
    });
    await controller.initialize();
    const component = new ControlCenterComponent({ controller, viewportRows: () => 19 });
    const text = component.render(81).join("\n");
    expect(text).toContain("needs at least 82×20");
    expect(text).toContain("current terminal: 81×19");
    expect(text).not.toContain("Tickets appear after plan approval");
    component.dispose();
    controller.dispose();
  });
});

describe("control-center focus order", () => {
  it("maps numeric focus in visual order", () => {
    const context = { panel: "runs" as const, editingNotes: false, modalOpen: false };
    expect(decodeControlCenterInput("1", context)).toEqual({ type: "focus_panel", panel: "runs" });
    expect(decodeControlCenterInput("2", context)).toEqual({
      type: "focus_panel",
      panel: "tickets",
    });
    expect(decodeControlCenterInput("3", context)).toEqual({
      type: "focus_panel",
      panel: "agents",
    });
    expect(decodeControlCenterInput("4", context)).toEqual({
      type: "focus_panel",
      panel: "details",
    });
    expect(decodeControlCenterInput("5", context)).toEqual({
      type: "focus_panel",
      panel: "activity",
    });
    // 6 was the graph panel; it now jumps to the Details panel's Graph feed.
    expect(decodeControlCenterInput("6", context)).toEqual({ type: "focus_graph" });
  });

  it("splits arrows from brackets so the Graph feed can own horizontal movement", () => {
    const context = { panel: "details" as const, editingNotes: false, modalOpen: false };
    expect(decodeControlCenterInput("\u001b[C", context)).toEqual({
      type: "move_horizontal",
      delta: 1,
    });
    expect(decodeControlCenterInput("\u001b[D", context)).toEqual({
      type: "move_horizontal",
      delta: -1,
    });
    expect(decodeControlCenterInput("]", context)).toEqual({ type: "details_tab", delta: 1 });
    expect(decodeControlCenterInput("[", context)).toEqual({ type: "details_tab", delta: -1 });
  });
});

class EmptyAuthority implements ControlCenterAuthorityClient {
  public revision = 1;

  public async request(method: string): Promise<RpcSuccess> {
    if (method !== "run.page") throw new Error(`unexpected RPC ${method}`);
    return {
      type: "response",
      id: "fixture",
      ok: true,
      revision: this.revision,
      result: {
        protocol: "koni.run-summary-page.v2",
        revision: this.revision,
        order: "created_at_desc_id_asc",
        includeDeleted: false,
        totalRuns: 0,
        startIndex: 0,
        runs: [],
      },
    };
  }
}
