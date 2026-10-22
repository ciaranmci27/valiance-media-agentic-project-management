'use client';

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useApp } from '@/lib/store';
import { useDemo } from '@/lib/demo-context';
import { fetchAgentActivity, fetchProjectTeamActivity } from '@/lib/supabase/queries';
import type { AgentActivity, TeamActivity } from '@/lib/types';

const AGENTS_ENABLED = process.env.NEXT_PUBLIC_ENABLE_AGENTS === 'true';

/**
 * One project's team and agent activity, read for that project alone: the
 * store's feeds are the newest rows across every project, so a quiet project
 * could find none of its own there. Refetches whenever live sync refreshes
 * either log in the store.
 */
export function useProjectActivity(projectId: string) {
  const { activities, agentActivity } = useApp();
  const { isDemoMode } = useDemo();
  const [team, setTeam] = useState<TeamActivity[]>([]);
  const [agent, setAgent] = useState<AgentActivity[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  // Demo mode has no database: the store's sample rows are the source.
  const demo = useMemo(() => isDemoMode ? {
    team: activities.filter((row) => row.project_id === projectId),
    agent: agentActivity.filter((row) => row.project_id === projectId),
  } : null, [isDemoMode, activities, agentActivity, projectId]);

  useEffect(() => {
    if (isDemoMode) return;
    let cancelled = false;
    const supabase = createClient();
    Promise.all([
      fetchProjectTeamActivity(supabase, projectId),
      AGENTS_ENABLED ? fetchAgentActivity(supabase, { project_id: projectId }) : Promise.resolve([] as AgentActivity[]),
    ])
      .then(([teamRows, agentRows]) => {
        if (cancelled) return;
        setTeam(teamRows);
        setAgent(agentRows);
        setFailed(false);
        setLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setFailed(true);
        setLoaded(true);
      });
    return () => { cancelled = true; };
  }, [projectId, isDemoMode, activities, agentActivity]);

  if (demo) return { team: demo.team, agent: demo.agent, loaded: true, failed: false, agentsEnabled: AGENTS_ENABLED };
  return { team, agent, loaded, failed, agentsEnabled: AGENTS_ENABLED };
}
