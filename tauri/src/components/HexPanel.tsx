import { Loader2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/api";
import { cn } from "@/lib/utils";
import { useAnalysisStore } from "@/store/analysisStore";

const ROW_BYTES = 16;
const DEFAULT_LEN = 256;

function fmtAddr(a: number): string {
	return `0x${a.toString(16).padStart(8, "0")}`;
}

function toAscii(b: number): string {
	return b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".";
}

/**
 * Read-and-patch hex view over `Engine::read_bytes`/`write_bytes`. Edits
 * are staged locally (shown with a highlight) until "Apply patch", which
 * writes the changed bytes straight to the file on disk — the session's
 * cached analysis is not re-derived from the patch (see the host's
 * `write_bytes` doc comment), so disassembly/decompile elsewhere in the
 * app will not reflect it until the binary is reopened. That is called
 * out in the panel itself, not left implicit.
 */
export function HexPanel() {
	const selected = useAnalysisStore((s) => s.selected);
	// Seeded once from whatever function is selected when the panel first
	// mounts (a lazy initializer, not an effect — it never re-seeds on a
	// later selection change, matching the original "only on first mount"
	// intent without a synchronous setState-in-effect).
	const [addrInput, setAddrInput] = useState(() =>
		selected ? fmtAddr(selected.addr) : "",
	);
	const [lenInput, setLenInput] = useState(String(DEFAULT_LEN));
	const [baseAddr, setBaseAddr] = useState<number | null>(null);
	const [bytes, setBytes] = useState<number[] | null>(null);
	const [edits, setEdits] = useState<Map<number, number>>(new Map());
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [status, setStatus] = useState<string | null>(null);

	const parseAddr = (s: string): number | null => {
		const t = s.trim();
		if (!t) return null;
		const n = t.startsWith("0x") ? parseInt(t, 16) : parseInt(t, 10);
		return Number.isFinite(n) ? n : null;
	};

	const load = async () => {
		const addr = parseAddr(addrInput);
		const len = parseInt(lenInput, 10);
		if (addr === null || !Number.isFinite(len) || len <= 0) {
			setError("enter a valid address and length");
			return;
		}
		setLoading(true);
		setError(null);
		setStatus(null);
		try {
			const data = await api.readBytes(addr, Math.min(len, 4096));
			setBaseAddr(addr);
			setBytes(data);
			setEdits(new Map());
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	};

	const editByte = (offset: number, hex: string) => {
		const v = parseInt(hex, 16);
		if (!Number.isFinite(v) || v < 0 || v > 255) return;
		setEdits((prev) => {
			const next = new Map(prev);
			next.set(offset, v);
			return next;
		});
	};

	const applyPatch = async () => {
		if (baseAddr === null || edits.size === 0) return;
		setStatus(null);
		setError(null);
		// Patch contiguous runs so a scattered edit set becomes as few
		// write_bytes calls as possible, in ascending address order.
		const offsets = [...edits.keys()].sort((a, b) => a - b);
		try {
			let i = 0;
			while (i < offsets.length) {
				let j = i;
				while (
					j + 1 < offsets.length &&
					offsets[j + 1] === offsets[j] + 1
				) {
					j++;
				}
				const runOffsets = offsets.slice(i, j + 1);
				const runBytes = runOffsets.map((o) => edits.get(o) ?? 0);
				await api.writeBytes(baseAddr + runOffsets[0], runBytes);
				i = j + 1;
			}
			setStatus(
				`patched ${edits.size} byte${edits.size === 1 ? "" : "s"} on disk — reopen the binary to see it reflected in disassembly`,
			);
			setEdits(new Map());
			await load();
		} catch (e) {
			setError(String(e));
		}
	};

	const rows: { addr: number; row: number[] }[] = [];
	if (bytes && baseAddr !== null) {
		for (let i = 0; i < bytes.length; i += ROW_BYTES) {
			rows.push({
				addr: baseAddr + i,
				row: bytes.slice(i, i + ROW_BYTES),
			});
		}
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="border-border bg-card flex items-center gap-2 border-b px-3 py-1.5">
				<Input
					value={addrInput}
					onChange={(e) => setAddrInput(e.target.value)}
					placeholder="address (0x…)"
					className="h-7 w-36 font-mono text-xs"
					onKeyDown={(e) => e.key === "Enter" && void load()}
				/>
				<Input
					value={lenInput}
					onChange={(e) => setLenInput(e.target.value)}
					placeholder="length"
					className="h-7 w-20 font-mono text-xs"
					onKeyDown={(e) => e.key === "Enter" && void load()}
				/>
				<Button size="sm" variant="outline" onClick={() => void load()}>
					Load
				</Button>
				{edits.size > 0 && (
					<>
						<div className="bg-border mx-1 h-5 w-px" />
						<span className="text-muted-foreground text-[11px]">
							{edits.size} unsaved edit
							{edits.size === 1 ? "" : "s"}
						</span>
						<Button size="sm" onClick={() => void applyPatch()}>
							Apply patch
						</Button>
						<Button
							size="sm"
							variant="ghost"
							onClick={() => setEdits(new Map())}
						>
							Discard
						</Button>
					</>
				)}
				{loading && (
					<Loader2 className="text-muted-foreground h-3.5 w-3.5 animate-spin" />
				)}
			</div>

			{error && (
				<div className="border-destructive bg-destructive/10 text-destructive border-b px-3 py-2 text-[11px]">
					{error}
				</div>
			)}
			{status && (
				<div className="border-border bg-primary/10 border-b px-3 py-2 text-[11px]">
					{status}
				</div>
			)}

			<div className="scroll-host min-h-0 flex-1 overflow-auto p-3 font-mono text-[11px]">
				{!bytes ? (
					<div className="text-muted-foreground">
						Enter an address and length, then Load. Try editing a
						byte's hex value and Apply patch to write it directly to
						the file on disk.
					</div>
				) : (
					<table className="border-separate border-spacing-y-0.5">
						<tbody>
							{rows.map(({ addr, row }) => (
								<tr key={addr}>
									<td className="text-muted-foreground pr-3 align-top select-none">
										{fmtAddr(addr)}
									</td>
									{row.map((b, i) => {
										const offset = addr - baseAddr! + i;
										const edited = edits.has(offset);
										const value = edited
											? (edits.get(offset) ?? b)
											: b;
										return (
											<td
												key={i}
												className="w-[2ch] pr-1.5 align-top"
											>
												<input
													value={value
														.toString(16)
														.padStart(2, "0")}
													onChange={(e) =>
														editByte(
															offset,
															e.target.value,
														)
													}
													maxLength={2}
													className={cn(
														"w-[2ch] bg-transparent text-center outline-none",
														edited &&
															"text-primary font-bold underline decoration-dotted",
													)}
												/>
											</td>
										);
									})}
									<td className="text-muted-foreground pl-3 align-top select-none">
										{row
											.map((b, i) =>
												toAscii(
													edits.get(
														addr - baseAddr! + i,
													) ?? b,
												),
											)
											.join("")}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</div>
		</div>
	);
}
