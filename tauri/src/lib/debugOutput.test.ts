import { describe, expect, it } from "vitest";

import {
	appendOutput,
	OUTPUT_MAX,
	outputText,
	trimOutput,
} from "./debugOutput";

describe("appendOutput", () => {
	it("appends program output", () => {
		expect(appendOutput([], "hi\n")).toEqual([
			{ text: "hi\n", echo: false },
		]);
	});

	it("marks echoed input as the analyst's", () => {
		expect(appendOutput([], "42\n", { echo: true })).toEqual([
			{ text: "42\n", echo: true },
		]);
	});

	it("merges into the previous chunk of the same kind", () => {
		// Output arrives in small polls; without merging, a chatty debuggee would
		// leave thousands of one-character chunks.
		const once = appendOutput([], "a");
		expect(appendOutput(once, "b")).toEqual([{ text: "ab", echo: false }]);
	});

	it("starts a new chunk when the kind changes", () => {
		const out = appendOutput([], "prompt: ");
		expect(appendOutput(out, "42\n", { echo: true })).toEqual([
			{ text: "prompt: ", echo: false },
			{ text: "42\n", echo: true },
		]);
	});

	it("keeps consecutive echoes in one chunk", () => {
		let chunks = appendOutput([], "a\n", { echo: true });
		chunks = appendOutput(chunks, "b\n", { echo: true });
		expect(chunks).toEqual([{ text: "a\nb\n", echo: true }]);
	});

	it("returns the same array for empty text, so no re-render", () => {
		const chunks = appendOutput([], "a");
		expect(appendOutput(chunks, "")).toBe(chunks);
	});

	it("never mutates the array it was given", () => {
		const before = appendOutput([], "a");
		const snapshot = structuredClone(before);
		appendOutput(before, "b");
		expect(before).toEqual(snapshot);
	});

	it("trims the oldest text to the budget", () => {
		const chunks = appendOutput([], "x".repeat(50), { max: 10 });
		expect(outputText(chunks)).toBe("x".repeat(10));
	});

	it("trims across chunk boundaries", () => {
		const chunks = trimOutput(
			[
				{ text: "aaaa", echo: false },
				{ text: "bbbb", echo: false },
				{ text: "cccc", echo: false },
			],
			4,
		);
		expect(outputText(chunks)).toBe("cccc");
	});
});

describe("trimOutput", () => {
	it("leaves a transcript within budget alone", () => {
		const chunks = [{ text: "abc" }];
		expect(trimOutput(chunks, 10)).toBe(chunks);
	});

	it("slices into the chunk that straddles the budget", () => {
		// 6 characters kept down to 3: the first chunk is dropped whole and one
		// character is cut from the front of the next.
		const chunks = trimOutput([{ text: "aa" }, { text: "bbbb" }], 3);
		expect(chunks).toEqual([{ text: "bbb" }]);
		expect(outputText(chunks)).toHaveLength(3);
	});

	it("drops every chunk when the budget is zero", () => {
		expect(trimOutput([{ text: "abc" }], 0)).toEqual([]);
	});
});

describe("outputText", () => {
	it("flattens the transcript back to plain text", () => {
		expect(
			outputText([
				{ text: "prompt: " },
				{ text: "42\n", echo: true },
				{ text: "ok\n" },
			]),
		).toBe("prompt: 42\nok\n");
	});

	it("is empty for an empty transcript", () => {
		expect(outputText([])).toBe("");
	});
});

describe("OUTPUT_MAX", () => {
	it("bounds a long-running session's transcript", () => {
		let chunks: ReturnType<typeof appendOutput> = [];
		for (let i = 0; i < 500; i++) {
			chunks = appendOutput(chunks, "line ".repeat(20) + "\n");
		}
		expect(outputText(chunks).length).toBeLessThanOrEqual(OUTPUT_MAX);
		// The newest text is the part worth keeping.
		expect(outputText(chunks).endsWith("\n")).toBe(true);
	});
});
