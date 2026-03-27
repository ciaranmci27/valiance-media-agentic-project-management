'use client';

import { useState } from 'react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { Header } from '@/components/layout/Header';
import { ReviewQueue } from '@/components/agent/ReviewQueue';
import { AutonomousProjects } from '@/components/agent/AutonomousProjects';
import { ActivityTimeline } from '@/components/agent/ActivityTimeline';
import { ApproveModal } from '@/components/agent/ApproveModal';
import { EditSuggestionModal } from '@/components/agent/EditSuggestionModal';
import { Bot, Lightbulb, FolderKanban, Zap, CheckCircle2 } from 'lucide-react';
import { toast } from '@/components/ui/Toast';

export default function AgentPage() {
  const {
    team, taskSuggestions, projects, tasks,
    approveSuggestion, updateSuggestion,
  } = useApp();
  const { teamMemberId } = useAuth();
  const [approveModalId, setApproveModalId] = useState<string | null>(null);
  const [editModalId, setEditModalId] = useState<string | null>(null);

  const currentMember = team.find(m => m.id === teamMemberId);
  const isAgentsEnabled = process.env.NEXT_PUBLIC_ENABLE_AGENTS === 'true';
  const isAdmin = currentMember?.role === 'admin';

  if (!isAgentsEnabled || !isAdmin) {
    return (
      <div className="animate-fadeIn min-h-screen bg-zinc-50 flex items-center justify-center">
        <div className="text-center">
          <Bot className="mx-auto mb-3 text-zinc-400" size={40} />
          <h3 className="font-medium text-zinc-700 mb-1">Not Available</h3>
          <p className="text-sm text-zinc-500">Agentic workflows are not enabled or you lack permissions.</p>
        </div>
      </div>
    );
  }

  const autonomousProjects = projects.filter(p => p.autonomous_enabled && !p.archived_at);
  const pendingCount = taskSuggestions.filter(s => s.status === 'pending').length;
  const needsInfoCount = taskSuggestions.filter(s => s.status === 'needs_info').length;
  const activeProjectCount = autonomousProjects.length;

  // Tasks that are in progress on autonomous projects
  const autonomousProjectIds = new Set(autonomousProjects.map(p => p.id));
  const runningTasks = tasks.filter(
    t => autonomousProjectIds.has(t.project_id) && (t.status === 'in_progress' || t.status === 'in_review')
  ).length;

  // Completed tasks this week
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const completedThisWeek = tasks.filter(
    t => autonomousProjectIds.has(t.project_id) &&
      t.status === 'done' &&
      new Date(t.updated_at) >= weekAgo
  ).length;

  const stats = [
    {
      label: 'Pending Review',
      value: pendingCount + needsInfoCount,
      icon: Lightbulb,
      color: pendingCount > 0 ? 'text-amber-600' : 'text-zinc-400',
      bg: pendingCount > 0 ? 'bg-amber-50' : 'bg-zinc-50',
    },
    {
      label: 'Active Projects',
      value: activeProjectCount,
      icon: FolderKanban,
      color: 'text-brand-600',
      bg: 'bg-brand-50',
    },
    {
      label: 'Running Tasks',
      value: runningTasks,
      icon: Zap,
      color: runningTasks > 0 ? 'text-blue-600' : 'text-zinc-400',
      bg: runningTasks > 0 ? 'bg-blue-50' : 'bg-zinc-50',
    },
    {
      label: 'Done This Week',
      value: completedThisWeek,
      icon: CheckCircle2,
      color: completedThisWeek > 0 ? 'text-emerald-600' : 'text-zinc-400',
      bg: completedThisWeek > 0 ? 'bg-emerald-50' : 'bg-zinc-50',
    },
  ];

  return (
    <div className="animate-fadeIn min-h-screen lg:h-screen bg-zinc-50 lg:flex lg:flex-col lg:overflow-hidden">
      <div className="lg:flex-shrink-0">
        <Header
          title="Agent Dashboard"
        />
      </div>

      <div className="p-4 lg:p-6 space-y-4 lg:space-y-0 lg:flex-1 lg:min-h-0 lg:flex lg:flex-col lg:gap-6 lg:overflow-hidden">
        {/* Stats Row */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 lg:gap-4 lg:flex-shrink-0">
          {stats.map((stat) => (
            <div
              key={stat.label}
              className="bg-white rounded-xl border border-zinc-200 p-3 lg:p-5 hover:shadow-md transition-shadow"
            >
              <div className="flex items-center justify-between mb-2 lg:mb-3">
                <div className={`p-2 lg:p-2.5 rounded-lg ${stat.bg}`}>
                  <stat.icon className={stat.color} size={20} />
                </div>
              </div>
              <p className="text-xl lg:text-2xl font-bold text-zinc-900">{stat.value}</p>
              <p className="text-xs lg:text-sm text-zinc-500">{stat.label}</p>
            </div>
          ))}
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
          onApprove={(overrides) => {
            approveSuggestion(approveModalId, overrides, teamMemberId || '');
            setApproveModalId(null);
            toast('success', 'Suggestion approved, task created');
          }}
          onApproveManual={(overrides) => {
            approveSuggestion(approveModalId, { ...overrides, ai_managed: false }, teamMemberId || '');
            setApproveModalId(null);
            toast('success', 'Suggestion approved as manual task');
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
