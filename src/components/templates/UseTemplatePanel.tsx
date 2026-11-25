'use client';

import { useMemo, useState } from 'react';
import { CalendarDays, CornerDownRight, Lock, RefreshCw, X } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { useRead } from '@/lib/query-cache';
import { taskTemplateRead, useBillingToday } from '@/lib/reads';
import { fieldErrorsFrom } from '@/lib/agent-workspace';
import { parseDateOnly } from '@/lib/date-utils';
import { appLocale } from '@/lib/region';
import { canAccessProject } from '@/lib/access-control';
import { missingValues, planRun, templateSizeLabel, type PlannedTask, type TaskTemplateRunResult } from '@/lib/task-templates';
import type { Task } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { DateInput } from '@/components/ui/inputs/DateInput';
import { Select } from '@/components/ui/inputs/Select';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { toast } from '@/components/ui/Toast';
import { TaskPanelShell } from '@/components/tasks/TaskPanelShell';
import { PRIORITY_OPTIONS } from '@/components/tasks/TaskFields';

const shortDate = (value: string) => parseDateOnly(value).toLocaleDateString(appLocale(), { weekday: 'short', month: 'short', day: 'numeric' });

/**
 * Using a template, in the side panel: where the tasks go (fixed for a
 * template locked to a project), the start date its due dates count from
 * (today by default), one box per fill-in field, then exactly what it will
 * create, in order, before anyone clicks. "Create 6 tasks" makes them all
 * at once.
 */
