import { CircuitElement, type EditField, type TokenReader } from "../element";
import { interpolate, type Point, snapToGrid } from "../geometry";
import type { MnaSystem } from "../mna-system";
import { ParamSet, type ParamSpec, type Preset } from "../params";
import { formatSi } from "../units";

// Linear regulators

/** Width of the corner where a regulator's output leaves dropout. */
const DROPOUT_SMOOTHING = 0.05;

/** Returns the smaller of `a` and `b` with a rounded corner, and its slope in `b`. */
function smoothMin(a: number, b: number) {
  const root = Math.sqrt((a - b) ** 2 + DROPOUT_SMOOTHING ** 2);

  return { value: (a + b - root) / 2, slope: (1 + (a - b) / root) / 2 };
}

/**
 * Returns a regulator's datasheet values. Adjustable regulators hold OUT a reference above ADJ
 * and source a small ADJ current; fixed ones hold OUT their rating above GND.
 */
function regulatorSpecs(isAdjustable: boolean): readonly ParamSpec[] {
  return [
    {
      key: "vout",
      label: isAdjustable ? "Reference voltage (OUT − ADJ)" : "Output voltage",
      unit: "V",
      fallback: isAdjustable ? 1.25 : 5,
      range: "positive",
      spiceNames: [],
      hint: isAdjustable
        ? "Vout = Vref × (1 + R2 / R1) + Iadj × R2, with R1 from OUT to ADJ."
        : undefined,
    },
    {
      key: "dropout",
      label: "Dropout voltage",
      unit: "V",
      fallback: 2,
      range: "nonnegative",
      spiceNames: [],
      hint: "How far the input must stay above the output.",
    },
    {
      key: "ilimit",
      label: "Current limit",
      unit: "A",
      fallback: 1.5,
      range: "positive",
      spiceNames: [],
    },
    {
      key: "rout",
      label: "Output resistance",
      unit: "Ω",
      fallback: 0.01,
      range: "positive",
      spiceNames: [],
      hint: "Load regulation: output change ÷ load current change.",
    },
    {
      key: "iq",
      label: isAdjustable ? "ADJ pin current" : "Ground pin current",
      unit: "A",
      fallback: isAdjustable ? 50e-6 : 5e-3,
      range: "nonnegative",
      spiceNames: [],
    },
  ];
}

/** Fixed regulator parts; `polarity` is 1 for positive and -1 for negative regulators. */
const FIXED_PRESETS: readonly Preset[] = [
  {
    name: "7805",
    polarity: 1,
    values: { vout: 5, dropout: 2, ilimit: 2.2, rout: 0.01, iq: 5e-3 },
  },
  {
    name: "7809",
    polarity: 1,
    values: { vout: 9, dropout: 2, ilimit: 2.2, rout: 0.012, iq: 5e-3 },
  },
  {
    name: "7812",
    polarity: 1,
    values: { vout: 12, dropout: 2, ilimit: 2.2, rout: 0.012, iq: 5e-3 },
  },
  {
    name: "7905",
    polarity: -1,
    values: { vout: 5, dropout: 1.1, ilimit: 2.1, rout: 0.01, iq: 3e-3 },
  },
  {
    name: "7912",
    polarity: -1,
    values: { vout: 12, dropout: 1.1, ilimit: 2.1, rout: 0.012, iq: 3e-3 },
  },
  {
    name: "LM1117-3.3 (LDO)",
    polarity: 1,
    values: { vout: 3.3, dropout: 1.1, ilimit: 1.2, rout: 0.005, iq: 5e-3 },
  },
  {
    name: "LM2940-5.0 (LDO)",
    polarity: 1,
    values: { vout: 5, dropout: 0.5, ilimit: 1.6, rout: 0.01, iq: 10e-3 },
  },
];

/** Adjustable regulator parts; `polarity` is 1 for positive and -1 for negative. */
const ADJUSTABLE_PRESETS: readonly Preset[] = [
  {
    name: "LM317",
    polarity: 1,
    values: { vout: 1.25, dropout: 1.7, ilimit: 2.2, rout: 0.005, iq: 50e-6 },
  },
  {
    name: "LM350",
    polarity: 1,
    values: { vout: 1.25, dropout: 1.7, ilimit: 4.5, rout: 0.005, iq: 50e-6 },
  },
  {
    name: "LM337",
    polarity: -1,
    values: { vout: 1.25, dropout: 2, ilimit: 2.2, rout: 0.005, iq: 65e-6 },
  },
  {
    name: "LM1117-ADJ (LDO)",
    polarity: 1,
    values: { vout: 1.25, dropout: 1.1, ilimit: 1.2, rout: 0.005, iq: 60e-6 },
  },
];

