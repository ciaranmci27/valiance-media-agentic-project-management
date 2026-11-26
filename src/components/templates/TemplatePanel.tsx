'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown, ArrowUp, CalendarClock, ChevronDown, ChevronRight, CornerDownRight, LayoutTemplate, Plus, RefreshCw, Sparkles, Trash2, X,
} from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { invalidateTables, setReadData, useRead } from '@/lib/query-cache';
import { taskTemplateRead, taskTemplateRunsRead, TEMPLATE_TABLES } from '@/lib/reads';
import { workspaceApi, WorkspaceApiError } from '@/lib/agent-workspace';
import { timeAgo } from '@/lib/task-times';
import {
  DEFAULT_KEY_DATE, dueLabel, RUNNER, syncFields, taskCount, TEMPLATE_DESCRIPTION_MAX, TEMPLATE_GUIDANCE_MAX, TEMPLATE_ITEMS_MAX,
  TEMPLATE_KEY_DATES_MAX, TEMPLATE_LABEL_MAX, TEMPLATE_NAME_MAX, TEMPLATE_ROLES_MAX, TEMPLATE_SUBTASKS_MAX, TEMPLATE_TITLE_MAX,
  type TaskTemplateView, type TemplateField, type TemplateFieldType, type TemplateKeyDate, type TemplatePriority, type TemplateRole,
  type TemplateSubtask, type TemplateTask,
} from '@/lib/task-templates';
import {
  canWriteTemplateIn, daysOfParts, duePartsOf, freshItemKey, localTemplateIssues, uniqueKey, type DueWhen, type ScreenIssue,
} from '@/lib/template-ui';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Checkbox } from '@/components/ui/inputs/Checkbox';
import { MultiSelect } from '@/components/ui/inputs/MultiSelect';
import { NumberInput } from '@/components/ui/inputs/NumberInput';
import { Select, type SelectOption } from '@/components/ui/inputs/Select';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { Textarea } from '@/components/ui/inputs/Textarea';
import { toast } from '@/components/ui/Toast';
import { useDiscardGuard } from '@/components/ui/useDiscardGuard';
import { TaskPanelShell } from '@/components/tasks/TaskPanelShell';
import { PRIORITY_OPTIONS, TagsField } from '@/components/tasks/TaskFields';
import { ScopeChip } from './TemplateLibrary';

/** A new template's first draft (a starter), in the template's own shape. */
export interface TemplateDraft {
  name: string;
  description: string;
  project_id: string | null;
  guidance?: string;
  key_dates?: TemplateKeyDate[];
  roles?: TemplateRole[];
  fields: TemplateField[];
  items: TemplateTask[];
}

// ── The draft ───────────────────────────────────────────────────────────
// Tasks point at key dates and roles by their draft uid, so renaming a new
// key date (whose key follows its label until it is saved) never strands a
// task. Saved keys never change: past runs read their dates by key.

type DraftKeyDate = { uid: string; key: string; label: string; main: boolean; saved: boolean };
type DraftRole = { uid: string; key: string; label: string; required: boolean; default_member_id: string | null; saved: boolean };
type DraftSub = { uid: string; key?: string; title: string; description: string; priority: TemplatePriority; tags: string[];
  assignee: TemplateTask['assignee']; roleUid: string | null; anchorUid: string | null; due_in_days: number | null };
type DraftTask = DraftSub & { key: string; depends_on: string[]; subtasks: DraftSub[] };

const uid = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2));

interface Draft {
  name: string;
  description: string;
  projectId: string | null;
  guidance: string;
  keyDates: DraftKeyDate[];
  roles: DraftRole[];
  labels: TemplateField[];
  items: DraftTask[];
}

function draftOf(origin: TemplateDraft | TaskTemplateView | null, presetProject: string | null): Draft {
  const keyDates: DraftKeyDate[] = (origin?.key_dates?.length ? origin.key_dates : [DEFAULT_KEY_DATE])
    .map((k, i, all) => ({ uid: uid(), key: k.key, label: k.label, main: 'main' in k && k.main ? true : !all.some((x) => 'main' in x && x.main) && i === 0, saved: true }));
  const roles: DraftRole[] = (origin?.roles ?? []).map((r) => ({
    uid: uid(), key: r.key, label: r.label, required: !!r.required, default_member_id: r.default_member_id ?? null, saved: true,
  }));
  const anchorUid = (key: string | undefined) => (key ? keyDates.find((k) => k.key === key)?.uid ?? null : null);
  const roleUid = (key: string | null | undefined) => (key ? roles.find((r) => r.key === key)?.uid ?? null : null);
  const sub = (s: TemplateSubtask): DraftSub => ({
    uid: uid(), key: s.key, title: s.title, description: s.description ?? '', priority: s.priority ?? 'medium', tags: s.tags ?? [],
    assignee: s.assignee ?? null, roleUid: roleUid(s.role), anchorUid: anchorUid(s.anchor), due_in_days: s.due_in_days ?? null,
  });
  const taken = new Set<string>();
  const items: DraftTask[] = (origin?.items ?? []).map((task) => {
    const key = task.key ?? freshItemKey(taken);
    taken.add(key);
    return { ...sub(task), key, depends_on: task.depends_on ?? [], subtasks: (task.subtasks ?? []).map(sub) };
  });
  return {
    name: origin?.name ?? '',
    description: origin?.description ?? '',
    projectId: origin ? origin.project_id : presetProject,
    guidance: origin?.guidance ?? '',
    keyDates,
    roles,
    labels: origin?.fields ?? [],
    items: items.length ? items : [blankTask(new Set())],
  };
}

const blankSub = (): DraftSub => ({ uid: uid(), title: '', description: '', priority: 'medium', tags: [], assignee: null, roleUid: null, anchorUid: null, due_in_days: null });
const blankTask = (taken: ReadonlySet<string>): DraftTask => ({ ...blankSub(), key: freshItemKey(taken), depends_on: [], subtasks: [] });

