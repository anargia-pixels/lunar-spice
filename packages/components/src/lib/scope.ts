/** Buckets across a scope's time span; each holds the lowest and highest sample of its steps. */
const BUCKETS_PER_SPAN = 512;

/**
 * Buckets a scope keeps: two time spans, so a triggered view can start at a crossing
 * that already has a whole span after it.
 */
const SCOPE_BUCKETS = 2 * BUCKETS_PER_SPAN;

/** Entries per bucket in a scope's sample arrays: the two extremes, in the order they came. */
const ENTRIES_PER_BUCKET = 2;

/** The time a new scope's window spans, in seconds. */
const DEFAULT_TIME_SPAN = 0.01;

/** The time spans a scope offers, in seconds: 1-2-5 steps from 100 µs to 10 s. */
export const SCOPE_TIME_SPANS: readonly number[] = [
  1e-4, 2e-4, 5e-4, 1e-3, 2e-3, 5e-3, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5,
  10,
];

/** The voltage scales a scope offers beside fitting the trace, in volts either side of 0. */
export const SCOPE_VOLTAGE_SCALES: readonly number[] = [
  0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100,
];

/** The lowest and highest value of the bucket being filled, and which came later. */
type Extremes = {
  low: number;
  high: number;
  isHighLater: boolean;
};

/**
 * A live plot of one element's voltage and current, Falstad's scope. The interactive
 * simulation writes samples into it in place every step, so views poll `count` to see
 * new ones. A long time span covers more steps than the scope keeps, so each bucket
 * keeps the extremes of its steps and fast waveforms show as an envelope.
 */
export type Scope = {
  elementId: number;
  title: string;
  voltages: Float32Array;
  currents: Float32Array;
  /** Entries written so far; the ring holds the latest `SCOPE_BUCKETS` buckets. */
  count: number;
  /** Seconds between simulation steps. */
  timeStep: number;
  /** Seconds the window shows. */
  timeSpan: number;
  /** Volts shown either side of 0; null fits the trace. */
  voltageScale: number | null;
  /**
   * True to start the view where the voltage rises through the trigger level, which holds
   * a repeating waveform still. False lets the trace scroll.
   */
  isTriggered: boolean;
  /** The trigger level in volts; null follows the middle of the trace. */
  triggerLevel: number | null;
  /** The largest voltage recorded since the trace started, either side of 0. */
  peakVoltage: number;
  /** Steps in the bucket being filled. */
  pendingSteps: number;
  pendingVoltage: Extremes;
  pendingCurrent: Extremes;
};

/** What a scope's controls change. */
export type ScopeSettings = Pick<
  Scope,
  "timeSpan" | "voltageScale" | "isTriggered" | "triggerLevel"
>;

export type ScopeQuantity = "voltage" | "current";

/** The menu command that adds a scope, named where it is offered and where it is taught. */
export const ADD_TO_SCOPE_LABEL = "Add to scope";

function emptyExtremes(): Extremes {
  return {
    low: Number.POSITIVE_INFINITY,
    high: Number.NEGATIVE_INFINITY,
    isHighLater: false,
  };
}

export function createScope(
  elementId: number,
  title: string,
  timeStep: number,
): Scope {
  const size = SCOPE_BUCKETS * ENTRIES_PER_BUCKET;

  return {
    elementId,
    title,
    voltages: new Float32Array(size),
    currents: new Float32Array(size),
    count: 0,
    timeStep,
    timeSpan: DEFAULT_TIME_SPAN,
    voltageScale: null,
    isTriggered: true,
    triggerLevel: null,
    peakVoltage: 0,
    pendingSteps: 0,
    pendingVoltage: emptyExtremes(),
    pendingCurrent: emptyExtremes(),
  };
}

/** How many simulation steps one bucket covers, so the buckets span the time span. */
function stepsPerBucket({ timeSpan, timeStep }: Scope) {
  return Math.max(1, Math.ceil(timeSpan / timeStep / BUCKETS_PER_SPAN));
}

/** Widens `extremes` to take in `value`. */
function widen(extremes: Extremes, value: number) {
  if (value > extremes.high) {
    extremes.high = value;
    extremes.isHighLater = true;
  }

  if (value < extremes.low) {
    extremes.low = value;
    extremes.isHighLater = false;
  }
}

/** Writes a bucket's extremes at `index`, the earlier one first. */
function writeBucket(target: Float32Array, index: number, extremes: Extremes) {
  const { low, high, isHighLater } = extremes;

  target[index] = isHighLater ? low : high;
  target[index + 1] = isHighLater ? high : low;
}

/** Adds one step's sample; a new time step starts the trace over, since times are implied. */
export function recordSample(
  scope: Scope,
  voltage: number,
  current: number,
  timeStep: number,
) {
  if (timeStep !== scope.timeStep) {
    scope.timeStep = timeStep;
    clearScope(scope);
  }

  scope.peakVoltage = Math.max(scope.peakVoltage, Math.abs(voltage));
  widen(scope.pendingVoltage, voltage);
  widen(scope.pendingCurrent, current);
  scope.pendingSteps += 1;

  if (scope.pendingSteps < stepsPerBucket(scope)) {
    return;
  }

  const index = scope.count % scope.voltages.length;

  writeBucket(scope.voltages, index, scope.pendingVoltage);
  writeBucket(scope.currents, index, scope.pendingCurrent);
  scope.count += ENTRIES_PER_BUCKET;
  scope.pendingSteps = 0;
  scope.pendingVoltage = emptyExtremes();
  scope.pendingCurrent = emptyExtremes();
}

