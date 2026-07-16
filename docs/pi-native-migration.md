# Pi-native session, resource, and authentication migration

Status: accepted target architecture; implementation is staged and compatibility-gated.

Decision date: 2026-07-16.

This decision evolves the direct-Pi architecture documented in
[Direct Pi runtime](pi-runtime.md). It does not erase that implementation history. The current
host deliberately uses the low-level Pi `Agent` and a Koni-owned event/session/auth layer. The
target adopts Pi's higher-level session, resource, extension, native-chat, and authentication
primitives while preserving Koni's compiler-authoritative Rust core.

## Decision

Pi becomes Koni's conversation, model-execution, resource, extension, native-chat, and provider-
authentication substrate. Rust remains the only authority for workflow state and meaningful
effects.

```text
Interactive Pi session chosen by the operator
└── @koni/pi
    ├── trusted Koni extension
    ├── native commands, status, semantic tools, and renderers
    ├── Pi-owned authentication and conversation session
    └── versioned client for the Rust control core

Contained autonomous Pi session per compiler assignment
└── exact immutable AgentLaunchSpec
    ├── createAgentSession() with a run-local SessionManager
    ├── one explicit Koni extension factory
    ├── one compiler-issued resource set
    ├── Rust-backed tools only
    └── Pi-owned auth capability with no ambient credential-file access

Authoritative Rust core
├── profile, graph, configuration, and ticket compiler
├── workflow readiness, scheduling, and max_parallel
├── immutable grants, CAS/replay, receipts, and recovery
├── questions, approvals, pause/resume/cancel/delete
├── worktrees, Git integration, conflict tickets, and merge
└── durable state and compatibility projections

Optional standalone interface
└── koni tui [--root <path>]
```

The installed extension and the autonomous runner may share typed extension/tool-client code, but
they are different trust contexts:

- The installed extension is an interactive operator interface in the user's chosen Pi session.
- An autonomous assignment is a contained session assembled only from an immutable Rust-issued
  launch specification.

The extension never opens a terminal, cmux, tmux, a pane, or the Rust TUI. The user alone decides
where to run `koni tui`.

### Alternatives rejected

- Replacing Koni with an unstructured Pi extension would move workflow authority out of the typed
  compiler and discard Koni's central product boundary.
- Keeping only the low-level `Agent` forever would preserve safety but continue duplicating Pi's
  sessions, resources, compaction, branching, native chat, and lifecycle code.
- Treating an extension hook as the permission layer is unsafe because extensions execute with the
  user's permissions and are not a sandbox.
- Sharing one autonomous Pi conversation tree per ticket would mix planner/worker/reviewer and
  rework grants; the attempt-scoped session design below avoids that authority bleed.
- Mounting the complete Pi agent directory into every sandbox would turn ambient credentials,
  settings, extensions, packages, and sessions into assignment inputs.
- An immediate in-place cutover would strand or reinterpret active runs; run-pinned runtime and
  conversation versions are required.
- Keeping Rust as the permanent provider-secret store would miss the corrected product direction
  and preserve two unrelated authentication experiences.

## Authority boundary

Pi may own:

- `AgentSession` lifecycle, provider streaming, steering, follow-ups, and conversation branching;
- Pi `SessionManager` conversational persistence and compaction;
- `AuthStorage` and `ModelRegistry` provider authentication and request credential resolution;
- explicit resource loading, extension commands, model-facing tools, and renderers;
- construction and supervision of a model session after Rust authorizes the exact assignment; and
- the incremental native Pi chat/status experience.

Rust continues to own:

- configuration and profile compilation;
- graph schemas, nodes, edges, rules, validation, and graph mutations;
- ticket derivation, dependencies, stage transitions, and scheduling;
- `max_parallel`, assignment selection, launch admission, and attempt identity;
- grants, expected-state hashes, replay protection, CAS, receipts, and verification;
- questions, approvals, plan state, pause/resume/cancel/delete, and recovery;
- branches, worktrees, integration, conflicts, and merges; and
- all durable workflow state.

A Pi extension is presentation and client code, not an authorization boundary. Extension hooks,
prompts, hidden messages, and tool interception may improve UX but cannot authorize an effect.
Every meaningful model-facing request still enters the Rust durable broker and is checked against
the immutable assignment grant.

## Exact pinned Pi 0.80.7 audit

The audit used the exact npm artifact
`@earendil-works/pi-coding-agent@0.80.7`, whose packed tarball SHA-256 was
`c010db218d57d561765651bf42ec13adc22736693880b46cf1919b9bfc260ab3`. Koni currently pins only
`@earendil-works/pi-agent-core@0.80.7` and `@earendil-works/pi-ai@0.80.7`; adopting the APIs below
requires adding and pinning `pi-coding-agent` explicitly. A later Pi upgrade is a separate reviewed
change, not an assumption made from latest documentation.

| Capability | Exact 0.80.7 API | Migration consequence |
| --- | --- | --- |
| Higher-level agent | `createAgentSession()`, `AgentSession` | Available and suitable for one controlled assignment. |
| Runtime replacement | `AgentSessionRuntime`, `createAgentSessionRuntime()` | Useful for native interactive resume/new/fork; not required for the first single-assignment runner. |
| Conversation store | `SessionManager`; JSONL session version `3` | Stores full messages, model/thinking changes, compaction, branches, and custom entries. |
| Resources | `ResourceLoader`, `DefaultResourceLoader` | Autonomous sessions must inject a minimal custom loader, not use ambient defaults. |
| Extension loading | async `ExtensionFactory`; inline extension factories | The exact trusted Koni extension can be loaded programmatically. |
| Tools and rendering | `registerTool`, `registerMessageRenderer`, `registerEntryRenderer` | Rust-supplied schemas can be registered and results rendered semantically. |
| Session lifecycle | `prompt`, `steer`, `followUp`, `abort`, `waitForIdle`, `dispose` | Replaces Koni's manual queue/lifecycle emulation after parity. |
| Compaction | `session_before_compact`, `session_compact`, `context` hooks | Supports a Koni structured summary plus authoritative context reissuance. |
| Authentication | `AuthStorage`, exported `AuthStorageBackend`, `FileAuthStorageBackend` | Pi can be the canonical credential owner, including a Koni-hardened Pi-side backend. |
| Models | `ModelRegistry` | Resolves built-in models and request auth; autonomous sessions should use an in-memory registry with a sanitized environment. |

