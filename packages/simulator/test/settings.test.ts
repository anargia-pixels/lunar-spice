import { describe, expect, test } from "bun:test";

import {
  readSettings,
  settingsLine,
  settingsForSpeed,
  settingsForTimeStep,
  speedMultiplier,
} from "../src/circuit";

describe("simulation settings", () => {
  test("the speed sets the time step, at 40,000 steps a second", () => {
    const settings = settingsForSpeed(1);

    expect(settings.timeStep).toBe(25e-6);
    expect(
      speedMultiplier({ ...settings, currentSpeed: 50, voltageRange: 5 }),
    ).toBeCloseTo(1, 12);
  });

  test("every speed keeps the same step count", () => {
    for (const multiplier of [0.001, 0.01, 1, 100, 1000]) {
      const settings = settingsForSpeed(multiplier);
      const full = { ...settings, currentSpeed: 50, voltageRange: 5 };

      expect(speedMultiplier(full)).toBeCloseTo(multiplier, 12);
      expect(multiplier / settings.timeStep).toBeCloseTo(40_000, 6);
    }
  });

  test("reading a file keeps its speed and adopts the automatic time step", () => {
    // Falstad's default step and speed: 160 × 50 × 5 µs = 1/25 × real time.
    const settings = readSettings("$ 1 5e-6 50 50 5 50 5e-11");

    expect(speedMultiplier(settings)).toBeCloseTo(0.04, 12);
    expect(settings.timeStep).toBe(1000e-9);
    expect(settings.speed).toBe(250);
  });

  test("a saved settings line reads back unchanged", () => {
    const line = settingsLine(settingsForSpeed(0.01));

    expect(settingsLine(readSettings(line))).toBe(line);
  });

  test("a manual time step keeps the speed and changes the step count", () => {
    const settings = {
      ...settingsForTimeStep(1, 10e-6),
      currentSpeed: 50,
      voltageRange: 5,
    };

    expect(settings.timeStep).toBe(10e-6);
    expect(settings.isTimeStepManual).toBe(true);
    expect(speedMultiplier(settings)).toBeCloseTo(1, 12);
    expect(1 / settings.timeStep).toBeCloseTo(100_000, 6);
  });

  test("a manual time step reads back from its settings line", () => {
    const line = settingsLine(settingsForTimeStep(0.01, 1e-6));
    const settings = readSettings(line);

    expect(line).toBe("$ 65537 0.000001 62.5 50 5 50 5e-11 1");
    expect(settings.isTimeStepManual).toBe(true);
    expect(settings.timeStep).toBe(1e-6);
    expect(speedMultiplier(settings)).toBeCloseTo(0.01, 12);
    expect(settingsLine(settings)).toBe(line);
  });

  test("an automatic time step writes Falstad's settings line", () => {
    expect(settingsLine(settingsForSpeed(1))).toBe(
      "$ 1 0.000025 250 50 5 50 5e-11",
    );
    expect(readSettings("$ 1 5e-6 50 50 5 50 5e-11").isTimeStepManual).toBe(
      false,
    );
  });
});
