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

## 2026-07-16 — Pi-native compiler lease (`check_runner_containment_fix/root`)

This later lease is independent of the historical Rust check-runner work above. Scope is limited
to `packages/core/src/{compiler,contracts}/**`, focused tests, and this append-only handoff. It
implements the schema-2 rule/ticket compiler and authenticated editable-project source boundary
without editing the root-owned graph model, authority runtime, public package barrel, installed
profile, binary, cockpit, cmux surface, Updog checkout, or live/forensic run state.

The released compiler boundary now provides:

- `GraphExpressionEvaluator` over a minimal `CompilerGraphProjection`, with frozen graph snapshots,
  named queries, traversal/inverse edges, set algebra, quantified predicates, bounded recursion,
  pure field/count/coverage/acyclic/semver/obligation predicates, and an explicit fail-closed
  `RuleDomainAdapter` for dynamic receipt/check/gate/path/filesystem policy;
- `evaluateConfiguredRules`, which applies deterministic derivations before ticket evaluation,
  resolves configured operation/workflow/step contracts, validates DAG dependencies and literal or
  graph-projected scope, and derives stable ticket IDs from rule + sorted targets + source-state key
  + effective configuration hash;
- `resolveCompiledRunType` and `resolveCompiledPersona`, including default-run selection and the
  documented stage > run-type persona > run-type role > persona > agent precedence;
- `projectGraphSchemaDefinition(configuration)`, a direct validated projection into the existing
  `GraphSchemaDefinition` boundary without duplicating or modifying graph runtime ownership;
- `compileProjectDirectory(projectRoot, packageBaseline, options?)`, where `packageBaseline` is a
  mandatory `VerifiedProfileBaseline` from a trusted package resolver. The function reverifies the
  package bytes, requires `.koni/.managed/install.json` to match that exact package/profile/
  compatibility/baseline provenance, reads the current editable tree twice through no-follow
  containment checks, hashes exact current bytes, classifies newly authored YAML/agent/skill/prompt
  resources, rejects symlinks/special files/path escapes/unknown file kinds, ignores only
  `.managed`, `.transactions`, and reserved legacy `runs` state, and feeds the authenticated snapshot
  to `compileProjectConfiguration`. Managed install metadata alone cannot produce an
  execution-authorized configuration. Current authority run state lives under the Git common-dir
  `koni/runs`, outside `.koni`, and therefore never enters the configuration hash.

Focused evidence on the composed shared tree is **16/16 green**:

```text
npx vitest run packages/core/test/project-directory.test.ts packages/core/test/rule-compiler.test.ts --reporter=verbose
```

This covers both frozen profile graph schemas, deterministic Coding and Research tickets,
derivation-to-ticket sequencing, inverse edges/set algebra/vacuous quantifiers/query recursion,
explicit domain adapters, safe projected paths, operation ambiguity, semantic graph-schema
rejection, baseline/editable project compilation, all four authored resource classifications,
compiler-state exclusion, trusted-package and forged-managed-provenance rejection, symlink
rejection, and untracked-kind rejection. The full Core typecheck is green on the final composed
source. During the lease it briefly observed expected mid-patch errors from concurrent non-lease
work in `control-center/input.ts` and `pi/managed-session.ts`; both owners reconciled their own lanes
and no foreign changes were reverted. The production Core TypeScript build is also green. A final
full Core test run passed **145/146**; the sole failure is the concurrently owned
`run-authority-engine.test.ts` timing out at its exact five-second bound, reproducible alone and
reported to root. Compiler-focused evidence is unaffected and no foreign lane was edited.

One frozen Research-profile discovery remains deliberately unmodified outside this lease:
`run-plan-targets` tests `readiness.state` without an explicit `subject: $node`. Query-candidate
filtering binds `$node`, while a leaf defaults to `$target`, so the shipped query likely selects no
ready experiments/ablations. The sequencing regression uses a cloned corrected query to prove the
generic compiler behavior. The Research profile owner should add the explicit subject and recapture
its package manifest rather than baking a special-case default into the compiler.

Status: `ready_for_integration`; compiler lease released to `pi-native-port/root`. Root owns the
public `packages/core/src/index.ts` barrel export.
