'use client';

import { workspaceApi } from '@/lib/agent-workspace';
import { peekRead, setReadData } from '@/lib/query-cache';
import { myAssistantRead } from '@/lib/reads';
import type { MyAssistantView, UpdateMyAssistant } from '@/lib/assistant';

/**
 * Saves a change to the person's own assistant and puts the server's answer
 * in the shared read, so the page and the sidebar show it at once. `optimistic`
 * paints the change first; a failure puts back what was there and throws.
 */
export async function saveMyAssistant(isDemo: boolean, patch: UpdateMyAssistant, optimistic?: (view: MyAssistantView) => MyAssistantView): Promise<MyAssistantView> {
  const read = myAssistantRead(isDemo);
  const before = peekRead(read);
  if (optimistic && before) setReadData(read, () => optimistic(before));
  try {
    const view = await workspaceApi<MyAssistantView>('/api/workspace/assistant', { method: 'PATCH', body: patch });
    setReadData(read, () => view);
    return view;
  } catch (error) {
    if (before) setReadData(read, () => before);
    throw error;
  }
}
