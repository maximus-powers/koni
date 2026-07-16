# Direct Pi runtime

> **Current 2.0 runtime contract — 2026-07-14.** This document records the replacement of the
> executable Codex integration with a Koni-owned host built directly on Pi. Older Codex contracts
> remain in the adjacent documentation as migration history; they are not executable fallbacks.

> **Release-status clarification — 2026-07-14:** “Current” above names the target schema-2
> contract under implementation, not an integrated or installed release. Schema 1 remains the
> executable pre-cutover reader until migration, and no guarded refresh or live project migration
> is authorized before the security, migration, compatibility, and immutable-fingerprint matrix
> below is green.

Koni uses Pi as its model loop and keeps Rust as the deterministic authority. This is a complete
runtime replacement, not a second backend: a migrated project cannot silently fall back to
`codex exec`, Codex app-server, the Pi CLI, an OpenAI API key, or an ambient community extension.

## Why this boundary exists

The former integration treated Codex as a large external agent process. Koni could compose prompts,
start sessions, and inspect JSONL, but the model loop, session controls, auth lifecycle, tool
transport, and event vocabulary lived behind the CLI/app-server boundary. The direct Pi host makes
those pieces application code that Koni can version and test:

- native streaming events instead of reconstructing a conversation from CLI output;
- first-class steering, follow-up, cancellation, usage, retry, and compaction signals;
- typed tools whose implementation remains inside the existing compiler grant/CAS boundary;
- model metadata and thinking levels from the same provider object used for inference;
- subscription OAuth refresh through a Koni-owned credential store;
- deterministic context transforms and durable session records that Koni owns;
- a small replaceable model transport without moving Git, graph, or receipt authority into Node.

