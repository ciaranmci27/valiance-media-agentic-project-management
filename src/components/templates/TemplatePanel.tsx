'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown, ArrowUp, ChevronDown, ChevronRight, CornerDownRight, LayoutTemplate, Lock, Plus, RefreshCw, Trash2, X,
} from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { canAccessProject, hasPermission } from '@/lib/access-control';
import { invalidateTables, setReadData, useRead } from '@/lib/query-cache';
import { taskTemplateRead, taskTemplateRunsRead, TEMPLATE_TABLES } from '@/lib/reads';
import { fieldErrorsFrom, workspaceApi } from '@/lib/agent-workspace';
import { timeAgo } from '@/lib/task-times';
import {
  dueLabel, RUNNER, syncFields, taskCount, TEMPLATE_DESCRIPTION_MAX, TEMPLATE_ITEMS_MAX, TEMPLATE_NAME_MAX, TEMPLATE_SUBTASKS_MAX,
  TEMPLATE_TASKS_MAX, TEMPLATE_TITLE_MAX, templateSizeLabel, type TaskTemplateView, type TemplateField, type TemplatePriority,
  type TemplateSubtask, type TemplateTask,
} from '@/lib/task-templates';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { NumberInput } from '@/components/ui/inputs/NumberInput';
import { Select } from '@/components/ui/inputs/Select';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { Textarea } from '@/components/ui/inputs/Textarea';
import { toast } from '@/components/ui/Toast';
import { TaskPanelShell } from '@/components/tasks/TaskPanelShell';
import { PRIORITY_OPTIONS, TagsField } from '@/components/tasks/TaskFields';

/** A task being edited, with a key that survives reordering. */
type DraftSubtask = TemplateSubtask & { uid: string };
type DraftTask = Omit<TemplateTask, 'subtasks'> & { uid: string; subtasks: DraftSubtask[] };

export interface TemplateDraft {
  name: string;
  description: string;
  project_id: string | null;
  fields: TemplateField[];
  items: TemplateTask[];
}

const uid = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2));
const blankTask = (): DraftTask => ({ uid: uid(), title: '', description: '', priority: 'medium', tags: [], assignee: null, due_in_days: null, subtasks: [] });
const blankSubtask = (): DraftSubtask => ({ uid: uid(), title: '', description: '', priority: 'medium', tags: [], assignee: null, due_in_days: null });
const toDraft = (items: readonly TemplateTask[]): DraftTask[] =>
  items.map((task) => ({ ...task, uid: uid(), subtasks: (task.subtasks ?? []).map((s) => ({ ...s, uid: uid() })) }));
const plainSubtask = (s: TemplateSubtask): TemplateSubtask => ({
  title: s.title.trim(), description: s.description, priority: s.priority, tags: s.tags, assignee: s.assignee, due_in_days: s.due_in_days,
});
const fromDraft = (items: readonly DraftTask[]): TemplateTask[] => items
  .filter((task) => task.title.trim())
  .map((task) => ({
    ...plainSubtask(task),
    subtasks: task.subtasks.filter((s) => s.title.trim()).map(plainSubtask),
  }));

/** What a save would send, to tell whether there is anything unsaved. */
const draftKey = (draft: { name: string; description: string; project_id: string | null; fields: readonly TemplateField[]; items: TemplateTask[] }) =>
  JSON.stringify({
    name: draft.name.trim(), description: draft.description.trim(), project_id: draft.project_id,
    fields: syncFields(draft.fields, draft.items), items: draft.items,
  });
const originKey = (origin: TemplateDraft | null) => draftKey({
  name: origin?.name ?? '', description: origin?.description ?? '', project_id: origin?.project_id ?? null,
  fields: origin?.fields ?? [], items: fromDraft(toDraft(origin?.items ?? [])),
});

