import type { Point } from "./geometry";
import type { AcSystem, AnalysisMode, MnaSystem } from "./mna-system";
import { formatSi } from "./units";

/** Every component a schematic can hold. */
export type ElementKind =
  | "wire"
  | "ground"
  | "label"
  | "voltmeter"
  | "voltage-probe"
  | "resistor"
  | "potentiometer"
  | "variable-resistor"
  | "capacitor"
  | "inductor"
  | "voltage-source"
  | "rail"
  | "current-source"
  | "switch"
  | "spdt-switch"
  | "diode"
  | "led"
  | "bjt"
  | "mosfet"
  | "jfet"
  | "op-amp"
  | "schmitt-trigger"
  | "regulator"
  | "adjustable-regulator"
  | "timer"
  | "microphone"
  | "speaker";

/** Which numbers a value accepts: above 0, 0 and above (0 turns it off), or any. */
export type ValueRange = "positive" | "nonnegative" | "any";

/** Returns why `value` is out of `range`, as the edit dialog shows it; null when it fits. */
export function rangeError(value: number, range: ValueRange) {
  if (range === "positive" && !(value > 0)) {
    return "Must be above 0.";
  }

  if (range === "nonnegative" && !(value >= 0)) {
    return "Must be 0 or more.";
  }

  return null;
}

type FieldBase = {
  key: string;
  label: string;
  /** A short note under the field, such as what 0 means. */
  hint?: string;
};

/**
 * One editable property in the element dialog. `set` writes the parsed value back to the
 * element, so the dialog never needs to know which element it edits. The dialog edits a
 * copy and asks it for fields again after every change, since presets and pasted SPICE
 * models change many values at once.
 */
export type EditField =
  | (FieldBase & {
      kind: "number";
      unit: string;
      value: number;
      range: ValueRange;
      set: (value: number) => void;
    })
  | (FieldBase & {
      kind: "choice";
      value: string;
      options: readonly { value: string; label: string }[];
      set: (value: string) => void;
    })
  | (FieldBase & {
      kind: "boolean";
      value: boolean;
      set: (value: boolean) => void;
    })
  | (FieldBase & {
      kind: "text";
      value: string;
      set: (value: string) => void;
    })
  | (FieldBase & {
      /** A part whose datasheet values fill the other fields, such as 1N4148. */
      kind: "preset";
      value: string;
      options: readonly string[];
      set: (value: string) => void;
    })
  | (FieldBase & {
      /** A pasted SPICE `.model` card; `set` returns why it could not be used, or null. */
      kind: "spice";
      set: (text: string) => string | null;
    });

/**
 * Set on elements written by Lunar Spice whose lines carry more values than Falstad's, such
 * as a capacitor's ESR. Lines without it are read the way Falstad writes them.
 */
export const EXTENDED_FORMAT_FLAG = 1 << 16;

/**
 * Starts the tokens at the end of a line that place and name a part's label:
 * `@label dx dy name`, the name left out when it is the automatic one. Only lines whose
 * label was moved or renamed carry it, behind `EXTENDED_FORMAT_FLAG`.
 */
export const LABEL_MARKER = "@label";

/** Reads the space-separated values after an element's position in a circuit file. */
export class TokenReader {
  private readonly tokens: readonly string[];
  private index = 0;

  constructor(tokens: readonly string[]) {
    this.tokens = tokens;
  }

  /** Reads the next value as a number; `fallback` when it is missing or not a number. */
  number(fallback: number) {
    const token = this.tokens[this.index];

    this.index += 1;

    if (token === undefined) {
      return fallback;
    }

    const value = token === "true" ? 1 : token === "false" ? 0 : Number(token);

    return Number.isFinite(value) ? value : fallback;
  }

  /** Reads the next value as text; `fallback` when it is missing. */
  string(fallback: string) {
    const token = this.tokens[this.index];

    this.index += 1;

    return token ?? fallback;
  }
}

