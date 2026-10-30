import { Loader2 } from "lucide-react";
import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from "react";

import { api } from "@/api";
import { DebugCpu } from "@/components/DebugCpu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { X86_FLAG_BITS } from "@/lib/branches";
import { DebuggerVariableList } from "@/components/VariableList";
import { chrome } from "@/lib/chrome";
import { cn } from "@/lib/utils";
import { useAnalysisStore } from "@/store/analysisStore";
import { useBinaryStore } from "@/store/binaryStore";
import { isLastStopView, isLiveState, useDebugStore } from "@/store/debugStore";
import type { DebugStopReason } from "@/types";

function fmtAddr(a?: number | null): string {
	return typeof a === "number" ? `0x${a.toString(16)}` : "";
}

/** x86-64 RFLAGS, as the set flag names. */
function flagsOf(eflags: number): string {
	return X86_FLAG_BITS.filter(([, bit]) => (eflags >> bit) & 1)
		.map(([name]) => name)
		.join(" ");
}

/**
 * How close to the bottom counts as "at the bottom", in pixels.
 *
 * Not zero: a scrollbar cannot always land exactly on the last pixel, and a
 * transcript that has just gained a wrapped line can be a pixel or two off
 * without the analyst having scrolled at all.
 */
const TAIL_SLOP = 4;

/** Human label for a stop reason. */
function reasonLabel(r?: DebugStopReason): string {
	if (!r) return "—";
	switch (r.reason) {
		case "started":
			return "started";
		case "breakpoint":
			return `breakpoint ${fmtAddr(r.addr)}`;
		case "step":
			return "step";
		case "paused":
			return "paused";
		case "signal":
			return `signal ${r.name ?? r.signal ?? "?"}`;
		case "exited":
			return `exited (${r.code})`;
		case "killed":
			return `killed (signal ${r.signal})`;
		default:
			return r.reason;
	}
}

/** Jump to the function containing a backtrace frame (a runtime address). */
function gotoFrame(addr: number): void {
	const bias = useDebugStore.getState().bias;
	const funcs = useAnalysisStore.getState().funcs;
	const f = funcs.find((x) => x.addr === addr - bias);
	if (f) useAnalysisStore.getState().selectFn(f);
}

function Empty({ label }: { label: string }) {
	return <div className="text-muted-foreground p-3 text-xs">{label}</div>;
}

/** A small uppercase title bar for a docked pane. */
function PaneHeader({ children }: { children: ReactNode }) {
	return (
		<div className="label border-border flex h-[var(--chrome-h)] shrink-0 items-center border-b px-3">
			{children}
		</div>
	);
}

/**
 * One editable register: click the value to write a new one.
 *
 * `changed` marks a register whose value moved at the last stop. It is the one
 * affordance that makes this pane worth scanning: the eye goes to the amber
 * value and the other eighteen can be ignored.
 */
function RegisterRow({
	name,
	value,
	emphasis,
	changed,
}: {
	name: string;
	value: number;
	emphasis?: boolean;
	changed?: boolean;
}) {
	const run = useDebugStore((s) => s.run);
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState("");

	const commit = () => {
		setEditing(false);
		const v = draft.trim();
		if (v) void run("setreg", { name, value: v });
	};

	return (
		<div className="flex justify-between gap-2">
			<span className="text-muted-foreground">{name}</span>
			{editing ? (
				<input
					autoFocus
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") commit();
						else if (e.key === "Escape") setEditing(false);
					}}
					onBlur={commit}
					className="w-full min-w-0 bg-transparent text-right outline-none"
				/>
			) : (
				<button
					className={cn(
						"nums min-w-0 truncate text-right hover:underline",
						emphasis && !changed && "text-primary",
						changed && chrome.changed,
					)}
					title={
						changed
							? "changed at this stop — click to edit"
							: "Click to edit"
					}
					onClick={() => {
						setDraft(fmtAddr(value));
						setEditing(true);
					}}
				>
					{fmtAddr(value)}
				</button>
			)}
		</div>
	);
}

/** The registers with a row of their own above the grid. */
const SPECIALS = ["rip", "rsp", "rbp"];

