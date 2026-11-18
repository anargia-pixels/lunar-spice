import {
  AC_COUPLING_CORNER,
  HORIZONTAL_DIVISIONS,
  type MeasurementKind,
  OSCILLOSCOPE_CHANNELS,
  type Oscilloscope,
  type OscilloscopeSettings,
  SECONDS_PER_DIVISION,
  VERTICAL_DIVISIONS,
  VOLTS_PER_DIVISION,
} from "@lunar-spice/simulator/elements/oscilloscope";
import { SignalMeter } from "@lunar-spice/simulator/signal-meter";

/** Buckets across one screen; each holds its steps' extremes, average and mean square. */
const BUCKETS_PER_SCREEN = 500;

/**
 * Buckets the recorder keeps: up to a screen before the trigger and a screen after it,
 * and a bucket either side so the trace runs off both edges.
 */
const RING_BUCKETS = 2 * BUCKETS_PER_SCREEN + 4;

/** Half the trigger's hysteresis band, in divisions of the source channel. */
const TRIGGER_HYSTERESIS = 0.05;

/** Half the band a measurement's crossings must clear, as a fraction of peak-to-peak. */
const MEASUREMENT_HYSTERESIS = 0.05;

/** One channel's buckets in a trace, oldest first. */
export type ChannelTrace = {
  /** Two entries per bucket: its lowest and highest value, the earlier first. */
  extremes: Float32Array<ArrayBuffer>;
  /** Each bucket's average over its steps. */
  means: Float32Array<ArrayBuffer>;
  /** Each bucket's mean square over its steps. */
  squares: Float32Array<ArrayBuffer>;
};

/**
 * A screenful of an oscilloscope's recording. Times are simulated seconds; bucket `k`
 * covers the `bucketTime` up to `firstEnd + k × bucketTime`, and its extremes are drawn
 * there.
 */
export type OscilloscopeTrace = {
  firstEnd: number;
  bucketTime: number;
  /** The simulation's time step; a bucket holds `bucketTime / timeStep` steps. */
  timeStep: number;
  count: number;
  /** When the trigger fired; null for an untriggered trace, which ends at the latest step. */
  triggerTime: number | null;
  /** The times at the screen's left and right edges. */
  start: number;
  end: number;
  /** By channel; null for a channel that is off. */
  channels: readonly (ChannelTrace | null)[];
};

/** A bucket being filled. */
type Pending = {
  low: number;
  high: number;
  isHighLater: boolean;
  area: number;
  squareArea: number;
};

function emptyPending(): Pending {
  return {
    low: Number.POSITIVE_INFINITY,
    high: Number.NEGATIVE_INFINITY,
    isHighLater: false,
    area: 0,
    squareArea: 0,
  };
}

/** Empties `pending` in place: a bucket fills every few steps, too often to allocate. */
function resetPending(pending: Pending) {
  pending.low = Number.POSITIVE_INFINITY;
  pending.high = Number.NEGATIVE_INFINITY;
  pending.isHighLater = false;
  pending.area = 0;
  pending.squareArea = 0;
}

/** One channel's ring of buckets. */
type ChannelRing = {
  extremes: Float32Array;
  means: Float32Array;
  squares: Float32Array;
  pending: Pending;
};

function createRing(): ChannelRing {
  return {
    extremes: new Float32Array(2 * RING_BUCKETS),
    means: new Float32Array(RING_BUCKETS),
    squares: new Float32Array(RING_BUCKETS),
    pending: emptyPending(),
  };
}

/** An AC-coupled channel's series capacitor: the input it last passed and its output. */
type Coupler = { input: number; output: number };

/** Seconds across the whole screen. */
export function screenTime(settings: OscilloscopeSettings) {
  return settings.secondsPerDivision * HORIZONTAL_DIVISIONS;
}

/** The shortest simulated time Auto waits for a trigger, in seconds. */
const MIN_AUTO_TIMEOUT = 0.05;

/**
 * How long Auto waits for a trigger before it shows the untriggered trace: two screens,
 * or 50 ms for short ones. It counts simulated time, so a circuit run slower than real
 * time triggers as steadily as one at 1×.
 */
