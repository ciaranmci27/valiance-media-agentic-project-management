'use client';

import { useEffect, useMemo, useState } from 'react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { hasPermission } from '@/lib/access-control';
import { useRead } from '@/lib/query-cache';
import { mySnoozesRead, useOpenQuestions } from '@/lib/reads';
import { computeNeedsYou, type NeedsYouItem } from '@/lib/autonomy';
import { buildAgentNeedsYou, type AgentNeedsYou } from '@/lib/agents-tab';
import { activeSnoozes, agentNeedsYouWithoutSnoozed, needsYouWithoutSnoozed, nextSnoozeWake, type Snooze } from '@/lib/notifications';

export interface NeedsYou {
  /** What waits on the signed-in person (computeNeedsYou), without what they snoozed. */
  items: NeedsYouItem[];
  /** items.length: the count every badge shows for it. */
  count: number;
  /** The agents' slice of the same answer, as the Agents home lists it (questions, blocks, reviews, suggestions). */
  agents: AgentNeedsYou;
  /** The person's snoozes still in force. */
  snoozes: Snooze[];
}

const NO_SNOOZES: Snooze[] = [];
/** setTimeout's ceiling; a later wake re-arms when this one fires. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Needs you for the signed-in person: the one hook the sidebar badges, My
 * Tasks, the Agents home and the notifications page read, so every count of
 * the same thing is the same number. computeNeedsYou stays the one
 * definition; this adds only the person's snoozes, applied at read time,
 * with a timer to the next one's end so a snoozed item comes back on its
 * own (no polling, no job).
 */
export function useNeedsYou(): NeedsYou {
  const { tasks, taskSuggestions, projects, team, agentActivity } = useApp();
  const { teamMemberId, access } = useAuth();
  const { isDemoMode } = useDemo();
  const questions = useOpenQuestions();
  const snoozes = useRead(teamMemberId ? mySnoozesRead(isDemoMode) : null).data ?? NO_SNOOZES;
  const oversight = hasPermission(access, 'agents.manage');

  // The moment snoozes are judged at; moved on when the next one wakes.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const wake = nextSnoozeWake(snoozes, now);
    if (wake === null) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(MAX_TIMER_MS, Math.max(0, wake - Date.now()) + 50));
    return () => window.clearTimeout(timer);
  }, [snoozes, now]);

  const all = useMemo(() => computeNeedsYou({
    tasks,
    suggestions: taskSuggestions,
    projects,
    teamMemberId: teamMemberId || null,
    includeSuggestions: false,
    oversight,
    agentActivity,
    questions,
  }), [tasks, taskSuggestions, projects, teamMemberId, oversight, agentActivity, questions]);

  return useMemo(() => {
    const hidden = activeSnoozes(snoozes, now);
    const items = needsYouWithoutSnoozed(all, hidden);
    const agents = agentNeedsYouWithoutSnoozed(
      buildAgentNeedsYou({ needsYou: all, tasks, team, suggestions: taskSuggestions, projects }),
      hidden,
    );
    return { items, count: items.length, agents, snoozes };
  }, [all, snoozes, now, tasks, team, taskSuggestions, projects]);
}
