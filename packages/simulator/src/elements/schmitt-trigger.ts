import {
  CircuitElement,
  type EditField,
  EXTENDED_FORMAT_FLAG,
  type TokenReader,
} from "../element";
import type { MnaSystem } from "../mna-system";
import { ParamSet, type ParamSpec, type Preset } from "../params";
import { formatSi } from "../units";

const SCHMITT_SPECS: readonly ParamSpec[] = [
  {
    key: "vtp",
    label: "Upper threshold (VT+)",
    unit: "V",
    fallback: 3.33,
    range: "any",
    spiceNames: [],
    hint: "A rising input switches the output once it passes this.",
  },
  {
    key: "vtn",
    label: "Lower threshold (VT−)",
    unit: "V",
    fallback: 1.66,
    range: "any",
    spiceNames: [],
    hint: "A falling input switches the output once it passes this.",
  },
  {
    key: "voh",
    label: "Output high",
    unit: "V",
    fallback: 5,
    range: "any",
    spiceNames: [],
    hint: "The supply voltage for a CMOS part.",
  },
  {
    key: "vol",
    label: "Output low",
    unit: "V",
    fallback: 0,
    range: "any",
    spiceNames: [],
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
    key: "slew",
    label: "Slew rate",
    unit: "V/µs",
    fallback: 0,
    range: "nonnegative",
    spiceNames: [],
    hint: "0 for no limit.",
  },
];

/**
 * Schmitt trigger parts; `polarity` is 1 for non-inverting and -1 for inverting. The
 * thresholds are datasheet typicals at the supply voltage in the name.
 */
const SCHMITT_PRESETS: readonly Preset[] = [
  { name: "Generic", isGeneric: true, polarity: 1, values: {} },
  { name: "Generic inverting", isGeneric: true, polarity: -1, values: {} },
  {
    name: "74HC14 (4.5 V)",
    polarity: -1,
    values: { vtp: 2.38, vtn: 1.4, voh: 4.5, vol: 0, rout: 45, slew: 500 },
  },
  {
    name: "CD40106 (5 V)",
    polarity: -1,
    values: { vtp: 2.9, vtn: 1.9, voh: 5, vol: 0, rout: 400, slew: 40 },
  },
  {
    name: "CD40106 (10 V)",
    polarity: -1,
    values: { vtp: 5.9, vtn: 3.9, voh: 10, vol: 0, rout: 190, slew: 160 },
  },
  {
    name: "CD40106 (15 V)",
    polarity: -1,
    values: { vtp: 8.8, vtn: 5.8, voh: 15, vol: 0, rout: 220, slew: 300 },
  },
];

/** Falstad writes the slew rate in V/ns; the model keeps it in V/µs. */
const MICROSECONDS_PER_NANOSECOND = 1000;

/**
 * A Schmitt trigger: a buffer or inverter whose input has hysteresis. The input draws no
 * current. It switches when it rises past the upper threshold or falls past the lower
 * one, at most once per time step, and between them the output keeps its level. The
 * output is a voltage source against ground behind the output resistance, as in Falstad.
 * Posts are the input and the output.
 */
export class SchmittTrigger extends CircuitElement {
  readonly kind = "schmitt-trigger";
  override readonly designatorPrefix = "U";
  protected override readonly usesExtendedFormat = true;
  /** 1 for non-inverting, -1 for inverting. */
  polarity = 1;
  readonly params = new ParamSet(SCHMITT_SPECS, SCHMITT_PRESETS);
  /** True once the input has risen past the upper threshold, until it falls past the lower. */
  isInputHigh = false;
  private hasFlipped = false;
  /** The driven voltage after the latest step, which the slew rate limits the next from. */
  private lastOutput = 0;

  static override read(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    flags: number,
    reader: TokenReader,
  ): CircuitElement {
    return new SchmittTrigger(x1, y1, x2, y2, flags).readValues(reader);
  }

  /** Reads Falstad's fields, then the model on lines Lunar Spice wrote. */
  protected readValues(reader: TokenReader) {
    const slew = reader.number(0.5) * MICROSECONDS_PER_NANOSECOND;
    const lower = reader.number(1.66);
    const upper = reader.number(3.33);
    const high = reader.number(5);
    const low = reader.number(0);

    this.params.applyGeneric(this.polarity);

    if ((this.flags & EXTENDED_FORMAT_FLAG) !== 0) {
      this.params.read(reader);
    } else {
      this.params.set("slew", slew);
      this.params.set("vtn", lower);
      this.params.set("vtp", upper);
      this.params.set("voh", high);
      this.params.set("vol", low);
    }

    return this;
  }

  /** Falstad's type: 182 for the buffer, 183 for the inverter. */
  get dumpType() {
    return this.polarity === 1 ? "182" : "183";
  }

