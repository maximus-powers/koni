# Pi runtime security review

Owner: `pi-runtime-security-review/root`

Status: `in_progress` — read-only adversarial review

Started: 2026-07-14 America/Phoenix

## Exact lease

- Read-only review of the active Pi runtime foundation in
  `crates/koni-core/src/{agent_runtime,pi_protocol,pi_auth,agent_tool_broker}.rs`, the exact
  `koni-core` exports, and `runtime/pi-host` if present.
- Read-only review of the schema-2 migration surface where it bears on authority, ownership,
  collision safety, or credential handling.
- This mailbox is the only file this lane may edit. It owns no Rust, TypeScript, package, lock,
  test, profile, product-document, central-registry, migration, TUI, binary, cockpit, cmux,
  project, credential, or run-state path.
- No installs, package-manager/network commands, live migration, cockpit/TUI input, token-spending
  work, or forensic-run access are authorized.

## Acceptance boundary

The host is an untrusted stdio transport peer. Rust remains the sole authority for graph and
filesystem scope, compiler-issued context, exact run/ticket/step/session grants, CAS identity,
durable replay, supplement closure, receipt binding, and canonical `submit_and_compile`.
Subscription credentials may cross only private non-durable protocol frames; durable state,
diagnostics, events, and errors may contain opaque broker handles only.

This review prioritizes concrete P0/P1 defects in framing, replay identity, stdout/stderr
separation, credential secrecy, process containment/cancellation, tool-contract injection,
default-deny broker behavior, event/usage ordering, and migration ownership. Missing integration
in an explicitly isolated foundation will be labeled incomplete rather than reported as an
authority defect unless the exposed API already claims or permits that authority.

## Coordination sweep

- Read `docs/AGENT_COLLAB.md`, every current top-level `docs/*.md` product/design document, and
  every current `docs/agent-collab/*.md` mailbox in full before source review.
- The Pi parent/core/host/migration mailboxes and the post-cutover integration/context gates are
  treated as the current contract while all older Codex/schema-1 wording remains historical
  evidence rather than being silently replaced.
- Relevant owner questions and exact source findings will be appended below after the current
  implementation snapshot is inspected.

## Findings and questions

Review in progress.

### 2026-07-14 adversarial snapshot — findings that remain in current bytes

This is an append-only interim checkpoint while the Pi owners are still changing source. Earlier
draft concerns about the `RuntimeResponse` Serde tag, arbitrary first sequence, concurrent public
request dispatch, event-listener ordering, and whole-machine Linux/macOS read access are **not**
current defects: the owners changed those ranges during this review. The current response tag is
`kind`, both peers require sequence 1, the TypeScript request chain is serialized while tool results
remain re-entrant, Pi listener promises are awaited in subscription order, and the current
containment compiler uses explicit read roots. Final handoff will re-read these ranges and append
any further correction rather than rewriting this chronology.

#### P1 actual defect — malformed OAuth failures can put secrets on public stdout/stderr

- `runtime/pi-host/src/redaction.ts:1-4` recognizes unquoted `access_token=value`, but not normal
  JSON such as `{"access_token":"...","refresh_token":"..."}` because the closing quote on the
  key occurs between the key name and colon. A local, non-network Node probe confirmed both values
  survive the current redactor unchanged.
- The pinned Pi dependency throws raw upstream bodies and `JSON.stringify(json)` from malformed
  OAuth responses. In the installed pinned source this includes
  `@earendil-works/pi-ai/dist/utils/oauth/openai-codex.js:96-105` for access/refresh tokens,
  `:152-168` for device-auth bodies, and `:190-197` for `authorization_code` / `code_verifier`.
- `runtime/pi-host/src/runtime.ts:512-528` registers credentials with the redactor only *after*
  `oauth.login()` returns. Therefore its login catch cannot redact a token contained in a failing
  response; `protocol.ts:252-265` can serialize that message into a public rejected response.
  `main.ts:56-58` also prints a final error without the host redactor.
- Required fix/test: convert upstream OAuth failures to an allowlisted stable error code and never
  forward provider response bodies; also make structured redaction handle quoted JSON/form keys
  including access/refresh tokens, authorization codes, code verifiers, and device-auth secrets,
  and use it at the outer stderr boundary. Adversarial fake-provider tests must throw each secret
  shape before a credential is registered and assert the value is absent from every public frame,
  event, exception string, and captured stderr byte.

This is a real secret-boundary defect in the isolated host, not a missing engine integration.

#### P1 actual defect — mutable `TMPDIR` defeats cross-process refresh serialization

- `pi_credentials.rs:336-384` derives the per-user lock directory from
  `std::env::temp_dir()` (`:346-348`). Two Koni processes for the same UID can be launched with
  different `TMPDIR` values and therefore take different flock files while modifying the same OS
  keyring entry.
- `PiCredentialTransaction::commit` at `:214-246` compares the expected revision only with the
  transaction's in-memory revision; it does not re-read the keyring under a UID-global lock. Both
  processes can read revision N, each persist N+1, and the last writer can discard the other
  provider-issued rotating refresh token.
- Required fix/test: choose one validated UID-stable lock namespace independent of mutable process
  environment (or an OS-native named lock) and retain revision conflict detection. A two-process
  test with distinct `TMPDIR` values must prove only one modify callback enters and that a stale
  transaction cannot commit over a newly rotated credential.

#### P1 actual defect — migration can follow a symlinked ancestor outside the project

- `schema2_migration.rs:432-468` forms `.codex/koni` and manifest-owned resource paths beneath a
  canonical project path, but `ensure_real_directory` / `ensure_real_file` at `:1454-1477` call
  `symlink_metadata` only on the leaf. An intermediate `.codex` symlink is followed, while returned
  entry paths remain lexically project-prefixed and pass `strip_prefix` at `:1268-1299`.
- Publication then renames those lexical paths at `:734-762`. With `.codex` redirected to another
  same-filesystem directory, apply can move an outside `.codex/koni` tree and owned agent files into
  the project's backup. That contradicts the documented refusal of redirected or escaping paths.
- Required fix/test: prove every source ancestor with no-follow directory handles (or canonicalize
  every source and require the expected canonical root) and retain the proof through publication.
  Add fixtures where `.codex` itself and `.codex/agents` are ancestor symlinks; planning and apply
  must fail before any outside byte moves.

#### P1 actual defects — migration is not a semantic- or crash-safe transaction yet

- `schema2_migration.rs:844-930` and `:973-1064` recursively rename `codex_agent`,
  `reasoning_effort`, and `sandbox` in *every* mapping and rewrite *every* string beginning with the
  legacy config path. Embedded JSON schemas, prompts, domain metadata, or examples can legally use
  those names as data. `reject_legacy_keys_yaml` at `:1066-1089` repeats the same global assumption.
  The conversion therefore exceeds the locked field paths and can silently change user semantics.
  Transform only schema-known paths/types; add preservation fixtures containing those exact keys
  and strings in prompts, metadata, and embedded input/output schemas.
- Source hashes are rechecked at `:384-390`, then the test hook and an unavoidable filesystem race
  occur before publication; only `is_dir()` is checked at `:402-410`. A source edit in that window
  is archived while stale staged output is published successfully. Recheck after atomically taking
  ownership of each renamed backup and before publishing `.koni`; add a hook test that mutates a
  source after the existing final check.
- `publish_transaction` at `:734-796` is several renames with only in-process rollback. A crash
  after moving legacy config or some agents leaves a partial layout with no durable phase marker or
  automatic recovery. Before production activation it needs an fsynced intent/phase journal and an
  idempotent recovery path tested by injected termination after each rename boundary.

