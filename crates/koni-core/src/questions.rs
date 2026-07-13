//! Structured, durable questions and pause/resume metadata.

use std::collections::BTreeSet;
use std::path::PathBuf;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

pub use crate::catalog::QuestionPolicy;
use crate::error::{KoniError, Result};

pub const QUESTION_SCHEMA_VERSION: &str = "1.0";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuestionStatus {
    Open,
    /// The answer is durable, but the bound agent session has not yet been
    /// relaunched. This is intentionally non-terminal so a failed process
    /// launch can be retried without losing the run/ticket pause.
    AnsweredPendingResume,
    Answered,
    AutoResolvedPendingResume,
    AutoResolved,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuestionImpact {
    Routine,
    High,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum QuestionPauseScope {
    Ticket { run_id: String, ticket_id: String },
    Run { run_id: String },
}

impl QuestionPauseScope {
    pub fn run_id(&self) -> &str {
        match self {
            Self::Ticket { run_id, .. } | Self::Run { run_id } => run_id,
        }
    }

    pub fn ticket_id(&self) -> Option<&str> {
        match self {
            Self::Ticket { ticket_id, .. } => Some(ticket_id),
            Self::Run { .. } => None,
        }
    }

    fn validate(&self) -> Result<()> {
        validate_id("question run", self.run_id())?;
        if let Some(ticket_id) = self.ticket_id() {
            validate_id("question ticket", ticket_id)?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QuestionOption {
    pub id: String,
    pub label: String,
    pub description: String,
    #[serde(default)]
    pub recommended: bool,
}

impl QuestionOption {
    fn validate(&self) -> Result<()> {
        validate_id("question option", &self.id)?;
        if self.label.trim().is_empty() || self.description.trim().is_empty() {
            return question_error(format!(
                "option {} requires a label and description",
                self.id
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QuestionAutoResolution {
    pub option_id: String,
    pub resolve_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QuestionSessionResume {
    pub session_id: String,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub turn_id: Option<String>,
    #[serde(default)]
    pub working_directory: Option<PathBuf>,
    pub context_hash: String,
    pub captured_at: DateTime<Utc>,
}

/// Optional membership metadata for questions emitted by one planning turn.
///
/// Singleton records created before batching omit this field entirely. A batch
/// binds up to three ordered questions to one resume boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QuestionBatchBinding {
    pub id: String,
    pub ordinal: usize,
    pub size: usize,
}

impl QuestionBatchBinding {
    pub fn new(id: impl Into<String>, ordinal: usize, size: usize) -> Result<Self> {
        let binding = Self {
            id: id.into(),
            ordinal,
            size,
        };
        binding.validate()?;
        Ok(binding)
    }

    pub fn validate(&self) -> Result<()> {
        validate_id("question batch", &self.id)?;
        if self.ordinal == 0 || self.ordinal > self.size || self.size > 3 {
            return question_error("question batch requires 1 <= ordinal <= size <= 3");
        }
        Ok(())
    }
}

impl QuestionSessionResume {
    pub fn validate(&self) -> Result<()> {
        validate_id("resume session", &self.session_id)?;
        if let Some(agent_id) = &self.agent_id {
            validate_id("resume agent", agent_id)?;
        }
        if let Some(turn_id) = &self.turn_id {
            validate_id("resume turn", turn_id)?;
        }
        if self
            .working_directory
            .as_ref()
            .is_some_and(|path| path.as_os_str().is_empty())
        {
            return question_error("resume working directory must not be empty");
        }
        validate_hash("resume context", &self.context_hash)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuestionAnswerSource {
    Human,
    Agent,
    AutoResolution,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QuestionAnswer {
    #[serde(default)]
    pub option_id: Option<String>,
    #[serde(default)]
    pub custom: Option<String>,
    pub source: QuestionAnswerSource,
    pub actor: String,
    pub answered_at: DateTime<Utc>,
}

impl QuestionAnswer {
    fn validate(&self, question: &QuestionRecord) -> Result<()> {
        let has_option = self.option_id.is_some();
        let has_custom = self
            .custom
            .as_deref()
            .is_some_and(|custom| !custom.trim().is_empty());
        if has_option == has_custom {
            return question_error(
                "an answer must contain exactly one option_id or nonempty custom answer",
            );
        }
        if self.custom.is_some() && !has_custom {
            return question_error("custom answer must not be blank");
        }
        if let Some(option_id) = &self.option_id
            && !question
                .options
                .iter()
                .any(|option| option.id == *option_id)
        {
            return question_error(format!("answer references unknown option {option_id}"));
        }
        if has_custom && !question.allow_custom_answer {
            return question_error("question does not allow a custom answer");
        }
        if self.actor.trim().is_empty() {
            return question_error("answer actor must not be empty");
        }
        if self.answered_at < question.created_at || self.answered_at > question.updated_at {
            return question_error("answer timestamp is outside the question lifetime");
        }
        match self.source {
            QuestionAnswerSource::AutoResolution => {
                if question.auto_resolution.is_none() {
                    return question_error("automatic answer has no configured resolution");
                }
                let recommended = question.recommended_option().ok_or_else(|| {
                    KoniError::Workflow(
                        "question: automatic answer has no recommended option".to_owned(),
                    )
                })?;
                if self.option_id.as_deref() != Some(recommended.id.as_str())
                    || self.custom.is_some()
                {
                    return question_error(
                        "automatic answer must select the one recommended option",
                    );
                }
                let deadline = question.auto_resolution.as_ref().ok_or_else(|| {
                    KoniError::Workflow(
                        "question: automatic answer has no resolution deadline".to_owned(),
                    )
                })?;
                if self.answered_at < deadline.resolve_at {
                    return question_error("question auto-resolved before its deadline");
                }
            }
            QuestionAnswerSource::Human | QuestionAnswerSource::Agent => {}
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QuestionRecord {
    pub schema_version: String,
    pub id: String,
    pub prompt: String,
    #[serde(default)]
    pub context: String,
    pub options: Vec<QuestionOption>,
    #[serde(default = "default_true")]
    pub allow_custom_answer: bool,
    pub pause_scope: QuestionPauseScope,
    pub policy: QuestionPolicy,
    pub impact: QuestionImpact,
    #[serde(default)]
    pub auto_resolution: Option<QuestionAutoResolution>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub batch: Option<QuestionBatchBinding>,
    pub session_resume: QuestionSessionResume,
    pub status: QuestionStatus,
    #[serde(default)]
    pub answer: Option<QuestionAnswer>,
    #[serde(default)]
    pub cancellation_reason: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

fn default_true() -> bool {
    true
}

impl QuestionRecord {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        id: impl Into<String>,
        prompt: impl Into<String>,
        context: impl Into<String>,
        options: Vec<QuestionOption>,
        allow_custom_answer: bool,
        pause_scope: QuestionPauseScope,
        policy: QuestionPolicy,
        impact: QuestionImpact,
        auto_resolution: Option<QuestionAutoResolution>,
        session_resume: QuestionSessionResume,
        now: DateTime<Utc>,
    ) -> Result<Self> {
        let question = Self {
            schema_version: QUESTION_SCHEMA_VERSION.to_owned(),
            id: id.into(),
            prompt: prompt.into(),
            context: context.into(),
            options,
            allow_custom_answer,
            pause_scope,
            policy,
            impact,
            auto_resolution,
            batch: None,
            session_resume,
            status: QuestionStatus::Open,
            answer: None,
            cancellation_reason: None,
            created_at: now,
            updated_at: now,
        };
        question.validate()?;
        Ok(question)
    }

    pub fn with_batch_binding(mut self, binding: QuestionBatchBinding) -> Result<Self> {
        binding.validate()?;
        self.batch = Some(binding);
        self.validate()?;
        Ok(self)
    }

    pub fn from_json(input: &str) -> Result<Self> {
        let question: Self = serde_json::from_str(input).map_err(|source| KoniError::Json {
            path: PathBuf::from("<question-record>"),
            source,
        })?;
        question.validate()?;
        Ok(question)
    }

    pub fn from_yaml(input: &str) -> Result<Self> {
        let question: Self = serde_yaml::from_str(input).map_err(|source| KoniError::Yaml {
            path: PathBuf::from("<question-record>"),
            source,
        })?;
        question.validate()?;
        Ok(question)
    }

    pub fn recommended_option(&self) -> Option<&QuestionOption> {
        self.options.iter().find(|option| option.recommended)
    }

    pub fn is_pause_active(&self) -> bool {
        matches!(
            self.status,
            QuestionStatus::Open
                | QuestionStatus::AnsweredPendingResume
                | QuestionStatus::AutoResolvedPendingResume
        ) && match self.policy {
            QuestionPolicy::Interactive => true,
            QuestionPolicy::HighImpactOnly => self.impact == QuestionImpact::High,
            QuestionPolicy::Autonomous => false,
        }
    }

    pub fn answer_option(
        &mut self,
        option_id: impl Into<String>,
        source: QuestionAnswerSource,
        actor: impl Into<String>,
        now: DateTime<Utc>,
    ) -> Result<()> {
        if source == QuestionAnswerSource::AutoResolution {
            return question_error("use auto_resolve to record an automatic answer");
        }
        self.record_answer(
            QuestionAnswer {
                option_id: Some(option_id.into()),
                custom: None,
                source,
                actor: actor.into(),
                answered_at: now,
            },
            QuestionStatus::Answered,
            now,
        )
    }

    pub fn prepare_answer_option(
        &mut self,
        option_id: impl Into<String>,
        source: QuestionAnswerSource,
        actor: impl Into<String>,
        now: DateTime<Utc>,
    ) -> Result<()> {
        if source == QuestionAnswerSource::AutoResolution {
            return question_error("use auto_resolve to record an automatic answer");
        }
        self.record_answer(
            QuestionAnswer {
                option_id: Some(option_id.into()),
                custom: None,
                source,
                actor: actor.into(),
                answered_at: now,
            },
            QuestionStatus::AnsweredPendingResume,
            now,
        )
    }

    pub fn answer_custom(
        &mut self,
        custom: impl Into<String>,
        source: QuestionAnswerSource,
        actor: impl Into<String>,
        now: DateTime<Utc>,
    ) -> Result<()> {
        if source == QuestionAnswerSource::AutoResolution {
            return question_error("automatic resolution cannot use a custom answer");
        }
        self.record_answer(
            QuestionAnswer {
                option_id: None,
                custom: Some(custom.into()),
                source,
                actor: actor.into(),
                answered_at: now,
            },
            QuestionStatus::Answered,
            now,
        )
    }

    pub fn prepare_answer_custom(
        &mut self,
        custom: impl Into<String>,
        source: QuestionAnswerSource,
        actor: impl Into<String>,
        now: DateTime<Utc>,
    ) -> Result<()> {
        if source == QuestionAnswerSource::AutoResolution {
            return question_error("automatic resolution cannot use a custom answer");
        }
        self.record_answer(
            QuestionAnswer {
                option_id: None,
                custom: Some(custom.into()),
                source,
                actor: actor.into(),
                answered_at: now,
            },
            QuestionStatus::AnsweredPendingResume,
            now,
        )
    }

    /// Replace a durable explicit answer before its bound session resumes.
    ///
    /// The engine exposes this only for a planning batch that still has an
    /// unanswered sibling. Keeping the record-level transition restricted to
    /// `AnsweredPendingResume` preserves the stronger invariant that an answer
    /// becomes immutable as soon as its agent session has resumed.
    pub fn revise_prepared_answer_option(
        &mut self,
        option_id: impl Into<String>,
        source: QuestionAnswerSource,
        actor: impl Into<String>,
        now: DateTime<Utc>,
    ) -> Result<()> {
        if source == QuestionAnswerSource::AutoResolution {
            return question_error("use auto-resolve to record an automatic answer");
        }
        self.revise_prepared_answer(
            QuestionAnswer {
                option_id: Some(option_id.into()),
                custom: None,
                source,
                actor: actor.into(),
                answered_at: now,
            },
            now,
        )
    }

    pub fn revise_prepared_answer_custom(
        &mut self,
        custom: impl Into<String>,
        source: QuestionAnswerSource,
        actor: impl Into<String>,
        now: DateTime<Utc>,
    ) -> Result<()> {
        if source == QuestionAnswerSource::AutoResolution {
            return question_error("automatic resolution cannot use a custom answer");
        }
        self.revise_prepared_answer(
            QuestionAnswer {
                option_id: None,
                custom: Some(custom.into()),
                source,
                actor: actor.into(),
                answered_at: now,
            },
            now,
        )
    }

    pub fn mark_resumed(&mut self, now: DateTime<Utc>) -> Result<()> {
        self.validate()?;
        self.require_monotonic_time(now)?;
        self.status = match self.status {
            QuestionStatus::AnsweredPendingResume => QuestionStatus::Answered,
            QuestionStatus::AutoResolvedPendingResume => QuestionStatus::AutoResolved,
            _ => return question_error("only an answer pending resume can be marked resumed"),
        };
        self.updated_at = now;
        self.validate()
    }

    /// Returns `true` when this call resolved the question.
    pub fn auto_resolve(&mut self, now: DateTime<Utc>) -> Result<bool> {
        if !self.prepare_auto_resolve(now)? {
            return Ok(false);
        }
        self.mark_resumed(now)?;
        Ok(true)
    }

    /// Durably choose the configured automatic answer while retaining the
    /// resume boundary. The engine marks it terminal only after relaunching the
    /// bound session.
    pub fn prepare_auto_resolve(&mut self, now: DateTime<Utc>) -> Result<bool> {
        self.validate()?;
        self.require_monotonic_time(now)?;
        if self.status != QuestionStatus::Open {
            return Ok(false);
        }
        let auto_resolution = self.auto_resolution.as_ref().ok_or_else(|| {
            KoniError::Workflow("question: missing auto-resolution metadata".to_owned())
        })?;
        if now < auto_resolution.resolve_at {
            return Ok(false);
        }
        let option_id = auto_resolution.option_id.clone();
        self.record_answer(
            QuestionAnswer {
                option_id: Some(option_id),
                custom: None,
                source: QuestionAnswerSource::AutoResolution,
                actor: "koni:auto-resolution".to_owned(),
                answered_at: now,
            },
            QuestionStatus::AutoResolvedPendingResume,
            now,
        )?;
        Ok(true)
    }

    pub fn cancel(&mut self, reason: impl Into<String>, now: DateTime<Utc>) -> Result<()> {
        self.validate()?;
        self.require_monotonic_time(now)?;
        if self.status != QuestionStatus::Open {
            return question_error("only an open question can be cancelled");
        }
        let reason = reason.into();
        if reason.trim().is_empty() {
            return question_error("cancellation reason must not be empty");
        }
        self.status = QuestionStatus::Cancelled;
        self.cancellation_reason = Some(reason);
        self.updated_at = now;
        self.validate()
    }

    pub fn validate(&self) -> Result<()> {
        if self.schema_version != QUESTION_SCHEMA_VERSION {
            return question_error(format!(
                "unsupported question schema {}",
                self.schema_version
            ));
        }
        validate_id("question", &self.id)?;
        if self.prompt.trim().is_empty() {
            return question_error(format!("question {} has an empty prompt", self.id));
        }
        if !(2..=4).contains(&self.options.len()) {
            return question_error("question requires between two and four options");
        }
        let mut ids = BTreeSet::new();
        for option in &self.options {
            option.validate()?;
            if !ids.insert(&option.id) {
                return question_error(format!("duplicate question option {}", option.id));
            }
        }
        if self
            .options
            .iter()
            .filter(|option| option.recommended)
            .count()
            != 1
        {
            return question_error("question must have exactly one recommended option");
        }
        self.pause_scope.validate()?;
        if let Some(batch) = &self.batch {
            batch.validate()?;
        }
        self.session_resume.validate()?;
        if self.session_resume.captured_at > self.updated_at {
            return question_error("resume metadata was captured after the question update");
        }
        if self.updated_at < self.created_at {
            return question_error("question updated_at precedes created_at");
        }
        if let Some(resolution) = &self.auto_resolution {
            if resolution.resolve_at <= self.created_at {
                return question_error("auto-resolution deadline must follow creation");
            }
            if self.recommended_option().map(|option| option.id.as_str())
                != Some(resolution.option_id.as_str())
            {
                return question_error("auto-resolution must select the one recommended option");
            }
        } else if self.auto_resolution_required() {
            return question_error("effective question policy requires auto-resolution metadata");
        }
        match self.status {
            QuestionStatus::Open => {
                if self.answer.is_some() || self.cancellation_reason.is_some() {
                    return question_error("open question contains terminal data");
                }
            }
            QuestionStatus::AnsweredPendingResume | QuestionStatus::Answered => {
                let answer = self.answer.as_ref().ok_or_else(|| {
                    KoniError::Workflow("question: answered question has no answer".to_owned())
                })?;
                if answer.source == QuestionAnswerSource::AutoResolution {
                    return question_error("explicit answer has automatic source");
                }
                answer.validate(self)?;
                if self.cancellation_reason.is_some() {
                    return question_error("answered question is also cancelled");
                }
            }
            QuestionStatus::AutoResolvedPendingResume | QuestionStatus::AutoResolved => {
                let answer = self.answer.as_ref().ok_or_else(|| {
                    KoniError::Workflow("question: auto-resolved question has no answer".to_owned())
                })?;
                if answer.source != QuestionAnswerSource::AutoResolution {
                    return question_error("auto-resolved question has explicit answer source");
                }
                answer.validate(self)?;
                if self.cancellation_reason.is_some() {
                    return question_error("auto-resolved question is also cancelled");
                }
            }
            QuestionStatus::Cancelled => {
                if self.answer.is_some()
                    || self
                        .cancellation_reason
                        .as_deref()
                        .is_none_or(|reason| reason.trim().is_empty())
                {
                    return question_error("cancelled question has malformed terminal data");
                }
            }
        }
        Ok(())
    }

    fn record_answer(
        &mut self,
        answer: QuestionAnswer,
        status: QuestionStatus,
        now: DateTime<Utc>,
    ) -> Result<()> {
        self.validate()?;
        self.require_monotonic_time(now)?;
        if self.status != QuestionStatus::Open {
            return question_error("only an open question can be answered");
        }
        let previous_updated_at = self.updated_at;
        self.status = status;
        self.answer = Some(answer);
        self.updated_at = now;
        if let Err(error) = self.validate() {
            self.status = QuestionStatus::Open;
            self.answer = None;
            self.updated_at = previous_updated_at;
            return Err(error);
        }
        Ok(())
    }

    fn revise_prepared_answer(&mut self, answer: QuestionAnswer, now: DateTime<Utc>) -> Result<()> {
        self.validate()?;
        self.require_monotonic_time(now)?;
        if self.status != QuestionStatus::AnsweredPendingResume {
            return question_error("only an explicit answer pending resume can be revised");
        }
        let previous_answer = self.answer.clone();
        let previous_updated_at = self.updated_at;
        self.answer = Some(answer);
        self.updated_at = now;
        if let Err(error) = self.validate() {
            self.answer = previous_answer;
            self.updated_at = previous_updated_at;
            return Err(error);
        }
        Ok(())
    }

    fn require_monotonic_time(&self, now: DateTime<Utc>) -> Result<()> {
        if now < self.updated_at {
            return question_error("question mutation timestamp moved backwards");
        }
        Ok(())
    }

    fn auto_resolution_required(&self) -> bool {
        match self.policy {
            QuestionPolicy::Interactive => false,
            QuestionPolicy::HighImpactOnly => self.impact == QuestionImpact::Routine,
            QuestionPolicy::Autonomous => true,
        }
    }
}

fn validate_id(label: &str, value: &str) -> Result<()> {
    if value.trim().is_empty()
        || value
            .chars()
            .any(|character| character.is_whitespace() || character == '/' || character == '\\')
    {
        return question_error(format!("invalid {label} id {value:?}"));
    }
    Ok(())
}

fn validate_hash(label: &str, value: &str) -> Result<()> {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return question_error(format!("{label} hash is not sha256"));
    };
    if hex.len() != 64 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return question_error(format!("{label} hash is malformed"));
    }
    Ok(())
}

fn question_error<T>(message: impl Into<String>) -> Result<T> {
    Err(KoniError::Workflow(format!("question: {}", message.into())))
}

#[cfg(test)]
mod tests {
    use chrono::{Duration, TimeZone, Utc};
    use serde_json::json;

    use crate::graph::normalized_hash;

    use super::*;

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 7, 10, 12, 0, 0).unwrap()
    }

    fn options() -> Vec<QuestionOption> {
        vec![
            QuestionOption {
                id: "recommended".to_owned(),
                label: "Use current scope".to_owned(),
                description: "Continue with the bounded ticket scope.".to_owned(),
                recommended: true,
            },
            QuestionOption {
                id: "expand".to_owned(),
                label: "Expand scope".to_owned(),
                description: "Pause the run and recompile broader work.".to_owned(),
                recommended: false,
            },
        ]
    }

    fn resume() -> QuestionSessionResume {
        QuestionSessionResume {
            session_id: "session-1".to_owned(),
            agent_id: Some("agent-1".to_owned()),
            turn_id: Some("turn-7".to_owned()),
            working_directory: Some(PathBuf::from("/tmp/worktree")),
            context_hash: normalized_hash(&json!({"ticket": "TK-1"})),
            captured_at: now(),
        }
    }

    #[test]
    fn auto_resolution_chooses_exactly_the_recommended_option() {
        let deadline = now() + Duration::minutes(5);
        let mut question = QuestionRecord::new(
            "question-1",
            "Should this ticket keep its current scope?",
            "A wider edit was proposed.",
            options(),
            true,
            QuestionPauseScope::Ticket {
                run_id: "run-1".to_owned(),
                ticket_id: "TK-1".to_owned(),
            },
            QuestionPolicy::Autonomous,
            QuestionImpact::Routine,
            Some(QuestionAutoResolution {
                option_id: "recommended".to_owned(),
                resolve_at: deadline,
            }),
            resume(),
            now(),
        )
        .unwrap();
        assert!(!question.is_pause_active());
        assert!(
            !question
                .auto_resolve(deadline - Duration::seconds(1))
                .unwrap()
        );
        assert!(question.auto_resolve(deadline).unwrap());
        assert_eq!(question.status, QuestionStatus::AutoResolved);
        assert_eq!(
            question.answer.as_ref().unwrap().option_id.as_deref(),
            Some("recommended")
        );
        assert!(!question.is_pause_active());
        QuestionRecord::from_yaml(&serde_yaml::to_string(&question).unwrap()).unwrap();
    }

    #[test]
    fn all_three_policies_and_both_pause_scopes_validate() {
        for policy in [QuestionPolicy::Interactive, QuestionPolicy::HighImpactOnly] {
            let question = QuestionRecord::new(
                format!("question-{policy:?}"),
                "Choose a path",
                "Context",
                options(),
                true,
                QuestionPauseScope::Run {
                    run_id: "run-1".to_owned(),
                },
                policy,
                QuestionImpact::High,
                None,
                resume(),
                now(),
            )
            .unwrap();
            assert!(question.is_pause_active());
        }
        let deadline = now() + Duration::minutes(5);
        let routine = QuestionRecord::new(
            "question-routine",
            "Choose a routine path",
            "Context",
            options(),
            true,
            QuestionPauseScope::Run {
                run_id: "run-1".to_owned(),
            },
            QuestionPolicy::HighImpactOnly,
            QuestionImpact::Routine,
            Some(QuestionAutoResolution {
                option_id: "recommended".to_owned(),
                resolve_at: deadline,
            }),
            resume(),
            now(),
        )
        .unwrap();
        assert!(!routine.is_pause_active());

        let mut interactive_timeout = QuestionRecord::new(
            "question-interactive-timeout",
            "Choose before the timeout",
            "Context",
            options(),
            true,
            QuestionPauseScope::Run {
                run_id: "run-1".to_owned(),
            },
            QuestionPolicy::Interactive,
            QuestionImpact::High,
            Some(QuestionAutoResolution {
                option_id: "recommended".to_owned(),
                resolve_at: deadline,
            }),
            resume(),
            now(),
        )
        .unwrap();
        assert!(interactive_timeout.is_pause_active());
        assert!(interactive_timeout.auto_resolve(deadline).unwrap());
    }

    #[test]
    fn custom_answer_is_exclusive_and_malformed_records_fail_closed() {
        let mut question = QuestionRecord::new(
            "question-1",
            "Choose a path",
            "Context",
            options(),
            true,
            QuestionPauseScope::Run {
                run_id: "run-1".to_owned(),
            },
            QuestionPolicy::Interactive,
            QuestionImpact::High,
            None,
            resume(),
            now(),
        )
        .unwrap();
        question
            .answer_custom(
                "Use a third bounded approach",
                QuestionAnswerSource::Human,
                "user",
                now() + Duration::seconds(1),
            )
            .unwrap();
        assert!(question.validate().is_ok());

        let mut malformed = serde_json::to_value(&question).unwrap();
        malformed["answer"]["option_id"] = json!("recommended");
        assert!(QuestionRecord::from_json(&malformed.to_string()).is_err());
        let mut unknown = serde_json::to_value(&question).unwrap();
        unknown["unexpected"] = json!(true);
        assert!(QuestionRecord::from_json(&unknown.to_string()).is_err());
    }

    #[test]
    fn prepared_answer_keeps_pause_active_until_session_resume_is_recorded() {
        let mut question = QuestionRecord::new(
            "question-pending",
            "Choose a path",
            "Context",
            options(),
            true,
            QuestionPauseScope::Run {
                run_id: "run-1".to_owned(),
            },
            QuestionPolicy::Interactive,
            QuestionImpact::High,
            None,
            resume(),
            now(),
        )
        .unwrap();
        question
            .prepare_answer_option(
                "recommended",
                QuestionAnswerSource::Human,
                "user",
                now() + Duration::seconds(1),
            )
            .unwrap();
        assert_eq!(question.status, QuestionStatus::AnsweredPendingResume);
        assert!(question.is_pause_active());
        let serialized = serde_yaml::to_string(&question).unwrap();
        question = QuestionRecord::from_yaml(&serialized).unwrap();
        question.mark_resumed(now() + Duration::seconds(2)).unwrap();
        assert_eq!(question.status, QuestionStatus::Answered);
        assert!(!question.is_pause_active());
    }

    #[test]
    fn prepared_explicit_answer_can_be_revised_but_resumed_answer_is_immutable() {
        let mut question = QuestionRecord::new(
            "question-revisable",
            "Choose a path",
            "Context",
            options(),
            true,
            QuestionPauseScope::Run {
                run_id: "run-1".to_owned(),
            },
            QuestionPolicy::Interactive,
            QuestionImpact::High,
            None,
            resume(),
            now(),
        )
        .unwrap();
        question
            .prepare_answer_option(
                "recommended",
                QuestionAnswerSource::Human,
                "user",
                now() + Duration::seconds(1),
            )
            .unwrap();
        question
            .revise_prepared_answer_option(
                "expand",
                QuestionAnswerSource::Human,
                "user",
                now() + Duration::seconds(2),
            )
            .unwrap();
        assert_eq!(question.status, QuestionStatus::AnsweredPendingResume);
        assert_eq!(
            question.answer.as_ref().unwrap().option_id.as_deref(),
            Some("expand")
        );

        question
            .revise_prepared_answer_custom(
                "Use a bounded third path",
                QuestionAnswerSource::Human,
                "user",
                now() + Duration::seconds(3),
            )
            .unwrap();
        assert_eq!(
            question.answer.as_ref().unwrap().custom.as_deref(),
            Some("Use a bounded third path")
        );
        question.mark_resumed(now() + Duration::seconds(4)).unwrap();
        let error = question
            .revise_prepared_answer_option(
                "recommended",
                QuestionAnswerSource::Human,
                "user",
                now() + Duration::seconds(5),
            )
            .expect_err("resumed answer must be immutable")
            .to_string();
        assert!(error.contains("pending resume"), "{error}");
    }

    #[test]
    fn optional_batch_binding_preserves_legacy_yaml_and_validates_bounds() {
        let legacy = QuestionRecord::new(
            "question-legacy",
            "Choose a path",
            "Context",
            options(),
            true,
            QuestionPauseScope::Run {
                run_id: "run-1".to_owned(),
            },
            QuestionPolicy::Interactive,
            QuestionImpact::High,
            None,
            resume(),
            now(),
        )
        .unwrap();
        let yaml = serde_yaml::to_string(&legacy).unwrap();
        assert!(!yaml.contains("batch:"), "{yaml}");
        assert_eq!(QuestionRecord::from_yaml(&yaml).unwrap(), legacy);

        for (ordinal, size) in [(1, 1), (1, 3), (2, 3), (3, 3)] {
            let bound = legacy
                .clone()
                .with_batch_binding(QuestionBatchBinding::new("batch-1", ordinal, size).unwrap())
                .unwrap();
            assert_eq!(bound.batch.as_ref().unwrap().ordinal, ordinal);
            assert_eq!(
                QuestionRecord::from_yaml(&serde_yaml::to_string(&bound).unwrap()).unwrap(),
                bound
            );
        }
        for (ordinal, size) in [(0, 1), (2, 1), (1, 0), (1, 4)] {
            assert!(QuestionBatchBinding::new("batch-1", ordinal, size).is_err());
        }
    }

    #[test]
    fn missing_or_multiple_recommendations_are_rejected() {
        let mut invalid = options();
        invalid[0].recommended = false;
        assert!(
            QuestionRecord::new(
                "question-1",
                "Choose",
                "Context",
                invalid,
                true,
                QuestionPauseScope::Run {
                    run_id: "run-1".to_owned(),
                },
                QuestionPolicy::Interactive,
                QuestionImpact::High,
                None,
                resume(),
                now(),
            )
            .is_err()
        );

        let mut duplicate = options();
        duplicate[1].recommended = true;
        assert!(
            QuestionRecord::new(
                "question-2",
                "Choose",
                "Context",
                duplicate,
                true,
                QuestionPauseScope::Run {
                    run_id: "run-1".to_owned(),
                },
                QuestionPolicy::Interactive,
                QuestionImpact::High,
                None,
                resume(),
                now(),
            )
            .is_err()
        );
    }

    #[test]
    fn more_than_four_options_are_rejected() {
        let mut too_many = options();
        for index in 3..=5 {
            too_many.push(QuestionOption {
                id: format!("alternative-{index}"),
                label: format!("Alternative {index}"),
                description: "A bounded alternative.".to_owned(),
                recommended: false,
            });
        }
        assert!(
            QuestionRecord::new(
                "question-many",
                "Choose",
                "Context",
                too_many,
                true,
                QuestionPauseScope::Run {
                    run_id: "run-1".to_owned(),
                },
                QuestionPolicy::Interactive,
                QuestionImpact::High,
                None,
                resume(),
                now(),
            )
            .is_err()
        );
    }
}
