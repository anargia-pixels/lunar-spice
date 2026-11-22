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
import { Bjt, Diode } from "./semiconductors";

// Shared package: an input LED lighting an output across the isolation gap

/** Width and height of an optocoupler's or vactrol's body, from its first point. */
export const COUPLER_SIZE = { width: 64, height: 64 } as const;

/**
 * Where each pin sits from the body's top-left corner, in post order: the LED's anode
 * and cathode on the left, the output's two pins on the right.
 */
export const COUPLER_PIN_OFFSETS = [
  { x: -16, y: 16 },
  { x: -16, y: 48 },
  { x: 80, y: 16 },
  { x: 80, y: 48 },
] as const;

// Indexes of the posts, in `COUPLER_PIN_OFFSETS` order.
const ANODE = 0;

const CATHODE = 1;

const OUTPUT_A = 2;

const OUTPUT_B = 3;

/** The first internal node, after the posts: the phototransistor's base, if any. */
const FIRST_INTERNAL = COUPLER_PIN_OFFSETS.length;

/** Light below this LED current counts as dark, where the cell's slope is not defined. */
const MIN_LIGHT = 1e-15;

/** The input LED's datasheet values; every coupler starts with these three. */
const LED_SPECS: readonly ParamSpec[] = [
  {
    key: "is",
    label: "LED saturation current (IS)",
    unit: "A",
    fallback: 1e-15,
    range: "positive",
    spiceNames: ["is"],
  },
  {
    key: "n",
    label: "LED emission coefficient (N)",
    unit: "",
    fallback: 1.6,
    range: "positive",
    spiceNames: ["n"],
  },
  {
    key: "rs",
    label: "LED series resistance (RS)",
    unit: "Ω",
    fallback: 1,
    range: "nonnegative",
    spiceNames: ["rs"],
  },
];

/** Returns how far a first-order lag of `timeConstant` moves toward its input in one step. */
function lagBlend(timeStep: number, timeConstant: number) {
  return timeConstant > 0 ? timeStep / (timeConstant + timeStep) : 1;
}

/**
 * Stamps a current from node `a` into `b` of `slope` × (V(p) − V(n)) into the iteration's
 * matrix.
 */
function stampControlledCurrent(
  system: MnaSystem,
  a: number,
  b: number,
  p: number,
  n: number,
  slope: number,
) {
  system.stampMatrix(a, p, slope);
  system.stampMatrix(a, n, -slope);
  system.stampMatrix(b, p, -slope);
  system.stampMatrix(b, n, slope);
}

/**
 * Lets a controlled current `slope` × (V(p) − V(n)) from `a` into `b`, which the
 * operating point stamped at full strength, roll off above 1 / (2π × `timeConstant`), as
 * light follows the LED with a lag.
 */
function stampLagAc(
  system: AcSystem,
  [a, b, p, n]: readonly [number, number, number, number],
  slope: number,
  omega: number,
  timeConstant: number,
) {
  const phase = omega * timeConstant;
  const denominator = 1 + phase * phase;
  // slope / (1 + jωτ) − slope, which the operating matrix already holds.
  const real = (-slope * phase * phase) / denominator;
  const imag = (-slope * phase) / denominator;

  for (const [row, column, sign] of [
    [a, p, 1],
    [a, n, -1],
    [b, p, -1],
    [b, n, 1],
  ] as const) {
    system.stampReal(row, column, sign * real);
    system.stampImaginary(row, column, sign * imag);
  }
}

/**
 * A four-pin package whose input LED lights an output across an isolation gap: an
 * optocoupler or a vactrol. The LED is the diode model on A and K; the output follows
 * the LED's current. It keeps upright with its first point at the body's top-left
 * corner, as the 555 does.
 */
abstract class LedCoupler extends CircuitElement {
  override readonly designatorPrefix = "U";
  protected override readonly usesExtendedFormat = true;
  abstract readonly params: ParamSet;
  /** The input LED, stamped on A and K. */
  protected readonly led = new Diode(0, 0, 0, 0);

