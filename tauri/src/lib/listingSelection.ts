import { BYTES_COLUMN, fmtAddr, groupBytes } from "./listingFormat";
import type { Function, ListingRow } from "../types";

/**
 * A native selection over the whole-image listing.
 *
 * The selection is a set of row indices, not addresses: a range has to be
 * contiguous in the listing, and an address only maps to an index once the
 * backend has located it. The anchor is the row a shift-range grows from, so
 * extending with the keyboard or a drag does not need to know which end the
 * analyst started at.
 */
export interface Selection {
	indices: number[];
	anchor: number | null;
}

/** Nothing selected. A shared value so an empty write bails a re-render. */
export const EMPTY_SELECTION: Selection = { indices: [], anchor: null };

/**
 * Every row index from `a` to `b`, inclusive, ascending.
 *
 * @param a - One end of the range.
 * @param b - The other end; either may be the larger.
 * @returns The indices, low to high.
 *
 * @example
 * indexRange(2, 5) // => [2, 3, 4, 5]
 * indexRange(5, 2) // => [2, 3, 4, 5]
 */
export function indexRange(a: number, b: number): number[] {
	const lo = Math.min(a, b);
	const hi = Math.max(a, b);
	const out: number[] = [];
	for (let i = lo; i <= hi; i++) out.push(i);
	return out;
}

/**
 * Apply a click at `index`.
 *
 * A shift-click grows a range from the anchor, a toggle click (Ctrl/Cmd) adds
 * or removes the one row, and a plain click replaces the selection.
 *
 * @param state - The selection before the click.
 * @param index - The row that was clicked.
 * @param mods - The held modifiers: shift for a range, toggle for Ctrl/Cmd.
 * @returns The selection after the click.
 *
 * @example
 * selectAt(EMPTY_SELECTION, 4, {}).indices            // => [4]
 * selectAt({ indices: [4], anchor: 4 }, 7, { shift: true }).indices
 * // => [4, 5, 6, 7]
 */
export function selectAt(
	state: Selection,
	index: number,
	mods: { shift?: boolean; toggle?: boolean },
): Selection {
	if (mods.shift && state.anchor != null) {
		return {
			indices: indexRange(state.anchor, index),
			anchor: state.anchor,
		};
	}
	if (mods.toggle) {
		const has = state.indices.includes(index);
		const indices = has
			? state.indices.filter((i) => i !== index)
			: [...state.indices, index].sort((a, b) => a - b);
		return { indices, anchor: index };
	}
	return { indices: [index], anchor: index };
}

/**
 * Extend the selection from its anchor to `index`, as a drag or a shift-arrow
 * does. With no anchor yet, `index` becomes the anchor and the sole row.
 *
 * @param state - The selection to extend.
 * @param index - The row the pointer or caret reached.
 * @returns The extended selection.
 *
 * @example
 * extendTo({ indices: [4], anchor: 4 }, 6).indices // => [4, 5, 6]
 * extendTo({ indices: [4], anchor: 4 }, 1).indices // => [1, 2, 3, 4]
 */
export function extendTo(state: Selection, index: number): Selection {
	const anchor = state.anchor ?? index;
	return { indices: indexRange(anchor, index), anchor };
}

/**
 * Move the caret by `delta` rows, optionally extending the selection.
 *
 * With no caret yet the first move lands on the first or last row, so an arrow
 * pressed into an unfocused listing does something predictable rather than
 * starting from nowhere.
 *
 * @param state - The selection before the move.
 * @param delta - Rows to move: negative is up, positive is down.
 * @param extend - Whether the move grows a selection from the anchor.
 * @param count - The listing's row count, for clamping.
 * @returns The selection after the move.
 *
 * @example
 * moveCursor({ indices: [4], anchor: 4 }, 1, false, 10).indices // => [5]
 * moveCursor({ indices: [4], anchor: 4 }, 1, true, 10).indices  // => [4, 5]
 */
export function moveCursor(
	state: Selection,
	delta: number,
	extend: boolean,
	count: number,
): Selection {
	if (count <= 0) return state;
	const caret = state.anchor ?? (delta > 0 ? -1 : count);
	const next = Math.max(0, Math.min(count - 1, caret + delta));
	if (extend) {
		const anchor = state.anchor ?? next;
		return { indices: indexRange(anchor, next), anchor };
	}
	return { indices: [next], anchor: next };
}

/** One row of the selection with the function it belongs to, if any. */
export interface ContextEntry {
	row: ListingRow;
	func?: Function | null;
}