The exact pin does **not** export a symbol named `ModelRuntime`. Current Pi documentation may use
that newer term, but implementation against 0.80.7 must use `AuthStorage` plus `ModelRegistry` and
the exact interfaces above.

### Safe autonomous construction

`createAgentSession()` has permissive defaults: absent an explicit allowlist, it enables built-in
read/bash/edit/write tools; absent a `ResourceLoader`, it performs normal Pi resource discovery;
absent an explicit `SessionManager`, it writes to Pi's default project session location. Koni must
therefore set every security-relevant input explicitly.

An autonomous construction must use all of the following:

- `noTools: "all"` and an exact allowlist containing only Koni Rust-backed tools;
- a minimal custom `ResourceLoader` that returns only the trusted inline Koni extension and the
  compiler-issued, hash-bound skills, prompts, context files, and system prompt;
- no default extension, skill, prompt-template, theme, package, `AGENTS.md`, or project discovery;
- `SettingsManager.inMemory()` or an equivalent explicit settings object;
- `ModelRegistry.inMemory(authStorage)` with the exact compiled provider/model selected;
- one exact thinking level, with no autonomous model cycling;
- a Rust-created and validated run-local `SessionManager` directory;
- a sanitized process environment, with no provider API-key environment fallback;
- no shell, filesystem, Git, network, MCP, project-extension, or project-prompt tool; and
- the exact launch-spec and resource/context hashes in session custom entries and Rust state.

Using `DefaultResourceLoader` with every `no*` option is still less auditable than a minimal custom
loader. The custom loader is the required default for autonomous sessions.

### Authentication behavior in the exact pin

`AuthStorage.create()` defaults to `~/.pi/agent/auth.json`. Its request-auth priority is runtime
override, stored API key, stored OAuth with locked automatic refresh, then environment fallback.
`AuthStorage.login(providerId, callbacks)`, `logout()`, `getAuthStatus()`, and `getApiKey()` are
available. `ModelRegistry` consumes the same storage and reports provider auth status without
returning credential values.

The stock `FileAuthStorageBackend` does use `proper-lockfile`, including a cross-process lock held
across OAuth refresh. It creates the parent/file with `0700`/`0600` modes. It does **not** perform
a durable atomic replacement: it rewrites `auth.json` in place with `writeFileSync`, without a
temporary-file rename and directory fsync. A crash can therefore truncate or corrupt the canonical
credential file.

The root package exports `AuthStorageBackend`, and `AuthStorage.fromStorage()` accepts it. Koni can
provide a Pi/Node-owned hardened backend that preserves Pi's format and `proper-lockfile` lock
convention while adding bounded reads, no-follow/type/owner checks, temporary-file fsync, atomic
rename, and directory fsync. Interoperability with an ordinary Pi 0.80.7 process must be proven;
otherwise two applications sharing the path could use incompatible locking. Upgrading to a Pi
version that supplies equivalent guarantees is also valid after its complete compatibility matrix
passes.

## Current Koni implementation audit

The migration is warranted by concrete duplication in the present boundary:

- `runtime/pi-host/README.md` intentionally excludes `pi-coding-agent`, Pi sessions, extensions,
  project resources, and ambient tools.
- `runtime/pi-host/src/runtime.ts` constructs a raw low-level `Agent`, keeps a manual in-memory
  `SessionRecord`, implements turn/queue/control behavior, and normalizes Pi events itself. It emits
  completed messages for Rust but has no Pi `SessionManager` transcript.
- `runtime/pi-host/src/credential-store.ts` implements Pi AI's lower-level credential interface
  over a private fd-3 service. `pi_credentials.rs`, `pi_credential_service.rs`, and `pi_auth.rs`
  make Rust the current provider-secret persistence and mutation authority.
- `agent_runtime.rs` has useful provider-neutral session, tool, control, lifecycle, and usage wire
  types, but `RuntimeSessionRef` does not yet bind a conversation-format version, Pi session file,
  resource manifest, launch spec, or nonsecret auth generation.
- `pi_runtime_process.rs` supplies valuable process containment, artifact identity, bounded
  protocol supervision, and teardown. Those controls should wrap the new session runner rather
  than be discarded.
- `agent_tool_broker.rs` already makes Rust the canonical tool-schema and durable grant/CAS/replay
  authority. The Pi extension should adapt to it, not replace it.
- `engine.rs` launches one contained raw Pi process per direct assignment and stores normalized
  JSONL. It also deterministically chooses most Lead boundaries before spending a Lead turn to
  call the already-selected operation.
- `control.rs::AgentSessionRecord` still carries the compatibility field `codex_session_id` and
  paths to Koni-authored stdout/stderr/output records rather than a versioned Pi session binding.
- `koni-tui/src/agent_chat.rs` explicitly implements a custom Codex-inspired renderer by
  reconstructing chat blocks from transport JSONL. It should retain that parser for old runs while
  new runs consume Pi session entries.
- `koni-cli/src/main.rs` opens the cockpit by default and has a `cockpit` subcommand, but does not
  expose the required explicit `koni tui` subcommand.
- `koni-cli/src/agent_mcp.rs` remains a legacy transport adapter. Its underlying durable broker
  behavior is still useful; the executable MCP topology can retire only after compatibility gates.

This audit argues for adapters and versioned run metadata, not a wholesale rewrite. The existing
Rust broker, process identity, containment, receipts, recovery, and TUI remain mature assets.

## Credential and authentication decision

Pi is the canonical provider-credential and authentication authority wherever Pi supports the
selected provider. Rust must not persist or receive provider access tokens, refresh tokens, API
keys, authorization codes, PKCE verifiers, or full credential documents in the target design.

