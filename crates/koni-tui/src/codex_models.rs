use std::collections::BTreeSet;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use koni_core::{
    CredentialLeaseId, PI_RUNTIME_PROVIDER_ID, PiRuntimeArtifact, PiRuntimeBootstrapRequest,
    PiRuntimeProcess, RuntimeThinkingLevel,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CodexModelOption {
    pub(crate) slug: String,
    pub(crate) display_name: String,
    pub(crate) reasoning_efforts: Vec<String>,
    pub(crate) default_reasoning_effort: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CodexModelCatalog {
    pub(crate) models: Vec<CodexModelOption>,
}

impl CodexModelCatalog {
    pub(crate) fn available() -> Self {
        static CATALOG: OnceLock<CodexModelCatalog> = OnceLock::new();
        CATALOG
            .get_or_init(|| pi_runtime_catalog().unwrap_or_else(Self::fallback))
            .clone()
    }

    pub(crate) fn fallback() -> Self {
        let standard = ["low", "medium", "high", "xhigh"];
        let frontier = ["low", "medium", "high", "xhigh", "max"];
        let luna = ["low", "medium", "high", "xhigh", "max"];
        Self {
            models: [
                ("gpt-5.6-sol", "GPT-5.6 Sol", frontier.as_slice()),
                ("gpt-5.6-terra", "GPT-5.6 Terra", frontier.as_slice()),
                ("gpt-5.6-luna", "GPT-5.6 Luna", luna.as_slice()),
                ("gpt-5.5", "GPT-5.5", standard.as_slice()),
                ("gpt-5.4", "GPT-5.4", standard.as_slice()),
                ("gpt-5.4-mini", "GPT-5.4 Mini", standard.as_slice()),
                (
                    "gpt-5.3-codex-spark",
                    "GPT-5.3 Codex Spark",
                    standard.as_slice(),
                ),
            ]
            .into_iter()
            .map(|(slug, display_name, efforts)| CodexModelOption {
                slug: slug.to_owned(),
                display_name: display_name.to_owned(),
                reasoning_efforts: efforts.iter().map(|effort| (*effort).to_owned()).collect(),
                default_reasoning_effort: efforts
                    .contains(&"medium")
                    .then(|| "medium".to_owned())
                    .or_else(|| efforts.first().map(|effort| (*effort).to_owned())),
            })
            .collect(),
        }
    }

    pub(crate) fn model_choices(&self) -> impl Iterator<Item = &str> {
        self.models.iter().map(|model| model.slug.as_str())
    }

    pub(crate) fn reasoning_choices(&self, model: Option<&str>) -> Vec<String> {
        if let Some(model) = model
            && let Some(option) = self.models.iter().find(|option| option.slug == model)
        {
            return option.reasoning_efforts.clone();
        }
        let mut seen = BTreeSet::new();
        self.models
            .iter()
            .flat_map(|option| option.reasoning_efforts.iter().cloned())
            .filter(|effort| seen.insert(effort.clone()))
            .collect()
    }

    pub(crate) fn supports_reasoning(&self, model: &str, effort: &str) -> bool {
        self.models
            .iter()
            .find(|option| option.slug == model)
            .is_none_or(|option| {
                option
                    .reasoning_efforts
                    .iter()
                    .any(|supported| supported == effort)
            })
    }

    pub(crate) fn preferred_reasoning(&self, model: &str) -> Option<String> {
        let option = self.models.iter().find(|option| option.slug == model)?;
        option
            .default_reasoning_effort
            .clone()
            .filter(|effort| option.reasoning_efforts.contains(effort))
            .or_else(|| {
                option
                    .reasoning_efforts
                    .iter()
                    .find(|effort| effort.as_str() == "medium")
                    .cloned()
            })
            .or_else(|| option.reasoning_efforts.first().cloned())
    }
}

fn pi_runtime_catalog() -> Option<CodexModelCatalog> {
    static REQUEST_SEQUENCE: AtomicU64 = AtomicU64::new(1);
    let sequence = REQUEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let nonce = format!("{}-{sequence}", std::process::id());
    let artifact = PiRuntimeArtifact::discover(&[]).ok()?;
    let mut process = PiRuntimeProcess::bootstrap(
        PiRuntimeBootstrapRequest {
            artifact,
            transport_session_id: format!("pi-tui-models-{nonce}"),
            credential_lease: CredentialLeaseId(format!("pi-tui-models-lease-{nonce}")),
            timeout: Duration::from_secs(2),
            network_access: false,
            oauth_callback_access: false,
        },
        &mut |_| Ok(()),
    )
    .ok()?;
    let response = process.list_models().ok();
    let shutdown = process.terminate();
    let response = response.filter(|_| shutdown.is_ok())?;
    let mut seen = BTreeSet::new();
    let models = response
        .into_iter()
        .filter(|model| model.provider == PI_RUNTIME_PROVIDER_ID)
        .filter(|model| seen.insert(model.id.clone()))
        .map(|model| CodexModelOption {
            display_name: if model.name.trim().is_empty() {
                model.id.clone()
            } else {
                model.name
            },
            slug: model.id,
            default_reasoning_effort: model
                .thinking_levels
                .contains(&RuntimeThinkingLevel::High)
                .then(|| "high".to_owned())
                .or_else(|| {
                    model
                        .thinking_levels
                        .contains(&RuntimeThinkingLevel::Medium)
                        .then(|| "medium".to_owned())
                })
                .or_else(|| {
                    model
                        .thinking_levels
                        .first()
                        .cloned()
                        .map(pi_thinking_level_name)
                }),
            reasoning_efforts: model
                .thinking_levels
                .into_iter()
                .map(pi_thinking_level_name)
                .collect(),
        })
        .collect::<Vec<_>>();
    (!models.is_empty()).then_some(CodexModelCatalog { models })
}

fn pi_thinking_level_name(level: RuntimeThinkingLevel) -> String {
    match level {
        RuntimeThinkingLevel::Off => "off",
        RuntimeThinkingLevel::Minimal => "minimal",
        RuntimeThinkingLevel::Low => "low",
        RuntimeThinkingLevel::Medium => "medium",
        RuntimeThinkingLevel::High => "high",
        RuntimeThinkingLevel::Xhigh => "xhigh",
        RuntimeThinkingLevel::Max => "max",
    }
    .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pi_thinking_levels_use_schema_two_names() {
        assert_eq!(
            pi_thinking_level_name(RuntimeThinkingLevel::Minimal),
            "minimal"
        );
        assert_eq!(pi_thinking_level_name(RuntimeThinkingLevel::Max), "max");
    }

    #[test]
    fn fallback_includes_codex_default_families_and_frontier_efforts() {
        let catalog = CodexModelCatalog::fallback();
        assert!(catalog.model_choices().any(|model| model == "gpt-5.6-sol"));
        assert_eq!(
            catalog.reasoning_choices(Some("gpt-5.6-sol")),
            ["low", "medium", "high", "xhigh", "max"]
        );
    }
}
