'use client';

import type { ReactNode } from 'react';
import { Logo } from '@/components/ui/Logo';
import type { WizardStepId } from '@/lib/setup/gate';

export const STEP_NAMES: Record<WizardStepId, string> = {
  account: 'Your account',
  workspace: 'Your workspace',
  usage: 'How you will use it',
  billing: 'Billing details',
  email: 'Email',
  team: 'Your team',
  projects: 'First projects',
  done: 'Done',
};

/**
 * The setup wizard's frame: the logo, an optional action on the right, the
 * progress ("Step 2 of 7: Your workspace" over one bar per step) and the
 * step itself. Shared by the account step (before signing in) and the rest
 * of the wizard, so the two read as one flow.
 */
export function WizardChrome({
  steps,
  current,
  headerAction,
  banner,
  hideProgress = false,
  children,
}: {
  steps: readonly WizardStepId[];
  current: WizardStepId;
  headerAction?: ReactNode;
  banner?: ReactNode;
  /** For what comes before the questions (Connect your server): no step count. */
  hideProgress?: boolean;
  children: ReactNode;
}) {
  const index = steps.indexOf(current);
  const questionCount = steps.length - 1;
  return (
    <div className="flex min-h-screen flex-col">
      <header className="mx-auto flex w-full max-w-[46rem] items-center justify-between gap-4 px-4 pb-2 pt-5 sm:px-8 sm:pt-8">
        <div className="flex h-8 items-center">
          <Logo className="h-7 w-auto max-w-[180px] dark:hidden" />
          <Logo variant="dark" className="hidden h-7 w-auto max-w-[180px] dark:block" />
        </div>
        {headerAction}
      </header>

      <div className="mx-auto w-full max-w-[46rem] flex-1 px-4 pb-16 pt-6 sm:px-8 sm:pt-10">
        <div className="mx-auto max-w-2xl">
          {banner}
          {!hideProgress && <nav aria-label="Setup progress" className="mb-10">
            <p className="text-xs font-medium text-zinc-400">
              {current === 'done' ? 'Setup complete' : `Step ${index + 1} of ${questionCount}: ${STEP_NAMES[current]}`}
            </p>
            <ol className="mt-3 flex gap-1.5">
              {steps.slice(0, questionCount).map((id, i) => (
                <li
                  key={id}
                  aria-label={`${STEP_NAMES[id]}${i < index || current === 'done' ? ', done' : i === index ? ', current step' : ''}`}
                  aria-current={i === index ? 'step' : undefined}
                  className={`h-1 flex-1 rounded-full transition-colors duration-300 motion-reduce:transition-none ${
                    i < index || current === 'done' ? 'bg-brand-500' : i === index ? 'bg-brand-500/50' : 'bg-white/[0.08]'
                  }`}
                />
              ))}
            </ol>
          </nav>}
          {children}
        </div>
      </div>
    </div>
  );
}
