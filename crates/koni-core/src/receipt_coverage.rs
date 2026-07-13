use std::collections::{BTreeMap, BTreeSet, VecDeque};

use serde_json::Value;

use crate::config::{ReceiptCoverageDef, ReceiptCoverageMode};
use crate::expr::TraverseDirection;
use crate::graph::{Graph, Node, NodeId, normalized_hash};
use crate::state::Ticket;

const MAX_DIAGNOSTICS: usize = 8;

pub(crate) fn candidate_ids_from_ticket(
    ticket: &Ticket,
    contract: &ReceiptCoverageDef,
    graph: &Graph,
) -> BTreeSet<NodeId> {
    let mut touched = BTreeSet::new();
    for delta in ticket
        .outputs
        .iter()
        .filter_map(|output| output.typed.get("graph_delta"))
    {
        for field in [
            "upsert",
            "add_nodes",
            "added_nodes",
            "nodes",
            "update_nodes",
            "updated_nodes",
        ] {
            touched.extend(
                delta
                    .get(field)
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|node| node.get("id").and_then(Value::as_str))
                    .map(ToOwned::to_owned),
            );
        }
        for field in ["add_edges", "added_edges", "edges"] {
            touched.extend(
                delta
                    .get(field)
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|edge| edge.get("source").and_then(Value::as_str))
                    .map(ToOwned::to_owned),
            );
        }
    }
    touched.retain(|id| {
        graph
            .node(id)
            .is_some_and(|node| contract.candidate_node_types.contains(&node.node_type))
    });
    touched
}

pub(crate) fn errors(
    contract: &ReceiptCoverageDef,
    target_ids: &[NodeId],
    candidate_ids: &BTreeSet<NodeId>,
    graph: &Graph,
    receipts: &[Value],
) -> Vec<String> {
    let mut diagnostics = Diagnostics::default();
    let required = required_nodes(contract, target_ids, graph);
    if required.is_empty() {
        diagnostics.push("the configured target traversal reached no required nodes");
    }
    if candidate_ids.is_empty() {
        diagnostics.push("the current ticket delta contains no configured candidate nodes");
    }

    let candidates = candidate_ids
        .iter()
        .filter_map(|id| graph.node(id))
        .collect::<Vec<_>>();
    let mut links_by_candidate = BTreeMap::new();
    let mut linked = BTreeSet::new();
    for (index, candidate) in candidates.iter().enumerate() {
        let raw_links = candidate
            .edges
            .get(&contract.candidate_link_relation)
            .cloned()
            .unwrap_or_default();
        let links = raw_links.iter().cloned().collect::<BTreeSet<_>>();
        if raw_links.len() != links.len() {
            diagnostics.push(format!(
                "candidate #{} repeats a {} link",
                index + 1,
                contract.candidate_link_relation
            ));
        }
        linked.extend(links.iter().cloned());
        links_by_candidate.insert(candidate.id.as_str(), links);
    }

    let missing = required.difference(&linked).count();
    if missing > 0 {
        diagnostics.push(format!(
            "candidate {} links omit {missing} required node(s)",
            contract.candidate_link_relation
        ));
    }
    let extra = linked.difference(&required).count();
    if contract.coverage == ReceiptCoverageMode::Exact && extra > 0 {
        diagnostics.push(format!(
            "candidate {} links include {extra} node(s) outside the exact required set",
            contract.candidate_link_relation
        ));
    }

    // At-least coverage permits extra links, but every linked node is still a
    // provenance assertion and receives the same exact receipt validation.
    let nodes_to_bind = required.union(&linked).cloned().collect::<BTreeSet<_>>();
    let mut expected_receipts = BTreeMap::new();
    for (index, node_id) in nodes_to_bind.iter().enumerate() {
        let bound = receipts
            .iter()
            .filter(|receipt| explicitly_targets(receipt, node_id))
            .max_by_key(|receipt| order_key(receipt));
        let Some(receipt) = bound else {
            diagnostics.push(format!(
                "required node #{} has no bound {}",
                index + 1,
                contract.receipt_type
            ));
            continue;
        };
        let Some(receipt_id) = receipt.get("id").and_then(Value::as_str) else {
            diagnostics.push(format!(
                "required node #{} latest receipt has no identity",
                index + 1
            ));
            continue;
        };
        if receipts
            .iter()
            .filter(|candidate| candidate.get("id").and_then(Value::as_str) == Some(receipt_id))
            .count()
            != 1
        {
            diagnostics.push(format!(
                "required node #{} latest receipt identity is not unique",
                index + 1
            ));
        }
        expected_receipts.insert(node_id.clone(), receipt_id.to_owned());
        if !receipt
            .get("status")
            .and_then(Value::as_str)
            .is_some_and(|status| {
                contract
                    .receipt_statuses
                    .iter()
                    .any(|allowed| allowed == status)
            })
        {
            diagnostics.push(format!(
                "required node #{} latest {} has a disallowed status",
                index + 1,
                contract.receipt_type
            ));
        }
        let current = match receipt.get("_command_current").and_then(Value::as_bool) {
            // Command receipts bind semantic node projections, not whole-node
            // hashes. Their durable execution snapshot and semantic target
            // bindings have already been recomputed by the receipt loader;
            // never reinterpret them as a legacy receipt here.
            Some(command_current) => command_current,
            None => graph.node(node_id).is_some_and(|node| {
                let expected_hash = normalized_hash(node);
                receipt
                    .get("target_hashes")
                    .and_then(Value::as_object)
                    .and_then(|hashes| hashes.get(node_id))
                    .and_then(Value::as_str)
                    == Some(expected_hash.as_str())
            }),
        };
        if !current {
            diagnostics.push(format!(
                "required node #{} latest {} is stale or lacks an exact target hash",
                index + 1,
                contract.receipt_type
            ));
        }
        if receipt
            .get("_input_binding_current")
            .and_then(Value::as_bool)
            == Some(false)
        {
            diagnostics.push(format!(
                "required node #{} latest {} is stale for its current command inputs",
                index + 1,
                contract.receipt_type
            ));
        }
    }

    for (candidate_index, candidate) in candidates.iter().enumerate() {
        let links = &links_by_candidate[candidate.id.as_str()];
        validate_candidate(
            contract,
            candidate,
            candidate_index,
            links,
            &expected_receipts,
            &mut diagnostics,
        );
    }
    diagnostics.finish()
}

