import "@/app/globals.css";
import { AppShell } from "@lunar-spice/app/app-shell";
import { setPlatform } from "@lunar-spice/app/lib/platform";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { StoragePane } from "@/components/settings-dialog/storage-pane";

const container = document.getElementById("root");

if (!container) {
  throw new Error("Missing #root element in index.html");
}

// Circuits live in the circuits folder, through the preload script.
setPlatform({
  ...window.lunarSpice,
  version: __APP_VERSION__,
  about: async () => {
    const info = await window.lunarSpice.getAppInfo();

    return [
      { label: "Version", value: info.version },
      { label: "Electron", value: info.electron },
      { label: "Chromium", value: info.chrome },
      { label: "Node.js", value: info.node },
    ];
  },
  storagePane: <StoragePane />,
});

createRoot(container).render(
  <StrictMode>
    <AppShell />
  </StrictMode>,
);
