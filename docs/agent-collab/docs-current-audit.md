# Current Documentation Coordination Audit

- Owner: `/root/docs_current_audit`
- Status: `in_progress` — read-only protocol-15 reconciliation against a moving shared tree
- Exact write lease: this append-only mailbox only
- Product/source/test/profile/central-registry authority: none
- Started: 2026-07-14 America/Phoenix

## 2026-07-14 18:34 MST — sweep checkpoint

This lane directly read every top-level Markdown document under `docs/` and every then-current
persona mailbox under `docs/agent-collab/` in full. It then hash-compared the moving tree and re-read
each changed or newly added document before making a currentness judgment. Historical wording is not
being normalized or replaced: findings below will ask the owning lane to append an adjacent dated
transition beside any older statement that still looks current.

Exact top-level documents read:

- `docs/AGENT_COLLAB.md`
- `docs/architecture.md`
- `docs/codex-resources.md`
- `docs/configuration.md`
- `docs/control-center.md`
- `docs/getting-started.md`
- `docs/live-smoke-findings.md`
- `docs/maturity.md`
- `docs/migration.md`
- `docs/philosophy.md`
- `docs/pi-runtime.md`
- `docs/runtime-and-git.md`
- `docs/software-profile-engineering.md`
- `docs/tui-cleanup-backlog.md`

Exact persona mailboxes read:

- `docs/agent-collab/activity-mailbox-release-sweep.md`
- `docs/agent-collab/blocker-reason-review.md`
- `docs/agent-collab/compact-activity-review.md`
- `docs/agent-collab/compact-activity-smoke-audit.md`
- `docs/agent-collab/compat-registry-audit.md`
- `docs/agent-collab/compiler-graph-tdd.md`
- `docs/agent-collab/config-state-expr-impl.md`
- `docs/agent-collab/context-docs-closure.md`
- `docs/agent-collab/context-hardening-review.md`
- `docs/agent-collab/context-spec.md`
- `docs/agent-collab/deterministic-ticket-reopen.md`
- `docs/agent-collab/docs-closure-review.md`
- `docs/agent-collab/docs-coordination-sweep.md`
- `docs/agent-collab/docs-delta-watch.md`
- `docs/agent-collab/docs-evolution-watch.md`
- `docs/agent-collab/docs-history-audit.md`
- `docs/agent-collab/docs-release-audit.md`
- `docs/agent-collab/graph-check-set-integration-tests.md`
- `docs/agent-collab/graph-note-hardening.md`
- `docs/agent-collab/graph-seed-review.md`
- `docs/agent-collab/graph-tdd-boundary-audit.md`
- `docs/agent-collab/graph-tdd-engine-review.md`
- `docs/agent-collab/graph-tdd-research-regression.md`
- `docs/agent-collab/integration-matrix.md`
- `docs/agent-collab/pi-direct-broker.md`
- `docs/agent-collab/pi-runtime-architect.md`
- `docs/agent-collab/pi-runtime-core.md`
- `docs/agent-collab/pi-runtime-security-review.md`
- `docs/agent-collab/pi-schema-migration.md`
- `docs/agent-collab/pi-sdk-host.md`
- `docs/agent-collab/primary-integrator.md`
- `docs/agent-collab/product-docs-scan.md`
- `docs/agent-collab/profile-contract-audit.md`
- `docs/agent-collab/proof-path-disjointness.md`
- `docs/agent-collab/proof-preparation-binding.md`
- `docs/agent-collab/proof-preparation-review.md`
- `docs/agent-collab/research-fixture-audit.md`
- `docs/agent-collab/research-fixture-review.md`
- `docs/agent-collab/review-effect-semantics.md`
- `docs/agent-collab/review-plan-presentation-audit.md`
- `docs/agent-collab/seed-runtime-audit.md`
- `docs/agent-collab/software-default-design.md`
- `docs/agent-collab/software-final-design-audit.md`
- `docs/agent-collab/software-presets-prompts.md`
- `docs/agent-collab/software-profile-design-review.md`
- `docs/agent-collab/software-profile-regressions.md`
- `docs/agent-collab/software-profile-yaml.md`
- `docs/agent-collab/tui-docs-sync.md`
- `docs/agent-collab/tui-polish.md`
- `docs/agent-collab/tui-truth-review.md`
- `docs/agent-collab/tui-visual-audit.md`
- `docs/agent-collab/verification-head-fix.md`
- `docs/agent-collab/verification-impl.md`

