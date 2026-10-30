import {
	memo,
	useCallback,
	useEffect,
	useRef,
	useState,
	type RefObject,
} from "react";
import { ArrowUp, Square } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { composerHeight, composerLines } from "@/lib/composerHeight";
import { api } from "@/api";
import { Markdown } from "@/components/Markdown";
import { ToolCallCard } from "@/components/ToolCallCard";
import { ModelPicker } from "@/components/ModelPicker";
import { useLlmStore } from "@/store/llmStore";
import { useAgentStore, type UiBlock } from "@/store/agentStore";
import { useContextStore } from "@/store/contextStore";
import { useSessionStore } from "@/store/sessionStore";
import type { ContextItem } from "@/types";

function fmtDate(secs: number): string {
	const d = new Date(secs * 1000);
	return Number.isNaN(d.getTime())
		? ""
		: d.toLocaleDateString(undefined, {
				month: "short",
				day: "numeric",
			});
}

interface Props {
	inputRef?: RefObject<HTMLTextAreaElement | null>;
}

/**
 * How close to the bottom still counts as being at the bottom, in pixels.
 *
 * A fraction of a scroll step rather than zero: "scrollTop + clientHeight ===
 * scrollHeight" is never quite true once a subpixel is involved, and a reader
 * who has scrolled to the end by dragging would be treated as looking back and
 * the transcript would stop following.
 */
const TAIL_SLOP = 4;

