'use client';

import { useMemo } from 'react';
import { useApp } from '@/lib/store';
import { Avatar } from '@/components/ui/Avatar';
import {
  Activity, Lightbulb, PlayCircle, CheckCircle2, XCircle,
  Search, MessageSquare, RefreshCw, Zap,
} from 'lucide-react';

const activityIcons: Record<string, any> = {
  suggestion_created: Lightbulb,
  task_started: PlayCircle,
  task_completed: CheckCircle2,
  task_failed: XCircle,
  research_completed: Search,
  comment_added: MessageSquare,
  status_changed: RefreshCw,
  custom: Zap,
};

const activityColors: Record<string, string> = {
  suggestion_created: 'bg-brand-500/15 text-brand-300',
  task_started: 'bg-blue-500/15 text-blue-400',
  task_completed: 'bg-emerald-500/15 text-emerald-400',
  task_failed: 'bg-red-500/15 text-red-400',
  research_completed: 'bg-purple-500/15 text-purple-400',
  comment_added: 'bg-amber-500/15 text-amber-400',
  status_changed: 'bg-white/[0.06] text-zinc-300',
  custom: 'bg-cyan-500/15 text-cyan-400',
};

export interface ActivityFilters {
  filterAgent: string;
  filterProject: string;
  filterType: string;
}

export function ActivityTab({ filters }: { filters: ActivityFilters }) {
  const { agentActivity, team, projects } = useApp();

  const { filterAgent, filterProject, filterType } = filters;

  const filtered = useMemo(() => {
    return agentActivity.filter(a => {
      if (filterAgent && a.agent_id !== filterAgent) return false;
      if (filterProject && a.project_id !== filterProject) return false;
      if (filterType && a.activity_type !== filterType) return false;
      return true;
    });
  }, [agentActivity, filterAgent, filterProject, filterType]);

  const getAgentName = (id: string) => team.find(m => m.id === id)?.name || 'Unknown Agent';
  const getAgentAvatar = (id: string) => team.find(m => m.id === id)?.avatar || '';
  const getProjectName = (id: string | null) => {
    if (!id) return null;
    return projects.find(p => p.id === id)?.name || null;
  };

  const formatTimestamp = (ts: string) => {
    const date = new Date(ts);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  };

  return (
    <div className="space-y-4">
      {/* Activity feed */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {filtered.map((entry) => {
          const Icon = activityIcons[entry.activity_type] || Zap;
          const colorClass = activityColors[entry.activity_type] || 'bg-white/[0.06] text-zinc-300';
          const projectName = getProjectName(entry.project_id);

          return (
            <div
              key={entry.id}
              className="glass-card rounded-xl p-4 hover:shadow-sm transition-shadow"
            >
              <div className="flex items-start gap-3">
                <div className={`p-2 rounded-lg ${colorClass} flex-shrink-0`}>
                  <Icon size={16} />
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <Avatar name={getAgentName(entry.agent_id)} src={getAgentAvatar(entry.agent_id) || undefined} size="xs" />
                    <span className="text-sm font-medium text-zinc-300">{getAgentName(entry.agent_id)}</span>
                    <span className="text-xs text-zinc-500">{formatTimestamp(entry.created_at)}</span>
                  </div>

                  <h4 className="text-sm font-semibold text-white">{entry.title}</h4>
                  {entry.description && (
                    <p className="text-sm text-zinc-300 mt-0.5">{entry.description}</p>
                  )}

                  {projectName && (
                    <span className="inline-block mt-2 text-xs text-zinc-400 bg-white/[0.03] px-2 py-0.5 rounded">
                      {projectName}
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Empty state */}
      {filtered.length === 0 && (
        <div className="glass-card rounded-xl flex flex-col items-center justify-center p-8 text-center">
          <div className="w-10 h-10 rounded-full bg-white/[0.06] flex items-center justify-center mb-3">
            <Activity size={18} className="text-zinc-500" />
          </div>
          <p className="text-sm font-medium text-zinc-400">No agent activity yet</p>
          <p className="text-xs text-zinc-500 mt-1">Activity from AI agents will appear here</p>
        </div>
      )}
    </div>
  );
}
