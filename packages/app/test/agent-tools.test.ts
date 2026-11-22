import { describe, expect, test } from "bun:test";

import {
  acSweep,
  operatingPoint,
  transient,
} from "@lunar-spice/simulator/analyses";
import { assignDesignators, Circuit } from "@lunar-spice/simulator/circuit";
import { joinPostsToWires, mergeWires } from "@lunar-spice/simulator/wiring";

import {
  type CircuitHost,
  type JsonObject,
  type JsonValue,
  runAgentTool,
  ToolInputError,
} from "../src/lib/agent-tools";

/** A host on a circuit of its own that edits it the way the editor commits an edit. */
function testHost() {
  let circuit = new Circuit();

  const host: CircuitHost = {
    title: () => "test",
    text: () => circuit.dump(),
    edit: (change) => {
      change(circuit);
      circuit.elements = [...joinPostsToWires(mergeWires(circuit.elements))];
      assignDesignators(circuit.elements);
    },
    openDraft: (_title, text) => {
      circuit = Circuit.parse(text);
    },
    analyze: async (request) => {
      switch (request.kind) {
        case "dc":
          return operatingPoint(request.text);
        case "ac":
          return acSweep(request.text, request.options);
        case "transient":
          return transient(request.text, request.options);
      }
    },
    simulate: () => ({ isRunning: false, time: 0, error: null }),
  };

  return host;
}

/** Runs a tool and returns its result as an object. */
async function call(host: CircuitHost, name: string, input: JsonObject) {
  const result: JsonValue = await runAgentTool(name, input, host);

  return JSON.parse(JSON.stringify(result));
}

/** A 10 V source across R1 over R2 to ground, with the middle labeled `out`. */
async function divider(host: CircuitHost) {
  await call(host, "place_parts", {
    parts: [
      { tool: "dc-source", x: 0, y: 64, values: { voltage: 10 } },
      { tool: "ground", x: 0, y: 64 },
      { tool: "resistor", x: 64, y: 0, values: { resistance: "1k" } },
      {
        tool: "resistor",
        x: 128,
        y: 0,
        rotate: 90,
        values: { resistance: "3k" },
      },
    ],
  });

  await call(host, "connect", {
    nets: [{ pins: ["V1:+", "R1:1"] }, { pins: ["R2:2", "V1:-"] }],
  });

  return call(host, "connect", {
    style: "label",
    nets: [{ name: "out", pins: ["R2:1"] }],
  });
}

/** The DC voltage of the net `name`, from `run_analysis`. */
async function dcVoltage(host: CircuitHost, name: string) {
  const result = await call(host, "run_analysis", { kind: "dc" });

  return result.nets.find(
    (net: { name: string; voltage: number }) => net.name === `V(${name})`,
  )?.voltage;
}

describe("agent tools", () => {
  test("place parts with their pins where the canvas would", async () => {
    const host = testHost();

    const [resistor] = await call(host, "place_parts", {
      parts: [{ tool: "resistor", x: 128, y: 0, rotate: 90 }],
    });

    // A quarter turn clockwise about the first pin points the resistor down.
    expect(resistor.ref).toBe("R1");
    expect(resistor.pins).toEqual([
      { pin: "1", x: 128, y: 0, net: expect.any(String) },
      { pin: "2", x: 128, y: 64, net: expect.any(String) },
    ]);
  });

  test("build, analyze and change a voltage divider", async () => {
    const host = testHost();
    const labeled = await divider(host);

    expect(labeled.pinNets["R2:1"]).toBe("out");
    // 10 V × 3 kΩ / (1 kΩ + 3 kΩ).
    expect(await dcVoltage(host, "out")).toBeCloseTo(7.5, 6);

    const circuit = await call(host, "get_circuit", {});

    expect(circuit.floatingPins).toEqual([]);
    expect(circuit.nets.out.sort()).toEqual(["R1:2", "R2:1"]);

    await call(host, "update_parts", {
      parts: [{ part: "R2", values: { resistance: "1k" } }],
    });

    expect(await dcVoltage(host, "out")).toBeCloseTo(5, 6);
  });

  test("report a pin left on a net of its own", async () => {
    const host = testHost();

    await call(host, "place_parts", {
      parts: [{ tool: "resistor", x: 0, y: 0 }],
    });

    const circuit = await call(host, "get_circuit", {});

    expect(circuit.floatingPins.sort()).toEqual(["R1:1", "R1:2"]);
  });

  test("place an optocoupler from a preset and name its pins", async () => {
    const host = testHost();

    const [coupler] = await call(host, "place_parts", {
      parts: [{ tool: "optocoupler", x: 0, y: 0, values: { preset: "4N35" } }],
    });

    expect(coupler.ref).toBe("U1");
    expect(coupler.value).toBe("4N35");
    expect(coupler.pins.map(({ pin }: { pin: string }) => pin)).toEqual([
      "A",
      "K",
      "C",
      "E",
    ]);
  });

  test("delete a part with the wires to its pins, as the canvas does", async () => {
    const host = testHost();

    await divider(host);

    const kinds = async () =>
      (await call(host, "get_circuit", {})).connectors
        .map(({ kind }: { kind: string }) => kind)
        .sort();

    const before = await kinds();

    // R1's wire from V1 goes with it; R2's wire to V1 and the label stay.
    await call(host, "delete_parts", { parts: ["R1"] });

    const after = await kinds();

    expect(before.filter((kind: string) => kind === "wire").length).toBe(
      after.filter((kind: string) => kind === "wire").length + 1,
    );
    expect(after).toContain("label");
  });

  test("delete parts and replace the circuit file", async () => {
    const host = testHost();

    await divider(host);
    await call(host, "delete_parts", { parts: ["R1"] });

    const circuit = await call(host, "get_circuit", {});

    expect(circuit.parts.map(({ ref }: { ref: string }) => ref).sort()).toEqual(
      ["R1", "V1"],
    );

    const written = await call(host, "set_circuit", {
      text: "r 0 0 64 0 0 100\nzz 0 0 0 0 0",
    });

    expect(written).toEqual({ elements: 1, skippedTypes: ["zz"] });
  });

  test("answer a bad call with what to fix", async () => {
    const host = testHost();

    expect(
      runAgentTool(
        "place_parts",
        { parts: [{ tool: "flux-capacitor", x: 0, y: 0 }] },
        host,
      ),
    ).rejects.toBeInstanceOf(ToolInputError);

    expect(
      runAgentTool(
        "place_parts",
        {
          parts: [{ tool: "resistor", x: 0, y: 0, values: { resistance: -1 } }],
        },
        host,
      ),
    ).rejects.toThrow("Must be above 0.");
  });
});
