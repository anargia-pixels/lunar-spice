import {
  MenubarItem,
  MenubarRadioGroup,
  MenubarRadioItem,
  MenubarSeparator,
  MenubarShortcut,
  MenubarSub,
  MenubarSubContent,
  MenubarSubTrigger,
} from "@lunar-spice/components/ui/menubar";

import { comboText } from "../../lib/shortcuts";
import { type CanvasCommandId, commandLabel, commandText } from "./commands";
import type { EditorController } from "./editor-controller";
import { ToolIcon } from "./tool-icons";
import { groupTools, TOOLS } from "./tools";

/*
 * Menu rows for the canvas commands, read from the same tables as the keys and the
 * shortcuts dialog. Each list is its own component, so a menu reads the editor's undo
 * and selection state when it opens rather than when the menu bar renders.
 */

/** A menu row named and keyed by its canvas command. */
function CommandItem({
  command,
  label,
  disabled,
  onClick,
}: {
  command: CanvasCommandId;
  label?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <MenubarItem disabled={disabled} onClick={onClick}>
      {label ?? commandLabel(command)}
      <MenubarShortcut>{commandText(command)}</MenubarShortcut>
    </MenubarItem>
  );
}

/** Undo, the clipboard, selection and transforms. */
export function EditMenuItems({
  controller,
}: {
  controller: EditorController | null;
}) {
  const hasSelection = (controller?.selectionCount ?? 0) > 0;

  return (
    <>
      <CommandItem
        command="undo"
        disabled={!controller?.canUndo}
        onClick={() => controller?.undo()}
      />
      <CommandItem
        command="redo"
        disabled={!controller?.canRedo}
        onClick={() => controller?.redo()}
      />
      <MenubarSeparator />
      <CommandItem
        command="cut"
        disabled={!hasSelection}
        onClick={() => controller?.cutSelection()}
      />
      <CommandItem
        command="copy"
        disabled={!hasSelection}
        onClick={() => controller?.copySelection()}
      />
      <CommandItem
        command="paste"
        disabled={!controller}
        onClick={() => controller?.pasteFromClipboard(false)}
      />
      <CommandItem
        command="paste-in-place"
        disabled={!controller}
        onClick={() => controller?.pasteFromClipboard(true)}
      />
      <MenubarSeparator />
      <CommandItem
        command="duplicate"
        disabled={!hasSelection}
        onClick={() => controller?.duplicateSelection()}
      />
      <CommandItem
        command="delete"
        disabled={!hasSelection}
        onClick={() => controller?.deleteSelection()}
      />
      <CommandItem
        command="edit"
        label="Edit properties…"
        disabled={controller?.selectionCount !== 1}
        onClick={() => controller?.editSelection()}
      />
      <MenubarSeparator />
      <CommandItem
        command="select-all"
        disabled={!controller}
        onClick={() => controller?.selectAll()}
      />
      <MenubarSeparator />
      <CommandItem
        command="rotate-left"
        disabled={!hasSelection}
        onClick={() => controller?.rotateSelection(false)}
      />
      <CommandItem
        command="rotate-right"
        disabled={!hasSelection}
        onClick={() => controller?.rotateSelection(true)}
      />
      <CommandItem
        command="flip-horizontal"
        disabled={!hasSelection}
        onClick={() => controller?.flipSelection("horizontal")}
      />
      <CommandItem
        command="flip-vertical"
        disabled={!hasSelection}
        onClick={() => controller?.flipSelection("vertical")}
      />
    </>
  );
}

/** Zooming the canvas. */
export function ZoomMenuItems({
  controller,
}: {
  controller: EditorController | null;
}) {
  return (
    <>
      <CommandItem command="zoom-in" onClick={() => controller?.zoomIn()} />
      <CommandItem command="zoom-out" onClick={() => controller?.zoomOut()} />
      <CommandItem command="zoom-1" onClick={() => controller?.zoomTo(1)} />
      <CommandItem
        command="zoom-selection"
        disabled={(controller?.selectionCount ?? 0) === 0}
        onClick={() => controller?.zoomToSelection()}
      />
      <CommandItem
        command="zoom-drawing"
        onClick={() => controller?.zoomToDrawing()}
      />
    </>
  );
}

/** Run or pause and reset the interactive simulation. */
export function RunMenuItems({
  controller,
  isRunning,
}: {
  controller: EditorController | null;
  isRunning: boolean;
}) {
  return (
    <>
      <CommandItem
        command="run"
        label={isRunning ? "Pause" : "Run"}
        disabled={!controller}
        onClick={() => controller?.toggleRunning()}
      />
      <CommandItem
        command="reset"
        label="Reset"
        disabled={!controller}
        onClick={() => controller?.resetSimulation()}
      />
    </>
  );
}

/** Opens the shortcuts dialog. */
export function ShortcutsMenuItem({
  controller,
}: {
  controller: EditorController | null;
}) {
  return (
    <CommandItem
      command="help"
      disabled={!controller}
      onClick={() => controller?.requestHelp()}
    />
  );
}

const [GENERAL_TOOLS, ...PART_GROUPS] = groupTools(TOOLS);

/** One tool as a menu row, checked while it is the tool in use. */
function ToolItems({ tools }: { tools: readonly (typeof TOOLS)[number][] }) {
  return tools.map((tool) => {
    const [combo] = tool.keys;

    return (
      <MenubarRadioItem key={tool.id} value={tool.id}>
        <ToolIcon toolId={tool.id} />
        {tool.label}
        {combo && <MenubarShortcut>{comboText(combo)}</MenubarShortcut>}
      </MenubarRadioItem>
    );
  });
}

/** Every tool: Select, Wire and the other general tools, then the parts by group. */
export function ToolMenuItems({
  controller,
}: {
  controller: EditorController | null;
}) {
  const toolId = controller?.toolId;

  return (
    <>
      {GENERAL_TOOLS && (
        <MenubarRadioGroup
          value={toolId}
          onValueChange={(id) => controller?.setTool(String(id))}
        >
          <ToolItems tools={GENERAL_TOOLS.tools} />
        </MenubarRadioGroup>
      )}
      <MenubarSeparator />
      {PART_GROUPS.map(({ title, tools }) => (
        <MenubarSub key={title}>
          <MenubarSubTrigger>{title}</MenubarSubTrigger>
          <MenubarSubContent className="min-w-56">
            <MenubarRadioGroup
              value={toolId}
              onValueChange={(id) => controller?.setTool(String(id))}
            >
              <ToolItems tools={tools} />
            </MenubarRadioGroup>
          </MenubarSubContent>
        </MenubarSub>
      ))}
    </>
  );
}
