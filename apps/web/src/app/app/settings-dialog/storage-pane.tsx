import { SettingsPane } from "@lunar-spice/components/settings-dialog/settings-pane";

/** Storage pane: circuits stay in this browser's storage. */
export function StoragePane() {
  return (
    <SettingsPane
      title="Storage"
      description="Saved circuits stay in this browser's storage (IndexedDB), one per circuit in Falstad's format. Drafts stay in the app until you save them. Clearing this site's data deletes them, and other browsers and devices do not see them."
    />
  );
}
