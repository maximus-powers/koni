use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};

use git2::{IndexAddOption, Oid, Repository, Signature};
use koni_core::config::StorageBackend;
use koni_core::git::{GitBackend, TicketWorktreeSpec};
use koni_core::graph::{Node, normalized_hash};
use koni_core::state::{Event, Journal, JournalStatus, Lease, StateStore, Ticket};
use koni_core::{
    AgentProcessLauncher, AgentProcessRequest, AgentProcessResult, Engine, OrchestrationState,
    RunControlStore,
};
use serde_json::{Value, json};
use tempfile::TempDir;
use uuid::Uuid;
use walkdir::WalkDir;

const OLD_SOURCE: &str = "tests/shared-proof.txt";
const NEW_SOURCE: &str = "tests/focused-proof.txt";
const COVERED_SOURCE: &str = "src/lib.rs";
// Proof preparation is now the first compiler-owned writer for a planned
// focused proof. A shared prepared source therefore conflicts at this
// upstream boundary, before any product implementation ticket may emit.
const EXPECTED_RULE: &str = "proof.prepare";
const RELOCATION_KIND: &str = "planned-proof-source-relocation";
const RELOCATION_COMPLETED_EVENT: &str = "compiler.planned-proof-source-relocation.completed";

fn assert_relocated_preparation_ticket(ticket: &Ticket, proof_id: &str) {
    assert_eq!(ticket.rule_id, EXPECTED_RULE);
    assert_eq!(ticket.operation, "prepare-proof");
    assert_eq!(ticket.target_nodes, vec![proof_id.to_owned()]);
    assert_eq!(
        ticket.scope.write_nodes,
        BTreeSet::from([proof_id.to_owned()])
    );
    assert_eq!(
        ticket.scope.read_paths,
        BTreeSet::from([NEW_SOURCE.to_owned(), COVERED_SOURCE.to_owned()])
    );
    assert_eq!(
        ticket.scope.write_paths,
        BTreeSet::from([NEW_SOURCE.to_owned()])
    );

    let author_steps = ticket
        .workflow
        .iter()
        .filter(|step| step.id == "author-historical-baseline")
        .collect::<Vec<_>>();
    let [author_step] = author_steps.as_slice() else {
        panic!(
            "relocated preparation ticket must contain one historical-baseline authoring step, found {}",
            author_steps.len()
        );
    };
    assert_eq!(
        author_step.read_paths.as_ref(),
        Some(&BTreeSet::from([
            NEW_SOURCE.to_owned(),
            COVERED_SOURCE.to_owned(),
        ]))
    );
    assert_eq!(
        author_step.write_paths.as_ref(),
        Some(&BTreeSet::from([NEW_SOURCE.to_owned()]))
    );

    let compiled_members = ticket
        .workflow
        .iter()
        .flat_map(|step| &step.compiled_check_sets)
        .flat_map(|set| {
            assert_eq!(set.parent_check_id, "baseline-proof-set");
            &set.members
        })
        .collect::<Vec<_>>();
    let [compiled_member] = compiled_members.as_slice() else {
        panic!(
            "relocated preparation ticket must bind exactly one baseline proof member, found {}",
            compiled_members.len()
        );
    };
    assert_eq!(compiled_member.source_node_id, proof_id);
    assert_eq!(
        compiled_member.source_paths,
        BTreeSet::from([NEW_SOURCE.to_owned()])
    );
    assert_eq!(
        compiled_member.covered_paths,
        BTreeSet::from([COVERED_SOURCE.to_owned()])
    );
    assert_eq!(
        compiled_member.argv,
        ["grep", "-q", "corrected", "focused-proof.txt"]
    );
    assert_eq!(compiled_member.working_directory, "tests");
}

#[test]
fn planned_proof_source_relocation_is_journaled_exact_and_replay_safe() -> Result<(), Box<dyn Error>>
{
    let RelocationScenario {
        mut fixture,
        prepared_proof,
        preparation_ticket,
        prepared_node_hash,
        preparation_ticket_hash,
        prepared_source_bytes,
        planned_proof,
        expected_ticket_id,
        failed_compile,
        steer_params,
        graph_hashes_before,
        ticket_hashes_before,
        integration_head_before_steer: _,
        empty_leased_ticket: _,
    } = relocated_scenario()?;

    let relocated_proof = fixture
        .store
        .graph()?
        .node(&planned_proof.id)
        .cloned()
        .ok_or("relocated proof disappeared")?;
    let mut exact_expected_proof = planned_proof.clone();
    exact_expected_proof
        .spec_object_mut()
        .insert("source_paths".to_owned(), json!([NEW_SOURCE]));
    exact_expected_proof.spec_object_mut().insert(
        "command".to_owned(),
        json!(["grep", "-q", "corrected", "focused-proof.txt"]),
    );
    exact_expected_proof.extensions.insert(
        "obligations".to_owned(),
        json!({
            "unmet": [{
                "key": "proof.preparation",
                "reason": "Preparation-eligible proof lacks a current independently reviewed source-only preparation and honest historical baseline",
                "rule": EXPECTED_RULE,
                "severity": "blocking"
            }]
        }),
    );
    assert_eq!(
        relocated_proof, exact_expected_proof,
        "relocation may change only the semantic source declaration and its one resolving command argument; the full compiler must add only the exact unmet preparation projection"
    );
    let graph_hashes_after = fixture
        .store
        .graph()?
        .nodes()
        .map(|node| (node.id.clone(), normalized_hash(node)))
        .collect::<BTreeMap<_, _>>();
    assert_eq!(graph_hashes_after.len(), graph_hashes_before.len());
    for (node_id, before_hash) in &graph_hashes_before {
        let after_hash = graph_hashes_after
            .get(node_id)
            .ok_or_else(|| format!("graph lost node {node_id} during relocation"))?;
        if node_id == &planned_proof.id {
            assert_ne!(after_hash, before_hash);
        } else {
            assert_eq!(
                after_hash, before_hash,
                "relocation changed unrelated graph node {node_id}"
            );
        }
    }

    let current_prepared_node = fixture
        .store
        .graph()?
        .node(&prepared_proof.id)
        .cloned()
        .ok_or("prepared proof disappeared after relocation")?;
    assert_eq!(normalized_hash(&current_prepared_node), prepared_node_hash);
    assert_eq!(
        normalized_hash(&fixture.store.ticket(&preparation_ticket.id)?),
        preparation_ticket_hash
    );
    assert_eq!(
        fs::read(fixture.root.join(OLD_SOURCE))?,
        prepared_source_bytes
    );

    let expected_ticket = fixture.store.ticket(&expected_ticket_id)?;
    assert_relocated_preparation_ticket(&expected_ticket, &planned_proof.id);
    assert!(expected_ticket.target_nodes.contains(&planned_proof.id));
    assert!(expected_ticket.scope.read_paths.contains(NEW_SOURCE));
    assert!(!expected_ticket.scope.read_paths.contains(OLD_SOURCE));
    assert!(expected_ticket.scope.write_paths.contains(NEW_SOURCE));
    assert!(!expected_ticket.scope.write_paths.contains(OLD_SOURCE));
    for step in &expected_ticket.workflow {
        if let Some(read_paths) = &step.read_paths {
            assert!(
                !read_paths.contains(OLD_SOURCE),
                "workflow step {} retained old source read authority",
                step.id
            );
        }
        if let Some(write_paths) = &step.write_paths {
            assert!(
                !write_paths.contains(OLD_SOURCE),
                "workflow step {} retained old source authority",
                step.id
            );
        }
    }
    let compiled_proof_members = expected_ticket
        .workflow
        .iter()
        .flat_map(|step| &step.compiled_check_sets)
        .flat_map(|set| &set.members)
        .filter(|member| member.source_node_id == planned_proof.id)
        .collect::<Vec<_>>();
    assert!(
        !compiled_proof_members.is_empty(),
        "relocated ticket omitted its graph-compiled planned-proof check"
    );
    for member in compiled_proof_members {
        assert!(member.source_paths.contains(NEW_SOURCE));
        assert!(!member.source_paths.contains(OLD_SOURCE));
        assert!(
            member
                .argv
                .iter()
                .any(|argument| argument == "focused-proof.txt")
        );
        assert!(
            member
                .argv
                .iter()
                .all(|argument| argument != "shared-proof.txt")
        );
    }
    let ticket_hashes_after = fixture
        .store
        .tickets()?
        .into_iter()
        .filter(|ticket| ticket.id != expected_ticket_id)
        .map(|ticket| (ticket.id.clone(), normalized_hash(&ticket)))
        .collect::<BTreeMap<_, _>>();
    assert_eq!(
        ticket_hashes_after, ticket_hashes_before,
        "relocation changed pre-existing ticket authority"
    );

    let recovered_compile = fixture
        .store
        .journals()?
        .into_iter()
        .find(|journal| journal.id == failed_compile.id)
        .ok_or("failed compile Journal disappeared")?;
    let mut expected_recovered_compile = failed_compile.clone();
    expected_recovered_compile.status = JournalStatus::Recovered;
    assert_eq!(
        normalized_hash(&recovered_compile),
        normalized_hash(&expected_recovered_compile),
        "relocation must change only the failed compile Journal status"
    );

    let transaction = only_relocation_transaction(&fixture.store)?;
    assert_eq!(
        transaction.get("status").and_then(Value::as_str),
        Some("complete")
    );
    assert!(
        transaction
            .get("completed_at")
            .is_some_and(|value| !value.is_null())
    );
    assert_eq!(completion_event_count(&fixture.store)?, 1);
    let full_compile_event_id = transaction
        .get("full_compile_event_id")
        .and_then(Value::as_str)
        .ok_or("complete transaction did not seal its full compile")?;
    let events = fixture.store.events()?;
    let full_compile_event = events
        .iter()
        .find(|event| event.id == full_compile_event_id)
        .ok_or("sealed full-compile event disappeared")?;
    assert_eq!(full_compile_event.event_type, "compiler.compile.full");
    assert_eq!(full_compile_event.actor, "compiler");
    assert!(full_compile_event.ticket_id.is_none());
    assert_eq!(
        full_compile_event.data,
        json!({
            "graph_hash": transaction["expected_compiled_graph_hash"],
            "derived_tickets": transaction["expected_derived_ticket_ids"],
        })
    );
    let steering_requests = events
        .iter()
        .filter(|event| {
            event.event_type == "compiler.steering.recorded"
                && event.data.get("kind").and_then(Value::as_str) == Some(RELOCATION_KIND)
        })
        .collect::<Vec<_>>();
    let [steering_request] = steering_requests.as_slice() else {
        return Err(format!(
            "expected one relocation steering request, found {}",
            steering_requests.len()
        )
        .into());
    };
    assert_eq!(
        transaction.get("request_event_id").and_then(Value::as_str),
        Some(steering_request.id.as_str())
    );
    let steering_journal_id = steering_request
        .data
        .get("compiler_transaction_journal")
        .and_then(Value::as_str)
        .ok_or("relocation steering event lost its action Journal")?;
    assert_eq!(
        transaction
            .get("request_action_journal_id")
            .and_then(Value::as_str),
        Some(steering_journal_id)
    );
    let steering_journal = fixture
        .store
        .journals()?
        .into_iter()
        .find(|journal| journal.id == steering_journal_id)
        .ok_or("relocation action Journal disappeared")?;
    assert_eq!(steering_journal.action, "steer");
    assert_eq!(steering_journal.status, JournalStatus::Complete);
    assert_eq!(steering_journal.completed_steps, vec![0, 1, 2]);
    let completion = events
        .iter()
        .find(|event| event.event_type == RELOCATION_COMPLETED_EVENT)
        .ok_or("relocation completion event disappeared")?;
    assert_eq!(completion.actor, "compiler");
    assert_eq!(
        completion.ticket_id.as_deref(),
        Some(preparation_ticket.id.as_str())
    );
    assert_eq!(
        completion.data,
        json!({
            "transaction_id": transaction["id"],
            "transaction_hash": transaction["transaction_hash"],
            "request_hash": transaction["request_hash"],
            "proof_node_id": transaction["proof_node_id"],
            "old_source_path": transaction["old_source_path"],
            "new_source_path": transaction["new_source_path"],
            "conflicting_preparation_ticket_id": transaction["conflicting_preparation_ticket_id"],
            "conflicting_preparation_node_id": transaction["conflicting_preparation_node_id"],
            "failed_compile_journal_id": transaction["failed_compile_journal_id"],
            "expected_rule_id": transaction["expected_rule_id"],
            "expected_ticket_id": transaction["expected_ticket_id"],
            "base_graph_hash": transaction["base_graph_hash"],
            "amended_graph_hash": transaction["amended_graph_hash"],
            "expected_compiled_graph_hash": transaction["expected_compiled_graph_hash"],
            "full_compile_event_id": transaction["full_compile_event_id"],
            "full_compile_event_hash": transaction["full_compile_event_hash"],
            "integration_ref": transaction["integration_ref"],
            "integration_head": transaction["integration_head"],
            "authority_changed": true,
            "write_authority_changed": true,
        })
    );

    let full_compile_count = fixture
        .store
        .events()?
        .iter()
        .filter(|event| event.event_type == "compiler.compile.full")
        .count();
    fixture
        .engine
        .execute_action("compile", BTreeMap::new())
        .map_err(|error| format!("later ordinary full compile failed: {error}"))?;
    assert!(
        fixture
            .store
            .events()?
            .iter()
            .filter(|event| event.event_type == "compiler.compile.full")
            .count()
            > full_compile_count,
        "the fixture must advance through a legitimate later full compile"
    );
    let control = fixture.control()?;
    let mut orchestration = control
        .orchestration()?
        .ok_or("relocation fixture lost its orchestration state")?;
    orchestration.set_running_at(true, chrono::Utc::now());
    control.write_orchestration(&orchestration)?;
    let sealed_replay_prestate = relocation_state_hashes(&fixture.store)?;
    let replay = fixture
        .engine
        .execute_action("steer", steer_params.clone())
        .map_err(|error| format!("sealed exact relocation replay after resume failed: {error}"))?;
    assert_eq!(
        replay.get("status").and_then(Value::as_str),
        Some("already_relocated")
    );
    assert_eq!(completion_event_count(&fixture.store)?, 1);
    assert_eq!(
        relocation_state_hashes(&fixture.store)?,
        sealed_replay_prestate,
        "sealed exact replay must not republish graph, ticket, Journal, event, or transaction authority"
    );
    orchestration.set_running_at(false, chrono::Utc::now());
    control.write_orchestration(&orchestration)?;

    remove_relocation_completion_events(&fixture.store)?;
    assert_eq!(completion_event_count(&fixture.store)?, 0);
    assert_eq!(
        only_relocation_transaction(&fixture.store)?
            .get("status")
            .and_then(Value::as_str),
        Some("complete"),
        "the crash seam keeps the complete transaction durable"
    );
    let quarantine = fixture
        .engine
        .execute_action("compile", BTreeMap::new())
        .expect_err("ordinary compiler authority must remain quarantined without the seal")
        .to_string();
    assert!(
        quarantine.contains("unfinished planned-proof source relocation"),
        "unexpected quarantine diagnostic: {quarantine}"
    );

    let recovery = fixture
        .engine
        .execute_action("recover", BTreeMap::new())
        .map_err(|error| format!("missing-seal recovery failed: {error}"))?;
    let preflight_relocations = recovery
        .get("preflight_planned_proof_source_relocations")
        .and_then(Value::as_array)
        .ok_or("recovery omitted its committed-relocation preflight result")?;
    assert_eq!(preflight_relocations.len(), 1);
    assert_eq!(
        preflight_relocations[0]
            .get("status")
            .and_then(Value::as_str),
        Some("already_relocated")
    );
    assert_ne!(
        recovery
            .pointer("/dispatch/generic_recovery_deferred")
            .and_then(Value::as_bool),
        Some(true),
        "recovery must seal committed relocation authority before generic dispatch"
    );
    assert_eq!(completion_event_count(&fixture.store)?, 1);

    remove_relocation_completion_events(&fixture.store)?;
    let healed = fixture
        .engine
        .execute_action("steer", steer_params.clone())
        .map_err(|error| format!("missing-seal exact replay failed: {error}"))?;
    assert_eq!(
        healed.get("status").and_then(Value::as_str),
        Some("already_relocated")
    );
    assert_eq!(completion_event_count(&fixture.store)?, 1);
    let healed_replay_prestate = relocation_state_hashes(&fixture.store)?;
    let idempotent = fixture
        .engine
        .execute_action("steer", steer_params)
        .map_err(|error| format!("healed relocation replay failed: {error}"))?;
    assert_eq!(
        idempotent.get("status").and_then(Value::as_str),
        Some("already_relocated")
    );
    assert_eq!(completion_event_count(&fixture.store)?, 1);
    assert_eq!(
        relocation_state_hashes(&fixture.store)?,
        healed_replay_prestate,
        "healed exact replay must be byte-semantically idempotent"
    );

    Ok(())
}

