import { create } from "zustand";

import { Channel } from "@tauri-apps/api/core";
import { api } from "../api";
import { pltSlot, shortName } from "../lib/debugCalls";
import { moduleAt, nearestSymbol } from "../lib/debugModules";
import { printableAt, STRING_WINDOW } from "../lib/debugModules";
import { appendOutput, type OutputChunk } from "../lib/debugOutput";
import { createFrameBatch } from "../lib/frameBatch";
import {
	countForward,
	DISASM_MIN_FORWARD,
	DISASM_WINDOW,
	mergeDisasm,
	type DisasmCache,
} from "../lib/debugDisasm";
import type {
	DebugBreakpoint,
	DebugEvent,
	DebugFrame,
	DebugInsn,
	DebugModule,
	DebugMemory,
	DebugModuleSymbol,
	DebugRegisters,
	DebugSnapshot,
	DebugStatus,
	DebugStop,
	DebugTraceEntry,
	Import,
} from "../types";

/** Ops whose result is a fresh stop (registers + reason). */
const STOP_OPS = new Set(["launch", "attach", "continue", "step"]);

/** Ops that start a new debuggee, so the previous one's view state is stale. */
const SESSION_OPS = new Set(["launch", "attach"]);

/** Stop reasons that mean the debuggee is gone for good. */
const TERMINAL_REASONS = new Set(["exited", "killed"]);

/** Stops kept in the timeline, oldest first, matching the host's own bound. */
const MAX_TRACE = 500;

/**
 * Whether a process state still has a live debuggee behind it, i.e. whether
 * Run/Step/Break can do anything.
 *
 * A process that exited or was detached is not an error state — it is a
 * finished session — so this is what gates the stepper, separately from
 * `active`, which only asks whether there is a session left to look at.
 *
 * @param state - A `ProcessState` as the backend reports it.
 * @returns True for `stopped` and `running`.
 */
export function isLiveState(state: string): boolean {
	return state === "stopped" || state === "running";
}

/**
 * Whether the register and CPU panes are a photograph of the last stop rather
 * than a live reading.
 *
 * A running debuggee has no readable registers and no readable pc: the ptrace
 * stop that made them readable is long gone, and nothing is published again
 * until the next stop. So while the target runs those panes show where it
 * *was* — and the output pane, which is live, will have moved on. A pane that
 * does not say which it is showing reads as a desync rather than as a stale
 * view, and the analyst ends up looking for a `read` in an instruction that was
 * never going to be one.
 *
 * ```
 * isLastStopView("stopped")  // => false
 * isLastStopView("running")  // => true
 * isLastStopView("exited")   // => false — nothing is claimed at all
 * ```
 *
 * @param state - The session's lifecycle state.
 * @returns True while the target is running on past the last stop.
 */
export function isLastStopView(state: string): boolean {
	return state === "running";
}

/**
 * Whether a stop ended the debuggee.
 *
 * @param stop - The stop the backend returned, if any.
 * @returns True when the process exited or was killed by a signal.
 */
export function isTerminalStop(stop: DebugStop | null | undefined): boolean {
	return !!stop && TERMINAL_REASONS.has(stop.reason?.reason ?? "");
}

