import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";

import { api } from "@/api";
import { clearHeaderInfoCache } from "@/components/FunctionHeader";
import { ListingContextMenu } from "@/components/ListingContextMenu";
import { ListingRowSlot } from "@/components/ListingRow";
import type { BuiltContext, Selection } from "@/lib/listingSelection";
import { useListingSelection } from "@/lib/useListingSelection";
import { useAnalysisStore } from "@/store/analysisStore";
import type { Function, ListingRow } from "@/types";

/** Rows fetched per request. Small enough to stay snappy, large enough that a
 * fast scroll does not outrun the fetches. */
const CHUNK = 256;

/** One listing row's height, matching the row's fixed `h-[18px]`. The window
 * places every row from this estimate; only a row that opens a function is
 * taller, and the virtualizer measures that one. */
const ROW_H = 18;

/**
 * The whole-image listing: every mapped section — code, rodata, data, bss — in
 * address order, on one scrollable surface. Rows are fetched a window at a time
 * as the view scrolls, so a multi-megabyte image is never held in the browser
 * at once.
 *
 * The selection is owned by the panel and handed down: the view reports what a
 * gesture produced, along with the excerpt it spells, and renders the highlight
 * the panel hands back. That keeps a drag's re-render to the rows that entered
 * or left the range instead of the whole listing.
 *
 * @param props.scrollRef - The scroll container this listing virtualizes within.
 * @param props.binaryPath - Resets the cached rows when the target changes.
 * @param props.selectedAddr - The selected row's address, highlighted until a
 *   selection replaces it.
 * @param props.focusAddr - An address to scroll to when it changes (a function
 *   chosen elsewhere, e.g. the function list).
 * @param props.onGoTo - Called when a function row is activated.
 * @param props.selection - The current native selection.
 * @param props.onSelect - Called with a new selection and its context excerpt.
 * @param props.onAddToContext - Called to add the selection to the agent.
 * @returns The listing surface.
 */
