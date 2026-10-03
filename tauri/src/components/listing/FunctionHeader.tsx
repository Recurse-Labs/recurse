import { useEffect, useState } from "react";

import { api } from "@/api";
import {
	argsOf,
	defaultVarName,
	derivedName,
	frameOf,
	localsOf,
	type ArgVar,
	type Frame,
	type LocalVar,
} from "@/lib/debugVars";
import { fmtAddr } from "@/lib/listingFormat";
import type { DebugInsn, Function, Xref } from "@/types";

/**
 * Ghidra's function banner: a boxed `FUNCTION` line, prefixed with the `;`
 * comment marker the listing uses for comments.
 *
 * @param width - Width of the box's star rules.
 * @returns The three comment lines, top rule first.
 *
 * @example
 * functionBanner(12);
 * // => ["; ************", "; * FUNCTION *", "; ************"]
 */
export function functionBanner(width = 60): [string, string, string] {
	const stars = "*".repeat(width);
	const label = "FUNCTION";
	const inner = width - 2;
	const left = Math.floor((inner - label.length) / 2);
	const right = inner - label.length - left;
	return [
		`; ${stars}`,
		`; *${" ".repeat(left)}${label}${" ".repeat(right)}*`,
		`; ${stars}`,
	];
}

/** A function's derived storage: what it reads for arguments and what it names
 * on the stack. Computed once per function and cached, since it needs the
 * function's instructions and a header is re-rendered as the view scrolls. */
interface HeaderInfo {
	args: ArgVar[];
	locals: LocalVar[];
	frame: Frame;
	xrefs: Xref[];
}

const headerInfoCache = new Map<number, HeaderInfo>();

/**
 * One columnar line of the function header, in Ghidra's order: the type, the
 * storage, then the name.
 *
 * @param type - The datum's type (`undefined`, `undefined4`, …).
 * @param storage - Where it lives (`rdi`, `Stack[-0x8]`, `<UNASSIGNED>`).
 * @param name - The variable or marker name.
 * @returns The padded line.
 *
 * @example
 * headerLine("undefined", "rdi", "param_1");
 * // => "undefined    rdi                  param_1"
 */
export function headerLine(
	type: string,
	storage: string,
	name: string,
): string {
	return `${type.padEnd(12)}${storage.padEnd(20)}${name}`;
}

/**
 * The storage column for a stack slot, spelled as Ghidra does.
 *
 * @param offset - The slot's offset from the frame pointer.
 * @returns The storage name.
 *
 * @example
 * stackStorage(-8);
 * // => "Stack[-0x8]"
 */
export function stackStorage(offset: number): string {
	return `Stack[${offset < 0 ? "-" : "+"}0x${Math.abs(offset).toString(16)}]`;
}

/**
 * Ghidra's function header: the banner, the signature, then where the function
 * takes each argument and what stack slots it names. The argument and local
 * lines are derived from the function's own instructions (calling-convention
 * registers and frame references), so they say what the code does, not what a
 * symbol table declares.
 *
 * @param props.func - The function whose entry this header introduces.
 * @param props.onGoTo - Called to navigate to the function.
 * @returns The header lines.
 */
export function FunctionHeader({
	func,
	onGoTo,
}: {
	func: Function;
	onGoTo?: (f: Function) => void;
}) {
	// Read straight from the cache during render; the only state is a counter
	// that re-renders this header once a fetch fills the cache.
	const [, forceRender] = useState(0);
	const info = headerInfoCache.get(func.addr) ?? null;

	useEffect(() => {
		if (headerInfoCache.has(func.addr)) return;
		let cancelled = false;
		Promise.all([
			api.functionDisasm(func.addr),
			api.xrefsTo(func.addr).catch(() => [] as Xref[]),
		])
			.then(([asm, xrefs]) => {
				const insns: DebugInsn[] = (asm?.ops ?? []).map((o) => ({
					addr: o.addr,
					bytes: o.bytes ?? "",
					text: o.text ?? o.disasm ?? "",
				}));
				headerInfoCache.set(func.addr, {
					args: argsOf(insns),
					locals: localsOf(insns),
					frame: frameOf(insns),
					xrefs,
				});
				if (!cancelled) forceRender((n) => n + 1);
			})
			.catch(() => {
				/* no disassembly to derive from; the header still renders */
			});
		return () => {
			cancelled = true;
		};
	}, [func.addr]);

	const xrefs = info?.xrefs ?? [];
	const xrefText = xrefs.length
		? `XREF[${xrefs.length}]:  ${xrefs
				.map((x) => `${fmtAddr(x.from)}(*)`)
				.join(", ")}`
		: "";

	return (
		// `pl` is the flow gutter plus the gap that follows it, so the header's
		// text — and the banner's rules, which are centred on what is left — stay
		// clear of the connectors drawn over the gutter.
		<div
			className="text-asm-number pt-3 pb-1 pl-[50px] font-mono text-[11px] leading-4 whitespace-pre"
			style={{ paddingRight: 12 }}
		>
			<div className="text-center">{functionBanner().join("\n")}</div>
			<button
				type="button"
				title="Go to this function"
				className="text-asm-symbol block w-full text-center hover:underline"
				onClick={() => onGoTo?.(func)}
			>
				{func.signature ?? `undefined ${func.name ?? "function"}()`}
			</button>
			<div className="text-muted-foreground">
				{headerLine("undefined", "<UNASSIGNED>", "<RETURN>")}
			</div>
			{info?.args.map((a) => (
				<div key={`arg-${a.reg}`} className="text-muted-foreground">
					{headerLine("undefined", a.reg, defaultVarName(a))}
				</div>
			))}
			{info?.locals.map((l) => (
				<div
					key={`local-${l.offset}`}
					className="text-muted-foreground"
				>
					{headerLine(
						`undefined${l.width > 1 ? l.width : ""}`,
						stackStorage(l.offset),
						derivedName(l.offset),
					)}
				</div>
			))}
			<div className="text-muted-foreground">
				{`${(func.name ?? "function").padEnd(26)}${xrefText}`}
			</div>
		</div>
	);
}
