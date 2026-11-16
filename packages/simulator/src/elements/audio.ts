import { CircuitElement, type EditField, type TokenReader } from "../element";
import {
  type AcSystem,
  type AnalysisMode,
  type Handle,
  mispredicts,
  type MnaSystem,
} from "../mna-system";
import { ParamSet, type ParamSpec, type Preset } from "../params";
import { formatSi } from "../units";

/** Where a microphone's sound comes from, in the order of their file codes. */
const SOUND_INPUTS = [
  { value: "live", label: "Live microphone" },
  { value: "tone", label: "Test tone" },
] as const;

type SoundInput = (typeof SOUND_INPUTS)[number]["value"];

/**
 * Drain voltage over which the capsule's JFET leaves saturation. Below about twice this
 * the current falls toward zero, as when the bias supply is missing.
 */
const KNEE_VOLTAGE = 0.4;

const MICROPHONE_SPECS: readonly ParamSpec[] = [
  {
    key: "sensitivity",
    label: "Sensitivity",
    unit: "dBV/Pa",
    fallback: -44,
    range: "any",
    spiceNames: [],
    hint: "Output at 1 Pa (94 dB SPL) and 1 kHz, as the datasheet gives it.",
  },
  {
    key: "load",
    label: "Sensitivity load",
    unit: "Ω",
    fallback: 2200,
    range: "positive",
    spiceNames: [],
    hint: "The load resistor the datasheet measures sensitivity with.",
  },
  {
    key: "bias",
    label: "Current consumption",
    unit: "A",
    fallback: 5e-4,
    range: "positive",
    spiceNames: [],
    hint: "Drain current of the built-in JFET in silence.",
  },
];

const MICROPHONE_PRESETS: readonly Preset[] = [
  {
    name: "CMA-4544PF-W",
    values: { sensitivity: -44, load: 2200, bias: 5e-4 },
  },
  {
    name: "Generic electret",
    values: { sensitivity: -42, load: 2200, bias: 3e-4 },
  },
];

/**
 * An electret condenser microphone: the capsule drives the gate of a JFET inside the can,
 * so it behaves as a sound-controlled current sink from its + post to its − post. Like the
 * real part it needs a bias resistor to a supply; the output is the voltage at +. Sound
 * comes from the computer's microphone (`liveInput`) or a test tone. Analyses cannot hear
 * a live microphone, so they use the tone.
 */
export class Microphone extends CircuitElement {
  readonly kind = "microphone";
  readonly dumpType = "LSMIC";
  override readonly designatorPrefix = "MK";
  readonly params = new ParamSet(MICROPHONE_SPECS, MICROPHONE_PRESETS);
  sound: SoundInput = "live";
  toneFrequency = 1000;
  /** Peak pressure of the tone, and of a full-scale sample from the live input. */
  pressure = 1;
  /**
   * The live input's sample at a simulated time, from −1 to 1. Set by the interactive
   * simulation; null in analyses.
   */
  liveInput: ((time: number) => number) | null = null;
  /** The terminal voltage and drain current last linearized at, and the current and slope there. */
  private lastVoltage = 0;
  private lastDrain = 0;
  private lastCurrent = 0;
  private lastConductance = 0;
  /** Where it stamps: the rows of its two posts, and in each the two posts. */
  private plusRow: Handle = 0;
  private minusRow: Handle = 0;
  private plusFromPlus: Handle = 0;
  private plusFromMinus: Handle = 0;
  private minusFromPlus: Handle = 0;
  private minusFromMinus: Handle = 0;
  /** Drain current per pascal, and the sensitivity and load it was worked out from. */
  private gain = 0;
  private gainSensitivity = Number.NaN;
  private gainLoad = Number.NaN;
  /**
   * The drain current as last worked out, and the time, source level and mode it was for.
   * It depends on nothing else, so every stamp of a step reuses it.
   */
  private drain = 0;
  private drainTime = Number.NaN;
  private drainScale = Number.NaN;
  private drainMode: AnalysisMode | null = null;

