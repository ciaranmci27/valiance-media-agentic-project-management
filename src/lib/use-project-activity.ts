'use client';

import { useMemo } from 'react';
import { useApp } from '@/lib/store';
import { useDemo } from '@/lib/demo-context';
import { useRead } from '@/lib/query-cache';
import { projectActivityRead } from '@/lib/reads';

const AGENTS_ENABLED = process.env.NEXT_PUBLIC_ENABLE_AGENTS === 'true';

/**
 * One project's team and agent activity: a cached read (reads.ts), warmed
 * before the project opens and refreshed when either log changes, so the
 * Overview paints it on arrival instead of loading it.
 */
export function useProjectActivity(projectId: string) {
  const { activities, agentActivity } = useApp();
  const { isDemoMode } = useDemo();
  const read = useRead(isDemoMode ? null : projectActivityRead(projectId));

  // Demo mode has no database: the store's sample rows are the source.
  const demo = useMemo(() => isDemoMode ? {
    team: activities.filter((row) => row.project_id === projectId),
    agent: agentActivity.filter((row) => row.project_id === projectId),
  } : null, [isDemoMode, activities, agentActivity, projectId]);

  if (demo) return { team: demo.team, agent: demo.agent, loaded: true, failed: false, agentsEnabled: AGENTS_ENABLED };
  return {
    team: read.data?.team ?? [],
    agent: read.data?.agent ?? [],
    loaded: !read.loading,
    failed: read.failed,
    agentsEnabled: AGENTS_ENABLED,
  };
}
