# `@koni/coding-profile`

This Pi package carries Koni's default coding profile: its typed graph, rules, operations,
workflows, run types, personas, agent instructions, and profile-selected skills.

Its extension only advertises an immutable profile bundle to `@koni/core`. Installing or updating
the npm package does not silently adopt new defaults into an existing project. Core materializes the
selected baseline and preserves project edits through explicit three-way upgrades.

Initialize it with `koni init coding`. Small, Medium, Large, New Feature, and Bug Fix are complete
run-type peers inside this one broad profile package, not separately installed runtime extensions.
Any staged upstream change is compared with the project version before the operator resolves it.

> Release transition (2026-07-18): Coding `0.8.0` publishes the reviewed Pi-native defaults and an
> authenticated, preview-required retirement from the exact official `0.7.0` bundle. Project edits
> remain overlay-owned. The release never replaces a customized `.koni` tree wholesale.
