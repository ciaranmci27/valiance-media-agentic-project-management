'use client';

import { useEffect, useRef } from 'react';
import { INBOX_UPDATED_EVENT } from '@/lib/inbound-email/inbox-types';
import type { InboxChangeDetail } from '@/lib/inbound-email/inbox-client';

/** Realtime pings and local actions arrive in bursts; one refetch covers each burst. */
const INBOX_REFRESH_DEBOUNCE_MS = 300;

/**
 * Calls `onUpdate` once per burst of inbox changes. The window event is the
 * one source: the store fires it for realtime pings and announceInboxChange
 * fires it for local actions, so views never listen to both.
 */
export function useInboxUpdates(onUpdate: (detail: InboxChangeDetail | null) => void) {
  const callback = useRef(onUpdate);
  useEffect(() => {
    callback.current = onUpdate;
  }, [onUpdate]);

  useEffect(() => {
    let timer: number | null = null;
    let pending: InboxChangeDetail | null | undefined;
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<InboxChangeDetail | null>).detail ?? null;
      // Two changes in one burst from different places: nobody can skip the refetch.
      pending = pending === undefined || (pending?.threadId === detail?.threadId) ? detail : null;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        const flushed = pending ?? null;
        pending = undefined;
        callback.current(flushed);
      }, INBOX_REFRESH_DEBOUNCE_MS);
    };
    window.addEventListener(INBOX_UPDATED_EVENT, handler);
    return () => {
      window.removeEventListener(INBOX_UPDATED_EVENT, handler);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);
}