/** Right column, top: general registers and flags, marked with what moved. */
function RegistersPane() {
	const regs = useDebugStore((s) => s.registers);
	const changed = useDebugStore((s) => s.changedRegisters);
	const stale = isLastStopView(useDebugStore((s) => s.state));
	// Reported by the backend under their own names as well as through
	// `pc`/`sp`/`fp`, and rendered above from those — so the grid skips them, or
	// each would be printed twice. `eflags` is decoded into the flags line and
	// `orig_rax` is noise; neither gets a row, so neither is counted as changed
	// either — a count that names a register with nowhere to show it is worse
	// than no count. Both spellings are listed, since the aarch64 backend calls
	// the first two `pc` and `sp`.
	const skip = new Set([
		"rip",
		"rsp",
		"rbp",
		"pc",
		"sp",
		"eflags",
		"orig_rax",
	]);
	const gp = (regs ? Object.entries(regs.values) : []).filter(
		([k]) => !skip.has(k),
	);
	const changedShown = [...SPECIALS, ...gp.map(([k]) => k)].filter((name) =>
		changed.has(name),
	).length;
	const row = (name: string, value: number, emphasis?: boolean) => (
		<RegisterRow
			name={name}
			value={value}
			emphasis={emphasis}
			changed={changed.has(name)}
		/>
	);
	return (
		<div className="flex min-h-0 flex-col">
			<PaneHeader>
				Registers
				{stale && (
					<span
						className="ml-2 font-normal normal-case opacity-70"
						title="The target is running: these are its registers at the last stop, not a live reading"
					>
						last stop
					</span>
				)}
				{changedShown > 0 && (
					<span
						className={cn(
							"ml-2 font-normal normal-case",
							chrome.changed,
						)}
					>
						{changedShown} changed
					</span>
				)}
			</PaneHeader>
			{!regs ? (
				<Empty label="no registers" />
			) : (
				<div className="scroll-host max-h-72 overflow-auto p-2 font-mono text-xs">
					{row("rip", regs.pc, true)}
					{row("rsp", regs.sp)}
					{row("rbp", regs.fp)}
					<div className="mt-1.5 grid grid-cols-2 gap-x-2 gap-y-0.5">
						{gp.map(([k, v]) => row(k, v))}
					</div>
					<div className="text-muted-foreground mt-1.5">
						flags{" "}
						<span className="text-foreground">
							{flagsOf(regs.values.eflags ?? 0) || "—"}
						</span>
					</div>
				</div>
			)}
		</div>
	);
}

/** Right column, bottom: the words at the stack pointer, with value hints. */
/**
 * The right column's lower pane: the stack, or the current function's variables.
 *
 * Two views of the same function, so they share a header and a switch rather
 * than both asking for space: the stack says where the program is, the
 * variables say what it is working on, and an analyst flipping between them is
 * following one question.
 */
function LowerPane() {
	const [tab, setTab] = useState<"stack" | "vars">("stack");
	const button = (id: "stack" | "vars", label: string) => (
		<button
			className={cn(
				"px-2 py-1 text-xs",
				tab === id
					? "text-foreground border-primary border-b-2"
					: "text-muted-foreground hover:text-foreground",
			)}
			onClick={() => setTab(id)}
		>
			{label}
		</button>
	);
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="label border-border flex h-[var(--chrome-h)] shrink-0 items-center border-b px-1">
				{button("stack", "Stack")}
				{button("vars", "Vars")}
			</div>
			{tab === "stack" ? <StackBody /> : <DebuggerVariableList />}
		</div>
	);
}