#[test]
fn committed_relocation_request_without_transaction_quarantines_ordinary_authority()
-> Result<(), Box<dyn Error>> {
    let RelocationScenario { mut fixture, .. } = relocated_scenario()?;

    // Reconstruct, in an independent fixture, the durable authority envelope
    // from the narrow crash after the configured steer action committed but
    // before its reconciler wrote a transaction: the authentic owning event
    // and complete action Journal stay, while neither transaction nor
    // completion seal exists. A private failpoint test still owns the exact
    // graph/ticket prepublication-byte proof.
    let owning_requests = fixture
        .store
        .events()?
        .into_iter()
        .filter(|event| {
            event.event_type == "compiler.steering.recorded"
                && event.data.get("kind").and_then(Value::as_str) == Some(RELOCATION_KIND)
        })
        .collect::<Vec<_>>();
    let [owning_request] = owning_requests.as_slice() else {
        return Err(format!(
            "expected one authentic relocation steering event, found {}",
            owning_requests.len()
        )
        .into());
    };
    let owner_journal_id = owning_request
        .data
        .get("compiler_transaction_journal")
        .and_then(Value::as_str)
        .ok_or("relocation steering event omitted its owning action Journal")?;
    assert!(fixture.store.journals()?.iter().any(|journal| {
        journal.id == owner_journal_id
            && journal.action == "steer"
            && journal.status == JournalStatus::Complete
    }));
    remove_relocation_completion_events(&fixture.store)?;
    fs::remove_file(only_relocation_transaction_path(&fixture.store)?)?;
    let absent_transaction_quarantine = fixture
        .engine
        .execute_action("compile", BTreeMap::new())
        .expect_err("a committed relocation request without a transaction must quarantine")
        .to_string();
    assert!(
        absent_transaction_quarantine.contains("committed-request-awaiting-transaction")
            && absent_transaction_quarantine.contains("unfinished planned-proof source relocation"),
        "unexpected absent-transaction quarantine: {absent_transaction_quarantine}"
    );

    Ok(())
}

#[test]
fn tracked_backend_relocation_pins_action_checkpoint_then_seals_and_replays()
-> Result<(), Box<dyn Error>> {
    let RelocationScenario {
        mut fixture,
        steer_params,
        integration_head_before_steer,
        ..
    } = relocated_scenario_with_backend(StorageBackend::Tracked)?;

    let transaction = only_relocation_transaction(&fixture.store)?;
    assert_eq!(
        transaction.get("status").and_then(Value::as_str),
        Some("complete")
    );
    let authority_checkpoint = transaction
        .get("integration_head")
        .and_then(Value::as_str)
        .ok_or("tracked relocation transaction omitted its pinned integration HEAD")?
        .to_owned();
    assert_ne!(
        authority_checkpoint, integration_head_before_steer,
        "tracked steer must durably checkpoint its owning event and Complete Journal before transaction preparation"
    );
    assert_exact_h0_h1_request_delta(
        &fixture,
        &integration_head_before_steer,
        &authority_checkpoint,
        transaction_string(&transaction, "request_action_journal_id")?,
    )?;

    let final_action_head = GitBackend::discover(&fixture.root)?.head_oid()?.to_string();
    assert_ne!(
        final_action_head, authority_checkpoint,
        "tracked relocation finalization must seal its completed state in a later checkpoint"
    );
    let repository = Repository::open(&fixture.root)?;
    let authority_commit = repository.find_commit(git2::Oid::from_str(&authority_checkpoint)?)?;
    assert_eq!(authority_commit.parent_count(), 1);
    assert_eq!(
        authority_commit.parent_id(0)?.to_string(),
        integration_head_before_steer,
        "the owning-action checkpoint must be the first tracked commit after the clean pre-steer state"
    );
    let final_action_commit = repository.find_commit(git2::Oid::from_str(&final_action_head)?)?;
    assert_eq!(final_action_commit.parent_count(), 1);
    assert_eq!(
        final_action_commit.parent_id(0)?.to_string(),
        authority_checkpoint,
        "the completed relocation seal must be a direct child of its pinned owning-action checkpoint"
    );
    drop(final_action_commit);
    drop(authority_commit);
    drop(repository);

    fixture.engine.execute_action("compile", BTreeMap::new())?;
    let progressed_head = GitBackend::discover(&fixture.root)?.head_oid()?.to_string();
    assert_ne!(
        progressed_head, final_action_head,
        "a later legitimate tracked compile must advance beyond the historical relocation seal"
    );
    assert!(
        Repository::open(&fixture.root)?.graph_descendant_of(
            git2::Oid::from_str(&progressed_head)?,
            git2::Oid::from_str(&final_action_head)?,
        )?,
        "later tracked progress must retain the relocation seal on its history"
    );

    let control = fixture.control()?;
    let mut orchestration = control
        .orchestration()?
        .ok_or("tracked relocation fixture lost its orchestration state")?;
    orchestration.set_running_at(true, chrono::Utc::now());
    control.write_orchestration(&orchestration)?;
    let sealed_prestate = relocation_state_hashes(&fixture.store)?;
    let replay = fixture
        .engine
        .execute_action("steer", steer_params)
        .map_err(|error| format!("tracked sealed relocation replay failed: {error}"))?;
    assert_eq!(
        replay.get("status").and_then(Value::as_str),
        Some("already_relocated")
    );
    assert_eq!(relocation_state_hashes(&fixture.store)?, sealed_prestate);
    assert_eq!(
        GitBackend::discover(&fixture.root)?.head_oid()?.to_string(),
        progressed_head,
        "sealed replay must not create another tracked checkpoint"
    );
    orchestration.set_running_at(false, chrono::Utc::now());
    control.write_orchestration(&orchestration)?;

    Ok(())
}

#[derive(Clone, Copy, Debug)]
enum TrackedCrashPhase {
    CommittedRequest,
    PreparedAfterGraph,
    GraphPublishedAfterCompile,
    CompiledAfterJournalRecovery,
    CompleteWithoutEvent,
    CompleteWithoutCheckpoint,
}

impl TrackedCrashPhase {
    const ALL: [Self; 6] = [
        Self::CommittedRequest,
        Self::PreparedAfterGraph,
        Self::GraphPublishedAfterCompile,
        Self::CompiledAfterJournalRecovery,
        Self::CompleteWithoutEvent,
        Self::CompleteWithoutCheckpoint,
    ];

    fn label(self) -> &'static str {
        match self {
            Self::CommittedRequest => "committed request without transaction",
            Self::PreparedAfterGraph => "prepared after graph publication",
            Self::GraphPublishedAfterCompile => "graph-published after compile",
            Self::CompiledAfterJournalRecovery => "compiled after Journal recovery",
            Self::CompleteWithoutEvent => "complete without completion event",
            Self::CompleteWithoutCheckpoint => "complete without tracked checkpoint",
        }
    }
}

#[test]
fn tracked_backend_relocation_recovers_every_durable_publication_phase()
-> Result<(), Box<dyn Error>> {
    for phase in TrackedCrashPhase::ALL {
        let RelocationScenario {
            mut fixture,
            planned_proof,
            expected_ticket_id,
            steer_params,
            ..
        } = relocated_scenario_with_backend(StorageBackend::Tracked)?;
        let capture =
            TrackedRelocationCapture::capture(&fixture, &planned_proof.id, &expected_ticket_id)?;
        restore_tracked_relocation_phase(&fixture, &capture, phase)?;

        let quarantine = fixture
            .engine
            .execute_action("compile", BTreeMap::new())
            .expect_err("ordinary compiler authority must remain quarantined during recovery")
            .to_string();
        assert!(
            quarantine.contains("unfinished planned-proof source relocation"),
            "{} produced an unexpected quarantine diagnostic: {quarantine}",
            phase.label()
        );

        let recovery = fixture
            .engine
            .execute_action("recover", BTreeMap::new())
            .map_err(|error| format!("{} failed configured recovery: {error}", phase.label()))?;
        let preflight = recovery
            .get("preflight_planned_proof_source_relocations")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                format!(
                    "{} recovery omitted its relocation preflight result",
                    phase.label()
                )
            })?;
        assert_eq!(preflight.len(), 1, "{} recovery count", phase.label());
        assert!(
            matches!(
                preflight[0].get("status").and_then(Value::as_str),
                Some("relocated" | "already_relocated")
            ),
            "{} returned an unexpected recovery result: {:?}",
            phase.label(),
            preflight[0]
        );
        assert_recovered_tracked_relocation(&fixture, &capture, phase, capture.h1)?;

        let control = fixture.control()?;
        let mut orchestration = control
            .orchestration()?
            .ok_or("tracked recovery fixture lost its orchestration state")?;
        orchestration.set_running_at(true, chrono::Utc::now());
        control.write_orchestration(&orchestration)?;
        let replay_prestate = relocation_state_hashes(&fixture.store)?;
        let replay_head = GitBackend::discover(&fixture.root)?.head_oid()?.to_string();
        let replay = fixture
            .engine
            .execute_action("steer", steer_params.clone())
            .map_err(|error| {
                format!(
                    "{} exact replay after recovery failed: {error}",
                    phase.label()
                )
            })?;
        assert_eq!(
            replay.get("status").and_then(Value::as_str),
            Some("already_relocated"),
            "{} exact replay did not resolve from its historical seal",
            phase.label()
        );
        assert_eq!(
            relocation_state_hashes(&fixture.store)?,
            replay_prestate,
            "{} exact replay changed semantic authority",
            phase.label()
        );
        assert_eq!(
            GitBackend::discover(&fixture.root)?.head_oid()?.to_string(),
            replay_head,
            "{} exact replay created another tracked checkpoint",
            phase.label()
        );
        orchestration.set_running_at(false, chrono::Utc::now());
        control.write_orchestration(&orchestration)?;
    }

    Ok(())
}

#[test]
fn tracked_backend_recovery_reconstructs_partial_action_success_before_h1()
-> Result<(), Box<dyn Error>> {
    let RelocationScenario {
        mut fixture,
        planned_proof,
        expected_ticket_id,
        steer_params,
        integration_head_before_steer,
        ..
    } = relocated_scenario_with_backend(StorageBackend::Tracked)?;
    let capture =
        TrackedRelocationCapture::capture(&fixture, &planned_proof.id, &expected_ticket_id)?;
    let h0 = Oid::from_str(&integration_head_before_steer)?;
    restore_tracked_checkout(&fixture, &capture, h0, "H0")?;

    fixture.store.append_event(&capture.request_event)?;
    fixture
        .store
        .write_journal(&capture.request_action_journal)?;
    let (failed_retry, partially_recovered_retry) = partial_steer_retry_journals(&capture);
    fixture.store.write_journal(&failed_retry)?;
    fixture.store.write_journal(&partially_recovered_retry)?;
    assert!(
        fixture
            .store
            .events()?
            .iter()
            .all(|event| event.event_type != "compiler.action.steer"),
        "the reconstructed pre-H1 crash must omit its action-completion event"
    );
    assert_eq!(completion_event_count(&fixture.store)?, 0);
    let transaction_root = fixture
        .store
        .root()
        .join("recovery/planned-proof-source-relocation");
    assert!(
        !transaction_root.exists() || fs::read_dir(&transaction_root)?.next().is_none(),
        "the reconstructed pre-H1 crash must not contain a transaction"
    );

    let quarantine = fixture
        .engine
        .execute_action("compile", BTreeMap::new())
        .expect_err("partial action success must quarantine ordinary compiler authority")
        .to_string();
    assert!(
        quarantine.contains("unfinished planned-proof source relocation"),
        "unexpected partial-action quarantine diagnostic: {quarantine}"
    );
    let recovery = fixture
        .engine
        .execute_action("recover", BTreeMap::new())
        .map_err(|error| format!("partial action-success recovery failed: {error}"))?;
    let preflight = recovery
        .get("preflight_planned_proof_source_relocations")
        .and_then(Value::as_array)
        .ok_or("partial action-success recovery omitted its relocation preflight")?;
    assert_eq!(preflight.len(), 1);
    assert_eq!(
        preflight[0].get("status").and_then(Value::as_str),
        Some("relocated")
    );

    let transaction = only_relocation_transaction(&fixture.store)?;
    let recovered_h1 = Oid::from_str(transaction_string(&transaction, "integration_head")?)?;
    assert_ne!(recovered_h1, h0);
    let repository = Repository::open(&fixture.root)?;
    let recovered_h1_commit = repository.find_commit(recovered_h1)?;
    assert_eq!(recovered_h1_commit.parent_count(), 1);
    assert_eq!(recovered_h1_commit.parent_id(0)?, h0);
    assert_exact_partial_action_h0_h1_delta(
        &fixture,
        h0,
        recovered_h1,
        [
            capture.request_action_journal.id.as_str(),
            failed_retry.id.as_str(),
            partially_recovered_retry.id.as_str(),
        ],
    )?;

    let h1_events = events_at_commit(&fixture, recovered_h1)?;
    let action_events = h1_events
        .iter()
        .filter(|event| event.event_type == "compiler.action.steer")
        .collect::<Vec<_>>();
    let [action_event] = action_events.as_slice() else {
        return Err(format!(
            "recovered H1 contains {} steer action-completion events",
            action_events.len()
        )
        .into());
    };
    assert_reconstructed_action_completion(
        action_event,
        &capture,
        [
            failed_retry.id.as_str(),
            partially_recovered_retry.id.as_str(),
        ],
    )?;

    let mut expected_failed_retry = failed_retry.clone();
    expected_failed_retry.status = JournalStatus::Recovered;
    assert_eq!(
        normalized_hash(&journal_at_commit(
            &fixture,
            recovered_h1,
            &failed_retry.id
        )?),
        normalized_hash(&expected_failed_retry)
    );
    assert_eq!(
        normalized_hash(&journal_at_commit(
            &fixture,
            recovered_h1,
            &partially_recovered_retry.id
        )?),
        normalized_hash(&partially_recovered_retry)
    );

    let current_head = repository.head()?.peel_to_commit()?.id();
    let recovered_h2 = first_parent_child_of(&repository, current_head, recovered_h1)?;
    assert_exact_relocation_delta_between(&fixture, &capture, recovered_h1, recovered_h2)?;
    drop(recovered_h1_commit);
    drop(repository);
    assert_recovered_tracked_relocation(
        &fixture,
        &capture,
        TrackedCrashPhase::CommittedRequest,
        recovered_h1,
    )?;

    let control = fixture.control()?;
    let mut orchestration = control
        .orchestration()?
        .ok_or("partial action-success fixture lost orchestration state")?;
    orchestration.set_running_at(true, chrono::Utc::now());
    control.write_orchestration(&orchestration)?;
    let replay_prestate = relocation_state_hashes(&fixture.store)?;
    let replay_head = GitBackend::discover(&fixture.root)?.head_oid()?.to_string();
    let replay = fixture
        .engine
        .execute_action("steer", steer_params)
        .map_err(|error| format!("partial action-success exact replay failed: {error}"))?;
    assert_eq!(
        replay.get("status").and_then(Value::as_str),
        Some("already_relocated")
    );
    assert_eq!(relocation_state_hashes(&fixture.store)?, replay_prestate);
    assert_eq!(
        GitBackend::discover(&fixture.root)?.head_oid()?.to_string(),
        replay_head
    );
    assert_eq!(
        fixture
            .store
            .events()?
            .iter()
            .filter(|event| event.event_type == "compiler.action.steer")
            .count(),
        1
    );
    orchestration.set_running_at(false, chrono::Utc::now());
    control.write_orchestration(&orchestration)?;
    Ok(())
}

