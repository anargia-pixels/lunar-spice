import {
  CircuitElement,
  type EditField,
  escapeText,
  type TokenReader,
  unescapeText,
} from "../element";
import { interpolatePair, type Point, roundPoint } from "../geometry";
import type { MnaSystem } from "../mna-system";
import { SignalMeter } from "../signal-meter";
import { formatSi } from "../units";

/** A wire joins its posts into one node; its current comes from the currents around it. */
export class Wire extends CircuitElement {
  readonly kind = "wire";
  readonly dumpType = "w";

  name() {
    return "Wire";
  }

  override isConductor() {
    return true;
  }

  override isNetElement() {
    return true;
  }

  override isStretchable() {
    return true;
  }

  override info() {
    return [
      this.name(),
      `I = ${formatSi(this.current, "A")}`,
      `V = ${formatSi(this.volts[0] ?? 0, "V")}`,
    ];
  }
}

/** Ties its post to the 0 V reference node. The second point only places the symbol. */
export class Ground extends CircuitElement {
  readonly kind = "ground";
  readonly dumpType = "g";

  name() {
    return "Ground";
  }

  override isGround() {
    return true;
  }

  override posts(): Point[] {
    return [this.start];
  }

  override info() {
    return [this.name(), `I = ${formatSi(this.current, "A")}`];
  }

  override dumpValues() {
    return [0];
  }
}

/**
 * A single-throw switch. A closed switch joins its posts like a wire. A push switch
 * (`isMomentary`) sits in its rest position and changes only while it is held down:
 * normally open closes, normally closed opens.
 */
export class Switch extends CircuitElement {
  readonly kind = "switch";
  readonly dumpType = "s";
  override readonly designatorPrefix = "S";
  isClosed = true;
  isMomentary = false;
  /** A push switch's rest position: closed until pressed. */
  isNormallyClosed = false;

  static override read(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    flags: number,
    reader: TokenReader,
  ) {
    const element = new Switch(x1, y1, x2, y2, flags);

    // Falstad stores the position: 0 is closed, 1 is open. A push switch stores its rest
    // position, so 0 makes it normally closed.
    element.isClosed = reader.number(0) === 0;
    element.isMomentary = reader.number(0) !== 0;
    element.isNormallyClosed = element.isMomentary && element.isClosed;

    return element;
  }

  name() {
    if (!this.isMomentary) {
      return "Switch";
    }

    return this.isNormallyClosed
      ? "Push switch (normally closed)"
      : "Push switch";
  }

  override isToggle() {
    return !this.isMomentary;
  }

  override toggle() {
    if (!this.isMomentary) {
      this.isClosed = !this.isClosed;
    }
  }

  override isPushButton() {
    return this.isMomentary;
  }

  /** Holds a push switch down, or lets it spring back to rest. */
  override press(isDown: boolean) {
    this.isClosed = isDown !== this.isNormallyClosed;
  }

  override valueLabel() {
    return this.isClosed ? "closed" : "open";
  }

  override isConductor() {
    return this.isClosed;
  }

  /** Sets an open switch's current to 0; the simulation finds a closed one's current. */
  override finishStep() {
    if (!this.isClosed) {
      this.current = 0;
    }
  }

  override info() {
    return [
      this.title(),
      this.isClosed ? "Closed" : "Open",
      `I = ${formatSi(this.current, "A")}`,
      `Vd = ${formatSi(this.voltageDifference(), "V")}`,
    ];
  }

  override editFields(): EditField[] {
    const fields: EditField[] = [
      {
        kind: "boolean",
        key: "momentary",
        label: "Push switch (changes only while held)",
        value: this.isMomentary,
        set: (value) => {
          this.isMomentary = value;
          this.isNormallyClosed = false;
          this.press(false);
        },
      },
    ];

    if (this.isMomentary) {
      fields.push({
        kind: "boolean",
        key: "normally-closed",
        label: "Normally closed (opens while held)",
        value: this.isNormallyClosed,
        set: (value) => {
          this.isNormallyClosed = value;
          this.press(false);
        },
      });
    }

    return fields;
  }

  override dumpValues() {
    const isClosed = this.isMomentary ? this.isNormallyClosed : this.isClosed;

    return [isClosed ? 0 : 1, this.isMomentary ? "true" : "false"];
  }
}

/** How far either throw of a changeover switch sits from the line through it. */
export const THROW_OFFSET = 16;

/**
 * A single-pole double-throw (changeover) switch, Falstad's `S`. The common post at the
 * start always joins one of the two throws at the end; a click flips which.
 */
export class SpdtSwitch extends CircuitElement {
  readonly kind = "spdt-switch";
  readonly dumpType = "S";
  override readonly designatorPrefix = "S";
  /** The throw the common post joins: 0 for the first, 1 for the second. */
  position = 0;

  static override read(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    flags: number,
    reader: TokenReader,
  ) {
    const element = new SpdtSwitch(x1, y1, x2, y2, flags);

    element.position = reader.number(0) === 1 ? 1 : 0;

    return element;
  }

  name() {
    return "Changeover switch";
  }

  /** Returns the common post, then the two throws each side of the end, as Falstad places them. */
  override posts(): Point[] {
    const [first, second] = interpolatePair(
      this.start,
      this.end,
      1,
      THROW_OFFSET,
    );

    return [this.start, roundPoint(first), roundPoint(second)];
  }

  override isToggle() {
    return true;
  }

