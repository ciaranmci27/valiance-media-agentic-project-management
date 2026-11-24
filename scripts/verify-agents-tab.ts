/**
 * The Agents page's logic: which tab a URL opens, what agents are waiting on
 * the signed-in person for, how the run feed is queried and a run row reads,
 * how an agent's rules and queue read in plain words, and an approval's
 * details in full behind Show all. Pure logic; nothing touches a database.
 *
 *   npm run -s test:agents-tab
 */
import { computeNeedsYou } from '@/lib/autonomy';
import {
  agentBacklog, agentRulesInWords, agentsTabFrom, backlogLine, buildAgentNeedsYou, canSeeRunTrace, currentRunByAgent, needsForAgent,
  formatRunDuration, runDurationMs, runFeedQuery, runTokens, toRunSummary, NO_RUN_FILTERS, RUNS_PAGE_SIZE,
} from '@/lib/agents-tab';
import { AGENT_RUN_STALE_AFTER_SECONDS, type AgentRunSummary } from '@/lib/agent-runs';
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

const team = [
  { id: ME, name: 'Ciara Owner', role: 'owner' },
  { id: MATE, name: 'Aleisha Mate', role: 'member' },
  { id: BUILDER, name: 'Jeff Builder', role: 'agent' },
  { id: AUDITOR, name: 'Ashley Auditor', role: 'agent', agent_close_policy: 'review', agent_create_policy: 'approval', agent_self_assign: false, agent_escalate_to: MATE },
] as TeamMember[];
const projects = [
  { id: PROJECT_ID, name: 'Site', autonomous_enabled: true },
  { id: QUIET_PROJECT_ID, name: 'Paused', autonomous_enabled: false },
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
check('a known tab opens', agentsTabFrom('runs') === 'runs' && agentsTabFrom('usage') === 'usage');
check('an unknown tab opens Needs you', agentsTabFrom('analytics') === 'needs-you');

// ── Needs you ─────────────────────────────────────────────────────────
{
  const tasks: Task[] = [
    // Claimed by the builder and finished into review (its close policy).
    task('claimed-review', { status: 'in_review', claimed_by: BUILDER, updated_at: '2026-11-21T09:00:00Z' }),
    // Created by the auditor, assigned to a person, in review: still agent work.
    task('created-review', { status: 'in_review', created_by: AUDITOR, assignee_ids: [MATE], updated_at: '2026-11-22T09:00:00Z' }),
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
    // Agents are off on this project: the review queue hides it, so the count does too.
    { id: 's3', status: 'pending', project_id: QUIET_PROJECT_ID },
    { id: 's4', status: 'approved', project_id: PROJECT_ID },
  ] as TaskSuggestion[];
  const agentActivity = [{
    activity_type: 'task_failed', reference_type: 'task', reference_id: 'blocked-build',
    title: 'BLOCKED: Which API key should I use?', description: '', created_at: '2026-11-19T09:00:00Z',
  }];

  const needsYou = computeNeedsYou({
    tasks, suggestions, projects, teamMemberId: ME, includeSuggestions: false, oversight: true, agentActivity, questions,
  });
  const needs = buildAgentNeedsYou({ needsYou, tasks, team, suggestions, projects });

  check('only questions agents asked me', needs.questions.map((q) => q.id).join() === 'newer-question,older-approval', needs.questions.map((q) => q.id));
  check('blocked agents come from the shared list, with the question verbatim',
    needs.blocked.length === 1 && needs.blocked[0].task.id === 'blocked-build' && needs.blocked[0].question === 'Which API key should I use?', needs.blocked);
  const review = needs.inReview.map((item) => item.task.id);
  check('agent work in review: claimed, created or assigned by an agent, plus held merges, newest first',
    review.join() === 'held-merge,created-review,claimed-review,assigned-review', review);
  check('a person\'s own work in review is not agent work', !review.includes('human-review'), review);
  check('the agent behind each review is named', needs.inReview.find((i) => i.task.id === 'claimed-review')?.agentId === BUILDER
    && needs.inReview.find((i) => i.task.id === 'created-review')?.agentId === AUDITOR
    && needs.inReview.find((i) => i.task.id === 'assigned-review')?.agentId === BUILDER);
  check('a held merge keeps its reviewer verdict slot; plain review has none',
    'reviewerVerdict' in needs.inReview.find((i) => i.task.id === 'held-merge')!
    && !('reviewerVerdict' in needs.inReview.find((i) => i.task.id === 'claimed-review')!));
  check('suggestions count only pending ones in projects agents run', needs.suggestions === 2, needs.suggestions);
  check('the pending suggestions themselves are listed for the inbox', needs.pendingSuggestions.map((s) => s.id).sort().join() === 's1,s2', needs.pendingSuggestions.map((s) => s.id));

  const builderOnly = needsForAgent(needs, BUILDER);
  check('one agent slice holds only its own items, and its own total',
    builderOnly.questions.every((q) => q.asked_by === BUILDER) && builderOnly.inReview.every((i) => i.agentId === BUILDER)
    && builderOnly.total === builderOnly.questions.length + builderOnly.blocked.length + builderOnly.inReview.length + builderOnly.pendingSuggestions.length
    && builderOnly.total < needs.total, builderOnly.total);
  check('the tab count is every item', needs.total === 2 + 1 + 4 + 2, needs.total);

  const quiet = buildAgentNeedsYou({ needsYou: [], tasks: [], team, suggestions: [], projects });
  check('nothing waiting is zero', quiet.total === 0 && quiet.questions.length === 0 && quiet.inReview.length === 0);
}

// ── Run feed query ────────────────────────────────────────────────────
{
  const all = runFeedQuery(NO_RUN_FILTERS, 0);
  check('no filters: no equalities, the first page', all.eq.length === 0 && all.from === 0 && all.to === RUNS_PAGE_SIZE - 1, all);
  const filtered = runFeedQuery({ agentId: BUILDER, status: 'failed', projectId: PROJECT_ID }, 2);
  check('filters become equalities on the view', JSON.stringify(filtered.eq) === JSON.stringify([['agent_id', BUILDER], ['status', 'failed'], ['project_id', PROJECT_ID]]), filtered.eq);
  check('page 3 reads rows 50 to 74', filtered.from === 2 * RUNS_PAGE_SIZE && filtered.to === 3 * RUNS_PAGE_SIZE - 1, filtered);
  check('each filter set and page has its own cache key', new Set([
    all.key, filtered.key, runFeedQuery({ ...NO_RUN_FILTERS, agentId: BUILDER }, 0).key, runFeedQuery(NO_RUN_FILTERS, 1).key,
  ]).size === 4);
  check('the same filters share one key', runFeedQuery({ agentId: BUILDER, status: null, projectId: null }, 0).key === runFeedQuery({ ...NO_RUN_FILTERS, agentId: BUILDER }, 0).key);
  const bad = runFeedQuery({ agentId: "x' or 1=1", status: 'exploded' as never, projectId: 'not-a-uuid' }, -4);
  check('a bad id, status or page is dropped, never sent', bad.eq.length === 0 && bad.from === 0, bad);
  check('a smaller page size (the roster) changes the range and key', runFeedQuery(NO_RUN_FILTERS, 0, 8).to === 7 && runFeedQuery(NO_RUN_FILTERS, 0, 8).key !== all.key);
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
    === 'Picks up unassigned work | Closes its own tasks | New tasks go live | Escalates to the Owner', agentRulesInWords(builder, team));
  check('set rules read in plain words, naming who it escalates to', agentRulesInWords(auditor, team).join(' | ')
    === 'Works only when assigned | Sends finished work to review | New tasks need approval | Escalates to Aleisha Mate', agentRulesInWords(auditor, team));
  check('an escalation target who left reads as the Owner', agentRulesInWords({ ...auditor, agent_escalate_to: '00000000-0000-4000-8000-00000000dead' }, team)[3] === 'Escalates to the Owner');

  const now = Date.parse('2026-11-24T12:00:00Z');
  const waiting = (mins: number) => [{ status: 'todo' as const, ai_readiness: 'ai_ready' as const, assignee_ids: [BUILDER], updated_at: new Date(now - mins * 60_000).toISOString() }];
  check('fresh ready work is not a backlog', agentBacklog(waiting(10), BUILDER, now, false) === null);
  const behind = agentBacklog(waiting(40), BUILDER, now, false);
  check('ready work past one missed pickup is waiting', behind?.state === 'behind' && backlogLine(behind) === 'Work waiting 40m', behind);
  const stalled = agentBacklog(waiting(180), BUILDER, now, false);
  check('past the stall threshold it is unclaimed', stalled?.state === 'stalled' && backlogLine(stalled) === 'Work unclaimed 3h', stalled);
  check('a busy agent shows no backlog', agentBacklog(waiting(180), BUILDER, now, true) === null);
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
