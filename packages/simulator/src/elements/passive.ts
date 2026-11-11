import { CompanionCapacitor } from "../companion";
import {
  CircuitElement,
  type EditField,
  type ElementKind,
  escapeText,
  EXTENDED_FORMAT_FLAG,
  type TokenReader,
  unescapeText,
} from "../element";
import type { Point } from "../geometry";
import type { AcSystem, AnalysisMode, MnaSystem } from "../mna-system";
import { formatSi } from "../units";

/** A potentiometer's ends never reach 0 Ω, which would be an infinite conductance. */
const MIN_RESISTANCE = 1e-3;

/** Length of a potentiometer's track, centered on the element's two points. */
const TRACK_SIZE = 32;

/**
 * Marks an `r` line as a two-pin potentiometer. Falstad reads the effective resistance
 * first and ignores the rest, so a file with one still opens there.
 */
const VARIABLE_RESISTOR_FLAG = 1 << 15;

/** Keeps a wiper inside its track. */
function clampPosition(position: number) {
  return Math.min(1, Math.max(0, position));
}

/** A wiper position as the dialogs and labels show it. */
function positionLabel(position: number) {
  return `${Number((position * 100).toPrecision(3))}%`;
}

export class Resistor extends CircuitElement {
  readonly kind: ElementKind = "resistor";
  readonly dumpType = "r";
  override readonly designatorPrefix: string = "R";
  resistance = 1000;

  static override read(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    flags: number,
    reader: TokenReader,
  ) {
    if ((flags & VARIABLE_RESISTOR_FLAG) !== 0) {
      return VariableResistor.read(x1, y1, x2, y2, flags, reader);
    }

    const resistor = new Resistor(x1, y1, x2, y2, flags);

    resistor.resistance = reader.number(1000);

    return resistor;
  }

  name() {
    return "Resistor";
  }

  override valueLabel() {
    return formatSi(this.resistance, "Ω");
  }

  override stamp(system: MnaSystem) {
    system.stampResistor(this.node(0), this.node(1), this.resistance);
  }

  override finishStep() {
    this.current = this.voltageDifference() / this.resistance;
  }

  override info() {
    return [this.title(), `R = ${this.valueLabel()}`, ...this.readingLines()];
  }

  override editFields(): EditField[] {
    return [
      {
        kind: "number",
        key: "resistance",
        label: "Resistance",
        unit: "Ω",
        value: this.resistance,
        range: "positive",
        set: (value) => {
          this.resistance = value;
        },
      },
    ];
  }

  override dumpValues() {
    return [this.resistance];
  }
}

/**
 * A three-post potentiometer: a resistive track between its first and second posts, and a
 * wiper on the third. The wiper divides the track into two resistors by `position`, from
 * 0 (tied to the first post) to 1 (tied to the second). Its line is Falstad's type 174,
 * so Falstad opens it with the same resistance and position.
 */
export class Potentiometer extends CircuitElement {
  readonly kind = "potentiometer";
  readonly dumpType = "174";
  override readonly designatorPrefix = "RV";
  override readonly mirrorFlag = 1;
  maxResistance = 1000;
  /** Wiper position along the track, from 0 to 1. */
  position = 0.5;
  /** Falstad's label for the slider beside the circuit; kept for its editor. */
  sliderText = "Resistance";
  private currentStart = 0;
  private currentEnd = 0;
  private currentWiper = 0;

  static override read(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    flags: number,
    reader: TokenReader,
  ) {
    const potentiometer = new Potentiometer(x1, y1, x2, y2, flags);

    potentiometer.maxResistance = reader.number(1000);
    potentiometer.position = clampPosition(reader.number(0.5));

    // Falstad writes the slider's label after the position.
    potentiometer.sliderText = unescapeText(reader.string("Resistance"));

    return potentiometer;
  }

  name() {
    return "Potentiometer";
  }

  override valueLabel() {
    return `${formatSi(this.maxResistance, "Ω")} ${positionLabel(this.position)}`;
  }

  /** True when flag 1 puts the wiper on the other side of the track. */
  private get side() {
    return (this.flags & 1) === 0 ? 1 : -1;
  }

