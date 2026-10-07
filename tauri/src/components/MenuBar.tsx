import { House } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { WindowControls } from "@/components/WindowControls";
import { buildCommands, MENU, MENU_ORDER, type MenuName } from "@/lib/commands";
import { chrome } from "@/lib/chrome";
import { useProjectStore } from "@/store/projectStore";
import { useUpdateStore } from "@/store/updateStore";
import {
	groupSections,
	readSections,
	sectionsFor,
	type MenuItem,
} from "@/lib/menuRegistry";

/**
 * The rows of one menu.
 *
 * Read when the menu opens rather than when the bar renders: a dropdown's content
 * is only mounted while it is open, and the commands answer to what is open right
 * now, so a bar that resolved them once at mount would offer a project that was
 * closed an hour ago.
 */
function MenuRows({ menu }: { menu: MenuName }) {
	const rows = groupSections(
		sectionsFor(menu, buildCommands(), readSections(menu)),
	);
	if (rows.length === 0) {
		return <DropdownMenuItem disabled>Nothing here yet</DropdownMenuItem>;
	}
	return (
		<>
			{rows.map((row, i) => {
				if (row.kind === "label") {
					return (
						<DropdownMenuLabel key={`label-${row.label}-${i}`}>
							{row.label}
						</DropdownMenuLabel>
					);
				}
				if (row.kind === "rule") {
					return <DropdownMenuSeparator key={`rule-${i}`} />;
				}
				// Keyed by position as well as name: a menu draws from two sources —
				// the command list and whatever a panel published — and two rows with
				// the same name are two rows React would rather merge into one.
				return <Row key={`${row.item.id}-${i}`} item={row.item} />;
			})}
		</>
	);
}

/** One menu item, with a tick for the items that show a mode rather than do a thing. */
function Row({ item }: { item: MenuItem }) {
	return (
		<DropdownMenuItem
			disabled={item.disabled}
			onSelect={item.run}
			className={item.checked === undefined ? undefined : "pl-7"}
		>
			<span
				aria-hidden
				className="text-brand -ml-5 w-4 shrink-0 text-center"
			>
				{item.checked ? "✓" : ""}
			</span>
			<span className="truncate">{item.label}</span>
			{item.hint && (
				<DropdownMenuShortcut className="ml-auto">
					{item.hint}
				</DropdownMenuShortcut>
			)}
		</DropdownMenuItem>
	);
}

/**
 * How long the pointer may be off a menu before the menu closes.
 *
 * The dropdown is a few pixels below its trigger, so moving the pointer from the
 * word to the menu crosses that gap and is briefly over neither. Without a pause
 * the menu shuts in the reader's hand on the way to the item they aimed at.
 */
const CLOSE_GRACE_MS = 150;