#[test]
fn tracked_backend_recovery_rejects_action_success_missing_canonical_retry_binding()
-> Result<(), Box<dyn Error>> {
    let RelocationScenario {
        mut fixture,
        planned_proof,
        expected_ticket_id,
        integration_head_before_steer,
        ..
    } = relocated_scenario_with_backend(StorageBackend::Tracked)?;
    let capture =
        TrackedRelocationCapture::capture(&fixture, &planned_proof.id, &expected_ticket_id)?;
    let h0 = Oid::from_str(&integration_head_before_steer)?;
    restore_tracked_checkout(&fixture, &capture, h0, "H0")?;
    if capture.sync_marker_path.exists() {
        fs::remove_file(&capture.sync_marker_path)?;
    }

    let (_, recovered_retry) = partial_steer_retry_journals(&capture);
    assert_eq!(recovered_retry.status, JournalStatus::Recovered);
    let recorded_superseded = capture
        .action_completion_event
        .data
        .get("superseded_failed_journals")
        .and_then(Value::as_array)
        .ok_or("captured action-success event lost its superseded retry list")?;
    assert!(
        recorded_superseded
            .iter()
            .all(|value| value.as_str() != Some(recovered_retry.id.as_str())),
        "fixture action-success event unexpectedly binds the later reconstructed retry"
    );
    fixture.store.append_event(&capture.request_event)?;
    fixture
        .store
        .append_event(&capture.action_completion_event)?;
    fixture
        .store
        .write_journal(&capture.request_action_journal)?;
    fixture.store.write_journal(&recovered_retry)?;
    assert_eq!(GitBackend::discover(&fixture.root)?.head_oid()?, h0);
    assert_eq!(completion_event_count(&fixture.store)?, 0);

    let quarantine = fixture
        .engine
        .execute_action("compile", BTreeMap::new())
        .expect_err("incomplete canonical retry binding must quarantine ordinary authority")
        .to_string();
    assert!(
        quarantine.contains("unfinished planned-proof source relocation"),
        "unexpected incomplete-retry quarantine diagnostic: {quarantine}"
    );
    let recovery_error = fixture
        .engine
        .execute_action("recover", BTreeMap::new())
        .expect_err("configured recovery must reject an incomplete canonical success record")
        .to_string();
    assert!(
        recovery_error
            .contains("action-completion event is not the exact canonical success record"),
        "unexpected incomplete-retry recovery diagnostic: {recovery_error}"
    );
    assert_eq!(GitBackend::discover(&fixture.root)?.head_oid()?, h0);
    assert_eq!(completion_event_count(&fixture.store)?, 0);
    let transaction_root = fixture
        .store
        .root()
        .join("recovery/planned-proof-source-relocation");
    assert!(
        !transaction_root.exists() || fs::read_dir(&transaction_root)?.next().is_none(),
        "rejected incomplete retry binding must not publish a transaction"
    );
    assert_eq!(
        fixture
            .store
            .journals()?
            .into_iter()
            .find(|journal| journal.id == recovered_retry.id)
            .ok_or("rejected retry Journal disappeared")?
            .status,
        JournalStatus::Recovered
    );
    Ok(())
}

#[test]
fn tracked_backend_recovery_rejects_tree_excluded_blob_in_request_checkpoint()
-> Result<(), Box<dyn Error>> {
    let RelocationScenario {
        mut fixture,
        planned_proof,
        expected_ticket_id,
        integration_head_before_steer,
        ..
    } = relocated_scenario_with_backend(StorageBackend::Tracked)?;
    let capture =
        TrackedRelocationCapture::capture(&fixture, &planned_proof.id, &expected_ticket_id)?;
    let h0 = Oid::from_str(&integration_head_before_steer)?;
    restore_tracked_checkout(&fixture, &capture, h0, "H0")?;
    if capture.sync_marker_path.exists() {
        fs::remove_file(&capture.sync_marker_path)?;
    }

    fixture.store.append_event(&capture.request_event)?;
    fixture
        .store
        .append_event(&capture.action_completion_event)?;
    fixture
        .store
        .write_journal(&capture.request_action_journal)?;
    let excluded_blob = fixture
        .store
        .root()
        .join("locks/forged-relocation-authority.yaml");
    fs::create_dir_all(
        excluded_blob
            .parent()
            .ok_or("excluded blob has no parent")?,
    )?;
    fs::write(&excluded_blob, "schema_version: '1.0'\nforged: true\n")?;
    let repository = Repository::open(&fixture.root)?;
    let malicious_h1 = commit_exact_paths(
        &repository,
        &fixture.root,
        [
            fixture.store.root().join("events.jsonl"),
            fixture
                .store
                .root()
                .join("journals")
                .join(format!("{}.yaml", capture.request_action_journal.id)),
            excluded_blob.clone(),
        ],
        "test: reconstruct request checkpoint with excluded lock authority",
    )?;
    let malicious_commit = repository.find_commit(malicious_h1)?;
    assert_eq!(malicious_commit.parent_count(), 1);
    assert_eq!(malicious_commit.parent_id(0)?, h0);
    let changed = changed_paths_between(&repository, h0, malicious_h1)?;
    let expected = [
        fixture.store.root().join("events.jsonl"),
        fixture
            .store
            .root()
            .join("journals")
            .join(format!("{}.yaml", capture.request_action_journal.id)),
        excluded_blob.clone(),
    ]
    .into_iter()
    .map(|path| path.strip_prefix(&fixture.root).map(Path::to_path_buf))
    .collect::<Result<BTreeSet<_>, _>>()?;
    assert_eq!(changed, expected);
    let excluded_relative = excluded_blob.strip_prefix(&fixture.root)?;
    let excluded_entry = malicious_commit.tree()?.get_path(excluded_relative)?;
    assert_eq!(excluded_entry.kind(), Some(git2::ObjectType::Blob));
    assert_eq!(
        repository.find_blob(excluded_entry.id())?.content(),
        b"schema_version: '1.0'\nforged: true\n"
    );
    assert!(repository_status(&repository)?.is_empty());
    assert_eq!(completion_event_count(&fixture.store)?, 0);

    let quarantine = fixture
        .engine
        .execute_action("compile", BTreeMap::new())
        .expect_err("tree-excluded H1 authority must quarantine ordinary actions")
        .to_string();
    assert!(
        quarantine.contains("unfinished planned-proof source relocation"),
        "unexpected excluded-tree quarantine diagnostic: {quarantine}"
    );
    let recovery_error = fixture
        .engine
        .execute_action("recover", BTreeMap::new())
        .expect_err("configured recovery must reject a retained tree-excluded blob")
        .to_string();
    assert!(
        recovery_error.contains("request checkpoint retained tree-excluded authority")
            && recovery_error.contains("program/locks"),
        "unexpected excluded-tree recovery diagnostic: {recovery_error}"
    );
    assert_eq!(repository.head()?.peel_to_commit()?.id(), malicious_h1);
    assert_eq!(completion_event_count(&fixture.store)?, 0);
    let transaction_root = fixture
        .store
        .root()
        .join("recovery/planned-proof-source-relocation");
    assert!(
        !transaction_root.exists() || fs::read_dir(&transaction_root)?.next().is_none(),
        "rejected excluded-tree H1 must not publish a relocation transaction"
    );
    assert_eq!(
        fs::read(&excluded_blob)?,
        b"schema_version: '1.0'\nforged: true\n"
    );
    Ok(())
}

#[test]
fn tracked_backend_recovery_rejects_unrelated_request_checkpoint_change()
-> Result<(), Box<dyn Error>> {
    let RelocationScenario {
        mut fixture,
        planned_proof,
        expected_ticket_id,
        integration_head_before_steer,
        ..
    } = relocated_scenario_with_backend(StorageBackend::Tracked)?;
    let capture =
        TrackedRelocationCapture::capture(&fixture, &planned_proof.id, &expected_ticket_id)?;
    let h0 = Oid::from_str(&integration_head_before_steer)?;
    restore_tracked_checkout(&fixture, &capture, h0, "H0")?;
    if capture.sync_marker_path.exists() {
        fs::remove_file(&capture.sync_marker_path)?;
    }

    fixture.store.append_event(&capture.request_event)?;
    fixture
        .store
        .append_event(&capture.action_completion_event)?;
    fixture
        .store
        .write_journal(&capture.request_action_journal)?;
    let unrelated_path = fixture.root.join("src/unrelated-request-checkpoint.txt");
    fs::write(
        &unrelated_path,
        "this product change is outside relocation request authority\n",
    )?;
    let repository = Repository::open(&fixture.root)?;
    commit_all_changes(
        &repository,
        "test: reconstruct a malicious relocation request checkpoint",
    )?;
    let malicious_h1 = repository.head()?.peel_to_commit()?.id();
    let malicious_commit = repository.find_commit(malicious_h1)?;
    assert_eq!(malicious_commit.parent_count(), 1);
    assert_eq!(malicious_commit.parent_id(0)?, h0);
    let changed = changed_paths_between(&repository, h0, malicious_h1)?;
    let expected = [
        fixture.store.root().join("events.jsonl"),
        fixture
            .store
            .root()
            .join("journals")
            .join(format!("{}.yaml", capture.request_action_journal.id)),
        unrelated_path.clone(),
    ]
    .into_iter()
    .map(|path| path.strip_prefix(&fixture.root).map(Path::to_path_buf))
    .collect::<Result<BTreeSet<_>, _>>()?;
    assert_eq!(changed, expected);
    assert_eq!(completion_event_count(&fixture.store)?, 0);

    let quarantine = fixture
        .engine
        .execute_action("compile", BTreeMap::new())
        .expect_err("malicious request checkpoint must quarantine ordinary authority")
        .to_string();
    assert!(
        quarantine.contains("unfinished planned-proof source relocation"),
        "unexpected malicious-H1 quarantine diagnostic: {quarantine}"
    );
    let recovery_error = fixture
        .engine
        .execute_action("recover", BTreeMap::new())
        .expect_err("configured recovery must reject an unrelated H1 product change")
        .to_string();
    assert!(
        recovery_error.contains("request checkpoint contains unrelated tree changes")
            && recovery_error.contains("src/unrelated-request-checkpoint.txt"),
        "unexpected malicious-H1 recovery diagnostic for owner {}: {recovery_error}",
        capture.request_action_journal.id
    );
    assert_eq!(repository.head()?.peel_to_commit()?.id(), malicious_h1);
    assert_eq!(completion_event_count(&fixture.store)?, 0);
    let transaction_root = fixture
        .store
        .root()
        .join("recovery/planned-proof-source-relocation");
    assert!(
        !transaction_root.exists() || fs::read_dir(&transaction_root)?.next().is_none(),
        "rejected malicious H1 must not publish a relocation transaction"
    );
    assert_eq!(
        fs::read(&unrelated_path)?,
        b"this product change is outside relocation request authority\n"
    );
    Ok(())
}

