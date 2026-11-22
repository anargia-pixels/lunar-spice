import { findTool, TOOLS } from "@lunar-spice/components/circuit-editor/tools";
import {
  type AcSweepOptions,
  type AnalysisResult,
  cornerFrequencies,
  toDecibels,
  type TransientOptions,
} from "@lunar-spice/simulator/analyses";
import {
  Circuit,
  createElement,
  type SimulationSettings,
} from "@lunar-spice/simulator/circuit";
import {
  type CircuitElement,
  type EditField,
  type ElementKind,
  rangeError,
  type ValueRange,
} from "@lunar-spice/simulator/element";
import { NetLabel } from "@lunar-spice/simulator/elements/connectors";
import { TIMER_PINS } from "@lunar-spice/simulator/elements/integrated-circuits";
import { OSCILLOSCOPE_PINS } from "@lunar-spice/simulator/elements/oscilloscope";
import {
  GRID_SIZE,
  type Point,
  snapToGrid,
} from "@lunar-spice/simulator/geometry";
import { buildNetlist } from "@lunar-spice/simulator/netlist";
import { parseSi } from "@lunar-spice/simulator/units";
import { deleteWithWires } from "@lunar-spice/simulator/wiring";

import type { AnalysisRequest } from "./analysis-request";

/** A value as JSON carries it: how an agent's arguments arrive and results leave. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | JsonObject;

/** A JSON object, such as a tool's arguments. */
export type JsonObject = { readonly [key: string]: JsonValue | undefined };

/** The interactive simulation's state, as agent tools report it. */
type RunState = { isRunning: boolean; time: number; error: string | null };

/** What `control_simulation` can ask of the interactive simulation. */
export type RunAction = "run" | "pause" | "reset" | "status";

/**
 * What agent tools act on: the open circuit in the editor and the app around it. Edits
 * go through `edit`, one undo step each, so the user can undo what an agent did.
 */
export type CircuitHost = {
  /** The open circuit's title. */
  title: () => string;
  /** The open circuit in its file format, as the editor last reported it. */
  text: () => string;
  /** Changes the open circuit, whose elements are in `text`'s order, as one undo step. */
  edit: (change: (circuit: Circuit) => void) => void;
  /** Opens `text` as a new draft called `title`. */
  openDraft: (title: string, text: string) => void;
  /** Runs an analysis of the open circuit and shows it in the results panel. */
  analyze: (request: AnalysisRequest) => Promise<AnalysisResult>;
  /** Runs, pauses or resets the interactive simulation, or reads its state. */
  simulate: (action: RunAction) => RunState;
};

/** WebMCP's hints on what a tool does. */
type ToolAnnotations = { readOnlyHint: boolean; untrustedContentHint: boolean };

/** One tool an agent can call, in WebMCP's shape plus the function that runs it. */
export type AgentTool = {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonObject;
  annotations: ToolAnnotations;
  run: (input: JsonObject, host: CircuitHost) => JsonValue | Promise<JsonValue>;
};

/** A mistake in what the agent asked for, reported back so it can fix the call. */
export class ToolInputError extends Error {}

// Reading arguments

/** True for a JSON object, not an array. */
function isObject(value: JsonValue | undefined): value is JsonObject {
  return value instanceof Object && !Array.isArray(value);
}

function isList(value: JsonValue | undefined): value is readonly JsonValue[] {
  return Array.isArray(value);
}

/** True for a string, number or boolean. */
function isScalar(value: JsonValue | undefined) {
  return value !== undefined && value !== null && !(value instanceof Object);
}

function objectOf(value: JsonValue | undefined, what: string) {
  if (!isObject(value)) {
    throw new ToolInputError(`${what} must be an object.`);
  }

  return value;
}

function listOf(value: JsonValue | undefined, what: string) {
  if (!isList(value) || value.length === 0) {
    throw new ToolInputError(`${what} must be a non-empty array.`);
  }

  return value;
}

function textOf(value: JsonValue | undefined, what: string) {
  const content = isScalar(value) ? String(value).trim() : "";

  if (!content) {
    throw new ToolInputError(`${what} must be a non-empty string.`);
  }

  return content;
}

/** A number, or a value with an SI prefix such as `4.7k` or `10u`. */
function quantity(value: JsonValue | undefined, what: string) {
  const parsed =
    isScalar(value) && value !== true && value !== false
      ? parseSi(String(value))
      : null;

  if (parsed === null || !Number.isFinite(parsed)) {
    throw new ToolInputError(
      `${what} must be a number or a value such as 4.7k or 10u.`,
    );
  }

  return parsed;
}

function optionalQuantity(
  value: JsonValue | undefined,
  what: string,
  fallback: number,
) {
  return value === undefined ? fallback : quantity(value, what);
}

/** A point given as `[x, y]` or `{ x, y }`; null for anything else. */
function pointOf(value: JsonValue | undefined, what: string): Point | null {
  if (isList(value) && value.length === 2) {
    return { x: quantity(value[0], what), y: quantity(value[1], what) };
  }

  if (isObject(value) && "x" in value) {
    return { x: quantity(value.x, what), y: quantity(value.y, what) };
  }

  return null;
}

