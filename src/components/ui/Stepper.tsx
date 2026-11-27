'use client';

import type { KeyboardEvent, ReactNode } from 'react';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, Check, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';

/**
 * The guided-flow family: hiring an agent (/agent/new) and setting up a
 * project (/projects/new) are built from these, so both read as one
 * product. A full page, never a modal: a header with a way out, the
 * stepper, one step at a time in a calm column, Back and Next at its foot,
 * and an optional aside beside it on desktop (below it on phones).
 */

export interface FlowStep {
  key: string;
  label: string;
}

/**
 * Where the flow stands, sized to the space it sits in (a container query,
 * so a dialog and a full page each get what fits). Wide: every step,
 * numbered, done ones ticked; a step already reached can be clicked back to.
 * Medium: the same row with only the current step's name shown. Narrow:
 * "Step 2 of 6", the step's name and a progress bar.
 */
export function Stepper({ steps, current, reached, onJump, label = 'Progress' }: {
  steps: readonly FlowStep[];
  /** Index of the step on screen. */
  current: number;
  /** Highest index reached so far: steps up to it can be revisited. */
  reached: number;
  onJump?: (index: number) => void;
  label?: string;
}) {
  const pct = steps.length > 1 ? (current / (steps.length - 1)) * 100 : 100;
  return (
    <nav aria-label={label} className="@container">
      <div className="@lg:hidden">
        <p className="flex items-baseline justify-between text-xs text-zinc-400">
          <span>Step {current + 1} of {steps.length}</span>
          <span className="font-medium text-zinc-200">{steps[current]?.label}</span>
        </p>
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/[0.06]" aria-hidden="true">
          <div className="h-full rounded-full bg-brand-400 transition-[width] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none" style={{ width: `${pct}%` }} />
        </div>
      </div>
      <ol className="hidden @lg:flex items-center gap-2">
        {steps.map((step, index) => {
          const done = index < current;
          const active = index === current;
          const canJump = !!onJump && index <= reached && !active;
          const body = (
            <>
              <span
                className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-[11px] font-semibold tabular-nums transition-colors duration-300 ${
                  active ? 'bg-brand-500 text-on-accent shadow-glow'
                    : done ? 'bg-brand-500/20 text-brand-200'
                      : 'bg-white/[0.06] text-zinc-500'
                }`}
                aria-hidden="true"
              >
                {done ? <Check size={12} strokeWidth={3} /> : index + 1}
              </span>
              <span className={`text-sm whitespace-nowrap ${active ? 'font-semibold text-white' : `sr-only @3xl:not-sr-only ${done ? 'text-zinc-300' : 'text-zinc-500'}`}`}>{step.label}</span>
            </>
          );
          return (
            <li key={step.key} className="flex min-w-0 items-center gap-2" title={active ? undefined : step.label}>
              {canJump ? (
                <button type="button" onClick={() => onJump(index)} className="flex items-center gap-2 rounded-full pr-1 hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
                  {body}
                </button>
              ) : (
                <span className="flex items-center gap-2" aria-current={active ? 'step' : undefined}>{body}</span>
              )}
              {index < steps.length - 1 && (
                <span className={`h-px w-4 @3xl:w-6 @5xl:w-10 ${done ? 'bg-brand-500/40' : 'bg-white/[0.08]'}`} aria-hidden="true" />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** The page around a flow: title, a way out, the stepper, the step, and an aside. */
export function FlowShell({ title, subtitle, exitHref, exitLabel = 'Cancel', onExit, stepper, aside, children }: {
  title: string;
  subtitle?: ReactNode;
  exitHref: string;
  exitLabel?: string;
  /** Asks before leaving (unsaved work, a secret not yet saved): called instead of following the link. */
  onExit?: () => void;
  stepper: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="animate-fadeIn min-h-screen">
      <header className="px-4 pt-5 lg:px-8 lg:pt-8">
        <div className="mx-auto flex max-w-5xl items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold tracking-tight text-white lg:text-title">{title}</h1>
            {subtitle && <p className="mt-1 max-w-xl text-sm text-zinc-400">{subtitle}</p>}
          </div>
          <Link
            href={exitHref}
            onClick={onExit ? (e) => { if (e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); onExit(); } : undefined}
            className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            <X size={15} aria-hidden="true" />
            {exitLabel}
          </Link>
        </div>
        <div className="mx-auto mt-6 max-w-5xl">{stepper}</div>
      </header>
      <div className={`mx-auto grid max-w-5xl gap-6 px-4 pb-16 pt-6 lg:px-8 lg:pt-8 ${aside ? 'lg:grid-cols-[minmax(0,1fr)_280px] lg:gap-10' : ''}`}>
        <main className="min-w-0">{children}</main>
        {aside && <aside className="min-w-0 lg:pt-1">{aside}</aside>}
      </div>
    </div>
  );
}

/**
 * One step: a heading that says what this step decides, one line on why,
 * then the fields. Re-keyed per step, so each enters with the app's
 * ease-out-expo slide (none under reduced motion).
 */
export function StepPanel({ stepKey, title, description, children }: {
  stepKey: string;
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={`step-${stepKey}`} className="animate-slideInUp">
      <h2 id={`step-${stepKey}`} className="text-lg font-semibold tracking-tight text-white lg:text-xl">{title}</h2>
      {description && <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-zinc-400">{description}</p>}
      <div className="mt-6">{children}</div>
    </section>
  );
}

/**
 * Back and Next at the foot of a step. Next says what it does on the step that
 * commits ("Hire Nova"). `bar` pins it as a side panel's save bar instead of
 * under the step's fields.
 */
export function StepFooter({ onBack, onNext, nextLabel = 'Next', busy = false, busyLabel, nextDisabled = false, error, extra, variant = 'inline' }: {
  onBack?: () => void;
  onNext?: () => void;
  nextLabel?: string;
  busy?: boolean;
  busyLabel?: string;
  nextDisabled?: boolean;
  /** A step-level problem (the server's), shown above the buttons. */
  error?: string | null;
  extra?: ReactNode;
  variant?: 'inline' | 'bar';
}) {
  return (
    <div className={variant === 'bar' ? 'border-t border-white/[0.06] px-5 py-3' : 'mt-10 border-t border-white/[0.06] pt-5'}>
      {error && <p role="alert" className="mb-4 rounded-lg bg-red-500/[0.12] px-3 py-2 text-sm text-red-300">{error}</p>}
      <div className="flex items-center justify-between gap-3">
        <div>
          {onBack && (
            <Button variant="ghost" size={variant === 'bar' ? 'sm' : 'md'} icon={<ArrowLeft size={15} aria-hidden="true" />} onClick={onBack} disabled={busy}>
              Back
            </Button>
          )}
        </div>
        {/* On a narrow screen the buttons keep their words on one line: the main one goes on top, the extra one under it. */}
        <div className="flex min-w-0 flex-1 flex-wrap-reverse items-center justify-end gap-2 [&>*]:shrink-0 [&>*]:whitespace-nowrap">
          {extra}
          {onNext && (
            <Button
              size={variant === 'bar' ? 'sm' : 'md'}
              onClick={onNext}
              disabled={busy || nextDisabled}
              icon={busy ? <Loader2 size={15} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : undefined}
            >
              {busy ? busyLabel ?? 'Saving' : nextLabel}
              {!busy && <ArrowRight size={15} aria-hidden="true" />}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * A set of choice cards as one radio group: arrow keys move between cards
 * and pick, Tab leaves the group, and only the picked card (or the first)
 * is in the tab order, as the ARIA radio group pattern expects.
 */
export function ChoiceGroup({ label, className = '', children }: { label: string; className?: string; children: ReactNode }) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    const radios = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled)')];
    const index = radios.indexOf(document.activeElement as HTMLButtonElement);
    if (index === -1) return;
    e.preventDefault();
    const next = e.key === 'Home' ? 0
      : e.key === 'End' ? radios.length - 1
        : e.key === 'ArrowRight' || e.key === 'ArrowDown' ? (index + 1) % radios.length
          : (index - 1 + radios.length) % radios.length;
    radios[next].focus();
    radios[next].click();
  };
  return (
    <div role="radiogroup" aria-label={label} onKeyDown={onKeyDown} className={className}>
      {children}
    </div>
  );
}

/**
 * One choice card (a template, a kind of setup) inside a ChoiceGroup: a big
 * target named by its title and described by its line. The picked card is
 * filled with the brand tint and ringed, so the choice reads at a glance.
 * A disabled card (already connected, coming soon) stays in view, dimmed,
 * with its reason in meta; arrow keys skip it.
 */
export function ChoiceCard({ id, selected, focusable, onSelect, icon, title, description, meta, disabled = false }: {
  /** Unique on the page: names the card for screen readers. */
  id: string;
  selected: boolean;
  /** In the tab order: the picked card, or the first when none is picked. */
  focusable: boolean;
  onSelect: () => void;
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  meta?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="radio"
      disabled={disabled}
      aria-checked={selected}
      aria-labelledby={`${id}-title`}
      aria-describedby={description ? `${id}-desc` : undefined}
      tabIndex={focusable && !disabled ? 0 : -1}
      onClick={onSelect}
      className={`group flex h-full w-full flex-col rounded-2xl p-5 text-left transition-all duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)] ${
        selected
          ? 'bg-brand-500/[0.18] ring-2 ring-inset ring-brand-400 shadow-glow'
          : disabled
            ? 'cursor-not-allowed bg-white/[0.02] opacity-60 ring-1 ring-inset ring-white/[0.04]'
            : 'bg-white/[0.03] hover:bg-white/[0.06] ring-1 ring-inset ring-white/[0.06]'
      }`}
    >
      <span className="flex items-start justify-between gap-3">
        {icon && (
          <span className={`flex h-10 w-10 items-center justify-center rounded-xl transition-colors ${selected ? 'bg-brand-500 text-on-accent' : 'bg-white/[0.06] text-zinc-300 group-hover:text-white'}`} aria-hidden="true">
            {icon}
          </span>
        )}
        <span className={`flex h-5 w-5 items-center justify-center rounded-full transition-all ${selected ? 'bg-brand-500 text-on-accent scale-100' : 'scale-90 ring-1 ring-inset ring-white/[0.15]'}`} aria-hidden="true">
          {selected && <Check size={12} strokeWidth={3} />}
        </span>
      </span>
      <span id={`${id}-title`} className="mt-4 text-base font-semibold text-white">{title}</span>
      {description && <span id={`${id}-desc`} className={`mt-1 text-sm leading-relaxed ${selected ? 'text-zinc-200' : 'text-zinc-400'}`}>{description}</span>}
      {meta && <span className={`mt-auto pt-4 text-xs ${selected ? 'text-brand-200' : 'text-zinc-500'}`}>{meta}</span>}
      {selected && <span className="sr-only">Selected</span>}
    </button>
  );
}

/** "Set this up from a chat": the aside every flow carries, showing an AI can do the same over MCP. */
export function ChatSetupAside({ prompt }: { prompt: string }) {
  return (
    <div className="rounded-2xl bg-white/[0.03] p-5 ring-1 ring-inset ring-white/[0.06]">
      <p className="text-sm font-semibold text-white">Set this up from a chat</p>
      <p className="mt-1.5 text-xs leading-relaxed text-zinc-400">
        Any AI connected to this workspace can do these steps for you. Ask it in plain words:
      </p>
      <p className="mt-3 rounded-lg bg-white/[0.04] px-3 py-2.5 text-xs leading-relaxed text-zinc-200">{prompt}</p>
    </div>
  );
}
