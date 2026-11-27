import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { loadAgentAccess, missingHierarchy } from './agent-access';
import { callerHolds, canManageAgent, type AgentCaller } from './agent-owners';
import { requireAgentsEnabled } from './agents';
import { ApiError, forbidden, notFound } from './errors';

/**
 * Reading and setting an agent's place in the chart and who can use it
 * (20261127001000_agent_hierarchy_access.sql): its orchestrator, the agents under
 * it, "Reachable directly", "Ask first" and its audience, with the limits
 * its orchestrators put on it in plain words. The session routes, v1 and MCP share
 * these. Reading takes team.read; changing takes managing the agent (an
 * Owner, team.manage, one of its owners) or agents.manage. An agent never
 * changes its own. The rules these settings enforce live in agent-access.ts.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read field by field
type Row = Record<string, any>;

export const AGENT_ORCHESTRATOR_MAX_LEVELS = 4;
export const AGENT_AUDIENCE_MAX = 100;
export const AUDIENCE_KINDS = ['everyone', 'role', 'group', 'member'] as const;
export const AUDIENCE_EFFECTS = ['include', 'exclude'] as const;
export const AUDIENCE_ROLES = ['owner', 'admin', 'member', 'guest'] as const;
export type AudienceKind = (typeof AUDIENCE_KINDS)[number];
export type AudienceEffect = (typeof AUDIENCE_EFFECTS)[number];

const ROLE_WORDS: Record<string, string> = { owner: 'Owners', admin: 'Admins', member: 'Members', guest: 'Guests' };

export const audienceEntrySchema = z.object({
  kind: z.enum(AUDIENCE_KINDS),
  /** Role key, group id or member id; left out for everyone. */
  ref: z.string().min(1).max(100).nullable().optional(),
  /** include (default) or exclude: an exclude always wins. */
  effect: z.enum(AUDIENCE_EFFECTS).optional(),
}).strict();
export type AudienceEntryInput = z.infer<typeof audienceEntrySchema>;

export const setAgentAccessSchema = z.object({
  /** The company agent it works under; null takes it out of the chart. */
  orchestrator_id: z.uuid('orchestrator_id must be an agent id').nullable().optional(),
  reachable_directly: z.boolean().optional(),
  ask_first: z.boolean().optional(),
  /**
   * "Ask a person directly": true sends its questions to people as
   * addressed; false (the default) sends them to its orchestrator first.
   */
  ask_people_directly: z.boolean().optional(),
  /** Replaces who can use it. An empty list: everyone who may otherwise give it work. */
  audience: z.array(audienceEntrySchema).max(AGENT_AUDIENCE_MAX).optional(),
}).strict().refine(
  (body) => ['orchestrator_id', 'reachable_directly', 'ask_first', 'ask_people_directly', 'audience'].some((key) => (body as Row)[key] !== undefined),
  'Send at least one of orchestrator_id, reachable_directly, ask_first, ask_people_directly or audience',
);
export type SetAgentAccess = z.infer<typeof setAgentAccessSchema>;

export interface AudienceView {
  kind: AudienceKind;
  ref: string | null;
  effect: AudienceEffect;
  /** What it names, in words: "Everyone", "Admins", a group's or a person's name. */
  name: string;
}

export interface AudienceSummary {
  /** False: no rows, everyone who may otherwise give it work. */
  limited: boolean;
  words: string;
}

/**
 * Who an audience lets in, in a few words: the one wording for every agent.
 * Pure. With no limit an agent at the top reads "Everyone"; under an
 * orchestrator, everyone means everyone who can use that orchestrator (a
 * person reaches an agent only through every orchestrator above it), so it
 * says so by name ("Everyone who can use Atlas").
 */
