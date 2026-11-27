'use client';

import { useMemo } from 'react';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { hasPermission, isModuleEnabled } from '@/lib/access-control';
import { useRead } from '@/lib/query-cache';
import { myAssistantActivityRead, myAssistantRead } from '@/lib/reads';
import { useNeedsYou } from '@/lib/use-needs-you';
import type { AgentNeedsYou } from '@/lib/agents-tab';
import type { AssistantDraft, MyAssistantView } from '@/lib/assistant';
import {
  aiHomeAccess, companyHubItems, hubCount, hubOrder, myHubItems, myNeeds,
  type AiHomeAccess, type HubItem,
} from '@/lib/ai-home';

export interface AiHub {
  access: AiHomeAccess;
  /** The person's assistant view (label, on or off, their assistant); null until it loads or when it does not apply. */
  assistant: MyAssistantView | null;
  /** Company AI's Needs you: the Agents Needs you answer (questions, approvals, stuck work, reviews, suggestions). */
  company: { needs: AgentNeedsYou; items: HubItem[] };
  /** Your assistant's Needs you: what waits on this person. */
  mine: { needs: AgentNeedsYou; drafts: AssistantDraft[]; items: HubItem[] };
  /** Both lists as one, each thing once, in hub order: what Notifications lists as Needs you and the bell counts. */
  all: HubItem[];
  /** The sidebar's count: both lists, each thing once. */
  count: number;
}

const NO_DRAFTS: AssistantDraft[] = [];

/**
 * The AI home's one read model: who sees which part, and what agents wait on
 * the person for. Built on useNeedsYou (the one Needs you definition the
 * sidebar, My Tasks and notifications share; agents' blocked comments are
 * part of it) plus the person's assistant's reply drafts, so the sidebar's
 * AI badge, the bell, the tabs' counts and the lists are the same numbers.
 */
export function useAiHub(): AiHub {
  const { access, teamMemberId } = useAuth();
  const { isDemoMode } = useDemo();
  const needsYou = useNeedsYou();
  const agentsOn = isModuleEnabled(access, 'agents');
  const person = !!access?.role && access.role !== 'agent';
  const assistant = useRead(agentsOn && person && teamMemberId ? myAssistantRead(isDemoMode) : null).data ?? null;
  const assistantsOn = !!assistant?.agents_on && !!assistant.enabled;
  const myAssistantId = assistantsOn ? assistant?.assistant?.id ?? null : null;
  const activity = useRead(myAssistantId ? myAssistantActivityRead(isDemoMode) : null).data;
  const drafts = activity?.drafts ?? NO_DRAFTS;

  const homeAccess = useMemo(() => aiHomeAccess({
    role: access?.role,
    agentsOn,
    assistantsOn,
    manageAgents: hasPermission(access, 'agents.manage'),
  }), [access, agentsOn, assistantsOn]);

  return useMemo(() => {
    const me = teamMemberId || null;
    const companyItems = homeAccess.company ? companyHubItems(needsYou.agents) : [];
    const mineItems = homeAccess.assistant ? myHubItems({ needs: needsYou.agents, drafts, me, myAssistantId }) : [];
    const byKey = new Map([...companyItems, ...mineItems].map((item) => [item.key, item]));
    return {
      access: homeAccess,
      assistant,
      company: { needs: needsYou.agents, items: companyItems },
      mine: { needs: myNeeds(needsYou.agents, me, myAssistantId), drafts, items: mineItems },
      all: hubOrder([...byKey.values()]),
      count: hubCount(companyItems, mineItems),
    };
  }, [homeAccess, teamMemberId, needsYou.agents, drafts, myAssistantId, assistant]);
}