const move = <T,>(list: T[], from: number, to: number): T[] => {
  if (to < 0 || to >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
};

const ICON_BUTTON = 'rounded-md p-1 text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-100 disabled:opacity-30 disabled:hover:bg-transparent focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500';

/**
 * A template in the side panel: open one to read it, and (with Manage
 * templates) change it; or set up a new one, from scratch or from a starter.
 * A template is a name, an optional project it is locked to, and its tasks
 * in order, each with optional subtasks, an assignee (a person, or whoever
 * uses it), and a due date counted in days from the start date. Typing
 * {client} in a title or description adds a "Client" box to fill in when it
 * is used.
 */
export function TemplatePanel({ templateId, starter, onClose, onUse, onSaved }: {
  /** The template to open; null sets up a new one. */
  templateId: string | null;
  /** A new template's first draft (a starter on the Templates page). */
  starter?: TemplateDraft | null;
  onClose: () => void;
  /** Use this template now (opens its Use panel). */
  onUse?: (templateId: string) => void;
  onSaved?: (template: TaskTemplateView) => void;
}) {
  const { access } = useAuth();
  const { isDemoMode } = useDemo();
  // The demo reads templates and uses them; setting them up is for a real workspace, as on every demo page.
  const canManage = !isDemoMode && hasPermission(access, 'templates.manage');
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
      canManage={canManage}
      onClose={onClose}
      onUse={onUse}
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

function TemplateEditor({ template, starter, canManage, onClose, onUse, onSaved }: {
  template: TaskTemplateView | null;
  starter: TemplateDraft | null;
  canManage: boolean;
  onClose: () => void;
  onUse?: (templateId: string) => void;
  onSaved?: (template: TaskTemplateView) => void;
}) {
  const { projects, team } = useApp();
  const { access } = useAuth();
  const origin = template ?? starter;
  const [name, setName] = useState(origin?.name ?? '');
  const [description, setDescription] = useState(origin?.description ?? '');
  const [projectId, setProjectId] = useState<string | null>(origin?.project_id ?? null);
  const [items, setItems] = useState<DraftTask[]>(() => (origin?.items.length ? toDraft(origin.items) : [blankTask()]));
  const [labels, setLabels] = useState<TemplateField[]>(origin?.fields ?? []);
  const [open, setOpen] = useState<string | null>(() => (origin ? null : items[0]?.uid ?? null));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [trashing, setTrashing] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const editable = canManage;
  // What was last loaded or saved: edits are measured against it.
  const [baseline, setBaseline] = useState(() => originKey(origin));
  const { isDemoMode } = useDemo();
  const runs = useRead(template ? taskTemplateRunsRead(template.id, isDemoMode) : null);

  const clean = useMemo(() => fromDraft(items), [items]);
  const fields = useMemo(() => syncFields(labels, clean), [labels, clean]);
  const total = taskCount(clean);
  const dirty = editable && draftKey({ name, description, project_id: projectId, fields: labels, items: clean }) !== baseline;

  // Someone else saved it while it was open: with nothing changed here, show
  // theirs; with edits in progress, keep them (saving sends this version).
  const seenVersion = useRef(template?.version);
  useEffect(() => {
    if (!template || template.version === seenVersion.current) return;
    seenVersion.current = template.version;
    if (dirty) return;
    setName(template.name);
    setDescription(template.description);
    setProjectId(template.project_id);
    setItems(template.items.length ? toDraft(template.items) : [blankTask()]);
    setLabels(template.fields);
    setBaseline(originKey(template));
  }, [template, dirty]);

  // Closing with unsaved edits asks first (as editing a project does); leaving the page warns too.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);
  const requestClose = () => {
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };
  const projectChoices = projects
    .filter((p) => p.status !== 'archived' && canAccessProject(access, p.id))
    .sort((a, b) => a.name.localeCompare(b.name));
  const people = team.filter((m) => m.status !== 'suspended').sort((a, b) => a.name.localeCompare(b.name));
  const assigneeOptions = [
    { value: '', label: 'Nobody' },
    { value: RUNNER, label: 'Whoever uses it' },
    ...people.map((m) => ({ value: m.id, label: m.name, group: 'People' })),
  ];
  const assigneeLabel = (value: string | null) => (value === RUNNER ? 'Whoever uses it' : value ? people.find((m) => m.id === value)?.name ?? 'Someone' : 'Nobody');

  const patchTask = (id: string, patch: Partial<DraftTask>) => setItems((list) => list.map((t) => (t.uid === id ? { ...t, ...patch } : t)));
  const patchSubtask = (taskId: string, subId: string, patch: Partial<DraftSubtask>) => setItems((list) => list.map((t) => (
    t.uid !== taskId ? t : { ...t, subtasks: t.subtasks.map((s) => (s.uid === subId ? { ...s, ...patch } : s)) }
  )));

  const save = async () => {
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = 'Give the template a name.';
    if (!clean.length) next.items = 'Add at least one task with a title.';
    if (total > TEMPLATE_TASKS_MAX) next.items = `A template makes ${TEMPLATE_TASKS_MAX} tasks at most.`;
    setErrors(next);
    if (Object.keys(next).length || busy) return;
    setBusy(true);
    const body = { name: name.trim(), description: description.trim(), project_id: projectId, fields, items: clean };
    try {
      const result = template
        ? await workspaceApi<TaskTemplateView>(`/api/workspace/task-templates/${template.id}`, { method: 'PATCH', body })
        : await workspaceApi<TaskTemplateView>('/api/workspace/task-templates', { method: 'POST', body });
      setReadData(taskTemplateRead(result.id), () => result);
      invalidateTables([...TEMPLATE_TABLES]);
      toast('success', template ? 'Template saved' : `${result.name} is ready to use`);
      onSaved?.(result);
      onClose();
    } catch (error) {
      const fieldErrors = fieldErrorsFrom(error);
      setErrors(Object.keys(fieldErrors).length ? { ...fieldErrors, form: error instanceof Error ? error.message : 'Could not save the template' }
        : { form: error instanceof Error ? error.message : 'Could not save the template' });
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

  const title = template ? (editable ? 'Edit template' : template.name) : 'New template';
  const lockedName = projectId ? projects.find((p) => p.id === projectId)?.name ?? template?.project_name ?? 'its project' : null;

  return (
    <TaskPanelShell
      labelledBy="template-title"
      onClose={requestClose}
      header={<PanelHeader title={title} eyebrow={template && editable ? template.name : template ? 'Template' : undefined} onClose={requestClose} />}
      footer={
        <div className="flex items-center justify-between gap-3 border-t border-white/[0.06] px-5 py-3">
          <div className="flex min-w-0 items-center gap-2">
            {template && editable && (
              <Button variant="ghost" size="sm" icon={<Trash2 size={14} aria-hidden="true" />} onClick={() => setTrashing(true)} aria-label={`Move ${template.name} to Trash`}>
                <span className="hidden sm:inline">Move to Trash</span>
              </Button>
            )}
            {!editable && <p className="truncate text-xs text-zinc-400">{templateSizeLabel({ item_count: clean.length, task_count: total })}</p>}
          </div>
          <div className="flex items-center gap-2">
            {template && onUse && (
              <Button variant={editable ? 'secondary' : 'primary'} size="sm" icon={<LayoutTemplate size={14} aria-hidden="true" />} onClick={() => onUse(template.id)}>
                Use
              </Button>
            )}
            {editable && (
              <Button size="sm" onClick={() => void save()} disabled={busy}>
                {busy ? 'Saving' : template ? 'Save changes' : 'Create template'}
              </Button>
            )}
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
              message="It leaves the library for everyone. Tasks it already made stay as they are."
            />
          )}
          <ConfirmDialog
            isOpen={confirmDiscard}
            onClose={() => setConfirmDiscard(false)}
            onConfirm={onClose}
            title="Discard changes?"
            message={template ? 'Your edits to this template are not saved. Discarding them cannot be undone.' : 'This template is not saved yet. Discarding it cannot be undone.'}
            confirmLabel="Discard"
            doubleConfirm={false}
          />
        </>
      }
    >
      <div className="space-y-5 px-5 pb-6">
        {editable ? (
          <div className="space-y-4">
            <TextInput label="Name *" value={name} onChange={setName} placeholder="Monthly payroll upload" maxLength={TEMPLATE_NAME_MAX} error={errors.name} autoFocus={!template} />
            <Textarea label="When to use it" value={description} onChange={setDescription} rows={2} autoResize maxLength={TEMPLATE_DESCRIPTION_MAX} placeholder="What this is for, so people pick the right one." />
            <Select
              label="Where it can be used"
              value={projectId ?? ''}
              onChange={(value) => setProjectId(value || null)}
              options={[{ value: '', label: 'Any project' }, ...projectChoices.map((p) => ({ value: p.id, label: `Only in ${p.name}`, keywords: p.name }))]}
              description={projectId ? 'Shows only in this project and always creates there.' : 'Whoever uses it picks the project.'}
              error={errors.project_id}
            />
          </div>
        ) : (
          <div className="space-y-2">
            {template?.description && <p className="text-sm leading-relaxed text-zinc-300 whitespace-pre-line">{template.description}</p>}
            <p className="flex items-center gap-2 text-xs text-zinc-400">
              {lockedName ? <><Lock size={12} aria-hidden="true" />Only in {lockedName}</> : 'Any project'}
            </p>
          </div>
        )}

        <section aria-labelledby="template-tasks" className="border-t border-white/[0.06] pt-4">
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <h3 id="template-tasks" className="text-sm font-semibold text-white">Tasks</h3>
            <span className="text-xs tabular-nums text-zinc-400">{total} {total === 1 ? 'task' : 'tasks'}</span>
          </div>
          {editable && <p className="mb-3 text-xs text-zinc-400">Type <code className="rounded bg-white/[0.06] px-1 font-mono text-[11px] text-zinc-200">{'{client}'}</code> in a title or description to ask for it each time it is used.</p>}
          <ol className="space-y-2">
            {items.map((task, index) => {
              const expanded = open === task.uid;
              const summary = [assigneeLabel(task.assignee), dueLabel(task.due_in_days), task.subtasks.length ? `${task.subtasks.length} subtask${task.subtasks.length === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ');
              return (
                <li key={task.uid} className="rounded-lg bg-white/[0.03] ring-1 ring-white/[0.06]">
                  <div className="flex items-start gap-1.5 px-2 py-2">
                    <button
                      type="button"
                      onClick={() => setOpen(expanded ? null : task.uid)}
                      aria-expanded={expanded}
                      aria-label={expanded ? 'Hide details' : 'Show details'}
                      className={`${ICON_BUTTON} mt-1.5`}
                    >
                      {expanded ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronRight size={15} aria-hidden="true" />}
                    </button>
                    <div className="min-w-0 flex-1">
                      {editable ? (
                        <TextInput
                          size="sm"
                          value={task.title}
                          onChange={(value) => patchTask(task.uid, { title: value })}
                          placeholder={index === 0 ? 'Upload the payroll sheet' : 'Task title'}
                          aria-label={`Task ${index + 1} title`}
                          maxLength={TEMPLATE_TITLE_MAX}
                        />
                      ) : <p className="py-1 text-sm font-medium text-zinc-100 break-words">{task.title}</p>}
                      {!expanded && <p className="mt-1 truncate px-0.5 text-[11px] text-zinc-400">{summary}</p>}
                    </div>
                    {editable && (
                      <div className="mt-1 flex flex-shrink-0 items-center">
                        <button type="button" onClick={() => setItems((list) => move(list, index, index - 1))} disabled={index === 0} aria-label="Move up" className={ICON_BUTTON}><ArrowUp size={14} aria-hidden="true" /></button>
                        <button type="button" onClick={() => setItems((list) => move(list, index, index + 1))} disabled={index === items.length - 1} aria-label="Move down" className={ICON_BUTTON}><ArrowDown size={14} aria-hidden="true" /></button>
                        <button type="button" onClick={() => setItems((list) => list.filter((t) => t.uid !== task.uid))} disabled={items.length === 1} aria-label="Remove task" className={ICON_BUTTON}><X size={14} aria-hidden="true" /></button>
                      </div>
                    )}
                  </div>
                  {expanded && (
                    <div className="space-y-3 border-t border-white/[0.06] px-3 pb-3 pt-3">
                      <TaskDetails
                        task={task}
                        editable={editable}
                        assigneeOptions={assigneeOptions}
                        assigneeLabel={assigneeLabel}
                        onChange={(patch) => patchTask(task.uid, patch)}
                      />
                      <div>
                        <p className="mb-1.5 text-xs font-medium text-zinc-300">Subtasks</p>
                        <ul className="space-y-1.5">
                          {task.subtasks.map((subtask) => (
                            <li key={subtask.uid} className="flex items-start gap-1.5">
                              <CornerDownRight size={13} className="mt-2 flex-shrink-0 text-zinc-500" aria-hidden="true" />
                              <div className="min-w-0 flex-1 space-y-1.5">
                                {editable ? (
                                  <TextInput size="sm" value={subtask.title} onChange={(value) => patchSubtask(task.uid, subtask.uid, { title: value })} placeholder="Subtask title" aria-label="Subtask title" maxLength={TEMPLATE_TITLE_MAX} />
                                ) : <p className="py-1 text-[13px] text-zinc-200 break-words">{subtask.title}</p>}
                                <div className="grid grid-cols-2 gap-1.5">
                                  {editable ? (
                                    <>
                                      <Select size="sm" ariaLabel="Subtask assignee" value={subtask.assignee ?? ''} onChange={(value) => patchSubtask(task.uid, subtask.uid, { assignee: value || null })} options={assigneeOptions} searchable={assigneeOptions.length > 8} />
                                      <NumberInput size="sm" min={0} max={3650} value={subtask.due_in_days ?? ''} onChange={(value) => patchSubtask(task.uid, subtask.uid, { due_in_days: value === '' ? null : Math.round(value) })} placeholder="No due date" suffix="days" aria-label="Subtask due, days after start" />
                                    </>
                                  ) : <p className="col-span-2 text-[11px] text-zinc-400">{assigneeLabel(subtask.assignee)} · {dueLabel(subtask.due_in_days)}</p>}
                                </div>
                              </div>
                              {editable && (
                                <button type="button" onClick={() => patchTask(task.uid, { subtasks: task.subtasks.filter((s) => s.uid !== subtask.uid) })} aria-label="Remove subtask" className={`${ICON_BUTTON} mt-1.5`}><X size={14} aria-hidden="true" /></button>
                              )}
                            </li>
                          ))}
                        </ul>
                        {editable && task.subtasks.length < TEMPLATE_SUBTASKS_MAX && (
                          <button
                            type="button"
                            onClick={() => patchTask(task.uid, { subtasks: [...task.subtasks, blankSubtask()] })}
                            className="mt-1.5 inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-zinc-300 transition-colors hover:bg-white/[0.06] hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                          >
                            <Plus size={13} aria-hidden="true" />Add subtask
                          </button>
                        )}
                        {!editable && task.subtasks.length === 0 && <p className="text-xs text-zinc-500">None</p>}
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
          {editable && items.length < TEMPLATE_ITEMS_MAX && (
            <Button
              variant="secondary"
              size="sm"
              className="mt-2"
              icon={<Plus size={14} aria-hidden="true" />}
              onClick={() => { const next = blankTask(); setItems((list) => [...list, next]); setOpen(next.uid); }}
            >
              Add task
            </Button>
          )}
          {errors.items && <p role="alert" className="mt-2 text-sm text-red-300">{errors.items}</p>}
        </section>

        {fields.length > 0 && (
          <section aria-labelledby="template-fields" className="border-t border-white/[0.06] pt-4">
            <h3 id="template-fields" className="mb-1 text-sm font-semibold text-white">Asked each time</h3>
            <p className="mb-3 text-xs text-zinc-400">Whoever uses it fills these in; they replace the words in braces.</p>
            <div className="space-y-2">
              {fields.map((field) => (
                <div key={field.key} className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] items-center gap-3">
                  <code className="truncate font-mono text-xs text-zinc-300">{`{${field.key}}`}</code>
                  {editable ? (
                    <TextInput
                      size="sm"
                      value={field.label}
                      onChange={(value) => setLabels((current) => [...current.filter((f) => f.key !== field.key), { key: field.key, label: value }])}
                      aria-label={`Label for {${field.key}}`}
                      maxLength={60}
                    />
                  ) : <span className="text-sm text-zinc-200">{field.label}</span>}
                </div>
              ))}
            </div>
          </section>
        )}

        {template && (
          <section aria-labelledby="template-history" className="border-t border-white/[0.06] pt-4">
            <h3 id="template-history" className="mb-2 text-sm font-semibold text-white">Recent uses</h3>
            {runs.loading ? <p role="status" className="text-xs text-zinc-400">Loading uses</p>
              : !runs.data?.rows.length ? <p className="text-xs text-zinc-400">Not used yet.</p>
              : (
                <ul className="space-y-1.5">
                  {runs.data.rows.map((run) => (
                    <li key={run.id} className="text-xs text-zinc-300">
                      <span className="text-zinc-100">{run.run_by_name ?? 'Someone'}</span>
                      {' made '}{run.task_ids.length} {run.task_ids.length === 1 ? 'task' : 'tasks'}
                      {run.project_name ? ` in ${run.project_name}` : ''}
                      <span className="text-zinc-500"> · {timeAgo(run.created_at)}{run.via !== 'app' ? ` · ${run.via === 'mcp' ? 'MCP' : run.via === 'api' ? 'API' : 'Schedule'}` : ''}</span>
                    </li>
                  ))}
                </ul>
              )}
            <p className="mt-3 text-[11px] text-zinc-500">
              Version {template.version}{template.created_by_name ? `, set up by ${template.created_by_name}` : ''}.
            </p>
          </section>
        )}
        {errors.form && <p role="alert" className="text-sm text-red-300">{errors.form}</p>}
      </div>
    </TaskPanelShell>
  );
}

function TaskDetails({ task, editable, assigneeOptions, assigneeLabel, onChange }: {
  task: DraftTask;
  editable: boolean;
  assigneeOptions: { value: string; label: string; group?: string }[];
  assigneeLabel: (value: string | null) => string;
  onChange: (patch: Partial<DraftTask>) => void;
}) {
  const priority = PRIORITY_OPTIONS.find((option) => option.value === task.priority);
  if (!editable) {
    return (
      <div className="space-y-2 text-sm">
        {task.description && <p className="whitespace-pre-line leading-relaxed text-zinc-300">{task.description}</p>}
        <p className="text-xs text-zinc-400">{assigneeLabel(task.assignee)} · {dueLabel(task.due_in_days)} · {priority?.label ?? 'Medium'} priority{task.tags.length ? ` · ${task.tags.join(', ')}` : ''}</p>
      </div>
    );
  }
  return (
    <>
      <Textarea size="sm" label="Description" value={task.description} onChange={(value) => onChange({ description: value })} rows={2} autoResize maxLength={10_000} placeholder="Steps, links, anything worth knowing" />
      <div className="grid grid-cols-2 gap-2">
        <Select size="sm" label="Assignee" value={task.assignee ?? ''} onChange={(value) => onChange({ assignee: value || null })} options={assigneeOptions} searchable={assigneeOptions.length > 8} visibleLabel="Assignee" />
        <NumberInput size="sm" label="Due" min={0} max={3650} value={task.due_in_days ?? ''} onChange={(value) => onChange({ due_in_days: value === '' ? null : Math.round(value) })} placeholder="No due date" suffix="days after start" />
        <Select
          size="sm"
          label="Priority"
          value={task.priority}
          onChange={(value) => onChange({ priority: value as TemplatePriority })}
          options={PRIORITY_OPTIONS.map((option) => ({ value: option.value, label: option.label, icon: <span className={`h-2 w-2 rounded-full ${option.color}`} aria-hidden="true" /> }))}
        />
        <div>
          <p className="mb-1.5 text-xs font-medium text-zinc-300">Tags</p>
          <TagsField value={task.tags} onChange={(tags) => onChange({ tags })} canEdit />
        </div>
      </div>
    </>
  );
}
