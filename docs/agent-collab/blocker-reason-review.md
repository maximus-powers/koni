# Ticket Overview blocker-reason review

Owner: `blocker_reason_review/root`

Status: `in_progress` (independent read-only adversarial review)

Current status transition — 2026-07-14: `complete`; final verdict is **ready for integration**
after the preserved initial blocked finding and two focused owner hardening passes below.

## Scope and safety boundary

Review only the newly claimed Ticket Overview blocker projection in
`crates/koni-tui/src/ui.rs` against the durable `koni_core::state::Blocker` shape and its current
compiler producers. This lane will not edit Rust, profiles, installed binaries, cockpit/cmux
state, or preserved runs. Product-source ownership remains with `tui-polish/root`.

## Durable data contract

`Ticket.blockers` is an ordered array of compiler-persisted records containing `kind`, `message`,
`created_at`, and optional `related_ticket`. Current producers include bounded compiler prose,
model-authored upstream-change reasons, and raw integration errors. Therefore the normal TUI may
use the first message that survives a fail-closed display projection, but must never render the
raw kind, timestamp, related-ticket field, structured record, checkout path, content hash, or
control-plane identifier. If no reason survives, the prior count-only disclosure remains the
honest fallback. `+N more` counts every other durable blocker record, including records whose
message was suppressed, and array order remains authoritative.

## Adversarial findings under review

The first candidate correctly preserves order, skips exact generic noise, keeps count-only fallback,
and replaces common known IDs, Unix paths, SHA-prefixed hashes, and one raw-record shape. Before
release it still needs fail-closed coverage for:

- unknown identifiers without digits and colon-keyed IDs, such as `TK-aaaaaaaaaaaaaaaa`,
  `EV-secret`, and `ticket_id:opaque`;
- single-slash and relative-Windows paths plus keyed/embedded hashes, such as
  `private/checkout`, `private\\checkout`, `commit=deadbee`, and `node@sha256:...`;
- a structured object/array embedded before later prose rather than occupying the whole suffix;
- overlong unbroken tokens and CJK/emoji, because character-count wrapping does not guarantee
  terminal display width;
- replacement labels derived from ticket/stage titles being sanitized again before display, and
  balanced punctuation around redaction placeholders.

## Required focused regressions

1. Preserve the current first-useful/order test: generic first record, useful second record,
   another later record, known-ID/path/hash redaction, `+2 more`, and semantic prose retained.
2. Add a table-driven adversarial projection test covering unknown and keyed IDs, Unix/relative/
   Windows paths, keyed and embedded hashes, mid-message JSON, and control characters. Assert the
   useful semantic clause survives while every sentinel is absent.
3. Add a display-width test with both a long unbroken word and CJK/emoji at compact width. Assert
   every rendered line is within the width in terminal cells and no semantic text is truncated.
4. Keep the count-only test for all-generic/raw/untyped records, including a message equivalent to
   its humanized kind, so redaction never fabricates a reason.
5. Add an unsafe replacement-label case: a known control ID whose title itself contains a path,
   hash, or structured payload must not reintroduce those bytes.

## Coordination

Findings were sent directly to `tui-polish/root` before this mailbox was created. Final severity,
source verdict, and any test evidence will be appended here; this initial finding history must
remain visible.

## 2026-07-14 initial verdict — hardening required before release

**Blocked pending the focused hardening above.** The candidate's ordering, `+N more`, known-record
projection, and count-only fallback are sound, but the current lexical filter is not yet a
fail-closed implementation of the claimed boundary. Concrete counterexamples remain:

- `TK-aaaaaaaaaaaaaaaa`, `EV-secret`, and `ticket_id:opaque` can remain visible;
- `private/checkout`, `private\\checkout`, `commit=deadbee`, and `node@sha256:...` can remain
  visible;
- `Compiler rejected {"status":"blocked","retry":false}; revise the plan` can retain the raw
  object because the parser currently recognizes only an object/array extending through the end;
- one unbroken word or CJK/emoji can exceed the requested terminal width because
  `wrap_full_text` counts characters and does not hard-break words;
- `Failed at /private/checkout` can become generic failure plus a placeholder and still be treated
  as a useful reason.

This review did not run Cargo while several other personas were compiling the shared core in
private targets; source inspection was sufficient to prove each counterexample reaches the
rendered projection. No product source, install, profile, cockpit, cmux, or live/forensic state was
changed. After the owner lands the focused regressions and repair, this lane should re-review the
exact candidate and append a release verdict rather than replacing this causal finding.

## 2026-07-14 final re-review — accepted

**Ready for integration for the exact Ticket Overview blocker-reason slice.** The initial blocked
verdict above remains the causal record. Two owner hardening passes now close every concrete P0/P1
counterexample from that review without broadening into Evidence, lifecycle, approval, compiler,
profile, or live-state behavior.

The final projection:

- considers only object rows with string `kind`, `message`, and `created_at` when selecting a
  durable reason or calculating `+N more`; malformed legacy rows can affect only the preserved
  historical count-only fallback;
- preserves durable array order, shows the first reason that remains semantic after sanitization,
  counts every other typed blocker as `+N more`, and falls back to the exact prior count-only copy
  when no useful reason survives;
- replaces known run/ticket/stage/agent/graph/question/action identifiers with fixed generic
  phrases rather than interpolating unsafe titles, then removes those phrases during semantic
  scoring so generic failure plus a placeholder cannot masquerade as an explanation;
- suppresses UUIDs, opaque/tagged IDs, `id`/`*_id`/`*-id` values using `=` or `:`, and control IDs
  embedded behind punctuation such as `ref(EV-secret)`;
- suppresses any slash/backslash token, keyed `path`/`file`/`worktree` values, hexadecimal and
  SHA/BLAKE material, and keyed/embedded hash/commit/digest/checksum/OID values using either `=` or
  `:`;
- removes control characters, uses streaming JSON parsing to replace embedded object/array spans
  even when useful prose follows, and rejects messages reduced to generic failure or redaction
  placeholders;
- hard-wraps rather than truncates long tokens and uses terminal display width for CJK/emoji, with
  the `! ` prefix included in the available-width budget.

Independent verification against the final shared source:

- `cargo test --locked -p koni-tui ticket_blocker_projection --lib -- --nocapture` — 2 passed.
- `cargo test --locked -p koni-tui ticket_overview_ --lib -- --nocapture` — 3 passed.
- Exact `ticket_overview_wraps_the_first_useful_sanitized_blocker_reason` — 1 passed.
- `cargo test --locked -p koni-tui --lib` — 292 passed, 0 failed, 0 ignored.
- `rustfmt --edition 2024 --check crates/koni-tui/src/ui.rs` and path-scoped `git diff --check` —
  clean.

No Rust source, installed binary, profile, cockpit, cmux, Updog, forensic run, or live state was
changed by this review lane. One cosmetic future hardening remains nonblocking: replacing a raw
control character with whitespace is terminal-safe but can leave the printable tail of an ANSI
sequence (for example `[31m`) visible as prose. If source-built smoke output exhibits that residue,
strip the complete CSI sequence in a separately claimed presentation slice. A future untyped
snapshot transport should also parse the blocker timestamp rather than relying on the current
typed compiler serialization.
