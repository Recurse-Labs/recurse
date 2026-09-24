import { useState } from "react";
import {
	Binary,
	Bug,
	Check,
	ChevronDown,
	CircleAlert,
	Copy,
	FolderOpen,
	HardDrive,
	ListTree,
	LoaderCircle,
	MemoryStick,
	Search,
	SquareTerminal,
	Terminal,
	type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
	classifyToolCall,
	formatToolOutput,
	getToolResultFacts,
	isToolError,
	type ToolArgumentField,
	type ToolCallView,
	type ToolFamily,
	type ToolResultFact,
} from "@/lib/toolCalls";
import type { ToolCallUi } from "@/store/agentStore";

const FAMILY_ICONS: Record<ToolFamily, LucideIcon> = {
	analysis: Binary,
	debugger: Bug,
	filesystem: FolderOpen,
	shell: Terminal,
	memory: MemoryStick,
	console: SquareTerminal,
	generic: HardDrive,
};

/** Render a compact field/value grid for a tool invocation. */
function ArgumentFields({ fields }: { fields: ToolArgumentField[] }) {
	if (fields.length === 0) return null;
	return (
		<dl className="grid grid-cols-[minmax(5.5rem,auto)_minmax(0,1fr)] gap-x-3 gap-y-1.5">
			{fields.map((field) => (
				<div key={field.key} className="contents">
					<dt className="text-muted-foreground text-2xs pt-0.5">
						{field.label}
					</dt>
					<dd
						className={
							field.mono
								? "text-2xs min-w-0 font-mono break-words"
								: "text-2xs min-w-0 break-words"
						}
					>
						{field.value}
					</dd>
				</div>
			))}
		</dl>
	);
}

/** Render operation-specific evidence extracted from a tool result. */
function ResultFacts({
	facts,
	limit = facts.length,
}: {
	facts: ToolResultFact[];
	limit?: number;
}) {
	if (facts.length === 0) return null;
	return (
		<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
			{facts.slice(0, limit).map((fact, index) => (
				<span
					key={`${fact.label}-${fact.value}`}
					className={`text-2xs inline-flex items-center gap-1 ${
						fact.tone === "warning"
							? "text-warning-foreground"
							: fact.tone === "danger"
								? "text-destructive"
								: "text-muted-foreground"
					}`}
				>
					{index > 0 && <span className="opacity-40">·</span>}
					<span className="opacity-70">{fact.label}</span>
					<span className="text-foreground/80 font-mono">
						{fact.value}
					</span>
				</span>
			))}
		</div>
	);
}

/** Render the normalized header for a tool call. */
function ToolHeader({
	view,
	expanded,
	detailsId,
	onToggle,
}: {
	view: ToolCallView;
	expanded: boolean;
	detailsId: string;
	onToggle: () => void;
}) {
	const Icon = FAMILY_ICONS[view.family];
	return (
		<button
			type="button"
			className="tool-card__header hover:bg-accent/20 flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors"
			onClick={onToggle}
			aria-expanded={expanded}
			aria-controls={detailsId}
		>
			<span className="tool-card__icon flex h-7 w-7 shrink-0 items-center justify-center rounded">
				<Icon className="h-3.5 w-3.5" strokeWidth={1.7} />
			</span>
			<span className="min-w-0 flex-1">
				<span className="flex min-w-0 items-center gap-1.5">
					<span className="text-2xs truncate font-semibold tracking-[0.04em] uppercase">
						{view.operationLabel}
					</span>
					<span className="text-muted-foreground/70 text-2xs shrink-0 font-mono">
						{view.name}
					</span>
				</span>
				<span className="text-muted-foreground text-2xs mt-0.5 block truncate">
					{view.summary}
				</span>
			</span>
			<ChevronDown
				className={`text-muted-foreground h-3.5 w-3.5 shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`}
				strokeWidth={1.8}
			/>
		</button>
	);
}

/** Display the most useful target for the selected tool family. */
function ToolTarget({ view }: { view: ToolCallView }) {
	const target = view.command ?? view.target;
	if (!target) return null;
	return (
		<div className="flex min-w-0 items-start gap-2 px-3 py-1">
			<span className="text-muted-foreground text-2xs shrink-0 pt-px font-medium tracking-[0.08em] uppercase">
				{view.targetLabel}
			</span>
			<code
				className={
					view.command
						? "text-2xs max-h-12 min-w-0 flex-1 overflow-auto font-mono break-words whitespace-pre-wrap"
						: "text-2xs min-w-0 flex-1 truncate font-mono"
				}
				title={target}
			>
				{target}
			</code>
		</div>
	);
}

