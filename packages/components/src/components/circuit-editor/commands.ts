import {
  comboLabel,
  comboText,
  findPressed,
  type KeyCombo,
  type ShortcutInfo,
  type ShortcutTab,
} from "../../lib/shortcuts";
import type { EditorController } from "./editor-controller";
import { groupTools, TOOLS } from "./tools";

/**
 * A canvas command and its keys. The editor runs it on a matching key press; the
 * shortcuts dialog, tooltips and the context menu show its label and keys.
 */
type CanvasCommand = {
  id: string;
  label: string;
  section: "Edit" | "Move and transform" | "View" | "Simulation";
  keys: readonly KeyCombo[];
  /** What the shortcuts dialog shows when it differs from `keys`, such as gestures. */
  shown?: readonly KeyCombo[];
  /** Absent for gestures the editor handles itself, which the dialog only lists. */
  run?: (editor: EditorController, event: KeyboardEvent) => void;
};

const ARROW_STEPS = new Map([
  ["ArrowLeft", [-1, 0]],
  ["ArrowRight", [1, 0]],
  ["ArrowUp", [0, -1]],
  ["ArrowDown", [0, 1]],
]);

/** Grid steps Shift multiplies arrow moves by, as in Inkscape. */
const SHIFT_MOVE_STEPS = 10;

/** Canvas pixels a Ctrl+Arrow scroll moves. */
const ARROW_SCROLL = 64;

/** The four arrows with the given modifiers. */
function arrows(modifiers: Omit<KeyCombo, "key">) {
  return [...ARROW_STEPS.keys()].map((key) => ({ key, ...modifiers }));
}

/** The grid direction of an arrow key press. */
function arrowStep({ key }: KeyboardEvent) {
  const [x = 0, y = 0] = ARROW_STEPS.get(key) ?? [];

  return { x, y };
}

/**
 * Every canvas shortcut. Moving, zooming, rotating, flipping and duplicating follow
 * Inkscape; tool letters (in tools.ts) avoid these keys.
 */
const CANVAS_COMMANDS = [
  {
    id: "undo",
    label: "Undo",
    section: "Edit",
    keys: [{ key: "z", mod: true, shift: false }],
    run: (editor) => editor.undo(),
  },
  {
    id: "redo",
    label: "Redo",
    section: "Edit",
    keys: [
      { key: "z", mod: true, shift: true },
      { key: "y", mod: true },
    ],
    run: (editor) => editor.redo(),
  },
  {
    id: "cut",
    label: "Cut",
    section: "Edit",
    keys: [{ key: "x", mod: true, shift: false }],
    run: (editor) => editor.cutSelection(),
  },
  {
    id: "copy",
    label: "Copy",
    section: "Edit",
    keys: [{ key: "c", mod: true, shift: false }],
    run: (editor) => editor.copySelection(),
  },
  {
    id: "paste",
    label: "Paste",
    section: "Edit",
    keys: [{ key: "v", mod: true, shift: false }],
    run: (editor) => editor.pasteFromClipboard(false),
  },
  {
    id: "paste-in-place",
    label: "Paste in place",
    section: "Edit",
    keys: [{ key: "v", mod: true, alt: true, shift: false }],
    run: (editor) => editor.pasteFromClipboard(true),
  },
  {
    id: "duplicate",
    label: "Duplicate",
    section: "Edit",
    keys: [{ key: "d", mod: true, shift: false }],
    run: (editor) => editor.duplicateSelection(),
  },
  {
    id: "delete",
    label: "Delete",
    section: "Edit",
    keys: [{ key: "Delete" }, { key: "Backspace" }],
    run: (editor) => editor.deleteSelection(),
  },
  {
    id: "edit",
    label: "Edit properties",
    section: "Edit",
    keys: [{ key: "Enter" }],
    shown: [{ key: "Enter" }, { key: "Double-click" }],
    run: (editor) => editor.editSelection(),
  },
  {
    id: "select-all",
    label: "Select all",
    section: "Edit",
    keys: [{ key: "a", mod: true, shift: false }],
    run: (editor) => editor.selectAll(),
  },
  {
    id: "cycle",
    label: "Select next or previous",
    section: "Edit",
    keys: [{ key: "Tab" }],
    shown: [{ key: "Tab" }, { key: "Tab", shift: true }],
    run: (editor, event) => editor.cycleSelection(event.shiftKey),
  },
  {
    id: "escape",
    label: "Deselect, or back to Select",
    section: "Edit",
    keys: [{ key: "Escape" }],
    run: (editor) => editor.escape(),
  },
  {
    id: "help",
    label: "Keyboard shortcuts",
    section: "Edit",
    keys: [{ key: "?" }],
    run: (editor) => editor.requestHelp(),
  },
  {
    id: "move",
    label: "Move one grid step",
    section: "Move and transform",
    keys: arrows({ shift: false }),
    shown: [{ key: "Arrow" }],
    run: (editor, event) => {
      const { x, y } = arrowStep(event);

      editor.moveSelection(x, y);
    },
  },
  {
    id: "move-far",
    label: "Move ten grid steps",
    section: "Move and transform",
    keys: arrows({ shift: true }),
    shown: [{ key: "Arrow", shift: true }],
    run: (editor, event) => {
      const { x, y } = arrowStep(event);

      editor.moveSelection(x * SHIFT_MOVE_STEPS, y * SHIFT_MOVE_STEPS);
    },
  },
  {
    id: "rotate-left",
    label: "Rotate a quarter turn left",
    section: "Move and transform",
    keys: [{ key: "[" }, { key: "[", mod: true }],
    shown: [{ key: "[" }],
    run: (editor) => editor.rotateSelection(false),
  },
  {
    id: "rotate-right",
    label: "Rotate a quarter turn right",
    section: "Move and transform",
    // Ctrl+R first: menus and tooltips show a command's first key.
    keys: [{ key: "r", mod: true }, { key: "]" }, { key: "]", mod: true }],
    shown: [{ key: "]" }, { key: "r", mod: true }],
    run: (editor) => editor.rotateSelection(true),
  },
  {
    id: "flip-horizontal",
    label: "Flip horizontally",
    section: "Move and transform",
    keys: [{ key: "h" }],
    run: (editor) => editor.flipSelection("horizontal"),
  },
  {
    id: "flip-vertical",
    label: "Flip vertically",
    section: "Move and transform",
    keys: [{ key: "v" }],
    run: (editor) => editor.flipSelection("vertical"),
  },
  {
    id: "zoom-in",
    label: "Zoom in",
    section: "View",
    keys: [{ key: "+" }, { key: "=" }],
    shown: [{ key: "+" }, { key: "Wheel", mod: true }],
    run: (editor) => editor.zoomIn(),
  },
  {
    id: "zoom-out",
    label: "Zoom out",
    section: "View",
    keys: [{ key: "-" }, { key: "_" }],
    shown: [{ key: "-" }],
    run: (editor) => editor.zoomOut(),
  },
  {
    id: "zoom-1",
    label: "Zoom 1:1",
    section: "View",
    keys: [{ key: "1" }],
    run: (editor) => editor.zoomTo(1),
  },
  {
    id: "zoom-selection",
    label: "Zoom to selection",
    section: "View",
    keys: [{ key: "3" }],
    run: (editor) => editor.zoomToSelection(),
  },
  {
    id: "zoom-drawing",
    label: "Zoom to drawing",
    section: "View",
    keys: [{ key: "4" }, { key: "5" }],
    run: (editor) => editor.zoomToDrawing(),
  },
  {
    id: "scroll",
    label: "Scroll",
    section: "View",
    keys: arrows({ mod: true }),
    shown: [
      { key: "Wheel" },
      { key: "Wheel", shift: true },
      { key: "Arrow", mod: true },
    ],
    run: (editor, event) => {
      const { x, y } = arrowStep(event);

      editor.scrollBy(x * ARROW_SCROLL, y * ARROW_SCROLL);
    },
  },
  {
    id: "pan",
    label: "Pan",
    section: "View",
    keys: [],
    shown: [{ key: "Space+Drag" }, { key: "Middle drag" }],
  },
  {
    id: "run",
    label: "Run or pause",
    section: "Simulation",
    keys: [{ key: "F5", shift: false }],
    run: (editor) => editor.toggleRunning(),
  },
  {
    id: "reset",
    label: "Reset",
    section: "Simulation",
    keys: [{ key: "F5", shift: true }],
    run: (editor) => editor.resetSimulation(),
  },
] as const satisfies readonly CanvasCommand[];

