# Profile Release Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development`
> (recommended) or `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Make the authenticated Coding and Research profile upgrade tests use byte-exact immutable
prior-release packages and restore the full release gate without weakening pinned identities.

**Architecture:** Historical package fixtures are complete, read-only package snapshots under the
Core test fixtures. Tests copy a snapshot to a temporary directory and authenticate it before using
it. Current profile packages remain the only source for current-release bytes; migration descriptors
name the exact historical bundle identities.

**Tech Stack:** Node.js 22, TypeScript 5.9, Vitest 4, npm workspaces, SHA-256 profile manifests.

## Global Constraints

- Do not replace the pinned Coding
  `sha256:4e955f7fb5a6bbd58542f395471d2e3f1c87364840abd218f973b8f62a5c0c7e` or Research
  `sha256:1bc8bdb64934ccd475f50acad5b22a7b1b6f7e168a748ecd91e234be76126c60` identities with
  reconstructed hashes.
- Do not format, normalize, or regenerate historical fixture bytes after authentication.
- Keep production migration allowlists closed and exact.
- Preserve all existing dirty-tree changes.

---

## Task 1: Characterize exact historical-package loading

**Files:**

- Modify: `packages/core/test/profile-release-upgrade.test.ts`
- Create: `packages/core/test/fixtures/profile-prior-releases.test.ts`

**Step 1: Add a failing fixture-authentication test**

Create a table with the two prior package directories and expected bundle hashes:

```ts
const fixtures = [
  ["coding-0.7.0", codingPriorBundleSha256],
  ["research-1.0.11", researchPriorBundleSha256],
] as const;

it.each(fixtures)("%s is a byte-exact authenticated package", async (directory, expected) => {
  const fixture = path.join(import.meta.dirname, "profile-prior-releases", directory);
  const loaded = await loadProfilePackage(fixture);
  expect(loaded.manifest.bundle_sha256).toBe(expected);
});
```

Run:

```sh
npm exec --workspace @koni/core -- vitest run test/fixtures/profile-prior-releases.test.ts
```

Expected: FAIL because the complete prior-release fixture directories do not exist.

**Step 2: Replace reverse transforms with a package-copy helper**

In `profile-release-upgrade.test.ts`, replace `buildPriorReleasePackage()` and all string transforms
with:

```ts
async function copyPriorReleasePackage(release: ReleaseFixture): Promise<string> {
  const root = await temporary(`${release.directory}-prior-release`);
  await cp(
    path.join(import.meta.dirname, "fixtures", "profile-prior-releases", release.fixtureDirectory),
    root,
    { recursive: true },
  );
  const loaded = await loadProfilePackage(root);
  expect(loaded.manifest.bundle_sha256).toBe(release.oldBundleSha256);
  return root;
}
```

Keep the existing upgrade assertions unchanged.

**Step 3: Commit the red characterization**

```sh
git add packages/core/test/profile-release-upgrade.test.ts \
  packages/core/test/fixtures/profile-prior-releases.test.ts
git commit -m "test(core): require exact prior profile packages"
```

---

## Task 2: Recover and freeze the authenticated prior packages

**Files:**

- Create: `packages/core/test/fixtures/profile-prior-releases/coding-0.7.0/package.json`
- Create:
  `packages/core/test/fixtures/profile-prior-releases/coding-0.7.0/koni/profile-manifest.json`
- Create: `packages/core/test/fixtures/profile-prior-releases/coding-0.7.0/koni/baseline/**`
- Create: `packages/core/test/fixtures/profile-prior-releases/research-1.0.11/package.json`
- Create:
  `packages/core/test/fixtures/profile-prior-releases/research-1.0.11/koni/profile-manifest.json`
- Create: `packages/core/test/fixtures/profile-prior-releases/research-1.0.11/koni/baseline/**`
- Delete: `packages/core/test/fixtures/coding-prior-release/**`

**Step 1: Recover bytes from local repository provenance**

Start from the committed `0.7.0` and `1.0.11` package trees and replay only the recorded profile
edits from local Codex session logs in timestamp order. At each recorded `profiles:capture`
boundary, compute the bundle with the repository's `computeProfileBundleSha256` implementation. Stop
only when the result equals the pinned identity.

The recovery check is:

```sh
npm exec --workspace @koni/core -- vitest run test/fixtures/profile-prior-releases.test.ts
```

Expected: PASS for both fixtures. A file-by-file descriptor match plus the top-level bundle hash is
the acceptance criterion; a semantically similar tree is not sufficient.

**Step 2: Remove migrations from historical manifests**

Historical manifests must contain the original `package`, `profile`, `baseline`, and `bundle_sha256`
fields. They must not inherit current migrations:

```ts
expect(manifest.migrations).toBeUndefined();
```

**Step 3: Run the release-upgrade suite**

```sh
npm exec --workspace @koni/core -- vitest run test/profile-release-upgrade.test.ts
```

Expected: 10 tests pass.

**Step 4: Commit immutable fixtures**

```sh
git add packages/core/test/fixtures packages/core/test/profile-release-upgrade.test.ts
git commit -m "fix(core): freeze authenticated prior profile releases"
```

---

## Task 3: Verify current package and migration integrity

**Files:**

- Verify: `packages/coding-profile/koni/profile-manifest.json`
- Verify: `packages/coding-profile/koni/migrations/retire-inert-semantics-v1.json`
- Verify: `packages/research-profile/koni/profile-manifest.json`
- Verify: `packages/research-profile/koni/migrations/retire-inert-semantics-v1.json`
- Modify only if verification exposes a real mismatch.

**Step 1: Authenticate current profiles**

```sh
npm run test:profiles
```

Expected: five tests pass.

**Step 2: Verify all named migration sources**

Add table-driven assertions to `profile-prior-releases.test.ts` that each frozen fixture identity is
present exactly once in its target migration's `source_bundle_sha256` list and that the current
bundle is the migration target.

Run:

```sh
npm exec --workspace @koni/core -- vitest run \
  test/fixtures/profile-prior-releases.test.ts \
  test/profile-package.test.ts \
  test/profile-install.test.ts \
  test/profile-release-upgrade.test.ts
```

Expected: PASS.

**Step 3: Verify package tests and manifests**

```sh
npm run test --workspace @koni/coding-profile
npm run test --workspace @koni/research-profile
npm run test:profiles
git diff --check
```

Expected: all commands pass.

**Step 4: Commit any integrity assertion changes**

```sh
git add packages/core/test/fixtures/profile-prior-releases.test.ts \
  packages/coding-profile packages/research-profile
git commit -m "test(profiles): enforce migration identity closure"
```
