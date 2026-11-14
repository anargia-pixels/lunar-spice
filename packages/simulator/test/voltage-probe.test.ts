import { describe, expect, test } from "bun:test";

import { operatingPoint } from "../src/analyses";
import { Circuit, cloneElement } from "../src/circuit";
import { VoltageProbe } from "../src/elements/connectors";
import { SignalMeter } from "../src/signal-meter";
import { Simulation } from "../src/simulation";
import { joinPostsToWires, mergeWires } from "../src/wiring";

/** Feeds `meter` `seconds` of `signal`, sampled every `timeStep`. */
function feed(
  meter: SignalMeter,
  signal: (time: number) => number,
  seconds: number,
  timeStep: number,
) {
  const steps = Math.round(seconds / timeStep);

  for (let step = 1; step <= steps; step += 1) {
    meter.add(signal(step * timeStep), timeStep);
  }
}

describe("signal meter", () => {
  test("reads a 1 kHz, 1 V sine on 0.5 V", () => {
    const meter = new SignalMeter();

    feed(
      meter,
      (time) => 0.5 + Math.sin(2 * Math.PI * 1000 * time),
      0.02,
      1e-6,
    );

    // Peak-to-peak 2 × 1 V; DC the 0.5 V offset; RMS √(0.5² + 1²/2) = 0.866 V.
    expect(meter.reading?.frequency ?? 0).toBeCloseTo(1000, 0);
    expect(meter.reading?.peakToPeak ?? 0).toBeCloseTo(2, 3);
    expect(meter.reading?.dc ?? 1).toBeCloseTo(0.5, 2);
    expect(meter.reading?.rms ?? 0).toBeCloseTo(Math.sqrt(0.75), 3);
  });

  test("times a square wave between samples", () => {
    const meter = new SignalMeter();

    // 7 kHz does not divide the 25 µs step, so crossings fall between samples.
    feed(meter, (time) => ((time * 7000) % 1 < 0.5 ? 5 : 0), 0.5, 25e-6);

    expect(meter.reading?.frequency ?? 0).toBeCloseTo(7000, -1);
    expect(meter.reading?.peakToPeak).toBe(5);
  });

  test("reads DC with no frequency", () => {
    const meter = new SignalMeter();

    feed(meter, () => 3, 2, 25e-6);

    expect(meter.reading?.frequency).toBeNull();
    expect(meter.reading?.peakToPeak).toBe(0);
    expect(meter.reading?.dc ?? 0).toBeCloseTo(3, 9);
    expect(meter.reading?.rms ?? 0).toBeCloseTo(3, 9);
  });

  test("forgets its readings on reset", () => {
    const meter = new SignalMeter();

    feed(meter, () => 3, 0.1, 25e-6);
    meter.reset();

    expect(meter.reading).toBeNull();
  });
});

