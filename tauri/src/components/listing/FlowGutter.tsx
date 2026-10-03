import {
	FLOW_ARROW_HALF,
	FLOW_GUTTER_W,
	FLOW_LINE_X,
	FLOW_MARKER_X,
	flowArrow,
	flowPath,
} from "@/lib/flowGutter";
import type { FlowMarker } from "@/lib/flowMarker";
import type { PlacedFlow } from "@/lib/flowGutter";
import { cn } from "@/lib/utils";

/**
 * One row's flow gutter: the fall-through line down its left edge, and the
 * branch glyph. Every x here is a fixed offset inside the gutter, so a marker
 * can never reach the address column.
 *
 * @param props.marker - The row's marker.
 * @returns The gutter cell.
 */
export function FlowCell({ marker }: { marker: FlowMarker }) {
	return (
		<span
			className="relative shrink-0 self-stretch"
			style={{ width: FLOW_GUTTER_W }}
			title={marker.title}
		>
			{marker.line ? (
				<span
					className="bg-muted-foreground/40 absolute inset-y-0 w-px"
					style={{ left: FLOW_LINE_X }}
				/>
			) : null}
			{marker.glyph ? (
				<span
					className={cn(
						"absolute inset-y-0 flex items-center justify-center text-[13px] leading-none font-bold",
						marker.className,
					)}
					style={{
						left: FLOW_MARKER_X - FLOW_ARROW_HALF - 6,
						width: (FLOW_ARROW_HALF + 6) * 2,
					}}
				>
					{marker.glyph}
				</span>
			) : null}
		</span>
	);
}

/**
 * The brackets for the rows on screen, drawn as one SVG inside the flow gutter.
 *
 * The overlay covers the window of rows on screen rather than the whole listing,
 * so its height is the height of that window and every bracket is shifted into
 * it. Because a bracket is only drawn when its target row is on screen too, it
 * always ends at a row, never at the edge of the view.
 *
 * @param props.edges - The placed edges, in listing content coordinates.
 * @param props.top - The window's top edge, in listing content pixels.
 * @param props.height - The window's height, in pixels.
 * @returns The overlay, or null when there is nothing to draw.
 */
export function FlowOverlay({
	edges,
	top,
	height,
}: {
	edges: readonly PlacedFlow[];
	top: number;
	height: number;
}) {
	if (height <= 0 || edges.length === 0) return null;
	return (
		<svg
			aria-hidden="true"
			className="pointer-events-none absolute z-10"
			style={{ left: 0, top, width: FLOW_GUTTER_W, height }}
		>
			{edges.map((edge) => {
				const local: PlacedFlow = {
					...edge,
					fromY: edge.fromY - top,
					toY: edge.toY - top,
				};
				return (
					<g
						key={edge.key}
						stroke={edge.color}
						strokeWidth={1.5}
						strokeLinecap="round"
						strokeLinejoin="round"
						fill="none"
					>
						<path d={flowPath(local)} />
						<polygon
							points={flowArrow(local)}
							fill={edge.color}
							stroke="none"
						/>
					</g>
				);
			})}
		</svg>
	);
}
