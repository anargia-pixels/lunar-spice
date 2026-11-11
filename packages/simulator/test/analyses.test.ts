import { describe, expect, test } from "bun:test";

import {
  acSweep,
  cornerFrequencies,
  operatingPoint,
  transient,
} from "../src/analyses";
import { Circuit } from "../src/circuit";
import { EXTENDED_FORMAT_FLAG } from "../src/element";
import { Diode } from "../src/elements/semiconductors";
import { Simulation } from "../src/simulation";
import { parseSpiceModel } from "../src/spice-model";
import { formatSi, parseSi } from "../src/units";

/** A circuit file from element lines, with the default settings line. */
function circuit(...lines: string[]) {
  return ["$ 1 0.000005 10.2 50 5 50", ...lines].join("\n");
}

/** The voltage of a named net in an operating point. */
function netVoltage(text: string, name: string) {
  const net = operatingPoint(text).nets.find(
    (candidate) => candidate.net === name,
  );

  if (!net) {
    throw new Error(`No net named ${name}`);
  }

  return net.voltage;
}

/**
 * A source on the left from (0, 100) up to (0, 0), a first element across the top to
 * (100, 0) labeled `mid`, a second down to (100, 100) and a wire back, grounded at
 * (0, 100). `top` and `down` are the element lines' type and values.
 */
function loop(source: string, top: string, down: string) {
  return circuit(
    `v 0 100 0 0 0 ${source}`,
    `${top.split(" ")[0]} 0 0 100 0 ${top.split(" ").slice(1).join(" ")}`,
    `${down.split(" ")[0]} 100 0 100 100 ${down.split(" ").slice(1).join(" ")}`,
    "w 100 100 0 100 0",
    "g 0 100 0 132 0 0",
    "207 100 0 132 0 0 mid",
  );
}

describe("units", () => {
  test("parses SI prefixes", () => {
    expect(parseSi("4.7k")).toBe(4700);
    expect(parseSi("10uF")).toBeCloseTo(1e-5);
    expect(parseSi("1M")).toBe(1e6);
    expect(parseSi("2m")).toBeCloseTo(2e-3);
    expect(parseSi("abc")).toBeNull();
  });

  test("formats readings", () => {
    expect(formatSi(4700, "Ω")).toBe("4.7 kΩ");
    expect(formatSi(-0.0123, "A")).toBe("-12.3 mA");
    expect(formatSi(0, "V")).toBe("0 V");
  });
});

