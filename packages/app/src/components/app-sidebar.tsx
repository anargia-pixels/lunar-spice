import { DeleteFileDialog } from "@lunar-spice/components/file-dialog/delete-file-dialog";
import { RenameFileDialog } from "@lunar-spice/components/file-dialog/rename-file-dialog";
import { runFileAction } from "@lunar-spice/components/lib/file-feedback";
import { AppSidebarHeader } from "@lunar-spice/components/sidebar/app-sidebar-header";
import { SidebarFileItem } from "@lunar-spice/components/sidebar/sidebar-file-item";
import { SidebarResizeRail } from "@lunar-spice/components/sidebar/sidebar-resize-rail";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@lunar-spice/components/ui/sidebar";
import { toast } from "@lunar-spice/components/ui/toast";
import { EXAMPLES } from "@lunar-spice/simulator/examples";
import { formatTimeAgo } from "@lunar-spice/utils/relative-time";
import { useEffect, useState } from "react";

import { appShortcutCombo, appShortcutText } from "../lib/app-commands";
import { titleOf } from "../lib/circuit-files";
import { openCircuitFile, openExample } from "../lib/open-circuit-file";
import { platform } from "../lib/platform";
import { useCircuitStore } from "../stores/circuit-store";
import { useSidebarStore } from "../stores/sidebar-store";
import { AboutPane } from "./settings-dialog/about-pane";
import { AppearancePane } from "./settings-dialog/appearance-pane";
import { toggleTheme } from "./theme-provider";

/** A sidebar entry: a saved circuit or a draft. */
type Entry =
  | { kind: "saved"; key: string; name: string; modifiedMs: number }
  | { kind: "draft"; key: string; title: string };

/** The rename or delete dialog that is open, if any. */
type FileDialog =
  | { kind: "rename"; entry: Entry }
  | { kind: "delete"; entry: Entry }
  | null;

/** Saved circuits are deleted; drafts, never saved, are discarded. */
function deleteVerb(entry: Entry) {
  return entry.kind === "saved" ? "Delete" : "Discard";
}

function entryTitle(entry: Entry) {
  return entry.kind === "saved" ? titleOf(entry.name) : entry.title;
}

/** The left sidebar: drafts, then saved circuits newest first, then the examples. */
export function AppSidebar() {
  const buffers = useCircuitStore((state) => state.buffers);
  const activeId = useCircuitStore((state) => state.activeId);
  const saved = useCircuitStore((state) => state.saved);
  const sidebarWidth = useSidebarStore((state) => state.width);
  const setSidebarWidth = useSidebarStore((state) => state.setWidth);

  // The entry whose menu is open, and where the menu sits.
  const [menu, setMenu] = useState<{
    key: string;
    anchor: HTMLElement | null;
  } | null>(null);

  const [dialog, setDialog] = useState<FileDialog>(null);
  const [now, setNow] = useState(() => Date.now());
  const active = buffers.find(({ id }) => id === activeId);

  // Refreshes the "5m ago" labels every minute.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);

    return () => clearInterval(timer);
  }, []);

  const entries: Entry[] = [
    ...buffers.flatMap((buffer): Entry[] =>
      buffer.fileName === null
        ? [{ kind: "draft", key: buffer.id, title: buffer.title }]
        : [],
    ),
    ...saved.map((circuit): Entry => ({
      kind: "saved",
      key: circuit.name,
      name: circuit.name,
      modifiedMs: circuit.modifiedMs,
    })),
  ];

  const isActive = (entry: Entry) =>
    entry.kind === "saved"
      ? active?.fileName === entry.name
      : active?.id === entry.key;

  const open = (entry: Entry) => {
    if (entry.kind === "draft") {
      useCircuitStore.getState().openDraft(entry.key);

      return;
    }

    void runFileAction(
      () => useCircuitStore.getState().openSaved(entry.name),
      "Unable to open circuit",
      "The circuit could not be read.",
    );
  };

  const { circuitPath, storagePane, version } = platform();

  const copyPath = (name: string) =>
    void runFileAction(
      async () => {
        const path = (await circuitPath?.(name)) ?? name;

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

  return (
    <Sidebar side="left">
      <AppSidebarHeader
        version={version}
        shortcuts={{
          newCircuit: appShortcutCombo("new-circuit"),
          openFile: appShortcutCombo("open-file"),
          toggleTheme: appShortcutCombo("toggle-theme"),
        }}
        onNewCircuit={() => useCircuitStore.getState().newCircuit()}
        onOpenFile={() => void openCircuitFile()}
        settingsPanes={{
          appearances: <AppearancePane />,
          storage: storagePane,
          about: <AboutPane />,
        }}
        onToggleTheme={toggleTheme}
      />
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Circuits</SidebarGroupLabel>
          {entries.length === 0 ? (
            <p className="text-muted-foreground px-2 py-4 text-sm text-pretty">
              No saved circuits yet. Press {appShortcutText("save")} to save
              this one.
            </p>
          ) : (
            <SidebarMenu>
              {entries.map((entry) => (
                <SidebarFileItem
                  key={entry.key}
                  label={entryTitle(entry)}
                  title={
                    entry.kind === "saved"
                      ? entry.name
                      : `${entry.title} (not saved)`
                  }
                  accessedLabel={
                    entry.kind === "saved"
                      ? formatTimeAgo(entry.modifiedMs, now)
                      : "draft"
                  }
                  menuAnchor={menu?.key === entry.key ? menu.anchor : undefined}
                  onMenuChange={(isOpen, anchor) =>
                    setMenu(isOpen ? { key: entry.key, anchor } : null)
                  }
                  isActive={isActive(entry)}
                  onOpen={() => open(entry)}
                  onRename={() => setDialog({ kind: "rename", entry })}
                  onCopyPath={
                    entry.kind === "saved" && circuitPath
                      ? () => copyPath(entry.name)
                      : undefined
                  }
                  onDelete={() => setDialog({ kind: "delete", entry })}
                  deleteLabel={deleteVerb(entry)}
                />
              ))}
            </SidebarMenu>
          )}
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Examples</SidebarGroupLabel>
          <SidebarMenu>
            {EXAMPLES.map((example) => (
              <SidebarMenuItem key={example.id}>
                <SidebarMenuButton
                  title={example.description}
                  onClick={() => openExample(example)}
                >
                  <span>{example.title}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      {dialog?.kind === "rename" && (
        <RenameFileDialog
          key={dialog.entry.key}
          name={entryTitle(dialog.entry)}
          onClose={() => setDialog(null)}
          onRename={async (title) => {
            const { entry } = dialog;

            if (entry.kind === "saved") {
              await useCircuitStore.getState().renameSaved(entry.name, title);
            } else {
              useCircuitStore.getState().renameDraft(entry.key, title);
            }
          }}
        />
      )}
      {dialog?.kind === "delete" && (
        <DeleteFileDialog
          key={dialog.entry.key}
          name={entryTitle(dialog.entry)}
          verb={deleteVerb(dialog.entry)}
          onClose={() => setDialog(null)}
          onDelete={async () => {
            const { entry } = dialog;

            if (entry.kind === "saved") {
              await useCircuitStore.getState().deleteSaved(entry.name);
            } else {
              useCircuitStore.getState().discardDraft(entry.key);
            }
          }}
        />
      )}
      <SidebarResizeRail width={sidebarWidth} onWidthChange={setSidebarWidth} />
    </Sidebar>
  );
}
