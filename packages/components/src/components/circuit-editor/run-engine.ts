import {
  assignDesignators,
  readElementLine,
  type SimulationSettings,
  speedMultiplier,
} from "@lunar-spice/simulator/circuit";
import type { CircuitElement } from "@lunar-spice/simulator/element";
import { Oscilloscope } from "@lunar-spice/simulator/elements/oscilloscope";
import { SignalMeter } from "@lunar-spice/simulator/signal-meter";
import { Simulation } from "@lunar-spice/simulator/simulation";

import { OscilloscopeRecorder } from "../../lib/oscilloscope";
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
  OscilloscopeRequest,
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
 * The most real time the run may owe steps for. A slice that runs out of budget, as when
 * a breakpoint divides a few steps, leaves the rest for the next ones to catch up on.
 * Steps owed past this are dropped, and longer gaps, as after the editor was hidden,
 * resume instead of racing to catch up.
 */
const MAX_CATCH_UP_MS = 100;

/**
 * How long dropping steps keeps the behind warning lit, so a circuit that drops a few
 * every slice shows a steady warning.
 */
const BEHIND_HOLD_MS = 500;

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

/** An oscilloscope's recorder and the oscilloscope it records. */
type Acquisition = {
  recorder: OscilloscopeRecorder;
  oscilloscope: Oscilloscope;
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
  /** Steps owed to real time, carried to the next call: a part of one, or a slice's rest. */
  private owedSteps = 0;
  /** When the behind warning expires, in milliseconds; 0 while keeping up. */
  private behindUntil = 0;
  private scopes: Scope[] = [];
  private byId = new Map<number, CircuitElement>();
  private recorders: OscilloscopeRecorder[] = [];
  /** The elements the scopes and oscilloscopes watch, which need every step. */
  private scoped: CircuitElement[] = [];
  /** Each scope with the element it watches, for recording every step. */
  private probes: Probe[] = [];
  /** Each recorder with its oscilloscope, for recording every step. */
  private acquisitions: Acquisition[] = [];
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

      for (const recorder of this.recorders) {
        recorder.restart();
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
    this.behindUntil = 0;
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

      for (const recorder of this.recorders) {
        recorder.retime(settings.timeStep);
      }
    }
  }

  setRunning(isRunning: boolean) {
    this.isRunning = isRunning;
    this.rest();
  }

  /** Stops following real time until the next `run`, as while the editor is hidden. */
  rest() {
    this.lastRun = null;
    this.owedSteps = 0;
    this.behindUntil = 0;
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

  /**
   * Follows the schematic's oscilloscopes: new ones start empty, kept ones keep their
   * recording unless their time base changed.
   */
  setOscilloscopes(requests: readonly OscilloscopeRequest[]) {
    const timeStep = this.settings?.timeStep ?? 1;

    this.recorders = requests.map(({ elementId, settings }) => {
      const recorder = this.recorders.find(
        (candidate) => candidate.elementId === elementId,
      );

      if (!recorder) {
        return new OscilloscopeRecorder(elementId, settings, timeStep);
      }

      recorder.configure(settings, timeStep);

      return recorder;
    });
    this.updateScoped();
  }

  private updateScoped() {
    this.probes = this.scopes.flatMap((scope) => {
      const element = this.byId.get(scope.elementId);

      return element ? [{ scope, element }] : [];
    });
    this.acquisitions = this.recorders.flatMap((recorder) => {
      const element = this.byId.get(recorder.elementId);

      return element instanceof Oscilloscope
        ? [{ recorder, oscilloscope: element }]
        : [];
    });
    this.scoped = [
      ...this.probes.map(({ element }) => element),
      ...this.acquisitions.map(({ oscilloscope }) => oscilloscope),
    ];
  }

  updateSound(settings: SoundSettings) {
    this.sound.update(settings);
  }

  writeInput(samples: Float32Array) {
    this.sound.write(samples);
  }

  /** Sets the sound clip the microphone `elementId` plays; null forgets it. */
  setClip(elementId: number, samples: Float32Array | null, sampleRate: number) {
    this.sound.setClip(elementId, samples, sampleRate);
  }

  /**
   * Steps for the real time since the last call at the set speed, plus the steps still
   * owed, for at most `budgetMs`. Returns true when steps are left owed, for another call
   * at once. A circuit that cannot keep up owes more and more; past `MAX_CATCH_UP_MS` the
   * steps are dropped, so it runs slower instead of falling ever further behind, and the
   * behind warning lights.
   */
  run(now: number, budgetMs: number) {
    const { simulation, settings } = this;

    if (!simulation || !settings || !this.isStepping) {
      this.rest();

      return false;
    }

    const elapsed =
      this.lastRun === null ? 0 : Math.min(now - this.lastRun, MAX_CATCH_UP_MS);

    this.lastRun = now;

    const { timeStep } = settings;
    const stepsPerMs = speedMultiplier(settings) / timeStep / 1000;
    const mostOwed = stepsPerMs * MAX_CATCH_UP_MS;
    let owed = this.owedSteps + stepsPerMs * elapsed;

    if (owed > mostOwed) {
      owed = mostOwed;
      this.behindUntil = now + BEHIND_HOLD_MS;
    }

    const steps = Math.floor(owed);
    const deadline = now + budgetMs;
    const { scoped } = this;
    let taken = 0;

    while (taken < steps) {
      if (!simulation.step()) {
        this.error = simulation.error;
        this.faults = simulation.faults;
        owed = 0;
        break;
      }

      taken += 1;

      // Steps leave wires and grounds for snapshots; a scope on one needs every step.
      if (scoped.length > 0) {
        simulation.updateIdleElementsAmong(scoped);
        this.recordScopes(timeStep);
        this.recordOscilloscopes(simulation.time);
      }

      this.sound.pushStep(timeStep);

      if (taken % STEPS_PER_CLOCK_CHECK === 0 && performance.now() > deadline) {
        break;
      }
    }

    this.owedSteps = Math.max(0, owed - taken);
    this.time = simulation.time;

    return this.owedSteps >= 1;
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

  private recordOscilloscopes(time: number) {
    for (const { recorder, oscilloscope } of this.acquisitions) {
      recorder.record(oscilloscope, time);
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
      isBehind: performance.now() < this.behindUntil,
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
      oscilloscopes: this.recorders.map((recorder) => ({
        elementId: recorder.elementId,
        live: recorder.live(),
        triggered: recorder.takeTriggered(),
        lastTrigger: recorder.lastTrigger,
        meters: recorder.meters.map((meter) =>
          statePatch(meter, PRISTINE_METER),
        ),
      })),
      sound: this.sound.take(),
    };
  }
}
