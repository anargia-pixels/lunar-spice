import {
  FileAddIcon,
  FolderOpenIcon,
  Settings01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { DarkModeToggle } from "@lunar-spice/components/darkmode-toggle/darkmode-toggle";
import { FluidHighlight } from "@lunar-spice/components/fluid-motion/fluid-motion";
import { Hint } from "@lunar-spice/components/hint/hint";
import { Button } from "@lunar-spice/components/ui/button";
import { DialogTrigger } from "@lunar-spice/components/ui/dialog";
import { Separator } from "@lunar-spice/components/ui/separator";
import { SidebarHeader } from "@lunar-spice/components/ui/sidebar";
import type { ComponentProps } from "react";

import { ariaKeyShortcut, hintKeys, type KeyCombo } from "../../lib/shortcuts";
import { SettingsDialog } from "../settings-dialog/settings-dialog";

import "./app-sidebar-header.css";

/**
 * The Lunar Spice logo above the sidebar's action buttons: new circuit, open file, the
 * settings window with `settingsPanes`, and the theme. Hovering the logo shows `version`.
 */
export function AppSidebarHeader({
  version,
  shortcuts,
  onNewCircuit,
  onOpenFile,
  settingsPanes,
  onToggleTheme,
}: {
  version: string;
  /** Each button's shortcut; left out where the platform has none. */
  shortcuts: Partial<
    Record<"newCircuit" | "openFile" | "toggleTheme", KeyCombo>
  >;
  onNewCircuit: () => void;
  onOpenFile: () => void;
  settingsPanes: ComponentProps<typeof SettingsDialog>["panes"];
  onToggleTheme: (origin: { x: number; y: number }) => void;
}) {
  return (
    <SidebarHeader data-app-sidebar-header>
      <div>
        <div className="flex h-8 shrink-0 items-center justify-center gap-2 px-3">
          <Hint label={`Version ${version}`} side="bottom">
            <h1 className="font-logo text-primary text-3xl">Lunar Spice</h1>
          </Hint>
        </div>
        <div className="relative flex items-center justify-center gap-1 px-3 py-1.5">
          <FluidHighlight rows="button" className="bg-muted rounded-lg" />
          <Hint
            label="New circuit"
            side="bottom"
            shortcut={hintKeys(shortcuts.newCircuit)}
          >
            <Button
              variant="fluid"
              size="icon-sm"
              aria-label="New circuit"
              aria-keyshortcuts={ariaKeyShortcut(shortcuts.newCircuit)}
              onClick={onNewCircuit}
            >
              <HugeiconsIcon icon={FileAddIcon} strokeWidth={2} />
            </Button>
          </Hint>
          <Hint
            label="Open file"
            side="bottom"
            shortcut={hintKeys(shortcuts.openFile)}
          >
            <Button
              variant="fluid"
              size="icon-sm"
              aria-label="Open file"
              aria-keyshortcuts={ariaKeyShortcut(shortcuts.openFile)}
              onClick={onOpenFile}
            >
              <HugeiconsIcon icon={FolderOpenIcon} strokeWidth={2} />
            </Button>
          </Hint>
          <Separator orientation="vertical" className="mx-1 my-1.5" />
          <SettingsDialog panes={settingsPanes}>
            <Hint label="Settings" side="bottom">
              <DialogTrigger
                render={
                  <Button
                    variant="fluid"
                    size="icon-sm"
                    aria-label="Settings"
                  />
                }
              >
                <HugeiconsIcon icon={Settings01Icon} strokeWidth={2} />
              </DialogTrigger>
            </Hint>
          </SettingsDialog>
          <DarkModeToggle
            shortcut={shortcuts.toggleTheme}
            onToggle={onToggleTheme}
          />
        </div>
      </div>
    </SidebarHeader>
  );
}
