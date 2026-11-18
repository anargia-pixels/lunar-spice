import { describe, expect, test } from "bun:test";

import { Circuit, readElementLine } from "../src/circuit";
import { Oscilloscope } from "../src/elements/oscilloscope";
import { Simulation } from "../src/simulation";

/**
 * A 5 V rail into a 1 kΩ / 1 kΩ divider: 5 V at (0, 0), 2.5 V at (64, 0) to (64, 64),
 * 0 V at (64, 128). An oscilloscope at (200, 0) has CH1 at (184, 16), CH2 at (184, 48)
 * and COM at (264, 144); `probes` wires them.
 */
function dividerWith(probes: readonly string[]) {
  return [
    "R 0 0 0 -32 0 0 40 5 0 0 0.5 0",
    "r 0 0 64 0 0 1000",
    "w 64 0 64 64 0",
    "r 64 64 64 128 0 1000",
    "g 64 128 64 144 0 0",
    "LSOSC 200 0 328 128 65536",
    ...probes,
  ].join("\n");
}

/** The oscilloscope in `text` after one 1 µs step. */
function measuredIn(text: string) {
  const circuit = Circuit.parse(text);
  const simulation = new Simulation(circuit.elements, "transient", 1e-6);

  simulation.step();

  const oscilloscope = circuit.elements.find(
    (element) => element instanceof Oscilloscope,
  );

  if (!(oscilloscope instanceof Oscilloscope)) {
    throw new Error("The circuit has no oscilloscope.");
  }

  return oscilloscope;
}

describe("oscilloscope", () => {
  test("reads each channel against COM without loading the circuit", () => {
    // COM on ground: CH1 on the divider's middle reads 2.5 V, CH2 on the rail 5 V. A
    // 1 MΩ input would pull the middle 1.25 mV low; GMIN's 1 pS pulls it 1.25 nV.
    const grounded = measuredIn(
      dividerWith(["w 64 0 184 16 0", "w 0 0 184 48 0", "w 64 128 264 144 0"]),
    );

    expect(grounded.channelVoltage(0)).toBeCloseTo(2.5, 8);
    expect(grounded.channelVoltage(1)).toBeCloseTo(5, 8);

    // COM on the middle: CH2 reads the upper resistor's 2.5 V.
    const floating = measuredIn(
      dividerWith(["w 0 0 184 48 0", "w 64 64 264 144 0"]),
    );

    expect(floating.channelVoltage(1)).toBeCloseTo(2.5, 8);
  });

  test("saves its front panel on its line", () => {
    const oscilloscope = new Oscilloscope(16, 32, 0, 0);

    oscilloscope.settings = {
      channels: [
        { isOn: true, coupling: "ac", voltsPerDivision: 0.5, position: -1.5 },
        { isOn: false, coupling: "dc", voltsPerDivision: 2, position: 0 },
        { isOn: true, coupling: "gnd", voltsPerDivision: 0.01, position: 3 },
        { isOn: false, coupling: "dc", voltsPerDivision: 1, position: 0 },
      ],
      secondsPerDivision: 2e-5,
      position: -2.5,
      triggerSource: 2,
      triggerEdge: "falling",
      triggerLevel: -0.25,
      triggerMode: "single",
      measurements: [
        { channel: 2, kind: "rms" },
        { channel: 0, kind: "duty" },
      ],
    };

    const read = readElementLine(oscilloscope.dump());

    expect(read).toBeInstanceOf(Oscilloscope);
    expect(read instanceof Oscilloscope && read.settings).toEqual(
      oscilloscope.settings,
    );
    expect(read?.posts()).toEqual(oscilloscope.posts());
  });

  test("reads a bare line with the default front panel", () => {
    const read = readElementLine("LSOSC 0 0 128 128 65536");

    expect(read instanceof Oscilloscope && read.settings).toEqual(
      new Oscilloscope(0, 0, 0, 0).settings,
    );
  });
});
