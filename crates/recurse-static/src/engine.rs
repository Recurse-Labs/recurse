//! Backend-agnostic binary-analysis engine.
//!
//! Analysis is not tied to any single implementation. This module defines the
//! seam:
//!
//! * [`Engine`] — one trait with a method per analysis operation (info,
//!   functions, disassembly, CFG, strings, imports, xrefs, decompilation,
//!   raw console). Every method returns owned, backend-neutral results.
//! * Canonical result types ([`FunctionInfo`], [`Instruction`], [`Xref`], …)
//!   whose JSON field names are exactly what the UI renders, so swapping the
//!   backend does not ripple into the frontend.
//! * [`BackendKind`] — which implementation to build. `native` is the pure-Rust
//!   parser/disassembler and the default; r2 (radare2) is available opt-in and
//!   runs as a separate process.
//! * [`tool_schema`] / [`execute_tool`] — a single backend-neutral agent tool
//!   (`analyze`) with a small, structured `op` vocabulary instead of any
//!   engine-specific command syntax. `op:"raw"` remains for engine console
//!   commands.
//!
//! Hosts own the concrete engine (it needs a target path, and an external
//! backend needs a child process) and hand a `&dyn Engine` to the tool runtime.
//! Everything here is pure data and pure functions, unit-tested without any
//! backend installed.

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Name of the backend-neutral analysis tool the agent calls.
pub const TOOL_NAME: &str = "analyze";

/// Which analysis implementation to instantiate.
///
/// Selected at runtime from `RECURSE_BACKEND` (or the host's config store).
/// The default is [`BackendKind::Native`]: the in-process, permissive,
/// multi-architecture backend. Opt into r2 (radare2) with
/// `RECURSE_BACKEND=r2` or the stored config.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BackendKind {
    /// r2 (radare2), driven over its pipe as a child process.
    R2,
    /// Pure-Rust ELF/PE/Mach-O parsing and disassembly.
    Native,
    /// IDA Pro (Hex-Rays), driven over headless IPC.
    Ida,
}

impl Default for BackendKind {
    /// The native backend: in-process, permissive, no external tool.
    ///
    /// ```
    /// use recurse_static::engine::BackendKind;
    /// assert_eq!(BackendKind::default(), BackendKind::Native);
    /// std::env::remove_var("RECURSE_BACKEND");
    /// assert_eq!(BackendKind::from_env(), BackendKind::Native);
    /// ```
    fn default() -> Self {
        Self::Native
    }
}

impl BackendKind {
    /// Parse a backend name. Accepts `native`, `r2`, and `ida` names.
    ///
    /// ```
    /// use recurse_static::engine::BackendKind;
    /// assert_eq!(BackendKind::parse("r2"), Some(BackendKind::R2));
    /// assert_eq!(BackendKind::parse("radare2"), Some(BackendKind::R2));
    /// assert_eq!(BackendKind::parse("Native"), Some(BackendKind::Native));
    /// assert_eq!(BackendKind::parse("ida"), Some(BackendKind::Ida));
    /// assert_eq!(BackendKind::parse("ghidra"), None);
    /// ```
    pub fn parse(name: &str) -> Option<Self> {
        match name.trim().to_ascii_lowercase().as_str() {
            "r2" | "radare2" => Some(Self::R2),
            "native" | "rust" => Some(Self::Native),
            "ida" | "idapro" | "hexrays" => Some(Self::Ida),
            _ => None,
        }
    }

    /// Resolve the backend from the `RECURSE_BACKEND` environment variable,
    /// falling back to [`BackendKind::default`] (native). Unknown values are
    /// ignored rather than fatal: a typo must never make the app unusable.
    ///
    /// ```
    /// use recurse_static::engine::BackendKind;
    /// std::env::remove_var("RECURSE_BACKEND");
    /// assert_eq!(BackendKind::from_env(), BackendKind::default());
    /// std::env::set_var("RECURSE_BACKEND", "r2");
    /// assert_eq!(BackendKind::from_env(), BackendKind::R2);
    /// std::env::set_var("RECURSE_BACKEND", "ida");
    /// assert_eq!(BackendKind::from_env(), BackendKind::Ida);
    /// std::env::remove_var("RECURSE_BACKEND");
    /// ```
    pub fn from_env() -> Self {
        std::env::var("RECURSE_BACKEND")
            .ok()
            .and_then(|v| Self::parse(&v))
            .unwrap_or_default()
    }

    /// Stable lowercase label for logs, the UI, and the database.
    ///
    /// ```
    /// use recurse_static::engine::BackendKind;
    /// assert_eq!(BackendKind::R2.as_str(), "r2");
    /// assert_eq!(BackendKind::Native.as_str(), "native");
    /// assert_eq!(BackendKind::Ida.as_str(), "ida");
    /// ```
    pub fn as_str(self) -> &'static str {
        match self {
            Self::R2 => "r2",
            Self::Native => "native",
            Self::Ida => "ida",
        }
    }
}