/** The names in a list of strings, or null when there are none. */
function namesOf(value: JsonValue | undefined) {
  return isList(value) && value.length > 0 ? value.map(String) : null;
}

function snapped({ x, y }: Point) {
  return { x: snapToGrid(x), y: snapToGrid(y) };
}

// Parts and pins

/** What each post is called, by kind, in post order; others are numbered from 1. */
const PIN_NAMES: Partial<Record<ElementKind, readonly string[]>> = {
  "voltage-source": ["-", "+"],
  rail: ["+"],
  "current-source": ["in", "out"],
  potentiometer: ["1", "2", "W"],
  "spdt-switch": ["COM", "A", "B"],
  diode: ["A", "K"],
  led: ["A", "K"],
  optocoupler: ["A", "K", "C", "E"],
  vactrol: ["A", "K", "1", "2"],
  bjt: ["B", "C", "E"],
  mosfet: ["G", "S", "D"],
  jfet: ["G", "S", "D"],
  "op-amp": ["-", "+", "OUT", "VCC", "VEE"],
  "schmitt-trigger": ["IN", "OUT"],
  regulator: ["IN", "OUT", "GND"],
  "adjustable-regulator": ["IN", "OUT", "ADJ"],
  timer: TIMER_PINS.map(({ name }) => name),
  oscilloscope: OSCILLOSCOPE_PINS.map(({ name }) => name),
  microphone: ["+", "-"],
  voltmeter: ["+", "-"],
};

function pinNames(element: CircuitElement) {
  const names = PIN_NAMES[element.kind] ?? [];

  return element
    .posts()
    .map((_post, index) => names[index] ?? String(index + 1));
}

/** How a part is referred to: its designator, or `#` and its place in the file. */
function referenceOf(element: CircuitElement, index: number) {
  return element.designator || `#${index}`;
}

/** Finds the element `reference` names: a designator such as R1, or `#3`. */
function findElement(elements: readonly CircuitElement[], reference: string) {
  const wanted = reference.trim();

  const index = wanted.startsWith("#")
    ? Number(wanted.slice(1))
    : elements.findIndex(
        ({ designator }) => designator.toLowerCase() === wanted.toLowerCase(),
      );

  const element = elements[index];

  if (!element || !Number.isInteger(index)) {
    throw new ToolInputError(
      `No part ${reference}. Call get_circuit for the parts and their references.`,
    );
  }

  return { element, index };
}

/** Finds the element and post index a pin such as `R1:2`, `Q1:B` or `#4:1` names. */
function findPin(elements: readonly CircuitElement[], reference: string) {
  const separator = reference.lastIndexOf(":");

  if (separator < 1) {
    throw new ToolInputError(
      `Pin ${reference} needs a part and a pin, such as R1:1 or Q1:B.`,
    );
  }

  const { element } = findElement(elements, reference.slice(0, separator));

  const wanted = reference
    .slice(separator + 1)
    .trim()
    .toLowerCase();

  const names = pinNames(element);
  const pin = names.findIndex((name) => name.toLowerCase() === wanted);
  const post = element.posts()[pin];

  if (!post) {
    throw new ToolInputError(
      `${element.title()} has no pin ${wanted}; its pins are ${names.join(", ")}.`,
    );
  }

  return { element, pin, post };
}

/** A pin reference or a point. */
function placeOf(
  elements: readonly CircuitElement[],
  value: JsonValue | undefined,
) {
  if (isScalar(value)) {
    return findPin(elements, String(value)).post;
  }

  const at = pointOf(value, "A point");

  if (!at) {
    throw new ToolInputError(
      "Each pin must be a reference such as R1:2, or a point [x, y].",
    );
  }

  return snapped(at);
}

/** The middle of `element`'s posts, for pointing labels away from it. */
function centerOf(element: CircuitElement) {
  const posts = element.posts();
  const count = Math.max(1, posts.length);

  return {
    x: posts.reduce((sum, { x }) => sum + x, 0) / count,
    y: posts.reduce((sum, { y }) => sum + y, 0) / count,
  };
}

/** A part's value, as `list_parts` describes it to an agent. */
type FieldInfo = {
  key: string;
  label: string;
  kind: EditField["kind"];
  unit?: string;
  range?: ValueRange;
  options?: readonly string[];
  hint?: string;
  value?: JsonValue;
};

/** A pin with where it sits and the net it is on. */
type PinInfo = { pin: string; x: number; y: number; net: string };

/** A part as the tools describe it: its reference, kind, value and pins. */
type ElementInfo = {
  ref: string;
  kind: ElementKind;
  name: string;
  pins: readonly PinInfo[];
  value?: string;
  values?: JsonObject;
};

/** A wire, net label, ground or group: what joins nets or outlines parts. */
type ConnectorInfo = {
  ref: string;
  kind: ElementKind;
  points: readonly Point[];
  net: string | null;
  text?: string;
};

/** The circuit as `get_circuit` describes it. */
type CircuitInfo = {
  title: string;
  settings: SimulationSettings;
  parts: readonly ElementInfo[];
  nets: Readonly<Record<string, readonly string[]>>;
  connectors: readonly ConnectorInfo[];
  floatingPins: readonly string[];
  skippedTypes?: readonly string[];
  text?: string;
};

