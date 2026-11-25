import { describe, expect, test } from "bun:test";

import { Circuit } from "../src/circuit";
import { LuMatrix, MatrixPattern } from "../src/matrix";
import { Simulation } from "../src/simulation";

/** A dense row-major matrix and the pattern of its nonzero entries. */
function matrixOf(rows: readonly (readonly number[])[]) {
  const size = rows.length;
  const values = new Float64Array(size * size);
  const pattern = new MatrixPattern(size);

  rows.forEach((row, rowIndex) =>
    row.forEach((value, column) => {
      if (value !== 0) {
        values[rowIndex * size + column] = value;
        pattern.add(rowIndex * size + column);
      }
    }),
  );

  return { values, pattern };
}

/** Factors `values` with `lu` and solves for `rhs`; null when it is singular. */
function solveWith(
  lu: LuMatrix,
  values: Float64Array,
  pattern: MatrixPattern,
  rhs: readonly number[],
) {
  if (!lu.factor(values, pattern)) {
    return null;
  }

  const result = new Float64Array(rhs.length);

  lu.solve(Float64Array.from(rhs), result);

  return [...result];
}

function expectClose(actual: readonly number[] | null, expected: number[]) {
  expect(actual).not.toBeNull();
  expected.forEach((value, index) =>
    expect(actual?.[index] ?? Number.NaN).toBeCloseTo(value, 12),
  );
}

describe("sparse LU", () => {
  test("solves a voltage source's zero diagonal by pivoting", () => {
    // 1 kΩ from node 1 to ground, held at 5 V by a source whose current is unknown 2:
    // v1 / 1000 + i = 0 and v1 = 5, so i = -5 mA.
    const { values, pattern } = matrixOf([
      [1e-3, 1],
      [1, 0],
    ]);

    expectClose(
      solveWith(new LuMatrix(2), values, pattern, [0, 5]),
      [5, -0.005],
    );
  });

  test("refactors new values with the pivots it chose", () => {
    const { values, pattern } = matrixOf([
      [4, 1, 0],
      [1, 3, 1],
      [0, 1, 2],
    ]);

    const lu = new LuMatrix(3);

    expectClose(solveWith(lu, values, pattern, [5, 5, 3]), [1, 1, 1]);

    // Same pattern, new values: [[2, 1, 0], [1, 5, 1], [0, 1, 4]] × [1, 2, 3].
    values.set([2, 1, 0, 1, 5, 1, 0, 1, 4]);
    expectClose(solveWith(lu, values, pattern, [4, 14, 14]), [1, 2, 3]);
  });

  test("chooses new pivots when a chosen one vanishes", () => {
    const { values, pattern } = matrixOf([
      [2, 1],
      [1, 1],
    ]);

    const lu = new LuMatrix(2);

    expectClose(solveWith(lu, values, pattern, [3, 2]), [1, 1]);

    // A zero diagonal where the first factorization pivoted: [[0, 1], [1, 1]] × [2, 3].
    values[0] = 0;
    expectClose(solveWith(lu, values, pattern, [3, 5]), [2, 3]);
  });

  test("takes in an entry the pattern gains", () => {
    const { values, pattern } = matrixOf([
      [1, 0],
      [0, 1],
    ]);

    const lu = new LuMatrix(2);

    expectClose(solveWith(lu, values, pattern, [1, 1]), [1, 1]);

    // [[1, 1], [0, 1]] × [2, 3] = [5, 3].
    values[1] = 1;
    pattern.add(1);
    expectClose(solveWith(lu, values, pattern, [5, 3]), [2, 3]);
  });

  test("names the column without a pivot in a singular matrix", () => {
    const { values, pattern } = matrixOf([
      [1, 0, 0],
      [0, 0, 0],
      [0, 0, 1],
    ]);

    const lu = new LuMatrix(3);

    expect(lu.factor(values, pattern)).toBe(false);
    expect(lu.singularColumn).toBe(1);
  });
});

describe("idle elements", () => {
  const text = [
    "R 0 0 0 -32 0 0 40 5 0 0 0.5 0",
    "w 0 0 64 0 0",
    "r 64 0 64 64 0 1000",
    "g 64 64 64 80 0 0",
  ].join("\n");

  test("wires wait for updateIdleElements when asked to", () => {
    const circuit = Circuit.parse(text);
    const wire = circuit.elements.find(({ kind }) => kind === "wire");
    const simulation = new Simulation(circuit.elements, "transient", 1e-6);

    simulation.updatesIdleElements = false;
    simulation.step();

    expect(wire?.current).toBe(0);

    simulation.updateIdleElements();

    expect(Math.abs(wire?.current ?? 0)).toBeCloseTo(0.005, 9);
    expect(wire?.volts[0]).toBeCloseTo(5, 9);
  });

  test("a net label alone gets its voltage without the wire currents", () => {
    const circuit = Circuit.parse(`${text}\n207 64 0 112 0 0 top`);
    const wire = circuit.elements.find(({ kind }) => kind === "wire");
    const label = circuit.elements.find(({ kind }) => kind === "label");
    const simulation = new Simulation(circuit.elements, "transient", 1e-6);

    simulation.updatesIdleElements = false;
    simulation.step();
    simulation.updateIdleElementsAmong(label ? [label] : []);

    expect(label?.volts[0]).toBeCloseTo(5, 9);
    expect(wire?.current).toBe(0);

    simulation.updateIdleElementsAmong(wire ? [wire] : []);

    expect(Math.abs(wire?.current ?? 0)).toBeCloseTo(0.005, 9);
  });

  test("a resistor's current waits too, and is there when asked for", () => {
    const circuit = Circuit.parse(text);
    const resistor = circuit.elements.find(({ kind }) => kind === "resistor");
    const simulation = new Simulation(circuit.elements, "transient", 1e-6);

    simulation.updatesIdleElements = false;
    simulation.step();

    expect(resistor?.current).toBe(0);

    simulation.updateIdleElementsAmong(resistor ? [resistor] : []);

    expect(Math.abs(resistor?.current ?? 0)).toBeCloseTo(0.005, 9);
  });

  test("wires follow every step by default", () => {
    const circuit = Circuit.parse(text);
    const wire = circuit.elements.find(({ kind }) => kind === "wire");
    const simulation = new Simulation(circuit.elements, "transient", 1e-6);

    simulation.step();

    expect(Math.abs(wire?.current ?? 0)).toBeCloseTo(0.005, 9);
  });
});

