import { LuMatrix } from "./matrix";

/**
 * How elements stamp: `transient` steps through time with companion models for
 * capacitors and inductors, `dc` solves the operating point with capacitors open and
 * inductors shorted. AC sweeps linearize around a `dc` solution.
 */
export type AnalysisMode = "transient" | "dc";

/**
 * The modified nodal analysis system for one netlist. Unknowns are numbered as Falstad
 * does: node 0 is ground and is never a row, nodes 1..n-1 are node voltages, and
 * `nodeCount + branch` is the current through voltage source `branch`. Stamps made while
 * building land in the constant base; stamps made during a step land in the working copy.
 */
export class MnaSystem {
  readonly nodeCount: number;
  readonly branchCount: number;
  readonly size: number;
  readonly mode: AnalysisMode;
  readonly base: Float64Array;
  readonly baseRhs: Float64Array;
  readonly matrix: Float64Array;
  readonly rhs: Float64Array;
  /** Node voltages and branch currents from the latest solve, indexed by unknown. */
  readonly solution: Float64Array;
  readonly lu: LuMatrix;
  /** Scratch space for one solve, reused so steps allocate nothing. */
  private readonly work: Float64Array;
  /** Cleared by any nonlinear element whose operating point is still moving. */
  converged = true;
  /** Newton iteration within the current step, from 0. */
  iteration = 0;
  time = 0;
  timeStep: number;
  /** Scales every independent source; DC solves ramp it to find hard operating points. */
  sourceScale = 1;
  private isStampingBase = true;

  constructor(
    nodeCount: number,
    branchCount: number,
    mode: AnalysisMode,
    timeStep: number,
  ) {
    this.nodeCount = nodeCount;
    this.branchCount = branchCount;
    this.size = Math.max(0, nodeCount - 1) + branchCount;
    this.mode = mode;
    this.timeStep = timeStep;
    this.base = new Float64Array(this.size * this.size);
    this.baseRhs = new Float64Array(this.size);
    this.matrix = new Float64Array(this.size * this.size);
    this.rhs = new Float64Array(this.size);
    this.solution = new Float64Array(this.size + 1);
    this.lu = new LuMatrix(this.size);
    this.work = new Float64Array(this.size);
  }

  /**
   * Sends later stamps into the working copy, which starts from the base. Linear circuits
   * stamp only right-hand sides during steps, so `isMatrixStamped` false skips copying
   * the matrix they never change.
   */
  beginStep(isMatrixStamped = true) {
    this.isStampingBase = false;

    if (isMatrixStamped) {
      this.matrix.set(this.base);
    }

    this.rhs.set(this.baseRhs);
  }

  /** Sends later stamps into the constant base, which starts empty. */
  beginBase() {
    this.isStampingBase = true;
    this.base.fill(0);
    this.baseRhs.fill(0);
  }

  /** Returns the unknown that holds the current through voltage source `branch`. */
  branchUnknown(branch: number) {
    return this.nodeCount + branch;
  }

  /** Returns the latest value of an unknown; ground reads 0. */
  value(unknown: number) {
    return unknown <= 0 ? 0 : (this.solution[unknown] ?? 0);
  }

  /** Adds `value` to one matrix entry; rows and columns of ground are dropped. */
  stampMatrix(row: number, column: number, value: number) {
    if (row <= 0 || column <= 0 || value === 0) {
      return;
    }

    const index = (row - 1) * this.size + (column - 1);
    const target = this.isStampingBase ? this.base : this.matrix;

    target[index] = (target[index] ?? 0) + value;
  }

  /** Adds `value` to one right-hand side row; the ground row is dropped. */
  stampRightSide(row: number, value: number) {
    if (row <= 0 || value === 0) {
      return;
    }

    const target = this.isStampingBase ? this.baseRhs : this.rhs;

    target[row - 1] = (target[row - 1] ?? 0) + value;
  }

  stampConductance(a: number, b: number, conductance: number) {
    this.stampMatrix(a, a, conductance);
    this.stampMatrix(b, b, conductance);
    this.stampMatrix(a, b, -conductance);
    this.stampMatrix(b, a, -conductance);
  }

