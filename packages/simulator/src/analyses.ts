import { Circuit } from "./circuit";
import { solveComplex } from "./matrix";
import { AcSystem } from "./mna-system";
import type { NodeInfo } from "./netlist";
import { Simulation } from "./simulation";

// Result types

/** One plotted quantity: a node voltage such as V(out) or an element current such as I(R1). */
type Trace = {
  /** How results show it, such as `V(out)`. */
  name: string;
  unit: "V" | "A";
  /** True for net labels and meters, which results show first and plot by default. */
  isFeatured: boolean;
  values: number[];
};

export type OperatingPointResult = {
  kind: "dc";
  /** Featured first. `net` is the net's own name, or null for a meter's reading. */
  nets: {
    name: string;
    net: string | null;
    voltage: number;
    isFeatured: boolean;
  }[];
  elements: {
    designator: string;
    name: string;
    voltage: number;
    current: number;
    power: number;
  }[];
};

type AcSweepScale = "decade" | "octave" | "linear";

export type AcSweepOptions = {
  startFrequency: number;
  stopFrequency: number;
  scale: AcSweepScale;
  /** Points per decade or octave, or the total for a linear sweep. */
  points: number;
};

export type AcSweepResult = {
  kind: "ac";
  frequencies: number[];
  /** Magnitude in volts and unwrapped phase in degrees for every net, featured first. */
  nets: {
    name: string;
    isFeatured: boolean;
    magnitude: number[];
    phase: number[];
  }[];
};

type InitialConditions = "dc" | "zero";

export type TransientOptions = {
  stopTime: number;
  /** Results start here; the circuit is still simulated from 0. */
  startTime: number;
  maxTimeStep: number;
  initialConditions: InitialConditions;
};

export type TransientResult = {
  kind: "transient";
  times: number[];
  /** Featured first. */
  traces: Trace[];
};

export type AnalysisResult =
  | OperatingPointResult
  | AcSweepResult
  | TransientResult;

// Result helpers

/** Returns the nodes results list, with their numbers: all but ground and internal ones. */
function listedNodes(nodes: readonly NodeInfo[]) {
  return nodes.flatMap((info, node) =>
    node === 0 || info.isInternal ? [] : [{ ...info, node }],
  );
}

/** Creates an empty trace to record into. */
function trace(name: string, unit: Trace["unit"], isFeatured: boolean): Trace {
  return { name, unit, isFeatured, values: [] };
}

/** Creates an empty AC sweep series to record into. */
function acNet(
  name: string,
  isFeatured: boolean,
): AcSweepResult["nets"][number] {
  return { name, isFeatured, magnitude: [], phase: [] };
}

/** Returns `items` with the featured ones (labeled nets, meters) first, in order. */
function featuredFirst<T extends { isFeatured: boolean }>(items: T[]) {
  return [
    ...items.filter(({ isFeatured }) => isFeatured),
    ...items.filter(({ isFeatured }) => !isFeatured),
  ];
}

/** Magnitudes below this read as this, so silent nets have a finite gain in dB. */
const MIN_MAGNITUDE = 1e-15;

/** Converts an AC sweep magnitude in volts to gain in dB relative to 1 V. */
export function toDecibels(magnitude: number) {
  return 20 * Math.log10(Math.max(magnitude, MIN_MAGNITUDE));
}

/** Most points any result keeps; longer runs keep every n-th step. */
const MAX_RESULT_POINTS = 4000;

/** Most time steps a transient analysis may take. */
const MAX_TRANSIENT_STEPS = 2_000_000;

/** Names a voltage as results show it, such as `V(out)` for a net or `V(PR1)` for a meter. */
export function voltageName(name: string) {
  return `V(${name})`;
}

/** Names an element's current as results show it, such as `I(R1)`. */
function currentName(designator: string) {
  return `I(${designator})`;
}

/**
 * Returns every voltage results list, featured first: each net to ground, then each
 * meter: a voltmeter from its first post to its second, a voltage probe to ground. `net`
 * is the net's own name; null for a meter.
 */
function voltageChannels(simulation: Simulation, circuit: Circuit) {
  return featuredFirst([
    ...listedNodes(simulation.netlist.nodes).map((info) => ({
      name: voltageName(info.name),
      net: info.name,
      isFeatured: info.isLabeled,
      nodes: [info.node, 0] as const,
    })),
    ...circuit.elements
      .filter((element) => element.isMeter())
      .map((meter) => ({
        name: voltageName(meter.designator),
        net: null,
        isFeatured: true,
        nodes: [meter.node(0), meter.node(1)] as const,
      })),
  ]);
}

/** Returns the solved voltage between a channel's two nodes. */
function channelVoltage(
  simulation: Simulation,
  [a, b]: readonly [number, number],
) {
  return simulation.system.value(a) - simulation.system.value(b);
}

