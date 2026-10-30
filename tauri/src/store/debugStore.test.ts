import { beforeEach, describe, expect, it, vi } from "vitest";

// The store talks to the Tauri backend through ../api; mock it so these tests
// drive the cache/pc logic without a runtime.
vi.mock("../api", () => ({
	api: {
		debugCommand: vi.fn(),
		debugSnapshot: vi.fn(),
		debugSubscribe: vi.fn(),
		debugModules: vi.fn(),
		debugModuleSymbols: vi.fn(),
	},
}));

import {
	changedRegisters,
	isLastStopView,
	isLiveState,
	isTerminalStop,
	useDebugStore,
} from "./debugStore";
import { Channel } from "@tauri-apps/api/core";
import { deliverTauriCallback } from "../../vitest.setup";
import { api } from "../api";
import { DISASM_MIN_FORWARD, DISASM_WINDOW } from "../lib/debugDisasm";
import { outputText } from "../lib/debugOutput";
import type {
	DebugEvent,
	DebugEventBody,
	DebugInsn,
	DebugRegisters,
	DebugSnapshot,
	DebugStop,
	DebugTraceEntry,
} from "../types";

const mocked = vi.mocked(api);

/** Whatever the last `debugSubscribe` call was handed, so a test can push. */
let channel: Channel<DebugEvent> | null = null;

/**
 * Deliver a pushed event the way the host would: through the channel the view
 * registered, not by reaching into the store.
 *
 * Stamped with the generation of the session on screen, which is what the host
 * does. A test that wants to be a session running late says which one.
 */
function push(
	event: DebugEventBody,
	gen = useDebugStore.getState().eventGen,
): void {
	if (channel === null) return;
	deliverTauriCallback(channel.id, { ...event, gen });
}

/**
 * Wait out the frame the output pane commits on.
 *
 * The debuggee's stdout is queued and committed once a frame rather than one
 * event at a time, so a test that pushes output has to let the frame land
 * before the transcript reflects it. A real timer rather than a fake one, so
 * this exercises the same path the app does.
 */
function flushOutput(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 150));
}

/** A stop carrying just a pc, which is all the cache logic reads. */
function stopAt(pc: number): DebugStop {
	return {
		pid: 4242,
		registers: { pc } as DebugRegisters,
	} as DebugStop;
}

/**
 * The stop the backend returns when the process runs to completion: a terminal
 * reason, and the zeroed pid/registers the backend sends with it.
 */
function exitedStop(code: number, reason = "exited"): DebugStop {
	return {
		pid: 0,
		thread: 0,
		reason: { reason, code },
		registers: { pc: 0, sp: 0, fp: 0, values: {} } as DebugRegisters,
	} as DebugStop;
}

/**
 * The `start` fixture at the reported addresses: `ret` at 0x804809c ends
 * `_start`, and `_exit` runs 0x804809d..0x80480a3.
 */
const EXIT_BODY: DebugInsn[] = [
	{ addr: 0x804809c, bytes: "c3", text: "ret" },
	{ addr: 0x804809d, bytes: "5c", text: "pop esp" },
	{ addr: 0x804809e, bytes: "31c0", text: "xor eax, eax" },
	{ addr: 0x80480a0, bytes: "40", text: "inc eax" },
	{ addr: 0x80480a1, bytes: "cd80", text: "int 0x80" },
];

/** A full stop at `pc`, with nothing but the three specials set. */
function stopWith(pc: number): DebugStop {
	return {
		pid: 4242,
		thread: 1,
		reason: { reason: "breakpoint" },
		registers: { pc, sp: 0, fp: 0, values: {} } as DebugRegisters,
	} as DebugStop;
}

/** A stop timeline entry: a stop, with the registers it happened at. */
function entry(pc: number): DebugTraceEntry {
	return {
		pid: 4242,
		thread: 1,
		reason: { reason: "breakpoint" },
		registers: { pc } as DebugRegisters,
	} as DebugTraceEntry;
}

/** A window long enough that the pc is never near its forward edge. */
const LONG_WINDOW: DebugInsn[] = Array.from({ length: 64 }, (_, i) => ({
	addr: 0x8048060 + i,
	bytes: "90",
	text: "nop",
}));

/**
 * Install a `debugCommand` mock that answers the side ops every stop fans out
 * into, and returns `stopAt(pc)` for the control-flow ops.
 */
function mockSession(
	pc: number | ((call: number) => number),
	disasm: DebugInsn[] = [],
): { calls: () => number } {
	let calls = 0;
	mocked.debugCommand.mockImplementation(async (op: string) => {
		if (op === "disasm") return disasm;
		if (op === "backtrace") return [];
		if (op === "breakpoints") return [];
		if (op === "kill" || op === "detach") return { ok: true };
		calls++;
		return stopAt(typeof pc === "function" ? pc(calls) : pc);
	});
	return { calls: () => calls };
}

/**
 * Every test starts with a view connected, because that is how events arrive:
 * the panel registers one channel on mount and everything after that is pushed.
 */
beforeEach(async () => {
	useDebugStore.getState().reset();
	mocked.debugCommand.mockReset();
	mocked.debugSnapshot.mockReset();
	mocked.debugSubscribe.mockReset();
	channel = null;
	mocked.debugSubscribe.mockImplementation(async (onEvent) => {
		channel = onEvent;
	});
	await useDebugStore.getState().connect();
});

/** A published view of the session, as the debugger would send it. */
function snapshotOf(over: Partial<DebugSnapshot> = {}): DebugSnapshot {
	return {
		pid: 4242,
		state: "stopped",
		stop: stopAt(0x804809d),
		breakpoints: [],
		frames: [],
		bias: 0,
		stop_seq: 1,
		...over,
	};
}

