//! Secret-safe proof of Codex's effective launch configuration.
//!
//! Pass one inventories inherited resource IDs without retaining their values.
//! Koni then adds highest-layer disables for every inherited MCP server,
//! app, and plugin. Pass two resolves the exact launch config and validates the
//! raw reserved runtime table in memory. Raw config values can contain bearer
//! tokens and are never returned, formatted, logged, or persisted.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use serde_json::{Map, Value, json};

use crate::error::{KoniError, Result, io_error};

pub(crate) const RUNTIME_MCP_SERVER_ID: &str = "koni_runtime";
pub(crate) const HARDENED_DISABLED_FEATURES: &[&str] = &[
    "apps",
    "artifact",
    "auth_elicitation",
    "browser_use",
    "browser_use_external",
    "browser_use_full_cdp_access",
    "code_mode",
    "code_mode_host",
    "code_mode_only",
    "computer_use",
    "default_mode_request_user_input",
    "deferred_executor",
    "enable_mcp_apps",
    "enable_fanout",
    "goals",
    "hooks",
    "image_generation",
    "in_app_browser",
    "memories",
    "multi_agent",
    "multi_agent_v2",
    "plugin_sharing",
    "plugins",
    "realtime_conversation",
    "remote_plugin",
    "request_permissions_tool",
    "skill_mcp_dependency_install",
    "tool_call_mcp_elicitation",
    "tool_suggest",
    "use_agent_identity",
    "workspace_dependencies",
];

const MAX_PREFLIGHT_LINE_BYTES: usize = 16 * 1024 * 1024;
const DEFAULT_PREFLIGHT_TIMEOUT: Duration = Duration::from_secs(10);
const RUNTIME_STARTUP_TIMEOUT_SECONDS: u64 = 10;
const RUNTIME_TOOL_TIMEOUT_SECONDS: u64 = 3_660;

#[derive(Debug, Clone)]
pub(crate) struct RuntimeMcpExpectation {
    pub command: PathBuf,
    pub args: Vec<String>,
    pub enabled_tools: Vec<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct PermissionProfileExpectation {
    pub(crate) name: String,
    description: Option<String>,
    extends: Option<String>,
    filesystem: Map<String, Value>,
    network_enabled: bool,
}

impl PermissionProfileExpectation {
    pub(crate) fn workspace(
        name: impl Into<String>,
        filesystem: BTreeMap<String, String>,
        network_enabled: bool,
    ) -> Self {
        Self {
            name: name.into(),
            description: None,
            extends: Some(":workspace".to_owned()),
            filesystem: Map::from_iter([(
                ":workspace_roots".to_owned(),
                serde_json::to_value(filesystem).expect("filesystem rules are serializable"),
            )]),
            network_enabled,
        }
    }

    pub(crate) fn read_only_scratch(name: impl Into<String>, scratch: &Path) -> Result<Self> {
        let scratch = scratch
            .to_str()
            .ok_or_else(|| KoniError::Process("Codex scratch path is not UTF-8".to_owned()))?;
        Ok(Self {
            name: name.into(),
            description: Some("Ephemeral Koni read-only agent scratch".to_owned()),
            extends: None,
            filesystem: Map::from_iter([
                (":root".to_owned(), json!("read")),
                (scratch.to_owned(), json!("write")),
            ]),
            network_enabled: false,
        })
    }
}

#[derive(Debug, Clone)]
pub(crate) struct CodexConfigPreflightRequest<'a> {
    pub executable: &'a Path,
    pub cwd: &'a Path,
    /// Safe, compiler-vetted assignments that the real launch will also use.
    pub base_config_overrides: &'a [String],
    pub additional_disabled_features: &'a [String],
    pub additional_enabled_features: &'a [String],
    pub expected_runtime: Option<RuntimeMcpExpectation>,
    pub expected_permission: Option<PermissionProfileExpectation>,
    pub expected_default_permissions: String,
    pub expected_approval_policy: String,
    pub expected_web_search: bool,
    pub timeout: Option<Duration>,
}

/// The exact compiler-owned additions that must be appended to the real Codex
/// launch after the same base config used for this proof.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct VerifiedCodexLaunchBoundary {
    pub config_overrides: Vec<String>,
    pub disabled_features: Vec<String>,
    pub enabled_features: Vec<String>,
}

