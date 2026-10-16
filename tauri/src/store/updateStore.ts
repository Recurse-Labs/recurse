import { create } from "zustand";
import { getVersion } from "@tauri-apps/api/app";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type UpdateStatus =
	| "idle"
	| "checking"
	| "up-to-date"
	| "available"
	| "downloading"
	| "restarting"
	| "error";

interface UpdateState {
	status: UpdateStatus;
	currentVersion: string;
	/** Set once an update is found; used for the "Update to vX" label. */
	availableVersion: string | null;
	notes: string | null;
	/** 0-100 while `status === "downloading"`; null when unknown. */
	progress: number | null;
	error: string | null;
	/** Held across `checkForUpdates` -> `installAndRestart`. */
	pending: Update | null;
	checkForUpdates: () => Promise<void>;
	installAndRestart: () => Promise<void>;
}

// Bundled dev/test builds (no updater artifacts, no signed endpoint) throw
// on `check()`; treat that as "can't check" rather than surfacing a scary
// error on every launch.
function isExpectedUnavailable(err: unknown): boolean {
	const msg = String(err instanceof Error ? err.message : err);
	return /could not fetch a valid release json|no updater endpoints/i.test(
		msg,
	);
}

export const useUpdateStore = create<UpdateState>((set, get) => ({
	status: "idle",
	currentVersion: "",
	availableVersion: null,
	notes: null,
	progress: null,
	error: null,
	pending: null,

	checkForUpdates: async () => {
		set({ status: "checking", error: null });
		try {
			const currentVersion = await getVersion();
			const update = await check();
			if (update?.available) {
				set({
					status: "available",
					currentVersion,
					availableVersion: update.version,
					notes: update.body ?? null,
					pending: update,
				});
			} else {
				set({
					status: "up-to-date",
					currentVersion,
					availableVersion: null,
					pending: null,
				});
			}
		} catch (err) {
			if (isExpectedUnavailable(err)) {
				set({ status: "idle", error: null });
				return;
			}
			set({
				status: "error",
				error: err instanceof Error ? err.message : String(err),
			});
		}
	},

	installAndRestart: async () => {
		const update = get().pending;
		if (!update) return;
		set({ status: "downloading", progress: 0, error: null });
		try {
			let downloaded = 0;
			let total = 0;
			await update.downloadAndInstall((event) => {
				switch (event.event) {
					case "Started":
						total = event.data.contentLength ?? 0;
						break;
					case "Progress":
						downloaded += event.data.chunkLength;
						set({
							progress:
								total > 0
									? Math.min(
											100,
											Math.round(
												(downloaded / total) * 100,
											),
										)
									: null,
						});
						break;
					case "Finished":
						set({ progress: 100 });
						break;
				}
			});
			set({ status: "restarting" });
			await relaunch();
		} catch (err) {
			set({
				status: "error",
				error: err instanceof Error ? err.message : String(err),
			});
		}
	},
}));
