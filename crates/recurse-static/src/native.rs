//! Pure-Rust analysis backend: in-process, no external tool, no copyleft
//! dependency.
//!
//! Parsing (ELF/PE/Mach-O) comes from [`object`](https://docs.rs/object).
//! Disassembly and control-flow recovery come from
//! [`capstone`](https://docs.rs/capstone), which covers x86/x86-64, ARM,
//! AArch64, MIPS, PowerPC, RISC-V, SPARC, SystemZ, M68K, BPF and more behind
//! one API. Capstone is BSD-3-Clause, so the whole backend stays permissive.
//!
//! Scope, stated honestly:
//!
//! * Functions are discovered from the symbol table, the entry point, the
//!   unwind tables (`.eh_frame` / PE `.pdata`, one exact range per function on
//!   stripped Rust/C++/Windows binaries), a linear sweep of the code (call
//!   targets, CET pads, prologues), and the indirect targets of calls whose
//!   pointer is read from a data slot. Where none of these cover the code, a
//!   low-priority background pass (see [`NativeEngine::indexing`]) recurses
//!   through functions of unknown size to expand the index after open.
//! * Cross-references are indexed during the same sweep, so `xrefs` is a
//!   lookup over an in-memory table rather than a re-decode of the binary.
//! * Branch targets and fall-through edges are recovered from instruction
//!   details, so the CFG covers reachable code; exotic architectures whose
//!   conditionality we cannot classify exactly are treated as conditional.
//! * [`Engine::decompile`] renders C-like pseudocode via
//!   [`recurse_vtil::decompile`] (lift → optimize → structure) rather than a
//!   Hex-Rays-class decompiler — no full type/variable recovery, but total
//!   coverage (an unlifted instruction still appears, as an `__asm` line,
//!   never dropped) and real `if`/`while` structuring where the CFG shape
//!   allows it. See `docs/vtil-lift.md`.

pub mod wasm;

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use capstone::prelude::*;
use capstone::InsnGroupType;
use gimli::{BaseAddresses, CieOrFde, EhFrame, RunTimeEndian, UnwindSection};
use object::{
    Architecture, BinaryFormat, Object, ObjectKind, ObjectSection, ObjectSymbol, SectionKind,
    SymbolKind,
};
use serde_json::json;

use crate::engine::{
    BackendKind, BasicBlock, Capabilities, Decompilation, Disassembly, Engine, FunctionGraph,
    FunctionInfo, Import, Instruction, StringRef, Target, Xref, XrefDirection,
};

/// Maximum functions discovered per binary; guards recursive descent and caps
/// the background indexer's work.
const MAX_FUNCTIONS: usize = 20_000;
/// Maximum basic blocks decoded per function.
const MAX_BLOCKS: usize = 512;
/// Upper bound on how many functions' blocks the background indexer keeps warm
/// in memory; beyond this it still decodes for discovery but drops the result,
/// so a huge binary cannot blow up the cache.
const BLOCK_CACHE_MAX: usize = 8192;
/// Maximum instructions decoded for one function before decoding stops, so a
/// runaway tail-call chain cannot consume the whole pass.
const MAX_FUNCTION_INSNS: usize = 50_000;
/// Maximum instructions decoded per block.
const MAX_BLOCK_INSNS: usize = 512;
/// Bytes decoded per parallel sweep chunk. One big `.text` section is split
/// into chunks of this size so the sweep parallelizes across cores.
const SWEEP_CHUNK_BYTES: usize = 512 * 1024;
/// Total bytes the parallel sweep decodes; bounds pathological inputs.
const SWEEP_MAX_BYTES: usize = 64 * 1024 * 1024;
/// Minimum run length for a string.
const MIN_STRING_LEN: usize = 4;

/// A code or data reference found during the linear sweep, before it is shaped
/// into a canonical [`Xref`] for a specific query.
#[derive(Clone)]
struct RawRef {
    /// Instruction that carries the reference.
    from: u64,
    /// Referenced address (branch target or data slot).
    to: u64,
    /// Reference kind (`CALL`, `JMP`, `CJMP`, `DATA`).
    kind: String,
    /// Text of the referring instruction.
    opcode: String,
}

/// Mutable analysis state, guarded by a mutex because [`Engine`] methods take
/// `&self`.
struct NativeState {
    /// Whether recursive-descent discovery has run.
    analyzed: bool,
    /// Discovered functions, keyed by entry address for stable ordering.
    functions: BTreeMap<u64, FunctionInfo>,
    /// Decoded basic blocks per function entry, cached across queries.
    blocks: HashMap<u64, Vec<BasicBlock>>,
    /// Names + strings for disassembly annotation, built once after discovery.
    labels: Option<Labels>,
    /// Cached string scan (`strings()` and annotation share it).
    strings: Option<Vec<StringRef>>,
    /// Functions whose bounds came from an unwind table (`.eh_frame`/
    /// `.pdata`). The background indexer skips these — their extent is already
    /// exact, so it only needs to recurse into functions of unknown size.
    fde_sized: HashSet<u64>,
    /// Analyst name overrides (`address -> name`), applied over the discovered
    /// names in listings, lookup, and annotation.
    renames: HashMap<u64, String>,
    /// Every code and data reference seen by the linear sweep, sorted by source
    /// address. Built once so a cross-reference query never has to re-decode
    /// the binary (which would stall the UI on a large target).
    xrefs: Vec<RawRef>,
    /// Referenced address -> indexes into [`NativeState::xrefs`], so a
    /// `xrefs to X` is a hash lookup instead of a full decode.
    xrefs_by_target: HashMap<u64, Vec<u32>>,
    /// True while the background indexer is still expanding the function set.
    indexing: bool,
}

/// Address indexes used to annotate disassembly with names.
#[derive(Default)]
struct Labels {
    /// address -> best-known name (symbol, imported GOT slot, function).
    names: HashMap<u64, String>,
    /// string vaddr -> text.
    strings: HashMap<u64, String>,
}

impl NativeState {
    fn new() -> Self {
        Self {
            analyzed: false,
            functions: BTreeMap::new(),
            blocks: HashMap::new(),
            labels: None,
            strings: None,
            fde_sized: HashSet::new(),
            renames: HashMap::new(),
            xrefs: Vec::new(),
            xrefs_by_target: HashMap::new(),
            indexing: false,
        }
    }
}

/// Build a Capstone disassembler configured for the object file's CPU, mode
/// and endianness. Capstone handles every architecture it supports uniformly,
/// Build a Capstone disassembler for the object's architecture (the single
/// switch on architecture lives in [`crate::arch`]).
fn build_capstone(file: &object::File<'_>) -> Result<Capstone, String> {
    crate::arch::Arch::from_file(file).capstone()
}

/// 32-bit ARM code addresses carry the Thumb bit in bit 0; clear it before
/// comparing or decoding.
fn code_addr(file: &object::File<'_>, addr: u64) -> u64 {
    if file.architecture() == Architecture::Arm {
        addr & !1
    } else {
        addr
    }
}

/// Open a target, detecting its container format and returning the matching
/// in-process engine. Native object formats (ELF/PE/Mach-O/COFF) go through the
/// [`NativeEngine`]; structured bytecodes route to their own decoders.
///
/// ```no_run
/// use recurse_static::native::open;
/// let engine = open(std::path::Path::new("/bin/true")).unwrap();
/// let _ = engine.summary().unwrap();
/// ```
pub fn open(path: &Path) -> Result<Box<dyn Engine>, String> {
    let mut magic = [0u8; 4];
    let read = std::fs::File::open(path)
        .and_then(|mut f| std::io::Read::read(&mut f, &mut magic))
        .map_err(|e| format!("read {}: {e}", path.display()))?;
    if read >= 4 && wasm::is_wasm(&magic) {
        return Ok(Box::new(wasm::WasmEngine::open(path)?));
    }
    Ok(Box::new(NativeEngine::open(path)?))
}

/// When `data` is a universal (fat) Mach-O, return the slice for the preferred
/// architecture — x86-64, then x86, else the first — so the object engine can
/// parse it. `None` for thin files (or anything that is not fat Mach-O).
fn macho_slice(data: &[u8]) -> Option<Vec<u8>> {
    use object::read::macho::{FatArch, MachOFatFile32, MachOFatFile64};
    let arches: Vec<(Architecture, u64, u64)> = if let Ok(fat) = MachOFatFile32::parse(data) {
        fat.arches()
            .iter()
            .map(|a| (a.architecture(), arch_word(a.offset()), arch_word(a.size())))
            .collect()
    } else if let Ok(fat) = MachOFatFile64::parse(data) {
        fat.arches()
            .iter()
            .map(|a| (a.architecture(), arch_word(a.offset()), arch_word(a.size())))
            .collect()
    } else {
        return None;
    };
    let (_, offset, size) = arches
        .iter()
        .find(|(a, _, _)| *a == Architecture::X86_64)
        .or_else(|| arches.iter().find(|(a, _, _)| *a == Architecture::I386))
        .or_else(|| arches.first())?;
    let start = *offset as usize;
    let end = start.checked_add(*size as usize)?;
    data.get(start..end).map(<[u8]>::to_vec)
}

/// Widen a fat-arch word (32- or 64-bit) to `u64` without a same-type
/// conversion lint.
fn arch_word<T: Into<u64>>(word: T) -> u64 {
    word.into()
}

/// The in-process [`Engine`] implementation.
pub struct NativeEngine {
    data: Arc<Vec<u8>>,
    path: PathBuf,
    state: Arc<Mutex<NativeState>>,
    /// Set on drop to stop the background indexer promptly.
    cancel: Arc<AtomicBool>,
}

impl NativeEngine {
    /// Read `path` into memory and prepare the backend. Parsing is deferred to
    /// each query, so opening a large binary is a single read.
    ///
    /// ```
    /// use recurse_static::native::NativeEngine;
    /// use recurse_static::engine::Engine;
    /// let path = std::env::current_exe().unwrap();
    /// let e = NativeEngine::open(&path).unwrap();
    /// assert!(e.summary().unwrap()["function_count"].as_u64().unwrap() >= 0);
    /// ```
    pub fn open(path: &Path) -> Result<Self, String> {
        let mut data = std::fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
        // Universal (fat) Mach-O: analyse one architecture's slice.
        if let Some(slice) = macho_slice(&data) {
            data = slice;
        }
        // Fail fast on non-objects; every later query then only fails on odd
        // sections, not on a fundamentally unparsable file.
        object::File::parse(&*data).map_err(|e| format!("not a recognised binary: {e}"))?;
        Ok(Self {
            data: Arc::new(data),
            path: path.to_path_buf(),
            state: Arc::new(Mutex::new(NativeState::new())),
            cancel: Arc::new(AtomicBool::new(false)),
        })
    }

