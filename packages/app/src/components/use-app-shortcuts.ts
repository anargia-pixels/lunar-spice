import { useEffect } from "react";

import { runAppShortcut } from "../lib/app-commands";
import { platform } from "../lib/platform";
import { useZoomStore } from "../stores/zoom-store";

/**
 * Listens for the app's shortcuts before anything else on the page, so the canvas and,
 * on the desktop, Electron's menu never see them. Also applies the window zoom.
 */
export function useAppShortcuts() {
  const percent = useZoomStore((state) => state.percent);

  useEffect(() => {
    // Only the desktop has a window to zoom; a browser zooms the page itself.
    platform().setZoomFactor?.(percent / 100);
  }, [percent]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.isComposing && runAppShortcut(event)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);

    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, []);
}
