import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { ActivityBar } from "@/components/ActivityBar";
import { AgentChat } from "@/components/AgentChat";
import { CenterPanel } from "@/components/CenterPanel";
import { CommandPalette } from "@/components/CommandPalette";
import { DebuggerSettingsDialog } from "@/components/DebuggerSettingsDialog";
import { NewProjectDialog } from "@/components/NewProjectDialog";
import { MenuBar } from "@/components/MenuBar";
import { ProjectScreen } from "@/components/ProjectScreen";
import { Sidebar } from "@/components/Sidebar";
import { useResizableColumn } from "@/components/ui/resizable-column";
import { CHAT_DEFAULT } from "@/lib/chatWidth";
import { SIDEBAR_DEFAULT } from "@/lib/sidebarWidth";
import { useBinaryStore } from "@/store/binaryStore";
import { useDebugStore } from "@/store/debugStore";
import { useLlmStore } from "@/store/llmStore";
import { useContextStore } from "@/store/contextStore";
import { useProjectStore } from "@/store/projectStore";
import { useSettingsStore } from "@/store/settingsStore";
import { useUiStore } from "@/store/uiStore";
import { useUpdateStore } from "@/store/updateStore";

function App() {
	const binary = useBinaryStore((s) => s.binary);
	const err = useUiStore((s) => s.err);
	const setErr = useUiStore((s) => s.setErr);
	const chatOpen = useUiStore((s) => s.chatOpen);
	const setChatOpen = useUiStore((s) => s.setChatOpen);
	const chatInputRef = useRef<HTMLTextAreaElement | null>(null);
	const debuggerSettingsOpen = useUiStore((s) => s.debuggerSettingsOpen);
	const setDebuggerSettingsOpen = useUiStore(
		(s) => s.setDebuggerSettingsOpen,
	);
	// The grid is state, not a ref: it is a value the layout reads during render,
	// and a ref would put the columns in reach of it.
	const [grid, setGrid] = useState<HTMLDivElement | null>(null);
	// Both columns read each other off the grid, so neither has to know the other
	// one's render order; each charges the centre's floor against the width its
	// sibling is really holding.
	const sidebar = useResizableColumn("sidebar", grid);
	const chat = useResizableColumn("chat", grid);

	useEffect(() => {
		useLlmStore.getState().init();
		useSettingsStore.getState().initZoom();
		useSettingsStore.getState().initTheme();
		// Came in with the header that used to hold it: the backend actually in use
		// is the backend's answer, not whatever localStorage last remembered.
		void useSettingsStore.getState().initBackend();
		useProjectStore.getState().loadProjects();
		void useUpdateStore.getState().checkForUpdates();
	}, []);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (!(e.ctrlKey || e.metaKey)) return;
			const k = e.key.toLowerCase();
			if (k === "=" || k === "+") {
				e.preventDefault();
				useSettingsStore.getState().zoomIn();
			} else if (k === "-") {
				e.preventDefault();
				useSettingsStore.getState().zoomOut();
			} else if (k === "0") {
				e.preventDefault();
				useSettingsStore.getState().resetZoom();
			} else if (k === "n") {
				e.preventDefault();
				if (!useBinaryStore.getState().binary) {
					useUiStore.getState().setNewProjectOpen(true);
				}
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const dbg = useDebugStore.getState();
			if (!dbg.active) return;
			if (e.key === "F7") {
				e.preventDefault();
				void dbg.run("step", { kind: "into" });
			} else if (e.key === "F8") {
				e.preventDefault();
				void dbg.run("step", { kind: "over" });
			} else if (e.key === "F9") {
				e.preventDefault();
				void dbg.run("continue");
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "l") {
				e.preventDefault();
				useContextStore.getState().commitPending();
				setChatOpen(true);
				setTimeout(() => chatInputRef.current?.focus(), 0);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [setChatOpen]);

	return (
		<div className="flex h-full flex-col">
			{/* The bar is the top row, where the title bar was: a window's menus sit
			    above its content, not below a heading. */}
			<MenuBar />

			{err && (
				<div className="border-destructive bg-destructive/15 text-destructive flex items-center justify-between gap-2 border-b px-3 py-1.5 text-xs">
					{err}
					<Button
						variant="ghost"
						size="sm"
						onClick={() => setErr(null)}
					>
						✕
					</Button>
				</div>
			)}

			{!binary ? (
				<ProjectScreen />
			) : (
				<div className="flex min-h-0 flex-1 overflow-hidden">
					<ActivityBar />
					<div
						ref={setGrid}
						className="grid min-h-0 min-w-0 flex-1 overflow-hidden"
						style={{
							// The widths live in CSS variables so a drag can write
							// them without re-rendering the panels either side; the
							// fallbacks are what the panes start at before that.
							gridTemplateColumns: chatOpen
								? `var(--recurse-sidebar, ${SIDEBAR_DEFAULT}px) 4px minmax(0, 1fr) 4px var(--recurse-chat, ${CHAT_DEFAULT}px)`
								: `var(--recurse-sidebar, ${SIDEBAR_DEFAULT}px) 4px minmax(0, 1fr)`,
						}}
					>
						<aside className="border-border bg-card flex min-h-0 min-w-0 flex-col border-r">
							<Sidebar />
						</aside>

						<div {...sidebar.divider} />

						<CenterPanel />

						{chatOpen && (
							<>
								<div {...chat.divider} />
								<aside className="border-border bg-card flex min-h-0 min-w-0 flex-col border-l">
									<AgentChat inputRef={chatInputRef} />
								</aside>
							</>
						)}
					</div>
				</div>
			)}

			<CommandPalette />
			<NewProjectDialog />
			<DebuggerSettingsDialog
				open={debuggerSettingsOpen}
				onOpenChange={setDebuggerSettingsOpen}
			/>
		</div>
	);
}

export default App;
