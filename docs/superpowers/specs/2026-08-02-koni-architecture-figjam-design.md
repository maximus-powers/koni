# Koni Architecture FigJam Design

## Goal

Create one editable FigJam architecture map that supports two reading depths:

- a fast onboarding path that explains how a goal becomes verified, integrated work; and
- a contributor-level map of the major Koni domains, their ownership boundaries, and their
  interactions.

The diagram describes the current `pi-native-port` working tree. It is explanatory documentation,
not a proposal to change runtime behavior.

## Source of truth

The content is derived from the current `pi-native-port` branch, including its current uncommitted
working-tree changes, with emphasis on:

- `README.md` and the architecture, configuration, runtime, Git, profile lifecycle, and
  control-center documentation;
- `packages/core/src/compiler`, `graph`, `state`, `authority`, `pi`, `git`, `profile`,
  `control-center`, `monitor`, and `operator`; and
- the coding and research profile packages under `packages/`.

The destination is the empty FigJam board with file key `VlRK6W4eUatMc7ThV4wUat`.

## Visual structure

Use one large section titled **Koni architecture — from goal to verified integration**. The section
contains a left-to-right lifecycle spine, detailed domain clusters above and below it, and three
cross-cutting authority rails.

### Lifecycle spine

The onboarding path is the strongest visual sequence:

1. Goal and selected run type
2. Resolve and compile project configuration
3. Seed and validate the typed semantic graph
4. Evaluate selectors, predicates, and obligations
5. Derive deterministic tickets and workflow step DAGs
6. Schedule eligible, non-conflicting work
7. Launch one contained Pi session per immutable attempt
8. Run checks, review, and bounded rework
9. Integrate accepted work and publish receipts, reports, and durable state

Each lifecycle node contains a one-sentence purpose statement. Primary arrows are solid and labeled
only where the transition would otherwise be ambiguous.

### Domain clusters

The detailed reading layer uses nine visually distinct clusters:

1. **Configuration and profiles** — project catalog, run types, graph schema, rules, operations,
   workflows, personas, actions, checks, reports, and profile overlays.
2. **Compiler** — resolution, fail-closed validation, typed intermediate state, hashing,
   deterministic identity, rule evaluation, and execution semantics.
3. **Semantic graph** — typed nodes, canonical edges, state machines, graph deltas, working-spec
   records, and advisory graph notes.
4. **Tickets and scheduling** — deterministic tickets, dependencies, step DAGs, leases, scope
   conflicts, single-flight constraints, parallelism, and change-control barriers.
5. **Context and authority** — context packs, mandatory graph anchors, dynamic graph expansion,
   advisory notes, grants, budgets, structured outputs, and compare-and-swap admission.
6. **Agents and Pi** — planner, Lead, ticket worker, reviewer, provider/model selection, immutable
   attempt lineage, tools, transcripts, and compaction.
7. **Checks, receipts, and recovery** — command and graph checks, review receipts, bounded rework,
   blockers, journals, exact replay, and crash-forward recovery.
8. **Git and durable state** — planning, integration, and ticket worktrees; run and ticket branches;
   squash integration; `.git/koni`; pinned configuration; and reports.
9. **Operator surfaces** — CLI, `/koni`, the TUI/control center, monitoring, questions, approval,
   pause/resume, recovery, and promotion.

Clusters show conceptual ownership, not a literal one-to-one directory dependency graph. Small
monospace path labels identify the most relevant `packages/core/src/*` domain where useful.

### Cross-cutting rails

Three horizontal rails run across the detailed layer:

- **Compiler-owned authority:** agents propose; Core validates, grants, admits, mutates, and
  publishes.
- **Pinned and hash-bound identity:** configuration, graph epochs, ticket projections, context,
  grants, attempts, outputs, and receipts are tied to exact identities.
- **Explicit failure and recovery:** ambiguity, drift, conflicts, failed checks, and crashes do not
  silently advance lifecycle state.

## Relationship vocabulary

- Solid dark arrows: primary lifecycle progression.
- Dashed blue arrows: context or read-only feedback.
- Purple arrows: compiler-issued authority or grants.
- Green arrows: accepted evidence and publication.
- Red arrows: failure, rework, blocker, or recovery routes.
- Storage/database shapes: durable sidecar state or Git-owned records.
- Human shapes or decision nodes: operator approval and questions.

Avoid crossing connectors when a nearby relay label or domain boundary can express the relationship
more clearly. Connector labels use verbs such as `compiles`, `derives`, `grants`, `runs`, `records`,
`reviews`, `integrates`, and `observes`.

## Failure and recovery paths

The diagram explicitly shows these bounded loops:

- failed review returns once to the compiler-selected producer step, then blocks if the bounded
  allowance is exhausted;
- failed validation cannot produce a passing receipt or close a ticket;
- configuration or hash drift blocks opening or approving a pinned run;
- dirty, foreign, moved, or ambiguous Git ownership fails closed;
- process interruption is reconciled from journals and durable attempt state; and
- human questions pause only according to the compiled question policy.

These are secondary paths, visually quieter than the happy path but still readable without zooming
into individual source files.

## Visual style

Use a restrained technical palette with one color family per responsibility boundary:

- warm yellow for project-owned profiles and semantics;
- blue for deterministic Core/compiler behavior;
- violet for Pi agents and model execution;
- green for checks, receipts, and accepted publication;
- gray for Git, durable storage, and infrastructure; and
- coral/red only for failure and recovery paths.

Use rounded rectangles for domains, smaller cards for concepts, and consistent spacing. Keep text
short enough to scan. A legend and a two-sentence `How to read this map` note sit at the upper left.

## Build and verification

Build the board incrementally: create the section and lifecycle skeleton, populate domain clusters,
add cross-cutting rails, then add secondary feedback and recovery connectors. Return every created
or modified node ID from each Figma write operation.

After each major stage, inspect the FigJam node tree and render a screenshot. Final verification
checks that:

- the lifecycle spine can be understood without reading the domain detail;
- every requested domain appears exactly once as a primary cluster;
- ownership boundaries distinguish profiles, Core, Pi, Git/state, and the operator;
- no connector or label is clipped, hidden, or misleading;
- the happy path remains visually dominant over recovery loops; and
- the completed artifact is editable and contained within one named FigJam section.
