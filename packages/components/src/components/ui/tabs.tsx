import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useFluidHover } from "@lunar-spice/components/hooks/use-fluid-hover";
import { spring } from "@lunar-spice/components/lib/springs";
import { cn } from "@lunar-spice/utils/cn";
import { motion, AnimatePresence } from "framer-motion";
import {
  useRef,
  useState,
  useCallback,
  useEffect,
  useLayoutEffect,
  createContext,
  useContext,
  forwardRef,
  Children,
  cloneElement,
  isValidElement,
  type ComponentPropsWithoutRef,
} from "react";

// Sizes

type TabsSize = "default" | "compact";

// List padding plus tab height make the control height (36px default, 28px
// compact), so the control lines up with buttons, selects and inputs beside it.
const TAB_SIZES = {
  default: { list: "p-1", tab: "h-7 gap-2", text: "text-[13px]/5", icon: 16 },
  compact: {
    list: "p-0.5",
    tab: "h-6 gap-1",
    text: "text-xs/[18px]",
    icon: 14,
  },
} as const;

// Contexts

interface TabsValueOrderContextValue {
  valueOrder: string[];
  setValueOrder: (order: string[]) => void;
  selectedValue: string | undefined;
  size: TabsSize;
}

const TabsValueOrderContext = createContext<TabsValueOrderContextValue | null>(
  null,
);

interface TabsListContextValue {
  registerTab: (index: number, value: string, el: HTMLElement | null) => void;
  hoveredIndex: number | null;
  selectedValue: string | undefined;
  /** Moves the selected pill at once on click, before the selection updates. */
  setOptimisticIdx: (index: number) => void;
}

const TabsListContext = createContext<TabsListContextValue | null>(null);

/** The TabsList context; throws when a TabItem is outside a TabsList. */
function useTabsList() {
  const ctx = useContext(TabsListContext);
  if (!ctx) throw new Error("TabItem must be used within a TabsList");
  return ctx;
}

// Tabs

interface TabsProps extends Omit<
  ComponentPropsWithoutRef<typeof TabsPrimitive.Root>,
  "onValueChange" | "value" | "defaultValue" | "onSelect"
> {
  /** Selected tab value; wins over `selectedIndex`. */
  value?: string;
  onValueChange?: (value: string) => void;
  /** Selected tab by position, for callers that track tabs by index. */
  selectedIndex?: number;
  onSelect?: (index: number) => void;
  defaultValue?: string;
  /** Control height: 36px by default, 28px compact. */
  size?: TabsSize;
}

/**
 * Segmented control root. Selection is controlled by `value` or
 * `selectedIndex`, or else kept in local state; changes report both ways.
 */
const Tabs = forwardRef<HTMLDivElement, TabsProps>(
  (
    {
      value,
      onValueChange,
      selectedIndex,
      onSelect,
      defaultValue,
      size,
      children,
      ...props
    },
    ref,
  ) => {
    const [valueOrder, setValueOrder] = useState<string[]>([]);
    const [uncontrolledValue, setUncontrolledValue] = useState<
      string | undefined
    >(defaultValue);
    // Keeps the current array when the order is unchanged, so React skips the
    // update when a TabsList reports the same tabs again (a remount, Strict
    // Mode's double effects) and the root does not re-render.
    const updateValueOrder = useCallback((order: string[]) => {
      setValueOrder((current) => {
        if (
          current.length === order.length &&
          current.every((v, i) => v === order[i])
        ) {
          return current;
        }
        return order;
      });
    }, []);

    // Order of precedence: `value`, then `selectedIndex`, then local state.
    // Without a defaultValue, the first tab is selected, so the pills match
    // what the primitive shows.
    const resolvedValue =
      value ??
      (selectedIndex != null
        ? valueOrder[selectedIndex]
        : (uncontrolledValue ?? valueOrder[0]));

    // Base UI also passes event details, which this handler ignores.
    const handleValueChange = useCallback(
      (newValue: unknown) => {
        const v = newValue as string;
        // Local state backs uncontrolled use only. With `value` or
        // `selectedIndex`, the parent owns the selection.
        if (value === undefined && selectedIndex == null) {
          setUncontrolledValue(v);
        }
        onValueChange?.(v);
        if (onSelect) {
          const idx = valueOrder.indexOf(v);
          if (idx !== -1) onSelect(idx);
        }
      },
      [onValueChange, onSelect, valueOrder, value, selectedIndex],
    );

    // The primitive is always controlled: Base UI's useControlled warns in
    // development when value changes from undefined to defined. valueOrder
    // is empty on the first commit, so "" stands in until TabsList's layout
    // effect fills valueOrder before paint.
    return (
      <TabsValueOrderContext.Provider
        value={{
          valueOrder,
          setValueOrder: updateValueOrder,
          selectedValue: resolvedValue,
          size: size ?? "default",
        }}
      >
        <TabsPrimitive.Root
          ref={ref}
          value={resolvedValue ?? ""}
          onValueChange={handleValueChange}
          {...props}
        >
          {children}
        </TabsPrimitive.Root>
      </TabsValueOrderContext.Provider>
    );
  },
);