export function audienceWords(entries: Pick<AudienceView, 'kind' | 'effect' | 'name'>[], orchestratorName?: string | null): AudienceSummary {
  const anyone = orchestratorName ? `Everyone who can use ${orchestratorName}` : 'Everyone';
  if (entries.length === 0) return { limited: false, words: anyone };
  const includes = entries.filter((e) => e.effect === 'include');
  const excludes = entries.filter((e) => e.effect === 'exclude');
  if (excludes.some((e) => e.kind === 'everyone')) return { limited: true, words: 'No one' };
  const base = includes.length === 0 || includes.some((e) => e.kind === 'everyone') ? anyone : `${includes.map((e) => e.name).join(', ')} only`;
  return { limited: true, words: excludes.length ? `${base.replace(/ only$/, '')}, except ${excludes.map((e) => e.name).join(', ')}` : base };
}

const pending = () => new ApiError(503, 'SERVICE_UNAVAILABLE', 'Orchestrators and who can use an agent work once the database update 20261127001000_agent_hierarchy_access.sql is applied', { reason: 'migration_pending' });

/** Audience rows of many agents, named, oldest first. Empty on a database before the update. */
export async function audiencesOf(db: SupabaseClient, agentIds: string[]): Promise<Map<string, AudienceView[]>> {
  const out = new Map<string, AudienceView[]>();
  const ids = [...new Set(agentIds)];
  for (const id of ids) out.set(id, []);
  if (ids.length === 0) return out;
  const { data, error } = await db.from('agent_audience').select('agent_id, kind, ref, effect, created_at').in('agent_id', ids).order('created_at').order('id');
  if (error) {
    if (missingHierarchy(error)) return out;
    throw error;
  }
  const rows = (data ?? []) as Row[];
  const groupIds = [...new Set(rows.filter((r) => r.kind === 'group').map((r) => r.ref as string))];
  const memberIds = [...new Set(rows.filter((r) => r.kind === 'member').map((r) => r.ref as string))];
  const [groups, members] = await Promise.all([
    groupIds.length ? db.from('groups').select('id, name, deleted_at').in('id', groupIds).then(({ data: g }) => new Map(((g ?? []) as Row[]).map((r) => [r.id, r]))) : Promise.resolve(new Map<string, Row>()),
    memberIds.length ? db.from('team_members').select('id, name').in('id', memberIds).then(({ data: m }) => new Map(((m ?? []) as Row[]).map((r) => [r.id, r]))) : Promise.resolve(new Map<string, Row>()),
  ]);
  for (const row of rows) {
    const name = row.kind === 'everyone' ? 'Everyone'
      : row.kind === 'role' ? ROLE_WORDS[row.ref] ?? row.ref
      : row.kind === 'group' ? (groups.get(row.ref)?.deleted_at ? 'A group in Trash' : groups.get(row.ref)?.name ?? 'A group')
      : members.get(row.ref)?.name ?? 'Someone';
    out.get(row.agent_id)?.push({ kind: row.kind, ref: row.ref ?? null, effect: row.effect, name });
  }
  return out;
}

/** The audience summary of many agents (the list and the tree). */
export async function audienceSummaries(db: SupabaseClient, agentIds: string[]): Promise<Map<string, AudienceSummary>> {
  const [audiences, orchestrators] = await Promise.all([audiencesOf(db, agentIds), orchestratorNames(db, agentIds)]);
  return new Map([...audiences].map(([id, entries]) => [id, audienceWords(entries, orchestrators.get(id))]));
}

/** Each agent's orchestrator by name, for the ones that have one. Empty on a database before the update. */
async function orchestratorNames(db: SupabaseClient, agentIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(agentIds)];
  if (ids.length === 0) return out;
  const { data, error } = await db.from('team_members').select('id, orchestrator_id').in('id', ids).not('orchestrator_id', 'is', null);
  if (error) {
    if (missingHierarchy(error)) return out;
    throw error;
  }
  const rows = (data ?? []) as Row[];
  const above = [...new Set(rows.map((r) => r.orchestrator_id as string))];
  if (above.length === 0) return out;
  const { data: named, error: nameError } = await db.from('team_members').select('id, name').in('id', above);
  if (nameError) throw nameError;
  const names = new Map(((named ?? []) as Row[]).map((r) => [r.id as string, r.name as string]));
  for (const row of rows) {
    const name = names.get(row.orchestrator_id);
    if (name) out.set(row.id, name);
  }
  return out;
}

