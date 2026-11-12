import { describe, expect, test } from "bun:test";

import { LiveInput } from "../src/components/circuit-editor/live-input";

const RATE = 48_000;

/** The simulation's time step at 1×, as the interactive run uses it. */
const STEP = 25e-6;

/** Samples numbered from `from`, so a sample read back tells where it was taken. */
function ramp(from: number, count: number) {
  return Float32Array.from({ length: count }, (_, index) => from + index);
}

/**
 * Plays `seconds` of the browser's timing: the microphone delivers 1024 samples in
 * clumps whose arrival `delayAt` holds back, while the simulation reads every step in
 * one burst per 60 Hz frame. Returns every value read, in order.
 */
function playBack(seconds: number, delayAt: (chunk: number) => number) {
  const input = new LiveInput();
  const chunkSeconds = 1024 / RATE;
  const frame = 1 / 60;
  const values: number[] = [];
  let written = 0;
  let chunk = 0;
  let time = 0;

  for (let wall = 0; wall < seconds; wall += frame) {
    // Chunks whose (delayed) arrival has come by this frame.
    while ((chunk + 1) * chunkSeconds + delayAt(chunk) <= wall) {
      input.write(ramp(written, 1024));
      written += 1024;
      chunk += 1;
    }

    for (; time < wall; time += STEP) {
      values.push(input.read(time, RATE));
    }
  }

  return values;
}

describe("live input", () => {
  test("never plays input it has already passed, however late input comes", () => {
    // Input arrives up to 80 ms late, in clumps, as when the simulation holds up the
    // thread the microphone delivers on.
    const values = playBack(3, (chunk) => ((chunk * 7919) % 11) * 0.008);
    const reads = values.filter((value) => value > 0);

    for (let index = 1; index < reads.length; index += 1) {
      expect(reads[index] ?? 0).toBeGreaterThanOrEqual(
        (reads[index - 1] ?? 0) - 1e-6,
      );
    }
  });

  test("reads a steady input a fixed cushion behind, at the simulated rate", () => {
    const values = playBack(2, () => 0);
    const last = values.at(-1) ?? 0;
    const tenthEarlier = values.at(-1 - Math.round(0.1 / STEP)) ?? 0;

    // A tenth of a second of simulated time reads a tenth of a second of input.
    expect(last - tenthEarlier).toBeCloseTo(0.1 * RATE, -1);
    // And it stays within the 60 ms cushion plus one capture chunk of the newest sample.
    expect(2 * RATE - last).toBeLessThan(0.06 * RATE + 1024 + 0.02 * RATE);
  });

  test("holds the newest sample when it runs dry, then refills its cushion", () => {
    const input = new LiveInput();

    input.write(ramp(0, 4800));
    input.read(0, RATE);

    // 200 ms of simulated time with no new input: it holds the last sample.
    let value = 0;

    for (let time = 0; time < 0.2; time += STEP) {
      value = input.read(time, RATE);
    }

    expect(value).toBe(4799);

    // New input does not move reading on until the 60 ms cushion is back.
    input.write(ramp(4800, 1024));
    expect(input.read(0.2, RATE)).toBe(4799);
    input.write(ramp(5824, 0.06 * RATE));
    input.read(0.2 + STEP, RATE);
    expect(input.read(0.2 + 2 * STEP, RATE)).toBeGreaterThan(4799);
  });

  test("follows a re-solved step back by as much as time went back", () => {
    const input = new LiveInput();

    input.write(ramp(0, 9600));
    input.read(0, RATE);

    const before = input.read(0.01, RATE);
    const back = input.read(0.01 - STEP, RATE);

    expect(before - back).toBeCloseTo(STEP * RATE, 3);
  });

  test("starts again a cushion behind the newest sample when time starts over", () => {
    const input = new LiveInput();

    input.write(ramp(0, 9600));
    input.read(0.5, RATE);

    expect(input.read(0, RATE)).toBe(9600 - 0.06 * RATE);
  });
});
