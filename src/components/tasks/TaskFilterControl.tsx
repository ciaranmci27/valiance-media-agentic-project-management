'use client';

import { useRef, useState } from 'react';
import { Filter } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { Popover } from '@/components/ui/Popover';
import { Avatar } from '@/components/ui/Avatar';
import type { Task } from '@/lib/types';

// Sentinel stored alongside real member ids in filters.assigneeIds. A task
// with no assignees matches it; a UUID can never collide with it.
export const UNASSIGNED_FILTER_ID = '__unassigned__';

/**
 * The task filter trigger and panel, living in the task toolbar next to the
 * view switcher rather than the page header: filters act on the task views,
 * so the control sits with what it controls. Filtering itself happens
 * upstream in the store, which is why one control covers board, list, and
 * calendar identically.
 *
 * `tasks` is the UNFILTERED project task list; it only feeds the tag
 * vocabulary, so the panel offers exactly the tags that exist here instead
 * of every tag in the workspace.
 */
export function TaskFilterControl({ tasks }: { tasks: Task[] }) {
  const { filters, setFilters, team } = useApp();
  const { teamMemberId } = useAuth();
  const anchorRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  const statusOptions = ['todo', 'in_progress', 'in_review', 'done'];
  const priorityOptions = ['low', 'medium', 'high', 'urgent'];
  const tagOptions = Array.from(new Set(tasks.flatMap(t => t.tags))).sort();
  // Every active member, viewer first: the point of the assignee filter is
  // "show me my work" or "hide the agents' flood", so nobody can be missing.
  const memberOptions = [...team]
    .filter(m => m.status !== 'suspended')
    .sort((a, b) =>
      a.id === teamMemberId ? -1 : b.id === teamMemberId ? 1 : a.name.localeCompare(b.name));

  const toggle = (key: 'status' | 'priority' | 'assigneeIds' | 'tags', value: string) => {
    const current = filters[key];
    const updated = current.includes(value) ? current.filter(v => v !== value) : [...current, value];
    setFilters({ ...filters, [key]: updated });
  };

  const activeCount =
    filters.status.length + filters.priority.length + filters.assigneeIds.length + filters.tags.length;

  const chip = (selected: boolean) =>
    `px-2 py-1 text-xs rounded-full transition-all ${
      selected
        ? 'bg-brand-500/15 text-brand-300 border border-brand-500/30'
        : 'bg-white/[0.03] text-zinc-400 border border-white/10 hover:border-white/20'
    }`;

  return (
    <div ref={anchorRef} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={`h-9 flex items-center gap-2 px-3 text-sm rounded-lg transition-colors ${
          activeCount > 0
            ? 'bg-brand-500/15 border border-brand-500/30 text-brand-300'
            : 'liquid-glass text-zinc-300'
        }`}
      >
        <Filter size={16} />
        <span className="hidden sm:inline">Filter</span>
        {activeCount > 0 && (
          <span className="bg-brand-600 text-white text-xs px-1.5 py-0.5 rounded-full">{activeCount}</span>
        )}
      </button>

      <Popover
        anchorRef={anchorRef}
        open={open}
        onClose={() => setOpen(false)}
        align="end"
        width={320}
        className="bg-surface-raised rounded-xl shadow-xl border border-white/[0.08] p-4 space-y-4"
      >
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-zinc-200">Filters</h3>
          {activeCount > 0 && (
            <button
              onClick={() => setFilters({ ...filters, status: [], priority: [], assigneeIds: [], tags: [] })}
              className="text-xs text-brand-300 hover:text-brand-200"
            >
              Clear all
            </button>
          )}
        </div>

        <div>
          <p className="text-xs font-medium text-zinc-400 mb-2">Assignee</p>
          <div className="flex flex-wrap gap-1.5">
            {memberOptions.map(member => (
              <button
                key={member.id}
                onClick={() => toggle('assigneeIds', member.id)}
                className={`${chip(filters.assigneeIds.includes(member.id))} flex items-center gap-1`}
              >
                <Avatar name={member.name} src={member.avatar || undefined} size="xs" />
                <span>{member.id === teamMemberId ? 'Me' : member.name.split(' ')[0]}</span>
              </button>
            ))}
            <button
              onClick={() => toggle('assigneeIds', UNASSIGNED_FILTER_ID)}
              className={chip(filters.assigneeIds.includes(UNASSIGNED_FILTER_ID))}
            >
              Unassigned
            </button>
          </div>
        </div>

        <div>
          <p className="text-xs font-medium text-zinc-400 mb-2">Status</p>
          <div className="flex flex-wrap gap-1.5">
            {statusOptions.map(status => (
              <button key={status} onClick={() => toggle('status', status)} className={chip(filters.status.includes(status))}>
                {status.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase())}
              </button>
            ))}
          </div>
        </div>

        <div>
          <p className="text-xs font-medium text-zinc-400 mb-2">Priority</p>
          <div className="flex flex-wrap gap-1.5">
            {priorityOptions.map(priority => (
              <button key={priority} onClick={() => toggle('priority', priority)} className={chip(filters.priority.includes(priority))}>
                {priority.charAt(0).toUpperCase() + priority.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {tagOptions.length > 0 && (
          <div>
            <p className="text-xs font-medium text-zinc-400 mb-2">Tags</p>
            <div className="flex flex-wrap gap-1.5">
              {tagOptions.map(tag => (
                <button key={tag} onClick={() => toggle('tags', tag)} className={chip(filters.tags.includes(tag))}>
                  {tag}
                </button>
              ))}
            </div>
          </div>
        )}
      </Popover>
    </div>
  );
}