    /// Parse the in-memory image.
    fn parse(&self) -> Result<object::File<'_>, String> {
        object::File::parse(&self.data[..]).map_err(|e| format!("parse failed: {e}"))
    }

    /// True when `addr` falls inside an executable section.
    fn in_text(file: &object::File<'_>, addr: u64) -> bool {
        file.sections().any(|s| {
            s.kind() == SectionKind::Text
                && addr >= s.address()
                && addr < s.address().saturating_add(s.size())
        })
    }

    /// Return the executable section containing `addr`.
    fn text_section<'f>(file: &'f object::File<'f>, addr: u64) -> Option<object::Section<'f, 'f>> {
        file.sections().find(|s| {
            s.kind() == SectionKind::Text
                && addr >= s.address()
                && addr < s.address().saturating_add(s.size())
        })
    }

    /// Decode up to `count` instructions linearly from `addr`.
    fn decode_linear(&self, addr: u64, count: usize) -> Result<Vec<Instruction>, String> {
        let file = self.parse()?;
        let cs = build_capstone(&file)?;
        let addr = code_addr(&file, addr);
        let section = Self::text_section(&file, addr).ok_or_else(|| missing_code(addr))?;
        let data = section.data().map_err(|e| e.to_string())?;
        let offset = (addr - section.address()) as usize;
        if offset >= data.len() {
            return Err(format!("{addr:#x} is past the end of its section"));
        }
        Ok(decode_with(
            &cs,
            &data[offset..],
            addr,
            count.max(1),
            false,
            true,
        ))
    }

    /// Decode the basic blocks of the function at `func_addr`, caching the
    /// result. Starts from the entry and follows branch edges within the
    /// executable sections.
    fn blocks_for(&self, func_addr: u64) -> Result<Vec<BasicBlock>, String> {
        {
            let state = self
                .state
                .lock()
                .map_err(|e| format!("native state poisoned: {e}"))?;
            if let Some(b) = state.blocks.get(&func_addr) {
                return Ok(b.clone());
            }
        }
        let file = self.parse()?;
        let cs = build_capstone(&file)?;
        let blocks = decode_blocks(&file, &cs, func_addr)?;
        let mut state = self
            .state
            .lock()
            .map_err(|e| format!("native state poisoned: {e}"))?;
        state.blocks.insert(func_addr, blocks.clone());
        Ok(blocks)
    }

    /// Run discovery: seed from symbols + entry, then follow direct call
    /// targets. Idempotent.
    /// Run discovery: seed from symbols, the entry point, and a linear sweep of
    /// the text sections, then assign names and sizes. Block decoding is lazy
    /// (see [`NativeEngine::blocks_for`]) so this stays fast on large binaries.
    fn discover(&self) -> Result<(), String> {
        {
            let state = self
                .state
                .lock()
                .map_err(|e| format!("native state poisoned: {e}"))?;
            if state.analyzed {
                return Ok(());
            }
        }
        let file = self.parse()?;
        let cs = build_capstone(&file)?;
        let got = import_got_labels(&file);

        let mut functions: BTreeMap<u64, FunctionInfo> = BTreeMap::new();
        // Named seeds first: they carry the real symbol names.
        for sym in file.symbols().chain(file.dynamic_symbols()) {
            if sym.kind() != SymbolKind::Text || sym.address() == 0 || !sym.is_definition() {
                continue;
            }
            if let Ok(name) = sym.name() {
                add_function(&mut functions, &file, sym.address(), shorten_name(name));
            }
        }
        let entry = code_addr(&file, file.entry());
        if entry != 0 && NativeEngine::in_text(&file, entry) {
            add_function(&mut functions, &file, entry, "entry0".to_string());
            // Stripped binaries often expose only the entry, which passes `main`
            // to libc as a pointer rather than calling it directly.
            if let Some(main) = entry_main_seed(&file, &cs, entry) {
                add_function(&mut functions, &file, main, "main".to_string());
            }
        }
        // A linear sweep adds every direct call target, CET landing pad, and
        // classic prologue as a function entry, and records every code and
        // data reference it decodes for the cross-reference index.
        let Sweep { seeds, mut refs } = sweep(&file);
        for seed in seeds {
            if functions.contains_key(&seed) {
                continue;
            }
            let name = plt_name_at(&file, &cs, seed, &got)
                .map(|imported| format!("imp.{imported}"))
                .unwrap_or_else(|| format!("fcn_{seed:x}"));
            add_function(&mut functions, &file, seed, name);
        }
        // Unwind tables recover the exact bounds of every function that can
        // unwind — most of a stripped Rust/C++ binary's code — so this is what
        // brings the function list close to a full analysis engine on a
        // symbol-free target.
        let mut fde_sized: HashSet<u64> = HashSet::new();
        let mut fde_sizes: Vec<(u64, u64)> = Vec::new();
        for (start, len) in eh_frame_functions(&file)
            .into_iter()
            .chain(pdata_functions(&file))
        {
            fde_sized.insert(start);
            fde_sizes.push((start, len));
            if functions.contains_key(&start) {
                continue;
            }
            let name = plt_name_at(&file, &cs, start, &got)
                .map(|imported| format!("imp.{imported}"))
                .unwrap_or_else(|| format!("fcn_{start:x}"));
            add_function(&mut functions, &file, start, name);
        }
        // Keep the lowest-addressed functions when a huge binary overflows.
        if functions.len() > MAX_FUNCTIONS {
            let keep: BTreeSet<u64> = functions.keys().copied().take(MAX_FUNCTIONS).collect();
            functions.retain(|addr, _| keep.contains(addr));
        }
        // Sizes from the sorted neighbour addresses, then exact unwind bounds
        // where the unwind table knows them.
        assign_sizes(&mut functions, &file);
        for (start, len) in &fde_sizes {
            if let Some(f) = functions.get_mut(start) {
                f.size = Some(*len);
            }
        }

        refs.sort_by_key(|r| r.from);
        refs.dedup_by(|a, b| a.from == b.from && a.to == b.to && a.kind == b.kind);
        let mut xrefs_by_target: HashMap<u64, Vec<u32>> = HashMap::new();
        for (i, r) in refs.iter().enumerate() {
            xrefs_by_target.entry(r.to).or_default().push(i as u32);
        }
        {
            let mut state = self
                .state
                .lock()
                .map_err(|e| format!("native state poisoned: {e}"))?;
            state.functions = functions;
            state.xrefs = refs;
            state.xrefs_by_target = xrefs_by_target;
            state.fde_sized = fde_sized;
            state.analyzed = true;
            state.indexing = true;
        }
        self.spawn_indexer();
        Ok(())
    }

    /// Expand the function index on a background thread: decode each function's
    /// blocks (warming the cache the UI reads), promote any code targets they
    /// reference that the sweep missed into functions, and recompute sizes.
    /// Clears the `indexing` flag when done, or when the engine is dropped.
    fn spawn_indexer(&self) {
        let data = Arc::clone(&self.data);
        let state = Arc::clone(&self.state);
        let cancel = Arc::clone(&self.cancel);
        std::thread::spawn(move || background_index(data, state, cancel));
    }

    /// Build the UI-shaped `info` object.
    fn info_value(&self, file: &object::File<'_>) -> serde_json::Value {
        let arch = arch_name(file.architecture());
        let bits = arch_bits(file.architecture()).unwrap_or(0);
        let kind = format_name(file.format());
        let endian = if file.is_little_endian() {
            "little"
        } else {
            "big"
        };
        json!({
            "bin": {
                "arch": arch,
                "bits": bits,
                "type": kind,
                "bintype": kind,
                "os": std::env::consts::OS,
                "endian": endian,
                "stripped": file.symbols().next().is_none(),
                "class": format!("{kind}{bits}"),
                "entry": file.entry(),
            },
            "core": { "type": object_kind_name(file.kind()) },
        })
    }

    /// Self-contained hardening report (the checksec-style fields), computed
    /// from the object itself — no external tool is invoked.
    fn checksec(&self, file: &object::File<'_>) -> serde_json::Value {
        let imports: Vec<String> = file
            .imports()
            .map(|it| {
                it.into_iter()
                    .map(|i| String::from_utf8_lossy(i.name()).into_owned())
                    .collect::<Vec<String>>()
            })
            .unwrap_or_default();
        let canary = imports.iter().any(|n| n == "__stack_chk_fail");
        let fortified = imports
            .iter()
            .filter(|n| n.ends_with("_chk") && n.as_str() != "__stack_chk_fail")
            .count();
        let fortifiable = imports
            .iter()
            .filter(|n| FORTIFIABLE.contains(&n.as_str()))
            .count();
        let (relro, pie, nx, rpath, runpath) = if file.format() == BinaryFormat::Elf {
            self.elf_hardening()
        } else {
            (
                "N/A".to_string(),
                if matches!(file.kind(), ObjectKind::Dynamic) {
                    "PIE enabled".to_string()
                } else {
                    "No PIE".to_string()
                },
                "unknown".to_string(),
                "No RPATH".to_string(),
                "No RUNPATH".to_string(),
            )
        };
        json!({
            "relro": relro,
            "canary": if canary { "Canary found" } else { "No canary found" },
            "nx": nx,
            "pie": pie,
            "rpath": rpath,
            "runpath": runpath,
            "fortify": if fortified > 0 { "Yes" } else { "No" },
            "fortified": fortified,
            "fortifiable": fortifiable,
        })
    }

    /// RELRO / PIE / NX / RPATH / RUNPATH from the ELF program headers and
    /// `.dynamic` entries.
    fn elf_hardening(&self) -> (String, String, String, String, String) {
        let data = &self.data[..];
        if let Ok(elf) = object::read::elf::ElfFile64::<object::Endianness>::parse(data) {
            return elf_checksec(&elf);
        }
        if let Ok(elf) = object::read::elf::ElfFile32::<object::Endianness>::parse(data) {
            return elf_checksec(&elf);
        }
        (
            "N/A".into(),
            "unknown".into(),
            "unknown".into(),
            "No RPATH".into(),
            "No RUNPATH".into(),
        )
    }

    /// Build the name/string index once (after discovery).
    fn ensure_labels(&self) -> Result<(), String> {
        {
            let state = self
                .state
                .lock()
                .map_err(|e| format!("native state poisoned: {e}"))?;
            if state.labels.is_some() {
                return Ok(());
            }
        }
        self.discover()?;
        let file = self.parse()?;
        let strings = scan_all_strings(&file);
        let mut names: HashMap<u64, String> = HashMap::new();
        for sym in file.symbols().chain(file.dynamic_symbols()) {
            if sym.address() == 0 {
                continue;
            }
            if let Ok(name) = sym.name() {
                if !name.is_empty() {
                    names
                        .entry(sym.address())
                        .or_insert_with(|| shorten_name(name));
                }
            }
        }
        for (addr, name) in import_got_labels(&file) {
            names.insert(addr, name);
        }
        let mut state = self
            .state
            .lock()
            .map_err(|e| format!("native state poisoned: {e}"))?;
        // Discovered function names are the friendliest, so they win.
        for f in state.functions.values() {
            names.insert(f.addr, f.name.clone());
        }
        // Analyst renames win over everything else.
        for (addr, name) in &state.renames {
            names.insert(*addr, name.clone());
        }
        let string_map = strings.iter().map(|s| (s.addr, s.string.clone())).collect();
        state.labels = Some(Labels {
            names,
            strings: string_map,
        });
        state.strings = Some(strings);
        Ok(())
    }

    /// Append `; name` / `; "string"` comments to `ops`, so the model does not
    /// have to cross-reference addresses by hand.
    fn annotate_ops(&self, ops: &mut [Instruction]) {
        if self.ensure_labels().is_err() {
            return;
        }
        let Ok(state) = self.state.lock() else {
            return;
        };
        let Some(labels) = state.labels.as_ref() else {
            return;
        };
        for op in ops.iter_mut() {
            let mut comment: Option<String> = op.jump.and_then(|t| labels.names.get(&t).cloned());
            if comment.is_none() {
                for ea in memory_references(op) {
                    if let Some(name) = labels.names.get(&ea) {
                        comment = Some(name.clone());
                        break;
                    }
                    if let Some(text) = labels.strings.get(&ea) {
                        comment = Some(format!("\"{}\"", truncate_str(text, 48)));
                        break;
                    }
                }
            }
            if let Some(c) = comment {
                op.disasm = format!("{} ; {}", op.disasm, c);
            }
        }
    }
}

/// Decode up to `max` instructions from a byte slice that begins at `ip`.
/// When `stop_at_terminator` is set, decoding stops *after* the first
/// instruction that ends a basic block (jump, conditional jump, return, trap).
///
/// Decoding is batched: Capstone honours a count by decoding that many
/// instructions up front, so asking for the whole cap (4096) just to stop at
/// the first branch wasted most of the work on large binaries. Small batches
/// plus an early return keep the cost proportional to the block length.
fn decode_with(
    cs: &Capstone,
    bytes: &[u8],
    ip: u64,
    max: usize,
    stop_at_terminator: bool,
    format: bool,
) -> Vec<Instruction> {
    /// Instructions requested per Capstone call.
    const BATCH: usize = 32;

    let mut out: Vec<Instruction> = Vec::new();
    let mut cursor = 0usize;
    while cursor < bytes.len() && out.len() < max {
        let want = BATCH.min(max - out.len());
        let Ok(insns) = cs.disasm_count(&bytes[cursor..], ip + cursor as u64, want) else {
            break;
        };
        if insns.is_empty() {
            break;
        }
        let exhausted = insns.len() < want;
        let mut consumed = 0usize;
        for insn in insns.iter() {
            let (kind, jump, fail) = classify(cs, insn);
            let terminator = matches!(
                kind.as_deref(),
                Some("jmp") | Some("cjmp") | Some("ret") | Some("int")
            );
            consumed += insn.bytes().len();
            out.push(Instruction {
                addr: insn.address(),
                disasm: if format {
                    format_insn(insn)
                } else {
                    // Cheap text (mnemonic + operands) for scans that only need
                    // to recognise call/prologue mnemonics, not formatted asm.
                    format!(
                        "{} {}",
                        insn.mnemonic().unwrap_or(""),
                        insn.op_str().unwrap_or("")
                    )
                    .trim_end()
                    .to_string()
                },
                bytes: Some(hex_bytes(insn.bytes())),
                kind,
                jump,
                fail,
                len: insn.bytes().len() as u32,
            });
            if (stop_at_terminator && terminator) || out.len() >= max {
                return out;
            }
        }
        cursor += consumed;
        if exhausted {
            break;
        }
    }
    out
}

/// Recover the basic blocks of the function at `func_addr` by following
/// branch and fall-through edges. Pure over the parsed file and Capstone
/// handle, so callers share one handle across many functions.
/// Executable address ranges, computed once so hot paths can test membership
/// without rescanning every section per instruction.
fn text_ranges(file: &object::File<'_>) -> Vec<(u64, u64)> {
    file.sections()
        .filter(|s| s.kind() == SectionKind::Text)
        .map(|s| (s.address(), s.address().saturating_add(s.size())))
        .collect()
}

/// True when `addr` is inside an executable range from [`text_ranges`].
fn in_text_ranges(ranges: &[(u64, u64)], addr: u64) -> bool {
    ranges.iter().any(|(lo, hi)| addr >= *lo && addr < *hi)
}

/// Data section address ranges.
fn data_ranges(file: &object::File<'_>) -> Vec<(u64, u64)> {
    file.sections()
        .filter(|s| {
            matches!(
                s.kind(),
                SectionKind::Data | SectionKind::ReadOnlyData | SectionKind::UninitializedData
            )
        })
        .map(|s| (s.address(), s.address().saturating_add(s.size())))
        .collect()
}

/// True when `addr` is inside a data range from [`data_ranges`].
fn in_data_ranges(ranges: &[(u64, u64)], addr: u64) -> bool {
    ranges.iter().any(|(lo, hi)| addr >= *lo && addr < *hi)
}

/// Name of the function containing `addr`, from the current state. Used by
/// cross-reference queries, which already hold the state lock.
fn fcn_name_at(state: &NativeState, addr: u64) -> Option<String> {
    let (_, f) = state.functions.range(..=addr).next_back()?;
    let contains = f
        .size
        .map_or(addr == f.addr, |s| addr < f.addr.saturating_add(s));
    contains.then(|| {
        state
            .renames
            .get(&f.addr)
            .cloned()
            .unwrap_or_else(|| f.name.clone())
    })
}

