'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Copy, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { toast } from '@/components/ui/Toast';

/** Small shared pieces of Settings > Updates. */

/** A button-styled link to GitHub or the preview, opening in a new tab. */
export function ExternalButton({
  href,
  children,
  variant = 'secondary',
}: {
  href: string;
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'ghost';
}) {
  return (
    <Button href={href} target="_blank" rel="noopener noreferrer" size="sm" variant={variant}
      icon={<ExternalLink size={13} aria-hidden="true" />}>
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </Button>
  );
}

/** A plain text link opening in a new tab. */
export function ExternalLinkText({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer"
      className="inline-flex items-center gap-1 rounded text-brand-300 underline underline-offset-2 hover:decoration-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
      {children}
      <ExternalLink size={11} aria-hidden="true" className="flex-shrink-0" />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

/** An environment variable or command, in mono, with a copy button for its text. */
export function CopyCode({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast('error', 'Couldn\'t copy. Select the name and copy it by hand.');
    }
  };

  return (
    <span className="inline-flex max-w-full items-center gap-0.5 rounded-md bg-white/[0.06] py-0.5 pl-2 pr-0.5 align-middle">
      <code className="min-w-0 truncate font-mono text-xs text-zinc-100">{text}</code>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={copied ? `Copied ${text}` : `Copy ${text}`}
        className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-zinc-400 transition-colors hover:bg-white/[0.08] hover:text-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        {copied ? <Check size={12} className="text-emerald-300" aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
      </button>
    </span>
  );
}

/** A quiet section label inside a card. */
export function Label({ children, id }: { children: ReactNode; id?: string }) {
  return <h3 id={id} className="text-xs font-medium uppercase tracking-wide text-zinc-400">{children}</h3>;
}

/** Inline mono for versions, repos and file paths. */
export function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono text-[0.92em] text-zinc-100">{children}</span>;
}
