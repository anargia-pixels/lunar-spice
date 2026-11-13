/** What a signal meter reads over its latest window. */
export type SignalReading = {
  peakToPeak: number;
  /** The average, as a DC voltmeter reads it. */
  dc: number;
  /** The true RMS, DC included. */
  rms: number;
  /** In hertz; null when the signal does not repeat within the longest window. */
  frequency: number | null;
};

/**
 * A window ends at the first rising crossing after this many steps, so fast signals are
 * read over many whole cycles and the reading holds steady.
 */
const MIN_WINDOW_STEPS = 2000;

/**
 * A window with no rising crossing ends after this many steps and reads with no
 * frequency, as for DC. At the interactive 40 000 steps a second, that is one second.
 */
const MAX_WINDOW_STEPS = 40_000;

/** Half the trigger's hysteresis band, as a fraction of the peak-to-peak. */
const HYSTERESIS = 0.05;

/** The smallest half band, in the signal's unit, so a flat signal never triggers. */
const MIN_HYSTERESIS = 1e-6;

/** Sums over the window being filled. */
type Window = {
  low: number;
  high: number;
  /** Integral of the value over time. */
  area: number;
  /** Integral of the value squared over time. */
  squareArea: number;
  duration: number;
  steps: number;
};

function emptyWindow(): Window {
  return {
    low: Number.POSITIVE_INFINITY,
    high: Number.NEGATIVE_INFINITY,
    area: 0,
    squareArea: 0,
    duration: 0,
    steps: 0,
  };
}

function readWindow(window: Window, frequency: number | null): SignalReading {
  const { low, high, area, squareArea, duration } = window;

  return {
    peakToPeak: high - low,
    dc: area / duration,
    rms: Math.sqrt(Math.max(0, squareArea / duration)),
    frequency,
  };
}

/**
 * Measures a sampled signal the way a scope's or Multisim probe's readout does: it
 * triggers on rising crossings of the middle of the signal and reads whole cycles, so
 * the average and RMS carry no partial cycle. Feed it one sample per simulation step.
 */
export class SignalMeter {
  private window = emptyWindow();
  /**
   * The range the trigger level sits in the middle of: the last window's extremes, or
   * every sample so far before the first window ends.
   */
  private range = emptyWindow();
  private latest: SignalReading | null = null;
  private previous: number | null = null;
  private time = 0;
  /** When the window's first rising crossing came; null before it. */
  private windowStart: number | null = null;
  private cycles = 0;
  /** True once the signal has dropped below the trigger band since the last crossing. */
  private isArmed = false;

  /** The latest whole window's reading, or the window so far before the first one ends. */
  get reading(): SignalReading | null {
    if (this.latest) {
      return this.latest;
    }

    return this.window.duration > 0 ? readWindow(this.window, null) : null;
  }

  /** Records `value`, held for `timeStep` seconds. */
  add(value: number, timeStep: number) {
    if (!Number.isFinite(value) || !(timeStep > 0)) {
      return;
    }

    const { window, range, previous } = this;

    this.previous = value;
    this.time += timeStep;
    window.low = Math.min(window.low, value);
    window.high = Math.max(window.high, value);
    window.area += value * timeStep;
    window.squareArea += value * value * timeStep;
    window.duration += timeStep;
    window.steps += 1;

    if (!this.latest) {
      range.low = Math.min(range.low, value);
      range.high = Math.max(range.high, value);
    }

    const level = (range.low + range.high) / 2;

    const band = Math.max(
      MIN_HYSTERESIS,
      HYSTERESIS * (range.high - range.low),
    );

    if (value < level - band) {
      this.isArmed = true;
    } else if (this.isArmed && previous !== null && value >= level + band) {
      this.isArmed = false;

      // Interpolate where between the two samples it rose through the band's top.
      const rise = value - previous;
      const past = rise > 0 ? Math.min(1, (value - level - band) / rise) : 0;

      this.crossed(this.time - timeStep * past);
    }

    if (this.window.steps >= MAX_WINDOW_STEPS) {
      this.finish(null);
      this.windowStart = null;
    }
  }

  /** Forgets every sample, as when the simulation starts again from 0 s. */
  reset() {
    this.window = emptyWindow();
    this.range = emptyWindow();
    this.latest = null;
    this.previous = null;
    this.time = 0;
    this.windowStart = null;
    this.cycles = 0;
    this.isArmed = false;
  }

  private crossed(time: number) {
    if (this.windowStart === null) {
      // The first crossing starts a window of whole cycles.
      this.windowStart = time;
      this.cycles = 0;
      this.window = emptyWindow();

      return;
    }

    this.cycles += 1;

    if (this.window.steps >= MIN_WINDOW_STEPS) {
      this.finish(this.cycles / (time - this.windowStart));
      this.windowStart = time;
      this.cycles = 0;
    }
  }

  /** Publishes the window's reading and starts the next window. */
  private finish(frequency: number | null) {
    this.latest = readWindow(this.window, frequency);
    this.range = { ...this.window };
    this.window = emptyWindow();
  }
}
