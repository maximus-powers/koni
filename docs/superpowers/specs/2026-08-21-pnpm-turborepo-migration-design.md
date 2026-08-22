# pnpm and Turborepo Migration Design

## Goal

Convert Koni's source repository from npm workspaces to a pnpm-managed Turborepo so independent
workspace tasks run concurrently and deterministic results are cached locally. Reduce cold core-test
latency by running isolated tests with bounded parallelism while retaining an exclusive lane for
tests that exercise shared operating-system resources.

## Scope

This migration changes the repository development toolchain. It does not change Koni's distribution
boundary: Koni packages are still published to npm, Pi still installs them through npm, and release
smoke tests must continue to exercise a stock npm/Pi installation.

The migration includes:

- pnpm 11.13.1 as the only supported repository package manager;
- a `pnpm-workspace.yaml` covering the three packages;
- Turborepo 2.10.5 for build, typecheck, test, and check orchestration;
- local `.turbo` caching only, with no hosted remote cache;
- pnpm-based CI dependency installation and repository commands;
- pnpm-based developer documentation and development activation;
- a dedicated npm lock fixture for the Pi host compatibility boundary;
- bounded parallel execution for isolated core tests and serialized execution for exclusive tests.

Historical plans and specifications remain historical records and are not mechanically rewritten.
References to npm package coordinates, npm publication, and Pi's npm-managed package directory are
runtime concepts and also remain unchanged.

## Repository Package Management

The root manifest declares `pnpm@11.13.1` in `packageManager` and declares Turborepo as an exact
development dependency. `pnpm-lock.yaml` becomes the development lockfile; the root
`package-lock.json` is removed.

`pnpm-workspace.yaml` includes `packages/*`. Workspace packages retain their existing names and
publication metadata. Package-local scripts use `pnpm run` when composing other package scripts.
Normal developer commands are:

```text
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
pnpm check
```

## Turbo Task Graph and Cache Policy

The root scripts delegate workspace work to `turbo run`. Turbo may run independent packages in
parallel. Task dependencies express ordering instead of shell-level workspace loops.

Deterministic tasks are cached locally:

- `build`, with package `dist/**` outputs;
- `typecheck`;
- parallel and exclusive test tasks;
- aggregate `test` and `check` tasks where their inputs are fully represented.

Repository-level tests remain named root scripts and are modeled as explicit root Turbo tasks where
that improves dependency ordering. Tasks that create disposable installations, exercise package
manager behavior, or validate mutable external state are not cached. The five-minute Pi package
smoke stays in `pnpm check` and release validation instead of the normal developer `pnpm test`; it
depends on both the Core build and Core test so its authority and package-manager rehearsal cannot
contend with the exclusive Core lane.

`.turbo/` is ignored. No remote-cache URL, token, team, or CI cache transport is configured.

## Core Test Execution

The existing global `fileParallelism: false` setting is replaced with two explicit lanes:

1. The isolated lane runs files concurrently with at most four workers. Tests in this lane must use
   process-isolated workers and unique temporary resources.
2. The exclusive lane runs files one at a time. It contains tests that launch or supervise real
   child processes, manipulate real Git repositories or worktrees, bind authority sockets, rehearse
   package installation, or otherwise depend on process-wide/shared operating-system state.

The file classification is centralized in test configuration rather than duplicated in scripts.
Every core test file must belong to exactly one lane. A small Node test verifies disjointness and
full coverage so new test files cannot silently bypass classification.

Integration validation finalized the split at 103 isolated files and five exclusive files.
`run-authority-engine.test.ts` moved to the exclusive lane after its 148 real authority-engine,
socket, and child-Git lifecycles produced two polling/lifecycle timing failures under four-worker OS
contention; both affected tests passed when the file ran without competing test files.
`profile-install.test.ts` also moved after warm integration exposed its process-global
`fs.promises.open`/`rename` replacement and `syncBuiltinESMExports()` fault injection: both affected
durability tests passed when the file ran in isolation.

The setup fixture remains hermetic. Each worker receives an independent Pi agent directory, so no
parallel test mutates another worker's environment or fixture tree.

The default `@koni/core` test script runs the isolated lane first and the exclusive lane second.
This preserves exclusivity while reducing the dominant cold-run cost. Developers and agents can run
a specific file directly through the package's targeted test script without invoking the full suite.

## npm Distribution Boundary

The current Pi host verifier reads npm lockfile version 3 data from the development lockfile. After
the migration, that exact npm dependency closure moves to
`scripts/fixtures/pi-host-package-lock.json`. The verifier continues to authenticate Pi 0.80.10 and
TypeBox 1.1.38 against npm's resolved package tree, but the fixture no longer masquerades as the
repository package-manager lock.

Release jobs continue using npm for:

- packing the public package payloads when the purpose is to validate npm packaging;
- installing archives into a stock Pi-managed npm closure;
- auditing and generating the shipping SBOM;
- publishing immutable archives to the npm registry.

Source checkout installation, builds, checks, and tests use pnpm. `scripts/install-dev.sh` requires
the pinned pnpm version for repository operations and retains npm for disposable runtime closure
materialization.

The npm/Pi release rehearsal remains package-manager-layout agnostic: stock npm packs each explicit
public package directory without requiring npm workspace metadata, and the rehearsal resolves Pi's
exact TypeBox runtime from Pi's package boundary. The Koni launcher follows a normal wrapper into
the pnpm-generated Pi shim before authenticating the real Pi package root; opaque active wrappers
still fail closed.

## CI and Documentation

CI and release validation enable Corepack, install with `pnpm install --frozen-lockfile`, and
execute repository tasks through pnpm. GitHub's setup-node cache changes from npm to pnpm.
Publication steps retain their explicit npm setup.

Current contributor and getting-started documentation describes pnpm and Turbo. Historical design
and plan documents are not rewritten. Package installation examples such as
`pi install npm:@koni/core` remain unchanged because they describe the product's distribution
protocol.

## Verification

Implementation uses targeted verification during development:

- a repository architecture test proves pnpm/Turbo metadata and rejects obsolete npm workspace
  orchestration;
- the lane-classification test proves every core test file belongs to exactly one lane;
- focused high-risk test groups exercise parallel fixture isolation and exclusive process/Git tests;
- typecheck, build, formatting, and repository-boundary tests run through their new pnpm commands;
- a single final cold `pnpm test` is reserved for the integration gate, followed by a warm run that
  demonstrates Turbo cache hits.

The old full suite is not repeatedly invoked during migration.
