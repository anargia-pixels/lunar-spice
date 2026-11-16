/** Pivots smaller than this mean the circuit has no unique solution. */
const SINGULAR_PIVOT = 1e-20;

/**
 * How small a pivot may be next to the largest entry below it in its column, as in SPICE's
 * sparse solver: smaller ones lose accuracy, so the pivots are chosen again.
 */
const PIVOT_THRESHOLD = 1e-3;

/**
 * How many times one pivot order must have solved before it is compiled. Analyses build a
 * system for a handful of solves, which loops handle sooner than a compiler would.
 */
const COMPILE_AFTER_SOLVES = 256;

/**
 * The most statements a compiled solve may hold. Engines leave very long functions to
 * their slow tiers, where the loops are faster.
 */
const MAX_COMPILED_STATEMENTS = 3000;

/**
 * A factorization's update and solve as straight-line code for its pattern: every index
 * the loops look up is a constant in it, which runs several times faster. Returns the sum
 * of the results, or NaN when a pivot has to be chosen again. Arguments are the matrix,
 * the right-hand side, the results and their offset, then the factorization's
 * `restValues`, `values` and `inverses`.
 */
type CompiledSolve = (
  source: Float64Array,
  rhs: Float64Array,
  result: Float64Array,
  offset: number,
  restValues: Float64Array,
  values: Float64Array,
  inverses: Float64Array,
) => number;

/** False once the platform has refused to compile code, as a content security policy does. */
let canCompile = true;

/** Returns `terms` added up as a balanced tree, which a processor adds side by side. */
function sumOf(terms: readonly string[]): string {
  if (terms.length <= 1) {
    return terms[0] ?? "0";
  }

  const middle = terms.length >> 1;

  return `(${sumOf(terms.slice(0, middle))} + ${sumOf(terms.slice(middle))})`;
}

/** An entry's state in a `MatrixPattern`'s mask. */
const EMPTY_ENTRY = 0;

const CONSTANT_ENTRY = 1;

export const VARIABLE_ENTRY = 2;

/**
 * The entries of a square matrix that have ever held a value, in the order they first
 * did. Indices are row-major. Variable entries are the ones that change from one
 * factorization to the next, as a nonlinear element's do with every Newton iteration; the
 * rest only change when the whole matrix is factored again. `version` changes whenever
 * either set grows, so a factorization knows when its pivot order no longer covers the
 * matrix.
 */
export class MatrixPattern {
  /** 0 for an empty entry, 1 for a constant one, 2 for a variable one. */
  readonly mask: Uint8Array;
  readonly indices: number[] = [];
  /** The variable entries among `indices`. */
  readonly variable: number[] = [];
  version = 0;

  constructor(size: number) {
    this.mask = new Uint8Array(size * size);
  }

  /** Records that the entry at `index` holds a value. */
  add(index: number) {
    if (this.mask[index] === EMPTY_ENTRY) {
      this.mask[index] = CONSTANT_ENTRY;
      this.indices.push(index);
      this.version += 1;
    }
  }

  /** Records that the entry at `index` holds a value that changes between factorizations. */
  addVariable(index: number) {
    if (this.mask[index] === VARIABLE_ENTRY) {
      return;
    }

    if (this.mask[index] === EMPTY_ENTRY) {
      this.indices.push(index);
    }

    this.mask[index] = VARIABLE_ENTRY;
    this.variable.push(index);
    this.version += 1;
  }
}

/** What `analyze` works out for each pivot before it is stored flat. */
type Elimination = {
  /** The rows each pivot eliminates and the columns right of it, one list per pivot. */
  lower: number[][];
  upper: number[][];
};

/**
 * A square real matrix factored into L and U, kept sparse. Circuit matrices are mostly
 * zeros, and their pattern stays the same from one Newton iteration to the next, so the
 * first factorization chooses pivots that keep it sparse (Markowitz's rule) and records
 * which entries each elimination touches. Later ones repeat only that arithmetic, and
 * choose pivots again only when the pattern grows or a pivot gets too small.
 *
 * Rows and columns that hold no variable entry are eliminated first. Those pivots and
 * what they leave in the rest of the matrix never change, so `update` starts from that
 * and eliminates only the rest.
 *
 * The factors live in `values`: each pivot, then L pivot by pivot, then U likewise.
 */