/// What a backend can actually do. Backends advertise this so the host can
/// hide UI affordances (the decompiler button) and the tool layer can answer
/// `op:"decompile"` with a precise message instead of a generic failure.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Capabilities {
    /// Decompilation, when the selected engine provides it (the native
    /// engine does not).
    pub decompile: bool,
    /// A raw, backend-specific console passthrough.
    pub raw: bool,
    /// Control-flow graph reconstruction.
    pub graph: bool,
    /// References pointing *from* an address (not just to it).
    pub xrefs_from: bool,
}

impl Capabilities {
    /// Conservative default: no optional features at all.
    ///
    /// ```
    /// use recurse_static::engine::Capabilities;
    /// let c = Capabilities::none();
    /// assert!(!c.decompile);
    /// assert!(!c.raw);
    /// ```
    pub fn none() -> Self {
        Self {
            decompile: false,
            raw: false,
            graph: false,
            xrefs_from: false,
        }
    }

    /// Every optional feature available. r2 advertises this, and
    /// it is the permissive default for callers that have not built an engine
    /// yet (e.g. schema previews and tests).
    ///
    /// ```
    /// use recurse_static::engine::Capabilities;
    /// let c = Capabilities::all();
    /// assert!(c.decompile && c.raw && c.graph && c.xrefs_from);
    /// ```
    pub fn all() -> Self {
        Self {
            decompile: true,
            raw: true,
            graph: true,
            xrefs_from: true,
        }
    }
}

/// An analysis target: a concrete address or a symbol to resolve first. The
/// tool layer accepts both so the model can write `main` or `0x401000`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Target {
    /// A numeric virtual address.
    Addr(u64),
    /// A name to resolve through the backend's symbol table.
    Symbol(String),
}

impl Target {
    /// Parse an address argument that may be a JSON number, a `0x`/decimal
    /// string, or a symbol name. `null`/missing yields `None`.
    ///
    /// ```
    /// use recurse_static::engine::Target;
    /// use serde_json::json;
    /// assert_eq!(Target::from_json(&json!(4198400)), Some(Target::Addr(0x401000)));
    /// assert_eq!(Target::from_json(&json!("0x401000")), Some(Target::Addr(0x401000)));
    /// assert_eq!(Target::from_json(&json!("main")), Some(Target::Symbol("main".into())));
    /// assert_eq!(Target::from_json(&json!(null)), None);
    /// ```
    pub fn from_json(value: &Value) -> Option<Self> {
        match value {
            Value::Number(n) => n.as_u64().map(Target::Addr),
            Value::String(s) => {
                let t = s.trim();
                if t.is_empty() {
                    None
                } else if let Some(hex) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
                    u64::from_str_radix(hex, 16).ok().map(Target::Addr)
                } else if let Ok(dec) = t.parse::<u64>() {
                    Some(Target::Addr(dec))
                } else {
                    Some(Target::Symbol(t.to_string()))
                }
            }
            _ => None,
        }
    }

    /// The concrete address when this target is already numeric.
    ///
    /// ```
    /// use recurse_static::engine::Target;
    /// assert_eq!(Target::Addr(7).to_u64(), Some(7));
    /// assert_eq!(Target::Symbol("main".into()).to_u64(), None);
    /// ```
    pub fn to_u64(&self) -> Option<u64> {
        match self {
            Self::Addr(a) => Some(*a),
            Self::Symbol(_) => None,
        }
    }
}

/// Direction of a cross-reference query.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum XrefDirection {
    /// References that point *at* the address (callers, data readers).
    To,
    /// References that point *from* the address (callees, data written).
    From,
}

/// A function as the UI and agent see it. Field names are exactly what the
/// frontend renders (`addr`, `name`, `size`, `signature`).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct FunctionInfo {
    pub addr: u64,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nbbs: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edges: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

/// One disassembled instruction.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Instruction {
    pub addr: u64,
    pub disasm: String,
    /// Raw instruction bytes as hex, when known. Populated for the UI's byte
    /// column; stripped from agent tool output (bulky and re-derivable).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes: Option<String>,
    /// Instruction category (`call`, `jmp`, `ret`, `cjmp`, …) when known.
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// Direct branch/call destination, when statically known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jump: Option<u64>,
    /// Fall-through destination for a conditional branch.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fail: Option<u64>,
    /// Instruction byte length. Not part of the wire format; used to resolve
    /// RIP-relative operands when annotating disassembly with symbol/string
    /// names.
    #[serde(skip)]
    pub len: u32,
}

/// A function's disassembly.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Disassembly {
    pub addr: u64,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    pub ops: Vec<Instruction>,
}

/// One basic block inside a control-flow graph.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct BasicBlock {
    pub addr: u64,
    pub ninstr: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jump: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fail: Option<u64>,
    /// Extra successors when the block ends in a computed jump (a jump-table /
    /// switch case list). Empty for a plain conditional or unconditional block.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub targets: Vec<u64>,
    pub ops: Vec<Instruction>,
}

/// A function's control-flow graph.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct FunctionGraph {
    pub addr: u64,
    pub name: String,
    pub blocks: Vec<BasicBlock>,
}