Rust may store only:

- provider and exact compiled model identity;
- a nonsecret opaque account binding generated inside the Pi credential service;
- a nonsecret auth-generation/fingerprint value;
- a capability status such as configured, expired, revoked, or migration-required; and
- compatibility-migration state.

The account binding must be a local one-way digest, not an email address or reversible provider
account identifier. A launch specification binds provider/model plus this opaque account/auth-
generation fingerprint. If the binding changes before a provider request, the session fails closed
and asks Rust to reauthorize; it does not silently switch accounts.

### No ambient credential-directory mount

Making Pi authoritative does not mean binding all of `~/.pi/agent` into every autonomous sandbox.
That directory can contain credentials, sessions, settings, extensions, packages, prompts, and
other ambient authority.

The preferred production boundary is one supervised Pi-owned credential service/backend in the
credential trusted computing base. It owns the canonical Pi `AuthStorage`, locking, refresh, and
login/logout lifecycle. A contained session receives only a private, launch-bound auth capability
for its exact provider/account generation. It gets no credential pathname and no filesystem tool
or mount capable of opening the store. The trusted Pi session host necessarily sees the ephemeral
request credential required to call the provider, but the model and its tools do not.

An exact auth-path capability inside a separately contained, pinned session host is an acceptable
fallback only if the sandbox exposes the minimum file-and-lock operations, never the complete Pi
agent directory, and the host is explicitly part of the credential TCB. The shared supervised
service is preferred because it centralizes refresh locking and avoids per-session file access.

### Guarded legacy import

Koni's existing Rust-owned credential file and fd-3 broker are transitional compatibility seams.
They remain available only for runtime generations that require them and until a guarded import is
complete. They are not a permanent second source of truth.

The migration transaction is:

1. Inspect only token-free status and compute nonsecret account fingerprints inside the credential
   TCB.
2. If Pi and Koni stores name different accounts, refuse automatic migration and require an
   explicit user choice.
3. Freeze legacy refresh/write authority for the selected account.
4. A short-lived trusted Pi-side migrator reads the legacy file and commits through Pi
   `AuthStorage`; credential bytes never cross Rust or public stdio.
5. Reopen a fresh Pi process, verify provider status and the same nonsecret account/generation
   binding, and exercise refresh with a fake or safely expiring test credential in automated
   coverage.
6. Record the migration receipt and disable legacy fallback for that binding.
7. Delete the old Koni credential only after explicit confirmation or a separately documented
   retention window. Install, status, upgrade, and project initialization never delete it.

There must never be two refresh writers for the same OAuth credential. On failure, leave the old
store untouched and the Pi store either unchanged or transactionally rolled back. Legacy fallback
may resume only under its pinned compatibility runtime, never after a successful Pi-authority
receipt for the same binding.

## Immutable `AgentLaunchSpec`

Rust schedules work by issuing a versioned, immutable launch specification. At minimum it contains:

- launch-spec version and hash;
- run, ticket, step, agent, attempt, and Pi session identities;
- initial conversation branch epoch and branch-capability binding;
- runtime/session format versions and the exact pinned Pi package/artifact identity;
- persona, exact instructions, model, thinking level, and output contract;
- exact Rust-owned tool definitions and their catalog/schema hash;
- terminal-boundary tool set;
- exact resource identities, content hashes, and ordered manifest hash;
- bounded graph/context references, context hash, and reissue policy;
- grant ID/hash, expected compiler state/CAS hash, and broker/session identity;
- token, retry, wall-clock, transcript, and context budgets;
- run-local session/transcript locator and containment policy hash;
- provider/model plus nonsecret auth capability/account-generation binding; and
- the only allowed terminal structured result variants.

Rust persists the launch admission before starting Pi. The runner verifies the complete hash,
constructs exactly one session, writes a non-context custom session entry binding the launch spec,
and reports the actual Pi session ID/path back to Rust. A resumed session must match every immutable
binding; a mismatch creates a guarded recovery state rather than a best-effort continuation.

## Scheduling: Rust spine, Pi leaves

Rust, not a Lead model, must:

1. derive ready tickets and steps;
2. choose exact assignments under `max_parallel`;
3. durably journal launch intent;
4. issue immutable launch specs;
5. ask the Pi supervisor to create those sessions;
6. consume terminal structured results;
7. compile, verify, and persist receipts; and
8. schedule the next ready batch.

The current engine already deterministically chooses `DispatchBatch`, `WaitWorkers`, `Recover`,
`SpawnWorker`, `Review`, and `Finish` boundaries before launching most Lead turns. Those rule-
complete choices should execute directly from Rust with the same journals, replay rules, and pause
gates. A Lead remains useful for ambiguous recovery, qualitative judgment, plan synthesis, user
steering, and semantic review. It is not a model-powered courier for a command the compiler has
already selected.

The TUI may retain a stable semantic Lead row even when no Lead model process is live. It must
distinguish orchestration availability from token-spending agent liveness.

## Graph-native Pi interface

The extension should expose semantic Koni actions rather than a generic shell. Candidate tool
families are:

- `koni_graph_context`
- `koni_ticket_context`
- `koni_propose_graph_delta`
- `koni_record_note`
- `koni_ask_question`
- `koni_submit_output`
- `koni_submit_and_compile`

Names and exact schemas remain Rust-owned. The extension fetches a versioned schema catalog during
its bounded handshake and registers those schemas; it does not maintain TypeScript copies. Tool
execution forwards the exact call to Rust. Semantic renderers may show typed nodes, relationships,
compiler decisions, diffs, receipts, and concise validation failures, but rendered UI never changes
the authoritative outcome.

For native read/edit/search presentation, first investigate Pi's injectable built-in tool
operations at the exact pinned version. Reuse their presentation only if every operation routes
through the Rust grant broker. Never enable Pi's ambient filesystem implementation to obtain its
renderer.

## Resources and context

`.koni/agents`, personas, run types, and compiled project configuration remain canonical. Pi does
not gain a second configuration authority under `.pi`.

