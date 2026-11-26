'use client';

import Link from 'next/link';
import { useState } from 'react';
import { CheckCircle2, History, Inbox, ListPlus, Loader2, Sparkles, Workflow } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { toast } from '@/components/ui/Toast';
import { workspaceApi } from '@/lib/agent-workspace';
import { invalidateTables, setReadData, useRead } from '@/lib/query-cache';
import { myAssistantActivityRead } from '@/lib/reads';
import { timeAgo } from '@/lib/task-times';
import type { ActivityKind, AssistantActivityItem } from '@/lib/assistant';

const KIND_ICON: Record<ActivityKind, typeof History> = {
  task_created: ListPlus,
  task_completed: CheckCircle2,
  inbox_sorted: Inbox,
  run: Workflow,
  event: Sparkles,
};

const UNDO_WORDS: Record<string, string> = {
  task_created: 'Moved to Trash',
  task_completed: 'Reopened',
  inbox_sorted: 'Sort undone',
};

const WINDOW = 10;

/**
 * What the assistant did, newest first, one plain line each. Undo acts at
 * once (no confirm: each can be done again) and the line then says what
 * happened: a task it made goes to Trash (with Restore beside it), a task it
 * finished goes back to the status it had, an email it sorted is put back
 * through the Inbox's own undo.
 */
export function AssistantActivityBand({ assistantName, isDemo = false }: { assistantName: string; isDemo?: boolean }) {
  const read = useRead(myAssistantActivityRead(isDemo));
  const [shown, setShown] = useState(WINDOW);
  const [undoing, setUndoing] = useState<string | null>(null);
  const [undone, setUndone] = useState<Record<string, string>>({});
  const [restored, setRestored] = useState<Record<string, true>>({});
  const items = read.data?.items ?? [];

  const restore = async (item: AssistantActivityItem, restoreUndo: NonNullable<AssistantActivityItem['restore']>) => {
    setUndoing(item.id);
    try {
      await workspaceApi('/api/workspace/assistant/undo', { method: 'POST', body: restoreUndo });
      invalidateTables(['tasks']);
      setRestored((current) => ({ ...current, [item.id]: true }));
      setUndone((current) => { const next = { ...current }; delete next[item.id]; return next; });
      setReadData(myAssistantActivityRead(isDemo), (current) => (current
        ? { ...current, items: current.items.map((row) => (row.id === item.id ? { ...row, undone: false, restore: null, undo: { kind: 'task_created' as const, id: restoreUndo.id } } : row)) }
        : current as never));
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not restore it. Try again.');
    } finally {
      setUndoing(null);
    }
  };

  const undo = async (item: AssistantActivityItem) => {
    if (!item.undo) return;
    setUndoing(item.id);
    try {
      if (item.undo.kind === 'inbox_sorted') {
        await workspaceApi(`/api/workspace/inbox/plans/${encodeURIComponent(item.undo.id)}/undo`, { method: 'POST' });
        invalidateTables(['communications.plans', 'communications.plan_items', 'tasks']);
      } else {
        await workspaceApi('/api/workspace/assistant/undo', { method: 'POST', body: item.undo });
        invalidateTables(['tasks']);
      }
      setUndone((current) => ({ ...current, [item.id]: UNDO_WORDS[item.undo!.kind] }));
      const restoreUndo = item.undo.kind === 'task_created' ? { kind: 'task_restore' as const, id: item.undo.id } : null;
      setReadData(myAssistantActivityRead(isDemo), (current) => (current
        ? { ...current, items: current.items.map((row) => (row.id === item.id ? { ...row, undo: null, undone: true, restore: restoreUndo } : row)) }
        : current as never));
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not undo. Try again.');
    } finally {
      setUndoing(null);
    }
  };

  return (
    <section className="glass-card rounded-xl overflow-hidden" aria-labelledby="assistant-did-heading">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-white/[0.08]">
        <History size={15} className="text-zinc-400" aria-hidden="true" />
        <h2 id="assistant-did-heading" className="text-sm font-semibold text-white">What it did</h2>
        <span className="text-xs tabular-nums px-1.5 py-0.5 rounded-full bg-white/[0.06] text-zinc-400">{items.length}</span>
        <span className="text-xs text-zinc-500 ml-auto hidden sm:block truncate pl-3">last 30 days</span>
      </div>
      {read.loading && !read.data ? (
        <div className="flex items-center gap-2 px-4 py-6 text-sm text-zinc-400" role="status">
          <Loader2 size={14} className="animate-spin" aria-hidden="true" />Loading activity
        </div>
      ) : read.failed && !read.data ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 px-4 py-4 text-sm text-zinc-300">
          Could not load what it did.
          <Button variant="secondary" size="sm" onClick={read.reload}>Try again</Button>
        </div>
      ) : items.length === 0 ? (
        <p className="px-4 py-6 text-sm text-zinc-400">Nothing yet. What {assistantName} does for you shows up here, with a way to undo it.</p>
      ) : (
        <ul className="divide-y divide-white/[0.04]">
          {items.slice(0, shown).map((item) => {
            const Icon = KIND_ICON[item.kind];
            const doneWords = undone[item.id] ?? (item.undone ? (item.kind === 'task_created' ? 'In Trash' : 'Undone') : null);
            const canRestore = !!item.restore && !restored[item.id];
            const line = <span className="text-sm text-zinc-200 break-words">{item.text}</span>;
            return (
              <li key={item.id} className="flex items-start gap-3 px-4 py-2.5">
                <Icon size={15} className="mt-0.5 flex-shrink-0 text-zinc-500" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  {item.href && !doneWords ? (
                    <Link href={item.href} className="rounded hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">{line}</Link>
                  ) : line}
                  <p className="text-[11px] text-zinc-500 tabular-nums">{timeAgo(item.at)}</p>
                </div>
                {doneWords ? (
                  <span className="flex flex-shrink-0 items-center gap-1.5">
                    <span className="rounded-full bg-white/[0.05] px-2 py-0.5 text-[11px] text-zinc-400">{doneWords}</span>
                    {canRestore && item.restore && (
                      <Button size="sm" variant="ghost" disabled={undoing === item.id} onClick={() => void restore(item, item.restore!)}>
                        {undoing === item.id ? 'Restoring' : 'Restore'}
                      </Button>
                    )}
                  </span>
                ) : item.undo ? (
                  <Button size="sm" variant="ghost" disabled={undoing === item.id} onClick={() => void undo(item)}>
                    {undoing === item.id ? 'Undoing' : 'Undo'}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {items.length > shown && (
        <button
          type="button"
          onClick={() => setShown((count) => count + WINDOW)}
          className="w-full border-t border-white/[0.04] px-4 py-2.5 text-xs text-zinc-400 hover:bg-white/[0.03] hover:text-zinc-200 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-500"
        >
          Show {Math.min(WINDOW, items.length - shown)} more of {items.length - shown}
        </button>
      )}
    </section>
  );
}
