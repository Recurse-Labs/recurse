import { api, pickBinary } from "@/api";
import { THEMES } from "@/lib/themes";
import { useAnalysisStore } from "@/store/analysisStore";
import { useBinaryStore } from "@/store/binaryStore";
import { useDebugStore } from "@/store/debugStore";
import { useProjectStore } from "@/store/projectStore";
import { useSettingsStore } from "@/store/settingsStore";
import { useUiStore } from "@/store/uiStore";
import { useUpdateStore } from "@/store/updateStore";
import type { CenterTab, Function } from "@/types";

/** One thing the app can be asked to do, wherever it is asked from. */
export interface Command {
	id: string;
	/** How the palette lists it, which is also what the palette filters on. */
	title: string;
	/**
	 * How the top-bar menu words it, when the menu needs a different wording
	 * from the palette.
	 *
	 * The palette lists every command flat with no heading, so a command that
	 * only means something in context has to carry that context in its own
	 * title to be findable by typing. A menu has a heading above the group, so
	 * the same words are read twice. This is the one command in the app that
	 * needs it, and it is here rather than special-cased in the menu because the
	 * mismatch is a property of the command, not of either place it is shown.
	 */
	menuTitle?: string;
	/** The keyboard shortcut to show beside it, when there is one. */
	hint?: string;
	run: () => void;
	/**
	 * Set for a command that shows a state rather than doing a thing, so the menu
	 * can tick the one that is in force.
	 */
	checked?: boolean;
	/** Set while the action cannot be run, so the menu greys it out. */
	disabled?: boolean;
	/** Which menu in the top bar this belongs under. */
	menu: MenuName;
	/** The heading it sits under inside that menu. */
	section: string;
}

/**
 * The menus the app has, named once.
 *
 * Naming them in one place is what keeps an option in one menu: a panel that
 * publishes its commands to `MENU.view` cannot have them turn up under Go, which
 * is what happened when the publisher was passed a list and every menu read it.
 */
export const MENU = {
	file: "File",
	view: "View",
	appearance: "Appearance",
	go: "Go",
	run: "Run",
	settings: "Settings",
} as const;

/** One of the app's menus. */
export type MenuName = (typeof MENU)[keyof typeof MENU];

/**
 * The menus, in the order a bar shows them.
 *
 * The names are the ones an editor of this kind has trained everyone to expect,
 * so a menu called View is the one holding the switches that change what you see.
 * A menu with no commands in it is not rendered at all: a header that opens onto
 * an empty panel is worse than no header, because it says there is nothing here
 * and is right.
 *
 * Appearance sits next to View because it is the part of View that was never
 * about the view. A menu holding ten themes and three zoom steps does not belong
 * under a heading about panels and disassembly; splitting it out costs one menu
 * and leaves both halves saying what they are.
 *
 * View keeps its place for what a panel publishes to it, and is absent from the
 * bar when nothing has: an empty menu that opens onto a blank panel says there
 * is nothing here and is right, which is worse than not being there. Its two own
 * commands are gone — the chat has a button in the activity bar and a shortcut,
 * and a second route to the same two places is a second thing to keep straight.
 *
 * Settings is last, and is its own menu rather than a section under File: it is
 * the one menu a reader goes looking for by name, and having to know that the
 * model picker and the debugger's settings are filed under "File ▸ Settings" is
 * the kind of thing you only know once.
 */
export const MENU_ORDER: readonly MenuName[] = [
	MENU.file,
	MENU.view,
	MENU.appearance,
	MENU.go,
	MENU.run,
	MENU.settings,
];

/** Every centre tab, by the name the palette and the Go menu both call it. */
export const TAB_LABEL: Record<CenterTab, string> = {
	recon: "Recon",
	disasm: "Disassembly",
	callgraph: "Call Graph",
	strings: "Strings",
	imports: "Imports",
	findings: "Findings",
	hex: "Hex view",
	debug: "Debug",
	console: "Console",
};

/**
 * How the Settings menu words the updater, and whether it can be clicked.
 *
 * Read at the moment the menu or palette is built, not stored, so a check that
 * finished while the menu was closed is what the next open shows.
 */
