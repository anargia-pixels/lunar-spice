import { LuMatrix, MatrixPattern, VARIABLE_ENTRY } from "./matrix";

/**
 * How elements stamp: `transient` steps through time with companion models for
 * capacitors and inductors, `dc` solves the operating point with capacitors open and
 * inductors shorted. AC sweeps linearize around a `dc` solution.
 */
export type AnalysisMode = "transient" | "dc";

/** SPICE's RELTOL for a nonlinear model's current: 0.1 %. */
const CURRENT_RELTOL = 1e-3;

/** SPICE's ABSTOL for a nonlinear model's current: 1 pA. */
const CURRENT_ABSTOL = 1e-12;

/**
 * True while a nonlinear model has not converged: the current its last linearization
 * predicts at the new solution misses the model's current there by more than SPICE's
 * tolerance. A device that only moved along its line, as a saturated or linear one does,
 * counts as converged however far it moved.
 */
export function mispredicts(current: number, predicted: number) {
  return (
    Math.abs(current - predicted) >
    CURRENT_RELTOL * Math.max(Math.abs(current), Math.abs(predicted)) +
      CURRENT_ABSTOL
  );
}

/**
 * A companion model's conductance in the base, which depends on the step's length: a
 * capacitance or an inductance between two nodes.
 */
type TimedConductance = {
  a: number;
  b: number;
  capacitance: number;
  inductance: number;
};

/** Where stamps land: the constant base, a step's right-hand side, or one iteration. */
const BASE = 0;

const STEP = 1;

const ITERATION = 2;

/**
 * A place in the matrix or the right-hand side that an element asked for once, in `stamp`,
 * so its `stampStep` adds there without working the place out again. Ground has one too,
 * which takes what is added and is never read.
 */
export type Handle = number;

/**
 * The modified nodal analysis system for one netlist. Unknowns are numbered as Falstad
 * does: node 0 is ground and is never a row, nodes 1..n-1 are node voltages, and
 * `nodeCount + branch` is the current through voltage source `branch`.
 *
 * Stamps land in one of three places. Those made while building go into the constant
 * base. A solve then starts with `beginStep`, after which linear elements stamp the
 * right-hand sides that hold for all its Newton iterations, and each iteration starts with
 * `beginIteration`, after which nonlinear elements stamp the working copy. Only the matrix
 * entries they reach are reset and factored again each iteration.
 *
 * Every array has one entry past its last unknown, where stamps on ground land.
 */
