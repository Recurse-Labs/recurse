//! A bounded call/stop trace timeline for the debug session, distinct
//! from `Debugger::snapshot`'s single live stop.
//!
//! `recurse_debug::tool::execute_tool` already returns the real `Stop`
//! (`{pid, thread, reason, registers}`) for every op that resumes and
//! re-stops the debuggee (`launch`, `attach`, `continue`, `step`) — this
//! module just recognizes that shape in `debug_command`'s own result and
//! appends it to a capped ring buffer on [`crate::AppState`], so the UI
//! can show "what happened" over the whole session, not just the current
//! stop. No new debugger internals, no unverified platform code: it is
//! pure bookkeeping over data the already-real, already-tested Windows
//! backend produces.

use serde_json::Value;

/// Oldest entries drop first once the trace holds this many stops.
pub const MAX_TRACE_ENTRIES: usize = 500;

/// Recognize a `Stop`-shaped JSON value (`{"reason": {...}, "registers": {...}, ...}`,
/// per `recurse_debug::model::Stop`'s `Serialize` impl) and, if `value`
/// matches, append it to the trace.
pub fn record_if_stop(state: &crate::AppState, value: &Value) {
    let Some(obj) = value.as_object() else {
        return;
    };
    if !obj.contains_key("reason") || !obj.contains_key("registers") {
        return;
    }
    let Ok(mut trace) = state.debug_trace.lock() else {
        return;
    };
    trace.push_back(value.clone());
    while trace.len() > MAX_TRACE_ENTRIES {
        trace.pop_front();
    }
}

/// The trace so far, oldest first.
#[tauri::command]
pub fn debug_trace(state: tauri::State<'_, crate::AppState>) -> Result<Vec<Value>, String> {
    let trace = state
        .debug_trace
        .lock()
        .map_err(|e| format!("debug_trace lock poisoned: {e}"))?;
    Ok(trace.iter().cloned().collect())
}

/// Clear the trace (a fresh `launch`/`attach` starts a new one implicitly
/// by appending; this is for an explicit "clear" action in the UI).
#[tauri::command]
pub fn debug_trace_clear(state: tauri::State<'_, crate::AppState>) -> Result<(), String> {
    let mut trace = state
        .debug_trace
        .lock()
        .map_err(|e| format!("debug_trace lock poisoned: {e}"))?;
    trace.clear();
    Ok(())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
    use super::*;
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    fn empty_state() -> crate::AppState {
        crate::AppState {
            session: Arc::new(Mutex::new(None)),
            agent: Arc::new(tokio::sync::Mutex::new(recurse_agent::agent::Agent::new())),
            llm: Mutex::new(crate::config::llm_config()),
            models: Mutex::new(None),
            project: Mutex::new(None),
            current_session: Mutex::new(None),
            debug: Arc::new(Mutex::new(None)),
            debug_trace: Arc::new(Mutex::new(std::collections::VecDeque::new())),
        }
    }

    #[test]
    fn records_a_real_stop_shape_and_ignores_everything_else() {
        let state = empty_state();
        let stop = json!({
            "pid": 123,
            "thread": 123,
            "reason": {"reason": "breakpoint", "addr": 4096, "id": 1},
            "registers": {"pc": 4096, "sp": 0, "fp": 0, "values": {}},
        });
        record_if_stop(&state, &stop);
        record_if_stop(&state, &json!({"written": 4}));
        record_if_stop(&state, &json!(null));
        record_if_stop(&state, &json!([1, 2, 3]));

        let trace = state.debug_trace.lock().unwrap();
        assert_eq!(trace.len(), 1);
        assert_eq!(trace[0]["reason"]["reason"], "breakpoint");
    }

    #[test]
    fn caps_at_max_entries_dropping_the_oldest() {
        let state = empty_state();
        for i in 0..(MAX_TRACE_ENTRIES + 10) {
            record_if_stop(
                &state,
                &json!({
                    "pid": 1,
                    "thread": 1,
                    "reason": {"reason": "step"},
                    "registers": {"pc": i, "sp": 0, "fp": 0, "values": {}},
                }),
            );
        }
        let trace = state.debug_trace.lock().unwrap();
        assert_eq!(trace.len(), MAX_TRACE_ENTRIES);
        // The oldest 10 (pc 0..10) were dropped; the first remaining entry
        // is pc == 10.
        assert_eq!(trace[0]["registers"]["pc"], 10);
    }
}
