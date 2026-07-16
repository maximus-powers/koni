# Credential upgrade and Pi-storage audit

- Owner: `credential-upgrade-audit/root`
- Status: `review_complete` — root cause and storage recommendation released to the primary
  integrator
- Started: 2026-07-14 America/Phoenix
- Exact lease: read-only inspection of Koni's credential broker, the pinned keyring/Apple adapter,
  macOS code identities, and Pi 0.80.7's primary auth-storage source. This mailbox is the only
  write.
- Explicit exclusions honored: no credential value was read or exposed; no Keychain, auth file,
  login/logout, project, Updog, process, binary, install, or source state was mutated.

## Verdict

The upgrade failure is an expected consequence of the **legacy macOS login-Keychain ACL chosen by
the current `keyring` backend**, combined with Koni's ad-hoc linker signatures. It is not evidence
that the credential is corrupt, tied to a project, or missing from the per-user store.

`keyring` creates a generic-password item without an explicit `SecAccess` object. Apple therefore
applies default access which trusts only the calling application for restricted operations. The
binary which created the current item and both replacement binaries have different ad-hoc
designated requirements, each reduced to its own CDHash. Rebuilding at the same
`~/.cargo/bin/koni` pathname does **not** preserve that identity. A stable pathname is not a stable
Keychain principal.

The live shape corroborates the static mechanism:

- the old packaged binary still reports signed-in status in about two seconds;
- a new isolated packaged binary and a rebuilt binary installed at the same
  `~/.cargo/bin/koni` pathname each produced no output for about 32 seconds, then the control
  request timed out;
- macOS `SecurityAgent` appeared during the replacement-binary probe;
- no credential lock or inference activity was intentionally introduced during the quiescent
  retry.

That is the expected shape of an untrusted replacement attempting to read a default-ACL Keychain
item while its containing control request cannot complete the OS authorization interaction.

For the current source-build / frequent-refresh workflow, the least surprising upgrade-stable
choice is a **Koni-owned per-user auth file**, not the shared Pi file and not the current default
Keychain ACL. It should use Pi's provider credential shape and user experience, while retaining
Koni's private Rust-to-host credential bridge:

- private Koni path (for example `~/.koni/auth.json`, with an explicit environment override);
- owner-only `0700` directory and `0600` regular file;
- no-follow/owner/type validation, a single cross-process lock, bounded reads, atomic replacement,
  and directory/file durability;
- only the parent Koni broker reads the file; the contained Pi host still receives the credential
  solely through the private credential channel;
- browser PKCE remains the normal login flow, matching Pi's UX.

Do **not** silently share `~/.pi/agent/auth.json`. Sharing would couple Koni login/logout and token
rotation to standalone Pi, require exact interoperability with Pi's separate `proper-lockfile`
protocol, expose Pi's other provider records to Koni's writer, and make either application able to
invalidate or overwrite the other's session. A symlink is worse for the same reasons. If a future
import is offered, it needs an explicit migration design; copying a rotating refresh credential is
not a safe one-time import because the two copies can diverge after refresh.

Production releases could instead keep Keychain only if every release is signed under one stable,
real designated requirement and the existing item is deliberately migrated to trust that
identity. That does not solve today's `cargo install` workflow: all inspected binaries are
ad-hoc/linker-signed, so every content change produces a new CDHash requirement. A hybrid
"Keychain for signed builds, file for development builds" would create two invisible login states
and is less predictable than one documented Koni-owned store.

## Evidence

### 1. Koni keys one legacy-Keychain item globally per user/provider

`crates/koni-core/src/pi_credentials.rs:25-29,128-178` fixes the provider to
`openai-codex`, service to `dev.koni.pi.oauth`, takes one UID-global five-second transaction lock,
then constructs `keyring::Entry(service, provider)` and calls `get_secret`. The path of the Koni
binary and the project directory are not part of the lookup key. The same module updates the
entry through `set_secret` at lines 236-259.

This means the old and new binaries are addressing the same per-user item. The differing outcome
must arise below the service/account lookup or in the surrounding process, not from a new project
namespace.

### 2. `keyring` 4.1.5 delegates to the legacy login Keychain with default application access

The workspace pins `keyring = 4.1.5`. Its default macOS feature selects
`apple-native-keyring-store` 1.0.1's `keychain` store. That adapter:

- uses the User/login Keychain by default;
- reads through `SecKeychainFindGenericPassword`;
- writes through `SecKeychain::set_generic_password`;
- creates a missing entry with `SecKeychainAddGenericPassword`, passing no explicit access object.

The relevant primary source is the locally pinned
`apple-native-keyring-store-1.0.1/src/keychain.rs:69-92,347-373` and
`security-framework-3.7.0/src/os/macos/passwords.rs:269-303`.

