import {
  EditMenuItems,
  RunMenuItems,
  ShortcutsMenuItem,
  ToolMenuItems,
  ZoomMenuItems,
} from "@lunar-spice/components/circuit-editor/canvas-menus";
import {
  SCHEMATIC_FONTS,
  SCHEMATIC_FONT_KEYS,
} from "@lunar-spice/components/circuit-editor/display-options";
import { runFileAction } from "@lunar-spice/components/lib/file-feedback";
import {
  MenubarCheckboxItem,
  MenubarContent,
  MenubarGroup,
  MenubarItem,
  MenubarLabel,
  MenubarMenu,
  MenubarRadioGroup,
  MenubarRadioItem,
  MenubarSeparator,
  MenubarShortcut,
  MenubarSub,
  MenubarSubContent,
  MenubarSubTrigger,
  MenubarTrigger,
} from "@lunar-spice/components/ui/menubar";
import { EXAMPLES } from "@lunar-spice/simulator/examples";
import { formatTimeAgo } from "@lunar-spice/utils/relative-time";
import { type ComponentProps, useRef, useState } from "react";

import { ANALYSIS_LABELS, type AnalysisKind } from "../lib/analysis-request";
import {
  type AppShortcutId,
  appShortcutText,
  runAppCommand,
} from "../lib/app-commands";
import { titleOf } from "../lib/circuit-files";
import { openExample } from "../lib/open-circuit-file";
import { ownsWindow } from "../lib/platform";
import { useAppearanceStore } from "../stores/appearance-store";
import { activeBuffer, useCircuitStore } from "../stores/circuit-store";
import { useLayoutStore } from "../stores/layout-store";
import { useSimulationStore } from "../stores/simulation-store";
import { toggleTheme } from "./theme-provider";

type MenuProps = ComponentProps<typeof MenubarMenu>;

type CloseReason = Parameters<
  NonNullable<MenuProps["onOpenChange"]>
>[1]["reason"];

/**
 * Moves focus to the canvas if it is left on the menu bar or the page, as a desktop
 * app's menus and dialogs hand it back to the document, so tool letters and canvas keys
 * work at once: on the menu bar, letters only search its menus. Focus that went anywhere
 * else stays. Waits a frame, for a closing menu or dialog to let go of the page.
 */
export function returnFocusToCanvas() {
  requestAnimationFrame(() => {
    const canvas = useSimulationStore.getState().editor?.canvas;
    const focused = document.activeElement;

    const isStranded =
      focused === null ||
      focused === document.body ||
      focused.closest("[role=menubar]") !== null;

    if (canvas && isStranded) {
      canvas.focus();
    }
  });
}

/** How long a closing dialog has to give focus back before that stops being watched. */
const DIALOG_FOCUS_WAIT_MS = 1000;

/**
 * Call when a dialog opened from the menu bar closes. The dialog gives focus back to the
 * menu bar item that opened it; that focus goes on to the canvas. Only the first focus
 * change after closing counts, so focus the user moves elsewhere stays.
 */
export function returnFocusAfterDialog() {
  let timer = 0;

  const onFocusIn = (event: FocusEvent) => {
    document.removeEventListener("focusin", onFocusIn);
    window.clearTimeout(timer);

    if (
      event.target instanceof Element &&
      event.target.closest("[role=menubar]")
    ) {
      returnFocusToCanvas();
    }
  };

  document.addEventListener("focusin", onFocusIn);
  timer = window.setTimeout(
    () => document.removeEventListener("focusin", onFocusIn),
    DIALOG_FOCUS_WAIT_MS,
  );
}

/** A top-level menu that returns focus to the canvas when it closes. */
function Menu(props: MenuProps) {
  const closeReason = useRef<CloseReason | null>(null);

  return (
    <MenubarMenu
      onOpenChange={(open, details) => {
        if (!open) {
          closeReason.current = details.reason;
        }
      }}
      onOpenChangeComplete={(open) => {
        const reason = closeReason.current;

        // Escape keeps focus on the bar, as menubars do; another menu takes it itself.
        if (!open && reason !== "escape-key" && reason !== "sibling-open") {
          returnFocusToCanvas();
        }
      }}
      {...props}
    />
  );
}

