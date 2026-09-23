# Recurse

Agentic reverse engineering environment — a Ghidra-class desktop app in the spirit of
"Cursor for reverse engineering". Built with **Tauri 2** (React + TypeScript frontend) on top
of a **pluggable analysis backend**. The default is a **pure-Rust native engine** — no
external process, no copyleft dependency, multi-architecture via Capstone. You can also run
analysis through **r2** (radare2): install it, select it as the engine, and the whole app —
agent tools and UI — drives it instead. The agent tool and the UI are backend-agnostic —
see [docs/backends.md](docs/backends.md).

![Recurse demo](tauri/public/recurse_demo.png)

## Repository layout

Cargo workspace at the root; the desktop app is one package in it.

```
tauri/                   desktop app (Tauri + React)
  src/                     React frontend
  src-tauri/               Tauri Rust backend (engine sessions, agent wiring)
  package.json             app scripts (Vite, Vitest, Tauri CLI)
crates/
  recurse-agent/              agent framework: LLM loop, tool runtime, SQLite memory
  recurse-static/          static analysis: ELF/PE/Mach-O parsing, multi-arch disassembly,
                           CFG and cross-reference recovery, the engine seam
  recurse-vtil/            VTIL-inspired de-obfuscation/de-virtualization IL, lifter, optimizer
  recurse-mcp/             standalone headless MCP server (stdio) over the engine — no Tauri, no IDA
  recurse-debug/           cross-platform debugger (ptrace/Mach/Win32, breakpoints, stepping)
  recurse-eval/            headless eval harness (YAML-configured tiers)
justfile                 single entry point for both halves
```

`recurse-agent` is only the agent; static analysis lives in `recurse-static` and the
debugger in `recurse-debug`, so the agent pulls in neither systems code it does
not use. No crate depends on Tauri, and each builds/tests standalone;
`recurse-eval` drives the agent headlessly. All are workspace members, so one
`Cargo.lock` and one `target/` cover the whole repo.

## Features

- Cursor-style workspace: function list, disassembly/strings/imports tabs, CFG graph,
  and a chat agent sidebar (toggle with the Chat button or `Ctrl+L`)
- Recon page: binary info, MD5/SHA1/SHA256/CRC32 hashes, entropy, linked libraries,
  a self-contained hardening report (RELRO / PIE / NX / canary / FORTIFY / RPATH —
  no external `checksec`), and analysis counts
- Rename functions from the list (double-click or the ✎ button); names persist in
  SQLite and show up in the function list, disassembly annotations, and to the agent
- Grounded agent: every address is a clickable object (function list, graph nodes,
  xrefs, decompiler annotations) — not pasted text that the model can hallucinate
- Live analysis session on any binary — including extension-less files
- Persistent project memory in SQLite with FTS5/BM25 retrieval — renames, findings
  and notes survive `/clear` and reopen, and seed the next session
- Headless core (`recurse-agent`) with per-turn debug tracing; the same agent loop runs
  in the UI and in the eval harness
- LLM agent backed by an OpenAI-compatible endpoint (OpenRouter by default) with a
  model picker; drives the session directly (disasm, xrefs, strings, imports, decompile)
- Dark-first UI built with Tailwind CSS v4 + shadcn/ui
- `lift` op: raises a function into a VTIL-style de-obfuscation IL and runs
  whole-routine propagation/folding/dead-code-elimination/branch-resolution
  passes over it — useful when disassembly looks like a VM dispatcher or
  opaque-predicate chain (see [docs/vtil-lift.md](docs/vtil-lift.md))
- Native decompiler: `decompile` renders C-like pseudocode (`if`/`while`
  structuring, total instruction coverage) from the same `recurse-vtil`
  pipeline — no external tool, no r2 required
- Standalone `recurse-mcp` server: the same `Engine` over MCP stdio for any
  MCP-capable agent (Claude Code, Cursor, Claude Desktop, …) — no Tauri, no
  IDA seat, no Python bridge (see [docs/recurse-mcp.md](docs/recurse-mcp.md))

## Analysis backends

Analysis goes through a single `Engine` trait (`crates/recurse-static/src/engine.rs`), so the
engine is a choice, not a hard dependency:

- **`native`** (default) — pure-Rust ELF/PE/Mach-O parsing and multi-architecture disassembly
  (`object` + `capstone`): x86/x86-64, ARM, AArch64, MIPS, PowerPC, RISC-V, SPARC, SystemZ,
  M68K, BPF. No child process, no external tool, no LGPL in the build. Includes a decompiler
  (`recurse-vtil`'s lift → optimize → structure pipeline — see
  [docs/vtil-lift.md](docs/vtil-lift.md)) and a `lift` op for VTIL-style de-obfuscation.