#[test]
fn tracked_backend_recovery_finalizes_existing_h2_without_advancing_integration()
-> Result<(), Box<dyn Error>> {
    let RelocationScenario {
        mut fixture,
        empty_leased_ticket,
        planned_proof,
        expected_ticket_id,
        steer_params,
        ..
    } = relocated_scenario_with_options(StorageBackend::Tracked, true)?;
    let empty_leased_ticket = empty_leased_ticket
        .ok_or("post-H2 fixture did not preserve its deliberately empty leased ticket")?;
    let capture =
        TrackedRelocationCapture::capture(&fixture, &planned_proof.id, &expected_ticket_id)?;
    let integration_head = GitBackend::discover(&fixture.root)?.head_oid()?;
    assert_eq!(integration_head, capture.h2);
    assert_clean_ticket_checkout_at(&fixture, &empty_leased_ticket, capture.h2)?;
    let sealed_state = relocation_state_hashes(&fixture.store)?;
    assert_eq!(completion_event_count(&fixture.store)?, 1);
    assert_eq!(
        fs::read(&capture.sync_marker_path)?,
        capture.sync_marker_bytes
    );
    assert_eq!(
        serde_yaml::from_slice::<Value>(&capture.sync_marker_bytes)?,
        expected_relocation_sync_marker(&capture.complete_transaction, capture.h2)?
    );

    reset_clean_ticket_checkout_to_lease_base(&fixture, &empty_leased_ticket)?;
    let lease = empty_leased_ticket
        .lease
        .as_ref()
        .ok_or("empty ticket lost its retained lease")?;
    let base = Oid::from_str(&lease.base_commit)?;
    assert_clean_ticket_checkout_at(&fixture, &empty_leased_ticket, base)?;
    assert_eq!(GitBackend::discover(&fixture.root)?.head_oid()?, capture.h2);

    fs::remove_file(&capture.sync_marker_path)?;
    assert!(!capture.sync_marker_path.exists());
    assert_eq!(relocation_state_hashes(&fixture.store)?, sealed_state);
    assert_eq!(completion_event_count(&fixture.store)?, 1);
    assert_eq!(
        fs::read(&capture.transaction_path)?,
        capture.transaction_bytes
    );

    let quarantine = fixture
        .engine
        .execute_action("compile", BTreeMap::new())
        .expect_err("missing post-H2 synchronization proof must quarantine ordinary authority")
        .to_string();
    assert!(
        quarantine.contains("unfinished planned-proof source relocation"),
        "unexpected post-H2 quarantine diagnostic: {quarantine}"
    );
    assert_eq!(GitBackend::discover(&fixture.root)?.head_oid()?, capture.h2);

    let recovery = fixture
        .engine
        .execute_action("recover", BTreeMap::new())
        .map_err(|error| format!("post-H2 operational finalization failed: {error}"))?;
    let preflight = recovery
        .get("preflight_planned_proof_source_relocations")
        .and_then(Value::as_array)
        .ok_or("post-H2 recovery omitted its relocation preflight")?;
    assert_eq!(preflight.len(), 1);
    assert_eq!(
        preflight[0].get("status").and_then(Value::as_str),
        Some("already_relocated")
    );
    assert_eq!(
        GitBackend::discover(&fixture.root)?.head_oid()?,
        capture.h2,
        "post-H2 operational recovery must not create another integration checkpoint"
    );
    assert_eq!(
        relocation_state_hashes(&fixture.store)?,
        sealed_state,
        "post-H2 operational recovery must not republish semantic authority"
    );
    assert_eq!(completion_event_count(&fixture.store)?, 1);
    assert_eq!(
        fs::read(&capture.transaction_path)?,
        capture.transaction_bytes
    );
    assert_clean_ticket_checkout_at(&fixture, &empty_leased_ticket, capture.h2)?;
    let recovered_marker_bytes = fs::read(&capture.sync_marker_path)?;
    assert_eq!(recovered_marker_bytes, capture.sync_marker_bytes);
    assert_eq!(
        serde_yaml::from_slice::<Value>(&recovered_marker_bytes)?,
        expected_relocation_sync_marker(&capture.complete_transaction, capture.h2)?
    );

    fs::remove_file(&capture.sync_marker_path)?;
    set_ticket_index_and_workdir_to_commit_keep_ref(
        &fixture,
        &empty_leased_ticket,
        capture.h1,
        capture.h2,
    )?;
    assert_eq!(GitBackend::discover(&fixture.root)?.head_oid()?, capture.h2);
    assert_eq!(relocation_state_hashes(&fixture.store)?, sealed_state);
    let torn_quarantine = fixture
        .engine
        .execute_action("compile", BTreeMap::new())
        .expect_err("torn post-H2 ticket checkout must quarantine ordinary authority")
        .to_string();
    assert!(
        torn_quarantine.contains("unfinished planned-proof source relocation"),
        "unexpected torn-checkout quarantine diagnostic: {torn_quarantine}"
    );
    let torn_recovery = fixture
        .engine
        .execute_action("recover", BTreeMap::new())
        .map_err(|error| format!("torn post-H2 checkout recovery failed: {error}"))?;
    let torn_preflight = torn_recovery
        .get("preflight_planned_proof_source_relocations")
        .and_then(Value::as_array)
        .ok_or("torn post-H2 recovery omitted its relocation preflight")?;
    assert_eq!(torn_preflight.len(), 1);
    assert_eq!(
        torn_preflight[0].get("status").and_then(Value::as_str),
        Some("already_relocated")
    );
    assert_eq!(
        GitBackend::discover(&fixture.root)?.head_oid()?,
        capture.h2,
        "torn post-H2 recovery must leave the semantic seal current"
    );
    assert_eq!(relocation_state_hashes(&fixture.store)?, sealed_state);
    assert_eq!(completion_event_count(&fixture.store)?, 1);
    assert_clean_ticket_checkout_at(&fixture, &empty_leased_ticket, capture.h2)?;
    assert_eq!(fs::read(&capture.sync_marker_path)?, recovered_marker_bytes);

    let control = fixture.control()?;
    let mut orchestration = control
        .orchestration()?
        .ok_or("post-H2 fixture lost orchestration state")?;
    orchestration.set_running_at(true, chrono::Utc::now());
    control.write_orchestration(&orchestration)?;
    let replay_state = relocation_state_hashes(&fixture.store)?;
    let replay_head = GitBackend::discover(&fixture.root)?.head_oid()?;
    let replay = fixture
        .engine
        .execute_action("steer", steer_params)
        .map_err(|error| format!("post-H2 exact replay failed: {error}"))?;
    assert_eq!(
        replay.get("status").and_then(Value::as_str),
        Some("already_relocated")
    );
    assert_eq!(relocation_state_hashes(&fixture.store)?, replay_state);
    assert_eq!(
        GitBackend::discover(&fixture.root)?.head_oid()?,
        replay_head
    );
    assert_eq!(fs::read(&capture.sync_marker_path)?, recovered_marker_bytes);
    assert_clean_ticket_checkout_at(&fixture, &empty_leased_ticket, capture.h2)?;
    orchestration.set_running_at(false, chrono::Utc::now());
    control.write_orchestration(&orchestration)?;
    Ok(())
}

struct TrackedRelocationCapture {
    complete_transaction: Value,
    transaction_path: PathBuf,
    transaction_bytes: Vec<u8>,
    amended_node: Node,
    amended_node_path: PathBuf,
    amended_node_bytes: Vec<u8>,
    expected_ticket: Ticket,
    expected_ticket_path: PathBuf,
    expected_ticket_bytes: Vec<u8>,
    recovered_journal: Journal,
    recovered_journal_path: PathBuf,
    recovered_journal_bytes: Vec<u8>,
    request_event: Event,
    request_action_journal: Journal,
    action_completion_event: Event,
    full_compile_event: Event,
    completion_event: Event,
    sync_marker_path: PathBuf,
    sync_marker_bytes: Vec<u8>,
    integration_ref: String,
    h1: Oid,
    h2: Oid,
}

impl TrackedRelocationCapture {
    fn capture(
        fixture: &LegacySoftwareFixture,
        proof_node_id: &str,
        expected_ticket_id: &str,
    ) -> Result<Self, Box<dyn Error>> {
        let complete_transaction = only_relocation_transaction(&fixture.store)?;
        assert_transaction_self_hash(&complete_transaction)?;
        let transaction_path = only_relocation_transaction_path(&fixture.store)?;
        let transaction_bytes = fs::read(&transaction_path)?;

        let amended_node = fixture
            .store
            .graph()?
            .node(proof_node_id)
            .cloned()
            .ok_or("tracked relocation capture lost its amended proof node")?;
        let amended_node_path = graph_node_path(&fixture.store, proof_node_id)?;
        let amended_node_bytes = fs::read(&amended_node_path)?;

        let expected_ticket = fixture.store.ticket(expected_ticket_id)?;
        let expected_ticket_path = ticket_path(&fixture.store, expected_ticket_id)?;
        let expected_ticket_bytes = fs::read(&expected_ticket_path)?;

        let failed_journal_id =
            transaction_string(&complete_transaction, "failed_compile_journal_id")?;
        let recovered_journal = fixture
            .store
            .journals()?
            .into_iter()
            .find(|journal| journal.id == failed_journal_id)
            .ok_or("tracked relocation capture lost its failed compile Journal")?;
        assert_eq!(recovered_journal.status, JournalStatus::Recovered);
        let recovered_journal_path = fixture
            .store
            .root()
            .join("journals")
            .join(format!("{}.yaml", recovered_journal.id));
        let recovered_journal_bytes = fs::read(&recovered_journal_path)?;

        let events = fixture.store.events()?;
        let request_event_id = transaction_string(&complete_transaction, "request_event_id")?;
        let request_event = events
            .iter()
            .find(|event| event.id == request_event_id)
            .cloned()
            .ok_or("tracked relocation capture lost its owning steering event")?;
        let request_action_journal_id =
            transaction_string(&complete_transaction, "request_action_journal_id")?;
        let request_action_journal = fixture
            .store
            .journals()?
            .into_iter()
            .find(|journal| journal.id == request_action_journal_id)
            .ok_or("tracked relocation capture lost its Complete steer Journal")?;
        assert_eq!(request_action_journal.status, JournalStatus::Complete);
        let action_completion_events = events
            .iter()
            .filter(|event| {
                event.event_type == "compiler.action.steer"
                    && event.data.get("journal").and_then(Value::as_str)
                        == Some(request_action_journal_id)
            })
            .cloned()
            .collect::<Vec<_>>();
        let [action_completion_event] = action_completion_events.as_slice() else {
            return Err(format!(
                "tracked relocation capture found {} action-completion events",
                action_completion_events.len()
            )
            .into());
        };
        let full_compile_event_id =
            transaction_string(&complete_transaction, "full_compile_event_id")?;
        let full_compile_event = events
            .iter()
            .find(|event| event.id == full_compile_event_id)
            .cloned()
            .ok_or("tracked relocation capture lost its full compile event")?;
        let completion_event = events
            .iter()
            .find(|event| event.event_type == RELOCATION_COMPLETED_EVENT)
            .cloned()
            .ok_or("tracked relocation capture lost its completion event")?;
        let sync_marker_path = relocation_sync_marker_path(fixture, &complete_transaction)?;
        let sync_marker_bytes = fs::read(&sync_marker_path)?;

        let integration_ref =
            transaction_string(&complete_transaction, "integration_ref")?.to_owned();
        let h1 = Oid::from_str(transaction_string(
            &complete_transaction,
            "integration_head",
        )?)?;
        let repository = Repository::open(&fixture.root)?;
        let h2 = repository.head()?.peel_to_commit()?.id();
        let h2_commit = repository.find_commit(h2)?;
        assert_eq!(h2_commit.parent_count(), 1);
        assert_eq!(
            h2_commit.parent_id(0)?,
            h1,
            "the authentic complete relocation checkpoint must directly follow H1"
        );

        let capture = Self {
            complete_transaction,
            transaction_path,
            transaction_bytes,
            amended_node,
            amended_node_path,
            amended_node_bytes,
            expected_ticket,
            expected_ticket_path,
            expected_ticket_bytes,
            recovered_journal,
            recovered_journal_path,
            recovered_journal_bytes,
            request_event,
            request_action_journal,
            action_completion_event: action_completion_event.clone(),
            full_compile_event,
            completion_event,
            sync_marker_path,
            sync_marker_bytes,
            integration_ref,
            h1,
            h2,
        };
        assert_exact_h1_h2_relocation_delta(fixture, &capture)?;
        Ok(capture)
    }
}

fn restore_tracked_relocation_phase(
    fixture: &LegacySoftwareFixture,
    capture: &TrackedRelocationCapture,
    phase: TrackedCrashPhase,
) -> Result<(), Box<dyn Error>> {
    restore_tracked_checkout_to_h1(fixture, capture)?;
    assert_eq!(completion_event_count(&fixture.store)?, 0);
    let transaction_root = fixture
        .store
        .root()
        .join("recovery/planned-proof-source-relocation");
    assert!(
        !transaction_root.exists() || fs::read_dir(&transaction_root)?.next().is_none(),
        "H1 must not contain a relocation transaction"
    );
    assert!(fixture.store.ticket(&capture.expected_ticket.id).is_err());
    assert_eq!(
        fixture
            .store
            .journals()?
            .into_iter()
            .find(|journal| journal.id == capture.recovered_journal.id)
            .ok_or("H1 lost its failed compile Journal")?
            .status,
        JournalStatus::Failed
    );

    match phase {
        TrackedCrashPhase::CommittedRequest => {}
        TrackedCrashPhase::PreparedAfterGraph => {
            write_captured_file(&capture.amended_node_path, &capture.amended_node_bytes)?;
            write_derived_transaction(capture, "prepared")?;
        }
        TrackedCrashPhase::GraphPublishedAfterCompile => {
            write_compiled_relocation_artifacts(fixture, capture, false)?;
            write_derived_transaction(capture, "graph_published")?;
        }
        TrackedCrashPhase::CompiledAfterJournalRecovery => {
            write_compiled_relocation_artifacts(fixture, capture, true)?;
            write_derived_transaction(capture, "compiled")?;
        }
        TrackedCrashPhase::CompleteWithoutEvent => {
            write_compiled_relocation_artifacts(fixture, capture, true)?;
            write_captured_file(&capture.transaction_path, &capture.transaction_bytes)?;
        }
        TrackedCrashPhase::CompleteWithoutCheckpoint => {
            write_compiled_relocation_artifacts(fixture, capture, true)?;
            fixture.store.append_event(&capture.completion_event)?;
            write_captured_file(&capture.transaction_path, &capture.transaction_bytes)?;
        }
    }
    Ok(())
}

fn write_compiled_relocation_artifacts(
    fixture: &LegacySoftwareFixture,
    capture: &TrackedRelocationCapture,
    recover_journal: bool,
) -> Result<(), Box<dyn Error>> {
    write_captured_file(&capture.amended_node_path, &capture.amended_node_bytes)?;
    write_captured_file(
        &capture.expected_ticket_path,
        &capture.expected_ticket_bytes,
    )?;
    fixture.store.append_event(&capture.full_compile_event)?;
    if recover_journal {
        write_captured_file(
            &capture.recovered_journal_path,
            &capture.recovered_journal_bytes,
        )?;
    }
    Ok(())
}

fn write_derived_transaction(
    capture: &TrackedRelocationCapture,
    status: &str,
) -> Result<(), Box<dyn Error>> {
    let mut transaction = capture.complete_transaction.clone();
    {
        let object = transaction
            .as_object_mut()
            .ok_or("relocation transaction is not an object")?;
        object.insert("status".to_owned(), Value::String(status.to_owned()));
        object.insert("completed_at".to_owned(), Value::Null);
        if status != "compiled" {
            object.remove("full_compile_event_id");
            object.remove("full_compile_event_hash");
        }
        object.insert("transaction_hash".to_owned(), Value::String(String::new()));
    }
    let transaction_hash = normalized_hash(&transaction);
    transaction
        .as_object_mut()
        .expect("transaction remains an object")
        .insert(
            "transaction_hash".to_owned(),
            Value::String(transaction_hash),
        );
    assert_transaction_self_hash(&transaction)?;
    write_captured_file(
        &capture.transaction_path,
        serde_yaml::to_string(&transaction)?.as_bytes(),
    )
}

fn write_captured_file(path: &Path, bytes: &[u8]) -> Result<(), Box<dyn Error>> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, bytes)?;
    Ok(())
}

fn restore_tracked_checkout_to_h1(
    fixture: &LegacySoftwareFixture,
    capture: &TrackedRelocationCapture,
) -> Result<(), Box<dyn Error>> {
    restore_tracked_checkout(fixture, capture, capture.h1, "H1")
}

