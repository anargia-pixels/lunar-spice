export const CIRCUIT_EXTENSION = ".circuit";

/** Extensions the open dialogs accept: saved circuits and Falstad's text exports. */
export const OPENABLE_EXTENSIONS = [CIRCUIT_EXTENSION, ".txt"] as const;

/** A saved circuit: a file in the circuits folder, or a record in browser storage. */
export type SavedCircuit = {
  name: string; // With the extension, such as `filter.circuit`.
  modifiedMs: number;
};

/** A circuit file opened from anywhere, such as a Falstad export. */
export type OpenedCircuit = {
  title: string;
  text: string;
};

/** A file name's title: the name without its extension. */
export function titleOf(name: string) {
  const dot = name.lastIndexOf(".");

  return dot > 0 ? name.slice(0, dot) : name;
}

/** Characters no file name may hold on Linux or macOS. */
const UNSAFE_NAME = /[/\\:]/gu;

/** The circuit in a file opened from anywhere, titled by its file name. */
export function openedCircuit(fileName: string, text: string): OpenedCircuit {
  return { title: titleOf(fileName), text };
}

/** Sorts saved circuits in place, newest first, as the File menu lists them. */
export function newestFirst(circuits: SavedCircuit[]) {
  return circuits.sort((a, b) => b.modifiedMs - a.modifiedMs);
}

/**
 * The name `title` saves under: `<title>.circuit`, or `<title>_1.circuit` and so on
 * while `isTaken` says another circuit has it. Desktop, browser storage and new drafts
 * all name circuits this way.
 */
export function freeName(title: string, isTaken: (name: string) => boolean) {
  const stem = toFileTitle(title);
  let name = `${stem}${CIRCUIT_EXTENSION}`;

  for (let suffix = 1; isTaken(name); suffix += 1) {
    name = `${stem}_${suffix}${CIRCUIT_EXTENSION}`;
  }

  return name;
}

/** The name a circuit exports under: `<title>.circuit`, made safe for a file name. */
export function exportName(title: string) {
  return `${toFileTitle(title)}${CIRCUIT_EXTENSION}`;
}

/**
 * A title made safe for a file name on Linux, macOS and in browser storage: no control
 * characters, slashes, colons or leading dots. Never empty.
 */
function toFileTitle(title: string) {
  const printable = [...title]
    .filter((character) => (character.codePointAt(0) ?? 0) >= 32)
    .join("");

  const clean = printable.replace(UNSAFE_NAME, "-").trim().replace(/^\.+/u, "");

  return clean || "untitled";
}
