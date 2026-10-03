import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * One docked pane: a title bar (label · count · actions) over a body.
 *
 * Every panel uses this, so pane titles, counts, and spacing are identical
 * everywhere and only the content differs.
 *
 * @param props.title - Uppercase pane title.
 * @param props.count - Optional item count, shown next to the title.
 * @param props.actions - Optional controls pinned to the right of the title bar.
 * @param props.scroll - Let the body scroll (default). Disable for a pane that
 *   manages its own scrolling, like the disassembly view.
 */
export function Pane({
	title,
	count,
	actions,
	children,
	className,
	bodyClassName,
	scroll = true,
}: {
	title?: ReactNode;
	count?: number | string;
	actions?: ReactNode;
	children: ReactNode;
	className?: string;
	bodyClassName?: string;
	scroll?: boolean;
}) {
	// `h-full`: a pane dropped into a sized frame (a `StackSplit` stack) must
	// fill it so the body's `flex-1` has a bound and its list can scroll.
	// Against an auto-height parent a percentage height resolves to auto, so
	// this is inert anywhere the pane already sizes itself.
	return (
		<section
			className={cn("flex h-full min-h-0 min-w-0 flex-col", className)}
		>
			{title !== undefined && (
				<header className="border-border flex h-[var(--chrome-h)] shrink-0 items-center gap-2 border-b px-2.5">
					<span className="label truncate">{title}</span>
					{count !== undefined && (
						<span className="nums text-2xs text-muted-foreground/70">
							{count}
						</span>
					)}
					{actions && (
						<div className="ml-auto flex items-center gap-0.5">
							{actions}
						</div>
					)}
				</header>
			)}
			<div
				className={cn(
					"min-h-0 flex-1",
					scroll && "scroll-host overflow-auto",
					bodyClassName,
				)}
			>
				{children}
			</div>
		</section>
	);
}

/**
 * A muted placeholder for an empty pane — a short hint rather than a bare
 * "none".
 */
export function Empty({
	icon,
	title,
	hint,
}: {
	icon?: ReactNode;
	title: string;
	hint?: string;
}) {
	return (
		<div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-1.5 p-6 text-center">
			{icon && <div className="opacity-40">{icon}</div>}
			<div className="text-xs">{title}</div>
			{hint && (
				<div className="text-2xs text-muted-foreground/60 max-w-[24ch]">
					{hint}
				</div>
			)}
		</div>
	);
}