export function autoTimeout(settings: OscilloscopeSettings) {
  return Math.max(2 * screenTime(settings), MIN_AUTO_TIMEOUT);
}

/**
 * Screens at least this long, 50 ms a division, roll in Auto: a trigger would leave them
 * blank for seconds, so the latest trace scrolls in from the right instead.
 */
export const ROLL_SCREEN = 0.5;

/**
 * Records one oscilloscope in the interactive simulation, the way a digital scope
 * acquires: every step goes into a ring of buckets, and a trigger, found between steps,
 * freezes a screenful around it. A frozen trace waits until a snapshot takes it before
 * the trigger arms again, so a fast signal costs one copy a frame. Each channel's meter
 * reads it over whole cycles for autoset. Everything past the input sees the channel
 * after its coupling, as on a bench scope.
 */
export class OscilloscopeRecorder {
  readonly elementId: number;
  readonly meters = Array.from(
    { length: OSCILLOSCOPE_CHANNELS },
    () => new SignalMeter(),
  );

  private settings: OscilloscopeSettings;
  private timeStep: number;
  private stepsPerBucket = 1;
  private readonly rings = Array.from(
    { length: OSCILLOSCOPE_CHANNELS },
    createRing,
  );

  /** By channel; null until an AC-coupled channel has seen its first value. */
  private readonly couplers: (Coupler | null)[] = Array.from(
    { length: OSCILLOSCOPE_CHANNELS },
    () => null,
  );

  private pendingSteps = 0;
  /** Buckets written since the recording started. */
  private buckets = 0;
  /** When the first bucket started; null until a step comes. */
  private origin: number | null = null;
  /** The source's previous value, signed so the edge always rises; null after a clear. */
  private previous: number | null = null;
  /** True once the source has dropped below the trigger band since the last trigger. */
  private isArmed = false;
  /** When the trigger fired for the trace being collected; null while none is. */
  private firing: number | null = null;
  /** A frozen trace waiting for a snapshot. */
  private frozen: OscilloscopeTrace | null = null;
  /** When the trigger last fired; null since the last clear. */
  private lastFire: number | null = null;

  constructor(
    elementId: number,
    settings: OscilloscopeSettings,
    timeStep: number,
  ) {
    this.elementId = elementId;
    this.settings = settings;
    this.timeStep = timeStep;
    this.stepsPerBucket = this.bucketSteps();
  }

  private bucketSteps() {
    return Math.max(
      1,
      // Rounding must not push an exact ratio, such as 2 ms in 1 µs steps, up a step.
      Math.ceil(
        (screenTime(this.settings) / this.timeStep / BUCKETS_PER_SCREEN) *
          (1 - 1e-9),
      ),
    );
  }

  private get bucketTime() {
    return this.stepsPerBucket * this.timeStep;
  }

  /**
   * Follows a new front panel or time step. A new time base or step starts the recording
   * over, since buckets then cover another number of steps; so does a channel turned on
   * or off. A new coupling starts its channel's capacitor and meter afresh.
   */
  configure(settings: OscilloscopeSettings, timeStep: number) {
    // A channel turned on would show what its ring held before it went off.
    const isNewBase =
      timeStep !== this.timeStep ||
      settings.secondsPerDivision !== this.settings.secondsPerDivision ||
      settings.channels.some(
        (channel, index) =>
          channel.isOn !== this.settings.channels[index]?.isOn,
      );

    const isNewCoupling = settings.channels.map(
      (channel, index) =>
        channel.coupling !== this.settings.channels[index]?.coupling,
    );

    const isNewTrigger =
      settings.triggerSource !== this.settings.triggerSource ||
      settings.triggerEdge !== this.settings.triggerEdge ||
      isNewCoupling[settings.triggerSource] === true;

    for (const [channel, isNew] of isNewCoupling.entries()) {
      if (isNew) {
        this.couplers[channel] = null;
        this.meters[channel]?.reset();
      }
    }

    this.settings = settings;
    this.timeStep = timeStep;

    if (isNewBase) {
      this.clear();
    } else if (isNewTrigger) {
      this.previous = null;
      this.isArmed = false;
    }
  }

