import {
  assignDesignators,
  readElementLine,
  type SimulationSettings,
  speedMultiplier,
} from "@lunar-spice/simulator/circuit";
import type { CircuitElement } from "@lunar-spice/simulator/element";
import { SignalMeter } from "@lunar-spice/simulator/signal-meter";
import { Simulation } from "@lunar-spice/simulator/simulation";

import {
  clearScope,
  createScope,
  recordSample,
  type Scope,
  updateScope,
} from "../../lib/scope";
import {
  changedFields,
  fieldsOf,
  type StateFields,
  statePatch,
} from "./element-state";
import type {
  FromWorker,
  LoadedElement,
  ScopeRequest,
  SoundSettings,
} from "./run-protocol";
import { RunSound } from "./run-sound";

/** A scope meter's fields before it measures anything. */
const PRISTINE_METER = fieldsOf(new SignalMeter());

/**
 * Steps between looks at the clock: reading it costs as much as a step of a small circuit,
 * and a few steps past the slice are not felt.
 */
const STEPS_PER_CLOCK_CHECK = 8;

/**
 * The longest stretch of real time one call to `run` makes up for. Longer gaps, as after
 * the editor was hidden, resume instead of racing to catch up.
 */
const MAX_CATCH_UP_MS = 100;

/** One element the engine steps, with a copy read fresh from its file line. */
type RunElement = {
  element: CircuitElement;
  /**
   * The fields of a copy read fresh from its line, as the line sets it up: what the
   * simulation has not changed.
   */
  pristine: StateFields;
  instance: number;
};

/** A scope and the element it records. */
type Probe = {
  scope: Scope;
  element: CircuitElement;
};

/**
 * The interactive simulation without the editor: it rebuilds the circuit from file lines,
 * steps it in real time at the set speed, records scopes, makes sound, and reports what
 * changed in snapshots. The run worker drives it on its own thread.
 */
export class RunEngine {
  private elements: RunElement[] = [];
  private simulation: Simulation | null = null;
  private settings: SimulationSettings | null = null;
  private generation = 0;
  private isRunning = false;
  private error: string | null = null;
  private faults: readonly CircuitElement[] = [];
  private time = 0;
  /** When `run` last stepped, in milliseconds; null after a pause. */
  private lastRun: number | null = null;
  /** The part of a step carried to the next call. */
  private stepRemainder = 0;
  private scopes: Scope[] = [];
  private byId = new Map<number, CircuitElement>();
  /** The elements the scopes watch, in scope order. */
  private scoped: CircuitElement[] = [];
  /** Each scope with the element it watches, for recording every step. */
  private probes: Probe[] = [];
  private readonly sound = new RunSound();

  /** True while it has a circuit to step: running and without an error. */
  get isStepping() {
    return this.isRunning && !this.error && this.simulation !== null;
  }

  /**
   * Rebuilds the circuit from the editor's elements. Elements that are the same object
   * in the editor keep their simulation state, so editing a running circuit picks up
   * where it left off; a restart starts every element at rest from 0 s.
   */
  load(
    generation: number,
    loaded: readonly LoadedElement[],
    settings: SimulationSettings,
    isRestart: boolean,
  ) {
    const previous = new Map(
      this.elements.map((entry) => [entry.instance, entry]),
    );

    this.generation = generation;

    const read = loaded.flatMap(({ line, id, instance, isPressed }) => {
      const element = readElementLine(line);
      const pristine = readElementLine(line);

      if (!element || !pristine) {
        return [];
      }

      const before = isRestart ? undefined : previous.get(instance);

      // Only what the simulation changed carries over; what the line sets up, such as
      // where it sits or whether a switch is closed, stays as the new line has it.
      if (before) {
        Object.assign(element, changedFields(before.element, before.pristine));
      }

      element.id = id;

      if (element.isPushButton()) {
        element.press(isPressed);
      }

      return [{ element, pristine, instance }];
    });

    const elements = read.map(({ element }) => element);

    assignDesignators(elements);
    assignDesignators(read.map(({ pristine }) => pristine));
    this.elements = read.map(({ element, pristine, instance }) => ({
      element,
      pristine: fieldsOf(pristine),
      instance,
    }));
    this.byId = new Map(elements.map((element) => [element.id, element]));
    this.sound.attach(elements);

    if (isRestart) {
      this.time = 0;

      for (const scope of this.scopes) {
        clearScope(scope);
      }
    }

    this.settings = settings;
    this.rebuild();
    this.updateScoped();
  }