  /** Keeps the body `COUPLER_SIZE` from the first point, whatever the second says. */
  constructor(x1: number, y1: number, _x2: number, _y2: number, flags = 0) {
    super(x1, y1, x1 + COUPLER_SIZE.width, y1 + COUPLER_SIZE.height, flags);
  }

  /** Names of the pins in post order, as the body is labeled. */
  abstract pinNames(): readonly string[];

  /** Internal nodes the output needs; they come first, before the LED's. */
  protected abstract outputNodeCount(): number;

  /** Stamps the output for one iteration, after the LED has linearized. */
  protected abstract stampOutput(system: MnaSystem): void;

  override valueLabel() {
    return this.params.modelName;
  }

  override posts(): Point[] {
    return COUPLER_PIN_OFFSETS.map(({ x, y }) => ({
      x: this.x1 + x,
      y: this.y1 + y,
    }));
  }

  /** Moves the body about its middle for a turn or flip, but keeps it upright. */
  override transform(map: (point: Point) => Point) {
    const center = map({
      x: this.x1 + COUPLER_SIZE.width / 2,
      y: this.y1 + COUPLER_SIZE.height / 2,
    });

    this.translate(
      snapToGrid(center.x - COUPLER_SIZE.width / 2) - this.x1,
      snapToGrid(center.y - COUPLER_SIZE.height / 2) - this.y1,
    );
  }

  override internalNodeCount() {
    return this.outputNodeCount() + (this.params.get("rs") > 0 ? 1 : 0);
  }

  override isNonlinear() {
    return true;
  }

  /** Returns the index in `nodes` of the LED's node past RS. */
  private ledInternalIndex() {
    return FIRST_INTERNAL + this.outputNodeCount();
  }

  /** Copies the package's voltages into the LED, which reads its own `volts`. */
  protected syncLedVolts() {
    const { volts } = this.led;

    volts[0] = this.volts[ANODE] ?? 0;
    volts[1] = this.volts[CATHODE] ?? 0;

    if (this.led.nodes.length > 2) {
      volts[2] = this.volts[this.ledInternalIndex()] ?? 0;
    }
  }

  /** The LED junction's anode-side node and the cathode: what the output follows. */
  protected ledControl(): readonly [number, number] {
    return [this.led.node(this.led.junctionIndex()), this.node(CATHODE)];
  }

  /**
   * The light at the latest iteration as an LED current, and its slope in the LED's
   * junction voltage: the LED's forward current, dark when it is reverse biased.
   */
  protected ledLight() {
    const { linearCurrent, linearConductance } = this.led;

    return linearCurrent > 0
      ? { light: linearCurrent, slope: linearConductance }
      : { light: 0, slope: 0 };
  }

  override stamp(system: MnaSystem) {
    const { led } = this;

    for (const key of ["is", "n", "rs"]) {
      led.params.set(key, this.params.get(key));
    }

    led.params.set("bv", 0);
    led.params.set("cjo", 0);
    led.nodes =
      this.params.get("rs") > 0
        ? [
            this.node(ANODE),
            this.node(CATHODE),
            this.node(this.ledInternalIndex()),
          ]
        : [this.node(ANODE), this.node(CATHODE)];
    led.volts = led.nodes.map(() => 0);
    led.stamp(system);
  }

  override startStep(system: MnaSystem) {
    this.led.startStep(system);
  }

  override stampStep(system: MnaSystem) {
    this.syncLedVolts();
    this.led.stampStep(system);
    this.stampOutput(system);
  }

  override finishStep(system: MnaSystem) {
    this.syncLedVolts();
    this.led.finishStep(system);
    this.current = this.led.current;
  }

  override stampAc(system: AcSystem, omega: number) {
    this.led.stampAc(system, omega);
  }

  override currentIntoPost(post: number) {
    if (post === ANODE) {
      return this.led.current;
    }

    return post === CATHODE ? -this.led.current : 0;
  }

