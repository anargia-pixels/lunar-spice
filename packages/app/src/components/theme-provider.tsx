import {
  COLOR_TOKENS,
  findColorTheme,
  type ColorPalette,
} from "@lunar-spice/components/themes/color-themes";
import { type ReactNode, useLayoutEffect } from "react";
import { flushSync } from "react-dom";

import { useAppearanceStore } from "../stores/appearance-store";

/** Where a theme toggle was pressed; the incoming theme is revealed from this point. */
type ThemeRevealOrigin = {
  x: number;
  y: number;
};

/** Writes each palette color onto `root`; without a palette, globals.css applies. */
function applyColorTheme(root: HTMLElement, palette?: ColorPalette) {
  for (const token of COLOR_TOKENS) {
    const value = palette?.[token];

    if (value === undefined) {
      root.style.removeProperty(`--${token}`);
    } else {
      root.style.setProperty(`--${token}`, value);
    }
  }
}

/**
 * Flips between light and dark, revealing the new theme in a circle from `origin` where
 * the browser supports view transitions and motion is welcome.
 */
export function toggleTheme({ x, y }: ThemeRevealOrigin) {
  const { theme, setTheme } = useAppearanceStore.getState();
  const next = theme === "light" ? "dark" : "light";

  const reducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;

  if (!document.startViewTransition || reducedMotion) {
    setTheme(next);

    return;
  }

  const root = document.documentElement;

  // globals.css centers the reveal circle on these two properties.
  root.style.setProperty(
    "--theme-reveal-x",
    `${(x / window.innerWidth) * 100}%`,
  );
  root.style.setProperty(
    "--theme-reveal-y",
    `${(y / window.innerHeight) * 100}%`,
  );

  document.startViewTransition(() => {
    // flushSync updates <html> before the transition captures the new palette.
    flushSync(() => setTheme(next));
  });
}

/** Puts the theme and its color theme on <html>. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const theme = useAppearanceStore((state) => state.theme);
  const lightColorTheme = useAppearanceStore((state) => state.lightColorTheme);
  const darkColorTheme = useAppearanceStore((state) => state.darkColorTheme);

  const colorTheme = findColorTheme(
    theme === "dark" ? darkColorTheme : lightColorTheme,
  );

  useLayoutEffect(() => {
    const root = document.documentElement;

    root.classList.remove("light", "dark");
    root.classList.add(theme);
    applyColorTheme(root, colorTheme?.[theme]);
  }, [theme, colorTheme]);

  return children;
}
