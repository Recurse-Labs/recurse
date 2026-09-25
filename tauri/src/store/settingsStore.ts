import { create } from "zustand";

import { api } from "../api";
import type { Backend } from "../types";
import { useAnalysisStore } from "./analysisStore";
import { useBinaryStore } from "./binaryStore";
import { useUiStore } from "./uiStore";

const KEY = "recurse.zoomLevel";
const BACKEND_KEY = "recurse.backend";
const THEME_KEY = "recurse.theme";
const MIN = -5;
const MAX = 8;

/**
 * Calculates the zoom scale multiplier for a given integer zoom level.
 *
 * @param level - The integer zoom level.
 * @returns The scale multiplier factor.
 */
function scaleFor(level: number): number {
	return Math.pow(1.2, level);
}

export type Theme = "dark" | "light";

interface SettingsState {
	zoomLevel: number;
	backend: Backend;
	theme: Theme;
	initZoom: () => Promise<void>;
	zoomIn: () => Promise<void>;
	zoomOut: () => Promise<void>;
	resetZoom: () => Promise<void>;
	initBackend: () => Promise<void>;
	setBackend: (backend: Backend) => Promise<void>;
	initTheme: () => void;
	toggleTheme: () => void;
	setTheme: (theme: Theme) => void;
}

/**
 * Reads the initially configured backend from localStorage.
 *
 * @returns The initial Backend identifier ('native', 'r2', or 'ida').
 */
function readInitialBackend(): Backend {
	const v = localStorage.getItem(BACKEND_KEY);
	return v === "r2" || v === "ida" ? v : "native";
}

/**
 * Reads the initial zoom level from localStorage.
 *
 * @returns Clamped integer zoom level between MIN and MAX.
 */
function readInitial(): number {
	const v = Number(localStorage.getItem(KEY));
	if (!Number.isFinite(v)) return 0;
	return Math.min(MAX, Math.max(MIN, Math.round(v)));
}

/**
 * Reads the initial theme from localStorage or system prefers-color-scheme.
 *
 * @returns 'light' or 'dark'.
 */
function readInitialTheme(): Theme {
	const v = localStorage.getItem(THEME_KEY);
	if (v === "light" || v === "dark") return v;
	if (typeof window !== "undefined" && window.matchMedia) {
		return window.matchMedia("(prefers-color-scheme: light)").matches
			? "light"
			: "dark";
	}
	return "dark";
}

/**
 * Applies the given theme to document.documentElement.
 *
 * @param theme - The theme to apply ('light' or 'dark').
 */
function applyTheme(theme: Theme) {
	if (typeof document === "undefined") return;
	const root = document.documentElement;
	root.classList.toggle("dark", theme === "dark");
	root.style.colorScheme = theme;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
	zoomLevel: readInitial(),
	backend: readInitialBackend(),
	theme: readInitialTheme(),

	initZoom: async () => {
		try {
			await api.setZoom(scaleFor(get().zoomLevel));
		} catch {
			/* non-fatal */
		}
	},

	zoomIn: async () => {
		const z = Math.min(MAX, get().zoomLevel + 1);
		set({ zoomLevel: z });
		localStorage.setItem(KEY, String(z));
		try {
			await api.setZoom(scaleFor(z));
		} catch {
			/* non-fatal */
		}
	},

	zoomOut: async () => {
		const z = Math.max(MIN, get().zoomLevel - 1);
		set({ zoomLevel: z });
		localStorage.setItem(KEY, String(z));
		try {
			await api.setZoom(scaleFor(z));
		} catch {
			/* non-fatal */
		}
	},

	resetZoom: async () => {
		localStorage.removeItem(KEY);
		set({ zoomLevel: 0 });
		try {
			await api.setZoom(1);
		} catch {
			/* non-fatal */
		}
	},

	initBackend: async () => {
		try {
			const { backend } = await api.getBackend();
			set({ backend });
			localStorage.setItem(BACKEND_KEY, backend);
		} catch {
			/* non-fatal: keep the local value */
		}
	},

	setBackend: async (backend: Backend) => {
		const prevBackend = get().backend;
		try {
			await api.setBackend(backend);
			useAnalysisStore.getState().clearDecompiled();
			const currentBinary = useBinaryStore.getState().binary;
			if (currentBinary?.path) {
				const prevSelected = useAnalysisStore.getState().selected;
				const currentTab = useUiStore.getState().tab;
				await useBinaryStore.getState().openBinary(currentBinary.path);
				if (currentTab) {
					useUiStore.getState().setTab(currentTab);
				}
				if (prevSelected) {
					const funcs = useAnalysisStore.getState().funcs;
					const match = funcs.find(
						(f) =>
							f.addr === prevSelected.addr ||
							f.name === prevSelected.name,
					);
					if (match) {
						useAnalysisStore.getState().selectFn(match);
					}
				}
			}
			set({ backend });
			localStorage.setItem(BACKEND_KEY, backend);
		} catch (e) {
			useUiStore.getState().setErr(String(e));
			set({ backend: prevBackend });
			localStorage.setItem(BACKEND_KEY, prevBackend);
			await api.setBackend(prevBackend).catch(() => {});
		}
	},

	initTheme: () => {
		applyTheme(get().theme);
	},

	toggleTheme: () => {
		const next: Theme = get().theme === "dark" ? "light" : "dark";
		set({ theme: next });
		localStorage.setItem(THEME_KEY, next);
		applyTheme(next);
	},

	setTheme: (theme: Theme) => {
		set({ theme });
		localStorage.setItem(THEME_KEY, theme);
		applyTheme(theme);
	},
}));

// Applied at import time (before first paint in practice) rather than only
// from a React effect, so a saved light-mode preference never flashes dark
// first. index.html still hardcodes class="dark" as the no-JS fallback.
applyTheme(readInitialTheme());
