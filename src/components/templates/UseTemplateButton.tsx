'use client';

import { useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { LayoutTemplate, Search, Settings2 } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { hasPermission } from '@/lib/access-control';
import { useRead, warmRead } from '@/lib/query-cache';
import { taskTemplateRead, taskTemplatesRead, useIntent } from '@/lib/reads';
import { templateSizeLabel, type TaskTemplateRunResult, type TaskTemplateSummary } from '@/lib/task-templates';
import { canWriteSomeTemplate } from '@/lib/template-ui';
import type { Task } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Popover } from '@/components/ui/Popover';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { MENU, MENU_ITEM } from '@/components/tasks/TaskFields';
import { UseTemplatePanel } from './UseTemplatePanel';

/** Whether the signed-in person may use templates: they create tasks. */
export function useCanUseTemplates(): boolean {
  const { access } = useAuth();
  return hasPermission(access, 'tasks.create');
}

/**
 * The templates usable in a project (or anywhere), as a list that opens
 * under its trigger: in a project, its own templates first, then the
 * company-wide ones, each with what it makes and what it asks for; searched
 * once there are more than six. "Manage templates" sits at the foot (the
 * project's Templates panel, or Settings > Templates). Picking one hands its
 * id back; pointing at one reads it ahead, so its run opens ready.
 */
export function TemplatePicker({ projectId, trigger, onPick, onManage }: {
  projectId?: string | null;
  /** The button that opens it, given whether it is open and how to toggle it. */
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  onPick: (template: TaskTemplateSummary) => void;
  /** Opens where this project's templates are managed; left out, the foot links to Settings > Templates. */
  onManage?: () => void;
}) {
  const { access } = useAuth();
  const { isDemoMode } = useDemo();
  const anchor = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const list = useRead(open ? taskTemplatesRead(isDemoMode, projectId ?? null) : null);
  const intent = useIntent();
  const canWrite = canWriteSomeTemplate(access);
  const rows = list.data ?? [];
  const needle = query.trim().toLowerCase();
  const shown = needle ? rows.filter((t) => t.name.toLowerCase().includes(needle)) : rows;
  const own = projectId ? shown.filter((t) => t.project_id === projectId) : [];
  const company = projectId ? shown.filter((t) => !t.project_id) : shown;
  const manageHref = projectId ? `/settings/templates?project=${encodeURIComponent(projectId)}` : '/settings/templates';

  const option = (template: TaskTemplateSummary) => (
    <button
      key={template.id}
      type="button"
      role="option"
      aria-selected={false}
      onClick={() => { setOpen(false); onPick(template); }}
      {...intent(() => void warmRead(taskTemplateRead(template.id, isDemoMode)))}
      className={`${MENU_ITEM} text-zinc-200`}
    >
      <LayoutTemplate size={15} className="flex-shrink-0 text-brand-300" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{template.name}</span>
        <span className="block truncate text-xs text-zinc-400">{templateSizeLabel(template)}{template.fields.length ? `, asks for ${template.fields.map((f) => f.label).join(', ')}` : ''}</span>
      </span>
    </button>
  );
  const group = (label: string, items: TaskTemplateSummary[]) => (items.length ? (
    <div role="group" aria-label={label}>
      <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">{label}</p>
      {items.map(option)}
    </div>
  ) : null);
  const manageClass = 'flex w-full items-center gap-2 px-3 py-2 text-sm text-zinc-300 transition-colors hover:bg-white/[0.06] hover:text-white focus:outline-none focus-visible:bg-white/[0.06]';

  return (
    <div ref={anchor} className="inline-flex">
      {trigger({ open, toggle: () => { setOpen((v) => !v); setQuery(''); } })}
      <Popover anchorRef={anchor} open={open} onClose={() => setOpen(false)} align="start" width={320} className={MENU}>
        {rows.length > 6 && (
          <div className="px-2 pb-1 pt-1">
            <TextInput size="sm" value={query} onChange={setQuery} placeholder="Search templates" leftIcon={Search} autoFocus aria-label="Search templates" />
          </div>
        )}
        <div role="listbox" aria-label="Templates" className="max-h-80 overflow-y-auto">
          {list.loading && <p role="status" className="px-3 py-2 text-sm text-zinc-400">Loading templates</p>}
          {list.failed && <p role="alert" className="px-3 py-2 text-sm text-red-300">Could not load templates.</p>}
          {!list.loading && !list.failed && rows.length === 0 && (
            <div className="px-3 py-3 text-sm">
              <p className="font-medium text-zinc-200">No templates yet</p>
              <p className="mt-0.5 text-xs leading-relaxed text-zinc-400">
                A template makes the same tasks every time, with due dates that fall into place.
                {canWrite ? ' Set one up under Manage templates.' : ' Ask whoever manages this project to set one up.'}
              </p>
            </div>
          )}
          {rows.length > 0 && shown.length === 0 && <p className="px-3 py-2 text-sm text-zinc-400">Nothing matches.</p>}
          {projectId ? <>{group('This project', own)}{group('Company-wide', company)}</> : company.map(option)}
        </div>
        <div className="mt-1 border-t border-white/[0.06] pt-1">
          {onManage ? (
            <button type="button" onClick={() => { setOpen(false); onManage(); }} className={manageClass}>
              <Settings2 size={14} className="flex-shrink-0 text-zinc-400" aria-hidden="true" />Manage templates
            </button>
          ) : (
            <Link href={manageHref} onClick={() => setOpen(false)} className={manageClass}>
              <Settings2 size={14} className="flex-shrink-0 text-zinc-400" aria-hidden="true" />Manage templates
            </Link>
          )}
        </div>
      </Popover>
    </div>
  );
}

/**
 * "From a template": a button that lists the templates usable in a project
 * and opens the chosen one's Use panel. Drop it on any page that makes
 * tasks (a project's Tasks tab, its header). Renders nothing for someone
 * who cannot create tasks.
 */
export function UseTemplateButton({ projectId, label = 'From a template', variant = 'secondary', size = 'sm', onDone }: {
  projectId?: string | null;
  label?: string;
  variant?: 'primary' | 'secondary' | 'ghost';
  size?: 'sm' | 'md';
  /** After the tasks exist (the panel has closed and said what it made). */
  onDone?: (result: TaskTemplateRunResult<Task>) => void;
}) {
  const canUse = useCanUseTemplates();
  const [using, setUsing] = useState<string | null>(null);
  if (!canUse) return null;
  return (
    <>
      <TemplatePicker
        projectId={projectId}
        onPick={(template) => setUsing(template.id)}
        trigger={({ open, toggle }) => (
          <Button variant={variant} size={size} icon={<LayoutTemplate size={14} aria-hidden="true" />} onClick={toggle} aria-expanded={open} aria-haspopup="listbox">
            {label}
          </Button>
        )}
      />
      {using && (
        <UseTemplatePanel
          templateId={using}
          projectId={projectId}
          onClose={() => setUsing(null)}
          onDone={(result) => { setUsing(null); onDone?.(result); }}
        />
      )}
    </>
  );
}
