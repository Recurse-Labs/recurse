import type { ReactNode } from "react";

/**
 * Split a disassembly line into its instruction and its `; comment` suffix.
 *
 * Both backends append annotations to `disasm` as `"<instr> ; <comment>"`
 * (the comment is a string literal, a symbol, or a GOT/PLT name), so the UI
 * splits on that separator to colour the two parts independently.
 *
 * ```
 * splitComment('mov edi, 0x4007d4 ; "Hello ! "')
 * // => { instr: "mov edi, 0x4007d4", comment: '"Hello ! "' }
 * ```
 */
export function splitComment(text: string): {
	instr: string;
	comment: string;
} {
	const i = text.indexOf(" ; ");
	if (i < 0) return { instr: text, comment: "" };
	return { instr: text.slice(0, i), comment: text.slice(i + 3) };
}

/**
 * Format a compact instruction byte string as separated hexadecimal pairs.
 *
 * ```
 * formatInstructionBytes("48b801000000")
 * // => "48 b8 01 00 00 00"
 * ```
 */
export function formatInstructionBytes(
	bytes: string | null | undefined,
): string {
	const compact = (bytes ?? "").replace(/\s+/g, "");
	if (!compact) return "";
	return (compact.match(/.{1,2}/g) ?? []).join(" ");
}

/** Token kinds the highlighter distinguishes. */
export type TokenKind = "mnemonic" | "register" | "number" | "plain";

export interface Token {
	text: string;
	kind: TokenKind;
}

/** Colour per token kind (mnemonic / register / immediate), from the theme. */
const TOKEN_CLASS: Record<TokenKind, string> = {
	mnemonic: "text-asm-mnemonic",
	register: "text-asm-register",
	number: "text-asm-number",
	plain: "",
};

// Register sets for the architectures the native engine decodes. Heuristic by
// design: an unrecognised operand is simply left in the default colour.
const X86 =
	/^(r(1[0-5]|[0-9])[dwb]?|[re]?(ax|bx|cx|dx|si|di|bp|sp)|[abcd]x|[abcd][lh]|[sd]il|[sb]pl|r?(ip|flags)|xmm\d+|ymm\d+|zmm\d+|mm\d+|st\d*|cs|ds|es|fs|gs|ss)$/i;
const ARM =
	/^(x([0-9]|[12][0-9]|3[01])|w([0-9]|[12][0-9]|3[01])|xzr|wzr|sp|lr|pc|fp|ip|r([0-9]|1[0-5])|v([0-9]|[12][0-9]|3[01])|q([0-9]|[12][0-9]|3[01])|d([0-9]|[12][0-9]|3[01])|s([0-9]|[12][0-9]|3[01])|sl|sb)$/i;
const MIPS = /^\$(zero|at|v[01]|a[0-3]|t[0-9]|s[0-7]|k[01]|gp|sp|fp|ra|pc)$/i;
const RISCV =
	/^(x([0-9]|[12][0-9]|3[01])|a[0-7]|t[0-6]|s([0-9]|1[01])|zero|ra|sp|gp|tp|fp)$/i;
const PPC =
	/^(r([0-9]|[12][0-9]|3[01])|f([0-9]|[12][0-9]|3[01])|lr|ctr|cr\d*|v([0-9]|[12][0-9]|3[01]))$/i;

/** True when a bare token names a CPU register on a supported architecture. */
export function isRegister(token: string): boolean {
	return (
		X86.test(token) ||
		ARM.test(token) ||
		MIPS.test(token) ||
		RISCV.test(token) ||
		PPC.test(token)
	);
}

/**
 * Tokenise one instruction (without its comment) into mnemonic, registers,
 * immediates, and plain text, so the UI can colour them apart.
 *
 * ```
 * tokenizeAsm("mov eax, 0x3").map((t) => t.kind)
 * // => ["mnemonic", "plain", "register", "plain", "plain", "number"]
 * ```
 */
export function tokenizeAsm(instr: string): Token[] {
	const toks: Token[] = [];
	let i = 0;
	let firstIdent = true;
	while (i < instr.length) {
		const c = instr[i];
		if (/\s/.test(c)) {
			toks.push({ text: c, kind: "plain" });
			i += 1;
			continue;
		}
		if (/[A-Za-z_.$]/.test(c)) {
			let j = i;
			while (j < instr.length && /[A-Za-z0-9_.$]/.test(instr[j])) j += 1;
			const word = instr.slice(i, j);
			let kind: TokenKind = "plain";
			if (firstIdent) {
				kind = "mnemonic";
				firstIdent = false;
			} else if (isRegister(word)) {
				kind = "register";
			}
			toks.push({ text: word, kind });
			i = j;
			continue;
		}
		if (
			/[0-9]/.test(c) ||
			(c === "-" && /[0-9]/.test(instr[i + 1] ?? ""))
		) {
			let j = i + 1;
			while (j < instr.length && /[0-9a-fA-FxX]/.test(instr[j])) j += 1;
			toks.push({ text: instr.slice(i, j), kind: "number" });
			i = j;
			continue;
		}
		toks.push({ text: c, kind: "plain" });
		i += 1;
	}
	return toks;
}

/**
 * Render one instruction with per-token colour (mnemonic, registers,
 * immediates), IDA-style. Comments are handled separately by
 * [`DisasmComment`].
 */
export function DisasmInstr({ text }: { text: string }): ReactNode {
	return (
		<>
			{tokenizeAsm(text).map((t, i) => {
				const cls = TOKEN_CLASS[t.kind];
				return cls ? (
					<span key={i} className={cls}>
						{t.text}
					</span>
				) : (
					<span key={i}>{t.text}</span>
				);
			})}
		</>
	);
}

/**
 * Render the `; comment` suffix of a disassembly line. Quoted string literals
 * get the string accent; symbol / GOT / PLT comments are muted italic, so a
 * `; "Give me your flag"` reads clearly as a string rather than more assembly.
 */
export function DisasmComment({ comment }: { comment: string }): ReactNode {
	if (!comment) return null;
	const isString = comment.startsWith('"');
	return (
		<span
			className={isString ? "text-asm-string" : "text-asm-symbol italic"}
		>
			{" ; "}
			{comment}
		</span>
	);
}
