# Pi worker tools

## Lease and status

- Persona/work type: `pi-worker-tools/root`.
- Status: `ready_for_integration` after focused verification; final shared-suite and release integration remain with `pi-runtime-architect/root`.
- Owned source ranges: worker product-tool catalog/argument validation in `crates/koni-core/src/agent_tool_broker.rs`; worker file/check execution, durable write intent/recovery, and focused tests in `crates/koni-core/src/engine.rs`.
- Non-owned files deliberately untouched: schema migration, CLI migration/control, runtime launcher/containment, profile YAML, release workflow, installed binary, and live/forensic run state.

## 2026-07-14 decisions and current contract

1. Direct-Pi production workers receive compiler-owned `read_file`, `list_files`, `search_files`, `write_file`, and `run_configured_check` tools in addition to the existing context/graph/output lifecycle tools. The model receives no shell, argv, cwd, environment, or arbitrary check command surface.
2. Product filesystem access is revalidated against the exact current ticket-step read/write scope. Paths are project-relative, no-follow, confined to the issued worktree, and deny compiler/repository namespaces (`.git`, `.agents`, `.koni`, `.codex`, `.claude`, `.opencode`, configured storage/worktree roots, configured exclusions, and internal CAS stage names).
3. Regular product reads are UTF-8, at most 512 KiB per file, and paged at at most 64 KiB while preserving UTF-8 boundaries. Listings/searches have count, walk, scan-byte, snippet, and encoded-result-byte ceilings. All worker product responses are checked below 384 KiB before the durable success receipt.
4. Direct-Pi context is compacted before broker persistence when the compiler document exceeds 32 KiB. The durable/model response contains the preview, exact compiler-issued `document_path`, `next_offset`, total bytes, and full-document SHA-256. `read_file` admits that otherwise-protected path only when it exactly equals the current step's compiler-derived context document and pages up to 64 KiB; the context document itself is capped at 64 MiB. A greater-than-1-MiB context therefore cannot become a permanently oversized exact replay.

   **Limit transition — 2026-07-16:** Preserve the bounded-preview and exact-path design, but the
   64 MiB ceiling above is no longer current. New compiler context packs are capped at 4,000,000
   bytes and exact context continuations require at least 32 KiB. Worst-case UTF-8 boundary
   rollback still fits the maximum document in at most 123 page-bearing deliveries. A path-only
   recovery response raises the worst case to 124, beneath a dedicated 128-receipt context
   allowance and leaving at least 128 of 256 grant receipts for product reads,
   configured checks, edits, and terminal submission. Each successful context delivery is also a
   provider-observation boundary; same-message siblings are rejected locally before broker
   dispatch.
5. `write_file` is a full-file compare-and-swap. Public input is `{path, expected_sha256, content}`; Rust computes the postimage hash. Raw content is at most 384 KiB and rejects controls other than LF/CR/tab, proving the worst accepted two-times JSON expansion plus the complete Pi frame remains below 1 MiB. Rust still measures encoded arguments (896 KiB ceiling). The separate Pi-host pre-dispatch guard for arbitrary non-write tool arguments belongs to the runtime-host lane and was routed to `pi-runtime-architect/root`.
6. Writes use a same-directory compiler-named stage, `O_NOFOLLOW`, file `fsync`, atomic rename/hard-link create, and parent-directory `fsync`. The grant durably records preimage/postimage/path/byte intent before the effect. Exact retry and supervisor revocation independently reconcile an observed postimage into the same response/receipt; an unchanged preimage discards only the stage; a third image fails closed. Revocation uses a nonblocking operation lock, and run deletion retries reconciliation after terminating the owned runtime.
7. Configured checks accept only a compiler-assigned check ID. Command checks must be declared read-only; graph/composite checks are allowed. Results expose bounded identity/status plus a bounded failed diagnostic. API keys, tokens, bearer values, cookies/passwords/secrets, OpenAI-style keys, and URI userinfo are redacted before the model-facing response.
8. Observer request hashes include the current product binding, so identical read/list/search/check calls after product drift execute again instead of replaying stale observations. A successful write replay additionally proves the current file is still its recorded postimage.

## Verification

