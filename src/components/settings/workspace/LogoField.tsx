'use client';

import { useId, useRef, useState, type DragEvent } from 'react';
import { AlertTriangle, ArrowRightLeft, Loader2, Trash2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { logoKindShape, logoKindTheme, type LogoKind } from '@/lib/brand';
import { OutcomeLine, type Outcome } from './OutcomeLine';
import { LOGO_ACCEPT, faviconLetter, logoRule } from './brand-settings';
import { PAPER, PAPER_INK } from './brand-paper';
import { logoToneHint } from './logo-checks';
import { useLogoTone } from './logo-measure';

/** A file that belongs in another slot: the line that says so, and the button that puts it there. */
export interface LogoGuard {
  text: string;
  /** "Add it to Square", or null when no other slot fits it either. */
  actionLabel: string | null;
  onAction?: () => void;
}

/**
 * One brand file: a drop zone with a thumbnail on the background it will sit
 * on, Choose file or Replace, Remove, the format and size line, and whatever
 * the last upload or removal left (an error, or a line with Undo). Uploads
 * save on their own at once, so the parent owns the request; this owns the
 * dragging, the picker and the look. The preview is at the size the app uses
 * (the sidebar's logo height; a square at 32px and at tab size, 16px), and an
 * uploaded logo that may not show on its theme gets a soft hint.
 */
export function LogoField({
  kind,
  label,
  fullName,
  usage,
  url,
  fallbackUrl = null,
  cropUrl = null,
  emptyNote,
  fallbackNote,
  name,
  brand600,
  invert = false,
  busy = false,
  error = null,
  guard = null,
  outcome = null,
  disabled = false,
  onFile,
  onRemove,
}: {
  kind: LogoKind;
  label: string;
  /** The slot's whole name for buttons and screen readers ("Square logo, dark theme"); the label when left out. */
  fullName?: string;
  /** Where it shows, in one line. */
  usage: string;
  url: string | null;
  /** Shown faintly while nothing is uploaded (the dark logo falls back to the light one). */
  fallbackUrl?: string | null;
  /** A square slot with nothing to fall back on: the horizontal logo it is cropped from. */
  cropUrl?: string | null;
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
  /** The last file was the wrong shape for this slot. */
  guard?: LogoGuard | null;
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
  const slotName = (fullName ?? label).toLowerCase();
  const toneHint = logoToneHint(logoKindTheme(kind), useLogoTone(url));

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
  const cropping = !shown && !!cropUrl;
  const status = busy
    ? 'Uploading'
    : dragging
      ? 'Drop to upload'
      : url
        ? 'Uploaded'
        : (fallbackUrl || cropping) && fallbackNote
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
        <Thumb kind={kind} src={shown ?? cropUrl} crop={cropping} faint={!url && (!!fallbackUrl || cropping)} name={name} brand600={brand600} invert={invert} busy={busy} />

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
              aria-label={`${url ? 'Replace' : 'Choose'} ${slotName}`}
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
                aria-label={`Remove ${slotName}`}
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
      {!error && guard && (
        <div role="alert" className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-amber-500/[0.1] px-2.5 py-1.5 text-xs text-zinc-200">
          <AlertTriangle size={13} className="flex-shrink-0 text-amber-300" aria-hidden="true" />
          <span className="min-w-0 flex-1 basis-56 break-words">{guard.text}</span>
          {guard.actionLabel && guard.onAction && (
            <Button size="sm" variant="ghost" className="!rounded-md !px-2 !py-0.5" disabled={locked} onClick={guard.onAction}
              icon={<ArrowRightLeft size={12} aria-hidden="true" />}>
              {guard.actionLabel}
            </Button>
          )}
        </div>
      )}
      {!error && !guard && outcome && <OutcomeLine outcome={outcome} busy={busy} className="mt-2" />}
      {url && toneHint && !busy && (
        <p role="note" className="mt-2 flex items-start gap-2 rounded-lg bg-white/[0.04] px-2.5 py-1.5 text-xs text-zinc-300">
          <AlertTriangle size={13} className="mt-px flex-shrink-0 text-amber-300" aria-hidden="true" />
          <span className="min-w-0 flex-1">{toneHint}</span>
        </p>
      )}
    </div>
  );
}

/**
 * The file on the background it will sit on, at the size the app shows it:
 * paper for the light theme, the sidebar's dark for the dark theme. A
 * horizontal logo at the sidebar's height (36px); a square one at 32px and
 * at the browser tab's 16px. A square slot with nothing uploaded may show a
 * crop of the horizontal logo, as the tab icon makes one.
 */
function Thumb({ kind, src, crop, faint, name, brand600, invert, busy }: {
  kind: LogoKind;
  src: string | null;
  crop: boolean;
  faint: boolean;
  name: string;
  brand600: string;
  invert: boolean;
  busy: boolean;
}) {
  const dark = logoKindTheme(kind) === 'dark';
  const spinner = busy && (
    <span className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/40">
      <Loader2 size={16} className="animate-spin text-white motion-reduce:animate-none" aria-hidden="true" />
    </span>
  );
  const surface = dark ? 'bg-surface ring-white/[0.08]' : 'ring-black/[0.06]';
  const paper = dark ? undefined : { background: PAPER };

  if (logoKindShape(kind) === 'square') {
    const mark = (edge: 'h-8 w-8' | 'h-4 w-4', letterSize: string) => (src ? (
      <span className={`relative block flex-shrink-0 overflow-hidden ${edge} ${faint ? 'opacity-60' : ''}`}>
        {/* eslint-disable-next-line @next/next/no-img-element -- a user upload on another host, shown as is */}
        <img src={src} alt="" className={crop ? 'absolute left-0 top-0 h-full w-auto max-w-none' : 'h-full w-full object-contain'} />
      </span>
    ) : (
      <span
        className={`flex flex-shrink-0 items-center justify-center font-bold leading-none text-white ${edge} ${letterSize}`}
        // The same square the generated tab icon draws: the letter on brand 600, corners at 22%.
        style={{ background: brand600, borderRadius: '22%' }}
      >
        {faviconLetter(name)}
      </span>
    ));
    return (
      <span
        aria-hidden="true"
        data-theme={dark ? 'dark' : undefined}
        className={`relative flex h-16 w-28 flex-shrink-0 items-center justify-center gap-4 rounded-lg ring-1 ring-inset sm:w-36 ${surface}`}
        style={paper}
      >
        {mark('h-8 w-8', 'text-lg')}
        {mark('h-4 w-4', 'text-[11px]')}
        {spinner}
      </span>
    );
  }

  return (
    <span
      aria-hidden="true"
      data-theme={dark ? 'dark' : undefined}
      className={`relative flex h-16 w-28 flex-shrink-0 items-center justify-center overflow-hidden rounded-lg px-3 ring-1 ring-inset sm:w-36 ${surface}`}
      style={paper}
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
