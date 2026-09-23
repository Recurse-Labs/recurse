import { useEffect, useRef } from "react";

import { Button } from "@/components/ui/button";
import { ActivityBar } from "@/components/ActivityBar";
import { AgentChat } from "@/components/AgentChat";
import { CenterPanel } from "@/components/CenterPanel";
import { CommandPalette } from "@/components/CommandPalette";
import { FunctionList } from "@/components/FunctionList";
import { Header } from "@/components/Header";
import { NewProjectDialog } from "@/components/NewProjectDialog";
import { ProjectScreen } from "@/components/ProjectScreen";
import { StatusBar } from "@/components/StatusBar";
import { useBinaryStore } from "@/store/binaryStore";
import { useDebugStore } from "@/store/debugStore";
import { useLlmStore } from "@/store/llmStore";
import { useContextStore } from "@/store/contextStore";
import { useProjectStore } from "@/store/projectStore";
import { useSettingsStore } from "@/store/settingsStore";
import { useUiStore } from "@/store/uiStore";

function App() {
	const binary = useBinaryStore((s) => s.binary);
	const err = useUiStore((s) => s.err);
	const setErr = useUiStore((s) => s.setErr);
	const chatOpen = useUiStore((s) => s.chatOpen);
	const setChatOpen = useUiStore((s) => s.setChatOpen);
	const chatInputRef = useRef<HTMLTextAreaElement | null>(null);

	useEffect(() => {
		useLlmStore.getState().init();
		useSettingsStore.getState().initZoom();
		useSettingsStore.getState().initTheme();
		useProjectStore.getState().loadProjects();
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
			<Header />

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
						className="grid min-h-0 min-w-0 flex-1 overflow-hidden"
						style={{
							gridTemplateColumns: chatOpen
								? "260px 1fr 340px"
								: "260px 1fr",
						}}
					>
						<aside className="border-border bg-card flex min-h-0 min-w-0 flex-col border-r">
							<FunctionList />
						</aside>

						<CenterPanel />

						{chatOpen && (
							<aside className="border-border bg-card flex min-h-0 min-w-0 flex-col border-l">
								<AgentChat inputRef={chatInputRef} />
							</aside>
						)}
					</div>
				</div>
			)}

			{binary && <StatusBar />}
			<CommandPalette />
			<NewProjectDialog />
			<CommandPalette />
		</div>
	);
}

export default App;
