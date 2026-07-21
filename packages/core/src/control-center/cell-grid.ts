import { visibleWidth } from "@earendil-works/pi-tui";
import type { ControlCenterRect } from "./layout.js";

export interface CellStyle {
  foreground: string;
  background: string;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
}

export interface ControlCenterCell {
  glyph: string;
  continuation: boolean;
  style: CellStyle;
  region?: string;
  hitTarget?: string;
}

export interface CellGridRegion {
  name: string;
  rect: ControlCenterRect;
  hitTarget?: string;
}

const DEFAULT_STYLE: CellStyle = {
  foreground: "default",
  background: "default",
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  inverse: false,
};

/**
 * Deterministic terminal-cell projection used by both hosts and the parity harness.
 *
 * It preserves the already-rendered ANSI lines for the host while exposing normalized glyph,
 * style, semantic-region, and hit-target cells to exact tests. Non-SGR terminal controls are
 * discarded, so hostile content cannot create cells outside the component's declared frame.
 */
export class CellGrid {
  public readonly width: number;
  public readonly height: number;
  public readonly cells: ControlCenterCell[][];
  public readonly regions: CellGridRegion[];
  readonly #ansiLines: string[];

  private constructor(width: number, height: number, ansiLines: string[], cells: ControlCenterCell[][]) {
    this.width = width;
    this.height = height;
    this.#ansiLines = ansiLines;
    this.cells = cells;
    this.regions = [];
  }

  public static fromAnsiLines(lines: readonly string[], width: number, height: number): CellGrid {
    const safeWidth = Math.max(1, Math.floor(width));
    const safeHeight = Math.max(1, Math.floor(height));
    const ansiLines: string[] = [];
    const cells: ControlCenterCell[][] = [];
    for (let row = 0; row < safeHeight; row += 1) {
      const source = lines[row] ?? "";
      const parsed = parseAnsiLine(source, safeWidth);
      ansiLines.push(parsed.safeAnsi);
      cells.push(parsed.cells);
    }
    return new CellGrid(safeWidth, safeHeight, ansiLines, cells);
  }

  public addRegion(name: string, rect: ControlCenterRect, hitTarget?: string): this {
    const clipped = clipRect(rect, this.width, this.height);
    this.regions.push({ name, rect: clipped, ...(hitTarget === undefined ? {} : { hitTarget }) });
    for (let y = clipped.y; y < clipped.y + clipped.height; y += 1) {
      for (let x = clipped.x; x < clipped.x + clipped.width; x += 1) {
        const cell = this.cells[y]?.[x];
        if (cell === undefined) continue;
        cell.region = name;
        if (hitTarget !== undefined) cell.hitTarget = hitTarget;
      }
    }
    return this;
  }

  public addHitTarget(target: string, rect: ControlCenterRect): this {
    const clipped = clipRect(rect, this.width, this.height);
    for (let y = clipped.y; y < clipped.y + clipped.height; y += 1) {
      for (let x = clipped.x; x < clipped.x + clipped.width; x += 1) {
        const cell = this.cells[y]?.[x];
        if (cell !== undefined) cell.hitTarget = target;
      }
    }
    return this;
  }

  /** Bind an exact rendered label to pointer geometry without re-computing layout from source text. */
  public addTextHitTarget(
    target: string,
    text: string,
    within: ControlCenterRect = { x: 0, y: 0, width: this.width, height: this.height },
    occurrence = 0,
  ): this {
    if (text.length === 0 || occurrence < 0) return this;
    const rect = clipRect(within, this.width, this.height);
    const glyphs = graphemes(text);
    let seen = 0;
    for (let y = rect.y; y < rect.y + rect.height; y += 1) {
      for (let x = rect.x; x < rect.x + rect.width; x += 1) {
        let cursor = x;
        let matches = true;
        for (const glyph of glyphs) {
          const cell = this.cells[y]?.[cursor];
          if (cell === undefined || cell.continuation || cell.glyph !== glyph) {
            matches = false;
            break;
          }
          cursor += Math.max(1, visibleWidth(glyph));
        }
        if (!matches || cursor > rect.x + rect.width) continue;
        if (seen === occurrence) return this.addHitTarget(target, { x, y, width: cursor - x, height: 1 });
        seen += 1;
      }
    }
    return this;
  }

  public hitTargetAt(x: number, y: number): string | undefined {
    return this.cells[y]?.[x]?.hitTarget;
  }

