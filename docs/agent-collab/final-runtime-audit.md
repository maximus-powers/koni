# Final runtime and release-security audit

- Owner: `final-runtime-audit/root`
- Status: `in_progress` -> `review_complete` — source audit closed; isolated macOS acceptance
  eligible with the evidence qualifications below
- Started: 2026-07-14 America/Phoenix
- Exact lease: this mailbox and one append-only coordination row in `docs/AGENT_COLLAB.md` only.
- Source/profile/test/runtime authority: none. This lane will not edit Rust, TypeScript, YAML,
  tests, installed resources, binaries, credentials, Git refs/worktrees, Updog, cockpit/cmux, or
  live/forensic run state.

## Audit boundary

Reconcile the current shared bytes against the last frozen findings in
`proof-preparation-review.md` and `pi-runtime-security-review.md`, specifically:

1. proof-preparation predicate/global supersession-key equality;
2. bubblewrap verified-identity continuity through execution;
3. schema-2 migration identity continuity through destructive rename/publication;
4. the credential-TCB decision, revoked-intent teardown, and the production
   compiler-grant -> contained Pi process -> fd3 -> durable broker -> terminal receipt path.

Read-only focused tests are permitted only when no competing Cargo/Rust process exists. Findings
will distinguish current source defects, architectural holds, and source-addressed behavior which
still lacks stable nonzero evidence. Historical decisions remain in their owning records; this
mailbox appends the current disposition rather than rewriting them.

## Coordination checkpoint — 2026-07-14

- Read the central coordination protocol/live-run safety and the complete prior proof-preparation
  and Pi runtime security review records before inspecting source.
- Confirmed no active `cargo` or `rustc` process at claim time.
- The protected Updog forensic runs, installed binary, cockpit, and live project are outside this
  lease and will not be touched.

## Current-source reconciliation — 2026-07-14

Audited current fingerprints:

- `engine.rs` `41436b37d63b63fc8dc37c7806a568809ef29d2188507d04e28cc3d984766533`
- `runtime_containment.rs` `ff0c4a82ee98e6a66f39369ca55a86dc34b7b55ccabbfc55a53f0d95361c70d2`
- `schema2_migration.rs` `34b2f5f08242dbda7cc440dae4db39448bed51e9130498a4166b90ed1016254e`
- `pi_credential_service.rs` `a01e2a9262001439743cea5938f0718ddfc0232b46f4d2283f5641dc03b78c5c`
- `pi_runtime_process.rs` `e02037a2dad65dbbab26b5dcdfda7bf5c36392be1303afa534936d97f1f415ae`
- host bundle `257c37416e39db82c65464497305a2e72730cc36ec7d7464f8d5ed3414bbe161`

These match the final endpoint recorded by the Pi architect rather than the older security-review
save point.

### Proof-preparation supersession — source defect resolved

The boolean predicate and global source-lock enumerator now consume the same newest-reviewed
attempt key, `(declared operation registry ID, compiled source node ID)`, before any expected-target
comparison:

- `engine.rs:28105-28180` builds the shared newest-attempt map without a target-universe filter;
- local predicate replay selects that winner at `engine.rs:26262-26287` and only then requires the
  exact target set at `26288-26292`;
- compile-wide predicates consume typed current bindings, including `target_nodes`, at
  `engine.rs:26250-26256` and `27955-27963`;
- global enumeration consumes the same map at `engine.rs:28477-28517`.

The prior old-narrow/new-wide divergence is therefore not present in current source. The focused
test `newest_preparation_attempt_supersedes_before_any_predicate_target_filter`
(`engine.rs:60107-60226`) confirms the newest failed wider ticket remains the shared tombstone,
including historical cutoff/re-review behavior. Evidence qualification: this test constructs the
ticket sequence directly; it does not itself persist a full graph/ticket/receipt sequence or assert
downstream non-emission and global write denial. The released preparation 16/16 and Software 20/20
matrices cover the surrounding consumers, but the exact real persisted two-predicate topology
scenario requested by the original reviewer is still an advisable adversarial regression.

### Linux bubblewrap launch identity — original source-path race closed; stronger same-UID proof absent

Current Linux compilation no longer hashes a packaged launcher and later executes that same
packaged pathname. It discovers only bytes matching the build-embedded digest
(`runtime_containment.rs:369-396`), opens the source with `NOFOLLOW`, copies it into a newly-created
file in the canonical owner-only runtime scratch, applies mode `0500`, fsyncs and re-hashes it
(`227-261`), then uses that staged path (`209-224`, `326-329`). The namespace now uses minimal
`--dev /dev` and network-enabled Linux inference is refused (`203-207`, `273-284`). This closes the
reported mutable-PATH/packaged-source verify-to-exec race for Koni's contained-child threat model.

