import { voltageName } from "@lunar-spice/simulator/analyses";
import { type Circuit, speedMultiplier } from "@lunar-spice/simulator/circuit";
import type { CircuitElement } from "@lunar-spice/simulator/element";
import { Oscilloscope } from "@lunar-spice/simulator/elements/oscilloscope";
import { type Point, pointKey } from "@lunar-spice/simulator/geometry";
import { buildNetlist, type Netlist } from "@lunar-spice/simulator/netlist";

import {
  createFeed,
  type OscilloscopeEntry,
  type OscilloscopeFeed,
} from "../../lib/oscilloscope-feed";
import {
  clearScope,
  createScope,
  type Scope,
  type ScopeSettings,
  updateScope,
} from "../../lib/scope";
import { AudioIo } from "./audio-io";
import { CurrentDots } from "./current-dots";
import { mergeState } from "./element-state";
import type {
  FromWorker,
  OscilloscopeData,
  ScopeData,
  ToWorker,
} from "./run-protocol";
import { INITIAL_STATUS, type SimulationStatus } from "./simulation-status";

/** While only the time moves, the status is reported at most this often. */
const STATUS_INTERVAL_MS = 100;

/** How far from 1× a speed may be and still count as real time, for sound. */
const REAL_TIME_TOLERANCE = 1e-6;

/** The status without the simulated time, to compare by. */
function steadyPart({ time: _time, ...rest }: SimulationStatus) {
  return JSON.stringify(rest);
}

/** A scope's controls, which the editor owns and the worker follows. */
function scopeSettings(scope: Scope): ScopeSettings {
  const { timeSpan, voltageScale, isTriggered, triggerLevel } = scope;

  return { timeSpan, voltageScale, isTriggered, triggerLevel };
}

/** Copies the trace a scope collected in the worker into the editor's scope. */
function mergeScope(scope: Scope, data: ScopeData) {
  if (scope.voltages.length === data.voltages.length) {
    scope.voltages.set(data.voltages);
    scope.currents.set(data.currents);
  }

  scope.count = data.count;
  scope.timeStep = data.timeStep;
  scope.peakVoltage = data.peakVoltage;
  mergeState(scope.meter, data.meter);
}

/** Copies what an oscilloscope recorded in the worker into its feed. */
function mergeOscilloscope(
  feed: OscilloscopeFeed,
  data: OscilloscopeData,
  time: number,
) {
  feed.live = data.live;
  feed.time = time;
  feed.lastTrigger = data.lastTrigger;

  if (data.triggered) {
    feed.triggered = data.triggered;
    feed.triggerCount += 1;
  }

  data.meters.forEach((patch, channel) => {
    const meter = feed.meters[channel];

    if (meter) {
      mergeState(meter, patch);
    }
  });
  feed.version += 1;
}

export type RunCallbacks = {
  onStatus: (status: SimulationStatus) => void;
  onScopesChange: (scopes: readonly Scope[]) => void;
  onOscilloscopesChange: (oscilloscopes: readonly OscilloscopeEntry[]) => void;
};

/**
 * The simulation that runs while the schematic is on screen. A worker steps the circuit
 * at the set speed on its own thread, records the scopes and makes the sound, so a
 * heavy circuit gets a whole core and the editor stays smooth. This side sends it the
 * schematic after every edit and copies back, once a frame, what the simulation changed
 * on each element, which the schematic draws; it also moves the current dots and plays
 * and records sound. Elements keep their state across edits, so a running circuit picks
 * up where it left off.
 */
export class InteractiveRun {
  private circuit: Circuit | null = null;
  private netlist: Netlist | null = null;
  /** Node voltages from the latest snapshot, by node. */
  private voltages: Float64Array<ArrayBufferLike> = new Float64Array(0);
  private isRunning = INITIAL_STATUS.isRunning;
  private time = 0;
  private error: string | null = null;
  private faultSet = new Set<CircuitElement>();
  private lastStatus: SimulationStatus | null = null;
  private lastStatusTime = 0;
  private scopes: Scope[] = [];
  /** What each oscilloscope recorded, by element id. */
  private feeds = new Map<number, OscilloscopeFeed>();
  /** The oscilloscopes as last reported, to report only changes. */
  private reportedOscilloscopes = "";
  /** Elements by id, so snapshots and scopes find theirs. */
  private elementsById = new Map<number, CircuitElement>();
  private readonly dots = new CurrentDots();
  private readonly audio: AudioIo;
  private audioError: string | null = null;
  private readonly callbacks: RunCallbacks;
  private readonly worker: Worker;
  /** Counts loads; snapshots of an older one carry state of elements since edited. */
  private generation = 0;
  /** True while a frame message waits for its snapshot. */
  private isFrameRequested = false;
  /** True when a snapshot came in since the last frame, so the schematic needs drawing. */
  private hasNewSnapshot = false;
  /** A number for each element object, so the worker knows which ones stayed. */
  private readonly instances = new WeakMap<CircuitElement, number>();
  private instanceCount = 0;
  /** Ids of the push switches held down. */
  private readonly pressed = new Set<number>();

