import { describe, expect, it } from "vitest";

import {
	FLOW_ARROW_HALF,
	FLOW_ARROW_LEN,
	FLOW_GUTTER_W,
	FLOW_LANES,
	FLOW_LINE_X,
	FLOW_MARKER_X,
	flowArrow,
	flowEdgeKey,
	flowPath,
	laneX,
	makeFlowEdge,
	rowCenterY,
	spansHeaderRow,
	type PlacedFlow,
} from "@/lib/flowGutter";

/**
 * A placed edge between two 18px rows.
 *
 * @param from - y of the source row's line.
 * @param to - y of the target row's line.
 * @param lane - Lane the bracket runs in.
 * @returns The edge.
 */
function placed(from: number, to: number, lane = 0): PlacedFlow {
	return {
		key: flowEdgeKey(0, 1),
		fromIndex: 0,
		toIndex: 1,
		fromY: from,
		toY: to,
		color: "red",
		lane,
	};
}

describe("flowEdgeKey", () => {
	it("joins the two row indices", () => {
		expect(flowEdgeKey(12, 40)).toBe("12-40");
	});
});

describe("rowCenterY", () => {
	it("aims at the middle of a normal row", () => {
		expect(rowCenterY(100, 18)).toBe(109);
	});

	it("aims at the first line of a taller row", () => {
		expect(rowCenterY(100, 180)).toBe(109);
	});
});

describe("laneX", () => {
	it("keeps every lane inside the gutter", () => {
		expect(laneX(0)).toBe(11);
		expect(laneX(FLOW_LANES - 1)).toBe(23);
	});
});

describe("gutter layout", () => {
	it("puts the fall-through line, the lanes and the glyph in one gutter", () => {
		expect(FLOW_LINE_X).toBeLessThan(laneX(0));
		expect(laneX(FLOW_LANES - 1)).toBeLessThan(FLOW_MARKER_X);
		expect(FLOW_MARKER_X + FLOW_ARROW_HALF).toBeLessThanOrEqual(
			FLOW_GUTTER_W,
		);
	});
});

describe("makeFlowEdge", () => {
	it("meets each row at its own line", () => {
		expect(
			makeFlowEdge({
				fromIndex: 10,
				toIndex: 30,
				fromStart: 180,
				fromSize: 18,
				toStart: 540,
				toSize: 18,
				color: "red",
			}),
		).toEqual({
			key: "10-30",
			fromIndex: 10,
			toIndex: 30,
			fromY: 189,
			toY: 549,
			color: "red",
		});
	});

	it("aims a branch into a function at its first line", () => {
		expect(
			makeFlowEdge({
				fromIndex: 1,
				toIndex: 2,
				fromStart: 0,
				fromSize: 18,
				toStart: 180,
				toSize: 130,
				color: "red",
			}),
		).toMatchObject({ toY: 189 });
	});

	it("rejects an unknown offset", () => {
		expect(
			makeFlowEdge({
				fromIndex: 0,
				toIndex: 1,
				fromStart: Number.NaN,
				fromSize: 18,
				toStart: 18,
				toSize: 18,
				color: "red",
			}),
		).toBeNull();
	});
});

describe("flowPath", () => {
	it("runs out of the row, down the lane, and into the target row", () => {
		expect(flowPath(placed(189, 549, 1))).toBe(
			`M ${FLOW_MARKER_X} 189 L ${laneX(1)} 189 L ${laneX(1)} 549 L ${FLOW_MARKER_X} 549`,
		);
	});
});

describe("flowArrow", () => {
	it("points right into a row below", () => {
		expect(flowArrow(placed(189, 549))).toBe(
			`${FLOW_MARKER_X - FLOW_ARROW_HALF},${549 - FLOW_ARROW_LEN} ${FLOW_MARKER_X + FLOW_ARROW_HALF},${549 - FLOW_ARROW_LEN} ${FLOW_MARKER_X},549`,
		);
	});

	it("points left into a row above", () => {
		expect(flowArrow(placed(549, 189))).toBe(
			`${FLOW_MARKER_X - FLOW_ARROW_HALF},${189 + FLOW_ARROW_LEN} ${FLOW_MARKER_X + FLOW_ARROW_HALF},${189 + FLOW_ARROW_LEN} ${FLOW_MARKER_X},189`,
		);
	});

	it("keeps every x inside the gutter", () => {
		const edge = placed(189, 549, FLOW_LANES - 1);
		const xs = `${flowPath(edge)} ${flowArrow(edge)}`
			.split(/[\s,ML]+/)
			.filter(Boolean)
			.map(Number)
			.filter((_, i) => i % 2 === 0);
		expect(Math.max(...xs)).toBeLessThanOrEqual(FLOW_GUTTER_W);
		expect(Math.min(...xs)).toBeGreaterThan(0);
	});
});

describe("spansHeaderRow", () => {
	it("sees a function header between two rows", () => {
		expect(spansHeaderRow([{ size: 18 }, { size: 130 }], 0, 1)).toBe(true);
	});

	it("passes a span of plain instructions", () => {
		expect(
			spansHeaderRow([{ size: 18 }, { size: 18 }, { size: 18 }], 0, 2),
		).toBe(false);
	});

	it("does not care which end is first", () => {
		expect(spansHeaderRow([{ size: 18 }, { size: 130 }], 1, 0)).toBe(true);
	});

	it("ignores rows it has no measurement for", () => {
		expect(spansHeaderRow([{ size: 18 }], 0, 40)).toBe(false);
	});
});
