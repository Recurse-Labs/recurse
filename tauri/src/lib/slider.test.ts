import { describe, expect, it } from "vitest";

import { sliderFill } from "./slider";

describe("sliderFill", () => {
	it("is the fraction of the range travelled", () => {
		expect(sliderFill(5, 0, 10)).toBe("50%");
		expect(sliderFill(0, 0, 10)).toBe("0%");
		expect(sliderFill(10, 0, 10)).toBe("100%");
	});

	it("measures from min, not from zero", () => {
		// The debugger history range starts at 1, so the minimum is not 0%.
		expect(sliderFill(1, 1, 500)).toBe("0%");
		expect(sliderFill(500, 1, 500)).toBe("100%");
	});

	it("clamps out-of-range values to the track", () => {
		expect(sliderFill(-40, 1, 500)).toBe("0%");
		expect(sliderFill(99999, 1, 500)).toBe("100%");
	});

	it("treats a zero-width range as empty instead of dividing by zero", () => {
		expect(sliderFill(5, 5, 5)).toBe("0%");
		expect(sliderFill(5, 10, 1)).toBe("0%");
	});

	it("is empty for a non-finite value", () => {
		expect(sliderFill(Number.NaN, 1, 500)).toBe("0%");
		expect(sliderFill(Number.POSITIVE_INFINITY, 1, 500)).toBe("0%");
	});
});
