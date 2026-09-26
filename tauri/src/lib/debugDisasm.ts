import type { DebugInsn } from "@/types";

/** How many instructions one `disasm` call asks the backend for. */
export const DISASM_WINDOW = 48;

/** Instructions kept below the program counter in the CPU view. */
export const DISASM_AFTER = 48;

/**
 * Forward coverage below the pc that suppresses a refetch. Stepping forward
 * inside an already-decoded window therefore renders instantly from the cache
 * and never blanks; only a pc at the edge of what we have (or somewhere new)
 * costs a round trip.
 */
export const DISASM_MIN_FORWARD = 16;

/** Instructions retained per session before the lowest addresses are evicted. */
export const DISASM_MAX = 20000;

/** Longest instruction on any architecture recurse decodes, so a backward walk never scans further. */
const MAX_INSN_BYTES = 16;

/** Instructions decoded from the debuggee's memory this session, keyed by address. */
export type DisasmCache = ReadonlyMap<number, DebugInsn>;

/**
 * Byte length of a decoded instruction, from its hex `bytes` field, or 0 when
 * the backend sent no bytes and the length cannot be known.
 *
 * ```
 * insnSize({ addr: 0x8048060, bytes: "54", text: "push esp" })      // => 1
 * insnSize({ addr: 0x8048061, bytes: "689d800408", text: "push" }) // => 5
 * insnSize({ addr: 0x8048066, bytes: "", text: "?" })              // => 0
 * ```
 */
export function insnSize(insn: DebugInsn): number {
	const hex = (insn.bytes ?? "").replace(/\s+/g, "");
	if (hex.length < 2 || hex.length % 2 !== 0) return 0;
	return hex.length / 2;
}

/**
 * Address just past `insn`, or null when its length is unknown — a run of
 * instructions cannot be walked across an instruction of unknown size.
 *
 * ```
 * insnEnd({ addr: 0x8048060, bytes: "54", text: "push esp" })      // => 0x8048061
 * insnEnd({ addr: 0x8048060, bytes: "", text: "?" })              // => null
 * ```
 */
export function insnEnd(insn: DebugInsn): number | null {
	const n = insnSize(insn);
	return n > 0 ? insn.addr + n : null;
}

/**
 * Merge freshly decoded instructions into the cache, returning a new map.
 *
 * The cache accumulates for the whole session so stepping never discards what
 * was already on screen, and a fresh decode wins over an older one for the same
 * address: the debuggee's memory is authoritative and may have changed (a
 * breakpoint's trap byte, self-modifying code). Past
 * {@link DISASM_MAX} the lowest addresses are dropped first, which is the
 * furthest-back history and the part scrolled off the top; if the program
 * counter ever lands on an evicted address the caller simply refetches.
 *
 * ```
 * const a = mergeDisasm(new Map(), [
 *   { addr: 0x8048060, bytes: "54", text: "push esp" },
 * ]);
 * mergeDisasm(a, [{ addr: 0x8048061, bytes: "689d800408", text: "push 0x804809d" }]).size
 * // => 2
 * ```
 */
export function mergeDisasm(
	cache: DisasmCache,
	fresh: readonly DebugInsn[] | null | undefined,
	max: number = DISASM_MAX,
): DisasmCache {
	if (!fresh || fresh.length === 0) return cache;
	const next = new Map(cache);
	for (const insn of fresh) {
		if (insn && typeof insn.addr === "number") next.set(insn.addr, insn);
	}
	if (next.size > max) {
		const ordered = [...next.keys()].sort((a, b) => a - b);
		for (const addr of ordered.slice(0, next.size - max)) next.delete(addr);
	}
	return next;
}

/**
 * The contiguous run of cached instructions starting at `addr`, walking forward
 * while each instruction begins exactly where the previous one ended. Stops at
 * the first gap, at an instruction of unknown length, or after `limit` rows.
 *
 * ```
 * const cache = new Map([
 *   [0x8048060, { addr: 0x8048060, bytes: "54", text: "push esp" }],
 *   [0x8048061, { addr: 0x8048061, bytes: "689d800408", text: "push 0x804809d" }],
 *   [0x8048066, { addr: 0x8048066, bytes: "31c0", text: "xor eax, eax" }],
 *   [0x8049000, { addr: 0x8049000, bytes: "90", text: "nop" }],
 * ]);
 * forwardRun(cache, 0x8048060, 8).map((i) => i.addr)
 * // => [0x8048060, 0x8048061, 0x8048066]  (stops at the gap before 0x8049000)
 * forwardRun(cache, 0x8049000, 8).length
 * // => 1
 * ```
 */