describe("ensureDisasm", () => {
	it("fetches a window and keeps it in the session cache", async () => {
		mocked.debugCommand.mockResolvedValue(LONG_WINDOW);
		await useDebugStore.getState().ensureDisasm(0x8048060);
		expect(mocked.debugCommand).toHaveBeenCalledWith("disasm", {
			addr: 0x8048060,
			count: DISASM_WINDOW,
		});
		expect(useDebugStore.getState().disasm.size).toBe(LONG_WINDOW.length);
	});

	it("does not refetch a pc the cache already covers", async () => {
		mocked.debugCommand.mockResolvedValue(LONG_WINDOW);
		await useDebugStore.getState().ensureDisasm(0x8048060);
		// Step forward one instruction: still inside the decoded window.
		await useDebugStore.getState().ensureDisasm(0x8048061);
		expect(mocked.debugCommand).toHaveBeenCalledTimes(1);
		expect(useDebugStore.getState().disasm.size).toBe(LONG_WINDOW.length);
	});

	it("leaves the cached rows in place when a later fetch fails", async () => {
		mocked.debugCommand.mockResolvedValueOnce(LONG_WINDOW);
		await useDebugStore.getState().ensureDisasm(0x8048060);
		const before = useDebugStore.getState().disasm;
		mocked.debugCommand.mockRejectedValueOnce(new Error("gone"));
		await useDebugStore.getState().ensureDisasm(0x900000);
		expect(useDebugStore.getState().disasmError).toContain("gone");
		// The earlier disassembly survives the failure rather than being dropped.
		expect(useDebugStore.getState().disasm).toBe(before);
	});

	it("clears the in-flight anchor whether the fetch resolves or throws", async () => {
		mocked.debugCommand.mockResolvedValueOnce(LONG_WINDOW);
		await useDebugStore.getState().ensureDisasm(0x8048060);
		expect(useDebugStore.getState().disasmPending.size).toBe(0);

		mocked.debugCommand.mockRejectedValueOnce(new Error("nope"));
		await useDebugStore.getState().ensureDisasm(0x900000);
		expect(useDebugStore.getState().disasmPending.size).toBe(0);
	});

	it("ignores an empty result instead of clearing the cache", async () => {
		mocked.debugCommand.mockResolvedValueOnce(LONG_WINDOW);
		await useDebugStore.getState().ensureDisasm(0x8048060);
		const before = useDebugStore.getState().disasm;
		mocked.debugCommand.mockResolvedValueOnce([]);
		await useDebugStore.getState().ensureDisasm(0x900000);
		expect(useDebugStore.getState().disasm).toBe(before);
	});
});

describe("reset", () => {
	it("drops the disassembly cache with the session", async () => {
		mockSession(0x8048060, LONG_WINDOW);
		await useDebugStore.getState().run("launch", { path: "/bin/true" });
		await useDebugStore.getState().ensureDisasm(0x8048060);
		expect(useDebugStore.getState().disasm.size).toBeGreaterThan(0);

		useDebugStore.getState().reset();
		expect(useDebugStore.getState().disasm.size).toBe(0);
	});

	it("clears the cache on kill, so a new session does not inherit addresses", async () => {
		mockSession(0x8048060, LONG_WINDOW);
		await useDebugStore.getState().run("launch", { path: "/bin/true" });
		await useDebugStore.getState().ensureDisasm(0x8048060);
		await useDebugStore.getState().run("kill");
		expect(useDebugStore.getState().disasm.size).toBe(0);
	});
});

describe("DISASM_MIN_FORWARD", () => {
	it("is smaller than the fetch window, so a decoded pc is never refetched", () => {
		expect(DISASM_MIN_FORWARD).toBeLessThan(DISASM_WINDOW);
	});
});

describe("process exit", () => {
	/** A live session with a decoded window, a pc on screen and output captured. */
	async function runIntoLiveSession(): Promise<void> {
		mocked.debugCommand.mockImplementation(async (op: string) => {
			if (op === "disasm") return EXIT_BODY;
			if (op === "backtrace") return [];
			if (op === "breakpoints")
				return [{ id: 1, addr: 0x804809d, enabled: true }];
			if (op === "continue") return exitedStop(9);
			return stopAt(0x804809d);
		});
		await useDebugStore.getState().run("launch", { path: "/bin/true" });
		push({ event: "output", text: "hello from the debuggee\n" });
		await useDebugStore.getState().ensureDisasm(0x804809d);
	}

	it("leaves a finished session visible instead of tearing it down", async () => {
		await runIntoLiveSession();
		expect(useDebugStore.getState().active).toBe(true);
		expect(useDebugStore.getState().disasm.size).toBeGreaterThan(0);

		await useDebugStore.getState().run("continue");

		const s = useDebugStore.getState();
		// Still a session to look at, with everything it showed before intact.
		expect(s.active).toBe(true);
		expect(s.state).toBe("exited");
		expect(s.disasm.size).toBe(EXIT_BODY.length);
		expect(s.breakpoints).toHaveLength(1);
		await flushOutput();
		expect(outputText(useDebugStore.getState().output)).toContain(
			"hello from the debuggee",
		);
	});

	it("reports the exit as a state, not as an error", async () => {
		await runIntoLiveSession();
		await useDebugStore.getState().run("continue");
		const s = useDebugStore.getState();
		expect(s.error).toBeNull();
		expect(s.disasmError).toBeNull();
		expect(s.stop?.reason.reason).toBe("exited");
		expect(s.stop?.reason.code).toBe(9);
	});

	it("drops the zeroed registers but keeps an anchor for the view", async () => {
		await runIntoLiveSession();
		await useDebugStore.getState().run("continue");
		const s = useDebugStore.getState();
		// The terminal stop carries pc 0; believing it would fetch address 0.
		expect(s.registers).toBeNull();
		expect(s.lastPc).toBe(0x804809d);
	});

	it("is no longer a live process, so the stepper disables", async () => {
		await runIntoLiveSession();
		await useDebugStore.getState().run("continue");
		expect(isLiveState(useDebugStore.getState().state)).toBe(false);
	});

	it("treats a fatal signal as the same clean exit", async () => {
		await runIntoLiveSession();
		mocked.debugCommand.mockImplementation(async (op: string) => {
			if (op === "continue") return exitedStop(9, "killed");
			return stopAt(0x804809d);
		});
		await useDebugStore.getState().run("continue");
		const s = useDebugStore.getState();
		expect(s.state).toBe("exited");
		expect(s.error).toBeNull();
		expect(s.disasm.size).toBe(EXIT_BODY.length);
	});

	it("does not refetch anything against the dead process", async () => {
		await runIntoLiveSession();
		mocked.debugCommand.mockClear();
		mocked.debugCommand.mockImplementation(async (op: string) => {
			if (op === "continue") return exitedStop(0);
			return stopAt(0x804809d);
		});
		await useDebugStore.getState().run("continue");
		// A backtrace or disasm here could only fail with "no debuggee is
		// running", which is what used to surface as a spurious error.
		const ops = mocked.debugCommand.mock.calls.map((c) => c[0]);
		expect(ops).not.toContain("backtrace");
		expect(ops).not.toContain("disasm");
	});

	it("survives a pushed view of the finished session", async () => {
		await runIntoLiveSession();
		push({
			event: "snapshot",
			snapshot: snapshotOf({
				pid: null,
				state: "exited",
				stop: exitedStop(9),
				stop_seq: 2,
			}),
		});
		const s = useDebugStore.getState();
		expect(s.active).toBe(true);
		expect(s.state).toBe("exited");
		expect(s.registers).toBeNull();
		expect(s.lastPc).toBe(0x804809d);
		expect(s.disasm.size).toBe(EXIT_BODY.length);
	});
});

