//! Multi-provider credential storage: which of `recurse_agent::providers`'
//! catalog entries the user has configured (an API key, or an OAuth
//! token from `recurse_agent::oauth`), and resolving the active one into
//! the `LlmConfig` the agent run loop actually consumes.
//!
//! Backward compatible by construction: when no provider has ever been
//! selected (`config::active_provider()` is `None`, true for every
//! install that predates this feature), [`resolve_llm_config`] falls
//! straight through to `config::llm_config()` — the original
//! OpenRouter-only path — unchanged.

use rusqlite::params;
use serde::Serialize;

use recurse_agent::agent::{LlmConfig, Protocol};
use recurse_agent::oauth::TokenSet;
use recurse_agent::providers::{self, AuthKind};

use crate::config;
use crate::db;

/// One provider's stored credential, however it's shaped.
enum Credential {
    ApiKey(String),
    OAuth(TokenSet),
    None,
}

fn load_credential(provider_id: &str) -> Credential {
    let Ok(conn) = db::connect() else {
        return Credential::None;
    };
    let row: Option<(Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT api_key, oauth_json FROM provider_credentials WHERE provider_id = ?1",
            params![provider_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok();
    match row {
        Some((Some(key), _)) if !key.is_empty() => Credential::ApiKey(key),
        Some((_, Some(oauth_json))) => serde_json::from_str::<TokenSet>(&oauth_json)
            .map(Credential::OAuth)
            .unwrap_or(Credential::None),
        _ => Credential::None,
    }
}

fn store_row(
    provider_id: &str,
    api_key: Option<&str>,
    oauth_json: Option<&str>,
) -> Result<(), String> {
    let conn = db::connect()?;
    conn.execute(
        "INSERT INTO provider_credentials (provider_id, api_key, oauth_json, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (provider_id) DO UPDATE SET api_key = excluded.api_key,
                                                   oauth_json = excluded.oauth_json,
                                                   updated_at = excluded.updated_at",
        params![provider_id, api_key, oauth_json, db::now()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Save (or, with `key: None`, clear) an API key for `provider_id`.
pub fn save_api_key(provider_id: &str, key: Option<String>) -> Result<(), String> {
    let trimmed = key.as_deref().map(str::trim).filter(|k| !k.is_empty());
    store_row(provider_id, trimmed, None)
}

/// Save an OAuth token set for `provider_id`, replacing any previous one.
pub fn save_oauth_token(provider_id: &str, token: &TokenSet) -> Result<(), String> {
    let json = serde_json::to_string(token).map_err(|e| e.to_string())?;
    store_row(provider_id, None, Some(&json))
}

/// Clear any stored credential for `provider_id`.
pub fn clear_credential(provider_id: &str) -> Result<(), String> {
    let conn = db::connect()?;
    conn.execute(
        "DELETE FROM provider_credentials WHERE provider_id = ?1",
        params![provider_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// One entry in the provider list the settings UI renders.
#[derive(Serialize)]
pub struct ProviderStatus {
    pub id: String,
    pub name: String,
    /// `"api_key"` | `"oauth_anthropic"` | `"oauth_github_copilot"` | `"local"`
    pub auth_kind: String,
    pub docs_url: String,
    /// True when this provider has a usable credential stored right now
    /// (an API key, or an OAuth token — expired-but-refreshable still
    /// counts, since [`resolve_llm_config`] refreshes transparently).
    pub configured: bool,
    /// Unix seconds, for an OAuth credential with a known expiry — lets
    /// the UI show "reconnect soon" without exposing the token itself.
    pub oauth_expires_at: Option<i64>,
    pub is_active: bool,
}

fn auth_kind_str(kind: AuthKind) -> &'static str {
    match kind {
        AuthKind::ApiKey | AuthKind::AnthropicApiKey => "api_key",
        AuthKind::OAuthAnthropic => "oauth_anthropic",
        AuthKind::OAuthGithubCopilot => "oauth_github_copilot",
        AuthKind::Local => "local",
    }
}

/// Every catalog provider, with its current configuration status.
#[must_use]
pub fn list_status() -> Vec<ProviderStatus> {
    let active = config::active_provider();
    providers::PROVIDERS
        .iter()
        .map(|p| {
            let (configured, oauth_expires_at) = match load_credential(p.id) {
                Credential::ApiKey(_) => (true, None),
                Credential::OAuth(t) => (true, t.expires_at),
                Credential::None => (p.auth == AuthKind::Local, None),
            };
            ProviderStatus {
                id: p.id.to_string(),
                name: p.name.to_string(),
                auth_kind: auth_kind_str(p.auth).to_string(),
                docs_url: p.docs_url.to_string(),
                configured,
                oauth_expires_at,
                is_active: active.as_deref() == Some(p.id),
            }
        })
        .collect()
}

/// Resolve the runtime `LlmConfig` for whichever provider is active.
///
/// - No provider ever selected (`config::active_provider()` is `None`):
///   the original single-provider path, unchanged
///   (`config::llm_config()` — OpenRouter via legacy config keys).
/// - An `ApiKey`/`Local` provider: build an OpenAI-compatible config
///   pointed at that provider's base URL, with its stored key (or none,
///   for a local server).
/// - `AnthropicApiKey`: build a [`Protocol::AnthropicNative`] config
///   pointed at that provider's base URL with its stored API key.
/// - `OAuthAnthropic`: refresh the stored token if it's expiring, then
///   build an [`Protocol::AnthropicNative`] config against Anthropic's
///   own Messages API endpoint.
/// - `OAuthGithubCopilot`: refresh the Copilot session token if expiring
///   (the long-lived `ghu_` token is stored as `TokenSet::refresh_token`
///   specifically to make this possible without a fresh login), then
///   build an OpenAI-compatible config against Copilot's chat endpoint
///   with its required extra headers.
///
/// A refresh failure degrades to the last-known (possibly expired)
/// token rather than erroring — the request itself will surface an auth
/// failure the UI can act on, which is more informative than silently
/// falling back to no LLM at all.
pub async fn resolve_llm_config() -> LlmConfig {
    let Some(provider_id) = config::active_provider() else {
        return config::llm_config();
    };
    let Some(preset) = providers::find(&provider_id) else {
        return config::llm_config();
    };
    let model = config::load().model.unwrap_or_default();

    match preset.auth {
        AuthKind::ApiKey | AuthKind::Local => {
            let key = match load_credential(preset.id) {
                Credential::ApiKey(k) => Some(k),
                _ => None,
            };
            LlmConfig::new(preset.base_url.to_string(), key, model)
        }
        AuthKind::AnthropicApiKey => {
            let key = match load_credential(preset.id) {
                Credential::ApiKey(k) => Some(k),
                _ => None,
            };
            LlmConfig::new(preset.base_url.to_string(), key, model)
                .with_protocol(Protocol::AnthropicNative)
        }
        AuthKind::OAuthAnthropic => {
            let token = match load_credential(preset.id) {
                Credential::OAuth(t) => t,
                _ => return config::llm_config(),
            };
            let token = refresh_if_needed_anthropic(preset.id, token).await;
            LlmConfig::new(
                recurse_agent::anthropic::DEFAULT_BASE_URL.to_string(),
                Some(token.access_token),
                model,
            )
            .with_protocol(Protocol::AnthropicNative)
        }
        AuthKind::OAuthGithubCopilot => {
            let token = match load_credential(preset.id) {
                Credential::OAuth(t) => t,
                _ => return config::llm_config(),
            };
            let token = refresh_if_needed_copilot(preset.id, token).await;
            let headers: Vec<(String, String)> = preset
                .extra_headers
                .iter()
                .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
                .collect();
            LlmConfig::new(preset.base_url.to_string(), Some(token.access_token), model)
                .with_extra_headers(headers)
        }
    }
}

/// 60s skew: refresh a little before real expiry so an in-flight request
/// never races against a token that just went stale.
const REFRESH_SKEW_SECS: i64 = 60;

async fn refresh_if_needed_anthropic(provider_id: &str, token: TokenSet) -> TokenSet {
    if !token.is_expired(REFRESH_SKEW_SECS) {
        return token;
    }
    match recurse_agent::oauth::anthropic::refresh(&token).await {
        Ok(fresh) => {
            let _ = save_oauth_token(provider_id, &fresh);
            fresh
        }
        Err(_) => token,
    }
}

async fn refresh_if_needed_copilot(provider_id: &str, token: TokenSet) -> TokenSet {
    if !token.is_expired(REFRESH_SKEW_SECS) {
        return token;
    }
    let Some(ghu) = token.refresh_token.clone() else {
        return token;
    };
    match recurse_agent::oauth::github_copilot::exchange_copilot_token(&ghu).await {
        Ok(fresh) => {
            let _ = save_oauth_token(provider_id, &fresh);
            fresh
        }
        Err(_) => token,
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
    use std::future::Future;

    use super::*;

    fn block_on<F: Future>(fut: F) -> F::Output {
        tokio::runtime::Runtime::new()
            .expect("tokio runtime")
            .block_on(fut)
    }

    #[test]
    fn api_key_round_trips_through_storage() {
        crate::testhome::with_test_home(|_| {
            save_api_key("openai", Some("sk-test-123".to_string())).expect("save");
            match load_credential("openai") {
                Credential::ApiKey(k) => assert_eq!(k, "sk-test-123"),
                _ => panic!("expected an api key credential"),
            }
        });
    }

    #[test]
    fn saving_an_empty_key_clears_it() {
        crate::testhome::with_test_home(|_| {
            save_api_key("openai", Some("sk-real".to_string())).expect("save");
            save_api_key("openai", Some("   ".to_string())).expect("save empty");
            assert!(matches!(load_credential("openai"), Credential::None));
        });
    }

    #[test]
    fn oauth_token_round_trips_through_storage() {
        crate::testhome::with_test_home(|_| {
            let token = TokenSet {
                access_token: "at".to_string(),
                refresh_token: Some("rt".to_string()),
                expires_at: Some(1_999_999_999),
            };
            save_oauth_token("anthropic-oauth", &token).expect("save");
            match load_credential("anthropic-oauth") {
                Credential::OAuth(t) => {
                    assert_eq!(t.access_token, "at");
                    assert_eq!(t.refresh_token.as_deref(), Some("rt"));
                    assert_eq!(t.expires_at, Some(1_999_999_999));
                }
                _ => panic!("expected an oauth credential"),
            }
        });
    }

    #[test]
    fn clear_credential_removes_it() {
        crate::testhome::with_test_home(|_| {
            save_api_key("groq", Some("gsk-x".to_string())).expect("save");
            clear_credential("groq").expect("clear");
            assert!(matches!(load_credential("groq"), Credential::None));
        });
    }

    #[test]
    fn list_status_marks_local_providers_configured_by_default() {
        crate::testhome::with_test_home(|_| {
            let statuses = list_status();
            let ollama = statuses.iter().find(|s| s.id == "ollama").expect("present");
            assert!(
                ollama.configured,
                "a local runtime needs no key to be usable"
            );
        });
    }

    #[test]
    fn list_status_reflects_a_saved_api_key() {
        crate::testhome::with_test_home(|_| {
            save_api_key("openai", Some("sk-x".to_string())).expect("save");
            let statuses = list_status();
            let openai = statuses.iter().find(|s| s.id == "openai").expect("present");
            assert!(openai.configured);
            let groq = statuses.iter().find(|s| s.id == "groq").expect("present");
            assert!(
                !groq.configured,
                "an unrelated provider must not appear configured"
            );
        });
    }

    #[test]
    fn list_status_reports_the_active_provider() {
        crate::testhome::with_test_home(|_| {
            config::set_active_provider(Some("openai".to_string())).expect("set active");
            let statuses = list_status();
            assert!(
                statuses
                    .iter()
                    .find(|s| s.id == "openai")
                    .expect("present")
                    .is_active
            );
            assert!(
                !statuses
                    .iter()
                    .find(|s| s.id == "groq")
                    .expect("present")
                    .is_active
            );
        });
    }

    #[test]
    fn resolve_llm_config_falls_back_to_the_legacy_path_when_no_provider_is_active() {
        crate::testhome::with_test_home(|_| {
            let resolved = block_on(resolve_llm_config());
            let legacy = config::llm_config();
            assert_eq!(resolved.endpoint, legacy.endpoint);
        });
    }

    #[test]
    fn resolve_llm_config_builds_an_openai_compatible_config_for_an_api_key_provider() {
        crate::testhome::with_test_home(|_| {
            config::set_active_provider(Some("groq".to_string())).expect("set active");
            save_api_key("groq", Some("gsk-real".to_string())).expect("save key");
            let resolved = block_on(resolve_llm_config());
            assert_eq!(resolved.protocol, Protocol::OpenAiCompatible);
            assert!(resolved.endpoint.starts_with("https://api.groq.com"));
            assert_eq!(resolved.api_key.as_deref(), Some("gsk-real"));
        });
    }

    #[test]
    fn resolve_llm_config_returns_anthropic_native_protocol_for_a_valid_oauth_token() {
        crate::testhome::with_test_home(|_| {
            config::set_active_provider(Some("anthropic-oauth".to_string())).expect("set active");
            let far_future = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs() as i64
                + 3600;
            save_oauth_token(
                "anthropic-oauth",
                &TokenSet {
                    access_token: "at".to_string(),
                    refresh_token: None,
                    expires_at: Some(far_future),
                },
            )
            .expect("save token");
            let resolved = block_on(resolve_llm_config());
            assert_eq!(resolved.protocol, Protocol::AnthropicNative);
            assert_eq!(resolved.api_key.as_deref(), Some("at"));
        });
    }

    #[test]
    fn resolve_llm_config_carries_copilot_extra_headers() {
        crate::testhome::with_test_home(|_| {
            config::set_active_provider(Some("github-copilot".to_string())).expect("set active");
            let far_future = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs() as i64
                + 3600;
            save_oauth_token(
                "github-copilot",
                &TokenSet {
                    access_token: "session".to_string(),
                    refresh_token: Some("ghu_x".to_string()),
                    expires_at: Some(far_future),
                },
            )
            .expect("save token");
            let resolved = block_on(resolve_llm_config());
            assert_eq!(resolved.protocol, Protocol::OpenAiCompatible);
            assert!(resolved
                .extra_headers
                .iter()
                .any(|(k, _)| k == "Editor-Version"));
        });
    }
}
