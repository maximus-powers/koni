//! Profiles shipped inside the CLI binary.
//!
//! `include_bytes!` is intentional: an installed `koni` executable must not
//! depend on the source checkout (or on the fixture paths used to build it).

pub(crate) struct EmbeddedFile {
    pub(crate) path: &'static str,
    pub(crate) contents: &'static [u8],
}

macro_rules! embedded {
    ($path:literal, $source:literal) => {
        EmbeddedFile {
            path: $path,
            contents: include_bytes!($source),
        }
    };
}

pub(crate) static SOFTWARE: &[EmbeddedFile] = &[
    embedded!("actions.yaml", "../templates/software/actions.yaml"),
    embedded!("checks.yaml", "../templates/software/checks.yaml"),
    embedded!("cockpit.yaml", "../templates/software/cockpit.yaml"),
    embedded!("graph.yaml", "../templates/software/graph.yaml"),
    embedded!("lifecycle.yaml", "../templates/software/lifecycle.yaml"),
    embedded!("operations.yaml", "../templates/software/operations.yaml"),
    embedded!("personas.yaml", "../templates/software/personas.yaml"),
    embedded!("reports.yaml", "../templates/software/reports.yaml"),
    embedded!("profile.yaml", "../templates/software/profile.yaml"),
    embedded!("project.yaml", "../templates/software/project.yaml"),
    embedded!("rules.yaml", "../templates/software/rules.yaml"),
    embedded!(
        "run-types/large.yaml",
        "../templates/software/run-types/large.yaml"
    ),
    embedded!(
        "run-types/medium.yaml",
        "../templates/software/run-types/medium.yaml"
    ),
    embedded!(
        "run-types/small.yaml",
        "../templates/software/run-types/small.yaml"
    ),
    embedded!("workflows.yaml", "../templates/software/workflows.yaml"),
];

/// Project-native Codex custom agents installed beside the Koni profile.
///
/// Paths are relative to `.codex/`, not `.codex/koni/`. Keeping this
/// inventory separate prevents native Codex resources from becoming an
/// implementation detail of the Koni profile tree.
pub(crate) static SOFTWARE_CODEX: &[EmbeddedFile] = &[
    embedded!(
        "agents/architecture-mapper.toml",
        "../templates/codex/software/agents/architecture-mapper.toml"
    ),
    embedded!(
        "agents/change-designer.toml",
        "../templates/codex/software/agents/change-designer.toml"
    ),
    embedded!(
        "agents/contract-designer.toml",
        "../templates/codex/software/agents/contract-designer.toml"
    ),
    embedded!(
        "agents/implementer.toml",
        "../templates/codex/software/agents/implementer.toml"
    ),
    embedded!(
        "agents/integrator.toml",
        "../templates/codex/software/agents/integrator.toml"
    ),
    embedded!(
        "agents/lead.toml",
        "../templates/codex/software/agents/lead.toml"
    ),
    embedded!(
        "agents/reviewer.toml",
        "../templates/codex/software/agents/reviewer.toml"
    ),
    embedded!(
        "agents/risk-analyst.toml",
        "../templates/codex/software/agents/risk-analyst.toml"
    ),
    embedded!(
        "agents/run-planner.toml",
        "../templates/codex/software/agents/run-planner.toml"
    ),
    embedded!(
        "agents/verifier.toml",
        "../templates/codex/software/agents/verifier.toml"
    ),
];

