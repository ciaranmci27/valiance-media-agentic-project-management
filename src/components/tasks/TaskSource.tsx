'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import type { Task, TaskSource as TaskSourceData } from '@/lib/types';

/** Where a task came from (GET /api/workspace/tasks/:id/source); null while loading, in demo mode, or on failure. */
export function useTaskSource(task: Task | null): TaskSourceData | null {
  const { isDemoMode } = useDemo();
  const [data, setData] = useState<{ id: string; value: TaskSourceData } | null>(null);
  const taskId = task?.id ?? null;
  useEffect(() => {
    if (!taskId || isDemoMode) return;
    let cancelled = false;
    fetch(`/api/workspace/tasks/${taskId}/source`)
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { data?: TaskSourceData } | null) => {
        if (!cancelled && body?.data) setData({ id: taskId, value: body.data });
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [taskId, isDemoMode]);
  return data && data.id === taskId ? data.value : null;
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
 * Under the task's Created date: who made it, the reason it came with, and
 * the email behind it. Tasks from before tracking say only that.
 */
export function TaskSourceLine({ source }: { source: TaskSourceData | null }) {
  const { teamMemberId } = useAuth();
  if (!source) return null;
  if (source.via === 'unknown') return <p className="mt-0.5 text-xs text-zinc-500">Before source tracking</p>;
  const creator = taskCreator(source, teamMemberId);
  return (
    <p className="mt-0.5 text-xs leading-relaxed text-zinc-400">
      {creator ? <>By {creator}</> : 'Source unknown'}
      {source.note && <> · <span className="text-zinc-300">{source.note}</span></>}
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
    </p>
  );
}

/** The dot on a card for a task that is new to you. */
export function UnseenDot({ task }: { task: Task }) {
  return (
    <span className="relative inline-flex h-2 w-2 flex-shrink-0" title="New to you">
      <span className="h-2 w-2 rounded-full bg-emerald-400" aria-hidden="true" />
      <span className="sr-only">New to you{task.created_note ? `: ${task.created_note}` : ''}. </span>
    </span>
  );
}
