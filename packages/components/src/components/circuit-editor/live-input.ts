/** Live input held back so the bursty simulation never runs it dry, in seconds. */
const INPUT_LATENCY = 0.06;

/** Input buffered past which reading jumps forward to catch up, in seconds. */
const MAX_INPUT_LAG = 0.3;

/** Samples of live input kept: over a second at 48 kHz. */
const INPUT_CAPACITY = 1 << 16;

/**
 * How far simulated time must go back to count as starting over, in seconds. Smaller
 * steps back are re-solved steps, which reading follows.
 */
const RESTART_TIME = 0.01;

/**
 * The computer's microphone input for the simulation: samples arrive in bursts from the
 * audio thread and are read back at simulated time, a cushion behind the newest one.
 *
 * Reading never replays sound it has already passed. When it runs dry, it holds the last
 * sample until the cushion has built up again; jumping back instead would play the same
 * stretch twice, which is heard as an echo.
 */
export class LiveInput {
  private readonly ring = new Float32Array(INPUT_CAPACITY);
  private written = 0;
  /** The sample being read, with a fraction between two samples. */
  private position = 0;
  private lastTime: number | null = null;
  private isRefilling = false;

  /** Appends samples from the microphone. */
  write(samples: Float32Array) {
    for (const sample of samples) {
      this.ring[this.written % INPUT_CAPACITY] = sample;
      this.written += 1;
    }
  }

  /** Forgets all input, as when the microphone closes. */
  clear() {
    this.written = 0;
    this.position = 0;
    this.lastTime = null;
    this.isRefilling = false;
  }

  /** The input at simulated `time`, from −1 to 1, with `rate` samples a second; 0 before any. */
  read(time: number, rate: number) {
    if (this.written === 0) {
      return 0;
    }

    const cushion = INPUT_LATENCY * rate;
    const previous = this.lastTime;

    this.lastTime = time;

    if (previous === null || time < previous - RESTART_TIME) {
      // The first read, and simulated time starting over, begin a cushion back.
      this.position = Math.max(0, this.written - cushion);
      this.isRefilling = false;
    } else if (this.isRefilling) {
      this.isRefilling = this.written - this.position < cushion;
    } else {
      // Re-solved steps go back a little in time, and reading goes back with them.
      this.position += (time - previous) * rate;
    }

    // Too far behind: skip ahead, dropping input rather than delaying it further.
    if (this.written - this.position > MAX_INPUT_LAG * rate) {
      this.position = this.written - cushion;
    }

    if (this.position > this.written - 1) {
      this.position = this.written - 1;
      this.isRefilling = true;
    }

    return this.sampleAt(this.position);
  }

  /** The input at a fractional position, between its two nearest samples. */
  private sampleAt(position: number) {
    const index = Math.floor(position);
    const next = Math.min(index + 1, this.written - 1);
    const a = this.ring[index % INPUT_CAPACITY] ?? 0;
    const b = this.ring[next % INPUT_CAPACITY] ?? 0;

    return a + (b - a) * (position - index);
  }
}