/** Returns the elements whose current results list: all with a designator but meters. */
function measuredElements(circuit: Circuit) {
  return circuit.elements.filter(
    (element) => element.designator && !element.isMeter(),
  );
}

// Analyses

/** Solves the DC operating point of `circuit`; throws the simulation's error on failure. */
function solveOperatingPoint(circuit: Circuit) {
  const simulation = new Simulation(
    circuit.elements,
    "dc",
    circuit.settings.timeStep,
  );

  if (!simulation.solveOperatingPoint()) {
    throw new Error(simulation.error ?? "The analysis failed.");
  }

  return simulation;
}

/** Finds node voltages and element currents with capacitors open and inductors shorted. */
export function operatingPoint(text: string): OperatingPointResult {
  const circuit = Circuit.parse(text);
  const simulation = solveOperatingPoint(circuit);

  const nets = voltageChannels(simulation, circuit).map(
    ({ name, net, isFeatured, nodes }) => ({
      name,
      net,
      voltage: channelVoltage(simulation, nodes),
      isFeatured,
    }),
  );

  const elements = measuredElements(circuit).map((element) => ({
    designator: element.designator,
    name: element.name(),
    voltage: element.voltageDifference(),
    current: element.current,
    power: element.power(),
  }));

  return { kind: "dc", nets, elements };
}

/** Returns the sweep's frequencies from start to stop, spaced by its scale. */
function sweepFrequencies(options: AcSweepOptions) {
  const { startFrequency, stopFrequency, scale, points } = options;
  const frequencies: number[] = [];

  if (scale === "linear") {
    const count = Math.max(2, Math.round(points));

    for (let index = 0; index < count; index += 1) {
      frequencies.push(
        startFrequency +
          ((stopFrequency - startFrequency) * index) / (count - 1),
      );
    }

    return frequencies;
  }

  const base = scale === "decade" ? 10 : 2;
  const span = Math.log(stopFrequency / startFrequency) / Math.log(base);
  const count = Math.max(2, Math.ceil(span * points) + 1);

  for (let index = 0; index < count; index += 1) {
    frequencies.push(startFrequency * base ** ((span * index) / (count - 1)));
  }

  return frequencies;
}

/**
 * Finds the small-signal response from start to stop frequency. Nonlinear parts are
 * linearized at the DC operating point; sine sources drive the circuit with their
 * amplitude and phase, microphones with their peak sound pressure. Throws when no element
 * drives the circuit or a frequency has no solution.
 */
export function acSweep(text: string, options: AcSweepOptions): AcSweepResult {
  if (
    !(options.startFrequency > 0) ||
    !(options.stopFrequency > options.startFrequency)
  ) {
    throw new Error(
      "The stop frequency must be above a start frequency above 0 Hz.",
    );
  }

  const circuit = Circuit.parse(text);

  if (!circuit.elements.some((element) => element.drivesAc())) {
    throw new Error(
      "AC sweeps need a sine voltage source or a microphone to drive the circuit.",
    );
  }

  const simulation = solveOperatingPoint(circuit);
  const { nodeCount } = simulation.netlist;
  const { size, matrix } = simulation.system;
  const frequencies = sweepFrequencies(options);

  const channels = voltageChannels(simulation, circuit).map(
    ({ name, isFeatured, nodes }) => ({
      net: acNet(name, isFeatured),
      nodes,
    }),
  );

  // Solve each frequency on the operating point's linearized matrix.
  for (const frequency of frequencies) {
    const system = new AcSystem(nodeCount, size, matrix);
    const omega = 2 * Math.PI * frequency;

    for (const element of circuit.elements) {
      element.stampAc(system, omega);
    }

    const { real, imag, rhsReal, rhsImag } = system;

    if (!solveComplex(size, real, imag, rhsReal, rhsImag)) {
      throw new Error(
        `The circuit has no solution at ${frequency.toPrecision(3)} Hz.`,
      );
    }

    const phasor = (node: number) =>
      node <= 0
        ? { re: 0, im: 0 }
        : { re: rhsReal[node - 1] ?? 0, im: rhsImag[node - 1] ?? 0 };

    // Record each channel's magnitude and phase.
    for (const { net, nodes } of channels) {
      const a = phasor(nodes[0]);
      const b = phasor(nodes[1]);
      const re = a.re - b.re;
      const im = a.im - b.im;
      const phase = (Math.atan2(im, re) * 180) / Math.PI;
      const previous = net.phase.at(-1) ?? phase;

      net.magnitude.push(Math.hypot(re, im));
      // Unwrap the phase: each point lands within 180° of the last one.
      net.phase.push(phase + 360 * Math.round((previous - phase) / 360));
    }
  }

  return {
    kind: "ac",
    frequencies,
    nets: channels.map(({ net }) => net),
  };
}

