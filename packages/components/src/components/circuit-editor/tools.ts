import type {
  CircuitElement,
  ElementKind,
} from "@lunar-spice/simulator/element";
import { Switch } from "@lunar-spice/simulator/elements/connectors";
import { VoltageSource } from "@lunar-spice/simulator/elements/sources";

import { findPressed, type KeyCombo } from "../../lib/shortcuts";

/** The headings the component picker and the shortcuts dialog sort tools under, in order. */
const TOOL_GROUPS = [
  "General",
  "Passive",
  "Sources",
  "Switches",
  "Semiconductors",
  "Integrated circuits",
  "Audio",
] as const;

type ToolGroup = (typeof TOOL_GROUPS)[number];

/** What a toolbar button does: select and move, or place one kind of element. */
export type Tool = {
  id: string;
  label: string;
  group: ToolGroup;
  /** The element it places; null for the select tool. */
  kind: ElementKind | null;
  /** Letters with or without Shift; Ctrl and Alt belong to editing and zoom. */
  keys: readonly KeyCombo[];
  /**
   * From the click point to the second point. Parts always place at this size, as in
   * Multisim; only wires stretch to where they are dragged.
   */
  size: { dx: number; dy: number };
  /** Sets the variant a tool places, such as a sine source or a PNP transistor. */
  configure?: (element: CircuitElement) => void;
  /** Shown in the toolbar itself rather than under More. */
  isPrimary: boolean;
};

/** A tool key: `letter` with Shift held, or by default with Shift released. */
function key(letter: string, shift = false): KeyCombo {
  return { key: letter, shift };
}

/** Selects and moves; the tool the editor starts with and Escape returns to. */
export const SELECT_TOOL = {
  id: "select",
  label: "Select and move",
  group: "General",
  kind: null,
  keys: [key("s"), { key: "F1" }],
  size: { dx: 0, dy: 0 },
  isPrimary: true,
} as const satisfies Tool;

/**
 * Every tool. Letters avoid Inkscape's editing keys (H and V flip, S selects, digits
 * zoom), so they never collide with the movement and view shortcuts.
 */
