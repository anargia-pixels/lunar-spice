import {
  offsetRect,
  type OffsetRect,
} from "@lunar-spice/components/lib/offset-rect";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

/**
 * The item under the pointer, or else the one whose center is nearest along x, so a
 * pointer in a gap or the container's padding still lands on an item. Ties keep the
 * first item.
 */
function pickNearest(
  container: HTMLElement,
  rects: readonly (OffsetRect | undefined)[],
  x: number,
) {
  const box = container.getBoundingClientRect();

  // Factors out an ancestor `transform: scale`, which the layout rects ignore.
  const scale =
    container.offsetWidth > 0 ? box.width / container.offsetWidth : 1;

  let nearestIndex: number | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  let containingIndex: number | null = null;

  for (const [index, rect] of rects.entries()) {
    if (!rect) continue;

    const start =
      box.left +
      (container.clientLeft + rect.left - container.scrollLeft) * scale;

    const width = rect.width * scale;

    if (x >= start && x <= start + width) containingIndex = index;

    const distance = Math.abs(x - (start + width / 2));

    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  }

  return containingIndex ?? nearestIndex;
}

/**
 * Tracks which item of a horizontal strip the pointer is nearest, and measures every
 * registered item in the container's layout space so overlays can be positioned on them.
 * Returns the active index, the item rects, the mouse handlers for the container, and
 * functions that register and measure items.
 */
export function useFluidHover(containerRef: RefObject<HTMLElement | null>) {
  const itemsRef = useRef(new Map<number, HTMLElement>());
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [itemRects, setItemRects] = useState<OffsetRect[]>([]);
  const itemRectsRef = useRef<OffsetRect[]>([]); // read by the pointer handler outside a render
  const moveFrameRef = useRef<number | null>(null);
  const measureFrameRef = useRef<number | null>(null);
  const itemObserverRef = useRef<ResizeObserver | null>(null);

  /** Measures every registered item; keeps the last rects while an item has no box. */
  const measureItems = useCallback(() => {
    const container = containerRef.current;

    if (!container) return;

    const rects: OffsetRect[] = [];

    for (const [index, element] of itemsRef.current) {
      // An item with no box (inside a `display: none` ancestor) reads every
      // offset as 0, so the last complete measurement stands instead.
      if (
        element.offsetParent === null &&
        element.offsetWidth === 0 &&
        element.offsetHeight === 0
      ) {
        return;
      }

      rects[index] = offsetRect(element, container);
    }

    // Skips the state update when nothing moved, so extra passes do not re-render.
    const previous = itemRectsRef.current;
    let changed = previous.length !== rects.length;

    for (let i = 0; !changed && i < rects.length; i++) {
      const p = previous[i];
      const r = rects[i];

      if (p === r) continue; // both undefined: an unregistered slot

      changed =
        !p ||
        !r ||
        p.top !== r.top ||
        p.left !== r.left ||
        p.width !== r.width ||
        p.height !== r.height;
    }

    if (changed) {
      itemRectsRef.current = rects;
      setItemRects(rects);
    }
  }, [containerRef]);

  /** Coalesces registrations and resizes into one measurement on the next frame. */
  const scheduleMeasurement = useCallback(() => {
    if (measureFrameRef.current !== null) {
      cancelAnimationFrame(measureFrameRef.current);
    }

    measureFrameRef.current = requestAnimationFrame(() => {
      measureFrameRef.current = null;
      measureItems();
    });
  }, [measureItems]);

  /** Adds `element` at `index`, or removes the item there when `element` is null. */
  const registerItem = useCallback(
    (index: number, element: HTMLElement | null) => {
      // Items are observed themselves, not only the container: a tab can change size
      // without the strip resizing.
      itemObserverRef.current ??= new ResizeObserver(() =>
        scheduleMeasurement(),
      );

      if (element) {
        itemsRef.current.set(index, element);
        itemObserverRef.current.observe(element);
      } else {
        const previous = itemsRef.current.get(index);

        if (previous) itemObserverRef.current.unobserve(previous);
        itemsRef.current.delete(index);

        // Decided when the update applies, after this commit's registrations, so
        // an item that only moved index hands the highlight to the item now under
        // it.
        setActiveIndex((current) =>
          current === index && !itemsRef.current.has(index) ? null : current,
        );
      }

      scheduleMeasurement();
    },
    [scheduleMeasurement],
  );

  const onMouseMove = useCallback(
    (e: React.MouseEvent) => {
      // React bubbles moves from portalled children through the tree; those happened
      // in another layer.
      if (e.target instanceof Node && !e.currentTarget.contains(e.target)) {
        return;
      }

      const mouseX = e.clientX;

      if (moveFrameRef.current !== null) {
        cancelAnimationFrame(moveFrameRef.current);
      }

      moveFrameRef.current = requestAnimationFrame(() => {
        moveFrameRef.current = null;
        const container = containerRef.current;

        if (!container) return;

        setActiveIndex(pickNearest(container, itemRectsRef.current, mouseX));
      });
    },
    [containerRef],
  );

  const onMouseLeave = useCallback(() => {
    if (moveFrameRef.current !== null) {
      cancelAnimationFrame(moveFrameRef.current);
      moveFrameRef.current = null;
    }

    setActiveIndex(null);
  }, []);

  // A reflow moves items even though the registered set is unchanged.
  useEffect(() => {
    const container = containerRef.current;

    if (!container) return;

    const observer = new ResizeObserver(() => scheduleMeasurement());

    observer.observe(container);

    return () => observer.disconnect();
  }, [containerRef, scheduleMeasurement]);

  useEffect(() => {
    return () => {
      if (moveFrameRef.current !== null) {
        cancelAnimationFrame(moveFrameRef.current);
      }

      if (measureFrameRef.current !== null) {
        cancelAnimationFrame(measureFrameRef.current);
      }

      itemObserverRef.current?.disconnect();
      itemObserverRef.current = null;
    };
  }, []);

  return {
    activeIndex,
    setActiveIndex,
    itemRects,
    handlers: { onMouseMove, onMouseLeave },
    registerItem,
    measureItems,
  };
}
