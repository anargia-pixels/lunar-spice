import type { CircuitElement } from "@lunar-spice/simulator/element";
import { Microphone, Speaker } from "@lunar-spice/simulator/elements/audio";

import { LiveInput } from "./live-input";

/** Frames per capture callback. */
const CAPTURE_FRAMES = 1024;

/** How far ahead of the audio clock a new run of output starts, in seconds. */
const OUTPUT_LEAD = 0.06;

/** Output queued past this is dropped, in seconds, so latency stays bounded. */
const MAX_OUTPUT_AHEAD = 0.3;

/** Corner of the high-pass that keeps a speaker's DC bias out of the output. */
const DC_BLOCK_HZ = 10;

/** Output starting sooner than this from now is late, so a new run of output begins. */
const LATE_START = 0.005;

/**
 * Sound for the interactive simulation: the computer's microphone feeds the circuit's
 * microphones, and its speakers play through the output. Simulated time maps to audio
 * time one to one, so sound only runs while the simulation runs in real time.
 *
 * Input fills a `LiveInput` that the simulation reads at its own pace, a little behind
 * the newest sample. Output is averaged down to the device's sample rate, stripped of
 * DC, and scheduled in one buffer per frame.
 */
export class AudioIo {
  private readonly onError: (message: string | null) => void;
  private context: AudioContext | null = null;
  private isInputWanted = false;
  private isOutputWanted = false;
  /** Bumped for every microphone request, so a late answer to an old one is dropped. */
  private inputRequest = 0;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private readonly input = new LiveInput();
  private pending: number[] = [];
  private nextStart = 0;
  private accumulated = 0;
  private accumulatedTime = 0;
  private previousIn = 0;
  private previousOut = 0;
  private microphones: Microphone[] = [];
  private speakers: Speaker[] = [];
  private isDestroyed = false;

  constructor(onError: (message: string | null) => void) {
    this.onError = (message) => {
      if (!this.isDestroyed) {
        onError(message);
      }
    };
  }

  /** True when the circuit has a microphone or a speaker. */
  get usesSound() {
    return this.microphones.length > 0 || this.speakers.length > 0;
  }

  /** Takes the circuit's microphones and speakers; live microphones hear the input. */
  attach(elements: readonly CircuitElement[]) {
    this.microphones = elements.filter(
      (element) => element instanceof Microphone,
    );
    this.speakers = elements.filter((element) => element instanceof Speaker);

    for (const microphone of this.microphones) {
      microphone.liveInput = (time) => this.inputAt(time);
    }
  }

  /** Opens the microphone and output the circuit uses, or closes them when not live. */
  update(isLive: boolean) {
    this.setActive(
      isLive && this.microphones.some(({ sound }) => sound === "live"),
      isLive && this.speakers.length > 0,
    );
  }

  /** Adds one simulation step of the speakers' sound, lasting `timeStep`. */
  pushStep(timeStep: number) {
    if (!this.isOutputWanted || !this.context) {
      return;
    }

    let level = 0;

    for (const speaker of this.speakers) {
      level += speaker.soundLevel();
    }

    this.pushOutput(level, timeStep);
  }

  /** Opens or closes the microphone and the output as the circuit needs them. */
  private setActive(isInputWanted: boolean, isOutputWanted: boolean) {
    if (
      isInputWanted === this.isInputWanted &&
      isOutputWanted === this.isOutputWanted
    ) {
      return;
    }

    this.isInputWanted = isInputWanted;
    this.isOutputWanted = isOutputWanted;

    if (!isInputWanted) {
      this.stopInput();
    }

    if (!isOutputWanted) {
      this.resetOutput();
    }

    if (!isInputWanted && !isOutputWanted) {
      this.closeContext();

      return;
    }

    const context = this.openContext();

    if (context && isInputWanted && !this.stream) {
      void this.startInput(context);
    }
  }

  /** The audio context, created on first use; null when the browser refuses one. */
  private openContext() {
    if (this.context) {
      return this.context;
    }

    try {
      this.context = new AudioContext({ latencyHint: "interactive" });
      this.context
        .resume()
        .catch((cause: Error) =>
          this.onError(`Sound is unavailable: ${cause.message}`),
        );
      this.onError(null);
    } catch (cause) {
      this.onError(
        cause instanceof Error
          ? `Sound is unavailable: ${cause.message}`
          : "Sound is unavailable.",
      );
    }

    return this.context;
  }

