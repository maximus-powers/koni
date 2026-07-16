#[cfg(target_os = "macos")]
use std::process::Command;
use std::time::Duration;

use anyhow::{Context, bail};
use koni_core::{
    CredentialBrokerRequest, CredentialBrokerResponse, CredentialLeaseId, OAuthInteraction,
    OAuthLoginFlow, OAuthProvider, OAuthStatus, PI_RUNTIME_PROVIDER_ID, PiRuntimeArtifact,
    PiRuntimeBootstrapRequest, PiRuntimeProcess,
};
use serde_json::json;
use uuid::Uuid;

const CONTROL_TIMEOUT: Duration = Duration::from_secs(30);
const LOGIN_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const OPENAI_BROWSER_AUTH_PREFIX: &str = "https://auth.openai.com/oauth/authorize?";

#[derive(Debug, Clone, Copy)]
pub(crate) enum AuthOperation {
    Status,
    Login,
    Logout,
}

pub(crate) fn run_auth(operation: AuthOperation, json_output: bool) -> anyhow::Result<()> {
    let network_access = matches!(operation, AuthOperation::Login);
    let timeout = if network_access {
        LOGIN_TIMEOUT
    } else {
        CONTROL_TIMEOUT
    };
    let mut process = bootstrap_control_process(timeout, network_access, network_access)?;
    let request = auth_request(operation);
    let response = process.authenticate(request, &mut print_auth_interaction)?;
    process.terminate()?;
    if json_output {
        println!("{}", serde_json::to_string_pretty(&response)?);
    } else {
        print_auth_response(&response)?;
    }
    if let CredentialBrokerResponse::Denied { code, message } = response {
        bail!("Pi authentication was denied ({code}): {message}");
    }
    Ok(())
}

fn auth_request(operation: AuthOperation) -> CredentialBrokerRequest {
    match operation {
        AuthOperation::Status => CredentialBrokerRequest::Status {
            provider: OAuthProvider::OpenAiCodex,
        },
        AuthOperation::Login => CredentialBrokerRequest::BeginLogin {
            provider: OAuthProvider::OpenAiCodex,
            preferred_flow: OAuthLoginFlow::BrowserPkce,
        },
        AuthOperation::Logout => CredentialBrokerRequest::Logout {
            provider: OAuthProvider::OpenAiCodex,
        },
    }
}

pub(crate) fn run_models(json_output: bool) -> anyhow::Result<()> {
    let mut process = bootstrap_control_process(CONTROL_TIMEOUT, false, false)?;
    let metadata = process.metadata()?;
    let mut models = process.list_models()?;
    process.terminate()?;
    models.sort_by(|left, right| left.id.cmp(&right.id));
    if json_output {
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({
                "runtime": "pi-sdk",
                "provider": PI_RUNTIME_PROVIDER_ID,
                "host": metadata,
                "models": models,
            }))?
        );
        return Ok(());
    }
    println!(
        "Pi SDK {} · {} model(s)",
        metadata.pi_sdk_version,
        models.len()
    );
    for model in models {
        let thinking = if model.thinking_levels.is_empty() {
            "none".to_owned()
        } else {
            model
                .thinking_levels
                .iter()
                .map(|level| serde_json::to_value(level).expect("thinking level serializes"))
                .filter_map(|level| level.as_str().map(ToOwned::to_owned))
                .collect::<Vec<_>>()
                .join(",")
        };
        println!(
            "{}\tcontext={}\tmax_output={}\tthinking={}",
            model.id, model.context_window, model.max_tokens, thinking
        );
    }
    Ok(())
}

fn bootstrap_control_process(
    timeout: Duration,
    network_access: bool,
    oauth_callback_access: bool,
) -> anyhow::Result<PiRuntimeProcess> {
    let artifact = PiRuntimeArtifact::discover(&[])
        .context("the verified Pi runtime is not installed beside this Koni executable")?;
    let nonce = Uuid::now_v7();
    PiRuntimeProcess::bootstrap(
        PiRuntimeBootstrapRequest {
            artifact,
            transport_session_id: format!("pi-control-{nonce}"),
            credential_lease: CredentialLeaseId(format!("pi-control-lease-{nonce}")),
            timeout,
            network_access,
            oauth_callback_access,
        },
        &mut |_| Ok(()),
    )
    .context("could not start the contained Pi SDK host")
}

