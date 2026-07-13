//! Provider-neutral domain logic for durable external review/check loops.
//!
//! The state machine is pure. Provider or command execution is supplied by an
//! adapter, while this module validates every observation against the exact
//! published head revision.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use chrono::{DateTime, Duration, Utc};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{KoniError, Result};
use crate::graph::normalized_hash;

pub const EXTERNAL_LOOP_SCHEMA_VERSION: &str = "1.0";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GitHubLoopConfig {
    /// `owner/repository`.
    pub repository: String,
    #[serde(default = "default_remote")]
    pub remote: String,
    pub base_branch: String,
    #[serde(default)]
    pub pull_request: Option<u64>,
    /// Normal PRs are the default; profiles may opt into draft publication.
    #[serde(default)]
    pub draft: bool,
}

fn default_remote() -> String {
    "origin".to_owned()
}

impl GitHubLoopConfig {
    fn validate(&self) -> Result<()> {
        let parts: Vec<_> = self.repository.split('/').collect();
        if parts.len() != 2
            || parts.iter().any(|part| {
                part.is_empty()
                    || part
                        .chars()
                        .any(|character| character.is_whitespace() || character == '\\')
            })
        {
            return external_error(format!(
                "GitHub repository must be owner/name, got {:?}",
                self.repository
            ));
        }
        validate_token("Git remote", &self.remote)?;
        if self.base_branch.trim().is_empty() || self.base_branch.chars().any(char::is_whitespace) {
            return external_error("GitHub base branch must not be empty or contain whitespace");
        }
        if self.pull_request == Some(0) {
            return external_error("GitHub pull request number must be positive");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CiLoopConfig {
    #[serde(default)]
    pub required_checks: BTreeSet<String>,
    #[serde(default)]
    pub allow_skipped: bool,
}

impl CiLoopConfig {
    fn validate(&self) -> Result<()> {
        for check in &self.required_checks {
            if check.trim().is_empty() {
                return external_error("required CI check name must not be empty");
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GreptileLoopConfig {
    #[serde(default = "default_true")]
    pub required: bool,
    pub minimum_confidence: u8,
    #[serde(default = "default_greptile_label")]
    pub review_label: String,
    #[serde(default = "default_greptile_bot")]
    pub bot_login: String,
    #[serde(default = "default_greptile_trigger")]
    pub trigger_comment: String,
}

fn default_true() -> bool {
    true
}

fn default_greptile_label() -> String {
    "greptile".to_owned()
}

fn default_greptile_bot() -> String {
    "greptile-apps[bot]".to_owned()
}

fn default_greptile_trigger() -> String {
    "@greptileai".to_owned()
}

impl GreptileLoopConfig {
    fn validate(&self) -> Result<()> {
        if self.minimum_confidence > 5 {
            return external_error("Greptile minimum confidence must be between 0 and 5");
        }
        if self.review_label.trim().is_empty() {
            return external_error("Greptile review label must not be empty");
        }
        if self.bot_login.trim().is_empty() || self.trigger_comment.trim().is_empty() {
            return external_error("Greptile bot login and trigger comment must not be empty");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExternalLoopIterationPolicy {
    pub max_iterations: u32,
    pub max_repairs_per_iteration: u32,
    #[serde(default = "default_true")]
    pub block_on_unchanged_head: bool,
}

impl ExternalLoopIterationPolicy {
    fn validate(&self) -> Result<()> {
        if self.max_iterations == 0 || self.max_repairs_per_iteration == 0 {
            return external_error("external loop iteration limits must be positive");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExternalLoopTimeoutPolicy {
    pub total_seconds: u64,
    pub prepare_seconds: u64,
    pub publish_seconds: u64,
    pub wait_seconds: u64,
    pub collect_seconds: u64,
    pub repair_seconds: u64,
    pub verify_seconds: u64,
    pub poll_interval_seconds: u64,
}

impl ExternalLoopTimeoutPolicy {
    fn validate(&self) -> Result<()> {
        if [
            self.total_seconds,
            self.prepare_seconds,
            self.publish_seconds,
            self.wait_seconds,
            self.collect_seconds,
            self.repair_seconds,
            self.verify_seconds,
            self.poll_interval_seconds,
        ]
        .contains(&0)
        {
            return external_error("external loop timeout values must be positive");
        }
        if self.poll_interval_seconds > self.wait_seconds {
            return external_error("poll interval cannot exceed wait timeout");
        }
        Ok(())
    }

    fn phase_seconds(&self, phase: ExternalLoopPhase) -> Option<u64> {
        match phase {
            ExternalLoopPhase::Prepare => Some(self.prepare_seconds),
            ExternalLoopPhase::Publish | ExternalLoopPhase::Republish => Some(self.publish_seconds),
            ExternalLoopPhase::Wait => Some(self.wait_seconds),
            ExternalLoopPhase::Collect => Some(self.collect_seconds),
            ExternalLoopPhase::Repair => Some(self.repair_seconds),
            ExternalLoopPhase::Verify => Some(self.verify_seconds),
            ExternalLoopPhase::Complete | ExternalLoopPhase::Blocked => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExternalLoopConfig {
    pub schema_version: String,
    pub id: String,
    pub github: GitHubLoopConfig,
    pub ci: CiLoopConfig,
    #[serde(default)]
    pub greptile: Option<GreptileLoopConfig>,
    /// Optional compiler-owned action dispatched when repair evidence is
    /// collected. Without an action, the durable repair request remains
    /// available for an orchestrator or human worker to claim.
    #[serde(default, skip_serializing_if = "ExternalRepairConfig::is_empty")]
    pub repair: ExternalRepairConfig,
    pub iterations: ExternalLoopIterationPolicy,
    pub timeouts: ExternalLoopTimeoutPolicy,
}

impl ExternalLoopConfig {
    pub fn from_yaml(input: &str) -> Result<Self> {
        let config: Self = serde_yaml::from_str(input).map_err(|source| KoniError::Yaml {
            path: PathBuf::from("<external-loop-config>"),
            source,
        })?;
        config.validate()?;
        Ok(config)
    }

    pub fn config_hash(&self) -> String {
        normalized_hash(self)
    }

    pub fn validate(&self) -> Result<()> {
        if self.schema_version != EXTERNAL_LOOP_SCHEMA_VERSION {
            return external_error(format!(
                "unsupported external loop schema {}",
                self.schema_version
            ));
        }
        validate_token("external loop", &self.id)?;
        self.github.validate()?;
        self.ci.validate()?;
        if let Some(greptile) = &self.greptile {
            greptile.validate()?;
        }
        self.repair.validate()?;
        self.iterations.validate()?;
        self.timeouts.validate()
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExternalRepairConfig {
    #[serde(default)]
    pub action: Option<String>,
}

impl ExternalRepairConfig {
    fn is_empty(&self) -> bool {
        self.action.is_none()
    }

    fn validate(&self) -> Result<()> {
        if let Some(action) = &self.action {
            validate_token("external repair action", action)?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExternalLoopPhase {
    Prepare,
    Publish,
    Wait,
    Collect,
    Repair,
    Republish,
    Verify,
    Complete,
    Blocked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExternalLoopStatus {
    Active,
    Waiting,
    Complete,
    Blocked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GhCheckBucket {
    Pass,
    Fail,
    Pending,
    Skipping,
    Cancel,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GhCheck {
    pub name: String,
    pub bucket: GhCheckBucket,
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub link: Option<String>,
    #[serde(default)]
    pub workflow: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GhCheckBuckets {
    #[serde(default)]
    pub passed: Vec<GhCheck>,
    #[serde(default)]
    pub failed: Vec<GhCheck>,
    #[serde(default)]
    pub pending: Vec<GhCheck>,
    #[serde(default)]
    pub skipped: Vec<GhCheck>,
    #[serde(default)]
    pub cancelled: Vec<GhCheck>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CiDisposition {
    Passed,
    Pending,
    Repair,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CiEvaluation {
    pub disposition: CiDisposition,
    #[serde(default)]
    pub missing: Vec<String>,
    #[serde(default)]
    pub pending: Vec<String>,
    #[serde(default)]
    pub failing: Vec<String>,
}

impl GhCheckBuckets {
    pub fn all(&self) -> impl Iterator<Item = &GhCheck> {
        self.passed
            .iter()
            .chain(&self.failed)
            .chain(&self.pending)
            .chain(&self.skipped)
            .chain(&self.cancelled)
    }

    pub fn evaluate(&self, policy: &CiLoopConfig) -> CiEvaluation {
        let by_name: BTreeMap<_, _> = self
            .all()
            .map(|check| (check.name.as_str(), check.bucket))
            .collect();
        let names: BTreeSet<String> = if policy.required_checks.is_empty() {
            by_name.keys().map(|name| (*name).to_owned()).collect()
        } else {
            policy.required_checks.clone()
        };
        let mut missing = Vec::new();
        let mut pending = Vec::new();
        let mut failing = Vec::new();
        for name in names {
            match by_name.get(name.as_str()) {
                Some(GhCheckBucket::Pass) => {}
                Some(GhCheckBucket::Skipping) if policy.allow_skipped => {}
                Some(GhCheckBucket::Pending) => pending.push(name),
                Some(GhCheckBucket::Fail)
                | Some(GhCheckBucket::Cancel)
                | Some(GhCheckBucket::Skipping) => failing.push(name),
                None => missing.push(name),
            }
        }
        let disposition = if !failing.is_empty() {
            CiDisposition::Repair
        } else if !pending.is_empty() || !missing.is_empty() {
            CiDisposition::Pending
        } else {
            CiDisposition::Passed
        };
        CiEvaluation {
            disposition,
            missing,
            pending,
            failing,
        }
    }

    fn validate(&self) -> Result<()> {
        let mut names = BTreeSet::new();
        for (expected, checks) in [
            (GhCheckBucket::Pass, &self.passed),
            (GhCheckBucket::Fail, &self.failed),
            (GhCheckBucket::Pending, &self.pending),
            (GhCheckBucket::Skipping, &self.skipped),
            (GhCheckBucket::Cancel, &self.cancelled),
        ] {
            if checks.iter().any(|check| check.bucket != expected) {
                return external_error(format!(
                    "GitHub check bucket {:?} contains a mismatched check",
                    expected
                ));
            }
        }
        for check in self.all() {
            if check.name.trim().is_empty() {
                return external_error("GitHub check name must not be empty");
            }
            if !names.insert(&check.name) {
                return external_error(format!("duplicate GitHub check {}", check.name));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawGhCheck {
    name: String,
    bucket: GhCheckBucket,
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    link: Option<String>,
    #[serde(default)]
    workflow: Option<String>,
}

/// Parse the JSON emitted by `gh pr checks --json name,bucket,state,link,workflow`.
pub fn parse_gh_check_buckets(input: &str) -> Result<GhCheckBuckets> {
    let raw: Vec<RawGhCheck> = serde_json::from_str(input).map_err(|source| KoniError::Json {
        path: PathBuf::from("<gh-pr-checks>"),
        source,
    })?;
    let mut buckets = GhCheckBuckets::default();
    for check in raw {
        let check = GhCheck {
            name: check.name,
            bucket: check.bucket,
            state: check.state,
            link: check.link,
            workflow: check.workflow,
        };
        match check.bucket {
            GhCheckBucket::Pass => buckets.passed.push(check),
            GhCheckBucket::Fail => buckets.failed.push(check),
            GhCheckBucket::Pending => buckets.pending.push(check),
            GhCheckBucket::Skipping => buckets.skipped.push(check),
            GhCheckBucket::Cancel => buckets.cancelled.push(check),
        }
    }
    for values in [
        &mut buckets.passed,
        &mut buckets.failed,
        &mut buckets.pending,
        &mut buckets.skipped,
        &mut buckets.cancelled,
    ] {
        values.sort_by(|left, right| left.name.cmp(&right.name));
    }
    buckets.validate()?;
    Ok(buckets)
}

/// Parse one exact Git object ID with no labels or additional output.
pub fn parse_exact_head_sha(input: &str) -> Result<String> {
    let value = input.trim();
    if value.lines().count() != 1
        || !matches!(value.len(), 40 | 64)
        || !value.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return external_error("head output must contain exactly one 40- or 64-digit hex SHA");
    }
    Ok(value.to_ascii_lowercase())
}

/// Parse exactly one `Confidence Score: N/5` marker from Greptile text.
pub fn parse_greptile_confidence(input: &str) -> Result<u8> {
    let expression = Regex::new(r"(?i)confidence\s+score\s*[:=-]?\s*([0-9]+)\s*/\s*5")
        .expect("Greptile confidence regex is static");
    let scores = expression
        .captures_iter(input)
        .map(|capture| capture[1].parse::<u8>())
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|_| KoniError::Workflow("external loop: malformed Greptile score".to_owned()))?;
    if scores.len() != 1 || scores[0] > 5 {
        return external_error(
            "Greptile output must contain exactly one Confidence Score: N/5 with N in 0..=5",
        );
    }
    Ok(scores[0])
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GitHubPublication {
    pub head_sha: String,
    pub pull_request: u64,
    pub url: String,
    pub published_at: DateTime<Utc>,
}

impl GitHubPublication {
    fn validate(&self) -> Result<()> {
        validate_sha(&self.head_sha)?;
        if self.pull_request == 0 || self.url.trim().is_empty() {
            return external_error("GitHub publication requires a PR number and URL");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GreptileObservation {
    pub head_sha: String,
    pub confidence: u8,
    pub body_hash: String,
    pub collected_at: DateTime<Utc>,
}

impl GreptileObservation {
    pub fn from_body(
        head_sha: impl Into<String>,
        body: &str,
        collected_at: DateTime<Utc>,
    ) -> Result<Self> {
        let observation = Self {
            head_sha: head_sha.into(),
            confidence: parse_greptile_confidence(body)?,
            body_hash: normalized_hash(&body),
            collected_at,
        };
        observation.validate()?;
        Ok(observation)
    }

    fn validate(&self) -> Result<()> {
        validate_sha(&self.head_sha)?;
        validate_hash("Greptile body", &self.body_hash)?;
        if self.confidence > 5 {
            return external_error("Greptile confidence must be between 0 and 5");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExternalCollection {
    pub head_sha: String,
    pub checks: GhCheckBuckets,
    #[serde(default)]
    pub greptile: Option<GreptileObservation>,
    pub collected_at: DateTime<Utc>,
}

impl ExternalCollection {
    fn validate(&self) -> Result<()> {
        validate_sha(&self.head_sha)?;
        self.checks.validate()?;
        if let Some(greptile) = &self.greptile {
            greptile.validate()?;
            if greptile.head_sha != self.head_sha {
                return external_error("Greptile observation is for a different head SHA");
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExternalRepairRecord {
    pub base_head_sha: String,
    /// Local integration HEAD produced by the compiler-owned repair. It is
    /// subsequently published and becomes the exact evidence key.
    pub result_head_sha: String,
    pub change_hash: String,
    pub summary: String,
    pub repaired_at: DateTime<Utc>,
}

impl ExternalRepairRecord {
    fn validate(&self) -> Result<()> {
        validate_sha(&self.base_head_sha)?;
        validate_sha(&self.result_head_sha)?;
        if self.result_head_sha == self.base_head_sha {
            return external_error("repair output did not advance local HEAD");
        }
        validate_hash("repair change", &self.change_hash)?;
        if self.summary.trim().is_empty() {
            return external_error("repair summary must not be empty");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExternalRepairRequestStatus {
    Requested,
    Dispatched,
    HeadChanged,
    Failed,
}

/// Durable, provider-neutral work requested by a failed external collection.
/// The surrounding run control store owns persistence and action dispatch.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExternalRepairRequest {
    pub schema_version: String,
    pub id: String,
    pub run_id: String,
    pub loop_id: String,
    pub iteration: u32,
    pub attempt: u32,
    pub base_head_sha: String,
    pub evidence_hash: String,
    pub reasons: Vec<String>,
    #[serde(default)]
    pub action: Option<String>,
    pub status: ExternalRepairRequestStatus,
    #[serde(default)]
    pub action_result: Option<Value>,
    #[serde(default)]
    pub result_head_sha: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    pub requested_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl ExternalRepairRequest {
    pub fn from_state(
        run_id: impl Into<String>,
        config: &ExternalLoopConfig,
        state: &ExternalLoopState,
        now: DateTime<Utc>,
    ) -> Result<Self> {
        if state.phase != ExternalLoopPhase::Repair || state.repair_attempts == 0 {
            return external_error("repair requests require an active repair phase");
        }
        let run_id = run_id.into();
        validate_token("repair request run", &run_id)?;
        let base_head_sha = state.head_sha.clone().ok_or_else(|| {
            KoniError::Workflow("external loop: repair request has no head".to_owned())
        })?;
        let reasons = state.repair_reasons(config)?;
        if reasons.is_empty() {
            return external_error("repair request has no failure evidence");
        }
        let evidence_hash = normalized_hash(&(
            &state.id,
            state.iteration,
            state.repair_attempts,
            &base_head_sha,
            &reasons,
        ));
        let id = format!("repair-{}", &evidence_hash["sha256:".len()..][..16]);
        let request = Self {
            schema_version: EXTERNAL_LOOP_SCHEMA_VERSION.to_owned(),
            id,
            run_id,
            loop_id: state.id.clone(),
            iteration: state.iteration,
            attempt: state.repair_attempts,
            base_head_sha,
            evidence_hash,
            reasons,
            action: config.repair.action.clone(),
            status: ExternalRepairRequestStatus::Requested,
            action_result: None,
            result_head_sha: None,
            error: None,
            requested_at: now,
            updated_at: now,
        };
        request.validate()?;
        Ok(request)
    }

    pub fn record_dispatch(&mut self, result: Value, now: DateTime<Utc>) -> Result<()> {
        if self.status != ExternalRepairRequestStatus::Requested {
            return external_error("only requested repair work can be dispatched");
        }
        self.status = ExternalRepairRequestStatus::Dispatched;
        self.action_result = Some(result);
        self.updated_at = now;
        self.validate()
    }

    pub fn record_head_change(
        &mut self,
        result_head_sha: impl Into<String>,
        now: DateTime<Utc>,
    ) -> Result<()> {
        if self.status == ExternalRepairRequestStatus::HeadChanged {
            return external_error("terminal repair request cannot record a head change");
        }
        self.result_head_sha = Some(result_head_sha.into());
        self.status = ExternalRepairRequestStatus::HeadChanged;
        self.error = None;
        self.updated_at = now;
        self.validate()
    }

    pub fn record_failure(&mut self, error: impl Into<String>, now: DateTime<Utc>) -> Result<()> {
        let error = error.into();
        if error.trim().is_empty() {
            return external_error("repair request failure must include an error");
        }
        if self.status == ExternalRepairRequestStatus::HeadChanged {
            return external_error("completed repair request cannot fail");
        }
        self.status = ExternalRepairRequestStatus::Failed;
        self.error = Some(error);
        self.updated_at = now;
        self.validate()
    }

    pub fn validate(&self) -> Result<()> {
        if self.schema_version != EXTERNAL_LOOP_SCHEMA_VERSION {
            return external_error("unsupported repair request schema");
        }
        validate_token("repair request", &self.id)?;
        validate_token("repair request run", &self.run_id)?;
        validate_token("repair request loop", &self.loop_id)?;
        validate_sha(&self.base_head_sha)?;
        validate_hash("repair evidence", &self.evidence_hash)?;
        if self.iteration == 0 || self.attempt == 0 {
            return external_error("repair request iteration and attempt must be positive");
        }
        if self.reasons.is_empty() || self.reasons.iter().any(|reason| reason.trim().is_empty()) {
            return external_error("repair request requires non-empty failure reasons");
        }
        if let Some(action) = &self.action {
            validate_token("external repair action", action)?;
        }
        if self.updated_at < self.requested_at {
            return external_error("repair request timestamp moved backwards");
        }
        match self.status {
            ExternalRepairRequestStatus::Requested => {
                if self.action_result.is_some()
                    || self.result_head_sha.is_some()
                    || self.error.is_some()
                {
                    return external_error("requested repair work already has terminal evidence");
                }
            }
            ExternalRepairRequestStatus::Dispatched => {
                if self.action.is_none()
                    || self.action_result.is_none()
                    || self.result_head_sha.is_some()
                    || self.error.is_some()
                {
                    return external_error("dispatched repair work has inconsistent evidence");
                }
            }
            ExternalRepairRequestStatus::HeadChanged => {
                let result = self.result_head_sha.as_deref().ok_or_else(|| {
                    KoniError::Workflow(
                        "external loop: completed repair request has no result head".to_owned(),
                    )
                })?;
                validate_sha(result)?;
                if result == self.base_head_sha || self.error.is_some() {
                    return external_error("repair request result did not advance its base head");
                }
            }
            ExternalRepairRequestStatus::Failed => {
                if self.error.as_deref().is_none_or(str::is_empty) || self.result_head_sha.is_some()
                {
                    return external_error("failed repair request has inconsistent evidence");
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "status")]
pub enum ExternalRepairProgress {
    Pending { observed_head_sha: String },
    Completed { repair: ExternalRepairRecord },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExternalVerification {
    pub head_sha: String,
    pub passed: bool,
    #[serde(default)]
    pub reasons: Vec<String>,
    pub verified_at: DateTime<Utc>,
}

impl ExternalVerification {
    fn validate(&self) -> Result<()> {
        validate_sha(&self.head_sha)?;
        if !self.passed && self.reasons.iter().all(|reason| reason.trim().is_empty()) {
            return external_error("failed verification requires a reason");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExternalCollectionDecisionKind {
    Wait,
    Repair,
    Verify,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExternalCollectionDecision {
    pub kind: ExternalCollectionDecisionKind,
    #[serde(default)]
    pub reasons: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExternalLoopTransition {
    pub from: ExternalLoopPhase,
    pub to: ExternalLoopPhase,
    pub iteration: u32,
    pub at: DateTime<Utc>,
    pub reason: String,
    #[serde(default)]
    pub head_sha: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExternalLoopState {
    pub schema_version: String,
    pub id: String,
    pub config_hash: String,
    pub phase: ExternalLoopPhase,
    pub status: ExternalLoopStatus,
    pub iteration: u32,
    pub repair_attempts: u32,
    #[serde(default)]
    pub head_sha: Option<String>,
    #[serde(default)]
    pub publication: Option<GitHubPublication>,
    #[serde(default)]
    pub collection: Option<ExternalCollection>,
    #[serde(default)]
    pub repairs: Vec<ExternalRepairRecord>,
    #[serde(default)]
    pub verification: Option<ExternalVerification>,
    #[serde(default)]
    pub blocker: Option<String>,
    #[serde(default)]
    pub history: Vec<ExternalLoopTransition>,
    pub started_at: DateTime<Utc>,
    pub phase_started_at: DateTime<Utc>,
    pub deadline_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl ExternalLoopState {
    pub fn new(
        id: impl Into<String>,
        config: &ExternalLoopConfig,
        now: DateTime<Utc>,
    ) -> Result<Self> {
        config.validate()?;
        let state = Self {
            schema_version: EXTERNAL_LOOP_SCHEMA_VERSION.to_owned(),
            id: id.into(),
            config_hash: config.config_hash(),
            phase: ExternalLoopPhase::Prepare,
            status: ExternalLoopStatus::Active,
            iteration: 0,
            repair_attempts: 0,
            head_sha: None,
            publication: None,
            collection: None,
            repairs: Vec::new(),
            verification: None,
            blocker: None,
            history: Vec::new(),
            started_at: now,
            phase_started_at: now,
            deadline_at: add_seconds(now, config.timeouts.total_seconds)?,
            updated_at: now,
        };
        state.validate(config)?;
        Ok(state)
    }

    pub fn from_json(input: &str, config: &ExternalLoopConfig) -> Result<Self> {
        let state: Self = serde_json::from_str(input).map_err(|source| KoniError::Json {
            path: PathBuf::from("<external-loop-state>"),
            source,
        })?;
        state.validate(config)?;
        Ok(state)
    }

    pub fn from_yaml(input: &str, config: &ExternalLoopConfig) -> Result<Self> {
        let state: Self = serde_yaml::from_str(input).map_err(|source| KoniError::Yaml {
            path: PathBuf::from("<external-loop-state>"),
            source,
        })?;
        state.validate(config)?;
        Ok(state)
    }

    pub fn advance(
        &mut self,
        config: &ExternalLoopConfig,
        to: ExternalLoopPhase,
        reason: impl Into<String>,
        now: DateTime<Utc>,
    ) -> Result<()> {
        self.validate(config)?;
        self.require_monotonic_time(now)?;
        let reason = reason.into();
        if reason.trim().is_empty() {
            return external_error("external loop transition reason must not be empty");
        }
        if self.timeout_reason(config, now)?.is_some() && to != ExternalLoopPhase::Blocked {
            return external_error("external loop timed out and must transition to blocked");
        }
        if !allowed_transition(self.phase, to) {
            return external_error(format!(
                "external loop cannot transition from {:?} to {:?}",
                self.phase, to
            ));
        }
        self.validate_transition_evidence(config, to)?;
        if to == ExternalLoopPhase::Repair {
            if self.repair_attempts >= config.iterations.max_repairs_per_iteration {
                return external_error("repair-attempt policy is exhausted");
            }
            self.repair_attempts += 1;
        }
        if to == ExternalLoopPhase::Republish && self.iteration >= config.iterations.max_iterations
        {
            return external_error("external-loop iteration policy is exhausted");
        }
        let transition = ExternalLoopTransition {
            from: self.phase,
            to,
            iteration: self.iteration,
            at: now,
            reason: reason.clone(),
            head_sha: self.head_sha.clone(),
        };
        self.phase = to;
        self.status = status_for_phase(to);
        self.phase_started_at = now;
        self.updated_at = now;
        if to == ExternalLoopPhase::Blocked {
            self.blocker = Some(reason);
        }
        self.history.push(transition);
        self.validate(config)
    }

    pub fn record_publication(
        &mut self,
        config: &ExternalLoopConfig,
        publication: GitHubPublication,
    ) -> Result<()> {
        self.validate(config)?;
        if !matches!(
            self.phase,
            ExternalLoopPhase::Publish | ExternalLoopPhase::Republish
        ) {
            return external_error("publication can only be recorded while publishing");
        }
        publication.validate()?;
        if config
            .github
            .pull_request
            .is_some_and(|pull_request| publication.pull_request != pull_request)
        {
            return external_error("publication PR does not match configured pull request");
        }
        if publication.published_at < self.phase_started_at {
            return external_error("publication predates the current publish phase");
        }
        self.require_monotonic_time(publication.published_at)?;
        if self.iteration >= config.iterations.max_iterations {
            return external_error("external-loop iteration policy is exhausted");
        }
        if self.phase == ExternalLoopPhase::Republish
            && config.iterations.block_on_unchanged_head
            && self.head_sha.as_deref() == Some(publication.head_sha.as_str())
        {
            return external_error("republish did not advance the exact head SHA");
        }
        if self.phase == ExternalLoopPhase::Republish
            && self
                .repairs
                .last()
                .is_none_or(|repair| repair.result_head_sha != publication.head_sha)
        {
            return external_error("republished head does not match compiler-owned repair output");
        }
        self.iteration += 1;
        self.repair_attempts = 0;
        self.head_sha = Some(publication.head_sha.clone());
        self.publication = Some(publication.clone());
        self.collection = None;
        self.verification = None;
        self.updated_at = publication.published_at;
        self.validate(config)
    }

    pub fn record_collection(
        &mut self,
        config: &ExternalLoopConfig,
        collection: ExternalCollection,
    ) -> Result<()> {
        self.validate(config)?;
        if self.phase != ExternalLoopPhase::Collect {
            return external_error("external observations can only be recorded while collecting");
        }
        collection.validate()?;
        self.require_current_head(&collection.head_sha)?;
        if collection.collected_at < self.phase_started_at {
            return external_error("external collection predates the collect phase");
        }
        self.require_monotonic_time(collection.collected_at)?;
        if let Some(greptile) = &collection.greptile
            && greptile.collected_at > collection.collected_at
        {
            return external_error("Greptile observation postdates its collection envelope");
        }
        self.updated_at = collection.collected_at;
        self.collection = Some(collection);
        self.validate(config)
    }

    pub fn collection_decision(
        &self,
        config: &ExternalLoopConfig,
    ) -> Result<ExternalCollectionDecision> {
        self.validate(config)?;
        let collection = self.collection.as_ref().ok_or_else(|| {
            KoniError::Workflow("external loop: no collection is available".to_owned())
        })?;
        let ci = collection.checks.evaluate(&config.ci);
        let mut wait = ci.missing;
        wait.extend(ci.pending);
        let mut repair = ci.failing;
        if let Some(greptile_config) = &config.greptile {
            match &collection.greptile {
                None if greptile_config.required => {
                    wait.push(greptile_config.review_label.clone());
                }
                Some(observation)
                    if observation.confidence < greptile_config.minimum_confidence =>
                {
                    repair.push(format!(
                        "{} confidence {}/5 is below {}/5",
                        greptile_config.review_label,
                        observation.confidence,
                        greptile_config.minimum_confidence
                    ));
                }
                _ => {}
            }
        }
        if !repair.is_empty() {
            return Ok(ExternalCollectionDecision {
                kind: ExternalCollectionDecisionKind::Repair,
                reasons: repair,
            });
        }
        if !wait.is_empty() {
            return Ok(ExternalCollectionDecision {
                kind: ExternalCollectionDecisionKind::Wait,
                reasons: wait,
            });
        }
        Ok(ExternalCollectionDecision {
            kind: ExternalCollectionDecisionKind::Verify,
            reasons: Vec::new(),
        })
    }

    pub fn repair_reasons(&self, config: &ExternalLoopConfig) -> Result<Vec<String>> {
        self.validate(config)?;
        if self.phase != ExternalLoopPhase::Repair {
            return external_error("repair reasons require an active repair phase");
        }
        if let Some(verification) = &self.verification
            && !verification.passed
        {
            return Ok(verification.reasons.clone());
        }
        let decision = self.collection_decision(config)?;
        if decision.kind != ExternalCollectionDecisionKind::Repair {
            return external_error("collection does not contain repairable failures");
        }
        Ok(decision.reasons)
    }

    pub fn record_repair(
        &mut self,
        config: &ExternalLoopConfig,
        repair: ExternalRepairRecord,
    ) -> Result<()> {
        self.validate(config)?;
        if self.phase != ExternalLoopPhase::Repair {
            return external_error("repair output can only be recorded in repair phase");
        }
        repair.validate()?;
        self.require_current_head(&repair.base_head_sha)?;
        if repair.repaired_at < self.phase_started_at {
            return external_error("repair predates the current repair phase");
        }
        self.require_monotonic_time(repair.repaired_at)?;
        self.updated_at = repair.repaired_at;
        self.repairs.push(repair);
        self.validate(config)
    }

    pub fn record_verification(
        &mut self,
        config: &ExternalLoopConfig,
        verification: ExternalVerification,
    ) -> Result<()> {
        self.validate(config)?;
        if self.phase != ExternalLoopPhase::Verify {
            return external_error("verification can only be recorded in verify phase");
        }
        verification.validate()?;
        self.require_current_head(&verification.head_sha)?;
        if verification.verified_at < self.phase_started_at {
            return external_error("verification predates the verify phase");
        }
        self.require_monotonic_time(verification.verified_at)?;
        self.updated_at = verification.verified_at;
        self.verification = Some(verification);
        self.validate(config)
    }

    pub fn timeout_reason(
        &self,
        config: &ExternalLoopConfig,
        now: DateTime<Utc>,
    ) -> Result<Option<String>> {
        config.validate()?;
        if now >= self.deadline_at {
            return Ok(Some("external loop total timeout exceeded".to_owned()));
        }
        let Some(limit) = config.timeouts.phase_seconds(self.phase) else {
            return Ok(None);
        };
        if now >= add_seconds(self.phase_started_at, limit)? {
            return Ok(Some(format!(
                "external loop {:?} timeout exceeded",
                self.phase
            )));
        }
        Ok(None)
    }

    pub fn block_for_timeout(
        &mut self,
        config: &ExternalLoopConfig,
        now: DateTime<Utc>,
    ) -> Result<bool> {
        let Some(reason) = self.timeout_reason(config, now)? else {
            return Ok(false);
        };
        self.advance(config, ExternalLoopPhase::Blocked, reason, now)?;
        Ok(true)
    }

    pub fn validate(&self, config: &ExternalLoopConfig) -> Result<()> {
        config.validate()?;
        if self.schema_version != EXTERNAL_LOOP_SCHEMA_VERSION {
            return external_error(format!(
                "unsupported external state schema {}",
                self.schema_version
            ));
        }
        validate_token("external loop state", &self.id)?;
        validate_hash("external loop config", &self.config_hash)?;
        if self.config_hash != config.config_hash() {
            return external_error("external loop state is bound to a different config");
        }
        if self.iteration > config.iterations.max_iterations
            || self.repair_attempts > config.iterations.max_repairs_per_iteration
        {
            return external_error("external loop state exceeds iteration policy");
        }
        if self.updated_at < self.started_at
            || self.phase_started_at < self.started_at
            || self.updated_at < self.phase_started_at
        {
            return external_error("external loop timestamps are inconsistent");
        }
        if self.deadline_at != add_seconds(self.started_at, config.timeouts.total_seconds)? {
            return external_error("external loop total deadline is not config-bound");
        }
        if self.status != status_for_phase(self.phase) {
            return external_error("external loop status does not match its phase");
        }
        if self.phase == ExternalLoopPhase::Blocked
            && self
                .blocker
                .as_deref()
                .is_none_or(|reason| reason.trim().is_empty())
        {
            return external_error("blocked external loop has no reason");
        }
        if self.phase != ExternalLoopPhase::Blocked && self.blocker.is_some() {
            return external_error("active/complete external loop retains a blocker");
        }
        match (&self.head_sha, &self.publication) {
            (None, None) if self.iteration == 0 => {}
            (Some(head), Some(publication)) if self.iteration > 0 => {
                validate_sha(head)?;
                publication.validate()?;
                if publication.head_sha != *head {
                    return external_error("publication and state head SHA differ");
                }
                if config
                    .github
                    .pull_request
                    .is_some_and(|pull_request| publication.pull_request != pull_request)
                {
                    return external_error("publication PR does not match configured pull request");
                }
            }
            _ => return external_error("external loop publication state is incomplete"),
        }
        if let Some(collection) = &self.collection {
            collection.validate()?;
            self.require_current_head(&collection.head_sha)?;
        }
        for repair in &self.repairs {
            repair.validate()?;
        }
        if let Some(verification) = &self.verification {
            verification.validate()?;
            self.require_current_head(&verification.head_sha)?;
        }
        if self.phase == ExternalLoopPhase::Complete
            && self
                .verification
                .as_ref()
                .is_none_or(|verification| !verification.passed)
        {
            return external_error("complete external loop lacks passing verification");
        }
        self.validate_history()
    }

    fn validate_transition_evidence(
        &self,
        config: &ExternalLoopConfig,
        to: ExternalLoopPhase,
    ) -> Result<()> {
        if to == ExternalLoopPhase::Blocked {
            return Ok(());
        }
        match (self.phase, to) {
            (ExternalLoopPhase::Publish | ExternalLoopPhase::Republish, _)
                if self
                    .publication
                    .as_ref()
                    .is_none_or(|publication| publication.published_at < self.phase_started_at) =>
            {
                return external_error("publish phase has no current publication");
            }
            (ExternalLoopPhase::Collect, ExternalLoopPhase::Repair | ExternalLoopPhase::Verify)
                if self
                    .collection
                    .as_ref()
                    .is_none_or(|collection| collection.collected_at < self.phase_started_at) =>
            {
                return external_error("collect phase has no current collection");
            }
            (ExternalLoopPhase::Repair, ExternalLoopPhase::Republish)
                if self
                    .repairs
                    .last()
                    .is_none_or(|repair| repair.repaired_at < self.phase_started_at) =>
            {
                return external_error("repair phase has no current repair output");
            }
            (ExternalLoopPhase::Verify, ExternalLoopPhase::Complete)
                if self.verification.as_ref().is_none_or(|verification| {
                    verification.verified_at < self.phase_started_at || !verification.passed
                }) =>
            {
                return external_error("verify phase has no current passing result");
            }
            (ExternalLoopPhase::Verify, ExternalLoopPhase::Repair)
                if self.verification.as_ref().is_none_or(|verification| {
                    verification.verified_at < self.phase_started_at || verification.passed
                }) =>
            {
                return external_error("verify phase has no current failed result");
            }
            _ => {}
        }
        if to == ExternalLoopPhase::Repair
            && self.repair_attempts >= config.iterations.max_repairs_per_iteration
        {
            return external_error("repair-attempt policy is exhausted");
        }
        Ok(())
    }

    fn validate_history(&self) -> Result<()> {
        let mut phase = ExternalLoopPhase::Prepare;
        let mut previous = self.started_at;
        for transition in &self.history {
            if transition.from != phase
                || !allowed_transition(transition.from, transition.to)
                || transition.at < previous
                || transition.reason.trim().is_empty()
                || transition.iteration > self.iteration
            {
                return external_error("external loop transition history is malformed");
            }
            if let Some(head) = &transition.head_sha {
                validate_sha(head)?;
            }
            phase = transition.to;
            previous = transition.at;
        }
        if phase != self.phase {
            return external_error("external loop history does not reach current phase");
        }
        Ok(())
    }

    fn require_current_head(&self, head_sha: &str) -> Result<()> {
        validate_sha(head_sha)?;
        if self.head_sha.as_deref() != Some(head_sha) {
            return external_error(format!(
                "observation head {head_sha} does not match current published head {}",
                self.head_sha.as_deref().unwrap_or("<none>")
            ));
        }
        Ok(())
    }

    fn require_monotonic_time(&self, now: DateTime<Utc>) -> Result<()> {
        if now < self.updated_at {
            return external_error("external loop mutation timestamp moved backwards");
        }
        Ok(())
    }
}

pub fn allowed_transition(from: ExternalLoopPhase, to: ExternalLoopPhase) -> bool {
    if matches!(
        from,
        ExternalLoopPhase::Complete | ExternalLoopPhase::Blocked
    ) {
        return false;
    }
    if to == ExternalLoopPhase::Blocked {
        return true;
    }
    matches!(
        (from, to),
        (ExternalLoopPhase::Prepare, ExternalLoopPhase::Publish)
            | (ExternalLoopPhase::Publish, ExternalLoopPhase::Wait)
            | (ExternalLoopPhase::Wait, ExternalLoopPhase::Collect)
            | (ExternalLoopPhase::Collect, ExternalLoopPhase::Wait)
            | (ExternalLoopPhase::Collect, ExternalLoopPhase::Repair)
            | (ExternalLoopPhase::Collect, ExternalLoopPhase::Verify)
            | (ExternalLoopPhase::Repair, ExternalLoopPhase::Republish)
            | (ExternalLoopPhase::Republish, ExternalLoopPhase::Wait)
            | (ExternalLoopPhase::Republish, ExternalLoopPhase::Verify)
            | (ExternalLoopPhase::Verify, ExternalLoopPhase::Repair)
            | (ExternalLoopPhase::Verify, ExternalLoopPhase::Complete)
    )
}

fn status_for_phase(phase: ExternalLoopPhase) -> ExternalLoopStatus {
    match phase {
        ExternalLoopPhase::Wait => ExternalLoopStatus::Waiting,
        ExternalLoopPhase::Complete => ExternalLoopStatus::Complete,
        ExternalLoopPhase::Blocked => ExternalLoopStatus::Blocked,
        _ => ExternalLoopStatus::Active,
    }
}

/// A low-level injectable argv adapter for GitHub or other external commands.
pub trait ExternalCommandAdapter {
    type Error;

    fn execute(
        &mut self,
        request: &ExternalCommandRequest,
    ) -> std::result::Result<ExternalCommandOutput, Self::Error>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExternalCommandRequest {
    pub id: String,
    pub argv: Vec<String>,
    pub cwd: PathBuf,
    pub environment: BTreeMap<String, String>,
    pub timeout_seconds: u64,
}

impl ExternalCommandRequest {
    pub fn validate(&self) -> Result<()> {
        validate_token("external command", &self.id)?;
        if self.argv.is_empty() || self.argv[0].trim().is_empty() {
            return external_error("external command argv must not be empty");
        }
        if self.argv.iter().any(|argument| argument.contains('\0')) {
            return external_error("external command argv contains a NUL byte");
        }
        if self.environment.iter().any(|(key, value)| {
            key.is_empty() || key.contains('=') || key.contains('\0') || value.contains('\0')
        }) {
            return external_error("external command environment contains an invalid key or value");
        }
        if self.cwd.as_os_str().is_empty() || self.timeout_seconds == 0 {
            return external_error("external command cwd and timeout must be set");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExternalCommandOutput {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// A higher-level injectable provider contract aligned with loop phases.
pub trait ExternalLoopAdapter {
    type Error;

    fn prepare(
        &mut self,
        config: &ExternalLoopConfig,
        state: &ExternalLoopState,
    ) -> std::result::Result<Value, Self::Error>;

    fn publish(
        &mut self,
        config: &ExternalLoopConfig,
        state: &ExternalLoopState,
    ) -> std::result::Result<GitHubPublication, Self::Error>;

    fn poll(
        &mut self,
        config: &ExternalLoopConfig,
        state: &ExternalLoopState,
    ) -> std::result::Result<bool, Self::Error>;

    fn collect(
        &mut self,
        config: &ExternalLoopConfig,
        state: &ExternalLoopState,
    ) -> std::result::Result<ExternalCollection, Self::Error>;

    fn repair(
        &mut self,
        config: &ExternalLoopConfig,
        state: &ExternalLoopState,
    ) -> std::result::Result<ExternalRepairProgress, Self::Error>;

    fn verify(
        &mut self,
        config: &ExternalLoopConfig,
        state: &ExternalLoopState,
    ) -> std::result::Result<ExternalVerification, Self::Error>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExternalDriveOutcome {
    Advanced(ExternalLoopPhase),
    Waiting,
    Complete,
    Blocked,
}

/// Execute at most one durable phase transition. Callers persist `state`
/// after every return and schedule another invocation after the configured
/// poll interval, making the loop restart-safe without foreground sleeps.
pub fn drive_external_loop_once<A>(
    config: &ExternalLoopConfig,
    state: &mut ExternalLoopState,
    adapter: &mut A,
    now: DateTime<Utc>,
) -> Result<ExternalDriveOutcome>
where
    A: ExternalLoopAdapter,
    A::Error: std::fmt::Display,
{
    if let Some(reason) = state.timeout_reason(config, now)? {
        state.advance(config, ExternalLoopPhase::Blocked, reason, now)?;
        return Ok(ExternalDriveOutcome::Blocked);
    }
    let adapter_error = |phase: ExternalLoopPhase, error: A::Error| {
        KoniError::Workflow(format!("external loop {phase:?} adapter failed: {error}"))
    };
    match state.phase {
        ExternalLoopPhase::Prepare => {
            let _ = adapter
                .prepare(config, state)
                .map_err(|error| adapter_error(state.phase, error))?;
            state.advance(
                config,
                ExternalLoopPhase::Publish,
                "provider preparation passed",
                now,
            )?;
            Ok(ExternalDriveOutcome::Advanced(state.phase))
        }
        ExternalLoopPhase::Publish | ExternalLoopPhase::Republish => {
            let publication = adapter
                .publish(config, state)
                .map_err(|error| adapter_error(state.phase, error))?;
            let transition_at = publication.published_at;
            state.record_publication(config, publication)?;
            state.advance(
                config,
                ExternalLoopPhase::Wait,
                "published exact head; awaiting checks and review",
                transition_at,
            )?;
            Ok(ExternalDriveOutcome::Advanced(state.phase))
        }
        ExternalLoopPhase::Wait => {
            let ready = adapter
                .poll(config, state)
                .map_err(|error| adapter_error(state.phase, error))?;
            if !ready {
                return Ok(ExternalDriveOutcome::Waiting);
            }
            state.advance(
                config,
                ExternalLoopPhase::Collect,
                "provider observations are ready",
                now,
            )?;
            Ok(ExternalDriveOutcome::Advanced(state.phase))
        }
        ExternalLoopPhase::Collect => {
            let collection = adapter
                .collect(config, state)
                .map_err(|error| adapter_error(state.phase, error))?;
            let transition_at = collection.collected_at;
            state.record_collection(config, collection)?;
            let decision = state.collection_decision(config)?;
            let next = match decision.kind {
                ExternalCollectionDecisionKind::Wait => ExternalLoopPhase::Wait,
                ExternalCollectionDecisionKind::Repair => ExternalLoopPhase::Repair,
                ExternalCollectionDecisionKind::Verify => ExternalLoopPhase::Verify,
            };
            state.advance(
                config,
                next,
                if decision.reasons.is_empty() {
                    "collection satisfied configured predicates".to_owned()
                } else {
                    decision.reasons.join("; ")
                },
                transition_at,
            )?;
            Ok(ExternalDriveOutcome::Advanced(state.phase))
        }
        ExternalLoopPhase::Repair => {
            let progress = adapter
                .repair(config, state)
                .map_err(|error| adapter_error(state.phase, error))?;
            let repair = match progress {
                ExternalRepairProgress::Pending { observed_head_sha } => {
                    state.require_current_head(&observed_head_sha)?;
                    return Ok(ExternalDriveOutcome::Waiting);
                }
                ExternalRepairProgress::Completed { repair } => repair,
            };
            let transition_at = repair.repaired_at;
            state.record_repair(config, repair)?;
            state.advance(
                config,
                ExternalLoopPhase::Republish,
                "compiler-owned repair completed",
                transition_at,
            )?;
            Ok(ExternalDriveOutcome::Advanced(state.phase))
        }
        ExternalLoopPhase::Verify => {
            let verification = adapter
                .verify(config, state)
                .map_err(|error| adapter_error(state.phase, error))?;
            let passed = verification.passed;
            let reasons = verification.reasons.clone();
            let transition_at = verification.verified_at;
            state.record_verification(config, verification)?;
            state.advance(
                config,
                if passed {
                    ExternalLoopPhase::Complete
                } else {
                    ExternalLoopPhase::Repair
                },
                if reasons.is_empty() {
                    "all configured external predicates passed".to_owned()
                } else {
                    reasons.join("; ")
                },
                transition_at,
            )?;
            Ok(if passed {
                ExternalDriveOutcome::Complete
            } else {
                ExternalDriveOutcome::Advanced(state.phase)
            })
        }
        ExternalLoopPhase::Complete => Ok(ExternalDriveOutcome::Complete),
        ExternalLoopPhase::Blocked => Ok(ExternalDriveOutcome::Blocked),
    }
}

fn seconds(value: u64) -> Result<Duration> {
    let value = i64::try_from(value)
        .map_err(|_| KoniError::Workflow("external loop: timeout is too large".to_owned()))?;
    Ok(Duration::seconds(value))
}

fn add_seconds(at: DateTime<Utc>, value: u64) -> Result<DateTime<Utc>> {
    at.checked_add_signed(seconds(value)?).ok_or_else(|| {
        KoniError::Workflow("external loop: timeout deadline is out of range".to_owned())
    })
}

fn validate_token(label: &str, value: &str) -> Result<()> {
    if value.trim().is_empty()
        || value
            .chars()
            .any(|character| character.is_whitespace() || character == '\\')
    {
        return external_error(format!("invalid {label} value {value:?}"));
    }
    Ok(())
}

fn validate_sha(value: &str) -> Result<()> {
    if !matches!(value.len(), 40 | 64)
        || !value.bytes().all(|byte| byte.is_ascii_hexdigit())
        || value.bytes().any(|byte| byte.is_ascii_uppercase())
    {
        return external_error(format!("invalid normalized head SHA {value:?}"));
    }
    Ok(())
}

fn validate_hash(label: &str, value: &str) -> Result<()> {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return external_error(format!("{label} hash is not sha256"));
    };
    if hex.len() != 64 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return external_error(format!("{label} hash is malformed"));
    }
    Ok(())
}

fn external_error<T>(message: impl Into<String>) -> Result<T> {
    Err(KoniError::Workflow(format!(
        "external loop: {}",
        message.into()
    )))
}

#[cfg(test)]
mod tests {
    use chrono::{TimeZone, Utc};
    use serde_json::json;

    use super::*;

    const SHA_1: &str = "1111111111111111111111111111111111111111";
    const SHA_2: &str = "2222222222222222222222222222222222222222";
    const SHA_3: &str = "3333333333333333333333333333333333333333";

    fn at(second: i64) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 7, 10, 12, 0, 0).unwrap() + Duration::seconds(second)
    }

    fn config() -> ExternalLoopConfig {
        ExternalLoopConfig {
            schema_version: EXTERNAL_LOOP_SCHEMA_VERSION.to_owned(),
            id: "github-review".to_owned(),
            github: GitHubLoopConfig {
                repository: "owner/repo".to_owned(),
                remote: "origin".to_owned(),
                base_branch: "main".to_owned(),
                pull_request: Some(42),
                draft: false,
            },
            ci: CiLoopConfig {
                required_checks: BTreeSet::from(["lint".to_owned(), "test".to_owned()]),
                allow_skipped: false,
            },
            greptile: Some(GreptileLoopConfig {
                required: true,
                minimum_confidence: 4,
                review_label: "greptile".to_owned(),
                bot_login: "greptile-apps[bot]".to_owned(),
                trigger_comment: "@greptileai".to_owned(),
            }),
            repair: ExternalRepairConfig::default(),
            iterations: ExternalLoopIterationPolicy {
                max_iterations: 3,
                max_repairs_per_iteration: 2,
                block_on_unchanged_head: true,
            },
            timeouts: ExternalLoopTimeoutPolicy {
                total_seconds: 600,
                prepare_seconds: 30,
                publish_seconds: 30,
                wait_seconds: 120,
                collect_seconds: 30,
                repair_seconds: 120,
                verify_seconds: 30,
                poll_interval_seconds: 10,
            },
        }
    }

    fn checks(test_bucket: &str) -> GhCheckBuckets {
        parse_gh_check_buckets(&format!(
            r#"[
                {{"name":"lint","bucket":"pass","state":"SUCCESS"}},
                {{"name":"test","bucket":"{test_bucket}","state":"COMPLETED"}}
            ]"#
        ))
        .unwrap()
    }

    #[test]
    fn exact_head_parser_rejects_labels_and_normalizes_hex_case() {
        assert_eq!(
            parse_exact_head_sha(&SHA_1.to_ascii_uppercase()).unwrap(),
            SHA_1
        );
        assert!(parse_exact_head_sha(&format!("head: {SHA_1}")).is_err());
        assert!(parse_exact_head_sha(&format!("{SHA_1}\n{SHA_2}")).is_err());
    }

    #[test]
    fn gh_buckets_and_greptile_score_are_strictly_parsed() {
        let parsed = checks("pending");
        let evaluation = parsed.evaluate(&config().ci);
        assert_eq!(evaluation.disposition, CiDisposition::Pending);
        assert_eq!(evaluation.pending, vec!["test"]);
        assert_eq!(
            parse_greptile_confidence("## Review\nConfidence Score: 4/5").unwrap(),
            4
        );
        assert!(parse_greptile_confidence("Confidence Score: 6/5").is_err());
        assert!(parse_greptile_confidence("Confidence Score: 4/5\nConfidence Score: 5/5").is_err());
        assert!(parse_gh_check_buckets(r#"[{"name":"test","bucket":"mystery"}]"#).is_err());
        assert!(
            parse_gh_check_buckets(r#"[{"name":"test","bucket":"pass","unexpected":true}]"#)
                .is_err()
        );
    }

    #[test]
    fn state_machine_repairs_republishes_verifies_and_completes() {
        let config = config();
        let mut state = ExternalLoopState::new("loop-1", &config, at(0)).unwrap();
        state
            .advance(&config, ExternalLoopPhase::Publish, "prepared", at(1))
            .unwrap();
        state
            .record_publication(
                &config,
                GitHubPublication {
                    head_sha: SHA_1.to_owned(),
                    pull_request: 42,
                    url: "https://github.example/owner/repo/pull/42".to_owned(),
                    published_at: at(2),
                },
            )
            .unwrap();
        state
            .advance(&config, ExternalLoopPhase::Wait, "published", at(3))
            .unwrap();
        state
            .advance(&config, ExternalLoopPhase::Collect, "checks ready", at(4))
            .unwrap();
        state
            .record_collection(
                &config,
                ExternalCollection {
                    head_sha: SHA_1.to_owned(),
                    checks: checks("fail"),
                    greptile: Some(
                        GreptileObservation::from_body(SHA_1, "Confidence Score: 3/5", at(5))
                            .unwrap(),
                    ),
                    collected_at: at(5),
                },
            )
            .unwrap();
        assert_eq!(
            state.collection_decision(&config).unwrap().kind,
            ExternalCollectionDecisionKind::Repair
        );
        state
            .advance(&config, ExternalLoopPhase::Repair, "checks failed", at(6))
            .unwrap();
        state
            .record_repair(
                &config,
                ExternalRepairRecord {
                    base_head_sha: SHA_1.to_owned(),
                    result_head_sha: SHA_2.to_owned(),
                    change_hash: normalized_hash(&json!({"patch": 1})),
                    summary: "Fix the failing test".to_owned(),
                    repaired_at: at(7),
                },
            )
            .unwrap();
        state
            .advance(&config, ExternalLoopPhase::Republish, "repair ready", at(8))
            .unwrap();
        assert!(
            state
                .record_publication(
                    &config,
                    GitHubPublication {
                        head_sha: SHA_3.to_owned(),
                        pull_request: 42,
                        url: "https://github.example/owner/repo/pull/42".to_owned(),
                        published_at: at(9),
                    },
                )
                .is_err()
        );
        state
            .record_publication(
                &config,
                GitHubPublication {
                    head_sha: SHA_2.to_owned(),
                    pull_request: 42,
                    url: "https://github.example/owner/repo/pull/42".to_owned(),
                    published_at: at(9),
                },
            )
            .unwrap();
        state
            .advance(&config, ExternalLoopPhase::Verify, "republished", at(10))
            .unwrap();
        state
            .record_verification(
                &config,
                ExternalVerification {
                    head_sha: SHA_2.to_owned(),
                    passed: true,
                    reasons: Vec::new(),
                    verified_at: at(11),
                },
            )
            .unwrap();
        state
            .advance(&config, ExternalLoopPhase::Complete, "verified", at(12))
            .unwrap();
        assert_eq!(state.status, ExternalLoopStatus::Complete);
        assert_eq!(state.iteration, 2);
        ExternalLoopState::from_json(&serde_json::to_string(&state).unwrap(), &config).unwrap();
        ExternalLoopState::from_yaml(&serde_yaml::to_string(&state).unwrap(), &config).unwrap();
    }

    #[test]
    fn durable_repair_waits_for_changed_head_then_restarts_exact_sha_evidence() {
        struct FakeAdapter {
            repair_calls: usize,
        }

        impl ExternalLoopAdapter for FakeAdapter {
            type Error = &'static str;

            fn prepare(
                &mut self,
                _config: &ExternalLoopConfig,
                _state: &ExternalLoopState,
            ) -> std::result::Result<Value, Self::Error> {
                Ok(Value::Null)
            }

            fn publish(
                &mut self,
                _config: &ExternalLoopConfig,
                _state: &ExternalLoopState,
            ) -> std::result::Result<GitHubPublication, Self::Error> {
                Ok(GitHubPublication {
                    head_sha: SHA_2.to_owned(),
                    pull_request: 42,
                    url: "https://example.test/pr/42".to_owned(),
                    published_at: at(9),
                })
            }

            fn poll(
                &mut self,
                _config: &ExternalLoopConfig,
                _state: &ExternalLoopState,
            ) -> std::result::Result<bool, Self::Error> {
                Ok(true)
            }

            fn collect(
                &mut self,
                _config: &ExternalLoopConfig,
                _state: &ExternalLoopState,
            ) -> std::result::Result<ExternalCollection, Self::Error> {
                Ok(ExternalCollection {
                    head_sha: SHA_2.to_owned(),
                    checks: checks("pass"),
                    greptile: Some(
                        GreptileObservation::from_body(SHA_2, "Confidence Score: 5/5", at(11))
                            .unwrap(),
                    ),
                    collected_at: at(11),
                })
            }

            fn repair(
                &mut self,
                _config: &ExternalLoopConfig,
                _state: &ExternalLoopState,
            ) -> std::result::Result<ExternalRepairProgress, Self::Error> {
                self.repair_calls += 1;
                if self.repair_calls == 1 {
                    return Ok(ExternalRepairProgress::Pending {
                        observed_head_sha: SHA_1.to_owned(),
                    });
                }
                Ok(ExternalRepairProgress::Completed {
                    repair: ExternalRepairRecord {
                        base_head_sha: SHA_1.to_owned(),
                        result_head_sha: SHA_2.to_owned(),
                        change_hash: normalized_hash(&(SHA_1, SHA_2)),
                        summary: "repair committed".to_owned(),
                        repaired_at: at(8),
                    },
                })
            }

            fn verify(
                &mut self,
                _config: &ExternalLoopConfig,
                state: &ExternalLoopState,
            ) -> std::result::Result<ExternalVerification, Self::Error> {
                Ok(ExternalVerification {
                    head_sha: state.head_sha.clone().unwrap(),
                    passed: true,
                    reasons: Vec::new(),
                    verified_at: at(12),
                })
            }
        }

        let mut config = config();
        config.repair.action = Some("repair-external".to_owned());
        let mut state = ExternalLoopState::new("repair-loop", &config, at(0)).unwrap();
        state
            .advance(&config, ExternalLoopPhase::Publish, "prepared", at(1))
            .unwrap();
        state
            .record_publication(
                &config,
                GitHubPublication {
                    head_sha: SHA_1.to_owned(),
                    pull_request: 42,
                    url: "https://example.test/pr/42".to_owned(),
                    published_at: at(2),
                },
            )
            .unwrap();
        state
            .advance(&config, ExternalLoopPhase::Wait, "published", at(3))
            .unwrap();
        state
            .advance(&config, ExternalLoopPhase::Collect, "ready", at(4))
            .unwrap();
        state
            .record_collection(
                &config,
                ExternalCollection {
                    head_sha: SHA_1.to_owned(),
                    checks: checks("fail"),
                    greptile: Some(
                        GreptileObservation::from_body(SHA_1, "Confidence Score: 3/5", at(5))
                            .unwrap(),
                    ),
                    collected_at: at(5),
                },
            )
            .unwrap();
        state
            .advance(
                &config,
                ExternalLoopPhase::Repair,
                "external predicates failed",
                at(6),
            )
            .unwrap();

        let request = ExternalRepairRequest::from_state("run-1", &config, &state, at(7)).unwrap();
        let same_request =
            ExternalRepairRequest::from_state("run-1", &config, &state, at(8)).unwrap();
        assert_eq!(request.id, same_request.id);
        assert_eq!(request.action.as_deref(), Some("repair-external"));
        assert!(request.reasons.iter().any(|reason| reason.contains("test")));
        assert!(
            request
                .reasons
                .iter()
                .any(|reason| reason.contains("confidence"))
        );

        let mut adapter = FakeAdapter { repair_calls: 0 };
        assert_eq!(
            drive_external_loop_once(&config, &mut state, &mut adapter, at(7)).unwrap(),
            ExternalDriveOutcome::Waiting
        );
        assert_eq!(state.phase, ExternalLoopPhase::Repair);
        assert!(state.repairs.is_empty());

        assert_eq!(
            drive_external_loop_once(&config, &mut state, &mut adapter, at(8)).unwrap(),
            ExternalDriveOutcome::Advanced(ExternalLoopPhase::Republish)
        );
        assert_eq!(state.repairs[0].result_head_sha, SHA_2);
        assert_eq!(
            drive_external_loop_once(&config, &mut state, &mut adapter, at(9)).unwrap(),
            ExternalDriveOutcome::Advanced(ExternalLoopPhase::Wait)
        );
        assert_eq!(state.head_sha.as_deref(), Some(SHA_2));
        assert!(state.collection.is_none());

        assert_eq!(
            drive_external_loop_once(&config, &mut state, &mut adapter, at(10)).unwrap(),
            ExternalDriveOutcome::Advanced(ExternalLoopPhase::Collect)
        );
        assert_eq!(
            drive_external_loop_once(&config, &mut state, &mut adapter, at(11)).unwrap(),
            ExternalDriveOutcome::Advanced(ExternalLoopPhase::Verify)
        );
        assert_eq!(state.collection.as_ref().unwrap().head_sha, SHA_2);
        assert_eq!(
            drive_external_loop_once(&config, &mut state, &mut adapter, at(12)).unwrap(),
            ExternalDriveOutcome::Complete
        );
        assert_eq!(state.verification.as_ref().unwrap().head_sha, SHA_2);
    }

    #[test]
    fn stale_heads_iteration_limits_timeouts_and_unknown_fields_fail_closed() {
        let config = config();
        let mut state = ExternalLoopState::new("loop-1", &config, at(0)).unwrap();
        state
            .advance(&config, ExternalLoopPhase::Publish, "prepared", at(1))
            .unwrap();
        state
            .record_publication(
                &config,
                GitHubPublication {
                    head_sha: SHA_1.to_owned(),
                    pull_request: 42,
                    url: "https://example.test/pr/42".to_owned(),
                    published_at: at(2),
                },
            )
            .unwrap();
        state
            .advance(&config, ExternalLoopPhase::Wait, "published", at(3))
            .unwrap();
        state
            .advance(&config, ExternalLoopPhase::Collect, "ready", at(4))
            .unwrap();
        assert!(
            state
                .record_collection(
                    &config,
                    ExternalCollection {
                        head_sha: SHA_2.to_owned(),
                        checks: checks("pass"),
                        greptile: None,
                        collected_at: at(5),
                    },
                )
                .is_err()
        );

        let mut timed_out = ExternalLoopState::new("loop-2", &config, at(0)).unwrap();
        assert!(timed_out.block_for_timeout(&config, at(31)).unwrap());
        assert_eq!(timed_out.phase, ExternalLoopPhase::Blocked);

        let mut malformed = serde_json::to_value(&timed_out).unwrap();
        malformed["unknown"] = json!(true);
        assert!(ExternalLoopState::from_json(&malformed.to_string(), &config).is_err());

        let malformed_config = format!(
            "{}\nunexpected: true\n",
            serde_yaml::to_string(&config).unwrap()
        );
        assert!(ExternalLoopConfig::from_yaml(&malformed_config).is_err());
    }

    #[test]
    fn iteration_policy_blocks_republish_after_the_last_allowed_head() {
        let mut config = config();
        config.iterations.max_iterations = 1;
        let mut state = ExternalLoopState::new("loop-limited", &config, at(0)).unwrap();
        state
            .advance(&config, ExternalLoopPhase::Publish, "prepared", at(1))
            .unwrap();
        state
            .record_publication(
                &config,
                GitHubPublication {
                    head_sha: SHA_1.to_owned(),
                    pull_request: 42,
                    url: "https://example.test/pr/42".to_owned(),
                    published_at: at(2),
                },
            )
            .unwrap();
        state
            .advance(&config, ExternalLoopPhase::Wait, "published", at(3))
            .unwrap();
        state
            .advance(&config, ExternalLoopPhase::Collect, "ready", at(4))
            .unwrap();
        state
            .record_collection(
                &config,
                ExternalCollection {
                    head_sha: SHA_1.to_owned(),
                    checks: checks("fail"),
                    greptile: None,
                    collected_at: at(5),
                },
            )
            .unwrap();
        state
            .advance(&config, ExternalLoopPhase::Repair, "failed", at(6))
            .unwrap();
        state
            .record_repair(
                &config,
                ExternalRepairRecord {
                    base_head_sha: SHA_1.to_owned(),
                    result_head_sha: SHA_2.to_owned(),
                    change_hash: normalized_hash(&"patch"),
                    summary: "repair".to_owned(),
                    repaired_at: at(7),
                },
            )
            .unwrap();
        assert!(
            state
                .advance(&config, ExternalLoopPhase::Republish, "repair ready", at(8),)
                .is_err()
        );
    }

    #[test]
    fn command_adapter_contract_is_injectable() {
        struct Fake;
        impl ExternalCommandAdapter for Fake {
            type Error = ();

            fn execute(
                &mut self,
                request: &ExternalCommandRequest,
            ) -> std::result::Result<ExternalCommandOutput, Self::Error> {
                Ok(ExternalCommandOutput {
                    exit_code: 0,
                    stdout: request.argv.join(" "),
                    stderr: String::new(),
                })
            }
        }

        let mut fake = Fake;
        let request = ExternalCommandRequest {
            id: "head".to_owned(),
            argv: vec!["git".to_owned(), "rev-parse".to_owned(), "HEAD".to_owned()],
            cwd: PathBuf::from("/tmp/project"),
            environment: BTreeMap::new(),
            timeout_seconds: 10,
        };
        request.validate().unwrap();
        let output = fake.execute(&request).unwrap();
        assert_eq!(output.stdout, "git rev-parse HEAD");

        let mut invalid = request.clone();
        invalid
            .environment
            .insert("INVALID=KEY".to_owned(), "value".to_owned());
        assert!(invalid.validate().is_err());

        let mut invalid = request;
        invalid
            .environment
            .insert("TOKEN".to_owned(), "bad\0value".to_owned());
        assert!(invalid.validate().is_err());
    }
}