  override reset() {
    super.reset();
    this.led.reset();
  }

  override editFields(): EditField[] {
    return this.params.fields();
  }

  override dumpValues(): (string | number)[] {
    return this.params.dump();
  }
}

// Optocoupler

const OPTOCOUPLER_SPECS: readonly ParamSpec[] = [
  ...LED_SPECS,
  {
    key: "ctr",
    label: "Current transfer ratio (CTR)",
    unit: "%",
    fallback: 100,
    range: "positive",
    spiceNames: [],
    hint: "Collector current ÷ LED current with the transistor out of saturation.",
  },
  {
    key: "bf",
    label: "Phototransistor gain (hFE)",
    unit: "",
    fallback: 400,
    range: "positive",
    spiceNames: ["bf"],
  },
  {
    key: "br",
    label: "Phototransistor reverse gain (BR)",
    unit: "",
    fallback: 0.45,
    range: "positive",
    spiceNames: ["br"],
    hint: "Sets VCE(sat): lower raises it.",
  },
  {
    key: "tr",
    label: "Rise time (10–90 %)",
    unit: "s",
    fallback: 4e-6,
    range: "nonnegative",
    spiceNames: [],
    hint: "How fast the light, and so the collector current, follows the LED.",
  },
];

/**
 * Optocoupler parts. Each LED's IS is fitted to the datasheet's typical forward voltage
 * with its N and RS; BR puts VCE(sat) at the datasheet's typical value.
 */
const OPTOCOUPLER_PRESETS: readonly Preset[] = [
  {
    // VF 1.2 V at 20 mA; CTR 50–600 % by rank; tr 4 µs; VCE(sat) 0.1 V at 20 mA, 1 mA.
    name: "PC817",
    values: {
      is: 8.276e-15,
      n: 1.6,
      rs: 1,
      ctr: 100,
      bf: 400,
      br: 0.45,
      tr: 4e-6,
    },
  },
  {
    // VF 1.3 V at 10 mA; CTR 100 % min at 10 mA; switching 10 µs.
    name: "4N35",
    values: {
      is: 2.9e-16,
      n: 1.6,
      rs: 1,
      ctr: 100,
      bf: 400,
      br: 0.45,
      tr: 1e-5,
    },
  },
];

/** Saturation current of the phototransistor, which only sets its VBE. */
const PHOTOTRANSISTOR_IS = 1e-14;

/** Relative change in the photocurrent within which Newton has converged. */
const LIGHT_RELTOL = 1e-3;

/**
 * An optocoupler with a phototransistor output, such as the PC817: the LED on A and K,
 * the NPN on C and E. The LED's light drives a photocurrent from the collector into the
 * transistor's base, sized so the collector carries CTR × the LED current; the
 * transistor saturates as the Ebers–Moll model does. The light follows the LED with a
 * first-order lag set by the rise time.
 */
export class Optocoupler extends LedCoupler {
  readonly kind = "optocoupler";
  readonly dumpType = "LSOPTO";
  readonly params = new ParamSet(OPTOCOUPLER_SPECS, OPTOCOUPLER_PRESETS);
  /** The output transistor; its base is internal, lit by the photocurrent. */
  private readonly transistor = new Bjt(0, 0, 0, 0);
  /** The photocurrent at the latest iteration, collector to base. */
  photoCurrent = 0;
  /** The photocurrent at the end of the step before. */
  private heldPhotoCurrent = 0;
  /** The photocurrent's slope in the LED junction voltage, at the latest iteration. */
  private photoSlope = 0;
  /** How far the light moves toward the LED's current in one step. */
  private blend = 1;

  static override read(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    flags: number,
    reader: TokenReader,
  ) {
    const coupler = new Optocoupler(x1, y1, x2, y2, flags);

    coupler.params.read(reader);

    return coupler;
  }

  name() {
    return "Optocoupler";
  }

  pinNames() {
    return ["A", "K", "C", "E"];
  }

