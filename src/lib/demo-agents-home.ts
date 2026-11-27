import { runFeedQuery, type RunFeedFilters } from '@/lib/agents-tab';
import { runDisplayStatus, type AgentRunNote, type AgentRunPlanStep, type AgentRunStatus, type AgentRunSummary } from '@/lib/agent-runs';
import type { QuestionView } from '@/lib/questions';
import { actionSentence } from '@/lib/question-actions-text';
import type { AgentTreeNode } from '@/lib/api/agent-hierarchy';

/**
 * The demo's Agents home: a few open questions and an approval, decided ones
 * for the Decided view, and runs that wait, fail and succeed (with a chain of
 * agents), so Needs you, Runs and run detail all have something to show.
 * Client-only fixtures; the demo writes nothing. The blocked agent's task and
 * its blocked event live with the rest of the demo store (demo-data.ts).
 */

export const DEMO_OWNER = 'a1a1a1a1-0001-4000-8000-000000000001';
const MARCUS = 'a1a1a1a1-0002-4000-8000-000000000002';
export const DEMO_ATLAS = 'a1a1a1a1-0006-4000-8000-000000000006';
export const DEMO_SCOUT = 'a1a1a1a1-0007-4000-8000-000000000007';
const CREST = 'c3c3c3c3-0001-4000-8000-000000000001';
const BLOOMWELL = 'c3c3c3c3-0002-4000-8000-000000000002';
const NEOFORGE = 'c3c3c3c3-0003-4000-8000-000000000003';

/** The task Atlas is blocked on (in the demo store's task list). */
export const DEMO_BLOCKED_TASK_ID = 'e5e5e5e5-0099-4000-8000-000000000099';

const RUN = (n: number) => `d7d7d7d7-${String(n).padStart(4, '0')}-4000-8000-${String(n).padStart(12, '0')}`;
/** The run Scout is waiting in, on its open question. */
export const DEMO_WAITING_RUN_ID = RUN(1);

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
const hoursAgo = (n: number) => minutesAgo(n * 60);

const NAMES: Record<string, string> = {
  [DEMO_OWNER]: 'Sarah Chen', [MARCUS]: 'Marcus Johnson', [DEMO_ATLAS]: 'Atlas', [DEMO_SCOUT]: 'Scout',
};
const PROJECT_NAMES: Record<string, string> = { [CREST]: 'Crest Financial Rebrand', [BLOOMWELL]: 'Bloomwell Health App', [NEOFORGE]: 'NeoForge Website' };

function question(fields: Partial<QuestionView> & Pick<QuestionView, 'id' | 'asked_by' | 'question' | 'created_at'>): QuestionView {
  const project = fields.project_id ?? null;
  return {
    project_id: project,
    project_name: project ? PROJECT_NAMES[project] ?? null : null,
    task_id: null,
    task_title: null,
    asked_by_name: NAMES[fields.asked_by] ?? null,
    asked_to: DEMO_OWNER,
    asked_to_name: NAMES[DEMO_OWNER],
    choices: null,
    allow_other: true,
    status: 'open',
    answer_choice: null,
    answer_text: null,
    answered_by: null,
    answered_by_name: null,
    answered_at: null,
    cancelled_by: null,
    cancelled_at: null,
    expires_at: null,
    updated_at: fields.created_at,
    can_answer: true,
    can_cancel: true,
    ...fields,
  };
}

/** Open questions and an approval the agents asked Sarah (the demo's Owner). */
export function demoOpenQuestions(): QuestionView[] {
  return [
    question({
      id: 'qqqqqqqq-0001-4000-8000-000000000001',
      asked_by: DEMO_SCOUT,
      project_id: BLOOMWELL,
      question: 'How long should a patient stay signed in on the portal before it asks for their password again?',
      choices: ['15 minutes', '30 minutes', '1 hour'],
      created_at: hoursAgo(2),
      run_id: DEMO_WAITING_RUN_ID,
    }),
    question({
      id: 'qqqqqqqq-0002-4000-8000-000000000002',
      asked_by: DEMO_ATLAS,
      project_id: CREST,
      kind: 'approval',
      question: 'The client asked for the final guidelines PDF by Friday.',
      choices: ['approve', 'reject'],
      allow_other: false,
      action: {
        type: 'send_email',
        summary: 'Email the brand guidelines PDF to David at Crest Financial',
        details: { to: 'david@crestfinancial.example', subject: 'Crest brand guidelines, final', attachment: 'crest-guidelines-v3.pdf' },
      },
      decision: null,
      created_at: hoursAgo(5),
    }),
    question({
      id: 'qqqqqqqq-0003-4000-8000-000000000003',
      asked_by: DEMO_ATLAS,
      project_id: NEOFORGE,
      question: 'Should the pricing page show annual prices first, or monthly?',
      choices: ['Annual first', 'Monthly first'],
      created_at: hoursAgo(26),
    }),
    // An answer that does something: the app's own sentence shows on the choice that acts.
    question({
      id: 'qqqqqqqq-0004-4000-8000-000000000004',
      asked_by: DEMO_QUILL,
      asked_by_name: 'Quill',
      project_id: NEOFORGE,
      question: 'My work on NeoForge is billed by the hour, but time tracking is off there. Turn it on so I can start?',
      choices: ['Turn it on', 'Not now'],
      proposed_actions: [{
        type: 'project.update', summary: null, details: { project_id: NEOFORGE, time_tracking_enabled: true }, on_choice: 'Turn it on', asked_may_perform: true, you_may_perform: true,
        sentence: actionSentence({ type: 'project.update', details: { time_tracking_enabled: true }, on_choice: 'Turn it on' }, { approval: false, projectName: 'NeoForge Website' }),
      }],
      performed: null,
      created_at: hoursAgo(1),
    }),
  ];
}

