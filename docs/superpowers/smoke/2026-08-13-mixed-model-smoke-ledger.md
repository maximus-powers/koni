# Mixed-model full-run smoke ledger — 2026-08-13

## Qualification boundary

- Core branch: `pi-native-port`
- Candidate Core commit: `084a900`
- Installed Core commit: `084a900`
- Research profile candidate: `@koni/research-profile` 1.1.33, bundle
  `sha256:ebcf924803e52dc319ab7f5052cf96d70c486f8d934d8fa578831a7030de123f`
- Coding profile: `@koni/coding-profile` 0.8.19, bundle
  `sha256:5410098799856a859f972a8e2b44d7ed422e590b6715b476f6f83b52ebab5519`
- Exact admitted models: historical mixed runs used `anthropic/claude-haiku-4-5` and
  `openai-codex/gpt-5.6-luna`; current v36/v30 runs use `openai-codex/gpt-5.6-luna` for every
  persona, all at `medium`
- Final boundary: promotion-ready only. No merge, push, deploy, publication, or destructive action.

## Replay runs

### Research — MUAT

- Repository: `/Users/max/Desktop/muat-luna-profile-smoke-20260812-v24`
- Run: `run-c0faae7b-d556-4a8e-b180-d4a168bd4d56`
- Target: `smoke/mixed-research-investigation-149-20260813-v33`
- Objective: committed investigation 149 crosswalk audit over attempt 147 artifacts
- Model matrix:
  - Luna: run-planner, hypothesis-planner, experiment-designer, run-operator, reviewer,
    report-writer
  - Haiku: lead, research-scout, gate-designer, asset-builder, evidence-analyst, integrator,
    dashboard-reporter
- Started: 2026-08-13 10:40 America/Phoenix
- Current milestone: approved exact revision-0 checkpoint; compiling research board
- Planning checkpoint: artifact
  `sha256:5fa53a758627da15823009110522fc78e85eaf2af3445965a2c93ef9145e8c41`, graph
  `sha256:7f300e00aca578cb5331c216ffc89a4077fcd8634e025dbe65980f488faa3be3`, transcript
  `sha256:508322037602cfe3a60c48f7dcece611b1e13efabd277c5e1ff691c3205862aa`
- Result: retained as a RED checkpoint after same-ticket repository work was repeatedly retired by
  an unnecessary planned-asset repair loop.

#### Fresh Research replay

- Run: `run-7d8ea87f-307e-4774-9179-cd066451dd41`
- Target: `smoke/mixed-research-investigation-149-20260813-v34`
- Objective: unchanged from v33
- Exact run configuration: all personas use `openai-codex/gpt-5.6-luna` at `medium`; this supersedes
  the historical mixed-model matrix above for this replay.
- Started: 2026-08-13 11:31 America/Phoenix
- Current milestone: retained as a RED checkpoint after gate definition requested an upstream
  capability-node proposal for a new interface that belongs inside the authorized gate's embedded
  `spec.capability` contract.

#### Gate-contract replay

- Run: `run-cccebd02-ec02-47e3-9ddc-42b31f2b3f11`
- Target: `smoke/mixed-research-investigation-149-20260813-v35`
- Objective: unchanged from v33/v34
- Exact run configuration: all personas use `openai-codex/gpt-5.6-luna` at `medium`.
- Started: 2026-08-13 11:47 America/Phoenix
- Planning checkpoint: artifact
  `sha256:e41841553063f516e909f6f1bbecc82972a89e525cf418943b6703d773f028db`, graph
  `sha256:afc4e461fa6394d57137f79c93aa4b676a6ae468644b487a2a7d80a9e673a40c`, transcript
  `sha256:a7a325bfedb35258022bd5d926376af73009d597792ef55334d9bc89ff34db04`
- Result: retained as a RED checkpoint after run-plan compilation launched alongside unresolved
  prerequisite work and requested operator change control for the still-closing exact-input manifest
  and a post-result verifier that the original runtime asset should have provisioned.

#### Prerequisite-closure replay

