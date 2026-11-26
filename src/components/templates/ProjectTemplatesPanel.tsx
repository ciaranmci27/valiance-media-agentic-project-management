'use client';

import { useState } from 'react';
import Link from 'next/link';
import { LayoutTemplate, Plus, RefreshCw } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { hasPermission } from '@/lib/access-control';
import { useRead } from '@/lib/query-cache';
import { taskTemplatesRead } from '@/lib/reads';
import { canWriteTemplateIn } from '@/lib/template-ui';
import { Button } from '@/components/ui/Button';
import { TaskPanelShell } from '@/components/tasks/TaskPanelShell';
import { PanelHeader } from '@/components/ui/PanelHeader';
import { TemplatePanel } from './TemplatePanel';
import { UseTemplatePanel } from './UseTemplatePanel';
import { TemplateRow, useTemplateRowActions } from './TemplateLibrary';
import { SchedulePanel } from '@/components/schedules/SchedulePanel';

type View = { kind: 'list' } | { kind: 'edit'; id: string | null } | { kind: 'use'; id: string } | { kind: 'schedule'; id: string };

/**
 * A project's own templates, in the side panel (from "Manage templates" at
 * the foot of its template picker): each with Use, Edit, Duplicate, Move and
 * Trash, and New template for whoever may write templates here. Editing or
 * using one takes the panel over; closing it comes back to the list.
 * Company-wide templates are kept in Settings > Templates.
 */
export function ProjectTemplatesPanel({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const { getProject } = useApp();
  const { access } = useAuth();
  const { isDemoMode } = useDemo();
  const project = getProject(projectId);
  const [view, setView] = useState<View>({ kind: 'list' });
  const list = useRead(taskTemplatesRead(isDemoMode, projectId));
  const rows = (list.data ?? []).filter((t) => t.project_id === projectId);
  const companyCount = (list.data ?? []).filter((t) => !t.project_id).length;
  // The demo opens the editor to try, with saving off.
  const canWrite = isDemoMode || canWriteTemplateIn(access, projectId);
  const canRun = hasPermission(access, 'tasks.create');
  const { actionsFor, dialogs } = useTemplateRowActions({
    onEdit: (t) => setView({ kind: 'edit', id: t.id }),
    onUse: (t) => setView({ kind: 'use', id: t.id }),
    onSchedule: (t) => setView({ kind: 'schedule', id: t.id }),
  });

  if (view.kind === 'edit') {
    return (
      <TemplatePanel
        templateId={view.id}
        projectId={projectId}
        onClose={() => setView({ kind: 'list' })}
        onUse={canRun ? (id) => setView({ kind: 'use', id }) : undefined}
        onSchedule={canRun ? (id) => setView({ kind: 'schedule', id }) : undefined}
      />
    );
  }
  if (view.kind === 'schedule') {
    return <SchedulePanel templateId={view.id} onClose={() => setView({ kind: 'list' })} />;
  }
  if (view.kind === 'use') {
    return <UseTemplatePanel templateId={view.id} projectId={projectId} onClose={() => setView({ kind: 'list' })} onDone={() => onClose()} />;
  }

  return (
    <TaskPanelShell
      labelledBy="project-templates-title"
      onClose={onClose}
      header={<PanelHeader id="project-templates-title" title="This project's templates" detail={project?.name} onClose={onClose} />}
      footer={canWrite ? (
        <div className="flex items-center justify-between gap-3 border-t border-white/[0.06] px-5 py-3">
          <p className="truncate text-xs text-zinc-400">{rows.length} {rows.length === 1 ? 'template' : 'templates'}</p>
          <Button size="sm" icon={<Plus size={14} aria-hidden="true" />} onClick={() => setView({ kind: 'edit', id: null })}>New template</Button>
        </div>
      ) : undefined}
      after={dialogs}
    >
      <div className="space-y-4 px-5 pb-6">
        <p className="text-sm text-zinc-400">Playbooks that show only here and always create in this project. Use one from the Tasks toolbar.</p>
        {list.failed && !list.data ? (
          <div role="alert" className="flex flex-col items-center gap-3 rounded-lg bg-white/[0.03] px-4 py-8 text-center">
            <p className="text-sm text-zinc-300">Could not load the templates.</p>
            <Button variant="secondary" size="sm" icon={<RefreshCw size={13} aria-hidden="true" />} onClick={list.reload}>Try again</Button>
          </div>
        ) : !list.data ? (
          <p role="status" className="py-8 text-center text-sm text-zinc-400">Loading templates</p>
        ) : rows.length === 0 ? (
          <div className="rounded-lg bg-white/[0.03] px-4 py-8 text-center">
            <LayoutTemplate className="mx-auto mb-2 text-zinc-500" size={24} aria-hidden="true" />
            <p className="text-sm font-medium text-zinc-200">No templates for this project yet</p>
            <p className="mx-auto mt-1 max-w-xs text-xs text-zinc-400">
              {canWrite ? 'Set up work this project repeats (a sprint review, a print run) once, then make it in one click.' : 'Whoever manages this project can set them up.'}
            </p>
            {canWrite && <Button className="mt-4" size="sm" variant="secondary" icon={<Plus size={14} aria-hidden="true" />} onClick={() => setView({ kind: 'edit', id: null })}>New template</Button>}
          </div>
        ) : (
          <ul className="divide-y divide-white/[0.06] rounded-lg border border-white/[0.06]">
            {rows.map((template) => (
              <TemplateRow key={template.id} template={template} showScope={false} onOpen={() => setView({ kind: 'edit', id: template.id })} actions={actionsFor(template)} />
            ))}
          </ul>
        )}
        {companyCount > 0 && (
          <p className="text-xs text-zinc-400">
            {companyCount} company-wide {companyCount === 1 ? 'template works' : 'templates work'} here too, kept in{' '}
            <Link href={`/settings/templates?project=${encodeURIComponent(projectId)}`} className="text-brand-300 underline-offset-2 hover:text-brand-200 hover:underline">Settings, Templates</Link>.
          </p>
        )}
      </div>
    </TaskPanelShell>
  );
}
