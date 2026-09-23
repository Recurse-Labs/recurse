//! Host-side glue for the `recurse-static` analysis modules that are not
//! part of the `Engine` trait: capability detection, C++ vtable/RTTI
//! recovery, kernel driver IOCTL recovery, firmware signature scanning,
//! DWARF debug info, binary diffing, function signature generation, and
//! the cross-binary semantic-similarity corpus. Each of those modules
//! takes plain data (bytes, `Instruction`s, `FunctionSummary`s) rather
//! than an `Engine` — this file is the one place that adapts the active
//! session's data into their inputs and back into UI-facing JSON, so the
//! library modules themselves stay decoupled and independently testable
//! (see each module's own doc comment).
//!
//! None of the types here derive `Serialize` (they are library-internal,
//! not wire types), so every command builds its JSON response field by
//! field rather than `serde_json::to_value`-ing a library struct.

use serde_json::{json, Value};
use tauri::State;

use recurse_agent::engine::{Engine, FunctionInfo};
use recurse_static::{capa, cpp, diff, driver, dwarf, firmware, semantic_memory, sig};

use crate::AppState;

/// Functions whose disassembly gets scanned for capa evidence / driver
/// IOCTL dispatch sites. Bounds the cost of "findings" on a huge binary —
/// see `native.rs`'s own `MAX_FUNCTIONS`/`SWEEP_MAX_BYTES` for the same
/// philosophy applied to discovery itself.
const FINDINGS_FUNCTION_CAP: usize = 400;
/// Instructions per function scanned for capa mnemonic/number evidence.
const FINDINGS_INSN_CAP: usize = 300;
/// Functions considered for the whole-binary call graph.
const CALL_GRAPH_FUNCTION_CAP: usize = 1500;

pub(crate) fn locked_engine<'a>(
    state: &'a State<'_, AppState>,
) -> Result<std::sync::MutexGuard<'a, Option<Box<dyn Engine>>>, String> {
    state
        .session
        .lock()
        .map_err(|e| format!("session lock poisoned: {e}"))
}

pub(crate) fn require_engine<'a>(
    guard: &'a std::sync::MutexGuard<'a, Option<Box<dyn Engine>>>,
) -> Result<&'a dyn Engine, String> {
    guard
        .as_ref()
        .map(|b| b.as_ref())
        .ok_or_else(|| "no binary loaded".to_string())
}

/// Extract every `0x...` hex literal from `text` as a `u64`. Best-effort:
/// an operand this cannot parse (overflow, no digits) is just skipped.
fn extract_hex_numbers(text: &str, out: &mut Vec<u64>) {
    let bytes = text.as_bytes();
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] == b'0' && bytes[i + 1] == b'x' {
            let start = i + 2;
            let mut end = start;
            while end < bytes.len() && bytes[end].is_ascii_hexdigit() {
                end += 1;
            }
            if end > start {
                if let Ok(n) = u64::from_str_radix(&text[start..end], 16) {
                    out.push(n);
                }
            }
            i = end.max(i + 1);
        } else {
            i += 1;
        }
    }
}

/// Build capa [`Evidence`](capa::Evidence) from the engine's imports,
/// strings, and a bounded scan of disassembly across the binary's
/// functions (mnemonics + numeric immediates).
pub(crate) fn collect_evidence(engine: &dyn Engine, funcs: &[FunctionInfo]) -> capa::Evidence {
    let imports: Vec<String> = engine
        .imports()
        .unwrap_or_default()
        .into_iter()
        .map(|i| i.name)
        .collect();
    let strings: Vec<String> = engine
        .strings()
        .unwrap_or_default()
        .into_iter()
        .map(|s| s.string)
        .collect();

    let mut mnemonics: Vec<String> = Vec::new();
    let mut numbers: Vec<u64> = Vec::new();
    for f in funcs.iter().take(FINDINGS_FUNCTION_CAP) {
        let Ok(dis) = engine.function_disasm(f.addr) else {
            continue;
        };
        for op in dis.ops.iter().take(FINDINGS_INSN_CAP) {
            if let Some(m) = op.disasm.split_whitespace().next() {
                mnemonics.push(m.to_string());
            }
            extract_hex_numbers(&op.disasm, &mut numbers);
        }
    }

    capa::Evidence::new()
        .with_imports(imports)
        .with_strings(strings)
        .with_numbers(numbers)
        .with_mnemonics(mnemonics)
}