/// Repository-scoped skills shared by every bundled Köni profile.
pub(crate) static SHARED_SKILLS: &[EmbeddedFile] = &[
    embedded!(
        "configure-koni/SKILL.md",
        "../templates/codex/shared/skills/configure-koni/SKILL.md"
    ),
    embedded!(
        "configure-koni/agents/openai.yaml",
        "../templates/codex/shared/skills/configure-koni/agents/openai.yaml"
    ),
    embedded!(
        "configure-koni/references/agents-and-skills.md",
        "../templates/codex/shared/skills/configure-koni/references/agents-and-skills.md"
    ),
    embedded!(
        "configure-koni/references/configuration-layers.md",
        "../templates/codex/shared/skills/configure-koni/references/configuration-layers.md"
    ),
    embedded!(
        "configure-koni/references/run-types.md",
        "../templates/codex/shared/skills/configure-koni/references/run-types.md"
    ),
    embedded!(
        "model-koni-work/SKILL.md",
        "../templates/codex/shared/skills/model-koni-work/SKILL.md"
    ),
    embedded!(
        "model-koni-work/agents/openai.yaml",
        "../templates/codex/shared/skills/model-koni-work/agents/openai.yaml"
    ),
    embedded!(
        "model-koni-work/references/execution-contracts.md",
        "../templates/codex/shared/skills/model-koni-work/references/execution-contracts.md"
    ),
    embedded!(
        "model-koni-work/references/graph-model.md",
        "../templates/codex/shared/skills/model-koni-work/references/graph-model.md"
    ),
    embedded!(
        "model-koni-work/references/rules-and-tickets.md",
        "../templates/codex/shared/skills/model-koni-work/references/rules-and-tickets.md"
    ),
    embedded!(
        "operate-koni/SKILL.md",
        "../templates/codex/shared/skills/operate-koni/SKILL.md"
    ),
    embedded!(
        "operate-koni/agents/openai.yaml",
        "../templates/codex/shared/skills/operate-koni/agents/openai.yaml"
    ),
    embedded!(
        "operate-koni/references/operator-surfaces.md",
        "../templates/codex/shared/skills/operate-koni/references/operator-surfaces.md"
    ),
    embedded!(
        "operate-koni/references/recovery.md",
        "../templates/codex/shared/skills/operate-koni/references/recovery.md"
    ),
    embedded!(
        "operate-koni/references/run-lifecycle.md",
        "../templates/codex/shared/skills/operate-koni/references/run-lifecycle.md"
    ),
];

pub(crate) static RESEARCH: &[EmbeddedFile] = &[
    embedded!("README.md", "../templates/research/README.md"),
    embedded!(
        "actions/research.yaml",
        "../templates/research/actions/research.yaml"
    ),
    embedded!(
        "checks/research.yaml",
        "../templates/research/checks/research.yaml"
    ),
    embedded!(
        "cockpit/research.yaml",
        "../templates/research/cockpit/research.yaml"
    ),
    embedded!("graph/edges.yaml", "../templates/research/graph/edges.yaml"),
    embedded!("graph/nodes.yaml", "../templates/research/graph/nodes.yaml"),
    embedded!(
        "operations/research.yaml",
        "../templates/research/operations/research.yaml"
    ),
    embedded!(
        "personas/research.yaml",
        "../templates/research/personas/research.yaml"
    ),
    embedded!("profile.yaml", "../templates/research/profile.yaml"),
    embedded!("project.yaml", "../templates/research/project.yaml"),
    embedded!(
        "reports/research.yaml",
        "../templates/research/reports/research.yaml"
    ),
    embedded!(
        "rules/lifecycle.yaml",
        "../templates/research/rules/lifecycle.yaml"
    ),
    embedded!(
        "rules/research.yaml",
        "../templates/research/rules/research.yaml"
    ),
    embedded!(
        "run-types/large.yaml",
        "../templates/research/run-types/large.yaml"
    ),
    embedded!(
        "run-types/medium.yaml",
        "../templates/research/run-types/medium.yaml"
    ),
    embedded!(
        "run-types/small.yaml",
        "../templates/research/run-types/small.yaml"
    ),
    embedded!(
        "workflows/research.yaml",
        "../templates/research/workflows/research.yaml"
    ),
];

