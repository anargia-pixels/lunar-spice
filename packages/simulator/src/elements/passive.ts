import { CompanionCapacitor } from "../companion";
import {
  CircuitElement,
  type EditField,
  EXTENDED_FORMAT_FLAG,
  type TokenReader,
} from "../element";
import type { AcSystem, AnalysisMode, MnaSystem } from "../mna-system";
import { formatSi } from "../units";

export class Resistor extends CircuitElement {
  readonly kind = "resistor";
  readonly dumpType = "r";
  override readonly designatorPrefix = "R";
  resistance = 1000;

  static override read(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    flags: number,
    reader: TokenReader,
  ) {
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
