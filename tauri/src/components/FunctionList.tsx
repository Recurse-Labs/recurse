import { Loader2 } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import { Pane } from "@/components/Pane";
import { Input } from "@/components/ui/input";
import { chrome } from "@/lib/chrome";
import { buildFunctionContext } from "@/lib/listingSelection";
import { cn } from "@/lib/utils";
import { useAnalysisStore } from "@/store/analysisStore";
import { useBinaryStore } from "@/store/binaryStore";
import { useContextStore } from "@/store/contextStore";
import { useUiStore } from "@/store/uiStore";
import type { Function } from "@/types";

/**
 * One row's height, in pixels, as the windowing needs to know it.
 *
 * Read from the stylesheet rather than repeated here, so the estimate and the
 * real height cannot drift apart. Rows are a fixed height by construction
 * (`chrome.row`), which is what makes them windowable at all.
 */
const ROW_H = 18;

/**
 * Format an address the way the list and its rows both write it.
 *
 * @param a - The address.
 * @returns The address as `0x` plus lowercase hex.
 *
 * @example
 * fmtAddr(0x1000); // => "0x1000"
 */
function fmtAddr(a: number) {
	return `0x${a.toString(16)}`;
}

/** Lower rank sorts first: entry points and `main` above everything else. */
function fnRank(f: Function, entry?: number): number {
	if (typeof entry === "number" && f.addr === entry) return 0;
	const name = (f.name ?? f.realname ?? f.signature ?? "")
		.toLowerCase()
		.replace(/^(sym\.|imp\.|fcn_)/, "");
	if (name === "main" || name === "__main") return 1;
	if (
		name === "_start" ||
		name === "start" ||
		name === "entry" ||
		name === "entry0" ||
		name === "_entry"
	)
		return 2;
	if (name.includes("libc_start_main")) return 3;
	if (
		name === "_init" ||
		name === "init" ||
		name === "_fini" ||
		name === "fini"
	)
		return 4;
	return 5;
}

/**
 * The name a function is listed under: what the analyst named it, then what the
 * engine knew, then something that at least identifies the address.
 *
 * @param f - The function.
 * @returns The name to show.
 *
 * @example
 * displayName({ addr: 0x1000, signature: "int f(int)" }); // => "int f(int)"
 */
function displayName(f: Function): string {
	return f.name ?? f.realname ?? f.signature ?? `sub_${f.addr.toString(16)}`;
}

/** Everything a row needs, so it can be compared without its parent's render. */
interface RowProps {
	fn: Function;
	active: boolean;
	editing: boolean;
	draft: string;
	onSelect: (f: Function) => void;
	onStartRename: (addr: number, current: string) => void;
	onDraftChange: (text: string) => void;
	onCommit: () => void;
	onCancel: () => void;
	onContextMenu: (f: Function, x: number, y: number) => void;
}

/**
 * One function in the list: its address, its name, and the field to rename it.
 *
 * Memoized because the list re-renders whenever the analyst types in the filter
 * or the background indexer adds a function, and neither changes any row that is
 * already on screen.
 */
const FunctionRow = memo(function FunctionRow({
	fn,
	active,
	editing,
	draft,
	onSelect,
	onStartRename,
	onDraftChange,
	onCommit,
	onCancel,
	onContextMenu,
}: RowProps) {
	const name = displayName(fn);
	return (
		<div
			onContextMenu={(event) => {
				if (editing) return;
				event.preventDefault();
				onContextMenu(fn, event.clientX, event.clientY);
			}}
			className={cn(
				chrome.row,
				"group border-l-2",
				active
					? "border-foreground ui-selected"
					: "hover:bg-accent border-transparent",
			)}
		>
			{editing ? (
				<input
					autoFocus
					value={draft}
					placeholder="name (blank clears)"
					onChange={(e) => onDraftChange(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") e.currentTarget.blur();
						else if (e.key === "Escape") onCancel();
					}}
					onBlur={onCommit}
					className="min-w-0 flex-1 bg-transparent text-xs outline-none"
				/>
			) : (
				<>
					<button
						className="flex min-w-0 flex-1 items-center gap-2 text-left"
						onClick={() => onSelect(fn)}
						onDoubleClick={() => onStartRename(fn.addr, name)}
						title={`${name}\n${fmtAddr(fn.addr)} · size ${fn.size ?? "?"}\ndouble-click to rename`}
					>
						<span
							className={cn(
								"nums font-mono",
								active ? "opacity-80" : "text-asm-addr",
							)}
						>
							{fmtAddr(fn.addr)}
						</span>
						<span className="truncate">{name}</span>
					</button>
					<button
						className="text-muted-foreground hover:text-foreground text-2xs hidden shrink-0 px-1 group-hover:block"
						onClick={(e) => {
							e.stopPropagation();
							onStartRename(fn.addr, name);
						}}
					>
						Rename
					</button>
				</>
			)}
		</div>
	);
});

