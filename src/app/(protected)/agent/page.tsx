'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { Header } from '@/components/layout/Header';
import { FleetStatusStrip } from '@/components/agent/FleetStatusStrip';
import { ReviewQueue } from '@/components/agent/ReviewQueue';
import { AutonomousProjects } from '@/components/agent/AutonomousProjects';
import { ActivityTimeline } from '@/components/agent/ActivityTimeline';
import { ApproveModal } from '@/components/agent/ApproveModal';
import { EditSuggestionModal } from '@/components/agent/EditSuggestionModal';
import { Radio } from 'lucide-react';
import { toast } from '@/components/ui/Toast';

export default function AgentPage() {
  const {
    taskSuggestions,
    approveSuggestion, updateSuggestion,
  } = useApp();
  const { teamMemberId } = useAuth();
  const [approveModalId, setApproveModalId] = useState<string | null>(null);
  const [editModalId, setEditModalId] = useState<string | null>(null);

  // The agents feature flag and `agents.manage` check live in this segment's
  // layout, which covers every route under /agent rather than this page alone.

  return (
    <div className="animate-fadeIn min-h-screen lg:h-screen lg:flex lg:flex-col lg:overflow-hidden">
      <div className="lg:flex-shrink-0">
        <Header
          title="Agent Dashboard"
          subtitle="Fleet status, pending reviews, and what your crew is working on."
          actions={
            <Link
              href="/agent/live"
              className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-zinc-300 transition-colors hover:bg-white/[0.08] hover:text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-400 focus-visible:outline-offset-2"
            >
              <Radio size={14} className="text-brand-300" aria-hidden="true" />
              Live floor
            </Link>
          }
        />
      </div>

      <div className="p-4 lg:p-6 lg:flex-1 lg:min-h-0 lg:flex lg:flex-col lg:overflow-hidden lg:gap-6 space-y-4 lg:space-y-0">
        {/* Fleet heartbeat: who is alive, what they are doing, what fires next */}
        <div className="lg:flex-shrink-0">
          <FleetStatusStrip />
        </div>

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
