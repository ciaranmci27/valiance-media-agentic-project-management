'use client';

import { Suspense, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { BellRing } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { Header } from '@/components/layout/Header';
import { Select } from '@/components/ui/inputs/Select';
import { ReminderComposer } from '@/components/reminders/ReminderComposer';
import { ReminderGroups } from '@/components/reminders/ReminderGroups';
import { reminderGroup } from '@/lib/reminders';

type Scope = 'mine' | 'all';

const NO_PROJECT = 'none';
const ALL_PROJECTS = 'all';

// useSearchParams (?project=) needs a Suspense boundary on a static page.
export default function RemindersPage() {
  return (
    <Suspense fallback={null}>
      <Reminders />
    </Suspense>
  );
}

/**
 * Every reminder in one place: yours by default, or everything shared with
 * you on tasks and projects. Grouped by what needs attention first.
 */
function Reminders() {
  const { reminders, projects, addReminder } = useApp();
  const { teamMemberId } = useAuth();
  const searchParams = useSearchParams();
  const [scope, setScope] = useState<Scope>('mine');
  const [projectFilter, setProjectFilter] = useState(searchParams.get('project') ?? ALL_PROJECTS);
  const [newProject, setNewProject] = useState(NO_PROJECT);

  const activeProjects = useMemo(
    () => projects.filter(p => p.status !== 'archived').sort((a, b) => a.name.localeCompare(b.name)),
    [projects],
  );

  const visible = reminders.filter(r =>
    (scope === 'all' || r.owner_id === teamMemberId)
    && (projectFilter === ALL_PROJECTS
      || (projectFilter === NO_PROJECT ? r.project_id === null : r.project_id === projectFilter)));

  const now = new Date();
  const overdue = visible.filter(r => reminderGroup(r, now) === 'overdue').length;
  const today = visible.filter(r => reminderGroup(r, now) === 'today').length;
  const open = visible.filter(r => r.status === 'open').length;
  const summary = open === 0
    ? 'Nothing waiting'
    : [overdue && `${overdue} overdue`, today && `${today} today`, `${open} open`].filter(Boolean).join(', ');

  const filterOptions = [
    { value: ALL_PROJECTS, label: 'All projects' },
    { value: NO_PROJECT, label: 'No project' },
    ...activeProjects.map(p => ({ value: p.id, label: p.name })),
  ];
  const newProjectOptions = [
    { value: NO_PROJECT, label: 'No project (just mine)' },
    ...activeProjects.map(p => ({ value: p.id, label: p.name })),
  ];

  return (
    <div className="animate-fadeIn min-h-screen">
      <Header title="Reminders" subtitle={<span className="hidden sm:inline">{summary}</span>} />

      <div className="p-4 lg:p-6 space-y-6 max-w-4xl">
        <div className="glass-card rounded-xl p-4 space-y-3">
          <ReminderComposer
            expanded
            placeholder="What should you be reminded of?"
            onAdd={(draft) => void addReminder({
              ...draft,
              project_id: newProject === NO_PROJECT ? null : newProject,
            })}
          />
          <Select
            ariaLabel="Project for the new reminder"
            value={newProject}
            onChange={setNewProject}
            options={newProjectOptions}
            searchable
            size="sm"
            className="w-full sm:w-64"
          />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="seg-track seg-sm w-fit" role="group" aria-label="Whose reminders">
            {([['mine', 'Mine'], ['all', 'Shared with me too']] as const).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setScope(id)}
                aria-pressed={scope === id}
                className={`seg-item ${scope === id ? 'is-active' : ''}`}
              >
                {label}
              </button>
            ))}
          </div>
          <Select
            ariaLabel="Filter by project"
            value={projectFilter}
            onChange={setProjectFilter}
            options={filterOptions}
            searchable
            size="sm"
            className="w-full sm:w-56"
          />
        </div>

        {visible.length === 0 ? (
          <div className="glass-card rounded-xl flex flex-col items-center justify-center py-14 text-center">
            <div className="w-12 h-12 rounded-full bg-white/[0.06] flex items-center justify-center mb-4">
              <BellRing size={20} className="text-zinc-400" aria-hidden="true" />
            </div>
            <p className="text-sm font-medium text-zinc-300">No reminders here</p>
            <p className="text-xs text-zinc-500 mt-1 max-w-xs">
              Add the next step a task is waiting on, or anything you would otherwise have to remember.
            </p>
          </div>
        ) : (
          <ReminderGroups reminders={visible} />
        )}
      </div>
    </div>
  );
}
