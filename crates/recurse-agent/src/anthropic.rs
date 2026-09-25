//! Native Anthropic Messages API client — the wire protocol a Claude
//! Pro/Max OAuth credential (`crate::oauth::anthropic`) actually needs.
//! Not OpenAI-compatible: different request shape (`system` is a
//! top-level field, not a message; message `content` is a block array,
//! not a flat string; tool results are `tool_result` content blocks
//! inside a `user` message, not a separate `role: "tool"` message), and
//! a different SSE event stream (`message_start`/`content_block_start`/
//! `content_block_delta`/`content_block_stop`/`message_delta`/
//! `message_stop`, not OpenAI's flat per-token `choices[0].delta`).
//!
//! This module converts to/from `crate::agent`'s existing OpenAI-shaped
//! [`ChatMessage`]/tool-schema types at the boundary, so the rest of the
//! agent (history, tool execution, the run loop) never needs to know two
//! wire formats exist — only [`crate::agent::LlmConfig::protocol`]
//! picking [`crate::agent::Protocol::AnthropicNative`] routes a request
//! here instead of through `crate::agent::stream_http`.
//!
//! # The required "Claude Code" system-prompt prefix
//!
//! Anthropic's server validates that a request presenting an OAuth
//! bearer token (rather than a metered `x-api-key`) opens its system
//! block with the exact sentence [`CLAUDE_CODE_IDENTITY`] — documented,
//! and used by every independent open-source tool that lets a user bring
//! their own Claude subscription this way (see
//! `crate::oauth::anthropic`'s module doc for the same context on the
//! OAuth flow itself). [`build_system`] prepends it automatically; the
//! real Recurse system prompt (`crate::agent::system_prompt`) follows as
//! additional blocks, unchanged.
//!
//! # Honest scope
//!
//! Built to the documented Messages API streaming protocol and unit
//! tested against hand-built synthetic SSE fixtures shaped exactly like
//! Anthropic's real event stream — but not exercised against the real
//! `api.anthropic.com` in this crate's test suite (no test Claude
//! subscription is available in this sandbox). Extended thinking
//! (`thinking_delta`) is parsed into the reasoning trace without the
//! repetition/length guard `crate::agent::append_stream` applies to
//! visible text — a real, minor, documented simplification, not an
//! oversight: a runaway thinking trace is far less user-visible-harmful
//! than runaway visible text, and this keeps two independent buffers
//! from needing one shared cut-index.

use serde_json::{json, Value};

use crate::agent::{
    append_stream, backoff, emit_text, http_client, is_rate_limited, is_transient_send,
    retry_delay, AgentEvent, ChatMessage, LlmConfig, StreamAppend, StreamOutcome,
    ToolCallAccumulator,
};

/// Anthropic's own hosted Messages API. `crate::providers` does not list
/// this as a `base_url` for [`crate::providers::AuthKind::OAuthAnthropic`]
/// since the OAuth path always talks to Anthropic directly, never a
/// user-configurable endpoint.
pub const DEFAULT_BASE_URL: &str = "https://api.anthropic.com/v1/messages";
pub const ANTHROPIC_VERSION: &str = "2023-06-01";
/// The beta flag that unlocks OAuth-token authentication on the Messages
/// API (as opposed to a metered `x-api-key`).
pub const OAUTH_BETA: &str = "oauth-2025-04-20";
/// Required verbatim system-prompt opener for OAuth-authenticated
/// requests — see module doc.
pub const CLAUDE_CODE_IDENTITY: &str = "You are Claude Code, Anthropic's official CLI for Claude.";

/// Anthropic requires `max_tokens`; OpenAI-compatible requests Recurse
/// sends elsewhere leave it to the provider's own default, so there is no
/// existing value to reuse here.
const DEFAULT_MAX_TOKENS: u32 = 8192;

/// Build the `system` field: [`CLAUDE_CODE_IDENTITY`] first (required for
/// OAuth, harmless to include otherwise), then every `role: "system"`
/// message's content as its own text block, in order.
fn build_system(messages: &[ChatMessage], oauth: bool) -> Value {
    let mut parts: Vec<Value> = Vec::new();
    if oauth {
        parts.push(json!({ "type": "text", "text": CLAUDE_CODE_IDENTITY }));
    }
    for m in messages {
        if m.role == "system" {
            if let Some(c) = &m.content {
                if !c.is_empty() {
                    parts.push(json!({ "type": "text", "text": c }));
                }
            }
        }
    }
    Value::Array(parts)
}