export function AgentChat({ inputRef }: Props) {
	const messages = useAgentStore((s) => s.messages);
	const busy = useAgentStore((s) => s.busy);
	const send = useAgentStore((s) => s.send);
	const prevBusy = useRef(false);

	const items = useContextStore((s) => s.items);
	const removeItem = useContextStore((s) => s.remove);
	const sessions = useSessionStore((s) => s.sessions);
	const current = useSessionStore((s) => s.current);
	const sessionsLoading = useSessionStore((s) => s.loading);
	const sessionsError = useSessionStore((s) => s.error);
	const createSession = useSessionStore((s) => s.create);
	const refreshSessions = useSessionStore((s) => s.refresh);

	const [input, setInput] = useState("");
	const [showSessions, setShowSessions] = useState(
		() => !useSessionStore.getState().current,
	);
	const scrollRef = useRef<HTMLDivElement>(null);
	// The transcript's content, observed rather than measured. See the effect
	// that pins to the bottom for why the two are separate nodes.
	const transcriptRef = useRef<HTMLDivElement>(null);
	// Whether the reader is looking back through the transcript.
	const atTail = useRef(true);

	const provider = useLlmStore((s) => s.provider);
	const configured = useLlmStore((s) => s.configured);

	// Refresh after completion so the generated session name appears on home.
	useEffect(() => {
		if (prevBusy.current && !busy) {
			void refreshSessions();
		}
		prevBusy.current = busy;
	}, [busy, refreshSessions]);

	// Follow the tail as the reply grows. A ResizeObserver on the content, not an
	// effect keyed on `messages` that reads `scrollHeight`: an observer is called
	// once the browser has already laid out, so the read is free, where reading
	// it during a commit forces the whole pane to lay out again — and this runs
	// on every frame of a stream.
	//
	// Tail detection is what makes it a chat rather than a ticker. A transcript
	// that always jumps to the newest token makes scrolling back to re-read an
	// answer impossible, which is the one thing a long reply makes you want to
	// do, so the pin only holds while the reader is already at the bottom.
	const onTranscriptScroll = useCallback(() => {
		const el = scrollRef.current;
		if (!el) return;
		atTail.current =
			el.scrollHeight - el.scrollTop - el.clientHeight < TAIL_SLOP;
	}, []);

	useEffect(() => {
		const scroller = scrollRef.current;
		const content = transcriptRef.current;
		if (!scroller || !content) return;
		scroller.addEventListener("scroll", onTranscriptScroll, {
			passive: true,
		});
		const observer = new ResizeObserver(() => {
			if (atTail.current) scroller.scrollTop = scroller.scrollHeight;
		});
		observer.observe(content);
		return () => {
			scroller.removeEventListener("scroll", onTranscriptScroll);
			observer.disconnect();
		};
	}, [onTranscriptScroll]);

	// Opening or closing the session list swaps the scroll container's contents
	// without changing its height, so the observer does not fire for it.
	useEffect(() => {
		const el = scrollRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [showSessions]);

	const openSessions = () => {
		setShowSessions(true);
		void refreshSessions();
	};

	const startNewChat = async () => {
		if (busy) return;
		await createSession();
		setShowSessions(false);
	};

	const selectSession = async (id: string) => {
		if (busy) return;
		await useSessionStore.getState().select(id);
		setShowSessions(false);
	};

	const doSend = async () => {
		const text = input.trim();
		if (!text || busy) return;
		setInput("");
		setShowSessions(false);
		const ctxs = useContextStore.getState().items;
		const sessionId = useSessionStore.getState().current?.id ?? "";
		await send(text, ctxs, sessionId);
	};

	// Grow the box with what is being typed, up to a ceiling, then scroll. Not a
	// CSS `field-sizing: content` because that is not yet in the WebView this
	// ships in, and not a height derived from `input` in state because that
	// re-renders the composer on every keystroke to set a number the DOM already
	// knows. The height is written straight to the element, the way the divider
	// drags write their position, so typing causes one style write and no
	// render.
	//
	// Reset to the minimum first: a box that has grown keeps its height when the
	// text is deleted otherwise, and the box stays tall for one line of typing.
	const autoGrow = useCallback((e: React.FormEvent<HTMLTextAreaElement>) => {
		const el = e.currentTarget;
		// The box's own line height, not a constant: at 11px on 1.45 it is
		// 15.95px, and assuming 20px made every line of growth a quarter taller
		// than the text it was making room for.
		const lineHeight = parseFloat(getComputedStyle(el).lineHeight);
		el.style.height = "auto";
		el.style.height = `${composerHeight(lineHeight, composerLines(el.scrollHeight, lineHeight))}px`;
		// Past the ceiling the box scrolls instead of growing, and a box that has
		// stopped growing does not bring its own caret into view.
		el.scrollTop = el.scrollHeight;
	}, []);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="border-border ui-bar border-b px-2">
				{showSessions ? (
					<span className="ui-panel-title">Sessions</span>
				) : (
					<Button
						variant="toolbar"
						size="sm"
						onClick={openSessions}
						title="Sessions"
					>
						Sessions
					</Button>
				)}
				{!showSessions && (
					<span className="ui-panel-title text-muted-foreground">
						{current?.name ?? "Chat"}
					</span>
				)}
				<Button
					variant="toolbar"
					size="sm"
					className="ml-auto"
					onClick={() => void startNewChat()}
					title="New chat"
				>
					New
				</Button>
			</div>

			{!configured && (
				<div className="border-border text-warning-foreground bg-warning/10 border-b px-3 py-1.5 text-xs">
					Set your{" "}
					<code className="font-mono">
						{provider.toUpperCase().replace(/_/g, " ")} API key
					</code>{" "}
					via the model menu.
				</div>
			)}

			<div
				ref={scrollRef}
				className="scroll-host min-h-0 flex-1 overflow-y-auto"
			>
				{/* The observed element. Separate from the scroller because a
				    ResizeObserver has to watch the thing that changed size, and the
				    scroller's own box does not grow as the reply streams — only its
				    content does. */}
				<div ref={transcriptRef} className="flex flex-col gap-2.5 p-4">
					{showSessions && (
						<div className="flex flex-col gap-3">
							{sessionsError && (
								<div className="bg-destructive/10 text-destructive rounded-md px-3 py-2 text-xs">
									{sessionsError}
								</div>
							)}
							{sessionsLoading ? (
								<div className="text-muted-foreground px-2 py-3 text-xs">
									Loading sessions…
								</div>
							) : sessions.length > 0 ? (
								<ul className="border-border overflow-hidden rounded-[var(--radius-control)] border">
									{sessions.map((s) => {
										const active = current?.id === s.id;
										return (
											<li key={s.id} className="min-w-0">
												<button
													type="button"
													onClick={() =>
														void selectSession(s.id)
													}
													className={cn(
														"hover:bg-accent focus-visible:ring-ring flex w-full min-w-0 flex-col px-3 py-2 text-left focus-visible:ring-1",
														active && "ui-selected",
													)}
												>
													<span className="block max-w-full truncate text-xs font-medium">
														{s.name}
													</span>
													<span className="text-2xs mt-0.5 block truncate opacity-70">
														{fmtDate(s.updated_at)}
													</span>
												</button>
											</li>
										);
									})}
								</ul>
							) : (
								<div className="text-muted-foreground border-border rounded-[var(--radius-control)] border px-3 py-8 text-center text-xs">
									No chats yet. Start one with New.
								</div>
							)}
						</div>
					)}
					{!showSessions &&
						messages.map((m) => (
							<div key={m.id} className="chat-message">
								{m.role === "user" ? (
									<UserMessage
										blocks={m.blocks}
										contextRefs={m.contextRefs}
										contextItems={m.contextItems}
									/>
								) : (
									<AssistantMessage
										blocks={m.blocks}
										pending={m.pending}
										error={m.error}
									/>
								)}
							</div>
						))}
				</div>
			</div>

			<div className="border-border border-t p-2">
				<div className="ui-composer">
					{items.length > 0 && (
						<div className="flex flex-wrap gap-1 px-1">
							{items.map((it) => (
								<Badge
									key={it.id}
									variant="secondary"
									className="text-2xs font-mono"
								>
									<span className="max-w-[180px] truncate">
										{it.label}
									</span>
									<button
										className="hover:text-destructive ml-1"
										onClick={() => removeItem(it.id)}
										title="Remove from context"
										aria-label="Remove from context"
									>
										×
									</button>
								</Badge>
							))}
						</div>
					)}
					<div className="flex items-end gap-1.5">
						<Textarea
							ref={inputRef}
							placeholder="Ask the agent"
							rows={1}
							onInput={autoGrow}
							className="min-h-[1.25rem] flex-1 resize-none overflow-y-auto border-0 bg-transparent px-1 py-1 text-xs shadow-none focus-visible:ring-0"
							value={input}
							onChange={(e) => setInput(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && !e.shiftKey) {
									e.preventDefault();
									doSend();
								}
							}}
						/>
						{busy ? (
							<Button
								variant="destructive"
								size="icon"
								className="size-[1.5rem] rounded-full"
								onClick={() => void api.agentCancel()}
								title="Stop the agent (lands between tool steps)"
								aria-label="Stop the agent"
							>
								<Square className="size-2.5 fill-current" />
							</Button>
						) : (
							<Button
								size="icon"
								className="size-[1.5rem] rounded-full"
								onClick={doSend}
								disabled={!input.trim()}
								title="Send"
								aria-label="Send"
							>
								<ArrowUp className="size-3" />
							</Button>
						)}
					</div>
					{/* Inside the same box rather than below it. The model is a property
					    of the message about to be sent, so it belongs on the thing that
					    sends it; a row of its own made the composer two controls that had
					    to be read together anyway. */}
					<div className="flex items-center justify-between gap-2 px-0.5">
						<ModelPicker />
					</div>
				</div>
			</div>
		</div>
	);
}

