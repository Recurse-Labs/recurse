//! Headless task runner: drives one crackme end-to-end through
//! [`recurse_agent::agent::Agent`] with debug tracing on, bounded turns and a
//! wall-clock timeout, then grades the final answer. Rust only.

use std::path::{Path, PathBuf};
use std::time::Duration;

use recurse_agent::agent::{Agent, AgentEvent, LlmConfig, PromptTarget, ToolCall};
use recurse_agent::engine::{BackendKind, Capabilities, Engine};
use recurse_agent::memory::MemoryStore;

use crate::{contains_token, cost_usd, env_string, grade_flag, prompt_target_for, Task};

/// Eval-wide knobs. Everything a tier swap or nightly matrix would vary.
#[derive(Clone, Debug)]
pub struct EvalOpts {
    pub model: String,
    pub endpoint: String,
    pub api_key: String,
    /// Analysis backend the agent drives: `native` or r2. Resolved from
    /// `EVAL_BACKEND`, then `RECURSE_BACKEND`, then the app default (native).
    pub backend: BackendKind,
    pub max_turns: usize,
    pub timeout_secs: u64,
    pub corpus_dir: PathBuf,
    pub trace_dir: PathBuf,
}

impl EvalOpts {
    /// Resolve from the environment (`RECURSE_LLM_*`, `EVAL_*`), with the
    /// same defaults as the app. Missing API key is an error, not a panic.
    /// Resolve from `crates/recurse-eval/.env` + the environment (`EVAL_*`,
    /// `RECURSE_LLM_*`), with the same defaults as the app. Empty values count
    /// as unset. A missing API key is an error, not a panic.
    pub fn from_env(corpus_dir: PathBuf, trace_dir: PathBuf) -> Result<Self, String> {
        let fallback = LlmConfig::default();
        let api_key = fallback.api_key.filter(|k| !k.is_empty()).ok_or_else(|| {
            "no API key: set RECURSE_LLM_API_KEY in crates/recurse-eval/.env".to_string()
        })?;
        Ok(Self {
            model: env_string("EVAL_MODEL").unwrap_or(fallback.model),
            endpoint: env_string("EVAL_ENDPOINT").unwrap_or(fallback.endpoint),
            api_key,
            backend: resolve_backend(None),
            max_turns: env_string("EVAL_MAX_TURNS")
                .and_then(|v| v.parse().ok())
                .unwrap_or(40),
            timeout_secs: env_string("EVAL_TIMEOUT_SECS")
                .and_then(|v| v.parse().ok())
                .unwrap_or(480),
            corpus_dir,
            trace_dir,
        })
    }
}

/// Resolve the backend with the eval's precedence: `EVAL_BACKEND` > the tier
/// YAML's `run.backend` (`yaml`) > `RECURSE_BACKEND` > the app default
/// (`native`). An unknown env value is ignored rather than fatal.
///
/// ```
/// use recurse_agent::engine::BackendKind;
/// use recurse_eval::runner::resolve_backend;
/// std::env::remove_var("EVAL_BACKEND");
/// std::env::remove_var("RECURSE_BACKEND");
/// // YAML wins when the env override is absent.
/// assert_eq!(resolve_backend(Some(BackendKind::Native)), BackendKind::Native);
/// // Env wins over YAML when set.
/// std::env::set_var("EVAL_BACKEND", "r2");
/// assert_eq!(resolve_backend(Some(BackendKind::Native)), BackendKind::R2);
/// std::env::remove_var("EVAL_BACKEND");
/// ```
pub fn resolve_backend(yaml: Option<BackendKind>) -> BackendKind {
    env_string("EVAL_BACKEND")
        .and_then(|v| BackendKind::parse(&v))
        .or(yaml)
        .unwrap_or_else(BackendKind::from_env)
}

/// What happened on one task.
#[derive(Clone, Debug)]
pub struct TaskOutcome {
    pub hexid: String,
    pub name: String,
    pub pass: bool,
    pub final_answer: String,
    pub turns: usize,
    pub est_in_tokens: u64,
    pub est_out_tokens: u64,
    pub cost_usd: f64,
    /// Distinct models that actually served this task, in first-seen order.
    /// Empty when the endpoint didn't report one. With a router this is the
    /// only way to know what answered.
    pub models: Vec<String>,
    /// Analysis backend this task ran against.
    pub backend: BackendKind,
    /// Total wall-clock time spent inside analysis tool calls (ms) — separates
    /// backend latency from model-turn latency.
    pub tool_ms: u64,
    pub error: Option<String>,
    pub trace_path: PathBuf,
    /// Kept workdir (temp task dir) for post-mortems.
    pub workdir: PathBuf,
}

