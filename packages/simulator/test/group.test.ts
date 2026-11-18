import { describe, expect, test } from "bun:test";

import { operatingPoint } from "../src/analyses";
import { Circuit, readElementLine } from "../src/circuit";
import { Group } from "../src/elements/group";
import { distanceToElement, withEnclosed } from "../src/layout";

/** A 10 V divider of two 1 kΩ resistors; a group holds the top one and the label "mid". */
const DIVIDER = [
  "$ 1 0.000005 10.2 50 5 50",
  String.raw`b -32 -96 64 32 65536 @label 0 0 Top\shalf`,
  "v 0 64 0 0 0 0 40 10 0 0 0.5",
  "r 0 0 32 0 0 1000",
  "r 32 0 32 64 0 1000",
  "w 32 64 0 64 0",
  "g 0 64 0 96 0 0",
  "207 32 0 48 0 0 mid",
].join("\n");

describe("group", () => {
  test("reads Falstad's box as a group and keeps its title through a save", () => {
    const line = String.raw`b -32 -96 64 32 65536 @label 0 0 Top\shalf`;
    const group = readElementLine(line);

    expect(group).toBeInstanceOf(Group);
    expect(group instanceof Group && group.titleText).toBe("Top half");
    expect(group?.dump()).toBe(line);
    expect(readElementLine("b 0 0 64 64 0")?.dump()).toBe("b 0 0 64 64 0");
  });

  test("holds what lies wholly inside it", () => {
    const { elements } = Circuit.parse(DIVIDER);
    const [group] = elements;

    if (!group) {
      throw new Error("Expected a group");
    }

    // The source and the lower resistor reach out of it.
    expect(
      withEnclosed([group], elements).map((element) => element.kind),
    ).toEqual(["group", "resistor", "label"]);
  });

  test("is picked by its border, not its inside", () => {
    const group = readElementLine("b 0 0 160 160 0");

    if (!group) {
      throw new Error("Expected a group");
    }

    expect(distanceToElement(group, { x: 80, y: 2 })).toBe(2);
    expect(distanceToElement(group, { x: 80, y: 80 })).toBe(80);
  });

  test("stays out of the simulation", () => {
    // 10 V across two equal resistors.
    const net = operatingPoint(DIVIDER).nets.find(({ net }) => net === "mid");

    expect(net?.voltage).toBeCloseTo(5, 6);
  });
});
