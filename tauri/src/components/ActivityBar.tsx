import {
	Bug,
	Code2,
	FileSearch,
	FileText,
	Info,
	MessageSquare,
	Package,
	Quote,
	Share2,
	Terminal,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { useBinaryStore } from "@/store/binaryStore";
import { useUiStore } from "@/store/uiStore";
import type { CenterTab } from "@/types";

/** One view in the rail: a center tab, its icon, and its tooltip. */
interface View {
	tab: CenterTab;
	icon: LucideIcon;
	label: string;
}

const VIEWS: View[] = [
	{ tab: "recon", icon: Info, label: "Recon" },
	{ tab: "disasm", icon: Code2, label: "Disassembly" },
	{ tab: "callgraph", icon: Share2, label: "Call Graph" },
	{ tab: "debug", icon: Bug, label: "Debug" },
	{ tab: "strings", icon: Quote, label: "Strings" },
	{ tab: "imports", icon: Package, label: "Imports" },
	{ tab: "findings", icon: FileSearch, label: "Findings" },
	{ tab: "hex", icon: FileText, label: "Hex" },
	{ tab: "console", icon: Terminal, label: "Console" },
];

/**
 * The far-left icon rail: one square button per center view, the current one
 * marked with an accent bar on its leading edge. The agent chat lives in its
 * own column rather than a tab, so it is toggled from the foot of the rail.
 *
 * ```
 * <ActivityBar />
 * // clicking the Code2 entry sets the center tab to "disasm"
 * ```
 */
export function ActivityBar() {
	const tab = useUiStore((s) => s.tab);
	const setTab = useUiStore((s) => s.setTab);
	const chatOpen = useUiStore((s) => s.chatOpen);
	const toggleChat = useUiStore((s) => s.toggleChat);
	// The raw console is a backend capability; hide it when it is absent.
	const capabilities = useBinaryStore((s) => s.binary?.capabilities);
	const views = VIEWS.filter(
		(v) => v.tab !== "console" || capabilities?.raw !== false,
	);

	return (
		<nav
			className="ui-activity flex min-h-0 flex-col items-center"
			aria-label="Views"
		>
			<div className="flex w-full flex-col">
				{views.map((v) => (
					<button
						key={v.tab}
						type="button"
						title={v.label}
						aria-label={v.label}
						aria-pressed={tab === v.tab}
						onClick={() => setTab(v.tab)}
					>
						<v.icon
							className="h-[18px] w-[18px]"
							strokeWidth={1.6}
						/>
					</button>
				))}
			</div>

			<button
				type="button"
				className="mt-auto"
				title="Toggle agent chat (Ctrl+L)"
				aria-label="Agent chat"
				aria-pressed={chatOpen}
				onClick={toggleChat}
			>
				<MessageSquare
					className="h-[18px] w-[18px]"
					strokeWidth={1.6}
				/>
			</button>
		</nav>
	);
}
