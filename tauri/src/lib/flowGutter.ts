/**
 * Geometry for the listing's left-hand flow gutter: the fall-through line down
 * its edge, the branch glyphs, and the short brackets that tie a branch to a
 * target row that is on screen beside it.
 *
 * Everything here is pure arithmetic on row offsets, so it can be reasoned about
 * (and tested) without a DOM. Which lane a bracket gets is `flowLanes.ts`; what a
 * row's own marker is, is `flowMarker.ts`.
 */

/** One listing row's height, matching `--row-h`. Rows are this tall unless a
 * function header makes one taller. */
export const ROW_H = 18;

/** Width of the flow gutter, in pixels. Sized to what the markers need and no
 * more — the address column starts immediately after it, so a marker can never
 * overlap text. */
export const FLOW_GUTTER_W = 38;

/** x of the fall-through line, at the gutter's left edge. */
export const FLOW_LINE_X = 3;

/** x of the first bracket lane. */
export const FLOW_LANE_X = 11;

/** Distance between bracket lanes. */
export const FLOW_LANE_PITCH = 6;

/** How many bracket lanes fit beside the fall-through line. Brackets are only
 * drawn between two rows that are both on screen, so there are never many to
 * separate. */
export const FLOW_LANES = 3;

/** x of a branch glyph's centre, and where a bracket's arrowhead touches the
 * row it points at. */
export const FLOW_MARKER_X = 30;

/** Vertical clearance kept between two brackets in the same lane. */
export const FLOW_LANE_GAP = 3;

/** Half the width of an arrowhead. */
export const FLOW_ARROW_HALF = 3;

/** Length of an arrowhead. */
export const FLOW_ARROW_LEN = 5;

/** How many row heights a row may be before it counts as a function header
 * rather than an instruction. */
export const HEADER_MIN_ROWS = 2;

/**
 * Whether a bracket between two rows would have to run through a function
 * header — a boxed banner and its argument list, which is a block of text
 * rather than code. A bracket drawn across one reads as a line through the
 * header, so the branch keeps its arrow glyph instead.
 *
 * @param measured - Row measurements, indexed by listing index.
 * @param fromIndex - The row the branch leaves.
 * @param toIndex - The row the branch reaches.
 * @returns True when a header row lies between them.
 *
 * @example
 * spansHeaderRow([{ size: 18 }, { size: 130 }], 0, 1);
 * // => true
 * spansHeaderRow([{ size: 18 }, { size: 18 }], 0, 1);
 * // => false
 */
export function spansHeaderRow(
	measured: readonly { size: number }[],
	fromIndex: number,
	toIndex: number,
): boolean {
	const limit = ROW_H * HEADER_MIN_ROWS;
	const low = Math.min(fromIndex, toIndex);
	const high = Math.max(fromIndex, toIndex);
	for (let index = low; index <= high; index += 1) {
		const row = measured[index];
		if (row && row.size > limit) return true;
	}
	return false;
}

/** The vertical band a bracket occupies in its lane. */
export type Band = readonly [number, number];

/** One branch between two rows that are both on screen: from the row that
 * transfers control, to the row it reaches. */
export interface FlowEdge {
	/** Identity of the edge, stable across renders: `from-to`. */
	key: string;
	/** Index of the row the edge leaves. */
	fromIndex: number;
	/** Index of the row the edge reaches. */
	toIndex: number;
	/** y of the source row's line, in listing content pixels. */
	fromY: number;
	/** y of the target row's line. */
	toY: number;
	/** Stroke colour for the edge. */
	color: string;
}

/** A {@link FlowEdge} that has been given a lane to run in. */
export interface PlacedFlow extends FlowEdge {
	/** Lane the bracket's vertical run occupies. */
	lane: number;
}

/** The row offsets one edge is drawn between. */
export interface EdgeGeometry {
	fromIndex: number;
	toIndex: number;
	fromStart: number;
	fromSize: number;
	toStart: number;
	toSize: number;
	color: string;
}

