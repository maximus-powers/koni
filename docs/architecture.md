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

The catalog compiler resolves explicit inheritance for compatibility and expert
authoring, validates every reference, and produces one standalone run behavior.
Inheritance does not survive into runtime.

Native Codex resources participate in the same hash:

- `.codex/config.toml`
- referenced `.codex/agents/*.toml`
- referenced `.agents/skills/*` bundles

See [Configuration](configuration.md) and [Codex resources](codex-resources.md).

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