export class LuMatrix {
  readonly size: number;
  /** The column whose pivot vanished in the last failed factorization; -1 after success. */
  singularColumn = -1;
  /** Row and column of each pivot, in elimination order. */
  private readonly pivotRows: Int32Array;
  private readonly pivotColumns: Int32Array;
  /** One over each pivot, so substitution multiplies instead of dividing. */
  private readonly inverses: Float64Array;
  /**
   * For pivot `k`, entries `lowerStart[k]` to `lowerStart[k + 1]` of `lowerRows` are the
   * rows it eliminates; `lowerValues` holds their factors.
   */
  private readonly lowerStart: Int32Array;
  private lowerRows = new Int32Array(0);
  private lowerValues = new Float64Array(0);
  /** Likewise the columns right of pivot `k` in its row, and their values. */
  private readonly upperStart: Int32Array;
  private upperColumns = new Int32Array(0);
  private upperValues = new Float64Array(0);
  /** Pivots, L and U in one array, which the three views above index into. */
  private values = new Float64Array(0);
  /**
   * The entry of `values` each elimination subtracts from: for pivot `k` from
   * `targetStart[k]`, one per pair of a row it eliminates and a column right of it.
   */
  private readonly targetStart: Int32Array;
  private targets = new Int32Array(0);
  /** The matrix entry each entry of `values` loads from. */
  private sources = new Int32Array(0);
  /** How many pivots come before the first row or column with a variable entry. */
  private constantPivots = 0;
  /** The entries of `values` past the constant pivots, and what those pivots leave there. */
  private restSlots = new Int32Array(0);
  private restValues = new Float64Array(0);
  /** The variable entries: where they sit in `values`, in the matrix, and their last values. */
  private variableSlots = new Int32Array(0);
  private variableSources = new Int32Array(0);
  private variableValues = new Float64Array(0);
  /** The pattern version the pivots were chosen for; -1 before the first. */
  private analyzedVersion = -1;
  /** The compiled update and solve for the pivots as chosen; null while the loops run. */
  private compiled: CompiledSolve | null = null;
  /** Solves left before the pivots as chosen are compiled. */
  private solvesUntilCompiled = COMPILE_AFTER_SOLVES;

  constructor(size: number) {
    this.size = size;
    this.pivotRows = new Int32Array(size);
    this.pivotColumns = new Int32Array(size);
    this.inverses = new Float64Array(size);
    this.lowerStart = new Int32Array(size + 1);
    this.upperStart = new Int32Array(size + 1);
    this.targetStart = new Int32Array(size + 1);
  }

  /**
   * Factors `source` (row-major, `size` squared), whose nonzero entries all lie in
   * `pattern`; false when it is singular.
   */
  factor(source: Float64Array, pattern: MatrixPattern) {
    this.singularColumn = -1;

    if (pattern.version !== this.analyzedVersion) {
      return this.analyze(source, pattern);
    }

    return this.load(source, true) || this.analyze(source, pattern);
  }

  /**
   * Factors `source` when only its variable entries have changed since the last
   * factorization; false when it is singular. A matrix equal to the last one is not
   * factored again.
   */
  update(source: Float64Array, pattern: MatrixPattern) {
    if (pattern.version !== this.analyzedVersion) {
      this.singularColumn = -1;

      return this.analyze(source, pattern);
    }

    const { variableSources, variableValues } = this;
    let isChanged = false;

    for (let entry = 0; entry < variableSources.length; entry += 1) {
      const value = source[variableSources[entry] ?? 0] ?? 0;

      if (value !== variableValues[entry]) {
        variableValues[entry] = value;
        isChanged = true;
      }
    }

    if (!isChanged) {
      return true;
    }

    this.singularColumn = -1;

    return this.eliminateRest(true) || this.analyze(source, pattern);
  }