/// The task prompt, phrased for the active backend's capabilities. Both
/// backends advertise `decompile` now: `native` renders pseudocode via
/// `recurse-vtil` (see `docs/vtil-lift.md`), `r2` via its own decompiler
/// plugin when installed.
fn task_prompt(binary: &Path, backend: BackendKind) -> String {
    let ops = match backend {
        BackendKind::R2 => "functions, disasm, decompile, xrefs, strings, imports",
        BackendKind::Native => "functions, disasm, decompile, lift, xrefs, strings, imports",
        BackendKind::Ida => "functions, disasm, decompile, strings, raw",
    };
    format!(
        "Recover a valid serial/key for the binary at {}.\n\
         Use the `analyze` tool for static analysis (ops: {ops}) and Python for decoding/brute-force. \
         You can run the binary to check a candidate key. When you have one that \
         works, finish with a final message containing the exact serial on its own \
         line prefixed with `FLAG:` (e.g. `FLAG: hunter2`).",
        binary.display()
    )
}

/// Run one task: isolated workdir + memory DB, debug trace on, bounded.
pub async fn run_task(task: &Task, binary: &Path, opts: &EvalOpts) -> Result<TaskOutcome, String> {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let workdir = std::env::temp_dir().join(format!(
        "recurse-eval-{}-{}-{}",
        task.hexid,
        std::process::id(),
        nanos
    ));
    std::fs::create_dir_all(&workdir).map_err(|e| format!("workdir: {e}"))?;

    let config = LlmConfig::new(
        opts.endpoint.clone(),
        Some(opts.api_key.clone()),
        opts.model.clone(),
    );
    let mem_project = format!("eval-{}", task.hexid);
    // Fresh memory DB per task; `open` creates tables idempotently.
    let store = MemoryStore::open(workdir.join("memory.db"))?;

    // One analysed backend for the whole task, so discovery runs once and
    // every later query is a cheap follow-up. The backend is `opts.backend`
    // (`EVAL_BACKEND` / the tier YAML / `RECURSE_BACKEND`).
    let engine: Option<std::sync::Arc<std::sync::Mutex<Box<dyn Engine>>>> = match opts.backend {
        BackendKind::R2 => match recurse_agent::r2_backend::R2Engine::open(binary) {
            Ok(e) => Some(std::sync::Arc::new(std::sync::Mutex::new(
                Box::new(e) as Box<dyn Engine>
            ))),
            Err(e) => {
                eprintln!("[eval] r2 unavailable ({e}); falling back to bash only");
                None
            }
        },
        BackendKind::Native => match recurse_agent::native::open(binary) {
            Ok(e) => Some(std::sync::Arc::new(std::sync::Mutex::new(e))),
            Err(e) => {
                eprintln!("[eval] native engine unavailable ({e}); falling back to bash only");
                None
            }
        },
        BackendKind::Ida => match recurse_agent::ida_backend::IdaEngine::open(binary) {
            Ok(e) => Some(std::sync::Arc::new(std::sync::Mutex::new(
                Box::new(e) as Box<dyn Engine>
            ))),
            Err(e) => {
                eprintln!("[eval] IDA unavailable ({e}); falling back to bash only");
                None
            }
        },
    };
    if let Some(e) = engine.as_ref() {
        if let Ok(g) = e.lock() {
            let _ = g.analyze();
        }
    }

    // Capabilities drive both the tool schema and the prompt, so the model
    // never sees ops this backend cannot serve (decompile/raw on native).
    let capabilities = engine
        .as_ref()
        .and_then(|e| e.lock().ok().map(|g| g.capabilities()))
        .unwrap_or_else(Capabilities::none);
    let target: PromptTarget = prompt_target_for(task, &binary.to_string_lossy(), capabilities);
    let mut tools = recurse_agent::tools::schema(capabilities);
    tools.extend(recurse_agent::memory::memory_tool_schema());

    let mut agent = Agent::new();
    agent.set_debug(true);
    let mut exec = |tc: &ToolCall| {
        let tc = tc.clone();
        let mem_project = mem_project.clone();
        let store = store.clone();
        let engine = engine.clone();
        async move {
            match tc.function.name.as_str() {
                "memory_save" | "memory_load" | "memory_search" => {
                    let args: serde_json::Value = serde_json::from_str(&tc.function.arguments)
                        .unwrap_or(serde_json::Value::Null);
                    store.execute_tool(&mem_project, &tc.function.name, &args)
                }
                name if recurse_agent::engine::is_op(name) => {
                    let name = name.to_string();
                    let args: serde_json::Value = serde_json::from_str(&tc.function.arguments)
                        .unwrap_or(serde_json::Value::Null);
                    match engine {
                        Some(engine) => {
                            // Blocking analysis IO off the async runtime.
                            tokio::task::spawn_blocking(move || {
                                let guard = engine
                                    .lock()
                                    .map_err(|e| format!("analysis engine poisoned: {e}"))?;
                                recurse_agent::engine::execute_call(guard.as_ref(), &name, &args)
                            })
                            .await
                            .map_err(|e| format!("analysis task failed: {e}"))?
                        }
                        None => Err("analysis backend unavailable".to_string()),
                    }
                }
                _ => recurse_agent::tools::execute(&tc).await,
            }
        }
    };
    let mut emit = |_: AgentEvent| {};

    let run_id = format!("eval-{}", task.hexid);
    let task_msg = task_prompt(binary, opts.backend);
    let timeout = Duration::from_secs(opts.timeout_secs);
    let run = agent.run_limited(
        &run_id,
        &config,
        &target,
        &task_msg,
        &tools,
        opts.max_turns,
        &mut exec,
        &mut emit,
    );
    let run_result = tokio::time::timeout(timeout, run).await;
    let error = match &run_result {
        Ok(Ok(())) => None,
        Ok(Err(e)) => Some(e.clone()),
        Err(_) => Some(format!("wall-clock timeout after {}s", opts.timeout_secs)),
    };

    let final_answer = agent
        .messages()
        .iter()
        .rev()
        .find(|m| m.role == "assistant" && m.tool_calls.is_none())
        .and_then(|m| m.content.clone())
        .unwrap_or_default();
    let pass = error.is_none() && grade_flag(&final_answer, &task.flag);
    let turns = agent.trace().turns.len();
    let mut models: Vec<String> = Vec::new();
    for t in &agent.trace().turns {
        if let Some(m) = t.model.as_ref() {
            if !models.contains(m) {
                models.push(m.clone());
            }
        }
    }
    let est_in_tokens: u64 = agent.trace().turns.iter().map(|t| t.est_input_tokens).sum();
    let est_out_tokens: u64 = agent
        .trace()
        .turns
        .iter()
        .map(|t| t.est_output_tokens)
        .sum();
    // Analysis (not bash/memory) time, so backend latency is separable from
    // the model's own latency in a post-mortem.
    let tool_ms: u64 = agent
        .trace()
        .turns
        .iter()
        .flat_map(|t| t.tool_results.iter())
        .filter(|r| recurse_agent::engine::is_op(&r.name))
        .map(|r| r.duration_ms)
        .sum();

    std::fs::create_dir_all(&opts.trace_dir).map_err(|e| format!("trace dir: {e}"))?;
    let trace_path = opts.trace_dir.join(format!("{}.json", task.hexid));
    // Trace write is best-effort: grading must not fail because of it.
    let _ = agent.save_trace(&trace_path).await;

    // Sanity: the flag must be discoverable in principle — if even the
    // task's own description can't grade, the manifest is wrong, not the agent.
    debug_assert!(
        contains_token(&format!("FLAG: {}", task.flag), &task.flag),
        "manifest flag does not self-grade"
    );

    Ok(TaskOutcome {
        hexid: task.hexid.clone(),
        name: task.name.clone(),
        pass,
        final_answer,
        turns,
        est_in_tokens,
        est_out_tokens,
        cost_usd: cost_usd(&opts.model, est_in_tokens, est_out_tokens),
        models,
        backend: opts.backend,
        tool_ms,
        error,
        trace_path,
        workdir,
    })
}
