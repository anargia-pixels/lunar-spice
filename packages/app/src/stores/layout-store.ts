import { create } from "zustand";
import { persist } from "zustand/middleware";

/** Narrowest simulation panel its edge can drag to, in CSS pixels. */
const PANEL_MIN_WIDTH = 260;

/** Widest simulation panel its edge can drag to, in CSS pixels. */
const PANEL_MAX_WIDTH = 480;

/** Room for the analysis settings and their labels. */
const PANEL_DEFAULT_WIDTH = 300;

/** Height of the results panel until it is dragged, in CSS pixels. */
const RESULTS_DEFAULT_HEIGHT = 320;

/** Keeps a dragged or restored width inside the panel bounds. */
function clampWidth(width: number) {
  return Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, width));
}

type LayoutStore = {
  panelOpen: boolean; // The simulation panel floating over the canvas.
  panelWidth: number;
  resultsOpen: boolean; // The results panel under the canvas.
  resultsHeight: number; // As last dragged, in CSS pixels.
  setPanelOpen: (open: boolean) => void;
  setPanelWidth: (width: number) => void;
  togglePanel: () => void;
  setResultsOpen: (open: boolean) => void;
  setResultsHeight: (height: number) => void;
  toggleResults: () => void;
};

/** Which panels are open and how big, remembered across launches. */
export const useLayoutStore = create<LayoutStore>()(
  persist(
    (set) => ({
      panelOpen: true,
      panelWidth: PANEL_DEFAULT_WIDTH,
      resultsOpen: false,
      resultsHeight: RESULTS_DEFAULT_HEIGHT,
      setPanelOpen: (panelOpen) => set({ panelOpen }),
      setPanelWidth: (width) => set({ panelWidth: clampWidth(width) }),
      togglePanel: () => set((state) => ({ panelOpen: !state.panelOpen })),
      setResultsOpen: (resultsOpen) => set({ resultsOpen }),
      setResultsHeight: (resultsHeight) => set({ resultsHeight }),
      toggleResults: () =>
        set((state) => ({ resultsOpen: !state.resultsOpen })),
    }),
    {
      // The key from when the circuits sidebar lived here too, so saved sizes carry over.
      name: "lunar-spice-sidebar",
      // Saved state may predate a field or hold a bad size; keep defaults for those.
      merge: (persisted, current) => {
        if (!(persisted instanceof Object)) {
          return current;
        }

        const panelWidth =
          "panelWidth" in persisted ? Number(persisted.panelWidth) : null;

        const resultsHeight =
          "resultsHeight" in persisted ? Number(persisted.resultsHeight) : null;

        return {
          ...current,
          panelOpen:
            "panelOpen" in persisted
              ? persisted.panelOpen !== false
              : current.panelOpen,
          resultsOpen:
            "resultsOpen" in persisted
              ? persisted.resultsOpen === true
              : current.resultsOpen,
          resultsHeight:
            resultsHeight !== null && resultsHeight > 0
              ? resultsHeight
              : current.resultsHeight,
          panelWidth:
            panelWidth !== null && Number.isFinite(panelWidth)
              ? clampWidth(panelWidth)
              : current.panelWidth,
        };
      },
    },
  ),
);
