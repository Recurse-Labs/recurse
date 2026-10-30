import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
	KeyboardEvent as ReactKeyboardEvent,
	MouseEvent as ReactMouseEvent,
	RefObject,
} from "react";

import {
	buildFunctionContext,
	buildListingContext,
	EMPTY_SELECTION,
	extendTo,
	moveCursor,
	selectAt,
	type BuiltContext,
	type ContextEntry,
	type Selection,
} from "./listingSelection";
import type { Function, ListingRow } from "../types";

/** The row index under an event's target, or null when the target is a control
 * the row hosts (a button, an input) rather than the row itself. */
function indexAt(target: EventTarget | null): number | null {
	if (!(target instanceof Element)) return null;
	if (
		target.closest(
			"button, input, select, textarea, a, [contenteditable='true']",
		)
	) {
		return null;
	}
	const el = target.closest<HTMLElement>("[data-index]");
	if (!el) return null;
	const index = Number(el.dataset.index);
	return Number.isInteger(index) ? index : null;
}

/** A right-click menu: where it opened, and what it offers. */
export interface ListingMenu {
	x: number;
	y: number;
	actions: { label: string; run: () => void }[];
}

interface Options {
	/** The current selection, owned by the panel. */
	selection: Selection;
	/** The rows loaded so far, keyed by chunk. */
	chunks: Map<number, ListingRow[]>;
	/** The function each address starts, for naming a selection's rows. */
	funcByAddr: Map<number, Function>;
	/** The listing's total row count, for clamping the caret. */
	total: number;
	/** Rows per fetched chunk. */
	chunkSize: number;
	/** The focusable list node, focused on a click so arrows reach it. */
	focusRef: RefObject<HTMLDivElement | null>;
	/** Report the selection and its rendered context up to the panel. */
	onSelect: (next: Selection, context: BuiltContext | null) => void;
	/** Add the selection to the agent's context. */
	onAddToContext?: (context: BuiltContext) => void;
}

/**
 * The listing's native selection gestures.
 *
 * Every way of selecting rows — click, shift-click, Ctrl/Cmd-click, drag,
 * arrows, shift-arrows, Ctrl/Cmd-A, Escape — lands here and leaves as one
 * {@link Selection} plus the excerpt it spells, so the view stays a renderer
 * and the selection rules stay testable.
 *
 * @param options - The selection, the loaded rows, and the reporting callbacks.
 * @returns The selected index set, the list's handlers, and the open menu.
 */
export function useListingSelection({
	selection,
	chunks,
	funcByAddr,
	total,
	chunkSize,
	focusRef,
	onSelect,
	onAddToContext,
}: Options) {
	const selectedSet = useMemo(
		() => new Set(selection.indices),
		[selection.indices],
	);
	const dragging = useRef(false);
	const [menu, setMenu] = useState<ListingMenu | null>(null);

	// The excerpt the agent would receive: the selected rows that are loaded,
	// each paired with the function it belongs to.
	const rowAt = useCallback(
		(index: number): ListingRow | undefined =>
			chunks.get(Math.floor(index / chunkSize))?.[index % chunkSize],
		[chunks, chunkSize],
	);

	const contextFor = useCallback(
		(sel: Selection): BuiltContext | null => {
			const entries: ContextEntry[] = [];
			for (const i of sel.indices) {
				const row = rowAt(i);
				if (!row) continue;
				entries.push({
					row,
					func:
						row.kind === "code"
							? (funcByAddr.get(row.addr) ?? null)
							: null,
				});
			}
			return buildListingContext(entries);
		},
		[rowAt, funcByAddr],
	);

	const apply = useCallback(
		(next: Selection) => onSelect(next, contextFor(next)),
		[onSelect, contextFor],
	);

	// A drag can end anywhere, including outside the list, so the release is
	// watched on the window rather than on the surface.
	useEffect(() => {
		const up = () => {
			dragging.current = false;
		};
		window.addEventListener("mouseup", up);
		return () => window.removeEventListener("mouseup", up);
	}, []);

	const loadedIndices = useCallback((): number[] => {
		const out: number[] = [];
		for (const [chunk, rows] of chunks) {
			for (let i = 0; i < rows.length; i++)
				out.push(chunk * chunkSize + i);
		}
		return out.sort((a, b) => a - b);
	}, [chunks, chunkSize]);

	const onMouseDown = useCallback(
		(e: ReactMouseEvent) => {
			if (e.button !== 0) return;
			const index = indexAt(e.target);
			if (index == null) return;
			// Suppress the browser's text selection: a drag across the rows is
			// a row range here, not a copied paragraph.
			e.preventDefault();
			focusRef.current?.focus({ preventScroll: true });
			dragging.current = true;
			apply(
				selectAt(selection, index, {
					shift: e.shiftKey,
					toggle: e.metaKey || e.ctrlKey,
				}),
			);
		},
		[apply, selection, focusRef],
	);

	const onMouseMove = useCallback(
		(e: ReactMouseEvent) => {
			if (!dragging.current || (e.buttons & 1) === 0) return;
			const index = indexAt(e.target);
			if (index == null) return;
			apply(extendTo(selection, index));
		},
		[apply, selection],
	);

	const onKeyDown = useCallback(
		(e: ReactKeyboardEvent) => {
			if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				e.preventDefault();
				apply(
					moveCursor(
						selection,
						e.key === "ArrowDown" ? 1 : -1,
						e.shiftKey,
						total,
					),
				);
			} else if (e.key === "Escape") {
				e.preventDefault();
				apply(EMPTY_SELECTION);
			} else if (
				(e.metaKey || e.ctrlKey) &&
				e.key.toLowerCase() === "a"
			) {
				e.preventDefault();
				const loaded = loadedIndices();
				apply({ indices: loaded, anchor: loaded[0] ?? null });
			}
		},
		[apply, selection, total, loadedIndices],
	);

	const onContextMenu = useCallback(
		(e: ReactMouseEvent) => {
			const index = indexAt(e.target);
			if (index == null) return;
			e.preventDefault();
			// A right-click inside the selection keeps it; outside, it selects
			// the row first, the way a native menu acts on what was clicked.
			const next = selection.indices.includes(index)
				? selection
				: selectAt(selection, index, {});
			const context = contextFor(next);
			if (!context) return;
			onSelect(next, context);
			// A function's entry row can attach the function itself, by
			// identity, alongside the rows the selection spells out.
			const clicked = rowAt(index);
			const func =
				clicked?.kind === "code"
					? funcByAddr.get(clicked.addr)
					: undefined;
			const actions: ListingMenu["actions"] = [];
			if (func && onAddToContext) {
				actions.push({
					label: "Add function to context",
					run: () => onAddToContext(buildFunctionContext(func)),
				});
			}
			if (onAddToContext) {
				actions.push({
					label: "Add selection to context",
					run: () => onAddToContext(context),
				});
			}
			actions.push({
				label: "Copy",
				run: () => void navigator.clipboard?.writeText(context.text),
			});
			actions.push({
				label: "Clear selection",
				run: () => apply(EMPTY_SELECTION),
			});
			setMenu({ x: e.clientX, y: e.clientY, actions });
		},
		[
			selection,
			contextFor,
			rowAt,
			funcByAddr,
			onSelect,
			onAddToContext,
			apply,
		],
	);

	const closeMenu = useCallback(() => setMenu(null), []);

	return {
		selectedSet,
		containerProps: { onMouseDown, onMouseMove, onKeyDown, onContextMenu },
		menu,
		closeMenu,
	};
}
