use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use recurse_agent::engine::{Engine, Target, XrefDirection};

use crate::config;
use crate::project::{self, Project};
use crate::sessions::{self, Session};
use crate::AppState;
use recurse_agent::agent::{self, AgentEvent, ModelInfo, ToolCall};

fn session_of(
    state: &AppState,
) -> Result<std::sync::MutexGuard<'_, Option<Box<dyn Engine>>>, String> {
    state
        .session
        .lock()
        .map_err(|e| format!("session lock poisoned: {e}"))
}

fn session<'a>(
    state: &'a State<'_, AppState>,
) -> Result<std::sync::MutexGuard<'a, Option<Box<dyn Engine>>>, String> {
    state
        .session
        .lock()
        .map_err(|e| format!("session lock poisoned: {e}"))
}

fn with_sess<'a>(
    guard: &'a std::sync::MutexGuard<'a, Option<Box<dyn Engine>>>,
) -> Result<&'a dyn Engine, String> {
    guard
        .as_ref()
        .map(|b| b.as_ref())
        .ok_or_else(|| "no binary loaded".into())
}

fn current_project_of(state: &AppState) -> Result<Option<String>, String> {
    Ok(state
        .project
        .lock()
        .map_err(|e| format!("project lock poisoned: {e}"))?
        .as_ref()
        .map(|p| p.name.clone()))
}

fn current_project(state: &State<'_, AppState>) -> Result<Option<String>, String> {
    Ok(state
        .project
        .lock()
        .map_err(|e| format!("project lock poisoned: {e}"))?
        .as_ref()
        .map(|p| p.name.clone()))
}

fn current_session_id_of(state: &AppState) -> Result<Option<String>, String> {
    Ok(state
        .current_session
        .lock()
        .map_err(|e| format!("current_session lock poisoned: {e}"))?
        .clone())
}

fn current_session_id(state: &State<'_, AppState>) -> Result<Option<String>, String> {
    Ok(state
        .current_session
        .lock()
        .map_err(|e| format!("current_session lock poisoned: {e}"))?
        .clone())
}

fn persist_history(project: Option<&str>, session_id: &str, messages: &[agent::ChatMessage]) {
    if let Ok(json) = serde_json::to_string(messages) {
        let _ = sessions::save_history(project, session_id, &json);
    }
}

// ---------------------------------------------------------------------------
// Binary / analysis commands
// ---------------------------------------------------------------------------

/// Core of [`open_binary`], taking plain state so integration tests can
/// drive the exact production path without a Tauri runtime.
pub fn open_binary_impl(path: String, state: &AppState) -> Result<Value, String> {
    eprintln!(
        "[recurse] open_binary: {path} (backend={})",
        crate::engine::active_label()
    );
    let mut guard = session_of(state)?;
    let sess = crate::engine::build(std::path::Path::new(&path))?;
    // Restore any analyst renames recorded for this target.
    sess.set_renames(crate::renames::load(&sess.path().to_string_lossy()));
    let mut summary = sess.summary()?;
    // Host metadata the UI uses to hide affordances the backend cannot serve
    // (decompile / raw console on the native backend).
    summary["backend"] = serde_json::json!(sess.backend().as_str());
    summary["capabilities"] =
        serde_json::to_value(sess.capabilities()).unwrap_or(serde_json::Value::Null);
    eprintln!(
        "[recurse] open_binary: funcs={} strings={}",
        summary["function_count"], summary["string_count"]
    );
    *guard = Some(sess);
    *state
        .current_session
        .lock()
        .map_err(|e| format!("current_session lock poisoned: {e}"))? = None;
    Ok(summary)
}

#[tauri::command]
pub fn open_binary(path: String, state: State<'_, AppState>) -> Result<Value, String> {
    open_binary_impl(path, &state)
}

#[tauri::command]
pub fn analyze(state: State<'_, AppState>) -> Result<(), String> {
    analyze_impl(&state)
}

/// Core of [`analyze`]; see [`open_binary_impl`].
pub fn analyze_impl(state: &AppState) -> Result<(), String> {
    eprintln!(
        "[recurse] analyze: starting analysis pass (backend={})",
        crate::engine::active_label()
    );
    let guard = session_of(state)?;
    with_sess(&guard)?.analyze()?;
    eprintln!("[recurse] analyze: done");
    Ok(())
}

/// Core of [`close_binary`]; see [`open_binary_impl`].
pub fn close_binary_impl(state: &AppState) -> Result<(), String> {
    session_of(state)?.take();
    *state
        .project
        .lock()
        .map_err(|e| format!("project lock poisoned: {e}"))? = None;
    *state
        .current_session
        .lock()
        .map_err(|e| format!("current_session lock poisoned: {e}"))? = None;
    Ok(())
}

#[tauri::command]
pub fn close_binary(state: State<'_, AppState>) -> Result<(), String> {
    close_binary_impl(&state)
}

#[tauri::command]
pub fn binary_info(state: State<'_, AppState>) -> Result<Value, String> {
    binary_info_impl(&state)
}

/// Core of [`binary_info`]; see [`open_binary_impl`].
pub fn binary_info_impl(state: &AppState) -> Result<Value, String> {
    let guard = session_of(state)?;
    with_sess(&guard)?.info()
}

#[tauri::command]
pub fn functions(state: State<'_, AppState>) -> Result<Value, String> {
    let guard = session(&state)?;
    let funcs = with_sess(&guard)?.functions()?;
    eprintln!("[recurse] functions: {}", funcs.len());
    serde_json::to_value(funcs).map_err(|e| e.to_string())
}

/// Core of [`rename_function`]; see [`open_binary_impl`]. Persists an analyst
/// rename (blank clears it) and installs the updated overrides into the active
/// engine, so the function list, the disassembly annotation, and the agent all
/// see it.
pub fn rename_function_impl(state: &AppState, addr: u64, name: &str) -> Result<(), String> {
    let guard = session_of(state)?;
    let engine = with_sess(&guard)?;
    let path = engine.path().to_string_lossy().to_string();
    crate::renames::set(&path, addr, Some(name))?;
    engine.set_renames(crate::renames::load(&path));
    Ok(())
}

