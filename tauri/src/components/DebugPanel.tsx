import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { api, pickBinary } from "@/api";
import { DebugCpu } from "@/components/DebugCpu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useAnalysisStore } from "@/store/analysisStore";
import { isLiveState, useDebugStore } from "@/store/debugStore";
import type { DebugStopReason, DebugTraceEntry } from "@/types";

function fmtAddr(a?: number | null): string {
	return typeof a === "number" ? `0x${a.toString(16)}` : "";
}

/** x86-64 RFLAGS, as the set flag names. */
function flagsOf(eflags: number): string {
	const bits: [string, number][] = [
		["CF", 0],
		["PF", 2],
		["AF", 4],
		["ZF", 6],
		["SF", 7],
		["TF", 8],
		["IF", 9],
		["DF", 10],
		["OF", 11],
	];
	return bits
		.filter(([, bit]) => (eflags >> bit) & 1)
		.map(([name]) => name)
		.join(" ");
}

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

/** One editable register: click the value to write a new one. */
function RegisterRow({
	name,
	value,
	emphasis,
}: {
	name: string;
	value: number;
	emphasis?: boolean;
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
						"min-w-0 truncate hover:underline",
						emphasis && "text-primary",
					)}
					title="Click to edit"
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

/** Right column, top: general registers and flags. */
function RegistersPane() {
	const regs = useDebugStore((s) => s.registers);
	const skip = new Set(["rip", "eflags", "orig_rax", "pc", "sp"]);
	const gp = (regs ? Object.entries(regs.values) : []).filter(
		([k]) => !skip.has(k),
	);
	return (
		<div className="flex min-h-0 flex-col">
			<PaneHeader>Registers</PaneHeader>
			{!regs ? (
				<Empty label="no registers" />
			) : (
				<div className="scroll-host max-h-72 overflow-auto p-2 font-mono text-xs">
					<RegisterRow name="rip" value={regs.pc} emphasis />
					<RegisterRow name="rsp" value={regs.sp} />
					<RegisterRow name="rbp" value={regs.fp} />
					<div className="mt-1.5 grid grid-cols-2 gap-x-2 gap-y-0.5">
						{gp.map(([k, v]) => (
							<RegisterRow key={k} name={k} value={v} />
						))}
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
function StackPane() {
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
		<div className="flex min-h-0 flex-1 flex-col">
			<PaneHeader>Stack</PaneHeader>
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
		</div>
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
	const [trace, setTrace] = useState<DebugTraceEntry[]>([]);

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

	useEffect(() => {
		if (tab !== "trace") return;
		let cancelled = false;
		const poll = () => {
			api.debugTrace()
				.then((t) => {
					if (!cancelled) setTrace(t);
				})
				.catch(() => {});
		};
		poll();
		const id = setInterval(poll, 1000);
		return () => {
			cancelled = true;
			clearInterval(id);
		};
	}, [tab]);

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
		<div className="flex min-h-0 flex-col">
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
								onClick={() =>
									void api
										.debugTraceClear()
										.then(() => setTrace([]))
								}
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
	const active = useDebugStore((s) => s.active);
	const pid = useDebugStore((s) => s.pid);
	const state = useDebugStore((s) => s.state);
	// Run/Step/Break need a live debuggee; `active` only means a session exists.
	const live = isLiveState(state);
	const stop = useDebugStore((s) => s.stop);
	const output = useDebugStore((s) => s.output);
	const busy = useDebugStore((s) => s.busy);
	const error = useDebugStore((s) => s.error);
	const follow = useDebugStore((s) => s.follow);
	const run = useDebugStore((s) => s.run);
	const sendStdin = useDebugStore((s) => s.sendStdin);
	const pollOutput = useDebugStore((s) => s.pollOutput);
	const pollSnapshot = useDebugStore((s) => s.pollSnapshot);
	const setFollow = useDebugStore((s) => s.setFollow);
	const [attachPid, setAttachPid] = useState("");
	const [breakAt, setBreakAt] = useState("");
	const [stdin, setStdin] = useState("");
	const outputRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!active && !follow) return;
		const id = setInterval(() => void pollOutput(), 400);
		return () => clearInterval(id);
	}, [active, follow, pollOutput]);

	useEffect(() => {
		if (!follow) return;
		void pollSnapshot();
		const id = setInterval(() => void pollSnapshot(), 500);
		return () => clearInterval(id);
	}, [follow, pollSnapshot]);

	useEffect(() => {
		if (outputRef.current) {
			outputRef.current.scrollTop = outputRef.current.scrollHeight;
		}
	}, [output]);

	const onLaunch = async () => {
		const path = await pickBinary();
		if (path) await run("launch", { path });
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
					disabled={busy}
				>
					Launch
				</Button>
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

			<div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_330px]">
				<div className="flex min-h-0 flex-col border-r">
					<DebugCpu />
					<div className="border-border h-44 border-t">
						<BottomTabs />
					</div>
				</div>
				<div className="flex min-h-0 flex-col">
					<div className="border-border border-b">
						<RegistersPane />
					</div>
					<StackPane />
				</div>
			</div>

			<div className="border-border border-t">
				<div className="text-muted-foreground px-3 py-1 text-xs font-semibold tracking-wider uppercase">
					Program output
				</div>
				<div ref={outputRef} className="scroll-host h-24 overflow-auto">
					<pre className="text-2xs p-2 font-mono whitespace-pre-wrap">
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
