'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, CalendarClock, Lock, Pause, Play, RefreshCw, Trash2, Undo2 } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { canAccessProject, hasPermission } from '@/lib/access-control';
import { setReadData, useRead } from '@/lib/query-cache';
import { scheduleOccurrencesRead, scheduleRead, schedulesRead, taskTemplateRead, taskTemplateRunsRead } from '@/lib/reads';
import { workspaceApi, WorkspaceApiError } from '@/lib/agent-workspace';
import { INITIATIVE_LABEL } from '@/lib/initiatives';
import { keyDatesOf, RUNNER, templateSizeLabel, TEMPLATE_VALUE_MAX, type TaskTemplateView } from '@/lib/task-templates';
import {
  addDays, BUILT_IN_FILLS, defaultRecurrence, occurrenceLabel, recurrenceSchema, scheduleDateLabel, scheduleFills, upcomingDates,
  type Recurrence, type ScheduleOccurrenceView, type ScheduleView, type TemplateScheduleInput,
} from '@/lib/schedules';
import { Button } from '@/components/ui/Button';
import { DateInput } from '@/components/ui/inputs/DateInput';
import { NumberInput } from '@/components/ui/inputs/NumberInput';
import { Select, type SelectOption } from '@/components/ui/inputs/Select';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { Toggle } from '@/components/ui/inputs/Toggle';
import { toast } from '@/components/ui/Toast';
import { useDiscardGuard } from '@/components/ui/useDiscardGuard';
import { TaskPanelShell } from '@/components/tasks/TaskPanelShell';
import { PanelHeader } from '@/components/ui/PanelHeader';
import { RecurrencePicker } from './RecurrencePicker';
import {
  errorText, refreshSchedules, removeSchedule, scheduleStatusLine, setSchedulePaused, todayIn, undoRemoveSchedule, useRemovedSchedules,
} from './schedule-actions';
import { profileTimeZone } from '@/lib/time-zone';

/**
 * A template's schedule, in the side panel: when it runs (the pattern, its
 * time zone, a start and an optional end), where (a company-wide template
 * asks for the project), who fills each role, the fill-ins it needs (the
 * date and month fill themselves), how far each later key date sits from the
 * run's date, and whether each run makes an initiative or waits while the
 * last one is still open. Editing one adds its status with Pause or Resume,
 * Remove (at once, Undo in place) and what its last runs did.
 */
export function SchedulePanel({ templateId: givenTemplate = null, scheduleId: givenSchedule = null, onClose }: {
  /** A new schedule on this template. */
  templateId?: string | null;
  /** An existing schedule to edit. */
  scheduleId?: string | null;
  onClose: () => void;
}) {
  const { isDemoMode } = useDemo();
  // The panel can switch from a new schedule to one the template already has.
  const [scheduleId, setScheduleId] = useState(givenSchedule);
  const schedule = useRead(scheduleId ? scheduleRead(scheduleId, isDemoMode) : null);
  const templateId = scheduleId ? schedule.data?.template_id ?? null : givenTemplate;
  const template = useRead(templateId ? taskTemplateRead(templateId, isDemoMode) : null);

  const failed = (scheduleId && schedule.failed && !schedule.data) || (template.failed && !template.data) || (scheduleId && schedule.data && !templateId);
  if (failed || !template.data || (scheduleId && !schedule.data)) {
    return (
      <TaskPanelShell labelledBy="schedule-title" onClose={onClose} header={<PanelHeader id="schedule-title" title={failed ? 'Schedule' : 'Loading schedule'} onClose={onClose} />}>
        {failed ? (
          <div role="alert" className="flex flex-col items-center gap-3 px-5 py-12 text-center">
            <p className="text-sm text-zinc-300">{scheduleId && schedule.data && !templateId ? 'Its template is gone, so this schedule cannot run.' : 'Could not open this schedule. It may have been removed.'}</p>
            <Button variant="secondary" size="sm" icon={<RefreshCw size={13} aria-hidden="true" />} onClick={() => { schedule.reload(); template.reload(); }}>Try again</Button>
          </div>
        ) : <div role="status" className="px-5 py-12 text-center text-sm text-zinc-400">Loading schedule</div>}
      </TaskPanelShell>
    );
  }
  return (
    <ScheduleForm
      key={schedule.data?.id ?? 'new'}
      template={template.data}
      schedule={scheduleId ? schedule.data ?? null : null}
      onOpen={setScheduleId}
      onClose={onClose}
    />
  );
}

