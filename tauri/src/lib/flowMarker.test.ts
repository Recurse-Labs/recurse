import { describe, expect, it } from "vitest";

import { flowMarker } from "@/lib/flowMarker";

describe("flowMarker", () => {
	it("draws a fall-through line and no glyph for straight-line code", () => {
		expect(
			flowMarker({ kind: "code", type: "nop", addr: 0x10 }),
		).toMatchObject({ glyph: "", line: true, title: "fall-through" });
	});

	it("ends the flow at a return", () => {
		expect(
			flowMarker({ kind: "code", type: "ret", addr: 0x10 }),
		).toMatchObject({ glyph: "", line: false, title: "flow ends" });
	});

	it("points a backward branch left", () => {
		expect(
			flowMarker({ kind: "code", type: "jmp", addr: 0x20, jump: 0x10 }),
		).toMatchObject({ glyph: "←", className: "text-destructive" });
	});

	it("points a call right", () => {
		expect(
			flowMarker({ kind: "code", type: "call", addr: 0x20, jump: 0x30 }),
		).toMatchObject({
			glyph: "→",
			line: true,
			className: "text-asm-symbol",
		});
	});

	it("drops the glyph when a bracket draws the branch", () => {
		expect(
			flowMarker(
				{
					kind: "code",
					type: "jmp",
					addr: 0x20,
					jump: 0x10,
				},
				true,
			),
		).toMatchObject({ glyph: "" });
	});

	it("has no marker on a data row", () => {
		expect(flowMarker({ kind: "data", addr: 0 })).toMatchObject({
			glyph: "",
			line: false,
		});
	});
});