/// One string recovered from the binary.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct StringRef {
    #[serde(rename = "vaddr")]
    pub addr: u64,
    pub string: String,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}

/// One imported symbol.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Import {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plt: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bind: Option<String>,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}

/// One cross-reference.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Xref {
    pub from: u64,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fcn_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opcode: Option<String>,
}

/// Decompiler output for one function.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Decompilation {
    pub addr: u64,
    pub name: String,
    pub code: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub annotations: Vec<Value>,
}

/// The analysis engine contract. Implementations are `Send + Sync` so a host
/// can hold one behind a lock and drive it from either the UI thread or the
/// async agent runtime. Methods take `&self`; implementations use interior
/// mutability for their own process/state.
pub trait Engine: Send + Sync {
    /// Which implementation this is.
    fn backend(&self) -> BackendKind;

    /// Features this backend actually supports.
    fn capabilities(&self) -> Capabilities;

    /// The analysed binary's path.
    fn path(&self) -> &Path;

    /// Run the backend's analysis pass. Idempotent.
    fn analyze(&self) -> Result<(), String>;

    /// Full binary summary, shaped for the UI
    /// (`{path, info:{bin:{...}}, function_count, string_count}`).
    fn summary(&self) -> Result<Value, String>;

    /// Raw engine metadata, shaped for the UI.
    fn info(&self) -> Result<Value, String>;

    /// Backend-specific reconnaissance summary for the recon page: linked
    /// libraries, a self-contained hardening report (RELRO / PIE / NX / …),
    /// reference and call counts, symbol count, analysis coverage, and extra
    /// binary info. The host adds file hashes and entropy itself, so a backend
    /// that cannot compute a field simply omits it.
    fn recon(&self) -> Result<Value, String> {
        Ok(Value::Object(serde_json::Map::new()))
    }

    /// All discovered functions.
    fn functions(&self) -> Result<Vec<FunctionInfo>, String>;

    /// The function containing `addr`, if any.
    fn function_at(&self, addr: u64) -> Result<Option<FunctionInfo>, String>;

    /// Disassemble `count` instructions starting at `target` (following the
    /// function when `count` is `None`).
    fn disassemble(&self, target: &Target, count: Option<usize>) -> Result<Disassembly, String>;

    /// Disassemble the whole function containing `addr`.
    fn function_disasm(&self, addr: u64) -> Result<Disassembly, String>;

    /// Reconstruct the control-flow graph of the function containing `addr`.
    fn function_graph(&self, addr: u64) -> Result<FunctionGraph, String>;

    /// Recover strings referenced by the binary.
    fn strings(&self) -> Result<Vec<StringRef>, String>;

    /// List imported symbols.
    fn imports(&self) -> Result<Vec<Import>, String>;

    /// Cross-references to/from `target`.
    fn xrefs(&self, target: &Target, direction: XrefDirection) -> Result<Vec<Xref>, String>;

    /// Decompile the function containing `addr`.
    fn decompile(&self, addr: u64) -> Result<Decompilation, String>;

    /// Lift the function containing `addr` into the VTIL-inspired IL
    /// ([`recurse_vtil`]), run its optimizer passes to a fixpoint, and
    /// return a VTIL-style text dump plus optimization stats. Implemented
    /// once here on top of [`Engine::function_graph`] rather than per
    /// backend, so it works unchanged against every [`Engine`] — including
    /// a future one — without any backend reimplementing the lifter. See
    /// `docs/vtil-lift.md`.
    fn lift(&self, addr: u64) -> Result<Value, String> {
        let graph = self.function_graph(addr)?;
        let blocks = function_graph_to_vtil_blocks(&graph);
        let (routine, stats) = recurse_vtil::lift_and_optimize(graph.addr, &graph.name, &blocks);
        Ok(json!({
            "op": "lift",
            "addr": routine.entry,
            "name": routine.name,
            "instructions": routine.instr_count(),
            "vtil": recurse_vtil::text::to_vtil_text(&routine),
            "optimized": stats,
        }))
    }

    /// Engine-specific console passthrough. Returns
    /// the backend's structured or textual output unchanged.
    fn raw(&self, cmd: &str) -> Result<Value, String>;

    /// Resolve a symbol name to an address, if the backend knows it.
    fn resolve(&self, name: &str) -> Result<Option<u64>, String>;

    /// Read `len` raw bytes at virtual address `addr` — the backing for the
    /// hex view. Default: unsupported (a backend opts in by overriding).
    fn read_bytes(&self, _addr: u64, _len: usize) -> Result<Vec<u8>, String> {
        Err("read_bytes: not supported by this backend".to_string())
    }

    /// Patch `bytes` directly into the file on disk at virtual address
    /// `addr` — the backing for in-place patching. Writes go straight to the
    /// file; the running session's cached analysis (disassembly, functions,
    /// decompile) is **not** re-derived from the patch, so a caller that
    /// wants the patched bytes reflected in disassembly must reopen the
    /// binary. Default: unsupported.
    fn write_bytes(&self, _addr: u64, _bytes: &[u8]) -> Result<(), String> {
        Err("write_bytes: not supported by this backend".to_string())
    }

