/**
 * How the listing spells things: addresses, and a function header's three
 * columns.
 *
 * The listing is monospaced, so its columns are widths in characters and its
 * addresses are fixed-width hex. Both are shared by the header and the rows, and
 * a view that spelled either of them its own way would leave the columns out of
 * alignment — so the spellings live here, arithmetic rather than template
 * strings spread across components.
 *
 * The two annotations an analyst can make — a name and a type — are keyed the
 * same way and stored in the same order, `"<func>:<key>"`, so a header cell can
 * look its value up without knowing which table it came from.
 */

/**
 * Hex address, the way the listing's columns spell it.
 *
 * Eight digits always, so a low address reads as an address rather than as a
 * short number, and two of them line up for comparison.
 *
 * @param addr - The address.
 * @returns The address as `0x` plus eight hex digits, lowercase.
 *
 * @example
 * fmtAddr(0x401000) // => "0x00401000"
 * fmtAddr(0)        // => "0x00000000"
 */
export function fmtAddr(addr: number): string {
	return `0x${addr.toString(16).padStart(8, "0")}`;
}

/** Width of the listing's byte column, in characters. */
export const BYTES_COLUMN = 26;

/**
 * Group a packed hex byte string into space-separated pairs, the way the
 * listing shows instruction and data bytes: `0f4c3b` becomes `0f 4c 3b`.
 *
 * @param hex - The packed hex string, or null when a row has no bytes.
 * @returns The bytes separated by single spaces, or `""` when there are none.
 *
 * @example
 * groupBytes("0f4c3b") // => "0f 4c 3b"
 * groupBytes("55")     // => "55"
 * groupBytes(null)     // => ""
 */
export function groupBytes(hex?: string | null): string {
	if (!hex) return "";
	return hex.match(/.{1,2}/g)?.join(" ") ?? "";
}

/**
 * The key a function's return value is annotated under.
 *
 * Not a register and not a number, so it cannot be read as an argument or as a
 * frame offset. It is the `<RETURN>` the header already prints as the return's
 * name, so the key and the label on screen are the same string.
 */
export const RETURN_KEY = "<RETURN>";

/** Width of the header's type column, in characters. */
export const TYPE_COLUMN = 12;

/** Width of the header's storage column, in characters. */
export const STORAGE_COLUMN = 20;

/**
 * The record an annotation is stored under: the function, then the datum.
 *
 * Scoped by function because a frame offset alone is not an identity: two
 * functions may both use `-0x18` for entirely different things, and an
 * argument is not an offset at all.
 *
 * @param func - The function's static address.
 * @param key - The datum: a frame offset, a register, or {@link RETURN_KEY}.
 * @returns The key both annotation tables are indexed by.
 *
 * @example
 * annotationKey(0x401000, -24)      // => "4198400:-24"
 * annotationKey(0x401000, "rdi")     // => "4198400:rdi"
 * annotationKey(0x401000, RETURN_KEY) // => "4198400:<RETURN>"
 */
export function annotationKey(func: number, key: string | number): string {
	return `${func}:${key}`;
}

/**
 * The type a datum is shown under until the analyst gives it one.
 *
 * `undefined` is the honest answer: nothing in the file says what a frame slot
 * holds. The byte width is appended because that much the instructions do say,
 * and `undefined8` says "eight bytes, type unknown" where `undefined` alone
 * says nothing at all.
 *
 * @param width - The widest access seen on the datum, in bytes. Zero for a
 *   return value or an argument, whose width no single access reveals.
 * @returns The derived type, e.g. `undefined` or `undefined8`.
 *
 * @example
 * derivedType(1)  // => "undefined"
 * derivedType(8)  // => "undefined8"
 * derivedType(0)  // => "undefined"
 * derivedType(-1) // => "undefined" — a nonsense width still renders
 */
export function derivedType(width: number): string {
	return Number.isFinite(width) && width > 1
		? `undefined${width}`
		: "undefined";
}

/**
 * Where a stack slot lives, spelled as Ghidra spells it.
 *
 * @param offset - The slot's offset from the frame pointer.
 * @returns The storage label, e.g. `Stack[-0x28]`.
 *
 * @example
 * stackStorage(-0x28) // => "Stack[-0x28]"
 * stackStorage(0x18)  // => "Stack[+0x18]"
 * stackStorage(0)     // => "Stack[+0x0]"
 */
export function stackStorage(offset: number): string {
	const sign = offset < 0 ? "-" : "+";
	return `Stack[${sign}0x${Math.abs(offset).toString(16)}]`;
}

/**
 * The type to show for a datum: the analyst's, or the derived one.
 *
 * @param types - Every recorded type, keyed by {@link annotationKey}.
 * @param func - The function's static address.
 * @param key - The datum.
 * @param width - The datum's derived width in bytes, used when nothing is
 *   recorded.
 * @returns The recorded type when there is one, else the derived one.
 *
 * @example
 * const types = { "4198400:<RETURN>": "int" };
 * typeFor(types, 0x401000, RETURN_KEY, 0) // => "int"
 * typeFor(types, 0x401000, "-24", 8)       // => "undefined8"
 */
export function typeFor(
	types: Readonly<Record<string, string>>,
	func: number,
	key: string | number,
	width: number,
): string {
	return types[annotationKey(func, key)] ?? derivedType(width);
}
