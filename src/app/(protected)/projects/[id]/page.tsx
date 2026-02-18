'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useApp } from '@/lib/store';
import { Header } from '@/components/layout/Header';
import { BoardView } from '@/components/views/BoardView';
import { ListView } from '@/components/views/ListView';
import { CalendarView } from '@/components/views/CalendarView';
import { TaskForm } from '@/components/tasks/TaskForm';
import { Button } from '@/components/ui/Button';
import { StatusBadge } from '@/components/ui/Badge';
import { AvatarGroup } from '@/components/ui/Avatar';
import { Plus, LayoutGrid, List, Calendar, ArrowLeft } from 'lucide-react';
import { Task, ViewMode } from '@/lib/types';
import Link from 'next/link';

export default function ProjectDetailPage() {
  const params = useParams();
  const projectId = params.id as string;
  
  const { getProject, getTasksByProject, deleteTask, filters } = useApp();
  
  const [viewMode, setViewMode] = useState<ViewMode>('board');
  const [isTaskFormOpen, setIsTaskFormOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);

  const project = getProject(projectId);
  let projectTasks = getTasksByProject(projectId);

  // Apply filters
  if (filters.status.length > 0) {
    projectTasks = projectTasks.filter(t => filters.status.includes(t.status));
  }
  if (filters.priority.length > 0) {
    projectTasks = projectTasks.filter(t => filters.priority.includes(t.priority));
  }
  if (filters.assigneeIds.length > 0) {
    projectTasks = projectTasks.filter(t => t.assignee_ids.some(id => filters.assigneeIds.includes(id)));
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
          <p className="text-zinc-500 mb-4">This project doesn't exist</p>
          <Link href="/projects">
            <Button variant="secondary">Back to Projects</Button>
          </Link>
        </div>
      </div>
    );
  }

  const members = project.member_ids ? [] : [];

  const handleEditTask = (task: Task) => {
    setEditingTask(task);
    setIsTaskFormOpen(true);
  };

  const handleDeleteTask = (id: string) => {
    if (confirm('Are you sure you want to delete this task?')) {
      deleteTask(id);
    }
  };

  const handleCloseTaskForm = () => {
    setIsTaskFormOpen(false);
    setEditingTask(null);
  };

  const viewModes: { id: ViewMode; icon: typeof LayoutGrid; label: string }[] = [
    { id: 'board', icon: LayoutGrid, label: 'Board' },
    { id: 'list', icon: List, label: 'List' },
    { id: 'calendar', icon: Calendar, label: 'Calendar' },
  ];

  const formatDate = (date: string | null) => {
    if (!date) return 'No due date';
    return new Date(date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  };

  return (
    <div className="animate-fadeIn min-h-screen bg-zinc-50">
      {/* Mobile back button */}
      <div className="lg:hidden px-4 pt-4 pb-2">
        <Link 
          href="/projects" 
          className="inline-flex items-center gap-1 text-sm text-zinc-600 hover:text-zinc-900"
        >
          <ArrowLeft size={16} />
          Back to Projects
        </Link>
      </div>
      
      <Header 
        title={project.name}
        subtitle={
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <StatusBadge status={project.status} />
            <span className="text-zinc-500">
              {projectTasks.length} tasks • {formatDate(project.due_date)}
            </span>
          </div>
        }
        actions={
          <div className="flex items-center gap-2">
            {/* View Mode Toggle - Scrollable on mobile */}
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
        }
      />

      {/* Project Description */}
      {project.description && (
        <div className="px-4 lg:px-6 py-3 bg-white border-b border-zinc-200">
          <p className="text-sm text-zinc-600">{project.description}</p>
        </div>
      )}

      {/* Tasks */}
      <div className="p-4 lg:p-6">
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
                onEditTask={handleEditTask}
                onDeleteTask={handleDeleteTask}
              />
            )}
            
            {viewMode === 'list' && (
              <ListView
                tasks={projectTasks}
                onEditTask={handleEditTask}
                onDeleteTask={handleDeleteTask}
              />
            )}
            
            {viewMode === 'calendar' && (
              <CalendarView
                tasks={projectTasks}
                onEditTask={handleEditTask}
              />
            )}
          </>
        )}
      </div>

      <TaskForm
        isOpen={isTaskFormOpen}
        onClose={handleCloseTaskForm}
        projectId={projectId}
        task={editingTask}
      />
    </div>
  );
}
