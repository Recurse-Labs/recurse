import { memo } from "react";

import { FunctionHeader } from "@/components/FunctionHeader";
import { DisasmComment, DisasmInstr, splitComment } from "@/lib/disasm";
import { fmtAddr, groupBytes } from "@/lib/listingFormat";
import { cn } from "@/lib/utils";
import type { Function, ListingRow } from "@/types";

/**
 * One row of the listing: a section header, a disassembled instruction, or a
 * run of data bytes.
 *
 * The row is a fixed height by construction, which is what lets the window
 * place it from a single estimate with no runtime measurement: a listed
 * instruction is one line, whose bytes grow the byte column to the right
 * instead of wrapping onto a second line. A variable height would make the
 * measured size disagree with the estimate, and each disagreement shifts every
 * row below the measured one while the analyst is scrolling.
 *
 * The row does not handle its own clicks: the listing delegates them from the
 * scroll surface, so a row stays a pure function of its props and a drag that
 * crosses a hundred of them re-renders none.
 *
 * @param props.row - The row to render.
 * @param props.func - Name of the function starting at this row, if any.
 * @param props.selected - Whether this row is part of the selection.
 * @param props.cursor - Whether this row is the selection's caret.
 * @param props.onGoTo - Called when a named function row is activated.
 * @returns The row element.
 */
export const ListingRowView = memo(function ListingRowView({
	row,
	func,
	selected,
	cursor,
	onGoTo,
}: {
	row: ListingRow;
	func?: Function | null;
	selected: boolean;
	cursor: boolean;
	onGoTo?: (f: Function) => void;
}) {
	if (row.kind === "header") {
		return (
			<div className="border-border bg-muted/40 text-asm-number flex h-[18px] items-center border-y px-3 font-mono text-[11px] font-semibold">
				{row.label ?? "section"}
			</div>
		);
	}

	const text = row.text ?? "";
	const { instr, comment } =
		row.kind === "code" ? splitComment(text) : { instr: "", comment: "" };

	return (
		<>
			{/* A function opens a region of the listing, marked the way Ghidra
			    marks it: blank space, the boxed FUNCTION banner, the signature
			    and its parameter/local storage, then the code. All as `;`
			    comments, so it reads as a header and not as either a section
			    band or an instruction. */}
			{func && <FunctionHeader func={func} onGoTo={onGoTo} />}
			<div
				className={cn(
					"flex h-[18px] min-w-max items-center gap-3 py-px pl-3 font-mono whitespace-nowrap",
					selected && "ui-selected",
					cursor && "border-brand border-l-2 pl-[10px]",
					"hover:bg-accent/70 cursor-pointer",
				)}
				title={
					row.kind === "code" ? "Select instruction" : "Select data"
				}
			>
				<span className="text-asm-addr w-[19ch] shrink-0">
					{fmtAddr(row.addr)}
				</span>
				{/* `min-w` keeps every instruction column aligned, while a long
				    instruction's bytes widen only this row rather than pushing
				    the instruction to a different x on every other row. */}
				<span className="text-asm-bytes min-w-[26ch] shrink-0 pr-3">
					{groupBytes(row.bytes)}
				</span>
				{row.kind === "code" ? (
					<span className="text-foreground">
						<DisasmInstr text={instr} />
						<DisasmComment comment={comment} />
						{typeof row.jump === "number" && (
							<span className="text-asm-jump">
								{" "}
								→ {fmtAddr(row.jump)}
							</span>
						)}
					</span>
				) : (
					<span className="text-asm-string">{text}</span>
				)}
			</div>
		</>
	);
});

/**
 * One virtualized slot of the listing: the absolutely positioned box the
 * virtualizer moves, holding either a loaded row or a placeholder for one whose
 * chunk has not arrived.
 *
 * The slot carries `data-index`, which is how the listing's delegated click,
 * drag and context-menu handlers find the row a pointer is over without a
 * handler on every row.
 *
 * @param props.index - The row's position in the whole listing.
 * @param props.row - The row, once its chunk has loaded.
 * @param props.func - The function starting at this row, if any.
 * @param props.selected - Whether the row is part of the selection.
 * @param props.cursor - Whether the row is the selection's caret.
 * @param props.measure - The virtualizer's element-measuring ref.
 * @param props.onGoTo - Called when a named function row is activated.
 * @returns The positioned slot.
 */
export function ListingRowSlot({
	index,
	row,
	func,
	selected,
	cursor,
	measure,
	onGoTo,
}: {
	index: number;
	row?: ListingRow;
	func?: Function | null;
	selected: boolean;
	cursor: boolean;
	measure: (node: HTMLDivElement | null) => void;
	onGoTo?: (f: Function) => void;
}) {
	return (
		<div
			data-index={index}
			ref={measure}
			style={{
				position: "absolute",
				insetBlockStart: 0,
				insetInlineStart: 0,
				width: "100%",
				// No `transform`: `directDomUpdates` writes each row's position
				// itself, and an inline transform here would be overwritten on
				// the next render.
			}}
		>
			{row ? (
				<ListingRowView
					row={row}
					func={func}
					selected={selected}
					cursor={cursor}
					onGoTo={onGoTo}
				/>
			) : (
				<div className="data-row text-muted-foreground pl-3 font-mono">
					…
				</div>
			)}
		</div>
	);
}
