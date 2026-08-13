# Empirical research

Use the installed Research profile for executable, receipt-backed empirical investigations. Its
terminal product is a bounded conclusion supported by traceable runs, not a plausible narrative. Ask
before adapting it to literature-only synthesis, theorem proving, or work with no executable or
observable evidence path.

## Model the scientific argument

Retain or specialize these semantic roles:

| Type           | Durable meaning                                                                    |
| -------------- | ---------------------------------------------------------------------------------- |
| `hypothesis`   | Falsifiable root question, scope, assumptions, and conclusion policy.              |
| `claim`        | Atomic proposition that evidence can support, contradict, or leave unresolved.     |
| `literature`   | Traceable prior source that informs or challenges the design.                      |
| `experiment`   | Controlled design targeting one or more claims.                                    |
| `method`       | Reproducible procedure or model configuration.                                     |
| `metric`       | Defined measurement with direction, unit, aggregation, uncertainty, and threshold. |
| `ablation`     | Controlled comparison that isolates one factor against a named baseline.           |
| `prerequisite` | Capability, data, access, or dependency required before execution.                 |
| `asset`        | Versioned code, data, model, environment, or implementation artifact.              |
| `gate`         | Predeclared acceptance or safety contract for a subject.                           |
| `run`          | Immutable execution plan plus observed execution identity.                         |
| `evidence`     | Receipt-backed result with provenance and bounded interpretation.                  |
| `report`       | Reviewed synthesis that cites exact evidence and records limitations.              |

Do not create a node for every note. Use a node when identity, lifecycle, dependencies, reuse, or
evidence matters independently.

## Make trust requirements structural

- Decompose the hypothesis into claims narrow enough to test or explicitly leave unresolved.
- Link every material claim to experiments or ablations that target it. Store one canonical
  `target_claims` fact with inverse `tested_by`; do not author both directions.
- Define the primary metric before execution. Record units, population, aggregation, variance or
  uncertainty treatment, comparison direction, threshold, and failure interpretation.
- Give every potentially optional scientific dimension an explicit applicability disposition. For
  ablations, record whether a controlled comparison is required for the declared inference or not
  applicable. Do not fabricate an ablation merely to satisfy a generic workflow slot; a bounded,
  reviewed non-applicability disposition is the durable result for that slot.
- Name a fair baseline and freeze all non-ablated factors. An ablation should identify exactly one
  intended variant, its baseline, target claims, metrics, and required runs.
- Attach gates through one canonical `gate.applies_to` fact with inverse `gates`. Gates may cover
  data integrity, preflight capability, contamination, safety, statistical validity, resource
  limits, or reporting completeness.
- Version assets and bind methods, datasets, seeds, environments, commands, and relevant hashes to
  each run plan.
- Treat an asset implementation plan as one filesystem authority boundary. Normalize
  `implementation_plan.root` as a directory boundary; every planned file must be contained beneath
  it, and every implementation or capability entrypoint must identify one of those planned files.
  Never serialize a file or entrypoint outside that root and rely on a later worker to reconcile it.
- Preserve null, negative, contradictory, and failed results as evidence when their receipts are
  valid. Never rewrite acceptance criteria after observing the result without a new explicit design
  revision.

## Compile gaps in causal order

A robust empirical progression is:

1. formulate and decompose the hypothesis and map relevant literature;
2. create a claim-covering experiment portfolio;
3. define methods, metrics, baselines, ablations, prerequisites, and gates;
4. resolve or build required assets and validate capability;
5. compile immutable run plans and execute gates before experiments;
6. run experiments and ablations with exact receipts;
7. synthesize evidence, independently review its disposition, and compile a report;
8. conclude only when every required claim and run is covered or explicitly unresolved under the
   approved conclusion policy.

Rules should reopen work when a required receipt becomes stale, an asset hash changes, a gate fails,
or claim coverage is incomplete. A report or reviewer cannot manufacture missing run evidence.

## Bind conclusions to receipts

Require evidence to identify the run, method, assets, metric outputs, command or runtime contract,
accepted result, relevant hashes, and review that promoted it. Keep raw observations separate from
interpretation. A claim's status should derive from reviewed evidence coverage and declared policy,
not from an agent-authored confidence sentence.

Use gates for predeclared thresholds and proof checks for receipt integrity, provenance, coverage,
and freshness. Treat a nonpassing process result as evidence only when the configured contract
intentionally accepts and interprets it.

## Synchronize and promote empirical artifacts

The bundled empirical Research profile is Git-enabled and should include target synchronization in
Small, Medium, and Large. Preserve this boundary when customizing a project whose runs change
versioned code, configs, reports, or other repository artifacts. If synchronization conflicts, emit
a dedicated resolution operation whose workflow forbids semantic graph mutation and requires fresh
verification of the composed product tree.

After target synchronization, rerun terminal verification and compile the final report against the
composed head. Seal the run only after those boundaries pass. Promotion to the selected target
branch must remain an explicit operator decision bound to the exact run head and observed target
head; never auto-publish a research conclusion.

## Ask only experiment-changing questions

Ask when repository evidence cannot determine the unit of analysis, target population or dataset,
baseline, primary metric, meaningful threshold, seed/repetition budget, allowed claim strength,
safety limit, compute budget, or publication target. State the inferred default and how the answer
changes the graph or gates. Record lower-impact uncertainty as an assumption or limitation.
