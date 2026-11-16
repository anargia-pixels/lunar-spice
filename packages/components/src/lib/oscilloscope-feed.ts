import {
  OSCILLOSCOPE_CHANNELS,
  type OscilloscopeSettings,
} from "@lunar-spice/simulator/elements/oscilloscope";
import { SignalMeter } from "@lunar-spice/simulator/signal-meter";

import {
  autoTimeout,
  type OscilloscopeTrace,
  ROLL_SCREEN,
  screenTime,
} from "./oscilloscope";

/**
 * What an oscilloscope recorded, as the interactive simulation last reported it. The
 * simulation updates it in place every frame, so views poll `version` to see new data.
 */
export type OscilloscopeFeed = {
  /** The latest screenful, untriggered. */
  live: OscilloscopeTrace | null;
  /** The latest trace frozen at a trigger. */
  triggered: OscilloscopeTrace | null;
  /** Counts the triggered traces, so Single can wait for the next one. */
  triggerCount: number;
  /** The simulated time of the latest snapshot. */
  time: number;
  /** When the trigger last fired, in simulated seconds; null before it has. */
  lastTrigger: number | null;
  /** Each channel's meter over whole cycles, for autoset. */
  meters: readonly SignalMeter[];
  /** The time base the traces were recorded at; null before the first. */
  secondsPerDivision: number | null;
  version: number;
};

/** An oscilloscope in the schematic: its name, its front panel and what it records. */
export type OscilloscopeEntry = {
  elementId: number;
  title: string;
  settings: OscilloscopeSettings;
  feed: OscilloscopeFeed;
};

export function createFeed(): OscilloscopeFeed {
  return {
    live: null,
    triggered: null,
    triggerCount: 0,
    time: 0,
    lastTrigger: null,
    meters: Array.from(
      { length: OSCILLOSCOPE_CHANNELS },
      () => new SignalMeter(),
    ),
    secondsPerDivision: null,
    version: 0,
  };
}

/** True while the trigger has fired within Auto's timeout. */
export function isTriggering(
  feed: OscilloscopeFeed,
  settings: OscilloscopeSettings,
) {
  return (
    feed.lastTrigger !== null &&
    feed.time - feed.lastTrigger < autoTimeout(settings)
  );
}

/**
 * The trace a running oscilloscope shows: in Auto the latest triggered one while triggers
 * keep coming, else the untriggered one; in Normal and Single only triggered ones.
 */
export function shownTrace(
  feed: OscilloscopeFeed,
  settings: OscilloscopeSettings,
) {
  if (settings.triggerMode !== "auto") {
    return feed.triggered;
  }

  const isRolling = screenTime(settings) >= ROLL_SCREEN;

  return !isRolling && isTriggering(feed, settings) && feed.triggered
    ? feed.triggered
    : feed.live;
}
