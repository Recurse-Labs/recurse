//! OAuth 2.0 flows for the subscription-gated providers Recurse
//! authenticates natively: [`anthropic`] (Claude Pro/Max, PKCE
//! authorization-code flow), [`github_copilot`] (a GitHub Copilot
//! subscription, RFC 8628 device flow), and [`openai_codex`] (a ChatGPT
//! Plus/Pro/Team subscription, OpenAI's own device-authorization flow).
//! See `crate::providers`' module doc for why only these providers get
//! a real OAuth implementation here, rather than every provider
//! oh-my-pi/omp itself supports.

pub mod anthropic;
pub mod github_copilot;
pub mod openai_codex;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::Rng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// A stored OAuth credential: the bearer token plus enough to refresh it
/// without asking the user to log in again.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TokenSet {
    pub access_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    /// Unix seconds. `None` means "assume valid" (a token whose provider
    /// gave no expiry — e.g. GitHub's own long-lived `ghu_` user token).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
}

impl TokenSet {
    /// True when this token needs refreshing before use: it has a known
    /// expiry and that expiry is within `skew_secs` of now (or already
    /// past) — checking a little early avoids a request racing an
    /// about-to-expire token.
    #[must_use]
    pub fn is_expired(&self, skew_secs: i64) -> bool {
        let Some(expires_at) = self.expires_at else {
            return false;
        };
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        now + skew_secs >= expires_at
    }
}

/// A generated PKCE (RFC 7636) verifier/challenge pair, `S256`.
#[derive(Clone, Debug)]
pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

/// Base64url, no padding (RFC 4648 §5) — the encoding every PKCE/OAuth
/// value in this module uses.
#[must_use]
pub fn base64url(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Generate a fresh PKCE pair: 32 cryptographically random bytes as the
/// verifier (base64url), and its SHA-256 digest (also base64url) as the
/// `S256` challenge — exactly the shape Anthropic's (and every other
/// PKCE-based) OAuth authorize endpoint expects.
#[must_use]
pub fn generate_pkce() -> Pkce {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    let verifier = base64url(&bytes);
    let challenge = base64url(&Sha256::digest(verifier.as_bytes()));
    Pkce {
        verifier,
        challenge,
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
    use super::*;

    #[test]
    fn base64url_matches_a_known_test_vector() {
        // RFC 4648 test vector "f" -> "Zg", url-safe-no-pad is identical
        // to standard base64 here (no +/=/ in the output).
        assert_eq!(base64url(b"f"), "Zg");
        assert_eq!(base64url(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn generate_pkce_produces_a_verifier_and_a_matching_s256_challenge() {
        let pkce = generate_pkce();
        assert!(!pkce.verifier.is_empty());
        assert!(!pkce.challenge.is_empty());
        // No '+', '/', or '=' -- confirms url-safe-no-pad encoding, which
        // an authorize URL's query string needs (raw base64 would need
        // percent-escaping of those characters).
        assert!(
            !pkce.verifier.contains('+')
                && !pkce.verifier.contains('/')
                && !pkce.verifier.contains('=')
        );
        assert!(
            !pkce.challenge.contains('+')
                && !pkce.challenge.contains('/')
                && !pkce.challenge.contains('=')
        );
        // The challenge really is SHA-256(verifier), not an unrelated value.
        let expected = base64url(&Sha256::digest(pkce.verifier.as_bytes()));
        assert_eq!(pkce.challenge, expected);
    }

    #[test]
    fn generate_pkce_is_random_across_calls() {
        let a = generate_pkce();
        let b = generate_pkce();
        assert_ne!(
            a.verifier, b.verifier,
            "two calls must not reuse the same verifier"
        );
    }

    #[test]
    fn token_set_expiry_uses_the_skew_window() {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        let far_future = TokenSet {
            access_token: "t".into(),
            refresh_token: None,
            expires_at: Some(now + 3600),
        };
        assert!(!far_future.is_expired(60));

        let about_to_expire = TokenSet {
            access_token: "t".into(),
            refresh_token: None,
            expires_at: Some(now + 30),
        };
        assert!(
            about_to_expire.is_expired(60),
            "30s left, 60s skew window: must count as expired"
        );

        let already_past = TokenSet {
            access_token: "t".into(),
            refresh_token: None,
            expires_at: Some(now - 10),
        };
        assert!(already_past.is_expired(60));
    }

    #[test]
    fn a_token_with_no_expiry_is_never_expired() {
        let no_expiry = TokenSet {
            access_token: "t".into(),
            refresh_token: None,
            expires_at: None,
        };
        assert!(!no_expiry.is_expired(60));
        assert!(!no_expiry.is_expired(i64::MAX));
    }
}
