//! Provider presets: a real, curated catalog of LLM providers Recurse can
//! authenticate against, so a user brings whichever subscription or API
//! key they already have instead of only ever pasting an OpenRouter key.
//!
//! # Scope
//!
//! Recurse's agent run loop (`crate::agent::stream_http`) speaks one wire
//! protocol natively: OpenAI-compatible chat completions (`POST
//! {base}/chat/completions`, SSE streaming, `tools`/`tool_calls` in the
//! OpenAI function-calling shape). The large majority of real-world
//! providers — including ones with their own native APIs — now also
//! expose an OpenAI-compatible endpoint, so [`AuthKind::ApiKey`] covers
//! them all through the existing client with zero protocol-specific code.
//!
//! Two providers do not fit that shape because they gate a *subscription*
//! (not a metered API key) behind their own OAuth flow, and (for
//! Anthropic) their own native wire protocol:
//!
//! - [`AuthKind::OAuthAnthropic`] — Claude Pro/Max, via
//!   `crate::oauth::anthropic`'s PKCE flow and `crate::anthropic`'s native
//!   Messages API client (see both modules' docs for exactly what's
//!   implemented and what isn't).
//! - [`AuthKind::OAuthGithubCopilot`] — a GitHub Copilot subscription, via
//!   `crate::oauth::github_copilot`'s device flow. Copilot's own chat
//!   endpoint *is* OpenAI-compatible, so once authenticated this still
//!   rides the existing [`AuthKind::ApiKey`] request path — it only needs
//!   a different token-acquisition step and a couple of required extra
//!   headers (see [`ProviderPreset::extra_headers`]).
//!
//! No other provider's OAuth/subscription flow is implemented here —
//! every other entry in this catalog is real (a correct name and base
//! URL), but reachable only with an API key the user already has, not a
//! reimplementation of that provider's own subscription login. Real,
//! honestly scoped follow-up work, the same pattern this project's static
//! analysis modules already established: build the real primitive for
//! the highest-value cases, name the rest as future work rather than
//! faking it.

/// How a provider is authenticated.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthKind {
    /// A bearer API key against an OpenAI-compatible endpoint.
    ApiKey,
    /// An API key against a native Anthropic Messages API endpoint.
    AnthropicApiKey,
    /// Claude Pro/Max subscription via OAuth (native Anthropic protocol).
    OAuthAnthropic,
    /// GitHub Copilot subscription via OAuth (OpenAI-compatible protocol
    /// once authenticated).
    OAuthGithubCopilot,
    /// A local server; a key is optional (often unset for e.g. Ollama).
    Local,
}

/// One provider entry.
#[derive(Clone, Copy, Debug)]
pub struct ProviderPreset {
    /// Stable identifier (storage key, wire value) — lowercase, hyphenated.
    pub id: &'static str,
    /// Display name for the UI.
    pub name: &'static str,
    /// Base URL (`.../v1` or `.../messages`), used for
    /// [`AuthKind::ApiKey`]/[`AuthKind::AnthropicApiKey`]/[`AuthKind::OAuthGithubCopilot`]/[`AuthKind::Local`].
    /// Ignored for [`AuthKind::OAuthAnthropic`], which uses
    /// `crate::anthropic`'s own native base URL instead.
    pub base_url: &'static str,
    pub auth: AuthKind,
    /// Where a user gets a key/enables the API, for the "how do I get a
    /// key" link in the UI.
    pub docs_url: &'static str,
    /// Extra static headers this provider's endpoint requires beyond a
    /// bearer token (e.g. GitHub Copilot's proxy rejects requests without
    /// an `Editor-Version`/`Copilot-Integration-Id` pair).
    pub extra_headers: &'static [(&'static str, &'static str)],
}

const NONE: &[(&str, &str)] = &[];
const COPILOT_HEADERS: &[(&str, &str)] = &[
    ("Editor-Version", "vscode/1.96.0"),
    ("Copilot-Integration-Id", "vscode-chat"),
];

