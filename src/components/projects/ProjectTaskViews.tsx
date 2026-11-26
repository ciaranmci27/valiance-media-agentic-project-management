'use client';

import { useMemo, useRef, useState } from 'react';
import { ChevronRight, FolderInput, LayoutGrid, LayoutTemplate, Calendar, List, Plus } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { useRead } from '@/lib/query-cache';
import { projectInitiativesRead } from '@/lib/reads';
import { INITIATIVE_LABEL, sortInitiatives } from '@/lib/initiatives';
import { canBeAssignedInProject, canEditTask, canManageAllTasks, hasPermission } from '@/lib/access-control';
import type { Task, ViewMode } from '@/lib/types';
import { Popover } from '@/components/ui/Popover';
import { Avatar } from '@/components/ui/Avatar';
import { DateInput } from '@/components/ui/inputs/DateInput';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { toast } from '@/components/ui/Toast';
import { TaskFilterControl, UNASSIGNED_FILTER_ID, NO_INITIATIVE_FILTER_ID } from '@/components/tasks/TaskFilterControl';
import { UnreadNotice, useCardUnread } from '@/components/tasks/TaskUnread';
import { NewTaskPanel } from '@/components/tasks/NewTaskPanel';
import { TaskMoveDialog } from '@/components/tasks/MoveTaskDialog';
import { TemplatePicker } from '@/components/templates/UseTemplateButton';
import { UseTemplatePanel } from '@/components/templates/UseTemplatePanel';
import { ProjectTemplatesPanel } from '@/components/templates/ProjectTemplatesPanel';
import { BoardView } from '@/components/views/BoardView';
import { ListView } from '@/components/views/ListView';
import { CalendarView } from '@/components/views/CalendarView';
import { InitiativeNamesProvider } from '@/components/initiatives/InitiativeBits';
import { EmptyCard, NoMatches, SubNav, TabToolbar, ToolbarButton } from './TabLayout';

const viewModes: { id: ViewMode; icon: typeof LayoutGrid; label: string }[] = [
  { id: 'board', icon: LayoutGrid, label: 'Board' },
  { id: 'list', icon: List, label: 'List' },
  { id: 'calendar', icon: Calendar, label: 'Calendar' },
];

const NO_INITIATIVES = new Map<string, string>();

/**
 * A project's task views: the toolbar (search, Board, List and Calendar,
 * filters, Add task), the bulk menu for a list selection, and the views.
 * The project's Tasks tab shows every task; an initiative's Board passes a
 * predicate that keeps its tasks and the initiative new tasks start in.
 * Filters are the store's (the page resets them when it opens). Opening a
 * task and the single-task delete confirm belong to the page, which owns
 * the task panel.
 */
