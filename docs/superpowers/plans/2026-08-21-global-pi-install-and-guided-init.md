# Global Pi Installation and Guided Init Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `pi install npm:@koni/core` publish an authenticated global `koni` command and make
bare shell or Pi `koni init` initialize Coding, validate automatically, and enter guided
configuration without creating a run.

**Architecture:** A package-lifecycle adapter publishes one authenticated launcher beside the
resolved global `pi` executable only when Core is installed inside Pi's user package root. CLI and
Pi surfaces share a new install-and-validate operation; the CLI prints the result, while
`/koni init` injects the installed `configure-koni` skill into the same Pi conversation after
success.

**Tech Stack:** TypeScript, Node.js 22.19+, npm lifecycle scripts, Pi 0.80.10 extension API, Vitest,
Node's test runner, packed-tarball smoke tests.

**Spec:** `docs/superpowers/specs/2026-08-21-global-pi-install-and-guided-init-design.md`

## Global Constraints

- `pi install npm:@koni/core` is the only end-user package installation authority; do not create a
  second package closure.
- Do not edit shell startup files or require a PATH export.
- The launcher may replace or remove only an exact authenticated Koni-owned target.
- Global installation must not create `.koni`, `.pi`, Git refs, worktrees, authority state, or runs
  in the invoking repository.
- Bare `koni init` means Coding at the current working directory and succeeds only after
  authoritative configuration validation.
- `/koni init` starts Configure in the same Pi conversation only after initialization and validation
  succeed.
- Initialization and guided configuration create no run and no commit.
- Preserve explicit Coding, Research, `--root`, update, conflict, duplicate-Core,
  active-installation, and runtime-integrity behavior.
- Keep the complete `@koni/core` package-root export surface unchanged.
- Use test-first RED/GREEN evidence for every production behavior change.

---

## File Structure

- `packages/core/src/installation/global-launcher.ts`: package-owned launcher discovery, ownership
  marker validation, atomic activation, recovery, and removal.
- `packages/core/bin/koni-package-lifecycle.js`: minimal npm lifecycle adapter that invokes built
  launcher code only for a real Pi user-package installation.
- `packages/core/src/operator/project-initialization.ts`: shared profile install plus authoritative
  configuration-validation operation.
- `packages/core/src/cli.ts`: bare-init defaults, shared initialization call, validated result
  formatting, and revised help.
- `packages/core/src/extension.ts`: `/koni init` default and same-session `$configure-koni` handoff.
- `packages/core/test/global-launcher-installation.test.ts`: mutation-sensitive launcher ownership
  and recovery tests.
- `packages/core/test/project-initialization.test.ts`: shared operation behavior and validation
  failure tests.
- `packages/core/test/operator-surface.test.ts`: shell CLI default and compatibility tests.
- `packages/core/test/pi-companion-extension.test.ts`: Pi initialization, passivity, handoff, and
  failure tests.
- `scripts/pi-package-smoke.test.mjs`: exact packed install, fresh-shell command discovery, guided
  Pi init, and uninstall audit.
- `docs/getting-started.md`, `README.md`, `packages/core/README.md`,
  `packages/coding-profile/README.md`, `packages/research-profile/README.md`: end-user installation
  and initialization contract.

---

### Task 1: Authenticated Pi-owned global launcher

**Files:**

- Create: `packages/core/src/installation/global-launcher.ts`
- Create: `packages/core/bin/koni-package-lifecycle.js`
- Modify: `packages/core/package.json`
- Test: `packages/core/test/global-launcher-installation.test.ts`

**Interfaces:**

- Produces:

