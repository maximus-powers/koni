import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const BIDI_OR_INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/gu;

export interface TerminalTextOptions {
  maxCodePoints?: number;
  multiline?: boolean;
}

/**
 * Remove terminal control protocols before any authority/user string reaches a component.
 * The scanner covers CSI, OSC, DCS/SOS/PM/APC, two-byte ESC sequences, C0, and C1 controls.
 */
export function terminalSafeText(value: string, options: TerminalTextOptions = {}): string {
  const multiline = options.multiline ?? false;
  const maximum = boundedInteger(options.maxCodePoints ?? 512, 1, 32_768);
  const stripped = stripTerminalControls(value).normalize("NFC").replace(BIDI_OR_INVISIBLE, "");
  const normalized = multiline
    ? stripped
        .replace(/\r\n?/gu, "\n")
        .split("\n")
        .map((line) => line.replace(/[\t\v\f ]+/gu, " ").trimEnd())
        .join("\n")
        .replace(/\n{4,}/gu, "\n\n\n")
        .trim()
    : stripped.replace(/\s+/gu, " ").trim();
  const codePoints = [...normalized];
  return codePoints.length <= maximum
    ? normalized
    : `${codePoints.slice(0, Math.max(0, maximum - 1)).join("")}…`;
}

export function terminalSafeLines(
  value: string,
  width: number,
  options: TerminalTextOptions & { maxLines?: number } = {},
): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const maximumLines = boundedInteger(options.maxLines ?? 20, 1, 1_000);
  const safe = terminalSafeText(value, { ...options, multiline: true });
  const lines =
    safe.length === 0
      ? [""]
      : safe.split("\n").flatMap((line) => wrapTextWithAnsi(line, safeWidth));
  const bounded = lines
    .slice(0, maximumLines)
    .map((line) => truncateToWidth(line, safeWidth, "…", true));
  if (lines.length > maximumLines && bounded.length > 0) {
    bounded[bounded.length - 1] = truncateToWidth(`${bounded.at(-1)!} …`, safeWidth, "…", true);
  }
  return bounded;
}

export function fitTerminalLine(value: string, width: number, fill = false): string {
  const safeWidth = Math.max(1, Math.floor(width));
  const clipped = truncateToWidth(value, safeWidth, "…", true);
  if (!fill) return clipped;
  return `${clipped}${" ".repeat(Math.max(0, safeWidth - visibleWidth(clipped)))}`;
}

function stripTerminalControls(value: string): string {
  let output = "";
  for (let index = 0; index < value.length;) {
    const code = value.charCodeAt(index);
    if (code === 0x1b) {
      const next = value.charCodeAt(index + 1);
      if (next === 0x5b) {
        index = consumeCsi(value, index + 2);
      } else if (next === 0x5d) {
        index = consumeStringControl(value, index + 2, true);
      } else if (next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
        index = consumeStringControl(value, index + 2, false);
      } else {
        index = Math.min(value.length, index + 2);
      }
      continue;
    }
    if (code === 0x9b) {
      index = consumeCsi(value, index + 1);
      continue;
    }
    if (code === 0x9d || code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
      index = consumeStringControl(value, index + 1, code === 0x9d);
      continue;
    }
    if (
      (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
      code === 0x7f ||
      (code >= 0x80 && code <= 0x9f)
    ) {
      index += 1;
      continue;
    }
    const point = value.codePointAt(index)!;
    output += String.fromCodePoint(point);
    index += point > 0xffff ? 2 : 1;
  }
  return output;
}

function consumeCsi(value: string, start: number): number {
  let index = start;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    index += 1;
    if (code >= 0x40 && code <= 0x7e) return index;
  }
  return index;
}

function consumeStringControl(value: string, start: number, bellTerminates: boolean): number {
  let index = start;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (bellTerminates && code === 0x07) return index + 1;
    if (code === 0x9c) return index + 1;
    if (code === 0x1b && value.charCodeAt(index + 1) === 0x5c) return index + 2;
    index += 1;
  }
  return index;
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value)) return minimum;
  return Math.max(minimum, Math.min(maximum, value));
}
