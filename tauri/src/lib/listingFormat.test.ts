import { describe, expect, it } from "vitest";

import { fmtAddr, groupBytes } from "@/lib/listingFormat";

describe("fmtAddr", () => {
	it("pads to eight hex digits", () => {
		expect(fmtAddr(0x1000)).toBe("0x00001000");
	});

	it("keeps every digit of a wide address", () => {
		expect(fmtAddr(0x7fff_1234)).toBe("0x7fff1234");
	});
});

describe("groupBytes", () => {
	it("groups bytes into pairs", () => {
		expect(groupBytes("0f4c3b")).toBe("0f 4c 3b");
	});

	it("is empty for a missing byte string", () => {
		expect(groupBytes(null)).toBe("");
		expect(groupBytes(undefined)).toBe("");
		expect(groupBytes("")).toBe("");
	});
});