#[derive(Clone)]
struct RawConfigRead {
    config: Map<String, Value>,
    origins: Option<Map<String, Value>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SafeInventory {
    mcp_servers: BTreeMap<String, BTreeSet<String>>,
    apps: BTreeSet<String>,
    plugins: BTreeSet<String>,
}

pub(crate) fn verify_effective_codex_config(
    request: CodexConfigPreflightRequest<'_>,
) -> Result<VerifiedCodexLaunchBoundary> {
    let executable = canonical_regular_file(request.executable, "Codex executable")?;
    let cwd = request
        .cwd
        .canonicalize()
        .map_err(|error| io_error(request.cwd, error))?;
    if !cwd.is_dir() || cwd.to_str().is_none() || executable.to_str().is_none() {
        return Err(KoniError::Process(
            "Codex preflight requires canonical UTF-8 executable and cwd paths".to_owned(),
        ));
    }

    let disabled_features = HARDENED_DISABLED_FEATURES
        .iter()
        .map(|feature| (*feature).to_owned())
        .chain(request.additional_disabled_features.iter().cloned())
        .chain((!request.expected_web_search).then(|| "network_proxy".to_owned()))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let enabled_features = request
        .additional_enabled_features
        .iter()
        .cloned()
        .chain(
            request
                .expected_web_search
                .then(|| "network_proxy".to_owned()),
        )
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    if enabled_features
        .iter()
        .any(|feature| disabled_features.contains(feature))
    {
        return Err(KoniError::Process(
            "Codex preflight received a feature in both enabled and disabled sets".to_owned(),
        ));
    }
    let baseline = hardened_baseline_overrides(
        &request.expected_default_permissions,
        &request.expected_approval_policy,
        request.expected_web_search,
    );
    let mut first_overrides = request.base_config_overrides.to_vec();
    first_overrides.extend(baseline.iter().cloned());
    let first = read_raw_effective_config(
        &executable,
        &cwd,
        &first_overrides,
        &disabled_features,
        &enabled_features,
        request.timeout,
    )?;
    let inventory = safe_inventory(&first)?;
    drop(first);
    if inventory.mcp_servers.contains_key(RUNTIME_MCP_SERVER_ID) {
        return Err(KoniError::Process(
            "reserved Koni runtime MCP identity already exists in inherited Codex config"
                .to_owned(),
        ));
    }

    let mut enforced = baseline;
    let expected_runtime = request
        .expected_runtime
        .as_ref()
        .map(normalized_runtime_expectation)
        .transpose()?;
    if let Some(assignment) = resource_table_assignment(
        "mcp_servers",
        inventory.mcp_servers.keys().map(String::as_str),
        request.expected_runtime.as_ref(),
    )? {
        enforced.push(assignment);
    }
    if let Some(assignment) =
        resource_table_assignment("apps", inventory.apps.iter().map(String::as_str), None)?
    {
        enforced.push(assignment);
    }
    if let Some(assignment) = resource_table_assignment(
        "plugins",
        inventory.plugins.iter().map(String::as_str),
        None,
    )? {
        enforced.push(assignment);
    }

    let mut second_overrides = request.base_config_overrides.to_vec();
    second_overrides.extend(enforced.iter().cloned());
    let second = read_raw_effective_config(
        &executable,
        &cwd,
        &second_overrides,
        &disabled_features,
        &enabled_features,
        request.timeout,
    )?;
    validate_second_pass(
        &second,
        &inventory,
        expected_runtime.as_ref(),
        request.expected_permission.as_ref(),
        &request.expected_default_permissions,
        &request.expected_approval_policy,
        request.expected_web_search,
        &disabled_features,
        &enabled_features,
    )?;
    drop(second);
    Ok(VerifiedCodexLaunchBoundary {
        config_overrides: enforced,
        disabled_features,
        enabled_features,
    })
}

fn hardened_baseline_overrides(
    default_permissions: &str,
    approval_policy: &str,
    web_search: bool,
) -> Vec<String> {
    vec![
        "shell_environment_policy={inherit=\"core\",ignore_default_excludes=false,experimental_use_profile=false}".to_owned(),
        format!(
            "web_search=\"{}\"",
            if web_search { "live" } else { "disabled" }
        ),
        format!("tools.web_search={web_search}"),
        "include_apps_instructions=false".to_owned(),
        "include_collaboration_mode_instructions=false".to_owned(),
        "notify=[]".to_owned(),
        format!(
            "default_permissions={}",
            serde_json::to_string(default_permissions).expect("permission name is serializable")
        ),
        format!(
            "approval_policy={}",
            serde_json::to_string(approval_policy).expect("approval policy is serializable")
        ),
    ]
}

fn resource_table_assignment<'a>(
    table: &str,
    disabled_ids: impl Iterator<Item = &'a str>,
    runtime: Option<&RuntimeMcpExpectation>,
) -> Result<Option<String>> {
    let mut entries = disabled_ids
        .map(|id| {
            let id = serde_json::to_string(id).expect("resource ID is serializable");
            format!("{id}={{enabled=false}}")
        })
        .collect::<Vec<_>>();
    if let Some(runtime) = runtime {
        entries.push(format!(
            "{RUNTIME_MCP_SERVER_ID}={}",
            runtime_inline_table(runtime)?
        ));
    }
    Ok((!entries.is_empty()).then(|| format!("{table}={{{}}}", entries.join(","))))
}

fn runtime_inline_table(expected: &RuntimeMcpExpectation) -> Result<String> {
    let command = canonical_regular_file(&expected.command, "runtime MCP executable")?;
    let command = command
        .to_str()
        .ok_or_else(|| KoniError::Process("runtime MCP executable path is not UTF-8".to_owned()))?;
    if expected.args.is_empty() || expected.enabled_tools.is_empty() {
        return Err(KoniError::Process(
            "runtime MCP expectation requires args and enabled tools".to_owned(),
        ));
    }
    let command = serde_json::to_string(command).expect("UTF-8 command is serializable");
    let args = serde_json::to_string(&expected.args)
        .map_err(|_| KoniError::Process("runtime MCP args could not be serialized".to_owned()))?;
    let tools = serde_json::to_string(&expected.enabled_tools)
        .map_err(|_| KoniError::Process("runtime MCP tools could not be serialized".to_owned()))?;
    Ok(format!(
        "{{command={command},args={args},env={{}},env_vars=[],enabled=true,required=true,enabled_tools={tools},default_tools_approval_mode=\"approve\",startup_timeout_sec={RUNTIME_STARTUP_TIMEOUT_SECONDS},tool_timeout_sec={RUNTIME_TOOL_TIMEOUT_SECONDS},supports_parallel_tool_calls=false}}"
    ))
}

