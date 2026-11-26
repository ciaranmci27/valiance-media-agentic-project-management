'use client';

import { useState } from 'react';
import { CheckCircle2, CircleAlert, Edit, Gavel, Link2, Megaphone, Plus, RefreshCw, RotateCcw, StickyNote, Trash2, type LucideIcon } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { hasPermission } from '@/lib/access-control';
import { useRead } from '@/lib/query-cache';
import { initiativeEntriesRead, type InitiativeEntryFilters } from '@/lib/reads';
import { INITIATIVE_ENTRY_KINDS, type InitiativeEntryKind, type Task } from '@/lib/types';
import {
  INITIATIVE_ENTRY_BODY_MAX, INITIATIVE_ENTRY_KIND_LABELS, INITIATIVE_ENTRY_TITLE_MAX, INITIATIVE_LABEL, INITIATIVE_READ_LIMITS,
  type InitiativeEntryView,
} from '@/lib/initiatives';
import { timeAgo, taskTimesTooltip } from '@/lib/task-times';
import { Button } from '@/components/ui/Button';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { Textarea } from '@/components/ui/inputs/Textarea';
import { Select } from '@/components/ui/inputs/Select';
import { RowActionsMenu, type RowAction } from '@/components/ui/RowActionsMenu';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Tooltip } from '@/components/ui/Tooltip';
import { LinkedText } from '@/components/ui/LinkedText';
import { toast } from '@/components/ui/Toast';
import { Bone, NoMatches, Skeleton } from '@/components/projects/TabLayout';
import { addInitiativeEntry, trashInitiativeEntry, updateInitiativeEntry, writeError } from './initiative-actions';

/**
 * An initiative's log: the dated record of updates, decisions, issues and
 * notes, newest first, a page of 50 at a time. Standing knowledge belongs in
 * the brief; a proposed task is a task suggestion, never an entry. Anyone
 * who may log adds entries and resolves or reopens issues; an entry's author
 * edits it.
 */

const KIND_STYLE: Record<InitiativeEntryKind, { icon: LucideIcon; tone: string; placeholder: string }> = {
  update: { icon: Megaphone, tone: 'bg-brand-500/15 text-brand-300', placeholder: 'Homepage wireframes done' },
  decision: { icon: Gavel, tone: 'bg-sky-500/[0.14] text-sky-300', placeholder: 'We go with a hosted CMS' },
  issue: { icon: CircleAlert, tone: 'bg-amber-500/[0.14] text-amber-300', placeholder: 'Waiting on the client for logo files' },
  note: { icon: StickyNote, tone: 'bg-white/[0.06] text-zinc-300', placeholder: 'Old URLs to redirect' },
};

type FilterKey = 'all' | InitiativeEntryKind | 'open';

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'update', label: 'Updates' },
  { key: 'decision', label: 'Decisions' },
  { key: 'issue', label: 'Issues' },
  { key: 'note', label: 'Notes' },
  { key: 'open', label: 'Open issues' },
];

const filtersOf = (key: FilterKey): InitiativeEntryFilters =>
  key === 'all' ? {} : key === 'open' ? { kind: 'issue', status: 'open' } : { kind: key };

const CHIP = (on: boolean) =>
  `inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
    on ? 'bg-brand-500/15 text-brand-300 border border-brand-500/30' : 'bg-white/[0.03] text-zinc-400 border border-white/10 hover:border-white/20 hover:text-zinc-200'
  }`;

