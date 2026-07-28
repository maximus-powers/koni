# Repository Quality Tooling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Add deterministic lint and formatting gates for authored TypeScript, JavaScript,
Markdown, JSON, YAML, and shell sources without rewriting authenticated or historical bytes.

**Architecture:** ESLint owns semantic TypeScript/JavaScript correctness. Prettier owns
non-semantic formatting checks. Root npm scripts compose these gates before the existing workspace
checks. Authenticated baselines, frozen releases, generated output, archives, and scratch trees are
explicit exclusions.

**Tech Stack:** ESLint 10.8, typescript-eslint 8.65, Prettier 3.9, TypeScript 5.9, npm 11.

## Global Constraints

- Do not run a formatter across `packages/*-profile/koni/baseline/**`,
  `packages/core/test/fixtures/profile-prior-releases/**`, generated `dist/**`, or archives.
- Do not add broad file-level disables to make the gate green.
- Keep type-aware lint scoped to authored TypeScript projects.
- Fix correctness findings in their owning subsystem with focused tests.

---

## Task 1: Install and configure the semantic lint gate

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `eslint.config.js`

**Step 1: Install pinned development dependencies**

```sh
npm install --save-dev --save-exact eslint@10.8.0 typescript-eslint@8.65.0
```

**Step 2: Add the flat configuration**

Configure:

```js
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "private/**",
      "packages/*-profile/koni/baseline/**",
      "packages/core/test/fixtures/profile-prior-releases/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    files: ["packages/**/*.ts", "scripts/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@typescript-eslint/only-throw-error": "error",
      "@typescript-eslint/prefer-nullish-coalescing": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
    },
  },
);
```

Use narrow overrides for JavaScript test/config files and declaration shims.

**Step 3: Add scripts**

```json
"lint": "eslint . --max-warnings 0",
"lint:fix": "eslint . --fix"
```

**Step 4: Run the red gate and classify every finding**

```sh
npm run lint
```

Expected: initially FAIL with a finite list of actionable findings.

**Step 5: Commit configuration separately**

```sh
git add package.json package-lock.json eslint.config.js
git commit -m "build: add type-aware eslint gate"
```

---

## Task 2: Resolve semantic lint findings

**Files:**

- Modify: only authored source/test files named by ESLint.
- Modify: owning focused tests when behavior changes.

**Step 1: Fix in correctness-first groups**

Resolve findings in this order:

1. unhandled promises and async callbacks;
2. unsafe `any`, unchecked member access, and unsafe returns;
3. impossible conditions, unnecessary assertions, and unreachable branches;
4. type-only imports and local naming/structure findings.

For any behavior-affecting finding, first add or identify a focused failing test. Do not replace an
unsafe cast with a different cast; validate the boundary.

**Step 2: Verify after each subsystem**

```sh
npm run lint
npm run typecheck
npm run test --workspace @koni/core
```

Expected: the affected subsystem and lint pass.

**Step 3: Commit findings by subsystem**

Use messages such as:

```sh
git commit -m "fix(authority): await durable cleanup paths"
git commit -m "refactor(pi): validate worker message boundaries"
git commit -m "style(core): normalize type-only imports"
```

---

## Task 3: Add a non-destructive formatting gate

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `.prettierignore`
- Create: `.prettierrc.json`
- Create: `.editorconfig`

**Step 1: Install Prettier**

```sh
npm install --save-dev --save-exact prettier@3.9.6
```

**Step 2: Define stable formatting**

Use:

```json
{
  "printWidth": 100,
  "proseWrap": "always",
  "trailingComma": "all"
}
```

Exclude authenticated baselines, historical releases, generated output, package locks, archives,
fixtures whose bytes are protocol inputs, and `private/**`.

**Step 3: Add scripts**

```json
"format": "prettier --write .",
"format:check": "prettier --check ."
```

**Step 4: Format only eligible authored files**

```sh
npm run format
npm run format:check
git diff --check
```

Expected: both checks pass and no excluded authenticated file changes.

**Step 5: Commit mechanical formatting**

```sh
git add .editorconfig .prettierignore .prettierrc.json package.json package-lock.json
git diff --name-only --diff-filter=ACMRTUXB -z | \
  xargs -0 git add --
git commit -m "style: enforce deterministic source formatting"
```

Before the second command, remove every excluded authenticated or historical path from the
null-delimited candidate list; stage those paths only through their owning release-integrity task.

---

## Task 4: Integrate quality checks into the release gate

**Files:**

- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`

**Step 1: Compose the root gate**

Make `check` execute `lint` and `format:check` before profile, boundary, workspace, build, and smoke
tests:

```json
"check": "npm run lint && npm run format:check && npm run test:profiles && npm run test:pi-host-boundary && npm run check --workspaces --if-present && node --test scripts/pi-package-smoke.test.mjs"
```

**Step 2: Ensure CI uses the root gate**

Keep dependency installation reproducible with `npm ci`; invoke `npm run check` exactly once after
environment setup.

**Step 3: Verify**

```sh
npm run lint
npm run format:check
npm run typecheck
```

Expected: PASS.

**Step 4: Commit gate integration**

```sh
git add package.json .github/workflows/ci.yml
git commit -m "ci: enforce repository quality gates"
```