describe("DC operating point", () => {
  test("solves a voltage divider", () => {
    const text = loop("0 40 10 0 0 0.5", "r 0 1000", "r 0 1000");

    expect(netVoltage(text, "mid")).toBeCloseTo(5, 6);
  });

  test("shorts inductors and opens capacitors", () => {
    expect(
      netVoltage(loop("0 40 10 0 0 0.5", "r 0 1000", "l 0 1 0"), "mid"),
    ).toBeCloseTo(0, 6);
    expect(
      netVoltage(loop("0 40 10 0 0 0.5", "r 0 1000", "c 0 1e-6 0"), "mid"),
    ).toBeCloseTo(10, 6);
  });

  test("includes an inductor's winding resistance", () => {
    const text = loop(
      "0 40 10 0 0 0.5",
      "r 0 1000",
      `l ${EXTENDED_FORMAT_FLAG} 1 0 1000`,
    );

    expect(netVoltage(text, "mid")).toBeCloseTo(5, 6);
  });

  test("drops about 0.65 V across a 1N4148 at 4 mA", () => {
    const diode = new Diode(0, 0, 100, 0, EXTENDED_FORMAT_FLAG);

    diode.params.applyPreset("1N4148");

    const text = circuit(
      "v 0 100 0 0 0 0 40 5 0 0 0.5",
      "r 0 0 100 0 0 1000",
      diode.dump().replace("d 0 0 100 0", "d 100 0 100 100"),
      "w 100 100 0 100 0",
      "g 0 100 0 132 0 0",
      "207 100 0 132 0 0 mid",
    );

    const voltage = netVoltage(text, "mid");

    expect(voltage).toBeGreaterThan(0.6);
    expect(voltage).toBeLessThan(0.75);
  });

  test("regulates with a Zener diode", () => {
    const diode = new Diode(100, 100, 100, 0, EXTENDED_FORMAT_FLAG);

    diode.params.applyPreset("1N4733A (5.1 V Zener)");

    const text = circuit(
      "v 0 100 0 0 0 0 40 12 0 0 0.5",
      "r 0 0 100 0 0 1000",
      diode.dump(),
      "w 100 100 0 100 0",
      "g 0 100 0 132 0 0",
      "207 100 0 132 0 0 mid",
    );

    expect(netVoltage(text, "mid")).toBeCloseTo(5.1, 0);
  });

  test("biases a common-emitter BJT stage", () => {
    // 12 V rail, 100 kΩ base resistor, 1 kΩ collector resistor, emitter grounded.
    const text = circuit(
      "R 0 0 0 -32 0 0 40 12 0 0 0.5",
      "r 0 0 0 64 0 100000",
      "t 0 64 32 64 0 1 0 0 100",
      "r 0 0 32 0 0 1000",
      "w 32 0 32 48 0",
      "g 32 80 32 112 0 0",
      "207 32 48 64 48 0 collector",
    );

    const result = operatingPoint(text);

    const transistor = result.elements.find(
      (element) => element.designator === "Q1",
    );

    // Ib ≈ (12 − 0.7) / 100k ≈ 113 µA, so Ic ≈ 11 mA would saturate the 1 kΩ load.
    expect(transistor?.current).toBeGreaterThan(0.009);
    expect(
      result.nets.find(({ net }) => net === "collector")?.voltage,
    ).toBeLessThan(1);
  });

  test("an inverting amplifier gains −10", () => {
    // 0.1 V in through 1 kΩ to the inverting input, 10 kΩ feedback.
    const text = circuit(
      "R 0 0 -32 0 0 0 40 0.1 0 0 0.5",
      "r 0 0 64 0 0 1000",
      "a 64 16 160 16 0 15 -15 1000000",
      "r 64 0 160 0 0 10000",
      "w 160 0 160 16 0",
      "g 64 32 64 64 0 0",
      "207 160 16 192 16 0 out",
    );

    expect(netVoltage(text, "out")).toBeCloseTo(-1, 3);
  });
});

describe("transient", () => {
  test("charges an RC to 63 % in one time constant", () => {
    const text = loop("0 40 5 0 0 0.5", "r 0 1000", "c 0 1e-6 0");

    const result = transient(text, {
      stopTime: 1e-3,
      startTime: 0,
      maxTimeStep: 1e-6,
      initialConditions: "zero",
    });

    const trace = result.traces.find(
      (candidate) => candidate.name === "V(mid)",
    );

    const last = trace?.values[trace.values.length - 1] ?? 0;

    expect(last).toBeCloseTo(5 * (1 - Math.exp(-1)), 2);
  });

  test("starts from the operating point", () => {
    const text = loop("0 40 5 0 0 0.5", "r 0 1000", "c 0 1e-6 0");

    const result = transient(text, {
      stopTime: 1e-4,
      startTime: 0,
      maxTimeStep: 1e-6,
      initialConditions: "dc",
    });

    const trace = result.traces.find(
      (candidate) => candidate.name === "V(mid)",
    );

    expect(trace?.values[0]).toBeCloseTo(5, 4);
    expect(trace?.values[trace.values.length - 1]).toBeCloseTo(5, 4);
  });
});