/** Recently decided questions and approvals, for the Decided view. */
export function demoDecidedQuestions(): QuestionView[] {
  return [
    question({
      id: 'qqqqqqqq-0011-4000-8000-000000000011',
      asked_by: DEMO_ATLAS,
      project_id: BLOOMWELL,
      kind: 'approval',
      question: 'Merge the CSV export once checks pass?',
      choices: ['approve', 'reject'],
      allow_other: false,
      action: { type: 'merge', summary: 'Merge the CSV export pull request into main', details: { repository: 'bloomwell-app', pull_request: '#214' } },
      status: 'answered',
      answer_choice: 'approve',
      answered_by: DEMO_OWNER,
      answered_by_name: NAMES[DEMO_OWNER],
      answered_at: hoursAgo(3),
      decision: 'approved',
      decided_by: DEMO_OWNER,
      decided_by_name: NAMES[DEMO_OWNER],
      decided_via: 'app',
      can_answer: false,
      can_cancel: false,
      created_at: hoursAgo(4),
    }),
    question({
      id: 'qqqqqqqq-0012-4000-8000-000000000012',
      asked_by: DEMO_SCOUT,
      project_id: CREST,
      question: 'Is the navy in the old logo staying in the new palette?',
      choices: ['Yes', 'No'],
      status: 'answered',
      answer_choice: 'No',
      answer_text: 'Swap it for the deeper teal from round 2.',
      answered_by: MARCUS,
      answered_by_name: NAMES[MARCUS],
      answered_at: hoursAgo(20),
      can_answer: false,
      can_cancel: false,
      created_at: hoursAgo(22),
    }),
    question({
      id: 'qqqqqqqq-0013-4000-8000-000000000013',
      asked_by: DEMO_ATLAS,
      project_id: NEOFORGE,
      kind: 'approval',
      question: 'Buy the stock photo pack for the hero?',
      choices: ['approve', 'reject'],
      allow_other: false,
      action: { type: 'purchase', summary: 'Buy a stock photo license for the NeoForge hero image', details: { amount: '$49.00' } },
      status: 'answered',
      answer_choice: 'reject',
      answer_text: 'Use the 3D renders instead.',
      answered_by: DEMO_OWNER,
      answered_by_name: NAMES[DEMO_OWNER],
      answered_at: hoursAgo(30),
      decision: 'rejected',
      decided_by: DEMO_OWNER,
      decided_by_name: NAMES[DEMO_OWNER],
      decided_via: 'api_key',
      can_answer: false,
      can_cancel: false,
      created_at: hoursAgo(31),
    }),
  ];
}

type DemoRun = Omit<AgentRunSummary, 'display_status' | 'agent_name'> & { plan?: AgentRunPlanStep[]; notes?: AgentRunNote[]; parent_run_id?: string; root_run_id?: string };

function run(fields: Partial<DemoRun> & Pick<DemoRun, 'id' | 'agent_id' | 'status' | 'started_at'>): DemoRun {
  return {
    source: 'run', task_id: null, project_id: null, outcome: null, title: null, summary: null, model: 'claude-sonnet', trigger: 'assigned',
    finished_at: null, duration_ms: null, tokens_in: null, tokens_out: null, cost_usd: null, external_id: null, external_url: null,
    updated_at: fields.started_at,
    ...fields,
  };
}

