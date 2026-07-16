# Architecture

Köni separates a reusable control plane, a deterministic execution kernel, and
a project-owned semantic plane. The engine understands graphs, rules, tickets,
workflows, receipts, and Git transactions; profiles supply the domain.

## System overview

```text
                          project-owned
┌─────────────────────────────────────────────────────────────────┐
│ .codex/koni     .codex/agents     .agents/skills   config.toml  │
└────────┬───────────────┬────────────────┬──────────────┬─────────┘
         └───────────────┴───────┬────────┴──────────────┘
                                 ▼
                       catalog + profile compiler
                                 │
                       typed, hashed configuration
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│ control plane                                                   │
│ run registry · planning · questions · pipeline · TUI · reports │
└───────────────────────────────┬─────────────────────────────────┘
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│ execution kernel                                                │
│ graph · rules · tickets · actions · process · receipts · Git   │
└─────────────────────────────────────────────────────────────────┘
```

> **Pi/schema 2 transition in progress — 2026-07-14 (`pi_product_docs_transition`):** The
> project-owned paths in this diagram remain the executable schema-1/Codex layout before cutover
> and the basis for reading pinned historical runs. The unreleased schema-2 target moves live Köni
> configuration and provider-neutral agent definitions to `.koni/`, keeps repository skills in
> `.agents/skills/`, and uses the direct Pi host described in [Direct Pi runtime](pi-runtime.md).
> A migrated project will execute only Pi, with no Codex fallback. Publication is still blocked on
> the schema-1-to-2 migration/security matrix, compiler-issued active-run archival evidence,
> historical-reader compatibility, and one frozen host/Rust/CLI/TUI/profile fingerprint.

> **Release-candidate supersession — 2026-07-14 (`pi_product_docs_transition`):** The preceding
> unreleased/blocked status is historical. Current source is the schema-2/direct-Pi release
> candidate for the supported macOS Seatbelt target, with no production Codex fallback. Its exact
> first-cut credential TCB is the Köni Rust binary, bundled Pi host, pinned Pi SDK 0.80.7 dependency
> closure, and official pinned Node 22.19.0 runtime; Node still has no compiler-tool, graph, Git,
> receipt, or project-filesystem authority. Linux networked login and inference fail closed pending
> a destination-allowlisted egress broker. Installation and live migration remain separate guarded
> operator actions, and protected forensic Updog state authorizes neither.

The three workspace crates follow that split:

- `koni-core` compiles configuration and owns durable graph, run, process,
  and Git behavior.
- `koni-cli` exposes automation commands, installation, and the `koni`
  executable.
- `koni-tui` projects core state into the Operate and Configure interfaces.

The TUI and CLI are clients of the same core APIs. A UI action cannot bypass a
compiler or runtime invariant.

## Configuration resolution

The canonical entry point is `.codex/koni/project.yaml`. It catalogs complete
run-type peers and one default. Every run type selects the same project profile
but owns its intake, planning pipeline, question behavior, role overrides, Git
namespaces, and orchestration limit.

```text
project catalog
  ├── Small ─┐
  ├── Medium ├── one selected run type
  ├── Large ─┘           │
  └── profile ◄──────────┘
          │
          ├── graph schema and edge policy
          ├── selectors and rules
          ├── ticket constructors and operations
          ├── workflows and personas
          ├── actions, checks, and gate policies
          └── reports and cockpit views
```

> **Evolving to — Software default 0.4.0 (2026-07-14):** The diagram above records the original
> complexity-only catalog and remains accurate for Research. The next Software baseline retains
> Small, Medium, and Large as complexity envelopes and adds New Feature and Bug Fix as intent-aware
> peers derived from Medium. Because a run still selects one complete type, materially large
> feature or defect work selects Large and preserves its intent in `objective.spec.work_kind`; the
> intent presets are not stackable modifiers. See [Software Profile Engineering](software-profile-engineering.md).

> **Software catalog implemented — 2026-07-14:** “Next” above is retained as the design-time
> transition. Fresh Software initialization now catalogs all five resolved run types and defaults
> to Medium; `new-feature` and `bug-fix` inherit Medium through compile-time overrides, while Small,
> Medium, and Large remain standalone complexity envelopes. Fresh interactive `koni init` asks the
> operator to choose Software or Research before copying either profile. Non-interactive fresh
> initialization requires an explicit bundled profile or custom source, and existing installation
> protection still runs before any prompt or write.

The catalog compiler resolves explicit inheritance for compatibility and expert
authoring, validates every reference, and produces one standalone run behavior.
Inheritance does not survive into runtime.

Native Codex resources participate in the same hash:

- `.codex/config.toml`
- referenced `.codex/agents/*.toml`
- referenced `.agents/skills/*` bundles

See [Configuration](configuration.md) and [Codex resources](codex-resources.md).

