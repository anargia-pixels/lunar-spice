import { useSyncExternalStore } from "react";

import { canvasPalette, watchPalette } from "../lib/canvas-palette";

/** The canvas palette, re-rendering the component when the theme changes. */
export function useCanvasPalette() {
  return useSyncExternalStore(watchPalette, canvasPalette);
}