#### P1 actual defect — a host leader can exit while descendants survive supervision

- `agent_runtime.rs:571-615` kills the process group only while the leader's birth identity is
  still live. If the leader exits after spawning a same-group helper, `try_wait()` observes a
  completed child and no group signal is sent. The documented guarantee at `:292-296` is therefore
  false for that lifecycle.
- The shared Unix helper `agent.rs:540-557` also falls back from a failed external `kill -KILL
  -PGID` invocation to killing only the direct child and reports success, which can strand helpers.
- Required fix/test: use a group/cgroup supervision mechanism whose ownership remains provable
  through leader exit and signal it directly rather than through PATH. A fake host should spawn a
  same-group helper, record its PID, exit first, and prove EOF, cancellation, timeout, and Drop all
  eliminate the helper before returning.

#### P1 actual defects — turn limits and terminal lifecycle are not enforced

- `runtime/pi-host/src/runtime.ts:79-91` trusts provider usage numbers without finite,
  non-negative, safe-integer, checked-add, or total-consistency validation. A bad provider event can
  corrupt metering or turn a public usage frame into JSON `null`; Rust then only fails later while
  decoding.
- The requested `token_budget` is checked only at `runtime.ts:463-468`, after an entire assistant
  message has completed. It is not passed to Pi's provider `maxTokens` option and is not enforced
  during streaming, so one completion can exceed the asserted budget by the model's full output
  limit before cancellation. Tests should prove the provider receives the remaining hard cap and
  that malformed/overflowing usage fails closed without a misleading receipt.
- `runTurn` at `runtime.ts:334-372` emits `runtime_error` on an asynchronous validation/provider/
  listener failure, clears the active turn, and never emits the canonical terminal
  `turn_completed`. A hash-invalid image is accepted synchronously and exercises this path. Define
  exactly one terminal outcome for every accepted turn and test invalid media, provider failure,
  tool timeout, cancellation, and event-write failure.

#### P1 integration gate — there is no single fail-closed production launch constructor

This is intentionally classified as incomplete foundation, not a live bypass, because no engine
call site uses the Pi host yet. It must be closed before integration:

- `agent_runtime.rs:257-289` publicly exposes arbitrary executable, argv, cwd, stderr path,
  environment additions/removals, `inherit_environment`, and a caller-selected positive frame
  bound. `SupervisedAgentRuntimeHost::spawn` at `:323-347` remains a public path that requires
  neither containment nor fd 3.
- The credential socket path, OS containment compiler, empty/denylisted environment, pinned host
  image/package roots, private scratch, stderr sink, and global frame ceiling are separate pieces;
  the type system does not require them to be assembled together. This contradicts the runtime
  contract that missing containment or credentials must refuse launch.
- Required integration shape: keep raw spawn test/crate-private and expose one constructor taking a
  compiler-built opaque launch capability that already contains the compiled Seatbelt/bwrap
  command, exact pinned roots, private scratch, forced-empty and sensitive-name-denied environment,
  fd-3 service/lease, internal stderr file, hard timeout, and a global maximum frame bound.
- Required negative tests: containment launcher missing; fd3 absent/wrong type/already consumed;
  inherited or explicitly injected API-key/provider vars; project/home as read or write root;
  symlink-swapped executable/package/scratch; oversized configured frame cap; stderr symlink;
  persistence callback failure; and durable-start callback failure. Every case must fail before a
  model request and leave no child or credential-service thread.

#### P1 integration gate — raw ordered frames are not an authenticated runtime state machine

This is also incomplete integration rather than a current broker bypass. The raw transport in
`agent_runtime.rs:477-535` validates frame shape/session/sequence, but it does not track outstanding
request IDs, match response kind to command, bind events to an accepted active turn, reject events
after a terminal event, validate usage monotonicity/totals, or deduplicate tool call IDs. A
correctly sequenced malicious host can therefore produce an unsolicited response, cross-turn
event, early completion, or replayed tool call for the future adapter to mishandle.

Before engine integration, add a Rust-owned session/turn protocol state machine and adversarial
tests for unknown/duplicate response IDs, wrong response kind, event-before-turn, wrong turn ID,
duplicate terminal, event-after-terminal, duplicate/undeclared tool call, tool call without an
active turn, usage regression/overflow/terminal mismatch, and cancellation races. Transport
sequence is not durable tool replay protection.

`AgentToolBroker` remains only an interface (`agent_tool_broker.rs:13-63`). The production adapter
must construct context exclusively from trusted runtime state and preserve the existing exact
durable replay, compiler-context-first, run/ticket/step/session grant, CAS, accepted-output
supplement closure, and canonical `submit_and_compile` receipt path. Required negative tests remain
wrong identity/grant/step/session, stale CAS, non-context-before-context, post-output supplement,
duplicate durable replay, and successful ordered composite submission. No Pi tool should be
advertised until that adapter and state machine are installed default-deny.

#### P1 integration gate — migration run archival needs authoritative evidence

`Schema2ApplyPreconditions` (`schema2_migration.rs:121-134`) is a public serializable assertion and
`apply` authorizes either enum variant at `:323-348`; the standalone migrator cannot know whether
active Codex runs were actually archived. This is acceptable only as an unwired seam. Production
integration should accept opaque compiler-issued archival/no-runs evidence bound to the current
run-registry revision and migration ID, then revalidate it at publication. Tests must prove a
deserialized/tampered assertion, stale registry revision, partial archive, or newly appeared legacy
run cannot authorize migration.

### Owner-directed questions

- `pi-sdk-host/root`: will the host owner close the OAuth-error leak, hard token limit/usage
  validation, and exactly-one-terminal-turn tests before releasing `runtime/pi-host`?
- `pi-runtime-architect/root`: what exact opaque constructor will make containment, sanitized env,
  fd3 credential service, bounded stderr/frame policy, and complete descendant teardown
  inseparable at every production call site?
- `pi-runtime-core/root`: which layer will own outstanding request correlation and the inbound
  session/turn/tool/usage state machine? The current transport validates ordering only.
- `pi-schema-migration/root`: please treat ancestor symlinks, post-check source mutation, global
  recursive data rewriting, crash recovery, and archival evidence as release blockers even though
  the earlier focused suite is green; its current fixtures do not exercise those boundaries.

### Appended P1 actual defect — browser OAuth cannot bind under the shipped macOS policy and can hang

- `crates/koni-core/src/runtime_containment.rs` currently grants the macOS child
  `network-outbound` but not the distinct Seatbelt `network-bind` / `network-inbound` operations.
  A read-only local probe using that policy shape and Node's `listen(0, "127.0.0.1")` failed with
  `EPERM`; outbound permission does not authorize the loopback callback listener used by browser
  OAuth.
- The pinned OpenAI Codex OAuth implementation attempts a localhost callback listener (port 1455).
  When the bind fails it returns a server facade whose `waitForCode` yields no code and then enters
  its manual-code fallback. In `runtime/pi-host/src/runtime.ts`, `resolveLoginPrompt`'s
  `manual_code` promise settles only when its abort signal fires, while the surrounding login only
  aborts that controller in `finally` after `oauth.login()` settles. That creates a dependency
  cycle: under the current sandbox a browser login can wait indefinitely until an external host
  shutdown.
- Required release fix: either grant only the exact loopback bind/inbound operations needed by the
  callback (with compiled-policy tests proving no non-loopback listener) or detect containment and
  select a device-code flow that does not bind. All login modes also need a bounded timeout and
  cancellation path that closes the callback server/controller. Add a macOS containment test for
  successful permitted loopback callback or deterministic fail-fast fallback, plus a lifecycle
  test proving bind failure, user cancellation, timeout, and host shutdown leave no listener or
  unresolved prompt.