export type CanvasCommandId = (typeof CANVAS_COMMANDS)[number]["id"];

/** The commands as one type, to look through without narrowing to each. */
const COMMANDS: readonly CanvasCommand[] = CANVAS_COMMANDS;

/** The commands a key press can run; gestures the dialog only lists are left out. */
const KEYED_COMMANDS = COMMANDS.filter(({ run }) => run !== undefined);

/** The command a key press runs, or undefined. */
export function commandForKey(event: KeyboardEvent) {
  return findPressed(KEYED_COMMANDS, event);
}

/** The keycaps of a command's first key, for tooltips and menus. */
export function commandKeys(id: CanvasCommandId) {
  const combo = COMMANDS.find((command) => command.id === id)?.keys[0];

  return combo ? comboLabel(combo) : [];
}

/** A command's first key written inline, as menus show it. */
export function commandText(id: CanvasCommandId) {
  const combo = COMMANDS.find((command) => command.id === id)?.keys[0];

  return combo ? comboText(combo) : "";
}

/** The label of a command, as menus name it. */
export function commandLabel(id: CanvasCommandId) {
  return COMMANDS.find((command) => command.id === id)?.label ?? id;
}

/** The shortcuts dialog tab each command section sits in. */
const SECTION_TABS = {
  Edit: "Editing",
  "Move and transform": "Editing",
  View: "View and simulation",
  Simulation: "View and simulation",
} as const satisfies Record<CanvasCommand["section"], string>;

/**
 * The canvas commands, then the tools by group, as tabs of the shortcuts dialog.
 */
export function canvasShortcutTabs(): ShortcutTab[] {
  const tabs = new Map<string, Map<string, ShortcutInfo[]>>();

  for (const { section, label, keys, shown } of COMMANDS) {
    const tab = SECTION_TABS[section];
    const sections = tabs.get(tab) ?? new Map<string, ShortcutInfo[]>();

    sections.set(section, [
      ...(sections.get(section) ?? []),
      { label, keys: shown ?? keys },
    ]);
    tabs.set(tab, sections);
  }

  return [
    ...[...tabs].map(([title, sections]) => ({
      title,
      sections: [...sections].map(([section, items]) => ({
        title: section,
        items,
      })),
    })),
    {
      title: "Components",
      sections: groupTools(TOOLS).map(({ title, tools }) => ({
        title,
        items: tools.map(({ label, keys }) => ({ label, keys })),
      })),
    },
  ];
}