interface DebugState {
	/**
	 * Whether there is a debug session to look at — not whether the debuggee is
	 * alive. Stays true after the process exits so the disassembly, breakpoints
	 * and output of a finished run remain on screen instead of being torn down.
	 */
	active: boolean;
	pid: number | null;
	/** `ProcessState` from the backend: `idle`, `stopped`, `running`, `exited`. */
	state: string;
	stop: DebugStop | null;
	/** Registers of the live debuggee; null once it has exited. */
	registers: DebugRegisters | null;
	/**
	 * The last program counter seen while the debuggee was alive. The CPU view
	 * anchors on this once the process is gone, so the disassembly of the final
	 * state stays on screen with every row marked as passed.
	 */
	lastPc: number | null;
	breakpoints: DebugBreakpoint[];
	frames: DebugFrame[];
	/**
	 * The program-output transcript, as chunks so echoed input can be told apart
	 * from what the debuggee printed. Per-process: a new debuggee starts with an
	 * empty transcript.
	 */
	output: OutputChunk[];
	/** ASLR/PIE load bias: runtime − static. */
	bias: number;
	busy: boolean;
	/** A session-wide op failure, shown once at the top of the debugger. */
	error: string | null;
	/** A disassembly fetch failure, shown in the CPU view only. */
	disasmError: string | null;
	/**
	 * Bumped whenever the debuggee is replaced or the session ends.
	 *
	 * Captured around the `output` poll so bytes that were already in flight
	 * when the process changed cannot be appended to the new process's pane.
	 */
	sessionGen: number;
	/** Follow the session live, even when the agent is driving it. */
	follow: boolean;
	/**
	 * Instructions decoded from the debuggee's memory this session, by address.
	 *
	 * The CPU view renders out of this rather than out of a single fetch, so
	 * moving the program counter appends to what is on screen instead of
	 * replacing it. Only addresses with no contiguous coverage are fetched.
	 */
	disasm: DisasmCache;
	/** Anchors with a `disasm` fetch already in flight, so steps cannot pile up. */
	disasmPending: ReadonlySet<number>;
	/**
	 * How many stops the session has reached, as last published.
	 *
	 * A view is pushed for all sorts of reasons and several of them leave the
	 * registers alone, so this — not the registers — is what says the program
	 * moved.
	 */
	stopSeq: number;
	/**
	 * Registers that moved at the last stop, by the name the register pane shows.
	 *
	 * The point of a register pane is to be scanned, not read: twenty hex values
	 * hide the one or two the instruction actually changed. A debugger that marks
	 * them is telling you where to look, and the mark is honest only if it is
	 * cleared by the *next* stop rather than by the next repaint of the same one.
	 */
	changedRegisters: ReadonlySet<string>;
	/** Every stop this session made, oldest first, as they are made. */
	trace: DebugTraceEntry[];
	/**
	 * GOT slot (static address) to the import it forwards to.
	 *
	 * Keyed by static address so it lines up with the analysis engine's, which
	 * does not know about the load bias.
	 */
	callNames: Map<number, string>;
	/** Whether this session's call targets have been resolved yet. */
	callNamesDone: boolean;
	/** Whether a resolution is in flight, so a re-render does not start another. */
	callNamesPending: boolean;
	/**
	 * The files mapped into the debuggee, with the ranges they occupy.
	 *
	 * What a call target is attributed to when it is not in the debuggee's own
	 * binary — a dynamically linked program spends most of its calls inside
	 * libc, and `libc` is more use than the raw address.
	 */
	modules: DebugModule[];
	/**
	 * What a `[rip + x]` operand points at, keyed by the operand's address.
	 *
	 * The comment the disassembly shows for such a reference: an import's GOT
	 * slot, a named global, or the text of a string that is really there.
	 */
	dataNames: Map<number, string>;
	/** Whether a resolution is in flight, so a re-render does not start another. */
	dataNamesPending: boolean;
	/**
	 * Library addresses already resolved to a name, keyed by runtime address.
	 *
	 * Only the addresses a call in the visible window actually reached, so this
	 * stays small however many symbols a library has.
	 */
	moduleNames: Map<number, string>;
	/**
	 * Which session the pushed events on screen belong to.
	 *
	 * A forwarder can have an event in flight when a relaunch replaces the
	 * session under it, and the transcript is per process: this is what stops
	 * the previous run's output arriving under the next one.
	 */
	eventGen: number;
	/**
	 * Whether a channel is registered, so a remount does not stack two up.
	 *
	 * Part of the state rather than a module flag because the session it belongs
	 * to is: a relaunch has to be able to register a fresh one.
	 */
	connected: boolean;

