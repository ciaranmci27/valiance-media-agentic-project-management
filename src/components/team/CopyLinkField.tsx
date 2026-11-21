'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/Button';

/**
 * An invite link to pass on by hand: the link in a read-only field (click
 * selects it all) and a Copy button that says Copied for a moment. When the
 * clipboard is blocked, the selected text is there to copy by keyboard.
 */
export function CopyLinkField({ link, label = 'Invite link', className = '' }: { link: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const copy = async () => {
    input.current?.select();
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Blocked: the link stays selected for Ctrl+C.
    }
  };

  return (
    <div className={`flex items-center gap-1.5 ${className}`}>
      <input
        ref={input}
        readOnly
        value={link}
        aria-label={label}
        onFocus={(event) => event.currentTarget.select()}
        className="min-w-0 flex-1 rounded-[var(--radius-input-sm)] bg-white/[0.04] px-2.5 py-1.5 font-mono text-[11px] text-zinc-300 ring-1 ring-inset ring-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      />
      <Button
        type="button"
        size="sm"
        variant="secondary"
        onClick={() => { void copy(); }}
        icon={copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
      >
        <span aria-live="polite">{copied ? 'Copied' : 'Copy'}</span>
      </Button>
    </div>
  );
}
