import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@lunar-spice/components/ui/dialog";
import { Kbd, KbdGroup } from "@lunar-spice/components/ui/kbd";
import {
  TabItem,
  TabPanel,
  Tabs,
  TabsList,
} from "@lunar-spice/components/ui/tabs";
import { Fragment } from "react";

import {
  comboLabel,
  isGesture,
  type KeyCombo,
  type ShortcutSection,
  type ShortcutTab,
} from "../../lib/shortcuts";
import { canvasShortcutTabs } from "./commands";

/**
 * One combo as keycaps; a mouse gesture in it reads as words, such as `Space + drag`.
 */
export function ComboKeys({ combo }: { combo: KeyCombo }) {
  return (
    <KbdGroup>
      {comboLabel(combo).map((part, index) =>
        isGesture(part) ? (
          <span key={part} className="text-muted-foreground font-ui text-xs">
            {index > 0 ? `+ ${part.toLowerCase()}` : part}
          </span>
        ) : (
          <Kbd key={part}>{part}</Kbd>
        ),
      )}
    </KbdGroup>
  );
}

/** Every combo of a shortcut, with "or" between them so each reads on its own. */
function ShortcutKeys({ keys }: { keys: readonly KeyCombo[] }) {
  return (
    <span className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
      {keys.map((combo, index) => (
        <Fragment key={comboLabel(combo).join("+")}>
          {index > 0 && (
            <span className="text-muted-foreground text-xs">or</span>
          )}
          <ComboKeys combo={combo} />
        </Fragment>
      ))}
    </span>
  );
}

/**
 * The canvas's tabs with the app's sections added: into the canvas section of the same
 * title, such as Simulation, or else into a tab of their own.
 */
function withAppSections(
  tabs: readonly ShortcutTab[],
  appSections: readonly ShortcutSection[],
): ShortcutTab[] {
  const titles = new Set(
    tabs.flatMap(({ sections }) => sections.map(({ title }) => title)),
  );

  const merged = tabs.map((tab) => ({
    ...tab,
    sections: tab.sections.map((section) => ({
      ...section,
      items: [
        ...section.items,
        ...appSections
          .filter(({ title }) => title === section.title)
          .flatMap(({ items }) => items),
      ],
    })),
  }));

  const rest = appSections.filter(({ title }) => !titles.has(title));

  return rest.length > 0
    ? [...merged, { title: "App", sections: rest }]
    : merged;
}

/**
 * Lists every keyboard shortcut in tabs: the canvas's own, then `appSections`, the
 * shortcuts the app around the editor handles. Panels share one height, so switching
 * tabs leaves the dialog still.
 */
export function ShortcutsDialog({
  open,
  onOpenChange,
  appSections,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appSections: readonly ShortcutSection[];
}) {
  const tabs = withAppSections(canvasShortcutTabs(), appSections);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Moving, zooming and transforming work as in Inkscape.
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue={tabs[0]?.title}>
          <TabsList className="mb-4">
            {tabs.map(({ title }) => (
              <TabItem key={title} value={title} label={title} />
            ))}
          </TabsList>
          {tabs.map(({ title, sections }) => (
            <TabPanel
              key={title}
              value={title}
              className="h-120 overflow-y-auto"
            >
              <div
                className="columns-2 gap-8 data-many:columns-3 data-many:gap-6"
                data-many={sections.length > 2 ? "" : undefined}
              >
                {sections.map((section) => (
                  <section
                    key={section.title}
                    className="mb-5 flex break-inside-avoid flex-col"
                  >
                    <h3 className="text-muted-foreground mb-1 text-xs font-medium">
                      {section.title}
                    </h3>
                    {section.items.map((item) => (
                      <div
                        key={item.label}
                        className="border-border flex items-center justify-between gap-4 border-b py-1 text-sm last:border-b-0"
                      >
                        <span className="text-pretty">{item.label}</span>
                        <ShortcutKeys keys={item.keys} />
                      </div>
                    ))}
                  </section>
                ))}
              </div>
            </TabPanel>
          ))}
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
