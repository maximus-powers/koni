use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};

use git2::{IndexAddOption, Repository, Signature};
use koni_core::Engine;
use koni_core::git::GitBackend;
use koni_core::graph::Node;
use koni_core::state::StateStore;
use serde_json::json;
use tempfile::TempDir;

const PROFILE: &str = r#"
schema_version: "1.0"
engine: ">=0.1,<0.2"
profile:
  id: graph-path-constraint-fixture
  version: 1.0.0
  description: Generic graph-selected path-set constraint integration fixture
initialization:
  root_node_type: objective
  goal_field: goal
  root_status: active
storage:
  backend: tracked
  graph_dir: program/graph
  tickets_dir: program/tickets
  state_path: program/state.yaml
  work_dir: program/work
  receipts_dir: program/receipts
  reports_dir: program/reports
imports:
  graph: [module.yaml]
"#;

const MODULE_PREFIX: &str = r#"
schema_version: "1.0"
module: {id: graph-path-constraint.fixture, version: 1.0.0}

node_types:
  - id: objective
    description: Root objective used only to initialize the fixture run.
    stage: framing
    required_any: [[goal]]
    statuses: [active]
    semantic_fields: [goal]
    fields:
      goal: {type: string, required: true}
  - id: proof
    description: Repository-owned executable proof with authored source authority.
    stage: verification
    required_any: [[source_paths]]
    statuses: [active]
    semantic_fields: [source_paths]
    fields:
      source_paths:
        type: list
        required: true
        items: {type: path}
  - id: artifact
    description: A second path-bearing type used to exercise selector declarations.
    stage: verification
    required_any: [[source_paths]]
    statuses: [active]
    semantic_fields: [source_paths]
    fields:
      source_paths:
        type: list
        required: true
        items: {type: path}

"#;

const DISJOINT_PROOF_SOURCES: &str = r#"
graph_constraints:
  - id: proof-source-paths-are-disjoint
    kind: path_sets_disjoint
    left:
      select: {nodes: {node_types: [proof]}}
      node_types: [proof]
      field: spec.source_paths
    right:
      select: {nodes: {node_types: [proof]}}
      node_types: [proof]
      field: spec.source_paths
    distinct_nodes: true
"#;

struct Fixture {
    _temp: TempDir,
    root: PathBuf,
    engine: Engine,
    store: StateStore,
}

#[test]
fn path_sets_disjoint_rejects_exact_overlap_between_distinct_nodes() -> Result<(), Box<dyn Error>> {
    let mut fixture = Fixture::new(&module(DISJOINT_PROOF_SOURCES))?;
    fixture.add_path_node("proof-a", "proof", "tests/shared.rs")?;
    fixture.add_path_node("proof-b", "proof", "tests/shared.rs")?;

    let error = fixture.compile_failure()?;
    assert_constraint_diagnostic(
        &error,
        &[
            "proof-source-paths-are-disjoint",
            "proof-a",
            "proof-b",
            "tests/shared.rs",
        ],
    );
    Ok(())
}

#[test]
fn path_sets_disjoint_rejects_ancestor_and_descendant_authority() -> Result<(), Box<dyn Error>> {
    let mut fixture = Fixture::new(&module(DISJOINT_PROOF_SOURCES))?;
    fixture.add_path_node("proof-directory", "proof", "tests/contracts")?;
    fixture.add_path_node("proof-file", "proof", "tests/contracts/focused-proof.rs")?;

    let error = fixture.compile_failure()?;
    assert_constraint_diagnostic(
        &error,
        &[
            "proof-source-paths-are-disjoint",
            "proof-directory",
            "proof-file",
            "tests/contracts",
            "tests/contracts/focused-proof.rs",
        ],
    );
    Ok(())
}

#[test]
fn path_sets_disjoint_accepts_distinct_nonoverlapping_authority() -> Result<(), Box<dyn Error>> {
    let mut fixture = Fixture::new(&module(DISJOINT_PROOF_SOURCES))?;
    fixture.add_path_node("proof-a", "proof", "tests/a/focused.rs")?;
    fixture.add_path_node("proof-b", "proof", "tests/b/focused.rs")?;

    fixture.engine.compile(None, false)?;
    Ok(())
}

