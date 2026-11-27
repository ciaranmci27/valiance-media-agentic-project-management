'use client';

import { useUndoTrash } from '@/components/projects/useUndoTrash';
import { useState, type ReactNode } from 'react';
import { ArrowRightLeft, CalendarClock, Copy, Edit, Eye, FolderKanban, Globe, LayoutTemplate, Play, Repeat, Trash2 } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { hasPermission } from '@/lib/access-control';
import { invalidateTables, warmRead } from '@/lib/query-cache';
import { taskTemplateRead, TEMPLATE_TABLES, useIntent } from '@/lib/reads';
import { workspaceApi } from '@/lib/agent-workspace';
import { timeAgo } from '@/lib/task-times';
import {
  TEMPLATE_NAME_MAX, templateSizeLabel, type TaskTemplateSummary, type TaskTemplateView,
} from '@/lib/task-templates';
import { canEditTemplate, canWriteTemplateIn, keyDatesSummary, rolesSummary } from '@/lib/template-ui';
import Modal from '@/components/ui/Modal';
import { RowActionsMenu, type RowAction } from '@/components/ui/RowActionsMenu';
import { Select } from '@/components/ui/inputs/Select';
import { toast } from '@/components/ui/Toast';

/**
 * The template library's shared pieces: one row per template (what it
 * makes, where it lives, its key dates and roles, when it last ran) with
 * the same actions everywhere it is listed (Settings > Templates and a
 * project's Templates panel): Edit, Use, Duplicate, Move to company-wide or
 * to a project, and Move to Trash.
 */

const errorText = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);

/** "Company-wide" or the project's name, as a quiet chip. */
export function ScopeChip({ template }: { template: Pick<TaskTemplateSummary, 'project_id' | 'project_name'> }) {
  const Icon = template.project_id ? FolderKanban : Globe;
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full bg-white/[0.04] px-2 py-0.5 text-[11px] text-zinc-300">
      <Icon size={11} className="flex-shrink-0 text-zinc-400" aria-hidden="true" />
      <span className="truncate">{template.project_id ? template.project_name ?? 'One project' : 'Company-wide'}</span>
    </span>
  );
}

/** "Repeats" beside a template that runs on a schedule, in the scope chip's style. */
export function RepeatsChip({ label }: { label?: string }) {
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full bg-brand-500/[0.12] px-2 py-0.5 text-[11px] text-brand-200">
      <Repeat size={11} className="flex-shrink-0" aria-hidden="true" />
      <span className="truncate">{label ?? 'Repeats'}</span>
    </span>
  );
}

/** "Last run 3 days ago, 4 runs", or "Never run". */
export function lastRunLabel(template: Pick<TaskTemplateSummary, 'last_run_at' | 'run_count'>): string {
  if (!template.last_run_at) return 'Never run';
  return `Last run ${timeAgo(template.last_run_at)}, ${template.run_count} ${template.run_count === 1 ? 'run' : 'runs'}`;
}

/**
 * The row actions and their dialogs: Duplicate (a copy in the same place),
 * Move (company-wide, or to a project you may write in) and Move to Trash
 * (asks first: it leaves the library for everyone). Each refreshes every
 * template list. The demo reads templates only, so it offers none.
 */
export function useTemplateRowActions({ onEdit, onUse, onSchedule }: {
  onEdit: (template: TaskTemplateSummary) => void;
  onUse?: (template: TaskTemplateSummary) => void;
  /** Run it on a schedule (opens the schedule panel). */
  onSchedule?: (template: TaskTemplateSummary) => void;
}) {
  const { access } = useAuth();
  const { isDemoMode } = useDemo();
  const [moving, setMoving] = useState<TaskTemplateSummary | null>(null);
  const undoTrash = useUndoTrash();
  const canRun = hasPermission(access, 'tasks.create');

  const duplicate = async (template: TaskTemplateSummary) => {
    try {
      const full = await workspaceApi<TaskTemplateView>(`/api/workspace/task-templates/${encodeURIComponent(template.id)}`);
      const copy = await workspaceApi<TaskTemplateView>('/api/workspace/task-templates', {
        method: 'POST',
        body: {
          name: `Copy of ${full.name}`.slice(0, TEMPLATE_NAME_MAX),
          description: full.description,
          project_id: full.project_id,
          guidance: full.guidance ?? '',
          key_dates: full.key_dates,
          roles: full.roles,
          fields: full.fields,
          items: full.items,
        },
      });
      invalidateTables([...TEMPLATE_TABLES]);
      toast('success', `Made ${copy.name}`);
      onEdit(copy);
    } catch (error) {
      toast('error', errorText(error, 'Could not duplicate the template'));
    }
  };

  const trash = async (template: TaskTemplateSummary) => {
    try {
      await workspaceApi(`/api/workspace/task-templates/${encodeURIComponent(template.id)}`, { method: 'DELETE' });
      invalidateTables([...TEMPLATE_TABLES]);
      undoTrash('task_templates', template.id, { message: `${template.name} moved to Trash`, onRestored: () => invalidateTables([...TEMPLATE_TABLES]) });
    } catch (error) {
      toast('error', errorText(error, 'Could not move it to Trash'));
    }
  };

  const actionsFor = (template: TaskTemplateSummary): RowAction[] => {
    const editable = !isDemoMode && canEditTemplate(access, template);
    const out: RowAction[] = [
      editable
        ? { label: 'Edit', icon: <Edit size={14} />, onClick: () => onEdit(template) }
        : { label: 'Open', icon: <Eye size={14} />, onClick: () => onEdit(template) },
    ];
    if (onUse && canRun) out.push({ label: template.project_id ? 'Use' : 'Use in a project', icon: <Play size={14} />, onClick: () => onUse(template) });
    if (onSchedule && canRun) out.push({ label: 'Schedule', icon: <CalendarClock size={14} />, onClick: () => onSchedule(template) });
    if (editable) {
      out.push(
        { label: 'Duplicate', icon: <Copy size={14} />, divider: true, onClick: () => void duplicate(template) },
        { label: template.project_id ? 'Move' : 'Move to a project', icon: <ArrowRightLeft size={14} />, onClick: () => setMoving(template) },
        { label: 'Move to Trash', icon: <Trash2 size={14} />, variant: 'danger', divider: true, onClick: () => void trash(template) },
      );
    }
    return out;
  };

  const dialogs = (
    <>
      {moving && <MoveTemplateDialog template={moving} onClose={() => setMoving(null)} />}
    </>
  );

  return { actionsFor, dialogs };
}

