import { CompanionCapacitor } from "../companion";
import {
  CircuitElement,
  type EditField,
  EXTENDED_FORMAT_FLAG,
  type TokenReader,
} from "../element";
import {
  directionSign,
  distance,
  interpolate,
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

/** Length of the leads at either end of the op-amp's triangle. */
const LEAD_LENGTH = 16;

/** Distance of the triangle's back corners from the op-amp's axis. */
const BODY_HALF_HEIGHT = 32;

/** Distance of the VCC and VEE posts from the op-amp's axis, halfway along it. */
const SUPPLY_OFFSET = 32;

/** How far the supplies may move between Newton iterations before the swing has not converged. */
const SUPPLY_VOLTAGE_TOLERANCE = 1e-6;

/**
 * Set on op-amps with VCC and VEE posts, whose output swings within a drop of each.
 * Falstad's op-amps have neither, and their swing stays a fixed pair of voltages.
 */
const SUPPLY_POSTS_FLAG = 1 << 17;

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
  {
    key: "dropHigh",
    label: "Output drop below VCC",
    unit: "V",
    fallback: 0,
    range: "nonnegative",
    spiceNames: [],
    hint: "How far below VCC the output tops out: VCC minus the datasheet's high swing.",
  },
  {
    key: "dropLow",
    label: "Output drop above VEE",
    unit: "V",
    fallback: 0,
    range: "nonnegative",
    spiceNames: [],
    hint: "How far above VEE the output bottoms out.",
  },
];

/** What old files add to a preset's name: the supply it was once named for. */
const LEGACY_PRESET_SUFFIX = / \(±15 V\)$/u;

