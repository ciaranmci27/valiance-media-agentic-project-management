'use client';

import { useState, useMemo } from 'react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { StatusBadge, PriorityBadge } from '@/components/ui/Badge';
import { AvatarGroup } from '@/components/ui/Avatar';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { TaskDetailPanel } from '@/components/tasks/TaskDetailPanel';
import { TaskForm } from '@/components/tasks/TaskForm';
import Link from 'next/link';
import {
  CheckSquare, Calendar, MessageSquare, FolderKanban, Filter,
  Edit, Trash2, MoreVertical,
} from 'lucide-react';
import { Task } from '@/lib/types';

type SortField = 'due_date' | 'priority' | 'status' | 'project' | 'updated_at';
type FilterTab = 'all' | 'active' | 'overdue';

const PRIORITY_ORDER: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
const STATUS_ORDER: Record<string, number> = { in_progress: 0, in_review: 1, todo: 2, done: 3 };

export default function MyTasksPage() {
  const { tasks, projects, team, deleteTask, updateTask } = useApp();
  const { teamMemberId } = useAuth();

  const [filterTab, setFilterTab] = useState<FilterTab>('active');
  const [sortField, setSortField] = useState<SortField>('priority');
  const [viewingTaskId, setViewingTaskId] = useState<string | null>(null);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [deletingTaskId, setDeletingTaskId] = useState<string | null>(null);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const myTasks = useMemo(() => {
    if (!teamMemberId) return [];
    return tasks.filter(t => t.assignee_ids.includes(teamMemberId));
  }, [tasks, teamMemberId]);

  const filteredTasks = useMemo(() => {
    let result = [...myTasks];

    if (filterTab === 'active') {
      result = result.filter(t => t.status !== 'done');
    } else if (filterTab === 'overdue') {
      result = result.filter(t => {
        if (!t.due_date || t.status === 'done') return false;
        const due = new Date(t.due_date);
        due.setHours(0, 0, 0, 0);
        return due < today;
      });
    }

    result.sort((a, b) => {
      switch (sortField) {
        case 'priority':
          return (PRIORITY_ORDER[a.priority] ?? 99) - (PRIORITY_ORDER[b.priority] ?? 99);
        case 'status':
          return (STATUS_ORDER[a.status] ?? 99) - (STATUS_ORDER[b.status] ?? 99);
        case 'due_date': {
          if (!a.due_date && !b.due_date) return 0;
          if (!a.due_date) return 1;
          if (!b.due_date) return -1;
          return new Date(a.due_date).getTime() - new Date(b.due_date).getTime();
        }
        case 'project':
          return (a.project_id || '').localeCompare(b.project_id || '');
        case 'updated_at':
          return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
        default:
          return 0;
      }
    });

    return result;
  }, [myTasks, filterTab, sortField, today]);

  const viewingTask = viewingTaskId ? tasks.find(t => t.id === viewingTaskId) ?? null : null;

  const overdueCount = myTasks.filter(t => {
    if (!t.due_date || t.status === 'done') return false;
    const due = new Date(t.due_date);
    due.setHours(0, 0, 0, 0);
    return due < today;
  }).length;

  const activeCount = myTasks.filter(t => t.status !== 'done').length;

  const handleEditTask = (task: Task) => {
    setViewingTaskId(null);
    setEditingTask(task);
  };

  const handleDeleteTask = (id: string) => {
    setDeletingTaskId(id);
  };

  const executeDelete = () => {
    if (!deletingTaskId) return;
    deleteTask(deletingTaskId);
    setViewingTaskId(null);
  };

  const formatDueDate = (date: string | null) => {
    if (!date) return null;
    const d = new Date(date);
    const isOverdue = d < today;
    return {
      text: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      isOverdue: isOverdue && true,
    };
  };

  const tabs: { id: FilterTab; label: string; count: number }[] = [
    { id: 'all', label: 'All', count: myTasks.length },
    { id: 'active', label: 'Active', count: activeCount },
    { id: 'overdue', label: 'Overdue', count: overdueCount },
  ];

  const sortOptions: { id: SortField; label: string }[] = [
    { id: 'priority', label: 'Priority' },
    { id: 'due_date', label: 'Due Date' },
    { id: 'status', label: 'Status' },
    { id: 'updated_at', label: 'Recent' },
  ];

  return (
    <div className="animate-fadeIn min-h-screen bg-zinc-50">
      <Header
        title="My Tasks"
        subtitle={`${activeCount} active task${activeCount !== 1 ? 's' : ''} assigned to you`}
      />

      <div className="p-4 lg:p-6 space-y-4">
        {/* Filter Tabs and Sort */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center bg-white border border-zinc-200 rounded-lg p-1">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setFilterTab(tab.id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-all ${
                  filterTab === tab.id
                    ? 'bg-zinc-900 text-white shadow-sm'
                    : 'text-zinc-500 hover:text-zinc-700'
                }`}
              >
                {tab.label}
                <span className={`text-xs px-1.5 py-0.5 rounded-full ${
                  filterTab === tab.id
                    ? 'bg-white/20'
                    : tab.id === 'overdue' && tab.count > 0
                    ? 'bg-red-100 text-red-700'
                    : 'bg-zinc-100 text-zinc-500'
                }`}>
                  {tab.count}
                </span>
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-500">Sort by:</span>
            <div className="w-32">
              <Select
                value={sortField}
                onChange={(value) => setSortField(value as SortField)}
                options={sortOptions.map(opt => ({ value: opt.id, label: opt.label }))}
                size="sm"
              />
            </div>
          </div>
        </div>

        {/* Task List */}
        {filteredTasks.length === 0 ? (
          <div className="text-center py-16 bg-white rounded-xl border border-zinc-200">
            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-zinc-100 flex items-center justify-center">
              <CheckSquare className="text-zinc-400" size={32} />
            </div>
            <h3 className="text-lg font-semibold text-zinc-900 mb-2">
              {filterTab === 'overdue' ? 'No overdue tasks' : filterTab === 'active' ? 'All caught up!' : 'No tasks assigned to you'}
            </h3>
            <p className="text-zinc-500">
              {filterTab === 'overdue'
                ? "You're on track with all your deadlines."
                : filterTab === 'active'
                ? 'All your tasks have been completed.'
                : 'Tasks assigned to you will appear here.'}
            </p>
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-zinc-200 overflow-hidden divide-y divide-zinc-100">
            {filteredTasks.map((task) => {
              const project = projects.find(p => p.id === task.project_id);
              const dueInfo = formatDueDate(task.due_date);
              const completedSubtasks = task.subtasks.filter(s => s.completed).length;

              return (
                <div
                  key={task.id}
                  onClick={() => setViewingTaskId(task.id)}
                  className="flex items-center gap-3 p-3 lg:p-4 hover:bg-zinc-50 transition-colors cursor-pointer group"
                >
                  {/* Status dot */}
                  <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
                    task.status === 'done' ? 'bg-emerald-500' :
                    task.status === 'in_progress' ? 'bg-brand-500' :
                    task.status === 'in_review' ? 'bg-amber-500' :
                    'bg-zinc-300'
                  }`} />

                  {/* Task info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="font-medium text-zinc-900 text-sm lg:text-base truncate">{task.title}</p>
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      {project && (
                        <span className="flex items-center gap-1 text-xs text-zinc-500">
                          {project.color && (
                            <span
                              className="w-2 h-2 rounded-full inline-block"
                              style={{ backgroundColor: project.color }}
                            />
                          )}
                          {project.name}
                        </span>
                      )}
                      {task.subtasks.length > 0 && (
                        <span className="text-xs text-zinc-400 flex items-center gap-1">
                          <CheckSquare size={11} />
                          {completedSubtasks}/{task.subtasks.length}
                        </span>
                      )}
                      {task.comments.length > 0 && (
                        <span className="text-xs text-zinc-400 flex items-center gap-1">
                          <MessageSquare size={11} />
                          {task.comments.length}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Meta */}
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {dueInfo && (
                      <span className={`text-xs px-2 py-0.5 rounded-full flex items-center gap-1 ${
                        dueInfo.isOverdue
                          ? 'bg-red-100 text-red-700 font-medium'
                          : 'bg-zinc-100 text-zinc-600'
                      }`}>
                        <Calendar size={11} />
                        {dueInfo.text}
                      </span>
                    )}
                    <StatusBadge status={task.status} />
                    <PriorityBadge priority={task.priority} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Task Detail Panel */}
      <TaskDetailPanel
        task={viewingTask}
        onClose={() => setViewingTaskId(null)}
        onEdit={handleEditTask}
        onDelete={handleDeleteTask}
      />

      {/* Edit Task Form */}
      {editingTask && (
        <TaskForm
          isOpen={!!editingTask}
          onClose={() => setEditingTask(null)}
          projectId={editingTask.project_id}
          task={editingTask}
        />
      )}

      {/* Confirm Delete */}
      <ConfirmDialog
        isOpen={!!deletingTaskId}
        onClose={() => setDeletingTaskId(null)}
        onConfirm={executeDelete}
        title="Delete Task"
        message="This will permanently delete this task and all its subtasks and comments. This action cannot be undone."
        confirmLabel="Delete"
        variant="danger"
      />
    </div>
  );
}
