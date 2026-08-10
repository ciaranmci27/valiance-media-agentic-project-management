'use client';

import { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react';
import Link from 'next/link';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

type SharedProps = {
  variant?: Variant;
  size?: Size;
  children: ReactNode;
  icon?: ReactNode;
  className?: string;
};

/**
 * Two shapes, one look.
 *
 * Without `href` this is a `<button>`, exactly as before. With `href` it
 * renders a Next `<Link>` instead — same classes, same icon slot, so a link
 * that looks like a button IS a link.
 *
 * That distinction is not pedantry here. The pattern this replaced was a
 * `<button>` with `onClick={() => router.push(...)}`, which looks identical and
 * navigates fine on a plain click, but silently drops everything a browser
 * gives you for free on an anchor: cmd/ctrl-click and middle-click to open in a
 * new tab, "Open in new tab" in the context menu, the status-bar URL preview,
 * and the correct role announced to a screen reader. The live floor is
 * documented as something you leave open on a second screen, so opening it in a
 * new tab is a thing people will actually try.
 *
 * A discriminated union rather than one loose interface, so `href` and
 * button-only props like `type` or `disabled` cannot be passed together.
 */
type ButtonAsButton = SharedProps &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, keyof SharedProps> & { href?: never };

type ButtonAsLink = SharedProps &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, keyof SharedProps | 'href'> & { href: string };

type ButtonProps = ButtonAsButton | ButtonAsLink;

const BASE =
  'inline-flex items-center justify-center font-medium rounded-lg transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)] disabled:opacity-50 disabled:cursor-not-allowed';

const VARIANTS: Record<Variant, string> = {
  primary: 'liquid-primary focus-visible:ring-brand-500',
  secondary: 'liquid-glass focus-visible:ring-white/25',
  ghost: 'text-zinc-300 hover:bg-white/[0.06] hover:text-white focus-visible:ring-white/20',
  danger:
    'bg-red-600/90 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.25)] hover:bg-red-600 hover:shadow-[0_0_20px_-6px_rgba(239,68,68,0.55)] focus-visible:ring-red-500',
};

const SIZES: Record<Size, string> = {
  sm: 'text-xs px-2.5 py-1.5 gap-1.5',
  md: 'text-sm px-4 py-2 gap-2',
  lg: 'text-base px-6 py-2.5 gap-2',
};

export function Button({
  variant = 'primary',
  size = 'md',
  children,
  icon,
  className = '',
  ...rest
}: ButtonProps) {
  const classes = `${BASE} ${VARIANTS[variant]} ${SIZES[size]} ${className}`;
  const content = (
    <>
      {icon && <span className="flex-shrink-0">{icon}</span>}
      {children}
    </>
  );

  // `rest` carries whatever the caller passed through — onClick, aria-*,
  // data-*, type, disabled — and 41 files rely on that, so it is spread rather
  // than allow-listed. The cast is the narrowing TypeScript cannot do through
  // a rest element: the union already guarantees href and the button-only
  // props are mutually exclusive at every call site.
  if (rest.href !== undefined) {
    const { href, ...anchor } = rest;
    return (
      <Link href={href} className={classes} {...(anchor as AnchorHTMLAttributes<HTMLAnchorElement>)}>
        {content}
      </Link>
    );
  }

  return (
    <button className={classes} {...(rest as ButtonHTMLAttributes<HTMLButtonElement>)}>
      {content}
    </button>
  );
}
