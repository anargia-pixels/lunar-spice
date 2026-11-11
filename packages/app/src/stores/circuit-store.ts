import { runFileAction } from "@lunar-spice/components/lib/file-feedback";
import { Circuit } from "@lunar-spice/simulator/circuit";
import { create } from "zustand";
import { persist } from "zustand/middleware";

import {
  freeName,
  type OpenedCircuit,
  type SavedCircuit,
  titleOf,
} from "../lib/circuit-files";
import { platform } from "../lib/platform";

/** The circuit a new buffer starts with: default settings and no elements. */
const EMPTY_CIRCUIT = new Circuit().dump();

/** An open circuit. Its text lives here until it is saved. */
type CircuitBuffer = {
  id: string;
  title: string;
  fileName: string | null; // Saved circuit's name; null for a draft.
  text: string;
  savedText: string; // Differs from `text` while changes are unsaved.
};

type CircuitStore = {
  buffers: CircuitBuffer[];
  activeId: string;
  saved: SavedCircuit[]; // As the platform lists them.
  setSaved: (saved: SavedCircuit[]) => void;
  newCircuit: () => void;
  openDraft: (id: string) => void;
  openText: (title: string, text: string) => void; // Opens a new draft.
  openSaved: (name: string) => Promise<void>; // Reuses its buffer if open.
  setText: (id: string, text: string) => void;
  saveActive: () => Promise<string>; // Returns the saved circuit's name.
  renameSaved: (name: string, title: string) => Promise<void>;
  renameDraft: (id: string, title: string) => void;
  deleteSaved: (name: string) => Promise<void>; // A new draft replaces it if active.
  discardDraft: (id: string) => void; // A new draft replaces it if active.
};

/** A buffer with a new id. A draft's saved text is empty, so it reads as unsaved. */
function newBuffer(title: string, text: string, fileName: string | null) {
  return {
    id: crypto.randomUUID(),
    title,
    fileName,
    text,
    savedText: fileName ? text : "",
  };
}

/**
 * The title a draft gets: the one `title` would save under, so the draft keeps its name
 * when saved. Saved circuits and other open drafts take theirs first.
 */
function freeTitle(
  title: string,
  buffers: readonly CircuitBuffer[],
  saved: readonly SavedCircuit[],
) {
  const taken = new Set([
    ...buffers.map((buffer) => buffer.title),
    ...saved.map(({ name }) => titleOf(name)),
  ]);

  return titleOf(freeName(title, (name) => taken.has(titleOf(name))));
}

/**
 * Keeps only buffers worth keeping beside `activeId`: drafts and circuits with unsaved
 * changes. Clean saved circuits reopen from disk when picked again.
 */
function prune(buffers: readonly CircuitBuffer[], activeId: string) {
  return buffers.filter(
    (buffer) =>
      buffer.id === activeId ||
      buffer.fileName === null ||
      buffer.text !== buffer.savedText,
  );
}

const firstBuffer = newBuffer("untitled", EMPTY_CIRCUIT, null);