function demoRunRows(): DemoRun[] {
  const finished = (startMin: number, lengthMin: number) => ({
    started_at: minutesAgo(startMin), finished_at: minutesAgo(startMin - lengthMin), duration_ms: lengthMin * 60_000, updated_at: minutesAgo(startMin - lengthMin),
  });
  return [
    run({
      id: DEMO_WAITING_RUN_ID, agent_id: DEMO_SCOUT, status: 'waiting', project_id: BLOOMWELL, trigger: 'scheduled',
      title: 'Audit the patient portal sign-in for HIPAA gaps', started_at: hoursAgo(2.5), updated_at: hoursAgo(2),
      summary: 'Found the session never expires. Asked how long a patient should stay signed in before changing it.',
      tokens_in: 48_200, tokens_out: 6_100, cost_usd: 0.31,
      plan: [
        { title: 'Read the auth flow', status: 'done' },
        { title: 'Check session handling against HIPAA', status: 'done' },
        { title: 'Ask for the timeout to use', status: 'running' },
        { title: 'Write the fix as a suggestion', status: 'pending' },
      ],
      notes: [{ at: hoursAgo(2.2), text: 'Session cookie has no max age; refresh tokens never rotate.' }],
    }),
    run({
      id: RUN(2), agent_id: DEMO_ATLAS, status: 'running', project_id: BLOOMWELL, task_id: DEMO_BLOCKED_TASK_ID,
      title: 'Add CSV export to reports', started_at: minutesAgo(40), updated_at: minutesAgo(3), tokens_in: 21_000, tokens_out: 3_400,
      plan: [
        { title: 'Stream rows through a worker', status: 'done' },
        { title: 'Upload the file to storage', status: 'running' },
        { title: 'Email the download link', status: 'pending' },
      ],
    }),
    // Atlas runs several at once (a pool): its org chart node reads "3 working now".
    run({
      id: RUN(9), agent_id: DEMO_ATLAS, status: 'running', project_id: CREST, trigger: 'chat',
      title: 'Sort this week\'s client requests', started_at: minutesAgo(12), updated_at: minutesAgo(1), tokens_in: 8_200, tokens_out: 1_100,
    }),
    run({
      id: RUN(10), agent_id: DEMO_ATLAS, status: 'running', project_id: NEOFORGE, trigger: 'scheduled',
      title: 'Plan the pricing page fix', started_at: minutesAgo(6), updated_at: minutesAgo(2), tokens_in: 5_400, tokens_out: 700,
    }),
    run({
      id: RUN(3), agent_id: DEMO_ATLAS, status: 'failed', project_id: NEOFORGE, title: 'Build the pricing page',
      ...finished(190, 14), tokens_in: 33_000, tokens_out: 4_800, cost_usd: 0.22,
      summary: 'The build failed: the CMS preview token is missing in the staging environment.',
    }),
    run({
      id: RUN(4), agent_id: DEMO_ATLAS, status: 'succeeded', project_id: CREST, trigger: 'chat', title: 'Plan the guidelines handoff',
      ...finished(320, 9), tokens_in: 12_400, tokens_out: 2_100, cost_usd: 0.09,
      summary: 'Split the guidelines handoff into a layout pass for Scout and a final review.',
    }),
    run({
      id: RUN(5), agent_id: DEMO_SCOUT, status: 'succeeded', project_id: CREST, title: 'Lay out the guidelines PDF',
      ...finished(300, 26), tokens_in: 54_000, tokens_out: 9_700, cost_usd: 0.41, parent_run_id: RUN(4), root_run_id: RUN(4),
      summary: 'Laid out 24 pages and exported crest-guidelines-v3.pdf.',
    }),
    run({
      id: RUN(6), agent_id: DEMO_SCOUT, status: 'timed_out', project_id: NEOFORGE, title: 'Check image sizes on the homepage',
      started_at: hoursAgo(30), updated_at: hoursAgo(27),
    }),
    run({
      id: RUN(7), agent_id: DEMO_ATLAS, source: 'turn', status: 'succeeded', outcome: 'blocked', project_id: BLOOMWELL, trigger: 'scheduled',
      task_id: DEMO_BLOCKED_TASK_ID, title: 'Waiting on the storage bucket name', ...finished(70, 4), tokens_in: 6_000, tokens_out: 700,
    }),
    run({
      id: RUN(8), agent_id: DEMO_SCOUT, source: 'turn', status: 'succeeded', outcome: 'work', project_id: CREST, trigger: 'chat',
      title: 'Answered a question about the color palette', ...finished(600, 3), tokens_in: 4_200, tokens_out: 900,
    }),
  ];
}

