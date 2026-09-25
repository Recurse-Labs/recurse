//! Analysis-backend selection.
//!
//! The host no longer knows which engine it holds: [`build`] reads the
//! configured backend (`native` or r2) and returns a boxed
//! [`recurse_agent::engine::Engine`]. Every command and the agent tool route
//! through that trait, so adding a backend is a change here only.

use std::path::Path;

use recurse_agent::engine::{BackendKind, Engine};

/// Build the configured analysis backend for `path`.
///
/// * r2 — spawn its executable (independently licensed,
///   invoked as a separate program). Requires it on `PATH`.
/// * `native` — pure-Rust in-process parsing/disassembly. No external
///   process and no copyleft dependency, but x86/x86-64 disassembly only and
///   no decompiler.
///
/// # Errors
/// Returns the backend's own error when the target cannot be opened (missing
/// file, unparsable format, missing external binary).
pub fn build(path: &Path) -> Result<Box<dyn Engine>, String> {
    match crate::config::backend() {
        BackendKind::R2 => Ok(Box::new(recurse_agent::r2_backend::R2Engine::open(path)?)),
        BackendKind::Native => recurse_agent::native::open(path),
        BackendKind::Ida => Ok(Box::new(recurse_agent::ida_backend::IdaEngine::open(path)?)),
    }
}

/// Label of the backend that would be used right now, for the UI and logs.
pub fn active_label() -> &'static str {
    crate::config::backend().as_str()
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
    use super::*;

    #[test]
    fn native_backend_opens_the_test_binary() {
        let exe = std::env::current_exe().unwrap();
        // Force the native backend regardless of stored config.
        let engine = recurse_agent::native::NativeEngine::open(&exe).unwrap();
        assert_eq!(engine.backend(), BackendKind::Native);
        assert!(engine.summary().unwrap()["path"].is_string());
    }
}
