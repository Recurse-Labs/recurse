# Analysis backends

Recurse does not depend on any single reverse-engineering engine. The binary
world-model (functions, disassembly, xrefs, strings, imports, CFG) is defined
once in `recurse_static::engine`, and each backend is an implementation of that
trait. The agent tool and every UI command go through the seam, so swapping the
engine never touches the agent loop, the storefront, or the eval harness.

## The seam

`crates/recurse-static/src/engine.rs` defines:

- `trait Engine` — one method per operation: `analyze`, `summary`, `info`,
  `functions`, `function_at`, `disassemble`, `function_disasm`,
  `function_graph`, `strings`, `imports`, `xrefs`, `decompile`, `lift`,
  `raw`, `resolve`, plus `pid`/`interrupt`/`force_kill` for out-of-process
  engines.
- Canonical result types (`FunctionInfo`, `Instruction`, `Disassembly`,
  `FunctionGraph`, `StringRef`, `Import`, `Xref`, `Decompilation`). Their JSON
  field names are exactly what the UI renders, so the frontend is
  backend-agnostic too.
- `BackendKind` (`native` | `r2` | `ida`), selected from `RECURSE_BACKEND` or the
  stored config. The default is `native`: the in-process, permissive,
  multi-architecture engine.
- The backend-neutral agent tool (`analyze`) and its dispatcher,
  `execute_tool(&dyn Engine, args)`. Its `op` vocabulary is
  `analyze | functions | disasm | graph | lift | decompile | xrefs | strings
  | imports | info | raw`. The vocabulary is filtered by `Engine::capabilities()`: an
  engine without a decompiler or console never advertises those ops in the
  schema or the system prompt, and `execute_tool` rejects them up front. `raw`
  is the escape hatch for an engine console, present only when the selected
  engine provides one. `lift` needs only `capabilities().graph` (it is built
  on `function_graph`, see below and `docs/vtil-lift.md`) so it is available
  on every engine that can recover a CFG, including the native default.

Hosts own the concrete engine (it needs a target path, and r2 needs a child
process) and box it as `Box<dyn Engine>` (see
`tauri/src-tauri/src/engine.rs`).

## Backends

### `native` — pure Rust (default)

`recurse_static::native::NativeEngine` parses and disassembles in-process. No child
process, no external tool, and no copyleft dependency anywhere in the chain.
Scope, stated honestly:

- ELF / PE / Mach-O parsing, symbols, imports, strings.
- Multi-architecture disassembly and control-flow recovery (Capstone):
  x86/x86-64, ARM (Arm and Thumb), AArch64, MIPS, PowerPC, RISC-V, SPARC,
  SystemZ, M68K, BPF.
- Disassembly annotation: direct call/jump targets are named
  (`call readInput`), `[rip+X]`/absolute references resolve to strings, globals,
  and imported data slots (`; "Enter key: "`, `; __libc_start_main`), and
  forwarding stubs are named after the import they resolve (`imp.exit`).
- Symbol names are demangled with template arguments and parameter lists
  stripped and capped at 64 chars: C++ STL symbols demangle to hundreds of
  characters (one `std::iter_swap` is 496), which otherwise dominates the
  model's context. Shortened names can collide; `resolve` returns the first
  match and the function list still carries addresses.
- Function discovery: symbols, the entry point, CET landing pads and classic
  prologues, direct call targets, and resolved indirect targets.
- Cross-references include data references (string/global loads), not just
  branch targets.
- Jump tables / switches are recovered (indexed-memory and base+offset idioms)
  and shown as `case` edges in the graph.
- Decompiler (`recurse_vtil::decompile`, `capabilities().decompile == true`):
  lift → optimize → structure, rendering C-like pseudocode with real
  `if`/`while` recognition and total instruction coverage (an unlifted
  instruction still appears, as an `__asm(...)` line) — not a Hex-Rays-class
  decompiler (no type/variable recovery). See `docs/vtil-lift.md`.
- Architectures Capstone does not cover (AVR, CSky, LoongArch, Xtensa, …) are
  detected and reported, not disassembled.