/** Drops every sample, as when the simulation starts again from 0 s. */
export function clearScope(scope: Scope) {
  scope.count = 0;
  scope.peakVoltage = 0;
  scope.pendingSteps = 0;
  scope.pendingVoltage = emptyExtremes();
  scope.pendingCurrent = emptyExtremes();
}

/**
 * Changes a scope's settings. A new time span starts the trace over, since each bucket
 * then covers another number of steps.
 */
export function updateScope(scope: Scope, settings: Partial<ScopeSettings>) {
  const { timeSpan } = settings;

  if (timeSpan !== undefined && timeSpan !== scope.timeSpan) {
    clearScope(scope);
  }

  Object.assign(scope, settings);
}

/** The buckets a scope holds: how many, and the entry its oldest one starts at. */
function heldBuckets(scope: Scope) {
  const entries = Math.min(scope.count, scope.voltages.length);

  return {
    count: entries / ENTRIES_PER_BUCKET,
    firstEntry: scope.count - entries,
  };
}

/** The voltage a held bucket ended on: the later of its two extremes. */
function bucketVoltage(scope: Scope, firstEntry: number, bucket: number) {
  const entry = firstEntry + bucket * ENTRIES_PER_BUCKET + 1;

  return scope.voltages[entry % scope.voltages.length] ?? 0;
}

/**
 * The level the scope triggers at: the one set, or else the middle of the voltages it
 * holds. Null while it holds none.
 */
export function triggerLevelOf(scope: Scope) {
  if (scope.triggerLevel !== null) {
    return scope.triggerLevel;
  }

  const { count, firstEntry } = heldBuckets(scope);
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;

  for (let bucket = 0; bucket < count; bucket += 1) {
    const voltage = bucketVoltage(scope, firstEntry, bucket);

    low = Math.min(low, voltage);
    high = Math.max(high, voltage);
  }

  return count === 0 ? null : (low + high) / 2;
}

/**
 * The voltage either side of 0 that a scope's trigger slider spans: its voltage scale,
 * or else the peak it has recorded rounded up to 1, 2 or 5 times a power of ten.
 */
export function triggerRangeOf(scope: Scope) {
  if (scope.voltageScale !== null) {
    return scope.voltageScale;
  }

  if (!(scope.peakVoltage > 0)) {
    return 1;
  }

  const power = 10 ** Math.floor(Math.log10(scope.peakVoltage));

  return (
    [1, 2, 5, 10]
      .map((factor) => factor * power)
      .find((candidate) => candidate >= scope.peakVoltage) ?? 10 * power
  );
}

/**
 * The held bucket a triggered view starts at: the latest one where the voltage rises
 * through the trigger level with a whole time span after it. Null when the scope is not
 * triggered or the voltage never rises through the level.
 */
function triggerBucket(scope: Scope, visibleBuckets: number) {
  const level = scope.isTriggered ? triggerLevelOf(scope) : null;
  const { count, firstEntry } = heldBuckets(scope);

  if (level === null) {
    return null;
  }

  for (let bucket = count - visibleBuckets; bucket >= 1; bucket -= 1) {
    if (
      bucketVoltage(scope, firstEntry, bucket - 1) < level &&
      bucketVoltage(scope, firstEntry, bucket) >= level
    ) {
      return bucket;
    }
  }

  return null;
}

/**
 * The samples of one quantity across the time span, oldest first, with their times in
 * seconds. Both extremes of a bucket share its time. A triggered view starts at the
 * trigger and counts time up from 0; otherwise the view ends at the latest sample, at 0.
 */
export function orderedSamples(scope: Scope, quantity: ScopeQuantity) {
  const source = quantity === "voltage" ? scope.voltages : scope.currents;
  const bucketTime = stepsPerBucket(scope) * scope.timeStep;

  const visibleBuckets = Math.min(
    BUCKETS_PER_SPAN,
    Math.ceil(scope.timeSpan / bucketTime),
  );

  const held = heldBuckets(scope);
  const trigger = triggerBucket(scope, visibleBuckets);
  const buckets = Math.min(held.count, visibleBuckets);
  const firstBucket = trigger ?? held.count - buckets;
  const firstEntry = held.firstEntry + firstBucket * ENTRIES_PER_BUCKET;
  const count = buckets * ENTRIES_PER_BUCKET;
  const values = new Float32Array(count);
  const times = new Float32Array(count);

  for (let index = 0; index < count; index += 1) {
    const bucket = index >> 1;

    values[index] = source[(firstEntry + index) % source.length] ?? 0;
    times[index] =
      (trigger === null ? bucket - buckets + 1 : bucket) * bucketTime;
  }

  return {
    values,
    times,
    timeRange:
      trigger === null
        ? { min: -scope.timeSpan, max: 0 }
        : { min: 0, max: scope.timeSpan },
  };
}
