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
import { CUSTOM_MODEL, ParamSet, type ParamSpec, type Preset } from "../params";
import { parseSpiceModel, type SpiceModel } from "../spice-model";
import { formatSi } from "../units";

// Shared junction model

/** Diode flag for the Zener symbol; Falstad's flags 1 and 2 are cleared on reading. */
const ZENER_FLAG = 4;

/** Thermal voltage at room temperature, in volts. */
const THERMAL_VOLTAGE = 0.025865;

/** Conductance across every junction, so reverse-biased parts never float. */
const JUNCTION_GMIN = 1e-12;

/** Largest exponent argument evaluated; beyond it the junction is far outside its range. */
const MAX_EXPONENT = 80;

/** Returns e to the `argument`, capped at MAX_EXPONENT so it stays finite. */
function limitedExp(argument: number) {
  return Math.exp(Math.min(MAX_EXPONENT, argument));
}

/** Returns SPICE's critical voltage, above which a junction's exponential needs damping. */
function criticalVoltage(saturationCurrent: number, thermal: number) {
  return thermal * Math.log(thermal / (Math.SQRT2 * saturationCurrent));
}

/**
 * Damps a junction voltage's Newton step the way SPICE's pnjlim does, so the
 * exponential does not overshoot.
 */
function limitJunction(
  next: number,
  previous: number,
  critical: number,
  thermal: number,
) {
  if (next > critical && Math.abs(next - previous) > 2 * thermal) {
    if (previous > 0) {
      const argument = 1 + (next - previous) / thermal;

      return argument > 0 ? previous + thermal * Math.log(argument) : critical;
    }

    return thermal * Math.log(next / thermal);
  }

  return next;
}

/** Applies a pasted `.model` card when its type is one of `types`; returns an error or null. */
function applySpiceText(
  text: string,
  types: readonly string[],
  apply: (model: SpiceModel) => void,
) {
  const model = parseSpiceModel(text);

  if (!model) {
    return "No .model card found. It starts with .model, then the part name and type.";
  }

  if (!types.includes(model.type)) {
    return `This is a ${model.type.toUpperCase()} model; this part takes ${types.map((type) => type.toUpperCase()).join(" or ")}.`;
  }

  apply(model);

  return null;
}

// Diodes and LEDs

const DIODE_SPECS: readonly ParamSpec[] = [
  {
    key: "is",
    label: "Saturation current (IS)",
    unit: "A",
    fallback: 1e-14,
    range: "positive",
    spiceNames: ["is"],
  },
  {
    key: "n",
    label: "Emission coefficient (N)",
    unit: "",
    fallback: 1,
    range: "positive",
    spiceNames: ["n"],
  },
  {
    key: "rs",
    label: "Series resistance (RS)",
    unit: "Ω",
    fallback: 0,
    range: "nonnegative",
    spiceNames: ["rs"],
  },
  {
    key: "bv",
    label: "Reverse breakdown voltage (BV)",
    unit: "V",
    fallback: 0,
    range: "nonnegative",
    spiceNames: ["bv"],
    hint: "0 for no breakdown. Set it to the Zener voltage for Zener diodes.",
  },
  {
    key: "ibv",
    label: "Current at breakdown (IBV)",
    unit: "A",
    fallback: 1e-3,
    range: "positive",
    spiceNames: ["ibv"],
  },
  {
    key: "cjo",
    label: "Junction capacitance (CJO)",
    unit: "F",
    fallback: 0,
    range: "nonnegative",
    spiceNames: ["cjo", "cj0"],
  },
];

const DIODE_PRESETS: readonly Preset[] = [
  { name: "Generic", isGeneric: true, values: { is: 1e-14, n: 1 } },
  {
    name: "1N4148",
    values: {
      is: 2.52e-9,
      n: 1.752,
      rs: 0.568,
      bv: 100,
      ibv: 1e-4,
      cjo: 4e-12,
    },
  },
  {
    name: "1N4007",
    values: {
      is: 7.02767e-9,
      n: 1.80803,
      rs: 0.0341512,
      bv: 1000,
      ibv: 5e-6,
      cjo: 1e-11,
    },
  },
  {
    name: "1N5819 (Schottky)",
    values: {
      is: 3.17e-5,
      n: 1.373,
      rs: 0.051,
      bv: 40,
      ibv: 1e-3,
      cjo: 1.1e-10,
    },
  },
  {
    name: "1N4733A (5.1 V Zener)",
    values: { is: 1e-11, n: 1, rs: 0.4, bv: 5.1, ibv: 1e-3, cjo: 1e-10 },
  },
];

/** Red, green and blue of each LED preset, from 0 to 1. */
type LedColor = readonly [number, number, number];

const LED_PRESETS: readonly (Preset & { color: LedColor })[] = [
  {
    name: "Red LED",
    values: { is: 1e-22, n: 1.5, rs: 6, cjo: 5e-11 },
    color: [1, 0, 0],
  },
  {
    name: "Yellow LED",
    values: { is: 2e-23, n: 1.55, rs: 6, cjo: 5e-11 },
    color: [1, 0.8, 0],
  },
  {
    name: "Green LED",
    values: { is: 1e-24, n: 1.6, rs: 6, cjo: 5e-11 },
    color: [0, 1, 0],
  },
  {
    name: "Blue LED",
    values: { is: 1.4e-22, n: 2.5, rs: 5, cjo: 5e-11 },
    color: [0, 0.4, 1],
  },
  {
    name: "White LED",
    values: { is: 1.4e-22, n: 2.5, rs: 5, cjo: 5e-11 },
    color: [1, 1, 1],
  },
];

/**
 * A diode with the SPICE junction model: saturation current, emission coefficient,
 * series resistance, reverse breakdown and junction capacitance. The first post is the
 * anode. Values come from a part preset, a pasted SPICE model or by hand.
 */
export class Diode extends CircuitElement {
  readonly kind: "diode" | "led" = "diode";
  readonly dumpType: string = "d";
  override readonly designatorPrefix = "D";
  protected override readonly usesExtendedFormat = true;
  readonly params: ParamSet;
  readonly junction = new CompanionCapacitor(0);
  junctionCurrent = 0;
  private lastVoltage = 0;