/** A menu row that runs an app command and shows its keys where this platform has them. */
function AppCommandItem({
  command,
  label,
  disabled,
}: {
  command: AppShortcutId;
  label: string;
  disabled?: boolean;
}) {
  return (
    <MenubarItem disabled={disabled} onClick={() => runAppCommand(command)}>
      {label}
      <MenubarShortcut>{appShortcutText(command)}</MenubarShortcut>
    </MenubarItem>
  );
}

/** A circuit the Open recent menu lists: an open draft or a saved circuit. */
type CircuitEntry =
  | { kind: "saved"; name: string; modifiedMs: number }
  | { kind: "draft"; id: string; title: string };

/** The radio value of an entry; drafts and saved circuits never share one. */
function entryValue(entry: CircuitEntry) {
  return entry.kind === "saved" ? `saved:${entry.name}` : `draft:${entry.id}`;
}

/** Drafts, then saved circuits newest first, with the open one checked. */
function OpenRecentItems() {
  const buffers = useCircuitStore((state) => state.buffers);
  const saved = useCircuitStore((state) => state.saved);
  const active = useCircuitStore(activeBuffer);
  // Menus mount as they open, so the times are as of opening.
  const [now] = useState(() => Date.now());

  const entries: CircuitEntry[] = [
    ...buffers.flatMap((buffer): CircuitEntry[] =>
      buffer.fileName === null
        ? [{ kind: "draft", id: buffer.id, title: buffer.title }]
        : [],
    ),
    ...saved.map(({ name, modifiedMs }): CircuitEntry => ({
      kind: "saved",
      name,
      modifiedMs,
    })),
  ];

  const activeValue =
    active?.fileName != null
      ? `saved:${active.fileName}`
      : active && `draft:${active.id}`;

  const open = (entry: CircuitEntry | undefined) => {
    if (entry?.kind === "draft") {
      useCircuitStore.getState().openDraft(entry.id);
    } else if (entry) {
      void runFileAction(
        () => useCircuitStore.getState().openSaved(entry.name),
        "Unable to open circuit",
        "The circuit could not be read.",
      );
    }
  };

  if (entries.length === 0) {
    return <MenubarItem disabled>No saved circuits yet</MenubarItem>;
  }

  return (
    <MenubarRadioGroup
      value={activeValue}
      onValueChange={(value) =>
        open(entries.find((entry) => entryValue(entry) === value))
      }
    >
      {entries.map((entry) => (
        <MenubarRadioItem
          key={entryValue(entry)}
          value={entryValue(entry)}
          title={entry.kind === "saved" ? entry.name : undefined}
        >
          <span className="min-w-0 truncate">
            {entry.kind === "saved" ? titleOf(entry.name) : entry.title}
          </span>
          <MenubarShortcut>
            {entry.kind === "saved"
              ? formatTimeAgo(entry.modifiedMs, now)
              : "draft"}
          </MenubarShortcut>
        </MenubarRadioItem>
      ))}
    </MenubarRadioGroup>
  );
}

