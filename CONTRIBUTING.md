# Contributing to Köni

## Before you open a change

- Search existing issues and pull requests.
- Open an issue before you implement a large feature, schema change, or compatibility change.
- Keep generic behavior in Core. Keep domain policy in a profile.
- Do not include credentials, private prompts, proprietary fixtures, or generated model transcripts.

Read [Support](SUPPORT.md) for questions. Report vulnerabilities according to
[Security](SECURITY.md).

## Development setup

Köni uses npm workspaces, Node 22.19 or later, npm 11.13, and Pi 0.80.10.

```sh
git clone https://github.com/maximus-powers/koni.git
cd koni
npm ci
npm run check
```

Use `./scripts/install-dev.sh` only when an end-to-end test needs a local Pi package installation.

## Make a change

1. Create a focused branch.
2. Add or update tests with the behavior.
3. Update public documentation for visible changes.
4. Preserve unrelated working-tree changes.
5. Run the relevant focused tests.
6. Run `npm run check`.

New configuration fields need:

- a documented purpose and ownership layer;
- parsing and semantic validation;
- stable hashing and run-snapshot behavior;
- a migration or an explicit compatibility decision;
- positive and negative tests;
- a TUI or CLI projection when an operator must inspect the field.

New effects need a containment policy, failure journal, receipt contract, and recovery path.

## Tests

Use the smallest layer that proves the behavior:

- unit tests for parsing, validation, state transitions, and pure projections;
- integration tests for runtime, storage, worktree, and recovery boundaries;
- profile tests for graph-to-ticket-to-reviewed-integration flows;
- presentation tests only when the rendered result is the contract.

Tests must not depend on global credentials, network access, wall-clock timing, or an absolute
workspace path.

## Pull requests

Describe the problem, design boundary, compatibility effects, validation, and known limitations.
Complete the pull-request template.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