fn decode_blocks(
    file: &object::File<'_>,
    cs: &Capstone,
    func_addr: u64,
) -> Result<Vec<BasicBlock>, String> {
    let func_addr = code_addr(file, func_addr);
    let section =
        NativeEngine::text_section(file, func_addr).ok_or_else(|| missing_code(func_addr))?;
    let data = section.data().map_err(|e| e.to_string())?;
    let base = section.address();
    let text = text_ranges(file);
    let mut visited: HashSet<u64> = HashSet::new();
    let mut queue: VecDeque<u64> = VecDeque::new();
    let mut blocks: Vec<BasicBlock> = Vec::new();
    // Blocks already examined by the switch post-pass, so it never rescans.
    let mut scanned: HashSet<u64> = HashSet::new();
    let mut insn_budget = MAX_FUNCTION_INSNS;
    queue.push_back(func_addr);

    loop {
        while let Some(start) = queue.pop_front() {
            if !visited.insert(start) || blocks.len() >= MAX_BLOCKS {
                continue;
            }
            if start < base || start >= base.saturating_add(data.len() as u64) {
                continue;
            }
            let offset = (start - base) as usize;
            let mut ops = decode_with(cs, &data[offset..], start, MAX_BLOCK_INSNS, true, true);
            if ops.is_empty() {
                continue;
            }
            insn_budget = insn_budget.saturating_sub(ops.len());
            // Follow indirect calls/jumps through data slots to their target,
            // so a tail call or function-pointer dispatch becomes an edge and a
            // cross-reference instead of a dead end.
            for op in ops.iter_mut() {
                if op.jump.is_none() && matches!(op.kind.as_deref(), Some("call") | Some("jmp")) {
                    if let Some(target) = resolve_indirect(file, &text, op) {
                        op.jump = Some(target);
                    }
                }
            }
            let Some(last) = ops.last() else {
                continue;
            };
            let (jump, fail) = match last.kind.as_deref() {
                Some("cjmp") => (last.jump, last.fail),
                _ => (last.jump, None),
            };
            // An indexed-memory jump table is fully described by the one
            // instruction, so it can be resolved immediately.
            let targets = if jump.is_none() && last.kind.as_deref() == Some("jmp") {
                jump_table_targets(file, &text, &ops, last)
            } else {
                Vec::new()
            };
            let successors = jump
                .into_iter()
                .chain(fail)
                .chain(targets.iter().copied())
                .filter(|t| in_text_ranges(&text, *t));
            for target in successors {
                queue.push_back(target);
            }
            blocks.push(BasicBlock {
                addr: start,
                ninstr: ops.len() as u64,
                jump,
                fail,
                targets,
                ops,
            });
        }

        // Second pass: a computed `jmp reg` is often its own block, separate
        // from the table setup that precedes it. Search a bounded window of the
        // function's preceding ops for the switch idiom. Each block is examined
        // once and the window is a slice (no per-block clone), so this is linear
        // in the block count rather than quadratic.
        blocks.sort_by_key(|b| b.addr);
        // Only build the flat op view when some block ends in a computed jump;
        // otherwise there is nothing for the switch matcher to do.
        let has_indirect = blocks.iter().any(|b| {
            b.ops
                .last()
                .is_some_and(|o| o.kind.as_deref() == Some("jmp") && o.jump.is_none())
        });
        if !has_indirect {
            break;
        }
        let mut flat: Vec<Instruction> =
            blocks.iter().flat_map(|b| b.ops.iter().cloned()).collect();
        flat.sort_by_key(|o| o.addr);
        let mut found: Vec<(usize, Vec<u64>)> = Vec::new();
        let mut discovered = false;
        for (i, block) in blocks.iter().enumerate() {
            if !scanned.insert(block.addr) || !block.targets.is_empty() {
                continue;
            }
            let Some(last) = block.ops.last() else {
                continue;
            };
            if !(last.kind.as_deref() == Some("jmp") && last.jump.is_none()) {
                continue;
            }
            let targets = switch_targets(file, &text, lookback(&flat, last.addr, 64));
            if targets.is_empty() {
                continue;
            }
            for target in targets.iter().filter(|t| in_text_ranges(&text, **t)) {
                if !visited.contains(target) {
                    queue.push_back(*target);
                    discovered = true;
                }
            }
            found.push((i, targets));
        }
        for (i, targets) in found {
            blocks[i].targets = targets;
        }
        if !discovered {
            break;
        }
    }
    blocks.sort_by_key(|b| b.addr);
    Ok(blocks)
}

/// Result of the linear sweep: function-entry seeds plus every code and data
/// reference seen while decoding.
struct Sweep {
    /// Function-entry candidates (call targets, CET pads, classic prologues).
    seeds: Vec<u64>,
    /// Every code/data reference seen, in sweep order.
    refs: Vec<RawRef>,
}

/// Decode the executable sections linearly and collect function-entry seeds
/// (every direct call target, plus CET landing pads and classic `push rbp; mov
/// rbp, rsp` prologues) and every code/data reference. A bounded, cheap
/// complement to recursive descent: it finds functions the call graph alone
/// misses (indirect-only callers, no symbols) and builds the cross-reference
/// index without a second pass over the code.
fn sweep(file: &object::File<'_>) -> Sweep {
    let text = text_ranges(file);
    let data = data_ranges(file);
    // Split every executable section into fixed-size chunks so a single large
    // `.text` still parallelizes. A chunk that starts mid-instruction only
    // perturbs the few instructions at its head, and the seeds it yields are
    // merged with (and deduplicated against) the symbol and unwind sources.
    let mut chunks: Vec<(u64, &[u8])> = Vec::new();
    let mut budget = SWEEP_MAX_BYTES;
    for section in file.sections() {
        if budget == 0 {
            break;
        }
        if section.kind() != SectionKind::Text {
            continue;
        }
        let Ok(bytes) = section.data() else {
            continue;
        };
        if bytes.is_empty() {
            continue;
        }
        let base = section.address();
        for (i, chunk) in bytes.chunks(SWEEP_CHUNK_BYTES).enumerate() {
            if chunk.len() > budget {
                break;
            }
            budget -= chunk.len();
            chunks.push((base + (i * SWEEP_CHUNK_BYTES) as u64, chunk));
        }
    }
    if chunks.is_empty() {
        return Sweep {
            seeds: Vec::new(),
            refs: Vec::new(),
        };
    }
    // One worker per core (bounded by the chunk count); each decodes its own
    // group with a private disassembler. Capstone handles are not shareable, so
    // there is no shared mutable state and no locking on the hot path.
    let workers = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1)
        .min(chunks.len())
        .max(1);
    let per = chunks.len().div_ceil(workers);
    let mut seeds: Vec<u64> = Vec::new();
    let mut refs: Vec<RawRef> = Vec::new();
    std::thread::scope(|scope| {
        let handles: Vec<_> = chunks
            .chunks(per)
            .map(|group| scope.spawn(|| sweep_chunks(file, group, &text, &data)))
            .collect();
        for handle in handles {
            if let Ok((mut s, mut r)) = handle.join() {
                seeds.append(&mut s);
                refs.append(&mut r);
            }
        }
    });
    Sweep { seeds, refs }
}

/// Decode one group of sweep chunks, returning its function-entry seeds and
/// code/data references. Each worker builds its own [`Capstone`], so the only
/// sharing between workers is read-only (`file`, the section ranges).
fn sweep_chunks(
    file: &object::File<'_>,
    group: &[(u64, &[u8])],
    text: &[(u64, u64)],
    data: &[(u64, u64)],
) -> (Vec<u64>, Vec<RawRef>) {
    let mut seeds = Vec::new();
    let mut refs = Vec::new();
    let Ok(cs) = build_capstone(file) else {
        return (seeds, refs);
    };
    for (addr, bytes) in group {
        let ops = decode_with(&cs, bytes, *addr, bytes.len().max(1), false, false);
        for (i, op) in ops.iter().enumerate() {
            // Direct branch target, or an indirect call/jump resolved through
            // its data slot (GOT slot, ifunc stub, function-pointer table).
            let branch = op.jump.or_else(|| {
                matches!(
                    op.kind.as_deref(),
                    Some("call") | Some("icall") | Some("jmp") | Some("ijmp")
                )
                .then(|| resolve_indirect(file, text, op))
                .flatten()
            });
            if let Some(to) = branch {
                if in_text_ranges(text, to) {
                    refs.push(RawRef {
                        from: op.addr,
                        to,
                        kind: branch_kind(op),
                        opcode: op.disasm.clone(),
                    });
                    if matches!(op.kind.as_deref(), Some("call") | Some("icall")) {
                        seeds.push(to);
                    }
                }
            }
            for to in memory_references(op) {
                if in_data_ranges(data, to) {
                    refs.push(RawRef {
                        from: op.addr,
                        to,
                        kind: "DATA".into(),
                        opcode: op.disasm.clone(),
                    });
                }
            }
            let is_entry = op.disasm.starts_with("endbr64")
                || op.disasm.starts_with("endbr32")
                || (op.disasm == "push rbp"
                    && ops
                        .get(i + 1)
                        .is_some_and(|n| n.disasm.starts_with("mov rbp, rsp")));
            if is_entry {
                seeds.push(op.addr);
            }
        }
    }
    (seeds, refs)
}

/// Map every imported GOT slot to its (demangled) name, from dynamic
/// relocations. This is what turns `call qword ptr [rip + 0x2fe2]` into
/// `... ; __libc_start_main`, and lets PLT stubs be named.
fn import_got_labels(file: &object::File<'_>) -> HashMap<u64, String> {
    // Dynamic relocations index `.dynsym` directly (`SymbolIndex(1)` is the
    // first entry yielded by `dynamic_symbols()`), so build index -> name.
    let mut dyn_names: HashMap<usize, String> = HashMap::new();
    for (i, sym) in file.dynamic_symbols().enumerate() {
        if let Ok(name) = sym.name() {
            if !name.is_empty() {
                dyn_names.insert(i + 1, shorten_name(name));
            }
        }
    }
    let mut out = HashMap::new();
    if let Some(iter) = file.dynamic_relocations() {
        for (addr, rel) in iter {
            if let object::RelocationTarget::Symbol(index) = rel.target() {
                if let Some(name) = dyn_names.get(&index.0) {
                    out.insert(addr, name.clone());
                }
            }
        }
    }
    out
}

/// If the first instruction is an indirect jump through a known GOT slot, the
/// block is a PLT stub; return the imported name it forwards to.
fn plt_import_name(ops: &[Instruction], got: &HashMap<u64, String>) -> Option<String> {
    let first = ops.first()?;
    if first.kind.as_deref() != Some("jmp") {
        return None;
    }
    memory_references(first)
        .into_iter()
        .find_map(|ea| got.get(&ea).cloned())
}

/// Name a forwarding stub: decode one instruction at `addr` and, if it is an
/// indirect jump through a known imported slot, return the import name.
fn plt_name_at(
    file: &object::File<'_>,
    cs: &Capstone,
    addr: u64,
    got: &HashMap<u64, String>,
) -> Option<String> {
    let section = NativeEngine::text_section(file, addr)?;
    let data = section.data().ok()?;
    let off = (addr - section.address()) as usize;
    if off >= data.len() {
        return None;
    }
    let ops = decode_with(cs, &data[off..], addr, 1, false, false);
    plt_import_name(&ops, got)
}

/// Add `addr` (mapping a name) to the function map, skipping non-code.
fn add_function(
    functions: &mut BTreeMap<u64, FunctionInfo>,
    file: &object::File<'_>,
    addr: u64,
    name: String,
) {
    let addr = code_addr(file, addr);
    if addr == 0 || !NativeEngine::in_text(file, addr) {
        return;
    }
    functions.entry(addr).or_insert(FunctionInfo {
        addr,
        name,
        size: None,
        nbbs: None,
        edges: None,
        signature: None,
    });
}

/// Assign each function a size from the next function's address, bounded by the
/// end of its section.
fn assign_sizes(functions: &mut BTreeMap<u64, FunctionInfo>, file: &object::File<'_>) {
    let addrs: Vec<u64> = functions.keys().copied().collect();
    for (i, addr) in addrs.iter().enumerate() {
        let end = addrs
            .get(i + 1)
            .copied()
            .or_else(|| {
                NativeEngine::text_section(file, *addr)
                    .map(|s| s.address().saturating_add(s.size()))
            })
            .unwrap_or(*addr);
        if let Some(f) = functions.get_mut(addr) {
            f.size = Some(end.saturating_sub(*addr));
        }
    }
}

/// Function boundaries recovered from the unwind tables (`.eh_frame`, or
/// `__eh_frame` on Mach-O). Every function that can unwind has a Frame
/// Description Entry carrying its exact start and length, so this recovers
/// boundaries on stripped binaries — e.g. Rust and C++ binaries, which always
/// emit unwind data. Each returned pair is `(start, len)` in executable code.
fn eh_frame_functions(file: &object::File<'_>) -> Vec<(u64, u64)> {
    let mut out = Vec::new();
    let Some(section) = file
        .sections()
        .find(|s| matches!(s.name(), Ok(".eh_frame") | Ok("__eh_frame")))
    else {
        return out;
    };
    let Ok(data) = section.data() else {
        return out;
    };
    let endian = if file.is_little_endian() {
        RunTimeEndian::Little
    } else {
        RunTimeEndian::Big
    };
    let mut eh_frame = EhFrame::new(data, endian);
    eh_frame.set_address_size(if file.is_64() { 8 } else { 4 });
    let bases = BaseAddresses::default().set_eh_frame(section.address());
    let text = text_ranges(file);
    let mut entries = eh_frame.entries(&bases);
    loop {
        match entries.next() {
            Ok(Some(CieOrFde::Fde(partial))) => {
                // One CIE per FDE group; parse it on demand.
                let parsed =
                    partial.parse(|section, bases, offset| section.cie_from_offset(bases, offset));
                if let Ok(fde) = parsed {
                    let start = fde.initial_address();
                    let len = fde.len();
                    if len > 0 && in_text_ranges(&text, start) {
                        out.push((start, len));
                    }
                }
            }
            Ok(Some(CieOrFde::Cie(_))) => {}
            Ok(None) | Err(_) => break,
        }
    }
    out
}

