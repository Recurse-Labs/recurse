//! Network-backed consistency checks against a real stripped release binary.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use recurse_static::native;
use serde_json::Value;

const YOUKI_URL: &str =
    "https://github.com/youki-dev/youki/releases/download/v0.7.0/youki-0.7.0-x86_64-gnu.tar.gz";

/// Download and unpack the pinned Youki release once, reusing the fixture cache.
fn download_youki() -> PathBuf {
    let root = std::env::var_os("RECURSE_LARGE_BINARY_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("recurse-large-binary-tests"));
    fs::create_dir_all(&root).expect("create large-binary fixture directory");
    let binary = root.join("youki-v0.7.0");
    if binary
        .metadata()
        .map(|m| m.len() > 1_000_000)
        .unwrap_or(false)
    {
        return binary;
    }
    let archive = root.join("youki-v0.7.0.tar.gz");
    let url = std::env::var("RECURSE_LARGE_BINARY_URL").unwrap_or_else(|_| YOUKI_URL.to_string());
    let status = Command::new("curl")
        .args(["-fL", "--retry", "3", "--max-time", "180", "-o"])
        .arg(&archive)
        .arg(&url)
        .status()
        .expect("curl is required for the network integration test");
    assert!(status.success(), "failed to download {url}");
    let status = Command::new("tar")
        .args(["-xzf"])
        .arg(&archive)
        .arg("-C")
        .arg(&root)
        .status()
        .expect("tar is required for the network integration test");
    assert!(status.success(), "failed to unpack {url}");
    let extracted = root.join("youki");
    fs::rename(extracted, &binary).expect("install unpacked Youki fixture");
    binary
}

struct R2Pipe {
    child: Child,
    stdin: ChildStdin,
    stdout: ChildStdout,
}

impl R2Pipe {
    /// Open a binary through radare2's native r2pipe protocol.
    fn open(binary: &Path) -> Result<Self, String> {
        let mut child = Command::new("r2")
            .args(["-q0"])
            .arg(binary)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("start r2pipe: {e}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "r2pipe stdin unavailable".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "r2pipe stdout unavailable".to_string())?;
        Ok(Self {
            child,
            stdin,
            stdout,
        })
    }

    /// Run one JSON command and return its decoded response.
    fn command(&mut self, command: &str) -> Result<Value, String> {
        self.stdin
            .write_all(command.as_bytes())
            .and_then(|_| self.stdin.write_all(b"\n"))
            .and_then(|_| self.stdin.flush())
            .map_err(|e| format!("write r2pipe command: {e}"))?;
        let mut response = Vec::new();
        loop {
            let mut byte = [0u8; 1];
            self.stdout
                .read_exact(&mut byte)
                .map_err(|e| format!("read r2pipe response: {e}"))?;
            if byte[0] == 0 {
                if response.is_empty() {
                    continue;
                }
                break;
            }
            response.push(byte[0]);
        }
        serde_json::from_slice(&response).map_err(|e| format!("decode r2pipe response: {e}"))
    }
}

impl Drop for R2Pipe {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Parse the instruction bytes emitted by objdump into an address-indexed map.
fn objdump_instruction_bytes(binary: &Path) -> HashMap<u64, String> {
    let output = Command::new("objdump")
        .args(["-d", "-M", "intel", "--insn-width=16"])
        .arg(binary)
        .output()
        .expect("objdump is required for the network integration test");
    assert!(output.status.success(), "objdump failed");
    let text = String::from_utf8(output.stdout).expect("objdump output is UTF-8");
    let mut instructions = HashMap::new();
    for line in text.lines() {
        let Some((address, rest)) = line.split_once(':') else {
            continue;
        };
        let Ok(address) = u64::from_str_radix(address.trim(), 16) else {
            continue;
        };
        let bytes: Vec<&str> = rest
            .split_whitespace()
            .take_while(|token| {
                token.len() <= 2 && token.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
            .collect();
        if !bytes.is_empty() {
            instructions.insert(address, bytes.join(""));
        }
    }
    instructions
}

/// Check raw bytes, function boundaries, and every decoded instruction against objdump and r2pipe.
#[cfg(target_os = "linux")]
#[test]
#[ignore = "downloads a pinned large release binary; run with --ignored"]
fn large_stripped_binary_matches_objdump_and_r2pipe() {
    if Command::new("objdump").arg("--version").output().is_err() {
        eprintln!("skipping: objdump is not installed");
        return;
    }
    let path = download_youki();
    let engine = native::open(&path).expect("open downloaded Youki binary");
    engine.functions().expect("start Youki discovery");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(120);
    while engine.indexing() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    assert!(!engine.indexing(), "background indexing did not settle");
    let functions = engine
        .functions()
        .expect("discover settled Youki functions");
    assert!(functions.len() > 1_000, "fixture is not a large binary");

    let mut candidates = BTreeMap::new();
    for (index, function) in functions.iter().enumerate() {
        if index % 29 == 0 || function.size.is_some_and(|size| size <= 64) {
            candidates.insert(function.addr, function.clone());
        }
    }
    for name in ["entry0", "main"] {
        if let Some(function) = functions.iter().find(|f| f.name == name) {
            candidates.insert(function.addr, function.clone());
        }
    }
    let candidates: Vec<_> = candidates.into_values().take(512).collect();
    let objdump = objdump_instruction_bytes(&path);
    let mut r2pipe = match R2Pipe::open(&path) {
        Ok(connection) => Some(connection),
        Err(error) => {
            if std::env::var_os("RECURSE_REQUIRE_R2PIPE").is_some() {
                panic!("{error}");
            }
            eprintln!("skipping r2pipe comparison: {error}");
            None
        }
    };
    let mut compared = 0usize;

    for function in candidates {
        let size = function.size.expect("test fixture functions have bounds");
        let end = function
            .addr
            .checked_add(size)
            .expect("fixture address range");
        let raw = engine
            .read_bytes(
                function.addr,
                usize::try_from(size).expect("fixture size fits usize"),
            )
            .expect("read complete function bytes");
        assert_eq!(raw.len() as u64, size, "raw bytes for {:#x}", function.addr);
        let disassembly = engine
            .function_disasm(function.addr)
            .expect("decode function");
        assert_eq!(disassembly.addr, function.addr);
        if let Some(connection) = r2pipe.as_mut() {
            for op in &disassembly.ops {
                let Some(op_bytes) = op.bytes.as_deref() else {
                    continue;
                };
                let actual = connection
                    .command(&format!("aoj 1 @ {:#x}", op.addr))
                    .and_then(|value| {
                        value
                            .as_array()
                            .and_then(|ops| ops.first().cloned())
                            .ok_or_else(|| "r2pipe aoj did not return an instruction".to_string())
                    })
                    .unwrap_or_else(|error| panic!("r2pipe aoj failed at {:#x}: {error}", op.addr));
                assert_eq!(
                    op_bytes.replace(' ', ""),
                    actual
                        .get("bytes")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                    "r2pipe instruction bytes differ at {:#x}",
                    op.addr
                );
            }
        }
        for op in &disassembly.ops {
            assert!(
                op.addr >= function.addr && op.addr < end,
                "instruction {:#x} escaped {:#x}..{:#x}",
                op.addr,
                function.addr,
                end
            );
            let Some(op_bytes) = op.bytes.as_deref() else {
                continue;
            };
            let expected = objdump
                .get(&op.addr)
                .unwrap_or_else(|| panic!("objdump has no instruction at {:#x}", op.addr));
            assert_eq!(
                op_bytes.replace(' ', ""),
                *expected,
                "instruction bytes differ at {:#x}",
                op.addr
            );
            compared += 1;
        }
    }
    assert!(
        compared > 100,
        "comparison did not cover enough instructions"
    );
}