Qualification: `Command::new` still executes the staged pathname later
(`agent_runtime.rs:421`), and there is no focused `stage_pinned_bwrap`/synchronized-swap regression.
A separate hostile process running as the same Unix UID could replace a `0700`-directory entry
between the staged re-hash and `exec`; Unix mode bits do not isolate processes sharing one UID.
Current contained Koni children cannot reach another runtime scratch, and Linux credential-bearing
network operations fail before spawn, so this is not the original model-write bypass. If the
release threat model promises defense from arbitrary same-UID native processes, the source still
needs descriptor-backed execution (or an independently immutable launcher); otherwise document
that exclusion and retain a Linux package/launcher smoke.

### Schema-2 publication — original ancestor/pathname redirect resolved

`SecureRenameBinding` opens every source/destination ancestor using component-wise `openat` with
`DIRECTORY|NOFOLLOW`, opens the exact source object, pins its device/inode/mode, rechecks the bound
name immediately before `renameat`, fsyncs both already-open parents, and verifies the destination
identity (`schema2_migration.rs:1632-1799`). Every destructive publication edge uses the binding
(`1225-1231`, `1277-1286`, `1334-1337`). The synchronized leaf and ancestor cases at
`3984-4064` prove that a pre-commit leaf replacement is rejected and ancestor substitution cannot
redirect the operation; the forged compiler-journal `.git` sentinel case is at `3925-3981`.
Opaque run-disposition proof retains migration, registry, and per-run authority guards through
`apply` (`143-152`, `174-181`, `283-294`, `592-771`). The prior `fs::rename` after pathname-only
validation defect is not present.

As with any name-based POSIX rename, an arbitrary same-UID native writer can race the final
`statat` and `renameat`; post-move identity checking would detect and attempt to restore that
object. The operation remains confined to the already-open source/destination parents and Koni has
fenced live run writers. This is not a project-symlink escape. Treat defense against a malicious
same-UID external process as an explicit threat-model choice rather than claiming an impossible
inode-conditional POSIX rename.

### Credential TCB, intent teardown, and production composition

- The earlier architectural P0 is decided, not still open: `docs/pi-runtime.md:456-465` and
  `pi-runtime-architect.md:447-475` explicitly place the exact Koni Rust binary, staged Node,
  bundled host/Pi SDK closure, and runtime closure in the first-cut credential TCB. Release
  workflow provenance attestation, exact runtime hashes, lockfile/SBOM validation, packaged
  official Node hashes, and update/package policy now exist. Node remains adversarial for compiler
  tools, graph, Git, and project filesystem.
- Credential mutation is operation-intent scoped. Revocation is observed by a 50 ms private-fd
  read poll and aborts an active transaction (`pi_credential_service.rs:275-333`), while production
  auth and inference paths terminate the one-shot process after each operation. The direct unit at
  `1143-1189` proves the abort primitive. `CredentialIntentGuard::drop` itself still has no wake/
  acknowledgement (`64-71`), so the reusable public process API can return for up to one poll
  interval before service-side abort. A real service-thread timing/next-operation test remains an
  evidence gap; synchronous release-at-return must not be claimed unless an ack is added.
- Real production planning/review and worker call sites now construct `PiRuntimeProcess`; worker
  startup issues and claims the exact compiler grant, binds the contained process identity,
  constructs `DurableAgentToolBroker`, starts the session with only that broker's catalog, requires
  a consumed terminal boundary, revokes the grant, terminates the host, and reconciles durable
  lifecycle state (`engine.rs:50954-51181`). This supersedes “caller missing.”
- The named Software bridge regression is not the full composed proof: it deliberately uses an
  owned `/bin/sleep` child before driving the real durable broker (`engine.rs:77398-77482`). The
  packaged `koni models` smoke proves the contained host/fd3/protocol half but does not exercise a
  compiler grant or terminal broker receipt. No current test found in the tree joins compiler
  grant -> actual contained host -> fd3 intent -> durable broker -> terminal receipt with injected
  failure/cleanup and token-budget cases. A successful fresh Updog Pi run would exercise the real
  production chain, but an automated fake-provider composition regression remains the principal
  release-evidence gap.

## Commands and coordination

- Read-only inspection used `grep`, `sed`, `nl`, `shasum -a 256`, and `git diff --check` only.
- `git diff --check -- docs/AGENT_COLLAB.md docs/agent-collab/final-runtime-audit.md` passed.
- No focused Cargo command was started: `primary-integrator/root` began the one frozen
  `cargo test --workspace --locked --all-targets` run after confirming a free build surface and
  asked this lane not to compete. Its final immutable count/fingerprint will be appended here.
- Central rows `AGENT_COLLAB.md:93-101` still literally report the credential-TCB decision and
  the two races as open. Later product/architect records supersede those snapshots, but the central
  registry needs dated adjacent transition notes rather than silent rewrites. This discrepancy was
  routed to `primary-integrator/root`.
