'use client';

import { useEffect, useState } from 'react';
import { LayoutTemplate, Lock, Plus, RefreshCw, Rocket, Repeat } from 'lucide-react';
import { useApp, defaultFilters } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { hasPermission } from '@/lib/access-control';
import { useRead, warmRead } from '@/lib/query-cache';
import { taskTemplateRead, taskTemplatesRead, useIntent } from '@/lib/reads';
import { timeAgo } from '@/lib/task-times';
import { RUNNER, templateSizeLabel, type TaskTemplateSummary } from '@/lib/task-templates';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/Button';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { TemplatePanel, type TemplateDraft } from '@/components/templates/TemplatePanel';
import { UseTemplatePanel } from '@/components/templates/UseTemplatePanel';

/** Two starting points that show what a template can be: one repeating task, and a playbook. */
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
      items: [{
        title: 'Upload the {month} payroll sheet', description: '', priority: 'high', tags: ['payroll'], assignee: RUNNER, due_in_days: 3, subtasks: [],
      }],
    },
  },
  {
    id: 'launch',
    icon: Rocket,
    label: 'Product launch playbook',
    hint: 'The same steps for every launch',
    draft: {
      name: 'Product launch',
      description: 'Everything a new product launch needs, from brief to review.',
      project_id: null,
      fields: [{ key: 'product', label: 'Product' }],
      items: [
        {
          title: 'Write the {product} launch brief', description: 'Who it is for, what is new, and the launch date.', priority: 'high', tags: ['launch'], assignee: RUNNER, due_in_days: 2,
          subtasks: [
            { title: 'Agree the launch date', description: '', priority: 'medium', tags: [], assignee: RUNNER, due_in_days: 1 },
            { title: 'List who needs to know', description: '', priority: 'medium', tags: [], assignee: RUNNER, due_in_days: 2 },
          ],
        },
        { title: 'Design the {product} launch assets', description: '', priority: 'medium', tags: ['launch'], assignee: null, due_in_days: 7, subtasks: [] },
        { title: 'Write the {product} announcement', description: '', priority: 'medium', tags: ['launch'], assignee: null, due_in_days: 10, subtasks: [] },
        { title: 'Set up the {product} landing page', description: '', priority: 'medium', tags: ['launch'], assignee: null, due_in_days: 14, subtasks: [] },
        { title: 'Launch {product}', description: '', priority: 'urgent', tags: ['launch'], assignee: RUNNER, due_in_days: 21, subtasks: [] },
        { title: 'Review how the {product} launch went', description: '', priority: 'low', tags: ['launch'], assignee: RUNNER, due_in_days: 28, subtasks: [] },
      ],
    },
  },
];

type Opened = { kind: 'view'; id: string } | { kind: 'new'; starter: TemplateDraft | null } | { kind: 'use'; id: string } | null;

/**
 * Templates: repeat work set up once. One task ("Upload the payroll sheet"
 * every month) or a playbook (every product launch needs the same tasks).
 * Everyone who creates tasks uses them here, from a project, or from the New
 * task panel; Owners and Admins (Manage templates) set them up. Open one to
 * read or change it in the side panel; Use asks for its fill-ins and start
 * date, shows what it will create, and creates it all at once.
 */
