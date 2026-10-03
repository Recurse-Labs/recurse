import { useMemo } from "react";
import type { ReactVirtualizer } from "@tanstack/react-virtual";
import type { VirtualItem } from "@tanstack/virtual-core";

import { CHUNK } from "@/components/listing/useListingRows";
import {
	makeFlowEdge,
	spansHeaderRow,
	type FlowEdge,
	type PlacedFlow,
} from "@/lib/flowGutter";
import { assignLanes, flowColor } from "@/lib/flowLanes";
import type { ListingRow } from "@/types";

/** The connectors to draw for the rows on screen. */
export interface FlowDrawing {
	/** The window's top edge, in listing content pixels. */
	top: number;
	/** The window's height, in pixels. */
	height: number;
	/** The edges, each with the lane its bracket runs in. */
	edges: PlacedFlow[];
	/** Indices of the rows whose branch is drawn as a bracket, not a glyph. */
	connected: Set<number>;
}

/** What the connectors are computed from. */
export interface FlowInput {
	/** The rows rendered on screen, overscanned. */
	items: readonly VirtualItem[];
	/** The virtualizer, for its own row measurements. */
	virtualizer: ReactVirtualizer<HTMLDivElement, Element>;
	/** The list's offset within the scroll container. */
	scrollMargin: number;
	/** Every row fetched so far, keyed by the chunk it came from. */
	chunks: Map<number, ListingRow[]>;
}

/** Lane per edge key from the last pass that drew it. Module state rather than
 * component state: the drawing is a pure function of the window plus what was
 * drawn last time, and this keeps the lanes still while the listing scrolls. */
const laneMemory = new Map<string, number>();

/** How many remembered lanes to keep before dropping them all. */
const LANE_MEMORY_MAX = 4096;

/**
 * Work out the flow brackets for the rows on screen.
 *
 * A branch is drawn only when its target row is on screen too, so every bracket
 * ends at a row the reader can see: a call into another function, or a branch
 * whose other end is scrolled away, keeps the plain arrow glyph on its own row
 * instead. That is what keeps the gutter readable — there is never a bundle of
 * lines running the height of the view with nothing at the end of them.
 *
 * Offsets come from the virtualizer's own measurements, the same ones the rows
 * are placed with, so a bracket meets its row exactly and nothing drifts while
 * scrolling. Lanes are remembered from the last pass, so a bracket keeps its
 * lane for as long as it is on screen.
 *
 * @param input - The rendered rows and the virtualizer measuring them.
 * @returns Where the overlay goes and what to draw in it.
 */
export function useFlowEdges({
	items,
	virtualizer,
	scrollMargin,
	chunks,
}: FlowInput): FlowDrawing {
	return useMemo(() => {
		const measured = virtualizer.measurementsCache;
		const first = measured[virtualizer.range?.startIndex ?? 0];
		const last = measured[virtualizer.range?.endIndex ?? 0];
		const top = first ? first.start - scrollMargin : 0;
		const bottom = last ? last.start - scrollMargin + last.size : 0;

		const rendered = new Set<number>();
		for (const item of items) rendered.add(item.index);

		const edges: FlowEdge[] = [];
		for (const item of items) {
			const row = rowOf(chunks, item.index);
			if (row?.kind !== "code" || row.targetIndex == null) continue;
			if (!rendered.has(row.targetIndex)) continue;
			if (spansHeaderRow(measured, item.index, row.targetIndex)) continue;
			const from = measured[item.index];
			const to = measured[row.targetIndex];
			if (!from || !to) continue;
			const edge = makeFlowEdge({
				fromIndex: item.index,
				toIndex: row.targetIndex,
				fromStart: from.start - scrollMargin,
				fromSize: from.size,
				toStart: to.start - scrollMargin,
				toSize: to.size,
				color: flowColor(row.type),
			});
			if (edge) edges.push(edge);
		}
		const placed = assignLanes(edges, laneMemory);
		if (laneMemory.size > LANE_MEMORY_MAX) laneMemory.clear();
		for (const edge of placed) laneMemory.set(edge.key, edge.lane);
		return {
			top,
			height: Math.max(bottom - top, 0),
			edges: placed,
			connected: new Set(placed.map((edge) => edge.fromIndex)),
		};
		// `items` is deliberately not read above: it is what changes identity as
		// the window scrolls and as rows are measured, which is what makes this
		// drawing follow the scroll instead of freezing on the first window's
		// offsets.
	}, [items, virtualizer, scrollMargin, chunks]);
}

/**
 * The fetched row at a listing index, if it has been fetched.
 *
 * @param chunks - Fetched rows, keyed by the chunk they came from.
 * @param index - The listing index.
 * @returns The row, or undefined while its chunk is in flight.
 */
function rowOf(
	chunks: Map<number, ListingRow[]>,
	index: number,
): ListingRow | undefined {
	return chunks.get(Math.floor(index / CHUNK))?.[index % CHUNK];
}