describe("relaunching after an exit", () => {
	beforeEach(async () => {
		mocked.debugCommand.mockImplementation(async (op: string) => {
			if (op === "disasm") return EXIT_BODY;
			if (op === "backtrace" || op === "breakpoints") return [];
			if (op === "continue") return exitedStop(9);
			return stopAt(0x804809d);
		});
		await useDebugStore.getState().run("launch", { path: "/bin/first" });
		push({ event: "output", text: "first run\n" });
		await useDebugStore.getState().ensureDisasm(0x804809d);
		await useDebugStore.getState().run("continue");
	});

	it("starts a fresh execution", async () => {
		expect(useDebugStore.getState().state).toBe("exited");
		await useDebugStore.getState().run("launch", { path: "/bin/second" });
		const s = useDebugStore.getState();
		expect(isLiveState(s.state)).toBe(true);
		expect(s.pid).toBe(4242);
		expect(s.registers?.pc).toBe(0x804809d);
		expect(s.error).toBeNull();
	});

	it("does not leak the previous process's addresses into the new one", async () => {
		// The relaunched process reports a different pc, so the old one can only
		// still be present if the previous session's disassembly survived.
		mocked.debugCommand.mockImplementation(async (op: string) => {
			if (op === "breakpoints" || op === "backtrace") return [];
			return stopAt(0x400500);
		});
		await useDebugStore.getState().run("launch", { path: "/bin/second" });
		const s = useDebugStore.getState();
		expect(s.disasm.size).toBe(0);
		expect(s.lastPc).toBe(0x400500);
	});

	it("clears the previous run's stdout instead of appending to it", async () => {
		await useDebugStore.getState().run("launch", { path: "/bin/second" });
		const s = useDebugStore.getState();
		// The backend gives each debugger its own capture buffer, so the pane
		// must show one run's stdout rather than a run's output with the next
		// run's appended underneath.
		expect(outputText(s.output)).toBe("");
	});

	it("shows the new run's own stdout, not a mix", async () => {
		mocked.debugCommand.mockImplementation(async (op: string) => {
			if (op === "breakpoints" || op === "backtrace") return [];
			return stopAt(0x400500);
		});
		await useDebugStore.getState().run("launch", { path: "/bin/second" });
		push({ event: "output", text: "second run\n" });
		await flushOutput();
		const s = useDebugStore.getState();
		expect(outputText(s.output)).toBe("second run\n");
		expect(outputText(s.output)).not.toContain("first run");
	});

	it("clears a stale error so the new session starts clean", async () => {
		mocked.debugCommand.mockRejectedValueOnce(new Error("stale failure"));
		await useDebugStore
			.getState()
			.run("continue")
			.catch(() => undefined);
		expect(useDebugStore.getState().error).toBe("stale failure");
		await useDebugStore.getState().run("launch", { path: "/bin/second" });
		expect(useDebugStore.getState().error).toBeNull();
	});
});

describe("failed ops", () => {
	it("restores the state a failed continue had optimistically changed", async () => {
		mocked.debugCommand.mockImplementation(async (op: string) => {
			if (op === "breakpoints" || op === "backtrace") return [];
			return stopAt(0x804809d);
		});
		await useDebugStore.getState().run("launch", { path: "/bin/true" });
		expect(useDebugStore.getState().state).toBe("stopped");

		mocked.debugCommand.mockRejectedValueOnce(
			new Error("no debuggee is running"),
		);
		await useDebugStore
			.getState()
			.run("continue")
			.catch(() => undefined);
		// Not left claiming a running process that was never started.
		expect(useDebugStore.getState().state).toBe("stopped");
	});

	it("keeps a disassembly failure out of the session-wide error", async () => {
		mocked.debugCommand.mockRejectedValue(
			new Error("no debuggee is running"),
		);
		await useDebugStore.getState().ensureDisasm(0x8048060);
		const s = useDebugStore.getState();
		// Separate fields, so the debugger does not report the same failure twice.
		expect(s.disasmError).toBe("no debuggee is running");
		expect(s.error).toBeNull();
	});
});

