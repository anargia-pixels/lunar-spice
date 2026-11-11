import {
  CircuitElement,
  type EditField,
  EXTENDED_FORMAT_FLAG,
  type TokenReader,
} from "../element";
import type { Point } from "../geometry";
import type { AcSystem, MnaSystem } from "../mna-system";
import { formatSi } from "../units";

/** Source waveforms, in the order of Falstad's waveform codes. */
const WAVEFORMS = [
  "dc",
  "sine",
  "square",
  "triangle",
  "sawtooth",
  "pulse",
] as const;

type Waveform = (typeof WAVEFORMS)[number];

const WAVEFORM_LABELS: Record<Waveform, string> = {
  dc: "DC",
  sine: "Sine",
  square: "Square",
  triangle: "Triangle",
  sawtooth: "Sawtooth",
  pulse: "Pulse",
};

const TWO_PI = 2 * Math.PI;

/** Wraps a phase `value` into [0, 2π). */
function wrapPhase(value: number) {
  return ((value % TWO_PI) + TWO_PI) % TWO_PI;
}

/**
 * An independent voltage source. Its second post is the positive terminal. Waveforms
 * other than DC swing `amplitude` around `bias`; DC sources output `amplitude + bias`.
 */
export class VoltageSource extends CircuitElement {
  readonly kind: "voltage-source" | "rail" = "voltage-source";
  readonly dumpType: string = "v";
  override readonly designatorPrefix = "V";
  protected override readonly usesExtendedFormat = true;
  waveform: Waveform = "dc";
  /** Internal resistance in series with the positive terminal, such as a battery's. */
  seriesResistance = 0;
  amplitude = 5;
  bias = 0;
  frequency = 40;
  /** Phase in radians, as Falstad stores it. */
  phase = 0;
  dutyCycle = 0.5;

  /** Reads the values Falstad writes after a voltage source's flags. */
  readValues(reader: TokenReader) {
    this.waveform = WAVEFORMS[reader.number(0)] ?? "dc";
    this.frequency = reader.number(40);
    this.amplitude = reader.number(5);
    this.bias = reader.number(0);
    this.phase = reader.number(0);
    this.dutyCycle = reader.number(0.5);

    if ((this.flags & EXTENDED_FORMAT_FLAG) !== 0) {
      this.seriesResistance = reader.number(0);
    }

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
    return new VoltageSource(x1, y1, x2, y2, flags).readValues(reader);
  }

  name() {
    return this.waveform === "dc"
      ? "DC voltage source"
      : `${WAVEFORM_LABELS[this.waveform]} voltage source`;
  }

  /** Returns the source's voltage at `time`, or its DC value when `isDc` is true. */
  voltageAt(time: number, isDc: boolean) {
    if (this.waveform === "dc") {
      return this.amplitude + this.bias;
    }

    if (isDc) {
      return this.bias;
    }

    const phase = wrapPhase(TWO_PI * this.frequency * time + this.phase);

    switch (this.waveform) {
      case "sine":
        return Math.sin(phase) * this.amplitude + this.bias;
      case "square":
        return (
          this.bias +
          (phase > TWO_PI * this.dutyCycle ? -this.amplitude : this.amplitude)
        );
      case "triangle":
        return (
          this.bias +
          this.amplitude *
            (phase < Math.PI
              ? (phase * 2) / Math.PI - 1
              : 1 - ((phase - Math.PI) * 2) / Math.PI)
        );
      case "sawtooth":
        return this.bias + (phase * this.amplitude) / Math.PI - this.amplitude;
      case "pulse":
        return phase < TWO_PI * this.dutyCycle
          ? this.amplitude + this.bias
          : this.bias;
    }
  }

  override valueLabel() {
    if (this.waveform === "dc") {
      return formatSi(this.amplitude + this.bias, "V");
    }

    return `${formatSi(this.amplitude, "V")} ${formatSi(this.frequency, "Hz")}`;
  }

  override branchCount() {
    return 1;
  }

  override internalNodeCount() {
    return this.seriesResistance > 0 ? 1 : 0;
  }

  /** Returns the node the ideal source drives: inside the series resistance, if any. */
  protected drivenNode(post: number) {
    return this.seriesResistance > 0
      ? this.node(this.posts().length)
      : this.node(post);
  }

  /** Stamps the series resistance between the driven node and `post`. */
  protected stampSeriesResistance(system: MnaSystem, post: number) {
    if (this.seriesResistance > 0) {
      system.stampResistor(
        this.drivenNode(post),
        this.node(post),
        this.seriesResistance,
      );
    }
  }

  override stamp(system: MnaSystem) {
    system.stampVoltageSource(
      this.node(0),
      this.drivenNode(1),
      this.firstBranch,
    );
    this.stampSeriesResistance(system, 1);
  }

  override stampStep(system: MnaSystem) {
    system.stampVoltageValue(
      this.firstBranch,
      this.voltageAt(system.time, system.mode === "dc") * system.sourceScale,
    );
  }

  override isSource() {
    return true;
  }

  override drivesAc() {
    return this.waveform === "sine";
  }

  /** Sine sources drive AC sweeps with their amplitude and phase; others are AC ground. */
  override stampAc(system: AcSystem) {
    if (this.waveform === "sine") {
      system.stampSourcePhasor(
        this.firstBranch,
        this.amplitude * Math.cos(this.phase),
        this.amplitude * Math.sin(this.phase),
      );
    }
  }

  override info() {
    return [this.title(), ...this.readingLines()];
  }