fn ioctl_handlers_json(engine: &dyn Engine, funcs: &[FunctionInfo]) -> (Vec<Value>, bool) {
    let truncated = funcs.len() > FINDINGS_FUNCTION_CAP;
    let mut out = Vec::new();
    for f in funcs.iter().take(FINDINGS_FUNCTION_CAP) {
        let Ok(dis) = engine.function_disasm(f.addr) else {
            continue;
        };
        for h in driver::recover_ioctl_handlers(&dis.ops) {
            out.push(json!({
                "function_addr": f.addr,
                "function_name": f.name,
                "compare_addr": h.compare_addr,
                "handler_addr": h.handler_addr,
                "code": {
                    "raw": h.code.raw,
                    "device_type": h.code.device_type,
                    "function": h.code.function,
                    "method": format!("{:?}", h.code.method),
                    "access": format!("{:?}", h.code.access),
                },
            }));
        }
    }
    (out, truncated)
}

/// Combined capability/class/driver/firmware/DWARF findings for the
/// active binary. Every sub-scan degrades independently (a backend with
/// no DWARF info, or a file `cpp::recover_classes` cannot parse, yields
/// an empty list for that section rather than failing the whole call).
#[tauri::command]
pub fn findings(state: State<'_, AppState>) -> Result<Value, String> {
    let guard = locked_engine(&state)?;
    let engine = require_engine(&guard)?;
    let path = engine.path().to_path_buf();
    let data = std::fs::read(&path).map_err(|e| format!("read {}: {e}", path.display()))?;

    let funcs = engine.functions()?;
    let evidence = collect_evidence(engine, &funcs);
    let capa_rules = capa::built_in_rules();
    let capabilities: Vec<Value> = capa_rules
        .evaluate(&evidence)
        .into_iter()
        .map(|r| {
            json!({
                "name": r.name,
                "namespace": r.namespace,
                "description": r.description,
            })
        })
        .collect();

    let classes: Vec<Value> = cpp::recover_classes(&data)
        .unwrap_or_default()
        .into_iter()
        .map(|c| {
            json!({
                "name": c.name,
                "vtable_address": c.vtable_address,
                "address_point": c.address_point,
                "typeinfo_address": c.typeinfo_address,
                "bases": c.bases,
                "virtual_functions": c.virtual_functions.iter().map(|v| json!({
                    "slot": v.slot,
                    "address": v.address,
                    "name": v.name,
                })).collect::<Vec<_>>(),
            })
        })
        .collect();

    let firmware_matches: Vec<Value> = firmware::scan(&data)
        .into_iter()
        .map(|m| json!({"offset": m.offset, "signature": m.signature}))
        .collect();

    let dwarf_functions: Vec<Value> = dwarf::load_functions(&path)
        .unwrap_or_default()
        .into_iter()
        .map(|f| {
            json!({
                "name": f.name,
                "low_pc": f.low_pc,
                "high_pc": f.high_pc,
                "return_type": f.return_type,
                "parameters": f.parameters.iter().map(|p| json!({
                    "name": p.name,
                    "ty": p.ty,
                })).collect::<Vec<_>>(),
            })
        })
        .collect();

    let (driver_ioctls, driver_ioctls_truncated) = ioctl_handlers_json(engine, &funcs);

    Ok(json!({
        "capabilities": capabilities,
        "classes": classes,
        "firmware": firmware_matches,
        "dwarf_functions": dwarf_functions,
        "driver_ioctls": driver_ioctls,
        "driver_ioctls_truncated": driver_ioctls_truncated,
        "scanned_functions": funcs.len().min(FINDINGS_FUNCTION_CAP),
        "total_functions": funcs.len(),
    }))
}

