# Recurse monorepo task runner (`just --list` to see all).
#
# Layout: `tauri/` = desktop app (frontend + Rust backend),
# `crates/` = shared Rust crates, root `Cargo.toml` = workspace.
# `just` is the single entry point for both halves.
#
# Evals read `crates/recurse-eval/.env` themselves (see its `.env.example`),
# so `just eval-run` needs no shell exports.
default:
    @just --list

# --- app ---
dev:
    cd tauri && npm run tauri dev

build:
    cd tauri && npm run tauri build

# Frontend only (no desktop shell)
preview:
    cd tauri && npm run build && npm run preview

# --- checks ---
lint:
    cargo clippy --workspace --all-targets --all-features
    cd tauri && npm run lint

fmt:
    cargo fmt --all
    cd tauri && npm run format

fmt-check:
    cargo fmt --all --check
    cd tauri && npm run format:check

test:
    cargo test --workspace
    cd tauri && npm run test:fe

# Rust only / frontend only
test-rs:
    cargo test --workspace

test-fe:
    cd tauri && npm run test:fe

# Downloads a pinned large release and compares native output with objdump and r2pipe.
test-large-binary:
    cargo test -p recurse-static --test large_binary_consistency -- --ignored --nocapture

# --- evals (see crates/recurse-eval/README.md) ---
eval-fetch:
    cargo run -p recurse-eval --bin fetch-corpus

eval-test:
    cargo test -p recurse-eval --test unit

# The only way to run an eval YAML (a paid agent run, never part of `cargo test`).
# Logs + per-turn traces land in target/eval-traces/<tier>/<backend>/.
# Backend: EVAL_BACKEND=native|r2 (also `run.backend` in the YAML).
eval-run:
    cargo run -p recurse-eval --bin eval-run

# Backend-pinned eval runs: pure-Rust native (no radare2) or radare2.
eval-run-native:
    EVAL_BACKEND=native cargo run -p recurse-eval --bin eval-run

eval-run-r2:
    EVAL_BACKEND=r2 cargo run -p recurse-eval --bin eval-run

eval: eval-fetch eval-test