  /**
   * Factors `source` when only its variable entries have changed since the last
   * factorization, then solves for `rhs` as `solve` does. False when the matrix is
   * singular or a result is not finite. A pivot order that keeps solving is compiled.
   */
  updateAndSolve(
    source: Float64Array,
    pattern: MatrixPattern,
    rhs: Float64Array,
    result: Float64Array,
    offset = 0,
  ) {
    if (pattern.version === this.analyzedVersion) {
      if (this.solvesUntilCompiled > 0) {
        this.solvesUntilCompiled -= 1;

        if (this.solvesUntilCompiled === 0) {
          this.compiled = this.compile();
        }
      }

      // A compiled solve that gives up leaves everything as it was for the loops.
      if (
        this.compiled !== null &&
        Number.isFinite(
          this.compiled(
            source,
            rhs,
            result,
            offset,
            this.restValues,
            this.values,
            this.inverses,
          ),
        )
      ) {
        return true;
      }
    }

    return (
      this.update(source, pattern) &&
      Number.isFinite(this.solve(rhs, result, offset))
    );
  }

  /**
   * Writes `updateAndSolve` for the pivots as chosen as straight-line code; null when the
   * platform does not compile code or the pattern is too large for it to pay off. The
   * code does the arithmetic of `eliminateRest` and `solve` in the same order, with the
   * entries past the constant pivots in local variables.
   */
  private compile(): CompiledSolve | null {
    const { size, pivotRows, pivotColumns, constantPivots } = this;
    const { lowerStart, lowerRows, upperStart, upperColumns } = this;
    const { targets, targetStart, restSlots } = this;
    const { variableSlots, variableSources } = this;
    const upperOffset = size + lowerRows.length;

    const statements =
      2 * restSlots.length + targets.length + 4 * size + upperColumns.length;

    if (!canCompile || statements > MAX_COMPILED_STATEMENTS) {
      return null;
    }

    const isLocal = new Uint8Array(upperOffset + upperColumns.length);
    const code: string[] = ['"use strict";'];

    /** The value at entry `slot` of `values`: a local past the constant pivots. */
    const valueAt = (slot: number) =>
      isLocal[slot] ? `v${slot}` : `values[${slot}]`;

    // Start past the constant pivots from what they left there plus the variable entries.
    restSlots.forEach((slot, entry) => {
      const variable = variableSlots.indexOf(slot);

      const added =
        variable < 0 ? "" : ` + source[${variableSources[variable] ?? 0}]`;

      isLocal[slot] = 1;
      code.push(`let v${slot} = restValues[${entry}]${added};`);
    });

    // Eliminate, giving up where the loops would choose pivots again.
    for (let pivot = constantPivots; pivot < size; pivot += 1) {
      const lowerFirst = lowerStart[pivot] ?? 0;
      const lowerEnd = lowerStart[pivot + 1] ?? 0;
      const upperFirst = upperStart[pivot] ?? 0;
      const upperEnd = upperStart[pivot + 1] ?? 0;
      let target = targetStart[pivot] ?? 0;

      code.push(
        `if (!(Math.abs(v${pivot}) > ${SINGULAR_PIVOT})) return NaN;`,
        `const i${pivot} = 1 / v${pivot};`,
      );

      if (lowerEnd > lowerFirst) {
        code.push(
          `const t${pivot} = Math.abs(v${pivot}) / ${PIVOT_THRESHOLD};`,
        );
      }

      for (let entry = lowerFirst; entry < lowerEnd; entry += 1) {
        const lower = `v${size + entry}`;

        code.push(
          `if (Math.abs(${lower}) > t${pivot}) return NaN;`,
          `${lower} /= v${pivot};`,
        );

        for (let upper = upperFirst; upper < upperEnd; upper += 1) {
          code.push(
            `v${targets[target] ?? 0} -= ${lower} * v${upperOffset + upper};`,
          );
          target += 1;
        }
      }
    }

    // Substitute forward through L, then backward through U.
    for (let row = 0; row < size; row += 1) {
      code.push(`let r${row} = rhs[${row}];`);
    }

    for (let pivot = 0; pivot < size; pivot += 1) {
      const lowerEnd = lowerStart[pivot + 1] ?? 0;

      for (let entry = lowerStart[pivot] ?? 0; entry < lowerEnd; entry += 1) {
        code.push(
          `r${lowerRows[entry] ?? 0} -= ${valueAt(size + entry)} * r${pivotRows[pivot] ?? 0};`,
        );
      }
    }

    for (let pivot = size - 1; pivot >= 0; pivot -= 1) {
      const upperEnd = upperStart[pivot + 1] ?? 0;
      let sum = `r${pivotRows[pivot] ?? 0}`;

      for (let entry = upperStart[pivot] ?? 0; entry < upperEnd; entry += 1) {
        sum += ` - ${valueAt(upperOffset + entry)} * x${upperColumns[entry] ?? 0}`;
      }

      const inverse =
        pivot < constantPivots ? `inverses[${pivot}]` : `i${pivot}`;

      code.push(`const x${pivotColumns[pivot] ?? 0} = (${sum}) * ${inverse};`);
    }

    const results = Array.from({ length: size }, (_, column) => `x${column}`);

    results.forEach((name, column) => {
      code.push(`result[offset + ${column}] = ${name};`);
    });
    code.push(`return ${sumOf(results)};`);

    try {
      // SAFETY: the code above is a function of these seven arguments that returns a
      // number, built from this factorization's own indices and no outside text.
      return new Function(
        "source",
        "rhs",
        "result",
        "offset",
        "restValues",
        "values",
        "inverses",
        code.join("\n"),
      ) as CompiledSolve;
    } catch {
      canCompile = false;

      return null;
    }
  }