/// The provider catalog, in the order the picker/settings UI lists them:
/// subscriptions first (an OAuth-based provider is usually the one a
/// first-time user actually has), then frontier API vendors, then
/// aggregators/gateways, then everything else, then local runtimes.
pub const PROVIDERS: &[ProviderPreset] = &[
    // -- Subscriptions (OAuth) --
    ProviderPreset {
        id: "anthropic-oauth",
        name: "Claude (Pro/Max subscription)",
        base_url: "",
        auth: AuthKind::OAuthAnthropic,
        docs_url: "https://claude.ai/",
        extra_headers: NONE,
    },
    ProviderPreset {
        id: "github-copilot",
        name: "GitHub Copilot",
        base_url: "https://api.githubcopilot.com",
        auth: AuthKind::OAuthGithubCopilot,
        docs_url: "https://github.com/features/copilot",
        extra_headers: COPILOT_HEADERS,
    },
    // -- Frontier API vendors (API key) --
    ProviderPreset {
        id: "openai",
        name: "OpenAI",
        base_url: "https://api.openai.com/v1",
        auth: AuthKind::ApiKey,
        docs_url: "https://platform.openai.com/api-keys",
        extra_headers: NONE,
    },
    ProviderPreset {
        id: "anthropic",
        name: "Anthropic (API key)",
        base_url: "https://api.anthropic.com/v1/messages",
        auth: AuthKind::AnthropicApiKey,
        docs_url: "https://console.anthropic.com/settings/keys",
        extra_headers: NONE,
    },
    ProviderPreset {
        id: "google-gemini",
        name: "Google Gemini",
        base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
        auth: AuthKind::ApiKey,
        docs_url: "https://aistudio.google.com/apikey",
        extra_headers: NONE,
    },
    ProviderPreset {
        id: "xai",
        name: "xAI (Grok)",
        base_url: "https://api.x.ai/v1",
        auth: AuthKind::ApiKey,
        docs_url: "https://console.x.ai/",
        extra_headers: NONE,
    },
    ProviderPreset {
        id: "deepseek",
        name: "DeepSeek",
        base_url: "https://api.deepseek.com/v1",
        auth: AuthKind::ApiKey,
        docs_url: "https://platform.deepseek.com/api_keys",
        extra_headers: NONE,
    },
    ProviderPreset {
        id: "mistral",
        name: "Mistral",
        base_url: "https://api.mistral.ai/v1",
        auth: AuthKind::ApiKey,
        docs_url: "https://console.mistral.ai/api-keys",
        extra_headers: NONE,
    },
    ProviderPreset {
        id: "moonshot",
        name: "Moonshot (Kimi)",
        base_url: "https://api.moonshot.ai/v1",
        auth: AuthKind::ApiKey,
        docs_url: "https://platform.moonshot.ai/console/api-keys",
        extra_headers: NONE,
    },
    // -- Aggregators / gateways --
    ProviderPreset {
        id: "openrouter",
        name: "OpenRouter",
        base_url: "https://openrouter.ai/api/v1",
        auth: AuthKind::ApiKey,
        docs_url: "https://openrouter.ai/keys",
        extra_headers: NONE,
    },
    // -- Fast inference vendors --
    ProviderPreset {
        id: "groq",
        name: "Groq",
        base_url: "https://api.groq.com/openai/v1",
        auth: AuthKind::ApiKey,
        docs_url: "https://console.groq.com/keys",
        extra_headers: NONE,
    },
    ProviderPreset {
        id: "cerebras",
        name: "Cerebras",
        base_url: "https://api.cerebras.ai/v1",
        auth: AuthKind::ApiKey,
        docs_url: "https://cloud.cerebras.ai/",
        extra_headers: NONE,
    },
    ProviderPreset {
        id: "fireworks",
        name: "Fireworks AI",
        base_url: "https://api.fireworks.ai/inference/v1",
        auth: AuthKind::ApiKey,
        docs_url: "https://fireworks.ai/account/api-keys",
        extra_headers: NONE,
    },
    ProviderPreset {
        id: "together",
        name: "Together AI",
        base_url: "https://api.together.xyz/v1",
        auth: AuthKind::ApiKey,
        docs_url: "https://api.together.ai/settings/api-keys",
        extra_headers: NONE,
    },
    ProviderPreset {
        id: "deepinfra",
        name: "DeepInfra",
        base_url: "https://api.deepinfra.com/v1/openai",
        auth: AuthKind::ApiKey,
        docs_url: "https://deepinfra.com/dash/api_keys",
        extra_headers: NONE,
    },
    ProviderPreset {
        id: "baseten",
        name: "Baseten",
        base_url: "https://inference.baseten.co/v1",
        auth: AuthKind::ApiKey,
        docs_url: "https://app.baseten.co/settings/api_keys",
        extra_headers: NONE,
    },
    ProviderPreset {
        id: "novita",
        name: "Novita AI",
        base_url: "https://api.novita.ai/v3/openai",
        auth: AuthKind::ApiKey,
        docs_url: "https://novita.ai/settings/key-management",
        extra_headers: NONE,
    },
    ProviderPreset {
        id: "siliconflow",
        name: "SiliconFlow",
        base_url: "https://api.siliconflow.com/v1",
        auth: AuthKind::ApiKey,
        docs_url: "https://cloud.siliconflow.com/account/ak",
        extra_headers: NONE,
    },
    ProviderPreset {
        id: "nvidia",
        name: "NVIDIA NIM",
        base_url: "https://integrate.api.nvidia.com/v1",
        auth: AuthKind::ApiKey,
        docs_url: "https://build.nvidia.com/",
        extra_headers: NONE,
    },
    ProviderPreset {
        id: "huggingface",
        name: "Hugging Face Inference",
        base_url: "https://router.huggingface.co/v1",
        auth: AuthKind::ApiKey,
        docs_url: "https://huggingface.co/settings/tokens",
        extra_headers: NONE,
    },
    ProviderPreset {
        id: "perplexity",
        name: "Perplexity",
        base_url: "https://api.perplexity.ai",
        auth: AuthKind::ApiKey,
        docs_url: "https://www.perplexity.ai/settings/api",
        extra_headers: NONE,
    },
    ProviderPreset {
        id: "zai",
        name: "Z.AI GLM (Coding Plan / Anthropic)",
        base_url: "https://api.z.ai/api/anthropic/v1/messages",
        auth: AuthKind::AnthropicApiKey,
        docs_url: "https://z.ai/manage-apikey/apikey-list",
        extra_headers: NONE,
    },
    ProviderPreset {
        id: "zai-openai",
        name: "Z.AI GLM (OpenAI API)",
        base_url: "https://api.z.ai/api/paas/v4",
        auth: AuthKind::ApiKey,
        docs_url: "https://z.ai/manage-apikey/apikey-list",
        extra_headers: NONE,
    },
    // -- Local runtimes --
    ProviderPreset {
        id: "ollama",
        name: "Ollama (local)",
        base_url: "http://localhost:11434/v1",
        auth: AuthKind::Local,
        docs_url: "https://ollama.com/",
        extra_headers: NONE,
    },
    ProviderPreset {
        id: "lmstudio",
        name: "LM Studio (local)",
        base_url: "http://localhost:1234/v1",
        auth: AuthKind::Local,
        docs_url: "https://lmstudio.ai/",
        extra_headers: NONE,
    },
    ProviderPreset {
        id: "llamacpp",
        name: "llama.cpp server (local)",
        base_url: "http://localhost:8080/v1",
        auth: AuthKind::Local,
        docs_url: "https://github.com/ggml-org/llama.cpp",
        extra_headers: NONE,
    },
    ProviderPreset {
        id: "vllm",
        name: "vLLM (local/self-hosted)",
        base_url: "http://localhost:8000/v1",
        auth: AuthKind::Local,
        docs_url: "https://docs.vllm.ai/",
        extra_headers: NONE,
    },
    // -- Custom --
    ProviderPreset {
        id: "custom",
        name: "Custom OpenAI-compatible endpoint",
        base_url: "",
        auth: AuthKind::ApiKey,
        docs_url: "",
        extra_headers: NONE,
    },
];