fn validate_candidate(
    contract: &ReceiptCoverageDef,
    candidate: &Node,
    candidate_index: usize,
    links: &BTreeSet<NodeId>,
    expected_receipts: &BTreeMap<NodeId, String>,
    diagnostics: &mut Diagnostics,
) {
    let disposition_value = candidate.field_owned(&contract.disposition_map_path);
    let Some(dispositions) = disposition_value.as_ref().and_then(Value::as_object) else {
        diagnostics.push(format!(
            "candidate #{} has no object at {}",
            candidate_index + 1,
            contract.disposition_map_path
        ));
        return;
    };
    let disposition_keys = dispositions.keys().cloned().collect::<BTreeSet<_>>();
    let missing_dispositions = links.difference(&disposition_keys).count();
    if missing_dispositions > 0 {
        diagnostics.push(format!(
            "candidate #{} lacks {missing_dispositions} linked-node disposition(s)",
            candidate_index + 1
        ));
    }
    let extra_dispositions = disposition_keys.difference(links).count();
    if extra_dispositions > 0 {
        diagnostics.push(format!(
            "candidate #{} has {extra_dispositions} disposition(s) without a matching link",
            candidate_index + 1
        ));
    }

    for (link_index, node_id) in links.iter().enumerate() {
        let Some(entry) = dispositions.get(node_id) else {
            continue;
        };
        if !entry.is_object() {
            diagnostics.push(format!(
                "candidate #{} disposition #{} is not an object",
                candidate_index + 1,
                link_index + 1
            ));
            continue;
        }
        let disposition =
            value_at_path(entry, &contract.disposition.value_path).and_then(Value::as_str);
        if disposition.is_none_or(|value| {
            !contract
                .disposition
                .allowed_values
                .iter()
                .any(|allowed| allowed == value)
        }) {
            diagnostics.push(format!(
                "candidate #{} disposition #{} has a missing or disallowed value",
                candidate_index + 1,
                link_index + 1
            ));
        }
        let cited_receipt =
            value_at_path(entry, &contract.disposition.receipt_id_path).and_then(Value::as_str);
        if expected_receipts
            .get(node_id)
            .is_none_or(|expected| cited_receipt != Some(expected.as_str()))
        {
            diagnostics.push(format!(
                "candidate #{} disposition #{} does not cite the exact latest receipt",
                candidate_index + 1,
                link_index + 1
            ));
        }
        if value_at_path(entry, &contract.disposition.rationale_path)
            .and_then(Value::as_str)
            .is_none_or(|rationale| rationale.trim().is_empty())
        {
            diagnostics.push(format!(
                "candidate #{} disposition #{} has a blank rationale",
                candidate_index + 1,
                link_index + 1
            ));
        }
    }

    if let Some(path) = &contract.receipt_refs_path {
        validate_receipt_refs(
            candidate,
            candidate_index,
            path,
            links,
            expected_receipts,
            diagnostics,
        );
    }
}