	/** Run one debugger op and fold its result into the store. */
	run: (op: string, args?: Record<string, unknown>) => Promise<unknown>;
	/**
	 * Make sure the cache covers `pc`, fetching a window only when it does not
	 * already, and merge the result in.
	 */
	ensureDisasm: (pc: number) => Promise<void>;
	ensureCallNames: (imports: Import[]) => Promise<void>;
	ensureModuleNames: (addrs: number[]) => Promise<void>;
	ensureDataNames: (targets: number[]) => Promise<void>;
	/** Send text to the debuggee's stdin. */
	sendStdin: (text: string) => Promise<void>;
	/**
	 * Listen to the session instead of polling it.
	 *
	 * Registers one channel for the life of the view. The session pushes a view
	 * of itself at every stop and the debuggee's output as it is printed, so
	 * nothing here has an interval: there is no "how late can this be" to
	 * choose, and a long `continue` costs nothing while it runs.
	 */
	connect: () => Promise<void>;
	/** Stop listening. */
	disconnect: () => Promise<void>;
	/** Pull the session's view once, for a view that has just opened. */
	refreshSnapshot: () => Promise<void>;
	setFollow: (b: boolean) => void;
	launch: (path: string) => Promise<void>;
	/**
	 * Continue until `addr` is reached, then remove the breakpoint that got it
	 * there unless the analyst had already set one there.
	 */
	runTo: (addr: number) => Promise<void>;
	attach: (pid: number) => Promise<void>;
	detach: () => Promise<void>;
	kill: () => Promise<void>;
	reset: () => void;
}

const initial = {
	active: false,
	pid: null as number | null,
	state: "idle",
	stop: null as DebugStop | null,
	registers: null as DebugRegisters | null,
	lastPc: null as number | null,
	breakpoints: [] as DebugBreakpoint[],
	frames: [] as DebugFrame[],
	output: [] as OutputChunk[],
	bias: 0,
	busy: false,
	error: null as string | null,
	disasmError: null as string | null,
	sessionGen: 0,
	follow: false,
	disasm: new Map() as DisasmCache,
	disasmPending: new Set<number>(),
	stopSeq: 0,
	changedRegisters: new Set<string>(),
	trace: [] as DebugTraceEntry[],
	callNames: new Map<number, string>(),
	callNamesDone: false,
	callNamesPending: false,
	dataNames: new Map<number, string>(),
	dataNamesPending: false,
	modules: [] as DebugModule[],
	moduleNames: new Map<number, string>(),
	eventGen: 0,
	connected: false,
};

/**
 * The message of a rejected op, as plain text for display.
 *
 * Tauri rejects with a string, but a JS caller can reject with an `Error`, and
 * `String(err)` on one yields a redundant `Error: ` prefix that would be shown
 * to the user verbatim.
 *
 * @param e - Whatever the rejected promise carried.
 * @returns The bare message.
 */
