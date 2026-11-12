import { reportFileError } from "@lunar-spice/components/lib/file-feedback";
import {
  comboLabel,
  comboText,
  findPressed,
  type KeyCombo,
  type ShortcutSection,
} from "@lunar-spice/components/lib/shortcuts";
import { toast } from "@lunar-spice/components/ui/toast";
import { createElement } from "react";

import { toggleTheme } from "../components/theme-provider";
import { activeBuffer, useCircuitStore } from "../stores/circuit-store";
import { useLayoutStore } from "../stores/layout-store";
import { useSimulationStore } from "../stores/simulation-store";
import { useZoomStore } from "../stores/zoom-store";
import { exportActiveCircuit } from "./export-circuit-file";
import { openCircuitFile } from "./open-circuit-file";
import { ownsWindow } from "./platform";

/** Saves the active circuit, confirming with a toast or reporting why it failed. */
async function saveActiveCircuit() {
  try {
    const name = await useCircuitStore.getState().saveActive();

    toast.add({
      type: "success",
      title: "Circuit saved",
      description: createElement("code", null, name),
    });
  } catch (cause) {
    reportFileError(
      cause,
      "Unable to save circuit",
      "The circuit could not be saved.",
    );
  }
}

/** Runs the analysis chosen in the simulation panel on the active circuit. */
export function runChosenAnalysis() {
  const buffer = activeBuffer(useCircuitStore.getState());

  if (buffer) {
    useSimulationStore.getState().runAnalysis(buffer.id, buffer.text);
  }
}

/** An app command with its keys. Menus run it with `runAppCommand`. */
type AppShortcut = {
  id: string;
  label: string;
  section: "App" | "Simulation" | "Window";
  keys: readonly KeyCombo[];
  run: () => void;
  needsOwnWindow?: boolean; // A browser keeps these keys for itself.
};

/**
 * Every app command with keys. The app catches these keys before the canvas and, on the
 * desktop, before Electron's menu.
 */
const APP_SHORTCUTS = [
  {
    id: "new-circuit",
    label: "New circuit",
    section: "App",
    keys: [{ key: "n", mod: true, shift: false }],
    run: () => useCircuitStore.getState().newCircuit(),
    needsOwnWindow: true,
  },
  {
    id: "import-file",
    label: "Import a circuit file",
    section: "App",
    keys: [{ key: "o", mod: true, shift: false }],
    run: () => void openCircuitFile(),
  },
  {
    // Inkscape's Export key; Firefox keeps it for its developer tools.
    id: "export-file",
    label: "Export the circuit to a file",
    section: "App",
    keys: [{ key: "e", mod: true, shift: true }],
    run: () => void exportActiveCircuit(),
    needsOwnWindow: true,
  },
  {
    id: "save",
    label: "Save",
    section: "App",
    keys: [{ key: "s", mod: true, shift: false }],
    run: () => void saveActiveCircuit(),
  },
  {
    id: "toggle-panel",
    label: "Toggle simulation panel",
    section: "App",
    keys: [{ key: "b", mod: true, alt: true, shift: false }],
    run: () => useLayoutStore.getState().togglePanel(),
  },
  {
    id: "toggle-theme",
    label: "Toggle theme",
    section: "App",
    keys: [{ key: "d", mod: true, shift: true }],
    run: () =>
      toggleTheme({ x: window.innerWidth / 2, y: window.innerHeight / 2 }),
  },
  {
    id: "run-analysis",
    label: "Run the chosen analysis",
    section: "Simulation",
    keys: [{ key: "Enter", mod: true }],
    run: runChosenAnalysis,
  },
  {
    id: "toggle-results",
    label: "Show or hide results",
    section: "Simulation",
    keys: [{ key: "j", mod: true, shift: false }],
    run: () => useLayoutStore.getState().toggleResults(),
  },
  {
    id: "zoom-window-in",
    label: "Zoom the window in",
    section: "Window",
    keys: [
      { key: "+", mod: true },
      { key: "=", mod: true },
    ],
    run: () => useZoomStore.getState().stepZoom(1),
    needsOwnWindow: true,
  },
  {
    id: "zoom-window-out",
    label: "Zoom the window out",
    section: "Window",
    keys: [
      { key: "-", mod: true },
      { key: "_", mod: true },
    ],
    run: () => useZoomStore.getState().stepZoom(-1),
    needsOwnWindow: true,
  },
  {
    id: "zoom-window-reset",
    label: "Reset window zoom",
    section: "Window",
    keys: [{ key: "0", mod: true }],
    run: () => useZoomStore.getState().setPercent(100),
    needsOwnWindow: true,
  },
] as const satisfies readonly AppShortcut[];

export type AppShortcutId = (typeof APP_SHORTCUTS)[number]["id"];

/** The shortcuts this platform has: the window ones only where the app owns its window. */
function availableShortcuts(): readonly AppShortcut[] {
  const canUseWindowKeys = ownsWindow();

  return APP_SHORTCUTS.filter(
    (shortcut: AppShortcut) => canUseWindowKeys || !shortcut.needsOwnWindow,
  );
}

/**
 * The first combo of a shortcut, for buttons that name their key; undefined where this
 * platform does not have it.
 */
export function appShortcutCombo(id: AppShortcutId) {
  return availableShortcuts().find((shortcut) => shortcut.id === id)?.keys[0];
}

/** The keycaps of a shortcut, for tooltips; undefined where it does not apply. */
export function appShortcutKeys(id: AppShortcutId) {
  const combo = appShortcutCombo(id);

  return combo && comboLabel(combo);
}

/** A shortcut written inline, such as `Ctrl+S`; empty where it does not apply. */
export function appShortcutText(id: AppShortcutId) {
  const combo = appShortcutCombo(id);

  return combo ? comboText(combo) : "";
}

/** The app's shortcuts as sections of the shortcuts dialog. */
export function appShortcutSections(): ShortcutSection[] {
  const sections = new Map<string, AppShortcut[]>();

  for (const shortcut of availableShortcuts()) {
    sections.set(shortcut.section, [
      ...(sections.get(shortcut.section) ?? []),
      shortcut,
    ]);
  }

  return [...sections].map(([title, items]) => ({ title, items }));
}

/** Runs an app command as its keys do, for menus; it runs where its keys are absent too. */
export function runAppCommand(id: AppShortcutId) {
  APP_SHORTCUTS.find((shortcut) => shortcut.id === id)?.run();
}

/**
 * Runs the app shortcut a key press matches, but not on key repeat. Returns true on a
 * match, so the caller can stop the event.
 */
export function runAppShortcut(event: KeyboardEvent) {
  const shortcut = findPressed(availableShortcuts(), event);

  if (shortcut && !event.repeat) {
    shortcut.run();
  }

  return shortcut !== undefined;
}
