//! SQLite storage, owned by the Tauri host.
//!
//! Single file at `~/.recurse/recurse.db` (WAL mode). Table ownership:
//!
//! - host (`db.rs`, `project.rs`, `sessions.rs`, `config.rs`, `renames.rs`,
//!   `providers.rs`): `config`, `projects`, `sessions`, `models`,
//!   `function_names`, `provider_credentials`
//! - recurse_agent (`recurse_agent::memory`): `memories`, `memories_fts`
//!
//! The filesystem under `~/.recurse/<project>/` is reserved for
//! LLM-written project code (`project_read_file` / `project_write_file`);
//! all metadata, model info and memories live in this DB.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rusqlite::Connection;

const SCHEMA_SQL: &str = "
CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
    name TEXT PRIMARY KEY,
    binary_path TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    project_name TEXT NOT NULL,
    name TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    chat_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_sessions_project
    ON sessions (project_name, updated_at DESC);
CREATE TABLE IF NOT EXISTS models (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    context_length INTEGER NOT NULL DEFAULT 0,
    prompt_price TEXT NOT NULL DEFAULT '',
    is_free INTEGER NOT NULL DEFAULT 0,
    fetched_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS function_names (
    binary_path TEXT NOT NULL,
    addr INTEGER NOT NULL,
    name TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (binary_path, addr)
);
CREATE TABLE IF NOT EXISTS provider_credentials (
    provider_id TEXT PRIMARY KEY,
    api_key TEXT,
    oauth_json TEXT,
    updated_at INTEGER NOT NULL
);
";

/// Serialises the one-time schema/journal setup between threads.
///
/// Only the setup is serialised: each caller still gets its own independent
/// [`Connection`] and runs its own queries unserialised afterwards.
static SETUP_LOCK: Mutex<()> = Mutex::new(());

/// How long to keep retrying the WAL switch, and how long to wait between
/// attempts. Only ever spent when another *process* holds the database, since
/// in-process attempts are serialised by [`SETUP_LOCK`].
const WAL_RETRY_BUDGET: Duration = Duration::from_secs(2);
const WAL_RETRY_DELAY: Duration = Duration::from_millis(20);

pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// The user's home directory, honoring a `HOME` environment variable
/// override before falling back to the OS default.
///
/// `dirs::home_dir()` alone is not enough: on Windows its implementation
/// resolves the real profile directory via the Known Folder API and
/// **ignores `$HOME` entirely** — `crate::testhome`'s test isolation
/// (`std::env::set_var("HOME", …)`) is a silent no-op there, so every
/// `with_test_home`-based test was actually reading/writing the real
/// user's `~/.recurse` on Windows instead of a throwaway directory. On
/// Unix, `dirs::home_dir()` already reads `$HOME` itself, so checking it
/// here first is a harmless no-op — this makes the override work
/// uniformly on every platform instead of only where `dirs` happens to
/// agree with it.
pub(crate) fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
        .or_else(dirs::home_dir)
}

pub fn db_path() -> Result<PathBuf, String> {
    let home = home_dir().ok_or_else(|| "could not determine home directory".to_string())?;
    Ok(home.join(".recurse").join("recurse.db"))
}

/// Switch the database to WAL, unless it already is.
///
/// Changing journal mode requires an **exclusive** lock on the database, and
/// SQLite does not run the busy handler for it — so `busy_timeout` set on the
/// connection does not make this safe to attempt concurrently. Two threads
/// racing here fail with `SQLITE_BUSY` ("database is locked") roughly one run in
/// three, which is exactly the flake this replaced.
///
/// Two things make it safe. The journal mode is persistent in the database
/// header, so after the first successful switch every later connect observes WAL
/// and skips the exclusive-lock operation entirely; and the attempt is made
/// under [`SETUP_LOCK`], so only one thread in this process ever tries. The
/// retry loop covers the remaining case, another *process* holding the file.
fn ensure_wal(conn: &Connection) -> Result<(), String> {
    let current: String = conn
        .query_row("PRAGMA journal_mode", [], |row| row.get(0))
        .map_err(|e| format!("read journal mode: {e}"))?;
    if current.eq_ignore_ascii_case("wal") {
        return Ok(());
    }
    let deadline = Instant::now() + WAL_RETRY_BUDGET;
    loop {
        match conn.execute_batch("PRAGMA journal_mode=WAL;") {
            Ok(()) => return Ok(()),
            Err(e) => {
                if Instant::now() >= deadline {
                    return Err(format!("db pragmas: {e}"));
                }
                std::thread::sleep(WAL_RETRY_DELAY);
            }
        }
    }
}

/// Open the DB, creating parent dirs and running all migrations
/// (host tables + recurse_agent memory tables). Safe to call on every access.
pub fn connect() -> Result<Connection, String> {
    let path = db_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create db dir: {e}"))?;
    }
    let conn = Connection::open(&path).map_err(|e| format!("open db: {e}"))?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| format!("db busy timeout: {e}"))?;
    let _setup = SETUP_LOCK
        .lock()
        .map_err(|_| "db setup lock poisoned".to_string())?;
    ensure_wal(&conn)?;
    conn.execute_batch("PRAGMA foreign_keys=ON;")
        .map_err(|e| format!("db pragmas: {e}"))?;
    conn.execute_batch(SCHEMA_SQL)
        .map_err(|e| format!("db schema: {e}"))?;
    recurse_agent::memory::ensure_schema(&conn)?;
    Ok(conn)
}

