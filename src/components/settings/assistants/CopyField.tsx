'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

/** Copies a value and says so in place. */
export function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-zinc-400">{label}</p>
      <div className="flex items-center gap-2 rounded-lg bg-white/[0.04] px-3 py-2">
        <code className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-200">{value}</code>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
          }}
          className="flex-shrink-0 rounded-md p-1 text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          aria-label={`Copy ${label}`}
        >
          {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
        </button>
      </div>
    </div>
  );
}