  constructor(x1: number, y1: number, x2: number, y2: number, flags = 0) {
    super(x1, y1, x2, y2, flags);
    this.params = new ParamSet(DIODE_SPECS, this.presets());
  }

  /** Returns the parts the Part picker offers. */
  presets(): readonly Preset[] {
    return DIODE_PRESETS;
  }

  /** Reads Lunar Spice's model values, or Falstad's forward voltage or model name. */
  readValues(reader: TokenReader) {
    if ((this.flags & EXTENDED_FORMAT_FLAG) !== 0) {
      this.params.read(reader);
    } else if ((this.flags & 2) !== 0) {
      // Skip Falstad's model name; the default preset stays.
      reader.string("default");
    } else if ((this.flags & 1) !== 0) {
      // Falstad's forward voltage at 1 A with an emission coefficient of 1.
      const forwardVoltage = reader.number(0.805904783);

      this.params.modelName = CUSTOM_MODEL;
      this.params.set(
        "is",
        1 / (limitedExp(forwardVoltage / THERMAL_VOLTAGE) - 1),
      );
      this.params.set("n", 1);
    }

    this.flags &= ~3;

    return this;
  }

  static override read(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    flags: number,
    reader: TokenReader,
  ) {
    return new Diode(x1, y1, x2, y2, flags).readValues(reader);
  }

  /** True when it is drawn and named as a Zener (flag 4); Zener presets set it. */
  get isZener() {
    return (this.flags & ZENER_FLAG) !== 0;
  }

  set isZener(value: boolean) {
    this.flags = value ? this.flags | ZENER_FLAG : this.flags & ~ZENER_FLAG;
  }

  name(): string {
    return this.isZener ? "Zener diode" : "Diode";
  }

  override valueLabel() {
    return this.params.modelName === CUSTOM_MODEL ? "" : this.params.modelName;
  }

  override internalNodeCount() {
    return this.params.get("rs") > 0 ? 1 : 0;
  }

  /** Returns the index in `nodes` of the junction's anode side: past RS, if any. */
  private junctionIndex() {
    return this.params.get("rs") > 0 ? 2 : 0;
  }

  /** Returns the thermal voltage times the emission coefficient N. */
  private thermal() {
    return this.params.get("n") * THERMAL_VOLTAGE;
  }

  /** Returns the junction current and conductance at `voltage`, breakdown included. */
  private junctionModel(voltage: number) {
    const saturation = this.params.get("is");
    const thermal = this.thermal();
    const exponential = limitedExp(voltage / thermal);
    let current = saturation * (exponential - 1) + JUNCTION_GMIN * voltage;
    let conductance = (saturation * exponential) / thermal + JUNCTION_GMIN;
    const breakdown = this.params.get("bv");

    if (breakdown > 0) {
      const reverse =
        this.params.get("ibv") * limitedExp(-(voltage + breakdown) / thermal);

      current -= reverse;
      conductance += reverse / thermal;
    }

    return { current, conductance };
  }

  override isNonlinear() {
    return true;
  }

  override stamp(system: MnaSystem) {
    const rs = this.params.get("rs");

    this.junction.capacitance = this.params.get("cjo");

    if (rs > 0) {
      system.stampResistor(this.node(0), this.node(2), rs);
    }

    this.junction.stamp(system, this.node(this.junctionIndex()), this.node(1));
  }

  override startStep(system: MnaSystem) {
    this.junction.startStep(system);
  }

  override stampStep(system: MnaSystem) {
    const anode = this.node(this.junctionIndex());
    const cathode = this.node(1);
    const thermal = this.thermal();

    const measured =
      (this.volts[this.junctionIndex()] ?? 0) - (this.volts[1] ?? 0);

    // Newton has not converged while the junction voltage moves more than 10 mV.
    if (Math.abs(measured - this.lastVoltage) > 0.01) {
      system.converged = false;
    }

    let voltage = limitJunction(
      measured,
      this.lastVoltage,
      criticalVoltage(this.params.get("is"), thermal),
      thermal,
    );

    const breakdown = this.params.get("bv");

    if (breakdown > 0 && voltage < 0) {
      // Past breakdown the reverse exponential needs the same damping.
      const reverse = limitJunction(
        -(voltage + breakdown),
        -(this.lastVoltage + breakdown),
        criticalVoltage(this.params.get("ibv"), thermal),
        thermal,
      );

      voltage = -(reverse + breakdown);
    }

    this.lastVoltage = voltage;

    // Stamp the junction linearized at `voltage`: a conductance and a current source.
    const { current, conductance } = this.junctionModel(voltage);

    system.stampConductance(anode, cathode, conductance);
    system.stampCurrentSource(anode, cathode, current - conductance * voltage);
    this.junction.stampStep(system, anode, cathode);
  }

  override finishStep(system: MnaSystem) {
    const voltage =
      (this.volts[this.junctionIndex()] ?? 0) - (this.volts[1] ?? 0);

    this.junctionCurrent = this.junctionModel(voltage).current;
    this.junction.finish(system, voltage);
    this.current = this.junctionCurrent + this.junction.current;
  }

  override stampAc(system: AcSystem, omega: number) {
    this.junction.stampAc(
      system,
      this.node(this.junctionIndex()),
      this.node(1),
      omega,
    );
  }

  override reset() {
    super.reset();
    this.lastVoltage = 0;
    this.junction.reset();
  }

  override info() {
    return [this.title(), this.params.modelName, ...this.readingLines()];
  }

  /** Applies a picked part and sets the Zener flag from its name; LEDs also take its color. */
  protected applyPreset(name: string) {
    this.params.applyPreset(name);
    this.isZener = name.includes("Zener");
  }

  /** Returns the fields for the part picker, a pasted `.model` card and the model values. */
  protected modelFields() {
    return this.params.fields(
      (text) =>
        applySpiceText(text, ["d"], (model) => this.params.applySpice(model)),
      (name) => this.applyPreset(name),
    );
  }

  override editFields(): EditField[] {
    return [
      ...this.modelFields(),
      {
        kind: "boolean",
        key: "zener",
        label: "Draw as a Zener diode",
        value: this.isZener,
        set: (value) => {
          this.isZener = value;
        },
      },
    ];
  }

  override dumpValues(): (string | number)[] {
    return this.params.dump();
  }
}