```ts
export interface GlobalLauncherEnvironment {
  packageRoot: string;
  agentDir: string;
  pathValue: string;
  platform: NodeJS.Platform;
}

export interface GlobalLauncherActivation {
  protocol: "koni.global-launcher.v1";
  launcherPath: string;
  packageRoot: string;
  launcherTarget: string;
  targetSha256: string;
}

export function isPiUserPackageInstallation(input: {
  packageRoot: string;
  agentDir: string;
}): boolean;

export async function activateGlobalLauncher(
  environment: GlobalLauncherEnvironment,
): Promise<GlobalLauncherActivation | undefined>;

export async function removeGlobalLauncher(
  environment: GlobalLauncherEnvironment,
): Promise<"removed" | "absent" | "not_owner">;
```

- The lifecycle adapter imports these functions from `../dist/installation/global-launcher.js` and
  accepts only `activate` or `remove`.

- [ ] **Step 1: Write failing ownership and activation tests**

Create tests with isolated agent/package/PATH directories. Use a fake executable `pi` already on
PATH and a real Core `bin/koni.js` target. Assert:

```ts
expect(isPiUserPackageInstallation({ packageRoot, agentDir })).toBe(true);
const activation = await activateGlobalLauncher(environment);
expect(activation?.launcherPath).toBe(path.join(piBin, "koni"));
expect(await realpath(activation!.launcherPath)).toBe(await realpath(coreLauncher));
expect(JSON.parse(await readFile(markerPath, "utf8"))).toMatchObject({
  protocol: "koni.global-launcher.v1",
  launcherPath: path.join(piBin, "koni"),
  packageRoot,
});
```

Also prove an ordinary monorepo/workspace install returns `undefined` and does not write a launcher
or marker.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```sh
npm --workspace @koni/core test -- --run test/global-launcher-installation.test.ts
```

Expected: FAIL because the installation module does not exist.

- [ ] **Step 3: Implement Pi-install detection and authenticated activation**

Implement exact containment beneath `<agentDir>/npm/node_modules/@koni/core`, PATH executable lookup
for one resolved `pi`, a platform launcher path beside that executable, SHA-256 binding of
`bin/koni.js`, a no-follow ownership marker beneath `<agentDir>/koni/global-launcher.json`, and
adjacent-temp atomic publication. Refuse ambiguous Pi candidates, unwritable directories, symlink
escapes, malformed markers, and unrelated launcher targets.

The POSIX launcher must resolve the package target without copying package bytes. The Windows form
must use an exact command shim bound by the same marker. Do not export this module from
`packages/core/src/index.ts`.

- [ ] **Step 4: Add RED tests for update, removal, collision, and interruption**

Cover these mutations independently:

```ts
await expect(activateGlobalLauncher(environmentWithUnrelatedTarget)).rejects.toThrow(
  /refusing to overwrite an unrelated koni launcher/,
);
expect(await removeGlobalLauncher(oldEnvironmentAfterNewActivation)).toBe("not_owner");
expect(await removeGlobalLauncher(currentEnvironment)).toBe("removed");
```

Inject a test-owned hook at marker publication and launcher rename to seed before/after crash
states. A subsequent activation must converge to the exact old or new authenticated generation
without deleting an unrelated file.

- [ ] **Step 5: Run the launcher tests and verify RED for each new boundary**

Run the same focused Vitest command after each test group. Confirm failures name the missing
ownership, recovery, or off-by-generation behavior rather than fixture setup.

- [ ] **Step 6: Implement update, recovery, and removal**

Use marker identity plus exact target SHA/path checks. Same-generation activation is idempotent.
New-generation activation atomically replaces the prior owned launcher and marker. Removal checks
the currently installed package root and target digest before unlinking. Recovery consumes only the
bounded authenticated marker/journal; a bare filename never proves ownership.

- [ ] **Step 7: Add the npm lifecycle adapter and package scripts**

Add to `packages/core/package.json`:

```json
{
  "scripts": {
    "postinstall": "node ./bin/koni-package-lifecycle.js activate",
    "preuninstall": "node ./bin/koni-package-lifecycle.js remove"
  }
}
```

The adapter derives `packageRoot` from its own location, `agentDir` from `PI_CODING_AGENT_DIR` or
`~/.pi/agent`, and passes the inherited PATH/platform. It exits without writes when
`isPiUserPackageInstallation` is false. A real Pi install failure must be nonzero and actionable.

