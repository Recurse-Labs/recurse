import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Slider } from "@/components/ui/slider";
import { chrome } from "@/lib/chrome";
import { cn } from "@/lib/utils";
import {
	DEBUG_HISTORY_DEFAULT,
	DEBUG_HISTORY_MAX,
	DEBUG_HISTORY_MIN,
	useSettingsStore,
} from "@/store/settingsStore";

/**
 * Debugger settings, opened from the header's Settings menu.
 *
 * The CPU view's history depth is a drag rather than a stepper because the
 * useful range is wide (a couple of instructions for a single step, hundreds
 * for a long run) and the interesting values are in between, where clicking `+`
 * would take dozens of presses. Dragging covers the whole range in one gesture
 * while the native control keeps arrow keys, Home/End and page steps working.
 *
 * The value is written to the store on every change rather than on release, so
 * the CPU view updates live under the dialog as the slider moves.
 */
export function DebuggerSettingsDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const depth = useSettingsStore((s) => s.debugHistory);
	const setDepth = useSettingsStore((s) => s.setDebugHistory);
	const reset = useSettingsStore((s) => s.resetDebugHistory);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-sm gap-4 p-4">
				<DialogTitle className={chrome.label}>Debugger</DialogTitle>

				<div className="flex flex-col gap-1.5">
					<div className="flex items-baseline justify-between gap-2">
						<label
							htmlFor="debug-history-depth"
							className="text-xs font-medium"
						>
							Instruction history
						</label>
						<span
							className={cn(
								chrome.nums,
								"text-foreground text-xs",
								depth === DEBUG_HISTORY_DEFAULT &&
									"text-muted-foreground",
							)}
						>
							{depth}
						</span>
					</div>
					<Slider
						id="debug-history-depth"
						label="Instruction history"
						value={depth}
						min={DEBUG_HISTORY_MIN}
						max={DEBUG_HISTORY_MAX}
						onValueChange={setDepth}
					/>
					<div className="text-muted-foreground text-2xs flex justify-between">
						<span>{DEBUG_HISTORY_MIN}</span>
						<span>
							keep the last {depth} already-executed instruction
							{depth === 1 ? "" : "s"} above the program counter
						</span>
						<span>{DEBUG_HISTORY_MAX}</span>
					</div>
					<p className="text-muted-foreground text-2xs">
						Older instructions stay in the session cache, so raising
						this scrolls them back into view without refetching.
					</p>
				</div>

				<div className="flex justify-end">
					<button
						type="button"
						onClick={reset}
						disabled={depth === DEBUG_HISTORY_DEFAULT}
						className="text-muted-foreground hover:text-foreground text-xs disabled:opacity-50"
					>
						Reset to {DEBUG_HISTORY_DEFAULT}
					</button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
