import type { AgentNeedsYou } from '@/lib/agents-tab';
import type { AssistantDraft } from '@/lib/assistant';
import type { Presence } from '@/lib/agents-ui';
import type { PillTone } from '@/components/ui/Pill';
import { formatElapsed } from '@/lib/time-format';
import type { Comment, Task, TeamMember } from '@/lib/types';
import { BLOCKED_COMMENT_PREFIX, type BlockedCommentSignal } from '@/lib/autonomy';

/**
 * The AI home (/ai): one place for everything AI, in three parts.
 *
 *  - Your assistant (?tab=assistant): every person's own assistant, the AI
 *    tools they connect (Claude, ChatGPT) and their chat accounts, plus what
 *    agents are waiting on them for.
 *  - Company AI (?tab=company): the company agents as an org chart, what they
 *    need from people (Needs you), their runs and analytics. People who
 *    manage agents.
 *  - Setup (?tab=setup): assistants on or off and who gets one, the agent
 *    service, chat apps and a pointer to keys. Owners.
 *
 * Old addresses (/assistant, /agent, /agent/<id>, /agent/new, Settings >
 * Assistants, the AI parts of Settings > Account) redirect here, deep links
 * kept. Pure and client-safe, so scripts/verify-ai-home.ts checks it alone.
 */

export const AI_HOME = '/ai';
export const HIRE_HREF = '/ai/agents/new';

export const AI_TABS = ['assistant', 'company', 'setup'] as const;
export type AiTab = (typeof AI_TABS)[number];

export const COMPANY_VIEWS = ['agents', 'runs', 'analytics'] as const;
export type CompanyView = (typeof COMPANY_VIEWS)[number];
export const DEFAULT_COMPANY_VIEW: CompanyView = 'agents';

export const COMPANY_VIEW_LABELS: Record<CompanyView, string> = { agents: 'Agents', runs: 'Runs', analytics: 'Analytics' };

/** The query params each Company AI view owns (Runs keeps its filters in the URL). */
export const COMPANY_VIEW_PARAMS: Record<CompanyView, string[]> = {
  agents: [],
  runs: ['agent', 'status', 'project', 'from', 'to', 'page'],
  analytics: [],
};

/** A link into the AI home: a tab, its params, and an optional section anchor. */
export function aiHomeHref(tab?: AiTab, params: Record<string, string | null | undefined> = {}, hash?: string): string {
  const query = new URLSearchParams();
  if (tab) query.set('tab', tab);
  for (const [key, value] of Object.entries(params)) if (value) query.set(key, value);
  const search = query.toString();
  return `${AI_HOME}${search ? `?${search}` : ''}${hash ? `#${hash}` : ''}`;
}

/** An agent's own page, optionally on one of its tabs (access, rules, connect). */
export function agentPageHref(agentId: string, tab?: string): string {
  return `/ai/agents/${encodeURIComponent(agentId)}${tab ? `?tab=${encodeURIComponent(tab)}` : ''}`;
}

// ── Who sees what ───────────────────────────────────────────────────────

export interface AiHomeViewer {
  role: string | null | undefined;
  /** The AI agents module. */
  agentsOn: boolean;
  /** Assistants are on for the workspace (business settings). */
  assistantsOn: boolean;
  /** agents.manage */
  manageAgents: boolean;
}

export interface AiHomeAccess {
  /** The sidebar entry and the page. */
  entry: boolean;
  /** Your assistant: your own AI (assistant, AI tools, chat accounts, what waits on you). */
  assistant: boolean;
  /** The assistant itself inside it: only while assistants are on. */
  assistantContent: boolean;
  company: boolean;
  setup: boolean;
}

/**
 * Who sees which part. Agents never sign in. With assistants off, nobody sees
 * an assistant (Owners turn them back on from Setup); the part still holds
 * the AI tools a person connects and what agents wait on them for. Company
 * AI is for people who manage agents; Setup for Owners. Nothing shows while
 * the AI agents module is off.
 */
export function aiHomeAccess(viewer: AiHomeViewer): AiHomeAccess {
  const person = !!viewer.role && viewer.role !== 'agent';
  if (!viewer.agentsOn || !person) return { entry: false, assistant: false, assistantContent: false, company: false, setup: false };
  const assistant = true;
  const company = viewer.manageAgents && viewer.role !== 'guest';
  const setup = viewer.role === 'owner';
  return { entry: assistant || company || setup, assistant, assistantContent: viewer.assistantsOn, company, setup };
}

