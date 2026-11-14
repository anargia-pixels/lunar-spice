/** Pivots smaller than this mean the circuit has no unique solution. */
const SINGULAR_PIVOT = 1e-20;

/**
 * How small a pivot may be next to the largest entry below it in its column, as in SPICE's
 * sparse solver: smaller ones lose accuracy, so the pivots are chosen again.
 */
const PIVOT_THRESHOLD = 1e-3;

/**
 * The entries of a square matrix that have ever held a value, in the order they first
 * did. Indices are row-major. `version` changes whenever an entry is added, so a
 * factorization knows when its pivot order no longer covers the matrix.
 */
export class MatrixPattern {
  readonly mask: Uint8Array;
  readonly indices: number[] = [];
  version = 0;

  constructor(size: number) {
    this.mask = new Uint8Array(size * size);
  }

  /** Records that the entry at `index` holds a value. */
  add(index: number) {
    if (this.mask[index] === 0) {
      this.mask[index] = 1;
      this.indices.push(index);
      this.version += 1;
    }
  }
}

/**
 * A square real matrix factored into L and U, kept sparse. Circuit matrices are mostly
 * zeros, and their pattern stays the same from one Newton iteration to the next, so the
 * first factorization chooses pivots that keep it sparse (Markowitz's rule) and records
 * which entries each elimination touches. Later ones repeat only that arithmetic, and
 * choose pivots again only when the pattern grows or a pivot gets too small. Factors
 * stay at their entry's place in `values`, which is row-major.
 */
export class LuMatrix {
  readonly size: number;
  readonly values: Float64Array;
  /** The column whose pivot vanished in the last failed factorization; -1 after success. */
  singularColumn = -1;
  /** Row and column of each pivot, in elimination order. */
  private readonly pivotRows: Int32Array;
  private readonly pivotColumns: Int32Array;
  /**
   * For pivot `k`, entries `lowerStart[k]` to `lowerStart[k + 1]` of `lowerRows` are the
   * rows it eliminates, and `lowerIndices` their entries in its column.
   */
  private readonly lowerStart: Int32Array;
  private lowerRows = new Int32Array(0);
  private lowerIndices = new Int32Array(0);
  /** Likewise the columns right of pivot `k` in its row, and their entries there. */
  private readonly upperStart: Int32Array;
  private upperColumns = new Int32Array(0);
  private upperIndices = new Int32Array(0);
  /** Every entry the factors fill, which a refactorization loads from the matrix. */
  private filled = new Int32Array(0);
  /** The pattern version the pivots were chosen for; -1 before the first. */
  private analyzedVersion = -1;
  /** The matrix entries at the last factorization, in `filled` order, to skip repeats. */
  private factored = new Float64Array(0);

  constructor(size: number) {
    this.size = size;
    this.values = new Float64Array(size * size);
    this.pivotRows = new Int32Array(size);
    this.pivotColumns = new Int32Array(size);
    this.lowerStart = new Int32Array(size + 1);
    this.upperStart = new Int32Array(size + 1);
  }

  /**
   * Factors `source` (row-major, `size` squared), whose nonzero entries all lie in
   * `pattern`; false when it is singular. A matrix equal to the last one is not factored
   * again.
   */
  factor(source: Float64Array, pattern: MatrixPattern) {
    this.singularColumn = -1;

    if (pattern.version !== this.analyzedVersion) {
      return this.analyze(source, pattern);
    }

    if (!this.load(source)) {
      return true;
    }

    return this.refactor() || this.analyze(source, pattern);
  }

  /**
   * Copies the filled entries of `source` into `values`; false when they equal those of
   * the last factorization, which `values` still holds factored.
   */
  private load(source: Float64Array) {
    const { filled, factored, values } = this;
    let isChanged = false;

    for (let entry = 0; entry < filled.length; entry += 1) {
      const value = source[filled[entry] ?? 0] ?? 0;

      if (value !== factored[entry]) {
        factored[entry] = value;
        isChanged = true;
      }
    }

    if (isChanged) {
      for (let entry = 0; entry < filled.length; entry += 1) {
        values[filled[entry] ?? 0] = factored[entry] ?? 0;
      }
    }

    return isChanged;
  }

