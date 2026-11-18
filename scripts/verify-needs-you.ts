/**
 * Needs you now, the list behind the My Tasks badge: a subtask in review is
 * one you only wait on, so it never counts, while a parent in review, a due
 * subtask of yours and an agent subtask holding for your merge still do.
 * Pure logic; nothing touches a database.
 *
 *   npm run -s test:needs-you
 */
import { computeNeedsYou } from '@/lib/autonomy';
import type { Project, Task } from '@/lib/types';

const ME = 'member-owner';
const MATE = 'member-mate';
const PROJECT = { id: 'project-1', name: 'Site' } as Project;

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`);
}

function task(id: string, fields: Partial<Task> = {}): Task {
  return {
    id,
    project_id: PROJECT.id,
    title: id,
    description: '',
    status: 'todo',
    priority: 'medium',
    assignee_ids: [ME],
    due_date: null,
    tags: [],
    comments: [],
    acceptance_criteria: [],
    blocked_by_ids: [],
    parent_task_id: null,
    created_at: '2026-11-01T00:00:00Z',
    updated_at: '2026-11-01T00:00:00Z',
    ...fields,
  };
}

const tasks: Task[] = [
  task('dashboard'),
  // Aleisha finished her piece and put it in review: you only wait on it.
  task('dashboard-chart', { parent_task_id: 'dashboard', status: 'in_review', assignee_ids: [ME, MATE] }),
  // A whole task of yours in review is still yours to review.
  task('logo', { status: 'in_review' }),
  // Your own subtask, due today and unstarted, is still a thing to do.
  task('dashboard-copy', { parent_task_id: 'dashboard', due_date: '2020-01-01' }),
  // An agent-built subtask holding for your merge is still one click for you.
  task('dashboard-api', { parent_task_id: 'dashboard', status: 'in_review', ai_readiness: 'ai_ready' }),
];

const items = computeNeedsYou({
  tasks,
  suggestions: [],
  projects: [PROJECT],
  teamMemberId: ME,
  includeSuggestions: false,
  oversight: true,
});
const kinds = items.map(item => `${item.kind}:${item.task?.id}`);

check('a subtask in review never counts as a thing to do', !kinds.some(k => k.endsWith(':dashboard-chart')), kinds);
check('a whole task in review still waits on your review', kinds.includes('review:logo'), kinds);
check('your due subtask still needs you', kinds.includes('due:dashboard-copy'), kinds);
check('an agent subtask holding for your merge still needs you', kinds.includes('merge:dashboard-api'), kinds);
check('the badge counts exactly those three', items.length === 3, kinds);

if (failures.length) {
  console.error(`needs-you: ${failures.length} failed, ${passed} passed`);
  for (const failure of failures) console.error(`  x ${failure}`);
  process.exit(1);
}
console.log(`needs-you: all ${passed} checks passed`);
