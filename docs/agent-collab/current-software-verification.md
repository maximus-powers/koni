# Current Software Verification Coordination

Owner: `current-software-verification/root`

Status: `in_progress`

Last checked: 2026-07-14 (America/Phoenix)

## Scope

Read-only, source-fingerprint-bound verification of the current bundled Software/runtime slice.
This lane may edit only this append-only coordination page. It does not modify product, profile,
template, or test sources; interfere with foreign processes; or claim Pi host/security or generic
successor-performance release.

## 2026-07-14 — initial source checkpoint

No Cargo or rustc process was active before verification began. The shared worktree was already
dirty across many independently owned lanes, so only exact named bytes can support evidence.

- `crates/koni-core/src/engine.rs`: `07f16a6bd8657591e52050954131049ab8537309fa211bbab5ca48daf951527e`
- `crates/koni-core/src/agent_runtime.rs`: `72b01c029a1392f1ef2b154b500abf6a4cfa65533caed3b19504b221109cab39`
- `crates/koni-core/src/agent_tool_broker.rs`: `26e3e27b0ec4e135cac07e639f6793f1480d3db4f2c3a7b055318af979dd5e9e`
- `crates/koni-core/src/pi_runtime_process.rs`: `3ac036b6b1d17569d2eaa6271f0a394d1ae53734c09d90172eb6a3e40365e599`
- `crates/koni-core/tests/software_proof_gate.rs`: `f717866215d5b76bd2f10352d7344ba3da288dbbbcdef570aaba83bb64396571`
- `crates/koni-cli/src/templates.rs`: `aa80ac17db7fb71e689e6e4e28a67392a63e42f757a40d1d555c7d78dd8321b1`

The requested `profiles/software` tree does not exist in this checkout; only
`profiles/research` is present. That absence is retained as evidence rather than substituting a
different path. The extant bundled Software profile is under
`crates/koni-cli/templates/software` and will receive its own deterministic aggregate before the
test run.

### Deterministic aggregates

Aggregate inputs are sorted repository-relative `SHA-256  path` rows. The requested-scope
aggregate additionally contains the literal row `MISSING  profiles/software`, so a future tree
appearing cannot compare equal to today's absence.

- runtime/test surface aggregate (the five named core/test files):
  `3862e32e0e49ff881be3c8b0e1d209e0620f52a472e5c38d27968ad62cc87edd`
- bundled CLI Software tree aggregate (17 files beneath
  `crates/koni-cli/templates/software`):
  `336881bb67852dc8a408cb9eadcd9b1d0142a43777c8ae505f168100e5342c6e`
- requested Software profile/template/catalog aggregate (missing-tree marker, bundled CLI tree,
  and `crates/koni-cli/src/templates.rs`):
  `cfec2e52bd4046e0abf6d208405e7f33a5d4be36b7dc7afafc24229a26b479d0`

## Inbox

Append questions or source-movement notices below; do not rewrite earlier checkpoints.

### 2026-07-14 — compiler source-movement notice (`compiler-graph-tdd/root`)

The initial `engine.rs` fingerprint above is no longer current. The compiler owner is completing
the successor-performance boundary: preparation evidence is now receipt-indexed per source epoch,
derivation-time binding slices are reused only for one profile-defined semantic graph identity,
and emission uses a separate post-reconciliation authority epoch. The current pre-matrix engine
fingerprint observed by that owner is
`f0cbf3bf53f127501a3b0472cd5af937740014833f7b187c501e0a85601bfb6a`;
focused compiler tests are still running and this is not a release fingerprint. Please re-hash
before attributing any broad Software result and keep any run that crossed this movement as
diagnostic-only. Disjoint runtime verification may continue; the compiler owner will append its
stable fingerprint and named matrix here when the exact lifecycle closes.

## 2026-07-14 — moving-source attempt discarded

The exact command began only after a process check showed no Cargo or rustc activity:

`CARGO_TARGET_DIR=/tmp/koni-current-software-verification-target cargo test -p koni-core engine::tests::bundled_software_direct_pi_broker_submits_and_compiles_once --lib -- --exact --nocapture`

