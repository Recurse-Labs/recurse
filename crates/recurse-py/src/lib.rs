//! Python bindings for `recurse_static::engine::Engine` — the idalib
//! equivalent for Recurse: headless binary analysis from Python with no IDA
//! seat, no license, and (for the `native` backend) no external tool at
//! all. Built as an `abi3-py38` extension module, so one compiled wheel
//! works across Python 3.8+ without a rebuild per interpreter version.
//!
//! ```python
//! import recurse_py
//! eng = recurse_py.Engine("/path/to/binary")   # backend="native" (default) or "r2"
//! eng.analyze()
//! for f in eng.functions()["items"]:
//!     print(hex(f["addr"]), f["name"])
//! print(eng.lift(eng.functions()["items"][0]["addr"])["vtil"])
//! ```
//!
//! One class, one generic method (`call`, mirroring the exact op vocabulary
//! `recurse-agent`'s tool runtime and `recurse-mcp` both use —
//! `crates/recurse-static/src/engine.rs`'s `execute_tool`) plus a handful of
//! convenience wrappers over it. Every non-`analyze` op returns the same
//! compact-JSON envelope shape those two other surfaces see, converted to
//! native Python `dict`/`list`/`str`/`int`/`float`/`bool`/`None` — never a
//! JSON string a caller has to parse again.

// pyo3 0.22's `#[pymethods]` expansion generates a `?`-propagated
// `PyErr::from(err)` for every fallible method, which clippy flags as a
// useless conversion when the function's own error type is already
// `PyErr` — triggered by macro output, not anything in this file.
#![allow(clippy::useless_conversion)]
use pyo3::exceptions::PyRuntimeError;
use pyo3::prelude::*;
use pyo3::types::{PyDict, PyList};
use std::path::PathBuf;

use recurse_static::engine::{self, BackendKind};
use recurse_static::{ida_backend, native, r2_backend};

fn to_pyerr(message: String) -> PyErr {
    PyRuntimeError::new_err(message)
}

/// Convert a [`serde_json::Value`] into the native Python object it means —
/// a `dict`/`list`/`str`/`int`/`float`/`bool`/`None`, never a JSON string a
/// caller has to parse again.
fn json_to_py(py: Python<'_>, value: &serde_json::Value) -> PyResult<PyObject> {
    match value {
        serde_json::Value::Null => Ok(py.None()),
        serde_json::Value::Bool(b) => Ok((*b).into_py(py)),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Ok(i.into_py(py))
            } else if let Some(u) = n.as_u64() {
                Ok(u.into_py(py))
            } else {
                Ok(n.as_f64().unwrap_or(0.0).into_py(py))
            }
        }
        serde_json::Value::String(s) => Ok(s.into_py(py)),
        serde_json::Value::Array(items) => {
            let list = PyList::empty_bound(py);
            for item in items {
                list.append(json_to_py(py, item)?)?;
            }
            Ok(list.into())
        }
        serde_json::Value::Object(map) => {
            let dict = PyDict::new_bound(py);
            for (key, item) in map {
                dict.set_item(key, json_to_py(py, item)?)?;
            }
            Ok(dict.into())
        }
    }
}

/// An open analysis session over one binary — a thin Python wrapper around
/// whichever [`engine::Engine`] backend it opened.
#[pyclass]
struct Engine {
    inner: Box<dyn engine::Engine>,
}

impl Engine {
    /// `op` through the exact same [`engine::execute_tool`] dispatcher
    /// `recurse-agent` and `recurse-mcp` use, so Python sees identical
    /// behavior (including error messages) to every other surface.
    fn run(&self, py: Python<'_>, op: &str, mut args: serde_json::Value) -> PyResult<PyObject> {
        if !args.is_object() {
            args = serde_json::json!({});
        }
        args["op"] = serde_json::Value::String(op.to_string());
        let out = engine::execute_tool(self.inner.as_ref(), &args).map_err(to_pyerr)?;
        let value: serde_json::Value =
            serde_json::from_str(&out).map_err(|e| to_pyerr(e.to_string()))?;
        json_to_py(py, &value)
    }
}

