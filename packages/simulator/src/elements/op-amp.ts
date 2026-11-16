import { CompanionCapacitor } from "../companion";
import {
  CircuitElement,
  type EditField,
  EXTENDED_FORMAT_FLAG,
  type TokenReader,
} from "../element";
import {
  directionSign,
  interpolatePair,
  type Point,
  roundPoint,
} from "../geometry";
import {
  type AcSystem,
  type Handle,
  mispredicts,
  type MnaSystem,
} from "../mna-system";
import { ParamSet, type ParamSpec, type Preset } from "../params";
import { formatSi } from "../units";

/** Distance of the inputs from the op-amp's axis. */
const INPUT_OFFSET = 16;

const OP_AMP_SPECS: readonly ParamSpec[] = [
  {
    key: "gain",
    label: "Open-loop gain (AVOL)",
    unit: "V/V",
    fallback: 100_000,
    range: "positive",
    spiceNames: [],
    hint: "Datasheets often give it in dB: 106 dB is 200 000 V/V.",
  },
  {
    key: "gbw",
    label: "Gain-bandwidth product",
    unit: "Hz",
    fallback: 0,
    range: "nonnegative",
    spiceNames: [],
    hint: "0 for unlimited bandwidth.",
  },
  {
    key: "slew",
    label: "Slew rate",
    unit: "V/µs",
    fallback: 0,
    range: "nonnegative",
    spiceNames: [],
    hint: "Needs a gain-bandwidth product. 0 for no limit.",
  },
  {
    key: "rin",
    label: "Input resistance",
    unit: "Ω",
    fallback: 0,
    range: "nonnegative",
    spiceNames: [],
    hint: "Between the inputs; 0 for infinite.",
  },
  {
    key: "rout",
    label: "Output resistance",
    unit: "Ω",
    fallback: 0,
    range: "nonnegative",
    spiceNames: [],
  },
  {
    key: "vos",
    label: "Input offset voltage",
    unit: "V",
    fallback: 0,
    range: "any",
    spiceNames: [],
  },
  {
    key: "vmax",
    label: "Output swing high",
    unit: "V",
    fallback: 15,
    range: "any",
    spiceNames: [],
    hint: "The highest the output reaches with your supply, from the datasheet.",
  },
  {
    key: "vmin",
    label: "Output swing low",
    unit: "V",
    fallback: -15,
    range: "any",
    spiceNames: [],
  },
];

const OP_AMP_PRESETS: readonly Preset[] = [
  {
    name: "Ideal",
    isGeneric: true,
    values: { gain: 100_000, vmax: 15, vmin: -15 },
  },
  {
    name: "LM741 (±15 V)",
    values: {
      gain: 200_000,
      gbw: 1e6,
      slew: 0.5,
      rin: 2e6,
      rout: 75,
      vos: 1e-3,
      vmax: 13,
      vmin: -13,
    },
  },
  {
    name: "LM358 (±15 V)",
    values: {
      gain: 100_000,
      gbw: 1e6,
      slew: 0.3,
      rin: 1e7,
      rout: 50,
      vos: 2e-3,
      vmax: 13.5,
      vmin: -15,
    },
  },
  {
    name: "TL072 (±15 V)",
    values: {
      gain: 200_000,
      gbw: 3e6,
      slew: 13,
      rin: 1e12,
      rout: 100,
      vos: 3e-3,
      vmax: 13.5,
      vmin: -13.5,
    },
  },
  {
    name: "NE5532 (±15 V)",
    values: {
      gain: 100_000,
      gbw: 1e7,
      slew: 9,
      rin: 3e5,
      rout: 0.3,
      vos: 5e-4,
      vmax: 13,
      vmin: -13,
    },
  },
  {
    // A comparator: datasheets give response times, not a GBW. 120 MHz turns 5 mV of
    // overdrive into 3.8 V/µs, a 5 V swing in the 1.3 µs it quotes; 17 V/µs swings 5 V
    // in its 0.3 µs for a TTL step. The open-collector output sinks 4 mA at 150 mV
    // (37.5 Ω) and rises to its pull-up, here the +15 V rail.
    name: "LM393 (±15 V)",
    values: {
      gain: 200_000,
      gbw: 1.2e8,
      slew: 17,
      rout: 37.5,
      vos: 2e-3,
      vmax: 15,
      vmin: -15,
    },
  },
];

/**
 * Returns how long something `distance` short of a breakpoint takes to reach it moving
 * toward it at `speed`: 0 once past it, Infinity when it is not getting closer.
 */
