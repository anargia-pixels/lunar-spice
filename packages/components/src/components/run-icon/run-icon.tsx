import { PauseIcon, PlayIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@lunar-spice/utils/cn";
import { AnimatePresence, motion } from "framer-motion";

import { spring } from "../../lib/springs";

const HIDDEN = { scale: 0.25, opacity: 0, filter: "blur(4px)" };

const SHOWN = { scale: 1, opacity: 1, filter: "blur(0px)" };

/**
 * Pause while the simulation runs, Play while it is paused, cross-faded so the swap
 * reads as one control changing. `className` sizes it, as `size-4` would an icon.
 */
export function RunIcon({
  isRunning,
  className,
}: {
  isRunning: boolean;
  className?: string;
}) {
  return (
    <span className={cn("relative inline-flex size-4 shrink-0", className)}>
      <AnimatePresence initial={false}>
        <motion.span
          key={isRunning ? "pause" : "play"}
          className="absolute inset-0 flex items-center justify-center"
          initial={HIDDEN}
          animate={SHOWN}
          exit={HIDDEN}
          transition={spring.swap}
        >
          <HugeiconsIcon
            icon={isRunning ? PauseIcon : PlayIcon}
            strokeWidth={2}
            className="size-full"
          />
        </motion.span>
      </AnimatePresence>
    </span>
  );
}