/** Escapes text for a circuit file the way Falstad does: spaces become `\s`. */
export function escapeText(text: string) {
  return text.replaceAll("\\", "\\\\").replaceAll(" ", "\\s");
}

/** Undoes `escapeText`: `\s` becomes a space again. */
export function unescapeText(text: string) {
  return text.replace(/\\(.)/gu, (_match, character: string) =>
    character === "s" ? " " : character,
  );
}

let nextElementId = 1;

/**
 * A component on the schematic. It spans from (x1, y1) to (x2, y2); its posts are the
 * points other components connect to. The netlist assigns `nodes`: one per post, then
 * the element's internal nodes, such as the point between a capacitor and its ESR. State
 * that survives a rebuild, such as a capacitor's voltage, lives on the element.
 */
export abstract class CircuitElement {
  abstract readonly kind: ElementKind;
  /** The type token that starts this element's line in a circuit file. */
  abstract readonly dumpType: string;
  /** Prefix of the reference designator, such as `R` for R1; empty for none. */
  readonly designatorPrefix: string = "";
  /** Unique within one run of the app; identifies the element across edits. */
  id = nextElementId++;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  flags: number;
  nodes: number[] = [];
  firstBranch = -1;
  /** Voltage at each node in `nodes` after the latest solve. */
  volts: number[] = [];
  /** Current into the first post, through the element and out of the second. */
  current = 0;
  /** Set by the circuit from the element's position in it, such as `R1`, or its custom name. */
  designator = "";
  /** A name typed for it, such as `Rload`, that replaces the numbered designator. */
  customName = "";
  /** How far its label sits from where the drawing puts it, in schematic units. */
  labelOffset: Point = { x: 0, y: 0 };
  /**
   * The flag bit that mirrors which side the element's extra posts sit on, for flips;
   * 0 for elements that have none.
   */
  readonly mirrorFlag: number = 0;
  /** True when its file line carries values Falstad does not write. */
  protected readonly usesExtendedFormat: boolean = false;

  constructor(x1: number, y1: number, x2: number, y2: number, flags = 0) {
    this.x1 = x1;
    this.y1 = y1;
    this.x2 = x2;
    this.y2 = y2;
    this.flags = flags;
  }

  /**
   * Reads an element from its file line: the position, the flags, then the values its
   * class writes in `dumpValues`. Elements without values only need their position.
   */
  static read<T extends CircuitElement>(
    this: new (
      x1: number,
      y1: number,
      x2: number,
      y2: number,
      flags: number,
    ) => T,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    flags: number,
    _reader: TokenReader,
  ): CircuitElement {
    return new this(x1, y1, x2, y2, flags);
  }

  get start(): Point {
    return { x: this.x1, y: this.y1 };
  }

  get end(): Point {
    return { x: this.x2, y: this.y2 };
  }

  /** Returns the posts, in node order. */
  posts(): Point[] {
    return [this.start, this.end];
  }

  /** Returns how many nodes the element has inside it, which no post connects to. */
  internalNodeCount() {
    return 0;
  }

  /** Returns the node of post `index`, or of internal node `index` after the posts. */
  node(index: number) {
    return this.nodes[index] ?? 0;
  }

  /** Returns how many voltage sources this element adds to the system in `mode`. */
  branchCount(_mode: AnalysisMode) {
    return 0;
  }

  /** True when its posts are the same node, like a wire or a closed switch. */
  isConductor() {
    return false;
  }

  /** Returns the two posts a conductor joins: its first two, unless it picks one. */
  conductorPosts(): readonly [number, number] {
    return [0, 1];
  }

  /** True for a wire or a net label: it sits on one net instead of between nets. */
  isNetElement() {
    return false;
  }

  /** True when its post is the 0 V reference node, like a ground symbol. */
  isGround() {
    return false;
  }

  /** True when it drives a node against ground, so the circuit needs no ground symbol. */
  referencesGround() {
    return this.isGround();
  }

  /** True for an independent source, which anchors 0 V when nothing else does. */
  isSource() {
    return false;
  }