  protected outputNodeCount() {
    return 1;
  }

  /** The light's time constant: a first-order lag rises from 10 % to 90 % in τ × ln 9. */
  private timeConstant() {
    return this.params.get("tr") / Math.log(9);
  }

  /** Photocurrent per ampere of LED current, so the collector carries CTR × IF. */
  private photoGain() {
    return this.params.get("ctr") / 100 / (this.params.get("bf") + 1);
  }

  /** The base node, the collector and the emitter. */
  private transistorNodes() {
    return [
      this.node(FIRST_INTERNAL),
      this.node(OUTPUT_A),
      this.node(OUTPUT_B),
    ] as const;
  }

  private syncTransistorVolts() {
    const { volts } = this.transistor;

    volts[0] = this.volts[FIRST_INTERNAL] ?? 0;
    volts[1] = this.volts[OUTPUT_A] ?? 0;
    volts[2] = this.volts[OUTPUT_B] ?? 0;
  }

  override stamp(system: MnaSystem) {
    super.stamp(system);

    const { transistor } = this;

    transistor.polarity = 1;
    transistor.params.applyValues({
      is: PHOTOTRANSISTOR_IS,
      bf: this.params.get("bf"),
      br: this.params.get("br"),
    });
    transistor.nodes = [...this.transistorNodes()];
    transistor.volts = [0, 0, 0];
    transistor.stamp(system);
  }

  override startStep(system: MnaSystem) {
    super.startStep(system);
    this.transistor.startStep(system);
    this.blend = lagBlend(system.timeStep, this.timeConstant());
  }

  protected stampOutput(system: MnaSystem) {
    this.syncTransistorVolts();
    this.transistor.stampStep(system);

    // The operating point has no time, so its light has settled.
    const isSettled = system.mode === "dc";
    const blend = isSettled ? 1 : this.blend;
    const held = isSettled ? 0 : (1 - blend) * this.heldPhotoCurrent;
    const gain = this.photoGain();
    const { light, slope } = this.ledLight();
    const photo = held + blend * gain * light;
    const photoSlope = blend * gain * slope;
    const [base, collector] = this.transistorNodes();
    const [anode, cathode] = this.ledControl();

    // Newton has not converged while the photocurrent still moves.
    if (
      Math.abs(photo - this.photoCurrent) >
      LIGHT_RELTOL * Math.abs(photo) + 1e-12
    ) {
      system.converged = false;
    }

    this.photoCurrent = photo;
    this.photoSlope = photoSlope;

    // The photocurrent, linearized in the LED's junction voltage.
    system.stampCurrentSource(
      collector,
      base,
      photo - photoSlope * this.led.linearVoltage,
    );
    stampControlledCurrent(system, collector, base, anode, cathode, photoSlope);
  }

  override finishStep(system: MnaSystem) {
    super.finishStep(system);
    this.syncTransistorVolts();
    this.transistor.finishStep(system);
    this.heldPhotoCurrent = this.photoCurrent;
  }

  override stampAc(system: AcSystem, omega: number) {
    super.stampAc(system, omega);
    this.transistor.stampAc(system, omega);

    const [base, collector] = this.transistorNodes();
    const [anode, cathode] = this.ledControl();

    stampLagAc(
      system,
      [collector, base, anode, cathode],
      this.photoSlope,
      omega,
      this.timeConstant(),
    );
  }

  /** Returns the current into the collector: the transistor's and the photocurrent. */
  collectorCurrent() {
    return this.transistor.currentIntoPost(1) + this.photoCurrent;
  }

  override currentIntoPost(post: number) {
    if (post === OUTPUT_A) {
      return this.collectorCurrent();
    }

    if (post === OUTPUT_B) {
      return this.transistor.currentIntoPost(2);
    }

    return super.currentIntoPost(post);
  }

  override reset() {
    super.reset();
    this.transistor.reset();
    this.photoCurrent = 0;
    this.heldPhotoCurrent = 0;
    this.photoSlope = 0;
  }

