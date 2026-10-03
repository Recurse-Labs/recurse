import { describe, expect, it } from "vitest";

import { FLOW_LANES, type FlowEdge } from "@/lib/flowGutter";
import {
	assignLanes,
	bandsClear,
	flowColor,
	flowColorClass,
} from "@/lib/flowLanes";

/**
 * An edge between two rows at the given y offsets.
 *
 * @param from - y of the source row's line.
 * @param to - y of the target row's line.
 * @param key - The edge's key.
 * @returns The edge.
 */
function edge(from: number, to: number, key = `${from}-${to}`): FlowEdge {
	return {
		key,
		fromIndex: 0,
		toIndex: 1,
		fromY: from,
		toY: to,
		color: "red",
	};
}

describe("flowColor", () => {
	it("gives every branch kind its own colour", () => {
		const colours = ["call", "icall", "cjmp", "jmp", "ijmp"].map(flowColor);
		expect(new Set(colours).size).toBe(4);
		expect(flowColor("call")).toBe("var(--asm-symbol)");
		expect(flowColor("cjmp")).toBe("var(--asm-number)");
		expect(flowColor("jmp")).toBe("var(--destructive)");
		expect(flowColor("ijmp")).toBe("var(--asm-jump)");
	});
});

describe("flowColorClass", () => {
	it("matches the stroke colour's text class", () => {
		expect(flowColorClass("call")).toBe("text-asm-symbol");
		expect(flowColorClass("cjmp")).toBe("text-asm-number");
		expect(flowColorClass("jmp")).toBe("text-destructive");
		expect(flowColorClass("ijmp")).toBe("text-asm-jump");
	});
});

describe("bandsClear", () => {
	it("clears bands separated by the lane gap", () => {
		expect(bandsClear([0, 10], [13, 20])).toBe(true);
	});

	it("refuses bands that overlap", () => {
		expect(bandsClear([0, 10], [5, 20])).toBe(false);
	});
});

describe("assignLanes", () => {
	it("keeps an edge in the lane it had", () => {
		const e = edge(100, 200);
		expect(
			assignLanes([e], new Map([[e.key, 2]])).map((p) => p.lane),
		).toEqual([2]);
	});

	it("is stable when the same edges are placed again", () => {
		const edges = [edge(100, 200), edge(120, 260), edge(140, 220)];
		const first = assignLanes(edges, new Map());
		const memory = new Map(first.map((p) => [p.key, p.lane]));
		const second = assignLanes(edges, memory);
		expect(second.map((p) => p.lane)).toEqual(first.map((p) => p.lane));
	});

	it("shares a lane between branches that do not overlap", () => {
		const lanes = assignLanes([edge(0, 20), edge(400, 420)], new Map()).map(
			(p) => p.lane,
		);
		expect(lanes[0]).toBe(lanes[1]);
	});

	it("separates overlapping branches into different lanes", () => {
		const lanes = assignLanes(
			[edge(0, 200), edge(100, 300)],
			new Map(),
		).map((p) => p.lane);
		expect(lanes[0]).not.toBe(lanes[1]);
	});

	it("never assigns a lane outside the gutter", () => {
		const edges = Array.from({ length: 12 }, (_, i) =>
			edge(i * 2, i * 2 + 100, `${i}`),
		);
		for (const placed of assignLanes(edges, new Map())) {
			expect(placed.lane).toBeGreaterThanOrEqual(0);
			expect(placed.lane).toBeLessThan(FLOW_LANES);
		}
	});

	it("ignores a remembered lane that no longer exists", () => {
		const e = edge(100, 200);
		expect(
			assignLanes([e], new Map([[e.key, 99]])).map((p) => p.lane),
		).toEqual([0]);
	});
});