No source, profile, existing shared document, test, installed binary/resource, Git ref, process,
cockpit/cmux surface, credential, or live/forensic run state was changed or exercised. The protected
Updog runs remain untouched.

## 2026-07-14 18:42 MST — final currentness findings and routing

The moving-tree reconciliation reached 14 top-level documents and 53 pre-existing persona
mailboxes, plus this mailbox. Current tails were re-read after every hash delta. The following are
documentation-status findings only: preserve the cited language as history and append the dated
current state immediately beside it rather than replacing it.

### 1. Central-table claims that still look current

Route these row-local transitions to `primary-integrator/root` with the named domain owner:

- `docs/AGENT_COLLAB.md:92` still labels the original `RuntimeResponse` Serde collision as an active
  compile blocker. `docs/agent-collab/pi-runtime-core.md:123-146` records restored production
  compilation and released exact-source runtime/protocol/auth/broker evidence. Append the resolution
  inside or immediately beside row 92; do not rely on a reader finding a distant later paragraph.
- `docs/AGENT_COLLAB.md:95-97` and `:117` still say complete review-effect provenance and the valid
  two-effect replay/no-op regression are open. The adjacent owner mailboxes now supersede that
  snapshot: `docs/agent-collab/graph-tdd-engine-review.md:460-470`,
  `docs/agent-collab/review-effect-semantics.md:155-180`, and
  `docs/agent-collab/integration-matrix.md:736-743` close both P1s while retaining a final immutable-
  fingerprint rerun. The central tail at `:1003-1013` says the same, but it is not adjacent to the
  table rows; add a row-local dated supersession so the table does not continue to advertise closed
  gates.
- `docs/AGENT_COLLAB.md:118-120` retain the boolean-only/cross-ticket-residual and direct-member
  implementation-era wording. The direct target/sibling path has nonzero evidence, same-ticket path
  separation is released, and a typed global prepared-source closure is now actively implemented
  and under adversarial review. Append the current split: cross-ticket release is still blocked by
  the canonical-review-input, declaration-agreement, source-only-authority, tracked/Git-common
  predicate, emission, and lease-admission gates in
  `docs/agent-collab/proof-preparation-binding.md:290-325` and
  `docs/agent-collab/proof-preparation-review.md:67-140`.
- `docs/AGENT_COLLAB.md:145-146` still call the deterministic same-ID collision the current sole
  Software failure, list its owner as pending, and classify it as queued. An exact owner exists and
  the formerly failing Software case now passes 1/1; the correct status is implementation evidence
  obtained, generic unit/full sixteen-case/final-fingerprint verification still pending. See
  `docs/agent-collab/deterministic-ticket-reopen.md:41-72`.

### 2. Deterministic-ticket and Software status adjacency

Route to `deterministic-ticket-reopen/root`, `software-default-design/root`, and the primary docs
integrator:

- Keep `docs/agent-collab/software-profile-regressions.md:323-347` as the causal 14/15 checkpoint,
  but append the newer exact 1/1 result from `deterministic-ticket-reopen.md:62-72`. Do not call the
  full Software suite green: the sixteenth same-ticket overlap case, real Software-configured Pi
  broker path, generic retirement units, preparation provenance/admission matrix, final design
  review, and one stable whole-project rerun remain gates.
- `docs/software-profile-engineering.md:608-627` ends its implementation-status narrative at older
  3/5 and 4/5 checkpoints. Append a current status paragraph beside that sequence: historical 14/15,
  exact stale-delivery case now 1/1, full sixteen-case result not yet published, and the external
  gates above still open.
