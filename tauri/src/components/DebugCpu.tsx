import { useEffect, useMemo, useRef } from "react";

import { DisasmComment, DisasmInstr, splitComment } from "@/lib/disasm";
import { chrome } from "@/lib/chrome";
import {
	branchVerdict,
	classifyInsn,
	peekTarget,
	verdictText,
	x86Flags,
} from "@/lib/branches";
import {
	DISASM_AFTER,
	DISASM_PEEK,
	windowAround,
	type DisasmPeek,
} from "@/lib/debugDisasm";
import { cn } from "@/lib/utils";
import { callTarget, ripTarget, shortName } from "@/lib/debugCalls";
import { VarNameChip } from "@/components/VarNameChip";
import { useDebugCpuMenu } from "@/components/DebugCpuMenu";
import { isLastStopView, isLiveState, useDebugStore } from "@/store/debugStore";
import { useAnalysisStore } from "@/store/analysisStore";
import type { DebugInsn } from "@/types";
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
 * mapping. It is a code window anchored on the cursor: the instructions leading
 * into it are dimmed as context, and the cursor row is the only one marked.
 *
 * The rows above the cursor are *not* a record of what ran, and deliberately do
 * not pretend to be. A debugger only observes the program between stops, so on a
 * loop the code sitting just above the cursor is the middle of a body the run
 * may have left several laps ago — reading it as history is what turns a
 * backward branch into an invisible one. What actually happened is on the
 * cursor's own instruction, and it is shown there: a conditional branch is
 * labelled `taken`/`not taken` with the flag condition that decides it, and when
 * it is going to be taken its target is spliced in underneath with `↳`, so
 * standing on a loop's back edge shows the whole iteration right there.
 *
 * `debugContext` (Settings > Debugger) sets how many instructions of context
 * stay above the cursor.
 *
 * A `; ...` suffix is split out and rendered by [`DisasmComment`], so the live
 * view colours comments exactly as the static views do.
 */
