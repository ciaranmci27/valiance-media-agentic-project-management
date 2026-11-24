'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, Archive, Bot, CalendarDays, Check, Pencil, Pin, PinOff, Plus, RefreshCw, Search, Target,
} from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { hasPermission } from '@/lib/access-control';
import { invalidateTables, setReadData, useRead } from '@/lib/query-cache';
import { projectBriefRead, projectBriefSearchRead, projectBriefSectionRead } from '@/lib/reads';
import {
  BRIEF_PAGE_SIZE, freshnessLabel, isStale, needsClamp, newestUpdate, orderBriefEntries, windowOf, showMoreLabel,
} from '@/lib/agents-ui';
import { workspaceApi } from '@/lib/agent-workspace';
import { BRIEF_ENTRY_MAX, BRIEF_SECTION_PAGE, BRIEF_SECTIONS, type BriefEntry, type BriefSection, type ProjectBrief } from '@/lib/project-brief';
import { appLocale } from '@/lib/region';
import type { ProjectGoal } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Markdown } from '@/components/ui/Markdown';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { Textarea } from '@/components/ui/inputs/Textarea';
import { DateInput } from '@/components/ui/inputs/DateInput';
import { Toggle } from '@/components/ui/inputs/Toggle';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { RowActionsMenu } from '@/components/ui/RowActionsMenu';
import { Bone, Skeleton } from '@/components/projects/TabLayout';
import { toast } from '@/components/ui/Toast';

/**
 * A project's brief: what every agent and person should know about it, in
 * sections (Overview, Goals, Rules, Decisions, Links, Glossary, History).
 * Pinned entries go into every agent's context for the project; the rest
 * are found by search. Agent-written entries are marked so a person can
 * check them. Each section lists a window and grows on request, so a brief
 * of a thousand entries stays quick; search goes to the server's index.
 */

const CONTENT_MAX = BRIEF_ENTRY_MAX;
/** Entries per server page past the first (the brief read's own page size). */
const BRIEF_SERVER_PAGE = BRIEF_SECTION_PAGE;

async function briefCall(projectId: string, path: string, method: string, body?: unknown) {
  await workspaceApi(`/api/workspace/projects/${encodeURIComponent(projectId)}/brief${path}`, { method, body });
  invalidateTables(['project_context']);
}