fn restore_tracked_checkout(
    fixture: &LegacySoftwareFixture,
    capture: &TrackedRelocationCapture,
    target: Oid,
    target_label: &str,
) -> Result<(), Box<dyn Error>> {
    let repository = Repository::open(&fixture.root)?;
    assert_eq!(repository.head()?.peel_to_commit()?.id(), capture.h2);
    assert_eq!(
        repository
            .find_reference(&capture.integration_ref)?
            .peel_to_commit()?
            .id(),
        capture.h2
    );
    let transaction_id = transaction_string(&capture.complete_transaction, "id")?;
    repository.reference(
        &format!("refs/koni-tests/relocation-h2/{transaction_id}"),
        capture.h2,
        true,
        "retain the authentic relocation seal for crash reconstruction",
    )?;
    repository.reference_matching(
        &capture.integration_ref,
        target,
        true,
        capture.h2,
        &format!("restore the disposable relocation fixture to {target_label}"),
    )?;
    repository.set_head(&capture.integration_ref)?;
    {
        let target_commit = repository.find_commit(target)?;
        let tree = target_commit.tree()?;
        let mut index = repository.index()?;
        index.read_tree(&tree)?;
        index.write()?;
    }
    let mut checkout = git2::build::CheckoutBuilder::new();
    checkout
        .force()
        .recreate_missing(true)
        .remove_untracked(true)
        .update_index(true);
    repository.checkout_head(Some(&mut checkout))?;
    assert_eq!(repository.head()?.peel_to_commit()?.id(), target);
    assert_eq!(
        repository
            .find_reference(&capture.integration_ref)?
            .peel_to_commit()?
            .id(),
        target
    );
    assert!(
        repository_status(&repository)?.is_empty(),
        "restoring the disposable integration checkout to {target_label} must be clean"
    );
    Ok(())
}

fn reset_clean_ticket_checkout_to_lease_base(
    fixture: &LegacySoftwareFixture,
    ticket: &Ticket,
) -> Result<(), Box<dyn Error>> {
    let lease = ticket
        .lease
        .as_ref()
        .ok_or_else(|| format!("ticket {} has no retained lease", ticket.id))?;
    let base = Oid::from_str(&lease.base_commit)?;
    let reference_name = format!("refs/heads/{}", lease.branch);
    let main_repository = Repository::open(&fixture.root)?;
    let ticket_repository = Repository::open(&lease.worktree)?;
    assert!(
        repository_status(&ticket_repository)?.is_empty(),
        "ticket {} must be clean before reconstructing the pre-sync checkout",
        ticket.id
    );
    let mut reference = main_repository.find_reference(&reference_name)?;
    if reference.target() != Some(base) {
        reference.set_target(base, "reconstruct post-H2 pre-synchronization ticket base")?;
    }
    drop(reference);
    ticket_repository.set_head(&reference_name)?;
    {
        let base_commit = ticket_repository.find_commit(base)?;
        let tree = base_commit.tree()?;
        let mut index = ticket_repository.index()?;
        index.read_tree(&tree)?;
        index.write()?;
    }
    let mut checkout = git2::build::CheckoutBuilder::new();
    checkout
        .force()
        .recreate_missing(true)
        .remove_untracked(true)
        .update_index(true);
    ticket_repository.checkout_head(Some(&mut checkout))?;
    assert_clean_ticket_checkout_at(fixture, ticket, base)
}

fn assert_clean_ticket_checkout_at(
    fixture: &LegacySoftwareFixture,
    ticket: &Ticket,
    expected: Oid,
) -> Result<(), Box<dyn Error>> {
    let lease = ticket
        .lease
        .as_ref()
        .ok_or_else(|| format!("ticket {} has no retained lease", ticket.id))?;
    let reference_name = format!("refs/heads/{}", lease.branch);
    let main_repository = Repository::open(&fixture.root)?;
    assert_eq!(
        main_repository.find_reference(&reference_name)?.target(),
        Some(expected),
        "ticket {} branch is not synchronized to the expected commit",
        ticket.id
    );
    let ticket_repository = Repository::open(&lease.worktree)?;
    assert_eq!(ticket_repository.head()?.name()?, reference_name);
    assert_eq!(ticket_repository.head()?.peel_to_commit()?.id(), expected);
    assert!(
        repository_status(&ticket_repository)?.is_empty(),
        "ticket {} checkout must remain clean",
        ticket.id
    );
    Ok(())
}

fn set_ticket_index_and_workdir_to_commit_keep_ref(
    fixture: &LegacySoftwareFixture,
    ticket: &Ticket,
    checkout_commit: Oid,
    reference_commit: Oid,
) -> Result<(), Box<dyn Error>> {
    assert_ne!(checkout_commit, reference_commit);
    assert_clean_ticket_checkout_at(fixture, ticket, reference_commit)?;
    let lease = ticket
        .lease
        .as_ref()
        .ok_or_else(|| format!("ticket {} has no retained lease", ticket.id))?;
    let repository = Repository::open(&lease.worktree)?;
    let tree = repository.find_commit(checkout_commit)?.tree()?;
    let mut index = repository.index()?;
    index.read_tree(&tree)?;
    index.write()?;
    let mut checkout = git2::build::CheckoutBuilder::new();
    checkout
        .force()
        .recreate_missing(true)
        .remove_untracked(true)
        .update_index(true);
    repository.checkout_index(Some(&mut index), Some(&mut checkout))?;
    assert_ticket_index_and_workdir_at_with_ref(fixture, ticket, checkout_commit, reference_commit)
}

fn assert_ticket_index_and_workdir_at_with_ref(
    fixture: &LegacySoftwareFixture,
    ticket: &Ticket,
    checkout_commit: Oid,
    reference_commit: Oid,
) -> Result<(), Box<dyn Error>> {
    let lease = ticket
        .lease
        .as_ref()
        .ok_or_else(|| format!("ticket {} has no retained lease", ticket.id))?;
    let reference_name = format!("refs/heads/{}", lease.branch);
    let main_repository = Repository::open(&fixture.root)?;
    assert_eq!(
        main_repository.find_reference(&reference_name)?.target(),
        Some(reference_commit)
    );
    let repository = Repository::open(&lease.worktree)?;
    assert_eq!(repository.head()?.name()?, reference_name);
    assert_eq!(repository.head()?.peel_to_commit()?.id(), reference_commit);
    let expected_tree = repository.find_commit(checkout_commit)?.tree_id();
    let mut index = repository.index()?;
    assert_eq!(index.write_tree()?, expected_tree);
    assert_eq!(
        repository
            .diff_index_to_workdir(Some(&index), None)?
            .deltas()
            .len(),
        0,
        "ticket {} workdir must exactly match its deliberately torn index",
        ticket.id
    );
    let mut status_options = git2::StatusOptions::new();
    status_options
        .include_untracked(true)
        .recurse_untracked_dirs(true);
    let statuses = repository.statuses(Some(&mut status_options))?;
    assert!(
        !statuses.is_empty(),
        "ticket {} must expose its torn checkout relative to the H2 branch",
        ticket.id
    );
    assert!(
        statuses.iter().all(|entry| !entry.status().is_wt_new()),
        "ticket {} torn checkout retained untracked files",
        ticket.id
    );
    Ok(())
}

fn partial_steer_retry_journals(capture: &TrackedRelocationCapture) -> (Journal, Journal) {
    let mut failed = capture.request_action_journal.clone();
    failed.id = Uuid::now_v7().to_string();
    failed.status = JournalStatus::Failed;
    failed.started_at -= chrono::Duration::seconds(2);
    failed.completed_steps = vec![0];
    failed.outputs.clear();
    failed.error = Some("fixture: transient event publication failure".to_owned());

    let mut recovered = failed.clone();
    recovered.id = Uuid::now_v7().to_string();
    recovered.status = JournalStatus::Recovered;
    recovered.started_at += chrono::Duration::seconds(1);
    recovered.error = Some("fixture: earlier identical retry was already recovered".to_owned());
    (failed, recovered)
}

fn assert_exact_partial_action_h0_h1_delta<const N: usize>(
    fixture: &LegacySoftwareFixture,
    h0: Oid,
    h1: Oid,
    journal_ids: [&str; N],
) -> Result<(), Box<dyn Error>> {
    let repository = Repository::open(&fixture.root)?;
    let h0_tree = repository.find_commit(h0)?.tree()?;
    let h1_tree = repository.find_commit(h1)?.tree()?;
    let changed = repository
        .diff_tree_to_tree(Some(&h0_tree), Some(&h1_tree), None)?
        .deltas()
        .filter_map(|delta| {
            delta
                .new_file()
                .path()
                .or_else(|| delta.old_file().path())
                .map(Path::to_path_buf)
        })
        .collect::<BTreeSet<_>>();
    let mut expected = BTreeSet::from([fixture
        .store
        .root()
        .join("events.jsonl")
        .strip_prefix(&fixture.root)?
        .to_path_buf()]);
    for journal_id in journal_ids {
        expected.insert(
            fixture
                .store
                .root()
                .join("journals")
                .join(format!("{journal_id}.yaml"))
                .strip_prefix(&fixture.root)?
                .to_path_buf(),
        );
    }
    assert_eq!(
        changed, expected,
        "partial action-success H1 must contain only the event ledger and its exact steer Journal family"
    );
    Ok(())
}

fn assert_reconstructed_action_completion(
    event: &Event,
    capture: &TrackedRelocationCapture,
    retry_ids: [&str; 2],
) -> Result<(), Box<dyn Error>> {
    assert_eq!(event.schema_version, "1.0");
    assert_eq!(event.event_type, "compiler.action.steer");
    assert_eq!(event.run_id, capture.action_completion_event.run_id);
    assert_eq!(event.ticket_id, capture.action_completion_event.ticket_id);
    assert_eq!(event.actor, capture.action_completion_event.actor);
    assert_eq!(
        event.data.get("journal").and_then(Value::as_str),
        Some(capture.request_action_journal.id.as_str())
    );
    let superseded = event
        .data
        .get("superseded_failed_journals")
        .and_then(Value::as_array)
        .ok_or("reconstructed action completion omitted its superseded Journal list")?
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(ToOwned::to_owned)
                .ok_or("reconstructed superseded Journal ID is not a string")
        })
        .collect::<Result<BTreeSet<_>, _>>()?;
    assert_eq!(
        superseded,
        retry_ids.into_iter().map(ToOwned::to_owned).collect(),
        "reconstructed action completion must bind every partially transitioned same-input retry"
    );
    Ok(())
}

fn events_at_commit(
    fixture: &LegacySoftwareFixture,
    commit: Oid,
) -> Result<Vec<Event>, Box<dyn Error>> {
    let relative = fixture
        .store
        .root()
        .join("events.jsonl")
        .strip_prefix(&fixture.root)?
        .to_path_buf();
    let bytes = blob_at_commit(&fixture.root, commit, &relative)?;
    std::str::from_utf8(&bytes)?
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str::<Event>(line).map_err(Into::into))
        .collect()
}

fn journal_at_commit(
    fixture: &LegacySoftwareFixture,
    commit: Oid,
    journal_id: &str,
) -> Result<Journal, Box<dyn Error>> {
    let relative = fixture
        .store
        .root()
        .join("journals")
        .join(format!("{journal_id}.yaml"))
        .strip_prefix(&fixture.root)?
        .to_path_buf();
    Ok(serde_yaml::from_slice(&blob_at_commit(
        &fixture.root,
        commit,
        &relative,
    )?)?)
}

fn blob_at_commit(
    repository_root: &Path,
    commit: Oid,
    relative: &Path,
) -> Result<Vec<u8>, Box<dyn Error>> {
    let repository = Repository::open(repository_root)?;
    let tree = repository.find_commit(commit)?.tree()?;
    let entry = tree.get_path(relative)?;
    Ok(repository.find_blob(entry.id())?.content().to_vec())
}

fn first_parent_child_of(
    repository: &Repository,
    tip: Oid,
    ancestor: Oid,
) -> Result<Oid, Box<dyn Error>> {
    let mut cursor = repository.find_commit(tip)?;
    loop {
        if cursor.parent_count() == 0 {
            return Err(format!(
                "first-parent history from {tip} did not reach relocation authority {ancestor}"
            )
            .into());
        }
        let parent = cursor.parent(0)?;
        if parent.id() == ancestor {
            return Ok(cursor.id());
        }
        cursor = parent;
    }
}

fn changed_paths_between(
    repository: &Repository,
    parent: Oid,
    child: Oid,
) -> Result<BTreeSet<PathBuf>, Box<dyn Error>> {
    let parent_tree = repository.find_commit(parent)?.tree()?;
    let child_tree = repository.find_commit(child)?.tree()?;
    Ok(repository
        .diff_tree_to_tree(Some(&parent_tree), Some(&child_tree), None)?
        .deltas()
        .filter_map(|delta| {
            delta
                .new_file()
                .path()
                .or_else(|| delta.old_file().path())
                .map(Path::to_path_buf)
        })
        .collect())
}

fn assert_exact_h1_h2_relocation_delta(
    fixture: &LegacySoftwareFixture,
    capture: &TrackedRelocationCapture,
) -> Result<(), Box<dyn Error>> {
    assert_exact_relocation_delta_between(fixture, capture, capture.h1, capture.h2)
}

fn assert_exact_relocation_delta_between(
    fixture: &LegacySoftwareFixture,
    capture: &TrackedRelocationCapture,
    h1: Oid,
    h2: Oid,
) -> Result<(), Box<dyn Error>> {
    let repository = Repository::open(&fixture.root)?;
    let h1_tree = repository.find_commit(h1)?.tree()?;
    let h2_tree = repository.find_commit(h2)?.tree()?;
    let changed = repository
        .diff_tree_to_tree(Some(&h1_tree), Some(&h2_tree), None)?
        .deltas()
        .filter_map(|delta| {
            delta
                .new_file()
                .path()
                .or_else(|| delta.old_file().path())
                .map(Path::to_path_buf)
        })
        .collect::<BTreeSet<_>>();
    let expected = [
        capture.transaction_path.as_path(),
        fixture.store.root().join("events.jsonl").as_path(),
        capture.recovered_journal_path.as_path(),
        capture.amended_node_path.as_path(),
        capture.expected_ticket_path.as_path(),
    ]
    .into_iter()
    .map(|path| path.strip_prefix(&fixture.root).map(Path::to_path_buf))
    .collect::<Result<BTreeSet<_>, _>>()?;
    assert_eq!(
        changed, expected,
        "H1-to-H2 must contain only the relocation transaction, event ledger, recovered Journal, amended node, and expected ticket"
    );
    Ok(())
}

