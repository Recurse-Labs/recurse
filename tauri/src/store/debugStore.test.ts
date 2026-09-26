import { beforeEach, describe, expect, it, vi } from "vitest";

// The store talks to the Tauri backend through ../api; mock it so these tests
// drive the cache/pc logic without a runtime.
vi.mock("../api", () => ({
	api: {
		debugCommand: vi.fn(),
		debugSnapshot: vi.fn(),
	},
}));

import { isLiveState, isTerminalStop, useDebugStore } from "./debugStore";
import { api } from "../api";
import { DISASM_MIN_FORWARD, DISASM_WINDOW } from "../lib/debugDisasm";
import { outputText } from "../lib/debugOutput";
import type { DebugInsn, DebugRegisters, DebugStop } from "../types";

const mocked = vi.mocked(api);

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

beforeEach(() => {
	useDebugStore.getState().reset();
	mocked.debugCommand.mockReset();
	mocked.debugSnapshot.mockReset();
});

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

describe("visited program counters", () => {
	it("records the pc of every stop", async () => {
		mockSession(0x8048060);
		await useDebugStore.getState().run("launch", { path: "/bin/true" });
		expect(useDebugStore.getState().visited.has(0x8048060)).toBe(true);
	});

	it("accumulates across steps, so earlier instructions stay marked", async () => {
		// Each step advances one instruction, the way the real backend does.
		const path = [0x804809d, 0x804809e, 0x80480a0];
		mockSession(
			(n) => path[Math.min(n, path.length) - 1] ?? 0x80480a0,
			EXIT_BODY,
		);

		for (let i = 0; i < 3; i++) {
			await useDebugStore.getState().run("step");
		}
		const visited = useDebugStore.getState().visited;
		expect(visited.has(0x804809d)).toBe(true);
		expect(visited.has(0x804809e)).toBe(true);
		expect(visited.has(0x80480a0)).toBe(true);
	});

	it("follow-mode snapshots mark the pc too", async () => {
		mocked.debugSnapshot.mockResolvedValue({
			pid: 4242,
			state: "stopped",
			stop: stopAt(0x804809d),
			breakpoints: [],
			frames: [],
			bias: 0,
		});
		await useDebugStore.getState().pollSnapshot();
		expect(useDebugStore.getState().visited.has(0x804809d)).toBe(true);
	});

	it("does not grow on a repeated poll of the same pc", async () => {
		mocked.debugSnapshot.mockResolvedValue({
			pid: 4242,
			state: "stopped",
			stop: stopAt(0x804809d),
			breakpoints: [],
			frames: [],
			bias: 0,
		});
		await useDebugStore.getState().pollSnapshot();
		const first = useDebugStore.getState().visited;
		await useDebugStore.getState().pollSnapshot();
		expect(useDebugStore.getState().visited).toBe(first);
	});
});

