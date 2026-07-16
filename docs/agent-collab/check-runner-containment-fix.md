# Check Runner Containment Fix

## 2026-07-16 — lease claimed (`check_runner_containment_fix/root`)

Scope is limited to `crates/koni-core/src/process.rs`, directly necessary Core helpers/tests, and
append-only coordination notes. I own `run_attempt`, its pipe readers/termination helpers,
bounded result-document reads, output truncation metadata on `AttemptReceipt`, and deterministic
Unix regressions for descendant containment and noisy output/result files.

Current defects being corrected:

- assigned checks inherit Koni's process group, and timeout/stop kills only the direct child;
- a descendant retaining stdout/stderr can therefore survive and block reader joins forever;
- stdout, stderr, configured result files, classifier concatenation, and JSON candidate collection
  can grow without a Koni-owned bound.

Contract under implementation: each check attempt owns a fresh Unix process group/session;
ordinary completion waits until its owned pipe writers close and reaps the leader, while timeout,
stop, and launch/wait errors terminate the entire owned group with TERM, bounded grace, KILL, and
bounded reap/drain. Stdout and stderr each have independent capture limits, the attempt has a safe
cumulative retained-output limit, result-file reads share the result-document limit, and receipts
retain useful prefixes plus explicit truncation/observed-byte metadata. No live run, cmux, binary,
profile, TUI/CLI, acceptance repository, or installed runtime is in scope.

Status: `in_progress`.

## 2026-07-16 — implementation complete; lease released

The configured-check runner now creates one fresh Unix process group per attempt and drains both
pipes synchronously in nonblocking mode. There are no pipe-reader threads to join. Normal leader
exit allows a short descendant drain, then cleans any remaining same-group helpers; timeout,
stop-file, setup/read/wait error, and post-leader cleanup all converge on TERM, bounded grace,
KILL, bounded group-exit observation, leader reap, and bounded final pipe drain.

Capture/result contracts are now explicit:

- stdout and stderr each retain at most 1 MiB;
- one attempt retains at most 1.5 MiB cumulatively;
- full observed streams are drained and hashed even after retention truncates;
- receipts persist observed bytes, retained bytes, and a truncation bit per stream;
- typed stdout and configured result files are capped at 1 MiB, with file reads limited to cap + 1
  even if the file grows after metadata inspection;
- truncated stdout cannot be parsed as a typed result, and a truncated expected-nonzero attempt is
  inadmissible rather than risking false-red classification;
- protocol line scanning retains only the latest matching value instead of collecting every JSON
  candidate, and infrastructure signature matching no longer builds a second combined lowercase
  output string.

Deterministic regressions prove a descendant that holds both pipes and ignores TERM cannot survive
timeout or stop, a successful leader cannot leave a same-group helper behind, ordinary commands
remain unchanged, noisy stdout/stderr respect both independent and cumulative limits, truncated
stdout results fail explicitly, and oversized result files never become parse candidates.

Verification on the composed shared source:

- `cargo test -p koni-core --lib process::tests:: -- --nocapture` — **24 passed, 0 failed**;
- `cargo clippy -p koni-core --lib --tests -- -D warnings` — **passed**;
- `cargo test -p koni-core --lib --no-fail-fast` — **692 passed, 0 failed, 3 ignored**;
- scoped Rustfmt and `git diff --check` — **clean**.

Documentation sweep: current `docs/AGENT_COLLAB.md`, all mailboxes modified during this lease, and
the command contracts in `docs/{runtime-and-git,configuration}.md` were re-read. Dated transition
notes now sit beside the earlier containment/accepted-exit language; no active cross-domain
question overlaps this source. No live state, binary, runtime bundle, cmux surface, profile,
acceptance repository, Git ref, or installed tool was touched.

Status: `ready_for_integration`; source lease released to `primary-integrator/root`.