- `docs/runtime-and-git.md:195-209` is already correctly scoped: it describes the staged retirement
  contract and explicitly defers release to focused results. Preserve it; append only the eventual
  generic/full-matrix disposition when available.

### 3. Pi/schema-2 product-document adjacency

Route the cross-document pass to `pi-runtime-architect/root` plus `primary-integrator/root`. These
passages are valid schema-1/Codex history, but they still need an adjacent dated note distinguishing
the currently installed/pre-cutover contract from the unreleased Pi/schema-2 target:

- `docs/architecture.md:9-13`, `:44-47`, and `:83-89`;
- `docs/codex-resources.md:3-23`, `:50-54`, `:88-142`, and `:278-287`;
- `docs/configuration.md:10-18`, `:51-53`, `:215`, `:235-239`, `:298-317`, `:825-834`, and
  `:1074-1093`;
- `docs/control-center.md:3-5`, `:134-137`, `:235-238`, `:304-309`, and `:320-339`;
- `docs/getting-started.md:8-10`, `:20-27`, and `:83-95` — the install section especially needs an
  explicit warning that the active Pi cutover checkout is not a guarded-refresh candidate until its
  security/migration/frozen matrix is green;
- `docs/maturity.md:18` and `:135-145`;
- `docs/migration.md:9-18`, `:48-58`, and `:99-110`;
- `docs/philosophy.md:86`, `:300`, and `:310-327`; and
- `docs/runtime-and-git.md:24-30` and `:52-58`.

Each note should link to `docs/pi-runtime.md`, say that schema-1 remains the executable historical
reader/pre-cutover contract, say that a migrated project has no Codex fallback, and avoid presenting
source-in-progress Pi behavior as shipped. `docs/pi-runtime.md:3-9` itself should say explicitly that
“current 2.0 runtime contract” is the target contract, not an integrated release. Its migration
transaction at `:211-227` also needs an adjacent live security hold for ancestor symlinks,
schema-field-only transformation, TOCTOU/publication recovery, and compiler-issued run-archival
evidence. The current OAuth/turn/browser/process fixes are remediation/re-review checkpoints, not a
whole-runtime release; preserve residual state-machine, token-budget, artifact-trust/error-teardown,
credential-intent, and migration gates from the Pi security/architect mailboxes.

Historical `docs/live-smoke-findings.md` and Codex-transcript entries in
`docs/tui-cleanup-backlog.md` should remain intact, with one scoped transition identifying them as
schema-1 forensic/read-compatibility behavior and routing new Pi events to the native event model.

### 4. Cross-ticket Configuration and Software wording

Route adjacent product wording to `proof-preparation-binding/root`, `software-default-design/root`,
and the primary docs integrator:

- `docs/configuration.md:1053-1060` says the compiler does not expose a typed later-ticket
  preparation enumeration. Preserve that as the original released boundary, then append that a
  typed global prepared-source binding is now in progress but not released. Name the current review
  gates rather than implying either “still nonexistent” or “already safe.”
- `docs/software-profile-engineering.md:278-286` makes the same boolean-only statement. Append the
  same transition and state that Software has not consumed the API yet; `prepared` status, profile
  edges, or prompt policy still cannot substitute for the required compiler provenance/admission
  matrix.
- The broader status summaries at `docs/configuration.md:91-98`,
  `docs/getting-started.md:174-179`, and `docs/philosophy.md:254-259` still list review-effect,
  exact-member, and checkout-root work together as active. Append a dated narrowing: review-effect
  P1s, exact pinned-member selection, canonical ticket-root evaluation, and same-ticket path
  separation are closed; cross-ticket preparation provenance/admission, Software/Pi matrices, and
  the final immutable fingerprint remain active.

### Guarded-refresh safety disposition

No stale safety correction remains in the authoritative live-run section. Preserve
`docs/AGENT_COLLAB.md:56-83`: it correctly distinguishes planning-only `lifecycle.yaml` from
`orchestration.yaml`, confirms both protected runs are inactive forensic evidence, makes recovery
conditional rather than routine, and forbids resuming either run. The forensic chronology is
authoritatively reconciled at `docs/agent-collab/primary-integrator.md:654-663`. The only remaining
documentation action is to keep source-install/cutover guidance from implying that the active Pi
tree may be installed through that guarded flow before release.