  /** Follows a new time step, which starts the recording over. */
  retime(timeStep: number) {
    this.configure(this.settings, timeStep);
  }

  /** Drops the recording, as when the simulation starts again from 0 s. */
  clear() {
    this.stepsPerBucket = this.bucketSteps();
    this.pendingSteps = 0;
    this.buckets = 0;
    this.origin = null;
    this.previous = null;
    this.isArmed = false;
    this.firing = null;
    this.frozen = null;
    this.lastFire = null;

    for (const ring of this.rings) {
      resetPending(ring.pending);
    }
  }

  /** Forgets the meters' readings and the coupling capacitors along with the recording. */
  restart() {
    this.clear();
    this.couplers.fill(null);

    for (const meter of this.meters) {
      meter.reset();
    }
  }

  /**
   * Channel `channel`'s `value` as its coupling passes it on. AC is a first-order
   * high-pass at `AC_COUPLING_CORNER`, stepped by the trapezoidal rule, which keeps a
   * signal's amplitude at a few dozen steps a cycle where backward Euler shrinks it; its
   * capacitor starts charged to the first value it sees, so a steady input reads 0 V.
   */
  private couple(channel: number, value: number) {
    const coupling = this.settings.channels[channel]?.coupling ?? "dc";

    if (coupling === "dc") {
      return value;
    }

    if (coupling === "gnd") {
      return 0;
    }

    const coupler = this.couplers[channel];

    if (!coupler) {
      this.couplers[channel] = { input: value, output: 0 };

      return 0;
    }

    const timeConstant = 1 / (2 * Math.PI * AC_COUPLING_CORNER);
    const sum = 2 * timeConstant + this.timeStep;
    const passed = (2 * timeConstant) / sum;
    const kept = (2 * timeConstant - this.timeStep) / sum;

    coupler.output = kept * coupler.output + passed * (value - coupler.input);
    coupler.input = value;

    return coupler.output;
  }

  /** Records the step that ended at `time`. */
  record(oscilloscope: Oscilloscope, time: number) {
    const { settings, timeStep } = this;

    if (this.origin === null) {
      this.origin = time - timeStep;
    }

    let triggerValue = 0;

    for (let channel = 0; channel < OSCILLOSCOPE_CHANNELS; channel += 1) {
      const value = this.couple(channel, oscilloscope.channelVoltage(channel));

      if (channel === settings.triggerSource) {
        triggerValue = value;
      }

      this.meters[channel]?.add(value, timeStep);

      const ring = this.rings[channel];

      if (!ring || !settings.channels[channel]?.isOn) {
        continue;
      }

      const { pending } = ring;

      if (value > pending.high) {
        pending.high = value;
        pending.isHighLater = true;
      }

      if (value < pending.low) {
        pending.low = value;
        pending.isHighLater = false;
      }

      pending.area += value * timeStep;
      pending.squareArea += value * value * timeStep;
    }

    this.watchTrigger(triggerValue, time);
    this.pendingSteps += 1;

    if (this.pendingSteps >= this.stepsPerBucket) {
      this.writeBucket();
    }
  }

  /** Fires the trigger where the source crosses its level between two steps. */
  private watchTrigger(value: number, time: number) {
    const { settings } = this;
    const sign = settings.triggerEdge === "rising" ? 1 : -1;
    const signed = sign * value;
    const level = sign * settings.triggerLevel;

    const band =
      TRIGGER_HYSTERESIS *
      (settings.channels[settings.triggerSource]?.voltsPerDivision ?? 1);

    const { previous } = this;

    this.previous = signed;

    if (signed < level - band) {
      this.isArmed = true;

      return;
    }

    // It must rise from below the level to at or above it during this step.
    if (
      !this.isArmed ||
      signed < level ||
      previous === null ||
      previous >= level ||
      this.firing !== null ||
      this.frozen !== null
    ) {
      return;
    }

    const rise = signed - previous;
    const past = rise > 0 ? Math.min(1, (signed - level) / rise) : 0;

    this.isArmed = false;
    this.firing = time - past * this.timeStep;
    this.lastFire = this.firing;
  }

