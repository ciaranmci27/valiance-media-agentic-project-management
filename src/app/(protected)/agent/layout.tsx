'use client';

import { ModulePage } from '@/components/modules/ModuleGate';

/**
 * One gate for the whole /agent segment: the dashboard, analytics, and
 * the per-project agent views. A layout is the one place a new leaf under
 * /agent can't forget: the AI agents module must be on and the person must
 * manage agents.
 */
export default function AgentLayout({ children }: { children: React.ReactNode }) {
  return <ModulePage module="agents" anyOf={['agents.manage']}>{children}</ModulePage>;
}
