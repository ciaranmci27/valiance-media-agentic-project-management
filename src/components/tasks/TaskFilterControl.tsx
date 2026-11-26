'use client';

import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { Avatar } from '@/components/ui/Avatar';
import { FilterButton, FilterOption, FilterSection } from '@/components/ui/FilterButton';
import { sentenceCase } from '@/components/ui/Pill';
import type { Initiative, Task } from '@/lib/types';
import { INITIATIVE_LABEL, isOpenInitiative } from '@/lib/initiatives';

// Sentinel stored alongside real member ids in filters.assigneeIds. A task
// with no assignees matches it; a UUID can never collide with it.
export const UNASSIGNED_FILTER_ID = '__unassigned__';
// The same for filters.initiativeIds: a task in no live initiative matches it.
export const NO_INITIATIVE_FILTER_ID = '__no_initiative__';

/**
 * The task filter, on the shared FilterButton, living in the task toolbar
 * next to the view switcher rather than the page header: filters act on the
 * task views, so the control sits with what it controls. Filtering itself
 * happens upstream in the store, which is why one control covers board,
 * list, and calendar identically.
 *
 * `tasks` is the UNFILTERED project task list; it only feeds the tag
 * vocabulary, so the panel offers exactly the tags that exist here instead
 * of every tag in the workspace.
 *
 * `initiatives` (a project's Tasks tab) adds the initiative filter: each
 * live initiative, done ones after open ones, and "No initiative".
 */
export function TaskFilterControl({ tasks, initiatives }: {
  tasks: Task[];
  initiatives?: readonly Pick<Initiative, 'id' | 'name' | 'status'>[];
}) {
  const { filters, setFilters, team } = useApp();
  const { teamMemberId } = useAuth();

  const statusOptions = ['backlog', 'todo', 'in_progress', 'in_review', 'done'];
  const priorityOptions = ['low', 'medium', 'high', 'urgent'];
  const tagOptions = Array.from(new Set(tasks.flatMap(t => t.tags))).sort();
  // Every active member, viewer first: the point of the assignee filter is
  // "show me my work" or "hide the agents' flood", so nobody can be missing.
  const memberOptions = [...team]
    .filter(m => m.status !== 'suspended')
    .sort((a, b) =>
      a.id === teamMemberId ? -1 : b.id === teamMemberId ? 1 : a.name.localeCompare(b.name));

  const initiativeIds = filters.initiativeIds ?? [];
  // Open ones first, then done ones, each in their own order.
  const initiativeOptions = initiatives
    ? [...initiatives.filter(isOpenInitiative), ...initiatives.filter((initiative) => !isOpenInitiative(initiative))]
    : [];

  const toggle = (key: 'status' | 'priority' | 'assigneeIds' | 'tags' | 'initiativeIds', value: string) => {
    const current = filters[key] ?? [];
    const updated = current.includes(value) ? current.filter(v => v !== value) : [...current, value];
    setFilters({ ...filters, [key]: updated });
  };

  const activeCount =
    filters.status.length + filters.priority.length + filters.assigneeIds.length + filters.tags.length + initiativeIds.length;

  return (
    <FilterButton
      activeCount={activeCount}
      onClear={() => setFilters({ ...filters, status: [], priority: [], assigneeIds: [], tags: [], initiativeIds: [] })}
    >
      <FilterSection label="Assignee">
        {memberOptions.map(member => (
          <FilterOption key={member.id} selected={filters.assigneeIds.includes(member.id)} onToggle={() => toggle('assigneeIds', member.id)}>
            <Avatar id={member.id} name={member.name} src={member.avatar || undefined} size="xs" />
            <span>{member.id === teamMemberId ? 'Me' : member.name.split(' ')[0]}</span>
          </FilterOption>
        ))}
        <FilterOption selected={filters.assigneeIds.includes(UNASSIGNED_FILTER_ID)} onToggle={() => toggle('assigneeIds', UNASSIGNED_FILTER_ID)}>
          Unassigned
        </FilterOption>
      </FilterSection>

      {initiatives && initiatives.length > 0 && (
        <FilterSection label={INITIATIVE_LABEL.singular}>
          {initiativeOptions.map(initiative => (
            <FilterOption key={initiative.id} selected={initiativeIds.includes(initiative.id)} onToggle={() => toggle('initiativeIds', initiative.id)} className="truncate">
              {initiative.name}
            </FilterOption>
          ))}
          <FilterOption selected={initiativeIds.includes(NO_INITIATIVE_FILTER_ID)} onToggle={() => toggle('initiativeIds', NO_INITIATIVE_FILTER_ID)}>
            No {INITIATIVE_LABEL.lower}
          </FilterOption>
        </FilterSection>
      )}

      <FilterSection label="Status">
        {statusOptions.map(status => (
          <FilterOption key={status} selected={filters.status.includes(status)} onToggle={() => toggle('status', status)}>
            {sentenceCase(status)}
          </FilterOption>
        ))}
      </FilterSection>

      <FilterSection label="Priority">
        {priorityOptions.map(priority => (
          <FilterOption key={priority} selected={filters.priority.includes(priority)} onToggle={() => toggle('priority', priority)}>
            {sentenceCase(priority)}
          </FilterOption>
        ))}
      </FilterSection>

      {tagOptions.length > 0 && (
        <FilterSection label="Tags">
          {tagOptions.map(tag => (
            <FilterOption key={tag} selected={filters.tags.includes(tag)} onToggle={() => toggle('tags', tag)}>
              {tag}
            </FilterOption>
          ))}
        </FilterSection>
      )}
    </FilterButton>
  );
}