function timeToCross(distance: number, speed: number) {
  if (!(distance > 0)) {
    return distance <= 0 ? 0 : Number.POSITIVE_INFINITY;
  }

  return speed > 0 ? distance / speed : Number.POSITIVE_INFINITY;
}

/**
 * How many breakpoint steps a stage may take to snap over once a limit lets go of it.
 * A comparator regenerates through its high-gain region in about six time constants.
 */
const SNAPPING_STEPS = 10;

/**
 * How far past its knee the input stage is saturated, in units of the difference that
 * reaches it: its current is then within 0.5% of the largest.
 */
const SATURATED_STAGE = 3;

/** Ratio of the swing limiter's pull to the input stage's largest current. */
const LIMITER_STIFFNESS = 1000;

/**
 * An op-amp built from its datasheet values. With a gain-bandwidth product, the input
 * stage drives a single pole: a transconductance into a 1 Ω, C node whose voltage the
 * output follows. Its current saturates at slew rate × C, and a limiter holds the node
 * inside the output swing. Without one, the output is a clipped voltage-controlled
 * source, as in Falstad. Posts are the inverting input, the non-inverting input and the
 * output, which is the second point.
 */
export class OpAmp extends CircuitElement {
  readonly kind = "op-amp";
  readonly dumpType = "a";
  override readonly designatorPrefix = "U";
  override readonly mirrorFlag = 1;
  protected override readonly usesExtendedFormat = true;
  readonly params = new ParamSet(OP_AMP_SPECS, OP_AMP_PRESETS);
  /** The capacitor that sets the dominant pole. */
  readonly pole = new CompanionCapacitor(0);
  private lastInputDifference = 0;
  /** The input stage's current and slope at `lastInputDifference`, as last stamped. */
  private lastStageCurrent = 0;
  private lastStageConductance = 0;
  /**
   * The input difference those two were worked out at with the parameters `stamp` last
   * read, so a stamp at the same difference reuses them; NaN when they are from before.
   */
  private stageInput = Number.NaN;
  /** Which swing limit holds the pole node: 1 high, -1 low, 0 neither. */
  private limit = 0;
  /**
   * The input difference and pole node voltage the latest step ended on, to tell from how
   * fast each moves when the next breakpoint comes. `hasSettled` is false until a step
   * has ended.
   */
  private hasSettled = false;
  /** The limit that held the pole node when the latest step ended. */
  private settledLimit = 0;
  /** Seconds since a limit let go of the pole node, while the stage still snaps over. */
  private snappingFor = Number.POSITIVE_INFINITY;
  private settledDifference = 0;
  private settledPole = 0;
  /** Seconds from the latest step's end to the next breakpoint, as `finishStep` predicts. */
  private untilBreakpoint = Number.POSITIVE_INFINITY;
  /** Where the pole stage stamps: the pole node's row, and in it the inputs and itself. */
  private poleRow: Handle = 0;
  private poleFromInverting: Handle = 0;
  private poleFromNonInverting: Handle = 0;
  private poleFromPole: Handle = 0;
  /**
   * The parameters each step reads, as `stamp` last read them: they hold for a whole
   * simulation, and looking them up every iteration costs more than the stage itself.
   */
  private stage = {
    hasPole: false,
    gain: 0,
    offset: 0,
    vmax: 0,
    vmin: 0,
    /** The input stage's largest current, which sets the slew rate. */
    maxCurrent: 0,
    /** The longest step that follows the pole stage through a breakpoint. */
    breakpointStep: Number.POSITIVE_INFINITY,
    /** The input differences where the limiters let go of the pole node. */
    releaseHigh: Number.NEGATIVE_INFINITY,
    releaseLow: Number.POSITIVE_INFINITY,
    /** The conductance a limiter holds the pole node with. */
    stiffness: 0,
  };

  static override read(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    flags: number,
    reader: TokenReader,
  ) {
    const opAmp = new OpAmp(x1, y1, x2, y2, flags);
    const maxOutput = reader.number(15);
    const minOutput = reader.number(-15);

    // Skip Falstad's gain-bandwidth product; extended lines carry their own.
    reader.number(1e6);

    if ((flags & EXTENDED_FORMAT_FLAG) !== 0) {
      opAmp.params.read(reader);
    } else {
      opAmp.params.set("vmax", maxOutput);
      opAmp.params.set("vmin", minOutput);
    }

    return opAmp;
  }

  name() {
    return "Op-amp";
  }

  override valueLabel() {
    return this.params.isGeneric ? "" : this.params.modelName;
  }

  /** True when flag 1 puts the non-inverting input on top. */
  get isSwapped() {
    return (this.flags & 1) !== 0;
  }

