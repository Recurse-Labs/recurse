# Binary diffing (`recurse_static::diff`)

`crates/recurse-static/src/diff.rs` matches functions between two
versions/builds of a binary by *shape*, not address — the same "which
function in the patched build corresponds to which function in the
pre-patch build, even though everything got relocated and renumbered" job
as BinDiff/Diaphora. The classic patch-diffing use case: find what a
security patch actually touched by diffing the patched binary against the
pre-patch one.

```rust
use recurse_static::diff::{diff, normalize_mnemonics, FunctionSummary};

let old = FunctionSummary {
    address: 0x1000,
    name: "parse_header".into(),
    normalized_instructions: normalize_mnemonics(&old_disasm_lines),
    calls: vec![],
};
let new = FunctionSummary {
    address: 0x4000,
    name: "sub_4000".into(),
    normalized_instructions: normalize_mnemonics(&new_disasm_lines),
    calls: vec![],
};
let result = diff(&[old], &[new]);
for m in &result.matched {
    println!("{:#x} ({}) -> {:#x} ({}): {:?} {:.2}", m.a, m.name_a, m.b, m.name_b, m.method, m.confidence);
}
println!("removed: {:?}  added: {:?}", result.removed, result.added);
```

## Design: decoupled from any particular disassembler

This module takes plain `FunctionSummary` values, not an `Engine` or raw
binary bytes — the caller extracts a normalized instruction shape from
whichever backend (native/r2/ida) they're already using. That keeps the
*matching algorithm* testable with hand-built inputs, independent of
disassembly, and reusable across all three `Engine` backends this crate
has without adding a fourth dependency direction. `normalize_mnemonics` is
the suggested way to build that shape from raw `"mnemonic operand, ..."`
disassembly text: it strips immediates/addresses (which differ across any
two builds even for byte-identical logic — a relocated call target, a
different stack-cookie constant) down to an `"imm"` placeholder, while
keeping register names (which usually *do* matter to whether logic
changed).

## Matching passes

1. **Exact** — functions whose full normalized-mnemonic sequence hashes
   identically. Confidence `1.0`: genuinely unchanged code, just
   moved/renamed/relinked.
2. **Fuzzy** — for everything exact matching leaves unmatched, greedy
   best-first pairing by normalized-mnemonic-sequence similarity (a
   longest-common-subsequence ratio — sequence *order* matters, so this
   survives an instruction inserted or deleted in the middle of a
   function, not just a same-length single-opcode edit) above
   `FUZZY_THRESHOLD` (0.6). This is what finds "this function gained a
   bounds check" or "this function lost an early return" across a patch.
   Matching is injective (greedy, strongest pairs claimed first) so one
   function in `a` never claims two functions in `b`.

Anything left over is reported as `removed` (only in `a`) or `added`
(only in `b`) rather than force-matched to a poor candidate — the same
"no match beats a bad match" philosophy `crate::sig`'s
`min_concrete_bytes` threshold uses.

## Honest scope

- **No call-graph confidence propagation** (BinDiff's "MD index"
  technique: a function's match confidence rises when its callers and
  callees are already known-matched). `FunctionSummary::calls` is carried
  through so a caller can build that on top, but this module's own
  matcher only looks at instruction shape. Real, scoped follow-up work.
- **No basic-block/CFG-shape matching**, only whole-function linear
  instruction sequences. Follow-up work for functions where block
  *reordering* (not content change) is the only difference.
- **Not wired into `Engine`/`analyze` yet** — a standalone, fully-tested
  library capability first, same path every other Tier-2 module here
  took.

## Trying it

```bash
cargo test -p recurse-static diff::
```

7 tests, including:
`identical_function_relocated_matches_exactly` (exact pass, address- and
name-independent), `a_patched_function_with_an_inserted_bounds_check_fuzzy_matches`
(fuzzy pass catches a real mid-function insertion),
`a_genuinely_new_function_is_reported_added_not_force_matched` /
`a_removed_function_is_reported_removed_not_force_matched` (unmatched
functions go to `added`/`removed`, never a forced weak pairing),
`completely_unrelated_functions_do_not_fuzzy_match` (the threshold
actually rejects dissimilar functions), plus direct `lcs_ratio`/
`normalize_mnemonics` unit tests.
