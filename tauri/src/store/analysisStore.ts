import { create } from "zustand";

import { api } from "../api";
import type {
	AsmResult,
	DecompileAnnotation,
	Function,
	Import,
	R2String,
} from "../types";
import { useUiStore } from "./uiStore";

interface AnalysisState {
	funcs: Function[];
	selected: Function | null;
	/** Function addresses currently open in the disassembly tab strip. */
	openTabs: number[];
	asm: AsmResult | null;
	/** Disassembly cache keyed by function address for instant tab switches. */
	asmByAddr: Record<number, AsmResult>;
	/** In-flight requests are shared when switching away and back quickly. */
	asmPending: Record<number, Promise<AsmResult>>;
	asmLoading: boolean;
	strings: R2String[];
	imports: Import[];
	decompiled: string | null;
	decompiledAnnotations: DecompileAnnotation[];
	decompileError: string | null;
	decompiling: boolean;

	beginOpen: () => void;
	setAll: (data: {
		funcs: Function[];
		strings: R2String[];
		imports: Import[];
	}) => void;
	setFunctions: (funcs: Function[]) => void;
	renameFunction: (addr: number, name: string) => Promise<void>;
	reset: () => void;
	selectFn: (fn: Function) => void;
	closeFunctionTab: (addr: number) => void;
	moveFunctionTab: (from: number, to: number) => void;
	refreshDisasm: () => Promise<void>;
	decompile: () => Promise<void>;
	clearDecompiled: () => void;
}

const initial = {
	funcs: [] as Function[],
	selected: null as Function | null,
	openTabs: [] as number[],
	asm: null as AsmResult | null,
	asmByAddr: {} as Record<number, AsmResult>,
	asmPending: {} as Record<number, Promise<AsmResult>>,
	asmLoading: false,
	strings: [] as R2String[],
	imports: [] as Import[],
	decompiled: null as string | null,
	decompiledAnnotations: [] as DecompileAnnotation[],
	decompileError: null as string | null,
	decompiling: false,
};

const setErr = (e: string) => useUiStore.getState().setErr(e);

export const useAnalysisStore = create<AnalysisState>((set, get) => ({
	...initial,

	beginOpen: () => set({ ...initial }),

	setAll: ({ funcs, strings, imports }) => set({ funcs, strings, imports }),

	setFunctions: (funcs) =>
		set((state) => ({
			funcs,
			selected: state.selected
				? (funcs.find((f) => f.addr === state.selected?.addr) ??
					state.selected)
				: null,
		})),

	renameFunction: async (addr, name) => {
		const trimmed = name.trim();
		await api.renameFunction(addr, trimmed);
		const sel = get().selected;
		if (!trimmed) {
			// Clearing restores the engine's original name.
			const funcs = await api.functions();
			set({
				funcs,
				selected:
					sel?.addr === addr
						? (funcs.find((f) => f.addr === addr) ?? sel)
						: sel,
			});
		} else {
			set({
				funcs: get().funcs.map((f) =>
					f.addr === addr ? { ...f, name: trimmed } : f,
				),
				selected: sel?.addr === addr ? { ...sel, name: trimmed } : sel,
			});
		}
		// Disassembly comments embed function names, so re-fetch the open
		// function so the rename shows up there too (the graph already
		// re-fetches because it depends on `funcs`).
		if (sel?.addr === addr) await get().refreshDisasm();
	},

	reset: () => set({ ...initial, decompiling: false }),

	selectFn: (fn) => {
		// UI concern: switch to disassembly tab when a function is picked.
		useUiStore.getState().setTab("disasm");
		const cached = get().asmByAddr[fn.addr];
		set((state) => ({
			selected: fn,
			openTabs: state.openTabs.includes(fn.addr)
				? state.openTabs
				: [...state.openTabs, fn.addr],
			asm: cached ?? null,
			asmLoading: !cached,
			decompiled: null,
			decompiledAnnotations: [],
			decompileError: null,
			decompiling: false,
		}));
		const addr = fn.addr;
		if (
			cached ||
			Object.prototype.hasOwnProperty.call(get().asmPending, addr)
		)
			return;
		const request = api.functionDisasm(addr);
		set((state) => ({
			asmPending: { ...state.asmPending, [addr]: request },
		}));
		request
			.then((asm) => {
				set((state) => ({
					asmByAddr: { ...state.asmByAddr, [addr]: asm },
					...(state.selected?.addr === addr ? { asm } : {}),
				}));
			})
			.catch((e) => {
				if (get().selected?.addr === addr) {
					set({ asm: null });
					setErr(String(e));
				}
			})
			.finally(() => {
				set((state) => {
					const { [addr]: _finished, ...pending } = state.asmPending;
					return {
						asmPending: pending,
						...(state.selected?.addr === addr
							? { asmLoading: false }
							: {}),
					};
				});
			});
	},

	closeFunctionTab: (addr) => {
		const state = get();
		const index = state.openTabs.indexOf(addr);
		if (index < 0) return;
		const openTabs = state.openTabs.filter((tab) => tab !== addr);
		set((current) => {
			const { [addr]: _cached, ...asmByAddr } = current.asmByAddr;
			return { openTabs, asmByAddr };
		});
		if (state.selected?.addr !== addr) return;
		const nextAddr = openTabs[Math.min(index, openTabs.length - 1)];
		const next =
			nextAddr === undefined
				? null
				: (state.funcs.find((f) => f.addr === nextAddr) ?? null);
		if (next) {
			get().selectFn(next);
		} else {
			set({
				selected: null,
				asm: null,
				asmLoading: false,
				decompiled: null,
				decompiledAnnotations: [],
				decompileError: null,
				decompiling: false,
			});
		}
	},

	moveFunctionTab: (from, to) => {
		const tabs = [...get().openTabs];
		const fromIndex = tabs.indexOf(from);
		const toIndex = tabs.indexOf(to);
		if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;
		tabs.splice(fromIndex, 1);
		tabs.splice(toIndex, 0, from);
		set({ openTabs: tabs });
	},

	refreshDisasm: async () => {
		const sel = get().selected;
		if (!sel) return;
		const addr = sel.addr;
		set({ asmLoading: true });
		try {
			const asm = await api.functionDisasm(addr);
			set((state) => ({
				asmByAddr: { ...state.asmByAddr, [addr]: asm },
				...(state.selected?.addr === addr ? { asm } : {}),
			}));
		} catch (e) {
			if (get().selected?.addr === addr) setErr(String(e));
		} finally {
			if (get().selected?.addr === addr) set({ asmLoading: false });
		}
	},

	decompile: async () => {
		const sel = get().selected;
		if (!sel) return;
		const addr = sel.addr;
		set({
			decompiling: true,
			decompiled: null,
			decompiledAnnotations: [],
			decompileError: null,
		});
		try {
			const out = await api.decompile(addr);
			if (get().selected?.addr !== addr) return;
			const code =
				typeof out === "string"
					? out
					: (out?.code ?? JSON.stringify(out, null, 2));
			const annotations =
				typeof out === "string" ? [] : (out.annotations ?? []);
			set({ decompiled: code, decompiledAnnotations: annotations });
		} catch (e) {
			if (get().selected?.addr !== addr) return;
			set({
				decompileError: `${e}\n\nThe decompiler plugin is not available on this install.`,
			});
		} finally {
			if (get().selected?.addr === addr) set({ decompiling: false });
		}
	},

	clearDecompiled: () =>
		set({
			decompiled: null,
			decompiledAnnotations: [],
			decompileError: null,
			decompiling: false,
		}),
}));
