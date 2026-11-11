"use client";

import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { fluidPopupMotion } from "@lunar-spice/components/fluid-motion/fluid-motion";
import { cn } from "@lunar-spice/utils/cn";

function TooltipProvider({
  delay = 0,
  ...props
}: TooltipPrimitive.Provider.Props) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delay={delay}
      {...props}
    />
  );
}

function Tooltip({ ...props }: TooltipPrimitive.Root.Props) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

function TooltipTrigger({ ...props }: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

function TooltipContent({
  className,
  side = "top",
  sideOffset = 4,
  align = "center",
  alignOffset = 0,
  anchor,
  children,
  ...props
}: TooltipPrimitive.Popup.Props &
  Pick<
    TooltipPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset" | "anchor"
  >) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        anchor={anchor}
        className="isolate z-50"
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={cn(
            "bg-popover text-popover-foreground border-border relative isolate z-50 inline-flex w-fit max-w-xs items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs select-none has-data-[slot=kbd]:pr-1.5 **:data-[slot=kbd]:rounded-sm",
            "before:bg-popover before:pointer-events-none before:absolute before:inset-px before:-z-1 before:rounded-[inherit]",
            fluidPopupMotion,
            className,
          )}
          {...props}
        >
          {children}
          <TooltipPrimitive.Arrow
            className={cn(
              "bg-popover fill-popover -z-10 size-2.5 translate-y-[calc(-50%-2px)] rotate-45 rounded-[2px] data-[side=bottom]:top-1 data-[side=inline-end]:top-1/2! data-[side=inline-end]:-left-1 data-[side=inline-end]:-translate-y-1/2 data-[side=inline-start]:top-1/2! data-[side=inline-start]:-right-1 data-[side=inline-start]:-translate-y-1/2 data-[side=left]:top-1/2! data-[side=left]:-right-1 data-[side=left]:-translate-y-1/2 data-[side=right]:top-1/2! data-[side=right]:-left-1 data-[side=right]:-translate-y-1/2 data-[side=top]:-bottom-2.5",
              "border-border data-[side=bottom]:border-t data-[side=bottom]:border-l data-[side=inline-end]:border-b data-[side=inline-end]:border-l data-[side=inline-start]:border-t data-[side=inline-start]:border-r data-[side=left]:border-t data-[side=left]:border-r data-[side=right]:border-b data-[side=right]:border-l data-[side=top]:border-r data-[side=top]:border-b",
            )}
          />
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
