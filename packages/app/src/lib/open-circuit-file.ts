import { runFileAction } from "@lunar-spice/components/lib/file-feedback";
import { toast } from "@lunar-spice/components/ui/toast";
import { Circuit } from "@lunar-spice/simulator/circuit";
import type { EXAMPLES } from "@lunar-spice/simulator/examples";

import { useCircuitStore } from "../stores/circuit-store";
import { useSimulationStore } from "../stores/simulation-store";
import type { OpenedCircuit } from "./circuit-files";
import { platform } from "./platform";

/**
 * Opens a circuit from outside the circuits folder as a new draft. Falstad files work;
 * a toast lists the Falstad element types Lunar Spice lacks and leaves out.
 */
export function openCircuit({ title, text }: OpenedCircuit) {
  const circuit = Circuit.parse(text);

  useCircuitStore.getState().openText(title, circuit.dump());

  if (circuit.skippedTypes.length > 0) {
    toast.add({
      type: "warning",
      title: "Some components were left out",
      description: `Lunar Spice does not have these Falstad types yet: ${circuit.skippedTypes.join(", ")}.`,
    });
  }
}

/** Asks for a circuit file and opens it as a new draft. */
export function openCircuitFile() {
  return runFileAction(
    async () => {
      const opened = await platform().openCircuitFile();

      if (opened) {
        openCircuit(opened);
      }
    },
    "Unable to open file",
    "The file could not be read.",
  );
}

/** Opens an example as a new draft and picks the analysis it shows off best. */
export function openExample(example: (typeof EXAMPLES)[number]) {
  useCircuitStore.getState().openText(example.title, example.text);

  if (example.analysis !== "interactive") {
    useSimulationStore.getState().setAnalysis(example.analysis);
  }
}