fn normalized_runtime_expectation(expected: &RuntimeMcpExpectation) -> Result<Value> {
    let command = canonical_regular_file(&expected.command, "runtime MCP executable")?;
    let command = command
        .to_str()
        .ok_or_else(|| KoniError::Process("runtime MCP executable path is not UTF-8".to_owned()))?;
    Ok(json!({
        "command": command,
        "args": expected.args,
        "env": {},
        "environment_id": "local",
        "enabled": true,
        "required": true,
        "startup_timeout_sec": RUNTIME_STARTUP_TIMEOUT_SECONDS as f64,
        "tool_timeout_sec": RUNTIME_TOOL_TIMEOUT_SECONDS as f64,
        "default_tools_approval_mode": "approve",
        "enabled_tools": expected.enabled_tools,
    }))
}

fn safe_inventory(raw: &RawConfigRead) -> Result<SafeInventory> {
    let mcp_servers = optional_object(raw.config.get("mcp_servers"), "MCP servers")?
        .iter()
        .map(|(id, _)| {
            validate_resource_id(id)?;
            Ok((id.clone(), mcp_provenance(id, raw.origins.as_ref())))
        })
        .collect::<Result<_>>()?;
    let apps = optional_object(raw.config.get("apps"), "apps")?
        .keys()
        .map(|id| {
            validate_resource_id(id)?;
            Ok(id.clone())
        })
        .collect::<Result<_>>()?;
    let plugins = optional_object(raw.config.get("plugins"), "plugins")?
        .keys()
        .map(|id| {
            validate_resource_id(id)?;
            Ok(id.clone())
        })
        .collect::<Result<_>>()?;
    Ok(SafeInventory {
        mcp_servers,
        apps,
        plugins,
    })
}

