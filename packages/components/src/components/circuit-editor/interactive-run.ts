import { voltageName } from "@lunar-spice/simulator/analyses";
import { type Circuit, speedMultiplier } from "@lunar-spice/simulator/circuit";
import type { CircuitElement } from "@lunar-spice/simulator/element";
import { type Point, pointKey } from "@lunar-spice/simulator/geometry";
import { Simulation } from "@lunar-spice/simulator/simulation";

import {
  clearScope,
  createScope,
  recordSample,
  type Scope,
  type ScopeSettings,
  updateScope,
} from "../../lib/scope";
import { AudioIo } from "./audio-io";
import { CurrentDots } from "./current-dots";
import { INITIAL_STATUS, type SimulationStatus } from "./simulation-status";

/** Longest the simulation may run in one frame, so the UI stays responsive. */
const FRAME_BUDGET_MS = 14;

/** While only the time moves, the status is reported at most this often. */
const STATUS_INTERVAL_MS = 100;

/** How far from 1× a speed may be and still count as real time, for sound. */
const REAL_TIME_TOLERANCE = 1e-6;

/** The status without the simulated time, to compare by. */
function steadyPart({ time: _time, ...rest }: SimulationStatus) {
  return JSON.stringify(rest);
}

export type RunCallbacks = {
  onStatus: (status: SimulationStatus) => void;
  onScopesChange: (scopes: readonly Scope[]) => void;
};

/**
 * The simulation that runs while the schematic is on screen: it steps the circuit each
 * frame at the set speed, records scopes, moves the current dots and plays sound. Edits
 * rebuild it; elements keep their state across rebuilds, so a running circuit picks up
 * where it left off.
 */
export class InteractiveRun {
  private circuit: Circuit | null = null;
  private simulation: Simulation | null = null;
  private isRunning = INITIAL_STATUS.isRunning;
  private time = 0;
  private error: string | null = null;
  private faultSet = new Set<CircuitElement>();
  private stepRemainder = 0; // part of a step carried to the next frame
  private lastStatus: SimulationStatus | null = null;
  private lastStatusTime = 0;
  private scopes: Scope[] = [];
  /** Elements by id, so scopes find theirs each step. */
  private elementsById = new Map<number, CircuitElement>();
  private readonly dots = new CurrentDots();
  private readonly audio: AudioIo;
  private audioError: string | null = null;
  private readonly callbacks: RunCallbacks;

  constructor(callbacks: RunCallbacks) {
    this.callbacks = callbacks;
    this.audio = new AudioIo((message) => {
      this.audioError = message;
      this.emitStatus(true);
    });
  }

  /** The parts behind the current error, which the schematic marks. */
  get faults(): ReadonlySet<CircuitElement> {
    return this.faultSet;
  }

  /** True while it steps: running and without an error. */
  private get isStepping() {
    return this.isRunning && !this.error;
  }

  /**
   * Builds a new netlist for `circuit` after an edit. Simulated time carries on; scopes
   * whose element is gone are dropped.
   */
  rebuild(circuit: Circuit) {
    this.circuit = circuit;
    this.error = null;
    this.faultSet = new Set();
    this.simulation = new Simulation(
      circuit.elements,
      "transient",
      circuit.settings.timeStep,
    );
    this.simulation.time = this.time;
    this.elementsById = new Map(
      circuit.elements.map((element) => [element.id, element]),
    );
    this.audio.attach(circuit.elements);

    const scopes = this.scopes.filter(({ elementId }) =>
      this.elementsById.has(elementId),
    );

    if (scopes.length !== this.scopes.length) {
      this.setScopes(scopes);
    }

    this.updateAudio();
    this.emitStatus(true);
  }

  /** Starts another circuit from 0 s with no scopes, like Falstad opening a file. */
  start(circuit: Circuit) {
    this.time = 0;
    this.setScopes([]);
    this.rebuild(circuit);
  }

  /** Discharges everything and starts again from 0 s. */
  reset(circuit: Circuit) {
    circuit.reset();
    this.time = 0;

    for (const scope of this.scopes) {
      clearScope(scope);
    }

    this.rebuild(circuit);
  }

  private setRunning(isRunning: boolean) {
    this.isRunning = isRunning;

    if (isRunning && this.error && this.circuit) {
      this.rebuild(this.circuit);
    }

    this.updateAudio();
    this.emitStatus(true);
  }

  toggleRunning() {
    this.setRunning(!this.isRunning);
  }

  /** Follows new settings: a new time step rebuilds the companion models. */
  updateSettings() {
    const { simulation, circuit } = this;

    if (circuit && simulation?.system.timeStep !== circuit.settings.timeStep) {
      this.rebuild(circuit);
    } else {
      this.updateAudio();
    }
  }

