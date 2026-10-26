'use client';

import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';

interface FillHeightOptions {
  /** Never shorter than this, in px, however little room is left. */
  min?: number;
  /** Space kept free below the element, in px. */
  gap?: number;
}

/**
 * Sizes an element to the rest of the viewport below where it sits, for views
 * that scroll inside themselves (a kanban board, an inbox). The height is
 * measured from the element's real position, so whatever renders above it
 * (header, wrapping toolbars, banners) never needs a hard-coded offset.
 *
 * Returns a ref and a style carrying `--fill-h`; the element opts in per
 * breakpoint with a class such as `lg:h-[var(--fill-h)]`, so mobile layouts
 * that stack and scroll with the page are unaffected.
 */
export function useFillHeight<T extends HTMLElement>(
  { min = 420, gap = 24 }: FillHeightOptions = {},
  /** Measure an element that already has a ref of its own. */
  existingRef?: RefObject<T | null>,
) {
  const ownRef = useRef<T>(null);
  const ref = existingRef ?? ownRef;
  const [height, setHeight] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      // A hidden tab has no layout; it is measured again once it shows.
      if (el.offsetParent === null) return;
      const top = el.getBoundingClientRect().top + window.scrollY;
      setHeight(Math.max(min, Math.floor(window.innerHeight - top - gap)));
    };
    measure();
    // The element itself resizes when its tab is shown; an ancestor resizes
    // when anything above it changes height (a banner closing). The body alone
    // is not enough: min-h-screen page wrappers hold it at the viewport, so it
    // never shrinks. Same value twice is a no-op render.
    const observer = new ResizeObserver(measure);
    for (let node: HTMLElement | null = el; node; node = node.parentElement) observer.observe(node);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [ref, min, gap]);

  const style = (height ? { '--fill-h': `${height}px` } : {}) as CSSProperties;
  return { ref, style };
}
