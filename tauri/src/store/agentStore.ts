import { Channel } from "@tauri-apps/api/core";
import { create } from "zustand";

import { api } from "../api";
import { createFrameBatch } from "../lib/frameBatch";
import type { AgentEvent, ChatMessage, ContextItem } from "../types";
import { useSessionStore } from "./sessionStore";

export interface ToolCallUi {
	id: string;
	name: string;
	arguments: string;
	result?: string;
}

// Chronological blocks within one assistant message, so reasoning, tool calls
// and content interleave in the UI in the order they actually happened.
export type UiBlock =
	| { kind: "reasoning"; text: string }
	| { kind: "tool_call"; call: ToolCallUi }
	| { kind: "content"; text: string };

export interface UiMessage {
	id: string;
	role: "user" | "assistant";
	blocks: UiBlock[];
	pending: boolean;
	error?: string;
	contextRefs?: string[];
	/** The context attached to this turn, kept whole so the bubble can show
	 * the excerpt the model was given rather than only its label. */
	contextItems?: ContextItem[];
}

interface AgentState {
	messages: UiMessage[];
	busy: boolean;
	activeSessionId: string | null;
	activeRunId: string | null;
	init: () => Promise<void>;
	reload: () => Promise<void>;
	send: (
		text: string,
		context?: ContextItem[],
		sessionId?: string,
	) => Promise<void>;
	reset: () => Promise<void>;
}

// Attach context items to the backend payload as fenced blocks so the LLM sees
// them, while the UI only shows the user's typed message.
function composeContext(items: ContextItem[]): string {
	if (items.length === 0) return "";
	const blocks = items.map(
		(c) =>
			"```context\n[" +
			c.source +
			" · " +
			c.label +
			"]\n" +
			c.text +
			"\n```",
	);
	return blocks.join("\n\n");
}

// Strip the composed context blocks back out of a user message (used when
// restoring persisted history so the raw context text never re-appears).
function stripContextBlocks(s: string): string {
	return s.replace(/```context[\s\S]*?```\s*/g, "").trim();
}

function contentBlock(text: string): UiBlock {
	return { kind: "content", text };
}

function userBlocks(text: string): UiBlock[] {
	return [contentBlock(text)];
}

function mapHistory(history: ChatMessage[]): UiMessage[] {
	const out: UiMessage[] = [];
	for (const m of history) {
		if (m.role === "system") continue;
		if (m.role === "user") {
			out.push({
				id: crypto.randomUUID(),
				role: "user",
				blocks: userBlocks(stripContextBlocks(m.content ?? "")),
				pending: false,
			});
		} else if (m.role === "assistant") {
			const blocks: UiBlock[] = [];
			const reasoning = m.reasoning ?? "";
			if (reasoning.length > 0)
				blocks.push({ kind: "reasoning", text: reasoning });
			for (const tc of m.tool_calls ?? []) {
				blocks.push({
					kind: "tool_call",
					call: {
						id: tc.id,
						name: tc.function.name,
						arguments: tc.function.arguments,
					},
				});
			}
			const text = m.content ?? "";
			if (text.length > 0) blocks.push(contentBlock(text));

			// Consecutive assistant messages are iterations of one turn — merge
			// them into a single bubble so the restored view matches the live
			// interleaved reasoning → tool → reasoning → answer flow.
			const last = out[out.length - 1];
			if (last && last.role === "assistant") {
				last.blocks.push(...blocks);
			} else {
				out.push({
					id: crypto.randomUUID(),
					role: "assistant",
					blocks,
					pending: false,
				});
			}
		} else if (m.role === "tool" && m.tool_call_id) {
			for (let i = out.length - 1; i >= 0; i--) {
				const msg = out[i];
				if (msg.role !== "assistant") continue;
				const idx = msg.blocks.findIndex(
					(b) =>
						b.kind === "tool_call" && b.call.id === m.tool_call_id,
				);
				if (idx >= 0) {
					const block = msg.blocks[idx];
					if (block.kind === "tool_call") {
						const blocks = [...msg.blocks];
						blocks[idx] = {
							kind: "tool_call",
							call: { ...block.call, result: m.content ?? "" },
						};
						msg.blocks = blocks;
					}
					break;
				}
			}
		}
	}
	return out;
}

function updateLast(
	messages: UiMessage[],
	fn: (m: UiMessage) => UiMessage,
): UiMessage[] {
	if (messages.length === 0) return messages;
	const idx = messages.length - 1;
	return [...messages.slice(0, idx), fn(messages[idx])];
}

// Append text to the last block if it matches `kind`, otherwise start a new
// one — this keeps streamed reasoning/content coalesced without losing the
// interleaving with tool calls.
function appendText(
	blocks: UiBlock[],
	kind: "reasoning" | "content",
	text: string,
): UiBlock[] {
	if (text.length === 0) return blocks;
	const last = blocks[blocks.length - 1];
	if (last && last.kind === kind) {
		return [...blocks.slice(0, -1), { kind, text: last.text + text }];
	}
	return [...blocks, { kind, text }];
}