### Appended live correction — the credential lock defect was remediated in current bytes

The earlier `TMPDIR` / stale-revision finding remains useful chronology, but it is no longer an
unfixed source defect as of the 18:34 local snapshot. `pi_credentials.rs` now derives the lock root
from canonical `/tmp`, opens the per-provider lock with `NOFOLLOW | CLOEXEC`, re-reads the
persistent keyring revision before writing, and includes a two-process test with distinct
`TMPDIR`s. Final disposition still requires the owner/integration test evidence, but downstream
agents should not independently reimplement the earlier fix.

### Appended P1 actual defects — the new production composition does not yet seal its authority

`pi_runtime_process.rs` landed after the initial snapshot and usefully composes containment, fd3,
scratch, and supervision in one path. Three release-blocking boundaries remain in its current
public shape:

- `PiRuntimeArtifact` (`:45-53`) is publicly constructible, while `bootstrap` accepts it without
  revalidation. Even the intended `discover` path selects the first `node` on mutable `PATH` and
  authenticates it only by executing `--version`; the host checksum is read from a co-located file
  with no independent trust anchor. Between `verify` (`:102-134`) and spawn, Node or the bundle can
  also be replaced. That means an arbitrary or post-verification-mutated executable can receive
  both the private OAuth fd3 and outbound network. Make the artifact fields private and issue an
  opaque capability only from a trusted install manifest/build digest and stable opened
  descriptors (or an equivalently race-free immutable image); do not trust `PATH`, an environment
  override, or a sibling checksum as the root of authority. Tests must inject a fake `node` that
  prints the minimum version, forge the public struct, mutate each artifact after verification,
  and prove no credential service or child starts.
- `run_turn` propagates `broker.execute` and `on_event` errors directly (`:391-413`, `:425-428`),
  `authenticate` lets an interaction callback error escape through `wait_for_response`
  (`:471-485`, `:598-599`), and unexpected protocol states from `wait_for_response` return without
  killing the host. Thus Rust can tell its caller that durable authorization/persistence failed
  while an accepted model turn or OAuth login remains live and spending/waiting. Every broker,
  callback, protocol-state, and persistence failure after spawn must cancel/terminate and reap the
  host plus credential service before returning. Tests should assert no further provider/tool/event
  activity and no child/listener after each injected callback and broker failure.
- The low-level spawn path creates the caller-selected stderr file using `File::create`
  (`agent_runtime.rs:387-396`), following leaf or ancestor symlinks and truncating the target before
  the child starts. The public production requests also expose `stderr_path`. Open a
  compiler-owned path beneath a no-follow state-directory handle with exclusive/regular-file
  checks, pass the already-open descriptor into spawn, and test leaf and ancestor redirects to an
  outside sentinel.

#### P1 credential-integrity authority defect in the composed fd3 service

`pi_credential_service.rs:193-313` authorizes `read`, global modify begin/commit, and `delete`
solely because the peer presents the process's generic lease. The service has no Rust-owned record
that a matching public BeginLogin, Logout, or legitimate refresh operation is outstanding. This is
not just secret transport: delete and replacement of the per-user OS credential are externally
meaningful effects, while the locked design says the Node host is untrusted and Rust owns all such
authority. A malicious/misbehaving host can therefore erase the user's credential during model
discovery or an ordinary turn, or replace it independently of the user's requested auth action.

Make mutation capabilities operation-scoped and short-lived: deletion is a one-shot capability
issued only for an outstanding Rust-authorized logout; initial/replacement login writes exist only
inside an outstanding login intent; inference refresh is serialized and must preserve provider and
account identity (or an equivalently strong compiler-owned binding). Unsolicited, replayed,
cross-intent, post-timeout, and post-cancellation private operations must be denied. Fake-host
tests should attempt delete/replace during metadata, model discovery, an ordinary turn, after
intent completion, and after intent expiry, and prove the keychain bytes/revision do not change.

### Appended live correction — several runtime defects were remediated while this review ran

The source moved again at 18:35–18:38. Preserve the earlier causal findings, but use these current
dispositions rather than sending owners to reimplement already-landed work:

- Raw `AgentRuntimeHostRequest` / `SupervisedAgentRuntimeHost` construction and spawn are now
  crate-private. The production composition selects `host.stderr` inside its fresh owner-only
  scratch, so the earlier public stderr-path redirect is closed on that path.
- `PiRuntimeArtifact` fields are now private, the bundle is opened no-follow, copied into scratch,
  synced and re-hashed before launch, and Node's recorded hash is rechecked. This closes public
  field forgery and the bundle-path swap. It does **not** close the root-of-trust issue: public
  `verify` still accepts any caller-controlled Node/bundle/sibling checksum, `discover` prefers
  mutable `PATH` and an environment override, and Node is still executed by pathname after its
  last hash check. An initially malicious `node` that prints the required version or a node swap
  in the rehash-to-exec window still reaches fd3 plus outbound network. Independent install trust
  and race-free executable identity remain P1.
- The production auth surface now refuses BrowserPkce before sending it to the contained host;
  the host also fails `manual_code` immediately and has a bounded abort timeout. The macOS bind /
  unbounded-manual-wait finding is therefore remediated in current production bytes pending exact
  tests, without adding broad inbound network permission.
- Group teardown now invokes `killpg` even after the unreaped leader exits, uses the Rust syscall
  instead of a PATH command, and includes a same-group descendant regression. The earlier
  descendant-survival defect is remediated pending verification.
- OAuth login failures now project to a stable allowlisted message, structured redaction covers
  quoted access/refresh/auth-code/verifier/device-auth fields, and the outer catch shares the
  redactor. Accepted turns now validate media before acceptance and attempt canonical
  `turn_completed` even after async provider/listener failure. Provider usage receives finite /
  safe-integer / consistency / checked-add validation. These earlier host defects are remediated
  pending the owner's adversarial test matrix rather than treated as an integrated release.
- A concrete `DurableAgentToolBroker` now adapts the existing process-bound `AgentBrokerIngress`,
  exact context, enabled-tool catalog, safe minimal responses, validation retry ceiling, and
  consuming terminal boundaries. This materially closes the former “trait only” gap; a real
  engine/runtime call path and the semantic state machine remain required.

### Appended P1 current gaps in the newly landed semantic/budget work

- `pi_runtime_state.rs` now implements useful request-kind, active-turn, declared-tool,
  broker-result, terminal, and usage checks, but it has no call site in current source. Until
  `send_command`, inbound acceptance, and tool-result recording are wired inseparably into the
  production host/process path with termination on rejection, its tests do not enforce the
  runtime boundary.
- Before wiring it, remove the check that cumulative `cached_input_tokens <= input_tokens`.
  Pi's pinned `Usage` defines `input` and `cacheRead` as separate buckets and computes total from
  both; a long cached prompt can legitimately have far more cache-read than uncached input. The
  current check would kill healthy cached sessions and can make normal production inference
  unavailable.
- Host token limiting now passes a remaining number as provider `maxTokens`, which is progress,
  but it subtracts prior **total** usage and uses the result as an **output-token** cap. On the
  first provider call no input/cache usage has yet been recorded, so input/cache plus the allowed
  completion can still exceed a total-token budget. Either define and bind this field explicitly
  as an output-generation cap and meter it against output only, or count/reserve prompt/cache
  usage before the request so a claimed total-token hard cap is real. Add first-call huge-context
  and multi-tool-call cache fixtures.

