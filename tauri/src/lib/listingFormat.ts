/** Column formatting shared by the listing's rows and headers. */

/**
 * Hex address, the way the disassembly columns spell it.
 *
 * @param addr - The address.
 * @returns Eight hex digits, zero padded, with a `0x` prefix.
 *
 * @example
 * fmtAddr(0x1000);
 * // => "0x00001000"
 */
export function fmtAddr(addr: number): string {
	return `0x${addr.toString(16).padStart(8, "0")}`;
}

/**
 * Group a hex byte string into space-separated pairs, the way Ghidra shows
 * instruction and data bytes: `0f4c3b` becomes `0f 4c 3b`.
 *
 * @param hex - The packed hex string, or null.
 * @returns The bytes separated by single spaces.
 *
 * @example
 * groupBytes("0f4c3b");
 * // => "0f 4c 3b"
 * groupBytes(null);
 * // => ""
 */
export function groupBytes(hex?: string | null): string {
	if (!hex) return "";
	return hex.match(/.{1,2}/g)?.join(" ") ?? "";
}