/** A part tool as `list_parts` describes it. */
type ToolInfo = {
  tool: string;
  label: string;
  group: string;
  pins: readonly { pin: string; dx: number; dy: number }[];
  values?: readonly FieldInfo[];
};

// Values

/** The value a field holds, as an agent reads it; null for a pasted SPICE card. */
function fieldValue(field: EditField) {
  switch (field.kind) {
    case "spice":
      return null;
    case "clip":
      return field.value?.name ?? null;
    default:
      return field.value;
  }
}

/** The dialog's fields an agent can set: all but sound clips. */
function settableFields(element: CircuitElement) {
  return element.dialogFields().filter((field) => field.kind !== "clip");
}

/** Describes a field for an agent: its key, what it takes and what it holds. */
function describeField(field: EditField) {
  const described: FieldInfo = {
    key: field.key,
    label: field.label,
    kind: field.kind,
  };

  if (field.kind === "number") {
    described.unit = field.unit;
    described.range = field.range;
  }

  if (field.kind === "choice") {
    described.options = field.options.map(({ value }) => value);
  }

  if (field.kind === "preset") {
    described.options = field.options;
  }

  if (field.hint) {
    described.hint = field.hint;
  }

  if (field.kind !== "spice") {
    described.value = fieldValue(field);
  }

  return described;
}

/** Sets one field from an agent's value; throws when the value does not fit. */
function setField(field: EditField, value: JsonValue | undefined) {
  const what = `${field.label} (${field.key})`;
  const wanted = isScalar(value) ? String(value) : "";

  switch (field.kind) {
    case "number": {
      const parsed = quantity(value, what);
      const error = rangeError(parsed, field.range);

      if (error) {
        throw new ToolInputError(`${what}: ${error}`);
      }

      field.set(parsed);

      return;
    }
    case "choice": {
      const option = field.options.find(
        (candidate) =>
          candidate.value.toLowerCase() === wanted.toLowerCase() ||
          candidate.label.toLowerCase() === wanted.toLowerCase(),
      );

      if (!option) {
        throw new ToolInputError(
          `${what} takes ${field.options.map((candidate) => candidate.value).join(", ")}.`,
        );
      }

      field.set(option.value);

      return;
    }
    case "preset": {
      const option = field.options.find(
        (candidate) => candidate.toLowerCase() === wanted.toLowerCase(),
      );

      if (!option) {
        throw new ToolInputError(`${what} takes ${field.options.join(", ")}.`);
      }

      field.set(option);

      return;
    }
    case "boolean":
      if (value !== true && value !== false) {
        throw new ToolInputError(`${what} takes true or false.`);
      }

      field.set(value);

      return;
    case "text":
      field.set(wanted);

      return;
    case "spice": {
      const error = field.set(wanted);

      if (error) {
        throw new ToolInputError(`${what}: ${error}`);
      }

      return;
    }
    case "clip":
      throw new ToolInputError(`${what} cannot be set by an agent.`);
  }
}

/**
 * Sets `values` on `element` by field key, in the order given, since a part preset
 * changes the values after it. `name` sets its designator.
 */
function applyValues(element: CircuitElement, values: JsonValue | undefined) {
  if (values === undefined) {
    return;
  }

  for (const [key, value] of Object.entries(objectOf(values, "values"))) {
    const wanted = key === "name" ? "custom-name" : key;
    const fields = settableFields(element);
    const field = fields.find((candidate) => candidate.key === wanted);

    if (!field) {
      throw new ToolInputError(
        `${element.title()} has no value ${key}; it takes ${fields.map((candidate) => candidate.key).join(", ")}.`,
      );
    }

    setField(field, value);
  }
}

// Describing the circuit

/** A parsed copy of the open circuit, with every post's net name. */
function readCircuit(host: CircuitHost) {
  const circuit = Circuit.parse(host.text());
  const netlist = buildNetlist(circuit.elements, "dc");

  const netOf = (element: CircuitElement, post: number) =>
    netlist.nodes[element.nodes[post] ?? 0]?.name ?? "0";

  return { circuit, netOf };
}

type NetOf = (element: CircuitElement, post: number) => string;

/** Describes one element: its reference, kind, value and pins with their nets. */
function describeElement(
  element: CircuitElement,
  index: number,
  netOf: NetOf,
  withValues: boolean,
) {
  const names = pinNames(element);

  const described: ElementInfo = {
    ref: referenceOf(element, index),
    kind: element.kind,
    name: element.name(),
    pins: element.posts().map((post, pin) => ({
      pin: names[pin] ?? String(pin + 1),
      x: post.x,
      y: post.y,
      net: netOf(element, pin),
    })),
  };

  if (element.valueLabel()) {
    described.value = element.valueLabel();
  }

  if (withValues) {
    described.values = Object.fromEntries(
      settableFields(element).flatMap((field) =>
        field.kind === "spice" || field.key === "custom-name"
          ? []
          : [[field.key, fieldValue(field)]],
      ),
    );
  }

  return described;
}