### 18:39 exact composition disposition and proof criteria

This append supersedes only the immediately preceding statement that the state machine had no call
site. It was wired while that statement was being recorded:

- `PiRuntimeProcess` now owns `PiRuntimeStateMachine` (`pi_runtime_process.rs:232-240`), registers
  commands at `:585-588`, records tool results at `:590-593`, and validates every received frame at
  `:595-603`, terminating the host on a semantic rejection. Request-kind, turn, declared-tool,
  broker-result, usage, and terminal correlation are therefore enforced on this composed path.
- The remaining integration criterion is a real engine call site that constructs the
  `DurableAgentToolBroker` from the exact compiler grant and uses this composed process; neither a
  standalone state unit test nor a caller-supplied alternative broker releases the cutover.
- Failure reconciliation is still wrong at `pi_runtime_process.rs:456-466`: Rust returns as soon as
  it sees `RuntimeError`, although the host now follows that advisory error with canonical
  `TurnCompleted`. The state remains active and the terminal frame unread. Store the safe failure,
  continue through the exactly-one matching terminal event, then return the failure. A fake-host
  regression must emit `turn_started -> runtime_error -> turn_completed`, prove the terminal is
  consumed, prove no active turn/pending frame remains, and prove the next legal turn can start (or
  the process was deliberately terminated and reaped).
- Deadline handling also remains fail-open: the actual `receive_timeout`-returns-`None` branches at
  `pi_runtime_process.rs:417-419` and `:636-640` create an error without the termination performed
  by the pre-wait `remaining.is_zero()` branches. Together with `broker.execute?` at `:430`,
  `on_event?` at `:434`, and auth-interaction callback propagation at `:510-515`, those paths can
  return while a provider/login is still live. Each injected path must prove zero surviving host
  group, credential-service thread/transaction, callback listener, and provider/tool/event work
  after the Rust error is observable.

#### Cache-usage acceptance proof

The exact incompatible check is `pi_runtime_state.rs:351-369`, specifically cached input being
required not to exceed uncached input at `:362-363`. The pinned Pi `Usage` contract makes `input`,
`cacheRead`, `cacheWrite`, and `output` separate contributors to `totalTokens`; cache-read is not a
subset of `input`. A required cross-language fixture is therefore a valid assistant usage such as
`input=5, cacheRead=10_000, cacheWrite=7, output=3, reasoning=1, totalTokens=10_015`. The host must
emit it without alteration, the Rust state machine must accept `cacheRead > input`, and the exact
cumulative terminal usage must reconcile. Preserve `reasoning <= output` and checked addition. For
fully auditable totals, add `cache_write_tokens` to `RuntimeUsage` and require exact bucket sum;
if that field remains omitted, require at least that the visible bucket sum does not exceed total
rather than inventing a cached/input subset relationship.

#### Pre-request budget proof

The current host sets an output `maxTokens` from total usage remaining at
`runtime/pi-host/src/runtime.ts:246-255`, before first-call input/cache usage is known, while later
metering is cumulative total (`:100-129`). If `token_budget` is promised as a hard total budget, a
fake provider must capture each request and prove:

1. for budget `B` and pre-request prompt/cache charge `C`, the first provider call receives
   `maxTokens <= B-C`, or no provider call occurs when `C >= B`;
2. after accumulated checked usage `U`, a tool-follow-up with next request charge `C2` receives
   `maxTokens <= B-U-C2`;
3. every terminal total is `<= B`, including a cache-heavy prompt and a budget smaller than the
   prompt itself.

If the provider boundary cannot determine `C` before dispatch, the honest safe contract is an
explicit output-generation cap (rename/bind it and meter only `output_tokens`), not a claimed hard
total-token cap.

#### Artifact classification

Public `discover` / `verify` is **not by itself** a cross-process or model-authority exposure: an
arbitrary in-process Rust caller is already inside Koni's trusted computing base. The P1 is
primarily a production trust-root construction defect at `pi_runtime_process.rs:62-90`,
`:105-138`, `:152-159`, and `:261-292`: the production capability can be minted from a mutable
`PATH` Node, an environment-selected host root, and a caller-controlled sibling checksum, then
Node is executed by pathname after the last hash check while receiving fd3 and outbound network.
The staged bundle closes its path race, but content consistency with an untrusted sibling digest
is not authenticity. Release requires an independently pinned install manifest/digest (or
OS/package signature and ownership policy), production discovery that cannot be redirected by
ambient environment, complete forbidden-root derivation inside the compiler rather than supplied
by each caller, and race-free executable identity through `exec`. Making alternate `verify`
test-only/crate-private is sensible API hardening, but it is not a substitute for fixing the trust
root used by `discover` itself.

### 18:46 live correction — cache acceptance fixed; Codex drops the requested token cap

The moving tree removed the invalid `cached_input_tokens <= input_tokens` condition from
`pi_runtime_state.rs:351-365`; only checked cumulative addition plus
`reasoning_tokens <= output_tokens` remains. Preserve the cache-heavy cross-language fixture as
regression evidence, but do not ask another owner to re-add or independently reimplement that
source fix.

The total-budget hold is stronger than the preceding proof note states. The Koni host computes a
remaining total and passes it as `options.maxTokens` at
`runtime/pi-host/src/runtime.ts:250-260`. However, the pinned production provider is
`openaiCodexProvider`, and its bundled request builder at
`runtime/pi-host/node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js:339-377`
never reads `options.maxTokens` and never emits `max_output_tokens`. (The separate ordinary
OpenAI Responses adapter does so; the Codex adapter does not.) Therefore the actual Codex provider
request is currently uncapped by Koni's `token_budget`. The later post-message abort at
`runtime.ts:567-572` can stop another iteration only after the already-unbounded assistant
response has been billed and emitted, so it cannot make the per-turn limit hard.

Release requires either a pinned Pi/provider implementation whose Codex request path demonstrably
honors an output cap, or a Koni-owned abort/metering boundary with an honestly specified enforceable
contract. Even if `max_output_tokens` is added, that remains an output cap rather than a hard total
cap; the earlier prompt/cache reservation criteria still apply to any `token_budget` documented as
total tokens. The exact fake-provider/integration proof must inspect the serialized Codex request
body (not merely the options passed into `streamSimple`), force an oversized single response, and
prove the terminal/accounted usage cannot exceed the advertised contract.

### 18:49 migration re-review — four repairs landed; two publication-authority P1s remain

The current `schema2_migration.rs` materially supersedes most of the earlier migration snapshot:
component-wise ancestor checks now reject symlinks; YAML/TOML conversion is limited to root
schema/persona/agent-role fields; run disposition is an opaque crate-issued, registry/receipt-hash-
bound proof with a real engine archive caller; and publication has an fsynced phase journal plus
idempotent recovery logic. Treat ancestor checking, arbitrary recursive semantic rewriting, public
precondition deserialization, and the complete absence of crash recovery as source-remediated
pending the promised nonzero adversarial tests. The current test module still exposes only the
original eight named migration tests, so the new obligations are not yet evidenced.

Two P1 boundaries remain on the new design:

