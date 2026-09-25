//! IDA Pro / Hex-Rays analysis engine implementation.
//!
//! [`IdaEngine`] spawns IDA Pro in headless batch mode (`idat -A`) and drives
//! it over a local IPC socket using an embedded IDAPython bridge script.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};

use object::{Object, ObjectSection};

use crate::engine::{
    BackendKind, BasicBlock, Capabilities, Decompilation, Disassembly, Engine, FunctionGraph,
    FunctionInfo, Import, Instruction, StringRef, Target, Xref, XrefDirection,
};

const IDA_MAX_FUNCTIONS: usize = 20_000;
const IDA_MAX_READ_BYTES: usize = 16 * 1024 * 1024;

/// Embedded IDAPython bridge script content.
pub const IDA_BRIDGE_SCRIPT: &str = include_str!("ida_bridge.py");

/// Find the IDA Pro executable on the host system.
///
/// Looks in `RECURSE_IDA_PATH` environment variable, common default locations,
/// and `PATH`.
///
/// # Examples
///
/// ```
/// use recurse_static::ida_backend::find_ida_executable;
/// let _ = find_ida_executable();
/// ```
/// Check if a directory contains an IDA Pro executable binary.
///
/// # Examples
///
/// ```
/// use std::path::Path;
/// use recurse_static::ida_backend::check_dir_for_ida;
/// assert!(check_dir_for_ida(Path::new("/nonexistent_path_test_ida")).is_none());
/// ```
pub fn check_dir_for_ida(dir: &Path) -> Option<PathBuf> {
    let bins = [
        "idat64",
        "idat",
        "ida64",
        "ida",
        "idat64.exe",
        "idat.exe",
        "ida64.exe",
        "ida.exe",
    ];
    for b in &bins {
        let p = dir.join(b);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

/// Scan a parent directory for IDA Pro subdirectories.
///
/// # Examples
///
/// ```
/// use std::path::Path;
/// use recurse_static::ida_backend::scan_parent_for_ida;
/// assert!(scan_parent_for_ida(Path::new("/nonexistent_parent_test_ida")).is_none());
/// ```
pub fn scan_parent_for_ida(parent: &Path) -> Option<PathBuf> {
    let Ok(entries) = std::fs::read_dir(parent) else {
        return None;
    };
    let mut matches = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                let lower = name.to_ascii_lowercase();
                if lower.starts_with("ida") {
                    if let Some(exe) = check_dir_for_ida(&path) {
                        matches.push(exe);
                    }
                }
            }
        }
    }
    matches.sort();
    matches.pop()
}

/// Find the IDA Pro executable on the host system.
///
/// 1. Checks environment variables (`RECURSE_IDA_PATH`, `IDA_PATH`, `IDADIR`).
/// 2. Scans natural OS installation paths (Linux, Windows, macOS).
/// 3. Searches `PATH`.
///
/// # Examples
///
/// ```
/// use recurse_static::ida_backend::find_ida_executable;
/// let _ = find_ida_executable();
/// ```
pub fn find_ida_executable() -> Option<PathBuf> {
    // 1. Environment variables
    for var in &["RECURSE_IDA_PATH", "IDA_PATH", "IDADIR"] {
        if let Ok(env_path) = std::env::var(var) {
            let p = PathBuf::from(env_path.trim());
            if p.is_file() {
                return Some(p);
            }
            if p.is_dir() {
                if let Some(exe) = check_dir_for_ida(&p) {
                    return Some(exe);
                }
            }
        }
    }

    // 2. Natural installation directories
    // Linux user home (~/ida-pro-*, ~/.idapro, etc.)
    if let Ok(home) = std::env::var("HOME") {
        let home_p = Path::new(&home);
        if let Some(exe) = scan_parent_for_ida(home_p) {
            return Some(exe);
        }
        let dot_ida = home_p.join(".idapro");
        if let Some(exe) = check_dir_for_ida(&dot_ida) {
            return Some(exe);
        }
    }

    // Linux system paths (/opt, /usr/local/bin, /usr/bin)
    let opt = Path::new("/opt");
    if let Some(exe) = scan_parent_for_ida(opt) {
        return Some(exe);
    }
    for sys_dir in &["/usr/local/bin", "/usr/bin"] {
        if let Some(exe) = check_dir_for_ida(Path::new(sys_dir)) {
            return Some(exe);
        }
    }

    // Windows Program Files & AppData
    for env_var in &["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
        if let Ok(val) = std::env::var(env_var) {
            let parent = Path::new(&val);
            if let Some(exe) = scan_parent_for_ida(parent) {
                return Some(exe);
            }
            let programs = parent.join("Programs");
            if let Some(exe) = scan_parent_for_ida(&programs) {
                return Some(exe);
            }
        }
    }

    // macOS Applications
    let apps = Path::new("/Applications");
    if let Some(exe) = scan_parent_for_ida(apps) {
        return Some(exe);
    }

    // 3. System PATH
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_var) {
            if let Some(exe) = check_dir_for_ida(&dir) {
                return Some(exe);
            }
        }
    }

    None
}

