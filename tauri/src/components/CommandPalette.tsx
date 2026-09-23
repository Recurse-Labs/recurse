import { useEffect, useMemo, useRef, useState } from "react";

import { api, pickBinary } from "@/api";
import { chrome } from "@/lib/chrome";
import { cn } from "@/lib/utils";
import { useAnalysisStore } from "@/store/analysisStore";
import { useBinaryStore } from "@/store/binaryStore";
import { useDebugStore } from "@/store/debugStore";
import { useProjectStore } from "@/store/projectStore";
import { useSettingsStore } from "@/store/settingsStore";
import { useUiStore } from "@/store/uiStore";
import type { CenterTab, Function } from "@/types";

function fmtAddr(a: number): string {
	return `0x${a.toString(16)}`;
}

interface Command {
	id: string;
	title: string;
	hint?: string;
	run: () => void;
}

const TAB_LABEL: Record<CenterTab, string> = {
	recon: "Recon",
	disasm: "Disassembly",
	callgraph: "Call Graph",
	strings: "Strings",
	imports: "Imports",
	findings: "Findings",
	hex: "Hex view",
	debug: "Debug",
	console: "Console",
};

/** Every command the palette can run, resolved from the stores at open time. */
function buildCommands(): Command[] {
	const ui = useUiStore.getState();
	const bin = useBinaryStore.getState();
	const dbg = useDebugStore.getState();
	const settings = useSettingsStore.getState();

	const cmds: Command[] = [
		{
			id: "open",
			title: "Open binary…",
			hint: "Ctrl+O",
			run: () => {
				void pickBinary().then((p) => {
					if (p) void bin.openBinary(p);
				});
			},
		},
		{
			id: "model-picker",
			title: "Switch model / provider…",
			run: () => ui.setModelPickerOpen(true),
		},
	];
	if (!bin.binary) {
		cmds.push({
			id: "new-project",
			title: "New project…",
			run: () => ui.setNewProjectOpen(true),
		});
	}
	if (bin.binary) {
		cmds.push({
			id: "close",
			title: "Close project",
			run: () => void useProjectStore.getState().close(),
		});
		for (const tab of Object.keys(TAB_LABEL) as CenterTab[]) {
			cmds.push({
				id: `tab-${tab}`,
				title: `Go to ${TAB_LABEL[tab]}`,
				run: () => ui.setTab(tab),
			});
		}
		cmds.push({
			id: "chat",
			title: "Toggle agent chat",
			hint: "Ctrl+L",
			run: () => ui.toggleChat(),
		});
	}
	cmds.push(
		{
			id: "engine-native",
			title: "Analysis engine: native (pure Rust)",
			run: () => void settings.setBackend("native"),
		},
		{
			id: "engine-r2",
			title: "Analysis engine: r2",
			run: () => void settings.setBackend("r2"),
		},
		{
			id: "toggle-theme",
			title: "Toggle light / dark theme",
			run: () => settings.toggleTheme(),
		},
	);

	if (dbg.active) {
		cmds.push(
			{
				id: "dbg-run",
				title: "Debug: Run",
				hint: "F9",
				run: () => void dbg.run("continue"),
			},
			{
				id: "dbg-pause",
				title: "Debug: Pause",
				run: () => void dbg.run("interrupt"),
			},
			{
				id: "dbg-into",
				title: "Debug: Step into",
				hint: "F7",
				run: () => void dbg.run("step", { kind: "into" }),
			},
			{
				id: "dbg-over",
				title: "Debug: Step over",
				hint: "F8",
				run: () => void dbg.run("step", { kind: "over" }),
			},
			{
				id: "dbg-out",
				title: "Debug: Step out",
				run: () => void dbg.run("step", { kind: "out" }),
			},
			{
				id: "dbg-detach",
				title: "Debug: Detach",
				run: () => void dbg.run("detach"),
			},
		);
	}

	return cmds;
}

/** Resolve a typed address/symbol and select the function containing it. */
function gotoQuery(query: string): void {
	const q = query.trim();
	if (!q) return;
	const addr = /^0x[0-9a-f]+$/i.test(q)
		? Number.parseInt(q.slice(2), 16)
		: /^\d+$/.test(q)
			? Number.parseInt(q, 10)
			: null;
	const analysis = useAnalysisStore.getState();
	if (addr != null) {
		api.functionAt(addr)
			.then((f) => {
				if (f) analysis.selectFn(f);
				else useUiStore.getState().setTab("disasm");
			})
			.catch(() => {});
		return;
	}
	// A symbol: the analysis engine resolves names through the same store path
	// the agent uses, so a function whose name matches is enough.
	const match = analysis.funcs.find(
		(f) =>
			(f.name ?? "").toLowerCase() === q.toLowerCase() ||
			(f.name ?? "").toLowerCase().includes(q.toLowerCase()),
	);
	if (match) analysis.selectFn(match);
}

