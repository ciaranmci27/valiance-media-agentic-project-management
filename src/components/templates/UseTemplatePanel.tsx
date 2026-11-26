'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Info, Layers, Lock, RefreshCw, Sparkles, X } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { useRead } from '@/lib/query-cache';
import { allGroupsRead, taskTemplateRead, taskTemplateRunsRead, useBillingToday } from '@/lib/reads';
import { workspaceApi } from '@/lib/agent-workspace';
import { canAccessProject, hasPermission } from '@/lib/access-control';
import { INITIATIVE_LABEL } from '@/lib/initiatives';
import {
  isCalendarDate, keyDatesOf, mainKeyDate, missingValues, RUNNER, templateSizeLabel, type RunTaskTemplateInput, type TaskTemplateRunResult,
  type TaskTemplateView,
} from '@/lib/task-templates';
import { localRunPreview, type ScreenIssue, type TemplateRunPreview } from '@/lib/template-ui';
import type { Task } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { DateInput } from '@/components/ui/inputs/DateInput';
import { Select, type SelectOption } from '@/components/ui/inputs/Select';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { Toggle } from '@/components/ui/inputs/Toggle';
import { StepFooter, Stepper, type FlowStep } from '@/components/ui/Stepper';
import { toast } from '@/components/ui/Toast';
import { TaskPanelShell } from '@/components/tasks/TaskPanelShell';
import { PastDueNotes, RunPreviewList, shortDate } from './RunPreviewList';

type StepKey = 'dates' | 'roles' | 'fields' | 'preview';
const STEP_LABELS: Record<StepKey, string> = { dates: 'Key dates', roles: 'Roles', fields: 'Fields', preview: 'Preview' };
/** Where each refusal is fixed, by the start of its path. */
const stepOfPath = (path: string): StepKey => (path.startsWith('roles') ? 'roles' : path.startsWith('values') ? 'fields'
  : path.startsWith('initiative') ? 'preview' : 'dates');

/**
 * Using a template, in the side panel, one step at a time: its key dates
 * (and the project, when the template does not say), who fills each role
 * (required ones before Next), its fill-in fields, then the exact dated and
 * assigned task list the run will make, with what each task waits on and the
 * initiative it creates (on by default, its name and owner editable). Create
 * makes it all at once; with an initiative, its page opens.
 */
