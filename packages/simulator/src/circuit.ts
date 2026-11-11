import { type CircuitElement, type ElementKind, TokenReader } from "./element";
import { Microphone, Speaker } from "./elements/audio";
import {
  Ground,
  NetLabel,
  Probe,
  SpdtSwitch,
  Switch,
  Wire,
} from "./elements/connectors";
import {
  Timer555,
  AdjustableRegulator,
  FixedRegulator,
} from "./elements/integrated-circuits";
import { OpAmp } from "./elements/op-amp";
import { Capacitor, Inductor, Resistor } from "./elements/passive";
import {
  InvertingSchmittTrigger,
  SchmittTrigger,
} from "./elements/schmitt-trigger";
import { Bjt, Diode, Led, Mosfet } from "./elements/semiconductors";
import { CurrentSource, Rail, VoltageSource } from "./elements/sources";

/** Simulation settings saved in a circuit file's `$` line, as Falstad writes them. */
export type SimulationSettings = {
  /** Interactive time step, in seconds; `settingsForSpeed` sets it from the speed. */
  timeStep: number;
  /**
   * Falstad's iteration count: the interactive simulation runs 160 × this steps a second.
   * `speedMultiplier` turns it into circuit time per second.
   */
  speed: number;
  /** Falstad's current speed slider, 1 to 100; kept for Falstad, the dots scale themselves. */
  currentSpeed: number;
  /** Voltage drawn at full color. */
  voltageRange: number;
};

/** Interactive steps a second for each unit of Falstad's iteration count. */
const STEPS_PER_SPEED_UNIT = 160;

/** Returns the circuit time the interactive simulation covers per second; 1 is real time. */
export function speedMultiplier(settings: SimulationSettings) {
  return STEPS_PER_SPEED_UNIT * settings.speed * settings.timeStep;
}

/** Returns the iteration count that runs `multiplier` × real time at `timeStep`. */
export function speedForMultiplier(multiplier: number, timeStep: number) {
  return multiplier / (STEPS_PER_SPEED_UNIT * timeStep);
}

/**
 * Interactive steps a second at every speed. The time step follows the speed, so a slower
 * speed simulates in finer detail, and the step count stays one a heavy circuit (several
 * op-amps or transistors) keeps up with; it also samples sound at 40 kHz in real time.
 */
const INTERACTIVE_STEPS_PER_SECOND = 40_000;

/** The Falstad iteration count that runs those steps; the time step carries the speed. */
const INTERACTIVE_SPEED = INTERACTIVE_STEPS_PER_SECOND / STEPS_PER_SPEED_UNIT;

/**
 * Returns the time step and Falstad iteration count that run `multiplier` × real time.
 * The step is rounded to 12 significant digits, so saving a file and opening it again
 * keeps its settings line unchanged.
 */
export function settingsForSpeed(multiplier: number) {
  return {
    timeStep: Number(
      (multiplier / INTERACTIVE_STEPS_PER_SECOND).toPrecision(12),
    ),
    speed: INTERACTIVE_SPEED,
  };
}

/** New circuits run in real time. */
const DEFAULT_SETTINGS: SimulationSettings = {
  ...settingsForSpeed(1),
  currentSpeed: 50,
  voltageRange: 5,
};

/** What the registry needs of an element class: a constructor and a file reader. */
type ElementClass = {
  new (
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    flags?: number,
  ): CircuitElement;
  read(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    flags: number,
    reader: TokenReader,
  ): CircuitElement;
};

/** Every element class by kind; adding a component means adding it here. */
const ELEMENT_CLASSES: Record<ElementKind, ElementClass> = {
  wire: Wire,
  ground: Ground,
  label: NetLabel,
  probe: Probe,
  resistor: Resistor,
  capacitor: Capacitor,
  inductor: Inductor,
  "voltage-source": VoltageSource,
  rail: Rail,
  "current-source": CurrentSource,
  switch: Switch,
  "spdt-switch": SpdtSwitch,
  diode: Diode,
  led: Led,
  bjt: Bjt,
  mosfet: Mosfet,
  "op-amp": OpAmp,
  "schmitt-trigger": SchmittTrigger,
  regulator: FixedRegulator,
  "adjustable-regulator": AdjustableRegulator,
  timer: Timer555,
  microphone: Microphone,
  speaker: Speaker,
};

/**
 * Element classes by the type token that starts their line, from a default of each.
 * Falstad gives the inverting Schmitt trigger its own type, so it has a class too.
 */
const CLASSES_BY_DUMP_TYPE = new Map(
  [...Object.values(ELEMENT_CLASSES), InvertingSchmittTrigger].map((type) => [
    new type(0, 0, 0, 0).dumpType,
    type,
  ]),
);

/** Creates an element of `kind` with default values, spanning the two points. */
export function createElement(
  kind: ElementKind,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
) {
  return new ELEMENT_CLASSES[kind](x1, y1, x2, y2);
}