function updateCommand(): { title: string; disabled: boolean } {
	const { status, availableVersion, progress } = useUpdateStore.getState();
	switch (status) {
		case "checking":
			return { title: "Checking for updates…", disabled: true };
		case "available":
			return {
				title: `Update to v${availableVersion} — restart to install`,
				disabled: false,
			};
		case "downloading":
			return {
				title:
					progress != null
						? `Downloading update… ${progress}%`
						: "Downloading update…",
				disabled: true,
			};
		case "restarting":
			return { title: "Restarting…", disabled: true };
		case "up-to-date":
			return { title: "You're up to date", disabled: false };
		case "error":
			return { title: "Update check failed — retry", disabled: false };
		default:
			return { title: "Check for updates", disabled: false };
	}
}

/**
 * Every command the app offers, resolved from the stores at the moment it is
 * asked for.
 *
 * Both places that offer commands call this — the palette and the menu bar — so
 * an action cannot exist in one and be missing from the other. Nothing here is
 * memoised because the answer depends on what is open: a command that closes the
 * project is not offered before there is one, and the debugger's step commands
 * are not offered before a session is running.
 *
 * @returns The commands, in the order they were declared.
 *
 * @example
 * buildCommands().every((c) => MENU_ORDER.includes(c.menu)) // => true
 */
export function buildCommands(): Command[] {
	const ui = useUiStore.getState();
	const bin = useBinaryStore.getState();
	const dbg = useDebugStore.getState();
	const settings = useSettingsStore.getState();

	const cmds: Command[] = [
		{
			id: "open",
			title: "Open binary…",
			hint: "Ctrl+O",
			menu: MENU.file,
			section: "Binary",
			run: () => {
				void pickBinary().then((p) => {
					if (p) void bin.openBinary(p);
				});
			},
		},
		{
			id: "model-picker",
			title: "Model / provider…",
			menu: MENU.settings,
			section: "",
			run: () => ui.setModelPickerOpen(true),
		},
		{
			id: "debugger-settings",
			title: "Debugger…",
			menu: MENU.settings,
			section: "",
			// Opened on the next tick, not inline: a menu restores focus to its
			// trigger as it closes, which would immediately yank it back out of the
			// dialog that just opened.
			run: () =>
				setTimeout(
					() => useUiStore.getState().setDebuggerSettingsOpen(true),
					0,
				),
		},
	];
	if (!bin.binary) {
		cmds.push({
			id: "new-project",
			title: "New project…",
			menu: MENU.file,
			section: "Binary",
			run: () => ui.setNewProjectOpen(true),
		});
	}
	if (bin.binary) {
		cmds.push({
			id: "close",
			title: "Close project",
			menu: MENU.file,
			section: "Binary",
			run: () => void useProjectStore.getState().close(),
		});
		for (const tab of Object.keys(TAB_LABEL) as CenterTab[]) {
			cmds.push({
				id: `tab-${tab}`,
				title: `Go to ${TAB_LABEL[tab]}`,
				menu: MENU.go,
				section: "Panels",
				run: () => ui.setTab(tab),
			});
		}
	}
	cmds.push(
		// One command per theme rather than a submenu, because these are listed
		// flat in the palette and a submenu there is a dead end. The palette title
		// is prefixed so typing "theme" finds them — the palette has no heading to
		// file them under — and the menu title is the bare name, because the menu
		// has the "Theme" heading right above them and would otherwise read
		// "Theme: Theme: Tokyo Night". The one in force is ticked, which is how a
		// reader tells ten names apart without remembering which they are on.
		...THEMES.map((theme) => ({
			id: `theme-${theme.id}`,
			title: `Theme: ${theme.label}`,
			menuTitle: theme.label,
			menu: MENU.appearance,
			section: "Theme",
			checked: settings.theme === theme.id,
			run: () => settings.setTheme(theme.id),
		})),
		{
			id: "zoom-in",
			title: "Zoom in",
			hint: "Ctrl +",
			menu: MENU.appearance,
			section: "Zoom",
			run: () => void settings.zoomIn(),
		},
		{
			id: "zoom-out",
			title: "Zoom out",
			hint: "Ctrl −",
			menu: MENU.appearance,
			section: "Zoom",
			run: () => void settings.zoomOut(),
		},
		{
			id: "zoom-reset",
			title: "Reset zoom",
			hint: "Ctrl 0",
			menu: MENU.appearance,
			section: "Zoom",
			run: () => void settings.resetZoom(),
		},
	);

	// Under Settings rather than View: an engine is a choice about how the work is
	// done, not a switch that changes what is on screen. The titles carry "Analysis
	// engine" rather than sitting under a heading of that name, because the palette
	// lists these flat and a reader searching for "engine" has to find them there
	// too. The one in force is ticked rather than listed twice.
	for (const [backend, title] of [
		["native", "Native (pure Rust)"],
		["r2", "radare2"],
		["ida", "IDA Pro (Hex-Rays)"],
	] as const) {
		cmds.push({
			id: `engine-${backend}`,
			title: `Analysis engine: ${title}`,
			menu: MENU.settings,
			section: "",
			checked: settings.backend === backend,
			run: () => void settings.setBackend(backend),
		});
	}

	// The header that used to hold this is gone; Settings is where a reader
	// looks for it now. The title is the live state, so opening the menu (or
	// the palette) shows "Update to v…" rather than a check that already ran.
	const update = updateCommand();
	cmds.push({
		id: "check-updates",
		title: update.title,
		menu: MENU.settings,
		section: "Updates",
		disabled: update.disabled,
		run: () => {
			const store = useUpdateStore.getState();
			if (
				store.status === "checking" ||
				store.status === "downloading" ||
				store.status === "restarting"
			) {
				return;
			}
			if (store.status === "available") void store.installAndRestart();
			else void store.checkForUpdates();
		},
	});

	if (dbg.active) {
		cmds.push(
			{
				id: "dbg-run",
				title: "Debug: Run",
				hint: "F9",
				menu: MENU.run,
				section: "Debug",
				run: () => void dbg.run("continue"),
			},
			{
				id: "dbg-pause",
				title: "Debug: Pause",
				menu: MENU.run,
				section: "Debug",
				run: () => void dbg.run("interrupt"),
			},
			{
				id: "dbg-into",
				title: "Debug: Step into",
				hint: "F7",
				menu: MENU.run,
				section: "Debug",
				run: () => void dbg.run("step", { kind: "into" }),
			},
			{
				id: "dbg-over",
				title: "Debug: Step over",
				hint: "F8",
				menu: MENU.run,
				section: "Debug",
				run: () => void dbg.run("step", { kind: "over" }),
			},
			{
				id: "dbg-out",
				title: "Debug: Step out",
				menu: MENU.run,
				section: "Debug",
				run: () => void dbg.run("step", { kind: "out" }),
			},
			{
				id: "dbg-detach",
				title: "Debug: Detach",
				menu: MENU.run,
				section: "Debug",
				run: () => void dbg.run("detach"),
			},
		);
	}

	return cmds;
}

