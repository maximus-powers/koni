# Global Pi installation and guided project initialization

**Date:** 2026-08-21

## Objective

Make the published Koni packages installable globally through Pi while keeping Koni passive in every
repository until that repository is explicitly initialized. After installation, `koni` must be
available from any ordinary terminal that can already run `pi`, without a PATH export or a second
package-manager installation.

The default project flow becomes:

```sh
pi install npm:@koni/core
pi install npm:@koni/coding-profile
cd /path/to/project
koni init
```

The equivalent guided Pi flow becomes:

```text
/koni init
```

## User-visible contract

### Global installation

`pi install npm:@koni/core` installs Core into Pi's user package closure and atomically publishes a
Koni-owned launcher beside the resolved globally available `pi` executable. That directory is
already on the invoking user's PATH, so a fresh ordinary shell can invoke `koni` without additional
configuration.

The launcher resolves the exact Pi-managed Core package that published it. It retains the existing
active-installation generation and runtime-integrity checks: a stale Pi session or authority cannot
silently launch a different Core generation.

Installation must fail closed when:

- the resolved `pi` command is ambiguous or its executable directory is not writable;
- the target `koni` path contains an unrelated file or a launcher Koni cannot authenticate;
- package activation or launcher publication is interrupted and cannot be recovered exactly; or
- multiple current Core origins are visible.

The failure explains the exact conflict and leaves the prior launcher and Pi settings unchanged.
Koni never edits shell startup files.

Updates atomically replace only the authenticated Koni-owned launcher. Pi 0.80.10 delegates removal
to npm, and npm 11 does not invoke package uninstall hooks, so Core cannot remove an external
launcher during `pi remove` without changing Pi. The launcher therefore remains a small,
authenticated executable rather than a broken package-target link. Its first invocation after Core
removal authenticates and displaces only its own public path and ownership marker, then reports the
exact reinstall command. It never deletes an unrelated or newer launcher.

Coding and Research profiles remain separate Pi packages. Coding is required for the default
initialization path; Research is optional.

### Passive installation boundary

A global package installation does not initialize, configure, or create state in the current
repository. Outside a valid initialized Git worktree, Core exposes only installation help and the
bootstrap initialization surface. Run intake, the control center, project agents, and authority
startup continue to fail closed with an initialization instruction.

No `.koni`, `.pi`, Git refs, worktrees, authority state, or run state is written until the operator
invokes project initialization.

### Shell initialization

`koni init` has these defaults:

- profile: `coding`;
- root: the current working directory; and
- postcondition: the complete effective configuration validates successfully.

Existing explicit forms remain compatible:

```sh
koni init coding
koni init research
koni init --root /path/to/project
koni init research --root /path/to/project
```

Initialization remains idempotent and creates no run or commit. It stages and authenticates the
profile, publishes the managed project configuration through the existing crash-forward lifecycle,
resolves the required pinned Pi package entry, and runs the same authoritative configuration
validation used by `koni config validate`. The command reports success only after validation passes.
If validation fails, it reports the diagnostics and does not claim a usable installation; existing
transaction recovery semantics remain authoritative.

An initialized project continues to use `koni update`, not `koni init`, for later baseline upgrades.
Ambiguous or unmanaged historical state remains an explicit operator reconciliation boundary.

### Pi-guided initialization

In an ordinary Pi chat, `/koni init` invokes the same initialization authority with the same Coding
and current-directory defaults. After authoritative initialization and validation succeed, the
command starts the installed `configure-koni` workflow in the same conversation.

The guided workflow:

1. inspects the initialized profile and repository-owned evidence;
2. proposes project-specific models, run types, workspace bootstrap, checks, graph rules, and
   resources;
3. waits for explicit user approval before editing project configuration;
4. applies approved edits through configuration authority rather than direct YAML writes; and
5. validates the complete effective configuration again.

The handoff creates no run. Run creation and plan approval remain separate explicit operator
actions. If initialization or validation fails, Configure is not started. If Configure cannot start,
the initialized and validated project remains usable and Pi returns an actionable error without
rolling back an otherwise valid installation.

Explicit `/koni init research` remains available when the Research package is installed.

## Architecture

### Package-owned launcher activation

