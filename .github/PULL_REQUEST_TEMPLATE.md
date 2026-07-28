## Summary

<!-- What user or maintainer problem does this change solve? -->

## Design

<!-- Why does this behavior belong in this Core, profile, UI, or documentation boundary? -->

## Public interface and migration

<!-- Describe command, schema, state, Git, or compatibility effects. Write "None" when none. -->

## Validation

- [ ] `npm run check`
- [ ] Exact package smoke ran when shipping, installation, or session behavior changed
- [ ] Affected profile manifests were regenerated and verified

## Safety checklist

- [ ] Agents do not gain authority over compiler-owned state or publication
- [ ] New effects have containment, receipts, failure journaling, and recovery
- [ ] Existing run snapshots remain immutable
- [ ] Documentation and tests cover user-visible behavior
- [ ] The change contains no credentials, private prompts, or proprietary fixtures
