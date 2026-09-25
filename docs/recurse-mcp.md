# `recurse-mcp` — standalone MCP server

`cargo run -p recurse-mcp -- <binary-path> [--backend native|r2|ida]` opens one
binary with `recurse_static`'s `Engine` and serves it over
[MCP](https://modelcontextprotocol.io) (stdio, JSON-RPC 2.0, one object per
line) until stdin closes. No Tauri, no desktop UI, no IDA seat, no Python
bridge — any MCP-capable agent (Claude Code, Cursor, Claude Desktop, a
custom harness) points straight at the binary and drives the exact same
native (or r2 / ida) engine `recurse-agent`'s bundled chat panel uses.

## Why this exists

"IDA Pro MCP"-style projects wrap IDA's Python API in an MCP server so an
external agent can drive a *running IDA GUI instance* over the network.
`recurse-mcp` is the more direct version of that idea: the engine is already
a Rust trait with no GUI dependency (`crates/recurse-static/src/engine.rs`),
so the MCP server is a ~250-line stdio loop around it, not a bridge into
someone else's process. No license, no Python interpreter, no IDA install —
`cargo install --path crates/recurse-mcp` (or a prebuilt binary) is the
entire setup.

## Configure a client

Claude Code / Claude Desktop / Cursor `mcpServers` config:

```json
{
  "mcpServers": {
    "recurse": {
      "command": "recurse-mcp",
      "args": ["/path/to/target-binary"]
    }
  }
}
```

Add `"--backend", "r2"` (or `"ida"`) to `args` to drive an alternative engine
instead of native (see [backends.md](backends.md)).

## Protocol surface

- `initialize` — protocol version `2024-11-05`, `{"capabilities":{"tools":{}}}`.
- `tools/list` — **exactly one** tool, `analyze` (Recurse's own
  backend-neutral tool; see `docs/backends.md`), never a tool-per-op
  menagerie. Its `inputSchema` is generated from the same
  `engine::tool_schema` the bundled agent uses, filtered by the opened
  engine's `capabilities()` — `raw`/`decompile` only appear when the
  selected backend actually provides them.
- `tools/call` — dispatches through `engine::execute_tool`. A tool-side
  failure (bad address, unsupported op) comes back as
  `{"content":[...], "isError": true}` per the MCP spec, not a JSON-RPC
  protocol error — those are reserved for a malformed request (unknown
  method, unknown tool name, bad JSON).
- `notifications/*` (`initialized`, `cancelled`, …) are accepted and never
  answered, per JSON-RPC (a notification has no `id` to reply to).

## Trying it

```bash
cargo test -p recurse-mcp
cargo run -p recurse-mcp -- ./some-binary
```

Then, on stdin:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"analyze","arguments":{"op":"functions","limit":5}}}
```

`crates/recurse-mcp/src/lib.rs` has the protocol test suite (`initialize`,
notification silence, `tools/list` capability filtering, `tools/call`
dispatch and error shaping) — pure logic over a stub `Engine`, no process or
real binary needed.
