# Orchestration Reliability Design

## Problem

An operator-seat smoke test of the research profile against the `muat` project ran thirteen
medium/small runs across two sessions. None reached `merge_ready`. Each run died further down the
pipeline than the last, and every defect it exposed was real and has been fixed or recorded. The
first nine failed at, in order: verification (a query-name typo), orchestration (an invalid
semantic-version range the profile itself taught agents), 4/12 tickets (gate-contract deadlock), 3/4
(an asset that could not declare its read dependencies), 0/6 (the same deadlock under stale pinned
config), 3/10 (a silent wedge), 4/8 (a provider abort followed by a silent wedge), 9/11 with all
five gates settled (an integrator pointed at a payload field that does not exist — section 9), and
5/13 (a gate verifier that wrote a file under a read-only check, whose refusal could not reach the
rule meant to remediate it — section 10).

Four more followed as the later fixes landed. One reached 12/13 — the deepest of the session, and
the first to clear a live operator decision mid-run — before blocking on a change-control output
collision (sections 11–12). The others stopped at 4/12, 9/15, and 3/10.

**Section 14 is the conclusion to read first.** Those four runs each stopped with most of their
board still schedulable — the 3/10 run had seven tickets `ready` and none running — because one
malformed durable output fails the whole board compile. Every defect below is worth fixing, but that
error boundary is why any one of them ends a run rather than degrading it.

Two of those four, and the 9/11 and 5/13 runs before them, died to **guidance** defects diagnosed
and corrected within minutes, where no correction could reach the run that exposed it, because
personas are pinned at `run.create`. A profile-prose bug therefore costs an entire run, and several
landed in a single evening. That is the strongest argument here for section 7's proposal to separate
the pinned semantic contract from floating guidance: the pinning is not protecting correctness in
these cases, it only guarantees each defect is paid for twice — once when it kills a run, and again
when the fix waits for the next one. Section 12b's flattening defect is the counterexample worth
noting: it lived in the tool contract rather than a persona, so its fix reached every run
immediately.

The individual defects matter less than what the operator experience revealed. Most of the elapsed
time went not to agents doing research but to a human deciding what the harness was currently doing,
whether it was still doing anything, and which of several superficially identical states it was in.
Koni's compiler-authoritative core is sound: it derives work correctly, it fails closed, and its
receipts are honest. What it lacks is the surrounding orchestration behaviour that keeps a long
autonomous run legible and self-correcting.

OpenAI's Symphony specification is a useful lens here, not as a design to copy but as an independent
enumeration of the problems any always-on agent orchestrator meets. Symphony's answers suit its own
shape — an issue tracker as control plane, an in-memory scheduler, no durable orchestrator database
— and several are wrong for Koni, whose entire value rests on durable compiler authority. Its
_problem list_ transfers almost completely. The gaps below are organised against that list.

## Design

### 1. Reconciliation: the orchestrator must re-derive reality, not only react to it

Symphony reconciles every poll tick. It recomputes which issues should be running, compares that
against live workers, terminates whatever stalled past `stall_timeout_ms`, and re-dispatches.
Restart recovery is source-truth-driven rather than dependent on surviving timers.

Koni is purely event-driven. `grep setInterval packages/core/src/authority` returns nothing.
Advancement happens because something _caused_ it — a submission, a settlement, a resume. Any lost
or raced advancement therefore wedges the run permanently, with no path back.

This was the single most expensive failure of the smoke test. Four separate times a run sat at
`phase=executing`, `blocker=None`, with a `terminal_accepted` attempt that never settled and nothing
dispatching. One instance idled fifty-nine minutes before being noticed. There is no error, no log
line, no timeout — the state is indistinguishable from healthy work in every surface the operator
has. Worse, `koni status` actively reports it as healthy, because `activeAttempt` in
`monitor-projection.ts` counts attempt _records_ — `terminal_accepted` among them — rather than live
processes.

The only reliable remedy found was `koni stop`, which retires the attempt to `interrupted` and
resets the ticket. That is precisely the wrong shape of remedy: it looks destructive, so it is the
last thing an operator reaches for on a run that reports itself healthy.

Koni already owns every part needed to fix this. `PiAttemptProcessSupervisor.list()` enumerates live
handles. `#tick` re-drives a run. The stop path proves that retiring a process-less
`terminal_accepted` attempt is safe. What is missing is the loop that compares the two views and
repairs the difference, plus a `lastProgressAt` stamp so staleness is expressible at all.

This is now implemented: a 60s reconciliation interval, armed at the end of `recover()`, retires
attempts that no supervisor handle backs once a run has been idle past a 1200s stall bound, then
re-drives through `#tick`. That bound was first set to 300s and had to be corrected — see 7b: an
attempt that submits normally has no live process while assignment validation runs, and a configured
check may take up to 900s, so the shorter bound retired healthy work mid-validation. Two constraints
emerged while building it, both worth stating because they bound any future work on the same path.
First, retirement is not merely a status change — an interrupted terminal acceptance is legal only
when the validation action bound to that exact attempt is settled `abandoned` in the same CAS, which
is precisely the closure `closeStoppedRunActions` performs for `koni stop`. Second, reconciliation
must decline attempts whose `terminalPolicy` has already landed: those are one CAS from settling on
their own, and abandoning them would discard proven compiler closure to fix a problem they do not
have.

The misleading `koni status` count was left alone deliberately. `activeAttempt` counts records
rather than processes, but during `terminal_accepted` work genuinely is in progress — the assignment
is being validated — so excluding it would trade one wrong reading for another. What made the count
a lie was the wedge persisting for fifty-nine minutes, and reconciliation is what fixes that.

### 2. Blocked states must carry their remedy

Symphony's issue states are few and total, and its rule that "a run MUST NOT stall indefinitely
waiting for user input" forces every path to resolve or fail.

Koni's `blocker` is `string | undefined`. Over the smoke test that one field represented at least
four operationally distinct situations: a transient race that self-heals within a tick; a condition
a plain `resume` clears; a condition only `stop` can clear, because `resume` retries an unreplayable
terminal output forever; and a permanently dead run whose pinned configuration predates the fix it
needs.

They render identically. Distinguishing them by hand — reading action-execution journals, comparing
hashes, checking pinned config — was the largest single time sink of the session. The TUI compounded
it by offering "[Enter] Retry blocked work" on a retry that could not possibly succeed.

The fix is to make the remedy part of the state rather than something the operator
reverse-engineers. Eleven call sites emit the `blocked` lifecycle event and only two assign
`state.blocker`, so carrying a typed `remedy` alongside the human-readable reason is a mechanical
change. Surfaces then render the action that will actually work, and suppress the ones that cannot.

