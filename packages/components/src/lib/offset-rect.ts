export interface OffsetRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * The box of `element` in `container`'s layout space, summing offsets through any
 * positioned wrappers between them. Layout offsets rather than `getBoundingClientRect`,
 * so an ancestor's CSS transform does not skew the result.
 */
export function offsetRect(
  element: HTMLElement,
  container: HTMLElement,
): OffsetRect {
  let top = element.offsetTop;
  let left = element.offsetLeft;
  let ancestor = element.offsetParent;

  while (
    ancestor instanceof HTMLElement &&
    ancestor !== container &&
    container.contains(ancestor)
  ) {
    top += ancestor.offsetTop + ancestor.clientTop;
    left += ancestor.offsetLeft + ancestor.clientLeft;
    ancestor = ancestor.offsetParent;
  }

  return {
    top,
    left,
    width: element.offsetWidth,
    height: element.offsetHeight,
  };
}
