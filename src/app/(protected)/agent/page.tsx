'use client';

import { useState, useEffect } from 'react';
import { useApp, defaultFilters } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { Header } from '@/components/layout/Header';
import { SuggestionsTab, StatusFilter, SuggestionsFilters } from '@/components/agent/SuggestionsTab';
import { AgentProjectsTab } from '@/components/agent/AgentProjectsTab';
import { ActivityTab, ActivityFilters } from '@/components/agent/ActivityTab';
import { Select } from '@/components/ui/Select';
import { TASK_TYPES } from '@/lib/types';
import { Bot, Lightbulb, FolderKanban, Activity } from 'lucide-react';
import { useRouter } from 'next/navigation';

type AgentTab = 'suggestions' | 'projects' | 'activity';

export default function AgentPage() {
  const { team, taskSuggestions, projects, projectGoals, setFilters } = useApp();
  const { teamMemberId } = useAuth();
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<AgentTab>('projects');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('');
  const [filterProject, setFilterProject] = useState('');
  const [filterGoal, setFilterGoal] = useState('');
  const [filterPriority, setFilterPriority] = useState('');
  const [filterAgent, setFilterAgent] = useState('');
  const [filterTaskType, setFilterTaskType] = useState('');
  // Activity filters
  const [actFilterAgent, setActFilterAgent] = useState('');
  const [actFilterProject, setActFilterProject] = useState('');
  const [actFilterType, setActFilterType] = useState('');

  useEffect(() => { setFilters(defaultFilters); }, []);

  // Gate: only admin + agents enabled
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

  const suggestionsFilters: SuggestionsFilters = {
    statusFilter, filterProject, filterGoal, filterPriority, filterAgent, filterTaskType,
  };

  const activityFilters: ActivityFilters = {
    filterAgent: actFilterAgent, filterProject: actFilterProject, filterType: actFilterType,
  };

  const agents = team.filter(m => m.role === 'agent');

  const statusOptions: { key: StatusFilter; label: string; count: number }[] = [
    { key: '', label: 'All Statuses', count: taskSuggestions.length },
    { key: 'pending', label: 'Pending', count: taskSuggestions.filter(s => s.status === 'pending').length },
    { key: 'needs_info', label: 'Needs Info', count: taskSuggestions.filter(s => s.status === 'needs_info').length },
    { key: 'approved', label: 'Approved', count: taskSuggestions.filter(s => s.status === 'approved').length },
    { key: 'rejected', label: 'Rejected', count: taskSuggestions.filter(s => s.status === 'rejected').length },
  ];

  const pendingCount = taskSuggestions.filter(s => s.status === 'pending').length;

  const tabs: { key: AgentTab; label: string; icon: any; count?: number }[] = [
    { key: 'projects', label: 'Projects', icon: FolderKanban },
    { key: 'suggestions', label: 'Suggestions', icon: Lightbulb, count: pendingCount },
    { key: 'activity', label: 'Activity', icon: Activity },
  ];

  return (
    <div className="animate-fadeIn min-h-screen bg-zinc-50">
      <Header
        title="Agent"
        subtitle={<span className="hidden sm:inline">AI home</span>}
      />

      <div className="p-4 lg:p-6 space-y-4">
        {/* Tab Switcher + Filters */}
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex gap-1 bg-white rounded-lg border border-zinc-200 p-1 w-fit">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all ${
                  activeTab === tab.key
                    ? 'bg-zinc-900 text-white shadow-sm'
                    : 'text-zinc-600 hover:text-zinc-900 hover:bg-zinc-50'
                }`}
              >
                <tab.icon size={16} />
                {tab.label}
                {tab.count !== undefined && tab.count > 0 && (
                  <span className={`min-w-[20px] h-5 flex items-center justify-center rounded-full text-xs font-medium px-1.5 ${
                    activeTab === tab.key
                      ? 'bg-white/20 text-white'
                      : 'bg-brand-100 text-brand-700'
                  }`}>
                    {tab.count}
                  </span>
                )}
              </button>
            ))}
          </div>

          {activeTab === 'suggestions' && (
            <div className="flex gap-3 flex-wrap">
              <Select
                value={statusFilter}
                onChange={(v) => setStatusFilter(v as StatusFilter)}
                options={statusOptions.map((o) => ({
                  value: o.key,
                  label: `${o.label}${o.count > 0 ? ` (${o.count})` : ''}`,
                }))}
              />
              <Select
                value={filterProject}
                onChange={setFilterProject}
                options={[
                  { value: '', label: 'All Projects' },
                  ...projects.map(p => ({ value: p.id, label: p.name })),
                ]}
              />
              <Select
                value={filterGoal}
                onChange={setFilterGoal}
                options={[
                  { value: '', label: 'All Goals' },
                  ...projectGoals.map(g => ({ value: g.id, label: g.title })),
                ]}
              />
              <Select
                value={filterPriority}
                onChange={setFilterPriority}
                options={[
                  { value: '', label: 'All Priorities' },
                  { value: 'low', label: 'Low' },
                  { value: 'medium', label: 'Medium' },
                  { value: 'high', label: 'High' },
                  { value: 'urgent', label: 'Urgent' },
                ]}
              />
              <Select
                value={filterTaskType}
                onChange={setFilterTaskType}
                options={[
                  { value: '', label: 'All Types' },
                  ...TASK_TYPES.map(t => ({ value: t, label: t.charAt(0).toUpperCase() + t.slice(1) })),
                ]}
              />
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
            </div>
          )}

          {activeTab === 'activity' && (
            <div className="flex gap-3 flex-wrap">
              {agents.length > 0 && (
                <Select
                  value={actFilterAgent}
                  onChange={setActFilterAgent}
                  options={[
                    { value: '', label: 'All Agents' },
                    ...agents.map(a => ({ value: a.id, label: a.name })),
                  ]}
                />
              )}
              <Select
                value={actFilterProject}
                onChange={setActFilterProject}
                options={[
                  { value: '', label: 'All Projects' },
                  ...projects.map(p => ({ value: p.id, label: p.name })),
                ]}
              />
              <Select
                value={actFilterType}
                onChange={setActFilterType}
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
          )}
        </div>

        {/* Tab Content */}
        {activeTab === 'suggestions' && <SuggestionsTab filters={suggestionsFilters} />}
        {activeTab === 'projects' && <AgentProjectsTab />}
        {activeTab === 'activity' && <ActivityTab filters={activityFilters} />}
      </div>
    </div>
  );
}
