import { ChevronRight, Loader2 } from "lucide-react";
import {
	lazy,
	Suspense,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	readDisasmView,
	storeDisasmView,
	type DisasmViewOptions,
} from "@/components/DisasmBytes";
import { PanelErrorBoundary } from "@/components/PanelErrorBoundary";
import { ReconPanel } from "@/components/ReconPanel";
import { cn } from "@/lib/utils";
import { ListingView } from "@/components/ListingView";
import { MENU } from "@/lib/commands";
import { disasmMenuSections } from "@/lib/disasmMenu";
import {
	buildFunctionContext,
	EMPTY_SELECTION,
	type BuiltContext,
	type Selection,
} from "@/lib/listingSelection";
import { clearSections, publishSections } from "@/lib/menuRegistry";
import { api } from "@/api";
import { useAnalysisStore } from "@/store/analysisStore";
import { useBinaryStore } from "@/store/binaryStore";
import { useContextStore } from "@/store/contextStore";
import { useNavStore } from "@/store/navStore";
import { useUiStore } from "@/store/uiStore";
import type { DecompileAnnotation, Function, Xref } from "@/types";

const R2Console = lazy(() =>
	import("@/components/R2Console").then((m) => ({ default: m.R2Console })),
);

const GraphPanel = lazy(() =>
	import("@/components/GraphPanel").then((m) => ({ default: m.GraphPanel })),
);

const CallGraphPanel = lazy(() =>
	import("@/components/CallGraphPanel").then((m) => ({
		default: m.CallGraphPanel,
	})),
);

const FindingsPanel = lazy(() =>
	import("@/components/FindingsPanel").then((m) => ({
		default: m.FindingsPanel,
	})),
);

const HexPanel = lazy(() =>
	import("@/components/HexPanel").then((m) => ({ default: m.HexPanel })),
);

// The debugger pane, deferred like its siblings. It carries the registers pane,
// the CPU view, the stack and the output transcript — none of which are needed
// until the analyst opens the Debug tab, and all of which were in the first
// chunk until they were.
const DebugPanel = lazy(() =>
	import("@/components/DebugPanel").then((m) => ({ default: m.DebugPanel })),
);

function fmtAddr(a?: number | null) {
	return typeof a === "number" ? `0x${a.toString(16)}` : "";
}

/**
 * The last segment of a path, for either separator.
 *
 * ```
 * baseName("/usr/bin/youki") // => "youki"
 * baseName("C:\\tools\\youki.exe") // => "youki.exe"
 * baseName(undefined) // => "binary"
 * ```
 */
function baseName(path: string | undefined): string {
	if (!path) return "binary";
	const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	return path.slice(i + 1);
}

const HL_COLORS: Record<string, string> = {
	keyword: "text-asm-mnemonic",
	comment: "text-muted-foreground italic",
	datatype: "text-asm-addr",
	function_name: "text-asm-jump",
	function_parameter: "text-asm-string",
	local_variable: "text-asm-register",
	constant_variable: "text-asm-number",
};

/**
 * Color a decompiled source according to the engine's annotations.
 *
 * Annotations are byte ranges over the source, so they are flattened into a
 * per-character category first and then coalesced back into runs — which is
 * linear in the source, and is why the caller memoizes the result.
 *
 * @param code - The decompiled source.
 * @param annotations - Ranges to color, from the engine.
 * @returns Runs of text, each in a `<span>` when the engine named a category.
 *
 * @example
 * highlight("mov a, b", [{ start: 0, end: 3, syntax_highlight: "instruction" }]);
 * // => [<span className="text-asm-instruction">"mov"</span>, " a, b"]
 */
function highlight(
	code: string,
	annotations: DecompileAnnotation[],
): ReactNode[] {
	const cats = new Array<string>(code.length).fill("");
	for (const a of annotations) {
		if (!Number.isFinite(a.start) || !Number.isFinite(a.end)) continue;
		const color = HL_COLORS[a.syntax_highlight ?? a.type ?? ""];
		if (!color) continue;
		for (let i = a.start; i < a.end && i < code.length; i++) {
			cats[i] = color;
		}
	}
	const spans: ReactNode[] = [];
	let i = 0;
	while (i < code.length) {
		const color = cats[i];
		let j = i;
		while (j < code.length && cats[j] === color) j++;
		spans.push(
			color ? (
				<span key={i} className={color}>
					{code.slice(i, j)}
				</span>
			) : (
				code.slice(i, j)
			),
		);
		i = j;
	}
	return spans;
}

