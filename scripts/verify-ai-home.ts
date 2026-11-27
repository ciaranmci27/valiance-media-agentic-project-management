/**
 * The AI home (/ai): where old addresses land, who sees which part (assistants
 * off, roles), what Needs you lists and from where (questions, approvals,
 * stuck work from the agent's event or its "[BLOCKED]" comment, reviews,
 * suggestions, reply drafts), and that its counts agree with the Needs you
 * count the rest of the app shows. Pure logic plus a look at the route files;
 * nothing touches a database.
 *
 *   npm run -s test:ai-home
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeNeedsYou } from '@/lib/autonomy';
import { buildAgentNeedsYou } from '@/lib/agents-tab';
import {
  AI_SECTION_HREFS, agentPageHref, aiHomeAccess, aiTabFrom, assistantTabLabel, blockedCommentSignals, companyHubItems, companyViewFrom, hubCount,
  hubOrder, legacyAgentProfileRedirect, legacyAgentsRedirect, legacyAssistantRedirect, legacyAssistantSettingsRedirect, legacyHireRedirect,
  myHubItems, orgChartRows, orgChartSplit, orgPresence, type AiHomeViewer, type HubItem,
} from '@/lib/ai-home';
import type { QuestionView } from '@/lib/questions';
import type { Comment, Project, Task, TeamMember } from '@/lib/types';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`);
}

const ME = '00000000-0000-4000-8000-000000000001';
const MATE = '00000000-0000-4000-8000-000000000002';
const ORCH = '00000000-0000-4000-8000-0000000000a1';
const DEV = '00000000-0000-4000-8000-0000000000a2';
const MINE = '00000000-0000-4000-8000-0000000000a3';
const PROJECT_ID = '00000000-0000-4000-8000-0000000000b1';

const team = [
  { id: ME, name: 'Ciara Owner', role: 'owner' },
  { id: MATE, name: 'Aleisha Mate', role: 'member' },
  { id: ORCH, name: 'Alexa', role: 'agent' },
  { id: DEV, name: 'Jeff', role: 'agent' },
  { id: MINE, name: 'Ashley', role: 'agent', delegate_of: ME },
] as TeamMember[];
const projects = [{ id: PROJECT_ID, name: 'Site' }] as Project[];

const comment = (id: string, user: string, text: string, at: string): Comment => ({ id, user_id: user, text, created_at: at });

function task(id: string, fields: Partial<Task> = {}): Task {
  return {
    id, project_id: PROJECT_ID, title: id, description: '', status: 'in_progress', priority: 'medium',
    assignee_ids: [], due_date: null, tags: [], comments: [], acceptance_criteria: [], blocked_by_ids: [], parent_task_id: null,
    created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z',
    ...fields,
  } as Task;
}

function question(id: string, fields: Partial<QuestionView> = {}): QuestionView {
  return {
    id, project_id: PROJECT_ID, project_name: 'Site', task_id: null, task_title: null,
    asked_by: DEV, asked_by_name: 'Jeff', asked_to: ME, asked_to_name: 'Ciara Owner',
    question: 'Ship it?', choices: ['Yes', 'No'], allow_other: false, status: 'open',
    answer_choice: null, answer_text: null, answered_by: null, answered_by_name: null, answered_at: null,
    cancelled_by: null, cancelled_at: null, expires_at: null,
    created_at: '2026-11-20T10:00:00Z', updated_at: '2026-11-20T10:00:00Z', can_answer: true, can_cancel: false,
    ...fields,
  };
}

// ── Old addresses land at their new homes, deep links kept ──────────────
{
  const p = (s: string) => new URLSearchParams(s);
  check('/agent opens Company AI', legacyAgentsRedirect(p('')) === '/ai?tab=company');
  check('/agent?tab=agents opens Company AI', legacyAgentsRedirect(p('tab=agents')) === '/ai?tab=company');
  check('/agent?tab=runs keeps its filters', legacyAgentsRedirect(p('tab=runs&agent=x&status=failed&page=2')) === '/ai?tab=company&view=runs&agent=x&status=failed&page=2',
    legacyAgentsRedirect(p('tab=runs&agent=x&status=failed&page=2')));
  check('/agent?tab=analytics opens Analytics', legacyAgentsRedirect(p('tab=analytics')) === '/ai?tab=company&view=analytics');
  check('the old usage name opens Analytics', legacyAgentsRedirect(p('tab=usage')) === '/ai?tab=company&view=analytics');
  check('an old roster selection opens that agent', legacyAgentsRedirect(p('tab=agents&agent=abc')) === '/ai/agents/abc');
  check('the open task comes along', legacyAgentsRedirect(p('task=t1')) === '/ai?tab=company&task=t1');
  check('/agent/<id>?tab=rules keeps its tab', legacyAgentProfileRedirect('abc', p('tab=rules')) === '/ai/agents/abc?tab=rules');
  check('/agent/new keeps the project and mode', legacyHireRedirect(p('project=p1&mode=ai')) === '/ai/agents/new?project=p1&mode=ai');
  check('/assistant opens Your assistant', legacyAssistantRedirect(p('')) === '/ai?tab=assistant');
  check('Settings > Assistants opens Setup', legacyAssistantSettingsRedirect() === '/ai?tab=setup');
  check('Connect AI moved to Your assistant', AI_SECTION_HREFS['connect-ai'] === '/ai?tab=assistant#connect-ai');
  check('chat accounts (and the old linked-accounts anchor) moved to Your assistant',
    AI_SECTION_HREFS['chat-accounts'] === '/ai?tab=assistant#chat-accounts' && AI_SECTION_HREFS['linked-accounts'] === '/ai?tab=assistant#chat-accounts');
  check('chat apps moved to Setup', AI_SECTION_HREFS['chat-connections'] === '/ai?tab=setup#chat-connections');
  check('an agent page link names the Access tab', agentPageHref('abc', 'access') === '/ai/agents/abc?tab=access');
  check('an unknown Company AI view opens Agents', companyViewFrom('nope') === 'agents' && companyViewFrom('runs') === 'runs');

  // Each old route file sends people on with the helper above.
  const app = join(process.cwd(), 'src', 'app', '(protected)');
  const routes: [string, string][] = [
    ['agent/page.tsx', 'legacyAgentsRedirect'],
    ['agent/[id]/page.tsx', 'legacyAgentProfileRedirect'],
    ['agent/new/page.tsx', 'legacyHireRedirect'],
    ['agent/analytics/page.tsx', 'legacyAgentsRedirect'],
    ['assistant/page.tsx', 'legacyAssistantRedirect'],
    ['settings/(sections)/assistants/page.tsx', 'legacyAssistantSettingsRedirect'],
  ];
  for (const [file, helper] of routes) {
    const path = join(app, file);
    check(`${file} redirects with ${helper}`, existsSync(path) && readFileSync(path, 'utf8').includes(helper));
  }
  check('the AI home and the agent pages exist', ['ai/page.tsx', 'ai/agents/[id]/page.tsx', 'ai/agents/new/page.tsx'].every((f) => existsSync(join(app, f))));
  const account = readFileSync(join(app, 'settings', '(sections)', 'account', 'page.tsx'), 'utf8');
  check('Settings > Account keeps no AI settings', !/ConnectAi|LinkedAccounts/.test(account));
}

// ── Who sees which part ─────────────────────────────────────────────────
{
  const base: AiHomeViewer = { role: 'member', agentsOn: true, assistantsOn: true, manageAgents: false };
  const member = aiHomeAccess(base);
  check('a member sees only Your assistant', member.entry && member.assistant && member.assistantContent && !member.company && !member.setup, member);
  const memberOff = aiHomeAccess({ ...base, assistantsOn: false });
  check('assistants off: a member sees nothing about assistants', !memberOff.assistantContent, memberOff);
  check('assistants off: the first part is named for AI tools, not assistants', assistantTabLabel(false, 'Assistant') === 'Your AI');
  check('assistants on: the first part takes the workspace word', assistantTabLabel(true, 'Helper') === 'Your helper' && assistantTabLabel(true, null) === 'Your assistant');
  const manager = aiHomeAccess({ ...base, role: 'admin', manageAgents: true });
  check('a manager sees Company AI, not Setup', manager.company && !manager.setup, manager);
  const owner = aiHomeAccess({ ...base, role: 'owner', manageAgents: true, assistantsOn: false });
  check('an Owner sees all three parts', owner.assistant && owner.company && owner.setup, owner);
  check('assistants off: an Owner sees no assistant either (Setup turns them on)', !owner.assistantContent);
  const guest = aiHomeAccess({ ...base, role: 'guest', manageAgents: true });
  check('a guest never sees Company AI', !guest.company && !guest.setup);
  check('an agent sees nothing', !aiHomeAccess({ ...base, role: 'agent', manageAgents: true }).entry);
  check('with AI agents off nobody sees the AI home', !aiHomeAccess({ ...base, role: 'owner', manageAgents: true, agentsOn: false }).entry);
  check('a part someone cannot see falls back to their first', aiTabFrom('setup', member) === 'assistant' && aiTabFrom('company', manager) === 'company' && aiTabFrom(null, owner) === 'assistant');
}

// ── Needs you: every source, each thing once, counts that agree ─────────
{
  const tasks: Task[] = [
    // The typed blocked event (activity) on Jeff's task.
    task('event-blocked', { claimed_by: DEV, updated_at: '2026-11-21T09:00:00Z' }),
    // Stuck only by its comment: "[BLOCKED] ..." from Alexa, then nothing newer from an agent.
    task('comment-blocked', { assignee_ids: [ORCH, ME], comments: [
      comment('c1', ORCH, 'Started on it.', '2026-11-22T08:00:00Z'),
      comment('c2', ORCH, '[BLOCKED] Need the staging password\nDetails: the vault entry is empty.', '2026-11-22T09:00:00Z'),
      comment('c3', ME, 'Looking', '2026-11-22T07:00:00Z'),
      // Another agent writing after it does not answer it.
      comment('c3b', DEV, 'I can take the copy meanwhile.', '2026-11-22T09:30:00Z'),
    ] }),
    // A person replied after the block: answered, it leaves.
    task('comment-answered', { comments: [
      comment('c10', DEV, '[BLOCKED] Which font?', '2026-11-22T09:00:00Z'),
      comment('c11', ME, 'Inter, as on the site.', '2026-11-22T09:20:00Z'),
    ] }),
    // The structured flag, no prefix.
    task('flag-blocked', { comments: [{ ...comment('c12', DEV, 'Need the DNS login for the client domain', '2026-11-22T12:00:00Z'), blocked: true }] }),
    // Blocked while in progress; the task has moved to review since.
    task('moved-on', { status: 'in_review', comments: [{ ...comment('c13', DEV, '[BLOCKED] waiting on QA', '2026-11-22T12:00:00Z'), blocked: true, blocked_task_status: 'in_progress' } as Comment] }),
    // An agent comment after the block clears it.
    task('comment-cleared', { comments: [
      comment('c4', DEV, '[BLOCKED] waiting on copy', '2026-11-22T09:00:00Z'),
      comment('c5', DEV, 'Got it, carrying on.', '2026-11-22T11:00:00Z'),
    ] }),
    // A person writing [BLOCKED] is not an agent's ask.
    task('person-blocked', { comments: [comment('c6', MATE, '[BLOCKED] me too', '2026-11-22T09:00:00Z')] }),
    // Done work is never stuck.
    task('done-blocked', { status: 'done', comments: [comment('c7', DEV, '[blocked]: old', '2026-11-22T09:00:00Z')] }),
    // Both signals on one task: one row.
    task('both-blocked', { claimed_by: DEV, updated_at: '2026-11-21T10:00:00Z', comments: [comment('c8', DEV, '[BLOCKED] same thing', '2026-11-21T10:00:00Z')] }),
    // My assistant stuck on a task not assigned to me.
    task('assistant-blocked', { comments: [comment('c9', MINE, '[BLOCKED] Which calendar?', '2026-11-23T09:00:00Z')] }),
    // Agent work in review (a review row for managers).
    task('review', { status: 'in_review', claimed_by: DEV, updated_at: '2026-11-21T12:00:00Z' }),
  ];
  const agentActivity = [
    { activity_type: 'blocked', reference_type: 'task', reference_id: 'event-blocked', title: 'Blocked: needs a key', description: 'Needs the API key', created_at: '2026-11-21T09:00:00Z' },
    { activity_type: 'blocked', reference_type: 'task', reference_id: 'both-blocked', title: 'Blocked: same', description: 'Same thing', created_at: '2026-11-21T10:00:00Z' },
  ];
  const questions = [
    question('q-plain'),
    question('q-approval', { kind: 'approval', action: { type: 'merge', summary: 'Merge it' } as never, created_at: '2026-11-19T10:00:00Z' }),
    // Asked to someone else: not mine to answer.
    question('q-other', { asked_to: MATE, asked_to_name: 'Aleisha Mate' }),
  ];
  const signals = blockedCommentSignals(tasks, team);
  check('comment sources: agents\' blocked comments (flag or [BLOCKED]) on open tasks that did not move, not answered by a person or the agent since',
    [...new Set(signals.map((c) => c.task_id))].sort().join() === 'assistant-blocked,both-blocked,comment-blocked,flag-blocked',
    signals.map((c) => c.task_id));
  const needsYou = computeNeedsYou({ tasks, suggestions: [], projects, teamMemberId: ME, includeSuggestions: false, oversight: true, agentActivity, questions, blockedComments: signals });
  const agents = buildAgentNeedsYou({ needsYou, tasks, team, suggestions: [], projects });
  const fromComment = agents.blocked.find((b) => b.task.id === 'comment-blocked');
  check('the comment reads without its prefix, keeping its details for More', fromComment?.question === 'Need the staging password\nDetails: the vault entry is empty.', fromComment?.question);
  check('the comment names the agent that wrote it, and when it started waiting', fromComment?.agentId === ORCH && fromComment?.commentId === 'c2' && fromComment?.since === '2026-11-22T09:00:00Z', fromComment);
  check('one Needs you: a blocked comment is a blocked item, never a second kind', needsYou.filter((i) => i.kind === 'blocked' && i.commentId).length === 3, needsYou.map((i) => `${i.kind}:${i.task?.id}`));

  const company = companyHubItems(agents);
  const kinds = (items: HubItem[]) => items.map((i) => `${i.kind}:${i.key}`);
  check('company: questions and approvals are listed', company.some((i) => i.key === 'q:q-plain' && i.kind === 'question') && company.some((i) => i.key === 'q:q-approval' && i.kind === 'approval'), kinds(company));
  check('company: a question for someone else is not', !company.some((i) => i.key === 'q:q-other'));
  check('company: stuck work from the event is listed', company.some((i) => i.key === 'b:event-blocked' && i.kind === 'blocked'));
  check('company: stuck work from a comment is listed, waiting since the comment', company.some((i) => i.key === 'b:comment-blocked' && i.kind === 'blocked' && i.at === '2026-11-22T09:00:00Z'));
  check('company: one stuck task with both signals is one row', company.filter((i) => i.key === 'b:both-blocked').length === 1);
  check('company: agent work in review is listed', company.some((i) => i.key === 'r:review' && i.kind === 'review'));
  // The count is the Agents Needs you count: comments are part of it now.
  check('company count = the Agents Needs you count', company.length === agents.total, { company: company.length, total: agents.total });
  check('stuck work leads, then decisions, longest waiting first', company[0].kind === 'blocked' && hubOrder(company).map((i) => i.key).join() === company.map((i) => i.key).join());
  const decisions = company.filter((i) => i.kind === 'question' || i.kind === 'approval');
  check('decisions: the one waiting longest comes first', decisions[0].key === 'q:q-approval', kinds(decisions));

  const drafts = [{ id: 'd1', thread_id: 'th1', subject: 'Re: invoice', completed_at: '2026-11-23T10:00:00Z' }];
  const mine = myHubItems({ needs: agents, drafts, me: ME, myAssistantId: MINE });
  check('mine: questions asked to me', mine.some((i) => i.key === 'q:q-plain') && mine.some((i) => i.key === 'q:q-approval'));
  check('mine: stuck work on my task', mine.some((i) => i.key === 'b:comment-blocked'));
  check('mine: my assistant stuck anywhere', mine.some((i) => i.key === 'b:assistant-blocked'));
  check('mine: another agent stuck on someone else\'s task is not mine', !mine.some((i) => i.key === 'b:event-blocked'), kinds(mine));
  check('mine: reviews stay with the managers', !mine.some((i) => i.kind === 'review'));
  check('mine: my assistant\'s reply drafts', mine.some((i) => i.key === 'd:d1' && i.kind === 'draft'));
  check('the sidebar count counts each thing once', hubCount(company, mine) === new Set([...company, ...mine].map((i) => i.key)).size && hubCount(company, mine) === company.length + 1,
    { count: hubCount(company, mine), company: company.length });
  check('a member\'s count is their own list', hubCount([], mine) === mine.length);
  check('no one signed in, nothing waits', myHubItems({ needs: agents, drafts, me: null, myAssistantId: null }).length === 0);
}

// ── The org chart ───────────────────────────────────────────────────────
{
  check('several runs read as "3 working now"', orgPresence('idle', 3).label === '3 working now');
  check('one run reads Working', orgPresence('idle', 1).label === 'Working' && orgPresence('working', 0).label === 'Working');
  check('a quiet agent reads Idle', orgPresence('idle', 0).label === 'Idle');
  check('a paused agent reads Paused, whatever its runs', orgPresence('paused', 2).label === 'Paused');
  const nodes = [
    { id: 'a', name: 'Alexa', orchestrator_id: null, depth: 0, report_ids: ['b', 'c'] },
    { id: 'b', name: 'Jeff', orchestrator_id: 'a', depth: 1, report_ids: ['d'] },
    { id: 'd', name: 'Junior', orchestrator_id: 'b', depth: 2, report_ids: [] },
    { id: 'c', name: 'John', orchestrator_id: 'a', depth: 1, report_ids: [] },
    { id: 'e', name: 'Greg', orchestrator_id: null, depth: 0, report_ids: [] },
  ];
  check('every agent shows, teams under their orchestrator', orgChartRows(nodes).rows.map((n) => n.id).join() === 'a,b,d,c,e');
  check('a window keeps whole branches', orgChartRows(nodes, { topShown: 1 }).rows.map((n) => n.id).join() === 'a,b,d,c' && orgChartRows(nodes, { topShown: 1 }).tops === 2);
  check('a search keeps the match and the orchestrators above it', orgChartRows(nodes, { match: (n) => n.name === 'Junior' }).rows.map((n) => n.id).join() === 'a,b,d');
  // QA with 63 agents: suspended ones go in one collapsed row at the end; one still heading a live team stays in place.
  const withSuspended = [
    { id: 'a', name: 'Alexa', orchestrator_id: null, depth: 0, report_ids: ['b', 's1'], status: 'suspended' },
    { id: 'b', name: 'Jeff', orchestrator_id: 'a', depth: 1, report_ids: [], status: 'active' },
    { id: 's1', name: 'Old test', orchestrator_id: 'a', depth: 1, report_ids: [], status: 'suspended' },
    { id: 'p', name: 'Paula', orchestrator_id: null, depth: 0, report_ids: [], status: 'paused' },
    { id: 's2', name: 'Test 2', orchestrator_id: null, depth: 0, report_ids: [], status: 'suspended' },
  ];
  const split = orgChartSplit(withSuspended);
  check('suspended agents leave the chart for one row at the end; paused ones stay; a suspended orchestrator of a live agent stays',
    split.chart.map((n) => n.id).join() === 'a,b,p' && split.suspended.map((n) => n.id).join() === 's1,s2', split);
}

if (failures.length) {
  console.error(`ai-home: ${failures.length} failed, ${passed} passed`);
  for (const failure of failures) console.error(`  x ${failure}`);
  process.exit(1);
}
console.log(`ai-home: all ${passed} checks passed`);