  /** True when a gain-bandwidth product gives the op-amp a dominant pole. */
  private get hasPole() {
    return this.params.get("gbw") > 0;
  }

  override posts(): Point[] {
    const across =
      INPUT_OFFSET *
      directionSign(this.start, this.end) *
      (this.isSwapped ? -1 : 1);

    const [inverting, nonInverting] = interpolatePair(
      this.start,
      this.end,
      0,
      across,
    );

    return [roundPoint(inverting), roundPoint(nonInverting), this.end];
  }

  override internalNodeCount() {
    return (this.hasPole ? 1 : 0) + (this.params.get("rout") > 0 ? 1 : 0);
  }

  /** Returns the index in `nodes` of the pole node. */
  private poleIndex() {
    return 3;
  }

  /** Returns the index in `nodes` of the ideal output, inside the output resistance. */
  private drivenIndex() {
    return this.params.get("rout") > 0 ? (this.hasPole ? 4 : 3) : 2;
  }

  override branchCount() {
    return 1;
  }

  override isNonlinear() {
    return true;
  }

  /** The pole stage tests its predicted current; the clipped stage only how far it moved. */
  override hasExactConvergenceTest() {
    return this.hasPole;
  }

  /** Returns the input stage's largest current, which sets the slew rate. */
  private maxStageCurrent() {
    const slew = this.params.get("slew") * 1e6;

    const swing = Math.max(
      Math.abs(this.params.get("vmax")),
      Math.abs(this.params.get("vmin")),
      1,
    );

    return slew > 0
      ? slew * this.pole.capacitance
      : swing * this.params.get("gain");
  }

  override stamp(system: MnaSystem) {
    this.stage = {
      hasPole: this.hasPole,
      gain: this.params.get("gain"),
      offset: this.params.get("vos"),
      vmax: this.params.get("vmax"),
      vmin: this.params.get("vmin"),
      maxCurrent: 0,
      breakpointStep: Number.POSITIVE_INFINITY,
      releaseHigh: Number.NEGATIVE_INFINITY,
      releaseLow: Number.POSITIVE_INFINITY,
      stiffness: 0,
    };

    const row = system.branchUnknown(this.firstBranch);
    const driven = this.node(this.drivenIndex());
    const rin = this.params.get("rin");
    const rout = this.params.get("rout");

    system.stampMatrix(driven, row, 1);

    if (rin > 0) {
      system.stampResistor(this.node(0), this.node(1), rin);
    }

    if (rout > 0) {
      system.stampResistor(driven, this.node(2), rout);
    }

    this.stageInput = Number.NaN;

    if (!this.hasPole) {
      return;
    }

    // C = AVOL / (2π × GBW) across 1 Ω puts the pole at GBW / AVOL.
    const poleNode = this.node(this.poleIndex());

    this.pole.capacitance =
      this.params.get("gain") / (2 * Math.PI * this.params.get("gbw"));
    this.stage.maxCurrent = this.maxStageCurrent();
    // With positive feedback the stage regenerates with a time constant of about
    // 1 / (2π × GBW × feedback). A trapezoidal step follows it while shorter than twice
    // that; past it the step's growth factor turns negative and the node rings.
    this.stage.breakpointStep = 2 / (Math.PI * this.params.get("gbw"));
    this.stage.releaseHigh = this.releaseDifference(this.stage.vmax);
    this.stage.releaseLow = this.releaseDifference(this.stage.vmin);
    this.stage.stiffness =
      (LIMITER_STIFFNESS * this.stage.maxCurrent) /
      Math.max(Math.abs(this.stage.vmax), Math.abs(this.stage.vmin), 1);
    this.poleRow = system.rightSideRow(poleNode);
    this.poleFromInverting = system.variableEntry(poleNode, this.node(0));
    this.poleFromNonInverting = system.variableEntry(poleNode, this.node(1));
    this.poleFromPole = system.variableEntry(poleNode, poleNode);
    system.stampMatrix(poleNode, poleNode, 1);
    this.pole.stamp(system, poleNode, 0);
    // The output follows the pole node.
    system.stampMatrix(row, driven, 1);
    system.stampMatrix(row, poleNode, -1);
  }

  /**
   * Held at a limit, the limiter and the pole capacitor form a mode far faster than any
   * step, which the trapezoidal rule leaves ringing; backward Euler damps it. A step that
   * may let go keeps the trapezoidal rule: the stage then regenerates, and backward Euler
   * turns that over once the step outlasts its time constant.
   */
  override startStep(system: MnaSystem) {
    this.pole.startStep(
      system,
      this.settledLimit !== 0 && this.timeToBreakpoint() > system.timeStep,
    );
  }