  name() {
    return this.polarity === 1
      ? "Schmitt trigger"
      : "Inverting Schmitt trigger";
  }

  get isInverting() {
    return this.polarity !== 1;
  }

  /** Sets buffer (1) or inverter (-1); a generic model changes to the other generic part. */
  override setPolarity(polarity: number) {
    this.polarity = polarity;

    if (this.params.isGeneric) {
      this.params.applyGeneric(polarity);
    }
  }

  override valueLabel() {
    return this.params.isGeneric ? "" : this.params.modelName;
  }

  override internalNodeCount() {
    return this.params.get("rout") > 0 ? 1 : 0;
  }

  /** Returns the index in `nodes` of the ideal output, inside the output resistance. */
  private drivenIndex() {
    return this.params.get("rout") > 0 ? 2 : 1;
  }

  override branchCount() {
    return 1;
  }

  override isNonlinear() {
    return true;
  }

  override stamp(system: MnaSystem) {
    const rout = this.params.get("rout");

    system.stampVoltageSource(
      0,
      this.node(this.drivenIndex()),
      this.firstBranch,
    );

    if (rout > 0) {
      system.stampResistor(this.node(2), this.node(1), rout);
    }
  }

  override startStep() {
    this.hasFlipped = false;
  }

  /** Returns the input state the input voltage calls for; between thresholds it stays. */
  private desiredState() {
    const [input = 0] = this.volts;

    if (input > this.params.get("vtp")) {
      return true;
    }

    if (input < this.params.get("vtn")) {
      return false;
    }

    return this.isInputHigh;
  }

  /** Returns the level the output heads for: high or low by the input state. */
  private targetOutput() {
    return this.isInputHigh === this.isInverting
      ? this.params.get("vol")
      : this.params.get("voh");
  }

  override stampStep(system: MnaSystem) {
    const desired = this.desiredState();

    // Switch at most once per time step, so a loop around it cannot chatter.
    if (desired !== this.isInputHigh && !this.hasFlipped) {
      this.isInputHigh = desired;
      this.hasFlipped = true;
      system.converged = false;
    }

    let output = this.targetOutput();
    const slew = this.params.get("slew") * 1e6;

    // The slew rate limits how far the output moves in one time step.
    if (system.mode === "transient" && slew > 0) {
      const reach = slew * system.timeStep;

      output = Math.max(
        this.lastOutput - reach,
        Math.min(this.lastOutput + reach, output),
      );
    }

    system.stampVoltageValue(this.firstBranch, output);
  }

  override finishStep() {
    this.lastOutput = this.volts[this.drivenIndex()] ?? 0;
  }

  /** Returns one path: the output lead, with the current leaving the part. */
  override currentPaths() {
    return [this.current];
  }

  /** The branch current leaves through the output; the input draws none. */
  override currentIntoPost(post: number) {
    return post === 1 ? -this.current : 0;
  }

  override reset() {
    super.reset();
    this.isInputHigh = false;
    this.hasFlipped = false;
    this.lastOutput = 0;
  }

  override info() {
    const [input = 0, output = 0] = this.volts;

    return [
      this.title(),
      this.params.modelName,
      `Vin = ${formatSi(input, "V")}`,
      `Vout = ${formatSi(output, "V")}`,
      `Iout = ${formatSi(this.current, "A")}`,
      `Switches at ${formatSi(this.params.get("vtn"), "V")} and ${formatSi(this.params.get("vtp"), "V")}`,
    ];
  }

  override editFields(): EditField[] {
    return [
      {
        kind: "choice",
        key: "polarity",
        label: "Output",
        value: this.isInverting ? "inverting" : "non-inverting",
        options: [
          { value: "non-inverting", label: "Non-inverting" },
          { value: "inverting", label: "Inverting" },
        ],
        set: (value) => {
          this.setPolarity(value === "inverting" ? -1 : 1);
        },
      },
      ...this.params.fields(undefined, (name) => {
        this.polarity =
          this.params.applyPreset(name)?.polarity ?? this.polarity;
      }),
    ];
  }

  override dumpValues() {
    return [
      this.params.get("slew") / MICROSECONDS_PER_NANOSECOND,
      this.params.get("vtn"),
      this.params.get("vtp"),
      this.params.get("voh"),
      this.params.get("vol"),
      ...this.params.dump(),
    ];
  }
}

/** Falstad's type 183: the same part, inverting until told otherwise. */
export class InvertingSchmittTrigger extends SchmittTrigger {
  override polarity = -1;

  static override read(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    flags: number,
    reader: TokenReader,
  ): CircuitElement {
    return new InvertingSchmittTrigger(x1, y1, x2, y2, flags).readValues(
      reader,
    );
  }
}
