'use client';

import { useSyncExternalStore } from 'react';

/**
 * Whether the primary input is a finger rather than a mouse.
 *
 * `(pointer: coarse)` rather than a viewport width, because this decides which
 * *input* the scene wires up, not how it is laid out. A narrow desktop window
 * still has a mouse and should keep pointer-lock free roam; a tablet in
 * landscape is wide enough for the `lg` breakpoint and still cannot use it.
 * Sizing stays with Tailwind's breakpoints; capability is asked for directly.
 *
 * `useSyncExternalStore` rather than useState-plus-useEffect: a media query is
 * exactly the external mutable source this hook exists for. It also keeps the
 * value correct across a change — a Surface switching between tablet and
 * laptop mode flips this without a reload — without writing state from an
 * effect, which tears under concurrent rendering.
 */

const QUERY = '(pointer: coarse)';

function subscribe(onStoreChange: () => void) {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const mediaQuery = window.matchMedia(QUERY);
  mediaQuery.addEventListener('change', onStoreChange);
  return () => mediaQuery.removeEventListener('change', onStoreChange);
}

function getSnapshot() {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia(QUERY).matches;
}

/** The scene is client-only, but this keeps the hook safe anywhere. */
function getServerSnapshot() {
  return false;
}

export function useCoarsePointer(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
