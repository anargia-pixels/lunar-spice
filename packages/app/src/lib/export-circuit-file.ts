import { runFileAction } from "@lunar-spice/components/lib/file-feedback";
import { toast } from "@lunar-spice/components/ui/toast";
import { createElement } from "react";

import { activeBuffer, useCircuitStore } from "../stores/circuit-store";
import { exportName } from "./circuit-files";
import { platform } from "./platform";

/**
 * Writes the open circuit, edits included, to a file of the user's choosing, confirming
 * where it went. The saved circuit and its name stay as they are.
 */
export async function exportActiveCircuit() {
  const buffer = activeBuffer(useCircuitStore.getState());

  if (!buffer) {
    return;
  }

  await runFileAction(
    async () => {
      const destination = await platform().exportCircuitFile(
        exportName(buffer.title),
        buffer.text,
      );

      if (destination) {
        toast.add({
          type: "success",
          title: "Circuit exported",
          description: createElement("code", null, destination),
        });
      }
    },
    "Unable to export circuit",
    "The file could not be written.",
  );
}