/** Slope left when the output sinks, as a fraction of 1 / ROUT. */
const REGULATOR_WEAK_SLOPE = 1e-3;

/** Slope left at the current limit, as a fraction of 1 / ROUT. */
const REGULATOR_LIMIT_SLOPE = 1e-5;

/**
 * A three-terminal linear regulator, fixed or adjustable. The output pass element pulls
 * current from IN to hold OUT at the set voltage above GND (or ADJ), within the dropout
 * and the current limit; the GND pin carries the quiescent current. Negative regulators
 * mirror every voltage. Posts are IN at the first point, OUT at the second and GND (or
 * ADJ) below the middle.
 */
export abstract class LinearRegulator extends CircuitElement {
  override readonly designatorPrefix = "U";
  override readonly mirrorFlag = 1;
  protected override readonly usesExtendedFormat = true;
  readonly params: ParamSet;
  /** 1 for a positive regulator, -1 for a negative one. */
  polarity = 1;
  outputCurrent = 0;
  pinCurrent = 0;
  /** Which piece of the output model applies: 0 regulating, 1 limiting, -1 sinking. */
  private region = 0;
  private lastError = 0;

  constructor(x1: number, y1: number, x2: number, y2: number, flags = 0) {
    super(x1, y1, x2, y2, flags);
    this.params = new ParamSet(
      regulatorSpecs(this.isAdjustable()),
      this.presets(),
    );
  }

  /** True when the third pin is ADJ rather than GND. */
  abstract isAdjustable(): boolean;

  /** Returns the parts the Part picker offers. */
  protected abstract presets(): readonly Preset[];

  /** Reads the polarity and model values after the flags. */
  protected readValues(reader: TokenReader) {
    this.polarity = reader.number(1) < 0 ? -1 : 1;
    this.params.read(reader);

    return this;
  }

  override valueLabel() {
    return this.params.modelName;
  }

  override posts(): Point[] {
    const flip = (this.flags & this.mirrorFlag) !== 0 ? -1 : 1;
    const middle = interpolate(this.start, this.end, 0.5, -32 * flip);

    return [
      this.start,
      this.end,
      { x: snapToGrid(middle.x), y: snapToGrid(middle.y) },
    ];
  }

  override isNonlinear() {
    return true;
  }

  override stampStep(system: MnaSystem) {
    const sign = this.polarity;
    const input = this.node(0);
    const output = this.node(1);
    const ground = this.node(2);
    const [vin = 0, vout = 0, vgnd = 0] = this.volts.map((volt) => sign * volt);
    const limit = this.params.get("ilimit");
    const conductance = 1 / this.params.get("rout");
    // Aim for the rating, or for the input minus the dropout when that is lower.
    const headroom = vin - vgnd - this.params.get("dropout");
    const target = smoothMin(this.params.get("vout"), headroom);
    const error = target.value + vgnd - vout;
    const drive = conductance * error;
    // Pick the piece: regulating through ROUT, at the current limit, or sinking.
    const region = drive > limit ? 1 : drive < 0 ? -1 : 0;
    // A piece change steps with the regulating piece first: jumping straight between the
    // two weak pieces overshoots and makes Newton's method cycle.
    const stamped = region === this.region ? region : 0;

    const weakSlope =
      stamped === 1 ? REGULATOR_LIMIT_SLOPE : REGULATOR_WEAK_SLOPE;

    const slope = stamped === 0 ? conductance : conductance * weakSlope;

    const current =
      stamped === 0
        ? drive
        : stamped === 1
          ? limit + (drive - limit) * weakSlope
          : drive * weakSlope;

    // Newton has not converged while the piece changes or the error moves over 0.1 mV.
    if (region !== this.region || Math.abs(error - this.lastError) > 1e-4) {
      system.converged = false;
    }

    this.region = region;
    this.lastError = error;

    // Linearize the pass element's current, IN to OUT, in each pin voltage.
    const dIn = slope * target.slope;
    const dGround = slope * (1 - target.slope);
    const dOut = -slope;

    const constant =
      sign * (current - dIn * vin - dGround * vgnd - dOut * vout);

    system.stampMatrix(input, input, dIn);
    system.stampMatrix(input, ground, dGround);
    system.stampMatrix(input, output, dOut);
    system.stampRightSide(input, -constant);
    system.stampMatrix(output, input, -dIn);
    system.stampMatrix(output, ground, -dGround);
    system.stampMatrix(output, output, -dOut);
    system.stampRightSide(output, constant);

    // Stamp the ground pin current, which fades out as the input falls to zero.
    const iq = this.params.get("iq");
    const supply = Math.tanh(Math.max(0, vin - vgnd) / 0.5);
    const pin = iq * supply;
    const dPin = vin > vgnd ? (iq * (1 - supply * supply)) / 0.5 : 0;
    const pinConstant = sign * (pin - dPin * (vin - vgnd));

    system.stampConductance(input, ground, dPin);
    system.stampCurrentSource(input, ground, pinConstant);
    this.outputCurrent = sign * current;
    this.pinCurrent = sign * pin;
  }

