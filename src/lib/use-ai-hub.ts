'use client';

import { useMemo } from 'react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { hasPermission, isModuleEnabled } from '@/lib/access-control';
import { useRead } from '@/lib/query-cache';
import { myAssistantActivityRead, myAssistantRead } from '@/lib/reads';
import { useNeedsYou } from '@/lib/use-needs-you';
import type { AgentNeedsYou } from '@/lib/agents-tab';
import type { AssistantDraft, MyAssistantView } from '@/lib/assistant';
import {
  aiHomeAccess, blockedComments, companyHubItems, hubCount, myBlockedComments, myHubItems, myNeeds,
  type AiHomeAccess, type BlockedCommentItem, type HubItem,
} from '@/lib/ai-home';

export interface AiHub {
  access: AiHomeAccess;
  /** The person's assistant view (label, on or off, their assistant); null until it loads or when it does not apply. */
  assistant: MyAssistantView | null;
  /** Company AI's Needs you: the Agents Needs you answer (questions, approvals, stuck work, reviews, suggestions). */
  company: { needs: AgentNeedsYou; comments: BlockedCommentItem[]; items: HubItem[] };
  /** Your assistant's Needs you: what waits on this person. */
  mine: { needs: AgentNeedsYou; comments: BlockedCommentItem[]; drafts: AssistantDraft[]; items: HubItem[] };
  /** The sidebar's count: both lists, each thing once. */
  count: number;
}

const NO_DRAFTS: AssistantDraft[] = [];

/**
 * The AI home's one read model: who sees which part, and what agents wait on
 * the person for. Built on useNeedsYou (the one Needs you definition the
 * sidebar, My Tasks and notifications share) plus agents' "[BLOCKED]"
 * comments and the person's assistant's reply drafts, so the sidebar's AI
 * badge, the tabs' counts and the lists are always the same numbers.
 */
export function useAiHub(): AiHub {
  const { tasks, team } = useApp();
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
    const comments = homeAccess.entry ? blockedComments(tasks, team) : [];
    const me = teamMemberId || null;
    const companyItems = homeAccess.company ? companyHubItems(needsYou.agents, comments) : [];
    const mineItems = homeAccess.assistant ? myHubItems({ needs: needsYou.agents, comments, drafts, me, myAssistantId }) : [];
    return {
      access: homeAccess,
      assistant,
      company: { needs: needsYou.agents, comments, items: companyItems },
      mine: {
        needs: myNeeds(needsYou.agents, me, myAssistantId),
        comments: myBlockedComments(comments, me, myAssistantId),
        drafts,
        items: mineItems,
      },
      count: hubCount(companyItems, mineItems),
    };
  }, [homeAccess, tasks, team, teamMemberId, needsYou.agents, drafts, myAssistantId, assistant]);
}