function ReasoningBlock({ text }: { text: string }) {
	return (
		<div className="border-primary/50 text-muted-foreground mb-1.5 border-l-2 pl-2">
			<div className="text-2xs tracking-wider uppercase">Thinking</div>
			<div className="text-muted-foreground/80 mt-1 break-words whitespace-pre-wrap">
				{text}
			</div>
		</div>
	);
}

/**
 * One question the analyst asked, as a bubble against the far edge.
 *
 * Memoized for the same reason `AssistantMessage` is: a streaming reply
 * re-renders the transcript on every frame, and every question already asked is
 * a question that did not change. Its blocks arrive by identity, so the
 * comparison is free.
 *
 * @param props.blocks - The turn's blocks; only its content is shown.
 * @param props.contextRefs - Labels of the context attached to the question.
 * @param props.contextItems - The attached context, shown as collapsible
 *   excerpts under the question.
 * @returns The rendered question.
 */
const UserMessage = memo(function UserMessage({
	blocks,
	contextRefs,
	contextItems,
}: {
	blocks: UiBlock[];
	contextRefs?: string[];
	contextItems?: ContextItem[];
}) {
	return (
		<div className="chat-turn flex justify-end">
			<div className="bg-secondary text-secondary-foreground max-w-[92%] rounded-lg px-2.5 py-2 text-xs leading-relaxed break-words whitespace-pre-wrap">
				{blocks
					.filter((b) => b.kind === "content")
					.map((b) => (b.kind === "content" ? b.text : ""))
					.join("")}
				{contextItems && contextItems.length > 0 ? (
					<div className="mt-1.5 space-y-1">
						{contextItems.map((c) => (
							<details
								key={c.id}
								className="bg-foreground/5 overflow-hidden rounded"
							>
								<summary className="text-muted-foreground text-2xs cursor-pointer px-1.5 py-1 font-mono select-none">
									{c.source} · {c.label}
								</summary>
								<pre className="scroll-host max-h-56 overflow-auto px-2 pb-1.5 font-mono text-[10px] leading-snug whitespace-pre">
									{c.text}
								</pre>
							</details>
						))}
					</div>
				) : (
					contextRefs &&
					contextRefs.length > 0 && (
						<div className="mt-1.5 flex flex-wrap gap-1">
							{contextRefs.map((ref, i) => (
								<span
									key={i}
									className="bg-foreground/10 text-2xs rounded px-1 py-px font-mono"
								>
									{ref}
								</span>
							))}
						</div>
					)
				)}
			</div>
		</div>
	);
});

