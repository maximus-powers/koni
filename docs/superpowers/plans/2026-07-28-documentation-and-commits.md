# Documentation and Semantic Commit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Make product documentation and repository contents match the shipping TypeScript/Pi-native
system, then place every intended change into a cohesive semantic commit with a clean worktree.

**Architecture:** Current public docs describe only shipping surfaces. Historical material survives
only in explicit release fixtures or migration records. Commit boundaries follow product domains
and keep tests with the behavior they prove.

**Tech Stack:** Markdown, npm workspaces, Git, repository shell checks.

## Global Constraints

- Use `ste-writing` for prose cleanup, never for source code.
- Do not commit `private/**`, caches, temporary captures, editor state, or local audit output.
- Do not split a behavior change from its regression test.
- Do not rewrite or squash existing commits.
- Use path-scoped staging and inspect each staged diff before committing.

---

## Task 1: Reconcile product documentation

**Files:**

- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/configuration.md`
- Modify: `docs/control-center.md`
- Modify: `docs/getting-started.md`
- Modify: `docs/maturity.md`
- Modify: `docs/philosophy.md`
- Modify: `docs/pi-community-resource-bindings.md`
- Modify: `docs/profile-lifecycle.md`
- Modify: `docs/runtime-and-git.md`
- Modify: `docs/software-profile-engineering.md`

**Step 1: Audit stale surface names**

```sh
rg -n -i \
  'cargo|rust oracle|rust runtime|runtime/pi-host|apps/docs|parity runner|legacy profile|koni init' \
  README.md docs packages/*/README.md
```

Classify each match as current migration history, an intentionally deleted surface, or stale
operator guidance.

**Step 2: Rewrite current guidance**

Describe the three npm workspaces, Pi-native authority runtime, authenticated profile packages,
control center, Git common-directory state, and current commands. Historical statements must be
explicitly labeled and must not read as current instructions.

**Step 3: Verify links and commands**

```sh
node --test scripts/docs-links.test.mjs
npm run check:brand
npm run format:check
```

If the repository lacks these scripts, add deterministic link and brand checks before running them.

**Step 4: Commit**

```sh
git add README.md docs packages/*/README.md scripts/docs-links.test.mjs package.json
git commit -m "docs: align guidance with the Pi-native release"
```

---

## Task 2: Remove accidental and obsolete repository material

**Files:**

- Modify: `.gitignore`
- Verify deletions already present under `crates/`, `runtime/pi-host/`, `apps/docs/`,
  `reference/parity/`, legacy profile trees, and obsolete audit documents.
- Exclude: `private/**`

**Step 1: Verify no live references require deleted trees**

```sh
rg -n \
  'crates/|runtime/pi-host|apps/docs|reference/parity|profiles/research|fixtures/updog-repo' \
  --glob '!package-lock.json' --glob '!docs/superpowers/**' .
```

Every remaining reference must either be removed or explicitly document migration history.

**Step 2: Protect local artifacts**

Add `private/`, coverage, test caches, build output, and local capture paths to `.gitignore`.

**Step 3: Verify package contents**

```sh
npm pack --dry-run --workspace @koni/core
npm pack --dry-run --workspace @koni/coding-profile
npm pack --dry-run --workspace @koni/research-profile
```

Expected: only declared shipping files appear.

**Step 4: Commit repository-shape changes**

```sh
git add .gitignore crates runtime/pi-host apps/docs reference profiles fixtures \
  Cargo.toml Cargo.lock rust-toolchain.toml deny.toml packaging
git diff --cached --check
git commit -m "refactor!: retire legacy Rust and parity surfaces"
```

Include an explanatory breaking-change body naming the TypeScript/Pi-native replacement.

---

## Task 3: Construct semantic commits for the migration

**Files:**

- Stage all remaining intended paths by domain.

**Step 1: Inventory**

```sh
git status --short
git diff --name-status
git diff --cached --name-status
```

Separate intended changes into:

1. root build and CI;
2. Coding profile release;
3. Research profile release;
4. Core contracts/compiler;
5. Core authority/state;
6. Core Pi runtime;
7. Core Git/operator/control center;
8. tests and fixtures that belong with those domains;
9. documentation and repository retirement.

**Step 2: Stage and inspect one group at a time**

For each group:

```sh
git diff --cached --stat
git diff --cached --check
git diff --cached --name-status
```

Stage the exact paths printed for that group by the inventory in Step 1, then use
`git diff --cached` to ensure no unrelated path entered the group.

**Step 3: Commit with Conventional Commit messages**

Use precise messages such as:

```text
feat(core)!: complete the Pi-native authority runtime
feat(coding-profile): publish the continuous improvement release
feat(research-profile): retire inert profile semantics
test(core): cover durable authority and process boundaries
```

Tests must be amended into their behavior commit when they can be grouped safely. Do not create
`chore: cleanup` or `misc` commits.

---

## Task 4: Final verification and clean-tree handoff

**Files:**

- Verify the final committed snapshot.

**Step 1: Invoke final-review and verification skills**

Use `final-review`, `superpowers:requesting-code-review`, and
`superpowers:verification-before-completion`. Resolve every P0/P1/P2 finding and rerun affected
checks.

**Step 2: Run the complete gate**

```sh
npm ci
npm run check
git diff --check HEAD^
git status --short
```

Expected:

- dependency install succeeds from the lockfile;
- lint, format, profile, boundary, workspace, build, architecture, and package smoke gates pass;
- no whitespace errors;
- the worktree is clean.

**Step 3: Inspect semantic history**

```sh
git log --oneline --decorate -20
```

Expected: cohesive Conventional Commit messages in dependency order, with no local scratch commit.
