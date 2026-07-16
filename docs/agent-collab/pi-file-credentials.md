# Pi file credentials

## Ownership

- Scope: `crates/koni-core/src/pi_credentials.rs`, the credential-service backend names, and dependency cleanup needed for this storage transition.
- Goal: replace executable-identity-sensitive platform secret-store access with a Koni-owned, UID-stable `~/.koni/auth.json` store while preserving the private fd3 broker and OAuth-only boundary.
- Non-goals: no login/logout invocation, no installed-binary or cockpit changes, no import from Pi's own credential file, and no project-specific credential configuration.

## Current decision

- Resolve the account home from the OS user database, not the project or process environment.
- Keep the existing UID-global cross-process lock and revision/CAS contract.
- Open the Koni directory and credential file with no-follow directory-relative operations; require owner-only directory/file modes; use bounded reads and same-directory atomic replace plus file/directory fsync.
- Tests use an injected private path only; production exposes no path override.

## Status

- Complete and ready for integration review.
- Production path is `~/.koni/auth.json`, with the home resolved from the OS account database rather than `HOME`, project configuration, or executable location.
- Storage writes use an owner-only same-directory temporary file, file fsync, atomic rename, and directory fsync. Reads are capped at 64 KiB. The final directory/file are checked as owned, no-follow `0700`/`0600` filesystem objects.
- The existing `/tmp` UID-global advisory lock remains the cross-process serialization boundary; commits and deletes re-read the persistent revision as a CAS guard.
- The fd3 lease/intent protocol and OAuth-only material validation are unchanged. Backend names now say file/account storage rather than platform keychain.

## Verification

- `cargo test -p koni-core pi_credentials::tests --lib`: 11 passed, 0 failed (normal parallel execution).
- `cargo test -p koni-core pi_ --lib`: 61 passed, 0 failed.
- `cargo test -p koni-core pi_credential_service::tests --lib`: 7 passed, 0 failed.
- `cargo clippy -p koni-core --lib --tests -- -D warnings`: passed.
- No authentication command was run and neither Koni's production credential path nor Pi's credential path was read or mutated by these tests.