/** The keys each key date and role will be saved with: saved ones keep theirs, new ones follow their label. */
function keysOf<T extends { uid: string; key: string; label: string; saved: boolean }>(list: readonly T[], fallback: string): Map<string, string> {
  const taken = new Set(list.filter((x) => x.saved).map((x) => x.key));
  const out = new Map<string, string>();
  for (const x of list) {
    if (x.saved) { out.set(x.uid, x.key); continue; }
    const key = uniqueKey(x.label, taken, fallback);
    taken.add(key);
    out.set(x.uid, key);
  }
  return out;
}

/** The template as it will be sent: what validate checks and save writes. */
function documentOf(draft: Draft) {
  const dateKeys = keysOf(draft.keyDates, 'date');
  const roleKeys = keysOf(draft.roles, 'role');
  const one = (task: DraftSub) => ({
    ...(task.key ? { key: task.key } : {}),
    title: task.title.trim(),
    description: task.description,
    priority: task.priority,
    tags: task.tags,
    assignee: task.roleUid ? null : task.assignee,
    due_in_days: task.due_in_days,
    ...(task.anchorUid && dateKeys.has(task.anchorUid) ? { anchor: dateKeys.get(task.anchorUid) } : {}),
    role: task.roleUid ? roleKeys.get(task.roleUid) ?? null : null,
  });
  const items = draft.items.map((task) => ({
    ...one(task),
    ...(task.depends_on.length ? { depends_on: task.depends_on } : {}),
    subtasks: task.subtasks.map(one),
  })) as TemplateTask[];
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    project_id: draft.projectId,
    guidance: draft.guidance,
    key_dates: draft.keyDates.map((k) => ({ key: dateKeys.get(k.uid) as string, label: k.label.trim(), ...(k.main ? { main: true } : {}) })),
    roles: draft.roles.map((r) => ({
      key: roleKeys.get(r.uid) as string, label: r.label.trim(),
      ...(r.required ? { required: true } : {}), ...(r.default_member_id ? { default_member_id: r.default_member_id } : {}),
    })),
    fields: syncFields(draft.labels, items),
    items,
  };
}

