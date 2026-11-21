'use client';

import { useEffect, useState, type AnimationEvent } from 'react';
import { useBrand } from '@/lib/brand/context';

/** How long each status line stays before the next one takes over. */
export const LOADER_STEP_MS = 700;

// The orbit around the mark: a hairline track and a quarter turn of brand light.
const ORBIT = 120;
const ORBIT_R = 56;
const ORBIT_C = 2 * Math.PI * ORBIT_R;
const ARC = ORBIT_C / 4;

/** Walks a status sequence one line at a time and stops on the last one. */
function useStepIndex(count: number) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (index >= count - 1) return;
    const timer = window.setTimeout(() => setIndex((i) => Math.min(i + 1, count - 1)), LOADER_STEP_MS);
    return () => window.clearTimeout(timer);
  }, [index, count]);
  return index;
}

/**
 * The one loading screen, shared by the app shell and the client portal.
 *
 * The workspace's logo inside the orbit (the dark or light one, following the
 * nearest `data-theme`; the name as text when none is uploaded), a hairline
 * orbit with a quarter turn of brand light going round, and a status line beneath that narrates what is coming up, one
 * short line at a time. The orbit is the only indicator; the words carry no
 * dots or spinner of their own.
 *
 * The line advances on a timer by default; a host that knows which phase is
 * really running passes `step` and the line follows that instead.
 *
 * `leaving` dissolves the stage, and `onLeft` fires once that dissolve has
 * finished playing, for hosts that hand off to their content in phases.
 * Styles live in globals.css under "Brand loader".
 */
export function BrandLoader({
  steps,
  announcement,
  step: controlledStep,
  leaving = false,
  onLeft,
  className = '',
}: {
  /** The lines the status reads, in order; the last one holds. */
  steps: readonly string[];
  /** The one thing a screen reader hears, instead of every line. */
  announcement: string;
  /** Which line to show, when the host tracks the real phase; omit to advance on a timer. */
  step?: number;
  leaving?: boolean;
  onLeft?: () => void;
  className?: string;
}) {
  const brand = useBrand();
  const timedStep = useStepIndex(steps.length);
  // A logo that fails to load gives way to the name, like having none.
  const [failed, setFailed] = useState<readonly string[]>([]);
  // The square mark (the favicon) fits the round splash best; a wide logo
  // shrinks to an unreadable strip inside it, so it is the fallback.
  const markSrc = brand.logos.favicon && !failed.includes(brand.logos.favicon) ? brand.logos.favicon : null;
  const darkSrc = brand.logos.dark && !failed.includes(brand.logos.dark) ? brand.logos.dark : null;
  const lightSrc = brand.logos.light && !failed.includes(brand.logos.light) ? brand.logos.light : null;
  const markFailed = (src: string) => () => setFailed((list) => [...list, src]);
  const step = controlledStep === undefined
    ? timedStep
    : Math.min(Math.max(controlledStep, 0), steps.length - 1);

  // Every animation inside the stage bubbles its end up here; only the
  // stage's own dissolve means the loader is gone.
  const handleAnimationEnd = (event: AnimationEvent<HTMLDivElement>) => {
    if (leaving && event.target === event.currentTarget) onLeft?.();
  };

  return (
    <div className={`brand-loader ${leaving ? 'is-leaving' : ''} ${className}`.trim()}>
      <div className="brand-loader-stage" onAnimationEnd={handleAnimationEnd}>
        <div className="brand-splash">
          <svg className="brand-splash-orbit" viewBox={`0 0 ${ORBIT} ${ORBIT}`} aria-hidden="true">
            <circle className="brand-splash-track" cx={ORBIT / 2} cy={ORBIT / 2} r={ORBIT_R} />
            <circle
              className="brand-splash-arc"
              cx={ORBIT / 2}
              cy={ORBIT / 2}
              r={ORBIT_R}
              strokeDasharray={`${ARC} ${ORBIT_C - ARC}`}
            />
          </svg>
          {/* The uploaded favicon when there is one, in both themes. Otherwise
              both logos are rendered and the theme shows one, so a theme
              change never swaps an image mid-load; a theme with no logo shows
              the name in its place. */}
          <span className="brand-splash-mark">
            {markSrc ? (
              // eslint-disable-next-line @next/next/no-img-element -- an uploaded file of any size, served from storage
              <img src={markSrc} alt={brand.name} className="brand-splash-mark-img is-mark" onError={markFailed(markSrc)} />
            ) : (
              <>
                {darkSrc ? (
                  // eslint-disable-next-line @next/next/no-img-element -- an uploaded file of any size, served from storage
                  <img src={darkSrc} alt={brand.name} className="brand-splash-mark-img is-dark" onError={markFailed(darkSrc)} />
                ) : (
                  <span className="brand-splash-mark-name is-dark">{brand.name}</span>
                )}
                {lightSrc ? (
                  // eslint-disable-next-line @next/next/no-img-element -- an uploaded file of any size, served from storage
                  <img src={lightSrc} alt={brand.name} className="brand-splash-mark-img is-light" onError={markFailed(lightSrc)} />
                ) : (
                  <span className="brand-splash-mark-name is-light">{brand.name}</span>
                )}
              </>
            )}
          </span>
        </div>

        {/* The outgoing and incoming lines share one grid cell, so the swap
            moves nothing: the old line lifts out as the new one rises in. */}
        <div className="brand-loader-steps" aria-hidden="true">
          {step > 0 && (
            <span key={`out-${step - 1}`} className="brand-step brand-step-out">{steps[step - 1]}</span>
          )}
          <span key={`in-${step}`} className="brand-step brand-step-in">{steps[step]}</span>
        </div>
        <p role="status" className="sr-only">{announcement}</p>
      </div>
    </div>
  );
}