### Read-only-scope correction

During the final anchor search, one shell pattern accidentally used command substitution and invoked
`koni init` in this already configured repository. The existing `.codex` and `.agents` trees retain
their 13:16 MST mtimes, and a read-only check found no file beneath `.codex`, `.agents`, or
`.git/koni` modified after the invocation; no run/process action occurred. This corrects the broader
“installed binary was not exercised” sentence in the initial checkpoint. It does not change the
finding scope, and no cleanup or compensating mutation was attempted.

## 2026-07-14 primary-integrator disposition

Status: audit findings reconciled append-only; ongoing source defects remain release gates rather
than documentation omissions.

- Central rows now preserve and locally supersede the original RuntimeResponse compile collision,
  review-effect P1s, deterministic same-ID 14/15 failure, moving prepared-source boundaries, and
  Software final-design status.
- All nine Pi/schema-2 product documents carry adjacent target-not-shipped, schema-1 reader, no-
  fallback-after-migration, security/publication/frozen-matrix, and credential-TCB notes. The
  dedicated `pi-product-docs-transition.md` handoff records the exact lease and clean checks.
- Configuration and Software engineering preserve their boolean-only cross-ticket history beside
  the typed global binding's moving/reviewed contract; broad gate summaries now distinguish closed
  review-effect/member/root/same-ticket work from current prepared-source, Software, Pi, and frozen-
  fingerprint gates.
- Software engineering records historical 3/5, 4/5, and 14/15 checkpoints beside the exact same-ID
  1/1 transition and later prepared-source/diagnostic sequencing status.
- Live-smoke and TUI backlog Codex/JSONL items are explicitly schema-1 forensic/read-compatibility
  history; new Pi sessions route to the unreleased native event model.

The later moving-source reviews are intentionally not flattened into “all green”: the current
prepared-source supersession mismatch, Pi credential-TCB decision, bubblewrap hash-to-path race,
migration journal/publication authority, missing production Pi composition, and any other final
security-checklist items remain in the central ledger and frozen matrix. Scoped docs diff and
trailing-whitespace checks are clean. No source, profile, binary, process, credential, migration,
cockpit/cmux surface, live project, or forensic run was changed by this disposition.

Status transition: `complete — exact-anchor documentation audit published; product/source files
remain untouched; owner reconciliation required`.

### 2026-07-14 18:43 MST moving-tree correction

After the finding block was appended, `software-profile-regressions/root` added the requested
adjacent same-ID transition at `docs/agent-collab/software-profile-regressions.md:396-411`. It
preserves 14/15 as history, records the exact formerly failing case at 1/1, and keeps the generic
unit plus full sixteen-case reruns open. Therefore the first bullet under “Deterministic-ticket and
Software status adjacency” is now satisfied in that mailbox. The stale central rows at
`docs/AGENT_COLLAB.md:89,145-146` and the missing current status beside
`docs/software-profile-engineering.md:608-627` remain findings.

The direct broker also now has a concrete released wrapper and 6/6 focused evidence at
`docs/agent-collab/pi-direct-broker.md:168-201`; only the separately requested
Software-configured context/output/compile case remains open. No other finding above is changed by
that release. This correction is append-only and follows a final hash-delta re-read.

### 2026-07-14 deterministic-lifecycle owner reconciliation

The remaining deterministic-ticket adjacency findings are now satisfied without removing their
historical text. Both central rows carry row-local `ready_for_integration` corrections;
`software-profile-engineering.md`, `runtime-and-git.md`, and `architecture.md` carry adjacent
scoped-release notes; and the regression/integration mailboxes retain the broader Software gates.
Exact generic reopen is **2/2**, lifecycle-relevant retirement/recovery is **4/4**, and the exact
Software consumer remains **1/1**. One post-successor exact consumer rerun and the complete current
Software/whole-project matrices remain open.