fn validate_receipt_refs(
    candidate: &Node,
    candidate_index: usize,
    path: &str,
    links: &BTreeSet<NodeId>,
    expected_receipts: &BTreeMap<NodeId, String>,
    diagnostics: &mut Diagnostics,
) {
    let raw_refs = candidate.field_owned(path);
    let refs = raw_refs.as_ref().and_then(Value::as_array).map(|items| {
        items
            .iter()
            .filter_map(Value::as_str)
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>()
    });
    let Some(refs) = refs.filter(|refs| {
        raw_refs
            .as_ref()
            .and_then(Value::as_array)
            .is_some_and(|items| refs.len() == items.len())
    }) else {
        diagnostics.push(format!(
            "candidate #{} has a non-string receipt reference list at {path}",
            candidate_index + 1
        ));
        return;
    };
    let ref_set = refs.iter().cloned().collect::<BTreeSet<_>>();
    if ref_set.len() != refs.len() {
        diagnostics.push(format!(
            "candidate #{} repeats a receipt reference",
            candidate_index + 1
        ));
    }
    let expected = links
        .iter()
        .filter_map(|node_id| expected_receipts.get(node_id))
        .cloned()
        .collect::<BTreeSet<_>>();
    let missing_refs = expected.difference(&ref_set).count();
    let extra_refs = ref_set.difference(&expected).count();
    if missing_refs > 0 || extra_refs > 0 {
        diagnostics.push(format!(
            "candidate #{} receipt references differ from exact linked-node receipts (missing {missing_refs}, extra {extra_refs})",
            candidate_index + 1
        ));
    }
}

fn required_nodes(
    contract: &ReceiptCoverageDef,
    target_ids: &[NodeId],
    graph: &Graph,
) -> BTreeSet<NodeId> {
    let mut seen = target_ids.iter().cloned().collect::<BTreeSet<_>>();
    let mut queue = target_ids
        .iter()
        .cloned()
        .map(|id| (id, 0usize))
        .collect::<VecDeque<_>>();
    let mut required = BTreeSet::new();
    while let Some((current, depth)) = queue.pop_front() {
        if depth >= contract.required_nodes.max_depth {
            continue;
        }
        let mut neighbors = BTreeSet::new();
        for relation in &contract.required_nodes.relations {
            let mut add = |nodes: Vec<&Node>| {
                for node in nodes {
                    neighbors.insert(node.id.clone());
                }
            };
            match contract.required_nodes.direction {
                TraverseDirection::Outgoing => add(graph.outgoing(&current, Some(relation))),
                TraverseDirection::Incoming => add(graph.incoming(&current, Some(relation))),
                TraverseDirection::Both => {
                    add(graph.outgoing(&current, Some(relation)));
                    add(graph.incoming(&current, Some(relation)));
                }
            }
        }
        let next_depth = depth + 1;
        for node in neighbors.into_iter().filter_map(|id| graph.node(&id)) {
            if seen.insert(node.id.clone()) {
                if next_depth >= contract.required_nodes.min_depth
                    && contract.required_nodes.node_types.contains(&node.node_type)
                {
                    required.insert(node.id.clone());
                }
                queue.push_back((node.id.clone(), next_depth));
            }
        }
    }
    required
}

fn explicitly_targets(receipt: &Value, node_id: &str) -> bool {
    receipt
        .get("target_node_ids")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .any(|target| target == node_id)
        || receipt
            .get("target_node_id")
            .or_else(|| receipt.get("target_id"))
            .and_then(Value::as_str)
            == Some(node_id)
}