export function DebugCpu() {
	const livePc = useDebugStore((s) => s.registers?.pc ?? null);
	const lastPc = useDebugStore((s) => s.lastPc);
	const registers = useDebugStore((s) => s.registers);
	const state = useDebugStore((s) => s.state);
	const disasm = useDebugStore((s) => s.disasm);
	const pending = useDebugStore((s) => s.disasmPending);
	const breakpoints = useDebugStore((s) => s.breakpoints);
	const active = useDebugStore((s) => s.active);
	const error = useDebugStore((s) => s.disasmError);
	const run = useDebugStore((s) => s.run);
	const ensureDisasm = useDebugStore((s) => s.ensureDisasm);
	const context = useSettingsStore((s) => s.debugContext);
	const pcRow = useRef<HTMLTableRowElement | null>(null);
	const { openMenu, menu, target } = useDebugCpuMenu();

	const bias = useDebugStore((s) => s.bias);
	const callNames = useDebugStore((s) => s.callNames);
	const ensureCallNames = useDebugStore((s) => s.ensureCallNames);
	const moduleNames = useDebugStore((s) => s.moduleNames);
	const ensureModuleNames = useDebugStore((s) => s.ensureModuleNames);
	const dataNames = useDebugStore((s) => s.dataNames);
	const ensureDataNames = useDebugStore((s) => s.ensureDataNames);
	const imports = useAnalysisStore((s) => s.imports);
	const funcs = useAnalysisStore((s) => s.funcs);

	const live = isLiveState(state);
	const stale = isLastStopView(state);
	// Once the process is gone there is no live pc, so the view stays anchored on
	// the last one and there are no registers left to judge a branch by.
	const anchor = livePc ?? lastPc;

	useEffect(() => {
		// Never fetch against a process that has exited: the backend would only
		// answer "no debuggee is running", and the decoded window is already here.
		if (livePc == null || !live) return;
		void ensureDisasm(livePc);
	}, [livePc, live, ensureDisasm]);

	// The cursor's own instruction is what carries the branch verdict, and the
	// verdict is what decides whether there is a target to peek.
	const cursor = anchor == null ? null : (disasm.get(anchor) ?? null);
	const branch = useMemo(
		() => (cursor ? classifyInsn(cursor.text) : null),
		[cursor],
	);
	const verdict = useMemo(
		() =>
			branch
				? branchVerdict(
						branch,
						x86Flags(registers?.values.eflags),
						registers?.values.rcx ?? 0,
					)
				: null,
		[branch, registers],
	);
	const peek = useMemo<DisasmPeek | null>(() => {
		const at = peekTarget(branch, verdict);
		return at == null ? null : { addr: at, lines: DISASM_PEEK };
	}, [branch, verdict]);

	// Anchored at the cursor: context above it, the straight decode below, or the
	// branch target when the cursor is on a branch that is about to be taken.
	const rows = useMemo(
		() => windowAround(disasm, anchor, context, DISASM_AFTER, peek),
		[disasm, anchor, context, peek],
	);

	// Where the cursor sits in the list, which is a row identity rather than an
	// address: a peek splices in code the window may already show elsewhere.
	const cursorAt = useMemo(
		() => rows.findIndex((r) => r.role === "cursor"),
		[rows],
	);

	// Keep the cursor on screen as the window slides, without yanking the view
	// when it is already visible.
	useEffect(() => {
		pcRow.current?.scrollIntoView({ block: "nearest" });
	}, [anchor, rows.length, cursorAt]);

	// Name the function each call in the window is going to, so a PIE's
	// `call qword ptr [rip + 0x200836]` reads as what it is. A direct branch
	// names itself from the engine's functions; a jump through the GOT has to be
	// resolved through the PLT, which is what `ensureCallNames` reads, once per
	// session.
	const funcNames = useMemo(() => {
		const m = new Map<number, string>();
		for (const f of funcs) {
			if (typeof f.addr === "number")
				m.set(f.addr, f.name ?? f.realname ?? "");
		}
		return m;
	}, [funcs]);
	const needsSlots = useMemo(
		() => rows.some((row) => callTarget(row.insn)?.kind === "slot"),
		[rows],
	);
	useEffect(() => {
		if (!needsSlots || !live) return;
		void ensureCallNames(imports);
	}, [needsSlots, live, imports, ensureCallNames]);
	// A direct call the analysis engine has no name for is either inside the
	// debuggee's own binary — a function its discovery missed — or in a library,
	// which has its own symbol table either way. Both are answered by reading
	// the mapped file, once per file, and only for a file the visible window
	// actually calls into. A jump through the GOT never needs this: it resolves
	// through the PLT, which is inside the binary.
	const unnamedTargets = useMemo(() => {
		const out = new Set<number>();
		for (const row of rows) {
			const target = callTarget(row.insn);
			if (target?.kind !== "direct") continue;
			if (funcNames.has(target.addr - bias)) continue;
			out.add(target.addr);
		}
		return [...out];
	}, [rows, bias, funcNames]);
	useEffect(() => {
		if (unnamedTargets.length === 0 || !live) return;
		void ensureModuleNames(unnamedTargets);
	}, [unnamedTargets, live, ensureModuleNames]);
	// Every `[rip + x]` in the window is a reference the displacement alone does
	// not explain, so each one is resolved: a GOT slot names its import, and
	// anything else may be text, which is read out of the process to find out.
	const dataTargets = useMemo(() => {
		const out = new Set<number>();
		for (const row of rows) {
			const target = ripTarget(row.insn);
			if (target !== null) out.add(target);
		}
		return [...out];
	}, [rows]);
	useEffect(() => {
		if (dataTargets.length === 0 || !live) return;
		void ensureDataNames(dataTargets);
	}, [dataTargets, live, ensureDataNames]);
	// The function the cursor is in, by its static address, which is what the
	// names are keyed by — and the same key the static views use, so a rename in
	// either place is the same rename.
	const frameFunc =
		(livePc ?? lastPc) === null ? null : (livePc ?? lastPc)! - bias;

	/** What a `[rip + x]` operand points at, if it can be named. */
	const dataName = (insn: DebugInsn): string | null => {
		const target = ripTarget(insn);
		if (target === null) return null;
		return dataNames.get(target) ?? null;
	};

	/** The function a call in this row reaches, if it can be named. */
	const callName = (insn: DebugInsn): string | null => {
		const target = callTarget(insn);
		if (target === null) return null;
		if (target.kind === "direct") {
			const own = funcNames.get(target.addr - bias);
			if (own) return shortName(own);
			return moduleNames.get(target.addr) ?? null;
		}
		const name = callNames.get(target.addr - bias);
		return name ? shortName(name) : null;
	};

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
		<div
			data-menu-boundary
			className="scroll-host min-h-0 flex-1 overflow-auto font-mono text-xs"
		>
			{error && (
				<div className="text-destructive border-destructive/40 border-b px-2 py-1">
					{error}
				</div>
			)}
			<table className="w-full border-collapse">
				<tbody>
					{rows.map((row, i) => {
						// The `; ...` suffix is a comment, not assembly, so it is
						// split out and styled like every other view rather than
						// tokenized as operands.
						const { instr, comment } = splitComment(row.insn.text);
						const isPc = live && !stale && row.role === "cursor";
						// While the target runs, the marked row is where it *was*.
						// It keeps the marker and the address — they are the most
						// recent ones known — but dimmed and titled, because the
						// "about to execute" reading would be a lie: the program is
						// past it, quite possibly inside a syscall, and the live
						// output pane will say so before the registers ever do.
						const atLastStop =
							live && stale && row.role === "cursor";
						const hasBp = bpAt.has(row.addr);
						// The row the context menu is acting on. It is not
						// necessarily the pc row above: right-clicking another
						// instruction must visibly move the selection there, or
						// the menu reads as an action on whatever is blue.
						const menuTarget = target === row;
						return (
							<tr
								// Positional: a peek repeats addresses the window may
								// already show, so an address is not a key here.
								key={i}
								ref={isPc ? pcRow : undefined}
								onContextMenu={(event) => openMenu(event, row)}
								className={cn(
									"hover:bg-accent/40",
									row.role === "past" && chrome.past,
									row.role === "peek" && chrome.peek,
									isPc && chrome.selected,
									atLastStop && "opacity-60",
									menuTarget && !isPc && "bg-accent",
								)}
							>
								<td
									className={cn(
										"w-4 cursor-pointer px-1 text-center select-none",
										menuTarget &&
											"shadow-[inset_2px_0_0_var(--brand)]",
									)}
									onClick={() => toggle(row.addr)}
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
										row.role === "cursor"
											? "text-primary"
											: "text-muted-foreground",
									)}
									title={
										row.role === "peek"
											? "where this branch is about to land"
											: atLastStop
												? "last stop — the target is running past this"
												: row.role === "cursor"
													? "about to execute"
													: undefined
									}
								>
									{row.marker === "pc"
										? "▶"
										: row.marker === "peek"
											? "↳"
											: ""}
								</td>
								<td className="nums text-asm-addr min-w-[9ch] px-1 whitespace-nowrap">
									{fmtAddr(row.addr)}
								</td>
								<td className="text-asm-bytes min-w-[16ch] px-1 whitespace-nowrap">
									{row.insn.bytes}
								</td>
								<td className="px-1 whitespace-nowrap">
									<DisasmInstr text={instr} />
									<DisasmComment comment={comment} />
									<DisasmComment
										comment={
											callName(row.insn) ??
											dataName(row.insn) ??
											""
										}
									/>
									<VarNameChip
										func={frameFunc}
										insns={rows.map((r) => r.insn)}
										text={row.insn.text}
									/>
									{isPc && verdict && (
										<span
											className={cn(
												"pl-3",
												verdict.taken
													? chrome.taken
													: chrome.fall,
											)}
											title="Decided by the flags at this stop"
										>
											{verdictText(verdict)}
										</span>
									)}
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
			{rows.length === 0 && (
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
			{menu}
		</div>
	);
}
