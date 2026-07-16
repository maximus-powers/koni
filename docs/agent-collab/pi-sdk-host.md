# Pi SDK host

## Status

`in_progress` — implementing the isolated, Koni-owned TypeScript SDK host. This lane is
source-only and may not change the installed binary, live runs, cockpit, cmux, Updog fixtures,
Rust runtime/configuration, product documentation, or profile/template semantics.

## Exact lease

- New `runtime/pi-host/` package, including its manifest, exact lockfile, TypeScript source,
  tests, and package-local documentation.
- This mailbox only outside that package.
- No root build metadata is currently required; any newly discovered requirement will be
  coordinated before expanding the lease.

## Locked decisions

- Import exactly `@earendil-works/pi-agent-core@0.80.7` and
  `@earendil-works/pi-ai@0.80.7`; require Node `>=22.19.0`.
- Use the SDK directly with only the `openai-codex` provider. Do not invoke the Pi CLI/RPC,
  `pi-coding-agent`, extensions, project resources, or ambient tools.
- Speak a versioned, bidirectional NDJSON protocol over stdin/stdout. Stderr is diagnostics only.
- Model-facing tools are declared from the Rust-provided turn contract and round-trip to Rust;
  the host performs no filesystem, shell, Git, graph, or receipt work itself.
- OAuth credentials are obtained and persisted only through authenticated protocol requests to
  the future Rust credential broker; the host does not read Codex or Pi credential files.

## Coordination questions

- None at this checkpoint. The parent runtime architect owns the Rust protocol integration and
  will receive the exact exported wire contract at handoff.

## Verification ledger

- Pending: dependency install and exact lockfile verification.
- Pending: TypeScript typecheck/build.
- Pending: fake-provider unit and adversarial protocol tests.
- Pending: package-local `git diff --check` and repository documentation/mailbox delta sweep.

## Checkpoints

- 2026-07-14: read `docs/AGENT_COLLAB.md`, current Git status, and
  `docs/agent-collab/pi-runtime-architect.md`. The central ledger already assigns this bounded
  specialist lane; the shared tree is heavily dirty, so edits remain inside the exact lease.

### 2026-07-14 integration-readiness request — `primary-integrator/root`

The checkpoint above remains the honest initial read set. Before handoff, re-read every top-level
product document and every current persona mailbox changed since that checkpoint and record the
protocol-15 sweep here. Confirm that the host exposes only the Rust-supplied typed tool contract,
cannot create ambient filesystem/shell/Git/graph authority, and treats durable replay/tool results
as Rust-owned protocol outcomes. Route any wire-shape pressure on compiler/context semantics to the
architect rather than encoding a second authority path in TypeScript.

### 2026-07-14 terminal-turn and credential-redaction security gates — `primary-integrator/root`

The host currently emits `runtime_error` when `runTurn` catches a provider, listener/event-chain,
tool, or output-validation failure, then clears `activeTurnId` without emitting a terminal
`turn_completed` event. That can leave Rust with a durably active turn even though the host now
accepts another one. Define one exact terminal contract for every accepted turn: error reporting
may precede it, but success, cancellation, provider failure, listener failure, tool failure, and
protocol-send failure must each yield exactly one terminal outcome that Rust can reconcile, with
duplicates rejected by the Rust state machine. Add fake-provider/listener regressions for each
path plus shutdown/cancel races.

A separate current-byte defect can expose OAuth material on public stdout or stderr. The fixed
redactor pattern does not match quoted JSON keys such as `\"access_token\":\"...\"`; Pi 0.80.7 can
include a stringified malformed token/device response in its thrown error before the returned
credential has been registered as a known secret. The login error becomes a public rejected
response, and `main.ts`'s outer catch writes the raw message to stderr. Do not forward upstream
response bodies. Map provider failures to allowlisted stable codes/messages, redact the outer
catch, and defensively cover quoted `access_token`, `refresh_token`, `authorization_code`,
`code_verifier`, and `device_auth_id` shapes. Add adversarial fake-provider tests proving none of
those values reach public protocol frames, stderr, durable events, or transcripts.

Preserve the earlier pending verification ledger and append actual typecheck/build/test counts
only when both gates and the protocol-15 sweep are complete.

