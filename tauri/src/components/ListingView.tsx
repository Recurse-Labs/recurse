import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";

import { api } from "@/api";
import { FlowOverlay } from "@/components/listing/FlowGutter";
import { ListingRowView } from "@/components/listing/ListingRow";
import { useFlowEdges } from "@/components/listing/useFlowEdges";
import { useListingRows } from "@/components/listing/useListingRows";
import { FLOW_GUTTER_W, ROW_H } from "@/lib/flowGutter";
import { useAnalysisStore } from "@/store/analysisStore";
import type { Function } from "@/types";

/**
 * The whole-image listing: every mapped section — code, rodata, data, bss — in
 * address order, on one scrollable surface. Rows are fetched a window at a time
 * as the view scrolls, so a multi-megabyte image is never held in the browser at
 * once, and the flow connectors in the left-hand gutter are drawn from the same
 * measurements the rows are placed with.
 *
 * @param props.scrollRef - The scroll container this listing virtualizes within.
 * @param props.binaryPath - Resets the fetched rows when the target changes.
 * @param props.selectedAddr - The selected row's address, for highlighting.
 * @param props.focusAddr - An address to scroll to when it changes (a function
 *   chosen elsewhere, e.g. the function list).
 * @param props.onGoTo - Called when a function header is activated.
 * @param props.onSelectAddress - Called with a row's address when it is clicked.
 * @returns The listing surface.
 */
export function ListingView({
	scrollRef,
	binaryPath,
	selectedAddr,
	focusAddr,
	onGoTo,
	onSelectAddress,
}: {
	scrollRef: RefObject<HTMLDivElement | null>;
	binaryPath?: string;
	selectedAddr?: number | null;
	focusAddr?: number | null;
	onGoTo?: (f: Function) => void;
	onSelectAddress?: (addr: number) => void;
}) {
	const funcs = useAnalysisStore((s) => s.funcs);
	const funcByAddr = useMemo(() => {
		const m = new Map<number, Function>();
		for (const f of funcs) {
			if (typeof f.addr === "number" && f.name) m.set(f.addr, f);
		}
		return m;
	}, [funcs]);

	const listRef = useRef<HTMLDivElement>(null);
	const [total, setTotal] = useState(0);
	const [scrollMargin, setScrollMargin] = useState(0);
	// Widest row seen. The list is sized to it so the section and function
	// bands span the whole scrollable width: sized to the viewport instead,
	// they slide left under a horizontal scroll and leave a gap, and their
	// centred headers get clipped at the edge.
	const [contentWidth, setContentWidth] = useState(0);
	const maxWidthRef = useRef(0);

	// TanStack's virtualizer: a hook whose result cannot be memoized, and this
	// app does not run the React Compiler, so the hazard the rule warns about
	// cannot occur. Same silence as the function list.
	// eslint-disable-next-line react-hooks/incompatible-library
	const virtualizer = useVirtualizer({
		count: total,
		getScrollElement: () => scrollRef.current,
		estimateSize: () => ROW_H,
		overscan: 24,
		scrollMargin,
	});

	const items = virtualizer.getVirtualItems();
	const rows = useListingRows(
		{
			firstIndex: items.length ? items[0].index : 0,
			lastIndex: items.length ? items[items.length - 1].index : 0,
		},
		setTotal,
	);
	const { error, bytesCh, rowAt } = rows;

	// A new target is a new address space; drop every cached row and the width.
	const { reset } = rows;
	useEffect(() => {
		reset();
		setTotal(0);
		maxWidthRef.current = 0;
		setContentWidth(0);
	}, [binaryPath, reset]);

	const flow = useFlowEdges({
		items,
		virtualizer,
		scrollMargin,
		chunks: rows.chunks,
	});

	// Measure a row for the window (its height) and for the list width (its
	// content), so the bands can span every row. The width only ever grows.
	const measureRow = useCallback(
		(node: HTMLDivElement | null) => {
			virtualizer.measureElement(node);
			if (!node) return;
			const wide = node.scrollWidth;
			if (wide > maxWidthRef.current + 8) {
				maxWidthRef.current = wide;
				setContentWidth(wide);
			}
		},
		[virtualizer],
	);

	useEffect(() => {
		scrollRef.current?.style.setProperty(
			"--listing-bytes-w",
			`${bytesCh}ch`,
		);
	}, [bytesCh, scrollRef]);

	// Scroll to a focus address once the listing's length is known: locating a
	// row needs the built index, which exists only after the first window
	// returns a total.
	useEffect(() => {
		if (focusAddr == null || total === 0) return;
		let cancelled = false;
		api.listingLocate(focusAddr)
			.then((index) => {
				if (!cancelled) {
					virtualizer.scrollToIndex(index, { align: "start" });
				}
			})
			.catch(() => {
				/* the backend has no listing to scroll within */
			});
		return () => {
			cancelled = true;
		};
	}, [focusAddr, total, virtualizer]);

	// The list may begin below other content in the shared scroll container;
	// measure its offset so the window aligns with the rows. The state write
	// bails when unchanged, so this does not loop.
	// eslint-disable-next-line react-hooks/exhaustive-deps
	useEffect(() => {
		const el = listRef.current;
		if (!el) return;
		const margin = el.offsetTop;
		setScrollMargin((current) => (current === margin ? current : margin));
	});

	if (error) {
		return (
			<div className="text-muted-foreground px-3 py-3 text-xs">
				This backend does not provide a whole-image listing.
			</div>
		);
	}

	return (
		<div
			ref={listRef}
			// `isolate` keeps the overlay's stacking inside the listing, so the
			// connectors cannot paint over the sticky column header above it.
			className="relative isolate"
			style={{
				height: `${virtualizer.getTotalSize()}px`,
				width: contentWidth ? `${contentWidth}px` : undefined,
			}}
		>
			<FlowOverlay
				edges={flow.edges}
				top={flow.top}
				height={flow.height}
			/>
			{items.map((item) => {
				const row = rowAt(item.index);
				return (
					<div
						key={item.index}
						data-index={item.index}
						ref={measureRow}
						style={{
							position: "absolute",
							insetBlockStart: 0,
							insetInlineStart: 0,
							width: "100%",
							transform: `translateY(${item.start - scrollMargin}px)`,
						}}
					>
						{row ? (
							<ListingRowView
								row={row}
								func={
									row.kind === "code"
										? (funcByAddr.get(row.addr) ?? null)
										: null
								}
								active={row.addr === selectedAddr}
								connected={flow.connected.has(item.index)}
								onGoTo={onGoTo}
								onSelect={onSelectAddress}
							/>
						) : (
							<div
								className="data-row text-muted-foreground font-mono"
								style={{ paddingLeft: FLOW_GUTTER_W + 12 }}
							>
								…
							</div>
						)}
					</div>
				);
			})}
		</div>
	);
}