  /** The screen's edges around a trigger at `time`, which sits `position` from the middle. */
  private window(time: number) {
    const { secondsPerDivision, position } = this.settings;
    const half = HORIZONTAL_DIVISIONS / 2;

    return {
      start: time - (half + position) * secondsPerDivision,
      end: time + (half - position) * secondsPerDivision,
    };
  }

  private writeBucket() {
    const index = this.buckets % RING_BUCKETS;
    const duration = this.pendingSteps * this.timeStep;

    for (const ring of this.rings) {
      const { pending } = ring;

      if (pending.low <= pending.high) {
        ring.extremes[2 * index] = pending.isHighLater
          ? pending.low
          : pending.high;
        ring.extremes[2 * index + 1] = pending.isHighLater
          ? pending.high
          : pending.low;
        ring.means[index] = pending.area / duration;
        ring.squares[index] = pending.squareArea / duration;
      }

      resetPending(pending);
    }

    this.buckets += 1;
    this.pendingSteps = 0;

    if (this.firing !== null) {
      const { start, end } = this.window(this.firing);

      if (this.latestEnd() >= end) {
        this.frozen = this.copy(start, end, this.firing);
        this.firing = null;
      }
    }
  }

  /** When the latest bucket ended. */
  private latestEnd() {
    return (this.origin ?? 0) + this.buckets * this.bucketTime;
  }

  /**
   * Copies the buckets from just before `start` to just past `end`, as far as the ring
   * still holds them.
   */
  private copy(
    start: number,
    end: number,
    triggerTime: number | null,
  ): OscilloscopeTrace {
    const { bucketTime } = this;
    const origin = this.origin ?? 0;
    const oldest = Math.max(0, this.buckets - RING_BUCKETS);

    const first = Math.max(
      oldest,
      Math.floor((start - origin) / bucketTime) - 1,
    );

    const last = Math.min(
      this.buckets - 1,
      Math.ceil((end - origin) / bucketTime),
    );

    const count = Math.max(0, last - first + 1);

    const channels = this.rings.map((ring, channel) => {
      if (!this.settings.channels[channel]?.isOn) {
        return null;
      }

      const trace: ChannelTrace = {
        extremes: new Float32Array(2 * count),
        means: new Float32Array(count),
        squares: new Float32Array(count),
      };

      for (let bucket = 0; bucket < count; bucket += 1) {
        const index = (first + bucket) % RING_BUCKETS;

        trace.extremes[2 * bucket] = ring.extremes[2 * index] ?? 0;
        trace.extremes[2 * bucket + 1] = ring.extremes[2 * index + 1] ?? 0;
        trace.means[bucket] = ring.means[index] ?? 0;
        trace.squares[bucket] = ring.squares[index] ?? 0;
      }

      return trace;
    });

    return {
      firstEnd: origin + (first + 1) * bucketTime,
      bucketTime,
      timeStep: this.timeStep,
      count,
      triggerTime,
      start,
      end,
      channels,
    };
  }

  /** When the trigger last fired, in simulated seconds; null since the last clear. */
  get lastTrigger() {
    return this.lastFire;
  }

  /** The latest triggered trace if one froze since the last call; the trigger then arms. */
  takeTriggered() {
    const { frozen } = this;

    this.frozen = null;

    return frozen;
  }

  /** The latest screenful, untriggered; null before the first bucket. */
  live() {
    if (this.buckets === 0) {
      return null;
    }

    const end = this.latestEnd();

    return this.copy(end - screenTime(this.settings), end, null);
  }
}

/**
 * The time bucket `bucket`'s average belongs to: the mean of its steps' times, half a
 * step short of its middle, since each step's value is taken at its end.
 */
function averageTime(trace: OscilloscopeTrace, bucket: number) {
  return (
    trace.firstEnd +
    bucket * trace.bucketTime -
    (trace.bucketTime - trace.timeStep) / 2
  );
}