/** Starting, opening and saving circuits, and the settings. */
export function FileMenu({
  isDraft,
  canCopyPath,
  onRename,
  onCopyPath,
  onDelete,
  onSettings,
}: {
  isDraft: boolean;
  canCopyPath: boolean;
  onRename: () => void;
  onCopyPath: () => void;
  onDelete: () => void;
  onSettings: () => void;
}) {
  return (
    <Menu>
      <MenubarTrigger>File</MenubarTrigger>
      <MenubarContent>
        <AppCommandItem command="new-circuit" label="New circuit" />
        <AppCommandItem command="open-file" label="Open file…" />
        <MenubarSub>
          <MenubarSubTrigger>Open recent</MenubarSubTrigger>
          <MenubarSubContent className="max-w-80 min-w-64">
            <OpenRecentItems />
          </MenubarSubContent>
        </MenubarSub>
        <MenubarSub>
          <MenubarSubTrigger>Examples</MenubarSubTrigger>
          <MenubarSubContent className="min-w-56">
            {EXAMPLES.map((example) => (
              <MenubarItem
                key={example.id}
                title={example.description}
                onClick={() => openExample(example)}
              >
                {example.title}
              </MenubarItem>
            ))}
          </MenubarSubContent>
        </MenubarSub>
        <MenubarSeparator />
        <AppCommandItem command="save" label="Save" />
        <MenubarItem onClick={onRename}>Rename…</MenubarItem>
        {canCopyPath && (
          <MenubarItem onClick={onCopyPath}>Copy path</MenubarItem>
        )}
        <MenubarSeparator />
        <MenubarItem variant="destructive" onClick={onDelete}>
          {isDraft ? "Discard draft…" : "Delete circuit…"}
        </MenubarItem>
        <MenubarSeparator />
        <MenubarItem onClick={onSettings}>Settings…</MenubarItem>
      </MenubarContent>
    </Menu>
  );
}

/** Undo, the clipboard and transforms, from the canvas's own commands. */
export function EditMenu() {
  const editor = useSimulationStore((state) => state.editor);

  return (
    <Menu>
      <MenubarTrigger>Edit</MenubarTrigger>
      <MenubarContent>
        <EditMenuItems controller={editor} />
      </MenubarContent>
    </Menu>
  );
}

/** The schematic's display options as checkable rows. */
function DisplayItems() {
  const display = useAppearanceStore((state) => state.display);
  const setDisplay = useAppearanceStore((state) => state.setDisplay);

  return (
    <>
      <MenubarCheckboxItem
        checked={display.showVoltageColors}
        onCheckedChange={(showVoltageColors) =>
          setDisplay({ showVoltageColors })
        }
      >
        Voltage colors
      </MenubarCheckboxItem>
      <MenubarCheckboxItem
        checked={display.showCurrentDots}
        onCheckedChange={(showCurrentDots) => setDisplay({ showCurrentDots })}
      >
        Current dots
      </MenubarCheckboxItem>
      <MenubarCheckboxItem
        checked={display.showValues}
        onCheckedChange={(showValues) => setDisplay({ showValues })}
      >
        Part values
      </MenubarCheckboxItem>
      <MenubarCheckboxItem
        checked={display.showGrid}
        onCheckedChange={(showGrid) => setDisplay({ showGrid })}
      >
        Grid
      </MenubarCheckboxItem>
      <MenubarSub>
        <MenubarSubTrigger>Schematic font</MenubarSubTrigger>
        <MenubarSubContent className="min-w-56">
          <MenubarRadioGroup
            value={display.schematicFont}
            onValueChange={(next) => {
              const font = SCHEMATIC_FONT_KEYS.find((key) => key === next);

              if (font) {
                setDisplay({ schematicFont: font });
              }
            }}
          >
            {SCHEMATIC_FONT_KEYS.map((font) => (
              <MenubarRadioItem key={font} value={font}>
                {SCHEMATIC_FONTS[font]}
              </MenubarRadioItem>
            ))}
          </MenubarRadioGroup>
        </MenubarSubContent>
      </MenubarSub>
    </>
  );
}

/** Canvas zoom, what the schematic shows, and the theme. */
export function ViewMenu() {
  const editor = useSimulationStore((state) => state.editor);
  const theme = useAppearanceStore((state) => state.theme);

  return (
    <Menu>
      <MenubarTrigger>View</MenubarTrigger>
      <MenubarContent>
        <ZoomMenuItems controller={editor} />
        <MenubarSeparator />
        <DisplayItems />
        <MenubarSeparator />
        <MenubarCheckboxItem
          checked={theme === "dark"}
          onCheckedChange={() =>
            toggleTheme({
              x: window.innerWidth / 2,
              y: window.innerHeight / 2,
            })
          }
        >
          Dark theme
          <MenubarShortcut>{appShortcutText("toggle-theme")}</MenubarShortcut>
        </MenubarCheckboxItem>
      </MenubarContent>
    </Menu>
  );
}

