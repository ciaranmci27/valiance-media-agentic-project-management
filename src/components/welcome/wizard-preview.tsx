'use client';

import { createContext, useContext } from 'react';

/**
 * The setup wizard as a preview: an Owner looking at it after setup, from
 * Settings > Workspace. Every step shows as it would and Continue moves on
 * (StepFrame calls `next` instead of the step's own submit), but nothing is
 * saved, uploaded, sent or created. Null outside a preview.
 */
export const WizardPreviewContext = createContext<{ next: () => void } | null>(null);

/** True while previewing: steps disable anything that would save on its own. */
export function useWizardPreview(): boolean {
  return useContext(WizardPreviewContext) !== null;
}

/** In a preview, the wizard's own "move on"; null otherwise. */
export function useWizardPreviewNext(): (() => void) | null {
  return useContext(WizardPreviewContext)?.next ?? null;
}