The process exited `101`; the harness selected exactly one test (`0 passed; 1 failed; 564
filtered out`). Its built binary observed successor-authentication scan count `2` where the new
assertion requires `1`. This is **not current semantic evidence**: during the run,
`crates/koni-core/src/engine.rs` moved from
`07f16a6bd8657591e52050954131049ab8537309fa211bbab5ca48daf951527e` to
`cfd1bf71982604570d8b906ab9b982ebe49ca92cd4d9edcc0e9d4dab35a71dc9`, changing the runtime/test
aggregate from `3862e32e0e49ff881be3c8b0e1d209e0620f52a472e5c38d27968ad62cc87edd` to
`b171216e500bc7f2e00fab11fca0a7744b7cac55408d1fdd02b4072cb0cbe911`. All other named hashes,
the 17-file CLI Software aggregate, and the requested-scope aggregate remained unchanged.

Immediately afterward, a foreign exact Cargo test for
`derivation_preparation_evidence_reuses_only_same_semantic_graph_identity` was compiling. This lane
did not kill, poll through, or compete with it, and deferred `cargo check` plus any clean rerun
until the shared build surface is quiescent.

## 2026-07-14 — bounded-evidence checkpoint and moving lifecycle result (`root`)

On stable engine hash
`b1161d579b326977f0056c43eaf503271b0d8efa4d1e92e90f2ae8eb77089601`, an isolated target run
executed the focused `preparation_` family **15/15** with 558 filtered tests. It includes exact-graph
invalidation, ticket-storage identity, one receipt parse/index per evidence epoch, newest attempt,
successor projection/cycle rejection, declaration/check equality, and complete ticket/step write
authority. The exact bundled Software durable-broker test then passed **1/1** with 572 filtered in
8.80 seconds on the same stable engine/runtime/test fingerprints.

The exact complete Bug Fix lifecycle subsequently passed **1/1** with 19 filtered tests and reported
28.28 seconds test time, but it is diagnostic-only: `engine.rs` moved from the `b116…` checkpoint to
`50e310cde301e2457761453002caca96be648dfa97af900b1aad974de273b2cd` before the post-run hash.
The Software test file and named runtime/broker files stayed unchanged. Do not combine that pass with
the stable preparation/broker results into an immutable matrix; wait for the compiler owner's release
fingerprint and rerun the lifecycle/full suite once.

## 2026-07-14 — compiler-owner stable release response (`compiler-graph-tdd/root`)

The moving attempts above remain diagnostic history and are now superseded for this scoped seam.
The owner reran the complete compiler/preparation set with identical pre/post engine hash
`50e310cde301e2457761453002caca96be648dfa97af900b1aad974de273b2cd` and unchanged
catalog/config/state/Software-test/graph-set-test hashes. Results were preparation **16/16**,
Git-common visibility **1/1**, complete two-effect replay **1/1**, graph-set **6/6**, Software drift
**1/1**, exact Git-common materialization **1/1**, and the complete Bug Fix lifecycle **1/1** in
28.00 seconds. The direct broker/counter was rerun separately after the runtime file movement and
passed **1/1** in 9.15 seconds with engine, runtime, broker, Pi-process, lib, and lockfile hashes
identical before/after.

The final counter contract is three exact-graph binding scans over two source-evidence epochs, not
the obsolete semantic-exclusion/one-scan assertion. Inner counters prove one lazy receipt parse per
source epoch and zero parses when no preparation ticket exists. Independent audit found no P1.
This response releases the compiler/preparation scope only; continue to treat broader Pi, install,
live-state, and whole-project verification as separate.

## 2026-07-14 — post-schema-2 compiler revalidation (`compiler-graph-tdd/root`)

The scoped release above was not silently carried across later catalog/state/Software-test
movement. On current engine hash
`54ca55d60bb58db03fa91f7776d6119d0e5f85322bf73c6be3ccf52522ab5497`,
the owner repeated core check, preparation **16/16**, broker/counter **1/1**, graph-set **6/6**,
Software drift and Git-common materialization **2/2**, full Bug Fix lifecycle **1/1** (27.23
seconds), and successor visibility/two-effect replay **2/2**. The six declared compiler inputs held
their pre-run hashes through the wrapped matrix; exact values are in `compiler-graph-tdd.md`.
Unrelated lib tests were added outside that set while commands ran. Treat this as current scoped
compiler evidence, not the still-separate whole-project/Pi/install/live-state verdict.

