'use client';

import { useState, useEffect } from 'react';
import { Task } from '@/lib/types';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import Modal from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Plus, X, CheckSquare, MessageSquare } from 'lucide-react';

interface TaskFormProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
  task?: Task | null;
}

export function TaskForm({ isOpen, onClose, projectId, task }: TaskFormProps) {
  const { team, addTask, updateTask, addSubtask, toggleSubtask, deleteSubtask, addComment, deleteComment, getTeamMember } = useApp();
  const { teamMemberId } = useAuth();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<Task['status']>('todo');
  const [priority, setPriority] = useState<Task['priority']>('medium');
  const [assigneeIds, setAssigneeIds] = useState<string[]>([]);
  const [dueDate, setDueDate] = useState('');
  const [tags, setTags] = useState('');
  const [newSubtask, setNewSubtask] = useState('');
  const [newComment, setNewComment] = useState('');

  // Tab state for viewing task details
  const [activeTab, setActiveTab] = useState<'details' | 'subtasks' | 'comments'>('details');

  useEffect(() => {
    if (task) {
      setTitle(task.title);
      setDescription(task.description);
      setStatus(task.status);
      setPriority(task.priority);
      setAssigneeIds(task.assignee_ids);
      setDueDate(task.due_date || '');
      setTags(task.tags.join(', '));
    } else {
      setTitle('');
      setDescription('');
      setStatus('todo');
      setPriority('medium');
      setAssigneeIds([]);
      setDueDate('');
      setTags('');
    }
    setNewSubtask('');
    setNewComment('');
    setActiveTab('details');
  }, [task, isOpen]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (!title.trim()) return;

    const taskData = {
      project_id: projectId,
      title: title.trim(),
      description: description.trim(),
      status,
      priority,
      assignee_ids: assigneeIds,
      due_date: dueDate || null,
      tags: tags.split(',').map(t => t.trim()).filter(Boolean),
      subtasks: task?.subtasks || [],
      comments: task?.comments || [],
    };

    if (task) {
      updateTask(task.id, taskData);
    } else {
      addTask(taskData);
    }

    onClose();
  };

  const handleAddSubtask = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSubtask.trim() || !task) return;
    addSubtask(task.id, newSubtask.trim());
    setNewSubtask('');
  };

  const handleAddComment = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newComment.trim() || !task) return;
    addComment(task.id, newComment.trim(), teamMemberId || '');
    setNewComment('');
  };

  const toggleAssignee = (userId: string) => {
    setAssigneeIds(prev =>
      prev.includes(userId)
        ? prev.filter(id => id !== userId)
        : [...prev, userId]
    );
  };

  const statusOptions = [
    { value: 'todo', label: 'To Do' },
    { value: 'in_progress', label: 'In Progress' },
    { value: 'in_review', label: 'In Review' },
    { value: 'done', label: 'Done' },
  ];

  const priorityOptions = [
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'urgent', label: 'Urgent' },
  ];

  const isViewing = !!task;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={isViewing ? task.title : 'New Task'}
      size="lg"
    >
      {isViewing ? (
        /* View Mode */
        <div className="space-y-4">
          {/* Tabs */}
          <div className="flex border-b border-zinc-200">
            <button
              onClick={() => setActiveTab('details')}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === 'details'
                  ? 'border-indigo-500 text-indigo-600'
                  : 'border-transparent text-zinc-500 hover:text-zinc-700'
              }`}
            >
              Details
            </button>
            <button
              onClick={() => setActiveTab('subtasks')}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === 'subtasks'
                  ? 'border-indigo-500 text-indigo-600'
                  : 'border-transparent text-zinc-500 hover:text-zinc-700'
              }`}
            >
              Subtasks ({task.subtasks.length})
            </button>
            <button
              onClick={() => setActiveTab('comments')}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === 'comments'
                  ? 'border-indigo-500 text-indigo-600'
                  : 'border-transparent text-zinc-500 hover:text-zinc-700'
              }`}
            >
              Comments ({task.comments.length})
            </button>
          </div>

          {/* Details Tab */}
          {activeTab === 'details' && (
            <form onSubmit={handleSubmit} className="space-y-4">
              <Input
                label="Title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
              />

              <div className="space-y-1.5">
                <label className="block text-sm font-medium text-zinc-700">Description</label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={4}
                  className="w-full px-3 py-2 text-sm bg-white border border-zinc-200 rounded-lg outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 resize-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <Select
                  label="Status"
                  value={status}
                  onChange={(e) => setStatus(e.target.value as Task['status'])}
                  options={statusOptions}
                />
                <Select
                  label="Priority"
                  value={priority}
                  onChange={(e) => setPriority(e.target.value as Task['priority'])}
                  options={priorityOptions}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <Input
                  label="Due Date"
                  type="date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                />
                <div className="space-y-1.5">
                  <label className="block text-sm font-medium text-zinc-700">Assignees</label>
                  <div className="flex flex-wrap gap-1.5">
                    {team.map((member) => (
                      <button
                        key={member.id}
                        type="button"
                        onClick={() => toggleAssignee(member.id)}
                        className={`px-2 py-1 text-xs rounded-full transition-all ${
                          assigneeIds.includes(member.id)
                            ? 'bg-indigo-100 text-indigo-700 border border-indigo-300'
                            : 'bg-zinc-100 text-zinc-600 border border-zinc-200'
                        }`}
                      >
                        {member.name}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <Input
                label="Tags (comma-separated)"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="design, frontend, urgent"
              />

              <div className="flex justify-end gap-3 pt-4">
                <Button type="button" variant="ghost" onClick={onClose}>
                  Close
                </Button>
                <Button type="submit">
                  Save Changes
                </Button>
              </div>
            </form>
          )}

          {/* Subtasks Tab */}
          {activeTab === 'subtasks' && (
            <div className="space-y-3">
              <form onSubmit={handleAddSubtask} className="flex gap-2">
                <Input
                  value={newSubtask}
                  onChange={(e) => setNewSubtask(e.target.value)}
                  placeholder="Add a subtask..."
                  className="flex-1"
                />
                <Button type="submit" size="sm">
                  <Plus size={16} />
                </Button>
              </form>

              <div className="space-y-2 max-h-64 overflow-y-auto">
                {task.subtasks.map((subtask) => (
                  <div
                    key={subtask.id}
                    className="flex items-center gap-3 p-2 rounded-lg hover:bg-zinc-50 group"
                  >
                    <button
                      onClick={() => toggleSubtask(task.id, subtask.id)}
                      className={`flex-shrink-0 w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${
                        subtask.completed
                          ? 'bg-emerald-500 border-emerald-500'
                          : 'border-zinc-300 hover:border-emerald-400'
                      }`}
                    >
                      {subtask.completed && <CheckSquare size={12} className="text-white" />}
                    </button>
                    <span className={`flex-1 text-sm ${subtask.completed ? 'text-zinc-400 line-through' : 'text-zinc-700'}`}>
                      {subtask.title}
                    </span>
                    <button
                      onClick={() => deleteSubtask(task.id, subtask.id)}
                      className="opacity-0 group-hover:opacity-100 p-1 text-zinc-400 hover:text-red-500 transition-all"
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
                {task.subtasks.length === 0 && (
                  <p className="text-sm text-zinc-500 text-center py-4">No subtasks yet</p>
                )}
              </div>
            </div>
          )}

          {/* Comments Tab */}
          {activeTab === 'comments' && (
            <div className="space-y-3">
              <form onSubmit={handleAddComment} className="flex gap-2">
                <Input
                  value={newComment}
                  onChange={(e) => setNewComment(e.target.value)}
                  placeholder="Write a comment..."
                  className="flex-1"
                />
                <Button type="submit" size="sm">
                  <MessageSquare size={16} />
                </Button>
              </form>

              <div className="space-y-3 max-h-64 overflow-y-auto">
                {task.comments.map((comment) => {
                  const author = getTeamMember(comment.user_id);
                  return (
                    <div key={comment.id} className="flex gap-3 p-2 rounded-lg hover:bg-zinc-50 group">
                      <div className="w-8 h-8 rounded-full bg-indigo-500 flex items-center justify-center text-white text-sm font-medium flex-shrink-0">
                        {author?.avatar || '?'}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between">
                          <p className="text-sm font-medium text-zinc-900">{author?.name || 'Unknown'}</p>
                          <button
                            onClick={() => deleteComment(task.id, comment.id)}
                            className="opacity-0 group-hover:opacity-100 p-1 text-zinc-400 hover:text-red-500 transition-all"
                          >
                            <X size={14} />
                          </button>
                        </div>
                        <p className="text-sm text-zinc-600">{comment.text}</p>
                        <p className="text-xs text-zinc-400 mt-1">
                          {new Date(comment.created_at).toLocaleDateString('en-US', {
                            month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
                          })}
                        </p>
                      </div>
                    </div>
                  );
                })}
                {task.comments.length === 0 && (
                  <p className="text-sm text-zinc-500 text-center py-4">No comments yet</p>
                )}
              </div>
            </div>
          )}
        </div>
      ) : (
        /* Create Mode */
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            label="Task Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Enter task title"
            required
          />

          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-zinc-700">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe the task..."
              rows={3}
              className="w-full px-3 py-2 text-sm bg-white border border-zinc-200 rounded-lg outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 resize-none"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Select
              label="Status"
              value={status}
              onChange={(e) => setStatus(e.target.value as Task['status'])}
              options={statusOptions}
            />
            <Select
              label="Priority"
              value={priority}
              onChange={(e) => setPriority(e.target.value as Task['priority'])}
              options={priorityOptions}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Due Date"
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
            />
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-zinc-700">Assignees</label>
              <div className="flex flex-wrap gap-1.5">
                {team.map((member) => (
                  <button
                    key={member.id}
                    type="button"
                    onClick={() => toggleAssignee(member.id)}
                    className={`px-2 py-1 text-xs rounded-full transition-all ${
                      assigneeIds.includes(member.id)
                        ? 'bg-indigo-100 text-indigo-700 border border-indigo-300'
                        : 'bg-zinc-100 text-zinc-600 border border-zinc-200'
                    }`}
                  >
                    {member.name}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <Input
            label="Tags (comma-separated)"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="design, frontend, urgent"
          />

          <div className="flex justify-end gap-3 pt-4">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">
              Create Task
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
