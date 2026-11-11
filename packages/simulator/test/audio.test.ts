import { describe, expect, test } from "bun:test";

import { acSweep, operatingPoint } from "../src/analyses";
import { Circuit } from "../src/circuit";
import { Microphone, Speaker } from "../src/elements/audio";
import { Simulation } from "../src/simulation";

/** A CMA-4544PF-W biased from 5 V through its 2.2 kΩ datasheet load; the output is `out`. */
function micCircuit(sound: "live" | "tone") {
  return [
    "$ 1 5e-6 1250 50 5 50 5e-11",
    "R 0 0 0 -32 0 0 40 5 0 0 0.5 0",
    "r 0 0 0 64 0 2200",
    `LSMIC 0 64 0 128 0 ${sound === "live" ? 0 : 1} 1000 1 CMA-4544PF-W -44 2200 0.0005`,
    "g 0 128 0 144 0 0",
    "207 0 64 32 64 0 out",
  ].join("\n");
}

/** −44 dBV/Pa: the output swing across the 2.2 kΩ load for 1 Pa. */
const VOLTS_PER_PASCAL = 10 ** (-44 / 20);

/** 5 V minus 0.5 mA through 2.2 kΩ; the JFET is deep in saturation at 3.9 V. */
const BIAS_VOLTAGE = 5 - 2200 * 0.5e-3;

function outVoltage(circuit: Circuit) {
  const microphone = circuit.elements.find(
    (element) => element instanceof Microphone,
  );

  return microphone?.volts[0] ?? Number.NaN;
}

describe("electret microphone", () => {
  test("sits at the supply minus its bias current through the load", () => {
    const out = operatingPoint(micCircuit("tone")).nets.find(
      ({ net }) => net === "out",
    );

    expect(out?.voltage).toBeCloseTo(BIAS_VOLTAGE, 4);
  });

  test("passes no current without a bias supply", () => {
    const text = micCircuit("tone").replace("40 5 0", "40 0 0");
    const out = operatingPoint(text).nets.find(({ net }) => net === "out");

    expect(out?.voltage).toBeCloseTo(0, 6);
  });

  test("an AC sweep gives its sensitivity: 6.31 mV for 1 Pa", () => {
    const result = acSweep(micCircuit("tone"), {
      startFrequency: 100,
      stopFrequency: 10_000,
      scale: "decade",
      points: 2,
    });

    const out = result.nets.find(({ name }) => name === "V(out)");

    for (const magnitude of out?.magnitude ?? []) {
      expect(magnitude).toBeCloseTo(VOLTS_PER_PASCAL, 5);
    }
  });

  test("a 1 Pa test tone swings the output by the sensitivity", () => {
    const circuit = Circuit.parse(micCircuit("tone"));
    const simulation = new Simulation(circuit.elements, "transient", 5e-6);
    let low = Number.POSITIVE_INFINITY;
    let high = Number.NEGATIVE_INFINITY;

    // 2 ms to settle, then two 1 kHz periods.
    for (let step = 0; step < 800; step += 1) {
      expect(simulation.step()).toBe(true);

      if (step >= 400) {
        const voltage = outVoltage(circuit);

        low = Math.min(low, voltage);
        high = Math.max(high, voltage);
      }
    }

    // Rising pressure raises the drain current, so the output falls around the bias.
    expect((high - low) / 2).toBeCloseTo(VOLTS_PER_PASCAL, 5);
    expect((high + low) / 2).toBeCloseTo(BIAS_VOLTAGE, 5);
  });

  test("a live sample of 0.5 full scale is 0.5 Pa", () => {
    const circuit = Circuit.parse(micCircuit("live"));

    const microphone = circuit.elements.find(
      (element) => element instanceof Microphone,
    );

    if (!microphone) {
      throw new Error("Expected a microphone");
    }

    microphone.liveInput = () => 0.5;

    const simulation = new Simulation(circuit.elements, "transient", 5e-6);

    for (let step = 0; step < 20; step += 1) {
      expect(simulation.step()).toBe(true);
    }

    expect(outVoltage(circuit)).toBeCloseTo(
      BIAS_VOLTAGE - 0.5 * VOLTS_PER_PASCAL,
      6,
    );
  });

  test("keeps its settings through a save", () => {
    const [, , , line = ""] = micCircuit("tone").split("\n");
    const circuit = Circuit.parse(micCircuit("tone"));

    expect(circuit.elements[2]?.dump()).toBe(line);
  });
});

describe("speaker", () => {
  const text = [
    "$ 1 5e-6 1250 50 5 50 5e-11",
    "R 0 0 0 -32 0 0 40 2 0 0 0.5 0",
    "LSSPK 0 0 0 64 0 8\\sΩ\\s0.5\\sW\\sspeaker 8 0.5",
    "g 0 64 0 80 0 0",
  ].join("\n");

  test("loads its source with its impedance: 2 V across 8 Ω is 250 mA", () => {
    const element = operatingPoint(text).elements.find(
      ({ designator }) => designator === "LS1",
    );

    expect(element?.current).toBeCloseTo(0.25, 9);
  });

  test("plays full scale at its rated power: 2 V of a 2.83 V peak", () => {
    const circuit = Circuit.parse(text);
    const simulation = new Simulation(circuit.elements, "transient", 5e-6);

    const speaker = circuit.elements.find(
      (element) => element instanceof Speaker,
    );

    expect(simulation.step()).toBe(true);
    // Rated 0.5 W into 8 Ω peaks at √(2 × 0.5 × 8) = 2.828 V.
    expect(speaker?.soundLevel()).toBeCloseTo(2 / Math.sqrt(8), 9);
  });
});
