'use client';

import { CalendarClock, CalendarDays, CornerDownRight, Link2, Sparkles } from 'lucide-react';
import { parseDateOnly } from '@/lib/date-utils';
import { appLocale } from '@/lib/region';
import type { TemplateDateWarning, TemplatePastDue } from '@/lib/task-templates';
import type { TemplateRunPreview } from '@/lib/template-ui';
import { PRIORITY_OPTIONS } from '@/components/tasks/TaskFields';

export const shortDate = (value: string) => parseDateOnly(value).toLocaleDateString(appLocale(), { weekday: 'short', month: 'short', day: 'numeric' });

type PreviewTask = TemplateRunPreview['tasks'][number] & { change?: 'added' | null };
type PreviewSubtask = TemplateRunPreview['tasks'][number]['subtasks'][number];

/** A planned task or subtask is past due when its key or title is in past_due. */
const pastKey = (task: { key?: string | null; title: string }) => task.key ?? `title:${task.title}`;

/**
 * The exact dated, assigned task list a run makes: each task with its due
 * date, assignee (and the role it came from), priority and tags, what it
 * waits on, and its subtasks under it. A step a draft adds is marked
 * "Added by <agent>"; a date before today reads amber. The run stepper's
 * preview and a draft's review show the same list.
 */
export function RunPreviewList({ tasks, roles, pastDue = [], addedBy, dimmed = false }: {
  tasks: readonly PreviewTask[];
  roles: TemplateRunPreview['roles'];
  pastDue?: readonly TemplatePastDue[];
  /** Who added the steps marked added (a draft's proposer). */
  addedBy?: string | null;
  /** The list is being worked out again: shown faded. */
  dimmed?: boolean;
}) {
  const past = new Set(pastDue.map(pastKey));
  return (
    <ol className={`space-y-1.5 transition-opacity ${dimmed ? 'opacity-60' : ''}`}>
      {tasks.map((task) => {
        const added = task.change === 'added';
        return (
          <li key={task.key ?? task.title} className={`rounded-lg px-3 py-2 ${added ? 'bg-brand-500/[0.08] ring-1 ring-inset ring-brand-500/25' : 'bg-white/[0.03]'}`}>
            {added && (
              <p className="mb-1 inline-flex items-center gap-1 text-[11px] font-medium text-brand-200">
                <Sparkles size={11} aria-hidden="true" />Added by {addedBy || 'an agent'}
              </p>
            )}
            <PlannedRow task={task} roles={roles} past={past.has(pastKey(task))} />
            {task.depends_on.length > 0 && (
              <p className="mt-1 flex items-start gap-1.5 text-[11px] text-zinc-400">
                <Link2 size={11} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
                Waits on {task.depends_on.map((key) => tasks.find((x) => x.key === key)?.title ?? key).join(', ')}
              </p>
            )}
            {task.subtasks.length > 0 && (
              <ul className="mt-1.5 space-y-1 border-t border-white/[0.06] pt-1.5">
                {task.subtasks.map((subtask) => (
                  <li key={subtask.key ?? subtask.title} className="flex items-start gap-1.5 pl-1">
                    <CornerDownRight size={13} className="mt-0.5 flex-shrink-0 text-zinc-500" aria-hidden="true" />
                    <PlannedRow task={subtask} roles={roles} small past={past.has(pastKey(subtask))} />
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function PlannedRow({ task, roles, small = false, past = false }: { task: PreviewSubtask; roles: TemplateRunPreview['roles']; small?: boolean; past?: boolean }) {
  const priority = PRIORITY_OPTIONS.find((option) => option.value === task.priority);
  const role = task.role ? roles.find((r) => r.key === task.role) : null;
  return (
    <div className="min-w-0 flex-1">
      <p className={`break-words text-zinc-100 ${small ? 'text-[13px]' : 'text-sm font-medium'}`}>{task.title}</p>
      <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-zinc-400">
        <span className={`inline-flex items-center gap-1 ${past ? 'text-amber-300' : ''}`}>
          <CalendarDays size={11} aria-hidden="true" />
          {task.due_date ? `Due ${shortDate(task.due_date)}${past ? ', before today' : ''}` : 'No due date'}
        </span>
        <span className={task.assignee_name ? 'text-zinc-300' : undefined}>
          {task.assignee_name ?? 'Unassigned'}{role ? ` (${role.label})` : ''}
        </span>
        {priority && task.priority !== 'medium' && (
          <span className="inline-flex items-center gap-1"><span className={`h-1.5 w-1.5 rounded-full ${priority.color}`} aria-hidden="true" />{priority.label}</span>
        )}
        {task.tags.length > 0 && <span>{task.tags.join(', ')}</span>}
      </p>
    </div>
  );
}

/** One note per planned task due before today, so nobody creates overdue work without seeing it. */
/**
 * Dates in a run that do not add up (key dates out of order, a task due
 * before what it waits on), said plainly before anyone creates it: the same
 * amber note as past due dates, one line each.
 */
export function DateWarnings({ items }: { items: readonly TemplateDateWarning[] }) {
  if (!items.length) return null;
  const order = items.some((item) => item.code === 'key_dates_out_of_order');
  const late = items.filter((item) => item.code === 'due_before_dependency').length;
  const title = order && late ? 'These dates do not add up'
    : order ? 'Key dates are out of order'
      : late === 1 ? '1 task is due before what it waits on' : `${late} tasks are due before what they wait on`;
  return (
    <div role="status" className="rounded-lg bg-amber-500/[0.1] px-3 py-2.5 text-xs text-amber-300">
      <p className="flex items-center gap-1.5 font-medium">
        <CalendarClock size={13} aria-hidden="true" />
        {title}
      </p>
      <ul className="mt-1 space-y-0.5 pl-[19px]">
        {items.map((item) => <li key={`${item.code}:${item.keys.join('>')}`} className="break-words">{item.message}.</li>)}
      </ul>
      <p className="mt-1 pl-[19px]">You can still create it; change the dates if this is not what you meant.</p>
    </div>
  );
}

export function PastDueNotes({ items }: { items: readonly TemplatePastDue[] }) {
  if (!items.length) return null;
  return (
    <div className="rounded-lg bg-amber-500/[0.1] px-3 py-2.5 text-xs text-amber-300">
      <p className="flex items-center gap-1.5 font-medium">
        <CalendarClock size={13} aria-hidden="true" />
        {items.length === 1 ? '1 task is due before today' : `${items.length} tasks are due before today`}
      </p>
      <ul className="mt-1 space-y-0.5 pl-[19px]">
        {items.map((item) => (
          <li key={pastKey(item)} className="break-words">
            {item.title}: due {shortDate(item.due_date)}
          </li>
        ))}
      </ul>
    </div>
  );
}