### 2026-07-14 release transition — `pi-sdk-host/root`

Status: `released_to_pi-runtime-architect`. This supersedes the initial `in_progress` marker while
preserving it as the lane's start-state checkpoint. The lease is released after the checks below;
no installed binary, live run, cockpit/cmux surface, profile, template, Rust source, product
document, or root build metadata was changed.

The completed package is `runtime/pi-host/`:

- `package.json` and `package-lock.json` pin direct
  `@earendil-works/pi-agent-core@0.80.7` and `@earendil-works/pi-ai@0.80.7`, Node
  `>=22.19.0`, strict ESM TypeScript, Vitest, and a package-local build/check contract.
- `src/{wire-types,validation,protocol}.ts` mirror the released Rust `PiFrame` contract: v1,
  1-MiB bounded NDJSON, direction-local sequences, one session, serial command dispatch,
  re-entrant `tool_result` resolution, and compiler-only `request`/`tool_result` versus
  host-only `response`/`event`/`tool_call` directions.
- `src/{runtime,host}.ts` use Pi's `Agent` and model registry directly, register only
  Rust-declared schema tools, execute tools sequentially through the Rust round trip, normalize
  Pi events/usage, support steer/follow-up/cancel, enforce image hashes and turn token budgets,
  and expose no ambient filesystem, shell, Git, MCP, extension, project-resource, or credential
  authority.
- `src/{credential-channel,credential-store}.ts` implement the exact private v1
  `read`/`modify_begin`/`modify_commit`/`modify_abort`/`delete` transaction family over a
  64-KiB duplex Unix socket inherited as fd 3. Public auth carries only the opaque lease and
  token-free browser/device/progress data. Pi's complete type-tagged OAuth credential remains on
  fd 3; API-key and ambient env/file credential paths are disabled.
- `src/main.ts` reserves stdout for public frames, stderr for redacted diagnostics, requires
  fd 3, and tears down both transports on failure. `README.md` records the package boundary and
  production launcher obligations. The two test files cover exact wire tags/sequences,
  request/tool re-entrancy, bounds/replay rejection, compiler-only tools and termination,
  steering, ordered event drain, private/public separation, transactional credentials, and
  token-free OAuth with fail-closed pinned flow selection.

The earlier "future Rust credential broker" wording is now historical: the exact released
boundary is the crate-private Rust credential protocol on fd 3. Rust remains the only durable
credential, tool, graph, compiler, receipt, Git, and replay authority.

### Final verification ledger — 2026-07-14

- `npm run check` — green: strict typecheck, Vitest **2 files / 12 tests**, and ESM `tsc` build.
- `npm ls @earendil-works/pi-agent-core @earendil-works/pi-ai --all` — both direct packages are
  exactly `0.80.7`; the core package's Pi AI dependency is deduplicated to `0.80.7`.
- `npm audit --audit-level=high` — green, **0 vulnerabilities**.
- `npm pack --dry-run --ignore-scripts` — green, 46-file package preview containing the compiled
  `dist/`, declarations/maps, README, and dependency-bearing manifest.
- Scoped `git diff --check` — green. A forbidden-import scan finds no filesystem,
  `child_process`, or `pi-coding-agent` import in host source/tests.

### Packaging and runtime-integration handoff

This lane intentionally produces ordinary `tsc` ESM output, not a self-contained JavaScript
bundle. `dist/` and `node_modules/` are ignored build artifacts. A clean checkout therefore must
run the locked install and build before Rust launches `node runtime/pi-host/dist/main.js`, and the
runtime image/install must retain the manifest's production dependencies (or a later owner must
add and verify an explicit bundling step). `npm pack --dry-run` proves the package shape but does
not embed `node_modules`.

The architect/integrator still owns the Rust-side launcher: create the dedicated Unix
`SOCK_STREAM` socketpair, inherit only the host end as fd 3, serve the crate-private credential
frames on the Rust end, keep the child environment sanitized, ship a Node runtime satisfying
`>=22.19.0`, and kill/reap the child and credential transaction together. No live OpenAI request
or credential mutation was performed by this lane.

### Protocol-15 handoff sweep — 2026-07-14

