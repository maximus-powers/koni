//! Profiles shipped inside the CLI binary.
//!
//! `include_bytes!` is intentional: an installed `koni` executable must not
//! depend on the source checkout (or on the fixture paths used to build it).

pub(crate) struct EmbeddedFile {
    pub(crate) path: &'static str,
    pub(crate) contents: &'static [u8],
}

macro_rules! embedded {
    ($path:literal, $source:literal) => {
        EmbeddedFile {
            path: $path,
            contents: include_bytes!($source),
        }
    };
}

pub(crate) static SOFTWARE: &[EmbeddedFile] = &[
    embedded!("actions.yaml", "../templates/software/actions.yaml"),
    embedded!("checks.yaml", "../templates/software/checks.yaml"),
    embedded!("cockpit.yaml", "../templates/software/cockpit.yaml"),
    embedded!("graph.yaml", "../templates/software/graph.yaml"),
    embedded!("lifecycle.yaml", "../templates/software/lifecycle.yaml"),
    embedded!("operations.yaml", "../templates/software/operations.yaml"),
    embedded!("personas.yaml", "../templates/software/personas.yaml"),
    embedded!("reports.yaml", "../templates/software/reports.yaml"),
    embedded!("profile.yaml", "../templates/software/profile.yaml"),
    embedded!("project.yaml", "../templates/software/project.yaml"),
    embedded!("rules.yaml", "../templates/software/rules.yaml"),
    embedded!(
        "run-types/bug-fix.yaml",
        "../templates/software/run-types/bug-fix.yaml"
    ),
    embedded!(
        "run-types/large.yaml",
        "../templates/software/run-types/large.yaml"
    ),
    embedded!(
        "run-types/medium.yaml",
        "../templates/software/run-types/medium.yaml"
    ),
    embedded!(
        "run-types/new-feature.yaml",
        "../templates/software/run-types/new-feature.yaml"
    ),
    embedded!(
        "run-types/small.yaml",
        "../templates/software/run-types/small.yaml"
    ),
    embedded!("workflows.yaml", "../templates/software/workflows.yaml"),
];

/// Project-native Codex custom agents installed beside the Koni profile.
///
/// Paths are relative to `.codex/`, not `.codex/koni/`. Keeping this
/// inventory separate prevents native Codex resources from becoming an
/// implementation detail of the Koni profile tree.
pub(crate) static SOFTWARE_CODEX: &[EmbeddedFile] = &[
    embedded!(
        "agents/architecture-mapper.toml",
        "../templates/codex/software/agents/architecture-mapper.toml"
    ),
    embedded!(
        "agents/change-designer.toml",
        "../templates/codex/software/agents/change-designer.toml"
    ),
    embedded!(
        "agents/contract-designer.toml",
        "../templates/codex/software/agents/contract-designer.toml"
    ),
    embedded!(
        "agents/implementer.toml",
        "../templates/codex/software/agents/implementer.toml"
    ),
    embedded!(
        "agents/integrator.toml",
        "../templates/codex/software/agents/integrator.toml"
    ),
    embedded!(
        "agents/lead.toml",
        "../templates/codex/software/agents/lead.toml"
    ),
    embedded!(
        "agents/reviewer.toml",
        "../templates/codex/software/agents/reviewer.toml"
    ),
    embedded!(
        "agents/risk-analyst.toml",
        "../templates/codex/software/agents/risk-analyst.toml"
    ),
    embedded!(
        "agents/run-planner.toml",
        "../templates/codex/software/agents/run-planner.toml"
    ),
    embedded!(
        "agents/verifier.toml",
        "../templates/codex/software/agents/verifier.toml"
    ),
];

/// Repository-scoped skills shared by every bundled Köni profile.
pub(crate) static SHARED_SKILLS: &[EmbeddedFile] = &[
    embedded!(
        "configure-koni/SKILL.md",
        "../templates/codex/shared/skills/configure-koni/SKILL.md"
    ),
    embedded!(
        "configure-koni/agents/openai.yaml",
        "../templates/codex/shared/skills/configure-koni/agents/openai.yaml"
    ),
    embedded!(
        "configure-koni/references/agents-and-skills.md",
        "../templates/codex/shared/skills/configure-koni/references/agents-and-skills.md"
    ),
    embedded!(
        "configure-koni/references/configuration-layers.md",
        "../templates/codex/shared/skills/configure-koni/references/configuration-layers.md"
    ),
    embedded!(
        "configure-koni/references/discovery-and-approval.md",
        "../templates/codex/shared/skills/configure-koni/references/discovery-and-approval.md"
    ),
    embedded!(
        "configure-koni/references/run-types.md",
        "../templates/codex/shared/skills/configure-koni/references/run-types.md"
    ),
    embedded!(
        "model-koni-work/SKILL.md",
        "../templates/codex/shared/skills/model-koni-work/SKILL.md"
    ),
    embedded!(
        "model-koni-work/agents/openai.yaml",
        "../templates/codex/shared/skills/model-koni-work/agents/openai.yaml"
    ),
    embedded!(
        "model-koni-work/references/empirical-research.md",
        "../templates/codex/shared/skills/model-koni-work/references/empirical-research.md"
    ),
    embedded!(
        "model-koni-work/references/execution-contracts.md",
        "../templates/codex/shared/skills/model-koni-work/references/execution-contracts.md"
    ),
    embedded!(
        "model-koni-work/references/graph-model.md",
        "../templates/codex/shared/skills/model-koni-work/references/graph-model.md"
    ),
    embedded!(
        "model-koni-work/references/rules-and-tickets.md",
        "../templates/codex/shared/skills/model-koni-work/references/rules-and-tickets.md"
    ),
    embedded!(
        "model-koni-work/references/software-projects.md",
        "../templates/codex/shared/skills/model-koni-work/references/software-projects.md"
    ),
    embedded!(
        "operate-koni/SKILL.md",
        "../templates/codex/shared/skills/operate-koni/SKILL.md"
    ),
    embedded!(
        "operate-koni/agents/openai.yaml",
        "../templates/codex/shared/skills/operate-koni/agents/openai.yaml"
    ),
    embedded!(
        "operate-koni/references/operator-surfaces.md",
        "../templates/codex/shared/skills/operate-koni/references/operator-surfaces.md"
    ),
    embedded!(
        "operate-koni/references/recovery.md",
        "../templates/codex/shared/skills/operate-koni/references/recovery.md"
    ),
    embedded!(
        "operate-koni/references/run-lifecycle.md",
        "../templates/codex/shared/skills/operate-koni/references/run-lifecycle.md"
    ),
];

