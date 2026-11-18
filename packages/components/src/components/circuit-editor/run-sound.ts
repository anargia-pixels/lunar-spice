import type { CircuitElement } from "@lunar-spice/simulator/element";
import { Microphone, Speaker } from "@lunar-spice/simulator/elements/audio";

import { LiveInput } from "./live-input";
import type { SoundSettings } from "./run-protocol";

/** Corner of the high-pass that keeps a speaker's DC bias out of the output. */
const DC_BLOCK_HZ = 10;

/** Output held for the editor past this is dropped, in seconds, so latency stays bounded. */
const MAX_HELD_OUTPUT = 0.3;

/** A decoded sound clip and its rate, in samples a second. */
type Clip = { samples: Float32Array; sampleRate: number };

/**
 * The sound side of a run, on the thread that steps it: the computer's microphone input,
 * which the editor records and sends, and the sound clips it decodes feed the circuit's
 * microphones, and the speakers' level each step is averaged down to the device's sample
 * rate, stripped of DC, and held for the editor to play.
 */
export class RunSound {
  private settings: SoundSettings = {
    sampleRate: null,
    isOutputWanted: false,
    hasInput: false,
  };
  private readonly input = new LiveInput();
  /** Each microphone's decoded clip, by element id. */
  private readonly clips = new Map<number, Clip>();
  private speakers: Speaker[] = [];
  private held: number[] = [];
  private accumulated = 0;
  private accumulatedTime = 0;
  private previousIn = 0;
  private previousOut = 0;

  /**
   * Takes the circuit's microphones and speakers: microphones playing a clip hear it, and
   * the rest hear the computer's microphone.
   */
  attach(elements: readonly CircuitElement[]) {
    this.speakers = elements.filter((element) => element instanceof Speaker);

    for (const element of elements) {
      if (element instanceof Microphone) {
        const { id } = element;

        element.soundInput =
          element.sound === "clip"
            ? (time) => this.clipAt(id, time)
            : (time) => this.inputAt(time);
      }
    }
  }

  /** Sets the clip the microphone `elementId` plays; null samples forget it. */
  setClip(elementId: number, samples: Float32Array | null, sampleRate: number) {
    if (samples && samples.length > 0) {
      this.clips.set(elementId, { samples, sampleRate });
    } else {
      this.clips.delete(elementId);
    }
  }

  /**
   * The clip of microphone `id` at simulated `time`, from −1 to 1, played on repeat from
   * 0 s; 0 while it has none. Simulated time sets the place, so the clip plays the same
   * at any speed and through any re-solved step.
   */
  private clipAt(id: number, time: number) {
    const clip = this.clips.get(id);

    if (!clip) {
      return 0;
    }

    const { samples, sampleRate } = clip;
    const position = (Math.max(0, time) * sampleRate) % samples.length;
    const index = Math.floor(position);
    const a = samples[index] ?? 0;
    const b = samples[(index + 1) % samples.length] ?? 0;

    return a + (b - a) * (position - index);
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