/// Build a [`diff::FunctionSummary`] list for one binary by opening a
/// throwaway native engine on it and normalizing every function's
/// disassembly. Independent of whichever backend the *active* session
/// uses — a diff target is always read with the native backend so the
/// comparison never depends on r2 being installed.
fn summarize_binary(path: &std::path::Path) -> Result<Vec<diff::FunctionSummary>, String> {
    let engine = recurse_static::native::NativeEngine::open(path)?;
    engine.analyze()?;
    let funcs = recurse_agent::engine::Engine::functions(&engine)?;
    let mut out = Vec::with_capacity(funcs.len());
    for f in funcs {
        let dis = recurse_agent::engine::Engine::function_disasm(&engine, f.addr).unwrap_or(
            recurse_static::engine::Disassembly {
                addr: f.addr,
                name: f.name.clone(),
                size: f.size,
                ops: Vec::new(),
            },
        );
        let lines: Vec<String> = dis.ops.iter().map(|op| op.disasm.clone()).collect();
        let calls: Vec<u64> = dis
            .ops
            .iter()
            .filter(|op| op.kind.as_deref() == Some("call"))
            .filter_map(|op| op.jump)
            .collect();
        out.push(diff::FunctionSummary {
            address: f.addr,
            name: f.name,
            normalized_instructions: diff::normalize_mnemonics(&lines),
            calls,
        });
    }
    Ok(out)
}

/// Diff the active binary's functions against another binary on disk
/// (opened fresh, native backend, never mutates the active session).
#[tauri::command]
pub fn diff_with(other_path: String, state: State<'_, AppState>) -> Result<Value, String> {
    let a_path = {
        let guard = locked_engine(&state)?;
        require_engine(&guard)?.path().to_path_buf()
    };
    let a = summarize_binary(&a_path)?;
    let b = summarize_binary(std::path::Path::new(&other_path))?;
    let name_of = |summaries: &[diff::FunctionSummary], addr: u64| -> String {
        summaries
            .iter()
            .find(|s| s.address == addr)
            .map(|s| s.name.clone())
            .unwrap_or_default()
    };
    let result = diff::diff(&a, &b);
    Ok(json!({
        "matched": result.matched.iter().map(|m| json!({
            "a": m.a,
            "b": m.b,
            "name_a": m.name_a,
            "name_b": m.name_b,
            "confidence": m.confidence,
            "method": match m.method {
                diff::MatchMethod::Exact => "exact",
                diff::MatchMethod::Fuzzy => "fuzzy",
            },
        })).collect::<Vec<_>>(),
        "removed": result.removed.iter().map(|&addr| json!({"addr": addr, "name": name_of(&a, addr)})).collect::<Vec<_>>(),
        "added": result.added.iter().map(|&b_addr| json!({"addr": b_addr, "name": name_of(&b, b_addr)})).collect::<Vec<_>>(),
        "a_function_count": a.len(),
        "b_function_count": b.len(),
    }))
}

/// Generate a wildcarded byte-pattern signature for the function at
/// `addr`, built from its own disassembled instruction lengths/targets —
/// useful for cross-version symbol migration (see
/// `docs/sig.md`/the `binary-diff` skill).
#[tauri::command]
pub fn generate_signature(addr: u64, state: State<'_, AppState>) -> Result<Value, String> {
    let guard = locked_engine(&state)?;
    let engine = require_engine(&guard)?;
    let dis = engine.function_disasm(addr)?;
    let total_len: usize = dis.ops.iter().map(|op| op.len as usize).sum();
    if total_len == 0 {
        return Err("function has no decoded instructions to sign".to_string());
    }
    let bytes = engine.read_bytes(dis.addr, total_len)?;
    let ops: Vec<sig::InsnShape> = dis
        .ops
        .iter()
        .map(|op| sig::InsnShape {
            len: op.len as usize,
            has_resolved_target: op.jump.is_some(),
        })
        .collect();
    let signature = sig::generate_signature(&dis.name, &bytes, &ops);
    let pattern_hex: Vec<String> = signature
        .pattern
        .iter()
        .map(|b| match b {
            Some(v) => format!("{v:02x}"),
            None => "??".to_string(),
        })
        .collect();
    Ok(json!({
        "name": signature.name,
        "addr": dis.addr,
        "pattern": pattern_hex.join(" "),
        "byte_count": signature.pattern.len(),
        "concrete_byte_count": signature.pattern.iter().filter(|b| b.is_some()).count(),
    }))
}