/// Function boundaries from a PE exception table (`.pdata`). Each x64
/// `RUNTIME_FUNCTION` holds begin/end RVAs; ARM64 packs two per 8 bytes. Covers
/// Windows binaries, which have no `.eh_frame`.
fn pdata_functions(file: &object::File<'_>) -> Vec<(u64, u64)> {
    let mut out = Vec::new();
    if file.format() != BinaryFormat::Pe {
        return out;
    }
    let Some(section) = file.sections().find(|s| matches!(s.name(), Ok(".pdata"))) else {
        return out;
    };
    let Ok(data) = section.data() else {
        return out;
    };
    let base = file.relative_address_base();
    let text = text_ranges(file);
    // x64 entries are 12 bytes (begin, end, unwind info); ARM64 are 8.
    let entry = if file.architecture() == Architecture::Aarch64 {
        8
    } else {
        12
    };
    for chunk in data.chunks_exact(entry) {
        let Ok(begin) = <[u8; 4]>::try_from(&chunk[0..4]) else {
            continue;
        };
        let Ok(end) = <[u8; 4]>::try_from(&chunk[4..8]) else {
            continue;
        };
        let begin = u32::from_le_bytes(begin) as u64;
        let end = u32::from_le_bytes(end) as u64;
        if begin == 0 || end <= begin {
            continue;
        }
        let start = base.wrapping_add(begin);
        if in_text_ranges(&text, start) {
            out.push((start, end - begin));
        }
    }
    out
}

/// Background half of discovery: decode every known function's blocks (warming
/// the cache the UI reads), promote any code target those blocks reference into
/// a function, and recompute sizes. Bounded by [`MAX_FUNCTIONS`], stopped early
/// when the engine is dropped, and run to a fixpoint so newly-found functions
/// are themselves decoded.
fn background_index(data: Arc<Vec<u8>>, state: Arc<Mutex<NativeState>>, cancel: Arc<AtomicBool>) {
    let finish = |state: &Arc<Mutex<NativeState>>| {
        if let Ok(mut s) = state.lock() {
            s.indexing = false;
        }
    };
    let file = match object::File::parse(&data[..]) {
        Ok(f) => f,
        Err(_) => return finish(&state),
    };
    let cs = match build_capstone(&file) {
        Ok(c) => c,
        Err(_) => return finish(&state),
    };
    let text = text_ranges(&file);
    let got = import_got_labels(&file);
    while !cancel.load(Ordering::Relaxed) {
        let pending: Vec<u64> = match state.lock() {
            Ok(s) => s
                .functions
                .keys()
                .copied()
                .filter(|a| !s.blocks.contains_key(a) && !s.fde_sized.contains(a))
                .collect(),
            Err(_) => break,
        };
        if pending.is_empty() {
            break;
        }
        let mut grew = false;
        let mut decoded = 0u32;
        for addr in pending {
            if cancel.load(Ordering::Relaxed) {
                return finish(&state);
            }
            let Ok(blocks) = decode_blocks(&file, &cs, addr) else {
                continue;
            };
            let mut candidates: Vec<u64> = Vec::new();
            for op in blocks.iter().flat_map(|b| b.ops.iter()) {
                if matches!(op.kind.as_deref(), Some("call") | Some("icall")) {
                    if let Some(t) = op.jump {
                        if in_text_ranges(&text, t) {
                            candidates.push(t);
                        }
                    }
                }
            }
            let Ok(mut s) = state.lock() else { break };
            if s.blocks.len() < BLOCK_CACHE_MAX {
                s.blocks.insert(addr, blocks);
            }
            for t in candidates {
                if s.functions.contains_key(&t) || s.functions.len() >= MAX_FUNCTIONS {
                    continue;
                }
                let name = plt_name_at(&file, &cs, t, &got)
                    .map(|imported| format!("imp.{imported}"))
                    .unwrap_or_else(|| format!("fcn_{t:x}"));
                add_function(&mut s.functions, &file, t, name);
                grew = true;
            }
            // Be a good citizen: yield the CPU periodically so the indexer runs
            // as idle-time work rather than competing with live queries.
            decoded += 1;
            if decoded.is_multiple_of(32) {
                std::thread::sleep(std::time::Duration::from_millis(2));
            }
        }
        if let Ok(mut s) = state.lock() {
            assign_sizes(&mut s.functions, &file);
        }
        if !grew {
            break;
        }
    }
    finish(&state);
}

/// Candidate absolute addresses referenced by an instruction, for annotation:
/// the effective address of a `[rip + disp]` operand, or any bare `0x` operand
/// (non-PIE string addresses). Exact lookups filter out false positives.
fn memory_references(op: &Instruction) -> Vec<u64> {
    let text = &op.disasm;
    if let Some(idx) = text.find("[rip") {
        return rip_displacement(&text[idx..])
            .map(|disp| {
                vec![op
                    .addr
                    .wrapping_add(op.len as u64)
                    .wrapping_add(disp as u64)]
            })
            .unwrap_or_default();
    }
    text.split(|c: char| !c.is_ascii_alphanumeric())
        .filter_map(|token| token.strip_prefix("0x"))
        .filter_map(|hex| u64::from_str_radix(hex, 16).ok())
        .collect()
}

/// The effective address of a non-indexed memory operand (`[rip + X]` or
/// `[0xADDR]`), or `None` for a register-relative / indexed operand.
fn memory_operand_address(op: &Instruction) -> Option<u64> {
    let text = &op.disasm;
    let start = text.find('[')?;
    let end = text[start..].find(']')? + start;
    let inner = &text[start + 1..end];
    if inner.contains('*') {
        return None;
    }
    if inner.contains("rip") {
        let disp = rip_displacement(inner)?;
        return Some(
            op.addr
                .wrapping_add(op.len as u64)
                .wrapping_add(disp as u64),
        );
    }
    let hex = inner.trim().strip_prefix("0x")?;
    u64::from_str_radix(hex, 16).ok()
}

/// Resolve an indirect call/jump through a data slot: read the pointer stored
/// at the operand address and return it when it points into executable code —
/// a tail call through a GOT slot, an ifunc stub, or a function-pointer table.
fn resolve_indirect(file: &object::File<'_>, text: &[(u64, u64)], op: &Instruction) -> Option<u64> {
    let slot = memory_operand_address(op)?;
    let section = file
        .sections()
        .find(|s| slot >= s.address() && slot < s.address().saturating_add(s.size()))?;
    if !matches!(
        section.kind(),
        SectionKind::Data | SectionKind::ReadOnlyData | SectionKind::UninitializedData
    ) {
        return None;
    }
    let base = section.address();
    let data = section.data().ok()?;
    let off = (slot - base) as usize;
    if off + 8 > data.len() {
        return None;
    }
    let value = u64::from_le_bytes(data[off..off + 8].try_into().ok()?);
    in_text_ranges(text, value).then_some(value)
}

/// Find the section containing `addr`, returning its bytes and base address.
fn section_at<'f>(file: &'f object::File<'f>, addr: u64) -> Option<(&'f [u8], u64)> {
    file.sections()
        .find(|s| addr >= s.address() && addr < s.address().saturating_add(s.size()))
        .and_then(|s| s.data().ok().map(|data| (data, s.address())))
}

/// True when `addr` lands in a data section (used to tell a real data
/// reference from an ordinary immediate).
/// Where a jump table lives: a fixed address, or a register set earlier in the
/// block (the position-independent case: `lea rdx, [rip + table]`).
#[derive(Clone, Debug, PartialEq)]
enum TableBase {
    Abs(u64),
    Reg(String),
}

/// Recover the case targets of a jump table: the base is named in the computed
/// jump operand (`jmp qword ptr [rax*8 + 0x4020]` or `jmp [rdx + rax*8]`), and
/// entries are either absolute pointers or offsets relative to the base.
fn jump_table_targets(
    file: &object::File<'_>,
    text: &[(u64, u64)],
    ops: &[Instruction],
    op: &Instruction,
) -> Vec<u64> {
    let Some((entry_size, base)) = parse_jump_table(&op.disasm) else {
        return Vec::new();
    };
    let base = match base {
        TableBase::Abs(addr) => addr,
        TableBase::Reg(reg) => match resolve_table_base(ops, &reg) {
            Some(addr) => addr,
            None => return Vec::new(),
        },
    };
    let Some((data, data_addr)) = section_at(file, base) else {
        return Vec::new();
    };
    let mut off = (base - data_addr) as usize;
    let mut out = Vec::new();
    while off + entry_size <= data.len() && out.len() < 256 {
        let value = if entry_size == 8 {
            u64::from_le_bytes(data[off..off + 8].try_into().unwrap_or([0; 8]))
        } else {
            u32::from_le_bytes(data[off..off + 4].try_into().unwrap_or([0; 4])) as u64
        };
        let target = if in_text_ranges(text, value) {
            value
        } else if in_text_ranges(text, base.wrapping_add(value)) {
            base.wrapping_add(value)
        } else {
            break;
        };
        out.push(target);
        off += entry_size;
    }
    out
}

/// Resolve a jump-table base register from an earlier instruction in the same
/// block: `lea reg, [rip + X]` (position-independent) or `mov reg, imm`.
fn resolve_table_base(ops: &[Instruction], reg: &str) -> Option<u64> {
    let lea = format!("lea {reg}, [rip");
    let mov = format!("mov {reg}, ");
    let movabs = format!("movabs {reg}, ");
    for op in ops.iter().rev() {
        let disasm = &op.disasm;
        if disasm.starts_with(&lea) {
            if let Some(disp) = rip_displacement(disasm) {
                return Some(
                    op.addr
                        .wrapping_add(op.len as u64)
                        .wrapping_add(disp as u64),
                );
            }
        } else if let Some(rest) = disasm
            .strip_prefix(&mov)
            .or_else(|| disasm.strip_prefix(&movabs))
        {
            let imm = rest.split(',').next().unwrap_or("").trim();
            if let Some(addr) = parse_number(imm) {
                if addr != 0 {
                    return Some(addr);
                }
            }
        }
    }
    None
}

/// The up-to-`n` instructions at or before `addr`, as a slice of the
/// address-sorted `flat` list. Used by the switch matcher so it scans a bounded
/// window instead of the whole function.
fn lookback<T: std::borrow::Borrow<Instruction>>(flat: &[T], addr: u64, n: usize) -> &[T] {
    let hi = flat.partition_point(|o| o.borrow().addr <= addr);
    let lo = hi.saturating_sub(n);
    &flat[lo..hi]
}

/// Recover switch cases from the `jmp reg` idiom compilers emit for dense
/// matches: a table base is loaded into a register, an entry is loaded and
/// (for position-independent tables) added to the base, then jumped to.
fn switch_targets<T: std::borrow::Borrow<Instruction>>(
    file: &object::File<'_>,
    text: &[(u64, u64)],
    ops: &[T],
) -> Vec<u64> {
    match switch_table(ops) {
        Some((table, relative)) => read_table(file, text, table, relative),
        None => Vec::new(),
    }
}

/// Recognise the switch idiom and return `(table_base, relative_entries)`.
///
/// * relative: `lea B,[rip+T]; movsxd R,[B + I*4]; add R, B; jmp R`
/// * absolute: `lea B,[rip+T]; mov R,[B + I*8]; jmp R`
fn switch_table<T: std::borrow::Borrow<Instruction>>(ops: &[T]) -> Option<(u64, bool)> {
    let last = ops.last()?.borrow();
    let reg = last.disasm.strip_prefix("jmp ")?.trim();
    if reg.is_empty() || reg.contains(['[', ',', '+']) {
        return None;
    }
    // Collect candidate table-base registers from the setup instructions:
    // `add reg, base` (relative table) and `mov/movsxd reg, [base + idx*scale]`
    // (absolute table).
    let mut bases: Vec<String> = Vec::new();
    let mut relative = false;
    let mut saw_load = false;
    let add = format!("add {reg}, ");
    let mov = format!("mov {reg}, ");
    let movsxd = format!("movsxd {reg}, ");
    for op in ops.iter().rev() {
        let disasm = &op.borrow().disasm;
        if let Some(rest) = disasm.strip_prefix(&add) {
            let base = rest
                .trim()
                .split(|c: char| !c.is_ascii_alphanumeric())
                .next()
                .unwrap_or("");
            if !base.is_empty() {
                bases.push(base.to_string());
                relative = true;
            }
        } else if let Some(rest) = disasm
            .strip_prefix(&mov)
            .or_else(|| disasm.strip_prefix(&movsxd))
        {
            if let Some(base) = bracketed_base_register(rest) {
                bases.push(base);
                saw_load = true;
            }
        }
    }
    // A computed jump with no table load and no base addition is a plain tail
    // call through a register, not a switch.
    if !(relative || saw_load) {
        return None;
    }
    bases.push(reg.to_string());
    for candidate in &bases {
        let lea = format!("lea {candidate}, [rip");
        for op in ops.iter().rev() {
            let op = op.borrow();
            if op.disasm.starts_with(&lea) {
                if let Some(disp) = rip_displacement(&op.disasm) {
                    let table = op
                        .addr
                        .wrapping_add(op.len as u64)
                        .wrapping_add(disp as u64);
                    return Some((table, relative));
                }
            }
        }
    }
    None
}

