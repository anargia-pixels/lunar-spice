import {
  type EditField,
  escapeText,
  type TokenReader,
  unescapeText,
  type ValueRange,
} from "./element";
import type { SpiceModel } from "./spice-model";

/** One datasheet value of a device model, such as a diode's saturation current. */
export type ParamSpec = {
  key: string;
  label: string;
  unit: string;
  fallback: number;
  range: ValueRange;
  /** SPICE `.model` parameter names that set it, in lowercase. */
  spiceNames: readonly string[];
  hint?: string;
};

/** A real part and the model values that represent it. */
export type Preset = {
  name: string;
  values: Readonly<Record<string, number>>;
  /** For parts that come both ways: 1 for NPN, N-channel or positive, -1 for the rest. */
  polarity?: number;
  /** A stand-in rather than a real part, such as Generic NPN; labels show values instead. */
  isGeneric?: boolean;
};

/** The name a model shows once its values no longer match a preset. */
export const CUSTOM_MODEL = "Custom";

/**
 * A device's model values with the part name they came from. It reads and writes them in
 * spec order in circuit files and turns them into edit fields.
 */
export class ParamSet {
  readonly specs: readonly ParamSpec[];
  readonly presets: readonly Preset[];
  modelName: string;
  private readonly values = new Map<string, number>();

  constructor(specs: readonly ParamSpec[], presets: readonly Preset[]) {
    this.specs = specs;
    this.presets = presets;
    this.modelName = presets[0]?.name ?? CUSTOM_MODEL;

    for (const spec of specs) {
      this.values.set(spec.key, spec.fallback);
    }

    if (presets[0]) {
      this.applyValues(presets[0].values);
    }
  }

  get(key: string) {
    return this.values.get(key) ?? 0;
  }

  set(key: string, value: number) {
    this.values.set(key, value);
  }

  /** Sets every value from `values`; keys it leaves out go back to their defaults. */
  applyValues(values: Readonly<Record<string, number>>) {
    for (const spec of this.specs) {
      const value = values[spec.key];

      this.values.set(spec.key, value ?? spec.fallback);
    }
  }

  /** Applies the preset called `name`; returns it, or undefined when there is none. */
  applyPreset(name: string) {
    const preset = this.presets.find((candidate) => candidate.name === name);

    if (preset) {
      this.modelName = preset.name;
      this.applyValues(preset.values);
    }

    return preset;
  }

  /** Applies the generic preset of `polarity`, such as Generic PNP for -1. */
  applyGeneric(polarity = 1) {
    const preset = this.presets.find(
      (candidate) =>
        candidate.isGeneric && (candidate.polarity ?? 1) === polarity,
    );

    if (preset) {
      this.applyPreset(preset.name);
    }
  }

  /** True while the values are a generic preset's, not a real part's. */
  get isGeneric() {
    return (
      this.presets.find(({ name }) => name === this.modelName)?.isGeneric ??
      false
    );
  }

  /** Sets every value the card names; values it leaves out go back to their defaults. */
  applySpice(model: SpiceModel) {
    for (const spec of this.specs) {
      const name = spec.spiceNames.find((candidate) =>
        model.params.has(candidate),
      );

      this.values.set(
        spec.key,
        name === undefined ? spec.fallback : (model.params.get(name) ?? 0),
      );
    }

    this.modelName = model.name;
  }

  /** Reads the model name, then each value in spec order, from a circuit file line. */
  read(reader: TokenReader) {
    this.modelName = unescapeText(reader.string(this.modelName));

    for (const spec of this.specs) {
      this.values.set(spec.key, reader.number(spec.fallback));
    }
  }

  /** Returns the model name, then each value in spec order, for a circuit file line. */
  dump() {
    return [
      escapeText(this.modelName),
      ...this.specs.map((spec) => this.get(spec.key)),
    ];
  }

  /**
   * Builds the edit fields: the preset picker, a SPICE paste box when `applyModel` is
   * given, the model name, then each value. `applyPreset` replaces picking a preset, for
   * parts whose presets set more than values, such as a transistor's polarity.
   */
  fields(
    applyModel?: (text: string) => string | null,
    applyPreset: (name: string) => void = (name) => this.applyPreset(name),
  ): EditField[] {
    const fields: EditField[] = [];

    if (this.presets.length > 0) {
      fields.push({
        kind: "preset",
        key: "preset",
        label: "Part",
        value: this.modelName,
        options: this.presets.map(({ name }) => name),
        set: applyPreset,
      });
    }

    if (applyModel) {
      fields.push({
        kind: "spice",
        key: "spice",
        label: "SPICE model",
        hint: "Paste a .model card from a datasheet or vendor library.",
        set: applyModel,
      });
    }

    fields.push({
      kind: "text",
      key: "model-name",
      label: "Model name",
      value: this.modelName,
      set: (value) => {
        this.modelName = value.trim() || CUSTOM_MODEL;
      },
    });

    for (const spec of this.specs) {
      const field: EditField = {
        kind: "number",
        key: spec.key,
        label: spec.label,
        unit: spec.unit,
        value: this.get(spec.key),
        range: spec.range,
        set: (value) => this.set(spec.key, value),
      };

      if (spec.hint) {
        field.hint = spec.hint;
      }

      fields.push(field);
    }

    return fields;
  }
}