const TOOL_DEFINITIONS = [
  SELECT_TOOL,

  {
    id: "wire",
    label: "Wire",
    group: "General",
    kind: "wire",
    keys: [key("w")],
    size: { dx: 64, dy: 0 },
    isPrimary: true,
  },
  {
    id: "resistor",
    label: "Resistor",
    group: "Passive",
    kind: "resistor",
    keys: [key("r")],
    size: { dx: 64, dy: 0 },
    isPrimary: true,
  },
  {
    id: "potentiometer",
    label: "Potentiometer (3-pin)",
    group: "Passive",
    kind: "potentiometer",
    keys: [key("f")],
    size: { dx: 64, dy: 0 },
    isPrimary: false,
  },
  {
    id: "variable-resistor",
    label: "Potentiometer (2-pin)",
    group: "Passive",
    kind: "variable-resistor",
    keys: [key("f", true)],
    size: { dx: 64, dy: 0 },
    isPrimary: false,
  },
  {
    id: "capacitor",
    label: "Capacitor",
    group: "Passive",
    kind: "capacitor",
    keys: [key("c")],
    size: { dx: 64, dy: 0 },
    isPrimary: true,
  },
  {
    id: "inductor",
    label: "Inductor",
    group: "Passive",
    kind: "inductor",
    keys: [key("l")],
    size: { dx: 64, dy: 0 },
    isPrimary: true,
  },
  {
    id: "dc-source",
    label: "DC voltage source",
    group: "Sources",
    kind: "voltage-source",
    keys: [key("b")],
    size: { dx: 0, dy: -64 },
    isPrimary: true,
  },
  {
    id: "ac-source",
    label: "AC voltage source",
    group: "Sources",
    kind: "voltage-source",
    keys: [key("a")],
    size: { dx: 0, dy: -64 },
    configure: (element) => {
      if (element instanceof VoltageSource) {
        element.waveform = "sine";
      }
    },
    isPrimary: true,
  },
  {
    id: "ground",
    label: "Ground",
    group: "General",
    kind: "ground",
    keys: [key("g")],
    size: { dx: 0, dy: 16 },
    isPrimary: true,
  },
  {
    id: "switch",
    label: "Switch",
    group: "Switches",
    kind: "switch",
    keys: [key("k")],
    size: { dx: 64, dy: 0 },
    isPrimary: true,
  },
  {
    id: "push-switch",
    label: "Push switch",
    group: "Switches",
    kind: "switch",
    keys: [key("k", true)],
    size: { dx: 64, dy: 0 },
    configure: (element) => {
      if (element instanceof Switch) {
        element.isMomentary = true;
        element.press(false);
      }
    },
    isPrimary: true,
  },
  {
    id: "spdt-switch",
    label: "Changeover switch",
    group: "Switches",
    kind: "spdt-switch",
    keys: [key("j")],
    size: { dx: 64, dy: 0 },
    isPrimary: true,
  },
  {
    id: "diode",
    label: "Diode",
    group: "Semiconductors",
    kind: "diode",
    keys: [key("d")],
    size: { dx: 64, dy: 0 },
    isPrimary: true,
  },
  {
    id: "npn",
    label: "NPN transistor",
    group: "Semiconductors",
    kind: "bjt",
    keys: [key("t")],
    size: { dx: 32, dy: 0 },
    isPrimary: true,
  },
  {
    id: "op-amp",
    label: "Op-amp",
    group: "Integrated circuits",
    kind: "op-amp",
    keys: [key("o")],
    size: { dx: 96, dy: 0 },
    isPrimary: true,
  },
  {
    id: "rail",
    label: "Voltage rail",
    group: "Sources",
    kind: "rail",
    keys: [key("b", true)],
    size: { dx: 0, dy: -32 },
    isPrimary: false,
  },
  {
    id: "current-source",
    label: "Current source",
    group: "Sources",
    kind: "current-source",
    keys: [key("i")],
    size: { dx: 0, dy: -64 },
    isPrimary: false,
  },
  {
    id: "push-switch-nc",
    label: "Push switch (normally closed)",
    group: "Switches",
    kind: "switch",
    keys: [key("j", true)],
    size: { dx: 64, dy: 0 },
    configure: (element) => {
      if (element instanceof Switch) {
        element.isMomentary = true;
        element.isNormallyClosed = true;
        element.press(false);
      }
    },
    isPrimary: false,
  },
  {
    id: "led",
    label: "LED",
    group: "Semiconductors",
    kind: "led",
    keys: [key("e")],
    size: { dx: 0, dy: 64 },
    isPrimary: false,
  },
  {
    id: "pnp",
    label: "PNP transistor",
    group: "Semiconductors",
    kind: "bjt",
    keys: [key("t", true)],
    size: { dx: 32, dy: 0 },
    configure: (element) => element.setPolarity(-1),
    isPrimary: false,
  },
  {
    id: "nmos",
    label: "N-channel MOSFET",
    group: "Semiconductors",
    kind: "mosfet",
    keys: [key("m")],
    size: { dx: 32, dy: 0 },
    isPrimary: false,
  },
  {
    id: "pmos",
    label: "P-channel MOSFET",
    group: "Semiconductors",
    kind: "mosfet",
    keys: [key("m", true)],
    size: { dx: 32, dy: 0 },
    configure: (element) => element.setPolarity(-1),
    isPrimary: false,
  },
  {
    id: "regulator",
    label: "Fixed regulator",
    group: "Integrated circuits",
    kind: "regulator",
    keys: [key("u")],
    size: { dx: 96, dy: 0 },
    isPrimary: false,
  },
  {
    id: "adjustable-regulator",
    label: "Adjustable regulator",
    group: "Integrated circuits",
    kind: "adjustable-regulator",
    keys: [key("u", true)],
    size: { dx: 96, dy: 0 },
    isPrimary: false,
  },
  {
    id: "schmitt-trigger",
    label: "Schmitt trigger",
    group: "Integrated circuits",
    kind: "schmitt-trigger",
    keys: [key("y")],
    size: { dx: 64, dy: 0 },
    isPrimary: false,
  },
  {
    id: "inverting-schmitt-trigger",
    label: "Inverting Schmitt trigger",
    group: "Integrated circuits",
    kind: "schmitt-trigger",
    keys: [key("y", true)],
    size: { dx: 64, dy: 0 },
    configure: (element) => element.setPolarity(-1),
    isPrimary: false,
  },
  {
    id: "timer",
    label: "555 timer",
    group: "Integrated circuits",
    kind: "timer",
    keys: [key("x")],
    size: { dx: 0, dy: 0 },
    isPrimary: false,
  },
  {
    id: "microphone",
    label: "Electret microphone",
    group: "Audio",
    kind: "microphone",
    keys: [key("a", true)],
    size: { dx: 0, dy: 64 },
    isPrimary: false,
  },
  {
    id: "speaker",
    label: "Speaker",
    group: "Audio",
    kind: "speaker",
    keys: [key("p", true)],
    size: { dx: 0, dy: 64 },
    isPrimary: false,
  },
  {
    id: "probe",
    label: "Voltage probe",
    group: "General",
    kind: "probe",
    keys: [key("p")],
    size: { dx: 0, dy: 64 },
    isPrimary: false,
  },
  {
    id: "label",
    label: "Net label",
    group: "General",
    kind: "label",
    keys: [key("n")],
    size: { dx: 32, dy: 0 },
    isPrimary: false,
  },
] as const satisfies readonly Tool[];

/** Every tool's id; each needs a glyph in tool-icons.tsx. */
export type ToolId = (typeof TOOL_DEFINITIONS)[number]["id"];

export const TOOLS: readonly (Tool & { id: ToolId })[] = TOOL_DEFINITIONS;

/** `tools` under their group headings, in group order; empty groups are left out. */
export function groupTools<T extends Tool>(tools: readonly T[]) {
  return TOOL_GROUPS.flatMap((title) => {
    const members = tools.filter((tool) => tool.group === title);

    return members.length > 0 ? [{ title, tools: members }] : [];
  });
}

export function findTool(id: string) {
  return TOOLS.find((tool) => tool.id === id);
}

/** The tool a key press picks, or undefined. */
export function toolForKey(event: KeyboardEvent) {
  return findPressed(TOOLS, event);
}