/// The base register of a memory operand — the register that is not the scaled
/// index — e.g. `[rdx + rax*8]` yields `rdx`.
fn bracketed_base_register(operands: &str) -> Option<String> {
    let start = operands.find('[')?;
    let end = operands[start..].find(']')? + start;
    let inner = &operands[start + 1..end];
    let tokens: Vec<&str> = inner
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|t| !t.is_empty())
        .collect();
    let index = tokens
        .iter()
        .enumerate()
        .find(|(i, t)| matches!(**t, "8" | "4" | "2") && *i > 0)
        .map(|(i, _)| tokens[i - 1]);
    tokens
        .iter()
        .find(|t| {
            t.chars().any(|c| c.is_ascii_alphabetic()) && Some(**t) != index && !t.starts_with("0x")
        })
        .map(|t| (*t).to_string())
}

/// Read up to 1024 case targets from a table. `relative` selects 4-byte signed
/// offsets from the table base (position-independent) versus 8-byte absolute
/// pointers.
fn read_table(
    file: &object::File<'_>,
    text: &[(u64, u64)],
    table: u64,
    relative: bool,
) -> Vec<u64> {
    let Some((data, data_addr)) = section_at(file, table) else {
        return Vec::new();
    };
    let entry_size = if relative { 4 } else { 8 };
    let mut off = (table - data_addr) as usize;
    let mut out = Vec::new();
    while off + entry_size <= data.len() && out.len() < 1024 {
        let target = if relative {
            let delta = i32::from_le_bytes(data[off..off + 4].try_into().unwrap_or([0; 4])) as i64;
            table.wrapping_add(delta as u64)
        } else {
            u64::from_le_bytes(data[off..off + 8].try_into().unwrap_or([0; 8]))
        };
        if !in_text_ranges(text, target) {
            break;
        }
        out.push(target);
        off += entry_size;
    }
    out
}

/// Parse `jmp ... [reg*8 + 0xADDR]` / `[0xADDR + reg*8]` into
/// `(entry_size, table_base)`. A register-indexed table with a RIP-relative
/// base is not statically resolvable here and yields `None`.
fn parse_jump_table(disasm: &str) -> Option<(usize, TableBase)> {
    let start = disasm.find('[')?;
    let end = disasm[start..].find(']')? + start;
    let inner = &disasm[start + 1..end];
    let entry_size = if inner.contains("*8") {
        8
    } else if inner.contains("*4") {
        4
    } else {
        return None;
    };
    let tokens: Vec<&str> = inner
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|t| !t.is_empty())
        .collect();
    // A fixed table base (non-position-independent code).
    for token in &tokens {
        if let Some(hex) = token.strip_prefix("0x") {
            if let Ok(v) = u64::from_str_radix(hex, 16) {
                return Some((entry_size, TableBase::Abs(v)));
            }
        }
    }
    // Register-indexed: the index is the token before the scale; the base is the
    // other register, resolved from an earlier `lea`/`mov` in the block.
    let mut index = None;
    for (i, token) in tokens.iter().enumerate() {
        if (*token == "8" || *token == "4") && i > 0 {
            index = Some(tokens[i - 1]);
            break;
        }
    }
    let base = tokens.iter().find(|t| {
        t.chars().any(|c| c.is_ascii_alphabetic()) && Some(**t) != index && !t.starts_with("0x")
    })?;
    Some((entry_size, TableBase::Reg((*base).to_string())))
}

/// Scan every loadable section for ASCII/UTF-16 strings, deduplicated and
/// sorted by address. Shared by `strings()` and disassembly annotation.
fn scan_all_strings(file: &object::File<'_>) -> Vec<StringRef> {
    let mut out: Vec<StringRef> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for section in file.sections() {
        if !matches!(
            section.kind(),
            SectionKind::Text | SectionKind::Data | SectionKind::ReadOnlyData
        ) {
            continue;
        }
        let Ok(data) = section.data() else {
            continue;
        };
        let base = section.address();
        for (addr, s, kind) in scan_strings(data, base) {
            if seen.insert(s.clone()) {
                out.push(StringRef {
                    addr,
                    string: s,
                    kind: Some(kind),
                });
            }
        }
    }
    out.sort_by_key(|s| s.addr);
    out
}

/// Error text for an address outside any executable section.
fn missing_code(addr: u64) -> String {
    format!(
        "{addr:#x} is not in an executable section (it may be data); use `strings`, `xrefs`, or a function address"
    )
}

/// Cap a string for an inline disassembly comment.
fn truncate_str(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut s: String = text.chars().take(max).collect();
    s.push('…');
    s
}

/// Recover `main` from a glibc `_start` prologue on x86/x86-64: the entry
/// loads `main`'s address into the first argument register and only *then*
/// calls `__libc_start_main`. Recognises both the PIE `lea rdi, [rip + X]`
/// form and the absolute `mov rdi, X` form.
fn entry_main_seed(file: &object::File<'_>, cs: &Capstone, entry: u64) -> Option<u64> {
    if !matches!(
        file.architecture(),
        Architecture::X86_64 | Architecture::X86_64_X32 | Architecture::I386
    ) {
        return None;
    }
    let section = NativeEngine::text_section(file, entry)?;
    let data = section.data().ok()?;
    let offset = entry.saturating_sub(section.address()) as usize;
    if offset >= data.len() {
        return None;
    }
    let reg = if file.is_64() { "rdi" } else { "edi" };
    let insns = cs.disasm_count(&data[offset..], entry, 64).ok()?;
    for insn in insns.iter() {
        let mnemonic = insn.mnemonic().unwrap_or("");
        let operands = insn.op_str().unwrap_or("");
        let next = insn.address().wrapping_add(insn.bytes().len() as u64);
        let prefix = format!("{reg}, ");
        if mnemonic == "lea" && operands.starts_with(&format!("{reg}, [rip")) {
            if let Some(disp) = rip_displacement(operands) {
                let target = next.wrapping_add(disp as u64);
                if NativeEngine::in_text(file, target) {
                    return Some(target);
                }
            }
        } else if (mnemonic == "mov" || mnemonic == "movabs") && operands.starts_with(&prefix) {
            let imm = operands[prefix.len()..]
                .split(',')
                .next()
                .unwrap_or("")
                .trim();
            if let Some(value) = parse_number(imm) {
                if NativeEngine::in_text(file, value) {
                    return Some(value);
                }
            }
        }
    }
    None
}

/// Parse the displacement in an x86 `[rip + X]` / `[rip - X]` operand.
fn rip_displacement(operands: &str) -> Option<i64> {
    let after_rip = operands
        .split("rip")
        .nth(1)?
        .split(']')
        .next()
        .unwrap_or("");
    let compact = after_rip.replace(' ', "");
    let (sign, rest) = match compact.chars().next() {
        Some('+') => (1i64, &compact[1..]),
        Some('-') => (-1i64, &compact[1..]),
        _ => (1i64, compact.as_str()),
    };
    let magnitude = if let Some(hex) = rest.strip_prefix("0x").or_else(|| rest.strip_prefix("0X")) {
        i64::from_str_radix(hex, 16).ok()?
    } else {
        rest.parse::<i64>().ok()?
    };
    Some(sign * magnitude)
}

/// Parse a decimal or `0x` hex number as printed in an operand.
fn parse_number(token: &str) -> Option<u64> {
    let t = token.trim();
    if let Some(hex) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        u64::from_str_radix(hex, 16).ok()
    } else {
        t.parse::<u64>().ok()
    }
}

/// Loose symbol-name match for [`Engine::resolve`]: ignores C++ template
/// arguments and argument list, a `sym.`/`imp.` prefix and trailing
/// underscores, so `readInput` matches `readInput()`, `readInput__`, or the
/// mangled `_Z9readInputv` once demangled.
///
/// ```
/// use recurse_static::native::name_matches;
/// assert!(name_matches("readInput", "readInput()"));
/// assert!(name_matches("success", "success()"));
/// assert!(name_matches("main", "sym.main__"));
/// assert!(name_matches("exit", "imp.exit"));
/// assert!(!name_matches("success", "_Z7successv")); // demangle first (resolve does)
/// assert!(!name_matches("main", "domain"));
/// assert!(!name_matches("", "anything"));
/// ```
pub fn name_matches(query: &str, candidate: &str) -> bool {
    let norm = |s: &str| -> String {
        strip_templates(s)
            .split('(')
            .next()
            .unwrap_or("")
            .trim_start_matches("sym.")
            .trim_start_matches("imp.")
            .trim_matches('_')
            .to_string()
    };
    let q = norm(query);
    !q.is_empty() && norm(candidate) == q
}

/// Remove balanced C++ template argument lists (`<...>`), leaving `operator<<`
/// and comparisons alone. Nested templates collapse entirely.
fn strip_templates(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut depth = 0i32;
    for (i, &c) in chars.iter().enumerate() {
        match c {
            '<' => {
                if depth > 0 {
                    depth += 1;
                } else {
                    let prev = if i > 0 { chars[i - 1] } else { ' ' };
                    let next = chars.get(i + 1).copied().unwrap_or(' ');
                    if matches!(prev, '<' | '=') || matches!(next, '<' | '=') {
                        out.push(c);
                    } else {
                        depth += 1;
                    }
                }
            }
            '>' if depth > 0 => depth -= 1,
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }
    out
}

/// A bounded, human-usable display name for a symbol: demangled, template
/// arguments and parameters stripped. C++ STL symbols demangle to hundreds of
/// characters (measured: 496 for one `std::iter_swap`), which bloats the
/// model's context for no benefit.
///
/// ```
/// use recurse_static::native::shorten_name;
/// assert_eq!(shorten_name("_Z9readInputv"), "readInput");
/// assert_eq!(shorten_name("main"), "main");
/// assert!(shorten_name("void std::iter_swap<char*, std::string>(char*, std::string)").len() <= 66);
/// ```
pub fn shorten_name(raw: &str) -> String {
    let base = strip_templates(&demangle(raw));
    let no_params = base.split('(').next().unwrap_or("");
    let collapsed = no_params.split_whitespace().collect::<Vec<_>>().join(" ");
    truncate_str(collapsed.trim(), 64)
}

/// Render bytes as lowercase hex (`554889e5`).
fn hex_bytes(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        use std::fmt::Write as _;
        let _ = write!(s, "{b:02x}");
    }
    s
}

/// Render one Capstone instruction as `mnemonic operand, operand`.
fn format_insn(insn: &capstone::Insn<'_>) -> String {
    let mnemonic = insn.mnemonic().unwrap_or("");
    let operands = insn.op_str().unwrap_or("");
    if operands.is_empty() {
        mnemonic.to_string()
    } else {
        format!("{mnemonic} {operands}")
    }
}

/// Map a Capstone instruction's groups to the canonical kind and edges.
///
/// Flow control comes from Capstone's instruction groups (jump/call/ret), and
/// direct targets are read from the operand text. An operand containing a
/// memory reference (`[...]`) or a register is a register/memory-indirect
/// branch and therefore has no static target.
fn classify(
    cs: &Capstone,
    insn: &capstone::Insn<'_>,
) -> (Option<String>, Option<u64>, Option<u64>) {
    let mnemonic = insn.mnemonic().unwrap_or("");
    let operands = insn.op_str().unwrap_or("");
    let detail = cs.insn_detail(insn);
    let has = |g: u8| {
        detail
            .as_ref()
            .map(|d| d.groups().iter().any(|x| x.0 == g))
            .unwrap_or(false)
    };
    let next = insn.address().saturating_add(insn.bytes().len() as u64);

    if has(InsnGroupType::CS_GRP_RET as u8) || has(InsnGroupType::CS_GRP_IRET as u8) {
        return (Some("ret".into()), None, None);
    }
    if has(InsnGroupType::CS_GRP_CALL as u8) {
        return (Some("call".into()), parse_branch_target(operands), None);
    }
    if has(InsnGroupType::CS_GRP_JUMP as u8) {
        let target = parse_branch_target(operands);
        if is_unconditional_branch(mnemonic) {
            return (Some("jmp".into()), target, None);
        }
        return (Some("cjmp".into()), target, Some(next));
    }
    if has(InsnGroupType::CS_GRP_INT as u8) {
        return (Some("int".into()), None, None);
    }
    (None, None, None)
}

/// Extract a direct branch/call target from an operand string, if it names a
/// bare immediate. Memory (`[...]`) and register operands yield `None`.
///
/// ```
/// use recurse_static::native::parse_branch_target;
/// assert_eq!(parse_branch_target("0x401000"), Some(0x401000));
/// assert_eq!(parse_branch_target("#0x1234"), Some(0x1234));
/// assert_eq!(parse_branch_target("ra, 0x1234"), Some(0x1234));
/// assert_eq!(parse_branch_target("rax"), None);
/// assert_eq!(parse_branch_target("qword ptr [rip + 0x10]"), None);
/// ```
pub fn parse_branch_target(operands: &str) -> Option<u64> {
    if operands.contains('[') || operands.contains("ptr") {
        return None;
    }
    for token in operands
        .split(|c: char| c.is_whitespace() || c == ',')
        .rev()
    {
        let t = token.trim_matches(|c: char| matches!(c, '#' | ']' | ')' | '+' | ':' | '$' | '('));
        if t.is_empty() {
            continue;
        }
        if let Some(hex) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
            if let Ok(v) = u64::from_str_radix(hex, 16) {
                return Some(v);
            }
        } else if t.chars().all(|c| c.is_ascii_digit()) {
            if let Ok(v) = t.parse::<u64>() {
                return Some(v);
            }
        }
    }
    None
}