describe("runTo", () => {
	it("leaves a temporary breakpoint only for the duration of the run", async () => {
		let bps: { id: number; addr: number; enabled: boolean }[] = [];
		mocked.debugCommand.mockImplementation(async (op: string) => {
			if (op === "backtrace") return [];
			if (op === "breakpoints") return bps;
			if (op === "break") {
				bps = [{ id: 9, addr: 0x401000, enabled: true }];
				return bps[0];
			}
			if (op === "unbreak") {
				bps = [];
				return {};
			}
			return stopAt(0x401000);
		});
		await useDebugStore.getState().run("launch", { path: "/bin/true" });
		await useDebugStore.getState().runTo(0x401000);
		expect(mocked.debugCommand).toHaveBeenCalledWith("break", {
			addr: 0x401000,
		});
		expect(mocked.debugCommand).toHaveBeenCalledWith("continue", undefined);
		expect(mocked.debugCommand).toHaveBeenCalledWith("unbreak", { id: 9 });
		expect(useDebugStore.getState().breakpoints).toEqual([]);
	});

	it("keeps a breakpoint the analyst already set", async () => {
		mocked.debugCommand.mockImplementation(async (op: string) => {
			if (op === "backtrace") return [];
			if (op === "breakpoints")
				return [{ id: 3, addr: 0x401000, enabled: true }];
			return stopAt(0x401000);
		});
		await useDebugStore.getState().run("launch", { path: "/bin/true" });
		await useDebugStore.getState().runTo(0x401000);
		expect(mocked.debugCommand).not.toHaveBeenCalledWith(
			"break",
			expect.anything(),
		);
		expect(mocked.debugCommand).not.toHaveBeenCalledWith(
			"unbreak",
			expect.anything(),
		);
	});

	it("resolves when the target exits before the temporary breakpoint is hit", async () => {
		let dead = false;
		mocked.debugCommand.mockImplementation(async (op: string) => {
			if (op === "backtrace") return [];
			if (op === "breakpoints")
				return dead ? [] : [{ id: 4, addr: 0x401000, enabled: true }];
			if (op === "unbreak" && dead)
				throw new Error("no debuggee is running");
			if (op === "continue") {
				dead = true;
				return exitedStop(0);
			}
			return stopAt(0x401000);
		});
		await useDebugStore.getState().run("launch", { path: "/bin/true" });
		await expect(
			useDebugStore.getState().runTo(0x401000),
		).resolves.toBeUndefined();
	});
});

describe("isLiveState", () => {
	it("is true only for a process that can still be stepped", () => {
		expect(isLiveState("stopped")).toBe(true);
		expect(isLiveState("running")).toBe(true);
		expect(isLiveState("exited")).toBe(false);
		expect(isLiveState("idle")).toBe(false);
	});
});

describe("isTerminalStop", () => {
	it("recognises the two ways a process can end", () => {
		expect(isTerminalStop(exitedStop(0))).toBe(true);
		expect(isTerminalStop(exitedStop(9, "killed"))).toBe(true);
	});

	it("is false for every stop that leaves a process to step", () => {
		expect(isTerminalStop(stopAt(0x804809d))).toBe(false);
		expect(
			isTerminalStop({ reason: { reason: "breakpoint" } } as DebugStop),
		).toBe(false);
		expect(isTerminalStop(null)).toBe(false);
		expect(isTerminalStop(undefined)).toBe(false);
	});
});

describe("stdout is per process", () => {
	beforeEach(() => {
		mocked.debugCommand.mockImplementation(async (op: string) => {
			if (op === "breakpoints" || op === "backtrace") return [];
			if (op === "continue") return exitedStop(0);
			return stopAt(0x804809d);
		});
	});

	it("stays readable after the process exits", async () => {
		await useDebugStore.getState().run("launch", { path: "/bin/first" });
		push({ event: "output", text: "run output\n" });
		await useDebugStore.getState().run("continue");
		// The finished session keeps its own output on screen.
		await flushOutput();
		expect(outputText(useDebugStore.getState().output)).toBe(
			"run output\n",
		);
	});

	it("is dropped when the session is killed", async () => {
		await useDebugStore.getState().run("launch", { path: "/bin/first" });
		push({ event: "output", text: "run output\n" });
		await useDebugStore.getState().run("kill");
		expect(outputText(useDebugStore.getState().output)).toBe("");
	});

	it("discards output still in flight from a session that has been replaced", async () => {
		await useDebugStore.getState().run("launch", { path: "/bin/first" });
		await useDebugStore.getState().run("launch", { path: "/bin/second" });

		// A relaunch tells the window the new session's generation with it, so a
		// straggler from the session it replaced is recognisable the moment it
		// lands — and the transcript belongs to the process on screen.
		push({ event: "snapshot", snapshot: snapshotOf({ stop_seq: 2 }) }, 2);
		push({ event: "output", text: "late output from the first run\n" }, 1);
		push({ event: "output", text: "second run\n" }, 2);
		await flushOutput();
		expect(outputText(useDebugStore.getState().output)).toBe(
			"second run\n",
		);
	});

	it("throws away output that is still queued when the process is replaced", async () => {
		// Not a straggler this time: the first run's output arrived and is
		// waiting for its frame when the relaunch replaces the debuggee. Committing
		// it afterwards would open the new process's transcript with the old
		// process's words in it.
		await useDebugStore.getState().run("launch", { path: "/bin/first" });
		push({ event: "output", text: "from the first run\n" });
		await useDebugStore.getState().run("launch", { path: "/bin/second" });
		await flushOutput();

		expect(outputText(useDebugStore.getState().output)).toBe("");
	});

	it("advances the generation on every process boundary", async () => {
		await useDebugStore.getState().run("launch", { path: "/bin/first" });
		const first = useDebugStore.getState().sessionGen;
		await useDebugStore.getState().run("launch", { path: "/bin/second" });
		expect(useDebugStore.getState().sessionGen).toBe(first + 1);
		await useDebugStore.getState().run("kill");
		expect(useDebugStore.getState().sessionGen).toBe(first + 2);
	});
});