/** A diode that glows with its current, up to full brightness at 20 mA. */
export class Led extends Diode {
  override readonly kind = "led";
  override readonly dumpType = "162";
  red = 1;
  green = 0;
  blue = 0;

  override presets() {
    return LED_PRESETS;
  }

  override editFields(): EditField[] {
    return this.modelFields();
  }

  static override read(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    flags: number,
    reader: TokenReader,
  ) {
    const isExtended = (flags & EXTENDED_FORMAT_FLAG) !== 0;
    const led = new Led(x1, y1, x2, y2, flags);

    // Falstad's LEDs use their own forward-voltage model; keep the red LED preset.
    if (isExtended) {
      led.readValues(reader);
    } else if ((flags & 3) !== 0) {
      reader.string("");
      led.flags &= ~3;
    }

    led.red = reader.number(1);
    led.green = reader.number(0);
    led.blue = reader.number(0);

    return led;
  }

  override name() {
    return "LED";
  }

  /** Returns the glow from 0 to 1. */
  brightness() {
    return Math.min(1, Math.max(0, this.current / 0.02));
  }

  protected override applyPreset(name: string) {
    super.applyPreset(name);

    const preset = LED_PRESETS.find((candidate) => candidate.name === name);

    if (preset) {
      [this.red, this.green, this.blue] = preset.color;
    }
  }

  override dumpValues() {
    return [...this.params.dump(), this.red, this.green, this.blue];
  }
}

// Bipolar transistors

/** Offset of a transistor's collector and emitter (or drain and source) from its axis. */
const TRANSISTOR_HALF_SPAN = 16;

const BJT_SPECS: readonly ParamSpec[] = [
  {
    key: "is",
    label: "Saturation current (IS)",
    unit: "A",
    fallback: 1e-13,
    range: "positive",
    spiceNames: ["is"],
  },
  {
    key: "bf",
    label: "Forward current gain (BF)",
    unit: "",
    fallback: 100,
    range: "positive",
    spiceNames: ["bf"],
  },
  {
    key: "br",
    label: "Reverse current gain (BR)",
    unit: "",
    fallback: 1,
    range: "positive",
    spiceNames: ["br"],
  },
  {
    key: "nf",
    label: "Emission coefficient (NF)",
    unit: "",
    fallback: 1,
    range: "positive",
    spiceNames: ["nf"],
  },
  {
    key: "vaf",
    label: "Early voltage (VAF)",
    unit: "V",
    fallback: 0,
    range: "nonnegative",
    spiceNames: ["vaf", "va"],
    hint: "0 for none: the collector current then ignores the collector voltage.",
  },
  {
    key: "cje",
    label: "Base-emitter capacitance (CJE)",
    unit: "F",
    fallback: 0,
    range: "nonnegative",
    spiceNames: ["cje"],
  },
  {
    key: "cjc",
    label: "Base-collector capacitance (CJC)",
    unit: "F",
    fallback: 0,
    range: "nonnegative",
    spiceNames: ["cjc"],
  },
];

/** Bipolar parts; `polarity` is 1 for NPN and -1 for PNP. */
const BJT_PRESETS: readonly Preset[] = [
  {
    name: "Generic NPN",
    polarity: 1,
    isGeneric: true,
    values: { is: 1e-13, bf: 100 },
  },
  {
    name: "Generic PNP",
    polarity: -1,
    isGeneric: true,
    values: { is: 1e-13, bf: 100 },
  },
  {
    name: "2N3904",
    polarity: 1,
    values: { is: 1e-14, bf: 300, br: 4, vaf: 100, cje: 8e-12, cjc: 4e-12 },
  },
  {
    name: "2N3906",
    polarity: -1,
    values: { is: 1e-14, bf: 200, br: 4, vaf: 100, cje: 1e-11, cjc: 4.5e-12 },
  },
  {
    name: "2N2222A",
    polarity: 1,
    values: { is: 1e-14, bf: 200, br: 3, vaf: 100, cje: 2.5e-11, cjc: 8e-12 },
  },
  {
    name: "BC547B",
    polarity: 1,
    values: {
      is: 2.39e-14,
      bf: 294.3,
      br: 7.946,
      nf: 1.008,
      vaf: 63.2,
      cje: 1.358e-11,
      cjc: 3.728e-12,
    },
  },
  {
    name: "BC557B",
    polarity: -1,
    values: {
      is: 1.02e-14,
      bf: 266.4,
      br: 9.32,
      nf: 1.004,
      vaf: 81.5,
      cje: 1.55e-11,
      cjc: 1.1e-11,
    },
  },
];

/**
 * A bipolar junction transistor with the Ebers–Moll transport model, the Early effect
 * and constant junction capacitances. Posts are base, collector and emitter; the base
 * is the first point and the other two sit either side of the second point.
 */
export class Bjt extends CircuitElement {
  readonly kind = "bjt";
  readonly dumpType = "t";
  override readonly designatorPrefix = "Q";
  override readonly mirrorFlag = 1;
  protected override readonly usesExtendedFormat = true;
  /** 1 for NPN, -1 for PNP. */
  polarity = 1;
  readonly params = new ParamSet(BJT_SPECS, BJT_PRESETS);
  readonly emitterJunction = new CompanionCapacitor(0);
  readonly collectorJunction = new CompanionCapacitor(0);
  baseCurrent = 0;
  collectorCurrent = 0;
  emitterCurrent = 0;
  private lastVbe = 0;
  private lastVbc = 0;

  static override read(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    flags: number,
    reader: TokenReader,
  ) {
    const bjt = new Bjt(x1, y1, x2, y2, flags);

    bjt.polarity = reader.number(1) < 0 ? -1 : 1;
    bjt.lastVbe = reader.number(0);
    bjt.lastVbc = reader.number(0);

    const beta = reader.number(100);

    if ((flags & EXTENDED_FORMAT_FLAG) !== 0) {
      bjt.params.read(reader);
    } else {
      bjt.params.applyGeneric(bjt.polarity);
      bjt.params.set("bf", beta);
    }

    return bjt;
  }

  name() {
    return this.polarity === 1 ? "NPN transistor" : "PNP transistor";
  }

