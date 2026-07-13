//! Concrete `gh`/Git adapter for provider-neutral external review loops.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use chrono::Utc;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::error::{KoniError, Result};
use crate::external_loop::{
    ExternalCollection, ExternalCollectionDecisionKind, ExternalCommandAdapter,
    ExternalCommandOutput, ExternalCommandRequest, ExternalLoopAdapter, ExternalLoopConfig,
    ExternalLoopState, ExternalRepairProgress, ExternalRepairRecord, ExternalVerification,
    GitHubPublication, GreptileObservation, parse_exact_head_sha, parse_gh_check_buckets,
};
use crate::graph::normalized_hash;
use crate::process::{CommandRunner, CommandSpec, EnvironmentPolicy};

#[derive(Debug, Default)]
pub struct StdExternalCommandAdapter;

impl ExternalCommandAdapter for StdExternalCommandAdapter {
    type Error = KoniError;

    fn execute(
        &mut self,
        request: &ExternalCommandRequest,
    ) -> std::result::Result<ExternalCommandOutput, Self::Error> {
        request.validate()?;
        let receipt = CommandRunner::new(request.cwd.clone()).run(
            &CommandSpec {
                id: request.id.clone(),
                argv: request.argv.clone(),
                cwd: ".".to_owned(),
                timeout_seconds: request.timeout_seconds,
                environment: EnvironmentPolicy {
                    inherit: true,
                    set: request.environment.clone(),
                    ..EnvironmentPolicy::default()
                },
                expected_exit_codes: BTreeSet::from([0]),
                transient_exit_codes: BTreeSet::new(),
                max_attempts: 1,
                result_protocol: None,
                artifact_paths: Vec::new(),
            },
            &BTreeMap::new(),
            None,
        )?;
        let attempt = receipt
            .attempts
            .last()
            .ok_or_else(|| KoniError::Process("external command produced no attempt".to_owned()))?;
        Ok(ExternalCommandOutput {
            exit_code: attempt.exit_code.unwrap_or(-1),
            stdout: attempt.stdout.clone(),
            stderr: attempt.stderr.clone(),
        })
    }
}

#[derive(Debug)]
pub struct GhCliExternalLoopAdapter<C = StdExternalCommandAdapter> {
    pub cwd: PathBuf,
    pub head_branch: String,
    pub title: String,
    pub body: String,
    pub command: C,
}

impl GhCliExternalLoopAdapter<StdExternalCommandAdapter> {
    pub fn new(
        cwd: PathBuf,
        head_branch: impl Into<String>,
        title: impl Into<String>,
        body: impl Into<String>,
    ) -> Self {
        Self {
            cwd,
            head_branch: head_branch.into(),
            title: title.into(),
            body: body.into(),
            command: StdExternalCommandAdapter,
        }
    }
}