/** Reads one element line; null for blank, settings and unsupported lines. */
export function readElementLine(line: string) {
  const tokens = line.trim().split(/\s+/u);
  const type = tokens[0];

  const elementClass =
    type === undefined ? undefined : CLASSES_BY_DUMP_TYPE.get(type);

  if (!elementClass || tokens.length < 6) {
    return null;
  }

  const [x1, y1, x2, y2, flags] = tokens.slice(1, 6).map(Number);

  if (
    x1 === undefined ||
    y1 === undefined ||
    x2 === undefined ||
    y2 === undefined ||
    flags === undefined ||
    ![x1, y1, x2, y2, flags].every(Number.isFinite)
  ) {
    return null;
  }

  return elementClass.read(
    x1,
    y1,
    x2,
    y2,
    flags,
    new TokenReader(tokens.slice(6)),
  );
}

/** Copies `element` through its file line; the copy gets a new id. Throws when it fails. */
export function cloneElement(element: CircuitElement) {
  const copy = readElementLine(element.dump());

  if (!copy) {
    throw new Error(`${element.title()} cannot be copied.`);
  }

  return copy;
}

/**
 * Returns the `$` line that starts a circuit file, as Falstad writes it. The 50 and 5e-11
 * after the voltage range are Falstad settings Lunar Spice does not use.
 */
export function settingsLine(settings: Partial<SimulationSettings> = {}) {
  const { timeStep, speed, currentSpeed, voltageRange } = {
    ...DEFAULT_SETTINGS,
    ...settings,
  };

  return `$ 1 ${timeStep} ${speed} ${currentSpeed} ${voltageRange} 50 5e-11`;
}

/** Reads the settings from a `$` line's tokens, with defaults for any it lacks. */
function settingsFromLine(tokens: readonly string[]): SimulationSettings {
  const reader = new TokenReader(tokens.slice(1));

  // Skip the first value, Falstad's option flags.
  reader.number(1);

  const settings = {
    timeStep: reader.number(DEFAULT_SETTINGS.timeStep),
    speed: reader.number(DEFAULT_SETTINGS.speed),
    currentSpeed: reader.number(DEFAULT_SETTINGS.currentSpeed),
    voltageRange: reader.number(DEFAULT_SETTINGS.voltageRange),
  };

  // The file's speed sets how fast circuit time runs; the time step becomes the automatic
  // one, which keeps that speed and sizes the steps to it.
  return { ...settings, ...settingsForSpeed(speedMultiplier(settings)) };
}

/** Reads a circuit file's simulation settings from its `$` line alone. */
export function readSettings(text: string) {
  const line = text
    .split(/\r?\n/u)
    .find((candidate) => candidate.trimStart().startsWith("$"));

  return line
    ? settingsFromLine(line.trim().split(/\s+/u))
    : { ...DEFAULT_SETTINGS };
}

/** Gives every element with a designator prefix its number, such as R1, R2, C1. */
export function assignDesignators(elements: readonly CircuitElement[]) {
  const counts = new Map<string, number>();

  for (const element of elements) {
    if (!element.designatorPrefix) {
      continue;
    }

    const count = (counts.get(element.designatorPrefix) ?? 0) + 1;

    counts.set(element.designatorPrefix, count);
    element.designator = `${element.designatorPrefix}${count}`;
  }
}

/** A schematic: its elements in file order and its simulation settings. */
export class Circuit {
  elements: CircuitElement[];
  settings: SimulationSettings;
  /** Type tokens of lines that could not be read, such as Falstad components Lunar Spice lacks. */
  readonly skippedTypes: readonly string[];

  constructor(
    elements: CircuitElement[] = [],
    settings: SimulationSettings = DEFAULT_SETTINGS,
    skippedTypes: readonly string[] = [],
  ) {
    this.elements = elements;
    this.settings = { ...settings };
    this.skippedTypes = skippedTypes;
    assignDesignators(elements);
  }

  /** Reads a circuit in Falstad's text format; unknown lines are skipped and listed. */
  static parse(text: string) {
    const elements: CircuitElement[] = [];
    const settings = { ...DEFAULT_SETTINGS };
    const skipped = new Set<string>();

    for (const line of text.split(/\r?\n/u)) {
      const trimmed = line.trim();

      if (!trimmed) {
        continue;
      }

      const tokens = trimmed.split(/\s+/u);

      if (tokens[0] === "$") {
        Object.assign(settings, settingsFromLine(tokens));
        continue;
      }

      const element = readElementLine(trimmed);

      if (element) {
        elements.push(element);
      } else if (tokens[0]) {
        skipped.add(tokens[0]);
      }
    }

    return new Circuit(elements, settings, [...skipped]);
  }

  /** Returns the circuit in Falstad's text format. */
  dump() {
    return [
      settingsLine(this.settings),
      ...this.elements.map((element) => element.dump()),
    ].join("\n");
  }

  /** Clears every element's stored state, as when the simulation restarts. */
  reset() {
    for (const element of this.elements) {
      element.reset();
    }
  }
}