export function UseTemplatePanel({ templateId, projectId: presetProject, onClose, onDone }: {
  templateId: string;
  /** The project it was opened from (a project page, the New task panel). */
  projectId?: string | null;
  onClose: () => void;
  /** After the tasks exist; closes by default. */
  onDone?: (result: TaskTemplateRunResult<Task>) => void;
}) {
  const { isDemoMode } = useDemo();
  const template = useRead(taskTemplateRead(templateId, isDemoMode));
  const header = (title: string, size?: string) => (
    <div className="flex items-start gap-3 px-5 pt-4 pb-3 flex-shrink-0">
      <div className="min-w-0 flex-1">
        <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-zinc-400">Use template</p>
        <h2 id="use-template-title" className="text-base font-semibold leading-snug text-white break-words">{title}</h2>
        {size && <p className="mt-0.5 text-xs text-zinc-400">{size}</p>}
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
  if (!template.data) {
    return (
      <TaskPanelShell labelledBy="use-template-title" onClose={onClose} header={header(template.failed ? 'Template' : 'Loading template')}>
        {template.failed ? (
          <div role="alert" className="flex flex-col items-center gap-3 px-5 py-12 text-center">
            <p className="text-sm text-zinc-300">Could not open this template. It may be in Trash.</p>
            <Button variant="secondary" size="sm" icon={<RefreshCw size={13} aria-hidden="true" />} onClick={template.reload}>Try again</Button>
          </div>
        ) : <div role="status" className="px-5 py-12 text-center text-sm text-zinc-400">Loading template</div>}
      </TaskPanelShell>
    );
  }
  return <RunFlow template={template.data} presetProject={presetProject ?? null} header={header(template.data.name, templateSizeLabel(template.data))} onClose={onClose} onDone={onDone} />;
}

function RunFlow({ template: t, presetProject, header, onClose, onDone }: {
  template: TaskTemplateView;
  presetProject: string | null;
  header: React.ReactNode;
  onClose: () => void;
  onDone?: (result: TaskTemplateRunResult<Task>) => void;
}) {
  const router = useRouter();
  const { projects, team, runTaskTemplate } = useApp();
  const { teamMemberId, access } = useAuth();
  const { isDemoMode } = useDemo();
  const today = useBillingToday();
  const runs = useRead(taskTemplateRunsRead(t.id, isDemoMode));
  const groups = useRead(allGroupsRead(isDemoMode));

  const keyDateList = keyDatesOf(t.key_dates);
  const mainKey = mainKeyDate(keyDateList).key;
  const roles = useMemo(() => t.roles ?? [], [t.roles]);
  const steps: (FlowStep & { key: StepKey })[] = (['dates', ...(roles.length ? ['roles'] : []), ...(t.fields.length ? ['fields'] : []), 'preview'] as StepKey[])
    .map((key) => ({ key, label: STEP_LABELS[key] }));
  const [step, setStep] = useState(0);
  const [reached, setReached] = useState(0);
  const current = steps[step].key;

  const lockedTo = t.project_id;
  const [projectChoice, setProjectChoice] = useState(presetProject ?? '');
  const projectId = lockedTo ?? projectChoice;
  const project = projects.find((p) => p.id === projectId);
  const projectChoices = projects.filter((p) => p.status !== 'archived' && canAccessProject(access, p.id)).sort((a, b) => a.name.localeCompare(b.name));

  const [dates, setDates] = useState<Record<string, string>>(() => (keyDateList.some((k) => k.key === 'start') ? { start: today } : {} as Record<string, string>));
  const [values, setValues] = useState<Record<string, string>>({});
  // Each role: a member id, "runner" (you), or '' for nobody. Starts at the template's default member.
  const [roleMap, setRoleMap] = useState<Record<string, string>>(() => Object.fromEntries(roles.map((r) => [r.key, r.default_member_id ?? ''])));
  const touchedRoles = useRef(new Set<string>());
  // Then, once, from the last run in this project: whoever filled each role last time.
  const prefilledFrom = useRef<string | null>(null);
  useEffect(() => {
    if (!projectId || !runs.data || prefilledFrom.current === projectId) return;
    prefilledFrom.current = projectId;
    const last = runs.data.rows.find((run) => run.project_id === projectId && run.role_members);
    if (!last?.role_members) return;
    setRoleMap((currentMap) => {
      const next = { ...currentMap };
      for (const role of roles) {
        const member = last.role_members?.[role.key];
        if (member && !touchedRoles.current.has(role.key) && team.some((m) => m.id === member && m.status !== 'suspended')) next[role.key] = member;
      }
      return next;
    });
  }, [projectId, runs.data, roles, team]);

  const [createInitiative, setCreateInitiative] = useState(true);
  const [initiativeName, setInitiativeName] = useState<string | null>(null);
  const [owner, setOwner] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Assigning anyone but yourself needs Manage all tasks; a role's default member stands either way.
  const assignsOthers = hasPermission(access, 'tasks.manage_all');
  const active = team.filter((m) => m.status !== 'suspended').sort((a, b) => a.name.localeCompare(b.name));
  const nameOf = (id: string | null | undefined) => (!id ? null : id === teamMemberId ? 'You' : team.find((m) => m.id === id)?.name ?? null);
  const roleOptions = (defaultMember: string | null): SelectOption[] => [
    { value: RUNNER, label: 'Me' },
    ...(assignsOthers
      ? [
        ...active.filter((m) => m.role !== 'agent' && m.id !== teamMemberId).map((m) => ({ value: m.id, label: m.name, group: 'People' })),
        ...active.filter((m) => m.role === 'agent').map((m) => ({ value: m.id, label: m.name, group: 'Agents' })),
      ]
      : defaultMember && defaultMember !== teamMemberId ? [{ value: defaultMember, label: nameOf(defaultMember) ?? 'Default member', detail: 'The template default' }] : []),
    { value: '', label: 'Nobody', detail: 'Its tasks keep their own assignee' },
  ];

  // What the run sends: a role left at its default member is left out, so the template's choice stands.
  const input: RunTaskTemplateInput = useMemo(() => {
    const roleInput: Record<string, string | null> = {};
    for (const role of roles) {
      const value = roleMap[role.key] ?? '';
      if (value && value === role.default_member_id) continue;
      if (!value && !role.default_member_id) continue;
      roleInput[role.key] = value ? (value === teamMemberId ? RUNNER : value) : null;
    }
    const ownerInput = owner.startsWith('role:') ? { owner_role: owner.slice(5) } : owner.startsWith('m:') ? { owner_member_id: owner.slice(2) }
      : owner.startsWith('g:') ? { owner_group_id: owner.slice(2) } : {};
    const name = initiativeName?.trim();
    return {
      ...(lockedTo || !projectId ? {} : { project_id: projectId }),
      key_dates: Object.fromEntries(Object.entries(dates).filter(([, value]) => value)),
      ...(Object.keys(roleInput).length ? { roles: roleInput } : {}),
      values,
      ...(createInitiative ? { create_initiative: true, ...(name || Object.keys(ownerInput).length ? { initiative: { ...(name ? { name } : {}), ...ownerInput } } : {}) } : {}),
    };
  }, [roles, roleMap, teamMemberId, owner, initiativeName, lockedTo, projectId, dates, values, createInitiative]);

  // Each step's own check before Next.
  const dateProblems: Record<string, string> = {};
  if (!projectId) dateProblems.project_id = 'Pick a project.';
  for (const keyDate of keyDateList) {
    const value = dates[keyDate.key];
    if (!value) dateProblems[keyDate.key] = `Set the ${keyDate.label}.`;
    else if (!isCalendarDate(value)) dateProblems[keyDate.key] = 'Use a real date.';
  }
  const roleProblems: Record<string, string> = {};
  for (const role of roles) if (role.required && !roleMap[role.key]) roleProblems[role.key] = `${role.label} needs someone.`;
  const missing = missingValues(t.fields, values);
  const problemsHere = current === 'dates' ? Object.keys(dateProblems).length : current === 'roles' ? Object.keys(roleProblems).length
    : current === 'fields' ? missing.length : 0;

  // The preview: the server's dry run (the demo works it out here), fresh on every change.
  const [preview, setPreview] = useState<{ key: string; data: TemplateRunPreview } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const inputKey = JSON.stringify(input);
  useEffect(() => {
    if (current !== 'preview') return;
    let cancelled = false;
    setPreviewError(null);
    const timer = window.setTimeout(async () => {
      try {
        const data = isDemoMode
          ? localRunPreview(t, input, { runnerId: teamMemberId ?? null, today, projectName: project?.name ?? t.project_name, nameOf: (id) => nameOf(id) })
          : await workspaceApi<TemplateRunPreview>(`/api/workspace/task-templates/${encodeURIComponent(t.id)}/preview`, { method: 'POST', body: input });
        if (!cancelled) setPreview({ key: inputKey, data });
      } catch (error) {
        if (!cancelled) setPreviewError(error instanceof Error ? error.message : 'Could not preview the run');
      }
    }, preview ? 300 : 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch on the input itself (inputKey), not each render's copies
  }, [current, inputKey, isDemoMode]);
  const fresh = preview?.key === inputKey ? preview.data : null;
  const shownPreview = preview?.data ?? null;

  const go = (index: number) => {
    setShowErrors(false);
    setFormError(null);
    setStep(index);
    setReached((r) => Math.max(r, index));
  };
  const next = () => {
    if (problemsHere) { setShowErrors(true); return; }
    go(step + 1);
  };

  const create = async () => {
    if (!fresh || !fresh.ok || busy) return;
    setBusy(true);
    setFormError(null);
    try {
      const result = await runTaskTemplate(t.id, input);
      const made = result.tasks.length;
      toast('success', result.initiative
        ? `Created ${result.initiative.name} with ${made} ${made === 1 ? 'task' : 'tasks'}`
        : `Created ${made} ${made === 1 ? 'task' : 'tasks'}${project ? ` in ${project.name}` : ''}`);
      for (const note of result.notes) toast('warning', note);
      if (onDone) onDone(result);
      else onClose();
      if (result.initiative) router.push(`/projects/${encodeURIComponent(result.initiative.project_id)}/initiatives/${encodeURIComponent(result.initiative.id)}`);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Could not use the template');
    } finally {
      setBusy(false);
    }
  };

  const count = shownPreview?.tasks.reduce((sum, task) => sum + 1 + task.subtasks.length, 0) ?? t.task_count;
  const nextLabel = current !== 'preview' ? 'Next'
    : createInitiative ? `Create ${INITIATIVE_LABEL.lower} and ${count} ${count === 1 ? 'task' : 'tasks'}`
      : `Create ${count} ${count === 1 ? 'task' : 'tasks'}`;
  const dateLabel = (key: string) => keyDateList.find((k) => k.key === key)?.label ?? key;

  return (
    <TaskPanelShell
      labelledBy="use-template-title"
      onClose={onClose}
      header={header}
      footer={
        <StepFooter
          variant="bar"
          onBack={step > 0 ? () => go(step - 1) : undefined}
          onNext={current === 'preview' ? () => void create() : next}
          nextLabel={nextLabel}
          busy={busy}
          busyLabel="Creating"
          nextDisabled={current === 'preview' ? !fresh || !fresh.ok : showErrors && problemsHere > 0}
          error={formError}
        />
      }
    >
      <div className="space-y-5 px-5 pb-6">
        <Stepper steps={steps} current={step} reached={reached} onJump={go} label="Run progress" />

        {current === 'dates' && (
          <section aria-labelledby="run-dates" className="space-y-4">
            <div>
              <h3 id="run-dates" className="text-sm font-semibold text-white">When is it?</h3>
              <p className="mt-0.5 text-xs text-zinc-400">Every due date counts from these.</p>
            </div>
            {t.guidance && <GuidanceNote text={t.guidance} />}
            {lockedTo ? (
              <div>
                <p className="mb-1.5 text-sm font-medium text-zinc-200">Project</p>
                <p className="flex items-center gap-2 rounded-lg bg-white/[0.04] px-3 py-2 text-sm text-zinc-200">
                  <Lock size={14} className="text-zinc-400" aria-hidden="true" />
                  {t.project_name ?? project?.name ?? 'Its project'}
                  <span className="text-xs text-zinc-400">Always creates here</span>
                </p>
              </div>
            ) : presetProject && project ? null : (
              <Select
                label="Project"
                visibleLabel="Project"
                searchable
                value={projectChoice}
                onChange={setProjectChoice}
                placeholder="Pick a project"
                options={projectChoices.map((p) => ({ value: p.id, label: p.name }))}
                error={showErrors ? dateProblems.project_id : undefined}
              />
            )}
            {keyDateList.map((keyDate) => (
              <DateInput
                key={keyDate.key}
                label={keyDate.label}
                description={keyDate.key === mainKey && keyDateList.length > 1 ? `The main date: the ${INITIATIVE_LABEL.lower} targets it.` : undefined}
                value={dates[keyDate.key] ?? ''}
                onChange={(value) => setDates((d) => ({ ...d, [keyDate.key]: value }))}
                error={showErrors ? dateProblems[keyDate.key] : undefined}
              />
            ))}
          </section>
        )}

        {current === 'roles' && (
          <section aria-labelledby="run-roles" className="space-y-4">
            <div>
              <h3 id="run-roles" className="text-sm font-semibold text-white">Who fills each role?</h3>
              <p className="mt-0.5 text-xs text-zinc-400">A person or an agent. Their tasks go to them.{!assignsOthers ? ' Giving tasks to others needs Manage all tasks, so you can pick yourself or the default.' : ''}</p>
            </div>
            {roles.map((role) => {
              const tasksFor = t.items.reduce((sum, item) => sum + (item.role === role.key ? 1 : 0) + (item.subtasks ?? []).filter((s) => s.role === role.key).length, 0);
              const value = roleMap[role.key] === teamMemberId ? RUNNER : roleMap[role.key] ?? '';
              return (
                <Select
                  key={role.key}
                  label={`${role.label}${role.required ? ' *' : ''}`}
                  visibleLabel={`${role.label}${role.required ? ' *' : ''}`}
                  value={value}
                  onChange={(next) => { touchedRoles.current.add(role.key); setRoleMap((m) => ({ ...m, [role.key]: next === RUNNER ? teamMemberId ?? RUNNER : next })); }}
                  options={roleOptions(role.default_member_id ?? null)}
                  searchable={active.length > 8}
                  description={`${tasksFor} ${tasksFor === 1 ? 'task' : 'tasks'}${role.default_member_id ? `, default ${nameOf(role.default_member_id) ?? 'member'}` : ''}`}
                  error={showErrors ? roleProblems[role.key] : undefined}
                />
              );
            })}
          </section>
        )}

        {current === 'fields' && (
          <section aria-labelledby="run-fields" className="space-y-4">
            <div>
              <h3 id="run-fields" className="text-sm font-semibold text-white">Fill in the blanks</h3>
              <p className="mt-0.5 text-xs text-zinc-400">They go into the task titles and descriptions.</p>
            </div>
            {t.fields.map((field) => {
              const error = showErrors && missing.some((f) => f.key === field.key) ? `Fill in ${field.label}.` : undefined;
              const label = `${field.label}${field.required !== false ? ' *' : ''}`;
              const setValue = (value: string) => setValues((v) => ({ ...v, [field.key]: value }));
              if (field.type === 'date') return <DateInput key={field.key} label={label} value={values[field.key] ?? ''} onChange={setValue} error={error} />;
              if (field.type === 'choice') {
                return <Select key={field.key} label={label} visibleLabel={label} value={values[field.key] ?? ''} onChange={setValue} placeholder="Pick one" options={(field.options ?? []).map((o) => ({ value: o, label: o }))} error={error} />;
              }
              if (field.type === 'member') {
                return (
                  <Select key={field.key} label={label} visibleLabel={label} value={values[field.key] ?? ''} onChange={setValue} placeholder="Pick someone" searchable={active.length > 8}
                    options={[...active.filter((m) => m.role !== 'agent').map((m) => ({ value: m.id, label: m.name, group: 'People' })), ...active.filter((m) => m.role === 'agent').map((m) => ({ value: m.id, label: m.name, group: 'Agents' }))]}
                    error={error} />
                );
              }
              return <TextInput key={field.key} label={label} value={values[field.key] ?? ''} onChange={setValue} placeholder={`Fills in {${field.key}}`} maxLength={200} error={error} />;
            })}
          </section>
        )}

        {current === 'preview' && (
          <section aria-labelledby="run-preview" className="space-y-4" aria-busy={!fresh}>
            <div>
              <h3 id="run-preview" className="text-sm font-semibold text-white">What it creates</h3>
              <p className="mt-0.5 text-xs text-zinc-400">
                {project ? `In ${project.name}. ` : ''}Exactly these, dated and assigned. Nothing is made until you create it.
              </p>
            </div>

            {previewError && !shownPreview && (
              <div role="alert" className="flex flex-col items-start gap-2 rounded-lg bg-red-500/[0.1] px-3 py-2.5 text-sm text-red-200">
                {previewError}
                <Button variant="secondary" size="sm" icon={<RefreshCw size={13} aria-hidden="true" />} onClick={() => setPreview(null)}>Try again</Button>
              </div>
            )}
            {!shownPreview && !previewError && <p role="status" className="py-6 text-center text-sm text-zinc-400">Working out dates</p>}

            {shownPreview && (
              <>
                {shownPreview.errors.length > 0 && (
                  <div role="alert" className="rounded-lg bg-red-500/[0.1] px-3 py-2.5">
                    <p className="text-sm font-medium text-red-200">Fix before creating</p>
                    <ul className="mt-1 space-y-1">
                      {(shownPreview.errors as ScreenIssue[]).map((issue) => {
                        const target = steps.findIndex((s) => s.key === stepOfPath(issue.path));
                        return (
                          <li key={`${issue.path}:${issue.code}`} className="flex items-baseline justify-between gap-3 text-xs text-red-300">
                            <span>{issue.message}</span>
                            {target >= 0 && target !== step && (
                              <button type="button" onClick={() => go(target)} className="flex-shrink-0 rounded font-medium text-red-200 underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
                                Go to {steps[target].label}
                              </button>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}

                {/* The initiative the run makes. */}
                <div className="rounded-lg bg-white/[0.03] p-3 ring-1 ring-white/[0.06]">
                  <Toggle
                    checked={createInitiative}
                    onChange={setCreateInitiative}
                    label={`Creates an ${INITIATIVE_LABEL.lower}`}
                    description={createInitiative
                      ? `Its tasks go in one ${INITIATIVE_LABEL.lower} with its own board and log${shownPreview.initiative?.target_date ? `, targeting ${shortDate(shownPreview.initiative.target_date)} (${dateLabel(shownPreview.main_key_date)})` : ''}.`
                      : 'The tasks go straight into the project.'}
                  />
                  {createInitiative && (
                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      <TextInput size="sm" label="Name" value={initiativeName ?? shownPreview.initiative?.name ?? ''} onChange={setInitiativeName} maxLength={120} />
                      <Select
                        size="sm"
                        label="Owner"
                        visibleLabel="Owner"
                        value={owner}
                        onChange={setOwner}
                        searchable
                        options={[
                          { value: '', label: 'Me' },
                          ...shownPreview.roles.filter((r) => r.member_id).map((r) => ({ value: `role:${r.key}`, label: `${r.label} (${r.member_id === teamMemberId ? 'you' : r.member_name ?? 'mapped'})`, group: 'Roles' })),
                          ...active.filter((m) => m.role !== 'agent' && m.id !== teamMemberId).map((m) => ({ value: `m:${m.id}`, label: m.name, group: 'People' })),
                          ...(groups.data ?? []).map((g) => ({ value: `g:${g.id}`, label: g.name, group: 'Groups' })),
                        ]}
                      />
                    </div>
                  )}
                </div>

                {shownPreview.notes.length > 0 && (
                  <ul className="space-y-1 rounded-lg bg-amber-500/[0.1] px-3 py-2.5 text-xs text-amber-200">
                    {shownPreview.notes.map((note) => <li key={note} className="flex gap-2"><Info size={13} className="mt-0.5 flex-shrink-0" aria-hidden="true" />{note}</li>)}
                  </ul>
                )}

                <PastDueNotes items={shownPreview.past_due ?? []} />

                <RunPreviewList tasks={shownPreview.tasks} roles={shownPreview.roles} pastDue={shownPreview.past_due ?? []} dimmed={!fresh} />
                {createInitiative && (
                  <p className="flex items-center gap-1.5 text-[11px] text-zinc-500">
                    <Layers size={12} aria-hidden="true" />Its page opens once it is created.
                  </p>
                )}
              </>
            )}
          </section>
        )}
      </div>
    </TaskPanelShell>
  );
}

function GuidanceNote({ text }: { text: string }) {
  return (
    <div className="flex gap-2 rounded-lg bg-white/[0.04] px-3 py-2.5">
      <Sparkles size={14} className="mt-0.5 flex-shrink-0 text-brand-300" aria-hidden="true" />
      <div className="min-w-0">
        <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-400">From the template</p>
        <p className="mt-0.5 whitespace-pre-line text-sm text-zinc-300">{text}</p>
      </div>
    </div>
  );
}
