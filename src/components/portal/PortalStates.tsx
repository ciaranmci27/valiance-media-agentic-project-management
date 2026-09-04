'use client';

import type { AnimationEvent, CSSProperties } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { DARK_LOGO_SRC, Logo } from '@/components/ui/Logo';
import { siteConfig } from '@/site-config';
import { PortalRoot } from './PortalShell';

// The orbit around the mark: a hairline track and a quarter turn of teal light.
const ORBIT = 120;
const ORBIT_R = 56;
const ORBIT_C = 2 * Math.PI * ORBIT_R;
const ARC = ORBIT_C / 4;

/**
 * Where the emblem sits in the dark lockup, in pixels of the 3443 x 820 file:
 * a circle of radius 397 centred at (403, 413.5). The crop is a slightly
 * larger circle so the ring's edge is never clipped, and round so the top of
 * the wordmark's first letter, which starts just past the ring, stays out.
 */
const MARK = { cx: 403, cy: 413.5, r: 402, fileHeight: 820 };
const MARK_D = MARK.r * 2;

/**
 * Our mark by itself, cropped out of the dark lockup so it is exactly the
 * emblem the page header shows, drawn for this canvas.
 */
function Emblem() {
  const style: CSSProperties = {
    height: `${(MARK.fileHeight / MARK_D) * 100}%`,
    left: `${(-(MARK.cx - MARK.r) / MARK_D) * 100}%`,
    top: `${(-(MARK.cy - MARK.r) / MARK_D) * 100}%`,
  };
  return (
    <span className="vm-splash-mark">
      {/* eslint-disable-next-line @next/next/no-img-element -- served by /api/logo so the brand can swap it */}
      <img src={DARK_LOGO_SRC} alt={siteConfig.name} className="absolute max-w-none" style={style} />
    </span>
  );
}

/**
 * Waiting for the portal payload.
 *
 * A splash built from the mark: the emblem on the bare canvas, a hairline
 * orbit around it with a quarter turn of teal light going round, and one
 * quiet line underneath. `leaving` dissolves the stage for the page,
 * and `onLeft` is called once that dissolve has finished playing.
 */
export function PortalLoading({
  leaving = false,
  onLeft,
  label = 'Preparing your portal',
}: {
  leaving?: boolean;
  onLeft?: () => void;
  label?: string;
}) {
  // Every animation inside the stage bubbles its end up here; only the
  // stage's own dissolve means the loader is gone.
  const handleAnimationEnd = (event: AnimationEvent<HTMLDivElement>) => {
    if (leaving && event.target === event.currentTarget) onLeft?.();
  };

  return (
    <PortalRoot>
      <main className={`vm-loader flex flex-1 items-center justify-center px-5 sm:px-8 ${leaving ? 'is-leaving' : ''}`}>
        <div className="vm-loader-stage flex flex-col items-center" onAnimationEnd={handleAnimationEnd}>
          <div className="vm-splash">
            <svg className="vm-splash-orbit" viewBox={`0 0 ${ORBIT} ${ORBIT}`} aria-hidden="true">
              <circle className="vm-splash-track" cx={ORBIT / 2} cy={ORBIT / 2} r={ORBIT_R} />
              <circle
                className="vm-splash-arc"
                cx={ORBIT / 2}
                cy={ORBIT / 2}
                r={ORBIT_R}
                strokeDasharray={`${ARC} ${ORBIT_C - ARC}`}
              />
            </svg>
            <Emblem />
          </div>
          {/* One quiet sentence. The orbit already says "loading", so the line
              carries no indicator of its own. */}
          <p role="status" className="vm-muted vm-fade mt-5 text-[15px]" style={{ '--d': '0.4s' } as CSSProperties}>
            {label}
          </p>
        </div>
      </main>
    </PortalRoot>
  );
}

/** Full-page: a centred card for a portal or file that cannot be shown. */
export function PortalError({
  title,
  message,
  backHref,
}: {
  title: string;
  message: string;
  /** When set, a "Back to portal" link follows the message. */
  backHref?: string;
}) {
  return (
    <PortalRoot>
      <main className="flex flex-1 items-center justify-center px-5 py-16 sm:px-8">
        <div className="vm-glass vm-card vm-rise w-full max-w-[26rem] p-8 sm:p-10">
          <Logo variant="dark" className="h-6 w-auto" />
          <h1 className="vm-h2 mt-8">{title}</h1>
          <p className="vm-muted mt-2.5 text-[15px] leading-relaxed">{message}</p>
          {backHref && (
            <Link href={backHref} className="vm-btn vm-btn-ghost vm-btn-sm mt-7">
              <ArrowLeft size={15} aria-hidden="true" />
              Back to portal
            </Link>
          )}
        </div>
      </main>
    </PortalRoot>
  );
}

/** Inside the shell: the portal is live but no section has anything to show. */
export function PortalEmpty() {
  return (
    <div className="vm-glass vm-card vm-rise p-8 text-center sm:p-12">
      <h2 className="vm-h2">Nothing here yet</h2>
      <p className="vm-muted mt-2.5 text-[15px]">Check back soon for updates.</p>
    </div>
  );
}