/// Stop and reap a partially initialized IDA child process.
fn stop_child(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

/// The IDA Pro engine backend.
pub struct IdaEngine {
    path: PathBuf,
    stream: Mutex<BufReader<TcpStream>>,
    writer: Mutex<TcpStream>,
    pid: AtomicU32,
    _child: Mutex<Child>,
    call_lock: Mutex<()>,
    session_dir: PathBuf,
    renames: Mutex<HashMap<u64, String>>,
}

impl IdaEngine {
    /// Open a target binary with IDA Pro headless.
    ///
    /// Spawns `idat` in batch mode and establishes an IPC connection with the IDAPython bridge.
    ///
    /// # Errors
    /// Returns an error if IDA executable is not found or fails to initialize.
    pub fn open(path: &Path) -> Result<Self, String> {
        let ida_exe = find_ida_executable().ok_or_else(|| {
            "IDA Pro executable not found. Please install IDA or set RECURSE_IDA_PATH.".to_string()
        })?;

        let listener = TcpListener::bind("127.0.0.1:0")
            .map_err(|e| format!("failed to bind local IPC listener: {e}"))?;
        let port = listener
            .local_addr()
            .map_err(|e| format!("failed to get local IPC port: {e}"))?
            .port();

        let bridge_root = std::env::temp_dir().join("recurse_ida");
        let bridge_dir = bridge_root.join(format!("session_{port}"));
        std::fs::create_dir_all(&bridge_dir)
            .map_err(|e| format!("failed to create IDA session directory: {e}"))?;
        let bridge_path = bridge_dir.join("ida_bridge.py");
        let log_path = bridge_dir.join("ida.log");
        let db_path = bridge_dir.join("analysis.i64");
        std::fs::write(&bridge_path, IDA_BRIDGE_SCRIPT)
            .map_err(|e| format!("failed to write IDA bridge script: {e}"))?;

        // Launch idat
        let mut child = Command::new(&ida_exe)
            .env("TVHEADLESS", "1")
            .env("RECURSE_IDA_PORT", port.to_string())
            .arg("-c")
            .arg("-A")
            .arg(format!("-o{}", db_path.display()))
            .arg(format!("-L{}", log_path.display()))
            .arg(format!("-S{}", bridge_path.display()))
            .arg(path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("failed to spawn IDA Pro ({:?}): {e}", ida_exe))?;

        let pid = child.id();

        // Wait for incoming connection from bridge
        if let Err(error) = listener.set_nonblocking(true) {
            stop_child(&mut child);
            let _ = std::fs::remove_dir_all(&bridge_dir);
            return Err(error.to_string());
        }

        let start = std::time::Instant::now();
        let stream = loop {
            match listener.accept() {
                Ok((s, _)) => break s,
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    // Check if child exited early
                    if let Ok(Some(status)) = child.try_wait() {
                        let log_content = std::fs::read_to_string(&log_path)
                            .unwrap_or_else(|_| "no log available".to_string());
                        let snippet: String = log_content.chars().take(800).collect();
                        stop_child(&mut child);
                        let _ = std::fs::remove_dir_all(&bridge_dir);
                        return Err(format!(
                            "IDA Pro process exited early with status {status}. Log: {snippet}"
                        ));
                    }
                    if start.elapsed() > Duration::from_secs(45) {
                        let log_content = std::fs::read_to_string(&log_path)
                            .unwrap_or_else(|_| "no log available".to_string());
                        let snippet: String = log_content.chars().take(800).collect();
                        stop_child(&mut child);
                        let _ = std::fs::remove_dir_all(&bridge_dir);
                        return Err(format!(
                            "IDA Pro initialization timed out (pid {pid}). Log: {snippet}"
                        ));
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(e) => {
                    stop_child(&mut child);
                    let _ = std::fs::remove_dir_all(&bridge_dir);
                    return Err(format!("IPC connection failed: {e}"));
                }
            }
        };

        if let Err(error) = stream.set_read_timeout(Some(Duration::from_secs(60))) {
            stop_child(&mut child);
            let _ = std::fs::remove_dir_all(&bridge_dir);
            return Err(error.to_string());
        }
        if let Err(error) = stream.set_write_timeout(Some(Duration::from_secs(10))) {
            stop_child(&mut child);
            let _ = std::fs::remove_dir_all(&bridge_dir);
            return Err(error.to_string());
        }

        let writer_stream = match stream.try_clone() {
            Ok(writer) => writer,
            Err(error) => {
                stop_child(&mut child);
                let _ = std::fs::remove_dir_all(&bridge_dir);
                return Err(format!("failed to clone stream: {error}"));
            }
        };
        let mut reader = BufReader::new(stream);

        // Read until ready message
        loop {
            let mut line = String::new();
            if let Err(error) = reader.read_line(&mut line) {
                stop_child(&mut child);
                let _ = std::fs::remove_dir_all(&bridge_dir);
                return Err(format!("failed to read IDA ready message: {error}"));
            }
            if line.contains("\"ready\"") {
                break;
            }
        }

        Ok(Self {
            path: path.to_path_buf(),
            stream: Mutex::new(reader),
            writer: Mutex::new(writer_stream),
            pid: AtomicU32::new(pid),
            _child: Mutex::new(child),
            call_lock: Mutex::new(()),
            session_dir: bridge_dir,
            renames: Mutex::new(HashMap::new()),
        })
    }

    /// Send a JSON-RPC request to the IDA bridge and return the result value.
    fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        let _call_guard = self
            .call_lock
            .lock()
            .map_err(|e| format!("IDA call lock poisoned: {e}"))?;
        let req = json!({
            "id": 1,
            "method": method,
            "params": params
        });
        let req_str = format!("{}\n", req);

        {
            let mut writer = self
                .writer
                .lock()
                .map_err(|e| format!("writer poisoned: {e}"))?;
            writer
                .write_all(req_str.as_bytes())
                .map_err(|e| format!("failed to send request to IDA: {e}"))?;
            writer
                .flush()
                .map_err(|e| format!("failed to flush request to IDA: {e}"))?;
        }

        let mut line = String::new();
        {
            let mut reader = self
                .stream
                .lock()
                .map_err(|e| format!("reader poisoned: {e}"))?;
            reader
                .read_line(&mut line)
                .map_err(|e| format!("failed to read response from IDA: {e}"))?;
        }

        if line.trim().is_empty() {
            return Err("empty response from IDA bridge".to_string());
        }

        let resp: Value = serde_json::from_str(&line)
            .map_err(|e| format!("invalid JSON from IDA: {e} (raw: {line})"))?;

        if resp.get("id").and_then(Value::as_u64) != Some(1) {
            return Err("IDA bridge returned a response for the wrong request".to_string());
        }
        if let Some(err) = resp.get("error") {
            return Err(format!("IDA error: {err}"));
        }

        Ok(resp.get("result").cloned().unwrap_or(Value::Null))
    }
}

impl Engine for IdaEngine {
    fn backend(&self) -> BackendKind {
        BackendKind::Ida
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
        // Auto-analysis is performed on open
        Ok(())
    }

    fn summary(&self) -> Result<Value, String> {
        let info = self.info()?;
        let funcs = self.call("functions", json!({ "limit": 1 }))?;
        let func_count = funcs.get("total").and_then(Value::as_u64).unwrap_or(0);
        let strs = self.call("strings", json!({ "limit": 1 }))?;
        let string_count = strs.get("total").and_then(Value::as_u64).unwrap_or(0);
        let imps = self.call("imports", json!({ "limit": 1 }))?;
        let import_count = imps.get("total").and_then(Value::as_u64).unwrap_or(0);

        Ok(json!({
            "path": self.path.to_string_lossy(),
            "info": info,
            "function_count": func_count,
            "string_count": string_count,
            "import_count": import_count,
        }))
    }

    fn info(&self) -> Result<Value, String> {
        let raw = self.call("info", json!({}))?;
        let arch = raw.get("arch").and_then(Value::as_str).unwrap_or("unknown");
        let bits = raw.get("bits").and_then(Value::as_u64).unwrap_or(64);
        let endian = raw
            .get("endian")
            .and_then(Value::as_str)
            .unwrap_or("little");
        let file_type = raw
            .get("file_type")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let min_ea = raw.get("min_ea").and_then(Value::as_u64).unwrap_or(0);
        let max_ea = raw.get("max_ea").and_then(Value::as_u64).unwrap_or(0);
        let entry = raw.get("entry").and_then(Value::as_u64).unwrap_or(min_ea);

        Ok(json!({
            "bin": {
                "arch": arch,
                "bits": bits,
                "endian": endian,
                "type": file_type,
                "bintype": file_type,
                "baddr": min_ea,
                "min_ea": min_ea,
                "max_ea": max_ea,
                "entry": entry,
                "os": std::env::consts::OS,
            },
            "core": {
                "type": file_type,
            }
        }))
    }

    fn recon(&self) -> Result<Value, String> {
        let imports = self.imports()?;
        let mut libs = std::collections::BTreeSet::new();
        for imp in &imports {
            if let Some(ref b) = imp.bind {
                if !b.is_empty() {
                    libs.insert(b.clone());
                }
            }
        }
        let lib_list: Vec<String> = libs.into_iter().collect();
        Ok(json!({
            "libraries": lib_list,
        }))
    }

    fn functions(&self) -> Result<Vec<FunctionInfo>, String> {
        let res = self.call("functions", json!({ "limit": IDA_MAX_FUNCTIONS }))?;
        let renames = self.renames.lock().unwrap_or_else(|e| e.into_inner());
        let items = res
            .get("functions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        let mut out = Vec::new();
        for item in items {
            let addr = item.get("addr").and_then(Value::as_u64).unwrap_or(0);
            let mut name = item
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if let Some(r) = renames.get(&addr) {
                name = r.clone();
            }
            let size = item.get("size").and_then(Value::as_u64).unwrap_or(0);
            out.push(FunctionInfo {
                addr,
                name,
                size: Some(size),
                nbbs: None,
                edges: None,
                signature: None,
            });
        }
        Ok(out)
    }

    fn function_at(&self, addr: u64) -> Result<Option<FunctionInfo>, String> {
        let res = self.call("function_at", json!({ "addr": addr }))?;
        if res.is_null() {
            return Ok(None);
        }
        let renames = self.renames.lock().unwrap_or_else(|e| e.into_inner());
        let mut name = res
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if let Some(r) = renames.get(&addr) {
            name = r.clone();
        }
        let size = res.get("size").and_then(Value::as_u64).unwrap_or(0);
        Ok(Some(FunctionInfo {
            addr,
            name,
            size: Some(size),
            nbbs: None,
            edges: None,
            signature: None,
        }))
    }

    fn disassemble(&self, target: &Target, _count: Option<usize>) -> Result<Disassembly, String> {
        let addr = match target {
            Target::Addr(a) => *a,
            Target::Symbol(s) => self.resolve(s)?.unwrap_or(0),
        };
        self.function_disasm(addr)
    }

    fn function_disasm(&self, addr: u64) -> Result<Disassembly, String> {
        let res = self.call("disasm", json!({ "addr": addr }))?;
        let name = res
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let renames = self.renames.lock().unwrap_or_else(|e| e.into_inner());
        let final_name = renames.get(&addr).cloned().unwrap_or(name);
        let size = res.get("size").and_then(Value::as_u64);
        let ops_val = res
            .get("ops")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut ops = Vec::new();
        for op in ops_val {
            let op_addr = op.get("addr").and_then(Value::as_u64).unwrap_or(0);
            let disasm = op
                .get("disasm")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let bytes = op
                .get("bytes")
                .and_then(Value::as_str)
                .map(|s| s.to_string());
            let kind = op
                .get("type")
                .and_then(Value::as_str)
                .map(|s| s.to_string());
            let jump = op.get("jump").and_then(Value::as_u64);
            let fail = op.get("fail").and_then(Value::as_u64);
            let len = op.get("len").and_then(Value::as_u64).unwrap_or(0) as u32;
            ops.push(Instruction {
                addr: op_addr,
                disasm,
                bytes,
                kind,
                jump,
                fail,
                len,
            });
        }
        Ok(Disassembly {
            addr,
            name: final_name,
            size,
            ops,
        })
    }

    fn function_graph(&self, addr: u64) -> Result<FunctionGraph, String> {
        let res = self.call("graph", json!({ "addr": addr }))?;
        let name = res
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let renames = self.renames.lock().unwrap_or_else(|e| e.into_inner());
        let final_name = renames.get(&addr).cloned().unwrap_or(name);
        let blocks_val = res
            .get("blocks")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut blocks = Vec::new();
        for b in blocks_val {
            let b_addr = b.get("addr").and_then(Value::as_u64).unwrap_or(0);
            let ninstr = b.get("ninstr").and_then(Value::as_u64).unwrap_or(0);
            let jump = b.get("jump").and_then(Value::as_u64);
            let fail = b.get("fail").and_then(Value::as_u64);
            let targets = b
                .get("targets")
                .and_then(Value::as_array)
                .map(|arr| arr.iter().filter_map(Value::as_u64).collect())
                .unwrap_or_default();
            let ops_val = b
                .get("ops")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let mut ops = Vec::new();
            for op in ops_val {
                let op_addr = op.get("addr").and_then(Value::as_u64).unwrap_or(0);
                let disasm = op
                    .get("disasm")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let bytes = op
                    .get("bytes")
                    .and_then(Value::as_str)
                    .map(|s| s.to_string());
                let kind = op
                    .get("type")
                    .and_then(Value::as_str)
                    .map(|s| s.to_string());
                let op_jump = op.get("jump").and_then(Value::as_u64);
                let op_fail = op.get("fail").and_then(Value::as_u64);
                let len = op.get("len").and_then(Value::as_u64).unwrap_or(0) as u32;
                ops.push(Instruction {
                    addr: op_addr,
                    disasm,
                    bytes,
                    kind,
                    jump: op_jump,
                    fail: op_fail,
                    len,
                });
            }
            blocks.push(BasicBlock {
                addr: b_addr,
                ninstr,
                jump,
                fail,
                targets,
                ops,
            });
        }
        Ok(FunctionGraph {
            addr,
            name: final_name,
            blocks,
        })
    }

    fn strings(&self) -> Result<Vec<StringRef>, String> {
        let res = self.call("strings", json!({ "limit": 10000 }))?;
        let items = res
            .get("strings")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        let mut out = Vec::new();
        for item in items {
            let addr = item.get("addr").and_then(Value::as_u64).unwrap_or(0);
            let value = item
                .get("value")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            out.push(StringRef {
                addr,
                string: value,
                kind: Some("utf8".to_string()),
            });
        }
        Ok(out)
    }

    fn imports(&self) -> Result<Vec<Import>, String> {
        let res = self.call("imports", json!({ "limit": 10000 }))?;
        let items = res
            .get("imports")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut out = Vec::new();
        for item in items {
            let name = item
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let plt = item.get("plt").and_then(Value::as_u64);
            let bind = item.get("bind").and_then(Value::as_str).map(str::to_string);
            let kind = item.get("kind").and_then(Value::as_str).map(str::to_string);
            out.push(Import {
                name,
                plt,
                bind,
                kind,
            });
        }
        Ok(out)
    }

    fn xrefs(&self, target: &Target, direction: XrefDirection) -> Result<Vec<Xref>, String> {
        let addr = match target {
            Target::Addr(a) => *a,
            Target::Symbol(s) => self.resolve(s)?.unwrap_or(0),
        };
        let dir_str = match direction {
            XrefDirection::To => "to",
            XrefDirection::From => "from",
        };
        let res = self.call(
            "xrefs",
            json!({ "addr": addr, "direction": dir_str, "limit": 200 }),
        )?;
        let items = res
            .get("xrefs")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut out = Vec::new();
        for item in items {
            let from = item.get("from").and_then(Value::as_u64).unwrap_or(0);
            let to = item.get("to").and_then(Value::as_u64);
            let kind = item
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("code")
                .to_string();
            let fcn_name = item
                .get("fcn_name")
                .and_then(Value::as_str)
                .map(|s| s.to_string());
            let opcode = item
                .get("opcode")
                .and_then(Value::as_str)
                .map(|s| s.to_string());
            out.push(Xref {
                from,
                kind,
                to,
                fcn_name,
                opcode,
            });
        }
        Ok(out)
    }

    fn decompile(&self, addr: u64) -> Result<Decompilation, String> {
        let res = self.call("decompile", json!({ "addr": addr }))?;
        if let Some(err) = res.get("error").and_then(Value::as_str) {
            return Err(err.to_string());
        }

        let name = res
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        let code = res
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();

        Ok(Decompilation {
            addr,
            name,
            code,
            annotations: Vec::new(),
        })
    }

    fn raw(&self, _cmd: &str) -> Result<Value, String> {
        Err("raw IDA Python execution is disabled for safety".to_string())
    }

    fn read_bytes(&self, addr: u64, len: usize) -> Result<Vec<u8>, String> {
        if len > IDA_MAX_READ_BYTES {
            return Err(format!(
                "IDA read exceeds the {IDA_MAX_READ_BYTES}-byte safety limit"
            ));
        }
        let res = self.call("read_bytes", json!({ "addr": addr, "len": len }))?;
        let hex_str = res.get("bytes").and_then(Value::as_str).unwrap_or("");
        let mut bytes = Vec::new();
        for i in (0..hex_str.len()).step_by(2) {
            if i + 2 <= hex_str.len() {
                if let Ok(b) = u8::from_str_radix(&hex_str[i..i + 2], 16) {
                    bytes.push(b);
                }
            }
        }
        Ok(bytes)
    }

    fn resolve(&self, name: &str) -> Result<Option<u64>, String> {
        // Check analyst renames first
        {
            let renames = self.renames.lock().unwrap_or_else(|e| e.into_inner());
            for (&addr, n) in renames.iter() {
                if n == name {
                    return Ok(Some(addr));
                }
            }
        }
        let res = self.call("resolve", json!({ "name": name }))?;
        if let Some(ea) = res.get("addr").and_then(Value::as_u64) {
            return Ok(Some(ea));
        }
        // Fallback to checking functions
        if let Ok(funcs) = self.functions() {
            for f in funcs {
                if f.name == name {
                    return Ok(Some(f.addr));
                }
            }
        }
        Ok(None)
    }

    fn set_renames(&self, renames: HashMap<u64, String>) {
        for (addr, name) in &renames {
            let _ = self.call("rename", json!({ "addr": addr, "name": name }));
        }
        let mut guard = self.renames.lock().unwrap_or_else(|e| e.into_inner());
        *guard = renames;
    }

    fn write_bytes(&self, addr: u64, bytes: &[u8]) -> Result<(), String> {
        if bytes.is_empty() {
            return Ok(());
        }
        let data = std::fs::read(&self.path)
            .map_err(|e| format!("failed to read binary {}: {e}", self.path.display()))?;
        let file =
            object::File::parse(&*data).map_err(|e| format!("failed to parse binary: {e}"))?;
        let len = bytes.len() as u64;
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
        use std::io::{Seek, SeekFrom};
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .open(&self.path)
            .map_err(|e| format!("open {} for writing: {e}", self.path.display()))?;
        f.seek(SeekFrom::Start(file_offset))
            .map_err(|e| format!("seek to 0x{file_offset:x}: {e}"))?;
        f.write_all(bytes)
            .map_err(|e| format!("write {} byte(s) at 0x{file_offset:x}: {e}", bytes.len()))?;

        // Also patch bytes in IDA database
        for (i, &b) in bytes.iter().enumerate() {
            let result = self.call("write_byte", json!({ "addr": addr + i as u64, "value": b }))?;
            if result.get("success").and_then(Value::as_bool) != Some(true) {
                return Err(format!(
                    "IDA failed to patch byte at {:#x}",
                    addr + i as u64
                ));
            }
        }

        Ok(())
    }

    fn pid(&self) -> u32 {
        self.pid.load(Ordering::SeqCst)
    }

    fn interrupt(&self) -> bool {
        crate::signals::interrupt(self.pid())
    }

    fn force_kill(&self) -> bool {
        crate::signals::terminate(self.pid())
    }
}

impl Drop for IdaEngine {
    fn drop(&mut self) {
        let _ = self.call("quit", json!({}));
        if let Ok(mut child) = self._child.lock() {
            stop_child(&mut child);
        }
        let _ = std::fs::remove_dir_all(&self.session_dir);
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
    use super::*;

    #[test]
    fn check_dir_prefers_the_headless_idat_binary() {
        let dir =
            std::env::temp_dir().join(format!("recurse-ida-path-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create IDA path fixture");
        std::fs::write(dir.join("ida64"), b"gui").expect("write GUI fixture");
        std::fs::write(dir.join("idat64"), b"headless").expect("write headless fixture");
        assert_eq!(check_dir_for_ida(&dir), Some(dir.join("idat64")));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn find_ida_returns_valid_path_when_present() {
        if let Some(exe) = find_ida_executable() {
            assert!(exe.is_file(), "discovered IDA path must be a file");
        }
    }
}
