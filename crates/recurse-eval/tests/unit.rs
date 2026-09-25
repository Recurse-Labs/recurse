//! Fast eval self-tests: no API key, no network, no r2.
//! Covers config parsing, selection over dataset fields, grading, target
//! mapping, and the debug trace against a scripted mock LLM.

use std::collections::HashMap;
use std::path::PathBuf;

use recurse_agent::agent::{Agent, LlmConfig, ToolCall};
use recurse_eval::config::EvalConfig;
use recurse_eval::select::{select_tasks, DatasetRecord};
use recurse_eval::{
    contains_token, cost_usd, grade_flag, pricing_for, prompt_target_for, rate_label, Task,
};

fn rec(
    hexid: &str,
    difficulty: f64,
    platform: &str,
    arch: &str,
    flag: Option<&str>,
) -> DatasetRecord {
    DatasetRecord {
        hexid: hexid.into(),
        name: hexid.into(),
        difficulty: Some(difficulty),
        quality: Some(4.0),
        platform: platform.into(),
        arch: arch.into(),
        language: "C/C++".into(),
        nbsolutions: Some(10.0),
        flag: flag.map(|s| s.into()),
        has_unique_flag: Some(true),
        url: String::new(),
        obfuscation_classes: Vec::new(),
    }
}

#[test]
fn config_parses_and_defaults() {
    let yaml = r#"
tier: easy-10
select:
  difficulty_max: 1.5
  platforms: [linux]
  count: 5
  seed: 7
run:
  max_turns: 20
"#;
    let cfg: EvalConfig = serde_yaml::from_str(yaml).expect("parse");
    assert_eq!(cfg.tier, "easy-10");
    assert_eq!(cfg.select.difficulty_max, Some(1.5));
    assert_eq!(cfg.select.platforms, vec!["linux".to_string()]);
    assert_eq!(cfg.select.count, 5);
    assert_eq!(cfg.select.seed, 7);
    assert!(cfg.select.require_flag, "flag grading on by default");
    assert_eq!(cfg.run.max_turns, 20);
    assert_eq!(cfg.run.timeout_secs, 480, "run default kept");
    assert!(
        cfg.run.backend.is_none(),
        "backend defaults to unset (env/app)"
    );
    assert!(cfg.dataset.jsonl_url.contains("crackmes_dataset.jsonl"));
}

#[test]
fn run_backend_parses_from_yaml() {
    use recurse_agent::engine::BackendKind;
    let native: EvalConfig = serde_yaml::from_str("run:\n  backend: native\n").expect("parse");
    assert_eq!(native.run.backend, Some(BackendKind::Native));
    let external: EvalConfig = serde_yaml::from_str("run:\n  backend: r2\n").expect("parse");
    assert_eq!(external.run.backend, Some(BackendKind::R2));
    let ida: EvalConfig = serde_yaml::from_str("run:\n  backend: ida\n").expect("parse");
    assert_eq!(ida.run.backend, Some(BackendKind::Ida));
    // Unknown values are a parse error, not a silent fallback.
    assert!(serde_yaml::from_str::<EvalConfig>("run:\n  backend: unknown_backend\n").is_err());
}

#[test]
fn shipped_easy_config_selects_current_ten() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("evals/easy.yaml");
    let cfg = EvalConfig::load(&path).expect("load easy.yaml");
    assert_eq!(cfg.select.hexids.len(), 10);
    assert_eq!(cfg.binaries.len(), 10);
    // The shipped tier does not pin a backend; env/app default applies.
    assert!(cfg.run.backend.is_none());
    // Every binary hint points at a tier hexid (no stale entries).
    let ids: std::collections::HashSet<&str> =
        cfg.select.hexids.iter().map(|s| s.as_str()).collect();
    for key in cfg.binaries.keys() {
        assert!(ids.contains(key.as_str()), "stale binary hint {key}");
    }
}

#[test]
fn selection_filters_all_fields() {
    let records = vec![
        rec("a", 1.0, "Unix/linux etc.", "x86-64", Some("flag-a")),
        rec("b", 1.0, "Windows", "x86", Some("flag-b")),
        rec("c", 3.0, "Unix/linux etc.", "x86", Some("flag-c")),
        rec("d", 1.0, "Unix/linux etc.", "ARM", None),
    ];
    // Difficulty + platform + flag filters compose.
    let select = recurse_eval::config::SelectConfig {
        difficulty_max: Some(1.5),
        platforms: vec!["linux".to_string()],
        count: 1,
        ..Default::default()
    };
    let tasks = select_tasks(&records, &select, &HashMap::new()).expect("select");
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0].hexid, "a");
    assert_eq!(tasks[0].flag, "flag-a");
}

