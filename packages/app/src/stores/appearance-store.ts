import {
  DEFAULT_DISPLAY,
  type DisplayOptions,
} from "@lunar-spice/components/circuit-editor/display-options";
import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Theme = "light" | "dark";

type AppearanceStore = {
  theme: Theme;
  lightColorTheme: string | null; // Color theme id; null keeps globals.css.
  darkColorTheme: string | null; // Color theme id; null keeps globals.css.
  display: DisplayOptions; // How the schematic draws.
  setTheme: (theme: Theme) => void;
  setLightColorTheme: (colorTheme: string | null) => void;
  setDarkColorTheme: (colorTheme: string | null) => void;
  setDisplay: (change: Partial<DisplayOptions>) => void;
  resetColorThemes: () => void; // Applies the colors in globals.css again.
};

/** Remembers the theme, color themes and schematic display settings across launches. */
export const useAppearanceStore = create<AppearanceStore>()(
  persist(
    (set) => ({
      // The first launch follows the OS color scheme.
      theme: window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light",
      lightColorTheme: null,
      darkColorTheme: null,
      display: DEFAULT_DISPLAY,
      setTheme: (theme) => set({ theme }),
      setLightColorTheme: (lightColorTheme) => set({ lightColorTheme }),
      setDarkColorTheme: (darkColorTheme) => set({ darkColorTheme }),
      setDisplay: (change) =>
        set((state) => ({ display: { ...state.display, ...change } })),
      resetColorThemes: () =>
        set({ lightColorTheme: null, darkColorTheme: null }),
    }),
    {
      name: "lunar-spice-appearance",
      version: 1,
      // Version 0 kept each display setting at the top level, beside the theme.
      migrate: (persisted) => {
        const saved = persisted instanceof Object ? persisted : {};

        return {
          ...saved,
          display: {
            ...DEFAULT_DISPLAY,
            ...Object.fromEntries(
              Object.entries(saved).filter(([key]) => key in DEFAULT_DISPLAY),
            ),
          },
        };
      },
      // Saved display settings may predate one; new ones start at their default.
      merge: (persisted, current) => {
        const saved = persisted instanceof Object ? persisted : {};

        const display =
          "display" in saved && saved.display instanceof Object
            ? saved.display
            : {};

        return {
          ...current,
          ...saved,
          display: { ...DEFAULT_DISPLAY, ...display },
        };
      },
    },
  ),
);