fn validate_resource_id(id: &str) -> Result<()> {
    if id.is_empty()
        || id.len() > 128
        || !id.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'@' | b'/')
        })
    {
        return Err(KoniError::Process(
            "Codex preflight found an unsafe resource identifier".to_owned(),
        ));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn validate_second_pass(
    raw: &RawConfigRead,
    inventory: &SafeInventory,
    expected_runtime: Option<&Value>,
    expected_permission: Option<&PermissionProfileExpectation>,
    expected_default_permissions: &str,
    expected_approval_policy: &str,
    expected_web_search: bool,
    disabled_features: &[String],
    enabled_features: &[String],
) -> Result<()> {
    let config = &raw.config;
    let fail = || {
        KoniError::Process(
            "effective Codex config differs from the compiler-owned launch boundary".to_owned(),
        )
    };
    let servers = optional_object(config.get("mcp_servers"), "MCP servers")?;
    for id in inventory.mcp_servers.keys() {
        if servers
            .get(id)
            .and_then(Value::as_object)
            .and_then(|server| server.get("enabled"))
            .and_then(Value::as_bool)
            != Some(false)
        {
            return Err(fail());
        }
    }
    match expected_runtime {
        Some(expected)
            if servers.get(RUNTIME_MCP_SERVER_ID) == Some(expected)
                && runtime_origins_are_exact(raw.origins.as_ref(), expected) => {}
        None if !servers.contains_key(RUNTIME_MCP_SERVER_ID) => {}
        _ => return Err(fail()),
    }
    if servers
        .iter()
        .any(|(id, server)| id != RUNTIME_MCP_SERVER_ID && server_enabled(server))
    {
        return Err(fail());
    }
    for (table, ids) in [("apps", &inventory.apps), ("plugins", &inventory.plugins)] {
        let entries = optional_object(config.get(table), table)?;
        if ids.iter().any(|id| {
            entries
                .get(id)
                .and_then(Value::as_object)
                .and_then(|entry| entry.get("enabled"))
                .and_then(Value::as_bool)
                != Some(false)
        }) {
            return Err(fail());
        }
        if entries.values().any(server_enabled) {
            return Err(fail());
        }
    }
    let features = optional_object(config.get("features"), "features")?;
    if disabled_features
        .iter()
        .any(|feature| features.get(feature).and_then(Value::as_bool) != Some(false))
        || enabled_features
            .iter()
            .any(|feature| features.get(feature).and_then(Value::as_bool) != Some(true))
        || features.get("network_proxy").and_then(Value::as_bool) != Some(expected_web_search)
        || config
            .get("include_apps_instructions")
            .and_then(Value::as_bool)
            != Some(false)
        || config
            .get("include_collaboration_mode_instructions")
            .and_then(Value::as_bool)
            != Some(false)
        || hooks_present(config.get("hooks"))
        || config
            .get("notify")
            .is_some_and(|value| !is_null_or_empty_array(value))
        || config.get("web_search").and_then(Value::as_str)
            != Some(if expected_web_search {
                "live"
            } else {
                "disabled"
            })
        || config
            .get("tools")
            .and_then(Value::as_object)
            .and_then(|tools| tools.get("web_search"))
            .is_some_and(|value| !value.is_null() && value.as_bool() != Some(expected_web_search))
        || config.get("default_permissions").and_then(Value::as_str)
            != Some(expected_default_permissions)
        || config.get("approval_policy").and_then(Value::as_str) != Some(expected_approval_policy)
        || !session_flag_origin(raw.origins.as_ref(), "web_search")
        || !session_flag_origin(raw.origins.as_ref(), "tools.web_search")
        || !shell_environment_is_exact(config.get("shell_environment_policy"))
    {
        return Err(fail());
    }
    if let Some(expected) = expected_permission {
        validate_permission(config, expected).map_err(|_| fail())?;
    }
    Ok(())
}

fn validate_permission(
    config: &Map<String, Value>,
    expected: &PermissionProfileExpectation,
) -> Result<()> {
    let permission = config
        .get("permissions")
        .and_then(Value::as_object)
        .and_then(|permissions| permissions.get(&expected.name))
        .and_then(Value::as_object)
        .ok_or_else(|| KoniError::Process("missing named permission profile".to_owned()))?;
    let mut filesystem = expected.filesystem.clone();
    filesystem.insert("glob_scan_max_depth".to_owned(), Value::Null);
    let normalized = json!({
        "description": expected.description,
        "extends": expected.extends,
        "workspace_roots": null,
        "filesystem": filesystem,
        "network": {
            "enabled": expected.network_enabled,
            "proxy_url": null,
            "enable_socks5": null,
            "socks_url": null,
            "enable_socks5_udp": null,
            "allow_upstream_proxy": null,
            "dangerously_allow_non_loopback_proxy": null,
            "dangerously_allow_all_unix_sockets": null,
            "mode": null,
            "domains": null,
            "unix_sockets": null,
            "allow_local_binding": null,
            "mitm": null,
        }
    });
    if Value::Object(permission.clone()) != normalized {
        return Err(KoniError::Process(
            "named permission profile differs from expectation".to_owned(),
        ));
    }
    Ok(())
}

fn runtime_origins_are_exact(origins: Option<&Map<String, Value>>, expected: &Value) -> bool {
    let Some(origins) = origins else {
        return false;
    };
    let prefix = format!("mcp_servers.{RUNTIME_MCP_SERVER_ID}.");
    if origins
        .iter()
        .filter(|(key, _)| key.starts_with(&prefix))
        .any(|(_, origin)| origin_type(origin) != Some("sessionFlags"))
    {
        return false;
    }
    let args = expected
        .get("args")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    let tools = expected
        .get("enabled_tools")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    let mut required = [
        "command",
        "enabled",
        "required",
        "startup_timeout_sec",
        "tool_timeout_sec",
        "default_tools_approval_mode",
        "supports_parallel_tool_calls",
    ]
    .into_iter()
    .map(|field| format!("{prefix}{field}"))
    .collect::<BTreeSet<_>>();
    required.extend((0..args).map(|index| format!("{prefix}args.{index}")));
    required.extend((0..tools).map(|index| format!("{prefix}enabled_tools.{index}")));
    required.into_iter().all(|key| {
        origins
            .get(&key)
            .is_some_and(|origin| origin_type(origin) == Some("sessionFlags"))
    })
}

fn origin_type(origin: &Value) -> Option<&str> {
    origin
        .get("name")
        .and_then(|name| name.get("type"))
        .and_then(Value::as_str)
}

fn session_flag_origin(origins: Option<&Map<String, Value>>, key: &str) -> bool {
    origins
        .and_then(|origins| origins.get(key))
        .is_some_and(|origin| origin_type(origin) == Some("sessionFlags"))
}

fn shell_environment_is_exact(value: Option<&Value>) -> bool {
    let Some(policy) = value.and_then(Value::as_object) else {
        return false;
    };
    policy.get("inherit").and_then(Value::as_str) == Some("core")
        && policy
            .get("ignore_default_excludes")
            .and_then(Value::as_bool)
            == Some(false)
        && policy
            .get("experimental_use_profile")
            .and_then(Value::as_bool)
            == Some(false)
        && policy.get("set").is_some_and(is_null_or_empty_object)
        && policy.get("exclude").is_some_and(is_null_or_empty_array)
        && policy
            .get("include_only")
            .is_some_and(is_null_or_empty_array)
        && policy.keys().all(|key| {
            matches!(
                key.as_str(),
                "inherit"
                    | "ignore_default_excludes"
                    | "experimental_use_profile"
                    | "set"
                    | "exclude"
                    | "include_only"
            )
        })
}

fn is_null_or_empty_object(value: &Value) -> bool {
    value.is_null() || value.as_object().is_some_and(Map::is_empty)
}

fn is_null_or_empty_array(value: &Value) -> bool {
    value.is_null() || value.as_array().is_some_and(Vec::is_empty)
}

fn hooks_present(value: Option<&Value>) -> bool {
    value.and_then(Value::as_object).is_some_and(|hooks| {
        hooks
            .iter()
            .filter(|(name, _)| name.as_str() != "state")
            .any(|(_, value)| value.as_array().is_some_and(|entries| !entries.is_empty()))
    })
}

fn server_enabled(value: &Value) -> bool {
    value
        .as_object()
        .and_then(|server| server.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

fn optional_object<'a>(value: Option<&'a Value>, label: &str) -> Result<&'a Map<String, Value>> {
    static EMPTY: std::sync::OnceLock<Map<String, Value>> = std::sync::OnceLock::new();
    match value {
        None | Some(Value::Null) => Ok(EMPTY.get_or_init(Map::new)),
        Some(Value::Object(object)) => Ok(object),
        Some(_) => Err(KoniError::Process(format!(
            "Codex preflight returned invalid {label}"
        ))),
    }
}

fn mcp_provenance(id: &str, origins: Option<&Map<String, Value>>) -> BTreeSet<String> {
    let prefix = format!("mcp_servers.{id}");
    origins
        .into_iter()
        .flat_map(|origins| origins.iter())
        .filter(|(key, _)| *key == &prefix || key.starts_with(&format!("{prefix}.")))
        .filter_map(|(_, origin)| {
            origin
                .get("name")
                .and_then(|name| name.get("type"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .collect()
}

fn read_raw_effective_config(
    executable: &Path,
    cwd: &Path,
    config_overrides: &[String],
    disabled_features: &[String],
    enabled_features: &[String],
    timeout: Option<Duration>,
) -> Result<RawConfigRead> {
    let mut command = Command::new(executable);
    command
        .args(["app-server", "--stdio", "--strict-config"])
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    for assignment in config_overrides {
        command.args(["--config", assignment]);
    }
    for feature in disabled_features {
        command.args(["--disable", feature]);
    }
    for feature in enabled_features {
        command.args(["--enable", feature]);
    }
    let mut child = command
        .spawn()
        .map_err(|_| KoniError::Process("could not start Codex config preflight".to_owned()))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| KoniError::Process("Codex config preflight has no stdin".to_owned()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| KoniError::Process("Codex config preflight has no stdout".to_owned()))?;
    let cwd = cwd
        .to_str()
        .expect("canonical UTF-8 cwd checked before preflight");
    for message in [
        json!({
            "id": 1,
            "method": "initialize",
            "params": {
                "clientInfo": {"name": "koni-preflight", "version": env!("CARGO_PKG_VERSION")},
                "capabilities": {"experimentalApi": true, "mcpServerOpenaiFormElicitation": false}
            }
        }),
        json!({"method": "initialized", "params": {}}),
        json!({
            "id": 2,
            "method": "config/read",
            "params": {"cwd": cwd, "includeLayers": true}
        }),
    ] {
        serde_json::to_writer(&mut stdin, &message).map_err(|_| {
            KoniError::Process("could not encode Codex preflight request".to_owned())
        })?;
        stdin.write_all(b"\n").map_err(|_| {
            KoniError::Process("could not write Codex preflight request".to_owned())
        })?;
    }
    stdin
        .flush()
        .map_err(|_| KoniError::Process("could not flush Codex preflight request".to_owned()))?;

    let (sender, receiver) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let result = read_config_response(BufReader::new(stdout));
        let _ = sender.send(result);
    });
    let result = receiver
        .recv_timeout(timeout.unwrap_or(DEFAULT_PREFLIGHT_TIMEOUT))
        .map_err(|error| match error {
            mpsc::RecvTimeoutError::Timeout => KoniError::Process(
                "Codex config preflight timed out before config/read completed".to_owned(),
            ),
            mpsc::RecvTimeoutError::Disconnected => KoniError::Process(
                "Codex config preflight ended before config/read completed".to_owned(),
            ),
        });
    drop(stdin);
    let _ = child.kill();
    let _ = child.wait();
    result?
}

fn read_config_response(mut reader: impl BufRead) -> Result<RawConfigRead> {
    let mut line = Vec::new();
    loop {
        line.clear();
        if !read_bounded_line(&mut reader, &mut line)? {
            return Err(KoniError::Process(
                "Codex config preflight exited without config/read".to_owned(),
            ));
        }
        let value: Value = serde_json::from_slice(&line).map_err(|_| {
            KoniError::Process("Codex config preflight returned malformed JSON".to_owned())
        })?;
        if value.get("id").and_then(Value::as_u64) != Some(2) {
            continue;
        }
        if value.get("error").is_some() {
            return Err(KoniError::Process(
                "Codex config preflight rejected config/read".to_owned(),
            ));
        }
        let result = value.get("result").ok_or_else(|| {
            KoniError::Process("Codex config preflight returned no effective config".to_owned())
        })?;
        let config = result
            .get("config")
            .and_then(Value::as_object)
            .cloned()
            .ok_or_else(|| {
                KoniError::Process("Codex config preflight returned no effective config".to_owned())
            })?;
        let origins = result.get("origins").and_then(Value::as_object).cloned();
        return Ok(RawConfigRead { config, origins });
    }
}

fn read_bounded_line(reader: &mut impl BufRead, output: &mut Vec<u8>) -> Result<bool> {
    loop {
        let buffer = reader.fill_buf().map_err(|_| {
            KoniError::Process("could not read Codex preflight response".to_owned())
        })?;
        if buffer.is_empty() {
            return Ok(!output.is_empty());
        }
        let take = buffer
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(buffer.len(), |index| index + 1);
        if output.len().saturating_add(take) > MAX_PREFLIGHT_LINE_BYTES {
            return Err(KoniError::Process(
                "Codex config preflight response exceeded its safe size limit".to_owned(),
            ));
        }
        output.extend_from_slice(&buffer[..take]);
        reader.consume(take);
        if output.last() == Some(&b'\n') {
            return Ok(true);
        }
    }
}

fn canonical_regular_file(path: &Path, label: &str) -> Result<PathBuf> {
    let canonical = path.canonicalize().map_err(|error| io_error(path, error))?;
    let metadata = fs::metadata(&canonical).map_err(|error| io_error(&canonical, error))?;
    if !metadata.is_file() {
        return Err(KoniError::Process(format!(
            "{label} is not a regular file: {}",
            canonical.display()
        )));
    }
    Ok(canonical)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    fn exact_shell_policy() -> Value {
        json!({
            "inherit": "core",
            "ignore_default_excludes": false,
            "exclude": null,
            "set": null,
            "include_only": null,
            "experimental_use_profile": false,
        })
    }

    fn session_origin() -> Value {
        json!({"name": {"type": "sessionFlags"}})
    }

    fn exact_hardened_config(
        runtime: Option<Value>,
        inherited_mcp: Option<(&str, bool)>,
        inherited_app: Option<(&str, bool)>,
        inherited_plugin: Option<(&str, bool)>,
    ) -> Value {
        let mut servers = Map::new();
        if let Some((id, enabled)) = inherited_mcp {
            servers.insert(id.to_owned(), json!({"enabled": enabled}));
        }
        if let Some(runtime) = runtime {
            servers.insert(RUNTIME_MCP_SERVER_ID.to_owned(), runtime);
        }
        let apps = inherited_app
            .map(|(id, enabled)| Map::from_iter([(id.to_owned(), json!({"enabled": enabled}))]))
            .unwrap_or_default();
        let plugins = inherited_plugin
            .map(|(id, enabled)| Map::from_iter([(id.to_owned(), json!({"enabled": enabled}))]))
            .unwrap_or_default();
        let mut features = HARDENED_DISABLED_FEATURES
            .iter()
            .map(|feature| ((*feature).to_owned(), Value::Bool(false)))
            .collect::<Map<_, _>>();
        features.insert("network_proxy".to_owned(), Value::Bool(false));
        json!({
            "mcp_servers": servers,
            "apps": apps,
            "plugins": plugins,
            "features": features,
            "include_apps_instructions": false,
            "include_collaboration_mode_instructions": false,
            "hooks": {},
            "notify": [],
            "web_search": "disabled",
            "tools": {"web_search": false},
            "default_permissions": ":read-only",
            "approval_policy": "never",
            "shell_environment_policy": exact_shell_policy(),
        })
    }

    fn runtime_origins(expected: &Value) -> Map<String, Value> {
        let prefix = format!("mcp_servers.{RUNTIME_MCP_SERVER_ID}.");
        let mut origins = [
            "command",
            "enabled",
            "required",
            "startup_timeout_sec",
            "tool_timeout_sec",
            "default_tools_approval_mode",
            "supports_parallel_tool_calls",
        ]
        .into_iter()
        .map(|field| (format!("{prefix}{field}"), session_origin()))
        .collect::<Map<_, _>>();
        for index in 0..expected
            .get("args")
            .and_then(Value::as_array)
            .map_or(0, Vec::len)
        {
            origins.insert(format!("{prefix}args.{index}"), session_origin());
        }
        for index in 0..expected
            .get("enabled_tools")
            .and_then(Value::as_array)
            .map_or(0, Vec::len)
        {
            origins.insert(format!("{prefix}enabled_tools.{index}"), session_origin());
        }
        origins.insert("web_search".to_owned(), session_origin());
        origins.insert("tools.web_search".to_owned(), session_origin());
        origins
    }

    fn config_read_response(config: Value, origins: Map<String, Value>) -> Value {
        json!({
            "id": 2,
            "result": {"config": config, "origins": origins},
        })
    }

    #[cfg(unix)]
    fn shell_quote(path: &Path) -> String {
        format!("'{}'", path.to_string_lossy().replace('\'', "'\"'\"'"))
    }

    #[cfg(unix)]
    fn write_fake_codex(
        root: &Path,
        first_response: &Path,
        second_response: &Path,
        counter: &Path,
        missing_disable_sentinel: &Path,
        inherited_startup: &Path,
    ) -> PathBuf {
        let executable = root.join("fake-codex");
        let script = format!(
            r#"#!/bin/sh
count=0
if [ -f {counter} ]; then count=$(cat {counter}); fi
count=$((count + 1))
printf '%s' "$count" > {counter}
response={first}
if [ "$count" -eq 2 ]; then
  response={second}
  missing=0
  case "$*" in *'"evil_mcp"={{enabled=false}}'*) ;; *) missing=1 ;; esac
  case "$*" in *'"evil_app"={{enabled=false}}'*) ;; *) missing=1 ;; esac
  case "$*" in *'"evil_plugin"={{enabled=false}}'*) ;; *) missing=1 ;; esac
  if [ "$missing" -eq 1 ]; then
    : > {sentinel}
    {startup}
  fi