- [ ] **Step 8: Verify Task 1 GREEN**

Run:

```sh
npm --workspace @koni/core test -- --run test/global-launcher-installation.test.ts
npm --workspace @koni/core run typecheck
npx eslint packages/core/src/installation/global-launcher.ts packages/core/test/global-launcher-installation.test.ts
npx prettier --check packages/core/src/installation/global-launcher.ts packages/core/bin/koni-package-lifecycle.js packages/core/test/global-launcher-installation.test.ts packages/core/package.json
git diff --check
```

Expected: all exit 0.

- [ ] **Step 9: Commit Task 1**

```sh
git add packages/core/src/installation/global-launcher.ts packages/core/bin/koni-package-lifecycle.js packages/core/package.json packages/core/test/global-launcher-installation.test.ts
git commit -m "feat(core): publish Pi-owned global launcher"
```

---

### Task 2: Shared install-and-validate project authority

**Files:**

- Create: `packages/core/src/operator/project-initialization.ts`
- Test: `packages/core/test/project-initialization.test.ts`

**Interfaces:**

- Consumes the existing `installAndCacheProfile` and `validateProjectConfiguration` operations.
- Produces:

```ts
export interface InitializeProjectProfileInput {
  projectRoot: string;
  profilePackageRoot: string;
}

export interface InitializedProjectProfile {
  installation: Awaited<ReturnType<typeof installAndCacheProfile>>;
  validation: Extract<Awaited<ReturnType<typeof validateProjectConfiguration>>, { ok: true }>;
}

export async function initializeProjectProfile(
  input: InitializeProjectProfileInput,
  dependencies?: {
    install: typeof installAndCacheProfile;
    validate: typeof validateProjectConfiguration;
  },
): Promise<InitializedProjectProfile>;
```

- [ ] **Step 1: Write the failing shared-operation tests**

Assert install runs once, validation runs against the installation's canonical project root, a valid
result returns both authenticated records, and invalid diagnostics throw one typed
`ProjectInitializationError` containing exact path/message pairs. Assert the operation never calls
authority start or run creation APIs.

- [ ] **Step 2: Verify RED**

Run:

```sh
npm --workspace @koni/core test -- --run test/project-initialization.test.ts
```

Expected: FAIL because the shared operation does not exist.

- [ ] **Step 3: Implement the minimal shared operation**

Call install, then validate the returned canonical project root. Return only when `ok === true` and
`configuration` is present. Preserve validation diagnostics and the successful installation record
in the typed error so surfaces can distinguish “profile published but configuration invalid” from
“installation failed.” Do not start Configure, an authority, or a run here.

- [ ] **Step 4: Verify GREEN and static checks**

```sh
npm --workspace @koni/core test -- --run test/project-initialization.test.ts
npm --workspace @koni/core run typecheck
npx eslint packages/core/src/operator/project-initialization.ts packages/core/test/project-initialization.test.ts
npx prettier --check packages/core/src/operator/project-initialization.ts packages/core/test/project-initialization.test.ts
git diff --check
```

- [ ] **Step 5: Commit Task 2**

```sh
git add packages/core/src/operator/project-initialization.ts packages/core/test/project-initialization.test.ts
git commit -m "feat(core): centralize validated project initialization"
```

---

### Task 3: Bare shell `koni init` defaults and automatic validation

**Files:**

- Modify: `packages/core/src/cli.ts`
- Modify: `packages/core/test/operator-surface.test.ts`

**Interfaces:**

- Consumes `initializeProjectProfile` from Task 2.
- Preserves `runKoniCli(argv, io, dependencies): Promise<number>` and the existing CLI
  dependency-injection surface.

- [ ] **Step 1: Write failing CLI behavior tests**

Add focused cases proving:

```ts
await runKoniCli(["init"], io, dependencies);
expect(dependencies.resolveProfile).toHaveBeenCalledWith("coding");
expect(dependencies.install).toHaveBeenCalledWith({
  projectRoot: canonicalRoot,
  profilePackageRoot: codingPackageRoot,
});
expect(dependencies.validate).toHaveBeenCalledWith(canonicalRoot);
```

Run from a fixture `process.cwd()` and prove omitted root uses that Git worktree. Retain explicit
`research`, `--profile-package`, and `--root` cases. Add invalid-validation assertions: nonzero
rejection/diagnostics, no success line, and no run/authority call.

- [ ] **Step 2: Verify CLI RED**

```sh
npm --workspace @koni/core test -- --run test/operator-surface.test.ts -t "initializes"
```

Expected: default selector may already pass, but automatic-validation assertions fail because CLI
currently returns after install.

- [ ] **Step 3: Route CLI init through shared authority**

Extend `KoniCliDependencies` with one `initialize` dependency whose default is
`initializeProjectProfile`, or adapt install/validate through the shared operation without
duplicating its logic. Keep default selector `coding` and
`path.resolve(parsed.root ?? process.cwd())`. Print installed profile, canonical project root, file
counts, and validated configuration SHA. Update help to show:

```text
koni init [coding|research] [--profile-package PATH] [--root PATH]
  Defaults: coding profile, current directory; validates before success.
```

- [ ] **Step 4: Run the full operator surface suite and static checks**

```sh
npm --workspace @koni/core test -- --run test/operator-surface.test.ts
npm --workspace @koni/core run typecheck
npx eslint packages/core/src/cli.ts packages/core/test/operator-surface.test.ts
npx prettier --check packages/core/src/cli.ts packages/core/test/operator-surface.test.ts
git diff --check
```

- [ ] **Step 5: Commit Task 3**

```sh
git add packages/core/src/cli.ts packages/core/test/operator-surface.test.ts
git commit -m "feat(core): make bare init validated coding setup"
```

---

### Task 4: Same-conversation Pi guided initialization

**Files:**

- Modify: `packages/core/src/extension.ts`
- Modify: `packages/core/test/pi-companion-extension.test.ts`
- Modify: `packages/core/test/monitor-run-intake.test.ts`
- Modify: `packages/core/src/monitor/run-intake.ts`

**Interfaces:**

- Consumes `initializeProjectProfile` from Task 2.
- Uses Pi 0.80.10
  `ExtensionAPI.sendUserMessage(content, { deliverAs?: "steer" | "followUp" }): void`.
- Produces the exact Configure handoff prompt:

```text
Use $configure-koni to inspect this initialized repository, propose the smallest evidence-backed project configuration, wait for my approval before editing, and validate the complete configuration after applying approved changes. Do not create a run.
```

- [ ] **Step 1: Extend the Pi harness and write failing guided-init tests**

Capture `sendUserMessage` calls in `extensionHarness`. Invoke `/koni init` with no argument and
assert Coding selection, installation, automatic validation, one informational notification, then
exactly one Configure handoff message. Assert no `ensure`, `createRun`, run-intake connector,
monitor authority start, or model loading occurs as part of handoff.

Add separate cases for explicit Research, failed initialization, invalid validation, and
`sendUserMessage` failure. Configure must not start after initialization/validation failure. A
handoff failure must report an actionable error while preserving the valid initialized result.

- [ ] **Step 2: Verify Pi guided-init RED**

```sh
npm --workspace @koni/core test -- --run test/pi-companion-extension.test.ts -t "init"
```

Expected: FAIL because `/koni init` currently may prompt for a profile and never injects Configure.

- [ ] **Step 3: Implement default initialization and Configure handoff**

Replace interactive default profile selection with `coding` when no argument is supplied. Resolve
explicit selectors as before. Call the shared initialization authority. Notify the validated
profile/configuration identity, call `pi.sendUserMessage` once with the exact prompt, and do not
mount/start the monitor merely because initialization succeeded. The next explicit `/koni`,
`/koni-run`, or shell command remains the run-control boundary.

