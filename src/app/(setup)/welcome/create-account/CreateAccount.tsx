'use client';

import { WizardChrome } from '@/components/welcome/WizardChrome';
import { AccountStep } from '@/components/welcome/steps/AccountStep';
import type { WizardStepId } from '@/lib/setup/gate';

/** Step 1 of the setup wizard, in the same frame as the steps that follow it. */
export function CreateAccount({ steps }: { steps: WizardStepId[] }) {
  return (
    <WizardChrome steps={steps} current="account">
      <div className="animate-fadeIn">
        <AccountStep />
      </div>
    </WizardChrome>
  );
}