Implementing this corrected one of the session's own conclusions, which is worth recording because
it changes what the gap actually is. Held provider exposure was classified here as a case only
`stop` could clear. It is not: the authority already models it as acknowledge-then-retry, with
`retire_provider_exposure` gated ahead of the retry by `requiresProviderExposureRetirement`, and a
test asserts the retry becomes available immediately after the acknowledgement. Labelling it `stop`
suppressed a retry that does work. The mechanism was never missing — it was undiscoverable from the
surfaces, which is the same defect one level up: the operator reached for `koni stop` all night
because nothing told them a supported two-step remedy existed. A typed remedy is worth having for
exactly that reason, but it has to be derived from what the harness does rather than from what the
operator resorted to, or it encodes the confusion instead of curing it. Where no evidence exists,
the default stays `resume` — the behaviour every surface already implies — rather than a guess
wearing a confident label.

### 3. Inherited conclusions must not outlive the harness that produced them

Symphony keeps continuations lean: the first turn carries the full prompt, later turns carry only
continuation guidance, and issue state is re-fetched between turns so an agent never reasons from a
stale snapshot.

Koni's `sameScopeContinuationPrompt` instructs an agent to "reuse its successful reads, searches,
checks, and decisions instead of repeating them" — correct for economy, and actively harmful across
a harness change. After a gate-resolution bug was fixed and deployed, continuation attempts _with
the fix live_ still submitted `failed`, quoting inherited history: the operation "returned the
identical hard error every time… deterministic". The agent was obeying instructions. The fix was
invisible to it. Three manual `executionEpoch` bumps were required to force fresh roots.

There is also a straightforward contradiction between two contracts. Continuation tells the agent to
reuse checks; assignment completion requires a check receipt bound to the _current_ attempt
(`check.attemptId === attemptId`). An agent that obeys the first cannot satisfy the second, so every
continuation after the first is structurally doomed to produce zero receipts and fail completion.

Koni already articulates the right principle. The comment governing epoch-less attempts states that
inheriting an old terminal conversation "would be unsafe and wasteful, while beginning a fresh root
loses no durable audit evidence." That rule simply never fires on the case that matters: the
compiler configuration or core build changing under a live run.

The contradiction is now fixed, on the side that was plainly wrong. The continuation prompt no
longer lists checks among the things to reuse, and states explicitly that an inherited check receipt
belongs to the parent attempt and that every configured check must be re-run in this attempt. That
mirrors the carve-out the same prompt already makes for terminal-tool receipts — the defect was
simply that checks were never added to it. The alternative, scoping receipts to ticket/step/epoch,
would let a green check from another attempt satisfy completion; that weakens a verification
contract `assignment_check_provenance` exists to enforce, so it should not be done as a side effect
of fixing a prompt.

Automatic epoch invalidation, however, cannot be built as this document originally proposed, and the
reason is worth recording. The trigger named here was a run's `compiledConfigHash` changing — but
that hash is pinned at `run.create` and asserted invariant against
`lifecycleCatalog.configuration_sha256`, so it is by construction identical for every attempt of a
run. It can never differ. What actually changed under the smoke-test runs was the _core build_: Koni
was rebuilt and reinstalled while runs were live. No attempt records the build identity it ran under
— `launchSpecHash` covers per-attempt material including `issuedAt` and the attempt id, so it
differs every time and cannot serve as a harness-identity comparison. Detecting this requires
stamping attempts with a durable runtime identity, which is a new durable field and a real design
decision rather than a mechanical change.

The same gap blocks the cheap configuration-staleness signal proposed in section 7. Comparing a
run's pinned configuration against the current project configuration needs an accessor for the
current effective configuration hash, and the compiler program exposes none — `controlCatalog()`
projects launch options but carries no hash. Both wants are served by one small addition, and that
addition should be designed rather than improvised.

### 4. Retry must distinguish deterministic from transient failure

Symphony separates the two explicitly: a clean-exit continuation retries after a fixed second, a
failure retries on capped exponential backoff.

Koni bounds provider-exposure recovery at three attempts and reissues an identical request each
time. When the failure is deterministic — as it was for a reviewer whose turn aborted the same way
three times — all three are spent proving the same thing before the run parks on a human
confirmation.

Everything needed to tell the cases apart is already durable on `authorityProviderRequests`: failure
code, step, payload hash. A second identical signature should change strategy rather than repeat,
and the cheapest available strategy change — a fresh conversational root instead of a continuation —
already exists in the epoch machinery. The `maxProviderRetries: 0` accounting invariant is
deliberate and should not be touched; this is about workflow-level recovery choosing better, not
about transport-level retries.

The bound described above was also not being applied at all, which is worse than applying it badly.
`providerRecoveryEpochAttempts` resets the recovery budget at the last attempt holding any settled
provider request, on the reasoning that real progress should earn a fresh budget. But nearly every
multi-turn attempt settles several requests before its final one fails, so each failure cleared the
counter it had just incremented and `MAX_PROVIDER_EXPOSURE_AUTO_RECOVERIES` could never be reached.
Observed directly: one run auto-recovered twelve consecutive times across roughly fifty minutes,
each attempt re-paying for the same repository discovery, with no cap ever engaging. An attempt that
itself died holding provider exposure is now excluded from advancing the epoch boundary, so
consecutive held-exposure aborts accumulate as intended while genuine completions still reset it.

### 5. Checks must not be resolved before the state they depend on exists

Symphony resolves what it needs at the moment it needs it, and degrades unsupported tool calls to
structured failures so a session continues rather than dying.

Koni resolves every configured check's command at attempt _dispatch_. The `gate-verifier` check
resolves its argv from `spec.gate_contracts[$gate.id].argv` — a field that the `implement-asset`
operation is itself responsible for authoring. On the first implementation of any gate-compatible
asset the resolution therefore cannot succeed, and the ticket that would create the contract can
never start. This deadlocked three runs.

The immediate mitigation — removing `implement-asset` from that check's `applies_to` — is landed and
correct, since gates remain covered by `run-gate` and `validate-asset`. The general class remains:
any check whose command depends on state its own step authors will deadlock the same way.

Lazy resolution is the real fix, and it has one hard constraint discovered by two failed attempts:
the authority grant is hash-pinned and must be byte-identical between dispatch and recovery.
Deriving the grant envelope (`maxTimeoutMs`, `networkAccess`) from static check definitions rather
than resolved commands makes it resolution-independent and therefore stable. That change deserves
its own review.

### 6. Completion must mean fitness, not existence

Symphony's framing is that an agent's goal is to convince a human to merge — outcome, not process.

