/** The interactive simulation's state, for the controls around the canvas. */
export type SimulationStatus = {
  isRunning: boolean;
  /** Simulated time in seconds. */
  time: number;
  /** Circuit seconds simulated per second lately; below the set speed when it lags. */
  achievedSpeed: number;
  /** True while the circuit cannot keep up with the set speed. */
  isLagging: boolean;
  error: string | null;
  /** True when the circuit has a microphone or a speaker. */
  usesSound: boolean;
  /** Why the microphone or sound output cannot run; null when they are fine. */
  audioError: string | null;
};

/** The status of a new editor: paused at 0 s until the circuit is run. */
export const INITIAL_STATUS: SimulationStatus = {
  isRunning: false,
  time: 0,
  achievedSpeed: 0,
  isLagging: false,
  error: null,
  usesSound: false,
  audioError: null,
};