Tabs.displayName = "Tabs";

// TabsList

type TabsListProps = ComponentPropsWithoutRef<typeof TabsPrimitive.List>;

/**
 * The muted track. It draws three layers over its tabs, each placed on the tab
 * rects that `useFluidHover` measures; the tabs stay transparent.
 * - Selected pill: the page background, so it stands off the track. It moves on
 *   `spring.moderate` without overshoot and dims to 0.85 over 80ms while
 *   another tab is hovered, so it reads as "current" and the hover pill as
 *   "next".
 * - Hover pill: `bg-hover` at 0.4 opacity, well below the selected pill. It
 *   starts at the selected pill and slides to the hovered tab on `spring.fast`
 *   to keep up with the cursor, so the preview reads as leaving the current
 *   choice. When the mouse leaves the list, it slides back into the selected
 *   pill while it fades over 60ms; over the selected tab, it fades in place.
 *   It does not draw without a selected pill.
 * - Focus ring: one ring for the list that springs between tabs, 2px outside
 *   the focused tab and above the tabs (z-20).
 */
const TabsList = forwardRef<HTMLDivElement, TabsListProps>(
  ({ children, className, ...props }, ref) => {
    const containerRef = useRef<HTMLDivElement>(null);
    // Whether the pointer is over the list: a ref for blur, which reads it at
    // the moment it runs, and the same flag as state for the render, which
    // picks the hover pill's exit from it. Both flip in the same handlers.
    const isMouseInside = useRef(false);
    const [mouseInside, setMouseInside] = useState(false);
    // Pills sit 4px (p-1) inside the rounded-2xl track, so their radius is
    // 4px smaller to stay concentric; the focus ring sits 2px outside a pill.
    const pillRadius = "rounded-[calc(var(--radius-2xl)-4px)]";
    const valueOrderCtx = useContext(TabsValueOrderContext);
    const sizes = TAB_SIZES[valueOrderCtx?.size ?? "default"];

    // Reads the tab values from the children during render.
    const values = Children.toArray(children)
      .filter(isValidElement)
      .map((child) => (child.props as { value?: string }).value)
      .filter((v): v is string => typeof v === "string");
    // `values` is a new array every render; the serialized key is what the
    // layout effect compares, so it only re-reports on a real change.
    const valueOrderKey = JSON.stringify(values);
    const setValueOrder = valueOrderCtx?.setValueOrder;

    // Reports the tab order to Tabs before paint.
    useLayoutEffect(() => {
      setValueOrder?.(JSON.parse(valueOrderKey) as string[]);
    }, [setValueOrder, valueOrderKey]);

    // The tab nearest the cursor horizontally wins, so the list's padding
    // never leaves the hover pill without a target.
    const {
      activeIndex: hoveredIndex,
      setActiveIndex: setHoveredIndex,
      itemRects,
      handlers,
      registerItem,
      measureItems,
    } = useFluidHover(containerRef);

    // Adapts TabItem's registration to useFluidHover, which ignores the value.
    const registerTab = useCallback(
      (index: number, _value: string, el: HTMLElement | null) => {
        registerItem(index, el);
      },
      [registerItem],
    );

    // Measures the tabs again when the children change. useFluidHover's
    // ResizeObserver covers resizes.
    useEffect(() => {
      measureItems();
    }, [measureItems, children]);

    const handleMouseMove = useCallback(
      (e: React.MouseEvent) => {
        isMouseInside.current = true;
        setMouseInside(true);
        handlers.onMouseMove(e);
      },
      [handlers],
    );

    // Flips the flag before it clears the hover index: the hover pill's exit
    // is chosen from it, sliding back into the selected pill or fading in place.
    const handleMouseLeave = useCallback(() => {
      isMouseInside.current = false;
      setMouseInside(false);
      handlers.onMouseLeave();
    }, [handlers]);

    // The tab with the focus ring; null when focus is not visible.
    const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
    const selectedValue = valueOrderCtx?.selectedValue;
    const selectedIdx =
      selectedValue !== undefined ? values.indexOf(selectedValue) : -1;

    // The pills follow optimisticIdx, not selectedIdx. A click sets it at once,
    // so the pill moves before controlled state round-trips; it is then
    // resynced, during render, whenever the resolved selection changes (arrow
    // keys, a parent). The first render syncs too: syncedIdx starts unset.
    const [optimisticIdx, setOptimisticIdx] = useState<number | null>(null);
    const [syncedIdx, setSyncedIdx] = useState<number | undefined>(undefined);
    if (syncedIdx !== selectedIdx) {
      setSyncedIdx(selectedIdx);
      setOptimisticIdx(selectedIdx >= 0 ? selectedIdx : null);
    }

    const activeSelectedIdx = optimisticIdx;
    const selectedRect =
      activeSelectedIdx !== null ? itemRects[activeSelectedIdx] : null;
    const hoverRect = hoveredIndex !== null ? itemRects[hoveredIndex] : null;
    const focusRect = focusedIndex !== null ? itemRects[focusedIndex] : null;
    // Hovering the selected tab needs no hover pill, because the selected pill
    // is already there. Hovering another tab shows one and dims the selected
    // pill.
    const isHoveringSelected = hoveredIndex === activeSelectedIdx;
    const isHovering = hoveredIndex !== null && !isHoveringSelected;

    // Gives each tab child its `_index`. Plain DOM children are skipped,
    // because React warns about the unknown prop on them.
    const indexedChildren = Children.map(children, (child, i) => {
      if (isValidElement(child) && typeof child.type !== "string") {
        return cloneElement(child, { _index: i } as Record<string, unknown>);
      }
      return child;
    });

    // `activateOnFocus` selects on arrow keys, so the pill follows the
    // keyboard as it follows a click. Focus also sets the hover index, so
    // keyboard and mouse share one highlight. The ring draws only on
    // :focus-visible, so a mouse click, which also focuses, shows none.
    // Focus moves between tabs stay inside the list and are ignored. Blur out
    // of the list drops the ring; the hover pill stays while the mouse rests
    // on a tab.
    return (
      <TabsListContext.Provider
        value={{
          registerTab,
          hoveredIndex,
          selectedValue,
          setOptimisticIdx,
        }}
      >
        <TabsPrimitive.List
          activateOnFocus
          ref={(node) => {
            (
              containerRef as React.MutableRefObject<HTMLDivElement | null>
            ).current = node;
            if (typeof ref === "function") ref(node);
            else if (ref)
              (ref as React.MutableRefObject<HTMLDivElement | null>).current =
                node;
          }}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          onFocus={(e) => {
            const trigger = (e.target as HTMLElement).closest('[role="tab"]');
            if (!trigger) return;
            const indexAttr = trigger.getAttribute("data-fluid-hover-index");
            if (indexAttr != null) {
              const idx = Number(indexAttr);
              setHoveredIndex(idx);
              setFocusedIndex(
                (e.target as HTMLElement).matches(":focus-visible")
                  ? idx
                  : null,
              );
            }
          }}
          onBlur={(e) => {
            if (containerRef.current?.contains(e.relatedTarget as Node)) return;
            setFocusedIndex(null);
            if (isMouseInside.current) return;
            setHoveredIndex(null);
          }}
          className={cn(
            "bg-muted relative inline-flex items-center select-none",
            sizes.list,
            "rounded-2xl",
            className,
          )}
          {...props}
        >
          {/* Selected pill */}
          {selectedRect && (
            <motion.div
              className={cn(
                "pointer-events-none absolute",
                "bg-background",
                pillRadius,
              )}
              initial={false}
              animate={{
                left: selectedRect.left,
                width: selectedRect.width,
                top: selectedRect.top,
                height: selectedRect.height,
                opacity: isHovering ? 0.85 : 1,
              }}
              transition={{
                ...spring.moderate,
                opacity: { duration: 0.08 },
              }}
            />
          )}

          {/* Hover pill */}
          <AnimatePresence>
            {hoverRect && !isHoveringSelected && selectedRect && (
              <motion.div
                className={cn(
                  "bg-hover pointer-events-none absolute",
                  pillRadius,
                )}
                initial={{
                  left: selectedRect.left,
                  width: selectedRect.width,
                  top: selectedRect.top,
                  height: selectedRect.height,
                  opacity: 0,
                }}
                animate={{
                  left: hoverRect.left,
                  width: hoverRect.width,
                  top: hoverRect.top,
                  height: hoverRect.height,
                  opacity: 0.4,
                }}
                exit={
                  !mouseInside && selectedRect
                    ? {
                        left: selectedRect.left,
                        width: selectedRect.width,
                        top: selectedRect.top,
                        height: selectedRect.height,
                        opacity: 0,
                        transition: {
                          ...spring.moderate,
                          opacity: { duration: 0.06 },
                        },
                      }
                    : { opacity: 0, transition: spring.fast.exit }
                }
                transition={{
                  ...spring.fast,
                  opacity: { duration: 0.08 },
                }}
              />
            )}
          </AnimatePresence>

          {/* Focus ring */}
          <AnimatePresence>
            {focusRect && (
              <motion.div
                className={cn(
                  "border-ring pointer-events-none absolute z-20 border",
                  "rounded-[calc(var(--radius-2xl)-2px)]",
                )}
                initial={false}
                animate={{
                  left: focusRect.left - 2,
                  top: focusRect.top - 2,
                  width: focusRect.width + 4,
                  height: focusRect.height + 4,
                }}
                exit={{ opacity: 0, transition: spring.fast.exit }}
                transition={{
                  ...spring.fast,
                  opacity: { duration: 0.08 },
                }}
              />
            )}
          </AnimatePresence>

          {indexedChildren}
        </TabsPrimitive.List>
      </TabsListContext.Provider>
    );
  },
);