describe("stdin echo", () => {
	beforeEach(async () => {
		mocked.debugCommand.mockImplementation(async (op: string) => {
			if (op === "breakpoints" || op === "backtrace") return [];
			return stopAt(0x804809d);
		});
		await useDebugStore.getState().run("launch", { path: "/bin/first" });
		push({ event: "output", text: "Let's start the CTF:\n" });
	});

	it("shows what was sent, so the pane reflects the input", async () => {
		await useDebugStore.getState().sendStdin("AAAA\n");
		await flushOutput();
		expect(outputText(useDebugStore.getState().output)).toContain("AAAA\n");
	});

	it("tags the echo apart from what the debuggee printed", async () => {
		await useDebugStore.getState().sendStdin("AAAA\n");
		await flushOutput();
		const chunks = useDebugStore.getState().output;
		expect(chunks.map((c) => c.echo ?? false)).toEqual([false, true]);
		expect(chunks[1].text).toBe("AAAA\n");
	});

	it("does not let an echo jump ahead of output already printed", async () => {
		// The transcript is one conversation in one order. An echo written
		// straight through while program output is still queued would put the
		// analyst's own line above the debuggee's line that prompted it.
		await useDebugStore.getState().sendStdin("AAAA\n");
		await flushOutput();

		const chunks = useDebugStore.getState().output;
		expect(chunks.map((c) => c.text)).toEqual([
			"Let's start the CTF:\n",
			"AAAA\n",
		]);
	});

	it("sends exactly what it echoes", async () => {
		await useDebugStore.getState().sendStdin("AAAA\n");
		expect(mocked.debugCommand).toHaveBeenCalledWith("stdin", {
			data: "AAAA\n",
		});
		// Nothing transformed on the way to the transcript.
		await flushOutput();
		const echoed = useDebugStore.getState().output.find((c) => c.echo);
		expect(echoed?.text).toBe("AAAA\n");
	});

	it("keeps consecutive lines of input in one echoed chunk", async () => {
		await useDebugStore.getState().sendStdin("one\n");
		await useDebugStore.getState().sendStdin("two\n");
		await flushOutput();
		const echoes = useDebugStore.getState().output.filter((c) => c.echo);
		expect(echoes).toHaveLength(1);
		expect(echoes[0].text).toBe("one\ntwo\n");
	});

	it("echoes nothing when the send failed", async () => {
		mocked.debugCommand.mockRejectedValueOnce(
			new Error("stdin is not piped"),
		);
		await useDebugStore.getState().sendStdin("AAAA\n");
		const s = useDebugStore.getState();
		expect(s.error).toBe("stdin is not piped");
		// A failed send must not put text in the transcript that never arrived.
		expect(outputText(s.output)).not.toContain("AAAA");
	});

	it("does not echo into a process that replaced the one it was typed at", async () => {
		let release: () => void = () => undefined;
		mocked.debugCommand.mockImplementationOnce(
			() => new Promise((resolve) => (release = () => resolve({}))),
		);
		const inFlight = useDebugStore.getState().sendStdin("AAAA\n");

		await useDebugStore.getState().run("launch", { path: "/bin/second" });
		release();
		await inFlight;

		expect(outputText(useDebugStore.getState().output)).not.toContain(
			"AAAA",
		);
	});
});

describe("resolving what a call goes to", () => {
	/**
	 * `ff 25 10 00 00 00` is a PLT stub at 0x1080: a jump six bytes long, rip
	 * past it, plus 0x10, so the slot it forwards through is 0x1096.
	 */
	const SCANF_STUB = "ff2510000000";

	beforeEach(() => {
		useDebugStore.setState({ bias: 0 });
		mocked.debugCommand.mockImplementation(
			async (op: string, args?: unknown) => {
				if (op === "breakpoints" || op === "backtrace") return [];
				if (op === "read") {
					const addr = (args as { addr: number }).addr;
					// The stub is read at its runtime address, bias applied, so the
					// fixture matches the low bits rather than one fixed address.
					const low = addr % 0x10000;
					return {
						addr,
						len: 6,
						hex: low === 0x1080 ? SCANF_STUB : "554889e5",
					};
				}
				return stopAt(0x804809d);
			},
		);
	});

	it("maps a GOT slot to the import its stub forwards to", async () => {
		await useDebugStore
			.getState()
			.ensureCallNames([{ name: "scanf", plt: 0x1080 }]);
		expect(useDebugStore.getState().callNames.get(0x1096)).toBe("scanf");
	});

	it("reads the stub at the debuggee's address, not the static one", async () => {
		// A PIE's PLT is mapped somewhere else entirely; reading the static
		// address would fail or, worse, read some other mapping.
		useDebugStore.setState({ bias: 0x7f000000 });
		await useDebugStore
			.getState()
			.ensureCallNames([{ name: "scanf", plt: 0x1080 }]);
		// The stored key stays static so a call's target can be compared with it.
		expect(useDebugStore.getState().callNames.get(0x1096)).toBe("scanf");
		expect(mocked.debugCommand).toHaveBeenCalledWith("read", {
			addr: 0x7f001080,
			len: 6,
		});
	});

	it("names an import without the engine's imp. prefix", async () => {
		await useDebugStore
			.getState()
			.ensureCallNames([{ name: "imp.puts", plt: 0x1080 }]);
		expect(useDebugStore.getState().callNames.get(0x1096)).toBe("puts");
	});

	it("resolves once per session, however often it is asked", async () => {
		const imports = [{ name: "scanf", plt: 0x1080 }];
		await useDebugStore.getState().ensureCallNames(imports);
		await useDebugStore.getState().ensureCallNames(imports);
		const reads = mocked.debugCommand.mock.calls.filter(
			([op]) => op === "read",
		);
		expect(reads).toHaveLength(1);
	});

	it("resolves again for a new session, whose GOT is somewhere else", async () => {
		await useDebugStore
			.getState()
			.ensureCallNames([{ name: "scanf", plt: 0x1080 }]);
		await useDebugStore.getState().run("launch", { path: "/bin/second" });
		expect(useDebugStore.getState().callNames.size).toBe(0);
	});

	it("leaves an import unnamed when its stub cannot be read", async () => {
		mocked.debugCommand.mockImplementation(async (op: string) => {
			if (op === "read") throw new Error("no debuggee is running");
			if (op === "breakpoints" || op === "backtrace") return [];
			return stopAt(0x804809d);
		});
		await useDebugStore
			.getState()
			.ensureCallNames([{ name: "scanf", plt: 0x1080 }]);
		// A missing name costs an annotation, nothing else.
		expect(useDebugStore.getState().callNames.size).toBe(0);
		expect(useDebugStore.getState().callNamesDone).toBe(true);
	});

	it("does nothing for a binary whose engine reported no stubs", async () => {
		await useDebugStore.getState().ensureCallNames([{ name: "scanf" }]);
		expect(mocked.debugCommand).not.toHaveBeenCalledWith(
			"read",
			expect.anything(),
		);
		expect(useDebugStore.getState().callNamesDone).toBe(true);
	});
});