  /**
   * Loads every entry from `source` and eliminates along the recorded pivots; false when
   * a pivot is singular or, with `checksPivots`, too small to keep.
   */
  private load(source: Float64Array, checksPivots: boolean) {
    const { values, sources, restSlots, restValues } = this;
    const { variableSlots, variableSources, variableValues } = this;

    for (let slot = 0; slot < values.length; slot += 1) {
      values[slot] = source[sources[slot] ?? 0] ?? 0;
    }

    // The constant pivots never read a variable entry, so those wait at zero.
    for (let entry = 0; entry < variableSlots.length; entry += 1) {
      variableValues[entry] = source[variableSources[entry] ?? 0] ?? 0;
      values[variableSlots[entry] ?? 0] = 0;
    }

    if (!this.eliminate(0, this.constantPivots, checksPivots)) {
      return false;
    }

    for (let entry = 0; entry < restSlots.length; entry += 1) {
      restValues[entry] = values[restSlots[entry] ?? 0] ?? 0;
    }

    return this.eliminateRest(checksPivots);
  }

  /**
   * Eliminates past the constant pivots, from what they left there plus the variable
   * entries' latest values.
   */
  private eliminateRest(checksPivots: boolean) {
    const { values, restSlots, restValues } = this;
    const { variableSlots, variableValues } = this;

    for (let entry = 0; entry < restSlots.length; entry += 1) {
      values[restSlots[entry] ?? 0] = restValues[entry] ?? 0;
    }

    for (let entry = 0; entry < variableSlots.length; entry += 1) {
      const slot = variableSlots[entry] ?? 0;

      values[slot] = (values[slot] ?? 0) + (variableValues[entry] ?? 0);
    }

    return this.eliminate(this.constantPivots, this.size, checksPivots);
  }

  /**
   * Repeats the recorded eliminations of pivots `from` up to `to` on the loaded values;
   * false when a pivot is singular or, with `checksPivots`, too small next to its column.
   */
  private eliminate(from: number, to: number, checksPivots: boolean) {
    const { values, inverses, targets, targetStart } = this;
    const { lowerStart, lowerValues, upperStart, upperValues } = this;

    for (let pivot = from; pivot < to; pivot += 1) {
      const pivotValue = values[pivot] ?? 0;
      const lowerFirst = lowerStart[pivot] ?? 0;
      const lowerEnd = lowerStart[pivot + 1] ?? 0;
      const upperFirst = upperStart[pivot] ?? 0;
      const upperEnd = upperStart[pivot + 1] ?? 0;
      const magnitude = Math.abs(pivotValue);

      if (!(magnitude > SINGULAR_PIVOT)) {
        this.singularColumn = this.pivotColumns[pivot] ?? 0;

        return false;
      }

      if (checksPivots) {
        const limit = magnitude / PIVOT_THRESHOLD;

        for (let entry = lowerFirst; entry < lowerEnd; entry += 1) {
          if (Math.abs(lowerValues[entry] ?? 0) > limit) {
            return false;
          }
        }
      }

      let target = targetStart[pivot] ?? 0;

      inverses[pivot] = 1 / pivotValue;

      for (let entry = lowerFirst; entry < lowerEnd; entry += 1) {
        const factor = (lowerValues[entry] ?? 0) / pivotValue;

        lowerValues[entry] = factor;

        if (factor === 0) {
          target += upperEnd - upperFirst;
          continue;
        }

        for (let upper = upperFirst; upper < upperEnd; upper += 1) {
          const slot = targets[target] ?? 0;

          values[slot] =
            (values[slot] ?? 0) - factor * (upperValues[upper] ?? 0);
          target += 1;
        }
      }
    }

    return true;
  }