export interface AgentAccessView {
  agent_id: string;
  name: string;
  /** A personal agent: only its person uses it, and it is never in the chart. */
  personal: boolean;
  orchestrator_id: string | null;
  orchestrator: { id: string; name: string } | null;
  reachable_directly: boolean;
  ask_first: boolean;
  /** With an orchestrator: false (the default) sends its questions to the orchestrator first. */
  ask_people_directly: boolean;
  audience: AudienceView[];
  audience_summary: AudienceSummary;
  /** Orchestrators above it whose own audience limits who can use it, nearest first. */
  inherited: { agent_id: string; name: string; summary: AudienceSummary }[];
  /** The same in a sentence ("Limited by Dev orchestrator: Engineering only."), or null. */
  inherited_words: string | null;
  /** Active people who can use it now (its own audience and every orchestrator's). */
  people_count: number;
  people_words: string;
  /** The agents directly under it. */
  reports: { id: string; name: string; status: string }[];
  /** How many levels sit above it (0 at the top). */
  depth: number;
  max_levels: number;
  can_manage: boolean;
}

async function loadAgent(db: SupabaseClient, agentId: string) {
  const row = (await loadAgentAccess(db, [agentId])).get(agentId);
  if (!row) throw notFound('Agent');
  if (row.role !== 'agent') throw new ApiError(422, 'VALIDATION_ERROR', `${row.name} is not an agent`, { reason: 'agents_only' });
  return row;
}

/** Whether the caller may change an agent's access: managing it, or agents.manage. Never the agent itself. */
export async function canManageAgentAccess(db: SupabaseClient, caller: AgentCaller, agentId: string): Promise<boolean> {
  if (caller.memberId === agentId) return false;
  return callerHolds(caller, 'agents.manage') || canManageAgent(db, caller, agentId);
}

/** One agent's access as the screens and agents read it. */
export async function getAgentAccess(db: SupabaseClient, caller: AgentCaller, agentId: string): Promise<AgentAccessView> {
  requireAgentsEnabled(caller.access);
  const agent = await loadAgent(db, agentId);
  // Up the chart: its orchestrators, nearest first.
  const orchestrators: { id: string; name: string }[] = [];
  const seen = new Set<string>([agent.id]);
  for (let at = agent.orchestrator_id; at && !seen.has(at) && orchestrators.length < 8;) {
    const orchestrator = (await loadAgentAccess(db, [at])).get(at);
    if (!orchestrator) break;
    orchestrators.push({ id: orchestrator.id, name: orchestrator.name });
    seen.add(at);
    at = orchestrator.orchestrator_id;
  }
  const audiences = await audiencesOf(db, [agent.id, ...orchestrators.map((l) => l.id)]);
  const own = audiences.get(agent.id) ?? [];
  const inherited = orchestrators
    .filter((orchestrator) => (audiences.get(orchestrator.id) ?? []).length > 0)
    .map((orchestrator) => ({ agent_id: orchestrator.id, name: orchestrator.name, summary: audienceWords(audiences.get(orchestrator.id) ?? []) }));
  const [reports, count, canManage, askDirect] = await Promise.all([
    db.from('team_members').select('id, name, status').eq('orchestrator_id', agent.id).order('name')
      .then(({ data, error }) => {
        if (error && missingHierarchy(error)) return [] as Row[];
        if (error) throw error;
        return (data ?? []) as Row[];
      }),
    peopleWhoMayUse(db, agent.id),
    canManageAgentAccess(db, caller, agent.id),
    db.from('team_members').select('ask_people_directly').eq('id', agent.id).maybeSingle()
      .then(({ data, error }) => (error ? false : (data as Row | null)?.ask_people_directly === true)),
  ]);
  return {
    agent_id: agent.id,
    name: agent.name,
    personal: !!agent.delegate_of,
    orchestrator_id: agent.orchestrator_id,
    orchestrator: orchestrators[0] ?? null,
    reachable_directly: agent.reachable_directly,
    ask_first: agent.ask_first,
    ask_people_directly: askDirect,
    audience: own,
    audience_summary: agent.delegate_of ? { limited: true, words: 'Only its person' } : audienceWords(own, orchestrators[0]?.name),
    inherited,
    inherited_words: inherited.length ? `${inherited.map((l) => `Limited by ${l.name}: ${l.summary.words}`).join('. ')}.` : null,
    people_count: count,
    people_words: count === 1 ? '1 person can use it' : `${count} people can use it`,
    reports: reports.map((r) => ({ id: r.id, name: r.name, status: r.status ?? 'active' })),
    depth: orchestrators.length,
    max_levels: AGENT_ORCHESTRATOR_MAX_LEVELS,
    can_manage: canManage,
  };
}