/** Solves a dense copy of `rows` by Gaussian elimination with partial pivoting. */
function denseSolve(rows: readonly (readonly number[])[], rhs: number[]) {
  const a = rows.map((row, index) => [...row, rhs[index] ?? 0]);
  const size = rows.length;

  for (let column = 0; column < size; column += 1) {
    let best = column;

    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(a[row]?.[column] ?? 0) > Math.abs(a[best]?.[column] ?? 0)) {
        best = row;
      }
    }

    [a[column], a[best]] = [a[best] ?? [], a[column] ?? []];

    for (let row = column + 1; row < size; row += 1) {
      const factor = (a[row]?.[column] ?? 0) / (a[column]?.[column] ?? 1);

      for (let entry = column; entry <= size; entry += 1) {
        const target = a[row] ?? [];

        target[entry] =
          (target[entry] ?? 0) - factor * (a[column]?.[entry] ?? 0);
      }
    }
  }

  const result = Array.from({ length: size }, () => 0);

  for (let row = size - 1; row >= 0; row -= 1) {
    let sum = a[row]?.[size] ?? 0;

    for (let column = row + 1; column < size; column += 1) {
      sum -= (a[row]?.[column] ?? 0) * (result[column] ?? 0);
    }

    result[row] = sum / (a[row]?.[row] ?? 1);
  }

  return result;
}

describe("sparse LU with variable entries", () => {
  // A ladder with a voltage source's zero diagonal in unknown 3; entries 0 and 5 vary.
  const constant = [
    [2, -1, 0, 1],
    [-1, 3, -1, 0],
    [0, -1, 2, 0],
    [1, 0, 0, 0],
  ];

  const variableIndices = [0, 5];

  /** The matrix with `first` and `second` added to the variable entries. */
  function rowsWith(first: number, second: number) {
    return constant.map((row, rowIndex) =>
      row.map((value, column) => {
        const index = rowIndex * 4 + column;

        if (index === 0) {
          return value + first;
        }

        return index === 5 ? value + second : value;
      }),
    );
  }

  test("updates and solves like a dense solve, before and after compiling", () => {
    const { values, pattern } = matrixOf(constant);
    const lu = new LuMatrix(4);

    for (const index of variableIndices) {
      pattern.addVariable(index);
    }

    expect(lu.factor(values, pattern)).toBe(true);

    // Enough solves to compile the pivots as chosen, then some more.
    for (let solve = 0; solve < 600; solve += 1) {
      const first = Math.sin(solve) * 0.5;
      const second = Math.cos(solve * 0.7) * 0.8;
      const rows = rowsWith(first, second);
      const rhs = [1, solve % 3, -2, 5];

      values[0] = rows[0]?.[0] ?? 0;
      values[5] = rows[1]?.[1] ?? 0;

      const result = new Float64Array(4);

      expect(
        lu.updateAndSolve(values, pattern, Float64Array.from(rhs), result),
      ).toBe(true);
      expectClose([...result], denseSolve(rows, rhs));
    }
  });

  test("factorizations with the same pivots solve their own values once compiled", () => {
    const first = matrixOf(constant);
    const second = matrixOf(constant);
    const lus = [new LuMatrix(4), new LuMatrix(4)];
    const systems = [first, second];

    for (const { pattern } of systems) {
      for (const index of variableIndices) {
        pattern.addVariable(index);
      }
    }

    systems.forEach(({ values, pattern }, index) =>
      expect(lus[index]?.factor(values, pattern)).toBe(true),
    );

    // Both compile the same code; their solves interleave with different values.
    for (let solve = 0; solve < 600; solve += 1) {
      systems.forEach(({ values, pattern }, index) => {
        const sign = index === 0 ? 1 : -1;
        const rows = rowsWith(sign * Math.sin(solve) * 0.5, sign * 0.3);
        const rhs = [1, index, -2, solve % 5];
        const result = new Float64Array(4);

        values[0] = rows[0]?.[0] ?? 0;
        values[5] = rows[1]?.[1] ?? 0;
        expect(
          lus[index]?.updateAndSolve(
            values,
            pattern,
            Float64Array.from(rhs),
            result,
          ),
        ).toBe(true);
        expectClose([...result], denseSolve(rows, rhs));
      });
    }
  });

  test("chooses new pivots when a variable pivot vanishes after compiling", () => {
    const { values, pattern } = matrixOf([
      [2, 1],
      [1, 1],
    ]);

    const lu = new LuMatrix(2);

    pattern.addVariable(0);
    expect(lu.factor(values, pattern)).toBe(true);

    const result = new Float64Array(2);

    for (let solve = 0; solve < 300; solve += 1) {
      lu.updateAndSolve(values, pattern, Float64Array.from([3, 2]), result);
    }

    expectClose([...result], [1, 1]);

    // [[0, 1], [1, 1]] × [2, 3] = [3, 5].
    values[0] = 0;
    expect(
      lu.updateAndSolve(values, pattern, Float64Array.from([3, 5]), result),
    ).toBe(true);
    expectClose([...result], [2, 3]);
  });
});
