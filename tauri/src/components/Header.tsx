import { useEffect } from "react";
import { Moon, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { LogoMark } from "@/components/Logo";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { chrome } from "@/lib/chrome";
import { cn } from "@/lib/utils";
import { useBinaryStore } from "@/store/binaryStore";
import { useProjectStore } from "@/store/projectStore";
import { useUiStore } from "@/store/uiStore";
import { useSettingsStore } from "@/store/settingsStore";

export function Header() {
	const binary = useBinaryStore((s) => s.binary);
	const busy = useBinaryStore((s) => s.busy);
	const project = useProjectStore((s) => s.current);
	const close = useProjectStore((s) => s.close);
	const chatOpen = useUiStore((s) => s.chatOpen);
	const toggleChat = useUiStore((s) => s.toggleChat);
	const zoomLevel = useSettingsStore((s) => s.zoomLevel);
	const zoomIn = useSettingsStore((s) => s.zoomIn);
	const zoomOut = useSettingsStore((s) => s.zoomOut);
	const resetZoom = useSettingsStore((s) => s.resetZoom);
	const backend = useSettingsStore((s) => s.backend);
	const setBackend = useSettingsStore((s) => s.setBackend);
	const initBackend = useSettingsStore((s) => s.initBackend);
	const theme = useSettingsStore((s) => s.theme);
	const toggleTheme = useSettingsStore((s) => s.toggleTheme);

	useEffect(() => {
		void initBackend();
	}, [initBackend]);

	const zoomPct = Math.round(Math.pow(1.2, zoomLevel) * 100);

	return (
		<header className="border-border bg-card ui-bar border-b px-3">
			<div className="flex min-w-0 items-center gap-2">
				<LogoMark className="h-5 w-auto" />
				<span className="text-sm font-semibold tracking-wide">
					Recurse
				</span>
				<span className="text-muted-foreground text-xs">
					agentic reverse engineering
				</span>
			</div>

			{binary && project && (
				<div className="flex min-w-0 flex-1 items-center overflow-hidden px-3">
					<Badge variant="outline" className="font-mono">
						{project.name}
					</Badge>
				</div>
			)}

			<div className="ml-auto flex items-center">
				{binary && (
					<Button
						variant="toolbar"
						size="sm"
						className={chrome.press}
						aria-pressed={chatOpen}
						onClick={toggleChat}
						title="Toggle agent chat (Ctrl+L)"
					>
						Chat
					</Button>
				)}
				{binary && (
					<Button
						variant="toolbar"
						size="sm"
						onClick={close}
						disabled={busy}
					>
						Close
					</Button>
				)}
				<Button
					variant="ghost"
					size="icon"
					onClick={toggleTheme}
					title={
						theme === "dark"
							? "Switch to light theme"
							: "Switch to dark theme"
					}
				>
					{theme === "dark" ? <Sun /> : <Moon />}
				</Button>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button variant="toolbar" size="sm">
							Settings
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="min-w-56">
						<DropdownMenuLabel>
							Zoom
							<span className={chrome.kbd}>{zoomPct}%</span>
						</DropdownMenuLabel>
						<DropdownMenuItem onClick={zoomIn}>
							Zoom in
							<DropdownMenuShortcut>Ctrl +</DropdownMenuShortcut>
						</DropdownMenuItem>
						<DropdownMenuItem onClick={zoomOut}>
							Zoom out
							<DropdownMenuShortcut>Ctrl −</DropdownMenuShortcut>
						</DropdownMenuItem>
						<DropdownMenuItem onClick={resetZoom}>
							Reset zoom
							<DropdownMenuShortcut>Ctrl 0</DropdownMenuShortcut>
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuLabel>Analysis engine</DropdownMenuLabel>
						<DropdownMenuItem
							className={cn(
								backend === "native" && chrome.selected,
							)}
							onClick={() => void setBackend("native")}
						>
							<span className="flex-1">Native</span>
							<span className="text-2xs opacity-70">default</span>
						</DropdownMenuItem>
						<DropdownMenuItem
							className={cn(backend === "r2" && chrome.selected)}
							onClick={() => void setBackend("r2")}
						>
							<span className="flex-1">radare2</span>
							<span className="text-2xs opacity-70">opt-in</span>
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
		</header>
	);
}