/** How many active people may use the agent now (pm.agent_audience_members); every active person before the update. */
async function peopleWhoMayUse(db: SupabaseClient, agentId: string): Promise<number> {
  const { data, error } = await db.rpc('agent_audience_members', { p_agent: agentId });
  if (!error) return ((data ?? []) as unknown[]).length;
  if (!missingHierarchy(error)) throw error;
  const { count } = await db.from('team_members').select('id', { count: 'exact', head: true }).neq('role', 'agent').eq('status', 'active');
  return count ?? 0;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = (message: string, details: Record<string, unknown>) => new ApiError(422, 'VALIDATION_ERROR', message, details);

/** Checks an audience against the workspace: live groups, active people, one row per subject. */
async function checkAudience(db: SupabaseClient, entries: AudienceEntryInput[]): Promise<{ kind: AudienceKind; ref: string | null; effect: AudienceEffect }[]> {
  const out = new Map<string, { kind: AudienceKind; ref: string | null; effect: AudienceEffect }>();
  for (const [index, entry] of entries.entries()) {
    const ref = entry.kind === 'everyone' ? null : (entry.ref ?? '').trim();
    if (entry.kind === 'everyone' && entry.ref) throw invalid('An "everyone" entry names nothing: leave ref out', { reason: 'invalid_audience', index });
    if (entry.kind === 'role' && !(AUDIENCE_ROLES as readonly string[]).includes(ref ?? '')) {
      throw invalid(`A role entry names one of ${AUDIENCE_ROLES.join(', ')}`, { reason: 'invalid_audience', index });
    }
    if ((entry.kind === 'group' || entry.kind === 'member') && !UUID.test(ref ?? '')) {
      throw invalid(`A ${entry.kind} entry names its id in ref`, { reason: 'invalid_audience', index });
    }
    const key = `${entry.kind}:${(ref ?? '').toLowerCase()}`;
    if (out.has(key)) throw invalid('Each one appears once: as included or as excluded', { reason: 'duplicate_audience', index });
    out.set(key, { kind: entry.kind, ref: entry.kind === 'group' || entry.kind === 'member' ? (ref as string).toLowerCase() : ref, effect: entry.effect ?? 'include' });
  }
  const list = [...out.values()];
  const groupIds = list.filter((e) => e.kind === 'group').map((e) => e.ref as string);
  const memberIds = list.filter((e) => e.kind === 'member').map((e) => e.ref as string);
  if (groupIds.length) {
    const { data, error } = await db.from('groups').select('id').in('id', groupIds).is('deleted_at', null);
    if (error) throw error;
    const live = new Set(((data ?? []) as Row[]).map((r) => r.id));
    const missing = groupIds.filter((id) => !live.has(id));
    if (missing.length) throw invalid('Every group must be a live group', { reason: 'audience_group_not_found', group_ids: missing });
  }
  if (memberIds.length) {
    const { data, error } = await db.from('team_members').select('id, role, status').in('id', memberIds);
    if (error) throw error;
    const people = new Set(((data ?? []) as Row[]).filter((r) => r.role !== 'agent' && (r.status ?? 'active') === 'active').map((r) => r.id));
    const refused = memberIds.filter((id) => !people.has(id));
    if (refused.length) throw invalid('Every person named must be an active person (never an agent)', { reason: 'audience_member_not_person', member_ids: refused });
  }
  return list;
}

/** A database refusal of an orchestrator, in words. */
function orchestratorError(error: { code?: string; message?: string }): ApiError | null {
  const message = error.message ?? '';
  if (/agent_orchestrator_loop/.test(message)) return invalid('That orchestrator already works under this agent: the chart would loop.', { reason: 'orchestrator_loop' });
  if (/agent_orchestrator_too_deep/.test(message)) return invalid(`A chart of agents is at most ${AGENT_ORCHESTRATOR_MAX_LEVELS} levels deep.`, { reason: 'orchestrator_too_deep', max_levels: AGENT_ORCHESTRATOR_MAX_LEVELS });
  if (/agent_orchestrator_not_agent|agent_orchestrator_personal|agent_orchestrator_agents_only|team_members_orchestrator_not_self/.test(message)) {
    return invalid('An orchestrator is another company agent (never itself, never a personal assistant).', { reason: 'orchestrator_not_agent' });
  }
  return null;
}

/**
 * Sets an agent's orchestrator, flags and audience (each only when sent; the
 * audience replaces what it had). Moving it to a new orchestrator changes where new
 * work may come from; its tasks and runs stay as they are.
 */
export async function setAgentAccess(db: SupabaseClient, caller: AgentCaller, agentId: string, body: SetAgentAccess): Promise<AgentAccessView> {
  requireAgentsEnabled(caller.access);
  const agent = await loadAgent(db, agentId);
  if (caller.memberId === agentId) {
    throw forbidden('An agent never changes its own orchestrator or who can use it', { reason: 'own_access' });
  }
  if (!(await canManageAgentAccess(db, caller, agentId))) {
    throw forbidden('Only an Owner, a member with team.manage or agents.manage, or one of this agent\'s owners changes who can use it', {
      reason: 'not_agent_owner',
      hint: 'Ask an Owner or one of the agent\'s owners to make the change.',
    });
  }
  if (agent.delegate_of) {
    throw invalid('A personal assistant works only for its person: it has no orchestrator and no audience', { reason: 'personal_agent' });
  }
  const audience = body.audience !== undefined ? await checkAudience(db, body.audience) : undefined;
  if (body.orchestrator_id) {
    const orchestrator = (await loadAgentAccess(db, [body.orchestrator_id])).get(body.orchestrator_id);
    if (!orchestrator || orchestrator.role !== 'agent' || orchestrator.delegate_of || orchestrator.id === agentId) {
      throw invalid('An orchestrator is another company agent (never itself, never a personal assistant).', { reason: 'orchestrator_not_agent' });
    }
  }
  const changes: Row = {};
  if (body.orchestrator_id !== undefined) changes.orchestrator_id = body.orchestrator_id;
  if (body.reachable_directly !== undefined) changes.reachable_directly = body.reachable_directly;
  if (body.ask_first !== undefined) changes.ask_first = body.ask_first;
  if (body.ask_people_directly !== undefined) changes.ask_people_directly = body.ask_people_directly;
  if (Object.keys(changes).length) {
    const { error } = await db.from('team_members').update(changes).eq('id', agentId);
    if (error) {
      if (missingHierarchy(error) && !orchestratorError(error)) throw pending();
      throw orchestratorError(error) ?? error;
    }
  }
  if (audience !== undefined) await replaceAudience(db, agentId, audience, caller.memberId);
  return getAgentAccess(db, caller, agentId);
}

/**
 * Replaces an agent's audience rows with exactly these (already checked), in
 * one transaction (pm.replace_agent_audience): a failure leaves the old ones.
 */
export async function replaceAudience(db: SupabaseClient, agentId: string, entries: { kind: AudienceKind; ref: string | null; effect: AudienceEffect }[], createdBy: string | null): Promise<void> {
  const { error } = await db.rpc('replace_agent_audience', {
    p_agent: agentId,
    p_rows: entries.map((entry) => ({ kind: entry.kind, ref: entry.ref, effect: entry.effect })),
    p_created_by: createdBy,
  });
  if (error) {
    if (missingHierarchy(error) && !/check constraint|violates|agent_audience_/.test(error.message ?? '')) throw pending();
    throw error;
  }
}

/**
 * At hire, an agent from a template that starts with its managers only
 * (audience 'managers': code and money) gets one include row per owner and
 * owner group, or the Owners role when it has neither. Nothing for the rest.
 */
export async function writeManagersOnlyAudience(db: SupabaseClient, agentId: string, ownerIds: string[], ownerGroupIds: string[], createdBy: string | null): Promise<void> {
  const entries: { kind: AudienceKind; ref: string | null; effect: AudienceEffect }[] = [
    ...[...new Set(ownerIds)].map((id) => ({ kind: 'member' as const, ref: id, effect: 'include' as const })),
    ...[...new Set(ownerGroupIds)].map((id) => ({ kind: 'group' as const, ref: id, effect: 'include' as const })),
  ];
  if (entries.length === 0) entries.push({ kind: 'role', ref: 'owner', effect: 'include' });
  try {
    await replaceAudience(db, agentId, entries, createdBy);
  } catch (error) {
    // Before the update there is nowhere to write it: the agent keeps today's behaviour.
    if (error instanceof ApiError && error.statusCode === 503) return;
    throw error;
  }
}

export interface AgentTreeNode {
  id: string;
  name: string;
  title: string | null;
  avatar_url: string | null;
  status: string;
  orchestrator_id: string | null;
  /** Levels above it (0 at the top). */
  depth: number;
  reachable_directly: boolean;
  ask_first: boolean;
  audience_summary: AudienceSummary;
  report_ids: string[];
}

/** The chart of company agents, top orchestrators first, each followed by the agents under it. Personal agents are left out. */
export async function agentTree(db: SupabaseClient, caller: AgentCaller): Promise<{ agents: AgentTreeNode[]; max_levels: number }> {
  requireAgentsEnabled(caller.access);
  const read = (columns: string) => db.from('team_members').select(columns).eq('role', 'agent').is('delegate_of', null).order('name');
  let { data, error } = await read('id, name, title, avatar, status, orchestrator_id, reachable_directly, ask_first');
  let before = false;
  if (error && missingHierarchy(error)) {
    before = true;
    ({ data, error } = await read('id, name, title, avatar, status'));
  }
  if (error) throw error;
  const rows = (data ?? []) as Row[];
  const summaries = before ? new Map<string, AudienceSummary>() : await audienceSummaries(db, rows.map((r) => r.id));
  const byId = new Map(rows.map((r) => [r.id as string, r]));
  const children = new Map<string, Row[]>();
  for (const row of rows) {
    const orchestrator = row.orchestrator_id && byId.has(row.orchestrator_id) ? row.orchestrator_id : null;
    const list = children.get(orchestrator ?? '') ?? [];
    list.push(row);
    children.set(orchestrator ?? '', list);
  }
  const out: AgentTreeNode[] = [];
  const visit = (row: Row, depth: number) => {
    if (out.some((n) => n.id === row.id) || depth > 8) return;
    const reports = children.get(row.id) ?? [];
    out.push({
      id: row.id, name: row.name, title: row.title ?? null, avatar_url: row.avatar || null, status: row.status ?? 'active',
      orchestrator_id: row.orchestrator_id ?? null, depth,
      reachable_directly: row.reachable_directly !== false, ask_first: row.ask_first === true,
      audience_summary: summaries.get(row.id) ?? audienceWords([]),
      report_ids: reports.map((r) => r.id as string),
    });
    for (const report of reports) visit(report, depth + 1);
  };
  for (const root of children.get('') ?? []) visit(root, 0);
  return { agents: out, max_levels: AGENT_ORCHESTRATOR_MAX_LEVELS };
}
