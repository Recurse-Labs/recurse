import { beforeEach, describe, expect, it } from "vitest";

import { buildCommands, MENU, MENU_ORDER } from "./commands";
import {
	clearSections,
	publishSections,
	readSections,
	sectionsFor,
} from "./menuRegistry";
import { THEMES } from "./themes";

describe("the menus", () => {
	beforeEach(() => {
		clearSections();
	});

	/**
	 * The commands a menu holds, from the app's own list and whatever a panel has
	 * published to it.
	 *
	 * @param menu - The menu to build.
	 * @returns Its item names, in order.
	 */
	const itemsOf = (menu: string): string[] =>
		sectionsFor(menu, buildCommands(), readSections(menu))
			.flatMap((section) => section.items)
			.map((item) => item.id);

	it("name a menu that exists", () => {
		// A command filed under a menu name nothing renders is a command that has
		// quietly disappeared, and a typo is the only thing that would do it.
		for (const command of buildCommands()) {
			expect(MENU_ORDER, command.id).toContain(command.menu);
		}
	});

	it("put an option in one menu, not several", () => {
		const homes = new Map<string, Set<string>>();
		for (const command of buildCommands()) {
			const seen = homes.get(command.id) ?? new Set<string>();
			seen.add(command.menu);
			homes.set(command.id, seen);
		}
		for (const [id, menus] of homes) {
			expect([...menus], id).toHaveLength(1);
		}
	});

	it("keep the settings where a reader looks for them by name", () => {
		const settings = itemsOf(MENU.settings);
		expect(settings).toContain("model-picker");
		expect(settings).toContain("debugger-settings");
		expect(settings).toContain("check-updates");
	});

	it("do not file a setting under File as well", () => {
		// Having to know that the debugger's settings live under File ▸ Settings is
		// the kind of thing you only know once.
		expect(itemsOf(MENU.file)).not.toContain("debugger-settings");
		expect(itemsOf(MENU.file)).not.toContain("model-picker");
	});

	it("put the analysis engine under Settings, not under View", () => {
		// An engine is a choice about how the work is done, not a switch that changes
		// what is on screen, so it belongs with the other settings.
		expect(itemsOf(MENU.settings)).toContain("engine-native");
		expect(itemsOf(MENU.view)).not.toContain("engine-native");
	});

	it("hold the themes and the zoom in Appearance, and nothing else", () => {
		// A menu holding ten themes and three zoom steps does not belong under a
		// heading about panels and disassembly. Splitting it out costs one menu and
		// leaves both halves saying what they are.
		const appearance = itemsOf(MENU.appearance);
		expect(appearance).toContain("theme-recurse-dark");
		expect(appearance).toContain("theme-dracula");
		expect(appearance).toContain("zoom-in");
		expect(appearance).toContain("zoom-reset");
		expect(appearance).toHaveLength(THEMES.length + 3);
		for (const id of appearance)
			expect(itemsOf(MENU.view)).not.toContain(id);
	});

	it("offer no second route to the chat or the light/dark toggle", () => {
		// The chat has a button in the activity bar and Ctrl+L; a menu entry for
		// it is a second route to one place, which is a second thing to keep
		// straight. The light/dark switch is now one of the named themes.
		for (const menu of MENU_ORDER) {
			expect(itemsOf(menu), menu).not.toContain("chat");
			expect(itemsOf(menu), menu).not.toContain("toggle-theme");
		}
	});

	it("leave View to whatever a panel publishes to it", () => {
		// View has no commands of its own. It still appears in the bar when a
		// panel offers it something, and is dropped when nothing has — an empty
		// menu that opens onto a blank panel is worse than no menu.
		expect(itemsOf(MENU.view)).toEqual([]);
		publishSections(MENU.view, [
			{
				label: "Actions",
				items: [{ id: "decompile", label: "Decompile", run: () => {} }],
			},
		]);
		expect(itemsOf(MENU.view)).toContain("decompile");
	});

	it("order Appearance right after View, so the two read together", () => {
		expect(MENU_ORDER.indexOf(MENU.appearance)).toBe(
			MENU_ORDER.indexOf(MENU.view) + 1,
		);
	});

	it("leave a panel's sections to the one menu that asked for them", () => {
		publishSections(MENU.view, [
			{
				label: "Actions",
				items: [{ id: "decompile", label: "Decompile", run: () => {} }],
			},
		]);
		for (const menu of MENU_ORDER) {
			expect(itemsOf(menu).includes("decompile"), menu).toBe(
				menu === MENU.view,
			);
		}
	});
});
