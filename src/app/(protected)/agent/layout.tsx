'use client';

import { Bot } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { hasPermission } from '@/lib/access-control';

/**
 * One gate for the whole /agent segment — the dashboard, the live floor, and
 * the per-project agent views.
 *
 * This check used to live inline in `agent/page.tsx` only, which meant every
 * new leaf under /agent started life ungated and had to remember to copy it.
 * A layout is the one place that can't be forgotten, and it keeps the two
 * conditions (feature flag, permission) defined once rather than drifting
 * between copies.
 */
export default function AgentLayout({ children }: { children: React.ReactNode }) {
  const { access } = useAuth();

  const isAgentsEnabled = process.env.NEXT_PUBLIC_ENABLE_AGENTS === 'true';
  const canManageAgents = hasPermission(access, 'agents.manage');

  if (!isAgentsEnabled || !canManageAgents) {
    return (
      <div className="animate-fadeIn min-h-screen flex items-center justify-center">
        <div className="text-center">
          <Bot className="mx-auto mb-3 text-zinc-500" size={40} aria-hidden="true" />
          <h3 className="font-medium text-zinc-300 mb-1">Not Available</h3>
          <p className="text-sm text-zinc-400">Agentic workflows are not enabled or you lack permissions.</p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