fn assert_exact_h0_h1_request_delta(
    fixture: &LegacySoftwareFixture,
    h0: &str,
    h1: &str,
    action_journal_id: &str,
) -> Result<(), Box<dyn Error>> {
    let repository = Repository::open(&fixture.root)?;
    let h0_tree = repository.find_commit(Oid::from_str(h0)?)?.tree()?;
    let h1_tree = repository.find_commit(Oid::from_str(h1)?)?.tree()?;
    let changed = repository
        .diff_tree_to_tree(Some(&h0_tree), Some(&h1_tree), None)?
        .deltas()
        .filter_map(|delta| {
            delta
                .new_file()
                .path()
                .or_else(|| delta.old_file().path())
                .map(Path::to_path_buf)
        })
        .collect::<BTreeSet<_>>();
    let expected = [
        fixture.store.root().join("events.jsonl"),
        fixture
            .store
            .root()
            .join("journals")
            .join(format!("{action_journal_id}.yaml")),
    ]
    .into_iter()
    .map(|path| path.strip_prefix(&fixture.root).map(Path::to_path_buf))
    .collect::<Result<BTreeSet<_>, _>>()?;
    assert_eq!(
        changed, expected,
        "H0-to-H1 must contain only the exact owning event ledger and Complete steer Journal"
    );
    Ok(())
}

fn assert_recovered_tracked_relocation(
    fixture: &LegacySoftwareFixture,
    capture: &TrackedRelocationCapture,
    phase: TrackedCrashPhase,
    authority_head: Oid,
) -> Result<(), Box<dyn Error>> {
    let transaction = only_relocation_transaction(&fixture.store)?;
    assert_eq!(
        transaction.get("status").and_then(Value::as_str),
        Some("complete")
    );
    assert_transaction_self_hash(&transaction)?;
    assert_eq!(
        transaction
            .get("expected_ticket_id")
            .and_then(Value::as_str),
        Some(capture.expected_ticket.id.as_str())
    );
    assert_eq!(
        normalized_hash(
            fixture
                .store
                .graph()?
                .node(&capture.amended_node.id)
                .ok_or("recovery lost its amended proof node")?
        ),
        normalized_hash(&capture.amended_node),
        "{} recovered the wrong graph authority",
        phase.label()
    );
    let recovered_ticket = fixture.store.ticket(&capture.expected_ticket.id)?;
    assert_relocated_preparation_ticket(&recovered_ticket, &capture.amended_node.id);
    assert_eq!(
        normalized_hash(&recovered_ticket),
        normalized_hash(&capture.expected_ticket),
        "{} recovered the wrong deterministic ticket",
        phase.label()
    );
    let recovered_journal = fixture
        .store
        .journals()?
        .into_iter()
        .find(|journal| journal.id == capture.recovered_journal.id)
        .ok_or("recovery lost its failed compile Journal")?;
    assert_eq!(recovered_journal.status, JournalStatus::Recovered);
    assert_eq!(
        normalized_hash(&recovered_journal),
        normalized_hash(&capture.recovered_journal),
        "{} recovered a non-exact compile Journal",
        phase.label()
    );

    let events = fixture.store.events()?;
    let full_compile_event_id = transaction_string(&transaction, "full_compile_event_id")?;
    let full_compile_event = events
        .iter()
        .find(|event| event.id == full_compile_event_id)
        .ok_or("recovery transaction lost its full compile event")?;
    assert_eq!(
        transaction
            .get("full_compile_event_hash")
            .and_then(Value::as_str),
        Some(normalized_hash(full_compile_event).as_str())
    );
    if !matches!(
        phase,
        TrackedCrashPhase::CommittedRequest | TrackedCrashPhase::PreparedAfterGraph
    ) {
        assert_eq!(
            normalized_hash(full_compile_event),
            normalized_hash(&capture.full_compile_event),
            "{} did not reuse its already-published exact compile event",
            phase.label()
        );
    }
    let completion_events = events
        .iter()
        .filter(|event| event.event_type == RELOCATION_COMPLETED_EVENT)
        .collect::<Vec<_>>();
    let [completion_event] = completion_events.as_slice() else {
        return Err(format!(
            "{} recovered {} completion events instead of one",
            phase.label(),
            completion_events.len()
        )
        .into());
    };
    assert_eq!(
        completion_event
            .data
            .get("transaction_hash")
            .and_then(Value::as_str),
        transaction.get("transaction_hash").and_then(Value::as_str)
    );
    if matches!(phase, TrackedCrashPhase::CompleteWithoutCheckpoint) {
        assert_eq!(
            normalized_hash(*completion_event),
            normalized_hash(&capture.completion_event),
            "the checkpoint-only crash must preserve its exact completion event"
        );
    }

    let repository = Repository::open(&fixture.root)?;
    let head = repository.head()?.peel_to_commit()?.id();
    assert_ne!(head, authority_head);
    assert!(
        repository.graph_descendant_of(head, authority_head)?,
        "{} recovery checkpoint must descend from H1",
        phase.label()
    );
    assert!(
        repository_status(&repository)?.is_empty(),
        "{} configured recovery must leave its tracked checkout clean",
        phase.label()
    );
    Ok(())
}

fn assert_transaction_self_hash(transaction: &Value) -> Result<(), Box<dyn Error>> {
    let expected = transaction_string(transaction, "transaction_hash")?.to_owned();
    let mut unhashed = transaction.clone();
    unhashed
        .as_object_mut()
        .ok_or("relocation transaction is not an object")?
        .insert("transaction_hash".to_owned(), Value::String(String::new()));
    assert_eq!(normalized_hash(&unhashed), expected);
    Ok(())
}

fn transaction_string<'a>(transaction: &'a Value, field: &str) -> Result<&'a str, Box<dyn Error>> {
    transaction
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("relocation transaction omitted {field}").into())
}

fn relocation_sync_marker_path(
    fixture: &LegacySoftwareFixture,
    transaction: &Value,
) -> Result<PathBuf, Box<dyn Error>> {
    let request_hash = transaction_string(transaction, "request_hash")?;
    let suffix = request_hash
        .strip_prefix("sha256:")
        .ok_or("relocation sync marker request hash has an unknown format")?;
    if suffix.len() != 64 || !suffix.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("relocation sync marker request hash is not canonical".into());
    }
    let run_id = transaction_string(transaction, "run_id")?;
    Ok(GitBackend::discover(&fixture.root)?
        .common_dir()
        .join("koni/runs")
        .join(run_id)
        .join("recovery/planned-proof-source-relocation-sync")
        .join(format!("{suffix}.yaml")))
}

fn expected_relocation_sync_marker(
    transaction: &Value,
    seal_commit: Oid,
) -> Result<Value, Box<dyn Error>> {
    Ok(json!({
        "schema_version": "1.0",
        "transaction_id": transaction_string(transaction, "id")?,
        "transaction_hash": transaction_string(transaction, "transaction_hash")?,
        "run_id": transaction_string(transaction, "run_id")?,
        "integration_ref": transaction_string(transaction, "integration_ref")?,
        "seal_commit": seal_commit.to_string(),
    }))
}

fn graph_node_path(store: &StateStore, node_id: &str) -> Result<PathBuf, Box<dyn Error>> {
    let paths = WalkDir::new(store.graph_dir())
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .filter_map(|entry| {
            let path = entry.into_path();
            let node = fs::read_to_string(&path)
                .ok()
                .and_then(|text| serde_yaml::from_str::<Node>(&text).ok())?;
            (node.id == node_id).then_some(path)
        })
        .collect::<Vec<_>>();
    match paths.as_slice() {
        [path] => Ok(path.clone()),
        _ => Err(format!(
            "expected one graph file for {node_id}, found {}",
            paths.len()
        )
        .into()),
    }
}

fn ticket_path(store: &StateStore, ticket_id: &str) -> Result<PathBuf, Box<dyn Error>> {
    let paths = WalkDir::new(store.tickets_dir())
        .min_depth(1)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .filter_map(|entry| {
            let path = entry.into_path();
            let ticket = fs::read_to_string(&path)
                .ok()
                .and_then(|text| serde_yaml::from_str::<Ticket>(&text).ok())?;
            (ticket.id == ticket_id).then_some(path)
        })
        .collect::<Vec<_>>();
    match paths.as_slice() {
        [path] => Ok(path.clone()),
        _ => Err(format!(
            "expected one ticket file for {ticket_id}, found {}",
            paths.len()
        )
        .into()),
    }
}

struct RelocationScenario {
    fixture: LegacySoftwareFixture,
    prepared_proof: Node,
    preparation_ticket: Ticket,
    prepared_node_hash: String,
    preparation_ticket_hash: String,
    prepared_source_bytes: Vec<u8>,
    planned_proof: Node,
    expected_ticket_id: String,
    failed_compile: Journal,
    steer_params: BTreeMap<String, String>,
    graph_hashes_before: BTreeMap<String, String>,
    ticket_hashes_before: BTreeMap<String, String>,
    integration_head_before_steer: String,
    empty_leased_ticket: Option<Ticket>,
}

fn relocated_scenario() -> Result<RelocationScenario, Box<dyn Error>> {
    relocated_scenario_with_backend(StorageBackend::GitCommonDir)
}

fn attach_clean_empty_ticket_lease(
    fixture: &LegacySoftwareFixture,
    excluded_ticket_id: &str,
) -> Result<Ticket, Box<dyn Error>> {
    let mut ticket = fixture
        .store
        .tickets()?
        .into_iter()
        .find(|ticket| ticket.id != excluded_ticket_id && ticket.lease.is_none())
        .ok_or("tracked fixture has no compiler-only ticket available for an empty lease")?;
    let git = GitBackend::discover(&fixture.root)?;
    let base = git.head_oid()?;
    let identity = Uuid::now_v7().to_string();
    let short_identity = identity
        .split('-')
        .next()
        .ok_or("empty lease UUID has no short component")?;
    let branch = format!("koni/tests/empty-lease-{short_identity}");
    let worktree_path = fixture
        .root
        .parent()
        .ok_or("tracked fixture root has no parent")?
        .join(format!("empty-lease-{short_identity}"));
    let worktree = git.create_ticket_worktree(&TicketWorktreeSpec {
        name: format!("koni-test-empty-{short_identity}"),
        branch_ref: format!("refs/heads/{branch}"),
        path: worktree_path,
        base,
        lock: true,
    })?;
    let now = chrono::Utc::now();
    ticket.lease = Some(Lease {
        id: identity,
        branch,
        worktree: worktree.path,
        base_commit: base.to_string(),
        started_at: now,
        heartbeat_at: now,
        worker_pid: None,
    });
    fixture.store.write_ticket(&ticket)?;
    assert_clean_ticket_checkout_at(fixture, &ticket, base)?;
    Ok(ticket)
}

fn relocated_scenario_with_backend(
    storage_backend: StorageBackend,
) -> Result<RelocationScenario, Box<dyn Error>> {
    relocated_scenario_with_options(storage_backend, false)
}

fn relocated_scenario_with_options(
    storage_backend: StorageBackend,
    create_empty_leased_ticket: bool,
) -> Result<RelocationScenario, Box<dyn Error>> {
    let mut fixture = LegacySoftwareFixture::new_with_backend(
        "Repair one defect while preserving its reviewed diagnostic boundary",
        storage_backend,
    )?;
    let mut objective = fixture.objective()?;
    objective
        .spec_object_mut()
        .insert("work_kind".to_owned(), Value::String("bug_fix".to_owned()));
    let system = fixture_system();
    objective
        .edges
        .insert("systems".to_owned(), vec![system.id.clone()]);
    let mut defect = fixture_defect(&objective.id, &system.id);
    let mut prepared_proof = semantic_proof("Reviewed diagnostic proof", "focused", [&defect.id]);
    configure_expected_red_proof(&mut prepared_proof, OLD_SOURCE);
    fixture.save_nodes([
        objective.clone(),
        system.clone(),
        defect.clone(),
        prepared_proof.clone(),
    ])?;
    fixture.compile_direct()?;
    fixture.complete_preparation_ticket(&prepared_proof.id)?;

    let preparation_ticket = fixture
        .store
        .tickets()?
        .into_iter()
        .find(|ticket| {
            ticket.operation == "prepare-proof"
                && ticket.target_nodes.contains(&prepared_proof.id)
                && ticket.status == "closed"
        })
        .ok_or("reviewed preparation ticket was not durably closed")?;
    let prepared_node_before = fixture
        .store
        .graph()?
        .node(&prepared_proof.id)
        .cloned()
        .ok_or("reviewed preparation proof disappeared")?;
    assert_eq!(prepared_node_before.status, "prepared");
    let prepared_node_hash = normalized_hash(&prepared_node_before);
    let preparation_ticket_hash = normalized_hash(&preparation_ticket);
    let prepared_source_bytes = fs::read(fixture.root.join(OLD_SOURCE))?;

    let empty_leased_ticket = if create_empty_leased_ticket {
        if storage_backend != StorageBackend::Tracked {
            return Err("the empty leased-ticket fixture requires tracked storage".into());
        }
        Some(attach_clean_empty_ticket_lease(
            &fixture,
            &preparation_ticket.id,
        )?)
    } else {
        None
    };

    defect.status = "diagnosed".to_owned();
    defect.spec_object_mut().insert(
        "root_cause".to_owned(),
        Value::String("The fixture returns before applying the requested correction.".to_owned()),
    );
    defect.spec_object_mut().insert(
        "causal_chain".to_owned(),
        json!([
            "the request reaches the fixture",
            "the early return preserves the old value"
        ]),
    );
    defect.spec_object_mut().insert(
        "ruled_out_alternatives".to_owned(),
        json!(["the caller supplied the wrong input"]),
    );
    let mut change = material_change(&objective.id, &system.id);
    change
        .edges
        .insert("addresses".to_owned(), vec![defect.id.clone()]);
    let mut planned_proof = semantic_proof("Focused repair proof", "focused", [&change.id]);
    configure_expected_red_proof(&mut planned_proof, OLD_SOURCE);
    fixture.save_nodes([defect, change, planned_proof.clone()])?;

    let compile_error = fixture
        .engine
        .execute_action("compile", BTreeMap::new())
        .expect_err("the configured compiler must reject independently managed shared source")
        .to_string();
    assert!(
        compile_error.contains(EXPECTED_RULE)
            && compile_error.contains(OLD_SOURCE)
            && compile_error.contains(&prepared_proof.id)
            && compile_error.contains(&preparation_ticket.id)
            && compile_error.contains("overlaps current prepared proof source"),
        "unexpected prepared-source failure: {compile_error}"
    );
    let expected_ticket_id = emitted_ticket_id(&compile_error, EXPECTED_RULE)?;
    let failed_compile = fixture
        .store
        .failed_journals()?
        .into_iter()
        .find(|journal| journal.action == "compile")
        .ok_or("configured failure did not preserve its compile Journal")?;
    assert_eq!(failed_compile.status, JournalStatus::Failed);
    assert!(failed_compile.input_hash.is_some());
    if storage_backend == StorageBackend::Tracked {
        commit_all_changes(
            &Repository::open(&fixture.root)?,
            "test: pin the relocation precondition",
        )?;
    }

    let control = fixture.control()?;
    control.write_orchestration(&OrchestrationState::new(false, 1)?)?;
    let request = json!({
        "schema_version": "1.0",
        "failed_compile_journal_id": failed_compile.id,
        "proof_node_id": planned_proof.id,
        "old_source_path": OLD_SOURCE,
        "new_source_path": NEW_SOURCE,
        "expected_rule_id": EXPECTED_RULE,
        "expected_ticket_id": expected_ticket_id,
        "reason": "Give the still-planned focused proof an independent whole-file authority boundary."
    });
    let message = serde_json::to_string(&request)?;
    let targets = serde_json::to_string(&vec![planned_proof.id.as_str()])?;
    let steer_params = string_params([
        ("kind", RELOCATION_KIND),
        ("message", message.as_str()),
        ("ticket", preparation_ticket.id.as_str()),
        ("target_nodes", targets.as_str()),
    ]);
    let graph_hashes_before = fixture
        .store
        .graph()?
        .nodes()
        .map(|node| (node.id.clone(), normalized_hash(node)))
        .collect::<BTreeMap<_, _>>();
    let ticket_hashes_before = fixture
        .store
        .tickets()?
        .into_iter()
        .map(|ticket| (ticket.id.clone(), normalized_hash(&ticket)))
        .collect::<BTreeMap<_, _>>();
    let integration_head_before_steer =
        GitBackend::discover(&fixture.root)?.head_oid()?.to_string();
    if storage_backend == StorageBackend::Tracked {
        let changed = repository_status(&Repository::open(&fixture.root)?)?;
        if !changed.is_empty() {
            return Err(
                format!("tracked relocation precondition remained dirty: {changed:?}").into(),
            );
        }
    }
    let relocation = fixture
        .engine
        .execute_action("steer", steer_params.clone())
        .map_err(|error| {
            format!(
                "initial relocation steer for failed compile Journal {} failed: {error}",
                failed_compile.id
            )
        })?;
    let relocation_result = relocation
        .get("planned_proof_source_relocations")
        .and_then(Value::as_array)
        .and_then(|rows| rows.first())
        .ok_or("steer did not publish a relocation result")?;
    assert_eq!(
        relocation_result.get("status").and_then(Value::as_str),
        Some("relocated")
    );
    assert_eq!(
        relocation_result
            .get("expected_ticket_id")
            .and_then(Value::as_str),
        Some(expected_ticket_id.as_str())
    );
    assert_relocated_preparation_ticket(
        &fixture.store.ticket(&expected_ticket_id)?,
        &planned_proof.id,
    );

    Ok(RelocationScenario {
        fixture,
        prepared_proof,
        preparation_ticket,
        prepared_node_hash,
        preparation_ticket_hash,
        prepared_source_bytes,
        planned_proof,
        expected_ticket_id,
        failed_compile,
        steer_params,
        graph_hashes_before,
        ticket_hashes_before,
        integration_head_before_steer,
        empty_leased_ticket,
    })
}