1. **Recovery state is forgeable from the model-writable project tree.**
   `publication-journal.json` authenticates itself only with a plain SHA-256 over its public fields
   (`schema2_migration.rs:1135-1203`). `pending_publication_plan` accepts an incomplete journal's
   embedded, publicly serializable `Schema2MigrationPlan` at `:1206-1258`. The recovery path then
   performs only `validate_static_plan_shape`, not `validate_plan_shape` / `derive_resource_plan`
   or the staged compiler callback. In particular, static validation does not rederive or constrain
   `retired_legacy_agents`; `recover_publication` consumes those paths at `:1025-1078`. A workspace
   writer can therefore compute a valid self-digest for a fabricated pending journal and nominate
   another regular project-relative file (including Git metadata when `.git` is a directory) as a
   “retired agent,” causing migration recovery to move it into the backup. Put the recovery record
   in compiler-owned storage outside agent write grants and bind it with an unforgeable/opaque
   compiler capability, then rederive and validate every destructive source path even during
   recovery. Add a forged-journal test that attempts to retire an unrelated source and `.git`
   sentinel and proves neither byte/path changes.
2. **The final publication and run-disposition checks are still pathname TOCTOUs.** The new
   component checks and hashes are valuable, but `inspect_at`/`verify` complete before later
   pathname `fs::rename` calls (`:991-1006`, `:1025-1053`, `:1084-1096`). A concurrent writer can
   exchange an ancestor or leaf after validation and before rename; post-rename hash checking can
   detect the mismatch only after an outside object was already moved. Likewise the run archive
   barriers are dropped when `archive_pi_migration_runs` returns, while `apply` only re-hashes the
   registry at discrete proof checks; a new/changed run can race the last check and publication.
   Bind source/destination identity with opened no-follow directory handles and descriptor-relative
   rename (or equivalent race-free OS primitives), and hold/reacquire compiler run-registry
   authority through the publication commit. Tests need an actual synchronization point in the
   check-to-rename window, not only the existing hook before the final recheck, plus a run appearing
   after the last proof verification.

### 18:51 runtime/credential rebase — fail-closed wrappers landed; intent teardown is incomplete

`PiRuntimeProcess` now brackets `start_session`, `run_turn`, `authenticate`, `list_models`, and
`metadata` so any inner broker/callback/receive/protocol/timeout error terminates the host and then
finishes the credential service. Consequently the earlier direct-`?` continued-spend finding and
the `RuntimeError` terminal wedge are source-remediated in the current bytes: Rust may still stop
reading at the advisory error, but it deliberately tears down/reaps rather than reusing the active
state. Keep injected failure/lifecycle tests as release evidence; do not reintroduce a second
terminal-draining implementation unless process reuse on provider failure becomes a requirement.

The new credential authority also closes the original ambient mutation defect in large part.
Rust now authorizes expiring `ReadOnly`, `Login`, `Logout`, or `InferenceRefresh` intents around the
matching public operation; logout is one-shot; modify requires login/refresh; and refresh requires
an existing credential with equal account metadata. Metadata/model discovery and post-operation
mutation are denied. Two residual P1s remain:

- A successful public operation can leave a private `ModifyBegin` transaction open. Dropping or
  expiring `CredentialIntentGuard` only removes the shared `AuthorizedIntent`; the actual
  `ActiveTransaction` lives solely in the service loop and is aborted only on another matching
  frame or fd3 disconnect. A hostile host can begin refresh, emit a successful turn terminal, and
  retain the per-user cross-process keychain lock indefinitely while the reusable runtime stays
  alive. Intent close/expiry/cancel must actively wake the service and abort any transaction bound
  to that intent before the Rust operation returns. Prove this after successful terminal, error,
  timeout, cancellation, and silent-host cases.
- Refresh compares `Option<String>` account metadata. An existing credential with no account ID
  accepts a replacement that also omits it, and a hostile host controls the replacement token and
  its self-asserted metadata. Require a nonempty independently derived/bound stable account
  identity before persistent refresh (or fail closed to a new explicit login); make login/refresh
  commits one-shot unless a demonstrated provider flow requires more. Tests should attempt
  arbitrary token replacement with copied/absent metadata, not only a visibly different account
  string.

#### Rust usage consistency remains authority-relevant

Removing `cached_input <= input` was correct, but current Rust accepts totals below the visible
bucket sum. Its own `usage_is_checked_for_overflow_subcounts_and_terminal_equality` fixture uses
`input=10`, `cacheRead=2`, `output=5`, `total=15` and accepts it, although the pinned Pi/OpenAI
contract counts uncached input, cache read, cache write, and output separately. Because the Node
host is explicitly untrusted, TypeScript-only arithmetic validation is not the Rust budget/
telemetry authority. Add `cache_write_tokens` and require exact checked equality, or at minimum
require checked `input + cacheRead + output <= total` while retaining `reasoning <= output` and
exact incremental/terminal equality. The cache-heavy valid fixture and a too-small-total negative
fixture are both required.

### P0 architectural trust contradiction — the “untrusted” host receives exportable OAuth secrets plus outbound network

The current composition protects tokens from **public protocol frames and logs**, but not from the
Node process itself. `IpcCredentialStore.read` / `beginModify` return the raw access and refresh
credential to the host over fd3 (`runtime/pi-host/src/credential-store.ts:32-54` and
`credential-channel.ts:14-55,206-243`). During inference the Rust intent authorizes that read, and
the containment policy grants the same process unrestricted `network-outbound`
(`runtime_containment.rs:143-152`; Linux uses shared networking). A malicious or substituted host
can therefore send the credential to any endpoint during an otherwise authorized turn without
ever placing it on stdout, stderr, or a durable event. Redaction and an operation-scoped lease do
not constrain what the credential consumer does with the bytes.

This is P0 under the written architecture's claim that the Node host is untrusted, and the weak
ambient artifact trust root makes the attack concrete: a PATH-selected Node or environment/
sibling-checksum-selected host that satisfies the superficial probes receives fd3 and outbound
network. Choose one honest boundary before cutover:

- keep Node outside the credential TCB by denying it raw secrets and general network, and perform
  allowlisted provider TLS/authentication in a Rust-owned proxy that injects credentials only for
  the pinned OpenAI endpoint and exposes a narrow response stream; or
- explicitly promote the exact host plus its dependency closure into the credential TCB, replace
  “untrusted host” claims accordingly, and require independently signed/pinned artifact provenance,
  update policy, and dependency review commensurate with a token-handling network client.

Destination-only network filtering without moving TLS/header authority is insufficient: a hostile
client that owns the bearer token and request body can still encode it to an allowed endpoint.
The integrated adversarial proof should substitute a host that asks for a valid read during a turn
and tries to transmit the secret; success must be impossible at the selected boundary.

### 19:02 recommendation — make the pinned Pi host a credential TCB for the first production cut; treat a Rust auth proxy as a later boundary redesign

For this harness, the pragmatic first production boundary is to **promote the exact Koni Pi host,
Pi SDK bundle, Node runtime, and their dependency closure into the credential TCB**, then rewrite
the threat model so it no longer calls that process untrusted with respect to credentials or model
traffic. This is not as strong as secret-blind Node, but it is the smallest coherent design that
matches the provider architecture already selected. Keep the public protocol, workspace, command,
and compiler-resource boundaries adversarial; narrow only the credential/network claim.

The reason is concrete rather than stylistic. The pinned Codex provider currently:

- obtains an exportable OAuth access token through Pi's `CredentialStore` / auth resolver;
- parses the token locally to derive `chatgpt-account-id`;
- constructs the bearer and account headers inside
  `openai-codex-responses.js:1168-1215`;
- directly owns both WebSocket and zstd/SSE transports, retry/fallback behavior, streaming parse,
  aborts, and provider diagnostics (`:130-275`); and
- runs Pi's OAuth login/refresh adapter in the same Node dependency closure, so protecting only
  inference requests would still leave refresh-token handling unresolved.