const summaryOf = (demo: DemoRun): AgentRunSummary => {
  const { parent_run_id, root_run_id, ...rest } = demo;
  const row = { ...rest };
  delete row.plan;
  delete row.notes;
  return {
  ...row,
  agent_name: null,
  display_status: runDisplayStatus(row),
  ...(parent_run_id ? { parent_run_id } : {}),
  ...(root_run_id ? { root_run_id } : {}),
  };
};

/** A page of the demo run feed, filtered and paged by the real query's rules. */
export function demoRunFeedPage(filters: RunFeedFilters, page: number, pageSize: number): { runs: AgentRunSummary[]; total: number } {
  const query = runFeedQuery(filters, page, pageSize);
  const rows = demoRunRows().map(summaryOf)
    .filter((row) => query.eq.every(([column, value]) => (row as unknown as Record<string, unknown>)[column] === value))
    .filter((row) => (!query.started.gte || row.started_at >= query.started.gte) && (!query.started.lt || row.started_at < query.started.lt))
    .sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
  return { runs: rows.slice(query.from, query.to + 1), total: rows.length };
}

/** One demo run by id, as a feed row; null when there is none. */
export function demoRunRow(id: string): AgentRunSummary | null {
  const row = demoRunRows().find((r) => r.id === id);
  return row ? summaryOf(row) : null;
}

export function demoRunDetail(id: string): { plan: AgentRunPlanStep[]; notes: AgentRunNote[] } {
  const row = demoRunRows().find((r) => r.id === id);
  return { plan: row?.plan ?? [], notes: row?.notes ?? [] };
}

/** A demo run's handoff: the guidelines plan (Atlas) handed the layout to Scout. */
export function demoRunFamily(id: string) {
  const rows = demoRunRows();
  const self = rows.find((r) => r.id === id);
  const rootId = self?.root_run_id ?? id;
  const brief = (r: DemoRun) => ({ id: r.id, agent_id: r.agent_id, title: r.title, status: r.status as AgentRunStatus, started_at: r.started_at, updated_at: r.updated_at });
  const parent = self?.parent_run_id ? rows.find((r) => r.id === self.parent_run_id) ?? null : null;
  const children = rows.filter((r) => r.parent_run_id === id);
  const members = rows.filter((r) => r.id === rootId || r.root_run_id === rootId);
  const chain = members.length > 1
    ? members.map((r) => ({ ...brief(r), parent_run_id: r.parent_run_id ?? null, task_id: r.task_id, task_title: null, depth: r.id === rootId ? 0 : 1 }))
    : [];
  return { parent: parent ? brief(parent) : null, children: children.map(brief), chain };
}

const DEMO_QUILL = 'a1a1a1a1-0008-4000-8000-000000000008';
const DEMO_LEDGER = 'a1a1a1a1-0009-4000-8000-000000000009';

/**
 * The demo's org chart (AI > Company AI): Atlas orchestrates Scout and Quill;
 * Ledger works on its own, for Owners only, and is paused. Intake bot is
 * suspended, so it waits in the chart's collapsed Suspended row. Personal
 * assistants are never on it.
 */
export function demoAgentTree(): { agents: AgentTreeNode[]; max_levels: number } {
  const node = (id: string, name: string, title: string, fields: Partial<AgentTreeNode>): AgentTreeNode => ({
    id, name, title, avatar_url: null, status: 'active', orchestrator_id: null, depth: 0, reachable_directly: true, ask_first: false,
    audience_summary: { limited: false, words: 'Everyone' }, report_ids: [], ...fields,
  });
  return {
    agents: [
      node(DEMO_ATLAS, 'Atlas', 'Plans work and hands it to the team', { report_ids: [DEMO_SCOUT, DEMO_QUILL], audience_summary: { limited: true, words: 'Everyone' } }),
      node(DEMO_SCOUT, 'Scout', 'Designs and checks client work', { orchestrator_id: DEMO_ATLAS, depth: 1, reachable_directly: false, audience_summary: { limited: false, words: 'Everyone who can use Atlas' } }),
      node(DEMO_QUILL, 'Quill', 'Writes copy and client updates', { orchestrator_id: DEMO_ATLAS, depth: 1, audience_summary: { limited: true, words: 'Sarah Chen, Marcus Johnson only' } }),
      node(DEMO_LEDGER, 'Ledger', 'Keeps the books and drafts invoices', { audience_summary: { limited: true, words: 'Owners only' }, ask_first: true }),
      node('a1a1a1a1-0010-4000-8000-000000000010', 'Intake bot', 'Sorted the old contact form', { status: 'suspended' }),
    ],
    max_levels: 4,
  };
}
