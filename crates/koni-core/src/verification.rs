use std::collections::BTreeMap;

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use crate::config::{CheckDef, CheckKind, ComposedReplayPolicy, ProcessEffect, ReceiptFreshness};
use crate::error::{KoniError, Result};
use crate::graph::normalized_hash;
use crate::state::Ticket;

/// One compiler-selected check that must be replayed against the composed run
/// tree after target synchronization. The contract hash binds the exact
/// ticket, step, target/scope, and configured check semantics.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct ComposedVerificationCheck {
    pub ticket_id: String,
    pub step_id: String,
    pub check_id: String,
    pub contract_hash: String,
    /// Present only for an exact member compiled from a graph-selected
    /// composite check. Legacy command selections intentionally omit these
    /// fields so their serialized plan and contract remain unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_check_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_node_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub member_contract_hash: Option<String>,
}

/// Select the latest occurrence of every distinct current command check in a
/// terminal ticket. Legacy checks are distinct by ticket/check; compiled
/// graph-set members are distinct by ticket/source-node/child-check.
/// Historical receipts and checks with an explicit replay opt-out remain
/// causal evidence and are deliberately not rerun. Verification checkpoints
/// never execute side-effecting commands implicitly.
pub(crate) fn composed_verification_plan(
    checks: &IndexMap<String, CheckDef>,
    tickets: &[Ticket],
    terminal_state: &str,
) -> Result<Vec<ComposedVerificationCheck>> {
    // `None` is the legacy check identity. `Some(source_node_id)` is an exact
    // graph-set member, so two proof nodes backed by the same child check do
    // not collapse into one replay.
    let mut selected =
        BTreeMap::<(String, Option<String>, String), ComposedVerificationCheck>::new();
    for ticket in tickets
        .iter()
        .filter(|ticket| ticket.status == terminal_state)
    {
        for step in ticket.workflow.iter().filter(|step| step.required) {
            for check_id in &step.validation_checks {
                let check = checks.get(check_id).ok_or_else(|| {
                    KoniError::Profile(format!(
                        "terminal ticket {} references missing verification check {check_id}",
                        ticket.id
                    ))
                })?;
                if check.kind != CheckKind::Command
                    || check.receipt_freshness == ReceiptFreshness::Historical
                    || check.composed_replay == ComposedReplayPolicy::Never
                {
                    continue;
                }
                if check.effect != ProcessEffect::ReadOnly {
                    return Err(KoniError::Profile(format!(
                        "composed verification check {check_id} on ticket {} must be read_only, not {:?}",
                        ticket.id, check.effect
                    )));
                }
                let contract_hash = normalized_hash(&(
                    ticket.id.as_str(),
                    &ticket.target_nodes,
                    &ticket.scope,
                    step.id.as_str(),
                    step.context_hash.as_str(),
                    check,
                ));
                selected.insert(
                    (ticket.id.clone(), None, check_id.clone()),
                    ComposedVerificationCheck {
                        ticket_id: ticket.id.clone(),
                        step_id: step.id.clone(),
                        check_id: check_id.clone(),
                        contract_hash,
                        parent_check_id: None,
                        source_node_id: None,
                        member_contract_hash: None,
                    },
                );
            }

            for compiled_set in &step.compiled_check_sets {
                if !step
                    .validation_checks
                    .iter()
                    .any(|check_id| check_id == &compiled_set.parent_check_id)
                {
                    return Err(KoniError::Profile(format!(
                        "terminal ticket {} step {} carries unscheduled compiled check set {}",
                        ticket.id, step.id, compiled_set.parent_check_id
                    )));
                }
                let parent = checks.get(&compiled_set.parent_check_id).ok_or_else(|| {
                    KoniError::Profile(format!(
                        "terminal ticket {} step {} references missing composite verification check {}",
                        ticket.id, step.id, compiled_set.parent_check_id
                    ))
                })?;
                if parent.kind != CheckKind::Composite {
                    return Err(KoniError::Profile(format!(
                        "terminal ticket {} step {} compiled check set {} no longer names a composite check",
                        ticket.id, step.id, compiled_set.parent_check_id
                    )));
                }
                if compiled_set.parent_check_hash != normalized_hash(parent) {
                    return Err(KoniError::Profile(format!(
                        "terminal ticket {} step {} composite check {} changed after its member set was compiled",
                        ticket.id, step.id, compiled_set.parent_check_id
                    )));
                }

                for member in &compiled_set.members {
                    let child = checks.get(&member.child_check_id).ok_or_else(|| {
                        KoniError::Profile(format!(
                            "terminal ticket {} step {} composite check {} references missing child check {}",
                            ticket.id,
                            step.id,
                            compiled_set.parent_check_id,
                            member.child_check_id
                        ))
                    })?;
                    if child.kind != CheckKind::Command {
                        return Err(KoniError::Profile(format!(
                            "composite verification child {} for source node {} on ticket {} must be a command check",
                            member.child_check_id, member.source_node_id, ticket.id
                        )));
                    }
                    if member.child_check_hash != normalized_hash(child) {
                        return Err(KoniError::Profile(format!(
                            "composite verification child {} for source node {} on ticket {} changed after compilation",
                            member.child_check_id, member.source_node_id, ticket.id
                        )));
                    }
                    if child.receipt_freshness == ReceiptFreshness::Historical
                        || child.composed_replay == ComposedReplayPolicy::Never
                    {
                        continue;
                    }
                    if child.effect != ProcessEffect::ReadOnly {
                        return Err(KoniError::Profile(format!(
                            "composed verification child {} for source node {} on ticket {} must be read_only, not {:?}",
                            member.child_check_id, member.source_node_id, ticket.id, child.effect
                        )));
                    }

                    // This new contract binds both the complete compiled set
                    // and the exact member. In particular, the member hash
                    // transitively carries selector/source/argv/cwd/path
                    // identity without adding another serialized plan field.
                    let contract_hash = normalized_hash(&(
                        ticket.id.as_str(),
                        &ticket.target_nodes,
                        &ticket.scope,
                        step.id.as_str(),
                        step.context_hash.as_str(),
                        parent,
                        compiled_set.contract_hash.as_str(),
                        member.contract_hash.as_str(),
                        child,
                    ));
                    selected.insert(
                        (
                            ticket.id.clone(),
                            Some(member.source_node_id.clone()),
                            member.child_check_id.clone(),
                        ),
                        ComposedVerificationCheck {
                            ticket_id: ticket.id.clone(),
                            step_id: step.id.clone(),
                            check_id: member.child_check_id.clone(),
                            contract_hash,
                            parent_check_id: Some(compiled_set.parent_check_id.clone()),
                            source_node_id: Some(member.source_node_id.clone()),
                            member_contract_hash: Some(member.contract_hash.clone()),
                        },
                    );
                }
            }
        }
    }
    if selected.is_empty() {
        return Err(KoniError::Workflow(
            "verification checkpoint has no replayable current read-only command proof".to_owned(),
        ));
    }
    Ok(selected.into_values().collect())
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use serde_json::json;

    use super::*;
    use crate::config::ProfileCompiler;

    fn check(value: serde_json::Value) -> CheckDef {
        serde_json::from_value(value).expect("check fixture deserializes")
    }

    fn ticket(workflow: serde_json::Value) -> Ticket {
        serde_json::from_value(json!({
            "schema_version": "1.0",
            "id": "TK-proof",
            "operation": "implement-change",
            "status": "closed",
            "title": "Implement bounded behavior",
            "target_nodes": ["change-a"],
            "scope": {"read_paths": ["src"], "write_paths": ["src"]},
            "source_state_key": "planned",
            "target_state_key": "implemented",
            "profile_hash": "sha256:test",
            "rule_id": "change.implement",
            "workflow": workflow
        }))
        .expect("ticket fixture deserializes")
    }

    fn compiled_member(
        checks: &IndexMap<String, CheckDef>,
        source_node_id: &str,
        child_check_id: &str,
        contract_hash: &str,
    ) -> serde_json::Value {
        json!({
            "source_node_id": source_node_id,
            "source_node_type": "proof",
            "source_semantic_hash": format!("sha256:semantic-{source_node_id}"),
            "child_check_id": child_check_id,
            "child_check_hash": normalized_hash(&checks[child_check_id]),
            "argv": checks[child_check_id].argv.clone(),
            "working_directory": ".",
            "source_paths": [format!("tests/{source_node_id}.rs")],
            "covered_paths": ["src/lib.rs"],
            "contract_hash": contract_hash,
        })
    }

    fn compiled_set(
        checks: &IndexMap<String, CheckDef>,
        members: Vec<serde_json::Value>,
        contract_hash: &str,
    ) -> serde_json::Value {
        json!({
            "schema_version": "1.0",
            "parent_check_id": "promotion-set",
            "parent_check_hash": normalized_hash(&checks["promotion-set"]),
            "selector_hash": "sha256:selector",
            "anchor_nodes": ["change-a"],
            "anchor_hashes": {"change-a": "sha256:change-a"},
            "selection_hash": "sha256:selection",
            "members": members,
            "contract_hash": contract_hash,
        })
    }

    #[test]
    fn plan_skips_historical_red_and_selects_the_latest_green_step() {
        let checks = IndexMap::from([
            (
                "expected-red".to_owned(),
                check(json!({
                    "id": "expected-red",
                    "kind": "command",
                    "receipt_type": "expected_red",
                    "receipt_freshness": "historical"
                })),
            ),
            (
                "scientific-runtime".to_owned(),
                check(json!({
                    "id": "scientific-runtime",
                    "kind": "command",
                    "receipt_type": "runtime.receipt",
                    "effect": "workspace_write",
                    "composed_replay": "never"
                })),
            ),
            (
                "focused-test".to_owned(),
                check(json!({
                    "id": "focused-test",
                    "kind": "command",
                    "receipt_type": "test"
                })),
            ),
        ]);
        let ticket = ticket(json!([
            {"id": "red", "persona": "worker", "validation_checks": ["expected-red"], "context_hash": "ctx-red"},
            {"id": "execute", "persona": "worker", "validation_checks": ["scientific-runtime"], "context_hash": "ctx-runtime"},
            {"id": "baseline", "persona": "worker", "validation_checks": ["focused-test"], "context_hash": "ctx-baseline"},
            {"id": "verify", "persona": "verifier", "validation_checks": ["focused-test"], "context_hash": "ctx-verify"}
        ]));
        let expected_legacy_contract = normalized_hash(&(
            ticket.id.as_str(),
            &ticket.target_nodes,
            &ticket.scope,
            "verify",
            "ctx-verify",
            &checks["focused-test"],
        ));

        let plan = composed_verification_plan(&checks, &[ticket], "closed").unwrap();

        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].check_id, "focused-test");
        assert_eq!(plan[0].step_id, "verify");
        assert_eq!(plan[0].contract_hash, expected_legacy_contract);
        assert_eq!(
            serde_json::to_value(&plan[0]).unwrap(),
            json!({
                "ticket_id": "TK-proof",
                "step_id": "verify",
                "check_id": "focused-test",
                "contract_hash": expected_legacy_contract,
            }),
            "legacy plans must not gain graph-member identity fields"
        );
    }

    #[test]
    fn compiled_members_replay_per_source_and_latest_duplicate_source_wins() {
        let checks = IndexMap::from([
            (
                "promotion-set".to_owned(),
                check(json!({
                    "id": "promotion-set",
                    "kind": "composite",
                    "receipt_type": "proof_set"
                })),
            ),
            (
                "proof-command".to_owned(),
                check(json!({
                    "id": "proof-command",
                    "kind": "command",
                    "argv": ["cargo", "test", "--test", "proof"],
                    "receipt_type": "proof"
                })),
            ),
            (
                "ticket-local".to_owned(),
                check(json!({
                    "id": "ticket-local",
                    "kind": "command",
                    "argv": ["cargo", "test", "--test", "focused"],
                    "receipt_type": "test",
                    "composed_replay": "never"
                })),
            ),
            (
                "expected-red".to_owned(),
                check(json!({
                    "id": "expected-red",
                    "kind": "command",
                    "argv": ["cargo", "test", "--test", "proof"],
                    "receipt_type": "expected_red",
                    "receipt_freshness": "historical"
                })),
            ),
        ]);
        let first_set = compiled_set(
            &checks,
            vec![
                compiled_member(&checks, "proof-a", "proof-command", "sha256:member-a-old"),
                compiled_member(&checks, "proof-b", "proof-command", "sha256:member-b"),
                compiled_member(
                    &checks,
                    "proof-local",
                    "ticket-local",
                    "sha256:member-local",
                ),
                compiled_member(&checks, "proof-red", "expected-red", "sha256:member-red"),
            ],
            "sha256:set-old",
        );
        let latest_set = compiled_set(
            &checks,
            vec![compiled_member(
                &checks,
                "proof-a",
                "proof-command",
                "sha256:member-a-new",
            )],
            "sha256:set-new",
        );
        let ticket = ticket(json!([
            {
                "id": "implement",
                "persona": "worker",
                "validation_checks": ["promotion-set"],
                "compiled_check_sets": [first_set],
                "context_hash": "ctx-implement"
            },
            {
                "id": "verify",
                "persona": "verifier",
                "validation_checks": ["promotion-set"],
                "compiled_check_sets": [latest_set],
                "context_hash": "ctx-verify"
            }
        ]));
        let mut prior_member_contract = ticket.clone();
        prior_member_contract.workflow[1].compiled_check_sets[0].members[0].contract_hash =
            "sha256:member-a-prior".to_owned();
        let prior_plan =
            composed_verification_plan(&checks, &[prior_member_contract], "closed").unwrap();

        let plan = composed_verification_plan(&checks, &[ticket], "closed").unwrap();

        assert_eq!(plan.len(), 2, "distinct proof sources must not collapse");
        assert_eq!(plan[0].source_node_id.as_deref(), Some("proof-a"));
        assert_eq!(plan[0].step_id, "verify");
        assert_eq!(
            plan[0].member_contract_hash.as_deref(),
            Some("sha256:member-a-new"),
            "the latest required step wins for the same ticket/source/check identity"
        );
        assert_ne!(
            plan[0].contract_hash, prior_plan[0].contract_hash,
            "the composed contract must transitively bind the exact member contract"
        );
        assert_eq!(plan[1].source_node_id.as_deref(), Some("proof-b"));
        assert_eq!(plan[1].step_id, "implement");
        assert!(plan.iter().all(|selected| {
            selected.parent_check_id.as_deref() == Some("promotion-set")
                && selected.check_id == "proof-command"
        }));
        let serialized = serde_json::to_value(&plan[0]).unwrap();
        assert_eq!(serialized["parent_check_id"], "promotion-set");
        assert_eq!(serialized["source_node_id"], "proof-a");
        assert_eq!(serialized["member_contract_hash"], "sha256:member-a-new");
    }

    #[test]
    fn compiled_member_definition_drift_and_unsafe_replay_fail_closed() {
        let checks = IndexMap::from([
            (
                "promotion-set".to_owned(),
                check(json!({
                    "id": "promotion-set",
                    "kind": "composite",
                    "receipt_type": "proof_set"
                })),
            ),
            (
                "proof-command".to_owned(),
                check(json!({
                    "id": "proof-command",
                    "kind": "command",
                    "argv": ["cargo", "test", "--test", "proof"],
                    "receipt_type": "proof"
                })),
            ),
            (
                "publish".to_owned(),
                check(json!({
                    "id": "publish",
                    "kind": "command",
                    "argv": ["cargo", "publish"],
                    "receipt_type": "published",
                    "effect": "external"
                })),
            ),
        ]);
        let mut stale_member =
            compiled_member(&checks, "proof-a", "proof-command", "sha256:member-a");
        stale_member["child_check_hash"] = json!("sha256:stale");
        let stale_ticket = ticket(json!([{
            "id": "verify",
            "persona": "verifier",
            "validation_checks": ["promotion-set"],
            "compiled_check_sets": [compiled_set(
                &checks,
                vec![stale_member],
                "sha256:set-stale"
            )]
        }]));
        let error = composed_verification_plan(&checks, &[stale_ticket], "closed")
            .unwrap_err()
            .to_string();
        assert!(error.contains("changed after compilation"), "{error}");

        let unsafe_ticket = ticket(json!([{
            "id": "verify",
            "persona": "verifier",
            "validation_checks": ["promotion-set"],
            "compiled_check_sets": [compiled_set(
                &checks,
                vec![compiled_member(
                    &checks,
                    "proof-publish",
                    "publish",
                    "sha256:member-publish"
                )],
                "sha256:set-publish"
            )]
        }]));
        let error = composed_verification_plan(&checks, &[unsafe_ticket], "closed")
            .unwrap_err()
            .to_string();
        assert!(error.contains("must be read_only"), "{error}");
    }

    #[test]
    fn plan_rejects_implicit_side_effects_and_an_empty_current_proof_set() {
        let external = IndexMap::from([(
            "publish".to_owned(),
            check(json!({
                "id": "publish",
                "kind": "command",
                "receipt_type": "published",
                "effect": "external"
            })),
        )]);
        let external_ticket = ticket(json!([
            {"id": "publish", "persona": "worker", "validation_checks": ["publish"]}
        ]));
        let error = composed_verification_plan(&external, &[external_ticket], "closed")
            .unwrap_err()
            .to_string();
        assert!(error.contains("must be read_only"), "{error}");

        let historical = IndexMap::from([(
            "expected-red".to_owned(),
            check(json!({
                "id": "expected-red",
                "kind": "command",
                "receipt_type": "expected_red",
                "receipt_freshness": "historical"
            })),
        )]);
        let historical_ticket = ticket(json!([
            {"id": "red", "persona": "worker", "validation_checks": ["expected-red"]}
        ]));
        let error = composed_verification_plan(&historical, &[historical_ticket], "closed")
            .unwrap_err()
            .to_string();
        assert!(error.contains("no replayable current read-only"), "{error}");
    }

    #[test]
    fn research_experiment_and_gate_paths_select_only_safe_composed_replays() {
        let profile_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join("profiles/research");
        let profile = ProfileCompiler::compile(&profile_root).unwrap();

        let scientific = &profile.checks["scientific-runtime"];
        assert_eq!(scientific.effect, ProcessEffect::WorkspaceWrite);
        assert_eq!(scientific.receipt_freshness, ReceiptFreshness::Current);
        assert_eq!(scientific.composed_replay, ComposedReplayPolicy::Never);

        let integrity = &profile.checks["scientific-result-integrity"];
        assert_eq!(integrity.effect, ProcessEffect::ReadOnly);
        assert_eq!(integrity.composed_replay, ComposedReplayPolicy::Required);
        assert_eq!(
            integrity
                .command_source
                .as_ref()
                .map(|source| source.field.as_str()),
            Some("runtime_contract.composed_verification_command")
        );

        let workflow_ticket = |workflow_id: &str, ticket_id: &str| {
            let workflow = &profile.workflows[workflow_id];
            let steps = workflow
                .steps
                .iter()
                .map(|step| {
                    json!({
                        "id": step.id,
                        "persona": step.persona,
                        "required": step.required,
                        "validation_checks": step.checks,
                        "context_hash": format!("ctx-{}", step.id),
                    })
                })
                .collect::<Vec<_>>();
            let mut ticket = ticket(json!(steps));
            ticket.id = ticket_id.to_owned();
            ticket
        };
        let experiment = workflow_ticket("run-experiment-runtime", "TK-experiment");
        let gate = workflow_ticket("run-gate-runtime", "TK-gate");

        let plan =
            composed_verification_plan(&profile.checks, &[experiment, gate], "closed").unwrap();
        let selected = plan
            .iter()
            .map(|check| {
                (
                    check.ticket_id.as_str(),
                    check.step_id.as_str(),
                    check.check_id.as_str(),
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            selected,
            vec![
                ("TK-experiment", "run", "scientific-result-integrity"),
                ("TK-gate", "run", "gate-verifier"),
            ]
        );
        assert!(
            plan.iter()
                .all(|check| check.check_id != "scientific-runtime"),
            "the empirical command must never be replayed implicitly"
        );
    }
}
