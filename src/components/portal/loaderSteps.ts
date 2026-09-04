import { LOADER_STEP_MS } from '@/components/ui/BrandLoader';

/**
 * What the loader says while the portal comes up: a short status sequence in
 * the present tense, three words a line, advancing on a timer. The last line
 * holds until the data is really there, so the sequence never skips a beat
 * and never claims to be done early.
 */
export const PORTAL_STEPS = ['Securing client portal', 'Syncing project data', 'Bringing portal online'];
export const FILE_STEPS = ['Securing file access', 'Opening your file'];

/** How long the last line is guaranteed on screen before the loader may leave. */
const LAST_STEP_MS = 800;

/** The minimum time the loader stays up so every line in `steps` can be read. */
export function loaderHoldMs(steps: readonly string[]): number {
  return Math.max(0, steps.length - 1) * LOADER_STEP_MS + LAST_STEP_MS;
}
