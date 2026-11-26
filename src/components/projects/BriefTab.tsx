'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, Archive, Bot, CalendarDays, Check, CornerDownRight, Pencil, Pin, PinOff, Plus, RefreshCw, Search, Target, Trash2,
} from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { hasPermission } from '@/lib/access-control';
import { invalidateTables, setReadData, useRead, type Read } from '@/lib/query-cache';
import {
  projectBriefRead, projectBriefSearchRead, projectBriefSectionRead, scopedBriefRead, scopedBriefSearchRead, scopedBriefSectionRead,
} from '@/lib/reads';
import { SCOPE_WORDS, type ScopedBrief, type ScopeRef } from '@/lib/context-scopes';
import {
  BRIEF_PAGE_SIZE, freshnessLabel, isStale, needsClamp, newestUpdate, orderBriefEntries, windowOf, showMoreLabel,
} from '@/lib/agents-ui';
import { workspaceApi } from '@/lib/agent-workspace';
import {
  BRIEF_ENTRY_MAX, BRIEF_SECTION_PAGE, BRIEF_SECTIONS, type BriefEntry, type BriefSection, type BriefSectionKey, type ProjectBrief,
} from '@/lib/project-brief';
import { PINNED_REACH, pinnedReach, pinnedReachLine, type PinnedReach } from '@/lib/project-agents-ui';
import {
  demoAddEntry, demoPatchEntry, demoProjectBriefRead, demoScopedBriefRead, demoSearchEntries,
} from '@/lib/demo-project-agents';
import { appLocale } from '@/lib/region';
import type { ProjectGoal } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Markdown } from '@/components/ui/Markdown';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { Textarea } from '@/components/ui/inputs/Textarea';
import { DateInput } from '@/components/ui/inputs/DateInput';
import { Select } from '@/components/ui/inputs/Select';
import { Toggle } from '@/components/ui/inputs/Toggle';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { RowActionsMenu, type RowAction } from '@/components/ui/RowActionsMenu';
import { Bone, Skeleton } from '@/components/projects/TabLayout';
import { toast } from '@/components/ui/Toast';

/**
 * A project's brief: what every agent and person should know about it, in
 * sections (Overview, Goals, Rules, Decisions, Links, Glossary, History).
 * Agents always see the newest few pinned entries (PINNED_REACH), each cut
 * to a length, and find the rest by search: the screen says which pinned
 * entries are past that. Agent-written entries are marked until a person
 * edits them or marks them checked. Each section lists a window and grows
 * on request, so a brief of a thousand entries stays quick; search goes to
 * the server's index. The demo works on its own copy (lib/demo-project-agents).
 */

const CONTENT_MAX = BRIEF_ENTRY_MAX;
/** Entries per server page past the first (the brief read's own page size). */
const BRIEF_SERVER_PAGE = BRIEF_SECTION_PAGE;

/** What a person's memory calls each section: personal words, not a project's. */
const MEMORY_LABELS: Record<BriefSectionKey, string> = {
  overview: 'About you',
  rules: 'Always and never',
  decisions: 'Decisions',
  links: 'Links',
  glossary: 'Words you use',
  history: 'What happened',
};

/** Who edits each scope, for a reader who cannot. */
const WHO_EDITS: Record<ScopeRef['scope_type'], string> = {
  workspace: 'Owners and people who manage settings edit company knowledge.',
  group: 'Whoever manages groups, and group members who manage project context, edit this.',
  project: 'People who manage project context edit the brief.',
  initiative: 'People who manage project context edit this brief.',
  agent: 'The agent and the people who manage it edit these notes.',
  member: 'Only you and your assistant edit this.',
};

/** The writes a brief makes: to the server, or to the demo's copy. */
interface BriefWriter {
  add: (section: BriefSectionKey, content: string, pinned: boolean) => Promise<void>;
  patch: (entry: BriefEntry, patch: { content?: string; pinned?: boolean; section?: BriefSectionKey; checked?: true }) => Promise<void>;
  remove: (entry: BriefEntry) => Promise<void>;
}

