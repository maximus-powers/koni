# Compatibility corpus

This directory defines Köni's normalized behavioral compatibility scenarios.
The fixtures and invariants are maintained as Köni-owned regression contracts;
they do not require an external reference implementation.

Each scenario in `scenarios.yaml` declares lifecycle checkpoints, compared
state surfaces, and invariants. A runner should create an isolated Git project,
exercise the configured scenario, capture each declared surface, normalize it
with `normalization.yaml`, and compare it with the reviewed fixture or snapshot.

The corpus covers structural, semantic, lifecycle, and audit behavior. Dynamic
values such as UUIDs, timestamps, process IDs, absolute paths, and Git object
IDs are normalized; authority boundaries, state transitions, receipt
provenance, and transaction topology are not.

> **Pi-native port transition — 2026-07-16:** The prose scenarios and v1 YAML
> normalizer above remain historical inputs, but they are no longer the release
> gate by themselves. `ledger.json` is the executable index for the frozen
> `rust-oracle-baseline`, typed action scripts, checkpoint captures, assertions,
> and exact known-issue dispositions. The TypeScript endpoint must match every
> ordinary oracle assertion and must satisfy the desired assertion for a
> narrowly registered oracle defect or intentional supersession.

## Executable ledger

Validate all IDs, references, action types, issue scopes, normalization hashes,
and the annotated oracle fingerprint without running a model or touching a
project:

```sh
node scripts/parity-ledger.mjs validate
node --test scripts/parity-ledger.test.mjs
```

Inspect the typed execution plan for the full corpus or one case:

```sh
node scripts/parity-ledger.mjs plan
node scripts/parity-ledger.mjs plan KPAR-LIF-0002
```

Execute the assertion-level TypeScript target gate, or one isolated case:

```sh
node scripts/parity-runner.mjs validate
node scripts/parity-runner.mjs run KPAR-SES-0001
node scripts/parity-runner.mjs gate
npm run parity:gate
node --test scripts/parity-runner.test.mjs
```

`validate` requires every assertion to name exact target evidence and, for an
oracle-authoritative assertion, exact frozen Rust evidence. An unimplemented
composition is represented by a typed blocker with its required surface and
acceptance proof. Development mode may inventory those blockers; release mode
rejects every blocker and every case not marked `passing`.

> **Executable release-gate transition — 2026-07-16:** The ledger is now in
> `release` mode with 24 passing cases, 65 executable assertions, and no typed
> blockers. `parity:gate` does not merely validate the manifest: it reruns the
> complete provider-free mapped corpus and compares every case, assertion,
> oracle identity, normalization record, and isolation record with the reviewed
> `captures/KPAR-ALL.typescript.json` artifact. Root `check`, Pi-native CI, the
> frozen-oracle job, and release validation all invoke this gate. The reviewed
> artifact's file SHA-256 is
> `a207fc6b99a23149f6dfda27a8e85d371c6d14e250fe6056486d894286caa8e7`;
> its internal canonical capture SHA-256 is
> `fa8a2cf061e95c12bd161e8c415e5c7347b5a572e52b0959e4a439d79dfd458d`.

`run` invokes only the mapped provider-free tests in a detached child process.
Its canonical output omits duration, PID, absolute paths, temporary roots, raw
stdout/stderr, and environment-specific Git identities. It preserves relative
test identity, outcomes, assertion contract hashes, oracle identity, and all
safety-relevant failure states. The frozen Rust semantic suite is generated
separately from the annotated tag with:

```sh
node scripts/parity-rust-suite.mjs > semantic-contract-suite.json
```

That command uses a detached oracle worktree and disposable HOME. The reviewed
artifact belongs under `oracle/rust-oracle-baseline/`; generation never updates
the ledger or source tree implicitly.

Case, checkpoint, assertion, action, and issue identifiers are durable API.
Never reuse an identifier for incompatible behavior. Tightening a compatible
contract increments the case revision; replacing it allocates a new case and
records `supersedes`.

`oracle` assertions compare normalized captures to the tagged Rust oracle.
`specification` assertions must declare one of the narrow dispositions in
`case.schema.json`. An `oracle_defect`, `superseded`, `legacy_reader`,
`platform_variant`, or temporary `quarantine` also cites an exact record in
`issues.json`. Release mode rejects every quarantine. An unexpected oracle pass
does not silently pass a known-defect assertion: it makes the classification
stale and requires the issue record and oracle capture to be reviewed.

All capture drivers use disposable Git projects and disposable Pi homes.
Network access is disabled or fixture-only; live projects, credentials,
provider calls, installed binaries, and terminal panes are out of scope.

## Frozen deterministic command capture

`oracle/rust-oracle-baseline/deterministic-command-surfaces.json` is generated
by `scripts/capture-rust-oracle.mjs`. The driver checks out the annotated tag
as a detached worktree, builds that exact source without provisioning a Pi
host beside the disposable binary, and then exercises no-model commands in an
isolated Git project and home. It captures:

- the complete fresh Software install tree (raw file digests, except the
  generated migration receipt's narrowly normalized ID/path fields);
- successful profile compilation and initialized-run validation;
- the empty project run-registry projection; and
- fail-closed pause, play, and cockpit behavior for an unknown run;
- exact provider-free Rust contracts for deterministic ticket compilation and
  durable planning/active pause-play behavior.

The driver deliberately does not call `plan-run`, `approve-run`, supervision,
or any agent command. Positive compiler and pause-play behavior is proved by
exact provider-free Rust integration contracts; positive interactive planning
and CLI lifecycle projections remain in the typed cases until a fixture seam
can execute them without reaching a provider. Do not weaken this boundary
merely to produce a golden file.

> **Detached-planning transition — 2026-07-16:** The original run-creation
> scenario expected an eager permanent run branch/worktree. That topology is
> retained as historical oracle context but superseded narrowly by
> `KBUG-GIT-0001`: planning now owns a detached checkout, and exact approval is
> the first operation allowed to create a permanent Koni run ref/worktree.

Two independent executions of the checked-in driver produced the exact same
capture digest:

```text
04c01423ebf329331f5d7f3a663d411df841c9bc9d6693fb91904fa85eb716c8
```