export default function TemplatesPage() {
  const { filters, setFilters } = useApp();
  const { access } = useAuth();
  const { isDemoMode } = useDemo();
  const canManage = !isDemoMode && hasPermission(access, 'templates.manage');
  // Using one creates tasks; reading the library is also open to whoever manages it.
  const canRun = hasPermission(access, 'tasks.create');
  const canUse = canRun || hasPermission(access, 'templates.manage');
  const [opened, setOpened] = useState<Opened>(null);
  const intent = useIntent();

  useEffect(() => {
    setFilters(defaultFilters);
  }, [setFilters]);

  const list = useRead(canUse ? taskTemplatesRead(isDemoMode) : null);
  const search = filters.search.trim().toLowerCase();
  const all = list.data ?? [];
  const rows = search ? all.filter((t) => `${t.name} ${t.description}`.toLowerCase().includes(search)) : all;
  const warm = (t: TaskTemplateSummary) => intent(() => void warmRead(taskTemplateRead(t.id, isDemoMode)));

  const nameCell = (t: TaskTemplateSummary) => (
    <div className="flex min-w-0 items-center gap-3">
      <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-brand-500/15 text-brand-300" aria-hidden="true"><LayoutTemplate size={15} /></span>
      <div className="min-w-0">
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setOpened({ kind: 'view', id: t.id }); }}
          {...warm(t)}
          className="block max-w-full truncate rounded text-left font-semibold text-white transition-colors hover:text-brand-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          {t.name}
        </button>
        {t.description && <p className="max-w-[420px] truncate text-xs text-zinc-400">{t.description}</p>}
      </div>
    </div>
  );
  const whereLabel = (t: TaskTemplateSummary) => (t.project_id
    ? <span className="inline-flex items-center gap-1.5 text-zinc-300"><Lock size={12} className="text-zinc-500" aria-hidden="true" />{t.project_name ?? 'One project'}</span>
    : <span className="text-zinc-400">Any project</span>);
  const lastUsed = (t: TaskTemplateSummary) => (t.last_run_at ? `${timeAgo(t.last_run_at)} · ${t.run_count} ${t.run_count === 1 ? 'use' : 'uses'}` : 'Not used yet');
  const actionCell = (t: TaskTemplateSummary) => (canRun ? (
    <Button variant="secondary" size="sm" onClick={(e) => { e.stopPropagation(); setOpened({ kind: 'use', id: t.id }); }} {...warm(t)} aria-label={`Use ${t.name}`}>
      Use
    </Button>
  ) : null);

  const columns: Column<TaskTemplateSummary>[] = [
    { key: 'name', header: 'Template', render: nameCell, sortValue: (t) => t.name.toLowerCase() },
    { key: 'makes', header: 'Makes', className: 'hidden md:table-cell', render: (t) => <span className="text-zinc-300">{templateSizeLabel(t)}</span>, sortValue: (t) => t.task_count },
    {
      key: 'asks', header: 'Asks for', className: 'hidden lg:table-cell',
      render: (t) => <span className="text-zinc-400">{t.fields.length ? t.fields.map((f) => f.label).join(', ') : 'Nothing'}</span>,
    },
    { key: 'where', header: 'Where', className: 'hidden sm:table-cell', render: whereLabel, sortValue: (t) => t.project_name ?? '' },
    { key: 'used', header: 'Last used', className: 'hidden md:table-cell', render: (t) => <span className="tabular-nums text-zinc-400">{lastUsed(t)}</span>, sortValue: (t) => t.last_run_at ?? '' },
    ...(canRun ? [{ key: 'use', header: <span className="sr-only">Use</span>, align: 'right' as const, render: actionCell }] : []),
  ];

  const mobileCard = (t: TaskTemplateSummary) => (
    <div className="glass-card rounded-xl p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          {nameCell(t)}
          <p className="mt-2 text-xs text-zinc-400">{templateSizeLabel(t)} · {t.project_id ? `Only in ${t.project_name ?? 'one project'}` : 'Any project'}</p>
          <p className="text-xs text-zinc-500">{lastUsed(t)}</p>
        </div>
        {actionCell(t)}
      </div>
    </div>
  );

  return (
    <div className="animate-fadeIn min-h-screen">
      <Header
        title="Templates"
        subtitle={<span className="hidden sm:inline">{list.loading ? 'Loading templates' : `${all.length} template${all.length === 1 ? '' : 's'}`}</span>}
        searchPlaceholder="Search templates..."
        actions={canManage ? <Button icon={<Plus size={16} />} onClick={() => setOpened({ kind: 'new', starter: null })}>New template</Button> : undefined}
      />

      <div className="space-y-4 p-4 lg:p-6">
        <p className="max-w-2xl text-sm text-zinc-400">
          Set up repeat work once, then make it in one click: a single task you do every month, or a playbook of tasks you need every time, with due dates that fall into place.
        </p>
        {!canUse ? (
          <div className="glass-card rounded-xl py-12 text-center">
            <h3 className="mb-1 font-medium text-zinc-300">Templates are for people who create tasks</h3>
            <p className="text-sm text-zinc-400">Ask an Owner to give you Create tasks.</p>
          </div>
        ) : list.failed && !all.length ? (
          <div role="alert" className="glass-card flex flex-col items-center gap-3 rounded-xl py-12 text-center">
            <p className="text-sm text-zinc-300">Could not load the templates.</p>
            <Button variant="secondary" size="sm" icon={<RefreshCw size={13} aria-hidden="true" />} onClick={list.reload}>Try again</Button>
          </div>
        ) : list.loading && !all.length ? (
          <div role="status" className="glass-card rounded-xl py-12 text-center text-sm text-zinc-400">Loading templates</div>
        ) : !all.length ? (
          <div className="glass-card rounded-xl px-4 py-12 text-center">
            <LayoutTemplate className="mx-auto mb-3 text-zinc-500" size={36} aria-hidden="true" />
            <h3 className="mb-1 font-medium text-zinc-300">No templates yet</h3>
            <p className="text-sm text-zinc-400">
              {canManage ? 'Start from one of these, or from scratch.' : 'An Owner or Admin can set up templates for work you do again and again.'}
            </p>
            {canManage && (
              <div className="mx-auto mt-5 grid max-w-xl gap-3 sm:grid-cols-2">
                {STARTERS.map((starter) => (
                  <button
                    key={starter.id}
                    type="button"
                    onClick={() => setOpened({ kind: 'new', starter: starter.draft })}
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
            )}
            {canManage && <Button className="mt-4" variant="ghost" icon={<Plus size={16} />} onClick={() => setOpened({ kind: 'new', starter: null })}>Start from scratch</Button>}
          </div>
        ) : !rows.length ? (
          <div className="glass-card rounded-xl py-12 text-center">
            <h3 className="mb-1 font-medium text-zinc-300">No templates match your search</h3>
            <p className="text-sm text-zinc-400">Try another name.</p>
          </div>
        ) : (
          <DataTable
            columns={columns}
            data={rows}
            keyExtractor={(t) => t.id}
            onRowClick={(t) => setOpened({ kind: 'view', id: t.id })}
            emptyState="No templates"
            mobileCard={mobileCard}
            initialSort={{ key: 'name', dir: 'asc' }}
          />
        )}
      </div>

      {opened?.kind === 'view' && (
        <TemplatePanel templateId={opened.id} onClose={() => setOpened(null)} onUse={canRun ? (id) => setOpened({ kind: 'use', id }) : undefined} />
      )}
      {opened?.kind === 'new' && (
        <TemplatePanel templateId={null} starter={opened.starter} onClose={() => setOpened(null)} />
      )}
      {opened?.kind === 'use' && (
        <UseTemplatePanel templateId={opened.id} onClose={() => setOpened(null)} />
      )}
    </div>
  );
}