impl<C> GhCliExternalLoopAdapter<C>
where
    C: ExternalCommandAdapter,
    C::Error: std::fmt::Display,
{
    fn run(&mut self, id: &str, argv: Vec<String>, timeout_seconds: u64) -> Result<String> {
        self.run_with_codes(id, argv, timeout_seconds, &[0])
    }

    fn run_with_codes(
        &mut self,
        id: &str,
        argv: Vec<String>,
        timeout_seconds: u64,
        accepted: &[i32],
    ) -> Result<String> {
        let output = self
            .command
            .execute(&ExternalCommandRequest {
                id: id.to_owned(),
                argv,
                cwd: self.cwd.clone(),
                environment: BTreeMap::new(),
                timeout_seconds,
            })
            .map_err(|error| KoniError::Process(error.to_string()))?;
        if !accepted.contains(&output.exit_code) {
            return Err(KoniError::Process(format!(
                "external command {id} exited {}: {}",
                output.exit_code,
                output.stderr.trim()
            )));
        }
        Ok(output.stdout)
    }

    fn head_sha(&mut self, timeout: u64) -> Result<String> {
        let output = self.run(
            "git-head",
            vec!["git".to_owned(), "rev-parse".to_owned(), "HEAD".to_owned()],
            timeout,
        )?;
        parse_exact_head_sha(&output)
    }

    fn pull_request_number(
        &self,
        config: &ExternalLoopConfig,
        state: &ExternalLoopState,
    ) -> Option<u64> {
        state
            .publication
            .as_ref()
            .map(|publication| publication.pull_request)
            .or(config.github.pull_request)
    }

    fn pr_view(&mut self, config: &ExternalLoopConfig, selector: &str) -> Result<RawPrView> {
        let output = self.run(
            "gh-pr-view",
            vec![
                "gh".to_owned(),
                "pr".to_owned(),
                "view".to_owned(),
                selector.to_owned(),
                "--repo".to_owned(),
                config.github.repository.clone(),
                "--json".to_owned(),
                "number,url,headRefOid".to_owned(),
            ],
            config.timeouts.publish_seconds,
        )?;
        serde_json::from_str(&output).map_err(|source| KoniError::Json {
            path: PathBuf::from("<gh-pr-view>"),
            source,
        })
    }

    fn checks(
        &mut self,
        config: &ExternalLoopConfig,
        pull_request: u64,
    ) -> Result<crate::external_loop::GhCheckBuckets> {
        let output = self.run_with_codes(
            "gh-pr-checks",
            vec![
                "gh".to_owned(),
                "pr".to_owned(),
                "checks".to_owned(),
                pull_request.to_string(),
                "--repo".to_owned(),
                config.github.repository.clone(),
                "--json".to_owned(),
                "name,bucket,state,link,workflow".to_owned(),
            ],
            config.timeouts.collect_seconds,
            &[0, 1, 8],
        )?;
        parse_gh_check_buckets(&output)
    }

    fn greptile_body(
        &mut self,
        config: &ExternalLoopConfig,
        pull_request: u64,
    ) -> Result<Option<String>> {
        let Some(greptile) = &config.greptile else {
            return Ok(None);
        };
        let endpoint = format!(
            "repos/{}/issues/{pull_request}/comments",
            config.github.repository
        );
        let output = self.run(
            "gh-greptile-comments",
            vec!["gh".to_owned(), "api".to_owned(), endpoint],
            config.timeouts.collect_seconds,
        )?;
        let comments: Vec<RawIssueComment> =
            serde_json::from_str(&output).map_err(|source| KoniError::Json {
                path: PathBuf::from("<gh-issue-comments>"),
                source,
            })?;
        Ok(comments
            .into_iter()
            .rev()
            .find(|comment| {
                comment.user.login == greptile.bot_login
                    && comment
                        .body
                        .to_ascii_lowercase()
                        .contains("confidence score")
            })
            .map(|comment| comment.body))
    }

    fn trigger_greptile(&mut self, config: &ExternalLoopConfig, pull_request: u64) -> Result<()> {
        let Some(greptile) = &config.greptile else {
            return Ok(());
        };
        self.run(
            "gh-greptile-trigger",
            vec![
                "gh".to_owned(),
                "pr".to_owned(),
                "comment".to_owned(),
                pull_request.to_string(),
                "--repo".to_owned(),
                config.github.repository.clone(),
                "--body".to_owned(),
                greptile.trigger_comment.clone(),
            ],
            config.timeouts.publish_seconds,
        )?;
        Ok(())
    }
}

