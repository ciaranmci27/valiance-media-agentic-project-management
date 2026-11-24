'use client';

import { avatarTone, initialsOf, PRESENCE_LABELS, type Presence } from '@/lib/agents-ui';

/**
 * An agent's face, with presence: initials on its own tone (one of the
 * avatar tone tokens, picked from its name so the hire flow's preview wears
 * the tone the agent keeps) or its picture, and a status dot. A working
 * agent's ring breathes softly; reduced motion keeps the ring still. The
 * dot's colours are the one agent vocabulary (lib/agent-status MOOD_STYLE):
 * emerald producing, amber ready and waiting, red needs a person.
 */

const SIZES = {
  xs: { box: 'h-5 w-5 text-[9px]', dot: 'h-1.5 w-1.5 ring-1' },
  sm: { box: 'h-7 w-7 text-[11px]', dot: 'h-2 w-2 ring-[1.5px]' },
  md: { box: 'h-10 w-10 text-sm', dot: 'h-2.5 w-2.5 ring-2' },
  lg: { box: 'h-14 w-14 text-lg', dot: 'h-3 w-3 ring-2' },
  xl: { box: 'h-[72px] w-[72px] text-2xl', dot: 'h-4 w-4 ring-[3px]' },
} as const;

/** Static class names, so Tailwind sees every tone (one per --color-avatar-N token). */
const TONE_BG = ['', 'bg-avatar-1', 'bg-avatar-2', 'bg-avatar-3', 'bg-avatar-4', 'bg-avatar-5', 'bg-avatar-6', 'bg-avatar-7', 'bg-avatar-8'];

/** Text colour for each presence, read by the dot (bg-current) and the breathing ring (currentColor). */
export const PRESENCE_TEXT: Record<Presence, string> = {
  working: 'text-emerald-400',
  reviewing: 'text-emerald-400',
  shipped: 'text-emerald-300',
  idle: 'text-amber-300',
  blocked: 'text-red-500',
  offline: 'text-red-600',
  suspended: 'text-zinc-500',
  paused: 'text-zinc-500',
};

/** The name decides the tone; an unnamed avatar falls back to its id. */
const toneKey = (name: string, id: string) => name.trim().toLowerCase() || id;

const LIVE: ReadonlySet<Presence> = new Set(['working', 'reviewing']);

export function AgentAvatar({ id, name, src, presence, size = 'md', label, className = '' }: {
  id: string;
  name: string;
  src?: string | null;
  /** Leave out for an avatar without a status (a picker row). */
  presence?: Presence | null;
  size?: keyof typeof SIZES;
  /** The status in words for screen readers; defaults to the presence label. */
  label?: string;
  className?: string;
}) {
  const s = SIZES[size];
  const picture = src && /^(https?:|\/|blob:)/.test(src) ? src : null;
  const live = !!presence && LIVE.has(presence);
  const off = presence === 'suspended' || presence === 'paused';
  return (
    <span className={`relative inline-flex h-fit w-fit flex-none self-start ${className}`}>
      <span
        className={`${s.box} ${presence ? PRESENCE_TEXT[presence] : ''} ${live ? 'presence-breathe' : ''} inline-flex items-center justify-center overflow-hidden rounded-full font-semibold tracking-tight select-none ${off ? 'opacity-60 grayscale' : ''}`}
        aria-hidden="true"
      >
        {picture ? (
          // eslint-disable-next-line @next/next/no-img-element -- agent pictures are arbitrary https links
          <img src={picture} alt="" className="h-full w-full object-cover" />
        ) : (
          <span className={`flex h-full w-full items-center justify-center text-white ${TONE_BG[avatarTone(toneKey(name, id))]}`}>{initialsOf(name)}</span>
        )}
      </span>
      {presence && (
        <span
          role="img"
          aria-label={label ?? PRESENCE_LABELS[presence]}
          className={`absolute -bottom-0.5 -right-0.5 ${s.dot} rounded-full bg-current ring-surface-raised ${PRESENCE_TEXT[presence]}`}
        />
      )}
    </span>
  );
}

/** The status word beside a dot, for rows and headers. */
export function PresencePill({ presence, children }: { presence: Presence; children?: React.ReactNode }) {
  const live = LIVE.has(presence);
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.05] px-2 py-0.5 text-[11px] font-medium text-zinc-200">
      <span className={`relative flex h-1.5 w-1.5 ${PRESENCE_TEXT[presence]}`} aria-hidden="true">
        {live && <span className="absolute inline-flex h-full w-full rounded-full bg-current opacity-60 motion-safe:animate-ping" />}
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
      </span>
      {children ?? PRESENCE_LABELS[presence]}
    </span>
  );
}

/** Up to three small faces of the people who own an agent, then a count. */
export function OwnerStack({ owners, max = 3 }: { owners: { id: string; name: string; avatar_url?: string | null }[]; max?: number }) {
  if (owners.length === 0) return null;
  const shown = owners.slice(0, max);
  const more = owners.length - shown.length;
  return (
    <span className="inline-flex items-center" aria-label={`Owned by ${owners.map((o) => o.name).join(', ')}`} role="img">
      <span className="flex -space-x-1.5">
        {shown.map((o) => (
          <AgentAvatar key={o.id} id={o.id} name={o.name} src={o.avatar_url} size="xs" className="rounded-full ring-2 ring-surface-raised" />
        ))}
      </span>
      {more > 0 && <span className="ml-1 text-[11px] tabular-nums text-zinc-400">+{more}</span>}
    </span>
  );
}
