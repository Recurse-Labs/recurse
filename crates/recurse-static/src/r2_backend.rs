//! The r2 (radare2) engine behind the [`Engine`] seam.
//!
//! [`R2Engine`] owns one long-lived [`Session`] (the `-q0` pipe) and
//! translates each backend-neutral operation into the command that answers
//! it, parsing the JSON back into the canonical result types. Nothing in the
//! agent or UI depends on engine syntax any more; `raw` is the only method that
//! speaks it, by design.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use serde_json::Value;

use crate::engine::{
    BackendKind, Capabilities, Decompilation, Disassembly, Engine, FunctionGraph, FunctionInfo,
    Import, Instruction, StringRef, Target, Xref, XrefDirection,
};
use crate::r2::{tidy, Session};

/// The external-engine implementation of [`Engine`].
pub struct R2Engine {
    session: Mutex<Session>,
    path: PathBuf,
    pid: AtomicU32,
}

impl R2Engine {
    /// Spawn r2 on `path` and return a ready engine. The child's pid is
    /// captured immediately so [`Engine::interrupt`] works even while a
    /// command holds the session lock.
    ///
    /// ```no_run
    /// use recurse_static::r2_backend::R2Engine;
    /// use recurse_static::engine::Engine;
    /// let e = R2Engine::open(std::path::Path::new("/bin/true")).unwrap();
    /// assert!(e.pid() > 0);
    /// ```
    pub fn open(path: &Path) -> Result<Self, String> {
        let session = Session::open(path)?;
        let pid = session.pid();
        Ok(Self {
            session: Mutex::new(session),
            path: path.to_path_buf(),
            pid: AtomicU32::new(pid),
        })
    }

    /// Run one raw engine command and return its tidied text output.
    fn run_text(&self, cmd: &str) -> Result<String, String> {
        let mut guard = self
            .session
            .lock()
            .map_err(|e| format!("engine session poisoned: {e}"))?;
        guard.run(cmd).map(|raw| tidy(&raw))
    }

    /// Run a `*j` command and parse the JSON array it returns.
    fn run_array(&self, cmd: &str) -> Result<Vec<Value>, String> {
        let text = self.run_text(cmd)?;
        if text.trim().is_empty() {
            return Ok(Vec::new());
        }
        match serde_json::from_str::<Value>(&text) {
            Ok(Value::Array(items)) => Ok(items),
            Ok(Value::Null) => Ok(Vec::new()),
            Ok(other) => Ok(vec![other]),
            Err(e) => Err(format!("engine `{cmd}` returned non-JSON: {e}")),
        }
    }

    /// Run a `*j` command and parse the single JSON object it returns.
    fn run_object(&self, cmd: &str) -> Result<Value, String> {
        let text = self.run_text(cmd)?;
        if text.trim().is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str::<Value>(&text)
            .map_err(|e| format!("r2 `{cmd}` returned non-JSON: {e}"))
    }

    /// Turn a [`Target`] into the operand expression that names it (`0x..` or the
    /// symbol verbatim, which the engine resolves itself).
    fn expr(target: &Target) -> String {
        match target {
            Target::Addr(a) => format!("{a:#x}"),
            Target::Symbol(s) => s.clone(),
        }
    }

    /// Parse one function object from `aflj`/`afij`.
    fn function_from(value: &Value) -> Option<FunctionInfo> {
        let addr = value.get("addr").and_then(Value::as_u64)?;
        let name = value
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        Some(FunctionInfo {
            addr,
            name,
            size: value.get("size").and_then(Value::as_u64),
            nbbs: value.get("nbbs").and_then(Value::as_u64),
            edges: value.get("edges").and_then(Value::as_u64),
            signature: value
                .get("signature")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string),
        })
    }

    /// Parse one instruction from `pdj`/`pdfj`.
    fn instruction_from(value: &Value) -> Option<Instruction> {
        let addr = value.get("addr").and_then(Value::as_u64)?;
        let disasm = value
            .get("disasm")
            .or_else(|| value.get("opcode"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        Some(Instruction {
            addr,
            disasm,
            bytes: value
                .get("bytes")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string),
            kind: value
                .get("type")
                .and_then(Value::as_str)
                .map(str::to_string),
            jump: value.get("jump").and_then(Value::as_u64),
            fail: value.get("fail").and_then(Value::as_u64),
            len: 0,
        })
    }
}

