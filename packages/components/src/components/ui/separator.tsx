import { Separator as SeparatorPrimitive } from "@base-ui/react/separator";
import { cn } from "@lunar-spice/utils/cn";

/**
 * `handle` is a drag edge for resizing a panel: hidden until hovered or focused, with a
 * hit area wider than the line it draws. Its owner gives it focus and its handlers.
 */
const VARIANTS = {
  default: "bg-border",
  handle:
    "bg-ring focus-visible:ring-ring/50 cursor-col-resize rounded-full opacity-0 transition-opacity outline-none after:absolute after:-inset-x-1.5 after:-inset-y-4 hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-3 active:opacity-100 data-vertical:w-0.5 motion-reduce:transition-none",
} as const;

function Separator({
  className,
  orientation = "horizontal",
  variant = "default",
  ...props
}: SeparatorPrimitive.Props & { variant?: keyof typeof VARIANTS }) {
  return (
    <SeparatorPrimitive
      data-slot="separator"
      orientation={orientation}
      className={cn(
        "shrink-0 data-horizontal:h-px data-horizontal:w-full data-vertical:w-px data-vertical:self-stretch",
        VARIANTS[variant],
        className,
      )}
      {...props}
    />
  );
}

export { Separator };