#[pymethods]
impl Engine {
    /// Open `path` with the named backend (`"native"`, pure Rust, the
    /// default; or `"r2"`, requires `r2` on `PATH`).
    #[new]
    #[pyo3(signature = (path, backend="native"))]
    fn new(path: String, backend: &str) -> PyResult<Self> {
        let kind = BackendKind::parse(backend).ok_or_else(|| {
            to_pyerr(format!(
                "unknown backend {backend:?} (expected \"native\" or \"r2\")"
            ))
        })?;
        let target = PathBuf::from(path);
        let inner: Box<dyn engine::Engine> = match kind {
            BackendKind::Native => Box::new(native::NativeEngine::open(&target).map_err(to_pyerr)?),
            BackendKind::R2 => Box::new(r2_backend::R2Engine::open(&target).map_err(to_pyerr)?),
            BackendKind::Ida => Box::new(ida_backend::IdaEngine::open(&target).map_err(to_pyerr)?),
        };
        Ok(Self { inner })
    }

    /// Which backend this session opened with (`"native"` or `"r2"`).
    fn backend(&self) -> &'static str {
        self.inner.backend().as_str()
    }

    /// Run the backend's analysis pass. Idempotent; call once before the
    /// other methods (they still work without it, just against a
    /// lazier/emptier index).
    fn analyze(&self) -> PyResult<()> {
        self.inner.analyze().map_err(to_pyerr)
    }

    /// Run one `op` from `crates/recurse-static/src/engine.rs`'s
    /// `execute_tool` vocabulary directly (`"functions"`, `"disasm"`,
    /// `"graph"`, `"lift"`, `"decompile"`, `"xrefs"`, `"strings"`,
    /// `"imports"`, `"info"`, `"raw"`), with `kwargs` passed straight
    /// through as the op's arguments (`addr`, `count`, `query`, `limit`,
    /// `direction`, `cmd`). The convenience methods below are thin
    /// wrappers over exactly this.
    #[pyo3(signature = (op, **kwargs))]
    fn call(
        &self,
        py: Python<'_>,
        op: &str,
        kwargs: Option<&Bound<'_, PyDict>>,
    ) -> PyResult<PyObject> {
        let args = match kwargs {
            Some(d) => py_dict_to_json(d)?,
            None => serde_json::json!({}),
        };
        self.run(py, op, args)
    }

    #[pyo3(signature = (query=None, limit=None))]
    fn functions(
        &self,
        py: Python<'_>,
        query: Option<&str>,
        limit: Option<u64>,
    ) -> PyResult<PyObject> {
        self.run(
            py,
            "functions",
            serde_json::json!({ "query": query, "limit": limit }),
        )
    }

    #[pyo3(signature = (addr, count=None))]
    fn disasm(&self, py: Python<'_>, addr: PyObject, count: Option<u64>) -> PyResult<PyObject> {
        self.run(
            py,
            "disasm",
            serde_json::json!({ "addr": py_addr_to_json(py, &addr)?, "count": count }),
        )
    }

    fn graph(&self, py: Python<'_>, addr: PyObject) -> PyResult<PyObject> {
        self.run(
            py,
            "graph",
            serde_json::json!({ "addr": py_addr_to_json(py, &addr)? }),
        )
    }

    /// Lift the function at `addr` into the VTIL-inspired IL and run its
    /// optimizer passes; see `docs/vtil-lift.md`.
    fn lift(&self, py: Python<'_>, addr: PyObject) -> PyResult<PyObject> {
        self.run(
            py,
            "lift",
            serde_json::json!({ "addr": py_addr_to_json(py, &addr)? }),
        )
    }

    /// Structuring decompiler pseudocode for the function at `addr`; see
    /// `crates/recurse-vtil/src/decompile.rs`. Available on every backend —
    /// `native` provides its own (`capabilities()["decompile"]` reflects
    /// this), not only `r2`.
    fn decompile(&self, py: Python<'_>, addr: PyObject) -> PyResult<PyObject> {
        self.run(
            py,
            "decompile",
            serde_json::json!({ "addr": py_addr_to_json(py, &addr)? }),
        )
    }

    #[pyo3(signature = (addr, direction="to"))]
    fn xrefs(&self, py: Python<'_>, addr: PyObject, direction: &str) -> PyResult<PyObject> {
        self.run(
            py,
            "xrefs",
            serde_json::json!({ "addr": py_addr_to_json(py, &addr)?, "direction": direction }),
        )
    }

    #[pyo3(signature = (query=None, limit=None))]
    fn strings(
        &self,
        py: Python<'_>,
        query: Option<&str>,
        limit: Option<u64>,
    ) -> PyResult<PyObject> {
        self.run(
            py,
            "strings",
            serde_json::json!({ "query": query, "limit": limit }),
        )
    }

    #[pyo3(signature = (query=None, limit=None))]
    fn imports(
        &self,
        py: Python<'_>,
        query: Option<&str>,
        limit: Option<u64>,
    ) -> PyResult<PyObject> {
        self.run(
            py,
            "imports",
            serde_json::json!({ "query": query, "limit": limit }),
        )
    }

    fn info(&self, py: Python<'_>) -> PyResult<PyObject> {
        self.run(py, "info", serde_json::json!({}))
    }

    /// Engine console passthrough; only available when `backend() == "r2"`.
    fn raw(&self, py: Python<'_>, cmd: &str) -> PyResult<PyObject> {
        self.run(py, "raw", serde_json::json!({ "cmd": cmd }))
    }

    /// Resolve a symbol name to an address, or `None` if the backend does
    /// not know it.
    fn resolve(&self, name: &str) -> PyResult<Option<u64>> {
        self.inner.resolve(name).map_err(to_pyerr)
    }

    fn __repr__(&self) -> String {
        format!(
            "Engine(path={:?}, backend={:?})",
            self.inner.path().display().to_string(),
            self.inner.backend().as_str()
        )
    }
}