describe("naming a call into a library", () => {
	const LIB = "/lib/libc.so.6";
	// The debuggee is mapped at 0x555555554000 and libc at 0x7f000000, so a
	// call at 0x7f001234 is 0x1234 into libc.
	const LIBC_CALL = 0x7f001234;

	beforeEach(() => {
		useDebugStore.setState({ bias: 0, pid: 4242 });
		mocked.debugCommand.mockReset();
		mocked.debugModules.mockReset();
		mocked.debugModuleSymbols.mockReset();
		mocked.debugModules.mockResolvedValue([
			{ path: "/bin/target", base: 0x555555554000, end: 0x555555555000 },
			{ path: LIB, base: 0x7f000000, end: 0x7f100000 },
		]);
		// A launch stops at the entry point, so the op has to answer with a stop.
		mocked.debugCommand.mockImplementation(async (op: string) => {
			if (op === "breakpoints" || op === "backtrace") return [];
			return stopAt(0x804809d);
		});
		mocked.debugModuleSymbols.mockResolvedValue([
			{ addr: 0x1000, name: "close_near", is_func: true },
			{ addr: 0x1100, name: "read", is_func: true },
			{ addr: 0x1108, name: "read.local", is_func: false },
		]);
	});

	it("names a library address from that library's own symbols", async () => {
		await useDebugStore.getState().ensureModuleNames([LIBC_CALL]);
		expect(useDebugStore.getState().moduleNames.get(LIBC_CALL)).toBe(
			"read+0x134",
		);
		expect(mocked.debugModuleSymbols).toHaveBeenCalledWith(LIB);
	});

	it("names an exact entry with no offset", async () => {
		await useDebugStore.getState().ensureModuleNames([0x7f001100]);
		console.log(
			"DBG calls:",
			mocked.debugModules.mock.calls.length,
			mocked.debugModuleSymbols.mock.calls.length,
		);
		expect(useDebugStore.getState().moduleNames.get(0x7f001100)).toBe(
			"read",
		);
	});

	it("reads the library once however many of its calls are in view", async () => {
		await useDebugStore
			.getState()
			.ensureModuleNames([0x7f001100, 0x7f001234, 0x7f001300]);
		expect(mocked.debugModuleSymbols).toHaveBeenCalledTimes(1);
		expect(mocked.debugModules).toHaveBeenCalledTimes(1);
	});

	it("claims nothing for an address no module covers", async () => {
		// A heap or stack address is in no file, so there is nothing to read and
		// nothing to name: a garbage pointer must not inherit a name from
		// whichever module happens to sit below it. The map is still consulted,
		// because that is the only way to know it covers nothing.
		await useDebugStore.getState().ensureModuleNames([0x7ffd3dc96000]);
		expect(useDebugStore.getState().moduleNames.size).toBe(0);
		expect(mocked.debugModuleSymbols).not.toHaveBeenCalled();
	});

	it("skips an address it has already named", async () => {
		await useDebugStore.getState().ensureModuleNames([0x7f001100]);
		await useDebugStore.getState().ensureModuleNames([0x7f001100]);
		expect(mocked.debugModuleSymbols).toHaveBeenCalledTimes(1);
	});

	it("reads nothing when there is no process to read from", async () => {
		useDebugStore.setState({ pid: null });
		await useDebugStore.getState().ensureModuleNames([LIBC_CALL]);
		expect(mocked.debugModules).not.toHaveBeenCalled();
	});

	it("survives a module map it cannot read", async () => {
		mocked.debugModules.mockRejectedValue(new Error("no such process"));
		await useDebugStore.getState().ensureModuleNames([LIBC_CALL]);
		expect(useDebugStore.getState().moduleNames.size).toBe(0);
	});

	it("survives a symbol table it cannot read", async () => {
		mocked.debugModuleSymbols.mockRejectedValue(
			new Error("permission denied"),
		);
		await useDebugStore.getState().ensureModuleNames([LIBC_CALL]);
		expect(useDebugStore.getState().moduleNames.size).toBe(0);
	});

	it("keeps what it already named when a later read fails", async () => {
		await useDebugStore.getState().ensureModuleNames([0x7f001100]);
		mocked.debugModuleSymbols.mockRejectedValue(new Error("gone"));
		await useDebugStore.getState().ensureModuleNames([0x7f001300]);
		expect(useDebugStore.getState().moduleNames.get(0x7f001100)).toBe(
			"read",
		);
	});

	it("forgets the map with the session, whose libraries are different ones", async () => {
		await useDebugStore.getState().ensureModuleNames([0x7f001100]);
		await useDebugStore.getState().run("launch", { path: "/bin/second" });
		expect(useDebugStore.getState().modules).toEqual([]);
		expect(useDebugStore.getState().moduleNames.size).toBe(0);
	});
});