/** True for the elements that only join nets: wires, net labels and grounds. */
function isConnector(element: CircuitElement) {
  return element.isNetElement() || element.kind === "ground";
}

/** Describes a wire, net label, ground or group by its points and net. */
function describeConnector(
  element: CircuitElement,
  index: number,
  netOf: NetOf,
) {
  const points =
    element.kind === "wire" || element.isEnclosure()
      ? [element.start, element.end]
      : element.posts();

  const described: ConnectorInfo = {
    ref: referenceOf(element, index),
    kind: element.kind,
    points,
    net: element.posts().length > 0 ? netOf(element, 0) : null,
  };

  if (element instanceof NetLabel) {
    described.text = element.text;
  }

  return described;
}

/**
 * The circuit as an agent reads it: the parts, the nets with the pins on each, the wires
 * and labels, and pins left on a net of their own.
 */
function describeCircuit(host: CircuitHost, withValues: boolean) {
  const { circuit, netOf } = readCircuit(host);
  const nets = new Map<string, string[]>();
  const parts: ElementInfo[] = [];
  const connectors: ConnectorInfo[] = [];
  const labeled = new Set<string>();

  for (const [index, element] of circuit.elements.entries()) {
    if (element instanceof NetLabel) {
      labeled.add(element.text);
    }

    if (isConnector(element) || element.isEnclosure()) {
      connectors.push(describeConnector(element, index, netOf));
      continue;
    }

    parts.push(describeElement(element, index, netOf, withValues));

    for (const [pin, name] of pinNames(element).entries()) {
      const net = netOf(element, pin);

      nets.set(net, [
        ...(nets.get(net) ?? []),
        `${referenceOf(element, index)}:${name}`,
      ]);
    }
  }

  // A pin on ground joins the ground symbol, unless 0 V only fell back to a part's pin
  // for want of one.
  const hasGround = circuit.elements.some((element) =>
    element.referencesGround(),
  );

  const floatingPins = [...nets].flatMap(([net, pins]) =>
    pins.length === 1 && !(net === "0" && hasGround) && !labeled.has(net)
      ? pins
      : [],
  );

  const described: CircuitInfo = {
    title: host.title(),
    settings: circuit.settings,
    parts,
    nets: Object.fromEntries(nets),
    connectors,
    floatingPins,
  };

  if (circuit.skippedTypes.length > 0) {
    described.skippedTypes = circuit.skippedTypes;
  }

  return described;
}

/** Each pin's net after an edit, so the agent sees what it joined. */
function netsOfPins(host: CircuitHost, references: readonly string[]) {
  const { circuit, netOf } = readCircuit(host);

  return Object.fromEntries(
    references.map((reference) => {
      const { element, pin } = findPin(circuit.elements, reference);

      return [reference, netOf(element, pin)];
    }),
  );
}

// Editing

/**
 * Runs `change` on the open circuit after checking it still matches `expected`, the
 * copy the change was worked out on, element by element.
 */
function editMatching(
  host: CircuitHost,
  expected: Circuit,
  change: (circuit: Circuit) => void,
) {
  host.edit((circuit) => {
    const isSame =
      circuit.elements.length === expected.elements.length &&
      circuit.elements.every(
        (element, index) => element.kind === expected.elements[index]?.kind,
      );

    if (!isSame) {
      throw new ToolInputError(
        "The circuit changed while the tool ran. Call get_circuit and try again.",
      );
    }

    change(circuit);
  });
}

/** Turns `element` a quarter turn clockwise `turns` times about `pivot`, then mirrors it. */
function orient(
  element: CircuitElement,
  pivot: Point,
  turns: number,
  isMirrored: boolean,
) {
  for (let turn = 0; turn < turns; turn += 1) {
    element.transform(({ x, y }) => ({
      x: pivot.x - (y - pivot.y),
      y: pivot.y + (x - pivot.x),
    }));
  }

  if (isMirrored) {
    element.transform(({ x, y }) => ({ x: 2 * pivot.x - x, y }));
  }
}

/** The tools that place a part, as `list_parts` names them; wires are drawn by `connect`. */
const PART_TOOLS = TOOLS.filter(
  (tool) => tool.kind !== null && tool.kind !== "wire",
);

/** Creates the part the tool `id` places with its first point at `at`. */
function createPart(id: string, at: Point) {
  const tool = findTool(id);

  if (!tool?.kind || tool.kind === "wire") {
    throw new ToolInputError(
      `No part tool ${id}. Call list_parts for the tools; draw wires with connect.`,
    );
  }

  const element = createElement(
    tool.kind,
    at.x,
    at.y,
    at.x + tool.size.dx,
    at.y + tool.size.dy,
  );

  tool.configure?.(element);

  return element;
}

/** Creates one placed part from its spec in `place_parts`. */
function placedPart(value: JsonValue, index: number) {
  const spec = objectOf(value, `parts[${index}]`);

  const at = snapped({
    x: quantity(spec.x, `parts[${index}].x`),
    y: quantity(spec.y, `parts[${index}].y`),
  });

  const element = createPart(textOf(spec.tool, `parts[${index}].tool`), at);
  const turns = Math.round(optionalQuantity(spec.rotate, "rotate", 0) / 90);

  orient(element, at, ((turns % 4) + 4) % 4, spec.mirror === true);
  applyValues(element, spec.values);

  if (spec.name !== undefined) {
    element.customName = textOf(spec.name, `parts[${index}].name`);
  }

  return element;
}