  /** Returns the net name it gives its post's node, like a net label; null for most. */
  netName(): string | null {
    return null;
  }

  /**
   * The point where a probe reads the net beneath it, like a voltage probe's tip; null
   * for the rest. It is no post: wiring never joins, cuts or drags it, and it takes the
   * node of a post there or of a wire running through it.
   */
  probePoint(): Point | null {
    return null;
  }

  /**
   * True for a voltmeter or voltage probe, whose reading results list beside the nets:
   * a voltmeter's first post against its second, a probe's tip against ground.
   */
  isMeter() {
    return false;
  }

  /**
   * How far its drawing reaches beyond the box around its start, end and posts, for hit
   * tests and framing: an IC's box or an op-amp's triangle; 0 for a part drawn between
   * its leads, like a transistor.
   */
  bodyMargin() {
    return 12;
  }

  /** True when it stretches to wherever it is drawn, like a wire; parts keep their size. */
  isStretchable() {
    return false;
  }

  /** Sets the polarity, such as NPN or PNP, of parts that come both ways; others ignore it. */
  setPolarity(_polarity: number) {}

  /** True when a click flips it, like a toggle switch. */
  isToggle() {
    return false;
  }

  /** Flips a toggle; other elements ignore it. */
  toggle() {}

  /** True when it acts only while held down, like a push switch. */
  isPushButton() {
    return false;
  }

  /** Holds a push button down or lets it go; other elements ignore it. */
  press(_isDown: boolean) {}

  /** True when it drives AC sweeps, like a sine source. */
  drivesAc() {
    return false;
  }

  /** True when it needs Newton iterations. */
  isNonlinear() {
    return false;
  }

  /** Stamps the values that stay constant until the netlist or time step changes. */
  stamp(_system: MnaSystem) {}

  /** Runs once per time step before the Newton iterations, to update companion models. */
  startStep(_system: MnaSystem) {}

  /** Stamps one Newton iteration: time-varying sources and nonlinear models. */
  stampStep(_system: MnaSystem) {}

  /** Receives a voltage source's solved current; `index` counts from `firstBranch`. */
  setBranchCurrent(_index: number, current: number) {
    this.current = current;
  }

  /** Runs after a step converges, to compute currents and keep state. */
  finishStep(_system: MnaSystem) {}

  /** Stamps the small-signal model for one AC sweep frequency `omega`, in rad/s. */
  stampAc(_system: AcSystem, _omega: number) {}

  /** Clears state such as stored charge, as when the simulation resets. */
  reset() {
    this.current = 0;
    // In place: a simulation holds on to each element's `volts`.
    this.volts.fill(0);
  }

  /** Returns the current that flows from the node into the element at `post`. */
  currentIntoPost(post: number) {
    return post === 0 ? this.current : -this.current;
  }

  /** Returns the voltage across a two-post element, first post minus second. */
  voltageDifference() {
    return (this.volts[0] ?? 0) - (this.volts[1] ?? 0);
  }

  /** Returns the power it takes from the circuit over all posts; negative for sources. */
  power() {
    return this.posts().reduce(
      (total, _post, index) =>
        total + (this.volts[index] ?? 0) * this.currentIntoPost(index),
      0,
    );
  }

  /**
   * Returns the current along each path its symbol draws, for the moving dots: one path
   * for two-post elements, one lead per post for the rest.
   */
  currentPaths() {
    return this.posts().length > 2
      ? this.posts().map((_post, index) => this.currentIntoPost(index))
      : [this.current];
  }

  /** Returns current, voltage and power lines for a two-terminal readout. */
  protected readingLines() {
    return [
      `I = ${formatSi(this.current, "A")}`,
      `Vd = ${formatSi(this.voltageDifference(), "V")}`,
      `P = ${formatSi(this.power(), "W")}`,
    ];
  }

  /** Returns lines for the hover readout: the name first, then values and readings. */
  info(): string[] {
    return [this.title()];
  }

