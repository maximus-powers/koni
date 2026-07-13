use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum KoniError {
    #[error("I/O error at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("invalid TOML at {path}: {source}")]
    Toml {
        path: PathBuf,
        #[source]
        source: toml::de::Error,
    },
    #[error("invalid YAML at {path}: {source}")]
    Yaml {
        path: PathBuf,
        #[source]
        source: serde_yaml::Error,
    },
    #[error("invalid JSON at {path}: {source}")]
    Json {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
    #[error("profile error: {0}")]
    Profile(String),
    #[error("graph error: {0}")]
    Graph(String),
    #[error("workflow error: {0}")]
    Workflow(String),
    #[error("action error: {0}")]
    Action(String),
    #[error("git error: {0}")]
    Git(#[from] git2::Error),
    #[error("process error: {0}")]
    Process(String),
    #[error("not found: {0}")]
    NotFound(String),
}

pub type Result<T> = std::result::Result<T, KoniError>;

pub(crate) fn io_error(path: impl Into<PathBuf>, source: std::io::Error) -> KoniError {
    KoniError::Io {
        path: path.into(),
        source,
    }
}