- **r2** (radare2) — supported as an **opt-in** alternative for installs that want its own,
  more complete decompiler or a raw console. Install r2 and select it as the engine; it runs
  as a separate process and is never linked or bundled with Recurse.

Pick with the settings menu, the `RECURSE_BACKEND` environment variable, or the stored
config. The agent gets one backend-neutral `analyze` tool (`functions`, `disasm`, `graph`,
`lift`, `decompile`, `xrefs`, `strings`, `imports`, `info`, plus `raw` for the engine console) —
filtered to the ops the active engine actually supports, so `raw` (native has no console) is
only advertised when available. The UI consumes canonical result types, not any engine's JSON.
See [docs/backends.md](docs/backends.md) for the trait, the crate choices, and the licensing
rationale. Opening a large binary is fast because analysis is **lazy** — discovery indexes
functions cheaply and basic blocks decode only when a function is viewed; see
[docs/lazy-analysis.md](docs/lazy-analysis.md).

## Why not just MCP-to-IDA / yolo it in Claude Code?

Stapling an MCP server onto IDA/Ghidra, or pasting disassembly into a CLI agent,
works for 5-function CTFs and falls apart on real binaries. Recurse is a
purpose-built environment, not a chatbot wrapper:

- **Binary world-model, not text scraping.** Functions, xrefs, strings and the CFG
  are first-class state shared by the agent and the UI. No re-parsing
  `pdF` dumps into context every turn, no invented `0x401023`s.
- **Verification > generation.** In RE there is no `npm test` — verification is
  visual. Agent renames propagate to the function list, graph and decompile
  instantly, so a human confirms or rejects in one click.
- **Built for scale.** Real malware is 10k functions. Demand-driven tools +
  persistent memory beat dumping full decompiles until context OOMs.
- **Agentable engine.** A scriptable, pipeable engine means agents can run 100 turns, fork,
  reset and diff — and you can actually ship it. The default native engine needs no external
  tool at all.
- **Malware-safe by default.** Local-first, BYO-key/OpenRouter routing, and a path
  to offline models — no forced exfil of samples to a cloud chatbot.

## Install

**macOS / Linux:**

```bash
curl -fsSL https://raw.githubusercontent.com/Recurse-Labs/recurse/master/scripts/install.sh | sh
```

**Windows (PowerShell):**

```powershell
powershell -c "irm https://raw.githubusercontent.com/Recurse-Labs/recurse/master/scripts/install.ps1 | iex"
```

