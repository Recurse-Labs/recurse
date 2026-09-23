import { create } from "zustand";

import type { CenterTab } from "../types";

interface UiState {
	tab: CenterTab;
	setTab: (t: CenterTab) => void;
	chatOpen: boolean;
	setChatOpen: (b: boolean) => void;
	toggleChat: () => void;
	client: string | null;
	setClient: (c: string | null) => void;
	err: string | null;
	setErr: (e: string | null) => void;
	newProjectOpen: boolean;
	setNewProjectOpen: (b: boolean) => void;
	modelPickerOpen: boolean;
	setModelPickerOpen: (b: boolean) => void;
}

export const useUiStore = create<UiState>((set) => ({
	tab: "recon",
	setTab: (tab) => set({ tab }),
	chatOpen: true,
	setChatOpen: (chatOpen) => set({ chatOpen }),
	toggleChat: () => set((s) => ({ chatOpen: !s.chatOpen })),
	client: null,
	setClient: (client) => set({ client }),
	err: null,
	setErr: (err) => set({ err }),
	newProjectOpen: false,
	setNewProjectOpen: (newProjectOpen) => set({ newProjectOpen }),
	modelPickerOpen: false,
	setModelPickerOpen: (modelPickerOpen) => set({ modelPickerOpen }),
}));