export function UseTemplatePanel({ templateId, projectId: presetProject, onClose, onDone }: {
  templateId: string;
  /** The project it was opened from (a project page, the New task panel). */
  projectId?: string | null;
  onClose: () => void;
  /** After the tasks exist; closes by default. */
  onDone?: (result: TaskTemplateRunResult<Task>) => void;
}) {
  const { projects, team, runTaskTemplate } = useApp();
  const { teamMemberId, access } = useAuth();
  const today = useBillingToday();
  const { isDemoMode } = useDemo();
  const template = useRead(taskTemplateRead(templateId, isDemoMode));
  const t = template.data;
  const [projectChoice, setProjectChoice] = useState<string>(presetProject ?? '');
  const [startDate, setStartDate] = useState(today);
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const lockedTo = t?.project_id ?? null;
  const projectId = lockedTo ?? projectChoice;
  const project = projects.find((p) => p.id === projectId);
  const choices = projects
    .filter((p) => p.status !== 'archived' && canAccessProject(access, p.id))
    .sort((a, b) => a.name.localeCompare(b.name));
  const plan: PlannedTask[] = useMemo(
    () => (t ? planRun(t.items, { startDate: startDate || today, values, runnerId: teamMemberId ?? null }) : []),
    [t, startDate, today, values, teamMemberId],
  );
  const count = plan.reduce((sum, task) => sum + 1 + task.subtasks.length, 0);
  const missing = t ? missingValues(t.fields, values) : [];
  const clearError = (key: string) => setErrors((current) => {
    if (!(key in current)) return current;
    const next = { ...current };
    delete next[key];
    return next;
  });
  const nameOf = (id: string | null) => (!id ? null : id === teamMemberId ? 'You' : team.find((m) => m.id === id)?.name ?? 'Someone');

  const submit = async () => {
    if (!t || busy) return;
    const next: Record<string, string> = {};
    if (!projectId) next.project_id = 'Pick a project.';
    for (const field of missing) next[`values.${field.key}`] = `Fill in ${field.label}.`;
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    try {
      const result = await runTaskTemplate(t.id, {
        ...(lockedTo ? {} : { project_id: projectId }),
        start_date: startDate || today,
        values,
      });
      const made = result.tasks.length;
      toast('success', `Created ${made} ${made === 1 ? 'task' : 'tasks'}${project ? ` in ${project.name}` : ''}`);
      for (const note of result.notes) toast('warning', note);
      if (onDone) onDone(result);
      else onClose();
    } catch (error) {
      const fields = fieldErrorsFrom(error);
      setErrors(Object.keys(fields).length ? fields : { form: error instanceof Error ? error.message : 'Could not use the template' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <TaskPanelShell
      labelledBy="use-template-title"
      onClose={onClose}
      header={
        <div className="flex items-start gap-3 px-5 pt-4 pb-3 flex-shrink-0">
          <div className="min-w-0 flex-1">
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-zinc-400">Use template</p>
            <h2 id="use-template-title" className="text-base font-semibold leading-snug text-white break-words">
              {t?.name ?? (template.failed ? 'Template' : 'Loading template')}
            </h2>
            {t && <p className="mt-0.5 text-xs text-zinc-400">{templateSizeLabel(t)}</p>}
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
      }
      footer={t ? (
        <div className="flex items-center justify-between gap-3 border-t border-white/[0.06] px-5 py-3">
          <p className="min-w-0 truncate text-xs text-zinc-400">
            {missing.length ? `Fill in ${missing.map((f) => f.label).join(', ')}` : project ? `Into ${project.name}` : 'Pick a project'}
          </p>
          <Button size="sm" onClick={() => void submit()} disabled={busy || !projectId}>
            {busy ? 'Creating' : `Create ${count} ${count === 1 ? 'task' : 'tasks'}`}
          </Button>
        </div>
      ) : undefined}
    >
      {template.failed && !t ? (
        <div role="alert" className="flex flex-col items-center gap-3 px-5 py-12 text-center">
          <p className="text-sm text-zinc-300">Could not open this template. It may be in Trash.</p>
          <Button variant="secondary" size="sm" icon={<RefreshCw size={13} aria-hidden="true" />} onClick={template.reload}>Try again</Button>
        </div>
      ) : !t ? (
        <div role="status" className="px-5 py-12 text-center text-sm text-zinc-400">Loading template</div>
      ) : (
        <div className="space-y-5 px-5 pb-6">
          {t.description && <p className="text-sm leading-relaxed text-zinc-300 whitespace-pre-line">{t.description}</p>}

          <div className="space-y-4">
            {lockedTo ? (
              <div>
                <p className="mb-1.5 text-sm font-medium text-zinc-200">Project</p>
                <p className="flex items-center gap-2 rounded-lg bg-white/[0.04] px-3 py-2 text-sm text-zinc-200">
                  <Lock size={14} className="text-zinc-400" aria-hidden="true" />
                  {t.project_name ?? project?.name ?? 'Its project'}
                  <span className="text-xs text-zinc-400">Always creates here</span>
                </p>
              </div>
            ) : (
              <Select
                label="Project"
                visibleLabel="Project"
                searchable
                value={projectChoice}
                onChange={(value) => { setProjectChoice(value); clearError('project_id'); }}
                placeholder="Pick a project"
                options={choices.map((p) => ({ value: p.id, label: p.name }))}
                error={errors.project_id}
              />
            )}
            <DateInput
              label="Start date"
              description="Due dates count from this day."
              value={startDate}
              onChange={(value) => setStartDate(value || today)}
            />
            {t.fields.map((field) => (
              <TextInput
                key={field.key}
                label={field.label}
                value={values[field.key] ?? ''}
                onChange={(value) => { setValues((current) => ({ ...current, [field.key]: value })); clearError(`values.${field.key}`); }}
                placeholder={`Fills in {${field.key}}`}
                maxLength={200}
                error={errors[`values.${field.key}`]}
              />
            ))}
          </div>

          <section aria-labelledby="use-template-preview" className="border-t border-white/[0.06] pt-4">
            <h3 id="use-template-preview" className="mb-2 text-sm font-semibold text-white">What it creates</h3>
            <ol className="space-y-1.5">
              {plan.map((task, index) => (
                <li key={index} className="rounded-lg bg-white/[0.03] px-3 py-2">
                  <PlannedRow task={task} nameOf={nameOf} />
                  {task.subtasks.length > 0 && (
                    <ul className="mt-1.5 space-y-1 border-t border-white/[0.06] pt-1.5">
                      {task.subtasks.map((subtask, i) => (
                        <li key={i} className="flex items-start gap-1.5 pl-1">
                          <CornerDownRight size={13} className="mt-0.5 flex-shrink-0 text-zinc-500" aria-hidden="true" />
                          <PlannedRow task={subtask} nameOf={nameOf} small />
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ol>
          </section>
          {errors.form && <p role="alert" className="text-sm text-red-300">{errors.form}</p>}
        </div>
      )}
    </TaskPanelShell>
  );
}

function PlannedRow({ task, nameOf, small = false }: {
  task: Omit<PlannedTask, 'subtasks'>;
  nameOf: (id: string | null) => string | null;
  small?: boolean;
}) {
  const priority = PRIORITY_OPTIONS.find((option) => option.value === task.priority);
  const who = nameOf(task.assignee_id);
  return (
    <div className="min-w-0 flex-1">
      <p className={`break-words text-zinc-100 ${small ? 'text-[13px]' : 'text-sm font-medium'}`}>{task.title}</p>
      <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-zinc-400">
        {task.due_date && (
          <span className="inline-flex items-center gap-1"><CalendarDays size={11} aria-hidden="true" />Due {shortDate(task.due_date)}</span>
        )}
        <span>{who ?? 'Unassigned'}</span>
        {priority && task.priority !== 'medium' && (
          <span className="inline-flex items-center gap-1"><span className={`h-1.5 w-1.5 rounded-full ${priority.color}`} aria-hidden="true" />{priority.label}</span>
        )}
        {task.tags.length > 0 && <span>{task.tags.join(', ')}</span>}
      </p>
    </div>
  );
}
