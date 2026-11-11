import {
  freeName,
  newestFirst,
  type SavedCircuit,
} from "@lunar-spice/app/lib/circuit-files";
import type { CircuitStorage } from "@lunar-spice/app/lib/platform";

/** A saved circuit as IndexedDB keeps it, in place of a file in the circuits folder. */
type CircuitRecord = {
  name: string; // `<title>.circuit`, the record's key.
  text: string;
  modifiedMs: number;
};

const DATABASE_NAME = "lunar-spice";

const DATABASE_VERSION = 1;

const STORE = "circuits";

let database: Promise<IDBDatabase> | null = null;

/** Opens the database once and reuses it; a failed open lets the next call retry. */
function openDatabase() {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

    request.addEventListener("upgradeneeded", () => {
      request.result.createObjectStore(STORE, { keyPath: "name" });
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () =>
      reject(new Error("Browser storage is unavailable.")),
    );
    // IndexedDB fires "blocked" while another tab holds an older version open.
    request.addEventListener("blocked", () =>
      reject(new Error("Close other Lunar Spice tabs, then reload.")),
    );
  }).catch((cause) => {
    database = null;

    throw cause;
  });

  return database;
}

/** Resolves with a request's result, or rejects with its error. */
function settle<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () =>
      reject(request.error ?? new Error("Browser storage request failed.")),
    );
  });
}

/** Runs `operation` in one transaction and resolves after the transaction commits. */
async function withStore<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => Promise<T>,
) {
  const transaction = (await openDatabase()).transaction(STORE, mode);

  const committed = new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () =>
      reject(transaction.error ?? new Error("Browser storage was aborted.")),
    );
  });

  // Awaiting both reports an abort even when the operation fails first.
  const [result] = await Promise.all([
    operation(transaction.objectStore(STORE)),
    committed,
  ]);

  return result;
}

/**
 * Reads every record. IndexedDB results are untyped; only this module writes records, so
 * each one is a `CircuitRecord`.
 */
function readAll(store: IDBObjectStore): Promise<CircuitRecord[]> {
  return settle(store.getAll());
}

/** Reads one record; throws when `name` is not a saved circuit. */
async function readRecord(store: IDBObjectStore, name: string) {
  const record: CircuitRecord | undefined = await settle(store.get(name));

  if (!record) {
    throw new Error(`“${name}” is not a saved circuit.`);
  }

  return record;
}

/** The name `title` saves under; the circuit's own previous name stays free for it. */
async function availableName(
  store: IDBObjectStore,
  title: string,
  previousName: string | null,
) {
  const taken = new Set((await settle(store.getAllKeys())).map(String));

  return freeName(title, (name) => name !== previousName && taken.has(name));
}

async function listCircuits(): Promise<SavedCircuit[]> {
  const records = await withStore("readonly", readAll);

  return newestFirst(
    records.map(({ name, modifiedMs }) => ({ name, modifiedMs })),
  );
}

/** This tab's `onCircuitsChanged` listeners. */
const listeners = new Set<(circuits: SavedCircuit[]) => void>();

/** Tells other tabs, the way the desktop app's folder watcher tells its windows. */
const channel = new BroadcastChannel("lunar-spice-circuits");

async function notifyListeners() {
  const circuits = await listCircuits();

  for (const listener of listeners) {
    listener(circuits);
  }
}

/**
 * Refreshes this tab's lists after a change. The change itself already happened, so a
 * failed refresh is only logged; the next change refreshes again.
 */
function refreshListeners() {
  notifyListeners().catch(console.error);
}

channel.addEventListener("message", refreshListeners);

/**
 * Refreshes this tab's listeners, then tells every other tab. A BroadcastChannel does
 * not deliver a message to its own sender.
 */
function announceChange() {
  refreshListeners();
  channel.postMessage("changed");
}

/**
 * Saved circuits in IndexedDB, one record per `<title>.circuit`, standing in for the
 * desktop app's Documents/lunar-spice folder. They stay in this browser profile until
 * its site data is cleared.
 */
export const browserCircuits: CircuitStorage = {
  listCircuits,
  readCircuit: async (name) =>
    (await withStore("readonly", (store) => readRecord(store, name))).text,
  saveCircuit: async (previousName, title, text) => {
    const name = await withStore("readwrite", async (store) => {
      const next = await availableName(store, title, previousName);

      const record: CircuitRecord = {
        name: next,
        text,
        modifiedMs: Date.now(),
      };

      await settle(store.put(record));

      if (previousName !== null && previousName !== next) {
        await settle(store.delete(previousName));
      }

      return next;
    });

    announceChange();

    return name;
  },
  renameCircuit: async (name, title) => {
    const next = await withStore("readwrite", async (store) => {
      const record = await readRecord(store, name);
      const renamed = await availableName(store, title, name);

      if (renamed !== name) {
        await settle(store.put({ ...record, name: renamed }));
        await settle(store.delete(name));
      }

      return renamed;
    });

    announceChange();

    return next;
  },
  deleteCircuit: async (name) => {
    await withStore("readwrite", (store) => settle(store.delete(name)));
    announceChange();
  },
  onCircuitsChanged: (listener) => {
    listeners.add(listener);

    return () => listeners.delete(listener);
  },
};
