// Single Zustand store for client-side state. Only Creator Research still
// persists here (the hidden /creators route). Brand Deals moved to Monday
// and was removed from the dashboard on 2026-09-04; Calendar / ManyChat /
// Content Studio / Thumbnails went in April 2026.

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { CreatorRecord } from "./types";

interface DashboardState {
  creators: CreatorRecord[];

  addCreator: (creator: CreatorRecord) => void;
  removeCreator: (id: string) => void;
}

export const useDashboardStore = create<DashboardState>()(
  persist(
    (set) => ({
      creators: [],

      addCreator: (creator) =>
        set((s) => ({ creators: [...s.creators, creator] })),
      removeCreator: (id) =>
        set((s) => ({ creators: s.creators.filter((c) => c.id !== id) })),
    }),
    {
      name: "bwp_dashboard_v2",
      storage: createJSONStorage(() => localStorage),
      version: 2,
      // v1 persisted a `deals` array. Strip it so older browsers do not carry
      // a ghost slice around forever.
      migrate: (persisted) => {
        const state = { ...(persisted as Record<string, unknown>) };
        delete state.deals;
        return state as unknown as DashboardState;
      },
    },
  ),
);