pub(crate) static RESEARCH_CODEX: &[EmbeddedFile] = &[
    embedded!(
        "agents/asset-builder.toml",
        "../templates/codex/research/agents/asset-builder.toml"
    ),
    embedded!(
        "agents/dashboard-reporter.toml",
        "../templates/codex/research/agents/dashboard-reporter.toml"
    ),
    embedded!(
        "agents/evidence-analyst.toml",
        "../templates/codex/research/agents/evidence-analyst.toml"
    ),
    embedded!(
        "agents/experiment-designer.toml",
        "../templates/codex/research/agents/experiment-designer.toml"
    ),
    embedded!(
        "agents/gate-designer.toml",
        "../templates/codex/research/agents/gate-designer.toml"
    ),
    embedded!(
        "agents/hypothesis-planner.toml",
        "../templates/codex/research/agents/hypothesis-planner.toml"
    ),
    embedded!(
        "agents/integrator.toml",
        "../templates/codex/research/agents/integrator.toml"
    ),
    embedded!(
        "agents/lead.toml",
        "../templates/codex/research/agents/lead.toml"
    ),
    embedded!(
        "agents/report-writer.toml",
        "../templates/codex/research/agents/report-writer.toml"
    ),
    embedded!(
        "agents/research-scout.toml",
        "../templates/codex/research/agents/research-scout.toml"
    ),
    embedded!(
        "agents/reviewer.toml",
        "../templates/codex/research/agents/reviewer.toml"
    ),
    embedded!(
        "agents/run-operator.toml",
        "../templates/codex/research/agents/run-operator.toml"
    ),
    embedded!(
        "agents/run-planner.toml",
        "../templates/codex/research/agents/run-planner.toml"
    ),
];

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use super::RESEARCH_CODEX;

    #[test]
    fn research_worker_prompts_never_delegate_lifecycle_through_the_shell() {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let source_root = manifest.join("../../profiles/research/personas/prompts");
        let source_prompts = fs::read_dir(&source_root)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.path().extension().and_then(|value| value.to_str()) == Some("md"))
            .map(|entry| {
                (
                    entry.file_name().to_string_lossy().into_owned(),
                    fs::read_to_string(entry.path()).unwrap(),
                )
            })
            .collect::<Vec<_>>();
        let native_prompts = RESEARCH_CODEX
            .iter()
            .map(|file| {
                (
                    file.path.rsplit('/').next().unwrap_or(file.path).to_owned(),
                    String::from_utf8(file.contents.to_vec()).unwrap(),
                )
            })
            .collect::<Vec<_>>();
        let lifecycle_verbs = [
            "action",
            "compile",
            "context",
            "finish",
            "output",
            "recover",
            "review",
            "spawn-lead",
            "spawn-worker",
            "start",
            "wait-worker",
            "yield-lead",
        ];
        for (name, prompt) in source_prompts.iter().chain(native_prompts.iter()) {
            let lower = prompt.to_ascii_lowercase();
            for verb in lifecycle_verbs {
                assert!(
                    !lower.contains(&format!("`koni {verb}"))
                        && !lower.contains(&format!("koni {verb} --")),
                    "{name} delegates `{verb}` through a shell lifecycle command"
                );
            }
        }
    }

    #[test]
    fn corrected_research_prompts_match_their_native_codex_agents() {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        for stem in ["asset-builder", "research-scout", "run-operator"] {
            let source = fs::read_to_string(manifest.join(format!(
                "../../profiles/research/personas/prompts/{stem}.md"
            )))
            .unwrap();
            let source_body = source
                .split_once("\n\n")
                .map_or(source.as_str(), |(_, body)| body);
            let native = RESEARCH_CODEX
                .iter()
                .find(|file| file.path == format!("agents/{stem}.toml"))
                .map(|file| String::from_utf8_lossy(file.contents))
                .unwrap();
            assert!(
                native.contains(source_body.trim()),
                "native agent {stem} drifted from its source prompt"
            );
        }
    }
}
