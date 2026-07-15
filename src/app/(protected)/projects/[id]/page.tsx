'use client';

import { useState, useMemo, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useApp, defaultFilters } from '@/lib/store';
import { Header } from '@/components/layout/Header';
import { BoardView } from '@/components/views/BoardView';
import { ListView } from '@/components/views/ListView';
import { CalendarView } from '@/components/views/CalendarView';
import { TaskForm } from '@/components/tasks/TaskForm';
import { TaskDetailPanel } from '@/components/tasks/TaskDetailPanel';
import { ProjectForm } from '@/components/projects/ProjectForm';
import { ProjectContactsPanel } from '@/components/projects/ProjectContactsPanel';
import { PortalSettingsPanel } from '@/components/projects/PortalSettingsPanel';
import { ClientCommunicationsPanel } from '@/components/projects/ClientCommunicationsPanel';
import { ClientCommunicationsLogPanel } from '@/components/projects/ClientCommunicationsLogPanel';
import { PortalUpdatesPanel } from '@/components/projects/PortalUpdatesPanel';
import { TimeTrackingPanel } from '@/components/projects/TimeTrackingPanel';
import { CredentialsPanel } from '@/components/projects/CredentialsPanel';
import InvoicesPanel from '@/components/projects/InvoicesPanel';
import { FileAttachments } from '@/components/ui/FileAttachments';
import { DateInput } from '@/components/ui/inputs/DateInput';
import { Button } from '@/components/ui/Button';
import { StatusBadge } from '@/components/ui/Badge';
import { Avatar, AvatarGroup } from '@/components/ui/Avatar';
import { toast } from '@/components/ui/Toast';
import {
  Plus, LayoutGrid, List, Calendar,
  Edit, Trash2, CalendarDays, Clock, Users, UserCircle, ChevronRight,
} from 'lucide-react';
import { Task, ViewMode, TeamMember } from '@/lib/types';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Tooltip } from '@/components/ui/Tooltip';
import { siteConfig } from '@/site-config';