const OP_AMP_PRESETS: readonly Preset[] = [
  {
    name: "Ideal",
    isGeneric: true,
    values: { gain: 100_000, vmax: 15, vmin: -15, dropHigh: 0, dropLow: 0 },
  },
  {
    name: "LM741",
    values: {
      gain: 200_000,
      gbw: 1e6,
      slew: 0.5,
      rin: 2e6,
      rout: 75,
      vos: 1e-3,
      vmax: 13,
      vmin: -13,
      dropHigh: 2,
      dropLow: 2,
    },
  },
  {
    name: "LM358",
    values: {
      gain: 100_000,
      gbw: 1e6,
      slew: 0.3,
      rin: 1e7,
      rout: 50,
      vos: 2e-3,
      vmax: 13.5,
      vmin: -15,
      dropHigh: 1.5,
      dropLow: 0.005,
    },
  },
  {
    name: "TL072",
    values: {
      gain: 200_000,
      gbw: 3e6,
      slew: 13,
      rin: 1e12,
      rout: 100,
      vos: 3e-3,
      vmax: 13.5,
      vmin: -13.5,
      dropHigh: 1.5,
      dropLow: 1.5,
    },
  },
  {
    name: "NE5532",
    values: {
      gain: 100_000,
      gbw: 1e7,
      slew: 9,
      rin: 3e5,
      rout: 0.3,
      vos: 5e-4,
      vmax: 13,
      vmin: -13,
      dropHigh: 2,
      dropLow: 2,
    },
  },
  {
    // A comparator: datasheets give response times, not a GBW. 120 MHz turns 5 mV of
    // overdrive into 3.8 V/µs, a 5 V swing in the 1.3 µs it quotes; 17 V/µs swings 5 V
    // in its 0.3 µs for a TTL step. The open-collector output sinks 4 mA at 150 mV
    // (37.5 Ω) and rises to its pull-up, here VCC or the +15 V rail.
    name: "LM393",
    values: {
      gain: 200_000,
      gbw: 1.2e8,
      slew: 17,
      rout: 37.5,
      vos: 2e-3,
      vmax: 15,
      vmin: -15,
      dropHigh: 0,
      dropLow: 0,
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
 * How many times longer than a breakpoint step a snapping stage's steps may grow as its
 * current saturates and its regeneration slows.
 */
const SNAPPING_GROWTH = 16;

/**
 * How many times shorter than the outer step a stage's whole transition, snapping over
 * and slewing to the other limit, must be for the stage to flip in one step: that detail
 * is then finer than anything the steps show.
 */
const FLIP_RATIO = 32;

/**
 * The most releases an op-amp whose flips failed snaps over in short steps before it
 * tries one again. Under negative feedback a flip never holds, and each failed one throws
 * Newton far off; a comparator's rarely fails.
 */
const MAX_FLIP_BACKOFF = 1024;

/**
 * How far past its knee the input stage is saturated, in units of the difference that
 * reaches it: its current is then within 0.5% of the largest.
 */
const SATURATED_STAGE = 3;

/**
 * Ratio of the swing limiter's pull to the input stage's largest current. The node gives
 * a little as the stage weakens toward the release, and with positive feedback that give
 * speeds the input difference up; a stiff limiter keeps it to a hundredth, so the release
 * comes where the steps toward it predicted.
 */
const LIMITER_STIFFNESS = 10000;

/**
 * An op-amp built from its datasheet values. With a gain-bandwidth product, the input
 * stage drives a single pole: a transconductance into a 1 Ω, C node whose voltage the
 * output follows. Its current saturates at slew rate × C, and a limiter holds the node
 * inside the output swing. Without one, the output is a clipped voltage-controlled
 * source, as in Falstad. Posts are the inverting input, the non-inverting input and the
 * output, which is the second point, then VCC and VEE on op-amps with supply posts.
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
  /**
   * The limit the stage flips to in this step, skipping its snap and slew: 1 high, -1
   * low, 0 while it takes them in short steps. A held stage flips in the step its release
   * falls in; one that let go unforeseen, in the step after.
   */
  private flipTo = 0;
  /** Releases left before the stage tries to flip again, and how many the next failure skips. */
  private flipSkips = 0;
  private flipBackoff = 1;
  /** The outer step the latest step was taken within, as its system said. */
  private outerTimeStep = Number.POSITIVE_INFINITY;
  private settledDifference = 0;
  private settledPole = 0;
  /**
   * How fast the input difference moved over the latest step, in volts per second, and
   * how long that step was; NaN while a limit has not held the pole node for a whole step.
   */
  private settledRate = Number.NaN;
  private settledStep = 0;
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
    /** How far inside VCC and VEE the output swings, with supply posts. */
    dropHigh: 0,
    dropLow: 0,
  };

  /** New op-amps have supply posts; ones read from a file have them if their flags say so. */
  constructor(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    flags = SUPPLY_POSTS_FLAG,
  ) {
    super(x1, y1, x2, y2, flags);
  }

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

      // Presets were once named for a ±15 V supply, as in "LM358 (±15 V)".
      const name = opAmp.params.modelName.replace(LEGACY_PRESET_SUFFIX, "");

      if (OP_AMP_PRESETS.some((preset) => preset.name === name)) {
        opAmp.params.modelName = name;
      }
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

  /** True when VCC and VEE posts set the output swing. */
  get hasSupplyPosts() {
    return (this.flags & SUPPLY_POSTS_FLAG) !== 0;
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

    const posts = [roundPoint(inverting), roundPoint(nonInverting), this.end];

    if (this.hasSupplyPosts) {
      // VCC on top and VEE below, whichever input is on top.
      const [vcc, vee] = interpolatePair(
        this.start,
        this.end,
        0.5,
        SUPPLY_OFFSET * directionSign(this.start, this.end),
      );

      posts.push(roundPoint(vcc), roundPoint(vee));
    }

    return posts;
  }

  /** Where the VCC and VEE leads meet the triangle, halfway along its sides. */
  supplyLeadEnds() {
    return interpolatePair(
      this.start,
      this.end,
      0.5,
      (BODY_HALF_HEIGHT / 2) * directionSign(this.start, this.end),
    );
  }

  /** The triangle, its back a lead's length after the inputs and its tip one before the output. */
  override bodyOutline() {
    const { start, end } = this;
    const length = distance(start, end) || 1;
    const back = interpolate(start, end, LEAD_LENGTH / length);
    const tip = interpolate(start, end, 1 - LEAD_LENGTH / length);

    return [
      interpolate(back, tip, 0, BODY_HALF_HEIGHT),
      interpolate(back, tip, 0, -BODY_HALF_HEIGHT),
      tip,
    ];
  }

  override internalNodeCount() {
    return (this.hasPole ? 1 : 0) + (this.params.get("rout") > 0 ? 1 : 0);
  }

  /** Returns how many posts the op-amp has, which is where its internal nodes start. */
  private postCount() {
    return this.hasSupplyPosts ? 5 : 3;
  }

  /** Returns the index in `nodes` of the pole node. */
  private poleIndex() {
    return this.postCount();
  }

  /** Returns the index in `nodes` of the ideal output, inside the output resistance. */
  private drivenIndex() {
    return this.params.get("rout") > 0
      ? this.postCount() + (this.hasPole ? 1 : 0)
      : 2;
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
    const { hasPole } = this;
    const gain = this.params.get("gain");
    const gbw = this.params.get("gbw");

    // C = AVOL / (2π × GBW) across 1 Ω puts the pole at GBW / AVOL.
    this.pole.capacitance = hasPole ? gain / (2 * Math.PI * gbw) : 0;
    this.stage = {
      hasPole,
      gain,
      offset: this.params.get("vos"),
      vmax: this.params.get("vmax"),
      vmin: this.params.get("vmin"),
      maxCurrent: hasPole ? this.maxStageCurrent() : 0,
      // With positive feedback the stage regenerates with a time constant of about
      // 1 / (2π × GBW × feedback). A trapezoidal step follows it while shorter than
      // twice that; past it the step's growth factor turns negative and the node rings.
      breakpointStep: hasPole ? 2 / (Math.PI * gbw) : Number.POSITIVE_INFINITY,
      releaseHigh: Number.NEGATIVE_INFINITY,
      releaseLow: Number.POSITIVE_INFINITY,
      stiffness: 0,
      dropHigh: this.params.get("dropHigh"),
      dropLow: this.params.get("dropLow"),
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

    const [vmax, vmin] = this.hasSupplyPosts
      ? this.supplySwing()
      : [this.stage.vmax, this.stage.vmin];

    this.setSwing(vmax, vmin);

    if (!hasPole) {
      return;
    }

    const poleNode = this.node(this.poleIndex());

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
    // Held at a limit, an armed stage flips in the step its release falls in.
    if (this.settledLimit !== 0) {
      this.flipTo =
        this.isArmed() && this.untilBreakpoint <= system.timeStep
          ? -this.settledLimit
          : 0;
    }

    this.pole.startStep(
      system,
      this.flipTo !== 0 ||
        (this.settledLimit !== 0 && this.timeToBreakpoint() > system.timeStep),
    );
  }

  override stampStep(system: MnaSystem) {
    if (this.hasSupplyPosts && this.followSupplies()) {
      system.converged = false;
    }

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

    // Past a swing limit, a stiff conductance holds the pole node at that limit. A step
    // starts from the limit the one before ended on: a flip may leave the node a hair
    // inside it, and a first solve without the limiter would throw it far past.
    let limit =
      system.iteration === 0 && this.settledLimit !== 0
        ? this.settledLimit
        : poleVoltage > vmax
          ? 1
          : poleVoltage < vmin
            ? -1
            : 0;

    if (this.flipTo !== 0) {
      limit = this.flipTo;

      // Once a solve has flipped it, the stage must hold the node at its new limit: with
      // positive feedback it does. One that would let go again snaps over as usual.
      if (system.iteration > 0 && !this.holdsAt(this.flipTo, difference)) {
        this.flipTo = 0;
        this.flipSkips = this.flipBackoff;
        this.flipBackoff = Math.min(2 * this.flipBackoff, MAX_FLIP_BACKOFF);
        limit = poleVoltage > vmax ? 1 : poleVoltage < vmin ? -1 : 0;
        system.converged = false;
      }
    }

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

    this.outerTimeStep = system.outerTimeStep;
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
      this.flipTo = 0;

      if (this.flipSkips > 0) {
        this.flipSkips -= 1;
      } else if (this.canFlip()) {
        this.flipTo = -this.settledLimit;
      }
    } else {
      if (this.flipTo !== 0 && this.limit === this.flipTo) {
        this.flipBackoff = 1;
      }

      this.flipTo = 0;
      this.snappingFor += system.timeStep;
    }

    if (
      this.limit !== 0 ||
      Math.abs(gain * difference) >= SATURATED_STAGE * maxCurrent ||
      this.snappingFor >= SNAPPING_STEPS * breakpointStep
    ) {
      this.snappingFor = Number.POSITIVE_INFINITY;
    }

    const { timeStep } = system;
    const averageRate = (difference - this.settledDifference) / timeStep;
    const isHeld = this.limit !== 0 && this.limit === this.settledLimit;

    const differenceRate = isHeld
      ? this.rateAtEnd(averageRate, timeStep)
      : averageRate;

    const poleRate = (pole - this.settledPole) / timeStep;
    const hadSettled = this.hasSettled;

    this.hasSettled = true;
    this.settledRate = isHeld ? averageRate : Number.NaN;
    this.settledStep = timeStep;
    this.settledLimit = this.limit;
    this.settledDifference = difference;
    this.settledPole = pole;
    this.untilBreakpoint = hadSettled
      ? this.predictBreakpoint(differenceRate, poleRate)
      : Number.POSITIVE_INFINITY;
  }

  /**
   * Returns how fast the input difference moves at the end of a step it moved across at
   * `averageRate`, from how that rate changed since the step before. An input charging
   * through an RC slows as it goes, and a limiter's release speeds up through positive
   * feedback, so the average lags; landing on the release from it takes several steps.
   * A rate that would turn around falls back on the average.
   */
  private rateAtEnd(averageRate: number, timeStep: number) {
    const { settledRate, settledStep } = this;

    if (!Number.isFinite(settledRate)) {
      return averageRate;
    }

    // Each average rate holds at the middle of its step.
    const slope = (averageRate - settledRate) / ((timeStep + settledStep) / 2);
    const rate = averageRate + (slope * timeStep) / 2;

    return Math.sign(rate) === Math.sign(averageRate) ? rate : averageRate;
  }

  override timeToBreakpoint() {
    return this.snappingFor === Number.POSITIVE_INFINITY && this.flipTo === 0
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

  /**
   * Returns the longest step that crosses a breakpoint. While the stage snaps over, its
   * regeneration's time constant grows as its slope falls toward saturation, and so may
   * the step that follows it.
   */
  override breakpointStep() {
    const { breakpointStep, gain } = this.stage;

    if (this.flipTo !== 0) {
      return this.transitionTime();
    }

    // An armed stage flips in a step centred on its release, which ends as it would
    // reach the other limit.
    if (this.snappingFor === Number.POSITIVE_INFINITY) {
      return this.isArmed() ? 2 * this.transitionTime() : breakpointStep;
    }

    const slope = Math.max(
      this.lastStageConductance / gain,
      1 / SNAPPING_GROWTH,
    );

    return breakpointStep / slope;
  }

  /**
   * Sets the output swing from VCC and VEE as they now are, each less its drop. A supply
   * narrower than the two drops, as an unpowered op-amp's, pins the output between
   * them. Returns true when the swing moved by more than the supply tolerance.
   */
  private followSupplies() {
    const { vmax, vmin } = this.stage;
    const [top, bottom] = this.supplySwing();

    if (top === vmax && bottom === vmin) {
      return false;
    }

    this.setSwing(top, bottom);

    return (
      Math.abs(top - vmax) > SUPPLY_VOLTAGE_TOLERANCE ||
      Math.abs(bottom - vmin) > SUPPLY_VOLTAGE_TOLERANCE
    );
  }

  /** Returns the highest and lowest output that VCC and VEE now allow. */
  private supplySwing() {
    const { dropHigh, dropLow } = this.stage;
    const [, , , vcc = 0, vee = 0] = this.volts;
    const high = vcc - dropHigh;
    const low = vee + dropLow;

    if (high >= low) {
      return [high, low] as const;
    }

    // Kept between the supplies, so an unpowered op-amp's output sits at their level.
    const middle = Math.min(
      Math.max((high + low) / 2, Math.min(vcc, vee)),
      Math.max(vcc, vee),
    );

    return [middle, middle] as const;
  }

  /** Sets the output swing, and with it where the limiters let go and how hard they hold. */
  private setSwing(vmax: number, vmin: number) {
    const { stage } = this;

    stage.vmax = vmax;
    stage.vmin = vmin;

    if (!stage.hasPole) {
      return;
    }

    stage.releaseHigh = this.releaseDifference(vmax);
    stage.releaseLow = this.releaseDifference(vmin);
    stage.stiffness =
      (LIMITER_STIFFNESS * stage.maxCurrent) /
      Math.max(Math.abs(vmax), Math.abs(vmin), 1);
  }

  /**
   * Returns how long the stage takes to snap over once a limit lets go and slew the pole
   * node to the other limit.
   */
  private transitionTime() {
    const { breakpointStep, maxCurrent, vmax, vmin } = this.stage;

    return (
      SNAPPING_STEPS * breakpointStep +
      ((vmax - vmin) * this.pole.capacitance) / maxCurrent
    );
  }

  /** True while a limit holds the pole node and the stage will flip once it lets go. */
  private isArmed() {
    return this.settledLimit !== 0 && this.flipSkips === 0 && this.canFlip();
  }

  /** True when the stage's whole transition is short enough to flip over in one step. */
  private canFlip() {
    return this.transitionTime() * FLIP_RATIO <= this.outerTimeStep;
  }

  /** True when the stage, at input difference `difference`, pushes the pole node past `limit`. */
  private holdsAt(limit: number, difference: number) {
    const { releaseHigh, releaseLow } = this.stage;

    return limit === 1 ? difference >= releaseHigh : difference <= releaseLow;
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
    const paths = [0, 0, -this.currentIntoPost(2)];

    return this.hasSupplyPosts ? [...paths, 0, 0] : paths;
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
    this.flipTo = 0;
    this.flipSkips = 0;
    this.flipBackoff = 1;
    this.outerTimeStep = Number.POSITIVE_INFINITY;
    this.settledDifference = 0;
    this.settledPole = 0;
    this.settledRate = Number.NaN;
    this.settledStep = 0;
    this.untilBreakpoint = Number.POSITIVE_INFINITY;
    this.pole.reset();
  }

  override info() {
    const [inverting = 0, nonInverting = 0, output = 0, vcc = 0, vee = 0] =
      this.volts;

    const lines = [
      this.title(),
      this.params.modelName,
      `V+ = ${formatSi(nonInverting, "V")}`,
      `V− = ${formatSi(inverting, "V")}`,
      `Vout = ${formatSi(output, "V")}`,
      `Iout = ${formatSi(-this.current, "A")}`,
    ];

    if (this.hasSupplyPosts) {
      lines.push(`VCC = ${formatSi(vcc, "V")}`, `VEE = ${formatSi(vee, "V")}`);
    }

    return lines;
  }

  override editFields(): EditField[] {
    // With supply posts the swing is each supply less its drop; without, a fixed pair.
    const hiddenKeys = this.hasSupplyPosts
      ? ["vmax", "vmin"]
      : ["dropHigh", "dropLow"];

    return [
      ...this.params.fields().filter(({ key }) => !hiddenKeys.includes(key)),
      {
        kind: "boolean",
        key: "supply-posts",
        label: "VCC and VEE posts",
        value: this.hasSupplyPosts,
        set: (value) => {
          this.flags = value
            ? this.flags | SUPPLY_POSTS_FLAG
            : this.flags & ~SUPPLY_POSTS_FLAG;
        },
      },
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
