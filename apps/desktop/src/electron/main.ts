import { existsSync } from "node:fs";
import { extname, join, resolve } from "node:path";

import {
  OPENABLE_EXTENSIONS,
  type OpenedCircuit,
} from "@lunar-spice/app/lib/circuit-files";
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  shell,
  type MenuItemConstructorOptions,
} from "electron";

import appIcon from "../../../../assets/icons/512x512.png?asset";
import { READY_CHANNEL } from "../lib/bridge";
import { readOpenedCircuit, registerCircuitsFolder } from "./circuits-folder";
import { broadcast, handle } from "./ipc";

// A second launch passes its argv to this instance and quits.
const hasInstanceLock = app.requestSingleInstanceLock();

if (!hasInstanceLock) {
  app.quit();
}

/** Circuits the OS asked to open before the window was ready to take them. */
const pendingCircuits: OpenedCircuit[] = [];

/** True once the renderer listens on `circuits:opened`. */
let isRendererReady = false;

/** Sends opened circuits to the window once it listens; queues them until then. */
function deliverCircuits() {
  if (BrowserWindow.getAllWindows().length === 0 || !isRendererReady) {
    return;
  }

  for (const circuit of pendingCircuits.splice(0)) {
    broadcast("circuits:opened", circuit);
  }
}

/**
 * Reads the circuit files among `paths`, resolved against `directory`, and delivers them.
 * Arguments that are not circuit files are ignored.
 */
function queueCircuitFiles(paths: readonly string[], directory: string) {
  const files = paths.flatMap((argument) => {
    const path = resolve(directory, argument);

    return OPENABLE_EXTENSIONS.some(
      (extension) => extension === extname(path),
    ) && existsSync(path)
      ? [path]
      : [];
  });

  // An unreadable file is left out; the others still open.
  void Promise.allSettled(files.map(readOpenedCircuit)).then((results) => {
    for (const result of results) {
      if (result.status === "fulfilled") {
        pendingCircuits.push(result.value);
      } else {
        console.error(result.reason);
      }
    }

    deliverCircuits();
  });
}

/** Brings the existing window forward, creating it if needed. */
function showWindow() {
  if (!app.isReady()) {
    return;
  }

  const window = BrowserWindow.getAllWindows()[0];

  if (!window) {
    createWindow();

    return;
  }

  if (window.isMinimized()) {
    window.restore();
  }

  window.show();
  window.focus();
}

// macOS opens files through this event, not through argv.
app.on("open-file", (event, path) => {
  event.preventDefault();
  queueCircuitFiles([path], process.cwd());
  showWindow();
});

app.on("second-instance", (_event, argv, workingDirectory) => {
  queueCircuitFiles(argv.slice(1), workingDirectory);
  showWindow();
});

/**
 * The application menu, without a reload item: Electron's default View menu reloads the
 * window on Ctrl+R, but the canvas rotates the selection on that key. Edit and window
 * roles stay for the text shortcuts macOS gets from the menu; developer tools and
 * full screen remain.
 */
function installMenu() {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** Opens the editor window and loads the renderer from Vite in dev or disk in production. */
function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    show: false,
    icon: appIcon,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/preload.cjs"),
      sandbox: true,
    },
  });

  // Shows the window on whichever event comes first, only once.
  const reveal = () => {
    window.off("ready-to-show", reveal);
    window.webContents.off("did-finish-load", reveal);

    if (!window.isDestroyed()) {
      window.show();
    }
  };

  window.once("ready-to-show", reveal);

  // Wayland can defer the first paint until the hidden window is shown.
  if (process.platform === "linux") {
    window.webContents.once("did-finish-load", reveal);
  }

  // Links open in the default browser, not in a new app window.
  window.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url);

    return { action: "deny" };
  });

  // Another page here would get the preload bridge, so block navigation.
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  // After a reload or close, files wait until the renderer listens again.
  window.webContents.on("did-start-loading", () => {
    isRendererReady = false;
  });
  window.on("closed", () => {
    isRendererReady = false;
  });

  const devServerUrl = process.env["ELECTRON_RENDERER_URL"];

  if (!app.isPackaged && devServerUrl) {
    void window.loadURL(devServerUrl);

    return;
  }

  void window.loadFile(join(__dirname, "../renderer/index.html"));
}

void app.whenReady().then(() => {
  if (!hasInstanceLock) {
    return;
  }

  // A packaged macOS app takes its dock icon from the bundle.
  if (!app.isPackaged) {
    app.dock?.setIcon(appIcon);
  }

  installMenu();

  const circuitsFolder = registerCircuitsFolder();

  handle("app:info", () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    circuitsFolder,
  }));
  ipcMain.on(READY_CHANNEL, () => {
    isRendererReady = true;
    deliverCircuits();
  });
  // In development, argv[1] is the app's path, not a file.
  queueCircuitFiles(process.argv.slice(app.isPackaged ? 1 : 2), process.cwd());
  createWindow();

  // macOS: a click on the dock icon with no window open makes a new one.
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// macOS apps keep running with no window open.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
