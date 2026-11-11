import { FolderOpenIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { runFileAction } from "@lunar-spice/components/lib/file-feedback";
import { SettingsPane } from "@lunar-spice/components/settings-dialog/settings-pane";
import { Button } from "@lunar-spice/components/ui/button";
import { useEffect, useState } from "react";

/** Storage pane: where circuits are saved, and a button to open that folder. */
export function StoragePane() {
  const [folder, setFolder] = useState<string | null>(null);

  useEffect(() => {
    window.lunarSpice
      .getAppInfo()
      .then((info) => setFolder(info.circuitsFolder))
      .catch(() => setFolder("The circuits folder could not be found."));
  }, []);

  return (
    <SettingsPane
      title="Storage"
      description="Saved circuits are plain text files in Falstad's format, one per circuit. Drafts stay in the app until you save them."
    >
      <code className="bg-muted rounded-md px-3 py-2 text-sm select-text">
        {folder ?? "…"}
      </code>
      <Button
        variant="outline"
        className="self-start"
        onClick={() =>
          void runFileAction(
            () => window.lunarSpice.showCircuitsFolder(),
            "Unable to open folder",
            "The circuits folder could not be opened.",
          )
        }
      >
        <HugeiconsIcon icon={FolderOpenIcon} strokeWidth={2} />
        Open circuits folder
      </Button>
    </SettingsPane>
  );
}
