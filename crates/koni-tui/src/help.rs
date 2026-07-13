use crate::configure::{ConfigDomain, ConfigResourceKind};
use crate::model::Panel;

/// The semantic surface that contextual help describes.
///
/// Keeping this typed prevents the help dialog from becoming a generic keybinding dump and makes
/// new panels opt into an explicit explanation of their place in the workflow.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HelpTopic {
    Runs,
    Tickets,
    Details(Panel),
    PendingQuestions,
    Agents,
    Graph,
    ConfigDomains,
    ConfigResources {
        domain: ConfigDomain,
    },
    ConfigEditor {
        domain: ConfigDomain,
        resource_kind: Option<ConfigResourceKind>,
        mode: ConfigEditorMode,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigEditorMode {
    Guided,
    LinkedInstructions,
    Source,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct HelpContent {
    pub(crate) title: String,
    pub(crate) summary: String,
    pub(crate) workflow: String,
    pub(crate) actions: Vec<HelpAction>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct HelpAction {
    pub(crate) keys: String,
    pub(crate) description: String,
}

impl HelpAction {
    pub(crate) fn new(keys: impl Into<String>, description: impl Into<String>) -> Self {
        Self {
            keys: keys.into(),
            description: description.into(),
        }
    }
}

impl HelpTopic {
    pub(crate) fn content(&self) -> HelpContent {
        match self {
            Self::Runs => content(
                "Runs",
                "Durable project goals; selecting one scopes every Operate panel.",
                "Goal Prompt + Run Config → planning, approval, work, checks, and reporting.",
                vec![
                    HelpAction::new("j / k", "Select a run"),
                    HelpAction::new("n", "Open New Run"),
                    HelpAction::new("Enter", "Open the selected planning approval"),
                    HelpAction::new("Space", "Pause or resume the selected run"),
                    HelpAction::new("D", "Open safe run removal"),
                    HelpAction::new("Tab / Shift-Tab", "Move focus between main panels"),
                    HelpAction::new("r", "Refresh project state"),
                ],
            ),
            Self::Tickets => content(
                "Tickets",
                "Compiler-created units of work for the selected run. Their type defines steps, delegation, checks, and integration behavior.",
                "The compiler derives ready tickets from the graph. Agents claim them in isolated worktrees; verified results are integrated back into the run.",
                vec![
                    HelpAction::new("j / k", "Select a ticket"),
                    HelpAction::new("[ / ]", "Switch ticket status queue"),
                    HelpAction::new("Left / Right / l", "Switch ticket status queue"),
                    HelpAction::new("a", "Open actions for the selected ticket"),
                    HelpAction::new("Tab / Shift-Tab", "Move focus between main panels"),
                    HelpAction::new("r", "Refresh project state"),
                ],
            ),
            Self::Details(panel) => details_content(*panel),
            Self::PendingQuestions => content(
                "Pending Questions",
                "Decisions currently blocking an agent for the selected run. Saved batch answers stay visible but muted until the batch is complete.",
                "Each answer is recorded durably. Planning resumes the exact waiting session once, after the final unanswered member of a question batch is resolved.",
                vec![
                    HelpAction::new(
                        "Left / Right / [ / ]",
                        "Move horizontally through questions",
                    ),
                    HelpAction::new("j / k / Mouse wheel", "Move through questions"),
                    HelpAction::new("Enter / ?", "Open the selected decision"),
                    HelpAction::new("R", "Resolve due automatic answers"),
                    HelpAction::new("Tab / Shift-Tab", "Move focus between main panels"),
                    HelpAction::new("r", "Refresh question state"),
                ],
            ),
            Self::Agents => content(
                "Agents",
                "Delegated Codex sessions for the selected run. Active work is bright; completed and inactive history is muted.",
                "Configured planners shape the run; the Lead delegates ticket-sized work; workers and reviewers produce and verify outputs. This history shows where model effort is being spent.",
                vec![
                    HelpAction::new("j / k", "Select and scroll through agents"),
                    HelpAction::new("PgUp / PgDn", "Scroll several agents"),
                    HelpAction::new("Mouse wheel", "Scroll while pointing at this panel"),
                    HelpAction::new("Tab / Shift-Tab", "Move focus between main panels"),
                    HelpAction::new("r", "Refresh agent state"),
                ],
            ),
            Self::Graph => content(
                "Graph",
                "The compiled nodes and relationships that describe the selected run's current world model.",
                "Rules validate this graph and emit work tickets. Selecting a ticket shows its graph projection when the profile provides one.",
                vec![
                    HelpAction::new("j / k", "Scroll one line"),
                    HelpAction::new("PgUp / PgDn", "Scroll several lines"),
                    HelpAction::new("Tab / Shift-Tab", "Move focus between main panels"),
                    HelpAction::new("r", "Refresh compiled state"),
                ],
            ),
            Self::ConfigDomains => content(
                "Configuration Domains",
                "Human-oriented sections for everything Koni can configure: project behavior, runs, agents, workflows, graph rules, checks, and views.",
                "Configuration edits affect future runs. Choose a domain, then a resource, edit its guided fields, and publish only after full validation succeeds.",
                vec![
                    HelpAction::new("j / k", "Choose a domain"),
                    HelpAction::new("Enter", "Move into that domain's resources"),
                    HelpAction::new("Tab / Shift-Tab", "Move focus between configuration panels"),
                    HelpAction::new("Ctrl-S", "Save all drafts"),
                    HelpAction::new("Ctrl-P", "Validate and publish drafts"),
                    HelpAction::new("c", "Return to Operate mode"),
                ],
            ),
            Self::ConfigResources { domain } => config_resources_content(*domain),
            Self::ConfigEditor {
                domain,
                resource_kind,
                mode,
            } => config_editor_content(*domain, *resource_kind, *mode),
        }
    }
}

fn content(
    title: impl Into<String>,
    summary: impl Into<String>,
    workflow: impl Into<String>,
    actions: Vec<HelpAction>,
) -> HelpContent {
    HelpContent {
        title: title.into(),
        summary: summary.into(),
        workflow: workflow.into(),
        actions,
    }
}

fn details_content(panel: Panel) -> HelpContent {
    let (title, summary, workflow, primary_action, navigation_action) = match panel {
        Panel::Overview => (
            "Details · Overview",
            "The selected ticket's workflow and metadata together with the run's progress, evidence, validation, and report summary.",
            "Use this combined view to orient before acting: ticket scope explains the current unit of work, while run-level outcomes remain traceable to graph state and verification evidence.",
            None,
            HelpAction::new("j / k", "Scroll this view"),
        ),
        Panel::Planning => (
            "Details · Planning",
            "The planning agent's progress and durable planning transcript for the selected run.",
            "Planning turns the goal and intake answers into a structured brief. The run waits for approval before execution begins.",
            None,
            HelpAction::new("j / k", "Scroll this view"),
        ),
        Panel::Stages => (
            "Details · Stages",
            "The configured workflow stages and their current state: pending, active, waiting, failed, skipped, or complete.",
            "Stages order planning, setup, execution, review, verification, and reporting. Koni advances automated work; approvals and decisions wait here for you.",
            Some(HelpAction::new(
                "Enter",
                "Control, retry, or advance the current stage",
            )),
            HelpAction::new("j / k", "Scroll this view"),
        ),
    };
    let mut actions = Vec::new();
    if let Some(action) = primary_action {
        actions.push(action);
    }
    actions.extend([
        HelpAction::new("[ / ]", "Switch Details view"),
        HelpAction::new("Left / Right / l", "Switch Details view"),
        navigation_action,
        HelpAction::new("Tab / Shift-Tab", "Move focus between main panels"),
        HelpAction::new("a", "Open available configured actions"),
        HelpAction::new("r", "Refresh project state"),
    ]);
    content(title, summary, workflow, actions)
}

fn config_resources_content(domain: ConfigDomain) -> HelpContent {
    let domain_purpose = domain_purpose(domain);
    let mut actions = vec![
        HelpAction::new("j / k", "Choose a resource"),
        HelpAction::new("Enter", "Open the selected resource editor"),
        HelpAction::new("Tab / Shift-Tab", "Move focus between configuration panels"),
        HelpAction::new("Ctrl-S", "Save all drafts"),
        HelpAction::new("Ctrl-P", "Validate and publish drafts"),
        HelpAction::new("c", "Return to Operate mode"),
    ];
    match domain {
        ConfigDomain::RunTypes => actions.push(HelpAction::new("T", "Create a new run type")),
        ConfigDomain::Advanced => {
            actions.push(HelpAction::new(
                "N / M / D",
                "Create, rename, or remove a source",
            ));
        }
        _ => {}
    }
    content(
        format!("{} Resources", domain.label()),
        format!("The configured resources in this domain. {domain_purpose}"),
        "Resources are semantic views over validated project files. Editing here stages future-run configuration without changing active runs.",
        actions,
    )
}

fn config_editor_content(
    domain: ConfigDomain,
    resource_kind: Option<ConfigResourceKind>,
    mode: ConfigEditorMode,
) -> HelpContent {
    let kind = resource_kind.map_or("resource", ConfigResourceKind::label);
    let purpose = resource_kind.map_or_else(
        || domain_purpose(domain),
        |kind| resource_kind_purpose(kind),
    );
    let (title, summary, mut actions) = match mode {
        ConfigEditorMode::Guided => (
            format!("Guided Editor · {kind}"),
            format!("A focused editor for this {kind}. {purpose}"),
            vec![
                HelpAction::new("j / k", "Choose a setting"),
                HelpAction::new("Enter", "Edit the selected setting"),
                HelpAction::new("Esc · Tab / ⇧Tab", "Leave or move focus from the editor"),
                HelpAction::new("c", "Return to Operate mode"),
            ],
        ),
        ConfigEditorMode::LinkedInstructions => (
            format!("Instructions Editor · {kind}"),
            format!(
                "This {kind}'s instruction body, edited alongside its model and reasoning settings."
            ),
            vec![
                HelpAction::new(
                    "Type",
                    "Edit instruction text (lowercase h is literal here)",
                ),
                HelpAction::new("Arrows", "Move the text cursor"),
                HelpAction::new("Enter / Backspace", "Insert a line or delete text"),
                HelpAction::new("Esc · Tab / ⇧Tab", "Leave instructions or move panel focus"),
                HelpAction::new("F1", "Reopen this help while editing instructions"),
            ],
        ),
        ConfigEditorMode::Source => (
            format!("Source Editor · {kind}"),
            format!("The complete project source for this {kind}. {purpose}"),
            vec![
                HelpAction::new("Type", "Edit text (lowercase h is literal here)"),
                HelpAction::new("Arrows", "Move the source cursor"),
                HelpAction::new("Enter / Backspace", "Insert a line or delete text"),
                HelpAction::new("Esc · Tab / ⇧Tab", "Leave source or move panel focus"),
                HelpAction::new("F1", "Reopen this help while editing source"),
            ],
        ),
    };
    actions.extend([
        HelpAction::new("Ctrl-S", "Save all drafts"),
        HelpAction::new("Ctrl-P", "Validate and publish drafts"),
    ]);
    let workflow = if resource_kind == Some(ConfigResourceKind::GatePolicy) {
        "Required coverage blocks a required subject with a missing gate. A verifier waits for execution readiness; automatic evaluation runs at compiler boundaries. A current passing receipt clears the blocker."
    } else {
        "Changes stay in the draft workspace until project-wide validation succeeds. Published changes configure future runs; active runs keep their pinned contract."
    };
    content(title, summary, workflow, actions)
}

fn domain_purpose(domain: ConfigDomain) -> &'static str {
    match domain {
        ConfigDomain::Project => {
            "Defines project identity, storage, Git, and global orchestration."
        }
        ConfigDomain::RunTypes => {
            "Defines reusable run presets, stages, question policy, and agent defaults."
        }
        ConfigDomain::Agents => {
            "Defines Codex personas, prompts, models, reasoning, permissions, and tools."
        }
        ConfigDomain::Skills => {
            "Defines project instructions agents can load for specialized work."
        }
        ConfigDomain::WorkflowsTickets => {
            "Defines stage order and the structured work emitted for agents."
        }
        ConfigDomain::GraphRules => {
            "Defines node meaning, legal relationships, queries, and compiler rules."
        }
        ConfigDomain::ActionsChecks => {
            "Defines executable controls and the checks that verify results."
        }
        ConfigDomain::ReportsViews => "Defines operator views and evidence-oriented run reports.",
        ConfigDomain::Advanced => {
            "Exposes complete configuration sources when guided fields are not enough."
        }
    }
}

fn resource_kind_purpose(kind: ConfigResourceKind) -> &'static str {
    match kind {
        ConfigResourceKind::Project | ConfigResourceKind::Profile => {
            "It establishes the reusable harness contract for this project."
        }
        ConfigResourceKind::Initialization => "It defines the graph state created for a new run.",
        ConfigResourceKind::Storage => {
            "It defines where durable graph, ticket, and report state lives."
        }
        ConfigResourceKind::Git => "It defines branch, worktree, merge, and integration behavior.",
        ConfigResourceKind::Orchestration => {
            "It defines project-wide concurrency and scheduling defaults."
        }
        ConfigResourceKind::RunTypeCatalog | ConfigResourceKind::RunType => {
            "It packages a selectable workflow and its run-specific defaults."
        }
        ConfigResourceKind::CodexProjectSettings => {
            "It controls the native Codex environment shared by project agents."
        }
        ConfigResourceKind::NativeAgent
        | ConfigResourceKind::AgentPolicy
        | ConfigResourceKind::Persona
        | ConfigResourceKind::MarkdownPrompt => {
            "It defines an agent's role, instructions, model, reasoning, permissions, or tools."
        }
        ConfigResourceKind::Skill => {
            "It gives agents reusable project-specific operating instructions."
        }
        ConfigResourceKind::Pipeline | ConfigResourceKind::Workflow => {
            "It orders the stages a run or ticket must pass through."
        }
        ConfigResourceKind::TicketOperation => {
            "It defines a ticket's steps, delegation, outputs, checks, and completion contract."
        }
        ConfigResourceKind::Lifecycle => "It defines valid work states and transitions.",
        ConfigResourceKind::NodeType => {
            "It defines a graph primitive and the metadata agents must supply."
        }
        ConfigResourceKind::EdgeType => "It defines a legal relationship between graph primitives.",
        ConfigResourceKind::GatePolicy => {
            "It defines required gate coverage, deterministic verifier selection, readiness, and automatic checks."
        }
        ConfigResourceKind::Query => "It selects graph state for rules, tickets, or views.",
        ConfigResourceKind::Rule => "It validates graph state or emits configured work.",
        ConfigResourceKind::Action => "It defines a compiler-mediated operator action.",
        ConfigResourceKind::Check => "It defines evidence required before work can advance.",
        ConfigResourceKind::RunCard | ConfigResourceKind::Report => {
            "It turns durable run evidence into an operator-readable result."
        }
        ConfigResourceKind::View => "It defines a projection shown in the control center.",
        ConfigResourceKind::RawSource => {
            "It exposes the complete underlying configuration document."
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_details_panel_has_specific_workflow_help() {
        for panel in Panel::ALL {
            let content = HelpTopic::Details(panel).content();
            assert!(
                content
                    .title
                    .to_lowercase()
                    .contains(&panel.label().to_lowercase())
            );
            assert!(!content.summary.is_empty());
            assert!(!content.workflow.is_empty());
            assert!(content.actions.iter().any(|action| action.keys == "[ / ]"));
        }
    }

    #[test]
    fn pending_questions_help_is_separate_from_every_details_topic() {
        let detail_titles = Panel::ALL
            .into_iter()
            .map(|panel| HelpTopic::Details(panel).content().title)
            .collect::<Vec<_>>();

        assert!(
            detail_titles
                .iter()
                .all(|title| !title.contains("Questions"))
        );
        assert_eq!(
            HelpTopic::PendingQuestions.content().title,
            "Pending Questions"
        );
    }

    #[test]
    fn each_configuration_domain_has_tailored_resource_help() {
        for domain in ConfigDomain::ALL {
            let content = HelpTopic::ConfigResources { domain }.content();
            assert!(content.title.contains(domain.label()));
            assert!(content.summary.contains(domain_purpose(domain)));
        }
    }

    #[test]
    fn gate_policy_help_explains_coverage_readiness_and_automatic_checks() {
        let content = HelpTopic::ConfigEditor {
            domain: ConfigDomain::GraphRules,
            resource_kind: Some(ConfigResourceKind::GatePolicy),
            mode: ConfigEditorMode::Guided,
        }
        .content();

        assert!(content.summary.contains("required gate coverage"));
        for concept in [
            "Required coverage",
            "missing",
            "execution readiness",
            "automatic evaluation",
            "compiler boundaries",
            "passing receipt",
        ] {
            assert!(
                content.workflow.contains(concept),
                "missing {concept}: {}",
                content.workflow
            );
        }
        assert!(content.actions.iter().any(|action| action.keys == "Enter"));
    }

    #[test]
    fn pending_questions_help_explains_durable_batch_resume() {
        let content = HelpTopic::PendingQuestions.content();

        assert!(content.summary.contains("batch answers"));
        assert!(content.workflow.contains("final unanswered"));
        assert!(
            content
                .actions
                .iter()
                .any(|action| action.keys == "Enter / ?")
        );
    }

    #[test]
    fn runs_help_names_the_current_new_run_sections() {
        let content = HelpTopic::Runs.content();

        assert!(content.workflow.contains("Goal Prompt"));
        assert!(content.workflow.contains("Run Config"));
        assert!(!content.workflow.contains("guided intake"));
    }

    #[test]
    fn agents_help_covers_planning_delegation_and_review() {
        let content = HelpTopic::Agents.content();

        for phase in ["planners", "Lead", "workers", "reviewers"] {
            assert!(content.workflow.contains(phase), "missing {phase}");
        }
    }

    #[test]
    fn help_actions_match_the_interactive_surfaces() {
        let runs = HelpTopic::Runs.content();
        assert!(
            runs.actions
                .iter()
                .any(|action| { action.keys == "n" && action.description == "Open New Run" })
        );

        let questions = HelpTopic::PendingQuestions.content();
        assert!(
            questions
                .actions
                .iter()
                .any(|action| action.keys.contains("Mouse wheel"))
        );

        for domain in ConfigDomain::ALL {
            let resources = HelpTopic::ConfigResources { domain }.content();
            assert!(resources.actions.iter().any(|action| action.keys == "c"));
        }

        let guided = HelpTopic::ConfigEditor {
            domain: ConfigDomain::Agents,
            resource_kind: Some(ConfigResourceKind::NativeAgent),
            mode: ConfigEditorMode::Guided,
        }
        .content();
        assert!(guided.actions.iter().any(|action| action.keys == "c"));

        for mode in [
            ConfigEditorMode::LinkedInstructions,
            ConfigEditorMode::Source,
        ] {
            let editor = HelpTopic::ConfigEditor {
                domain: ConfigDomain::Agents,
                resource_kind: Some(ConfigResourceKind::NativeAgent),
                mode,
            }
            .content();
            assert!(
                !editor.actions.iter().any(|action| action.keys == "c"),
                "literal text editor advertised c as a navigation command"
            );
        }
    }

    #[test]
    fn linked_instruction_help_keeps_the_persona_resource_context() {
        let content = HelpTopic::ConfigEditor {
            domain: ConfigDomain::Agents,
            resource_kind: Some(ConfigResourceKind::NativeAgent),
            mode: ConfigEditorMode::LinkedInstructions,
        }
        .content();

        assert!(content.title.starts_with("Instructions Editor"));
        assert!(content.summary.contains("model and reasoning"));
        assert!(!content.summary.contains("complete project source"));
        assert!(content.actions.iter().any(|action| action.keys == "F1"));
    }

    #[test]
    fn panel_help_does_not_promise_profile_claimable_focus_numbers() {
        for topic in [HelpTopic::Agents, HelpTopic::Graph] {
            let content = topic.content();

            assert!(
                content
                    .actions
                    .iter()
                    .any(|action| action.keys == "Tab / Shift-Tab")
            );
            assert!(
                !content
                    .actions
                    .iter()
                    .any(|action| { matches!(action.keys.as_str(), "1" | "2" | "3" | "4" | "5") })
            );
        }
    }
}
