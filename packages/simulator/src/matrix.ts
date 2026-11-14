/** Pivots smaller than this mean the circuit has no unique solution. */
const SINGULAR_PIVOT = 1e-20;

/**
 * A square real matrix factored in place into L and U with partial pivoting, so one
 * factorization solves many right-hand sides. Storage is row-major.
 */
export class LuMatrix {
  readonly size: number;
  readonly values: Float64Array;
  readonly pivots: Int32Array;
  /** The column whose pivot vanished in the last failed factorization; -1 after success. */
  singularColumn = -1;
  /** Scratch: the columns right of the pivot where the pivot row is nonzero. */
  private readonly pivotColumns: Int32Array;

  constructor(size: number) {
    this.size = size;
    this.values = new Float64Array(size * size);
    this.pivots = new Int32Array(size);
    this.pivotColumns = new Int32Array(size);
  }

  /**
   * Factors `source` (row-major, `size` squared); false when it is singular. MNA matrices
   * are mostly zeros, so each elimination touches only the pivot row's nonzero columns.
   */
  factor(source: Float64Array) {
    const { size, values, pivots, pivotColumns } = this;

    values.set(source);
    this.singularColumn = -1;

    for (let column = 0; column < size; column += 1) {
      // Pick the largest entry in the column as the pivot.
      let pivotRow = column;
      let largest = Math.abs(values[column * size + column] ?? 0);

      for (let row = column + 1; row < size; row += 1) {
        const magnitude = Math.abs(values[row * size + column] ?? 0);

        if (magnitude > largest) {
          largest = magnitude;
          pivotRow = row;
        }
      }

      if (!(largest > SINGULAR_PIVOT)) {
        this.singularColumn = column;

        return false;
      }

      // Swap the pivot row into place and record the swap for `solve`.
      pivots[column] = pivotRow;

      if (pivotRow !== column) {
        for (let index = 0; index < size; index += 1) {
          const a = column * size + index;
          const b = pivotRow * size + index;
          const swap = values[a] ?? 0;

          values[a] = values[b] ?? 0;
          values[b] = swap;
        }
      }

      // Eliminate below the pivot; each factor stays in the L slot it clears.
      const pivotStart = column * size;
      const pivot = values[pivotStart + column] ?? 1;
      let nonzeroCount = 0;

      for (let index = column + 1; index < size; index += 1) {
        if (values[pivotStart + index] !== 0) {
          pivotColumns[nonzeroCount] = index;
          nonzeroCount += 1;
        }
      }

      for (let row = column + 1; row < size; row += 1) {
        const rowStart = row * size;
        const factor = (values[rowStart + column] ?? 0) / pivot;

        values[rowStart + column] = factor;

        if (factor === 0) {
          continue;
        }

        for (let nonzero = 0; nonzero < nonzeroCount; nonzero += 1) {
          const index = pivotColumns[nonzero] ?? 0;

          values[rowStart + index] =
            (values[rowStart + index] ?? 0) -
            factor * (values[pivotStart + index] ?? 0);
        }
      }
    }

    return true;
  }

  /** Solves in place: `rhs` holds the right-hand side and receives the solution. */
  solve(rhs: Float64Array) {
    const { size, values, pivots } = this;

    // Apply the row swaps from `factor`, then substitute forward through L.
    for (let row = 0; row < size; row += 1) {
      const pivotRow = pivots[row] ?? row;

      if (pivotRow !== row) {
        const swap = rhs[row] ?? 0;

        rhs[row] = rhs[pivotRow] ?? 0;
        rhs[pivotRow] = swap;
      }
    }

    for (let row = 1; row < size; row += 1) {
      let sum = rhs[row] ?? 0;

      for (let index = 0; index < row; index += 1) {
        sum -= (values[row * size + index] ?? 0) * (rhs[index] ?? 0);
      }

      rhs[row] = sum;
    }

    // Substitute backward through U.
    for (let row = size - 1; row >= 0; row -= 1) {
      let sum = rhs[row] ?? 0;

      for (let index = row + 1; index < size; index += 1) {
        sum -= (values[row * size + index] ?? 0) * (rhs[index] ?? 0);
      }

      rhs[row] = sum / (values[row * size + row] ?? 1);
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