    /// Install analyst name overrides (`address -> name`), replacing any
    /// previous set. Backends apply them to `functions`, `function_at`,
    /// `resolve`, and disassembly annotation where they can, so a rename is
    /// visible to both the UI and the agent. An empty map clears all
    /// overrides. Default: no-op.
    fn set_renames(&self, _renames: std::collections::HashMap<u64, String>) {}

    /// True while the backend is still expanding its function index in the
    /// background. A lazy backend reports `true` after [`Engine::analyze`]
    /// until its background pass finishes; synchronous backends always report
    /// `false`.
    fn indexing(&self) -> bool {
        false
    }

    /// Child process id for interrupt/teardown; 0 when the backend is
    /// in-process or unknown.
    fn pid(&self) -> u32 {
        0
    }

    /// Best-effort interrupt of a blocked operation. Returns false when the
    /// backend has no interruptible process.
    fn interrupt(&self) -> bool {
        false
    }

    /// Last-resort kill of a wedged backend process. Returns false when there
    /// is nothing to kill.
    fn force_kill(&self) -> bool {
        false
    }
}

/// Adapt a [`FunctionGraph`] into [`recurse_vtil`]'s decoupled input shape
/// (`InputBlock`/`InputInsn`) — the one place this conversion is written,
/// shared by [`Engine::lift`]'s default body and any backend (`native`'s
/// [`crate::native::NativeEngine::decompile`]) that builds its own
/// [`Decompilation`] on top of [`recurse_vtil::decompile::decompile`]
/// instead of the `lift` op's text dump.
pub fn function_graph_to_vtil_blocks(graph: &FunctionGraph) -> Vec<recurse_vtil::InputBlock> {
    graph
        .blocks
        .iter()
        .map(|b| recurse_vtil::InputBlock {
            addr: b.addr,
            jump: b.jump,
            fail: b.fail,
            targets: b.targets.clone(),
            ops: b
                .ops
                .iter()
                .map(|op| recurse_vtil::InputInsn {
                    addr: op.addr,
                    disasm: op.disasm.clone(),
                    kind: op.kind.clone(),
                    jump: op.jump,
                    fail: op.fail,
                })
                .collect(),
        })
        .collect()
}

/// JSON schema for the single backend-neutral analysis tool.
///
/// One tool with a structured `op` keeps the schema small (it is re-sent with
/// every request) while staying independent of any backend's command syntax.
/// The `op` enum and description are filtered by `capabilities`, so a backend
/// that cannot serve an op never advertises it — the model is not tempted to
/// waste turns on `decompile`/`raw` against the native backend.
///
/// ```
/// use recurse_static::engine::{tool_schema, Capabilities};
/// let schema = tool_schema(Capabilities::all());
/// assert_eq!(schema["function"]["name"], "analyze");
///
/// // A backend with no decompiler or console drops those ops entirely.
/// let native = Capabilities { decompile: false, raw: false, graph: true, xrefs_from: true };
/// let ops = tool_schema(native)["function"]["parameters"]["properties"]["op"]["enum"]
///     .as_array()
///     .unwrap()
///     .clone();
/// assert!(!ops.iter().any(|v| v == "decompile"));
/// assert!(!ops.iter().any(|v| v == "raw"));
/// ```
pub fn tool_schema(capabilities: Capabilities) -> Value {
    let mut ops: Vec<&str> = vec!["analyze", "functions", "disasm"];
    if capabilities.graph {
        ops.push("graph");
        ops.push("lift");
    }
    if capabilities.decompile {
        ops.push("decompile");
    }
    ops.extend(["xrefs", "strings", "imports", "info"]);
    if capabilities.raw {
        ops.push("raw");
    }
    let mut description = format!(
        "Inspect the loaded binary through the active analysis backend. \
         This is the primary way to examine the target: prefer it over shelling out. \
         Analysis state persists, so call `analyze` once and then query. \
         Ops: {}. `addr` accepts a number, `0x` hex, or a symbol name. Results are compact JSON.",
        ops.join(", ")
    );
    if capabilities.graph {
        description.push_str(
            " `lift` raises a function into a VTIL-style de-obfuscation IL, runs constant-folding/propagation/dead-code-elimination passes, and returns the optimized text — useful when disassembly looks like a VM dispatcher or opaque-predicate chain.",
        );
    }
    if capabilities.raw {
        description.push_str(
            " `raw` runs an engine console command, available only when the selected engine provides one.",
        );
    }
    json!({
        "type": "function",
        "function": {
            "name": TOOL_NAME,
            "description": description,
            "parameters": {
                "type": "object",
                "properties": {
                    "op": {
                        "type": "string",
                        "enum": ops
                    },
                    "addr": {
                        "type": ["string", "integer"],
                        "description": "Target address or symbol name (hex, decimal, or name)."
                    },
                    "count": {
                        "type": "integer",
                        "description": "For `disasm`: number of instructions. Omit to use the whole function."
                    },
                    "direction": {
                        "type": "string",
                        "enum": ["to", "from"],
                        "description": "For `xrefs`: which way the references point (default \"to\")."
                    },
                    "query": {
                        "type": "string",
                        "description": "Substring filter applied to `functions`, `strings`, or `imports`."
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Max items returned (default 60)."
                    },
                    "cmd": {
                        "type": "string",
                        "description": "For `raw`: the backend console command."
                    }
                },
                "required": ["op"]
            }
        }
    })
}

