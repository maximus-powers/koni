# Pi cutover consistency

## Status and lease

`integrated_by_pi-runtime-architect/root` — the delegated audit found a release-blocking live-root
gap and assembled the core repair before its agent session ended. The primary integrator owns the
final tests and any follow-up fixes.

Owned review surface: schema-2 catalog discovery, immutable configuration snapshots, new-run
planning, fresh CLI installation, Configure/TUI root selection, and documentation statements about
the live `.koni` authority. Historical schema-1 migration readers remain intact.

## 2026-07-14 decisions

- An existing real `.koni` directory is the only live catalog authority. It never falls back to a
  coexisting `.codex/koni`; a malformed or redirected `.koni` fails closed.
- Catalog, run-type, and profile schema generations must agree. `.koni` requires `2.0`, while an
  explicitly compiled `.codex/koni` migration input remains `1.0`.
- A schema-2 run snapshot contains `.koni` plus repository `.agents/skills` and never imports
  `.codex/config.toml` or `.codex/agents`. Codex projection/exclusion helpers are disabled for such
  snapshots.
- Fresh bundled schema-1 templates are converted in private installer staging through
  `Schema2Migrator::convert_fresh_install`; only the validated `.koni` tree and owned repository
  skills are published. No executable Codex agent resource reaches the destination project.
- Existing schema-1 projects still require the explicit `migrate-pi` transaction. Active Codex
  runs retain the permanent archive disposition; unrelated `.codex` content remains untouched.
- Configure/TUI chooses `.koni` when present and omits Codex-native configuration/agent documents
  from schema-2 drafts and validation roots.

## Verification owned by the primary integrator

The delegated lane reported `cargo check -p koni-core --lib` and `cargo check -p koni-cli` green
before its session ended. Final integration adds/runs focused proofs for schema-2 catalog
precedence, snapshot exclusion and symlink rejection, fresh init -> new run, and migration -> new
run. Exact final results are recorded in `pi-runtime-architect.md`.