/// Convert the OpenAI-shaped conversation history into Anthropic's
/// `messages` array. Consecutive `role: "tool"` messages (parallel tool
/// results from one assistant turn) are merged into a single `user`
/// message carrying multiple `tool_result` blocks, matching how
/// Anthropic expects a turn's tool results delivered.
fn build_messages(messages: &[ChatMessage]) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let mut last_was_tool_result = false;
    for m in messages {
        match m.role.as_str() {
            "system" => { /* handled by build_system */ }
            "user" => {
                out.push(json!({
                    "role": "user",
                    "content": [{ "type": "text", "text": m.content.clone().unwrap_or_default() }],
                }));
                last_was_tool_result = false;
            }
            "assistant" => {
                let mut blocks: Vec<Value> = Vec::new();
                if let Some(c) = &m.content {
                    if !c.is_empty() {
                        blocks.push(json!({ "type": "text", "text": c }));
                    }
                }
                if let Some(calls) = &m.tool_calls {
                    for call in calls {
                        let input: Value = serde_json::from_str(&call.function.arguments)
                            .unwrap_or_else(|_| json!({}));
                        blocks.push(json!({ "type": "tool_use", "id": call.id, "name": call.function.name, "input": input }));
                    }
                }
                out.push(json!({ "role": "assistant", "content": blocks }));
                last_was_tool_result = false;
            }
            "tool" => {
                let block = json!({
                    "type": "tool_result",
                    "tool_use_id": m.tool_call_id.clone().unwrap_or_default(),
                    "content": [{ "type": "text", "text": m.content.clone().unwrap_or_default() }],
                });
                if last_was_tool_result {
                    if let Some(last) = out.last_mut() {
                        if let Some(arr) = last["content"].as_array_mut() {
                            arr.push(block);
                            continue;
                        }
                    }
                }
                out.push(json!({ "role": "user", "content": [block] }));
                last_was_tool_result = true;
            }
            _ => {}
        }
    }
    out
}

/// Convert OpenAI function-calling tool schemas
/// (`{"type":"function","function":{"name","description","parameters"}}`)
/// into Anthropic's flat `{"name","description","input_schema"}` shape.
/// A malformed entry (missing `function`/`name`) is skipped rather than
/// failing the whole request — one bad tool schema should not break every
/// other tool.
fn build_tools(tools: &[Value]) -> Vec<Value> {
    tools
        .iter()
        .filter_map(|t| {
            let f = t.get("function")?;
            let name = f.get("name")?.as_str()?;
            let description = f.get("description").and_then(Value::as_str).unwrap_or("");
            let input_schema = f
                .get("parameters")
                .cloned()
                .unwrap_or_else(|| json!({ "type": "object", "properties": {} }));
            Some(json!({ "name": name, "description": description, "input_schema": input_schema }))
        })
        .collect()
}

/// Build the full request body.
fn build_request(model: &str, messages: &[ChatMessage], tools: &[Value], oauth: bool) -> Value {
    let mut body = json!({
        "model": model,
        "max_tokens": DEFAULT_MAX_TOKENS,
        "system": build_system(messages, oauth),
        "messages": build_messages(messages),
        "stream": true,
    });
    if !tools.is_empty() {
        body["tools"] = Value::Array(build_tools(tools));
    }
    body
}

