'use client';

import { useMemo, useState } from 'react';
import { useApp } from '@/lib/store';
import { Activity, ChevronDown } from 'lucide-react';

const activityDots: Record<string, string> = {
  suggestion_created: 'bg-brand-500',
  task_started: 'bg-blue-500',
  task_completed: 'bg-emerald-500',
  task_failed: 'bg-red-500',
  research_started: 'bg-purple-400',
  research_completed: 'bg-purple-500',
  suggestion_reviewed: 'bg-amber-500',
  comment_added: 'bg-amber-500',
  status_changed: 'bg-zinc-400',
  agent_spawned: 'bg-cyan-500',
  agent_completed: 'bg-cyan-500',
  agent_failed: 'bg-red-400',
  heartbeat: 'bg-zinc-300',
  system_check: 'bg-zinc-300',
  custom: 'bg-cyan-500',
};

const MAX_VISIBLE = 15;

export function ActivityTimeline() {
  const { agentActivity, team, projects } = useApp();
  const [showAll, setShowAll] = useState(false);

  const getAgentName = (id: string) => team.find(m => m.id === id)?.name || 'Agent';
  const getProjectName = (id: string | null) => {
    if (!id) return null;
    return projects.find(p => p.id === id)?.name || null;
  };

  const formatTime = (ts: string) => {
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
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  const getDayLabel = (ts: string) => {
    const date = new Date(ts);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const entryDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());

    if (entryDate.getTime() === today.getTime()) return 'Today';
    if (entryDate.getTime() === yesterday.getTime()) return 'Yesterday';
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  // Group by day
  const grouped = useMemo(() => {
    const sorted = [...agentActivity].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );

    const limited = showAll ? sorted : sorted.slice(0, MAX_VISIBLE);

    const groups: { label: string; entries: typeof sorted }[] = [];
    let currentLabel = '';

    for (const entry of limited) {
      const label = getDayLabel(entry.created_at);
      if (label !== currentLabel) {
        currentLabel = label;
        groups.push({ label, entries: [] });
      }
      groups[groups.length - 1].entries.push(entry);
    }

    return groups;
  }, [agentActivity, showAll]);

  const totalCount = agentActivity.length;

  return (
    <div className="bg-white rounded-xl border border-zinc-200 overflow-hidden lg:flex lg:flex-col lg:h-full lg:min-h-0">
      <div className="p-4 border-b border-zinc-100 lg:flex-shrink-0">
        <h2 className="font-semibold text-zinc-900">Recent Activity</h2>
      </div>

      <div className="lg:flex-1 lg:min-h-0 overflow-y-auto board-column-scroll max-h-[400px] lg:max-h-none">
        {grouped.length > 0 ? (
          <div className="px-4 lg:px-5 py-3">
            {grouped.map((group) => (
              <div key={group.label} className="mb-4 last:mb-0">
                {/* Day label */}
                <p className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider mb-2">{group.label}</p>

                {/* Entries */}
                <div className="space-y-0.5">
                  {group.entries.map((entry) => {
                    const dotColor = activityDots[entry.activity_type] || 'bg-zinc-400';
                    const projectName = getProjectName(entry.project_id);

                    return (
                      <div
                        key={entry.id}
                        className="flex items-start gap-2.5 py-1.5 group/entry"
                      >
                        {/* Timeline dot */}
                        <div className={`w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0 ${dotColor}`} />

                        {/* Content */}
                        <div className="flex-1 min-w-0">
                          <p className="text-xs text-zinc-700 leading-relaxed">
                            <span className="font-medium">{getAgentName(entry.agent_id)}</span>
                            {' '}
                            <span className="text-zinc-500">{entry.title}</span>
                          </p>
                          {projectName && (
                            <p className="text-[10px] text-zinc-400 mt-0.5">{projectName}</p>
                          )}
                        </div>

                        {/* Time */}
                        <span className="text-[10px] text-zinc-300 flex-shrink-0 mt-0.5">
                          {formatTime(entry.created_at)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}

            {/* Show more */}
            {!showAll && totalCount > MAX_VISIBLE && (
              <button
                onClick={() => setShowAll(true)}
                className="w-full flex items-center justify-center gap-1 py-2 text-xs text-brand-600 hover:text-brand-700 transition-colors"
              >
                View all ({totalCount})
                <ChevronDown size={12} />
              </button>
            )}
          </div>
        ) : (
          <div className="py-8 text-center">
            <Activity className="mx-auto mb-2 text-zinc-300" size={24} />
            <p className="text-sm text-zinc-400">No activity yet</p>
          </div>
        )}
      </div>
    </div>
  );
}
