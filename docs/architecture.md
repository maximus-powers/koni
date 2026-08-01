# Architecture

Köni separates a reusable control plane, a deterministic execution kernel, and a project-owned
semantic plane. The engine understands graphs, rules, tickets, workflows, receipts, and Git
transactions. Profiles supply the domain.

## System overview

```text
ordinary Pi installation
├── @koni/core              TypeScript compiler, authority, sessions, effects, and control center
├── @koni/coding-profile    passive immutable coding baseline
└── @koni/research-profile  passive immutable research baseline
             │
             ▼
project .koni overlay ──► one authority per Git common directory
                          ├── graph + rule compiler
                          ├── tickets + deterministic scheduler
                          ├── grants + receipts + recovery
                          ├── worktrees + Git integration
                          └── questions + approval + lifecycle
                                      │
                                      ▼
                           one contained Pi AgentSession
                           per immutable Koni attempt
```

TypeScript Core is the sole authority for configuration, graph mutations, scheduling, durable state,
tool effects, verification, and Git. `@koni/core` contains the graph and configuration compiler, the
deterministic scheduler, grants, receipts, project authority, Git transactions, the contained
`AgentSession` runner, and the shared control center.

Pi `0.80.10` supplies provider credentials, model execution, session JSONL, compaction primitives,
and ordinary interactive resources. The tested host pair is TypeBox `1.1.38` on Node `>=22.19`. Koni
does not copy or rewrite Pi credentials or unrelated settings.