export function CenterPanel() {
	const tab = useUiStore((s) => s.tab);
	const selected = useAnalysisStore((s) => s.selected);
	const funcs = useAnalysisStore((s) => s.funcs);
	const selectFn = useAnalysisStore((s) => s.selectFn);
	const asm = useAnalysisStore((s) => s.asm);
	const asmLoading = useAnalysisStore((s) => s.asmLoading);
	const strings = useAnalysisStore((s) => s.strings);
	const imports = useAnalysisStore((s) => s.imports);
	const decompiled = useAnalysisStore((s) => s.decompiled);
	const decompiledAnnotations = useAnalysisStore(
		(s) => s.decompiledAnnotations,
	);
	const decompileError = useAnalysisStore((s) => s.decompileError);
	const decompiling = useAnalysisStore((s) => s.decompiling);
	const refreshDisasm = useAnalysisStore((s) => s.refreshDisasm);
	const decompile = useAnalysisStore((s) => s.decompile);
	const clearDecompiled = useAnalysisStore((s) => s.clearDecompiled);
	// Capabilities of the active backend; hide affordances it cannot serve
	// (decompile / raw console on native). Undefined = older host, show them.
	const capabilities = useBinaryStore((s) => s.binary?.capabilities);
	const binaryPath = useBinaryStore((s) => s.binary?.path);
	// Coloring walks every character of the source, so it is done when the
	// source changes and not when the window does.
	const highlighted = useMemo(
		() =>
			decompiled ? highlight(decompiled, decompiledAnnotations) : null,
		[decompiled, decompiledAnnotations],
	);

	const pending = useContextStore((s) => s.pending);
	const setPending = useContextStore((s) => s.setPending);
	const commitPending = useContextStore((s) => s.commitPending);

	// Signature-generation / semantic-similarity results for the selected
	// function, shown inline below the disasm toolbar until dismissed.
	const [toolResult, setToolResult] = useState<{
		title: string;
		lines: string[];
	} | null>(null);
	const [toolBusy, setToolBusy] = useState(false);

	const runGenerateSignature = useCallback(async () => {
		if (!selected) return;
		setToolBusy(true);
		try {
			const sig = await api.generateSignature(selected.addr);
			setToolResult({
				title: `Signature: ${sig.name}`,
				lines: [
					sig.pattern,
					`${sig.concrete_byte_count}/${sig.byte_count} concrete bytes`,
				],
			});
		} catch (e) {
			setToolResult({ title: "Signature failed", lines: [String(e)] });
		} finally {
			setToolBusy(false);
		}
	}, [selected]);

	const runIndexBinary = useCallback(async () => {
		setToolBusy(true);
		try {
			const res = await api.semanticIndex();
			setToolResult({
				title: "Indexed for similarity search",
				lines: [
					`${res.indexed} functions added — corpus now holds ${res.corpus_size.toLocaleString()}`,
				],
			});
		} catch (e) {
			setToolResult({ title: "Indexing failed", lines: [String(e)] });
		} finally {
			setToolBusy(false);
		}
	}, []);

	const runShowSimilar = useCallback(async () => {
		if (!selected) return;
		setToolBusy(true);
		try {
			const res = await api.semanticSimilar(selected.addr);
			setToolResult({
				title: `Similar functions (corpus: ${res.corpus_size.toLocaleString()})`,
				lines:
					res.matches.length === 0
						? [
								'No matches. Use "Index" (this binary, or others opened previously) to populate the corpus first.',
							]
						: res.matches.map(
								(m) =>
									`${(m.similarity * 100).toFixed(0)}%  ${m.name} @ 0x${m.address.toString(16)}  (${m.binary})`,
							),
			});
		} catch (e) {
			setToolResult({
				title: "Similarity search failed",
				lines: [String(e)],
			});
		} finally {
			setToolBusy(false);
		}
	}, [selected]);

	const scrollRef = useRef<HTMLDivElement>(null);
	const selectedAddr = selected?.addr;
	const [consoleMounted, setConsoleMounted] = useState(false);
	const [viewMode, setViewMode] = useState<"linear" | "graph">("linear");
	const [xrefs, setXrefs] = useState<Xref[]>([]);
	const [xrefsAddress, setXrefsAddress] = useState<number | null>(null);
	const [xrefsOpen, setXrefsOpen] = useState(false);
	const [xrefsLoading, setXrefsLoading] = useState(false);
	const [xrefsError, setXrefsError] = useState<string | null>(null);
	const [stringQuery, setStringQuery] = useState("");
	const [importQuery, setImportQuery] = useState("");
	const [viewOptions, setViewOptions] =
		useState<DisasmViewOptions>(readDisasmView);
	const [listingSelection, setListingSelection] =
		useState<Selection>(EMPTY_SELECTION);
	const [listingContext, setListingContext] = useState<BuiltContext | null>(
		null,
	);

	// The listing reports both the selection and the excerpt it spells, so the
	// panel can offer the agent action without knowing the listing's rows.
	const handleListingSelect = useCallback(
		(next: Selection, context: BuiltContext | null) => {
			setListingSelection(next);
			setListingContext(context);
		},
		[],
	);

	// Add the selection to the agent's context as one item — the function
	// header and its rows — then clear the highlight so a second click does not
	// add it twice.
	const addListingContext = useCallback((context: BuiltContext) => {
		useContextStore.getState().add({
			source: "disasm",
			label: context.label,
			text: context.text,
		});
		setListingSelection(EMPTY_SELECTION);
		setListingContext(null);
		useUiStore.getState().setChatOpen(true);
	}, []);

	// A whole function attached by identity: name, address, signature, size.
	// Deliberately not its disassembly — that is what selecting its lines is
	// for, and a body would drown the question it is meant to support.
	const addFunctionContext = useCallback((func: Function) => {
		const context = buildFunctionContext(func);
		useContextStore.getState().add({
			source: "function",
			label: context.label,
			text: context.text,
		});
		useUiStore.getState().setChatOpen(true);
	}, []);

	// A new function or target is a new listing: the old selection's indices
	// would point at different rows now. Adjusted during render, guarded, so the
	// reset lands in the same commit as the new listing rather than a frame
	// later.
	const listingKey = `${binaryPath ?? ""}\u0000${selectedAddr ?? ""}`;
	const [selectionKey, setSelectionKey] = useState(listingKey);
	if (selectionKey !== listingKey) {
		setSelectionKey(listingKey);
		setListingSelection(EMPTY_SELECTION);
		setListingContext(null);
	}

	const updateViewOption = useCallback(
		(key: keyof DisasmViewOptions, value: boolean) => {
			setViewOptions((current) => {
				const next = { ...current, [key]: value };
				storeDisasmView(next);
				return next;
			});
		},
		[],
	);

	// Withdrawn when the panel goes, so the View menu stops offering commands that
	// act on a disassembly that is no longer on screen.
	useEffect(() => clearSections, []);

	// Large Rust binaries can carry 100k+ strings (youki: 113k). Rendering
	// them all freezes the webview, so filter first and cap the row count.
	const visibleStrings = useMemo(() => {
		const q = stringQuery.trim().toLowerCase();
		const CAP = 2000;
		if (!q)
			return {
				rows: strings.slice(0, CAP),
				total: strings.length,
				capped: strings.length > CAP,
			};
		const matched = strings.filter((s) =>
			(s.string ?? "").toLowerCase().includes(q),
		);
		return {
			rows: matched.slice(0, CAP),
			total: matched.length,
			capped: matched.length > CAP,
		};
	}, [strings, stringQuery]);

	// A large binary can import tens of thousands of symbols, and the table has
	// no pagination: it renders what it is given. Capped the way the strings
	// table is, with the count saying so rather than the list stopping silently.
	const visibleImports = useMemo(() => {
		const IMPORTS_CAP = 2000;
		const q = importQuery.trim().toLowerCase();
		if (!q)
			return {
				rows: imports.slice(0, IMPORTS_CAP),
				capped: imports.length > IMPORTS_CAP,
			};
		const matched = imports.filter((imp) =>
			(imp.name ?? "").toLowerCase().includes(q),
		);
		return {
			rows: matched.slice(0, IMPORTS_CAP),
			capped: matched.length > IMPORTS_CAP,
		};
	}, [imports, importQuery]);

	// Mount (and keep mounted) the console the first time its tab is opened, so
	// its state survives tab switches. Adjusting state during render is the
	// documented React pattern here (guarded, no effect).
	if (tab === "console" && !consoleMounted) {
		setConsoleMounted(true);
	}

	// Track text selection in the disassembly / decompiler views so the user
	// can add the selected text to the agent's context (Ctrl+L or the hint).
	const handleSelection = () => {
		requestAnimationFrame(() => {
			const sel = window.getSelection();
			const text = sel?.toString().trim() ?? "";
			if (!text) {
				setPending(null);
				return;
			}
			const anchor = sel?.anchorNode;
			const inView =
				anchor instanceof Node && scrollRef.current?.contains(anchor);
			if (!inView) {
				setPending(null);
				return;
			}
			const source = tab === "disasm" ? "disasm" : "decompile";
			const label = selected
				? `${fmtAddr(selected.addr)} · ${selected.name ?? "fn"}`
				: "selection";
			setPending({ source, label, text });
		});
	};

	// Every selected address is a step on the path, so history can walk it.
	// Returning to an address already at the cursor re-selects it, which `push`
	// ignores, so the record is not corrupted by walking back over it.
	useEffect(() => {
		if (selectedAddr != null) useNavStore.getState().push(selectedAddr);
	}, [selectedAddr]);
	useEffect(() => {
		useNavStore.getState().reset();
	}, [binaryPath]);

	const loadXrefs = useCallback(async () => {
		if (!selected) return;
		const addr = selected.addr;
		setXrefsAddress(addr);
		setXrefsLoading(true);
		setXrefsError(null);
		try {
			const result = await api.xrefsTo(addr);
			if (useAnalysisStore.getState().selected?.addr === addr) {
				setXrefs(result ?? []);
			}
		} catch (e) {
			if (useAnalysisStore.getState().selected?.addr === addr) {
				setXrefsError(String(e));
			}
		} finally {
			setXrefsLoading(false);
		}
	}, [selected]);

	const toggleXrefs = useCallback(() => {
		if (xrefsOpen && xrefsAddress === selectedAddr) {
			setXrefsOpen(false);
			return;
		}
		setXrefsOpen(true);
		void loadXrefs();
	}, [xrefsOpen, xrefsAddress, selectedAddr, loadXrefs]);

	// The commands live in the bar at the top of the window, and they answer to
	// what this panel is holding: which function is selected, which tool is busy,
	// which columns are on. Publishing on every render is a field assignment and
	// nothing more, and the bar reads it only when a menu is opened — so the
	// alternative, a store written from an effect, would buy a re-render nobody
	// asked for.
	//
	// Published even when the disassembly is not the tab on screen, with every
	// option marked inactive: a View menu that emptied itself whenever the reader
	// looked at Strings would drop out of the bar and slide back in, and a command
	// that vanishes between two visits is one nobody waits for.
	useEffect(() => {
		publishSections(
			MENU.view,
			disasmMenuSections({
				inactive: tab !== "disasm",
				viewMode,
				viewOptions,
				canDecompile: capabilities?.decompile !== false,
				decompiling,
				xrefsOpen,
				toolBusy,
				asmLoading,
				hasSelection: !!selected,
				onViewModeChange: setViewMode,
				onOptionChange: updateViewOption,
				onDecompile: () => void decompile(),
				onToggleXrefs: () => toggleXrefs(),
				onGenerateSignature: () => void runGenerateSignature(),
				onShowSimilar: () => void runShowSimilar(),
				onIndexBinary: () => void runIndexBinary(),
				onRefresh: () => void refreshDisasm(),
			}),
		);
	}, [
		tab,
		viewMode,
		viewOptions,
		capabilities?.decompile,
		decompiling,
		xrefsOpen,
		toolBusy,
		asmLoading,
		selected,
		setViewMode,
		updateViewOption,
		decompile,
		toggleXrefs,
		runGenerateSignature,
		runShowSimilar,
		runIndexBinary,
		refreshDisasm,
	]);

	const currentXrefs = xrefsAddress === selectedAddr ? xrefs : [];
	const currentXrefsError = xrefsAddress === selectedAddr ? xrefsError : null;
	const currentXrefsLoading = xrefsAddress === selectedAddr && xrefsLoading;

	// An incoming-reference list is one row per reference, and each row has to
	// find the function it came from. Doing that with a `find` per row made the
	// list quadratic in the binary's function count, so both lookups are built
	// once: by name, and by the address ranges a reference can fall inside.
	const funcsByName = useMemo(() => {
		const m = new Map<string, Function>();
		for (const f of funcs) {
			if (f.name && !m.has(f.name)) m.set(f.name, f);
			if (f.realname && !m.has(f.realname)) m.set(f.realname, f);
		}
		return m;
	}, [funcs]);

	const sizedFuncs = useMemo(
		() =>
			funcs
				.filter((f) => typeof f.size === "number")
				.slice()
				.sort((a, b) => a.addr - b.addr),
		[funcs],
	);

	const sourceFunction = useCallback(
		(xref: Xref): Function | undefined => {
			if (xref.fcn_name) {
				const byName = funcsByName.get(xref.fcn_name);
				if (byName) return byName;
			}
			// The last function starting at or before the reference whose range
			// contains it. Sorted by address, so this is a binary search rather
			// than a walk over every function in the binary.
			let lo = 0;
			let hi = sizedFuncs.length - 1;
			let found: Function | undefined;
			while (lo <= hi) {
				const mid = (lo + hi) >> 1;
				const f = sizedFuncs[mid];
				if (f.addr <= xref.from) {
					found = f;
					lo = mid + 1;
				} else {
					hi = mid - 1;
				}
			}
			if (
				found &&
				typeof found.size === "number" &&
				xref.from < found.addr + found.size
			) {
				return found;
			}
			return undefined;
		},
		[funcsByName, sizedFuncs],
	);

	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col">
			{tab === "disasm" && (
				<div className="border-border bg-card ui-bar shrink-0 gap-2 border-b px-3">
					{selected && (
						<>
							<span className="text-muted-foreground truncate text-xs">
								{baseName(binaryPath)}
							</span>
							<ChevronRight className="text-muted-foreground/50 h-3 w-3 shrink-0" />
							<span className="text-foreground truncate text-xs font-medium">
								{selected.name ??
									selected.signature ??
									"unknown"}
							</span>
							<span className="text-muted-foreground nums shrink-0 font-mono text-xs">
								{fmtAddr(selected.addr)} ·{" "}
								{asm?.size ?? selected.size ?? "?"} bytes
							</span>
						</>
					)}
					<div className="ml-auto flex shrink-0 items-center gap-1">
						{listingContext && (
							<Button
								variant="toolbar"
								size="sm"
								onClick={() =>
									addListingContext(listingContext)
								}
								title="Add the selected listing lines to the agent's context"
							>
								Add {listingContext.count} line
								{listingContext.count === 1 ? "" : "s"}
							</Button>
						)}
						{selected && (
							<Button
								variant="toolbar"
								size="sm"
								onClick={() => addFunctionContext(selected)}
								title="Add this function's name, address and signature to the agent's context"
							>
								Add function
							</Button>
						)}
					</div>
				</div>
			)}
			{toolResult && (
				<div className="border-border bg-muted/30 flex items-start justify-between gap-3 border-b px-3 py-2">
					<div className="min-w-0 flex-1">
						<div className="text-xs font-semibold">
							{toolResult.title}
						</div>
						{toolResult.lines.map((l, i) => (
							<div
								key={i}
								className="text-muted-foreground mt-0.5 max-w-full truncate font-mono text-[11px]"
								title={l}
							>
								{l}
							</div>
						))}
					</div>
					<Button
						variant="toolbar"
						size="sm"
						onClick={() => setToolResult(null)}
						title="Dismiss"
					>
						Dismiss
					</Button>
				</div>
			)}

			<div className="flex min-h-0 min-w-0 flex-1 flex-col">
				{tab === "recon" ? (
					<ReconPanel key={binaryPath} />
				) : tab === "debug" ? (
					<Suspense
						fallback={
							<div className="text-muted-foreground px-3 py-3 text-xs">
								loading debugger…
							</div>
						}
					>
						<DebugPanel />
					</Suspense>
				) : tab === "callgraph" ? (
					<Suspense
						fallback={
							<div className="text-muted-foreground px-3 py-3 text-xs">
								loading call graph…
							</div>
						}
					>
						<CallGraphPanel />
					</Suspense>
				) : tab === "findings" ? (
					<Suspense
						fallback={
							<div className="text-muted-foreground px-3 py-3 text-xs">
								loading findings…
							</div>
						}
					>
						<FindingsPanel />
					</Suspense>
				) : tab === "hex" ? (
					<Suspense
						fallback={
							<div className="text-muted-foreground px-3 py-3 text-xs">
								loading hex view…
							</div>
						}
					>
						<HexPanel />
					</Suspense>
				) : tab === "disasm" && viewMode === "graph" && selected ? (
					<Suspense
						fallback={
							<div className="text-muted-foreground px-3 py-3 text-xs">
								loading graph…
							</div>
						}
					>
						<GraphPanel addr={selected.addr} />
					</Suspense>
				) : (
					<>
						<div
							ref={scrollRef}
							onMouseUp={handleSelection}
							className="scroll-host relative min-h-0 min-w-0 flex-1 overflow-auto"
						>
							{pending && (
								<div className="absolute top-2 right-2 z-20 flex items-center gap-1">
									<Button
										variant="toolbar"
										size="sm"
										onClick={commitPending}
										title="Add selection to agent context (Ctrl+L)"
									>
										Add to context
									</Button>
									<Button
										variant="toolbar"
										size="sm"
										onClick={() => setPending(null)}
									>
										Dismiss
									</Button>
								</div>
							)}
							{tab === "disasm" && (
								<>
									{xrefsOpen &&
										selected &&
										xrefsAddress === selectedAddr && (
											<div className="border-border bg-card mx-3 my-2 max-h-44 overflow-auto rounded-md border">
												<div className="text-muted-foreground flex items-center justify-between px-2.5 py-1.5 text-xs">
													<span>
														Incoming references
													</span>
													<span>
														{currentXrefs.length}
													</span>
												</div>
												{currentXrefsLoading && (
													<div className="text-muted-foreground flex items-center gap-1.5 px-2.5 py-2 text-xs">
														<Loader2 className="h-3.5 w-3.5 animate-spin" />
														Loading xrefs…
													</div>
												)}
												{currentXrefsError && (
													<div className="text-destructive px-2.5 py-2 text-xs">
														{currentXrefsError}
													</div>
												)}
												{!currentXrefsLoading &&
													!currentXrefsError &&
													currentXrefs.length ===
														0 && (
														<div className="text-muted-foreground px-2.5 py-2 text-xs">
															No incoming
															references.
														</div>
													)}
												{currentXrefs.map((xref, i) => {
													const source =
														sourceFunction(xref);
													return (
														<button
															key={`${xref.from}-${i}`}
															type="button"
															disabled={!source}
															onClick={() =>
																source &&
																selectFn(source)
															}
															className={cn(
																"offscreen-row hover:bg-accent flex w-full items-center gap-2 px-2.5 py-1.5 text-left font-mono text-xs disabled:cursor-default",
																source &&
																	"text-primary",
															)}
															title={
																source
																	? "Go to source function"
																	: undefined
															}
														>
															<span className="w-[9ch] shrink-0">
																{fmtAddr(
																	xref.from,
																)}
															</span>
															<span className="min-w-0 flex-1 truncate">
																{source?.name ??
																	xref.fcn_name ??
																	"unknown function"}
															</span>
															<span className="text-muted-foreground max-w-[45%] truncate">
																{xref.opcode ??
																	xref.type ??
																	"reference"}
															</span>
														</button>
													);
												})}
											</div>
										)}
									<div className="font-mono text-xs">
										<div className="border-border bg-card text-2xs flex gap-3 border-b px-3 py-1 font-semibold tracking-wider uppercase">
											<span className="text-asm-addr w-[19ch] shrink-0">
												Address
											</span>
											<span className="text-asm-bytes w-[26ch] shrink-0 pr-3">
												Bytes
											</span>
											<span className="text-muted-foreground">
												Instruction / Data
											</span>
										</div>
										<ListingView
											scrollRef={scrollRef}
											binaryPath={binaryPath}
											selectedAddr={selectedAddr}
											focusAddr={selectedAddr}
											onGoTo={selectFn}
											selection={listingSelection}
											onSelect={handleListingSelect}
											onAddToContext={addListingContext}
										/>
									</div>
								</>
							)}

							{tab === "strings" && (
								<div className="flex min-h-0 flex-1 flex-col">
									<div className="border-border bg-card sticky top-0 z-10 flex items-center gap-2 border-b px-3 py-1.5">
										<Input
											value={stringQuery}
											onChange={(e) =>
												setStringQuery(e.target.value)
											}
											placeholder={`Filter ${strings.length.toLocaleString()} strings…`}
											className="w-64 font-mono"
										/>
										<span className="text-muted-foreground text-xs">
											showing{" "}
											{visibleStrings.rows.length.toLocaleString()}{" "}
											of{" "}
											{visibleStrings.total.toLocaleString()}
											{visibleStrings.capped
												? " (capped at 2,000 — refine the filter)"
												: ""}
										</span>
									</div>
									<table className="w-full font-mono text-xs">
										<thead className="bg-card sticky top-0">
											<tr className="text-muted-foreground text-left text-xs">
												<th className="px-3 py-1.5">
													Offset
												</th>
												<th className="px-3 py-1.5">
													Type
												</th>
												<th className="px-3 py-1.5">
													String
												</th>
											</tr>
										</thead>
										<tbody>
											{visibleStrings.rows.map((s, i) => (
												<tr
													key={`${s.vaddr}-${i}-${s.string?.slice(0, 16)}`}
													className="hover:bg-accent offscreen-row"
												>
													<td className="text-primary px-3 py-px">
														{fmtAddr(s.vaddr)}
													</td>
													<td className="px-3 py-px">
														{s.type ?? ""}
													</td>
													<td
														className="max-w-0 truncate px-3 py-px"
														title={s.string}
													>
														{s.string}
													</td>
												</tr>
											))}
											{visibleStrings.rows.length ===
												0 && (
												<tr>
													<td
														colSpan={3}
														className="text-muted-foreground px-3 py-3 text-center"
													>
														{stringQuery.trim()
															? `no strings match "${stringQuery.trim()}"`
															: "no strings"}
													</td>
												</tr>
											)}
										</tbody>
									</table>
								</div>
							)}

							{tab === "imports" && (
								<div className="flex min-h-0 flex-1 flex-col">
									<div className="border-border bg-card sticky top-0 z-10 flex items-center gap-2 border-b px-3 py-1.5">
										<Input
											value={importQuery}
											onChange={(e) =>
												setImportQuery(e.target.value)
											}
											placeholder={`Filter ${imports.length.toLocaleString()} imports…`}
											className="w-64 font-mono"
										/>
										<span className="text-muted-foreground text-xs">
											showing{" "}
											{visibleImports.rows.length.toLocaleString()}{" "}
											of {imports.length.toLocaleString()}
											{visibleImports.capped
												? " (capped at 2,000 — refine the filter)"
												: ""}
										</span>
									</div>
									<table className="w-full font-mono text-xs">
										<thead className="bg-card sticky top-0">
											<tr className="text-muted-foreground text-left text-xs">
												<th className="px-3 py-1.5">
													Import
												</th>
											</tr>
										</thead>
										<tbody>
											{visibleImports.rows.map(
												(imp, i) => (
													<tr
														key={i}
														className="hover:bg-accent offscreen-row"
													>
														<td className="px-3 py-px">
															{imp.name ??
																"(unnamed)"}
														</td>
													</tr>
												),
											)}
											{visibleImports.rows.length ===
												0 && (
												<tr>
													<td className="text-muted-foreground px-3 py-3 text-center">
														{importQuery.trim()
															? `no imports match "${importQuery.trim()}"`
															: "no imports"}
													</td>
												</tr>
											)}
										</tbody>
									</table>
								</div>
							)}
						</div>

						{tab === "disasm" && decompiled && (
							<div className="border-border bg-card relative shrink-0 border-t">
								<pre className="scroll-host text-primary h-64 overflow-auto px-3 py-2 font-mono text-xs">
									{highlighted}
								</pre>
								<Button
									variant="toolbar"
									size="sm"
									className="absolute top-1 right-1"
									onClick={clearDecompiled}
								>
									Close
								</Button>
							</div>
						)}

						{tab === "disasm" && decompileError && (
							<div className="border-destructive bg-destructive/10 text-destructive m-3 rounded-md border p-2.5 font-mono text-xs whitespace-pre-wrap">
								{decompileError}
							</div>
						)}
					</>
				)}
			</div>

			{consoleMounted && (
				<div
					className={cn(
						"min-h-0 min-w-0 flex-1",
						tab !== "console" && "hidden",
					)}
				>
					<PanelErrorBoundary label="Engine Console">
						<Suspense
							fallback={
								<div className="text-muted-foreground px-3 py-3 text-xs">
									loading engine console…
								</div>
							}
						>
							<R2Console />
						</Suspense>
					</PanelErrorBoundary>
				</div>
			)}
		</div>
	);
}
