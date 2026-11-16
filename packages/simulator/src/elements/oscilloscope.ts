import { CircuitElement, type TokenReader } from "../element";
import { type Point, snapToGrid } from "../geometry";
import { formatSi } from "../units";

/** How many inputs an oscilloscope has, besides its common. */
export const OSCILLOSCOPE_CHANNELS = 4;

/** The posts: CH1 to CH4 down the left side, COM under the body's middle, from its top-left. */
export const OSCILLOSCOPE_PINS = [
  { name: "CH1", x: -16, y: 16 },
  { name: "CH2", x: -16, y: 48 },
  { name: "CH3", x: -16, y: 80 },
  { name: "CH4", x: -16, y: 112 },
  { name: "COM", x: 64, y: 144 },
] as const;

/** Width and height of the body, from its first point. */
export const OSCILLOSCOPE_SIZE = { width: 128, height: 128 } as const;

/** The common post's index, after the channels. */
const COMMON = OSCILLOSCOPE_CHANNELS;

/** The volts per division the vertical scale offers, 1-2-5 from 1 mV to 50 V. */
export const VOLTS_PER_DIVISION: readonly number[] = [
  1e-3, 2e-3, 5e-3, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50,
];

/** The seconds per division the horizontal scale offers, 1-2-5 from 100 ns to 1 s. */
export const SECONDS_PER_DIVISION: readonly number[] = [
  1e-7, 2e-7, 5e-7, 1e-6, 2e-6, 5e-6, 1e-5, 2e-5, 5e-5, 1e-4, 2e-4, 5e-4, 1e-3,
  2e-3, 5e-3, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1,
];

/** Divisions across the screen, and from its middle to either side. */
export const HORIZONTAL_DIVISIONS = 10;

/** Divisions up the screen. */
export const VERTICAL_DIVISIONS = 8;

export const TRIGGER_EDGES = ["rising", "falling"] as const;

export type TriggerEdge = (typeof TRIGGER_EDGES)[number];

/**
 * When the screen shows a new trace: Auto at every trigger, or untriggered once none
 * comes; Normal only at a trigger; Single at the next trigger, then it stops.
 */
export const TRIGGER_MODES = ["auto", "normal", "single"] as const;

export type TriggerMode = (typeof TRIGGER_MODES)[number];

/** What a measurement reads off a channel's trace, in menu order. */
export const MEASUREMENT_KINDS = [
  "frequency",
  "period",
  "peak-to-peak",
  "maximum",
  "minimum",
  "mean",
  "rms",
  "duty",
] as const;

export type MeasurementKind = (typeof MEASUREMENT_KINDS)[number];

/** The most measurements the screen lists. */
export const MAX_MEASUREMENTS = 8;

export type OscilloscopeChannel = {
  isOn: boolean;
  voltsPerDivision: number;
  /** Divisions the channel's 0 V sits above the middle of the screen. */
  position: number;
};

export type Measurement = { channel: number; kind: MeasurementKind };

/** Its front panel, saved in the circuit file. */
export type OscilloscopeSettings = {
  channels: readonly OscilloscopeChannel[];
  secondsPerDivision: number;
  /** Divisions the trigger point sits right of the middle of the screen. */
  position: number;
  /** The channel whose voltage triggers, from 0 for CH1. */
  triggerSource: number;
  triggerEdge: TriggerEdge;
  /** In volts, against COM like the channel. */
  triggerLevel: number;
  triggerMode: TriggerMode;
  measurements: readonly Measurement[];
};

/** A new oscilloscope's front panel: CH1 and CH2 on at 1 V/div, 1 ms/div. */
export function defaultOscilloscopeSettings(): OscilloscopeSettings {
  return {
    channels: Array.from({ length: OSCILLOSCOPE_CHANNELS }, (_, index) => ({
      isOn: index < 2,
      voltsPerDivision: 1,
      position: 0,
    })),
    secondsPerDivision: 1e-3,
    position: 0,
    triggerSource: 0,
    triggerEdge: "rising",
    triggerLevel: 0,
    triggerMode: "auto",
    measurements: [
      { channel: 0, kind: "frequency" },
      { channel: 0, kind: "peak-to-peak" },
    ],
  };
}

/** `value` held to `low` through `high`. */
function clamp(value: number, low: number, high: number) {
  return Math.min(high, Math.max(low, value));
}

/** The whole number `value` held to the indexes of a list of `length`. */
function indexIn(value: number, length: number) {
  return clamp(Math.round(value), 0, length - 1);
}

/** A positive value read from a file, or `fallback` for anything else. */
function positive(value: number, fallback: number) {
  return value > 0 ? value : fallback;
}

