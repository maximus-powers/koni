export const CONTROL_CENTER_MIN_WIDTH = 82;
export const CONTROL_CENTER_MIN_HEIGHT = 20;

export interface ControlCenterRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type OperateRegionName =
  "runs" | "tickets" | "agents" | "details" | "questions" | "activity" | "footer";

export interface OperateLayout {
  kind: "operate";
  width: number;
  height: number;
  runs: ControlCenterRect;
  tickets: ControlCenterRect;
  agents: ControlCenterRect;
  details: ControlCenterRect;
  questions?: ControlCenterRect;
  activity: ControlCenterRect;
  footer: ControlCenterRect;
}

export interface ResizeLayout {
  kind: "resize";
  width: number;
  height: number;
  screen: ControlCenterRect;
}

export type ControlCenterLayout = OperateLayout | ResizeLayout;

/**
 * Stable dashboard geometry.
 *
 * The left column keeps one third of the width (plus the division remainder) for Runs / Tickets /
 * Agents / Activity; the remaining two thirds are one tall Details section, split 67/33 over
 * Questions when the run has any. Activity sits last in the left column so it absorbs the
 * rounding slack. This is the only source of panel geometry for drawing, frame regions, and hit
 * testing.
 */
export function operateLayout(
  width: number,
  height: number,
  showQuestions: boolean,
): ControlCenterLayout {
  const safeWidth = Math.max(1, Math.floor(width));
  const safeHeight = Math.max(1, Math.floor(height));
  if (safeWidth < CONTROL_CENTER_MIN_WIDTH || safeHeight < CONTROL_CENTER_MIN_HEIGHT) {
    return {
      kind: "resize",
      width: safeWidth,
      height: safeHeight,
      screen: rect(0, 0, safeWidth, safeHeight),
    };
  }

  const footer = rect(0, safeHeight - 1, safeWidth, 1);
  const bodyY = 0;
  const bodyHeight = safeHeight - footer.height;
  const leftWidth = Math.floor(safeWidth / 3) + Number(safeWidth % 3 > 0);
  const rightWidth = safeWidth - leftWidth;
  const leftX = 0;
  const rightX = leftWidth;

  const left = percentageSplit(bodyHeight, [28, 34, 22, 16]);
  const runsHeight = left[0]!;
  const ticketsHeight = left[1]!;
  const agentsHeight = left[2]!;
  const activityHeight = left[3]!;
  const right = showQuestions ? percentageSplit(bodyHeight, [67, 33]) : [bodyHeight, 0];
  const detailsHeight = right[0]!;
  const questionsHeight = right[1]!;

  return {
    kind: "operate",
    width: safeWidth,
    height: safeHeight,
    runs: rect(leftX, bodyY, leftWidth, runsHeight),
    tickets: rect(leftX, bodyY + runsHeight, leftWidth, ticketsHeight),
    agents: rect(leftX, bodyY + runsHeight + ticketsHeight, leftWidth, agentsHeight),
    activity: rect(
      leftX,
      bodyY + runsHeight + ticketsHeight + agentsHeight,
      leftWidth,
      activityHeight,
    ),
    details: rect(rightX, bodyY, rightWidth, detailsHeight),
    ...(showQuestions
      ? {
          questions: rect(rightX, bodyY + detailsHeight, rightWidth, questionsHeight),
        }
      : {}),
    footer,
  };
}

export interface ConfigureLayout {
  kind: "configure";
  width: number;
  height: number;
  header: ControlCenterRect;
  domains: ControlCenterRect;
  resources: ControlCenterRect;
  editor: ControlCenterRect;
  draftBar: ControlCenterRect;
  footer: ControlCenterRect;
}

/** Configure geometry: 25 cells, 30 percent, remainder; three-row draft bar. */
export function configureLayout(width: number, height: number): ConfigureLayout | ResizeLayout {
  const base = operateLayout(width, height, false);
  if (base.kind === "resize") return base;
  const header = rect(0, 0, base.width, 4);
  const bodyY = header.height;
  const bodyHeight = base.footer.y - bodyY;
  const draftHeight = Math.min(3, bodyHeight);
  const contentHeight = bodyHeight - draftHeight;
  const domainsWidth = Math.min(25, base.width);
  const remaining = base.width - domainsWidth;
  const resourcesWidth = Math.min(remaining, Math.floor(base.width * 0.3));
  const editorWidth = Math.max(0, base.width - domainsWidth - resourcesWidth);
  return {
    kind: "configure",
    width: base.width,
    height: base.height,
    header,
    domains: rect(0, bodyY, domainsWidth, contentHeight),
    resources: rect(domainsWidth, bodyY, resourcesWidth, contentHeight),
    editor: rect(domainsWidth + resourcesWidth, bodyY, editorWidth, contentHeight),
    draftBar: rect(0, bodyY + contentHeight, base.width, draftHeight),
    footer: base.footer,
  };
}

export function rectContains(rectangle: ControlCenterRect, x: number, y: number): boolean {
  return (
    x >= rectangle.x &&
    y >= rectangle.y &&
    x < rectangle.x + rectangle.width &&
    y < rectangle.y + rectangle.height
  );
}

function percentageSplit(total: number, percentages: readonly number[]): number[] {
  const output: number[] = [];
  let assigned = 0;
  percentages.forEach((percentage, index) => {
    const value =
      index === percentages.length - 1 ? total - assigned : Math.floor((total * percentage) / 100);
    output.push(value);
    assigned += value;
  });
  return output;
}

function rect(x: number, y: number, width: number, height: number): ControlCenterRect {
  return { x, y, width: Math.max(0, width), height: Math.max(0, height) };
}
