import {
  SidebarInset,
  SidebarProvider,
} from "@lunar-spice/components/ui/sidebar";
import { Toaster } from "@lunar-spice/components/ui/toast";
import { TooltipProvider } from "@lunar-spice/components/ui/tooltip";
import { type CSSProperties, useEffect } from "react";

import { openCircuit } from "../lib/open-circuit-file";
import { startCircuitSync } from "../stores/circuit-store";
import { useSidebarStore } from "../stores/sidebar-store";
import { AppSidebar } from "./app-sidebar";
import { EditorPage } from "./editor-page";
import { RegisterPanelToggle } from "./register-panel-toggle";
import { SimulationPanel } from "./simulation-panel";
import { ThemeProvider } from "./theme-provider";
import { useAppShortcuts } from "./use-app-shortcuts";

/**
 * The whole app: circuits on the left, the editor in the inset, the simulation panel on
 * the right. Call `setPlatform` before rendering it.
 */
export function AppShell() {
  const sidebarOpen = useSidebarStore((state) => state.open);
  const setSidebarOpen = useSidebarStore((state) => state.setOpen);
  const sidebarWidth = useSidebarStore((state) => state.width);

  const sidebarStyle: CSSProperties & Record<"--sidebar-width", string> = {
    "--sidebar-width": `${sidebarWidth}px`,
  };

  useAppShortcuts();
  useEffect(() => startCircuitSync(openCircuit), []);

  // Tooltips open after 800 ms of hover, or at once within 300 ms of one closing.
  return (
    <ThemeProvider>
      <Toaster>
        <TooltipProvider delay={800} timeout={300}>
          <SidebarProvider
            keyboardShortcut={null}
            open={sidebarOpen}
            onOpenChange={setSidebarOpen}
            style={sidebarStyle}
          >
            <RegisterPanelToggle panel="sidebar" />
            <AppSidebar />
            <SidebarInset className="min-w-0 flex-row">
              <div className="flex min-w-0 flex-1 flex-col">
                <EditorPage />
              </div>
              <SimulationPanel />
            </SidebarInset>
          </SidebarProvider>
        </TooltipProvider>
      </Toaster>
    </ThemeProvider>
  );
}