- The same append-only chronology gap remains in `docs/architecture.md:263-275`: its retained
  Pi/schema-2 transition still ends with an unresolved credential-TCB choice and “not an installed
  capability,” while `docs/pi-runtime.md` and `pi-runtime-architect.md` later record the accepted
  first-cut TCB and final release-candidate evidence. The older paragraph is useful discovery
  history and must remain; a dated adjacent release supersession was routed to the product-doc/
  primary owner rather than edited across this lane's lease.
- Coordinated with `updog-smoke-audit/root` so the eventual fresh Medium acceptance run records the
  real compiler-grant -> contained Pi process -> private fd-3 service -> durable broker -> terminal
  receipt and teardown path without inspecting secrets or touching either protected forensic run.
  That owner confirmed in-place schema-2 migration would archive the protected schema-1 records;
  therefore the live proof must use a new isolated clone/current prefix rather than the forensic
  project state. Its checklist now includes a fresh run ID and exact release fingerprint, grant
  claim/revoke, terminal receipt, clean service/host teardown, durable usage reconciliation, and
  sanitized diagnostics only.

## Final disposition — 2026-07-14

The primary integrator's single frozen workspace command completed on unchanged audited bytes:
`cargo test --workspace --locked --all-targets` passed **1,041 / 1,041**, with **0 failed** and
**3 intentionally ignored**. The reported partition is CLI 66, core 573 plus 3 ignored, graph 6,
Research 3 + 4 + 20 + 4, lifecycle 49, Software 20, Updog 2, and TUI 294. The engine remained
`41436b37d63b63fc8dc37c7806a568809ef29d2188507d04e28cc3d984766533`; containment remained
`ff0c4a82ee98e6a66f39369ca55a86dc34b7b55ccabbfc55a53f0d95361c70d2`; migration remained
`34b2f5f08242dbda7cc440dae4db39448bed51e9130498a4166b90ed1016254e`. The integrator also reported
unchanged Software, CLI, template, and lockfile fingerprints and a clean repository diff check.
This lane did not start a second Cargo process.

### Current release-security verdict

No definite P0/P1 source blocker from the frozen proof-preparation or Pi security reviews remains
for the documented **macOS networked runtime boundary**:

- proof predicates and global preparation authority now share one supersession selector before
  target comparison;
- migration publication is descriptor-relative, no-follow, identity-bound, and swap-tested;
- bubblewrap is no longer executed from the previously verified mutable packaged source; it is
  copied and re-hashed in owner-only runtime scratch, and Linux credential-bearing network work is
  refused before launch;
- the credential architecture now explicitly trusts the exact signed/pinned Koni Rust + Node +
  host/Pi SDK/runtime closure for provider credential handling while retaining compiler, graph,
  Git, and project-filesystem authority in Rust;
- production planning/review and worker paths really use the contained Pi process and durable
  compiler broker, and the frozen workspace matrix covers their component contracts.

This verdict authorizes the primary integrator to proceed to a **fresh isolated macOS acceptance
run**, not to reinterpret, migrate, archive, resume, or otherwise mutate either protected Updog
forensic run. Linux login/inference remains deliberately unsupported until an allowlisted egress
broker exists.

### Evidence and threat-model qualifications retained

1. No automated test yet joins the actual contained host and private credential service to a real
   compiler grant, durable broker terminal receipt, teardown, failure path, and token reconciliation
   in one scenario. The fresh isolated Updog run will provide production-path evidence; a fake-
   provider composed regression should still be added for repeatable CI coverage.
2. The proof-preparation regression directly constructs tickets. A persisted graph/ticket/receipt
   two-predicate adversarial case that also asserts downstream non-emission and global write denial
   remains desirable, even though the shared selector and full matrices are green.
3. Revocation aborts active credential transactions within the documented poll bound, but no real
   service-thread regression proves abort acknowledgement and immediate next-operation behavior.
   Production processes are one-shot and terminated after each operation; do not claim a stronger
   synchronous release-at-guard-drop contract without that test or an acknowledgement channel.
4. A hostile arbitrary native process under the same Unix UID could still race a staged pathname
   between re-hash and `exec`. Current containment excludes Koni child access to sibling scratch and
   Linux networked credential operations fail closed. If defense from arbitrary same-UID native
   code becomes a promised boundary, use descriptor-backed execution or independently immutable
   launcher identity and add a synchronized staged-swap test.
5. Several product-doc transition notes still described Pi/schema 2 as unreleased after the
   architect's final release checkpoint. Their owner was reactivated for an append-only
   supersession pass; the historical paragraphs must remain as causal design history.

Accordingly the final classification is **source-security review complete; fresh isolated macOS
acceptance eligible; composed live proof and the explicit hardening regressions above still to be
captured**. No install, credential operation, migration, containment launch, project mutation,
cockpit/cmux action, or live/forensic run mutation was performed by this audit lane.
