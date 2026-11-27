import type { AgentDetail, ProjectAgentAssignment, SettingsField } from '@/lib/agent-workspace';
import { DEFAULT_AGENT_RULES } from '@/lib/agent-rules';
import { demoAgentActivity, demoProjects, demoTeam } from '@/lib/demo-data';
import type { AgentActivity } from '@/lib/types';

/**
 * An agent's profile in demo mode, from the demo team and projects: who it
 * is, its owners, projects (some set up), limits and usage, keys and its
 * context pack, so every tab of /agent/<id> shows something real. Nothing
 * here is saved; the profile's writes do nothing in demo.
 *
 * On a development server, ?sample= on the profile shows the states demo
 * data does not reach: paused, suspended, over-budget, workspace-paused,
 * personal (applyAgentSample).
 */

const SARAH = 'a1a1a1a1-0001-4000-8000-000000000001';
const MARCUS = 'a1a1a1a1-0002-4000-8000-000000000002';
const EMILY = 'a1a1a1a1-0003-4000-8000-000000000003';
const ATLAS = 'a1a1a1a1-0006-4000-8000-000000000006';
const SCOUT = 'a1a1a1a1-0007-4000-8000-000000000007';
const CREST = 'c3c3c3c3-0001-4000-8000-000000000001';
const BLOOMWELL = 'c3c3c3c3-0002-4000-8000-000000000002';
const NEOFORGE = 'c3c3c3c3-0003-4000-8000-000000000003';
const SOLSTICE = 'c3c3c3c3-0004-4000-8000-000000000004';

const iso = (daysAgo: number, hoursAgo = 0) => new Date(Date.now() - daysAgo * 86_400_000 - hoursAgo * 3_600_000).toISOString();
const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

const BUILDER_SETTINGS: SettingsField[] = [
  { key: 'repo', label: 'Repository', type: 'text', required: true, placeholder: 'owner/repo' },
  { key: 'branch', label: 'Branch to work on', type: 'text', default: 'dev' },
  { key: 'review_before_merge', label: 'A person reviews before merge', type: 'boolean', default: true },
];

const REVIEW_SETTINGS: SettingsField[] = [
  { key: 'checklist', label: 'Checklist', type: 'select', options: ['Security', 'Accessibility', 'Performance'], default: 'Security' },
  { key: 'report_day', label: 'Report day', type: 'select', options: ['monday', 'friday'], default: 'friday' },
];

interface DemoAgent {
  title: string;
  role: string;
  description: string;
  owners: string[];
  /** Projects it can open; the first ones listed in setUp carry an assignment. */
  on: string[];
  setUp: { project: string; schema: SettingsField[]; settings: Record<string, string | boolean>; instructions: string; paused?: boolean }[];
  budget: { usd: number; spent: number; tokens: number };
  keys: { name: string; prefix: string; scopes: string[]; used: number | null; created: number; ends: number | null }[];
  escalateTo: string | null;
}

const AGENTS: Record<string, DemoAgent> = {
  [ATLAS]: {
    title: 'Builder',
    role: 'builder',
    description: 'Builds features from ready tasks, opens a pull request for each and waits for review.',
    owners: [SARAH, MARCUS],
    on: [BLOOMWELL, CREST, NEOFORGE],
    setUp: [
      { project: BLOOMWELL, schema: BUILDER_SETTINGS, settings: { repo: 'bloomwell/app', branch: 'dev', review_before_merge: true }, instructions: 'Keep exports under the memory limit. Ask before touching auth.' },
      { project: CREST, schema: BUILDER_SETTINGS, settings: { repo: 'crest/site', branch: 'dev', review_before_merge: true }, instructions: '', paused: true },
    ],
    budget: { usd: 150, spent: 61.4, tokens: 4_820_000 },
    keys: [
      { name: 'Atlas on the build server', prefix: 'pk_live_3fa9c1', scopes: ['tasks.read', 'tasks.manage_assigned', 'tasks.create', 'projects.read', 'project_context.read', 'agent_activity.write'], used: 0.02, created: 40, ends: 50 },
      { name: 'Atlas laptop (old)', prefix: 'pk_live_81bd02', scopes: ['tasks.read'], used: 70, created: 120, ends: -5 },
    ],
    escalateTo: null,
  },
  [SCOUT]: {
    title: 'Reviewer',
    role: 'reviewer',
    description: 'Audits pull requests and finished tasks against the checklist, and files what it finds.',
    owners: [EMILY],
    on: [BLOOMWELL, SOLSTICE],
    setUp: [
      { project: BLOOMWELL, schema: REVIEW_SETTINGS, settings: { checklist: 'Security', report_day: 'friday' }, instructions: 'HIPAA matters here: flag anything that logs patient data.' },
    ],
    budget: { usd: 40, spent: 12.75, tokens: 1_105_000 },
    keys: [
      { name: 'Scout on the review host', prefix: 'pk_live_c27e44', scopes: ['tasks.read', 'suggestions.create', 'projects.read', 'questions.ask'], used: 0.1, created: 21, ends: 69 },
    ],
    escalateTo: null,
  },
};

const SCOPES_AN_AGENT_HOLDS = [
  'tasks.read', 'tasks.create', 'tasks.manage_assigned', 'projects.read', 'project_context.read', 'project_context.manage',
  'suggestions.create', 'agent_activity.write', 'questions.ask', 'time.manage_own', 'goals.read', 'files.read',
];

const member = (id: string) => demoTeam.find((m) => m.id === id);
const projectName = (id: string) => demoProjects.find((p) => p.id === id)?.name ?? 'Project';