export function BriefTab({ projectId }: { projectId: string }) {
  const { projectGoals } = useApp();
  const { access } = useAuth();
  const { isDemoMode } = useDemo();
  const brief = useRead(isDemoMode ? null : projectBriefRead(projectId));
  const canEdit = !isDemoMode && hasPermission(access, 'project_context.manage');
  const canEditGoals = !isDemoMode && hasPermission(access, 'goals.manage');
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(q.trim()), 250);
    return () => window.clearTimeout(t);
  }, [q]);
  const search = useRead(debounced.length >= 2 && !isDemoMode ? projectBriefSearchRead(projectId, debounced) : null);
  const [deleting, setDeleting] = useState<BriefEntry | null>(null);

  const goals = projectGoals.filter((g) => g.project_id === projectId && !g.archived_at);

  // Sections in the brief's order, with any the server adds after them.
  const sections: BriefSection[] = useMemo(() => {
    const byKey = new Map((brief.data?.sections ?? []).map((s) => [s.key, s]));
    const known = BRIEF_SECTIONS.map((s): BriefSection => byKey.get(s.key) ?? { key: s.key, label: s.label, entries: [], total: 0 });
    const extra = (brief.data?.sections ?? []).filter((s) => !BRIEF_SECTIONS.some((k) => k.key === s.key));
    return [...known, ...extra];
  }, [brief.data]);
  const all = sections.flatMap((s) => s.entries);
  const totalEntries = sections.reduce((n, s) => n + Math.max(s.total ?? 0, s.entries.length), 0);
  const updated = newestUpdate(all);
  const pinned = all.filter((e) => e.pinned).length;
  const fromAgents = all.filter((e) => e.source === 'agent').length;

  // Optimistic: the brief changes on screen at once and the server's answer replaces it.
  const patchLocal = (id: string, patch: Partial<BriefEntry> | null) => setReadData<ProjectBrief>(projectBriefRead(projectId), (current) => ({
    goals: current?.goals ?? [],
    omitted: current?.omitted ?? [],
    sections: (current?.sections ?? []).map((s) => ({
      ...s,
      entries: patch === null ? s.entries.filter((e) => e.id !== id) : s.entries.map((e) => (e.id === id ? { ...e, ...patch } : e)),
    })),
  }));

  const act = async (fn: () => Promise<void>, fail: string) => {
    try {
      await fn();
    } catch (error) {
      invalidateTables(['project_context']);
      toast('error', error instanceof Error ? error.message : fail);
    }
  };

  const onPin = (entry: BriefEntry) => {
    patchLocal(entry.id, { pinned: !entry.pinned });
    void act(() => briefCall(projectId, `/${entry.id}`, 'PATCH', { pinned: !entry.pinned }), 'Could not pin it');
  };
  const onSave = async (entry: BriefEntry, content: string) => {
    patchLocal(entry.id, { content, updated_at: new Date().toISOString() });
    await act(() => briefCall(projectId, `/${entry.id}`, 'PATCH', { content }), 'Could not save it');
  };
  const onDelete = (entry: BriefEntry) => {
    patchLocal(entry.id, null);
    // The server archives it (is_active false); there is no Trash for brief entries.
    void act(() => briefCall(projectId, `/${entry.id}`, 'DELETE'), 'Could not archive it');
  };
  const onAdd = async (section: string, content: string, pin: boolean) => {
    try {
      await briefCall(projectId, '', 'POST', { section, content, pinned: pin });
      return true;
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not add it');
      return false;
    }
  };

  if (isDemoMode) return <p className="py-10 text-center text-sm text-zinc-400">The brief is not part of the demo.</p>;

  if (brief.loading) {
    return (
      <Skeleton label="Loading the brief" className="space-y-8">
        {[0, 1, 2].map((i) => (
          <div key={i} className="space-y-3"><Bone className="h-4 w-40" /><Bone className="h-16 w-full rounded-xl" /></div>
        ))}
      </Skeleton>
    );
  }
  if (brief.failed) {
    return (
      <div role="alert" className="flex flex-col items-center gap-3 py-14 text-center">
        <AlertTriangle size={26} className="text-red-400" aria-hidden="true" />
        <p className="text-sm text-zinc-300">Could not load the brief.</p>
        <Button variant="secondary" size="sm" icon={<RefreshCw size={13} aria-hidden="true" />} onClick={brief.reload}>Try again</Button>
      </div>
    );
  }

  const searching = debounced.length >= 2;
  // While the server's ranked answer loads, the entries already here are filtered as a stand-in.
  const results = searching
    ? (search.data ?? all.filter((e) => e.content.toLowerCase().includes(debounced.toLowerCase())))
    : [];

  return (
    <div className="grid gap-8 lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-10">
      <nav aria-label="Brief sections" className="hidden lg:block">
        <div className="sticky top-6 space-y-0.5">
          <a href="#brief-goals" className="flex items-center justify-between rounded-lg px-3 py-1.5 text-sm text-zinc-300 hover:bg-white/[0.04] hover:text-white">
            Goals <span className="text-xs tabular-nums text-zinc-500">{goals.length || ''}</span>
          </a>
          {sections.map((s) => (
            <a key={s.key} href={`#brief-${s.key}`} className="flex items-center justify-between rounded-lg px-3 py-1.5 text-sm text-zinc-300 hover:bg-white/[0.04] hover:text-white">
              <span className="truncate">{s.label}</span>
              <span className="text-xs tabular-nums text-zinc-500">{s.entries.length || ''}</span>
            </a>
          ))}
        </div>
      </nav>

      <div className="min-w-0">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-zinc-400">
            {totalEntries === 0 && goals.length === 0
              ? 'Nothing written yet.'
              : [
                  `${totalEntries} ${totalEntries === 1 ? 'entry' : 'entries'}`,
                  updated ? freshnessLabel(updated) : null,
                  `${pinned} pinned for every agent`,
                  fromAgents ? `${fromAgents} written by agents` : null,
                ].filter(Boolean).join(' · ')}
          </p>
          <div className="w-full sm:w-72">
            <TextInput type="search" aria-label="Search the brief" placeholder="Search the brief" value={q} onChange={setQ} leftIcon={Search} clearable />
          </div>
        </div>

        {searching ? (
          <section aria-label="Search results" className="mt-6">
            <p className="text-xs text-zinc-500" aria-live="polite">{results.length} {results.length === 1 ? 'match' : 'matches'}{search.loading ? ', searching' : ''}</p>
            <ul className="mt-3 space-y-2">
              {results.slice(0, 50).map((entry) => (
                <EntryRow key={entry.id} entry={entry} canEdit={canEdit} onPin={onPin} onSave={onSave} onDelete={setDeleting} />
              ))}
            </ul>
          </section>
        ) : (
          <div className="mt-6 space-y-10">
            <GoalsSection projectId={projectId} goals={goals} canEdit={canEditGoals} />
            {sections.map((section) => (
              <SectionBlock
                key={section.key}
                projectId={projectId}
                section={section}
                hint={BRIEF_SECTIONS.find((s) => s.key === section.key)?.hint}
               
                canEdit={canEdit}
                onPin={onPin}
                onSave={onSave}
                onDelete={setDeleting}
                onAdd={onAdd}
              />
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        isOpen={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => { if (deleting) onDelete(deleting); setDeleting(null); }}
        title="Archive this entry?"
        message="Agents stop seeing it, and it leaves the brief. An archived entry cannot be brought back from here."
        confirmLabel="Archive"
        variant="danger"
        doubleConfirm={false}
      />
    </div>
  );
}

function SectionBlock({ projectId, section, hint, canEdit, onPin, onSave, onDelete, onAdd }: {
  projectId: string;
  section: BriefSection;
  hint?: string;
  canEdit: boolean;
  onPin: (entry: BriefEntry) => void;
  onSave: (entry: BriefEntry, content: string) => Promise<void>;
  onDelete: (entry: BriefEntry) => void;
  onAdd: (section: string, content: string, pinned: boolean) => Promise<boolean>;
}) {
  const [pages, setPages] = useState(1);
  const [serverPages, setServerPages] = useState(0);
  const [adding, setAdding] = useState(false);
  const ordered = useMemo(() => orderBriefEntries(section.entries), [section.entries]);
  const { shown, hidden } = windowOf(ordered, pages, BRIEF_PAGE_SIZE);
  // The brief read holds a section's first page; past it, each "Show more" reads the next page from the server.
  const total = Math.max(section.total ?? 0, section.entries.length);
  const loadedElsewhere = section.entries.length + serverPages * BRIEF_SERVER_PAGE;
  const onServer = Math.max(0, total - loadedElsewhere);
  return (
    <section id={`brief-${section.key}`} aria-labelledby={`brief-h-${section.key}`} className="scroll-mt-6">
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <h3 id={`brief-h-${section.key}`} className="text-[15px] font-semibold text-white">{section.label}</h3>
          {hint && <p className="mt-0.5 text-xs text-zinc-500">{hint}</p>}
        </div>
        {canEdit && !adding && (
          <Button variant="ghost" size="sm" icon={<Plus size={13} aria-hidden="true" />} onClick={() => setAdding(true)}>Add</Button>
        )}
      </div>
      {adding && <NewEntry onCancel={() => setAdding(false)} onSubmit={async (content, pin) => { if (await onAdd(section.key, content, pin)) setAdding(false); }} />}
      {section.entries.length === 0 && !adding ? (
        <p className="mt-3 rounded-xl bg-white/[0.02] px-4 py-3 text-sm text-zinc-500">
          {canEdit ? 'Nothing here yet. Add what an agent new to this project should know.' : 'Nothing here yet.'}
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {shown.map((entry) => (
            <EntryRow key={entry.id} entry={entry} canEdit={canEdit} onPin={onPin} onSave={onSave} onDelete={onDelete} />
          ))}
        </ul>
      )}
      {hidden === 0 && Array.from({ length: serverPages }, (_, i) => (
        <SectionPage
          key={i}
          projectId={projectId}
          section={section.key}
          page={i + 2}
          render={(entry) => <EntryRow key={entry.id} entry={entry} canEdit={canEdit} onPin={onPin} onSave={onSave} onDelete={onDelete} />}
        />
      ))}
      {hidden > 0 ? (
        <Button variant="ghost" size="sm" className="mt-2" onClick={() => setPages(pages + 1)}>
          {showMoreLabel(hidden, BRIEF_PAGE_SIZE, hidden + onServer)}
        </Button>
      ) : onServer > 0 && (
        <Button variant="ghost" size="sm" className="mt-2" onClick={() => setServerPages(serverPages + 1)}>
          {showMoreLabel(onServer, BRIEF_SERVER_PAGE)}
        </Button>
      )}
    </section>
  );
}

/** Entries a section holds past the brief read's first page, read a page at a time. */
function SectionPage({ projectId, section, page: pageNumber, render }: {
  projectId: string;
  section: string;
  /** The server's page, from 2 (the brief read holds page 1). */
  page: number;
  render: (entry: BriefEntry) => React.ReactNode;
}) {
  const page = useRead(projectBriefSectionRead(projectId, section, pageNumber, BRIEF_SERVER_PAGE));
  if (page.loading) return <Skeleton label="Loading more" className="mt-2 space-y-2"><Bone className="h-14 w-full rounded-xl" /><Bone className="h-14 w-full rounded-xl" /></Skeleton>;
  if (page.failed) return <p role="alert" className="mt-2 text-sm text-red-300">Could not load more. <button type="button" className="underline" onClick={page.reload}>Try again</button></p>;
  return <ul className="mt-2 space-y-2">{orderBriefEntries(page.data ?? []).map(render)}</ul>;
}

function EntryRow({ entry, canEdit, onPin, onSave, onDelete }: {
  entry: BriefEntry;
  canEdit: boolean;
  onPin: (entry: BriefEntry) => void;
  onSave: (entry: BriefEntry, content: string) => Promise<void>;
  onDelete: (entry: BriefEntry) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const clampable = needsClamp(entry.content);
  const [draft, setDraft] = useState(entry.content);
  const byAgent = entry.source === 'agent';
  const stale = isStale(entry.updated_at);
  return (
    <li className={`group rounded-xl px-4 py-3 transition-colors ${entry.pinned ? 'bg-brand-500/[0.07]' : 'bg-white/[0.025] hover:bg-white/[0.04]'}`}>
      {editing ? (
        <div>
          <Textarea aria-label="Entry" value={draft} onChange={setDraft} rows={4} maxLength={CONTENT_MAX} />
          <div className="mt-2 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => { setDraft(entry.content); setEditing(false); }}>Cancel</Button>
            <Button size="sm" disabled={!draft.trim() || draft === entry.content} onClick={async () => { await onSave(entry, draft.trim()); setEditing(false); }}>Save</Button>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            {/* Entries are markdown: rendered, and long ones held to about eight lines until opened. */}
            <div
              id={`brief-entry-${entry.id}`}
              className={clampable && !expanded ? 'max-h-[11.5rem] overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]' : ''}
            >
              <Markdown markdown={entry.content} className="text-zinc-200" />
            </div>
            {clampable && (
              <button
                type="button"
                onClick={() => setExpanded(!expanded)}
                aria-expanded={expanded}
                aria-controls={`brief-entry-${entry.id}`}
                className="mt-1 rounded text-xs font-medium text-brand-300 hover:text-brand-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                {expanded ? 'Show less' : 'Show more'}
              </button>
            )}
            <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-zinc-500">
              {entry.pinned && <span className="inline-flex items-center gap-1 text-brand-300"><Pin size={11} aria-hidden="true" />Pinned</span>}
              {byAgent && (
                <span className="inline-flex items-center gap-1 rounded-full bg-sky-500/[0.14] px-1.5 py-0.5 text-sky-200">
                  <Bot size={11} aria-hidden="true" />Written by an agent, check it
                </span>
              )}
              <span className={stale ? 'text-amber-300' : ''}>{freshnessLabel(entry.updated_at)}{stale ? ', may be out of date' : ''}</span>
              {entry.file_path && <span className="font-mono">{entry.file_path}</span>}
            </p>
          </div>
          {canEdit && (
            <div className="flex flex-shrink-0 items-center gap-0.5 opacity-100 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
              <button
                type="button"
                onClick={() => onPin(entry)}
                aria-pressed={entry.pinned}
                aria-label={entry.pinned ? 'Unpin: agents find it by search' : 'Pin: every agent reads it'}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                {entry.pinned ? <PinOff size={14} aria-hidden="true" /> : <Pin size={14} aria-hidden="true" />}
              </button>
              <RowActionsMenu
                label="Entry actions"
                actions={[
                  { label: 'Edit', icon: <Pencil size={14} />, onClick: () => setEditing(true) },
                  { label: 'Archive', icon: <Archive size={14} />, variant: 'danger', divider: true, onClick: () => onDelete(entry) },
                ]}
              />
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function NewEntry({ onCancel, onSubmit }: { onCancel: () => void; onSubmit: (content: string, pinned: boolean) => Promise<void> }) {
  const [content, setContent] = useState('');
  const [pinned, setPinned] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <div className="animate-slideDown mt-3 rounded-xl bg-white/[0.03] p-3 ring-1 ring-inset ring-white/[0.08]">
      <Textarea aria-label="New entry" value={content} onChange={setContent} rows={3} maxLength={CONTENT_MAX} placeholder="One fact, rule or decision. Plain words." autoFocus />
      <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
        <Toggle size="sm" checked={pinned} onChange={setPinned} label="Pin for every agent" />
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button size="sm" disabled={!content.trim() || busy} icon={<Check size={13} aria-hidden="true" />} onClick={async () => { setBusy(true); await onSubmit(content.trim(), pinned); setBusy(false); }}>
            Add
          </Button>
        </div>
      </div>
    </div>
  );
}

const GOAL_STATUS_TONE: Record<ProjectGoal['status'], string> = {
  active: 'bg-emerald-500/[0.14] text-emerald-200',
  achieved: 'bg-sky-500/[0.14] text-sky-200',
  paused: 'bg-amber-500/[0.14] text-amber-200',
  abandoned: 'bg-white/[0.06] text-zinc-400',
};

/** Goals are the project's goals (pm.project_goals), shown as the brief's second section. */
function GoalsSection({ projectId, goals, canEdit }: { projectId: string; goals: ProjectGoal[]; canEdit: boolean }) {
  const { addGoal, updateGoal, archiveGoal } = useApp();
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const add = async () => {
    if (!title.trim()) return;
    setBusy(true);
    const goal = await addGoal({ project_id: projectId, title: title.trim(), target_date: target || null, status: 'active' });
    setBusy(false);
    if (goal) { setTitle(''); setTarget(''); setAdding(false); }
  };
  return (
    <section id="brief-goals" aria-labelledby="brief-h-goals" className="scroll-mt-6">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h3 id="brief-h-goals" className="text-[15px] font-semibold text-white">Goals</h3>
          <p className="mt-0.5 text-xs text-zinc-500">What this project is working toward. Agents plan against these.</p>
        </div>
        {canEdit && !adding && <Button variant="ghost" size="sm" icon={<Plus size={13} aria-hidden="true" />} onClick={() => setAdding(true)}>Add</Button>}
      </div>
      {adding && (
        <div className="animate-slideDown mt-3 grid gap-3 rounded-xl bg-white/[0.03] p-3 ring-1 ring-inset ring-white/[0.08] sm:grid-cols-[minmax(0,1fr)_180px_auto] sm:items-end">
          <TextInput label="Goal" value={title} onChange={setTitle} placeholder="Launch the new checkout" autoFocus />
          <DateInput label="Target date" value={target} onChange={setTarget} />
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>Cancel</Button>
            <Button size="sm" disabled={!title.trim() || busy} onClick={add}>Add</Button>
          </div>
        </div>
      )}
      {goals.length === 0 && !adding ? (
        <p className="mt-3 rounded-xl bg-white/[0.02] px-4 py-3 text-sm text-zinc-500">No goals yet.{canEdit ? ' Add one so agents know what matters most.' : ''}</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {goals.map((goal) => (
            <li key={goal.id} className="flex items-start gap-3 rounded-xl bg-white/[0.025] px-4 py-3">
              <Target size={15} className="mt-0.5 flex-shrink-0 text-brand-300" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-white">{goal.title}</p>
                {goal.description && <p className="mt-0.5 text-sm text-zinc-400">{goal.description}</p>}
                <p className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
                  <span className={`rounded-full px-1.5 py-0.5 capitalize ${GOAL_STATUS_TONE[goal.status]}`}>{goal.status}</span>
                  {goal.target_date && (
                    <span className="inline-flex items-center gap-1">
                      <CalendarDays size={11} aria-hidden="true" />
                      {new Date(`${goal.target_date}T00:00:00`).toLocaleDateString(appLocale(), { month: 'short', day: 'numeric', year: 'numeric' })}
                    </span>
                  )}
                </p>
              </div>
              {canEdit && (
                <RowActionsMenu
                  label={`Actions for ${goal.title}`}
                  actions={[
                    ...(goal.status !== 'achieved' ? [{ label: 'Mark achieved', icon: <Check size={14} />, onClick: () => updateGoal(goal.id, { status: 'achieved' }) }] : []),
                    ...(goal.status === 'active' ? [{ label: 'Pause', onClick: () => updateGoal(goal.id, { status: 'paused' }) }] : [{ label: 'Make active', onClick: () => updateGoal(goal.id, { status: 'active' }) }]),
                    { label: 'Archive', icon: <Archive size={14} />, variant: 'danger' as const, divider: true, onClick: () => archiveGoal(goal.id) },
                  ]}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