describe("AC sweep", () => {
  test("an RC low-pass is 3 dB down at its corner", () => {
    const text = loop("1 1000 1 0 0 0.5", "r 0 1000", "c 0 1e-6 0");
    const corner = 1 / (2 * Math.PI * 1000 * 1e-6);

    const result = acSweep(text, {
      startFrequency: corner,
      stopFrequency: corner * 10,
      scale: "decade",
      points: 10,
    });

    const net = result.nets.find((candidate) => candidate.name === "V(mid)");

    expect(net?.magnitude[0]).toBeCloseTo(Math.SQRT1_2, 4);
    expect(net?.phase[0]).toBeCloseTo(-45, 2);
  });

  test("finds an RC low-pass's corner at 1 / (2πRC)", () => {
    const text = loop("1 1000 1 0 0 0.5", "r 0 1000", "c 0 1e-6 0");

    const result = acSweep(text, {
      startFrequency: 1,
      stopFrequency: 1e5,
      scale: "decade",
      points: 20,
    });

    const net = result.nets.find((candidate) => candidate.name === "V(mid)");
    const corners = cornerFrequencies(result.frequencies, net?.magnitude ?? []);

    expect(corners).toHaveLength(1);
    expect(corners[0] ?? 0).toBeCloseTo(1 / (2 * Math.PI * 1000 * 1e-6), -1);
  });

  test("unwraps a three-pole RC ladder's phase past −180°", () => {
    const text = circuit(
      "v 0 100 0 0 0 1 1000 1 0 0 0.5",
      "r 0 0 100 0 0 1000",
      "c 100 0 100 100 0 1e-6 0",
      "r 100 0 200 0 0 1000",
      "c 200 0 200 100 0 1e-6 0",
      "r 200 0 300 0 0 1000",
      "c 300 0 300 100 0 1e-6 0",
      "w 0 100 100 100 0",
      "w 100 100 200 100 0",
      "w 200 100 300 100 0",
      "g 0 100 0 132 0 0",
      "207 300 0 332 0 0 out",
    );

    const result = acSweep(text, {
      startFrequency: 1,
      stopFrequency: 1e6,
      scale: "decade",
      points: 10,
    });

    const phase =
      result.nets.find((candidate) => candidate.name === "V(out)")?.phase ?? [];

    // Three poles head for −270°; wrapped phase would jump to +180° on the way.
    expect(phase.at(-1) ?? 0).toBeLessThan(-250);

    for (let index = 1; index < phase.length; index += 1) {
      expect((phase[index] ?? 0) - (phase[index - 1] ?? 0)).toBeLessThan(1e-9);
    }
  });

  test("a model op-amp's gain falls with its gain-bandwidth product", () => {
    // Non-inverting amplifier with a gain of 10 using the LM741 values.
    const text = circuit(
      "R 64 32 32 32 0 1 1000 0.01 0 0 0.5",
      "a 64 16 160 16 65536 15 -15 1000000 LM741 200000 1000000 0.5 2000000 75 0 13 -13",
      "r 64 0 160 0 0 9000",
      "w 160 0 160 16 0",
      "r 64 0 64 -64 0 1000",
      "g 64 -64 64 -96 0 0",
      "207 160 16 192 16 0 out",
    );

    const result = acSweep(text, {
      startFrequency: 10,
      stopFrequency: 1e6,
      scale: "decade",
      points: 20,
    });

    const net = result.nets.find((candidate) => candidate.name === "V(out)");
    const gains = (net?.magnitude ?? []).map((value) => value / 0.01);
    const lowGain = gains[0] ?? 0;
    const index = gains.findIndex((gain) => gain < lowGain * Math.SQRT1_2);
    const cornerFrequency = result.frequencies[index] ?? 0;

    expect(lowGain).toBeCloseTo(10, 1);
    // Bandwidth ≈ GBW / closed-loop gain = 100 kHz.
    expect(cornerFrequency).toBeGreaterThan(70e3);
    expect(cornerFrequency).toBeLessThan(150e3);
  });

  test("a model op-amp slews at its slew rate", () => {
    // Unity-gain follower driven by a 10 V step at t = 0 with the LM741's 0.5 V/µs.
    const text = circuit(
      "R 64 32 32 32 0 2 1000 5 5 0 0.999",
      "a 64 16 160 16 65536 15 -15 1000000 LM741 200000 1000000 0.5 2000000 75 0 13 -13",
      "w 64 0 160 0 0",
      "w 160 0 160 16 0",
      "207 160 16 192 16 0 out",
    );

    const result = transient(text, {
      stopTime: 1e-5,
      startTime: 0,
      maxTimeStep: 1e-8,
      initialConditions: "zero",
    });

    const trace = result.traces.find(
      (candidate) => candidate.name === "V(out)",
    );

    const values = trace?.values ?? [];

    const atTime = (time: number) =>
      values[result.times.findIndex((candidate) => candidate >= time)] ?? 0;

    // From 0 V, about 0.5 V per µs: near 2 V after 4 µs, far from the 10 V step.
    expect(atTime(4e-6)).toBeGreaterThan(1.5);
    expect(atTime(4e-6)).toBeLessThan(2.5);
  });
});

