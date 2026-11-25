import { CompanionCapacitor } from "../companion";
import { CircuitElement, type EditField, type TokenReader } from "../element";
import { type Point, snapToGrid } from "../geometry";
import {
  type AcSystem,
  type Handle,
  mispredicts,
  type MnaSystem,
} from "../mna-system";
import { ParamSet, type ParamSpec, type Preset } from "../params";
import { formatSi } from "../units";

/** The LM386's pins in the order of its posts and nodes: pin 1 first, pin 8 last. */
export const AMPLIFIER_PINS = [
  { name: "GAIN1", number: 1, x: 16, y: -16 },
  { name: "-IN", number: 2, x: -16, y: 32 },
  { name: "+IN", number: 3, x: -16, y: 64 },
  { name: "GND", number: 4, x: 48, y: 112 },
  { name: "OUT", number: 5, x: 112, y: 48 },
  { name: "VS", number: 6, x: 80, y: -16 },
  { name: "BYPASS", number: 7, x: 80, y: 112 },
  { name: "GAIN8", number: 8, x: 48, y: -16 },
] as const;

/** Width and height of the LM386's body, from its first point. */
export const AMPLIFIER_SIZE = { width: 96, height: 96 } as const;

// Indexes of the LM386's posts and nodes, in `AMPLIFIER_PINS` order.
const GAIN_1 = 0;

const INVERTING = 1;

const NON_INVERTING = 2;

const GROUND = 3;

const OUTPUT = 4;

const SUPPLY = 5;

const BYPASS = 6;

const GAIN_8 = 7;

/** Internal node: the inverting side's emitter, at the far end of the 150 Ω from pin 8. */
const EMITTER = 8;

/** Internal node: the pole node, which holds the voltage the output stage drives OUT to. */
const POLE = 9;

/** The feedback resistor from OUT to pin 1. */
const FEEDBACK_RESISTANCE = 15_000;

/** The emitter resistor from pin 8 to the inverting side. */
const EMITTER_RESISTANCE = 150;

/** The resistor between pins 1 and 8, which a capacitor across them shorts for gain 200. */
const GAIN_RESISTANCE = 1350;

/** Each half of the divider from VS through BYPASS to GND that sets the output at VS / 2. */
const BIAS_RESISTANCE = 15_000;

/** Loop gain around the feedback resistor: the gain is within 1 / this of its setting. */
const LOOP_GAIN = 10_000;

/** Conductance that holds the pole node inside the output swing, so it never winds up. */
const CLAMP_CONDUCTANCE = 1;

/** Width of the clamps' rounded corner, which keeps Newton's method smooth. */
const CLAMP_KNEE = 5e-3;

/** Current through the output pair with no signal; class AB, so it turns over smoothly. */
const OUTPUT_BIAS = 1e-3;

/** The supply the datasheet gives the quiescent current at. */
const QUIESCENT_SUPPLY = 6;

/** Supply voltage over which the quiescent current comes up from 0. */
const SUPPLY_KNEE = 1;

const AMPLIFIER_SPECS: readonly ParamSpec[] = [
  {
    key: "bw",
    label: "Bandwidth",
    unit: "Hz",
    fallback: 300_000,
    range: "positive",
    spiceNames: [],
    hint: "The −3 dB point; it stays put as pins 1 and 8 change the gain.",
  },
  {
    key: "rin",
    label: "Input resistance",
    unit: "Ω",
    fallback: 50_000,
    range: "positive",
    spiceNames: [],
    hint: "From each input to GND.",
  },
  {
    key: "dropHigh",
    label: "Output drop below VS",
    unit: "V",
    fallback: 0.6,
    range: "nonnegative",
    spiceNames: [],
    hint: "How far below VS the output tops out with no load.",
  },
  {
    key: "dropLow",
    label: "Output drop above GND",
    unit: "V",
    fallback: 0.6,
    range: "nonnegative",
    spiceNames: [],
  },
  {
    key: "rout",
    label: "Output resistance",
    unit: "Ω",
    fallback: 1.4,
    range: "positive",
    spiceNames: [],
    hint: "Adds to the drops under load: an 8 Ω speaker swings to about 1.2 V from each rail.",
  },
  {
    key: "ilimit",
    label: "Output current limit",
    unit: "A",
    fallback: 1,
    range: "positive",
    spiceNames: [],
  },
  {
    key: "iq",
    label: "Quiescent current",
    unit: "A",
    fallback: 4e-3,
    range: "nonnegative",
    spiceNames: [],
    hint: "Drawn from VS at 6 V with no signal.",
  },
  {
    key: "vsmin",
    label: "Lowest supply",
    unit: "V",
    fallback: 4,
    range: "nonnegative",
    spiceNames: [],
    hint: "The readout warns outside the supply range; the model runs anyway.",
  },
  {
    key: "vsmax",
    label: "Highest supply",
    unit: "V",
    fallback: 12,
    range: "positive",
    spiceNames: [],
  },
];

