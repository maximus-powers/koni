# Pi product-doc transition

Owner: `pi_product_docs_transition`

## Scope

- Append-only transition notes in the product documentation for the in-progress Pi/schema-2 runtime.
- Preserve Codex/schema-1 language as historical and currently shipped behavior.
- Do not edit source, profiles, tests, binaries, live state, or the central registry.

## Status

- 2026-07-14 `pi_product_docs_transition`: Started the required full documentation and coordination-mailbox read before making product-doc edits.
- 2026-07-14 `pi_product_docs_transition`: Completed a full read of
  `docs/AGENT_COLLAB.md`, `docs/pi-runtime.md`, the current docs/Pi/security/integrator
  coordination mailboxes named in this lane's assignment, and all nine target product documents.
  The shared tree already contains coherent edits from other agents; this lane will append only
  adjacent Pi/schema-2 transition notes and will not normalize, relocate, or replace their work.
- Exact product-doc lease for this pass:
  `docs/{architecture,codex-resources,configuration,control-center,getting-started,maturity,migration,philosophy,runtime-and-git}.md`.
  Notes will distinguish the shipped executable schema-1/Codex contract from the unreleased
  Pi/schema-2 target and link to `../pi-runtime.md`. No central-registry or canonical Pi-document
  edit belongs to this lane.

## Current contract used for this pass

- Schema 1 and the Codex-backed resource/runtime descriptions remain the executable pre-cutover
  contract and the historical-reader contract.
- A successfully migrated schema-2 project has Pi as its only runtime; there is no Codex fallback.
- Pi/schema 2 is not shipped from the current shared source. Release remains gated by the frozen
  host/Rust/CLI/TUI/profile matrix, migration ancestor-symlink/schema-field-only/publication and
  crash-recovery hardening, compiler-issued active-run archival evidence, historical schema-1
  readers, and the current security holds for artifact trust, fail-closed teardown, credential
  intent, protocol/token accounting, and OAuth containment/secrecy.

## Coordination updates

- 2026-07-14 `pi-runtime-security-review/root` added a canonical-runtime security hold while this
  pass was active: fd 3 currently exposes raw OAuth secrets to the Node host while inference has
  broad outbound network, so public-frame/log redaction does not protect credentials from their
  consumer. The target must either put TLS/auth behind a Rust-owned allowlisted proxy so Node never
  receives bearer tokens/general outbound authority, or explicitly classify the pinned host and
  dependency closure as credential TCB with signed provenance. This lane does not own
  `docs/pi-runtime.md`; the exact canonical edit was routed to `primary-integrator/root` and the
  security reviewer, and these product-doc notes continue to label credential/runtime trust as an
  open release gate.
- 2026-07-14 `primary-integrator/root` appended that decision boundary to the canonical Pi
  document and Pi coordination surfaces. This pass then named the same unresolved choice in each
  affected product document: either a Rust-owned destination-allowlisted TLS/auth proxy keeps Node
  outside the credential TCB, or the independently signed/pinned host and dependency closure are
  explicitly treated as the credential TCB. No product note describes raw fd-3 OAuth plus general
  outbound access as a coherent or shipped untrusted-host design.
- 2026-07-14 `primary-integrator/root` asked this lane to absorb two adjacent currentness updates
  while it held the affected product files, avoiding an overlapping edit: `configuration.md` now
  preserves the original boolean-only prepared-source boundary beside the in-progress typed global
  binding/emission/lease-admission contract and its open review/authority/runtime/Software gates;
  `configuration.md`, `getting-started.md`, and `philosophy.md` also preserve their broad active-
  gate snapshots beside a narrowing that closes review-effect P1s, exact pinned-member selection,
  canonical ticket-root evaluation, and same-ticket path separation while retaining cross-ticket
  preparation, Software/Pi matrices, and the final immutable fingerprint as active.

## Handoff

- Status: `complete` — exact product-doc lease released to `primary-integrator/root`.
- Files edited append-only by this lane:
  - `docs/architecture.md`
  - `docs/codex-resources.md`
  - `docs/configuration.md`
  - `docs/control-center.md`
  - `docs/getting-started.md`
  - `docs/maturity.md`
  - `docs/migration.md`
  - `docs/philosophy.md`
  - `docs/runtime-and-git.md`
  - `docs/agent-collab/pi-product-docs-transition.md`
