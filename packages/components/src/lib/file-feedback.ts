import { toast } from "@lunar-spice/components/ui/toast";
import { errorMessage } from "@lunar-spice/utils/error-message";

import { formatFileMessage } from "./file-message";

/** Reports a failed file action in a toast, with quoted file names shown as code. */
export function reportFileError(
  cause: unknown,
  title: string,
  fallback: string,
) {
  toast.add({
    type: "error",
    title,
    description: formatFileMessage(errorMessage(cause, fallback)),
  });
}

/** Runs a file action and reports its failure in a toast, so event handlers can drop the promise. */
export async function runFileAction(
  action: () => Promise<void>,
  title: string,
  fallback: string,
) {
  try {
    await action();
  } catch (cause) {
    reportFileError(cause, title, fallback);
  }
}