struct LegacySoftwareFixture {
    _temp: TempDir,
    root: PathBuf,
    engine: Engine,
    store: StateStore,
}

impl LegacySoftwareFixture {
    fn new_with_backend(
        goal: &str,
        storage_backend: StorageBackend,
    ) -> Result<Self, Box<dyn Error>> {
        let temp = TempDir::new()?;
        let root = temp.path().join("planned-proof-source-relocation");
        fs::create_dir_all(root.join("src"))?;
        fs::create_dir_all(root.join("tests"))?;
        fs::write(root.join("src/lib.rs"), "pub fn value() -> u8 { 1 }\n")?;
        fs::write(root.join(OLD_SOURCE), "fixture proof source\n")?;
        copy_tree(&software_profile_root(), &root.join(".codex/koni"))?;
        copy_tree(&software_agents_root(), &root.join(".codex/agents"))?;
        install_legacy_profile_contract(&root.join(".codex/koni"))?;
        set_profile_storage_backend(&root.join(".codex/koni"), storage_backend)?;
        initialize_repository(&root)?;

        let (root, engine, store_root) = match storage_backend {
            StorageBackend::Tracked => {
                let planned = Engine::plan_run(&root, Some("small"), goal, "HEAD", None)?;
                Engine::record_planning_intake_with(
                    &root,
                    &planned.run_id,
                    json!({"goal": goal}),
                    &StaticPlanningLauncher,
                )?;
                let approved = Engine::approve_run(&root, &planned.run_id)?;
                let engine = Engine::open_run(&root, &planned.run_id)?;
                let store_root = approved.worktree.join("program");
                (approved.worktree, engine, store_root)
            }
            StorageBackend::GitCommonDir => {
                let mut engine = Engine::open_with_profile(&root, None)?;
                let run_id = engine.initialize_run(goal)?;
                let backend = GitBackend::discover(&root)?;
                let store_root = backend.sidecar_path(format!("runs/{run_id}"))?;
                (root, engine, store_root)
            }
        };
        let store = StateStore::with_storage(store_root, &engine.profile().manifest.storage)?;
        Ok(Self {
            _temp: temp,
            root,
            engine,
            store,
        })
    }

    fn control(&self) -> Result<RunControlStore, Box<dyn Error>> {
        let run = self.store.manifest()?;
        let backend = GitBackend::discover(&self.root)?;
        Ok(RunControlStore::new(
            backend.sidecar_path(format!("runs/{}", run.id))?,
        ))
    }

    fn objective(&self) -> Result<Node, Box<dyn Error>> {
        self.store
            .graph()?
            .nodes_of_type("objective")
            .next()
            .cloned()
            .ok_or_else(|| "Software initialization did not create an objective".into())
    }

    fn save_nodes<const N: usize>(&self, nodes: [Node; N]) -> Result<(), Box<dyn Error>> {
        let mut graph = self.store.graph()?;
        let ids = nodes.iter().map(|node| node.id.clone()).collect::<Vec<_>>();
        for node in nodes {
            graph.upsert(node);
        }
        for id in ids {
            graph.save_node(&self.store.graph_dir(), &id)?;
        }
        Ok(())
    }

    fn compile_direct(&mut self) -> Result<(), Box<dyn Error>> {
        self.engine.compile(None, false)?;
        Ok(())
    }

    fn only_open_ticket_for(
        &self,
        operation: &str,
        target: &str,
    ) -> Result<Ticket, Box<dyn Error>> {
        let tickets = self
            .store
            .tickets()?
            .into_iter()
            .filter(|ticket| ticket.operation == operation)
            .filter(|ticket| !matches!(ticket.status.as_str(), "closed" | "retired"))
            .filter(|ticket| ticket.target_nodes.iter().any(|node| node == target))
            .collect::<Vec<_>>();
        match tickets.as_slice() {
            [ticket] => Ok(ticket.clone()),
            _ => Err(format!(
                "expected one open {operation} ticket for {target}, found {}",
                tickets.len()
            )
            .into()),
        }
    }

    fn complete_preparation_ticket(&mut self, proof_id: &str) -> Result<(), Box<dyn Error>> {
        let ticket = self.only_open_ticket_for("prepare-proof", proof_id)?;
        self.engine
            .execute_action("start", string_params([("ticket", ticket.id.as_str())]))?;
        let started = self.store.ticket(&ticket.id)?;
        let worktree = started
            .lease
            .as_ref()
            .ok_or("started preparation ticket has no lease")?
            .worktree
            .clone();
        if self.engine.profile().manifest.storage.backend == StorageBackend::Tracked {
            StateStore::with_storage(
                worktree.join("program"),
                &self.engine.profile().manifest.storage,
            )?
            .ensure_layout()?;
        }
        let mut ticket_engine = Engine::open(&worktree)?;
        record_output(
            &mut ticket_engine,
            &ticket.id,
            "author-historical-baseline",
            "implementer",
            evidence_output(
                "The exact proof-only source already records its honest historical baseline.",
            ),
        )?;
        ticket_engine.execute_action(
            "compile-ticket",
            string_params([("ticket", ticket.id.as_str())]),
        )?;
        ticket_engine.review_ticket_with(
            &ticket.id,
            &StaticReviewLauncher::passing(
                "The historical proof seam is relevant, bounded, and source-only.",
            ),
        )?;
        if self.engine.profile().manifest.storage.backend == StorageBackend::Tracked {
            let ticket_store = StateStore::with_storage(
                worktree.join("program"),
                &self.engine.profile().manifest.storage,
            )?;
            assert_eq!(
                ticket_store
                    .graph()?
                    .node(proof_id)
                    .ok_or("reviewed preparation proof disappeared from its ticket worktree")?
                    .status,
                "prepared",
                "passing tracked review must materialize its configured graph effect before finish"
            );
        }
        let finish_params = string_params([
            ("ticket", ticket.id.as_str()),
            ("message", "test: prepare the diagnostic proof source"),
        ]);
        if self.engine.profile().manifest.storage.backend == StorageBackend::Tracked {
            ticket_engine.execute_action("finish", finish_params)?;
            let worktree_node = self
                .store
                .graph()?
                .node(proof_id)
                .cloned()
                .ok_or("tracked finish removed the preparation proof")?;
            let head_node = graph_node_at_head(&self.root, &self.store, proof_id)?;
            if worktree_node.status != "prepared" || head_node.status != "prepared" {
                return Err(format!(
                    "tracked finish projection boundary: integration worktree={}, integration HEAD={}",
                    worktree_node.status, head_node.status
                )
                .into());
            }
        } else {
            self.engine.execute_action("finish", finish_params)?;
        }
        Ok(())
    }
}

fn graph_node_at_head(
    repository_root: &Path,
    store: &StateStore,
    node_id: &str,
) -> Result<Node, Box<dyn Error>> {
    let graph_path = WalkDir::new(store.graph_dir())
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .find_map(|entry| {
            let path = entry.into_path();
            let text = fs::read_to_string(&path).ok()?;
            let node = serde_yaml::from_str::<Node>(&text).ok()?;
            (node.id == node_id).then_some(path)
        })
        .ok_or_else(|| format!("graph node {node_id} has no tracked file"))?;
    let relative = graph_path.strip_prefix(repository_root)?;
    let repository = Repository::open(repository_root)?;
    let commit = repository.head()?.peel_to_commit()?;
    let tree = commit.tree()?;
    let entry = tree.get_path(relative)?;
    let blob = repository.find_blob(entry.id())?;
    Ok(serde_yaml::from_slice(blob.content())?)
}

trait NodeSpecExt {
    fn spec_object_mut(&mut self) -> &mut serde_json::Map<String, Value>;
}

impl NodeSpecExt for Node {
    fn spec_object_mut(&mut self) -> &mut serde_json::Map<String, Value> {
        self.spec
            .as_object_mut()
            .expect("fixture node spec is an object")
    }
}

fn fixture_system() -> Node {
    let mut node = Node::new(
        "system",
        "Relocation fixture",
        json!({
            "kind": "package",
            "responsibility": "Provide the bounded fixture behavior.",
            "contract_required": false,
            "contract_reason": "This local boundary has no material compatibility contract.",
            "owned_paths": ["src"]
        }),
    );
    node.status = "active".to_owned();
    node
}

fn fixture_defect(objective_id: &str, system_id: &str) -> Node {
    let mut node = Node::new(
        "defect",
        "Fixture returns the old value",
        json!({
            "expected_behavior": "The fixture returns the corrected bounded value.",
            "observed_behavior": "The fixture returns its old value.",
            "reproduction_signal": "Run the focused repository proof and observe the mismatch.",
            "impact": "The bounded caller observes the old value.",
            "environment": "The isolated Software fixture."
        }),
    );
    node.status = "unresolved".to_owned();
    node.edges
        .insert("concerns".to_owned(), vec![objective_id.to_owned()]);
    node.edges
        .insert("manifests_in".to_owned(), vec![system_id.to_owned()]);
    node
}

fn material_change(objective_id: &str, system_id: &str) -> Node {
    let mut node = Node::new(
        "change",
        "Return the corrected bounded value",
        json!({
            "approval_claim": "Return the corrected value through the existing fixture boundary.",
            "current_state": "The fixture returns its old value.",
            "target_state": "The fixture returns the corrected value.",
            "owned_paths": ["src/lib.rs"],
            "blast_radius": "The fixture library only.",
            "commit_type": "fix",
            "risk_tier": "routine",
            "risk_factors": ["bounded fixture behavior"],
            "proof_strategy": "red_green"
        }),
    );
    node.status = "planned".to_owned();
    node.edges
        .insert("realizes".to_owned(), vec![objective_id.to_owned()]);
    node.edges
        .insert("affects".to_owned(), vec![system_id.to_owned()]);
    node
}

fn semantic_proof<'a>(
    title: &str,
    purpose: &str,
    verifies: impl IntoIterator<Item = &'a String>,
) -> Node {
    let mut node = Node::new(
        "proof",
        title,
        json!({
            "purpose": purpose,
            "baseline_check_id": "proof-expected-red",
            "claim": format!("{title} establishes the bounded repair claim."),
            "method": "Run the smallest repository-owned command.",
            "command": ["grep", "-q", "corrected", "shared-proof.txt"],
            "source_paths": [OLD_SOURCE],
            "covered_paths": ["src/lib.rs"],
            "oracle_cases": [{
                "id": "bounded-behavior",
                "condition": "Execute the current composed fixture behavior.",
                "claim": format!("{title} establishes the bounded repair claim."),
                "production_seam": "src/lib.rs::value",
                "seam_paths": ["src/lib.rs"],
                "action": "Invoke value() through the repository-owned proof source.",
                "assertions": [
                    "The bounded return value matches the corrected signal.",
                    "Behavior outside the bounded fixture remains unchanged."
                ],
                "environment": "The isolated Software proof fixture.",
                "recipe": ["Load the callable production seam.", "Invoke the bounded behavior."]
            }],
            "working_directory": "tests",
            "layer": "unit",
            "conditions": ["Execute against the current composed source tree."],
            "expected_signal": "The historical command fails until the correction exists.",
            "why": "The command directly exercises the bounded fixture claim.",
            "not_proven": ["Repository behavior outside this bounded fixture."]
        }),
    );
    node.status = "planned".to_owned();
    node.edges.insert(
        "verifies".to_owned(),
        verifies.into_iter().cloned().collect(),
    );
    node
}

fn configure_expected_red_proof(node: &mut Node, source: &str) {
    node.spec_object_mut()
        .insert("source_paths".to_owned(), json!([source]));
    node.spec_object_mut().insert(
        "command".to_owned(),
        json!([
            "grep",
            "-q",
            "corrected",
            Path::new(source)
                .file_name()
                .and_then(|name| name.to_str())
                .expect("fixture proof source is a UTF-8 file")
        ]),
    );
}

struct StaticReviewLauncher {
    output: String,
    requests: RefCell<Vec<AgentProcessRequest>>,
}

impl StaticReviewLauncher {
    fn passing(summary: &str) -> Self {
        Self {
            output: serde_json::to_string(&json!({
                "schema_version": "1.1",
                "verdict": "passed",
                "failure_domain": "none",
                "summary": summary,
                "findings": ["No blocking findings remain at the configured boundary."],
                "evidence_pointers": ["packet://review/acceptance"]
            }))
            .expect("review result serializes"),
            requests: RefCell::new(Vec::new()),
        }
    }
}

impl AgentProcessLauncher for StaticReviewLauncher {
    fn is_alive(&self, _pid: u32) -> bool {
        false
    }

