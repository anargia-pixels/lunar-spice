import { useSidebar } from "@lunar-spice/components/ui/sidebar";
import { useEffect } from "react";

import { useSidebarStore } from "../stores/sidebar-store";

/**
 * Lets shortcuts and buttons outside a side panel toggle it the way its own button does,
 * which on narrow screens opens it as a sheet. Render it inside the panel's provider.
 */
export function RegisterPanelToggle({ panel }: { panel: "sidebar" | "panel" }) {
  const { toggleSidebar } = useSidebar();

  useEffect(
    () => useSidebarStore.getState().registerToggle(panel, toggleSidebar),
    [panel, toggleSidebar],
  );

  return null;
}
