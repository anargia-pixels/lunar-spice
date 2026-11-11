import { create } from "zustand";
import { persist } from "zustand/middleware";

/** Zoom steps in percent, shared by the shortcuts and the appearance pane. */
export const ZOOM_PERCENTS = [
  50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300,
] as const;

export type ZoomPercent = (typeof ZOOM_PERCENTS)[number];

/** Narrows a restored or selected number to a zoom step. */
function isZoomPercent(percent: number): percent is ZoomPercent {
  return ZOOM_PERCENTS.some((step) => step === percent);
}

type ZoomStore = {
  percent: ZoomPercent;
  setPercent: (percent: ZoomPercent) => void;
  /** Moves `steps` zoom steps from the current one, stopping at either end. */
  stepZoom: (steps: number) => void;
};

/** Window zoom, remembered across launches. */
export const useZoomStore = create<ZoomStore>()(
  persist(
    (set) => ({
      percent: 100,
      setPercent: (percent) => set({ percent }),
      stepZoom: (steps) =>
        set((state) => {
          const index = ZOOM_PERCENTS.indexOf(state.percent) + steps;

          return {
            percent:
              ZOOM_PERCENTS[
                Math.min(ZOOM_PERCENTS.length - 1, Math.max(0, index))
              ],
          };
        }),
    }),
    {
      name: "lunar-spice-zoom",
      // Keeps the default for a missing or unknown percent.
      merge: (persisted, current) => {
        const percent =
          persisted instanceof Object && "percent" in persisted
            ? Number(persisted.percent)
            : null;

        return {
          ...current,
          percent:
            percent !== null && isZoomPercent(percent)
              ? percent
              : current.percent,
        };
      },
    },
  ),
);