/**
 * LM386 grades. They share one die and differ in their supply range and the output power
 * they are tested for at 10% distortion: the N-1 325 mW at 6 V into 8 Ω, the N-3 700 mW at
 * 9 V into 8 Ω and the N-4 1 W at 16 V into 32 Ω.
 */
const AMPLIFIER_PRESETS: readonly Preset[] = [
  { name: "LM386N-1", values: { vsmin: 4, vsmax: 12 } },
  { name: "LM386N-3", values: { vsmin: 4, vsmax: 12 } },
  { name: "LM386N-4", values: { vsmin: 5, vsmax: 18 } },
];

/** Returns softplus(`u`) with a corner `CLAMP_KNEE` wide, and its slope. */
function softplus(u: number) {
  const ratio = u / CLAMP_KNEE;

  if (ratio > 30) {
    return { value: u, slope: 1 };
  }

  const exponential = Math.exp(ratio);

  return {
    value: CLAMP_KNEE * Math.log1p(exponential),
    slope: exponential / (1 + exponential),
  };
}

/**
 * Returns the part of output current `current` that VS supplies: all of it when sourcing,
 * none when sinking, and the output pair's bias in between.
 */
function sourcedPart(current: number) {
  return (current + Math.hypot(current, 2 * OUTPUT_BIAS)) / 2;
}

/**
 * Where each Newton iteration stamps: the right-hand side rows of the pole node, VS, GND
 * and OUT, and the matrix entries their currents reach, named row then column.
 */
type IteratedHandles = {
  pole: Handle;
  supply: Handle;
  ground: Handle;
  output: Handle;
  poleFromPole: Handle;
  poleFromSupply: Handle;
  poleFromGround: Handle;
  groundFromPole: Handle;
  groundFromSupply: Handle;
  groundFromGround: Handle;
  groundFromOutput: Handle;
  supplyFromPole: Handle;
  supplyFromSupply: Handle;
  supplyFromGround: Handle;
  supplyFromOutput: Handle;
  outputFromPole: Handle;
  outputFromOutput: Handle;
};

/** The handles before the first stamp, which point nowhere yet. */
const UNSTAMPED: IteratedHandles = {
  pole: 0,
  supply: 0,
  ground: 0,
  output: 0,
  poleFromPole: 0,
  poleFromSupply: 0,
  poleFromGround: 0,
  groundFromPole: 0,
  groundFromSupply: 0,
  groundFromGround: 0,
  groundFromOutput: 0,
  supplyFromPole: 0,
  supplyFromSupply: 0,
  supplyFromGround: 0,
  supplyFromOutput: 0,
  outputFromPole: 0,
  outputFromOutput: 0,
};

/**
 * An LM386 audio power amplifier, as a behavioral model of its datasheet schematic. Each
 * input has 50 kΩ to GND and a follower that holds an emitter at its voltage: pin 1 for
 * +IN, and for −IN a node 150 Ω past pin 8, with 1.35 kΩ between pins 1 and 8. A 15 kΩ
 * feedback resistor runs from OUT to pin 1. The amplifier drives OUT until the current
 * into pin 1, less the current between the emitters, matches the current BYPASS would put
 * through another 15 kΩ: OUT then sits at BYPASS, half of VS, plus
 * 2 × 15 kΩ ÷ (150 Ω + 1.35 kΩ) = 20 times the input difference. Whatever sits across pins
 * 1 and 8 joins the 1.35 kΩ, so a capacitor there sets 200.
 *
 * The drive passes through a pole node, which sets the bandwidth and is clamped inside the
 * output swing, then a push-pull output stage with an output resistance and a current
 * limit that draws from VS when it sources and returns to GND when it sinks. The first
 * point is the body's top-left corner.
 */