  /** Sets NPN (1) or PNP (-1); a generic model changes to the other generic part. */
  override setPolarity(polarity: number) {
    this.polarity = polarity;

    if (this.params.isGeneric) {
      this.params.applyGeneric(polarity);
    }
  }

  override valueLabel() {
    return this.params.isGeneric
      ? `β ${this.params.get("bf")}`
      : this.params.modelName;
  }

  override posts(): Point[] {
    const flip = (this.flags & 1) !== 0 ? -1 : 1;

    const across =
      TRANSISTOR_HALF_SPAN *
      directionSign(this.start, this.end) *
      this.polarity *
      flip;

    const [collector, emitter] = interpolatePair(
      this.start,
      this.end,
      1,
      across,
    );

    return [this.start, roundPoint(collector), roundPoint(emitter)];
  }

  /** Drawn between its leads, so only the box they bound picks it. */
  override bodyMargin() {
    return 0;
  }

  override isNonlinear() {
    return true;
  }

  override stamp(system: MnaSystem) {
    this.emitterJunction.capacitance = this.params.get("cje");
    this.collectorJunction.capacitance = this.params.get("cjc");
    this.emitterJunction.stamp(system, this.node(0), this.node(2));
    this.collectorJunction.stamp(system, this.node(0), this.node(1));
  }

  override startStep(system: MnaSystem) {
    this.emitterJunction.startStep(system);
    this.collectorJunction.startStep(system);
  }

  override stampStep(system: MnaSystem) {
    const base = this.node(0);
    const collector = this.node(1);
    const emitter = this.node(2);
    const sign = this.polarity;
    const is = this.params.get("is");
    const bf = this.params.get("bf");
    const br = this.params.get("br");
    const vaf = this.params.get("vaf");
    const forwardThermal = this.params.get("nf") * THERMAL_VOLTAGE;
    const measuredVbe = (this.volts[0] ?? 0) - (this.volts[2] ?? 0);
    const measuredVbc = (this.volts[0] ?? 0) - (this.volts[1] ?? 0);

    // Newton has not converged while either junction voltage moves more than 10 mV.
    if (
      Math.abs(measuredVbe - this.lastVbe) > 0.01 ||
      Math.abs(measuredVbc - this.lastVbc) > 0.01
    ) {
      system.converged = false;
    }

    // Damp each junction's Newton step in NPN terms, then restore the sign.
    const vbe =
      sign *
      limitJunction(
        sign * measuredVbe,
        sign * this.lastVbe,
        criticalVoltage(is, forwardThermal),
        forwardThermal,
      );

    const vbc =
      sign *
      limitJunction(
        sign * measuredVbc,
        sign * this.lastVbc,
        criticalVoltage(is, THERMAL_VOLTAGE),
        THERMAL_VOLTAGE,
      );

    this.lastVbe = vbe;
    this.lastVbc = vbc;

    // Currents into each terminal of an NPN at the polarity-corrected voltages.
    const ebe = limitedExp((sign * vbe) / forwardThermal);
    const ebc = limitedExp((sign * vbc) / THERMAL_VOLTAGE);
    const early = vaf > 0 ? Math.max(0.1, 1 - (sign * vbc) / vaf) : 1;
    const transport = is * (ebe - ebc);
    const collectorNpn = transport * early - (is / br) * (ebc - 1);
    const baseNpn = (is / bf) * (ebe - 1) + (is / br) * (ebc - 1);

    // Partial derivatives by vbe and vbc; the polarity cancels out of them.
    const dEbe = (is * ebe) / forwardThermal;
    const dEbc = (is * ebc) / THERMAL_VOLTAGE;
    const dEarly = vaf > 0 && early > 0.1 ? -1 / vaf : 0;
    const dCollectorBe = dEbe * early;
    const dCollectorBc = -dEbc * early + transport * dEarly - dEbc / br;
    const dBaseBe = dEbe / bf;
    const dBaseBc = dEbc / br;

    this.collectorCurrent = sign * collectorNpn;
    this.baseCurrent = sign * baseNpn;
    this.emitterCurrent = -(this.collectorCurrent + this.baseCurrent);

    // Stamp each terminal's current, linearized in vbe and vbc.
    const terminals = [
      { node: base, current: this.baseCurrent, dBe: dBaseBe, dBc: dBaseBc },
      {
        node: collector,
        current: this.collectorCurrent,
        dBe: dCollectorBe,
        dBc: dCollectorBc,
      },
      {
        node: emitter,
        current: this.emitterCurrent,
        dBe: -(dBaseBe + dCollectorBe),
        dBc: -(dBaseBc + dCollectorBc),
      },
    ];

    for (const terminal of terminals) {
      system.stampMatrix(terminal.node, base, terminal.dBe + terminal.dBc);
      system.stampMatrix(terminal.node, emitter, -terminal.dBe);
      system.stampMatrix(terminal.node, collector, -terminal.dBc);
      system.stampRightSide(
        terminal.node,
        -(terminal.current - terminal.dBe * vbe - terminal.dBc * vbc),
      );
    }

    system.stampConductance(base, emitter, JUNCTION_GMIN);
    system.stampConductance(base, collector, JUNCTION_GMIN);
    this.emitterJunction.stampStep(system, base, emitter);
    this.collectorJunction.stampStep(system, base, collector);
  }

  override finishStep(system: MnaSystem) {
    const [vb = 0, vc = 0, ve = 0] = this.volts;

    this.emitterJunction.finish(system, vb - ve);
    this.collectorJunction.finish(system, vb - vc);
    this.current = this.collectorCurrent;
  }

  override stampAc(system: AcSystem, omega: number) {
    this.emitterJunction.stampAc(system, this.node(0), this.node(2), omega);
    this.collectorJunction.stampAc(system, this.node(0), this.node(1), omega);
  }

  override currentIntoPost(post: number) {
    const emitterCap = this.emitterJunction.current;
    const collectorCap = this.collectorJunction.current;

    return (
      [
        this.baseCurrent + emitterCap + collectorCap,
        this.collectorCurrent - collectorCap,
        this.emitterCurrent - emitterCap,
      ][post] ?? 0
    );
  }

  override reset() {
    super.reset();
    this.lastVbe = 0;
    this.lastVbc = 0;
    this.baseCurrent = 0;
    this.collectorCurrent = 0;
    this.emitterCurrent = 0;
    this.emitterJunction.reset();
    this.collectorJunction.reset();
  }