Koni's asset pipeline currently verifies process. A corpus manifest shipped with
`builder_status: "unresolved"` and every hash null. The asset-builder approved it, the integrator
approved it, and the reviewer approved it — each correctly, because the files existed and matched
the recorded `asset_manifest` hashes. Nothing in the loop asked whether the payload satisfied the
gate it exists for. The gate then held red permanently while the harness reissued the _gate_ step
rather than reopening the deficient _asset_.

Two structural absences make this worse. The run-gate ticket outranks the asset ticket it depends
on, so ordering is correct only by accident, and there is no route from a red gate back to the work
that caused it.

The related claim that `dependencyIds` is empty throughout was too broad and is corrected here. A
later run showed the derivation working: every `implement-asset` ticket carried a dependency on the
`plan-build-asset` ticket that defines its spec, and one carried two, which correctly serialized six
otherwise-parallel tickets behind their prerequisite. Empty dependency lists appear on the earliest
prerequisite and graph-compilation tickets, which genuinely have no predecessors. The gap is
specifically the gate-to-asset edge and the priority inversion, not dependency derivation at large.

Persona guidance has been strengthened already: a payload that cannot produce real output is a
failed implementation, alternatives must be exhausted before declaring an input unreachable, and a
genuine blocker must become a change request rather than a degraded payload. The remaining work is
structural — a remediation rule that reopens the asset when its gate records an
accepted-but-nonpassing receipt, and dependency edges derived from the gate-to-asset policy
selection.

That remaining work is now the top ship blocker, and it is no longer a hypothesis. Two later runs
reproduced it mechanically. The `ticket.run-gate` rule emits while
`not gate_policy_has_current_terminal`, so a gate whose verifier cannot produce a valid receipt
re-emits its ticket indefinitely. The operation that would resolve it cannot: a `run-gate` attempt
is granted exactly `koni_run_check`, `koni_record_note`, and `koni_submit_output`, with no write
tool of any kind. It can execute the broken verifier and read the failure in full — stderr does
reach the agent, contrary to a first reading of the durable evidence artifact, which stores only
hashes — and it can do nothing about it. The asset-builder that owns the verifier has long since
completed and nothing reopens it.

So the loop is closed by construction: the gate cannot go green, the ticket cannot stop being
emitted, and no agent in the graph is authorized to fix the thing in the way. Both observed
instances were genuine verifier defects — one exiting 1 to report a red gate, one exiting 2 on an
argv mismatch — which is exactly the case the remediation rule exists to catch. Until an
unacceptable or nonpassing gate receipt reopens its selected asset, a research run can implement
every asset correctly and still never terminate.

The remediation rule also cannot be written in the profile as the DSL stands, which changes the size
of this work. The compiler exposes exactly fifteen gate-policy predicates — `auto_boundary`,
`auto_check`, `candidate_count`, `command_available`, `compatible`, `context_drift`, `context_hash`,
`contexts`, `evaluation_targets_ready`, `execution_ready`, `has_current_terminal`, `has_selection`,
`invalid`, `satisfied`, `selected` — and none of them expresses "this gate's verifier produced an
unacceptable receipt." `has_current_terminal` reports binary presence and `satisfied` reports
presence-and-green; neither separates "has not run yet" from "ran repeatedly and failed its result
contract every time". Those two states must drive opposite decisions — dispatch the gate, or reopen
the asset — so the condition has to become expressible before any rule can act on it. The work is
therefore a new compiler predicate first, then the profile rule, then the gate-to-asset dependency
edges, and it should be sequenced in that order rather than attempted as a configuration change.

An adjacent gap in the same family: nothing instructs the planner to inventory what the repository
already provides. Four existing `model_zoo/scripts/` modules sat unused across six runs while agents
planned to reimplement equivalent logic. Guidance now requires a reuse inventory, and the
`support_paths` field added alongside it lets a reused module actually be reachable at execution
time. The first run planned under that guidance declared concrete `support_paths` for two of three
assets and correctly left the genuinely-new verifier without any.

### 6b. Rework that accumulates instead of converging

A later run found the other end of the same problem, and it is worse than a stalled gate because it
corrupts the graph. A `plan-build-asset` review rejected the seeded asset and reopened the step per
`review_failure_reopen_from`. The builder responded by seeding _another_ asset rather than repairing
the draft it had already created, three times over, until the reviewer reported four draft assets
all declaring one capability. `max_new_nodes: 1` did not catch it: the budget is enforced per
attempt, so cumulative accumulation across reworks passes every individual check.

The consequence propagated exactly as the gate policy demands. Four candidates for one capability
means no deterministic winner, so the Lead refused to release orchestration — "unresolvable four-way
validator ambiguity" — and twelve dependency-free tickets sat unadmitted behind a run that reported
`phase=executing, blocker=None`. Nothing was wedged in the reconciliation sense; the orchestrator
had correctly decided it could not proceed.

The recovery path existed and was not taken. `lifecycle.apply-change-request` is the one operation
in the profile with `allow_node_deletion: true`, and these tickets carry
`proposal_operation: change-request`, so the builder could have proposed retiring the duplicates.
Instead it blocked, reporting that no compiled operation could resolve the ambiguity. It was wrong,
and reasonably so: nothing connected "duplicate nodes make this gate unresolvable" to "propose a
change request that retires them". Both halves are now stated — repair the existing draft on a
reopen, and escalate an ambiguity your write scope cannot fix into a change request naming the node
ids.

That makes four of this session's defects the same shape: a mechanism that exists, works, and is
undiscoverable from where the agent stands. Held provider exposure was acknowledge-then-retry. The
terminal tool must be alone in its batch. A failed assignment takes `blocker` and never `summary`.
Duplicate nodes are retired through a change request. Every one was enforced precisely and
documented nowhere the model reads, and every one cost at least a full attempt. The compiler's
contracts are sound; the gap is that agents can only satisfy contracts they are told about, and that
is a cheaper class of fix than any of the structural work above.

### 7. Configuration pinning versus iteration

Symphony re-reads `WORKFLOW.md` on change and re-applies it without restart, because an orchestrator
that cannot be corrected while running is an orchestrator you cannot operate.

Koni pins the compiled configuration at `run.create`, which is correct for audit: a run's receipts
must mean what they meant when issued. The cost, measured this session, is that four of seven runs
were killed by defects that were fixed before the run ended and could not reach it. Nothing in any
surface indicates that a run can no longer receive fixes, so an operator can spend an hour repairing
a run that was already unsalvageable.

The cheap improvement is honesty: when a run blocks and its pinned `configuration_sha256` differs
from the current project configuration, say so and recommend a new run.

The deeper question is whether everything now pinned needs to be. Three of the four unreachable
fixes were pure persona-instruction prose, which constrains no receipt and binds no hash. Splitting
the pinned _semantic contract_ — graph schema, rules, checks, scopes, anything a receipt's meaning
depends on — from _floating guidance_ would let prose corrections reach live runs without weakening
audit. This needs design work before implementation.