export class AudioAmplifier extends CircuitElement {
  readonly kind = "audio-amplifier";
  readonly dumpType = "LS386";
  override readonly designatorPrefix = "U";
  protected override readonly usesExtendedFormat = true;
  readonly params = new ParamSet(AMPLIFIER_SPECS, AMPLIFIER_PRESETS);
  /** The capacitor on the pole node that sets the bandwidth. */
  readonly pole = new CompanionCapacitor(0);
  /** Current the output stage pushes into OUT, and the part of it VS supplies. */
  outputCurrent = 0;
  sourcedCurrent = 0;
  /** Current from VS to GND that runs the chip. */
  quiescentCurrent = 0;
  /** Current each follower takes from its emitter: pin 1's, then the inverting side's. */
  private readonly followerCurrents = [0, 0];
  /** The parameters each iteration reads, as `stamp` last read them. */
  private stage = {
    dropHigh: 0,
    dropLow: 0,
    rout: 1,
    ilimit: 1,
    /** The quiescent current less what the divider, feedback and output bias draw. */
    idle: 0,
  };

  /** Where each iteration stamps, as `stamp` last found it. */
  private handles = UNSTAMPED;

  /**
   * The voltages the last stamp linearized at and the currents it found there, so the next
   * can tell how far off its prediction was; `isLinearized` is false before the first.
   */
  private isLinearized = false;
  private readonly last = {
    pole: 0,
    supply: 0,
    ground: 0,
    drive: 0,
    clamp: 0,
    clampPole: 0,
    clampSupply: 0,
    clampGround: 0,
    output: 0,
    outputSlope: 0,
    sourced: 0,
    sourcedSlope: 0,
    quiescent: 0,
    quiescentSlope: 0,
  };

  /** Keeps the body `AMPLIFIER_SIZE` from the first point, whatever the second point says. */
  constructor(x1: number, y1: number, _x2: number, _y2: number, flags = 0) {
    super(x1, y1, x1 + AMPLIFIER_SIZE.width, y1 + AMPLIFIER_SIZE.height, flags);
  }

  static override read(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    flags: number,
    reader: TokenReader,
  ) {
    const amplifier = new AudioAmplifier(x1, y1, x2, y2, flags);

    amplifier.params.read(reader);

    return amplifier;
  }

  name() {
    return "Audio amplifier";
  }

  override valueLabel() {
    return this.params.modelName;
  }

  override posts(): Point[] {
    return AMPLIFIER_PINS.map(({ x, y }) => ({
      x: this.x1 + x,
      y: this.y1 + y,
    }));
  }

  /** Moves the body about its middle for a turn or flip, but keeps it upright. */
  override transform(map: (point: Point) => Point) {
    const center = map({
      x: this.x1 + AMPLIFIER_SIZE.width / 2,
      y: this.y1 + AMPLIFIER_SIZE.height / 2,
    });

    this.translate(
      snapToGrid(center.x - AMPLIFIER_SIZE.width / 2) - this.x1,
      snapToGrid(center.y - AMPLIFIER_SIZE.height / 2) - this.y1,
    );
  }

  override internalNodeCount() {
    return 2;
  }

  /** The two input followers. */
  override branchCount() {
    return 2;
  }

  override isNonlinear() {
    return true;
  }

  /** Every iteration checks the currents its last linearization predicted. */
  override hasExactConvergenceTest() {
    return true;
  }

