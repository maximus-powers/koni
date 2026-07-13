use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};

use git2::{IndexAddOption, Repository, RepositoryInitOptions, Signature};
use koni_core::Engine;
use koni_core::graph::Node;
use koni_core::state::StateStore;
use serde_json::{Value, json};
use tempfile::TempDir;
use walkdir::WalkDir;

#[test]
fn empirical_profile_declares_the_complete_epistemic_contract() -> Result<(), Box<dyn Error>> {
    let (_temp, engine) = open_research_fixture()?;

    let hypothesis = &engine.profile().node_types["hypothesis"];
    assert!(
        !hypothesis.fields["objective"].required,
        "objective is useful initialization metadata, not an extra hypothesis requirement"
    );

    let claim = &engine.profile().node_types["claim"];
    for field in ["scope", "assumptions", "evidence_standard", "threat_model"] {
        assert!(claim.fields[field].required, "claim field {field}");
    }
    assert!(has_required_group(
        claim,
        &["falsification", "falsification_criteria"]
    ));

    let evidence = &engine.profile().node_types["evidence"];
    for field in [
        "summary",
        "interpretation",
        "evidence_basis",
        "inference_scope",
        "polarity",
        "confidence",
        "scope",
        "limitations",
        "receipt_refs",
        "run_dispositions",
    ] {
        assert!(evidence.fields[field].required, "evidence field {field}");
    }
    assert_eq!(
        evidence.fields["evidence_basis"].enum_values,
        vec![json!("empirical_runtime")]
    );
    assert_eq!(
        evidence.fields["inference_scope"].enum_values,
        vec![json!("bounded_empirical")]
    );
    assert_eq!(
        evidence.fields["polarity"].enum_values,
        vec![
            json!("supported"),
            json!("contradicted"),
            json!("inconclusive")
        ]
    );
    assert_eq!(
        evidence.fields["confidence"].enum_values,
        vec![json!("low"), json!("medium"), json!("high")]
    );
    for field in ["limitations", "receipt_refs"] {
        assert!(
            evidence.fields[field]
                .items
                .as_ref()
                .and_then(|items| items.pattern.as_deref())
                .is_some(),
            "evidence {field} entries must not be blank"
        );
    }
    for field in [
        "spec.promotion_state",
        "spec.promoted_by",
        "spec.promotion_review_id",
    ] {
        assert!(
            evidence
                .compiler_owned_fields
                .iter()
                .any(|configured| configured == field),
            "promotion field {field} must remain compiler-owned"
        );
    }

    let report = &engine.profile().node_types["report"];
    assert!(report.fields["limitations"].required);
    assert!(
        report.fields["limitations"]
            .items
            .as_ref()
            .and_then(|items| items.pattern.as_deref())
            .is_some(),
        "report limitation entries must not be blank"
    );
    for field in ["spec.concluded_by", "spec.conclusion_review_id"] {
        assert!(
            report
                .compiler_owned_fields
                .iter()
                .any(|configured| configured == field),
            "conclusion field {field} must remain compiler-owned"
        );
    }

    for persona in [
        "run-planner",
        "hypothesis-planner",
        "evidence-analyst",
        "report-writer",
        "reviewer",
        "lead",
    ] {
        let instructions = engine.profile().resolve_persona(persona)?.instructions;
        assert!(
            instructions.contains("evidence_basis: empirical_runtime"),
            "{persona} must see the configured evidence basis"
        );
        assert!(
            instructions.contains("inference_scope: bounded_empirical"),
            "{persona} must see the configured inference boundary"
        );
    }
    Ok(())
}

