# `@koni/core`

`@koni/core` is Koni's single authoritative Pi extension package. It owns the typed profile and
graph compiler, durable workflow state, ticket scheduling, grants, receipts, Git effects, native
Pi integration, and the shared control-center view model.

Coding and research behavior are supplied by separately versioned profile packages. Those
packages can describe resources, but they cannot authorize effects or mutate Koni state.
