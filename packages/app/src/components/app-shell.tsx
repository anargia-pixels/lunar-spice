import { Toaster } from "@lunar-spice/components/ui/toast";
import { TooltipProvider } from "@lunar-spice/components/ui/tooltip";
import { useEffect } from "react";

import { openCircuit } from "../lib/open-circuit-file";
import { startCircuitSync } from "../stores/circuit-store";
import { AppMenuBar } from "./app-menu-bar";
import { EditorPage } from "./editor-page";
import { ThemeProvider } from "./theme-provider";
import { useAppShortcuts } from "./use-app-shortcuts";

/**
 * The whole app: the menu bar over the editor, whose canvas the simulation panel floats
 * over. Call `setPlatform` before rendering it.
 */
export function AppShell() {
  useAppShortcuts();
  useEffect(() => startCircuitSync(openCircuit), []);

  // Tooltips open after 800 ms of hover, or at once within 300 ms of one closing.
  return (
    <ThemeProvider>
      <Toaster>
        <TooltipProvider delay={800} timeout={300}>
          <div className="bg-background flex h-svh flex-col overflow-hidden">
            <AppMenuBar />
            <EditorPage />
          </div>
        </TooltipProvider>
      </Toaster>
    </ThemeProvider>
  );
}