  override stamp(system: MnaSystem) {
    const node = (index: number) => this.node(index);
    const ground = node(GROUND);
    const rin = this.params.get("rin");

    system.stampResistor(node(INVERTING), ground, rin);
    system.stampResistor(node(NON_INVERTING), ground, rin);
    system.stampResistor(node(OUTPUT), node(GAIN_1), FEEDBACK_RESISTANCE);
    system.stampResistor(node(GAIN_1), node(GAIN_8), GAIN_RESISTANCE);
    system.stampResistor(node(GAIN_8), node(EMITTER), EMITTER_RESISTANCE);
    system.stampResistor(node(SUPPLY), node(BYPASS), BIAS_RESISTANCE);
    system.stampResistor(node(BYPASS), ground, BIAS_RESISTANCE);
    this.stampFollower(system, 0, node(GAIN_1), node(NON_INVERTING));
    this.stampFollower(system, 1, node(EMITTER), node(INVERTING));

    // The error current leaves the pole node for GND: what pin 1's follower takes, less
    // what the inverting side's takes and what BYPASS would put through 15 kΩ to pin 1.
    // Too much feedback current so pulls the pole node, and with it OUT, down.
    const pole = node(POLE);
    const followerA = system.branchUnknown(this.firstBranch);
    const followerB = system.branchUnknown(this.firstBranch + 1);

    for (const [row, sign] of [
      [pole, -1],
      [ground, 1],
    ] as const) {
      system.stampMatrix(row, followerA, -sign);
      system.stampMatrix(row, followerB, sign);
      system.stampMatrix(row, node(BYPASS), sign / FEEDBACK_RESISTANCE);
      system.stampMatrix(row, node(GAIN_1), -sign / FEEDBACK_RESISTANCE);
    }

    // Loop gain is the pole node's resistance over the feedback resistor; its capacitor
    // puts the closed loop's pole at 1 / (2π × 15 kΩ × C), whatever the gain.
    system.stampResistor(pole, ground, LOOP_GAIN * FEEDBACK_RESISTANCE);
    this.pole.capacitance =
      1 / (2 * Math.PI * FEEDBACK_RESISTANCE * this.params.get("bw"));
    this.pole.stamp(system, pole, ground);

    this.stage = {
      dropHigh: this.params.get("dropHigh"),
      dropLow: this.params.get("dropLow"),
      rout: this.params.get("rout"),
      ilimit: this.params.get("ilimit"),
      // At 6 V the divider draws 0.2 mA, and the output sources 0.2 mA into the
      // feedback resistor on top of the pair's bias.
      idle: Math.max(
        0,
        this.params.get("iq") -
          QUIESCENT_SUPPLY / (2 * BIAS_RESISTANCE) -
          sourcedPart(QUIESCENT_SUPPLY / (2 * FEEDBACK_RESISTANCE)),
      ),
    };
    this.handles = {
      pole: system.rightSideRow(pole),
      supply: system.rightSideRow(node(SUPPLY)),
      ground: system.rightSideRow(ground),
      output: system.rightSideRow(node(OUTPUT)),
      poleFromPole: system.variableEntry(pole, pole),
      poleFromSupply: system.variableEntry(pole, node(SUPPLY)),
      poleFromGround: system.variableEntry(pole, ground),
      groundFromPole: system.variableEntry(ground, pole),
      groundFromSupply: system.variableEntry(ground, node(SUPPLY)),
      groundFromGround: system.variableEntry(ground, ground),
      groundFromOutput: system.variableEntry(ground, node(OUTPUT)),
      supplyFromPole: system.variableEntry(node(SUPPLY), pole),
      supplyFromSupply: system.variableEntry(node(SUPPLY), node(SUPPLY)),
      supplyFromGround: system.variableEntry(node(SUPPLY), ground),
      supplyFromOutput: system.variableEntry(node(SUPPLY), node(OUTPUT)),
      outputFromPole: system.variableEntry(node(OUTPUT), pole),
      outputFromOutput: system.variableEntry(node(OUTPUT), node(OUTPUT)),
    };
    this.isLinearized = false;
  }

  /**
   * Stamps follower `index`, which holds `emitter` at the voltage of `input` and passes
   * the current it takes from the emitter to GND.
   */
  private stampFollower(
    system: MnaSystem,
    index: number,
    emitter: number,
    input: number,
  ) {
    const row = system.branchUnknown(this.firstBranch + index);

    system.stampMatrix(row, emitter, 1);
    system.stampMatrix(row, input, -1);
    system.stampMatrix(emitter, row, 1);
    system.stampMatrix(this.node(GROUND), row, -1);
  }

  /** Backward Euler for the pole: it lies far above audio, so it should damp, not ring. */
  override startStep(system: MnaSystem) {
    this.pole.startStep(system, true);
  }

