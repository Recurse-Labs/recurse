import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api } from "@/api";
import type { ListingRow } from "@/types";

/** Rows fetched per request. Small enough to stay snappy, large enough that a
 * fast scroll does not outrun the fetches. */
export const CHUNK = 256;

/** What the listing knows about the rows it has fetched. */
export interface ListingRows {
	/** Fetched rows, keyed by the chunk they came from. */
	chunks: Map<number, ListingRow[]>;
	/** The first fetch's error, if the backend has no listing. */
	error: string | null;
	/** Width of the byte column, in `ch`, sized to the longest byte run. */
	bytesCh: number;
	/** The row at a listing index, or undefined while its chunk is in flight. */
	rowAt: (index: number) => ListingRow | undefined;
	/** Drop every fetched row, for a new target. */
	reset: () => void;
}

/** The slice of rows that needs fetching next. */
export interface ListingWindow {
	firstIndex: number;
	lastIndex: number;
}

/**
 * Fetch the listing a window at a time, as the view scrolls, so a multi-megabyte
 * image is never held in the browser at once.
 *
 * The listing's length is reported to the caller rather than held here, because
 * the caller needs it to size the virtualizer that decides which rows to fetch;
 * the first window is fetched until that arrives.
 *
 * @param window - The range of rows currently on screen.
 * @param onTotal - Called with the listing's length once it is known.
 * @returns The fetched rows, the byte column's width, and the reset hook.
 */
export function useListingRows(
	window: ListingWindow,
	onTotal: (total: number) => void,
): ListingRows {
	const [chunks, setChunks] = useState<Map<number, ListingRow[]>>(new Map());
	const [error, setError] = useState<string | null>(null);
	const [length, setLength] = useState(0);
	const inflight = useRef<Set<number>>(new Set());
	const { firstIndex, lastIndex } = window;

	const reset = useCallback(() => {
		setChunks(new Map());
		setLength(0);
		setError(null);
		inflight.current = new Set();
	}, []);

	useEffect(() => {
		const want = (index: number) => {
			const chunk = Math.floor(index / CHUNK);
			if (chunks.has(chunk) || inflight.current.has(chunk)) return;
			inflight.current.add(chunk);
			api.listing(chunk * CHUNK, CHUNK)
				.then((fetched) => {
					inflight.current.delete(chunk);
					onTotal(fetched.total);
					setLength((prev) => (prev === 0 ? fetched.total : prev));
					setChunks((prev) => {
						if (prev.has(chunk)) return prev;
						const next = new Map(prev);
						next.set(chunk, fetched.rows);
						return next;
					});
				})
				.catch((e) => {
					inflight.current.delete(chunk);
					setError(String(e));
				});
		};
		if (length === 0) {
			want(0);
		} else {
			want(firstIndex);
			want(lastIndex);
		}
	}, [firstIndex, lastIndex, length, chunks, onTotal]);

	const rowAt = useCallback(
		(index: number): ListingRow | undefined =>
			chunks.get(Math.floor(index / CHUNK))?.[index % CHUNK],
		[chunks],
	);

	// Width of the byte column, sized to the longest bytes in the loaded rows so
	// a byte run never wraps and the column is no wider than it must be. Capped
	// at the x86 instruction ceiling: 15 bytes, three columns each, minus the
	// last one's missing trailing space, plus a gutter for the padding.
	const bytesCh = useMemo(() => {
		let mostBytes = 4;
		for (const rows of chunks.values()) {
			for (const r of rows) {
				if (r.bytes) {
					mostBytes = Math.max(
						mostBytes,
						Math.ceil(r.bytes.length / 2),
					);
				}
			}
		}
		return Math.min(15, mostBytes) * 3 - 1 + 2;
	}, [chunks]);

	return { chunks, error, bytesCh, rowAt, reset };
}