export class MnaSystem {
  readonly nodeCount: number;
  readonly branchCount: number;
  readonly size: number;
  readonly mode: AnalysisMode;
  readonly base: Float64Array;
  readonly baseRhs: Float64Array;
  /** The base plus the latest iteration's stamps. */
  readonly matrix: Float64Array;
  readonly rhs: Float64Array;
  /** Node voltages and branch currents from the latest solve, indexed by unknown. */
  readonly solution: Float64Array;
  readonly lu: LuMatrix;
  /** The matrix entries any stamp has reached, and the ones iterations change. */
  readonly pattern: MatrixPattern;
  /** The base right-hand side plus what linear elements stamp for the step being solved. */
  private readonly stepRhs: Float64Array;
  /** The right-hand side that stamps land in now: the base's, the step's or the iteration's. */
  private target: Float64Array;
  /** Cleared by any nonlinear element whose operating point is still moving. */
  converged = true;
  /** Newton iteration within the current step, from 0. */
  iteration = 0;
  time = 0;
  timeStep: number;
  /** Scales every independent source; DC solves ramp it to find hard operating points. */
  sourceScale = 1;
  private phase = BASE;
  /** True once the working copy has started from the base as it now is. */
  private isBaseCopied = false;
  /** True once the base as it now is has been factored. */
  private isBaseFactored = false;
  /** The base's companion conductances, stamped again for each new step length. */
  private readonly timed: TimedConductance[] = [];
  /** The base without them, as `finishBase` found it. */
  private untimedBase: Float64Array | null = null;

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
    this.base = new Float64Array(this.size * this.size + 1);
    this.baseRhs = new Float64Array(this.size + 1);
    this.matrix = new Float64Array(this.size * this.size + 1);
    this.rhs = new Float64Array(this.size + 1);
    this.stepRhs = new Float64Array(this.size + 1);
    this.target = this.baseRhs;
    this.solution = new Float64Array(this.size + 1);
    this.lu = new LuMatrix(this.size);
    this.pattern = new MatrixPattern(this.size);
  }

  /** Sends later stamps into the constant base, which starts empty. */
  beginBase() {
    this.phase = BASE;
    this.target = this.baseRhs;
    this.isBaseCopied = false;
    this.isBaseFactored = false;
    this.base.fill(0);
    this.baseRhs.fill(0);
    this.timed.length = 0;
    this.untimedBase = null;
  }

  /** Ends the base: the companion conductances go in last, for the step's length. */
  finishBase() {
    this.untimedBase = this.base.slice();
    this.stampTimed();
  }

  /**
   * Takes steps of `timeStep` from now on. Only the companion conductances depend on the
   * length, so the base is the one `finishBase` found with them stamped for the new one.
   */
  retime(timeStep: number) {
    const { untimedBase } = this;

    this.timeStep = timeStep;

    if (untimedBase === null) {
      return;
    }

    this.base.set(untimedBase);
    this.phase = BASE;
    this.stampTimed();
    this.isBaseCopied = false;
    this.isBaseFactored = false;
  }

  private stampTimed() {
    for (const { a, b, capacitance, inductance } of this.timed) {
      this.stampResistor(
        a,
        b,
        capacitance > 0
          ? this.capacitorResistance(capacitance)
          : this.inductorResistance(inductance),
      );
    }
  }

  /** Returns the companion resistor of `capacitance` for this system's steps. */
  capacitorResistance(capacitance: number) {
    return this.timeStep / (2 * capacitance);
  }

  /** Returns the companion resistor of `inductance` for this system's steps. */
  inductorResistance(inductance: number) {
    return (2 * inductance) / this.timeStep;
  }

  /** Stamps the companion resistor of `capacitance` between `a` and `b` into the base. */
  stampCapacitance(a: number, b: number, capacitance: number) {
    this.timed.push({ a, b, capacitance, inductance: 0 });
  }

  /** Stamps the companion resistor of `inductance` between `a` and `b` into the base. */
  stampInductance(a: number, b: number, inductance: number) {
    this.timed.push({ a, b, capacitance: 0, inductance });
  }

  /**
   * Starts a solve at one time and source level: later right-hand side stamps hold for
   * every Newton iteration of it. Linear elements stamp here, and never the matrix.
   */
  beginStep() {
    const { size, stepRhs, baseRhs } = this;

    this.phase = STEP;
    this.target = stepRhs;

    if (!this.isBaseCopied) {
      this.matrix.set(this.base);
      this.isBaseCopied = true;
    }

    for (let row = 0; row < size; row += 1) {
      stepRhs[row] = baseRhs[row] ?? 0;
    }
  }

  /**
   * Starts one Newton iteration: later stamps land in the working copy, which starts from
   * the base and the step's right-hand side. Only entries an iteration has stamped can
   * differ from the base, so only those are reset.
   */
  beginIteration() {
    const { size, matrix, base, rhs, stepRhs } = this;
    const { variable } = this.pattern;

    this.phase = ITERATION;
    this.target = rhs;

    for (let entry = 0; entry < variable.length; entry += 1) {
      const index = variable[entry] ?? 0;

      matrix[index] = base[index] ?? 0;
    }

    for (let row = 0; row < size; row += 1) {
      rhs[row] = stepRhs[row] ?? 0;
    }
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

    if (this.phase === BASE) {
      this.pattern.add(index);
      this.base[index] = (this.base[index] ?? 0) + value;

      return;
    }

    if (this.pattern.mask[index] !== VARIABLE_ENTRY) {
      this.addVariable(index);
    }

    this.matrix[index] = (this.matrix[index] ?? 0) + value;
  }

  /** Marks the entry at `index` as one that iterations change. */
  private addVariable(index: number) {
    if (this.phase !== ITERATION) {
      throw new Error(
        "Only nonlinear elements may stamp the matrix during a step.",
      );
    }

    this.pattern.addVariable(index);
  }

  /** Adds `value` to one right-hand side row; the ground row is dropped. */
  stampRightSide(row: number, value: number) {
    if (row <= 0 || value === 0) {
      return;
    }

    this.target[row - 1] = (this.target[row - 1] ?? 0) + value;
  }

  /**
   * Returns a handle on the matrix entry at `row` and `column`, for a nonlinear element
   * to add to every iteration with `addEntry`. The entry counts as one iterations change.
   */
  variableEntry(row: number, column: number): Handle {
    if (row <= 0 || column <= 0) {
      return this.size * this.size;
    }

    const index = (row - 1) * this.size + (column - 1);

    this.pattern.addVariable(index);

    return index;
  }

  /** Returns a handle on the right-hand side row of `row`, for `addRightSide`. */
  rightSideRow(row: number): Handle {
    return row <= 0 ? this.size : row - 1;
  }

  /** Adds `value` to the matrix entry behind a handle from `variableEntry`, in an iteration. */
  addEntry(entry: Handle, value: number) {
    this.matrix[entry] = (this.matrix[entry] ?? 0) + value;
  }

  /** Adds `value` to the right-hand side row behind a handle from `rightSideRow`. */
  addRightSide(row: Handle, value: number) {
    this.target[row] = (this.target[row] ?? 0) + value;
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
   * Solves the working copy, factoring only what has changed since the last solve.
   * Returns false when the circuit has no solution or the result is not finite. The
   * right-hand side is used up.
   */
  solve() {
    if (this.isBaseFactored) {
      return this.lu.updateAndSolve(
        this.matrix,
        this.pattern,
        this.rhs,
        this.solution,
        1,
      );
    }

    if (!this.lu.factor(this.matrix, this.pattern)) {
      return false;
    }

    this.isBaseFactored = true;

    return Number.isFinite(this.lu.solve(this.rhs, this.solution, 1));
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
    this.real = operatingMatrix.slice(0, size * size);
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
