/**
 * Exact identities for historical stock configuration objects that current Core may project
 * read-only while reopening an immutable run snapshot. These are compatibility identities, not
 * schema allowances: a one-byte customization must continue to fail current compilation.
 */
export const RETIRED_STOCK_BROWSER_SMOKE_SHA256 =
  "sha256:04925fedc8c20178ebcd28b948ddd07799b9a3d10c027dc8e160bed4d4f6bbcd" as const;

/** Exact 0.7 software-profile fragments that may be upgraded in memory for an immutable run. */
export const LEGACY_SOFTWARE_PROFILE_GIT_SHA256 =
  "sha256:2bc721b0ce13472a027a76dcf59c0884353a7db618f01275b6ee360a9aa09588" as const;
export const CURRENT_SOFTWARE_PROFILE_GIT_SHA256 =
  "sha256:f140067db6edfaf4ffb260b8378bbe9c8a66de3a3e675faa1c382b1731e33ae6" as const;
export const LEGACY_SOFTWARE_STORAGE_SHA256 =
  "sha256:ab355367ad8b397efe26647108ffd2bf5cbd55fd2aa53703d34bca07d302ca55" as const;
export const LEGACY_SOFTWARE_RUN_GIT_SHA256 =
  "sha256:0d0efabfb6ea9e4b652d66a17b024d87e6ca5624001fad0452b57f563a3a3f11" as const;
export const CURRENT_SOFTWARE_RUN_GIT_SHA256 =
  "sha256:4643adbe1ed23c6c180683c2d6cf1ff955ce557444d0164f3e5e10dde92600c1" as const;
export const LEGACY_SOFTWARE_LEAD_IDENTITY_SHA256 =
  "sha256:5c68014a603aa83d717bf966dc7ac6a864daecb80f6b6489d18c5018ee3fe841" as const;
export const CURRENT_SOFTWARE_LEAD_IDENTITY_SHA256 =
  "sha256:f1ce476adf4c682859a77aff44d740716b5450be3be374c0753c2096cf723d2a" as const;

/**
 * Exact pre-reissue lifecycle machines shipped by Koni's stock Coding and Research profiles.
 *
 * Those profiles declared `closed` terminal but predated the compiler fixpoint behavior that can
 * discover a completed obligation whose evidence has become stale. Current profiles configure the
 * compiler-only `closed -> todo` transition explicitly. These hashes let already-pinned stock runs
 * receive that one additive correction without granting the same transition to customized lifecycle
 * machines or reinterpreting any other state/actor pair.
 */
export const LEGACY_SOFTWARE_TICKET_LIFECYCLE_MACHINE_SHA256 =
  "sha256:4d6f5e51a8d3604b1f97cfc3aa0cf39c1783e6dc0cc421cbeee4fb810c42be44" as const;
export const LEGACY_RESEARCH_TICKET_LIFECYCLE_MACHINE_SHA256 =
  "sha256:472f815e8ef223eb648139ec76063739dcbf9cd599075ab8aca1b7cb92fdea33" as const;