/// Process one SSE `data:` payload (already stripped of the `data: `
/// prefix). Returns `true` when `message_stop` (or a fatal `error` event)
/// ends the stream.
#[allow(clippy::too_many_arguments)]
fn handle_event(
    data: &str,
    run_id: &str,
    acc: &mut ToolCallAccumulator,
    block_index_to_acc: &mut std::collections::HashMap<u64, usize>,
    next_acc_index: &mut usize,
    content: &mut String,
    reasoning: &mut String,
    served_model: &mut Option<String>,
    loop_cut: &mut bool,
    emit: &mut (dyn FnMut(AgentEvent) + Send),
) -> Result<bool, String> {
    let value: Value = match serde_json::from_str(data) {
        Ok(v) => v,
        Err(_) => return Ok(false), // a malformed/partial line; tolerate and keep reading
    };
    let event_type = value.get("type").and_then(Value::as_str).unwrap_or("");
    match event_type {
        "message_start" => {
            if let Some(model) = value["message"]["model"].as_str() {
                *served_model = Some(model.to_string());
            }
            Ok(false)
        }
        "content_block_start" => {
            let index = value.get("index").and_then(Value::as_u64).unwrap_or(0);
            let block = &value["content_block"];
            if block.get("type").and_then(Value::as_str) == Some("tool_use") {
                let acc_index = *next_acc_index;
                *next_acc_index += 1;
                block_index_to_acc.insert(index, acc_index);
                if let Some(id) = block.get("id").and_then(Value::as_str) {
                    acc.set_id(acc_index, id);
                }
                if let Some(name) = block.get("name").and_then(Value::as_str) {
                    acc.set_name(acc_index, name);
                }
                emit(AgentEvent::ToolCall {
                    run_id: run_id.to_string(),
                    id: acc.calls[acc_index].id.clone(),
                    name: acc.calls[acc_index].function.name.clone(),
                    arguments: String::new(),
                });
            }
            Ok(false)
        }
        "content_block_delta" => {
            let index = value.get("index").and_then(Value::as_u64).unwrap_or(0);
            let delta = &value["delta"];
            match delta.get("type").and_then(Value::as_str) {
                Some("text_delta") => {
                    let text = delta.get("text").and_then(Value::as_str).unwrap_or("");
                    match append_stream(content, text) {
                        StreamAppend::Keep(visible) => emit_text("text", run_id, visible, emit),
                        StreamAppend::Stop(visible) => {
                            emit_text("text", run_id, visible, emit);
                            *loop_cut = true;
                            return Ok(true);
                        }
                    }
                }
                Some("thinking_delta") => {
                    let text = delta.get("thinking").and_then(Value::as_str).unwrap_or("");
                    if !text.is_empty() {
                        reasoning.push_str(text);
                        emit_text("reasoning", run_id, text.to_string(), emit);
                    }
                }
                Some("input_json_delta") => {
                    let partial = delta
                        .get("partial_json")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    if let Some(&acc_index) = block_index_to_acc.get(&index) {
                        acc.append_args(acc_index, partial);
                    }
                }
                _ => {}
            }
            Ok(false)
        }
        "message_stop" => Ok(true),
        "error" => {
            let message = value
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("unknown error");
            Err(format!("anthropic stream error: {message}"))
        }
        // content_block_stop, message_delta, ping: no action needed.
        _ => Ok(false),
    }
}

