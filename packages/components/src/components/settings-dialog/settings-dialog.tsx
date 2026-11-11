import {
  Database01Icon,
  InformationCircleIcon,
  PaintBoardIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@lunar-spice/components/ui/dialog";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@lunar-spice/components/ui/sidebar";
import { type ReactNode, useState } from "react";

/** The sections of the settings window, in the order its sidebar lists them. */
const SECTIONS = [
  { id: "appearances", label: "Appearances", icon: PaintBoardIcon },
  { id: "storage", label: "Storage", icon: Database01Icon },
  { id: "about", label: "About", icon: InformationCircleIcon },
] as const;

type SettingsSection = (typeof SECTIONS)[number]["id"];

/**
 * Settings window filling 80% of the Lunar Spice window: a sidebar of sections beside
 * the open one's pane. `children` is the trigger that opens it.
 */
export function SettingsDialog({
  panes,
  children,
}: {
  panes: Record<SettingsSection, ReactNode>;
  children: ReactNode;
}) {
  const [section, setSection] = useState<SettingsSection>("appearances");

  return (
    <Dialog>
      {children}
      <DialogContent
        className="h-4/5 w-4/5 max-w-none sm:max-w-none"
        padded={false}
      >
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <SidebarProvider keyboardShortcut={null} className="h-full min-h-0">
          <Sidebar collapsible="none">
            <SidebarContent>
              <SidebarGroup>
                <SidebarGroupLabel>General</SidebarGroupLabel>
                <SidebarMenu>
                  {SECTIONS.map(({ id, label, icon }) => (
                    <SidebarMenuItem key={id}>
                      <SidebarMenuButton
                        isActive={section === id}
                        onClick={() => setSection(id)}
                      >
                        <HugeiconsIcon icon={icon} strokeWidth={2} />
                        <span>{label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroup>
            </SidebarContent>
          </Sidebar>
          <div className="bg-background min-w-0 flex-1">{panes[section]}</div>
        </SidebarProvider>
      </DialogContent>
    </Dialog>
  );
}
