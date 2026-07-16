# Tracked Git symlink alias audit

- Owner: `tracked-symlink-alias-audit/root`
- Status: `complete` (read-only source/security audit)
- Started: 2026-07-16 MST
- Scope: `ensure_planned_proof_source_relocation_path_untracked` and its path-identity helpers

## Exact lease

Diagnose why the paused Updog relocation rejected the unrelated tracked
`.claude/skills -> ../.agents/skills` compatibility link, design the smallest secure admission
algorithm, and review the implementation owner's focused repair. This lane changes no Rust,
tests, profile, installed or isolated binary, live run state, product worktree, Git ref, process,
or cockpit/cmux surface. Its only write is this coordination record.

## Diagnosis

The original verifier iterated every index and pinned-HEAD blob and passed its Git pathname to
`project_authority_paths_overlap` / `project_authority_paths_equal`. Those helpers intentionally
construct a filesystem authority identity and reject any path component which is a symlink. The
scan therefore failed as soon as it reached `.claude/skills`, before it had established any
relationship between that link and the proposed
`apps/books/.../spiced-framework.focused.test.tsx` source.

The live link is a mode-`120000` Git entry whose exact blob is `../.agents/skills`. Its link path,
root-contained target, and target subtree are disjoint from the proposed source. The proposed
source is absent, its own components are symlink-free, and ordinary tracked files still need the
full filesystem-identity comparison.

An unconditional `continue` for every mode-`120000` entry is not a secure repair. A tracked
`alias -> tests` or `alias -> tests/focused-proof.txt` is lexically unrelated at the link pathname
while still providing a reverse alias to the future proof source. Candidate-component checks do
not discover a symlink which points *to* the candidate. Skipping the target would weaken the
compiler's single-path write-authority and proof-source disjointness invariants.

## Smallest secure algorithm

Keep the existing index and pinned-HEAD scans, but make a mode-aware comparison for each exact
snapshot entry:

1. Normalize and compare the Git pathname to the proposed source before inspecting its mode. An
   equal, ancestor, or descendant pathname blocks. For a symlink pathname, also use a conservative
   component comparison (NFD plus lowercase) so a sparse or otherwise omitted link cannot evade
   case- or Unicode-normalization alias detection. Ordinary non-symlink entries should retain the
   more precise filesystem comparator rather than inheriting this extra false-positive policy.
2. For a non-symlink entry, retain the existing `project_authority_paths_overlap` behavior for the
   index and `project_authority_paths_equal` behavior for the pinned HEAD. This preserves existing
   inode/hard-link, existing-prefix, case, Unicode, ancestor, and descendant defenses.
3. For a mode-`120000` entry, read the target from the exact immutable blob OID belonging to that
   entry. Never use `fs::read_link`: the index and HEAD may intentionally have different target
   blobs, and the worktree may be sparse, dirty, absent, or materialized differently. Evaluate
   every index stage rather than silently selecting stage zero.
4. Accept only a nonempty, NUL-free, valid UTF-8 target. Blob lookup/type failure, malformed
   bytes, or an unrepresentable path fails closed. This matches the existing UTF-8 project-path
   authority contract and avoids lossy decoding.
5. Reject absolute targets. Resolve a relative target against the link pathname's parent with a
   root-bounded component stack. Leading `.` and `..` components are valid when they remain inside
   the project; this is what admits `.claude/skills -> ../.agents/skills`. A `..` which would pop
   above the root fails closed.
6. Do not blindly collapse an interior `normal/..`. Path lookup follows `normal` first; if it is a
   symlink, `jump/../safe` need not have the lexical meaning `safe`. The minimal secure rule is to
   reject a parent traversal after the first normal target component. A fuller resolver could
   recursively bind every intermediate Git/filesystem link, but it is unnecessary for this repair
   and materially enlarges the trusted code surface.
7. Compare the resulting project-relative target to the proposed source using both pathname
   overlap and the existing filesystem authority comparator. Exact targets, directory ancestors,
   descendants, case/normalization aliases on the host filesystem, hard-link identities, and
   chained filesystem symlinks therefore reject. An unrelated, simple, root-contained target may
   pass. If the resolved target itself crosses a symlink component, the existing comparator stays
   fail-closed rather than following mutable checkout state.
8. Repeat the operation independently for the index OID and each pinned-HEAD tree-entry OID. A
   safe index target cannot sanitize a malicious HEAD target, and a safe HEAD target cannot
   sanitize a staged malicious index target.

This algorithm admits the real Updog compatibility link without treating its target as writable
authority, while retaining the conservative defenses which motivated the original helper.

## Adversarial test matrix

The smallest focused unit fixture is a temporary libgit2 repository calling the private verifier
from the `engine.rs` test module. It should create real mode-`120000` entries so the test covers
mode dispatch and blob lookup rather than only the target-normalization helper.

Required positive case:

- Commit `.claude/skills -> ../.agents/skills`, create ordinary tracked content under
  `.agents/skills`, keep `apps/books/focused.test.tsx` absent, and require admission.

