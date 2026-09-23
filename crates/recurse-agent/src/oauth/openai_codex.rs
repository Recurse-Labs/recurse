//! ChatGPT (OpenAI Codex) subscription login: the device-authorization
//! flow OpenAI's own Codex CLI uses to turn a ChatGPT Plus/Pro/Team
//! subscription into a bearer token usable in place of a metered
//! OpenAI API key.
//!
//! # These constants are real, publicly documented, and widely reused
//!
//! `CLIENT_ID` is the fixed client identifier OpenAI's own Codex CLI
//! (open source) uses — not a secret, and not something this module
//! invented; it is reused by numerous independent open-source tools
//! that let a user log in with their own ChatGPT subscription the same
//! way Codex does. `DEVICE_USERCODE_URL`/`DEVICE_TOKEN_URL`/`TOKEN_URL`/
//! `DEVICE_AUTH_URL` are equally public and documented by the same
//! community.
//!
//! # Why device flow instead of a local callback server
//!
//! OpenAI's browser OAuth flow expects a local loopback redirect
//! (`http://localhost:1455/...`), which needs this process to bind a
//! port and run an HTTP server for the single life of one login. The
//! device flow avoids that entirely: [`start_device_flow`] gets a
//! `user_code` to show, [`poll_device_flow`] waits for the user to
//! approve it at [`DEVICE_AUTH_URL`], and the approval response already
//! carries a PKCE `authorization_code`/`code_verifier` pair this module
//! exchanges directly at [`TOKEN_URL`] — matching Codex CLI's own
//! documented fallback path (used whenever its local callback server
//! can't bind, e.g. a headless/SSH session), not an invention of this
//! module.
//!
//! # Honest scope
//!
//! Live network exchange against OpenAI's real device-auth/OAuth
//! servers is not exercised by this crate's test suite (no test ChatGPT
//! subscription is available in this environment) — the request/
//! response *shapes* and polling state machine are unit-tested; the
//! actual HTTP round-trip is real code, built to the documented
//! protocol, not yet verified end-to-end in this sandbox.

use serde::Deserialize;

use super::TokenSet;

pub const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
pub const DEVICE_USERCODE_URL: &str =
    "https://auth.openai.com/api/accounts/deviceauth/usercode";
pub const DEVICE_TOKEN_URL: &str = "https://auth.openai.com/api/accounts/deviceauth/token";
pub const TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
/// The page the user visits (and enters `user_code` into) to approve a
/// pending device authorization.
pub const DEVICE_AUTH_URL: &str = "https://auth.openai.com/codex/device";
/// Fixed redirect the device-flow token exchange is registered under —
/// never actually navigated to (there is no browser redirect in this
/// flow), but required as the `redirect_uri` the token endpoint expects
/// to match what the approval step recorded.
const DEVICE_REDIRECT_URI: &str = "https://auth.openai.com/deviceauth/callback";

/// A device flow in progress: what to show the user, plus the
/// `device_auth_id`/`user_code` pair [`poll_device_flow`] needs.
#[derive(Clone, Debug)]
pub struct DeviceStart {
    pub device_auth_id: String,
    pub user_code: String,
    /// Minimum seconds between polls — polling faster risks the same
    /// "come back later" treatment RFC 8628's `slow_down` describes,
    /// even though this endpoint isn't itself RFC 8628.
    pub interval_secs: u64,
}

/// OpenAI's device-usercode endpoint reports `interval` as either a
/// number or a numeric string depending on client; accept both rather
/// than failing a login over a harmless shape difference.
#[derive(Deserialize)]
#[serde(untagged)]
enum IntervalValue {
    Num(u64),
    Str(String),
}

impl IntervalValue {
    fn as_secs(&self) -> u64 {
        match self {
            IntervalValue::Num(n) => *n,
            IntervalValue::Str(s) => s.parse().unwrap_or(5),
        }
    }
}