  override info() {
    const [vb = 0, vc = 0, ve = 0] = this.volts;

    return [
      this.title(),
      this.params.modelName,
      `Ic = ${formatSi(this.collectorCurrent, "A")}`,
      `Ib = ${formatSi(this.baseCurrent, "A")}`,
      `Vbe = ${formatSi(vb - ve, "V")}`,
      `Vce = ${formatSi(vc - ve, "V")}`,
      `P = ${formatSi(this.power(), "W")}`,
    ];
  }

  override editFields(): EditField[] {
    const type: EditField = {
      kind: "choice",
      key: "polarity",
      label: "Type",
      value: this.polarity === 1 ? "npn" : "pnp",
      options: [
        { value: "npn", label: "NPN" },
        { value: "pnp", label: "PNP" },
      ],
      set: (value) => {
        this.setPolarity(value === "pnp" ? -1 : 1);
      },
    };

    const fields = this.params.fields(
      (text) =>
        applySpiceText(text, ["npn", "pnp"], (model) => {
          this.params.applySpice(model);
          this.polarity = model.type === "pnp" ? -1 : 1;
        }),
      (name) => {
        this.polarity =
          this.params.applyPreset(name)?.polarity ?? this.polarity;
      },
    );

    return [type, ...fields];
  }

  override dumpValues() {
    return [
      this.polarity,
      this.lastVbe,
      this.lastVbc,
      this.params.get("bf"),
      ...this.params.dump(),
    ];
  }
}

// MOSFETs

const MOSFET_SPECS: readonly ParamSpec[] = [
  {
    key: "vto",
    label: "Threshold voltage (VTO)",
    unit: "V",
    fallback: 1.5,
    range: "positive",
    spiceNames: ["vto"],
    hint: "Its magnitude; P-channel parts turn on below −VTO.",
  },
  {
    key: "kp",
    label: "Transconductance (KP)",
    unit: "A/V²",
    fallback: 0.02,
    range: "positive",
    spiceNames: ["kp"],
    hint: "KP × W/L for level-1 models. Id = KP/2 · (Vgs − VTO)² in saturation.",
  },
  {
    key: "lambda",
    label: "Channel-length modulation (LAMBDA)",
    unit: "1/V",
    fallback: 0,
    range: "nonnegative",
    spiceNames: ["lambda"],
  },
  {
    key: "rd",
    label: "Drain-source resistance (RD + RS)",
    unit: "Ω",
    fallback: 0,
    range: "nonnegative",
    spiceNames: ["rd"],
    hint: "Adds to the channel's on-resistance, as in Rds(on).",
  },
  {
    key: "cgs",
    label: "Gate-source capacitance (CGS)",
    unit: "F",
    fallback: 0,
    range: "nonnegative",
    spiceNames: ["cgs"],
  },
  {
    key: "cgd",
    label: "Gate-drain capacitance (CGD)",
    unit: "F",
    fallback: 0,
    range: "nonnegative",
    spiceNames: ["cgd"],
  },
];

/** A field-effect channel's current and its derivatives at one Vgs and Vds. */
type ChannelPoint = {
  current: number;
  transconductance: number; // dI/dVgs
  outputConductance: number; // dI/dVds
};

/** MOSFET parts; `polarity` is 1 for N-channel and -1 for P-channel. */
const MOSFET_PRESETS: readonly Preset[] = [
  {
    name: "Generic N-channel",
    polarity: 1,
    isGeneric: true,
    values: { vto: 1.5, kp: 0.02 },
  },
  {
    name: "Generic P-channel",
    polarity: -1,
    isGeneric: true,
    values: { vto: 1.5, kp: 0.02 },
  },
  {
    name: "2N7000",
    polarity: 1,
    values: { vto: 1.6, kp: 0.17, rd: 0.75, cgs: 5e-11, cgd: 4.6e-11 },
  },
  {
    name: "BS170",
    polarity: 1,
    values: { vto: 1.8, kp: 0.2, rd: 1.9, cgs: 2.4e-11, cgd: 1.25e-11 },
  },
  {
    name: "IRF540N",
    polarity: 1,
    values: {
      vto: 4,
      kp: 30,
      lambda: 0.03,
      rd: 0.0195,
      cgs: 1.4e-9,
      cgd: 8e-10,
    },
  },
  {
    name: "IRF9540N",
    polarity: -1,
    values: {
      vto: 3.5,
      kp: 6.5,
      lambda: 0.03,
      rd: 0.07,
      cgs: 1.3e-9,
      cgd: 6e-10,
    },
  },
];

/**
 * A MOSFET with the square-law (SPICE level 1) model, channel-length modulation,
 * drain-source resistance and constant gate capacitances. Posts are gate, source and
 * drain; source and drain swap roles when the drain sits below the source.
 */
export class Mosfet extends CircuitElement {
  readonly kind: "mosfet" | "jfet" = "mosfet";
  readonly dumpType: string = "f";
  override readonly designatorPrefix: string = "M";
  override readonly mirrorFlag = 2;
  protected override readonly usesExtendedFormat = true;
  readonly params: ParamSet = new ParamSet(MOSFET_SPECS, MOSFET_PRESETS);
  readonly gateSource = new CompanionCapacitor(0);
  readonly gateDrain = new CompanionCapacitor(0);
  /** Channel current into the drain. */
  drainCurrent = 0;
  private lastVgs = 0;
  private lastVds = 0;

  static override read(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    flags: number,
    reader: TokenReader,
  ) {
    const mosfet = new Mosfet(x1, y1, x2, y2, flags);
    const threshold = Math.abs(reader.number(1.5));
    const beta = reader.number(0.02);

    if ((flags & EXTENDED_FORMAT_FLAG) !== 0) {
      mosfet.params.read(reader);
    } else {
      mosfet.params.applyGeneric(mosfet.polarity);
      mosfet.params.set("vto", threshold);
      mosfet.params.set("kp", beta);
    }

    return mosfet;
  }

  /** 1 for N-channel, -1 for P-channel (flag 1). */
  get polarity() {
    return (this.flags & 1) !== 0 ? -1 : 1;
  }