export function FunctionList() {
	const funcs = useAnalysisStore((s) => s.funcs);
	const selected = useAnalysisStore((s) => s.selected);
	const selectFn = useAnalysisStore((s) => s.selectFn);
	const renameFunction = useAnalysisStore((s) => s.renameFunction);
	const busy = useBinaryStore((s) => s.busy);
	const indexing = useBinaryStore((s) => s.indexing);
	const entry = useBinaryStore((s) => s.binary?.info?.bin?.entry);
	const [query, setQuery] = useState("");
	const [renaming, setRenaming] = useState<number | null>(null);
	const [draft, setDraft] = useState("");
	const [contextMenu, setContextMenu] = useState<{
		function: Function;
		x: number;
		y: number;
	} | null>(null);
	const skipBlur = useRef(false);
	const scrollRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!contextMenu) return;
		const close = () => setContextMenu(null);
		window.addEventListener("click", close);
		window.addEventListener("keydown", close);
		return () => {
			window.removeEventListener("click", close);
			window.removeEventListener("keydown", close);
		};
	}, [contextMenu]);

	/** Save the in-progress rename (blank clears it). */
	const commitRename = useCallback(async () => {
		const addr = renaming;
		if (addr === null) return;
		setRenaming(null);
		await renameFunction(addr, draft.trim());
	}, [renaming, renameFunction, draft]);

	const onSelect = useCallback(
		(f: Function) => {
			selectFn(f);
		},
		[selectFn],
	);

	// The function goes to the agent by identity — name, address, signature,
	// size — not by its disassembly.
	const addToContext = useCallback((f: Function) => {
		const context = buildFunctionContext(f);
		useContextStore.getState().add({
			source: "function",
			label: context.label,
			text: context.text,
		});
		useUiStore.getState().setChatOpen(true);
	}, []);

	const onStartRename = useCallback((addr: number, current: string) => {
		setDraft(current);
		setRenaming(addr);
	}, []);

	const onDraftChange = useCallback((text: string) => {
		setDraft(text);
	}, []);

	const onContextMenuFor = useCallback(
		(f: Function, x: number, y: number) => {
			setContextMenu({ function: f, x, y });
		},
		[],
	);

	// A commit that must not fire when the rename was only cancelled: the blur
	// that follows Escape would otherwise save the name the analyst backed out
	// of. Only one row edits at a time, so this identity changing costs nothing.
	const onCommitRow = useCallback(() => {
		if (skipBlur.current) {
			skipBlur.current = false;
			return;
		}
		void commitRename();
	}, [commitRename]);

	const onCancelRow = useCallback(() => {
		skipBlur.current = true;
		setRenaming(null);
	}, []);
	const [prevFuncs, setPrevFuncs] = useState(funcs);
	if (prevFuncs !== funcs) {
		setPrevFuncs(funcs);
		setQuery("");
	}

	// Entry points and `main` float to the top; the rest stay in address order.
	const ordered = useMemo(
		() =>
			[...funcs].sort(
				(a, b) =>
					fnRank(a, entry) - fnRank(b, entry) || a.addr - b.addr,
			),
		[funcs, entry],
	);

	// A keystroke re-filters the whole list, and the lowercasing a search needs
	// is the expensive half of that — so it is done once per function per list
	// rebuild rather than once per function per keystroke.
	const searchable = useMemo(
		() => ordered.map((f) => ({ f, key: displayName(f).toLowerCase() })),
		[ordered],
	);

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return ordered;
		const out: Function[] = [];
		for (const { f, key } of searchable) {
			if (key.includes(q)) out.push(f);
		}
		return out;
	}, [ordered, searchable, query]);

	// Windowed, because a large binary has tens of thousands of functions and
	// only the two dozen on screen are ever looked at. `overscan` is what keeps
	// a fast scroll from showing gaps.
	//
	// The compiler's `incompatible-library` rule is silenced here: it is advice
	// about auto-memoization, and this app does not run the React Compiler
	// (`@vitejs/plugin-react` is configured with no compiler plugin), so the
	// hazard it describes cannot occur here.
	// eslint-disable-next-line react-hooks/incompatible-library
	const virtualizer = useVirtualizer({
		count: filtered.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: () => ROW_H,
		overscan: 12,
		// Rows are a fixed height, so a scroll needs no re-render: the
		// virtualizer writes each row's position directly and only asks React
		// for a render when a new row enters the window. Dropping the
		// synchronous render the default forces inside the scroll handler is
		// what keeps a fast scroll from stuttering. See `ListingView`.
		directDomUpdates: true,
		useFlushSync: false,
	});

	return (
		<>
			{/* No pane title: the sidebar's tab above already says "Functions" and
			    how many, and a second label for the same list is the same fact twice.
			    The count lives on the tab, where the Data tab's does. */}
			<Pane scroll={false} bodyClassName="flex min-h-0 flex-col">
				<div className="px-2 py-1.5">
					<Input
						placeholder="Filter functions…"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
					/>
				</div>
				{indexing && (
					<div className="text-muted-foreground/80 text-2xs flex items-center gap-1.5 px-3 pb-1.5">
						<Loader2 className="h-3 w-3 animate-spin" />
						indexing in the background — more may appear
					</div>
				)}
				{/* `pr-2.5` reserves a gutter for the overlay scrollbar (w-2.5),
			    so it never covers the rename button on hover. */}
				<div
					ref={scrollRef}
					className="scroll-host min-h-0 flex-1 overflow-auto pr-2.5"
				>
					{busy && filtered.length === 0 ? (
						<div className="text-muted-foreground flex items-center gap-2 px-3 py-3 text-xs">
							<Loader2 className="h-3.5 w-3.5 animate-spin" />
							analyzing…
						</div>
					) : (
						<div
							ref={virtualizer.containerRef}
							className="relative"
						>
							{virtualizer.getVirtualItems().map((row) => {
								const f = filtered[row.index];
								if (!f) return null;
								return (
									<div
										key={`${f.addr}-${f.name ?? f.realname ?? ""}`}
										data-index={row.index}
										ref={virtualizer.measureElement}
										style={{
											position: "absolute",
											insetBlockStart: 0,
											insetInlineStart: 0,
											width: "100%",
										}}
									>
										<FunctionRow
											fn={f}
											active={selected?.addr === f.addr}
											editing={renaming === f.addr}
											draft={draft}
											onSelect={onSelect}
											onStartRename={onStartRename}
											onDraftChange={onDraftChange}
											onCommit={onCommitRow}
											onCancel={onCancelRow}
											onContextMenu={onContextMenuFor}
										/>
									</div>
								);
							})}
						</div>
					)}
					{filtered.length === 0 && (
						<div className="text-muted-foreground px-3 py-3 text-center text-xs">
							{query.trim()
								? `no functions match "${query.trim()}"`
								: "no functions"}
						</div>
					)}
				</div>
			</Pane>
			{contextMenu && (
				<div
					className="border-border bg-card fixed z-50 min-w-44 rounded-md border p-1 shadow-xl"
					style={{
						left: Math.min(contextMenu.x, window.innerWidth - 190),
						top: Math.min(contextMenu.y, window.innerHeight - 140),
					}}
					onClick={(event) => event.stopPropagation()}
				>
					<button
						type="button"
						className="hover:bg-accent flex w-full items-center rounded-sm px-2.5 py-1.5 text-left text-xs"
						onClick={() => {
							selectFn(contextMenu.function);
							setContextMenu(null);
						}}
					>
						Open in new tab
					</button>
					<button
						type="button"
						className="hover:bg-accent flex w-full items-center rounded-sm px-2.5 py-1.5 text-left text-xs"
						onClick={() => {
							addToContext(contextMenu.function);
							setContextMenu(null);
						}}
					>
						Add to context
					</button>
					<button
						type="button"
						className="hover:bg-accent flex w-full items-center rounded-sm px-2.5 py-1.5 text-left text-xs"
						onClick={() => {
							onStartRename(
								contextMenu.function.addr,
								displayName(contextMenu.function),
							);
							setContextMenu(null);
						}}
					>
						Rename
					</button>
				</div>
			)}
		</>
	);
}