/** Open circuits, remembered across launches, and the saved circuits. */
export const useCircuitStore = create<CircuitStore>()(
  persist(
    (set, get) => ({
      buffers: [firstBuffer],
      activeId: firstBuffer.id,
      saved: [],
      setSaved: (saved) => set({ saved }),
      newCircuit: () => get().openText("untitled", EMPTY_CIRCUIT),
      openDraft: (id) =>
        set((state) => ({ activeId: id, buffers: prune(state.buffers, id) })),
      openText: (title, text) =>
        set((state) => {
          const buffer = newBuffer(
            freeTitle(title, state.buffers, state.saved),
            text,
            null,
          );

          return {
            buffers: [...prune(state.buffers, buffer.id), buffer],
            activeId: buffer.id,
          };
        }),
      openSaved: async (name) => {
        const open = get().buffers.find(({ fileName }) => fileName === name);

        if (open) {
          set((state) => ({
            activeId: open.id,
            buffers: prune(state.buffers, open.id),
          }));

          return;
        }

        const text = await platform().readCircuit(name);
        const buffer = newBuffer(titleOf(name), text, name);

        set((state) => ({
          buffers: [...prune(state.buffers, buffer.id), buffer],
          activeId: buffer.id,
        }));
      },
      setText: (id, text) =>
        set((state) => ({
          buffers: state.buffers.map((buffer) =>
            buffer.id === id ? { ...buffer, text } : buffer,
          ),
        })),
      saveActive: async () => {
        const { buffers, activeId } = get();
        const buffer = buffers.find(({ id }) => id === activeId);

        if (!buffer) {
          throw new Error("There is no circuit to save.");
        }

        const name = await platform().saveCircuit(
          buffer.fileName,
          buffer.title,
          buffer.text,
        );

        set((state) => ({
          buffers: state.buffers.map((candidate) =>
            candidate.id === buffer.id
              ? {
                  ...candidate,
                  fileName: name,
                  title: titleOf(name),
                  savedText: buffer.text,
                }
              : candidate,
          ),
        }));

        return name;
      },
      renameSaved: async (name, title) => {
        const next = await platform().renameCircuit(name, title);

        set((state) => ({
          buffers: state.buffers.map((buffer) =>
            buffer.fileName === name
              ? { ...buffer, fileName: next, title: titleOf(next) }
              : buffer,
          ),
        }));
      },
      renameDraft: (id, title) =>
        set((state) => {
          const others = state.buffers.filter((buffer) => buffer.id !== id);
          const free = freeTitle(title, others, state.saved);

          return {
            buffers: state.buffers.map((buffer) =>
              buffer.id === id ? { ...buffer, title: free } : buffer,
            ),
          };
        }),
      deleteSaved: async (name) => {
        await platform().deleteCircuit(name);

        const { buffers, activeId } = get();
        const deleted = buffers.find(({ fileName }) => fileName === name);

        if (!deleted) {
          return;
        }

        if (deleted.id === activeId) {
          get().newCircuit();
        }

        set((state) => ({
          buffers: state.buffers.filter(({ id }) => id !== deleted.id),
        }));
      },
      discardDraft: (id) => {
        if (get().activeId === id) {
          get().newCircuit();
        }

        set((state) => ({
          buffers: state.buffers.filter((buffer) => buffer.id !== id),
        }));
      },
    }),
    {
      name: "lunar-spice-circuits",
      // The saved list comes from the platform on every launch.
      partialize: ({ buffers, activeId }) => ({ buffers, activeId }),
      // Keeps well-formed buffers; falls back to defaults without the active one.
      merge: (persisted, current) => {
        if (
          !(persisted instanceof Object) ||
          !("buffers" in persisted) ||
          !Array.isArray(persisted.buffers) ||
          !("activeId" in persisted)
        ) {
          return current;
        }

        const buffers = persisted.buffers.flatMap((value) => {
          if (
            !(value instanceof Object) ||
            !("id" in value) ||
            !("title" in value) ||
            !("text" in value)
          ) {
            return [];
          }

          const fileName =
            "fileName" in value && value.fileName !== null
              ? String(value.fileName)
              : null;

          return [
            {
              id: String(value.id),
              title: String(value.title),
              fileName,
              text: String(value.text),
              savedText: "savedText" in value ? String(value.savedText) : "",
            },
          ];
        });

        const activeId = String(persisted.activeId);

        if (!buffers.some(({ id }) => id === activeId)) {
          return current;
        }

        return { ...current, buffers, activeId };
      },
    },
  ),
);

/** The active buffer, or undefined while none is open. */
export function activeBuffer(state: CircuitStore) {
  return state.buffers.find(({ id }) => id === state.activeId);
}

/**
 * Keeps the saved list current and opens circuits the platform hands over, such as a
 * double-clicked file. Returns a function that stops both.
 */
export function startCircuitSync(onOpened: (circuit: OpenedCircuit) => void) {
  const { setSaved } = useCircuitStore.getState();

  void runFileAction(
    async () => setSaved(await platform().listCircuits()),
    "Unable to list circuits",
    "The saved circuits could not be read.",
  );

  const stopChanges = platform().onCircuitsChanged(setSaved);
  const stopOpened = platform().onCircuitOpened?.(onOpened);

  return () => {
    stopChanges();
    stopOpened?.();
  };
}
