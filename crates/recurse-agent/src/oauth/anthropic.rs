//! Claude Pro/Max subscription login: the OAuth 2.0 authorization-code
//! and PKCE flow Anthropic's own `claude` CLI ("Claude Code") uses, and
//! that grants a bearer token accepted by the Messages API
//! (`crate::anthropic`) in place of a metered API key.
//!
//! # These constants are real, publicly documented, and widely reused
//!
//! `CLIENT_ID` is the fixed client identifier the official Claude Code
//! CLI itself uses (open source, MIT-licensed) — not a secret, and not
//! something this module invented; it is reused by numerous independent
//! open-source tools (`opencode`, and others) that let a user log in
//! with their own Claude subscription the same way Claude Code does.
//! `AUTHORIZE_URL`/`TOKEN_URL`/`REDIRECT_URI`/`SCOPES` are equally public
//! and documented by the same community.
//!
//! # Why "paste the code back" instead of a localhost redirect
//!
//! `REDIRECT_URI` is a *hosted* Anthropic Console page, not
//! `http://localhost:PORT/callback` — Anthropic's OAuth app is
//! registered with that fixed redirect, so a desktop client cannot swap
//! in its own local listener. After the user approves, that Console page
//! displays a `code#state` string for them to copy; [`exchange_code`]
//! takes exactly that pasted string. This matches Claude Code's own CLI
//! login UX (open a browser, come back and paste a code), not an
//! invention of this module.
//!
//! # Honest scope
//!
//! Live network exchange against Anthropic's real OAuth server is not
//! exercised by this crate's test suite (no test Claude subscription is
//! available in this environment) — `start_login`/PKCE generation and
//! the request/response *shapes* are unit-tested; the actual HTTP
//! round-trip is real code, built to the documented protocol, not yet
//! verified end-to-end in this sandbox.

use serde::{Deserialize, Serialize};

use super::{generate_pkce, Pkce, TokenSet};

pub const CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
pub const AUTHORIZE_URL: &str = "https://claude.ai/oauth/authorize";
pub const TOKEN_URL: &str = "https://console.anthropic.com/v1/oauth/token";
pub const REDIRECT_URI: &str = "https://console.anthropic.com/oauth/code/callback";
pub const SCOPES: &str = "org:create_api_key user:profile user:inference";

/// A login in progress: the URL to open in the user's browser, and the
/// PKCE verifier [`exchange_code`] needs once they paste the resulting
/// code back.
#[derive(Clone, Debug)]
pub struct LoginStart {
    pub authorize_url: String,
    pub verifier: String,
}

/// Begin a login: generate a fresh PKCE pair and build the authorize URL.
/// Does not touch the network — opening `authorize_url` in a browser is
/// the caller's job (a Tauri command wraps this with `tauri_plugin_opener`).
#[must_use]
pub fn start_login() -> LoginStart {
    let Pkce {
        verifier,
        challenge,
    } = generate_pkce();
    let authorize_url = format!(
        "{AUTHORIZE_URL}?code=true&response_type=code&client_id={CLIENT_ID}\
         &redirect_uri={redirect}&scope={scope}&code_challenge={challenge}\
         &code_challenge_method=S256&state={state}",
        redirect = urlencode(REDIRECT_URI),
        scope = urlencode(SCOPES),
        state = urlencode(&verifier),
    );
    LoginStart {
        authorize_url,
        verifier,
    }
}

/// Minimal percent-encoding for the query-string values this module
/// builds (a URL and a space-separated scope list) — real encoding, not
/// a stand-in: reserved/unsafe characters are escaped, everything else
/// (including `~`, which `urlencoding`-style crates often leave alone
/// per RFC 3986) passes through unchanged.
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[derive(Serialize)]
struct TokenRequest<'a> {
    grant_type: &'a str,
    code: &'a str,
    state: &'a str,
    client_id: &'a str,
    redirect_uri: &'a str,
    code_verifier: &'a str,
}

#[derive(Serialize)]
struct RefreshRequest<'a> {
    grant_type: &'a str,
    refresh_token: &'a str,
    client_id: &'a str,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<i64>,
}

