import { contextBridge, ipcRenderer, webFrame } from "electron";

import {
  type EventChannels,
  type InvokeChannels,
  type LunarSpiceApi,
  READY_CHANNEL,
} from "../lib/bridge";

/** Asks main over `channel`, typed by the channel's arguments and answer. */
function invoke<C extends keyof InvokeChannels>(
  channel: C,
  ...args: InvokeChannels[C]["args"]
): Promise<InvokeChannels[C]["result"]> {
  return ipcRenderer.invoke(channel, ...args);
}

/** Calls `listener` with each event on `channel`; returns a function that stops it. */
function listen<C extends keyof EventChannels>(
  channel: C,
  listener: (payload: EventChannels[C]) => void,
) {
  const handler = (
    _event: Electron.IpcRendererEvent,
    payload: EventChannels[C],
  ) => listener(payload);

  ipcRenderer.on(channel, handler);

  return () => {
    ipcRenderer.off(channel, handler);
  };
}

/** File operations and app events for the renderer, which has no Node access. */
const api: LunarSpiceApi = {
  listCircuits: () => invoke("circuits:list"),
  readCircuit: (name) => invoke("circuits:read", name),
  saveCircuit: (previousName, title, text) =>
    invoke("circuits:save", previousName, title, text),
  renameCircuit: (name, title) => invoke("circuits:rename", name, title),
  deleteCircuit: (name) => invoke("circuits:delete", name),
  circuitPath: (name) => invoke("circuits:path", name),
  openCircuitFile: () => invoke("circuits:open-dialog"),
  exportCircuitFile: (name, text) =>
    invoke("circuits:export-dialog", name, text),
  showCircuitsFolder: () => invoke("circuits:show-folder"),
  onCircuitsChanged: (listener) => listen("circuits:changed", listener),
  onCircuitOpened: (listener) => {
    const stop = listen("circuits:opened", listener);

    // Main holds files opened before the renderer listens until it hears this.
    ipcRenderer.send(READY_CHANNEL);

    return stop;
  },
  getAppInfo: () => invoke("app:info"),
  setZoomFactor: (factor) => webFrame.setZoomFactor(factor),
};

contextBridge.exposeInMainWorld("lunarSpice", api);
