import { RotateLeft01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  GRID_STYLES,
  GRID_STYLE_KEYS,
  RESISTOR_STYLES,
  type ResistorStyle,
  SCHEMATIC_FONTS,
  SCHEMATIC_FONT_KEYS,
} from "@lunar-spice/components/circuit-editor/display-options";
import { SettingsPane } from "@lunar-spice/components/settings-dialog/settings-pane";
import {
  COLOR_THEMES,
  findColorTheme,
  type ColorPalette,
} from "@lunar-spice/components/themes/color-themes";
import { Button } from "@lunar-spice/components/ui/button";
import { Label } from "@lunar-spice/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@lunar-spice/components/ui/select";
import { Switch } from "@lunar-spice/components/ui/switch";
import type { CSSProperties } from "react";

import { ownsWindow } from "../../lib/platform";
import { type Theme, useAppearanceStore } from "../../stores/appearance-store";
import {
  type ZoomPercent,
  useZoomStore,
  ZOOM_PERCENTS,
} from "../../stores/zoom-store";

/** Stands for the colors written in globals.css rather than a color theme. */
const DEFAULT_COLOR_THEME = "default";

const LABELS = {
  light: "Light theme",
  dark: "Dark theme",
} as const;

/** Each color theme's label by id, with Default first. */
const COLOR_THEME_ITEMS = {
  [DEFAULT_COLOR_THEME]: "Default",
  ...Object.fromEntries(
    COLOR_THEMES.map((colorTheme) => [colorTheme.id, colorTheme.label]),
  ),
};

/** The five colors a color theme shows beside its name. */
const SWATCH_TOKENS = [
  "background",
  "foreground",
  "accent",
  "primary",
  "popover",
] as const;

type SwatchStyle = CSSProperties & { "--swatch": string };