#[test]
fn selection_count_overflow_errors() {
    let records = vec![rec("a", 1.0, "Unix", "x86", Some("flag-a"))];
    let select = recurse_eval::config::SelectConfig {
        count: 5,
        ..Default::default()
    };
    let err = select_tasks(&records, &select, &HashMap::new()).expect_err("must fail");
    assert!(err.contains("need 5"), "actionable message: {err}");
}

#[test]
fn selection_is_deterministic_per_seed() {
    let records: Vec<DatasetRecord> = (0..20)
        .map(|i| rec(&format!("id-{i:02}"), 1.0, "Unix", "x86", Some("flag-x")))
        .collect();
    let select = recurse_eval::config::SelectConfig {
        count: 10,
        seed: 7,
        ..Default::default()
    };
    let first = select_tasks(&records, &select, &HashMap::new()).expect("select");
    let second = select_tasks(&records, &select, &HashMap::new()).expect("select");
    assert_eq!(
        first.iter().map(|t| &t.hexid).collect::<Vec<_>>(),
        second.iter().map(|t| &t.hexid).collect::<Vec<_>>(),
        "same seed, same set in same order"
    );
}

#[test]
fn explicit_hexids_win_exactly() {
    let records = vec![
        rec("a", 1.0, "Unix", "x86", Some("flag-a")),
        rec("b", 5.0, "Windows", "ARM", Some("flag-b")),
    ];
    let mut select = recurse_eval::config::SelectConfig {
        hexids: vec!["b".into(), "nope".into()],
        ..Default::default()
    };
    let err = select_tasks(&records, &select, &HashMap::new()).expect_err("missing id");
    assert!(err.contains("nope"), "names the missing id: {err}");
    select.hexids = vec!["b".into(), "a".into()];
    let mut hints = HashMap::new();
    hints.insert("b".to_string(), "b.exe".to_string());
    let tasks = select_tasks(&records, &select, &hints).expect("select");
    assert_eq!(tasks.len(), 2);
    assert_eq!(tasks[0].hexid, "b", "order kept");
    assert_eq!(tasks[0].binary, "b.exe", "hint threaded through");
    assert_eq!(tasks[1].binary, "", "no hint, magic fallback later");
}

#[test]
fn grading_boundaries() {
    assert!(grade_flag("serial 73313 works", "73313"));
    assert!(!grade_flag("x733134", "73313"), "longer numeric run");
    assert!(grade_flag("FLAG: P455w0rd", "P455w0rd"));
    assert!(!grade_flag("p455w0rd", "P455w0rd"), "case-sensitive");
    assert!(grade_flag("got d00r1$m@licious today", "d00r1$m@licious"));
    assert!(!grade_flag("anything", ""), "empty flag never grades");
    assert!(!grade_flag("short", "a"), "single-char flag never grades");
    assert!(contains_token("a PuL-sAr-001!", "PuL-sAr-001"));
    assert!(
        !contains_token("xxPuL-sAr-001", "PuL-sAr-001"),
        "left boundary"
    );
}

#[test]
fn target_mapping() {
    let task = Task {
        hexid: "h".into(),
        name: "n".into(),
        difficulty: 1.0,
        quality: 4.0,
        platform: "Windows".into(),
        arch: "x86".into(),
        language: "Assembler".into(),
        nbsolutions: 1,
        flag: "f".into(),
        binary: "b".into(),
        url: String::new(),
        tags: Vec::new(),
    };
    let t = prompt_target_for(
        &task,
        "C:\\x.exe",
        recurse_agent::engine::Capabilities::all(),
    );
    assert_eq!(t.kind, "pe");
    assert_eq!(t.bits, 32);
    let mut arm = task.clone();
    arm.platform = "Unix/linux etc.".into();
    arm.arch = "ARM".into();
    let t = prompt_target_for(&arm, "/tmp/x", recurse_agent::engine::Capabilities::all());
    assert_eq!(t.kind, "elf");
    assert_eq!(t.arch, "arm");
}

