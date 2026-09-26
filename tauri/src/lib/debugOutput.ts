/**
 * The program-output transcript, as the chunks it is built from.
 *
 * A plain string cannot mark which lines the analyst typed, so input is kept as
 * its own kind of chunk: the pane then renders program output and echoed input
 * differently, the way a terminal distinguishes what you typed from what the
 * program said. {@link outputText} flattens it back to plain text for tests and
 * for anything that wants to copy the transcript.
 */
export interface OutputChunk {
	/** The text, verbatim. */
	text: string;
	/** True for the analyst's own input echoed back, false for program output. */
	echo?: boolean;
}

/** Characters of transcript kept; older ones are dropped from the front. */
export const OUTPUT_MAX = 20000;

/**
 * Append text to the transcript, merging into the last chunk when it has the
 * same kind, and trimming to {@link OUTPUT_MAX} from the front.
 *
 * Merging matters because the output arrives in small polls: without it a chatty
 * debuggee would produce thousands of single-character spans. Trimming drops
 * whole leading chunks and slices a partial one, so the budget is a character
 * count across the whole transcript rather than per chunk.
 *
 * Empty text returns the same array, so a poll that brought nothing new does not
 * trigger a re-render.
 *
 * ```
 * appendOutput([], "hi\n")
 * // => [{ text: "hi\n" }]
 * appendOutput([{ text: "a" }], "b")
 * // => [{ text: "ab" }]
 * appendOutput([{ text: "a" }], "b", { echo: true })
 * // => [{ text: "a" }, { text: "b", echo: true }]
 * appendOutput([], "")
 * // => []
 * ```
 *
 * @param chunks - The current transcript.
 * @param text - Text to append; ignored when empty.
 * @param opts.echo - Mark the text as the analyst's input rather than output.
 * @param opts.max - Character budget (default {@link OUTPUT_MAX}).
 * @returns A new chunk array, or `chunks` itself when there was nothing to add.
 */
export function appendOutput(
	chunks: readonly OutputChunk[],
	text: string,
	opts: { echo?: boolean; max?: number } = {},
): OutputChunk[] {
	if (!text) return chunks as OutputChunk[];
	const { echo = false, max = OUTPUT_MAX } = opts;
	const last = chunks[chunks.length - 1];
	const next =
		last && !!last.echo === echo
			? [...chunks.slice(0, -1), { ...last, text: last.text + text }]
			: [...chunks, { text, echo }];
	return trimOutput(next, max);
}

/**
 * Drop the oldest characters until the transcript fits `max`.
 *
 * @param chunks - Chunks to trim, oldest first.
 * @param max - Character budget.
 * @returns The trimmed chunks.
 */
export function trimOutput(
	chunks: readonly OutputChunk[],
	max: number = OUTPUT_MAX,
): OutputChunk[] {
	let total = 0;
	for (const c of chunks) total += c.text.length;
	if (total <= max) return chunks as OutputChunk[];
	let excess = total - max;
	let start = 0;
	// Skip whole chunks first, then slice into the one that straddles the budget.
	while (start < chunks.length && excess >= chunks[start].text.length) {
		excess -= chunks[start].text.length;
		start++;
	}
	const rest = chunks.slice(start);
	if (excess > 0 && rest.length > 0) {
		rest[0] = { ...rest[0], text: rest[0].text.slice(excess) };
	}
	return rest;
}

/**
 * Flatten the transcript to plain text.
 *
 * ```
 * outputText([{ text: "a" }, { text: "b", echo: true }])  // => "ab"
 * ```
 *
 * @param chunks - The transcript.
 * @returns Every chunk's text, concatenated.
 */
export function outputText(chunks: readonly OutputChunk[]): string {
	let out = "";
	for (const c of chunks) out += c.text;
	return out;
}