#[tauri::command]
pub fn rename_function(addr: u64, name: String, state: State<'_, AppState>) -> Result<(), String> {
    rename_function_impl(&state, addr, &name)
}

/// Current function count plus whether the backend is still discovering
/// functions in the background. The UI polls this to grow the function list
/// without blocking the initial open; synchronous backends always report
/// `indexing: false`.
#[tauri::command]
pub fn analysis_progress(state: State<'_, AppState>) -> Result<Value, String> {
    let guard = session(&state)?;
    let engine = with_sess(&guard)?;
    let count = engine.functions()?.len();
    Ok(serde_json::json!({
        "function_count": count,
        "indexing": engine.indexing(),
    }))
}

/// Core of [`recon`]; see [`open_binary_impl`]. The engine supplies the
/// hardening report, libraries and analysis counts; the host adds file hashes,
/// entropy and size, so the page works on any backend.
pub async fn recon_impl(state: &AppState) -> Result<Value, String> {
    let (path, engine_recon, engine_info, counts) = {
        let guard = session_of(state)?;
        let engine = with_sess(&guard)?;
        (
            engine.path().to_path_buf(),
            engine.recon()?,
            engine.info()?,
            serde_json::json!({
                "functions": engine.functions()?.len(),
                "strings": engine.strings()?.len(),
                "imports": engine.imports()?.len(),
            }),
        )
    };

    let hash_path = path.clone();
    let (hashes, entropy, size, mode) =
        tauri::async_runtime::spawn_blocking(move || file_stats(&hash_path))
            .await
            .map_err(|e| format!("hashing task failed: {e}"))??;

    // Info: engine `info().bin` (arch/bits/…), overlaid with the backend's
    // richer recon info, then the host's file-level fields.
    let mut info = engine_info
        .get("bin")
        .cloned()
        .filter(Value::is_object)
        .unwrap_or_else(|| serde_json::json!({}));
    if let Some(extra) = engine_recon.get("info").and_then(Value::as_object) {
        for (k, v) in extra {
            info[k] = v.clone();
        }
    }
    info["file"] = serde_json::json!(path.display().to_string());
    info["size"] = serde_json::json!(size);
    info["mode"] = serde_json::json!(mode);

    let mut analysis = engine_recon
        .get("analysis")
        .cloned()
        .filter(Value::is_object)
        .unwrap_or_else(|| serde_json::json!({}));
    if analysis
        .get("functions")
        .map(Value::is_null)
        .unwrap_or(true)
    {
        analysis["functions"] = counts["functions"].clone();
    }
    analysis["strings"] = counts["strings"].clone();
    analysis["imports"] = counts["imports"].clone();

    Ok(serde_json::json!({
        "info": info,
        "checksec": engine_recon
            .get("checksec")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({})),
        "libraries": engine_recon
            .get("libraries")
            .cloned()
            .unwrap_or_else(|| serde_json::json!([])),
        "analysis": analysis,
        "hashes": hashes,
        "entropy": entropy,
        "temperature": entropy / 8.0,
    }))
}

#[tauri::command]
pub async fn recon(state: State<'_, AppState>) -> Result<Value, String> {
    recon_impl(&state).await
}

/// Run one debugger op (`launch`, `attach`, `continue`, `step`, `break`,
/// `unbreak`, `breakpoints`, `regs`, `read`, `write`, `backtrace`, `threads`,
/// `status`, `detach`, `kill`).
///
/// One command covers the whole vocabulary: `launch`/`attach` create the
/// session, `detach`/`kill` clear it. The debugger blocks in `waitpid` while
/// running, so the work runs on a blocking thread and never stalls the UI.
#[tauri::command]
pub async fn debug_command(
    op: String,
    args: Option<Value>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let session = state.session.clone();
    let debug = state.debug.clone();
    let args = args.unwrap_or(Value::Null);
    let out = tauri::async_runtime::spawn_blocking(move || {
        crate::debug::run_op(session, debug, &op, &args)
    })
    .await
    .map_err(|e| format!("debug task failed: {e}"))??;
    let value: Value = serde_json::from_str(&out).map_err(|e| e.to_string())?;
    crate::debug_trace::record_if_stop(&state, &value);
    Ok(value)
}

/// Live snapshot of the debug session (pid, state, last stop, breakpoints,
/// backtrace), or `null` when no session is active.
///
/// Read directly, without going through the debugger's worker thread, so the
/// UI can follow an agent-driven session in real time — even while a
/// `continue` is blocked waiting for a stop.
#[tauri::command]
pub fn debug_snapshot(state: State<'_, AppState>) -> Result<Value, String> {
    let dbg = state
        .debug
        .lock()
        .map_err(|e| format!("debug lock poisoned: {e}"))?
        .clone();
    match dbg {
        Some(dbg) => serde_json::to_value(dbg.snapshot()).map_err(|e| e.to_string()),
        None => Ok(Value::Null),
    }
}

/// Hashes, Shannon entropy, size and permission string for the recon page.
/// Reads the file once, off the UI thread.
fn file_stats(path: &std::path::Path) -> Result<(Value, f64, u64, String), String> {
    use md5::Digest;
    let bytes = std::fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let hashes = serde_json::json!({
        "md5": hex(md5::Md5::digest(&bytes).as_slice()),
        "sha1": hex(sha1::Sha1::digest(&bytes).as_slice()),
        "sha256": hex(sha2::Sha256::digest(&bytes).as_slice()),
        "crc32": format!("{:08x}", crc32fast::hash(&bytes)),
    });
    Ok((hashes, entropy(&bytes), bytes.len() as u64, file_mode(path)))
}

/// Lowercase hex encoding.
fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(out, "{b:02x}");
    }
    out
}

/// Shannon entropy of the file, in bits per byte (0–8).
fn entropy(bytes: &[u8]) -> f64 {
    if bytes.is_empty() {
        return 0.0;
    }
    let mut counts = [0u64; 256];
    for &b in bytes {
        counts[b as usize] += 1;
    }
    let len = bytes.len() as f64;
    let mut e = 0.0;
    for &c in &counts {
        if c > 0 {
            let p = c as f64 / len;
            e -= p * p.log2();
        }
    }
    e
}

