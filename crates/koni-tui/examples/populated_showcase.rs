use std::path::PathBuf;

use serde_json::{Map, Value, json};

fn main() -> anyhow::Result<()> {
    let workflow = json!([
        {"id":"scope","title":"Map scope","persona":"research scout","kind":"action"},
        {"id":"design","title":"Design experiment","persona":"experiment designer","kind":"action"},
        {"id":"build","title":"Build evidence","persona":"asset builder","kind":"action"},
        {"id":"integrate","title":"Integrate findings","persona":"integrator","kind":"action"},
        {"id":"review","title":"Independent review","persona":"reviewer","kind":"review"}
    ]);
    let mut ticket_progress = Map::new();
    let tickets = (1..=36)
        .map(|number| {
            let id = format!("ticket-{number}");
            let (status, completed, ready, pending, worker_state, active_step) = if number <= 10 {
                ("closed", json!(["scope", "design", "build", "integrate", "review"]), json!([]), json!([]), "idle", Value::Null)
            } else if number == 11 {
                ("in_progress", json!(["scope"]), json!(["design", "build"]), json!(["design", "build", "integrate", "review"]), "running", json!("design"))
            } else if number <= 16 {
                ("in_progress", json!(["scope", "design"]), json!(["build"]), json!(["build", "integrate", "review"]), "idle", Value::Null)
            } else if number <= 31 {
                ("todo", json!([]), json!(["scope"]), json!(["scope", "design", "build", "integrate", "review"]), "idle", Value::Null)
            } else {
                ("blocked", json!([]), json!([]), json!(["scope", "design", "build", "integrate", "review"]), "idle", Value::Null)
            };
            ticket_progress.insert(
                id.clone(),
                json!({
                    "completed_steps":completed,
                    "ready_steps":ready,
                    "pending_steps":pending,
                    "active_worker_step":active_step,
                    "worker_state":worker_state,
                    "review_status": if number <= 10 { "passed" } else { "pending" }
                }),
            );
            json!({
                "id":id,
                "title": match number {
                    11 => "Non-list boundary checks".to_owned(),
                    12 => "Vacuous case evidence".to_owned(),
                    13 => "Soundness proof review".to_owned(),
                    14 => "Completeness corpus run".to_owned(),
                    15 => "Mutation safety audit".to_owned(),
                    16 => "Determinism reproduction".to_owned(),
                    _ => format!("Evidence package {number}"),
                },
                "status":status,
                "operation":"design experiment",
                "workflow":workflow,
                "outputs": if number <= 16 { json!([{
                    "step_id":"scope","persona":"research scout",
                    "findings":["bounded contract mapped"],"risks":["oracle coupling"],
                    "files_written":[],"files_deleted":[]
                }]) } else { json!([]) },
                "blockers": if number > 31 { json!(["waiting for prerequisite evidence"]) } else { json!([]) },
                "scope":{"read_nodes":["hypothesis","claim-boundary"],"write_nodes":["experiment-boundary","evidence-boundary"]}
            })
        })
        .collect::<Vec<_>>();

    let graph = vec![
        json!({"id":"hypothesis","type":"hypothesis","title":"Finite list sortedness predicate","edges":{"claims":["claim-interface","claim-boundary","claim-soundness","claim-completeness","claim-purity"]}}),
        json!({"id":"claim-interface","type":"claim","title":"C1 — Exact Boolean interface behavior","edges":{"gates":["gate-interface"],"tests":["experiment-interface"]}}),
        json!({"id":"claim-boundary","type":"claim","title":"C2 — Deterministic input boundary rejection","edges":{"gates":["gate-boundary"],"tests":["experiment-boundary"]}}),
        json!({"id":"claim-soundness","type":"claim","title":"C3 — True results imply ordered pairs","edges":{"gates":["gate-soundness"],"tests":["experiment-corpus"]}}),
        json!({"id":"claim-completeness","type":"claim","title":"C4 — Ordered pairs imply true results","edges":{"gates":["gate-completeness"],"tests":["experiment-corpus"]}}),
        json!({"id":"claim-purity","type":"claim","title":"C5 — Supported calls preserve inputs","edges":{"gates":["gate-purity"],"tests":["experiment-mutation"]}}),
        json!({"id":"gate-interface","type":"gate","title":"G1 — Exact Boolean acceptance","edges":{}}),
        json!({"id":"gate-boundary","type":"gate","title":"G2 — Rejection before callbacks","edges":{}}),
        json!({"id":"gate-soundness","type":"gate","title":"G3 — Soundness proof accepted","edges":{}}),
        json!({"id":"gate-completeness","type":"gate","title":"G4 — Complete corpus passes","edges":{}}),
        json!({"id":"gate-purity","type":"gate","title":"G5 — No mutation observed","edges":{}}),
        json!({"id":"experiment-interface","type":"experiment","title":"Public interface checks","edges":{"produces":["evidence-interface"]}}),
        json!({"id":"experiment-boundary","type":"experiment","title":"Hostile boundary probes","edges":{"produces":["evidence-boundary"]}}),
        json!({"id":"experiment-corpus","type":"experiment","title":"Finite corpus comparison","edges":{"produces":["evidence-corpus"]}}),
        json!({"id":"experiment-mutation","type":"experiment","title":"Mutation trap audit","edges":{"produces":["evidence-mutation"]}}),
        json!({"id":"evidence-interface","type":"evidence","title":"Interface trace receipt","edges":{}}),
        json!({"id":"evidence-boundary","type":"evidence","title":"Boundary trace receipt","edges":{}}),
        json!({"id":"evidence-corpus","type":"evidence","title":"Corpus summary receipt","edges":{}}),
        json!({"id":"evidence-mutation","type":"evidence","title":"Mutation audit receipt","edges":{}}),
    ];
    let agents = vec![
        json!({"id":"lead","persona":"lead","stage_id":"execute","status":"running"}),
        json!({"id":"worker-boundary","persona":"experiment designer","ticket_id":"ticket-11","stage_id":"design","status":"running"}),
        json!({"id":"worker-corpus","persona":"asset builder","ticket_id":"ticket-14","stage_id":"build","status":"running"}),
        json!({"id":"planner-architecture","persona":"run planner","stage_id":"architecture","status":"completed"}),
        json!({"id":"planner-risk","persona":"risk analyst","stage_id":"risk","status":"completed"}),
        json!({"id":"reviewer-interface","persona":"reviewer","ticket_id":"ticket-1","stage_id":"review","status":"completed"}),
        json!({"id":"reviewer-boundary","persona":"reviewer","ticket_id":"ticket-2","stage_id":"review","status":"completed"}),
    ];

    let snapshot = json!({
        "run":{
            "id":"showcase-run","goal":"Establish the bounded sortedness contract with reproducible evidence.",
            "status":"active","run_type_id":"large","run_type_title":"Large"
        },
        "token_usage":{"input_tokens":1_032_400,"output_tokens":86_300,"total_tokens":1_118_700},
        "tickets":tickets,
        "board":{"ticket_workflows":ticket_progress,"failed_journals":[],"incomplete_journals":[],"incomplete_integrations":[]},
        "graph":graph,
        "ticket_graphs":{"ticket-11":{"graph":graph}},
        "questions":[
            {"id":"question-one","status":"open","prompt":"Which rejection contract should govern non-list inputs?","context":"The choice controls the boundary claim, hostile probes, and acceptance gate.","options":[
                {"id":"type-error","label":"Raise TypeError","description":"Reject before iteration or user callbacks.","recommended":true},
                {"id":"return-false","label":"Return false","description":"Treat unsupported values as unsorted.","recommended":false},
                {"id":"precondition","label":"Document only","description":"Leave invalid inputs outside the contract.","recommended":false}
            ]},
            {"id":"question-two","status":"open","prompt":"How large should the deterministic generated corpus be?","context":"More cases improve corroboration but do not replace the proof obligation.","options":[
                {"id":"10k","label":"10K cases","description":"Fast, reproducible corroboration.","recommended":true},
                {"id":"100k","label":"100K cases","description":"Broader search with a longer runtime.","recommended":false}
            ]}
        ],
        "stages":[
            {"status":"succeeded","definition":{"id":"planning","kind":"planning","title":"Research planning"}},
            {"status":"succeeded","definition":{"id":"initialize","kind":"initialize","title":"Initialize run"}},
            {"status":"running","definition":{"id":"execute","kind":"orchestration","title":"Execute research"}},
            {"status":"pending","definition":{"id":"verify","kind":"checkpoint","title":"Verification"}},
            {"status":"pending","definition":{"id":"report","kind":"action","title":"Report","config":{"action":"report"}}}
        ],
        "agents":agents,
        "events":[
            {"ticket_id":"ticket-11","event_type":"compiler.worker_spawned"},
            {"ticket_id":"ticket-11","event_type":"compiler.context_issued"},
            {"ticket_id":"ticket-11","event_type":"worker.output_recorded"}
        ],
        "planning_transcript":[
            {"type":"planning.agent.starting","stage_id":"architecture"},
            {"type":"planning.agent.event","stage_id":"architecture","event":{"type":"item.started","item":{"type":"command_execution","command":"git status --short"}}},
            {"type":"planning.agent.event","stage_id":"architecture","event":{"type":"item.completed","item":{"type":"agent_message","text":"{\"summary\":\"Mapped the contract into five independently gated claims.\"}"}}},
            {"type":"planning.output","stage_id":"architecture","output":{"summary":"Five claim families, four experiments, and immutable receipts define the research constitution."}}
        ],
        "orchestration":{"running":true,"max_parallel":3,"unchained":false},
        "views":[
            {"id":"research-graph","kind":"graph","options":{"show_titles":true,"hierarchy":["hypothesis","claim","gate","experiment","evidence"]}},
            {"id":"run-report","kind":"report"}
        ]
    });

    koni_tui::run_read_only_snapshot(PathBuf::from("/tmp/koni-showcase"), snapshot)
}