  /** The point on the track the wiper touches. */
  wiperContact(): Point {
    const length = Math.hypot(this.x2 - this.x1, this.y2 - this.y1) || 1;
    const inset = Math.min(TRACK_SIZE, length) / 2 / length;
    const along = inset + (1 - 2 * inset) * this.position;

    return {
      x: this.x1 + (this.x2 - this.x1) * along,
      y: this.y1 + (this.y2 - this.y1) * along,
    };
  }

  /** The track's ends, then the wiper 16 units to one side of its contact point. */
  override posts(): Point[] {
    const length = Math.hypot(this.x2 - this.x1, this.y2 - this.y1) || 1;
    const contact = this.wiperContact();
    const side = 16 * this.side;

    return [
      this.start,
      this.end,
      {
        x: contact.x + ((this.y2 - this.y1) / length) * side,
        y: contact.y + ((this.x1 - this.x2) / length) * side,
      },
    ];
  }

  /** Resistance from the first post to the wiper, never 0. */
  resistanceToWiper() {
    return Math.max(this.maxResistance * this.position, MIN_RESISTANCE);
  }

  /** Resistance from the wiper to the second post, never 0. */
  resistanceFromWiper() {
    return Math.max(this.maxResistance * (1 - this.position), MIN_RESISTANCE);
  }

  override stamp(system: MnaSystem) {
    system.stampResistor(this.node(0), this.node(2), this.resistanceToWiper());
    system.stampResistor(
      this.node(2),
      this.node(1),
      this.resistanceFromWiper(),
    );
  }

  override finishStep() {
    const start = this.volts[0] ?? 0;
    const end = this.volts[1] ?? 0;
    const wiper = this.volts[2] ?? 0;

    this.currentStart = (start - wiper) / this.resistanceToWiper();
    this.currentEnd = (wiper - end) / this.resistanceFromWiper();
    this.currentWiper = this.currentEnd - this.currentStart;
    this.current = this.currentWiper;
  }

  override currentIntoPost(post: number) {
    if (post === 0) {
      return this.currentStart;
    }

    return post === 1 ? -this.currentEnd : this.currentWiper;
  }

  override currentPaths() {
    return [this.currentStart, this.currentEnd, this.currentWiper];
  }

  override reset() {
    super.reset();
    this.currentStart = 0;
    this.currentEnd = 0;
    this.currentWiper = 0;
  }

  override info() {
    return [
      this.title(),
      `R = ${this.valueLabel()}`,
      `R1 = ${formatSi(this.resistanceToWiper(), "Ω")}`,
      `R2 = ${formatSi(this.resistanceFromWiper(), "Ω")}`,
      `Vw = ${formatSi(this.volts[2] ?? 0, "V")}`,
    ];
  }

  override editFields(): EditField[] {
    return [
      {
        kind: "number",
        key: "maxResistance",
        label: "Total resistance",
        unit: "Ω",
        value: this.maxResistance,
        range: "positive",
        hint: "Resistance across the whole track.",
        set: (value) => {
          this.maxResistance = value;
        },
      },
      {
        kind: "number",
        key: "position",
        label: "Wiper position",
        unit: "%",
        value: this.position * 100,
        range: "nonnegative",
        hint: "0% ties the wiper to the first post, 100% to the second.",
        set: (value) => {
          this.position = clampPosition(value / 100);
        },
      },
    ];
  }

  override dumpValues() {
    // Falstad's fields: the total resistance, the position, then the slider label.
    return [this.maxResistance, this.position, escapeText(this.sliderText)];
  }
}

/**
 * A two-post potentiometer, a rheostat: the resistance from its maximum at 100% down to
 * nearly 0 Ω at 0%. Its line uses Falstad's resistor type with the effective resistance
 * first, so Falstad opens it as that fixed resistance, and the extended values keep the
 * dial in Lunar Spice.
 */
export class VariableResistor extends Resistor {
  readonly kind = "variable-resistor";
  override readonly designatorPrefix = "RV";
  protected override readonly usesExtendedFormat = true;
  maxResistance = 1000;
  /** Wiper position along the track, from 0 to 1. */
  position = 0.5;

  constructor(x1: number, y1: number, x2: number, y2: number, flags = 0) {
    super(x1, y1, x2, y2, flags | VARIABLE_RESISTOR_FLAG);
    this.updateResistance();
  }

