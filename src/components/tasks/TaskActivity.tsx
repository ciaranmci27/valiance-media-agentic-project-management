'use client';

import { useMemo } from 'react';
import { useApp } from '@/lib/store';
import { useDemo } from '@/lib/demo-context';
import { useRead } from '@/lib/query-cache';
import { taskActivityRead } from '@/lib/reads';
import { ActivityTimeline } from '@/components/agent/ActivityTimeline';
import type { Task } from '@/lib/types';

/** How many entries the Activity section shows before "View all". */
const COLLAPSED = 3;

/** How many entries a task's history holds, for the section's heading. */
export function useTaskActivityCount(task: Task | null): number {
  const { team, agent } = useTaskActivity(task);
  return team.length + agent.length;
}

/**
 * One task's history (reads.ts): the team log without its comments (shown
 * above) and the agents' log. Demo mode reads the store's sample rows.
 */
function useTaskActivity(task: Task | null) {
  const { activities, agentActivity } = useApp();
  const { isDemoMode } = useDemo();
  const read = useRead(task && !isDemoMode ? taskActivityRead(task.id) : null);
  const demo = useMemo(() => (isDemoMode && task ? {
    team: activities.filter((row) => row.entity_type !== 'comment'
      && (row.entity_id === task.id || row.metadata?.task_id === task.id)),
    agent: agentActivity.filter((row) => row.reference_type === 'task' && row.reference_id === task.id),
  } : null), [isDemoMode, task, activities, agentActivity]);
  return {
    team: demo?.team ?? read.data?.team ?? [],
    agent: demo?.agent ?? read.data?.agent ?? [],
    loading: !demo && read.loading,
    failed: !demo && read.failed,
  };
}

/**
 * The task's Activity: who did what to it, people and agents, newest first.
 * Collapsed to the latest few; "View all" opens the rest. The caller's
 * section draws the heading.
 */
export function TaskActivity({ task }: { task: Task }) {
  const { team, agent, loading, failed } = useTaskActivity(task);
  return (
    <ActivityTimeline
      frame="none"
      projectId={task.project_id}
      taskTitle={task.title}
      teamEntries={team}
      agentEntries={agent}
      loading={loading}
      failed={failed}
      visible={COLLAPSED}
    />
  );
}
