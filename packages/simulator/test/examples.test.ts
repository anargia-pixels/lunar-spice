import { describe, expect, test } from "bun:test";

import { operatingPoint, transient } from "../src/analyses";
import { Circuit } from "../src/circuit";
import { EXAMPLES } from "../src/examples";
import { pointKey } from "../src/geometry";
import { flipElements, rotateElements } from "../src/layout";
import { Simulation } from "../src/simulation";
import { joinPostsToWires, mergeWires } from "../src/wiring";

describe("examples", () => {
  for (const example of EXAMPLES) {
    test(`${example.title} is wired and solves`, () => {
      const circuit = Circuit.parse(example.text);
      const counts = new Map<string, number>();

      for (const element of circuit.elements) {
        for (const post of element.posts()) {
          counts.set(pointKey(post), (counts.get(pointKey(post)) ?? 0) + 1);
        }
      }

      const loose = [...counts].filter(([, count]) => count < 2);

      expect(circuit.skippedTypes).toEqual([]);
      expect(loose).toEqual([]);
      expect(operatingPoint(example.text).nets.length).toBeGreaterThan(0);

      const simulation = new Simulation(
        circuit.elements,
        "transient",
        circuit.settings.timeStep,
      );

      for (let step = 0; step < 200; step += 1) {
        expect(simulation.step()).toBe(true);
      }
    });
  }
});

test("the LM317 example sets 1.25 V × (1 + 720 / 240) plus the ADJ current", () => {
  const example = EXAMPLES.find(({ id }) => id === "lm317-supply");

  const out = operatingPoint(example?.text ?? "").nets.find(
    ({ net }) => net === "out",
  );

  expect(out?.voltage).toBeCloseTo(5 + 50e-6 * 720, 1);
});

describe("layout", () => {
  /** The transistor's posts as sorted keys, to compare shapes after moves. */
  function postKeys(text: string) {
    const [element] = Circuit.parse(text).elements;

    if (!element) {
      throw new Error("Expected an element");
    }

    return { element, keys: () => element.posts().map(pointKey) };
  }

  test("four quarter turns bring a transistor back", () => {
    const { element, keys } = postKeys("t 0 0 32 0 0 1 0 0 100");
    const before = keys();

    for (let turn = 0; turn < 4; turn += 1) {
      rotateElements([element], true);
    }

    expect(keys()).toEqual(before);
  });

  test("a quarter turn rotates every post", () => {
    const { element, keys } = postKeys("t 0 0 32 0 0 1 0 0 100");

    rotateElements([element], true);

    // Base (0, 0), collector (32, -16), emitter (32, 16), turned clockwise about (16, 0).
    expect(keys()).toEqual(["16,-16", "32,16", "0,16"]);
  });

  test("a vertical flip swaps collector and emitter sides", () => {
    const { element, keys } = postKeys("t 0 0 32 0 0 1 0 0 100");

    flipElements([element], "vertical");

    expect(keys()).toEqual(["0,0", "32,16", "32,-16"]);
  });
});

describe("joining posts to wires", () => {
  // 10 V across a wire from (0, 0) to (128, 0), then 1 kΩ down to ground at its end.
  const supply = [
    "v 0 64 0 0 0 0 40 10 0 0 0.5",
    "g 0 64 0 96 0 0",
    "w 0 0 128 0 0",
    "r 128 0 128 64 0 1000",
    "g 128 64 128 96 0 0",
  ];

  /** The voltage of net `out` once posts are joined to the wires they touch. */
  function joinedOut(...lines: string[]) {
    const circuit = Circuit.parse([...supply, ...lines].join("\n"));

    circuit.elements = [...joinPostsToWires(circuit.elements)];

    const out = operatingPoint(circuit.dump()).nets.find(
      ({ net }) => net === "out",
    );

    return { circuit, voltage: out?.voltage };
  }

  test("a post in the middle of a wire cuts it and joins", () => {
    // A resistor hangs from the middle of the supply wire, with `out` under it.
    const { circuit, voltage } = joinedOut(
      "r 64 0 64 64 0 1000",
      "207 64 64 64 96 0 out",
    );

    const wires = circuit.elements.filter((element) => element.isConductor());

    expect(wires.map((wire) => wire.dump())).toEqual([
      "w 0 0 64 0 0",
      "w 64 0 128 0 0",
    ]);
    // No current flows in the hanging resistor, so `out` sits at the supply.
    expect(voltage).toBeCloseTo(10, 6);
  });

  test("wires that only cross stay apart", () => {
    const elements = Circuit.parse(
      [...supply, "w 64 -64 64 64 0"].join("\n"),
    ).elements;

    expect(joinPostsToWires(elements)).toBe(elements);
  });
});