pub(crate) static RESEARCH: &[EmbeddedFile] = &[
    embedded!("README.md", "../templates/research/README.md"),
    embedded!(
        "actions/research.yaml",
        "../templates/research/actions/research.yaml"
    ),
    embedded!(
        "checks/research.yaml",
        "../templates/research/checks/research.yaml"
    ),
    embedded!(
        "cockpit/research.yaml",
        "../templates/research/cockpit/research.yaml"
    ),
    embedded!("graph/edges.yaml", "../templates/research/graph/edges.yaml"),
    embedded!("graph/nodes.yaml", "../templates/research/graph/nodes.yaml"),
    embedded!(
        "operations/research.yaml",
        "../templates/research/operations/research.yaml"
    ),
    embedded!(
        "personas/research.yaml",
        "../templates/research/personas/research.yaml"
    ),
    embedded!("profile.yaml", "../templates/research/profile.yaml"),
    embedded!("project.yaml", "../templates/research/project.yaml"),
    embedded!(
        "reports/research.yaml",
        "../templates/research/reports/research.yaml"
    ),
    embedded!(
        "rules/lifecycle.yaml",
        "../templates/research/rules/lifecycle.yaml"
    ),
    embedded!(
        "rules/research.yaml",
        "../templates/research/rules/research.yaml"
    ),
    embedded!(
        "run-types/large.yaml",
        "../templates/research/run-types/large.yaml"
    ),
    embedded!(
        "run-types/medium.yaml",
        "../templates/research/run-types/medium.yaml"
    ),
    embedded!(
        "run-types/small.yaml",
        "../templates/research/run-types/small.yaml"
    ),
    embedded!(
        "workflows/research.yaml",
        "../templates/research/workflows/research.yaml"
    ),
];