impl<C> ExternalLoopAdapter for GhCliExternalLoopAdapter<C>
where
    C: ExternalCommandAdapter,
    C::Error: std::fmt::Display,
{
    type Error = KoniError;

    fn prepare(
        &mut self,
        config: &ExternalLoopConfig,
        _state: &ExternalLoopState,
    ) -> std::result::Result<Value, Self::Error> {
        config.validate()?;
        self.run(
            "gh-auth",
            vec!["gh".to_owned(), "auth".to_owned(), "status".to_owned()],
            config.timeouts.prepare_seconds,
        )?;
        Ok(json!({
            "head_sha": self.head_sha(config.timeouts.prepare_seconds)?,
            "repository": config.github.repository,
        }))
    }

    fn publish(
        &mut self,
        config: &ExternalLoopConfig,
        state: &ExternalLoopState,
    ) -> std::result::Result<GitHubPublication, Self::Error> {
        let local_head = self.head_sha(config.timeouts.publish_seconds)?;
        self.run(
            "git-push-run",
            vec![
                "git".to_owned(),
                "push".to_owned(),
                "--set-upstream".to_owned(),
                config.github.remote.clone(),
                format!("HEAD:refs/heads/{}", self.head_branch),
            ],
            config.timeouts.publish_seconds,
        )?;
        let view = if let Some(number) = self.pull_request_number(config, state) {
            self.pr_view(config, &number.to_string())?
        } else {
            let mut argv = vec![
                "gh".to_owned(),
                "pr".to_owned(),
                "create".to_owned(),
                "--repo".to_owned(),
                config.github.repository.clone(),
                "--base".to_owned(),
                config.github.base_branch.clone(),
                "--head".to_owned(),
                self.head_branch.clone(),
                "--title".to_owned(),
                self.title.clone(),
                "--body".to_owned(),
                self.body.clone(),
            ];
            if config.github.draft {
                argv.push("--draft".to_owned());
            }
            let selector = self
                .run("gh-pr-create", argv, config.timeouts.publish_seconds)?
                .trim()
                .to_owned();
            self.pr_view(config, &selector)?
        };
        if view.head_ref_oid.to_ascii_lowercase() != local_head {
            return Err(KoniError::Workflow(format!(
                "published PR head {} does not match local exact head {local_head}",
                view.head_ref_oid
            )));
        }
        self.trigger_greptile(config, view.number)?;
        Ok(GitHubPublication {
            head_sha: local_head,
            pull_request: view.number,
            url: view.url,
            published_at: Utc::now(),
        })
    }

    fn poll(
        &mut self,
        config: &ExternalLoopConfig,
        state: &ExternalLoopState,
    ) -> std::result::Result<bool, Self::Error> {
        let pull_request = self
            .pull_request_number(config, state)
            .ok_or_else(|| KoniError::Workflow("external loop has no PR".to_owned()))?;
        let evaluation = self.checks(config, pull_request)?.evaluate(&config.ci);
        if !evaluation.pending.is_empty() || !evaluation.missing.is_empty() {
            return Ok(false);
        }
        if config
            .greptile
            .as_ref()
            .is_some_and(|greptile| greptile.required)
            && self.greptile_body(config, pull_request)?.is_none()
        {
            return Ok(false);
        }
        Ok(true)
    }

    fn collect(
        &mut self,
        config: &ExternalLoopConfig,
        state: &ExternalLoopState,
    ) -> std::result::Result<ExternalCollection, Self::Error> {
        let pull_request = self
            .pull_request_number(config, state)
            .ok_or_else(|| KoniError::Workflow("external loop has no PR".to_owned()))?;
        let head_sha = self.head_sha(config.timeouts.collect_seconds)?;
        if state.head_sha.as_deref() != Some(head_sha.as_str()) {
            return Err(KoniError::Workflow(format!(
                "local head {head_sha} does not match published head {}",
                state.head_sha.as_deref().unwrap_or("<none>")
            )));
        }
        let checks = self.checks(config, pull_request)?;
        let greptile = self
            .greptile_body(config, pull_request)?
            .map(|body| GreptileObservation::from_body(head_sha.clone(), &body, Utc::now()))
            .transpose()?;
        Ok(ExternalCollection {
            head_sha,
            checks,
            greptile,
            collected_at: Utc::now(),
        })
    }

    fn repair(
        &mut self,
        config: &ExternalLoopConfig,
        state: &ExternalLoopState,
    ) -> std::result::Result<ExternalRepairProgress, Self::Error> {
        let current = self.head_sha(config.timeouts.repair_seconds)?;
        let base = state
            .head_sha
            .clone()
            .ok_or_else(|| KoniError::Workflow("repair has no published base head".to_owned()))?;
        if current == base {
            return Ok(ExternalRepairProgress::Pending {
                observed_head_sha: current,
            });
        }
        Ok(ExternalRepairProgress::Completed {
            repair: ExternalRepairRecord {
                base_head_sha: base.clone(),
                result_head_sha: current.clone(),
                change_hash: normalized_hash(&(base, &current)),
                summary: format!("compiler-owned repair prepared local head {current}"),
                repaired_at: Utc::now(),
            },
        })
    }

    fn verify(
        &mut self,
        config: &ExternalLoopConfig,
        state: &ExternalLoopState,
    ) -> std::result::Result<ExternalVerification, Self::Error> {
        let decision = state.collection_decision(config)?;
        let passed = decision.kind == ExternalCollectionDecisionKind::Verify;
        if passed && config.github.draft {
            let pull_request = self
                .pull_request_number(config, state)
                .ok_or_else(|| KoniError::Workflow("external loop has no PR".to_owned()))?;
            self.run(
                "gh-pr-ready",
                vec![
                    "gh".to_owned(),
                    "pr".to_owned(),
                    "ready".to_owned(),
                    pull_request.to_string(),
                    "--repo".to_owned(),
                    config.github.repository.clone(),
                ],
                config.timeouts.verify_seconds,
            )?;
        }
        Ok(ExternalVerification {
            head_sha: state
                .head_sha
                .clone()
                .ok_or_else(|| KoniError::Workflow("verification has no head".to_owned()))?,
            passed,
            reasons: decision.reasons,
            verified_at: Utc::now(),
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawPrView {
    number: u64,
    url: String,
    head_ref_oid: String,
}

#[derive(Debug, Deserialize)]
struct RawIssueComment {
    user: RawIssueUser,
    body: String,
}

#[derive(Debug, Deserialize)]
struct RawIssueUser {
    login: String,
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use chrono::Duration;

    use super::*;
    use crate::external_loop::{
        CiLoopConfig, ExternalLoopIterationPolicy, ExternalLoopTimeoutPolicy, GitHubLoopConfig,
        GreptileLoopConfig,
    };

    #[derive(Debug)]
    struct FakeCommand {
        outputs: VecDeque<ExternalCommandOutput>,
        requests: Vec<ExternalCommandRequest>,
    }

    impl ExternalCommandAdapter for FakeCommand {
        type Error = KoniError;

        fn execute(
            &mut self,
            request: &ExternalCommandRequest,
        ) -> std::result::Result<ExternalCommandOutput, Self::Error> {
            self.requests.push(request.clone());
            self.outputs
                .pop_front()
                .ok_or_else(|| KoniError::Process("missing fake output".to_owned()))
        }
    }

    fn output(exit_code: i32, stdout: &str) -> ExternalCommandOutput {
        ExternalCommandOutput {
            exit_code,
            stdout: stdout.to_owned(),
            stderr: String::new(),
        }
    }

    fn config() -> ExternalLoopConfig {
        ExternalLoopConfig {
            schema_version: "1.0".to_owned(),
            id: "review".to_owned(),
            github: GitHubLoopConfig {
                repository: "owner/repo".to_owned(),
                remote: "origin".to_owned(),
                base_branch: "development".to_owned(),
                pull_request: Some(12),
                draft: false,
            },
            ci: CiLoopConfig {
                required_checks: BTreeSet::from(["test".to_owned()]),
                allow_skipped: false,
            },
            greptile: Some(GreptileLoopConfig {
                required: true,
                minimum_confidence: 5,
                review_label: "greptile".to_owned(),
                bot_login: "greptile-apps[bot]".to_owned(),
                trigger_comment: "@greptileai".to_owned(),
            }),
            repair: crate::external_loop::ExternalRepairConfig::default(),
            iterations: ExternalLoopIterationPolicy {
                max_iterations: 5,
                max_repairs_per_iteration: 2,
                block_on_unchanged_head: true,
            },
            timeouts: ExternalLoopTimeoutPolicy {
                total_seconds: 3_600,
                prepare_seconds: 30,
                publish_seconds: 60,
                wait_seconds: 600,
                collect_seconds: 60,
                repair_seconds: 600,
                verify_seconds: 60,
                poll_interval_seconds: 10,
            },
        }
    }

    #[test]
    fn collect_accepts_failed_check_exit_and_filters_real_greptile_bot() {
        let sha = "a".repeat(40);
        let command = FakeCommand {
            outputs: VecDeque::from([
                output(0, &format!("{sha}\n")),
                output(1, r#"[{"name":"test","bucket":"fail","state":"FAILURE"}]"#),
                output(
                    0,
                    r#"[{"id":1,"user":{"login":"human","id":2},"body":"Confidence Score: 5/5"},{"id":3,"user":{"login":"greptile-apps[bot]","id":4},"body":"<h3>Confidence Score: 4/5</h3>"}]"#,
                ),
            ]),
            requests: Vec::new(),
        };
        let mut adapter = GhCliExternalLoopAdapter {
            cwd: PathBuf::from("/tmp"),
            head_branch: "feature".to_owned(),
            title: "Title".to_owned(),
            body: "Body".to_owned(),
            command,
        };
        let cfg = config();
        let now = Utc::now();
        let mut state = ExternalLoopState::new("loop", &cfg, now).unwrap();
        state.head_sha = Some(sha.clone());
        state.publication = Some(GitHubPublication {
            head_sha: sha.clone(),
            pull_request: 12,
            url: "https://github.com/owner/repo/pull/12".to_owned(),
            published_at: now + Duration::seconds(1),
        });
        let collection = adapter.collect(&cfg, &state).unwrap();
        assert_eq!(collection.head_sha, sha);
        assert_eq!(collection.checks.failed[0].name, "test");
        assert_eq!(collection.greptile.unwrap().confidence, 4);
        assert_eq!(
            adapter.command.requests[1].argv[0..3],
            ["gh", "pr", "checks"]
        );
    }

    #[test]
    fn repair_progress_waits_for_and_records_a_new_local_head() {
        let base = "a".repeat(40);
        let changed = "b".repeat(40);
        let command = FakeCommand {
            outputs: VecDeque::from([
                output(0, &format!("{base}\n")),
                output(0, &format!("{changed}\n")),
            ]),
            requests: Vec::new(),
        };
        let mut adapter = GhCliExternalLoopAdapter {
            cwd: PathBuf::from("/tmp"),
            head_branch: "feature".to_owned(),
            title: "Title".to_owned(),
            body: "Body".to_owned(),
            command,
        };
        let cfg = config();
        let mut state = ExternalLoopState::new("loop", &cfg, Utc::now()).unwrap();
        state.head_sha = Some(base.clone());

        assert_eq!(
            adapter.repair(&cfg, &state).unwrap(),
            ExternalRepairProgress::Pending {
                observed_head_sha: base.clone()
            }
        );
        let ExternalRepairProgress::Completed { repair } = adapter.repair(&cfg, &state).unwrap()
        else {
            panic!("changed HEAD should complete repair");
        };
        assert_eq!(repair.base_head_sha, base);
        assert_eq!(repair.result_head_sha, changed);
        assert_eq!(adapter.command.requests.len(), 2);
        assert!(
            adapter
                .command
                .requests
                .iter()
                .all(|request| request.argv == ["git", "rev-parse", "HEAD"])
        );
    }
}
