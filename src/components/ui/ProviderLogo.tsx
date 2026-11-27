import { AlertTriangle, Check, Clock } from 'lucide-react';
import { LOGO_MARKS } from '@/components/ui/logos/marks';
import { LOGOS, logoAccessibleName, logoInitials, logoLabel, resolveLogo, type LogoBadge } from '@/lib/logos';

/**
 * A provider's real logo from the logo bank (DESIGN.md Rule 20), never a
 * generic icon: chat apps, Google, Claude, ChatGPT, GitHub, email and
 * hosting providers (the list is LOGO_IDS in src/lib/logos.ts). Brand marks
 * keep their own colors; a black or white mark (GitHub, OpenAI, Vercel) is
 * drawn in the theme's ink on a subtle tile, so every mark reads in light
 * and dark. A provider the bank lacks gets a neutral initials tile.
 *
 * `badge` puts the state in the bottom right corner: a check for connected
 * or done, a clock for waiting, a warning for a problem; it is part of the
 * accessible name ("Telegram, connected"). `tile` sets the mark on a quiet
 * rounded tile, for rows and cards. With a visible name beside it, pass
 * `decorative` so a screen reader does not hear the name twice.
 */

/** Sizes on the type scale: sm beside text-sm, md beside text-base, lg in rows, xl to lead a page. */
const SIZES = { xs: 12, sm: 16, md: 20, lg: 24, xl: 40 } as const;
export type LogoSize = keyof typeof SIZES;

const BADGE: Record<LogoBadge, { icon: typeof Check; className: string }> = {
  done: { icon: Check, className: 'bg-emerald-500' },
  waiting: { icon: Clock, className: 'bg-amber-500' },
  problem: { icon: AlertTriangle, className: 'bg-red-500' },
};

export function ProviderLogo({ provider, size = 'md', badge = null, tile = false, decorative = false, label, className = '' }: {
  /** A bank id or any name the app stores for it ("chatgpt", "claude_code", "custom.mattermost"). */
  provider: string;
  /** A size on the scale, or pixels for the mark itself. */
  size?: LogoSize | number;
  badge?: LogoBadge | null;
  /** A quiet rounded tile behind the mark (always on for ink marks and the initials fallback). */
  tile?: boolean;
  /** Hidden from screen readers: a visible name sits beside it. */
  decorative?: boolean;
  /** The name to read, when the app calls the provider something else. */
  label?: string;
  className?: string;
}) {
  const px = typeof size === 'number' ? size : SIZES[size];
  const known = resolveLogo(provider);
  const name = label ?? (known ? known.label : logoLabel(provider));
  const mark = known ? LOGO_MARKS[known.id] : null;
  const ink = known ? LOGOS[known.id].tone === 'ink' : true;
  const tiled = tile || ink;
  // The tile is a little larger than the mark; an untiled mark is its own box.
  const box = tiled ? Math.round(px * 1.6) : px;
  const a11y = decorative
    ? { 'aria-hidden': true as const }
    : { role: 'img' as const, 'aria-label': logoAccessibleName(name, badge) };

  const glyph = mark ? (
    <svg width={px} height={px} viewBox={mark.viewBox} aria-hidden="true" focusable="false" className={ink ? 'text-white' : undefined}>
      {mark.paths.map((path, index) => <path key={index} d={path.d} fill={path.fill ?? 'currentColor'} />)}
    </svg>
  ) : (
    <span aria-hidden="true" className="font-semibold leading-none text-zinc-300" style={{ fontSize: Math.max(9, Math.round(px * 0.55)) }}>
      {logoInitials(provider)}
    </span>
  );

  const badgePx = Math.max(10, Math.round(box * 0.42));
  const Badge = badge ? BADGE[badge] : null;

  return (
    <span {...a11y} className={`relative inline-flex flex-shrink-0 ${className}`} style={{ width: box, height: box }}>
      {tiled ? (
        <span className="flex h-full w-full items-center justify-center bg-white/[0.06] ring-1 ring-inset ring-white/[0.06]" style={{ borderRadius: Math.max(4, Math.round(box * 0.28)) }}>
          {glyph}
        </span>
      ) : glyph}
      {Badge && (
        <span
          aria-hidden="true"
          className={`absolute flex items-center justify-center rounded-full text-on-accent ring-2 ring-surface-raised ${Badge.className}`}
          style={{ width: badgePx, height: badgePx, right: -Math.round(badgePx * 0.25), bottom: -Math.round(badgePx * 0.25) }}
        >
          <Badge.icon size={Math.round(badgePx * 0.62)} strokeWidth={3} />
        </span>
      )}
    </span>
  );
}
