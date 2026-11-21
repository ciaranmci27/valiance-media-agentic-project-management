'use client';

import { useEffect, useRef, type FormEvent, type ReactNode } from 'react';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { OutcomeLine } from '@/components/settings/workspace/OutcomeLine';
import { useWizardPreviewNext } from './wizard-preview';

/** What the wizard hands every step: where Back, Skip and Continue lead. */
export interface WizardStepProps {
  onNext: () => void;
  onSkip: () => void;
  onBack?: () => void;
}

/**
 * One step of the setup wizard: the question, its fields, and the footer
 * (Back on the left; Skip for now and the primary action on the right).
 * The step is a form, so Enter in any field continues. On arrival the first
 * field takes focus with a mouse or keyboard; on touch screens the heading
 * does, so the keyboard does not cover the step. In a preview the primary
 * action only moves on: the step's own submit, which saves, never runs.
 */
export function StepFrame({
  title,
  description,
  children,
  onSubmit,
  onBack,
  onSkip,
  busy = false,
  busyLabel = 'Saving',
  primaryLabel = 'Continue',
  primaryDisabled = false,
  skipLabel = 'Skip for now',
  error,
}: {
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  onSubmit: () => void;
  onBack?: () => void;
  onSkip?: () => void;
  busy?: boolean;
  busyLabel?: string;
  primaryLabel?: string;
  primaryDisabled?: boolean;
  skipLabel?: string;
  error?: string | null;
}) {
  const form = useRef<HTMLFormElement>(null);
  const previewNext = useWizardPreviewNext();
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const fine = window.matchMedia?.('(pointer: fine)').matches;
    const field = fine
      ? form.current?.querySelector<HTMLElement>('input:not([type="hidden"]):not([readonly]):not([disabled]), textarea:not([disabled])')
      : null;
    (field ?? heading.current)?.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (previewNext) {
      previewNext();
      return;
    }
    if (busy || primaryDisabled) return;
    onSubmit();
  };

  return (
    <form ref={form} onSubmit={submit} noValidate className="flex flex-col">
      <h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold tracking-tight text-white focus:outline-none sm:text-[28px] sm:leading-tight">
        {title}
      </h1>
      {description && <p className="mt-2 max-w-lg text-sm leading-relaxed text-zinc-400">{description}</p>}

      {children && <div className="mt-8">{children}</div>}

      {error && <OutcomeLine outcome={{ tone: 'error', text: error }} className="mt-6" />}

      <div className="mt-10 flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.06] pt-5">
        <div>
          {onBack && (
            <Button type="button" variant="ghost" onClick={onBack} disabled={busy} icon={<ArrowLeft size={14} aria-hidden="true" />}>
              Back
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2">
          {onSkip && (
            <Button type="button" variant="ghost" onClick={onSkip} disabled={busy}>
              {skipLabel}
            </Button>
          )}
          <Button
            type="submit"
            disabled={!previewNext && (busy || primaryDisabled)}
            icon={busy ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : undefined}
          >
            {busy ? busyLabel : primaryLabel}
          </Button>
        </div>
      </div>
    </form>
  );
}
