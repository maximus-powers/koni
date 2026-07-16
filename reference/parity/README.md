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