/** The interactive simulation, then the analysis to run and Run. */
export function SimulationMenu() {
  const editor = useSimulationStore((state) => state.editor);
  const isRunning = useSimulationStore((state) => state.status.isRunning);
  const analysis = useSimulationStore((state) => state.analysis);
  const isAnalyzing = useSimulationStore((state) => state.isAnalyzing);
  const { setAnalysis, cancelAnalysis } = useSimulationStore.getState();

  const kinds = Object.keys(ANALYSIS_LABELS).filter(
    (kind): kind is AnalysisKind => kind in ANALYSIS_LABELS,
  );

  return (
    <Menu>
      <MenubarTrigger>Simulation</MenubarTrigger>
      <MenubarContent>
        <MenubarGroup>
          <MenubarLabel>Interactive simulation</MenubarLabel>
          <RunMenuItems controller={editor} isRunning={isRunning} />
        </MenubarGroup>
        <MenubarSeparator />
        <MenubarGroup>
          <MenubarLabel>Analysis</MenubarLabel>
          <MenubarRadioGroup
            value={analysis}
            onValueChange={(next) => {
              const match = kinds.find((kind) => kind === next);

              if (match) {
                setAnalysis(match);
              }
            }}
          >
            {kinds.map((kind) => (
              <MenubarRadioItem key={kind} value={kind}>
                {ANALYSIS_LABELS[kind]}
              </MenubarRadioItem>
            ))}
          </MenubarRadioGroup>
        </MenubarGroup>
        <MenubarSeparator />
        {isAnalyzing ? (
          <MenubarItem onClick={cancelAnalysis}>Cancel analysis</MenubarItem>
        ) : (
          <AppCommandItem
            command="run-analysis"
            label={`Run ${ANALYSIS_LABELS[analysis]}`}
          />
        )}
      </MenubarContent>
    </Menu>
  );
}

/** Every placing tool, the way the toolbar's component picker lists them. */
export function ToolsMenu() {
  const editor = useSimulationStore((state) => state.editor);

  return (
    <Menu>
      <MenubarTrigger>Tools</MenubarTrigger>
      <MenubarContent>
        <ToolMenuItems controller={editor} />
      </MenubarContent>
    </Menu>
  );
}

/** Which panels show, and the window zoom where the app owns its window. */
export function WindowMenu() {
  const isPanelOpen = useLayoutStore((state) => state.panelOpen);
  const isResultsOpen = useLayoutStore((state) => state.resultsOpen);

  return (
    <Menu>
      <MenubarTrigger>Window</MenubarTrigger>
      <MenubarContent>
        <MenubarCheckboxItem
          checked={isPanelOpen}
          onCheckedChange={() => runAppCommand("toggle-panel")}
        >
          Simulation panel
          <MenubarShortcut>{appShortcutText("toggle-panel")}</MenubarShortcut>
        </MenubarCheckboxItem>
        <MenubarCheckboxItem
          checked={isResultsOpen}
          onCheckedChange={() => runAppCommand("toggle-results")}
        >
          Results panel
          <MenubarShortcut>{appShortcutText("toggle-results")}</MenubarShortcut>
        </MenubarCheckboxItem>
        {ownsWindow() && (
          <>
            <MenubarSeparator />
            <AppCommandItem command="zoom-window-in" label="Zoom window in" />
            <AppCommandItem command="zoom-window-out" label="Zoom window out" />
            <AppCommandItem
              command="zoom-window-reset"
              label="Reset window zoom"
            />
          </>
        )}
      </MenubarContent>
    </Menu>
  );
}

/** The shortcuts dialog and the About pane. */
export function HelpMenu({ onAbout }: { onAbout: () => void }) {
  const editor = useSimulationStore((state) => state.editor);

  return (
    <Menu>
      <MenubarTrigger>Help</MenubarTrigger>
      <MenubarContent>
        <ShortcutsMenuItem controller={editor} />
        <MenubarSeparator />
        <MenubarItem onClick={onAbout}>About Lunar Spice</MenubarItem>
      </MenubarContent>
    </Menu>
  );
}