A secret-blind Rust proxy is possible, but **not cleanly without changing/forking the provider
boundary today**. Merely redirecting `baseUrl` to localhost does not help: the provider still
requires a token, parses it, and builds its own auth headers. A placeholder JWT plus header
replacement would be brittle, would need both SSE and WebSocket proxying, and would not solve the
OAuth login/refresh path. Intercepting global `fetch`/WebSocket is an equally fragile implicit
fork. A defensible proxy therefore needs a first-class upstream transport/auth-injection API or a
Koni-owned provider adapter, plus Rust-owned OAuth exchange/refresh, endpoint allowlisting, TLS,
stream backpressure, retries, cancellation, and dual SSE/WebSocket conformance. Operationally that
is a high-complexity provider implementation, not a small containment patch.

The TCB option is moderate operational work and should be explicit release work, not a docs-only
waiver:

1. ship the host as the current build-digest-pinned single bundle and preserve the new
   descriptor-copy-to-scratch launch path;
2. pin/provenance the **Node image itself** rather than accepting whichever binary happens to
   exist first at `/opt/homebrew/bin/node`, `/usr/local/bin/node`, or `/usr/bin/node` (bundle a
   reviewed runtime, verify a signed platform artifact/package identity, or embed an independently
   release-pinned digest set);
3. retain lockfile integrity, SBOM/dependency review, signed Koni releases, reproducible artifact
   checks, and an explicit emergency/update policy for the complete bundle/runtime closure;
4. keep fd3 off public frames/logs and retain credential intent, transactional persistence,
   scratch isolation, redaction, and fail-closed teardown as defense in depth; and
5. add an adversarial provenance test that substitutes both host bundle and Node image and proves
   neither reaches fd3 or outbound network.

If Koni later needs to run user-selectable/unreviewed providers or plugins in this process, reverse
the recommendation: that extensibility makes a credential-bearing host TCB too broad, and the
Rust proxy/provider-adapter redesign becomes necessary. Destination filtering alone is not an
intermediate solution because a credential-bearing hostile client can exfiltrate through an
allowed provider request.

#### Live corrections accompanying this recommendation

- The earlier artifact wording about mutable `PATH`, `KONI_PI_HOST_DIR`, and a caller-chosen sibling
  checksum is superseded by current source. `PiRuntimeArtifact::discover` now searches only
  executable-relative host install roots, compares the package checksum to a digest embedded at
  Koni build time, disables `PATH` lookup for Node, and descriptor-copies/hash-verifies both Node
  and bundle into the owner-only scratch directory before launch. The remaining provenance gap is
  the initially discovered fixed-path Node image: its hash is learned from the local file rather
  than independently authorized by the Koni release.
- Login modify is now one-shot, and inference refresh now rejects an existing credential without a
  nonempty account ID before opening the transaction. Remove the earlier absent-account subcase
  from the current defect list. The transaction-lifetime defect remains: dropping
  `CredentialIntentGuard` still only clears `CredentialAuthority`; it does not wake the service
  loop or abort an already-open `ActiveTransaction`, so a successful terminal can retain the
  keychain lock until another fd3 frame or process teardown.
- Rust usage authority still accepts a too-small visible total. Current
  `usage_is_checked_for_overflow_subcounts_and_terminal_equality` deliberately accepts
  input=10, cache-read=2, output=5, total=15, and `add_usage` checks only overflow and
  reasoning<=output. This remains a P1 independently of the now-removed invalid cache<=input rule.
- Migration's new identity map and journal phase tests do not close the two publication P1s. The
  journal digest remains self-computable, `pending_publication_plan` still returns its embedded
  public plan, recovery still validates only that same plan's static shape, and destructive
  `retired_legacy_agents` are not rederived there. Publication still checks inode identity and
  then invokes pathname `fs::rename`; post-rename identity/hash validation detects a swap only
  after the wrong object has moved. The run proof is also a sequence of hash observations, not a
  registry lock/capability held across commit.

### 19:10 moving-source correction — Node and Codex output caps are now source-addressed

Two portions of the 19:02 recommendation changed again in the shared tree. Preserve the earlier
text as the reason for the repairs, but use this current-byte classification:

- `koni-core/build.rs` now selects one Node image at build time, hashes it, and embeds both path and
  digest as `KONI_PINNED_NODE_*`; runtime discovery accepts only a fixed/install-relative candidate
  whose bytes equal that embedded digest. `PiRuntimeArtifact::verify_expected` compares it again,
  and launch descriptor-copies/re-hashes the image into scratch. Thus “learns the Node hash only at
  runtime” is superseded. The remaining TCB release obligation is provenance of the **build** that
  selected those bytes: the build script still accepts an environment/PATH candidate and does not
  itself verify the stated minimum Node version or an external vendor signature. A signed trusted
  release pipeline can legitimately make the signed Koni binary plus embedded digest the trust
  root; local/untrusted builds cannot claim that provenance. Package/update/SBOM policy and a
  malicious-build-input regression remain required.
- The turn contract is now honestly named `output_token_budget`, explicitly excluding input and
  cache-read tokens. The host's Codex stream wrapper injects `max_output_tokens` through the
  provider's real `onPayload` boundary, recomputes remaining output allowance across tool rounds,
  aborts at exhaustion, and has source tests that inspect the serialized payload and fail an
  oversized provider report. This supersedes the definite finding that the production Codex
  request drops the cap. Treat it as source-addressed pending the nonzero pinned-provider and
  composed-process tests on a stable fingerprint.

Neither repair resolves the still-open trust-model choice. If Node is kept outside the credential
TCB, its TypeScript payload/usage checks are not Rust authority and it still receives raw secrets
plus outbound network. If the proposed host-TCB design is accepted, those checks may be trusted as
part of the reviewed bundle, with Rust retaining fail-closed protocol reconciliation as defense in
depth. `RuntimeUsage` still omits provider `cacheWrite`; Rust still accepts total values smaller
than the sum of the buckets it does expose and does not independently bind terminal output usage
to the requested output budget. Keep exact visible-usage/cache-write semantics as a P1 telemetry/
policy gate even though the request-cap transport defect is now source-addressed.

The current credential and migration bytes do not yet change their residual findings: intent drop
does not cancel an open `ActiveTransaction`; the recovery journal remains self-forgeable with an
embedded un-rederived retirement plan; publication renames remain pathname-based after identity
checks; and run-registry proof is not held across commit. Real engine composition also remains an
integration gate: `PiRuntimeProcess` and `DurableAgentToolBroker` still have no caller outside
their defining/export modules in `crates/**`.

### 19:16 P1 packaging defect — the pinned “single-file” host lazily imports an unstaged OAuth module

The rebuilt artifact is not actually self-contained for its production provider path. The bundle
contains this unresolved variable import at `runtime/pi-host/dist/koni-pi-host.mjs:21120-21132`:

```js
var importOAuthModule = (specifier) => import(/* rewritten variable specifier */);
var loadOpenAICodexOAuth = async () =>
  (await importOAuthModule("./openai-codex.ts")).openaiCodexOAuth;
```

This is deliberate upstream Pi behavior: `utils/oauth/load.js` hides Node-only OAuth code from
bundlers, and `lazyOAuth` invokes it on login, refresh, **and `toAuth`**. Thus an existing valid
credential does not avoid the import; ordinary model auth also needs it. The upstream module exists
only under `node_modules/@earendil-works/pi-ai/dist/utils/oauth/openai-codex.js`. Koni's runtime
artifact directory contains only `koni-pi-host.mjs`, its checksum, and declarations, while
`stage_verified_bundle` copies only the `.mjs` file into the isolated scratch directory. Relative
resolution therefore targets an absent scratch `openai-codex.ts` (or `.js` under a differently
named output), so authentication/inference fails closed with module-not-found.

