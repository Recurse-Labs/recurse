const STORAGE_KEY = "recurse.disasmView";

/** User-selectable parts of the linear disassembly presentation. */
export interface DisasmViewOptions {
	showRawBytes: boolean;
	showAscii: boolean;
	showAddresses: boolean;
	showInstructionBytes: boolean;
	showComments: boolean;
	showFunctionMarkers: boolean;
	showSectionHeaders: boolean;
	wideSpacing: boolean;
}

/** Defaults keep the compact presentation while exposing every useful column. */
export const DEFAULT_DISASM_VIEW: DisasmViewOptions = {
	showRawBytes: true,
	showAscii: true,
	showAddresses: true,
	showInstructionBytes: true,
	showComments: true,
	showFunctionMarkers: true,
	showSectionHeaders: true,
	wideSpacing: false,
};

/**
 * Read the display preferences saved by the last disassembly-view change.
 *
 * ```
 * readDisasmView().showComments
 * // => true unless the user explicitly saved false
 * ```
 */
export function readDisasmView(): DisasmViewOptions {
	if (typeof localStorage === "undefined") return { ...DEFAULT_DISASM_VIEW };
	try {
		const saved = JSON.parse(
			localStorage.getItem(STORAGE_KEY) ?? "{}",
		) as Partial<DisasmViewOptions>;
		return { ...DEFAULT_DISASM_VIEW, ...saved };
	} catch {
		return { ...DEFAULT_DISASM_VIEW };
	}
}

/**
 * Save the current disassembly display preferences.
 *
 * ```
 * storeDisasmView({ ...DEFAULT_DISASM_VIEW, showAscii: false })
 * ```
 */
export function storeDisasmView(options: DisasmViewOptions): void {
	if (typeof localStorage === "undefined") return;
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(options));
	} catch {
		// Preferences are optional; a full or disabled storage must not affect analysis.
	}
}

/**
 * Convert a raw byte to the printable ASCII representation used in dumps.
 *
 * ```
 * byteAscii(0x41) // => "A"
 * byteAscii(0x00) // => "."
 * ```
 */
function byteAscii(byte: number): string {
	return byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : ".";
}

/**
 * Format an address in the section:offset form used by the disassembly view.
 *
 * ```
 * formatSectionAddress(0x1001630)
 * // => ".text:01001630"
 * ```
 */
function formatSectionAddress(address: number): string {
	return `.text:${address.toString(16).toUpperCase().padStart(8, "0")}`;
}

/**
 * Render the selected executable section's bytes above the instruction listing.
 * The preview is deliberately bounded so a large function does not push the
 * actual instructions out of view; the section separator still reports the
 * complete function size.
 *
 * @example
 * <DisasmBytes address={0x401000} bytes={[0x90]} size={1} loading={false} error={null} showAscii />
 */
export function DisasmBytes({
	address,
	bytes,
	size,
	loading,
	error,
	showAscii,
	canShowMore = false,
	showAll = false,
	onShowMore,
}: {
	address: number;
	bytes: number[];
	size: number;
	loading: boolean;
	error: string | null;
	showAscii: boolean;
	canShowMore?: boolean;
	showAll?: boolean;
	onShowMore?: () => void;
}) {
	const rows: { address: number; bytes: number[] }[] = [];
	for (let i = 0; i < bytes.length; i += 16) {
		rows.push({ address: address + i, bytes: bytes.slice(i, i + 16) });
	}
	const shown = bytes.length;
	const total = Math.max(size, shown);

	return (
		<div className="border-border bg-card font-mono text-[11px]">
			<div className="text-muted-foreground border-border text-2xs flex items-center justify-between border-b px-3 py-1 font-semibold tracking-wider uppercase">
				<span>Section bytes</span>
				<div className="flex items-center gap-3">
					<span>
						{loading
							? "loading…"
							: error
								? error
								: `${shown} / ${total} bytes shown`}
					</span>
					{canShowMore && onShowMore && (
						<button
							type="button"
							className="text-primary hover:text-primary/80 tracking-normal normal-case"
							onClick={onShowMore}
						>
							{showAll ? "Show less" : "Show more"}
						</button>
					)}
				</div>
			</div>
			{rows.map((row) => (
				<div
					key={row.address}
					className="grid min-w-max gap-x-2 px-3 py-px"
					style={{
						gridTemplateColumns: showAscii
							? "19ch 48ch 1fr"
							: "19ch max-content",
					}}
				>
					<span
						className="nums text-asm-addr"
						title="Virtual address"
					>
						{formatSectionAddress(row.address)}
					</span>
					<span className="text-asm-bytes whitespace-pre">
						{row.bytes
							.map((byte) => byte.toString(16).padStart(2, "0"))
							.join(" ")}
					</span>
					{showAscii && (
						<span className="text-asm-string pl-2 whitespace-pre">
							{row.bytes.map(byteAscii).join("").padEnd(16, " ")}
						</span>
					)}
				</div>
			))}
			{!loading && !error && bytes.length === 0 && (
				<div className="text-muted-foreground px-3 py-2">
					No raw bytes available.
				</div>
			)}
		</div>
	);
}