> **Pi resource transition in progress — 2026-07-14 (`pi_product_docs_transition`):** Those
> Codex TOML resources and their hashes remain authoritative for schema-1 and already pinned runs.
> Schema 2 converts only manifest-proven, schema-defined owned fields into provider-neutral agents
> during an explicit transaction; unrelated `.codex` files and historical snapshot readers remain
> untouched. The transaction is not released until ancestor-symlink rejection, field-scoped
> conversion, validation/publication race closure, durable multi-rename recovery, and exact run-
> registry archival authority pass the matrix in [Direct Pi runtime](pi-runtime.md).

> **Resource-transition supersession — 2026-07-14 (`pi_product_docs_transition`):** Those
> implementation and matrix holds are now closed in the current release candidate. Fresh schema-2
> projects use `.koni`; an explicitly migrated project permanently archives active Codex-backed
> runs, preserves unrelated `.codex` files and historical readers, and never falls back to Codex.
> That capability does not migrate an installed project without a separate guarded operator action.

## Compilation into typed state

Profile compilation is fail-closed:

1. locate the catalog and profile root;
2. parse YAML modules and native Codex resources;
3. reject contained-path escapes, duplicate IDs, unknown references, invalid
   selectors, cycles, and unsafe action-effect ordering;
4. normalize the configuration into typed intermediate representation;
5. hash the normalized semantic profile and every bound native resource.

Runtime code evaluates typed selectors and predicates. Project configuration
does not embed arbitrary shell or Python expressions. Commands are structured
argv recipes with declared inputs, effects, timeout, working-directory policy,
result protocol, and receipt behavior.

## Plan, approve, execute

The normal multi-run lifecycle separates investigation from publication:

```text
plan
 ├─ resolve base commit
 ├─ resolve and hash run type + profile
 ├─ capture every configuration file
 ├─ create a detached planning worktree
 └─ run the safe planning prefix
               │
               ▼ explicit approval
approve
 ├─ verify the pinned snapshot
 ├─ create the permanent run branch/worktree
 ├─ seed semantic state
 └─ compile the initial ticket board
               │
               ▼ restart-safe supervision
execute
 ├─ reconcile graph gaps and ticket eligibility
 ├─ schedule bounded workers
 ├─ run checks and review
 ├─ squash accepted ticket work
 └─ produce receipts and reports
```

> **Planning identity transition — 2026-07-14:** “Resolve base commit” above preserves the
> original single-identity shorthand. Current planning pins both the operator-selected target ref
> and that ref's observed base commit before the detached planning worktree is created. Approval
> verifies both identities before creating the permanent run namespace, so later target sync and
> explicit promotion retain destination intent as well as source history.

Before approval, no permanent run ref exists. Opening a pinned run later
recompiles its captured files and rejects hash drift rather than silently using
the project's current configuration.

## Graph compilation

The semantic graph stores typed nodes, typed edges, and node state. Rules bind
selectors to predicates and effects:

```text
selector → candidate targets → predicate → unmet obligation
                                               │
                                               ▼
                                  deterministic ticket constructor
```

Ticket identity is derived from the rule, target, operation, and relevant
semantic inputs. Recompiling the same gap reconciles the existing ticket
instead of multiplying work. Once an accepted transition satisfies the rule,
the compiler retires or closes the corresponding obligation according to the
profile.

> **Same-ID terminal reconciliation transition — 2026-07-14:** “Reconciles the existing ticket”
> above also covers a later gap that legitimately reopens after its prior deterministic ticket was
> integrated. Terminal outputs/reviews/blockers are archived in `prior_cycles`, while the new cycle
> preserves the ticket ID and starts without a lease. Before that publication, the kernel now
> proves and retires any retained completed-cycle Git/command authority through the exact durable
> integration transaction; absent, dirty, foreign, active, ambiguous, or unintegrated authority
> fails closed. This is namespace lifecycle reconciliation, not a profile-specific ticket-ID
> exception. See the adjacent deterministic reopen transition in
> [Runtime, state, and Git](runtime-and-git.md).

> **Scoped reconciliation release — 2026-07-14:** The generic retirement contract above is now
> backed by **2/2** exact reopen cases and **4/4** lifecycle-relevant retirement/recovery cases; the
> exact Software stale-delivery consumer also passes **1/1** through namespace reuse. A later
> preparation/successor-specific rerun remains a separate integration gate because deterministic
> ID recurrence and `prior_cycles` never authorize semantic successor state.