  override toggle() {
    this.position = 1 - this.position;
  }

  /** Returns one path: from the common post to the throw it joins. */
  override currentPaths() {
    return [this.current];
  }

  override valueLabel() {
    return this.position === 0 ? "throw 1" : "throw 2";
  }

  override isConductor() {
    return true;
  }

  override conductorPosts() {
    return [0, 1 + this.position] as const;
  }

  override currentIntoPost(post: number) {
    if (post === 0) {
      return this.current;
    }

    return post === 1 + this.position ? -this.current : 0;
  }

  override info() {
    return [
      this.title(),
      `Common joins throw ${this.position + 1}`,
      `I = ${formatSi(this.current, "A")}`,
    ];
  }

  override dumpValues() {
    // Falstad's fields: position, momentary flag, then link group (0 for none).
    return [this.position, "false", 0];
  }
}

/**
 * A net label. Every label with the same text joins one node, and that node takes the
 * label's text as its name in analysis results. The second point places the text.
 */
export class NetLabel extends CircuitElement {
  readonly kind = "label";
  readonly dumpType = "207";
  text = "out";

  static override read(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    flags: number,
    reader: TokenReader,
  ) {
    const label = new NetLabel(x1, y1, x2, y2, flags);

    label.text = unescapeText(reader.string("out"));

    return label;
  }

  name() {
    return "Net label";
  }

  override isNetElement() {
    return true;
  }

  override netName() {
    return this.text;
  }

  override valueLabel() {
    return this.text;
  }

  override posts(): Point[] {
    return [this.start];
  }

  override info() {
    return [
      `${this.name()} ${this.text}`,
      `V = ${formatSi(this.volts[0] ?? 0, "V")}`,
    ];
  }

  override editFields(): EditField[] {
    return [
      {
        kind: "text",
        key: "text",
        label: "Net name",
        value: this.text,
        set: (value) => {
          this.text = value.trim() || this.text;
        },
      },
    ];
  }

  override dumpValues() {
    return [escapeText(this.text)];
  }
}

/** A voltmeter between its posts: first post minus second. It draws no current. */
export class Voltmeter extends CircuitElement {
  readonly kind = "voltmeter";
  readonly dumpType = "p";
  override readonly designatorPrefix = "VM";

  name() {
    return "Voltmeter";
  }

  override isMeter() {
    return true;
  }

  override valueLabel() {
    return formatSi(this.voltageDifference(), "V");
  }

  override info() {
    return [this.title(), `V = ${formatSi(this.voltageDifference(), "V")}`];
  }

  override dumpValues() {
    return [0];
  }
}

/** Formats a reading with four significant digits, or a dash while there is none. */
function formatReading(value: number | null | undefined, unit: string) {
  return value === null || value === undefined ? "–" : formatSi(value, unit, 4);
}

/**
 * A voltage probe, as in Multisim: its tip reads the net beneath it against ground.
 * The tip is no post, so placing or moving the probe never changes the wiring; it reads
 * whichever wire or post it rests on. Beside the voltage it reads the signal's
 * peak-to-peak, RMS, DC and frequency during the interactive simulation. It is
 * Falstad's output element, so Falstad opens it too. It draws no current.
 */
export class VoltageProbe extends CircuitElement {
  readonly kind = "voltage-probe";
  readonly dumpType = "O";
  override readonly designatorPrefix = "PR";
  /** Falstad's display scale for the reading, kept so its files save unchanged. */
  scale = 0;
  readonly meter = new SignalMeter();

  static override read(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    flags: number,
    reader: TokenReader,
  ) {
    const probe = new VoltageProbe(x1, y1, x2, y2, flags);

    probe.scale = reader.number(0);

    return probe;
  }

  name() {
    return "Voltage probe";
  }

  override posts(): Point[] {
    return [];
  }

  override probePoint() {
    return this.start;
  }

  override isMeter() {
    return true;
  }

  /** True while its tip rests on a net, so it has a node to read. */
  get isConnected() {
    return this.nodes.length > 0;
  }

  /** Its tip's voltage to ground. */
  get voltage() {
    return this.volts[0] ?? 0;
  }

  /** The readout lines, Multisim's: V, V(p-p), V(rms), V(dc) and frequency. */
  readings() {
    const reading = this.meter.reading;

    return [
      `V: ${formatReading(this.isConnected ? this.voltage : null, "V")}`,
      `V(p-p): ${formatReading(reading?.peakToPeak, "V")}`,
      `V(rms): ${formatReading(reading?.rms, "V")}`,
      `V(dc): ${formatReading(reading?.dc, "V")}`,
      `Freq: ${formatReading(reading?.frequency, "Hz")}`,
    ];
  }

  override valueLabel() {
    return formatSi(this.voltage, "V");
  }

  override info() {
    return [this.title(), ...this.readings()];
  }

  override finishStep(system: MnaSystem) {
    if (system.mode === "transient" && this.isConnected) {
      this.meter.add(this.voltage, system.timeStep);
    }
  }

  override reset() {
    super.reset();
    this.meter.reset();
  }

  /** A moved probe reads another place, so its measurements start over. */
  override translate(dx: number, dy: number) {
    super.translate(dx, dy);
    this.meter.reset();
  }

  override transform(map: (point: Point) => Point) {
    super.transform(map);
    this.meter.reset();
  }

  override dumpValues() {
    return [this.scale];
  }
}