/// True when a branch mnemonic is an unconditional jump (so a block has no
/// fall-through edge). Best-effort across the architectures Capstone covers;
/// an unrecognised mnemonic is treated as conditional, which only adds a
/// fall-through edge rather than dropping real control flow.
///
/// ```
/// use recurse_static::native::is_unconditional_branch;
/// assert!(is_unconditional_branch("jmp"));
/// assert!(is_unconditional_branch("b"));
/// assert!(is_unconditional_branch("b.w"));
/// assert!(is_unconditional_branch("ba"));
/// assert!(!is_unconditional_branch("je"));
/// assert!(!is_unconditional_branch("beq"));
/// ```
pub fn is_unconditional_branch(mnemonic: &str) -> bool {
    // Strip ARM condition/width suffixes (`b.w`, `b.n`, `bne` stays distinct).
    let stem = mnemonic
        .split(['.', ' '])
        .next()
        .unwrap_or(mnemonic)
        .to_ascii_lowercase();
    matches!(
        stem.as_str(),
        "jmp"
            | "ljmp"
            | "b"
            | "ba"
            | "br"
            | "bx"
            | "bxj"
            | "bra"
            | "braf"
            | "brf"
            | "j"
            | "ja"
            | "jr"
            | "jal"
            | "jalr"
            | "bctr"
            | "blr"
            | "rg"
    )
}

impl Drop for NativeEngine {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Relaxed);
    }
}

/// libc functions that have a FORTIFY (`_chk`) variant; used for the
/// "fortifiable" count on the recon page.
const FORTIFIABLE: &[&str] = &[
    "memcpy",
    "memmove",
    "memset",
    "memcmp",
    "strcpy",
    "strncpy",
    "strcat",
    "strncat",
    "sprintf",
    "snprintf",
    "vsprintf",
    "vsnprintf",
    "gets",
    "fgets",
    "printf",
    "fprintf",
    "vfprintf",
    "vprintf",
    "syslog",
    "read",
    "pread",
    "realpath",
    "getcwd",
    "asprintf",
    "dprintf",
    "fread",
    "readlink",
    "stpcpy",
    "stpncpy",
    "swprintf",
    "ttyname_r",
    "vasprintf",
    "vdprintf",
    "wcscpy",
    "wcsncpy",
    "wmemcpy",
    "wmemmove",
    "wmemset",
];

/// Distinct libraries an object links against, from its imports (ELF
/// `DT_NEEDED` names, PE import directory).
fn libraries(file: &object::File<'_>) -> Vec<String> {
    let mut out: BTreeSet<String> = BTreeSet::new();
    if let Ok(imports) = file.imports() {
        for imp in imports {
            let lib = String::from_utf8_lossy(imp.library());
            if !lib.is_empty() {
                out.insert(lib.into_owned());
            }
        }
    }
    out.into_iter().collect()
}

/// Clone a function with any analyst rename applied to its display name.
fn apply_rename(state: &NativeState, f: &FunctionInfo) -> FunctionInfo {
    let mut f = f.clone();
    if let Some(name) = state.renames.get(&f.addr) {
        f.name = name.clone();
    }
    f
}

/// Fraction of executable bytes that belong to a discovered function.
fn coverage(functions: &BTreeMap<u64, FunctionInfo>, file: &object::File<'_>) -> f64 {
    let text = text_ranges(file);
    let total: u64 = text.iter().map(|(lo, hi)| hi - lo).sum();
    if total == 0 {
        return 0.0;
    }
    let mut covered = 0u64;
    for f in functions.values() {
        let Some(size) = f.size else { continue };
        let end = f.addr.saturating_add(size);
        for (lo, hi) in &text {
            if f.addr >= *lo && f.addr < *hi {
                covered += end.min(*hi).saturating_sub(f.addr);
                break;
            }
        }
    }
    (covered as f64 / total as f64).clamp(0.0, 1.0)
}

/// Friendly CPU name for the recon page.
fn machine_name(arch: Architecture) -> &'static str {
    match arch {
        Architecture::X86_64 | Architecture::X86_64_X32 => "AMD x86-64",
        Architecture::I386 => "Intel 80386",
        Architecture::Aarch64 | Architecture::Aarch64_Ilp32 => "AArch64",
        Architecture::Arm => "ARM",
        Architecture::Mips | Architecture::Mips64 | Architecture::Mips64_N32 => "MIPS",
        Architecture::PowerPc | Architecture::PowerPc64 => "PowerPC",
        Architecture::Riscv32 | Architecture::Riscv64 => "RISC-V",
        Architecture::Sparc | Architecture::Sparc32Plus | Architecture::Sparc64 => "SPARC",
        Architecture::S390x => "IBM S/390",
        Architecture::M68k => "Motorola 68000",
        Architecture::Bpf => "eBPF",
        _ => arch_name(arch),
    }
}