#[tokio::test]
async fn echo_path_records_no_model_turns() {
    // No API key: the agent answers from the echo fallback without any
    // model call, so the trace stays empty while history still works.
    let mut agent = Agent::new();
    agent.set_debug(true);
    let config = LlmConfig::new("http://127.0.0.1:9".into(), None, "m".into());
    let target = recurse_agent::agent::PromptTarget {
        path: "/tmp/x".into(),
        arch: "x86".into(),
        bits: 64,
        kind: "elf".into(),
        memory: String::new(),
        capabilities: recurse_agent::engine::Capabilities::all(),
    };
    let tools = recurse_agent::tools::schema(recurse_agent::engine::Capabilities::all());
    let mut exec = |_: &ToolCall| async { Ok("".to_string()) };
    let mut emit = |_: recurse_agent::agent::AgentEvent| {};
    agent
        .run("t", &config, &target, "hi", &tools, &mut exec, &mut emit)
        .await
        .expect("echo run");
    assert_eq!(agent.messages().len(), 2);
    assert!(agent.trace().turns.is_empty());
}

// ---------------------------------------------------------------------------
// Scripted mock LLM: canned SSE over a real TCP socket. Deterministic
// full-loop test (tool call -> exec -> result -> final answer) plus the
// exact per-turn trace a human would inspect after an eval.
// ---------------------------------------------------------------------------

fn sse_tool_call(id: &str, name: &str, args_json: &str) -> String {
    let payload = serde_json::json!({
        "choices": [{
            "delta": {
                "tool_calls": [{
                    "index": 0,
                    "id": id,
                    "function": {"name": name, "arguments": args_json},
                }],
            },
        }],
    });
    format!("data: {payload}\n\ndata: [DONE]\n\n")
}

fn sse_text(text: &str) -> String {
    let payload = serde_json::json!({
        "model": "some-vendor/served-model-9b",
        "choices": [{"delta": {"content": text}}],
    });
    format!("data: {payload}\n\ndata: [DONE]\n\n")
}

/// Serve `bodies` as one SSE response per incoming POST.
async fn mock_llm(bodies: Vec<String>) -> (String, tokio::task::JoinHandle<()>) {
    let raws = bodies
        .into_iter()
        .map(|b| {
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                b.len(),
                b
            )
        })
        .collect();
    mock_llm_raw(raws).await
}

/// A raw HTTP 200 carrying an SSE body (what `mock_llm_raw` expects).
fn ok_sse(body: &str) -> String {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    )
}