    fn run(
        &self,
        request: &AgentProcessRequest,
        on_started: &mut dyn FnMut(u32) -> koni_core::Result<()>,
    ) -> koni_core::Result<AgentProcessResult> {
        self.requests.borrow_mut().push(request.clone());
        let pid = 46_001;
        on_started(pid)?;
        fs::write(&request.stdout_path, "{\"type\":\"turn.completed\"}\n")
            .expect("write review events");
        fs::write(&request.stderr_path, "").expect("write review stderr");
        let output_path = request
            .args
            .windows(2)
            .find(|pair| pair[0] == "--output-last-message")
            .map(|pair| PathBuf::from(&pair[1]))
            .expect("review request includes output path");
        fs::write(output_path, &self.output).expect("write review result");
        Ok(AgentProcessResult {
            pid,
            exit_code: Some(0),
            timed_out: false,
        })
    }
}

struct StaticPlanningLauncher;

impl AgentProcessLauncher for StaticPlanningLauncher {
    fn is_alive(&self, _pid: u32) -> bool {
        false
    }

    fn run(
        &self,
        request: &AgentProcessRequest,
        on_started: &mut dyn FnMut(u32) -> koni_core::Result<()>,
    ) -> koni_core::Result<AgentProcessResult> {
        let pid = 46_002;
        on_started(pid)?;
        fs::write(
            &request.stdout_path,
            "{\"type\":\"thread.started\",\"thread_id\":\"fixture-planner\"}\n{\"type\":\"turn.completed\"}\n",
        )
        .expect("write planning events");
        fs::write(&request.stderr_path, "").expect("write planning stderr");
        let output_path = request
            .args
            .windows(2)
            .find(|pair| pair[0] == "--output-last-message")
            .map(|pair| PathBuf::from(&pair[1]))
            .expect("planning request includes output path");
        fs::write(
            output_path,
            serde_json::to_vec(&json!({
                "kind": "plan",
                "plan": "Prepare one bounded diagnostic proof, then preserve its independent source authority while implementing the repair.",
                "review": {
                    "architecture": [{
                        "heading": "Bounded repair",
                        "description": "Keep the diagnostic proof source independent from the focused implementation proof."
                    }],
                    "risk": null,
                    "verification": [{
                        "heading": "Independent proof",
                        "description": "Use one exact repository-owned proof source for each lifecycle boundary."
                    }]
                },
                "graph_seed": {
                    "root_spec": {"work_kind": "bug_fix"},
                    "nodes": [],
                    "edges": []
                },
                "prompt": null,
                "context": null,
                "impact": null,
                "options": null,
                "questions": null
            }))
            .expect("serialize planning result"),
        )
        .expect("write planning result");
        Ok(AgentProcessResult {
            pid,
            exit_code: Some(0),
            timed_out: false,
        })
    }
}

fn record_output(
    engine: &mut Engine,
    ticket: &str,
    step: &str,
    persona: &str,
    payload: Value,
) -> Result<(), Box<dyn Error>> {
    let payload = serde_json::to_string(&payload)?;
    engine.execute_action(
        "output",
        string_params([
            ("ticket", ticket),
            ("step", step),
            ("persona", persona),
            ("payload", payload.as_str()),
        ]),
    )?;
    Ok(())
}

fn evidence_output(finding: &str) -> Value {
    json!({
        "files_read": [],
        "files_written": [],
        "findings": [finding],
        "risks": [],
        "patch_proposal": "",
        "recommended_next_step": "Continue through the configured review boundary."
    })
}

fn install_legacy_profile_contract(profile_root: &Path) -> Result<(), Box<dyn Error>> {
    let graph_path = profile_root.join("graph.yaml");
    let mut graph: serde_yaml::Value = serde_yaml::from_str(&fs::read_to_string(&graph_path)?)?;
    graph
        .as_mapping_mut()
        .ok_or("Software graph module is not a mapping")?
        .remove(serde_yaml::Value::String("graph_constraints".to_owned()));
    fs::write(&graph_path, serde_yaml::to_string(&graph)?)?;

    // Name the configured recovery primitive so its public action result exposes
    // whether generic recovery deferred before the post-commit reconciler ran.
    let actions_path = profile_root.join("actions.yaml");
    let mut actions: serde_yaml::Value = serde_yaml::from_str(&fs::read_to_string(&actions_path)?)?;
    let action_rows = actions
        .get_mut("actions")
        .and_then(serde_yaml::Value::as_sequence_mut)
        .ok_or("Software actions module has no actions sequence")?;
    let recover = action_rows
        .iter_mut()
        .find(|action| action.get("id").and_then(serde_yaml::Value::as_str) == Some("recover"))
        .ok_or("Software profile has no recover action")?;
    let dispatch = recover
        .get_mut("recipe")
        .and_then(serde_yaml::Value::as_sequence_mut)
        .and_then(|recipe| {
            recipe.iter_mut().find(|step| {
                step.get("primitive").and_then(serde_yaml::Value::as_str)
                    == Some("recovery.dispatch")
            })
        })
        .ok_or("Software recover action has no recovery.dispatch primitive")?;
    dispatch
        .as_mapping_mut()
        .ok_or("recovery.dispatch step is not a mapping")?
        .insert(
            serde_yaml::Value::String("id".to_owned()),
            serde_yaml::Value::String("dispatch".to_owned()),
        );
    fs::write(&actions_path, serde_yaml::to_string(&actions)?)?;
    Ok(())
}

fn set_profile_storage_backend(
    profile_root: &Path,
    storage_backend: StorageBackend,
) -> Result<(), Box<dyn Error>> {
    let profile_path = profile_root.join("profile.yaml");
    let mut profile: serde_yaml::Value = serde_yaml::from_str(&fs::read_to_string(&profile_path)?)?;
    profile
        .get_mut("storage")
        .and_then(serde_yaml::Value::as_mapping_mut)
        .ok_or("Software profile has no storage mapping")?
        .insert(
            serde_yaml::Value::String("backend".to_owned()),
            serde_yaml::Value::String(
                match storage_backend {
                    StorageBackend::Tracked => "tracked",
                    StorageBackend::GitCommonDir => "git_common_dir",
                }
                .to_owned(),
            ),
        );
    fs::write(profile_path, serde_yaml::to_string(&profile)?)?;
    if storage_backend == StorageBackend::Tracked {
        configure_fixture_persona_prompts(profile_root)?;
        configure_tracked_finish_action(profile_root)?;
    }
    Ok(())
}

fn configure_fixture_persona_prompts(profile_root: &Path) -> Result<(), Box<dyn Error>> {
    let personas_path = profile_root.join("personas.yaml");
    let mut personas: serde_yaml::Value =
        serde_yaml::from_str(&fs::read_to_string(&personas_path)?)?;
    let rows = personas
        .get_mut("personas")
        .and_then(serde_yaml::Value::as_sequence_mut)
        .ok_or("Software personas module has no personas sequence")?;
    let prompts_root = profile_root.join("personas/prompts");
    fs::create_dir_all(&prompts_root)?;
    for row in rows {
        let mapping = row
            .as_mapping_mut()
            .ok_or("Software persona is not a mapping")?;
        let id = mapping
            .get(serde_yaml::Value::String("id".to_owned()))
            .and_then(serde_yaml::Value::as_str)
            .ok_or("Software persona has no ID")?
            .to_owned();
        mapping.remove(serde_yaml::Value::String("codex_agent".to_owned()));
        mapping.insert(
            serde_yaml::Value::String("prompt".to_owned()),
            serde_yaml::Value::String(format!("personas/prompts/{id}.md")),
        );
        fs::write(
            prompts_root.join(format!("{id}.md")),
            format!("Operate only as the compiler-configured {id} fixture persona.\n"),
        )?;
    }
    fs::write(personas_path, serde_yaml::to_string(&personas)?)?;
    Ok(())
}

fn configure_tracked_finish_action(profile_root: &Path) -> Result<(), Box<dyn Error>> {
    let actions_path = profile_root.join("actions.yaml");
    let mut actions: serde_yaml::Value = serde_yaml::from_str(&fs::read_to_string(&actions_path)?)?;
    let action_rows = actions
        .get_mut("actions")
        .and_then(serde_yaml::Value::as_sequence_mut)
        .ok_or("Software actions module has no actions sequence")?;
    let finish = action_rows
        .iter_mut()
        .find(|action| action.get("id").and_then(serde_yaml::Value::as_str) == Some("finish"))
        .ok_or("Software profile has no finish action")?;
    let finish_mapping = finish
        .as_mapping_mut()
        .ok_or("Software finish action is not a mapping")?;
    finish_mapping.remove(serde_yaml::Value::String(
        "requires_main_checkout".to_owned(),
    ));
    finish_mapping.insert(
        serde_yaml::Value::String("requires_ticket_worktree".to_owned()),
        serde_yaml::Value::Bool(true),
    );
    let tracked_recipe = serde_yaml::from_str::<Vec<serde_yaml::Value>>(
        r#"
- {primitive: project.validate}
- {primitive: review.validate, ticket: "${params.ticket}", strict_transition_checklist: true, request_review_and_stop_if_missing: true, require_no_live_worker: true}
- {primitive: ticket.transition, ticket: "${params.ticket}", to: integrating}
- {primitive: integration.validate, ticket: "${params.ticket}"}
- {primitive: git.integrate_squash, ticket: "${params.ticket}", message: "${params.message}", preserve_other_leases: true, retain_closed_worktree: true}
- {primitive: event.append, type: compiler.finish.closed, ticket: "${params.ticket}"}
"#,
    )?;
    finish_mapping.insert(
        serde_yaml::Value::String("recipe".to_owned()),
        serde_yaml::Value::Sequence(tracked_recipe),
    );
    fs::write(actions_path, serde_yaml::to_string(&actions)?)?;
    Ok(())
}

fn emitted_ticket_id(error: &str, rule_id: &str) -> Result<String, Box<dyn Error>> {
    let prefix = format!("rule {rule_id} cannot emit ticket ");
    let tail = error
        .split_once(&prefix)
        .map(|(_, tail)| tail)
        .ok_or_else(|| format!("compiler error omitted {prefix}"))?;
    let ticket_id = tail
        .split(':')
        .next()
        .map(str::trim)
        .filter(|ticket| ticket.starts_with("TK-") && ticket.len() == 19)
        .ok_or("compiler error omitted a canonical deterministic ticket ID")?;
    Ok(ticket_id.to_owned())
}

fn only_relocation_transaction(store: &StateStore) -> Result<Value, Box<dyn Error>> {
    let path = only_relocation_transaction_path(store)?;
    Ok(serde_yaml::from_str(&fs::read_to_string(path)?)?)
}

fn only_relocation_transaction_path(store: &StateStore) -> Result<PathBuf, Box<dyn Error>> {
    let root = store
        .root()
        .join("recovery/planned-proof-source-relocation");
    let paths = fs::read_dir(&root)?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<Result<Vec<_>, _>>()?;
    match paths.as_slice() {
        [path] => Ok(path.clone()),
        _ => Err(format!("expected one relocation transaction, found {}", paths.len()).into()),
    }
}

fn completion_event_count(store: &StateStore) -> Result<usize, Box<dyn Error>> {
    Ok(store
        .events()?
        .iter()
        .filter(|event| event.event_type == RELOCATION_COMPLETED_EVENT)
        .count())
}

#[derive(Debug, PartialEq, Eq)]
struct RelocationStateHashes {
    graph: String,
    tickets: String,
    journals: String,
    events: String,
    transaction: String,
}

fn relocation_state_hashes(store: &StateStore) -> Result<RelocationStateHashes, Box<dyn Error>> {
    Ok(RelocationStateHashes {
        graph: normalized_hash(&store.graph()?),
        tickets: normalized_hash(&store.tickets()?),
        journals: normalized_hash(&store.journals()?),
        events: normalized_hash(&store.events()?),
        transaction: normalized_hash(&only_relocation_transaction(store)?),
    })
}

fn remove_relocation_completion_events(store: &StateStore) -> Result<(), Box<dyn Error>> {
    let path = store.root().join("events.jsonl");
    let retained = fs::read_to_string(&path)?
        .lines()
        .filter(|line| {
            serde_json::from_str::<Value>(line)
                .ok()
                .and_then(|event| event.get("type").and_then(Value::as_str).map(str::to_owned))
                .as_deref()
                != Some(RELOCATION_COMPLETED_EVENT)
        })
        .collect::<Vec<_>>()
        .join("\n");
    fs::write(path, format!("{retained}\n"))?;
    Ok(())
}

fn software_profile_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../koni-cli/templates/software")
}

fn software_agents_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../koni-cli/templates/codex/software/agents")
}

fn copy_tree(source: &Path, destination: &Path) -> Result<(), Box<dyn Error>> {
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
    let repository = Repository::init(root)?;
    let mut index = repository.index()?;
    index.add_all(["*"], IndexAddOption::DEFAULT, None)?;
    index.write()?;
    let tree_id = index.write_tree()?;
    {
        let tree = repository.find_tree(tree_id)?;
        let signature = Signature::now("Fixture Author", "fixture@example.local")?;
        repository.commit(
            Some("HEAD"),
            &signature,
            &signature,
            "chore: initialize relocation fixture",
            &tree,
            &[],
        )?;
    }
    Ok(repository)
}

fn commit_all_changes(repository: &Repository, message: &str) -> Result<(), Box<dyn Error>> {
    let mut index = repository.index()?;
    index.update_all(["*"], None)?;
    index.add_all(["*"], IndexAddOption::DEFAULT, None)?;
    index.write()?;
    let tree_id = index.write_tree()?;
    let tree = repository.find_tree(tree_id)?;
    let parent = repository.head()?.peel_to_commit()?;
    let signature = Signature::now("Fixture Author", "fixture@example.local")?;
    repository.commit(
        Some("HEAD"),
        &signature,
        &signature,
        message,
        &tree,
        &[&parent],
    )?;
    Ok(())
}

fn commit_exact_paths<const N: usize>(
    repository: &Repository,
    repository_root: &Path,
    paths: [PathBuf; N],
    message: &str,
) -> Result<Oid, Box<dyn Error>> {
    let mut index = repository.index()?;
    for path in paths {
        let relative = path.strip_prefix(repository_root)?;
        index.add_path(relative)?;
    }
    index.write()?;
    let tree_id = index.write_tree()?;
    let tree = repository.find_tree(tree_id)?;
    let parent = repository.head()?.peel_to_commit()?;
    let signature = Signature::now("Fixture Author", "fixture@example.local")?;
    Ok(repository.commit(
        Some("HEAD"),
        &signature,
        &signature,
        message,
        &tree,
        &[&parent],
    )?)
}

fn repository_status(repository: &Repository) -> Result<Vec<PathBuf>, git2::Error> {
    let mut options = git2::StatusOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false);
    let statuses = repository.statuses(Some(&mut options))?;
    let mut paths = Vec::new();
    for entry in statuses.iter() {
        paths.push(PathBuf::from(entry.path()?));
    }
    Ok(paths)
}

fn string_params<const N: usize>(pairs: [(&str, &str); N]) -> BTreeMap<String, String> {
    pairs
        .into_iter()
        .map(|(key, value)| (key.to_owned(), value.to_owned()))
        .collect()
}
