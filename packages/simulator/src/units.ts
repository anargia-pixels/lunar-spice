/** SI prefixes from femto to tera, largest first, used to format readings. */
const PREFIXES = [
  { exponent: 12, symbol: "T" },
  { exponent: 9, symbol: "G" },
  { exponent: 6, symbol: "M" },
  { exponent: 3, symbol: "k" },
  { exponent: 0, symbol: "" },
  { exponent: -3, symbol: "m" },
  { exponent: -6, symbol: "µ" },
  { exponent: -9, symbol: "n" },
  { exponent: -12, symbol: "p" },
  { exponent: -15, symbol: "f" },
] as const;

const SMALLEST_PREFIX = PREFIXES[PREFIXES.length - 1] ?? PREFIXES[0];

/** Multipliers for the prefixes a typed value may end with, plus SPICE-style spellings. */
const PREFIX_MULTIPLIERS = new Map<string, number>([
  ...PREFIXES.flatMap(({ symbol, exponent }): [string, number][] =>
    symbol ? [[symbol, 10 ** exponent]] : [],
  ),
  ["meg", 1e6],
  ["K", 1e3],
  ["u", 1e-6],
]);

/** A number, an optional SI prefix, then an optional unit word such as `F` or `Ω`. */
const VALUE_PATTERN =
  /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*(meg|[TGMkKmuµnpf])?\s*[a-zA-ZΩ°]*\s*$/u;

/** Drops trailing zeros from a fixed-precision number, so 4.700 reads 4.7. */
function trimNumber(text: string) {
  return text.includes(".") ? text.replace(/\.?0+$/u, "") : text;
}

/**
 * Formats a reading such as `4.7 kΩ` or `-12 mA`, with `digits` significant digits.
 * Values below 1 f read 0, and values above the tera range use exponent notation.
 */
export function formatSi(value: number, unit: string, digits = 3) {
  if (!Number.isFinite(value)) {
    return `${value} ${unit}`.trim();
  }

  const magnitude = Math.abs(value);

  if (magnitude < 1e-15) {
    return `0 ${unit}`.trim();
  }

  const prefix =
    PREFIXES.find(({ exponent }) => magnitude >= 10 ** exponent * 0.9995) ??
    SMALLEST_PREFIX;

  const scaled = value / 10 ** prefix.exponent;

  return `${trimNumber(scaled.toPrecision(digits))} ${prefix.symbol}${unit}`.trim();
}

/** Formats a value the way a user types it into edit fields, such as `4.7k` for 4700. */
export function formatEditValue(value: number) {
  if (value === 0) {
    return "0";
  }

  const magnitude = Math.abs(value);

  const prefix = PREFIXES.find(
    ({ exponent }) => magnitude >= 10 ** exponent * 0.9999999,
  );

  if (!prefix || prefix.exponent === 0) {
    return trimNumber(value.toPrecision(6));
  }

  const symbol = prefix.symbol === "µ" ? "u" : prefix.symbol;

  return `${trimNumber((value / 10 ** prefix.exponent).toPrecision(6))}${symbol}`;
}

/**
 * Reads a typed value with an optional SI prefix and unit: `4.7k`, `10uF`, `1meg`, `5 V`.
 * `m` is milli and `M` is mega. Returns null when the text is not a number.
 */
export function parseSi(text: string) {
  const match = VALUE_PATTERN.exec(text);

  if (!match?.[1]) {
    return null;
  }

  const base = Number(match[1]);
  const multiplier = match[2] ? (PREFIX_MULTIPLIERS.get(match[2]) ?? 1) : 1;
  const value = base * multiplier;

  return Number.isFinite(value) ? value : null;
}