/// Stream a chat completion against Anthropic's native Messages API. Same
/// external contract as `crate::agent::stream_http` (same retry policy,
/// same [`StreamOutcome`] shape), different wire protocol.
pub(crate) async fn stream_http(
    run_id: &str,
    config: &LlmConfig,
    messages: &[ChatMessage],
    tools: &[Value],
    emit: &mut (dyn FnMut(AgentEvent) + Send),
) -> Result<StreamOutcome, String> {
    let oauth = config
        .api_key
        .as_deref()
        .map(|k| k.starts_with("sk-ant-oat"))
        .unwrap_or(false);
    let body = build_request(&config.model, messages, tools, oauth);
    let key = config.api_key.as_deref().unwrap_or("");

    let send = || {
        let mut request = http_client()
            .post(&config.endpoint)
            .header("anthropic-version", ANTHROPIC_VERSION);
        if !key.is_empty() {
            request = request.header("x-api-key", key).bearer_auth(key);
        }
        if oauth {
            request = request.header("anthropic-beta", OAUTH_BETA);
        }
        request = request.json(&body);
        for (name, value) in &config.extra_headers {
            request = request.header(name.as_str(), value.as_str());
        }
        request.send()
    };

    let mut resp = {
        let mut attempt = 0u32;
        loop {
            attempt += 1;
            let last = attempt >= crate::agent::MAX_SEND_ATTEMPTS;
            match send().await {
                Ok(r) if r.status().is_success() => break r,
                Ok(r) if (is_rate_limited(&r) || r.status().is_server_error()) && !last => {
                    let wait = retry_delay(&r, attempt);
                    tokio::time::sleep(wait).await;
                }
                Ok(r) => {
                    let status = r.status();
                    let body = r.text().await.unwrap_or_default();
                    let snippet: String = body.chars().take(300).collect();
                    return Err(format!(
                        "anthropic request failed with status {code}: {snippet}",
                        code = status.as_u16()
                    ));
                }
                Err(e) if is_transient_send(&e) && !last => {
                    tokio::time::sleep(backoff(attempt)).await;
                }
                Err(e) => return Err(format!("anthropic request failed: {e}")),
            }
        }
    };

    let mut pending: Vec<u8> = Vec::new();
    let mut acc = ToolCallAccumulator::default();
    let mut block_index_to_acc: std::collections::HashMap<u64, usize> =
        std::collections::HashMap::new();
    let mut next_acc_index = 0usize;
    let mut content = String::new();
    let mut reasoning = String::new();
    let mut served_model: Option<String> = None;
    let mut loop_cut = false;

    'outer: loop {
        match resp.chunk().await {
            Ok(Some(bytes)) => pending.extend_from_slice(&bytes),
            Ok(None) | Err(_) => break,
        }
        while let Some(pos) = pending.iter().position(|&b| b == b'\n') {
            let raw: Vec<u8> = pending.drain(..=pos).collect();
            let Ok(line) = std::str::from_utf8(&raw) else {
                break 'outer;
            };
            let line = line.trim_end_matches(['\r', '\n']);
            let Some(data) = line
                .strip_prefix("data: ")
                .or_else(|| line.strip_prefix("data:"))
            else {
                continue; // `event:` lines, blank lines, and comments carry no payload of their own
            };
            let done = handle_event(
                data,
                run_id,
                &mut acc,
                &mut block_index_to_acc,
                &mut next_acc_index,
                &mut content,
                &mut reasoning,
                &mut served_model,
                &mut loop_cut,
                emit,
            )?;
            if done {
                break 'outer;
            }
        }
    }

    if loop_cut {
        acc.calls
            .retain(|call| !call.id.is_empty() && !call.function.name.is_empty());
    }
    for call in &acc.calls {
        emit(AgentEvent::ToolCall {
            run_id: run_id.to_string(),
            id: call.id.clone(),
            name: call.function.name.clone(),
            arguments: call.function.arguments.clone(),
        });
    }
    Ok(StreamOutcome {
        content,
        reasoning,
        tool_calls: acc.calls,
        model: served_model,
        loop_cut,
    })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
    use super::*;
    use crate::agent::ToolCall;

    fn chat(role: &str, content: Option<&str>) -> ChatMessage {
        ChatMessage {
            role: role.to_string(),
            content: content.map(str::to_string),
            tool_calls: None,
            tool_call_id: None,
            reasoning: None,
        }
    }

    #[test]
    fn build_system_prepends_the_required_identity_for_oauth() {
        let messages = vec![
            chat("system", Some("Real Recurse prompt.")),
            chat("user", Some("hi")),
        ];
        let system = build_system(&messages, true);
        let arr = system.as_array().expect("array");
        assert_eq!(arr[0]["text"], CLAUDE_CODE_IDENTITY);
        assert_eq!(arr[1]["text"], "Real Recurse prompt.");
    }

    #[test]
    fn build_system_omits_the_identity_when_not_oauth() {
        let messages = vec![chat("system", Some("Real Recurse prompt."))];
        let system = build_system(&messages, false);
        let arr = system.as_array().expect("array");
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["text"], "Real Recurse prompt.");
    }

    #[test]
    fn build_messages_converts_user_and_assistant_turns() {
        let messages = vec![chat("user", Some("hello"))];
        let out = build_messages(&messages);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["role"], "user");
        assert_eq!(out[0]["content"][0]["type"], "text");
        assert_eq!(out[0]["content"][0]["text"], "hello");
    }

    #[test]
    fn build_messages_converts_assistant_tool_calls_to_tool_use_blocks() {
        let call = ToolCall {
            id: "toolu_1".to_string(),
            call_type: "function".to_string(),
            function: crate::agent::ToolCallFn {
                name: "read".to_string(),
                arguments: r#"{"path":"/tmp/f"}"#.to_string(),
            },
        };
        let mut m = chat("assistant", Some("Let me check."));
        m.tool_calls = Some(vec![call]);
        let out = build_messages(&[m]);
        assert_eq!(out[0]["role"], "assistant");
        let blocks = out[0]["content"].as_array().expect("array");
        assert_eq!(blocks[0]["type"], "text");
        assert_eq!(blocks[1]["type"], "tool_use");
        assert_eq!(blocks[1]["id"], "toolu_1");
        assert_eq!(blocks[1]["name"], "read");
        assert_eq!(blocks[1]["input"]["path"], "/tmp/f");
    }

    #[test]
    fn build_messages_merges_consecutive_tool_results_into_one_user_message() {
        let mut a = chat("tool", Some("result A"));
        a.tool_call_id = Some("toolu_a".to_string());
        let mut b = chat("tool", Some("result B"));
        b.tool_call_id = Some("toolu_b".to_string());
        let out = build_messages(&[a, b]);
        assert_eq!(
            out.len(),
            1,
            "two parallel tool results must merge into one user message"
        );
        let blocks = out[0]["content"].as_array().expect("array");
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0]["tool_use_id"], "toolu_a");
        assert_eq!(blocks[1]["tool_use_id"], "toolu_b");
    }

    #[test]
    fn build_messages_does_not_merge_tool_results_across_an_intervening_user_turn() {
        let mut a = chat("tool", Some("result A"));
        a.tool_call_id = Some("toolu_a".to_string());
        let u = chat("user", Some("thanks"));
        let mut b = chat("tool", Some("result B"));
        b.tool_call_id = Some("toolu_b".to_string());
        let out = build_messages(&[a, u, b]);
        assert_eq!(out.len(), 3);
    }

    #[test]
    fn build_tools_converts_openai_function_schema_to_anthropic_input_schema() {
        let openai_tools = vec![
            json!({"type":"function","function":{"name":"read","description":"Read a file","parameters":{"type":"object","properties":{"path":{"type":"string"}}}}}),
        ];
        let converted = build_tools(&openai_tools);
        assert_eq!(converted.len(), 1);
        assert_eq!(converted[0]["name"], "read");
        assert_eq!(converted[0]["description"], "Read a file");
        assert_eq!(
            converted[0]["input_schema"]["properties"]["path"]["type"],
            "string"
        );
        assert!(
            converted[0].get("type").is_none(),
            "anthropic tool schema has no top-level type wrapper"
        );
    }

    #[test]
    fn build_tools_skips_a_malformed_entry_without_failing_the_rest() {
        let tools = vec![
            json!({"not": "a valid tool"}),
            json!({"type":"function","function":{"name":"ok","description":"","parameters":{}}}),
        ];
        let converted = build_tools(&tools);
        assert_eq!(converted.len(), 1);
        assert_eq!(converted[0]["name"], "ok");
    }

    #[test]
    fn build_request_sets_max_tokens_and_streaming() {
        let req = build_request("claude-sonnet-4-5", &[chat("user", Some("hi"))], &[], true);
        assert_eq!(req["model"], "claude-sonnet-4-5");
        assert_eq!(req["stream"], true);
        assert!(req["max_tokens"].as_u64().unwrap() > 0);
    }

    fn run_events(events: &[&str]) -> (String, String, Vec<ToolCall>, Option<String>) {
        let mut acc = ToolCallAccumulator::default();
        let mut block_index_to_acc = std::collections::HashMap::new();
        let mut next_acc_index = 0usize;
        let mut content = String::new();
        let mut reasoning = String::new();
        let mut served_model = None;
        let mut loop_cut = false;
        let mut emitted = Vec::new();
        for data in events {
            let done = handle_event(
                data,
                "run1",
                &mut acc,
                &mut block_index_to_acc,
                &mut next_acc_index,
                &mut content,
                &mut reasoning,
                &mut served_model,
                &mut loop_cut,
                &mut |ev| emitted.push(ev),
            )
            .expect("no error events in this fixture");
            if done {
                break;
            }
        }
        (content, reasoning, acc.calls, served_model)
    }

    #[test]
    fn parses_a_real_shaped_text_only_sse_sequence() {
        let events = [
            r#"{"type":"message_start","message":{"model":"claude-sonnet-4-5-20250929"}}"#,
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#,
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello, "}}"#,
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"world."}}"#,
            r#"{"type":"content_block_stop","index":0}"#,
            r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"}}"#,
            r#"{"type":"message_stop"}"#,
        ];
        let (content, _reasoning, calls, model) = run_events(&events);
        assert_eq!(content, "Hello, world.");
        assert!(calls.is_empty());
        assert_eq!(model.as_deref(), Some("claude-sonnet-4-5-20250929"));
    }

    #[test]
    fn parses_a_real_shaped_tool_use_sse_sequence_with_streamed_json_args() {
        let events = [
            r#"{"type":"message_start","message":{"model":"claude-sonnet-4-5"}}"#,
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_01","name":"read","input":{}}}"#,
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"path\":"}}"#,
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\"/tmp/f\"}"}}"#,
            r#"{"type":"content_block_stop","index":0}"#,
            r#"{"type":"message_stop"}"#,
        ];
        let (_content, _reasoning, calls, _model) = run_events(&events);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id, "toolu_01");
        assert_eq!(calls[0].function.name, "read");
        assert_eq!(calls[0].function.arguments, r#"{"path":"/tmp/f"}"#);
    }

    #[test]
    fn parses_thinking_delta_into_the_reasoning_buffer() {
        let events = [
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}"#,
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me consider..."}}"#,
            r#"{"type":"message_stop"}"#,
        ];
        let (_content, reasoning, _calls, _model) = run_events(&events);
        assert_eq!(reasoning, "Let me consider...");
    }

    #[test]
    fn a_text_block_and_a_tool_use_block_at_different_indices_do_not_collide() {
        // The real, tricky case build_tools/handle_event must get right:
        // Anthropic's index space is shared across all content blocks, so
        // a tool_use at index 1 must not be treated as "tool call #1"
        // (which would leave a bogus empty tool_calls[0] behind).
        let events = [
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#,
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Checking."}}"#,
            r#"{"type":"content_block_stop","index":0}"#,
            r#"{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_x","name":"read","input":{}}}"#,
            r#"{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{}"}}"#,
            r#"{"type":"message_stop"}"#,
        ];
        let (content, _reasoning, calls, _model) = run_events(&events);
        assert_eq!(content, "Checking.");
        assert_eq!(
            calls.len(),
            1,
            "exactly one real tool call, no padding entry from the text block's index"
        );
        assert_eq!(calls[0].id, "toolu_x");
    }

    #[test]
    fn an_error_event_stops_parsing_and_returns_it() {
        let mut acc = ToolCallAccumulator::default();
        let mut block_index_to_acc = std::collections::HashMap::new();
        let mut next_acc_index = 0usize;
        let mut content = String::new();
        let mut reasoning = String::new();
        let mut served_model = None;
        let mut loop_cut = false;
        let result = handle_event(
            r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#,
            "run1",
            &mut acc,
            &mut block_index_to_acc,
            &mut next_acc_index,
            &mut content,
            &mut reasoning,
            &mut served_model,
            &mut loop_cut,
            &mut |_| {},
        );
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Overloaded"));
    }

    #[test]
    fn a_malformed_data_line_is_tolerated_not_fatal() {
        let mut acc = ToolCallAccumulator::default();
        let mut block_index_to_acc = std::collections::HashMap::new();
        let mut next_acc_index = 0usize;
        let mut content = String::new();
        let mut reasoning = String::new();
        let mut served_model = None;
        let mut loop_cut = false;
        let result = handle_event(
            "not valid json",
            "run1",
            &mut acc,
            &mut block_index_to_acc,
            &mut next_acc_index,
            &mut content,
            &mut reasoning,
            &mut served_model,
            &mut loop_cut,
            &mut |_| {},
        );
        assert_eq!(result, Ok(false));
    }
}