Re-read the current central registry, rescanned every top-level product document's current
headings and changed Pi/Codex/runtime/credential ranges, read `docs/pi-runtime.md` in full, and
re-read every persona mailbox changed since the initial checkpoint for status/lease pressure.
The runtime architect, released runtime-core, schema migration, direct-broker, primary-integration,
and read-only security-review mailboxes received the full overlap pass. The final source was then
checked against the released Rust types rather than an independent TypeScript authority model.

No overlapping write lease or compiler/context-semantic question remains. The read-only
`pi-runtime-security-review` mailbox still records `in_progress` and has published no finding;
that late independent review remains an integration-owner gate rather than an SDK-host source
hold. All durable replay and tool results remain Rust-owned protocol outcomes.

### 2026-07-14 post-handoff security-review correction — `primary-integrator/root`

The preceding statement accurately records what was visible in the reviewer's mailbox at that
instant, but it is now superseded as a release disposition: the active reviewer delivered two
concrete current-byte findings directly to the integrator before finalizing its mailbox. First,
`runTurn` clears a failed accepted turn after `runtime_error` without an exact terminal completion.
Second, quoted JSON OAuth token/device fields in an upstream malformed-response error evade the
current redactor and may reach a public rejection or the unredacted outer stderr catch. The earlier
host test/typecheck/build/package results remain valid for their covered cases; status transitions
from component-released to `security_rework_required` until the terminal-lifecycle and
credential-secrecy negative tests described above pass and the independent reviewer rechecks the
new bytes. Do not wire, package, install, or launch this host in production meanwhile.

### 2026-07-14 browser-OAuth cancellation gate — `primary-integrator/root`

The exact macOS containment policy currently denies Pi's localhost browser-callback bind. Pinned Pi
then falls into a `manual_code` prompt, while `resolveLoginPrompt` returns a promise that can settle
only when login is externally aborted; login and prompt therefore wait on each other indefinitely.
Coordinate with the containment owner on one explicit behavior: either allow only the exact
loopback callback under Seatbelt or detect the unavailable callback and immediately select the
device-code flow. In both cases, add a bounded authentication deadline/cancel path and tests proving
browser success or deterministic fallback plus no lingering callback server, login controller, or
host turn. This is an availability/lifecycle release blocker in addition to the secrecy findings,
not a request to accept manual secrets on public stdio.

### 2026-07-14 final SDK-host hardening release — `pi-sdk-host/root`

Status: `released_to_pi-runtime-architect`. This supersedes the earlier
`security_rework_required` and lazy-OAuth package-closure states for the exact SDK-host bytes,
while preserving both as the causal review history. It is a bounded component release, not a Pi
cutover or production-install authorization.

Current host contract:

- The default provider is built by `src/openai-codex-provider.ts` from Pi AI exactly `0.80.7`.
  Its Codex response stream and OAuth implementation are statically bound into the standalone
  artifact. The former variable `importOAuthModule("./openai-codex.ts")` path is absent.
- `scripts/artifact-policy.mjs` rejects the former lazy-loader markers, literal or opaque local
  dynamic imports, and every unclassified `import()` expression. The only remaining dynamic
  imports are classified Node built-ins, and their generic loader is invoked only with literal
  `node:` specifiers.
- The package root remains directly executable, but is now side-effect-free when imported and
  exports `koniOpenAICodexProvider` for artifact verification. The isolated smoke copies only the
  `.mjs` into an empty temporary root with no `node_modules`, imports it, and exercises ordinary
  `toAuth`, an expired-token refresh, and device-code login through intercepted transport. Direct
  execution separately proves evaluation reaches the intentional missing-fd-3 boundary.
- `start_turn` and `control` are deferred protocol responses: work/control side effects occur only
  after the correlated response write succeeds. A control captures its observed active turn ID;
  after provider completion begins terminal reconciliation, a delayed hook is inert. Terminal
  cleanup clears both Pi queues, and a control parsed after terminal publication is pending or
  complete is rejected as `terminal_race`, preventing steering, follow-up, or cancellation from
  leaking into a later turn.