function errText(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** Re-fetch the breakpoint list. */
async function refreshBreakpoints(): Promise<void> {
	try {
		const bps = (await api.debugCommand(
			"breakpoints",
		)) as DebugBreakpoint[];
		useDebugStore.setState({ breakpoints: bps ?? [] });
	} catch {
		/* leave the previous list */
	}
}

/** Re-fetch the backtrace. */
async function refreshFrames(): Promise<void> {
	try {
		const frames = (await api.debugCommand("backtrace")) as DebugFrame[];
		useDebugStore.setState({ frames: frames ?? [] });
	} catch {
		useDebugStore.setState({ frames: [] });
	}
}

/**
 * The registers whose values differ between two stops, by the name the register
 * pane shows them under.
 *
 * The pane prints `pc`, `sp` and `fp` as `rip`, `rsp` and `rbp` and then
 * everything else under its own name, so the diff is keyed the same way: a
 * consumer asks "did `rbp` change?" and gets an answer without knowing that the
 * snapshot calls it `fp`.
 *
 * A register that appears on one side only counts as changed, which is what a
 * register does the first time a target reports it.
 *
 * ```
 * const a = { pc: 0x401000, sp: 0x7ffd00, fp: 0, values: { rax: 1, rbx: 2 } };
 * const b = { pc: 0x401005, sp: 0x7ffd00, fp: 0, values: { rax: 1, rbx: 3 } };
 * [...changedRegisters(a, b)].sort()   // => ["rax", "rbx", "rip"]
 * changedRegisters(a, a).size          // => 0
 * ```
 *
 * @param before - The registers at the previous stop.
 * @param after - The registers now.
 * @returns The names that moved, and nothing else.
 */
export function changedRegisters(
	before: DebugRegisters | null,
	after: DebugRegisters | null,
): ReadonlySet<string> {
	const changed = new Set<string>();
	if (before === null || after === null) return changed;
	if (before.pc !== after.pc) changed.add("rip");
	if (before.sp !== after.sp) changed.add("rsp");
	if (before.fp !== after.fp) changed.add("rbp");
	// A target that reports no general-purpose registers is still worth marking
	// the three specials on, so the map is treated as optional rather than as a
	// reason to mark nothing at all.
	const beforeValues = before.values ?? {};
	const afterValues = after.values ?? {};
	for (const name of new Set([
		...Object.keys(beforeValues),
		...Object.keys(afterValues),
	])) {
		if (beforeValues[name] !== afterValues[name]) changed.add(name);
	}
	return changed;
}

/**
 * Fold a register set in.
 *
 * A null register set means there is no live debuggee. `lastPc` is deliberately
 * left alone so the CPU view keeps an anchor on the final state, and the live
 * `registers` are cleared so nothing reads a pc out of a process that is gone.
 */
function applyRegisters(regs: DebugRegisters | null): void {
	if (regs?.pc == null) {
		useDebugStore.setState({ registers: null });
		return;
	}
	useDebugStore.setState({ registers: regs, lastPc: regs.pc });
}

/**
 * Fold a published view of the session into the store.
 *
 * A view arrives for every change the session publishes, not only for stops, so
 * what a stop is has to be counted rather than inferred: the register diff is
 * recomputed when `stop_seq` moves and left alone when it does not, which is
 * what stops a repeated view of one stop from clearing a mark that is still
 * true.
 *
 * @param snapshot - The session's view of itself.
 */
function applySnapshot(snapshot: DebugSnapshot): void {
	const isNewStop =
		(snapshot.stop_seq ?? 0) > useDebugStore.getState().stopSeq;
	const before = useDebugStore.getState().registers;
	// A snapshot means a session exists, whether or not its process is still
	// alive: keying `active` off the pid used to make the whole debugger vanish
	// the moment a process exited.
	useDebugStore.setState({
		active: true,
		pid: snapshot.pid ?? null,
		state: snapshot.state,
		stop: snapshot.stop ?? null,
		breakpoints: snapshot.breakpoints ?? [],
		frames: snapshot.frames ?? [],
		bias: snapshot.bias ?? 0,
		stopSeq: snapshot.stop_seq ?? 0,
	});
	applyRegisters(
		isLiveState(snapshot.state) ? (snapshot.stop?.registers ?? null) : null,
	);
	if (!isNewStop) return;
	const after = useDebugStore.getState().registers;
	useDebugStore.setState({
		changedRegisters: changedRegisters(before, after),
	});
}

/**
 * One chunk of the debuggee's stdout, held until its frame.
 *
 * The generation is carried with the text rather than read at commit time: a
 * debuggee that has been replaced by the time the frame lands must not have the
 * old process's last words appended under the new one's.
 */
interface PendingOutput {
	/** The session generation the text belongs to. */
	gen: number;
	/** The text, verbatim. */
	text: string;
	/** True for the analyst's own input, false for what the program printed. */
	echo?: boolean;
}

/**
 * Commit queued stdout to the transcript.
 *
 * @param items - The chunks, oldest first.
 */
function commitOutput(items: PendingOutput[]): void {
	if (items.length === 0) return;
	const gen = useDebugStore.getState().eventGen;
	// A queued chunk from a replaced session is already out of date, exactly as
	// an event that arrives after the swap would be.
	const live = items.filter((i) => i.gen >= gen);
	if (live.length === 0) return;
	useDebugStore.setState((s) => {
		let output = s.output;
		for (const item of live) {
			output = appendOutput(output, item.text, { echo: item.echo });
		}
		return { output };
	});
}

/**
 * The debuggee's stdout, queued to land a frame at a time.
 *
 * A program that prints quickly produces events far faster than the screen
 * refreshes, and committing each one is a re-render of the whole debugger
 * panel plus a forced layout to keep the pane pinned to the bottom. A chatty
 * debuggee should read as a scroll of text, not a flicker.
 */
const outputBatch = createFrameBatch<PendingOutput>(commitOutput);

/**
 * Fold one pushed event into the store.
 *
 * @param event - What the session or the host said.
 */
function applyEvent(event: DebugEvent): void {
	// A push from a session that has been replaced is not this session's news.
	// The host stamps each new session and sends that stamp with the session's
	// own first view, from the same command that started it, so a straggler from
	// the previous one is already out of date by the time it can arrive.
	if (event.gen < useDebugStore.getState().eventGen) return;
	if (event.gen > useDebugStore.getState().eventGen) {
		useDebugStore.setState({ eventGen: event.gen });
	}
	switch (event.event) {
		case "snapshot":
			applySnapshot(event.snapshot);
			return;
		case "output":
			if (!event.text) return;
			outputBatch.push({ gen: event.gen, text: event.text });
			return;
		case "trace_appended":
			useDebugStore.setState((s) => ({
				trace: [...s.trace, event.entry].slice(-MAX_TRACE),
			}));
			return;
		case "trace_cleared":
			useDebugStore.setState({ trace: [] });
			return;
	}
}

/**
 * Read `len` bytes of the debuggee's memory, or null when it cannot be read.
 *
 * An annotation reads the process to find out what a pointer means, and an
 * unreadable range is an ordinary outcome — the mapping may be gone, or the
 * process may have exited — so it is a null rather than an error. The view it
 * decorates is unaffected either way.
 */
async function readBytes(addr: number): Promise<DebugMemory | null> {
	return (await api.debugCommand("read", {
		addr,
		len: STRING_WINDOW,
	})) as DebugMemory | null;
}

/**
 * Drop everything tied to one debuggee, keeping the session's op transcript.
 *
 * Used when a new process is launched or attached: its addresses, registers,
 * breakpoints and stdout mean nothing for the next one, so they must not leak
 * across. `output` in particular is per-process — the
 * backend hands each `Debugger` its own capture buffer, so the pane must show
 * one run's stdout, not a run's output with the next run's appended underneath
 * it.
 *
 * The finished run's own output stays readable while its exited session is on
 * screen; it is dropped here, at the boundary where a new process takes over.
 */
function clearProcessState(): void {
	// Anything still queued belongs to the debuggee that is being replaced, and
	// committing it now would open the new process's transcript with the old
	// process's last words.
	outputBatch.drop();
	useDebugStore.setState((s) => ({
		pid: null,
		stop: null,
		registers: null,
		lastPc: null,
		breakpoints: [],
		frames: [],
		bias: 0,
		error: null,
		disasmError: null,
		output: [],
		disasm: new Map(),
		disasmPending: new Set<number>(),
		trace: [],
		changedRegisters: new Set<string>(),
		stopSeq: 0,
		callNames: new Map<number, string>(),
		callNamesDone: false,
		callNamesPending: false,
		dataNames: new Map<number, string>(),
		dataNamesPending: false,
		modules: [],
		moduleNames: new Map<number, string>(),
		sessionGen: s.sessionGen + 1,
	}));
}

/**
 * Fold a stop result into the store and refresh derived state.
 *
 * A terminal stop (the process exited or was killed) is a finished session, not
 * a failure: the state becomes `exited`, the registers are dropped because the
 * backend zeroes them, and the disassembly, breakpoints, frames and history are
 * all left exactly as they were so the final state can still be read. Nothing is
 * refetched — `backtrace` and `disasm` would only fail against a dead process.
 */
async function applyStop(stop: DebugStop): Promise<void> {
	const ended = isTerminalStop(stop);
	useDebugStore.setState({
		active: true,
		pid: stop.pid || null,
		state: ended ? "exited" : "stopped",
		stop,
	});
	if (ended) {
		useDebugStore.setState({
			registers: null,
			disasmPending: new Set<number>(),
		});
		return;
	}
	applyRegisters(stop.registers);
	await refreshBreakpoints();
	await refreshFrames();
}

export const useDebugStore = create<DebugState>((set, get) => ({
	...initial,

	run: async (op, args) => {
		set({ busy: true, error: null });
		// Captured before the optimistic "running" below, which has to be undone
		// if the op fails or the status strip claims a process that never started.
		const stateBefore = get().state;
		if (op === "continue" || op === "step") set({ state: "running" });
		if (SESSION_OPS.has(op)) clearProcessState();
		try {
			const out = await api.debugCommand(op, args);
			if (STOP_OPS.has(op)) {
				await applyStop(out as DebugStop);
			} else if (op === "detach" || op === "kill") {
				// Detaching or killing ends the session on purpose: the same clean
				// exit path as a process that ran to completion. The follow
				// preference is the viewer's, not the process's, so it survives;
				// the process's stdout does not, being per-process.
				outputBatch.drop();
				set((s) => ({
					...initial,
					follow: s.follow,
					sessionGen: s.sessionGen + 1,
				}));
			} else if (op === "break" || op === "unbreak") {
				await refreshBreakpoints();
			} else if (op === "regs" || op === "setreg") {
				applyRegisters(out as DebugRegisters);
			} else if (op === "backtrace") {
				set({ frames: (out as DebugFrame[]) ?? [] });
			} else if (op === "status") {
				const st = out as DebugStatus;
				// `status` reports a reason, not a full stop, so the richer `stop`
				// from the last real stop is left in place for the status strip.
				set({
					active: true,
					pid: st.pid ?? null,
					state: st.state,
					breakpoints: st.breakpoints ?? [],
				});
				// It carries no registers, so a finished process drops the live
				// ones and keeps `lastPc` as the CPU view's anchor.
				if (!isLiveState(st.state)) applyRegisters(null);
			}
			return out;
		} catch (e) {
			const message = errText(e);
			set({ error: message, state: stateBefore });
			throw e;
		} finally {
			set({ busy: false });
		}
	},

	launch: async (path) => {
		await get().run("launch", { path });
	},

	/**
	 * Continue until `addr` is reached.
	 *
	 * Implemented as a temporary breakpoint: unless the analyst already had one
	 * at `addr`, it is added for this run and removed once the target stops
	 * again. Selecting "Run to here" therefore does not quietly leave a
	 * breakpoint behind. If the process stops somewhere else first — a signal or
	 * another breakpoint — the temporary one is still cleaned up.
	 *
	 * @param addr - The runtime address to run to.
	 *
	 * @example
	 * // Continue until the instruction at 0x401000 is next reached.
	 * await useDebugStore.getState().runTo(0x401000);
	 */
	runTo: async (addr) => {
		const existing = get().breakpoints.find((b) => b.addr === addr);
		if (!existing) await get().run("break", { addr });
		try {
			await get().run("continue");
		} finally {
			if (!existing) {
				const added = get().breakpoints.find((b) => b.addr === addr);
				if (added) {
					try {
						await get().run("unbreak", { id: added.id });
					} catch {
						// The target can exit while running to it, leaving no
						// session in which to remove the breakpoint.
					}
				}
			}
		}
	},

	ensureDisasm: async (pc) => {
		// A fetch for this anchor is already running; a second would only race it.
		if (get().disasmPending.has(pc)) return;
		// Already decoded around here: render from the cache and skip the
		// round trip, which is what keeps stepping from blanking the view.
		if (countForward(get().disasm, pc) >= DISASM_MIN_FORWARD) return;
		set({ disasmPending: new Set(get().disasmPending).add(pc) });
		try {
			const fresh = (await api.debugCommand("disasm", {
				addr: pc,
				count: DISASM_WINDOW,
			})) as DebugInsn[] | null;
			set({
				disasm: mergeDisasm(get().disasm, fresh ?? []),
				disasmError: null,
			});
		} catch (e) {
			// Its own field, not the session-wide `error`: a failed disassembly
			// fetch must not blank the debugger, and must not double up with a
			// genuine session failure shown at the top of the panel.
			set({ disasmError: errText(e) });
		} finally {
			const pending = new Set(get().disasmPending);
			pending.delete(pc);
			set({ disasmPending: pending });
		}
	},

	/**
	 * Resolve which import each GOT slot forwards to, once per session.
	 *
	 * A PIE reaches libc through `call qword ptr [rip + x]`, where `x` names a
	 * slot in the GOT and the instruction itself says nothing about which
	 * function that is. The PLT stub does: it is a `jmp qword ptr [rip + y]`
	 * whose `y` is the slot for its own import, so reading six bytes per stub
	 * gives the slot-to-name table the disassembly needs to say `; scanf`.
	 *
	 * Reading the GOT slot itself would not do: the dynamic linker patches it to
	 * the resolved libc address the first time the import is called, and there
	 * are no symbols for that.
	 */
	ensureCallNames: async (imports) => {
		// Once per session. Re-resolving on every re-render would be a read per
		// stub per keystroke elsewhere in the window, and a session that has no
		// live process would only produce failures.
		if (get().callNamesDone || get().callNamesPending) return;
		const stubs = imports.filter(
			(imp): imp is Import & { plt: number; name: string } =>
				typeof imp.plt === "number" && typeof imp.name === "string",
		);
		if (stubs.length === 0) {
			set({ callNamesDone: true });
			return;
		}
		set({ callNamesPending: true });
		// The stubs are static addresses; the debuggee's are the same plus bias.
		const bias = get().bias;
		try {
			const resolved = await Promise.all(
				stubs.map(async (imp) => {
					try {
						const read = (await api.debugCommand("read", {
							addr: imp.plt + bias,
							len: 6,
						})) as { hex?: string } | null;
						const slot = read?.hex
							? pltSlot(imp.plt + bias, read.hex)
							: null;
						// Static, so it can be compared with a call's target without
						// knowing the bias again.
						return slot === null
							? null
							: ([slot - bias, imp.name] as const);
					} catch {
						// One unreadable stub costs that import its name and nothing
						// else: a name is an annotation, not the disassembly itself.
						return null;
					}
				}),
			);
			const names = new Map<number, string>();
			for (const entry of resolved) {
				if (entry) names.set(entry[0], shortName(entry[1]));
			}
			set({ callNames: names, callNamesDone: true });
		} finally {
			set({ callNamesPending: false });
		}
	},

	/**
	 * Name library addresses a call in the window reached, by reading the
	 * symbol table of the file they are mapped from.
	 *
	 * The debuggee's own calls are named from the analysis engine; this is for
	 * the ones it has no name for, which is mostly libc — a different file with
	 * a different symbol table, so a call into it needs that file read. Once per
	 * file, and only for a file the visible window actually calls into.
	 *
	 * The module list comes from the kernel, so a heap or stack address is
	 * attributed to nothing rather than to whichever file happens to sit below
	 * it in the map.
	 */
	ensureModuleNames: async (addrs) => {
		const unresolved = addrs.filter((a) => !get().moduleNames.has(a));
		if (unresolved.length === 0) return;
		// The map comes first: whether an address belongs to a file at all is the
		// kernel's answer, and there is nowhere else to learn it.
		let modules = get().modules;
		if (modules.length === 0) {
			const pid = get().pid;
			if (pid == null) return;
			try {
				modules = await api.debugModules(pid);
			} catch {
				// No map, no names. The disassembly is unaffected.
				return;
			}
			set({ modules });
		}
		// An address in no file — a heap, a stack — is named by nothing.
		const wanted = unresolved.filter((a) => moduleAt(modules, a) !== null);
		if (wanted.length === 0) return;
		// One read per distinct module, not per address: a window full of calls
		// into libc reads libc once.
		const byPath = new Map<string, DebugModule>();
		for (const addr of wanted) {
			const mod = moduleAt(modules, addr);
			if (mod) byPath.set(mod.path, mod);
		}
		const resolved = new Map(get().moduleNames);
		await Promise.all(
			[...byPath.values()].map(async (mod) => {
				let symbols: DebugModuleSymbol[];
				try {
					symbols = await api.debugModuleSymbols(mod.path);
				} catch {
					return;
				}
				for (const addr of wanted) {
					if (resolved.has(addr)) continue;
					if (moduleAt(modules, addr)?.path !== mod.path) continue;
					const hit = nearestSymbol(symbols, addr - mod.base);
					if (hit === null) continue;
					// A name is only worth showing when it is the whole story: a
					// call into the middle of a function is that function plus an
					// offset, and the offset is the part that is actually known.
					resolved.set(
						addr,
						hit.offset === 0
							? hit.name
							: `${hit.name}+0x${hit.offset.toString(16)}`,
					);
				}
			}),
		);
		if (resolved.size > get().moduleNames.size)
			set({ moduleNames: resolved });
	},

	/**
	 * Say what each `[rip + x]` operand in view points at.
	 *
	 * Three sources, in the order that can be trusted: a GOT slot names the
	 * import it forwards to; a slot with no import may be text, which is read
	 * out of the debuggee and shown if it is really text; anything else is left
	 * alone rather than guessed at. A displacement on its own is meaningless —
	 * it is an offset from the end of the instruction — so an unresolvable
	 * operand is a number, and a number the analyst has to add up by hand.
	 */
	ensureDataNames: async (targets) => {
		const wanted = targets.filter((t) => !get().dataNames.has(t));
		if (wanted.length === 0 || get().dataNamesPending) return;
		set({ dataNamesPending: true });
		try {
			const bias = get().bias;
			const slots = get().callNames;
			const resolved = new Map(get().dataNames);
			for (const addr of wanted) {
				const imported = slots.get(addr - bias);
				if (imported !== undefined) {
					resolved.set(addr, imported);
					continue;
				}
				// Only a slot the PLT table does not account for can be text, and
				// only text in the debuggee's own mapping can be read as such: a
				// library's address is somebody else's file to name.
				if (moduleAt(get().modules, addr) !== null) continue;
				const text = await printableAt(
					(where) => readBytes(where),
					addr,
				);
				if (text !== null) resolved.set(addr, `"${text}"`);
			}
			if (resolved.size > get().dataNames.size)
				set({ dataNames: resolved });
		} finally {
			set({ dataNamesPending: false });
		}
	},

	sendStdin: async (text) => {
		// Stamped for the same reason as `pollOutput`: a send that lands after the
		// process was replaced must not echo into the new one's transcript.
		const gen = get().sessionGen;
		// The stamp the queue's own filter compares against, read at the same
		// moment so the echo is filtered exactly like a pushed chunk would be.
		const stamp = get().eventGen;
		try {
			await api.debugCommand("stdin", { data: text });
			if (get().sessionGen !== gen) return;
			// The pty runs with ECHO off (the analyst types in the UI, not at the
			// terminal) and the Windows target does not capture stdio at all, so
			// nothing downstream reflects the input. Echo it here instead, which
			// is the one place that works on every backend: what was sent is
			// exactly what appears, tagged so the pane can style it apart from the
			// debuggee's own output.
			//
			// Queued with the program output rather than written straight through,
			// because the transcript is a conversation in one order: an echo that
			// jumped ahead of output the debuggee had already printed would put
			// the analyst's own line above the reply to it.
			outputBatch.push({ gen: stamp, text, echo: true });
		} catch (e) {
			set({ error: errText(e) });
		}
	},

	connect: async () => {
		if (get().connected) return;
		set({ connected: true });
		try {
			// One channel for the life of the view. It has to be a real
			// `Channel`: the host deserializes this argument as one, and a bare
			// callback is rejected — which would leave the view with no pushes at
			// all and no sign of why, so the failure is shown rather than eaten.
			const channel = new Channel<DebugEvent>();
			channel.onmessage = (event) => applyEvent(event);
			await api.debugSubscribe(channel);
			await get().refreshSnapshot();
		} catch (e) {
			set({
				connected: false,
				error: `debug event channel: ${errText(e)}`,
			});
		}
	},

	disconnect: async () => {
		// The channel is gone, so nothing more will be delivered on it; holding
		// queued text would only replay it into a pane nobody is watching.
		outputBatch.drop();
		set({ connected: false });
	},

	refreshSnapshot: async () => {
		try {
			const snapshot = await api.debugSnapshot();
			if (snapshot) applySnapshot(snapshot);
		} catch {
			/* no session yet */
		}
	},

	setFollow: (follow) => set({ follow }),

	attach: async (pid) => {
		await get().run("attach", { pid });
	},

	detach: async () => {
		await get().run("detach");
	},

	kill: async () => {
		await get().run("kill");
	},

	reset: () => {
		outputBatch.drop();
		set({ ...initial });
	},
}));