The build checks do not exercise this boundary. `build-bundle.mjs` asks esbuild's metafile for
external imports, but a variable dynamic import has no statically enumerable external path.
`smoke-bundle.mjs` launches without fd3 and considers stopping at the credential-channel bootstrap
success; it never starts a session or invokes `toAuth`/refresh/login. This explains why the
purported isolated-bundle smoke can pass while the production provider cannot load.

Do not repair this by copying an unhashed module tree beside the bundle; that would invalidate the
host-TCB closure and reintroduce ambient dependency authority. Statically include the exact pinned
OAuth implementation and its dependencies via an explicit Koni provider adapter/build shim, or
stage a separately manifest-pinned closed artifact set and grant only those files. Add an isolated
artifact smoke with a fake fd3 credential and intercepted provider transport that forces all three
lazy paths (`toAuth`, refresh, device-code login) without `node_modules`, then assert no non-builtin
relative/dynamic module load escapes the signed manifest. This P1 is independent of whether the
architecture ultimately chooses host-TCB or a Rust-owned auth proxy.

### 19:21 live correction — Rust output-budget and visible-usage authority landed

Current `pi_runtime_state.rs` now carries the compiler-issued `output_token_budget` from the
pending StartTurn into `ActiveTurn`, rejects cumulative reported output above it, and rejects
checked `input + cacheRead + output > total`. New source regressions cover a cache-heavy valid
usage record, an output overrun, and the formerly accepted too-small total. The host also calculates
usage into a temporary value and publishes it only after consistency/output-cap checks. Therefore
the definite Rust finding that total=15 was accepted for visible buckets summing to 17 is
source-remediated; classify this gate as pending exact nonzero/composed verification, not current
unfixed code.

`cacheWrite` remains represented only in provider `total_tokens`, not as its own Rust/wire bucket.
That makes the Rust inequality intentionally a lower-bound rather than exact equality. Treat this
as an observability/cost-policy schema decision unless a compiler rule needs independent
cache-write values; it is no longer evidence that the visible total may undercount known buckets.
The credential-TCB decision still determines whether the Node-side provider normalization itself
is trusted. The abandoned credential transaction, lazy OAuth bundle import, migration recovery/
rename/run-barrier defects, and missing real engine composition remain unchanged at this snapshot.

### 19:29 current security blocker checklist

This is the concise current-byte classification requested by `primary-integrator/root`. Historical
findings above remain the repair record; do not count a superseded item twice.

#### Architectural decision — P0 hold

- **Credential TCB boundary remains unchosen.** Current Node receives raw access/refresh material
  and general outbound network. Either make Rust own allowlisted provider TLS/auth so Node is
  secret-blind, or explicitly put the exact host/Node/dependency closure in the credential TCB.
  This review recommends the latter for the first cut because Pi's current Codex auth/transport is
  tightly coupled, but the owner has not frozen that choice. Under the TCB option, signed build/
  package provenance, dependency/SBOM/update policy, and corrected threat-language are mandatory;
  under the proxy option, current fd3/network composition is not admissible.

#### Definite current source defects — release blockers

- **P0/P1 Linux containment launcher substitution:** `runtime_containment.rs::find_executable`
  resolves `bwrap` from mutable runtime `PATH`, then executes that unverified program with the
  private credential fd. A fake launcher can ignore every bubblewrap argument, consume fd3, and
  use ambient network. Bind a fixed independently authorized launcher/package identity through
  race-free exec and reject malicious PATH substitution. Also replace broad
  `--dev-bind /dev /dev` with a minimal new device namespace (`--dev /dev`) unless an exact pinned
  need proves more authority is required.
- **P1 incomplete host artifact:** the emitted “single-file” `.mjs` retains Pi's variable lazy
  `./openai-codex.ts` import, required by stored-credential `toAuth`, refresh, and login, while
  production stages only the bundle. It fails module resolution from isolated scratch. Statically
  bundle the pinned OAuth closure or manifest-pin/stage a closed multi-file artifact; exercise all
  three auth paths in the isolated smoke.
- **P1 intent teardown:** dropping/expiring `CredentialIntentGuard` clears authorization but does
  not synchronously abort an already-open fd3 `ActiveTransaction`. A successful host terminal can
  leave the per-user keychain lock held until another frame or process exit. Guard close/cancel/
  expiry must wake or share transaction state and abort the matching transaction before the Rust
  operation returns.
- **P1 forgeable migration recovery:** `publication-journal.json` is self-authenticated only by a
  recomputable SHA and supplies the pending public plan; recovery does not rederive destructive
  `retired_legacy_agents`. Compiler-owned/authenticated recovery state plus rederivation is still
  required, with unrelated-source and `.git` sentinels.
- **P1 migration publication races:** inode/hash checks are followed by pathname `fs::rename`, so
  a synchronized ancestor/leaf exchange can move the wrong object before post-move detection.
  The opaque run proof likewise rehashes registry/receipts at points but does not hold run authority
  across publication. Use descriptor-relative no-follow publication and a run-registry barrier/
  capability spanning commit.

#### Source-closed; exact stable-fingerprint verification still pending

- public host/state correlation, terminal reconciliation, broker/callback/protocol-error
  terminate+reap, process-group cleanup, owner-only scratch/diagnostics, and secret redaction;
- build-time Node digest pin plus descriptor-copy/re-hash launch, and build-time bundle digest pin
  (subject to the selected signed-build provenance and the OAuth-closure defect above);
- operation-scoped credential intents, one-shot login/logout/refresh mutation, nonempty same-account
  refresh binding, UID-stable no-follow keychain lock, and persistent CAS (excluding active-
  transaction teardown above);
- honest `output_token_budget`, serialized Codex `max_output_tokens`, multi-round remaining cap,
  Rust output-cap binding, checked visible usage lower bound, cache-heavy acceptance, and overrun/
  inconsistent-total rejection;
- browser-PKCE refusal/device-code route and bounded OAuth timeout/cancel;
- concrete `DurableAgentToolBroker`, context-first/replay/CAS/output closure, and host-local invalid-
  tool reconciliation; and
- migration ancestor-symlink checks, schema-field-scoped transforms, staged compiler validation,
  opaque registry/receipt-bound run proof, fsynced phase journal, and idempotent recovery mechanics
  (excluding journal authority and publication races above).

No green claim for this section comes from this review lane: it ran no Cargo/npm/auth/migration/
containment/live-process command. Retain the named nonzero adversarial suites and complete frozen
matrix on one immutable fingerprint.

#### Integration/cutover gaps

- **No real engine composition:** repository search still finds no caller of `PiRuntimeProcess` or
  `DurableAgentToolBroker` outside their defining/export modules. No production path yet proves one
  exact compiler grant -> pinned process -> fd3 intent -> brokered tools -> terminal receipt flow.
- Schema-2 migration and historical-reader cutover are not an installed capability; no fallback
  from a migrated Pi project to Codex is permitted, so publication must wait for every source
  defect and frozen matrix item above.
- Packaging still needs one closed signed host/Node/OAuth/launcher dependency manifest, clean-build
  reproducibility/version proof, macOS/Linux policy smokes, and an adversarial artifact-substitution
  test. A source-embedded digest from an untrusted local build is not release provenance.

### 19:16 moving-source correction — OAuth closure, Linux launcher, and intent teardown

Preserve the 19:29 checklist as the snapshot that drove these repairs, but do not count three of
its source defects unchanged on the current bytes:

