import type {
  OpenedCircuit,
  SavedCircuit,
} from "@lunar-spice/app/lib/circuit-files";
import type { Platform } from "@lunar-spice/app/lib/platform";

/** Versions and folders for the About and Storage panes. */
export type AppInfo = {
  version: string;
  electron: string;
  chrome: string;
  node: string;
  circuitsFolder: string;
};

/**
 * The API the preload script exposes as `window.lunarSpice`: the platform, less the
 * version and panes the renderer supplies, plus what the desktop's own settings panes
 * need. The preload implements this type; env.d.ts types `window` with it.
 */
export type LunarSpiceApi = Omit<
  Platform,
  "version" | "about" | "storagePane" | "circuitPath" | "setZoomFactor"
> & {
  circuitPath: (name: string) => Promise<string>;
  setZoomFactor: (factor: number) => void;
  showCircuitsFolder: () => Promise<void>;
  getAppInfo: () => Promise<AppInfo>;
};

/** Requests the renderer sends to main: each channel's arguments and its answer. */
export type InvokeChannels = {
  "circuits:list": { args: []; result: SavedCircuit[] };
  "circuits:read": { args: [name: string]; result: string };
  "circuits:path": { args: [name: string]; result: string };
  "circuits:save": {
    args: [previousName: string | null, title: string, text: string];
    result: string;
  };
  "circuits:rename": { args: [name: string, title: string]; result: string };
  "circuits:delete": { args: [name: string]; result: void };
  "circuits:show-folder": { args: []; result: void };
  "circuits:open-dialog": { args: []; result: OpenedCircuit | null };
  "circuits:export-dialog": {
    args: [name: string, text: string];
    result: string | null;
  };
  "app:info": { args: []; result: AppInfo };
};

/** Events main sends to the renderer, with what each carries. */
export type EventChannels = {
  "circuits:changed": SavedCircuit[];
  "circuits:opened": OpenedCircuit;
};

/**
 * The renderer sends this once it listens on `circuits:opened`, so main can deliver the
 * files it holds.
 */
export const READY_CHANNEL = "circuits:ready";