describe("reset", () => {
	it("drops the disassembly cache and the visited history with the session", async () => {
		mockSession(0x8048060, LONG_WINDOW);
		await useDebugStore.getState().run("launch", { path: "/bin/true" });
		await useDebugStore.getState().ensureDisasm(0x8048060);
		expect(useDebugStore.getState().disasm.size).toBeGreaterThan(0);
		expect(useDebugStore.getState().visited.size).toBeGreaterThan(0);

		useDebugStore.getState().reset();
		expect(useDebugStore.getState().disasm.size).toBe(0);
		expect(useDebugStore.getState().visited.size).toBe(0);
	});

	it("clears the cache on kill, so a new session does not inherit addresses", async () => {
		mockSession(0x8048060, LONG_WINDOW);
		await useDebugStore.getState().run("launch", { path: "/bin/true" });
		await useDebugStore.getState().ensureDisasm(0x8048060);
		await useDebugStore.getState().run("kill");
		expect(useDebugStore.getState().disasm.size).toBe(0);
		expect(useDebugStore.getState().visited.size).toBe(0);
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
			if (op === "output") return { text: "hello from the debuggee\n" };
			if (op === "continue") return exitedStop(9);
			return stopAt(0x804809d);
		});
		await useDebugStore.getState().run("launch", { path: "/bin/true" });
		await useDebugStore.getState().pollOutput();
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
		expect(s.visited.has(0x804809d)).toBe(true);
		expect(s.breakpoints).toHaveLength(1);
		expect(outputText(s.output)).toContain("hello from the debuggee");
		expect(s.log.length).toBeGreaterThan(0);
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

	it("survives follow-mode snapshots of the finished session", async () => {
		await runIntoLiveSession();
		mocked.debugSnapshot.mockResolvedValue({
			pid: null,
			state: "exited",
			stop: exitedStop(9),
			breakpoints: [{ id: 1, addr: 0x804809d, enabled: true }],
			frames: [],
			bias: 0,
		});
		await useDebugStore.getState().pollSnapshot();
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
			if (op === "output") return { text: "first run\n" };
			if (op === "continue") return exitedStop(9);
			return stopAt(0x804809d);
		});
		await useDebugStore.getState().run("launch", { path: "/bin/first" });
		await useDebugStore.getState().pollOutput();
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
		// still be present if the previous session's history survived.
		mocked.debugCommand.mockImplementation(async (op: string) => {
			if (op === "breakpoints" || op === "backtrace") return [];
			return stopAt(0x400500);
		});
		await useDebugStore.getState().run("launch", { path: "/bin/second" });
		const s = useDebugStore.getState();
		expect(s.disasm.size).toBe(0);
		expect(s.visited.has(0x804809d)).toBe(false);
		// Only the new process's own pc is marked.
		expect([...s.visited]).toEqual([0x400500]);
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

	it("keeps the op log, which is a record of what was done", async () => {
		const before = useDebugStore.getState().log.length;
		await useDebugStore.getState().run("launch", { path: "/bin/second" });
		const s = useDebugStore.getState();
		expect(s.log.length).toBeGreaterThan(before);
		expect(s.log.some((l) => l.includes("/bin/first"))).toBe(true);
	});

	it("shows the new run's own stdout, not a mix", async () => {
		mocked.debugCommand.mockImplementation(async (op: string) => {
			if (op === "output") return { text: "second run\n" };
			if (op === "breakpoints" || op === "backtrace") return [];
			return stopAt(0x400500);
		});
		await useDebugStore.getState().run("launch", { path: "/bin/second" });
		await useDebugStore.getState().pollOutput();
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
			if (op === "output") return { text: "run output\n" };
			if (op === "breakpoints" || op === "backtrace") return [];
			if (op === "continue") return exitedStop(0);
			return stopAt(0x804809d);
		});
	});

	it("stays readable after the process exits", async () => {
		await useDebugStore.getState().run("launch", { path: "/bin/first" });
		await useDebugStore.getState().pollOutput();
		await useDebugStore.getState().run("continue");
		// The finished session keeps its own output on screen.
		expect(outputText(useDebugStore.getState().output)).toBe(
			"run output\n",
		);
	});

	it("is dropped when the session is killed", async () => {
		await useDebugStore.getState().run("launch", { path: "/bin/first" });
		await useDebugStore.getState().pollOutput();
		await useDebugStore.getState().run("kill");
		expect(outputText(useDebugStore.getState().output)).toBe("");
	});

	it("keeps the op log across a kill", async () => {
		await useDebugStore.getState().run("launch", { path: "/bin/first" });
		const before = useDebugStore.getState().log.length;
		await useDebugStore.getState().run("kill");
		expect(useDebugStore.getState().log.length).toBeGreaterThan(before);
	});

	it("discards an output poll that was in flight across a relaunch", async () => {
		await useDebugStore.getState().run("launch", { path: "/bin/first" });

		// A poll issued for the first process, whose reply lands only after the
		// second process has replaced it.
		let release: (v: { text?: string }) => void = () => undefined;
		mocked.debugCommand.mockImplementationOnce(
			() =>
				new Promise<{ text?: string }>(
					(resolve) => (release = resolve),
				),
		);
		const inFlight = useDebugStore.getState().pollOutput();

		await useDebugStore.getState().run("launch", { path: "/bin/second" });
		release({ text: "late output from the first run\n" });
		await inFlight;

		// Dropped: it belongs to a process that is no longer the current one.
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
			if (op === "output") return { text: "Let's start the CTF:\n" };
			if (op === "breakpoints" || op === "backtrace") return [];
			return stopAt(0x804809d);
		});
		await useDebugStore.getState().run("launch", { path: "/bin/first" });
		await useDebugStore.getState().pollOutput();
	});

	it("shows what was sent, so the pane reflects the input", async () => {
		await useDebugStore.getState().sendStdin("AAAA\n");
		expect(outputText(useDebugStore.getState().output)).toContain("AAAA\n");
	});

	it("tags the echo apart from what the debuggee printed", async () => {
		await useDebugStore.getState().sendStdin("AAAA\n");
		const chunks = useDebugStore.getState().output;
		expect(chunks.map((c) => c.echo ?? false)).toEqual([false, true]);
		expect(chunks[1].text).toBe("AAAA\n");
	});

	it("sends exactly what it echoes", async () => {
		await useDebugStore.getState().sendStdin("AAAA\n");
		expect(mocked.debugCommand).toHaveBeenCalledWith("stdin", {
			data: "AAAA\n",
		});
		// Nothing transformed on the way to the transcript.
		const echoed = useDebugStore.getState().output.find((c) => c.echo);
		expect(echoed?.text).toBe("AAAA\n");
	});

	it("keeps consecutive lines of input in one echoed chunk", async () => {
		await useDebugStore.getState().sendStdin("one\n");
		await useDebugStore.getState().sendStdin("two\n");
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
