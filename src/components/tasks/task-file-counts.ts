'use client';

import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { hasPermission } from '@/lib/access-control';
import { peekRead, setReadData, useRead } from '@/lib/query-cache';
import { taskFileCountsRead } from '@/lib/reads';

/**
 * The open task's Files section knows its count exactly (after an upload or
 * a removal, or a fresh read); cards follow it without a round trip.
 */
export function setTaskFileCount(taskId: string, count: number) {
  const counts = peekRead(taskFileCountsRead);
  if (!counts || (counts.get(taskId) ?? 0) === count) return;
  setReadData(taskFileCountsRead, (current) => new Map(current ?? []).set(taskId, count));
}

/** How many files a task holds; 0 until loaded, in demo mode, or without file access. */
export function useTaskFileCount(taskId: string): number {
  const { isDemoMode } = useDemo();
  const { access } = useAuth();
  const canRead = hasPermission(access, 'files.read') || hasPermission(access, 'files.manage');
  return useRead(!isDemoMode && canRead ? taskFileCountsRead : null).data?.get(taskId) ?? 0;
}