const move = <T,>(list: T[], from: number, to: number): T[] => {
  if (to < 0 || to >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
};

const ICON_BUTTON = 'rounded-md p-1 text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-100 disabled:opacity-30 disabled:hover:bg-transparent focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500';
const ADD_LINK = 'inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-zinc-300 transition-colors hover:bg-white/[0.06] hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500';
const FIELD_TYPES: { value: TemplateFieldType; label: string }[] = [
  { value: 'text', label: 'Text' }, { value: 'date', label: 'Date' }, { value: 'member', label: 'Person or agent' }, { value: 'choice', label: 'Choice' },
];
const DUE_WHEN: { value: DueWhen; label: string }[] = [
  { value: 'none', label: 'No due date' }, { value: 'on', label: 'On' }, { value: 'before', label: 'days before' }, { value: 'after', label: 'days after' },
];

// ── The panel ───────────────────────────────────────────────────────────

/**
 * A template in the side panel: open one to read it, and (where you may
 * write templates) change it; or set up a new one. A template is a name,
 * where it lives (company-wide or one project), its key dates, roles,
 * fill-in fields, a note for whoever runs it, and its tasks in order, each
 * due a number of days before or after a key date, done by a role or a
 * person, waiting on other tasks. Every change is checked as you type, with
 * each problem shown where it is; Save waits until there are none.
 */
export function TemplatePanel({ templateId, starter, projectId = null, onClose, onUse, onSchedule, onSaved }: {
  /** The template to open; null sets up a new one. */
  templateId: string | null;
  /** A new template's first draft (a starter). */
  starter?: TemplateDraft | null;
  /** A new template made from a project starts in it. */
  projectId?: string | null;
  onClose: () => void;
  /** Use this template now (opens its run). */
  onUse?: (templateId: string) => void;
  /** Run this template on a schedule (opens the schedule panel). */
  onSchedule?: (templateId: string) => void;
  onSaved?: (template: TaskTemplateView) => void;
}) {
  const { isDemoMode } = useDemo();
  const saved = useRead(templateId ? taskTemplateRead(templateId, isDemoMode) : null);
  if (templateId && !saved.data) {
    return (
      <TaskPanelShell labelledBy="template-title" onClose={onClose} header={<PanelHeader title={saved.failed ? 'Template' : 'Loading template'} onClose={onClose} />}>
        {saved.failed ? (
          <div role="alert" className="flex flex-col items-center gap-3 px-5 py-12 text-center">
            <p className="text-sm text-zinc-300">Could not open this template. It may be in Trash.</p>
            <Button variant="secondary" size="sm" icon={<RefreshCw size={13} aria-hidden="true" />} onClick={saved.reload}>Try again</Button>
          </div>
        ) : <div role="status" className="px-5 py-12 text-center text-sm text-zinc-400">Loading template</div>}
      </TaskPanelShell>
    );
  }
  return (
    <TemplateEditor
      // The id alone: a save by someone else updates it in place, never wiping edits in progress.
      key={saved.data?.id ?? 'new'}
      template={saved.data ?? null}
      starter={starter ?? null}
      presetProject={projectId}
      onClose={onClose}
      onUse={onUse}
      onSchedule={onSchedule}
      onSaved={onSaved}
    />
  );
}

function PanelHeader({ title, eyebrow, onClose }: { title: string; eyebrow?: string; onClose: () => void }) {
  return (
    <div className="flex items-start gap-3 px-5 pt-4 pb-3 flex-shrink-0">
      <div className="min-w-0 flex-1">
        {eyebrow && <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-zinc-400">{eyebrow}</p>}
        <h2 id="template-title" className="text-base font-semibold leading-snug text-white break-words">{title}</h2>
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.06] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        <X size={18} aria-hidden="true" />
      </button>
    </div>
  );
}

/** One hairline section of the form: a heading, a line on what it is for, then its fields. */
function Section({ id, title, description, aside, children }: { id: string; title: string; description?: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="border-t border-white/[0.06] pt-4">
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <h3 id={id} className="text-sm font-semibold text-white">{title}</h3>
        {aside}
      </div>
      {description && <p className="mb-3 text-xs text-zinc-400">{description}</p>}
      {children}
    </section>
  );
}

function ErrorLine({ message }: { message?: string | null }) {
  if (!message) return null;
  return <p role="alert" className="mt-1 text-xs text-red-300">{message}</p>;
}

function TemplateEditor({ template, starter, presetProject, onClose, onUse, onSchedule, onSaved }: {
  template: TaskTemplateView | null;
  starter: TemplateDraft | null;
  presetProject: string | null;
  onClose: () => void;
  onUse?: (templateId: string) => void;
  onSchedule?: (templateId: string) => void;
  onSaved?: (template: TaskTemplateView) => void;
}) {
  const { projects, team } = useApp();
  const { access } = useAuth();
  const { isDemoMode } = useDemo();
  // The demo shows the editor to try, with saving off, as on every demo page.
  const editable = template ? (template.can_edit ?? canWriteTemplateIn(access, template.project_id)) || isDemoMode : true;
  const [draft, setDraft] = useState<Draft>(() => draftOf(template ?? starter, presetProject));
  const set = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));
  const [open, setOpen] = useState<string | null>(() => (template ? null : draft.items[0]?.uid ?? null));
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [trashing, setTrashing] = useState(false);
  const runs = useRead(template ? taskTemplateRunsRead(template.id, isDemoMode) : null);

  const doc = useMemo(() => documentOf(draft), [draft]);
  const docKey = JSON.stringify(doc);
  const [baseline, setBaseline] = useState(docKey);
  const dirty = editable && !isDemoMode && docKey !== baseline;

  // Someone else saved it while it was open: with nothing changed here, show theirs.
  const seenVersion = useRef(template?.version);
  useEffect(() => {
    if (!template || template.version === seenVersion.current) return;
    seenVersion.current = template.version;
    if (dirty) return;
    const next = draftOf(template, null);
    setDraft(next);
    setBaseline(JSON.stringify(documentOf(next)));
  }, [template, dirty]);

  // Checked as you type: the rules here at once, the server's (the same
  // rules plus the workspace: projects, members) a moment later.
  const local = useMemo(() => localTemplateIssues(doc), [doc]);
  const [server, setServer] = useState<{ key: string; errors: ScreenIssue[]; canSave: boolean } | null>(null);
  useEffect(() => {
    if (!editable || isDemoMode) return;
    const controller = { cancelled: false };
    const timer = window.setTimeout(async () => {
      try {
        const result = await workspaceApi<{ valid: boolean; errors: ScreenIssue[]; can_save: boolean }>('/api/workspace/task-templates/validate', {
          method: 'POST', body: { template: doc, ...(template ? { template_id: template.id } : {}) },
        });
        if (!controller.cancelled) setServer({ key: docKey, errors: result.errors, canSave: result.can_save });
      } catch {
        // Offline or refused: the rules checked here still stand; save says what is wrong.
      }
    }, 450);
    return () => { controller.cancelled = true; window.clearTimeout(timer); };
  }, [docKey, editable, isDemoMode, template, doc]);
  const checked = server?.key === docKey;
  const issues = checked ? server.errors : local;
  const canSaveHere = checked ? server.canSave : true;

  // Empty required boxes stay quiet until a save is tried.
  const quiet = (issue: ScreenIssue) => !attempted && (issue.code === 'required' || /Name is required|needs a title|needs a label/.test(issue.message));
  const shown = issues.filter((issue) => !quiet(issue));
  const errorAt = (path: string) => {
    const found = shown.find((issue) => issue.path === path);
    if (!found) return undefined;
    if (found.cycle) {
      const titleOf = (key: string) => draft.items.find((t) => t.key === key)?.title.trim() || key;
      return `These tasks wait on each other in a loop: ${found.cycle.map(titleOf).join(', then ')}`;
    }
    return found.message;
  };
  const errorsUnder = (prefix: string) => shown.filter((issue) => issue.path === prefix || issue.path.startsWith(`${prefix}.`) || issue.path.startsWith(`${prefix}[`));

  const { requestClose, dialog: discardDialog } = useDiscardGuard(dirty, onClose,
    template ? 'Your edits to this template are not saved. Discarding them cannot be undone.' : 'This template is not saved yet. Discarding it cannot be undone.');

  // Who can do a task: whoever runs it, a role, a person or an agent.
  const people = team.filter((m) => m.status !== 'suspended').sort((a, b) => a.name.localeCompare(b.name));
  const memberOptions: SelectOption[] = [
    ...people.filter((m) => m.role !== 'agent').map((m) => ({ value: m.id, label: m.name, group: 'People' })),
    ...people.filter((m) => m.role === 'agent').map((m) => ({ value: m.id, label: m.name, group: 'Agents' })),
  ];
  const whoOptions: SelectOption[] = [
    { value: '', label: 'Nobody' },
    { value: RUNNER, label: 'Whoever runs it' },
    ...draft.roles.map((r) => ({ value: `role:${r.uid}`, label: r.label.trim() || 'Unnamed role', group: 'Roles' })),
    ...memberOptions,
  ];
  const whoValue = (task: DraftSub) => (task.roleUid ? `role:${task.roleUid}` : task.assignee ?? '');
  const whoPatch = (value: string): Partial<DraftSub> => (value.startsWith('role:')
    ? { roleUid: value.slice(5), assignee: null }
    : { roleUid: null, assignee: (value || null) as TemplateTask['assignee'] });
  const whoLabel = (task: DraftSub) => whoOptions.find((o) => o.value === whoValue(task))?.label ?? 'Someone';
  const anchorLabel = (task: DraftSub) => (draft.keyDates.find((k) => k.uid === task.anchorUid) ?? draft.keyDates[0])?.label.trim() || 'the key date';

  // Where it can live: company-wide (Manage templates) or a project you may write templates in.
  const scopeOptions: SelectOption[] = [
    ...(canWriteTemplateIn(access, null) || isDemoMode || !draft.projectId ? [{ value: '', label: 'Company-wide', detail: 'Usable in any project' }] : []),
    ...projects
      .filter((p) => (p.status !== 'archived' && (isDemoMode || canWriteTemplateIn(access, p.id))) || p.id === draft.projectId)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => ({ value: p.id, label: `Only in ${p.name}`, keywords: p.name, group: 'One project' })),
  ];

  const patchTask = (id: string, patch: Partial<DraftTask>) => set({ items: draft.items.map((t) => (t.uid === id ? { ...t, ...patch } : t)) });
  const patchSub = (taskId: string, subId: string, patch: Partial<DraftSub>) => set({
    items: draft.items.map((t) => (t.uid !== taskId ? t : { ...t, subtasks: t.subtasks.map((s) => (s.uid === subId ? { ...s, ...patch } : s)) })),
  });
  const removeTask = (task: DraftTask) => set({
    items: draft.items.filter((t) => t.uid !== task.uid).map((t) => ({ ...t, depends_on: t.depends_on.filter((key) => key !== task.key) })),
  });
  const removeKeyDate = (keyDate: DraftKeyDate) => {
    const rest = draft.keyDates.filter((k) => k.uid !== keyDate.uid);
    if (keyDate.main && rest.length) rest[0] = { ...rest[0], main: true };
    // Tasks that counted from it count from the first key date now.
    const strip = <T extends DraftSub>(task: T): T => (task.anchorUid === keyDate.uid ? { ...task, anchorUid: null } : task);
    set({ keyDates: rest, items: draft.items.map((t) => ({ ...strip(t), subtasks: t.subtasks.map(strip) })) });
  };
  const removeRole = (role: DraftRole) => {
    const strip = <T extends DraftSub>(task: T): T => (task.roleUid === role.uid ? { ...task, roleUid: null } : task);
    set({ roles: draft.roles.filter((r) => r.uid !== role.uid), items: draft.items.map((t) => ({ ...strip(t), subtasks: t.subtasks.map(strip) })) });
  };

  const total = taskCount(doc.items);
  const fields = doc.fields;
  const blocked = issues.length > 0 || !canSaveHere;

  const save = async () => {
    setAttempted(true);
    setFormError(null);
    if (blocked || busy || isDemoMode) return;
    setBusy(true);
    try {
      const result = template
        ? await workspaceApi<TaskTemplateView>(`/api/workspace/task-templates/${template.id}`, { method: 'PATCH', body: doc })
        : await workspaceApi<TaskTemplateView>('/api/workspace/task-templates', { method: 'POST', body: doc });
      setReadData(taskTemplateRead(result.id), () => result);
      invalidateTables([...TEMPLATE_TABLES]);
      setBaseline(docKey);
      toast('success', template ? 'Template saved' : `${result.name} is ready to use`);
      onSaved?.(result);
      onClose();
    } catch (error) {
      // A refusal lists every problem with its path, the same as validate.
      const details = error instanceof WorkspaceApiError ? (error.details as { errors?: ScreenIssue[] } | undefined) : undefined;
      if (details?.errors?.length) setServer({ key: docKey, errors: details.errors, canSave: true });
      setFormError(error instanceof Error ? error.message : 'Could not save the template');
    } finally {
      setBusy(false);
    }
  };

  const trash = async () => {
    if (!template) return;
    try {
      await workspaceApi(`/api/workspace/task-templates/${template.id}`, { method: 'DELETE' });
      invalidateTables([...TEMPLATE_TABLES]);
      toast('success', `${template.name} moved to Trash`);
      onClose();
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not move it to Trash');
    } finally {
      setTrashing(false);
    }
  };

  // Problems no box on screen shows (a duplicate key, say), listed at the foot.
  const placed = (path: string) => /^(name|description|guidance|project_id|items)$/.test(path)
    || /^(key_dates|roles|fields)\[\d+\]\.(label|main|default_member_id|options|type|key)$/.test(path)
    || /^items\[\d+\](\.subtasks\[\d+\])?\.(title|description|anchor|due_in_days|role|assignee|priority|tags|key)$/.test(path)
    || /^items\[\d+\]\.depends_on(\[\d+\])?$/.test(path);
  const stray = shown.filter((issue) => !placed(issue.path));

  if (!editable) return <TemplateReadView template={template as TaskTemplateView} onClose={onClose} onUse={onUse} onSchedule={onSchedule} runs={runs.data?.rows ?? null} />;

  // Only empty required boxes so far: a plain nudge, not a red count.
  const status = shown.length ? `${shown.length} ${shown.length === 1 ? 'problem' : 'problems'} to fix`
    : issues.length ? 'Fill in the required boxes'
    : isDemoMode ? 'The demo does not save templates'
      : !checked ? 'Checking'
        : !canSaveHere ? 'You cannot save a template here'
          : dirty || !template ? 'Ready to save' : 'No changes';

  return (
    <TaskPanelShell
      labelledBy="template-title"
      onClose={requestClose}
      header={<PanelHeader title={template ? 'Edit template' : 'New template'} eyebrow={template?.name} onClose={requestClose} />}
      footer={
        <div className="flex items-center justify-between gap-3 border-t border-white/[0.06] px-5 py-3">
          <div className="flex min-w-0 items-center gap-1">
            {template && !isDemoMode && (
              <button type="button" onClick={() => setTrashing(true)} aria-label={`Move ${template.name} to Trash`} className={`${ICON_BUTTON} p-1.5`}>
                <Trash2 size={15} aria-hidden="true" />
              </button>
            )}
            {shown.length > 0 ? (
              <button
                type="button"
                onClick={() => {
                  setAttempted(true);
                  window.setTimeout(() => document.querySelector('[data-template-editor] [role="alert"]')?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 30);
                }}
                className="truncate rounded text-xs font-medium text-red-300 underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                {status}
              </button>
            ) : <p className="truncate text-xs text-zinc-400" role="status">{status}</p>}
          </div>
          <div className="flex flex-shrink-0 items-center gap-2">
            {template && onSchedule && (
              <Button variant="secondary" size="sm" icon={<CalendarClock size={14} aria-hidden="true" />} onClick={() => onSchedule(template.id)} disabled={dirty} aria-label="Schedule">
                <span className="hidden sm:inline">Schedule</span>
              </Button>
            )}
            {template && onUse && (
              <Button variant="secondary" size="sm" icon={<LayoutTemplate size={14} aria-hidden="true" />} onClick={() => onUse(template.id)} disabled={dirty}>
                Use
              </Button>
            )}
            <Button size="sm" onClick={() => void save()} disabled={busy || (blocked && (shown.length > 0 || !canSaveHere)) || isDemoMode || (!!template && !dirty)}>
              {busy ? 'Saving' : template ? 'Save changes' : 'Create template'}
            </Button>
          </div>
        </div>
      }
      after={
        <>
          {template && (
            <ConfirmDialog
              isOpen={trashing}
              onClose={() => setTrashing(false)}
              onConfirm={() => void trash()}
              title={`Move ${template.name} to Trash?`}
              trash
              message="It leaves the library for everyone. Tasks it already made stay as they are, and it can be restored from Trash."
            />
          )}
          {discardDialog}
        </>
      }
    >
      <div data-template-editor className="space-y-5 px-5 pb-6">
        <div className="space-y-4">
          <TextInput label="Name *" value={draft.name} onChange={(name) => set({ name })} placeholder="Product launch" maxLength={TEMPLATE_NAME_MAX} error={errorAt('name')} autoFocus={!template} />
          <Textarea label="When to use it" value={draft.description} onChange={(description) => set({ description })} rows={2} autoResize maxLength={TEMPLATE_DESCRIPTION_MAX} placeholder="What this is for, so people pick the right one." error={errorAt('description')} />
          <Select
            label="Where it lives"
            visibleLabel="Where it lives"
            value={draft.projectId ?? ''}
            onChange={(value) => set({ projectId: value || null })}
            options={scopeOptions}
            searchable={scopeOptions.length > 8}
            description={draft.projectId ? 'Shows only in this project and always creates there.' : 'Any project can use it.'}
            error={errorAt('project_id')}
          />
        </div>

        <Section id="template-key-dates" title="Key dates" description="Due dates count from these. A run asks for each one; the main one is the initiative's target date.">
          <ul className="space-y-2">
            {draft.keyDates.map((keyDate, index) => (
              <li key={keyDate.uid}>
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <TextInput
                      size="sm"
                      value={keyDate.label}
                      onChange={(label) => set({ keyDates: draft.keyDates.map((k) => (k.uid === keyDate.uid ? { ...k, label } : k)) })}
                      placeholder="Launch date"
                      aria-label={`Key date ${index + 1} name`}
                      maxLength={TEMPLATE_LABEL_MAX}
                      error={errorAt(`key_dates[${index}].label`) ?? errorAt(`key_dates[${index}].key`)}
                    />
                  </div>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={keyDate.main}
                    onClick={() => set({ keyDates: draft.keyDates.map((k) => ({ ...k, main: k.uid === keyDate.uid })) })}
                    className={`h-7 flex-shrink-0 rounded-full px-2.5 text-[11px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
                      keyDate.main ? 'bg-brand-500/20 text-brand-200' : 'bg-white/[0.04] text-zinc-400 hover:bg-white/[0.07] hover:text-zinc-200'
                    }`}
                  >
                    {keyDate.main ? 'Main date' : 'Make main'}
                  </button>
                  <button type="button" onClick={() => removeKeyDate(keyDate)} disabled={draft.keyDates.length === 1} aria-label={`Remove ${keyDate.label || 'key date'}`} className={`${ICON_BUTTON} mt-1`}>
                    <X size={14} aria-hidden="true" />
                  </button>
                </div>
                <ErrorLine message={errorAt(`key_dates[${index}].main`)} />
              </li>
            ))}
          </ul>
          {draft.keyDates.length < TEMPLATE_KEY_DATES_MAX && (
            <button type="button" className={`${ADD_LINK} mt-1.5`} onClick={() => set({ keyDates: [...draft.keyDates, { uid: uid(), key: '', label: '', main: false, saved: false }] })}>
              <Plus size={13} aria-hidden="true" />Add key date
            </button>
          )}
        </Section>

        <Section id="template-roles" title="Roles" description="Give tasks to a role (Designer, Reviewer agent) instead of a person; each run picks who fills it.">
          {draft.roles.length === 0 && <p className="text-xs text-zinc-500">No roles. Tasks go to a person, or whoever runs it.</p>}
          <ul className="space-y-3">
            {draft.roles.map((role, index) => (
              <li key={role.uid} className="rounded-lg bg-white/[0.03] p-2.5">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <TextInput
                      size="sm"
                      value={role.label}
                      onChange={(label) => set({ roles: draft.roles.map((r) => (r.uid === role.uid ? { ...r, label } : r)) })}
                      placeholder="Designer"
                      aria-label={`Role ${index + 1} name`}
                      maxLength={TEMPLATE_LABEL_MAX}
                      error={errorAt(`roles[${index}].label`) ?? errorAt(`roles[${index}].key`)}
                    />
                  </div>
                  <button type="button" onClick={() => removeRole(role)} aria-label={`Remove ${role.label || 'role'}`} className={`${ICON_BUTTON} mt-1`}>
                    <X size={14} aria-hidden="true" />
                  </button>
                </div>
                <div className="mt-2 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
                  <Select
                    size="sm"
                    ariaLabel={`Default for ${role.label || 'this role'}`}
                    value={role.default_member_id ?? ''}
                    onChange={(value) => set({ roles: draft.roles.map((r) => (r.uid === role.uid ? { ...r, default_member_id: value || null } : r)) })}
                    options={[{ value: '', label: 'No default' }, ...memberOptions]}
                    searchable={memberOptions.length > 8}
                    error={errorAt(`roles[${index}].default_member_id`)}
                  />
                  <Checkbox
                    size="sm"
                    checked={role.required}
                    onChange={(required) => set({ roles: draft.roles.map((r) => (r.uid === role.uid ? { ...r, required } : r)) })}
                    label="Required"
                  />
                </div>
              </li>
            ))}
          </ul>
          {draft.roles.length < TEMPLATE_ROLES_MAX && (
            <button type="button" className={`${ADD_LINK} mt-1.5`} onClick={() => set({ roles: [...draft.roles, { uid: uid(), key: '', label: '', required: false, default_member_id: null, saved: false }] })}>
              <Plus size={13} aria-hidden="true" />Add role
            </button>
          )}
        </Section>

        <Section id="template-tasks" title="Tasks" aside={<span className="text-xs tabular-nums text-zinc-400">{total} {total === 1 ? 'task' : 'tasks'}</span>}
          description="In order. Type {client} in a title or description to ask for it on each run.">
          <ol className="space-y-2">
            {draft.items.map((task, index) => {
              const expanded = open === task.uid;
              const problems = errorsUnder(`items[${index}]`);
              const waits = task.depends_on.map((key) => draft.items.find((t) => t.key === key)?.title.trim() || 'a task');
              const summary = [
                whoLabel(task),
                dueLabel(task.due_in_days, task.due_in_days === null ? undefined : anchorLabel(task)),
                waits.length ? `waits on ${waits.join(', ')}` : null,
                task.subtasks.length ? `${task.subtasks.length} subtask${task.subtasks.length === 1 ? '' : 's'}` : null,
              ].filter(Boolean).join(' · ');
              return (
                <li key={task.uid} className={`rounded-lg ring-1 ${problems.length ? 'bg-red-500/[0.05] ring-red-500/25' : 'bg-white/[0.03] ring-white/[0.06]'}`}>
                  <div className="flex items-start gap-1.5 px-2 py-2">
                    <button type="button" onClick={() => setOpen(expanded ? null : task.uid)} aria-expanded={expanded} aria-label={expanded ? 'Hide details' : 'Show details'} className={`${ICON_BUTTON} mt-1.5`}>
                      {expanded ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronRight size={15} aria-hidden="true" />}
                    </button>
                    <div className="min-w-0 flex-1">
                      <TextInput
                        size="sm"
                        value={task.title}
                        onChange={(title) => patchTask(task.uid, { title })}
                        placeholder={index === 0 ? 'Write the launch brief' : 'Task title'}
                        aria-label={`Task ${index + 1} title`}
                        maxLength={TEMPLATE_TITLE_MAX}
                        error={errorAt(`items[${index}].title`)}
                      />
                      {!expanded && <p className="mt-1 truncate px-0.5 text-[11px] text-zinc-400">{summary}</p>}
                      {!expanded && problems.length > 0 && !errorAt(`items[${index}].title`) && <ErrorLine message={errorAt(problems[0].path) ?? problems[0].message} />}
                    </div>
                    <div className="mt-1 flex flex-shrink-0 items-center">
                      <button type="button" onClick={() => set({ items: move(draft.items, index, index - 1) })} disabled={index === 0} aria-label="Move up" className={ICON_BUTTON}><ArrowUp size={14} aria-hidden="true" /></button>
                      <button type="button" onClick={() => set({ items: move(draft.items, index, index + 1) })} disabled={index === draft.items.length - 1} aria-label="Move down" className={ICON_BUTTON}><ArrowDown size={14} aria-hidden="true" /></button>
                      <button type="button" onClick={() => removeTask(task)} disabled={draft.items.length === 1} aria-label="Remove task" className={ICON_BUTTON}><X size={14} aria-hidden="true" /></button>
                    </div>
                  </div>
                  {expanded && (
                    <div className="space-y-3 border-t border-white/[0.06] px-3 pb-3 pt-3">
                      <Textarea size="sm" label="Description" value={task.description} onChange={(description) => patchTask(task.uid, { description })} rows={2} autoResize maxLength={10_000} placeholder="Steps, links, anything worth knowing" error={errorAt(`items[${index}].description`)} />
                      <Select size="sm" label="Who does it" visibleLabel="Who does it" value={whoValue(task)} onChange={(value) => patchTask(task.uid, whoPatch(value))} options={whoOptions} searchable={whoOptions.length > 8}
                        error={errorAt(`items[${index}].role`) ?? errorAt(`items[${index}].assignee`)} />
                      <DueField task={task} keyDates={draft.keyDates} onChange={(patch) => patchTask(task.uid, patch)}
                        error={errorAt(`items[${index}].due_in_days`) ?? errorAt(`items[${index}].anchor`)} label={`Task ${index + 1}`} />
                      {draft.items.length > 1 && (
                        <div>
                          <MultiSelect
                            size="sm"
                            label="Waits on"
                            placeholder="Nothing"
                            value={task.depends_on}
                            onChange={(depends_on) => patchTask(task.uid, { depends_on })}
                            options={draft.items.filter((t) => t.uid !== task.uid).map((t) => ({ value: t.key, label: t.title.trim() || 'Untitled task' }))}
                            searchable={draft.items.length > 8}
                          />
                          <ErrorLine message={errorAt(`items[${index}].depends_on`) ?? task.depends_on.map((_, j) => errorAt(`items[${index}].depends_on[${j}]`)).find(Boolean)} />
                        </div>
                      )}
                      <div className="grid grid-cols-2 gap-2">
                        <Select
                          size="sm"
                          label="Priority"
                          visibleLabel="Priority"
                          value={task.priority}
                          onChange={(value) => patchTask(task.uid, { priority: value as TemplatePriority })}
                          options={PRIORITY_OPTIONS.map((option) => ({ value: option.value, label: option.label, icon: <span className={`h-2 w-2 rounded-full ${option.color}`} aria-hidden="true" /> }))}
                        />
                        <div>
                          <p className="mb-1.5 text-xs font-medium text-zinc-300">Tags</p>
                          <TagsField value={task.tags} onChange={(tags) => patchTask(task.uid, { tags })} canEdit />
                        </div>
                      </div>
                      <div>
                        <p className="mb-1.5 text-xs font-medium text-zinc-300">Subtasks</p>
                        <ul className="space-y-3">
                          {task.subtasks.map((subtask, j) => (
                            <li key={subtask.uid} className="flex items-start gap-1.5">
                              <CornerDownRight size={13} className="mt-2 flex-shrink-0 text-zinc-500" aria-hidden="true" />
                              <div className="min-w-0 flex-1 space-y-1.5">
                                <TextInput size="sm" value={subtask.title} onChange={(title) => patchSub(task.uid, subtask.uid, { title })} placeholder="Subtask title" aria-label="Subtask title" maxLength={TEMPLATE_TITLE_MAX}
                                  error={errorAt(`items[${index}].subtasks[${j}].title`)} />
                                <Select size="sm" ariaLabel="Who does the subtask" value={whoValue(subtask)} onChange={(value) => patchSub(task.uid, subtask.uid, whoPatch(value))} options={whoOptions} searchable={whoOptions.length > 8} />
                                <DueField task={subtask} keyDates={draft.keyDates} onChange={(patch) => patchSub(task.uid, subtask.uid, patch)} compact
                                  error={errorAt(`items[${index}].subtasks[${j}].due_in_days`) ?? errorAt(`items[${index}].subtasks[${j}].anchor`)} label="Subtask" />
                              </div>
                              <button type="button" onClick={() => patchTask(task.uid, { subtasks: task.subtasks.filter((s) => s.uid !== subtask.uid) })} aria-label="Remove subtask" className={`${ICON_BUTTON} mt-1.5`}><X size={14} aria-hidden="true" /></button>
                            </li>
                          ))}
                        </ul>
                        {task.subtasks.length < TEMPLATE_SUBTASKS_MAX && (
                          <button type="button" className={`${ADD_LINK} mt-1.5`} onClick={() => patchTask(task.uid, { subtasks: [...task.subtasks, { ...blankSub(), anchorUid: task.anchorUid }] })}>
                            <Plus size={13} aria-hidden="true" />Add subtask
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
          {draft.items.length < TEMPLATE_ITEMS_MAX && (
            <Button variant="secondary" size="sm" className="mt-2" icon={<Plus size={14} aria-hidden="true" />}
              onClick={() => { const next = blankTask(new Set(draft.items.map((t) => t.key))); set({ items: [...draft.items, next] }); setOpen(next.uid); }}>
              Add task
            </Button>
          )}
          <ErrorLine message={errorAt('items')} />
        </Section>

        {fields.length > 0 && (
          <Section id="template-fields" title="Asked on each run" description="Whoever runs it fills these in; they replace the words in braces.">
            <ul className="space-y-3">
              {fields.map((field, index) => {
                const setField = (patch: Partial<TemplateField>) => set({ labels: [...draft.labels.filter((f) => f.key !== field.key), { ...field, ...patch }] });
                return (
                  <li key={field.key} className="rounded-lg bg-white/[0.03] p-2.5">
                    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
                      <TextInput size="sm" label={`{${field.key}}`} value={field.label} onChange={(label) => setField({ label })} maxLength={60} error={errorAt(`fields[${index}].label`)} />
                      <Select size="sm" label="Type" visibleLabel="Type" value={field.type ?? 'text'}
                        onChange={(value) => setField({ type: value as TemplateFieldType, options: value === 'choice' ? field.options ?? [] : undefined })}
                        options={FIELD_TYPES} error={errorAt(`fields[${index}].type`)} />
                    </div>
                    {field.type === 'choice' && (
                      <div className="mt-2">
                        <p className="mb-1.5 text-xs font-medium text-zinc-300">Options</p>
                        <TagsField value={field.options ?? []} onChange={(options) => setField({ options })} canEdit />
                        <ErrorLine message={errorAt(`fields[${index}].options`)} />
                      </div>
                    )}
                    <div className="mt-2">
                      <Checkbox size="sm" checked={field.required !== false} onChange={(required) => setField({ required: required ? undefined : false })} label="Required" />
                    </div>
                  </li>
                );
              })}
            </ul>
          </Section>
        )}

        <Section id="template-guidance" title="Note for whoever runs it" description="Read by people on each run, and by agents over MCP before they draft one: what to look at, how to pick the dates.">
          <Textarea value={draft.guidance} onChange={(guidance) => set({ guidance })} rows={3} autoResize maxLength={TEMPLATE_GUIDANCE_MAX} placeholder="Set the launch date from the release plan." aria-label="Note for whoever runs it" error={errorAt('guidance')} />
        </Section>

        {template && <RecentRuns template={template} runs={runs.data?.rows ?? null} loading={runs.loading} />}

        {stray.length > 0 && (
          <div role="alert" className="rounded-lg bg-red-500/[0.08] px-3 py-2">
            <p className="text-xs font-medium text-red-200">Also fix</p>
            <ul className="mt-1 space-y-0.5 text-xs text-red-300">{stray.map((issue) => <li key={`${issue.path}:${issue.code}`}>{issue.message}</li>)}</ul>
          </div>
        )}
        {formError && <p role="alert" className="text-sm text-red-300">{formError}</p>}
      </div>
    </TaskPanelShell>
  );
}

/**
 * When a task is due, in words a person would say: "3 days before Launch
 * date", "On Kickoff", "No due date": a count, before or after, and which
 * key date it counts from.
 */
function DueField({ task, keyDates, onChange, error, label, compact = false }: {
  task: DraftSub;
  keyDates: DraftKeyDate[];
  onChange: (patch: Partial<DraftSub>) => void;
  error?: string;
  label: string;
  compact?: boolean;
}) {
  const parts = duePartsOf(task.due_in_days);
  const anchor = task.anchorUid && keyDates.some((k) => k.uid === task.anchorUid) ? task.anchorUid : keyDates[0]?.uid ?? '';
  const setParts = (when: DueWhen, count: number) => onChange({ due_in_days: daysOfParts(when, count) });
  return (
    <div>
      {!compact && <p className="mb-1.5 text-xs font-medium text-zinc-300">Due</p>}
      <div className="flex flex-wrap items-start gap-1.5">
        {(parts.when === 'before' || parts.when === 'after') && (
          <NumberInput size="sm" min={1} max={3650} value={parts.count} onChange={(value) => setParts(parts.when, value === '' ? 1 : value)} aria-label={`${label}: days`} className="w-20" />
        )}
        <Select size="sm" ariaLabel={`${label}: when it is due`} value={parts.when} onChange={(value) => setParts(value as DueWhen, parts.count)} options={DUE_WHEN} className="w-32" />
        {parts.when !== 'none' && (
          <Select
            size="sm"
            ariaLabel={`${label}: key date`}
            value={anchor}
            onChange={(value) => onChange({ anchorUid: value })}
            options={keyDates.map((k) => ({ value: k.uid, label: k.label.trim() || 'Unnamed key date' }))}
            className="min-w-0 flex-1 basis-32"
          />
        )}
      </div>
      <ErrorLine message={error} />
    </div>
  );
}

function RecentRuns({ template, runs, loading }: { template: TaskTemplateView; runs: { id: string; run_by_name: string | null; task_ids: string[]; project_name: string | null; created_at: string; via: string }[] | null; loading: boolean }) {
  return (
    <Section id="template-history" title="Recent runs">
      {loading ? <p role="status" className="text-xs text-zinc-400">Loading runs</p>
        : !runs?.length ? <p className="text-xs text-zinc-400">Not run yet.</p>
        : (
          <ul className="space-y-1.5">
            {runs.map((run) => (
              <li key={run.id} className="text-xs text-zinc-300">
                <span className="text-zinc-100">{run.run_by_name ?? 'Someone'}</span>
                {' made '}{run.task_ids.length || 'its'} {run.task_ids.length === 1 ? 'task' : 'tasks'}
                {run.project_name ? ` in ${run.project_name}` : ''}
                <span className="text-zinc-500"> · {timeAgo(run.created_at)}{run.via !== 'app' ? ` · ${run.via === 'mcp' ? 'MCP' : run.via === 'api' ? 'API' : 'Schedule'}` : ''}</span>
              </li>
            ))}
          </ul>
        )}
      <p className="mt-3 text-[11px] text-zinc-500">Version {template.version}{template.created_by_name ? `, set up by ${template.created_by_name}` : ''}.</p>
    </Section>
  );
}

/** A template for someone who may use it but not change it: what it makes, when, and by whom. */
function TemplateReadView({ template, onClose, onUse, onSchedule, runs }: {
  template: TaskTemplateView;
  onClose: () => void;
  onUse?: (templateId: string) => void;
  onSchedule?: (templateId: string) => void;
  runs: Parameters<typeof RecentRuns>[0]['runs'];
}) {
  const { team } = useApp();
  const keyDates: TemplateKeyDate[] = template.key_dates?.length ? template.key_dates : [{ ...DEFAULT_KEY_DATE }];
  const labelOfDate = (key?: string) => keyDates.find((k) => k.key === key)?.label ?? keyDates[0].label;
  const who = (task: TemplateSubtask) => (task.role ? template.roles?.find((r) => r.key === task.role)?.label ?? 'A role'
    : task.assignee === RUNNER ? 'Whoever runs it' : task.assignee ? team.find((m) => m.id === task.assignee)?.name ?? 'Someone' : 'Nobody');
  const line = (task: TemplateSubtask) => `${who(task)} · ${dueLabel(task.due_in_days ?? null, task.due_in_days === null ? undefined : labelOfDate(task.anchor))}`;
  return (
    <TaskPanelShell
      labelledBy="template-title"
      onClose={onClose}
      header={<PanelHeader title={template.name} eyebrow="Template" onClose={onClose} />}
      footer={onUse || onSchedule ? (
        <div className="flex items-center justify-between gap-3 border-t border-white/[0.06] px-5 py-3">
          <p className="truncate text-xs text-zinc-400">Ask whoever manages it to change it.</p>
          <div className="flex flex-shrink-0 items-center gap-2">
            {onSchedule && <Button variant="secondary" size="sm" icon={<CalendarClock size={14} aria-hidden="true" />} onClick={() => onSchedule(template.id)}>Schedule</Button>}
            {onUse && <Button size="sm" icon={<LayoutTemplate size={14} aria-hidden="true" />} onClick={() => onUse(template.id)}>Use</Button>}
          </div>
        </div>
      ) : undefined}
    >
      <div className="space-y-5 px-5 pb-6">
        <div className="space-y-2">
          <ScopeChip template={template} />
          {template.description && <p className="text-sm leading-relaxed text-zinc-300 whitespace-pre-line">{template.description}</p>}
        </div>
        {template.guidance && (
          <div className="flex gap-2 rounded-lg bg-white/[0.04] px-3 py-2.5 text-sm text-zinc-300">
            <Sparkles size={14} className="mt-0.5 flex-shrink-0 text-brand-300" aria-hidden="true" />
            <p className="whitespace-pre-line">{template.guidance}</p>
          </div>
        )}
        <Section id="template-read-dates" title="Key dates">
          <p className="text-sm text-zinc-300">{keyDates.map((k) => `${k.label}${k.main ? ' (main)' : ''}`).join(', ')}</p>
          {!!template.roles?.length && <p className="mt-1 text-xs text-zinc-400">Roles: {template.roles.map((r) => `${r.label}${r.required ? ' (required)' : ''}`).join(', ')}</p>}
        </Section>
        <Section id="template-read-tasks" title="Tasks" aside={<span className="text-xs tabular-nums text-zinc-400">{template.task_count}</span>}>
          <ol className="space-y-1.5">
            {template.items.map((task) => (
              <li key={task.key} className="rounded-lg bg-white/[0.03] px-3 py-2">
                <p className="text-sm font-medium text-zinc-100 break-words">{task.title}</p>
                <p className="mt-0.5 text-[11px] text-zinc-400">
                  {line(task)}
                  {task.depends_on?.length ? ` · waits on ${task.depends_on.map((key) => template.items.find((t) => t.key === key)?.title ?? key).join(', ')}` : ''}
                </p>
                {task.subtasks.length > 0 && (
                  <ul className="mt-1.5 space-y-1 border-t border-white/[0.06] pt-1.5">
                    {task.subtasks.map((subtask) => (
                      <li key={subtask.key} className="flex items-start gap-1.5">
                        <CornerDownRight size={12} className="mt-0.5 flex-shrink-0 text-zinc-500" aria-hidden="true" />
                        <span className="min-w-0 text-[13px] text-zinc-200">{subtask.title}<span className="block text-[11px] text-zinc-400">{line(subtask)}</span></span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        </Section>
        <RecentRuns template={template} runs={runs} loading={runs === null} />
      </div>
    </TaskPanelShell>
  );
}