/**
 * Moves a template between company-wide and a project: company-wide needs
 * Manage templates; a project is one you may write templates in. The runs it
 * made and their tasks stay where they are.
 */
export function MoveTemplateDialog({ template, onClose }: { template: TaskTemplateSummary; onClose: () => void }) {
  const { projects } = useApp();
  const { access } = useAuth();
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = [
    ...(template.project_id && canWriteTemplateIn(access, null) ? [{ value: 'workspace', label: 'Company-wide', detail: 'Usable in any project' }] : []),
    ...projects
      .filter((p) => p.status !== 'archived' && p.id !== template.project_id && canWriteTemplateIn(access, p.id))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => ({ value: p.id, label: p.name, group: 'Projects' })),
  ];
  const move = async () => {
    if (!target || busy) return;
    setBusy(true);
    setError(null);
    const projectId = target === 'workspace' ? null : target;
    try {
      await workspaceApi(`/api/workspace/task-templates/${encodeURIComponent(template.id)}`, { method: 'PATCH', body: { project_id: projectId } });
      invalidateTables([...TEMPLATE_TABLES]);
      toast('success', projectId ? `${template.name} now lives in ${projects.find((p) => p.id === projectId)?.name ?? 'the project'}` : `${template.name} is company-wide`);
      onClose();
    } catch (err) {
      setError(errorText(err, 'Could not move the template'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal isOpen onClose={onClose} title="Move template" size="sm" primaryAction={{ label: 'Move template', onClick: () => void move(), disabled: !target, busy }}>
      <div className="space-y-4">
        <p className="text-sm text-zinc-400">
          {template.name} is now {template.project_id ? `only in ${template.project_name ?? 'one project'}` : 'company-wide'}.
        </p>
        {options.length ? (
          <Select
            label="Move to"
            visibleLabel="Move to"
            value={target}
            onChange={setTarget}
            placeholder="Pick where it lives"
            options={options}
            searchable={options.length > 8}
            error={error ?? undefined}
          />
        ) : (
          <p role="status" className="rounded-lg bg-white/[0.04] px-3 py-2 text-sm text-zinc-300">There is nowhere else you may keep it. Moving it company-wide needs Manage templates.</p>
        )}
      </div>
    </Modal>
  );
}

/**
 * One template in a list: its name (opens it), what it is for, where it
 * lives, and a line of what it holds: tasks, key dates, roles, last run.
 * `action` sits before the row menu (a Use button, say).
 */
export function TemplateRow({ template, showScope = true, onOpen, actions, action, chip }: {
  template: TaskTemplateSummary;
  showScope?: boolean;
  onOpen: () => void;
  actions: RowAction[];
  action?: ReactNode;
  /** Beside the scope chip (RepeatsChip for a template on a schedule). */
  chip?: ReactNode;
}) {
  const { isDemoMode } = useDemo();
  const intent = useIntent();
  const roles = rolesSummary(template);
  const facts = [
    templateSizeLabel(template),
    keyDatesSummary(template),
    roles ? `Roles: ${roles}` : null,
    lastRunLabel(template),
  ].filter(Boolean) as string[];
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <span className="mt-0.5 hidden h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-brand-500/15 text-brand-300 sm:flex" aria-hidden="true">
        <LayoutTemplate size={15} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <button
            type="button"
            onClick={onOpen}
            {...intent(() => void warmRead(taskTemplateRead(template.id, isDemoMode)))}
            className="min-w-0 max-w-full truncate rounded text-left text-sm font-semibold text-white transition-colors hover:text-brand-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            {template.name}
          </button>
          {showScope && <ScopeChip template={template} />}
          {chip}
        </div>
        {template.description && <p className="mt-0.5 line-clamp-1 text-xs text-zinc-400">{template.description}</p>}
        <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-zinc-400">
          {facts.map((fact) => <span key={fact} className="min-w-0 max-w-full truncate">{fact}</span>)}
        </p>
      </div>
      <div className="flex flex-shrink-0 items-center gap-1">
        {action}
        <RowActionsMenu actions={actions} label={`Actions for ${template.name}`} />
      </div>
    </li>
  );
}