/** Wires from `from` to `to`: straight when they line up, else across then down. */
function route(from: Point, to: Point) {
  const corner = { x: to.x, y: from.y };

  return [
    [from, corner],
    [corner, to],
  ].flatMap(([a, b]) =>
    !a || !b || (a.x === b.x && a.y === b.y)
      ? []
      : [createElement("wire", a.x, a.y, b.x, b.y)],
  );
}

/** A net label named `name` on `pin`, its text out to the side away from `center`. */
function labelAt(pin: Point, center: Point, name: string) {
  const dx = pin.x - center.x;
  const dy = pin.y - center.y;
  const reach = 2 * GRID_SIZE;

  const end =
    Math.abs(dx) >= Math.abs(dy)
      ? { x: pin.x + (dx < 0 ? -reach : reach), y: pin.y }
      : { x: pin.x, y: pin.y + (dy < 0 ? -reach : reach) };

  const label = createElement("label", pin.x, pin.y, end.x, end.y);

  if (label instanceof NetLabel) {
    label.text = name;
  }

  return label;
}

/** A net label on the pin `reference` names, pointing away from its part. */
function labelOnPin(
  elements: readonly CircuitElement[],
  reference: string,
  name: string,
) {
  const { element, post } = findPin(elements, reference);

  return labelAt(post, centerOf(element), name);
}

/** The wires and labels one net of `connect` adds, and the pins it names. */
function netElements(
  elements: readonly CircuitElement[],
  value: JsonValue,
  index: number,
  isLabel: boolean,
) {
  const net = objectOf(value, `nets[${index}]`);
  const pins = listOf(net.pins, `nets[${index}].pins`);
  const name = net.name === undefined ? null : textOf(net.name, "name");
  const named = pins.filter(isScalar).map(String);

  if (isLabel) {
    if (!name) {
      throw new ToolInputError(`nets[${index}] needs a name for labels.`);
    }

    return {
      named,
      added: named.map((pin) => labelOnPin(elements, pin, name)),
    };
  }

  const places = pins.map((pin) => placeOf(elements, pin));

  if (places.length < 2) {
    throw new ToolInputError(`nets[${index}] needs two pins or more.`);
  }

  const added = places.flatMap((to, hop) => {
    const from = places[hop - 1];

    return from ? route(from, to) : [];
  });

  const [first] = named;

  if (name && first) {
    added.push(labelOnPin(elements, first, name));
  }

  return { named, added };
}

// Analysis results

/** Every `stride`-th of `values` so at most `limit` remain, always with the last. */
function sampled<T>(values: readonly T[], limit: number) {
  const stride = Math.max(1, Math.ceil(values.length / limit));

  return values.filter(
    (_value, index) => index % stride === 0 || index === values.length - 1,
  );
}

/** True when `name`, such as `V(out)`, is one of `wanted`, with or without `V( )`. */
function isWanted(name: string, wanted: readonly string[]) {
  const bare = name.replace(/^[VI]\((.*)\)$/u, "$1").toLowerCase();

  return wanted.some(
    (candidate) =>
      candidate.toLowerCase() === name.toLowerCase() ||
      candidate.toLowerCase() === bare,
  );
}

/** Picks what to report: the names asked for, else featured ones, else all. */
function picked<T extends { name: string; isFeatured: boolean }>(
  items: readonly T[],
  wanted: readonly string[] | null,
) {
  if (wanted) {
    return items.filter(({ name }) => isWanted(name, wanted));
  }

  const featured = items.filter(({ isFeatured }) => isFeatured);

  return featured.length > 0 ? featured : items;
}

/** Rounds to five significant digits, which is all an agent needs to read. */
function rounded(value: number) {
  return Number(value.toPrecision(5));
}

/** Summarizes one transient trace: its range, mean, RMS and final value, and samples. */
function summarizeTrace(
  { name, unit, values }: { name: string; unit: string; values: number[] },
  times: readonly number[],
  indexes: readonly number[],
) {
  const count = Math.max(1, values.length);
  const mean = values.reduce((sum, value) => sum + value, 0) / count;

  const rms = Math.sqrt(
    values.reduce((sum, value) => sum + value * value, 0) / count,
  );

  return {
    name,
    unit,
    min: rounded(Math.min(...values)),
    max: rounded(Math.max(...values)),
    mean: rounded(mean),
    rms: rounded(rms),
    final: rounded(values[values.length - 1] ?? 0),
    points: indexes.map((index) => [
      rounded(times[index] ?? 0),
      rounded(values[index] ?? 0),
    ]),
  };
}

