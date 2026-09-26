import type { CSSProperties } from "react";

import { chrome } from "@/lib/chrome";
import { sliderFill } from "@/lib/slider";
import { cn } from "@/lib/utils";

/**
 * A draggable value input.
 *
 * A native `input[type=range]` rather than a custom pointer handler: dragging,
 * arrow-key nudging, Home/End and page steps then come from the platform, and
 * the control is announced correctly to assistive tech for free. The filled
 * part of the groove is painted from `--ui-slider-fill`, the fraction of the
 * range already travelled.
 *
 * @param props.value - Current value.
 * @param props.min - Lowest selectable value (default 0).
 * @param props.max - Highest selectable value (default 100).
 * @param props.step - Granularity (default 1).
 * @param props.onValueChange - Called with the dragged-to value.
 * @param props.label - Accessible name for the control.
 */
export function Slider({
	value,
	min = 0,
	max = 100,
	step = 1,
	onValueChange,
	label,
	className,
	...rest
}: {
	value: number;
	min?: number;
	max?: number;
	step?: number;
	onValueChange: (value: number) => void;
	label: string;
	className?: string;
} & Omit<
	React.InputHTMLAttributes<HTMLInputElement>,
	"onChange" | "value" | "min" | "max" | "step" | "type"
>) {
	return (
		<input
			type="range"
			aria-label={label}
			className={cn(chrome.slider, className)}
			min={min}
			max={max}
			step={step}
			value={value}
			onChange={(e) => onValueChange(Number(e.currentTarget.value))}
			style={
				{
					"--ui-slider-fill": sliderFill(value, min, max),
				} as CSSProperties
			}
			{...rest}
		/>
	);
}
