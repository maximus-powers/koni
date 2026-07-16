# `@koni/coding-profile`

This Pi package carries Koni's default coding profile: its typed graph, rules, operations,
workflows, run types, personas, agent instructions, and profile-selected skills.

Its extension only advertises an immutable profile bundle to `@koni/core`. Installing or updating
the npm package does not silently adopt new defaults into an existing project. Core materializes
the selected baseline and preserves project edits through explicit three-way upgrades.
