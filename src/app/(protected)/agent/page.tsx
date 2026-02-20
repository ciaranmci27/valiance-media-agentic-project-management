'use client';

import { useState, useEffect } from 'react';
import { useApp, defaultFilters } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { Header } from '@/components/layout/Header';
import { SuggestionsTab } from '@/components/agent/SuggestionsTab';
import { GoalsTab } from '@/components/agent/GoalsTab';
import { ActivityTab } from '@/components/agent/ActivityTab';
import { Bot, Lightbulb, Target, Activity } from 'lucide-react';
import { useRouter } from 'next/navigation';

type AgentTab = 'suggestions' | 'goals' | 'activity';

export default function AgentPage() {
  const { team, taskSuggestions, setFilters } = useApp();
  const { teamMemberId } = useAuth();
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<AgentTab>('suggestions');

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

  const pendingCount = taskSuggestions.filter(s => s.status === 'pending').length;

  const tabs: { key: AgentTab; label: string; icon: any; count?: number }[] = [
    { key: 'suggestions', label: 'Suggestions', icon: Lightbulb, count: pendingCount },
    { key: 'goals', label: 'Goals', icon: Target },
    { key: 'activity', label: 'Activity', icon: Activity },
  ];

  return (
    <div className="animate-fadeIn min-h-screen bg-zinc-50">
      <Header
        title="Agent"
        subtitle={<span className="hidden sm:inline">AI agent workflows</span>}
      />

      <div className="p-4 lg:p-6 space-y-4">
        {/* Tab Switcher */}
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
                    : 'bg-indigo-100 text-indigo-700'
                }`}>
                  {tab.count}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        {activeTab === 'suggestions' && <SuggestionsTab />}
        {activeTab === 'goals' && <GoalsTab />}
        {activeTab === 'activity' && <ActivityTab />}
      </div>
    </div>
  );
}