/**
 * The identity of a flow edge, stable for as long as the branch exists.
 *
 * @param fromIndex - Index of the row leaving which control transfers.
 * @param toIndex - Index of the row reached.
 * @returns The key.
 *
 * @example
 * flowEdgeKey(12, 40);
 * // => "12-40"
 */
export function flowEdgeKey(fromIndex: number, toIndex: number): string {
	return `${fromIndex}-${toIndex}`;
}

/**
 * y of a row's line within the listing. A row taller than one line (a function
 * header) is met at its first line, so a branch into a function lands on the
 * entry instruction rather than the middle of the header.
 *
 * @param start - The row's top, in listing content pixels.
 * @param size - The row's measured height.
 * @returns The y a bracket should meet.
 *
 * @example
 * rowCenterY(100, 18);
 * // => 109
 * rowCenterY(100, 180);
 * // => 109
 */
export function rowCenterY(start: number, size: number): number {
	return start + Math.min(size, ROW_H) / 2;
}

/**
 * The x of a bracket lane.
 *
 * @param lane - Lane number, zero-based.
 * @returns Its x within the gutter.
 *
 * @example
 * laneX(0);
 * // => 11
 * laneX(2);
 * // => 23
 */
export function laneX(lane: number): number {
	return FLOW_LANE_X + lane * FLOW_LANE_PITCH;
}

/**
 * Build the edge between two rows.
 *
 * Only branches whose target row is on screen are drawn as brackets; a branch to
 * a row that is not on screen keeps its own arrow glyph instead, so the gutter
 * never fills with lines that run off the edge of the view without saying where
 * they end.
 *
 * @param geom - The two rows' offsets.
 * @returns The edge, or null when a row has no known offset.
 *
 * @example
 * makeFlowEdge({
 *   fromIndex: 10, toIndex: 30,
 *   fromStart: 180, fromSize: 18,
 *   toStart: 540, toSize: 18,
 *   color: "red",
 * });
 * // => {
 * //   key: "10-30", fromIndex: 10, toIndex: 30,
 * //   fromY: 189, toY: 549, color: "red",
 * // }
 */
export function makeFlowEdge(geom: EdgeGeometry): FlowEdge | null {
	const fromY = rowCenterY(geom.fromStart, geom.fromSize);
	const toY = rowCenterY(geom.toStart, geom.toSize);
	if (!Number.isFinite(fromY) || !Number.isFinite(toY)) return null;
	return {
		key: flowEdgeKey(geom.fromIndex, geom.toIndex),
		fromIndex: geom.fromIndex,
		toIndex: geom.toIndex,
		fromY,
		toY,
		color: geom.color,
	};
}

/**
 * The path of a bracket: out of the source row, along its lane, and into the
 * target row.
 *
 * @param edge - The placed edge.
 * @returns An SVG path `d` attribute.
 *
 * @example
 * flowPath({ ...edge, lane: 0 });
 * // => "M 30 189 L 11 189 L 11 549 L 30 549"
 */
export function flowPath(edge: PlacedFlow): string {
	const lane = laneX(edge.lane);
	return `M ${FLOW_MARKER_X} ${edge.fromY} L ${lane} ${edge.fromY} L ${lane} ${edge.toY} L ${FLOW_MARKER_X} ${edge.toY}`;
}

/**
 * The arrowhead of a bracket, pointing into the target row: right when the
 * branch goes down the listing, left when it goes back up.
 *
 * @param edge - The placed edge.
 * @returns An SVG polygon `points` attribute.
 *
 * @example
 * flowArrow({ ...edge, lane: 0 });
 * // => "27,544 33,544 30,549"
 */
export function flowArrow(edge: PlacedFlow): string {
	const w = FLOW_ARROW_HALF;
	const backwards = edge.toY < edge.fromY;
	const base = backwards
		? edge.toY + FLOW_ARROW_LEN
		: edge.toY - FLOW_ARROW_LEN;
	return `${FLOW_MARKER_X - w},${base} ${FLOW_MARKER_X + w},${base} ${FLOW_MARKER_X},${edge.toY}`;
}
