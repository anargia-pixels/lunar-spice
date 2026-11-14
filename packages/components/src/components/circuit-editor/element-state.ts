import type { CircuitElement } from "@lunar-spice/simulator/element";
import type { SignalMeter } from "@lunar-spice/simulator/signal-meter";

/**
 * What the simulation changed on an element, carried between two copies of it: the
 * worker's, which steps, and the editor's, which is drawn. An element's file line holds
 * all it was set up with, so a copy read fresh from that line (its pristine copy) differs
 * from a stepped one only in simulation state: voltages, currents, a capacitor's charge, a
 * Schmitt trigger's side, a meter's readings. Comparing the two finds that state for any
 * element without each class listing it.
 */

/** A method an object holds; patches leave them out. */
type Method = (...args: never[]) => void;

/** What a field of an element, or of an object inside one, holds. */
export type StateValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly StateValue[]
  | ReadonlyMap<string | number, StateValue>
  | StateFields
  | Method;

/** An object's fields by name. */
export type StateFields = { [key: string]: StateValue };

/** What carries simulation state between threads: an element, or a scope's meter. */
export type StateOwner = CircuitElement | SignalMeter;

/**
 * The fields of an element or a meter, by name: a new object, but nested objects are the
 * owner's own, so filling them in fills the owner's.
 */
export function fieldsOf(owner: StateOwner): StateFields {
  return Object.fromEntries(Object.entries(owner));
}

function isMethod(value: StateValue): value is Method {
  return value instanceof Function;
}

function isFields(value: StateValue): value is StateFields {
  return (
    value instanceof Object &&
    !Array.isArray(value) &&
    !(value instanceof Map) &&
    !isMethod(value)
  );
}

/** True when `a` and `b` hold the same data; methods count as equal. */
function isSame(a: StateValue, b: StateValue): boolean {
  if (Object.is(a, b)) {
    return true;
  }

  if (isMethod(a) && isMethod(b)) {
    return true;
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    return (
      a.length === b.length &&
      a.every((item: StateValue, index) => isSame(item, b[index]))
    );
  }

  if (a instanceof Map && b instanceof Map) {
    return (
      a.size === b.size &&
      [...a].every(([key, value]) => b.has(key) && isSame(value, b.get(key)))
    );
  }

  if (!isFields(a) || !isFields(b) || a.constructor !== b.constructor) {
    return false;
  }

  const keys = Object.keys(a);

  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => isSame(a[key], b[key]))
  );
}

/**
 * A copy of `value` that can be posted to another thread: methods are dropped and class
 * instances become plain objects, which `mergeState` folds back into the live ones.
 */
function postable(value: StateValue): StateValue {
  if (isMethod(value)) {
    return undefined;
  }

  if (Array.isArray(value)) {
    return value.map(postable);
  }

  if (value instanceof Map) {
    return new Map([...value].map(([key, item]) => [key, postable(item)]));
  }

  if (!isFields(value)) {
    return value;
  }

  const copy: StateFields = {};

  for (const [key, item] of Object.entries(value)) {
    if (!isMethod(item)) {
      copy[key] = postable(item);
    }
  }

  return copy;
}

/** The fields of `owner` by name, in order: cheaper than `fieldsOf` when only read. */
function entriesOf(owner: StateOwner): [string, StateValue][] {
  return Object.entries(owner);
}

/**
 * The fields where `live` differs from `pristine`, the fields of a copy of it read fresh
 * from its file line: its simulation state. Values are the live ones, not copies.
 */
export function changedFields(live: StateOwner, pristine: StateFields) {
  const changed: StateFields = {};

  for (const [key, value] of entriesOf(live)) {
    if (!isMethod(value) && !isSame(value, pristine[key])) {
      changed[key] = value;
    }
  }

  return changed;
}

/**
 * The simulation state of `live` as a postable patch for `mergeState`; `pristine` holds
 * the fields of a copy read fresh from its file line.
 */
export function statePatch(live: StateOwner, pristine: StateFields) {
  const patch = changedFields(live, pristine);

  for (const [key, value] of Object.entries(patch)) {
    patch[key] = postable(value);
  }

  return patch;
}

/**
 * Writes a patch from `statePatch` into `target`. Nested objects are filled in place, so
 * class instances such as a meter keep their methods; arrays are filled item by item.
 */
export function mergeState(target: StateOwner, patch: StateFields) {
  const fields = fieldsOf(target);

  mergeFields(fields, patch);
  Object.assign(target, fields);
}

/** Writes `patch` into `fields`, filling nested objects in place. */
function mergeFields(fields: StateFields, patch: StateFields) {
  for (const [key, value] of Object.entries(patch)) {
    const current = fields[key];

    if (Array.isArray(value) && Array.isArray(current)) {
      fields[key] = mergeArray(current, value);
    } else if (isFields(value) && current !== undefined && isFields(current)) {
      mergeFields(current, value);
    } else {
      fields[key] = value;
    }
  }
}

/** Returns `target` with the items of `source`, filling nested objects in place. */
function mergeArray(
  target: readonly StateValue[],
  source: readonly StateValue[],
) {
  return source.map((item, index) => {
    const current = target[index];

    if (isFields(item) && current !== undefined && isFields(current)) {
      mergeFields(current, item);

      return current;
    }

    return item;
  });
}
