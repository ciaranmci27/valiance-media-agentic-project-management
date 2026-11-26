'use client';

import { useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { LayoutTemplate, Plus, RefreshCw, Repeat, Rocket, Search } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { canAccessProject, hasPermission } from '@/lib/access-control';
import { useRead } from '@/lib/query-cache';
import { schedulesRead, taskTemplatesRead } from '@/lib/reads';
import { RUNNER } from '@/lib/task-templates';
import { canWriteSomeTemplate } from '@/lib/template-ui';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/inputs/Select';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import { NoMatches, SubNav } from '@/components/projects/TabLayout';
import { TemplatePanel, type TemplateDraft } from '@/components/templates/TemplatePanel';
import { UseTemplatePanel } from '@/components/templates/UseTemplatePanel';
import { RepeatsChip, TemplateRow, useTemplateRowActions } from '@/components/templates/TemplateLibrary';
import { SchedulePanel } from '@/components/schedules/SchedulePanel';
import { ScheduleList } from '@/components/schedules/ScheduleList';

type Filter = 'all' | 'workspace' | 'project';
type Opened = { kind: 'edit'; id: string | null; starter?: TemplateDraft | null } | { kind: 'use'; id: string }
  | { kind: 'schedule'; templateId: string | null; scheduleId: string | null } | null;

const PAGE = 25;

/** Two starting points that show what a template can be: one repeating task, and a playbook planned back from a launch date. */
const STARTERS: { id: string; icon: typeof Repeat; label: string; hint: string; draft: TemplateDraft }[] = [
  {
    id: 'payroll',
    icon: Repeat,
    label: 'Monthly payroll upload',
    hint: 'One task you do every month',
    draft: {
      name: 'Monthly payroll upload',
      description: 'Use it at the start of each month.',
      project_id: null,
      fields: [{ key: 'month', label: 'Month' }],
      items: [{ key: 'upload', title: 'Upload the {month} payroll sheet', description: '', priority: 'high', tags: ['payroll'], assignee: RUNNER, due_in_days: 3, subtasks: [] }],
    },
  },
  {
    id: 'launch',
    icon: Rocket,
    label: 'Product launch playbook',
    hint: 'Planned back from the launch date',
    draft: {
      name: 'Product launch',
      description: 'Everything a new product launch needs, from brief to review.',
      project_id: null,
      key_dates: [{ key: 'kickoff', label: 'Kickoff' }, { key: 'launch', label: 'Launch date', main: true }],
      roles: [{ key: 'designer', label: 'Designer', required: true }, { key: 'copywriter', label: 'Copywriter' }],
      fields: [{ key: 'product', label: 'Product' }],
      items: [
        { key: 'brief', title: 'Write the {product} launch brief', description: 'Who it is for, what is new, and the launch date.', priority: 'high', tags: ['launch'], assignee: RUNNER, anchor: 'kickoff', due_in_days: 2, subtasks: [] },
        { key: 'assets', title: 'Design the {product} launch assets', description: '', priority: 'medium', tags: ['launch'], assignee: null, role: 'designer', anchor: 'launch', due_in_days: -14, depends_on: ['brief'], subtasks: [] },
        { key: 'copy', title: 'Write the {product} announcement', description: '', priority: 'medium', tags: ['launch'], assignee: null, role: 'copywriter', anchor: 'launch', due_in_days: -7, depends_on: ['brief'], subtasks: [] },
        { key: 'ship', title: 'Launch {product}', description: '', priority: 'urgent', tags: ['launch'], assignee: RUNNER, anchor: 'launch', due_in_days: 0, depends_on: ['assets', 'copy'], subtasks: [] },
        { key: 'retro', title: 'Review how the {product} launch went', description: '', priority: 'low', tags: ['launch'], assignee: RUNNER, anchor: 'launch', due_in_days: 14, depends_on: ['ship'], subtasks: [] },
      ],
    },
  },
];

/**
 * Settings > Templates: every template the person may read, company-wide
 * ones and each project's own, with a switch between them (and a project
 * picker for project templates). Each row shows where it lives, what it
 * makes, its key dates and roles, and when it last ran, with Edit, Use,
 * Duplicate, Move and Trash. A project's own templates are also reachable
 * from its Tasks toolbar ("Manage templates").
 */
export function TemplatesSection() {
  const { projects } = useApp();
  const { access } = useAuth();
  const { isDemoMode } = useDemo();
  const params = useSearchParams();
  const linkedProject = params.get('project');
  const [filter, setFilter] = useState<Filter>(linkedProject ? 'project' : 'all');
  const [projectFilter, setProjectFilter] = useState(linkedProject ?? '');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE);
  // A deep link (the paused-schedule notification) opens that schedule.
  const linkedSchedule = params.get('schedule');
  const [opened, setOpened] = useState<Opened>(linkedSchedule ? { kind: 'schedule', templateId: null, scheduleId: linkedSchedule } : null);
  const canWrite = isDemoMode || canWriteSomeTemplate(access);
  const canRun = hasPermission(access, 'tasks.create');
  const list = useRead(taskTemplatesRead(isDemoMode));
  const all = useMemo(() => list.data ?? [], [list.data]);
  const { actionsFor, dialogs } = useTemplateRowActions({
    onEdit: (t) => setOpened({ kind: 'edit', id: t.id }),
    onUse: (t) => setOpened({ kind: 'use', id: t.id }),
    onSchedule: (t) => setOpened({ kind: 'schedule', templateId: t.id, scheduleId: null }),
  });
  const schedules = useRead(schedulesRead(isDemoMode, 'template')).data?.schedules;
  const scheduled = useMemo(() => new Set((schedules ?? []).filter((s) => s.status === 'active').map((s) => s.template_id)), [schedules]);

  const counts = { all: all.length, workspace: all.filter((t) => !t.project_id).length, project: all.filter((t) => t.project_id).length };
  const projectOptions = useMemo(() => {
    const withTemplates = new Set(all.map((t) => t.project_id).filter(Boolean));
    return projects
      .filter((p) => withTemplates.has(p.id) || (p.status !== 'archived' && canAccessProject(access, p.id)))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => ({ value: p.id, label: p.name, detail: `${all.filter((t) => t.project_id === p.id).length || 'No'} templates` }));
  }, [projects, all, access]);
  const needle = query.trim().toLowerCase();
  const rows = all
    .filter((t) => (filter === 'workspace' ? !t.project_id : filter === 'project' ? !!t.project_id && (!projectFilter || t.project_id === projectFilter) : true))
    .filter((t) => !needle || `${t.name} ${t.description} ${t.project_name ?? ''}`.toLowerCase().includes(needle));
  const visible = rows.slice(0, limit);

  const newTemplate = (starter: TemplateDraft | null = null) => setOpened({
    kind: 'edit', id: null, starter: starter ?? (filter === 'project' && projectFilter ? { name: '', description: '', project_id: projectFilter, fields: [], items: [] } : null),
  });

  return (
    <section id="templates" className="glass-card rounded-xl p-4 lg:p-6 scroll-mt-6" aria-labelledby="templates-heading">
      <SettingsSectionHeader
        icon={LayoutTemplate}
        headingId="templates-heading"
        title="Templates"
        description="Playbooks for work you do again and again: the same tasks every time, due around the dates you pick, given to the right people. Company-wide ones work in any project; a project's own show only there."
        action={canWrite && all.length > 0 ? (
          <Button size="sm" icon={<Plus size={14} aria-hidden="true" />} onClick={() => newTemplate()} className="flex-shrink-0">
            <span className="hidden sm:inline">New template</span><span className="sm:hidden">New</span>
          </Button>
        ) : undefined}
      />

      {isDemoMode && <p className="mb-4 rounded-lg bg-white/[0.04] px-3 py-2 text-xs text-zinc-400">The demo shows templates to try. Using one works; saving changes to a template is off.</p>}

      {list.failed && !list.data ? (
        <div role="alert" className="flex flex-col items-center gap-3 rounded-lg bg-white/[0.03] py-10 text-center">
          <p className="text-sm text-zinc-300">Could not load the templates.</p>
          <Button variant="secondary" size="sm" icon={<RefreshCw size={13} aria-hidden="true" />} onClick={list.reload}>Try again</Button>
        </div>
      ) : !list.data ? (
        <div role="status" aria-label="Loading templates" className="space-y-2">
          {[0, 1, 2].map((i) => <div key={i} className="h-16 rounded-lg bg-white/[0.03] motion-safe:animate-pulse" />)}
        </div>
      ) : all.length === 0 ? (
        <div className="rounded-lg bg-white/[0.03] px-4 py-10 text-center">
          <p className="text-sm font-medium text-zinc-200">No templates yet</p>
          <p className="mt-1 text-xs text-zinc-400">{canWrite ? 'Start from one of these, or from scratch.' : 'Whoever manages templates can set them up for work you do again and again.'}</p>
          {canWrite && (
            <>
              <div className="mx-auto mt-5 grid max-w-xl gap-3 sm:grid-cols-2">
                {STARTERS.map((starter) => (
                  <button
                    key={starter.id}
                    type="button"
                    onClick={() => newTemplate(starter.draft)}
                    className="flex items-start gap-3 rounded-xl bg-white/[0.04] p-4 text-left ring-1 ring-white/[0.06] transition-colors hover:bg-white/[0.07] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                  >
                    <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-brand-500/15 text-brand-300" aria-hidden="true"><starter.icon size={15} /></span>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-white">{starter.label}</span>
                      <span className="block text-xs text-zinc-400">{starter.hint}</span>
                    </span>
                  </button>
                ))}
              </div>
              <Button className="mt-4" variant="ghost" size="sm" icon={<Plus size={14} aria-hidden="true" />} onClick={() => newTemplate()}>Start from scratch</Button>
            </>
          )}
        </div>
      ) : (
        <>
          <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="max-w-full overflow-x-auto scrollbar-none">
              <SubNav<Filter>
                label="Which templates"
                active={filter}
                onChange={(key) => { setFilter(key); setLimit(PAGE); }}
                items={[
                  { key: 'all', label: 'All', count: counts.all },
                  { key: 'workspace', label: 'Company-wide', count: counts.workspace },
                  { key: 'project', label: 'Project only', count: counts.project },
                ]}
              />
            </div>
            {all.length > 6 && (
              <div className="sm:w-56">
                <TextInput size="sm" value={query} onChange={(value) => { setQuery(value); setLimit(PAGE); }} placeholder="Search templates" leftIcon={Search} aria-label="Search templates" clearable />
              </div>
            )}
          </div>
          {filter === 'project' && (
            <div className="mb-3 sm:max-w-xs">
              <Select
                size="sm"
                ariaLabel="Project"
                value={projectFilter}
                onChange={(value) => { setProjectFilter(value); setLimit(PAGE); }}
                options={[{ value: '', label: 'Every project' }, ...projectOptions]}
                searchable={projectOptions.length > 8}
              />
            </div>
          )}
          {rows.length === 0 ? (
            <div className="rounded-lg border border-white/[0.06]">
              <NoMatches>
                {needle ? 'No templates match your search.' : filter === 'workspace' ? 'No company-wide templates yet.'
                  : projectFilter ? 'This project has no templates of its own yet.' : 'No project has its own templates yet.'}
              </NoMatches>
            </div>
          ) : (
            <ul className="divide-y divide-white/[0.06] rounded-lg border border-white/[0.06]">
              {visible.map((template) => (
                <TemplateRow
                  key={template.id}
                  template={template}
                  onOpen={() => setOpened({ kind: 'edit', id: template.id })}
                  actions={actionsFor(template)}
                  chip={scheduled.has(template.id) ? <RepeatsChip /> : undefined}
                />
              ))}
            </ul>
          )}
          {rows.length > visible.length && (
            <Button variant="ghost" size="sm" className="mt-2 -ml-2.5" onClick={() => setLimit((n) => n + PAGE)}>
              Show {Math.min(PAGE, rows.length - visible.length)} more of {rows.length - visible.length}
            </Button>
          )}
        </>
      )}

      {list.data && (all.length > 0 || (schedules?.length ?? 0) > 0) && (
        <div className="mt-6 border-t border-white/[0.06] pt-5">
          <ScheduleList onOpen={(s) => setOpened({ kind: 'schedule', templateId: s.template_id, scheduleId: s.id })} />
        </div>
      )}

      {dialogs}
      {opened?.kind === 'edit' && (
        <TemplatePanel
          templateId={opened.id}
          starter={opened.starter ?? null}
          onClose={() => setOpened(null)}
          onUse={canRun ? (id) => setOpened({ kind: 'use', id }) : undefined}
          onSchedule={canRun ? (id) => setOpened({ kind: 'schedule', templateId: id, scheduleId: null }) : undefined}
        />
      )}
      {opened?.kind === 'use' && <UseTemplatePanel templateId={opened.id} onClose={() => setOpened(null)} />}
      {opened?.kind === 'schedule' && (
        <SchedulePanel
          key={opened.scheduleId ?? opened.templateId ?? 'schedule'}
          templateId={opened.templateId}
          scheduleId={opened.scheduleId}
          onClose={() => setOpened(null)}
        />
      )}
    </section>
  );
}
