import type { Task, TeamMember } from '@/lib/types';
import { parseDateOnly } from '@/lib/date-utils';
import { toast } from '@/components/ui/Toast';

/**
 * A task as text, for pasting somewhere else: an AI chat that needs the
 * context, a message to a teammate, or Ashley ("add a reminder to this").
 * Markdown, because chat tools render it and it still reads as plain text.
 */

export const TASK_STATUS_LABELS: Record<Task['status'], string> = {
  todo: 'To Do',
  in_progress: 'In Progress',
  in_review: 'In Review',
  done: 'Done',
};

const PRIORITY_LABELS: Record<Task['priority'], string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  urgent: 'Urgent',
};

/** The task's own address in the app: the project page with the task open. */
export function taskUrl(task: Pick<Task, 'id' | 'project_id'>): string {
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  return `${origin}/projects/${task.project_id}?task=${task.id}`;
}

interface TaskTextContext {
  projectName?: string | null;
  team: Pick<TeamMember, 'id' | 'name'>[];
  /** Every task the app has loaded, to name what this one is waiting on. */
  tasks: Pick<Task, 'id' | 'title' | 'status'>[];
}

function day(date: string): string {
  return parseDateOnly(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function taskAsText(task: Task, { projectName, team, tasks }: TaskTextContext): string {
  const nameOf = (id: string) => team.find(m => m.id === id)?.name ?? 'Someone';
  const lines: string[] = [`# ${task.title}`, ''];

  const facts = [
    projectName ? `Project: ${projectName}` : null,
    `Status: ${TASK_STATUS_LABELS[task.status]}`,
    `Priority: ${PRIORITY_LABELS[task.priority]}`,
    task.due_date ? `Due: ${day(task.due_date)}` : null,
  ].filter(Boolean);
  lines.push(facts.join(' | '));
  if (task.assignee_ids.length) lines.push(`Assigned to: ${task.assignee_ids.map(nameOf).join(', ')}`);
  if (task.tags.length) lines.push(`Tags: ${task.tags.join(', ')}`);
  lines.push(`Task ID: ${task.id}`, `Link: ${taskUrl(task)}`);

  if (task.description.trim()) lines.push('', '## Description', '', task.description.trim());

  if (task.subtasks.length) {
    const done = task.subtasks.filter(s => s.completed).length;
    lines.push('', `## Subtasks (${done} of ${task.subtasks.length} done)`, '');
    for (const s of task.subtasks) lines.push(`- [${s.completed ? 'x' : ' '}] ${s.title}`);
  }

  if (task.acceptance_criteria.length) {
    lines.push('', '## Acceptance criteria', '');
    for (const c of task.acceptance_criteria) lines.push(`- [${c.satisfied ? 'x' : ' '}] ${c.criterion}`);
  }

  const blockers = (task.blocked_by_ids || [])
    .map(id => tasks.find(t => t.id === id))
    .filter((t): t is Pick<Task, 'id' | 'title' | 'status'> => !!t);
  if (blockers.length) {
    lines.push('', '## Waiting on', '');
    for (const b of blockers) lines.push(`- ${b.title} (${TASK_STATUS_LABELS[b.status]})`);
  }

  if (task.comments.length) {
    lines.push('', `## Comments (${task.comments.length})`, '');
    for (const c of task.comments) {
      const when = new Date(c.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      lines.push(`- ${nameOf(c.user_id)}, ${when}: ${c.text.trim()}`);
    }
  }

  return lines.join('\n');
}

/** Copies, then confirms with a toast (or says why it could not). */
export async function copyText(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast('success', `${what} copied`);
  } catch {
    toast('error', `Could not copy the ${what.toLowerCase()}`);
  }
}