  override stampStep(system: MnaSystem) {
    const { volts, stage, last } = this;
    const pole = volts[POLE] ?? 0;
    const supply = volts[SUPPLY] ?? 0;
    const ground = volts[GROUND] ?? 0;
    const output = volts[OUTPUT] ?? 0;
    const drive = pole - output;

    // The clamps hold the pole node between GND + dropLow and VS − dropHigh.
    const high = softplus(pole - supply + stage.dropHigh);
    const low = softplus(ground + stage.dropLow - pole);
    const clamp = CLAMP_CONDUCTANCE * (high.value - low.value);
    const clampPole = CLAMP_CONDUCTANCE * (high.slope + low.slope);
    const clampSupply = -CLAMP_CONDUCTANCE * high.slope;
    const clampGround = -CLAMP_CONDUCTANCE * low.slope;

    // The output stage: ROUT for small currents, flattening out at the current limit.
    const ratio = Math.tanh(drive / (stage.ilimit * stage.rout));
    const current = stage.ilimit * ratio;
    const currentSlope = (1 - ratio * ratio) / stage.rout;
    // VS supplies what it sources, plus the bias through the pair; GND takes the rest.
    const sourced = sourcedPart(current);

    const sourcedSlope =
      ((1 + current / Math.hypot(current, 2 * OUTPUT_BIAS)) / 2) * currentSlope;

    // The quiescent current, which fades out as VS falls to GND.
    const headroom = Math.max(0, supply - ground);
    const running = Math.tanh(headroom / SUPPLY_KNEE);
    const quiescent = stage.idle * running;

    const quiescentSlope =
      headroom > 0 ? (stage.idle * (1 - running * running)) / SUPPLY_KNEE : 0;

    // Newton has not converged while a current misses what the last linearization said.
    if (
      !this.isLinearized ||
      mispredicts(
        clamp,
        last.clamp +
          last.clampPole * (pole - last.pole) +
          last.clampSupply * (supply - last.supply) +
          last.clampGround * (ground - last.ground),
      ) ||
      mispredicts(
        current,
        last.output + last.outputSlope * (drive - last.drive),
      ) ||
      mispredicts(
        sourced,
        last.sourced + last.sourcedSlope * (drive - last.drive),
      ) ||
      mispredicts(
        quiescent,
        last.quiescent +
          last.quiescentSlope * (supply - ground - last.supply + last.ground),
      )
    ) {
      system.converged = false;
    }

    this.isLinearized = true;
    last.pole = pole;
    last.supply = supply;
    last.ground = ground;
    last.drive = drive;
    last.clamp = clamp;
    last.clampPole = clampPole;
    last.clampSupply = clampSupply;
    last.clampGround = clampGround;
    last.output = current;
    last.outputSlope = currentSlope;
    last.sourced = sourced;
    last.sourcedSlope = sourcedSlope;
    last.quiescent = quiescent;
    last.quiescentSlope = quiescentSlope;

    // Each current is linearized: its slopes in the matrix, the rest as a source on the
    // right-hand side, from the pin it leaves to the pin it enters.
    const { handles } = this;
    const sunkSlope = currentSlope - sourcedSlope;

    // The clamps' current leaves the pole node for GND.
    system.addEntry(handles.poleFromPole, clampPole);
    system.addEntry(handles.groundFromPole, -clampPole);
    system.addEntry(handles.poleFromSupply, clampSupply);
    system.addEntry(handles.groundFromSupply, -clampSupply);
    system.addEntry(handles.poleFromGround, clampGround);
    system.addEntry(handles.groundFromGround, -clampGround);
    this.stampSource(
      system,
      handles.pole,
      handles.ground,
      clamp - clampPole * pole - clampSupply * supply - clampGround * ground,
    );

    // What VS sources leaves VS for OUT.
    system.addEntry(handles.supplyFromPole, sourcedSlope);
    system.addEntry(handles.outputFromPole, -sourcedSlope);
    system.addEntry(handles.supplyFromOutput, -sourcedSlope);
    system.addEntry(handles.outputFromOutput, sourcedSlope);
    this.stampSource(
      system,
      handles.supply,
      handles.output,
      sourced - sourcedSlope * pole + sourcedSlope * output,
    );

    // The rest of the output current leaves GND for OUT.
    system.addEntry(handles.groundFromPole, sunkSlope);
    system.addEntry(handles.outputFromPole, -sunkSlope);
    system.addEntry(handles.groundFromOutput, -sunkSlope);
    system.addEntry(handles.outputFromOutput, sunkSlope);
    this.stampSource(
      system,
      handles.ground,
      handles.output,
      current - sourced - sunkSlope * pole + sunkSlope * output,
    );

    // The quiescent current leaves VS for GND.
    system.addEntry(handles.supplyFromSupply, quiescentSlope);
    system.addEntry(handles.groundFromSupply, -quiescentSlope);
    system.addEntry(handles.supplyFromGround, -quiescentSlope);
    system.addEntry(handles.groundFromGround, quiescentSlope);
    this.stampSource(
      system,
      handles.supply,
      handles.ground,
      quiescent - quiescentSlope * supply + quiescentSlope * ground,
    );

    // Backward Euler's extra conductance for the pole capacitor.
    const { extraConductance } = this.pole;

    system.addEntry(handles.poleFromPole, extraConductance);
    system.addEntry(handles.groundFromGround, extraConductance);
    system.addEntry(handles.poleFromGround, -extraConductance);
    system.addEntry(handles.groundFromPole, -extraConductance);
    this.pole.stampStep(system);
    this.outputCurrent = current;
    this.sourcedCurrent = sourced;
    this.quiescentCurrent = quiescent;
  }