/// A Python `addr` argument is either an int (a concrete address) or a str
/// (a symbol name, or `0x...`/decimal text) — accept both, matching
/// `engine::Target::from_json`'s own leniency.
fn py_addr_to_json(py: Python<'_>, addr: &PyObject) -> PyResult<serde_json::Value> {
    if let Ok(n) = addr.extract::<u64>(py) {
        return Ok(serde_json::Value::from(n));
    }
    if let Ok(s) = addr.extract::<String>(py) {
        return Ok(serde_json::Value::String(s));
    }
    Err(to_pyerr("addr must be an int or a str".to_string()))
}

/// Convert a Python `**kwargs` dict into a [`serde_json::Value`] object,
/// for [`Engine::call`]'s pass-through arguments.
fn py_dict_to_json(dict: &Bound<'_, PyDict>) -> PyResult<serde_json::Value> {
    let mut map = serde_json::Map::new();
    for (key, value) in dict.iter() {
        let key: String = key.extract()?;
        map.insert(key, py_value_to_json(&value)?);
    }
    Ok(serde_json::Value::Object(map))
}

fn py_value_to_json(value: &Bound<'_, PyAny>) -> PyResult<serde_json::Value> {
    if value.is_none() {
        return Ok(serde_json::Value::Null);
    }
    if let Ok(b) = value.extract::<bool>() {
        return Ok(serde_json::Value::Bool(b));
    }
    if let Ok(i) = value.extract::<i64>() {
        return Ok(serde_json::Value::from(i));
    }
    if let Ok(f) = value.extract::<f64>() {
        return Ok(serde_json::json!(f));
    }
    if let Ok(s) = value.extract::<String>() {
        return Ok(serde_json::Value::String(s));
    }
    Err(to_pyerr(format!(
        "unsupported argument type for {value:?}; use int/float/str/bool/None"
    )))
}

#[pymodule]
fn recurse_py(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_class::<Engine>()?;
    m.add("__version__", env!("CARGO_PKG_VERSION"))?;
    Ok(())
}
