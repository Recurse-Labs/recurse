import { create } from "zustand";

import { api } from "../api";
import type { Backend } from "../types";

const KEY = "recurse.zoomLevel";
const BACKEND_KEY = "recurse.backend";
const THEME_KEY = "recurse.theme";
const MIN = -5;
const MAX = 8;

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

function readInitialBackend(): Backend {
	const v = localStorage.getItem(BACKEND_KEY);
	return v === "r2" ? "r2" : "native";
}

function readInitial(): number {
	const v = Number(localStorage.getItem(KEY));
	if (!Number.isFinite(v)) return 0;
	return Math.min(MAX, Math.max(MIN, Math.round(v)));
}

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
		set({ backend });
		localStorage.setItem(BACKEND_KEY, backend);
		try {
			await api.setBackend(backend);
		} catch {
			/* non-fatal: takes effect on next launch */
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