  override info() {
    const [, , vc = 0, ve = 0] = this.volts;

    return [
      this.title(),
      this.params.modelName,
      `IF = ${formatSi(this.led.current, "A")}`,
      `IC = ${formatSi(this.collectorCurrent(), "A")}`,
      `VCE = ${formatSi(vc - ve, "V")}`,
      `P = ${formatSi(this.power(), "W")}`,
    ];
  }
}

// Vactrol

const VACTROL_SPECS: readonly ParamSpec[] = [
  ...LED_SPECS,
  {
    key: "r1",
    label: "Cell resistance at 1 mA",
    unit: "Ω",
    fallback: 10_000,
    range: "positive",
    spiceNames: [],
  },
  {
    key: "r10",
    label: "Cell resistance at 10 mA",
    unit: "Ω",
    fallback: 1000,
    range: "positive",
    spiceNames: [],
  },
  {
    key: "r40",
    label: "Cell resistance at 40 mA",
    unit: "Ω",
    fallback: 500,
    range: "positive",
    spiceNames: [],
    hint: "The cell's resistance follows a straight line through these three on log–log axes.",
  },
  {
    key: "rdark",
    label: "Dark resistance",
    unit: "Ω",
    fallback: 10e6,
    range: "positive",
    spiceNames: [],
  },
  {
    key: "ton",
    label: "Turn-on time (to 63 %)",
    unit: "s",
    fallback: 2.5e-3,
    range: "nonnegative",
    spiceNames: [],
    hint: "The light's time constant as the LED current rises.",
  },
  {
    key: "toff",
    label: "Turn-off time (to 100 kΩ)",
    unit: "s",
    fallback: 35e-3,
    range: "nonnegative",
    spiceNames: [],
    hint: "How long the cell takes to reach 100 kΩ after 10 mA is switched off.",
  },
];

/**
 * Vactrol parts from the Excelitas (PerkinElmer) VTL5C datasheets. Their red LED's IS is
 * fitted to 1.65 V at 20 mA with its N and RS.
 */
const VACTROL_PRESETS: readonly Preset[] = [
  {
    name: "VTL5C3",
    values: {
      is: 6.955e-17,
      n: 1.8,
      rs: 5,
      r1: 10_000,
      r10: 1000,
      r40: 500,
      rdark: 10e6,
      ton: 2.5e-3,
      toff: 35e-3,
    },
  },
  {
    name: "VTL5C4",
    values: {
      is: 6.955e-17,
      n: 1.8,
      rs: 5,
      r1: 1200,
      r10: 125,
      r40: 75,
      rdark: 400e3,
      ton: 6e-3,
      toff: 1.5,
    },
  },
];

/** LED current at which the cell's curve changes slope, and the datasheet's turn-off test. */
const KNEE_CURRENT = 0.01;

/** Cell resistance the datasheet's turn-off time runs to. */
const TURN_OFF_RESISTANCE = 100e3;

/**
 * A vactrol, such as the VTL5C3: an LED lighting a photoresistor (LDR) cell. The cell's
 * conductance is the dark conductance plus a power of the light, one power below 10 mA
 * and another above it, through the datasheet's resistances at 1, 10 and 40 mA. The light
 * follows the LED current quickly as it rises and slowly as it falls, as a photocell
 * does: the turn-on time is its time constant, and the turn-off time is how long it takes
 * from 10 mA until the cell reaches 100 kΩ.
 */