/** The name of the first part: the workspace's word for an assistant while they are on, "Your AI" while they are off. */
export function assistantTabLabel(assistantsOn: boolean, label: string | null | undefined): string {
  if (!assistantsOn) return 'Your AI';
  const word = (label ?? '').trim() || 'Assistant';
  return `Your ${word.charAt(0).toLowerCase()}${word.slice(1)}`;
}

/** The tab a ?tab= opens: the one asked for when this person sees it, else the first they do (null: none). */
export function aiTabFrom(value: string | null | undefined, access: AiHomeAccess): AiTab | null {
  const visible = AI_TABS.filter((tab) => access[tab]);
  if (value && (visible as readonly string[]).includes(value)) return value as AiTab;
  return visible[0] ?? null;
}

export function companyViewFrom(value: string | null | undefined): CompanyView {
  return (COMPANY_VIEWS as readonly string[]).includes(value ?? '') ? value as CompanyView : DEFAULT_COMPANY_VIEW;
}

// ── Old addresses ───────────────────────────────────────────────────────

/** A server page's searchParams, as Next hands them over. */
export type PageSearchParams = Record<string, string | string[] | undefined>;

/** A server page's searchParams as URLSearchParams (a repeated key keeps every value). */
export function searchParamsOf(params: PageSearchParams): URLSearchParams {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) for (const v of value) out.append(key, v);
    else if (value !== undefined) out.set(key, value);
  }
  return out;
}

const copy = (params: URLSearchParams, keys: string[]): Record<string, string | null> =>
  Object.fromEntries(keys.map((key) => [key, params.get(key)]));

/**
 * /agent?… (the old Agents page) to its home. Needs you and the roster are
 * Company AI's first view, Runs keeps its filters, Analytics (and its old
 * name, usage) its own view; an old ?agent=<id> on the roster opens that
 * agent's page. The open task (?task=) comes along.
 */
export function legacyAgentsRedirect(params: URLSearchParams): string {
  const tab = params.get('tab');
  const task = params.get('task');
  if ((tab === 'agents' || !tab) && params.get('agent') && !params.get('status')) return agentPageHref(params.get('agent')!);
  if (tab === 'runs') return aiHomeHref('company', { view: 'runs', ...copy(params, COMPANY_VIEW_PARAMS.runs), task });
  if (tab === 'analytics' || tab === 'usage') return aiHomeHref('company', { view: 'analytics', task });
  return aiHomeHref('company', { task });
}

/** /agent/<id>?tab=… to the agent's page, its tab and any other params kept. */
export function legacyAgentProfileRedirect(agentId: string, params: URLSearchParams): string {
  const search = params.toString();
  return `/ai/agents/${encodeURIComponent(agentId)}${search ? `?${search}` : ''}`;
}

/** /agent/new?… (hiring) to its new address, ?project= and ?mode= kept. */
export function legacyHireRedirect(params: URLSearchParams): string {
  const search = params.toString();
  return `${HIRE_HREF}${search ? `?${search}` : ''}`;
}

/** /assistant to Your assistant. */
export function legacyAssistantRedirect(params: URLSearchParams): string {
  return aiHomeHref('assistant', copy(params, ['task']));
}

/** Settings > Assistants to Setup. */
export function legacyAssistantSettingsRedirect(): string {
  return aiHomeHref('setup');
}

/**
 * Old Settings anchors (/settings#<id>, /settings/account#<id>) that moved to
 * the AI home: each to its part, the anchor kept so the page scrolls to it.
 */
export const AI_SECTION_HREFS: Readonly<Record<string, string>> = {
  'assistant-service': aiHomeHref('setup', {}, 'assistant-service'),
  assistants: aiHomeHref('setup', {}, 'assistants'),
  'assistant-setups': aiHomeHref('setup', {}, 'assistant-setups'),
  'assistant-status': aiHomeHref('setup', {}, 'assistant-status'),
  'chat-connections': aiHomeHref('setup', {}, 'chat-connections'),
  'connect-ai': aiHomeHref('assistant', {}, 'connect-ai'),
  'chat-accounts': aiHomeHref('assistant', {}, 'chat-accounts'),
  'linked-accounts': aiHomeHref('assistant', {}, 'chat-accounts'),
};

// ── Needs you: what agents are waiting on a person for ──────────────────