  /**
   * Chooses each pivot by Markowitz's rule: of the entries no smaller than
   * `PIVOT_THRESHOLD` of their column's largest, the one whose row and column hold the
   * fewest others, so the factors fill in the fewest zeros. Rows and columns without a
   * variable entry go first. Records the eliminations, then factors `source` along them.
   */
  private analyze(source: Float64Array, pattern: MatrixPattern) {
    const { size, pivotRows, pivotColumns } = this;
    const dense = new Float64Array(source);
    const isNonzero = new Uint8Array(size * size);
    const isVariableRow = new Uint8Array(size);
    const isVariableColumn = new Uint8Array(size);
    const rowCounts = new Int32Array(size);
    const columnCounts = new Int32Array(size);
    const columnLargest = new Float64Array(size);
    const rows = Int32Array.from({ length: size }, (_, index) => index);
    const columns = Int32Array.from(rows);
    const elimination: Elimination = { lower: [], upper: [] };
    let isConstant = true;

    this.singularColumn = -1;
    this.analyzedVersion = -1;
    this.constantPivots = size;
    this.compiled = null;
    this.solvesUntilCompiled = COMPILE_AFTER_SOLVES;

    for (const index of pattern.indices) {
      const row = Math.floor(index / size);
      const column = index % size;

      isNonzero[index] = 1;
      rowCounts[row] = (rowCounts[row] ?? 0) + 1;
      columnCounts[column] = (columnCounts[column] ?? 0) + 1;
    }

    for (const index of pattern.variable) {
      isVariableRow[Math.floor(index / size)] = 1;
      isVariableColumn[index % size] = 1;
    }

    for (let pivot = 0; pivot < size; pivot += 1) {
      // Rows and columns from `pivot` on are not yet eliminated.
      for (let at = pivot; at < size; at += 1) {
        columnLargest[at] = 0;
      }

      for (let rowAt = pivot; rowAt < size; rowAt += 1) {
        const rowStart = (rows[rowAt] ?? 0) * size;

        for (let columnAt = pivot; columnAt < size; columnAt += 1) {
          columnLargest[columnAt] = Math.max(
            columnLargest[columnAt] ?? 0,
            Math.abs(dense[rowStart + (columns[columnAt] ?? 0)] ?? 0),
          );
        }
      }

      let best = isConstant
        ? this.choosePivot(
            pivot,
            dense,
            rows,
            columns,
            isNonzero,
            rowCounts,
            columnCounts,
            columnLargest,
            isVariableRow,
            isVariableColumn,
          )
        : null;

      // No constant row and column are left to pair: the rest changes with the variables.
      if (!best) {
        if (isConstant) {
          isConstant = false;
          this.constantPivots = pivot;
        }

        best = this.choosePivot(
          pivot,
          dense,
          rows,
          columns,
          isNonzero,
          rowCounts,
          columnCounts,
          columnLargest,
          null,
          null,
        );
      }

      if (!best) {
        // Name the column with the smallest entries as the one without a pivot.
        let smallest = pivot;

        for (let columnAt = pivot; columnAt < size; columnAt += 1) {
          if ((columnLargest[columnAt] ?? 0) < (columnLargest[smallest] ?? 0)) {
            smallest = columnAt;
          }
        }

        this.singularColumn = columns[smallest] ?? 0;

        return false;
      }

      const [pivotRowAt, pivotColumnAt] = best;
      const pivotRow = rows[pivotRowAt] ?? 0;
      const pivotColumn = columns[pivotColumnAt] ?? 0;

      rows[pivotRowAt] = rows[pivot] ?? 0;
      rows[pivot] = pivotRow;
      columns[pivotColumnAt] = columns[pivot] ?? 0;
      columns[pivot] = pivotColumn;
      pivotRows[pivot] = pivotRow;
      pivotColumns[pivot] = pivotColumn;

      const pivotStart = pivotRow * size;
      const pivotValue = dense[pivotStart + pivotColumn] ?? 1;
      const lower: number[] = [];
      const upper: number[] = [];

      for (let at = pivot + 1; at < size; at += 1) {
        const column = columns[at] ?? 0;

        if (isNonzero[pivotStart + column]) {
          upper.push(column);
          columnCounts[column] = (columnCounts[column] ?? 0) - 1;
        }
      }

      for (let at = pivot + 1; at < size; at += 1) {
        const row = rows[at] ?? 0;
        const rowStart = row * size;

        if (!isNonzero[rowStart + pivotColumn]) {
          continue;
        }

        lower.push(row);
        rowCounts[row] = (rowCounts[row] ?? 0) - 1;

        const factor = (dense[rowStart + pivotColumn] ?? 0) / pivotValue;

        for (const column of upper) {
          const target = rowStart + column;

          if (!isNonzero[target]) {
            isNonzero[target] = 1;
            rowCounts[row] = (rowCounts[row] ?? 0) + 1;
            columnCounts[column] = (columnCounts[column] ?? 0) + 1;
          }

          dense[target] =
            (dense[target] ?? 0) - factor * (dense[pivotStart + column] ?? 0);
        }
      }

      elimination.lower.push(lower);
      elimination.upper.push(upper);
    }

    this.record(elimination, pattern);

    // The pivots were just chosen for these values, so they are not tested again.
    if (!this.load(source, false)) {
      return false;
    }

    this.analyzedVersion = pattern.version;

    return true;
  }