describe("interactive simulation", () => {
  test("wires carry the loop current", () => {
    const parsed = Circuit.parse(
      loop("0 40 10 0 0 0.5", "r 0 1000", "r 0 1000"),
    );

    const simulation = new Simulation(parsed.elements, "transient", 5e-6);

    expect(simulation.step()).toBe(true);

    const wire = parsed.elements.find((element) => element.kind === "wire");

    expect(Math.abs(wire?.current ?? 0)).toBeCloseTo(0.005, 6);
  });

  test("keeps running with a part that is not wired yet", () => {
    const parsed = Circuit.parse(
      loop("0 40 10 0 0 0.5", "r 0 1000", "r 0 1000") +
        "\nr 400 400 464 400 0 1000\nc 400 480 464 480 65536 1e-6 0 0",
    );

    const simulation = new Simulation(parsed.elements, "transient", 5e-6);

    expect(simulation.step()).toBe(true);
    expect(operatingPoint(parsed.dump()).nets.length).toBeGreaterThan(0);
  });

  test("reports a voltage source shorted by a wire", () => {
    const parsed = Circuit.parse(
      circuit(
        "v 0 100 0 0 0 0 40 5 0 0 0.5",
        "w 0 0 0 100 0",
        "g 0 100 0 132 0 0",
      ),
    );

    const simulation = new Simulation(parsed.elements, "transient", 5e-6);

    expect(simulation.step()).toBe(false);
    expect(simulation.error).toContain("no unique solution");
    expect(simulation.faults.map(({ kind }) => kind)).toEqual([
      "voltage-source",
    ]);
  });
});

describe("circuit files", () => {
  test("round-trips through the text format", () => {
    const text = loop(
      "0 40 10 0 0 0.5",
      "r 0 1000",
      `c ${EXTENDED_FORMAT_FLAG} 1e-6 2 0.1`,
    );

    const once = Circuit.parse(text).dump();

    expect(Circuit.parse(once).dump()).toBe(once);
    expect(once).toContain("0.1");
  });

  test("skips unknown Falstad components", () => {
    const parsed = Circuit.parse(circuit("w 0 0 16 0 0", "x 0 0 16 0 0 hello"));

    expect(parsed.elements).toHaveLength(1);
    expect(parsed.skippedTypes).toEqual(["x"]);
  });
});

describe("SPICE models", () => {
  test("reads a diode card with continuations and suffixes", () => {
    const model = parseSpiceModel(
      ".model 1N4148 D(Is=2.52n Rs=.568\n+ N=1.752 Cjo=4p M=.4 tt=20n BV=100) ; switching diode",
    );

    expect(model?.type).toBe("d");
    expect(model?.params.get("is")).toBeCloseTo(2.52e-9);
    expect(model?.params.get("cjo")).toBeCloseTo(4e-12);
    expect(model?.params.get("bv")).toBe(100);
  });

  test("applies a pasted card to a diode", () => {
    const diode = new Diode(0, 0, 100, 0);
    const spice = diode.editFields().find((field) => field.kind === "spice");

    if (spice?.kind !== "spice") {
      throw new Error("Expected a SPICE field");
    }

    expect(spice.set(".model MYD D(Is=1n N=2 Rs=0.5)")).toBeNull();
    expect(diode.params.get("is")).toBeCloseTo(1e-9);
    expect(diode.params.modelName).toBe("MYD");
    expect(spice.set(".model Q1 NPN(Is=1f)")).toContain("NPN");
  });
});