/// Hard ceiling on returned items, so a huge binary cannot blow the context.
pub const MAX_LIMIT: usize = 500;

/// Every operation the neutral tool understands. Kept explicit (not derived
/// from capabilities) so hosts can recognise a tool call the model named after
/// the op — a common mistake (`{"name":"disasm"}` instead of
/// `{"name":"analyze","op":"disasm"}`) that would otherwise fail.
pub const OPS: &[&str] = &[
    "analyze",
    "functions",
    "disasm",
    "graph",
    "lift",
    "decompile",
    "xrefs",
    "strings",
    "imports",
    "info",
    "raw",
];

/// True when `name` is one of the [`TOOL_NAME`] tool's `op` values.
///
/// ```
/// use recurse_static::engine::{is_op, TOOL_NAME};
/// assert!(is_op("disasm"));
/// assert!(is_op(TOOL_NAME));
/// assert!(!is_op("bash"));
/// ```
pub fn is_op(name: &str) -> bool {
    OPS.contains(&name)
}

/// Normalise a tool call whose `name` is either the tool (`analyze`) or one of
/// its ops. Returns `args` with `op` filled in, or `None` when `name` is
/// neither. This lets a host serve a call the model named after the op.
///
/// ```
/// use recurse_static::engine::op_args;
/// use serde_json::json;
/// assert_eq!(
///     op_args("disasm", &json!({"addr": "main"})),
///     Some(json!({"addr": "main", "op": "disasm"})),
/// );
/// // The tool's own name leaves args untouched.
/// assert_eq!(op_args("analyze", &json!({"op": "info"})), Some(json!({"op": "info"})));
/// assert_eq!(op_args("bash", &json!({})), None);
/// ```
pub fn op_args(name: &str, args: &Value) -> Option<Value> {
    if name == TOOL_NAME {
        return Some(args.clone());
    }
    if !is_op(name) {
        return None;
    }
    let mut merged = match args {
        Value::Object(map) => Value::Object(map.clone()),
        _ => json!({}),
    };
    if let Value::Object(map) = &mut merged {
        map.insert("op".to_string(), Value::String(name.to_string()));
    }
    Some(merged)
}

/// Execute a tool call by its wire `name`, accepting either the tool name or
/// an op name. Hosts route every analysis call through this instead of
/// matching on [`TOOL_NAME`] alone.
///
/// ```
/// use recurse_static::engine::{execute_call, BackendKind, Capabilities, Engine};
/// use recurse_static::engine::{Decompilation, Disassembly, FunctionGraph, FunctionInfo};
/// use recurse_static::engine::{Import, StringRef, Target, Xref, XrefDirection};
/// use serde_json::{json, Value};
/// use std::path::Path;
///
/// struct Stub;
/// impl Engine for Stub {
///     fn backend(&self) -> BackendKind { BackendKind::Native }
///     fn capabilities(&self) -> Capabilities { Capabilities::none() }
///     fn path(&self) -> &Path { Path::new("/bin/true") }
///     fn analyze(&self) -> Result<(), String> { Ok(()) }
///     fn summary(&self) -> Result<Value, String> { Ok(json!({})) }
///     fn info(&self) -> Result<Value, String> { Ok(json!({})) }
///     fn functions(&self) -> Result<Vec<FunctionInfo>, String> { Ok(vec![]) }
///     fn function_at(&self, _a: u64) -> Result<Option<FunctionInfo>, String> { Ok(None) }
///     fn disassemble(&self, _t: &Target, _c: Option<usize>) -> Result<Disassembly, String> {
///         Ok(Disassembly { addr: 1, name: "f".into(), size: None, ops: vec![] })
///     }
///     fn function_disasm(&self, _a: u64) -> Result<Disassembly, String> {
///         Ok(Disassembly { addr: 1, name: "f".into(), size: None, ops: vec![] })
///     }
///     fn function_graph(&self, _a: u64) -> Result<FunctionGraph, String> {
///         Ok(FunctionGraph { addr: 1, name: "f".into(), blocks: vec![] })
///     }
///     fn strings(&self) -> Result<Vec<StringRef>, String> { Ok(vec![]) }
///     fn imports(&self) -> Result<Vec<Import>, String> { Ok(vec![]) }
///     fn xrefs(&self, _t: &Target, _d: XrefDirection) -> Result<Vec<Xref>, String> { Ok(vec![]) }
///     fn decompile(&self, _a: u64) -> Result<Decompilation, String> { Err("no".into()) }
///     fn raw(&self, _c: &str) -> Result<Value, String> { Err("no".into()) }
///     fn resolve(&self, _n: &str) -> Result<Option<u64>, String> { Ok(None) }
/// }
///
/// // The model named the op instead of the tool: still routed.
/// let out = execute_call(&Stub, "disasm", &json!({"addr": 1})).unwrap();
/// assert!(out.contains("\"op\":\"disasm\""));
/// assert!(execute_call(&Stub, "bash", &json!({})).is_err());
/// ```
pub fn execute_call(engine: &dyn Engine, name: &str, args: &Value) -> Result<String, String> {
    match op_args(name, args) {
        Some(merged) => execute_tool(engine, &merged),
        None => Err(format!("unknown tool: {name}")),
    }
}

