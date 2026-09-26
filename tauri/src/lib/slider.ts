/**
 * The fraction of a slider's range already travelled, as a CSS percentage.
 *
 * A range input paints its groove with a gradient, so the filled portion has to
 * be handed to CSS as a length. This is the only arithmetic the slider needs,
 * kept out of the component so it can be tested without a DOM.
 *
 * Values outside the range are clamped rather than allowed to produce a
 * gradient that overflows the track, and a zero-width range is treated as empty
 * instead of dividing by zero.
 *
 * ```
 * sliderFill(24, 1, 500)  // => "4.607843137254902%"
 * sliderFill(0, 1, 500)   // => "0%"
 * sliderFill(900, 1, 500) // => "100%"
 * sliderFill(5, 5, 5)     // => "0%"
 * ```
 *
 * @param value - Current value.
 * @param min - Lowest selectable value.
 * @param max - Highest selectable value.
 * @returns A percentage string for `--ui-slider-fill`.
 */
export function sliderFill(value: number, min: number, max: number): string {
	const span = max - min;
	if (!Number.isFinite(value) || !Number.isFinite(span) || span <= 0) {
		return "0%";
	}
	const pct = ((value - min) / span) * 100;
	const clamped = Math.min(100, Math.max(0, pct));
	return `${clamped}%`;
}
