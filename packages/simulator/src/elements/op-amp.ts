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
import type { AcSystem, MnaSystem } from "../mna-system";
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
];

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
  /** Which swing limit holds the pole node: 1 high, -1 low, 0 neither. */
  private limit = 0;

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

    if (!this.hasPole) {
      return;
    }

    // C = AVOL / (2π × GBW) across 1 Ω puts the pole at GBW / AVOL.
    const poleNode = this.node(this.poleIndex());

    this.pole.capacitance =
      this.params.get("gain") / (2 * Math.PI * this.params.get("gbw"));
    system.stampMatrix(poleNode, poleNode, 1);
    this.pole.stamp(system, poleNode, 0);
    // The output follows the pole node.
    system.stampMatrix(row, driven, 1);
    system.stampMatrix(row, poleNode, -1);
  }

  override startStep(system: MnaSystem) {
    this.pole.startStep(system);
  }

  override stampStep(system: MnaSystem) {
    const [inverting = 0, nonInverting = 0] = this.volts;
    const offset = this.params.get("vos");
    const difference = nonInverting - inverting + offset;

    if (this.hasPole) {
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
    const poleNode = this.node(this.poleIndex());
    const poleVoltage = this.volts[this.poleIndex()] ?? 0;
    const gain = this.params.get("gain");
    const maxCurrent = this.maxStageCurrent();
    const ratio = Math.tanh((gain * difference) / maxCurrent);
    const current = maxCurrent * ratio;
    const conductance = gain * (1 - ratio * ratio);

    // Newton has not converged while the input difference moves more than 1 µV.
    if (Math.abs(difference - this.lastInputDifference) > 1e-6) {
      system.converged = false;
    }

    // The stage pushes `current` into the pole node: a negative current leaving it.
    system.stampMatrix(poleNode, this.node(1), -conductance);
    system.stampMatrix(poleNode, this.node(0), conductance);
    system.stampRightSide(
      poleNode,
      current - conductance * difference + conductance * offset,
    );

    // Past a swing limit, a stiff conductance holds the pole node at that limit.
    const vmax = this.params.get("vmax");
    const vmin = this.params.get("vmin");
    const limit = poleVoltage > vmax ? 1 : poleVoltage < vmin ? -1 : 0;

    if (limit !== this.limit) {
      system.converged = false;
      this.limit = limit;
    }

    if (limit !== 0) {
      const swing = Math.max(Math.abs(vmax), Math.abs(vmin), 1);
      const stiffness = (LIMITER_STIFFNESS * maxCurrent) / swing;

      system.stampMatrix(poleNode, poleNode, stiffness);
      system.stampRightSide(poleNode, stiffness * (limit === 1 ? vmax : vmin));
    }

    this.pole.stampStep(system, poleNode, 0);
  }

  /** Stamps Falstad's clipped voltage-controlled source, used without a gain-bandwidth product. */
  private stampClippedStage(
    system: MnaSystem,
    difference: number,
    offset: number,
  ) {
    const gain = this.params.get("gain");
    const vmax = this.params.get("vmax");
    const vmin = this.params.get("vmin");
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
    this.pole.finish(system, this.volts[this.poleIndex()] ?? 0);
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
    this.limit = 0;
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