  static override read(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    flags: number,
    reader: TokenReader,
  ) {
    const microphone = new Microphone(x1, y1, x2, y2, flags);

    microphone.sound = SOUND_INPUTS[reader.number(0)]?.value ?? "live";
    microphone.toneFrequency = reader.number(1000);
    microphone.pressure = reader.number(1);
    microphone.params.read(reader);

    return microphone;
  }

  name() {
    return "Electret microphone";
  }

  override valueLabel() {
    return this.params.modelName;
  }

  override isNonlinear() {
    return true;
  }

  override hasExactConvergenceTest() {
    return true;
  }

  override drivesAc() {
    return true;
  }

  /** Sound pressure at the capsule at `time`, in pascals. */
  pressureAt(time: number) {
    if (this.sound === "live" && this.liveInput) {
      return this.pressure * Math.max(-1, Math.min(1, this.liveInput(time)));
    }

    return this.pressure * Math.sin(2 * Math.PI * this.toneFrequency * time);
  }

  /** Drain current per pascal: the datasheet's output voltage across its load. */
  private currentPerPascal() {
    const { sensitivity = 0, load = 0 } = this.params.values;

    // Steps ask every time, and the power costs more than the rest of a step's model.
    if (sensitivity !== this.gainSensitivity || load !== this.gainLoad) {
      this.gain = 10 ** (sensitivity / 20) / load;
      this.gainSensitivity = sensitivity;
      this.gainLoad = load;
    }

    return this.gain;
  }

  /**
   * Works out the current through the microphone and its slope at `voltage`, for drain
   * current `drain`, into `lastCurrent` and `lastConductance`. The same voltage and drain
   * current as last time keep what is there.
   */
  private linearize(voltage: number, drain: number) {
    if (voltage === this.lastVoltage && drain === this.lastDrain) {
      return;
    }

    const saturation = Math.tanh(voltage / KNEE_VOLTAGE);

    this.lastVoltage = voltage;
    this.lastDrain = drain;
    this.lastCurrent = drain * saturation;
    this.lastConductance =
      (drain / KNEE_VOLTAGE) * (1 - saturation * saturation);
  }

  /** The JFET's saturated drain current at the system's time and source level. */
  private drainCurrent(system: MnaSystem) {
    const { mode, time, sourceScale } = system;

    if (
      time !== this.drainTime ||
      sourceScale !== this.drainScale ||
      mode !== this.drainMode
    ) {
      const pressure = mode === "dc" ? 0 : this.pressureAt(time);

      const drain = Math.max(
        0,
        (this.params.values.bias ?? 0) + this.currentPerPascal() * pressure,
      );

      this.drain = drain * sourceScale;
      this.drainTime = time;
      this.drainScale = sourceScale;
      this.drainMode = mode;
    }

    return this.drain;
  }

  override stamp(system: MnaSystem) {
    const plus = this.node(0);
    const minus = this.node(1);

    this.plusRow = system.rightSideRow(plus);
    this.minusRow = system.rightSideRow(minus);
    this.plusFromPlus = system.variableEntry(plus, plus);
    this.plusFromMinus = system.variableEntry(plus, minus);
    this.minusFromPlus = system.variableEntry(minus, plus);
    this.minusFromMinus = system.variableEntry(minus, minus);
  }

  override stampStep(system: MnaSystem) {
    const voltage = this.voltageDifference();

    const predicted =
      this.lastCurrent + this.lastConductance * (voltage - this.lastVoltage);

    this.linearize(voltage, this.drainCurrent(system));

    const current = this.lastCurrent;
    const conductance = this.lastConductance;

    if (mispredicts(current, predicted)) {
      system.converged = false;
    }

    const source = current - conductance * voltage;

    system.addEntry(this.plusFromPlus, conductance);
    system.addEntry(this.minusFromMinus, conductance);
    system.addEntry(this.plusFromMinus, -conductance);
    system.addEntry(this.minusFromPlus, -conductance);
    system.addRightSide(this.plusRow, -source);
    system.addRightSide(this.minusRow, source);
  }

  override finishStep(system: MnaSystem) {
    this.linearize(this.voltageDifference(), this.drainCurrent(system));
    this.current = this.lastCurrent;
  }

