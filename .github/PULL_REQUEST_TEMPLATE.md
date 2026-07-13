## Summary

<!-- What user or maintainer problem does this change solve? -->

## Design

<!-- Why does this behavior belong in this engine/profile/UI/docs boundary? -->

## Public interface and migration

<!-- Describe command, schema, state, Git, or compatibility effects. Write "None" when none. -->

## Validation

- [ ] `cargo fmt --all -- --check`
- [ ] `cargo clippy --workspace --all-targets -- -D warnings`
- [ ] `cargo test --workspace`
- [ ] Affected profiles or docs site were validated

## Safety checklist

- [ ] Agents do not gain authority over compiler-owned state or publication
- [ ] New effects have containment, receipts, failure journaling, and recovery
- [ ] Existing run snapshots remain immutable
- [ ] Documentation and tests cover user-visible behavior
- [ ] No credentials, private prompts, or proprietary fixtures are included