function StackBody() {
	const sp = useDebugStore((s) => s.registers?.sp ?? null);
	// Reading the debuggee's memory needs a live process; a finished session has
	// no stack left to read.
	const live = isLiveState(useDebugStore((s) => s.state));
	const bias = useDebugStore((s) => s.bias);
	const funcs = useAnalysisStore((s) => s.funcs);
	const strings = useAnalysisStore((s) => s.strings);
	const [data, setData] = useState<{ sp: number; words: number[] } | null>(
		null,
	);

	useEffect(() => {
		if (sp == null || !live) return;
		let cancelled = false;
		api.debugCommand("read", { addr: sp, len: 256, format: "u64" })
			.then((r) => {
				if (!cancelled) {
					setData({
						sp,
						words: (r as { words?: number[] })?.words ?? [],
					});
				}
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [sp, live]);

	// Static address -> function name, for code pointers on the stack.
	const codeMap = useMemo(() => {
		const m = new Map<number, string>();
		for (const f of funcs) {
			if (typeof f.addr === "number") {
				m.set(
					f.addr,
					f.name ?? f.realname ?? `sub_${f.addr.toString(16)}`,
				);
			}
		}
		return m;
	}, [funcs]);

	// Static address -> string, for pointers to string data.
	const strMap = useMemo(() => {
		const m = new Map<number, string>();
		for (const s of strings) m.set(s.vaddr, s.string ?? "");
		return m;
	}, [strings]);

	/** Resolve a stack word to a symbol, a string, or a stack offset. */
	const hint = (v: number): string => {
		if (v === 0) return "";
		const code = codeMap.get(v - bias);
		if (code) return code;
		const text = strMap.get(v - bias);
		if (text !== undefined) return `"${text.slice(0, 48)}"`;
		if (sp != null && v > sp && v < sp + 0x400) {
			return `=> rsp+0x${(v - sp).toString(16)}`;
		}
		return "";
	};

	const words = sp != null && data && data.sp === sp ? data.words : [];
	return (
		<>
			{sp == null ? (
				<Empty label="no stack" />
			) : (
				<div className="scroll-host min-h-0 flex-1 overflow-auto py-1 font-mono text-xs">
					{words.map((w, i) => {
						const top = i === 0;
						return (
							<div
								key={i}
								className={cn(
									"flex gap-2 px-1 pr-2",
									top && "bg-primary/25",
								)}
							>
								<span className="text-muted-foreground">
									{fmtAddr(sp + i * 8)}
								</span>
								<span className="text-foreground w-[18ch] shrink-0">
									{fmtAddr(w)}
								</span>
								<span className="text-asm-string truncate">
									{top ? "◀ rsp " : ""}
									{hint(w)}
								</span>
							</div>
						);
					})}
					{words.length === 0 && <Empty label="unreadable" />}
				</div>
			)}
		</>
	);
}

/** Bottom tabs: call stack, breakpoints, threads. */
function BottomTabs() {
	const frames = useDebugStore((s) => s.frames);
	const breakpoints = useDebugStore((s) => s.breakpoints);
	const run = useDebugStore((s) => s.run);
	const live = isLiveState(useDebugStore((s) => s.state));
	const pid = useDebugStore((s) => s.pid);
	const [tab, setTab] = useState<
		"stack" | "breakpoints" | "threads" | "trace"
	>("stack");
	const [threads, setThreads] = useState<{
		pid: number | null;
		ids: number[];
	}>({ pid: null, ids: [] });
	const trace = useDebugStore((s) => s.trace);

	useEffect(() => {
		if (tab !== "threads" || !live) return;
		let cancelled = false;
		api.debugCommand("threads")
			.then((t) => {
				if (!cancelled) setThreads({ pid, ids: (t as number[]) ?? [] });
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [tab, live, pid]);

	const threadIds = threads.pid === pid ? threads.ids : [];

	const tabButton = (id: typeof tab, label: string, count?: number) => (
		<button
			className={cn(
				"px-2 py-1 text-xs",
				tab === id
					? "text-foreground border-primary border-b-2"
					: "text-muted-foreground hover:text-foreground",
			)}
			onClick={() => setTab(id)}
		>
			{label}
			{count != null ? ` · ${count}` : ""}
		</button>
	);

	return (
		// `h-full` so the scroll host below has a definite height to fill: a
		// flex-1 child of an auto-height parent is sized by its content, and a
		// long call stack would then spill past the pane into the one below.
		<div className="flex h-full min-h-0 flex-col">
			<div className="border-border flex items-center border-b px-1">
				{tabButton("stack", "Call stack", frames.length)}
				{tabButton("breakpoints", "Breakpoints", breakpoints.length)}
				{tabButton("threads", "Threads")}
				{tabButton("trace", "Trace", trace.length)}
			</div>
			<div className="scroll-host min-h-0 flex-1 overflow-auto">
				{tab === "stack" &&
					frames.map((f, i) => (
						<button
							key={`${f.addr}-${i}`}
							className="hover:bg-accent flex w-full items-center gap-2 px-2 py-0.5 text-left font-mono text-xs"
							onClick={() => gotoFrame(f.addr)}
							title="Go to function"
						>
							<span className="text-muted-foreground w-4">
								{i}
							</span>
							<span className="text-primary">
								{fmtAddr(f.addr)}
							</span>
							<span className="truncate">{f.name ?? "?"}</span>
						</button>
					))}
				{tab === "breakpoints" &&
					breakpoints.map((b) => (
						<div
							key={b.id}
							className="group hover:bg-accent flex items-center gap-2 px-2 py-0.5 font-mono text-xs"
						>
							<span className="text-destructive">●</span>
							<span className="text-primary">
								{fmtAddr(b.addr)}
							</span>
							<span className="text-muted-foreground">
								#{b.id}
							</span>
							<button
								className="text-muted-foreground hover:text-foreground text-2xs ml-auto hidden group-hover:block"
								onClick={() =>
									void run("unbreak", { id: b.id })
								}
							>
								Remove
							</button>
						</div>
					))}
				{tab === "threads" &&
					threadIds.map((t) => (
						<div key={t} className="px-2 py-0.5 font-mono text-xs">
							{t === pid ? "▶ " : "  "}
							{fmtAddr(t)}
						</div>
					))}
				{tab === "trace" && (
					<>
						<div className="border-border text-muted-foreground flex items-center justify-between border-b px-2 py-1 text-[10px]">
							<span>
								Every launch/attach/continue/step stop, in
								order.
							</span>
							<button
								className="hover:text-foreground"
								onClick={() => void api.debugTraceClear()}
							>
								Clear
							</button>
						</div>
						{trace.length === 0 && (
							<Empty label="no stops recorded yet" />
						)}
						{trace.map((t, i) => (
							<div
								key={i}
								className="hover:bg-accent flex items-center gap-2 px-2 py-0.5 font-mono text-[11px]"
							>
								<span className="text-muted-foreground w-6">
									{i}
								</span>
								<span className="text-primary">
									{fmtAddr(t.registers.pc)}
								</span>
								<span className="truncate">
									{reasonLabel(t.reason)}
								</span>
							</div>
						))}
					</>
				)}
			</div>
		</div>
	);
}

/**
 * Debug workspace: a CPU/disassembly view with a breakpoint
 * gutter and current-instruction highlight, a registers + stack column, and
 * call-stack / breakpoint / thread tabs. All state is shared with the agent.
 */
export function DebugPanel() {
	const pid = useDebugStore((s) => s.pid);
	const state = useDebugStore((s) => s.state);
	// Run/Step/Break need a live debuggee; a session can outlive its process.
	const live = isLiveState(state);
	const stop = useDebugStore((s) => s.stop);
	const output = useDebugStore((s) => s.output);
	const busy = useDebugStore((s) => s.busy);
	const error = useDebugStore((s) => s.error);
	const follow = useDebugStore((s) => s.follow);
	const run = useDebugStore((s) => s.run);
	const sendStdin = useDebugStore((s) => s.sendStdin);
	const connect = useDebugStore((s) => s.connect);
	const disconnect = useDebugStore((s) => s.disconnect);
	const setFollow = useDebugStore((s) => s.setFollow);
	// The debuggee is the binary already open for analysis: the panel only
	// exists once one is loaded.
	const binaryPath = useBinaryStore((s) => s.binary?.path);
	const [attachPid, setAttachPid] = useState("");
	const [breakAt, setBreakAt] = useState("");
	const [stdin, setStdin] = useState("");
	const outputRef = useRef<HTMLDivElement>(null);
	const outputTailRef = useRef<HTMLPreElement>(null);
	/** Whether the analyst is at the bottom, and so wants new output followed. */
	const atTail = useRef(true);

	// One channel for the life of the view: the session pushes a view of itself
	// at every stop and the debuggee's output as it is printed, so there is no
	// interval here to tune and nothing to keep running while a `continue` is
	// blocked.
	useEffect(() => {
		void connect();
		return () => {
			void disconnect();
		};
	}, [connect, disconnect]);

	// Whether the analyst is reading back through the transcript. A pane that
	// always jumps to the newest line makes scrolling up to re-read something
	// impossible, which is the one thing a program that printed a lot makes you
	// want to do.
	const onOutputScroll = useCallback(() => {
		const el = outputRef.current;
		if (!el) return;
		atTail.current =
			el.scrollHeight - el.scrollTop - el.clientHeight < TAIL_SLOP;
	}, []);

	// Follow the tail as the transcript grows. A ResizeObserver on the content
	// rather than an effect that reads `scrollHeight`: an observer is called
	// after layout has already been done, so the read is free, where reading it
	// during a commit forces the browser to lay the whole pane out again — once
	// per chunk printed, which is what made a chatty debuggee stutter.
	useEffect(() => {
		const scroller = outputRef.current;
		const tail = outputTailRef.current;
		if (!scroller || !tail) return;
		scroller.addEventListener("scroll", onOutputScroll, { passive: true });
		const observer = new ResizeObserver(() => {
			if (atTail.current) scroller.scrollTop = scroller.scrollHeight;
		});
		observer.observe(tail);
		return () => {
			scroller.removeEventListener("scroll", onOutputScroll);
			observer.disconnect();
		};
	}, [onOutputScroll]);

	/**
	 * Start the loaded binary under the debugger.
	 *
	 * The target is the one open for analysis, so asking for a path again would
	 * make the analyst pick the file they already have open — and could leave
	 * the debugger watching a process other than the one on screen.
	 *
	 * @example
	 * // With /bin/cat opened, Launch runs /bin/cat, not a fresh file picker.
	 * await onLaunch();
	 */
	const onLaunch = async () => {
		if (binaryPath) await run("launch", { path: binaryPath });
	};

	const onAttach = async () => {
		const n = Number.parseInt(attachPid.trim(), 10);
		if (Number.isFinite(n) && n > 0) await run("attach", { pid: n });
	};

	const onBreak = async () => {
		const spec = breakAt.trim();
		if (!spec) return;
		const isAddr = /^0x[0-9a-f]+$/i.test(spec) || /^\d+$/.test(spec);
		await run("break", isAddr ? { addr: spec } : { symbol: spec });
		setBreakAt("");
	};

	const onSendStdin = async () => {
		const text = stdin;
		setStdin("");
		await sendStdin(`${text}\n`);
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="border-border ui-bar flex-wrap border-b px-2">
				<Button
					variant="toolbar"
					size="sm"
					onClick={onLaunch}
					disabled={busy || !binaryPath}
					title="Launch the analyzed binary"
				>
					Launch
				</Button>
				<div className="ui-sep" />
				<div className="flex items-center gap-1">
					<Input
						value={attachPid}
						onChange={(e) => setAttachPid(e.target.value)}
						placeholder="pid"
						className="w-16"
					/>
					<Button
						variant="toolbar"
						size="sm"
						onClick={onAttach}
						disabled={busy || !attachPid.trim()}
					>
						Attach
					</Button>
				</div>
				<div className="ui-sep" />
				<Button
					variant="toolbar"
					size="sm"
					className={live && !busy ? "ui-selected" : undefined}
					onClick={() => void run("continue")}
					disabled={busy || !live}
					title="Run (continue)"
				>
					Run
				</Button>
				<Button
					variant="toolbar"
					size="sm"
					onClick={() => void run("interrupt")}
					disabled={!live}
					title="Pause the running target"
				>
					Pause
				</Button>
				<Button
					variant="toolbar"
					size="sm"
					onClick={() => void run("step", { kind: "into" })}
					disabled={busy || !live}
					title="Step into"
				>
					Into
				</Button>
				<Button
					variant="toolbar"
					size="sm"
					onClick={() => void run("step", { kind: "over" })}
					disabled={busy || !live}
					title="Step over"
				>
					Over
				</Button>
				<Button
					variant="toolbar"
					size="sm"
					onClick={() => void run("step", { kind: "out" })}
					disabled={busy || !live}
					title="Step out"
				>
					Out
				</Button>
				<div className="ui-sep" />
				<Input
					value={breakAt}
					onChange={(e) => setBreakAt(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") void onBreak();
					}}
					placeholder="break at addr or symbol"
					className="w-44"
				/>
				<Button
					variant="toolbar"
					size="sm"
					onClick={onBreak}
					disabled={busy || !live || !breakAt.trim()}
				>
					Break
				</Button>
				<div className="ui-sep" />
				<Button
					variant="toolbar"
					size="sm"
					onClick={() => void run("detach")}
					disabled={busy || !live}
				>
					Detach
				</Button>
				<Button
					variant="toolbar"
					size="sm"
					className="text-destructive hover:bg-destructive/10 hover:text-destructive"
					onClick={() => void run("kill")}
					disabled={busy || !live}
				>
					Kill
				</Button>
				<Button
					variant="toolbar"
					size="sm"
					className="ui-press"
					aria-pressed={follow}
					onClick={() => setFollow(!follow)}
					title="Follow the debug session live — including when the agent drives it"
				>
					Follow
				</Button>
				{busy && (
					<Loader2 className="text-muted-foreground h-3.5 w-3.5 animate-spin" />
				)}
			</div>

			<div className="text-muted-foreground flex items-center gap-3 border-b px-3 py-1 text-xs">
				<span>
					pid{" "}
					<span className="text-foreground font-mono">
						{pid ?? "—"}
					</span>
				</span>
				<span>
					state{" "}
					<span className="text-foreground font-mono">{state}</span>
				</span>
				<span>
					stop{" "}
					<span className="text-foreground font-mono">
						{reasonLabel(stop?.reason)}
					</span>
				</span>
			</div>

			{error && (
				<div className="border-destructive bg-destructive/10 text-destructive border-b px-3 py-1.5 text-xs">
					{error}
				</div>
			)}

			<div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_330px] grid-rows-[minmax(0,1fr)]">
				<div className="flex min-h-0 flex-col border-r">
					<DebugCpu />
					<div className="border-border h-44 shrink-0 overflow-hidden border-t">
						<BottomTabs />
					</div>
				</div>
				<div className="flex min-h-0 flex-col">
					<div className="border-border border-b">
						<RegistersPane />
					</div>
					<LowerPane />
				</div>
			</div>

			<div className="border-border border-t">
				<div className="text-muted-foreground px-3 py-1 text-xs font-semibold tracking-wider uppercase">
					Program output
				</div>
				<div
					ref={outputRef}
					className="scroll-host h-24 overflow-auto"
					data-testid="debug-output"
				>
					<pre
						ref={outputTailRef}
						className="text-2xs p-2 font-mono whitespace-pre-wrap"
					>
						{/* Chunks, so the analyst's own input reads differently from what
					    the debuggee printed. Index keys: the transcript only appends
					    and trims from the front, and the children are plain text. */}
						{output.map((chunk, i) => (
							<span
								key={i}
								className={
									chunk.echo ? "text-brand" : undefined
								}
							>
								{chunk.text}
							</span>
						))}
					</pre>
				</div>

				<div className="flex items-center gap-1.5 border-t px-2 py-1.5">
					<Input
						value={stdin}
						onChange={(e) => setStdin(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") void onSendStdin();
						}}
						placeholder="type input for the target — Enter sends"
						className="h-7 flex-1 text-xs"
						disabled={!live}
					/>
					<Button
						variant="toolbar"
						size="sm"
						onClick={onSendStdin}
						disabled={!live || !stdin.trim()}
					>
						Send
					</Button>
				</div>
			</div>
		</div>
	);
}
