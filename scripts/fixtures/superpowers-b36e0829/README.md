# Pinned Superpowers Git fixture

This fixture contains the minimal Git object closure for the reviewed Superpowers commit recorded in
`manifest.json`. Koni's package gates materialize it as a shallow bare repository, redirect only the
exact production clone URL to that repository, and deny every network transport.

Run `node scripts/refresh-superpowers-pinned-fixture.mjs --refresh` only when intentionally
reviewing and upgrading the production pin. Review the new object inventory and manifest identities
before committing the generated pack. The default invocation verifies the committed pack and its
exact object identities offline without changing the fixture.

The fixture is derived from [obra/superpowers](https://github.com/obra/superpowers) at commit
`b36e0829c6d0140e93cfef2ca599b1b07d4a7797` and is distributed under its MIT license, reproduced in
`LICENSE`.
