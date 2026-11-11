import { SettingsPane } from "@lunar-spice/components/settings-dialog/settings-pane";
import { errorMessage } from "@lunar-spice/utils/error-message";
import { useEffect, useState } from "react";

import { type AboutRow, platform } from "../../lib/platform";

/** About pane: what Lunar Spice is, then the versions the platform reports. */
export function AboutPane() {
  const [rows, setRows] = useState<readonly AboutRow[] | null>(null);

  useEffect(() => {
    platform()
      .about()
      .then(setRows)
      .catch((cause: Error) =>
        setRows([
          {
            label: "Versions",
            value: errorMessage(cause, "The versions could not be read."),
          },
        ]),
      );
  }, []);

  return (
    <SettingsPane
      title="About"
      description="Lunar Spice is an interactive circuit simulator in the spirit of Falstad's, with DC operating point, AC sweep and transient analyses. It opens Falstad circuit exports."
    >
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
        {(rows ?? [{ label: "Version", value: "…" }]).map((row) => (
          <div key={row.label} className="contents">
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd className="font-code select-text">{row.value}</dd>
          </div>
        ))}
      </dl>
    </SettingsPane>
  );
}
