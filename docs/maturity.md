# Maturity

Köni is an active pre-1.0 project. Its core graph, run, receipt, process, TUI,
and libgit2 boundaries are implemented and covered by Rust tests, but the
configuration schema and recovery surface are still evolving.

> **Pi-native 1.0 maturity supersession — 2026-07-16 (`pi-native-port`):** The paragraph above and
> capability table below describe the frozen Rust product line. The current shipping candidate is
> `@koni/core@1.0.0` plus the Coding and Research profile packages, all implemented in TypeScript
> on Pi 0.80.10. Rust/libgit2 are non-shipping oracle dependencies only. Release remains
> fail-closed until the executable parity ledger has no blockers; after that gate, versioned
> package/profile protocols, guarded legacy migration, and baseline/overlay upgrades—not the old
> pre-1.0 caveat—define compatibility.

Use it today for evaluation, profile development, and supervised work on
repositories with good backups and review discipline. Do not treat the current
release as an unattended production scheduler or a security boundary for
untrusted code.

## Current capability

| Area | Status |
| --- | --- |
| YAML project catalogs and standalone run types | Implemented |
| Typed profile compilation and cross-reference validation | Implemented |
| Native Codex agents, settings, and skill pinning | Implemented |
| Multi-run planning, questions, and explicit approval | Implemented |
| Immutable configuration snapshots | Implemented |
| Graph/rule compilation and deterministic ticket identity | Implemented for the documented rule VM |
| Durable pipelines and restart-safe supervision ticks | Implemented |
| Linked run/ticket worktrees and squash integration | Implemented |
| Command, graph, review, checkpoint, and integration receipts | Implemented |
| Operate and validated Configure TUI | Implemented |
| Bundled software and research profiles | Implemented and exercised end to end |
| Homebrew installation | Prepared, not published |
| Always-running daemon or background scheduler | Not included |
| Stable 1.0 schema/migration guarantee | Not yet |

> **Pi/schema 2 maturity transition — 2026-07-14 (`pi_product_docs_transition`):** The native
> Codex/resource and end-to-end rows above describe the executable schema-1 checkpoints and remain
> valid historical evidence. The direct Pi/schema-2 runtime in
> [Direct Pi runtime](pi-runtime.md) is source-in-progress, not an implemented/shipped row. A
> migrated project will have Pi as its only runtime, but release still requires independently
> trusted runtime artifacts, fail-closed teardown, operation-scoped credential authority,
> and a coherent credential TCB: either a Rust-owned allowlisted TLS/auth proxy or a signed/pinned
> host-plus-dependency closure. Protocol/token/OAuth containment proof, ownership- and crash-safe
> migration with active-run archival, historical readers, and one frozen host/Rust/CLI/TUI/profile
> matrix also remain gates.

> **Release-candidate supersession — 2026-07-14 (`pi_product_docs_transition`):** The preceding
> source-in-progress/undecided status is historical. Current source is the schema-2/direct-Pi
> release candidate for the macOS Seatbelt target, with no production Codex fallback. Its exact
> accepted credential TCB is the Köni Rust binary, bundled Pi host, pinned Pi SDK 0.80.7 dependency
> closure, and official pinned Node 22.19.0 runtime; Node still owns no compiler-tool, graph, Git,
> receipt, or project-file authority. Linux networked login and inference fail closed pending a
> destination-allowlisted egress broker. Installation, migration, credentials, and live acceptance
> remain separate guarded operator actions; protected forensic Updog state authorizes none of them.

> **Current profile-evidence qualification — 2026-07-14:** The Software and
> Research row preserves the end-to-end checkpoint that was true for its
> recorded profile versions. The staged Software 0.4 redesign is not released
> by that row: its expanded semantic matrix, deterministic same-ticket reopen,
> prepared-source authority, direct Pi broker path, final independent design
> review, and one immutable Pi-era integration fingerprint remain separate
> gates. Research retains its own independently executed profile evidence.

The distinction between “configuration compiles” and “behavior is executable”
is important. Structural validation proves that IDs, references, selectors,
workflow graphs, action effects, and schemas are coherent. A primitive or check
kind still needs an engine handler and an executable acceptance test before a
profile should rely on it.

## Known limitations

### Compatibility

- The profile schema and runtime are `0.1.x`; backward compatibility is not a
  stable public API.
- Pinned run snapshots are immutable, but there is no general typed migration
  for an old active run when a newer engine strengthens validation. The run
  fails closed with its diagnostic.