  static override read(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    flags: number,
    reader: TokenReader,
  ) {
    const variableResistor = new VariableResistor(x1, y1, x2, y2, flags);
    const resistance = reader.number(1000);

    variableResistor.maxResistance = reader.number(resistance);
    variableResistor.position = clampPosition(reader.number(1));
    variableResistor.updateResistance();

    return variableResistor;
  }

  name() {
    return "Variable resistor";
  }

  private updateResistance() {
    this.resistance = Math.max(
      this.maxResistance * this.position,
      MIN_RESISTANCE,
    );
  }

  override info() {
    return [
      this.title(),
      `R = ${formatSi(this.resistance, "Ω")} (${positionLabel(this.position)} of ${formatSi(this.maxResistance, "Ω")})`,
      ...this.readingLines(),
    ];
  }

  override editFields(): EditField[] {
    return [
      {
        kind: "number",
        key: "maxResistance",
        label: "Maximum resistance",
        unit: "Ω",
        value: this.maxResistance,
        range: "positive",
        hint: "Resistance with the dial at 100%.",
        set: (value) => {
          this.maxResistance = value;
          this.updateResistance();
        },
      },
      {
        kind: "number",
        key: "position",
        label: "Dial position",
        unit: "%",
        value: this.position * 100,
        range: "nonnegative",
        hint: "0% shorts the resistor; 100% gives the maximum resistance.",
        set: (value) => {
          this.position = clampPosition(value / 100);
          this.updateResistance();
        },
      },
    ];
  }

  override dumpValues() {
    // Falstad reads the effective resistance and ignores the two extended values.
    return [this.resistance, this.maxResistance, this.position];
  }
}

/** A capacitor with optional equivalent series resistance (ESR) on its first post. */
export class Capacitor extends CircuitElement {
  readonly kind = "capacitor";
  readonly dumpType = "c";
  override readonly designatorPrefix = "C";
  protected override readonly usesExtendedFormat = true;
  esr = 0;
  readonly plates = new CompanionCapacitor(1e-5);

  static override read(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    flags: number,
    reader: TokenReader,
  ) {
    const capacitor = new Capacitor(x1, y1, x2, y2, flags);

    capacitor.plates.capacitance = reader.number(1e-5);
    capacitor.plates.voltage = reader.number(0);

    if ((flags & EXTENDED_FORMAT_FLAG) !== 0) {
      capacitor.esr = reader.number(0);
    }

    return capacitor;
  }

  name() {
    return "Capacitor";
  }

  override valueLabel() {
    return formatSi(this.plates.capacitance, "F");
  }

  override internalNodeCount() {
    return this.esr > 0 ? 1 : 0;
  }

  /** Returns the node the plates start at: past the ESR when there is one. */
  private platesNode() {
    return this.esr > 0 ? this.node(2) : this.node(0);
  }

  override stamp(system: MnaSystem) {
    if (this.esr > 0) {
      system.stampResistor(this.node(0), this.node(2), this.esr);
    }

    this.plates.stamp(system, this.platesNode(), this.node(1));
  }

  override startStep(system: MnaSystem) {
    this.plates.startStep(system);
  }

  override stampStep(system: MnaSystem) {
    this.plates.stampStep(system, this.platesNode(), this.node(1));
  }

  override finishStep(system: MnaSystem) {
    const platesVoltage =
      (this.volts[this.esr > 0 ? 2 : 0] ?? 0) - (this.volts[1] ?? 0);

    this.plates.finish(system, platesVoltage);
    this.current = this.plates.current;
  }

  override stampAc(system: AcSystem, omega: number) {
    this.plates.stampAc(system, this.platesNode(), this.node(1), omega);
  }

  override reset() {
    super.reset();
    this.plates.reset();
  }

  override info() {
    return [
      this.title(),
      `C = ${this.valueLabel()}`,
      `I = ${formatSi(this.current, "A")}`,
      `Vc = ${formatSi(this.plates.voltage, "V")}`,
    ];
  }

  override editFields(): EditField[] {
    return [
      {
        kind: "number",
        key: "capacitance",
        label: "Capacitance",
        unit: "F",
        value: this.plates.capacitance,
        range: "positive",
        set: (value) => {
          this.plates.capacitance = value;
        },
      },
      {
        kind: "number",
        key: "esr",
        label: "ESR",
        unit: "Ω",
        value: this.esr,
        range: "nonnegative",
        hint: "Equivalent series resistance from the datasheet; 0 for an ideal capacitor.",
        set: (value) => {
          this.esr = value;
        },
      },
      {
        kind: "number",
        key: "voltage",
        label: "Initial voltage",
        unit: "V",
        value: this.plates.voltage,
        range: "any",
        set: (value) => {
          this.plates.voltage = value;
        },
      },
    ];
  }