Pi deliberately has no built-in permission system. Koni therefore treats the host as an untrusted
transport peer and applies its own operating-system containment. This follows Pi's published
[permissions and containerization guidance](https://github.com/earendil-works/pi#permissions--containerization)
while preserving Koni's stricter compiler-owned tool boundary.

> **Credential trust-model correction — 2026-07-14:** The “untrusted transport peer” statement
> above is the intended boundary, but the current design does not satisfy it. The host receives raw
> access/refresh credentials through fd 3 while also receiving outbound network authority; a
> malicious or substituted host can exfiltrate them without using public frames, so redaction and
> tool grants are irrelevant to that path. Before release, choose and document one coherent model:
> either keep Node outside the credential TCB by routing provider traffic through a Rust-owned,
> destination-allowlisted TLS proxy that injects auth and denies general host outbound, or explicitly
> place the pinned host and its dependency closure inside the credential TCB and establish an
> independent signed artifact/provenance and race-free execution chain. The current mutable PATH/
> sibling-digest trust root makes the second choice especially unsafe until repaired. No Pi cutover
> is authorized while the prose and implementation disagree on this boundary.

> **First-cut architecture recommendation and source correction — 2026-07-14:** Current source no
> longer discovers Node/host from mutable PATH, environment, or a sibling-provided digest; preserve
> those hazards above as the discovery that drove the repair. The remaining trust problem is that
> the fixed Node identity is learned locally rather than authorized by an independent release root.
> For the first production cut, the security review recommends explicitly placing the exact pinned
> Pi host, SDK bundle, Node runtime, and dependency closure in the credential TCB. Pi's Codex
> provider locally parses the token/account, constructs bearer requests, and owns streaming,
> retries, compression, login, and refresh; a genuinely secret-blind Rust proxy would amount to a
> Koni-owned provider adapter or fork. The TCB route still requires release signing/provenance,
> lockfile/SBOM and update policy, immutable packaging, and race-free execution. Node remains
> untrusted for compiler tools, graph, Git, and filesystem authority even if it is explicitly
> trusted for provider credential use. This is a recommended target pending architect acceptance,
> not a release declaration.

> **Build-time pinning correction — 2026-07-14:** Current source now selects and hashes Node during
> the Koni build, embeds its path/digest, verifies that identity again, and descriptor-copies plus
> rehashes Node into scratch before launch. This supersedes “learned only at runtime.” The remaining
> TCB requirement is provenance of the build that chose those bytes: a signed trusted release may
> anchor the embedded digest, while a local/untrusted build whose build script accepts environment/
> PATH input cannot claim that authority. Verify minimum version/vendor identity in the trusted
> pipeline and retain signed-release, SBOM/lockfile/update, and malicious-build-input evidence.

## Components and authority

```text
Koni engine (Rust)
  graph / rules / tickets / pipeline / receipts / Git / questions
  broker grants + context-first/CAS/replay checks
  OS keychain + containment + process supervision
                    │
                    │ versioned bounded NDJSON over private stdio
                    ▼
Koni Pi host (Node >= 22.19)
  @earendil-works/pi-agent-core Agent
  @earendil-works/pi-ai Models + openaiCodexProvider
  streaming model loop + transient conversation state
                    │
                    │ ChatGPT subscription OAuth
                    ▼
openai-codex provider
```

> **Credential-storage transition — 2026-07-14:** Preserve `OS keychain` in the original diagram
> as the earlier design. Current source instead keeps Pi's OAuth material in the operating-system
> account's Koni-owned `~/.koni/auth.json`, behind the same private Rust fd-3 broker. This avoids
> executable-identity prompts and login loss when an ad-hoc local build is upgraded. The file is
> plaintext to its owning account, like Pi's normal local credential file, but its directory/file
> modes are exactly `0700`/`0600`; bounded no-follow reads, owner/type/link checks, atomic replace,
> file and directory fsync, a UID-stable lock, and revision CAS fail closed on unsafe state. Koni
> neither imports nor mutates `~/.pi/agent/auth.json` or `~/.codex/auth.json`.

> **Project-namespace disjointness correction — 2026-07-14:** The `~/.koni/auth.json` path above
> is the first file-backed checkpoint, retained as design history. Because `.koni/` is also the
> schema-2 project root, a repository initialized directly at the account home could collide with
> that path. Current source uses the account database only to anchor a conventional application-
> state location: `~/Library/Application Support/Koni/auth.json` on macOS and
> `~/.local/state/koni/auth.json` on Linux. It accepts no environment path override. Exact
> owner-only UUIDv7 temporary files left by a hard crash are now reaped under the UID credential
> lock and directory-fsynced; lookalikes, symlinks, unsafe modes, and non-Koni files are preserved.

> **Pi-native authentication supersession — 2026-07-16:** The Koni-owned account file and Rust
> fd-3 credential authority above remain the current raw-host compatibility checkpoint, not the
> target credential source. The accepted next architecture makes Pi `AuthStorage` canonical
> wherever Pi supports the provider. A supervised Pi-owned backend/service owns login, refresh,
> locking, and persistence; Rust stores only provider/model plus a nonsecret opaque account/auth-
> generation binding and migration status, never provider secret material. Autonomous sandboxes
> must not mount or discover the complete `~/.pi/agent` directory. The old Koni store remains a
> guarded import/fallback only until its explicit verification and deletion gates pass, with no
> simultaneous refresh writers. Stock Pi 0.80.7 locks cross-process refresh but rewrites
> `auth.json` in place, so a Pi-side atomic backend or reviewed upstream upgrade is a production
> migration gate. See [Pi-native session, resource, and authentication migration](pi-native-migration.md).

Rust is authoritative for every externally meaningful effect. The host cannot read or write the
workspace through a Pi built-in tool, spawn a shell, mutate Git, edit compiler state, accept a
question, or publish a receipt. It receives only the tool schemas issued for one pinned attempt and
round-trips each call to Rust. Rust revalidates the attempt and executes the same compiler-owned
tool implementation used before the transport migration.

The host package pins both direct dependencies to `0.80.7`:

- `@earendil-works/pi-agent-core@0.80.7`
- `@earendil-works/pi-ai@0.80.7`

It imports `Agent`, `createModels()`, and `openaiCodexProvider()` directly. It does not depend on
`pi-coding-agent`, invoke `pi`, load Pi project resources/extensions, use Pi RPC, or adopt the
experimental orchestrator. Pi's stable `Agent` surface provides lifecycle events, sequential tool
execution, steering/follow-up queues, abort, and context transformation; the provider collection
owns auth application and token refresh. See the upstream
[`Agent` documentation](https://github.com/earendil-works/pi/tree/v0.80.7/packages/agent) and
[`Models` implementation](https://github.com/earendil-works/pi/blob/v0.80.7/packages/ai/src/models.ts).

> **Lazy OAuth bundle-closure hold — 2026-07-14:** Pinning the direct packages and producing one
> host file does not currently make that file self-contained. Upstream Pi retains a variable lazy
> import of `openai-codex` OAuth, used by ordinary stored-credential `toAuth` as well as refresh and
> login. The production launcher stages only `koni-pi-host.mjs` into isolated scratch, while the
> referenced OAuth module remains under unstaged/unreadable `node_modules`; the existing smoke exits
> at missing fd 3 before exercising this path. Statically bundle the exact OAuth closure through a
> build adapter/shim, or manifest-pin and stage every required module without ambient dependency
> copying. Add an isolated fake-fd3/fake-provider packaging smoke that forces stored-credential
> `toAuth`, refresh, and device-code login with no `node_modules` available. This closure is part of
> the recommended host credential TCB and must be covered by its provenance/SBOM.

> **OAuth closure remediation checkpoint — 2026-07-14:** Current host source statically imports a
> pinned OAuth adapter; the rebuilt distribution no longer retains `importOAuthModule`, and the
> packaging smoke now forces isolated stored-credential `toAuth`, refresh, and device-code paths.
> Treat the missing-module defect as source/artifact-addressed pending exact nonzero verification on
> the final signed fingerprint. Preserve the closed dependency set in the TCB manifest/SBOM.

## Wire protocol

Every line on stdin or stdout is one bounded JSON frame. Each public frame carries a protocol
version, session id, monotonically increasing direction-local sequence number, and request or event
identity. Blank, oversized, malformed, unsupported-version, cross-session, duplicate, and
out-of-order frames terminate the complete supervised host process group.

Public commands cover session start, turn start, steering, follow-up, cancellation, and shutdown.
Public inbound frames cover acknowledgements, canonical runtime events, and first-party tool calls.
Canonical events include:

- turn start/completion and final stop reason;
- message start/delta/completion;
- tool start/update/completion;
- usage and cache/reasoning token counts;
- retry attempt/delay/reason;
- compaction boundaries and summary hashes;
- bounded, sanitized runtime failures.

> **Completed-message projection transition — 2026-07-15:** The list above preserves the original
> wire vocabulary, including `message_delta`. Current production inference does not export raw
> provider text deltas across the host boundary. Codex streams can split one response into
> thousands of tiny fragments, while Koni's durable logs, TUI chat, schema validation, and agent
> output all consume the authoritative `message_completed` event. The verified host therefore
> retains deltas internally and publishes one bounded completed message, preventing useful
> synthesis from exhausting the 4,096-event Rust transcript guard. The delta wire variant remains
> reserved for a future explicitly coalesced streaming contract.

> **Same-session bounded-planning transition — 2026-07-15:** Direct planning now performs bounded
> repository exploration and structured synthesis as two turns in one live Pi host/session. A
> compiler-terminal final read closes the first turn while preserving its result and conversation;
> the second turn has no repository authority and must return the schema-valid artifact. Run types
> configure the shared read budget with `planning.max_repository_tool_calls`. Planning prose is
> capped at 24,000 characters and direct-Pi output at 16,384 local tokens so the full execution
> artifact remains below the downstream 32 KiB-per-pass projection instead of spending on repeated
> prompt material. A failed process always pauses for operator resume; retryability still describes
> provider transience and does not authorize a blind new-process replay.

Credential traffic is a separate private frame family. It supports only `read`, serialized
`modify.begin`/`modify.commit`/`modify.abort`, and `delete`. Token-free authorization URLs,
device codes, and progress cross the public event stream; secret or manual-code input is never
accepted on public stdio, and a flow that would require it retries through device authorization.
The credential frames necessarily contain OAuth material while crossing the private pipe, but they are not
`RuntimeEvent`s, cannot be appended to transcripts, have redacted debug output, and never enter
argv, environment variables, prompts, errors, receipts, or logs.

> **Browser-flow transition — 2026-07-14:** Preserve the paragraph above as the original
> fail-closed design. Koni now follows Pi's normal local UX: `koni auth login` selects browser PKCE,
> opens the pinned `https://auth.openai.com/oauth/authorize` URL, and lets Pi receive the result on
> its localhost callback. Pi's optional manual-code prompt remains pending only inside the host
> while the callback races it; no code or token input was added to public stdio. Device-code support
> remains in the pinned provider and isolated tests, but it is no longer Koni's normal local login.

> **Implementation security hold — 2026-07-14:** The paragraph above remains the required runtime
> contract, not a claim that the current host already satisfies it. An adversarial review found
> that quoted JSON OAuth fields in an upstream malformed-response error can evade the current
> redactor before the credential is registered, then reach a public rejection or the outer stderr
> handler. Release now requires allowlisted provider error projection, outer-catch redaction,
> defensive coverage of quoted token and device-flow fields, and negative tests proving secrets
> never enter public frames, stderr, durable events, or transcripts.

> **Provider-error projection closure — 2026-07-14:** Preserve the hold above as the discovery
> record. Current source projects arbitrary provider failures onto seven fixed public tuples:
> usage limit, authentication, access denial, request rejection, transient rate limit, transient
> unavailability, or unknown. Classification may inspect only a bounded hint and never returns or
> persists it. Rust rejects any code/message/retryable mismatch before callbacks or transcripts,
> retains the validated retry disposition in a typed turn failure, and publishes only the canonical
> action text to durable agent state. `retryable` describes provider transience, not replay safety:
> a failed planning turn is paused for explicit operator resume rather than relaunched blindly.
> Host runtime/protocol tests include hostile unknown values and complete secret-negative public,
> snapshot, and stderr assertions.

## Subscription OAuth only

The only provider is Pi's `openai-codex` provider, whose upstream definition targets the ChatGPT
Codex backend and advertises “OpenAI (ChatGPT Plus/Pro).” Koni calls the provider's own OAuth login
implementation, including browser PKCE and headless device-code flows, rather than copying the
OAuth client protocol. The provider source is
[`openai-codex.ts`](https://github.com/earendil-works/pi/blob/v0.80.7/packages/ai/src/providers/openai-codex.ts),
and the flow is implemented in
[`utils/oauth/openai-codex.ts`](https://github.com/earendil-works/pi/blob/v0.80.7/packages/ai/src/utils/oauth/openai-codex.ts).

Koni persists the resulting type-tagged OAuth credential per OS user in Keychain Services on macOS
or Secret Service on Linux. It never imports `~/.codex/auth.json` or `~/.pi/agent/auth.json` and
rejects `api_key` credentials. A per-user cross-process lock spans Pi's complete
`CredentialStore.modify` callback so concurrent hosts cannot double-refresh a rotating token.

> **Credential-serialization hold — 2026-07-14:** The sentence above remains the required
> contract. The current lock path is derived from mutable `TMPDIR`, so two same-UID processes with
> different temporary directories can take different locks, read the same keyring revision, and
> both commit a replacement refresh token. Release requires one UID-stable OS lock namespace,
> keyring-current revision validation at commit, and a real two-process/different-`TMPDIR`
> regression proving only one modification enters and a stale revision cannot commit.

> **Current-source remediation checkpoint — 2026-07-14:** The hold above remains the discovery
> history. Current bytes now derive the lock from canonical `/tmp` and UID, open the lock with
> no-follow/CLOEXEC, and re-read the persistent keyring revision before commit; focused source also
> contains distinct-`TMPDIR` process serialization and stale-CAS tests. This changes the defect from
> unfixed to verification/re-review pending. It is not an integrated Pi release by itself.

> **Upgrade-stable credential supersession — 2026-07-14:** The Keychain Services/Secret Service
> paragraph and `keyring` wording above are now historical. Ad-hoc macOS rebuilds receive a new code
> identity, so Keychain can prompt or block after an otherwise ordinary Koni upgrade. Current source
> removes that dependency and uses the Koni-owned owner-only account file described above. It keeps
> the same OAuth-only validation, operation-scoped fd-3 authority, UID-global serialization, and
> revision-CAS semantics. This intentionally chooses predictable Pi-style local persistence over an
> OS-encrypted-at-rest store; release signing plus a deliberate Keychain ACL migration can be
> reconsidered later without changing the browser-login UX.

> **Canonical-owner evolution — 2026-07-16:** Preserve the preceding Koni-owned-store decision as
> the history of the low-level host. The next session-runtime generation instead uses Pi's normal
> authentication authority and a Pi/Node-owned `AuthStorageBackend`; Rust no longer reads, writes,
> refreshes, or transports provider credentials. Legacy credentials migrate through a guarded,
> single-writer Pi-side transaction and are deleted only after a fresh-process verification and
> explicit retention decision. Exact target constraints and deletion gates are in
> [Pi-native session, resource, and authentication migration](pi-native-migration.md).

> **Credential-intent authority hold — 2026-07-14:** Locking and fd-3 secrecy do not by themselves
> authorize credential mutation. The current private service accepts `read`, global `modify`, and
> `delete` throughout a generic lease without knowing whether Rust has authorized login, logout,
> or refresh. Because the host is untrusted, release requires operation-scoped, expiring authority:
> one-shot delete only for an outstanding logout, login write only during outstanding login, and
> serialized identity-preserving refresh during inference. Fake-host tests must reject unsolicited
> delete/replacement during metadata, model listing, ordinary turns, and after intent expiry.

> **Credential teardown remediation checkpoint — 2026-07-14:** A bounded fd-3 read wakeup now
> notices revoked intent and aborts its active transaction, removing the indefinite-lock behavior in
> source. The public guard drop is not synchronously acknowledged by the service before returning,
> so retain a bounded teardown/acknowledgement test across success, error, timeout, cancellation,
> and silent host. Classify this as source-addressed/test-pending rather than an unbounded current
> lock defect.

This use is intentionally narrower than general OpenAI API authentication. OpenAI documents
ChatGPT sign-in as the subscription path for local Codex surfaces and Platform API keys as the
usage-billed path; this Koni runtime implements only the former. See OpenAI's
[authentication documentation](https://learn.chatgpt.com/docs/auth).

## Containment

The host begins with an empty environment and receives only explicit non-secret values. Koni
removes common model-provider/API-key variables regardless of caller input. The process is its own
group leader and is killed and reaped on protocol, persistence, timeout, or parent failures.

- macOS uses `/usr/bin/sandbox-exec` with a generated Seatbelt policy. The host can execute only
  the pinned Node image, read only its pinned package plus isolated scratch/TLS roots, write only
  that scratch space, and open outbound network connections only when explicitly granted.
- Linux uses `bwrap --die-with-parent --new-session --unshare-all` with an empty root assembled
  from system-runtime, pinned-package, certificate, and isolated-scratch binds. It does not mount
  the project, home directory, or machine root; its network namespace stays isolated unless
  network was granted.
- If the required containment implementation is absent, Koni refuses to start the host.

> **Browser-OAuth containment hold — 2026-07-14:** The bullets above remain the containment goal,
> but the current macOS policy grants only `network-outbound`. Pi's browser OAuth binds a localhost
> callback server, which Seatbelt denies without separate bind/inbound authority; Pi then requests
> manual input while the host waits only for abort, producing an unbounded login hang. Release must
> either grant an exact loopback-only callback capability and prove it under the compiled policy,
> or detect the unavailable callback and fail fast into device-code flow. Both paths need bounded
> timeout/cancellation tests and proof that no callback server or login controller survives.

> **Browser-OAuth containment transition — 2026-07-14:** Current macOS source takes the first path.
> Only the short-lived login bootstrap may request callback authority, it also requires explicit
> outbound networking, and Seatbelt grants exactly `(local tcp "localhost:1455")`; inference,
> model discovery, status, and logout retain no inbound grant. The compiled filter was exercised
> against a real loopback listener: port 1455 accepted a callback while 1456 was denied. Linux
> browser login remains fail-closed pending its dedicated network broker.

> **Linux containment-launcher hold — 2026-07-14:** The Linux policy currently resolves `bwrap`
> through mutable `PATH` and then gives that unverified launcher the private credential fd. A fake
> user/workspace binary can ignore containment and exfiltrate credentials even if Node and the host
> bundle are perfectly pinned. Select a fixed root-owned launcher, authorize it through the signed
> build/package trust root, and bind its identity race-free through execution; an adversarial PATH
> substitution must never reach fd 3. Also replace `--dev-bind /dev /dev` with bubblewrap's minimal
> `--dev /dev` namespace unless one exact pinned device need is justified and tested. This is a
> definite Linux source blocker, not merely defense-in-depth hardening.

> **Linux launcher remediation checkpoint — 2026-07-14:** Current source build-pins a bubblewrap
> digest, rejects a PATH candidate whose bytes differ, and uses minimal `--dev /dev`. This closes the
> direct fake-PATH/broad-device shapes in source. A hash-then-path execution race remains: the
> verified canonical launcher is later spawned by pathname and can be replaced if its install root
> is writable. Stage/descriptor-bind bubblewrap like Node, or prove a root-owned immutable package
> identity through exec. Build-time PATH selection is acceptable only inside the explicit signed-
> build trust decision.

> **Process-composition security hold — 2026-07-14:** The current public launcher still accepts a
> forgeable artifact value, discovers the first PATH `node` after only a version probe, trusts a
> writable co-located checksum, and does not bind launch to the verified opened bytes. Callback,
> broker, and protocol errors can return without terminating the child, and low-level stderr
> creation follows symlinks. Release requires an opaque independently trusted artifact, launch-time
> identity/hash binding, fail-closed cancel/terminate/reap on every error exit, and compiler-owned
> no-follow diagnostics. Test malicious PATH and post-verify swaps, callback/broker failures with
> no continued token spend, and stderr leaf/ancestor symlink attacks.

> **Composition rebaseline — 2026-07-14:** Preserve the hold above as the discovery snapshot.
> Current source makes raw host construction crate-private, stages and rehashes the host beneath a
> fresh 0700 scratch root, fixes diagnostics there, rejects unsupported browser PKCE before launch,
> bounds login, redacts OAuth failures, emits a terminal host frame on failed turns, checks usage
> integers, wires the Pi state machine, provides the concrete broker, and terminates the host on
> public run/auth/list/metadata/session wrapper errors. Remaining release blockers are the mutable
> PATH/sibling-digest trust root and rehash-to-exec race; private credential transactions that can
> outlive their intent and retain the keychain lock; independently binding a nonempty account
> identity for refresh persistence; and exact terminal/usage/budget evidence.

> **Production-composition transition — 2026-07-14:** The earlier “exported pieces but no real
> caller” finding is now superseded in source. Engine/agent paths compose `PiRuntimeProcess` with the
> durable broker for planning/review/worker launch. That moving implementation is integration-
> unreleased: require one exact compiler grant -> pinned contained process -> fd-3 intent -> brokered
> tools -> terminal receipt proof, plus failure cleanup and output-budget cases, on the final signed
> fingerprint before cutover.

> **Token-budget truthfulness hold — 2026-07-14:** The host passes a remaining value as
> `options.maxTokens`, but the pinned `openai-codex` request builder does not read that option or
> serialize `max_output_tokens`. The actual provider response is therefore uncapped by Koni's
> advertised `token_budget`; a post-message abort occurs after billing/emission. Release must
> inspect the serialized Codex request and force an oversized single response through an exact
> integration test. If the enforceable primitive is an output cap, name and meter it as such;
> claim a hard total-token budget only if input/cache reservation plus output enforcement proves
> every terminal total stays within the bound. Rust must also reject inconsistent usage buckets,
> including input plus cache-read plus output exceeding the reported total.

> **Output-cap remediation checkpoint — 2026-07-14:** Preserve the uncapped-request paragraph as
> the defect that drove the repair. Current source renames this primitive
> `output_token_budget`, explicitly excludes input/cache tokens, injects `max_output_tokens` at the
> real Codex `onPayload` boundary, carries the remaining allowance across tool rounds, aborts at
> exhaustion, and includes source tests for serialized payload and oversized provider usage. Treat
> this as source-addressed pending nonzero pinned-provider/composed-process evidence. Rust still
> needs exact visible bucket consistency (including provider cache-write semantics) and terminal
> reconciliation against the requested output cap.

> **Rust usage-authority correction — 2026-07-14:** Current Rust state now binds
> `output_token_budget` into the active turn, rejects cumulative output above the cap, and rejects
> checked input plus cache-read plus output above reported total. Source regressions cover a valid
> cache-heavy event, output-cap overrun, and the former too-small-total case; the host checks before
> publishing. Treat the definite Rust undercount/cap omission as source-remediated pending nonzero
> composed verification. Provider cache-write remains folded into total rather than exposed as a
> separate field; that is now an observability/schema choice unless a policy needs the bucket.

> **Moving-source usage regression — 2026-07-14:** The remediation checkpoint above is preserved,
> but current `visible_total` mixes `next.input_tokens` with the previous totals' cache-read and
> output fields. A first delta can therefore be accepted even when its visible buckets exceed its
> reported total. Compute the entire sum from `next`, retain checked overflow, and run the valid
> cache-heavy, first-delta-too-small, cumulative, and output-cap cases on the same fingerprint.
> Until corrected and green, Rust usage authority is source-red again.

> **Usage regression repair — 2026-07-14:** Current bytes now compute the visible sum entirely
> from `next` input/cache-read/output fields and add an underreported-cache rejection. Return this
> item to source-addressed/test-pending, retaining the exact first-delta, cumulative, cache-heavy,
> and cap cases in the frozen composed run.

Containment is defense in depth. It does not replace tool grants, typed operation contracts,
context-first issuance, accepted-output closure, replay protection, or Git CAS.

## Configuration schema 2.0

The live project root is `.koni/`. Repository skills remain in `.agents/skills/`. Agent definitions
are provider-neutral YAML beneath `.koni/agents/`; fields describe instructions, model,
`thinking_level`, capabilities, and skills without embedding Codex custom-agent configuration.

An `ai` pipeline stage is the generic model-turn block. Its transport is fixed by this runtime, so a
profile configures intent rather than a CLI command:

```yaml
pipeline:
  stages:
    assess-risk:
      kind: ai
      title: Assess implementation risk
      config:
        persona: risk-analyst
        prompt: Identify material risks and propose bounded verification.
        output_schema: schemas/risk-assessment.json
        session_scope: stage
        thinking_level: high
        tools: [context, graph_context, record_note, submit_and_compile]
        timeout_seconds: 900
  order: [assess-risk]
```

Existing planning, worker, Lead, and independent-review flows compile to the same runtime request.
Their distinct compiler policies remain intact; `ai` makes the reusable primitive available to new
profiles without adding another special executable path.

> **Cognition-boundary refinement — 2026-07-15.** “Lead flow” above now means a semantic
> orchestration boundary, not deterministic process polling. While one or more workers are live,
> automatic supervision observes their compiler-owned identities passively and creates no Pi host,
> model request, or Lead slice. Once durable state makes dispatch, review, recovery, or completion
> actionable, the next Lead request receives that boundary. Explicit low-level `wait_worker` calls
> remain bounded and compatible, including a nonterminal result when a worker temporarily owns run
> publication authority.

## Migration transaction

Migration is explicit and fail-closed:

1. inspect schema-1 ownership manifests and hash every Koni-owned input;
2. refuse collisions, modified owned resources, symlinks, or ambiguous agent references;
3. stage a complete `.koni` schema-2 tree and convert only referenced owned Codex-agent TOML;
4. convert `codex_agent` to `agent`, `reasoning_effort` to `thinking_level`, and `sandbox` to
   provider-neutral `capabilities`;
5. compile and validate the staged catalog/profile before publication;
6. archive any active Codex-backed run with an explicit migration reason—never resume it under Pi;
7. publish `.koni` atomically, retain a rollback backup, and retire only manifest-proven owned
   legacy resources;
8. leave unrelated `.codex` files and all historical run/transcript readers untouched.

Schema-1 snapshots remain readable for audit and display. They are not accepted as a source of new
execution after migration.

> **Migration publication security hold — 2026-07-14:** The transaction above is the target
> contract. Current source now has ancestor checks, schema-scoped transforms, opaque run-disposition
> proof, and an fsynced recovery journal, superseding the earlier absence of those mechanisms.
> Publication is still unreleased: the journal is self-hashed public data in a model-writable tree
> and recovery trusts its embedded retirement plan without rederiving every destructive path; the
> check-to-rename sequence remains pathname-based and can race an ancestor swap; and run-registry
> authority is not held across the publication commit. Store authenticated compiler-owned recovery
> state outside write grants, rederive all retired paths, use no-follow handle-relative identity/
> rename semantics, hold run authority through publication, and add forged-journal, outside-
> sentinel, synchronized swap, crash-boundary, semantic-preservation, and late-run regressions.

> **Migration authority remediation checkpoint — 2026-07-14:** Current source moves the journal to
> compiler-owned Git-common state, rederives the complete legacy/resource plan during recovery,
> reruns profile compilation, and carries migration/registry/per-run guards through
> `Schema2Migrator::apply`. Reclassify the forgeable model-writable journal and dropped-run-barrier
> findings as source-addressed/test-pending. The pathname publication race remains definite: inode/
> hash verification is followed by pathname `rename`, so a synchronized swap can move the wrong
> source before detection. The forged-journal, late-run, crash, and semantic-preservation matrix
> still belongs on the final fingerprint.

## New extension doors

The direct boundary enables functionality that was awkward or impossible to make reliable around a
CLI transcript:

- live operator steering and queued follow-ups with durable authorship/order;
- per-stage context compaction with compiler-visible provenance and hashes;
- images as hash-bound runtime inputs for research/design workflows;
- structured model/tool timing and cache usage in Evidence and cost/limit policies;
- dynamic tool availability after compiler state transitions without ambient MCP discovery;
- deterministic fake-provider tests for retries, partial streams, malformed tool calls, aborts, and
  crash recovery;
- session branching or replay built from Koni's own event log rather than a provider's hidden
  history format;
- future provider evaluation behind the same internal runtime contract, if product policy ever
  expands beyond the currently fixed subscription provider.

The last item is an architectural option, not current configuration: schema 2.0 intentionally does
not expose a provider switch.

## Release verification

A releasable cutover requires all of the following on one source fingerprint:

- Pi host install, lockfile integrity, typecheck/build, unit tests, and dependency audit;
- adversarial wire tests for bounds, sequences, session/request identity, secret-frame separation,
  tool ordering, cancellation, and child termination;
- keychain login/status/logout and serialized refresh tests using a fake vault;
- macOS Seatbelt and Linux bubblewrap command/policy tests plus packaging smoke;
- schema-1-to-2 migration, collision, rollback, active-run archival, and unrelated-Codex-preservation
  fixtures;
- the complete existing compiler/broker context-first, CAS, replay, graph, Git, pipeline,
  verification, promotion, CLI, and TUI suites;
- recursive bundled-profile/template parity and documentation history checks.

> **File-backed verification supersession — 2026-07-14:** The `keychain login/status/logout`
> wording in this historical release list now means the equivalent Koni account-file lifecycle:
> signed-out status without touching legacy Keychain state, browser login and atomic persistence,
> a second independently packaged binary reading the same account state, refresh serialization,
> and logout deleting only Koni's file. The final frozen source gate passed **1,057** Rust tests
> with zero failures and three intentional ignores, warning-denied workspace clippy, format/diff
> checks, and **53/53** Pi-host tests. Live browser completion and nonzero inference remain distinct
> operator evidence rather than unit-test claims.

No installed binary or live/forensic run is refreshed as part of source implementation.

## Implementation checkpoint — 2026-07-14 (`pi-runtime-architect`)

The historical holds and moving-source notes above are retained as the audit trail that shaped the
implementation. The current source now implements the following cutover candidate:

- production planning, review, ticket-worker, and Lead model loops use the direct Pi SDK host;
  there is no production selector, environment switch, or runtime fallback to the Codex CLI;
- `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` are exact-pinned at `0.80.7` and
  statically bundled into one host artifact; the Rust build embeds its SHA-256 plus the exact Node
  image SHA-256 and minimum Node version 22.19.0;
- Rust owns session/tool identity, public protocol sequencing, output-schema validation, Git,
  graph, receipts, questions, lifecycle, and durable publication. The host sees subscription
  credentials only on private fd 3 and never receives project pathname authority;

> **Exact review-path refinement — 2026-07-15:** A configured ticket scope can include production
> files that do not exist yet in a preparation checkout. The review packet records those paths as
> unavailable scope facts, while the direct Pi read broker receives only current regular files as
> exact capabilities. Unavailable paths are not valid evidence pointers and cannot fail session
> admission merely because a later ticket owns their creation.
- `koni models` and the TUI model picker read Pi's pinned provider registry directly;
  `koni auth status|login|logout` exposes token-free OS-keychain control, with device-code login
  only and no API-key mode;

> **Local-login UX supersession — 2026-07-14:** The device-code-only phrase immediately above is
> retained as release history. Current macOS `koni auth login` uses Pi's default browser-PKCE flow,
> automatically opens the allowlisted OpenAI authorization URL, and returns through the exact
> localhost callback grant. The no-API-key and OS-keychain boundaries are unchanged.
- planning replay serializes prior successful outputs, resolved decisions, and question
  checkpoints into each fresh one-shot host; full-output hashes/truncation markers prevent bounded
  replay from silently pretending to be complete;
- compiler token ledgers account successful, failed, schema-invalid, and timeout-partial turns.
  `new_tokens` removes cache-read exactly once, processed tokens use provider total, output is
  capped at the provider payload boundary, and fewer than 16 remaining tokens is terminal;

> **Durable-ingestion closure — 2026-07-15 (`token-ingestion-impl`):** The ledger statement above
> now has one implementation authority for planning and whole-run reporting. Each compiler-owned
> log is read once and cached by canonical path, size, and modification time. Native Codex
> `turn.completed` usage treats input as gross; direct Pi treats provider total as uncached input
> plus cached input plus output and reconstructs gross input as total minus output. Per Pi turn,
> committed compatibility completion supersedes its checkpoint and deltas, checkpoint/legacy
> terminal supersedes deltas, and only a delta-only partial lacks a completed-turn increment.
> Planning transcripts and agent result objects remain mirrors, not additional accounting sources.

> **Independent-review hardening — 2026-07-15:** Preserve the closure above, with two stricter
> details. Legacy compiler-owned Pi usage/terminal records may omit `type`, but an explicit invalid
> type is not legacy. And precedence applies only to internally consistent usage: native cache is a
> subset of gross input, Pi visible buckets cannot exceed provider total, reasoning cannot exceed
> output, and all arithmetic is checked. Provider total is allowed to exceed Pi's visible buckets;
> the surplus is real provider/new usage rather than a reason to discard the record.
- runtime/broker frames, tool arguments/outcomes, context pages, project reads/searches/listings,
  scan work, and logs are independently bounded. Oversized model tool arguments are rejected
  locally before a broker-dispatched marker exists; worker context uses a bounded preview plus the
  exact compiler-issued `read_file` path;

> **Context-completeness refinement — 2026-07-16:** For newly issued Worker grants, the preview is
> not the complete contract until `eof:true`. A product read/list/search, mutation, configured
> check, or submission before EOF receives one bounded retryable `context_incomplete` correction;
> only the exact compiler-issued context path at the returned `next_offset` can advance the cursor.
> After the exact continuation reaches EOF, product tools and terminal semantics proceed unchanged,
> including a following sibling call in the same model-authored batch. The policy is hash-bound and
> optional on the grant so already-issued historical grants retain their pinned behavior. Worker
> copy additionally teaches search-first navigation for a known literal in a large file and avoids
> redundant relocation searches over an `eof:true` result already retained in the transcript.

> **Superseded at the observation boundary — 2026-07-16:** Retain the grant-compatibility and
> EOF cursor rules above, but not the same-batch-success sentence. Sequential execution orders
> effects; it does not let the provider observe one result before authoring its sibling. Every
> successful compiler-context delivery now establishes a Pi-local observation boundary: later
> siblings from that assistant message are quarantined without broker dispatch, and the next
> provider request may continue after the result is in the transcript. This includes the initial
> full/paged response, every continuation, and the page that reaches EOF. Contexts are accepted up
> to 4,000,000 bytes; exact continuations must request at least 32 KiB. Allowing for three bytes of
> UTF-8 boundary rollback per page, the maximum needs at most 123 page-bearing deliveries. A
> path-only recovery response adds one receipt, so even that case consumes at most 124 of the 128
> context receipts inside a 256-receipt grant, preserving an unconditional 128-receipt product/
> check/submission reserve plus four slack receipts. The compiler rejects the first byte above the bound
> before publishing the context pack or making its Worker step eligible.
- schema migration uses compiler-owned recovery state and descriptor-relative no-follow
  publication, archives active Codex runs permanently, and preserves unrelated `.codex` content
  plus historical readers. Focused migration evidence is 18/18 core and 2/2 CLI;
- release archives and the Homebrew source formula install `bin/koni` with
  `libexec/koni/pi-host` and `libexec/koni/pi-runtime`; clean-extract smoke uses the packaged
  runtime bytes rather than the build runner's matching copy.

### Credential TCB decision

For this cutover, accept the security review's practical branch: the exact Pi host, bundled Pi SDK
dependency closure, pinned Node image, and Koni Rust binary are one credential trusted computing
base. The provider implementation constructs bearer requests in Node, so pretending Node is
secret-blind would require a materially different Rust provider/proxy. Release provenance therefore
attests the complete archive, lockfile-resolved bundle, and runtime image as one unit; launch copies
source bytes through no-follow descriptors into a private scratch directory and rehashes before
execution. A future Rust-owned destination-allowlisted provider proxy remains a stronger optional
architecture, not an implied property of this implementation.

### Linux network status

The earlier generic containment description is a target capability, not current Linux behavior.
Current `compile_linux` rejects every `network_access: true` request because sharing the host
network namespace would let the credential TCB reach arbitrary destinations. Consequently Linux
packages can run contained metadata/model discovery and other non-network probes, but **cannot yet
run subscription login or inference**. Planning, review, worker, Lead, and `auth login` fail closed
until an outbound-only, destination-allowlisted egress broker is implemented. macOS Seatbelt is the
current network-enabled production target.

### Verification status

Source checks completed during this implementation include the Pi host typecheck and its focused
runtime suite (25/25), the schema/migration matrix above, CLI compilation, and focused budget,
replay, transport, artifact, credential, containment, and broker tests recorded in the collaboration
ledger. The remaining release decision is evidence, not a hidden feature fallback: run the full
locked workspace/clippy/host/dependency/package matrix on one final source fingerprint, perform a
macOS fake-vault plus opt-in live subscription smoke, and retain Linux inference as unsupported
until the egress broker exists.

## Cutover implementation closure — 2026-07-14 (`pi-runtime-architect`)

This checkpoint appends to, and does not erase, the review history above. The current source closes
the remaining executable cutover gaps found during final integration:

- `.koni/project.yaml` is the live schema-2 catalog root for discovery, snapshots, CLI planning,
  run-local overrides, and TUI authoring. A coexisting `.codex/koni` tree is never a fallback for a
  schema-2 project, and schema-2 snapshots omit `.codex/config.toml` and `.codex/agents` while still
  binding repository skills under `.agents/skills`.
- Fresh initialization stages the historical bundled templates privately, converts them through the
  same schema-2 transaction, and publishes only `.koni` plus repository skills. In-place migration
  preserves unrelated `.codex` content, archives Codex-backed active runs, and can immediately plan
  a new Pi-backed run from the published catalog.
- Run-type agent settings remain generation-native: schema 1 accepts `reasoning_effort`, schema 2
  accepts `thinking_level`, inherited overrides and standalone snapshots retain the right spelling,
  and runtime selection reads one provider-neutral effective value. Cross-generation fields and
  dual definitions fail closed.
- Pi runtime scratch is created atomically with mode `0700`. The launch path is canonicalized before
  staging Node/the bundle or compiling Seatbelt rules, and macOS grants metadata-only access to the
  exact ancestor directories Node must traverse while resolving its canonical entrypoint. This
  closes the clean-package failures caused by a normal `022` umask and macOS `/var` → `/private/var`
  path aliases without broadening project read authority.

The host closure is 34/34 tests plus strict typecheck, build, checksum verification, and an isolated
no-`node_modules` startup/OAuth smoke. The single-file host is 873,700 bytes with SHA-256
`257c37416e39db82c65464497305a2e72730cc36ec7d7464f8d5ed3414bbe161`; production dependency audit
reports zero vulnerabilities. Focused Rust evidence includes direct Pi 9/9, supervised runtime 9/9,
schema-2 field-generation regressions 2/2, fresh-init-to-run 1/1, in-place-migration-to-run 1/1,
planning replay 1/1, TUI Pi model mapping 3/3, and CLI subscription-only surface 1/1.

`scripts/install-dev.sh` also completed against a clean temporary prefix using downloaded,
SHA-256-verified Node 22.19.0 and npm 11.13.0. Its optimized packaged binary started the contained
host and completed `koni models --json`, reporting provider `openai-codex`, Pi SDK 0.80.7, no ambient
credentials/resources, and compiler-brokered tools only. No user installation, credential, project,
or live/forensic run was modified by that temporary-prefix smoke.

Linux networked inference/login remains deliberately unsupported as recorded above. A real
subscription inference smoke would spend provider capacity and inspect the user's credential state,
so it remains an explicit operator opt-in rather than an implementation-side test.

## Live planning and transcript transition — 2026-07-15 (`primary-integrator`)

This note supersedes only the older 16,384-token local synthesis allowance; the bounded same-host
two-turn design and credential-safe protocol remain unchanged. Direct-Pi planning now reserves
32,768 local output tokens because that meter includes hidden reasoning, while Rust independently
rejects visible structured planning responses above 96 KiB and plan prose above 24,000 characters.
If the provider still overruns the allowance, the host publishes the completed message and exact
usage before returning the fixed `runtime_output_limit` tuple, so a costly response is not replaced
by a zero-usage generic internal failure.

The host still emits no raw streaming deltas. Complete message and compiler-tool payloads cross the
same bounded, credential-isolated runtime protocol once, then Rust retains them in the local
compiler-owned per-agent transcript. Cockpit chat renders those user/assistant/tool cells directly
and suppresses raw `pi.event` envelopes; the planning state journal retains only hashes, sizes, and
lifecycle metadata so refresh snapshots do not duplicate repository excerpts.

### Review capability admission refinement — 2026-07-15 (`primary-integrator`)

The earlier exact-file review rule remains authoritative, with one stricter qualification learned
from the preserved Updog acceptance run: a path is advertised to Pi as an inspectable product-file
capability only when it is a current contained non-symlink regular file **and** its size is within
the read-only broker's shared 96 KiB per-file ceiling. Existing files above that bound remain in the
compiler packet as typed `exceeds_read_limit` scope facts, including size and limit, but are absent
from the exact allowlist and valid-evidence enum. Planned or non-regular paths retain the separate
`not_current_regular_file` classification. This appends to, rather than erases, the missing-path
transition: both conditions ensure the model sees only capabilities the broker can actually honor.

## Final release-candidate verification addendum — 2026-07-14 (`pi-runtime-architect`)

This addendum supersedes only the incomplete verification status of earlier checkpoints; it does
not erase their design or audit history. Final whole-workspace integration exposed and closed four
additional boundary defects:

- Schema-1 run-type hashes retain their historical serialized shape, while schema 2 binds its
  generation into the hash domain. Optional schema-2 policy fields therefore cannot change legacy
  run identity accidentally.
- A refresh request that finds no existing same-account credential no longer consumes its one-shot
  mutation authorization. The private fd-3 service consumes that capability only after the vault
  transaction and identity preconditions succeed; replay after a successful begin remains denied.
- Git-common tickets in `todo` or terminal state project against the integration checkout because no
  private checkout exists before `start` or after integration. Active tickets still fail closed
  without a canonical lease; this is an evaluation-root distinction, not an agent-spawn fallback.
- Durable planning records keep complete-output hashes, but fresh model-facing risk/verification
  prompts now contain only semantic prior-pass content plus bounded truncation metadata. Compiler
  hashes, stage IDs, session IDs, paths, batch IDs, and other runtime identity remain private.

The exact CI gates now pass on one final source tree: `cargo clippy --workspace --all-targets
--locked -- -D warnings`; `cargo test --locked --workspace` with **1,041 passed, 0 failed, 3
intentionally ignored**; `cargo fmt --all --check`; and `git diff --check`. The Pi host independently
passes strict typecheck, **34/34** tests, bundle build/verification, and isolated no-`node_modules`
startup/OAuth smoke. Its artifact remains 873,700 bytes at SHA-256
`257c37416e39db82c65464497305a2e72730cc36ec7d7464f8d5ed3414bbe161`, and `npm audit
--omit=dev` reports zero vulnerabilities.

The developer installer was repeated after the final Rust cleanup into a new temporary prefix. It
downloaded and verified the pinned Node 22.19.0 and npm 11.13.0 archives, generated and validated the
production SBOM, built the optimized Koni binary, and passed the packaged contained `koni models
--json` probe. That probe reported `runtime=pi-sdk`, Pi SDK 0.80.7, provider `openai-codex`, no
ambient credentials/resources, and compiler-brokered tools only. The temporary install was not a
user installation and was removed after verification.