/// Default items per list.
pub const DEFAULT_LIMIT: usize = 60;

/// Serialize an envelope compactly. Minified on purpose: whitespace in a
/// 60-item envelope is paid for on every later turn.
///
/// ```
/// use recurse_static::engine::compact;
/// use serde_json::json;
/// assert_eq!(compact(json!({"a": 1})), r#"{"a":1}"#);
/// ```
pub fn compact(value: Value) -> String {
    serde_json::to_string(&value).unwrap_or_else(|_| "{}".to_string())
}

/// Remove `bytes` from every object in an agent-facing result. The model does
/// not need instruction bytes (bulky, re-derivable from the address); the UI
/// does, and reads them from the host commands, not this tool.
fn strip_bytes(value: &mut Value) {
    match value {
        Value::Object(map) => {
            map.remove("bytes");
            for v in map.values_mut() {
                strip_bytes(v);
            }
        }
        Value::Array(items) => {
            for v in items.iter_mut() {
                strip_bytes(v);
            }
        }
        _ => {}
    }
}

/// Keep at most `limit` items, reporting how many were dropped.
///
/// ```
/// use recurse_static::engine::take;
/// let v = vec![1, 2, 3, 4];
/// let (kept, dropped) = take(&v, 2);
/// assert_eq!(kept, vec![&1, &2]);
/// assert_eq!(dropped, 2);
/// ```
pub fn take<T>(items: &[T], limit: usize) -> (Vec<&T>, usize) {
    let kept = items.iter().take(limit).collect::<Vec<_>>();
    (kept, items.len().saturating_sub(limit))
}

/// Filter items with a case-insensitive substring match against one or more
/// candidate fields. An empty/whitespace query keeps everything.
fn matches_query(query: &str, candidates: &[&str]) -> bool {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return true;
    }
    candidates.iter().any(|c| c.to_lowercase().contains(&q))
}

/// Build a `{op, count, showing, items, truncated?, hint?}` envelope.
fn list_envelope(op: &str, total: usize, showing: usize, items: Value) -> Value {
    let mut env = json!({
        "op": op,
        "count": total,
        "showing": showing,
        "items": items,
    });
    if total > showing {
        env["truncated"] = json!(true);
        env["hint"] = json!(format!(
            "{total} items total; raise `limit` or narrow the query"
        ));
    }
    env
}