  set polarity(value: number) {
    this.flags = value < 0 ? this.flags | 1 : this.flags & ~1;
  }

  name(): string {
    return this.polarity === 1 ? "N-channel MOSFET" : "P-channel MOSFET";
  }

  /** Sets N-channel (1) or P-channel (-1); a generic model changes to the other generic part. */
  override setPolarity(polarity: number) {
    this.polarity = polarity;

    if (this.params.isGeneric) {
      this.params.applyGeneric(polarity);
    }
  }

  override valueLabel(): string {
    return this.params.isGeneric
      ? `Vt ${formatSi(this.params.get("vto") * this.polarity, "V")}`
      : this.params.modelName;
  }

  override posts(): Point[] {
    const flip = (this.flags & this.mirrorFlag) !== 0 ? -1 : 1;

    const across =
      -TRANSISTOR_HALF_SPAN *
      directionSign(this.start, this.end) *
      this.polarity *
      flip;

    const [source, drain] = interpolatePair(this.start, this.end, 1, across);

    return [this.start, roundPoint(source), roundPoint(drain)];
  }

  /** Drawn between its leads, so only the box they bound picks it. */
  override bodyMargin() {
    return 0;
  }

  override internalNodeCount() {
    return this.params.get("rd") > 0 ? 1 : 0;
  }

  /** Returns the index in `nodes` of the channel's drain end: past RD, if any. */
  protected channelDrain() {
    return this.params.get("rd") > 0 ? 3 : 2;
  }

  override isNonlinear() {
    return true;
  }

  override stamp(system: MnaSystem) {
    const rd = this.params.get("rd");

    if (rd > 0) {
      system.stampResistor(this.node(2), this.node(3), rd);
    }

    this.gateSource.capacitance = this.params.get("cgs");
    this.gateDrain.capacitance = this.params.get("cgd");
    this.gateSource.stamp(system, this.node(0), this.node(1));
    this.gateDrain.stamp(system, this.node(0), this.node(this.channelDrain()));
  }

  override startStep(system: MnaSystem) {
    this.gateSource.startStep(system);
    this.gateDrain.startStep(system);
  }

  override stampStep(system: MnaSystem) {
    const sign = this.polarity;
    const drainIndex = this.channelDrain();
    const vg = this.volts[0] ?? 0;
    const vs = this.volts[1] ?? 0;
    const vd = this.volts[drainIndex] ?? 0;
    let vgs = sign * (vg - vs);
    let vds = sign * (vd - vs);

    // Newton has not converged while Vgs or Vds moves more than 10 mV.
    if (
      Math.abs(vgs - this.lastVgs) > 0.01 ||
      Math.abs(vds - this.lastVds) > 0.01
    ) {
      system.converged = false;
    }

    // Limit each Newton step to 0.5 V for Vgs and 1 V for Vds.
    vgs = this.lastVgs + Math.max(-0.5, Math.min(0.5, vgs - this.lastVgs));
    vds = this.lastVds + Math.max(-1, Math.min(1, vds - this.lastVds));
    this.lastVgs = vgs;
    this.lastVds = vds;

    // With the drain below the source, the terminals swap roles.
    const isSwapped = vds < 0;
    const gate = this.node(0);
    const source = isSwapped ? this.node(drainIndex) : this.node(1);
    const drain = isSwapped ? this.node(1) : this.node(drainIndex);
    const effectiveVgs = isSwapped ? vgs - vds : vgs;
    const effectiveVds = Math.abs(vds);
    const channel = this.channelCurrent(effectiveVgs, effectiveVds);
    const transconductance = channel.transconductance;
    // Add 10 nS of leakage, so an off channel does not float.
    const current = channel.current + 1e-8 * effectiveVds;
    const outputConductance = channel.outputConductance + 1e-8;

    // Linearize the current into the effective drain, in real polarity.
    const drainCurrent = sign * current;

    const constant =
      drainCurrent -
      transconductance * sign * effectiveVgs -
      outputConductance * sign * effectiveVds;

    system.stampMatrix(drain, gate, transconductance);
    system.stampMatrix(drain, drain, outputConductance);
    system.stampMatrix(drain, source, -transconductance - outputConductance);
    system.stampRightSide(drain, -constant);
    system.stampMatrix(source, gate, -transconductance);
    system.stampMatrix(source, drain, -outputConductance);
    system.stampMatrix(source, source, transconductance + outputConductance);
    system.stampRightSide(source, constant);
    this.gateSource.stampStep(system, this.node(0), this.node(1));
    this.gateDrain.stampStep(system, this.node(0), this.node(drainIndex));
    this.drainCurrent = isSwapped ? -drainCurrent : drainCurrent;
  }

  /**
   * The square-law (level 1) channel current at `vgs` and `vds` (never negative), in
   * N-channel terms, with its derivatives: linear region, then saturation; nothing below
   * threshold.
   */
  protected channelCurrent(vgs: number, vds: number): ChannelPoint {
    const beta = this.params.get("kp");
    const lambda = this.params.get("lambda");
    const overdrive = vgs - this.params.get("vto");
    const modulation = 1 + lambda * vds;

    if (overdrive <= 0) {
      return { current: 0, transconductance: 0, outputConductance: 0 };
    }

    if (vds < overdrive) {
      const base = beta * (overdrive * vds - (vds * vds) / 2);

      return {
        current: base * modulation,
        transconductance: beta * vds * modulation,
        outputConductance:
          beta * (overdrive - vds) * modulation + base * lambda,
      };
    }

    const base = (beta / 2) * overdrive * overdrive;

    return {
      current: base * modulation,
      transconductance: beta * overdrive * modulation,
      outputConductance: base * lambda,
    };
  }

  override finishStep(system: MnaSystem) {
    const [vg = 0, vs = 0] = this.volts;
    const vd = this.volts[this.channelDrain()] ?? 0;

    this.gateSource.finish(system, vg - vs);
    this.gateDrain.finish(system, vg - vd);
    this.current = this.drainCurrent;
  }

  override stampAc(system: AcSystem, omega: number) {
    this.gateSource.stampAc(system, this.node(0), this.node(1), omega);
    this.gateDrain.stampAc(
      system,
      this.node(0),
      this.node(this.channelDrain()),
      omega,
    );
  }

