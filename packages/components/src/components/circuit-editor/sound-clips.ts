import type { SoundClip } from "@lunar-spice/simulator/element";

/** The rate clips are decoded at, in samples a second. */
export const CLIP_RATE = 48_000;

/**
 * Largest audio file a clip keeps, in bytes. The file is stored in the circuit file, and
 * in every undo step.
 */
const MAX_CLIP_BYTES = 4 * 1024 * 1024;

/** Longest recording, in seconds; it stops by itself after this. */
export const MAX_RECORDING_SECONDS = 60;

/** Bit rate of recordings, in bits a second: about 1 MB a minute. */
const RECORDING_BIT_RATE = 128_000;

/** Bytes encoded per call, under the argument limit of `String.fromCharCode`. */
const BASE64_CHUNK = 0x8000;

/** Clips decoded so far, by their data, so a rebuild does not decode them again. */
const decoded = new Map<string, Promise<Float32Array<ArrayBuffer>>>();

/** Decoded clips kept; older ones are forgotten. */
const MAX_DECODED = 8;

function toBase64(bytes: Uint8Array) {
  let text = "";

  for (let start = 0; start < bytes.length; start += BASE64_CHUNK) {
    text += String.fromCharCode(...bytes.subarray(start, start + BASE64_CHUNK));
  }

  return btoa(text);
}

function fromBase64(data: string) {
  const text = atob(data);
  const bytes = new Uint8Array(text.length);

  for (let index = 0; index < text.length; index += 1) {
    bytes[index] = text.codePointAt(index) ?? 0;
  }

  return bytes;
}

/** An audio file's sound mixed down to one channel at `CLIP_RATE`. */
async function decodeBytes(bytes: Uint8Array<ArrayBuffer>) {
  // Decoding resamples to the context's rate; the context itself never plays.
  const context = new OfflineAudioContext(1, 1, CLIP_RATE);
  const buffer = await context.decodeAudioData(bytes.buffer);
  const samples = new Float32Array(buffer.length);

  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);

    for (let index = 0; index < data.length; index += 1) {
      samples[index] =
        (samples[index] ?? 0) + (data[index] ?? 0) / buffer.numberOfChannels;
    }
  }

  return samples;
}

/** A clip's sound at `CLIP_RATE`, decoded once and then reused. */
export function decodeClip(clip: SoundClip) {
  let samples = decoded.get(clip.data);

  if (!samples) {
    samples = decodeBytes(fromBase64(clip.data));
    decoded.set(clip.data, samples);

    // A clip that fails to decode is tried again next time.
    samples.catch(() => decoded.delete(clip.data));

    for (const data of decoded.keys()) {
      if (decoded.size <= MAX_DECODED) {
        break;
      }

      decoded.delete(data);
    }
  }

  return samples;
}

/**
 * A clip from an audio file, such as an upload or a recording. Rejects with a message
 * for the user when it is too large or holds no sound the browser can decode.
 */
export async function clipFromFile(file: Blob, name: string) {
  if (file.size > MAX_CLIP_BYTES) {
    throw new Error(
      `${name} is ${(file.size / 1024 / 1024).toFixed(1)} MB; pick a file under 4 MB, such as a short MP3.`,
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  const clip: SoundClip = {
    name: name.trim() || "Clip",
    data: toBase64(bytes),
  };

  try {
    const samples = await decodeClip(clip);

    if (samples.length === 0) {
      throw new Error("empty");
    }
  } catch {
    throw new Error(`${name} is not a sound this browser can play.`);
  }

  return clip;
}

/** The length of a decoded clip, in seconds. */
export function clipDuration(samples: Float32Array) {
  return samples.length / CLIP_RATE;
}

/**
 * Records the computer's microphone into a clip. `start` asks for the microphone; `stop`
 * ends the recording and gives the clip, and `cancel` drops it.
 */
export class ClipRecorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];

  async start() {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });

    const recorder = new MediaRecorder(stream, {
      audioBitsPerSecond: RECORDING_BIT_RATE,
    });

    recorder.addEventListener("dataavailable", (event) => {
      this.chunks.push(event.data);
    });

    this.stream = stream;
    this.recorder = recorder;
    this.chunks = [];
    recorder.start();
  }

  /** Ends the recording; resolves with its clip. */
  async stop() {
    const { recorder } = this;

    if (!recorder) {
      throw new Error("Nothing is being recorded.");
    }

    const stopped = new Promise((resolve) => {
      recorder.addEventListener("stop", resolve, { once: true });
    });

    recorder.stop();
    await stopped;

    const blob = new Blob(this.chunks, { type: recorder.mimeType });

    this.release();

    return clipFromFile(blob, "Recording");
  }

  /** Drops the recording and lets go of the microphone. */
  cancel() {
    if (this.recorder?.state === "recording") {
      this.recorder.stop();
    }

    this.release();
  }

  private release() {
    for (const track of this.stream?.getTracks() ?? []) {
      track.stop();
    }

    this.stream = null;
    this.recorder = null;
    this.chunks = [];
  }
}