type Entry =
	| { kind: "command"; command: Command }
	| { kind: "function"; fn: Function };

/**
 * Ctrl+K command palette: open a binary, jump to a tab or function, drive the
 * debugger, or type an address/symbol to go there. The one place that reaches
 * every action. Mounted once at the app root; owns its own open state and
 * global keydown listener.
 */
export function CommandPalette() {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [active, setActive] = useState(0);
	const listRef = useRef<HTMLDivElement>(null);

	const binary = useBinaryStore((s) => s.binary);
	const funcs = useAnalysisStore((s) => s.funcs);
	const selectFn = useAnalysisStore((s) => s.selectFn);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
				e.preventDefault();
				setOpen((o) => !o);
				setQuery("");
				setActive(0);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	const commands = useMemo(() => (open ? buildCommands() : []), [open]);

	const q = query.trim().toLowerCase();

	const matchedFunctions = useMemo(() => {
		if (!q || !binary) return [];
		return funcs
			.filter((f) => (f.name ?? "").toLowerCase().includes(q))
			.slice(0, 30);
	}, [funcs, q, binary]);

	const matchedCommands = useMemo(
		() =>
			q
				? commands.filter((c) => c.title.toLowerCase().includes(q))
				: commands,
		[commands, q],
	);

	const entries: Entry[] = [
		...matchedFunctions.map((fn) => ({ kind: "function" as const, fn })),
		...matchedCommands.map((command) => ({
			kind: "command" as const,
			command,
		})),
	];

	const close = () => setOpen(false);
	const runEntry = (entry: Entry) => {
		close();
		if (entry.kind === "command") entry.command.run();
		else selectFn(entry.fn);
	};

	const onKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Escape") {
			e.preventDefault();
			close();
		} else if (e.key === "ArrowDown") {
			e.preventDefault();
			setActive((a) => Math.min(a + 1, entries.length - 1));
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			setActive((a) => Math.max(a - 1, 0));
		} else if (e.key === "Enter") {
			e.preventDefault();
			const entry = entries[active];
			if (entry) runEntry(entry);
			else if (query.trim()) {
				close();
				gotoQuery(query);
			}
		}
	};

	if (!open) return null;
	return (
		<div
			className="fixed inset-0 z-50 flex justify-center bg-black/40 pt-[12vh]"
			onClick={close}
		>
			<div
				className="bg-popover border-border flex max-h-[60vh] w-[min(560px,92vw)] flex-col overflow-hidden rounded-lg border shadow-2xl"
				onClick={(e) => e.stopPropagation()}
			>
				<input
					autoFocus
					value={query}
					onChange={(e) => {
						setQuery(e.target.value);
						setActive(0);
					}}
					onKeyDown={onKeyDown}
					placeholder={
						binary
							? "type a function name, address, or command…"
							: "type a command…"
					}
					className="placeholder:text-muted-foreground/60 w-full bg-transparent px-3.5 py-3 text-sm outline-none"
				/>
				<div
					ref={listRef}
					className="border-border scroll-host min-h-0 overflow-auto border-t p-1"
				>
					{entries.length === 0 && query.trim() === "" && (
						<div className="text-muted-foreground px-3 py-6 text-center text-xs">
							No commands.
						</div>
					)}
					{entries.map((entry, i) => (
						<button
							key={
								entry.kind === "command"
									? entry.command.id
									: `fn-${entry.fn.addr}`
							}
							onMouseEnter={() => setActive(i)}
							onClick={() => runEntry(entry)}
							className={cn(
								chrome.row,
								"w-full rounded text-left text-sm",
								i === active
									? chrome.selected
									: "hover:bg-accent",
							)}
						>
							{entry.kind === "command" ? (
								<>
									<span className="truncate">
										{entry.command.title}
									</span>
									{entry.command.hint && (
										<span className="text-kbd text-2xs ml-auto">
											{entry.command.hint}
										</span>
									)}
								</>
							) : (
								<>
									<span className="min-w-0 flex-1 truncate">
										{entry.fn.name ??
											`sub_${entry.fn.addr.toString(16)}`}
									</span>
									<span className="text-muted-foreground ml-auto font-mono text-2xs">
										{fmtAddr(entry.fn.addr)}
									</span>
								</>
							)}
						</button>
					))}
					{entries.length === 0 && query.trim() && (
						<button
							onClick={() => {
								close();
								gotoQuery(query);
							}}
							className={cn(
								chrome.row,
								chrome.selected,
								"w-full rounded text-left text-sm",
							)}
						>
							Go to “{query.trim()}”
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