- Skills contain reusable persona/domain procedures with progressive disclosure.
- Prompt templates contain operator-invoked macros and intake workflows.
- Extension commands contain stateful operator actions such as start, pause, approve, revise,
  inspect, merge, and delete.
- Extension tools contain structured model actions against Rust.
- Context hooks reissue bounded compiler-authoritative graph/ticket context.
- Session custom entries carry UI/audit annotations that must not enter model context.
- Custom messages are used only for information deliberately entering model context.

Every autonomous resource has an identity and content hash in the launch spec. Ambient Pi discovery
cannot alter an already-issued attempt. A resource update affects only a newly compiled attempt.

The `context` hook may reintroduce exact bounded context after compaction, restore, or before a
provider turn. It must fetch or validate that context against Rust and fail closed on a hash/state
mismatch. A summary is advisory memory; it never replaces the graph, grant, receipts, or expected-
state hash.

## Sessions, transcripts, and compaction

Pi session JSONL becomes the canonical conversational transcript for new session-version runs.
Rust stores the Pi session ID and validated locator, launch/resource/context hashes, run/ticket/
agent/attempt mapping, usage totals, lifecycle status, terminal outcome, and receipt references.
Rust workflow state remains authoritative even if a transcript is missing or damaged.

Pi `SessionManager` version 3 preserves complete assistant messages, tool calls/results, model and
thinking changes, branches, compaction entries, and custom entries. New run-local session paths must
be owner-only, symlink-safe, bounded, and registered by Rust before launch. Because Pi's session
file is conversational rather than transactional workflow state, a partial final JSONL line after a
crash can lose chat detail but cannot authorize or roll back an effect.

The Rust TUI should consume a bounded compatibility projection:

- new runs: parse the registered Pi session JSONL and render full native message/tool semantics;
- old runs: continue parsing Koni's existing transport-event JSONL; and
- mixed upgrade state: choose by the run-pinned conversation-format version, never by guessing.

Keep the existing runtime event journal for lifecycle, usage, partial-stream diagnostics, and old
run compatibility until transcript parity and crash tests pass. Stop reconstructing completed chat
from lossy generic events once the Pi-session projection is proven.

The Koni compaction hook produces a concise structured summary containing:

- objective and approved plan;
- ticket and current step;
- graph nodes and relationships touched;
- files read or modified;
- receipts and checks;
- unresolved questions; and
- the next required action.

The hook stores stable references and hashes in `CompactionEntry.details`. After compaction, the
context hook reissues current authoritative context from Rust. Compaction token use is accounted
like any other provider use, and compaction may not silently alter a grant or expected-state hash.

## Session trees, branches, and attempt authority

Pinned Pi 0.80.7 represents one session as an append-only tree. Every entry has `id` and
`parentId`; `SessionManager` tracks one current leaf. Its exact APIs include `getTree()`,
`getBranch()`, `getChildren()`, `getLeafId()`, `branch()`, `branchWithSummary()`, `resetLeaf()`, and
`createBranchedSession()`. `AgentSession.navigateTree()` changes the active path in the same file
and can summarize the abandoned suffix. `AgentSessionRuntime.fork()` creates a new session file
containing the selected root-to-leaf path and records the previous file as `parentSession`.
Compaction and branch-summary entries may carry extension details; custom entries persist Koni UI/
audit data without entering model context.

These primitives are conversational. They do not by themselves define which branch may exercise a
Koni grant. Rust must add that authority.

### Mapping

Use one Pi session tree per immutable **agent assignment attempt**, not one shared session per
ticket.

```text
run
└── ticket
    └── step
        ├── attempt 1 / AgentLaunchSpec 1
        │   └── Pi session 1
        │       ├── branch epoch 1: initial conversation (abandoned or sealed)
        │       └── branch epoch 2: user-directed revision (active or sealed)
        ├── attempt 2 / AgentLaunchSpec 2 (rework)
        │   └── Pi session 2
        └── reviewer attempt 1 / AgentLaunchSpec 3
            └── Pi session 3
```

The durable mapping is:

| Koni identity | Pi identity | Cardinality and rule |
| --- | --- | --- |
| Run | many ticket/step assignments | Run owns scheduling and aggregate lifecycle only. |
| Ticket | many step/role attempts | A ticket view groups related sessions; it does not share their context or grants. |
| Step + persona + attempt | one `AgentLaunchSpec` | This is the immutable authorization boundary. |
| `AgentLaunchSpec` | one Pi session ID/file | Multiple turns and safe conversational branches may live in this tree. |
| Pi session | one current Koni branch epoch | Pi's leaf is observed state; Rust's epoch record is authoritative. |
| Rework/retry with new authority | new attempt and new Pi session | Never revive an old grant by navigating an old tree. |
| Reviewer or qualitative Lead | separate attempt/session | Never make a reviewer a branch of the worker it evaluates. |

A terminal output or plan-candidate submission closes its immutable launch attempt. No in-file
navigation can reopen it. Any revision after that boundary is a new launch spec, attempt, session,
grant, and call-ID namespace, even when the new session reuses a reviewed conversational prefix.

Steering and follow-up continue the current branch; they do not create branches. An in-file branch
is only for an explicit conversational alternative while the same attempt is still live and before
terminal compiler submission. Reviewer failure, implementation or plan rework after terminal
submission, retry after a terminal failure, changed persona/step/worktree/resources/model/context
authority, or a new grant always creates a new attempt/session.

`AgentSessionRuntime.fork()` and `createBranchedSession()` copy conversational history into a new
session file. They never carry Koni authority. The preferred autonomous rework session starts clean
with a new launch spec, a `parentSession`/Koni lineage reference, and a fresh compiler-issued
context. A guarded optimization may fork only the reviewed root-to-preterminal-checkpoint path into
the new session when persona, worktree, resources, and context remain compatible; Rust still issues
a new attempt, grant, branch epoch, launch entry, and authoritative context. Copied grant/custom
entries are historical only and must not be accepted as bindings. Any summary is advisory and hash-
bound.