/** The buckets of `trace` wholly on its screen. */
function screenBuckets(trace: OscilloscopeTrace) {
  const tolerance = trace.bucketTime * 1e-6;
  let first = 0;
  let last = trace.count - 1;

  while (
    first <= last &&
    trace.firstEnd + (first - 1) * trace.bucketTime < trace.start - tolerance
  ) {
    first += 1;
  }

  while (
    last >= first &&
    trace.firstEnd + last * trace.bucketTime > trace.end + tolerance
  ) {
    last -= 1;
  }

  return { first, last };
}

/**
 * Where a signal crosses the middle of its range, rising and falling, in seconds, between
 * buckets `first` and `last`.
 */
function crossings(
  trace: OscilloscopeTrace,
  means: Float32Array,
  first: number,
  last: number,
  low: number,
  high: number,
) {
  const level = (low + high) / 2;
  const band = MEASUREMENT_HYSTERESIS * (high - low);
  const rises: number[] = [];
  const falls: number[] = [];
  let canRise = false;
  let canFall = false;

  const timeOf = (bucket: number) => averageTime(trace, bucket);

  for (let bucket = first; bucket <= last; bucket += 1) {
    const value = means[bucket] ?? 0;
    const previous = means[bucket - 1] ?? value;

    // Where between the two averages the line through them meets the level.
    const at = () =>
      timeOf(bucket - 1) +
      ((level - previous) / (value - previous)) * trace.bucketTime;

    if (value < level - band) {
      canRise = true;
    }

    if (value > level + band) {
      canFall = true;
    }

    if (canRise && bucket > first && previous < level && value >= level) {
      rises.push(at());
      canRise = false;
    }

    if (canFall && bucket > first && previous > level && value <= level) {
      falls.push(at());
      canFall = false;
    }
  }

  return { rises, falls };
}

/** The time the signal spends above the middle of its range per whole cycle. */
function dutyCycle(rises: readonly number[], falls: readonly number[]) {
  let high = 0;

  for (let cycle = 0; cycle < rises.length - 1; cycle += 1) {
    const rise = rises[cycle] ?? 0;
    const next = rises[cycle + 1] ?? 0;
    const fall = falls.find((time) => time > rise && time < next);

    if (fall === undefined) {
      return null;
    }

    high += fall - rise;
  }

  const span = (rises.at(-1) ?? 0) - (rises[0] ?? 0);

  return span > 0 ? high / span : null;
}

/** What a channel's measurements read over the screen. */
export type ChannelReadings = Record<MeasurementKind, number | null>;

/**
 * Measures one channel over the screen, as a digital scope does: the extremes, average
 * and RMS of every step on it, and the frequency, period and duty cycle from the whole
 * cycles between its first and last rising crossing of the middle of its range.
 */
export function measureChannel(
  trace: OscilloscopeTrace,
  channel: number,
): ChannelReadings | null {
  const data = trace.channels[channel];
  const { first, last } = screenBuckets(trace);

  if (!data || last < first) {
    return null;
  }

  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  let sum = 0;
  let squareSum = 0;

  for (let bucket = first; bucket <= last; bucket += 1) {
    const a = data.extremes[2 * bucket] ?? 0;
    const b = data.extremes[2 * bucket + 1] ?? 0;

    low = Math.min(low, a, b);
    high = Math.max(high, a, b);
    sum += data.means[bucket] ?? 0;
    squareSum += data.squares[bucket] ?? 0;
  }

  const buckets = last - first + 1;

  // A crossing right on an edge falls between the screen's last bucket and the one past
  // it, so the search reaches one bucket past either edge.
  const { rises, falls } =
    high > low
      ? crossings(
          trace,
          data.means,
          Math.max(0, first - 1),
          Math.min(trace.count - 1, last + 1),
          low,
          high,
        )
      : { rises: [], falls: [] };

  const period =
    rises.length >= 2
      ? ((rises.at(-1) ?? 0) - (rises[0] ?? 0)) / (rises.length - 1)
      : null;

  return {
    frequency: period === null ? null : 1 / period,
    period,
    "peak-to-peak": high - low,
    maximum: high,
    minimum: low,
    mean: sum / buckets,
    rms: Math.sqrt(Math.max(0, squareSum / buckets)),
    duty: period === null ? null : dutyCycle(rises, falls),
  };
}