  /** Returns current only on the third path: the channel, drain to source. */
  override currentPaths() {
    return [0, 0, this.current];
  }

  override currentIntoPost(post: number) {
    const gateSource = this.gateSource.current;
    const gateDrain = this.gateDrain.current;

    return (
      [
        gateSource + gateDrain,
        -this.drainCurrent - gateSource,
        this.drainCurrent - gateDrain,
      ][post] ?? 0
    );
  }

  override reset() {
    super.reset();
    this.lastVgs = 0;
    this.lastVds = 0;
    this.drainCurrent = 0;
    this.gateSource.reset();
    this.gateDrain.reset();
  }

  override info() {
    const [vg = 0, vs = 0, vd = 0] = this.volts;

    return [
      this.title(),
      this.params.modelName,
      `Id = ${formatSi(this.drainCurrent, "A")}`,
      `Vgs = ${formatSi(vg - vs, "V")}`,
      `Vds = ${formatSi(vd - vs, "V")}`,
      `P = ${formatSi(this.power(), "W")}`,
    ];
  }

  /** Reads a level-1 or VDMOS card: KP scales by W/L, CGD averages VDMOS's range. */
  private applySpice(model: SpiceModel) {
    this.params.applySpice(model);

    const { params } = model;
    const width = params.get("w");
    const length = params.get("l");

    if (width !== undefined && length !== undefined && length > 0) {
      this.params.set("kp", this.params.get("kp") * (width / length));
    }

    const cgdMax = params.get("cgdmax");
    const cgdMin = params.get("cgdmin");

    if (cgdMax !== undefined) {
      this.params.set(
        "cgd",
        cgdMin === undefined ? cgdMax : (cgdMax + cgdMin) / 2,
      );
    }

    // The model's RD holds the whole drain-source resistance, RD + RS.
    this.params.set("rd", (params.get("rd") ?? 0) + (params.get("rs") ?? 0));
    // P-channel cards give a negative threshold; polarity carries the sign.
    this.params.set("vto", Math.abs(this.params.get("vto")));
    this.polarity =
      model.type === "pmos" || model.switches.has("pchan") ? -1 : 1;
  }

  /** The N- or P-channel choice that heads the edit dialog. */
  protected polarityField(): EditField {
    return {
      kind: "choice",
      key: "polarity",
      label: "Type",
      value: this.polarity === 1 ? "n" : "p",
      options: [
        { value: "n", label: "N-channel" },
        { value: "p", label: "P-channel" },
      ],
      set: (value) => {
        this.setPolarity(value === "p" ? -1 : 1);
      },
    };
  }

  override editFields(): EditField[] {
    const fields = this.params.fields(
      (text) =>
        applySpiceText(text, ["nmos", "pmos", "vdmos"], (model) =>
          this.applySpice(model),
        ),
      (name) => {
        this.polarity =
          this.params.applyPreset(name)?.polarity ?? this.polarity;
      },
    );

    return [this.polarityField(), ...fields];
  }

  override dumpValues() {
    return [
      this.params.get("vto"),
      this.params.get("kp"),
      ...this.params.dump(),
    ];
  }
}

// JFETs

const JFET_SPECS: readonly ParamSpec[] = [
  {
    key: "vto",
    label: "Pinch-off voltage (VTO)",
    unit: "V",
    fallback: 4,
    range: "positive",
    spiceNames: ["vto"],
    hint: "Its magnitude, as Vgs(off) on a datasheet; SPICE cards give it negative.",
  },
  {
    key: "beta",
    label: "Transconductance (BETA)",
    unit: "A/V²",
    fallback: 6.25e-4,
    range: "positive",
    spiceNames: ["beta"],
    hint: "Idss = BETA × VTO². Id = BETA · (Vgs − VTO)² in saturation.",
  },
  {
    key: "lambda",
    label: "Channel-length modulation (LAMBDA)",
    unit: "1/V",
    fallback: 0,
    range: "nonnegative",
    spiceNames: ["lambda"],
  },
  {
    key: "rd",
    label: "Drain-source resistance (RD + RS)",
    unit: "Ω",
    fallback: 0,
    range: "nonnegative",
    spiceNames: ["rd"],
  },
  {
    key: "is",
    label: "Gate saturation current (IS)",
    unit: "A",
    fallback: 1e-14,
    range: "positive",
    spiceNames: ["is"],
    hint: "Of each gate junction, which conducts when the gate is forward biased.",
  },
  {
    key: "cgs",
    label: "Gate-source capacitance (CGS)",
    unit: "F",
    fallback: 0,
    range: "nonnegative",
    spiceNames: ["cgs"],
  },
  {
    key: "cgd",
    label: "Gate-drain capacitance (CGD)",
    unit: "F",
    fallback: 0,
    range: "nonnegative",
    spiceNames: ["cgd"],
  },
];

/**
 * JFET parts; `polarity` is 1 for N-channel and -1 for P-channel. The generic parts are
 * Falstad's default JFET: Idss 10 mA, pinching off at 4 V.
 */
const JFET_PRESETS: readonly Preset[] = [
  {
    name: "Generic N-channel",
    polarity: 1,
    isGeneric: true,
    values: { vto: 4, beta: 6.25e-4 },
  },
  {
    name: "Generic P-channel",
    polarity: -1,
    isGeneric: true,
    values: { vto: 4, beta: 6.25e-4 },
  },
  {
    name: "2N3819",
    polarity: 1,
    values: {
      vto: 3,
      beta: 1.304e-3,
      lambda: 2.25e-3,
      rd: 2,
      is: 3.357e-14,
      cgs: 2.414e-12,
      cgd: 1.6e-12,
    },
  },
  {
    name: "2N5457",
    polarity: 1,
    values: {
      vto: 1.372,
      beta: 1.125e-3,
      lambda: 2.3e-3,
      rd: 2,
      is: 1.813e-13,
      cgs: 3e-12,
      cgd: 1.5e-12,
    },
  },
];

/** Falstad's JFET square law has a factor ½ that SPICE's BETA leaves out. */
const FALSTAD_BETA_SCALE = 2;

/**
 * A junction FET with the SPICE level 1 (Shichman-Hodges) model: a depletion channel
 * that pinches off at VTO, channel-length modulation, drain-source resistance, gate
 * junctions to source and drain, and constant gate capacitances. Posts and drawing
 * follow the MOSFET's: gate, source, drain.
 */
