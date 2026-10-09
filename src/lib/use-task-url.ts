'use client';

import { useCallback } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

/**
 * The open task lives in the URL (`?task=<id>`), so every task link (Ashley's
 * Telegram messages, the Inbox, the activity feed, a pasted link) opens the
 * task panel, a link clicked while already on the page opens it too, and the
 * address bar always holds a shareable link to the task on screen.
 */
export function useTaskUrlParam() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const taskId = searchParams.get('task');

  const setTask = useCallback((id: string | null) => {
    const next = new URLSearchParams(searchParams.toString());
    if (id) next.set('task', id);
    else next.delete('task');
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [router, pathname, searchParams]);

  const openTask = useCallback((id: string) => setTask(id), [setTask]);
  const closeTask = useCallback(() => setTask(null), [setTask]);

  return { taskId, openTask, closeTask };
}