  constructor(callbacks: RunCallbacks) {
    this.callbacks = callbacks;
    this.audio = new AudioIo(
      (message) => {
        this.audioError = message;
        this.emitStatus(true);
      },
      (samples) => this.send({ kind: "input", samples }, [samples.buffer]),
    );
    this.worker = new Worker(new URL("./run-worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.addEventListener("message", (event: MessageEvent<FromWorker>) =>
      this.receive(event.data),
    );
    this.worker.addEventListener("error", (event) => {
      event.preventDefault();
      this.error = `The simulation stopped: ${event.message || "its worker failed."}`;
      this.updateAudio();
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

  private send(message: ToWorker, transfer: Transferable[] = []) {
    this.worker.postMessage(message, transfer);
  }

  private instanceOf(element: CircuitElement) {
    let instance = this.instances.get(element);

    if (instance === undefined) {
      this.instanceCount += 1;
      instance = this.instanceCount;
      this.instances.set(element, instance);
    }

    return instance;
  }

  /**
   * Sends the circuit after an edit. Simulated time carries on unless `isRestart`;
   * scopes whose element is gone are dropped.
   */
  rebuild(circuit: Circuit, isRestart = false) {
    this.circuit = circuit;
    this.error = null;
    this.faultSet = new Set();
    this.netlist = buildNetlist(circuit.elements, "transient");
    this.voltages = new Float64Array(this.netlist.nodeCount);

    // Until the worker reports, nodes read the voltages their elements last had.
    for (const element of circuit.elements) {
      element.nodes.forEach((node, post) => {
        if (node > 0) {
          this.voltages[node] = element.volts[post] ?? 0;
        }
      });
    }

    this.elementsById = new Map(
      circuit.elements.map((element) => [element.id, element]),
    );
    this.audio.attach(circuit.elements);
    this.generation += 1;
    this.send({
      kind: "load",
      generation: this.generation,
      elements: circuit.elements.map((element) => ({
        line: element.dump(),
        id: element.id,
        instance: this.instanceOf(element),
        isPressed: this.pressed.has(element.id),
      })),
      settings: { ...circuit.settings },
      isRestart,
    });

    const scopes = this.scopes.filter(({ elementId }) =>
      this.elementsById.has(elementId),
    );

    if (scopes.length !== this.scopes.length) {
      this.setScopes(scopes);
    }

    this.updateOscilloscopes();
    this.updateAudio();
    this.emitStatus(true);
  }

  /** Starts another circuit from 0 s with no scopes, like Falstad opening a file. */
  start(circuit: Circuit) {
    this.time = 0;
    this.setScopes([]);
    this.rebuild(circuit, true);
  }

  /** Discharges everything and starts again from 0 s. */
  reset(circuit: Circuit) {
    circuit.reset();
    this.time = 0;

    for (const scope of this.scopes) {
      clearScope(scope);
    }

    for (const feed of this.feeds.values()) {
      feed.live = null;
      feed.triggered = null;
      feed.version += 1;
    }

    this.rebuild(circuit, true);
  }

  /** Holds a push switch down or lets it go. */
  press(element: CircuitElement, isDown: boolean) {
    element.press(isDown);

    if (isDown) {
      this.pressed.add(element.id);
    } else {
      this.pressed.delete(element.id);
    }

    if (this.circuit) {
      this.rebuild(this.circuit);
    }
  }

  private setRunning(isRunning: boolean) {
    this.isRunning = isRunning;

    if (isRunning && this.error && this.circuit) {
      this.rebuild(this.circuit);
    }

    this.send({ kind: "running", isRunning });
    this.updateAudio();
    this.emitStatus(true);
  }

  toggleRunning() {
    this.setRunning(!this.isRunning);
  }

  /** Follows new settings: a new time step rebuilds the companion models. */
  updateSettings() {
    if (this.circuit) {
      this.send({ kind: "settings", settings: { ...this.circuit.settings } });
    }

    this.updateAudio();
  }

  /**
   * Asks the worker for its latest state and moves the current dots for one frame.
   * Returns true when the schematic needs drawing: while it runs, and once for the
   * snapshot a pause or an error reports.
   */
  runFrame(elapsedMs: number, showCurrentDots: boolean) {
    const { circuit } = this;
    const hasNewSnapshot = this.hasNewSnapshot;

    this.hasNewSnapshot = false;

    if (!circuit || !this.isStepping) {
      return hasNewSnapshot;
    }

    // One snapshot at a time, so a busy worker is never asked faster than it answers.
    if (!this.isFrameRequested) {
      this.isFrameRequested = true;
      this.send({ kind: "frame", sound: this.audio.soundSettings() });
    }

    if (showCurrentDots) {
      this.dots.advance(circuit.elements, elapsedMs);
    }

    this.emitStatus();

    return true;
  }

  /** Takes a snapshot: sound to play, then element state if it is of this schematic. */
  private receive(snapshot: FromWorker) {
    this.isFrameRequested = false;

    if (snapshot.sound) {
      this.audio.play(snapshot.sound);
    }

    if (snapshot.generation !== this.generation) {
      return;
    }

    this.time = snapshot.time;
    this.voltages = snapshot.voltages;
    this.hasNewSnapshot = true;

    for (const [id, patch] of snapshot.states) {
      const element = this.elementsById.get(id);

      if (element) {
        mergeState(element, patch);
      }
    }

    for (const data of snapshot.oscilloscopes) {
      const feed = this.feeds.get(data.elementId);

      if (feed) {
        mergeOscilloscope(feed, data, snapshot.time);
      }
    }

    for (const data of snapshot.scopes) {
      const scope = this.scopes.find(
        (candidate) => candidate.elementId === data.elementId,
      );

      if (scope) {
        mergeScope(scope, data);
      }
    }

    if (snapshot.error && !this.error) {
      this.error = snapshot.error;
      this.faultSet = new Set(
        snapshot.faults.flatMap((id) => {
          const element = this.elementsById.get(id);

          return element ? [element] : [];
        }),
      );
      this.updateAudio();
      this.emitStatus(true);
    }

    // The snapshot a pause reports comes after the pause's status, so it is always shown.
    this.emitStatus(!this.isStepping);
  }

  /** Where each of an element's current dots starts, by path. */
  dotOffsetsOf(element: CircuitElement): readonly number[] {
    return this.isRunning ? this.dots.of(element) : [];
  }

  /** The solved voltage of the node at a post's point; 0 for points not in the netlist. */
  voltageAt(point: Point) {
    const node = this.netlist?.nodeOfPoint.get(pointKey(point)) ?? 0;

    return this.voltages[node] ?? 0;
  }

  /** What results call `node`, such as `0`, `out` or `n3`. */
  netName(node: number) {
    return this.netlist?.nodes[node]?.name ?? `n${node}`;
  }

  /** The net at a post's point, as results name it; null for points not in the netlist. */
  netAt(point: Point) {
    const { netlist } = this;
    const node = netlist?.nodeOfPoint.get(pointKey(point));

    return node === undefined ? null : (netlist?.nodes[node] ?? null);
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

  /**
   * Sends the worker every oscilloscope's front panel, and reports the oscilloscopes when
   * one came, went, was renamed or had its front panel changed.
   */
  updateOscilloscopes() {
    const oscilloscopes =
      this.circuit?.elements.filter(
        (element): element is Oscilloscope => element instanceof Oscilloscope,
      ) ?? [];

    const feeds = new Map(
      oscilloscopes.map(({ id, settings }) => {
        const feed = this.feeds.get(id) ?? createFeed();

        // A trace recorded at another time base would draw at the wrong scale.
        if (feed.secondsPerDivision !== settings.secondsPerDivision) {
          feed.secondsPerDivision = settings.secondsPerDivision;
          feed.live = null;
          feed.triggered = null;
          feed.version += 1;
        }

        return [id, feed];
      }),
    );

    this.feeds = feeds;
    this.send({
      kind: "oscilloscopes",
      oscilloscopes: oscilloscopes.map(({ id, settings }) => ({
        elementId: id,
        settings,
      })),
    });

    const entries = oscilloscopes.map((oscilloscope) => ({
      elementId: oscilloscope.id,
      title: oscilloscope.title(),
      settings: oscilloscope.settings,
      feed: feeds.get(oscilloscope.id) ?? createFeed(),
    }));

    const reported = JSON.stringify(
      entries.map(({ elementId, title, settings }) => [
        elementId,
        title,
        settings,
      ]),
    );

    if (reported !== this.reportedOscilloscopes) {
      this.reportedOscilloscopes = reported;
      this.callbacks.onOscilloscopesChange(entries);
    }
  }

  destroy() {
    this.worker.terminate();
    this.audio.destroy();
  }

  private setScopes(scopes: Scope[]) {
    this.scopes = scopes;
    this.callbacks.onScopesChange(scopes);
    this.send({
      kind: "scopes",
      scopes: scopes.map((scope) => ({
        elementId: scope.elementId,
        title: scope.title,
        settings: scopeSettings(scope),
      })),
    });
  }

  /** Plays sound only while the run steps at 1×: sound needs simulated time at real time. */
  private updateAudio() {
    const isRealTime =
      this.circuit !== null &&
      Math.abs(speedMultiplier(this.circuit.settings) - 1) <
        REAL_TIME_TOLERANCE;

    this.audio.update(this.isStepping && isRealTime);
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