#[cfg(unix)]
fn file_mode(path: &std::path::Path) -> String {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|m| {
            let bits = m.permissions().mode();
            let mut s = String::with_capacity(9);
            for shift in [6, 3, 0] {
                let p = (bits >> shift) & 7;
                s.push(if p & 4 != 0 { 'r' } else { '-' });
                s.push(if p & 2 != 0 { 'w' } else { '-' });
                s.push(if p & 1 != 0 { 'x' } else { '-' });
            }
            s
        })
        .unwrap_or_default()
}

#[cfg(not(unix))]
fn file_mode(_path: &std::path::Path) -> String {
    String::new()
}

#[tauri::command]
pub fn disassemble(addr: u64, count: u64, state: State<'_, AppState>) -> Result<Value, String> {
    let guard = session(&state)?;
    let dis = with_sess(&guard)?.disassemble(&Target::Addr(addr), Some(count as usize))?;
    serde_json::to_value(dis).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn function_at(addr: u64, state: State<'_, AppState>) -> Result<Value, String> {
    let guard = session(&state)?;
    let f = with_sess(&guard)?.function_at(addr)?;
    serde_json::to_value(f).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn function_disasm(addr: u64, state: State<'_, AppState>) -> Result<Value, String> {
    let guard = session(&state)?;
    let dis = with_sess(&guard)?.function_disasm(addr)?;
    serde_json::to_value(dis).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn function_graph(addr: u64, state: State<'_, AppState>) -> Result<Value, String> {
    let guard = session(&state)?;
    let graph = with_sess(&guard)?.function_graph(addr)?;
    serde_json::to_value(graph).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn strings(state: State<'_, AppState>) -> Result<Value, String> {
    let guard = session(&state)?;
    let strings = with_sess(&guard)?.strings()?;
    eprintln!("[recurse] strings: {}", strings.len());
    serde_json::to_value(strings).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn imports(state: State<'_, AppState>) -> Result<Value, String> {
    let guard = session(&state)?;
    let imports = with_sess(&guard)?.imports()?;
    eprintln!("[recurse] imports: {}", imports.len());
    serde_json::to_value(imports).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn xrefs_to(addr: u64, state: State<'_, AppState>) -> Result<Value, String> {
    let guard = session(&state)?;
    let refs = with_sess(&guard)?.xrefs(&Target::Addr(addr), XrefDirection::To)?;
    serde_json::to_value(refs).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn decompile(addr: u64, state: State<'_, AppState>) -> Result<Value, String> {
    let guard = session(&state)?;
    let dec = with_sess(&guard)?.decompile(addr)?;
    serde_json::to_value(dec).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn raw(cmd: String, state: State<'_, AppState>) -> Result<Value, String> {
    let guard = session(&state)?;
    with_sess(&guard)?.raw(&cmd)
}

/// Read raw bytes at a virtual address — the hex view's data source.
#[tauri::command]
pub fn read_bytes(addr: u64, len: usize, state: State<'_, AppState>) -> Result<Vec<u8>, String> {
    let guard = session(&state)?;
    with_sess(&guard)?.read_bytes(addr, len)
}

/// Patch raw bytes at a virtual address directly into the file on disk.
/// The active session's cached analysis does not reflect the patch until
/// the binary is reopened (see [`recurse_agent::engine::Engine::write_bytes`]).
#[tauri::command]
pub fn write_bytes(addr: u64, bytes: Vec<u8>, state: State<'_, AppState>) -> Result<(), String> {
    let guard = session(&state)?;
    with_sess(&guard)?.write_bytes(addr, &bytes)
}

#[derive(Serialize)]
pub struct BackendStatus {
    pub backend: String,
}

/// The active analysis backend, for the UI selector.
#[tauri::command]
pub fn get_backend() -> BackendStatus {
    BackendStatus {
        backend: crate::engine::active_label().to_string(),
    }
}

/// Persist the selected analysis backend (`native`, `r2`, or `ida`).
/// Returns an error if the requested backend is not available on the system.
#[tauri::command]
pub fn set_backend(backend: String) -> Result<(), String> {
    let parsed = recurse_agent::engine::BackendKind::parse(&backend)
        .ok_or_else(|| format!("unknown backend: {backend}"))?;
    if parsed == recurse_agent::engine::BackendKind::Ida
        && recurse_agent::ida_backend::find_ida_executable().is_none()
    {
        return Err("IDA Pro executable not found. Please install IDA in standard paths or set RECURSE_IDA_PATH.".to_string());
    }
    config::set_backend(Some(parsed.as_str().to_string()))
}

/// Zoom the whole window (native webview zoom, like VS Code's Ctrl +/-).
#[tauri::command]
pub fn set_zoom(scale: f64, window: tauri::WebviewWindow) -> Result<(), String> {
    window
        .set_zoom(scale)
        .map_err(|e| format!("set_zoom failed: {e}"))
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

/// Start an agent turn in the given session. Returns immediately; progress
/// streams over the `agent-event` channel. The async turn loop (LLM
/// streaming + tool calls) runs on the Tauri async runtime.
#[tauri::command]
pub async fn agent_chat(
    message: String,
    session_id: String,
    on_event: tauri::ipc::Channel<AgentEvent>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let (path, info, capabilities) = {
        let guard = state
            .session
            .lock()
            .map_err(|e| format!("session lock poisoned: {e}"))?;
        let sess = guard
            .as_ref()
            .ok_or_else(|| "no binary loaded".to_string())?;
        (
            sess.path().to_string_lossy().to_string(),
            sess.info()?,
            sess.capabilities(),
        )
    };
    // Resolved fresh on every turn (not the startup-time `state.llm`
    // snapshot): a multi-provider OAuth credential needs its expiry
    // checked, and transparently refreshed, on every call, not just once
    // at launch. Falls back to the legacy single-provider `state.llm`
    // config when no `crate::providers` entry has ever been selected.
    let config = crate::providers::resolve_llm_config().await;
    let agent = state.agent.clone();
    // Arc clone: the worker task can't hold `State`, but it needs the live
    // engine session to serve the analysis tool from the UI's own analysis state.
    let session_state = state.session.clone();
    // Arc clone: the debugger tool runs on a blocking thread and must outlive
    // the borrow of `State`.
    let debug_state = state.debug.clone();
    let project = current_project(&state)?;
    let project_storage = project.clone();
    let config_storage = config.clone();
    let sid = session_id.clone();

    // The panic channel stays outside: the worker task owns `on_event`, so
    // a panicking worker still reports through this clone.
    let panic_channel = on_event.clone();
    let worker = tauri::async_runtime::spawn(async move {
        let mut tools = recurse_agent::tools::schema(capabilities);
        tools.extend(recurse_agent::memory::memory_tool_schema());
        tools.push(recurse_debug::tool::tool_schema());
        // Memory is owned by recurse_agent (SQLite + BM25); the host only
        // resolves which project the turn belongs to.
        let mem_project = project.clone().unwrap_or_else(|| "default".to_string());
        let memory = crate::db::memory_store()
            .and_then(|s| s.summary(&mem_project, 4000))
            .unwrap_or_default();
        // The engine's metadata shape stays on the host side: the library only ever
        // sees the normalized PromptTarget interface.
        let target = recurse_agent::agent::PromptTarget {
            path,
            arch: info["bin"]["arch"].as_str().unwrap_or("?").to_string(),
            bits: info["bin"]["bits"].as_u64().unwrap_or(0),
            kind: info["bin"]["type"].as_str().unwrap_or("?").to_string(),
            memory,
            capabilities,
        };

        // The async mutex is held across the whole turn; cancel/reset wait
        // on it instead of wedging a thread.
        let mut guard = agent.lock().await;
        // Clone per call so the returned future owns its data (the run
        // loop is generic over the future, no boxing needed).
        // Memory tools are owned by recurse_agent and served from SQLite;
        // everything else falls through to the base tool runtime.
        let mut exec = |tc: &ToolCall| {
            let tc = tc.clone();
            let mem_project = mem_project.clone();
            // Clone per call: the closure must stay `FnMut`, so it can't move
            // the Arc into the first future it produces.
            let session_state = session_state.clone();
            let debug_state = debug_state.clone();
            async move {
                match tc.function.name.as_str() {
                    "memory_save" | "memory_load" | "memory_search" => {
                        let args: serde_json::Value = serde_json::from_str(&tc.function.arguments)
                            .unwrap_or(serde_json::Value::Null);
                        crate::db::memory_store()
                            .and_then(|s| s.execute_tool(&mem_project, &tc.function.name, &args))
                    }
                    // Backend-neutral analysis tool: serve it from the live
                    // engine the UI is already driving, so analysis state is
                    // shared and the result is projected/capped the same way
                    // as in the harness. Accept the op as the tool name too.
                    name if recurse_agent::engine::is_op(name) => {
                        let args: serde_json::Value = serde_json::from_str(&tc.function.arguments)
                            .unwrap_or(serde_json::Value::Null);
                        let guard = session_state
                            .lock()
                            .map_err(|e| format!("session lock poisoned: {e}"))?;
                        match guard.as_ref() {
                            Some(engine) => {
                                recurse_agent::engine::execute_call(engine.as_ref(), name, &args)
                            }
                            None => Err("no binary loaded".to_string()),
                        }
                    }
                    // Debugger tool: served from the host's debug session (the
                    // same one the UI drives), on a blocking thread because it
                    // waits in `waitpid` while running.
                    name if recurse_debug::tool::is_op(name) => {
                        let args: serde_json::Value = serde_json::from_str(&tc.function.arguments)
                            .unwrap_or(serde_json::Value::Null);
                        let op = name.to_string();
                        let session = session_state.clone();
                        let debug = debug_state.clone();
                        tauri::async_runtime::spawn_blocking(move || {
                            crate::debug::run_op(session, debug, &op, &args)
                        })
                        .await
                        .map_err(|e| format!("debug task failed: {e}"))?
                    }
                    _ => recurse_agent::tools::execute(&tc).await,
                }
            }
        };
        let mut emit = |ev: AgentEvent| {
            let _ = on_event.send(ev);
        };
        let outcome = guard
            .run(
                "run", &config, &target, &message, &tools, &mut exec, &mut emit,
            )
            .await
            .map(|_| guard.messages().to_vec());
        // Release the agent before session bookkeeping so a concurrent
        // cancel/reset lands promptly instead of waiting on file IO.
        drop(guard);
        match outcome {
            Ok(messages) => {
                persist_history(project_storage.as_deref(), &sid, &messages);
            }
            Err(message) => {
                let _ = on_event.send(AgentEvent::Error {
                    run_id: "run".into(),
                    message,
                });
            }
        }

        // Remember the model + bump the recency, and title a brand-new session.
        let _ = sessions::set_model(project_storage.as_deref(), &sid, &config_storage.model);
        let _ = sessions::touch(project_storage.as_deref(), &sid);
        ensure_session_name(project_storage.as_deref(), &sid, &config_storage, &message).await;
    });
    // Supervisor: the command returns immediately, but a panicking worker
    // must still surface an Error event instead of hanging the frontend.
    tauri::async_runtime::spawn(async move {
        if let Err(e) = worker.await {
            let _ = panic_channel.send(AgentEvent::Error {
                run_id: "run".into(),
                message: format!("agent worker panicked: {e}"),
            });
        }
    });

    Ok(())
}

/// If this is a brand-new session (still named "New session"), ask the model
/// to title it from the first user message. Falls back to a truncated message.
async fn ensure_session_name(
    project: Option<&str>,
    session_id: &str,
    config: &agent::LlmConfig,
    message: &str,
) {
    if let Ok(s) = sessions::get(project, session_id) {
        if s.name.is_empty() || s.name == "New session" {
            let name = agent::generate_title(config, message).await;
            let _ = sessions::set_name(project, session_id, &name);
        }
    }
}

/// Ask the in-flight agent run to stop. Cooperative: lands between tool
/// iterations; the run then emits an Error("run cancelled") event like any
/// other failure so the frontend resets uniformly.
#[tauri::command]
pub async fn agent_cancel_run(state: State<'_, AppState>) -> Result<(), String> {
    state.agent.lock().await.request_cancel();
    Ok(())
}

#[tauri::command]
pub async fn agent_reset(state: State<'_, AppState>) -> Result<(), String> {
    {
        state.agent.lock().await.reset();
    }
    let project = current_project_of(&state)?;
    if let Some(sid) = current_session_id_of(&state)? {
        let _ = sessions::save_history(project.as_deref(), &sid, "[]");
    }
    Ok(())
}

/// Restore the active session's persisted conversation into the agent and
/// return the messages (used by the frontend to render on load / reload).
#[tauri::command]
pub async fn agent_history(state: State<'_, AppState>) -> Result<Vec<agent::ChatMessage>, String> {
    let project = current_project(&state)?;
    let sid = current_session_id(&state)?;
    let mut agent = state.agent.lock().await;
    if let Some(sid) = sid {
        if let Some(json) = sessions::load_history(project.as_deref(), &sid) {
            if let Ok(msgs) = serde_json::from_str::<Vec<agent::ChatMessage>>(&json) {
                agent.load(msgs.clone());
                return Ok(msgs);
            }
        }
    }
    agent.reset();
    Ok(vec![])
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn sessions_list(project: String) -> Result<Vec<Session>, String> {
    sessions::list(Some(&project))
}

/// Create a new session for the active project and make it current.
/// Core of [`sessions_create`]; see [`open_binary_impl`].
pub async fn sessions_create_impl(state: &AppState) -> Result<Session, String> {
    let project = current_project_of(state)?;
    let model = state
        .llm
        .lock()
        .map_err(|e| format!("llm lock poisoned: {e}"))?
        .model
        .clone();
    let s = sessions::create(project.as_deref(), &model)?;
    state.agent.lock().await.reset();
    *state
        .current_session
        .lock()
        .map_err(|e| format!("current_session lock poisoned: {e}"))? = Some(s.id.clone());
    Ok(s)
}

#[tauri::command]
pub async fn sessions_create(state: State<'_, AppState>) -> Result<Session, String> {
    sessions_create_impl(&state).await
}

/// Switch to a session: load its history into the agent and restore its model.
/// Core of [`sessions_select`]; see [`open_binary_impl`].
pub async fn sessions_select_impl(state: &AppState, session_id: &str) -> Result<Session, String> {
    let project = current_project_of(state)?;
    let s = sessions::get(project.as_deref(), session_id)?;
    {
        let mut agent = state.agent.lock().await;
        match sessions::load_history(project.as_deref(), session_id) {
            Some(json) => match serde_json::from_str::<Vec<agent::ChatMessage>>(&json) {
                Ok(msgs) => agent.load(msgs),
                Err(_) => agent.reset(),
            },
            None => agent.reset(),
        }
    }
    {
        let mut llm = state
            .llm
            .lock()
            .map_err(|e| format!("llm lock poisoned: {e}"))?;
        if !s.model.is_empty() {
            llm.model = s.model.clone();
        }
    }
    *state
        .current_session
        .lock()
        .map_err(|e| format!("current_session lock poisoned: {e}"))? = Some(s.id.clone());
    Ok(s)
}

#[tauri::command]
pub async fn sessions_select(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<Session, String> {
    sessions_select_impl(&state, &session_id).await
}

#[tauri::command]
pub fn sessions_delete(project: String, session_id: String) -> Result<(), String> {
    sessions::remove(Some(&project), &session_id)
}

#[tauri::command]
pub fn sessions_rename(project: String, session_id: String, name: String) -> Result<(), String> {
    sessions::set_name(Some(&project), &session_id, &name)
}

// ---------------------------------------------------------------------------
// LLM / projects
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct LlmStatus {
    pub provider: String,
    pub configured: bool,
    pub model: String,
    /// Normalized completions URL the agent will call.
    pub endpoint: String,
    /// True when the endpoint is not the built-in hosted provider — a local or
    /// self-hosted OpenAI-compatible server, which needs no API key.
    pub custom: bool,
}

/// Core of [`llm_status`]; see [`open_binary_impl`].
pub fn llm_status_impl(state: &AppState) -> Result<LlmStatus, String> {
    let config = state
        .llm
        .lock()
        .map_err(|e| format!("llm lock poisoned: {e}"))?;
    let custom = !is_hosted_provider(&config.endpoint);
    let has_key = config
        .api_key
        .as_ref()
        .map(|k| !k.is_empty())
        .unwrap_or(false);
    Ok(LlmStatus {
        provider: if custom {
            "custom".into()
        } else {
            "openrouter".into()
        },
        // A custom endpoint may be keyless; the hosted provider needs a key.
        configured: has_key || custom,
        model: config.model.clone(),
        endpoint: config.endpoint.clone(),
        custom,
    })
}

#[tauri::command]
pub fn llm_status(state: State<'_, AppState>) -> Result<LlmStatus, String> {
    llm_status_impl(&state)
}

/// Core of [`set_model`]; see [`open_binary_impl`].
pub fn set_model_impl(state: &AppState, id: &str) -> Result<(), String> {
    config::set_model(id.to_string())?;
    let mut config = state
        .llm
        .lock()
        .map_err(|e| format!("llm lock poisoned: {e}"))?;
    config.model = id.to_string();
    Ok(())
}

#[tauri::command]
pub fn set_model(id: String, state: State<'_, AppState>) -> Result<(), String> {
    set_model_impl(&state, &id)
}

/// Core of [`save_api_key`]; see [`open_binary_impl`].
pub fn save_api_key_impl(state: &AppState, key: &str) -> Result<(), String> {
    let trimmed = key.trim();
    let key_opt = if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    };
    config::set_api_key(key_opt.clone())?;
    let mut config = state
        .llm
        .lock()
        .map_err(|e| format!("llm lock poisoned: {e}"))?;
    config.api_key = key_opt;
    Ok(())
}

#[tauri::command]
pub fn save_api_key(key: String, state: State<'_, AppState>) -> Result<(), String> {
    save_api_key_impl(&state, &key)
}

/// Core of [`set_endpoint`]; see [`open_binary_impl`]. An empty string clears
/// the override and restores the built-in hosted endpoint.
pub fn set_endpoint_impl(state: &AppState, endpoint: &str) -> Result<(), String> {
    let trimmed = endpoint.trim();
    config::set_endpoint(if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    })?;
    let mut config = state
        .llm
        .lock()
        .map_err(|e| format!("llm lock poisoned: {e}"))?;
    config.endpoint = recurse_agent::agent::normalize_endpoint(trimmed);
    Ok(())
}

#[tauri::command]
pub fn set_endpoint(endpoint: String, state: State<'_, AppState>) -> Result<(), String> {
    set_endpoint_impl(&state, &endpoint)
}

/// True when a normalized completions URL targets the built-in hosted provider
/// rather than a custom/local OpenAI-compatible server.
fn is_hosted_provider(endpoint: &str) -> bool {
    endpoint.contains("openrouter.ai")
}

/// Derive the OpenAI-compatible `/models` base URL from a completions URL.
fn models_base_url(endpoint: &str) -> String {
    let trimmed = endpoint.trim_end_matches('/');
    let trimmed = trimmed
        .strip_suffix("/chat/completions")
        .or_else(|| trimmed.strip_suffix("/completions"))
        .unwrap_or(trimmed);
    trimmed.trim_end_matches('/').to_string()
}

/// OpenRouter model catalog endpoint (public, unauthenticated).
const OPENROUTER_MODELS_LIST: &str = "https://openrouter.ai/api/v1/models";

#[derive(Deserialize)]
struct OrResponse {
    data: Vec<OrModel>,
}

#[derive(Deserialize)]
struct OrModel {
    id: String,
    name: String,
    #[serde(default)]
    context_length: Option<u64>,
    #[serde(default)]
    pricing: Option<OrPricing>,
    #[serde(default)]
    architecture: Option<OrArchitecture>,
}

#[derive(Deserialize, Default)]
struct OrArchitecture {
    #[serde(default)]
    input_modalities: Vec<String>,
    #[serde(default)]
    output_modalities: Vec<String>,
}

#[derive(Deserialize, Default)]
struct OrPricing {
    #[serde(default)]
    prompt: String,
}

/// Text-only models: accept text on input (may also accept other modalities)
/// but produce text-only output. This drops image/video/audio output models
/// (VLMs, TTS, etc.).
fn is_text_model(m: &OrModel) -> bool {
    match m.architecture.as_ref() {
        Some(a) => {
            let input_has_text = a.input_modalities.iter().any(|x| x == "text");
            let output_text_only =
                a.output_modalities.len() == 1 && a.output_modalities[0] == "text";
            input_has_text && output_text_only
        }
        None => true,
    }
}

/// Fetch the full OpenRouter model catalog (public, unauthenticated).
fn fetch_models() -> Result<Vec<ModelInfo>, String> {
    let resp: OrResponse = ureq::get(OPENROUTER_MODELS_LIST)
        .call()
        .map_err(|e| format!("models request failed: {e}"))?
        .into_json()
        .map_err(|e| format!("models parse failed: {e}"))?;

    let models: Vec<ModelInfo> = resp
        .data
        .into_iter()
        .filter(is_text_model)
        .map(|m| {
            let prompt_price = m
                .pricing
                .as_ref()
                .map(|p| p.prompt.clone())
                .unwrap_or_default();
            ModelInfo {
                id: m.id,
                name: m.name,
                context_length: m.context_length.unwrap_or(0),
                free: prompt_price == "0",
                prompt_price,
            }
        })
        .collect();
    cache_models(&models);
    Ok(models)
}

/// Fetch the model list from an OpenAI-compatible `{base}/models` endpoint.
/// Lenient about the response shape — `{"data":[{"id":…}]}` or a bare array —
/// and about fields: only `id` is required. Returns an empty list (not an
/// error) when the server exposes no catalog, so the UI can fall back to a
/// typed model id.
fn fetch_custom_models(
    base: &str,
    api_key: &str,
    extra_headers: &[(String, String)],
) -> Result<Vec<ModelInfo>, String> {
    let url = format!("{base}/models");
    let mut request = ureq::get(&url);
    for (name, value) in extra_headers {
        request = request.set(name, value);
    }
    let request = if api_key.is_empty() {
        request
    } else {
        request.set("Authorization", &format!("Bearer {api_key}"))
    };
    let value: serde_json::Value = request
        .call()
        .map_err(|e| format!("models request failed: {e}"))?
        .into_json()
        .map_err(|e| format!("models parse failed: {e}"))?;
    let array = value
        .get("data")
        .and_then(|d| d.as_array())
        .or_else(|| value.as_array());
    let mut out = Vec::new();
    if let Some(array) = array {
        for m in array {
            let Some(id) = m.get("id").and_then(|v| v.as_str()) else {
                continue;
            };
            let name = m.get("name").and_then(|v| v.as_str()).unwrap_or(id);
            out.push(ModelInfo {
                id: id.to_string(),
                name: name.to_string(),
                context_length: m
                    .get("context_length")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0),
                prompt_price: String::new(),
                free: false,
            });
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out.dedup_by(|a, b| a.id == b.id);
    Ok(out)
}

/// Model catalog cache in SQLite (`models` table, 24h TTL). Best-effort:
/// cache failures never fail the fetch itself.
fn cache_models(models: &[ModelInfo]) {
    let Ok(conn) = crate::db::connect() else {
        return;
    };
    let ts = crate::db::now();
    for m in models {
        let _ = conn.execute(
            "INSERT INTO models (id, name, context_length, prompt_price, is_free, fetched_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT (id) DO UPDATE SET name = excluded.name,
                                              context_length = excluded.context_length,
                                              prompt_price = excluded.prompt_price,
                                              is_free = excluded.is_free,
                                              fetched_at = excluded.fetched_at",
            rusqlite::params![
                m.id,
                m.name,
                m.context_length as i64,
                m.prompt_price,
                i64::from(m.free),
                ts
            ],
        );
    }
}

fn cached_models(max_age_secs: i64) -> Option<Vec<ModelInfo>> {
    let conn = crate::db::connect().ok()?;
    let cutoff = crate::db::now() - max_age_secs;
    let mut stmt = conn
        .prepare(
            "SELECT id, name, context_length, prompt_price, is_free FROM models
             WHERE fetched_at > ?1",
        )
        .ok()?;
    let rows = stmt
        .query_map(rusqlite::params![cutoff], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })
        .ok()?;
    let mut out = Vec::new();
    for row in rows {
        match row {
            Ok((id, name, context_length, prompt_price, is_free)) => out.push(ModelInfo {
                id,
                name,
                context_length: context_length.max(0) as u64,
                prompt_price,
                free: is_free != 0,
            }),
            Err(_) => return None,
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// Fetch Anthropic's own model catalog (`GET /v1/models`, a real,
/// documented endpoint distinct from the OpenAI-compatible `/models`
/// shape `fetch_custom_models` handles) — used only for the
/// `Protocol::AnthropicNative` (Claude OAuth) case, since that provider
/// never speaks the OpenAI-compatible wire format at all.
fn fetch_anthropic_models(api_key: &str) -> Result<Vec<ModelInfo>, String> {
    let value: serde_json::Value = ureq::get("https://api.anthropic.com/v1/models")
        .set(
            "anthropic-version",
            recurse_agent::anthropic::ANTHROPIC_VERSION,
        )
        .set("anthropic-beta", recurse_agent::anthropic::OAUTH_BETA)
        .set("Authorization", &format!("Bearer {api_key}"))
        .call()
        .map_err(|e| format!("anthropic models request failed: {e}"))?
        .into_json()
        .map_err(|e| format!("anthropic models parse failed: {e}"))?;
    let mut out = Vec::new();
    if let Some(array) = value.get("data").and_then(|d| d.as_array()) {
        for m in array {
            let Some(id) = m.get("id").and_then(|v| v.as_str()) else {
                continue;
            };
            let name = m.get("display_name").and_then(|v| v.as_str()).unwrap_or(id);
            out.push(ModelInfo {
                id: id.to_string(),
                name: name.to_string(),
                context_length: 0,
                prompt_price: String::new(),
                free: false,
            });
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn list_models(
    refresh: bool,
    state: State<'_, AppState>,
) -> Result<Vec<ModelInfo>, String> {
    let config = crate::providers::resolve_llm_config().await;
    if config.protocol == recurse_agent::agent::Protocol::AnthropicNative {
        let key = config.api_key.as_deref().unwrap_or("");
        return fetch_anthropic_models(key);
    }
    let (endpoint, api_key) = (
        config.endpoint.clone(),
        config.api_key.clone().unwrap_or_default(),
    );
    // A custom/local endpoint (or any newly selected `crate::providers`
    // entry other than the legacy OpenRouter default) has its own
    // catalog, which is not cached (the endpoint can change per run).
    if !is_hosted_provider(&endpoint) {
        return fetch_custom_models(&models_base_url(&endpoint), &api_key, &config.extra_headers);
    }
    const CACHE_TTL_SECS: i64 = 24 * 60 * 60;
    if !refresh {
        {
            let guard = state
                .models
                .lock()
                .map_err(|e| format!("models lock poisoned: {e}"))?;
            if let Some(cached) = guard.as_ref() {
                return Ok(cached.clone());
            }
        }
        // SQLite cache survives restarts; in-memory cache is per-launch.
        if let Some(cached) = cached_models(CACHE_TTL_SECS) {
            let mut guard = state
                .models
                .lock()
                .map_err(|e| format!("models lock poisoned: {e}"))?;
            *guard = Some(cached.clone());
            return Ok(cached);
        }
    }
    let models = fetch_models()?;
    let mut guard = state
        .models
        .lock()
        .map_err(|e| format!("models lock poisoned: {e}"))?;
    *guard = Some(models.clone());
    Ok(models)
}

// ---------------------------------------------------------------------------
// Multi-provider auth: `crate::providers`/`recurse_agent::oauth` glue.
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn providers_list() -> Vec<crate::providers::ProviderStatus> {
    crate::providers::list_status()
}

#[tauri::command]
pub fn provider_save_api_key(id: String, key: String) -> Result<(), String> {
    crate::providers::save_api_key(&id, Some(key))
}

#[tauri::command]
pub fn provider_clear_credential(id: String) -> Result<(), String> {
    crate::providers::clear_credential(&id)
}

#[tauri::command]
pub fn provider_set_active(id: String) -> Result<(), String> {
    if recurse_agent::providers::find(&id).is_none() {
        return Err(format!("unknown provider: {id}"));
    }
    crate::config::set_active_provider(Some(id))
}

/// What the frontend needs to open the browser and later submit the
/// pasted code — the PKCE verifier round-trips through the frontend
/// rather than living in server-side state, so a restarted app (or a
/// user who never finishes the flow) never leaves anything to clean up.
#[derive(Serialize)]
pub struct AnthropicLoginStart {
    pub authorize_url: String,
    pub verifier: String,
}

#[tauri::command]
pub fn anthropic_oauth_start() -> AnthropicLoginStart {
    let login = recurse_agent::oauth::anthropic::start_login();
    AnthropicLoginStart {
        authorize_url: login.authorize_url,
        verifier: login.verifier,
    }
}

/// Complete a Claude Pro/Max login: exchange the user-pasted `code#state`
/// string for a real token, store it, and make this provider active.
#[tauri::command]
pub async fn anthropic_oauth_finish(pasted_code: String, verifier: String) -> Result<(), String> {
    let token = recurse_agent::oauth::anthropic::exchange_code(&pasted_code, &verifier).await?;
    crate::providers::save_oauth_token("anthropic-oauth", &token)?;
    crate::config::set_active_provider(Some("anthropic-oauth".to_string()))
}

#[derive(Serialize)]
pub struct DeviceLoginInfo {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub interval_secs: u64,
    pub expires_in_secs: u64,
}

#[tauri::command]
pub async fn github_copilot_device_start() -> Result<DeviceLoginInfo, String> {
    let start = recurse_agent::oauth::github_copilot::start_device_flow().await?;
    Ok(DeviceLoginInfo {
        device_code: start.device_code,
        user_code: start.user_code,
        verification_uri: start.verification_uri,
        interval_secs: start.interval_secs,
        expires_in_secs: start.expires_in_secs,
    })
}

/// Poll until the user approves the device in their browser (or the code
/// expires), then exchange the resulting GitHub token for a Copilot
/// session token, store it, and make this provider active. One blocking
/// async command rather than frontend-side polling — the frontend just
/// awaits this after showing the user/verification code from
/// [`github_copilot_device_start`].
#[tauri::command]
pub async fn github_copilot_device_finish(
    device_code: String,
    interval_secs: u64,
    expires_in_secs: u64,
) -> Result<(), String> {
    use recurse_agent::oauth::github_copilot::{
        exchange_copilot_token, poll_device_flow, PollOutcome,
    };
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(expires_in_secs);
    let interval = std::time::Duration::from_secs(interval_secs.max(1));
    let ghu_token = loop {
        if std::time::Instant::now() >= deadline {
            return Err("device login expired before it was approved".to_string());
        }
        match poll_device_flow(&device_code).await? {
            PollOutcome::Approved(token) => break token,
            PollOutcome::Pending => tokio::time::sleep(interval).await,
        }
    };
    let session_token = exchange_copilot_token(&ghu_token).await?;
    crate::providers::save_oauth_token("github-copilot", &session_token)?;
    crate::config::set_active_provider(Some("github-copilot".to_string()))
}

// ---------------------------------------------------------------------------
// Memories (owned by recurse_agent, stored in SQLite + FTS5/BM25)
// ---------------------------------------------------------------------------

fn mem_project(project: Option<&str>) -> String {
    project.unwrap_or("default").to_string()
}

#[tauri::command]
pub fn memories_list(project: String) -> Result<Vec<String>, String> {
    crate::db::memory_store()?.list(&mem_project(Some(&project)))
}

#[tauri::command]
pub fn memory_get(project: String, key: String) -> Result<String, String> {
    crate::db::memory_store()?.load(&mem_project(Some(&project)), &key)
}

#[tauri::command]
pub fn memory_save(project: String, key: String, content: String) -> Result<(), String> {
    crate::db::memory_store()?.save(&mem_project(Some(&project)), &key, &content)
}

#[tauri::command]
pub fn memory_remove(project: String, key: String) -> Result<(), String> {
    crate::db::memory_store()?.remove(&mem_project(Some(&project)), &key)
}

#[derive(serde::Serialize)]
pub struct MemoryHit {
    pub key: String,
    pub snippet: String,
}

#[tauri::command]
pub fn memory_search(
    project: String,
    query: String,
    limit: Option<i64>,
) -> Result<Vec<MemoryHit>, String> {
    let hits = crate::db::memory_store()?.search(
        &mem_project(Some(&project)),
        &query,
        limit.unwrap_or(5),
    )?;
    Ok(hits
        .into_iter()
        .map(|(key, content, _rank)| MemoryHit {
            key,
            snippet: content.chars().take(1200).collect(),
        })
        .collect())
}

#[tauri::command]
pub fn list_projects() -> Result<Vec<Project>, String> {
    project::list()
}

/// Core of [`create_project`]; see [`open_binary_impl`].
pub fn create_project_impl(
    state: &AppState,
    name: &str,
    binary_path: &str,
) -> Result<Project, String> {
    let p = project::create(name, binary_path)?;
    *state
        .project
        .lock()
        .map_err(|e| format!("project lock poisoned: {e}"))? = Some(p.clone());
    Ok(p)
}

#[tauri::command]
pub fn create_project(
    name: String,
    binary_path: String,
    state: State<'_, AppState>,
) -> Result<Project, String> {
    create_project_impl(&state, &name, &binary_path)
}

/// Core of [`open_project`]; see [`open_binary_impl`].
pub fn open_project_impl(state: &AppState, name: &str) -> Result<Project, String> {
    let p = project::get(name)?;
    project::touch(name)?;
    *state
        .project
        .lock()
        .map_err(|e| format!("project lock poisoned: {e}"))? = Some(p.clone());
    Ok(p)
}

#[tauri::command]
pub fn open_project(name: String, state: State<'_, AppState>) -> Result<Project, String> {
    open_project_impl(&state, &name)
}

#[tauri::command]
pub fn delete_project(name: String) -> Result<(), String> {
    project::remove(&name)
}

#[tauri::command]
pub fn project_read_file(name: String, path: String) -> Result<String, String> {
    project::read_file(&name, &path)
}

#[tauri::command]
pub fn project_write_file(name: String, path: String, content: String) -> Result<(), String> {
    project::write_file(&name, &path, &content)
}

#[tauri::command]
pub fn project_list_files(name: String) -> Result<Vec<String>, String> {
    project::list_files(&name)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
    use super::*;

    #[test]
    fn models_base_url_strips_the_completions_route() {
        assert_eq!(
            models_base_url("https://openrouter.ai/api/v1/chat/completions"),
            "https://openrouter.ai/api/v1"
        );
        assert_eq!(
            models_base_url("http://localhost:11434/v1/chat/completions"),
            "http://localhost:11434/v1"
        );
        assert_eq!(
            models_base_url("http://127.0.0.1:8080/v1"),
            "http://127.0.0.1:8080/v1"
        );
    }

    #[test]
    fn hosted_provider_is_detected_by_host() {
        assert!(is_hosted_provider(
            "https://openrouter.ai/api/v1/chat/completions"
        ));
        assert!(!is_hosted_provider(
            "http://localhost:11434/v1/chat/completions"
        ));
        assert!(!is_hosted_provider(
            "https://api.openai.com/v1/chat/completions"
        ));
    }
}