export class Vactrol extends LedCoupler {
  readonly kind = "vactrol";
  readonly dumpType = "LSVAC";
  readonly params = new ParamSet(VACTROL_SPECS, VACTROL_PRESETS);
  /** The light as an LED current at the latest iteration, and at the end of the step before. */
  light = 0;
  private heldLight = 0;
  /** The cell's conductance at the latest iteration. */
  conductance = 0;
  /**
   * The cell current's slope in the LED junction voltage at the latest iteration, and
   * the junction voltage it was taken at.
   */
  private controlSlope = 0;
  private controlVoltage = 0;
  /** How far the light moves toward the LED current in one step, rising or falling. */
  private riseBlend = 1;
  private fallBlend = 1;
  /** The curve's powers below and above `KNEE_CURRENT`, worked out in `stamp`. */
  private lowPower = 1;
  private highPower = 1;
  /**
   * The values each iteration reads, as `stamp` last worked them out: the dark
   * conductance, the conductance at `KNEE_CURRENT` above it, and the light's rise and
   * fall time constants.
   */
  private darkConductance = 0;
  private kneeConductance = 0;
  private riseTime = 0;
  private fallTime = 0;
  /**
   * Where the cell stamps: the rows of its pins A and B, and in them each pin and the
   * LED's two control nodes.
   */
  private rowA: Handle = 0;
  private rowB: Handle = 0;
  private aFromA: Handle = 0;
  private aFromB: Handle = 0;
  private bFromA: Handle = 0;
  private bFromB: Handle = 0;
  private aFromAnode: Handle = 0;
  private aFromCathode: Handle = 0;
  private bFromAnode: Handle = 0;
  private bFromCathode: Handle = 0;

  static override read(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    flags: number,
    reader: TokenReader,
  ) {
    const vactrol = new Vactrol(x1, y1, x2, y2, flags);

    vactrol.params.read(reader);

    return vactrol;
  }

  name() {
    return "Vactrol";
  }

  pinNames() {
    return ["A", "K", "", ""];
  }

  protected outputNodeCount() {
    return 0;
  }

  /** The LED and the cell both test their predicted currents. */
  override hasExactConvergenceTest() {
    return true;
  }

  /**
   * Returns the cell's conductance at `light`, an LED current, and its slope in it, with
   * the values `stamp` worked out.
   */
  cellConductance(light: number) {
    const dark = this.darkConductance;

    if (light <= MIN_LIGHT) {
      return { conductance: dark, slope: 0 };
    }

    const power = light <= KNEE_CURRENT ? this.lowPower : this.highPower;
    const lit = (light / KNEE_CURRENT) ** power * this.kneeConductance;

    return { conductance: dark + lit, slope: (power * lit) / light };
  }

  /**
   * The light's time constant as it falls: a fall from 10 mA reaches the light where the
   * cell is 100 kΩ in the turn-off time.
   */
  private fallTimeConstant() {
    const turnOff = this.params.get("toff");
    const lit = 1 / TURN_OFF_RESISTANCE - 1 / this.params.get("rdark");
    const ratio = lit * this.params.get("r10");

    if (!(lit > 0) || !(ratio < 1) || !(this.lowPower > 0)) {
      return turnOff;
    }

    const light = KNEE_CURRENT * ratio ** (1 / this.lowPower);

    return turnOff / Math.log(KNEE_CURRENT / light);
  }

  override stamp(system: MnaSystem) {
    super.stamp(system);

    const r1 = this.params.get("r1");
    const r10 = this.params.get("r10");
    const r40 = this.params.get("r40");

    // The resistance falls as the light rises, never the other way.
    this.lowPower = Math.max(0, Math.log(r1 / r10) / Math.log(10));
    this.highPower = Math.max(0, Math.log(r10 / r40) / Math.log(4));
    this.darkConductance = 1 / this.params.get("rdark");
    this.kneeConductance = 1 / r10;
    this.riseTime = this.params.get("ton");
    this.fallTime = this.fallTimeConstant();

    const a = this.node(OUTPUT_A);
    const b = this.node(OUTPUT_B);
    const [anode, cathode] = this.ledControl();

    this.rowA = system.rightSideRow(a);
    this.rowB = system.rightSideRow(b);
    this.aFromA = system.variableEntry(a, a);
    this.aFromB = system.variableEntry(a, b);
    this.bFromA = system.variableEntry(b, a);
    this.bFromB = system.variableEntry(b, b);
    this.aFromAnode = system.variableEntry(a, anode);
    this.aFromCathode = system.variableEntry(a, cathode);
    this.bFromAnode = system.variableEntry(b, anode);
    this.bFromCathode = system.variableEntry(b, cathode);
  }