/// Memory store bound to the same DB file. All memory CRUD/search goes
/// through recurse_agent — the host never touches the `memories` tables.
pub fn memory_store() -> Result<recurse_agent::memory::MemoryStore, String> {
    Ok(recurse_agent::memory::MemoryStore::new(db_path()?))
}

/// Delete pre-SQLite filesystem metadata. No migration: stale
/// `project.json` / `sessions/` / `memory/*.md` / `config.json` / legacy
/// `history/` dirs are removed, LLM-written project files are kept.
pub fn cleanup_legacy_filesystem() {
    let Some(home) = home_dir() else {
        return;
    };
    let root = home.join(".recurse");
    if !root.is_dir() {
        return;
    }
    // Top-level config from the JSON era.
    let _ = std::fs::remove_file(root.join("config.json"));
    let Ok(entries) = std::fs::read_dir(&root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        // Stray empty "default" project leftovers.
        if path.file_name().and_then(|n| n.to_str()) == Some("default")
            && path.join("project.json").exists()
        {
            let _ = std::fs::remove_dir_all(&path);
            continue;
        }
        let _ = std::fs::remove_file(path.join("project.json"));
        let _ = std::fs::remove_dir_all(path.join("sessions"));
        let _ = std::fs::remove_dir_all(path.join("memory"));
        let _ = std::fs::remove_dir_all(path.join("history"));
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    /// The invariant that actually makes concurrent connects safe: the schema
    /// and journal setup runs under [`SETUP_LOCK`], so the exclusive-lock
    /// journal switch is attempted by one thread at a time.
    ///
    /// Proved without relying on timing: hold the lock, and `connect()` from
    /// another thread must not get past it. A timing-based "N threads, no
    /// failures" test cannot establish this — it passes against the broken code
    /// whenever the threads happen not to collide, which is most of the time.
    #[test]
    fn connect_waits_for_the_setup_lock() {
        crate::testhome::with_test_home(|_| {
            let held = SETUP_LOCK.lock().unwrap_or_else(|e| e.into_inner());

            let finished = std::sync::Arc::new(AtomicBool::new(false));
            let flag = std::sync::Arc::clone(&finished);
            let handle = std::thread::spawn(move || {
                let _ = connect();
                flag.store(true, Ordering::SeqCst);
            });

            // The spawned connect() is blocked on the lock we still hold.
            std::thread::sleep(Duration::from_millis(150));
            assert!(
                !finished.load(Ordering::SeqCst),
                "connect() must not run setup while another caller holds the lock"
            );

            drop(held);
            handle.join().unwrap();
            assert!(
                finished.load(Ordering::SeqCst),
                "connect() must complete once the lock is released"
            );
        });
    }

    /// Concurrent connects must all succeed. A smoke test rather than the
    /// primary guard: the original race only reproduced on a fresh database
    /// with unlucky timing, so this alone passes against the broken code.
    /// `connect_waits_for_the_setup_lock` is what pins the fix.
    #[test]
    fn concurrent_connects_all_succeed() {
        crate::testhome::with_test_home(|_| {
            const ROUNDS: usize = 8;
            const THREADS: usize = 8;
            let failures = std::sync::Arc::new(AtomicUsize::new(0));
            let db = db_path().unwrap();
            for _ in 0..ROUNDS {
                // A fresh, non-WAL database, so the journal switch is really
                // attempted rather than skipped.
                for suffix in ["", "-wal", "-shm"] {
                    let _ = std::fs::remove_file(format!("{}{suffix}", db.display()));
                }
                let barrier = std::sync::Arc::new(std::sync::Barrier::new(THREADS));
                let mut handles = Vec::new();
                for _ in 0..THREADS {
                    let failures = std::sync::Arc::clone(&failures);
                    let barrier = std::sync::Arc::clone(&barrier);
                    handles.push(std::thread::spawn(move || {
                        barrier.wait();
                        for _ in 0..5 {
                            if connect().is_err() {
                                failures.fetch_add(1, Ordering::SeqCst);
                            }
                        }
                    }));
                }
                for h in handles {
                    h.join().unwrap();
                }
            }
            assert_eq!(
                failures.load(Ordering::SeqCst),
                0,
                "every concurrent connect on a fresh database must succeed"
            );
        });
    }

    /// The journal mode is persistent, so the exclusive-lock switch is a
    /// one-time cost, and asking for it again on a WAL database is harmless.
    #[test]
    fn journal_mode_is_wal_and_idempotent() {
        crate::testhome::with_test_home(|_| {
            connect().unwrap();
            let conn = connect().unwrap();
            let mode: String = conn
                .query_row("PRAGMA journal_mode", [], |row| row.get(0))
                .unwrap();
            assert_eq!(mode.to_ascii_lowercase(), "wal");
            ensure_wal(&conn).unwrap();
        });
    }

    #[test]
    fn connect_creates_the_schema() {
        crate::testhome::with_test_home(|_| {
            let conn = connect().unwrap();
            for table in ["config", "projects", "sessions", "models"] {
                let found: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                        [table],
                        |row| row.get(0),
                    )
                    .unwrap();
                assert_eq!(found, 1, "missing table {table}");
            }
        });
    }
}