  override stampStep(system: MnaSystem) {
    const { volts } = this;
    const { offset, hasPole } = this.stage;
    const difference = (volts[1] ?? 0) - (volts[0] ?? 0) + offset;

    if (hasPole) {
      this.stampPoleStage(system, difference, offset);
    } else {
      this.stampClippedStage(system, difference, offset);
    }

    this.lastInputDifference = difference;
  }

  /** Stamps the transconductance into the pole node, its soft current limit and the limiter. */
  private stampPoleStage(
    system: MnaSystem,
    difference: number,
    offset: number,
  ) {
    const { poleRow } = this;
    const poleVoltage = this.volts[this.poleIndex()] ?? 0;
    const { gain, maxCurrent, vmax, vmin } = this.stage;

    // A step's first stamp is at the voltages the one before it ended on.
    if (difference !== this.stageInput) {
      const ratio = Math.tanh((gain * difference) / maxCurrent);
      const current = maxCurrent * ratio;

      const predicted =
        this.lastStageCurrent +
        this.lastStageConductance * (difference - this.lastInputDifference);

      if (mispredicts(current, predicted)) {
        system.converged = false;
      }

      this.lastStageCurrent = current;
      this.lastStageConductance = gain * (1 - ratio * ratio);
      this.stageInput = difference;
    }

    const current = this.lastStageCurrent;
    const conductance = this.lastStageConductance;

    // The stage pushes `current` into the pole node: a negative current leaving it.
    system.addEntry(this.poleFromNonInverting, -conductance);
    system.addEntry(this.poleFromInverting, conductance);
    system.addRightSide(
      poleRow,
      current - conductance * difference + conductance * offset,
    );

    // Past a swing limit, a stiff conductance holds the pole node at that limit.
    const limit = poleVoltage > vmax ? 1 : poleVoltage < vmin ? -1 : 0;

    if (limit !== this.limit) {
      system.converged = false;
      this.limit = limit;
    }

    if (limit !== 0) {
      const { stiffness } = this.stage;

      system.addEntry(this.poleFromPole, stiffness);
      system.addRightSide(poleRow, stiffness * (limit === 1 ? vmax : vmin));
    }

    if (this.pole.extraConductance !== 0) {
      system.addEntry(this.poleFromPole, this.pole.extraConductance);
    }

    this.pole.stampStep(system);
  }

  /** Stamps Falstad's clipped voltage-controlled source, used without a gain-bandwidth product. */
  private stampClippedStage(
    system: MnaSystem,
    difference: number,
    offset: number,
  ) {
    const { gain, vmax, vmin } = this.stage;
    const output = this.volts[this.drivenIndex()] ?? 0;

    // Newton has not converged while the input moves or the output overshoots a limit.
    if (Math.abs(this.lastInputDifference - difference) > 0.1) {
      system.converged = false;
    } else if (output > vmax + 0.1 || output < vmin - 0.1) {
      system.converged = false;
    }

    // Past a swing limit, a shallow slope stands in for the clipped output.
    let slope = gain;
    let constant = 0;
    // Every fourth iteration retries the other side, so a clipped output can recover.
    const isRetry = system.iteration % 4 === 1;

    if (
      difference >= vmax / gain &&
      (this.lastInputDifference >= 0 || isRetry)
    ) {
      slope = 1e-4;
      constant = vmax - (slope * vmax) / gain;
    } else if (
      difference <= vmin / gain &&
      (this.lastInputDifference <= 0 || isRetry)
    ) {
      slope = 1e-4;
      constant = vmin - (slope * vmin) / gain;
    }

    // Stamp the branch row: output = constant + slope × input difference.
    const row = system.branchUnknown(this.firstBranch);

    system.stampMatrix(row, this.node(0), slope);
    system.stampMatrix(row, this.node(1), -slope);
    system.stampMatrix(row, this.node(this.drivenIndex()), 1);
    system.stampRightSide(row, constant + slope * offset);
  }

