/**
 * Where a panel says what its menus contain.
 *
 * A panel in the middle of the window knows which function is selected and which
 * of its tools are busy; the bar at the top of the window is where those commands
 * belong. Something has to carry the answer between them, and the honest shape of
 * that is a question asked at the moment the menu opens rather than state pushed
 * on every keystroke: a menu is not on screen until it is opened, so a command
 * that changed five times since the last open does not need five renders.
 *
 * That is also why this is a module rather than a store. A store would have to be
 * written from an effect, which is a second render triggered by nothing the
 * analyst did, and read during render, which is how a menu ends up offering a
 * stale command.
 */

/** One entry in a menu. */
export interface MenuItem {
	/** Stable name, so a keyed list does not remount on every open. */
	id: string;
	label: string;
	/** The keyboard shortcut to show at the right, when there is one. */
	hint?: string;
	run: () => void;
	/** Why it cannot be run right now, or that it can. */
	disabled?: boolean;
	/** Set for an item that shows a mode rather than doing a thing. */
	checked?: boolean;
}

/** A heading and the items under it, as an editor's menus are laid out. */
export interface MenuSection {
	/** The heading, e.g. "Actions". Empty for a group with no heading. */
	label: string;
	items: MenuItem[];
}

/**
 * What the shared command list has to say for a menu to be built out of it.
 *
 * Structural rather than the command type itself, so this module does not have to
 * know where the commands come from — only that each one says which menu it
 * belongs under and which heading it sits beneath.
 */
export interface MenuCommand {
	id: string;
	title: string;
	/** Wording for the menu when it differs from the palette's `title`. */
	menuTitle?: string;
	hint?: string;
	run: () => void;
	/** Set for a command that shows a state rather than doing a thing. */
	checked?: boolean;
	/** Set while the action cannot be run, so the menu greys it out. */
	disabled?: boolean;
	/** The menu this command sits under. */
	menu: string;
	/** The heading it sits under inside that menu. */
	section: string;
}

/**
 * What each menu was last told it contains, by menu name.
 *
 * Keyed by menu because a panel's commands belong to one menu: a disassembly
 * offering "Decompile" has said so about the View menu, and appending it to
 * everything is how File and Go end up listing a section of a panel that has
 * nothing to do with either.
 */
let published = new Map<string, MenuSection[]>();

/**
 * Say what a panel's menus contain, replacing whatever it said last.
 *
 * A panel publishes as often as its own state changes; the bar reads only when a
 * menu opens, so the cost of publishing on every change is a field assignment and
 * the cost of not publishing is a menu offering a command that would fail.
 *
 * ```
 * publishSections("View", [{ label: "Actions", items: [{ id: "reload", label: "Reload", run }] }]);
 * readSections("View").length // => 1
 * readSections("Go").length   // => 0 — those commands are not the Go menu's
 * clearSections();
 * readSections("View").length // => 0
 * ```
 *
 * @param menu - The menu these sections belong under.
 * @param sections - The sections, in the order they should be shown.
 */
export function publishSections(menu: string, sections: MenuSection[]): void {
	published.set(menu, sections);
}

/**
 * Withdraw a panel's sections, so its commands stop being offered.
 *
 * Called when a panel unmounts: a menu that still offered "Decompile" after the
 * disassembly closed would be a menu offering to do something with nothing.
 */
export function clearSections(): void {
	published = new Map();
}

/**
 * What was published for one menu, in the order it was published.
 *
 * @param menu - The menu being built.
 * @returns Its sections, or an empty list when nothing has published to it.
 */
export function readSections(menu: string): MenuSection[] {
	return published.get(menu) ?? [];
}

/**
 * Gather the commands for one menu into the sections that menu shows them under.
 *
 * A command's own `section` is what groups it, so a menu and the list a command
 * belongs in cannot disagree: there is one field saying "this is an Appearance
 * command" and both read it.
 *
 * `published` is whatever a panel offered *to this menu*, and nothing else. It
 * goes last, because the window's own appearance is what a reader opened the menu
 * for and a panel's commands are the specific ones.
 *
 * @example
 * sectionsFor("View", [{ id: "theme", title: "Dark", run, menu: "View", section: "Appearance" }], [])
 * // => [{ label: "Appearance", items: [{ id: "theme", label: "Dark", run }] }]
 *
 * @param menu - The menu being built.
 * @param commands - Every command the app has.
 * @param published - What a panel has offered to this menu, and only this menu.
 * @returns The sections, in the order they should be rendered.
 */
export function sectionsFor(
	menu: string,
	commands: MenuCommand[],
	published: MenuSection[],
): MenuSection[] {
	const sections: MenuSection[] = [];
	for (const command of commands) {
		if (command.menu !== menu) continue;
		const item: MenuItem = {
			id: command.id,
			label: command.menuTitle ?? command.title,
			...(command.hint ? { hint: command.hint } : {}),
			...(command.checked === undefined
				? {}
				: { checked: command.checked }),
			...(command.disabled ? { disabled: true } : {}),
			run: command.run,
		};
		const last = sections[sections.length - 1];
		if (last && last.label === command.section) last.items.push(item);
		else sections.push({ label: command.section, items: [item] });
	}
	return [...sections, ...published];
}

/**
 * A menu flattened into the rows it is drawn from: headings, rules and items.
 *
 * Every row is tagged, so a renderer asks what a row is rather than guessing from
 * which fields it happens to have — an item and a heading both carry a label, and
 * only one of them is something you can click.
 */
export type MenuRow =
	| { kind: "label"; label: string }
	| { kind: "rule" }
	| { kind: "item"; item: MenuItem };

/**
 * Lay sections out as a menu shows them: a heading above each group, and a rule
 * after it so the items under a heading are visibly their own group.
 *
 * ```
 * groupSections([{ label: "Actions", items: [{ id: "a", label: "One", run }] }])
 * // => a "label" row reading "Actions", a "rule", then the item
 * ```
 *
 * @param sections - The sections to lay out.
 * @returns A flat list of rows, in the order they should be rendered.
 */
export function groupSections(sections: MenuSection[]): MenuRow[] {
	const rows: MenuRow[] = [];
	sections.forEach((section, i) => {
		if (section.label) {
			rows.push({ kind: "label", label: section.label });
			rows.push({ kind: "rule" });
		} else if (i > 0) {
			rows.push({ kind: "rule" });
		}
		for (const item of section.items) rows.push({ kind: "item", item });
	});
	return rows;
}
