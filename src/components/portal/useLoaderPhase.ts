'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/** The loader stays up at least this long, so a fast response never flashes it. */
const DEFAULT_MIN_SHOW_MS = 1100;
/**
 * The dissolve reports its own end (see `onLeft`); this only steps in if the
 * event never comes, for instance in a background tab where the animation is
 * not being played. Longer than .brand-loader-out so it never cuts it short.
 */
const EXIT_FALLBACK_MS = 1000;

export type LoaderPhase = 'loading' | 'leaving' | 'done';

/**
 * Turns a `loading` flag into the three moments a loading screen actually
 * has: on screen, leaving, gone. The page renders the loader for the first
 * two (passing `leaving` so it can dissolve, and `onLeft` so it can say when
 * the dissolve has finished) and its real content only for `done`. Arrival
 * then reads as one choreographed hand-off rather than a cut from a
 * half-drawn loader to a page fading in from nothing.
 *
 * `minShowMs` is how long the loader is held even when the data is quick; a
 * loader that narrates a sequence passes the time its lines need to be read.
 */
export function useLoaderPhase(
  loading: boolean,
  minShowMs = DEFAULT_MIN_SHOW_MS,
): { phase: LoaderPhase; onLeft: () => void } {
  // The later phases are reached once `loading` clears. A hook that starts
  // out not loading was never shown, so it is done from the start.
  const [settled, setSettled] = useState<Exclude<LoaderPhase, 'loading'> | null>(loading ? null : 'done');
  const [wasLoading, setWasLoading] = useState(loading);
  const shownAt = useRef(0);

  // A fresh load after the first one starts the sequence over.
  if (loading !== wasLoading) {
    setWasLoading(loading);
    if (loading) setSettled(null);
  }

  useEffect(() => {
    if (loading) {
      shownAt.current = performance.now();
      return;
    }
    // Never shown: nothing to hold or dissolve.
    if (shownAt.current === 0) return;
    const hold = Math.max(0, minShowMs - (performance.now() - shownAt.current));
    const leave = window.setTimeout(() => setSettled('leaving'), hold);
    const fallback = window.setTimeout(() => setSettled('done'), hold + EXIT_FALLBACK_MS);
    return () => {
      window.clearTimeout(leave);
      window.clearTimeout(fallback);
    };
  }, [loading, minShowMs]);

  /** The loader's dissolve has finished playing. */
  const onLeft = useCallback(() => {
    setSettled((current) => (current === 'leaving' ? 'done' : current));
  }, []);

  return { phase: loading ? 'loading' : settled ?? 'loading', onLeft };
}
