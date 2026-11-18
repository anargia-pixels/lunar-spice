import type { SimulationSettings } from "@lunar-spice/simulator/circuit";
import type { OscilloscopeSettings } from "@lunar-spice/simulator/elements/oscilloscope";

import type { OscilloscopeTrace } from "../../lib/oscilloscope";
import type { ScopeSettings } from "../../lib/scope";
import type { StateFields } from "./element-state";

/**
 * Messages between the editor's `InteractiveRun` and the run worker, which steps the
 * circuit on its own thread. The editor owns the schematic and sends it as file lines;
 * the worker owns the simulation and sends back what it changed.
 */

/** One element of the schematic as the worker rebuilds it. */
export type LoadedElement = {
  /** Its file line, which holds everything it was set up with. */
  line: string;
  id: number;
  /**
   * Names the editor's element object. While it stays the same object, as when it is
   * moved or switched, the worker's copy keeps its simulation state; an element replaced
   * by an edited copy starts afresh, as it does in the editor.
   */
  instance: number;
  /** True for a push switch held down. */
  isPressed: boolean;
};

/** A scope the editor shows, with its controls. */
export type ScopeRequest = {
  elementId: number;
  title: string;
  settings: ScopeSettings;
};

/** An oscilloscope in the schematic, with its front panel as the editor last set it. */
export type OscilloscopeRequest = {
  elementId: number;
  settings: OscilloscopeSettings;
};

/** The sound the worker makes and hears; set by the editor, which plays and records. */
export type SoundSettings = {
  /** The output device's sample rate; null while no sound runs. */
  sampleRate: number | null;
  /** True while the speakers' sound is wanted. */
  isOutputWanted: boolean;
  /** True while the computer's microphone feeds `input` messages. */
  hasInput: boolean;
};

export type ToWorker =
  | {
      kind: "load";
      /** Counts loads, so the editor can tell which schematic a snapshot is of. */
      generation: number;
      elements: readonly LoadedElement[];
      settings: SimulationSettings;
      /** True to start from 0 s with every element at rest, as Reset does. */
      isRestart: boolean;
    }
  | { kind: "settings"; settings: SimulationSettings }
  | { kind: "running"; isRunning: boolean }
  | { kind: "scopes"; scopes: readonly ScopeRequest[] }
  | {
      kind: "oscilloscopes";
      oscilloscopes: readonly OscilloscopeRequest[];
    }
  /** Sent every animation frame while running; answered with a snapshot. */
  | { kind: "frame"; sound: SoundSettings }
  | { kind: "input"; samples: Float32Array }
  /**
   * A microphone's sound clip, decoded at `sampleRate`, to play on repeat; null samples
   * forget it. Sent whenever a microphone's clip changes.
   */
  | {
      kind: "clip";
      elementId: number;
      samples: Float32Array | null;
      sampleRate: number;
    };

/** The data a scope collects as it runs; its controls stay with the editor. */
export type ScopeData = {
  elementId: number;
  voltages: Float32Array;
  currents: Float32Array;
  count: number;
  timeStep: number;
  peakVoltage: number;
  meter: StateFields;
};

/** What an oscilloscope recorded since the last snapshot. */
export type OscilloscopeData = {
  elementId: number;
  /** The latest screenful, untriggered. */
  live: OscilloscopeTrace | null;
  /** A trace frozen at a trigger since the last snapshot, or null. */
  triggered: OscilloscopeTrace | null;
  /** When the trigger last fired, in simulated seconds; null since the recording began. */
  lastTrigger: number | null;
  /** Each channel's meter, for autoset. */
  meters: readonly StateFields[];
};

export type FromWorker = {
  kind: "snapshot";
  /** The load this snapshot is of; the editor drops element state from older ones. */
  generation: number;
  time: number;
  error: string | null;
  /** Ids of the elements behind `error`. */
  faults: readonly number[];
  /** Node voltages by node, ground first. */
  voltages: Float64Array;
  /** What the simulation changed on each element since it was read, by element id. */
  states: readonly (readonly [number, StateFields])[];
  scopes: readonly ScopeData[];
  oscilloscopes: readonly OscilloscopeData[];
  /** Speaker output at the device's sample rate, to play after the last. */
  sound: Float32Array<ArrayBuffer> | null;
};