/** One hairline section of the form: a heading, a line on what it is for, then its fields. */
function Section({ id, title, description, children }: { id: string; title: string; description?: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="border-t border-white/[0.06] pt-4">
      <h3 id={id} className="mb-1 text-sm font-semibold text-white">{title}</h3>
      {description && <p className="mb-3 text-xs text-zinc-400">{description}</p>}
      {children}
    </section>
  );
}

const BUILT_IN = new Set<string>(BUILT_IN_FILLS);
let zoneOptionsCache: SelectOption[] | null = null;
/** Every IANA zone the browser knows, with its offset now ("GMT-7"), built once. */
function zoneOptions(): SelectOption[] {
  if (zoneOptionsCache) return zoneOptionsCache;
  let zones: string[] = [];
  try { zones = Intl.supportedValuesOf('timeZone'); } catch { zones = []; }
  if (!zones.includes('UTC')) zones = ['UTC', ...zones];
  const now = new Date();
  zoneOptionsCache = zones.map((zone) => {
    let offset = '';
    try { offset = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' }).formatToParts(now).find((p) => p.type === 'timeZoneName')?.value ?? ''; } catch { offset = ''; }
    return { value: zone, label: zone.replace(/_/g, ' '), detail: offset, keywords: `${zone} ${offset}` };
  });
  return zoneOptionsCache;
}

type Issue = { path?: string | (string | number)[]; message: string };
const pathOf = (issue: Issue) => (Array.isArray(issue.path) ? issue.path.join('.') : issue.path ?? '');

function ScheduleForm({ template: t, schedule, onOpen, onClose }: {
  template: TaskTemplateView;
  schedule: ScheduleView | null;
  onOpen: (scheduleId: string) => void;
  onClose: () => void;
}) {
  const { projects, team } = useApp();
  const { access, teamMemberId } = useAuth();
  const { isDemoMode } = useDemo();
  const removedList = useRemovedSchedules();
  const isRemoved = !!schedule && removedList.some((s) => s.id === schedule.id);
  const canRun = hasPermission(access, 'tasks.create');
  const editable = schedule ? schedule.can_edit : canRun;
  const assignsOthers = hasPermission(access, 'tasks.manage_all');

  // A new schedule starts in the person's own zone (their profile's, lib/time-zone); an existing one keeps its own.
  const initialZone = schedule?.timezone ?? profileTimeZone(team.find((m) => m.id === teamMemberId));
  const keyDateList = keyDatesOf(t.key_dates);
  const roles = useMemo(() => t.roles ?? [], [t.roles]);
  const askFields = t.fields.filter((f) => !BUILT_IN.has(f.key));
  const builtIns = t.fields.filter((f) => BUILT_IN.has(f.key));

  // ── The form ──
  const [timezone, setTimezone] = useState(initialZone);
  const today = todayIn(timezone);
  const [recurrence, setRecurrence] = useState<Recurrence>(() => schedule?.recurrence ?? defaultRecurrence(today));
  const [startDate, setStartDate] = useState(() => schedule?.start_date ?? today);
  const [endDate, setEndDate] = useState(schedule?.end_date ?? '');
  const [projectChoice, setProjectChoice] = useState(schedule?.project_id ?? '');
  const [roleMap, setRoleMap] = useState<Record<string, string>>(() => Object.fromEntries(roles.map((r) => {
    if (schedule) return [r.key, schedule.roles[r.key] ?? ''];
    return [r.key, r.default_member_id ?? (r.required ? RUNNER : '')];
  })));
  const [values, setValues] = useState<Record<string, string>>(() => ({ ...(schedule?.values ?? {}) }));
  const [offsets, setOffsets] = useState<Record<string, number>>(() => Object.fromEntries(keyDateList.slice(1).map((k) => [k.key, schedule?.key_date_offsets[k.key] ?? 0])));
  const [createInitiative, setCreateInitiative] = useState(schedule?.create_initiative ?? false);
  const [skipIfOpen, setSkipIfOpen] = useState(schedule?.skip_if_open ?? true);
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [serverIssues, setServerIssues] = useState<{ key: string; issues: Issue[] } | null>(null);

  const lockedTo = t.project_id;
  const projectId = lockedTo ?? projectChoice;
  const projectChoices = projects.filter((p) => (p.status !== 'archived' && canAccessProject(access, p.id)) || p.id === projectChoice)
    .sort((a, b) => a.name.localeCompare(b.name));

  // What saving sends, in the create route's shape.
  const body: TemplateScheduleInput = useMemo(() => ({
    ...(lockedTo ? {} : projectId ? { project_id: projectId } : {}),
    recurrence,
    timezone,
    start_date: startDate,
    end_date: endDate || null,
    roles: Object.fromEntries(roles.map((r) => [r.key, roleMap[r.key] || null])),
    values: Object.fromEntries(askFields.map((f) => [f.key, (values[f.key] ?? '').trim()]).filter(([, v]) => v)),
    key_date_offsets: Object.fromEntries(keyDateList.slice(1).map((k) => [k.key, offsets[k.key] ?? 0])),
    create_initiative: createInitiative,
    skip_if_open: skipIfOpen,
  // eslint-disable-next-line react-hooks/exhaustive-deps -- askFields and keyDateList follow the template
  }), [lockedTo, projectId, recurrence, timezone, startDate, endDate, roles, roleMap, values, offsets, createInitiative, skipIfOpen, t]);
  const bodyKey = JSON.stringify(body);
  const [baseline] = useState(bodyKey);
  const dirty = editable && !isDemoMode && !isRemoved && (!schedule || bodyKey !== baseline);

  // ── Checks before saving, then the server's own at each field ──
  const problems: Record<string, string> = {};
  const parsedRule = recurrenceSchema.safeParse(recurrence);
  if (!parsedRule.success) problems.recurrence = parsedRule.error.issues[0]?.message ?? 'Check the pattern';
  if (!projectId) problems.project_id = 'Pick the project the runs go in.';
  if (!startDate) problems.start_date = 'Pick the first day it may run.';
  if (endDate && startDate && endDate < startDate) problems.end_date = 'The end date is before the start date.';
  for (const role of roles) if (role.required && !roleMap[role.key]) problems[`roles.${role.key}`] = `${role.label} needs someone.`;
  for (const field of askFields) if (field.required !== false && !(values[field.key] ?? '').trim()) problems[`values.${field.key}`] = `Fill in ${field.label}.`;
  const fromServer = serverIssues?.key === bodyKey ? serverIssues.issues : [];
  const fieldError = (path: string) => (attempted ? problems[path] : undefined) ?? fromServer.find((i) => pathOf(i) === path || pathOf(i).startsWith(`${path}.`))?.message;
  const placedPaths = /^(recurrence|project_id|start_date|end_date|timezone|roles\.[^.]+|values\.[^.]+|key_date_offsets\.[^.]+)/;
  const strayIssues = fromServer.filter((i) => !placedPaths.test(pathOf(i)));
  const problemCount = Object.keys(problems).length;

  // The run dates this sets, for the fill-ins and the key dates.
  const upcoming = useMemo(() => {
    if (!parsedRule.success || !startDate) return [] as string[];
    try { return upcomingDates(parsedRule.data, startDate, today > startDate ? today : startDate, 1, endDate || null); } catch { return []; }
  }, [parsedRule.success, parsedRule.data, startDate, today, endDate]);
  const nextRun = upcoming[0] ?? null;

  const { requestClose, dialog: discardDialog } = useDiscardGuard(dirty, onClose,
    schedule ? 'Your changes to this schedule are not saved. Discarding them cannot be undone.' : 'This schedule is not set up yet. Discarding it cannot be undone.');

  const save = async () => {
    setAttempted(true);
    setFormError(null);
    if (problemCount || busy || isDemoMode || !editable) return;
    setBusy(true);
    try {
      if (schedule) {
        // Only what changed: whose rights the runs use follows whoever last changed what it makes.
        const before = JSON.parse(baseline) as Record<string, unknown>;
        const patch = Object.fromEntries(Object.entries(body).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(before[key])));
        const result = await workspaceApi<ScheduleView>(`/api/workspace/schedules/${encodeURIComponent(schedule.id)}`, { method: 'PATCH', body: patch });
        setReadData(scheduleRead(result.id, isDemoMode), () => result);
        toast('success', 'Schedule saved');
      } else {
        const result = await workspaceApi<ScheduleView>(`/api/workspace/task-templates/${encodeURIComponent(t.id)}/schedules`, { method: 'POST', body });
        toast('success', `${t.name} is scheduled: ${result.recurrence_label.charAt(0).toLowerCase()}${result.recurrence_label.slice(1)}`);
      }
      refreshSchedules();
      onClose();
    } catch (error) {
      const details = error instanceof WorkspaceApiError ? (error.details as { errors?: Issue[] } | undefined) : undefined;
      if (details?.errors?.length) setServerIssues({ key: bodyKey, issues: details.errors });
      setFormError(errorText(error, 'Could not save the schedule'));
    } finally {
      setBusy(false);
    }
  };

  const togglePaused = async () => {
    if (!schedule || statusBusy || isDemoMode) return;
    setStatusBusy(true);
    try {
      const result = await setSchedulePaused(schedule, schedule.status !== 'paused');
      setReadData(scheduleRead(result.id, isDemoMode), () => result);
      toast('success', result.status === 'paused' ? 'Schedule paused' : 'Schedule resumed');
    } catch (error) {
      toast('error', errorText(error, 'Could not change the schedule'));
    } finally {
      setStatusBusy(false);
    }
  };

  const remove = async () => {
    if (!schedule || isDemoMode) return;
    try { await removeSchedule(schedule); } catch (error) { toast('error', errorText(error, 'Could not remove the schedule')); }
  };
  const undo = async () => {
    if (!schedule) return;
    try {
      const made = await undoRemoveSchedule(schedule);
      toast('success', 'Schedule is back');
      onOpen(made.id);
    } catch (error) {
      toast('error', errorText(error, 'Could not bring the schedule back'));
    }
  };

  // ── Who fills each role ──
  const active = team.filter((m) => m.status !== 'suspended').sort((a, b) => a.name.localeCompare(b.name));
  const nameOf = (id: string | null | undefined) => (!id ? null : id === teamMemberId ? 'You' : team.find((m) => m.id === id)?.name ?? null);
  const runnerName = schedule ? (schedule.run_as === teamMemberId ? 'you' : schedule.run_as_name ?? 'whoever set it up') : 'you';
  const roleOptions = (defaultMember: string | null, current: string): SelectOption[] => {
    const people = assignsOthers
      ? [
        ...active.filter((m) => m.role !== 'agent').map((m) => ({ value: m.id, label: m.name, group: 'People' })),
        ...active.filter((m) => m.role === 'agent').map((m) => ({ value: m.id, label: m.name, group: 'Agents' })),
      ]
      : [defaultMember, current].filter((id, i, all): id is string => !!id && id !== RUNNER && all.indexOf(id) === i)
        .map((id) => ({ value: id, label: nameOf(id) ?? 'A member', detail: id === defaultMember ? 'The template default' : undefined }));
    return [
      { value: RUNNER, label: 'Whoever runs it', detail: `Now ${runnerName}` },
      ...people,
      { value: '', label: 'Nobody', detail: 'Its tasks keep their own assignee' },
    ];
  };

  const memberFieldOptions = [
    ...active.filter((m) => m.role !== 'agent').map((m) => ({ value: m.id, label: m.name, group: 'People' })),
    ...active.filter((m) => m.role === 'agent').map((m) => ({ value: m.id, label: m.name, group: 'Agents' })),
  ];

  const project = projects.find((p) => p.id === projectId);
  const statusLine = schedule ? scheduleStatusLine(schedule) : null;
  const saveLabel = busy ? 'Saving' : schedule ? 'Save changes' : 'Start schedule';
  const footerStatus = isDemoMode ? 'The demo does not save schedules'
    : !editable ? 'Ask whoever set it up to change it'
      : attempted && problemCount ? `${problemCount} ${problemCount === 1 ? 'thing' : 'things'} to fix`
        : schedule ? (dirty ? 'Ready to save' : 'No changes') : nextRun ? `First run ${scheduleDateLabel(nextRun, false)}` : 'Ready to start';

  // Schedules this template already has (a new one starts beside them).
  const existing = useRead(!schedule ? schedulesRead(isDemoMode, 'template') : null).data?.schedules.filter((s) => s.template_id === t.id) ?? [];

  if (isRemoved && schedule) {
    return (
      <TaskPanelShell labelledBy="schedule-title" onClose={onClose} header={<PanelHeader id="schedule-title" title="Schedule" detail={`${t.name}, ${templateSizeLabel(t)}`} onClose={onClose} />}>
        <div role="status" className="flex flex-col items-center gap-3 px-5 py-14 text-center">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-white/[0.05] text-zinc-400" aria-hidden="true"><Trash2 size={18} /></span>
          <p className="text-sm font-medium text-zinc-100">Schedule removed</p>
          <p className="max-w-xs text-xs text-zinc-400">It will not run again. Tasks and {INITIATIVE_LABEL.lowerPlural} it already made stay as they are.</p>
          <div className="mt-1 flex gap-2">
            <Button variant="secondary" size="sm" icon={<Undo2 size={14} aria-hidden="true" />} onClick={() => void undo()}>Undo</Button>
            <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
          </div>
        </div>
      </TaskPanelShell>
    );
  }

  return (
    <TaskPanelShell
      labelledBy="schedule-title"
      onClose={requestClose}
      header={<PanelHeader id="schedule-title" title={schedule ? 'Edit schedule' : 'Schedule a template'} detail={`${t.name}, ${templateSizeLabel(t)}`} onClose={requestClose} />}
      footer={
        <div className="border-t border-white/[0.06] px-5 py-3">
          {formError && <p role="alert" className="mb-2 text-xs text-red-300">{formError}</p>}
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-1">
              {schedule && editable && !isDemoMode && (
                <button
                  type="button"
                  onClick={() => void remove()}
                  aria-label="Remove this schedule"
                  className="flex-shrink-0 rounded-lg p-1.5 text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-red-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                >
                  <Trash2 size={15} aria-hidden="true" />
                </button>
              )}
              <p role="status" className={`truncate text-xs ${attempted && problemCount ? 'text-red-300' : 'text-zinc-400'}`}>{footerStatus}</p>
            </div>
            {editable && (
              <Button size="sm" onClick={() => void save()} disabled={busy || isDemoMode || (!!schedule && !dirty)}>{saveLabel}</Button>
            )}
          </div>
        </div>
      }
      after={discardDialog}
    >
      <div className="space-y-5 px-5 pb-6">
        {isDemoMode && <p className="rounded-lg bg-white/[0.04] px-3 py-2 text-xs text-zinc-400">The demo shows a schedule to try. Saving, pausing and removing are off.</p>}

        {schedule && (
          <div className="flex items-center gap-3 rounded-lg bg-white/[0.04] px-3 py-2.5">
            <span className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg ${schedule.status === 'paused' ? 'bg-amber-500/[0.14] text-amber-300' : 'bg-brand-500/15 text-brand-300'}`} aria-hidden="true">
              {schedule.status === 'paused' ? <Pause size={15} /> : <CalendarClock size={15} />}
            </span>
            <div className="min-w-0 flex-1">
              <p className={`text-sm font-medium ${schedule.status === 'paused' ? 'text-amber-200' : 'text-white'}`}>{statusLine}</p>
              <p className="line-clamp-2 text-[11px] text-zinc-400">
                {schedule.recurrence_label}{schedule.project_name ? ` in ${schedule.project_name}` : ''}{schedule.run_as_name ? `, runs as ${schedule.run_as === teamMemberId ? 'you' : schedule.run_as_name}` : ''}
              </p>
            </div>
            {editable && schedule.status !== 'ended' && (
              <Button
                variant="secondary"
                size="sm"
                icon={schedule.status === 'paused' ? <Play size={13} aria-hidden="true" /> : <Pause size={13} aria-hidden="true" />}
                onClick={() => void togglePaused()}
                disabled={statusBusy || isDemoMode}
              >
                {schedule.status === 'paused' ? 'Resume' : 'Pause'}
              </Button>
            )}
          </div>
        )}

        {!schedule && existing.length > 0 && (
          <div className="rounded-lg bg-white/[0.04] px-3 py-2.5">
            <p className="text-xs text-zinc-400">This template already runs on {existing.length === 1 ? 'a schedule' : `${existing.length} schedules`}. A new one runs beside {existing.length === 1 ? 'it' : 'them'}.</p>
            <ul className="mt-1.5 space-y-1">
              {existing.slice(0, 3).map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate text-zinc-200">{s.recurrence_label}{s.project_name ? ` in ${s.project_name}` : ''}</span>
                  <button type="button" onClick={() => onOpen(s.id)} className="flex-shrink-0 rounded text-xs font-medium text-brand-300 underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">Open</button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <fieldset disabled={!editable} className="m-0 min-w-0 space-y-5 border-0 p-0">
          <Section id="schedule-when" title="When" description="It runs on each date of this pattern, counted from the start date.">
            <RecurrencePicker value={recurrence} onChange={setRecurrence} startDate={startDate || today} timeZone={timezone} endDate={endDate || null} error={fieldError('recurrence')} />
            <div className="mt-4 space-y-4">
              <Select
                label="Time zone"
                visibleLabel="Time zone"
                value={timezone}
                onChange={setTimezone}
                options={zoneOptions()}
                searchable
                description="Runs start at midnight here."
                error={fieldError('timezone')}
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <DateInput label="Starts" value={startDate} onChange={setStartDate} error={fieldError('start_date')} />
                <DateInput label="Ends" value={endDate} onChange={setEndDate} placeholder="No end date" clearable minDate={startDate || undefined} error={fieldError('end_date')} />
              </div>
            </div>
          </Section>

          <Section id="schedule-project" title="Project" description={lockedTo ? undefined : 'Each run creates its tasks here.'}>
            {lockedTo ? (
              <p className="flex items-center gap-2 rounded-lg bg-white/[0.04] px-3 py-2 text-sm text-zinc-200">
                <Lock size={14} className="flex-shrink-0 text-zinc-400" aria-hidden="true" />
                <span className="min-w-0 truncate">{t.project_name ?? project?.name ?? 'Its project'}</span>
                <span className="ml-auto flex-shrink-0 text-xs text-zinc-400">This template&apos;s project</span>
              </p>
            ) : (
              <Select
                label="Project"
                ariaLabel="Project"
                searchable
                value={projectChoice}
                onChange={setProjectChoice}
                placeholder="Pick a project"
                options={projectChoices.map((p) => ({ value: p.id, label: p.name }))}
                error={fieldError('project_id')}
              />
            )}
          </Section>

          {roles.length > 0 && (
            <Section id="schedule-roles" title="Roles" description={`Each run gives a role's tasks to this person or agent.${!assignsOthers ? ' Giving tasks to others needs Manage all tasks.' : ''}`}>
              <div className="space-y-4">
                {roles.map((role) => (
                  <Select
                    key={role.key}
                    label={`${role.label}${role.required ? ' *' : ''}`}
                    visibleLabel={`${role.label}${role.required ? ' *' : ''}`}
                    value={roleMap[role.key] ?? ''}
                    onChange={(next) => setRoleMap((m) => ({ ...m, [role.key]: next }))}
                    options={roleOptions(role.default_member_id ?? null, roleMap[role.key] ?? '')}
                    searchable={active.length > 8}
                    error={fieldError(`roles.${role.key}`)}
                  />
                ))}
              </div>
            </Section>
          )}

          {t.fields.length > 0 && (
            <Section id="schedule-fields" title="Fill-ins" description={askFields.length ? 'The same on every run. They go into the task titles and descriptions.' : undefined}>
              <div className="space-y-4">
                {builtIns.map((field) => (
                  <p key={field.key} className="flex items-baseline justify-between gap-3 rounded-lg bg-white/[0.04] px-3 py-2 text-sm">
                    <span className="text-zinc-300">{field.label}</span>
                    <span className="text-right text-xs text-zinc-400">
                      Filled on each run{nextRun ? <>: <span className="text-zinc-200">{field.key === 'month' ? scheduleFills(nextRun).month : scheduleDateLabel(nextRun)}</span></> : ''}
                    </span>
                  </p>
                ))}
                {askFields.map((field) => {
                  const label = `${field.label}${field.required !== false ? ' *' : ''}`;
                  const error = fieldError(`values.${field.key}`);
                  const setValue = (value: string) => setValues((v) => ({ ...v, [field.key]: value }));
                  if (field.type === 'date') return <DateInput key={field.key} label={label} value={values[field.key] ?? ''} onChange={setValue} error={error} />;
                  if (field.type === 'choice') {
                    return <Select key={field.key} label={label} visibleLabel={label} value={values[field.key] ?? ''} onChange={setValue} placeholder="Pick one" options={(field.options ?? []).map((o) => ({ value: o, label: o }))} error={error} />;
                  }
                  if (field.type === 'member') {
                    return <Select key={field.key} label={label} visibleLabel={label} value={values[field.key] ?? ''} onChange={setValue} placeholder="Pick someone" searchable={active.length > 8} options={memberFieldOptions} error={error} />;
                  }
                  return <TextInput key={field.key} label={label} value={values[field.key] ?? ''} onChange={setValue} placeholder={`Fills in {${field.key}}`} maxLength={TEMPLATE_VALUE_MAX} error={error} />;
                })}
              </div>
            </Section>
          )}

          {keyDateList.length > 1 && (
            <Section id="schedule-key-dates" title="Key dates" description={`${keyDateList[0].label} is the run's date. Set how many days after it each other key date falls (a negative number is before it).`}>
              <div className="space-y-3">
                {keyDateList.slice(1).map((keyDate) => {
                  const days = offsets[keyDate.key] ?? 0;
                  return (
                    <div key={keyDate.key} className="flex items-center gap-3">
                      <span className="min-w-0 flex-1 truncate text-sm text-zinc-200">{keyDate.label}</span>
                      <NumberInput
                        value={days}
                        onChange={(next) => setOffsets((o) => ({ ...o, [keyDate.key]: next === '' ? 0 : Math.max(-365, Math.min(365, Math.round(next))) }))}
                        min={-365}
                        max={365}
                        precision={0}
                        showButtons={false}
                        className="w-20 flex-shrink-0"
                        inputClassName="tabular-nums"
                        suffix="days"
                        aria-label={`${keyDate.label}: days from the run's date`}
                        error={fieldError(`key_date_offsets.${keyDate.key}`)}
                      />
                      <span className="w-24 flex-shrink-0 text-right text-xs tabular-nums text-zinc-400">{nextRun ? scheduleDateLabel(addDays(nextRun, days), false) : ''}</span>
                    </div>
                  );
                })}
                {nextRun && <p className="text-[11px] text-zinc-500">Dates shown for the next run, {keyDateList[0].label} {scheduleDateLabel(nextRun, false)}.</p>}
              </div>
            </Section>
          )}

          <Section id="schedule-each-run" title="Each run">
            <div className="space-y-4">
              <Toggle
                checked={createInitiative}
                onChange={setCreateInitiative}
                label={`Create an ${INITIATIVE_LABEL.lower} for each run`}
                description={`Its tasks go in their own ${INITIATIVE_LABEL.lower}, with a board and a log.`}
              />
              <Toggle
                checked={skipIfOpen}
                onChange={setSkipIfOpen}
                label="Skip a run while the previous one still has open tasks"
                description="Runs never pile up. Turn it off to make every run on its date."
              />
            </div>
          </Section>
        </fieldset>

        {strayIssues.length > 0 && (
          <ul role="alert" className="space-y-1 rounded-lg bg-red-500/[0.1] px-3 py-2.5 text-xs text-red-300">
            {strayIssues.map((issue) => <li key={`${pathOf(issue)}:${issue.message}`} className="flex gap-2"><AlertTriangle size={13} className="mt-0.5 flex-shrink-0" aria-hidden="true" />{issue.message}</li>)}
          </ul>
        )}

        {schedule && <ScheduleHistory schedule={schedule} templateId={t.id} />}
      </div>
    </TaskPanelShell>
  );
}