#[test]
fn distinct_nodes_skips_only_a_nodes_comparison_with_itself() -> Result<(), Box<dyn Error>> {
    let mut fixture = Fixture::new(&module(DISJOINT_PROOF_SOURCES))?;
    fixture.add_path_node("proof-only", "proof", "tests/only/focused.rs")?;

    fixture.engine.compile(None, false)?;
    Ok(())
}

#[test]
fn selector_that_can_return_an_undeclared_node_type_fails_closed() -> Result<(), Box<dyn Error>> {
    let constraint = r#"
graph_constraints:
  - id: declared-proof-paths-only
    kind: path_sets_disjoint
    left:
      select: {nodes: {node_types: [proof, artifact]}}
      node_types: [proof]
      field: spec.source_paths
    right:
      select: {nodes: {node_types: [proof]}}
      node_types: [proof]
      field: spec.source_paths
    distinct_nodes: true
"#;
    let module = module(constraint);
    let temp = TempDir::new()?;
    let root = temp.path().join("project");
    initialize_project(&root, &module)?;

    let error = match Engine::open_with_profile(&root, None) {
        Err(error) => error.to_string(),
        Ok(mut engine) => {
            let run_id = engine.initialize_run("Reject undeclared selector output types")?;
            let store = state_store(&root, &run_id, &engine.profile().manifest.storage)?;
            save_path_node(&store, "proof-a", "proof", "tests/proof.rs")?;
            save_path_node(&store, "artifact-a", "artifact", "tests/artifact.rs")?;
            engine
                .compile(None, false)
                .err()
                .ok_or("selector returned an undeclared node type without failing closed")?
                .to_string()
        }
    };
    assert_constraint_diagnostic(&error, &["declared-proof-paths-only", "artifact", "proof"]);
    Ok(())
}

#[cfg(unix)]
#[test]
fn path_sets_disjoint_rejects_hardlink_and_symlink_aliases() -> Result<(), Box<dyn Error>> {
    let mut hardlink_fixture = Fixture::new(&module(DISJOINT_PROOF_SOURCES))?;
    hardlink_fixture.write_file("tests/canonical-hardlink.rs", "fn proof() {}\n")?;
    fs::hard_link(
        hardlink_fixture.root.join("tests/canonical-hardlink.rs"),
        hardlink_fixture.root.join("tests/aliased-hardlink.rs"),
    )?;
    hardlink_fixture.add_path_node(
        "proof-hardlink-source",
        "proof",
        "tests/canonical-hardlink.rs",
    )?;
    hardlink_fixture.add_path_node("proof-hardlink-alias", "proof", "tests/aliased-hardlink.rs")?;
    let hardlink_error = hardlink_fixture.compile_failure()?;
    assert_constraint_diagnostic(
        &hardlink_error,
        &[
            "proof-source-paths-are-disjoint",
            "proof-hardlink-source",
            "proof-hardlink-alias",
        ],
    );

    let mut symlink_fixture = Fixture::new(&module(DISJOINT_PROOF_SOURCES))?;
    symlink_fixture.write_file("tests/canonical-symlink.rs", "fn proof() {}\n")?;
    std::os::unix::fs::symlink(
        "canonical-symlink.rs",
        symlink_fixture.root.join("tests/aliased-symlink.rs"),
    )?;
    symlink_fixture.add_path_node(
        "proof-symlink-source",
        "proof",
        "tests/canonical-symlink.rs",
    )?;
    symlink_fixture.add_path_node("proof-symlink-alias", "proof", "tests/aliased-symlink.rs")?;
    let symlink_error = symlink_fixture.compile_failure()?;
    assert_constraint_diagnostic(&symlink_error, &["proof-source-paths-are-disjoint"]);
    assert!(
        symlink_error.contains("proof-symlink-source")
            && symlink_error.contains("proof-symlink-alias")
            || symlink_error.contains("safely compare"),
        "symlink authority must either report the conflicting nodes or fail closed as an unsafe comparison: {symlink_error}"
    );

    Ok(())
}

