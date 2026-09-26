import { useEffect, useMemo, useRef } from "react";

import { DisasmInstr } from "@/lib/disasm";
import { chrome } from "@/lib/chrome";
import { DISASM_AFTER, windowAround } from "@/lib/debugDisasm";
import { cn } from "@/lib/utils";
import { useDebugStore, isLiveState } from "@/store/debugStore";
import { useSettingsStore } from "@/store/settingsStore";

function fmtAddr(a?: number | null): string {
	return typeof a === "number" ? `0x${a.toString(16)}` : "";
}

/**
 * The CPU view: the instructions around the current program counter, decoded
 * from the debuggee's live memory.
 *
 * Addresses here are *runtime* addresses (the loader, a JIT page, or the main
 * binary), so the disassembly is what is actually mapped and needs no static
 * mapping. Each row has a breakpoint gutter (click to toggle) and a marker
 * column: `▶` on the instruction about to run, `·` on one the program counter
 * has already been observed at.
 *
 * The rows come out of the session's disassembly cache rather than a single
 * fetch anchored at the pc, so stepping never clears the view. Moving into the
 * next function leaves the instructions already on screen above the cursor, and
 * the `·`/tinted rows mark the run the program has already made.
 *
 * Only the last `debugHistory` already-executed instructions are shown, set
 * from Settings > Debugger; older ones stay in the cache, so raising it
 * scrolls them back into view without refetching.
 */
export function DebugCpu() {
	const livePc = useDebugStore((s) => s.registers?.pc ?? null);
	const lastPc = useDebugStore((s) => s.lastPc);
	const state = useDebugStore((s) => s.state);
	const disasm = useDebugStore((s) => s.disasm);
	const visited = useDebugStore((s) => s.visited);
	const pending = useDebugStore((s) => s.disasmPending);
	const breakpoints = useDebugStore((s) => s.breakpoints);
	const active = useDebugStore((s) => s.active);
	const error = useDebugStore((s) => s.disasmError);
	const run = useDebugStore((s) => s.run);
	const ensureDisasm = useDebugStore((s) => s.ensureDisasm);
	const history = useSettingsStore((s) => s.debugHistory);
	const pcRow = useRef<HTMLTableRowElement | null>(null);

	const live = isLiveState(state);
	// Once the process is gone there is no live pc, so the view stays anchored on
	// the last one and every row reads as already executed.
	const anchor = livePc ?? lastPc;

	useEffect(() => {
		// Never fetch against a process that has exited: the backend would only
		// answer "no debuggee is running", and the decoded window is already here.
		if (livePc == null || !live) return;
		void ensureDisasm(livePc);
	}, [livePc, live, ensureDisasm]);

	// Anchored at the pc, reaching back through the cache, and showing only the
	// last `history` already-executed rows above it.
	const ops = useMemo(
		() => windowAround(disasm, anchor, history, DISASM_AFTER),
		[disasm, anchor, history],
	);

	// Keep the cursor on screen as the window slides, without yanking the view
	// when it is already visible.
	useEffect(() => {
		pcRow.current?.scrollIntoView({ block: "nearest" });
	}, [anchor, ops.length]);

	// Breakpoints are runtime addresses, matching these rows directly.
	const bpAt = useMemo(() => {
		const m = new Map<number, number>();
		for (const b of breakpoints) m.set(b.addr, b.id);
		return m;
	}, [breakpoints]);

	const toggle = (addr: number) => {
		const id = bpAt.get(addr);
		if (id != null) void run("unbreak", { id });
		else void run("break", { addr });
	};

	if (!active) {
		return (
			<div className="text-muted-foreground flex h-full items-center justify-center text-xs">
				no debug session — Launch… or Attach
			</div>
		);
	}

	return (
		<div className="scroll-host min-h-0 flex-1 overflow-auto font-mono text-xs">
			{error && (
				<div className="text-destructive border-destructive/40 border-b px-2 py-1">
					{error}
				</div>
			)}
			<table className="w-full border-collapse">
				<tbody>
					{ops.map((op) => {
						const isPc = live && op.addr === anchor;
						const seen = visited.has(op.addr);
						const hasBp = bpAt.has(op.addr);
						return (
							<tr
								key={op.addr}
								ref={isPc ? pcRow : undefined}
								className={cn(
									"hover:bg-accent/40",
									// Instructions the program has already been at,
									// tinted and ruled so a run of them reads as one
									// block of history behind the cursor.
									seen && chrome.executed,
									isPc && chrome.selected,
								)}
							>
								<td
									className="w-4 cursor-pointer px-1 text-center select-none"
									onClick={() => toggle(op.addr)}
									title="Toggle breakpoint"
								>
									<span
										className={cn(
											"inline-block h-2 w-2 rounded-full",
											hasBp
												? "bg-red-500"
												: "bg-transparent hover:bg-red-500/40",
										)}
									/>
								</td>
								<td
									className={cn(
										"w-3 text-center select-none",
										isPc
											? "text-primary"
											: "text-muted-foreground",
									)}
									title={
										isPc
											? "about to execute"
											: seen
												? "already executed"
												: undefined
									}
								>
									{isPc ? "▶" : seen ? "·" : ""}
								</td>
								<td className="nums text-asm-addr min-w-[9ch] px-1 whitespace-nowrap">
									{fmtAddr(op.addr)}
								</td>
								<td className="text-asm-bytes min-w-[16ch] px-1 whitespace-nowrap">
									{op.bytes}
								</td>
								<td className="px-1 whitespace-nowrap">
									<DisasmInstr text={op.text} />
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
			{ops.length === 0 && (
				<div className="text-muted-foreground p-3 text-xs">
					{!live
						? "process has exited — no disassembly decoded"
						: livePc == null
							? "no program counter"
							: pending.has(livePc)
								? "disassembling…"
								: "no disassembly"}
				</div>
			)}
		</div>
	);
}
