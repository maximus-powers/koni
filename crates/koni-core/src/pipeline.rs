//! Durable, ordered run-pipeline domain state.
//!
//! This module contains no persistence or process execution. Callers serialize
//! [`RunPipeline`] after each successful mutation and inject the stage work.

use std::collections::BTreeSet;
use std::path::PathBuf;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::catalog::{PipelineDef, PipelineStageDef};
use crate::error::{KoniError, Result};
use crate::graph::normalized_hash;

pub const RUN_PIPELINE_SCHEMA_VERSION: &str = "1.0";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PipelineStageKind {
    Action,
    Orchestration,
    AgentReview,
    ExternalLoop,
    Question,
    Manual,
    Checkpoint,
}

impl PipelineStageKind {
    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "action" | "profile" | "legacy_profile" | "planning" | "agent_dialog" | "koni" => {
                Ok(Self::Action)
            }
            "orchestration" => Ok(Self::Orchestration),
            "agent_review" => Ok(Self::AgentReview),
            "external_loop" => Ok(Self::ExternalLoop),
            "question" | "form" => Ok(Self::Question),
            "manual" | "approval" | "handoff" => Ok(Self::Manual),
            "checkpoint" | "initialize" => Ok(Self::Checkpoint),
            other => pipeline_error(format!("unsupported pipeline stage kind {other:?}")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PipelineStageStatus {
    Pending,
    Running,
    Waiting,
    Paused,
    Succeeded,
    Failed,
    Blocked,
    Skipped,
}

impl PipelineStageStatus {
    pub fn is_success_terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Skipped)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunPipelineStatus {
    Pending,
    Running,
    Waiting,
    Paused,
    Blocked,
    Failed,
    Complete,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PipelineStageDefinition {
    pub id: String,
    pub title: String,
    pub kind: PipelineStageKind,
    #[serde(default = "default_true")]
    pub required: bool,
    #[serde(default)]
    pub config: Value,
}

fn default_true() -> bool {
    true
}

impl PipelineStageDefinition {
    pub fn from_catalog(id: &str, stage: &PipelineStageDef) -> Result<Self> {
        let definition = Self {
            id: id.to_owned(),
            title: stage.title.clone(),
            kind: PipelineStageKind::parse(&stage.kind)?,
            required: true,
            config: stage.config.clone().unwrap_or(Value::Null),
        };
        definition.validate()?;
        Ok(definition)
    }

    pub fn definition_hash(&self) -> String {
        normalized_hash(self)
    }

    pub fn validate(&self) -> Result<()> {
        validate_id("pipeline stage", &self.id)?;
        if self.title.trim().is_empty() {
            return pipeline_error(format!("stage {} has an empty title", self.id));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PipelineStageReceipt {
    pub schema_version: String,
    pub id: String,
    pub receipt_type: String,
    pub stage_id: String,
    pub stage_definition_hash: String,
    pub input_hash: String,
    pub output_hash: String,
    pub payload: Value,
    pub payload_hash: String,
    pub recorded_at: DateTime<Utc>,
}

impl PipelineStageReceipt {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        id: impl Into<String>,
        receipt_type: impl Into<String>,
        stage_id: impl Into<String>,
        stage_definition_hash: impl Into<String>,
        input_hash: impl Into<String>,
        output_hash: impl Into<String>,
        payload: Value,
        recorded_at: DateTime<Utc>,
    ) -> Result<Self> {
        let receipt = Self {
            schema_version: RUN_PIPELINE_SCHEMA_VERSION.to_owned(),
            id: id.into(),
            receipt_type: receipt_type.into(),
            stage_id: stage_id.into(),
            stage_definition_hash: stage_definition_hash.into(),
            input_hash: input_hash.into(),
            output_hash: output_hash.into(),
            payload_hash: normalized_hash(&payload),
            payload,
            recorded_at,
        };
        receipt.validate_binding(
            &receipt.stage_id,
            &receipt.stage_definition_hash,
            &receipt.input_hash,
            &receipt.output_hash,
        )?;
        Ok(receipt)
    }

    pub fn validate_binding(
        &self,
        stage_id: &str,
        stage_definition_hash: &str,
        input_hash: &str,
        output_hash: &str,
    ) -> Result<()> {
        if self.schema_version != RUN_PIPELINE_SCHEMA_VERSION {
            return pipeline_error(format!(
                "receipt {} has unsupported schema {}",
                self.id, self.schema_version
            ));
        }
        validate_id("pipeline receipt", &self.id)?;
        validate_id("receipt type", &self.receipt_type)?;
        validate_id("receipt stage", &self.stage_id)?;
        for (label, hash) in [
            ("stage definition", &self.stage_definition_hash),
            ("input", &self.input_hash),
            ("output", &self.output_hash),
            ("payload", &self.payload_hash),
        ] {
            validate_hash(label, hash)?;
        }
        if self.stage_id != stage_id
            || self.stage_definition_hash != stage_definition_hash
            || self.input_hash != input_hash
            || self.output_hash != output_hash
        {
            return pipeline_error(format!(
                "receipt {} is not bound to the current stage output",
                self.id
            ));
        }
        if self.payload_hash != normalized_hash(&self.payload) {
            return pipeline_error(format!("receipt {} payload hash is stale", self.id));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PipelineStageOutput {
    pub schema_version: String,
    pub stage_id: String,
    pub stage_definition_hash: String,
    pub attempt: u32,
    pub input_hash: String,
    pub output: Value,
    pub output_hash: String,
    #[serde(default)]
    pub receipts: Vec<PipelineStageReceipt>,
    pub recorded_at: DateTime<Utc>,
}

#[derive(Serialize)]
struct OutputHashInput<'a> {
    stage_id: &'a str,
    stage_definition_hash: &'a str,
    attempt: u32,
    input_hash: &'a str,
    output: &'a Value,
}

impl PipelineStageOutput {
    pub fn output_hash_for(
        stage_id: &str,
        stage_definition_hash: &str,
        attempt: u32,
        input_hash: &str,
        output: &Value,
    ) -> String {
        normalized_hash(&OutputHashInput {
            stage_id,
            stage_definition_hash,
            attempt,
            input_hash,
            output,
        })
    }

    pub fn new(
        definition: &PipelineStageDefinition,
        attempt: u32,
        input_hash: impl Into<String>,
        output: Value,
        recorded_at: DateTime<Utc>,
    ) -> Result<Self> {
        let input_hash = input_hash.into();
        validate_hash("stage input", &input_hash)?;
        if attempt == 0 {
            return pipeline_error("stage output attempt must be positive");
        }
        let stage_definition_hash = definition.definition_hash();
        let output_hash = Self::output_hash_for(
            &definition.id,
            &stage_definition_hash,
            attempt,
            &input_hash,
            &output,
        );
        Ok(Self {
            schema_version: RUN_PIPELINE_SCHEMA_VERSION.to_owned(),
            stage_id: definition.id.clone(),
            stage_definition_hash,
            attempt,
            input_hash,
            output,
            output_hash,
            receipts: Vec::new(),
            recorded_at,
        })
    }

    pub fn push_receipt(&mut self, receipt: PipelineStageReceipt) -> Result<()> {
        receipt.validate_binding(
            &self.stage_id,
            &self.stage_definition_hash,
            &self.input_hash,
            &self.output_hash,
        )?;
        if self.receipts.iter().any(|current| current.id == receipt.id) {
            return pipeline_error(format!("duplicate receipt {}", receipt.id));
        }
        self.receipts.push(receipt);
        Ok(())
    }

    pub fn validate(&self, definition: &PipelineStageDefinition) -> Result<()> {
        if self.schema_version != RUN_PIPELINE_SCHEMA_VERSION {
            return pipeline_error(format!(
                "stage output {} has unsupported schema {}",
                self.stage_id, self.schema_version
            ));
        }
        if self.stage_id != definition.id
            || self.stage_definition_hash != definition.definition_hash()
        {
            return pipeline_error(format!(
                "stage output {} is bound to a different definition",
                self.stage_id
            ));
        }
        if self.attempt == 0 {
            return pipeline_error("stage output attempt must be positive");
        }
        validate_hash("stage input", &self.input_hash)?;
        validate_hash("stage output", &self.output_hash)?;
        let expected = Self::output_hash_for(
            &self.stage_id,
            &self.stage_definition_hash,
            self.attempt,
            &self.input_hash,
            &self.output,
        );
        if self.output_hash != expected {
            return pipeline_error(format!("stage {} output hash is stale", self.stage_id));
        }
        let mut ids = BTreeSet::new();
        for receipt in &self.receipts {
            if !ids.insert(&receipt.id) {
                return pipeline_error(format!("duplicate receipt {}", receipt.id));
            }
            receipt.validate_binding(
                &self.stage_id,
                &self.stage_definition_hash,
                &self.input_hash,
                &self.output_hash,
            )?;
            if receipt.recorded_at < self.recorded_at {
                return pipeline_error(format!(
                    "receipt {} predates the output it binds",
                    receipt.id
                ));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PipelineStage {
    pub definition: PipelineStageDefinition,
    pub definition_hash: String,
    pub status: PipelineStageStatus,
    #[serde(default)]
    pub attempt: u32,
    #[serde(default)]
    pub input_hash: Option<String>,
    #[serde(default)]
    pub output: Option<PipelineStageOutput>,
    #[serde(default)]
    pub pause_reason: Option<String>,
    #[serde(default)]
    pub terminal_reason: Option<String>,
    #[serde(default)]
    pub started_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub finished_at: Option<DateTime<Utc>>,
}

impl PipelineStage {
    pub fn new(definition: PipelineStageDefinition) -> Result<Self> {
        definition.validate()?;
        Ok(Self {
            definition_hash: definition.definition_hash(),
            definition,
            status: PipelineStageStatus::Pending,
            attempt: 0,
            input_hash: None,
            output: None,
            pause_reason: None,
            terminal_reason: None,
            started_at: None,
            finished_at: None,
        })
    }

    fn validate(&self) -> Result<()> {
        self.definition.validate()?;
        validate_hash("stage definition", &self.definition_hash)?;
        if self.definition_hash != self.definition.definition_hash() {
            return pipeline_error(format!(
                "stage {} definition hash is stale",
                self.definition.id
            ));
        }
        if let Some(input_hash) = &self.input_hash {
            validate_hash("stage input", input_hash)?;
        }
        match self.status {
            PipelineStageStatus::Pending => {
                if self.attempt != 0
                    || self.input_hash.is_some()
                    || self.output.is_some()
                    || self.terminal_reason.is_some()
                    || self.started_at.is_some()
                    || self.finished_at.is_some()
                {
                    return pipeline_error(format!(
                        "pending stage {} contains execution state",
                        self.definition.id
                    ));
                }
            }
            PipelineStageStatus::Succeeded => {
                let output = self.output.as_ref().ok_or_else(|| {
                    KoniError::Workflow(format!(
                        "pipeline: succeeded stage {} has no output",
                        self.definition.id
                    ))
                })?;
                output.validate(&self.definition)?;
                if output.attempt != self.attempt
                    || self.input_hash.as_deref() != Some(output.input_hash.as_str())
                    || self.started_at.is_none()
                    || self.finished_at.is_none()
                {
                    return pipeline_error(format!(
                        "succeeded stage {} has inconsistent execution metadata",
                        self.definition.id
                    ));
                }
                let started_at = self.started_at.expect("checked above");
                let finished_at = self.finished_at.expect("checked above");
                if output.recorded_at < started_at
                    || output.recorded_at > finished_at
                    || output
                        .receipts
                        .iter()
                        .any(|receipt| receipt.recorded_at > finished_at)
                    || self.terminal_reason.is_some()
                {
                    return pipeline_error(format!(
                        "succeeded stage {} has inconsistent output timing/reason",
                        self.definition.id
                    ));
                }
            }
            PipelineStageStatus::Skipped => {
                if self.definition.required
                    || self.attempt != 0
                    || self.input_hash.is_some()
                    || self.output.is_some()
                    || self.started_at.is_some()
                    || self.finished_at.is_none()
                    || self.pause_reason.is_some()
                    || self.terminal_reason.is_some()
                {
                    return pipeline_error(format!(
                        "stage {} cannot be represented as skipped",
                        self.definition.id
                    ));
                }
            }
            PipelineStageStatus::Running
            | PipelineStageStatus::Waiting
            | PipelineStageStatus::Paused
            | PipelineStageStatus::Failed
            | PipelineStageStatus::Blocked => {
                if self.attempt == 0 || self.input_hash.is_none() || self.started_at.is_none() {
                    return pipeline_error(format!(
                        "active/terminal stage {} is missing execution metadata",
                        self.definition.id
                    ));
                }
                if self.output.is_some() {
                    return pipeline_error(format!(
                        "non-success stage {} unexpectedly contains output",
                        self.definition.id
                    ));
                }
                if matches!(
                    self.status,
                    PipelineStageStatus::Failed | PipelineStageStatus::Blocked
                ) && self.finished_at.is_none()
                {
                    return pipeline_error(format!(
                        "terminal stage {} has no finished_at",
                        self.definition.id
                    ));
                }
                if matches!(
                    self.status,
                    PipelineStageStatus::Running
                        | PipelineStageStatus::Waiting
                        | PipelineStageStatus::Paused
                ) && (self.finished_at.is_some() || self.terminal_reason.is_some())
                {
                    return pipeline_error(format!(
                        "active stage {} contains terminal metadata",
                        self.definition.id
                    ));
                }
                if matches!(
                    self.status,
                    PipelineStageStatus::Failed | PipelineStageStatus::Blocked
                ) && self
                    .terminal_reason
                    .as_deref()
                    .is_none_or(|reason| reason.trim().is_empty())
                {
                    return pipeline_error(format!(
                        "terminal stage {} has no reason",
                        self.definition.id
                    ));
                }
            }
        }
        if self.status == PipelineStageStatus::Paused
            && self.pause_reason.as_deref().is_none_or(str::is_empty)
        {
            return pipeline_error(format!(
                "paused stage {} has no pause reason",
                self.definition.id
            ));
        }
        if self.status != PipelineStageStatus::Paused && self.pause_reason.is_some() {
            return pipeline_error(format!(
                "unpaused stage {} retains a pause reason",
                self.definition.id
            ));
        }
        if let (Some(started_at), Some(finished_at)) = (self.started_at, self.finished_at)
            && finished_at < started_at
        {
            return pipeline_error(format!(
                "stage {} finished before it started",
                self.definition.id
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunPipeline {
    pub schema_version: String,
    pub id: String,
    pub run_id: String,
    pub profile_hash: String,
    #[serde(default)]
    pub run_type_id: Option<String>,
    #[serde(default)]
    pub run_type_hash: Option<String>,
    pub definition_hash: String,
    pub status: RunPipelineStatus,
    pub cursor: usize,
    pub stages: Vec<PipelineStage>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Serialize)]
struct PipelineDefinitionHashInput<'a> {
    id: &'a str,
    run_id: &'a str,
    profile_hash: &'a str,
    run_type_id: &'a Option<String>,
    run_type_hash: &'a Option<String>,
    stages: Vec<&'a PipelineStageDefinition>,
}

impl RunPipeline {
    pub fn new(
        id: impl Into<String>,
        run_id: impl Into<String>,
        profile_hash: impl Into<String>,
        definitions: Vec<PipelineStageDefinition>,
        now: DateTime<Utc>,
    ) -> Result<Self> {
        let stages = definitions
            .into_iter()
            .map(PipelineStage::new)
            .collect::<Result<Vec<_>>>()?;
        let mut pipeline = Self {
            schema_version: RUN_PIPELINE_SCHEMA_VERSION.to_owned(),
            id: id.into(),
            run_id: run_id.into(),
            profile_hash: profile_hash.into(),
            run_type_id: None,
            run_type_hash: None,
            definition_hash: String::new(),
            status: RunPipelineStatus::Pending,
            cursor: 0,
            stages,
            created_at: now,
            updated_at: now,
        };
        pipeline.definition_hash = pipeline.compute_definition_hash();
        pipeline.validate()?;
        Ok(pipeline)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn from_catalog_pipeline(
        id: impl Into<String>,
        run_id: impl Into<String>,
        run_type_id: impl Into<String>,
        run_type_hash: impl Into<String>,
        profile_hash: impl Into<String>,
        definition: &PipelineDef,
        now: DateTime<Utc>,
    ) -> Result<Self> {
        let definitions = definition
            .order
            .iter()
            .map(|stage_id| {
                let stage = definition.stages.get(stage_id).ok_or_else(|| {
                    KoniError::Workflow(format!(
                        "pipeline: catalog order references missing stage {stage_id}"
                    ))
                })?;
                PipelineStageDefinition::from_catalog(stage_id, stage)
            })
            .collect::<Result<Vec<_>>>()?;
        if definitions.len() != definition.stages.len() {
            return pipeline_error("catalog pipeline order must contain each stage exactly once");
        }
        let mut pipeline = Self::new(id, run_id, profile_hash, definitions, now)?;
        pipeline.run_type_id = Some(run_type_id.into());
        pipeline.run_type_hash = Some(run_type_hash.into());
        pipeline.definition_hash = pipeline.compute_definition_hash();
        pipeline.validate()?;
        Ok(pipeline)
    }

    pub fn from_json(input: &str) -> Result<Self> {
        let pipeline: Self = serde_json::from_str(input).map_err(|source| KoniError::Json {
            path: PathBuf::from("<run-pipeline>"),
            source,
        })?;
        pipeline.validate()?;
        Ok(pipeline)
    }

    pub fn from_yaml(input: &str) -> Result<Self> {
        let pipeline: Self = serde_yaml::from_str(input).map_err(|source| KoniError::Yaml {
            path: PathBuf::from("<run-pipeline>"),
            source,
        })?;
        pipeline.validate()?;
        Ok(pipeline)
    }

    pub fn current(&self) -> Option<&PipelineStage> {
        self.stages.get(self.cursor)
    }

    pub fn start_current(
        &mut self,
        input_hash: impl Into<String>,
        now: DateTime<Utc>,
    ) -> Result<&str> {
        self.validate()?;
        self.require_monotonic_time(now)?;
        let input_hash = input_hash.into();
        validate_hash("stage input", &input_hash)?;
        let stage = self.stages.get_mut(self.cursor).ok_or_else(|| {
            KoniError::Workflow("pipeline: complete pipeline has no current stage".to_owned())
        })?;
        if stage.status != PipelineStageStatus::Pending {
            return pipeline_error(format!(
                "stage {} cannot start from {:?}",
                stage.definition.id, stage.status
            ));
        }
        stage.attempt = 1;
        stage.input_hash = Some(input_hash);
        stage.started_at = Some(now);
        stage.status = PipelineStageStatus::Running;
        self.status = RunPipelineStatus::Running;
        self.updated_at = now;
        Ok(&stage.definition.id)
    }

    pub fn mark_waiting(&mut self, now: DateTime<Utc>) -> Result<()> {
        self.transition_current(
            PipelineStageStatus::Running,
            PipelineStageStatus::Waiting,
            now,
        )?;
        self.status = RunPipelineStatus::Waiting;
        Ok(())
    }

    pub fn resume_waiting(&mut self, now: DateTime<Utc>) -> Result<()> {
        self.transition_current(
            PipelineStageStatus::Waiting,
            PipelineStageStatus::Running,
            now,
        )?;
        self.status = RunPipelineStatus::Running;
        Ok(())
    }

    pub fn pause_current(&mut self, reason: impl Into<String>, now: DateTime<Utc>) -> Result<()> {
        self.validate()?;
        self.require_monotonic_time(now)?;
        let reason = reason.into();
        if reason.trim().is_empty() {
            return pipeline_error("pause reason must not be empty");
        }
        let stage = self.stages.get_mut(self.cursor).ok_or_else(|| {
            KoniError::Workflow("pipeline: complete pipeline cannot pause".to_owned())
        })?;
        if !matches!(
            stage.status,
            PipelineStageStatus::Running | PipelineStageStatus::Waiting
        ) {
            return pipeline_error(format!(
                "stage {} cannot pause from {:?}",
                stage.definition.id, stage.status
            ));
        }
        stage.status = PipelineStageStatus::Paused;
        stage.pause_reason = Some(reason);
        self.status = RunPipelineStatus::Paused;
        self.updated_at = now;
        Ok(())
    }

    pub fn resume_paused(&mut self, now: DateTime<Utc>) -> Result<()> {
        self.validate()?;
        self.require_monotonic_time(now)?;
        let stage = self.stages.get_mut(self.cursor).ok_or_else(|| {
            KoniError::Workflow("pipeline: complete pipeline cannot resume".to_owned())
        })?;
        if stage.status != PipelineStageStatus::Paused {
            return pipeline_error(format!("stage {} is not paused", stage.definition.id));
        }
        stage.status = PipelineStageStatus::Running;
        stage.pause_reason = None;
        self.status = RunPipelineStatus::Running;
        self.updated_at = now;
        Ok(())
    }

    pub fn succeed_current(
        &mut self,
        output: PipelineStageOutput,
        now: DateTime<Utc>,
    ) -> Result<()> {
        self.validate()?;
        self.require_monotonic_time(now)?;
        let stage = self.stages.get_mut(self.cursor).ok_or_else(|| {
            KoniError::Workflow("pipeline: complete pipeline cannot succeed again".to_owned())
        })?;
        if !matches!(
            stage.status,
            PipelineStageStatus::Running | PipelineStageStatus::Waiting
        ) {
            return pipeline_error(format!(
                "stage {} cannot succeed from {:?}",
                stage.definition.id, stage.status
            ));
        }
        output.validate(&stage.definition)?;
        if output.attempt != stage.attempt
            || stage.input_hash.as_deref() != Some(output.input_hash.as_str())
        {
            return pipeline_error(format!(
                "stage {} output does not match its active attempt",
                stage.definition.id
            ));
        }
        stage.status = PipelineStageStatus::Succeeded;
        stage.output = Some(output);
        stage.finished_at = Some(now);
        self.cursor += 1;
        self.status = if self.cursor == self.stages.len() {
            RunPipelineStatus::Complete
        } else {
            RunPipelineStatus::Running
        };
        self.updated_at = now;
        self.validate()
    }

    pub fn skip_current(&mut self, now: DateTime<Utc>) -> Result<()> {
        self.validate()?;
        self.require_monotonic_time(now)?;
        let stage = self.stages.get_mut(self.cursor).ok_or_else(|| {
            KoniError::Workflow("pipeline: complete pipeline cannot skip".to_owned())
        })?;
        if stage.definition.required || stage.status != PipelineStageStatus::Pending {
            return pipeline_error(format!("stage {} cannot be skipped", stage.definition.id));
        }
        stage.status = PipelineStageStatus::Skipped;
        stage.finished_at = Some(now);
        self.cursor += 1;
        self.status = if self.cursor == self.stages.len() {
            RunPipelineStatus::Complete
        } else {
            RunPipelineStatus::Running
        };
        self.updated_at = now;
        self.validate()
    }

    pub fn block_current(&mut self, reason: impl Into<String>, now: DateTime<Utc>) -> Result<()> {
        self.finish_current_unsuccessfully(PipelineStageStatus::Blocked, reason, now)
    }

    pub fn fail_current(&mut self, reason: impl Into<String>, now: DateTime<Utc>) -> Result<()> {
        self.finish_current_unsuccessfully(PipelineStageStatus::Failed, reason, now)
    }

    /// Begin another durable attempt after an operator has addressed the
    /// reason a supervised stage was blocked or failed.
    ///
    /// Successful and active stages cannot be retried. The caller supplies
    /// the input binding for the new attempt so a subsequent supervisor tick
    /// can prove it is resuming the same pinned work.
    pub fn retry_current(
        &mut self,
        input_hash: impl Into<String>,
        now: DateTime<Utc>,
    ) -> Result<()> {
        self.validate()?;
        self.require_monotonic_time(now)?;
        let input_hash = input_hash.into();
        validate_hash("stage input", &input_hash)?;
        let stage = self.stages.get_mut(self.cursor).ok_or_else(|| {
            KoniError::Workflow("pipeline: complete pipeline cannot retry".to_owned())
        })?;
        if !matches!(
            stage.status,
            PipelineStageStatus::Blocked | PipelineStageStatus::Failed
        ) {
            return pipeline_error(format!(
                "stage {} cannot retry from {:?}",
                stage.definition.id, stage.status
            ));
        }
        stage.attempt = stage.attempt.saturating_add(1);
        stage.input_hash = Some(input_hash);
        stage.output = None;
        stage.pause_reason = None;
        stage.terminal_reason = None;
        stage.started_at = Some(now);
        stage.finished_at = None;
        stage.status = PipelineStageStatus::Running;
        self.status = RunPipelineStatus::Running;
        self.updated_at = now;
        self.validate()
    }

    pub fn validate(&self) -> Result<()> {
        if self.schema_version != RUN_PIPELINE_SCHEMA_VERSION {
            return pipeline_error(format!(
                "unsupported run pipeline schema {}",
                self.schema_version
            ));
        }
        validate_id("pipeline", &self.id)?;
        validate_id("pipeline run", &self.run_id)?;
        validate_hash("profile", &self.profile_hash)?;
        match (&self.run_type_id, &self.run_type_hash) {
            (Some(run_type_id), Some(run_type_hash)) => {
                validate_id("pipeline run type", run_type_id)?;
                validate_hash("pipeline run type", run_type_hash)?;
            }
            (None, None) => {}
            _ => return pipeline_error("pipeline run-type binding is incomplete"),
        }
        validate_hash("pipeline definition", &self.definition_hash)?;
        if self.stages.is_empty() {
            return pipeline_error("pipeline must contain at least one stage");
        }
        if self.updated_at < self.created_at {
            return pipeline_error("pipeline updated_at precedes created_at");
        }
        if self.definition_hash != self.compute_definition_hash() {
            return pipeline_error("pipeline definition hash is stale");
        }
        let mut ids = BTreeSet::new();
        for stage in &self.stages {
            if !ids.insert(&stage.definition.id) {
                return pipeline_error(format!("duplicate pipeline stage {}", stage.definition.id));
            }
            stage.validate()?;
            for timestamp in [stage.started_at, stage.finished_at].into_iter().flatten() {
                if timestamp < self.created_at || timestamp > self.updated_at {
                    return pipeline_error(format!(
                        "stage {} timestamp is outside the pipeline lifetime",
                        stage.definition.id
                    ));
                }
            }
            if let Some(output) = &stage.output
                && (output.recorded_at < self.created_at || output.recorded_at > self.updated_at)
            {
                return pipeline_error(format!(
                    "stage {} output timestamp is outside the pipeline lifetime",
                    stage.definition.id
                ));
            }
        }
        if self.cursor > self.stages.len() {
            return pipeline_error("pipeline cursor is outside the stage list");
        }
        for stage in &self.stages[..self.cursor] {
            if !stage.status.is_success_terminal() {
                return pipeline_error(format!(
                    "stage {} before the cursor is not successful",
                    stage.definition.id
                ));
            }
        }
        if self.cursor < self.stages.len() {
            for stage in &self.stages[self.cursor + 1..] {
                if stage.status != PipelineStageStatus::Pending {
                    return pipeline_error(format!(
                        "later stage {} advanced out of order",
                        stage.definition.id
                    ));
                }
            }
            let expected = match self.stages[self.cursor].status {
                PipelineStageStatus::Pending if self.cursor == 0 => RunPipelineStatus::Pending,
                PipelineStageStatus::Pending => RunPipelineStatus::Running,
                PipelineStageStatus::Running => RunPipelineStatus::Running,
                PipelineStageStatus::Waiting => RunPipelineStatus::Waiting,
                PipelineStageStatus::Paused => RunPipelineStatus::Paused,
                PipelineStageStatus::Blocked => RunPipelineStatus::Blocked,
                PipelineStageStatus::Failed => RunPipelineStatus::Failed,
                PipelineStageStatus::Succeeded | PipelineStageStatus::Skipped => {
                    return pipeline_error("pipeline cursor points at a terminal success stage");
                }
            };
            if self.status != expected {
                return pipeline_error(format!(
                    "pipeline status {:?} disagrees with current stage {:?}",
                    self.status, self.stages[self.cursor].status
                ));
            }
        } else if self.status != RunPipelineStatus::Complete {
            return pipeline_error("pipeline past its last stage is not complete");
        }
        Ok(())
    }

    fn compute_definition_hash(&self) -> String {
        normalized_hash(&PipelineDefinitionHashInput {
            id: &self.id,
            run_id: &self.run_id,
            profile_hash: &self.profile_hash,
            run_type_id: &self.run_type_id,
            run_type_hash: &self.run_type_hash,
            stages: self.stages.iter().map(|stage| &stage.definition).collect(),
        })
    }

    fn transition_current(
        &mut self,
        from: PipelineStageStatus,
        to: PipelineStageStatus,
        now: DateTime<Utc>,
    ) -> Result<()> {
        self.validate()?;
        self.require_monotonic_time(now)?;
        let stage = self.stages.get_mut(self.cursor).ok_or_else(|| {
            KoniError::Workflow("pipeline: complete pipeline cannot transition".to_owned())
        })?;
        if stage.status != from {
            return pipeline_error(format!(
                "stage {} cannot transition from {:?}; expected {:?}",
                stage.definition.id, stage.status, from
            ));
        }
        stage.status = to;
        self.updated_at = now;
        Ok(())
    }

    fn finish_current_unsuccessfully(
        &mut self,
        status: PipelineStageStatus,
        reason: impl Into<String>,
        now: DateTime<Utc>,
    ) -> Result<()> {
        self.validate()?;
        self.require_monotonic_time(now)?;
        let reason = reason.into();
        if reason.trim().is_empty() {
            return pipeline_error("terminal reason must not be empty");
        }
        let stage = self.stages.get_mut(self.cursor).ok_or_else(|| {
            KoniError::Workflow("pipeline: complete pipeline cannot fail".to_owned())
        })?;
        if !matches!(
            stage.status,
            PipelineStageStatus::Running
                | PipelineStageStatus::Waiting
                | PipelineStageStatus::Paused
        ) {
            return pipeline_error(format!(
                "stage {} cannot terminate from {:?}",
                stage.definition.id, stage.status
            ));
        }
        stage.status = status;
        stage.pause_reason = None;
        stage.terminal_reason = Some(reason);
        stage.finished_at = Some(now);
        self.status = match status {
            PipelineStageStatus::Blocked => RunPipelineStatus::Blocked,
            PipelineStageStatus::Failed => RunPipelineStatus::Failed,
            _ => unreachable!("caller supplies an unsuccessful terminal status"),
        };
        self.updated_at = now;
        self.validate()
    }

    fn require_monotonic_time(&self, now: DateTime<Utc>) -> Result<()> {
        if now < self.updated_at {
            return pipeline_error("pipeline mutation timestamp moved backwards");
        }
        Ok(())
    }
}

fn validate_id(label: &str, value: &str) -> Result<()> {
    if value.trim().is_empty()
        || value
            .chars()
            .any(|character| character.is_whitespace() || character == '/' || character == '\\')
    {
        return pipeline_error(format!("invalid {label} id {value:?}"));
    }
    Ok(())
}

fn validate_hash(label: &str, value: &str) -> Result<()> {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return pipeline_error(format!("{label} hash is not sha256"));
    };
    if hex.len() != 64 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return pipeline_error(format!("{label} hash is malformed"));
    }
    Ok(())
}

fn pipeline_error<T>(message: impl Into<String>) -> Result<T> {
    Err(KoniError::Workflow(format!("pipeline: {}", message.into())))
}

#[cfg(test)]
mod tests {
    use chrono::{TimeZone, Utc};
    use indexmap::IndexMap;
    use serde_json::json;

    use super::*;

    fn now(second: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 7, 10, 12, 0, second).unwrap()
    }

    fn definitions() -> Vec<PipelineStageDefinition> {
        vec![
            PipelineStageDefinition {
                id: "build".to_owned(),
                title: "Build".to_owned(),
                kind: PipelineStageKind::Action,
                required: true,
                config: json!({"action": "compile"}),
            },
            PipelineStageDefinition {
                id: "publish".to_owned(),
                title: "Publish".to_owned(),
                kind: PipelineStageKind::ExternalLoop,
                required: true,
                config: json!({"loop": "github"}),
            },
        ]
    }

    #[test]
    fn ordered_pipeline_round_trips_hash_bound_output_and_receipt() {
        let profile_hash = normalized_hash(&"profile");
        let input_hash = normalized_hash(&json!({"head": "abc"}));
        let mut pipeline =
            RunPipeline::new("delivery", "run-1", profile_hash, definitions(), now(0)).unwrap();
        assert_eq!(
            pipeline.start_current(&input_hash, now(1)).unwrap(),
            "build"
        );

        let definition = pipeline.current().unwrap().definition.clone();
        let mut output = PipelineStageOutput::new(
            &definition,
            1,
            &input_hash,
            json!({"ticket": "TK-1"}),
            now(2),
        )
        .unwrap();
        let receipt = PipelineStageReceipt::new(
            "receipt-1",
            "compiler",
            &output.stage_id,
            &output.stage_definition_hash,
            &output.input_hash,
            &output.output_hash,
            json!({"status": "passed"}),
            now(2),
        )
        .unwrap();
        output.push_receipt(receipt).unwrap();
        pipeline.succeed_current(output, now(3)).unwrap();
        assert_eq!(pipeline.cursor, 1);

        let yaml = serde_yaml::to_string(&pipeline).unwrap();
        let restored = RunPipeline::from_yaml(&yaml).unwrap();
        assert_eq!(restored, pipeline);
        assert_eq!(restored.current().unwrap().definition.id, "publish");
    }

    #[test]
    fn stages_cannot_advance_out_of_order() {
        let mut pipeline = RunPipeline::new(
            "delivery",
            "run-1",
            normalized_hash(&"profile"),
            definitions(),
            now(0),
        )
        .unwrap();
        pipeline.stages[1].status = PipelineStageStatus::Running;
        pipeline.stages[1].attempt = 1;
        pipeline.stages[1].input_hash = Some(normalized_hash(&"input"));
        pipeline.stages[1].started_at = Some(now(1));
        assert!(pipeline.validate().is_err());
    }

    #[test]
    fn tampered_output_and_unknown_fields_fail_closed() {
        let profile_hash = normalized_hash(&"profile");
        let input_hash = normalized_hash(&"input");
        let mut pipeline =
            RunPipeline::new("delivery", "run-1", profile_hash, definitions(), now(0)).unwrap();
        pipeline.start_current(&input_hash, now(1)).unwrap();
        let mut output = PipelineStageOutput::new(
            &pipeline.current().unwrap().definition,
            1,
            input_hash,
            json!({"ok": true}),
            now(2),
        )
        .unwrap();
        output.output = json!({"ok": false});
        assert!(pipeline.succeed_current(output, now(3)).is_err());

        let definition = pipeline.current().unwrap().definition.clone();
        let mut receipt_bound = PipelineStageOutput::new(
            &definition,
            1,
            normalized_hash(&"input"),
            json!({"ok": true}),
            now(2),
        )
        .unwrap();
        let mut receipt = PipelineStageReceipt::new(
            "receipt-2",
            "verification",
            &receipt_bound.stage_id,
            &receipt_bound.stage_definition_hash,
            &receipt_bound.input_hash,
            &receipt_bound.output_hash,
            json!({"verdict": "passed"}),
            now(2),
        )
        .unwrap();
        receipt.payload = json!({"verdict": "failed"});
        receipt_bound.receipts.push(receipt);
        assert!(receipt_bound.validate(&definition).is_err());

        let mut value = serde_json::to_value(&pipeline).unwrap();
        value
            .as_object_mut()
            .unwrap()
            .insert("unexpected".to_owned(), json!(true));
        assert!(RunPipeline::from_json(&value.to_string()).is_err());
    }

    #[test]
    fn blocked_stage_persists_reason_and_rejects_backdated_mutation() {
        let mut pipeline = RunPipeline::new(
            "delivery",
            "run-1",
            normalized_hash(&"profile"),
            definitions(),
            now(1),
        )
        .unwrap();
        assert!(
            pipeline
                .start_current(normalized_hash(&"input"), now(0))
                .is_err()
        );
        pipeline
            .start_current(normalized_hash(&"input"), now(2))
            .unwrap();
        pipeline
            .block_current("external review exhausted", now(3))
            .unwrap();
        assert_eq!(
            pipeline.current().unwrap().terminal_reason.as_deref(),
            Some("external review exhausted")
        );
        RunPipeline::from_json(&serde_json::to_string(&pipeline).unwrap()).unwrap();
    }

    #[test]
    fn supervised_stage_kinds_are_not_action_aliases() {
        assert_eq!(
            PipelineStageKind::parse("orchestration").unwrap(),
            PipelineStageKind::Orchestration
        );
        assert_eq!(
            PipelineStageKind::parse("agent_review").unwrap(),
            PipelineStageKind::AgentReview
        );
        assert_ne!(
            PipelineStageKind::parse("agent_review").unwrap(),
            PipelineStageKind::Action
        );
    }

    #[test]
    fn blocked_stage_can_begin_a_new_bound_attempt() {
        let first_input = normalized_hash(&"first");
        let retry_input = normalized_hash(&"retry");
        let mut pipeline = RunPipeline::new(
            "delivery",
            "run-1",
            normalized_hash(&"profile"),
            definitions(),
            now(0),
        )
        .unwrap();
        pipeline.start_current(first_input, now(1)).unwrap();
        pipeline.block_current("repair required", now(2)).unwrap();

        pipeline.retry_current(&retry_input, now(3)).unwrap();

        let stage = pipeline.current().unwrap();
        assert_eq!(stage.status, PipelineStageStatus::Running);
        assert_eq!(stage.attempt, 2);
        assert_eq!(stage.input_hash.as_deref(), Some(retry_input.as_str()));
        assert!(stage.terminal_reason.is_none());
        assert!(stage.finished_at.is_none());
        RunPipeline::from_yaml(&serde_yaml::to_string(&pipeline).unwrap()).unwrap();
    }

    #[test]
    fn catalog_pipeline_order_and_run_type_hash_are_pinned() {
        let definition = PipelineDef {
            stages: IndexMap::from([
                (
                    "plan".to_owned(),
                    PipelineStageDef {
                        kind: "action".to_owned(),
                        title: "Plan".to_owned(),
                        config: Some(json!({"action": "compile"})),
                    },
                ),
                (
                    "review".to_owned(),
                    PipelineStageDef {
                        kind: "external_loop".to_owned(),
                        title: "Review".to_owned(),
                        config: Some(json!({"provider": "github"})),
                    },
                ),
            ]),
            order: vec!["plan".to_owned(), "review".to_owned()],
        };
        let pipeline = RunPipeline::from_catalog_pipeline(
            "delivery",
            "run-1",
            "software-change",
            normalized_hash(&"run-type"),
            normalized_hash(&"profile"),
            &definition,
            now(0),
        )
        .unwrap();
        assert_eq!(pipeline.run_type_id.as_deref(), Some("software-change"));
        assert_eq!(
            pipeline.stages[0].definition.kind,
            PipelineStageKind::Action
        );
        assert_eq!(
            pipeline.stages[1].definition.kind,
            PipelineStageKind::ExternalLoop
        );
    }
}