export function InitiativeLog({ projectId, initiativeId, canLog, openIssueCount, linkableTasks, onOpenTask }: {
  projectId: string;
  initiativeId: string;
  canLog: boolean;
  /** For the Open issues filter's count. */
  openIssueCount: number;
  /** Tasks an entry can point at: the initiative's own. */
  linkableTasks: Task[];
  onOpenTask: (taskId: string) => void;
}) {
  const { isDemoMode } = useDemo();
  const [filter, setFilter] = useState<FilterKey>('all');
  const [pages, setPages] = useState(1);
  const first = useRead(initiativeEntriesRead(projectId, initiativeId, isDemoMode, { ...filtersOf(filter), page: 1 }));
  const total = first.data?.total ?? 0;
  const pageSize = INITIATIVE_READ_LIMITS.entriesPage;
  const remaining = Math.max(0, total - pages * pageSize);

  const pick = (key: FilterKey) => {
    setFilter(key);
    setPages(1);
  };

  return (
    <div className="space-y-4">
      {canLog && <Composer projectId={projectId} initiativeId={initiativeId} linkableTasks={linkableTasks} />}

      <div role="radiogroup" aria-label="Show entries" className="flex flex-wrap items-center gap-1.5">
        {FILTERS.map((item) => (
          <button
            key={item.key}
            type="button"
            role="radio"
            aria-checked={filter === item.key}
            onClick={() => pick(item.key)}
            className={CHIP(filter === item.key)}
          >
            {item.label}
            {item.key === 'open' && openIssueCount > 0 && <span className="tabular-nums text-amber-300">{openIssueCount}</span>}
          </button>
        ))}
      </div>

      <section className="glass-card rounded-xl" aria-label="Log entries">
        {first.loading ? (
          <Skeleton label="Loading the log" className="divide-y divide-white/[0.06]">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex gap-3 px-5 py-4">
                <Bone className="h-7 w-7 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Bone className="h-3 w-24" />
                  <Bone className="h-4 w-2/3" />
                  <Bone className="h-3 w-full" />
                </div>
              </div>
            ))}
          </Skeleton>
        ) : first.failed ? (
          <div className="px-5 py-10 text-center">
            <p className="text-sm text-zinc-300">Couldn&apos;t load the log.</p>
            <Button className="mt-3" size="sm" variant="secondary" icon={<RefreshCw size={14} aria-hidden="true" />} onClick={first.reload}>Try again</Button>
          </div>
        ) : total === 0 ? (
          <NoMatches>
            {filter === 'all'
              ? canLog ? 'Nothing logged yet. Add the first update, decision, issue or note.' : 'Nothing logged yet.'
              : filter === 'open' ? 'No open issues.' : `No ${FILTERS.find((f) => f.key === filter)?.label.toLowerCase()} yet.`}
          </NoMatches>
        ) : (
          <ul className="divide-y divide-white/[0.06]">
            {(first.data?.rows ?? []).map((entry) => (
              <EntryItem key={entry.id} entry={entry} projectId={projectId} canLog={canLog} onOpenTask={onOpenTask} />
            ))}
            {Array.from({ length: pages - 1 }, (_, index) => (
              <LogPage
                key={index + 2}
                page={index + 2}
                projectId={projectId}
                initiativeId={initiativeId}
                filters={filtersOf(filter)}
                canLog={canLog}
                onOpenTask={onOpenTask}
              />
            ))}
          </ul>
        )}
        {remaining > 0 && (
          <div className="border-t border-white/[0.06] px-5 py-3 text-center">
            <Button variant="ghost" size="sm" onClick={() => setPages((n) => n + 1)}>
              Show {Math.min(pageSize, remaining)} more of {remaining}
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}

/** A later page of the log, read when Show more asks for it. */
function LogPage({ page, projectId, initiativeId, filters, canLog, onOpenTask }: {
  page: number;
  projectId: string;
  initiativeId: string;
  filters: InitiativeEntryFilters;
  canLog: boolean;
  onOpenTask: (taskId: string) => void;
}) {
  const { isDemoMode } = useDemo();
  const read = useRead(initiativeEntriesRead(projectId, initiativeId, isDemoMode, { ...filters, page }));
  if (read.loading) {
    return (
      <li className="px-5 py-4">
        <Skeleton label="Loading more entries"><Bone className="h-4 w-1/2" /></Skeleton>
      </li>
    );
  }
  if (read.failed) {
    return (
      <li className="px-5 py-4 text-sm text-zinc-400">
        Couldn&apos;t load more. <button type="button" onClick={read.reload} className="font-medium text-brand-300 hover:text-brand-200 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">Try again</button>
      </li>
    );
  }
  return (
    <>
      {(read.data?.rows ?? []).map((entry) => (
        <EntryItem key={entry.id} entry={entry} projectId={projectId} canLog={canLog} onOpenTask={onOpenTask} />
      ))}
    </>
  );
}

function KindBadge({ kind }: { kind: InitiativeEntryKind }) {
  const { icon: Icon, tone } = KIND_STYLE[kind];
  return (
    <span className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full ${tone}`} aria-hidden="true">
      <Icon size={14} />
    </span>
  );
}

function EntryItem({ entry, projectId, canLog, onOpenTask }: {
  entry: InitiativeEntryView;
  projectId: string;
  canLog: boolean;
  onOpenTask: (taskId: string) => void;
}) {
  const { tasks } = useApp();
  const { access, teamMemberId } = useAuth();
  const { isDemoMode } = useDemo();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmTrash, setConfirmTrash] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const isAuthor = !!teamMemberId && entry.created_by === teamMemberId;
  const canTrash = isAuthor || hasPermission(access, 'projects.manage');
  const linked = entry.task_id ? tasks.find((task) => task.id === entry.task_id) : undefined;
  const isIssue = entry.kind === 'issue';
  const resolved = isIssue && entry.status === 'resolved';
  const long = entry.body.length > 280 || entry.body.split('\n').length > 4;
  const demo = { isDemo: isDemoMode, memberId: teamMemberId ?? null };

  const setStatus = async (status: 'open' | 'resolved') => {
    setBusy(true);
    try {
      await updateInitiativeEntry(projectId, entry.initiative_id, entry.id, { status }, demo);
    } catch (error) {
      toast('error', writeError(error, status === 'resolved' ? "Couldn't resolve the issue" : "Couldn't reopen the issue"));
    } finally {
      setBusy(false);
    }
  };

  const trash = async () => {
    try {
      await trashInitiativeEntry(projectId, entry.initiative_id, entry.id, isDemoMode);
      toast('success', 'Entry moved to Trash');
    } catch (error) {
      toast('error', writeError(error, "Couldn't move the entry to Trash"));
    }
  };

  const actions: RowAction[] = [
    ...(isAuthor ? [{ label: 'Edit', icon: <Edit size={14} />, onClick: () => setEditing(true) }] : []),
    ...(canTrash ? [{ label: 'Move to Trash', icon: <Trash2 size={14} />, variant: 'danger' as const, divider: isAuthor, onClick: () => setConfirmTrash(true) }] : []),
  ];

  return (
    <li className="flex gap-3 px-4 py-4 sm:px-5">
      <KindBadge kind={entry.kind} />
      <div className="min-w-0 flex-1">
        {editing ? (
          <EntryEditor entry={entry} projectId={projectId} onDone={() => setEditing(false)} />
        ) : (
          <>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-zinc-400">
                  <span className="font-medium uppercase tracking-wide">{INITIATIVE_ENTRY_KIND_LABELS[entry.kind]}</span>
                  {isIssue && (
                    <span className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 font-medium normal-case ${
                      resolved ? 'bg-emerald-500/[0.14] text-emerald-300' : 'bg-amber-500/[0.14] text-amber-300'
                    }`}>
                      {resolved && <CheckCircle2 size={11} aria-hidden="true" />}
                      {resolved ? 'Resolved' : 'Open'}
                    </span>
                  )}
                </p>
                <h4 className={`mt-0.5 text-sm font-medium leading-snug break-words ${resolved ? 'text-zinc-300' : 'text-white'}`}>{entry.title}</h4>
              </div>
              <div className="flex flex-shrink-0 items-center gap-1">
                {isIssue && canLog && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    icon={resolved ? <RotateCcw size={13} aria-hidden="true" /> : <CheckCircle2 size={13} aria-hidden="true" />}
                    onClick={() => void setStatus(resolved ? 'open' : 'resolved')}
                  >
                    {resolved ? 'Reopen' : 'Resolve'}
                  </Button>
                )}
                {actions.length > 0 && <RowActionsMenu actions={actions} label={`Actions for ${entry.title}`} />}
              </div>
            </div>
            {entry.body && (
              <div className="mt-1.5">
                <p className={`text-sm leading-relaxed text-zinc-300 whitespace-pre-wrap break-words ${long && !expanded ? 'line-clamp-4' : ''}`}>
                  <LinkedText text={entry.body} />
                </p>
                {long && (
                  <button
                    type="button"
                    onClick={() => setExpanded((v) => !v)}
                    className="mt-1 text-xs font-medium text-brand-300 hover:text-brand-200 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                  >
                    {expanded ? 'Show less' : 'Show more'}
                  </button>
                )}
              </div>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-400">
              <span>{entry.created_by_name ?? 'Someone'}</span>
              <span aria-hidden="true">·</span>
              <Tooltip content={taskTimesTooltip(entry.created_at, entry.updated_at)}>
                <time dateTime={entry.created_at}>{timeAgo(entry.created_at)}</time>
              </Tooltip>
              {resolved && entry.resolved_at && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>Resolved{entry.resolved_by_name ? ` by ${entry.resolved_by_name}` : ''} {timeAgo(entry.resolved_at)}</span>
                </>
              )}
              {linked && (
                <button
                  type="button"
                  onClick={() => onOpenTask(linked.id)}
                  className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full bg-white/[0.05] px-2 py-0.5 text-zinc-300 hover:bg-white/[0.08] hover:text-white transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                >
                  <Link2 size={12} className="flex-shrink-0" aria-hidden="true" />
                  <span className="sr-only">Linked task: </span>
                  <span className="truncate">{linked.title}</span>
                </button>
              )}
            </div>
          </>
        )}
      </div>
      <ConfirmDialog
        isOpen={confirmTrash}
        onClose={() => setConfirmTrash(false)}
        onConfirm={() => void trash()}
        title="Move entry to Trash?"
        message="The entry leaves the log."
        variant="danger"
        trash
      />
    </li>
  );
}