  override finishStep() {
    this.current = this.outputCurrent;
  }

  override currentIntoPost(post: number) {
    return (
      [
        this.outputCurrent + this.pinCurrent,
        -this.outputCurrent,
        -this.pinCurrent,
      ][post] ?? 0
    );
  }

  override reset() {
    super.reset();
    this.region = 0;
    this.lastError = 0;
    this.outputCurrent = 0;
    this.pinCurrent = 0;
  }

  override info() {
    const [vin = 0, vout = 0, vgnd = 0] = this.volts;

    return [
      this.title(),
      this.params.modelName,
      `Vin = ${formatSi(vin - vgnd, "V")}`,
      `Vout = ${formatSi(vout - vgnd, "V")}`,
      `Iout = ${formatSi(this.outputCurrent, "A")}`,
      `P = ${formatSi(this.power(), "W")}`,
    ];
  }

  override editFields(): EditField[] {
    const type: EditField = {
      kind: "choice",
      key: "polarity",
      label: "Type",
      value: this.polarity === 1 ? "positive" : "negative",
      options: [
        { value: "positive", label: "Positive" },
        { value: "negative", label: "Negative" },
      ],
      set: (value) => {
        this.polarity = value === "negative" ? -1 : 1;
      },
    };

    const fields = this.params.fields(undefined, (name) => {
      this.polarity = this.params.applyPreset(name)?.polarity ?? this.polarity;
    });

    return [type, ...fields];
  }

  override dumpValues() {
    return [this.polarity, ...this.params.dump()];
  }
}

/** A fixed regulator such as the 7805: OUT sits its rated voltage above GND. */
export class FixedRegulator extends LinearRegulator {
  readonly kind = "regulator";
  readonly dumpType = "LSREG";

  static override read(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    flags: number,
    reader: TokenReader,
  ) {
    return new FixedRegulator(x1, y1, x2, y2, flags).readValues(reader);
  }

  isAdjustable() {
    return false;
  }

  protected presets() {
    return FIXED_PRESETS;
  }

  name() {
    return this.polarity === 1
      ? "Voltage regulator"
      : "Negative voltage regulator";
  }
}

/**
 * An adjustable regulator such as the LM317: OUT sits a reference above ADJ, so two
 * resistors set the output.
 */
export class AdjustableRegulator extends LinearRegulator {
  readonly kind = "adjustable-regulator";
  readonly dumpType = "LSADJ";

  static override read(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    flags: number,
    reader: TokenReader,
  ) {
    return new AdjustableRegulator(x1, y1, x2, y2, flags).readValues(reader);
  }

  isAdjustable() {
    return true;
  }

  protected presets() {
    return ADJUSTABLE_PRESETS;
  }

  name() {
    return this.polarity === 1
      ? "Adjustable regulator"
      : "Negative adjustable regulator";
  }
}

// 555 timer

/** The 555's pins in the order of its posts and nodes. */
export const TIMER_PINS = [
  { name: "VCC", number: 8, x: 16, y: -16 },
  { name: "RST", number: 4, x: 48, y: -16 },
  { name: "DIS", number: 7, x: -16, y: 16 },
  { name: "THR", number: 6, x: -16, y: 48 },
  { name: "TRIG", number: 2, x: -16, y: 80 },
  { name: "OUT", number: 3, x: 80, y: 48 },
  { name: "CV", number: 5, x: 48, y: 112 },
  { name: "GND", number: 1, x: 16, y: 112 },
] as const;

/** Width and height of the 555's body, from its first point. */
export const TIMER_SIZE = { width: 64, height: 96 } as const;

// Indexes of the 555's posts and nodes, in `TIMER_PINS` order.
const VCC = 0;

const RESET = 1;

const DISCHARGE = 2;