// ---------------------------------------------------------------------------
// Cross-binary semantic-similarity corpus.
// ---------------------------------------------------------------------------

fn semantic_memory_path() -> Result<std::path::PathBuf, String> {
    let home =
        crate::db::home_dir().ok_or_else(|| "could not determine home directory".to_string())?;
    Ok(home.join(".recurse").join("semantic_memory.json"))
}

fn load_semantic_memory() -> Result<semantic_memory::Memory, String> {
    let path = semantic_memory_path()?;
    match std::fs::read_to_string(&path) {
        Ok(text) => semantic_memory::Memory::from_json(&text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(semantic_memory::Memory::new()),
        Err(e) => Err(format!("read {}: {e}", path.display())),
    }
}

fn save_semantic_memory(memory: &semantic_memory::Memory) -> Result<(), String> {
    let path = semantic_memory_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    std::fs::write(&path, memory.to_json()?).map_err(|e| format!("write {}: {e}", path.display()))
}

/// Index every function of the active binary into the persistent,
/// cross-binary similarity corpus at `~/.recurse/semantic_memory.json`.
/// Re-indexing the same binary replaces its previous entries (keyed by
/// `binary path + address`) rather than duplicating them.
#[tauri::command]
pub fn semantic_index(state: State<'_, AppState>) -> Result<Value, String> {
    let (binary, funcs, ops_by_addr) = {
        let guard = locked_engine(&state)?;
        let engine = require_engine(&guard)?;
        let binary = engine.path().to_string_lossy().to_string();
        let funcs = engine.functions()?;
        let mut ops_by_addr = std::collections::HashMap::new();
        for f in funcs.iter().take(FINDINGS_FUNCTION_CAP) {
            if let Ok(dis) = engine.function_disasm(f.addr) {
                let lines: Vec<String> = dis.ops.iter().map(|op| op.disasm.clone()).collect();
                ops_by_addr.insert(f.addr, diff::normalize_mnemonics(&lines));
            }
        }
        (binary, funcs, ops_by_addr)
    };

    let mut memory = load_semantic_memory()?;
    memory.records.retain(|r| r.binary != binary);
    let mut indexed = 0usize;
    for f in &funcs {
        if let Some(normalized) = ops_by_addr.get(&f.addr) {
            if normalized.is_empty() {
                continue;
            }
            memory.add(semantic_memory::FunctionRecord::new(
                binary.clone(),
                f.name.clone(),
                f.addr,
                normalized.clone(),
            ));
            indexed += 1;
        }
    }
    save_semantic_memory(&memory)?;
    Ok(json!({"indexed": indexed, "corpus_size": memory.records.len()}))
}

/// The corpus's closest matches to the function at `addr`, by SimHash
/// distance then LCS-ratio re-scoring (see `semantic_memory` module doc).
#[tauri::command]
pub fn semantic_similar(addr: u64, state: State<'_, AppState>) -> Result<Value, String> {
    let guard = locked_engine(&state)?;
    let engine = require_engine(&guard)?;
    let dis = engine.function_disasm(addr)?;
    let lines: Vec<String> = dis.ops.iter().map(|op| op.disasm.clone()).collect();
    let query = diff::normalize_mnemonics(&lines);
    drop(guard);

    let memory = load_semantic_memory()?;
    let matches = memory.find_similar(&query, 10, 200);
    Ok(json!({
        "query_addr": addr,
        "corpus_size": memory.records.len(),
        "matches": matches.iter().map(|m| json!({
            "binary": m.record.binary,
            "name": m.record.name,
            "address": m.record.address,
            "similarity": m.similarity,
        })).collect::<Vec<_>>(),
    }))
}

// ---------------------------------------------------------------------------
// Whole-binary call graph.
// ---------------------------------------------------------------------------

/// Aggregate call edges across the binary's functions (capped — see
/// [`CALL_GRAPH_FUNCTION_CAP`]) into `{nodes, edges}`, for a global
/// navigation view distinct from `function_graph`'s per-function CFG.
#[tauri::command]
pub fn call_graph(state: State<'_, AppState>) -> Result<Value, String> {
    let guard = locked_engine(&state)?;
    let engine = require_engine(&guard)?;
    let funcs = engine.functions()?;
    let truncated = funcs.len() > CALL_GRAPH_FUNCTION_CAP;
    let known: std::collections::HashSet<u64> = funcs.iter().map(|f| f.addr).collect();

    let mut edges: Vec<Value> = Vec::new();
    let mut seen_edges: std::collections::HashSet<(u64, u64)> = std::collections::HashSet::new();
    for f in funcs.iter().take(CALL_GRAPH_FUNCTION_CAP) {
        let Ok(dis) = engine.function_disasm(f.addr) else {
            continue;
        };
        for op in &dis.ops {
            let is_call = matches!(op.kind.as_deref(), Some("call") | Some("icall"));
            let Some(target) = op.jump else { continue };
            if !is_call || !known.contains(&target) || target == f.addr {
                continue;
            }
            if seen_edges.insert((f.addr, target)) {
                edges.push(json!({"from": f.addr, "to": target}));
            }
        }
    }

    let called: std::collections::HashSet<u64> = edges
        .iter()
        .filter_map(|e| e.get("to").and_then(Value::as_u64))
        .collect();
    let nodes: Vec<Value> = funcs
        .iter()
        .take(CALL_GRAPH_FUNCTION_CAP)
        .map(|f| {
            json!({
                "addr": f.addr,
                "name": f.name,
                "is_leaf": !edges.iter().any(|e| e.get("from").and_then(Value::as_u64) == Some(f.addr)),
                "is_called": called.contains(&f.addr),
            })
        })
        .collect();

    Ok(json!({
        "nodes": nodes,
        "edges": edges,
        "truncated": truncated,
        "total_functions": funcs.len(),
    }))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
    use super::extract_hex_numbers;

    #[test]
    fn extract_hex_numbers_finds_every_literal() {
        let mut out = Vec::new();
        extract_hex_numbers("cmp eax, 0x1234; je 0xdeadbeef", &mut out);
        assert_eq!(out, vec![0x1234, 0xdead_beef]);
    }

    #[test]
    fn extract_hex_numbers_ignores_bare_decimal_and_dangling_prefix() {
        let mut out = Vec::new();
        extract_hex_numbers("add eax, 10; jmp 0x", &mut out);
        assert!(out.is_empty());
    }

    #[test]
    fn extract_hex_numbers_is_greedy_and_case_insensitive() {
        let mut out = Vec::new();
        // Uppercase hex, and a run of digits right after "0x" is consumed
        // in full (greedy), not split at the first non-alpha-looking char.
        extract_hex_numbers("mov eax, 0xDEAD10CC", &mut out);
        assert_eq!(out, vec![0xDEAD_10CC]);
    }

    #[test]
    fn extract_hex_numbers_finds_two_literals_separated_by_a_space() {
        let mut out = Vec::new();
        extract_hex_numbers("0x1 0x2", &mut out);
        assert_eq!(out, vec![0x1, 0x2]);
    }
}
