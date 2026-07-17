#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { findParityRoot, loadParityRepository } from "./parity-ledger.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function secretMatches(value) {
  const patterns = [
    /\bsk-[A-Za-z0-9_-]{16,}\b/gu,
    /\b(?:OPENAI|ANTHROPIC|GEMINI|AWS)_[A-Z0-9_]*(?:KEY|TOKEN|SECRET)\s*=\s*\S+/gu,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu,
  ];
  return patterns.flatMap((pattern) => value.match(pattern) ?? []).map((match) => sha256(match));
}

export function parsePassedTests(output) {
  const tests = [];
  for (const line of output.split(/\r?\n/u)) {
    const match = /^test (.+) \.\.\. ok$/u.exec(line.trim());
    if (match) tests.push(match[1]);
  }
  return [...new Set(tests)].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

export function captureFrozenRustSuite(root = findParityRoot(), options = {}) {
  const model = loadParityRepository(root);
  const temp = mkdtempSync(join(tmpdir(), "koni-parity-rust-"));
  const worktree = join(temp, "oracle");
  const target = options.targetDir ?? join(root, "target", "parity-rust-oracle");
  try {
    execFileSync("git", ["-C", root, "worktree", "add", "--detach", worktree, model.fingerprint.tag.commit], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    const prebuildArgs = ["test", "--workspace", "--no-run"];
    // These frozen tests intentionally inspect or create macOS process/sandbox
    // boundaries that an outer sandbox-exec makes unverifiable. None is an
    // oracle proof named by the parity manifest; exclude them rather than
    // weakening the external-network boundary for the semantic contract suite.
    const macosOuterSandboxIncompatible = [
      "codex_permission_profile_writes_scratch_but_denies_project",
      "timeout_kills_the_complete_agent_process_group",
      "credential_socket_is_inherited_only_as_fd_three",
      "supervised_host_drains_stderr_without_blocking_and_caps_diagnostics",
      "unrelated_non_cloexec_descriptor_is_not_inherited",
      "agent_process_is_started_in_its_own_process_group",
      "bundled_software_direct_pi_broker_submits_and_compiles_once",
      "composed_broker_failure_boundaries_reconcile_without_duplicate_effects",
      "composed_execute_and_revoke_are_safe_in_both_lock_orderings",
      "composed_lead_execution_commits_every_enabled_action_path",
      "composed_lead_spawn_then_yield_keeps_the_same_grant_current",
      "configured_nonzero_exit_is_a_passing_durable_check_receipt",
      "configured_run_step_executes_and_writes_its_runtime_receipt",
      "direct_pi_worker_grant_pages_large_context_and_recovers_write_postimage_after_reopen",
      "gate_command_resolution_is_exactly_ticket_scoped",
      "macos_read_only_sandbox_allows_only_declared_reads_and_private_scratch",
      "zombie_process_is_not_reported_as_a_live_worker",
      "red_to_green_freezes_only_source_bytes_across_distinct_child_checks",
      "historical_baseline_aggregate_binds_output_recorded_before_receipt",
      "inverse_selected_members_are_stable_exact_and_fail_closed_on_topology_drift",
      "committed_relocation_request_without_transaction_quarantines_ordinary_authority",
      "planned_proof_source_relocation_is_journaled_exact_and_replay_safe",
      "tracked_backend_recovery_reconstructs_partial_action_success_before_h1",
      "tracked_backend_recovery_finalizes_existing_h2_without_advancing_integration",
      "tracked_backend_recovery_rejects_unrelated_request_checkpoint_change",
      "tracked_backend_recovery_rejects_action_success_missing_canonical_retry_binding",
      "tracked_backend_recovery_rejects_tree_excluded_blob_in_request_checkpoint",
      "tracked_backend_relocation_pins_action_checkpoint_then_seals_and_replays",
      "tracked_backend_relocation_recovers_every_durable_publication_phase",
      "compile_ticket_action_reaccepts_filesystem_changes_for_tracked_and_git_common_storage",
      "canonical_gate_edge_and_compatible_asset_relationship_advance_gate",
      "compiler_filesystem_manifest_scopes_acceptance_and_reopens_on_vendor_or_file_staleness",
      "automatic_gate_preflight_skips_gaps_and_honors_legacy_run_gate_owner",
      "automatic_gate_terminal_matrix_respects_scoped_impact_and_full_catchup",
      "composed_verification_rejects_nonpassing_receipts_even_when_the_check_allows_them",
      "failed_composed_verification_blocks_and_retry_rebinds_the_fixed_run_tree",
      "git_common_verification_binds_promotion_to_the_exact_checked_head",
      "intervening_run_commit_after_target_sync_reopens_sync_before_verification",
      "promotion_requires_one_safe_receipt_projection_for_each_bound_check",
      "running_read_only_command_and_deletion_serialize_at_durable_boundaries",
      "target_bound_run_waits_for_authorization_then_promotes_the_verified_head",
      "target_only_commit_after_target_sync_reopens_before_verification",
      "target_sync_cas_input_move_returns_to_pending_and_rebinds",
      "tracked_report_after_verification_preserves_the_exact_product_projection",
      "unchecked_product_changes_after_verification_never_become_promotion_ready",
      "software_assurance_scales_and_risk_treatment_has_disjoint_routing",
      "software_bug_fix_bootstraps_prepares_diagnoses_then_plans_the_causal_change",
      "software_bug_fix_planning_exact_covers_every_active_diagnosed_defect",
      "software_bug_fix_requires_causal_diagnosis_and_an_addressing_change",
      "software_delivery_requires_current_proof_and_exact_nonvacuous_coverage",
      "software_each_proof_strategy_runs_baseline_product_promotion_review_and_finish",
      "software_failed_implementation_proof_preparation_blocks_product_authority",
      "software_git_common_preparation_integrates_at_its_exact_ticket_materialization_boundary",
      "software_implementation_review_stamps_only_its_pinned_active_proofs",
      "software_migration_preparation_gate_routes_authoring_strategies_only",
      "software_one_change_accepts_multiple_nonredundant_focused_proofs_in_one_ticket",
      "software_preparation_current_rejects_effect_destination_and_historical_receipt_drift",
      "software_prepared_risk_boundary_waits_for_introducer_and_control_then_runs_green",
      "software_review_rework_keeps_prepared_oracle_immutable_and_reopens_product_only",
      "software_sibling_proof_tickets_select_and_stamp_exactly_one_shared_subject_member",
      "software_stale_candidate_delivery_revises_the_same_exact_scoped_node",
      "software_upstream_oracle_review_failure_holds_change_migration_and_multi_proof_candidates",
    ];
    const excluded = process.platform === "darwin" ? macosOuterSandboxIncompatible : [];
    const cargoArgs = [
      "test", "--workspace", "--", "--format", "pretty",
      ...excluded.flatMap((name) => ["--skip", name]),
    ];
    const environment = {
      ...process.env,
      CARGO_TARGET_DIR: target,
      HOME: join(temp, "home"),
      KONI_PARITY_NO_PROVIDER: "1",
    };
    const prebuild = spawnSync("cargo", prebuildArgs, {
      cwd: worktree,
      encoding: "utf8",
      env: environment,
      maxBuffer: 128 * 1024 * 1024,
      timeout: options.timeoutMs ?? 30 * 60 * 1000,
    });
    if (prebuild.status !== 0 || prebuild.signal) {
      throw new Error(`frozen Rust no-run build failed: exit=${prebuild.status} signal=${prebuild.signal ?? "none"}\n${(prebuild.stderr ?? "").slice(-4000)}`);
    }
    const macosFixtureOnlyProfile = [
      "(version 1)",
      "(allow default)",
      "(deny network*)",
      "(allow network-bind (local ip \"localhost:*\"))",
      "(allow network-inbound (local ip \"localhost:*\"))",
      "(allow network-outbound (remote ip \"localhost:*\"))",
    ].join(" ");
    const command = process.platform === "darwin" ? "/usr/bin/sandbox-exec" : "cargo";
    const commandArgs = process.platform === "darwin"
      ? ["-p", macosFixtureOnlyProfile, "cargo", ...cargoArgs]
      : cargoArgs;
    if (process.platform !== "darwin" && options.networkIsolated !== true) {
      throw new Error("frozen Rust capture requires an enforced network-isolated runner on this platform");
    }
    const result = spawnSync(command, commandArgs, {
      cwd: worktree,
      encoding: "utf8",
      env: {
        ...environment,
        CARGO_NET_OFFLINE: "true",
      },
      maxBuffer: 128 * 1024 * 1024,
      timeout: options.timeoutMs ?? 30 * 60 * 1000,
    });
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    const tests = parsePassedTests(`${stdout}\n${stderr}`);
    const proofManifest = JSON.parse(readFileSync(join(root, "reference/parity/proofs.json"), "utf8"));
    const requiredOracleTests = [...new Set(
      proofManifest.proofs.map((proof) => proof.oracle_test).filter(Boolean),
    )].sort();
    const missingOracleTests = requiredOracleTests.filter((requested) =>
      tests.filter((name) => name === requested || name.endsWith(`::${requested}`)).length !== 1);
    const secrets = secretMatches(`${prebuild.stdout ?? ""}\n${prebuild.stderr ?? ""}\n${stdout}\n${stderr}`);
    if (result.status !== 0 || result.signal || tests.length === 0 || missingOracleTests.length > 0) {
      throw new Error(`frozen Rust suite failed: exit=${result.status} signal=${result.signal ?? "none"} passed=${tests.length} missing_oracles=${missingOracleTests.join(",") || "none"}\nstdout:\n${stdout.slice(-4000)}\nstderr:\n${stderr.slice(-4000)}`);
    }
    return {
      schema_version: "1.0",
      protocol: "koni.rust-semantic-suite.v1",
      oracle: {
        tag: model.fingerprint.tag.name,
        commit: model.fingerprint.tag.commit,
        tree: model.fingerprint.tag.tree,
      },
      isolation: {
        detached_oracle_worktree: true,
        temporary_home: true,
        provider_calls: 0,
        live_project_mutations: 0,
        network: "fixture_only",
        test_network: "loopback_only",
        network_enforcement: process.platform === "darwin"
          ? "sandbox-exec deny network* with explicit localhost bind/inbound/outbound allowance"
          : "caller-attested fixture-only namespace",
        sandbox_incompatible_exclusions: excluded,
      },
      build_command: ["cargo", ...prebuildArgs],
      command: ["cargo", ...cargoArgs],
      outcome: {
        exit_code: result.status,
        signal: null,
        timed_out: false,
        semantic_test_list_sha256: sha256(`${tests.join("\n")}\n`),
      },
      passed_tests: tests,
      secret_scan: { passed: secrets.length === 0, matches: secrets },
    };
  } finally {
    try { execFileSync("git", ["-C", root, "worktree", "remove", "--force", worktree], { stdio: "ignore" }); }
    catch {}
    rmSync(temp, { recursive: true, force: true });
  }
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    const capture = captureFrozenRustSuite();
    const outputIndex = process.argv.indexOf("--output");
    if (outputIndex >= 0) {
      const output = process.argv[outputIndex + 1];
      if (output === undefined || output.startsWith("-") || outputIndex + 2 !== process.argv.length) {
        throw new Error("--output requires exactly one path");
      }
      writeFileSync(resolve(output), `${JSON.stringify(capture, null, 2)}\n`, { flag: "w", mode: 0o600 });
      process.stdout.write(`Wrote frozen Rust semantic suite (${capture.passed_tests.length} tests).\n`);
    } else {
      process.stdout.write(`${JSON.stringify(capture, null, 2)}\n`);
    }
  } catch (error) {
    process.stderr.write(`ERROR ${error.message}\n`);
    process.exitCode = 1;
  }
}
