'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { Logo } from '@/components/ui/Logo';
import { Button } from '@/components/ui/Button';
import { OutcomeLine } from '@/components/settings/workspace/OutcomeLine';
import { useModuleSwitch } from '@/components/settings/workspace/workspace-modules';
import { AFTER_SETUP_PATH, wizardSteps, type WizardStepId } from '@/lib/setup/gate';
import { WorkspaceStep } from './steps/WorkspaceStep';
import { UsageStep } from './steps/UsageStep';
import { BillingStep } from './steps/BillingStep';
import { EmailStep } from './steps/EmailStep';
import { TeamStep } from './steps/TeamStep';
import { ProjectsStep } from './steps/ProjectsStep';
import { DoneStep } from './steps/DoneStep';

const ALL_STEPS = wizardSteps();
const STEP_NAMES: Record<WizardStepId, string> = {
  workspace: 'Your workspace',
  usage: 'How you will use it',
  billing: 'Billing details',
  email: 'Email',
  team: 'Your team',
  projects: 'First projects',
  done: 'Done',
};

// Where the Owner was, so closing the tab and coming back resumes there.
// Everything entered is saved as each step continues; this is only the place.
const storageKey = (memberId: string | null) => `welcome-step:${memberId ?? 'me'}`;
function readStep(memberId: string | null): WizardStepId | null {
  try {
    const value = window.localStorage.getItem(storageKey(memberId));
    return value && (ALL_STEPS as string[]).includes(value) ? (value as WizardStepId) : null;
  } catch {
    return null;
  }
}
function writeStep(memberId: string | null, step: WizardStepId | null) {
  try {
    if (step) window.localStorage.setItem(storageKey(memberId), step);
    else window.localStorage.removeItem(storageKey(memberId));
  } catch {
    // Private mode: the wizard starts at the top next time, with what was saved filled in.
  }
}

/**
 * First-run setup for the Owner of a fresh install: full screen, one
 * decision per step, every step skippable. Finishing or "Skip setup" marks
 * the workspace set up (the same completeSetup the Features screen uses),
 * and the Dashboard's Getting started list picks up whatever was skipped.
 */
export function WelcomeWizard() {
  const router = useRouter();
  const { teamMemberId } = useAuth();
  const { enabled, save } = useModuleSwitch();
  const steps = wizardSteps(enabled);
  const [step, setStep] = useState<WizardStepId>('workspace');
  const [finishing, setFinishing] = useState<'finish' | 'skip' | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Resume after mount (localStorage is the browser's), never during the server render.
  useEffect(() => {
    const saved = readStep(teamMemberId);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (saved) setStep(saved);
  }, [teamMemberId]);

  // A step that no longer applies (Billing after Client invoicing went off) gives way to the next one.
  const current: WizardStepId = steps.includes(step)
    ? step
    : steps.find((id) => ALL_STEPS.indexOf(id) > ALL_STEPS.indexOf(step)) ?? 'done';
  const index = steps.indexOf(current);
  const questionCount = steps.length - 1;

  const go = useCallback((next: WizardStepId) => {
    setStep(next);
    setError(null);
    writeStep(teamMemberId, next);
  }, [teamMemberId]);

  // The full order, not today's list (the usage step may have just switched Client invoicing on);
  // a step that does not apply gives way to the one after it (see `current`).
  const nextFrom = (from: WizardStepId) => ALL_STEPS[ALL_STEPS.indexOf(from) + 1] ?? 'done';
  const onNext = () => go(nextFrom(current));
  const onBack = index > 0 ? () => go(steps[index - 1]) : undefined;

  const complete = async (how: 'finish' | 'skip') => {
    if (finishing) return;
    setFinishing(how);
    setError(null);
    const result = await save(enabled, { completeSetup: true });
    if (!result.ok) {
      setFinishing(null);
      setError(`Could not finish setup. ${result.message}`);
      return;
    }
    writeStep(teamMemberId, null);
    router.replace(AFTER_SETUP_PATH);
  };

  const props = { onNext, onSkip: onNext, onBack };

  return (
    <div className="flex min-h-screen flex-col">
      <header className="mx-auto flex w-full max-w-[46rem] items-center justify-between gap-4 px-4 pb-2 pt-5 sm:px-8 sm:pt-8">
        <div className="flex h-8 items-center">
          <Logo className="h-7 w-auto max-w-[180px] dark:hidden" />
          <Logo variant="dark" className="hidden h-7 w-auto max-w-[180px] dark:block" />
        </div>
        {current !== 'done' && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { void complete('skip'); }}
            disabled={!!finishing}
            icon={finishing === 'skip' ? <Loader2 size={13} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : undefined}
          >
            {finishing === 'skip' ? 'Skipping' : 'Skip setup'}
          </Button>
        )}
      </header>

      <div className="mx-auto w-full max-w-[46rem] flex-1 px-4 pb-16 pt-6 sm:px-8 sm:pt-10">
        <div className="mx-auto max-w-2xl">
          <nav aria-label="Setup progress" className="mb-10">
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
          </nav>

          {error && finishing === null && current !== 'done' && <OutcomeLine outcome={{ tone: 'error', text: error }} className="mb-6" />}

          {/* Keyed by step, so each one arrives fresh and takes focus. */}
          <div key={current} className="animate-fadeIn">
            {current === 'workspace' && <WorkspaceStep {...props} onBack={undefined} />}
            {current === 'usage' && <UsageStep {...props} />}
            {current === 'billing' && <BillingStep {...props} />}
            {current === 'email' && <EmailStep {...props} />}
            {current === 'team' && <TeamStep {...props} />}
            {current === 'projects' && <ProjectsStep {...props} />}
            {current === 'done' && (
              <DoneStep
                onFinish={() => { void complete('finish'); }}
                onBack={() => go(steps[index - 1])}
                finishing={finishing === 'finish'}
                error={error}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