/** Reads the front panel in the order `dumpSettings` writes it. */
function readSettings(reader: TokenReader): OscilloscopeSettings {
  const defaults = defaultOscilloscopeSettings();

  const secondsPerDivision = positive(
    reader.number(defaults.secondsPerDivision),
    defaults.secondsPerDivision,
  );

  const position = clamp(reader.number(0), -5, 5);
  const triggerSource = indexIn(reader.number(0), OSCILLOSCOPE_CHANNELS);
  const triggerEdge = TRIGGER_EDGES[indexIn(reader.number(0), 2)] ?? "rising";
  const triggerLevel = reader.number(0);

  const triggerMode =
    TRIGGER_MODES[indexIn(reader.number(0), TRIGGER_MODES.length)] ?? "auto";

  const channels = defaults.channels.map((channel) => ({
    isOn: reader.number(channel.isOn ? 1 : 0) !== 0,
    voltsPerDivision: positive(reader.number(1), 1),
    position: clamp(reader.number(0), -VERTICAL_DIVISIONS, VERTICAL_DIVISIONS),
  }));

  // A line without measurements keeps the default ones.
  const count = Math.round(reader.number(-1));

  const measurements =
    count < 0
      ? defaults.measurements
      : Array.from({ length: Math.min(count, MAX_MEASUREMENTS) }, () => ({
          channel: indexIn(reader.number(0), OSCILLOSCOPE_CHANNELS),
          kind:
            MEASUREMENT_KINDS[
              indexIn(reader.number(0), MEASUREMENT_KINDS.length)
            ] ?? "frequency",
        }));

  return {
    channels,
    secondsPerDivision,
    position,
    triggerSource,
    triggerEdge,
    triggerLevel,
    triggerMode,
    measurements,
  };
}

/** The front panel as file tokens. */
function dumpSettings(settings: OscilloscopeSettings) {
  return [
    settings.secondsPerDivision,
    settings.position,
    settings.triggerSource,
    TRIGGER_EDGES.indexOf(settings.triggerEdge),
    settings.triggerLevel,
    TRIGGER_MODES.indexOf(settings.triggerMode),
    ...settings.channels.flatMap(({ isOn, voltsPerDivision, position }) => [
      isOn ? 1 : 0,
      voltsPerDivision,
      position,
    ]),
    settings.measurements.length,
    ...settings.measurements.flatMap(({ channel, kind }) => [
      channel,
      MEASUREMENT_KINDS.indexOf(kind),
    ]),
  ];
}

/**
 * A four-channel bench oscilloscope. Each channel reads its input against COM, which
 * floats like a differential probe's; tie COM to ground for ground-referenced traces.
 * It draws no current. Its front panel, the scales, trigger and measurements, is saved
 * on its line; the interactive simulation records its traces.
 */
export class Oscilloscope extends CircuitElement {
  readonly kind = "oscilloscope";
  readonly dumpType = "LSOSC";
  override readonly designatorPrefix = "XSC";
  protected override readonly usesExtendedFormat = true;
  settings = defaultOscilloscopeSettings();

  /** Keeps the body `OSCILLOSCOPE_SIZE` from the first point, whatever the second says. */
  constructor(x1: number, y1: number, _x2: number, _y2: number, flags = 0) {
    super(
      x1,
      y1,
      x1 + OSCILLOSCOPE_SIZE.width,
      y1 + OSCILLOSCOPE_SIZE.height,
      flags,
    );
  }

  static override read(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    flags: number,
    reader: TokenReader,
  ) {
    const oscilloscope = new Oscilloscope(x1, y1, x2, y2, flags);

    oscilloscope.settings = readSettings(reader);

    return oscilloscope;
  }

  name() {
    return "Oscilloscope";
  }

  override posts(): Point[] {
    return OSCILLOSCOPE_PINS.map(({ x, y }) => ({
      x: this.x1 + x,
      y: this.y1 + y,
    }));
  }

  /** Moves the body about its middle for a turn or flip, but keeps it upright. */
  override transform(map: (point: Point) => Point) {
    const center = map({
      x: this.x1 + OSCILLOSCOPE_SIZE.width / 2,
      y: this.y1 + OSCILLOSCOPE_SIZE.height / 2,
    });

    this.translate(
      snapToGrid(center.x - OSCILLOSCOPE_SIZE.width / 2) - this.x1,
      snapToGrid(center.y - OSCILLOSCOPE_SIZE.height / 2) - this.y1,
    );
  }

  /** Channel `channel`'s voltage against COM after the latest step. */
  channelVoltage(channel: number) {
    return (this.volts[channel] ?? 0) - (this.volts[COMMON] ?? 0);
  }

  override info() {
    return [
      this.title(),
      ...this.settings.channels.flatMap((channel, index) =>
        channel.isOn
          ? [`CH${index + 1} = ${formatSi(this.channelVoltage(index), "V")}`]
          : [],
      ),
    ];
  }

  override dumpValues() {
    return dumpSettings(this.settings);
  }
}
