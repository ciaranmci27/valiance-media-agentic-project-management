import type { AgentAccessView, AgentTreeNode } from '@/lib/api/agent-hierarchy';
import type { AgentPowersView } from '@/lib/api/agent-powers';
import { mergedPowers, powersOutOfStep } from '@/lib/agent-access-ui';
import { demoAgentDetail } from '@/lib/demo-agent-profile';
import { demoTeam } from '@/lib/demo-data';

/**
 * An agent's Access tab in demo mode, from the demo team: Scout works for
 * Atlas (the top of the chart), Atlas is for its managers only, so Scout
 * shows the limit it inherits; Scout's key and its powers are out of step,
 * so Save has something to line up. Nothing here is saved.
 */

const SARAH = 'a1a1a1a1-0001-4000-8000-000000000001';
const MARCUS = 'a1a1a1a1-0002-4000-8000-000000000002';
const JAKE = 'a1a1a1a1-0004-4000-8000-000000000004';
const ATLAS = 'a1a1a1a1-0006-4000-8000-000000000006';
const SCOUT = 'a1a1a1a1-0007-4000-8000-000000000007';

const nameOf = (id: string) => demoTeam.find((m) => m.id === id)?.name ?? 'Someone';
const people = demoTeam.filter((m) => m.role !== 'agent');

/** Powers given in Team, beyond what a key shows (Scout: Act for a person, the trigger of critique H2). */
const GIVEN: Record<string, string[]> = { [SCOUT]: ['agents.act_for'] };

export function demoAgentTree(): { agents: AgentTreeNode[]; max_levels: number } {
  const node = (id: string, orchestrator: string | null, depth: number, reports: string[], words: string, limited: boolean): AgentTreeNode => ({
    id, name: nameOf(id), title: demoAgentDetail(id)?.agent.title ?? null, avatar_url: null, status: 'active', orchestrator_id: orchestrator, depth,
    reachable_directly: true, ask_first: false, audience_summary: { limited, words }, report_ids: reports,
  });
  return {
    agents: [
      node(ATLAS, null, 0, [SCOUT], `${nameOf(SARAH)}, ${nameOf(MARCUS)} only`, true),
      node(SCOUT, ATLAS, 1, [], `Everyone who can use ${nameOf(ATLAS)}, except ${nameOf(JAKE)}`, true),
    ],
    max_levels: 4,
  };
}

export function demoAgentAccess(agentId: string): AgentAccessView | null {
  const detail = demoAgentDetail(agentId);
  if (!detail) return null;
  const atlasAudience = [
    { kind: 'member' as const, ref: SARAH, effect: 'include' as const, name: nameOf(SARAH) },
    { kind: 'member' as const, ref: MARCUS, effect: 'include' as const, name: nameOf(MARCUS) },
  ];
  if (agentId === ATLAS) {
    return {
      agent_id: ATLAS, name: nameOf(ATLAS), personal: false, orchestrator_id: null, orchestrator: null, reachable_directly: true, ask_first: false, ask_people_directly: false,
      audience: atlasAudience, audience_summary: { limited: true, words: `${nameOf(SARAH)}, ${nameOf(MARCUS)} only` },
      inherited: [], inherited_words: null, people_count: 2, people_words: '2 people can use it',
      reports: [{ id: SCOUT, name: nameOf(SCOUT), status: 'active' }], depth: 0, max_levels: 4, can_manage: true,
    };
  }
  return {
    agent_id: agentId, name: detail.agent.name, personal: false, orchestrator_id: ATLAS, orchestrator: { id: ATLAS, name: nameOf(ATLAS) },
    reachable_directly: true, ask_first: false, ask_people_directly: false,
    audience: [{ kind: 'member', ref: JAKE, effect: 'exclude', name: nameOf(JAKE) }],
    audience_summary: { limited: true, words: `Everyone who can use ${nameOf(ATLAS)}, except ${nameOf(JAKE)}` },
    inherited: [{ agent_id: ATLAS, name: nameOf(ATLAS), summary: { limited: true, words: `${nameOf(SARAH)}, ${nameOf(MARCUS)} only` } }],
    inherited_words: `Limited by ${nameOf(ATLAS)}: ${nameOf(SARAH)}, ${nameOf(MARCUS)} only.`,
    people_count: Math.min(2, people.length), people_words: '2 people can use it',
    reports: [], depth: 1, max_levels: 4, can_manage: true,
  };
}

export function demoAgentPowers(agentId: string): AgentPowersView | null {
  const detail = demoAgentDetail(agentId);
  if (!detail) return null;
  const now = Date.now();
  const keys = (detail.keys ?? []).map((key) => ({ ...key, key_prefix: key.prefix }));
  const given = GIVEN[agentId] ?? [];
  const live = keys.filter((key) => !key.revoked_at && !key.disabled_at && (!key.expires_at || new Date(key.expires_at).getTime() > now));
  return {
    agent_id: agentId,
    name: detail.agent.name,
    personal: false,
    scopes: mergedPowers(live, given, now),
    held: [...new Set([...(detail.key_scopes_available ?? []), ...given])],
    given,
    live_keys: live.map((key) => ({ id: key.id, name: key.name, scopes: key.scopes })),
    out_of_step: powersOutOfStep(live, given, now),
    can_edit: live.length > 0,
    can_give_beyond_role: true,
  };
}