/// Look up a preset by id.
#[must_use]
pub fn find(id: &str) -> Option<&'static ProviderPreset> {
    PROVIDERS.iter().find(|p| p.id == id)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
    use super::*;

    #[test]
    fn every_id_is_unique() {
        let mut ids: Vec<&str> = PROVIDERS.iter().map(|p| p.id).collect();
        let before = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), before, "duplicate provider id in the catalog");
    }

    #[test]
    fn every_non_custom_non_local_provider_has_a_real_https_base_url() {
        for p in PROVIDERS {
            if p.id == "custom" || p.auth == AuthKind::Local || p.auth == AuthKind::OAuthAnthropic {
                continue;
            }
            assert!(
                p.base_url.starts_with("https://"),
                "{}: {}",
                p.id,
                p.base_url
            );
        }
    }

    #[test]
    fn oauth_providers_are_present() {
        assert!(find("anthropic-oauth").is_some());
        assert!(find("github-copilot").is_some());
        assert_eq!(
            find("anthropic-oauth").unwrap().auth,
            AuthKind::OAuthAnthropic
        );
        assert_eq!(
            find("github-copilot").unwrap().auth,
            AuthKind::OAuthGithubCopilot
        );
    }

    #[test]
    fn find_misses_cleanly_on_an_unknown_id() {
        assert!(find("not-a-real-provider").is_none());
    }

    #[test]
    fn copilot_carries_its_required_extra_headers() {
        let copilot = find("github-copilot").expect("present");
        assert!(copilot
            .extra_headers
            .iter()
            .any(|(k, _)| *k == "Editor-Version"));
        assert!(copilot
            .extra_headers
            .iter()
            .any(|(k, _)| *k == "Copilot-Integration-Id"));
    }

    #[test]
    fn catalog_has_a_real_breadth_of_providers() {
        // A loose floor, not a magic number: this catalog exists to cover
        // "bring whichever key you already have" broadly, not to list
        // exactly N providers.
        assert!(PROVIDERS.len() >= 20, "only {} providers", PROVIDERS.len());
    }
}