const THRESHOLD = 3;

const TRIGGER = 4;

const OUTPUT = 5;

const CONTROL = 6;

const GROUND = 7;

/** Internal node: the output driver before its output resistance. */
const DRIVER = 8;

/** Internal node: the lower tap of the 5 kΩ divider. */
const LOWER_TAP = 9;

const TIMER_SPECS: readonly ParamSpec[] = [
  {
    key: "highdrop",
    label: "Output high drop below VCC",
    unit: "V",
    fallback: 1.7,
    range: "nonnegative",
    spiceNames: [],
  },
  {
    key: "lowvoltage",
    label: "Output low voltage",
    unit: "V",
    fallback: 0.1,
    range: "nonnegative",
    spiceNames: [],
  },
  {
    key: "rout",
    label: "Output resistance",
    unit: "Ω",
    fallback: 10,
    range: "positive",
    spiceNames: [],
  },
  {
    key: "rdis",
    label: "Discharge on-resistance",
    unit: "Ω",
    fallback: 15,
    range: "positive",
    spiceNames: [],
  },
  {
    key: "divider",
    label: "Divider resistors",
    unit: "Ω",
    fallback: 5000,
    range: "positive",
    spiceNames: [],
    hint: "Each of the three resistors that set the 1/3 and 2/3 VCC thresholds.",
  },
  {
    key: "icc",
    label: "Supply current at 5 V",
    unit: "A",
    fallback: 3e-3,
    range: "positive",
    spiceNames: [],
  },
];

const TIMER_PRESETS: readonly Preset[] = [
  {
    name: "NE555",
    values: {
      highdrop: 1.7,
      lowvoltage: 0.1,
      rout: 10,
      rdis: 15,
      divider: 5000,
      icc: 3e-3,
    },
  },
  {
    name: "TLC555 (CMOS)",
    values: {
      highdrop: 0.2,
      lowvoltage: 0.05,
      rout: 25,
      rdis: 20,
      divider: 50_000,
      icc: 1.7e-4,
    },
  },
  {
    name: "ICM7555 (CMOS)",
    values: {
      highdrop: 0.3,
      lowvoltage: 0.1,
      rout: 30,
      rdis: 25,
      divider: 100_000,
      icc: 6e-5,
    },
  },
];

/** Reset pin voltage above GND below which the output is forced low. */
const RESET_THRESHOLD = 0.7;

/**
 * A 555 timer: the three-resistor divider, the threshold and trigger comparators, the
 * flip-flop, the output driver and the discharge transistor. The flip-flop flips at most
 * once per time step. RST has no pull-up, as on the real chip, so tie it to VCC. The
 * first point is the body's top-left corner.
 */
export class Timer555 extends CircuitElement {
  readonly kind = "timer";
  readonly dumpType = "LS555";
  override readonly designatorPrefix = "U";
  protected override readonly usesExtendedFormat = true;
  readonly params = new ParamSet(TIMER_SPECS, TIMER_PRESETS);
  /** The flip-flop: true while the output is high. */
  isOutputHigh = false;
  /** Current into DIS while the discharge transistor is on. */
  dischargeCurrent = 0;
  private hasFlipped = false;

  /** Keeps the body `TIMER_SIZE` from the first point, whatever the second point says. */
  constructor(x1: number, y1: number, _x2: number, _y2: number, flags = 0) {
    super(x1, y1, x1 + TIMER_SIZE.width, y1 + TIMER_SIZE.height, flags);
  }

  static override read(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    flags: number,
    reader: TokenReader,
  ) {
    const timer = new Timer555(x1, y1, x2, y2, flags);

    timer.isOutputHigh = reader.number(0) !== 0;
    timer.params.read(reader);

    return timer;
  }

  name() {
    return "555 timer";
  }

  override valueLabel() {
    return this.params.modelName;
  }

  override posts(): Point[] {
    return TIMER_PINS.map(({ x, y }) => ({ x: this.x1 + x, y: this.y1 + y }));
  }

  /** Moves the body about its middle for a turn or flip, but keeps it upright. */
  override transform(map: (point: Point) => Point) {
    const center = map({
      x: this.x1 + TIMER_SIZE.width / 2,
      y: this.y1 + TIMER_SIZE.height / 2,
    });

    this.translate(
      snapToGrid(center.x - TIMER_SIZE.width / 2) - this.x1,
      snapToGrid(center.y - TIMER_SIZE.height / 2) - this.y1,
    );
  }

  override internalNodeCount() {
    return 2;
  }

