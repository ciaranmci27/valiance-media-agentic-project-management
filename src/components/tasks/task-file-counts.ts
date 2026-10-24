'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { hasPermission } from '@/lib/access-control';
import { createClient } from '@/lib/supabase/client';

// How many files each task holds, for the cards and rows: one light read of
// every live task file the person can see (RLS), once a session, kept in step
// with the open task's Files section as files are added and removed there.
let fileCounts = new Map<string, number>();
let version = 0;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

const changed = () => {
  version++;
  listeners.forEach((listener) => listener());
};

function loadFileCounts(): Promise<void> {
  loading ??= (async () => {
    const supabase = createClient();
    const next = new Map<string, number>();
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase.from('task_files').select('task_id').is('deleted_at', null).order('id').range(from, from + 999);
      if (error) {
        loading = null;
        return;
      }
      for (const row of (data ?? []) as { task_id: string }[]) next.set(row.task_id, (next.get(row.task_id) ?? 0) + 1);
      if (!data || data.length < 1000) break;
    }
    fileCounts = next;
    changed();
  })();
  return loading;
}

/** The open task's Files section knows its count exactly; cards follow it. */
export function setTaskFileCount(taskId: string, count: number) {
  if ((fileCounts.get(taskId) ?? 0) === count) return;
  fileCounts = new Map(fileCounts).set(taskId, count);
  changed();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** How many files a task holds; 0 until loaded, in demo mode, or without file access. */
export function useTaskFileCount(taskId: string): number {
  const { isDemoMode } = useDemo();
  const { access } = useAuth();
  const canRead = hasPermission(access, 'files.read') || hasPermission(access, 'files.manage');
  useEffect(() => {
    if (!isDemoMode && canRead) void loadFileCounts();
  }, [isDemoMode, canRead]);
  useSyncExternalStore(subscribe, () => version, () => 0);
  return isDemoMode || !canRead ? 0 : fileCounts.get(taskId) ?? 0;
}