  override dumpValues() {
    return [this.plates.capacitance, this.plates.voltage, this.esr];
  }
}

/**
 * An inductor with optional winding resistance (DCR) on its first post. Transient steps
 * use the trapezoidal companion model; DC solves short it with a zero-volt source whose
 * branch current is the inductor current.
 */
export class Inductor extends CircuitElement {
  readonly kind = "inductor";
  readonly dumpType = "l";
  override readonly designatorPrefix = "L";
  protected override readonly usesExtendedFormat = true;
  inductance = 1;
  dcr = 0;
  private companionResistance = 0;
  private companionCurrent = 0;

  static override read(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    flags: number,
    reader: TokenReader,
  ) {
    const inductor = new Inductor(x1, y1, x2, y2, flags);

    inductor.inductance = reader.number(1);
    inductor.current = reader.number(0);

    if ((flags & EXTENDED_FORMAT_FLAG) !== 0) {
      inductor.dcr = reader.number(0);
    }

    return inductor;
  }

  name() {
    return "Inductor";
  }

  override valueLabel() {
    return formatSi(this.inductance, "H");
  }

  override internalNodeCount() {
    return this.dcr > 0 ? 1 : 0;
  }

  /** Returns the node the winding starts at: past the DCR when there is one. */
  private windingNode() {
    return this.dcr > 0 ? this.node(2) : this.node(0);
  }

  /** Returns the voltage across the winding alone, without the DCR. */
  private windingVoltage() {
    return (this.volts[this.dcr > 0 ? 2 : 0] ?? 0) - (this.volts[1] ?? 0);
  }

  override branchCount(mode: AnalysisMode) {
    return mode === "dc" ? 1 : 0;
  }

  override stamp(system: MnaSystem) {
    const a = this.windingNode();
    const b = this.node(1);

    if (this.dcr > 0) {
      system.stampResistor(this.node(0), this.node(2), this.dcr);
    }

    if (system.mode === "dc") {
      system.stampVoltageSource(a, b, this.firstBranch);

      return;
    }

    this.companionResistance = (2 * this.inductance) / system.timeStep;
    system.stampResistor(a, b, this.companionResistance);
  }

  override startStep(system: MnaSystem) {
    if (system.mode === "transient") {
      this.companionCurrent =
        this.windingVoltage() / this.companionResistance + this.current;
    }
  }

  override stampStep(system: MnaSystem) {
    if (system.mode === "transient") {
      system.stampCurrentSource(
        this.windingNode(),
        this.node(1),
        this.companionCurrent,
      );
    }
  }

  override finishStep(system: MnaSystem) {
    if (system.mode === "transient") {
      this.current =
        this.windingVoltage() / this.companionResistance +
        this.companionCurrent;
    }
  }

  /** Adds jωL to the branch row of the DC short, which turns it into the inductor. */
  override stampAc(system: AcSystem, omega: number) {
    const row = system.branchUnknown(this.firstBranch);

    system.stampImaginary(row, row, omega * this.inductance);
  }

  override info() {
    return [this.title(), `L = ${this.valueLabel()}`, ...this.readingLines()];
  }

  override editFields(): EditField[] {
    return [
      {
        kind: "number",
        key: "inductance",
        label: "Inductance",
        unit: "H",
        value: this.inductance,
        range: "positive",
        set: (value) => {
          this.inductance = value;
        },
      },
      {
        kind: "number",
        key: "dcr",
        label: "DC resistance",
        unit: "Ω",
        value: this.dcr,
        range: "nonnegative",
        hint: "Winding resistance (DCR) from the datasheet; 0 for an ideal inductor.",
        set: (value) => {
          this.dcr = value;
        },
      },
      {
        kind: "number",
        key: "current",
        label: "Initial current",
        unit: "A",
        value: this.current,
        range: "any",
        set: (value) => {
          this.current = value;
        },
      },
    ];
  }

  override dumpValues() {
    return [this.inductance, this.current, this.dcr];
  }
}
