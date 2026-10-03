import { memo } from "react";

import { FunctionHeader } from "@/components/listing/FunctionHeader";
import { FlowCell } from "@/components/listing/FlowGutter";
import { DisasmComment, DisasmInstr, splitComment } from "@/lib/disasm";
import { flowMarker } from "@/lib/flowMarker";
import { fmtAddr, groupBytes } from "@/lib/listingFormat";
import { cn } from "@/lib/utils";
import type { Function, ListingRow } from "@/types";

/**
 * One row of the listing: a section header, a disassembled instruction, or a
 * run of data bytes. A row that starts a function also introduces its header, so
 * the header scrolls with the code it belongs to.
 *
 * @param props.row - The row to render.
 * @param props.func - The function starting at this row, if any.
 * @param props.active - Whether this row's address is selected.
 * @param props.connected - Whether a connector is drawn for this row's branch.
 * @param props.onGoTo - Called when the function header is activated.
 * @param props.onSelect - Called with the row's address when it is clicked.
 * @returns The row element.
 */
export const ListingRowView = memo(function ListingRowView({
	row,
	func,
	active,
	connected,
	onGoTo,
	onSelect,
}: {
	row: ListingRow;
	func?: Function | null;
	active: boolean;
	connected: boolean;
	onGoTo?: (f: Function) => void;
	onSelect?: (addr: number) => void;
}) {
	if (row.kind === "header") {
		return (
			<div className="border-border bg-muted/40 text-asm-number flex h-[18px] items-center border-y pr-3 pl-[50px] font-mono text-[11px] font-semibold">
				{row.label ?? "section"}
			</div>
		);
	}

	const text = row.text ?? "";
	const { instr, comment } =
		row.kind === "code" ? splitComment(text) : { instr: "", comment: "" };
	const marker = flowMarker(row, connected);

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
					// Not `data-row`: its fixed height cannot hold bytes that
					// wrap to a second line, which is how a long instruction's
					// bytes stay in one narrow column instead of pushing the
					// instruction far to the right.
					// No padding of its own: the flow gutter is the first
					// column, and the address column follows it directly, so
					// the two line up exactly and nothing overlaps either.
					"flex min-h-[18px] min-w-max items-center gap-3 font-mono whitespace-nowrap",
					// An inset shadow rather than a border and padding, so the
					// selected row does not shift its gutter out from under the
					// connectors drawn over it.
					active &&
						"ui-selected bg-brand/15 shadow-[inset_2px_0_0_var(--brand)]",
					"hover:bg-accent/70 cursor-pointer",
				)}
				onClick={() => onSelect?.(row.addr)}
				title={
					row.kind === "code" ? "Select instruction" : "Select data"
				}
			>
				<FlowCell marker={marker} />
				<span className="text-asm-addr min-w-[11ch] shrink-0">
					{fmtAddr(row.addr)}
				</span>
				<span
					className="listing-bytes text-asm-bytes shrink-0 pr-3 whitespace-pre"
					style={{ width: "var(--listing-bytes-w, 26ch)" }}
				>
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
