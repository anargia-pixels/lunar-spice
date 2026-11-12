/** A parsed SPICE `.model` card, such as a manufacturer's model from a datasheet. */
export type SpiceModel = {
  name: string;
  /** The device type in lowercase: `d`, `npn`, `pnp`, `nmos`, `pmos`, `vdmos`, `njf` or `pjf`. */
  type: string;
  /** Parameters by lowercase name, values in base units. */
  params: Map<string, number>;
  /** Parameters written without a value, such as VDMOS's `pchan`. */
  switches: Set<string>;
};

/** SPICE scale suffixes. SPICE ignores case, so `m` is milli and `meg` is mega. */
const SPICE_SCALES = new Map<string, number>([
  ["t", 1e12],
  ["g", 1e9],
  ["meg", 1e6],
  ["k", 1e3],
  ["mil", 25.4e-6],
  ["m", 1e-3],
  ["u", 1e-6],
  ["µ", 1e-6],
  ["n", 1e-9],
  ["p", 1e-12],
  ["f", 1e-15],
]);

/** A SPICE number: a mantissa, an optional scale suffix, then any unit letters. */
const SPICE_NUMBER =
  /^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)(meg|mil|[tgkmuµnpf])?[a-z]*$/iu;

/** Reads a SPICE number such as `2.52n`, `1meg` or `4pF`; null when it is not one. */
function parseSpiceNumber(text: string) {
  const match = SPICE_NUMBER.exec(text.trim());

  if (!match?.[1]) {
    return null;
  }

  const scale = match[2] ? (SPICE_SCALES.get(match[2].toLowerCase()) ?? 1) : 1;
  const value = Number(match[1]) * scale;

  return Number.isFinite(value) ? value : null;
}

/**
 * Reads the first `.model` card in `text`. Continuation lines (`+`), comments (`*` lines
 * and `;` tails) and parentheses are allowed. Returns null when there is no card.
 */
export function parseSpiceModel(text: string): SpiceModel | null {
  // Drop comments and join continuation lines into one line.
  const joined = text
    .split(/\r?\n/u)
    .filter((line) => !line.trim().startsWith("*"))
    .map((line) => line.replace(/;.*$/u, ""))
    .join("\n")
    .replace(/\n\s*\+/gu, " ");

  const match = /\.model\s+(\S+)\s+([a-z]+)\s*(.*)$/imsu.exec(joined);

  if (!match?.[1] || !match[2]) {
    return null;
  }

  // Split the body into `name=value` parameters and bare switches.
  const body = (match[3] ?? "")
    .replace(/[()]/gu, " ")
    .replace(/\s*=\s*/gu, "=");

  const params = new Map<string, number>();
  const switches = new Set<string>();

  for (const token of body.split(/\s+/u)) {
    if (!token) {
      continue;
    }

    const [name, value] = token.split("=");

    if (!name) {
      continue;
    }

    if (value === undefined) {
      switches.add(name.toLowerCase());
      continue;
    }

    const number = parseSpiceNumber(value);

    if (number !== null) {
      params.set(name.toLowerCase(), number);
    }
  }

  return { name: match[1], type: match[2].toLowerCase(), params, switches };
}
