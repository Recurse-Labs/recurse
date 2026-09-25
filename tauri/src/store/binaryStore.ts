import { create } from "zustand";

import { api } from "../api";
import type { BinaryInfo } from "../types";
import { useAnalysisStore } from "./analysisStore";
import { useSessionStore } from "./sessionStore";
import { useUiStore } from "./uiStore";

interface BinaryState {
	binary: BinaryInfo | null;
	busy: boolean;
	indexing: boolean;
	openBinary: (path: string) => Promise<void>;
	closeBinary: () => Promise<void>;
}

/**
 * Cancel token for the background-index poll. Bumped on every open and close so
 * a stale loop exits immediately instead of updating a newer session.
 */
let indexPollToken = 0;

/**
 * Poll the backend's background indexer until it finishes, refreshing the
 * function list as the count grows. Lazy backends keep finding functions after
 * the initial open; synchronous backends report `indexing: false` on the first
 * poll and the loop ends at once. Never blocks the open itself.
 *
 * @param token - the poll generation captured when the loop started
 */
async function pollIndexing(token: number) {
	while (token === indexPollToken) {
		let progress: { function_count: number; indexing: boolean };
		try {
			progress = await api.analysisProgress();
		} catch {
			return;
		}
		if (token !== indexPollToken) return;
		useBinaryStore.setState({ indexing: progress.indexing });
		if (
			progress.function_count > 0 &&
			(progress.function_count !==
				useAnalysisStore.getState().funcs.length ||
				!progress.indexing)
		) {
			try {
				const funcs = await api.functions();
				if (token === indexPollToken && funcs) {
					useAnalysisStore.getState().setFunctions(funcs);
				}
			} catch {
				/* a refresh failure must not tear down the poll */
			}
		}
		if (!progress.indexing) return;
		await new Promise((resolve) => setTimeout(resolve, 1500));
	}
}

export const useBinaryStore = create<BinaryState>((set) => ({
	binary: null,
	busy: false,
	indexing: false,
	openBinary: async (path) => {
		indexPollToken += 1;
		set({ busy: true, indexing: false });
		useUiStore.getState().setErr(null);
		useAnalysisStore.getState().beginOpen();
		try {
			const info = await api.openBinary(path);
			set({ binary: info });
			// A freshly opened binary starts on the recon page.
			useUiStore.getState().setTab("recon");
			await api.analyze();
			const [f, s, i] = await Promise.all([
				api.functions(),
				api.strings(),
				api.imports(),
			]);
			useAnalysisStore.getState().setAll({
				funcs: f ?? [],
				strings: s ?? [],
				imports: i ?? [],
			});
			await useSessionStore.getState().ensure();
			void pollIndexing(indexPollToken);
		} catch (e) {
			useUiStore.getState().setErr(`failed to open binary: ${e}`);
			set({ binary: null });
		} finally {
			set({ busy: false });
		}
	},
	closeBinary: async () => {
		indexPollToken += 1;
		set({ indexing: false });
		try {
			await api.closeBinary();
		} catch {
			/* ignore close errors */
		}
		useAnalysisStore.getState().reset();
		set({ binary: null });
	},
}));