### 7b. A ticket whose scope its own work changes cannot validate

The gate-contract deadlock in section 5 has a sibling one level up, found after the predicate work
landed and now the blocking defect for gate-bearing assets. `ticket.implement-asset` declares
`read_scope: union[$target, gate-evaluation-subjects]`, and that second term is a live selector. The
ticket's whole purpose is to author `spec.gate_contracts` on the target asset — which changes the
gate policy's selection, which changes the subject set, which changes the ticket's own scope. The
attempt then settles against a ticket whose deterministic content no longer matches the one it was
issued against, and validation compensates with
`ticket … changed under the same deterministic identity`. Observed nine attempts on a single
`implement-asset` step, four failing exactly this way, with the graph otherwise stable at revision 7
and every other ticket in the run completed.

This is the same shape as the argv deadlock: a derivation input that the derived work is responsible
for producing. The remedy is the same in spirit — make the input stable across the attempt. Binding
the gate subject set at ticket emission, rather than re-selecting it live, would let the attempt
validate against the contract it was actually given. That touches deterministic ticket identity, so
it is a designed change rather than a scope edit.

Four separate bounds in this system were also set below the duration of the work they bound: the
120s supervisor deadline, the 180s provider-request liveness bound, and — introduced by this very
document's section 1 fix — a 300s reconciliation stall bound that retired healthy attempts
mid-validation, because an attempt that submits normally has no live process while assignment
validation runs configured checks whose own timeout reaches 900s. Each was chosen from an intuition
about how long something ought to take rather than measured against what it actually takes, and each
silently converted healthy long work into failure. Any new bound here should be derived from the
longest legitimate quiet period it must clear, and should say so where it is defined.

The fourth instance is the one that matters for anyone operating Koni unattended, because it lives
outside the harness. The operator watchdog driving these smoke tests declared a wedge after 15
minutes of unchanged revision and stopped supervising the run — while the harness's own stall bound
had been raised to 20 minutes for the reason above. For five minutes the run was neither
self-healing (the reconciler was not yet entitled to act) nor supervised (the watchdog had given
up). It then resumed on its own and completed four more tickets. The rule this yields: **an external
watchdog must be strictly looser than the harness's own recovery bound**, or it will call a wedge on
runs the harness is still allowed to fix, and its verdict will be wrong in the one direction that
costs a run. Koni should therefore publish its effective recovery bound rather than leaving
operators to guess it — a watchdog cannot be correctly tuned against a constant it cannot see. Until
it does, the conservative default is _stall bound + one reconcile tick + margin_, and a quiet period
should be reported rather than acted on.

### 8. Turn-protocol fragility

Symphony requires that an unsupported tool call return a structured failure and the session
continue.

This was the single largest source of lost work in the smoke test, and every theory advanced about
it — including the ones previously written in this section — was wrong. The cause is Koni's own
watchdog.

`PiAttemptProcessSupervisor` arms a 120-second activated-outcome deadline and refreshes it on only
two events: `reserve_provider_request` and `reconcile_provider_request`. Between those, a model that
is thinking has no way to signal liveness. Any single provider turn longer than two minutes was
therefore aborted by the supervisor, which left the reservation open and produced the accounting
message "Provider request remains reserved without a canonical assistant settlement".

This explains the duration correlation recorded earlier — aborted turns at 132–191s median against
35–74s for completed ones. That was never a provider characteristic. It was the 120s deadline, read
back through the outcome. The thinking-level and output-cap theories were correctly disproved; the
duration theory was right about the number and wrong about who owned it. It is worth stating plainly
that three successive hypotheses were formed from the attempt records alone, and the answer was
visible only in the transcripts.

Reading the durable transcripts across 172 aborted attempts settles the rest. Every one ends with a
final assistant message whose `stopReason` is `aborted` (92) or `error` (80) — never `stop`,
`toolUse`, or `length`, the three values `strictAssistantUsage` accepts. Half carry no content at
all. And each one carries an `errorMessage` field that Koni discards: 64 read "Our servers are
currently overloaded. Please try again later.", nine more say the request may be retried, four are
rate limits. Roughly 77 of the aborts were explicitly transient, retryable provider conditions
reported in plain language, and the operator saw only a sentence about held token exposure.

Three changes follow. The deadline now measures liveness rather than turn duration: a
reserved-but-unsettled request is outstanding work owned upstream, not silence, so the deadline
extends while one is genuinely open, bounded to five extensions so a wedged provider still
terminates. The provider's reported cause is now composed into the attempt error and the blocker
ahead of the accounting consequence, keeping the substring that existing retry-classification
patterns match.

Surfacing the cause immediately earned its keep, and it is the reason the rest of this section
exists. The very next abort read "provider reported: Provider request exceeded the 180000ms liveness
boundary" — a _second_, independent timer, `DEFAULT_PROVIDER_REQUEST_LIVENESS_TIMEOUT_MS`, bounding
a single reserved request to three minutes. The supervisor deadline fix was necessary but not
sufficient: attempts began surviving past 120s and then died at 225–351s instead. Twelve consecutive
planning attempts hit this bound. Its comment described three minutes as "deliberately generous",
which is simply not true of a research planner reasoning at high thinking over a large repository
before its first tool call, so it is now ten minutes — still short enough to catch a hang, long
enough not to truncate the work. With the supervisor's extension ceiling at 720s the two are
coherent, and the liveness path fires first, which is the one that produces a clean diagnostic and
retires exposure properly.

The honest lesson is that the first fix was aimed at a real defect that was not the binding one, and
only became visible because the diagnostic improved. Both timers were genuinely mis-calibrated; only
one was killing this workload.

The measured effect explains why seven runs in a row failed. Across the first thirty-six successful
attempts of the run that followed these changes, the median duration was 84 seconds and only four
exceeded the old three-minute bound — but those four were the load-bearing ones: the 891-second
planning attempt without which no run starts at all, the 330-second builder that produces the cohort
and probe signatures the whole hypothesis rests on, and two further asset implementations at 374 and
258 seconds. The short median belongs to cheap bookkeeping steps. A bound set below the duration of
substantive work does not slow a pipeline down; it selectively removes the only attempts that were
doing anything, while leaving the surrounding activity healthy enough to look fine.

The terminal-tool batch abort then reproduced in the same run, which pins it down. `ManagedSession`
requires the terminal tool to be the only call in its assistant batch and aborts the whole turn when
it is not — costing the entire attempt, held reservation and all. The rule was enforced but stated
nowhere the model reads: neither the tool description nor any persona instruction mentioned it, so
an agent pairing its submission with one last read lost a complete attempt for a formatting rule it
was never given. The description now states it.

