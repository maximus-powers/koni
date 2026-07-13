# Migration

Köni includes a one-time migration for projects configured by its predecessor.
The old name appears in this document only where it identifies a literal path
or namespace that the migration must recognize.

## What is detected

When `.codex/koni/` is absent, `koni init` checks for the legacy
`.codex/pythagoras/` directory. It also inventories native Codex resources
listed in that installation's ownership manifest.

Migration does not maintain two live layouts. A successful project uses only
the Köni configuration and namespace going forward.

If both `.codex/koni/` and the legacy directory exist, initialization refuses
to guess which is authoritative. Reconcile or archive one layout explicitly,
then rerun the dry run.

## Preview first

From the project:

```sh
koni init --dry-run
```

The preview reports:

- the discovered project root;
- the selected profile;
- whether `.codex/` would be created;
- whether a current or legacy installation exists;
- whether replacement was requested.

Dry-run does not write a receipt, backup, configuration, branch, or Git ref.
It is an orientation step, not full validation; the real transaction performs
validation before publication.

## Migration transaction

Run the normal initializer when the preview is clean:

```sh
koni init
```

Köni then:

1. reads the legacy tree without modifying it;
2. converts known catalog, profile, resource locator, and branch-template
   identifiers in a staging directory;
3. preserves the original bytes beneath
   `.codex/.koni-migrations/<timestamp>/`;
4. compiles and validates the staged Köni project with its native agents and
   skills;
5. publishes `.codex/koni/` and owned native resources atomically;
6. writes a migration receipt identifying the migration and backup.

Validation or publication failure rolls the project back to its exact
pre-migration state. A failed staging directory is not treated as an installed
project.

## Conflicts

Migration stops when:

- old and new live configuration trees both exist;
- an installed native agent or skill collides with an unowned project resource;
- an owned resource changed since its recorded hash;
- a source path is a redirected symlink or escapes the project;
- configuration conversion leaves a dangling reference or invalid profile;
- a source filename collides after conversion.

Do not use `--replace` to silence an ownership problem you have not inspected.
Move intentional project customizations into a distinct resource or incorporate
them into the converted profile, validate, and retry.

## Legacy profile format

Köni can present a legacy TOML profile through a synthesized `legacy` run type
long enough to stage an explicit conversion. That adapter is a compatibility
surface, not the recommended authoring format.

The control center's migration action creates a canonical YAML catalog, run
type, and profile draft. Review the draft and publish it through the same
complete validation transaction used by Configure. Existing pinned runs keep
their snapshots; future runs use the canonical catalog.

## After migration

Verify the project and inspect the resulting resources:

```sh
koni validate-profile .
koni
```

Then:

1. review `.codex/koni/project.yaml` and its default run type;
2. start a new Codex chat so project skills are rediscovered;
3. create a dry, narrow planning run and review its pinned snapshot;
4. keep the migration backup until the new configuration has been exercised;
5. commit project-owned configuration when it is intended to be shared.

The initializer migrates project configuration and its owned native resources;
it does not guess at active run directories, worktrees, or Git refs. Do not
rename those resources manually. Conclude or archive legacy active runs, then
create new work through Köni.
