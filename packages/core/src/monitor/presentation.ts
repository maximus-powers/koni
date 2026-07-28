import type { Theme } from "@earendil-works/pi-coding-agent";

export interface MonitorPalette {
  text(value: string): string;
  muted(value: string): string;
  dim(value: string): string;
  accent(value: string): string;
  success(value: string): string;
  warning(value: string): string;
  error(value: string): string;
  border(value: string): string;
  selected(value: string): string;
  bold(value: string): string;
}

export const plainMonitorPalette: MonitorPalette = {
  text: identity,
  muted: identity,
  dim: identity,
  accent: identity,
  success: identity,
  warning: identity,
  error: identity,
  border: identity,
  selected: (value) => `‹${value}›`,
  bold: identity,
};

export function monitorPaletteFromPiTheme(theme: Theme): MonitorPalette {
  return {
    text: (value) => theme.fg("text", value),
    muted: (value) => theme.fg("muted", value),
    dim: (value) => theme.fg("dim", value),
    accent: (value) => theme.fg("accent", value),
    success: (value) => theme.fg("success", value),
    warning: (value) => theme.fg("warning", value),
    error: (value) => theme.fg("error", value),
    border: (value) => theme.fg("borderMuted", value),
    selected: (value) => theme.bg("selectedBg", theme.fg("text", value)),
    bold: (value) => theme.bold(value),
  };
}

function identity(value: string): string {
  return value;
}