describe("saying what a [rip + x] operand points at", () => {
	// `push qword ptr [rip + 0x1d15e]` at 0x400510: six bytes on, then the
	// displacement, lands on 0x60106e.
	const SLOT = 0x60106e;
	/** `"Give Me Your Flag\0"` */
	const FLAG = "47697665204d6520596f757220466c616700";

	beforeEach(() => {
		useDebugStore.setState({ bias: 0, pid: 4242, modules: [] });
		mocked.debugCommand.mockReset();
		mocked.debugCommand.mockImplementation(
			async (op: string, args?: unknown) => {
				if (op === "breakpoints" || op === "backtrace") return [];
				if (op === "read") {
					const addr = (args as { addr: number }).addr;
					return {
						addr,
						len: 64,
						hex: addr === SLOT ? FLAG : "0011223344556677",
					};
				}
				return stopAt(0x804809d);
			},
		);
	});

	it("spells out the text a reference points at", async () => {
		await useDebugStore.getState().ensureDataNames([SLOT]);
		expect(useDebugStore.getState().dataNames.get(SLOT)).toBe(
			'"Give Me Your Flag"',
		);
	});

	it("names an import's GOT slot without reading it", async () => {
		// The PLT table already says which import owns the slot, so there is
		// nothing to read and nothing to guess.
		useDebugStore.setState({ callNames: new Map([[SLOT, "scanf"]]) });
		await useDebugStore.getState().ensureDataNames([SLOT]);
		expect(useDebugStore.getState().dataNames.get(SLOT)).toBe("scanf");
		expect(mocked.debugCommand).not.toHaveBeenCalledWith(
			"read",
			expect.anything(),
		);
	});

	it("claims nothing for a reference that is not text", async () => {
		const other = 0x601100;
		await useDebugStore.getState().ensureDataNames([other]);
		expect(useDebugStore.getState().dataNames.has(other)).toBe(false);
	});

	it("does not read the same address twice", async () => {
		await useDebugStore.getState().ensureDataNames([SLOT]);
		await useDebugStore.getState().ensureDataNames([SLOT]);
		const reads = mocked.debugCommand.mock.calls.filter(
			([op]) => op === "read",
		);
		expect(reads).toHaveLength(1);
	});

	it("does not read an address in a library, whose bytes are not text here", async () => {
		// The words in a GOT slot are a pointer into libc. They are not a string,
		// and the file they belong to is named by its own symbol table instead.
		const inLibc = 0x7f001000;
		useDebugStore.setState({
			modules: [
				{ path: "/lib/libc.so.6", base: 0x7f000000, end: 0x7f100000 },
			],
		});
		await useDebugStore.getState().ensureDataNames([inLibc]);
		expect(useDebugStore.getState().dataNames.has(inLibc)).toBe(false);
		expect(mocked.debugCommand).not.toHaveBeenCalledWith(
			"read",
			expect.anything(),
		);
	});

	it("survives an unreadable address", async () => {
		mocked.debugCommand.mockImplementation(async (op: string) => {
			if (op === "read") throw new Error("no debuggee is running");
			if (op === "breakpoints" || op === "backtrace") return [];
			return stopAt(0x804809d);
		});
		await useDebugStore.getState().ensureDataNames([SLOT]);
		expect(useDebugStore.getState().dataNames.size).toBe(0);
		// The view keeps working, so the in-flight guard has to be released.
		expect(useDebugStore.getState().dataNamesPending).toBe(false);
	});

	it("forgets the names with the session, whose addresses mean nothing next time", async () => {
		await useDebugStore.getState().ensureDataNames([SLOT]);
		await useDebugStore.getState().run("launch", { path: "/bin/second" });
		expect(useDebugStore.getState().dataNames.size).toBe(0);
	});
});

describe("isLastStopView", () => {
	it("is only true while the target is running", () => {
		expect(isLastStopView("running")).toBe(true);
		expect(isLastStopView("stopped")).toBe(false);
		// A finished session has no live reading either, but it is claiming
		// nothing: the exit strip already says the process is gone.
		expect(isLastStopView("exited")).toBe(false);
		expect(isLastStopView("idle")).toBe(false);
	});
});

describe("a running target keeps the last stop's view", () => {
	beforeEach(() => {
		mocked.debugCommand.mockImplementation(async (op: string) => {
			if (op === "breakpoints" || op === "backtrace") return [];
			return stopAt(0x804809d);
		});
	});

	/**
	 * The output pane is live and the register pane is not, so while the target
	 * runs they describe two different moments. The register values are kept —
	 * they are the last thing known — and `isLastStopView` is what the panes
	 * read to say so, instead of leaving the analyst to read a stale pc as the
	 * instruction the program is sitting in.
	 */
	it("holds the last stop's registers while the session runs", async () => {
		// Two stops, so there is a previous stop to have marked something
		// against; the first stop of a session has nothing to compare to.
		push({ event: "snapshot", snapshot: snapshotOf({ stop_seq: 1 }) });
		push({
			event: "snapshot",
			snapshot: snapshotOf({
				stop_seq: 2,
				stop: stopWith(2),
			}),
		});
		const atStop = useDebugStore.getState().registers;
		expect(atStop?.pc).toBe(2);

		await useDebugStore.getState().run("continue");
		push({
			event: "snapshot",
			snapshot: snapshotOf({
				state: "running",
				stop_seq: 2,
				stop: stopWith(2),
			}),
		});

		expect(isLastStopView(useDebugStore.getState().state)).toBe(true);
		expect(useDebugStore.getState().registers).toEqual(atStop);
		// The same stop, republished: the change marks stand rather than being
		// recomputed against themselves.
		expect(useDebugStore.getState().changedRegisters.has("rip")).toBe(true);
	});
});