function applyEvent(m: UiMessage, ev: AgentEvent): UiMessage {
	switch (ev.kind) {
		case "reasoning":
			return {
				...m,
				blocks: appendText(m.blocks, "reasoning", ev.delta ?? ""),
			};
		case "token":
			return {
				...m,
				blocks: appendText(m.blocks, "content", ev.delta ?? ""),
			};
		case "tool_call":
			return {
				...m,
				blocks: [
					...m.blocks,
					{
						kind: "tool_call",
						call: {
							id: ev.id ?? "",
							name: ev.name ?? "",
							arguments: ev.arguments ?? "",
						},
					},
				],
			};
		case "tool_result": {
			const blocks = m.blocks.map((b) =>
				b.kind === "tool_call" && b.call.id === ev.id
					? { ...b, call: { ...b.call, result: ev.result ?? "" } }
					: b,
			);
			return { ...m, blocks };
		}
		case "done": {
			const content = ev.content ?? "";
			const blocks = m.blocks.map((b, i, arr): UiBlock => {
				if (b.kind !== "content" || !content) return b;
				const later = arr
					.slice(i + 1)
					.some((x) => x.kind === "content");
				if (later) return b;
				if (
					b.text.startsWith(content) &&
					b.text.length > content.length
				) {
					return { kind: "content", text: content };
				}
				return b;
			});
			return { ...m, pending: false, blocks };
		}
		case "error":
			return { ...m, pending: false, error: ev.message ?? "" };
		default:
			return m;
	}
}

/**
 * Apply a run's queued events, in the order the host sent them.
 *
 * Events are committed a batch at a time rather than one at a time, because
 * they arrive faster than the screen refreshes. Within a batch the order is
 * exactly the wire order, which for a stream is the difference between a tool
 * call and the result that answers it.
 *
 * @param events - The events, oldest first.
 * @param sessionId - The session the run belongs to. An event for another
 *   session is dropped, which is what keeps a reply from a session the analyst
 *   has left out of the one they are reading.
 * @param set - The store's setter.
 */
function applyEvents(
	events: AgentEvent[],
	sessionId: string | null,
	set: (fn: (st: AgentState) => Partial<AgentState>) => void,
): void {
	if (events.length === 0) return;
	set((st) => {
		if (st.activeSessionId !== sessionId) return st;
		let messages = st.messages;
		let activeRunId = st.activeRunId;
		let busy = st.busy;
		let applied = false;
		for (const ev of events) {
			if (activeRunId && activeRunId !== ev.run_id) continue;
			activeRunId = activeRunId ?? ev.run_id;
			messages = updateLast(messages, (m) => applyEvent(m, ev));
			busy = ev.kind !== "done" && ev.kind !== "error";
			if (!busy) activeRunId = null;
			applied = true;
		}
		// Nothing applied, so the same state: returning it is what keeps a batch
		// of events for a stale session from re-rendering the transcript.
		if (!applied) return st;
		return { messages, busy, activeRunId };
	});
}

export const useAgentStore = create<AgentState>((set, get) => ({
	messages: [],
	busy: false,
	activeSessionId: null,
	activeRunId: null,

	init: async () => {
		try {
			const history = await api.agentHistory();
			if (history && history.length > 0) {
				set({ messages: mapHistory(history) });
			}
		} catch {
			/* no history */
		}
	},

	reload: async () => {
		set({ messages: [], busy: false });
		try {
			const history = await api.agentHistory();
			set({
				messages: history?.length ? mapHistory(history) : [],
				busy: false,
			});
		} catch {
			set({ messages: [], busy: false });
		}
	},

	send: async (text: string, context?: ContextItem[], sessionId?: string) => {
		const s = get();
		if (s.busy || !text.trim()) return;

		const refs = (context ?? []).map((c) => c.label);
		const payload =
			context && context.length > 0
				? `${composeContext(context)}\n\n${text}`
				: text;
		// Read once, here: the run belongs to whichever session was current when
		// it started, and re-reading it per event would let a mid-stream session
		// switch change which run an event counts as.
		const runSession =
			sessionId || useSessionStore.getState().current?.id || null;

		set((st) => ({
			messages: [
				...st.messages,
				{
					id: crypto.randomUUID(),
					role: "user",
					blocks: userBlocks(text),
					pending: false,
					contextRefs: refs,
					contextItems: context ?? [],
				},
				{
					id: crypto.randomUUID(),
					role: "assistant",
					blocks: [],
					pending: true,
				},
			],
			busy: true,
			activeSessionId: runSession,
			activeRunId: null,
		}));

		// Each turn gets its own IPC channel; events stream back per-request so
		// there is no global listener to leak or double-register.
		const channel = new Channel<AgentEvent>();
		// A reply arrives faster than the screen refreshes. Committing each event
		// on its own would re-render the whole transcript per token — every
		// settled message, every tool card, every markdown block — so events are
		// queued and committed together, in wire order, once a frame.
		const batch = createFrameBatch<AgentEvent>((events) => {
			applyEvents(events, runSession, set);
		});
		channel.onmessage = (ev) => batch.push(ev);

		try {
			const sid =
				sessionId || useSessionStore.getState().current?.id || "";
			await api.agentChat(payload, sid, channel);
			// The host is done sending, so nothing is still in flight: commit what
			// is queued rather than leaving the last tokens for the next frame.
			batch.flush();
		} catch (e) {
			batch.drop();
			set((st) => ({
				messages: updateLast(st.messages, (m) => ({
					...m,
					pending: false,
					error: String(e),
				})),
				busy: false,
				activeRunId: null,
			}));
		}
	},

	reset: async () => {
		await api.agentReset();
		set({
			messages: [],
			busy: false,
			activeRunId: null,
			activeSessionId: null,
		});
	},
}));
