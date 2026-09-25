//! Static binary analysis for Recurse: the binary world-model (functions,
//! disassembly, xrefs, strings, imports, CFG) and the engine seam that produces
//! it.
//!
//! This is systems code — ELF/PE/Mach-O parsing, multi-architecture
//! disassembly, unwind tables — and is deliberately independent of the agent
//! (the `recurse_agent` crate). The agent, the debugger, and the UI all consume it.
//!
//! * [`engine`] — the backend-agnostic `Engine` trait, canonical result types,
//!   and the agent's `analyze` tool schema/dispatcher.
//! * [`native`] — the default pure-Rust engine (in-process, permissive).
//! * [`r2`] / [`r2_backend`] — the opt-in r2 engine.
//! * [`arch`] — architecture detection and disassembly, shared by every
//!   consumer (including the debugger).
//! * [`signals`] — best-effort process signals for the r2 engine.

pub mod arch;
pub mod capa;
pub mod cpp;
pub mod decompose;
pub mod diff;
pub mod driver;
pub mod dwarf;
pub mod engine;
pub mod firmware;
pub mod ida_backend;
pub mod native;
pub mod r2;
pub mod r2_backend;
pub mod semantic_memory;
pub mod sig;
pub mod signals;
pub mod types;
pub mod unwind;
pub mod winpdb;

pub use engine::{BackendKind, Capabilities, Engine};
