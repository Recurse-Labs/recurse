import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { chrome } from "./chrome";

const css = readFileSync(new URL("../chrome.css", import.meta.url), "utf8");

describe("chrome tokens", () => {
	it("exports class names that exist in chrome.css", () => {
		for (const name of Object.values(chrome)) {
			expect(css).toContain(`.${name}`);
		}
	});

	it("defines the shared control tokens", () => {
		for (const token of [
			"--selection",
			"--executed",
			"--control-h",
			"--chrome-h",
			"--radius-control",
			"--space-1",
			"--space-2",
			"--space-3",
			"--kbd",
			"--warning",
		]) {
			expect(css).toContain(token);
		}
	});

	it("defines the executed highlight for both themes", () => {
		const root = css.slice(0, css.indexOf(".dark"));
		const dark = css.slice(css.indexOf(".dark"));
		expect(root).toContain("--executed:");
		expect(dark).toContain("--executed:");
	});
});
