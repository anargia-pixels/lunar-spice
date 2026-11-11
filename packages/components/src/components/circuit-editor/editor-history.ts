import { readElementLine } from "@lunar-spice/simulator/circuit";
import type { CircuitElement } from "@lunar-spice/simulator/element";

/** Undo steps kept; older ones are dropped. */
const MAX_HISTORY = 200;

/**
 * The elements as they were before one edit: their file lines and their ids, which
 * scopes follow. Simulation settings are left out: sliders change them many times a
 * second, so undo never moves them.
 */
export type Snapshot = {
  lines: readonly string[];
  ids: readonly number[];
};

export function snapshotOf(elements: readonly CircuitElement[]): Snapshot {
  return {
    lines: elements.map((element) => element.dump()),
    ids: elements.map(({ id }) => id),
  };
}

/** The elements a snapshot holds, each with the id it had. */
export function restoreSnapshot({ lines, ids }: Snapshot) {
  return lines.flatMap((line, index) => {
    const element = readElementLine(line);
    const id = ids[index];

    if (!element || id === undefined) {
      return [];
    }

    element.id = id;

    return [element];
  });
}

/** Undo and redo stacks of snapshots; reports whether each has a step. */
export class EditorHistory {
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private readonly onChange: (canUndo: boolean, canRedo: boolean) => void;

  constructor(onChange: (canUndo: boolean, canRedo: boolean) => void) {
    this.onChange = onChange;
  }

  /** Records the state before an edit; a new edit drops the redo steps. */
  record(before: Snapshot) {
    this.undoStack.push(before);

    if (this.undoStack.length > MAX_HISTORY) {
      this.undoStack.shift();
    }

    this.redoStack = [];
    this.report();
  }

  /** The state to go back to from `current`, or null when there is none. */
  undo(current: Snapshot) {
    return this.move(this.undoStack, this.redoStack, current);
  }

  /** The state to go forward to from `current`, or null when there is none. */
  redo(current: Snapshot) {
    return this.move(this.redoStack, this.undoStack, current);
  }

  clear() {
    this.undoStack = [];
    this.redoStack = [];
    this.report();
  }

  private move(from: Snapshot[], to: Snapshot[], current: Snapshot) {
    const next = from.pop();

    if (next) {
      to.push(current);
      this.report();
    }

    return next ?? null;
  }

  private report() {
    this.onChange(this.undoStack.length > 0, this.redoStack.length > 0);
  }
}
