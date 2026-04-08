'use client';

import { useState, ReactNode } from 'react';
import { Search, Filter, X, Menu } from 'lucide-react';
import { useApp } from '@/lib/store';
import { Avatar } from '@/components/ui/Avatar';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { NotificationDropdown } from './NotificationDropdown';

interface HeaderProps {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  searchPlaceholder?: string;
  showFilters?: boolean;
}

export function Header({ title, subtitle, actions, searchPlaceholder, showFilters = false }: HeaderProps) {
  const { filters, setFilters, team, tasks } = useApp();
  const [isFilterPanelOpen, setIsFilterPanelOpen] = useState(false);

  const statusOptions = ['todo', 'in_progress', 'in_review', 'done'];
  const priorityOptions = ['low', 'medium', 'high', 'urgent'];

  // Collect unique tags across all tasks
  const allTags = Array.from(new Set(tasks.flatMap(t => t.tags))).sort();

  const toggleFilter = (type: 'status' | 'priority', value: string) => {
    const current = filters[type];
    const updated = current.includes(value)
      ? current.filter(v => v !== value)
      : [...current, value];
    setFilters({ ...filters, [type]: updated });
  };

  const clearFilters = () => {
    setFilters({ status: [], priority: [], assigneeIds: [], tags: [], search: '' });
  };

  const hasActiveFilters = filters.status.length > 0 || filters.priority.length > 0 || filters.assigneeIds.length > 0 || filters.tags.length > 0;

  return (
    <>
    <header className="bg-white border-b border-zinc-200 sticky top-0 z-30">
      {/* Main header row */}
      <div className="h-16 flex items-center justify-between px-4 lg:px-6">
        <div className="flex items-center gap-3">
          <button
            onClick={() => window.dispatchEvent(new Event('open-sidebar'))}
            className="lg:hidden p-2 -ml-2 rounded-lg text-zinc-500 hover:text-zinc-700 hover:bg-zinc-100 transition-colors"
          >
            <Menu size={20} />
          </button>
          <div className="flex items-center gap-3 min-w-0">
            <h1 className="text-lg lg:text-xl font-semibold text-zinc-900 tracking-tight truncate">{title}</h1>
            {subtitle && <div className="hidden sm:block text-sm text-zinc-500">{subtitle}</div>}
          </div>
        </div>

        <div className="flex items-center gap-2 lg:gap-3">
          <NotificationDropdown />

          {searchPlaceholder && (
            <>
              {/* Search (desktop) */}
              <div className="hidden md:block w-40 lg:w-64">
                <TextInput
                  type="search"
                  placeholder={searchPlaceholder}
                  value={filters.search}
                  onChange={v => setFilters({ ...filters, search: v })}
                  leftIcon={Search}
                  size="sm"
                />
              </div>
            </>
          )}

          {showFilters && (
            <button
              onClick={() => setIsFilterPanelOpen(!isFilterPanelOpen)}
              className={`flex items-center gap-2 px-3 py-2 text-sm border rounded-lg transition-colors ${
                hasActiveFilters
                  ? 'bg-brand-50 border-brand-300 text-brand-700'
                  : 'bg-zinc-50 border-zinc-200 text-zinc-600 hover:bg-zinc-100'
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

          {/* Custom actions */}
          {actions}
        </div>
      </div>

      {/* Filter panel */}
      {showFilters && isFilterPanelOpen && (
        <div className="border-t border-zinc-200 px-4 lg:px-6 py-4 bg-zinc-50 animate-slideDown">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-zinc-700">Filters</h3>
            {hasActiveFilters && (
              <button
                onClick={clearFilters}
                className="text-xs text-brand-600 hover:text-brand-700"
              >
                Clear all
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Status filter */}
            <div>
              <label className="block text-xs font-medium text-zinc-500 mb-2">Status</label>
              <div className="flex flex-wrap gap-1.5">
                {statusOptions.map(status => (
                  <button
                    key={status}
                    onClick={() => toggleFilter('status', status)}
                    className={`px-2 py-1 text-xs rounded-full transition-all ${
                      filters.status.includes(status)
                        ? 'bg-brand-100 text-brand-700 border border-brand-300'
                        : 'bg-white text-zinc-600 border border-zinc-200 hover:border-zinc-300'
                    }`}
                  >
                    {status.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase())}
                  </button>
                ))}
              </div>
            </div>

            {/* Priority filter */}
            <div>
              <label className="block text-xs font-medium text-zinc-500 mb-2">Priority</label>
              <div className="flex flex-wrap gap-1.5">
                {priorityOptions.map(priority => (
                  <button
                    key={priority}
                    onClick={() => toggleFilter('priority', priority)}
                    className={`px-2 py-1 text-xs rounded-full transition-all ${
                      filters.priority.includes(priority)
                        ? 'bg-brand-100 text-brand-700 border border-brand-300'
                        : 'bg-white text-zinc-600 border border-zinc-200 hover:border-zinc-300'
                    }`}
                  >
                    {priority.charAt(0).toUpperCase() + priority.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            {/* Assignee filter */}
            <div>
              <label className="block text-xs font-medium text-zinc-500 mb-2">Assignee</label>
              <div className="flex flex-wrap gap-1.5">
                {team.slice(0, 4).map(member => (
                  <button
                    key={member.id}
                    onClick={() => {
                      const current = filters.assigneeIds;
                      const updated = current.includes(member.id)
                        ? current.filter(id => id !== member.id)
                        : [...current, member.id];
                      setFilters({ ...filters, assigneeIds: updated });
                    }}
                    className={`px-2 py-1 text-xs rounded-full transition-all flex items-center gap-1 ${
                      filters.assigneeIds.includes(member.id)
                        ? 'bg-brand-100 text-brand-700 border border-brand-300'
                        : 'bg-white text-zinc-600 border border-zinc-200 hover:border-zinc-300'
                    }`}
                  >
                    <Avatar name={member.name} src={member.avatar || undefined} size="xs" />
                    <span>{member.name.split(' ')[0]}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Tags filter */}
            {allTags.length > 0 && (
              <div>
                <label className="block text-xs font-medium text-zinc-500 mb-2">Tags</label>
                <div className="flex flex-wrap gap-1.5">
                  {allTags.slice(0, 8).map(tag => (
                    <button
                      key={tag}
                      onClick={() => {
                        const current = filters.tags;
                        const updated = current.includes(tag)
                          ? current.filter(t => t !== tag)
                          : [...current, tag];
                        setFilters({ ...filters, tags: updated });
                      }}
                      className={`px-2 py-1 text-xs rounded-full transition-all ${
                        filters.tags.includes(tag)
                          ? 'bg-brand-100 text-brand-700 border border-brand-300'
                          : 'bg-white text-zinc-600 border border-zinc-200 hover:border-zinc-300'
                      }`}
                    >
                      {tag}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </header>

    {/* Mobile search — renders below sticky header in page content flow */}
    {searchPlaceholder && (
      <div className="md:hidden px-4 pt-3 pb-1">
        <TextInput
          type="search"
          placeholder={searchPlaceholder}
          value={filters.search}
          onChange={v => setFilters({ ...filters, search: v })}
          leftIcon={Search}
          size="sm"
        />
      </div>
    )}
    </>
  );
}
