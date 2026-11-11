import { SidebarRail, useSidebar } from "@lunar-spice/components/ui/sidebar";
import type { PointerEvent } from "react";
import { useRef } from "react";

import "./sidebar-resize-rail.css";

/** Pointer travel that turns a rail click into a drag. */
const DRAG_THRESHOLD = 3;

type Drag = { startX: number; startWidth: number; hasMoved: boolean };

/**
 * Sidebar rail that resizes the open sidebar on drag and toggles it on click. A right
 * sidebar grows as the rail moves left. The app owns `width` and keeps it in bounds.
 */
export function SidebarResizeRail({
  width,
  onWidthChange,
  side = "left",
}: {
  width: number;
  onWidthChange: (width: number) => void;
  side?: "left" | "right";
}) {
  const { open, toggleSidebar } = useSidebar();
  const drag = useRef<Drag | null>(null);
  const wasDragged = useRef(false);

  const handlePointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (!open || event.button !== 0) {
      return;
    }

    // Keeps the drag from selecting text in the sidebar or the editor.
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      startX: event.clientX,
      startWidth: width,
      hasMoved: false,
    };
  };

  const handlePointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const current = drag.current;

    if (!current) {
      return;
    }

    const offset =
      (event.clientX - current.startX) * (side === "left" ? 1 : -1);

    if (!current.hasMoved && Math.abs(offset) < DRAG_THRESHOLD) {
      return;
    }

    if (!current.hasMoved) {
      current.hasMoved = true;
      // Turns off the sidebar's width transition, which lags behind the pointer.
      event.currentTarget
        .closest<HTMLElement>("[data-slot=sidebar-wrapper]")
        ?.setAttribute("data-resizing", "");
    }

    onWidthChange(current.startWidth + offset);
  };

  const handlePointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    wasDragged.current = drag.current?.hasMoved ?? false;
    drag.current = null;
    event.currentTarget
      .closest<HTMLElement>("[data-slot=sidebar-wrapper]")
      ?.removeAttribute("data-resizing");
  };

  return (
    <SidebarRail
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onClick={() => {
        if (!wasDragged.current) {
          toggleSidebar();
        }

        wasDragged.current = false;
      }}
    />
  );
}
