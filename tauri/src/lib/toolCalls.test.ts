import { describe, expect, it } from "vitest";

import {
	classifyToolCall,
	formatToolOutput,
	getToolResultFacts,
	isToolError,
	parseToolArguments,
} from "./toolCalls";

describe("parseToolArguments", () => {
	it("parses object payloads and preserves malformed text", () => {
		expect(parseToolArguments('{"op":"disasm","addr":"0x401000"}')).toEqual(
			{
				op: "disasm",
				addr: "0x401000",
			},
		);
		expect(parseToolArguments("not json")).toEqual({ raw: "not json" });
	});
});

describe("classifyToolCall", () => {
	it("gives static analysis calls an address and observation risk", () => {
		const view = classifyToolCall(
			"analyze",
			JSON.stringify({ op: "disasm", addr: "0x401000", count: 24 }),
		);

		expect(view.family).toBe("analysis");
		expect(view.operationLabel).toBe("Disassemble");
		expect(view.target).toBe("0x401000");
		expect(view.risk).toBe("observe");
		expect(view.fields.map((field) => field.key)).toContain("count");
	});

	it("marks process-memory writes as mutating debugger operations", () => {
		const view = classifyToolCall(
			"debug",
			JSON.stringify({ op: "write", addr: "0x7fff0000", bytes: "90" }),
		);

		expect(view.family).toBe("debugger");
		expect(view.operationLabel).toBe("Write process memory");
		expect(view.risk).toBe("mutate");
		expect(view.fields.find((field) => field.key === "bytes")?.value).toBe(
			"90",
		);
	});

	it("separates shell, filesystem, memory, and raw-console calls", () => {
		expect(
			classifyToolCall("bash", JSON.stringify({ command: "file target" }))
				.family,
		).toBe("shell");
		expect(
			classifyToolCall(
				"read",
				JSON.stringify({ filePath: "/tmp/target" }),
			).family,
		).toBe("filesystem");
		expect(
			classifyToolCall(
				"memory_search",
				JSON.stringify({ query: "decrypt" }),
			).family,
		).toBe("memory");
		expect(
			classifyToolCall(
				"analyze",
				JSON.stringify({ op: "raw", cmd: "afl" }),
			).family,
		).toBe("console");
	});
});

describe("tool result evidence", () => {
	it("extracts list counts and truncation state", () => {
		const view = classifyToolCall(
			"analyze",
			JSON.stringify({ op: "functions", limit: 2 }),
		);
		const facts = getToolResultFacts(
			view,
			JSON.stringify({
				count: 40,
				showing: 2,
				truncated: true,
				items: [],
			}),
		);

		expect(facts).toEqual(
			expect.arrayContaining([
				{ label: "Count", value: "40", tone: "default" },
				{ label: "Showing", value: "2", tone: "default" },
				{ label: "Truncated", value: "yes", tone: "warning" },
			]),
		);
	});

	it("does not duplicate raw shell output as evidence", () => {
		const view = classifyToolCall(
			"bash",
			JSON.stringify({ command: "printf test" }),
		);

		expect(getToolResultFacts(view, "bash: command failed")).toEqual([]);
	});

	it("recognizes backend errors and pretty-prints JSON output", () => {
		expect(isToolError("tool error: unsupported operation")).toBe(true);
		expect(isToolError('{"ok":true}')).toBe(false);
		expect(formatToolOutput('{"op":"info","ok":true}')).toBe(
			'{\n  "op": "info",\n  "ok": true\n}',
		);
	});
});
