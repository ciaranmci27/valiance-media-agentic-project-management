'use client';

import Link from 'next/link';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { useRead } from '@/lib/query-cache';
import { taskSourceRead } from '@/lib/reads';
import type { Task, TaskSource as TaskSourceData } from '@/lib/types';

/** Where a task came from: a cached read, warmed before the panel opens; null while loading, in demo mode, or on failure. */
export function useTaskSource(task: Task | null): TaskSourceData | null {
  const { isDemoMode } = useDemo();
  return useRead(task && !isDemoMode ? taskSourceRead(task.id) : null).data ?? null;
}

/**
 * Who or what made the task, in a few words: "you", "Ashley", "your Claude
 * Code key", "Maya's Time recap key", "an automation". A key is named by
 * itself, so a task an agent made through a person's key never reads as
 * that person's own.
 */
export function taskCreator(source: Pick<TaskSourceData, 'via' | 'by' | 'key'>, memberId: string | null): string | null {
  const mine = !!source.by && source.by.id === memberId;
  switch (source.via) {
    case 'app':
      return source.by ? (mine ? 'you' : source.by.name) : null;
    case 'api':
    case 'mcp':
      if (source.by?.agent) return source.by.name;
      if (source.key) return mine ? `your ${source.key.name} key` : source.by ? `${source.by.name}'s ${source.key.name} key` : `the ${source.key.name} key`;
      return source.by ? `${source.by.name}, through the API` : 'the API';
    case 'system':
      return 'an automation';
    default:
      return null;
  }
}

/**
 * The task's Source row: who made it, the reason it came with, and the email
 * behind it. Tasks from before tracking say only that.
 */
export function TaskSourceLine({ source }: { source: TaskSourceData | null }) {
  const { teamMemberId } = useAuth();
  if (!source) return null;
  if (source.via === 'unknown') return <span className="text-sm text-zinc-500">Before tracking</span>;
  const creator = taskCreator(source, teamMemberId);
  return (
    <span className="py-1 text-sm leading-snug text-zinc-300">
      {creator ? creator.charAt(0).toUpperCase() + creator.slice(1) : 'Unknown'}
      {source.note && <span className="text-zinc-400"> · {source.note}</span>}
      {source.email && (
        <>
          {' · '}
          <Link
            href={`/inbox?thread=${source.email.thread_id}&message=${source.email.message_id}`}
            className="rounded font-medium text-brand-300 hover:text-brand-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            View email
          </Link>
        </>
      )}
    </span>
  );
}