- `CARGO_TARGET_DIR=/tmp/koni-worker-tools-target cargo check -p koni-core --lib` — passed (warnings only).
- `engine::tests::pi_worker_product_tools_enforce_step_scope_hash_cas_and_no_follow` — passed; includes multipage UTF-8 reconstruction, scope/protected-path denial, stale/create CAS, and symlink denial.
- `engine::tests::pi_worker_check_tool_accepts_only_assigned_read_only_configured_ids` — passed.
- `engine::tests::pi_worker_diagnostics_redact_secrets_and_bound_result_rows_by_encoded_bytes` — passed.
- `agent_tool_broker::tests::direct_pi_worker_product_catalog_is_bounded_and_forwards_safe_results` — passed.
- `agent_tool_broker::tests::paged_context_projection_preserves_recovery_metadata_below_pi_transport_limit` — passed.
- `agent_tool_broker::tests::worst_case_worker_write_arguments_fit_one_complete_pi_tool_call_frame` — passed.
- `CARGO_TARGET_DIR=/tmp/koni-worker-tools-target cargo test -p koni-core --lib agent_tool_broker::tests -- --nocapture` — passed 9/9.
- `engine::tests::direct_pi_worker_grant_pages_large_context_and_recovers_write_postimage_after_reopen` — passed; greater-than-1-MiB context compacts before its durable receipt/exact replay, and a persisted crash-after-replacement write is reconciled through a freshly reopened supervisor path into one receipt without re-execution.
- Final post-edit `CARGO_TARGET_DIR=/tmp/koni-worker-tools-target cargo check -p koni-core --lib` — passed (warnings only). The immediately following focused test rerun was compile-blocked outside this lease by a concurrent cfg-test-only `agent_runtime.rs` initializer missing its newly added `stderr_thread`; the same worker-check test had passed before that unrelated concurrent edit.

## Coordination and open questions

- `pi-runtime-security-review/root` reviewed the durability and transport boundaries during implementation. Its write-recovery, byte-bounded list, context replay, redaction, paging, and frame-expansion findings are incorporated above.
- Routed to `pi-runtime-architect/root`: add a host-local/before-dispatch encoded-argument guard for every Pi tool call. Rust's broker guard occurs after the 1-MiB NDJSON ingress and cannot alone turn an oversized arbitrary `submit_*` payload into a model-visible retry.
- Integration owner should preserve the context-first prompt wording that tells a direct-Pi agent to page only the exact compiler-issued context path. No question is currently blocking this worker-tool lane.

## Mailbox sweep

- 2026-07-14 handoff sweep: re-read `docs/AGENT_COLLAB.md` and the Pi owner/security mailboxes relevant to overlapping runtime/broker contracts. No unanswered request requires worker-tool source changes beyond the routed all-tool host-frame guard above.

## 2026-07-14 P2 worker-log follow-up

- Status: `ready_for_integration`; the direct-Pi worker log naming/bounding lease is released. The concurrently moving schema-2 cutover ranges were not edited.
- Direct-Pi production now gives every agent/attempt its own same-directory
  `worker.<agent-id>.attempt-<n>.log`. `AgentSessionRecord.stdout_path`/`stderr_path` store that exact
  path, and keeping its parent unchanged preserves the existing parent-derived `worker.pid`
  cleanup/recovery invariant.
- The 8 MiB writer reserves the full `log_truncated` marker. Opening an older unmarked file that
  already consumed the reserve trims only to the payload ceiling, appends and syncs the marker, and
  treats the attempt as sealed. Later agent sessions start with independent capacity.
- Runtime-root Git exclusions and tracked-artifact cleanup recognize the validated new filename;
  similarly named product logs outside that exact runtime root remain visible and preserved.
- Verification: `direct_pi_worker_logs_are_per_attempt_and_always_mark_truncation` passed 1/1;
  `runtime_cleanup_preserves_product_logs_and_unrelated_staging` passed 1/1;
  `CARGO_TARGET_DIR=/tmp/koni-worker-tools-target cargo check -p koni-core --lib` passed with only
  unrelated existing dead-code warnings; scoped `git diff --check` passed.
- Final documentation sweep: re-read `docs/AGENT_COLLAB.md`, the Pi architect and red-team
  mailboxes, and every worker-log reference under `docs/`. The historical cumulative Codex behavior
  remains in place with dated Direct-Pi transition notes; no unanswered worker-log question remains.
