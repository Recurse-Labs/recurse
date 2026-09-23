pub mod commands;
pub mod config;
pub mod db;
pub mod debug;
pub mod engine;
pub mod project;
pub mod providers;
pub mod renames;
pub mod sessions;
/// Test-only helpers (HOME isolation) for the storage modules' unit tests.
#[doc(hidden)]
pub mod testhome;

use std::sync::{Arc, Mutex};

use recurse_agent::agent::{Agent, LlmConfig, ModelInfo};

/// WebKitGTK registers a `GtkGestureZoom` on the web view under the data key
/// `"wk-view-zoom-gesture"` that scales the whole page on trackpad pinch. Tauri
/// exposes no setting to disable it (upstream limitation) and JS/CSS cannot
/// cancel it, so we destroy that gesture's signal handlers. The app keeps its
/// own Ctrl+/−/0 keyboard zoom via the `set_zoom` command.
#[cfg(target_os = "linux")]
fn disable_pinch_zoom(app: &tauri::App) {
    use glib::prelude::ObjectExt;
    use tauri::Manager;

    let Some(webview) = app.get_webview_window("main") else {
        eprintln!("[recurse] no main webview; skipping pinch-zoom disable");
        return;
    };
    let _ = webview.with_webview(|wv| unsafe {
        let inner = wv.inner();
        if let Some(gesture) = inner.data::<()>("wk-view-zoom-gesture") {
            glib::gobject_ffi::g_signal_handlers_destroy(
                gesture.as_ptr() as *mut glib::gobject_ffi::GObject
            );
            eprintln!("[recurse] disabled WebKitGTK pinch-zoom gesture");
        } else {
            eprintln!("[recurse] wk-view-zoom-gesture not found");
        }
    });
}

#[cfg(not(target_os = "linux"))]
fn disable_pinch_zoom(_app: &tauri::App) {}

pub struct AppState {
    /// The selected analysis backend (native or r2), owned behind one
    /// lock. Commands and the agent tool both route through the trait.
    pub session: Arc<Mutex<Option<Box<dyn recurse_agent::engine::Engine>>>>,
    /// Async mutex: turns hold it across `.await` points, which a std
    /// mutex must never do.
    pub agent: Arc<tokio::sync::Mutex<Agent>>,
    pub llm: Mutex<LlmConfig>,
    pub models: Mutex<Option<Vec<ModelInfo>>>,
    pub project: Mutex<Option<crate::project::Project>>,
    pub current_session: Mutex<Option<String>>,
    /// Active debug session, created by `debug launch`/`attach`.
    pub debug: Arc<Mutex<Option<Arc<recurse_debug::Debugger>>>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Belt-and-suspenders Wayland fix for direct `cargo run` / tests
    // without going through `main.rs`. Mirrors the env setup in `main.rs`.
    #[cfg(target_os = "linux")]
    {
        if std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER").is_err() {
            // SAFETY: still before GTK/WebKit init, single-threaded setup path.
            unsafe {
                std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
            }
        }
    }
    // Startup failure is unrecoverable by design: without an event loop
    // there is no app. This is the one sanctioned expect().
    #[allow(clippy::expect_used)]
    fn die_on_failure(result: tauri::Result<()>) {
        result.expect("error while running tauri application");
    }

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init());

    // Self-update: desktop only (the updater/process plugins have no
    // mobile implementation). Configured in `tauri.conf.json` under
    // `plugins.updater` (endpoint + pubkey) — see docs/updating.md.
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build());

    let builder = builder
        .setup(|app| {
            crate::sessions::cleanup_legacy();
            disable_pinch_zoom(app);
            Ok(())
        })
        .manage(AppState {
            session: Arc::new(Mutex::new(None)),
            agent: Arc::new(tokio::sync::Mutex::new(Agent::new())),
            llm: Mutex::new(crate::config::llm_config()),
            models: Mutex::new(None),
            project: Mutex::new(None),
            current_session: Mutex::new(None),
            debug: Arc::new(Mutex::new(None)),
        })
        .invoke_handler(tauri::generate_handler![
            commands::open_binary,
            commands::analyze,
            commands::close_binary,
            commands::binary_info,
            commands::functions,
            commands::rename_function,
            commands::analysis_progress,
            commands::debug_command,
            commands::debug_snapshot,
            commands::recon,
            commands::disassemble,
            commands::function_at,
            commands::function_disasm,
            commands::function_graph,
            commands::strings,
            commands::imports,
            commands::xrefs_to,
            commands::decompile,
            commands::raw,
            commands::get_backend,
            commands::set_backend,
            commands::set_zoom,
            commands::agent_chat,
            commands::agent_cancel_run,
            commands::agent_reset,
            commands::agent_history,
            commands::sessions_list,
            commands::sessions_create,
            commands::sessions_select,
            commands::sessions_delete,
            commands::sessions_rename,
            commands::llm_status,
            commands::set_model,
            commands::save_api_key,
            commands::set_endpoint,
            commands::list_models,
            commands::providers_list,
            commands::provider_save_api_key,
            commands::provider_clear_credential,
            commands::provider_set_active,
            commands::anthropic_oauth_start,
            commands::anthropic_oauth_finish,
            commands::github_copilot_device_start,
            commands::github_copilot_device_finish,
            commands::memories_list,
            commands::memory_get,
            commands::memory_save,
            commands::memory_remove,
            commands::memory_search,
            commands::list_projects,
            commands::create_project,
            commands::open_project,
            commands::delete_project,
            commands::project_read_file,
            commands::project_write_file,
            commands::project_list_files,
        ]);

    die_on_failure(builder.run(tauri::generate_context!()));
}
