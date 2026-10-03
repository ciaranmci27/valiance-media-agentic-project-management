import { after } from 'next/server';

/**
 * Runs bookkeeping once the response is sent (Next's after()). Outside a
 * Next request, such as a script or test calling a handler directly, after()
 * throws, so the work runs straight away instead. Either way a failure is
 * logged and never fails the request it follows.
 */
export function afterResponse(label: string, work: () => Promise<unknown>): void {
  const guarded = async () => {
    try {
      await work();
    } catch (error) {
      console.error(`[API] ${label} failed`, error);
    }
  };
  try {
    after(guarded);
  } catch {
    void guarded();
  }
}