/** Its author changes the title and the details in place. */
function EntryEditor({ entry, projectId, onDone }: { entry: InitiativeEntryView; projectId: string; onDone: () => void }) {
  const { isDemoMode } = useDemo();
  const { teamMemberId } = useAuth();
  const [title, setTitle] = useState(entry.title);
  const [body, setBody] = useState(entry.body);
  const [saving, setSaving] = useState(false);
  const dirty = title.trim() !== entry.title || body !== entry.body;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || saving) return;
    if (!dirty) { onDone(); return; }
    setSaving(true);
    try {
      await updateInitiativeEntry(projectId, entry.initiative_id, entry.id, {
        ...(title.trim() !== entry.title ? { title: title.trim() } : {}),
        ...(body !== entry.body ? { body } : {}),
      }, { isDemo: isDemoMode, memberId: teamMemberId ?? null });
      onDone();
    } catch (error) {
      toast('error', writeError(error, "Couldn't save the entry"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={save} className="space-y-3" onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onDone(); } }}>
      <TextInput label="Title" value={title} onChange={(v) => setTitle(v.slice(0, INITIATIVE_ENTRY_TITLE_MAX))} autoFocus error={title.trim() ? undefined : 'Give it a title'} />
      <Textarea label="Details" value={body} onChange={(v) => setBody(v.slice(0, INITIATIVE_ENTRY_BODY_MAX))} rows={3} autoResize maxHeight={360} />
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>Cancel</Button>
        <Button type="submit" size="sm" disabled={!title.trim() || saving}>{saving ? 'Saving' : 'Save'}</Button>
      </div>
    </form>
  );
}