/** A selection rendered for the agent: a chip label and the excerpt body. */
export interface BuiltContext {
	/** The one-line label shown on the composer chip and the chat bubble. */
	label: string;
	/** The listing excerpt, one row per line, with function headers. */
	text: string;
	/** How many rows the excerpt carries. */
	count: number;
}

/**
 * The name a function is shown under, falling back to its address.
 *
 * @param func - The function, or null.
 * @returns Its name, or `sub` when it has none.
 *
 * @example
 * funcName({ addr: 0x401000, name: "main" }) // => "main"
 * funcName({ addr: 0x401000 })               // => "sub"
 * funcName(null)                             // => "sub"
 */
function funcName(func?: Function | null): string {
	return func?.name ?? "sub";
}

/**
 * One listing row as the context spells it: address, bytes, instruction.
 *
 * @param row - The row to spell.
 * @returns The row as a single line, padded so the columns line up.
 *
 * @example
 * // for { addr: 0x401000, bytes: "55", text: "push rbp" }
 * // => "0x00401000  55                        push rbp"
 */
function contextLine(row: ListingRow): string {
	const bytes = groupBytes(row.bytes);
	const text = row.text ?? "";
	return `${fmtAddr(row.addr)}  ${bytes.padEnd(BYTES_COLUMN)}  ${text}`.trimEnd();
}

/**
 * Render a selection of listing rows as an agent context item.
 *
 * The excerpt keeps the listing's own shape — an address column, a byte
 * column, the instruction — and opens each function it spans with a `;`
 * comment naming it, so the model can tell where a run of instructions came
 * from. Section bands become `;` comments too.
 *
 * @param entries - The selected rows, in listing order, each with its function.
 * @returns The label and body, or null when nothing is selected.
 *
 * @example
 * buildListingContext([]) // => null
 * buildListingContext([{ row, func }]) // => { label: "main · 1 line", ... }
 */
export function buildListingContext(
	entries: ContextEntry[],
): BuiltContext | null {
	if (entries.length === 0) return null;

	const lines: string[] = [];
	let lastFunc: number | null = null;
	for (const { row, func } of entries) {
		if (func && func.addr !== lastFunc) {
			lines.push(`; function ${funcName(func)} @ ${fmtAddr(func.addr)}`);
			lastFunc = func.addr;
		}
		if (row.kind === "header") {
			lines.push(`; ---- ${row.label ?? "section"} ----`);
		} else {
			lines.push(contextLine(row));
		}
	}

	const count = entries.length;
	const funcs = new Map<number, string>();
	for (const { func } of entries) {
		if (func) funcs.set(func.addr, funcName(func));
	}
	let label: string;
	if (funcs.size === 1) {
		const [name] = [...funcs.values()];
		label = `${name} · ${count} line${count === 1 ? "" : "s"}`;
	} else if (funcs.size > 1) {
		label = `${count} lines · ${funcs.size} functions`;
	} else {
		label = `${count} line${count === 1 ? "" : "s"} @ ${fmtAddr(entries[0].row.addr)}`;
	}

	return { label, text: lines.join("\n"), count };
}

/**
 * Render a whole function as an agent context item: who it is, not what it
 * does.
 *
 * A line selection carries the disassembly because that is what the analyst
 * pointed at; a whole function is usually attached for its identity — name,
 * address, signature, size — and sending its body would swamp the context with
 * instructions the model was not asked about. The item's source is
 * `"function"`, so the wire header and the chat both say which kind it is.
 *
 * @param func - The function to describe.
 * @returns A one-line label and a short `;`-commented descriptor.
 *
 * @example
 * buildFunctionContext({ addr: 0x401000, name: "main", size: 419 });
 * // => {
 * //   label: "main @ 0x00401000",
 * //   text: "; function main @ 0x00401000\n; size: 419 bytes",
 * //   count: 1,
 * // }
 */
export function buildFunctionContext(func: Function): BuiltContext {
	const name = func.name ?? func.realname ?? `sub_${func.addr.toString(16)}`;
	const lines = [`; function ${name} @ ${fmtAddr(func.addr)}`];
	if (func.signature) lines.push(`; signature: ${func.signature}`);
	if (typeof func.size === "number") {
		lines.push(`; size: ${func.size} bytes`);
	}
	return {
		label: `${name} @ ${fmtAddr(func.addr)}`,
		text: lines.join("\n"),
		count: 1,
	};
}
