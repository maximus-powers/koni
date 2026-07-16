# Software Presets and Prompts

Owner: `/root/software_presets_prompts`

Status: `complete` (assigned files released to `software-default-design/root`)

Last checked: 2026-07-14 (Phoenix)

## Exact lease

This lane implemented and then released only:

- `crates/koni-cli/templates/software/project.yaml`
- `crates/koni-cli/templates/software/run-types/{small,medium,large,new-feature,bug-fix}.yaml`
- `crates/koni-cli/templates/software/personas.yaml`
- `crates/koni-cli/templates/codex/software/agents/*.toml`

It did not edit the Software graph, rules, operations, workflows, checks, cockpit, reports, Rust
tests/source, Research, fixtures, product documentation, the installed binary, cockpit, Updog, or
live/forensic run state. The shared worktree was preserved without reset or global formatting.

## Released decisions

- The Software catalog exposes five run types. `new-feature` and `bug-fix` extend `medium` and
  alter inherited behavior only through ordered JSON-Pointer overrides.
- Both intent presets inherit Medium's final `combined-plan` graph-seed stage. New Feature centers
  observable acceptance, an existing journey, a walking skeleton when cross-boundary, and the
  fewest thin vertical slices. Bug Fix requires expected and observed behavior, accepts an optional
  reproduction signal, seeds causal defect state honestly, and serializes implementation with
  `max_parallel: 1`.
- Small uses `high_impact_only` and permits at most one acceptance-blocking question in its planner
  contract. Large has no target or minimum question count; its staged passes share one ledger and
  only ask repository-unanswerable, decision-bearing questions.
- Every planner emits the smallest sufficient nonempty root-connected semantic seed, classifies
  `objective.work_kind`, uses repository-native boundaries, and excludes status, receipts,
  tickets, transient notes, progress, and compiler-owned fields.
- Architecture, contract, change, and risk specialists are filesystem read-only direct bounded
  graph producers. Their former producer-to-Integrator transcription hop is not the Software 0.4
  contract. Reviewer and Verifier are read-only and explicitly forbidden from repairing product,
  tests, commands, or graph state.
- Change design covers conditional defect diagnosis as well as vertical change planning. It must
  preserve expected/observed/reproduction evidence, stop before an unsupported root-cause claim,
  use focused/boundary proof proportionally, and never create residual-risk acceptance authority.
- Implementer uses compiler-issued context before repository instructions, preserves honest
  red-green/characterization/current-verification causality, and fixes the causal defect boundary.
  Reviewer prioritizes correctness and actionable evidence without taste-driven perfectionism,
  rejects fake proof independence and unapproved risk acceptance, and blocks when critical domain
  qualification is unavailable. Integrator is reserved for exact delivery assembly or real target
  conflict.

## Validation and release evidence

- Ruby Psych parsed every assigned YAML file.
- Python `tomllib` parsed all ten assigned native agent TOMLs.
- Path-scoped `git diff --check` passed.
- An isolated temporary custom install used the five Software catalog/run-type files over a known-
  valid bundled profile. `ProjectCatalogCompiler` accepted all five entries and both ordered
  Medium-derived presets, proving their inheritance/override shape without touching a live project.
- A direct bundled Software install was not claimed because the concurrently active generic
  graph-set/profile implementation was at a mid-edit validation boundary. Final integrated profile,
  CLI, and runtime verification belongs to `software-default-design/root`.
- The exact lease was explicitly released to the parent integration lane. The two new run-type
  files remain ordinary shared-tree additions until the integration owner commits the complete
  Software 0.4 change.

## 2026-07-14 full coordination sweep

Read `docs/AGENT_COLLAB.md` and every currently present `docs/agent-collab/*.md` file in full after
release. The following findings specifically affect Software 0.4 or generic graph-set convergence:

1. **Open generic compatibility defect:** `graph_sets_preserve_compatible` currently compares the
   selector, member types, source-path field, working-directory field, status filters, and
   cardinality, but not `covered_paths_field`. This exactly matches the unresolved finding at the
   end of `compiler-graph-tdd.md`. Config-time preservation can therefore accept parents that read
   covered paths from different schema fields even though runtime concrete-path equality is meant
   to be strict. The generic compiler owner retains this source range.
2. **Generic implementation is still an integration gate:** the central ledger correctly marks
   `compiler-graph-tdd/root` in progress, and current mailboxes record incomplete graph-set
   `Step`/execution/predicate integration as the reason unrelated profile/TUI checks may stop before
   their own code. Software profile tests must not claim a result until that core lane publishes a
   compilable release and the focused-to-full matrix reruns.
3. **Compiler mailbox status wording conflicts internally:** its header still says “core
   implementation pending,” while its later handoff and the central ledger say implementation is
   active after Software acknowledgement. The active central row is authoritative, but the header
   should be transitioned rather than left ambiguous at handoff.
4. **Required specialist mailboxes are absent:** the compiler mailbox requires separate
   `config-state-expr-impl.md` and `verification-impl.md` handoffs, and the Software mailbox requires
   `software-profile-yaml.md` and `software-profile-regressions.md`. None was present in the swept
   inventory even though the corresponding implementation lanes are active. This mailbox closes
   the same requirement for the presets/prompts lane but does not substitute for theirs.
5. **Two historical Software prompt/test findings are already closed in live source:** Implementer
   now reads compiler-issued context first, and the Small question-policy regression derives its
   expected diagnostic from the pinned policy rather than hard-coding `autonomous`. They should not
   be reopened from older mailbox paragraphs.
6. **No current file overlap remains for this lane:** the preset/prompt lease is released. Active
   Software schema/rule/regression work and generic graph-set core work remain disjoint as recorded;
   Research and Updog compatibility paths remain outside Software 0.4.

No additional unresolved question or status conflict affecting the Software 0.4 / generic
graph-set boundary was found in the remaining mailboxes. Historical red checkpoints remain useful
causal evidence but are superseded by their adjacent dated resolutions where present.

## 2026-07-14 parent-owned causal-preset and prompt transition

The released specialist checkpoint above remains accurate for its original bytes. After the defect
schema evolved to compiler-owned `unresolved|diagnosed|superseded`, the parent integration lane
made the following later corrections in its own lease:

- Bug Fix no longer names the removed `localization_status` field or commands a speculative repair
  before diagnosis. An unresolved seed includes expected/observed/reproduction evidence plus
  exactly one focused diagnostic proof and no addressing change; a complete evidenced causal triad
  is the only path that may seed the smallest addressing change immediately.
- Planner and specialist prompts now use exact sole-authority vocabulary: production
  `change|migration.owned_paths`; proof `baseline_check_id`, argv `command`, `source_paths`,
  read-only `covered_paths`, working directory, conditions, expected signal, `why`, and
  `not_proven`. They do not name retired baseline/test/readback fields.
- Implementer distinguishes conditional diagnostic/boundary source preparation from ordinary
  focused implementation. Routine implementation consumes the compiler baseline, makes the
  cohesive production edit, and lets the compiler run the promotion set before independent review;
  it does not add a second Verifier model hop.
- Integrator exact-covers active diagnosed/addressed/proved defects under any work kind and current
  risk-boundary evidence for both accepted and mitigated risks. Reviewer distinguishes
  preparation-time oracle review from cross-ticket source-currentness and does not invent qualified
  human review authority.

The raw catalog assertion and resolved installed-catalog assertion now require the Bug Fix prompt's
diagnostic proof, no-speculative-change wording, and absence of `localization_status`. Current
focused catalog and staged bundled-install checks pass 1/1 each. These later bytes are owned by
`software-default-design/root`, not retroactively attributed to the released specialist.