/// ELF object type, in the `readelf` phrasing.
fn object_type(file: &object::File<'_>) -> &'static str {
    match file.kind() {
        ObjectKind::Executable => "EXEC (Executable file)",
        ObjectKind::Dynamic => "DYN (Shared object file)",
        ObjectKind::Relocatable => "REL (Relocatable file)",
        ObjectKind::Core => "CORE (Core file)",
        _ => "unknown",
    }
}

/// The `.comment` section as one string (compiler identification).
fn comment_string(file: &object::File<'_>) -> Option<String> {
    let section = file.section_by_name(".comment")?;
    let data = section.data().ok()?;
    let text = String::from_utf8_lossy(data);
    let parts: Vec<&str> = text.split('\0').filter(|s| !s.trim().is_empty()).collect();
    (!parts.is_empty()).then(|| parts.join("; "))
}

/// Best-effort source language, from symbols and the compiler comment.
fn guess_language(file: &object::File<'_>) -> &'static str {
    if comment_string(file).is_some_and(|c| c.contains("rustc")) {
        return "rust";
    }
    let mut cpp = false;
    for sym in file.symbols().chain(file.dynamic_symbols()) {
        let Ok(name) = sym.name() else { continue };
        if name.starts_with("_R") || name.contains("rust") {
            return "rust";
        }
        if name.starts_with("_Z") {
            cpp = true;
        }
    }
    if cpp {
        "c++"
    } else {
        "c"
    }
}

/// True when the object references common crypto routines.
fn has_crypto(file: &object::File<'_>) -> bool {
    const NEEDLES: [&str; 8] = [
        "aes", "sha1", "sha256", "sha512", "md5", "rc4", "chacha", "evp_",
    ];
    let matches = |name: &str| {
        let lower = name.to_ascii_lowercase();
        NEEDLES.iter().any(|n| lower.contains(n))
    };
    if let Ok(imports) = file.imports() {
        for imp in imports {
            if matches(&String::from_utf8_lossy(imp.name())) {
                return true;
            }
        }
    }
    file.symbols()
        .chain(file.dynamic_symbols())
        .filter_map(|s| s.name().ok())
        .any(matches)
}

/// Read a NUL-terminated string at `offset` in a string table.
fn read_cstr(data: &[u8], offset: usize) -> Option<String> {
    let rest = data.get(offset..)?;
    let end = rest.iter().position(|&b| b == 0).unwrap_or(rest.len());
    Some(String::from_utf8_lossy(&rest[..end]).into_owned())
}

/// RELRO / PIE / NX / RPATH / RUNPATH for an ELF file, from its program headers
/// and `.dynamic` section. Self-contained: no external tool is run.
#[allow(clippy::type_complexity)]
fn elf_checksec<'d, Elf, R>(
    elf: &object::read::elf::ElfFile<'d, Elf, R>,
) -> (String, String, String, String, String)
where
    Elf: object::read::elf::FileHeader<Endian = object::Endianness>,
    R: object::ReadRef<'d>,
{
    use object::read::elf::{Dyn, ProgramHeader};
    let endian = elf.endian();
    let mut has_relro = false;
    let mut stack_exec: Option<bool> = None;
    let mut has_interp = false;
    for ph in elf.elf_program_headers() {
        match ph.p_type(endian) {
            object::elf::PT_GNU_RELRO => has_relro = true,
            object::elf::PT_GNU_STACK => {
                stack_exec = Some(ph.p_flags(endian) & object::elf::PF_X != 0);
            }
            object::elf::PT_INTERP => has_interp = true,
            _ => {}
        }
    }
    let mut bind_now = false;
    let mut rpath: Option<String> = None;
    let mut runpath: Option<String> = None;
    if let Some(section) = elf.section_by_name(".dynamic") {
        if let Ok(data) = section.data() {
            // `size_of::<Elf::Dyn>()` is a non-zero constant (16 for ELF64,
            // 8 for ELF32), so the divisor is never zero.
            let size = core::mem::size_of::<Elf::Dyn>();
            if let Ok((entries, _)) =
                object::pod::slice_from_bytes::<Elf::Dyn>(data, data.len() / size)
            {
                let dynstr = elf.section_by_name(".dynstr").and_then(|s| s.data().ok());
                for d in entries {
                    let tag: u64 = d.d_tag(endian).into();
                    let val: u64 = d.d_val(endian).into();
                    match tag as u32 {
                        object::elf::DT_BIND_NOW => bind_now = true,
                        object::elf::DT_FLAGS => {
                            if val as u32 & object::elf::DF_BIND_NOW != 0 {
                                bind_now = true;
                            }
                        }
                        object::elf::DT_FLAGS_1 => {
                            if val as u32 & object::elf::DF_1_NOW != 0 {
                                bind_now = true;
                            }
                        }
                        object::elf::DT_RPATH => {
                            rpath = dynstr.and_then(|s| read_cstr(s, val as usize));
                        }
                        object::elf::DT_RUNPATH => {
                            runpath = dynstr.and_then(|s| read_cstr(s, val as usize));
                        }
                        _ => {}
                    }
                }
            }
        }
    }
    let relro = if !has_relro {
        "No RELRO"
    } else if bind_now {
        "Full RELRO"
    } else {
        "Partial RELRO"
    };
    let pie = match elf.elf_header().e_type(endian) {
        object::elf::ET_DYN if has_interp => "PIE enabled",
        object::elf::ET_DYN => "DSO",
        _ => "No PIE",
    };
    let nx = match stack_exec {
        Some(true) => "NX disabled",
        // Absent or non-executable `GNU_STACK` is the modern non-exec default.
        _ => "NX enabled",
    };
    (
        relro.to_string(),
        pie.to_string(),
        nx.to_string(),
        rpath.unwrap_or_else(|| "No RPATH".into()),
        runpath.unwrap_or_else(|| "No RUNPATH".into()),
    )
}

/// Extended binary info for the recon page (fields the generic `info()` omits).
fn recon_info(file: &object::File<'_>) -> serde_json::Value {
    let bits = arch_bits(file.architecture()).unwrap_or(0);
    let format = format_name(file.format());
    let dynamic = file.dynamic_symbols().next().is_some();
    let canary = file
        .imports()
        .map(|it| {
            it.into_iter()
                .any(|i| i.name() == b"__stack_chk_fail".as_slice())
        })
        .unwrap_or(false);
    json!({
        "format": format,
        "arch": arch_name(file.architecture()),
        "bits": bits,
        "machine": machine_name(file.architecture()),
        "os": std::env::consts::OS,
        "class": format!("{}{bits}", format.to_uppercase()),
        "endian": if file.is_little_endian() { "LE" } else { "BE" },
        "type": object_type(file),
        "stripped": file.symbols().next().is_none(),
        "static": !dynamic,
        "pic": matches!(file.kind(), ObjectKind::Dynamic | ObjectKind::Relocatable),
        "relocs": file.dynamic_relocations().is_some(),
        "canary": canary,
        "crypto": has_crypto(file),
        "language": guess_language(file),
        "compiler": comment_string(file).unwrap_or_else(|| "N/A".into()),
        "base_addr": format!("{:#x}", file.relative_address_base()),
        "entry": file.entry(),
        "virtual_addr": true,
    })
}

impl Engine for NativeEngine {
    fn indexing(&self) -> bool {
        self.state.lock().map(|s| s.indexing).unwrap_or(false)
    }

    fn backend(&self) -> BackendKind {
        BackendKind::Native
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            decompile: true,
            raw: false,
            graph: true,
            xrefs_from: true,
        }
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn analyze(&self) -> Result<(), String> {
        self.discover()
    }

    fn summary(&self) -> Result<serde_json::Value, String> {
        let info = self.info()?;
        self.discover()?;
        let function_count = {
            let state = self
                .state
                .lock()
                .map_err(|e| format!("native state poisoned: {e}"))?;
            state.functions.len()
        };
        let string_count = self.strings().map(|s| s.len()).unwrap_or(0);
        Ok(json!({
            "path": self.path.to_string_lossy(),
            "info": info,
            "function_count": function_count,
            "string_count": string_count,
        }))
    }

    fn info(&self) -> Result<serde_json::Value, String> {
        let file = self.parse()?;
        Ok(self.info_value(&file))
    }

    fn recon(&self) -> Result<serde_json::Value, String> {
        let file = self.parse()?;
        self.discover()?;
        let (functions, xrefs, calls, symbols, coverage) = {
            let state = self
                .state
                .lock()
                .map_err(|e| format!("native state poisoned: {e}"))?;
            (
                state.functions.len(),
                state.xrefs.len(),
                state.xrefs.iter().filter(|r| r.kind == "CALL").count(),
                file.symbols().filter(|s| s.is_definition()).count(),
                coverage(&state.functions, &file),
            )
        };
        Ok(json!({
            "libraries": libraries(&file),
            "checksec": self.checksec(&file),
            "analysis": {
                "functions": functions,
                "xrefs": xrefs,
                "calls": calls,
                "symbols": symbols,
                "coverage": coverage,
            },
            "info": recon_info(&file),
        }))
    }

    fn functions(&self) -> Result<Vec<FunctionInfo>, String> {
        self.discover()?;
        let state = self
            .state
            .lock()
            .map_err(|e| format!("native state poisoned: {e}"))?;
        Ok(state
            .functions
            .values()
            .map(|f| apply_rename(&state, f))
            .collect())
    }

    fn set_renames(&self, renames: std::collections::HashMap<u64, String>) {
        if let Ok(mut state) = self.state.lock() {
            state.renames = renames;
            // Annotation labels embed function names; rebuild on next use.
            state.labels = None;
        }
    }

    fn function_at(&self, addr: u64) -> Result<Option<FunctionInfo>, String> {
        self.discover()?;
        let state = self
            .state
            .lock()
            .map_err(|e| format!("native state poisoned: {e}"))?;
        // The containing function is the greatest entry <= addr.
        Ok(state
            .functions
            .range(..=addr)
            .next_back()
            .map(|(_, f)| apply_rename(&state, f))
            .filter(|f| {
                f.size
                    .map(|s| addr < f.addr.saturating_add(s))
                    .unwrap_or(true)
            }))
    }

    fn disassemble(&self, target: &Target, count: Option<usize>) -> Result<Disassembly, String> {
        let addr = match target {
            Target::Addr(a) => *a,
            Target::Symbol(name) => self
                .resolve(name)?
                .ok_or_else(|| format!("could not resolve symbol `{name}`"))?,
        };
        match count {
            Some(n) => {
                let mut ops = self.decode_linear(addr, n)?;
                self.annotate_ops(&mut ops);
                let name = self
                    .function_at(addr)?
                    .map(|f| f.name)
                    .unwrap_or_else(|| format!("fcn_{addr:x}"));
                Ok(Disassembly {
                    addr,
                    name,
                    size: None,
                    ops,
                })
            }
            None => self.function_disasm(addr),
        }
    }

    fn function_disasm(&self, addr: u64) -> Result<Disassembly, String> {
        self.discover()?;
        let func = self.function_at(addr)?;
        let entry = func.as_ref().map(|f| f.addr).unwrap_or(addr);
        let blocks = self.blocks_for(entry)?;
        let mut ops: Vec<Instruction> = blocks.into_iter().flat_map(|b| b.ops).collect();
        ops.sort_by_key(|o| o.addr);
        ops.dedup_by_key(|o| o.addr);
        self.annotate_ops(&mut ops);
        Ok(Disassembly {
            addr: entry,
            name: func
                .as_ref()
                .map(|f| f.name.clone())
                .unwrap_or_else(|| format!("fcn_{entry:x}")),
            size: func.and_then(|f| f.size),
            ops,
        })
    }

    fn function_graph(&self, addr: u64) -> Result<FunctionGraph, String> {
        self.discover()?;
        let func = self.function_at(addr)?;
        let entry = func.as_ref().map(|f| f.addr).unwrap_or(addr);
        let mut blocks = self.blocks_for(entry)?;
        for block in &mut blocks {
            self.annotate_ops(&mut block.ops);
        }
        Ok(FunctionGraph {
            addr: entry,
            name: func
                .map(|f| f.name)
                .unwrap_or_else(|| format!("fcn_{entry:x}")),
            blocks,
        })
    }

    fn strings(&self) -> Result<Vec<StringRef>, String> {
        self.ensure_labels()?;
        let state = self
            .state
            .lock()
            .map_err(|e| format!("native state poisoned: {e}"))?;
        Ok(state.strings.clone().unwrap_or_default())
    }

    fn imports(&self) -> Result<Vec<Import>, String> {
        let file = self.parse()?;
        let mut out: Vec<Import> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        for imp in file.imports().map_err(|e| e.to_string())? {
            let raw = String::from_utf8_lossy(imp.name()).into_owned();
            if raw.is_empty() {
                continue;
            }
            let name = shorten_name(&raw);
            if !seen.insert(name.clone()) {
                continue;
            }
            let bind = String::from_utf8_lossy(imp.library()).into_owned();
            out.push(Import {
                name,
                plt: None,
                bind: (!bind.is_empty()).then_some(bind),
                kind: Some("import".to_string()),
            });
        }
        // ELF often lists imports only as undefined dynamic symbols.
        if out.is_empty() {
            for sym in file.dynamic_symbols() {
                if !sym.is_undefined() {
                    continue;
                }
                if let Ok(raw) = sym.name() {
                    let name = shorten_name(raw);
                    if !name.is_empty() && seen.insert(name.clone()) {
                        out.push(Import {
                            name,
                            plt: None,
                            bind: None,
                            kind: Some("import".to_string()),
                        });
                    }
                }
            }
        }
        // Each import is forwarded through a discovered `imp.<name>` stub;
        // attach its address so callers can jump straight to the thunk.
        self.discover()?;
        let plts: HashMap<String, u64> = {
            let state = self
                .state
                .lock()
                .map_err(|e| format!("native state poisoned: {e}"))?;
            state
                .functions
                .values()
                .filter_map(|f| f.name.strip_prefix("imp.").map(|n| (n.to_string(), f.addr)))
                .collect()
        };
        for imp in &mut out {
            if imp.plt.is_none() {
                imp.plt = plts.get(&imp.name).copied();
            }
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    }

    fn xrefs(&self, target: &Target, direction: XrefDirection) -> Result<Vec<Xref>, String> {
        let addr = match target {
            Target::Addr(a) => *a,
            Target::Symbol(name) => self
                .resolve(name)?
                .ok_or_else(|| format!("could not resolve symbol `{name}`"))?,
        };
        self.discover()?;
        let state = self
            .state
            .lock()
            .map_err(|e| format!("native state poisoned: {e}"))?;
        let mut out: Vec<Xref> = Vec::new();
        match direction {
            XrefDirection::To => {
                // The sweep already indexed every reference; this is a lookup,
                // not a re-decode, so it cannot stall on a large binary.
                if let Some(idxs) = state.xrefs_by_target.get(&addr) {
                    for &i in idxs {
                        let r = &state.xrefs[i as usize];
                        out.push(Xref {
                            from: r.from,
                            kind: r.kind.clone(),
                            to: Some(r.to),
                            fcn_name: fcn_name_at(&state, r.from),
                            opcode: Some(r.opcode.clone()),
                        });
                    }
                }
            }
            XrefDirection::From => {
                // References that originate inside the function containing
                // `addr`, or at `addr` itself when it is not in a known one.
                let (lo, hi) = match state.functions.range(..=addr).next_back() {
                    Some((_, f))
                        if f.size
                            .map_or(addr == f.addr, |s| addr < f.addr.saturating_add(s)) =>
                    {
                        (f.addr, f.addr.saturating_add(f.size.unwrap_or(0)))
                    }
                    _ => (addr, addr.saturating_add(1)),
                };
                let start = state.xrefs.partition_point(|r| r.from < lo);
                let fname = fcn_name_at(&state, addr);
                for r in &state.xrefs[start..] {
                    if r.from >= hi {
                        break;
                    }
                    out.push(Xref {
                        from: r.from,
                        kind: r.kind.clone(),
                        to: Some(r.to),
                        fcn_name: fname.clone(),
                        opcode: Some(r.opcode.clone()),
                    });
                }
            }
        }
        out.sort_by_key(|x| x.from);
        out.dedup_by(|a, b| a.from == b.from && a.kind == b.kind && a.to == b.to);
        Ok(out)
    }

    fn decompile(&self, addr: u64) -> Result<Decompilation, String> {
        let graph = self.function_graph(addr)?;
        let blocks = crate::engine::function_graph_to_vtil_blocks(&graph);
        let (routine, _stats) = recurse_vtil::lift_and_optimize(graph.addr, &graph.name, &blocks);
        Ok(Decompilation {
            addr: graph.addr,
            name: graph.name,
            code: recurse_vtil::decompile::decompile(&routine),
            annotations: vec![],
        })
    }

    fn raw(&self, _cmd: &str) -> Result<serde_json::Value, String> {
        Err("the native backend has no console".to_string())
    }

    fn resolve(&self, name: &str) -> Result<Option<u64>, String> {
        // Names the tool itself emits (`fcn_1080`, `sub_1080`, `loc_1080`) are
        // not ELF symbols, but the model will ask for them verbatim, so parse
        // the hex form before falling back to the symbol table.
        for prefix in ["fcn_", "sub_", "loc_"] {
            if let Some(hex) = name.strip_prefix(prefix) {
                if let Ok(addr) = u64::from_str_radix(hex.trim_start_matches("0x"), 16) {
                    return Ok(Some(addr));
                }
            }
        }
        // A discovered function name. Matched loosely so the model can drop the
        // C++ argument list it saw in the list (`readInput()` -> `readInput`).
        // The query may also be given mangled (`_Z4mainiPPc`), so demangle it.
        let query_demangled = demangle(name);
        self.discover()?;
        {
            let state = self
                .state
                .lock()
                .map_err(|e| format!("native state poisoned: {e}"))?;
            // An analyst rename resolves to its address.
            if let Some((addr, _)) = state
                .renames
                .iter()
                .find(|(_, n)| name_matches(name, n) || name_matches(&query_demangled, n))
            {
                return Ok(Some(*addr));
            }
            if let Some((_, f)) = state.functions.iter().find(|(_, f)| {
                name_matches(name, &f.name) || name_matches(&query_demangled, &f.name)
            }) {
                return Ok(Some(f.addr));
            }
        }
        let file = self.parse()?;
        let mut suffix: Option<u64> = None;
        for sym in file.symbols().chain(file.dynamic_symbols()) {
            if sym.address() == 0 {
                continue;
            }
            let Ok(sym_name) = sym.name() else {
                continue;
            };
            // The mangled name, its demangled form, and the demangled query
            // (`_Z4mainiPPc` -> `main(int, char**)` -> `main`).
            let demangled = demangle(sym_name);
            if name_matches(name, sym_name)
                || name_matches(name, &demangled)
                || name_matches(&query_demangled, sym_name)
                || name_matches(&query_demangled, &demangled)
            {
                return Ok(Some(sym.address()));
            }
            let stripped = sym_name.trim_start_matches("sym.").trim_end_matches('_');
            if !name.is_empty()
                && stripped.ends_with(name.trim_end_matches('_'))
                && suffix.is_none()
            {
                suffix = Some(sym.address());
            }
        }
        Ok(suffix)
    }

    fn read_bytes(&self, addr: u64, len: usize) -> Result<Vec<u8>, String> {
        if len == 0 {
            return Ok(Vec::new());
        }
        let file = self.parse()?;
        for section in file.sections() {
            let start = section.address();
            let end = start.saturating_add(section.size());
            if addr < start || addr.saturating_add(len as u64) > end {
                continue;
            }
            let data = section
                .data()
                .map_err(|e| format!("read section data: {e}"))?;
            let off = (addr - start) as usize;
            let off_end = off.saturating_add(len);
            if off_end > data.len() {
                // Past the section's file-backed bytes (e.g. tail of .bss) —
                // keep looking; another section may cover it exactly.
                continue;
            }
            return Ok(data[off..off_end].to_vec());
        }
        Err(format!(
            "0x{addr:x}: no section covers {len} byte(s) at this address"
        ))
    }

    fn write_bytes(&self, addr: u64, bytes: &[u8]) -> Result<(), String> {
        if bytes.is_empty() {
            return Ok(());
        }
        let len = bytes.len() as u64;
        let file = self.parse()?;
        let mut file_offset = None;
        for section in file.sections() {
            let start = section.address();
            let end = start.saturating_add(section.size());
            if addr < start || addr.saturating_add(len) > end {
                continue;
            }
            let (sec_file_off, sec_file_len) = section.file_range().ok_or_else(|| {
                format!(
                    "0x{addr:x}: section '{}' has no file-backed bytes (e.g. .bss) — cannot patch",
                    section.name().unwrap_or("?")
                )
            })?;
            let rel = addr - start;
            if rel.saturating_add(len) > sec_file_len {
                continue;
            }
            file_offset = Some(sec_file_off + rel);
            break;
        }
        let file_offset = file_offset.ok_or_else(|| {
            format!("0x{addr:x}: no section covers {len} byte(s) at this address")
        })?;
        use std::io::{Seek, SeekFrom, Write};
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .open(&self.path)
            .map_err(|e| format!("open {} for writing: {e}", self.path.display()))?;
        f.seek(SeekFrom::Start(file_offset))
            .map_err(|e| format!("seek to 0x{file_offset:x}: {e}"))?;
        f.write_all(bytes)
            .map_err(|e| format!("write {} byte(s) at 0x{file_offset:x}: {e}", bytes.len()))?;
        Ok(())
    }
}

/// The reference kind a branch instruction carries, for xref labels.
fn branch_kind(op: &Instruction) -> String {
    match op.kind.as_deref() {
        Some("call") | Some("icall") => "CALL".to_string(),
        Some("jmp") | Some("ijmp") => "JMP".to_string(),
        Some("cjmp") => "CJMP".to_string(),
        _ => "CODE".to_string(),
    }
}

/// Extract ASCII and UTF-16LE strings from one section's bytes.
fn scan_strings(data: &[u8], base: u64) -> Vec<(u64, String, String)> {
    let mut out = Vec::new();
    // ASCII run scanner: printable bytes terminated by a NUL or a non-printable.
    let mut start = 0usize;
    let mut i = 0usize;
    while i <= data.len() {
        let printable = i < data.len() && is_ascii_printable(data[i]);
        if printable {
            if i == start || !is_ascii_printable(data[start]) {
                start = i;
            }
        } else {
            if i > start && i - start >= MIN_STRING_LEN {
                if let Ok(s) = std::str::from_utf8(&data[start..i]) {
                    out.push((base + start as u64, s.to_string(), "ascii".to_string()));
                }
            }
            start = i + 1;
        }
        i += 1;
    }
    // UTF-16LE: alternating printable + NUL bytes, also >= MIN_STRING_LEN.
    let mut i = 0usize;
    while i + 1 < data.len() {
        if data[i] == 0 {
            i += 1;
            continue;
        }
        let begin = i;
        let mut end = i;
        while end + 1 < data.len() && data[end] != 0 && data[end + 1] == 0 {
            end += 2;
        }
        if (end - begin) / 2 >= MIN_STRING_LEN {
            let mut chars: Vec<u16> = Vec::with_capacity((end - begin) / 2);
            let mut j = begin;
            while j + 1 < end {
                chars.push(u16::from_le_bytes([data[j], data[j + 1]]));
                j += 2;
            }
            if let Ok(s) = String::from_utf16(&chars) {
                if s.chars().all(|c| !c.is_control()) {
                    out.push((base + begin as u64, s, "utf16".to_string()));
                }
            }
            i = end;
        } else {
            i += 1;
        }
    }
    out
}

/// True for the bytes allowed inside an ASCII string literal.
fn is_ascii_printable(b: u8) -> bool {
    (0x20..=0x7e).contains(&b) || b == b'\t'
}

/// Short architecture name.
fn arch_name(arch: Architecture) -> &'static str {
    match arch {
        Architecture::X86_64 | Architecture::X86_64_X32 | Architecture::I386 => "x86",
        Architecture::Aarch64 | Architecture::Aarch64_Ilp32 => "arm",
        Architecture::Arm => "arm",
        Architecture::Mips | Architecture::Mips64 | Architecture::Mips64_N32 => "mips",
        Architecture::PowerPc | Architecture::PowerPc64 => "ppc",
        Architecture::Riscv32 | Architecture::Riscv64 => "riscv",
        Architecture::Sparc | Architecture::Sparc32Plus | Architecture::Sparc64 => "sparc",
        Architecture::S390x => "s390",
        Architecture::M68k => "m68k",
        Architecture::Bpf => "bpf",
        Architecture::Avr => "avr",
        Architecture::Wasm32 | Architecture::Wasm64 => "wasm",
        _ => "unknown",
    }
}

/// Address width in bits for an architecture, when known.
fn arch_bits(arch: Architecture) -> Option<u64> {
    match arch {
        Architecture::X86_64
        | Architecture::X86_64_X32
        | Architecture::Aarch64
        | Architecture::Mips64
        | Architecture::Mips64_N32
        | Architecture::PowerPc64
        | Architecture::Riscv64
        | Architecture::Sparc64
        | Architecture::S390x
        | Architecture::Wasm64 => Some(64),
        Architecture::I386
        | Architecture::Arm
        | Architecture::Aarch64_Ilp32
        | Architecture::Mips
        | Architecture::PowerPc
        | Architecture::Riscv32
        | Architecture::Sparc
        | Architecture::Sparc32Plus
        | Architecture::Wasm32
        | Architecture::Bpf
        | Architecture::M68k => Some(32),
        Architecture::Avr => Some(8),
        _ => None,
    }
}

/// Short binary-format name.
fn format_name(format: BinaryFormat) -> &'static str {
    match format {
        BinaryFormat::Elf => "elf",
        BinaryFormat::Pe => "pe",
        BinaryFormat::MachO => "mach0",
        BinaryFormat::Coff => "coff",
        BinaryFormat::Wasm => "wasm",
        BinaryFormat::Xcoff => "xcoff",
        _ => "unknown",
    }
}