describe("register change marking", () => {
	/** A register set, with the general-purpose registers spelled out. */
	function regs(
		pc: number,
		sp: number,
		fp: number,
		values: Record<string, number> = {},
	): DebugRegisters {
		return { pc, sp, fp, values } as DebugRegisters;
	}

	it("names the specials and the general-purpose registers that moved", () => {
		const before = regs(0x401000, 0x7ffd00, 0x7ffcf0, { rax: 1, rbx: 2 });
		const after = regs(0x401005, 0x7ffd00, 0x7ffcf0, { rax: 1, rbx: 3 });
		expect([...changedRegisters(before, after)].sort()).toEqual([
			"rbx",
			"rip",
		]);
	});

	it("marks the stack and frame pointers when the call moved", () => {
		const before = regs(0x401000, 0x7ffd00, 0x7ffcf0);
		const after = regs(0x401000, 0x7ffd10, 0x7ffce0);
		expect([...changedRegisters(before, after)].sort()).toEqual([
			"rbp",
			"rsp",
		]);
	});

	it("marks a register the first time a target reports one", () => {
		expect([
			...changedRegisters(regs(1, 2, 3), regs(1, 2, 3, { rax: 0 })),
		]).toEqual(["rax"]);
	});

	it("marks nothing when nothing moved", () => {
		const same = regs(0x401000, 0x7ffd00, 0x7ffcf0, { rax: 1 });
		expect(changedRegisters(same, same).size).toBe(0);
	});

	it("marks nothing when there is no previous stop to compare against", () => {
		expect(changedRegisters(null, regs(1, 2, 3)).size).toBe(0);
		expect(changedRegisters(regs(1, 2, 3), null).size).toBe(0);
	});

	it("recomputes the marks when a new stop arrives", () => {
		push({ event: "snapshot", snapshot: snapshotOf({ stop_seq: 1 }) });
		push({
			event: "snapshot",
			snapshot: snapshotOf({
				stop_seq: 2,
				stop: {
					pid: 4242,
					registers: regs(0x804809e, 1, 2),
				} as DebugStop,
			}),
		});
		expect(useDebugStore.getState().changedRegisters.has("rip")).toBe(true);
	});

	it("keeps the marks when the same stop is published again", () => {
		const first = {
			pid: 4242,
			registers: regs(0x804809d, 1, 2),
		} as DebugStop;
		const second = {
			pid: 4242,
			registers: regs(0x804809e, 1, 2),
		} as DebugStop;
		push({
			event: "snapshot",
			snapshot: snapshotOf({ stop_seq: 4, stop: first }),
		});
		push({
			event: "snapshot",
			snapshot: snapshotOf({ stop_seq: 5, stop: second }),
		});
		expect(useDebugStore.getState().changedRegisters.has("rip")).toBe(true);
		// A view published for a reason that leaves the registers alone: a
		// breakpoint was added, say. Same stop, so the marks still stand.
		push({
			event: "snapshot",
			snapshot: snapshotOf({ stop_seq: 5, stop: second }),
		});
		expect(useDebugStore.getState().changedRegisters.has("rip")).toBe(true);
	});
});

describe("pushed trace", () => {
	beforeEach(() => {
		mocked.debugCommand.mockImplementation(async (op: string) => {
			if (op === "breakpoints" || op === "backtrace") return [];
			return stopAt(0x804809d);
		});
	});

	it("grows as stops are made", () => {
		push({ event: "trace_appended", entry: entry(0x804809d) });
		push({ event: "trace_appended", entry: entry(0x804809e) });
		expect(
			useDebugStore.getState().trace.map((e) => e.registers.pc),
		).toEqual([0x804809d, 0x804809e]);
	});

	it("is cleared when the timeline is cleared", () => {
		push({ event: "trace_appended", entry: entry(0x804809d) });
		// The host clears it from its own side, then says so.
		push({ event: "trace_cleared" });
		expect(useDebugStore.getState().trace).toEqual([]);
	});

	it("drops the trace when the session is replaced", async () => {
		push({ event: "trace_appended", entry: entry(0x804809d) });
		await useDebugStore.getState().run("launch", { path: "/bin/second" });
		expect(useDebugStore.getState().trace).toEqual([]);
	});
});

describe("the push channel", () => {
	it("registers a channel the host can answer, not a bare callback", async () => {
		// The host side is `tauri::ipc::Channel<Envelope>`, and a plain function
		// does not deserialize into one: the command rejects and the view gets
		// nothing at all, silently. So the argument has to be a real Channel.
		expect(channel).toBeInstanceOf(Channel);
		expect(typeof channel?.onmessage).toBe("function");
	});

	it("folds an event the host delivers through the channel", async () => {
		push({ event: "output", text: "hello from the debuggee\n" });
		await flushOutput();
		expect(outputText(useDebugStore.getState().output)).toBe(
			"hello from the debuggee\n",
		);
	});

	it("holds a burst of output to one commit, not one per chunk", async () => {
		// A program that prints faster than the screen refreshes delivers events
		// far faster than a human can read them; committing each is a re-render
		// of the whole panel per chunk.
		const seen: string[] = [];
		const unsub = useDebugStore.subscribe((s) =>
			seen.push(outputText(s.output)),
		);
		for (let i = 0; i < 20; i++) {
			push({ event: "output", text: `line ${i}\n` });
		}
		await flushOutput();
		unsub();

		expect(seen).toHaveLength(1);
		expect(seen[0]).toContain("line 0");
		expect(seen[0]).toContain("line 19");
	});

	it("says so when the channel cannot be registered", async () => {
		mocked.debugSubscribe.mockRejectedValueOnce(
			new Error("invalid args `onEvent` for command `debug_subscribe`"),
		);
		await useDebugStore.getState().disconnect();
		await useDebugStore.getState().connect();
		// A dead channel looks exactly like a hung program otherwise: no output,
		// no trace, and a running target nobody can see.
		expect(useDebugStore.getState().error).toContain("debug event channel");
		expect(useDebugStore.getState().connected).toBe(false);
	});

	it("registers once, however often the view connects", async () => {
		mocked.debugSubscribe.mockClear();
		await useDebugStore.getState().connect();
		await useDebugStore.getState().connect();
		expect(mocked.debugSubscribe).toHaveBeenCalledTimes(0);
		await useDebugStore.getState().disconnect();
		await useDebugStore.getState().connect();
		expect(mocked.debugSubscribe).toHaveBeenCalledTimes(1);
	});

	it("keeps working through a snapshot the view asks for itself", async () => {
		mocked.debugSnapshot.mockResolvedValue(snapshotOf({ stop_seq: 3 }));
		await useDebugStore.getState().refreshSnapshot();
		expect(useDebugStore.getState().stopSeq).toBe(3);
		// The channel is still the one from the connect: the pull must not have
		// replaced it, or pushes would silently stop arriving.
		push({ event: "trace_appended", entry: entry(1) });
		expect(useDebugStore.getState().trace).toHaveLength(1);
	});
});