Each script grabs the right bundle from the
[latest release](https://github.com/Recurse-Labs/recurse/releases/latest) for your OS/arch
and installs it natively (`.deb`/`.rpm`/`.AppImage` on Linux, `.dmg` → `/Applications` on
macOS, `.msi`/`.exe` on Windows). Prefer a manual download? Grab the asset for your platform
from the [Releases page](https://github.com/Recurse-Labs/recurse/releases) instead.

Once installed, Recurse updates itself — no reinstalling for new versions. It checks for
updates on launch and offers a one-click **"Update to vX.Y.Z"** from the ⚙ menu; see
[docs/updating.md](docs/updating.md). Building from source instead? Skip to
[Prerequisites](#prerequisites) below.

## Prerequisites

### 1. Core toolchains

| Tool     | Version (tested)   | Install                                                                 |
| -------- | ------------------ | ----------------------------------------------------------------------- |
| Node.js  | ≥ 20 (23.11 used)  | https://nodejs.org or `nvm`                                              |
| npm      | ≥ 10               | ships with Node.js                                                       |
| Rust     | ≥ 1.77 (1.97 used) | https://rustup.rs                                                         |
| cargo    | —                  | ships with Rust (rustup)                                                  |

Verify:

```bash
node --version && npm --version && rustc --version && cargo --version
```

### 2. Analysis engine

The default **native** engine is pure Rust — **nothing to install**. To use **r2** (radare2)
as the analysis engine instead, install it and select it (the settings menu, or
`RECURSE_BACKEND=r2`); Recurse drives the `r2` binary on your `PATH`. r2 is optional, is
never required by the build, and is never distributed with Recurse — bring your own install.

### 3. Tauri Linux system dependencies

Debian/Ubuntu/Pop!_OS:

```bash
sudo apt update
sudo apt install -y libwebkit2gtk-4.1-dev build-essential \
  curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

Other distros: follow the official
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

### 4. Decompiler

Both engines provide one: `native` renders pseudocode via `recurse-vtil`
(lift → optimize → structure — see [docs/vtil-lift.md](docs/vtil-lift.md)),
nothing to install; **r2** can provide its own, more complete decompiler
when its plugin is installed.

## Build

App dependencies live in `tauri/`; Rust comes from the workspace root. `just` wraps
both (see `just --list`), or drive them directly.

### Development

```bash
just dev
# equivalent: cd tauri && npm install && npm run tauri dev
```

This starts the Vite dev server and launches the Tauri window. First compile takes a
while (Rust build); subsequent ones are fast.

### Production binary

```bash
just build
# equivalent: cd tauri && npm run tauri build
```

The bundle lands in `target/release/bundle/` (workspace target):

- `.deb` / `.rpm` / `.AppImage` for Linux
- standalone binary at `target/release/recurse`

On Arch and other rolling distros the AppImage step needs a one-time local fix
(upstream `linuxdeploy` lags the distro toolchain) — see
[docs/linux-appimage-build.md](docs/linux-appimage-build.md).

Local builds don't ship signed updater artifacts (that requires the
`TAURI_SIGNING_PRIVATE_KEY` secret, set only in CI) and won't self-update —
expected for a source build. See [docs/releasing.md](docs/releasing.md) for
how tagged releases are built, signed, and published.

### Just the frontend (no desktop shell)

```bash
just preview
# equivalent: cd tauri && npm run build && npm run preview
```

## Quality checks

```bash
just lint        # cargo clippy --workspace + eslint
just fmt         # cargo fmt --all + prettier
just fmt-check   # verify without writing
just test        # cargo test --workspace + vitest
```

Equivalent direct commands: `cargo clippy --workspace --all-targets`,
`cargo test --workspace` at the root; `npm run lint` / `npm run format` /
`npm run build` inside `tauri/`.

## Evals

The agent is evaluated headlessly against crackme tiers (see
[`crates/recurse-eval/README.md`](crates/recurse-eval/README.md)). Tiers are YAML:
selection filters over the dataset, or a frozen hexid list, plus run knobs.

```bash
just eval-fetch   # download the tier's binaries
just eval-test    # harness self-tests (no API key needed, no LLM calls)
just eval-run     # run the tier — the only way to execute an eval YAML
```

`eval-run` is a binary, not a test, so `cargo test` never spends money or time on
the agent. Endpoint + key go in `crates/recurse-eval/.env` (copy `.env.example`).
Each run writes `target/eval-traces/<tier>/<backend>/run.log` (the full narrative)
plus one `<hexid>.json` per task with the complete per-turn conversation. The
backend (`native` or `r2`) is selectable per run — see the eval README.

## Agent LLM

The agent chat panel runs on any OpenAI-compatible endpoint. Configure the API key,
base URL, and model from the in-app **Model & Provider** dialog (persisted in
`~/.recurse/recurse.db`), or via env:

```bash
# Hosted provider (default)
export RECURSE_LLM_API_KEY=sk-or-...   # or OPENROUTER_API_KEY
export RECURSE_LLM_ENDPOINT=https://openrouter.ai/api/v1/chat/completions  # optional
export RECURSE_LLM_MODEL=openrouter/auto  # optional
```

### Local models / custom base URL

Point the agent at any local or self-hosted OpenAI-compatible server — Ollama, LM
Studio, llama.cpp's `llama-server`, vLLM, text-generation-webui, or a remote gateway.
Set the **Base URL** in the dialog (a bare base URL or a full `/chat/completions`
route both work) and pick a model from that server's catalog, or type a model id
(`llama3.1:8b`, `qwen2.5-coder`, …) directly:

```bash
export RECURSE_LLM_ENDPOINT=http://localhost:11434/v1   # Ollama
export RECURSE_LLM_MODEL=llama3.1:8b
export RECURSE_LLM_API_KEY=           # usually unnecessary locally
```

Local endpoints need no API key: when the key is blank the request is sent with no
`Authorization` header, and the model list is read from the endpoint's own
`{base}/models`. A custom endpoint is treated as configured without a key, so the
chat works out of the box against a local server.

Without credentials it falls back to an echo client so the wiring stays exercisable.

The agent sees live binary context (arch, bits, type) and can drive the full analysis
surface (disassembly, xrefs, strings, imports, decompilation) through the session.

## License

[Apache-2.0](./LICENSE) — © 2026 Aayush Khanna