function projectWriter(projectId: string, demo: boolean): BriefWriter {
  const call = async (path: string, method: string, body?: unknown) => {
    await workspaceApi(`/api/workspace/projects/${encodeURIComponent(projectId)}/brief${path}`, { method, body });
  };
  if (demo) {
    return {
      add: async (section, content, pinned) => demoAddEntry({ scope_type: 'project', scope_id: projectId }, { section, content, pinned }),
      patch: async (entry, patch) => demoPatchEntry(entry.id, patch),
      remove: async (entry) => demoPatchEntry(entry.id, { is_active: false }),
    };
  }
  return {
    add: (section, content, pinned) => call('', 'POST', { section, content, pinned }),
    patch: (entry, patch) => call(`/${entry.id}`, 'PATCH', patch),
    remove: (entry) => call(`/${entry.id}`, 'DELETE'),
  };
}

function scopeWriter(scope: ScopeRef, demo: boolean): BriefWriter {
  const query = scope.scope_id ? `?scope_id=${encodeURIComponent(scope.scope_id)}` : '';
  const call = async (path: string, method: string, body?: unknown) => {
    await workspaceApi(`/api/workspace/context/${scope.scope_type}${path}${query}`, { method, body });
  };
  if (demo) {
    return {
      add: async (section, content, pinned) => demoAddEntry(scope, { section, content, pinned }),
      patch: async (entry, patch) => demoPatchEntry(entry.id, patch),
      remove: async (entry) => demoPatchEntry(entry.id, { is_active: false }),
    };
  }
  return {
    add: (section, content, pinned) => call('', 'POST', { section, content, pinned }),
    patch: (entry, patch) => call(`/${entry.id}`, 'PATCH', patch),
    remove: (entry) => call(`/${entry.id}`, 'DELETE'),
  };
}

/**
 * The actions every brief list shares, each answering whether it worked:
 * optimistic on screen, the server's answer replacing it (or, in the demo,
 * the demo's copy reread).
 */
function useBriefActions(writer: BriefWriter, patchLocal: (id: string, patch: Partial<BriefEntry> | null) => void, words: { removeFail: string }) {
  const run = async (fn: () => Promise<void>, fail: string): Promise<boolean> => {
    try {
      await fn();
      invalidateTables(['project_context']);
      return true;
    } catch (error) {
      invalidateTables(['project_context']);
      toast('error', error instanceof Error ? error.message : fail);
      return false;
    }
  };
  return {
    onPin: (entry: BriefEntry) => {
      patchLocal(entry.id, { pinned: !entry.pinned });
      void run(() => writer.patch(entry, { pinned: !entry.pinned }), 'Could not pin it');
    },
    onSave: (entry: BriefEntry, content: string) => {
      patchLocal(entry.id, { content, source: 'human', updated_at: new Date().toISOString() });
      return run(() => writer.patch(entry, { content }), 'Could not save it');
    },
    onCheck: (entry: BriefEntry) => {
      patchLocal(entry.id, { source: 'human' });
      void run(() => writer.patch(entry, { checked: true }), 'Could not mark it checked');
    },
    onMove: (entry: BriefEntry, section: BriefSectionKey) => {
      patchLocal(entry.id, null);
      void run(() => writer.patch(entry, { section }), 'Could not move it');
    },
    onDelete: (entry: BriefEntry) => {
      patchLocal(entry.id, null);
      void run(() => writer.remove(entry), words.removeFail);
    },
    onAdd: (section: BriefSectionKey, content: string, pin: boolean) => run(() => writer.add(section, content, pin), 'Could not add it'),
  };
}

type BriefActions = ReturnType<typeof useBriefActions>;

