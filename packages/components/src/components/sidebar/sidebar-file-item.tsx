import {
  Copy01Icon,
  Delete02Icon,
  MoreHorizontalIcon,
  PencilEdit01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@lunar-spice/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@lunar-spice/components/ui/context-menu";
import {
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@lunar-spice/components/ui/sidebar";
import { useRef } from "react";

import type { DeleteVerb } from "../file-dialog/delete-file-dialog";

import "./sidebar-file-item.css";

/**
 * One sidebar entry with a menu shared by right-click and its action button. Menu items
 * whose callback is omitted are left out. `accessedLabel` sits at the right edge and gives
 * way to the action button on hover; sidebar-file-item.css styles it.
 */
export function SidebarFileItem({
  label,
  title,
  accessedLabel,
  menuAnchor,
  onMenuChange,
  isActive,
  onOpen,
  onRename,
  onCopyPath,
  onDelete,
  deleteLabel,
}: {
  label: string;
  title: string;
  accessedLabel?: string;
  /** Where its open menu sits, or undefined while the menu is closed. */
  menuAnchor: HTMLElement | null | undefined;
  onMenuChange: (open: boolean, anchor: HTMLElement | null) => void;
  isActive: boolean;
  onOpen: () => void;
  onRename?: () => void;
  onCopyPath?: () => void;
  onDelete?: () => void;
  /** The delete item's verb, which its confirmation dialog repeats. */
  deleteLabel: DeleteVerb;
}) {
  const isMenuOpen = menuAnchor !== undefined;
  const actionRef = useRef<HTMLButtonElement>(null);
  const hasMenu = Boolean(onRename ?? onCopyPath ?? onDelete);

  return (
    <ContextMenu
      open={isMenuOpen}
      onOpenChange={(open) => onMenuChange(open, menuAnchor ?? null)}
    >
      <ContextMenuTrigger
        render={<SidebarMenuItem data-sidebar-file-item />}
        onContextMenu={() => onMenuChange(hasMenu, null)}
      >
        <SidebarMenuButton
          className="h-auto"
          isActive={isActive}
          title={title}
          onClick={onOpen}
        >
          <span>{label}</span>
        </SidebarMenuButton>
        {accessedLabel && <SidebarMenuBadge>{accessedLabel}</SidebarMenuBadge>}
        {hasMenu && (
          <SidebarMenuAction
            ref={actionRef}
            render={<Button variant="ghost" size="icon-xs" />}
            showOnHover
            aria-label={`Actions for ${label}`}
            aria-haspopup="menu"
            aria-expanded={isMenuOpen}
            onClick={(event) => {
              onMenuChange(!isMenuOpen, event.currentTarget);
            }}
          >
            <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
          </SidebarMenuAction>
        )}
      </ContextMenuTrigger>
      <ContextMenuContent
        anchor={menuAnchor ?? undefined}
        finalFocus={actionRef}
      >
        {onRename && (
          <ContextMenuItem onClick={onRename}>
            <HugeiconsIcon icon={PencilEdit01Icon} strokeWidth={2} />
            Rename
          </ContextMenuItem>
        )}
        {onCopyPath && (
          <ContextMenuItem onClick={onCopyPath}>
            <HugeiconsIcon icon={Copy01Icon} strokeWidth={2} />
            Copy path
          </ContextMenuItem>
        )}
        {onDelete && (
          <ContextMenuItem variant="destructive" onClick={onDelete}>
            <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
            {deleteLabel}
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
