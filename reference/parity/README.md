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