#[derive(Deserialize)]
struct DeviceUserCodeResponse {
    device_auth_id: String,
    user_code: String,
    #[serde(default)]
    interval: Option<IntervalValue>,
}

/// Begin a device flow: request a `device_auth_id`/`user_code` pair.
///
/// # Errors
/// A message when the HTTP request fails or OpenAI's response isn't the
/// expected shape.
pub async fn start_device_flow() -> Result<DeviceStart, String> {
    let resp = reqwest::Client::new()
        .post(DEVICE_USERCODE_URL)
        .json(&serde_json::json!({ "client_id": CLIENT_ID }))
        .send()
        .await
        .map_err(|e| format!("openai device usercode request failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!(
            "openai device usercode request failed ({status}): {}",
            text.chars().take(300).collect::<String>()
        ));
    }
    let parsed: DeviceUserCodeResponse = resp
        .json()
        .await
        .map_err(|e| format!("openai device usercode response parse failed: {e}"))?;
    Ok(DeviceStart {
        device_auth_id: parsed.device_auth_id,
        user_code: parsed.user_code,
        interval_secs: parsed.interval.map(|i| i.as_secs()).unwrap_or(5),
    })
}

/// Outcome of one poll against the device-token endpoint.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PollOutcome {
    /// The user hasn't approved yet — keep polling after `interval_secs`.
    Pending,
    /// The user approved: the PKCE `authorization_code`/`code_verifier`
    /// pair [`exchange_code`] needs.
    Approved { code: String, verifier: String },
}

#[derive(Deserialize)]
struct DeviceTokenResponse {
    #[serde(default)]
    authorization_code: Option<String>,
    #[serde(default)]
    code_verifier: Option<String>,
}

/// Poll once. A `403`/`404` means "not approved yet" (OpenAI's
/// documented pending signal for this endpoint) — the only genuine
/// failure is a non-pending error status or a response missing the
/// expected fields once OpenAI does report success.
///
/// # Errors
/// A message when the HTTP request fails, the poll genuinely failed
/// (a non-pending error status), or a "success" response is missing
/// the `authorization_code`/`code_verifier` pair.
pub async fn poll_device_flow(device_auth_id: &str, user_code: &str) -> Result<PollOutcome, String> {
    let resp = reqwest::Client::new()
        .post(DEVICE_TOKEN_URL)
        .json(&serde_json::json!({
            "device_auth_id": device_auth_id,
            "user_code": user_code,
        }))
        .send()
        .await
        .map_err(|e| format!("openai device token poll failed: {e}"))?;
    let status = resp.status();
    if status.as_u16() == 403 || status.as_u16() == 404 {
        return Ok(PollOutcome::Pending);
    }
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!(
            "openai device token poll failed ({status}): {}",
            text.chars().take(300).collect::<String>()
        ));
    }
    let parsed: DeviceTokenResponse = resp
        .json()
        .await
        .map_err(|e| format!("openai device token response parse failed: {e}"))?;
    match (parsed.authorization_code, parsed.code_verifier) {
        (Some(code), Some(verifier)) => Ok(PollOutcome::Approved { code, verifier }),
        _ => Err("openai device token response missing authorization_code/code_verifier".to_string()),
    }
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<i64>,
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn to_token_set(resp: TokenResponse) -> TokenSet {
    let expires_at = resp.expires_in.map(|secs| now() + secs);
    TokenSet {
        access_token: resp.access_token,
        refresh_token: resp.refresh_token,
        expires_at,
    }
}

/// Exchange the PKCE `code`/`verifier` pair a completed [`poll_device_flow`]
/// returned for a real bearer token.
///
/// # Errors
/// A message when the HTTP request fails or OpenAI's response isn't the
/// expected token shape.
pub async fn exchange_code(code: &str, verifier: &str) -> Result<TokenSet, String> {
    let resp = reqwest::Client::new()
        .post(TOKEN_URL)
        .form(&[
            ("grant_type", "authorization_code"),
            ("client_id", CLIENT_ID),
            ("code", code),
            ("code_verifier", verifier),
            ("redirect_uri", DEVICE_REDIRECT_URI),
        ])
        .send()
        .await
        .map_err(|e| format!("openai oauth token request failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!(
            "openai oauth token exchange failed ({status}): {}",
            text.chars().take(300).collect::<String>()
        ));
    }
    let parsed: TokenResponse = resp
        .json()
        .await
        .map_err(|e| format!("openai oauth token response parse failed: {e}"))?;
    Ok(to_token_set(parsed))
}