/** Display the normalized invocation and raw payload for auditability. */
function ToolInvocation({
	view,
	argumentsText,
}: {
	view: ToolCallView;
	argumentsText: string;
}) {
	return (
		<div className="grid gap-2.5">
			<ArgumentFields fields={view.fields} />
			<details className="group">
				<summary className="text-muted-foreground hover:text-foreground text-2xs cursor-pointer list-none">
					<span className="group-open:hidden">
						Show raw arguments
					</span>
					<span className="hidden group-open:inline">
						Hide raw arguments
					</span>
				</summary>
				<pre className="bg-muted/55 text-2xs mt-1.5 max-h-32 overflow-auto rounded-[2px] p-2 font-mono leading-relaxed whitespace-pre-wrap">
					{formatToolOutput(argumentsText)}
				</pre>
			</details>
		</div>
	);
}

/** Display result evidence and the escaped raw output. */
function ToolResult({
	result,
	facts,
	failed,
}: {
	result?: string;
	facts: ToolResultFact[];
	failed: boolean;
}) {
	if (result === undefined) {
		return (
			<div className="text-2xs flex items-center gap-2 px-2.5 py-2">
				<LoaderCircle className="text-brand h-3.5 w-3.5 animate-spin" />
				<span className="text-muted-foreground">
					Waiting for the host response…
				</span>
			</div>
		);
	}
	return (
		<div className="grid gap-2">
			<ResultFacts facts={facts} />
			<div>
				<div className="text-muted-foreground text-2xs mb-1 flex items-center gap-1.5 font-medium tracking-wide uppercase">
					{failed ? (
						<CircleAlert className="text-destructive h-3 w-3" />
					) : (
						<ListTree className="h-3 w-3" />
					)}
					{failed ? "Error" : "Output"}
				</div>
				<pre
					className={
						failed
							? "bg-destructive/10 text-destructive text-2xs max-h-48 overflow-auto rounded-[2px] p-2 font-mono leading-relaxed whitespace-pre-wrap"
							: "bg-muted/55 text-muted-foreground text-2xs max-h-48 overflow-auto rounded-[2px] p-2 font-mono leading-relaxed whitespace-pre-wrap"
					}
				>
					{formatToolOutput(result)}
				</pre>
			</div>
		</div>
	);
}

/** Render one security-aware, domain-specific tool call in the agent transcript. */
export function ToolCallCard({ call }: { call: ToolCallUi }) {
	const [expanded, setExpanded] = useState(false);
	const [copied, setCopied] = useState(false);
	const view = classifyToolCall(call.name, call.arguments);
	const running = call.result === undefined;
	const failed = isToolError(call.result);
	const cancelled =
		call.result?.trim().toLowerCase().startsWith("cancelled") === true;
	const facts = getToolResultFacts(view, call.result);
	const Icon = FAMILY_ICONS[view.family];
	const detailsId = `tool-call-details-${call.id}`;

	/** Copy the complete invocation and response as a compact audit trace. */
	const handleCopy = async () => {
		try {
			await navigator.clipboard.writeText(
				`${view.name} ${call.arguments}\n\n${call.result ?? "(running)"}`,
			);
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1400);
		} catch {
			setCopied(false);
		}
	};

	return (
		<article
			className="tool-card transition-colors"
			data-running={running}
			data-error={failed}
			data-cancelled={cancelled}
		>
			<ToolHeader
				view={view}
				expanded={expanded}
				detailsId={detailsId}
				onToggle={() => setExpanded((value) => !value)}
			/>
			<ToolTarget view={view} />
			{!expanded && facts.length > 0 && (
				<div className="flex min-w-0 gap-1 overflow-hidden px-3 pt-1 pb-2">
					<ResultFacts facts={facts} limit={2} />
				</div>
			)}
			{expanded && (
				<div id={detailsId} className="tool-card__body grid gap-3 p-3">
					<div>
						<div className="text-muted-foreground text-2xs mb-1.5 flex items-center gap-1.5 font-medium tracking-wide uppercase">
							<Search className="h-3 w-3" />
							Invocation
						</div>
						<ToolInvocation
							view={view}
							argumentsText={call.arguments}
						/>
					</div>
					<div>
						<div className="text-muted-foreground text-2xs mb-1.5 flex items-center gap-1.5 font-medium tracking-wide uppercase">
							{failed ? (
								<CircleAlert className="text-destructive h-3 w-3" />
							) : (
								<Icon className="h-3 w-3" />
							)}
							Evidence
						</div>
						<ToolResult
							result={call.result}
							facts={facts}
							failed={failed || cancelled}
						/>
					</div>
					<div className="flex items-center justify-between gap-2 pt-1">
						<span className="text-muted-foreground text-2xs min-w-0 truncate">
							Trace · {view.name}
						</span>
						<Button
							variant="ghost"
							size="sm"
							className="shrink-0"
							onClick={() => void handleCopy()}
							title="Copy invocation and result"
							aria-label="Copy invocation and result"
						>
							{copied ? (
								<Check className="h-3 w-3" />
							) : (
								<Copy className="h-3 w-3" />
							)}
							{copied ? "Copied" : "Copy trace"}
						</Button>
					</div>
				</div>
			)}
		</article>
	);
}