- Run: `run-2f2752fc-9ab7-4860-a0db-ffc5e08dbf0b`
- Target: `smoke/mixed-research-investigation-149-20260813-v36`
- Objective: unchanged from v33/v34/v35
- Exact run configuration: all personas use `openai-codex/gpt-5.6-luna` at `medium`.
- Started: 2026-08-13 12:30 America/Phoenix
- Current milestone: revision-0 planning is active on Research 1.1.33 / exact Core `084a900`; the
  MUAT left-panel TUI shows this fresh run.

### Coding — Updog

- Repository: `/Users/max/Desktop/updog-luna-profile-smoke-20260812-v11`
- Run: `run-fa970e72-a821-480c-96fb-002fd19b0aa4`
- Target: `smoke/mixed-coding-analysis-guide-20260813-v28`
- Objective: add a real URL-backed Analysis Guide tab with focused regression coverage
- Model matrix:
  - Haiku: run-planner, architecture-mapper, change-designer, implementer, verifier
  - Luna: lead, contract-designer, risk-analyst, reviewer, integrator
- Started: 2026-08-13 10:33 America/Phoenix
- Current milestone: approved exact revision-0 checkpoint; compiling delivery board
- Planning checkpoint: artifact
  `sha256:9d937d1c8e736928241a50979f59622ecdfecf2971437f0cbb3b86c807eefcdf`, graph
  `sha256:71c26daa034392de89cb7330a163e461f42874d9329ad3bb1d047439db1ebaf6`, transcript
  `sha256:18e093c30f3c41a0bb2288d4dd3f15acaca1953a27fb854e23a0ed3aa8dd5169`
- Result: retained as a RED checkpoint after the first exact edge-only graph delta compiled but
  receipt hashing rejected the in-memory optional ticket fields that durable JSON correctly omits.

#### Fresh Coding replay

- Run: `run-a3d2da7b-5cba-49af-90ec-67dbdf4fa35e`
- Target: `smoke/mixed-coding-analysis-guide-20260813-v29`
- Objective: unchanged from v28
- Exact run configuration: all personas use `openai-codex/gpt-5.6-luna` at `medium`; this supersedes
  the historical mixed-model matrix above for this replay.
- Started: 2026-08-13 11:20 America/Phoenix
- Result: retained as a bounded RED checkpoint after repeated provider-input pressure compaction
  preserved one indivisible oversized assistant tool-call batch, leaving the immediate successor
  request above Luna's reserved-input ceiling. Automatic recovery stopped at its global bound
  without widening authority or spending indefinitely.

#### Provider-pressure replay

- Run: `run-d7d350cf-e801-4da7-bc4f-74739e2f7262`
- Target: `smoke/mixed-coding-analysis-guide-20260813-v30`
- Objective: unchanged from v28/v29
- Exact run configuration: all personas use `openai-codex/gpt-5.6-luna` at `medium`.
- Started: 2026-08-13 12:12 America/Phoenix
- Result: retained as a bounded RED checkpoint. The corrected pressure compaction discarded the
  oversized turn and allowed three compiler-directed submissions, but Luna consumed the full 120K
  revision allowance with two typed graph defects remaining; no planning checkpoint validated and no
  authority widened.

## Pre-qualification evidence retained