  override finishStep(system: MnaSystem) {
    const { volts } = this;
    const pole = volts[this.poleIndex()] ?? 0;

    this.pole.finish(system, pole);

    if (system.mode !== "transient" || !this.stage.hasPole) {
      return;
    }

    const difference = (volts[1] ?? 0) - (volts[0] ?? 0) + this.stage.offset;
    const { gain, maxCurrent, breakpointStep } = this.stage;

    // Once a limit lets go, the stage snaps over until its current saturates, or, with
    // negative feedback, settles within a few time constants.
    if (this.settledLimit !== 0 && this.limit === 0) {
      this.snappingFor = 0;
    } else {
      this.snappingFor += system.timeStep;
    }

    if (
      this.limit !== 0 ||
      Math.abs(gain * difference) >= SATURATED_STAGE * maxCurrent ||
      this.snappingFor >= SNAPPING_STEPS * breakpointStep
    ) {
      this.snappingFor = Number.POSITIVE_INFINITY;
    }

    const differenceRate =
      (difference - this.settledDifference) / system.timeStep;

    const poleRate = (pole - this.settledPole) / system.timeStep;
    const hadSettled = this.hasSettled;

    this.hasSettled = true;
    this.settledLimit = this.limit;
    this.settledDifference = difference;
    this.settledPole = pole;
    this.untilBreakpoint = hadSettled
      ? this.predictBreakpoint(differenceRate, poleRate)
      : Number.POSITIVE_INFINITY;
  }

  override timeToBreakpoint() {
    return this.snappingFor === Number.POSITIVE_INFINITY
      ? this.untilBreakpoint
      : 0;
  }

  /**
   * Returns the seconds until the next breakpoint, were the input difference and the pole
   * node to keep moving at these rates, in volts per second. The pole stage has two: a
   * limiter lets go of the pole node once the input difference crosses where the stage
   * no longer pushes it past the limit, and catches it once it slews to the other limit.
   */
  private predictBreakpoint(differenceRate: number, poleRate: number) {
    const { vmax, vmin, releaseHigh, releaseLow } = this.stage;

    if (this.settledLimit === 1) {
      return timeToCross(this.settledDifference - releaseHigh, -differenceRate);
    }

    if (this.settledLimit === -1) {
      return timeToCross(releaseLow - this.settledDifference, differenceRate);
    }

    return poleRate > 0
      ? timeToCross(vmax - this.settledPole, poleRate)
      : timeToCross(this.settledPole - vmin, -poleRate);
  }

  override breakpointStep() {
    return this.stage.breakpointStep;
  }

  /**
   * Returns the input difference where the stage pushes just `limit` amps into the pole
   * node's 1 Ω, which holds it at `limit` volts: the limiter lets go there.
   */
  private releaseDifference(limit: number) {
    const { gain, maxCurrent } = this.stage;
    const ratio = limit / maxCurrent;

    // A stage too weak to reach the limit never lets go of it.
    if (!(Math.abs(ratio) < 1)) {
      return limit > 0 ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
    }

    return (maxCurrent / gain) * Math.atanh(ratio);
  }

  override stampAc(system: AcSystem, omega: number) {
    if (this.hasPole) {
      this.pole.stampAc(system, this.node(this.poleIndex()), 0, omega);
    }
  }

  /** Returns current only on the output lead, the third path, as it leaves the op-amp. */
  override currentPaths() {
    return [0, 0, -this.currentIntoPost(2)];
  }

  override currentIntoPost(post: number) {
    const rin = this.params.get("rin");
    const [inverting = 0, nonInverting = 0] = this.volts;
    const inputCurrent = rin > 0 ? (inverting - nonInverting) / rin : 0;

    return [inputCurrent, -inputCurrent, this.current][post] ?? 0;
  }

  override reset() {
    super.reset();
    this.lastInputDifference = 0;
    this.lastStageCurrent = 0;
    this.lastStageConductance = 0;
    this.stageInput = Number.NaN;
    this.limit = 0;
    this.hasSettled = false;
    this.settledLimit = 0;
    this.snappingFor = Number.POSITIVE_INFINITY;
    this.settledDifference = 0;
    this.settledPole = 0;
    this.untilBreakpoint = Number.POSITIVE_INFINITY;
    this.pole.reset();
  }

  override info() {
    const [inverting = 0, nonInverting = 0, output = 0] = this.volts;

    return [
      this.title(),
      this.params.modelName,
      `V+ = ${formatSi(nonInverting, "V")}`,
      `V− = ${formatSi(inverting, "V")}`,
      `Vout = ${formatSi(output, "V")}`,
      `Iout = ${formatSi(-this.current, "A")}`,
    ];
  }

  override editFields(): EditField[] {
    return [
      ...this.params.fields(),
      {
        kind: "boolean",
        key: "swap",
        label: "Non-inverting input on top",
        value: this.isSwapped,
        set: (value) => {
          this.flags = value ? this.flags | 1 : this.flags & ~1;
        },
      },
    ];
  }

  override dumpValues() {
    return [
      this.params.get("vmax"),
      this.params.get("vmin"),
      this.params.get("gbw") || 1e6, // Falstad's GBW field; 1 MHz when unlimited.
      ...this.params.dump(),
    ];
  }
}