  /** Adds a current `value` that leaves the row `from` and enters the row `to`. */
  private stampSource(
    system: MnaSystem,
    from: Handle,
    to: Handle,
    value: number,
  ) {
    system.addRightSide(from, -value);
    system.addRightSide(to, value);
  }

  override setBranchCurrent(index: number, current: number) {
    this.followerCurrents[index] = current;
  }

  override finishStep(system: MnaSystem) {
    this.pole.finish(
      system,
      (this.volts[POLE] ?? 0) - (this.volts[GROUND] ?? 0),
    );
    this.current = this.outputCurrent;
  }

  override stampAc(system: AcSystem, omega: number) {
    this.pole.stampAc(system, this.node(POLE), this.node(GROUND), omega);
  }

  /** Returns the current from each pin's node into the chip, in post order. */
  private pinCurrents() {
    const volt = (index: number) => this.volts[index] ?? 0;
    const rin = this.params.get("rin");
    const [followerA = 0, followerB = 0] = this.followerCurrents;
    const feedback = (volt(OUTPUT) - volt(GAIN_1)) / FEEDBACK_RESISTANCE;
    const gain = (volt(GAIN_1) - volt(GAIN_8)) / GAIN_RESISTANCE;
    const upper = (volt(SUPPLY) - volt(BYPASS)) / BIAS_RESISTANCE;
    const lower = (volt(BYPASS) - volt(GROUND)) / BIAS_RESISTANCE;

    const currents = [
      followerA - feedback + gain,
      (volt(INVERTING) - volt(GROUND)) / rin,
      (volt(NON_INVERTING) - volt(GROUND)) / rin,
      0,
      feedback - this.outputCurrent,
      upper + this.sourcedCurrent + this.quiescentCurrent,
      lower - upper,
      followerB - gain,
    ];

    // GND returns what the other pins bring in.
    currents[GROUND] = -currents.reduce((total, value) => total + value, 0);

    return currents;
  }

  override currentIntoPost(post: number) {
    return this.pinCurrents()[post] ?? 0;
  }

  override reset() {
    super.reset();
    this.pole.reset();
    this.outputCurrent = 0;
    this.sourcedCurrent = 0;
    this.quiescentCurrent = 0;
    this.followerCurrents.fill(0);
    this.isLinearized = false;
  }

  override info() {
    const ground = this.volts[GROUND] ?? 0;
    const supply = (this.volts[SUPPLY] ?? 0) - ground;
    const vsmin = this.params.get("vsmin");
    const vsmax = this.params.get("vsmax");

    const lines = [
      this.title(),
      this.params.modelName,
      `VS = ${formatSi(supply, "V")}`,
      `Vout = ${formatSi((this.volts[OUTPUT] ?? 0) - ground, "V")}`,
      `Iout = ${formatSi(this.outputCurrent, "A")}`,
      `P = ${formatSi(this.power(), "W")}`,
    ];

    if (supply < vsmin || supply > vsmax) {
      lines.push(
        `VS is outside its ${formatSi(vsmin, "V")} to ${formatSi(vsmax, "V")} range.`,
      );
    }

    return lines;
  }

  override editFields(): EditField[] {
    return this.params.fields();
  }

  override dumpValues() {
    return this.params.dump();
  }
}