#[test]
fn graph_validation_rejects_missing_or_unbounded_epistemic_metadata() -> Result<(), Box<dyn Error>>
{
    let (temp, mut engine) = open_research_fixture()?;
    engine.initialize_run("Validate configured empirical evidence boundaries.")?;
    let store = StateStore::with_storage(
        temp.path().join("research-project/program"),
        &engine.profile().manifest.storage,
    )?;
    let mut graph = store.graph()?;

    let claim = Node::new(
        "claim",
        "Claim missing epistemic preparation",
        json!({
            "claim": "A runtime observation supports this claim.",
            "assumptions": ["The configured subject can be executed."],
            "threat_model": ["The observed corpus may be incomplete."]
        }),
    );
    let evidence = Node::new(
        "evidence",
        "Evidence missing bounded interpretation metadata",
        json!({
            "summary": "The configured subject produced an observation.",
            "interpretation": "The observation is not yet dispositioned."
        }),
    );
    let unbounded = Node::new(
        "evidence",
        "Evidence attempting an unconfigured inference",
        complete_evidence_spec("formal_proof", "unbounded"),
    );
    let report = Node::new(
        "report",
        "Report missing limitations",
        json!({
            "summary": "A candidate synthesis.",
            "paper_context_role": "results"
        }),
    );
    for node in [&claim, &evidence, &unbounded, &report] {
        graph.insert(node.clone())?;
        graph.save_node(&store.graph_dir(), &node.id)?;
    }

    let error = engine
        .compile(None, false)
        .expect_err("incomplete epistemic metadata must fail graph validation")
        .to_string();
    for (node, fields) in [
        (&claim, vec!["scope", "falsification", "evidence_standard"]),
        (
            &evidence,
            vec![
                "evidence_basis",
                "inference_scope",
                "polarity",
                "confidence",
                "scope",
                "limitations",
                "receipt_refs",
                "run_dispositions",
            ],
        ),
        (&report, vec!["limitations"]),
    ] {
        assert!(
            error.contains(&node.id),
            "missing node identity in: {error}"
        );
        for field in fields {
            assert!(
                error
                    .lines()
                    .any(|line| line.contains(&node.id) && line.contains(field)),
                "missing validation failure for {field}: {error}"
            );
        }
    }
    assert!(
        error
            .lines()
            .any(|line| line.contains(&unbounded.id) && line.contains("evidence_basis")),
        "an unconfigured evidence basis must fail closed: {error}"
    );
    assert!(
        error
            .lines()
            .any(|line| line.contains(&unbounded.id) && line.contains("inference_scope")),
        "an unbounded inference class must fail closed: {error}"
    );
    Ok(())
}

#[test]
fn graph_validation_accepts_documented_aliases_with_bounded_metadata() -> Result<(), Box<dyn Error>>
{
    let (temp, mut engine) = open_research_fixture()?;
    engine.initialize_run("Preserve documented research-node aliases.")?;
    let store = StateStore::with_storage(
        temp.path().join("research-project/program"),
        &engine.profile().manifest.storage,
    )?;
    let mut graph = store.graph()?;

    let mut hypothesis = graph
        .nodes_of_type("hypothesis")
        .next()
        .cloned()
        .expect("initialized hypothesis");
    hypothesis
        .spec
        .as_object_mut()
        .expect("hypothesis spec")
        .remove("objective");
    let claim = Node::new(
        "claim",
        "Claim using documented aliases",
        json!({
            "statement": "The observed subject behaves consistently on the declared corpus.",
            "scope": "The configured fixture corpus and subject implementation.",
            "assumptions": ["The runtime adapter preserves the declared interface."],
            "falsification_criteria": "Any contradictory runtime observation in the corpus.",
            "evidence_standard": "Current runtime receipts covering the declared corpus.",
            "threat_model": ["Unobserved inputs remain outside the inference scope."]
        }),
    );
    let evidence = Node::new(
        "evidence",
        "Bounded empirical evidence",
        json!({
            "summary": "The current receipt records the expected result.",
            "interpretation": "The receipt supports the claim within the fixture corpus.",
            "evidence_basis": "empirical_runtime",
            "inference_scope": "bounded_empirical",
            "polarity": "supported",
            "confidence": "medium",
            "scope": "The configured fixture corpus and subject implementation.",
            "limitations": ["No inference is made about unobserved inputs."],
            "receipt_refs": ["RT-fixture-current"],
            "run_dispositions": {
                "run-fixture": {
                    "disposition": "supports",
                    "receipt_id": "RT-fixture-current",
                    "rationale": "The run directly observes the claim in scope."
                }
            }
        }),
    );
    let report = Node::new(
        "report",
        "Bounded synthesis",
        json!({
            "synthesis": "The current evidence supports only the observed corpus.",
            "paper_context_role": "results",
            "limitations": ["Unobserved inputs and implementations remain outside scope."]
        }),
    );
    for node in [&hypothesis, &claim, &evidence, &report] {
        graph.upsert(node.clone());
        graph.save_node(&store.graph_dir(), &node.id)?;
    }

    engine.compile(None, false)?;
    Ok(())
}

