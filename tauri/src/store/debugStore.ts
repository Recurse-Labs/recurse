import { create } from "zustand";

import { api } from "../api";
import { appendOutput, type OutputChunk } from "../lib/debugOutput";
import {
	countForward,
	DISASM_MIN_FORWARD,
	DISASM_WINDOW,
	markVisited,
	mergeDisasm,
	type DisasmCache,
} from "../lib/debugDisasm";
import type {
	DebugBreakpoint,
	DebugFrame,
	DebugInsn,
	DebugRegisters,
	DebugStatus,
	DebugStop,
} from "../types";

/** Ops whose result is a fresh stop (registers + reason). */
const STOP_OPS = new Set(["launch", "attach", "continue", "step"]);

/** Ops that start a new debuggee, so the previous one's view state is stale. */
const SESSION_OPS = new Set(["launch", "attach"]);

/** Stop reasons that mean the debuggee is gone for good. */
const TERMINAL_REASONS = new Set(["exited", "killed"]);

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
	log: string[];
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
	/** Addresses the program counter has already been observed at. */
	visited: ReadonlySet<number>;
	/** Anchors with a `disasm` fetch already in flight, so steps cannot pile up. */
	disasmPending: ReadonlySet<number>;

	/** Run one debugger op and fold its result into the store. */
	run: (op: string, args?: Record<string, unknown>) => Promise<unknown>;
	/**
	 * Make sure the cache covers `pc`, fetching a window only when it does not
	 * already, and merge the result in.
	 */
	ensureDisasm: (pc: number) => Promise<void>;
	/** Send text to the debuggee's stdin. */
	sendStdin: (text: string) => Promise<void>;
	/** Drain the debuggee's captured output into `output`. */
	pollOutput: () => Promise<void>;
	/** Pull the live snapshot (follow-along). */
	pollSnapshot: () => Promise<void>;
	setFollow: (b: boolean) => void;
	launch: (path: string) => Promise<void>;
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
	log: [] as string[],
	busy: false,
	error: null as string | null,
	disasmError: null as string | null,
	sessionGen: 0,
	follow: false,
	disasm: new Map() as DisasmCache,
	visited: new Set<number>(),
	disasmPending: new Set<number>(),
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

/** Append a line to the capped debug log. */
function appendLog(line: string): void {
	useDebugStore.setState((s) => ({ log: [...s.log, line].slice(-300) }));
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
 * Fold a register set in, remembering the pc as one the program has reached so
 * the CPU view can mark it as already executed.
 *
 * A null register set means there is no live debuggee. `lastPc` is deliberately
 * left alone so the CPU view keeps an anchor on the final state, and the live
 * `registers` are cleared so nothing reads a pc out of a process that is gone.
 */
function applyRegisters(regs: DebugRegisters | null): void {
	const pc = regs?.pc ?? null;
	if (pc == null) {
		useDebugStore.setState({ registers: null });
		return;
	}
	useDebugStore.setState({ registers: regs, lastPc: pc });
	if (useDebugStore.getState().visited.has(pc)) return;
	useDebugStore.setState({
		visited: markVisited(useDebugStore.getState().visited, pc),
	});
}

/**
 * Drop everything tied to one debuggee, keeping the session's op transcript.
 *
 * Used when a new process is launched or attached: its addresses, registers,
 * breakpoints and stdout mean nothing for the next one, so they must not leak
 * across. `output` in particular is per-process — the backend hands each
 * `Debugger` its own capture buffer, so the pane must show one run's stdout,
 * not a run's output with the next run's appended underneath it.
 *
 * The finished run's own output stays readable while its exited session is on
 * screen; it is dropped here, at the boundary where a new process takes over.
 */
function clearProcessState(): void {
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
		visited: new Set<number>(),
		disasmPending: new Set<number>(),
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
		appendLog(`> ${op}${args ? ` ${JSON.stringify(args)}` : ""}`);
		try {
			const out = await api.debugCommand(op, args);
			appendLog(JSON.stringify(out));
			if (STOP_OPS.has(op)) {
				await applyStop(out as DebugStop);
			} else if (op === "detach" || op === "kill") {
				// Detaching or killing ends the session on purpose: the same clean
				// exit path as a process that ran to completion. The op transcript
				// and the follow preference are the viewer's, not the process's, so
				// they survive; its stdout does not, being per-process.
				set((s) => ({
					...initial,
					log: s.log,
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
			appendLog(`! ${message}`);
			throw e;
		} finally {
			set({ busy: false });
		}
	},

	launch: async (path) => {
		await get().run("launch", { path });
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

	sendStdin: async (text) => {
		// Stamped for the same reason as `pollOutput`: a send that lands after the
		// process was replaced must not echo into the new one's transcript.
		const gen = get().sessionGen;
		try {
			await api.debugCommand("stdin", { data: text });
			if (get().sessionGen !== gen) return;
			// The pty runs with ECHO off (the analyst types in the UI, not at the
			// terminal) and the Windows target does not capture stdio at all, so
			// nothing downstream reflects the input. Echo it here instead, which
			// is the one place that works on every backend: what was sent is
			// exactly what appears, tagged so the pane can style it apart from the
			// debuggee's own output.
			set((s) => ({
				output: appendOutput(s.output, text, { echo: true }),
			}));
		} catch (e) {
			set({ error: errText(e) });
		}
	},

	pollOutput: async () => {
		// The poll reads whichever debugger the host currently holds, so a reply
		// that was already in flight when the process changed belongs to the old
		// run. Stamped before the await, it is dropped rather than appended to the
		// new process's pane.
		const gen = get().sessionGen;
		try {
			const out = (await api.debugCommand("output")) as {
				text?: string;
			};
			if (get().sessionGen !== gen) return;
			const text = (out?.text ?? "").replace(/\r/g, "");
			if (text) set((s) => ({ output: appendOutput(s.output, text) }));
		} catch {
			/* the worker may be busy; try again next tick */
		}
	},

	pollSnapshot: async () => {
		try {
			const s = await api.debugSnapshot();
			if (!s) return;
			// A snapshot means a session exists, whether or not its process is
			// still alive: keying `active` off the pid used to make the whole
			// debugger vanish the moment a process exited.
			set({
				active: true,
				pid: s.pid ?? null,
				state: s.state,
				stop: s.stop ?? null,
				breakpoints: s.breakpoints ?? [],
				frames: s.frames ?? [],
				bias: s.bias ?? 0,
			});
			applyRegisters(
				isLiveState(s.state) ? (s.stop?.registers ?? null) : null,
			);
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

	reset: () => set({ ...initial }),
}));
