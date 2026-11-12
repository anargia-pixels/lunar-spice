import { Menubar as MenubarPrimitive } from "@base-ui/react/menubar";
import { FluidHighlight } from "@lunar-spice/components/fluid-motion/fluid-motion";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@lunar-spice/components/ui/dropdown-menu";
import { cn } from "@lunar-spice/utils/cn";
import type * as React from "react";

/**
 * A bar of menu triggers. One fill glides between the triggers as the pointer moves, as
 * in the app's other button rows. The menus reuse the dropdown menu's rows, so their
 * highlight and indicators match every other menu.
 */
function Menubar({
  className,
  children,
  ...props
}: MenubarPrimitive.Props & { children?: React.ReactNode }) {
  return (
    <MenubarPrimitive
      data-slot="menubar"
      className={cn("relative flex h-8 items-center gap-0.5", className)}
      {...props}
    >
      <FluidHighlight
        rows="[data-slot=menubar-trigger]"
        className="bg-muted rounded-md"
      />
      {children}
    </MenubarPrimitive>
  );
}

function MenubarMenu({ ...props }: React.ComponentProps<typeof DropdownMenu>) {
  return <DropdownMenu {...props} />;
}

function MenubarTrigger({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuTrigger>) {
  return (
    <DropdownMenuTrigger
      data-slot="menubar-trigger"
      className={cn(
        "text-muted-foreground hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground focus-visible:ring-ring/50 relative flex h-7 items-center rounded-md px-2.5 text-sm font-medium outline-none select-none focus-visible:ring-[3px]",
        className,
      )}
      {...props}
    />
  );
}

/** A checkable row that closes its menu when picked, as a desktop menu bar's do. */
function MenubarCheckboxItem({
  closeOnClick = true,
  ...props
}: React.ComponentProps<typeof DropdownMenuCheckboxItem>) {
  return <DropdownMenuCheckboxItem closeOnClick={closeOnClick} {...props} />;
}

/** One of a set of choices; picking it closes its menu, as a desktop menu bar's do. */
function MenubarRadioItem({
  closeOnClick = true,
  ...props
}: React.ComponentProps<typeof DropdownMenuRadioItem>) {
  return <DropdownMenuRadioItem closeOnClick={closeOnClick} {...props} />;
}

function MenubarContent({
  className,
  align = "start",
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof DropdownMenuContent>) {
  return (
    <DropdownMenuContent
      align={align}
      sideOffset={sideOffset}
      className={cn("w-auto min-w-56", className)}
      {...props}
    />
  );
}

export {
  Menubar,
  DropdownMenuPortal as MenubarPortal,
  MenubarMenu,
  MenubarTrigger,
  MenubarContent,
  DropdownMenuGroup as MenubarGroup,
  DropdownMenuSeparator as MenubarSeparator,
  DropdownMenuLabel as MenubarLabel,
  DropdownMenuItem as MenubarItem,
  DropdownMenuShortcut as MenubarShortcut,
  MenubarCheckboxItem,
  DropdownMenuRadioGroup as MenubarRadioGroup,
  MenubarRadioItem,
  DropdownMenuSub as MenubarSub,
  DropdownMenuSubTrigger as MenubarSubTrigger,
  DropdownMenuSubContent as MenubarSubContent,
};