/// Human label for an object kind.
fn object_kind_name(kind: ObjectKind) -> &'static str {
    match kind {
        ObjectKind::Executable => "executable",
        ObjectKind::Dynamic => "shared library",
        ObjectKind::Relocatable => "relocatable",
        ObjectKind::Core => "core",
        ObjectKind::Unknown => "unknown",
        _ => "unknown",
    }
}

/// Best-effort symbol demangling (Rust first, then Itanium C++), falling back
/// to the original name.
fn demangle(name: &str) -> String {
    if let Ok(sym) = rustc_demangle::try_demangle(name) {
        return format!("{sym:#}");
    }
    if let Ok(sym) = cpp_demangle::Symbol::new(name) {
        if let Ok(demangled) = sym.demangle(&cpp_demangle::DemangleOptions::default()) {
            return demangled;
        }
    }
    name.to_string()
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
    use super::*;

    /// Copy the running test binary to a temp path so `write_bytes` has a
    /// real, disposable ELF/PE/Mach-O to patch (never patches the test
    /// harness's own on-disk binary).
    fn temp_copy_of_self() -> PathBuf {
        let src = std::env::current_exe().expect("current test executable path");
        let mut dst = std::env::temp_dir();
        dst.push(format!(
            "recurse-native-engine-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::copy(&src, &dst).expect("copy test binary to a scratch path");
        dst
    }

    #[test]
    fn read_bytes_matches_the_file_on_disk() {
        let path = temp_copy_of_self();
        let engine = NativeEngine::open(&path).expect("open native engine");
        let funcs = engine.functions().expect("functions");
        let entry = funcs
            .first()
            .expect("at least one discovered function")
            .addr;
        let want = engine
            .disassemble(&Target::Addr(entry), Some(1))
            .expect("disasm");
        let first_op = &want.ops[0];
        let want_len = first_op.len as usize;
        assert!(want_len > 0, "first instruction must report a byte length");

        let got = engine
            .read_bytes(entry, want_len)
            .expect("read_bytes at the function entry");
        assert_eq!(got.len(), want_len);
        let want_bytes = first_op
            .bytes
            .as_deref()
            .expect("disasm carries the instruction's own hex bytes");
        let want_bytes = (0..want_bytes.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&want_bytes[i..i + 2], 16).unwrap())
            .collect::<Vec<u8>>();
        assert_eq!(
            got, want_bytes,
            "read_bytes must match the disassembled instruction's own bytes"
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn write_bytes_patches_the_file_on_disk_only() {
        let path = temp_copy_of_self();
        let engine = NativeEngine::open(&path).expect("open native engine");
        let funcs = engine.functions().expect("functions");
        let entry = funcs
            .first()
            .expect("at least one discovered function")
            .addr;
        let original = engine.read_bytes(entry, 4).expect("read original bytes");

        // A patch that is provably different from whatever was there,
        // regardless of architecture or original content.
        let patch: Vec<u8> = original.iter().map(|b| b.wrapping_add(1)).collect();
        engine
            .write_bytes(entry, &patch)
            .expect("write_bytes at the function entry");

        // The in-memory session (`self.data`) is documented as not
        // reflecting the patch — read_bytes still returns the pre-patch
        // bytes from the cached buffer.
        let cached = engine.read_bytes(entry, 4).expect("read cached bytes");
        assert_eq!(
            cached, original,
            "write_bytes must not mutate the cached in-memory analysis"
        );

        // The file on disk, opened fresh, must carry the patch.
        let reopened = NativeEngine::open(&path).expect("reopen native engine");
        let on_disk = reopened.read_bytes(entry, 4).expect("read patched bytes");
        assert_eq!(on_disk, patch, "write_bytes must patch the file on disk");

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn read_bytes_rejects_an_address_with_no_covering_section() {
        let path = temp_copy_of_self();
        let engine = NativeEngine::open(&path).expect("open native engine");
        assert!(engine.read_bytes(0xffff_ffff_0000_0000, 4).is_err());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn scan_finds_ascii_and_utf16() {
        let mut data = b"hello world\0".to_vec();
        data.extend_from_slice(&[0x00, 0x00]);
        data.extend(
            "abcd"
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect::<Vec<u8>>(),
        );
        let found = scan_strings(&data, 0x1000);
        assert!(found
            .iter()
            .any(|(a, s, k)| *a == 0x1000 && s == "hello world" && k == "ascii"));
        assert!(found.iter().any(|(_, s, k)| s == "abcd" && k == "utf16"));
    }

    #[test]
    fn branch_targets_ignore_indirect_operands() {
        assert_eq!(parse_branch_target("0x401000"), Some(0x401000));
        assert_eq!(parse_branch_target("#0x1234"), Some(0x1234));
        assert_eq!(parse_branch_target("ra, 0x1234"), Some(0x1234));
        assert_eq!(parse_branch_target("rax"), None);
        assert_eq!(parse_branch_target("qword ptr [rip + 0x10]"), None);
    }

    #[test]
    fn parses_rip_displacements_and_numbers() {
        assert_eq!(parse_number("0x401000"), Some(0x401000));
        assert_eq!(parse_number("4437"), Some(4437));
        assert_eq!(rip_displacement("rdi, [rip + 0x11e]"), Some(0x11e));
        assert_eq!(rip_displacement("rdi, [rip - 0x10]"), Some(-16));
        assert_eq!(rip_displacement("rax, rbx"), None);
    }

    #[test]
    fn unconditional_branch_detection() {
        assert!(is_unconditional_branch("jmp"));
        assert!(is_unconditional_branch("b.w"));
        assert!(is_unconditional_branch("ba"));
        assert!(!is_unconditional_branch("je"));
        assert!(!is_unconditional_branch("bne"));
    }

    #[test]
    fn name_matches_is_loose() {
        assert!(name_matches("readInput", "readInput()"));
        assert!(name_matches("main", "sym.main__"));
        assert!(name_matches("exit", "imp.exit"));
        assert!(name_matches("checkPassword", "checkPassword(int)"));
        assert!(!name_matches("main", "domain"));
        assert!(!name_matches("", "anything"));
    }

    #[test]
    fn shortens_long_cpp_names() {
        assert_eq!(shorten_name("_Z9readInputv"), "readInput");
        assert_eq!(shorten_name("main"), "main");
        let long = "void std::iter_swap<char*, std::string>(char*, std::string)";
        assert!(
            shorten_name(long).len() <= 66,
            "got: {}",
            shorten_name(long)
        );
        // `operator<<` keeps its symbol rather than being eaten as a template.
        assert_eq!(
            strip_templates("std::operator<< <char>(int)"),
            "std::operator<< (int)"
        );
    }

    #[test]
    fn parses_jump_table_operands() {
        assert_eq!(
            parse_jump_table("jmp qword ptr [rax*8 + 0x4020]"),
            Some((8, TableBase::Abs(0x4020)))
        );
        assert_eq!(
            parse_jump_table("jmp qword ptr [0x4020 + rax*8]"),
            Some((8, TableBase::Abs(0x4020)))
        );
        assert_eq!(
            parse_jump_table("jmp dword ptr [eax*4 + 0x8040]"),
            Some((4, TableBase::Abs(0x8040)))
        );
        // Register-indexed base (position-independent code).
        assert_eq!(
            parse_jump_table("jmp qword ptr [rdx + rax*8]"),
            Some((8, TableBase::Reg("rdx".into())))
        );
        assert_eq!(parse_jump_table("jmp rax"), None);
    }

    #[test]
    fn detects_switch_idiom() {
        let mk = |addr: u64, disasm: &str, len: u32| Instruction {
            addr,
            disasm: disasm.into(),
            bytes: None,
            kind: None,
            jump: None,
            fail: None,
            len,
        };
        // Relative table: lea rcx,[rip+0x100] @0x1000 -> table 0x1107.
        let relative = vec![
            mk(0x1000, "lea rcx, [rip + 0x100]", 7),
            mk(0x1007, "movsxd rax, dword ptr [rcx + rax*4]", 7),
            mk(0x100e, "add rax, rcx", 3),
            mk(0x1011, "jmp rax", 2),
        ];
        assert_eq!(switch_table(&relative), Some((0x1107, true)));
        // Absolute table: lea rdx,[rip+0x200] @0x2000 -> table 0x2207.
        let absolute = vec![
            mk(0x2000, "lea rdx, [rip + 0x200]", 7),
            mk(0x2007, "mov rax, qword ptr [rdx + rax*8]", 7),
            mk(0x200e, "jmp rax", 2),
        ];
        assert_eq!(switch_table(&absolute), Some((0x2207, false)));
        // A plain indirect tail call is not a switch.
        let tail = vec![mk(0x3000, "jmp rax", 2)];
        assert_eq!(switch_table(&tail), None);
    }

    #[test]
    fn selects_x86_64_from_a_fat_macho() {
        fn arch_entry(cputype: u32, offset: u32, size: u32) -> Vec<u8> {
            let mut v = Vec::new();
            v.extend_from_slice(&cputype.to_be_bytes()); // cputype
            v.extend_from_slice(&3u32.to_be_bytes()); // cpusubtype
            v.extend_from_slice(&offset.to_be_bytes());
            v.extend_from_slice(&size.to_be_bytes());
            v.extend_from_slice(&0u32.to_be_bytes()); // align
            v
        }
        let arm = vec![0xAAu8; 8];
        let x86 = vec![0xBBu8; 12];
        let header = 8 + 2 * 20;
        let mut fat = Vec::new();
        fat.extend_from_slice(&0xcafebabeu32.to_be_bytes());
        fat.extend_from_slice(&2u32.to_be_bytes());
        fat.extend(arch_entry(0x0100_000C, header as u32, arm.len() as u32));
        fat.extend(arch_entry(
            0x0100_0007,
            (header + arm.len()) as u32,
            x86.len() as u32,
        ));
        fat.extend_from_slice(&arm);
        fat.extend_from_slice(&x86);
        // x86-64 is preferred over the earlier arm64 slice.
        assert_eq!(macho_slice(&fat), Some(x86));
        // A non-fat file is left alone.
        assert_eq!(macho_slice(b"\x7fELF\x02\x01\x01\0"), None);
    }

    #[test]
    fn demangle_falls_back_to_input() {
        assert_eq!(demangle("plain_name"), "plain_name");
    }
}