pub(crate) static RESEARCH_CODEX: &[EmbeddedFile] = &[
    embedded!(
        "agents/asset-builder.toml",
        "../templates/codex/research/agents/asset-builder.toml"
    ),
    embedded!(
        "agents/dashboard-reporter.toml",
        "../templates/codex/research/agents/dashboard-reporter.toml"
    ),
    embedded!(
        "agents/evidence-analyst.toml",
        "../templates/codex/research/agents/evidence-analyst.toml"
    ),
    embedded!(
        "agents/experiment-designer.toml",
        "../templates/codex/research/agents/experiment-designer.toml"
    ),
    embedded!(
        "agents/gate-designer.toml",
        "../templates/codex/research/agents/gate-designer.toml"
    ),
    embedded!(
        "agents/hypothesis-planner.toml",
        "../templates/codex/research/agents/hypothesis-planner.toml"
    ),
    embedded!(
        "agents/integrator.toml",
        "../templates/codex/research/agents/integrator.toml"
    ),
    embedded!(
        "agents/lead.toml",
        "../templates/codex/research/agents/lead.toml"
    ),
    embedded!(
        "agents/report-writer.toml",
        "../templates/codex/research/agents/report-writer.toml"
    ),
    embedded!(
        "agents/research-scout.toml",
        "../templates/codex/research/agents/research-scout.toml"
    ),
    embedded!(
        "agents/reviewer.toml",
        "../templates/codex/research/agents/reviewer.toml"
    ),
    embedded!(
        "agents/run-operator.toml",
        "../templates/codex/research/agents/run-operator.toml"
    ),
    embedded!(
        "agents/run-planner.toml",
        "../templates/codex/research/agents/run-planner.toml"
    ),
];

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use super::{RESEARCH, RESEARCH_CODEX, SHARED_SKILLS, SOFTWARE, SOFTWARE_CODEX};

    #[test]
    fn bundled_cockpits_use_the_autoresearch_relationship_outline() {
        for (profile, files, path) in [
            ("software", SOFTWARE, "cockpit.yaml"),
            ("research", RESEARCH, "cockpit/research.yaml"),
        ] {
            let cockpit = files.iter().find(|file| file.path == path).unwrap();
            let document: serde_yaml::Value = serde_yaml::from_slice(cockpit.contents).unwrap();
            let graph_view = document["views"]
                .as_sequence()
                .unwrap()
                .iter()
                .find(|view| matches!(view["kind"].as_str(), Some("graph" | "typed_tree")))
                .unwrap();
            assert_eq!(
                graph_view["options"]["layout"].as_str(),
                Some("nested"),
                "{profile} must use the relationship-outline renderer ported from autoresearch-v2"
            );
            assert_eq!(graph_view["options"]["show_titles"].as_bool(), Some(true));
        }
    }

    #[test]
    fn software_catalog_packages_five_proportional_run_types() {
        let yaml = |path| {
            let file = SOFTWARE
                .iter()
                .find(|file| file.path == path)
                .unwrap_or_else(|| panic!("software template {path} is bundled"));
            serde_yaml::from_slice::<serde_yaml::Value>(file.contents).unwrap()
        };

        let project = yaml("project.yaml");
        let run_type_ids = project["run_types"]
            .as_sequence()
            .unwrap()
            .iter()
            .filter_map(|entry| entry["id"].as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            run_type_ids,
            ["small", "medium", "large", "new-feature", "bug-fix"]
        );

        let small = yaml("run-types/small.yaml");
        assert_eq!(
            small["questions"]["policy"].as_str(),
            Some("high_impact_only")
        );
        let small_planning = small["instructions"]["planning"].as_str().unwrap();
        assert!(small_planning.contains("at most one question"));
        assert!(small_planning.contains("acceptance"));

        let medium = yaml("run-types/medium.yaml");

        let large = yaml("run-types/large.yaml");
        let large_planning = large["instructions"]["planning"].as_str().unwrap();
        assert!(large_planning.contains("no target or minimum question count"));
        assert!(!large_planning.contains("three to six"));
        for (id, document, limit, reserve) in [
            ("small", &small, 120_000, 30_000),
            ("medium", &medium, 240_000, 60_000),
            ("large", &large, 480_000, 120_000),
        ] {
            assert_eq!(
                document["planning"]["token_budget"]["limit"].as_u64(),
                Some(limit),
                "{id} planning ceiling"
            );
            assert_eq!(
                document["planning"]["token_budget"]["synthesis_reserve"].as_u64(),
                Some(reserve),
                "{id} synthesis reserve"
            );
        }

        for (path, id, intent, expected_parallel) in [
            (
                "run-types/new-feature.yaml",
                "new-feature",
                "new_feature",
                3,
            ),
            ("run-types/bug-fix.yaml", "bug-fix", "bug_fix", 1),
        ] {
            let document = yaml(path);
            assert_eq!(document["id"].as_str(), Some(id));
            assert_eq!(document["extends"].as_str(), Some("medium"));
            for inline_behavior in [
                "profile",
                "intake",
                "pipeline",
                "questions",
                "git",
                "run_card",
                "agents",
                "orchestration",
                "promotion",
                "planning",
                "instructions",
            ] {
                assert!(
                    document[inline_behavior].is_null(),
                    "{id} must express behavior only through ordered overrides"
                );
            }
            let overrides = document["overrides"].as_sequence().unwrap();
            assert!(overrides.iter().all(|operation| {
                matches!(
                    operation["op"].as_str(),
                    Some("merge" | "replace" | "remove")
                ) && operation["path"]
                    .as_str()
                    .is_some_and(|path| path.starts_with('/'))
            }));

            if id == "bug-fix" {
                let planning = overrides
                    .iter()
                    .find(|operation| operation["path"].as_str() == Some("/instructions/planning"))
                    .and_then(|operation| operation["value"].as_str())
                    .expect("Bug Fix replaces inherited planning instructions");
                assert!(planning.contains("exactly one focused diagnostic proof"));
                assert!(planning.contains("do not speculate a repair"));
                assert!(!planning.contains("localization_status"));

                let combined_plan = overrides
                    .iter()
                    .find(|operation| {
                        operation["path"].as_str()
                            == Some("/pipeline/stages/combined-plan/config/prompt")
                    })
                    .and_then(|operation| operation["value"].as_str())
                    .expect("Bug Fix replaces the inherited combined-plan prompt");
                assert!(combined_plan.contains("exactly one focused diagnostic proof"));
                assert!(combined_plan.contains("Do not seed a speculative change"));
                assert!(combined_plan.contains("omit those causal fields"));
                assert!(!combined_plan.contains("localization_status"));
            }
            assert!(overrides.iter().any(|operation| {
                operation["path"].as_str() == Some("/instructions/planning")
                    && operation["value"]
                        .as_str()
                        .is_some_and(|value| value.contains(intent))
            }));
            assert!(overrides.iter().any(|operation| {
                operation["path"].as_str() == Some("/orchestration/max_parallel")
                    && operation["value"].as_i64() == Some(expected_parallel)
            }));
        }
    }

    #[test]
    fn software_architecture_defaults_are_conditional_direct_and_bounded() {
        let rules = SOFTWARE
            .iter()
            .find(|file| file.path == "rules.yaml")
            .expect("software rules are bundled");
        let document: serde_yaml::Value = serde_yaml::from_slice(rules.contents).unwrap();
        let architecture = document["rules"]
            .as_sequence()
            .unwrap()
            .iter()
            .find(|rule| rule["id"].as_str() == Some("objective.map-architecture"))
            .expect("software architecture transition is configured");
        assert_eq!(architecture["for_each"].as_str(), Some("objectives"));
        let missing_boundary = &architecture["when"]["not"]["exists"]["intersection"];
        let missing_boundary = missing_boundary
            .as_sequence()
            .expect("architecture is missing only when no active affected system exists");
        assert_eq!(
            missing_boundary[0]["traverse"]["relation"].as_str(),
            Some("systems")
        );
        assert_eq!(missing_boundary[1].as_str(), Some("active_systems"));

        let operations = SOFTWARE
            .iter()
            .find(|file| file.path == "operations.yaml")
            .expect("software operations are bundled");
        let operations: serde_yaml::Value = serde_yaml::from_slice(operations.contents).unwrap();
        let architecture_operation = operations["operations"]
            .as_sequence()
            .unwrap()
            .iter()
            .find(|operation| operation["id"].as_str() == Some("architecture.objective.map"))
            .expect("software architecture operation is configured");
        assert_eq!(
            architecture_operation["allowed_new_node_types"]
                .as_sequence()
                .unwrap()
                .iter()
                .filter_map(serde_yaml::Value::as_str)
                .collect::<Vec<_>>(),
            ["system", "interface", "data_model", "contract", "flow"]
        );
        let output_contract = architecture_operation["output_contract"].as_str().unwrap();
        assert!(output_contract.contains("at least one system"));
        assert!(output_contract.contains("exact owned_paths"));
        assert!(output_contract.contains("Do not create speculative layers"));
        assert!(output_contract.contains("assurance ceremony"));

        let workflows = SOFTWARE
            .iter()
            .find(|file| file.path == "workflows.yaml")
            .expect("software workflows are bundled");
        let workflows: serde_yaml::Value = serde_yaml::from_slice(workflows.contents).unwrap();
        let architecture_workflow = workflows["workflows"]
            .as_sequence()
            .unwrap()
            .iter()
            .find(|workflow| workflow["id"].as_str() == Some("architecture-map"))
            .expect("software architecture workflow is configured");
        let boundary_step = architecture_workflow["steps"]
            .as_sequence()
            .unwrap()
            .iter()
            .find(|step| step["id"].as_str() == Some("map-affected-boundary"))
            .expect("architecture boundary step is configured");
        let expected_output = boundary_step["expected_output"].as_str().unwrap();
        assert!(expected_output.contains("Smallest repository-grounded affected system"));
        assert_eq!(
            boundary_step["persona"].as_str(),
            Some("architecture-mapper")
        );
        assert_eq!(boundary_step["graph_mutation"].as_str(), Some("required"));
        let steps = architecture_workflow["steps"].as_sequence().unwrap();
        assert_eq!(
            steps.len(),
            2,
            "conditional discovery should not add transcription hops"
        );
        assert_eq!(steps[1]["id"].as_str(), Some("review"));
        assert_eq!(steps[1]["graph_mutation"].as_str(), Some("forbidden"));

        let integrator = SOFTWARE_CODEX
            .iter()
            .find(|file| file.path == "agents/integrator.toml")
            .expect("software Integrator is bundled");
        let prompt = String::from_utf8_lossy(integrator.contents);
        let normalized_prompt = prompt.split_whitespace().collect::<Vec<_>>().join(" ");
        assert!(normalized_prompt.contains("reserved for a composition boundary"));
        assert!(normalized_prompt.contains("transcription path is not the current default"));
        assert!(normalized_prompt.contains("exact delivery assembly"));
        assert!(normalized_prompt.contains("candidate_ready"));

        let mapper = SOFTWARE_CODEX
            .iter()
            .find(|file| file.path == "agents/architecture-mapper.toml")
            .expect("software Architecture Mapper is bundled");
        let mapper_prompt = String::from_utf8_lossy(mapper.contents);
        let mapper_prompt = mapper_prompt
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        assert!(mapper_prompt.contains("conditional fallback"));
        assert!(mapper_prompt.contains("smallest repository-native system"));
        assert!(mapper_prompt.contains("exact project-root-relative owned paths"));
        assert!(mapper_prompt.contains("Write the bounded graph delta"));
        assert!(mapper_prompt.contains("do not make every system own a contract"));
    }

    #[test]
    fn software_change_design_defaults_emit_one_reviewed_vertical_candidate() {
        let graph = SOFTWARE
            .iter()
            .find(|file| file.path == "graph.yaml")
            .expect("software graph is bundled");
        let graph: serde_yaml::Value = serde_yaml::from_slice(graph.contents).unwrap();
        for node_type in ["system", "change", "migration"] {
            let node = graph["node_types"]
                .as_sequence()
                .unwrap()
                .iter()
                .find(|node| node["id"].as_str() == Some(node_type))
                .unwrap_or_else(|| panic!("software graph contains {node_type}"));
            assert_eq!(
                node["fields"]["owned_paths"]["items"]["type"].as_str(),
                Some("path"),
                "{node_type}.owned_paths must expose path semantics to producers"
            );
        }
        let proof = graph["node_types"]
            .as_sequence()
            .unwrap()
            .iter()
            .find(|node| node["id"].as_str() == Some("proof"))
            .expect("software graph declares proof nodes");
        assert_eq!(
            proof["fields"]["source_paths"]["items"]["type"].as_str(),
            Some("path")
        );
        assert_eq!(
            proof["fields"]["covered_paths"]["items"]["type"].as_str(),
            Some("path")
        );
        assert_eq!(
            proof["fields"]["working_directory"]["type"].as_str(),
            Some("path")
        );
        let graph_constraints = graph["graph_constraints"]
            .as_sequence()
            .expect("software graph declares cross-proof path authority constraints");
        let preparation_sources = graph_constraints
            .iter()
            .find(|constraint| {
                constraint["id"].as_str()
                    == Some("preparation-proof-source-paths-pairwise-disjoint")
            })
            .expect("preparation proof sources are pairwise disjoint");
        assert_eq!(
            preparation_sources["kind"].as_str(),
            Some("path_sets_disjoint")
        );
        assert_eq!(preparation_sources["distinct_nodes"].as_bool(), Some(true));
        for side in ["left", "right"] {
            assert_eq!(
                preparation_sources[side]["select"]["union"]
                    .as_sequence()
                    .expect("preparation source selector is a union")
                    .iter()
                    .filter_map(serde_yaml::Value::as_str)
                    .collect::<Vec<_>>(),
                [
                    "diagnostic_proofs",
                    "risk_boundary_proofs",
                    "preparation_eligible_implementation_proofs",
                ]
            );
            assert_eq!(
                preparation_sources[side]["node_types"]
                    .as_sequence()
                    .and_then(|types| types.first())
                    .and_then(serde_yaml::Value::as_str),
                Some("proof")
            );
            assert_eq!(
                preparation_sources[side]["field"].as_str(),
                Some("spec.source_paths")
            );
        }
        let implementation_sources = graph_constraints
            .iter()
            .find(|constraint| {
                constraint["id"].as_str()
                    == Some("preparation-and-implementation-proof-source-paths-disjoint")
            })
            .expect("preparation and implementation proof sources are disjoint");
        assert_eq!(
            implementation_sources["kind"].as_str(),
            Some("path_sets_disjoint")
        );
        assert_eq!(
            implementation_sources["distinct_nodes"].as_bool(),
            Some(true)
        );
        assert_eq!(
            implementation_sources["left"]["select"]["union"]
                .as_sequence()
                .expect("preparation source selector is a union")
                .iter()
                .filter_map(serde_yaml::Value::as_str)
                .collect::<Vec<_>>(),
            [
                "diagnostic_proofs",
                "risk_boundary_proofs",
                "preparation_eligible_implementation_proofs",
            ]
        );
        assert_eq!(
            implementation_sources["right"]["select"].as_str(),
            Some("well_scoped_implementation_proofs")
        );
        for side in ["left", "right"] {
            assert_eq!(
                implementation_sources[side]["field"].as_str(),
                Some("spec.source_paths")
            );
        }

        let operations = SOFTWARE
            .iter()
            .find(|file| file.path == "operations.yaml")
            .expect("software operations are bundled");
        let operations: serde_yaml::Value = serde_yaml::from_slice(operations.contents).unwrap();
        let plan_change = operations["operations"]
            .as_sequence()
            .unwrap()
            .iter()
            .find(|operation| operation["id"].as_str() == Some("design.objective.plan-change"))
            .expect("software plan-change operation is configured");
        let output_contract = plan_change["output_contract"].as_str().unwrap();
        assert!(output_contract.contains("one-sentence change.approval_claim"));
        assert!(output_contract.contains("baseline_check_id"));
        assert!(output_contract.contains("proof-expected-red"));
        assert!(output_contract.contains("proof-current-baseline"));
        assert!(output_contract.contains("change.addresses"));
        assert!(output_contract.contains("cannot create decisions"));
        assert!(output_contract.contains(
            "Named tests or describe blocks within one file remain one compiler authority boundary"
        ));
        assert!(output_contract.contains(
            "Red-green and characterization proof sources must be independently prepared and reviewed before product implementation"
        ));
        for (id, field, contract_fragment) in [
            (
                "design.objective.ground-defect",
                "output_contract",
                "Different named tests or describe blocks in one file do not satisfy this boundary",
            ),
            (
                "assurance.proof.prepare",
                "review_contract",
                "Named tests in one shared file are one authority boundary",
            ),
            (
                "assurance.risk.plan-treatment",
                "output_contract",
                "named tests in one file are not separate authority",
            ),
        ] {
            let operation = operations["operations"]
                .as_sequence()
                .unwrap()
                .iter()
                .find(|operation| operation["id"].as_str() == Some(id))
                .unwrap_or_else(|| panic!("software operation {id} is configured"));
            assert!(
                operation[field]
                    .as_str()
                    .is_some_and(|contract| contract.contains(contract_fragment)),
                "software operation {id} must teach physical proof-source separation"
            );
        }

        let workflows = SOFTWARE
            .iter()
            .find(|file| file.path == "workflows.yaml")
            .expect("software workflows are bundled");
        let workflows: serde_yaml::Value = serde_yaml::from_slice(workflows.contents).unwrap();
        let change_design = workflows["workflows"]
            .as_sequence()
            .unwrap()
            .iter()
            .find(|workflow| workflow["id"].as_str() == Some("change-design"))
            .expect("software change-design workflow is configured");
        let steps = change_design["steps"].as_sequence().unwrap();
        assert_eq!(
            steps.len(),
            2,
            "planning should be one direct producer plus review"
        );
        assert_eq!(steps[0]["id"].as_str(), Some("plan-vertical-change"));
        assert_eq!(steps[0]["persona"].as_str(), Some("change-designer"));
        assert_eq!(steps[0]["graph_mutation"].as_str(), Some("required"));
        let planned = steps[0]["expected_output"].as_str().unwrap();
        assert!(planned.contains("one-sentence vertical change claims"));
        assert!(planned.contains("adaptive proof purposes"));
        assert!(planned.contains("causal defects"));
        assert_eq!(steps[1]["id"].as_str(), Some("review"));
        assert_eq!(steps[1]["graph_mutation"].as_str(), Some("forbidden"));

        let proof_preparation = workflows["workflows"]
            .as_sequence()
            .unwrap()
            .iter()
            .find(|workflow| workflow["id"].as_str() == Some("proof-preparation"))
            .expect("software proof preparation workflow is configured");
        let preparation_steps = proof_preparation["steps"].as_sequence().unwrap();
        assert!(
            preparation_steps[0]["expected_output"]
                .as_str()
                .is_some_and(
                    |output| output.contains("red-green, or characterization proof source")
                )
        );
        assert!(
            preparation_steps[1]["expected_output"]
                .as_str()
                .is_some_and(|output| output
                    .contains("before any linked product implementation becomes eligible"))
        );
        for workflow_id in [
            "red-green-implementation",
            "characterization-implementation",
        ] {
            let workflow = workflows["workflows"]
                .as_sequence()
                .unwrap()
                .iter()
                .find(|workflow| workflow["id"].as_str() == Some(workflow_id))
                .unwrap_or_else(|| panic!("software workflow {workflow_id} is configured"));
            assert_eq!(
                workflow["review_failure_routes"]["ticket_rework"]["disposition"].as_str(),
                Some("reopen")
            );
            assert_eq!(
                workflow["review_failure_routes"]["ticket_rework"]["reopen_from"].as_str(),
                Some("implement")
            );
            assert_eq!(
                workflow["review_failure_routes"]["upstream_proof"]["disposition"].as_str(),
                Some("block")
            );
            assert_eq!(
                workflow["review_failure_routes"]["upstream_proof"]["recovery"].as_str(),
                Some("replan_from_clean_integration")
            );
            let baseline = workflow["steps"]
                .as_sequence()
                .unwrap()
                .iter()
                .find(|step| step["id"].as_str() == Some("establish-baseline"))
                .expect("implementation workflow retains baseline confirmation");
            assert_eq!(
                baseline["write_paths"].as_sequence().map(Vec::len),
                Some(0),
                "{workflow_id} proof source is immutable after preparation review"
            );
        }

        let prompt = |path| {
            String::from_utf8_lossy(
                SOFTWARE_CODEX
                    .iter()
                    .find(|file| file.path == path)
                    .unwrap_or_else(|| panic!("software prompt {path} is bundled"))
                    .contents,
            )
            .into_owned()
        };
        let change_designer = prompt("agents/change-designer.toml");
        let change_designer = change_designer
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        assert!(change_designer.contains("fewest cohesive vertical slices"));
        assert!(change_designer.contains("first invalid state and causal boundary"));
        assert!(change_designer.contains("already populated human-approved decision"));
        assert!(change_designer.contains("project-root-relative"));
        assert!(change_designer.contains(
            "Named tests or describe blocks in one file share one compiler authority boundary"
        ));
        assert!(change_designer.contains(
            "Red-green and characterization proofs must be independently prepared and reviewed"
        ));
        let risk_analyst = prompt("agents/risk-analyst.toml");
        let risk_analyst = risk_analyst
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        assert!(risk_analyst.contains("narrow treatment-repair boundary"));
        assert!(risk_analyst.contains("may not invent product scope"));
        assert!(risk_analyst.contains("Never create a decision"));
        let contract_designer = prompt("agents/contract-designer.toml")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        assert!(
            contract_designer
                .contains("Create only material interface, data, flow, or contract facts")
        );
        assert!(contract_designer.contains("This operation cannot create a decision"));
        assert!(!contract_designer.contains("flow, decision, or contract"));
        let run_planner = prompt("agents/run-planner.toml")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        assert!(run_planner.contains(
            "Every critical change also needs recovery or roll-forward controls and an already human-approved `review_authority` decision"
        ));
        assert!(run_planner.contains("unavailable required expertise remains a blocker"));
        assert!(run_planner.contains(
            "Named tests or describe blocks in one file are one compiler authority boundary"
        ));
        assert!(run_planner.contains(
            "Red-green and characterization proof sources must be prepared and independently reviewed before product implementation"
        ));
        let software_modeling_reference = String::from_utf8_lossy(
            SHARED_SKILLS
                .iter()
                .find(|file| file.path == "model-koni-work/references/software-projects.md")
                .expect("Software modeling reference is bundled")
                .contents,
        )
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
        assert!(software_modeling_reference.contains(
            "Every critical change needs a concrete recovery plan and an already human-approved `review_authority` decision"
        ));
        assert!(
            software_modeling_reference.contains(
                "if required domain expertise is unavailable, review blocks and escalates"
            )
        );
        assert!(
            software_modeling_reference
                .contains("describe blocks within one file are not independent compiler authority")
        );
        assert!(
            software_modeling_reference.contains("Software-0.6 implementation-oracle correction")
        );
        let configure_skill = String::from_utf8_lossy(
            SHARED_SKILLS
                .iter()
                .find(|file| file.path == "configure-koni/SKILL.md")
                .expect("configuration skill is bundled")
                .contents,
        );
        assert!(configure_skill.contains("Prefer current schema 2 at `.koni/project.yaml`"));
        assert!(configure_skill.contains("koni validate-profile .koni/profile.yaml"));
        assert!(configure_skill.contains("provider-neutral agent instructions"));
        assert!(configure_skill.contains("detected schema-1 project only"));
        let agent_reference = String::from_utf8_lossy(
            SHARED_SKILLS
                .iter()
                .find(|file| file.path == "configure-koni/references/agents-and-skills.md")
                .expect("agent configuration reference is bundled")
                .contents,
        );
        assert!(agent_reference.contains(".koni/agents/reviewer.yaml"));
        assert!(agent_reference.contains("thinking_level: xhigh"));
        assert!(agent_reference.contains("agent: reviewer"));
        assert!(agent_reference.contains("Schema-1 compatibility"));
        let operate_skill = String::from_utf8_lossy(
            SHARED_SKILLS
                .iter()
                .find(|file| file.path == "operate-koni/SKILL.md")
                .expect("operation skill is bundled")
                .contents,
        );
        assert!(operate_skill.contains("Treat current `.koni/project.yaml` as initialized"));
        assert!(operate_skill.contains("the normal schema-2 path is `.koni/profile.yaml`"));
        let integrator = prompt("agents/integrator.toml");
        assert!(integrator.contains("not a transcription hop"));
        assert!(integrator.contains("exact delivery assembly"));
    }

    #[test]
    fn software_proof_defaults_are_adaptive_graph_selected_and_repository_owned() {
        let yaml = |path| {
            let file = SOFTWARE
                .iter()
                .find(|file| file.path == path)
                .unwrap_or_else(|| panic!("software template {path} is bundled"));
            serde_yaml::from_slice::<serde_yaml::Value>(file.contents).unwrap()
        };

        let graph = yaml("graph.yaml");
        for node_type in ["change", "migration"] {
            let node = graph["node_types"]
                .as_sequence()
                .unwrap()
                .iter()
                .find(|node| node["id"].as_str() == Some(node_type))
                .unwrap();
            let strategies = node["fields"]["proof_strategy"]["enum"]
                .as_sequence()
                .unwrap()
                .iter()
                .filter_map(serde_yaml::Value::as_str)
                .collect::<Vec<_>>();
            assert_eq!(
                strategies,
                ["red_green", "characterization", "current_verification"]
            );
            for removed_duplicate in [
                "baseline_signal",
                "behavior_readback",
                "test_command",
                "test_paths",
                "test_layer",
                "not_proven",
            ] {
                assert!(
                    node["fields"][removed_duplicate].is_null(),
                    "{node_type}.{removed_duplicate} must not duplicate proof authority"
                );
            }
        }
        let proof = graph["node_types"]
            .as_sequence()
            .unwrap()
            .iter()
            .find(|node| node["id"].as_str() == Some("proof"))
            .expect("software graph declares proof nodes");
        assert_eq!(proof["fields"]["command"]["type"].as_str(), Some("list"));
        assert!(
            proof["fields"]["owned_paths"].is_null(),
            "proof source_paths and covered_paths are the sole path authority"
        );
        assert_eq!(
            proof["fields"]["command"]["items"]["type"].as_str(),
            Some("string")
        );
        assert_eq!(
            proof["fields"]["baseline_check_id"]["enum"]
                .as_sequence()
                .unwrap()
                .iter()
                .filter_map(serde_yaml::Value::as_str)
                .collect::<Vec<_>>(),
            ["proof-expected-red", "proof-current-baseline"]
        );
        for field in ["source_paths", "covered_paths"] {
            assert_eq!(
                proof["fields"][field]["items"]["type"].as_str(),
                Some("path")
            );
        }
        assert_eq!(
            proof["fields"]["working_directory"]["type"].as_str(),
            Some("path")
        );
        let edges = graph["edge_types"].as_sequence().unwrap();
        for (source, relation, inverse) in [
            ("change", "realizes", "realized_by"),
            ("delivery", "fulfills", "delivered_by"),
        ] {
            let edge = edges
                .iter()
                .find(|edge| {
                    edge["source"].as_str() == Some(source)
                        && edge["relation"].as_str() == Some(relation)
                })
                .unwrap();
            assert_eq!(edge["bidirectional"].as_bool(), Some(true));
            assert_eq!(edge["inverse"].as_str(), Some(inverse));
            assert!(
                !edges.iter().any(|candidate| {
                    candidate["source"].as_str() == Some("objective")
                        && candidate["relation"].as_str() == Some(inverse)
                }),
                "the inverse alias must not be stored as a reciprocal edge type"
            );
        }

        let rules = yaml("rules.yaml");
        let strategy_rules = rules["rules"]
            .as_sequence()
            .unwrap()
            .iter()
            .filter(|rule| {
                rule["id"].as_str().is_some_and(|id| {
                    id.starts_with("change.implement-") || id.starts_with("migration.implement-")
                })
            })
            .collect::<Vec<_>>();
        assert_eq!(strategy_rules.len(), 6);
        assert!(strategy_rules.iter().all(|rule| {
            rule["emit"]["registry_entry_id"].is_string() && rule["emit"]["workflow"].is_string()
        }));

        let operations = yaml("operations.yaml");
        for id in [
            "implementation.change.red-green",
            "implementation.change.characterize",
            "implementation.change.verify-current",
            "implementation.migration.red-green",
            "implementation.migration.characterize",
            "implementation.migration.verify-current",
        ] {
            assert!(
                operations["operations"]
                    .as_sequence()
                    .unwrap()
                    .iter()
                    .any(|operation| operation["id"].as_str() == Some(id))
            );
        }

        let workflows = yaml("workflows.yaml");
        for id in [
            "red-green-implementation",
            "characterization-implementation",
            "current-verification-implementation",
        ] {
            let workflow = workflows["workflows"]
                .as_sequence()
                .unwrap()
                .iter()
                .find(|workflow| workflow["id"].as_str() == Some(id))
                .unwrap_or_else(|| panic!("software workflow contains {id}"));
            let baseline = workflow["steps"]
                .as_sequence()
                .unwrap()
                .iter()
                .find(|step| step["id"].as_str() == Some("establish-baseline"))
                .expect("implementation workflow has an explicit compiler-bound baseline");
            assert_eq!(
                baseline["checks"]
                    .as_sequence()
                    .unwrap()
                    .iter()
                    .filter_map(serde_yaml::Value::as_str)
                    .collect::<Vec<_>>(),
                ["baseline-proof-set"]
            );
            let implement = workflow["steps"]
                .as_sequence()
                .unwrap()
                .iter()
                .find(|step| step["id"].as_str() == Some("implement"))
                .expect("implementation workflow has a compiler-proved implementation step");
            assert_eq!(
                implement["preserve_source_paths_from"].as_str(),
                Some("establish-baseline")
            );
            assert_eq!(
                implement["checks"]
                    .as_sequence()
                    .unwrap()
                    .iter()
                    .filter_map(serde_yaml::Value::as_str)
                    .collect::<Vec<_>>(),
                ["promotion-proof-set"]
            );
        }

        let checks = yaml("checks.yaml");
        let checks = checks["checks"].as_sequence().unwrap();
        assert!(checks.iter().all(|check| {
            check["kind"].as_str() != Some("command") || check["command_source"].is_mapping()
        }));
        for id in ["proof-expected-red", "proof-current-baseline"] {
            let check = checks
                .iter()
                .find(|check| check["id"].as_str() == Some(id))
                .unwrap_or_else(|| panic!("software checks contain {id}"));
            assert_eq!(check["receipt_freshness"].as_str(), Some("historical"));
            assert_eq!(check["composed_replay"].as_str(), Some("never"));
        }
        let baseline_set = checks
            .iter()
            .find(|check| check["id"].as_str() == Some("baseline-proof-set"))
            .expect("software checks contain the baseline graph set");
        assert_eq!(baseline_set["kind"].as_str(), Some("composite"));
        assert_eq!(
            baseline_set["graph_set"]["member_check_field"].as_str(),
            Some("spec.baseline_check_id")
        );
        let promotion_set = checks
            .iter()
            .find(|check| check["id"].as_str() == Some("promotion-proof-set"))
            .expect("software checks contain the current promotion graph set");
        assert_eq!(promotion_set["kind"].as_str(), Some("composite"));
        assert_eq!(
            promotion_set["graph_set"]["member_check"].as_str(),
            Some("proof-command")
        );
        for set in [baseline_set, promotion_set] {
            assert_eq!(
                set["graph_set"]["source_paths_field"].as_str(),
                Some("spec.source_paths")
            );
            assert_eq!(
                set["graph_set"]["covered_paths_field"].as_str(),
                Some("spec.covered_paths")
            );
            assert_eq!(
                set["graph_set"]["working_directory_field"].as_str(),
                Some("spec.working_directory")
            );
        }
        let profile = yaml("profile.yaml");
        assert!(profile["git"]["ticket_worktree_setup_check"].is_null());

        for path in [
            "agents/change-designer.toml",
            "agents/implementer.toml",
            "agents/reviewer.toml",
            "agents/verifier.toml",
        ] {
            let prompt = String::from_utf8_lossy(
                SOFTWARE_CODEX
                    .iter()
                    .find(|file| file.path == path)
                    .unwrap()
                    .contents,
            );
            assert!(prompt.contains("red_green") || prompt.contains("red-green"));
            assert!(prompt.contains("characterization"));
            assert!(
                prompt.contains("current verification") || prompt.contains("current_verification")
            );
        }
        let reviewer = String::from_utf8_lossy(
            SOFTWARE_CODEX
                .iter()
                .find(|file| file.path == "agents/reviewer.toml")
                .expect("software Reviewer is bundled")
                .contents,
        )
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
        assert!(reviewer.contains(
            "Named tests or describe blocks within one file do not create separate compiler authority"
        ));
    }

    #[test]
    fn bundled_implementer_requires_complete_context_and_adaptive_product_reads() {
        let implementer = String::from_utf8_lossy(
            SOFTWARE_CODEX
                .iter()
                .find(|file| file.path == "agents/implementer.toml")
                .expect("software Implementer is bundled")
                .contents,
        );
        for required in [
            "complete only when `eof` is true",
            "exact `document_path`",
            "each returned `next_offset`",
            "at least 32768 `max_bytes`",
            "Observe every returned page before the next call",
            "before any product-file call",
            "search first and read only the required region",
            "do not search it again merely to",
        ] {
            assert!(
                implementer.contains(required),
                "bundled Implementer omitted `{required}`"
            );
        }
        for preserved in [
            "ticket's declared paths and semantic scope",
            "run_configured_check",
            "submit_and_compile",
            "workflow owns graph state",
        ] {
            assert!(
                implementer.contains(preserved),
                "bundled Implementer lost `{preserved}`"
            );
        }
    }

    #[test]
    fn research_worker_prompts_never_delegate_lifecycle_through_the_shell() {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let source_root = manifest.join("../../profiles/research/personas/prompts");
        let source_prompts = fs::read_dir(&source_root)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.path().extension().and_then(|value| value.to_str()) == Some("md"))
            .map(|entry| {
                (
                    entry.file_name().to_string_lossy().into_owned(),
                    fs::read_to_string(entry.path()).unwrap(),
                )
            })
            .collect::<Vec<_>>();
        let native_prompts = RESEARCH_CODEX
            .iter()
            .map(|file| {
                (
                    file.path.rsplit('/').next().unwrap_or(file.path).to_owned(),
                    String::from_utf8(file.contents.to_vec()).unwrap(),
                )
            })
            .collect::<Vec<_>>();
        let lifecycle_verbs = [
            "action",
            "compile",
            "context",
            "finish",
            "output",
            "recover",
            "review",
            "spawn-lead",
            "spawn-worker",
            "start",
            "wait-worker",
            "yield-lead",
        ];
        for (name, prompt) in source_prompts.iter().chain(native_prompts.iter()) {
            let lower = prompt.to_ascii_lowercase();
            for verb in lifecycle_verbs {
                assert!(
                    !lower.contains(&format!("`koni {verb}"))
                        && !lower.contains(&format!("koni {verb} --")),
                    "{name} delegates `{verb}` through a shell lifecycle command"
                );
            }
        }
    }

    #[test]
    fn corrected_research_prompts_match_their_native_codex_agents() {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        for stem in ["asset-builder", "research-scout", "run-operator"] {
            let source = fs::read_to_string(manifest.join(format!(
                "../../profiles/research/personas/prompts/{stem}.md"
            )))
            .unwrap();
            let source_body = source
                .split_once("\n\n")
                .map_or(source.as_str(), |(_, body)| body);
            let native = RESEARCH_CODEX
                .iter()
                .find(|file| file.path == format!("agents/{stem}.toml"))
                .map(|file| String::from_utf8_lossy(file.contents))
                .unwrap();
            assert!(
                native.contains(source_body.trim()),
                "native agent {stem} drifted from its source prompt"
            );
        }
    }
}