  override startStep(system: MnaSystem) {
    super.startStep(system);
    this.riseBlend = lagBlend(system.timeStep, this.riseTime);
    this.fallBlend = lagBlend(system.timeStep, this.fallTime);
  }

  protected stampOutput(system: MnaSystem) {
    const { light: target, slope: targetSlope } = this.ledLight();
    // The operating point has no time, so its light has settled.
    const isSettled = system.mode === "dc";
    const held = this.heldLight;

    const blend = isSettled
      ? 1
      : target > held
        ? this.riseBlend
        : this.fallBlend;

    const light = held + blend * (target - held);
    const { conductance, slope } = this.cellConductance(light);

    const cellVoltage =
      (this.volts[OUTPUT_A] ?? 0) - (this.volts[OUTPUT_B] ?? 0);

    const { linearVoltage } = this.led;

    const predicted =
      this.conductance * cellVoltage +
      this.controlSlope * (linearVoltage - this.controlVoltage);

    // Converged once the cell current lands where the last linearization predicted.
    if (mispredicts(conductance * cellVoltage, predicted)) {
      system.converged = false;
    }

    this.light = light;
    this.conductance = conductance;
    // The cell current G × V, linearized in the LED junction voltage too.
    this.controlSlope = slope * blend * targetSlope * cellVoltage;
    this.controlVoltage = linearVoltage;
    system.addEntry(this.aFromA, conductance);
    system.addEntry(this.bFromB, conductance);
    system.addEntry(this.aFromB, -conductance);
    system.addEntry(this.bFromA, -conductance);
    // A current source pushing -controlSlope × the junction voltage from A into B.
    system.addRightSide(this.rowA, this.controlSlope * linearVoltage);
    system.addRightSide(this.rowB, -this.controlSlope * linearVoltage);
    // The controlled current from A into B, controlSlope × (V(anode) − V(cathode)).
    system.addEntry(this.aFromAnode, this.controlSlope);
    system.addEntry(this.aFromCathode, -this.controlSlope);
    system.addEntry(this.bFromAnode, -this.controlSlope);
    system.addEntry(this.bFromCathode, this.controlSlope);
  }

  override finishStep(system: MnaSystem) {
    super.finishStep(system);
    this.heldLight = this.light;
  }

  override stampAc(system: AcSystem, omega: number) {
    super.stampAc(system, omega);

    const [anode, cathode] = this.ledControl();

    stampLagAc(
      system,
      [this.node(OUTPUT_A), this.node(OUTPUT_B), anode, cathode],
      this.controlSlope,
      omega,
      this.params.get("ton"),
    );
  }

  /** Returns the current through the cell, from its first pin to its second. */
  cellCurrent() {
    return (
      this.conductance *
      ((this.volts[OUTPUT_A] ?? 0) - (this.volts[OUTPUT_B] ?? 0))
    );
  }

  override currentIntoPost(post: number) {
    if (post === OUTPUT_A) {
      return this.cellCurrent();
    }

    if (post === OUTPUT_B) {
      return -this.cellCurrent();
    }

    return super.currentIntoPost(post);
  }

  override reset() {
    super.reset();
    this.light = 0;
    this.heldLight = 0;
    this.conductance = 0;
    this.controlSlope = 0;
    this.controlVoltage = 0;
  }

  override info() {
    return [
      this.title(),
      this.params.modelName,
      `IF = ${formatSi(this.led.current, "A")}`,
      `R = ${formatSi(1 / Math.max(this.conductance, 1e-15), "Ω")}`,
      `I = ${formatSi(this.cellCurrent(), "A")}`,
      `P = ${formatSi(this.power(), "W")}`,
    ];
  }
}