/** What the schedule's last runs did: the date it was for, made or skipped and why, and a link to what it made. */
function ScheduleHistory({ schedule, templateId }: { schedule: ScheduleView; templateId: string }) {
  const { isDemoMode } = useDemo();
  const occurrences = useRead(scheduleOccurrencesRead(schedule.id, isDemoMode));
  const runs = useRead(taskTemplateRunsRead(templateId, isDemoMode));
  const runById = new Map((runs.data?.rows ?? []).map((run) => [run.id, run]));
  const linkFor = (o: ScheduleOccurrenceView): { href: string; label: string } | null => {
    if (o.task_id) return { href: `/projects/${encodeURIComponent(schedule.project_id)}/tasks/${encodeURIComponent(o.task_id)}`, label: 'Open task' };
    const run = o.run_id ? runById.get(o.run_id) : undefined;
    if (run?.initiative_id) return { href: `/projects/${encodeURIComponent(run.project_id)}/initiatives/${encodeURIComponent(run.initiative_id)}`, label: `Open ${INITIATIVE_LABEL.lower}` };
    if (run?.task_ids[0]) return { href: `/projects/${encodeURIComponent(run.project_id)}/tasks/${encodeURIComponent(run.task_ids[0])}`, label: run.task_ids.length > 1 ? `Open first of ${run.task_ids.length}` : 'Open task' };
    return null;
  };
  const rows = occurrences.data ?? [];
  return (
    <Section id="schedule-history" title="History" description="Its last runs, newest first.">
      {occurrences.failed && !occurrences.data ? (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-lg bg-white/[0.03] px-3 py-2.5 text-sm text-zinc-300">
          Could not load its history.
          <Button variant="ghost" size="sm" icon={<RefreshCw size={13} aria-hidden="true" />} onClick={occurrences.reload}>Try again</Button>
        </div>
      ) : !occurrences.data ? (
        <div role="status" aria-label="Loading history" className="space-y-1.5">
          {[0, 1].map((i) => <div key={i} className="h-9 rounded-lg bg-white/[0.03] motion-safe:animate-pulse" />)}
        </div>
      ) : rows.length === 0 ? (
        <p className="rounded-lg bg-white/[0.03] px-3 py-2.5 text-sm text-zinc-400">
          No runs yet.{schedule.next_on ? ` The first is ${scheduleDateLabel(schedule.next_on, false)}.` : ''}
        </p>
      ) : (
        <ol className="divide-y divide-white/[0.06] rounded-lg border border-white/[0.06]">
          {rows.map((o) => {
            const link = linkFor(o);
            const tone = o.status === 'created' ? 'bg-emerald-400' : o.status === 'failed' ? 'bg-red-400' : o.status === 'running' ? 'bg-sky-400' : 'bg-zinc-500';
            return (
              <li key={o.id} className="flex items-start gap-3 px-3 py-2">
                <span className={`mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full ${tone}`} aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-zinc-200">
                    <span className="tabular-nums">{scheduleDateLabel(o.scheduled_for)}</span>
                    <span className={o.status === 'failed' ? 'text-red-300' : o.status === 'created' ? 'text-zinc-300' : 'text-zinc-400'}> · {occurrenceLabel(o)}</span>
                  </p>
                  {o.status === 'failed' && o.error && <p className="mt-0.5 line-clamp-2 text-[11px] text-zinc-400">{o.error}</p>}
                </div>
                {link && (
                  <Link href={link.href} className="flex-shrink-0 rounded text-xs font-medium text-brand-300 underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
                    {link.label}
                  </Link>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </Section>
  );
}

