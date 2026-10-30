import { useCallback, useMemo, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";

import {
	ListingContextMenu,
	type ContextMenuAction,
	type ContextMenuAnchor,
	type ContextMenuBounds,
} from "@/components/ListingContextMenu";
import type { DisasmRow } from "@/lib/debugDisasm";
import { isLiveState, useDebugStore } from "@/store/debugStore";

/** A right-click that opened the menu, and the instruction under it. */
interface OpenMenu {
	x: number;
	y: number;
	row: DisasmRow;
	anchor: ContextMenuAnchor;
	placement: "above" | "below";
	/** The disassembly pane, so the menu can stay inside it. */
	bounds?: ContextMenuBounds;
}

/** Approximate height of the menu, for choosing a side of the row. */
const MENU_HEIGHT = 176;

/** How an address is written in the menu header. */
function fmtAddr(addr: number): string {
	return `0x${addr.toString(16)}`;
}

/**
 * The register that is the program counter for this architecture.
 *
 * x86 names it `rip`; the aarch64 backend exposes the same value as `pc`. The
 * debugger's normalized `registers.pc` is not necessarily a name the backend's
 * `setreg` accepts, so the live register set decides.
 *
 * @param values - The live register values, if there are any.
 * @returns The register name to pass to `setreg`.
 *
 * @example
 * pcRegister({ rip: 0x401000 }) // => "rip"
 * pcRegister({ pc: 0x401000 })  // => "pc"
 * pcRegister(undefined)         // => "pc"
 */
function pcRegister(values: Record<string, number> | undefined): string {
	return values && "rip" in values ? "rip" : "pc";
}

/**
 * The right-click menu for an instruction in the CPU view.
 *
 * The actions are the ones that make sense on a *row*: set or clear its
 * breakpoint, run to it, move the program counter to it, and copy what it
 * says. Commands that are not available — running to the instruction the pc is
 * already on, or changing the pc while the target is running — stay visible and
 * disabled, so the menu keeps its shape and says why it cannot act.
 *
 * @returns An opener to call from a row's `onContextMenu`, the row the menu is
 * acting on, and the menu element.
 *
 * @example
 * const { openMenu, menu, target } = useDebugCpuMenu();
 * <tr onContextMenu={(event) => openMenu(event, row)}>…</tr>
 * {menu}
 */
export function useDebugCpuMenu() {
	const [open, setOpen] = useState<OpenMenu | null>(null);
	const run = useDebugStore((s) => s.run);
	const runTo = useDebugStore((s) => s.runTo);
	const breakpoints = useDebugStore((s) => s.breakpoints);
	const busy = useDebugStore((s) => s.busy);
	const live = isLiveState(useDebugStore((s) => s.state));
	const pc = useDebugStore((s) => s.registers?.pc ?? null);
	const registerValues = useDebugStore((s) => s.registers?.values);

	/**
	 * Open the menu where the pointer is, for the row it is over.
	 *
	 * @param event - The browser's context-menu event.
	 * @param row - The instruction that was right-clicked.
	 */
	const openMenu = useCallback((event: ReactMouseEvent, row: DisasmRow) => {
		event.preventDefault();
		const rowRect = (
			event.currentTarget as HTMLElement
		).getBoundingClientRect();
		const pane = (event.currentTarget as HTMLElement).closest<HTMLElement>(
			"[data-menu-boundary]",
		);
		const rect = pane?.getBoundingClientRect();
		const bounds = rect
			? {
					left: rect.left,
					right: rect.right,
					top: rect.top,
					bottom: rect.bottom,
				}
			: undefined;
		// Open on the side of the row with room for the menu. The row nearest
		// the bottom of the disassembly pane gets a menu above it, so the menu
		// never hangs over the call-stack tabs or the output pane.
		const below = (bounds?.bottom ?? window.innerHeight) - rowRect.bottom;
		const above = rowRect.top - (bounds?.top ?? 0);
		setOpen({
			x: event.clientX,
			y: event.clientY,
			row,
			bounds,
			anchor: {
				left: rowRect.left,
				top: rowRect.top,
				right: rowRect.right,
				bottom: rowRect.bottom,
			},
			placement: below < MENU_HEIGHT && above > below ? "above" : "below",
		});
	}, []);

	const closeMenu = useCallback(() => setOpen(null), []);

	const actions = useMemo<ContextMenuAction[]>(() => {
		if (!open) return [];
		const { row } = open;
		const breakpoint = breakpoints.find((b) => b.addr === row.addr);
		const here = pc === row.addr;
		const unavailable = !live || busy;
		return [
			{
				label: breakpoint ? "Remove breakpoint" : "Set breakpoint",
				disabled: busy,
				run: () => {
					if (breakpoint) {
						void run("unbreak", { id: breakpoint.id });
					} else {
						void run("break", { addr: row.addr });
					}
				},
			},
			{
				label: "Run to here",
				disabled: unavailable || here,
				run: () => void runTo(row.addr),
			},
			{
				label: "Set PC here",
				separatorBefore: true,
				disabled: unavailable,
				run: () =>
					void run("setreg", {
						name: pcRegister(registerValues),
						value: `0x${row.addr.toString(16)}`,
					}),
			},
			{
				label: "Copy address",
				separatorBefore: true,
				run: () =>
					void navigator.clipboard?.writeText(fmtAddr(row.addr)),
			},
			{
				label: "Copy instruction",
				run: () => void navigator.clipboard?.writeText(row.insn.text),
			},
		];
	}, [open, breakpoints, busy, live, pc, registerValues, run, runTo]);

	return {
		openMenu,
		target: open?.row ?? null,
		menu: open ? (
			<ListingContextMenu
				x={open.x}
				y={open.y}
				heading={fmtAddr(open.row.addr)}
				bounds={open.bounds}
				anchor={open.anchor}
				placement={open.placement}
				actions={actions}
				onClose={closeMenu}
			/>
		) : null,
	};
}
