use std::collections::BTreeSet;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;

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
            .get_or_init(|| {
                command_catalog(&["debug", "models"])
                    .or_else(|| command_catalog(&["debug", "models", "--bundled"]))
                    .unwrap_or_else(Self::fallback)
            })
            .clone()
    }

    pub(crate) fn fallback() -> Self {
        let standard = ["low", "medium", "high", "xhigh"];
        let frontier = ["low", "medium", "high", "xhigh", "max", "ultra"];
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

#[derive(Debug, Deserialize)]
struct CodexModelsResponse {
    #[serde(default)]
    models: Vec<CodexModelEntry>,
}

#[derive(Debug, Deserialize)]
struct CodexModelEntry {
    slug: String,
    #[serde(default)]
    display_name: String,
    #[serde(default)]
    visibility: String,
    #[serde(default)]
    supported_reasoning_levels: Vec<CodexReasoningLevel>,
    #[serde(default)]
    default_reasoning_level: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CodexReasoningLevel {
    effort: String,
}

fn command_catalog(args: &[&str]) -> Option<CodexModelCatalog> {
    let mut child = Command::new("codex")
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).ok()?;
        Some(bytes)
    });
    let deadline = Instant::now() + Duration::from_secs(2);
    let status = loop {
        if let Some(status) = child.try_wait().ok().flatten() {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let _ = reader.join();
            return None;
        }
        thread::sleep(Duration::from_millis(20));
    };
    let bytes = reader.join().ok().flatten()?;
    status.success().then(|| parse_catalog(&bytes)).flatten()
}

fn parse_catalog(bytes: &[u8]) -> Option<CodexModelCatalog> {
    let response = serde_json::from_slice::<CodexModelsResponse>(bytes).ok()?;
    let mut seen = BTreeSet::new();
    let models = response
        .models
        .into_iter()
        .filter(|model| model.visibility.is_empty() || model.visibility == "list")
        .filter(|model| seen.insert(model.slug.clone()))
        .map(|model| CodexModelOption {
            display_name: if model.display_name.trim().is_empty() {
                model.slug.clone()
            } else {
                model.display_name
            },
            slug: model.slug,
            default_reasoning_effort: model.default_reasoning_level,
            reasoning_efforts: model
                .supported_reasoning_levels
                .into_iter()
                .map(|level| level.effort)
                .collect(),
        })
        .collect::<Vec<_>>();
    (!models.is_empty()).then_some(CodexModelCatalog { models })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_visible_models_and_their_model_specific_reasoning_levels() {
        let catalog = parse_catalog(
            br#"{
                "models": [
                    {
                        "slug": "gpt-frontier",
                        "display_name": "GPT Frontier",
                        "visibility": "list",
                        "default_reasoning_level": "max",
                        "supported_reasoning_levels": [
                            {"effort": "low"},
                            {"effort": "max"},
                            {"effort": "ultra"}
                        ]
                    },
                    {
                        "slug": "gpt-hidden",
                        "display_name": "Hidden",
                        "visibility": "hide",
                        "supported_reasoning_levels": [{"effort": "medium"}]
                    }
                ]
            }"#,
        )
        .unwrap();

        assert_eq!(
            catalog.model_choices().collect::<Vec<_>>(),
            ["gpt-frontier"]
        );
        assert_eq!(
            catalog.reasoning_choices(Some("gpt-frontier")),
            ["low", "max", "ultra"]
        );
        assert!(catalog.supports_reasoning("gpt-frontier", "ultra"));
        assert!(!catalog.supports_reasoning("gpt-frontier", "medium"));
        assert_eq!(
            catalog.preferred_reasoning("gpt-frontier").as_deref(),
            Some("max")
        );
    }

    #[test]
    fn fallback_includes_codex_default_families_and_frontier_efforts() {
        let catalog = CodexModelCatalog::fallback();
        assert!(catalog.model_choices().any(|model| model == "gpt-5.6-sol"));
        assert_eq!(
            catalog.reasoning_choices(Some("gpt-5.6-sol")),
            ["low", "medium", "high", "xhigh", "max", "ultra"]
        );
    }
}