That is a mitigation, not the fix. Symphony's rule — degrade the offending call to a structured
failure and let the session continue — remains right, and this file already shows the shape:
malformed terminal _arguments_ are recorded per call and surfaced as a normal model-visible error
result rather than killing the turn. Applying the same treatment to the batch violation needs the
authority to reject that one call so `tool_execution_end` sees `isError` and the session continues,
which is a veto path that does not exist yet. It should be built deliberately rather than improvised
into the session state machine.

### 9. An agent cannot honor a scope it is pointed at under the wrong name

The last structural blocker of the smoke test cost three full agent attempts and then wedged the run
at 8/11 tickets, and it reduces to a misspelled field name.

`define-gates` declares `write_scope: $target` — the experiment node only. Gate nodes are created
through the compiler's new-node exemption, which is deliberate and correct: a node that does not yet
exist cannot appear in a scope derived before it. But once an earlier step of the ticket commits a
gate, that gate is ordinary existing graph state, and the ticket's write scope has never contained
it. The `integrate` step then re-emitted the gate as an upsert, hit the existing-node branch of
`assertGraphDeltaScope`, and was rejected with `graph_delta_write_scope`. Three compensated reissues
replayed the identical rejection — the retry budget spent entirely on a deterministic contract
violation — and the run blocked.

The integrator was not being careless. Its persona says _"Use canonical `upsert` only for nodes
listed in `scope.write_nodes`"_, and the payload it receives carries that list as
`scope.writeNodeIds`. The field it was told to consult did not exist in the document it was given,
so the one instruction that would have prevented the rejection was unfollowable. It guessed, and its
guesses were locally reasonable: first an `applies_to` edge whose canonical source was an existing
gate, then a fresh gate node — each rejected by a different clause of the same rule. The persona's
own correct answer, _"record an empty graph delta"_, was three sentences away and never selected,
because nothing connected it to this situation.

Three lessons, in descending order of generality. **A persona that names a payload field is
asserting an interface**, and nothing checked that assertion — profile prose and payload shape
drifted apart silently. These references should be validated at profile-compile time; a persona
citing a field the runtime does not emit is a build error, not a runtime guess. **A ticket that
authors nodes cannot later compose them**, which is sound but non-obvious, and the personas that
integrate such tickets must be told so explicitly rather than left to infer it from a rejection. **A
deterministic contract violation is not a transient race**: the compensated-reissue path exists for
`graph_delta_cas` losses under concurrent compile, and spending its budget replaying a scope
violation is pure waste. Failure codes already distinguish these cases; the retry path should read
them.

The blocker also told the operator nothing. Its message was
`ticket validation action did not complete with its exact accepted assignment (compensated)` — the
journal status and not one word about the scope violation that caused it, which was sitting in the
action ledger the whole time. Diagnosing it meant reading `actionExecutions` by hand. The message
now carries the failed step's error, which is the difference between an actionable blocker and an
invitation to go digging.

### 10. A refusal is a fact about the verifier, not about the graph

The next run reproduced section 6's shape with a new cause and exposed a defect one level beneath
it. A generated gate verifier called `os.makedirs()` for an output directory. The `gate-verifier`
check declares `effect: read_only` and runs under a macOS seatbelt sandbox, so the call raised
`PermissionError: Operation not permitted` and the receipt failed its result contract — the compiler
listing all ten violations precisely, none of which was the actual cause. Writing an output
directory is ordinary practice, and nothing told the author not to: `asset-builder` explains
`output_root`, `result_path`, and artifacts at length, but those belong to the separate
`scientific-runtime` check, which is `workspace_write`. The profile already set
`PYTHONDONTWRITEBYTECODE` on the verifier environment, so incidental writes had been anticipated;
author-written output had not. The guidance now states that a verifier must not create anything and
that its stdout is its entire result.

The deeper defect is what happened next. `gate_policy_receipt_refused` — added earlier so a refused
receipt reopens its asset rather than re-running a broken gate forever — **evaluated `true`, exactly
as designed, and still changed nothing.** Receipt-derived predicates are keyed through
`rulePredicateEvidenceKey`, which includes `inputGraphSha256`. The refusal was recorded against
graph `65cf25fb`; by the time any rule consulted it the graph stood at `b6af5aef`, revision 10. The
key missed, the predicate read `false`, and both rules that depend on it went the wrong way at once:
the asset never reopened, and `ticket.run-gate`'s `not refused` guard let the gate re-run the same
broken verifier. Four refused receipts, no remediation.

This is not an oversight the new predicate stumbled into — it is an acknowledged limitation it
inherited, and the remedy is already named in the source. Koni does carry a rebinding pass,
`rebindRuleEvidenceAcrossNonInterferingGraphChange`, which re-keys a predicate onto a new graph hash
when its recursively resolved scope is byte-identical, dropping fail-closed whatever it cannot
project. But `ruleEvidencePredicateGraphScopeSha256` projects only `check_passed`,
`check_has_current_terminal`, and `current_receipt`. Every `gate_policy_*` op returns `undefined`
and is dropped, for a reason the code states plainly: _"Policy selection can depend on the complete
candidate graph. Until that selection exposes a dedicated deterministic footprint, preserve its
receipt only on the exact whole-graph hash."_ That is the correct conservative default for
`gate_policy_satisfied`, where a wrong answer would let an unproven gate read as green.

A refusal is different in kind, and that difference is what makes it worth separating. It is not a
claim about the graph or about which asset a policy would select today; it is a claim about a
program — that this verifier cannot produce a valid receipt — and it stays true until the program is
repaired. What it needs is exactly the footprint the comment says is missing: the selected asset's
identity together with its manifest hash. Keyed that way, a refusal survives unrelated graph motion
and is invalidated by the repair itself, because repairing the verifier changes the manifest — which
is precisely the semantics the rule comment already claims and does not get.

So the work is to give gate-policy selection that deterministic footprint, starting with the refusal
case where the fail-closed default is most costly. That is a change to the compiler's evidence model
rather than a rule edit, and it should be designed rather than improvised; this document's own worst
regression came from patching an identity check under time pressure.

The general form is worth stating, because three separate defects tonight share it: **evidence keyed
more tightly than the fact it records expires before it can be used.** A predicate that is true at
the moment of recording and false one revision later is not a predicate the rule engine can build
remediation on.

### 11. The escape hatch that nothing could open

Making the change-request remedy discoverable had a consequence worth recording, because it is the
clearest instance of this session's recurring shape. Agents began using it — correctly. A
`resolve-assets` attempt found that its planning and rework attempts had both held
`Readable: none / Writable: none`, so the real `model_zoo` index and probe entrypoint were
undiscoverable in-attempt and the asset had been written with fixture stand-ins. Rather than guess
again, the agent raised a change request asking for read scope. That is exactly the behaviour the
guidance was added to produce.