  /**
   * Returns the positions in `rows` and `columns` of the next pivot, from `pivot` on, or
   * null when no entry is large enough. With `isVariableRow` and `isVariableColumn`, only
   * rows and columns they leave unmarked are considered.
   */
  private choosePivot(
    pivot: number,
    dense: Float64Array,
    rows: Int32Array,
    columns: Int32Array,
    isNonzero: Uint8Array,
    rowCounts: Int32Array,
    columnCounts: Int32Array,
    columnLargest: Float64Array,
    isVariableRow: Uint8Array | null,
    isVariableColumn: Uint8Array | null,
  ): [number, number] | null {
    const { size } = this;
    let best: [number, number] | null = null;
    let bestCost = Number.POSITIVE_INFINITY;
    let bestRatio = 0;

    for (let rowAt = pivot; rowAt < size; rowAt += 1) {
      const row = rows[rowAt] ?? 0;
      const rowStart = row * size;

      if (isVariableRow?.[row]) {
        continue;
      }

      for (let columnAt = pivot; columnAt < size; columnAt += 1) {
        const column = columns[columnAt] ?? 0;

        if (!isNonzero[rowStart + column] || isVariableColumn?.[column]) {
          continue;
        }

        const magnitude = Math.abs(dense[rowStart + column] ?? 0);
        const largest = columnLargest[columnAt] ?? 0;

        if (
          !(magnitude > SINGULAR_PIVOT) ||
          magnitude < PIVOT_THRESHOLD * largest
        ) {
          continue;
        }

        const cost =
          ((rowCounts[row] ?? 1) - 1) * ((columnCounts[column] ?? 1) - 1);

        const ratio = magnitude / largest;

        if (cost < bestCost || (cost === bestCost && ratio > bestRatio)) {
          best = [rowAt, columnAt];
          bestCost = cost;
          bestRatio = ratio;
        }
      }
    }

    return best;
  }

  /** Stores the eliminations `analyze` chose, as the flat lists the other methods walk. */
  private record(elimination: Elimination, pattern: MatrixPattern) {
    const { size, pivotRows, pivotColumns } = this;
    const { lowerStart, upperStart, targetStart, constantPivots } = this;
    const lower = elimination.lower.flat();
    const upper = elimination.upper.flat();
    const upperOffset = size + lower.length;
    const slotCount = upperOffset + upper.length;
    /** Where each matrix entry sits in `values`; -1 for the ones that stay zero. */
    const slots = new Int32Array(size * size).fill(-1);
    const sources = new Int32Array(slotCount);
    const rest: number[] = [];
    const targets: number[] = [];
    let lowerAt = 0;
    let upperAt = 0;