  /** Returns the element's name with its designator, such as `Resistor R1`. */
  title() {
    return this.designator ? `${this.name()} ${this.designator}` : this.name();
  }

  /** Returns the element's name, such as `Resistor`. */
  abstract name(): string;

  /** Returns the main value drawn beside the element, such as `1 kΩ`. */
  valueLabel() {
    return "";
  }

  /** Returns the fields the element dialog shows; empty when it has none. */
  editFields(): EditField[] {
    return [];
  }

  /** Returns the values after the flags on this element's line in a circuit file. */
  dumpValues(): (string | number)[] {
    return [];
  }

  /**
   * True when its line carries values Falstad does not write: always for elements that set
   * `usesExtendedFormat`, only for some settings on others.
   */
  protected hasExtendedValues() {
    return this.usesExtendedFormat;
  }

  /** True when its label was moved or renamed, so its line carries `LABEL_MARKER`. */
  private hasCustomLabel() {
    return (
      this.customName !== "" ||
      this.labelOffset.x !== 0 ||
      this.labelOffset.y !== 0
    );
  }

  /** The tokens after `LABEL_MARKER` in its line, or none. */
  private labelTokens(): (string | number)[] {
    if (!this.hasCustomLabel()) {
      return [];
    }

    return [
      LABEL_MARKER,
      this.labelOffset.x,
      this.labelOffset.y,
      ...(this.customName ? [escapeText(this.customName)] : []),
    ];
  }

  /** Reads the tokens that followed `LABEL_MARKER` in its line. */
  readLabel(tokens: readonly string[]) {
    const [x = "0", y = "0", name] = tokens;

    this.labelOffset = {
      x: Number.isFinite(Number(x)) ? Number(x) : 0,
      y: Number.isFinite(Number(y)) ? Number(y) : 0,
    };
    this.customName = name === undefined ? "" : unescapeText(name);
  }

  /**
   * The fields the edit dialog shows: a name for parts with a designator, then
   * `editFields`.
   */
  dialogFields(): EditField[] {
    if (!this.designatorPrefix) {
      return this.editFields();
    }

    const name: EditField = {
      kind: "text",
      key: "custom-name",
      label: "Name",
      value: this.customName,
      hint: "Shown on the schematic and in results. Leave it empty to number it automatically.",
      set: (value) => {
        this.customName = value.trim();
      },
    };

    return [name, ...this.editFields()];
  }

  /**
   * Returns the element's line in a circuit file. It sets `EXTENDED_FORMAT_FLAG` only
   * when the line carries values Falstad does not write.
   */
  dump() {
    return [
      this.dumpType,
      this.x1,
      this.y1,
      this.x2,
      this.y2,
      this.hasExtendedValues() || this.hasCustomLabel()
        ? this.flags | EXTENDED_FORMAT_FLAG
        : this.flags & ~EXTENDED_FORMAT_FLAG,
      ...this.dumpValues(),
      ...this.labelTokens(),
    ].join(" ");
  }

  /** Moves the element by a whole number of units. */
  translate(dx: number, dy: number) {
    this.x1 += dx;
    this.y1 += dy;
    this.x2 += dx;
    this.y2 += dy;
  }

  /**
   * Moves both points through `map`, a rotation or reflection. When its side posts land
   * on the wrong side, as when a transistor is reflected, it flips its mirror flag.
   */
  transform(map: (point: Point) => Point) {
    // The label's place depends on which way the part faces, so a turn or flip resets it.
    this.labelOffset = { x: 0, y: 0 };

    const expected = this.posts().map(map);
    const start = map(this.start);
    const end = map(this.end);

    this.x1 = start.x;
    this.y1 = start.y;
    this.x2 = end.x;
    this.y2 = end.y;

    const posts = this.posts();

    const isMirrored = expected.some(
      (point, index) =>
        point.x !== posts[index]?.x || point.y !== posts[index]?.y,
    );

    if (this.mirrorFlag !== 0 && isMirrored) {
      this.flags ^= this.mirrorFlag;
    }
  }
}