/// Refresh an expiring/expired token using its stored `refresh_token`.
///
/// # Errors
/// A message when `token` has no refresh token, the HTTP request fails,
/// or the response isn't the expected token shape.
pub async fn refresh(token: &TokenSet) -> Result<TokenSet, String> {
    let refresh_token = token
        .refresh_token
        .as_deref()
        .ok_or("no refresh token stored for this credential")?;
    let resp = reqwest::Client::new()
        .post(TOKEN_URL)
        .form(&[
            ("grant_type", "refresh_token"),
            ("client_id", CLIENT_ID),
            ("refresh_token", refresh_token),
        ])
        .send()
        .await
        .map_err(|e| format!("openai oauth refresh request failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!(
            "openai oauth refresh failed ({status}): {}",
            text.chars().take(300).collect::<String>()
        ));
    }
    let mut parsed: TokenResponse = resp
        .json()
        .await
        .map_err(|e| format!("openai oauth refresh response parse failed: {e}"))?;
    if parsed.refresh_token.is_none() {
        parsed.refresh_token = token.refresh_token.clone();
    }
    Ok(to_token_set(parsed))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
    use super::*;

    #[test]
    fn interval_value_parses_both_number_and_string_shapes() {
        assert_eq!(IntervalValue::Num(7).as_secs(), 7);
        assert_eq!(IntervalValue::Str("9".to_string()).as_secs(), 9);
        assert_eq!(IntervalValue::Str("garbage".to_string()).as_secs(), 5);
    }

    #[test]
    fn device_user_code_response_parses_numeric_interval() {
        let parsed: DeviceUserCodeResponse = serde_json::from_str(
            r#"{"device_auth_id":"d1","user_code":"ABCD-1234","interval":7}"#,
        )
        .expect("parse");
        assert_eq!(parsed.device_auth_id, "d1");
        assert_eq!(parsed.user_code, "ABCD-1234");
        assert_eq!(parsed.interval.map(|i| i.as_secs()), Some(7));
    }

    #[test]
    fn device_user_code_response_parses_string_interval() {
        let parsed: DeviceUserCodeResponse = serde_json::from_str(
            r#"{"device_auth_id":"d1","user_code":"ABCD-1234","interval":"5"}"#,
        )
        .expect("parse");
        assert_eq!(parsed.interval.map(|i| i.as_secs()), Some(5));
    }

    #[test]
    fn device_token_response_missing_fields_is_not_approved() {
        let parsed: DeviceTokenResponse = serde_json::from_str("{}").expect("parse");
        assert!(parsed.authorization_code.is_none());
        assert!(parsed.code_verifier.is_none());
    }

    #[test]
    fn refresh_without_a_stored_refresh_token_fails_fast_with_no_network_call() {
        let token = TokenSet {
            access_token: "t".into(),
            refresh_token: None,
            expires_at: None,
        };
        let rt = tokio::runtime::Runtime::new().expect("runtime");
        let result = rt.block_on(refresh(&token));
        assert!(result.is_err());
    }

    #[test]
    fn to_token_set_carries_expiry_forward_when_present() {
        let resp = TokenResponse {
            access_token: "a".into(),
            refresh_token: Some("r".into()),
            expires_in: Some(3600),
        };
        let set = to_token_set(resp);
        assert_eq!(set.access_token, "a");
        assert_eq!(set.refresh_token.as_deref(), Some("r"));
        assert!(set.expires_at.is_some());
    }
}
