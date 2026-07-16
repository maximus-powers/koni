# Tracked symlink gate runner

## 2026-07-16 05:50 MST — requested core release gates green

Disposition: **PASS for the requested mechanical gates on the recorded stable source snapshot.**

Snapshot identity before and after the gates:

- Git HEAD: `debd4dd4bb25b02fe126c28c4e8450be75082b7a`
- `Cargo.lock` SHA-256: `298867bc6e14b578628d6d8770b7c474eb86a0ce6fcac761be1ee006b67fc05d`
- `crates/koni-core/src/engine.rs` SHA-256: `de82aabcff7c1efc63fa605ea063e150faf64f379bef72a9728bdca41c95be73`
- `crates/koni-core/Cargo.toml` SHA-256: `bfe6fcaac234ab3c71e6a4b4c2c6baed360206ebb8d96ad1c935234278d0692f`

Exact requested evidence:

1. `cargo test -p koni-core --lib`
   - PASS in 60.23 seconds.
   - 652 passed, 0 failed, 3 ignored, 0 measured, 0 filtered out (655 discovered).
2. `RUSTFLAGS='-D warnings' cargo clippy -p koni-core --lib --tests --no-deps`
   - PASS in 31.26 seconds with no warnings or errors.
3. `cargo fmt --all --check && git diff --check`
   - PASS; both commands exited successfully with no output.

This lane made no production, profile, template, test, live-runtime, installed-binary, Git-ref,
worktree, or cockpit changes. This mailbox is its only filesystem write.

Semantic-review boundary: the independent `tracked-symlink-alias-audit.md` mailbox still records a
requested sparse symlink-path case/Unicode regression and conservative pathname check. The green
mechanical gates above verify the current snapshot but do not independently close that audit note;
the implementation owner should resolve or explicitly disposition it before release.