fn order_key(receipt: &Value) -> (String, String) {
    let timestamp = receipt
        .get("recorded_at")
        .or_else(|| receipt.get("finished_at"))
        .or_else(|| receipt.get("started_at"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let identity = receipt
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    (timestamp, identity)
}

fn value_at_path<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    let mut current = value;
    for segment in path.strip_prefix("$.").unwrap_or(path).split('.') {
        current = current.as_object()?.get(segment)?;
    }
    Some(current)
}

#[derive(Default)]
struct Diagnostics {
    rows: Vec<String>,
    omitted: usize,
}

impl Diagnostics {
    fn push(&mut self, message: impl Into<String>) {
        if self.rows.len() < MAX_DIAGNOSTICS {
            self.rows
                .push(format!("receipt coverage: {}", message.into()));
        } else {
            self.omitted += 1;
        }
    }

    fn finish(mut self) -> Vec<String> {
        if self.omitted > 0 {
            self.rows.push(format!(
                "receipt coverage: {} additional issue(s) omitted from this bounded diagnostic",
                self.omitted
            ));
        }
        self.rows
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn contract() -> ReceiptCoverageDef {
        serde_yaml::from_str(
            r#"
candidate_node_types: [evidence]
required_nodes:
  relations: [claims, experiments, tested_by, target_claims, ablations, runs]
  direction: both
  min_depth: 1
  max_depth: 4
  node_types: [run]
candidate_link_relation: from_runs
coverage: exact
receipt_type: runtime.receipt
receipt_statuses: [passed]
receipt_refs_path: spec.receipt_refs
disposition_map_path: spec.run_dispositions
disposition:
  value_path: disposition
  receipt_id_path: receipt_id
  rationale_path: rationale
  allowed_values: [supports, contradicts, neutral, out_of_scope]
"#,
        )
        .unwrap()
    }

    fn node(id: &str, node_type: &str, spec: Value) -> Node {
        let mut node = Node::new(node_type, id, spec);
        node.id = id.to_owned();
        node
    }

    fn base_graph() -> Graph {
        let mut graph = Graph::default();
        let mut claim_a = node("claim-a", "claim", json!({}));
        claim_a
            .edges
            .insert("tested_by".to_owned(), vec!["experiment".to_owned()]);
        let mut claim_b = node("claim-b", "claim", json!({}));
        claim_b
            .edges
            .insert("tested_by".to_owned(), vec!["experiment".to_owned()]);
        let mut experiment = node("experiment", "experiment", json!({}));
        experiment.edges.insert(
            "target_claims".to_owned(),
            vec!["claim-a".to_owned(), "claim-b".to_owned()],
        );
        experiment.edges.insert(
            "runs".to_owned(),
            vec!["run-a".to_owned(), "run-b".to_owned()],
        );
        let mut run_a = node("run-a", "run", json!({"revision": 1}));
        run_a
            .edges
            .insert("uses".to_owned(), vec!["experiment".to_owned()]);
        let mut run_b = node("run-b", "run", json!({"revision": 1}));
        run_b
            .edges
            .insert("uses".to_owned(), vec!["experiment".to_owned()]);
        let mut evidence = node(
            "evidence",
            "evidence",
            json!({
                "receipt_refs": ["receipt-a", "receipt-b"],
                "run_dispositions": {
                    "run-a": {
                        "disposition": "supports",
                        "receipt_id": "receipt-a",
                        "rationale": "Observed the declared outcome in the first run."
                    },
                    "run-b": {
                        "disposition": "neutral",
                        "receipt_id": "receipt-b",
                        "rationale": "The second observation did not distinguish outcomes."
                    }
                }
            }),
        );
        evidence.edges.insert(
            "from_runs".to_owned(),
            vec!["run-a".to_owned(), "run-b".to_owned()],
        );
        evidence.edges.insert(
            "supports".to_owned(),
            vec!["claim-a".to_owned(), "claim-b".to_owned()],
        );
        for node in [claim_a, claim_b, experiment, run_a, run_b, evidence] {
            graph.insert(node).unwrap();
        }
        graph
    }

    fn receipt(id: &str, node_id: &str, graph: &Graph, recorded_at: &str) -> Value {
        json!({
            "id": id,
            "receipt_type": "runtime.receipt",
            "status": "passed",
            "recorded_at": recorded_at,
            "target_node_ids": [node_id],
            "target_hashes": {node_id: normalized_hash(graph.node(node_id).unwrap())}
        })
    }

    fn base_receipts(graph: &Graph) -> Vec<Value> {
        vec![
            receipt("receipt-a", "run-a", graph, "2026-01-01T00:00:00Z"),
            receipt("receipt-b", "run-b", graph, "2026-01-01T00:00:01Z"),
        ]
    }

    fn validate(graph: &Graph, receipts: &[Value]) -> Vec<String> {
        errors(
            &contract(),
            &["claim-a".to_owned()],
            &BTreeSet::from(["evidence".to_owned()]),
            graph,
            receipts,
        )
    }

    #[test]
    fn exact_multi_run_shared_experiment_coverage_passes() {
        let graph = base_graph();
        assert_eq!(
            validate(&graph, &base_receipts(&graph)),
            Vec::<String>::new()
        );
    }

    #[test]
    fn rejects_missing_and_extra_coverage() {
        let mut missing = base_graph();
        missing
            .node_mut("evidence")
            .unwrap()
            .edges
            .get_mut("from_runs")
            .unwrap()
            .retain(|id| id != "run-b");
        missing.node_mut("evidence").unwrap().spec["run_dispositions"]
            .as_object_mut()
            .unwrap()
            .remove("run-b");
        missing.node_mut("evidence").unwrap().spec["receipt_refs"] = json!(["receipt-a"]);
        assert!(
            validate(&missing, &base_receipts(&missing))
                .iter()
                .any(|error| error.contains("omit 1 required"))
        );

        let mut extra = base_graph();
        extra
            .insert(node("run-extra", "run", json!({"revision": 1})))
            .unwrap();
        extra
            .node_mut("evidence")
            .unwrap()
            .edges
            .get_mut("from_runs")
            .unwrap()
            .push("run-extra".to_owned());
        extra.node_mut("evidence").unwrap().spec["run_dispositions"]["run-extra"] = json!({
            "disposition": "out_of_scope",
            "receipt_id": "receipt-extra",
            "rationale": "This run is outside the claim context."
        });
        extra.node_mut("evidence").unwrap().spec["receipt_refs"] =
            json!(["receipt-a", "receipt-b", "receipt-extra"]);
        let mut receipts = base_receipts(&extra);
        receipts.push(receipt(
            "receipt-extra",
            "run-extra",
            &extra,
            "2026-01-01T00:00:02Z",
        ));
        assert!(
            validate(&extra, &receipts)
                .iter()
                .any(|error| error.contains("outside the exact required set"))
        );
    }

    #[test]
    fn rejects_stale_wrong_receipt_disposition_and_blank_rationale() {
        let graph = base_graph();
        let receipts = base_receipts(&graph);

        let mut stale = graph.clone();
        stale.node_mut("run-a").unwrap().spec["revision"] = json!(2);
        assert!(
            validate(&stale, &receipts)
                .iter()
                .any(|error| error.contains("stale"))
        );

        let mut wrong_receipt = graph.clone();
        wrong_receipt.node_mut("evidence").unwrap().spec["run_dispositions"]["run-a"]["receipt_id"] =
            json!("receipt-old");
        assert!(
            validate(&wrong_receipt, &receipts)
                .iter()
                .any(|error| error.contains("exact latest receipt"))
        );

        let mut wrong_disposition = graph.clone();
        wrong_disposition.node_mut("evidence").unwrap().spec["run_dispositions"]["run-a"]["disposition"] =
            json!("proved");
        assert!(
            validate(&wrong_disposition, &receipts)
                .iter()
                .any(|error| error.contains("disallowed value"))
        );

        let mut blank = graph.clone();
        blank.node_mut("evidence").unwrap().spec["run_dispositions"]["run-a"]["rationale"] =
            json!("  ");
        assert!(
            validate(&blank, &receipts)
                .iter()
                .any(|error| error.contains("blank rationale"))
        );
    }

    #[test]
    fn latest_receipt_supersession_and_new_run_invalidate_existing_evidence() {
        let graph = base_graph();
        let mut superseded = base_receipts(&graph);
        superseded.push(receipt(
            "receipt-a-new",
            "run-a",
            &graph,
            "2026-01-02T00:00:00Z",
        ));
        let superseded_errors = validate(&graph, &superseded);
        assert!(
            superseded_errors
                .iter()
                .any(|error| error.contains("exact latest receipt"))
        );
        assert!(
            superseded_errors
                .iter()
                .any(|error| error.contains("receipt references differ"))
        );

        let mut expanded = graph.clone();
        expanded
            .insert(node("run-c", "run", json!({"revision": 1})))
            .unwrap();
        expanded
            .node_mut("experiment")
            .unwrap()
            .edges
            .get_mut("runs")
            .unwrap()
            .push("run-c".to_owned());
        let mut expanded_receipts = base_receipts(&expanded);
        expanded_receipts.push(receipt(
            "receipt-c",
            "run-c",
            &expanded,
            "2026-01-02T00:00:01Z",
        ));
        assert!(
            validate(&expanded, &expanded_receipts)
                .iter()
                .any(|error| error.contains("omit 1 required"))
        );
    }

    #[test]
    fn changed_command_input_fingerprint_invalidates_evidence_without_run_mutation() {
        let graph = base_graph();
        let mut receipts = base_receipts(&graph);
        receipts[0]["_input_binding_current"] = json!(false);
        assert!(
            validate(&graph, &receipts)
                .iter()
                .any(|error| error.contains("current command inputs"))
        );
    }

    #[test]
    fn decorated_command_receipts_use_semantic_target_currentness_without_legacy_downgrade() {
        let graph = base_graph();
        let mut receipts = base_receipts(&graph);
        receipts[0]["target_hashes"]["run-a"] = json!("sha256:semantic-projection");
        receipts[0]["_command_current"] = json!(true);
        receipts[0]["_input_binding_current"] = json!(true);
        assert_eq!(
            validate(&graph, &receipts),
            Vec::<String>::new(),
            "a fully decorated command receipt owns semantic target validation"
        );

        receipts[0]["_command_current"] = json!(false);
        assert!(
            validate(&graph, &receipts)
                .iter()
                .any(|error| error.contains("stale"))
        );

        receipts[0]
            .as_object_mut()
            .unwrap()
            .remove("_command_current");
        receipts[0]
            .as_object_mut()
            .unwrap()
            .remove("_input_binding_current");
        assert!(
            validate(&graph, &receipts)
                .iter()
                .any(|error| error.contains("stale")),
            "an undecorated row must retain legacy whole-node hash semantics"
        );
    }

    #[test]
    fn exact_coverage_includes_descendant_ablation_runs() {
        let mut graph = base_graph();
        let mut ablation = node("ablation", "ablation", json!({}));
        ablation
            .edges
            .insert("runs".to_owned(), vec!["ablation-run".to_owned()]);
        graph.insert(ablation).unwrap();
        graph
            .insert(node("ablation-run", "run", json!({"revision": 1})))
            .unwrap();
        graph
            .node_mut("experiment")
            .unwrap()
            .edges
            .insert("ablations".to_owned(), vec!["ablation".to_owned()]);
        let mut receipts = base_receipts(&graph);
        receipts.push(receipt(
            "ablation-receipt",
            "ablation-run",
            &graph,
            "2026-01-01T00:00:02Z",
        ));
        assert!(
            validate(&graph, &receipts)
                .iter()
                .any(|error| error.contains("omit 1 required"))
        );

        graph
            .node_mut("evidence")
            .unwrap()
            .edges
            .get_mut("from_runs")
            .unwrap()
            .push("ablation-run".to_owned());
        graph.node_mut("evidence").unwrap().spec["run_dispositions"]["ablation-run"] = json!({
            "disposition": "neutral",
            "receipt_id": "ablation-receipt",
            "rationale": "The ablation observation is included without overclaiming."
        });
        graph.node_mut("evidence").unwrap().spec["receipt_refs"] =
            json!(["receipt-a", "receipt-b", "ablation-receipt"]);
        assert_eq!(validate(&graph, &receipts), Vec::<String>::new());
    }

    #[test]
    fn rejects_extra_disposition_and_bounds_diagnostics_without_ids() {
        let mut graph = base_graph();
        graph.node_mut("evidence").unwrap().spec["run_dispositions"]["not-linked"] = json!({
            "disposition": "neutral",
            "receipt_id": "not-a-receipt",
            "rationale": "Not linked."
        });
        let diagnostics = validate(&graph, &base_receipts(&graph));
        assert!(
            diagnostics
                .iter()
                .any(|error| error.contains("without a matching link"))
        );
        assert!(diagnostics.len() <= MAX_DIAGNOSTICS + 1);
        assert!(
            diagnostics
                .iter()
                .all(|error| !error.contains("claim-a") && !error.contains("run-a"))
        );
    }
}
