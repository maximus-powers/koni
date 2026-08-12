# Simplify Ticket Status Design

**Date:** 2026-08-10

## Outcome

Koni uses one unambiguous waiting state for tickets: `queued`. The legacy ticket states `todo`,
`ready`, and `failed` are removed end to end. Tickets previously created or returned as `todo` or
`ready` use `queued`; a failed assignment continues to mark its active step as `failed` and places
the ticket in `blocked`, which is already the production scheduler behavior.

This is a clean cutover. The change adds no compatibility alias or migration for old ticket records.

## Run Cleanup

Before changing the durable ticket type, delete all five existing smoke-test runs through Koni's
run-deletion authority:

- MUAT: `run-6723c8fc-e17b-412c-a8c6-434c24d3e5af`
- MUAT: `run-69b251cf-056f-4923-88f1-39a05dd3e43b`
- MUAT: `run-6dd651cd-35d5-416e-8042-9376352fcae8`
- Updog smoke clone: `run-851c1688-8ec3-4492-9d75-c538d6b22b91`
- Updog smoke clone: `run-a9b634b6-b09b-47a7-9287-e1c1446d1317`

Deletion must retire each run's Koni-managed Git worktrees and refs as well as its authority state.
Repository branches and files outside the Koni run namespaces remain untouched. After cleanup, both
smoke roots must have no run records, Koni run refs, or Koni-managed run worktrees.

## Ticket State Model

`TicketStatus` contains exactly:

- `proposed`
- `queued`
- `running`
- `review`
- `blocked`
- `completed`
- `cancelled`

`queued` means that the ticket is approved and eligible to be admitted when its dependencies, gates,
resources, and concurrency policy allow it. It absorbs all ticket-specific behavior previously
attached to `todo` or `ready`.

Ticket failure is represented by `status: "blocked"` plus a blocker. The failing step remains
`status: "failed"` and retains its immutable attempt and diagnostic evidence.

The following active failure vocabularies are outside this change and remain unchanged:

- ticket-step status
- attempt and provider outcomes
- checks, actions, journals, and settlement outcomes
- planning-revision status
- run lifecycle phase

## End-to-End Vocabulary

The clean rename applies to every ticket-specific boundary:

- the durable `TicketStatus` type and parser;
- configured profile lifecycle state names, initial states, transitions, and retirement rules;
- compiler-created executable, control, and integration tickets;
- scheduler admission and ticket-transition logic;
- authority mutation, recovery, and summary logic;
- control-center protocol and view-model parsing;
- the TUI ticket tab, which is named and labeled `queued`;
- ticket fixtures, test helpers, and public documentation.

Unrelated uses of `ready` are not ticket states and remain unchanged, including authority readiness,
Git readiness, provider/session readiness, transcript events, and ordinary prose where the word does
not name a ticket status.

Remove ticket-level `failed` handling from:

- the durable `TicketStatus` union and ticket parsers;
- configured ticket lifecycle projection;
- scheduler terminal/source predicates;
- authority summaries and monitor/control-center projections;
- control-center protocol validation and ticket presentation;
- tests and fixtures typed as ticket records.

Fixtures that model a failed assignment use a failed step and blocked ticket. Tests for run,
attempt, check, action, planning, or step failure retain `failed` unchanged.

No loader fallback, record migration, deprecated union member, or protocol alias is added. Old run
records containing `todo`, `ready`, or a failed ticket are unsupported because all existing smoke
runs are deleted before activation of the new build.

## Safety and Verification

Implementation follows test-first development. The first focused durable-boundary test must reject
`todo`, `ready`, and `failed` as ticket statuses, accept `queued`, and continue to accept a failed
step on a blocked ticket. Profile tests must prove that configured ticket lifecycles start in and
return to `queued`; scheduler and compiler tests must prove that queued tickets retain the admission
behavior previously split between `todo` and `ready`.

After the production change, run focused store, scheduler, configured-lifecycle, compiler,
authority, protocol, summary, control-center, coding-profile, and research-profile tests, followed
by core typecheck, repository typecheck, and build.

A final reference audit must confirm that no production-code occurrence treats `todo`, `ready`, or
`failed` as a ticket status. Remaining `todo` and `ready` occurrences must be unrelated vocabularies
or historical documentation; remaining `failed` occurrences must belong to one of the explicitly
preserved failure vocabularies above.

No smoke run is resumed, merged, pushed, or published during this cleanup.