The run then deadlocked, because nothing could answer it. A `proposal` role ticket stays `proposed`
until it carries exact approval authority, so the proposal's three steps never dispatched and the
last research ticket waited on them forever. `decideProposal` existed and worked — from the TUI and
from the Pi companion. It had no CLI surface. An operator driving Koni headlessly, which is the
entire premise of an unattended long run, could not answer a question the harness had just decided
to ask them. Worse, the blocker was typed `resume`, so the operator loop dutifully resumed every
twenty seconds, each resume re-running the Lead to re-derive the identical diagnosis, until its
retry budget ran out.

Both halves are fixed.
`koni decide --run <id> (--approve|--reject) [--proposal <ticket>] [--message]` mirrors
`koni acknowledge`, and a deadlock that traces to an undecided proposal is now typed
`change_request` rather than `resume`, with guidance naming the command. Applied to the live run,
the proposal moved `proposed → ready` with `actor: operator`, its steps became schedulable, and the
run resumed from 10/12 — the deadlock cleared without a restart.

This is the third mechanism this session that existed, worked, and was unreachable from where the
operator stood; `koni acknowledge` and the change-request remedy itself were the first two. The
pattern is specific enough to be worth a rule: **every state the harness can enter that requires a
human decision needs a non-interactive surface for making it.** A decision that only a TUI can
express is not available to an unattended run, and an unattended run is what Koni is for. The typed
remedy is what makes this checkable — any blocker whose remedy is not `auto` or `resume` should name
a command that exists.

### 12. A grant that makes the operation impossible

Section 11's change request had a cause worth separating from it, because the change-request
machinery was never going to fix it. `ticket.resolve-prerequisite-asset` emits with
`read_scope: $target`, `write_scope: $target`, and **no `read_paths` at all**. The operation's whole
job is deciding whether an existing repository asset already satisfies a prerequisite — a question
answerable only by reading that asset's files. Every attempt therefore ran with `Readable: none`,
and the only output available to an honest agent was a manifest full of fixture stand-ins for
entrypoints it had never been permitted to look at.

The agent handled this about as well as it could: it recorded the blocker in a note, raised a change
request naming the paths it needed, and refused to invent more. But a change request proposes a
**graph** change, and the missing authority was a **path grant**, which is derived from the emitting
rule and cannot be widened by any proposal. The escape hatch existed, was reachable once section
11's CLI gap closed, and still could not resolve this class of blocker — the run had asked a
question the mechanism was not shaped to answer. Sibling rules already grant paths this way
(`implement-asset` selects `spec.implementation_plan.root`), so the omission reads as an oversight
rather than a policy; the rule now grants the materialized implementation roots of active assets,
which restores an evidence-based decision without widening node scope.

Run three then blocked at 12/13 on `typed change-control output cannot also contain graphDelta`, and
this one is **recorded unresolved** — with the evidence gathered, and two theories eliminated rather
than merely untested.

The agent-facing half is understood and fixed. Two `plan-asset` attempts submitted outputs carrying
both `upstreamChangeRequest` and `graphDelta`; each was refused, compensated, and retired. That is
the step named `propose-graph-delta`, whose contract is a typed declaration of
`{operation, targetNodeIds, summary}` with `additionalProperties: false`, sitting inside a persona
whose dominant instruction set is otherwise entirely about emitting graph deltas. The step name
teaches the opposite of its own contract, and the integrator guidance now says so explicitly.

What remains unexplained is why the run kept blocking on that message afterwards. Established by
direct inspection of the durable record: at block time no attempt was running, no action was
unsettled, both collision actions were settled, the error carried no ticket id, and it recurred
identically across a full stop/start/resume cycle — so it is raised during run-level compilation
rather than at submission. A scan of every stored terminal output in the run found exactly two
carrying both fields, both belonging to those already-retired attempts.

The next run reproduced it, which corrected where the guidance belonged and preserved a live case.
The collision recurred with the new change-control paragraph already pinned — because that paragraph
went into `integrator.yaml`, and the step that submits the offending output is `plan-asset`, whose
persona is `asset-builder`. The integrator does own `integrate`, so the text is not wrong there; it
was simply not where these attempts were failing. `asset-builder` is the persona already instructed
to raise upstream change requests, and it was never told that a request and a `graphDelta` cannot
travel together. It now is. The general lesson is narrow and practical: **guidance has to be
attached to the persona that owns the failing step, not the one that owns the concept** — the step
id and the operation name were both misleading here, and only the step's `personaId` settles it.

`run-13714528` is left holding that reproduction: two `plan-asset` attempts whose stored outputs
carry both fields, both of their validation actions compensated and settled, and a run that
re-blocks on every resume with no attempt running. Anyone picking this up has the durable record
rather than a description of it.

Two explanations are ruled out. It is **not** a composed-output collision across a ticket's steps:
`hasUpstreamRequest` and `hasChangeApplication` are read from one output's root, so no combination
of separate step outputs can trigger the rule — which also retires the guess an earlier draft of
this section recorded. And it is **not** a live attempt resubmitting the pair, because none was
running. What is left is a compilation path that re-reads a retired attempt's stored bytes, which
would make one poisoned output permanently fatal to its run. That is a direction to investigate, not
a finding; it needs a deliberate reproduction, and this area has already produced two confident
wrong answers.

### 12b. The schema advertised the combination it refuses

The submission half of that collision does have an answer, and it is not the one three rounds of
persona guidance assumed. `transportToolSchema` flattens the terminal submit union into a single
merged object, deliberately and for a good reason recorded in its own comment: root-union schemas
flatten to zero properties in provider tool transforms, so an agent facing the raw union cannot
target the contract at all. The merge fixes that. What it costs is the one thing the union expressed
for free — that branch fields are **mutually exclusive**. After merging, every branch-specific field
arrives as an optional sibling of every other. `graphDelta` and `upstreamChangeRequest` are
presented to the model as two optional properties of one object, and filling in both reads as
thorough rather than illegal. The authority then refuses the pair and discards the whole attempt.

This is why the defect kept recurring across different runs, different personas, and different
steps: **23 configured operations permit both a graph mutation and an upstream request**, so every
one of them is a site for it. Persona prose was written three times against a shape that
contradicted it — twice into the wrong persona file, because the failing step's id
(`propose-graph-delta`) and its operation name both point away from the persona that actually owns
it. Only `personaId` settles that, and none of it would have mattered: prose loses to shape.

The merged object now states what merging removed. `mutuallyExclusiveFieldGroups` computes, from the
branches themselves, which fields never co-occur, and the description names them — so the exclusion
travels with the fields rather than living in a persona that may or may not mention it. Being tool
contract rather than pinned profile, that correction reached every run and every persona on the next
install, which is exactly the property section 7 argues guidance should have.

