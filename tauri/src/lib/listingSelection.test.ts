import { describe, expect, it } from "vitest";

import {
	buildFunctionContext,
	buildListingContext,
	EMPTY_SELECTION,
	extendTo,
	indexRange,
	moveCursor,
	selectAt,
	type ContextEntry,
} from "./listingSelection";
import type { Function, ListingRow } from "../types";

const MAIN: Function = { addr: 0x401000, name: "main" };
const HELPER: Function = { addr: 0x402000, name: "helper" };

/** A code row, the common case in a selection. */
function code(addr: number, bytes: string, text: string): ListingRow {
	return { addr, kind: "code", size: bytes.length / 2, bytes, text };
}

describe("indexRange", () => {
	it("counts up from either end", () => {
		expect(indexRange(2, 5)).toEqual([2, 3, 4, 5]);
		expect(indexRange(5, 2)).toEqual([2, 3, 4, 5]);
	});

	it("is a single index when both ends meet", () => {
		expect(indexRange(3, 3)).toEqual([3]);
	});
});

describe("selectAt", () => {
	it("replaces the selection on a plain click", () => {
		const next = selectAt({ indices: [1, 2, 3], anchor: 2 }, 7, {});
		expect(next).toEqual({ indices: [7], anchor: 7 });
	});

	it("grows a range from the anchor on a shift click", () => {
		const next = selectAt({ indices: [4], anchor: 4 }, 7, {
			shift: true,
		});
		expect(next.indices).toEqual([4, 5, 6, 7]);
		expect(next.anchor).toBe(4);
	});

	it("adds and removes one row on a toggle click", () => {
		const added = selectAt({ indices: [1, 3], anchor: 1 }, 2, {
			toggle: true,
		});
		expect(added.indices).toEqual([1, 2, 3]);

		const removed = selectAt({ indices: [1, 2, 3], anchor: 2 }, 2, {
			toggle: true,
		});
		expect(removed.indices).toEqual([1, 3]);
		expect(removed.anchor).toBe(2);
	});

	it("falls back to a plain click when shift has no anchor", () => {
		const next = selectAt(EMPTY_SELECTION, 5, { shift: true });
		expect(next).toEqual({ indices: [5], anchor: 5 });
	});
});

describe("extendTo", () => {
	it("reaches the row from the anchor, whichever side it is on", () => {
		expect(extendTo({ indices: [4], anchor: 4 }, 6).indices).toEqual([
			4, 5, 6,
		]);
		expect(extendTo({ indices: [4], anchor: 4 }, 1).indices).toEqual([
			1, 2, 3, 4,
		]);
	});

	it("takes the row as the anchor when there is none yet", () => {
		const next = extendTo(EMPTY_SELECTION, 3);
		expect(next).toEqual({ indices: [3], anchor: 3 });
	});
});

describe("moveCursor", () => {
	it("moves one row without extending", () => {
		expect(
			moveCursor({ indices: [4], anchor: 4 }, 1, false, 10).indices,
		).toEqual([5]);
	});

	it("extends the range with shift held", () => {
		expect(
			moveCursor({ indices: [4], anchor: 4 }, 1, true, 10).indices,
		).toEqual([4, 5]);
	});

	it("lands on the first or last row from an empty selection", () => {
		expect(moveCursor(EMPTY_SELECTION, 1, false, 10).indices).toEqual([0]);
		expect(moveCursor(EMPTY_SELECTION, -1, false, 10).indices).toEqual([9]);
	});

	it("clamps at the ends of the listing", () => {
		expect(
			moveCursor({ indices: [9], anchor: 9 }, 1, false, 10).indices,
		).toEqual([9]);
		expect(
			moveCursor({ indices: [0], anchor: 0 }, -1, false, 10).indices,
		).toEqual([0]);
	});

	it("does nothing to an empty listing", () => {
		expect(moveCursor(EMPTY_SELECTION, 1, false, 0)).toBe(EMPTY_SELECTION);
	});
});

