import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Pi entry point for Koni Core.
 *
 * Runtime registration is intentionally assembled by the Core implementation
 * rather than by profile packages. Keeping the entry point side-effect free
 * also lets Pi evaluate it in commands that never start a session.
 */
export default function registerKoniCore(_pi: ExtensionAPI): void {}
