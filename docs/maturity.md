# Maturity

The shipping candidate is `@koni/core@1.0.0` plus the Coding and Research profile packages. All of
them are implemented in TypeScript on Pi 0.80.10. Versioned package and profile protocols, and
baseline and overlay upgrades, define compatibility.

## Current candidate (2026-08-20)

| Area                               | Current source                                                                         |
| ---------------------------------- | -------------------------------------------------------------------------------------- |
| Public product packages            | `@koni/core`, `@koni/coding-profile`, `@koni/research-profile`                         |
| Authority implementation           | Pure TypeScript Core                                                                   |
| Runtime compatibility              | Declared Node `>=22.19`; qualified on `22.19` and `24`; Pi `0.80.10`, TypeBox `1.1.38` |
| Credentials and model providers    | Ordinary Pi ownership. Koni has no second login or credential store                    |
| Profiles and project customization | Immutable package baseline plus preserved `.koni` project overlay                      |
| Upstream conflicts                 | Explicit current and upstream comparison with revisioned resolution                    |
| Sessions                           | One immutable linear Pi session per Koni attempt, with explicit attempt lineage        |
| Provider retry policy              | One admitted transport. Zero automatic provider retries                                |
| Operator surfaces                  | Shared `/koni` and explicit `koni tui`. No automatic pane creation                     |
| Release evidence                   | Final immutable composed acceptance is still being assembled. No count is claimed here |

Trusted initialized Pi TUI projects also get `/koni-run`, `/koni-runs`, and an always-visible
read-only widget. Passive attachment cannot start work. Only explicit commands cross the authority
mutation boundary.

The v1 qualification boundary is operator-started autonomous Coding and Research work on trusted
macOS repositories. The qualifying model policy uses `openai-codex/gpt-5.6-luna` with medium
thinking for every persona and no fallback. That fixed policy is release evidence, not a claim that
all Pi providers or models behave equivalently. Pi extensions are trusted user code rather than a
sandbox. Koni's meaningful autonomous effects still pass through compiler grants, durable CAS and
replay checks, contained command execution, and explicit Git transactions.

Within that boundary, autonomous means Koni may schedule and run approved agent work without
step-by-step steering. It does not mean unattended operation. An operator starts the run, answers
material questions, approves the compiled plan, keeps the TUI or an explicit supervision driver
active, handles unknown recovery states, inspects the final receipts and diff, and separately
authorizes promotion.

Use Köni for operator-supervised autonomous work on repositories with good backups and normal review
discipline. Do not treat the current release as an unattended production scheduler, a security
boundary for untrusted code, or a guarantee about a project's methodology or result quality.

## Current capability

| Area                                                          | Status                                 |
| ------------------------------------------------------------- | -------------------------------------- |
| YAML project catalogs and standalone run types                | Implemented                            |
| Typed profile compilation and cross-reference validation      | Implemented                            |
| Multi-run planning, questions, and explicit approval          | Implemented                            |
| Immutable configuration snapshots                             | Implemented                            |
| Graph and rule compilation with deterministic ticket identity | Implemented for the documented rule VM |
| Durable pipelines and restart-safe supervision ticks          | Implemented                            |
| Linked run and ticket worktrees with squash integration       | Implemented                            |
| Command, graph, review, checkpoint, and integration receipts  | Implemented                            |
| Operate and validated Configure TUI                           | Implemented                            |
| Bundled coding and research profiles                          | Implemented and exercised end to end   |
| Always-running daemon or background scheduler                 | Not included                           |

The distinction between "configuration compiles" and "behavior is executable" is important.
Structural validation proves that IDs, references, selectors, workflow graphs, action effects, and
schemas are coherent. A primitive or check kind still needs an engine handler and an executable
acceptance test before a profile should rely on it.

## Known limitations

### Compatibility

- Public package and profile protocols are versioned. Profile upgrades preserve project overlays.
- Pinned run snapshots are immutable. There is no general typed migration for an old active run when
  a newer engine strengthens validation. That run fails closed with its diagnostic.
- Canonical YAML is the only supported authoring format.
- The development dependency audit reports two advisories inside Pi 0.80.10's published shrinkwrap.
  The affected packages are `brace-expansion` 5.0.6 and `protobufjs` 7.6.4.
- npm cannot replace these nested packages without changing the exact Pi runtime. The three Koni
  package payloads do not include Pi or its nested dependency tree.

Pin the Köni version used by CI and long-running projects.