fi
while IFS= read -r line; do
  case "$line" in
    *'"method":"config/read"'*) cat "$response" ;;
    *'"method":"initialize"'*|*'"method":"initialized"'*) ;;
    *) {startup} ;;
  esac
done
"#,
            counter = shell_quote(counter),
            first = shell_quote(first_response),
            second = shell_quote(second_response),
            sentinel = shell_quote(missing_disable_sentinel),
            startup = shell_quote(inherited_startup),
        );
        fs::write(&executable, script).unwrap();
        let mut permissions = fs::metadata(&executable).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&executable, permissions).unwrap();
        executable
    }

    #[test]
    fn raw_response_is_kept_in_memory_but_safe_inventory_never_retains_secrets() {
        let secret = "do-not-retain";
        let response = json!({
            "id": 2,
            "result": {
                "config": {
                    "mcp_servers": {"remote": {"url": "https://example.invalid", "bearer_token": secret}},
                    "apps": {}, "plugins": {}
                },
                "origins": {"mcp_servers.remote.url": {"name": {"type": "user"}}}
            }
        });
        let raw = read_config_response(Cursor::new(format!("{response}\n"))).unwrap();
        let inventory = safe_inventory(&raw).unwrap();
        drop(raw);
        let debug = format!("{inventory:?}");
        assert!(!debug.contains(secret));
        assert_eq!(
            inventory.mcp_servers["remote"],
            BTreeSet::from(["user".to_owned()])
        );
    }

    #[test]
    fn runtime_comparison_rejects_any_extra_secret_field_generically() {
        let secret = "SECRET_SENTINEL";
        let runtime = json!({
            "command": "/bin/echo", "args": ["agent-mcp"], "environment_id": "local",
            "enabled": true, "required": true, "startup_timeout_sec": 10.0,
            "tool_timeout_sec": 3660.0, "default_tools_approval_mode": "approve",
            "enabled_tools": ["context"]
        });
        let mut hostile = runtime.clone();
        hostile
            .as_object_mut()
            .unwrap()
            .insert("bearer_token".to_owned(), json!(secret));
        let disabled = HARDENED_DISABLED_FEATURES
            .iter()
            .map(|v| (*v).to_owned())
            .collect::<Vec<_>>();
        let mut servers = Map::new();
        servers.insert(RUNTIME_MCP_SERVER_ID.to_owned(), hostile);
        let config = json!({
            "mcp_servers": servers,
            "apps": {}, "plugins": {}, "features": disabled.iter().map(|f| (f.clone(), Value::Bool(false))).collect::<Map<_,_>>(),
            "include_apps_instructions": false, "include_collaboration_mode_instructions": false,
            "hooks": {}, "web_search": "disabled", "tools": {"web_search": null},
            "default_permissions": ":read-only", "approval_policy": "never",
            "shell_environment_policy": exact_shell_policy(),
        });
        let inventory = SafeInventory {
            mcp_servers: BTreeMap::new(),
            apps: BTreeSet::new(),
            plugins: BTreeSet::new(),
        };
        let origins = Map::from_iter([
            (
                "mcp_servers.koni_runtime.command".to_owned(),
                session_origin(),
            ),
            (
                "mcp_servers.koni_runtime.args.0".to_owned(),
                session_origin(),
            ),
            (
                "mcp_servers.koni_runtime.enabled".to_owned(),
                session_origin(),
            ),
            (
                "mcp_servers.koni_runtime.required".to_owned(),
                session_origin(),
            ),
            (
                "mcp_servers.koni_runtime.startup_timeout_sec".to_owned(),
                session_origin(),
            ),
            (
                "mcp_servers.koni_runtime.tool_timeout_sec".to_owned(),
                session_origin(),
            ),
            (
                "mcp_servers.koni_runtime.default_tools_approval_mode".to_owned(),
                session_origin(),
            ),
            (
                "mcp_servers.koni_runtime.supports_parallel_tool_calls".to_owned(),
                session_origin(),
            ),
            (
                "mcp_servers.koni_runtime.enabled_tools.0".to_owned(),
                session_origin(),
            ),
            ("web_search".to_owned(), session_origin()),
            ("tools.web_search".to_owned(), session_origin()),
        ]);
        let raw = RawConfigRead {
            config: config.as_object().unwrap().clone(),
            origins: Some(origins),
        };
        let error = validate_second_pass(
            &raw,
            &inventory,
            Some(&runtime),
            None,
            ":read-only",
            "never",
            false,
            &disabled,
            &[],
        )
        .unwrap_err()
        .to_string();
        assert!(!error.contains(secret));
        assert!(error.contains("differs from the compiler-owned launch boundary"));
    }

    #[test]
    fn resource_table_assignments_quote_untrusted_resource_ids() {
        assert_eq!(
            resource_table_assignment("mcp_servers", ["odd.id\"value"].into_iter(), None)
                .unwrap()
                .unwrap(),
            "mcp_servers={\"odd.id\\\"value\"={enabled=false}}"
        );
    }

    #[test]
    fn config_read_protocol_uses_camel_case_layers_and_errors_are_secret_safe() {
        let secret = "sensitive-config-value";
        let input = format!("{}\n", json!({"id": 2, "error": {"message": secret}}));
        let error = match read_config_response(Cursor::new(input)) {
            Ok(_) => panic!("error response unexpectedly passed preflight"),
            Err(error) => error.to_string(),
        };
        assert!(!error.contains(secret));
        let source = include_str!("codex_preflight.rs");
        assert!(source.contains("\"includeLayers\": true"));
    }

    #[cfg(unix)]
    #[test]
    fn hostile_inherited_resources_are_disabled_before_the_verified_launch_boundary() {
        let temp = tempfile::TempDir::new().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let startup_sentinel = root.join("inherited-resource-started");
        let startup = root.join("evil-startup");
        fs::write(
            &startup,
            format!("#!/bin/sh\n: > {}\n", shell_quote(&startup_sentinel)),
        )
        .unwrap();
        let mut startup_permissions = fs::metadata(&startup).unwrap().permissions();
        startup_permissions.set_mode(0o700);
        fs::set_permissions(&startup, startup_permissions).unwrap();

        let first = config_read_response(
            json!({
                "mcp_servers": {
                    "evil_mcp": {"command": startup, "enabled": true, "bearer_token": "INHERITED_SECRET"}
                },
                "apps": {"evil_app": {"enabled": true}},
                "plugins": {"evil_plugin": {"enabled": true}},
            }),
            Map::from_iter([(
                "mcp_servers.evil_mcp.command".to_owned(),
                json!({"name": {"type": "user"}}),
            )]),
        );
        let runtime = RuntimeMcpExpectation {
            command: PathBuf::from("/bin/echo"),
            args: vec![
                "agent-mcp".to_owned(),
                "--grant".to_owned(),
                "opaque-test".to_owned(),
            ],
            enabled_tools: vec!["context".to_owned()],
        };
        let normalized_runtime = normalized_runtime_expectation(&runtime).unwrap();
        let second = config_read_response(
            exact_hardened_config(
                Some(normalized_runtime.clone()),
                Some(("evil_mcp", false)),
                Some(("evil_app", false)),
                Some(("evil_plugin", false)),
            ),
            runtime_origins(&normalized_runtime),
        );
        let first_path = root.join("first.jsonl");
        let second_path = root.join("second.jsonl");
        fs::write(&first_path, format!("{first}\n")).unwrap();
        fs::write(&second_path, format!("{second}\n")).unwrap();
        let counter = root.join("calls");
        let missing_disable = root.join("missing-disable");
        let fake = write_fake_codex(
            &root,
            &first_path,
            &second_path,
            &counter,
            &missing_disable,
            &startup,
        );

        let boundary = verify_effective_codex_config(CodexConfigPreflightRequest {
            executable: &fake,
            cwd: &root,
            base_config_overrides: &[],
            additional_disabled_features: &[],
            additional_enabled_features: &[],
            expected_runtime: Some(runtime),
            expected_permission: None,
            expected_default_permissions: ":read-only".to_owned(),
            expected_approval_policy: "never".to_owned(),
            expected_web_search: false,
            timeout: Some(Duration::from_secs(2)),
        })
        .unwrap();

        assert_eq!(fs::read_to_string(&counter).unwrap(), "2");
        assert!(
            !startup_sentinel.exists(),
            "inventory must never start inherited MCP resources"
        );
        assert!(
            !missing_disable.exists(),
            "pass two must carry every inherited resource disable"
        );
        for (table, id) in [
            ("mcp_servers", "evil_mcp"),
            ("apps", "evil_app"),
            ("plugins", "evil_plugin"),
        ] {
            assert!(boundary.config_overrides.iter().any(|assignment| {
                assignment.starts_with(&format!("{table}={{"))
                    && assignment.contains(&format!("\"{id}\"={{enabled=false}}"))
            }));
        }
    }

    #[cfg(unix)]
    #[test]
    fn inherited_reserved_runtime_fails_after_inventory_without_a_second_pass() {
        let temp = tempfile::TempDir::new().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let secret = "RESERVED_RUNTIME_SECRET_SENTINEL";
        let first = config_read_response(
            json!({
                "mcp_servers": {
                    (RUNTIME_MCP_SERVER_ID): {
                        "command": "/tmp/hostile-runtime",
                        "enabled": true,
                        "bearer_token": secret,
                    }
                },
                "apps": {},
                "plugins": {},
            }),
            Map::new(),
        );
        let second = config_read_response(json!({}), Map::new());
        let first_path = root.join("first.jsonl");
        let second_path = root.join("second.jsonl");
        fs::write(&first_path, format!("{first}\n")).unwrap();
        fs::write(&second_path, format!("{second}\n")).unwrap();
        let counter = root.join("calls");
        let second_pass_sentinel = root.join("second-pass");
        let fake = write_fake_codex(
            &root,
            &first_path,
            &second_path,
            &counter,
            &second_pass_sentinel,
            Path::new("/usr/bin/false"),
        );

        let error = verify_effective_codex_config(CodexConfigPreflightRequest {
            executable: &fake,
            cwd: &root,
            base_config_overrides: &[],
            additional_disabled_features: &[],
            additional_enabled_features: &[],
            expected_runtime: None,
            expected_permission: None,
            expected_default_permissions: ":read-only".to_owned(),
            expected_approval_policy: "never".to_owned(),
            expected_web_search: false,
            timeout: Some(Duration::from_secs(2)),
        })
        .unwrap_err()
        .to_string();

        assert_eq!(fs::read_to_string(&counter).unwrap(), "1");
        assert!(!second_pass_sentinel.exists());
        assert!(!error.contains(secret));
        assert!(error.contains("reserved Koni runtime MCP identity"));
    }

    #[test]
    #[ignore = "requires the locally installed Codex app-server"]
    fn installed_codex_accepts_the_exact_two_pass_boundary() {
        use crate::agent::ReadOnlyCodexScratch;

        let codex = std::env::var_os("PATH")
            .into_iter()
            .flat_map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
            .map(|directory| directory.join("codex"))
            .find(|candidate| candidate.is_file())
            .expect("Codex is installed on PATH");
        let temp = tempfile::TempDir::new().unwrap();
        for expected_web_search in [false, true] {
            let base = vec![format!(
                "permissions={{koni_agent={{extends=\":workspace\",filesystem={{\":workspace_roots\"={{\".koni\"=\"read\"}}}},network={{enabled={expected_web_search}}}}}}}"
            )];
            let boundary = verify_effective_codex_config(CodexConfigPreflightRequest {
                executable: &codex,
                cwd: temp.path(),
                base_config_overrides: &base,
                additional_disabled_features: &[],
                additional_enabled_features: &[],
                expected_runtime: Some(RuntimeMcpExpectation {
                    command: PathBuf::from("/bin/echo"),
                    args: vec![
                        "agent-mcp".to_owned(),
                        "--grant".to_owned(),
                        "test".to_owned(),
                    ],
                    enabled_tools: vec!["context".to_owned()],
                }),
                expected_permission: Some(PermissionProfileExpectation::workspace(
                    "koni_agent",
                    BTreeMap::from([(".koni".to_owned(), "read".to_owned())]),
                    expected_web_search,
                )),
                expected_default_permissions: "koni_agent".to_owned(),
                expected_approval_policy: "never".to_owned(),
                expected_web_search,
                timeout: Some(Duration::from_secs(10)),
            })
            .unwrap();
            assert!(boundary.config_overrides.iter().any(|assignment| {
                assignment.starts_with("mcp_servers={")
                    && assignment.contains("supports_parallel_tool_calls=false")
            }));
            assert!(boundary.config_overrides.iter().any(|assignment| {
                assignment
                    == &format!(
                        "web_search=\"{}\"",
                        if expected_web_search {
                            "live"
                        } else {
                            "disabled"
                        }
                    )
            }));
        }

        let scratch = ReadOnlyCodexScratch::create(&[temp.path()]).unwrap();
        verify_effective_codex_config(CodexConfigPreflightRequest {
            executable: &codex,
            cwd: temp.path(),
            base_config_overrides: &scratch.codex_config_assignments(),
            additional_disabled_features: &[],
            additional_enabled_features: &[],
            expected_runtime: None,
            expected_permission: Some(
                PermissionProfileExpectation::read_only_scratch(
                    scratch.profile_name(),
                    scratch.path(),
                )
                .unwrap(),
            ),
            expected_default_permissions: scratch.profile_name().to_owned(),
            expected_approval_policy: "never".to_owned(),
            expected_web_search: false,
            timeout: Some(Duration::from_secs(10)),
        })
        .unwrap();
    }
}
