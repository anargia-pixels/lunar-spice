import type { CircuitElement } from "@lunar-spice/simulator/element";
import { Microphone, Speaker } from "@lunar-spice/simulator/elements/audio";

import type { SoundSettings } from "./run-protocol";
import { CLIP_RATE, decodeClip } from "./sound-clips";

/** Frames per capture callback. */
const CAPTURE_FRAMES = 1024;

/** How far ahead of the audio clock a new run of output starts, in seconds. */
const OUTPUT_LEAD = 0.06;

/** Output queued past this is dropped, in seconds, so latency stays bounded. */
const MAX_OUTPUT_AHEAD = 0.3;

/** Output starting sooner than this from now is late, so a new run of output begins. */
const LATE_START = 0.005;

/**
 * Sound for the interactive simulation, on the editor's thread: it records the computer's
 * microphone for the circuit's microphones and plays what its speakers make. Simulated
 * time maps to audio time one to one, so sound only runs while the simulation runs in
 * real time. The run worker, which steps the circuit, reads the input at its own pace
 * (`RunSound`) and makes the output at the device's sample rate; each batch it sends is
 * scheduled right after the last. It also decodes the microphones' sound clips, which the
 * worker cannot, and hands them over as they change.
 */
export class AudioIo {
  private readonly onError: (message: string | null) => void;
  private readonly onInput: (samples: Float32Array<ArrayBuffer>) => void;
  private readonly onClip: (
    elementId: number,
    samples: Float32Array | null,
    sampleRate: number,
  ) => void;
  /** The clip data each microphone was last given, by element id. */
  private readonly clipData = new Map<number, string>();
  private context: AudioContext | null = null;
  private isInputWanted = false;
  private isOutputWanted = false;
  /** Bumped for every microphone request, so a late answer to an old one is dropped. */
  private inputRequest = 0;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private nextStart = 0;
  private microphones: Microphone[] = [];
  private speakers: Speaker[] = [];
  private isDestroyed = false;

  /**
   * `onError` hears why sound cannot run, and null once it can; `onInput` gets each
   * batch the microphone records, and `onClip` each microphone's decoded clip (null
   * samples when it has none any more), for the run worker.
   */
  constructor(
    onError: (message: string | null) => void,
    onInput: (samples: Float32Array<ArrayBuffer>) => void,
    onClip: (
      elementId: number,
      samples: Float32Array | null,
      sampleRate: number,
    ) => void,
  ) {
    this.onError = (message) => {
      if (!this.isDestroyed) {
        onError(message);
      }
    };

    this.onInput = onInput;
    this.onClip = onClip;
  }

  /** True when the circuit has a microphone or a speaker. */
  get usesSound() {
    return this.microphones.length > 0 || this.speakers.length > 0;
  }

  /** Takes the circuit's microphones and speakers, to know what sound it needs. */
  attach(elements: readonly CircuitElement[]) {
    this.microphones = elements.filter(
      (element) => element instanceof Microphone,
    );
    this.speakers = elements.filter((element) => element instanceof Speaker);
    this.updateClips();
  }

  /** Decodes and hands over the clips that changed, and drops the ones now unused. */
  private updateClips() {
    const clips = new Map(
      this.microphones.flatMap(({ id, sound, clip }) =>
        sound === "clip" && clip ? [[id, clip] as const] : [],
      ),
    );

    for (const id of this.clipData.keys()) {
      if (!clips.has(id)) {
        this.clipData.delete(id);
        this.onClip(id, null, CLIP_RATE);
      }
    }

    for (const [id, clip] of clips) {
      if (this.clipData.get(id) === clip.data) {
        continue;
      }

      this.clipData.set(id, clip.data);

      // A clip replaced while it decoded is dropped.
      const isCurrent = () =>
        !this.isDestroyed && this.clipData.get(id) === clip.data;

      decodeClip(clip)
        .then((samples) => {
          if (isCurrent()) {
            this.onClip(id, samples, CLIP_RATE);
          }
        })
        .catch(() => {
          if (isCurrent()) {
            this.onError(`The sound clip ${clip.name} cannot be played.`);
          }
        });
    }
  }

  /** What the run worker needs to know to make and hear sound. */
  soundSettings(): SoundSettings {
    return {
      sampleRate: this.context?.sampleRate ?? null,
      isOutputWanted: this.isOutputWanted && this.context !== null,
      hasInput: this.stream !== null,
    };
  }

  /** Opens the microphone and output the circuit uses, or closes them when not live. */
  update(isLive: boolean) {
    this.setActive(
      isLive && this.microphones.some(({ sound }) => sound === "live"),
      isLive && this.speakers.length > 0,
    );
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
   * Opens the microphone and hands its samples to `onInput`. Drops the stream
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
        this.onInput(event.inputBuffer.getChannelData(0).slice()),
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
  }

  /** Schedules output from the run worker right after the last batch. */
  play(samples: Float32Array<ArrayBuffer>) {
    const { context } = this;

    if (!context || !this.isOutputWanted || samples.length === 0) {
      return;
    }

    const now = context.currentTime;

    if (this.nextStart < now + LATE_START) {
      this.nextStart = now + OUTPUT_LEAD;
    }

    if (this.nextStart > now + MAX_OUTPUT_AHEAD) {
      return;
    }

    const buffer = context.createBuffer(1, samples.length, context.sampleRate);

    buffer.copyToChannel(samples, 0);

    const node = context.createBufferSource();

    node.buffer = buffer;
    node.connect(context.destination);
    node.start(this.nextStart);
    this.nextStart += buffer.duration;
  }

  private resetOutput() {
    this.nextStart = 0;
  }

  destroy() {
    this.isDestroyed = true;
    this.setActive(false, false);
  }
}