/// Execute one `analyze` tool call against an engine and return the compact
/// JSON result the model reads.
///
/// This is the single routing point between the backend-neutral tool schema
/// and whichever [`Engine`] the host selected, so the agent never encodes
/// engine-specific specifics in its own logic.
///
/// ```
/// use recurse_static::engine::{execute_tool, BackendKind, Capabilities};
/// use recurse_static::engine::{Disassembly, Engine, FunctionGraph, FunctionInfo};
/// use recurse_static::engine::{Import, StringRef, Target, Xref, XrefDirection};
/// use serde_json::{json, Value};
/// use std::path::Path;
///
/// struct Stub;
/// impl Engine for Stub {
///     fn backend(&self) -> BackendKind { BackendKind::Native }
///     fn capabilities(&self) -> Capabilities { Capabilities::none() }
///     fn path(&self) -> &Path { Path::new("/bin/true") }
///     fn analyze(&self) -> Result<(), String> { Ok(()) }
///     fn summary(&self) -> Result<Value, String> { Ok(json!({})) }
///     fn info(&self) -> Result<Value, String> { Ok(json!({})) }
///     fn functions(&self) -> Result<Vec<FunctionInfo>, String> {
///         Ok(vec![FunctionInfo { addr: 1, name: "main".into(), size: None, nbbs: None, edges: None, signature: None }])
///     }
///     fn function_at(&self, _a: u64) -> Result<Option<FunctionInfo>, String> { Ok(None) }
///     fn disassemble(&self, _t: &Target, _c: Option<usize>) -> Result<Disassembly, String> {
///         Ok(Disassembly { addr: 1, name: "main".into(), size: None, ops: vec![] })
///     }
///     fn function_disasm(&self, _a: u64) -> Result<Disassembly, String> {
///         Ok(Disassembly { addr: 1, name: "main".into(), size: None, ops: vec![] })
///     }
///     fn function_graph(&self, _a: u64) -> Result<FunctionGraph, String> {
///         Ok(FunctionGraph { addr: 1, name: "main".into(), blocks: vec![] })
///     }
///     fn strings(&self) -> Result<Vec<StringRef>, String> { Ok(vec![]) }
///     fn imports(&self) -> Result<Vec<Import>, String> { Ok(vec![]) }
///     fn xrefs(&self, _t: &Target, _d: XrefDirection) -> Result<Vec<Xref>, String> { Ok(vec![]) }
///     fn decompile(&self, _a: u64) -> Result<recurse_static::engine::Decompilation, String> {
///         Err("unsupported".into())
///     }
///     fn raw(&self, _c: &str) -> Result<Value, String> { Err("unsupported".into()) }
///     fn resolve(&self, _n: &str) -> Result<Option<u64>, String> { Ok(None) }
/// }
///
/// let out = execute_tool(&Stub, &json!({"op": "functions"})).unwrap();
/// let env: Value = serde_json::from_str(&out).unwrap();
/// assert_eq!(env["op"], "functions");
/// assert_eq!(env["count"], 1);
/// ```
pub fn execute_tool(engine: &dyn Engine, args: &Value) -> Result<String, String> {
    let op = args
        .get("op")
        .and_then(Value::as_str)
        .ok_or_else(|| "missing string argument 'op'".to_string())?;
    let limit = args
        .get("limit")
        .and_then(Value::as_u64)
        .map(|v| v as usize)
        .unwrap_or(DEFAULT_LIMIT)
        .clamp(1, MAX_LIMIT);
    let query = args.get("query").and_then(Value::as_str).unwrap_or("");

    match op {
        "analyze" => {
            engine.analyze()?;
            Ok(compact(json!({ "op": "analyze", "ok": true })))
        }
        "info" => {
            let info = engine.info()?;
            Ok(compact(json!({ "op": "info", "info": info })))
        }
        "functions" => {
            let all = engine.functions()?;
            let filtered: Vec<&FunctionInfo> = all
                .iter()
                .filter(|f| matches_query(query, &[f.name.as_str()]))
                .collect();
            let (kept, _) = take(&filtered, limit);
            let items = serde_json::to_value(kept).map_err(|e| e.to_string())?;
            Ok(compact(list_envelope(
                "functions",
                filtered.len(),
                items.as_array().map(Vec::len).unwrap_or(0),
                items,
            )))
        }
        "disasm" => {
            let target = required_target(args)?;
            let count = args
                .get("count")
                .and_then(Value::as_u64)
                .map(|v| v as usize);
            let dis = engine.disassemble(&target, count)?;
            let total = dis.ops.len();
            let (kept, _) = take(&dis.ops, limit);
            let mut items = serde_json::to_value(kept).map_err(|e| e.to_string())?;
            strip_bytes(&mut items);
            let mut env = list_envelope(
                "disasm",
                total,
                items.as_array().map(Vec::len).unwrap_or(0),
                items,
            );
            env["name"] = json!(dis.name);
            env["addr"] = json!(dis.addr);
            Ok(compact(env))
        }
        "graph" => {
            let addr = required_addr(engine, args)?;
            let graph = engine.function_graph(addr)?;
            let mut value = serde_json::to_value(graph).map_err(|e| e.to_string())?;
            strip_bytes(&mut value);
            Ok(compact(value))
        }
        "lift" => {
            let addr = required_addr(engine, args)?;
            if !engine.capabilities().graph {
                return Err(format!(
                    "the {} backend cannot recover a control-flow graph, which `lift` requires",
                    engine.backend().as_str()
                ));
            }
            let lifted = engine.lift(addr)?;
            Ok(compact(lifted))
        }
        "decompile" => {
            let addr = required_addr(engine, args)?;
            if !engine.capabilities().decompile {
                return Err(format!(
                    "the {} backend has no decompiler",
                    engine.backend().as_str()
                ));
            }
            let dec = engine.decompile(addr)?;
            Ok(compact(
                serde_json::to_value(dec).map_err(|e| e.to_string())?,
            ))
        }
        "xrefs" => {
            let target = required_target(args)?;
            let direction = match args.get("direction").and_then(Value::as_str) {
                Some("from") => XrefDirection::From,
                _ => XrefDirection::To,
            };
            let all = engine.xrefs(&target, direction)?;
            let filtered: Vec<&Xref> = all
                .iter()
                .filter(|x| {
                    matches_query(
                        query,
                        &[
                            x.fcn_name.as_deref().unwrap_or(""),
                            x.opcode.as_deref().unwrap_or(""),
                        ],
                    )
                })
                .collect();
            let (kept, _) = take(&filtered, limit);
            let items = serde_json::to_value(kept).map_err(|e| e.to_string())?;
            Ok(compact(list_envelope(
                "xrefs",
                filtered.len(),
                items.as_array().map(Vec::len).unwrap_or(0),
                items,
            )))
        }
        "strings" => {
            let all = engine.strings()?;
            // `addr` answers "what string is at this address?" (a common
            // question, e.g. from a `[rip+X]` operand); `query` filters by
            // content.
            let at = match args.get("addr").and_then(Target::from_json) {
                Some(Target::Addr(a)) => Some(a),
                Some(Target::Symbol(n)) => engine.resolve(&n)?,
                None => None,
            };
            let filtered: Vec<&StringRef> = all
                .iter()
                .filter(|s| {
                    matches_query(query, &[s.string.as_str()])
                        && at.is_none_or(|a| {
                            let end = s.addr.saturating_add(s.string.len() as u64 + 1);
                            a >= s.addr && a < end
                        })
                })
                .collect();
            let (kept, _) = take(&filtered, limit);
            let items = serde_json::to_value(kept).map_err(|e| e.to_string())?;
            Ok(compact(list_envelope(
                "strings",
                filtered.len(),
                items.as_array().map(Vec::len).unwrap_or(0),
                items,
            )))
        }
        "imports" => {
            let all = engine.imports()?;
            let filtered: Vec<&Import> = all
                .iter()
                .filter(|i| matches_query(query, &[i.name.as_str()]))
                .collect();
            let (kept, _) = take(&filtered, limit);
            let items = serde_json::to_value(kept).map_err(|e| e.to_string())?;
            Ok(compact(list_envelope(
                "imports",
                filtered.len(),
                items.as_array().map(Vec::len).unwrap_or(0),
                items,
            )))
        }
        "raw" => {
            if !engine.capabilities().raw {
                return Err(format!(
                    "the {} backend has no console",
                    engine.backend().as_str()
                ));
            }
            let cmd = args
                .get("cmd")
                .and_then(Value::as_str)
                .ok_or_else(|| "op `raw` requires a `cmd` string".to_string())?;
            let out = engine.raw(cmd)?;
            Ok(compact(json!({ "op": "raw", "cmd": cmd, "result": out })))
        }
        other => Err(format!("unknown op: {other}")),
    }
}