/**
 * Simulates from 0 to the stop time with a fixed step, starting from the DC operating
 * point or from rest, and records every node voltage and element current.
 */
export function transient(
  text: string,
  options: TransientOptions,
): TransientResult {
  // Check the options, then pick the largest step that divides the stop time evenly.
  const { stopTime, startTime, maxTimeStep, initialConditions } = options;

  if (!(stopTime > 0) || !(maxTimeStep > 0)) {
    throw new Error("The stop time and time step must be above 0.");
  }

  if (!(startTime >= 0 && startTime < stopTime)) {
    throw new Error("The start time must be from 0 up to the stop time.");
  }

  const stepCount = Math.ceil(stopTime / maxTimeStep);

  if (stepCount > MAX_TRANSIENT_STEPS) {
    throw new Error(
      `That is ${stepCount.toLocaleString()} time steps. Raise the maximum time step or shorten the run.`,
    );
  }

  const timeStep = stopTime / stepCount;
  const circuit = Circuit.parse(text);

  if (initialConditions === "dc") {
    solveOperatingPoint(circuit);
  } else {
    circuit.reset();
  }

  const simulation = new Simulation(circuit.elements, "transient", timeStep);

  // Keep at most MAX_RESULT_POINTS points from the start time on.
  const recordedSteps = Math.ceil(
    (stepCount * (stopTime - startTime)) / stopTime,
  );

  const stride = Math.max(1, Math.ceil(recordedSteps / MAX_RESULT_POINTS));
  const times: number[] = [];

  // Pair each trace with a function that reads it after a step.
  const channels: { trace: Trace; read: () => number }[] = [
    ...voltageChannels(simulation, circuit).map(
      ({ name, isFeatured, nodes }) => ({
        trace: trace(name, "V", isFeatured),
        read: () => channelVoltage(simulation, nodes),
      }),
    ),
    ...measuredElements(circuit).map((element) => ({
      trace: trace(currentName(element.designator), "A", false),
      read: () => element.current,
    })),
  ];

  /** Records the time and the value of every trace after the latest step. */
  const record = () => {
    times.push(simulation.time);

    for (const {
      trace: { values },
      read,
    } of channels) {
      values.push(read());
    }
  };

  if (startTime === 0) {
    record();
  }

  // Record every `stride`-th step from the start time on, and always the last step.
  for (let step = 1; step <= stepCount; step += 1) {
    if (!simulation.step()) {
      throw new Error(
        `${simulation.error ?? "The analysis failed."} (at ${simulation.time.toPrecision(3)} s)`,
      );
    }

    if (
      simulation.time >= startTime - timeStep / 2 &&
      (step % stride === 0 || step === stepCount)
    ) {
      record();
    }
  }

  return {
    kind: "transient",
    times,
    traces: channels.map(({ trace }) => trace),
  };
}

// Response measurements

/**
 * Finds the −3 dB corners of a response: where the gain crosses 3 dB below its peak on
 * either side of the peak. `magnitudes` are in volts, as AC sweeps give them. Frequencies
 * between samples are interpolated on a log scale. A side the sweep never falls on has
 * no corner.
 */
export function cornerFrequencies(
  frequencies: ArrayLike<number>,
  magnitudes: ArrayLike<number>,
) {
  const gainDb = Array.from(magnitudes, toDecibels);

  let peak = 0;

  for (let index = 1; index < gainDb.length; index += 1) {
    if ((gainDb[index] ?? 0) > (gainDb[peak] ?? 0)) {
      peak = index;
    }
  }

  const level = (gainDb[peak] ?? 0) - 3;

  /** Returns the frequency between samples `a` and `b` where the gain crosses `level`. */
  const crossing = (a: number, b: number) => {
    const gainA = gainDb[a] ?? 0;
    const gainB = gainDb[b] ?? 0;
    const fraction = (gainA - level) / (gainA - gainB);
    const logA = Math.log10(frequencies[a] ?? 1);
    const logB = Math.log10(frequencies[b] ?? 1);

    return 10 ** (logA + (logB - logA) * fraction);
  };

  // Walk out from the peak on each side to the first sample below `level`.
  const corners: number[] = [];

  for (let index = peak; index > 0; index -= 1) {
    if ((gainDb[index - 1] ?? 0) < level) {
      corners.push(crossing(index, index - 1));
      break;
    }
  }

  for (let index = peak; index < gainDb.length - 1; index += 1) {
    if ((gainDb[index + 1] ?? 0) < level) {
      corners.push(crossing(index, index + 1));
      break;
    }
  }

  return corners;
}