/**
 * Channel `channel`'s value at `time`, between the averages of the buckets either side;
 * null off the trace.
 */
export function valueAt(
  trace: OscilloscopeTrace,
  channel: number,
  time: number,
) {
  const data = trace.channels[channel];
  const position = (time - averageTime(trace, 0)) / trace.bucketTime;
  const before = Math.floor(position);

  if (!data || position < 0 || position > trace.count - 1) {
    return null;
  }

  const earlier = data.means[before] ?? 0;
  const later = data.means[Math.min(before + 1, trace.count - 1)] ?? earlier;

  return earlier + (later - earlier) * (position - before);
}

/** The smallest of `options` at least `value`, or the largest. */
function smallestAtLeast(options: readonly number[], value: number) {
  return (
    options.find((option) => option >= value * (1 - 1e-9)) ??
    options.at(-1) ??
    value
  );
}

/** Divisions a channel's signal fills after autoset, top to bottom. */
const AUTOSET_DIVISIONS = 6;

/** Cycles autoset puts on the screen. */
const AUTOSET_CYCLES = 2.5;

/** A signal with a range and offset under this is taken for no signal. */
const NO_SIGNAL = 1e-6;

/**
 * The front panel autoset picks from what each channel's meter has read: channels with
 * a signal on and scaled to fill six divisions about the middle, those without off, the
 * trigger on the middle of the first repeating one, and two and a half of its cycles on
 * the screen. A GND-coupled channel, which shows no signal, stays as it is. Null while no
 * channel has a signal.
 */
export function autoset(
  settings: OscilloscopeSettings,
  meters: readonly SignalMeter[],
): OscilloscopeSettings | null {
  const readings = meters.map((meter) => meter.reading);

  const hasSignal = readings.map(
    (reading) =>
      reading !== null &&
      (reading.peakToPeak > NO_SIGNAL || Math.abs(reading.dc) > NO_SIGNAL),
  );

  if (!hasSignal.some(Boolean)) {
    return null;
  }

  const channels = settings.channels.map((channel, index) => {
    const reading = readings[index];

    if (channel.coupling === "gnd") {
      return channel;
    }

    if (!reading || !hasSignal[index]) {
      return { ...channel, isOn: false };
    }

    const middle = (reading.minimum + reading.maximum) / 2;

    const voltsPerDivision = smallestAtLeast(
      VOLTS_PER_DIVISION,
      reading.peakToPeak > NO_SIGNAL
        ? reading.peakToPeak / AUTOSET_DIVISIONS
        : Math.abs(middle) / (VERTICAL_DIVISIONS / 2 - 1),
    );

    const position = Math.round((-middle / voltsPerDivision) * 10) / 10;

    return {
      ...channel,
      isOn: true,
      voltsPerDivision,
      position: Math.max(
        -VERTICAL_DIVISIONS / 2,
        Math.min(VERTICAL_DIVISIONS / 2, position),
      ),
    };
  });

  const source = readings.findIndex(
    (reading, index) => hasSignal[index] && reading?.frequency,
  );

  const triggerSource = source >= 0 ? source : hasSignal.indexOf(true);
  const trigger = readings[triggerSource];
  const frequency = trigger?.frequency ?? null;

  return {
    ...settings,
    channels,
    secondsPerDivision:
      frequency === null
        ? settings.secondsPerDivision
        : smallestAtLeast(
            SECONDS_PER_DIVISION,
            AUTOSET_CYCLES / frequency / HORIZONTAL_DIVISIONS,
          ),
    position: 0,
    triggerSource,
    triggerEdge: "rising",
    triggerLevel: trigger ? (trigger.minimum + trigger.maximum) / 2 : 0,
    triggerMode: "auto",
  };
}