  /** Drives AC sweeps with its peak sound pressure at every frequency. */
  override stampAc(system: AcSystem) {
    const saturation = Math.tanh(this.voltageDifference() / KNEE_VOLTAGE);
    const current = this.currentPerPascal() * this.pressure * saturation;

    system.stampCurrentPhasor(this.node(0), this.node(1), current, 0);
  }

  override reset() {
    super.reset();
    this.lastVoltage = 0;
    this.lastDrain = 0;
    this.lastCurrent = 0;
    this.lastConductance = 0;
    this.drainTime = Number.NaN;
  }

  override info() {
    return [this.title(), this.params.modelName, ...this.readingLines()];
  }

  override editFields(): EditField[] {
    return [
      {
        kind: "choice",
        key: "sound",
        label: "Sound",
        value: this.sound,
        options: SOUND_INPUTS,
        hint: "Analyses always hear the test tone.",
        set: (value) => {
          this.sound =
            SOUND_INPUTS.find((input) => input.value === value)?.value ??
            this.sound;
        },
      },
      {
        kind: "number",
        key: "pressure",
        label: "Peak sound pressure",
        unit: "Pa",
        value: this.pressure,
        range: "positive",
        hint: "The tone's peak, and a full-scale live sample's. 1 Pa is 94 dB SPL.",
        set: (value) => {
          this.pressure = value;
        },
      },
      {
        kind: "number",
        key: "tone-frequency",
        label: "Tone frequency",
        unit: "Hz",
        value: this.toneFrequency,
        range: "positive",
        set: (value) => {
          this.toneFrequency = value;
        },
      },
      ...this.params.fields(),
    ];
  }

  override dumpValues() {
    return [
      SOUND_INPUTS.findIndex(({ value }) => value === this.sound),
      this.toneFrequency,
      this.pressure,
      ...this.params.dump(),
    ];
  }
}

const SPEAKER_SPECS: readonly ParamSpec[] = [
  {
    key: "impedance",
    label: "Impedance",
    unit: "Ω",
    fallback: 8,
    range: "positive",
    spiceNames: [],
  },
  {
    key: "power",
    label: "Rated power",
    unit: "W",
    fallback: 0.5,
    range: "positive",
    spiceNames: [],
    hint: "It plays at full volume at this power.",
  },
];

const SPEAKER_PRESETS: readonly Preset[] = [
  { name: "8 Ω 0.5 W speaker", values: { impedance: 8, power: 0.5 } },
  { name: "8 Ω 2 W speaker", values: { impedance: 8, power: 2 } },
  { name: "4 Ω 3 W speaker", values: { impedance: 4, power: 3 } },
  { name: "32 Ω headphones", values: { impedance: 32, power: 0.02 } },
];

/**
 * A loudspeaker: a resistive load of its rated impedance. The interactive simulation
 * plays the voltage across it through the computer's speakers, full scale at rated power.
 */
export class Speaker extends CircuitElement {
  readonly kind = "speaker";
  readonly dumpType = "LSSPK";
  override readonly designatorPrefix = "LS";
  readonly params = new ParamSet(SPEAKER_SPECS, SPEAKER_PRESETS);

  static override read(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    flags: number,
    reader: TokenReader,
  ) {
    const speaker = new Speaker(x1, y1, x2, y2, flags);

    speaker.params.read(reader);

    return speaker;
  }

  name() {
    return "Speaker";
  }

  override valueLabel() {
    return formatSi(this.params.get("impedance"), "Ω");
  }

  override stamp(system: MnaSystem) {
    system.stampResistor(
      this.node(0),
      this.node(1),
      this.params.get("impedance"),
    );
  }

  override finishStep() {
    this.current =
      this.voltageDifference() / (this.params.values.impedance ?? 0);
  }

  /** The sound it plays, from −1 to 1 at its rated power; louder values clip. */
  soundLevel() {
    const { power = 0, impedance = 0 } = this.params.values;

    return this.voltageDifference() / Math.sqrt(2 * power * impedance);
  }

  override info() {
    return [this.title(), this.params.modelName, ...this.readingLines()];
  }

  override editFields(): EditField[] {
    return this.params.fields();
  }

  override dumpValues() {
    return this.params.dump();
  }
}
