import {
	FLOW_LANE_GAP,
	FLOW_LANES,
	type Band,
	type FlowEdge,
	type PlacedFlow,
} from "@/lib/flowGutter";

/**
 * Which lane each branch runs in, and in which colour. Lane choice is what keeps
 * connectors from crossing each other, and stickiness is what keeps them from
 * jumping while the listing scrolls.
 */

/**
 * The stroke colour for a branch kind: calls in the symbol colour, conditional
 * branches in the number colour, unconditional jumps in the destructive colour,
 * and indirect jumps in the jump colour.
 *
 * @param kind - The instruction's kind (`call`, `cjmp`, `jmp`, `ijmp`, …).
 * @returns A CSS colour.
 *
 * @example
 * flowColor("call");
 * // => "var(--asm-symbol)"
 * flowColor("jmp");
 * // => "var(--destructive)"
 */
export function flowColor(kind?: string | null): string {
	switch (kind) {
		case "call":
		case "icall":
			return "var(--asm-symbol)";
		case "cjmp":
			return "var(--asm-number)";
		case "jmp":
			return "var(--destructive)";
		default:
			return "var(--asm-jump)";
	}
}

/**
 * The text colour class matching {@link flowColor}, for a row's own branch
 * glyph.
 *
 * @param kind - The instruction's kind.
 * @returns A text colour class.
 *
 * @example
 * flowColorClass("cjmp");
 * // => "text-asm-number"
 */
export function flowColorClass(kind?: string | null): string {
	switch (kind) {
		case "call":
		case "icall":
			return "text-asm-symbol";
		case "cjmp":
			return "text-asm-number";
		case "jmp":
			return "text-destructive";
		default:
			return "text-asm-jump";
	}
}

/**
 * A lane picked deterministically from an edge's key, for the rare case where
 * every lane is already busy.
 *
 * @param key - The edge's key.
 * @returns A lane number.
 *
 * @example
 * hashLane("1-2");
 * // => 0 <= hashLane("1-2") < FLOW_LANES
 */
export function hashLane(key: string): number {
	let h = 2166136261;
	for (let i = 0; i < key.length; i += 1) {
		h ^= key.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return Math.abs(h) % FLOW_LANES;
}

/**
 * Whether two vertical bands clear each other, allowing for a gap.
 *
 * @param a - One band.
 * @param b - The other band.
 * @returns True when they do not overlap.
 *
 * @example
 * bandsClear([0, 10], [13, 20]);
 * // => true
 * bandsClear([0, 10], [5, 20]);
 * // => false
 */
export function bandsClear(a: Band, b: Band): boolean {
	return a[0] - FLOW_LANE_GAP >= b[1] || b[0] - FLOW_LANE_GAP >= a[1];
}

/**
 * Give every edge a lane. An edge keeps the lane it had last time as long as
 * that lane is still free, so scrolling does not shuffle the drawing; new edges
 * take the lowest lane whose vertical run they do not overlap, and share a lane
 * only when every lane is busy.
 *
 * @param edges - The edges, in the order they were drawn last time.
 * @param previous - Lane per edge key from the previous pass.
 * @returns The edges with lanes.
 *
 * @example
 * const e = { key: "1-2", fromIndex: 1, toIndex: 2, fromY: 0, toY: 90,
 *   clipped: "none", color: "red" };
 * assignLanes([e], new Map()).map((p) => p.lane);
 * // => [0]
 * assignLanes([e], new Map([[e.key, 3]])).map((p) => p.lane);
 * // => [3]
 */
export function assignLanes(
	edges: readonly FlowEdge[],
	previous?: ReadonlyMap<string, number>,
): PlacedFlow[] {
	const busy: Band[][] = Array.from({ length: FLOW_LANES }, () => []);
	const placed: PlacedFlow[] = [];
	for (const edge of edges) {
		const band: Band = [
			Math.min(edge.fromY, edge.toY),
			Math.max(edge.fromY, edge.toY),
		];
		const sticky = previous?.get(edge.key);
		const valid =
			typeof sticky === "number" && sticky >= 0 && sticky < FLOW_LANES;
		const order = valid
			? [
					sticky,
					...Array.from({ length: FLOW_LANES }, (_, i) => i).filter(
						(l) => l !== sticky,
					),
				]
			: Array.from({ length: FLOW_LANES }, (_, i) => i);
		let lane = order[0];
		let free = false;
		for (const candidate of order) {
			if (busy[candidate].every((other) => bandsClear(band, other))) {
				lane = candidate;
				free = true;
				break;
			}
		}
		if (!free) lane = valid ? (sticky as number) : hashLane(edge.key);
		busy[lane].push(band);
		placed.push({ ...edge, lane });
	}
	return placed;
}
