'use client';

import { useState, useMemo } from 'react';
import { useApp } from '@/lib/store';
import { Avatar } from '@/components/ui/Avatar';
import { Select } from '@/components/ui/Select';
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
  suggestion_created: 'bg-indigo-100 text-indigo-600',
  task_started: 'bg-blue-100 text-blue-600',
  task_completed: 'bg-emerald-100 text-emerald-600',
  task_failed: 'bg-red-100 text-red-600',
  research_completed: 'bg-purple-100 text-purple-600',
  comment_added: 'bg-amber-100 text-amber-600',
  status_changed: 'bg-zinc-100 text-zinc-600',
  custom: 'bg-cyan-100 text-cyan-600',
};

export function ActivityTab() {
  const { agentActivity, team, projects } = useApp();

  const [filterAgent, setFilterAgent] = useState('');
  const [filterProject, setFilterProject] = useState('');
  const [filterType, setFilterType] = useState('');

  const agents = team.filter(m => m.role === 'agent');

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
      {/* Filters */}
      <div className="flex gap-3 flex-wrap">
        {agents.length > 0 && (
          <Select
            value={filterAgent}
            onChange={setFilterAgent}
            options={[
              { value: '', label: 'All Agents' },
              ...agents.map(a => ({ value: a.id, label: a.name })),
            ]}
          />
        )}
        <Select
          value={filterProject}
          onChange={setFilterProject}
          options={[
            { value: '', label: 'All Projects' },
            ...projects.map(p => ({ value: p.id, label: p.name })),
          ]}
        />
        <Select
          value={filterType}
          onChange={setFilterType}
          options={[
            { value: '', label: 'All Types' },
            { value: 'suggestion_created', label: 'Suggestion Created' },
            { value: 'task_started', label: 'Task Started' },
            { value: 'task_completed', label: 'Task Completed' },
            { value: 'task_failed', label: 'Task Failed' },
            { value: 'research_completed', label: 'Research Completed' },
            { value: 'comment_added', label: 'Comment Added' },
            { value: 'status_changed', label: 'Status Changed' },
            { value: 'custom', label: 'Custom' },
          ]}
        />
      </div>

      {/* Activity feed */}
      <div className="space-y-3">
        {filtered.map((entry) => {
          const Icon = activityIcons[entry.activity_type] || Zap;
          const colorClass = activityColors[entry.activity_type] || 'bg-zinc-100 text-zinc-600';
          const projectName = getProjectName(entry.project_id);

          return (
            <div
              key={entry.id}
              className="bg-white rounded-xl border border-zinc-200 p-4 hover:shadow-sm transition-shadow"
            >
              <div className="flex items-start gap-3">
                <div className={`p-2 rounded-lg ${colorClass} flex-shrink-0`}>
                  <Icon size={16} />
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <Avatar name={getAgentName(entry.agent_id)} src={getAgentAvatar(entry.agent_id) || undefined} size="xs" />
                    <span className="text-sm font-medium text-zinc-700">{getAgentName(entry.agent_id)}</span>
                    <span className="text-xs text-zinc-400">{formatTimestamp(entry.created_at)}</span>
                  </div>

                  <h4 className="text-sm font-semibold text-zinc-900">{entry.title}</h4>
                  {entry.description && (
                    <p className="text-sm text-zinc-600 mt-0.5">{entry.description}</p>
                  )}

                  {projectName && (
                    <span className="inline-block mt-2 text-xs text-zinc-500 bg-zinc-50 px-2 py-0.5 rounded">
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
        <div className="text-center py-12 bg-white rounded-xl border border-zinc-200">
          <Activity className="mx-auto mb-3 text-zinc-400" size={40} />
          <h3 className="font-medium text-zinc-700 mb-1">No agent activity yet</h3>
          <p className="text-sm text-zinc-500">Activity from AI agents will appear here.</p>
        </div>
      )}
    </div>
  );
}