export function ListingView({
	scrollRef,
	binaryPath,
	selectedAddr,
	focusAddr,
	onGoTo,
	selection,
	onSelect,
	onAddToContext,
}: {
	scrollRef: RefObject<HTMLDivElement | null>;
	binaryPath?: string;
	selectedAddr?: number | null;
	focusAddr?: number | null;
	onGoTo?: (f: Function) => void;
	selection: Selection;
	onSelect: (next: Selection, context: BuiltContext | null) => void;
	onAddToContext?: (context: BuiltContext) => void;
}) {
	const funcs = useAnalysisStore((s) => s.funcs);
	const funcByAddr = useMemo(() => {
		const m = new Map<number, Function>();
		for (const f of funcs) {
			if (typeof f.addr === "number" && f.name) m.set(f.addr, f);
		}
		return m;
	}, [funcs]);

	const [chunks, setChunks] = useState<Map<number, ListingRow[]>>(new Map());
	const [total, setTotal] = useState(0);
	const [error, setError] = useState<string | null>(null);
	const inflight = useRef<Set<number>>(new Set());
	const listRef = useRef<HTMLDivElement>(null);
	const [scrollMargin, setScrollMargin] = useState(0);
	// Widest row seen. The list is sized to it so the section and function
	// bands span the whole scrollable width: sized to the viewport instead,
	// they slide left under a horizontal scroll and leave a gap, and their
	// centred headers get clipped at the edge.
	const [contentWidth, setContentWidth] = useState(0);
	const maxWidthRef = useRef(0);

	// Every selection gesture — click, drag, arrows, the context menu — is
	// resolved here and reported up; the view only renders what comes back.
	const { selectedSet, containerProps, menu, closeMenu } =
		useListingSelection({
			selection,
			chunks,
			funcByAddr,
			total,
			chunkSize: CHUNK,
			focusRef: listRef,
			onSelect,
			onAddToContext,
		});

	// A new target is a new address space; drop every cached row, the width, and
	// the headers derived from the old one's instructions — an address means a
	// different function here, so a cached header would describe the wrong one.
	useEffect(() => {
		setChunks(new Map());
		setTotal(0);
		setError(null);
		inflight.current = new Set();
		maxWidthRef.current = 0;
		setContentWidth(0);
		clearHeaderInfoCache();
	}, [binaryPath]);

	// TanStack's virtualizer: a hook whose result cannot be memoized, and this
	// app does not run the React Compiler, so the hazard the rule warns about
	// cannot occur. Same silence as the function list.
	//
	// `directDomUpdates` keeps a scroll from re-rendering the view at all: the
	// virtualizer writes each row's transform itself and only asks React for a
	// render when a new row enters the window. `useFlushSync: false` drops the
	// synchronous render the default would force inside the scroll handler,
	// which is what makes a fast scroll stutter. Together they move a fast
	// scroll off React and onto the compositor.
	// eslint-disable-next-line react-hooks/incompatible-library
	const virtualizer = useVirtualizer({
		count: total,
		getScrollElement: () => scrollRef.current,
		estimateSize: () => ROW_H,
		overscan: 24,
		scrollMargin,
		directDomUpdates: true,
		useFlushSync: false,
	});

	const items = virtualizer.getVirtualItems();
	const firstIndex = items.length ? items[0].index : 0;
	const lastIndex = items.length ? items[items.length - 1].index : 0;

	// The size container the virtualizer writes its height into directly; the
	// listing also keeps the same node to measure the offset it starts at.
	const setListRef = useCallback(
		(node: HTMLDivElement | null) => {
			listRef.current = node;
			virtualizer.containerRef(node);
		},
		[virtualizer],
	);

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
		const want = (index: number) => {
			const chunk = Math.floor(index / CHUNK);
			if (chunks.has(chunk) || inflight.current.has(chunk)) return;
			inflight.current.add(chunk);
			api.listing(chunk * CHUNK, CHUNK)
				.then((window) => {
					inflight.current.delete(chunk);
					setTotal(window.total);
					setChunks((prev) => {
						if (prev.has(chunk)) return prev;
						const next = new Map(prev);
						next.set(chunk, window.rows);
						return next;
					});
				})
				.catch((e) => {
					inflight.current.delete(chunk);
					setError(String(e));
				});
		};
		if (total === 0) {
			want(0);
		} else {
			want(firstIndex);
			want(lastIndex);
		}
	}, [firstIndex, lastIndex, total, chunks]);

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
		<>
			<div
				ref={setListRef}
				tabIndex={0}
				className="relative outline-none"
				{...containerProps}
				style={{
					// The height is owned by `containerRef`, which writes it without
					// a render; setting it here too would fight that write.
					// At least the viewport, and wider only when a row is. Sized to
					// the content alone, a listing whose rows are all narrow stops
					// short of the panel's edge: the selected-row band and the
					// centred FUNCTION banner would end at the content, leaving a
					// dead margin a selected instruction does not span.
					width: contentWidth ? `${contentWidth}px` : undefined,
					minWidth: "100%",
				}}
			>
				{items.map((item) => {
					const row = chunks.get(Math.floor(item.index / CHUNK))?.[
						item.index % CHUNK
					];
					// Until the analyst selects something, the row the app chose
					// elsewhere (a function's entry) stays highlighted.
					const fallback =
						selectedSet.size === 0 && row?.addr === selectedAddr;
					return (
						<ListingRowSlot
							key={item.index}
							index={item.index}
							row={row}
							func={
								row?.kind === "code"
									? (funcByAddr.get(row.addr) ?? null)
									: null
							}
							selected={fallback || selectedSet.has(item.index)}
							cursor={fallback || selection.anchor === item.index}
							measure={measureRow}
							onGoTo={onGoTo}
						/>
					);
				})}
			</div>
			{menu && (
				<ListingContextMenu
					x={menu.x}
					y={menu.y}
					actions={menu.actions}
					onClose={closeMenu}
				/>
			)}
		</>
	);
}
