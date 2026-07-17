import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const KONI_PROFILE_DISCOVER_EVENT = "koni.profile.discover.v1" as const;
export const KONI_PROFILE_AVAILABLE_EVENT = "koni.profile.available.v1" as const;

export const PROFILE_DESCRIPTOR = Object.freeze({
  protocol: "koni.profile-source.v1" as const,
  package: "@koni/coding-profile",
  manifest_url: new URL("../koni/profile-manifest.json", import.meta.url).href,
});

/** Announce the immutable bundle source; Koni Core remains the sole authority. */
export default function registerCodingProfile(pi: ExtensionAPI): void {
  const announce = (): void => {
    pi.events.emit(KONI_PROFILE_AVAILABLE_EVENT, PROFILE_DESCRIPTOR);
  };

  const unsubscribe = pi.events.on(KONI_PROFILE_DISCOVER_EVENT, announce);
  pi.on("session_start", announce);
  pi.on("session_shutdown", unsubscribe);
}