export function forwardRun(
	cache: DisasmCache,
	addr: number,
	limit: number,
): DebugInsn[] {
	const out: DebugInsn[] = [];
	let cur = cache.get(addr);
	while (cur && out.length < limit) {
		out.push(cur);
		const end = insnEnd(cur);
		if (end == null) break;
		cur = cache.get(end);
	}
	return out;
}

/** How many instructions the cache already holds contiguously below `addr`. */
export function countForward(cache: DisasmCache, addr: number): number {
	return forwardRun(cache, addr, DISASM_MIN_FORWARD).length;
}

/** The cached instruction ending exactly at `addr`, if any. */
function findPrevious(cache: DisasmCache, addr: number): DebugInsn | null {
	for (let back = 1; back <= MAX_INSN_BYTES; back++) {
		const cand = cache.get(addr - back);
		if (cand && insnEnd(cand) === addr) return cand;
	}
	return null;
}

/**
 * The rows the CPU view shows: up to `before` already-decoded instructions
 * above the program counter, then up to `after` from it downward, all
 * contiguous.
 *
 * This is what keeps the view from resetting on every step. The window is
 * anchored to the pc but reaches *backwards* through the cache, so stepping
 * into the next function leaves the instructions already on screen above the
 * cursor instead of replacing them — the previous run stays as history.
 *
 * `before` is the debugger's configurable history depth, so only the last `x`
 * already-executed instructions are shown. Anything older still sits in the
 * cache: raising the depth brings it back without refetching.
 *
 * The window never bridges a gap: when the pc moves somewhere the cache has
 * nothing contiguous for (a `continue` into unrelated code), the window starts
 * there rather than inventing adjacency.
 *
 * Returns an empty list when the pc itself has not been decoded yet, which is
 * the caller's cue to fetch.
 *
 * ```
 * const cache = new Map([
 *   [0x804809c, { addr: 0x804809c, bytes: "c3", text: "ret" }],
 *   [0x804809d, { addr: 0x804809d, bytes: "5c", text: "pop esp" }],
 *   [0x804809e, { addr: 0x804809e, bytes: "31c0", text: "xor eax, eax" }],
 *   [0x80480a0, { addr: 0x80480a0, bytes: "40", text: "inc eax" }],
 * ]);
 * // History depth 8: everything decoded above the cursor.
 * windowAround(cache, 0x80480a0, 8, 8).map((i) => i.addr)
 * // => [0x804809c, 0x804809d, 0x804809e, 0x80480a0]
 * // History depth 1: only the last instruction before the cursor.
 * windowAround(cache, 0x80480a0, 1, 8).map((i) => i.addr)
 * // => [0x804809e, 0x80480a0]
 * windowAround(cache, 0x1234, 8, 8)
 * // => []
 * ```
 */
export function windowAround(
	cache: DisasmCache,
	pc: number | null,
	before: number,
	after: number,
): DebugInsn[] {
	if (pc == null || !cache.has(pc)) return [];
	const back: DebugInsn[] = [];
	let at = pc;
	while (back.length < before) {
		const prev = findPrevious(cache, at);
		if (!prev) break;
		back.push(prev);
		at = prev.addr;
	}
	back.reverse();
	return [...back, ...forwardRun(cache, pc, after)];
}

/**
 * Add `pc` to the set of addresses the program counter has been observed at,
 * returning a new set, or the same set when it was already there.
 *
 * This is the "already happened here" history behind the CPU view's `·` marker.
 * The granularity is one address per stop — every single-step, breakpoint hit
 * and signal the debugger reports — so it marks where the program has *been*,
 * which is what the view can honestly claim. Instructions run through between
 * two stops are not marked, because nothing observed them.
 *
 * ```
 * const seen = markVisited(new Set<number>(), 0x8048060).has(0x8048060);
 * seen  // => true
 * ```
 */
export function markVisited(
	visited: ReadonlySet<number>,
	pc: number | null | undefined,
): ReadonlySet<number> {
	if (pc == null || !Number.isFinite(pc)) return visited;
	if (visited.has(pc)) return visited;
	const next = new Set(visited);
	next.add(pc);
	return next;
}
