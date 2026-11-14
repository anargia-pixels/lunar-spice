import type { CircuitElement } from "@lunar-spice/simulator/element";
import { Microphone, Speaker } from "@lunar-spice/simulator/elements/audio";

import { LiveInput } from "./live-input";
import type { SoundSettings } from "./run-protocol";

/** Corner of the high-pass that keeps a speaker's DC bias out of the output. */
const DC_BLOCK_HZ = 10;

/** Output held for the editor past this is dropped, in seconds, so latency stays bounded. */
const MAX_HELD_OUTPUT = 0.3;

/**
 * The sound side of a run, on the thread that steps it: the computer's microphone input,
 * which the editor records and sends, feeds the circuit's microphones, and the speakers'
 * level each step is averaged down to the device's sample rate, stripped of DC, and held
 * for the editor to play.
 */
export class RunSound {
  private settings: SoundSettings = {
    sampleRate: null,
    isOutputWanted: false,
    hasInput: false,
  };
  private readonly input = new LiveInput();
  private speakers: Speaker[] = [];
  private held: number[] = [];
  private accumulated = 0;
  private accumulatedTime = 0;
  private previousIn = 0;
  private previousOut = 0;

  /** Takes the circuit's microphones and speakers; live microphones hear the input. */
  attach(elements: readonly CircuitElement[]) {
    this.speakers = elements.filter((element) => element instanceof Speaker);

    for (const element of elements) {
      if (element instanceof Microphone) {
        element.liveInput = (time) => this.inputAt(time);
      }
    }
  }

  /** Follows the editor's sound: what it wants played and whether it records. */
  update(settings: SoundSettings) {
    if (!settings.hasInput || settings.sampleRate === null) {
      this.input.clear();
    }

    if (!settings.isOutputWanted || settings.sampleRate === null) {
      this.resetOutput();
    }

    this.settings = settings;
  }

  /** Appends samples from the computer's microphone. */
  write(samples: Float32Array) {
    if (this.settings.hasInput) {
      this.input.write(samples);
    }
  }

  /** The live input at simulated `time`, from −1 to 1; 0 while there is none. */
  private inputAt(time: number) {
    const { hasInput, sampleRate } = this.settings;

    return hasInput && sampleRate !== null
      ? this.input.read(time, sampleRate)
      : 0;
  }

  /** Adds one simulation step of the speakers' sound, lasting `timeStep`. */
  pushStep(timeStep: number) {
    const { isOutputWanted, sampleRate } = this.settings;

    if (!isOutputWanted || sampleRate === null || this.speakers.length === 0) {
      return;
    }

    let level = 0;

    for (const speaker of this.speakers) {
      level += speaker.soundLevel();
    }

    const period = 1 / sampleRate;

    this.accumulated += level * timeStep;
    this.accumulatedTime += timeStep;

    if (this.accumulatedTime < period) {
      return;
    }

    // The average over each output period filters out what the device cannot play.
    const value = this.accumulated / this.accumulatedTime;
    // A one-pole high-pass removes the speakers' DC bias.
    const pole = 1 - (2 * Math.PI * DC_BLOCK_HZ) / sampleRate;

    while (this.accumulatedTime >= period) {
      const output = value - this.previousIn + pole * this.previousOut;

      this.previousIn = value;
      this.previousOut = output;
      this.held.push(Math.max(-1, Math.min(1, output)));
      this.accumulatedTime -= period;
    }

    this.accumulated = value * this.accumulatedTime;

    // Nobody collected it, as while the editor is hidden: keep only the latest.
    const limit = Math.ceil(MAX_HELD_OUTPUT * sampleRate);

    if (this.held.length > 2 * limit) {
      this.held = this.held.slice(-limit);
    }
  }

  /** Hands over the output made since the last call; null when there is none. */
  take() {
    if (this.held.length === 0) {
      return null;
    }

    const samples = Float32Array.from(this.held);

    this.held = [];

    return samples;
  }

  private resetOutput() {
    this.held = [];
    this.accumulated = 0;
    this.accumulatedTime = 0;
    this.previousIn = 0;
    this.previousOut = 0;
  }
}
