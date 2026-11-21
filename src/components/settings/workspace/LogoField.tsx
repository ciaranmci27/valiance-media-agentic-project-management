'use client';

import { useId, useRef, useState, type DragEvent } from 'react';
import { Loader2, Trash2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import type { LogoKind } from '@/lib/brand';
import { OutcomeLine, type Outcome } from './OutcomeLine';
import { LOGO_ACCEPT, faviconLetter, logoRule } from './brand-settings';
import { PAPER, PAPER_INK } from './brand-paper';

/**
 * One brand file: a drop zone with a thumbnail on the background it will sit
 * on, Choose file or Replace, Remove, the format and size line, and whatever
 * the last upload or removal left (an error, or a line with Undo). Uploads
 * save on their own at once, so the parent owns the request; this owns the
 * dragging, the picker and the look.
 */
export function LogoField({
  kind,
  label,
  usage,
  url,
  fallbackUrl = null,
  emptyNote,
  fallbackNote,
  name,
  brand600,
  invert = false,
  busy = false,
  error = null,
  outcome = null,
  disabled = false,
  onFile,
  onRemove,
}: {
  kind: LogoKind;
  label: string;
  /** Where it shows, in one line. */
  usage: string;
  url: string | null;
  /** Shown faintly while nothing is uploaded (the dark logo falls back to the light one). */
  fallbackUrl?: string | null;
  /** What shows while nothing is uploaded. */
  emptyNote: string;
  /** What shows while the fallback is used. */
  fallbackNote?: string;
  /** For the empty states: the name as text, the generated favicon's letter. */
  name: string;
  brand600: string;
  invert?: boolean;
  busy?: boolean;
  error?: string | null;
  outcome?: Outcome | null;
  disabled?: boolean;
  onFile: (file: File) => void;
  onRemove: () => void;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  // dragenter and dragleave fire for every child crossed: count them.
  const depth = useRef(0);
  const locked = disabled || busy;

  const take = (files: FileList | null) => {
    const file = files?.[0];
    if (file && !locked) onFile(file);
  };

  const dragProps = {
    onDragEnter: (event: DragEvent) => {
      if (locked || !event.dataTransfer.types.includes('Files')) return;
      event.preventDefault();
      depth.current += 1;
      setDragging(true);
    },
    onDragOver: (event: DragEvent) => {
      if (locked || !event.dataTransfer.types.includes('Files')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: () => {
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    },
    onDrop: (event: DragEvent) => {
      event.preventDefault();
      depth.current = 0;
      setDragging(false);
      take(event.dataTransfer.files);
    },
  };

  const shown = url ?? fallbackUrl;
  const status = busy
    ? 'Uploading...'
    : dragging
      ? 'Drop to upload'
      : url
        ? 'Uploaded'
        : fallbackUrl && fallbackNote
          ? fallbackNote
          : emptyNote;

  return (
    <div role="group" aria-labelledby={`${id}-label`} aria-describedby={`${id}-usage ${id}-rule`}>
      <p id={`${id}-label`} className="text-sm font-medium text-input-text-label">{label}</p>
      <p id={`${id}-usage`} className="mt-0.5 text-xs text-zinc-400">{usage}</p>

      <div
        {...dragProps}
        className={`mt-2.5 flex items-center gap-4 rounded-xl border p-3 transition-colors duration-150 motion-reduce:transition-none ${
          dragging
            ? 'border-brand-500/50 bg-brand-500/[0.08]'
            : url
              ? 'border-white/[0.06] bg-white/[0.03]'
              : 'border-dashed border-white/[0.14] bg-white/[0.02]'
        }`}
      >
        <Thumb kind={kind} src={shown} faint={!url && !!fallbackUrl} name={name} brand600={brand600} invert={invert} busy={busy} />

        <div className="min-w-0 flex-1">
          <p className="text-sm leading-snug text-zinc-200" aria-live="polite">{status}</p>
          <p id={`${id}-rule`} className="mt-0.5 text-[11px] text-zinc-400">{logoRule(kind)}</p>
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={locked}
              onClick={() => input.current?.click()}
              icon={<Upload size={12} aria-hidden="true" />}
              aria-label={`${url ? 'Replace' : 'Choose'} ${label.toLowerCase()}`}
            >
              {url ? 'Replace' : 'Choose file'}
            </Button>
            {url && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={locked}
                onClick={onRemove}
                icon={<Trash2 size={12} aria-hidden="true" />}
                aria-label={`Remove ${label.toLowerCase()}`}
              >
                Remove
              </Button>
            )}
            {!url && !locked && <span className="hidden text-[11px] text-zinc-400 sm:inline">or drop it here</span>}
          </div>
        </div>

        <input
          ref={input}
          type="file"
          accept={LOGO_ACCEPT[kind]}
          tabIndex={-1}
          aria-hidden="true"
          className="sr-only"
          onChange={(event) => {
            take(event.target.files);
            // The same file chosen again should still upload.
            event.target.value = '';
          }}
        />
      </div>

      {error && <OutcomeLine outcome={{ tone: 'error', text: error }} className="mt-2" />}
      {!error && outcome && <OutcomeLine outcome={outcome} busy={busy} className="mt-2" />}
    </div>
  );
}

/** The file on the background it will sit on: paper for light, the sidebar's dark for dark, a tab-sized square for the favicon. */
function Thumb({ kind, src, faint, name, brand600, invert, busy }: {
  kind: LogoKind;
  src: string | null;
  faint: boolean;
  name: string;
  brand600: string;
  invert: boolean;
  busy: boolean;
}) {
  const spinner = busy && (
    <span className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/40">
      <Loader2 size={16} className="animate-spin text-white motion-reduce:animate-none" aria-hidden="true" />
    </span>
  );

  if (kind === 'favicon') {
    return (
      <span aria-hidden="true" className="relative flex h-16 w-16 flex-shrink-0 items-center justify-center rounded-lg bg-white/[0.04] ring-1 ring-inset ring-white/[0.06]">
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element -- a user upload on another host, shown as is
          <img src={src} alt="" className="h-8 w-8 object-contain" />
        ) : (
          <span
            className="flex h-8 w-8 items-center justify-center text-lg font-bold leading-none text-white"
            // The same square the generated favicon draws: the letter on brand 600, corners at 22%.
            style={{ background: brand600, borderRadius: '22%' }}
          >
            {faviconLetter(name)}
          </span>
        )}
        {spinner}
      </span>
    );
  }

  const dark = kind === 'dark';
  return (
    <span
      aria-hidden="true"
      data-theme={dark ? 'dark' : undefined}
      className={`relative flex h-16 w-28 flex-shrink-0 items-center justify-center overflow-hidden rounded-lg px-3 ring-1 ring-inset sm:w-36 ${dark ? 'bg-surface ring-white/[0.08]' : 'ring-black/[0.06]'}`}
      style={dark ? undefined : { background: PAPER }}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element -- a user upload on another host, shown as is
        <img src={src} alt="" className={`max-h-9 max-w-full object-contain ${faint ? 'opacity-60' : ''} ${dark && invert ? 'invert' : ''}`} />
      ) : (
        <span className={`truncate text-sm font-bold tracking-tight ${dark ? 'text-white' : ''}`} style={dark ? undefined : { color: PAPER_INK }}>
          {name}
        </span>
      )}
      {spinner}
    </span>
  );
}
