import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Markdown,
  type Component,
  type MarkdownTheme,
} from "@earendil-works/pi-tui";

export interface KoniPalette {
  text(value: string): string;
  muted(value: string): string;
  dim(value: string): string;
  accent(value: string): string;
  border(value: string): string;
  borderActive(value: string): string;
  success(value: string): string;
  warning(value: string): string;
  error(value: string): string;
  info(value: string): string;
  selected(value: string): string;
  bold(value: string): string;
  italic(value: string): string;
  underline(value: string): string;
}

export const plainKoniPalette: KoniPalette = Object.freeze({
  text: identity,
  muted: identity,
  dim: identity,
  accent: identity,
  border: identity,
  borderActive: identity,
  success: identity,
  warning: identity,
  error: identity,
  info: identity,
  selected: identity,
  bold: identity,
  italic: identity,
  underline: identity,
});

export function paletteFromPiTheme(theme: Theme): KoniPalette {
  return {
    text: (value) => theme.fg("text", value),
    muted: (value) => theme.fg("muted", value),
    dim: (value) => theme.fg("dim", value),
    accent: (value) => theme.fg("accent", value),
    border: (value) => theme.fg("borderMuted", value),
    borderActive: (value) => theme.fg("borderAccent", value),
    success: (value) => theme.fg("success", value),
    warning: (value) => theme.fg("warning", value),
    error: (value) => theme.fg("error", value),
    info: (value) => theme.fg("customMessageText", value),
    selected: (value) => theme.bg("selectedBg", theme.fg("text", value)),
    bold: (value) => theme.bold(value),
    italic: (value) => theme.italic(value),
    underline: (value) => theme.underline(value),
  };
}

export function ansiKoniPalette(enabled = process.env.NO_COLOR === undefined): KoniPalette {
  if (!enabled) return plainKoniPalette;
  const sgr = (open: number, close: number) => (value: string): string =>
    `\u001b[${open}m${value}\u001b[${close}m`;
  return {
    text: sgr(37, 39),
    muted: sgr(90, 39),
    dim: sgr(2, 22),
    accent: sgr(36, 39),
    border: sgr(90, 39),
    borderActive: sgr(36, 39),
    success: sgr(32, 39),
    warning: sgr(33, 39),
    error: sgr(31, 39),
    info: sgr(35, 39),
    selected: sgr(7, 27),
    bold: sgr(1, 22),
    italic: sgr(3, 23),
    underline: sgr(4, 24),
  };
}

/** Pi's native Markdown renderer with Koni's shared semantic palette. */
export class KoniMarkdown implements Component {
  readonly #markdown: Markdown;

  public constructor(text: string, palette: KoniPalette, paddingX = 0, paddingY = 0) {
    this.#markdown = new Markdown(
      text,
      paddingX,
      paddingY,
      markdownTheme(palette),
      { color: palette.text },
      { preserveOrderedListMarkers: true, preserveBackslashEscapes: true },
    );
  }

  public setText(text: string): void {
    this.#markdown.setText(text);
  }

  public invalidate(): void {
    this.#markdown.invalidate();
  }

  public render(width: number): string[] {
    return this.#markdown.render(Math.max(1, width));
  }
}

export function renderKoniMarkdown(
  text: string,
  width: number,
  palette: KoniPalette,
): string[] {
  return new KoniMarkdown(text, palette).render(width);
}

function markdownTheme(palette: KoniPalette): MarkdownTheme {
  return {
    heading: (value) => palette.bold(palette.text(value)),
    link: palette.accent,
    linkUrl: palette.muted,
    code: palette.info,
    codeBlock: palette.text,
    codeBlockBorder: palette.border,
    quote: palette.muted,
    quoteBorder: palette.border,
    hr: palette.border,
    listBullet: palette.accent,
    bold: palette.bold,
    italic: palette.italic,
    strikethrough: palette.dim,
    underline: palette.underline,
    codeBlockIndent: "  ",
  };
}

function identity(value: string): string {
  return value;
}