#[test]
fn source_prompts_and_installable_native_agents_have_identical_intent() -> Result<(), Box<dyn Error>>
{
    let repository = repository_root();
    let source = repository.join("profiles/research");
    let installable = repository.join("crates/koni-cli/templates/research");
    for relative in [
        "README.md",
        "graph/nodes.yaml",
        "profile.yaml",
        "workflows/research.yaml",
        "run-types/small.yaml",
        "run-types/medium.yaml",
        "run-types/large.yaml",
    ] {
        assert_eq!(
            fs::read(source.join(relative))?,
            fs::read(installable.join(relative))?,
            "installable research copy drifted at {relative}"
        );
    }

    let source_personas: Value =
        serde_yaml::from_str(&fs::read_to_string(source.join("personas/research.yaml"))?)?;
    let installed_personas: Value = serde_yaml::from_str(&fs::read_to_string(
        installable.join("personas/research.yaml"),
    )?)?;
    let installed_by_id = installed_personas["personas"]
        .as_array()
        .expect("installed personas")
        .iter()
        .map(|persona| (persona["id"].as_str().expect("persona id"), persona))
        .collect::<std::collections::BTreeMap<_, _>>();
    for persona in source_personas["personas"]
        .as_array()
        .expect("source personas")
    {
        let id = persona["id"].as_str().expect("persona id");
        let prompt = persona["prompt"].as_str().expect("source prompt");
        assert_eq!(
            installed_by_id[id]["codex_agent"].as_str(),
            Some(id),
            "installed persona {id} must bind its matching native agent"
        );

        let markdown = fs::read_to_string(source.join(prompt))?;
        let (_, markdown_body) = markdown
            .split_once("\n\n")
            .ok_or("persona Markdown must have a heading and body")?;
        let native_path = repository
            .join("crates/koni-cli/templates/codex/research/agents")
            .join(format!("{id}.toml"));
        let native: toml::Value = toml::from_str(&fs::read_to_string(native_path)?)?;
        assert_eq!(native["name"].as_str(), Some(id));
        assert_eq!(
            native["developer_instructions"].as_str(),
            Some(markdown_body),
            "native agent {id} instructions drifted from the profile prompt"
        );
    }
    Ok(())
}

fn complete_evidence_spec(evidence_basis: &str, inference_scope: &str) -> Value {
    json!({
        "summary": "The runtime receipt records one bounded observation.",
        "interpretation": "The observation supports only its declared corpus.",
        "evidence_basis": evidence_basis,
        "inference_scope": inference_scope,
        "polarity": "supported",
        "confidence": "medium",
        "scope": "The observed fixture corpus and configured implementation.",
        "limitations": ["Unobserved inputs and implementations remain outside scope."],
        "receipt_refs": ["RT-fixture-current"]
    })
}

fn has_required_group(definition: &koni_core::config::NodeTypeDef, expected: &[&str]) -> bool {
    definition
        .required_any
        .iter()
        .any(|group| group.iter().map(String::as_str).collect::<Vec<_>>() == expected)
}

fn open_research_fixture() -> Result<(TempDir, Engine), Box<dyn Error>> {
    let temp = TempDir::new()?;
    let root = temp.path().join("research-project");
    copy_fixture(
        &repository_root().join("profiles/research"),
        &root.join(".codex/koni"),
    )?;
    initialize_repository(&root)?;
    let engine = Engine::open_with_profile(&root, None)?;
    Ok((temp, engine))
}

fn repository_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn copy_fixture(source: &Path, destination: &Path) -> Result<(), Box<dyn Error>> {
    for entry in WalkDir::new(source).follow_links(false) {
        let entry = entry?;
        let relative = entry.path().strip_prefix(source)?;
        let target = destination.join(relative);
        if entry.file_type().is_dir() {
            fs::create_dir_all(&target)?;
        } else if entry.file_type().is_file() {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

fn initialize_repository(root: &Path) -> Result<Repository, Box<dyn Error>> {
    let mut options = RepositoryInitOptions::new();
    options.initial_head("main");
    let repository = Repository::init_opts(root, &options)?;
    let mut index = repository.index()?;
    index.add_all(["*"], IndexAddOption::DEFAULT, None)?;
    index.write()?;
    let tree_id = index.write_tree()?;
    {
        let tree = repository.find_tree(tree_id)?;
        let signature = Signature::now("Epistemic Fixture", "fixture@example.local")?;
        repository.commit(
            Some("HEAD"),
            &signature,
            &signature,
            "chore: initialize epistemic fixture",
            &tree,
            &[],
        )?;
    }
    Ok(repository)
}
