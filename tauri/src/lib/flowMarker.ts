import { flowColorClass } from "@/lib/flowLanes";

/**
 * A row's left-margin marker: the fall-through line down its edge, and the arrow
 * that says which way this row's branch goes.
 */

/** A row's left-margin marker: a branch glyph, a fall-through line, or both. */
export interface FlowMarker {
	/** Directional glyph for a branch, else empty. */
	glyph: string;
	/** Colour class for the glyph. */
	className: string;
	/** Whether straight-line flow continues past this row. */
	line: boolean;
	/** Tooltip describing the row's flow. */
	title: string;
}

/** The row shape the marker reads. */
export interface FlowRow {
	kind: string;
	type?: string | null;
	addr: number;
	jump?: number | null;
}

/**
 * The left-margin flow marker for a row, as Ghidra draws it: an arrow showing
 * which way a branch goes — its target above or below this line — and a line
 * where execution falls through to the next row. A return or trap ends the flow
 * and gets neither. The line is drawn rather than spelled as a glyph so it is
 * visible in any font.
 *
 * A branch whose target row is on screen is drawn as a bracket instead, and then
 * the arrow would only compete with it, so it is dropped.
 *
 * @param row - The listing row.
 * @param bracketed - Whether a bracket is drawn for this row's branch.
 * @returns The marker; all-empty for a non-code row.
 *
 * @example
 * flowMarker({ kind: "code", type: "ret", addr: 0x10 });
 * // => { glyph: "", className: "", line: false, title: "flow ends" }
 */
export function flowMarker(row: FlowRow, bracketed = false): FlowMarker {
	if (row.kind !== "code") {
		return { glyph: "", className: "", line: false, title: "" };
	}
	const kind = row.type ?? "";
	const isCall = kind === "call" || kind === "icall";
	const target = typeof row.jump === "number" ? row.jump : null;
	const glyph = bracketed
		? ""
		: target !== null
			? target < row.addr
				? "←"
				: "→"
			: isCall
				? "→"
				: "";
	const className = glyph ? flowColorClass(kind) : "";
	const stops =
		kind === "jmp" ||
		kind === "ijmp" ||
		kind === "ret" ||
		kind === "trap" ||
		kind === "int";
	const direction =
		target !== null && target < row.addr ? "backward" : "forward";
	const title = isCall
		? `call ${direction}`
		: glyph
			? `${kind || "branch"} ${direction}`
			: stops
				? "flow ends"
				: "fall-through";
	return { glyph, className, line: !stops, title };
}
