import { existsSync, mkdirSync, watch } from "node:fs";
import {
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, extname, join, resolve, sep } from "node:path";

import {
  CIRCUIT_EXTENSION,
  freeName,
  newestFirst,
  OPENABLE_EXTENSIONS,
  type OpenedCircuit,
  openedCircuit,
  type SavedCircuit,
} from "@lunar-spice/app/lib/circuit-files";
import { app, BrowserWindow, dialog, shell } from "electron";

import { broadcast, handle } from "./ipc";

/**
 * Serves the circuits folder, Documents/lunar-spice, to the renderer over IPC and tells
 * every window when its files change. Returns the folder's path.
 */
export function registerCircuitsFolder() {
  const folder = join(app.getPath("documents"), "lunar-spice");

  /** The full path of a circuit file, refusing names that leave the folder. */
  const pathOf = (name: string) => {
    const path = resolve(folder, name);

    if (!path.startsWith(folder + sep) || basename(path) !== name) {
      throw new Error(`“${name}” is not a circuit in the circuits folder.`);
    }

    return path;
  };

  /** The name `title` saves under; the circuit's own previous name stays free for it. */
  const availableName = (title: string, previousName: string | null) =>
    freeName(
      title,
      (name) => name !== previousName && existsSync(pathOf(name)),
    );

  const listCircuits = async (): Promise<SavedCircuit[]> => {
    const names = (await readdir(folder)).filter(
      (name) => extname(name) === CIRCUIT_EXTENSION,
    );

    const circuits = await Promise.all(
      names.map(async (name) => ({
        name,
        modifiedMs: (await stat(pathOf(name))).mtimeMs,
      })),
    );

    return newestFirst(circuits);
  };

  mkdirSync(folder, { recursive: true });

  // Answer the renderer's requests.
  handle("circuits:list", listCircuits);
  handle("circuits:read", (_event, name) => readFile(pathOf(name), "utf8"));
  handle("circuits:path", (_event, name) => pathOf(name));
  handle("circuits:save", async (_event, previousName, title, text) => {
    const name = availableName(title, previousName);

    await writeFile(pathOf(name), text, "utf8");

    if (
      previousName &&
      previousName !== name &&
      existsSync(pathOf(previousName))
    ) {
      await rm(pathOf(previousName));
    }

    return name;
  });
  handle("circuits:rename", async (_event, name, title) => {
    const next = availableName(title, name);

    if (next !== name) {
      await rename(pathOf(name), pathOf(next));
    }

    return next;
  });
  handle("circuits:delete", (_event, name) => rm(pathOf(name)));
  handle("circuits:show-folder", async () => {
    await shell.openPath(folder);
  });
  handle("circuits:open-dialog", async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);

    const options = {
      title: "Open circuit",
      properties: ["openFile" as const],
      filters: [
        {
          name: "Circuits",
          extensions: OPENABLE_EXTENSIONS.map((extension) =>
            extension.slice(1),
          ),
        },
        { name: "All files", extensions: ["*"] },
      ],
    };

    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);

    const [path] = result.filePaths;

    if (result.canceled || !path) {
      return null;
    }

    return readOpenedCircuit(path);
  });
  handle("circuits:export-dialog", async (event, name, text) => {
    const window = BrowserWindow.fromWebContents(event.sender);

    // Both write the same text, in Falstad's format; `.txt` is what Falstad's exports use.
    const options = {
      title: "Export circuit",
      defaultPath: join(app.getPath("documents"), name),
      filters: [
        { name: "Circuit", extensions: [CIRCUIT_EXTENSION.slice(1)] },
        { name: "Falstad text", extensions: ["txt"] },
      ],
    };

    const result = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options);

    if (result.canceled || !result.filePath) {
      return null;
    }

    await writeFile(result.filePath, text, "utf8");

    return result.filePath;
  });

  // fs.watch fires several events per change, so wait for a quiet 150 ms, then
  // tell every window once.
  let timer: ReturnType<typeof setTimeout> | undefined;

  const watcher = watch(folder, () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      // A failed listing is logged; the next change lists again.
      listCircuits()
        .then((circuits) => broadcast("circuits:changed", circuits))
        .catch(console.error);
    }, 150);
  });

  app.on("will-quit", () => watcher.close());

  return folder;
}

/** Reads a circuit file from anywhere, such as one passed by the OS, for the renderer. */
export async function readOpenedCircuit(path: string): Promise<OpenedCircuit> {
  return openedCircuit(basename(path), await readFile(path, "utf8"));
}