Required negative cases:

- An ordinary exact tracked file still rejects; existing hard-link/identity tests remain green.
- A symlink pathname equal to, above, or below the proposed path rejects before target handling.
- `alias -> apps/books` and `alias -> apps/books/focused.test.tsx` reject as reverse aliases.
- `.claude/alias -> ../apps/books` proves root-contained leading-`..` resolution still rejects a
  target ancestor.
- Absolute, root-escaping, empty, embedded-NUL, non-UTF-8, unreadable/non-blob, and oversized or
  otherwise policy-invalid target payloads fail closed. An explicit size bound is availability
  hardening; it is not needed to resolve the live failure.
- `compat/link -> jump/../safe` fails closed because interior parent traversal can erase an
  intermediate symlink from a naive lexical result.
- A target which crosses another symlink fails closed (or is recursively resolved only if a later
  design binds the complete chain and detects cycles).
- A missing/sparse symlink pathname which differs from the candidate only by case, or by composed
  versus decomposed Unicode, rejects through the symlink-only conservative pathname comparison.
- Commit `alias -> safe`, then stage `alias -> apps/books`; the index blob must reject. In a fresh
  repository, commit `alias -> apps/books`, then stage `alias -> safe` or delete it; the pinned-HEAD
  blob must still reject. These cases prove the code never substitutes worktree or opposite-snapshot
  target bytes.
- If the index contains conflict-stage symlink entries, every candidate target must be checked;
  any ambiguous or aliasing stage rejects.

The current focused fixture already covers the real Updog-style positive case, an index target
pointing at the candidate parent, and a pinned-HEAD target retained after index deletion. The
normalization unit coverage includes relative `..`, absolute/root escape, empty, NUL, non-UTF-8,
and ambiguous interior traversal. The case/Unicode sparse-path rows are the important final
defense-in-depth additions.

## P0/P1 review notes

- No definite P0 was identified in the target-aware design. This helper decides whether a new
  product proof path can receive authority; a false negative is an authority-integrity problem,
  but it does not by itself overwrite compiler-owned state.
- **P1 if retained:** unconditional mode-`120000` skipping. It misses reverse aliases from a
  tracked link target into the proposed source or its parent.
- **P1 if retained:** reading a target from the worktree, or reusing the index target for HEAD (or
  vice versa). Staged/sparse state can make the checked target differ from the pinned authority.
- **P1 if retained:** lossy/unchecked blob decoding, ignoring blob/type lookup failures, accepting
  absolute or root-escaping targets, or treating malformed targets as unrelated.
- **P1 if retained:** exact-only target comparison. A link to the candidate's directory is an
  effective alias even when it does not name the final file.
- **P1 if retained:** lexical collapse of interior `normal/..`; it can erase a symlink-sensitive
  path component before the alias comparator sees it.
- **P1 defense gap in sparse checkouts:** exact-only comparison of the symlink's own Git pathname.
  A symlink-only conservative case/NFD component comparison closes this without weakening precise
  handling for ordinary existing files.
- Resolving every link with `canonicalize` is not an acceptable shortcut: dangling aliases to the
  future source cannot canonicalize, and the result would bind mutable worktree state instead of
  the exact index/HEAD blobs.

## Reviewed implementation disposition

The implementation owner replaced the transient unconditional skip with target-aware blob
handling while this audit was active. The reviewed source now binds index and HEAD OIDs
independently, permits the live root-contained `../.agents/skills` target, rejects reverse target
overlap, and fails closed for invalid UTF-8, NUL, absolute, root-escaping, and ambiguous interior
parent traversal. Focused positive/index/HEAD target tests were reported green. The remaining
requested closure is the sparse symlink-path case/Unicode regression and its conservative
pathname check; release should not rely only on the physical worktree link being present.

## 2026-07-16 — final reviewed-source disposition

This note supersedes the pending sentence immediately above without deleting the audit history
that caused the final change. The implementation owner added a symlink-only conservative
component-prefix comparison using the existing NFD/lowercase identity rule. The focused fixture
now removes tracked `Tests/Alias` and `Tests/Café` links from the checkout, then proves proposed
`tests/alias/...` and decomposed `tests/café/...` paths still reject from index/HEAD identity.
The ordinary `.claude/skills -> ../.agents/skills` compatibility link continues to pass for the
unrelated `apps/books/...` source. Interior `Normal/..` remains fail-closed.

Independent focused verification on the reviewed shared bytes:

```text
cargo test -p koni-core --lib tracked_symlink
2 passed; 0 failed; 0 ignored; 653 filtered out
```

Final disposition: **no definite P0 or P1 remains** in this bounded verifier. The exact index and
HEAD blob targets are checked independently; malformed, external, escaping, ambiguous, reverse-
aliasing, case-aliasing, and Unicode-aliasing symlinks fail closed; unrelated root-contained links
may pass; and non-symlink hard-link/filesystem identity behavior is unchanged. A target-size bound
and support for more complex but provably safe symlink chains are availability/P2 hardening only,
not release blockers for this repair.