/**
 * One assistant turn: its reasoning, its tool calls, and its answer.
 *
 * Memoized because a streaming reply re-renders the whole transcript on every
 * frame, and every settled turn in it is a turn that did not change. Without
 * this, a two-hundred-turn conversation re-renders all two hundred turns once a
 * frame for the sake of the one being written.
 *
 * `blocks` is compared by identity, which the store guarantees: a turn that has
 * not been appended to is handed over as the very same array.
 *
 * @param props.blocks - The turn's blocks, in the order they happened.
 * @param props.pending - Whether the turn is still being written.
 * @param props.error - The turn's failure, when it failed.
 * @returns The rendered turn.
 */
const AssistantMessage = memo(function AssistantMessage({
	blocks,
	pending,
	error,
}: {
	blocks: UiBlock[];
	pending: boolean;
	error?: string;
}) {
	const hasAny = blocks.some(
		(b) => b.kind !== "content" || b.text.length > 0,
	);
	return (
		<div className="chat-turn max-w-full min-w-0 text-xs leading-relaxed">
			{blocks.map((b, i) => {
				switch (b.kind) {
					case "reasoning":
						return <ReasoningBlock key={i} text={b.text} />;
					case "tool_call":
						return (
							<div key={i} className="mb-2">
								<ToolCallCard call={b.call} />
							</div>
						);
					case "content":
						return b.text.length > 0 ? (
							<div key={i} className="mb-1.5">
								<Markdown>{b.text}</Markdown>
							</div>
						) : null;
					default:
						return null;
				}
			})}
			{/* A caret rather than an ellipsis. An ellipsis says "there is more
			    coming and it is nothing in particular"; a caret says the reply is
			    being written right now, which is what the analyst is waiting on, and
			    it is the one piece of motion the chat actually needs. Hidden from
			    assistive tech, which is told the turn is pending by the store. */}
			{pending && hasAny && (
				<span
					aria-hidden
					className="chat-caret bg-brand ml-0.5 inline-block h-[0.95em] w-[2px] translate-y-[0.15em] rounded-full"
				/>
			)}
			{pending && !hasAny && (
				<span
					aria-hidden
					className="chat-caret bg-brand inline-block h-[0.95em] w-[2px] rounded-full"
				/>
			)}
			{error && (
				<div className="text-destructive mt-1.5 text-xs">{error}</div>
			)}
		</div>
	);
});