  /**
   * Repeats the recorded eliminations on the loaded `values`; false when a pivot is too
   * small, so the pivots must be chosen again.
   */
  private refactor() {
    const { size, values, pivotRows, pivotColumns } = this;
    const { lowerStart, lowerRows, lowerIndices } = this;
    const { upperStart, upperColumns, upperIndices } = this;

    for (let pivot = 0; pivot < size; pivot += 1) {
      const pivotValue =
        values[(pivotRows[pivot] ?? 0) * size + (pivotColumns[pivot] ?? 0)] ??
        0;

      const lowerEnd = lowerStart[pivot + 1] ?? 0;
      const upperFirst = upperStart[pivot] ?? 0;
      const upperEnd = upperStart[pivot + 1] ?? 0;
      let largest = 0;

      for (let entry = lowerStart[pivot] ?? 0; entry < lowerEnd; entry += 1) {
        largest = Math.max(
          largest,
          Math.abs(values[lowerIndices[entry] ?? 0] ?? 0),
        );
      }

      const magnitude = Math.abs(pivotValue);

      if (
        !(magnitude > SINGULAR_PIVOT) ||
        magnitude < PIVOT_THRESHOLD * largest
      ) {
        return false;
      }

      for (let entry = lowerStart[pivot] ?? 0; entry < lowerEnd; entry += 1) {
        const index = lowerIndices[entry] ?? 0;
        const factor = (values[index] ?? 0) / pivotValue;

        values[index] = factor;

        if (factor === 0) {
          continue;
        }

        const rowStart = (lowerRows[entry] ?? 0) * size;

        for (let upper = upperFirst; upper < upperEnd; upper += 1) {
          const target = rowStart + (upperColumns[upper] ?? 0);

          values[target] =
            (values[target] ?? 0) -
            factor * (values[upperIndices[upper] ?? 0] ?? 0);
        }
      }
    }

    return true;
  }

  /**
   * Factors `source` choosing each pivot by Markowitz's rule: of the entries no smaller
   * than `PIVOT_THRESHOLD` of their column's largest, the one whose row and column hold
   * the fewest others, so the factors fill in the fewest zeros. Records the eliminations
   * for `refactor`.
   */
  private analyze(source: Float64Array, pattern: MatrixPattern) {
    const { size, values, pivotRows, pivotColumns } = this;
    const isNonzero = new Uint8Array(pattern.mask);
    const rowCounts = new Int32Array(size);
    const columnCounts = new Int32Array(size);
    const columnLargest = new Float64Array(size);
    const rows = Int32Array.from({ length: size }, (_, index) => index);
    const columns = Int32Array.from(rows);
    const lower: number[] = [];
    const upper: number[] = [];

    values.set(source);
    this.analyzedVersion = -1;

    for (const index of pattern.indices) {
      const row = Math.floor(index / size);
      const column = index % size;

      rowCounts[row] = (rowCounts[row] ?? 0) + 1;
      columnCounts[column] = (columnCounts[column] ?? 0) + 1;
    }

    for (let pivot = 0; pivot < size; pivot += 1) {
      // Rows and columns from `pivot` on are not yet eliminated.
      const [pivotRowAt, pivotColumnAt] = this.choosePivot(
        pivot,
        rows,
        columns,
        isNonzero,
        rowCounts,
        columnCounts,
        columnLargest,
      );

      if (pivotRowAt < 0) {
        this.singularColumn = columns[pivotColumnAt] ?? 0;

        return false;
      }

      const pivotRow = rows[pivotRowAt] ?? 0;
      const pivotColumn = columns[pivotColumnAt] ?? 0;

      rows[pivotRowAt] = rows[pivot] ?? 0;
      rows[pivot] = pivotRow;
      columns[pivotColumnAt] = columns[pivot] ?? 0;
      columns[pivot] = pivotColumn;
      pivotRows[pivot] = pivotRow;
      pivotColumns[pivot] = pivotColumn;
      this.lowerStart[pivot] = lower.length;
      this.upperStart[pivot] = upper.length;

      const pivotStart = pivotRow * size;
      const pivotValue = values[pivotStart + pivotColumn] ?? 1;

      for (let at = pivot + 1; at < size; at += 1) {
        const column = columns[at] ?? 0;

        if (isNonzero[pivotStart + column]) {
          upper.push(column);
          columnCounts[column] = (columnCounts[column] ?? 0) - 1;
        }
      }

      const upperFirst = this.upperStart[pivot] ?? 0;

      for (let at = pivot + 1; at < size; at += 1) {
        const row = rows[at] ?? 0;
        const rowStart = row * size;

        if (!isNonzero[rowStart + pivotColumn]) {
          continue;
        }

        lower.push(row);
        rowCounts[row] = (rowCounts[row] ?? 0) - 1;

        const factor = (values[rowStart + pivotColumn] ?? 0) / pivotValue;

        values[rowStart + pivotColumn] = factor;

        for (let entry = upperFirst; entry < upper.length; entry += 1) {
          const column = upper[entry] ?? 0;
          const target = rowStart + column;

          if (!isNonzero[target]) {
            isNonzero[target] = 1;
            rowCounts[row] = (rowCounts[row] ?? 0) + 1;
            columnCounts[column] = (columnCounts[column] ?? 0) + 1;
          }

          values[target] =
            (values[target] ?? 0) - factor * (values[pivotStart + column] ?? 0);
        }
      }
    }

    this.lowerStart[size] = lower.length;
    this.upperStart[size] = upper.length;
    this.record(lower, upper, isNonzero, source);
    this.analyzedVersion = pattern.version;

    return true;
  }

