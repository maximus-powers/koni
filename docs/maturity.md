# Maturity

Köni is an active pre-1.0 project. Its core graph, run, receipt, process, TUI,
and libgit2 boundaries are implemented and covered by Rust tests, but the
configuration schema and recovery surface are still evolving.

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
- Context packs and core receipts bind current profile, graph, ticket, target,
  output, and command inputs where applicable. Provenance is not yet uniform
  across every custom artifact and third-party receipt type.
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