/** Shortens an analysis result for an agent: what it asked for, sampled. */
function summarize(
  result: AnalysisResult,
  wanted: readonly string[] | null,
  maxPoints: number,
) {
  switch (result.kind) {
    case "dc":
      return {
        kind: "dc",
        nets: result.nets.map(({ name, voltage }) => ({
          name,
          voltage: rounded(voltage),
        })),
        parts: result.elements.map(
          ({ designator, voltage, current, power }) => ({
            ref: designator,
            voltage: rounded(voltage),
            current: rounded(current),
            power: rounded(power),
          }),
        ),
      };
    case "ac": {
      const indexes = sampled([...result.frequencies.keys()], maxPoints);

      return {
        kind: "ac",
        nets: picked(result.nets, wanted).map(({ name, magnitude, phase }) => ({
          name,
          cornersHz: cornerFrequencies(result.frequencies, magnitude).map(
            rounded,
          ),
          peakDb: rounded(Math.max(...magnitude.map(toDecibels))),
          points: indexes.map((index) => ({
            hz: rounded(result.frequencies[index] ?? 0),
            db: rounded(toDecibels(magnitude[index] ?? 0)),
            deg: rounded(phase[index] ?? 0),
          })),
        })),
      };
    }
    case "transient": {
      const indexes = sampled([...result.times.keys()], maxPoints);

      return {
        kind: "transient",
        traces: picked(result.traces, wanted).map((trace) =>
          summarizeTrace(trace, result.times, indexes),
        ),
      };
    }
  }
}

/** The analysis `run_analysis` asks for, with defaults for what it leaves out. */
function analysisRequest(input: JsonObject, text: string): AnalysisRequest {
  const { kind } = input;

  if (kind === "ac") {
    const options: AcSweepOptions = {
      startFrequency: optionalQuantity(
        input.startFrequency,
        "startFrequency",
        1,
      ),
      stopFrequency: optionalQuantity(
        input.stopFrequency,
        "stopFrequency",
        1e6,
      ),
      scale:
        input.scale === "octave" || input.scale === "linear"
          ? input.scale
          : "decade",
      points: optionalQuantity(input.points, "points", 20),
    };

    return { kind, text, options };
  }

  if (kind === "transient") {
    const options: TransientOptions = {
      stopTime: optionalQuantity(input.stopTime, "stopTime", 0.01),
      startTime: optionalQuantity(input.startTime, "startTime", 0),
      maxTimeStep: optionalQuantity(input.maxTimeStep, "maxTimeStep", 1e-5),
      initialConditions: input.initialConditions === "zero" ? "zero" : "dc",
    };

    return { kind, text, options };
  }

  if (kind !== "dc") {
    throw new ToolInputError('kind must be "dc", "ac" or "transient".');
  }

  return { kind, text };
}

// The tools

const PIN_REFERENCE =
  "A pin is `<part>:<pin>`, such as `R1:2`, `Q1:B` or `U1:OUT`, or a point `[x, y]`.";

const COORDINATES =
  "Coordinates are schematic units: x grows right, y grows down, and the grid is 16. Pins at the same point join; a pin or wire end that lands on the middle of a wire joins it, but wires that only cross stay apart.";

const pinListSchema = {
  type: "array",
  minItems: 1,
  items: {
    anyOf: [
      { type: "string", description: "A pin, such as R1:2." },
      {
        type: "array",
        items: { type: "number" },
        minItems: 2,
        maxItems: 2,
        description: "A point [x, y] a wire runs through.",
      },
    ],
  },
};

const valueSchema = {
  type: ["number", "string"],
  description: "A number, or a value with an SI prefix such as 10m.",
};

const READS = { readOnlyHint: true, untrustedContentHint: false };

const EDITS = { readOnlyHint: false, untrustedContentHint: false };