  private closeContext() {
    // Each context is closed once, and close only rejects for a closed context.
    void this.context?.close();
    this.context = null;
    this.onError(null);
  }

  /**
   * Opens the microphone and feeds its samples into the live input. Drops the stream
   * when a newer request or a new context replaced this one while it waited.
   */
  private async startInput(context: AudioContext) {
    this.inputRequest += 1;

    const request = this.inputRequest;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });

      if (request !== this.inputRequest || this.context !== context) {
        for (const track of stream.getTracks()) {
          track.stop();
        }

        return;
      }

      // Electron cannot load audio worklets from file:// pages, but a script
      // processor runs there.
      const processor = context.createScriptProcessor(CAPTURE_FRAMES, 1, 1);
      const source = context.createMediaStreamSource(stream);

      processor.addEventListener("audioprocess", (event) =>
        this.input.write(event.inputBuffer.getChannelData(0)),
      );
      source.connect(processor);
      // The processor runs only while connected; its output stays silent.
      processor.connect(context.destination);
      this.stream = stream;
      this.source = source;
      this.processor = processor;
      this.onError(null);
    } catch (cause) {
      if (request === this.inputRequest) {
        this.onError(
          cause instanceof Error
            ? `The microphone is unavailable: ${cause.message}`
            : "The microphone is unavailable.",
        );
      }
    }
  }

  private stopInput() {
    this.inputRequest += 1;
    this.processor?.disconnect();
    this.source?.disconnect();

    for (const track of this.stream?.getTracks() ?? []) {
      track.stop();
    }

    this.processor = null;
    this.source = null;
    this.stream = null;
    this.input.clear();
  }

  /** The live input at simulated `time`, from −1 to 1; 0 while there is none. */
  private inputAt(time: number) {
    const { context } = this;

    return this.stream && context
      ? this.input.read(time, context.sampleRate)
      : 0;
  }

  /** Adds one simulation step of output, `level` from −1 to 1, lasting `timeStep`. */
  private pushOutput(level: number, timeStep: number) {
    const { context } = this;

    if (!context) {
      return;
    }

    const period = 1 / context.sampleRate;

    this.accumulated += level * timeStep;
    this.accumulatedTime += timeStep;

    if (this.accumulatedTime < period) {
      return;
    }

    // The average over each output period filters out what the device cannot play.
    const value = this.accumulated / this.accumulatedTime;
    // A one-pole high-pass removes the speakers' DC bias.
    const pole = 1 - (2 * Math.PI * DC_BLOCK_HZ) / context.sampleRate;

    while (this.accumulatedTime >= period) {
      const output = value - this.previousIn + pole * this.previousOut;

      this.previousIn = value;
      this.previousOut = output;
      this.pending.push(Math.max(-1, Math.min(1, output)));
      this.accumulatedTime -= period;
    }

    this.accumulated = value * this.accumulatedTime;
  }

  /** Schedules the output collected this frame right after the last buffer. */
  flush() {
    const { context } = this;

    if (!context || this.pending.length === 0) {
      return;
    }

    const now = context.currentTime;

    if (this.nextStart < now + LATE_START) {
      this.nextStart = now + OUTPUT_LEAD;
    }

    if (this.nextStart > now + MAX_OUTPUT_AHEAD) {
      this.pending = [];

      return;
    }

    const buffer = context.createBuffer(
      1,
      this.pending.length,
      context.sampleRate,
    );

    buffer.copyToChannel(Float32Array.from(this.pending), 0);

    const node = context.createBufferSource();

    node.buffer = buffer;
    node.connect(context.destination);
    node.start(this.nextStart);
    this.nextStart += buffer.duration;
    this.pending = [];
  }

  private resetOutput() {
    this.pending = [];
    this.nextStart = 0;
    this.accumulated = 0;
    this.accumulatedTime = 0;
    this.previousIn = 0;
    this.previousOut = 0;
  }

  destroy() {
    this.isDestroyed = true;
    this.setActive(false, false);
  }
}
