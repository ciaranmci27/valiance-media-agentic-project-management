/**
 * Needs you now, the list behind the My Tasks badge: a subtask in review is
 * one you only wait on, so it never counts, while a parent in review, a due
 * subtask of yours and an agent subtask holding for your merge still do.
 * A question or approval whose task or project went to Trash leaves every
 * Needs you list and count (the hub, an agent's own list, the badges) and
 * comes back with it. Pure logic; nothing touches a database.
 *
 *   npm run -s test:needs-you
 */
import { computeNeedsYou } from '@/lib/autonomy';
import { buildAgentNeedsYou, needsForAgent } from '@/lib/agents-tab';
import type { QuestionView } from '@/lib/questions';
import type { Project, Task, TeamMember } from '@/lib/types';

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

// --- Trash: a question or approval goes with its task or project ---------------------
const AGENT = 'member-agent';
const OTHER = { id: 'project-2', name: 'Shop' } as Project;
const team = [{ id: ME, role: 'owner' }, { id: MATE, role: 'member' }, { id: AGENT, role: 'agent' }] as Pick<TeamMember, 'id' | 'role'>[];
function question(id: string, fields: Partial<QuestionView> = {}): QuestionView {
  return {
    id, project_id: null, project_name: null, task_id: null, task_title: null,
    asked_by: AGENT, asked_by_name: 'Nova', asked_to: ME, asked_to_name: 'Owner',
    question: id, choices: null, allow_other: true, status: 'open',
    answer_choice: null, answer_text: null, answered_by: null, answered_by_name: null, answered_at: null,
    cancelled_by: null, cancelled_at: null, expires_at: null,
    created_at: '2026-11-20T00:00:00Z', updated_at: '2026-11-20T00:00:00Z',
    can_answer: true, can_cancel: false,
    ...fields,
  } as QuestionView;
}
const questions = [
  question('on-nothing'),
  question('on-live-task', { project_id: PROJECT.id, project_name: 'Site', task_id: 'logo', task_title: 'logo' }),
  question('on-trashed-task', { project_id: PROJECT.id, project_name: 'Site', task_id: 'gone-task', task_title: 'Old task' }),
  question('approval-in-trashed-project', { kind: 'approval', project_id: OTHER.id, project_name: 'Shop' }),
  question('task-in-trashed-project', { project_id: OTHER.id, project_name: 'Shop', task_id: 'shop-task', task_title: 'Shop task' }),
  // Asked to you on a project you cannot open: no name, so the screen cannot tell; the server leaves it out once it is in Trash.
  question('on-place-you-cannot-open', { project_id: 'project-closed', task_id: 'closed-task' }),
];
const live = (taskList: Task[], projectList: Project[], placesLoaded = true) => computeNeedsYou({
  tasks: taskList, suggestions: [], projects: projectList, teamMemberId: ME, includeSuggestions: false, oversight: true,
  questions, placesLoaded,
});
const questionIds = (list: ReturnType<typeof computeNeedsYou>) => list.flatMap(item => (item.openQuestion ? [item.openQuestion.id] : []));

// 'gone-task' is in Trash (not in the live tasks); project-2 is in Trash (not in the live projects).
const trashedOut = live(tasks, [PROJECT]);
const shown = questionIds(trashedOut);
check('a question on a task in Trash leaves Needs you', !shown.includes('on-trashed-task'), shown);
check('an approval on a project in Trash leaves Needs you', !shown.includes('approval-in-trashed-project'), shown);
check('a question on a task in a project in Trash leaves Needs you', !shown.includes('task-in-trashed-project'), shown);
check('questions on live places and on nothing stay', shown.includes('on-live-task') && shown.includes('on-nothing'), shown);
check('a question on a place the viewer cannot open stays (the server judges it)', shown.includes('on-place-you-cannot-open'), shown);

const agentNeeds = buildAgentNeedsYou({ needsYou: trashedOut, tasks, team, suggestions: [], projects: [PROJECT] });
const novaNeeds = needsForAgent(agentNeeds, AGENT);
check("the hub and the agent's own Needs you count the same, without what is in Trash",
  agentNeeds.questions.length === 3 && novaNeeds.questions.length === 3 && novaNeeds.total === 3,
  { hub: agentNeeds.questions.map(q => q.id), agent: novaNeeds.questions.map(q => q.id) });

// Restored: the task and the project are back in the live lists, and so are their questions.
const restored = questionIds(live([...tasks, task('gone-task'), task('shop-task', { project_id: OTHER.id })], [PROJECT, OTHER]));
check('restored from Trash, they show again', ['on-trashed-task', 'approval-in-trashed-project', 'task-in-trashed-project'].every(id => restored.includes(id)), restored);

// Before the workspace's tasks and projects have loaded, nothing is judged missing.
const loading = questionIds(live([], [], false));
check('while tasks and projects load, no question is hidden', loading.length === questions.length, loading);

if (failures.length) {
  console.error(`needs-you: ${failures.length} failed, ${passed} passed`);
  for (const failure of failures) console.error(`  x ${failure}`);
  process.exit(1);
}
console.log(`needs-you: all ${passed} checks passed`);