/**
 * Agents' blocked comments that wait on a person, worked out from the tasks
 * a browser holds: the mirror of pm.my_blocked_comments for the demo and the
 * tests (the app reads the database's answer). A comment is blocked when an
 * agent wrote it with blocked: true or starting "[BLOCKED]"; it waits until a
 * person comments after it or the agent writes again, and only while the
 * task is open and still in the status it had then. Who it waits on (the
 * agent's managers, the task's people) is the database's to say; this lists
 * every one in reach.
 */
export function blockedCommentSignals(tasks: Task[], team: Pick<TeamMember, 'id' | 'role' | 'name'>[]): BlockedCommentSignal[] {
  const agents = new Map(team.filter((m) => m.role === 'agent').map((m) => [m.id, m.name]));
  const out: BlockedCommentSignal[] = [];
  for (const task of tasks) {
    if (task.status === 'done') continue;
    const comments = [...(task.comments ?? [])].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1));
    comments.forEach((comment, index) => {
      if (!agents.has(comment.user_id)) return;
      if (!(comment.blocked || BLOCKED_COMMENT_PREFIX.test(comment.text))) return;
      const status = (comment as Comment & { blocked_task_status?: string | null }).blocked_task_status;
      if (status && status !== task.status) return;
      const over = comments.slice(index + 1).some((later) => !agents.has(later.user_id) || later.user_id === comment.user_id);
      if (over) return;
      out.push({
        comment_id: comment.id, task_id: task.id, task_title: task.title, project_id: task.project_id,
        agent_id: comment.user_id, agent_name: agents.get(comment.user_id) ?? null, text: comment.text, created_at: comment.created_at,
      });
    });
  }
  return out.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

export type HubKind = 'question' | 'approval' | 'blocked' | 'merge' | 'review' | 'suggestion' | 'draft';

/** One thing waiting on the person, keyed so the same thing is counted once wherever it shows. */
export interface HubItem {
  key: string;
  kind: HubKind;
  /** When it started waiting. */
  at: string;
  agentId: string | null;
  taskId: string | null;
}

/** Stuck work first (it holds everything behind it), then decisions, then work to check, then ideas; longest waiting first in each. */
const KIND_RANK: Record<HubKind, number> = {
  blocked: 0, approval: 1, question: 1, merge: 2, review: 2, draft: 2, suggestion: 3,
};

export function hubOrder<T extends HubItem>(items: T[]): T[] {
  return [...items].sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || (a.at < b.at ? -1 : a.at > b.at ? 1 : 0) || (a.key < b.key ? -1 : 1));
}

/**
 * Company AI's Needs you: everything agents wait on people for that this
 * manager sees (the Agents page's Needs you, same count): stuck work
 * however the agent said so (an event, a blocked run, a blocked comment).
 */
export function companyHubItems(needs: AgentNeedsYou): HubItem[] {
  return hubOrder([
    ...needs.questions.map((q): HubItem => ({ key: `q:${q.id}`, kind: q.kind === 'approval' ? 'approval' : 'question', at: q.created_at, agentId: q.asked_by, taskId: q.task_id })),
    ...needs.blocked.map((b): HubItem => ({ key: `b:${b.task.id}`, kind: 'blocked', at: b.since ?? b.task.updated_at, agentId: b.agentId, taskId: b.task.id })),
    ...needs.inReview.map((r): HubItem => ({ key: `r:${r.task.id}`, kind: r.reviewerVerdict !== undefined ? 'merge' : 'review', at: r.task.updated_at, agentId: r.agentId || null, taskId: r.task.id })),
    ...needs.pendingSuggestions.map((s): HubItem => ({ key: `s:${s.id}`, kind: 'suggestion', at: s.created_at, agentId: s.proposed_by, taskId: null })),
  ]);
}

/** Whether a task is this person's: assigned to them. */
const isTheirs = (task: Pick<Task, 'assignee_ids'>, me: string) => (task.assignee_ids ?? []).includes(me);

/**
 * The person's own slice of what agents wait on: questions and approvals
 * asked to them, stuck work on their tasks or from their own assistant, and
 * reply drafts their assistant wrote. Reviews and suggestions are for the
 * people who manage agents (Company AI).
 */
export function myNeeds(needs: AgentNeedsYou, me: string | null, myAssistantId: string | null): AgentNeedsYou {
  if (!me) return { questions: [], blocked: [], inReview: [], suggestions: 0, pendingSuggestions: [], total: 0 };
  const questions = needs.questions;
  const blocked = needs.blocked.filter((b) => isTheirs(b.task, me) || (myAssistantId !== null && b.agentId === myAssistantId));
  return { questions, blocked, inReview: [], suggestions: 0, pendingSuggestions: [], total: questions.length + blocked.length };
}

