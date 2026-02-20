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
import { TimeTrackingPanel } from '@/components/projects/TimeTrackingPanel';
import { FileAttachments } from '@/components/ui/FileAttachments';
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

export default function ProjectDetailPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;

  const {
    getProject, getTasksByProject, getTeamMember,
    getContactsByProject,
    deleteTask, deleteProject, updateTask, filters, setFilters,
  } = useApp();

  useEffect(() => { setFilters(defaultFilters); }, []);

  const [viewMode, setViewMode] = useState<ViewMode>('board');
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

  const handleStatusChange = (taskId: string, newStatus: Task['status']) => {
    updateTask(taskId, { status: newStatus });
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

  const formatDate = (date: string | null) => {
    if (!date) return null;
    return new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
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
            <span
              className="hidden md:inline-block w-2.5 h-2.5 rounded-full flex-shrink-0"
              style={{ backgroundColor: project.color }}
            />
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
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
            {/* Start Date */}
            <div className="flex items-start gap-2.5">
              <div className="mt-0.5 p-1.5 bg-zinc-100 rounded-md">
                <CalendarDays size={14} className="text-zinc-500" />
              </div>
              <div>
                <p className="text-xs text-zinc-500 font-medium">Start Date</p>
                <p className="text-sm text-zinc-900">
                  {formatDate(project.start_date) || (
                    <button onClick={() => setIsEditProjectOpen(true)} className="text-indigo-600 hover:text-indigo-700 transition-colors">Not set</button>
                  )}
                </p>
              </div>
            </div>

            {/* Due Date */}
            <div className="flex items-start gap-2.5">
              <div className="mt-0.5 p-1.5 bg-zinc-100 rounded-md">
                <Clock size={14} className="text-zinc-500" />
              </div>
              <div>
                <p className="text-xs text-zinc-500 font-medium">Due Date</p>
                <p className="text-sm text-zinc-900">
                  {formatDate(project.due_date) || (
                    <button onClick={() => setIsEditProjectOpen(true)} className="text-indigo-600 hover:text-indigo-700 transition-colors">Not set</button>
                  )}
                </p>
              </div>
            </div>

            {/* Team */}
            <div className="flex items-start gap-2.5">
              <div className="mt-0.5 p-1.5 bg-zinc-100 rounded-md">
                <Users size={14} className="text-zinc-500" />
              </div>
              <div>
                <p className="text-xs text-zinc-500 font-medium mb-1">Team</p>
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
                    className="text-sm text-zinc-400 hover:text-indigo-600 transition-colors"
                  >
                    Add members...
                  </button>
                )}
              </div>
            </div>

            {/* Contacts */}
            <div className="flex items-start gap-2.5">
              <div className="mt-0.5 p-1.5 bg-zinc-100 rounded-md">
                <UserCircle size={14} className="text-zinc-500" />
              </div>
              <div>
                <p className="text-xs text-zinc-500 font-medium mb-1">Contacts</p>
                {projectContactsList.length > 0 ? (
                  <button onClick={() => setIsContactsPanelOpen(true)} className="group">
                    <div className="flex items-center -space-x-1.5">
                      {projectContactsList.slice(0, 4).map((pc) => (
                        <div
                          key={pc.id}
                          className="w-6 h-6 rounded-full flex items-center justify-center text-white text-[10px] font-medium ring-2 ring-white"
                          style={{ backgroundColor: pc.contact?.color || '#6366F1' }}
                          title={`${pc.contact?.name || 'Contact'} (${pc.role})`}
                        >
                          {pc.contact?.name?.charAt(0).toUpperCase() || '?'}
                        </div>
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
                    className="text-sm text-zinc-400 hover:text-indigo-600 transition-colors"
                  >
                    Add contacts...
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Progress Bar (only when tasks exist) */}
          {allProjectTasks.length > 0 && (
            <div className="mb-5">
              <div className="flex items-center justify-between mb-1.5">
                <p className="text-xs text-zinc-500 font-medium">Progress</p>
                <p className="text-xs text-zinc-500">
                  {doneTasks}/{allProjectTasks.length} tasks completed ({progressPercent}%)
                </p>
              </div>
              <div className="w-full h-2 bg-zinc-100 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{
                    width: `${progressPercent}%`,
                    backgroundColor: project.color,
                  }}
                />
              </div>
            </div>
          )}

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
            {projectTasks.length > 0 && viewMode === 'list' && (
              <button
                onClick={selectAllTasks}
                className="text-xs text-indigo-600 hover:text-indigo-700 transition-colors"
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
                  className="flex items-center gap-2 px-3 py-1.5 text-sm bg-indigo-50 text-indigo-700 border border-indigo-200 rounded-lg hover:bg-indigo-100 transition-colors"
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
          <div className="text-center py-12 bg-white rounded-xl border border-zinc-200">
            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-zinc-100 flex items-center justify-center">
              <LayoutGrid className="text-zinc-400" size={32} />
            </div>
            <h3 className="text-lg font-semibold text-zinc-900 mb-2">No tasks yet</h3>
            <p className="text-zinc-500 mb-4">Create your first task to get started</p>
            <Button onClick={() => setIsTaskFormOpen(true)}>
              Create Task
            </Button>
          </div>
        ) : (
          <>
            {viewMode === 'board' && (
              <BoardView
                tasks={projectTasks}
                onAddTask={() => setIsTaskFormOpen(true)}
                onViewTask={handleViewTask}
                onEditTask={handleEditTask}
                onDeleteTask={handleDeleteTask}
                onStatusChange={handleStatusChange}
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
        <div className={`grid grid-cols-1 ${project.hourly_tracking ? 'lg:grid-cols-2' : ''} gap-6 items-start`}>
          {project.hourly_tracking && (
            <TimeTrackingPanel projectId={projectId} projectColor={project.color} />
          )}

          <div className="space-y-6">
            <FileAttachments entityType="project" entityId={projectId} />
            <PortalSettingsPanel projectId={projectId} />
          </div>
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
