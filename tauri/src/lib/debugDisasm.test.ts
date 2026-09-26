import { describe, expect, it } from "vitest";

import type { DebugInsn } from "../types";
import {
	countForward,
	DISASM_MAX,
	forwardRun,
	insnEnd,
	insnSize,
	markVisited,
	mergeDisasm,
	windowAround,
} from "./debugDisasm";

/** Build a cache from `[addr, bytesHex, text]` triples. */
function cacheOf(
	rows: readonly (readonly [number, string, string])[],
): Map<number, DebugInsn> {
	return new Map(
		rows.map(([addr, bytes, text]) => [addr, { addr, bytes, text }]),
	);
}

describe("insnSize", () => {
	it("reads the length from the hex bytes", () => {
		expect(insnSize({ addr: 0, bytes: "54", text: "push esp" })).toBe(1);
		expect(
			insnSize({ addr: 0, bytes: "689d800408", text: "push 0x804809d" }),
		).toBe(5);
	});

	it("tolerates spaced bytes", () => {
		expect(
			insnSize({ addr: 0, bytes: "31 c0", text: "xor eax, eax" }),
		).toBe(2);
	});

	it("reports 0 when the length cannot be known", () => {
		expect(insnSize({ addr: 0, bytes: "", text: "?" })).toBe(0);
		expect(insnSize({ addr: 0, bytes: "abc", text: "?" })).toBe(0);
	});
});

describe("insnEnd", () => {
	it("is the address just past the instruction", () => {
		expect(
			insnEnd({ addr: 0x8048060, bytes: "54", text: "push esp" }),
		).toBe(0x8048061);
	});

	it("is null when the length is unknown", () => {
		expect(insnEnd({ addr: 0x8048060, bytes: "", text: "?" })).toBeNull();
	});
});

describe("mergeDisasm", () => {
	it("accumulates across fetches instead of replacing", () => {
		const first = mergeDisasm(new Map(), [
			{ addr: 0x8048060, bytes: "54", text: "push esp" },
		]);
		const second = mergeDisasm(first, [
			{ addr: 0x8048061, bytes: "689d800408", text: "push 0x804809d" },
		]);
		expect(second.size).toBe(2);
		expect([...second.keys()]).toEqual([0x8048060, 0x8048061]);
	});

	it("lets a fresh decode win for the same address", () => {
		// A breakpoint's trap byte is replaced, then restored: the newest read
		// of an address is the authoritative one.
		const withTrap = mergeDisasm(new Map(), [
			{ addr: 0x8048060, bytes: "cc", text: "int3" },
		]);
		const restored = mergeDisasm(withTrap, [
			{ addr: 0x8048060, bytes: "54", text: "push esp" },
		]);
		expect(restored.size).toBe(1);
		expect(restored.get(0x8048060)?.text).toBe("push esp");
	});

	it("returns the same cache for an empty fetch", () => {
		const cache = cacheOf([[0x8048060, "54", "push esp"]]);
		expect(mergeDisasm(cache, [])).toBe(cache);
		expect(mergeDisasm(cache, null)).toBe(cache);
		expect(mergeDisasm(cache, undefined)).toBe(cache);
	});

	it("evicts the lowest addresses past the cap", () => {
		const many = Array.from({ length: 10 }, (_, i) => ({
			addr: 0x8048060 + i,
			bytes: "90",
			text: "nop",
		}));
		const capped = mergeDisasm(new Map(), many, 4);
		expect([...capped.keys()]).toEqual([
			0x8048066, 0x8048067, 0x8048068, 0x8048069,
		]);
	});

	it("defaults the cap to the session limit", () => {
		const many = Array.from({ length: DISASM_MAX + 5 }, (_, i) => ({
			addr: i,
			bytes: "90",
			text: "nop",
		}));
		expect(mergeDisasm(new Map(), many).size).toBe(DISASM_MAX);
	});
});

describe("forwardRun", () => {
	const cache = cacheOf([
		[0x8048060, "54", "push esp"],
		[0x8048061, "689d800408", "push 0x804809d"],
		[0x8048066, "31c0", "xor eax, eax"],
		[0x8048068, "31db", "xor ebx, ebx"],
		[0x8049000, "90", "nop"],
	]);

	it("walks forward while instructions are contiguous", () => {
		expect(forwardRun(cache, 0x8048060, 8).map((i) => i.addr)).toEqual([
			0x8048060, 0x8048061, 0x8048066, 0x8048068,
		]);
	});

	it("stops at a gap rather than bridging it", () => {
		// 0x8049000 is decoded, but it does not follow 0x8048068.
		expect(forwardRun(cache, 0x8048068, 8).map((i) => i.addr)).toEqual([
			0x8048068,
		]);
	});

	it("honours the limit", () => {
		expect(forwardRun(cache, 0x8048060, 2).length).toBe(2);
	});

	it("is empty for an address that was never decoded", () => {
		expect(forwardRun(cache, 0x1234, 8)).toEqual([]);
	});

	it("stops at an instruction of unknown length", () => {
		const odd = cacheOf([
			[0x8048060, "", "?"],
			[0x8048061, "90", "nop"],
		]);
		expect(forwardRun(odd, 0x8048060, 8).map((i) => i.addr)).toEqual([
			0x8048060,
		]);
	});
});

