/**
 * The Agents page's logic: which tab a URL opens, what agents are waiting on
 * the signed-in person for, how the run feed is queried and a run row reads,
 * how an agent's rules and queue read in plain words, and an approval's
 * details in full behind Show all. Pure logic; nothing touches a database.
 *
 *   npm run -s test:agents-tab
 */
import { demoRunFeedPage } from '@/lib/demo-agents-home';
import { computeNeedsYou } from '@/lib/autonomy';
import {
  agentBacklog, agentPausedNow, agentRulesInWords, agentsTabFrom, backlogLine, buildAgentNeedsYou, canSeeRunTrace, currentRunByAgent, needsForAgent,
  formatRunDuration, runDurationMs, runFeedQuery, runCursorFilter, runCursorOf, mergeRunPages, runPill, runTokens, toRunSummary, NO_RUN_FILTERS, RUN_STATUS_LABELS, RUNS_PAGE_SIZE,
} from '@/lib/agents-tab';
import { INFO_ANSWER_MARKER, pendingSuggestionsInReach, suggestionsInReach } from '@/lib/suggestion-reach';
import { AGENT_RUN_STALE_AFTER_SECONDS, RUN_FILTER_STATUSES, runDisplayStatus, type AgentRunSummary } from '@/lib/agent-runs';
import { APPROVAL_DETAIL_ROWS_MAX, APPROVAL_DETAIL_VALUE_MAX, approvalDetailRows, type QuestionView } from '@/lib/questions';
import type { Project, Task, TaskSuggestion, TeamMember } from '@/lib/types';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`);
}

const ME = '00000000-0000-4000-8000-000000000001';
const MATE = '00000000-0000-4000-8000-000000000002';
const BUILDER = '00000000-0000-4000-8000-0000000000a1';
const AUDITOR = '00000000-0000-4000-8000-0000000000a2';
const PROJECT_ID = '00000000-0000-4000-8000-0000000000b1';
const QUIET_PROJECT_ID = '00000000-0000-4000-8000-0000000000c2';
// A project the viewer cannot reach (not in their project list).
const OTHER_PROJECT_ID = '00000000-0000-4000-8000-0000000000d3';

const team = [
  { id: ME, name: 'Ciara Owner', role: 'owner' },
  { id: MATE, name: 'Aleisha Mate', role: 'member' },
  { id: BUILDER, name: 'Jeff Builder', role: 'agent' },
  { id: AUDITOR, name: 'Ashley Auditor', role: 'agent', agent_close_policy: 'review', agent_create_policy: 'approval', agent_self_assign: false, agent_escalate_to: MATE },
] as TeamMember[];
const projects = [
  { id: PROJECT_ID, name: 'Site', autonomous_enabled: true },
  // A fleet setting (autonomous_enabled) never narrows what a person reviews.
  { id: QUIET_PROJECT_ID, name: 'Inbox work', autonomous_enabled: false },
] as Project[];

function task(id: string, fields: Partial<Task> = {}): Task {
  return {
    id,
    project_id: PROJECT_ID,
    title: id,
    description: '',
    status: 'todo',
    priority: 'medium',
    assignee_ids: [],
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

function question(id: string, fields: Partial<QuestionView>): QuestionView {
  return {
    id, project_id: PROJECT_ID, project_name: 'Site', task_id: null, task_title: null,
    asked_by: BUILDER, asked_by_name: 'Jeff Builder', asked_to: ME, asked_to_name: 'Ciara Owner',
    question: 'Ship it?', choices: null, allow_other: false, status: 'open',
    answer_choice: null, answer_text: null, answered_by: null, answered_by_name: null, answered_at: null,
    cancelled_by: null, cancelled_at: null, expires_at: null,
    created_at: '2026-11-20T10:00:00Z', updated_at: '2026-11-20T10:00:00Z',
    can_answer: true, can_cancel: false,
    ...fields,
  };
}

// ── Tabs ──────────────────────────────────────────────────────────────
check('no tab opens Needs you', agentsTabFrom(null) === 'needs-you');
check('a known tab opens', agentsTabFrom('runs') === 'runs' && agentsTabFrom('analytics') === 'analytics');
check('an unknown tab opens Needs you', agentsTabFrom('reports') === 'needs-you');

// ── Needs you ─────────────────────────────────────────────────────────
{
  const tasks: Task[] = [
    // Claimed by the builder and finished into review (its close policy).
    task('claimed-review', { status: 'in_review', claimed_by: BUILDER, updated_at: '2026-11-21T09:00:00Z' }),
    // Created by the auditor (triage), assigned to a person, in review: the person's work, not the agent's.
    task('created-review', { status: 'in_review', created_by: AUDITOR, assignee_ids: [MATE], updated_at: '2026-11-22T09:00:00Z' }),
    // A human-only task, even one an agent is assigned: a person's work.
    task('human-only-review', { status: 'in_review', assignee_ids: [BUILDER], ai_readiness: 'human_only', updated_at: '2026-11-22T10:00:00Z' }),
    // A subtask in review is a piece of its parent: you only wait on it.
    task('sub-review', { status: 'in_review', claimed_by: BUILDER, parent_task_id: 'claimed-review', updated_at: '2026-11-22T11:00:00Z' }),
    // The reviewer sent it back: the agent is fixing it, nothing waits on you.
    task('sent-back', {
      status: 'in_review', claimed_by: BUILDER, updated_at: '2026-11-22T12:00:00Z',
      reviews: [{ id: 'rv1', task_id: 'sent-back', round: 2, verdict: 'changes_requested', created_at: '2026-11-22T12:00:00Z' } as never],
    }),
    // A held merge the reviewer sent back: waiting on the agent, not on your merge.
    task('merge-sent-back', {
      status: 'in_review', ai_readiness: 'ai_ready', updated_at: '2026-11-23T10:00:00Z',
      reviews: [{ id: 'rv2', task_id: 'merge-sent-back', round: 1, verdict: 'changes_requested', created_at: '2026-11-23T10:00:00Z' } as never],
    }),
    // Typed blocked event (activity_type blocked, "Blocked: ..."): shows as blocked.
    task('typed-blocked', { status: 'in_progress', claimed_by: AUDITOR, updated_at: '2026-11-21T09:00:00Z' }),
    // Blocked on a question already listed for me: counted once, as the question.
    task('asked-blocked', { status: 'in_progress', claimed_by: AUDITOR, updated_at: '2026-11-21T08:00:00Z' }),
    // Blocked on a question that is no longer open (answered): not blocked any more.
    task('answered-blocked', { status: 'in_progress', claimed_by: BUILDER, updated_at: '2026-11-21T07:00:00Z' }),
    // A person on the task first, the agent second: the block is filed under the agent.
    task('person-first-blocked', { status: 'in_progress', assignee_ids: [MATE, BUILDER], updated_at: '2026-11-21T06:00:00Z' }),
    // Assigned to the builder with no claim left: agent work in review.
    task('assigned-review', { status: 'in_review', assignee_ids: [BUILDER], updated_at: '2026-11-20T09:00:00Z' }),
    // A person's own work in review is not agent work.
    task('human-review', { status: 'in_review', assignee_ids: [MATE], created_by: MATE }),
    // An agent build holding for a merge (AI ready, no file forecast): the merge item carries over.
    task('held-merge', { status: 'in_review', ai_readiness: 'ai_ready', updated_at: '2026-11-23T09:00:00Z' }),
    // An agent stopped on a question.
    task('blocked-build', { status: 'in_progress', assignee_ids: [BUILDER], updated_at: '2026-11-19T09:00:00Z' }),
    // Done agent work never waits on anyone.
    task('done-agent', { status: 'done', claimed_by: BUILDER }),
  ];
  const questions = [
    question('older-approval', { kind: 'approval', created_at: '2026-11-18T10:00:00Z' }),
    question('newer-question', { asked_by: AUDITOR, created_at: '2026-11-22T10:00:00Z' }),
    // A person's question to me: My Tasks has it; the Agents page is for agents.
    question('from-a-person', { asked_by: MATE, asked_by_name: 'Aleisha Mate' }),
    // Asked to someone else: not mine.
    question('for-mate', { asked_to: MATE }),
  ];
  const suggestions = [
    { id: 's1', status: 'pending', project_id: PROJECT_ID },
    { id: 's2', status: 'pending', project_id: PROJECT_ID },
    // From any agent, in any project the viewer reaches: counted.
    { id: 's3', status: 'pending', project_id: QUIET_PROJECT_ID, created_at: '2026-11-20T10:00:00Z' },
    { id: 's4', status: 'approved', project_id: PROJECT_ID },
    // Outside the viewer's reach: never counted.
    { id: 's5', status: 'pending', project_id: OTHER_PROJECT_ID },
  ] as TaskSuggestion[];
  const agentActivity = [{
    activity_type: 'task_failed', reference_type: 'task', reference_id: 'blocked-build',
    title: 'BLOCKED: Which API key should I use?', description: '', created_at: '2026-11-19T09:00:00Z',
  }, {
    activity_type: 'blocked', reference_type: 'task', reference_id: 'typed-blocked',
    title: 'Blocked: Need the staging bucket', description: '', metadata: { reason: 'Need the staging bucket name' }, created_at: '2026-11-21T09:00:00Z',
  }, {
    activity_type: 'blocked', reference_type: 'task', reference_id: 'asked-blocked',
    title: 'Blocked: Ship it?', description: '', metadata: { reason: 'Ship it?', question_id: 'newer-question' }, created_at: '2026-11-22T10:00:00Z',
  }, {
    activity_type: 'blocked', reference_type: 'task', reference_id: 'answered-blocked',
    title: 'Blocked: Which font?', description: '', metadata: { reason: 'Which font?', question_id: 'long-answered' }, created_at: '2026-11-20T10:00:00Z',
  }, {
    activity_type: 'blocked', reference_type: 'task', reference_id: 'person-first-blocked',
    title: 'Blocked: Which region?', description: '', metadata: { reason: 'Which region?' }, created_at: '2026-11-21T06:00:00Z',
  }];

  const needsYou = computeNeedsYou({
    tasks, suggestions, projects, teamMemberId: ME, includeSuggestions: false, oversight: true, agentActivity, questions,
  });
  const needs = buildAgentNeedsYou({ needsYou, tasks, team, suggestions, projects });

  check('only questions agents asked me', needs.questions.map((q) => q.id).join() === 'newer-question,older-approval', needs.questions.map((q) => q.id));
  const blockedIds = needs.blocked.map((b) => b.task.id);
  check('blocked agents come from the shared list, with the question verbatim (the legacy title still works)',
    needs.blocked.find((b) => b.task.id === 'blocked-build')?.question === 'Which API key should I use?', needs.blocked);
  check('blocked by type: a typed blocked event ("Blocked: ...") shows, with the agent\'s reason',
    needs.blocked.find((b) => b.task.id === 'typed-blocked')?.question === 'Need the staging bucket name', needs.blocked);
  check('blocked by type: a block on a question already listed for me is counted once, as the question', !blockedIds.includes('asked-blocked'), blockedIds);
  check('blocked by type: a block on a question no longer open is over', !blockedIds.includes('answered-blocked'), blockedIds);
  check('blocked: newest first, exactly the live blocks', blockedIds.join() === 'typed-blocked,person-first-blocked,blocked-build', blockedIds);
  check('blocked: one rule names the agent (the claim, else the first agent assignee, never a person)',
    needs.blocked.find((b) => b.task.id === 'person-first-blocked')?.agentId === BUILDER
    && needs.blocked.find((b) => b.task.id === 'typed-blocked')?.agentId === AUDITOR, needs.blocked.map((b) => [b.task.id, b.agentId]));
  check('blocked: an agent\'s slice holds its own blocks by the same rule',
    needsForAgent(needs, BUILDER).blocked.map((b) => b.task.id).sort().join() === 'blocked-build,person-first-blocked');
  const review = needs.inReview.map((item) => item.task.id);
  check('agent work in review: claimed or assigned to an agent, plus held merges, newest first',
    review.join() === 'held-merge,claimed-review,assigned-review', review);
  check('a person\'s own work in review is not agent work', !review.includes('human-review'), review);
  check('To review: a task an agent only created is the person\'s, not the agent\'s', !review.includes('created-review'), review);
  check('To review: a human-only task never counts, whoever is assigned', !review.includes('human-only-review'), review);
  check('To review: a subtask in review never counts', !review.includes('sub-review'), review);
  check('To review: work the reviewer sent back waits on the agent, held merge or not', !review.includes('sent-back') && !review.includes('merge-sent-back'), review);
  check('the agent behind each review is named', needs.inReview.find((i) => i.task.id === 'claimed-review')?.agentId === BUILDER
    && needs.inReview.find((i) => i.task.id === 'assigned-review')?.agentId === BUILDER);
  check('a held merge keeps its reviewer verdict slot; plain review has none',
    'reviewerVerdict' in needs.inReview.find((i) => i.task.id === 'held-merge')!
    && !('reviewerVerdict' in needs.inReview.find((i) => i.task.id === 'claimed-review')!));
  check('suggestions count every pending one in a project the viewer reaches, whatever its fleet setting', needs.suggestions === 3, needs.suggestions);
  check('the pending suggestions themselves are listed for the inbox', needs.pendingSuggestions.map((s) => s.id).sort().join() === 's1,s2,s3', needs.pendingSuggestions.map((s) => s.id));

  const builderOnly = needsForAgent(needs, BUILDER);
  check('one agent slice holds only its own items, and its own total',
    builderOnly.questions.every((q) => q.asked_by === BUILDER) && builderOnly.inReview.every((i) => i.agentId === BUILDER)
    && builderOnly.total === builderOnly.questions.length + builderOnly.blocked.length + builderOnly.inReview.length + builderOnly.pendingSuggestions.length
    && builderOnly.total < needs.total, builderOnly.total);
  check('the tab count is every item', needs.total === 2 + 3 + 3 + 3, needs.total);

  const quiet = buildAgentNeedsYou({ needsYou: [], tasks: [], team, suggestions: [], projects });
  check('nothing waiting is zero', quiet.total === 0 && quiet.questions.length === 0 && quiet.inReview.length === 0);
}

// ── Suggestions in reach ──────────────────────────────────────────────
{
  // Generic installs: suggestions come from any agent (inbox triage, an
  // approval policy, an auditor), in any project. Only the viewer's reach
  // narrows them; no fleet setting does.
  const reach = [{ id: PROJECT_ID }, { id: QUIET_PROJECT_ID }];
  const rows = [
    { id: 'triage', status: 'pending', project_id: QUIET_PROJECT_ID, created_at: '2026-11-21T09:00:00Z' },
    { id: 'audit', status: 'pending', project_id: PROJECT_ID, created_at: '2026-11-22T09:00:00Z' },
    { id: 'asked', status: 'needs_info', project_id: PROJECT_ID, description: 'Add a sitemap.', created_at: '2026-11-23T09:00:00Z' },
    // The agent answered the info request: back with the person, so it counts again.
    { id: 'answered', status: 'needs_info', project_id: PROJECT_ID, description: `Add a robots file.${INFO_ANSWER_MARKER}\nAsked: Which paths?\nAnswer: Only /admin.`, created_at: '2026-11-20T09:00:00Z' },
    { id: 'done', status: 'approved', project_id: QUIET_PROJECT_ID, created_at: '2026-11-19T09:00:00Z' },
    { id: 'elsewhere', status: 'pending', project_id: OTHER_PROJECT_ID, created_at: '2026-11-24T09:00:00Z' },
  ] as TaskSuggestion[];
  const pending = pendingSuggestionsInReach(rows, reach).map((s) => s.id);
  check('reach: every pending suggestion in a reachable project counts, from any agent, and an answered info request with them', pending.join() === 'audit,triage,answered', pending);
  check('needs_info: an info request the agent has not answered waits on the agent, not counted', !pending.includes('asked'), pending);
  check('reach: a project outside the viewer list is never counted', !pending.includes('elsewhere'), pending);
  check('reach: the queue keeps every status in reach, for its tabs and per-project groups',
    suggestionsInReach(rows, reach).map((s) => s.id).sort().join() === 'answered,asked,audit,done,triage', suggestionsInReach(rows, reach).map((s) => s.id));
  check('reach: no projects reached, nothing counted', pendingSuggestionsInReach(rows, []).length === 0);
  check('reach: a project with its fleet switch off still counts',
    pendingSuggestionsInReach(rows, [{ id: QUIET_PROJECT_ID, autonomous_enabled: false } as Project]).map((s) => s.id).join() === 'triage');
  const withCount = computeNeedsYou({
    tasks: [], suggestions: rows, projects: reach as Project[], teamMemberId: ME, includeSuggestions: true, oversight: true,
  });
  const band = withCount.find((item) => item.kind === 'suggestions');
  check('reach: the needs-you suggestions band counts the same set', band?.count === 3, band);
}

// ── Run feed query ────────────────────────────────────────────────────
{
  const all = runFeedQuery(NO_RUN_FILTERS, null);
  check('no filters: no equalities, the first page from the top', all.eq.length === 0 && all.after === null && all.limit === RUNS_PAGE_SIZE, all);
  const CURSOR = { at: '2026-11-20T10:00:00.123456+00:00', id: 'a1b2c3d4-0000-4000-8000-000000000001' };
  const filtered = runFeedQuery({ agentId: BUILDER, status: 'failed', projectId: PROJECT_ID }, CURSOR);
  check('filters become equalities on the view; status matches display_status (what the pill shows)',
    JSON.stringify(filtered.eq) === JSON.stringify([['agent_id', BUILDER], ['display_status', 'failed'], ['project_id', PROJECT_ID]]), filtered.eq);
  check('status filter: a turn outcome (blocked, no work) can be filtered on; other cannot',
    runFeedQuery({ ...NO_RUN_FILTERS, status: 'blocked' }, null).eq[0]?.[1] === 'blocked' && runFeedQuery({ ...NO_RUN_FILTERS, status: 'no_work' }, null).eq[0]?.[1] === 'no_work'
    && runFeedQuery({ ...NO_RUN_FILTERS, status: 'other' }, null).eq.length === 0);
  const ranged = runFeedQuery({ ...NO_RUN_FILTERS, from: '2026-11-01', to: '2026-11-26' }, null, RUNS_PAGE_SIZE, 'Pacific/Honolulu');
  check('date range: from and to become midnight in the profile zone, the end day included',
    ranged.started.gte === '2026-11-01T10:00:00.000Z' && ranged.started.lt === '2026-11-27T10:00:00.000Z' && ranged.key !== all.key, ranged.started);
  check('date range: another zone is another cache key',
    ranged.key !== runFeedQuery({ ...NO_RUN_FILTERS, from: '2026-11-01', to: '2026-11-26' }, null, RUNS_PAGE_SIZE, 'Europe/London').key);
  check('date range: a bad day is dropped', Object.keys(runFeedQuery({ ...NO_RUN_FILTERS, from: '2026-13-45', to: 'soon' }, null).started).length === 0);
  check('a later page starts after the last row shown (keyset)', filtered.after?.at === CURSOR.at && filtered.after?.id === CURSOR.id, filtered.after);
  check('the cursor filter takes older rows, and the same time with a lower id',
    runCursorFilter(CURSOR) === `sort_at.lt."${CURSOR.at}",and(sort_at.eq."${CURSOR.at}",id.lt."${CURSOR.id}")`, runCursorFilter(CURSOR));
  check('a cursor that could break the filter is dropped, never sent',
    runCursorOf({ at: '2026-11-20T10:00:00Z),id.gt.(x', id: 'x' }) === null && runCursorOf({ at: CURSOR.at, id: 'a,b' }) === null && runCursorOf(CURSOR) === CURSOR);
  check('each filter set and page has its own cache key', new Set([
    all.key, filtered.key, runFeedQuery({ ...NO_RUN_FILTERS, agentId: BUILDER }, null).key, runFeedQuery(NO_RUN_FILTERS, CURSOR).key,
  ]).size === 4);
  check('the same filters share one key', runFeedQuery({ agentId: BUILDER, status: null, projectId: null }, null).key === runFeedQuery({ ...NO_RUN_FILTERS, agentId: BUILDER }, null).key);
  const bad = runFeedQuery({ agentId: "x' or 1=1", status: 'exploded' as never, projectId: 'not-a-uuid' }, { at: 'soon', id: '1' });
  check('a bad id, status or cursor is dropped, never sent', bad.eq.length === 0 && bad.after === null, bad);
  check('a smaller page size (the roster) changes the limit and key', runFeedQuery(NO_RUN_FILTERS, null, 8).limit === 8 && runFeedQuery(NO_RUN_FILTERS, null, 8).key !== all.key);

  // Show more over keyset pages (the demo feed): every run once, newest first, the total from the first page.
  {
    const first = demoRunFeedPage(NO_RUN_FILTERS, null, 4);
    const pages = [first];
    while (pages[pages.length - 1].next && pages.length < 20) pages.push(demoRunFeedPage(NO_RUN_FILTERS, pages[pages.length - 1].next, 4));
    const shown = pages.reduce<AgentRunSummary[]>((rows, page) => mergeRunPages(rows, page.runs), []);
    const everything = demoRunFeedPage(NO_RUN_FILTERS, null, 1000).runs;
    check('Show more reaches every run once, in order', shown.length === everything.length && shown.every((run, i) => run.id === everything[i].id), shown.map((r) => r.id));
    check('the total comes from the first page; later pages say none', first.total === everything.length && pages.slice(1).every((page) => page.total === null));
    check('the last page says there is no more', pages[pages.length - 1].next === null && pages.length === Math.ceil(everything.length / 4), pages.length);
    check('a run that moved into the first page shows once', mergeRunPages(everything.slice(0, 2), everything.slice(1, 3)).length === 3);
  }

  // The display status: one value for the filter and the pill.
  const turn = (outcome: string | null) => ({ source: 'turn' as const, status: 'succeeded' as const, outcome });
  check('display status: a turn shows its outcome, never its process status',
    runDisplayStatus(turn('blocked')) === 'blocked' && runDisplayStatus(turn('error')) === 'failed' && runDisplayStatus(turn('failed')) === 'failed'
    && runDisplayStatus(turn('idle')) === 'no_work' && runDisplayStatus(turn('work')) === 'succeeded' && runDisplayStatus(turn(null)) === 'succeeded'
    && runDisplayStatus(turn('unknown')) === 'other');
  check('display status: a stored run shows its status', runDisplayStatus({ source: 'run', status: 'waiting', outcome: null }) === 'waiting'
    && runDisplayStatus({ source: 'run', status: 'timed_out', outcome: null }) === 'timed_out');
  check('display status: every filter status has the pill label the filter shows',
    RUN_FILTER_STATUSES.every((status) => runPill({ source: 'run', status: 'succeeded', outcome: null, display_status: status }).label === RUN_STATUS_LABELS[status]));
  check('display status: a failed turn wears Failed, the label the Failed filter shows', runPill(turn('failed')).label === RUN_STATUS_LABELS.failed && runPill(turn('failed')).status === 'failed');
  check('display status: a timed out run is red, as Analytics counts it a failure', runPill({ source: 'run', status: 'timed_out', outcome: null }).tone === 'danger');
  const fromView = toRunSummary({ id: 't9', source: 'turn', agent_id: BUILDER, status: 'succeeded', display_status: 'blocked', outcome: 'blocked', started_at: '2026-11-24T11:00:00Z', updated_at: '2026-11-24T11:00:00Z' }, new Map());
  check('display status: a row keeps the view\'s display_status', fromView.display_status === 'blocked' && runPill(fromView).label === 'Blocked', fromView);
  const beforeView = toRunSummary({ id: 't10', source: 'turn', agent_id: BUILDER, status: 'succeeded', outcome: 'idle', started_at: '2026-11-24T11:00:00Z', updated_at: '2026-11-24T11:00:00Z' }, new Map());
  check('display status: a view without the column (before the update) is computed the same way', beforeView.display_status === 'no_work', beforeView);
}

// ── Run rows ──────────────────────────────────────────────────────────
{
  const now = Date.parse('2026-11-24T12:00:00Z');
  const names = new Map([[BUILDER, 'Jeff Builder']]);
  const row = toRunSummary({
    id: 'r1', source: 'run', agent_id: BUILDER, task_id: null, project_id: PROJECT_ID, status: 'succeeded',
    title: 'Fix the footer', started_at: '2026-11-24T11:00:00Z', finished_at: '2026-11-24T11:12:30Z', duration_ms: '750000',
    tokens_in: '1200', tokens_out: null, cost_usd: '0.42', external_url: 'https://trace.example/r1', updated_at: '2026-11-24T11:12:30Z',
  }, names);
  check('a run row names its agent and reads numbers as numbers', row.agent_name === 'Jeff Builder' && row.duration_ms === 750000 && row.tokens_in === 1200 && row.cost_usd === 0.42, row);
  check('a missing count stays null, never zero', row.tokens_out === null && row.summary === null);
  check('tokens add what was reported', runTokens(row) === 1200 && runTokens({ tokens_in: null, tokens_out: null }) === null);
  check('length is the duration', formatRunDuration(runDurationMs(row, now)) === '12m');
  const stale = toRunSummary({
    id: 'r2', source: 'run', agent_id: BUILDER, status: 'running', started_at: '2026-11-24T01:00:00Z',
    updated_at: new Date(now - (AGENT_RUN_STALE_AFTER_SECONDS + 60) * 1000).toISOString(),
  }, names);
  check('a run silent past the stale threshold reads timed out', stale.status === 'timed_out', stale.status);
  const turn = toRunSummary({ id: 't1', source: 'turn', agent_id: AUDITOR, status: 'succeeded', started_at: '2026-11-24T11:00:00Z', updated_at: '2026-11-24T11:00:00Z' }, names);
  check('a turn row is a finished run with no name it cannot know', turn.source === 'turn' && turn.status === 'succeeded' && turn.agent_name === null);
  const live = { status: 'running' as const, started_at: '2026-11-24T11:55:00Z', finished_at: null, duration_ms: null };
  check('a running run counts its time so far', runDurationMs(live, now) === 5 * 60_000);
  check('an unfinished run that is not running has no length', runDurationMs({ ...live, status: 'cancelled' }, now) === null);
  check('a run waiting on a person counts how long it has gone', runDurationMs({ ...live, status: 'waiting' }, now) === 5 * 60_000);
  check('durations read short', formatRunDuration(45_000) === '45s' && formatRunDuration(65 * 60_000) === '1h 5m' && formatRunDuration(null) === '');

  check('the trace is for who manages agents', canSeeRunTrace(row, MATE, true));
  check('the trace is for the run\'s own agent', canSeeRunTrace(row, BUILDER, false));
  check('nobody else sees the trace', !canSeeRunTrace(row, MATE, false) && !canSeeRunTrace(row, null, false));
  check('no link, no trace', !canSeeRunTrace({ ...row, external_url: null }, BUILDER, true));

  const runs = [
    { ...row, id: 'a', status: 'running', started_at: '2026-11-24T10:00:00Z' },
    { ...row, id: 'b', status: 'running', started_at: '2026-11-24T11:00:00Z' },
    { ...row, id: 'c', agent_id: AUDITOR, status: 'succeeded' },
  ] as AgentRunSummary[];
  const current = currentRunByAgent(runs);
  check('each agent\'s current run is its newest running one', current.get(BUILDER)?.id === 'b' && !current.has(AUDITOR), [...current.keys()]);
}

// ── Roster ────────────────────────────────────────────────────────────
{
  const builder = team.find((m) => m.id === BUILDER)!;
  const auditor = team.find((m) => m.id === AUDITOR)!;
  check('an agent nobody configured reads the defaults', agentRulesInWords(builder, team).join(' | ')
    === 'Picks up unassigned work | Closes its own tasks | New tasks go live | Escalates to its owners', agentRulesInWords(builder, team));
  check('set rules read in plain words, naming who it escalates to', agentRulesInWords(auditor, team).join(' | ')
    === 'Works only when assigned | Sends finished work to review | New tasks need approval | Escalates to Aleisha Mate', agentRulesInWords(auditor, team));
  check('an escalation target who left reads as its owners', agentRulesInWords({ ...auditor, agent_escalate_to: '00000000-0000-4000-8000-00000000dead' }, team)[3] === 'Escalates to its owners');

  const now = Date.parse('2026-11-24T12:00:00Z');
  const waiting = (mins: number) => [{ status: 'todo' as const, ai_readiness: 'ai_ready' as const, assignee_ids: [BUILDER], updated_at: new Date(now - mins * 60_000).toISOString() }];
  check('fresh ready work is not a backlog', agentBacklog(waiting(10), BUILDER, now, false) === null);
  const behind = agentBacklog(waiting(40), BUILDER, now, false);
  check('ready work past one missed pickup is waiting', behind?.state === 'behind' && backlogLine(behind) === 'Work waiting 40m', behind);
  const stalled = agentBacklog(waiting(180), BUILDER, now, false);
  check('past the stall threshold it is unclaimed', stalled?.state === 'stalled' && backlogLine(stalled) === 'Work unclaimed 3h', stalled);
  check('a busy agent shows no backlog', agentBacklog(waiting(180), BUILDER, now, true) === null);

  // Pause every agent: every card reads Paused while it is on.
  check('pause-all: every agent reads paused while the workspace is paused', agentPausedNow({ status: 'active', agent_paused_at: null }, '2026-11-24T11:00:00Z'));
  check('pause-all: an agent reads paused on its own pause too, and working agents do not', agentPausedNow({ status: 'active', agent_paused_at: '2026-11-24T10:00:00Z' }, null)
    && !agentPausedNow({ status: 'active', agent_paused_at: null }, null));
  check('pause-all: a suspended agent reads suspended, not paused', !agentPausedNow({ status: 'suspended', agent_paused_at: null }, '2026-11-24T11:00:00Z'));
  check('someone else\'s or unready work is not this agent\'s backlog',
    agentBacklog(waiting(180), AUDITOR, now, false) === null
    && agentBacklog([{ ...waiting(180)[0], ai_readiness: 'human_only' as never }], BUILDER, now, false) === null);
}

// ── Approval details: Show all ────────────────────────────────────────
{
  const long = 'x'.repeat(APPROVAL_DETAIL_VALUE_MAX + 50);
  const action = { details: { amount: '$4,200.00', recipient: 'client@example.com', terms: long } };
  const cut = approvalDetailRows(action);
  check('a long value is cut and says so', cut.truncated && cut.rows[2].value.length === APPROVAL_DETAIL_VALUE_MAX && cut.hidden === 0, cut.rows[2].value.length);
  const full = approvalDetailRows(action, { all: true });
  check('Show all gives the whole value', full.rows[2].value === long && !full.truncated);
  const many = { details: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i])) };
  check('more than the row limit is truncated', approvalDetailRows(many).truncated && approvalDetailRows(many).rows.length === APPROVAL_DETAIL_ROWS_MAX);
  check('Show all gives every row', approvalDetailRows(many, { all: true }).rows.length === 30);
  const short = approvalDetailRows({ details: { amount: 12 } });
  check('short details need no Show all', !short.truncated && short.rows[0].value === '12');
  check('Show all keeps values as plain text', approvalDetailRows({ details: { html: '<b>hi</b>', nested: { a: 1 } } }, { all: true }).rows
    .map((r) => r.value).join('|') === '<b>hi</b>|{"a":1}');
}

if (failures.length) {
  console.error(`agents-tab: ${failures.length} failed, ${passed} passed`);
  for (const failure of failures) console.error(`  x ${failure}`);
  process.exit(1);
}
console.log(`agents-tab: all ${passed} checks passed`);