impl Engine for R2Engine {
    fn backend(&self) -> BackendKind {
        BackendKind::R2
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            decompile: true,
            raw: true,
            graph: true,
            xrefs_from: true,
        }
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn analyze(&self) -> Result<(), String> {
        let mut guard = self
            .session
            .lock()
            .map_err(|e| format!("r2 session poisoned: {e}"))?;
        guard.warm_up()
    }

    fn summary(&self) -> Result<Value, String> {
        let info = self.info()?;
        let function_count = self.run_text("aflc").ok().and_then(|t| {
            t.trim()
                .parse::<usize>()
                .ok()
                .or_else(|| self.functions().ok().map(|f| f.len()))
        });
        let function_count = function_count.unwrap_or(0);
        let string_count = self
            .run_text("izzc")
            .ok()
            .and_then(|t| t.trim().parse::<usize>().ok())
            .unwrap_or(0);
        Ok(serde_json::json!({
            "path": self.path.to_string_lossy(),
            "info": info,
            "function_count": function_count,
            "string_count": string_count,
        }))
    }

    fn info(&self) -> Result<Value, String> {
        self.run_object("ij")
    }

    fn functions(&self) -> Result<Vec<FunctionInfo>, String> {
        Ok(self
            .run_array("aflj")?
            .iter()
            .filter_map(Self::function_from)
            .collect())
    }

    fn function_at(&self, addr: u64) -> Result<Option<FunctionInfo>, String> {
        let v = self.run_object(&format!("afij @ {addr:#x}"))?;
        if v.is_null() || v.as_object().map(|o| o.is_empty()).unwrap_or(true) {
            return Ok(None);
        }
        Ok(Self::function_from(&v))
    }

