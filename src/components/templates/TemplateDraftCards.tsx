'use client';

import { useState } from 'react';
import { ArrowRight, MinusCircle, PlusCircle, ShieldCheck, Sparkles } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { hasPermission } from '@/lib/access-control';
import { useRead } from '@/lib/query-cache';
import { projectTemplateDraftsRead } from '@/lib/reads';
import { timeAgo } from '@/lib/task-times';
import type { TemplateDraftView } from '@/lib/template-ui';
import { CountBadge } from '@/components/ui/CountBadge';
import { shortDate } from './RunPreviewList';
import { TemplateDraftReviewPanel } from './TemplateDraftReviewPanel';

/**
 * "Needs approval" on a project's Initiatives tab: one card per template run
 * an agent drafted here that waits for a person (template, who drafted it and
 * when, its key dates, the steps it adds or leaves out). A card opens the
 * review panel. Nothing shows when no draft waits.
 */
export function NeedsApprovalDrafts({ projectId }: { projectId: string }) {
  const { isDemoMode } = useDemo();
  const { access } = useAuth();
  const mayRead = hasPermission(access, 'tasks.create') || hasPermission(access, 'templates.manage');
  const read = useRead(mayRead ? projectTemplateDraftsRead(projectId, isDemoMode) : null);
  const [open, setOpen] = useState<string | null>(null);
  const drafts = (read.data ?? []).filter((draft) => draft.status === 'pending');
  if (!drafts.length) return null;

  return (
    <section aria-labelledby={`needs-approval-${projectId}`} className="mb-5">
      <h2 id={`needs-approval-${projectId}`} className="mb-2.5 flex items-center gap-2 text-sm font-semibold text-white">
        <ShieldCheck size={15} className="text-amber-300" aria-hidden="true" />
        Needs approval
        <CountBadge count={drafts.length} tone="warning" label={`${drafts.length} ${drafts.length === 1 ? 'draft waits' : 'drafts wait'} for a decision`} />
      </h2>
      <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {drafts.map((draft) => (
          <li key={draft.id} className="min-w-0">
            <DraftCard draft={draft} onOpen={() => setOpen(draft.id)} />
          </li>
        ))}
      </ul>
      {open && <TemplateDraftReviewPanel draftId={open} onClose={() => setOpen(null)} />}
    </section>
  );
}

function DraftCard({ draft, onOpen }: { draft: TemplateDraftView; onOpen: () => void }) {
  const dates = Object.entries(draft.key_dates).sort(([, a], [, b]) => a.localeCompare(b));
  const added = draft.extra_steps.length;
  const removed = draft.removed_steps.length;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex h-full w-full flex-col rounded-xl bg-amber-500/[0.06] p-4 text-left ring-1 ring-inset ring-amber-500/20 transition-colors hover:bg-amber-500/[0.1] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 lg:p-5"
    >
      <p className="flex min-w-0 items-center gap-1.5 text-xs text-zinc-400">
        <Sparkles size={13} className="flex-shrink-0 text-brand-300" aria-hidden="true" />
        <span className="truncate">Drafted by <span className="text-zinc-200">{draft.proposed_by_name ?? 'an agent'}</span></span>
        <span aria-hidden="true">·</span>
        <time dateTime={draft.created_at} className="flex-shrink-0 tabular-nums">{timeAgo(draft.created_at)}</time>
      </p>
      <h3 className="mt-2 text-sm font-semibold leading-snug text-white transition-colors group-hover:text-brand-300 lg:text-base break-words">
        {draft.template_name}
      </h3>
      {draft.note && <p className="mt-1 text-xs leading-relaxed text-zinc-400 line-clamp-2 break-words lg:text-sm">{draft.note}</p>}

      {dates.length > 0 && (
        <dl className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {dates.map(([key, date]) => (
            <div key={key} className="inline-flex items-baseline gap-1.5">
              <dt className="text-zinc-400">{draft.key_date_labels?.[key] ?? key}</dt>
              <dd className="tabular-nums text-zinc-200">{shortDate(date)}</dd>
            </div>
          ))}
        </dl>
      )}

      <div className="mt-auto pt-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-white/[0.06] pt-3 text-xs text-zinc-400">
          {added > 0 && <span className="inline-flex items-center gap-1"><PlusCircle size={13} aria-hidden="true" />{added} added</span>}
          {removed > 0 && <span className="inline-flex items-center gap-1"><MinusCircle size={13} aria-hidden="true" />{removed} left out</span>}
          {draft.template_changed && <span className="text-sky-300">Template changed</span>}
          <span className="ml-auto inline-flex items-center gap-1 font-medium text-brand-300 group-hover:text-brand-200">
            Review<ArrowRight size={13} aria-hidden="true" />
          </span>
        </div>
      </div>
    </button>
  );
}