  /** Builds a new simulation of the current elements, which keep their state. */
  private rebuild() {
    const { settings } = this;

    if (!settings) {
      return;
    }

    this.error = null;
    this.faults = [];
    this.simulation = new Simulation(
      this.elements.map(({ element }) => element),
      "transient",
      settings.timeStep,
    );
    // Wires and grounds are brought up to date for each snapshot.
    this.simulation.updatesIdleElements = false;
    this.simulation.time = this.time;
  }

  /** Follows new settings: a new time step rebuilds the companion models. */
  updateSettings(settings: SimulationSettings) {
    const isNewStep = settings.timeStep !== this.settings?.timeStep;

    this.settings = settings;

    if (isNewStep) {
      this.rebuild();
    }
  }

  setRunning(isRunning: boolean) {
    this.isRunning = isRunning;
    this.lastRun = null;
  }

  /** Follows the editor's scopes: new ones start empty, kept ones keep their trace. */
  setScopes(requests: readonly ScopeRequest[]) {
    const timeStep = this.settings?.timeStep ?? 1;

    this.scopes = requests.map(({ elementId, title, settings }) => {
      const scope =
        this.scopes.find((candidate) => candidate.elementId === elementId) ??
        createScope(elementId, title, timeStep);

      updateScope(scope, settings);

      return scope;
    });
    this.updateScoped();
  }

  private updateScoped() {
    this.probes = this.scopes.flatMap((scope) => {
      const element = this.byId.get(scope.elementId);

      return element ? [{ scope, element }] : [];
    });
    this.scoped = this.probes.map(({ element }) => element);
  }

  updateSound(settings: SoundSettings) {
    this.sound.update(settings);
  }

  writeInput(samples: Float32Array) {
    this.sound.write(samples);
  }

  /**
   * Steps for the real time since the last call at the set speed, for at most `budgetMs`.
   * Returns true when it ran out of budget: the circuit is behind real time, and the
   * steps it could not take are dropped, so a heavy circuit runs slower instead of
   * falling ever further behind.
   */
  run(now: number, budgetMs: number) {
    const { simulation, settings } = this;

    if (!simulation || !settings || !this.isStepping) {
      this.lastRun = null;

      return false;
    }

    const elapsed =
      this.lastRun === null ? 0 : Math.min(now - this.lastRun, MAX_CATCH_UP_MS);

    this.lastRun = now;

    const { timeStep } = settings;

    const wanted =
      (speedMultiplier(settings) / timeStep) * (elapsed / 1000) +
      this.stepRemainder;

    const steps = Math.floor(wanted);
    const deadline = now + budgetMs;
    const { scoped } = this;
    let isBehind = false;

    this.stepRemainder = Math.min(wanted - steps, 1);

    for (let step = 0; step < steps; step += 1) {
      if (!simulation.step()) {
        this.error = simulation.error;
        this.faults = simulation.faults;
        break;
      }

      // Steps leave wires and grounds for snapshots; a scope on one needs every step.
      if (scoped.length > 0) {
        simulation.updateIdleElementsAmong(scoped);
        this.recordScopes(timeStep);
      }

      this.sound.pushStep(timeStep);

      if (
        step % STEPS_PER_CLOCK_CHECK === STEPS_PER_CLOCK_CHECK - 1 &&
        performance.now() > deadline
      ) {
        isBehind = step < steps - 1;
        break;
      }
    }

    this.time = simulation.time;

    return isBehind;
  }

  private recordScopes(timeStep: number) {
    for (const { scope, element } of this.probes) {
      // A wire or net label probes its net's voltage to ground.
      const voltage = element.isNetElement()
        ? (element.volts[0] ?? 0)
        : element.voltageDifference();

      recordSample(scope, voltage, element.current, timeStep);
    }
  }

  /** Reports the state of every element, the scopes and the sound made since the last. */
  snapshot(): FromWorker {
    const { simulation } = this;

    simulation?.updateIdleElements();

    return {
      kind: "snapshot",
      generation: this.generation,
      time: this.time,
      error: this.error,
      faults: this.faults.map(({ id }) => id),
      voltages: simulation
        ? simulation.system.solution.slice(0, simulation.netlist.nodeCount)
        : new Float64Array(0),
      states: this.elements.map(
        ({ element, pristine }) =>
          [element.id, statePatch(element, pristine)] as const,
      ),
      scopes: this.scopes.map((scope) => ({
        elementId: scope.elementId,
        voltages: scope.voltages.slice(),
        currents: scope.currents.slice(),
        count: scope.count,
        timeStep: scope.timeStep,
        peakVoltage: scope.peakVoltage,
        meter: statePatch(scope.meter, PRISTINE_METER),
      })),
      sound: this.sound.take(),
    };
  }
}
