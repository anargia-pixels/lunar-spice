/** True on macOS and iOS, where shortcuts use Command and Option. */
const isMac = /Mac|iPhone|iPad/u.test(globalThis.navigator?.userAgent ?? "");

/** How hints name the primary modifier: ⌘ on a Mac, Ctrl elsewhere. */
const modKeyLabel = isMac ? "⌘" : "Ctrl";

/**
 * One way to trigger a shortcut. `key` is a `KeyboardEvent.key`, matched without regard
 * to case; `mod` is Ctrl, or Command on a Mac. `shift` left out accepts either, for keys
 * such as `+` and `?` that need Shift on some layouts. Gestures such as `Wheel` or
 * `Drag` are listed for the shortcuts dialog and never match a key press.
 */
export type KeyCombo = {
  key: string;
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
};

/** A named action with its keys, as the shortcuts dialog lists it. */
export type ShortcutInfo = {
  label: string;
  keys: readonly KeyCombo[];
};

/** A section of the shortcuts dialog. */
export type ShortcutSection = {
  title: string;
  items: readonly ShortcutInfo[];
};

/** A tab of the shortcuts dialog. */
export type ShortcutTab = {
  title: string;
  sections: readonly ShortcutSection[];
};

/** How keys whose `KeyboardEvent.key` is a word are shown. */
const KEY_NAMES = new Map([
  ["ArrowLeft", "←"],
  ["ArrowRight", "→"],
  ["ArrowUp", "↑"],
  ["ArrowDown", "↓"],
  ["Delete", "Del"],
  ["Backspace", "⌫"],
  ["Escape", "Esc"],
  ["Enter", "Enter"],
  [" ", "Space"],
  ["-", "−"],
  ["Arrow", "Arrow keys"],
]);

/** Mouse gestures the shortcuts dialog lists beside keys; they are not keycaps. */
const GESTURES = new Set(["Wheel", "Drag", "Double-click", "Middle drag"]);

/** True when a part of a combo is a mouse gesture rather than a key. */
export function isGesture(part: string) {
  return GESTURES.has(part);
}

/** One key's caption; a word key such as `Space+Drag` splits into its parts. */
function keyParts(key: string) {
  if (key.length === 1) {
    return [KEY_NAMES.get(key) ?? key.toUpperCase()];
  }

  return key.split("+").map((part) => KEY_NAMES.get(part) ?? part);
}

/** The parts of `combo` as keycaps, such as `["Ctrl", "⇧", "Z"]`. */
export function comboLabel(combo: KeyCombo) {
  return [
    ...(combo.mod ? [modKeyLabel] : []),
    ...(combo.alt ? [isMac ? "⌥" : "Alt"] : []),
    ...(combo.shift ? ["⇧"] : []),
    ...keyParts(combo.key),
  ];
}

/** A combo written inline, as menus show it, such as `Ctrl+⇧+Z`. */
export function comboText(combo: KeyCombo) {
  return comboLabel(combo).join("+");
}

/** True when `event` presses `combo`, with no other modifier held. */
function isComboPressed(combo: KeyCombo, event: KeyboardEvent) {
  const isMod = event.ctrlKey || event.metaKey;

  if (
    isMod !== Boolean(combo.mod) ||
    event.altKey !== Boolean(combo.alt) ||
    (combo.shift !== undefined && event.shiftKey !== combo.shift)
  ) {
    return false;
  }

  // Option changes the character a Mac letter key types, so Alt combos match the
  // physical key.
  if (combo.alt && /^[a-z]$/iu.test(combo.key)) {
    return event.code === `Key${combo.key.toUpperCase()}`;
  }

  return event.key.toLowerCase() === combo.key.toLowerCase();
}

/** The first item with a combo `event` presses, or undefined. */
export function findPressed<T extends { keys: readonly KeyCombo[] }>(
  items: readonly T[],
  event: KeyboardEvent,
) {
  return items.find(({ keys }) =>
    keys.some((combo) => isComboPressed(combo, event)),
  );
}

/** A combo as `aria-keyshortcuts` writes it, such as `Control+Shift+D`; undefined for none. */
export function ariaKeyShortcut(combo: KeyCombo | undefined) {
  return (
    combo &&
    [
      ...(combo.mod ? [isMac ? "Meta" : "Control"] : []),
      ...(combo.alt ? ["Alt"] : []),
      ...(combo.shift ? ["Shift"] : []),
      combo.key.length === 1 ? combo.key.toUpperCase() : combo.key,
    ].join("+")
  );
}

/** The keycaps a tooltip shows for `combo`; undefined when a control has no shortcut. */
export function hintKeys(combo: KeyCombo | undefined) {
  return combo && comboLabel(combo);
}