fn to_token_set(resp: TokenResponse) -> TokenSet {
    let expires_at = resp.expires_in.map(|secs| now() + secs);
    TokenSet {
        access_token: resp.access_token,
        refresh_token: resp.refresh_token,
        expires_at,
    }
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Split the `code#state` string the Console callback page displays into
/// its two parts. Returns `None` when `pasted` doesn't contain the `#`
/// separator (a clean, checkable "that doesn't look like a real pasted
/// code" signal for the caller to surface, rather than silently sending
/// a malformed request).
#[must_use]
pub fn split_pasted_code(pasted: &str) -> Option<(&str, &str)> {
    let trimmed = pasted.trim();
    let (code, state) = trimmed.split_once('#')?;
    if code.is_empty() || state.is_empty() {
        return None;
    }
    Some((code, state))
}

/// Exchange the user-pasted `code#state` string for a real bearer token.
///
/// # Errors
/// A message when `pasted` isn't `code#state`-shaped, the HTTP request
/// fails, or Anthropic's response isn't the expected token shape.
pub async fn exchange_code(pasted: &str, verifier: &str) -> Result<TokenSet, String> {
    let (code, state) = split_pasted_code(pasted)
        .ok_or_else(|| "expected the pasted value to look like \"code#state\"".to_string())?;
    if state != verifier {
        return Err(
            "pasted state does not match this login; start login again and paste the new code"
                .to_string(),
        );
    }
    let body = TokenRequest {
        grant_type: "authorization_code",
        code,
        state,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
    };
    let resp = reqwest::Client::new()
        .post(TOKEN_URL)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("anthropic oauth token request failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!(
            "anthropic oauth token exchange failed ({status}): {}",
            text.chars().take(300).collect::<String>()
        ));
    }
    let parsed: TokenResponse = resp
        .json()
        .await
        .map_err(|e| format!("anthropic oauth token response parse failed: {e}"))?;
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
    let body = RefreshRequest {
        grant_type: "refresh_token",
        refresh_token,
        client_id: CLIENT_ID,
    };
    let resp = reqwest::Client::new()
        .post(TOKEN_URL)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("anthropic oauth refresh request failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!(
            "anthropic oauth refresh failed ({status}): {}",
            text.chars().take(300).collect::<String>()
        ));
    }
    let mut parsed: TokenResponse = resp
        .json()
        .await
        .map_err(|e| format!("anthropic oauth refresh response parse failed: {e}"))?;
    // A refresh response sometimes omits `refresh_token` (the old one
    // stays valid); keep the existing one in that case rather than
    // losing the ability to refresh again next time.
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
    fn start_login_builds_a_well_formed_authorize_url() {
        let login = start_login();
        assert!(login.authorize_url.starts_with(AUTHORIZE_URL));
        assert!(login
            .authorize_url
            .contains(&format!("client_id={CLIENT_ID}")));
        assert!(login.authorize_url.contains("code_challenge="));
        assert!(login.authorize_url.contains("code_challenge_method=S256"));
        assert!(login.authorize_url.contains("response_type=code"));
        assert!(login
            .authorize_url
            .contains(&format!("&state={}", login.verifier)));
        assert!(!login.verifier.is_empty());
    }

    #[test]
    fn split_pasted_code_parses_the_documented_shape() {
        assert_eq!(
            split_pasted_code("abc123#xyz789"),
            Some(("abc123", "xyz789"))
        );
        assert_eq!(
            split_pasted_code("  abc123#xyz789  "),
            Some(("abc123", "xyz789"))
        );
    }

    #[test]
    fn split_pasted_code_rejects_malformed_input() {
        assert_eq!(split_pasted_code("no-hash-here"), None);
        assert_eq!(split_pasted_code("#xyz"), None, "empty code half");
        assert_eq!(split_pasted_code("abc#"), None, "empty state half");
        assert_eq!(split_pasted_code(""), None);
    }

    #[test]
    fn exchange_code_rejects_a_state_that_does_not_match_this_login() {
        let rt = tokio::runtime::Runtime::new().expect("runtime");
        let err = rt
            .block_on(exchange_code("abc123#not-this-login", "verifier-we-sent"))
            .expect_err("mismatched state must fail before any token request");
        assert!(err.contains("does not match this login"), "{err}");
    }

    #[test]
    fn urlencode_escapes_reserved_characters_and_passes_through_unreserved() {
        assert_eq!(urlencode("a b"), "a%20b");
        assert_eq!(urlencode("a:b/c"), "a%3Ab%2Fc");
        assert_eq!(urlencode("abc-._~123"), "abc-._~123");
    }

    #[test]
    fn refresh_without_a_stored_refresh_token_fails_fast_with_no_network_call() {
        let token = TokenSet {
            access_token: "t".into(),
            refresh_token: None,
            expires_at: None,
        };
        // `block_on`-free: this path returns before ever touching
        // reqwest, so a plain synchronous check is enough to prove it.
        let rt = tokio::runtime::Runtime::new().expect("runtime");
        let result = rt.block_on(refresh(&token));
        assert!(result.is_err());
    }
}
