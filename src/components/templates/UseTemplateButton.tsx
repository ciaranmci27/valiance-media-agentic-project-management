'use client';

import { useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { LayoutTemplate, Lock, Search } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { hasPermission } from '@/lib/access-control';
import { useRead, warmRead } from '@/lib/query-cache';
import { taskTemplateRead, taskTemplatesRead, useIntent } from '@/lib/reads';
import { templateSizeLabel, type TaskTemplateRunResult, type TaskTemplateSummary } from '@/lib/task-templates';
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
 * under its trigger: searched once there are more than six, each with what
 * it makes and whether it is locked to this project. Picking one hands its
 * id back; pointing at one reads it ahead, so its panel opens ready.
 */
export function TemplatePicker({ projectId, trigger, onPick }: {
  projectId?: string | null;
  /** The button that opens it, given whether it is open and how to toggle it. */
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  onPick: (template: TaskTemplateSummary) => void;
}) {
  const { access } = useAuth();
  const { isDemoMode } = useDemo();
  const anchor = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const list = useRead(open ? taskTemplatesRead(isDemoMode, projectId ?? null) : null);
  const intent = useIntent();
  const canManage = !isDemoMode && hasPermission(access, 'templates.manage');
  const rows = list.data ?? [];
  const needle = query.trim().toLowerCase();
  const shown = needle ? rows.filter((t) => t.name.toLowerCase().includes(needle)) : rows;

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
              <p className="text-zinc-300">No templates yet.</p>
              <p className="mt-0.5 text-xs text-zinc-400">
                {canManage ? <>Set up repeat work once in <Link href="/templates" className="text-brand-300 hover:text-brand-200 underline-offset-2 hover:underline">Templates</Link>.</> : 'An Owner or Admin can set them up in Templates.'}
              </p>
            </div>
          )}
          {rows.length > 0 && shown.length === 0 && <p className="px-3 py-2 text-sm text-zinc-400">Nothing matches.</p>}
          {shown.map((template) => (
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
              {template.project_id && <Lock size={13} className="flex-shrink-0 text-zinc-500" aria-label="Only in this project" />}
            </button>
          ))}
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