- [ ] **Step 4: Tighten uninitialized guidance and passivity tests**

Change user guidance from profile-required syntax to bare-init-first wording:

```text
Koni is not initialized in this repository. Run `koni init` or `/koni init`, then retry.
```

Prove an uninitialized trusted session registers the bootstrap command but performs no
inspect/autostart/monitor/model/run work until the operator invokes it. Preserve untrusted-session
noninterference.

- [ ] **Step 5: Run Pi/component suites and static checks**

```sh
npm --workspace @koni/core test -- --run test/pi-companion-extension.test.ts test/monitor-run-intake.test.ts
npm --workspace @koni/core run typecheck
npx eslint packages/core/src/extension.ts packages/core/src/monitor/run-intake.ts packages/core/test/pi-companion-extension.test.ts packages/core/test/monitor-run-intake.test.ts
npx prettier --check packages/core/src/extension.ts packages/core/src/monitor/run-intake.ts packages/core/test/pi-companion-extension.test.ts packages/core/test/monitor-run-intake.test.ts
git diff --check
```

- [ ] **Step 6: Commit Task 4**

```sh
git add packages/core/src/extension.ts packages/core/src/monitor/run-intake.ts packages/core/test/pi-companion-extension.test.ts packages/core/test/monitor-run-intake.test.ts
git commit -m "feat(core): guide Pi initialization into Configure"
```

---

### Task 5: End-user documentation and exact package smoke

**Files:**

- Modify: `README.md`
- Modify: `docs/getting-started.md`
- Modify: `docs/profile-lifecycle.md`
- Modify: `docs/control-center.md`
- Modify: `packages/core/README.md`
- Modify: `packages/coding-profile/README.md`
- Modify: `packages/research-profile/README.md`
- Modify: `scripts/pi-package-smoke.test.mjs`

**Interfaces:**

- Consumes the packed Core lifecycle adapter and both initialization surfaces.
- Produces the canonical public quickstart:

```sh
pi install npm:@koni/core
pi install npm:@koni/coding-profile
cd /path/to/project
koni init
```

- [ ] **Step 1: Write a failing package-smoke boundary for global discovery**

In a disposable agent/project/Pi installation, install the exact Core and Coding tarballs with stock
`pi install`. Preserve the pre-install PATH bytes. Spawn a fresh shell using that unchanged PATH and
assert:

```js
assert.equal(await commandOutput("koni", ["--version"], freshEnvironment), "1.0.0");
assert.equal(existsSync(path.join(project, ".koni")), false);
```

Then invoke bare `koni init` from the clean Git project and assert Coding profile identity,
successful automatic validation, no run state, and project-local pinned Superpowers settings.

- [ ] **Step 2: Verify package-smoke RED through visible cmux**

Build fixed archives once, then launch only this exact smoke through left cmux `surface:2` with the
runtime/version/hash banner visible.

Expected: FAIL because `koni` is not discoverable on the unchanged PATH and bare init does not yet
expose validated output.

- [ ] **Step 3: Extend smoke coverage for guided Pi init and passivity**

Use the existing installed Pi command-handler probe. In a second clean project, invoke `/koni init`
without a profile, wait for the Configure user-message turn, and assert the conversation contains
the exact Configure contract and remains at its approval boundary. Assert no run ID, authority run
state, or provider attempt is created by initialization.

Retain the real TUI and installed handler boundaries; do not replace them with direct source
imports.

- [ ] **Step 4: Add packed update/uninstall launcher audits**

Exercise same-version install, a test-owned second Core generation, stale old-generation uninstall,
current uninstall, and unrelated target collision. Assert exact marker/launcher identity, old/new
command version, Pi settings, credentials, and absence of package bytes after current uninstall.
Restore no shell profile because none was changed.

- [ ] **Step 5: Rewrite end-user documentation**

Remove the PATH export from the published install flow. Clearly separate:

- end users: `pi install` then bare `koni init`;
- existing projects: stop, `pi update`, reload Pi, `koni update`, explicit resume;
- maintainers: `scripts/install-dev.sh`;
- optional Research installation and explicit `koni init research`.

Document that global packages are passive outside initialized repositories and `/koni init` enters
guided configuration without creating a run.

- [ ] **Step 6: Run documentation and focused package checks**

```sh
npm run test:docs
npm run check:brand
npm run test:pi-host-boundary
npx prettier --check README.md docs/getting-started.md docs/profile-lifecycle.md docs/control-center.md packages/core/README.md packages/coding-profile/README.md packages/research-profile/README.md scripts/pi-package-smoke.test.mjs
git diff --check
```

- [ ] **Step 7: Commit Task 5**

```sh
git add README.md docs/getting-started.md docs/profile-lifecycle.md docs/control-center.md packages/core/README.md packages/coding-profile/README.md packages/research-profile/README.md scripts/pi-package-smoke.test.mjs
git commit -m "docs: make Pi install the canonical Koni quickstart"
```

---

### Task 6: Review, full verification, reseal, and visible qualification

**Files:**

- Modify only files required by review findings.
- Create ignored SDD evidence reports under
  `.superpowers/sdd/2026-08-20-koni-v1-autonomous-release-hardening/`.

**Interfaces:**

- Consumes all Task 1–5 commits.
- Produces reviewed sealed Core/Coding/Research archives and exact visible qualification evidence.

- [ ] **Step 1: Run a structured implementation review**

Review launcher ownership/recovery, npm/Pi lifecycle integration, public API stability, CLI
compatibility, Pi conversational behavior, passivity, and smoke fidelity. Treat any unauthenticated
overwrite/removal, temp-package launcher binding, shell-profile mutation, skipped validation, or
implicit run creation as Important or Critical.

- [ ] **Step 2: Address review findings test-first**

For every accepted finding: write a mutation-catching RED, run it, implement the smallest general
fix, rerun GREEN, and commit the fix separately. Re-review until no Critical or Important finding
remains.

- [ ] **Step 3: Run static and focused gates**

```sh
npm run format:check
npm run lint
npm run lint:shell
npm run typecheck
npm run test:docs
npm run check:brand
npm run test:architecture
npm run test:profiles
npm run test:pi-host-boundary
npm --workspace @koni/core test -- --run test/global-launcher-installation.test.ts test/project-initialization.test.ts test/operator-surface.test.ts test/pi-companion-extension.test.ts test/monitor-run-intake.test.ts
git diff --check
```

Expected: all exit 0 with no skipped required boundary.

- [ ] **Step 4: Run the complete repository gate twice only after focused GREEN**

Run through left cmux `surface:2`:

```sh
npm run check
npm run check
```

Both runs must use the same commit and fixed archive hashes. Record Core/Research totals, runtime,
exit status, and cleanup audit. Stop on the first deterministic RED; do not loop or raise timeouts.

- [ ] **Step 5: Qualify exact packed installs on Node 22 and Node 24**

Build each archive once from the reviewed candidate. Through visible `surface:2`, run two clean
sequential exact package rehearsals on Node 22.19 and two on Node 24.16. Each rehearsal must prove:

- stock global `pi install`;
- `koni` discovery from an unchanged fresh-shell PATH;
- project passivity before init;
- bare Coding initialization plus automatic validation;
- guided `/koni init` Configure handoff;
- installed real TUI operation;
- update/uninstall ownership cleanup; and
- no disposable root or process leak.

- [ ] **Step 6: Final evidence and handoff**

Record candidate commit/tree, archive hashes, Node/npm/Pi versions, every counted run, honest
diagnostic REDs, launcher marker identities, project-state audits, and remaining known issues.
Confirm:

```sh
git status --short
git diff --check
```

Expected: tracked worktree clean and no qualification process remains. Do not publish packages,
merge, push, deploy, or tag without separate operator authorization.