/// A 429 as OpenRouter sends it: JSON body plus the reset hint the driver
/// is expected to honour.
fn rate_limited_response() -> String {
    let body = r#"{"error":{"message":"Rate limit exceeded: free-models-per-min.","code":429}}"#;
    format!(
        "HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\nRetry-After: 0\r\nX-RateLimit-Reset: 1\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    )
}

/// Serve pre-built raw HTTP responses, one per incoming POST. Returns the
/// endpoint URL; the server task ends after the last response.
async fn mock_llm_raw(responses: Vec<String>) -> (String, tokio::task::JoinHandle<()>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind mock llm");
    let endpoint = format!(
        "http://{}/v1/chat/completions",
        listener.local_addr().expect("addr")
    );
    let handle = tokio::spawn(async move {
        for resp in responses {
            let Ok((mut sock, _)) = listener.accept().await else {
                return;
            };
            // Consume the request (headers + body) so the client never blocks.
            let mut buf = Vec::new();
            let mut tmp = [0u8; 4096];
            let header_end = loop {
                match sock.read(&mut tmp).await {
                    Ok(0) | Err(_) => return,
                    Ok(n) => {
                        buf.extend_from_slice(&tmp[..n]);
                        if let Some(p) = find_subslice(&buf, b"\r\n\r\n") {
                            break p + 4;
                        }
                    }
                }
            };
            let content_len = String::from_utf8_lossy(&buf[..header_end])
                .lines()
                .find_map(|l| {
                    let (k, v) = l.split_once(':')?;
                    (k.trim().eq_ignore_ascii_case("content-length"))
                        .then(|| v.trim().parse::<usize>().ok())?
                })
                .unwrap_or(0);
            while buf.len() < header_end + content_len {
                match sock.read(&mut tmp).await {
                    Ok(0) | Err(_) => return,
                    Ok(n) => buf.extend_from_slice(&tmp[..n]),
                }
            }
            let _ = sock.write_all(resp.as_bytes()).await;
        }
    });
    (endpoint, handle)
}

fn find_subslice(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

#[tokio::test]
async fn mock_loop_records_exact_turns() {
    let (endpoint, _server) = mock_llm(vec![
        sse_tool_call("call_1", "bash", r#"{"command":"echo mock-hi"}"#),
        sse_text("done FLAG: mock-hi"),
    ])
    .await;
    let config = LlmConfig::new(endpoint, Some("test".into()), "mock".into());
    let target = recurse_agent::agent::PromptTarget {
        path: "/tmp/x".into(),
        arch: "x86".into(),
        bits: 64,
        kind: "elf".into(),
        memory: String::new(),
        capabilities: recurse_agent::engine::Capabilities::all(),
    };
    let tools = recurse_agent::tools::schema(recurse_agent::engine::Capabilities::all());
    let mut agent = Agent::new();
    agent.set_debug(true);
    let mut exec = |tc: &ToolCall| {
        let tc = tc.clone();
        async move { recurse_agent::tools::execute(&tc).await }
    };
    let mut emit = |_: recurse_agent::agent::AgentEvent| {};
    agent
        .run_limited(
            "mock-run",
            &config,
            &target,
            "recover the key",
            &tools,
            5,
            &mut exec,
            &mut emit,
        )
        .await
        .expect("mock run");

    // Two model turns: tool call, then final answer.
    let trace = &agent.trace().turns;
    assert_eq!(trace.len(), 2);
    // Routers report which model actually answered; the trace must keep it so
    // an `openrouter/auto` or `openrouter/free` run is attributable.
    assert_eq!(
        trace[1].model.as_deref(),
        Some("some-vendor/served-model-9b")
    );
    let first = &trace[0];
    assert_eq!(first.run_id, "mock-run");
    assert_eq!(first.turn, 1);
    // The request is stored as indices into the shared message pool; resolve
    // it back to the exact messages that were sent.
    let turn1 = agent.trace().request_messages(1);
    assert_eq!(turn1[0].role, "system");
    assert!(
        turn1.iter().any(|m| m
            .content
            .as_deref()
            .unwrap_or("")
            .contains("recover the key")),
        "user task visible in turn-1 input"
    );
    assert!(first.tools_sent >= 4, "tool schemas counted");
    assert_eq!(first.tool_calls.len(), 1);
    assert_eq!(first.tool_calls[0].function.name, "bash");
    assert_eq!(first.tool_results.len(), 1);
    assert!(
        first.tool_results[0].result.contains("mock-hi"),
        "exact tool result captured: {}",
        first.tool_results[0].result
    );
    assert!(first.est_input_tokens > 0);
    let second = &trace[1];
    assert_eq!(second.turn, 2);
    assert_eq!(second.content, "done FLAG: mock-hi");
    assert!(second.tool_calls.is_empty());

    // Trace persists to disk as inspectable JSON.
    let path = std::env::temp_dir().join(format!("recurse-eval-unit-{}.json", std::process::id()));
    agent.save_trace(&path).await.expect("save trace");
    let text = std::fs::read_to_string(&path).expect("read trace");
    let value: serde_json::Value = serde_json::from_str(&text).expect("trace is JSON");
    assert_eq!(value["turns"].as_array().map(|a| a.len()), Some(2));
    assert!(value["conversation"]
        .as_array()
        .is_some_and(|a| !a.is_empty()));
    // The system prompt is stored once, not repeated per turn, and messages
    // live in the pool rather than being copied into every turn's request.
    assert!(value["system_prompt"]
        .as_str()
        .is_some_and(|s| !s.is_empty()));
    assert!(value["messages"].as_array().is_some_and(|a| !a.is_empty()));
    assert!(
        value["turns"][0]["request"][0].is_u64(),
        "request holds pool indices"
    );
    // Every tool call records its wall-clock duration (backend vs model time).
    assert_eq!(value["turns"][0]["tool_results"][0]["name"], "bash");
    assert!(value["turns"][0]["tool_results"][0]["duration_ms"].is_u64());
    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn trace_stores_each_message_once() {
    // Turns are cumulative: turn 2's request contains turn 1's messages. Those
    // must be pooled and referenced, not re-serialized (measured at ~8x
    // duplication and O(turns^2) file size before this).
    let (endpoint, _server) = mock_llm(vec![
        sse_tool_call("c1", "bash", r#"{"command":"echo hi"}"#),
        sse_text("done"),
    ])
    .await;
    let config = LlmConfig::new(endpoint, Some("test".into()), "mock".into());
    let target = recurse_agent::agent::PromptTarget {
        path: "/tmp/x".into(),
        arch: "x86".into(),
        bits: 64,
        kind: "elf".into(),
        memory: String::new(),
        capabilities: recurse_agent::engine::Capabilities::all(),
    };
    let tools = recurse_agent::tools::schema(recurse_agent::engine::Capabilities::all());
    let mut agent = Agent::new();
    agent.set_debug(true);
    let mut exec = |tc: &ToolCall| {
        let tc = tc.clone();
        async move { recurse_agent::tools::execute(&tc).await }
    };
    let mut emit = |_: recurse_agent::agent::AgentEvent| {};
    agent
        .run_limited(
            "dedup", &config, &target, "go", &tools, 4, &mut exec, &mut emit,
        )
        .await
        .expect("run");

    let t = agent.trace();
    assert_eq!(t.turns.len(), 2);
    assert!(
        t.turns[1].request.len() > t.turns[0].request.len(),
        "later requests are longer"
    );
    // Turn 2's request references (does not re-store) turn 1's messages.
    assert!(
        t.turns[0]
            .request
            .iter()
            .all(|i| t.turns[1].request.contains(i)),
        "shared prefix is referenced by index"
    );
    assert!(
        t.messages.len() <= t.turns[1].request.len(),
        "pool is no larger than the widest request"
    );
    // Resolving a turn reproduces exactly what was sent.
    let resolved = t.request_messages(2);
    assert_eq!(
        resolved.len(),
        t.turns[1].request.len() + 1,
        "system + request"
    );
    assert_eq!(resolved[0].role, "system");
    assert_eq!(
        resolved[0].content.as_deref(),
        Some(t.system_prompt.as_str())
    );
}

#[test]
fn free_models_are_priced_zero() {
    assert_eq!(pricing_for("openrouter/free"), (0.0, 0.0));
    assert_eq!(
        pricing_for("openrouter/auto"),
        (0.15, 0.60),
        "paid router -> fallback rate"
    );
    assert_eq!(pricing_for("meta-llama/llama-3.3-70b:free"), (0.0, 0.0));
    assert_eq!(pricing_for("deepseek/deepseek-v4.1-flash"), (0.15, 0.60));
    // A free run must never report a fabricated cost.
    assert_eq!(cost_usd("openrouter/free", 5_000_000, 1_000_000), 0.0);
    assert_eq!(rate_label("openrouter/free"), "free");
    assert_eq!(rate_label("deepseek/deepseek-v4.1-flash"), "est.");
    // Priced model: 1M in + 1M out at 0.15/0.60.
    assert!((cost_usd("deepseek/deepseek-v4.1-flash", 1_000_000, 1_000_000) - 0.75).abs() < 1e-9);
}

#[tokio::test]
async fn rate_limit_is_retried_then_succeeds() {
    // Free endpoints throttle hard (openrouter/free allows 20 req/min). A 429
    // must be waited out and retried rather than failing the whole turn.
    let (endpoint, _server) = mock_llm_raw(vec![
        rate_limited_response(),
        ok_sse(&sse_text("recovered FLAG: ok")),
    ])
    .await;
    let config = LlmConfig::new(endpoint, Some("test".into()), "mock".into());
    let target = recurse_agent::agent::PromptTarget {
        path: "/tmp/x".into(),
        arch: "x86".into(),
        bits: 64,
        kind: "elf".into(),
        memory: String::new(),
        capabilities: recurse_agent::engine::Capabilities::all(),
    };
    let tools = recurse_agent::tools::schema(recurse_agent::engine::Capabilities::all());
    let mut agent = Agent::new();
    let mut exec = |_: &ToolCall| async { Ok(String::new()) };
    let mut emit = |_: recurse_agent::agent::AgentEvent| {};
    agent
        .run_limited(
            "rl", &config, &target, "go", &tools, 3, &mut exec, &mut emit,
        )
        .await
        .expect("429 should be retried, not fatal");
    assert_eq!(
        agent
            .messages()
            .last()
            .and_then(|m| m.content.clone())
            .as_deref(),
        Some("recovered FLAG: ok")
    );
}

#[tokio::test]
async fn mock_serves_multiple_sequential_requests() {
    // Isolates the mock from the agent: two POSTs must both get a response.
    let (endpoint, _server) =
        mock_llm_raw(vec![rate_limited_response(), ok_sse(&sse_text("second"))]).await;
    let client = reqwest::Client::new();
    let r1 = client.post(&endpoint).body("{}").send().await;
    println!("first: {:?}", r1.as_ref().map(|r| r.status()));
    let second = client.post(&endpoint).body("{}").send().await;
    println!("second: {:?}", second.as_ref().map(|r| r.status()));
    assert_eq!(r1.expect("first").status().as_u16(), 429);
    assert_eq!(second.expect("second").status().as_u16(), 200);
}

#[tokio::test]
async fn empty_tool_result_is_replaced_not_sent_verbatim() {
    // A successful command can print nothing (`grep` with no match). Sending
    // `content: ""` breaks providers whose tool-result shape requires an
    // `outputs` property (Cohere via OpenRouter 400s), so the loop substitutes
    // a placeholder before the result enters the conversation.
    let (endpoint, _server) = mock_llm(vec![
        sse_tool_call("c1", "bash", r#"{"command":"true"}"#),
        sse_text("done"),
    ])
    .await;
    let config = LlmConfig::new(endpoint, Some("test".into()), "mock".into());
    let target = recurse_agent::agent::PromptTarget {
        path: "/tmp/x".into(),
        arch: "x86".into(),
        bits: 64,
        kind: "elf".into(),
        memory: String::new(),
        capabilities: recurse_agent::engine::Capabilities::all(),
    };
    let tools = recurse_agent::tools::schema(recurse_agent::engine::Capabilities::all());
    let mut agent = Agent::new();
    agent.set_debug(true);
    // Tool runtime that returns nothing at all, like a silent success.
    let mut exec = |_: &ToolCall| async { Ok(String::new()) };
    let mut emit = |_: recurse_agent::agent::AgentEvent| {};
    agent
        .run_limited(
            "empty", &config, &target, "go", &tools, 3, &mut exec, &mut emit,
        )
        .await
        .expect("run");

    let tool_msg = agent
        .messages()
        .iter()
        .find(|m| m.role == "tool")
        .expect("tool message recorded");
    assert_eq!(tool_msg.content.as_deref(), Some("(no output)"));
    // The trace (what a human inspects) must agree with what was sent.
    assert_eq!(agent.trace().turns[0].tool_results[0].result, "(no output)");
}

#[tokio::test]
async fn analyze_is_one_tool_and_the_runtime_refuses_to_fake_it() {
    // Analysis must go through the backend-neutral tool, not bash. The base
    // runtime has no engine attached, so it must say so rather than silently
    // "succeed".
    let tools = recurse_agent::tools::schema(recurse_agent::engine::Capabilities::all());
    let names: Vec<&str> = tools
        .iter()
        .filter_map(|t| t["function"]["name"].as_str())
        .collect();
    assert!(names.contains(&recurse_agent::engine::TOOL_NAME));
    // One analysis tool, not a family of r2_disasm/r2_xref/... tools.
    assert_eq!(
        names
            .iter()
            .filter(|n| **n == recurse_agent::engine::TOOL_NAME)
            .count(),
        1,
        "exactly one analysis tool: {names:?}"
    );
    let desc = tools
        .iter()
        .find(|t| t["function"]["name"] == recurse_agent::engine::TOOL_NAME)
        .and_then(|t| t["function"]["description"].as_str())
        .expect("analysis tool described");
    assert!(
        desc.contains("backend"),
        "description names the backend: {desc}"
    );
    assert!(desc.contains("decompile"), "description lists ops: {desc}");

    let tc = ToolCall {
        id: "x".into(),
        call_type: "function".into(),
        function: recurse_agent::agent::ToolCallFn {
            name: recurse_agent::engine::TOOL_NAME.into(),
            arguments: r#"{"op":"functions"}"#.into(),
        },
    };
    let err = recurse_agent::tools::execute(&tc)
        .await
        .expect_err("base runtime cannot serve analysis");
    assert!(err.contains("served by the host"), "got: {err}");
}

#[test]
fn native_engine_serves_the_neutral_tool_end_to_end() {
    // The whole seam: a concrete backend + the neutral tool dispatcher.
    use recurse_agent::engine::{execute_tool, Engine};
    let exe = std::env::current_exe().expect("test exe");
    let engine = recurse_agent::native::NativeEngine::open(&exe).expect("open native engine");
    engine.analyze().expect("analyze");
    let out = execute_tool(&engine, &serde_json::json!({"op": "functions", "limit": 5}))
        .expect("functions op");
    let env: serde_json::Value = serde_json::from_str(&out).expect("envelope");
    assert_eq!(env["op"], "functions");
    assert!(env["count"].as_u64().is_some());
    // The native backend now has a (partial, total-coverage) decompiler —
    // see docs/vtil-lift.md — so this succeeds rather than erroring.
    let funcs = engine.functions().expect("functions");
    let entry_addr = funcs[0].addr;
    let out = execute_tool(
        &engine,
        &serde_json::json!({"op": "decompile", "addr": entry_addr}),
    )
    .expect("native decompile");
    let env: serde_json::Value = serde_json::from_str(&out).expect("envelope");
    assert!(env["code"].as_str().is_some_and(|c| !c.is_empty()));

    // The schema and system prompt derived from those capabilities hide the
    // ops the backend cannot serve (still true of `raw`, the console), and
    // now advertise `decompile` too since native provides one.
    let caps = engine.capabilities();
    assert!(caps.decompile && !caps.raw);
    let schema = recurse_agent::engine::tool_schema(caps);
    let ops = schema["function"]["parameters"]["properties"]["op"]["enum"]
        .as_array()
        .expect("op enum");
    assert!(
        ops.iter().any(|v| v == "decompile"),
        "schema advertises decompile"
    );
    assert!(!ops.iter().any(|v| v == "raw"), "schema hides raw");

    let target = recurse_agent::agent::PromptTarget {
        path: exe.to_string_lossy().into_owned(),
        arch: "x86".into(),
        bits: 64,
        kind: "elf".into(),
        memory: String::new(),
        capabilities: caps,
    };
    let prompt = recurse_agent::agent::system_prompt(&target);
    assert!(
        prompt.contains("decompile"),
        "prompt advertises decompile: {prompt}"
    );
    assert!(!prompt.contains("`raw`"), "prompt hides raw: {prompt}");

    // `raw` is rejected up front rather than reaching the backend.
    let err = execute_tool(&engine, &serde_json::json!({"op": "raw", "cmd": "afl"}))
        .expect_err("native has no console");
    assert!(err.contains("no console"), "got: {err}");
}

#[test]
fn lift_op_raises_a_function_into_vtil_style_il() {
    use recurse_agent::engine::{execute_tool, Engine};
    let exe = std::env::current_exe().expect("test exe");
    let engine = recurse_agent::native::NativeEngine::open(&exe).expect("open native engine");
    engine.analyze().expect("analyze");
    let functions = engine.functions().expect("functions");
    let target = functions.first().expect("at least one function").addr;

    let out =
        execute_tool(&engine, &serde_json::json!({"op": "lift", "addr": target})).expect("lift op");
    let env: serde_json::Value = serde_json::from_str(&out).expect("envelope");
    assert_eq!(env["op"], "lift");
    let vtil = env["vtil"].as_str().expect("vtil text field");
    assert!(vtil.starts_with("begin_routine"), "got: {vtil}");
    assert!(vtil.trim_end().ends_with("end_routine"), "got: {vtil}");
    assert!(env["optimized"]["rounds"].as_u64().is_some());

    // Advertised alongside `graph`, since the native backend can recover a
    // CFG (`lift` is built on `function_graph`).
    let caps = engine.capabilities();
    let schema = recurse_agent::engine::tool_schema(caps);
    let ops = schema["function"]["parameters"]["properties"]["op"]["enum"]
        .as_array()
        .expect("op enum");
    assert!(
        ops.iter().any(|v| v == "lift"),
        "schema advertises lift: {ops:?}"
    );
}

#[tokio::test]
async fn bash_results_are_colour_stripped_through_the_tool_runtime() {
    // The escape-stripping has to apply on the path the model actually sees,
    // not only inside r2 module.
    let tc = ToolCall {
        id: "b".into(),
        call_type: "function".into(),
        function: recurse_agent::agent::ToolCallFn {
            name: "bash".into(),
            // Built, not hand-written: JSON has no \033 escape, so a literal
            // raw string here would fail to parse as arguments.
            arguments: serde_json::json!({
                "command": "printf '\\033[31mred\\033[0m\\n'"
            })
            .to_string(),
        },
    };
    let out = recurse_agent::tools::execute(&tc).await.expect("bash runs");
    assert_eq!(out.trim(), "red");
    assert!(
        !out.contains('\u{1b}'),
        "no escapes reach the model: {out:?}"
    );
}
