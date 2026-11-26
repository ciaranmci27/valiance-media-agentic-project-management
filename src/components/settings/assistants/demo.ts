'use client';

import { toast } from '@/components/ui/Toast';

/** Said once at the top of Settings > Assistants in the demo workspace. */
export const ASSISTANTS_DEMO_NOTE = 'Sample assistants: changes are off in the demo.';

/**
 * In the demo every change on Settings > Assistants is a no-op: it says so
 * and answers true, so the caller stops. Outside the demo it answers false.
 */
export function demoBlocked(isDemo: boolean): boolean {
  if (isDemo) toast('info', 'Changes are off in the demo.');
  return isDemo;
}