  /**
   * Steps the simulation for one frame's worth of time, within the frame budget.
   * Returns false when it does not step: paused, stopped by an error, or not built.
   */
  runFrame(elapsedMs: number, showCurrentDots: boolean) {
    const { simulation, circuit } = this;

    if (!simulation || !circuit || !this.isStepping) {
      return false;
    }

    const { timeStep } = circuit.settings;
    const target = speedMultiplier(circuit.settings);

    const wanted =
      (target / timeStep) * (elapsedMs / 1000) + this.stepRemainder;

    const steps = Math.floor(wanted);
    const deadline = performance.now() + FRAME_BUDGET_MS;

    this.stepRemainder = Math.min(wanted - steps, 1);

    for (let step = 0; step < steps; step += 1) {
      if (!simulation.step()) {
        this.error = simulation.error;
        this.faultSet = new Set(simulation.faults);
        this.updateAudio();
        break;
      }

      this.recordScopes(timeStep);
      this.audio.pushStep(timeStep);

      if (performance.now() > deadline) {
        break;
      }
    }

    this.audio.flush();

    this.time = simulation.time;

    if (showCurrentDots) {
      this.dots.advance(circuit.elements, elapsedMs);
    }

    this.emitStatus();

    return true;
  }

  /** Where each of an element's current dots starts, by path. */
  dotOffsetsOf(element: CircuitElement): readonly number[] {
    return this.isRunning ? this.dots.of(element) : [];
  }

  /** The solved voltage of the node at a post's point; 0 for points not in the netlist. */
  voltageAt(point: Point) {
    const { simulation } = this;

    return (
      simulation?.system.value(
        simulation.netlist.nodeOfPoint.get(pointKey(point)) ?? 0,
      ) ?? 0
    );
  }

  /** What results call `node`, such as `0`, `out` or `n3`. */
  netName(node: number) {
    return this.simulation?.netlist.nodes[node]?.name ?? `n${node}`;
  }

  /** The name of the net at a post's point; null for points not in the netlist. */
  netNameAt(point: Point) {
    const node = this.simulation?.netlist.nodeOfPoint.get(pointKey(point));

    return node === undefined ? null : this.netName(node);
  }

  /**
   * Watches an element in a scope: its voltage and current, or for a wire or net label,
   * its net's voltage to ground.
   */
  addScope(element: CircuitElement) {
    if (
      !this.circuit ||
      this.scopes.some(({ elementId }) => elementId === element.id)
    ) {
      return;
    }

    const title = element.isNetElement()
      ? voltageName(this.netName(element.node(0)))
      : element.title();

    this.setScopes([
      ...this.scopes,
      createScope(element.id, title, this.circuit.settings.timeStep),
    ]);
  }

  removeScope(elementId: number) {
    this.setScopes(
      this.scopes.filter((scope) => scope.elementId !== elementId),
    );
  }

  /** Changes a scope's settings and reports the scopes again. */
  updateScope(elementId: number, settings: Partial<ScopeSettings>) {
    const scope = this.scopes.find(
      (candidate) => candidate.elementId === elementId,
    );

    if (scope) {
      updateScope(scope, settings);
      this.setScopes([...this.scopes]);
    }
  }

  destroy() {
    this.audio.destroy();
  }

  private setScopes(scopes: Scope[]) {
    this.scopes = scopes;
    this.callbacks.onScopesChange(scopes);
  }

  /** Plays sound only while the run steps at 1×: sound needs simulated time at real time. */
  private updateAudio() {
    const isRealTime =
      this.circuit !== null &&
      Math.abs(speedMultiplier(this.circuit.settings) - 1) <
        REAL_TIME_TOLERANCE;

    this.audio.update(this.isStepping && isRealTime);
  }

  private recordScopes(timeStep: number) {
    for (const scope of this.scopes) {
      const element = this.elementsById.get(scope.elementId);

      if (element) {
        // A wire or net label probes its net's voltage to ground.
        const voltage = element.isNetElement()
          ? (element.volts[0] ?? 0)
          : element.voltageDifference();

        recordSample(scope, voltage, element.current, timeStep);
      }
    }
  }

  private status(): SimulationStatus {
    return {
      isRunning: this.isStepping,
      time: this.time,
      error:
        this.error && this.faultSet.size > 0
          ? `${this.error} The parts involved are marked on the schematic.`
          : this.error,
      usesSound: this.audio.usesSound,
      audioError: this.audioError,
    };
  }

  /** Reports the status; while only the time and speed move, at most every interval. */
  private emitStatus(isForced = false) {
    const status = this.status();
    const now = performance.now();
    const { lastStatus } = this;

    const isOnlyTimeChanged =
      lastStatus !== null && steadyPart(status) === steadyPart(lastStatus);

    if (
      !isForced &&
      isOnlyTimeChanged &&
      now - this.lastStatusTime < STATUS_INTERVAL_MS
    ) {
      return;
    }

    this.lastStatus = status;
    this.lastStatusTime = now;
    this.callbacks.onStatus(status);
  }
}
