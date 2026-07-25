'use client';

import { useState } from 'react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { hasPermission } from '@/lib/access-control';
import { Header } from '@/components/layout/Header';
import { ReviewQueue } from '@/components/agent/ReviewQueue';
import { AutonomousProjects } from '@/components/agent/AutonomousProjects';
import { ActivityTimeline } from '@/components/agent/ActivityTimeline';
import { ApproveModal } from '@/components/agent/ApproveModal';
import { EditSuggestionModal } from '@/components/agent/EditSuggestionModal';
import { Bot } from 'lucide-react';
import { toast } from '@/components/ui/Toast';

export default function AgentPage() {
  const {
    taskSuggestions,
    approveSuggestion, updateSuggestion,
  } = useApp();
  const { access, teamMemberId } = useAuth();
  const [approveModalId, setApproveModalId] = useState<string | null>(null);
  const [editModalId, setEditModalId] = useState<string | null>(null);

  const isAgentsEnabled = process.env.NEXT_PUBLIC_ENABLE_AGENTS === 'true';
  const canManageAgents = hasPermission(access, 'agents.manage');

  if (!isAgentsEnabled || !canManageAgents) {
    return (
      <div className="animate-fadeIn min-h-screen flex items-center justify-center">
        <div className="text-center">
          <Bot className="mx-auto mb-3 text-zinc-500" size={40} />
          <h3 className="font-medium text-zinc-300 mb-1">Not Available</h3>
          <p className="text-sm text-zinc-400">Agentic workflows are not enabled or you lack permissions.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="animate-fadeIn min-h-screen lg:h-screen bg-white/[0.03] lg:flex lg:flex-col lg:overflow-hidden">
      <div className="lg:flex-shrink-0">
        <Header
          title="Agent Dashboard"
        />
      </div>

      <div className="p-4 lg:p-6 lg:flex-1 lg:min-h-0 lg:flex lg:flex-col lg:overflow-hidden">
        {/* Main Content: Review Queue + Sidebar */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 lg:gap-6 lg:flex-1 lg:min-h-0">
          {/* Review Queue - takes 2/3, fills grid row height */}
          <div className="lg:col-span-2 lg:min-h-0">
            <ReviewQueue
              onApprove={(id) => setApproveModalId(id)}
              onEdit={(id) => setEditModalId(id)}
            />
          </div>

          {/* Sidebar - takes 1/3, stretches to match review queue */}
          <div className="space-y-4 lg:space-y-0 lg:min-h-0 lg:flex lg:flex-col lg:gap-6">
            <AutonomousProjects />
            <div className="lg:flex-1 lg:min-h-0 lg:flex lg:flex-col">
              <ActivityTimeline />
            </div>
          </div>
        </div>
      </div>

      {/* Approve Modal */}
      {approveModalId && taskSuggestions.find(s => s.id === approveModalId) && (
        <ApproveModal
          suggestion={taskSuggestions.find(s => s.id === approveModalId)!}
          onClose={() => setApproveModalId(null)}
          onApprove={async (overrides) => {
            setApproveModalId(null);
            const ok = await approveSuggestion(approveModalId, overrides, teamMemberId || '');
            if (ok) toast('success', 'Suggestion approved, task created');
          }}
          onApproveManual={async (overrides) => {
            setApproveModalId(null);
            const ok = await approveSuggestion(approveModalId, { ...overrides, ai_managed: false }, teamMemberId || '');
            if (ok) toast('success', 'Suggestion approved as manual task');
          }}
        />
      )}

      {/* Edit Suggestion Modal */}
      {editModalId && taskSuggestions.find(s => s.id === editModalId) && (
        <EditSuggestionModal
          suggestion={taskSuggestions.find(s => s.id === editModalId)!}
          onClose={() => setEditModalId(null)}
          onSave={(updates) => {
            updateSuggestion(editModalId, updates);
            setEditModalId(null);
            toast('success', 'Suggestion updated');
          }}
        />
      )}
    </div>
  );
}
