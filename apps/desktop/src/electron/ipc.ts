import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";

import type { EventChannels, InvokeChannels } from "../lib/bridge";

/** Answers `channel` with `handler`, typed by the channel's arguments and answer. */
export function handle<C extends keyof InvokeChannels>(
  channel: C,
  handler: (
    event: IpcMainInvokeEvent,
    ...args: InvokeChannels[C]["args"]
  ) => InvokeChannels[C]["result"] | Promise<InvokeChannels[C]["result"]>,
) {
  ipcMain.handle(channel, handler);
}

/** Sends an event on `channel` to every window. */
export function broadcast<C extends keyof EventChannels>(
  channel: C,
  payload: EventChannels[C],
) {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(channel, payload);
  }
}