  override branchCount() {
    return 1;
  }

  override isNonlinear() {
    return true;
  }

  override stamp(system: MnaSystem) {
    // Stamp the divider from VCC through CV and the lower tap to GND.
    const divider = this.params.get("divider");

    system.stampResistor(this.node(VCC), this.node(CONTROL), divider);
    system.stampResistor(this.node(CONTROL), this.node(LOWER_TAP), divider);
    system.stampResistor(this.node(LOWER_TAP), this.node(GROUND), divider);
    // Draw the rest of the supply current through a resistance sized at 5 V.
    system.stampResistor(
      this.node(VCC),
      this.node(GROUND),
      5 / Math.max(1e-9, this.params.get("icc") - 5 / (3 * divider)),
    );
    system.stampResistor(
      this.node(DRIVER),
      this.node(OUTPUT),
      this.params.get("rout"),
    );
  }

  override startStep() {
    this.hasFlipped = false;
  }

  /** Returns the flip-flop state the pins call for: reset, then trigger, then threshold. */
  private desiredState() {
    const volt = (pin: number) =>
      (this.volts[pin] ?? 0) - (this.volts[GROUND] ?? 0);

    if (volt(RESET) < RESET_THRESHOLD) {
      return false;
    }

    if (volt(TRIGGER) < volt(LOWER_TAP)) {
      return true;
    }

    if (volt(THRESHOLD) > volt(CONTROL)) {
      return false;
    }

    return this.isOutputHigh;
  }

  override stampStep(system: MnaSystem) {
    const desired = this.desiredState();

    // Flip the flip-flop at most once per time step.
    if (desired !== this.isOutputHigh && !this.hasFlipped) {
      this.isOutputHigh = desired;
      this.hasFlipped = true;
      system.converged = false;
    }

    // The driver sits a fixed drop below VCC when high, or above GND when low.
    if (this.isOutputHigh) {
      system.stampVoltageSource(
        this.node(VCC),
        this.node(DRIVER),
        this.firstBranch,
        -this.params.get("highdrop"),
      );
    } else {
      system.stampVoltageSource(
        this.node(GROUND),
        this.node(DRIVER),
        this.firstBranch,
        this.params.get("lowvoltage"),
      );
      system.stampResistor(
        this.node(DISCHARGE),
        this.node(GROUND),
        this.params.get("rdis"),
      );
    }
  }

  override finishStep() {
    const [, , discharge = 0] = this.volts;
    const ground = this.volts[GROUND] ?? 0;

    this.dischargeCurrent = this.isOutputHigh
      ? 0
      : (discharge - ground) / this.params.get("rdis");
  }

  /** Returns the current out of OUT into the load. */
  outputCurrent() {
    return (
      ((this.volts[DRIVER] ?? 0) - (this.volts[OUTPUT] ?? 0)) /
      this.params.get("rout")
    );
  }

  override currentIntoPost(post: number) {
    if (post === OUTPUT) {
      return -this.outputCurrent();
    }

    if (post === DISCHARGE) {
      return this.dischargeCurrent;
    }

    if (post === VCC || post === GROUND) {
      // Supply current: what the outputs and divider draw, flowing VCC to GND.
      const supply =
        ((this.volts[VCC] ?? 0) - (this.volts[GROUND] ?? 0)) /
          (3 * this.params.get("divider")) +
        (this.isOutputHigh ? this.outputCurrent() : 0);

      const sink =
        supply +
        this.dischargeCurrent -
        (this.isOutputHigh ? 0 : this.outputCurrent());

      return post === VCC ? supply : -sink;
    }

    return 0;
  }

  override reset() {
    super.reset();
    this.isOutputHigh = false;
    this.dischargeCurrent = 0;
  }

  override info() {
    const ground = this.volts[GROUND] ?? 0;

    const lines = [
      this.title(),
      this.params.modelName,
      `Output ${this.isOutputHigh ? "high" : "low"}`,
      `VCC = ${formatSi((this.volts[VCC] ?? 0) - ground, "V")}`,
      `Vout = ${formatSi((this.volts[OUTPUT] ?? 0) - ground, "V")}`,
    ];

    if ((this.volts[RESET] ?? 0) - ground < RESET_THRESHOLD) {
      lines.push("RST is low: tie it to VCC to run.");
    }

    return lines;
  }

  override editFields(): EditField[] {
    return this.params.fields();
  }

  override dumpValues() {
    return [this.isOutputHigh ? 1 : 0, ...this.params.dump()];
  }
}