- Verification:
  - `git diff --check --` over the nine product documents: passed with no output.
  - trailing-whitespace scan over the nine product documents and this mailbox: passed with no
    matches.
  - all nine product documents contain a direct `pi-runtime.md` link and explicitly name the
    unresolved credential-TCB boundary.
- Re-read the current tails/deltas of `docs/pi-runtime.md`, `docs-current-audit.md`,
  `pi-runtime-architect.md`, `pi-runtime-security-review.md`, and `primary-integrator.md` before
  handoff. The canonical Pi document now carries the target-not-integrated status, migration
  publication hold, and credential-TCB decision. Historical Codex/schema-1 language in the product
  documents was retained; no normalization or replacement was performed.
- Intentionally untouched: central registry, canonical Pi document, source, configs, profiles,
  tests, binaries, credentials, processes, Git refs, cockpit/cmux, project resources, and every
  live/forensic run. The target files were already heavily modified by coherent parallel work;
  repository-wide diff statistics therefore include changes outside this lane's additions.

## Release-candidate reconciliation follow-up

- 2026-07-14 `pi_product_docs_transition`: Reopened the released nine-document lease after the
  Pi architect and final runtime audit published a later current-source endpoint. Re-read the
  complete central registry, canonical Pi runtime document, architect handoff, final runtime
  audit, and this mailbox before editing.
- The earlier “unreleased,” blocked-cutover, and unresolved-credential-TCB paragraphs remain
  verbatim as causal history. Adjacent supersession notes will identify current source as the
  schema-2/direct-Pi release candidate, with no production Codex fallback.
- The accepted first-cut credential TCB is exact: the Köni Rust binary, bundled Pi host, pinned Pi
  SDK dependency closure (`@earendil-works/pi-agent-core@0.80.7` and
  `@earendil-works/pi-ai@0.80.7`), and official pinned Node 22.19.0 runtime. Node remains outside
  compiler-tool, graph, Git, receipt, and project-filesystem authority.
- The supported networked target is macOS Seatbelt. Linux supports contained non-network probes,
  while login and model inference fail closed until a destination-allowlisted outbound egress
  broker exists.
- Source/release-candidate status does not install a binary, migrate a project, touch credentials,
  or authorize a live acceptance run. Those remain separate guarded operator actions, and the two
  protected forensic Updog runs are never migration or execution authority.
- Exact follow-up lease remains
  `docs/{architecture,codex-resources,configuration,control-center,getting-started,maturity,migration,philosophy,runtime-and-git}.md`.
  Central registry, canonical Pi documentation, source, profiles, binaries, installed projects,
  and run state remain outside this lane.

## Release-candidate reconciliation handoff

- Status: `complete` — the nine-document follow-up lease is released to `primary-integrator/root`.
- Every earlier Pi/schema-2 hold remains verbatim. Adjacent dated notes now supersede stale
  “unreleased,” blocked-cutover, unresolved-TCB, not-shipped, and not-an-installed-capability
  statements with the final source release-candidate contract.
- Every target document independently records the supported boundary: exact pinned Köni Rust +
  host/Pi SDK 0.80.7 + official Node 22.19.0 provider credential TCB; Rust-only compiler/graph/
  receipt/Git/project-file authority; no production Codex fallback; macOS networked support; and
  Linux networked login/inference fail-closed pending destination-allowlisted egress.
- Every target document also keeps release-source status separate from installing, migrating,
  using credentials, or starting live acceptance. Protected forensic Updog state grants none of
  those actions.
- Verification: path-scoped `git diff --check` over all nine product documents passed with no
  output; a trailing-whitespace scan over those documents and this mailbox returned no matches.
  No Cargo/install/migration/live-smoke command was needed or run for this append-only docs pass.
- Intentionally untouched in both passes: `docs/AGENT_COLLAB.md`, `docs/pi-runtime.md`, all source,
  configuration/profile/test files, binaries, credentials, installed projects, processes, Git
  refs, cockpit/cmux, live runs, and both protected forensic Updog run records.
- The central registry's earlier product-doc row still says the lane documented an unreleased
  target. `primary-integrator/root` owns the adjacent central supersession; this lane did not edit
  the registry.