> **Preparation lineage reconciliation transition — 2026-07-14 (`compiler-graph-tdd`):** The
> separate gate named above now uses the current ticket's live last review, never `prior_cycles`,
> as its base or successor authority. Preparation lookup first selects the newest attempt by
> operation registry ID and compiled source node; deterministic ID reuse cannot revive an older
> favorable review. Durable successors are replayed in strict `(reviewed_at, ticket_id, review_id)`
> order with an older-than-current replay cutoff, and the exact in-memory application may act as
> one prospective next link only at its own review boundary. Git-common active effects are visible
> only while materializing that same ticket and become globally visible after terminal publication.
> The full compiler loop authenticates this evidence once per immutable epoch and gives the same
> typed slice to rule evaluation and source-write admission. Frozen release evidence remains an
> adjacent integration gate, not authority inferred from namespace reconciliation.

> **Compiler evaluation-epoch refinement — 2026-07-14 (`compiler-graph-tdd`):** “Once per
> immutable epoch” now has two explicit layers. Graph-dependent preparation truth is reused only
> for a byte-for-byte normalized graph identity; sequential derivations that change even a
> semantic-hash-excluded projection create another graph epoch because profile selectors are
> allowed to observe that projection. The underlying immutable ticket/receipt evidence is loaded
> and indexed once for all derivation graph epochs, keyed by the exact state root plus ticket and
> receipt directories. Reconciliation closes that source epoch before emission receives a fresh
> typed slice. This preserves generic selector semantics while bounding filesystem work, and the
> same reentrant index scopes nested historical replay without weakening its cutoff or successor
> authentication.

The engine is unaware that a node represents a package, claim, risk, or
experiment. That vocabulary is entirely profile-owned.

## Workflows, actions, and checks

A ticket selects an operation, and an operation selects a workflow. Workflow
steps form a validated directed acyclic graph. A step may call a persona,
perform a compiler-owned action, wait at a manual boundary, or require
structured outputs.

Actions are deterministic recipes composed from registered primitives. The
compiler validates their declared effects and safety order. For example,
candidate work must be created before it is checked, and integration cannot
precede review. Profiles may add recipes without adding another engine.

Checks have explicit handlers and produce receipts. Native command checks run
argv-only commands under containment and timeout policy. Graph checks evaluate
semantic state. Agent or manual checks require an explicit handler or external
receipt; they never pass because their declaration merely exists.

## Durable control records

Run-local state includes:

- a manifest binding base commit and configuration hashes;
- the pipeline and its hash-bound stage records;
- planning transcripts and structured decisions;
- orchestration and external-loop state;
- ticket, step, lease, output, review, event, and action journals;
- command, graph, checkpoint, and integration receipts.

Individual records publish through atomic replacement. Operations that span
multiple records use journals and recovery markers so a restart can reconcile
known intermediate states or stop with a precise diagnostic.

## Process authority

Agents and commands receive a contained working directory, explicit environment
policy, timeout, and declared permissions. Model processes do not own run IDs,
control metadata, Git publication, or success status.

Köni injects a narrow runtime broker for bounded agent capabilities. The
`koni_runtime` MCP server name is reserved so project configuration cannot
shadow that authority boundary. Agent output is accepted only through the
configured structured boundary.

> **Pi process transition in progress — 2026-07-14 (`pi_product_docs_transition`):** The
> paragraph above describes the current Codex-backed execution boundary and remains valid history.
> The schema-2 target replaces that transport with a Köni-owned Pi SDK host while retaining Rust
> as the only tool, compiler, receipt, and Git authority. Cutover remains blocked on an
> independently pinned/race-free runtime artifact, fail-closed child and callback teardown,
> operation-scoped credential intent, and an unresolved credential-TCB choice between a Rust-owned
> allowlisted TLS/auth proxy and a signed/pinned host-plus-dependency TCB. Exact session/turn/tool
> correlation, token accounting, OAuth secrecy/containment, and the complete frozen verification
> matrix also remain gates. Source-in-progress Pi
> behavior is not an installed capability yet; see [Direct Pi runtime](pi-runtime.md).

> **Process-boundary supersession — 2026-07-14 (`pi_product_docs_transition`):** The credential-TCB
> choice and frozen verification hold above are resolved for the release candidate: the exact Köni
> Rust, bundled host/Pi SDK 0.80.7 closure, and pinned Node 22.19.0 image form the provider credential
> TCB, while Rust alone retains broker, compiler, graph, receipt, Git, and project-file authority.
> The contained networked process is supported on macOS; Linux login/inference remains fail-closed
> pending allowlisted egress. “Release candidate” still does not mean an installed project was
> refreshed or migrated.

## Concurrency boundaries

Approved runs occupy independent branch and worktree namespaces. Ticket workers
are additionally constrained by ticket scope, graph target, dependency state,
single-flight groups, and the run's maximum parallelism.

Project-wide operations use a shared Git-common-dir lock. Run-local control
locks serialize transitions for one run without pausing unrelated runs.
Integration composes Git trees in memory, reports conflicts without mutating
the integration checkout, and publishes one squash commit after semantic and
repository checks succeed.

For paths, branches, recovery, and storage modes, continue with
[Runtime, state, and Git](runtime-and-git.md).
