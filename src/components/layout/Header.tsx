'use client';

import { useState, ReactNode } from 'react';
import { Search, Filter, X } from 'lucide-react';
import { useApp } from '@/lib/store';

interface HeaderProps {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}

export function Header({ title, subtitle, actions }: HeaderProps) {
  const { filters, setFilters, team } = useApp();
  const [showFilters, setShowFilters] = useState(false);

  const statusOptions = ['todo', 'in_progress', 'in_review', 'done'];
  const priorityOptions = ['low', 'medium', 'high', 'urgent'];

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

  const hasActiveFilters = filters.status.length > 0 || filters.priority.length > 0 || filters.assigneeIds.length > 0;

  return (
    <header className="bg-white border-b border-zinc-200 sticky top-0 z-30">
      {/* Main header row */}
      <div className="h-16 flex items-center justify-between px-4 lg:px-6">
        <div className="flex items-center gap-4">
          <div className="pl-12 lg:pl-0">
            <h1 className="text-lg lg:text-xl font-semibold text-zinc-900 tracking-tight">{title}</h1>
            {subtitle && <div className="text-sm text-zinc-500">{subtitle}</div>}
          </div>
        </div>

        <div className="flex items-center gap-2 lg:gap-3">
          {/* Search */}
          <div className="hidden md:block relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" size={16} />
            <input
              type="text"
              placeholder="Search..."
              value={filters.search}
              onChange={(e) => setFilters({ ...filters, search: e.target.value })}
              className="pl-9 pr-4 py-2 w-40 lg:w-64 text-sm bg-zinc-50 border border-zinc-200 rounded-lg outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 transition-all"
            />
          </div>

          {/* Filter button */}
          <button 
            onClick={() => setShowFilters(!showFilters)}
            className={`flex items-center gap-2 px-3 py-2 text-sm border rounded-lg transition-colors ${
              hasActiveFilters 
                ? 'bg-indigo-50 border-indigo-300 text-indigo-700' 
                : 'bg-zinc-50 border-zinc-200 text-zinc-600 hover:bg-zinc-100'
            }`}
          >
            <Filter size={16} />
            <span className="hidden sm:inline">Filter</span>
            {hasActiveFilters && (
              <span className="bg-indigo-600 text-white text-xs px-1.5 py-0.5 rounded-full">
                {filters.status.length + filters.priority.length + filters.assigneeIds.length}
              </span>
            )}
          </button>

          {/* Custom actions */}
          {actions}
        </div>
      </div>

      {/* Filter panel */}
      {showFilters && (
        <div className="border-t border-zinc-200 px-4 lg:px-6 py-4 bg-zinc-50 animate-slideDown">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-zinc-700">Filters</h3>
            {hasActiveFilters && (
              <button 
                onClick={clearFilters}
                className="text-xs text-indigo-600 hover:text-indigo-700"
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
                        ? 'bg-indigo-100 text-indigo-700 border border-indigo-300'
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
                        ? 'bg-indigo-100 text-indigo-700 border border-indigo-300'
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
                        ? 'bg-indigo-100 text-indigo-700 border border-indigo-300'
                        : 'bg-white text-zinc-600 border border-zinc-200 hover:border-zinc-300'
                    }`}
                  >
                    {member.avatar}
                  </button>
                ))}
              </div>
            </div>

            {/* Search (mobile) */}
            <div className="md:hidden">
              <label className="block text-xs font-medium text-zinc-500 mb-2">Search</label>
              <input
                type="text"
                placeholder="Search tasks..."
                value={filters.search}
                onChange={(e) => setFilters({ ...filters, search: e.target.value })}
                className="w-full px-3 py-2 text-sm bg-white border border-zinc-200 rounded-lg outline-none focus:border-indigo-500"
              />
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
