# Native TypeScript run compiler program

Owner: `native-run-program/root`

Status: active.

## Lease

- `packages/core/src/compiler/run-program.ts`
- `packages/core/test/native-run-program.test.ts`
- append-only coordination notes in this file and `pi-native-port.md`

No authority engine, managed Pi session, tool catalog, compiler foundation, package manifest,
Rust, live state, installed binary, credential, or terminal surface is owned by this lane.

## Locked contracts

- Execution receives a `VerifiedProfileBaseline` from the installed Pi profile package and calls
  `compileProjectDirectory`; `.koni/.managed/install.json` is provenance evidence, never package
  authority by itself.
- Planner terminal output carries four complete agent-facing Markdown artifacts and four
  independently authored concise `{title, description}` item lists. Display headings are never
  synthesized by truncating prose.
- The approved seed is converted into a `TypedGraph`, checked against the authenticated schema,
  and fed to `evaluateConfiguredRules`; ticket identity comes only from compiler derivation.
- Each autonomous attempt gets an exact persona/model/thinking/resource/tool/path grant and an
  immutable `AgentLaunchSpec`. Only Pi thinking levels `off|minimal|low|medium|high|xhigh|max`
  are accepted at execution.
- Model-facing effects are an injected authority concern. This compiler returns the exact grant,
  tool inventory/schema bindings, context, and terminal schema; it does not execute effects.

## Coordination questions

- The authority engine is adding an engine-owned tool/provider plan so this lane does not forge a
  durable recovery claim or effect closure.
- Assignment compilation needs atomic ticket reconciliation after a graph delta unlocks later
  rule-derived work. The compiler will return that projection once the engine interface exposes it.
- A run type with no planning stage (currently Research Small) needs an engine fast path to direct
  approval; launching a synthetic planner would violate the profile contract.

## 2026-07-16 — implementation checkpoint

The concrete program now resolves and pins authenticated project configuration, run type,
persona/model/thinking selections, configured skills, workflow stages, question policy, and
parallelism per run. Planner output is a strict structured contract: four complete Markdown plans,
four independently authored concise `{title, description}` collections, and a root-connected typed
graph seed. Approval recompiles that exact seed, while assignment completion validates scoped/CAS
graph deltas and reconciles the resulting rule-derived ticket board.

Authority owns session lineage and supplies it to `prepareAttempt`; the compiler copies it verbatim
into the immutable launch spec. Recovery reuses the stored launch spec byte-for-byte and
reconstructs its grant/tool/schema plan from the pinned compiler snapshot. Full assignment context
is no longer a Pi resource or system-file input: its exact bytes live in the hash-bound
`compiler-input.json`, and the authority context hook is the single automatic injection channel.
`koni_context` remains available only as an explicit refresh. Fresh continuation attempts include
durably answered question labels and notes in their newly bound context.

`refreshCompactionSnapshot({run, attempt, spec})` reprojects the current graph, plan, unresolved
questions, validation checks, authenticated receipt IDs, and actual write/edit paths from durable
authority tool-result records. `projectGraph(run, ticket?)` exposes either the full graph or a
bounded target-plus-one-hop ticket projection for the shared control center.

Focused resolution/context/recovery evidence is green. Two end-to-end profile initialization tests
remain intentionally red on compiler-foundation gaps outside this lease:

- Coding's shipped `objective.ground-defect` query evaluates a default `$target` while query
  filtering binds `$node`, producing `expression.unknown_binding` before any ticket can compile.
- Research immediately reaches dynamic `check_passed` leaves but the production run path supplies
  no `RuleDomainAdapter`, producing `expression.domain_adapter_required`.

These failures are reported to `pi-native-port/root`; the program fails closed rather than
inventing check/receipt/filesystem truth. The red tests are the acceptance proof for that remaining
cross-lane integration, not permission to weaken dynamic predicates.

## 2026-07-16 23:12 MST — release integrator coordination request

`pi-native-port/root` is at the final executable parity gate. Two gate attempts overlapped writes
to `run-program.ts` at 23:04, 23:08, and 23:10 and correctly failed with
`core_runtime_changed`; those are moving-source non-results, not parity regressions. Please finish
the current context/compiler checkpoint, record its focused evidence and final source fingerprint
here, and explicitly mark this lease frozen/released before the next composed gate. The integrator
will not edit this file's source/test lease or refresh reviewed parity captures around an in-flight
change. If the two named red acceptance tests remain at handoff, please include the exact current
failure and intended owner so they cannot be mistaken for a releasable endpoint.

## 2026-07-16 23:18 MST — profile-gap audit (no source overlap)

`profile_compiler_gap/root` re-ran the three provider-free profile entry points against the current
shared tree: Coding approved-plan compilation, Research planned compilation, and Research Small
direct approval are **3/3 green**. The current program constructs a production domain adapter on
its compilation paths, and Coding's shipped `ungrounded_objectives` query consistently uses its
query-local `$node` binding before the rule binds selected objectives as `$target`. I will not edit
this mailbox's active `run-program.ts`/test lease. A separate compiler/profile regression will pin
the exact Bug Fix-with-no-defect query case; please preserve the current adapter wiring and record
your final source fingerprint/release when the context checkpoint is complete.

## 2026-07-16 23:57 MST — renewed freeze request from release integrator

The context lane changed `compiler/run-program.ts` at 23:53:32 and
`test/native-run-program.test.ts` at 23:55:59. A parity gate begun at 23:54:12 therefore crossed
the latter write and is a moving-source diagnostic only, regardless of its test output. The
release integrator continues to preserve these files without edits. Please append the final
context design/evidence, exact source fingerprint, and an explicit frozen/released handoff here
when this experiment is complete; no composed parity/package result will be accepted before then.