/** Picks the color theme for light or dark; each option shows its five swatches. */
function ColorThemeSelect({
  theme,
  colorTheme,
  onColorThemeChange,
}: {
  theme: Theme;
  colorTheme: string | null;
  onColorThemeChange: (colorTheme: string | null) => void;
}) {
  const selected = findColorTheme(colorTheme);
  const value = selected === undefined ? DEFAULT_COLOR_THEME : selected.id;

  return (
    <div className="flex items-center justify-between gap-6">
      <span className="text-sm">{LABELS[theme]}</span>
      <Select
        items={COLOR_THEME_ITEMS}
        value={value}
        onValueChange={(next) =>
          onColorThemeChange(next === DEFAULT_COLOR_THEME ? null : next)
        }
      >
        <SelectTrigger
          className="w-64 justify-between"
          aria-label={LABELS[theme]}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>
          <SelectItem value={DEFAULT_COLOR_THEME}>Default</SelectItem>
          {COLOR_THEMES.map((colorTheme) => (
            <SelectItem key={colorTheme.id} value={colorTheme.id}>
              <ColorThemeSwatches palette={colorTheme[theme]} />
              <span>{colorTheme.label}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

const ZOOM_ITEMS = ZOOM_PERCENTS.map((percent) => ({
  value: percent,
  label: `${percent}%`,
}));

/** Picks the window zoom from the same steps the zoom shortcuts move through. */
function ZoomSelect() {
  const percent = useZoomStore((state) => state.percent);
  const setPercent = useZoomStore((state) => state.setPercent);

  return (
    <div className="flex items-center justify-between gap-6">
      <span className="text-sm">Zoom</span>
      <Select<ZoomPercent>
        items={ZOOM_ITEMS}
        value={percent}
        onValueChange={(next) => {
          if (next !== null) {
            setPercent(next);
          }
        }}
      >
        <SelectTrigger className="w-64 justify-between" aria-label="Zoom">
          <SelectValue />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>
          {ZOOM_ITEMS.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * The five swatches of a palette. Each sets `--swatch` inline, because a Tailwind class
 * cannot hold a color known only at runtime.
 */
function ColorThemeSwatches({ palette }: { palette: ColorPalette }) {
  return SWATCH_TOKENS.map((token) => {
    const style: SwatchStyle = { "--swatch": palette[token] };

    return (
      <span
        key={token}
        className="ring-foreground/15 size-3.5 shrink-0 rounded-xs bg-(--swatch) ring-1"
        style={style}
      />
    );
  });
}

const RESISTOR_STYLE_KEYS = Object.keys(RESISTOR_STYLES).filter(
  (key): key is ResistorStyle => key in RESISTOR_STYLES,
);

/** The on/off display settings, in the order the pane lists them. */
const DISPLAY_SWITCHES = [
  { key: "showVoltageColors", label: "Color wires by voltage" },
  { key: "showCurrentDots", label: "Show current as moving dots" },
  { key: "showValues", label: "Show designators and values" },
  { key: "showGrid", label: "Show grid" },
] as const;

/**
 * How the schematic draws: voltage colors, current dots, values, grid, resistor symbols
 * and the font of its text.
 */
function SchematicSettings() {
  const display = useAppearanceStore((state) => state.display);
  const setDisplay = useAppearanceStore((state) => state.setDisplay);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h3 className="text-base font-medium">Schematic</h3>
        <p className="text-muted-foreground text-sm text-pretty">
          What the canvas shows while the simulation runs.
        </p>
      </header>
      {DISPLAY_SWITCHES.map(({ key, label }) => (
        <div key={key} className="flex items-center justify-between gap-6">
          <Label htmlFor={key}>{label}</Label>
          <Switch
            id={key}
            checked={display[key]}
            onCheckedChange={(checked) => setDisplay({ [key]: checked })}
          />
        </div>
      ))}
      <div className="flex items-center justify-between gap-6">
        <span className="text-sm">Grid style</span>
        <Select
          items={GRID_STYLES}
          value={display.gridStyle}
          disabled={!display.showGrid}
          onValueChange={(next) => {
            const style = GRID_STYLE_KEYS.find((key) => key === next);

            if (style) {
              setDisplay({ gridStyle: style });
            }
          }}
        >
          <SelectTrigger
            className="w-64 justify-between"
            aria-label="Grid style"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            {GRID_STYLE_KEYS.map((style) => (
              <SelectItem key={style} value={style}>
                {GRID_STYLES[style]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center justify-between gap-6">
        <span className="text-sm">Resistor symbol</span>
        <Select
          items={RESISTOR_STYLES}
          value={display.resistorStyle}
          onValueChange={(next) => {
            const style = RESISTOR_STYLE_KEYS.find((key) => key === next);

            if (style) {
              setDisplay({ resistorStyle: style });
            }
          }}
        >
          <SelectTrigger
            className="w-64 justify-between"
            aria-label="Resistor symbol"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            {RESISTOR_STYLE_KEYS.map((style) => (
              <SelectItem key={style} value={style}>
                {RESISTOR_STYLES[style]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center justify-between gap-6">
        <span className="text-sm">Schematic font</span>
        <Select
          items={SCHEMATIC_FONTS}
          value={display.schematicFont}
          onValueChange={(next) => {
            const font = SCHEMATIC_FONT_KEYS.find((key) => key === next);

            if (font) {
              setDisplay({ schematicFont: font });
            }
          }}
        >
          <SelectTrigger
            className="w-64 justify-between"
            aria-label="Schematic font"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            {SCHEMATIC_FONT_KEYS.map((font) => (
              <SelectItem key={font} value={font}>
                {SCHEMATIC_FONTS[font]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

/**
 * Appearances pane: color themes, how the schematic draws, then window zoom where the
 * app owns its window. A browser zooms the page itself.
 */
export function AppearancePane() {
  const lightColorTheme = useAppearanceStore((state) => state.lightColorTheme);
  const darkColorTheme = useAppearanceStore((state) => state.darkColorTheme);

  const setLightColorTheme = useAppearanceStore(
    (state) => state.setLightColorTheme,
  );

  const setDarkColorTheme = useAppearanceStore(
    (state) => state.setDarkColorTheme,
  );

  const resetColorThemes = useAppearanceStore(
    (state) => state.resetColorThemes,
  );

  return (
    <SettingsPane
      title="Appearances"
      description="A color theme restyles every color in the app. Each theme picks its own."
    >
      <div className="flex flex-col gap-4">
        <ColorThemeSelect
          theme="light"
          colorTheme={lightColorTheme}
          onColorThemeChange={setLightColorTheme}
        />
        <ColorThemeSelect
          theme="dark"
          colorTheme={darkColorTheme}
          onColorThemeChange={setDarkColorTheme}
        />
      </div>
      <Button
        variant="outline"
        className="self-start"
        disabled={lightColorTheme === null && darkColorTheme === null}
        onClick={resetColorThemes}
      >
        <HugeiconsIcon icon={RotateLeft01Icon} strokeWidth={2} />
        Reset to defaults
      </Button>
      <SchematicSettings />
      {ownsWindow() && (
        <div className="flex flex-col gap-4">
          <header className="flex flex-col gap-1">
            <h3 className="text-base font-medium">Window</h3>
            <p className="text-muted-foreground text-sm text-pretty">
              Zoom scales the whole window; the canvas zooms on its own.
            </p>
          </header>
          <ZoomSelect />
        </div>
      )}
    </SettingsPane>
  );
}