Analysis is **lazy**: opening a large binary only builds the function index
(cheap), and basic blocks/CFG/switch recovery decode on demand per function.
See [lazy-analysis.md](lazy-analysis.md) for the design, bounds, and timings.

### `r2` — radare2 (opt-in)

**r2** (radare2) is supported as an **opt-in alternative** analysis engine for
installs that want a full-featured engine, including decompilation and a command
console. Install it and select it as the engine (settings menu, or
`RECURSE_BACKEND=r2`); Recurse drives the `r2` binary on your `PATH`. It runs as
a separate program, is never linked or bundled, and is never required by the
build. When selected, the `decompile` and `raw` ops become available and its
capabilities are advertised to the agent and UI.

### `ida` — IDA Pro (opt-in)

**IDA Pro** (`ida`) is supported as an opt-in analysis engine driving headless IDA
(`idat`) over a local IPC socket. It provides Hex-Rays decompilation, CFG, xrefs,
and raw IDAPython execution. Select it via settings or `RECURSE_BACKEND=ida`.
Auto-detected from standard system paths, or configured via `RECURSE_IDA_PATH`.

## Crates and why

| Crate | License | Used for |
| --- | --- | --- |
| `object` | Apache-2.0 / MIT | ELF/PE/Mach-O/COFF parsing: architecture, bits, endianness, entry point, sections, symbols, imports, exports. |
| `capstone` | BSD-3-Clause | Multi-architecture disassembly + instruction groups (jump/call/ret) for CFG and xref recovery: x86, x86-64, ARM, AArch64, MIPS, PowerPC, RISC-V, SPARC, SystemZ, M68K, BPF, and more. Vendors the Capstone C library (permissive), used behind a safe API. |
| `rustc-demangle` | Apache-2.0 / MIT | Rust v0/legacy symbol demangling. |
| `cpp_demangle` | Apache-2.0 / MIT | Itanium C++ symbol demangling. |
| `nix` | MIT | Safe wrappers (`killpg`/`kill`) for `Engine::interrupt` / `force_kill` (r2 only). Replaces any raw `libc` FFI. |

Already-present crates that also serve analysis: `serde`/`serde_json` (canonical
envelopes), `regex` (host-side scans).

### Crates considered and rejected

| Candidate | Why not (for the native engine) |
| --- | --- |
| `iced-x86` | MIT and excellent, but x86-only. Capstone supersedes it for a multi-arch engine behind one API; keeps a single decode path. |
| `yaxpeax-*` | 0BSD/MIT pure-Rust multi-arch decoders. Kept as the fallback if linking the Capstone C library (via `cc`) is ever undesirable; coverage is currently narrower. |
| `goblin` | MIT, but `object` is the ecosystem standard and what `gimli`/`addr2line` use. |
| `zydis` | MIT but x86-only and bindgen over C++. No advantage over Capstone. |
| `petgraph` | MIT/Apache, but the CFG is a small `Vec<BasicBlock>` and needs no graph library. |
| RetDec / Ghidra / snowman | Full Hex-Rays-class decompilers. RetDec is MIT but a large C++ sidecar; Ghidra is Apache but a JVM; snowman is GPL. `recurse-vtil`'s own lift → optimize → structure pipeline (`crates/recurse-vtil/src/decompile.rs`) covers the native engine's decompiler instead, permissively and in-process; r2's own decompiler remains available too when selected. |

If linking a C library at all is unacceptable, swap `capstone` for the
`yaxpeax-*` decoders behind the same `Engine` methods; nothing above the trait
changes.

## Licensing posture

Because the engine is a trait:

- The repository ships the native engine and builds/runs with **no copyleft
  component present**.
- r2 is an optional runtime dependency of one implementation, invoked as a
  separate program (mere aggregation), never linked. Its code is isolated in
  its own modules and only runs when it is selected — so a distribution can
  omit it without touching the rest of the tree.
- The opt-in large-binary consistency test also invokes `r2`/`objdump` as
  separate oracle processes. It contains no r2pipe, radare2, or binutils code
  and does not bundle those tools. The downloaded Youki fixture is not stored
  in the repository.