fn print_auth_interaction(interaction: &OAuthInteraction) -> koni_core::Result<()> {
    match interaction {
        OAuthInteraction::AuthUrl { url, instructions } => {
            if open_browser_auth_url(url) {
                eprintln!("Opening your browser to sign in with ChatGPT…");
            } else {
                eprintln!("Open {url}");
            }
            if let Some(instructions) = instructions {
                eprintln!("{instructions}");
            }
        }
        OAuthInteraction::DeviceCode {
            user_code,
            verification_uri,
            expires_in_seconds,
            ..
        } => {
            eprintln!("Open {verification_uri}");
            eprintln!("Enter code: {user_code}");
            if let Some(seconds) = expires_in_seconds {
                eprintln!("The code expires in {seconds} seconds.");
            }
        }
        OAuthInteraction::Progress { message } => eprintln!("{message}"),
    }
    Ok(())
}

fn browser_auth_url_is_allowed(url: &str) -> bool {
    url.starts_with(OPENAI_BROWSER_AUTH_PREFIX)
        && url.len() > OPENAI_BROWSER_AUTH_PREFIX.len()
        && !url.chars().any(char::is_whitespace)
}

fn open_browser_auth_url(url: &str) -> bool {
    if !browser_auth_url_is_allowed(url) {
        return false;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("/usr/bin/open")
            .arg(url)
            .status()
            .is_ok_and(|status| status.success())
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

fn print_auth_response(response: &CredentialBrokerResponse) -> anyhow::Result<()> {
    match response {
        CredentialBrokerResponse::Status { status, .. }
        | CredentialBrokerResponse::LoginStarted { status, .. } => match status {
            OAuthStatus::SignedOut => println!("Signed out of OpenAI (ChatGPT subscription)."),
            OAuthStatus::LoginPending {
                verification_uri,
                user_code,
                expires_at,
                ..
            } => println!(
                "OpenAI login is pending{}{} (expires {}).",
                verification_uri
                    .as_deref()
                    .map(|uri| format!(" at {uri}"))
                    .unwrap_or_default(),
                user_code
                    .as_deref()
                    .map(|code| format!(" with code {code}"))
                    .unwrap_or_default(),
                expires_at
            ),
            OAuthStatus::SignedIn {
                account_label,
                expires_at,
            } => println!(
                "Signed in to OpenAI (ChatGPT subscription){}{}.",
                account_label
                    .as_deref()
                    .map(|label| format!(" as {label}"))
                    .unwrap_or_default(),
                expires_at
                    .map(|expires| format!("; credential expires {expires}"))
                    .unwrap_or_default()
            ),
            OAuthStatus::ReauthenticationRequired { reason } => {
                println!("OpenAI reauthentication is required: {reason}")
            }
        },
        CredentialBrokerResponse::LoggedOut { .. } => {
            println!("Signed out of OpenAI and removed the stored subscription credential.")
        }
        CredentialBrokerResponse::LeaseGranted { .. } => {
            bail!("the public auth command received an internal inference lease")
        }
        CredentialBrokerResponse::Denied { code, message } => {
            println!("OpenAI authentication denied ({code}): {message}")
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_uses_pis_default_browser_pkce_flow() {
        assert_eq!(
            auth_request(AuthOperation::Login),
            CredentialBrokerRequest::BeginLogin {
                provider: OAuthProvider::OpenAiCodex,
                preferred_flow: OAuthLoginFlow::BrowserPkce,
            }
        );
    }

    #[test]
    fn browser_launcher_accepts_only_the_pinned_openai_authorization_endpoint() {
        assert!(browser_auth_url_is_allowed(
            "https://auth.openai.com/oauth/authorize?client_id=test"
        ));
        assert!(!browser_auth_url_is_allowed(
            "https://auth.openai.com.evil.invalid/oauth/authorize?client_id=test"
        ));
        assert!(!browser_auth_url_is_allowed(
            "file:///tmp/fake-openai-login.html"
        ));
        assert!(!browser_auth_url_is_allowed(
            "https://auth.openai.com/oauth/authorize?client_id=test\nfile:///tmp/evil"
        ));
    }
}