describe("integrated circuits", () => {
  /** A regulator from (0, 0) to (64, 0) fed by `input` volts into a `load` Ω load. */
  function regulator(
    preset: string,
    input: number,
    load: number,
    extra: string[] = [],
  ) {
    return circuit(
      `R 0 0 -32 0 0 0 40 ${input} 0 0 0.5`,
      `LSREG 0 0 64 0 65536 1 ${preset.replaceAll(" ", "\\s")} 5 2 2.2 0.01 0.005`,
      `r 64 0 64 64 0 ${load}`,
      "g 64 64 64 96 0 0",
      ...(extra.length > 0 ? extra : ["w 32 32 32 64 0", "g 32 64 32 96 0 0"]),
      "207 64 0 96 0 0 out",
    );
  }

  test("a 7805 regulates 12 V down to 5 V under load", () => {
    expect(netVoltage(regulator("7805", 12, 100), "out")).toBeCloseTo(5, 1);
  });

  test("a 7805 drops out when the input is too low", () => {
    const output = netVoltage(regulator("7805", 6, 100), "out");

    expect(output).toBeGreaterThan(3.7);
    expect(output).toBeLessThan(4.2);
  });

  test("a 7805 limits a shorted output's current", () => {
    const result = operatingPoint(regulator("7805", 12, 0.01));

    const current = result.elements.find(
      ({ designator }) => designator === "U1",
    );

    expect(current?.current).toBeGreaterThan(2);
    expect(current?.current).toBeLessThan(2.3);
  });

  test("an LM317 sets 1.25 V × (1 + R2 / R1)", () => {
    // ADJ at (32, 32): 240 Ω from OUT to ADJ, 720 Ω from ADJ to ground → 5 V.
    const text = circuit(
      "R 0 0 -32 0 0 0 40 12 0 0 0.5",
      "LSADJ 0 0 64 0 65536 1 LM317 1.25 1.7 2.2 0.005 0.00005",
      "r 64 0 64 32 0 240",
      "w 64 32 32 32 0",
      "r 32 32 32 96 0 720",
      "g 32 96 32 128 0 0",
      "r 64 0 128 0 0 100",
      "g 128 0 128 32 0 0",
      "207 64 0 96 -16 0 out",
    );

    expect(netVoltage(text, "out")).toBeCloseTo(5.05, 1);
  });

  test("a 555 astable runs at 1.44 / ((Ra + 2 Rb) C)", () => {
    // Timer at (0, 0): VCC (16, -16), RST (48, -16), DIS (-16, 16), THR (-16, 48),
    // TRIG (-16, 80), OUT (80, 48), CV (48, 112), GND (16, 112).
    const text = circuit(
      "R 16 -48 16 -80 0 0 40 9 0 0 0.5",
      "w 16 -48 16 -16 0",
      "w 16 -48 48 -48 0",
      "w 48 -48 48 -16 0",
      "w 16 -48 -48 -48 0",
      "r -48 -48 -48 16 0 1000",
      "w -48 16 -16 16 0",
      "r -48 16 -48 48 0 10000",
      "w -48 48 -16 48 0",
      "w -48 48 -48 80 0",
      "w -48 80 -16 80 0",
      "c -48 80 -48 144 0 1e-7 0",
      "g -48 144 -48 176 0 0",
      "LS555 0 0 64 96 65536 0 NE555 1.7 0.1 10 15 5000 0.003",
      "g 16 112 16 144 0 0",
      "c 48 112 48 144 0 1e-8 0",
      "g 48 144 48 176 0 0",
      "r 80 48 112 48 0 1000",
      "g 112 48 112 80 0 0",
      "207 80 48 80 16 0 out",
    );

    const result = transient(text, {
      stopTime: 0.02,
      startTime: 0,
      maxTimeStep: 1e-6,
      initialConditions: "zero",
    });

    const trace = result.traces.find(
      (candidate) => candidate.name === "V(out)",
    );

    const values = trace?.values ?? [];
    const rises: number[] = [];

    values.forEach((value, index) => {
      if (index > 0 && (values[index - 1] ?? 0) < 4 && value >= 4) {
        rises.push(result.times[index] ?? 0);
      }
    });

    const settled = rises.slice(2);

    const period =
      ((settled[settled.length - 1] ?? 0) - (settled[0] ?? 0)) /
      (settled.length - 1);

    expect(1 / period).toBeGreaterThan(686 * 0.92);
    expect(1 / period).toBeLessThan(686 * 1.08);
  });
});