/** One menu and its trigger. */
function Menu({
	menu,
	open,
	hovered,
	onHover,
	onOpen,
}: {
	menu: MenuName;
	/** Which menu is showing, if any. */
	open: MenuName | null;
	/** Whether the open menu was opened by the pointer rather than by a click. */
	hovered: boolean;
	/** The pointer reached this trigger, or left it. */
	onHover: (menu: MenuName, over: boolean) => void;
	/** A click, a key, or a dismissal asked for this menu to open or close. */
	onOpen: (menu: MenuName | null) => void;
}) {
	// Primitive selectors only. A fresh object here fails React's getSnapshot
	// cache check and re-renders forever. Non-Settings menus select null, so a
	// download does not repaint the rest of the bar.
	const updateStatus = useUpdateStore((s) =>
		menu === MENU.settings ? s.status : null,
	);
	const updateProgress = useUpdateStore((s) =>
		menu === MENU.settings ? s.progress : null,
	);
	const updateVersion = useUpdateStore((s) =>
		menu === MENU.settings ? s.availableVersion : null,
	);
	const updateAvailable = updateStatus === "available";
	return (
		<DropdownMenu
			// Not modal: a modal menu takes the pointer events away from the rest of
			// the document, which would leave the other triggers unhoverable and so
			// unable to take over from an open menu the way a menu bar is supposed to.
			modal={false}
			open={open === menu}
			onOpenChange={(next) => {
				if (next) {
					onOpen(menu);
					return;
				}
				// A close for a menu that is no longer the open one is the outgoing
				// half of a switch, not a dismissal. Acting on it closes the menu that
				// just replaced it, which is why sliding along the bar opened nothing.
				if (open === menu) onOpen(null);
			}}
		>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					className={chrome.menuItem}
					title={
						updateAvailable
							? `Update available: v${updateVersion}`
							: updateStatus === "downloading"
								? updateProgress != null
									? `Downloading update… ${updateProgress}%`
									: "Downloading update…"
								: undefined
					}
					onPointerEnter={() => onHover(menu, true)}
					onPointerLeave={() => onHover(menu, false)}
				>
					{menu}
					{updateAvailable && (
						<span
							className="bg-primary inline-block h-1.5 w-1.5 rounded-full"
							aria-label="Update available"
						/>
					)}
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="start"
				className="w-64"
				onCloseAutoFocus={(event) => {
					// Focus belongs to whichever menu is open now. Handing it back to
					// this menu's trigger when another menu has just taken its place
					// pulls focus out of that new menu, and Radix closes a menu whose
					// content loses focus — which is why sliding along the bar opened
					// nothing. A menu closing on its own still gets its focus back.
					if (open !== null && open !== menu) event.preventDefault();
				}}
				onPointerEnter={() => hovered && onHover(menu, true)}
				onPointerLeave={() => hovered && onHover(menu, false)}
			>
				<MenuRows menu={menu} />
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/**
 * The menu bar across the top of the window.
 *
 * Every command the app has is reachable from here, so the panels below it do not
 * each need a button for their own: a disassembly that offers "Reload" offers it
 * here too, and its toolbar is left holding only what is specific to the thing on
 * screen.
 *
 * A menu with nothing in it is not rendered. `Selection`, `Terminal` and `Help`
 * are absent because nothing is behind them yet, and will appear the moment
 * something is — a header that opens onto an empty panel is worse than no header,
 * because it claims there is nothing here and is right.
 *
 * @example
 * <MenuBar />
 */
export function MenuBar() {
	const commands = buildCommands();
	const menus = MENU_ORDER.filter(
		(menu) => sectionsFor(menu, commands, readSections(menu)).length > 0,
	);
	const project = useProjectStore((s) => s.current);
	const closeProject = useProjectStore((s) => s.close);
	const [open, setOpen] = useState<MenuName | null>(null);
	const [hovered, setHovered] = useState(false);
	// The pointer's way out of a menu, held back by the grace pause and cancelled
	// the moment it comes back — which it will, on the way from the trigger's
	// label down to the item under it.
	const leave = useRef<ReturnType<typeof setTimeout> | null>(null);

	const cancelLeave = () => {
		if (leave.current === null) return;
		clearTimeout(leave.current);
		leave.current = null;
	};

	useEffect(() => cancelLeave, []);

	/**
	 * Open this menu because the pointer is on it, or let it go because the pointer
	 * has left.
	 *
	 * @param menu - The menu the pointer moved onto or off.
	 * @param over - Whether the pointer is on its trigger or its dropdown.
	 */
	const onHover = (menu: MenuName, over: boolean) => {
		if (over) {
			cancelLeave();
			// Sliding along the bar swaps menus without a second pause, which is what
			// makes a menu bar worth aiming at rather than clicking through.
			if (hovered) setOpen(menu);
			else {
				setHovered(true);
				setOpen(menu);
			}
			return;
		}
		if (!hovered || leave.current !== null) return;
		leave.current = setTimeout(() => {
			leave.current = null;
			setOpen(null);
			setHovered(false);
		}, CLOSE_GRACE_MS);
	};

	if (menus.length === 0) return null;
	return (
		<div className={chrome.menuBar} role="menubar" aria-label="Main menu">
			{/* Back to the projects, in the bar rather than in a menu: it is the way
			    out of whatever is open, and the reader who wants it has usually not
			    decided which menu holds it. Only while there is something to go back
			    from — with no project open, the project list is already the screen. */}
			{project && (
				<>
					<button
						type="button"
						className={chrome.menuItem}
						title="Back to projects"
						onClick={() => void closeProject()}
					>
						<House aria-hidden className="h-3 w-3" />
						Home
					</button>
					<span className={chrome.menuDivider} aria-hidden="true" />
				</>
			)}
			{menus.map((menu) => (
				<Menu
					key={menu}
					menu={menu}
					open={open}
					hovered={hovered}
					onHover={onHover}
					// A click or a key opens a menu that stays put: only the pointer
					// closes a menu the pointer opened, so a menu opened from the
					// keyboard does not vanish when the mouse is elsewhere.
					onOpen={(next) => {
						cancelLeave();
						setHovered(false);
						setOpen(next);
					}}
				/>
			))}
			{/* The empty half of the bar drags the window, so the bar behaves like
			    the title bar it replaced. */}
			<div data-tauri-drag-region className="flex-1" />
			<WindowControls />
		</div>
	);
}
