import { ChevronRight, Loader2 } from "lucide-react";
import {
	lazy,
	Suspense,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DebugPanel } from "@/components/DebugPanel";
import { PanelErrorBoundary } from "@/components/PanelErrorBoundary";
import { ReconPanel } from "@/components/ReconPanel";
import { cn } from "@/lib/utils";
import { chrome } from "@/lib/chrome";
import { callTarget } from "@/lib/calls";
import { DisasmComment, DisasmInstr, splitComment } from "@/lib/disasm";
import { api } from "@/api";
import { useAnalysisStore } from "@/store/analysisStore";
import { useBinaryStore } from "@/store/binaryStore";
import { useContextStore } from "@/store/contextStore";
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

function OpRow({
	op,
	target,
	onGoTo,
}: {
	op: {
		addr: number;
		bytes?: string | null;
		text?: string;
		disasm?: string;
		jump?: number | null;
		ptr?: number | null;
	};
	target?: Function | null;
	onGoTo?: (f: Function) => void;
}) {
	const text = op.text ?? op.disasm ?? "";
	const { instr, comment } = splitComment(text);
	const clickable = !!target;
	return (
		<div
			className={cn(
				chrome.row,
				"gap-3 pl-3",
				clickable && "hover:bg-accent/70 cursor-pointer",
			)}
			onClick={clickable && onGoTo ? () => onGoTo(target) : undefined}
			title={
				clickable
					? `Go to ${target.name ?? fmtAddr(target.addr)}`
					: undefined
			}
		>
			<span
				className="nums text-asm-addr min-w-[9ch] shrink-0 font-mono"
				title="Virtual address"
			>
				{fmtAddr(op.addr)}
			</span>
			<span
				className="text-asm-bytes min-w-[16ch] shrink-0 font-mono"
				title="Machine code bytes (hex)"
			>
				{op.bytes ?? ""}
			</span>
			<span
				className={cn(
					"text-foreground",
					clickable &&
						"text-primary underline decoration-dotted underline-offset-2",
				)}
				title="Disassembly (mnemonic + operands)"
			>
				{instr && <DisasmInstr text={instr} />}
				<DisasmComment comment={comment} />
				{typeof op.jump === "number" && (
					<span className="text-asm-jump"> → {fmtAddr(op.jump)}</span>
				)}
				{typeof op.ptr === "number" && (
					<span className="text-asm-jump">
						{" "}
						; [{fmtAddr(op.ptr)}]
					</span>
				)}
			</span>
		</div>
	);
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

	const runGenerateSignature = async () => {
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
	};

	const runIndexBinary = async () => {
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
	};

	const runShowSimilar = async () => {
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
	};
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

	const visibleImports = useMemo(() => {
		const q = importQuery.trim().toLowerCase();
		if (!q) return imports;
		return imports.filter((imp) =>
			(imp.name ?? "").toLowerCase().includes(q),
		);
	}, [imports, importQuery]);

	// Address → function lookup so call instructions can resolve to their target.
	const funcByAddr = useMemo(() => {
		const m = new Map<number, Function>();
		for (const f of funcs) {
			if (typeof f.addr === "number") m.set(f.addr, f);
		}
		return m;
	}, [funcs]);

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

	// Reset scroll whenever the selected function changes so a new function
	// always renders from the top (no stale scroll position from the previous
	// function's assembly/decompiled view). Runs pre-paint to avoid a flash.
	useLayoutEffect(() => {
		scrollRef.current?.scrollTo({ top: 0 });
	}, [selectedAddr]);

	const loadXrefs = async () => {
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
	};

	const toggleXrefs = () => {
		if (xrefsOpen && xrefsAddress === selectedAddr) {
			setXrefsOpen(false);
			return;
		}
		setXrefsOpen(true);
		void loadXrefs();
	};

	const currentXrefs = xrefsAddress === selectedAddr ? xrefs : [];
	const currentXrefsError = xrefsAddress === selectedAddr ? xrefsError : null;
	const currentXrefsLoading = xrefsAddress === selectedAddr && xrefsLoading;

	const sourceFunction = (xref: Xref): Function | undefined => {
		if (xref.fcn_name) {
			const byName = funcs.find(
				(f) => f.name === xref.fcn_name || f.realname === xref.fcn_name,
			);
			if (byName) return byName;
		}
		return funcs.find(
			(f) =>
				typeof f.size === "number" &&
				xref.from >= f.addr &&
				xref.from < f.addr + f.size,
		);
	};

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
					<div className="ml-auto flex items-center gap-1">
						<div className="ui-seg" role="group" aria-label="View">
							<button
								type="button"
								aria-pressed={viewMode === "linear"}
								onClick={() => setViewMode("linear")}
								title="Linear disassembly"
							>
								Linear
							</button>
							<button
								type="button"
								aria-pressed={viewMode === "graph"}
								onClick={() => setViewMode("graph")}
								title="Control-flow graph (pan/zoom)"
							>
								Graph
							</button>
						</div>
						{capabilities?.decompile !== false && (
							<Button
								variant="toolbar"
								size="sm"
								onClick={decompile}
								disabled={decompiling || !selected}
							>
								{decompiling ? "Decompiling…" : "Decompile"}
							</Button>
						)}
						<Button
							variant="toolbar"
							size="sm"
							className="ui-press"
							aria-pressed={xrefsOpen}
							onClick={toggleXrefs}
							disabled={!selected}
							title="Show incoming cross-references"
						>
							Xrefs
						</Button>
						<Button
							variant="toolbar"
							size="sm"
							onClick={() => void runGenerateSignature()}
							disabled={!selected || toolBusy}
							title="Generate a wildcarded byte-pattern signature for this function"
						>
							Sig
						</Button>
						<Button
							variant="toolbar"
							size="sm"
							onClick={() => void runShowSimilar()}
							disabled={!selected || toolBusy}
							title="Find similar functions in the cross-binary corpus"
						>
							Similar
						</Button>
						<Button
							variant="toolbar"
							size="sm"
							onClick={() => void runIndexBinary()}
							disabled={toolBusy}
							title="Index every function of this binary into the similarity corpus"
						>
							Index
						</Button>
						<Button
							variant="toolbar"
							size="sm"
							onClick={refreshDisasm}
							disabled={asmLoading}
							title="Reload"
						>
							{asmLoading ? "Loading" : "Reload"}
						</Button>
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
					<DebugPanel />
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
																"hover:bg-accent flex w-full items-center gap-2 px-2.5 py-1.5 text-left font-mono text-xs disabled:cursor-default",
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
										{asmLoading && (
											<div className="text-muted-foreground px-3 py-3">
												disassembling…
											</div>
										)}
										{!selected && !asmLoading && (
											<div className="text-muted-foreground px-3 py-3">
												Select a function to disassemble
												it.
											</div>
										)}
										{selected &&
											!asmLoading &&
											(!asm?.ops ||
												asm.ops.length === 0) && (
												<div className="text-muted-foreground px-3 py-3">
													No instructions.
												</div>
											)}
										{selected &&
											!asmLoading &&
											(asm?.ops?.length ?? 0) > 0 && (
												<div className="border-border bg-card text-2xs flex gap-3 border-b px-3 py-1 font-semibold tracking-wider uppercase">
													<span className="text-asm-addr w-[9ch] shrink-0">
														Address
													</span>
													<span className="text-asm-bytes w-[16ch] shrink-0">
														Bytes
													</span>
													<span className="text-muted-foreground">
														Instruction
													</span>
												</div>
											)}
										{asm?.ops?.map((op) => (
											<OpRow
												key={op.addr}
												op={op}
												target={callTarget(
													op,
													funcByAddr,
												)}
												onGoTo={selectFn}
											/>
										))}
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
													className="hover:bg-accent"
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
											{visibleImports.length.toLocaleString()}{" "}
											of {imports.length.toLocaleString()}
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
											{visibleImports.map((imp, i) => (
												<tr
													key={i}
													className="hover:bg-accent"
												>
													<td className="px-3 py-px">
														{imp.name ??
															"(unnamed)"}
													</td>
												</tr>
											))}
											{visibleImports.length === 0 && (
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
									{highlight(
										decompiled,
										decompiledAnnotations,
									)}
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
