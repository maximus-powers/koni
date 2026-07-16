# Rename Reference Audit

## Lease — 2026-07-14 (`rename-reference-audit/root`)

- **Scope:** read-only audit for exact references to the former harness root after the repository
  moved to `/Users/max/Desktop/koni`.
- **Surfaces:** repository-owned source/docs/config, Desktop-level launch scripts and symlinks,
  discoverable live process/cockpit command lines, Cargo install metadata, and Git remote/config
  metadata.
- **Authority:** this lane may append findings to this mailbox only. It must not edit source,
  configuration, installed binaries, shell state, cmux state, or any Updog project/run/cockpit.
- **Status:** `in_progress`.

## Read-only findings — 2026-07-14

### Clean migration surfaces

- Repository-owned source, documentation, configuration, templates, fixtures, and scripts have
  **zero** remaining exact former-root references. The audit note itself also avoids preserving
  the retired literal so the repository can enforce a strict zero-match invariant.
- Git resolves both the top level and Git directory beneath `/Users/max/Desktop/koni`; the local
  config has no former-root value, and `origin` already names a repository whose basename is
  `koni`.
- Desktop launch/script roots, Desktop symlink targets, shell startup/config surfaces, and cmux
  workspace/tree/process projections have no former-root reference.
- The globally installed `koni` executable, both isolated acceptance executables, and the legacy
  `harness` / `pythagoras` executables contain no embedded former-root literal.
- Generated build/cache remnants discovered during the first scan were removed by the integration
  owner before this handoff; a second repository scan found no remaining project-owned match.

### Actionable operational references

1. Cargo's per-user install registries still record three path-source installs from the former
   root: the legacy `harness-cli`, current `koni-cli`, and legacy `pythagoras-cli` entries. Both
   `~/.cargo/.crates.toml` and `~/.cargo/.crates2.json` carry those stale sources, and all three
   executables still exist in `~/.cargo/bin`.
   - Recommended normalization: uninstall the two legacy packages and reinstall `koni-cli` from
     `/Users/max/Desktop/koni/crates/koni-cli`. Cargo should rewrite its own registries; do not
     hand-edit those files.
2. The current ChatGPT kernel process was launched with its working-directory argument set to the
   former root. No Koni, cmux, cockpit, or Updog worker process carries that argument. This is
   transient parent-process metadata rather than repository state; it should disappear when this
   ChatGPT session/kernel is restarted and must not be "fixed" by terminating the live session
   during integration.

### Boundaries and handoff

- Shell-history and conversation-transcript stores were intentionally not searched or exposed;
  they are private historical records, not launch/config authority.
- No source, configuration, registry, executable, symlink, process, cmux surface, project, run,
  cockpit, or Updog state was changed by this audit.
- **Status:** `ready_for_integration`; the integration owner has the two operational follow-ups
  above. Re-run the exact fixed-string checks after Cargo normalization and after a natural kernel
  restart to establish machine-wide operational zero.

## Integration-owner update — 2026-07-14

The earlier three-entry Cargo inventory remains as discovery history. The integration owner has
since uninstalled `harness-cli` and `pythagoras-cli`: both legacy executables are absent, and each
Cargo registry now has only the current `koni-cli` source entry awaiting the planned reinstall from
`/Users/max/Desktop/koni/crates/koni-cli`. That reinstall is intentionally sequenced after the
active browser-auth patch and tests so the installed binary is one coherent build.

Final read-only counts at this checkpoint are: repository **0**, repository Git metadata **0**,
cmux **0**, Cargo registries **1 current Koni entry each**, and live processes **1** (only this
ChatGPT session's transient kernel launch argument). The latter is non-actionable until the session
restarts naturally. No live process was terminated.

**Final status:** `released_read_only`. Repository rename coverage is complete; the integration
owner retains the already scheduled Koni reinstall, and the current session restart is the only
natural cleanup boundary remaining.

## Final normalization — 2026-07-14

The scheduled Cargo normalization is now complete. Both per-user Cargo registries identify the
current package as `koni-cli v0.1.0 (/Users/max/Desktop/koni/crates/koni-cli)`, and neither legacy
package remains installed. A final fixed-string pass found zero persistent references in the
repository (including Git metadata), Cargo registries, Desktop symlink targets, or generated
project caches. The sole match is still the historical working-directory argument of this live
ChatGPT kernel; it is process-launch history, not Koni state, and will clear on the next natural
session restart.
