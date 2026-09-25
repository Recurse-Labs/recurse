import { beforeEach, describe, expect, it, vi } from "vitest";

// Node has no localStorage; settingsStore reads it at module init.
const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
	getItem: (k: string) => store.get(k) ?? null,
	setItem: (k: string, v: string) => void store.set(k, v),
	removeItem: (k: string) => void store.delete(k),
});

// Stores hit the Tauri backend through ../api; mock the whole module so
// tests drive pure state logic and race guards without a runtime.
vi.mock("../api", () => ({
	api: {
		functionDisasm: vi.fn(),
		decompile: vi.fn(),
		setZoom: vi.fn().mockResolvedValue(undefined),
	},
}));

import { useAnalysisStore } from "./analysisStore";
import { useContextStore } from "./contextStore";
import { useSettingsStore } from "./settingsStore";
import { api } from "../api";

const flush = () => new Promise((r) => setTimeout(r, 0));

const mockedDisasm = vi.mocked(api.functionDisasm);

function deferred<T>() {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((r) => (resolve = r));
	return { promise, resolve };
}

describe("analysisStore selectFn stale-response guard", () => {
	beforeEach(() => {
		useAnalysisStore.getState().reset();
		mockedDisasm.mockReset();
	});

	it("applies only the newest selection when responses race", async () => {
		const first = deferred();
		const second = deferred();
		mockedDisasm
			.mockReturnValueOnce(first.promise as never)
			.mockReturnValueOnce(second.promise as never);

		useAnalysisStore.getState().selectFn({ addr: 0x1000 } as never);
		useAnalysisStore.getState().selectFn({ addr: 0x2000 } as never);

		// Old response lands last-in-real-time? No: resolve OLD first — the
		// guard must still keep it from clobbering the newer selection.
		first.resolve({ instructions: [{ text: "old" }] });
		await Promise.resolve();
		expect(useAnalysisStore.getState().asm).toBeNull(); // discarded
		expect(useAnalysisStore.getState().selected?.addr).toBe(0x2000);

		second.resolve({ instructions: [{ text: "new" }] });
		await flush();
		expect(useAnalysisStore.getState().asm).toEqual({
			instructions: [{ text: "new" }],
		});
		expect(useAnalysisStore.getState().asmLoading).toBe(false);
	});

	it("keeps multiple function tabs and closes the active tab to its neighbor", () => {
		mockedDisasm.mockReturnValue(new Promise(() => {}) as never);
		useAnalysisStore
			.getState()
			.setFunctions([{ addr: 0x1000 }, { addr: 0x2000 }] as never);
		useAnalysisStore.getState().selectFn({ addr: 0x1000 } as never);
		useAnalysisStore.getState().selectFn({ addr: 0x2000 } as never);
		useAnalysisStore.getState().selectFn({ addr: 0x1000 } as never);
		expect(useAnalysisStore.getState().openTabs).toEqual([0x1000, 0x2000]);
		useAnalysisStore.getState().closeFunctionTab(0x1000);
		expect(useAnalysisStore.getState().openTabs).toEqual([0x2000]);
		expect(useAnalysisStore.getState().selected?.addr).toBe(0x2000);
	});

	it("reorders function tabs without changing the active function", () => {
		mockedDisasm.mockReturnValue(new Promise(() => {}) as never);
		useAnalysisStore
			.getState()
			.setFunctions([{ addr: 0x1000 }, { addr: 0x2000 }] as never);
		useAnalysisStore.getState().selectFn({ addr: 0x1000 } as never);
		useAnalysisStore.getState().selectFn({ addr: 0x2000 } as never);
		useAnalysisStore.getState().moveFunctionTab(0x1000, 0x2000);
		expect(useAnalysisStore.getState().openTabs).toEqual([0x2000, 0x1000]);
		expect(useAnalysisStore.getState().selected?.addr).toBe(0x2000);
	});

	it("reuses cached disassembly when switching back to a tab", async () => {
		mockedDisasm
			.mockResolvedValueOnce({ name: "one" } as never)
			.mockResolvedValueOnce({ name: "two" } as never);
		useAnalysisStore.getState().selectFn({ addr: 0x1000 } as never);
		await flush();
		useAnalysisStore.getState().selectFn({ addr: 0x2000 } as never);
		await flush();
		useAnalysisStore.getState().selectFn({ addr: 0x1000 } as never);
		expect(mockedDisasm).toHaveBeenCalledTimes(2);
		expect(useAnalysisStore.getState().asm).toEqual({ name: "one" });
		expect(useAnalysisStore.getState().asmLoading).toBe(false);
	});

	it("clears loading on error for the current selection", async () => {
		mockedDisasm.mockRejectedValueOnce(new Error("boom"));
		useAnalysisStore.getState().selectFn({ addr: 0x3000 } as never);
		await flush();
		const s = useAnalysisStore.getState();
		expect(s.asmLoading).toBe(false);
	});
});

describe("contextStore", () => {
	it("commitPending appends and clears pending", () => {
		useContextStore.getState().clear();
		useContextStore.getState().setPending({
			source: "disasm",
			label: "main",
			text: "push rbp",
		} as never);
		useContextStore.getState().commitPending();
		const items = useContextStore.getState().items;
		expect(items).toHaveLength(1);
		expect(items[0].label).toBe("main");
		expect(useContextStore.getState().pending).toBeNull();
	});
});

describe("settingsStore zoom clamps", () => {
	it("zoomIn stops at MAX", async () => {
		useSettingsStore.setState({ zoomLevel: 8 });
		await useSettingsStore.getState().zoomIn();
		expect(useSettingsStore.getState().zoomLevel).toBe(8);
	});

	it("zoomOut stops at MIN", async () => {
		useSettingsStore.setState({ zoomLevel: -5 });
		await useSettingsStore.getState().zoomOut();
		expect(useSettingsStore.getState().zoomLevel).toBe(-5);
	});
});