### Rust branch record

For every session-version attempt, Rust stores a versioned conversation binding containing:

- run, ticket, step, persona, attempt, launch-spec hash, and Pi session ID/locator;
- active branch epoch and last reconciled Pi leaf entry ID;
- branch lineage, purpose, author, created time, and status (`pending`, `active`, `abandoned`,
  `sealed`, or `interrupted`);
- the branch-point entry ID and optional Pi branch-summary/custom-entry IDs;
- the resource, context, grant, expected-state, and auth-generation hashes active for the epoch;
- whether the abandoned suffix contains only conversation/read observations or any durable Koni
  transition; and
- per-branch usage and terminal status.

Raw Pi entry IDs are storage identities and should not dominate the UI. Koni assigns human labels
such as `Initial`, `Plan revision 2`, or `Steered alternative` and records the underlying IDs only
for reconciliation.

Every autonomous tool request carries the session ID, attempt identity, and current Rust-issued
branch epoch/capability. Rust compares them under the existing grant and state lock. A delayed call
from an abandoned branch is rejected before replay lookup or effect execution. The Pi leaf alone
never proves authority.

### Branch transaction

A Koni-controlled in-session branch follows this crash-safe sequence:

1. Pause delivery for the attempt and wait until the Pi session is idle with no in-flight broker
   call, retry, compaction, or branch summary.
2. Under Rust's run/agent lock, validate the requested branch point and classify the abandoned
   suffix. Ordinary conversation and explicitly side-effect-free reads may be abandoned; graph
   mutation, note publication, question creation, output/plan candidate submission, compilation,
   or any terminal effect closes the immutable attempt and requires a new attempt instead.
3. Persist a `branch_pending` journal entry and increment the branch epoch. This immediately
   invalidates the old branch capability. No tool call is accepted while the transition is pending.
4. Ask Pi to navigate in the same session tree, optionally create a structured branch summary, and
   append a `koni.branch` custom entry containing the non-authoritative binding hash. Appending the
   custom entry makes the selected path recoverable even when a bare in-memory `branch()` leaf move
   would otherwise leave no durable marker.
5. Re-read the session tree, verify the branch point/custom entry/leaf, then atomically mark the new
   epoch active and the former epoch abandoned or sealed.
6. Reissue current Rust context before the next provider request.

Recovery reconciles `branch_pending` against the Pi custom entry and current tree. It either
finishes the exact intended transition or leaves the attempt paused for operator repair. It never
selects the newest JSONL entry heuristically and never restores the old capability after the epoch
was revoked.

Pi's `session_before_tree`/`session_before_fork` hooks should block ad hoc autonomous navigation and
route it through this Rust transaction. Those hooks are defense in depth only: a compromised or
buggy extension still cannot use an old epoch at the Rust broker.

### Planning revisions and work rework

Before a planner submits its terminal plan candidate, explicit steering may branch within the same
live attempt. Once Rust accepts a terminal candidate, that immutable planner attempt is closed even
if the plan is not yet approved. A user revision then creates a new planner attempt/session; the old
plan remains an immutable superseded revision. The new attempt may receive a compiler-issued
summary or, after compatibility validation, a Pi fork of the selected preterminal checkpoint, but
it always receives a new launch spec, grant, branch epoch, and authoritative context.

Plan approval seals the selected candidate lineage. Implementation rework after review likewise
uses a new worker attempt/session. The new launch spec may reference rejected output and a concise
compiler-issued rework packet, but it cannot replay tool call IDs or receipts from the old attempt.
Reviewers always use their own session and can inspect only the exact candidate artifacts Rust
grants them.

### Pi and Rust TUI UX

The Pi-native view may use Pi's tree/fork presentation for ordinary operator conversations. For a
Koni autonomous session it should display Koni branch labels and status, expose `Branch from here`
only when Rust reports the suffix safe, and otherwise offer `Start rework attempt`. Abandoned and
sealed branches remain readable but have no resume/action control.

The Rust TUI ticket chat should group by persona and attempt, then show a compact branch selector:

```text
Planner     · Attempt 1: Initial candidate (superseded)
Planner     · Attempt 2: Revised candidate (sealed)
Implementer · Attempt 1: Initial (abandoned) | Steered alternative (sealed)
Implementer · Attempt 2: Rework (active)
Reviewer    · Attempt 1: Review (sealed)
```

The selected branch renders its complete transcript. Active is visually distinct; abandoned,
sealed, and interrupted branches are muted and explicitly read-only. The UI uses labels rather
than session/entry IDs. When the run row is selected, all ticket sessions may be browsed; when a
ticket is selected, only that ticket's attempts are shown. Branch selection never changes Rust
authority by itself.

### Usage, compaction, cancellation, and deletion

Pi's `getSessionStats()` intentionally aggregates all entries, including compacted and abandoned
history. That is appropriate for the billed session total. Rust additionally attributes each usage
event to run/ticket/step/attempt/session/branch epoch so the UI can explain where tokens were spent.
Abandoning a branch never subtracts its tokens. Branch-summary and compaction usage is charged to
the new branch epoch that requested it; cache-inclusive provider totals and new-token totals retain
their existing separate meanings.

Compaction applies to the current branch context only. Its structured details include the branch
epoch and launch/context hashes. Navigating to an older branch uses that branch's compaction path,
but restoring it for model work still requires a new Rust branch transaction and authoritative
context reissue.

Pause/cancel targets the live attempt/session, regardless of which historical branches its JSONL
contains. Abandoned branches have no process. Run deletion first revokes every attempt and branch
epoch, then aborts/disposes all live Pi sessions, rejects late usage/tool events, and applies the
existing retention/deletion policy to every registered session tree. A user-owned interactive Pi
chat is not a run-owned process and is not killed, but all Koni capabilities for the deleted run
become invalid immediately.

### Branching acceptance tests and deletion gates

Before autonomous branching is enabled, tests must prove:

- one launch spec maps to one session tree and one active branch epoch;
- a delayed tool call, retry, steer, follow-up, or usage event from an abandoned epoch is rejected;
- a branch containing a mutable/terminal Koni effect cannot be treated as if that effect vanished;
- a pre-submission planner branch stays within one live attempt, while a post-candidate revision
  preserves the old plan version and creates a new attempt/session;
- worker rework and reviewer execution receive distinct attempts, sessions, grants, and call-ID
  namespaces;
- every crash point in the pending/navigate/custom-entry/finalize sequence recovers deterministically
  without two active branches;
- malformed, missing, duplicated, cross-session, or forged branch custom entries fail closed;
- compaction and branch summaries cannot replace launch/context/grant authority;
- per-branch usage sums to the session/run totals without dropping abandoned work; and
- pause/delete terminates the one live branch, invalidates all historical epochs, and produces zero
  post-delete provider calls, token increments, or effects.

Koni's manual branch adapter may be removed only after Pi tree parsing, pending-transition crash
recovery, old-epoch rejection, per-branch token attribution, and both-interface UX tests pass for
planning, worker rework, reviewers, and qualitative Leads. Historical branch metadata remains
readable even after its execution adapter retires.

## Questions, approvals, steering, and lifecycle

Rust persists questions, answers, approval/revision state, pause state, queued steering authorship,
and ordering. Pi presents them and applies an authorized steer/follow-up to the exact session.

- `koni_ask_question` persists the question in Rust before the agent yields.
- An answer is durably accepted by Rust before it is delivered to Pi.
- Plan approval/revision remains a Rust transition; the Pi command and Rust TUI are peers over the
  same state.
- Pause stops new scheduling and sends a bounded abort/drain command to live sessions according to
  existing durable semantics.
- Delete revokes grants first, aborts every associated Pi session, clears queues, disposes sessions,
  kills/reaps remaining contained processes, and rejects every late event/tool call.

Deletion is not complete while a session can still call the provider or publish usage. A fake
streaming provider test must prove zero post-delete provider requests, tool effects, durable events,
and token increments.

## Core bridge and package boundary

Use two related but separate transports:

1. The installed interactive extension lazily starts one long-lived
   `koni extension-server --stdio --root <path>` child on first Koni use. The protocol is bounded,
   versioned, sequenced, request-correlated, event-capable, and explicitly shut down on Pi session
   shutdown. The initial surface is read-only.
2. The contained autonomous runner remains a Rust-supervised child using the existing process-
   identity, containment, grant, and tool-broker boundary, upgraded to `AgentSession`. It receives
   an injected bridge client; it never spawns another Koni process.

The shared package should separate pure schema/result renderers, a typed bridge client, the
interactive extension factory, and the autonomous inline extension factory. Code reuse must not
collapse the two trust contexts or weaken one-process-per-assignment containment without a separate
security decision.

The handshake includes protocol version, core build identity, project identity, state/session
versions, capabilities, and the Rust tool-catalog hash. Frames and displayed errors are bounded and
redacted. No command spawns a fresh CLI process for each tool call.

Packaging is independent of authority. A native Koni install plus a Pi package is the smallest
first form. A later unified installer may provision both after version compatibility checks. The
stable acceptance command remains:

```sh
koni tui [--root <path>]
```

The current CLI has a default/Cockpit path but no explicit `tui` subcommand; adding that alias is
part of the first vertical slice. It must not launch automatically.

## Migration matrix

| Current subsystem | Pi primitive | Disposition | Security and compatibility requirement | Legacy deletion gate |
| --- | --- | --- | --- | --- |
| Raw low-level `Agent` host | `AgentSession` / `createAgentSession` | Migrate behind a run-pinned runtime version | Explicit tools/resources/settings/session/auth only; preserve current OS containment and terminal protocol | All assignment roles pass lifecycle, transcript, cancellation, budget, broker, and restart parity; old active/paused runs remain resumable |
| Manual `SessionRecord` | `AgentSession` + run-local `SessionManager` | Retire for new runtimes; retain adapter | Bind session file/ID and launch hash in Rust | No raw-host run can require the old record, and session recovery/crash matrix is green |
| Event normalization | `AgentSession.subscribe()` and Pi session entries | Wrap and narrow | Rust still needs bounded lifecycle/usage projection; complete chat comes from Pi JSONL | TUI and audit parity prove no lost assistant/tool/result content; old log parser remains for historical runs |
| Steering/follow-up queues | `steer`, `followUp`, `clearQueue`, `abort`, `waitForIdle` | Migrate execution; retain Rust durable intent | Rust persists authorship/order and exact session binding before delivery | Restart, race, pause, and terminal-boundary tests prove exactly-once delivery or explicit non-delivery |
| Koni Rust credential store/fd 3 | Pi `AuthStorage` + Pi-owned backend/service | Transitional import/fallback, then retire | Rust sees no secret; no ambient `~/.pi/agent` mount; one refresh writer; atomic/interoperable backend | Guarded import verified after fresh process/restart, account binding matches, rollback window resolved, old pinned runs no longer require it |
| Manual model registry/provider setup | `ModelRegistry` constrained by compiled run config | Migrate | Exact provider/model/thinking only; sanitized environment; no autonomous model cycling | Model/auth parity, unavailable-model failure, and provider request tests pass for every supported role |
| Koni chat reconstruction | Pi `SessionManager` JSONL + Pi renderers | Replace for new-format runs; retain compatibility projection | Registered paths, bounded parser, session format version | Full transcript fidelity and malformed/partial/oversized JSONL tests pass; historical parser remains separately supported |
| Attempt/session branching | Pi append-only session tree + Rust branch epochs | Adopt with Rust authority wrapper | One tree per attempt; one Rust-authorized active epoch; rework/review use new sessions | Pending-branch crash matrix, old-epoch rejection, usage attribution, and both-interface branch UX pass |
| Lead orchestration protocol | Rust ready-set scheduler + selective Lead sessions | Retire deterministic model courier | Journal/replay/pause/max-parallel semantics cannot change | Direct scheduler crash matrix matches legacy effects, zero model sessions for deterministic boundaries, semantic Lead UX remains truthful |
| Worker giant prompt protocol | Launch spec + explicit skills/resources/context hooks | Migrate incrementally | Resource/context hashes and terminal output contract are immutable | Every persona passes output/context/tool parity and compaction/resume tests |
| Rust tool schemas + TS projections | Rust catalog + Pi extension `registerTool` | Retain Rust source; retire TS duplication | Handshake schema hash; all calls revalidated by durable broker | Schema-drift test proves one source; no TypeScript-authored production schema remains |
| Legacy MCP bridge | Existing durable broker adapter | Wrap, then retire only if unused | Direct Pi and MCP compatibility paths must share one effect/replay implementation during transition | No live/historical executable runtime requires MCP, all broker parity tests pass, and historical records remain readable |
| Persona/skill/context assembly | Explicit `ResourceLoader` | Migrate presentation/loading; retain `.koni` authority | Minimal custom loader; exact resource hash manifest; no ambient discovery | Resource-isolation adversaries and upgrade/overlay preservation tests pass |
| Custom compaction/event summary | Pi compaction hooks | Migrate | Summary advisory; Rust context reissued and hash-checked | Overflow/manual/restore tests prove grants/context/effects unchanged and usage accounted |
| Questions and approvals | Pi commands/UI + Rust state | Retain Rust; wrap in Pi | Rust commits transition before Pi delivery | Restart and dual-interface parity prove no hidden Pi-only question/approval state |
| Cancellation/deletion | `abort`, queue clear, `dispose` plus Rust process supervision | Wrap | Revoke Rust grants before abort; reject late events | Streaming-provider deletion test proves prompt termination and zero later tokens/effects |
| Rust TUI | Pi renderers/widgets for incremental native UI | Retain | Both interfaces read/control the same Rust state | Delete only by a future explicit parity decision; not part of this migration |
| Packaging/update | Pi package plus native Koni binary | Wrap | Protocol/version handshake; project overlays and runs never overwritten | Unified packaging only after clean-install, upgrade, rollback, and version-skew matrix |
| Graph/compiler/tickets/Git | No Pi authority equivalent | Retain entirely in Rust | Extension and sessions are clients of Rust | Never deleted by this architecture |