### Scheduling and recovery

- Supervision is a sequence of short explicit ticks. The TUI drives them while open. Otherwise an
  operator or external scheduler must call `supervise-run`.
- Due question defaults also require an explicit tick.
- Manual, handoff, and external-loop stages are intentionally explicit.
- Known interrupted boundaries are reconciled. Not every possible multi-file crash state has an
  automatic repair. Unknown state stops with a recovery diagnostic.
- Semantic forward reversal currently supports tracked state only. Git-common-dir runs are refused
  until product and sidecar reversal can share one proven transaction.

### Containment

- On macOS, configured automatic read-only commands use an exact-path Seatbelt policy with private
  scratch and denied network.
- An equivalent read sandbox is not implemented on every platform. Automatic gate commands fail
  closed where required containment is unavailable. Generic read-only commands rely on mutation
  audit and quarantine, but they cannot prove which files a process read.
- Quarantine restores no external side effects. It requires exact operator restoration of recorded
  filesystem preimages.

Köni should not execute code from an untrusted repository merely because a profile labels the action
read-only.

### Checks and provenance

- Native command and graph checks are implemented. Agent, manual, and composite check declarations
  require an explicit handler or external receipt. One exception applies: a validated opt-in
  `kind: composite` check with `graph_set` has a generic built-in handler. It compiles an exact
  finite step-scoped member set, executes registered read-only child commands, derives non-vacuous
  aggregate readiness, and participates in currentness and composed replay. Profiles that omit
  `graph_set` keep the handler-only or receipt-only behavior.
- Context packs and core receipts bind current profile, graph, ticket, target, output, and command
  inputs where applicable. Eligible graph-forbidden file and check execution packets also bind
  hashes for the complete pre-projection ticket, review history, selected contract set, dependency
  outputs, and prior outputs. Full schema `1.0` packets remain the conservative compatibility path.
  Provenance is not yet uniform across every custom artifact and third-party receipt type.
- Retry policies are bounded. Complex provider-specific backoff and every external failure mode
  remain profile and integration work.

### UI and authoring

- Configure publishes complete validated draft sets. Touched YAML may be normalized, and comments
  are not preserved.
- Resource renames do not rewrite cross-document references automatically.
- The TUI renders the common run, ticket, graph, planning, agent, and report surfaces. It does not
  implement every possible custom report projection or control kind that a profile could describe.
- A configured graph view controls hierarchy and labels. Dense graphs may be better inspected
  through exported reports.

### External providers

- The external-loop state machine and bounded driver interface are implemented. There is no
  background poller.
- Projects must explicitly configure provider adapters and credentials.
- A repair request does not become successful until new work produces and integrates a reviewed
  candidate.

## Platform support

macOS is the supported networked target. Linux login and model inference fail closed until a
destination-allowlisted egress broker replaces the denied network namespace. Installation, OAuth
use, profile updates, and any live acceptance run each require separate guarded authorization. No
existing installed project is refreshed implicitly. Preview a profile update, review its retirement
plan, and apply only with a release that publishes the complete provenance and verification record.

Repository gates run on macOS and Ubuntu with Node 22.19 and 24. This cross-platform matrix covers
compilation, deterministic authority behavior, package installation, TUI components, and the
platform containment boundary. It does not convert Ubuntu into a supported networked inference
target; Linux provider egress remains fail-closed as described above.

## Safety posture

The current safety model is fail-closed:

- Invalid configuration does not partially publish.
- Unverified snapshots do not open as current behavior.
- A model cannot mark its own work accepted.
- Missing receipts do not become inferred success.
- Dirty or unowned Git resources block cleanup.
- Conflicts do not auto-resolve.
- Unsupported recovery does not rewrite history.

These properties reduce accidental damage. They are not a substitute for repository protection,
least-privilege credentials, CI, backups, and human review.

## Validation before adoption

For a serious evaluation:

1. Pin a Köni release and a model policy.
2. Initialize a disposable copy of the repository.
3. Validate the profile and inspect every installed agent and skill.
4. Exercise Small, Medium, and Large runs on representative goals.
5. Interrupt planning and ticket work to test recovery.
6. Inspect branch and worktree ownership, plus squash commits.
7. Verify required receipts independently.
8. Test run deletion in preview and safe modes.
9. Document project-specific recovery and credential policy.

A fresh isolated macOS acceptance run remains an explicit operator action. It is never a guarded
refresh of protected state.
