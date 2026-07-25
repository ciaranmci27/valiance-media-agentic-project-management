'use client';

import { useState, ReactNode } from 'react';
import { Search, Filter, Menu } from 'lucide-react';
import { useApp } from '@/lib/store';
import { Avatar } from '@/components/ui/Avatar';
import { TextInput } from '@/components/ui/inputs/TextInput';

interface HeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  searchPlaceholder?: string;
  showFilters?: boolean;
}

/**
 * Integrated page header — lives in the content flow (no sticky chrome bar).
 * Title + subtitle on the left, search + page actions on the right. Every page
 * renders this, so the header is consistent across the app. Global chrome
 * (notifications, user) lives in the sidebar, not here.
 */
export function Header({ title, subtitle, actions, searchPlaceholder, showFilters = false }: HeaderProps) {
  const { filters, setFilters, team, tasks } = useApp();
  const [isFilterPanelOpen, setIsFilterPanelOpen] = useState(false);

  const statusOptions = ['todo', 'in_progress', 'in_review', 'done'];
  const priorityOptions = ['low', 'medium', 'high', 'urgent'];
  const allTags = Array.from(new Set(tasks.flatMap(t => t.tags))).sort();

  const toggleFilter = (type: 'status' | 'priority', value: string) => {
    const current = filters[type];
    const updated = current.includes(value) ? current.filter(v => v !== value) : [...current, value];
    setFilters({ ...filters, [type]: updated });
  };

  const clearFilters = () => setFilters({ status: [], priority: [], assigneeIds: [], tags: [], search: '' });
  const hasActiveFilters = filters.status.length > 0 || filters.priority.length > 0 || filters.assigneeIds.length > 0 || filters.tags.length > 0;

  return (
    <div className="px-4 lg:px-6 pt-5 lg:pt-7 pb-1">
      <div className="flex items-center justify-between gap-3 lg:gap-4 flex-wrap">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={() => window.dispatchEvent(new Event('open-sidebar'))}
            className="lg:hidden p-2 -ml-2 rounded-lg text-zinc-400 hover:text-white hover:bg-white/[0.06] transition-colors flex-shrink-0"
            aria-label="Open menu"
          >
            <Menu size={20} />
          </button>
          <div className="min-w-0">
            <h1 className="text-2xl lg:text-[26px] font-bold text-white tracking-tight leading-tight truncate">{title}</h1>
            {subtitle && <div className="text-sm text-zinc-400 mt-1">{subtitle}</div>}
          </div>
        </div>

        <div className="flex items-center gap-2 lg:gap-3 flex-shrink-0">
          {searchPlaceholder && (
            <div className="hidden md:block w-44 lg:w-64">
              <TextInput
                type="search"
                placeholder={searchPlaceholder}
                value={filters.search}
                onChange={v => setFilters({ ...filters, search: v })}
                leftIcon={Search}
                size="default"
              />
            </div>
          )}

          {showFilters && (
            <button
              onClick={() => setIsFilterPanelOpen(!isFilterPanelOpen)}
              className={`flex items-center gap-2 px-3 py-2 text-sm border rounded-lg transition-colors ${
                hasActiveFilters
                  ? 'bg-brand-500/15 border-brand-500/30 text-brand-300'
                  : 'bg-white/[0.03] border-white/10 text-zinc-300 hover:bg-white/[0.06]'
              }`}
            >
              <Filter size={16} />
              <span className="hidden sm:inline">Filter</span>
              {hasActiveFilters && (
                <span className="bg-brand-600 text-white text-xs px-1.5 py-0.5 rounded-full">
                  {filters.status.length + filters.priority.length + filters.assigneeIds.length + filters.tags.length}
                </span>
              )}
            </button>
          )}

          {actions}
        </div>
      </div>

      {/* Filter panel */}
      {showFilters && isFilterPanelOpen && (
        <div className="glass-card rounded-xl px-4 lg:px-5 py-4 mt-4 animate-slideDown">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-zinc-200">Filters</h3>
            {hasActiveFilters && (
              <button onClick={clearFilters} className="text-xs text-brand-300 hover:text-brand-200">Clear all</button>
            )}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-2">Status</label>
              <div className="flex flex-wrap gap-1.5">
                {statusOptions.map(status => (
                  <button key={status} onClick={() => toggleFilter('status', status)}
                    className={`px-2 py-1 text-xs rounded-full transition-all ${filters.status.includes(status) ? 'bg-brand-500/15 text-brand-300 border border-brand-500/30' : 'bg-white/[0.03] text-zinc-400 border border-white/10 hover:border-white/20'}`}>
                    {status.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase())}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-2">Priority</label>
              <div className="flex flex-wrap gap-1.5">
                {priorityOptions.map(priority => (
                  <button key={priority} onClick={() => toggleFilter('priority', priority)}
                    className={`px-2 py-1 text-xs rounded-full transition-all ${filters.priority.includes(priority) ? 'bg-brand-500/15 text-brand-300 border border-brand-500/30' : 'bg-white/[0.03] text-zinc-400 border border-white/10 hover:border-white/20'}`}>
                    {priority.charAt(0).toUpperCase() + priority.slice(1)}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-2">Assignee</label>
              <div className="flex flex-wrap gap-1.5">
                {team.slice(0, 4).map(member => (
                  <button key={member.id}
                    onClick={() => {
                      const current = filters.assigneeIds;
                      const updated = current.includes(member.id) ? current.filter(id => id !== member.id) : [...current, member.id];
                      setFilters({ ...filters, assigneeIds: updated });
                    }}
                    className={`px-2 py-1 text-xs rounded-full transition-all flex items-center gap-1 ${filters.assigneeIds.includes(member.id) ? 'bg-brand-500/15 text-brand-300 border border-brand-500/30' : 'bg-white/[0.03] text-zinc-400 border border-white/10 hover:border-white/20'}`}>
                    <Avatar name={member.name} src={member.avatar || undefined} size="xs" />
                    <span>{member.name.split(' ')[0]}</span>
                  </button>
                ))}
              </div>
            </div>
            {allTags.length > 0 && (
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-2">Tags</label>
                <div className="flex flex-wrap gap-1.5">
                  {allTags.slice(0, 8).map(tag => (
                    <button key={tag}
                      onClick={() => {
                        const current = filters.tags;
                        const updated = current.includes(tag) ? current.filter(t => t !== tag) : [...current, tag];
                        setFilters({ ...filters, tags: updated });
                      }}
                      className={`px-2 py-1 text-xs rounded-full transition-all ${filters.tags.includes(tag) ? 'bg-brand-500/15 text-brand-300 border border-brand-500/30' : 'bg-white/[0.03] text-zinc-400 border border-white/10 hover:border-white/20'}`}>
                      {tag}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Mobile search */}
      {searchPlaceholder && (
        <div className="md:hidden mt-3">
          <TextInput
            type="search"
            placeholder={searchPlaceholder}
            value={filters.search}
            onChange={v => setFilters({ ...filters, search: v })}
            leftIcon={Search}
            size="default"
          />
        </div>
      )}
    </div>
  );
}