| Run                                        | Profile/model                     | Observed failure                                                                                                                                                                                                                                                                 | Classification                                                                  | Resulting change                                                                                                                                                                                                                                                                               |
| ------------------------------------------ | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run-ed53ff3c-0ea2-428c-b002-77a9a81513ec` | Research 1.1.30, Luna             | Repository-only asset repair reached an Integrator contract that unconditionally required a graph mutation.                                                                                                                                                                      | Profile execution-contract contradiction                                        | `74732c3`: Research 1.1.31 permits an exact empty delta at the mixed publication/repair boundary.                                                                                                                                                                                              |
| `run-b77453ec-49dd-41f6-a514-d5d50b258adf` | Coding 0.8.19, Luna               | A repository worker exhausted a 120K semantic attempt envelope after authenticated discovery and compaction; the retry inherited the same under-sized envelope.                                                                                                                  | Generic attempt-budget sizing defect                                            | `edd3b7c`: ticket work receives a bounded 2× semantic envelope; retry/rework/global caps are unchanged.                                                                                                                                                                                        |
| `run-bd0d7e2a-093e-4df2-a038-a9d9915a4fbc` | Research 1.1.31, mixed Luna/Haiku | Haiku asset-builder repeatedly sent the new-file CAS precondition as the string `"null"`; exact authority rejected it, and the agent opened an unnecessary upstream proposal.                                                                                                    | Generic provider presentation normalization defect                              | `74730e7`: schema-directed JSON scalar normalization accepts only a decoded value authorized by the exact issued field contract.                                                                                                                                                               |
| `run-f4a5a6c0-0706-4059-a401-7e51bf7605df` | Coding 0.8.19, mixed Haiku/Luna   | Haiku planning stringified nested terminal objects. Koni decoded them, but reported only the original transport shape; a fallback planning note then failed against the revision-scoped grant ID and left no durable receipt.                                                    | Generic transport-diagnostic and continuous-planning identity defects           | `74730e7`: diagnostics use the normalized candidate, legitimate JSON-looking strings stay intact, and agent tools authenticate the exact stable planning-revision grant.                                                                                                                       |
| `run-a3057b40-c7e6-4641-a8af-678eff3d77d1` | Research 1.1.31, mixed Luna/Haiku | The repaired transport reached genuine schema and compiler diagnostics, but Luna consumed the bounded revision-0 allowance before removing the last impermissible edge. All failures had durable no-effect receipts.                                                             | Bounded stochastic planner non-convergence, not an authority or compiler defect | Retained as a bounded RED run; launched unchanged v33 replay to distinguish recurring policy ambiguity from one-run model variance.                                                                                                                                                            |
| `run-fa970e72-a821-480c-96fb-002fd19b0aa4` | Coding 0.8.19, mixed Haiku/Luna   | A valid edge-only architecture delta compiled follow-up tickets, then direct receipt hashing failed because the in-memory ticket projection retained optional `undefined` fields that durable JSON omits.                                                                        | Generic durable-projection hashing defect                                       | `eda1f56`: direct and configured ticket-board receipts hash the exact durable JSON projection. Core authority tests pass 129/129 with the 30-second integration timeout.                                                                                                                       |
| `run-c0faae7b-d556-4a8e-b180-d4a168bd4d56` | Research 1.1.31, mixed Luna/Haiku | The asset workflow created the concrete files, but implement/verify requested planned asset repair for semantic publication already owned by the same ticket's later Integrator. Each route retired the file-bearing worktree and reopened implementation.                       | Generic workflow-handoff versus upstream-authority prompt contradiction         | `5970589`: Core identifies causal downstream graph-publication steps, keeps their semantic handoff in predecessor evidence, and reserves change control for authority the complete workflow cannot satisfy. Shared profile-authoring guidance records the same invariant.                      |
| `run-7d8ea87f-307e-4774-9179-cd066451dd41` | Research 1.1.31, Luna             | Gate definition correctly found no compatible visible verifier interface, then interpreted the new embedded gate capability contract as a missing external capability node and requested operator change control.                                                                | Research modeling-policy ambiguity                                              | `f374d00`: Research 1.1.32 makes the gate-local contract boundary explicit in the persona, operation, and reusable empirical-modeling skill; later asset resolution owns provider implementation.                                                                                              |
| `run-a3d2da7b-5cba-49af-90ec-67dbdf4fa35e` | Coding 0.8.19, Luna               | A second provider-input compaction retained an indivisible oversized assistant tool-call batch because Pi's small recent-token boundary fell at that assistant entry; Koni's authenticated checkpoint plus the retained tail immediately exceeded Luna's reserved-input ceiling. | Generic provider-pressure compaction-boundary defect                            | `54af8d3`: only an exact current typed Koni exposure failure may move the boundary to its exact durable zero-usage assistant error; authorization, persisted compaction, and cold recovery bind the same entry, while mismatches keep Pi's conservative boundary.                              |
| `run-cccebd02-ec02-47e3-9ddc-42b31f2b3f11` | Research 1.1.32, Luna             | Run-plan compilation launched before its direct prerequisite resolved, then asked the operator to supply the still-closing exact-input manifest and a distinct post-result verifier absent from the completed runtime asset.                                                     | Research closure-ordering and asset-completeness policy gap                     | `084a900`: Research 1.1.33 includes direct prerequisites in compile-run-plan read authority so existing scope conflicts order their producers, and requires every planned scientific runtime asset to provision a distinct repository-owned read-only post-result verifier before compilation. |

## Observation log

- 10:04 — Installed exact Core build containing `edd3b7c`; restarted both project authorities.
- 10:08 — Created both qualifying runs through authenticated `run.create` persona overrides;
  immutable run records confirm every exact provider/model/thinking selection.
- 10:09 — Both planning agents remained live; Research reached its synthesis boundary without a
  question or provider substitution.
- 10:13 — Research revision 0 validated an eight-node graph. Audit confirmed bounded empirical
  scope, explicit no-training/no-holdout constraints, progressive preparation → observation →
  analysis → review → reporting closure, and exact artifact/graph hashes; approved that checkpoint.
- 10:17 — Research asset execution exposed provider-stringified `null`; exact authority correctly
  denied writes, but transport normalization was too narrow and the run entered an avoidable
  upstream hold.
- 10:19 — Coding planning exposed decoded-object diagnostics bound to the pre-normalized payload,
  followed by a continuous-planning grant identity mismatch on `koni_record_note`; retained both
  runs as RED evidence rather than approving or repairing their contaminated state.
- 10:29 — Added test-first, schema-directed provider normalization and revision-aware planning tool
  identity in `74730e7`. Affected Core suites pass 110/110; Core typecheck, targeted lint,
  formatting, and diff integrity pass.
- 10:33 — Installed `74730e7`, restarted both authorities, replaced both left-panel TUI tabs without
  a visibility gap, and created fresh v32/v28 replay runs from the unchanged objectives/intake.
  Durable records confirm `medium`, the exact requested Haiku/Luna persona matrices, and unchanged
  authenticated profile bundles.
- 10:40 — Research v32 proved the repaired schema/receipt path but exhausted revision 0 after one
  remaining invalid edge. No authority was widened and no artifact validated. Started unchanged v33
  as the bounded replay; its TUI replaced v32 as the selected Research run.
- 10:40 — Coding v28 validated an eight-node revision-0 checkpoint after Haiku used the normalized
  diagnostics, survived provider-pressure compaction, and corrected two rounds of genuine graph/path
  diagnostics. Audit found a bounded additive owner, explicit URL contract, focused proofs, and
  exact immutable hashes; approved that checkpoint.
- 10:43 — Research v33 validated an eight-node revision-0 checkpoint on the unchanged objective.
  Audit confirmed one bounded read-only asset, frozen authenticated inputs, typed preflight,
  one-time empirical observation, independent review, explicit no-training/no-holdout limits, and a
  fail-closed inconclusive branch; approved the exact checkpoint.
- 10:44 — Research Haiku Lead explicitly released both initial preparation tickets (asset
  implementation and experiment design) concurrently. The previously observed false block over
  absent downstream execution did not recur; compiler dependencies remain the progressive-closure
  authority.
- 11:05 — Research v33 demonstrated nine successful repository implementations followed by nine
  unnecessary planned-asset repair routes. The repeated fresh epochs retired each prior worktree,
  then a final dynamic-scope proposal surfaced the internally solvable handoff as an operator
  blocker.
- 11:18 — Coding v28 reached the intended edge-only architecture delta, proving the earlier provider
  path was repaired. Core then threw while hashing optional in-memory ticket fields. `eda1f56` now
  hashes the exact durable ticket-board projection; focused authority tests, full 129/129 authority
  coverage, typecheck, lint, formatting, and diff integrity pass.
- 11:28 — Added the same-workflow publication boundary in `5970589` using test-first Core prompt
  derivation and shared profile-authoring guidance. Focused RED→GREEN contracts pass; full affected
  tests pass 96/96 with typecheck, lint, formatting, and diff integrity.
- 11:31 — Installed exact Core `5970589`, restarted both authorities, refreshed both left-panel TUI
  tabs, resumed Coding v29, and started unchanged Research v34.
- 11:43 — Research v34 reached execution without the prior asset-publication loop, then exposed a
  distinct gate-modeling ambiguity: Luna requested an external capability node even though the
  authorized new gate could carry the complete embedded expected-red interface. Retained the
  proposal as RED evidence.
- 11:45 — Added the gate-local capability policy test-first in `f374d00` and released Research
  1.1.32. Research passes 29/29, bundle checks 11/11, authenticated package/upgrade checks 36/36,
  plus typecheck, lint, formatting, and diff integrity. The historical prior-release fixture suite
  still has its two pre-existing schema-range failures.
- 11:47 — Installed exact Core/profile build `f374d00`, updated MUAT to Research 1.1.32 while
  preserving the Luna/medium project overlay, replaced the Research left-panel TUI, and started
  unchanged v35.
- 11:51 — Research v35 validated a bounded seven-node revision-0 checkpoint. Audit confirmed an
  embedded gate-local capability contract, exact-path prerequisite instead of guessed repository
  authority, no training/holdout access, progressive closure, one empirical observation, independent
  review, and bounded reporting.
- 11:57 — Approved the exact v35 checkpoint. Lead released the initial frontier and the reusable
  audit asset entered execution while unresolved artifact identity remained downstream in the
  prerequisite/gate.
- 12:08 — Added repeated provider-pressure compaction recovery test-first in `54af8d3`. The
  regression reproduces two pressure compactions, proves the second oversized tool batch is
  discarded only at the exact durable Koni error, verifies conservative mismatch fallback and cold
  recovery, and preserves full Codex output reservation. Affected tests pass 79/79; full Core tests,
  typecheck, build, lint, formatting, and diff integrity pass; independent review is READY.
- 12:12 — Installed exact Core `54af8d3`, restarted both project authorities, replaced both
  left-panel TUI processes on the new build, retained Coding v29 as RED evidence, and started
  unchanged Coding v30 from the clean smoke base.
- 12:18 — Coding v30 proved the repeated-pressure compaction fix by reaching three compiler-directed
  submissions after the oversized turn was discarded. It then exhausted the bounded 120K revision
  allowance with two typed graph diagnostics remaining; retained it as a non-converged RED rather
  than widening its budget.
- 12:25 — Research v35 reached a genuine operator proposal after compile-run-plan raced unresolved
  prerequisite closure and found no distinct post-result verifier in the planned asset. Retained the
  exact proposal as RED evidence without approval.
- 12:27 — Added the prerequisite and verifier policy test-first in `084a900` and released Research
  1.1.33. Research passes 30/30, authenticated package/upgrade checks 36/36, bundles 11/11, new
  domain regression, both typechecks, lint, formatting, and diff integrity; independent review is
  READY. The three known schema-invalid legacy asset fixtures remain pre-existing.
- 12:30 — Installed exact Core/profile build `084a900`, updated MUAT to Research 1.1.33 while
  preserving the all-Luna/medium overlay, restored both left-panel TUI tabs on the new installation,
  and started unchanged Research v36.

## Invariant audit (rolling)

- [x] Fresh isolated target branches were provisioned from the dedicated smoke checkouts.
- [x] Current v36/v30 run records authenticate Luna `medium` for every persona; historical
      mixed-provider RED checkpoints remain recorded separately.
- [x] No silent substitutions occurred at creation.
- [x] Left-panel cmux TUI tabs show both authorities and active runs.
- [x] Both plans validate and bind exact approval checkpoints.
- [ ] Both runs exercise compiled tickets, reviews, validation, recovery, and terminal handling.
- [ ] Both runs reach the final non-destructive promotion boundary, or a safely irreparable
      evidenced blocker.
- [ ] Focused tests, repository checks, release coherence, and final worktree audit pass.
