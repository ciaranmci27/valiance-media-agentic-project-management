'use client';

import { avatarTone, initialsOf } from '@/lib/agents-ui';

/**
 * The one face for a person or an agent (DESIGN.md Rule 11): their picture,
 * or their initials on one of the eight avatar tone tokens. The tone and the
 * initials come from one function (avatarFace), shared with AgentAvatar, so
 * Atlas wears the same tone and the same "AT" on Agents, Team, a project's
 * Overview and Analytics. The name picks the tone (every caller has it, and
 * an agent's hire preview keeps the tone it is hired with); the id is the
 * fallback for a record without a name.
 */

interface AvatarProps {
  name: string;
  src?: string;
  /** A stable id; used for the tone only when the name is empty. */
  id?: string;
  /** One of the eight tones, when a person chose it (their assistant); left out, the name picks it. */
  tone?: number | null;
  /** Legacy: a raw background color. Prefer the tones. */
  color?: string;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  className?: string;
}

const sizeClasses = {
  xs: 'w-5 h-5 text-[9px]',
  sm: 'w-6 h-6 text-[11px]',
  md: 'w-8 h-8 text-sm',
  lg: 'w-10 h-10 text-base',
};

/** Static class names, so Tailwind sees every tone (one per --color-avatar-N token). */
export const AVATAR_TONE_BG = ['', 'bg-avatar-1', 'bg-avatar-2', 'bg-avatar-3', 'bg-avatar-4', 'bg-avatar-5', 'bg-avatar-6', 'bg-avatar-7', 'bg-avatar-8'] as const;

/** The tone number (1 to 8) and initials for a face. One source for Avatar and AgentAvatar. */
export function avatarFace(name: string, id?: string | null, tone?: number | null): { tone: number; initials: string; toneClass: string } {
  const picked = tone && tone >= 1 && tone <= 8 ? tone : avatarTone(name.trim().toLowerCase() || id || '?');
  return { tone: picked, initials: initialsOf(name), toneClass: AVATAR_TONE_BG[picked] };
}

/** A picture link the app can show (uploaded, relative or a local preview). */
export function avatarPicture(src: string | null | undefined): string | null {
  return src && /^(https?:|\/|blob:)/.test(src) ? src : null;
}

export function Avatar({ name, src, id, tone, color, size = 'md', className = '' }: AvatarProps) {
  const picture = avatarPicture(src);

  if (picture) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- avatars are arbitrary uploaded links
      <img
        src={picture}
        alt={name}
        className={`${sizeClasses[size]} flex-shrink-0 rounded-full object-cover ${className}`}
      />
    );
  }

  const face = avatarFace(name, id, tone);
  return (
    <div
      className={`${sizeClasses[size]} flex flex-shrink-0 select-none items-center justify-center rounded-full font-semibold tracking-tight text-white ${color ? '' : face.toneClass} ${className}`}
      style={color ? { backgroundColor: color } : undefined}
    >
      {face.initials}
    </div>
  );
}

// Avatar group for multiple users
interface AvatarGroupProps {
  users: { id: string; name: string; avatar?: string }[];
  max?: number;
  size?: 'xs' | 'sm' | 'md' | 'lg';
}

export function AvatarGroup({ users, max = 4, size = 'sm' }: AvatarGroupProps) {
  const visible = users.slice(0, max);
  const remaining = users.length - max;

  // Rings exist ONLY to separate overlapping circles; a single avatar has
  // nothing to separate from, and ringing it paints a black border that is not
  // in the design language. When separation is needed, the raised-surface
  // token sits close to every card background (and follows the theme), where
  // page-base near-black read as an outline on anything lighter than the page.
  const overlapping = visible.length + (remaining > 0 ? 1 : 0) > 1;
  const separation = overlapping ? 'ring-2 ring-surface-raised' : '';

  return (
    <div className="flex -space-x-2">
      {visible.map((user) => (
        <Avatar
          key={user.id}
          id={user.id}
          name={user.name}
          src={user.avatar}
          size={size}
          className={separation}
        />
      ))}
      {remaining > 0 && (
        <div
          className={`${sizeClasses[size]} rounded-full flex items-center justify-center font-medium bg-white/10 text-zinc-300 ${separation}`}
        >
          +{remaining}
        </div>
      )}
    </div>
  );
}