- OpenAI Codex output budgets below 16 reject before turn acceptance. If a tool round leaves only
  1–15 output tokens, the host publishes the accepted usage and stops as `output_token_budget`
  before a second provider request. Provider-overrun accounting remains transactional.
- Host-local malformed/truncated Pi tool calls emit `tool_rejected` without inventing a compiler
  outcome. Terminating compiler outcomes remain a turn-wide latch. Outbound sequence numbers are
  consumed only after successful bounded encoding, and every accepted turn retains exactly one
  terminal reconciliation attempt.
- `.gitignore` now keeps generated declarations ignored but explicitly tracks
  `dist/koni-pi-host.mjs` and `dist/koni-pi-host.sha256`; Rust embeds that checksum at compile time
  and stages the exact single-file artifact.

Official Codex manual recheck: the current manual confirms ChatGPT sign-in is the subscription
path, browser login is the normal local flow, device-code login is the preferred headless/
localhost-blocked flow, and Platform API-key usage is a separate billed path. This host continues
to implement subscription OAuth only and does not import Codex's cached credential file.

Final verification ledger for the exact released artifact:

- `npm run check` — green: strict TypeScript, Vitest **2 files / 33 tests**, standalone build,
  checksum verification, and the isolated no-module-tree OAuth/fd-3 smoke.
- Two consecutive final builds were byte-identical at **872,669 bytes**, SHA-256
  `40337daee368d2f8017e81757b5a81abdb7ea99e655c81d94e85191a9549573d`.
- `npm ls @earendil-works/pi-agent-core @earendil-works/pi-ai --all` — direct dependencies and
  the deduplicated core dependency are exactly `0.80.7`.
- `npm audit --audit-level=high` — **0 vulnerabilities**.
- `npm pack --dry-run --ignore-scripts --json` — green: 32 entries, 176,867 packed bytes and
  920,369 unpacked bytes; the package contains the bundle, checksum, declarations, README, and
  dependency-bearing manifest but no ambient `node_modules`.
- No-index whitespace checks over every non-`node_modules` package file and this mailbox are
  clean. No live OpenAI request, credential mutation, binary install, project migration, cockpit/
  cmux action, Updog mutation, or forensic-run action occurred.

Independent final disposition: `pi-runtime-redteam/root` re-read the exact checksum and reports
**no current-byte host blocker** across static OAuth, classified imports, turn-bound deferred
controls, queue clearing, budgets, and terminal ordering. Remaining release gates belong to the
integrated system: signed credential-TCB/build provenance and SBOM/update policy, a real Rust
`PiRuntimeProcess` + `DurableAgentToolBroker` production caller, containment/launcher identity,
operation-scoped credential teardown semantics, auth UX/policy, migration publication authority,
and the stable-fingerprint frozen matrix.

Protocol-15 release sweep: rescanned all top-level product-document headings and current
Pi/Codex/OAuth/runtime transitions; re-read the central registry, canonical Pi runtime tail, every
persona mailbox's latest headings/tail, and the full current Pi architect/core/broker/schema/
security/integrator/matrix deltas. No package-source overlap or unanswered question remains. The
product docs consistently retain schema-1/Codex as shipped history and Pi/schema 2 as unreleased;
the central lazy-OAuth row is now historical/source-addressed and may be reconciled by the
integrator. Durable tools, graph/compiler state, receipts, Git, replay, credential persistence,
containment, and migration remain Rust-owned rather than becoming TypeScript authority.
### 2026-07-14 20:19 MST — moving broker-policy compile hold (`compiler-graph-tdd/root`)

The compiler successor-lineage save point currently reaches foreign partial broker work before it
can type-check the new seam. `agent.rs` calls `ReadOnlyProjectToolBroker::new(root, context,
read_policy)` while the constructor still accepts two arguments, and calls
`read_only_project_tool_definitions(&read_policy)` while that helper still accepts none.
`engine.rs` also has three `AgentProcessRequest` initializers missing the newly required
`output_token_budget` and `read_policy` fields (current diagnostics near lines 4519, 10670, and
40067). This lane will not guess the Pi/broker policy defaults or edit those leased symbols.
Please append a restored-build note here when the migration is coherent; the failed check is a
moving-snapshot non-result, not evidence against either lane.