impl Fixture {
    fn new(module: &str) -> Result<Self, Box<dyn Error>> {
        let temp = TempDir::new()?;
        let root = temp.path().join("project");
        initialize_project(&root, module)?;
        let mut engine = Engine::open_with_profile(&root, None)?;
        let run_id = engine.initialize_run("Exercise graph path-set constraints")?;
        let store = state_store(&root, &run_id, &engine.profile().manifest.storage)?;
        Ok(Self {
            _temp: temp,
            root,
            engine,
            store,
        })
    }

    fn add_path_node(&self, id: &str, node_type: &str, path: &str) -> Result<(), Box<dyn Error>> {
        save_path_node(&self.store, id, node_type, path)
    }

    fn write_file(&self, relative: &str, contents: &str) -> Result<(), Box<dyn Error>> {
        write(&self.root, relative, contents)
    }

    fn compile_failure(&mut self) -> Result<String, Box<dyn Error>> {
        self.engine
            .compile(None, false)
            .err()
            .map(|error| error.to_string())
            .ok_or_else(|| "graph path-set constraint unexpectedly compiled".into())
    }
}

fn module(constraint: &str) -> String {
    format!("{MODULE_PREFIX}{constraint}")
}

fn save_path_node(
    store: &StateStore,
    id: &str,
    node_type: &str,
    path: &str,
) -> Result<(), Box<dyn Error>> {
    let mut graph = store.graph()?;
    let mut node = Node::new(
        node_type,
        format!("Path authority {id}"),
        json!({"source_paths": [path]}),
    );
    node.id = id.to_owned();
    node.status = "active".to_owned();
    graph.upsert(node.clone());
    graph.save_node(&store.graph_dir(), &node.id)?;
    Ok(())
}

fn assert_constraint_diagnostic(error: &str, expected_fragments: &[&str]) {
    for fragment in expected_fragments {
        assert!(
            error.contains(fragment),
            "constraint diagnostic should contain {fragment:?}: {error}"
        );
    }
}

fn initialize_project(root: &Path, module: &str) -> Result<(), Box<dyn Error>> {
    fs::create_dir_all(root)?;
    write(root, ".codex/koni/profile.yaml", PROFILE)?;
    write(root, ".codex/koni/module.yaml", module)?;
    initialize_repository(root)?;
    Ok(())
}

fn state_store(
    root: &Path,
    run_id: &str,
    storage: &koni_core::config::StorageConfig,
) -> Result<StateStore, Box<dyn Error>> {
    let state_root = match storage.backend {
        koni_core::config::StorageBackend::Tracked => root.join(
            storage
                .state_path
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
                .unwrap_or(Path::new(".")),
        ),
        koni_core::config::StorageBackend::GitCommonDir => {
            GitBackend::discover(root)?.sidecar_path(format!("runs/{run_id}"))?
        }
    };
    Ok(StateStore::with_storage(state_root, storage)?)
}

fn write(root: &Path, relative: &str, contents: &str) -> Result<(), Box<dyn Error>> {
    let path = root.join(relative);
    fs::create_dir_all(path.parent().ok_or("fixture path has no parent")?)?;
    fs::write(path, contents)?;
    Ok(())
}

fn initialize_repository(root: &Path) -> Result<Repository, Box<dyn Error>> {
    let repository = Repository::init(root)?;
    let mut index = repository.index()?;
    index.add_all(["*"], IndexAddOption::DEFAULT, None)?;
    index.write()?;
    let tree_id = index.write_tree()?;
    {
        let tree = repository.find_tree(tree_id)?;
        let signature = Signature::now("Graph Constraint Fixture", "fixture@example.local")?;
        repository.commit(
            Some("HEAD"),
            &signature,
            &signature,
            "test: initialize graph path constraint fixture",
            &tree,
            &[],
        )?;
    }
    Ok(repository)
}