  stampResistor(a: number, b: number, resistance: number) {
    this.stampConductance(a, b, 1 / resistance);
  }

  /** Stamps a current source that pushes `current` from node `a` through itself into `b`. */
  stampCurrentSource(a: number, b: number, current: number) {
    this.stampRightSide(a, -current);
    this.stampRightSide(b, current);
  }

  /**
   * Stamps a voltage source that holds node `b` at `value` above node `a`. Its branch
   * current flows from `a` through the source into `b`. Time-varying sources stamp
   * their value each step with `stampVoltageValue`.
   */
  stampVoltageSource(a: number, b: number, branch: number, value = 0) {
    const row = this.branchUnknown(branch);

    this.stampMatrix(row, a, -1);
    this.stampMatrix(row, b, 1);
    this.stampMatrix(a, row, 1);
    this.stampMatrix(b, row, -1);
    this.stampRightSide(row, value);
  }

  /** Adds a voltage source's value for this step to its branch row. */
  stampVoltageValue(branch: number, value: number) {
    this.stampRightSide(this.branchUnknown(branch), value);
  }

  /**
   * Solves the working matrix, factoring it first when `shouldFactor` is true. Returns
   * false when the circuit has no solution or the result is not finite.
   */
  solve(shouldFactor: boolean) {
    if (shouldFactor && !this.lu.factor(this.matrix)) {
      return false;
    }

    const result = this.work;

    result.set(this.rhs);
    this.lu.solve(result);

    for (let index = 0; index < this.size; index += 1) {
      const value = result[index] ?? 0;

      if (!Number.isFinite(value)) {
        return false;
      }

      this.solution[index + 1] = value;
    }

    return true;
  }
}

/**
 * The complex system for one AC sweep frequency. The real part starts from the
 * linearized operating point; elements add their reactances and AC sources.
 */
export class AcSystem {
  readonly nodeCount: number;
  readonly size: number;
  readonly real: Float64Array;
  readonly imag: Float64Array;
  readonly rhsReal: Float64Array;
  readonly rhsImag: Float64Array;

  constructor(nodeCount: number, size: number, operatingMatrix: Float64Array) {
    this.nodeCount = nodeCount;
    this.size = size;
    this.real = new Float64Array(operatingMatrix);
    this.imag = new Float64Array(size * size);
    this.rhsReal = new Float64Array(size);
    this.rhsImag = new Float64Array(size);
  }

  branchUnknown(branch: number) {
    return this.nodeCount + branch;
  }

  /** Adds `value` to one imaginary matrix entry; rows and columns of ground are dropped. */
  stampImaginary(row: number, column: number, value: number) {
    if (row <= 0 || column <= 0) {
      return;
    }

    const index = (row - 1) * this.size + (column - 1);

    this.imag[index] = (this.imag[index] ?? 0) + value;
  }

  /** Stamps a susceptance between two nodes, such as a capacitor's ωC. */
  stampSusceptance(a: number, b: number, susceptance: number) {
    this.stampImaginary(a, a, susceptance);
    this.stampImaginary(b, b, susceptance);
    this.stampImaginary(a, b, -susceptance);
    this.stampImaginary(b, a, -susceptance);
  }

  /** Stamps the phasor of a current source that pushes from node `a` into `b`. */
  stampCurrentPhasor(a: number, b: number, real: number, imag: number) {
    for (const [node, sign] of [
      [a, -1],
      [b, 1],
    ] as const) {
      if (node > 0) {
        this.rhsReal[node - 1] = (this.rhsReal[node - 1] ?? 0) + sign * real;
        this.rhsImag[node - 1] = (this.rhsImag[node - 1] ?? 0) + sign * imag;
      }
    }
  }

  /** Adds a phasor to a voltage source's branch row. */
  stampSourcePhasor(branch: number, real: number, imag: number) {
    const row = this.branchUnknown(branch) - 1;

    this.rhsReal[row] = (this.rhsReal[row] ?? 0) + real;
    this.rhsImag[row] = (this.rhsImag[row] ?? 0) + imag;
  }
}