  /** Returns the positive terminal's voltage minus the negative terminal's. */
  override voltageDifference() {
    return (this.volts[1] ?? 0) - (this.volts[0] ?? 0);
  }

  override editFields(): EditField[] {
    const fields: EditField[] = [
      {
        kind: "choice",
        key: "waveform",
        label: "Waveform",
        value: this.waveform,
        options: WAVEFORMS.map((waveform) => ({
          value: waveform,
          label: WAVEFORM_LABELS[waveform],
        })),
        set: (value) => {
          this.waveform =
            WAVEFORMS.find((waveform) => waveform === value) ?? "dc";
        },
      },
    ];

    const seriesResistance: EditField = {
      kind: "number",
      key: "series-resistance",
      label: "Internal resistance",
      unit: "Ω",
      value: this.seriesResistance,
      range: "nonnegative",
      hint: "Such as a battery's internal resistance; 0 for an ideal source.",
      set: (value) => {
        this.seriesResistance = value;
      },
    };

    if (this.waveform === "dc") {
      fields.push(
        {
          kind: "number",
          key: "voltage",
          label: "Voltage",
          unit: "V",
          value: this.amplitude + this.bias,
          range: "any",
          set: (value) => {
            this.amplitude = value;
            this.bias = 0;
          },
        },
        seriesResistance,
      );

      return fields;
    }

    fields.push(
      {
        kind: "number",
        key: "amplitude",
        label: "Amplitude",
        unit: "V",
        value: this.amplitude,
        range: "any",
        set: (value) => {
          this.amplitude = value;
        },
      },
      {
        kind: "number",
        key: "frequency",
        label: "Frequency",
        unit: "Hz",
        value: this.frequency,
        range: "positive",
        set: (value) => {
          this.frequency = value;
        },
      },
      {
        kind: "number",
        key: "bias",
        label: "DC offset",
        unit: "V",
        value: this.bias,
        range: "any",
        set: (value) => {
          this.bias = value;
        },
      },
      {
        kind: "number",
        key: "phase",
        label: "Phase",
        unit: "°",
        value: (this.phase * 180) / Math.PI,
        range: "any",
        set: (value) => {
          this.phase = (value * Math.PI) / 180;
        },
      },
    );

    if (this.waveform === "square" || this.waveform === "pulse") {
      fields.push({
        kind: "number",
        key: "duty",
        label: "Duty cycle",
        unit: "%",
        value: this.dutyCycle * 100,
        range: "any",
        set: (value) => {
          this.dutyCycle = Math.min(1, Math.max(0, value / 100));
        },
      });
    }

    fields.push(seriesResistance);

    return fields;
  }

  override dumpValues() {
    return [
      WAVEFORMS.indexOf(this.waveform),
      this.frequency,
      this.amplitude,
      this.bias,
      this.phase,
      this.dutyCycle,
      this.seriesResistance, // Extended format only; Falstad stops at the duty cycle.
    ];
  }
}

/**
 * A voltage rail: one post held at the source's voltage above ground. The second point
 * only places the label.
 */
export class Rail extends VoltageSource {
  override readonly kind = "rail";
  override readonly dumpType = "R";

  static override read(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    flags: number,
    reader: TokenReader,
  ) {
    return new Rail(x1, y1, x2, y2, flags).readValues(reader);
  }

  override name() {
    return this.waveform === "dc" ? "Voltage rail" : "AC voltage rail";
  }

  /** True: a rail drives its post against ground, which it stamps as node 0. */
  override referencesGround() {
    return true;
  }

  /** Returns its voltage, or an AC rail's amplitude and a ~, short enough for its tip. */
  override valueLabel() {
    return this.waveform === "dc"
      ? super.valueLabel()
      : `${formatSi(this.amplitude, "V")} ~`;
  }

  override posts(): Point[] {
    return [this.start];
  }

  override stamp(system: MnaSystem) {
    system.stampVoltageSource(0, this.drivenNode(0), this.firstBranch);
    this.stampSeriesResistance(system, 0);
  }

  /** The source current flows from ground out of the post into the circuit. */
  override currentIntoPost() {
    return -this.current;
  }

  /** Returns the post's voltage above ground. */
  override voltageDifference() {
    return this.volts[0] ?? 0;
  }
}

/** A DC current source pushing current in at its first post and out of its second. */
export class CurrentSource extends CircuitElement {
  readonly kind = "current-source";
  readonly dumpType = "i";
  override readonly designatorPrefix = "I";
  sourceCurrent = 0.01;

  override isSource() {
    return true;
  }

  static override read(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    flags: number,
    reader: TokenReader,
  ) {
    const source = new CurrentSource(x1, y1, x2, y2, flags);

    source.sourceCurrent = reader.number(0.01);

    return source;
  }

  name() {
    return "Current source";
  }

  override valueLabel() {
    return formatSi(this.sourceCurrent, "A");
  }

  override stampStep(system: MnaSystem) {
    system.stampCurrentSource(
      this.node(0),
      this.node(1),
      this.sourceCurrent * system.sourceScale,
    );
  }

  override finishStep(system: MnaSystem) {
    this.current = this.sourceCurrent * system.sourceScale;
  }

  override info() {
    return [this.title(), ...this.readingLines()];
  }

  override editFields(): EditField[] {
    return [
      {
        kind: "number",
        key: "current",
        label: "Current",
        unit: "A",
        value: this.sourceCurrent,
        range: "any",
        set: (value) => {
          this.sourceCurrent = value;
        },
      },
    ];
  }

  override dumpValues() {
    return [this.sourceCurrent];
  }
}
