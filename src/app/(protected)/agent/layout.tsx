'use client';

import { usePathname } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { hasPermission } from '@/lib/access-control';
import { useRead } from '@/lib/query-cache';
import { agentDetailRead } from '@/lib/reads';
import { agentProfileAccess, agentProfileIdFrom } from '@/lib/agents-ui';
import { ModulePage, NoAccessState } from '@/components/modules/ModuleGate';

/**
 * One gate for the whole /agent segment: the dashboard, analytics, and
 * the per-project agent views. A layout is the one place a new leaf under
 * /agent can't forget: the AI agents module must be on and the person must
 * manage agents. One exception: an agent's profile (/agent/<id>) also opens
 * for that agent's owners, in person or through a group (agentProfileAccess).
 */
export default function AgentLayout({ children }: { children: React.ReactNode }) {
  const profileId = agentProfileIdFrom(usePathname());
  if (profileId) return <ModulePage module="agents"><ProfileGate agentId={profileId}>{children}</ProfileGate></ModulePage>;
  return <ModulePage module="agents" anyOf={['agents.manage']}>{children}</ModulePage>;
}

/** agents.manage opens it at once; anyone else waits on the profile read's is_owner. */
function ProfileGate({ agentId, children }: { agentId: string; children: React.ReactNode }) {
  const { access } = useAuth();
  const { isDemoMode } = useDemo();
  const manageAgents = hasPermission(access, 'agents.manage');
  // The same cached read the profile shows, so an owner's page loads once.
  const detail = useRead(manageAgents || isDemoMode ? null : agentDetailRead(agentId));
  if (manageAgents) return <>{children}</>;
  if (!isDemoMode && detail.loading) return null;
  return agentProfileAccess({ manageAgents, isOwner: detail.data?.is_owner }) ? <>{children}</> : <NoAccessState module="agents" />;
}
