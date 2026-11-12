import { SidebarRightIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { DarkModeToggle } from "@lunar-spice/components/darkmode-toggle/darkmode-toggle";
import { DeleteFileDialog } from "@lunar-spice/components/file-dialog/delete-file-dialog";
import { RenameFileDialog } from "@lunar-spice/components/file-dialog/rename-file-dialog";
import { FluidHighlight } from "@lunar-spice/components/fluid-motion/fluid-motion";
import { Hint } from "@lunar-spice/components/hint/hint";
import { runFileAction } from "@lunar-spice/components/lib/file-feedback";
import {
  type SettingsSection,
  SettingsDialog,
} from "@lunar-spice/components/settings-dialog/settings-dialog";
import { Button } from "@lunar-spice/components/ui/button";
import { Menubar } from "@lunar-spice/components/ui/menubar";
import { toast } from "@lunar-spice/components/ui/toast";
import { Toggle } from "@lunar-spice/components/ui/toggle";
import { useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { appShortcutCombo, appShortcutKeys } from "../lib/app-commands";
import { platform } from "../lib/platform";
import { activeBuffer, useCircuitStore } from "../stores/circuit-store";
import { useLayoutStore } from "../stores/layout-store";
import {
  EditMenu,
  FileMenu,
  HelpMenu,
  SimulationMenu,
  ToolsMenu,
  returnFocusAfterDialog,
  ViewMenu,
  WindowMenu,
} from "./app-menus";
import { AboutPane } from "./settings-dialog/about-pane";
import { AppearancePane } from "./settings-dialog/appearance-pane";
import { toggleTheme } from "./theme-provider";

/** The dialog the menu bar has open, if any. */
type BarDialog =
  | { kind: "rename" | "delete" }
  | { kind: "settings"; section: SettingsSection }
  | null;

/** Copies a saved circuit's path, confirming with a toast. */
function copyPath(name: string) {
  void runFileAction(
    async () => {
      const path = (await platform().circuitPath?.(name)) ?? name;

      await navigator.clipboard.writeText(path);
      toast.add({
        type: "success",
        title: "Path copied",
        description: <code>{path}</code>,
      });
    },
    "Unable to copy path",
    "The path could not be copied.",
  );
}

/**
 * The bar across the top of the window: the logo and the menus, the open circuit's
 * title, which renames it, then the theme and the simulation panel's toggle.
 */
export function AppMenuBar() {
  const [dialog, setDialog] = useState<BarDialog>(null);
  const isPanelOpen = useLayoutStore((state) => state.panelOpen);
  const togglePanel = useLayoutStore((state) => state.togglePanel);
  const { version, circuitPath, storagePane } = platform();

  // Edits change only the text, so the bar re-renders only when the title or the
  // saved state does.
  const buffer = useCircuitStore(
    useShallow((state) => {
      const active = activeBuffer(state);

      return active
        ? {
            id: active.id,
            title: active.title,
            fileName: active.fileName,
            isDirty: active.text !== active.savedText,
          }
        : null;
    }),
  );

  const isDraft = buffer?.fileName === null;

  const close = () => {
    setDialog(null);
    returnFocusAfterDialog();
  };

  return (
    <header className="bg-sidebar text-sidebar-foreground border-sidebar-border flex h-11 shrink-0 items-center gap-4 border-b px-2 select-none">
      <div className="flex min-w-max flex-1 items-center gap-2">
        <Hint label={`Version ${version}`} side="bottom">
          <h1 className="font-logo text-primary px-2 text-xl leading-none">
            Lunar Spice
          </h1>
        </Hint>
        <Menubar aria-label="Application menu">
          <FileMenu
            isDraft={isDraft}
            canCopyPath={!isDraft && circuitPath !== undefined}
            onRename={() => setDialog({ kind: "rename" })}
            onCopyPath={() => buffer?.fileName && copyPath(buffer.fileName)}
            onDelete={() => setDialog({ kind: "delete" })}
            onSettings={() =>
              setDialog({ kind: "settings", section: "appearances" })
            }
          />
          <EditMenu />
          <ViewMenu />
          <SimulationMenu />
          <ToolsMenu />
          <WindowMenu />
          <HelpMenu
            onAbout={() => setDialog({ kind: "settings", section: "about" })}
          />
        </Menubar>
      </div>
      {buffer && (
        <div className="flex min-w-0 shrink items-center justify-center">
          <Hint label={buffer.fileName ?? "Rename this draft"} side="bottom">
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Rename ${buffer.title}`}
              className="max-w-full min-w-0"
              onClick={() => setDialog({ kind: "rename" })}
            >
              <span className="min-w-0 truncate">{buffer.title}</span>
              {(isDraft || buffer.isDirty) && (
                <output className="text-muted-foreground ml-1 flex shrink-0 items-center gap-1.5 text-xs font-normal">
                  <span
                    aria-hidden
                    className="bg-primary size-1.5 rounded-full"
                  />
                  {isDraft ? "Not saved" : "Edited"}
                </output>
              )}
            </Button>
          </Hint>
        </div>
      )}
      <div className="relative flex min-w-max flex-1 items-center justify-end gap-0.5">
        <FluidHighlight rows="button" className="bg-muted rounded-md" />
        <DarkModeToggle
          shortcut={appShortcutCombo("toggle-theme")}
          onToggle={toggleTheme}
        />
        <Hint
          label={
            isPanelOpen ? "Hide simulation panel" : "Show simulation panel"
          }
          side="bottom"
          shortcut={appShortcutKeys("toggle-panel")}
        >
          <Toggle
            size="icon-sm"
            aria-label="Simulation panel"
            pressed={isPanelOpen}
            onPressedChange={togglePanel}
          >
            <HugeiconsIcon icon={SidebarRightIcon} strokeWidth={2} />
          </Toggle>
        </Hint>
      </div>
      {buffer && dialog?.kind === "rename" && (
        <RenameFileDialog
          key={buffer.id}
          name={buffer.title}
          onClose={close}
          onRename={async (title) => {
            const store = useCircuitStore.getState();

            if (buffer.fileName === null) {
              store.renameDraft(buffer.id, title);
            } else {
              await store.renameSaved(buffer.fileName, title);
            }
          }}
        />
      )}
      {buffer && dialog?.kind === "delete" && (
        <DeleteFileDialog
          key={buffer.id}
          name={buffer.title}
          verb={isDraft ? "Discard" : "Delete"}
          onClose={close}
          onDelete={async () => {
            const store = useCircuitStore.getState();

            if (buffer.fileName === null) {
              store.discardDraft(buffer.id);
            } else {
              await store.deleteSaved(buffer.fileName);
            }
          }}
        />
      )}
      <SettingsDialog
        open={dialog?.kind === "settings"}
        onOpenChange={(open) => !open && close()}
        initialSection={
          dialog?.kind === "settings" ? dialog.section : "appearances"
        }
        panes={{
          appearances: <AppearancePane />,
          storage: storagePane,
          about: <AboutPane />,
        }}
      />
    </header>
  );
}
