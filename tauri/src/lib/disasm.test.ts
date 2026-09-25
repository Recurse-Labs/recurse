import { describe, expect, it } from "vitest";

import {
	formatInstructionBytes,
	isRegister,
	splitComment,
	tokenizeAsm,
} from "./disasm";

describe("splitComment", () => {
	it("splits an instruction from its string comment", () => {
		expect(splitComment('mov edi, 0x4007d4 ; "Hello ! "')).toEqual({
			instr: "mov edi, 0x4007d4",
			comment: '"Hello ! "',
		});
	});

	it("splits a symbol/GOT comment", () => {
		expect(splitComment("call 0x400520 ; imp.puts")).toEqual({
			instr: "call 0x400520",
			comment: "imp.puts",
		});
	});

	it("returns the whole line when there is no comment", () => {
		expect(splitComment("push rbp")).toEqual({
			instr: "push rbp",
			comment: "",
		});
	});
});

describe("formatInstructionBytes", () => {
	it("adds spaces between hexadecimal byte pairs", () => {
		expect(formatInstructionBytes("48b801000000")).toBe(
			"48 b8 01 00 00 00",
		);
	});

	it("keeps already formatted bytes stable and handles empty values", () => {
		expect(formatInstructionBytes("90 c3")).toBe("90 c3");
		expect(formatInstructionBytes(undefined)).toBe("");
	});
});

describe("tokenizeAsm", () => {
	it("classifies mnemonic, registers, and immediates", () => {
		expect(tokenizeAsm("mov eax, 0x3").map((t) => t.kind)).toEqual([
			"mnemonic",
			"plain",
			"register",
			"plain",
			"plain",
			"number",
		]);
	});

	it("does not colour a non-register operand", () => {
		expect(tokenizeAsm("call printf").map((t) => t.kind)).toEqual([
			"mnemonic",
			"plain",
			"plain",
		]);
	});
});

describe("isRegister", () => {
	it("recognises the supported architectures", () => {
		for (const r of [
			"rax",
			"eax",
			"esi",
			"r15d",
			"x0",
			"w8",
			"sp",
			"lr",
			"$ra",
			"a0",
			"r3",
		]) {
			expect(isRegister(r), r).toBe(true);
		}
		for (const n of ["main", "printf", "qword", "0x3", "edi_x"]) {
			expect(isRegister(n), n).toBe(false);
		}
	});
});
