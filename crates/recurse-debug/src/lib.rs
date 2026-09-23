//! Cross-platform debugger for Recurse, written from scratch in Rust.
//!
//! This crate is deliberately independent of the agent (`recurse_agent`): it is
//! low-level systems code (ptrace, the Mach task API, the Win32 debug API) and
//! must not sit in the agent's dependency graph. The host wires it to both the
//! agent (as the [`tool`] tool) and the UI.
//!
//! Layout:
//!
//! * [`Debugger`] — the platform-neutral session (launch/attach, breakpoints,
//!   stepping, registers, memory, backtrace). Everything above the OS.
//! * [`target`] — one `Target` trait with a per-OS implementation.
//! * [`symbols`] — a [`Symbols`] trait the host implements over its analysis
//!   engine, so the debugger can take symbol names without depending on it.
//! * [`tool`] — the agent tool schema and dispatcher.
//!
//! ```no_run
//! use recurse_debug::{Debugger, model::{BreakAt, LaunchOptions, StepKind}};
//! # fn main() -> recurse_debug::Result<()> {
//! let dbg = Debugger::new()?;
//! dbg.launch(&LaunchOptions { path: "/bin/true".into(), ..Default::default() })?;
//! dbg.add_breakpoint(&BreakAt::Addr { addr: 0x401000 })?;
//! dbg.resume()?;
//! dbg.step(StepKind::Into)?;
//! dbg.detach()?;
//! # Ok(())
//! # }
//! ```

pub mod advanced;
pub mod arch;
pub mod error;
pub mod gdb_remote;
pub mod model;
pub mod session;
pub mod symbols;
pub mod target;
pub mod tool;

pub use error::{Error, Result};
pub use session::Debugger;
pub use symbols::Symbols;