The general rule is the one worth keeping: **when several personas make the same mistake, suspect
the contract they share before the instructions they were each given.** A schema that permits an
invalid state will produce it, however clearly the prose forbids it.

### 13. Scope without materialization is worse than no scope

Section 12's path grant went live in the next run and worked exactly as intended — which is how it
exposed a deeper defect, and revealed that the grant alone is necessary but not sufficient.

Two `resolve-assets` tickets used their new read access to inspect `program/assets` with
`koni_list_files(recursive)`, found the directories for the assets they were evaluating absent,
confirmed no alternative asset could satisfy their prerequisite, and each raised a careful,
well-evidenced change request asking for write scope so the declared files could be authored. Both
tickets then blocked awaiting a decision. The reasoning was impeccable and the conclusion was wrong.
The files exist. `git ls-tree` on the run's integration branch lists
`program/assets/classifier-dependency-availability/verify_classifier_dependency_availability.py`,
its `pinned_dependency_manifest.json`, and the matching pair under
`program/assets/probe-extraction-code-executability/` — authored by `implement-asset` tickets that
had already **completed** with exactly those write paths.

The assets were simply never materialized into the evaluating ticket's worktree. One of the two
carries `dependencyIds: []`; its worktree holds `muat_v25/.gitkeep` and an unrelated gate's files
and nothing else. A ticket whose entire question is _"does an existing asset satisfy this
prerequisite?"_ was handed a worktree that does not contain the assets, and a read grant over the
directory where they were missing.

The dependency wiring underneath is worth recording as an open anomaly, because it does not match
what the derivation appears to promise. All three `resolve-assets` tickets were emitted in one
compile with the identical read scope `program/assets`, and dependencies derive from scope overlap
against higher-priority predecessors — `implement-asset` at rule priority 155 sorts ahead of
`resolve-assets` at 140, and `pathsOverlap` handles parent/child containment in both directions.
Three tickets with one scope should therefore derive one dependency set. They did not: the three
carry `[]`, `[TK-d7aa86e4…]`, and `[TK-9e00677b…]`, and in neither blocked case is the listed
dependency the `implement-asset` ticket that authored the files that ticket needed.

A later run sharpened this and eliminated the obvious explanation. Materialization is not merely
absent — it is **partial and not explained by declared dependencies**. A `resolve-assets` ticket
carrying `dependencyIds: []` received one completed asset's files
(`fp-metadata-confound-protocol-verifier`, four files) and not another's
(`fp-model-zoo-split-manifest-verifier`, two files), though both `implement-asset` tickets had
completed and the integration branch carries both. So "dependencies drive what lands in the
worktree" is wrong: a ticket with no dependencies still got one and not the other.

By the time that run reached 14/23 the pattern had become a per-prerequisite tax: **three of its
five `resolve-assets` tickets were blocked at once**, each having raised its own change request. The
agents' wording had also converged on the right answer — the later requests ask to "materialize the
declared files" rather than for write scope to author them, which is exactly correct. And that is
what makes this the sharpest form of the defect: **the escape hatch is reachable, the agent uses it
precisely, and no available decision resolves it.** Change control proposes graph changes; it cannot
materialize a worktree. Approving would authorize re-authoring files that already exist; rejecting
returns the ticket to a worktree that still lacks them, where it will re-verify and re-request.
There is no correct operator action, which is a different and worse condition than the unreachable
remedy of section 11.

The run that reached 21/23 closed this argument in the harness's own words, and the result is worth
quoting because it is the strongest evidence in this document. With one ticket left blocked, the
configured Lead review fired and returned: _"The deadlock is a **stale-visibility review
rejection**, not a missing execution path: TK-dc143412e7f90def's review demanded that plan-asset
materialize asset-fp-probe-pipeline-inference-mode-verifier's two files, but that ticket's grant is
`writePaths:[]` so its **reopen loop is structurally incapable of succeeding** — while the board's
correctly-granted operation for that exact repair … is already completed with its own
verify/integrate/review confirming both declared files materialized and hash-matched."_ It went
further, noting the run had _"twice produced the same false-absence finding for sibling assets"_ —
citing each false note and the note that refuted it — that three change requests of the same class
had closed unactioned, and that the unmet obligation was _"satisfied by concrete graph facts."_ Its
verdict was **"Proceed."**

Every part of that is correct, and it is a better diagnosis than the one reached from outside the
run with `git ls-tree`. The Lead identified the false-absence class, proved the files existed by
pointing at the completed implementing ticket's own hash-matched receipts, recognised its own run
had recorded both the false findings and their refutations, and concluded the obligation was already
met. Then the run stayed blocked, because a Lead judgment of "proceed" carries no authority over a
`review` step that has failed with `reviewReworkCount 1/1`.

So the escalation path is not missing and not unreachable — it **runs, reaches the right answer, and
cannot act on it**. That is a third distinct failure shape, past section 11's unreachable remedy and
past the no-correct-decision case above: a correct conclusion with no route into the state machine.
Whatever weight a Lead judgment is meant to carry, "the review that blocked this ticket was
factually wrong, and here is the completed ticket whose receipts prove it" should be able to clear a
rework counter. Today it cannot, and a run one ticket from a complete board stops.

The third instance in that run is the one to act on, because it reached the review gate. A `review`
step rejected an asset as not ready — "Pre-commit asset readiness review fails again (rework ordinal
1 confirmed unresolved)" — after independently listing `program/assets` and finding only three
materialized directories, with `fp-probe-pipeline-inference-mode-verifier` absent. That directory is
on the integration branch. **The reviewer rejected completed, correct work**, and a rejection is not
inert: it sends the producing step back to redo work that was already done, whose output will be
equally invisible to the next review, which will reject it again. An unmaterialized worktree does
not merely block a ticket — at a review boundary it manufactures a rework loop and records a false
negative in the run's own audit trail. Of everything in this section, that is the part that damages
the receipts Koni exists to produce.

That partiality is what makes the failure mode dangerous rather than merely inconvenient. The agent
did not face an empty directory that might plausibly signal a missing grant. It faced a populated
`program/assets` holding a comparable sibling verifier, searched it three ways (`koni_list_files`,
`koni_search_files`, `koni_read_file` on both claimed paths), and reasoned — correctly from what it
could see — that the compiler-owned `asset_manifest` claiming `implementation_status: ready` with
concrete content hashes must be reconciled against files that do not exist. The manifest was
truthful; the worktree was not complete. **A selectively populated scope is more misleading than an
empty one**, because the visible sibling is evidence that materialization worked, which makes
absence read as non-existence. Why one asset materialized and the other did not is the open
question, and it is the same question as the dependency anomaly above.

