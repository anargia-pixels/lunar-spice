import { AppShell } from "@lunar-spice/app/app-shell";
import { setPlatform } from "@lunar-spice/app/lib/platform";

import { browserCircuits } from "@/lib/browser-circuits";
import { downloadCircuitFile } from "@/lib/download-circuit-file";
import { pickCircuitFile } from "@/lib/pick-circuit-file";

import { StoragePane } from "./settings-dialog/storage-pane";

// Circuits live in IndexedDB; the browser zooms the page and has no file paths.
setPlatform({
  ...browserCircuits,
  version: __APP_VERSION__,
  openCircuitFile: pickCircuitFile,
  exportCircuitFile: downloadCircuitFile,
  about: async () => [{ label: "Version", value: __APP_VERSION__ }],
  storagePane: <StoragePane />,
});

/** The simulator, the same app the desktop runs, with circuits in browser storage. */
export default function Editor() {
  return <AppShell />;
}