- Canonical YAML is the supported authoring direction. Legacy TOML conversion
  is explicit and should not be treated as a permanent dual-format mode.

Pin the Köni version used by CI and long-running projects.

> **Schema compatibility transition in progress — 2026-07-14 (`pi_product_docs_transition`):**
> Schema-1 snapshots and transcripts remain readable, while new schema-1 execution stops only
> after an explicit successful schema-2 migration. That transaction is not a dual-runtime mode:
> active Codex runs are authoritatively archived and there is no Codex fallback. Until migration
> security/recovery and the frozen matrix are green, schema 1 remains the executable product.

> **Schema-compatibility supersession — 2026-07-14 (`pi_product_docs_transition`):** Migration
> security/recovery, archival, historical readers, and the locked source matrix now pass for the
> release candidate. Fresh schema-2 projects execute Pi; an existing schema-1 installation remains
> on its current executable contract until a separately authorized migration, after which Codex is
> archival history only and cannot be a fallback.

### Scheduling and recovery

- Supervision is a sequence of short explicit ticks. The TUI drives them while
  open; otherwise an operator or external scheduler must call
  `supervise-run`.
- Due question defaults also require an explicit tick.
- Manual, handoff, and external-loop stages are intentionally explicit.
- Known interrupted boundaries are reconciled, but not every possible
  multi-file crash state has an automatic repair. Unknown state stops with a
  recovery diagnostic.
- Semantic forward reversal currently supports tracked state only.
  Git-common-dir runs are refused until product and sidecar reversal can share
  one proven transaction.

### Containment

- On macOS, configured automatic read-only commands use an exact-path Seatbelt
  policy with private scratch and denied network.
- An equivalent read sandbox is not implemented on every platform. Automatic
  gate commands fail closed where required containment is unavailable; generic
  read-only commands rely on mutation audit and quarantine but cannot prove
  which files a process read.
- Quarantine restores no external side effects and requires exact operator
  restoration of recorded filesystem preimages.

Köni should not execute code from an untrusted repository merely because a
profile labels the action read-only.

### Checks and provenance

- Native command and graph checks are implemented. Agent, manual, and composite
  check declarations require an explicit handler or external receipt.
  > **Built-in composite exception — 2026-07-14:** The limitation above remains
  > true for ordinary composite declarations. A validated opt-in
  > `kind: composite` check with `graph_set` now has a generic built-in handler:
  > it compiles an exact finite step-scoped member set, executes registered
  > read-only child commands, derives non-vacuous aggregate readiness, and
  > participates in currentness and composed replay. Profiles that omit
  > `graph_set` retain the earlier handler/receipt-only behavior.
- Context packs and core receipts bind current profile, graph, ticket, target,
  output, and command inputs where applicable. Provenance is not yet uniform
  across every custom artifact and third-party receipt type.
  > **Step-relevant transport — 2026-07-15:** Eligible graph-forbidden
  > file/check execution packets now additionally bind hashes for the complete
  > pre-projection ticket, review history, selected contract set, dependency
  > outputs, and prior outputs. Full schema `1.0` packets remain the conservative
  > compatibility path; provenance outside compiler-owned context/receipts is
  > still subject to the limitation above.
- Retry policies are bounded, but complex provider-specific backoff and every
  external failure mode remain profile/integration work.

### UI and authoring

- Configure publishes complete validated draft sets, but touched YAML may be
  normalized and comments are not preserved.
- Resource renames do not rewrite cross-document references automatically.
- The TUI renders the common run, ticket, graph, planning, agent, and report
  surfaces. It does not implement every possible custom report projection or
  control kind that a profile could describe.
- A configured graph view controls hierarchy and labels, but dense graphs may
  be better inspected through exported reports.

### External providers

- The external-loop state machine and bounded driver interface are implemented.
  There is no background poller.
- Projects must explicitly configure provider adapters and credentials.
- A repair request does not become successful until new work produces and
  integrates a reviewed candidate.

## Safety posture

The current safety model is fail-closed:

- invalid configuration does not partially publish;
- unverified snapshots do not open as current behavior;
- a model cannot mark its own work accepted;
- missing receipts do not become inferred success;
- dirty or unowned Git resources block cleanup;
- conflicts do not auto-resolve;
- unsupported recovery does not rewrite history.

These properties reduce accidental damage, but they are not a substitute for
repository protection, least-privilege credentials, CI, backups, and human
review.

## Validation before adoption

For a serious evaluation:

1. pin a Köni release and Codex model policy;
2. initialize a disposable copy of the repository;
3. validate the profile and inspect every installed native agent and skill;
4. exercise Small, Medium, and Large runs on representative goals;
5. interrupt planning and ticket work to test recovery;
6. inspect branch/worktree ownership and squash commits;
7. verify required receipts independently;
8. test run deletion in preview and safe modes;
9. document project-specific recovery and credential policy.

> **Pi evaluation gate — 2026-07-14 (`pi_product_docs_transition`):** Steps 1–9 remain the
> schema-1 adoption checklist. A schema-2 evaluation must additionally exercise migration
> collision/rollback/crash recovery and historical readers; fake-vault login/logout/refresh and
> operation-scoped credential intent; macOS/Linux containment; artifact trust and rehash-to-exec;
> malformed protocol, cancellation, terminal, secret-redaction, and enforceable token cases; and
> the complete existing compiler/Git/CLI/TUI/profile suites on one immutable fingerprint. The
> active Pi checkout is not yet a guarded-refresh candidate.

> **Evaluation-gate supersession — 2026-07-14 (`pi_product_docs_transition`):** That frozen
> release-candidate evidence now records locked workspace 1,041 passed, 0 failed, 3 intentionally
> ignored; locked clippy and formatting green; Pi host 34/34; the verified pinned runtime bundle;
> and a clean temporary-prefix packaged model probe. It did not install for the user, mutate
> credentials, migrate a project, or exercise a protected forensic run. A fresh isolated macOS
> acceptance remains an explicit operator action, not a guarded refresh of protected state.

> **Evolving to — Software default 0.4.0 (2026-07-14):** Step 4 preserves the original validation
> baseline. After the Evidence-Guided Vertical Delivery profile lands, Software evaluations should
> additionally exercise the inherited New Feature and Bug Fix presets, including scope escalation,
> causal regression proof, structural risk disposition, and exact composed verification. Research
> continues to use its deliberately designed Small, Medium, and Large catalog unchanged. See
> [Software Profile Engineering](software-profile-engineering.md).

> **Software evaluation matrix expanded — 2026-07-14:** “After ... lands” above records the
> pre-implementation checkpoint. The frozen Software candidate now additionally requires causal
> write-capable diagnosis, multi-defect exact coverage, source-only diagnostic/boundary preparation,
> shared-boundary terminal ordering, wrong-objective mitigation rejection, all three proof
> strategies through real compiler/review effects, stale-delivery in-place revision, and real
> broker context -> output -> compile ordering. Release evidence must also include generic
> proof-source/production-path disjointness, cross-ticket preparation source identity, and exact
> review-effect replay provenance; a green happy path alone is not sufficient maturity evidence.

## Pi/schema-2 implementation maturity — 2026-07-14

The direct Pi cutover is now implemented as a source candidate rather than an architecture-only
proposal: production model turns no longer select Codex CLI, provider-neutral schema-2 migration
is transactional, OAuth/model controls exist, the TUI reads the Pi registry, and release layouts
carry the verified host/runtime closure. The prior “source-in-progress” notes remain useful history
but should not be read as saying these components are absent.

Adoption is still pre-release. Focused runtime and migration suites are green, but this shared
worktree contains many parallel changes and needs one final immutable, locked whole-workspace
matrix plus packaged macOS containment/OAuth/inference smoke. Linux inference and login are
explicitly unsupported until a destination-allowlisted egress broker replaces the denied network
namespace. No existing installed project should be refreshed implicitly; use migration dry-run,
review the archive plan, and apply only with a release that publishes the complete provenance and
verification record.

> **Implementation-maturity supersession — 2026-07-14 (`pi_product_docs_transition`):** The final
> immutable locked matrix and packaged temporary-prefix probe are complete, so the source endpoint
> is now the release candidate rather than merely a pre-release implementation candidate. The
> platform and operator limits remain: macOS is the supported networked target; Linux login/model
> inference fail closed until allowlisted egress exists; installation, OAuth use, project migration,
> and any live acceptance run require separate guarded authorization.

## Reporting gaps

Open a focused GitHub issue with:

- Köni version and platform;
- storage backend and run type;
- the exact command or TUI action;
- the validation or recovery diagnostic;
- a minimal sanitized profile or reproduction when possible.

Do not publish credentials, private prompts, proprietary repository content, or
security vulnerabilities. Use the private process in [Security](../SECURITY.md)
for vulnerability reports.