/**
 * Resolve a typed address or symbol and select the function containing it.
 *
 * ```
 * gotoQuery("0x1000")  // asks the engine which function holds that address
 * ```
 *
 * @param query - What was typed: an address, a number, or part of a name.
 */
export function gotoQuery(query: string): void {
	const q = query.trim();
	if (!q) return;
	const addr = /^0x[0-9a-f]+$/i.test(q)
		? Number.parseInt(q.slice(2), 16)
		: /^\d+$/.test(q)
			? Number.parseInt(q, 10)
			: null;
	const analysis = useAnalysisStore.getState();
	if (addr != null) {
		api.functionAt(addr)
			.then((f) => {
				if (f) analysis.selectFn(f);
				else useUiStore.getState().setTab("disasm");
			})
			.catch(() => {});
		return;
	}
	// A symbol: the analysis engine resolves names through the same store path
	// the agent uses, so a function whose name matches is enough.
	const match = analysis.funcs.find(
		(f) =>
			(f.name ?? "").toLowerCase() === q.toLowerCase() ||
			(f.name ?? "").toLowerCase().includes(q.toLowerCase()),
	);
	if (match) analysis.selectFn(match);
}

/** What the palette lists: a command, or a function to jump to. */
export type Entry =
	{ kind: "command"; command: Command } | { kind: "function"; fn: Function };
