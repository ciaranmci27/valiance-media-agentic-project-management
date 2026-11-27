import type { AgentAccessView, AgentTreeNode } from '@/lib/api/agent-hierarchy';
import type { AgentPowersView } from '@/lib/api/agent-powers';
import type { Read } from '@/lib/query-cache';
import { workspaceApi } from '@/lib/agent-workspace';
import { demoAgentAccess, demoAgentPowers, demoAgentTree } from '@/lib/demo-agent-access';

/**
 * The Access tab's reads (lib/query-cache.ts): who can use an agent and who
 * it works for, the chart of company agents (for the Works for picker), and
 * what it may do as one list. Demo mode reads lib/demo-agent-access.ts.
 */

export function agentAccessRead(agentId: string, isDemo = false): Read<AgentAccessView> {
  return {
    key: `agent-access:${isDemo ? 'demo:' : ''}${agentId}`,
    tables: ['team_members', 'agent_audience', 'agent_owners', 'groups', 'group_members'],
    load: async () => {
      if (!isDemo) return workspaceApi<AgentAccessView>(`/api/workspace/agents/${encodeURIComponent(agentId)}/access`);
      const access = demoAgentAccess(agentId);
      if (!access) throw new Error('No such agent');
      return access;
    },
  };
}

export function agentTreeRead(isDemo = false): Read<{ agents: AgentTreeNode[]; max_levels: number }> {
  return {
    key: `agent-tree${isDemo ? ':demo' : ''}`,
    tables: ['team_members', 'agent_audience'],
    load: async () => (isDemo ? demoAgentTree() : workspaceApi<{ agents: AgentTreeNode[]; max_levels: number }>('/api/workspace/agents/tree')),
  };
}

export function agentPowersRead(agentId: string, isDemo = false): Read<AgentPowersView> {
  return {
    key: `agent-powers:${isDemo ? 'demo:' : ''}${agentId}`,
    tables: ['api_keys', 'team_member_permissions', 'role_permissions'],
    load: async () => {
      if (!isDemo) return workspaceApi<AgentPowersView>(`/api/workspace/agents/${encodeURIComponent(agentId)}/powers`);
      const powers = demoAgentPowers(agentId);
      if (!powers) throw new Error('No such agent');
      return powers;
    },
  };
}