export const AGENT_TOOLS: readonly AgentTool[] = [
  {
    name: "list_parts",
    title: "List parts",
    description: `Lists the parts Lunar Spice can place, by tool id, with each pin's offset from the placement point. Give \`tools\` for the values those take, with their keys and presets. ${COORDINATES}`,
    inputSchema: {
      type: "object",
      properties: {
        tools: {
          type: "array",
          items: { type: "string" },
          description: "Tool ids to describe in full.",
        },
      },
    },
    annotations: READS,
    run: (input) => {
      const wanted = namesOf(input.tools);

      return PART_TOOLS.filter(({ id }) => !wanted || wanted.includes(id)).map(
        (tool) => {
          const element = createPart(tool.id, { x: 0, y: 0 });
          const names = pinNames(element);

          const described: ToolInfo = {
            tool: tool.id,
            label: tool.label,
            group: tool.group,
            pins: element.posts().map((post, index) => ({
              pin: names[index] ?? String(index + 1),
              dx: post.x,
              dy: post.y,
            })),
          };

          if (wanted) {
            described.values = settableFields(element)
              .filter(({ key }) => key !== "custom-name")
              .map(describeField);
          }

          return described;
        },
      );
    },
  },
  {
    name: "get_circuit",
    title: "Read the circuit",
    description:
      "Reads the open circuit: each part with its reference (R1, Q2, or #n for unnamed elements), value and pins with the net each is on, the pins on every net, wires and labels, and pins alone on a net (`floatingPins`, usually a missed connection). Set `values` for every part's values, and `text` for the circuit file in Falstad's text format.",
    inputSchema: {
      type: "object",
      properties: {
        values: {
          type: "boolean",
          description: "Include every part's values.",
        },
        text: { type: "boolean", description: "Include the circuit file." },
      },
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    run: (input, host) => {
      const described = describeCircuit(host, input.values === true);

      if (input.text === true) {
        described.text = host.text();
      }

      return described;
    },
  },
  {
    name: "place_parts",
    title: "Place parts",
    description: `Places parts in the open circuit as one undo step and returns their references and pins. \`x\`, \`y\` is where a click would drop the part: its first pin for most parts, the body's top-left corner for ICs, couplers and the oscilloscope. \`rotate\` turns it clockwise by 90, 180 or 270; \`mirror\` flips it left to right. \`values\` sets values by key, such as { "resistance": "4.7k" } or { "preset": "2N3904" }; list_parts gives the keys. ${COORDINATES}`,
    inputSchema: {
      type: "object",
      properties: {
        parts: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              tool: {
                type: "string",
                description:
                  "A tool id from list_parts, such as resistor or npn.",
              },
              x: { type: "number" },
              y: { type: "number" },
              rotate: { type: "number", enum: [0, 90, 180, 270] },
              mirror: { type: "boolean" },
              name: {
                type: "string",
                description:
                  "A designator to use instead of the automatic one.",
              },
              values: { type: "object" },
            },
            required: ["tool", "x", "y"],
          },
        },
      },
      required: ["parts"],
    },
    annotations: EDITS,
    run: (input, host) => {
      const elements = listOf(input.parts, "parts").map(placedPart);

      host.edit((circuit) => circuit.elements.push(...elements));

      // The new parts are the last ones in the file.
      const { circuit, netOf } = readCircuit(host);
      const first = circuit.elements.length - elements.length;

      return circuit.elements
        .slice(first)
        .map((element, offset) =>
          describeElement(element, first + offset, netOf, false),
        );
    },
  },
  {
    name: "connect",
    title: "Connect pins",
    description: `Joins pins into nets as one undo step. Each net lists pins in the order a wire runs through them; points between them are corners it passes. With \`style\` "wire" (the default) each hop is a straight wire, or two with a corner when the ends do not line up (across, then down). With "label" each pin gets a net label called \`name\` instead, which joins them without wires. A named wire net also gets a label on its first pin. Returns each pin's net, so a wire that ran over another pin shows. ${PIN_REFERENCE} ${COORDINATES}`,
    inputSchema: {
      type: "object",
      properties: {
        nets: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              pins: pinListSchema,
              name: {
                type: "string",
                description: "The net's name, which results use, such as out.",
              },
            },
            required: ["pins"],
          },
        },
        style: { type: "string", enum: ["wire", "label"] },
      },
      required: ["nets"],
    },
    annotations: EDITS,
    run: (input, host) => {
      const { circuit } = readCircuit(host);

      const nets = listOf(input.nets, "nets").map((value, index) =>
        netElements(circuit.elements, value, index, input.style === "label"),
      );

      editMatching(host, circuit, (live) =>
        live.elements.push(...nets.flatMap(({ added }) => added)),
      );

      return {
        pinNets: netsOfPins(
          host,
          nets.flatMap(({ named }) => named),
        ),
      };
    },
  },
  {
    name: "update_parts",
    title: "Change part values",
    description:
      'Changes parts\' values as one undo step, by key, such as { "part": "R1", "values": { "resistance": "10k" } } or { "part": "Q1", "values": { "preset": "BC547B" } }; `name` renames a part. get_circuit with `values` gives each part\'s keys.',
    inputSchema: {
      type: "object",
      properties: {
        parts: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              part: { type: "string", description: "A reference, such as R1." },
              values: { type: "object" },
            },
            required: ["part", "values"],
          },
        },
      },
      required: ["parts"],
    },
    annotations: EDITS,
    run: (input, host) => {
      const { circuit, netOf } = readCircuit(host);

      // The parsed copy takes the values first, so a bad one changes nothing.
      const changes = listOf(input.parts, "parts").map((value, index) => {
        const spec = objectOf(value, `parts[${index}]`);

        const found = findElement(
          circuit.elements,
          textOf(spec.part, `parts[${index}].part`),
        );

        applyValues(found.element, spec.values);

        return found;
      });

      editMatching(host, circuit, (live) => {
        for (const { element, index } of changes) {
          const original = live.elements[index];

          if (original) {
            element.id = original.id;
            live.elements[index] = element;
          }
        }
      });

      return changes.map(({ element, index }) =>
        describeElement(element, index, netOf, true),
      );
    },
  },
  {
    name: "delete_parts",
    title: "Delete parts",
    description:
      "Deletes parts, wires or labels by reference (R1, or #n from get_circuit) as one undo step, with the wires they leave hanging, as the canvas does: a part's wires back to the nearest junction or other pin, and a wire's whole run up to one. Numbers after # shift once something is deleted, so read the circuit again before using them.",
    inputSchema: {
      type: "object",
      properties: {
        parts: { type: "array", minItems: 1, items: { type: "string" } },
      },
      required: ["parts"],
    },
    annotations: EDITS,
    run: (input, host) => {
      const { circuit } = readCircuit(host);

      const references = listOf(input.parts, "parts").map((value) =>
        textOf(value, "Each part"),
      );

      const indexes = new Set(
        references.map(
          (reference) => findElement(circuit.elements, reference).index,
        ),
      );

      editMatching(host, circuit, (live) => {
        live.elements = deleteWithWires(
          live.elements,
          new Set(
            live.elements.filter((_element, index) => indexes.has(index)),
          ),
        );
      });

      return { deleted: references };
    },
  },
  {
    name: "set_circuit",
    title: "Write the circuit file",
    description:
      'Replaces the open circuit with `text`, a circuit in Falstad\'s text format as get_circuit with `text` returns it, as one undo step; with `mode` "new" it opens as a new draft called `title` instead. Without a `$` settings line the simulation settings stay. Falstad exports open directly; types of lines Lunar Spice cannot read come back in `skippedTypes`.',
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        mode: { type: "string", enum: ["replace", "new"] },
        title: { type: "string" },
      },
      required: ["text"],
    },
    annotations: EDITS,
    run: (input, host) => {
      const source = isScalar(input.text) ? String(input.text) : "";
      const parsed = Circuit.parse(source);

      const hasSettings = source
        .split(/\r?\n/u)
        .some((line) => line.trimStart().startsWith("$"));

      if (input.mode === "new") {
        const title = isScalar(input.title) ? String(input.title).trim() : "";

        host.openDraft(title || "untitled", parsed.dump());
      } else {
        host.edit((circuit) => {
          circuit.elements = parsed.elements;

          if (hasSettings) {
            circuit.settings = { ...parsed.settings };
          }
        });
      }

      return {
        elements: parsed.elements.length,
        skippedTypes: parsed.skippedTypes,
      };
    },
  },
  {
    name: "run_analysis",
    title: "Run an analysis",
    description:
      'Runs an analysis of the open circuit and shows it in the results panel. "dc" is the operating point: every net\'s voltage and every part\'s voltage, current and power. "ac" sweeps the small-signal response that sine sources drive: gain in dB, phase and −3 dB corners per net. "transient" runs over time: min, max, mean, RMS and final value per trace, with samples. Values take SI prefixes, such as "10m" for 10 ms.',
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["dc", "ac", "transient"] },
        startFrequency: {
          ...valueSchema,
          description: "AC, in Hz; 1 by default.",
        },
        stopFrequency: {
          ...valueSchema,
          description: "AC, in Hz; 1 MHz by default.",
        },
        scale: { type: "string", enum: ["decade", "octave", "linear"] },
        points: {
          type: "number",
          description:
            "AC points per decade or octave, or in all when linear; 20 by default.",
        },
        stopTime: {
          ...valueSchema,
          description: "Transient, in s; 10 ms by default.",
        },
        startTime: {
          ...valueSchema,
          description: "Transient results start here; 0 by default.",
        },
        maxTimeStep: {
          ...valueSchema,
          description: "Transient, in s; 10 µs by default.",
        },
        initialConditions: {
          type: "string",
          enum: ["dc", "zero"],
          description:
            "Transient: start from the operating point (dc, the default) or from rest (zero).",
        },
        names: {
          type: "array",
          items: { type: "string" },
          description:
            "Nets or traces to report, such as out or I(R1). Defaults to labeled nets and meters, else all.",
        },
        maxPoints: {
          type: "number",
          description: "Most samples per net or trace; 40 by default.",
        },
      },
      required: ["kind"],
    },
    annotations: EDITS,
    run: async (input, host) => {
      const request = analysisRequest(input, host.text());
      const result = await host.analyze(request);

      const maxPoints = Math.max(
        2,
        Math.round(optionalQuantity(input.maxPoints, "maxPoints", 40)),
      );

      return summarize(result, namesOf(input.names), maxPoints);
    },
  },
  {
    name: "control_simulation",
    title: "Run or pause the simulation",
    description:
      'Runs, pauses or resets the interactive simulation, which animates the canvas in real time, or reads its state with "status".',
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["run", "pause", "reset", "status"] },
      },
      required: ["action"],
    },
    annotations: EDITS,
    run: (input, host) => {
      const { action } = input;

      if (
        action !== "run" &&
        action !== "pause" &&
        action !== "reset" &&
        action !== "status"
      ) {
        throw new ToolInputError(
          'action must be "run", "pause", "reset" or "status".',
        );
      }

      return host.simulate(action);
    },
  },
];

/**
 * Runs the tool called `name` with `input`. Throws `ToolInputError` when the call asks
 * for something the circuit or the tool cannot do.
 */
export async function runAgentTool(
  name: string,
  input: JsonValue | undefined,
  host: CircuitHost,
) {
  const tool = AGENT_TOOLS.find((candidate) => candidate.name === name);

  if (!tool) {
    throw new ToolInputError(
      `No tool ${name}; the tools are ${AGENT_TOOLS.map((candidate) => candidate.name).join(", ")}.`,
    );
  }

  return tool.run(
    input === undefined ? {} : objectOf(input, "The input"),
    host,
  );
}
