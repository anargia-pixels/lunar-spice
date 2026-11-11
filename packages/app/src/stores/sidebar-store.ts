import { create } from "zustand";
import { persist } from "zustand/middleware";

/** Narrowest sidebar the rail can drag to, in CSS pixels. */
const SIDEBAR_MIN_WIDTH = 200;

/** Widest sidebar the rail can drag to, in CSS pixels. */
const SIDEBAR_MAX_WIDTH = 480;

/** Matches shadcn's 16rem sidebar. */
const SIDEBAR_DEFAULT_WIDTH = 256;

/** Room for the analysis settings and their labels. */
const PANEL_DEFAULT_WIDTH = 288;

/** Height of the results panel until it is dragged, in CSS pixels. */
const RESULTS_DEFAULT_HEIGHT = 320;

/** Keeps a dragged or restored width inside the sidebar bounds. */
function clampWidth(width: number) {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width));
}

/** The circuits sidebar on the left and the simulation panel on the right. */
type SidePanel = "sidebar" | "panel";

type SidebarStore = {
  open: boolean; // The circuits sidebar on the left.
  width: number;
  panelOpen: boolean; // The simulation panel on the right.
  panelWidth: number;
  resultsOpen: boolean; // The results panel under the canvas.
  resultsHeight: number; // As last dragged, in CSS pixels.
  setOpen: (open: boolean) => void;
  setWidth: (width: number) => void;
  setPanelOpen: (open: boolean) => void;
  setPanelWidth: (width: number) => void;
  /**
   * Toggles each side panel the way its own button does, which on narrow screens opens
   * it as a sheet. Each panel registers its toggle with `registerToggle` while mounted;
   * the function `registerToggle` returns removes it.
   */
  toggles: Partial<Record<SidePanel, () => void>>;
  registerToggle: (panel: SidePanel, toggle: () => void) => () => void;
  setResultsOpen: (open: boolean) => void;
  setResultsHeight: (height: number) => void;
  toggleResults: () => void;
};

/** Which side panels are open and how wide, remembered across launches. */
export const useSidebarStore = create<SidebarStore>()(
  persist(
    (set) => ({
      open: true,
      width: SIDEBAR_DEFAULT_WIDTH,
      panelOpen: true,
      panelWidth: PANEL_DEFAULT_WIDTH,
      resultsOpen: false,
      resultsHeight: RESULTS_DEFAULT_HEIGHT,
      setOpen: (open) => set({ open }),
      setWidth: (width) => set({ width: clampWidth(width) }),
      setPanelOpen: (panelOpen) => set({ panelOpen }),
      setPanelWidth: (width) => set({ panelWidth: clampWidth(width) }),
      toggles: {},
      registerToggle: (panel, toggle) => {
        set((state) => ({ toggles: { ...state.toggles, [panel]: toggle } }));

        return () =>
          set((state) => ({
            toggles: { ...state.toggles, [panel]: undefined },
          }));
      },
      setResultsOpen: (resultsOpen) => set({ resultsOpen }),
      setResultsHeight: (resultsHeight) => set({ resultsHeight }),
      toggleResults: () =>
        set((state) => ({ resultsOpen: !state.resultsOpen })),
    }),
    {
      name: "lunar-spice-sidebar",
      // Saved state may predate a field or hold a bad width; keep defaults for those.
      merge: (persisted, current) => {
        if (!(persisted instanceof Object)) {
          return current;
        }

        const width = "width" in persisted ? Number(persisted.width) : null;

        const panelWidth =
          "panelWidth" in persisted ? Number(persisted.panelWidth) : null;

        const resultsHeight =
          "resultsHeight" in persisted ? Number(persisted.resultsHeight) : null;

        return {
          ...current,
          open: "open" in persisted ? persisted.open !== false : current.open,
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
          width:
            width !== null && Number.isFinite(width)
              ? clampWidth(width)
              : current.width,
          panelWidth:
            panelWidth !== null && Number.isFinite(panelWidth)
              ? clampWidth(panelWidth)
              : current.panelWidth,
        };
      },
    },
  ),
);