describe("buildListingContext", () => {
	it("is null when nothing is selected", () => {
		expect(buildListingContext([])).toBeNull();
	});

	it("opens with the function and spells each row in the listing's columns", () => {
		const entries: ContextEntry[] = [
			{ row: code(0x401000, "55", "push rbp"), func: MAIN },
			{ row: code(0x401001, "4889e5", "mov rbp, rsp"), func: MAIN },
		];
		const ctx = buildListingContext(entries);
		expect(ctx).not.toBeNull();
		const lines = ctx!.text.split("\n");
		expect(lines[0]).toBe("; function main @ 0x00401000");
		expect(lines[1].startsWith("0x00401000")).toBe(true);
		expect(lines[1]).toContain("55");
		expect(lines[1]).toContain("push rbp");
		expect(lines[2]).toContain("mov rbp, rsp");
		expect(ctx!.label).toBe("main · 2 lines");
		expect(ctx!.count).toBe(2);
	});

	it("opens each function a selection spans", () => {
		const entries: ContextEntry[] = [
			{ row: code(0x401000, "55", "push rbp"), func: MAIN },
			{ row: code(0x402000, "90", "nop"), func: HELPER },
		];
		const ctx = buildListingContext(entries)!;
		const headers = ctx.text
			.split("\n")
			.filter((l) => l.startsWith("; function"));
		expect(headers).toEqual([
			"; function main @ 0x00401000",
			"; function helper @ 0x00402000",
		]);
		expect(ctx.label).toBe("2 lines · 2 functions");
	});

	it("names a function once however many of its rows are selected", () => {
		const entries: ContextEntry[] = [
			{ row: code(0x401000, "55", "push rbp"), func: MAIN },
			{ row: code(0x401001, "90", "nop"), func: MAIN },
			{ row: code(0x401002, "c3", "ret"), func: MAIN },
		];
		const headers = buildListingContext(entries)!
			.text.split("\n")
			.filter((l) => l.startsWith("; function"));
		expect(headers).toHaveLength(1);
	});

	it("renders a section band as a comment", () => {
		const entries: ContextEntry[] = [
			{
				row: {
					addr: 0x401000,
					kind: "header",
					size: 0,
					label: ".text",
				},
			},
		];
		const ctx = buildListingContext(entries)!;
		expect(ctx.text).toBe("; ---- .text ----");
		expect(ctx.label).toBe("1 line @ 0x00401000");
	});

	it("says one line, not one lines", () => {
		const entries: ContextEntry[] = [
			{ row: code(0x401000, "c3", "ret"), func: MAIN },
		];
		expect(buildListingContext(entries)!.label).toBe("main · 1 line");
	});
});

describe("buildFunctionContext", () => {
	it("describes the function's identity, not its instructions", () => {
		const ctx = buildFunctionContext({
			addr: 0x401000,
			name: "main",
			signature: "int main(int argc, char **argv)",
			size: 419,
		});
		expect(ctx.label).toBe("main @ 0x00401000");
		expect(ctx.text).toBe(
			[
				"; function main @ 0x00401000",
				"; signature: int main(int argc, char **argv)",
				"; size: 419 bytes",
			].join("\n"),
		);
		expect(ctx.count).toBe(1);
	});

	it("omits a signature and size it does not have", () => {
		const ctx = buildFunctionContext({ addr: 0x401000, name: "main" });
		expect(ctx.text).toBe("; function main @ 0x00401000");
	});

	it("names an unnamed function by its address", () => {
		const ctx = buildFunctionContext({ addr: 0x4010a0 });
		expect(ctx.text).toBe("; function sub_4010a0 @ 0x004010a0");
		expect(ctx.label).toBe("sub_4010a0 @ 0x004010a0");
	});

	it("prefers a name, then a real name", () => {
		expect(
			buildFunctionContext({ addr: 1, name: "main", realname: "real" })
				.label,
		).toBe("main @ 0x00000001");
		expect(buildFunctionContext({ addr: 1, realname: "real" }).label).toBe(
			"real @ 0x00000001",
		);
	});
});
