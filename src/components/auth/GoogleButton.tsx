'use client';

import { Loader2 } from 'lucide-react';
import { ProviderLogo } from '@/components/ui/ProviderLogo';

/**
 * Google's "G" from the logo bank, in Google's own colors: their sign-in
 * branding asks for the mark unchanged.
 */
export function GoogleMark({ size = 18 }: { size?: number }) {
  return <ProviderLogo provider="google" size={size} decorative />;
}

/**
 * "Continue with Google", the same full-width height as the sign-in form's
 * own button so the two read as one pair. Busy while the browser hands over
 * to Google.
 */
export function GoogleButton({
  onClick,
  busy = false,
  disabled = false,
  label = 'Continue with Google',
  type = 'button',
}: {
  onClick?: () => void;
  busy?: boolean;
  disabled?: boolean;
  label?: string;
  type?: 'button' | 'submit';
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={busy || disabled}
      aria-busy={busy || undefined}
      className="liquid-glass flex w-full items-center justify-center gap-2.5 rounded-lg px-4 py-2.5 text-sm font-medium text-white transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white/25 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)] disabled:cursor-not-allowed disabled:opacity-50"
    >
      {busy ? <Loader2 size={16} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <GoogleMark />}
      {label}
    </button>
  );
}

/** The "or" between Google and the email form. */
export function OrDivider() {
  return (
    <div className="flex items-center gap-3 text-[11px] font-medium uppercase tracking-[0.12em] text-zinc-500" role="separator" aria-label="or">
      <span className="h-px flex-1 bg-white/[0.08]" aria-hidden="true" />
      or
      <span className="h-px flex-1 bg-white/[0.08]" aria-hidden="true" />
    </div>
  );
}