describe("countForward", () => {
	it("measures cached coverage below an address", () => {
		const cache = cacheOf([
			[0x8048060, "90", "nop"],
			[0x8048061, "90", "nop"],
		]);
		expect(countForward(cache, 0x8048060)).toBe(2);
		expect(countForward(cache, 0x9999)).toBe(0);
	});
});

describe("windowAround", () => {
	// The reported case, at the reported addresses: _start ends with `ret` at
	// 0x804809c and _exit begins at 0x804809d, so stepping into _exit must leave
	// _start on screen above the cursor.
	const cache = cacheOf([
		[0x804809c, "c3", "ret"],
		[0x804809d, "5c", "pop esp"],
		[0x804809e, "31c0", "xor eax, eax"],
		[0x80480a0, "40", "inc eax"],
		[0x80480a1, "cd80", "int 0x80"],
	]);

	it("keeps the earlier instructions above the cursor", () => {
		// Stepping into _exit leaves _start's `ret` on screen above it, and the
		// rest of _exit below — the whole run, with nothing thrown away.
		expect(windowAround(cache, 0x804809d, 8, 8).map((i) => i.addr)).toEqual(
			[0x804809c, 0x804809d, 0x804809e, 0x80480a0, 0x80480a1],
		);
	});

	it("includes the cursor and the instructions below it", () => {
		expect(windowAround(cache, 0x80480a0, 8, 8).map((i) => i.addr)).toEqual(
			[0x804809c, 0x804809d, 0x804809e, 0x80480a0, 0x80480a1],
		);
	});

	it("never bridges a gap to reach a distant decoded address", () => {
		// 0x804809d is decoded, but 0x804809c is not, so nothing reaches back to
		// it: the run must start at the pc rather than invent adjacency.
		const gapped = cacheOf([
			[0x804809d, "5c", "pop esp"],
			[0x804809e, "31c0", "xor eax, eax"],
		]);
		expect(
			windowAround(gapped, 0x804809d, 8, 8).map((i) => i.addr),
		).toEqual([0x804809d, 0x804809e]);
	});

	it("does not walk back across an instruction that ends past the pc", () => {
		// The cached row at 0x804809d is three bytes, so it ends at 0x80480a0 —
		// past the pc, and therefore not its predecessor.
		const overlong = cacheOf([
			[0x804809d, "c3c3c3", "ret ret ret"],
			[0x804809f, "31c0", "xor eax, eax"],
		]);
		expect(
			windowAround(overlong, 0x804809f, 8, 8).map((i) => i.addr),
		).toEqual([0x804809f]);
	});

	it("bounds the rows above and below the cursor", () => {
		const many = cacheOf(
			Array.from(
				{ length: 30 },
				(_, i) => [0x8048060 + i, "90", "nop"] as const,
			),
		);
		const rows = windowAround(many, 0x8048070, 4, 3);
		expect(rows.map((i) => i.addr)).toEqual([
			0x804806c, 0x804806d, 0x804806e, 0x804806f, 0x8048070, 0x8048071,
			0x8048072,
		]);
	});

	it("shows only the last x already-executed instructions", () => {
		// The configurable history depth is the `before` count: 1 keeps just the
		// instruction immediately before the cursor, 2 the two before it.
		expect(windowAround(cache, 0x80480a0, 1, 8).map((i) => i.addr)).toEqual(
			[0x804809e, 0x80480a0, 0x80480a1],
		);
		expect(windowAround(cache, 0x80480a0, 2, 8).map((i) => i.addr)).toEqual(
			[0x804809d, 0x804809e, 0x80480a0, 0x80480a1],
		);
		// 0 history: no rows above the cursor, but lookahead is untouched.
		expect(windowAround(cache, 0x80480a0, 0, 8).map((i) => i.addr)).toEqual(
			[0x80480a0, 0x80480a1],
		);
	});

	it("keeps the rows below the cursor regardless of the depth", () => {
		// The depth bounds history, not lookahead: upcoming code stays visible so
		// the next step has somewhere to land.
		expect(windowAround(cache, 0x804809d, 1, 8).map((i) => i.addr)).toEqual(
			[0x804809c, 0x804809d, 0x804809e, 0x80480a0, 0x80480a1],
		);
	});

	it("is empty when the pc has not been decoded yet", () => {
		expect(windowAround(cache, 0x1234, 8, 8)).toEqual([]);
	});

	it("is empty without a pc", () => {
		expect(windowAround(cache, null, 8, 8)).toEqual([]);
	});

	it("is empty against an empty cache", () => {
		expect(windowAround(new Map(), 0x8048060, 8, 8)).toEqual([]);
	});
});

describe("markVisited", () => {
	it("records a newly observed pc", () => {
		const seen = markVisited(new Set<number>(), 0x8048060);
		expect(seen.has(0x8048060)).toBe(true);
	});

	it("keeps the addresses already recorded", () => {
		const first = markVisited(new Set<number>(), 0x8048060);
		const second = markVisited(first, 0x8048061);
		expect([...second].sort()).toEqual([0x8048060, 0x8048061]);
	});

	it("returns the same set when the pc is already there", () => {
		const first = markVisited(new Set<number>(), 0x8048060);
		expect(markVisited(first, 0x8048060)).toBe(first);
	});

	it("ignores a missing pc", () => {
		const empty = new Set<number>();
		expect(markVisited(empty, null)).toBe(empty);
		expect(markVisited(empty, undefined)).toBe(empty);
		expect(markVisited(empty, Number.NaN)).toBe(empty);
	});
});