That combination is the finding, and it generalizes past this rule. **Granting read scope over a
location the run has not materialized manufactures false evidence.** Before the grant, the operation
could not look and produced fixture stand-ins — visibly degraded output that review can catch. After
it, the operation looks, sees an authoritative-looking absence, and produces a confident, precisely
argued, entirely wrong conclusion — plus a change request that blocks its ticket and demands
operator attention. The second failure is harder to catch precisely because the evidence trail is
impeccable. An agent cannot distinguish "this does not exist" from "this was not materialized for
you," and nothing in the payload tells it which it is looking at.

Two things follow. A ticket that evaluates existing assets needs those assets materialized —
dependency derivation, not path scope, is the missing authority, and the same `dependencyIds: []`
gap that section 6 noted for gate tickets is the mechanism here. And until materialization is
guaranteed, a scope grant should be accompanied by something the agent can check: if the read scope
names a root the run has not populated for this ticket, the agent should be told that rather than
left to infer authorship is required. Deciding the two proposals was straightforward once the
integration branch was inspected — both rejected, with the actual file locations in the decision
message — but no agent could have reached that answer from inside its own grant.

### 14. One bad output stops every ticket, not its own

The three deepest runs of the session all ended the same way, and the shape matters more than any of
the individual defects that triggered it. Run three stopped at 12/13, run five at 9/15, run six at
3/10 — each with most of its board still schedulable. Run six is the clearest specimen: **seven
tickets `ready`, zero running, phase `blocked`**, because one configured check on one `run` node's
`runtime_contract` would not resolve —
`check scientific-result-integrity … must be one exact nonempty argv array`. Nothing was wrong with
the other seven tickets. They simply could not be dispatched, because dispatch requires compiling
the board and compiling the board requires validating that contract.

An earlier draft of this section attributed that to the contract carrying `scientific_inputs` with
`argv: null`. **That was wrong, and the correction matters more than the original claim.** The
`runtime_contract` schema has no `argv` field — the argv lives in `command` — so a probe reading
`argv` returns null for every contract ever written, including entirely valid ones. Re-read against
the real field names, the failing contracts in both runs carry a fully populated `command`, a valid
`result_protocol`, `composed_verification_command`, `asset_entrypoints`, and `scientific_inputs`.
Nothing was missing. Why the check nevertheless refuses to resolve is **not established**, and it is
recorded here as unresolved rather than replaced with a second guess. The lesson is one this
document has now paid for twice: a probe that queries a field name the schema does not define
reports absence everywhere and looks like a finding. Confirm field names against the schema before
believing a null.

Fail-closed compilation is right, and this document has argued throughout against weakening it. But
fail-closed at the **board** level converts every localized defect into a total stop. The blast
radius of one agent's malformed output is the whole run, and the remedies available — resume, stop,
new run — are all run-scoped too, so an operator cannot quarantine the bad ticket and let the other
seven proceed. That is why these runs die at a high ticket count rather than degrading: they are not
running out of work, they are losing the ability to schedule any of it.

Two consequences worth separating. First, the recurrence in section 12 is the same phenomenon, which
retires the "poisoned bytes get replayed" framing: the compile is not replaying a retired attempt,
it is re-validating durable graph state that a retired attempt left behind, and failing the whole
board each time. Second, the resume loop an unattended operator runs against this is pure waste —
every resume re-attempts the identical compile, which is why the driver burns its budget at roughly
one attempt per twenty seconds and finishes no closer.

The proposal below is more clearly feasible than it first appears, because Koni already does exactly
this for a different failure class. When a `review` step rejects an asset, that ticket goes
`blocked` with the reviewer's diagnosis attached while the run stays `executing` and every other
ticket keeps dispatching — observed in the run that reached 10/19 with one `resolve-assets` ticket
blocked on a review rejection and the rest advancing. Ticket-scoped blocking, per-ticket diagnosis,
and continued scheduling around it are all implemented. What is missing is routing compile failures
through the same path instead of failing the board.

The design question is therefore narrower than "should this be possible": it is whether a compile
failure attributable to one ticket's durable state can be **attributed** reliably enough to reuse
the existing mechanism — mark that ticket blocked with the compiler's own diagnosis, exclude it from
the board, and compile the rest. That preserves fail-closed semantics exactly where the defect is
while letting independent work continue, and it would have turned three total stops into three
degraded runs that kept making progress. It is a change to the compiler's error boundary rather than
to any rule, and it should be designed deliberately — but of everything in this document, it is the
item that would most change how a long autonomous run behaves when something goes wrong.

## Consequences

The first three items are what make a long run operable: without reconciliation a run can stop
silently, without typed remedies an operator cannot tell recoverable from dead, and without epoch
invalidation a fix cannot reach the agent that needs it. They are also the cheapest, because Koni
already owns the mechanisms and needs only to connect them.

Items four through six improve the economics and honesty of the work itself. Items seven and eight
are genuine design questions that should not be resolved by patching.

Items nine through thirteen came from driving the harness after those first fixes landed, and they
sort differently — not by cost, but by where the defect lives. Three of them (9, 10, 13) are cases
where **the agent was told something the runtime does not honour, or not told something it
enforces**: a persona citing a payload field that does not exist, a verifier contract that forbids
writes without saying so, a read grant over a directory the run never materialized. Two (11, 12) are
cases where **a mechanism worked and could not be reached**: a proposal decision with no
non-interactive surface, and an operation whose grant made its own question unanswerable. And
section 12's live reproduction turned out to be neither — the terminal submit union is flattened for
transport, which advertises mutually exclusive fields as combinable, so 23 operations invite an
output the authority refuses.

That last one is the shape to generalize from, because it was misdiagnosed twice as an agent problem
before the schema was read. **When several personas make the same mistake, suspect the contract they
share rather than the instructions they were each given.** Persona guidance was written three times
for that collision — twice into the wrong file — before the flattening was found, and each of those
attempts cost a run, because personas are pinned and the tool contract is not.

Ranked for ship: the reachability defects (11, 12) are the ones that strand an unattended run with
no path forward and should land first; the contract-honesty defects (9, 10, 12b, 13) are what make
agent output trustworthy and are cheap now that the pattern is named; the open items — section 10's
evidence keying, section 12's recurrence, and the dependency-derivation anomaly in 13 — each need a
deliberate reproduction rather than another confident fix.

Nothing here argues for weakening compiler authority, durable receipts, or fail-closed verification.
The observed failures were not caused by that strictness; they were caused by strictness without a
reconciliation loop, without typed outcomes, and without a way to tell an agent that the world
changed underneath it. The later items sharpen that: strictness is only fair when the contract the
agent is judged against is the contract it was actually shown.