TabsList.displayName = "TabsList";

// TabItem

interface TabItemProps extends ComponentPropsWithoutRef<
  typeof TabsPrimitive.Tab
> {
  /** Unique value for this tab. */
  value: string;
  /** Icon before the label. */
  icon?: IconSvgElement;
  label: string;
  /** @internal Set by TabsList. */
  _index?: number;
}

/** One tab: an optional icon and a label, drawn over the list's pills. */
const TabItem = forwardRef<HTMLButtonElement, TabItemProps>(
  (
    { value, icon: Icon, label, _index = 0, className, onClick, ...props },
    ref,
  ) => {
    const internalRef = useRef<HTMLButtonElement>(null);
    const sizes =
      TAB_SIZES[useContext(TabsValueOrderContext)?.size ?? "default"];
    const { registerTab, hoveredIndex, selectedValue, setOptimisticIdx } =
      useTabsList();

    // Registers the button so the list can measure its rect; the cleanup
    // unregisters it, so no pill aims at a tab that is gone.
    useEffect(() => {
      registerTab(_index, value, internalRef.current);
      return () => registerTab(_index, value, null);
    }, [_index, value, registerTab]);

    const isSelected = selectedValue === value;
    const isActive = hoveredIndex === _index || isSelected;

    // The onClick wraps the caller's, so a caller cannot replace the pill jump.
    // `data-fluid-hover-index` lets the list's onFocus find the tab's index.
    // The tab has no outline: the list draws one shared focus ring. A fixed
    // height, not padding, keeps the text-box trim from shrinking the tab, so
    // browsers without text-box support render the same.
    // Hover or selection changes the icon stroke from 1.5 to 2 and the icon
    // and label from muted to foreground, both over 80ms.
    return (
      <TabsPrimitive.Tab
        onClick={(e) => {
          setOptimisticIdx(_index);
          onClick?.(e);
        }}
        ref={(node) => {
          (internalRef as React.MutableRefObject<HTMLElement | null>).current =
            node as HTMLButtonElement | null;
          if (typeof ref === "function") ref(node as HTMLButtonElement);
          else if (ref)
            (ref as React.MutableRefObject<HTMLButtonElement | null>).current =
              node as HTMLButtonElement | null;
        }}
        value={value}
        data-fluid-hover-index={_index}
        className={cn(
          "relative z-10 flex cursor-pointer items-center border-none bg-transparent px-3 outline-none",
          sizes.tab,
          className,
        )}
        {...props}
      >
        {Icon && (
          <HugeiconsIcon
            icon={Icon}
            size={sizes.icon}
            strokeWidth={isActive ? 2 : 1.5}
            className={cn(
              "transition-[color,stroke-width] duration-80",
              isActive ? "text-foreground" : "text-muted-foreground",
            )}
          />
        )}
        <span
          className={cn(
            "whitespace-nowrap transition-colors duration-80 [text-box:trim-both_cap_alphabetic]",
            sizes.text,
            isActive ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {label}
        </span>
      </TabsPrimitive.Tab>
    );
  },
);

TabItem.displayName = "TabItem";

// TabPanel

interface TabPanelProps extends ComponentPropsWithoutRef<
  typeof TabsPrimitive.Panel
> {
  /** Must match a TabItem value. */
  value: string;
}

/** The content shown while the TabItem with the same `value` is selected. */
const TabPanel = forwardRef<HTMLDivElement, TabPanelProps>(
  ({ className, ...props }, ref) => {
    return (
      <TabsPrimitive.Panel
        ref={ref}
        className={cn("outline-none", className)}
        {...props}
      />
    );
  },
);

TabPanel.displayName = "TabPanel";

export { Tabs, TabsList, TabItem, TabPanel };
export type { TabsProps, TabsListProps, TabItemProps, TabPanelProps };