- **OAuth closure is source/artifact-addressed.** `src/openai-codex-provider.ts` now constructs the
  exact OpenAI Codex provider with a static import of the pinned OAuth implementation. The rebuilt
  `dist/koni-pi-host.mjs` contains that implementation and no longer contains
  `importOAuthModule`; the isolated smoke now imports the copied bundle with no module tree and
  forces `toAuth`, expired-token refresh, and device-code login through fake transport. Retain a
  stable-fingerprint nonzero smoke/reproducibility gate and include these bytes in the selected
  signed credential-TCB manifest, but remove the variable-import module-not-found defect from the
  current blocker list.
- **The obvious Linux launcher substitution and broad-device defects are source-addressed.** The
  build now embeds the selected bubblewrap digest, runtime discovery ignores `PATH` and accepts
  only a fixed/install-relative candidate with those exact bytes, and the policy uses bubblewrap's
  minimal `--dev /dev` namespace. A residual authority gap remains: discovery hashes the canonical
  launcher and later executes its pathname, unlike the descriptor-copy/re-hash path used for Node
  and the host. A writable packaged launcher can therefore be exchanged between verification and
  spawn. Bind/stage the opened bytes race-free or require and verify a root-owned package identity;
  build-time environment/PATH selection is legitimate only beneath the explicit signed-build TCB.
- **Abandoned transaction retention is now bounded, not indefinite.** The credential service polls
  fd3 with a 50 ms read timeout, checks the current intent before each read, and aborts an active
  transaction after guard revocation; the direct unit exercises the abort primitive. `Drop` still
  only clears shared intent and does not synchronously acknowledge service-side abort before the
  public operation can return. Treat this as source-addressed pending an exact service-thread test
  and an owner decision that the bounded residual window is acceptable, or add a wake/ack barrier
  if return-time release is the contract.

Two current defects remain unchanged at this fingerprint. `pi_runtime_state.rs::add_usage` still
computes `visible_total` from `next.input_tokens` plus the **previous** `total.cached_input_tokens`
and `total.output_tokens`, so its first-delta inconsistent-total regression must fail until all
three operands use `next`. Migration recovery still trusts a recomputable journal plus its embedded
public destructive plan, uses verify-then-pathname-renames, and drops run barriers before the CLI
calls `Schema2Migrator::apply`; those remain P1 publication-authority blockers. Repository search
still finds no production caller of `PiRuntimeProcess`; the new Software direct-broker occurrence
in `engine.rs` is a test, not the real composed execution path.

#### 19:17 usage correction after the preceding moving-source snapshot

The usage sentence immediately above was accurate for the bytes inspected before the 19:14 source
update. Current `add_usage` now computes the complete visible lower bound from
`next.input_tokens + next.cached_input_tokens + next.output_tokens`, with checked overflow, before
assigning `next` into durable state. The regression set also adds a cache/output-heavy total of one
and requires rejection. Move this item back to source-addressed, stable-fingerprint/composed-test
pending; keep both earlier regressions as chronology because this accumulator changed twice during
the integration window. Migration publication, residual launcher exec identity, credential
teardown semantics, the credential-TCB decision, and real engine composition remain open.

### 2026-07-14 19:21 MST — final save-point verdict

Status: `review_complete_security_holds_open`. This verdict freezes the read-only review at the
save point requested by `primary-integrator/root`; later edits require a fresh review. Representative
audited SHA-256 values are `pi_runtime_process.rs` `2cfbf8c0…dea5`,
`runtime_containment.rs` `d3720060…3c3c`, `pi_credential_service.rs` `11758798…ad5`,
`pi_runtime_state.rs` `7c1f7a13…b540`, `schema2_migration.rs` `c6b424cc…f451`, and the
matching host bundle `40337dae…573d`.

#### Architectural P0 hold

- The credential trust boundary is not frozen. For the first cut this review recommends making
  the exact Koni host, pinned Pi SDK closure, Node image, and required launch/runtime closure an
  explicit credential TCB. That requires a signed/reproducible build and package provenance root,
  lockfile/SBOM/update policy, and threat-language that no longer calls those exact bytes
  adversarial. If selectable/unreviewed providers or plugins enter that process, this recommendation
  no longer holds and Rust must own the provider auth/transport boundary.

#### Definite current source blockers

- **P1 Linux launcher identity race.** Bubblewrap no longer comes from runtime `PATH`, its build
  digest is embedded, and `/dev` is minimal; however Rust hashes the canonical launcher and later
  spawns the pathname. A writable packaged launcher can be exchanged between those operations.
  Bind the opened bytes through exec or prove an independently immutable/root-owned package
  identity through launch, then retain the malicious-PATH and synchronized-swap cases.
- **P1 migration pathname publication race.** Current recovery still verifies inode/hash and then
  calls pathname `fs::rename` for the legacy config, retired agents, and staged destination. A
  synchronized ancestor/leaf exchange can move the wrong object before post-move detection. Use
  no-follow descriptor-relative publication (or an equivalent race-free primitive) and prove the
  swap cannot move a source or `.git` sentinel.

#### Source-addressed, but not released without stable nonzero evidence

- The OAuth implementation is now statically bundled; the artifact has no prior
  `importOAuthModule`, its checksum matches, and the isolated smoke source forces `toAuth`, refresh,
  and device-code login. Signed closure/reproducibility and an actual green isolated run remain.
- Node, host bundle, and bubblewrap have build-embedded digests; Node and bundle are
  descriptor-copied/re-hashed into owner-only scratch. The signed-build provenance decision and
  bubblewrap exec race above remain.
- Credential mutation is intent-scoped, one-shot, same-account/CAS-bound, and revoked active
  transactions are polled and aborted within 50 ms. The former indefinite lock is closed in
  source; retain an actual service-thread abandoned-frame test and either prove bounded teardown is
  the public contract or add synchronous abort acknowledgement before returning.
- Output authority now uses `output_token_budget`, injects Codex `max_output_tokens`, reconciles
  terminal usage, and computes Rust's checked visible lower bound entirely from next-state input,
  cache-read, and output. Keep first-delta, cumulative, cache-heavy, provider-overrun, and terminal
  cases on one composed fingerprint.
- Migration journal authority materially changed at the end of this review: the journal moved to
  compiler-owned Git-common state, recovery rederives the complete legacy/resource plan and reruns
  profile compilation, and the opaque proof now carries migration/registry/per-run guards through
  `Schema2Migrator::apply`. Thus the earlier model-writable forged-plan and dropped-run-barrier
  defects are source-addressed, not current definite blockers. The moving caller/test fixtures and
  forged-journal/late-run/crash matrix still need a stable compiling fingerprint; the pathname
  race above remains independently red.
- Public protocol correlation, terminal/tool latching, terminate/reap behavior, scratch/log
  redaction, device-code-only contained OAuth, and the concrete durable broker remain
  source-addressed pending the frozen adversarial matrix.

#### Composition/cutover disposition

- The earlier “no real caller” finding was superseded during this audit: current Engine/agent
  source now contains production `PiRuntimeProcess` composition, including direct durable-broker
  setup and the planning/review launcher. It landed while the tree was still moving and has not
  received an independent stable-fingerprint adversarial run, so it is **integration-unreleased**,
  not “missing.” Require one exact compiler grant -> pinned contained process -> fd3 intent ->
  durable broker -> terminal receipt proof, plus failure/cleanup and token-budget cases, before
  cutover.
- Schema 2 and Pi remain unreleased and must not fall back to Codex after migration. No Cargo/npm,
  auth, migration, containment, process, install, live-project, cmux, Updog, or forensic-run action
  was performed by this review lane.
