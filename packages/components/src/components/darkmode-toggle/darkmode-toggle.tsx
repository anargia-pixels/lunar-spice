import { Moon02Icon, Sun03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Hint } from "@lunar-spice/components/hint/hint";
import { Button } from "@lunar-spice/components/ui/button";

import { ariaKeyShortcut, hintKeys, type KeyCombo } from "../../lib/shortcuts";

/** Flips between light and dark themes; `onToggle` gets where it was pressed. */
export function DarkModeToggle({
  shortcut,
  onToggle,
}: {
  shortcut?: KeyCombo;
  onToggle: (origin: { x: number; y: number }) => void;
}) {
  return (
    <Hint label="Toggle theme" side="bottom" shortcut={hintKeys(shortcut)}>
      <Button
        variant="fluid"
        size="icon-sm"
        aria-label="Toggle theme"
        aria-keyshortcuts={ariaKeyShortcut(shortcut)}
        onClick={(event) => onToggle({ x: event.clientX, y: event.clientY })}
      >
        <HugeiconsIcon
          icon={Sun03Icon}
          strokeWidth={2}
          className="scale-100 rotate-0 transition-transform dark:scale-0 dark:-rotate-90"
        />
        <HugeiconsIcon
          icon={Moon02Icon}
          strokeWidth={2}
          className="absolute scale-0 rotate-90 transition-transform dark:scale-100 dark:rotate-0"
        />
      </Button>
    </Hint>
  );
}