describe("merging wires", () => {
  /** The wires left once the editor tidies `lines`, as file lines. */
  function tidied(...lines: string[]) {
    const elements = Circuit.parse(lines.join("\n")).elements;

    return joinPostsToWires(mergeWires(elements))
      .filter((element) => element.isConductor())
      .map((wire) => wire.dump());
  }

  test("a wire drawn over a longer one disappears into it", () => {
    expect(tidied("w 0 0 0 128 0", "w 0 32 0 96 0")).toEqual(["w 0 0 0 128 0"]);
  });

  test("wires meeting in line with nothing else there become one", () => {
    expect(tidied("w 0 0 64 0 0", "w 128 0 64 0 0", "w 128 0 192 0 0")).toEqual(
      ["w 0 0 192 0 0"],
    );
  });

  test("overlapping wires combine, then split where a post lands", () => {
    expect(
      tidied("w 0 0 96 0 0", "w 32 0 128 0 0", "r 64 0 64 64 0 1000"),
    ).toEqual(["w 0 0 64 0 0", "w 64 0 128 0 0"]);
  });

  test("wires meeting at another post stay apart", () => {
    const elements = Circuit.parse(
      ["w 0 0 64 0 0", "w 64 0 128 0 0", "w 64 0 64 64 0"].join("\n"),
    ).elements;

    expect(mergeWires(elements)).toBe(elements);
  });

  test("wires on parallel lines or a gap apart stay apart", () => {
    const elements = Circuit.parse(
      ["w 0 0 64 0 0", "w 0 16 64 16 0", "w 80 0 128 0 0"].join("\n"),
    ).elements;

    expect(mergeWires(elements)).toBe(elements);
  });

  test("a diagonal wire merges with one in line with it", () => {
    expect(tidied("w 0 0 32 32 0", "w 32 32 64 64 0")).toEqual([
      "w 0 0 64 64 0",
    ]);
  });
});

describe("oscillator examples", () => {
  /** The frequency at which an example's `out` net rises through `level`. */
  function frequencyOf(id: string, level: number, stopTime: number) {
    const example = EXAMPLES.find((candidate) => candidate.id === id);

    const result = transient(example?.text ?? "", {
      stopTime,
      startTime: 0,
      maxTimeStep: 5e-6,
      initialConditions: "zero",
    });

    const values =
      result.traces.find(({ name }) => name === "V(out)")?.values ?? [];

    const rises = result.times
      .filter(
        (_time, index) =>
          index > 0 &&
          (values[index - 1] ?? 0) < level &&
          (values[index] ?? 0) >= level,
      )
      .slice(1);

    return (
      (rises.length - 1) / ((rises[rises.length - 1] ?? 0) - (rises[0] ?? 0))
    );
  }

  test("the Schmitt trigger example runs at the frequency its thresholds set", () => {
    // 10.045 kΩ with the output resistance, 1 µF, 4.5 V output, 1.4 V and 2.38 V:
    // T = RC × (ln((4.5 − 1.4) / (4.5 − 2.38)) + ln(2.38 / 1.4)) = 9.146 ms.
    const frequency = frequencyOf("schmitt-oscillator", 2.25, 0.1);

    expect(frequency).toBeGreaterThan((1 / 9.146e-3) * 0.99);
    expect(frequency).toBeLessThan((1 / 9.146e-3) * 1.01);
  });

  test("the relaxation oscillator example runs at about 65 Hz", () => {
    const frequency = frequencyOf("relaxation-oscillator", 0, 0.2);

    expect(frequency).toBeGreaterThan(55);
    expect(frequency).toBeLessThan(75);
  });
});