export function BriefTab({ projectId }: { projectId: string }) {
  const { projectGoals } = useApp();
  const { access } = useAuth();
  const { isDemoMode } = useDemo();
  const read = isDemoMode ? demoProjectBriefRead(projectId) : projectBriefRead(projectId);
  const brief = useRead(read);
  const canEdit = hasPermission(access, 'project_context.manage');
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
  const reach = pinnedReach(all, brief.data?.pinned_total);
  const fromAgents = Math.max(brief.data?.agent_total ?? 0, all.filter((e) => e.source === 'agent').length);

  // Optimistic: the brief changes on screen at once and the server's answer replaces it.
  const patchLocal = (id: string, patch: Partial<BriefEntry> | null) => setReadData<ProjectBrief>(read, (current) => ({
    ...(current ?? { goals: [], omitted: [] }),
    goals: current?.goals ?? [],
    omitted: current?.omitted ?? [],
    sections: (current?.sections ?? []).map((s) => ({
      ...s,
      entries: patch === null ? s.entries.filter((e) => e.id !== id) : s.entries.map((e) => (e.id === id ? { ...e, ...patch } : e)),
    })),
  }));
  const actions = useBriefActions(projectWriter(projectId, isDemoMode), patchLocal, { removeFail: 'Could not archive it' });

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
    ? (isDemoMode ? demoSearchEntries({ scope_type: 'project', scope_id: projectId }, debounced) : search.data ?? all.filter((e) => e.content.toLowerCase().includes(debounced.toLowerCase())))
    : [];
  const rowProps = { canEdit, actions, reach, onDelete: setDeleting, sections: BRIEF_SECTIONS };

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
              <span className="text-xs tabular-nums text-zinc-500">{Math.max(s.total ?? 0, s.entries.length) || ''}</span>
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
                  pinnedReachLine(reach.pinned),
                  fromAgents ? `${fromAgents} written by agents, check ${fromAgents === 1 ? 'it' : 'them'}` : null,
                ].filter(Boolean).join(' · ')}
          </p>
          <div className="w-full sm:w-72">
            <TextInput type="search" aria-label="Search the brief" placeholder="Search the brief" value={q} onChange={setQ} leftIcon={Search} clearable />
          </div>
        </div>
        {(!canEdit || !canEditGoals) && (
          <p className="mt-2 text-xs text-zinc-500">
            {!canEdit && !canEditGoals
              ? 'Read only for you. People who manage project context edit the brief; people who manage goals edit Goals.'
              : !canEdit
                ? 'You can change Goals. People who manage project context edit the rest of the brief.'
                : isDemoMode ? 'Goals are read only in the demo.' : 'People who manage goals edit Goals; you edit the rest of the brief.'}
          </p>
        )}
        {isDemoMode && canEdit && <p className="mt-1 text-xs text-zinc-500">Demo: changes here show at once and last until you reload.</p>}

        {searching ? (
          <section aria-label="Search results" className="mt-6">
            <p className="text-xs text-zinc-500" aria-live="polite">{results.length} {results.length === 1 ? 'match' : 'matches'}{search.loading ? ', searching' : ''}</p>
            <ul className="mt-3 space-y-2">
              {results.slice(0, 50).map((entry) => <EntryRow key={entry.id} entry={entry} {...rowProps} />)}
            </ul>
          </section>
        ) : (
          <div className="mt-6 space-y-10">
            <GoalsSection projectId={projectId} goals={goals} canEdit={canEditGoals} />
            {sections.map((section) => (
              <SectionBlock
                key={section.key}
                pageRead={(key, page) => projectBriefSectionRead(projectId, key, page, BRIEF_SERVER_PAGE)}
                section={section}
                hint={BRIEF_SECTIONS.find((s) => s.key === section.key)?.hint}
                rowProps={rowProps}
                emptyText={canEdit ? 'Nothing here yet. Add what an agent new to this project should know.' : 'Nothing here yet.'}
              />
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        isOpen={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => { if (deleting) actions.onDelete(deleting); setDeleting(null); }}
        title="Archive this entry?"
        message="Agents stop seeing it, and it leaves the brief. It cannot be brought back."
        confirmLabel="Archive"
        variant="danger"
        doubleConfirm={false}
      />
    </div>
  );
}

/** How a scope's entries are worded where they differ from a project brief's. */
interface EntryWords {
  deleteLabel?: string;
  pinLabels?: { pin: string; unpin: string };
  pinLabel?: string;
  /** Who reads pinned entries: "agents", "the agent", "your assistant". */
  reader?: string;
}

interface RowProps {
  canEdit: boolean;
  actions: BriefActions;
  reach: PinnedReach;
  onDelete: (entry: BriefEntry) => void;
  sections: { key: BriefSectionKey; label: string }[];
  words?: EntryWords;
}

function SectionBlock({ pageRead, section, hint, emptyText, rowProps, canAdd = rowProps.canEdit }: {
  /** A section's server page (from 2): the project's brief, or a scope's. */
  pageRead: (section: string, page: number) => Read<BriefEntry[]>;
  section: BriefSection;
  emptyText: string;
  hint?: string;
  rowProps: RowProps;
  /** Offer Add here (a person's memory has one Add above every section instead). */
  canAdd?: boolean;
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
        {canAdd && !adding && (
          <Button variant="ghost" size="sm" icon={<Plus size={13} aria-hidden="true" />} onClick={() => setAdding(true)}>Add</Button>
        )}
      </div>
      {adding && (
        <NewEntry
          pinLabel={rowProps.words?.pinLabel}
          onCancel={() => setAdding(false)}
          onSubmit={async (content, pin) => { if (await rowProps.actions.onAdd(section.key, content, pin)) setAdding(false); }}
        />
      )}
      {section.entries.length === 0 && !adding ? (
        <p className="mt-3 rounded-xl bg-white/[0.02] px-4 py-3 text-sm text-zinc-500">{emptyText}</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {shown.map((entry) => <EntryRow key={entry.id} entry={entry} {...rowProps} />)}
        </ul>
      )}
      {hidden === 0 && Array.from({ length: serverPages }, (_, i) => (
        <SectionPage key={i} read={pageRead(section.key, i + 2)} render={(entry) => <EntryRow key={entry.id} entry={entry} {...rowProps} />} />
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
function SectionPage({ read, render }: {
  /** The server's page, from 2 (the brief read holds page 1). */
  read: Read<BriefEntry[]>;
  render: (entry: BriefEntry) => React.ReactNode;
}) {
  const page = useRead(read);
  if (page.loading) return <Skeleton label="Loading more" className="mt-2 space-y-2"><Bone className="h-14 w-full rounded-xl" /><Bone className="h-14 w-full rounded-xl" /></Skeleton>;
  if (page.failed) return <p role="alert" className="mt-2 text-sm text-red-300">Could not load more. <button type="button" className="underline" onClick={page.reload}>Try again</button></p>;
  return <ul className="mt-2 space-y-2">{orderBriefEntries(page.data ?? []).map(render)}</ul>;
}

function EntryRow({ entry, canEdit, actions, reach, onDelete, sections, words }: RowProps & { entry: BriefEntry }) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const clampable = needsClamp(entry.content);
  const [draft, setDraft] = useState(entry.content);
  const byAgent = entry.source === 'agent';
  const stale = isStale(entry.updated_at);
  const reader = words?.reader ?? 'agents';
  const beyond = entry.pinned && reach.beyond.has(entry.id);
  const cut = entry.pinned && reach.cut.has(entry.id);
  const deleteLabel = words?.deleteLabel ?? 'Archive';
  const moveTo = sections.filter((s) => s.key !== entry.section);

  const save = async () => {
    setSaving(true);
    // A failed save keeps the editor open with what was typed.
    if (await actions.onSave(entry, draft.trim())) setEditing(false);
    setSaving(false);
  };

  const menu: RowAction[] = [
    { label: 'Edit', icon: <Pencil size={14} />, onClick: () => { setDraft(entry.content); setEditing(true); } },
    ...(byAgent ? [{ label: 'Mark checked', icon: <Check size={14} />, onClick: () => actions.onCheck(entry) }] : []),
    ...moveTo.map((s, i) => ({ label: `Move to ${s.label}`, icon: <CornerDownRight size={14} />, divider: i === 0, onClick: () => actions.onMove(entry, s.key) })),
    { label: deleteLabel, icon: deleteLabel === 'Delete' ? <Trash2 size={14} /> : <Archive size={14} />, variant: 'danger', divider: true, onClick: () => onDelete(entry) },
  ];

  return (
    <li className={`group rounded-xl px-4 py-3 transition-colors ${entry.pinned && !beyond ? 'bg-brand-500/[0.07]' : 'bg-white/[0.025] hover:bg-white/[0.04]'}`}>
      {editing ? (
        <div>
          <Textarea aria-label="Entry" value={draft} onChange={setDraft} rows={4} maxLength={CONTENT_MAX} disabled={saving} />
          <div className="mt-2 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => { setDraft(entry.content); setEditing(false); }} disabled={saving}>Cancel</Button>
            <Button size="sm" disabled={!draft.trim() || draft === entry.content || saving} onClick={() => void save()}>{saving ? 'Saving' : 'Save'}</Button>
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
              {entry.pinned && !beyond && <span className="inline-flex items-center gap-1 text-brand-300"><Pin size={11} aria-hidden="true" />Pinned</span>}
              {beyond && (
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/[0.14] px-1.5 py-0.5 text-amber-300">
                  <Pin size={11} aria-hidden="true" />Pinned, past the newest {PINNED_REACH.perScope}: {reader} find it by search
                </span>
              )}
              {cut && <span className="text-amber-300">Long: {reader} see the first {PINNED_REACH.entry} characters</span>}
              {byAgent && (
                <span className="inline-flex items-center gap-1 rounded-full bg-sky-500/[0.14] px-1.5 py-0.5 text-sky-300">
                  <Bot size={11} aria-hidden="true" />Written by an agent, check it
                </span>
              )}
              {byAgent && canEdit && (
                <button type="button" onClick={() => actions.onCheck(entry)} className="rounded font-medium text-brand-300 hover:text-brand-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
                  Mark checked
                </button>
              )}
              <span className={stale ? 'text-amber-300' : ''}>{freshnessLabel(entry.updated_at)}{stale ? ', may be out of date' : ''}</span>
              {entry.file_path && <span className="font-mono">{entry.file_path}</span>}
            </p>
          </div>
          {canEdit && (
            <div className="flex flex-shrink-0 items-center gap-0.5 opacity-100 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
              <button
                type="button"
                onClick={() => actions.onPin(entry)}
                aria-pressed={entry.pinned}
                aria-label={entry.pinned
                  ? words?.pinLabels?.unpin ?? 'Unpin: agents find it by search'
                  : words?.pinLabels?.pin ?? `Pin: agents always see it (the newest ${PINNED_REACH.perScope})`}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                {entry.pinned ? <PinOff size={14} aria-hidden="true" /> : <Pin size={14} aria-hidden="true" />}
              </button>
              <RowActionsMenu label="Entry actions" actions={menu} />
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function NewEntry({ onCancel, onSubmit, pinLabel = `Pin: agents always see it (the newest ${PINNED_REACH.perScope})`, sections }: {
  onCancel: () => void;
  onSubmit: (content: string, pinned: boolean, section?: BriefSectionKey) => Promise<void>;
  pinLabel?: string;
  /** Offer a section to put it in (a person's memory has one Add for all). */
  sections?: { key: BriefSectionKey; label: string }[];
}) {
  const [content, setContent] = useState('');
  const [pinned, setPinned] = useState(false);
  const [section, setSection] = useState<BriefSectionKey>(sections?.[0]?.key ?? 'overview');
  const [busy, setBusy] = useState(false);
  return (
    <div className="animate-slideDown mt-3 rounded-xl bg-white/[0.03] p-3 ring-1 ring-inset ring-white/[0.08]">
      {sections && (
        <div className="mb-3 max-w-xs">
          <Select label="Where it goes" value={section} onChange={(v) => setSection(v as BriefSectionKey)} options={sections.map((s) => ({ value: s.key, label: s.label }))} />
        </div>
      )}
      <Textarea aria-label="New entry" value={content} onChange={setContent} rows={3} maxLength={CONTENT_MAX} placeholder="One fact, rule or decision. Plain words." autoFocus />
      <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
        <Toggle size="sm" checked={pinned} onChange={setPinned} label={pinLabel} />
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button size="sm" disabled={!content.trim() || busy} icon={<Check size={13} aria-hidden="true" />} onClick={async () => { setBusy(true); await onSubmit(content.trim(), pinned, section); setBusy(false); }}>
            Add
          </Button>
        </div>
      </div>
    </div>
  );
}

const GOAL_STATUS_TONE: Record<ProjectGoal['status'], string> = {
  active: 'bg-emerald-500/[0.14] text-emerald-200',
  achieved: 'bg-sky-500/[0.14] text-sky-300',
  paused: 'bg-amber-500/[0.14] text-amber-300',
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

const SCOPE_ENTRY_WORDS: Record<ScopeRef['scope_type'], EntryWords> = {
  workspace: { pinLabels: { pin: `Pin: every agent always sees it (the newest ${PINNED_REACH.perScope})`, unpin: 'Unpin: agents find it by search' }, pinLabel: `Pin for every agent (the newest ${PINNED_REACH.perScope} reach them)` },
  group: { pinLabels: { pin: `Pin: the group's agents always see it (the newest ${PINNED_REACH.perScope})`, unpin: 'Unpin: agents find it by search' }, pinLabel: `Pin for the group's agents (the newest ${PINNED_REACH.perScope} reach them)` },
  project: {},
  initiative: { pinLabels: { pin: `Pin: agents on its tasks always see it (the newest ${PINNED_REACH.perScope})`, unpin: 'Unpin: agents find it by search' }, pinLabel: `Pin for agents on its tasks (the newest ${PINNED_REACH.perScope} reach them)` },
  agent: { reader: 'the agent', pinLabels: { pin: `Pin: the agent always sees it (the newest ${PINNED_REACH.perScope})`, unpin: 'Unpin: the agent finds it by search' }, pinLabel: `Pin: the agent always sees it (the newest ${PINNED_REACH.perScope})` },
  member: {
    reader: 'your assistant',
    deleteLabel: 'Delete',
    pinLabels: { pin: 'Pin: your assistant always keeps it in mind', unpin: 'Unpin: your assistant finds it when it needs it' },
    pinLabel: 'Always keep this in mind',
  },
};

/**
 * Context beyond a project, built from the brief's own pieces: company
 * knowledge (workspace), a group's knowledge, an agent's notes, an
 * initiative's brief, or what a person's assistant remembers. The server
 * decides who reads and who edits (can_edit); a reader who cannot edit is
 * told who does. Deleting from a person's memory deletes, everything else is
 * archived. The newest pinned entries go into the context of the agents the
 * scope reaches (the screen says which are past the limit); the rest are
 * found by search. A person's memory has one Add for every section, in its
 * own words. Company and group knowledge work in the demo on its own copy.
 */
export function ContextBrief({ scope, emptyText, label }: {
  scope: ScopeRef;
  /** What an empty list says to someone who can add to it. */
  emptyText?: string;
  /** What the search box and messages call the scope ("company knowledge"). */
  label?: string;
}) {
  const { isDemoMode } = useDemo();
  const demoReady = isDemoMode && (scope.scope_type === 'workspace' || scope.scope_type === 'group');
  const read = demoReady ? demoScopedBriefRead(scope) : scopedBriefRead(scope);
  const brief = useRead(isDemoMode && !demoReady ? null : read);
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(q.trim()), 250);
    return () => window.clearTimeout(t);
  }, [q]);
  const search = useRead(debounced.length >= 2 && !isDemoMode ? scopedBriefSearchRead(scope, debounced) : null);
  const [deleting, setDeleting] = useState<BriefEntry | null>(null);
  const [addingMemory, setAddingMemory] = useState(false);
  const words = SCOPE_ENTRY_WORDS[scope.scope_type];
  const memory = scope.scope_type === 'member';
  const name = label ?? SCOPE_WORDS[scope.scope_type].label.toLowerCase();
  const canEdit = brief.data?.can_edit === true;

  const sections: BriefSection[] = useMemo(() => {
    const byKey = new Map((brief.data?.sections ?? []).map((s) => [s.key, s]));
    return BRIEF_SECTIONS.map((s): BriefSection => {
      const found = byKey.get(s.key) ?? { key: s.key, label: s.label, entries: [], total: 0 };
      return memory ? { ...found, label: MEMORY_LABELS[s.key] } : found;
    });
  }, [brief.data, memory]);
  const all = sections.flatMap((s) => s.entries);
  const totalEntries = sections.reduce((n, s) => n + Math.max(s.total ?? 0, s.entries.length), 0);
  const reach = pinnedReach(all, brief.data?.pinned_total);
  const updated = newestUpdate(all);

  const patchLocal = (id: string, patch: Partial<BriefEntry> | null) => setReadData<ScopedBrief>(read, (current) => ({
    ...(current ?? { scope, name: null, can_edit: false }),
    scope: current?.scope ?? scope,
    name: current?.name ?? null,
    can_edit: current?.can_edit ?? false,
    sections: (current?.sections ?? []).map((s) => ({
      ...s,
      entries: patch === null ? s.entries.filter((e) => e.id !== id) : s.entries.map((e) => (e.id === id ? { ...e, ...patch } : e)),
    })),
  }));
  const actions = useBriefActions(scopeWriter(scope, demoReady), patchLocal, { removeFail: memory ? 'Could not delete it' : 'Could not archive it' });

  if (isDemoMode && !demoReady) return <p className="py-6 text-sm text-zinc-400">This is not part of the demo.</p>;
  if (brief.loading) {
    return (
      <Skeleton label={`Loading ${name}`} className="space-y-6">
        {[0, 1].map((i) => <div key={i} className="space-y-3"><Bone className="h-4 w-40" /><Bone className="h-14 w-full rounded-xl" /></div>)}
      </Skeleton>
    );
  }
  if (brief.failed) {
    return (
      <div role="alert" className="flex flex-col items-center gap-3 py-10 text-center">
        <AlertTriangle size={24} className="text-red-400" aria-hidden="true" />
        <p className="text-sm text-zinc-300">Could not load {name}.</p>
        <Button variant="secondary" size="sm" icon={<RefreshCw size={13} aria-hidden="true" />} onClick={brief.reload}>Try again</Button>
      </div>
    );
  }

  const searching = debounced.length >= 2;
  const results = searching
    ? (demoReady ? demoSearchEntries(scope, debounced) : search.data ?? all.filter((e) => e.content.toLowerCase().includes(debounced.toLowerCase())))
    : [];
  // A person's memory shows only the sections that hold something (one Add serves them all); so does a scope the reader cannot add to.
  const shownSections = canEdit && !memory ? sections : sections.filter((s) => s.entries.length > 0);
  const rowProps: RowProps = { canEdit, actions, reach, onDelete: setDeleting, sections: sections.map((s) => ({ key: s.key, label: s.label })), words };
  const pinnedLine = memory ? (reach.pinned ? `${reach.pinned} pinned` : null) : pinnedReachLine(reach.pinned)?.replace('agents', words.reader ?? 'agents') ?? null;

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-zinc-400">
          {totalEntries === 0
            ? 'Nothing written yet.'
            : [
                `${totalEntries} ${totalEntries === 1 ? 'entry' : 'entries'}`,
                updated ? freshnessLabel(updated) : null,
                pinnedLine,
              ].filter(Boolean).join(' · ')}
        </p>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          {totalEntries > 0 && (
            <div className="w-full sm:w-72">
              <TextInput type="search" aria-label={`Search ${name}`} placeholder={`Search ${name}`} value={q} onChange={setQ} leftIcon={Search} clearable />
            </div>
          )}
          {memory && canEdit && !addingMemory && (
            <Button variant="secondary" size="sm" icon={<Plus size={13} aria-hidden="true" />} onClick={() => setAddingMemory(true)}>Add something to remember</Button>
          )}
        </div>
      </div>
      {!canEdit && <p className="mt-2 text-xs text-zinc-500">Read only for you. {WHO_EDITS[scope.scope_type]}</p>}
      {demoReady && canEdit && <p className="mt-1 text-xs text-zinc-500">Demo: changes here show at once and last until you reload.</p>}
      {memory && addingMemory && (
        <NewEntry
          pinLabel={words.pinLabel}
          sections={sections.map((s) => ({ key: s.key, label: s.label }))}
          onCancel={() => setAddingMemory(false)}
          onSubmit={async (content, pin, section) => { if (await actions.onAdd(section ?? 'overview', content, pin)) setAddingMemory(false); }}
        />
      )}

      {searching ? (
        <section aria-label="Search results" className="mt-5">
          <p className="text-xs text-zinc-500" aria-live="polite">{results.length} {results.length === 1 ? 'match' : 'matches'}{search.loading ? ', searching' : ''}</p>
          <ul className="mt-3 space-y-2">
            {results.slice(0, 50).map((entry) => <EntryRow key={entry.id} entry={entry} {...rowProps} />)}
          </ul>
        </section>
      ) : shownSections.length === 0 ? (
        <p className="mt-4 rounded-xl bg-white/[0.02] px-4 py-3 text-sm text-zinc-500">{canEdit && emptyText ? emptyText : 'Nothing here yet.'}</p>
      ) : (
        <div className="mt-5 space-y-8">
          {shownSections.map((section) => (
            <SectionBlock
              key={section.key}
              pageRead={(key, page) => scopedBriefSectionRead(scope, key, page, BRIEF_SERVER_PAGE)}
              section={section}
              hint={memory ? undefined : BRIEF_SECTIONS.find((s) => s.key === section.key)?.hint}
              rowProps={rowProps}
              canAdd={!memory && canEdit}
              emptyText="Nothing here yet."
            />
          ))}
        </div>
      )}

      <ConfirmDialog
        isOpen={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => { if (deleting) actions.onDelete(deleting); setDeleting(null); }}
        title={memory ? 'Delete this?' : 'Archive this entry?'}
        message={memory
          ? 'Your assistant forgets it, and it is deleted for good.'
          : 'Agents stop seeing it, and it leaves this list. It cannot be brought back.'}
        confirmLabel={memory ? 'Delete' : 'Archive'}
        variant="danger"
        doubleConfirm={false}
      />
    </div>
  );
}