## Smallest safe end-to-end slice

The first implementation slice validates the boundary without replacing the current runtime:

1. Add a separately pinned `@koni/pi` package with a trusted extension factory, typed bridge
   client, and semantic renderers. Do not add ambient resources or terminal management.
2. Add a versioned, bounded, read-only `koni extension-server --stdio` connection to Rust.
3. Add one operator command/status view that reports project/run/compiler state.
4. Add one Rust-schema-derived `koni_graph_context` read-only tool.
5. Render typed graph nodes, edges, and compiler diagnostics semantically in Pi.
6. Start lazily, handle missing/incompatible Koni cleanly, and shut down idempotently on
   `session_shutdown`.
7. Test that the extension cannot mutate graph/compiler/run state directly and that forged,
   oversized, replayed, cross-project, and post-shutdown calls fail closed.
8. Add the explicit `koni tui [--root <path>]` command and a regression proving no Koni path opens
   a pane or terminal.

This slice should not touch autonomous execution or credentials. It first proves package loading,
schema ownership, bridge framing, lifecycle, and dual-interface state observation.

The second slice upgrades one low-risk read-only planner/explorer assignment:

1. Add runtime/session/launch-spec versions and pin the new runtime only for an opt-in test run
   type.
2. Create a run-local Pi `SessionManager` and minimal custom `ResourceLoader`.
3. Use `createAgentSession()` with no built-in or ambient tools/resources.
4. Load the same trusted extension factory with an injected Rust broker client.
5. Keep the existing Rust credential seam through an `AuthStorageBackend` compatibility adapter
   for this slice; do not yet delete or duplicate credentials.
6. Preserve full Pi session messages and project them into the Rust TUI.
7. Prove steering, cancellation, restart, terminal output, broker authorization, resource
   isolation, and transcript parity against the raw host.

The credential cutover is a separate guarded slice after the Pi-side atomic backend/service and
interoperability tests pass.

## Compatibility model

Runs pin, at creation:

- runtime host generation (`raw-agent-v1` or `pi-agent-session-v1`);
- conversation format (`koni-events-v1` or `pi-session-v3`);
- launch-spec and resource-manifest versions;
- exact Pi package/artifact identity; and
- auth-binding generation.

No upgrade silently changes those values. Existing active or paused runs continue through the old
host, or are offered an explicit previewed migration only at a safe idle boundary. A failed guarded
migration leaves the old run unchanged. Historical transcripts remain readable regardless of
whether their execution runtime remains installed.

Package updates stage and validate new bundled baselines separately from project-owned `.koni`
overlays and `.agents/skills`. They never replace project configuration or run state wholesale.

## P0 and P1 implementation risks

### P0 — must fail closed before any autonomous opt-in

- Constructing `AgentSession` with defaults can enable shell/filesystem tools and ambient resources.
- Treating extension hooks or renderers as authorization can bypass Rust grants/CAS/replay.
- Mounting or discovering all of `~/.pi/agent` exposes credentials and ambient extensions/settings.
- Duplicating Rust schemas in TypeScript creates a second, drifting authority.
- Resuming a Pi session without matching launch/resource/context/grant/auth hashes can publish work
  under stale authority.
- Treating Pi's current tree leaf as authorization can let an abandoned branch replay an old grant;
  every tool/event must bind the Rust-issued branch epoch.
- Reopening a terminally closed attempt by navigating or forking its Pi history can reuse obsolete
  grant/worktree/context authority; every post-terminal revision must be a new launch attempt.
- Migrating credentials with two refresh writers, deleting the old store before verified import,
  or silently switching provider accounts can lose access or cross account boundaries.
- Switching transcript/runtime formats in place can strand active runs or replay completed work.
- Deletion that does not revoke, abort, dispose, kill, and reject late publication can continue
  spending tokens after the user deletes a run.

