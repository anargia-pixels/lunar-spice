import type { ReactNode } from "react";

import type { OpenedCircuit, SavedCircuit } from "./circuit-files";

/**
 * Where saved circuits live: the circuits folder on the desktop, IndexedDB on the web.
 * Circuits are named `<title>.circuit` either way.
 */
export type CircuitStorage = {
  listCircuits: () => Promise<SavedCircuit[]>;
  readCircuit: (name: string) => Promise<string>;
  /**
   * Writes `text` as `<title>.circuit`, renaming `previousName` when the title changed.
   * Never overwrites another circuit. Returns the saved circuit's name.
   */
  saveCircuit: (
    previousName: string | null,
    title: string,
    text: string,
  ) => Promise<string>;
  renameCircuit: (name: string, title: string) => Promise<string>;
  deleteCircuit: (name: string) => Promise<void>;
  /**
   * Calls `listener` with the new list whenever circuits change, here or elsewhere.
   * Returns a function that stops it.
   */
  onCircuitsChanged: (
    listener: (circuits: SavedCircuit[]) => void,
  ) => () => void;
};

/** What the app needs from the desktop app or the browser it runs in. */
export type Platform = CircuitStorage & {
  version: string; // Shown in the sidebar header.
  openCircuitFile: () => Promise<OpenedCircuit | null>; // Null when cancelled.
  /**
   * Calls `listener` with each file the OS asks the app to open, such as a
   * double-clicked file. Absent where nothing opens the app that way.
   */
  onCircuitOpened?: (listener: (circuit: OpenedCircuit) => void) => () => void;
  circuitPath?: (name: string) => Promise<string>; // Absent without file paths.
  setZoomFactor?: (factor: number) => void; // 1 is 100%; absent in a browser.
  about: () => Promise<readonly AboutRow[]>; // Versions the About pane lists.
  storagePane: ReactNode; // Tells where this platform keeps circuits.
};

/** One line of the About pane, such as `Version 0.1.0`. */
export type AboutRow = { label: string; value: string };

let current: Platform | null = null;

/** Sets the platform once, before the app renders. */
export function setPlatform(platform: Platform) {
  current = platform;
}

/**
 * True where the app has a window of its own, as on the desktop. Only there are window
 * zoom and keys a browser keeps for itself, such as Ctrl+N, the app's to use.
 */
export function ownsWindow() {
  return platform().setZoomFactor !== undefined;
}

/** The platform passed to `setPlatform`; throws when it has not run yet. */
export function platform() {
  if (!current) {
    throw new Error("setPlatform must run before the app renders.");
  }

  return current;
}