export function demoAgentDetail(agentId: string): AgentDetail | null {
  const row = member(agentId);
  const spec = AGENTS[agentId];
  if (!row || row.role !== 'agent' || !spec) return null;
  const assignments: ProjectAgentAssignment[] = spec.setUp.map((s, index) => ({
    agent_id: agentId,
    agent_name: row.name,
    avatar_url: null,
    agent_role: spec.role,
    status: s.paused ? 'paused' : 'active',
    template_key: null,
    settings: s.settings,
    instructions: s.instructions,
    settings_schema: s.schema,
    created_at: iso(30 - index),
    updated_at: iso(2 + index),
    project_id: s.project,
    project_name: projectName(s.project),
  }));
  const projects = spec.on.map((id) => {
    const project = demoProjects.find((p) => p.id === id);
    return { id, name: project?.name ?? 'Project', status: project?.status ?? 'active' };
  }).sort((a, b) => a.name.localeCompare(b.name));
  return {
    agent: {
      id: agentId, name: row.name, title: spec.title, description: spec.description, avatar_url: row.avatar || null,
      status: row.status === 'suspended' ? 'suspended' : 'active', agent_role: spec.role, paused_at: null, delegate_of: null,
    },
    person: null,
    rules: { ...DEFAULT_AGENT_RULES, agent_escalate_to: spec.escalateTo, agent_escalate_to_group: null },
    limits: { max_concurrent_runs: 2, rate_per_minute: null, budget_usd: spec.budget.usd, budget_tokens: null, budget_period: 'month', max_run_spend_cents: null },
    usage: { period_start: iso(new Date().getUTCDate() - 1), spent_usd: spec.budget.spent, spent_tokens: spec.budget.tokens, running_runs: 0, live_claims: 1 },
    health: null,
    current_run: null,
    projects: assignments,
    projects_total: assignments.length,
    project_access: { projects, hidden_count: 0, total: projects.length },
    keys: spec.keys.map((k, index) => ({
      id: `demo-key-${agentId.slice(-4)}-${index}`,
      name: k.name,
      prefix: k.prefix,
      scopes: k.scopes,
      created_at: iso(k.created),
      last_used_at: k.used === null ? null : iso(0, k.used * 24),
      revoked_at: null,
      expires_at: k.ends === null ? null : inDays(k.ends),
      disabled_at: null,
    })),
    key_scopes_available: SCOPES_AN_AGENT_HOLDS,
    webhooks: [],
    template_key: null,
    owners: spec.owners.map((id) => ({ id, name: member(id)?.name ?? '', avatar_url: member(id)?.avatar || null })),
    owner_groups: [],
    can_manage: true,
    is_owner: spec.owners.includes(SARAH),
    omitted: [],
  };
}

/** States demo data does not reach, for a development server's ?sample=. */
export const AGENT_SAMPLES = ['paused', 'suspended', 'over-budget', 'workspace-paused', 'personal'] as const;
export type AgentSample = (typeof AGENT_SAMPLES)[number];

export function agentSampleOf(value: string | null | undefined): AgentSample | null {
  return (AGENT_SAMPLES as readonly string[]).includes(value ?? '') ? value as AgentSample : null;
}

export function applyAgentSample(detail: AgentDetail, sample: AgentSample | null): AgentDetail {
  switch (sample) {
    case 'paused':
      return { ...detail, agent: { ...detail.agent, paused_at: iso(0, 3) } };
    case 'suspended':
      return { ...detail, agent: { ...detail.agent, status: 'suspended' } };
    case 'over-budget':
      return detail.usage && detail.limits?.budget_usd
        ? { ...detail, usage: { ...detail.usage, spent_usd: detail.limits.budget_usd + 2.4 } }
        : detail;
    case 'personal': {
      const person = member(EMILY);
      return {
        ...detail,
        agent: { ...detail.agent, delegate_of: EMILY },
        person: { id: EMILY, name: person?.name ?? 'Emily', status: 'active', paused_at: iso(0, 1) },
        owners: [{ id: EMILY, name: person?.name ?? 'Emily', avatar_url: null }],
        keys: [],
        key_scopes_available: undefined,
      };
    }
    default:
      return detail;
  }
}

/** Every agent paused, for ?sample=workspace-paused (the real state comes from agentsPauseRead). */
export function sampleAgentsPause(sample: AgentSample | null): { paused_at: string; paused_by: { id: string; name: string } } | null {
  if (sample !== 'workspace-paused') return null;
  return { paused_at: iso(0, 2), paused_by: { id: SARAH, name: member(SARAH)?.name ?? 'An Owner' } };
}

/** The context pack (AGENTS.md) a demo agent reads, in the shape the real one takes. */
export function demoAgentContext(agentId: string): string {
  const detail = demoAgentDetail(agentId);
  if (!detail) return '';
  const lines = [
    `# ${detail.agent.name}`,
    '',
    detail.agent.description ?? '',
    '',
    '## Rules',
    '- Picks up unassigned work',
    '- Closes its own tasks',
    '- New tasks go live',
    `- Escalates to its owners (${detail.owners.map((o) => o.name).join(', ')})`,
    '',
    '## Limits',
    `- Budget: $${detail.limits?.budget_usd} every month (UTC).`,
    '',
    '## Projects',
  ];
  for (const a of detail.projects) {
    lines.push('', `### ${a.project_name}${a.status === 'paused' ? ' (paused)' : ''}`);
    for (const field of a.settings_schema) lines.push(`- ${field.label}: ${String(a.settings[field.key] ?? field.default ?? '')}`);
    if (a.instructions) lines.push('', a.instructions);
  }
  return lines.join('\n');
}

/** What a demo agent logged, newest first. */
export function demoAgentActivityFor(agentId: string): AgentActivity[] {
  return demoAgentActivity.filter((a) => a.agent_id === agentId).sort((a, b) => b.created_at.localeCompare(a.created_at));
}