/** Adding an entry: a quiet line that opens into a short form. */
function Composer({ projectId, initiativeId, linkableTasks }: { projectId: string; initiativeId: string; linkableTasks: Task[] }) {
  const { isDemoMode } = useDemo();
  const { teamMemberId } = useAuth();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<InitiativeEntryKind>('update');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [taskId, setTaskId] = useState('');
  const [saving, setSaving] = useState(false);
  const [tried, setTried] = useState(false);

  const reset = () => {
    setOpen(false);
    setKind('update');
    setTitle('');
    setBody('');
    setTaskId('');
    setTried(false);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (!title.trim() || saving) return;
    setSaving(true);
    try {
      await addInitiativeEntry(projectId, initiativeId, {
        kind,
        title: title.trim(),
        ...(body.trim() ? { body: body.trim() } : {}),
        ...(taskId ? { task_id: taskId } : {}),
      }, { isDemo: isDemoMode, memberId: teamMemberId ?? null });
      toast('success', `${INITIATIVE_ENTRY_KIND_LABELS[kind]} added`);
      reset();
    } catch (error) {
      toast('error', writeError(error, "Couldn't add the entry"));
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="glass-card flex w-full items-center gap-3 rounded-xl px-4 py-3.5 text-left text-sm text-zinc-400 transition-colors hover:text-zinc-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 sm:px-5"
      >
        <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-white/[0.06]" aria-hidden="true">
          <Plus size={14} />
        </span>
        Add an update, decision, issue or note
      </button>
    );
  }

  const taskOptions = [
    { value: '', label: 'No task' },
    ...linkableTasks.map((task) => ({ value: task.id, label: task.title })),
  ];

  return (
    <form
      onSubmit={submit}
      className="glass-card space-y-4 rounded-xl px-4 py-4 sm:px-5"
      aria-label={`Add to the ${INITIATIVE_LABEL.lower} log`}
      onKeyDown={(e) => { if (e.key === 'Escape' && !title && !body) { e.preventDefault(); reset(); } }}
    >
      <div className="max-w-full overflow-x-auto">
        <div role="radiogroup" aria-label="Kind of entry" className="seg-track seg-sm">
          {INITIATIVE_ENTRY_KINDS.map((value) => {
            const Icon = KIND_STYLE[value].icon;
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={kind === value}
                onClick={() => setKind(value)}
                className={`seg-item flex items-center gap-1.5 ${kind === value ? 'is-active' : ''}`}
              >
                <Icon size={14} aria-hidden="true" />
                {INITIATIVE_ENTRY_KIND_LABELS[value]}
              </button>
            );
          })}
        </div>
      </div>
      <TextInput
        label="Title *"
        value={title}
        onChange={(v) => setTitle(v.slice(0, INITIATIVE_ENTRY_TITLE_MAX))}
        placeholder={KIND_STYLE[kind].placeholder}
        autoFocus
        error={tried && !title.trim() ? 'Give it a title' : undefined}
      />
      <Textarea
        label="Details"
        value={body}
        onChange={(v) => setBody(v.slice(0, INITIATIVE_ENTRY_BODY_MAX))}
        placeholder="What happened, why, and what comes next."
        rows={3}
        autoResize
        maxHeight={360}
      />
      {linkableTasks.length > 0 && (
        <Select
          label="Linked task"
          visibleLabel="Linked task"
          value={taskId}
          onChange={setTaskId}
          options={taskOptions}
          searchable={taskOptions.length > 8}
          placeholder="No task"
          emptyText="No tasks match."
        />
      )}
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={reset}>Cancel</Button>
        <Button type="submit" size="sm" disabled={saving}>
          {saving ? 'Adding' : `Add ${INITIATIVE_ENTRY_KIND_LABELS[kind].toLowerCase()}`}
        </Button>
      </div>
    </form>
  );
}