### P1 — blocks broad production cutover

- Stock Pi 0.80.7 auth persistence locks refreshes but rewrites the credential file in place; the
  Pi-side atomic backend/upstream upgrade and interoperability matrix must land first.
- Pi session JSONL needs Koni path, symlink, size, malformed-tail, privacy, and crash-recovery tests.
- Latest Pi documentation uses names such as `ModelRuntime` that do not exist in the pin; exact
  version compilation and API fixtures must govern implementation.
- The extension-server and autonomous host need bounded backpressure, correlation, shutdown, and
  version-skew tests.
- Full transcripts may contain sensitive project context and tool results; owner-only storage,
  bounded display, retention, and deletion semantics are required.
- Compaction can consume unaccounted tokens or become mistaken for authority unless its summary and
  reissue contracts are explicit.
- Native package and Rust binary version skew can expose incompatible tools or state; handshake and
  fail-closed upgrade/rollback behavior are required.
- Deterministic Lead courier turns remain a large token cost until Rust scheduling passes its crash
  and semantic-UX parity gates.

## Verification matrix

Before enabling an autonomous AgentSession runtime by default, tests must prove:

- exact pinned dependency identity and reproducible package artifact;
- zero default/built-in tools and zero ambient extension/resource/context discovery;
- Rust-owned tool schemas and exact schema-hash handshake;
- wrong run/ticket/step/agent/attempt/grant/session/context/auth bindings fail before effects;
- durable replay, CAS, receipt, terminal-boundary, and compiler behavior match the old host;
- full assistant messages, reasoning, tool calls, updates, results, usage, and terminal state survive
  restart and render in both Pi and Rust TUI paths;
- one session tree per attempt, exactly one Rust-authorized active branch epoch, deterministic
  pending-branch recovery, old-epoch rejection, and complete abandoned-branch token accounting;
- steering/follow-up ordering and pause/resume survive process restart;
- questions and approvals are identical through Pi and Rust interfaces;
- manual and overflow compaction reissue current Rust context and cannot change authority;
- deletion aborts every associated session and yields zero later provider requests/tokens/effects;
- Pi auth migration has one writer, no Rust/provider secret exposure, fresh-process verification,
  account-binding equality, and safe rollback;
- old active/paused runs remain resumable under their pinned runtime;
- project overlays, run state, and unrelated resources survive install/update/rollback;
- `koni tui` runs only where invoked; and
- no code path opens cmux, tmux, a terminal, a pane, or another TUI.

## Legacy subsystem deletion gates

The old raw host may be deleted only after every role and run size has run through AgentSession,
all active/paused raw-host runs have completed or received explicit guarded migration, and the
complete broker/lifecycle/transcript/budget/containment matrix is green on one immutable build.

The custom completed-chat reconstruction may be deleted only for new-format runs after Pi JSONL
fidelity and malformed/crash tests pass. The historical event-log reader remains indefinitely or
until an offline, byte-preserving migration with independent verification exists.

The Rust provider-secret store, fd-3 secret protocol, and Rust auth mutation code may be deleted
only after the Pi-owned store/backend is atomic and stock-Pi interoperable, every supported account
has a verified migration receipt, no pinned runtime needs legacy fallback, rollback policy is
resolved, and a secret-flow audit proves Rust receives no provider material.

Deterministic Lead model turns may be deleted only after direct Rust scheduling preserves journals,
replay, crash recovery, pause, max-parallel, review/recovery semantics, and the truthful Lead UX.
Qualitative Lead configuration and sessions remain.

The legacy MCP executable path may be deleted only after every production and compatibility runtime
uses the provider-neutral durable broker directly, all adversarial broker tests pass, and no
historical resumable run references the MCP topology. Historical records remain parseable.

Manual resource/prompt assembly may be deleted only after every compiled resource is represented in
the hash-bound loader manifest, customization overlays survive upgrades, and zero-ambient discovery
tests pass.

The normalized runtime event journal may be narrowed, not wholly deleted, after Pi sessions become
canonical chat. Rust still needs lifecycle, usage, partial-failure, supervision, and audit events.

The Rust TUI has no deletion gate in this decision. It remains fully supported until a separate
product decision finds genuine Pi-native feature parity.

## Recommended source scopes

Keep implementation reviewable by separating these scopes:

1. `runtime/pi-package/` (or a clearly separate package under `runtime/`): extension, renderers,
   bridge client, and package tests.
2. A new Rust extension-server module and the minimal CLI subcommand/`tui` alias.
3. A versioned `AgentLaunchSpec` and runtime/session compatibility metadata in `koni-core`.
4. A contained AgentSession runner beside the old raw host, selected by run-pinned runtime version.
5. A core Pi-session compatibility projector for the existing TUI.
6. A Pi/Node-owned credential backend/service and a separately reviewed migration transaction.
7. The deterministic Rust scheduling driver, after the runtime/session slices are stable.

Do not combine credential migration, raw-host deletion, deterministic-Lead removal, transcript
cutover, and package installation into one change. Each has a distinct rollback and deletion gate.

## References

- [Direct Pi runtime](pi-runtime.md)
- [Architecture](architecture.md)
- [Philosophy](philosophy.md)
- [Pi SDK](https://pi.dev/docs/latest/sdk)
- [Pi extensions](https://pi.dev/docs/latest/extensions)
- [Pi skills](https://pi.dev/docs/latest/skills)
- [Pi prompt templates](https://pi.dev/docs/latest/prompt-templates)
- [Pi sessions](https://pi.dev/docs/latest/sessions)
- [Pi session format](https://pi.dev/docs/latest/session-format)
- [Pi compaction](https://pi.dev/docs/latest/compaction)
- [Pi packages](https://pi.dev/docs/latest/packages)
- [Pi security](https://pi.dev/docs/latest/security)
- [Pi providers](https://pi.dev/docs/latest/providers)

The latest documentation is directional. Source and declarations from the exact pinned package are
the implementation contract until Koni deliberately upgrades its pin.
