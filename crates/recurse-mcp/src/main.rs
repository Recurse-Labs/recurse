//! `recurse-mcp <binary-path> [--backend native|r2]` — open one binary with
//! a `recurse_static::engine::Engine`, then serve it over MCP stdio
//! (newline-delimited JSON-RPC 2.0, per the MCP stdio transport) until
//! stdin closes. See `crate::recurse_mcp` (`src/lib.rs`) for the protocol
//! logic itself; this is only argv parsing, engine setup, and the read loop.

use std::io::{BufRead, Write};

use recurse_static::engine::{BackendKind, Engine};

fn usage() -> ! {
    eprintln!("usage: recurse-mcp <binary-path> [--backend native|r2]");
    eprintln!();
    eprintln!("Serves Recurse's backend-neutral `analyze` tool over MCP stdio");
    eprintln!("(JSON-RPC 2.0, one JSON object per line) for the target binary.");
    eprintln!("Point an MCP client (Claude Code, Cursor, Claude Desktop, ...) at");
    eprintln!("this process instead of an IDA Pro MCP bridge or IDA seat.");
    std::process::exit(2);
}

fn open_engine(path: &std::path::Path, backend: BackendKind) -> Result<Box<dyn Engine>, String> {
    match backend {
        BackendKind::Native => {
            recurse_static::native::NativeEngine::open(path).map(|e| Box::new(e) as Box<dyn Engine>)
        }
        BackendKind::R2 => {
            recurse_static::r2_backend::R2Engine::open(path).map(|e| Box::new(e) as Box<dyn Engine>)
        }
        BackendKind::Ida => {
            recurse_static::ida_backend::IdaEngine::open(path).map(|e| Box::new(e) as Box<dyn Engine>)
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let Some(path_arg) = args.get(1) else {
        usage();
    };
    if path_arg == "-h" || path_arg == "--help" {
        usage();
    }

    let backend = args
        .iter()
        .position(|a| a == "--backend")
        .and_then(|i| args.get(i + 1))
        .and_then(|s| BackendKind::parse(s))
        .unwrap_or_default();

    let path = std::path::PathBuf::from(path_arg);
    let engine = match open_engine(&path, backend) {
        Ok(e) => e,
        Err(err) => {
            eprintln!("recurse-mcp: failed to open {}: {err}", path.display());
            std::process::exit(1);
        }
    };
    if let Err(err) = engine.analyze() {
        eprintln!("recurse-mcp: analyze failed for {}: {err}", path.display());
        // Not fatal: most ops still work against a partially-indexed
        // engine, and a lazy backend's analyze() failing outright is rare
        // enough that refusing to serve at all would be the worse default.
    }

    eprintln!(
        "recurse-mcp: serving {} ({} backend) over stdio",
        path.display(),
        engine.backend().as_str()
    );

    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else {
            break;
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let response = match serde_json::from_str::<serde_json::Value>(trimmed) {
            Ok(request) => recurse_mcp::handle_request(engine.as_ref(), &request),
            Err(err) => Some(recurse_mcp::parse_error_response(&err.to_string())),
        };

        if let Some(response) = response {
            let Ok(text) = serde_json::to_string(&response) else {
                continue;
            };
            if writeln!(stdout, "{text}").is_err() {
                break;
            }
            let _ = stdout.flush();
        }
    }
}
