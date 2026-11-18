import { CircuitElement, type EditField } from "../element";
import type { Point } from "../geometry";

/** The title a group shows until it is given one. */
export const DEFAULT_GROUP_TITLE = "Group";

/**
 * A titled outline drawn around part of a schematic, as Excalidraw's frames are. It
 * spans from one corner (x1, y1) to the opposite one (x2, y2) and has no posts, so the
 * simulation never sees it. What lies inside it belongs to it: the editor moves, copies
 * and deletes that along with it. Saved as Falstad's box, so Falstad's boxes open as
 * groups; the title is the element's custom name.
 */
export class Group extends CircuitElement {
  readonly kind = "group";
  readonly dumpType = "b";

  name() {
    return "Group";
  }

  /** The title drawn on its outline. */
  get titleText() {
    return this.customName || DEFAULT_GROUP_TITLE;
  }

  override posts(): Point[] {
    return [];
  }

  override isEnclosure() {
    return true;
  }

  override editFields(): EditField[] {
    return [
      {
        kind: "text",
        key: "title",
        label: "Title",
        value: this.customName,
        hint: `Drawn on its outline. Leave it empty for "${DEFAULT_GROUP_TITLE}".`,
        set: (value) => {
          this.customName = value.trim();
        },
      },
    ];
  }
}