  public toAnsiLines(): string[] {
    return [...this.#ansiLines];
  }

  public toPlainLines(): string[] {
    return this.cells.map((row) => row.map((cell) => cell.continuation ? "" : cell.glyph).join(""));
  }

  public serialize(): {
    width: number;
    height: number;
    regions: CellGridRegion[];
    rows: { glyph: string; style: string; region?: string; hitTarget?: string }[][];
  } {
    return {
      width: this.width,
      height: this.height,
      regions: structuredClone(this.regions),
      rows: this.cells.map((row) => row.map((cell) => ({
        glyph: cell.continuation ? "<continuation>" : cell.glyph,
        style: styleKey(cell.style),
        ...(cell.region === undefined ? {} : { region: cell.region }),
        ...(cell.hitTarget === undefined ? {} : { hitTarget: cell.hitTarget }),
      }))),
    };
  }
}

function parseAnsiLine(source: string, width: number): { safeAnsi: string; cells: ControlCenterCell[] } {
  const cells: ControlCenterCell[] = [];
  let safeAnsi = "";
  let style = { ...DEFAULT_STYLE };
  const tokens = source.match(/\u001b\[[0-9;]*m|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[[0-?]*[ -/]*[@-~]|[^\u001b]+|\u001b/gu) ?? [];
  for (const token of tokens) {
    if (/^\u001b\[[0-9;]*m$/u.test(token)) {
      style = applySgr(style, token);
      safeAnsi += token;
      continue;
    }
    if (token.startsWith("\u001b")) continue;
    const safeText = token.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "�");
    for (const grapheme of graphemes(safeText)) {
      if (cells.length >= width) break;
      const glyphWidth = Math.max(0, visibleWidth(grapheme));
      if (glyphWidth === 0) {
        const previous = [...cells].reverse().find((cell) => !cell.continuation);
        if (previous !== undefined) previous.glyph += grapheme;
        continue;
      }
      if (cells.length + glyphWidth > width) break;
      cells.push({ glyph: grapheme, continuation: false, style: { ...style } });
      for (let offset = 1; offset < glyphWidth; offset += 1) {
        cells.push({ glyph: "", continuation: true, style: { ...style } });
      }
      safeAnsi += grapheme;
    }
  }
  while (cells.length < width) cells.push({ glyph: " ", continuation: false, style: { ...DEFAULT_STYLE } });
  const visible = visibleWidth(safeAnsi);
  if (visible < width) safeAnsi += " ".repeat(width - visible);
  return { safeAnsi, cells };
}

function applySgr(previous: CellStyle, sequence: string): CellStyle {
  const body = sequence.slice(2, -1);
  const codes = body.length === 0 ? [0] : body.split(";").map((part) => Number(part));
  let style = { ...previous };
  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index] ?? 0;
    if (code === 0) style = { ...DEFAULT_STYLE };
    else if (code === 1) style.bold = true;
    else if (code === 2) style.dim = true;
    else if (code === 3) style.italic = true;
    else if (code === 4) style.underline = true;
    else if (code === 7) style.inverse = true;
    else if (code === 22) { style.bold = false; style.dim = false; }
    else if (code === 23) style.italic = false;
    else if (code === 24) style.underline = false;
    else if (code === 27) style.inverse = false;
    else if (code === 39) style.foreground = "default";
    else if (code === 49) style.background = "default";
    else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) style.foreground = `ansi-${code}`;
    else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) style.background = `ansi-${code}`;
    else if ((code === 38 || code === 48) && codes[index + 1] === 2) {
      const red = codes[index + 2];
      const green = codes[index + 3];
      const blue = codes[index + 4];
      if ([red, green, blue].every((value) => Number.isInteger(value) && value! >= 0 && value! <= 255)) {
        const value = `rgb-${red}-${green}-${blue}`;
        if (code === 38) style.foreground = value;
        else style.background = value;
        index += 4;
      }
    } else if ((code === 38 || code === 48) && codes[index + 1] === 5) {
      const value = `index-${codes[index + 2] ?? 0}`;
      if (code === 38) style.foreground = value;
      else style.background = value;
      index += 2;
    }
  }
  return style;
}

function graphemes(value: string): string[] {
  const Segmenter = Intl.Segmenter;
  if (Segmenter === undefined) return Array.from(value);
  return [...new Segmenter(undefined, { granularity: "grapheme" }).segment(value)].map((entry) => entry.segment);
}

function styleKey(style: CellStyle): string {
  return [
    `fg=${style.foreground}`,
    `bg=${style.background}`,
    ...(style.bold ? ["bold"] : []),
    ...(style.dim ? ["dim"] : []),
    ...(style.italic ? ["italic"] : []),
    ...(style.underline ? ["underline"] : []),
    ...(style.inverse ? ["inverse"] : []),
  ].join(";");
}

function clipRect(rect: ControlCenterRect, width: number, height: number): ControlCenterRect {
  const x = Math.max(0, Math.min(width, rect.x));
  const y = Math.max(0, Math.min(height, rect.y));
  return {
    x,
    y,
    width: Math.max(0, Math.min(width - x, rect.width)),
    height: Math.max(0, Math.min(height - y, rect.height)),
  };
}