/// Parse the required `addr` argument into a [`Target`].
fn required_target(args: &Value) -> Result<Target, String> {
    args.get("addr")
        .and_then(Target::from_json)
        .ok_or_else(|| "this op requires an `addr` (number, hex string, or symbol)".to_string())
}

/// Resolve the required `addr` argument to a concrete address, using the
/// backend's symbol table for names.
fn required_addr(engine: &dyn Engine, args: &Value) -> Result<u64, String> {
    let target = required_target(args)?;
    match target {
        Target::Addr(a) => Ok(a),
        Target::Symbol(name) => engine
            .resolve(&name)?
            .ok_or_else(|| format!("could not resolve symbol `{name}`")),
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
    use super::*;
    use serde_json::json;

    #[test]
    fn backend_names_parse_and_default() {
        assert_eq!(BackendKind::parse("r2"), Some(BackendKind::R2));
        assert_eq!(BackendKind::parse("RADARE2"), Some(BackendKind::R2));
        assert_eq!(BackendKind::parse("native"), Some(BackendKind::Native));
        assert_eq!(BackendKind::parse("ida"), Some(BackendKind::Ida));
        assert_eq!(BackendKind::parse("unknown_engine"), None);
        assert_eq!(BackendKind::R2.as_str(), "r2");
        assert_eq!(BackendKind::Ida.as_str(), "ida");
    }

    #[test]
    fn default_backend_is_native() {
        assert_eq!(BackendKind::default(), BackendKind::Native);
    }

    #[test]
    fn target_parsing_accepts_all_forms() {
        assert_eq!(
            Target::from_json(&json!(0x1149)),
            Some(Target::Addr(0x1149))
        );
        assert_eq!(
            Target::from_json(&json!("0x1149")),
            Some(Target::Addr(0x1149))
        );
        assert_eq!(Target::from_json(&json!("4437")), Some(Target::Addr(4437)));
        assert_eq!(
            Target::from_json(&json!("sym.main")),
            Some(Target::Symbol("sym.main".into()))
        );
        assert_eq!(Target::from_json(&json!("   ")), None);
        assert_eq!(Target::from_json(&json!(true)), None);
    }

    #[test]
    fn schema_is_one_neutral_tool() {
        let schema = tool_schema(Capabilities::all());
        assert_eq!(schema["function"]["name"], TOOL_NAME);
        let variants = schema["function"]["parameters"]["properties"]["op"]["enum"]
            .as_array()
            .unwrap();
        for op in ["decompile", "xrefs", "functions", "raw"] {
            assert!(variants.iter().any(|v| v == op), "{op} missing");
        }
    }

    #[test]
    fn schema_hides_unsupported_ops() {
        let native = Capabilities {
            decompile: false,
            raw: false,
            graph: true,
            xrefs_from: true,
        };
        let schema = tool_schema(native);
        let ops = schema["function"]["parameters"]["properties"]["op"]["enum"]
            .as_array()
            .unwrap();
        assert!(
            !ops.iter().any(|v| v == "decompile"),
            "no decompiler -> no op"
        );
        assert!(!ops.iter().any(|v| v == "raw"), "no console -> no op");
        assert!(ops.iter().any(|v| v == "disasm"));
        let desc = schema["function"]["description"].as_str().unwrap();
        assert!(!desc.contains("decompile"));
        assert!(!desc.contains("raw"));
    }
}