    /** Gives the matrix entry at `index` the entry `slot` of `values`. */
    const place = (index: number, slot: number, pivot: number) => {
      slots[index] = slot;
      sources[slot] = index;

      if (pivot >= constantPivots) {
        rest.push(slot);
      }
    };

    elimination.lower.forEach((rowsBelow, pivot) => {
      const pivotRow = pivotRows[pivot] ?? 0;
      const pivotColumn = pivotColumns[pivot] ?? 0;

      lowerStart[pivot] = lowerAt;
      upperStart[pivot] = upperAt;
      place(pivotRow * size + pivotColumn, pivot, pivot);

      for (const row of rowsBelow) {
        place(row * size + pivotColumn, size + lowerAt, pivot);
        lowerAt += 1;
      }

      for (const column of elimination.upper[pivot] ?? []) {
        place(pivotRow * size + column, upperOffset + upperAt, pivot);
        upperAt += 1;
      }
    });
    lowerStart[size] = lowerAt;
    upperStart[size] = upperAt;

    // Every entry has its place now, so each elimination can name the ones it changes.
    elimination.lower.forEach((rowsBelow, pivot) => {
      targetStart[pivot] = targets.length;

      for (const row of rowsBelow) {
        for (const column of elimination.upper[pivot] ?? []) {
          targets.push(slots[row * size + column] ?? 0);
        }
      }
    });
    targetStart[size] = targets.length;

    this.values = new Float64Array(slotCount);
    this.lowerValues = this.values.subarray(size, upperOffset);
    this.upperValues = this.values.subarray(upperOffset);
    this.lowerRows = Int32Array.from(lower);
    this.upperColumns = Int32Array.from(upper);
    this.targets = Int32Array.from(targets);
    this.sources = sources;
    this.restSlots = Int32Array.from(rest);
    this.restValues = new Float64Array(rest.length);
    this.variableSources = Int32Array.from(pattern.variable);
    this.variableSlots = this.variableSources.map((index) => slots[index] ?? 0);
    this.variableValues = new Float64Array(pattern.variable.length);
  }

  /**
   * Solves for the right-hand side `rhs`, indexed by row, into `result` from `offset` on,
   * indexed by column. `rhs` is overwritten. Returns the sum of the results, which is not
   * finite when any of them is not.
   */
  solve(rhs: Float64Array, result: Float64Array, offset = 0) {
    const { size, pivotRows, pivotColumns, inverses } = this;
    const { lowerStart, lowerRows, lowerValues } = this;
    const { upperStart, upperColumns, upperValues } = this;
    let total = 0;

    // Substitute forward through L, one pivot's eliminations at a time.
    for (let pivot = 0; pivot < size; pivot += 1) {
      const value = rhs[pivotRows[pivot] ?? 0] ?? 0;

      if (value === 0) {
        continue;
      }

      const lowerEnd = lowerStart[pivot + 1] ?? 0;

      for (let entry = lowerStart[pivot] ?? 0; entry < lowerEnd; entry += 1) {
        const row = lowerRows[entry] ?? 0;

        rhs[row] = (rhs[row] ?? 0) - (lowerValues[entry] ?? 0) * value;
      }
    }

    // Substitute backward through U.
    for (let pivot = size - 1; pivot >= 0; pivot -= 1) {
      const upperEnd = upperStart[pivot + 1] ?? 0;
      let sum = rhs[pivotRows[pivot] ?? 0] ?? 0;

      for (let entry = upperStart[pivot] ?? 0; entry < upperEnd; entry += 1) {
        sum -=
          (upperValues[entry] ?? 0) *
          (result[offset + (upperColumns[entry] ?? 0)] ?? 0);
      }

      const value = sum * (inverses[pivot] ?? 0);

      result[offset + (pivotColumns[pivot] ?? 0)] = value;
      total += value;
    }

    return total;
  }
}