export default function ProjectDetailPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;

  const {
    getProject, getTasksByProject, getTeamMember,
    getContactsByProject,
    deleteTask, deleteProject, updateTask, reorderTasks, updateProject, filters, setFilters,
  } = useApp();

  useEffect(() => { setFilters(defaultFilters); }, []);

  const [viewMode, setViewMode] = useState<ViewMode>('board');
  const [commsRefreshKey, setCommsRefreshKey] = useState(0);
  const [isTaskFormOpen, setIsTaskFormOpen] = useState(false);
  const [isEditProjectOpen, setIsEditProjectOpen] = useState(false);
  const [isContactsPanelOpen, setIsContactsPanelOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [viewingTaskId, setViewingTaskId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ type: 'task' | 'project' | 'bulk'; id: string } | null>(null);
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(new Set());
  const [showBulkMenu, setShowBulkMenu] = useState(false);

  const project = getProject(projectId);

  // Unfiltered tasks for stats / progress bar
  const allProjectTasks = getTasksByProject(projectId);

  // Derive viewingTask from store so it stays in sync with subtask/comment changes
  const viewingTask = useMemo(() => {
    if (!viewingTaskId) return null;
    return allProjectTasks.find(t => t.id === viewingTaskId) || null;
  }, [viewingTaskId, allProjectTasks]);

  // Filtered tasks for the views
  let projectTasks = [...allProjectTasks];
  if (filters.status.length > 0) {
    projectTasks = projectTasks.filter(t => filters.status.includes(t.status));
  }
  if (filters.priority.length > 0) {
    projectTasks = projectTasks.filter(t => filters.priority.includes(t.priority));
  }
  if (filters.assigneeIds.length > 0) {
    projectTasks = projectTasks.filter(t => t.assignee_ids.some(id => filters.assigneeIds.includes(id)));
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

  if (!project) {
    return (
      <div className="animate-fadeIn min-h-screen bg-zinc-50">
        <Header title="Project Not Found" />
        <div className="p-6 text-center">
          <p className="text-zinc-500 mb-4">This project doesn&apos;t exist</p>
          <Link href="/projects">
            <Button variant="secondary">Back to Projects</Button>
          </Link>
        </div>
      </div>
    );
  }

  // Derived data
  const projectMembers = (project.member_ids || [])
    .map(id => getTeamMember(id))
    .filter(Boolean) as TeamMember[];
  const projectContactsList = getContactsByProject(projectId);
  const doneTasks = allProjectTasks.filter(t => t.status === 'done').length;
  const progressPercent = allProjectTasks.length > 0
    ? Math.round((doneTasks / allProjectTasks.length) * 100)
    : 0;

  const handleViewTask = (task: Task) => {
    setViewingTaskId(task.id);
  };

  const handleEditTask = (task: Task) => {
    setViewingTaskId(null);
    setEditingTask(task);
    setIsTaskFormOpen(true);
  };

  const handleDeleteTask = (id: string) => {
    setConfirmDelete({ type: 'task', id });
  };

  // Recomputes sort_order for a status column after a drag. The drop index
  // refers to the filtered (visible) list, but the whole unfiltered column is
  // resequenced so hidden tasks keep a valid, stable position.
  const reorderColumn = (taskId: string, status: Task['status'], visibleIndex: number) => {
    const bySort = (a: Task, b: Task) => (a.sort_order ?? 0) - (b.sort_order ?? 0);
    const task = allProjectTasks.find(t => t.id === taskId);
    if (!task) return;

    const visibleSiblings = projectTasks
      .filter(t => t.id !== taskId && t.status === status)
      .sort(bySort);
    const allSiblings = allProjectTasks
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
    const task = allProjectTasks.find(t => t.id === taskId);
    if (!task) return;
    reorderColumn(taskId, task.status, newIndex);
  };

  const handleCloseTaskForm = () => {
    setIsTaskFormOpen(false);
    setEditingTask(null);
  };

  const handleDeleteProject = () => {
    setConfirmDelete({ type: 'project', id: projectId });
  };

  const toggleTaskSelection = (taskId: string) => {
    setSelectedTaskIds(prev => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  };

  const selectAllTasks = () => {
    if (selectedTaskIds.size === projectTasks.length) {
      setSelectedTaskIds(new Set());
    } else {
      setSelectedTaskIds(new Set(projectTasks.map(t => t.id)));
    }
  };

  const bulkUpdateStatus = (status: Task['status']) => {
    selectedTaskIds.forEach(id => updateTask(id, { status }));
    toast('success', `Updated ${selectedTaskIds.size} tasks`);
    setSelectedTaskIds(new Set());
    setShowBulkMenu(false);
  };

  const bulkUpdatePriority = (priority: Task['priority']) => {
    selectedTaskIds.forEach(id => updateTask(id, { priority }));
    toast('success', `Updated ${selectedTaskIds.size} tasks`);
    setSelectedTaskIds(new Set());
    setShowBulkMenu(false);
  };

  const bulkDelete = () => {
    setConfirmDelete({ type: 'bulk', id: 'bulk' });
  };

  const executeDelete = () => {
    if (!confirmDelete) return;
    if (confirmDelete.type === 'task') {
      deleteTask(confirmDelete.id);
    } else if (confirmDelete.type === 'bulk') {
      selectedTaskIds.forEach(id => deleteTask(id));
      toast('success', `Deleted ${selectedTaskIds.size} tasks`);
      setSelectedTaskIds(new Set());
    } else {
      deleteProject(confirmDelete.id);
      toast('success', 'Project deleted');
      router.push('/projects');
    }
  };

  const viewModes: { id: ViewMode; icon: typeof LayoutGrid; label: string }[] = [
    { id: 'board', icon: LayoutGrid, label: 'Board' },
    { id: 'list', icon: List, label: 'List' },
    { id: 'calendar', icon: Calendar, label: 'Calendar' },
  ];

  return (
    <div className="animate-fadeIn min-h-screen bg-zinc-50">
      {/* Header */}
      <Header
        title={project.name}
        subtitle={
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {project.color && (
              <span
                className="hidden md:inline-block w-2.5 h-2.5 rounded-full flex-shrink-0"
                style={{ backgroundColor: project.color }}
              />
            )}
            <StatusBadge status={project.status} />
            {project.description && (
              <span className="hidden md:inline text-zinc-500">
                {project.description}
              </span>
            )}
          </div>
        }
        actions={
          <Button
            variant="secondary"
            icon={<Edit size={16} />}
            onClick={() => setIsEditProjectOpen(true)}
          >
            <span className="hidden sm:inline">Edit</span>
          </Button>
        }
      />

      {/* Overview Card */}
      <div className="px-4 lg:px-6 pt-4 lg:pt-6">
        <div className="bg-white rounded-xl border border-zinc-200 p-5 lg:p-6">
          {/* Info Grid */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 lg:gap-0">
            {/* Start Date */}
            <div className="flex items-center gap-2.5 lg:pr-5">
              <div className="p-1.5 bg-zinc-100 rounded-md">
                <CalendarDays size={14} className="text-zinc-500" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs text-zinc-500 font-medium">Start Date</p>
                <DateInput
                  value={project.start_date || ''}
                  onChange={(v) => updateProject(projectId, { start_date: v || null })}
                  placeholder="Not set"
                  size="sm"
                  clearable
                  inputClassName="!w-fit !justify-start !gap-1 !border-transparent !bg-transparent !shadow-none hover:!bg-zinc-100 focus:!ring-0 focus:!border-transparent !px-1.5 !-mx-1.5 !py-0.5 !rounded-md"
                />
              </div>
            </div>

            {/* Due Date */}
            <div className="flex items-center gap-2.5 lg:border-l lg:border-zinc-200 lg:pl-5 lg:pr-5">
              <div className="p-1.5 bg-zinc-100 rounded-md">
                <Clock size={14} className="text-zinc-500" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs text-zinc-500 font-medium">Due Date</p>
                <DateInput
                  value={project.due_date || ''}
                  onChange={(v) => updateProject(projectId, { due_date: v || null })}
                  placeholder="Not set"
                  size="sm"
                  minDate={project.start_date || undefined}
                  clearable
                  inputClassName="!w-fit !justify-start !gap-1 !border-transparent !bg-transparent !shadow-none hover:!bg-zinc-100 focus:!ring-0 focus:!border-transparent !px-1.5 !-mx-1.5 !py-0.5 !rounded-md"
                />
              </div>
            </div>

            {/* Team */}
            <div className="flex items-center gap-2.5 lg:border-l lg:border-zinc-200 lg:pl-5 lg:pr-5">
              <div className="p-1.5 bg-zinc-100 rounded-md">
                <Users size={14} className="text-zinc-500" />
              </div>
              <div>
                <p className="text-xs text-zinc-500 font-medium">Team</p>
                {projectMembers.length > 0 ? (
                  <button onClick={() => setIsEditProjectOpen(true)} className="group">
                    <AvatarGroup
                      users={projectMembers.map(m => ({ id: m.id, name: m.name, avatar: m.avatar }))}
                      max={4}
                      size="xs"
                    />
                  </button>
                ) : (
                  <button
                    onClick={() => setIsEditProjectOpen(true)}
                    className="text-sm text-zinc-400 hover:text-brand-600 transition-colors"
                  >
                    Add members...
                  </button>
                )}
              </div>
            </div>

            {/* Contacts */}
            <div className="flex items-center gap-2.5 lg:border-l lg:border-zinc-200 lg:pl-5">
              <div className="p-1.5 bg-zinc-100 rounded-md">
                <UserCircle size={14} className="text-zinc-500" />
              </div>
              <div>
                <p className="text-xs text-zinc-500 font-medium">Contacts</p>
                {projectContactsList.length > 0 ? (
                  <button onClick={() => setIsContactsPanelOpen(true)} className="group">
                    <div className="flex items-center -space-x-1.5">
                      {projectContactsList.slice(0, 4).map((pc) => (
                        <Tooltip key={pc.id} content={`${pc.contact?.name || 'Contact'} (${pc.role})`}>
                          <Avatar name={pc.contact?.name || '?'} src={pc.contact?.avatar_url || undefined} size="sm" className="ring-2 ring-white" />
                        </Tooltip>
                      ))}
                      {projectContactsList.length > 4 && (
                        <div className="w-6 h-6 rounded-full flex items-center justify-center bg-zinc-200 text-zinc-600 text-[10px] font-medium ring-2 ring-white">
                          +{projectContactsList.length - 4}
                        </div>
                      )}
                    </div>
                  </button>
                ) : (
                  <button
                    onClick={() => setIsContactsPanelOpen(true)}
                    className="text-sm text-zinc-400 hover:text-brand-600 transition-colors"
                  >
                    Add contacts...
                  </button>
                )}
              </div>
            </div>
          </div>

        </div>
      </div>

      {/* Tasks Section */}
      <div className="px-4 lg:px-6 pt-4 lg:pt-6 pb-4 lg:pb-6">
        {/* Tasks Section Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-3">
            <h2 className="text-base font-semibold text-zinc-900">
              Tasks ({allProjectTasks.length})
            </h2>
            {allProjectTasks.length > 0 && (
              <div className="hidden lg:flex items-center gap-2">
                <div className="w-20 h-1.5 bg-zinc-100 rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{
                      width: `${progressPercent}%`,
                      backgroundColor: project.color || '#A1A1AA',
                    }}
                  />
                </div>
                <span className="text-xs text-zinc-400">{progressPercent}%</span>
              </div>
            )}
            {projectTasks.length > 0 && viewMode === 'list' && (
              <button
                onClick={selectAllTasks}
                className="text-xs text-brand-600 hover:text-brand-700 transition-colors"
              >
                {selectedTaskIds.size === projectTasks.length ? 'Deselect all' : 'Select all'}
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* Bulk Actions */}
            {selectedTaskIds.size > 0 && (
              <div className="relative">
                <button
                  onClick={() => setShowBulkMenu(!showBulkMenu)}
                  className="flex items-center gap-2 px-3 py-1.5 text-sm bg-brand-50 text-brand-700 border border-brand-200 rounded-lg hover:bg-brand-100 transition-colors"
                >
                  {selectedTaskIds.size} selected
                  <ChevronRight size={14} className="rotate-90" />
                </button>
                {showBulkMenu && (
                  <>
                    <div className="fixed inset-0 z-10 cursor-default" onClick={(e) => { e.stopPropagation(); setShowBulkMenu(false); }} />
                    <div className="absolute right-0 top-10 bg-white rounded-lg shadow-xl border border-zinc-200 py-1 z-20 min-w-[200px] cursor-pointer">
                      <p className="px-3 py-1.5 text-xs font-medium text-zinc-500 uppercase">Set Status</p>
                      {(['todo', 'in_progress', 'in_review', 'done'] as const).map(s => (
                        <button key={s} onClick={() => bulkUpdateStatus(s)} className="w-full text-left px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50">
                          {s.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase())}
                        </button>
                      ))}
                      <div className="border-t border-zinc-100 my-1" />
                      <p className="px-3 py-1.5 text-xs font-medium text-zinc-500 uppercase">Set Priority</p>
                      {(['low', 'medium', 'high', 'urgent'] as const).map(p => (
                        <button key={p} onClick={() => bulkUpdatePriority(p)} className="w-full text-left px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50">
                          {p.charAt(0).toUpperCase() + p.slice(1)}
                        </button>
                      ))}
                      <div className="border-t border-zinc-100 my-1" />
                      <button onClick={bulkDelete} className="w-full text-left px-3 py-1.5 text-sm text-red-600 hover:bg-red-50">
                        Delete selected
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* View Mode Toggle */}
            {allProjectTasks.length > 0 && (
              <div className="flex items-center bg-zinc-100 rounded-lg p-1 overflow-x-auto">
                {viewModes.map((mode) => (
                  <button
                    key={mode.id}
                    onClick={() => setViewMode(mode.id)}
                    className={`flex items-center gap-1.5 px-2 lg:px-3 py-1.5 rounded-md text-sm font-medium transition-all whitespace-nowrap ${
                      viewMode === mode.id
                        ? 'bg-white text-zinc-900 shadow-sm'
                        : 'text-zinc-500 hover:text-zinc-700'
                    }`}
                  >
                    <mode.icon size={16} />
                    <span className="hidden sm:inline">{mode.label}</span>
                  </button>
                ))}
              </div>
            )}

            <Button
              onClick={() => setIsTaskFormOpen(true)}
              icon={<Plus size={16} />}
              className="whitespace-nowrap"
            >
              <span className="hidden sm:inline">Add Task</span>
            </Button>
          </div>
        </div>

        {/* Task Views */}
        {projectTasks.length === 0 ? (
          <div className="bg-white rounded-xl border border-zinc-200 flex flex-col items-center justify-center p-8 text-center">
            <div className="w-10 h-10 rounded-full bg-zinc-100 flex items-center justify-center mb-3">
              <LayoutGrid size={18} className="text-zinc-400" />
            </div>
            <p className="text-sm font-medium text-zinc-500">No tasks yet</p>
            <p className="text-xs text-zinc-400 mt-1">Create your first task to get started</p>
          </div>
        ) : (
          <>
            {viewMode === 'board' && (
              <BoardView
                tasks={projectTasks}
                onViewTask={handleViewTask}
                onEditTask={handleEditTask}
                onDeleteTask={handleDeleteTask}
                onStatusChange={handleStatusChange}
                onReorder={handleReorder}
              />
            )}

            {viewMode === 'list' && (
              <ListView
                tasks={projectTasks}
                onViewTask={handleViewTask}
                onEditTask={handleEditTask}
                onDeleteTask={handleDeleteTask}
                selectedIds={selectedTaskIds}
                onToggleSelect={toggleTaskSelection}
              />
            )}

            {viewMode === 'calendar' && (
              <CalendarView
                tasks={projectTasks}
                onViewTask={handleViewTask}
                onEditTask={handleEditTask}
              />
            )}
          </>
        )}
      </div>

      {/* Management sections: 2-column grid when time tracking enabled */}
      <div className="px-4 lg:px-6 pb-4 lg:pb-6">
        <div className={`grid grid-cols-1 ${project.hourly_tracking ? 'lg:grid-cols-2' : ''} gap-6 items-stretch`}>
          {project.hourly_tracking && (
            <TimeTrackingPanel projectId={projectId} projectColor={project.color} />
          )}

          <FileAttachments entityType="project" entityId={projectId} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch mt-6">
          <PortalSettingsPanel projectId={projectId} />
          <PortalUpdatesPanel projectId={projectId} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch mt-6">
          <ClientCommunicationsPanel
            projectId={projectId}
            onSent={() => setCommsRefreshKey(k => k + 1)}
          />
          <ClientCommunicationsLogPanel
            projectId={projectId}
            refreshSignal={commsRefreshKey}
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch mt-6">
          <CredentialsPanel projectId={projectId} />
          <InvoicesPanel projectId={projectId} projectColor={project.color} />
        </div>

      </div>

      {/* Delete Project */}
      <div className="px-4 lg:px-6 pb-6">
        <div className="flex justify-end">
          <Button variant="danger" onClick={handleDeleteProject} icon={<Trash2 size={16} />}>
            Delete Project
          </Button>
        </div>
      </div>

      {/* Edit Project Modal */}
      <ProjectForm
        isOpen={isEditProjectOpen}
        onClose={() => setIsEditProjectOpen(false)}
        project={project}
      />

      {/* Task Form Modal */}
      <TaskForm
        isOpen={isTaskFormOpen}
        onClose={handleCloseTaskForm}
        projectId={projectId}
        task={editingTask}
      />

      {/* Contacts Panel Modal */}
      <ProjectContactsPanel
        isOpen={isContactsPanelOpen}
        onClose={() => setIsContactsPanelOpen(false)}
        projectId={projectId}
      />

      {/* Task Detail Panel */}
      <TaskDetailPanel
        task={viewingTask}
        onClose={() => setViewingTaskId(null)}
        onEdit={handleEditTask}
        onDelete={handleDeleteTask}
      />

      {/* Confirm Delete Dialog */}
      <ConfirmDialog
        isOpen={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onConfirm={executeDelete}
        title={confirmDelete?.type === 'project' ? 'Delete Project' : confirmDelete?.type === 'bulk' ? 'Delete Selected Tasks' : 'Delete Task'}
        message={
          confirmDelete?.type === 'project'
            ? 'This will permanently delete the project and all its tasks. This action cannot be undone.'
            : confirmDelete?.type === 'bulk'
            ? `This will permanently delete ${selectedTaskIds.size} selected tasks. This action cannot be undone.`
            : 'This will permanently delete this task and all its subtasks and comments. This action cannot be undone.'
        }
        confirmLabel="Delete"
        variant="danger"
      />
    </div>
  );
}