Apple's `SecAccessCreate` documentation states that when an application does not explicitly set an
access instance, Keychain Services uses the default access; for restricted operations, a nil
trusted list contains **only the calling application**. Apple's
`SecTrustedApplicationCopyData` documentation further states that trusted-application data can
include a cryptographic hash and is used to verify that the app has not changed. This is exactly
the ACL behavior exercised by the adapter above.

Primary references:

- <https://developer.apple.com/documentation/security/secaccesscreate%28_%3A_%3A_%3A%29>
- <https://developer.apple.com/documentation/security/sectrustedapplicationcopydata%28_%3A_%3A%29>

### 3. Every inspected development binary is a different Keychain application identity

Read-only `codesign` inspection found:

| Binary | Signing form | Designated requirement |
| --- | --- | --- |
| old acceptance package | ad-hoc, linker-signed | `cdhash 34ecce460c6d678814bacdc6cc5ee0284b4b25a8` |
| later isolated package | ad-hoc, linker-signed | `cdhash d88704abc8e95ca8062b845040d42b58860cb522` |
| current `~/.cargo/bin/koni` at inspection time | ad-hoc, linker-signed | `cdhash b1021094412eea337cc0b3405e6a6a5217eb522b` |

All use the same linker-generated identifier, but their designated requirements are the distinct
CDHashes. Apple describes a designated requirement as the criterion used to decide whether code is
the same code previously seen. For an ad-hoc binary here, the observed criterion is the exact
content-derived CDHash, not the filename or install path.

Primary reference:

- <https://developer.apple.com/documentation/security/applying-code-requirements>

Therefore a new build installed over `~/.cargo/bin/koni` should **not** be expected to reuse this
default-ACL credential without a new OS trust decision. A properly Developer-ID-signed release can
have a stable certificate/identifier-based designated requirement across versions; the current
ad-hoc cargo binaries do not.

### 4. Pi 0.80.7 is upgrade-stable because its auth identity is a file path, not its executable

The runtime lock pins `@earendil-works/pi-ai` 0.80.7. The matching Pi coding-agent 0.80.7 primary
source implements `AuthStorage.create()` with a `FileAuthStorageBackend` at
`~/.pi/agent/auth.json`. It creates the parent as `0700`, creates/writes the file as `0600`, and
serializes OAuth refreshes with `proper-lockfile`. The record is keyed by provider and the
`openai-codex` value is the same logical OAuth shape Koni already validates (`type`, `access`,
`refresh`, `expires`, plus provider metadata).

Primary pinned sources:

- <https://raw.githubusercontent.com/badlogic/pi-mono/v0.80.7/packages/coding-agent/src/core/auth-storage.ts>
- <https://raw.githubusercontent.com/badlogic/pi-mono/v0.80.7/packages/coding-agent/src/config.ts>

Because the file belongs to the user rather than an executable ACL, Pi upgrades do not change who
can open it. The tradeoff is explicit: Pi's credential is plaintext at rest to processes with that
user's filesystem authority, while Koni's current Keychain item is encrypted and app-ACL-gated.
The proposed Koni-owned file chooses Pi-like upgrade behavior, but should retain Koni's stronger
path validation, private runtime channel, and contained project-tool boundary.

### 5. Login UX and storage ownership are separable

Pinned `pi-ai` 0.80.7 presents **Browser login (default)** and **Device code login (headless)**.
The browser path uses PKCE and a localhost callback, then hands the resulting credential to its
caller-provided store. Koni can and should mirror that normal browser flow without sharing Pi's
auth path. Browser UX answers "how the user authenticates"; storage ownership answers "which
application can rotate or delete the resulting session." They do not need to be the same choice.

Local primary source:

- `runtime/pi-host/node_modules/@earendil-works/pi-ai/dist/utils/oauth/openai-codex.js`

## Safe transition recommendation

1. Freeze writes to the legacy Keychain backend while implementing the Koni-owned store; do not
   delete or rewrite the existing item during development.
2. Add the hardened Koni-owned path/backend and exact permission/symlink/ownership/concurrency/
   crash-consistency tests. Preserve the existing credential protocol and redaction boundary.
3. Treat the first browser login into the new backend as explicit reauthentication. Do not copy or
   print the old credential, and do not auto-import Pi's file.
4. Prove the same credential status works before and after replacing a binary at the same install
   path, and that two Koni processes serialize one refresh without lost updates.
5. After a separately reviewed migration window, offer an explicit cleanup path for the legacy
   item. Never remove it as a side effect of status, install, or upgrade.

This transition optimizes for the user's active frequent-rebuild workflow while keeping the
credential out of project state and out of the contained model/tool process. If the product later
ships stable Developer-ID-signed binaries and wishes to return to Keychain, that should be a
deliberate backend migration with one visible auth state, not an implicit difference between dev
and release builds.