  /**
   * Returns the positions in `rows` and `columns` of the next pivot, from `pivot` on. When
   * no entry is large enough the row is -1 and the column is the one that has none.
   */
  private choosePivot(
    pivot: number,
    rows: Int32Array,
    columns: Int32Array,
    isNonzero: Uint8Array,
    rowCounts: Int32Array,
    columnCounts: Int32Array,
    columnLargest: Float64Array,
  ) {
    const { size, values } = this;

    for (let at = pivot; at < size; at += 1) {
      columnLargest[at] = 0;
    }

    for (let rowAt = pivot; rowAt < size; rowAt += 1) {
      const rowStart = (rows[rowAt] ?? 0) * size;

      for (let columnAt = pivot; columnAt < size; columnAt += 1) {
        columnLargest[columnAt] = Math.max(
          columnLargest[columnAt] ?? 0,
          Math.abs(values[rowStart + (columns[columnAt] ?? 0)] ?? 0),
        );
      }
    }

    let best: [number, number] = [-1, pivot];
    let bestCost = Number.POSITIVE_INFINITY;
    let bestRatio = 0;

    for (let rowAt = pivot; rowAt < size; rowAt += 1) {
      const row = rows[rowAt] ?? 0;
      const rowStart = row * size;

      for (let columnAt = pivot; columnAt < size; columnAt += 1) {
        const column = columns[columnAt] ?? 0;

        if (!isNonzero[rowStart + column]) {
          continue;
        }

        const magnitude = Math.abs(values[rowStart + column] ?? 0);
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

    if (best[0] < 0) {
      // Name the column with the smallest entries as the one without a pivot.
      for (let columnAt = pivot; columnAt < size; columnAt += 1) {
        if ((columnLargest[columnAt] ?? 0) < (columnLargest[best[1]] ?? 0)) {
          best = [-1, columnAt];
        }
      }
    }

    return best;
  }

  /** Stores the eliminations `analyze` made, as flat lists for `refactor` and `solve`. */
  private record(
    lower: readonly number[],
    upper: readonly number[],
    isNonzero: Uint8Array,
    source: Float64Array,
  ) {
    const { size, pivotRows, pivotColumns, lowerStart, upperStart } = this;

    this.lowerRows = Int32Array.from(lower);
    this.upperColumns = Int32Array.from(upper);
    this.lowerIndices = new Int32Array(lower.length);
    this.upperIndices = new Int32Array(upper.length);

    for (let pivot = 0; pivot < size; pivot += 1) {
      const pivotRow = pivotRows[pivot] ?? 0;
      const pivotColumn = pivotColumns[pivot] ?? 0;

      for (
        let entry = lowerStart[pivot] ?? 0;
        entry < (lowerStart[pivot + 1] ?? 0);
        entry += 1
      ) {
        this.lowerIndices[entry] = (lower[entry] ?? 0) * size + pivotColumn;
      }

      for (
        let entry = upperStart[pivot] ?? 0;
        entry < (upperStart[pivot + 1] ?? 0);
        entry += 1
      ) {
        this.upperIndices[entry] = pivotRow * size + (upper[entry] ?? 0);
      }
    }

    const filled: number[] = [];

    isNonzero.forEach((flag, index) => {
      if (flag) {
        filled.push(index);
      }
    });

    this.filled = Int32Array.from(filled);
    this.factored = Float64Array.from(filled, (index) => source[index] ?? 0);
  }

  /**
   * Solves for the right-hand side `rhs`, indexed by row, into `result`, indexed by
   * column. `rhs` is overwritten.
   */
  solve(rhs: Float64Array, result: Float64Array) {
    const { size, values, pivotRows, pivotColumns } = this;
    const { lowerStart, lowerRows, lowerIndices } = this;
    const { upperStart, upperColumns, upperIndices } = this;

    // Substitute forward through L, one pivot's eliminations at a time.
    for (let pivot = 0; pivot < size; pivot += 1) {
      const value = rhs[pivotRows[pivot] ?? 0] ?? 0;

      if (value === 0) {
        continue;
      }

      const lowerEnd = lowerStart[pivot + 1] ?? 0;

      for (let entry = lowerStart[pivot] ?? 0; entry < lowerEnd; entry += 1) {
        const row = lowerRows[entry] ?? 0;

        rhs[row] =
          (rhs[row] ?? 0) - (values[lowerIndices[entry] ?? 0] ?? 0) * value;
      }
    }

    // Substitute backward through U.
    for (let pivot = size - 1; pivot >= 0; pivot -= 1) {
      const pivotRow = pivotRows[pivot] ?? 0;
      const pivotColumn = pivotColumns[pivot] ?? 0;
      const upperEnd = upperStart[pivot + 1] ?? 0;
      let sum = rhs[pivotRow] ?? 0;

      for (let entry = upperStart[pivot] ?? 0; entry < upperEnd; entry += 1) {
        sum -=
          (values[upperIndices[entry] ?? 0] ?? 0) *
          (result[upperColumns[entry] ?? 0] ?? 0);
      }

      result[pivotColumn] = sum / (values[pivotRow * size + pivotColumn] ?? 1);
    }
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
