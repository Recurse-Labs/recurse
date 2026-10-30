import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties, KeyboardEvent } from "react";

/** One action in a context menu. */
export interface ContextMenuAction {
	label: string;
	run: () => void;
	/** Shown but not selectable when the session cannot do it right now. */
	disabled?: boolean;
	/** Draw a rule above this action, grouping it with what follows. */
	separatorBefore?: boolean;
}

/** The rectangle a menu must stay inside, in viewport coordinates. */
export interface ContextMenuBounds {
	left: number;
	right: number;
	top: number;
	bottom: number;
}

/** The row a menu is attached to, in viewport coordinates. */
export interface ContextMenuAnchor {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

/** Space between the menu and the edge of its bounds, in pixels. */
const EDGE = 4;

/** Widest a menu is allowed to be, so the left clamp leaves it on screen. */
const MAX_WIDTH = 200;

/**
 * The menu a right-click opens over a listing selection or a debugger row.
 *
 * Positioned at the pointer but clamped to the window, so a click near an edge
 * opens the menu inward instead of off-screen. It closes itself on the next
 * click or key anywhere, the way a native menu does, so the listing does not
 * have to track it.
 *
 * Rendered in a portal on `document.body`, not in the pane that opened it: a
 * menu inside a scroll container is clipped by that container's overflow and
 * loses the stacking fight with sibling bars, no matter how high its own
 * `z-index` is.
 *
 * The first enabled action takes focus when the menu opens, and the arrow keys
 * walk the list, so the menu is usable without reaching back to the pointer.
 *
 * @param props.x - The pointer's viewport x.
 * @param props.y - The pointer's viewport y.
 * @param props.heading - An optional non-interactive line above the actions,
 *   naming what they apply to.
 * @param props.bounds - The pane used to keep the menu horizontally inside.
 *   The menu is allowed to overlay neighboring panes vertically: it is
 *   temporary, and a scrollbar inside a context menu is worse than covering
 *   the call stack for the moment it is open.
 * @param props.anchor - The row the menu was opened on. When given, the menu is
 *   attached to it instead of the pointer.
 * @param props.placement - Whether to open below or above the anchor row.
 * @param props.actions - The actions to offer, in order.
 * @param props.onClose - Called when the menu should go away.
 * @returns The menu element.
 *
 * @example
 * <ListingContextMenu
 *   x={120}
 *   y={80}
 *   actions={[{ label: "Set breakpoint", run: () => setBreak() }]}
 *   onClose={() => setMenu(null)}
 * />
 */
export function ListingContextMenu({
	x,
	y,
	heading,
	bounds,
	anchor,
	placement = "below",
	actions,
	onClose,
}: {
	x: number;
	y: number;
	heading?: string;
	bounds?: ContextMenuBounds;
	anchor?: ContextMenuAnchor;
	placement?: "above" | "below";
	actions: ContextMenuAction[];
	onClose: () => void;
}) {
	const menuRef = useRef<HTMLDivElement>(null);

	const leftEdge = (bounds?.left ?? 0) + EDGE;
	const rightEdge = (bounds?.right ?? window.innerWidth) - EDGE;
	// Attached to the row's left edge when there is one: a menu that lands
	// wherever the pointer happened to be can look detached from the row it is
	// about to change.
	const style: CSSProperties = {
		left: Math.max(
			leftEdge,
			Math.min(anchor?.left ?? x, rightEdge - MAX_WIDTH),
		),
		maxWidth: rightEdge - leftEdge,
	};
	if (anchor) {
		if (placement === "above") {
			// Anchored by its bottom so the menu grows upward from the row.
			style.bottom = window.innerHeight - anchor.top + EDGE;
		} else {
			style.top = anchor.bottom + EDGE;
		}
	} else {
		style.top = y;
	}

	// A menu that opened from a right-click should still be reachable from the
	// keyboard, but it must not start with an item highlighted: the pointer is
	// sitting over the menu, and an auto-focused first row plus the row under
	// the pointer reads as two selections at once. Focus the menu itself; the
	// arrow keys move into the list when the analyst asks.
	useEffect(() => {
		menuRef.current?.focus({ preventScroll: true });
	}, []);

	useEffect(() => {
		const close = () => onClose();
		window.addEventListener("click", close);
		window.addEventListener("keydown", close);
		return () => {
			window.removeEventListener("click", close);
			window.removeEventListener("keydown", close);
		};
	}, [onClose]);

	/**
	 * Arrow keys move between enabled actions; Escape closes the menu.
	 *
	 * The handled keys stop propagating so the window listener above does not
	 * also treat them as a dismissal.
	 *
	 * @param event - The key press, from anywhere inside the menu.
	 */
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			onClose();
			return;
		}
		if (
			event.key !== "ArrowDown" &&
			event.key !== "ArrowUp" &&
			event.key !== "Home" &&
			event.key !== "End"
		) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		const items = [
			...(menuRef.current?.querySelectorAll<HTMLButtonElement>(
				"button:not([disabled])",
			) ?? []),
		];
		if (items.length === 0) return;
		const current = items.indexOf(
			document.activeElement as HTMLButtonElement,
		);
		let next = 0;
		if (event.key === "ArrowDown") {
			next = current < 0 ? 0 : (current + 1) % items.length;
		} else if (event.key === "ArrowUp") {
			next = current <= 0 ? items.length - 1 : current - 1;
		} else if (event.key === "End") {
			next = items.length - 1;
		}
		items[next]?.focus();
	};

	return createPortal(
		<div
			ref={menuRef}
			role="menu"
			aria-label="Options"
			tabIndex={-1}
			className="border-border bg-popover text-popover-foreground fixed z-50 min-w-32 rounded-md border p-1 shadow-xl outline-none"
			style={style}
			onKeyDown={onKeyDown}
			onClick={(event) => event.stopPropagation()}
		>
			{heading && (
				<div className="text-muted-foreground text-2xs px-2 py-1 font-mono select-none">
					{heading}
				</div>
			)}
			{actions.map((action, i) => (
				<div key={`${action.label}-${i}`}>
					{action.separatorBefore && (
						<div
							role="separator"
							className="bg-border my-0.5 h-px"
						/>
					)}
					<button
						type="button"
						role="menuitem"
						disabled={action.disabled}
						className="hover:bg-accent focus:bg-accent focus:text-accent-foreground flex w-full items-center rounded-sm px-2 py-1 text-left text-xs whitespace-nowrap outline-none disabled:pointer-events-none disabled:opacity-50"
						onClick={() => {
							action.run();
							onClose();
						}}
					>
						{action.label}
					</button>
				</div>
			))}
		</div>,
		document.body,
	);
}
