import { Kbd, KbdGroup } from "@lunar-spice/components/ui/kbd";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@lunar-spice/components/ui/tooltip";
import type { ComponentProps, ReactElement } from "react";

/**
 * A tooltip with a label and an optional shortcut. `children` is the trigger itself, so
 * the control gets hover and focus.
 */
export function Hint({
  label,
  side,
  shortcut,
  children,
}: {
  label: string;
  side?: ComponentProps<typeof TooltipContent>["side"];
  shortcut?: readonly string[];
  children: ReactElement;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent side={side}>
        <div className="flex items-center gap-2">
          <span>{label}</span>
          {shortcut && (
            <KbdGroup>
              {shortcut.map((key) => (
                <Kbd key={key}>{key}</Kbd>
              ))}
            </KbdGroup>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
