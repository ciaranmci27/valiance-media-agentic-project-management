'use client';

import { useCallback } from 'react';
import { useApp } from '@/lib/store';
import { toast } from '@/components/ui/Toast';
import type { TrashTable } from '@/lib/supabase/trash';

export { restoreOrder } from '@/lib/trash-undo';

/**
 * Says something just went to Trash, with Undo (DESIGN.md Rule 6: moving to
 * Trash acts at once, never a confirm). The row it was on is gone, so the
 * result is a toast; it outlives a page change, so Undo still works after
 * moving on. Undo restores each record in order (parents first) and then
 * runs `onRestored`, for screens that read outside the app store.
 */
export function useUndoTrash() {
  const { restoreRecord } = useApp();
  return useCallback((table: TrashTable, ids: string | string[], options: {
    message?: string;
    onRestored?: () => void;
    /** Restores one record another way (a read outside the store, a demo list). */
    restore?: (id: string) => Promise<boolean>;
  } = {}) => {
    const list = Array.isArray(ids) ? ids : [ids];
    if (!list.length) return;
    const restore = options.restore ?? ((id: string) => restoreRecord(table, id));
    toast('success', options.message ?? 'Moved to Trash', {
      action: {
        label: 'Undo',
        onClick: () => {
          void (async () => {
            let back = 0;
            // One at a time: a later record may need an earlier one back first.
            for (const id of list) if (await restore(id)) back++;
            if (back > 0) {
              options.onRestored?.();
              toast('success', back === 1 && list.length === 1 ? 'Restored' : `Restored ${back} of ${list.length}`);
            }
          })();
        },
      },
    });
  }, [restoreRecord]);
}