export function myHubItems(input: {
  needs: AgentNeedsYou;
  drafts: AssistantDraft[];
  me: string | null;
  myAssistantId: string | null;
}): HubItem[] {
  if (!input.me) return [];
  const mine = myNeeds(input.needs, input.me, input.myAssistantId);
  return hubOrder([
    ...companyHubItems(mine),
    ...input.drafts.map((d): HubItem => ({ key: `d:${d.id}`, kind: 'draft', at: d.completed_at ?? '', agentId: input.myAssistantId, taskId: null })),
  ]);
}

/** How long something has waited on a person, in words: "Waiting on you 3 h", "Waiting on you 16 min". */
export function waitedWords(since: string, now: number = Date.now()): string {
  const at = Date.parse(since);
  if (!Number.isFinite(at)) return 'Waiting on you';
  const waited = Math.max(0, now - at);
  return waited < 60_000 ? 'Waiting on you now' : `Waiting on you ${formatElapsed(waited)}`;
}

/** The sidebar's AI count: everything in either list, each thing once. */
export function hubCount(company: HubItem[], mine: HubItem[]): number {
  return new Set([...company, ...mine].map((item) => item.key)).size;
}

/** The count in words, for the sidebar badge and the tabs. */
export function hubCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'thing needs' : 'things need'} you from AI: questions, approvals, stuck work and reviews`;
}

// ── The org chart ───────────────────────────────────────────────────────

/** How a node says what the agent is doing: "3 working now" when several runs are going. */
export function orgPresence(presence: Presence, runningCount: number): { label: string; tone: PillTone } {
  if (presence === 'paused' || presence === 'suspended') return { label: presence === 'paused' ? 'Paused' : 'Suspended', tone: 'neutral' };
  if (runningCount > 1) return { label: `${runningCount} working now`, tone: 'good' };
  if (runningCount === 1 || presence === 'working' || presence === 'reviewing') return { label: 'Working', tone: 'good' };
  if (presence === 'blocked') return { label: 'Waiting on a person', tone: 'waiting' };
  if (presence === 'offline') return { label: 'Offline', tone: 'problem' };
  return { label: 'Idle', tone: 'neutral' };
}

export interface OrgNode {
  id: string;
  orchestrator_id: string | null;
  depth: number;
  report_ids: string[];
}

/**
 * The chart's rows in reading order, each orchestrator followed by its team
 * (the tree read already orders it so). `topShown` caps the top-level
 * branches shown (a hundred agents page through "Show more"); a branch shows
 * whole. A search keeps every match and the orchestrators above it.
 */
export function orgChartRows<T extends OrgNode>(nodes: T[], options: { topShown?: number; match?: (node: T) => boolean } = {}): { rows: T[]; tops: number } {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let keep: Set<string> | null = null;
  if (options.match) {
    keep = new Set();
    for (const node of nodes) {
      if (!options.match(node)) continue;
      let at: T | undefined = node;
      let guard = 0;
      while (at && !keep.has(at.id) && guard++ < 10) {
        keep.add(at.id);
        at = at.orchestrator_id ? byId.get(at.orchestrator_id) : undefined;
      }
    }
  }
  const visible = keep ? nodes.filter((n) => keep!.has(n.id)) : nodes;
  const tops = visible.filter((n) => n.depth === 0).length;
  if (options.topShown === undefined) return { rows: visible, tops };
  const rows: T[] = [];
  let seenTops = 0;
  for (const node of visible) {
    if (node.depth === 0) seenTops++;
    if (seenTops > options.topShown) break;
    rows.push(node);
  }
  return { rows, tops };
}

/**
 * The chart without suspended agents, and the suspended ones for one
 * collapsed row at its end (QA with 63 agents, most of them old suspended
 * test agents). A suspended orchestrator that still heads an active or
 * paused agent stays in the chart, so that team reads under it. Order kept.
 */
export function orgChartSplit<T extends OrgNode & { status?: string | null }>(nodes: T[]): { chart: T[]; suspended: T[] } {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const keep = new Set<string>();
  for (const node of nodes) {
    if (node.status === 'suspended') continue;
    let at: T | undefined = node;
    let guard = 0;
    while (at && !keep.has(at.id) && guard++ < 10) {
      keep.add(at.id);
      at = at.orchestrator_id ? byId.get(at.orchestrator_id) : undefined;
    }
  }
  return { chart: nodes.filter((n) => keep.has(n.id)), suspended: nodes.filter((n) => !keep.has(n.id)) };
}
