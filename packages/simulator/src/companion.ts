import type { AcSystem, MnaSystem } from "./mna-system";

/**
 * A linear capacitance between two nodes inside an element, such as a diode's junction
 * capacitance. Transient steps use the trapezoidal companion model: a resistor of dt/2C
 * beside a current source carrying the previous step's charge. DC solves leave it open.
 */
export class CompanionCapacitor {
  capacitance: number;
  /** Voltage across it, first node minus second, kept between steps. */
  voltage = 0;
  current = 0;
  private resistance = 0;
  private source = 0;

  constructor(capacitance: number) {
    this.capacitance = capacitance;
  }

  get isPresent() {
    return this.capacitance > 0;
  }

  /** Stamps the companion resistor, which stays the same for every step. */
  stamp(system: MnaSystem, a: number, b: number) {
    if (system.mode !== "transient" || !this.isPresent) {
      return;
    }

    this.resistance = system.timeStep / (2 * this.capacitance);
    system.stampResistor(a, b, this.resistance);
  }

  /** Sets the history current source from the previous step's voltage and current. */
  startStep(system: MnaSystem) {
    if (system.mode === "transient" && this.isPresent) {
      this.source = -this.voltage / this.resistance - this.current;
    }
  }

  /** Stamps the history current source for this step. */
  stampStep(system: MnaSystem, a: number, b: number) {
    if (system.mode === "transient" && this.isPresent) {
      system.stampCurrentSource(a, b, this.source);
    }
  }

  /** Takes the solved voltage across it and works out its current. */
  finish(system: MnaSystem, voltage: number) {
    this.voltage = voltage;
    this.current =
      system.mode === "transient" && this.isPresent
        ? voltage / this.resistance + this.source
        : 0;
  }

  /** Stamps the capacitor's susceptance ωC for one AC sweep frequency. */
  stampAc(system: AcSystem, a: number, b: number, omega: number) {
    if (this.isPresent) {
      system.stampSusceptance(a, b, omega * this.capacitance);
    }
  }

  reset() {
    this.voltage = 0;
    this.current = 0;
  }
}