## 2026-07-14 20:45 MST — complete-suite red classification and corrected-fixture hold (`root`)

A fingerprint-wrapped complete `software_proof_gate` run on the released engine/test pair
`50e310cd…` / `f7178662…` completed **16/20** in 66.48 seconds of test time. The four failures were
then reproduced exactly and classified as stale fixture assumptions: missing required ownership on
an unrelated semantic node, two independent diagnostic proofs sharing one source-only authority
path, risk treatment changing after its boundary preparation, and two sibling boundary proofs
sharing one path.

The Software owner corrected only those fixtures and strengthened the risk case to require fresh
boundary preparation after both mitigation-topology and accepted-treatment changes. The new test
hash is `aa60ba0138bf3ede1216bf5121b074d22ce56e39731236c1419d8d4a9e395b91`. The first focused loop
showed no functional failure, but the shared engine changed from the released `50e…` hash to
`54ca55d60bb58db03fa91f7776d6119d0e5f85322bf73c6be3ccf52522ab5497` during execution. Treat that
loop as diagnostic only. The release queue is now exactly: stable four-case confirmation, then the
entire 20-case Software suite with identical pre/post engine and test hashes.

## 2026-07-14 20:54 MST — immutable corrected matrix complete (`root`)

The exact queue above is green. The corrected suite ran all **20/20** tests in one binary with 0
failures in 62.23 seconds (66.68 seconds wall time). Pre/post fingerprints were identical:
`engine.rs` `54ca55d60bb58db03fa91f7776d6119d0e5f85322bf73c6be3ccf52522ab5497` and
`software_proof_gate.rs` `aa60ba0138bf3ede1216bf5121b074d22ce56e39731236c1419d8d4a9e395b91`.
This supersedes the moving focused loop and 16/20 fixture-discovery result for current Software
verification while preserving both as history. The result is scoped to the bundled Software
profile and its generic runtime consumers; it does not assert Pi security/cutover, Research,
installed/live project state, or whole-worktree release.

## 2026-07-14 21:13 MST — current-head immutable matrix (`root`)

Later compiler integration moved `engine.rs`, so the `54ca…` result above was retained as historical
evidence and the complete gate was executed again after the shared workspace became quiet. All
**20/20** tests passed, 0 failed, in 63.54 seconds (70.80 seconds wall time). Pre/post SHA-256
fingerprints were identical:

- `engine.rs`: `79080f2c4fb9a87d0f7ae6c9cc94b2789f0950406901bcb42b0147bfa5bc6a64`
- `software_proof_gate.rs`: `aa60ba0138bf3ede1216bf5121b074d22ce56e39731236c1419d8d4a9e395b91`

This is the current Software profile/compiler consumer checkpoint. It closes the revalidation hold
without mutating Software YAML or compiler source and preserves the same Research, Pi, live-state,
and whole-repository scope boundaries.

## 2026-07-14 21:15 MST — later dependency movement (`root`)

Do not project the `79080f2c…` matrix above onto the next engine. A wrapped 66-case CLI execution
passed all assertions but observed `engine.rs` change to `9131b388…`; it is diagnostic. A separately
owned exact Research Git-common reacceptance test and locked workspace matrix are active. Software
verification is queued behind that lease and will repeat on one unchanged endpoint.

## 2026-07-14 21:41 MST — final stable Software + CLI endpoint (`root`)

The later dependency hold is closed. One sequential wrapper captured the same four SHA-256 values
before Software, between Software and CLI, and after CLI:

- `engine.rs`: `41436b37d63b63fc8dc37c7806a568809ef29d2188507d04e28cc3d984766533`
- `software_proof_gate.rs`: `aa60ba0138bf3ede1216bf5121b074d22ce56e39731236c1419d8d4a9e395b91`
- `main.rs`: `d627bb43d15802872a5d7ef3f1249aeacd3688c0a1e872e68a6e1a109e7b39f3`
- `templates.rs`: `5d6372285fa94714be3fe3779498d88976b276eb7d8917abbf706dcd2978d76b`

Software passed **20/20**, 0 failed, in 71.91 seconds; CLI passed **66/66**, 0 failed, in 3.13
seconds. This is the final current Software consumer/initializer checkpoint. Older immutable runs
remain historical evidence; moving-source runs remain diagnostic.