/**
 * Solves a complex system `(real + i·imag) x = rhs` by Gaussian elimination with
 * partial pivoting. Every argument is overwritten. Returns false when it is singular.
 */
export function solveComplex(
  size: number,
  real: Float64Array,
  imag: Float64Array,
  rhsReal: Float64Array,
  rhsImag: Float64Array,
) {
  // Reduce the matrix to upper triangular form, one pivot column at a time.
  for (let column = 0; column < size; column += 1) {
    let pivotRow = column;
    let largest = 0;

    for (let row = column; row < size; row += 1) {
      const index = row * size + column;
      const magnitude = Math.hypot(real[index] ?? 0, imag[index] ?? 0);

      if (magnitude > largest) {
        largest = magnitude;
        pivotRow = row;
      }
    }

    if (!(largest > SINGULAR_PIVOT)) {
      return false;
    }

    if (pivotRow !== column) {
      for (let index = 0; index < size; index += 1) {
        const a = column * size + index;
        const b = pivotRow * size + index;
        const swapReal = real[a] ?? 0;
        const swapImag = imag[a] ?? 0;

        real[a] = real[b] ?? 0;
        imag[a] = imag[b] ?? 0;
        real[b] = swapReal;
        imag[b] = swapImag;
      }

      const swapReal = rhsReal[column] ?? 0;
      const swapImag = rhsImag[column] ?? 0;

      rhsReal[column] = rhsReal[pivotRow] ?? 0;
      rhsImag[column] = rhsImag[pivotRow] ?? 0;
      rhsReal[pivotRow] = swapReal;
      rhsImag[pivotRow] = swapImag;
    }

    const pivotReal = real[column * size + column] ?? 0;
    const pivotImag = imag[column * size + column] ?? 0;
    const pivotNorm = pivotReal * pivotReal + pivotImag * pivotImag;

    for (let row = column + 1; row < size; row += 1) {
      const entryReal = real[row * size + column] ?? 0;
      const entryImag = imag[row * size + column] ?? 0;

      if (entryReal === 0 && entryImag === 0) {
        continue;
      }

      // factor = entry / pivot
      const factorReal =
        (entryReal * pivotReal + entryImag * pivotImag) / pivotNorm;

      const factorImag =
        (entryImag * pivotReal - entryReal * pivotImag) / pivotNorm;

      for (let index = column; index < size; index += 1) {
        const source = column * size + index;
        const target = row * size + index;
        const sourceReal = real[source] ?? 0;
        const sourceImag = imag[source] ?? 0;

        real[target] =
          (real[target] ?? 0) -
          (factorReal * sourceReal - factorImag * sourceImag);
        imag[target] =
          (imag[target] ?? 0) -
          (factorReal * sourceImag + factorImag * sourceReal);
      }

      const sourceReal = rhsReal[column] ?? 0;
      const sourceImag = rhsImag[column] ?? 0;

      rhsReal[row] =
        (rhsReal[row] ?? 0) -
        (factorReal * sourceReal - factorImag * sourceImag);
      rhsImag[row] =
        (rhsImag[row] ?? 0) -
        (factorReal * sourceImag + factorImag * sourceReal);
    }
  }

  // Substitute backward; the solution replaces the right-hand side.
  for (let row = size - 1; row >= 0; row -= 1) {
    let sumReal = rhsReal[row] ?? 0;
    let sumImag = rhsImag[row] ?? 0;

    for (let index = row + 1; index < size; index += 1) {
      const entryReal = real[row * size + index] ?? 0;
      const entryImag = imag[row * size + index] ?? 0;
      const valueReal = rhsReal[index] ?? 0;
      const valueImag = rhsImag[index] ?? 0;

      sumReal -= entryReal * valueReal - entryImag * valueImag;
      sumImag -= entryReal * valueImag + entryImag * valueReal;
    }

    const pivotReal = real[row * size + row] ?? 1;
    const pivotImag = imag[row * size + row] ?? 0;
    const pivotNorm = pivotReal * pivotReal + pivotImag * pivotImag;

    rhsReal[row] = (sumReal * pivotReal + sumImag * pivotImag) / pivotNorm;
    rhsImag[row] = (sumImag * pivotReal - sumReal * pivotImag) / pivotNorm;
  }

  return true;
}