    fn disassemble(&self, target: &Target, count: Option<usize>) -> Result<Disassembly, String> {
        let expr = Self::expr(target);
        let cmd = match count {
            Some(n) => format!("pdj {n} @ {expr}"),
            None => format!("pdfj @ {expr}"),
        };
        let v = self.run_object(&cmd)?;
        let ops: Vec<Instruction> = v
            .get("ops")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Self::instruction_from).collect())
            .unwrap_or_default();
        let addr = v
            .get("addr")
            .and_then(Value::as_u64)
            .or_else(|| target.to_u64())
            .unwrap_or(0);
        let name = v
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        Ok(Disassembly {
            addr,
            name,
            size: v.get("size").and_then(Value::as_u64),
            ops,
        })
    }

    fn function_disasm(&self, addr: u64) -> Result<Disassembly, String> {
        self.disassemble(&Target::Addr(addr), None)
    }

    fn function_graph(&self, addr: u64) -> Result<FunctionGraph, String> {
        let v = self.run_object(&format!("agfj @ {addr:#x}"))?;
        // `agfj` returns `[{...}]`; a plain object is also accepted.
        let root = match v {
            Value::Array(items) => items.into_iter().next().unwrap_or(Value::Null),
            other => other,
        };
        let name = root
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let blocks = root
            .get("blocks")
            .and_then(Value::as_array)
            .map(|blocks| {
                blocks
                    .iter()
                    .map(|b| {
                        let ops: Vec<Instruction> = b
                            .get("ops")
                            .and_then(Value::as_array)
                            .map(|a| a.iter().filter_map(Self::instruction_from).collect())
                            .unwrap_or_default();
                        crate::engine::BasicBlock {
                            addr: b.get("addr").and_then(Value::as_u64).unwrap_or(0),
                            ninstr: b
                                .get("ninstr")
                                .and_then(Value::as_u64)
                                .unwrap_or(ops.len() as u64),
                            jump: b.get("jump").and_then(Value::as_u64),
                            fail: b.get("fail").and_then(Value::as_u64),
                            targets: Vec::new(),
                            ops,
                        }
                    })
                    .collect()
            })
            .unwrap_or_default();
        Ok(FunctionGraph { addr, name, blocks })
    }

    fn strings(&self) -> Result<Vec<StringRef>, String> {
        Ok(self
            .run_array("izzj")?
            .iter()
            .filter_map(|v| {
                let addr = v.get("vaddr").and_then(Value::as_u64)?;
                Some(StringRef {
                    addr,
                    string: v
                        .get("string")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    kind: v.get("type").and_then(Value::as_str).map(str::to_string),
                })
            })
            .collect())
    }

    fn imports(&self) -> Result<Vec<Import>, String> {
        Ok(self
            .run_array("iij")?
            .iter()
            .filter_map(|v| {
                let name = v.get("name").and_then(Value::as_str)?.to_string();
                Some(Import {
                    name,
                    plt: v.get("plt").and_then(Value::as_u64),
                    bind: v.get("bind").and_then(Value::as_str).map(str::to_string),
                    kind: v.get("type").and_then(Value::as_str).map(str::to_string),
                })
            })
            .collect())
    }

    fn xrefs(&self, target: &Target, direction: XrefDirection) -> Result<Vec<Xref>, String> {
        let expr = Self::expr(target);
        let cmd = match direction {
            XrefDirection::To => format!("axtj @ {expr}"),
            XrefDirection::From => format!("axfj @ {expr}"),
        };
        let to = target.to_u64();
        Ok(self
            .run_array(&cmd)?
            .iter()
            .filter_map(|v| {
                let from = v.get("from").and_then(Value::as_u64)?;
                Some(Xref {
                    from,
                    kind: v
                        .get("type")
                        .and_then(Value::as_str)
                        .unwrap_or("ref")
                        .to_string(),
                    to: v.get("to").and_then(Value::as_u64).or(to),
                    fcn_name: v
                        .get("fcn_name")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    opcode: v.get("opcode").and_then(Value::as_str).map(str::to_string),
                })
            })
            .collect())
    }

    fn decompile(&self, addr: u64) -> Result<Decompilation, String> {
        let mut text = self.run_text(&format!("pdg @ {addr:#x}")).unwrap_or_default();
        if text.trim().is_empty() || text.contains("install the plugin with r2pm") {
            text = self.run_text(&format!("pdd @ {addr:#x}")).unwrap_or_default();
        }
        if text.trim().is_empty() || text.contains("install the plugin with r2pm") {
            text = self.run_text(&format!("pdc @ {addr:#x}")).unwrap_or_default();
        }
        if text.trim().is_empty() {
            return Err("decompiler produced no output (is r2ghidra or r2dec installed?)".into());
        }
        let name = self
            .function_at(addr)?
            .map(|f| f.name)
            .unwrap_or_else(|| format!("fcn.{addr:x}"));
        Ok(Decompilation {
            addr,
            name,
            code: text,
            annotations: Vec::new(),
        })
    }

    fn raw(&self, cmd: &str) -> Result<Value, String> {
        let text = self.run_text(cmd)?;
        Ok(serde_json::from_str::<Value>(&text).unwrap_or(Value::String(text)))
    }

    fn resolve(&self, name: &str) -> Result<Option<u64>, String> {
        let text = self.run_text(&format!("s {name}; ?v $$"))?;
        Ok(text.lines().last().and_then(parse_number))
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

/// Parse a number the engine prints in decimal or `0x` hex form.
fn parse_number(line: &str) -> Option<u64> {
    let t = line.trim();
    if let Some(hex) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        u64::from_str_radix(hex, 16).ok()
    } else {
        t.parse::<u64>().ok()
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
    use super::*;

    #[test]
    fn parses_r2_numbers_in_both_bases() {
        assert_eq!(parse_number("4437"), Some(4437));
        assert_eq!(parse_number("0x1149"), Some(0x1149));
        assert_eq!(parse_number("not a number"), None);
    }

    #[test]
    fn expr_prefers_hex_for_addresses() {
        assert_eq!(R2Engine::expr(&Target::Addr(0x1149)), "0x1149");
        assert_eq!(R2Engine::expr(&Target::Symbol("main".into())), "main");
    }
}
