import {
  OPENABLE_EXTENSIONS,
  type OpenedCircuit,
  openedCircuit,
} from "@lunar-spice/app/lib/circuit-files";

/**
 * Asks for a circuit file through the browser's file picker, such as a `.circuit` file
 * or a Falstad `.txt` export; null when the picker is cancelled.
 */
export function pickCircuitFile() {
  return new Promise<OpenedCircuit | null>((resolve, reject) => {
    const input = document.createElement("input");

    input.type = "file";
    input.accept = [...OPENABLE_EXTENSIONS, "text/plain"].join(",");
    input.addEventListener("cancel", () => resolve(null));
    input.addEventListener("change", () => {
      const [file] = input.files ?? [];

      if (!file) {
        resolve(null);

        return;
      }

      file
        .text()
        .then((text) => resolve(openedCircuit(file.name, text)), reject);
    });
    input.click();
  });
}