Building on Pi rather than on one vendor's coding CLI is what makes Koni provider-neutral: every
provider Pi can reach is selectable per role, and the engine holds no vendor default. Provider
knowledge inside Core is limited to transport adaptation that a Pi API shape requires — for example
an API that publishes no wire-level output cap must reserve its authenticated catalog maximum
instead. See [Providers and models](configuration.md#providers-and-models).

The package boundary is deliberately coarse. Koni ships one broad `@koni/core` package plus broad
domain packages such as `@koni/coding-profile` and `@koni/research-profile`. Runtime adapters and
run types are internal domains, not separate micro-packages. Profile registrars are passive
discovery surfaces, and the two profile packages contribute immutable passive baselines. See
[Pi-native profile lifecycle](profile-lifecycle.md).

An autonomous attempt receives only compiler-selected, content-hashed resources and least-privilege
grants implemented by TypeScript Core. Its Pi session is immutable and linear. Retry, rework,
review, recovery, and integration are new Koni-authorized attempts with explicit parent attempt and
session lineage. They are not in-session branch switching. Provider admission allows one transport
with zero automatic provider retries. An ambiguous response stays durably reserved instead of
causing another hidden request.

## Operator surfaces

Both `/koni` and explicitly invoked `koni tui [--root <path>]` use the same authority protocol and
component model. The extension is inert until a Koni command. Multiple Core origins warn and disable
only Koni, so ordinary Pi stays available. Profile-upgrade conflicts expose current and upstream
documents before an operator resolves them.

A second, deliberately smaller surface lives beside ordinary Pi chat. `/koni-run` opens complete
guided intake. A passive read-only widget and the `/koni-runs` overlay observe background runs and
surface only actionable decisions. Inert continues to forbid passive work and provider activity. It
does not mean an initialized trusted project has no passive status presentation.

## Configuration resolution

The canonical entry point is `.koni/project.yaml`. It catalogs complete run-type peers and one
default. Every run type selects the same project profile, but it owns its intake, planning pipeline,
question behavior, role overrides, Git namespaces, and orchestration limit.

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

Research catalogs Small, Medium, and Large as complexity envelopes. Coding catalogs five resolved
run types and defaults to Medium. Its `new-feature` and `bug-fix` types inherit Medium through
compile-time overrides, while Small, Medium, and Large stay standalone complexity envelopes. Because
a run selects one complete type, materially large feature or defect work selects Large and preserves
its intent in `objective.spec.work_kind`. The intent presets are not stackable modifiers. See
[Software Profile Engineering](software-profile-engineering.md).

Interactive `koni init` asks the operator to choose Coding or Research before copying either
profile. Non-interactive initialization requires an explicit bundled profile or custom source.
Existing-installation protection runs before any prompt or write.

The catalog compiler resolves explicit inheritance for compatibility and expert authoring, validates
every reference, and produces one standalone run behavior. Inheritance does not survive into
runtime.

Provider-neutral agent resources under `.koni/agents` and repository skills under `.agents/skills`
participate in the same hash. See [Configuration](configuration.md).

## Compilation into typed state

Profile compilation is fail-closed:

1. Locate the catalog and profile root.
2. Parse the YAML modules and bound agent resources.
3. Reject contained-path escapes, duplicate IDs, unknown references, invalid selectors, cycles, and
   unsafe action-effect ordering.
4. Normalize the configuration into a typed intermediate representation.
5. Hash the normalized semantic profile and every bound resource.

Runtime code evaluates typed selectors and predicates. Project configuration does not embed
arbitrary shell or Python expressions. Commands are structured argv recipes with declared inputs,
effects, timeout, working-directory policy, result protocol, and receipt behavior.

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

Planning pins two identities: the operator-selected target ref, and that ref's observed base commit.
It pins both before creating the detached planning worktree. Approval verifies both identities
before creating the permanent run namespace. Later target sync and explicit promotion therefore
retain destination intent as well as source history.

Before approval, no permanent run ref exists. Opening a pinned run later recompiles its captured
files and rejects hash drift. It never silently uses the project's current configuration.

## Graph compilation

The semantic graph stores typed nodes, typed edges, and node state. Rules bind selectors to
predicates and effects:

```text
selector → candidate targets → predicate → unmet obligation
                                               │
                                               ▼
                                  deterministic ticket constructor
```

Ticket identity is derived from the rule, target, operation, and relevant semantic inputs.
Recompiling the same gap reconciles the existing ticket instead of multiplying work. Once an
accepted transition satisfies the rule, the compiler retires or closes the corresponding obligation
according to the profile.

Reconciliation also covers a later gap that legitimately reopens after its prior deterministic
ticket was integrated. Terminal outputs, reviews, and blockers are archived in `prior_cycles`. The
new cycle preserves the ticket ID and starts without a lease. Before that publication, the kernel
proves and retires any retained completed-cycle Git or command authority through the exact durable
integration transaction. Absent, dirty, foreign, active, ambiguous, or unintegrated authority fails
closed. This is namespace lifecycle reconciliation, not a profile-specific ticket-ID exception. See
the deterministic reopen transition in [Runtime, state, and Git](runtime-and-git.md).

A later preparation-specific or successor-specific rerun remains a separate integration gate.
Deterministic ID recurrence and `prior_cycles` never authorize semantic successor state.

Preparation lineage uses the current ticket's live last review as its base or successor authority,
never `prior_cycles`. Preparation lookup first selects the newest attempt by operation registry ID
and compiled source node, so deterministic ID reuse cannot revive an older favorable review. Durable
successors replay in strict `(reviewed_at, ticket_id, review_id)` order with an older-than-current
replay cutoff. The exact in-memory application may act as one prospective next link only at its own
review boundary. Git-common active effects are visible only while materializing that same ticket,
and they become globally visible after terminal publication.

The compiler loop authenticates this evidence once per immutable epoch and gives the same typed
slice to rule evaluation and source-write admission. That epoch has two layers. Graph-dependent
preparation truth is reused only for a byte-for-byte normalized graph identity. Sequential
derivations that change even a semantic-hash-excluded projection create another graph epoch, because
profile selectors are allowed to observe that projection. The underlying immutable ticket and
receipt evidence is loaded and indexed once for all derivation graph epochs. The index key is the
exact state root plus the ticket and receipt directories. Reconciliation closes that source epoch
before emission receives a fresh typed slice. This preserves generic selector semantics while
bounding filesystem work, and the same reentrant index scopes nested historical replay without
weakening its cutoff or successor authentication.

The engine is unaware that a node represents a package, claim, risk, or experiment. That vocabulary
is entirely profile-owned, and profile ownership includes executable ontology and identity rather
than raw retained YAML. `GraphSchema` exposes authored node annotations to bounded agent context and
projects `semantic_fields`. It subtracts compiler-owned paths before hashing and checks
gate-required type consistency. It evaluates the shipped finite edge predicate before accepting a
concrete canonical edge. Rule compilation derives missing and unsatisfied gate obligations from the
authored templates and receipt-status set. It publishes the exact selected node and path context
under a policy-contract hash.

Lifecycle modules compile into an immutable finite transition catalog with guards rejected and
actors resolved. The catalog rejects dead declared states, so every state must be reachable from the
configured initial state through finite transitions. Coding and Research both ship `ticket` and
`run` machines with explicit proposal and compiler-failure paths. Research's additional `gate` and
`research` machines stay compiler-owned graph lifecycles. The runtime integration projects its
existing durable values through this catalog and does not add another mutable lifecycle field. Pi
ticket and run mutation remains a named integration boundary, because its native status vocabulary
must be mapped explicitly rather than assumed.

## Workflows, actions, and checks

A ticket selects an operation, and an operation selects a workflow. Workflow steps form a validated
directed acyclic graph. A step may call a persona, perform a compiler-owned action, wait at a manual
boundary, or require structured outputs.

Actions are deterministic recipes composed from registered primitives. The compiler validates their
declared effects and safety order. For example, candidate work must be created before it is checked,
and integration cannot precede review. Profiles may add recipes without adding another engine.

Checks have explicit handlers and produce receipts. Native command checks run argv-only commands
under containment and timeout policy. Graph checks evaluate semantic state. Agent and manual checks
require an explicit handler or external receipt. They never pass because their declaration merely
exists.

## Durable control records

Run-local state includes:

- a manifest binding base commit and configuration hashes
- the pipeline and its hash-bound stage records
- planning transcripts and structured decisions
- orchestration and external-loop state
- ticket, step, lease, output, review, event, and action journals
- command, graph, checkpoint, and integration receipts

Project authority uses exact raw run-byte anchors and a state-last crash-forward journal. Artifacts
publish before run records, and the state anchor publishes last. Operations that span multiple
records use journals and recovery markers, so a restart can reconcile known intermediate states or
stop with a precise diagnostic.

Strict-v2 anchored reads keep archive history cold. Pre-anchor and genuine-v1 histories are fully
authenticated with disk-backed exact identity tracking before an anchor is installed. Run, state,
transaction, and journal envelopes are 64 MiB, 32 MiB, 96 MiB, and 32 MiB respectively.
Compatibility overflows fail with named, non-mutating diagnostics rather than pruning immutable
settlement authority.

A prepared journal publishes only after its staged directory entries are durable. Recovery discards
a safe real no-journal prefix, while an exact descriptor-verified stage-to-destination temporary
handoff can finish publication after restart. Journaled, symlinked, malformed, and hash-mismatched
or preimage-mismatched prefixes fail closed.

## Process authority

Agents and commands receive a contained working directory, explicit environment policy, timeout, and
declared permissions. Model processes do not own run IDs, control metadata, Git publication, or
success status.

Köni injects a narrow runtime broker for bounded agent capabilities. The `koni_runtime` MCP server
name is reserved, so project configuration cannot shadow that authority boundary. Agent output is
accepted only through the configured structured boundary.

## Concurrency boundaries

Approved runs occupy independent branch and worktree namespaces. Ticket workers are also constrained
by ticket scope, graph target, dependency state, single-flight groups, and the run's maximum
parallelism.

Project-wide operations use a shared Git-common-dir lock. Run-local control locks serialize
transitions for one run without pausing unrelated runs. Integration composes Git trees in memory,
reports conflicts without mutating the integration checkout, and publishes one squash commit after
semantic and repository checks succeed.

## Community resources

Optional community packages do not create another runtime authority. Core may inspect Pi's
already-resolved package metadata without mutation, but it copies only exact compiler-selected text
resources into immutable run state. Contained sessions receive those copied bytes through the normal
launch-resource hash and sealed loader. Executable package extensions stay outside autonomous
sessions. An `explicit_tools` binding can select only a Koni-owned authority adapter, with network
effects restricted to an already-granted configured check. A Pi package itself never gains compiler,
filesystem, network, Git, or scheduling authority.

For paths, branches, recovery, and storage modes, continue with
[Runtime, state, and Git](runtime-and-git.md).
