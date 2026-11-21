'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Eye, X } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { Button } from '@/components/ui/Button';
import { OutcomeLine } from '@/components/settings/workspace/OutcomeLine';
import { useModuleSwitch } from '@/components/settings/workspace/workspace-modules';
import { AFTER_SETUP_PATH, wizardSteps, type WizardStepId } from '@/lib/setup/gate';
import { WizardChrome } from './WizardChrome';
import { WizardPreviewContext } from './wizard-preview';
import { AccountStep } from './steps/AccountStep';
import { WorkspaceStep } from './steps/WorkspaceStep';
import { UsageStep } from './steps/UsageStep';
import { BillingStep } from './steps/BillingStep';
import { EmailStep } from './steps/EmailStep';
import { TeamStep } from './steps/TeamStep';
import { ProjectsStep } from './steps/ProjectsStep';
import { DoneStep } from './steps/DoneStep';

const ALL_STEPS = wizardSteps();
/** Where a preview goes back to: the page that opens it. */
const PREVIEW_RETURN = '/settings/workspace';

// Where the Owner was, so closing the tab and coming back resumes there.
// Everything entered is saved as each step continues; this is only the place.
const storageKey = (memberId: string | null) => `welcome-step:${memberId ?? 'me'}`;
function readStep(memberId: string | null): WizardStepId | null {
  try {
    const value = window.localStorage.getItem(storageKey(memberId));
    return value && value !== 'account' && (ALL_STEPS as string[]).includes(value) ? (value as WizardStepId) : null;
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
 * decision per step. Their account was made before signing in (step 1,
 * /welcome/create-account), so this starts at Your workspace. There is no
 * skipping the wizard: optional steps say so and have "Skip for now", and
 * finishing marks the workspace set up (the same completeSetup the Features
 * screen uses); the Dashboard's Getting started list picks up what was left.
 *
 * After setup an Owner can open it as a preview (?preview=1, from Settings >
 * Workspace): every step, the account step included, nothing saved.
 */
export function WelcomeWizard() {
  const router = useRouter();
  const { teamMemberId } = useAuth();
  const { enabled, save, read } = useModuleSwitch();
  const setupDone = read.data?.status === 'ready' && read.data.setupCompleted;
  const preview = useSearchParams().get('preview') === '1' && setupDone;
  const steps = wizardSteps(enabled);
  // Null until the Owner moves: the first step (Your account in a preview).
  const [step, setStep] = useState<WizardStepId | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Resume after mount (localStorage is the browser's), never during the server render.
  useEffect(() => {
    if (preview) return;
    const saved = readStep(teamMemberId);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (saved) setStep(saved);
  }, [teamMemberId, preview]);

  // A step that no longer applies (Billing after Client invoicing went off)
  // gives way to the next one. Outside a preview the account step is done.
  const start: WizardStepId = preview ? 'account' : 'workspace';
  const wanted: WizardStepId = !step || (!preview && step === 'account') ? start : step;
  const current: WizardStepId = steps.includes(wanted)
    ? wanted
    : steps.find((id) => ALL_STEPS.indexOf(id) > ALL_STEPS.indexOf(wanted)) ?? 'done';
  const index = steps.indexOf(current);
  const firstIndex = preview ? 0 : 1;

  const go = (next: WizardStepId) => {
    setStep(next);
    setError(null);
    if (!preview) writeStep(teamMemberId, next);
  };

  const closePreview = () => router.push(PREVIEW_RETURN);

  // The full order, not today's list (the usage step may have just switched Client invoicing on);
  // a step that does not apply gives way to the one after it (see `current`).
  const nextFrom = (from: WizardStepId) => ALL_STEPS[ALL_STEPS.indexOf(from) + 1] ?? 'done';
  const onNext = () => go(nextFrom(current));
  const onBack = index > firstIndex ? () => go(steps[index - 1]) : undefined;

  // In a preview StepFrame moves on through this; Done closes the preview.
  const previewValue = preview ? { next: () => (current === 'done' ? closePreview() : onNext()) } : null;

  const complete = async () => {
    if (finishing) return;
    setFinishing(true);
    setError(null);
    const result = await save(enabled, { completeSetup: true });
    if (!result.ok) {
      setFinishing(false);
      setError(`Could not finish setup. ${result.message}`);
      return;
    }
    writeStep(teamMemberId, null);
    router.replace(AFTER_SETUP_PATH);
  };

  const props = { onNext, onSkip: onNext, onBack };

  return (
    <WizardPreviewContext.Provider value={previewValue}>
      <WizardChrome
        steps={steps}
        current={current}
        headerAction={preview ? (
          <Button variant="ghost" size="sm" onClick={closePreview} icon={<X size={14} aria-hidden="true" />}>
            Close preview
          </Button>
        ) : undefined}
        banner={preview ? (
          <p role="status" className="mb-8 flex items-start gap-2.5 rounded-lg bg-brand-500/[0.08] px-3.5 py-3 text-sm text-zinc-300 ring-1 ring-inset ring-brand-500/20">
            <Eye size={15} className="mt-0.5 flex-shrink-0 text-brand-300" aria-hidden="true" />
            <span>Preview: this is what a new Owner sees. Continue moves on without saving anything.</span>
          </p>
        ) : undefined}
      >
        {error && !finishing && current !== 'done' && <OutcomeLine outcome={{ tone: 'error', text: error }} className="mb-6" />}

        {/* Keyed by step, so each one arrives fresh and takes focus. */}
        <div key={current} className="animate-fadeIn">
          {current === 'account' && <AccountStep />}
          {current === 'workspace' && <WorkspaceStep {...props} onBack={onBack} />}
          {current === 'usage' && <UsageStep {...props} />}
          {current === 'billing' && <BillingStep {...props} />}
          {current === 'email' && <EmailStep {...props} />}
          {current === 'team' && <TeamStep {...props} />}
          {current === 'projects' && <ProjectsStep {...props} />}
          {current === 'done' && (
            <DoneStep
              onFinish={() => { if (preview) closePreview(); else void complete(); }}
              onBack={() => go(steps[index - 1])}
              finishing={finishing}
              error={error}
            />
          )}
        </div>
      </WizardChrome>
    </WizardPreviewContext.Provider>
  );
}
