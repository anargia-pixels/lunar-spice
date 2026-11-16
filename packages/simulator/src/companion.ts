import type { AcSystem, Handle, MnaSystem } from "./mna-system";

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
  /** Conductance this step adds to the companion resistor in the base; see `startStep`. */
  extraConductance = 0;
  private resistance = 0;
  private source = 0;
  /** The right-hand side rows of its two nodes, as `stamp` last found them. */
  private rowA: Handle = 0;
  private rowB: Handle = 0;

  constructor(capacitance: number) {
    this.capacitance = capacitance;
  }

  get isPresent() {
    return this.capacitance > 0;
  }

  /** Stamps the companion resistor, which stays the same for every step of one length. */
  stamp(system: MnaSystem, a: number, b: number) {
    if (system.mode !== "transient" || !this.isPresent) {
      return;
    }

    this.rowA = system.rightSideRow(a);
    this.rowB = system.rightSideRow(b);
    system.stampCapacitance(a, b, this.capacitance);
  }

  /**
   * Sets the history current source from the previous step's voltage and, for the
   * trapezoidal rule, its current. The resistance is worked out here, since a step that
   * is divided is solved by a system with a shorter time step. A `damped` step uses
   * backward Euler instead, which damps what the trapezoidal rule leaves ringing; the
   * element that owns the capacitor then stamps `extraConductance` beside the base's
   * trapezoidal companion resistor.
   */
  startStep(system: MnaSystem, damped = false) {
    if (system.mode !== "transient" || !this.isPresent) {
      return;
    }

    this.resistance = system.capacitorResistance(this.capacitance);
    this.extraConductance = 0;

    if (damped) {
      // Backward Euler's resistor is twice the trapezoidal one the base holds.
      this.extraConductance = -0.5 / this.resistance;
      this.resistance *= 2;
      this.source = -this.voltage / this.resistance;
    } else {
      this.source = -this.voltage / this.resistance - this.current;
    }
  }

  /** Stamps the history current source for this step, between the nodes `stamp` was given. */
  stampStep(system: MnaSystem) {
    if (system.mode === "transient" && this.capacitance > 0) {
      system.addRightSide(this.rowA, -this.source);
      system.addRightSide(this.rowB, this.source);
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