describe("voltage probe", () => {
  /** A 1 kHz, 1 V AC rail on 0.5 V into 1 kΩ, with a voltage probe on the rail. */
  const RAIL_CIRCUIT = [
    "R 0 0 0 -32 0 1 1000 1 0.5 0 0.5 0",
    "r 0 0 64 0 0 1000",
    "g 64 0 64 16 0 0",
    "O 0 0 16 -16 0 0",
  ].join("\n");

  test("opens and saves as Falstad's output element", () => {
    const circuit = Circuit.parse(RAIL_CIRCUIT);
    const [probe] = circuit.elements.filter((e) => e instanceof VoltageProbe);

    expect(probe?.designator).toBe("PR1");
    expect(probe?.dump()).toBe("O 0 0 16 -16 0 0");
  });

  test("saves a changed readout behind the extended flag", () => {
    const probe = Circuit.parse(RAIL_CIRCUIT).elements.find(
      (e) => e instanceof VoltageProbe,
    );

    probe
      ?.editFields()
      .find(({ key }) => key === "show-1")
      ?.set(false);
    probe
      ?.editFields()
      .find(({ key }) => key === "text-size")
      ?.set(14);

    // 65536 is the extended flag; 29 shows every reading but V(p-p).
    expect(probe?.dump()).toBe("O 0 0 16 -16 65536 0 29 14");

    const copy = probe && cloneElement(probe);

    expect(copy instanceof VoltageProbe && copy.textSize).toBe(14);
    expect(copy instanceof VoltageProbe && copy.readout()).toEqual([
      "V: –",
      "V(rms): –",
      "V(dc): –",
      "Freq: –",
    ]);
  });

  test("reads its tip against ground in results", () => {
    const text = [
      "R 0 0 0 -32 0 0 40 5 0 0 0.5 0",
      "r 0 0 64 0 0 1000",
      "r 64 0 64 64 0 1000",
      "g 64 64 64 80 0 0",
      "O 64 0 80 -16 0 0",
      "p 0 0 64 64 0 0",
    ].join("\n");

    const nets = new Map(
      operatingPoint(text).nets.map(({ name, voltage }) => [name, voltage]),
    );

    // The divider halves the 5 V rail; the voltmeter spans the whole rail.
    expect(nets.get("V(PR1)") ?? 0).toBeCloseTo(2.5, 6);
    expect(nets.get("V(VM1)") ?? 0).toBeCloseTo(5, 6);
  });

  test("reads the rail's sine during a run", () => {
    const circuit = Circuit.parse(RAIL_CIRCUIT);
    const timeStep = 1e-6;
    const simulation = new Simulation(circuit.elements, "transient", timeStep);
    const probe = circuit.elements.find((e) => e instanceof VoltageProbe);

    for (let step = 0; step < 20_000; step += 1) {
      simulation.step();
    }

    const lines = probe?.readings() ?? [];

    expect(probe?.meter.reading?.frequency ?? 0).toBeCloseTo(1000, 0);
    expect(probe?.meter.reading?.peakToPeak ?? 0).toBeCloseTo(2, 3);
    expect(probe?.meter.reading?.dc ?? 0).toBeCloseTo(0.5, 2);
    expect(lines[1]).toBe("V(p-p): 2 V");
    expect(lines[4]).toBe("Freq: 1 kHz");

    circuit.reset();

    expect(probe?.meter.reading).toBeNull();
  });

  /**
   * A 5 V rail into a 1 kΩ / 1 kΩ divider whose middle is one wire from (64, 0) to
   * (64, 64), between the two resistors. `probe` is the probe's line.
   */
  function dividerWith(probe: string) {
    return [
      "R 0 0 0 -32 0 0 40 5 0 0 0.5 0",
      "r 0 0 64 0 0 1000",
      "w 64 0 64 64 0",
      "r 64 64 64 128 0 1000",
      "g 64 128 64 144 0 0",
      probe,
    ].join("\n");
  }

  test("reads a wire it rests on between the wire's ends", () => {
    const nets = new Map(
      operatingPoint(dividerWith("O 64 32 80 16 0 0")).nets.map(
        ({ name, voltage }) => [name, voltage],
      ),
    );

    expect(nets.get("V(PR1)") ?? 0).toBeCloseTo(2.5, 6);
  });

  test("never cuts or joins the wiring", () => {
    const { elements } = Circuit.parse(dividerWith("O 64 32 80 16 0 0"));

    expect(mergeWires(elements)).toBe(elements);
    expect(joinPostsToWires(elements)).toBe(elements);
  });

  test("adds no net of its own", () => {
    const bare = new Simulation(
      Circuit.parse(dividerWith("")).elements,
      "dc",
      1e-6,
    );

    for (const probe of ["O 64 32 80 16 0 0", "O 200 200 216 184 0 0"]) {
      const { netlist } = new Simulation(
        Circuit.parse(dividerWith(probe)).elements,
        "dc",
        1e-6,
      );

      expect(netlist.nodes.map(({ name }) => name)).toEqual(
        bare.netlist.nodes.map(({ name }) => name),
      );
    }
  });

  test("over no net it reads nothing and is left out of results", () => {
    const text = dividerWith("O 200 200 216 184 0 0");
    const circuit = Circuit.parse(text);
    const probe = circuit.elements.find((e) => e instanceof VoltageProbe);

    new Simulation(circuit.elements, "dc", 1e-6).solveOperatingPoint();

    expect(probe?.isConnected).toBe(false);
    expect(probe?.readings()[0]).toBe("V: –");
    expect(
      operatingPoint(text).nets.some(({ name }) => name === "V(PR1)"),
    ).toBe(false);
  });

  test("starts its measurements over when moved", () => {
    const circuit = Circuit.parse(RAIL_CIRCUIT);
    const simulation = new Simulation(circuit.elements, "transient", 1e-6);
    const probe = circuit.elements.find((e) => e instanceof VoltageProbe);

    for (let step = 0; step < 100; step += 1) {
      simulation.step();
    }

    expect(probe?.meter.reading).not.toBeNull();

    probe?.translate(16, 0);

    expect(probe?.meter.reading).toBeNull();
  });
});
