import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Pane } from "@/components/Pane";
import { Input } from "@/components/ui/input";
import { chrome } from "@/lib/chrome";
import { cn } from "@/lib/utils";
import { useAnalysisStore } from "@/store/analysisStore";
import { useBinaryStore } from "@/store/binaryStore";
import type { Function } from "@/types";

export const FUNCTION_DRAG_TYPE = "application/x-recurse-function";

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

	/** Begin editing the name of the function at `addr`. */
	const startRename = (addr: number, current: string) => {
		setDraft(current);
		setRenaming(addr);
	};

	/** Save the in-progress rename (blank clears it). */
	const commitRename = async () => {
		const addr = renaming;
		if (addr === null) return;
		setRenaming(null);
		await renameFunction(addr, draft.trim());
	};

	/** Abandon the in-progress rename. */
	const cancelRename = () => {
		skipBlur.current = true;
		setRenaming(null);
	};
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

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return ordered;
		return ordered.filter((f) =>
			(f.name ?? f.realname ?? f.signature ?? "")
				.toLowerCase()
				.includes(q),
		);
	}, [ordered, query]);

	return (
		<>
			<Pane
				title="Functions"
				count={
					funcs.length > 0
						? `${funcs.length}${indexing ? "+" : ""}`
						: undefined
				}
				scroll={false}
				bodyClassName="flex min-h-0 flex-col"
			>
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
				<div className="scroll-host min-h-0 flex-1 overflow-auto pr-2.5">
					<div className="flex flex-col">
						{busy && filtered.length === 0 ? (
							<div className="text-muted-foreground flex items-center gap-2 px-3 py-3 text-xs">
								<Loader2 className="h-3.5 w-3.5 animate-spin" />
								analyzing…
							</div>
						) : (
							<>
								{filtered.map((f) => {
									const name =
										f.name ??
										f.realname ??
										f.signature ??
										`sub_${f.addr.toString(16)}`;
									const active = selected?.addr === f.addr;
									const editing = renaming === f.addr;
									return (
										<div
											key={`${f.addr}-${name}`}
											onContextMenu={(event) => {
												if (editing) return;
												event.preventDefault();
												setContextMenu({
													function: f,
													x: event.clientX,
													y: event.clientY,
												});
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
													onChange={(e) =>
														setDraft(e.target.value)
													}
													onKeyDown={(e) => {
														if (e.key === "Enter")
															e.currentTarget.blur();
														else if (
															e.key === "Escape"
														)
															cancelRename();
													}}
													onBlur={() => {
														if (skipBlur.current) {
															skipBlur.current = false;
															return;
														}
														void commitRename();
													}}
													className="min-w-0 flex-1 bg-transparent text-xs outline-none"
												/>
											) : (
												<>
													<button
														draggable={!editing}
														onDragStart={(
															event,
														) => {
															event.dataTransfer.effectAllowed =
																"copy";
															event.dataTransfer.setData(
																FUNCTION_DRAG_TYPE,
																String(f.addr),
															);
															event.dataTransfer.setData(
																"text/plain",
																String(f.addr),
															);
														}}
														className="flex min-w-0 flex-1 items-center gap-2 text-left"
														onClick={() =>
															selectFn(f)
														}
														onDoubleClick={() =>
															startRename(
																f.addr,
																name,
															)
														}
														title={`${name}\n${fmtAddr(f.addr)} · size ${f.size ?? "?"}\ndouble-click to rename`}
													>
														<span
															className={cn(
																"nums font-mono",
																active
																	? "opacity-80"
																	: "text-asm-addr",
															)}
														>
															{fmtAddr(f.addr)}
														</span>
														<span className="truncate">
															{name}
														</span>
													</button>
													<button
														className="text-muted-foreground hover:text-foreground text-2xs hidden shrink-0 px-1 group-hover:block"
														onClick={(e) => {
															e.stopPropagation();
															startRename(
																f.addr,
																name,
															);
														}}
													>
														Rename
													</button>
												</>
											)}
										</div>
									);
								})}
								{filtered.length === 0 && (
									<div className="text-muted-foreground px-3 py-3 text-center text-xs">
										{query.trim()
											? `no functions match "${query.trim()}"`
											: "no functions"}
									</div>
								)}
							</>
						)}
					</div>
				</div>
			</Pane>
			{contextMenu && (
				<div
					className="border-border bg-card fixed z-50 min-w-44 rounded-md border p-1 shadow-xl"
					style={{
						left: Math.min(contextMenu.x, window.innerWidth - 190),
						top: Math.min(contextMenu.y, window.innerHeight - 110),
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
							startRename(
								contextMenu.function.addr,
								contextMenu.function.name ??
									contextMenu.function.realname ??
									contextMenu.function.signature ??
									`sub_${contextMenu.function.addr.toString(16)}`,
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