export class Jfet extends Mosfet {
  override readonly kind = "jfet";
  override readonly dumpType = "j";
  override readonly designatorPrefix = "J";
  override readonly params = new ParamSet(JFET_SPECS, JFET_PRESETS);
  /** Current through the gate-source and gate-drain junctions, gate to channel. */
  gateSourceCurrent = 0;
  gateDrainCurrent = 0;
  private lastJunctionVgs = 0;
  private lastJunctionVgd = 0;

  static override read(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    flags: number,
    reader: TokenReader,
  ) {
    const jfet = new Jfet(x1, y1, x2, y2, flags);
    const pinchOff = Math.abs(reader.number(-4));
    const beta = reader.number(1.25e-3) / FALSTAD_BETA_SCALE;

    if ((flags & EXTENDED_FORMAT_FLAG) !== 0) {
      jfet.params.read(reader);
    } else {
      jfet.params.applyGeneric(jfet.polarity);
      jfet.params.set("vto", pinchOff);
      jfet.params.set("beta", beta);
    }

    return jfet;
  }

  override name() {
    return this.polarity === 1 ? "N-channel JFET" : "P-channel JFET";
  }

  /** Idss, the drain current with the gate tied to the source, for generic parts. */
  override valueLabel() {
    const vto = this.params.get("vto");

    return this.params.isGeneric
      ? `Idss ${formatSi(this.params.get("beta") * vto * vto, "A")}`
      : this.params.modelName;
  }

  /** Conducts from Vgs = −VTO on, so it is on with the gate at the source. */
  protected override channelCurrent(vgs: number, vds: number): ChannelPoint {
    const beta = this.params.get("beta");
    const lambda = this.params.get("lambda");
    const overdrive = vgs + this.params.get("vto");
    const modulation = 1 + lambda * vds;

    if (overdrive <= 0) {
      return { current: 0, transconductance: 0, outputConductance: 0 };
    }

    if (vds < overdrive) {
      const base = beta * vds * (2 * overdrive - vds);

      return {
        current: base * modulation,
        transconductance: 2 * beta * vds * modulation,
        outputConductance:
          2 * beta * (overdrive - vds) * modulation + base * lambda,
      };
    }

    const base = beta * overdrive * overdrive;

    return {
      current: base * modulation,
      transconductance: 2 * beta * overdrive * modulation,
      outputConductance: base * lambda,
    };
  }

  /**
   * Stamps one gate junction from the gate to `channel` at the measured `voltage` (gate
   * minus channel); returns the voltage it linearized at and its current, gate to
   * channel.
   */
  private stampJunction(
    system: MnaSystem,
    channel: number,
    voltage: number,
    previous: number,
  ) {
    const sign = this.polarity;
    const saturation = this.params.get("is");
    const critical = criticalVoltage(saturation, THERMAL_VOLTAGE);
    // In the junction's forward direction: gate to channel for N-channel parts.
    const measured = sign * voltage;

    // Newton has not converged while the junction voltage moves more than 10 mV.
    if (Math.abs(measured - previous) > 0.01) {
      system.converged = false;
    }

    const limited = limitJunction(
      measured,
      previous,
      critical,
      THERMAL_VOLTAGE,
    );

    const exponential = limitedExp(limited / THERMAL_VOLTAGE);
    const current = saturation * (exponential - 1) + JUNCTION_GMIN * limited;

    const conductance =
      (saturation * exponential) / THERMAL_VOLTAGE + JUNCTION_GMIN;

    const gate = this.node(0);

    system.stampConductance(gate, channel, conductance);
    system.stampCurrentSource(
      gate,
      channel,
      sign * (current - conductance * limited),
    );

    return { voltage: limited, current: sign * current };
  }

  override stampStep(system: MnaSystem) {
    super.stampStep(system);

    const vg = this.volts[0] ?? 0;
    const drainIndex = this.channelDrain();

    const source = this.stampJunction(
      system,
      this.node(1),
      vg - (this.volts[1] ?? 0),
      this.lastJunctionVgs,
    );

    const drain = this.stampJunction(
      system,
      this.node(drainIndex),
      vg - (this.volts[drainIndex] ?? 0),
      this.lastJunctionVgd,
    );

    this.lastJunctionVgs = source.voltage;
    this.lastJunctionVgd = drain.voltage;
    this.gateSourceCurrent = source.current;
    this.gateDrainCurrent = drain.current;
  }

  override currentIntoPost(post: number) {
    const junctions = [
      this.gateSourceCurrent + this.gateDrainCurrent,
      -this.gateSourceCurrent,
      -this.gateDrainCurrent,
    ];

    return super.currentIntoPost(post) + (junctions[post] ?? 0);
  }

  override reset() {
    super.reset();
    this.gateSourceCurrent = 0;
    this.gateDrainCurrent = 0;
    this.lastJunctionVgs = 0;
    this.lastJunctionVgd = 0;
  }

  override info() {
    return [
      ...super.info(),
      `Ig = ${formatSi(this.gateSourceCurrent + this.gateDrainCurrent, "A")}`,
    ];
  }

  /** Reads an NJF or PJF card; the pinch-off keeps its magnitude, polarity its sign. */
  private applyJfetSpice(model: SpiceModel) {
    const { params } = model;

    this.params.applySpice(model);
    this.params.set("rd", (params.get("rd") ?? 0) + (params.get("rs") ?? 0));
    this.params.set("vto", Math.abs(this.params.get("vto")));
    this.polarity = model.type === "pjf" ? -1 : 1;
  }

  override editFields(): EditField[] {
    const fields = this.params.fields(
      (text) =>
        applySpiceText(text, ["njf", "pjf"], (model) =>
          this.applyJfetSpice(model),
        ),
      (name) => {
        this.polarity =
          this.params.applyPreset(name)?.polarity ?? this.polarity;
      },
    );

    return [this.polarityField(), ...fields];
  }

  /** Falstad's tokens: the pinch-off as a negative threshold, then its beta. */
  override dumpValues() {
    return [
      -this.params.get("vto"),
      this.params.get("beta") * FALSTAD_BETA_SCALE,
      ...this.params.dump(),
    ];
  }
}