export function ProjectTaskViews({ projectId, taskFilter, newTaskInitiativeId = null, emptyTitle = 'No tasks yet', emptyDescription, onOpenTask, onDeleteTask }: {
  projectId: string;
  /** Which of the project's tasks these views show; all of them when left out. */
  taskFilter?: (task: Task) => boolean;
  /** The initiative a new task starts in (an initiative's own board). Its board shows no initiative filter or tags. */
  newTaskInitiativeId?: string | null;
  emptyTitle?: string;
  emptyDescription?: { canCreate: string; cannot: string };
  onOpenTask: (taskId: string) => void;
  onDeleteTask: (taskId: string) => void;
}) {
  const { isDemoMode } = useDemo();
  const { access, teamMemberId } = useAuth();
  const canManageTasks = canManageAllTasks(access);
  const canCreateTasks = hasPermission(access, 'tasks.create');
  const {
    getProject, getTasksByProject, team, deleteTask, updateTask, reorderTasks, filters, setFilters, tasks,
  } = useApp();
  const cardUnread = useCardUnread();
  const project = getProject(projectId);
  const scoped = !!newTaskInitiativeId;

  const [viewMode, setViewMode] = useState<ViewMode>('board');
  // A new task being drafted in the side panel, with a calendar day's date when it came from one.
  const [newTask, setNewTask] = useState<{ dueDate?: string } | null>(null);
  const [usingTemplate, setUsingTemplate] = useState<string | null>(null);
  const [managingTemplates, setManagingTemplates] = useState(false);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(new Set());
  const [showBulkMenu, setShowBulkMenu] = useState(false);
  const bulkMenuRef = useRef<HTMLDivElement>(null);
  // Clearing due dates wipes data with no undo, so it confirms first; it
  // already cost real due dates to an accidental click.
  const [confirmClearDueDates, setConfirmClearDueDates] = useState(false);
  const [bulkMove, setBulkMove] = useState(false);

  // The project's live initiatives: the filter's choices and the tags' names.
  // An initiative's own board needs neither.
  const initiativesRead = useRead(scoped ? null : projectInitiativesRead(projectId, isDemoMode));
  const initiatives = useMemo(() => sortInitiatives(initiativesRead.data ?? []), [initiativesRead.data]);
  const initiativeNames = useMemo(
    () => (scoped ? NO_INITIATIVES : new Map(initiatives.map((initiative) => [initiative.id, initiative.name]))),
    [scoped, initiatives],
  );

  const keep = taskFilter ?? (() => true);
  // The whole column, every task of the project: a drag resequences it all,
  // so tasks these views hide keep a valid, stable position.
  const columnTasks = getTasksByProject(projectId);
  // Unfiltered tasks for these views: the top-level ones they cover.
  const allProjectTasks = columnTasks.filter(keep);
  // With their subtasks, which open in the panel and turn up in a search.
  const everyProjectTask = tasks.filter(t => t.project_id === projectId && keep(t));

  // Filtered tasks for the views. Looking for someone's work or a word also
  // finds subtasks, which name their parent on the card.
  const findsSubtasks = !!filters.search || filters.assigneeIds.length > 0;
  let projectTasks = [...(findsSubtasks ? everyProjectTask : allProjectTasks)];
  if (filters.unread) {
    projectTasks = projectTasks.filter((task) => !!cardUnread(task));
  }
  if (filters.status.length > 0) {
    projectTasks = projectTasks.filter(t => filters.status.includes(t.status));
  }
  if (filters.priority.length > 0) {
    projectTasks = projectTasks.filter(t => filters.priority.includes(t.priority));
  }
  if (filters.assigneeIds.length > 0) {
    projectTasks = projectTasks.filter(t =>
      (filters.assigneeIds.includes(UNASSIGNED_FILTER_ID) && t.assignee_ids.length === 0) ||
      t.assignee_ids.some(id => filters.assigneeIds.includes(id)));
  }
  const initiativeIds = scoped ? [] : filters.initiativeIds ?? [];
  if (initiativeIds.length > 0) {
    // One in Trash reads as none, like everywhere else.
    projectTasks = projectTasks.filter(t => {
      const live = t.initiative_id && initiativeNames.has(t.initiative_id) ? t.initiative_id : null;
      return live ? initiativeIds.includes(live) : initiativeIds.includes(NO_INITIATIVE_FILTER_ID);
    });
  }
  if (filters.tags.length > 0) {
    projectTasks = projectTasks.filter(t => t.tags.some(tag => filters.tags.includes(tag)));
  }
  if (filters.search) {
    const search = filters.search.toLowerCase();
    projectTasks = projectTasks.filter(t =>
      t.title.toLowerCase().includes(search) ||
      t.description.toLowerCase().includes(search)
    );
  }

  if (!project) return null;

  const handleViewTask = (task: Task) => onOpenTask(task.id);

  // Recomputes sort_order for a status column after a drag. The drop index
  // refers to the filtered (visible) list, but the whole unfiltered column is
  // resequenced so hidden tasks keep a valid, stable position.
  const reorderColumn = (taskId: string, status: Task['status'], visibleIndex: number) => {
    const bySort = (a: Task, b: Task) => (a.sort_order ?? 0) - (b.sort_order ?? 0);
    const task = columnTasks.find(t => t.id === taskId);
    if (!task) return;

    const visibleSiblings = projectTasks
      .filter(t => t.id !== taskId && t.status === status && !t.parent_task_id)
      .sort(bySort);
    const allSiblings = columnTasks
      .filter(t => t.id !== taskId && t.status === status)
      .sort(bySort);

    // Map the visible drop position onto the unfiltered column: insert before
    // the visible task now at that position, or at the end of the column.
    const clamped = Math.min(visibleIndex, visibleSiblings.length);
    const anchor = visibleSiblings[clamped];
    const insertAt = anchor ? allSiblings.findIndex(t => t.id === anchor.id) : allSiblings.length;
    allSiblings.splice(insertAt, 0, task);

    // Each element still carries its pre-drag sort_order, so only rows whose
    // position actually changed are written
    reorderTasks(
      allSiblings
        .map((t, idx) => ({ task: t, sort_order: idx }))
        .filter(({ task: t, sort_order }) => (t.sort_order ?? 0) !== sort_order)
        .map(({ task: t, sort_order }) => ({ id: t.id, sort_order }))
    );
  };

  const handleStatusChange = (taskId: string, newStatus: Task['status'], targetIndex?: number) => {
    updateTask(taskId, { status: newStatus });

    // If a drop position was specified, reorder within the target column
    if (targetIndex !== undefined) {
      reorderColumn(taskId, newStatus, targetIndex);
    }
  };

  const handleReorder = (taskId: string, newIndex: number) => {
    const task = columnTasks.find(t => t.id === taskId);
    if (!task) return;
    reorderColumn(taskId, task.status, newIndex);
  };

  const toggleTaskSelection = (taskId: string) => {
    setSelectedTaskIds(prev => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  };

  const selectableTaskIds = projectTasks
    .filter(t => canEditTask(access, t, teamMemberId))
    .map(t => t.id);
  const allSelectableSelected = selectableTaskIds.length > 0
    && selectableTaskIds.every(id => selectedTaskIds.has(id));

  const selectAllTasks = () => {
    setSelectedTaskIds(allSelectableSelected ? new Set() : new Set(selectableTaskIds));
  };

  // Every write is awaited, so the toast reports what actually saved. Tasks
  // that failed stay selected, ready for a retry on just those.
  const runBulk = async (verb: 'Updated' | 'Deleted', write: (id: string) => Promise<boolean>) => {
    const ids = [...selectedTaskIds];
    setShowBulkMenu(false);
    const results = await Promise.all(ids.map(write));
    const failedIds = ids.filter((_, index) => !results[index]);
    const saved = ids.length - failedIds.length;
    const count = (n: number) => `${n} ${n === 1 ? 'task' : 'tasks'}`;
    setSelectedTaskIds(new Set(failedIds));
    if (failedIds.length === 0) {
      toast('success', verb === 'Deleted' ? `Moved ${count(saved)} to Trash` : `${verb} ${count(saved)}`);
    } else if (saved === 0) {
      toast('error', verb === 'Deleted' ? `Couldn't move ${count(failedIds.length)} to Trash` : `Couldn't update ${count(failedIds.length)}`);
    } else {
      const done = verb === 'Deleted' ? `Moved ${count(saved)} to Trash` : `${verb} ${count(saved)}`;
      toast('error', `${done}. ${count(failedIds.length)} failed and ${failedIds.length === 1 ? 'is' : 'are'} still selected.`);
    }
  };

  const bulkUpdateStatus = (status: Task['status']) =>
    runBulk('Updated', id => updateTask(id, { status }, { silent: true }));

  const bulkUpdatePriority = (priority: Task['priority']) =>
    runBulk('Updated', id => updateTask(id, { priority }, { silent: true }));

  const bulkAssign = (memberId: string | null) =>
    runBulk('Updated', id => updateTask(id, { assignee_ids: memberId ? [memberId] : [] }, { silent: true }));

  const bulkSetDueDate = (date: string | null) =>
    runBulk('Updated', id => updateTask(id, { due_date: date }, { silent: true }));

  // A subtask follows its parent, so only top-level tasks change initiative from a selection.
  const bulkSetInitiative = (initiativeId: string | null) => {
    const topLevel = new Set(tasks.filter(t => selectedTaskIds.has(t.id) && !t.parent_task_id).map(t => t.id));
    return runBulk('Updated', id => (topLevel.has(id) ? updateTask(id, { initiative_id: initiativeId }, { silent: true }) : Promise.resolve(true)));
  };

  // A subtask moves with its parent, so only top-level tasks move from a selection.
  const bulkMovable = canCreateTasks
    ? tasks.filter(t => selectedTaskIds.has(t.id) && !t.parent_task_id).map(t => ({ id: t.id, title: t.title, project_id: t.project_id }))
    : [];

  const clearSelection = () => {
    setSelectedTaskIds(new Set());
    setShowBulkMenu(false);
  };

  const liveInitiatives = initiatives.filter((initiative) => initiative.status !== 'done');

  return (
    <InitiativeNamesProvider names={initiativeNames}>
      {/* Tasks toolbar: the shared tab toolbar, search first */}
      <TabToolbar
        search={{
          value: filters.search,
          onChange: v => setFilters({ ...filters, search: v }),
          placeholder: 'Search tasks',
        }}
        filters={allProjectTasks.length > 0 && (
          <SubNav
            label="Task view"
            active={viewMode}
            onChange={setViewMode}
            items={viewModes.map(mode => ({ key: mode.id, label: mode.label, icon: mode.icon, hideLabelOnMobile: true }))}
          />
        )}
        extra={<>
          {/* Selection is a desktop-only gesture: the mobile cards have no
              checkboxes, so offering Select all there would select rows the
              user cannot see or unpick individually. */}
          {selectableTaskIds.length > 0 && viewMode === 'list' && (
            <button
              onClick={selectAllTasks}
              className="hidden lg:inline text-xs text-brand-300 hover:text-brand-300 transition-colors"
            >
              {allSelectableSelected ? 'Deselect all' : 'Select all'}
            </button>
          )}
          {/* Bulk Actions (desktop-only, like the selection that feeds it) */}
          {selectedTaskIds.size > 0 && (
            <div ref={bulkMenuRef} className="relative hidden lg:block">
              <button
                onClick={() => setShowBulkMenu(!showBulkMenu)}
                className="h-9 flex items-center gap-2 px-3 text-sm bg-brand-500/15 text-brand-300 border border-brand-500/30 rounded-lg hover:bg-brand-500/15 transition-colors"
              >
                {selectedTaskIds.size} selected
                <ChevronRight size={14} className="rotate-90" />
              </button>
              <Popover
                anchorRef={bulkMenuRef}
                open={showBulkMenu}
                onClose={() => setShowBulkMenu(false)}
                align="start"
                width={248}
                className="bg-surface-raised rounded-lg shadow-xl border border-white/[0.08] py-1 max-h-[70vh] overflow-y-auto"
              >
                {/* Same escape hatch the filter panel offers: back out of a
                    half-committed bulk edit in one click. */}
                <div className="flex items-center justify-between px-3 py-1.5 border-b border-white/[0.06] mb-1">
                  <span className="text-xs font-medium text-zinc-300">{selectedTaskIds.size} selected</span>
                  <button
                    onClick={clearSelection}
                    className="text-xs text-brand-300 hover:text-brand-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500 rounded"
                  >
                    Clear selection
                  </button>
                </div>
                <p className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Set Status</p>
                <div className="grid grid-cols-2 gap-1 px-2 pb-1">
                  {(['backlog', 'todo', 'in_progress', 'in_review', 'done'] as const).map(s => (
                    <button key={s} onClick={() => bulkUpdateStatus(s)} className="text-left px-2 py-1.5 text-sm text-zinc-300 rounded-md hover:bg-white/[0.06]">
                      {s.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase())}
                    </button>
                  ))}
                </div>
                <div className="border-t border-white/[0.06] my-1" />
                <p className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Set Priority</p>
                <div className="grid grid-cols-2 gap-1 px-2 pb-1">
                  {(['low', 'medium', 'high', 'urgent'] as const).map(p => (
                    <button key={p} onClick={() => bulkUpdatePriority(p)} className="text-left px-2 py-1.5 text-sm text-zinc-300 rounded-md hover:bg-white/[0.06]">
                      {p.charAt(0).toUpperCase() + p.slice(1)}
                    </button>
                  ))}
                </div>
                {canManageTasks && <>
                  <div className="border-t border-white/[0.06] my-1" />
                  <p className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Assign To</p>
                  {team.filter(m => canBeAssignedInProject(m, project)).map(member => (
                    <button key={member.id} onClick={() => bulkAssign(member.id)} className="w-full flex items-center gap-2 text-left px-3 py-1.5 text-sm text-zinc-300 hover:bg-white/[0.03]">
                      <Avatar name={member.name} src={member.avatar || undefined} size="xs" />
                      {member.name}
                    </button>
                  ))}
                  <button onClick={() => bulkAssign(null)} className="w-full text-left px-3 py-1.5 text-sm text-zinc-400 hover:bg-white/[0.03]">
                    Unassign all
                  </button>
                </>}
                {!scoped && liveInitiatives.length > 0 && <>
                  <div className="border-t border-white/[0.06] my-1" />
                  <p className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">{INITIATIVE_LABEL.singular}</p>
                  {liveInitiatives.map(initiative => (
                    <button key={initiative.id} onClick={() => bulkSetInitiative(initiative.id)} className="w-full truncate text-left px-3 py-1.5 text-sm text-zinc-300 hover:bg-white/[0.03]">
                      {initiative.name}
                    </button>
                  ))}
                  <button onClick={() => bulkSetInitiative(null)} className="w-full text-left px-3 py-1.5 text-sm text-zinc-400 hover:bg-white/[0.03]">
                    No {INITIATIVE_LABEL.lower}
                  </button>
                </>}
                <div className="border-t border-white/[0.06] my-1" />
                <p className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Due Date</p>
                <div className="px-3 pb-1.5">
                  <DateInput value="" onChange={v => { if (v) bulkSetDueDate(v); }} />
                </div>
                <button onClick={() => { setShowBulkMenu(false); setConfirmClearDueDates(true); }} className="w-full text-left px-3 py-1.5 text-sm text-zinc-400 hover:bg-white/[0.03]">
                  Clear due date
                </button>
                {bulkMovable.length > 0 && <>
                  <div className="border-t border-white/[0.06] my-1" />
                  <button onClick={() => { setShowBulkMenu(false); setBulkMove(true); }} className="w-full flex items-center gap-2 text-left px-3 py-1.5 text-sm text-zinc-300 hover:bg-white/[0.03]">
                    <FolderInput size={14} aria-hidden="true" />
                    {bulkMovable.length === selectedTaskIds.size ? 'Move to project...' : `Move ${bulkMovable.length} to project...`}
                  </button>
                </>}
                {canManageTasks && <>
                  <div className="border-t border-white/[0.06] my-1" />
                  <button onClick={() => setConfirmBulkDelete(true)} className="w-full text-left px-3 py-1.5 text-sm text-red-400 hover:bg-red-500/15">
                    Delete selected
                  </button>
                </>}
              </Popover>
              {bulkMove && bulkMovable.length > 0 && (
                <TaskMoveDialog
                  tasks={bulkMovable}
                  onClose={() => setBulkMove(false)}
                  onMoved={() => setSelectedTaskIds(new Set())}
                />
              )}
            </div>
          )}
        </>}
        actions={<>
          {allProjectTasks.length > 0 && (
            <TaskFilterControl tasks={allProjectTasks} initiatives={scoped ? undefined : initiatives} />
          )}
        </>}
        primary={canCreateTasks && (
          <>
            {/* Tasks from a template land in no initiative, so an initiative's board offers only Add task. */}
            {!scoped && (
              <TemplatePicker
                projectId={projectId}
                onPick={(template) => setUsingTemplate(template.id)}
                onManage={() => setManagingTemplates(true)}
                trigger={({ open, toggle }) => (
                  <ToolbarButton variant="secondary" icon={<LayoutTemplate />} label="From a template" onClick={toggle} aria-expanded={open} aria-haspopup="listbox" />
                )}
              />
            )}
            <ToolbarButton icon={<Plus />} label="Add task" onClick={() => setNewTask({})} />
          </>
        )}
      />

      <UnreadNotice tasks={allProjectTasks} />

      {/* Task Views */}
      {allProjectTasks.length === 0 ? (
        <EmptyCard
          icon={<LayoutGrid />}
          title={emptyTitle}
          description={canCreateTasks
            ? emptyDescription?.canCreate ?? 'Use Add task to create the first one.'
            : emptyDescription?.cannot ?? 'Tasks for this project will list here.'}
        />
      ) : projectTasks.length === 0 ? (
        <div className="glass-card rounded-xl"><NoMatches>No tasks match.</NoMatches></div>
      ) : (
        <>
          {viewMode === 'board' && (
            <BoardView
              tasks={projectTasks}
              onViewTask={handleViewTask}
              onDeleteTask={onDeleteTask}
              onStatusChange={handleStatusChange}
              onReorder={handleReorder}
            />
          )}

          {viewMode === 'list' && (
            <ListView
              tasks={projectTasks}
              onViewTask={handleViewTask}
              onDeleteTask={onDeleteTask}
              selectedIds={selectedTaskIds}
              onToggleSelect={toggleTaskSelection}
              onStatusChange={handleStatusChange}
              onReorder={handleReorder}
            />
          )}

          {viewMode === 'calendar' && (
            <CalendarView
              tasks={projectTasks}
              onViewTask={handleViewTask}
              onAddTask={canCreateTasks ? (date) => setNewTask({ dueDate: date }) : undefined}
            />
          )}
        </>
      )}

      {/* A new task, drafted in the side panel; once made, its own panel takes over. */}
      {newTask && (
        <NewTaskPanel
          projectId={projectId}
          initialDueDate={newTask.dueDate}
          initialInitiativeId={newTaskInitiativeId}
          onClose={() => setNewTask(null)}
          onCreated={(task) => {
            setNewTask(null);
            onOpenTask(task.id);
          }}
        />
      )}

      {/* Tasks from a template, previewed and filled in the same side panel. */}
      {usingTemplate && (
        <UseTemplatePanel
          templateId={usingTemplate}
          projectId={projectId}
          onClose={() => setUsingTemplate(null)}
        />
      )}
      {/* The project's own templates, from "Manage templates" at the picker's foot. */}
      {managingTemplates && <ProjectTemplatesPanel projectId={projectId} onClose={() => setManagingTemplates(false)} />}

      <ConfirmDialog
        isOpen={confirmBulkDelete}
        onClose={() => setConfirmBulkDelete(false)}
        onConfirm={() => { void runBulk('Deleted', id => deleteTask(id, { silent: true })); }}
        title="Move tasks to Trash?"
        message={`The ${selectedTaskIds.size} selected ${selectedTaskIds.size === 1 ? 'task goes' : 'tasks go'} to Trash with their subtasks and comments.`}
        variant="danger"
        trash
      />

      {/* Confirm Clear Due Dates: destructive but recoverable by re-entering
          dates, so the softer variant without double-confirm. */}
      <ConfirmDialog
        isOpen={confirmClearDueDates}
        onClose={() => setConfirmClearDueDates(false)}
        onConfirm={() => {
          setConfirmClearDueDates(false);
          bulkSetDueDate(null);
        }}
        title="Clear Due Dates"
        message={`This will remove the due date from ${selectedTaskIds.size} selected ${selectedTaskIds.size === 1 ? 'task' : 'tasks'}.`}
        confirmLabel="Clear due dates"
        variant="default"
      />
    </InitiativeNamesProvider>
  );
}
