# Contributing to Köni

Thank you for helping make graph-first agentic work safer and easier to
understand.

## Before opening a change

- Search existing issues and pull requests.
- Use an issue for a substantial feature, new primitive, schema change, or
  compatibility decision before investing in an implementation.
- Keep behavior generic in the engine. Domain vocabulary and policy belong in
  profiles unless the capability truly applies to every domain.
- Do not include credentials, private prompts, proprietary fixtures, or
  generated model transcripts.

For questions and support, see [Support](SUPPORT.md). Report vulnerabilities
privately according to [Security](SECURITY.md).

## Development setup

Köni uses the Rust toolchain pinned in `rust-toolchain.toml`.

```sh
git clone https://github.com/maximus-powers/koni.git
cd koni
cargo build --workspace
cargo test --workspace
```

Install the development CLI when an end-to-end check needs it:

```sh
cargo install --path crates/koni-cli
koni --help
```

## Making a change

1. Create a focused branch.
2. Add or update tests with the behavior.
3. Update public documentation for user-visible commands, configuration,
   guarantees, or limitations.
4. Preserve unrelated working-tree changes.
5. Run the relevant checks.

The minimum Rust checks are:

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

For profile work, also validate the affected installed-style project:

```sh
cargo run -p koni-cli -- validate-profile <project-or-profile-path>
```

For documentation-site changes, run the lint, type-check, and production build
commands defined in `apps/docs/package.json`.

## Design expectations

Changes should preserve Köni's core boundaries:

- graph gaps compile deterministically into work;
- agents propose output but do not authorize their own state transitions;
- IDs, paths, permissions, and Git publication remain compiler-owned;
- evidence is durable and bound to current inputs;
- parallel work has provably disjoint authority;
- invalid, ambiguous, stale, or unowned state fails closed.

New configuration fields need:

- a documented purpose and ownership layer;
- parsing and semantic validation;
- stable hashing and run-snapshot behavior;
- a migration or an explicit pre-1.0 compatibility note;
- positive and negative tests;
- TUI/CLI projection when operators need to inspect them.

New actions or process capabilities need an explicit effect, containment
policy, failure journal, receipt contract, and recovery story.

## Tests

Prefer the smallest layer that proves the behavior:

- unit tests for parsing, validation, selectors, state transitions, and pure
  projections;
- integration tests for run lifecycle, process, storage, worktree, and recovery
  boundaries;
- profile acceptance tests for graph-to-ticket-to-reviewed-integration flows;
- snapshot tests only when the presentation itself is the contract.

Tests must not depend on a developer's global Codex configuration, credentials,
network, wall-clock timing, or absolute workspace path.

## Pull requests

Keep a pull request narrow and explain:

- the user or maintainer problem;
- the chosen boundary and why it belongs there;
- public interface or migration effects;
- validation performed;
- known limitations or follow-up work.

Complete the pull-request template. A maintainer may ask to split changes that
mix engine behavior, profile policy, and unrelated cleanup.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
