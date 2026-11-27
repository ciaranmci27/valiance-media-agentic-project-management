'use client';

import { useCallback } from 'react';
import { useApp } from '@/lib/store';
import { toast } from '@/components/ui/Toast';

/**
 * Moves a task to Trash at once and offers Undo (DESIGN.md Rule 6: Trash is
 * always Undo, never a confirm). The task panel closes on delete, so the
 * result has no place on screen: it is a toast with Undo, which restores it.
 */
export function useTrashTask(): (id: string) => Promise<void> {
  const { deleteTask, restoreRecord } = useApp();
  return useCallback(async (id: string) => {
    if (await deleteTask(id)) {
      toast('success', 'Moved to Trash', { action: { label: 'Undo', onClick: () => void restoreRecord('tasks', id) } });
    }
  }, [deleteTask, restoreRecord]);
}