Core adds a small installation-lifecycle entry point used by its npm installation hook. It resolves
the real `pi` command visible to the installing process, derives its executable directory, and
publishes a platform-appropriate self-cleaning launcher there:

- POSIX: an atomic executable launcher file named `koni`;
- Windows: a command shim containing the same authenticated launcher bootstrap.

Launcher ownership is recorded in a bounded, authenticated marker under Pi's agent-owned Koni state.
The marker binds protocol version, launcher path and digest, exact Core package root, launcher
target, and package identity. Publication uses an adjacent temporary path plus atomic rename. The
journal records the exact old-launcher displacement path before moving it. Recovery accepts an
npm-style replacement at the same package root when the new target, old launcher, marker, and
journal all authenticate, and handles interruption before and after launcher replacement without
inferring ownership from a bare filename.

This extends the existing development activation model rather than creating a second Koni
installation. The Pi-managed package remains the only package closure; the global launcher is only
an authenticated entry point into those exact bytes.

### Shared initialization authority

CLI and Pi extension handlers call one shared initialization operation. Default resolution happens
at the boundary:

- omitted profile becomes `coding`;
- omitted root becomes `process.cwd()` or the Pi session root.

The shared operation performs profile installation followed by authoritative configuration
validation and returns a typed result containing installed profile identity, root, configuration
hash, effective bundle hash, and diagnostics.

The CLI formats that result and exits. The Pi handler uses the successful result to enqueue the
installed Configure skill in the current conversation. Neither path duplicates profile lifecycle or
validation logic.

### Compatibility

All existing explicit initialization syntax and lifecycle APIs remain supported. Published package
names, profile manifests, `.koni` schemas, active authority state, and project upgrade semantics do
not change.

The documentation presents `pi install` plus `koni init` as the end-user path. `install-dev.sh`
remains a maintainer-only source-checkout path and must exercise the same launcher ownership
contract.

## Failure and recovery semantics

- Launcher installation never overwrites an unauthenticated target.
- Interrupted activation recovers to either the authenticated old generation or authenticated new
  generation; it never leaves a mixed package/launcher state.
- Project initialization does not start Configure until validation succeeds.
- Configure failure does not misreport initialization failure or create a run.
- Repeated `koni init` on the same current Coding installation is idempotent.
- Missing Coding or Research profile packages produce an exact install instruction.
- Uninitialized repositories remain free of Koni project state until explicit initialization.

## Verification strategy

### Launcher lifecycle

Package-level tests install packed artifacts through stock Pi, start a fresh shell with the original
PATH, and invoke `koni --version` and `koni init` without a PATH export. Mutation-sensitive cases
cover:

- fresh install;
- same-generation reinstall;
- upgrade to a new generation;
- uninstall of the owning generation;
- interrupted publication and recovery;
- unrelated target collision;
- stale-generation uninstall after a newer activation;
- unwritable Pi executable directory;
- ambiguous/multiple Pi installations; and
- POSIX and Windows launcher forms.

The tests assert exact target identity, ownership marker hashes, Pi-settings preservation,
credential noninterference, and absence of a second package closure.

### Initialization

CLI tests prove:

- bare `koni init` selects Coding and the current directory;
- explicit Coding, Research, and root arguments retain their behavior;
- validation runs automatically and a validation failure is nonzero and diagnostic;
- no run is created;
- repeated initialization is idempotent; and
- missing profile, unmanaged state, and non-Git roots fail closed.

Pi component tests prove `/koni init` calls the same operation, starts Configure only after a valid
result, preserves the current conversation, waits at Configure's approval boundary, and never
creates a run. Explicit Research selection and Configure-start failure receive separate coverage.

### Release smoke

The exact packed-package smoke installs through stock Pi, invokes `koni` from an unmodified fresh
terminal environment, initializes a clean project with bare `koni init`, completes the guided
`/koni init` Configure handoff in the real Pi TUI, validates project passivity before
initialization, and audits install/update/uninstall cleanup. Final qualification remains visible
through the left cmux terminal on both supported Node versions.

## Non-goals

- Automatically initializing repositories during package installation.
- Editing user shell startup files.
- Creating a run during initialization or configuration.
- Combining Coding and Research into one profile package.
- Changing project profile schemas or provider/model policy.
- Weakening duplicate-Core, runtime-integrity, or promotion safety checks.
