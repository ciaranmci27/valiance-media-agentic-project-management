'use client';

import { WizardChrome } from '@/components/welcome/WizardChrome';
import { AccountStep } from '@/components/welcome/steps/AccountStep';
import { ConnectServerStep } from '@/components/welcome/steps/ConnectServerStep';
import type { ServerCheck } from '@/lib/setup/checks';
import type { WizardStepId } from '@/lib/setup/gate';

/**
 * Step 1 of the setup wizard, in the same frame as the steps that follow it.
 * While the host still lacks a required setting, "Connect your server" comes
 * first: a precondition, not one of the questions, so it sits above step 1.
 */
export function CreateAccount({ steps, missing, google = false }: { steps: WizardStepId[]; missing: ServerCheck[]; google?: boolean }) {
  const blocked = missing.length > 0;
  return (
    <WizardChrome
      steps={steps}
      current="account"
      hideProgress={blocked}
      banner={blocked ? <p className="mb-8 text-xs font-medium text-amber-300">Before you start</p> : undefined}
    >
      <div className="animate-fadeIn">
        {blocked ? <ConnectServerStep missing={missing} /> : <AccountStep google={google} />}
      </div>
    </WizardChrome>
  );
}
