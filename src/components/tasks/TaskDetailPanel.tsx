'use client';

import { useEffect, useRef, useState } from 'react';
import { Task } from '@/lib/types';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { StatusBadge, PriorityBadge } from '@/components/ui/Badge';
import { Avatar, AvatarGroup } from '@/components/ui/Avatar';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { Textarea } from '@/components/ui/inputs/Textarea';
import {
  X, Edit, Trash2, Calendar, CheckSquare, MessageSquare, Plus, Tag, Users, Clock, GripVertical, Bot,
} from 'lucide-react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Tooltip } from '@/components/ui/Tooltip';
import { parseDateOnly, isDateOverdue } from '@/lib/date-utils';
import { hasPermission } from '@/lib/access-control';

interface TaskDetailPanelProps {
  task: Task | null;
  onClose: () => void;
  onEdit: (task: Task) => void;
  onDelete: (id: string) => void;
}

const STATUS_OPTIONS: { value: Task['status']; label: string; color: string }[] = [
  { value: 'todo', label: 'To Do', color: 'bg-zinc-400' },
  { value: 'in_progress', label: 'In Progress', color: 'bg-brand-500' },
  { value: 'in_review', label: 'In Review', color: 'bg-amber-500' },
  { value: 'done', label: 'Done', color: 'bg-emerald-500' },
];

const PRIORITY_OPTIONS: { value: Task['priority']; label: string; color: string }[] = [
  { value: 'low', label: 'Low', color: 'bg-zinc-400' },
  { value: 'medium', label: 'Medium', color: 'bg-blue-500' },
  { value: 'high', label: 'High', color: 'bg-orange-500' },
  { value: 'urgent', label: 'Urgent', color: 'bg-red-500' },
];

export function TaskDetailPanel({ task, onClose, onEdit, onDelete }: TaskDetailPanelProps) {
  const { team, getTeamMember, getProject, updateTask, toggleSubtask, addSubtask, updateSubtask, reorderSubtasks, deleteSubtask, addComment, updateComment, deleteComment } = useApp();
  const { teamMemberId, access } = useAuth();
  const backdropRef = useRef<HTMLDivElement>(null);
  const [newSubtask, setNewSubtask] = useState('');
  const [newComment, setNewComment] = useState('');
  const [showStatusMenu, setShowStatusMenu] = useState(false);
  const [showPriorityMenu, setShowPriorityMenu] = useState(false);
  const [editingSubtaskId, setEditingSubtaskId] = useState<string | null>(null);
  const [editingSubtaskTitle, setEditingSubtaskTitle] = useState('');
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editingCommentText, setEditingCommentText] = useState('');
  const [draggedSubtaskId, setDraggedSubtaskId] = useState<string | null>(null);
  // Local subtask order while dragging; persisted once on drag end
  const [dragSubtaskOrder, setDragSubtaskOrder] = useState<string[] | null>(null);
  const [deleteSubtaskTarget, setDeleteSubtaskTarget] = useState<string | null>(null);
  const [deleteCommentTarget, setDeleteCommentTarget] = useState<string | null>(null);

  // Reset local state when task changes
  useEffect(() => {
    setNewSubtask('');
    setNewComment('');
  }, [task?.id]);

  // Escape key handler
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    if (task) {
      document.addEventListener('keydown', handleEscape);
      document.body.style.overflow = 'hidden';
    }

    return () => {
      document.removeEventListener('keydown', handleEscape);
      document.body.style.overflow = 'unset';
    };
  }, [task, onClose]);

  if (!task) return null;
  const canEdit = hasPermission(access, 'tasks.manage_all') || (hasPermission(access, 'tasks.manage_assigned') && task.assignee_ids.includes(teamMemberId || ''));
  const canDelete = hasPermission(access, 'tasks.manage_all');

  const isAgentsEnabled = process.env.NEXT_PUBLIC_ENABLE_AGENTS === 'true';
  const project = getProject(task.project_id);
  const showAiToggle = isAgentsEnabled && hasPermission(access, 'agents.manage') && project?.autonomous_enabled;

  const assignees = team.filter(m => task.assignee_ids.includes(m.id));
  const completedSubtasks = task.subtasks.filter(s => s.completed).length;

  const formatDate = (date: string | null) => {
    if (!date) return null;
    const d = parseDateOnly(date);
    const isOverdue = isDateOverdue(date) && task.status !== 'done';
    return {
      text: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      isOverdue,
    };
  };

  const dueInfo = formatDate(task.due_date);
  const createdDate = new Date(task.created_at).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });

  const handleAddSubtask = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canEdit || !newSubtask.trim()) return;
    addSubtask(task.id, newSubtask.trim());
    setNewSubtask('');
  };

  const handleAddComment = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newComment.trim()) return;
    addComment(task.id, newComment.trim(), teamMemberId || '');
    setNewComment('');
  };

  const handleDelete = () => {
    // The parent owns the delete and shows its own confirmation dialog;
    // confirming here too would make the user confirm four times.
    if (canDelete) onDelete(task.id);
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <div
        ref={backdropRef}
        className="absolute inset-0 bg-black/40 backdrop-blur-sm animate-fadeIn"
        onClick={(e) => e.target === backdropRef.current && onClose()}
      />

      {/* Panel */}
      <div className="relative w-full sm:w-[480px] bg-surface-raised shadow-2xl flex flex-col animate-slideIn overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.08] flex-shrink-0">
          <h2 className="text-lg font-semibold text-white truncate pr-3">{task.title}</h2>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {canEdit && <Tooltip content="Edit task">
              <button
                onClick={() => onEdit(task)}
                className="p-1.5 rounded-lg text-zinc-400 hover:text-brand-300 hover:bg-brand-500/15 transition-colors"
              >
                <Edit size={16} />
              </button>
            </Tooltip>}
            {canDelete && <Tooltip content="Delete task">
              <button
                onClick={handleDelete}
                className="p-1.5 rounded-lg text-zinc-400 hover:text-red-400 hover:bg-red-500/15 transition-colors"
              >
                <Trash2 size={16} />
              </button>
            </Tooltip>}
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.06] transition-colors"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto">
          <div className="p-5 space-y-5">
            {/* Status & Priority Row */}
            <div className="flex items-center gap-2 flex-wrap">
              {/* Clickable Status */}
              <div className="relative">
                <button
                  onClick={() => canEdit && setShowStatusMenu(!showStatusMenu)}
                  className={canEdit ? 'hover:ring-2 hover:ring-brand-500/30 rounded-full transition-all' : 'cursor-default'}
                >
                  <StatusBadge status={task.status} />
                </button>
                {canEdit && showStatusMenu && (
                  <>
                    <div className="fixed inset-0 z-10 cursor-default" onClick={() => setShowStatusMenu(false)} />
                    <div className="absolute left-0 top-8 bg-surface-raised rounded-lg shadow-xl border border-white/[0.08] py-1 z-20 min-w-[160px] cursor-pointer">
                      {STATUS_OPTIONS.map((opt) => (
                        <button
                          key={opt.value}
                          onClick={() => {
                            updateTask(task.id, { status: opt.value });
                            setShowStatusMenu(false);
                          }}
                          className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-white/[0.03] transition-colors ${
                            task.status === opt.value ? 'bg-white/[0.03] font-medium' : 'text-zinc-300'
                          }`}
                        >
                          <div className={`w-2 h-2 rounded-full ${opt.color}`} />
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>

              {/* Clickable Priority */}
              <div className="relative">
                <button
                  onClick={() => canEdit && setShowPriorityMenu(!showPriorityMenu)}
                  className={canEdit ? 'hover:ring-2 hover:ring-brand-500/30 rounded-full transition-all' : 'cursor-default'}
                >
                  <PriorityBadge priority={task.priority} />
                </button>
                {canEdit && showPriorityMenu && (
                  <>
                    <div className="fixed inset-0 z-10 cursor-default" onClick={() => setShowPriorityMenu(false)} />
                    <div className="absolute left-0 top-8 bg-surface-raised rounded-lg shadow-xl border border-white/[0.08] py-1 z-20 min-w-[140px] cursor-pointer">
                      {PRIORITY_OPTIONS.map((opt) => (
                        <button
                          key={opt.value}
                          onClick={() => {
                            updateTask(task.id, { priority: opt.value });
                            setShowPriorityMenu(false);
                          }}
                          className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-white/[0.03] transition-colors ${
                            task.priority === opt.value ? 'bg-white/[0.03] font-medium' : 'text-zinc-300'
                          }`}
                        >
                          <div className={`w-2 h-2 rounded-full ${opt.color}`} />
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
              {dueInfo && (
                <div className={`flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full ${
                  dueInfo.isOverdue
                    ? 'bg-red-500/15 text-red-300 font-medium'
                    : 'bg-white/[0.06] text-zinc-300'
                }`}>
                  <Calendar size={12} />
                  <span>{dueInfo.text}</span>
                </div>
              )}
            </div>

            {/* Meta Section */}
            <div className="space-y-3">
              {/* Assignees */}
              {assignees.length > 0 && (
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-1.5 text-xs text-zinc-400 w-20 flex-shrink-0">
                    <Users size={14} />
                    <span>Assignees</span>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    {assignees.map((member) => (
                      <div key={member.id} className="flex items-center gap-1.5 px-2 py-1 bg-white/[0.06] rounded-full">
                        <Avatar name={member.name} src={member.avatar || undefined} size="xs" />
                        <span className="text-xs text-zinc-300">{member.name}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Tags */}
              {task.tags.length > 0 && (
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-1.5 text-xs text-zinc-400 w-20 flex-shrink-0">
                    <Tag size={14} />
                    <span>Tags</span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {task.tags.map((tag) => (
                      <span
                        key={tag}
                        className="px-2 py-0.5 text-xs bg-white/[0.06] text-zinc-300 rounded-full"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Created */}
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1.5 text-xs text-zinc-400 w-20 flex-shrink-0">
                  <Clock size={14} />
                  <span>Created</span>
                </div>
                <span className="text-xs text-zinc-300">{createdDate}</span>
              </div>
            </div>

            {/* AI Managed Toggle */}
            {showAiToggle && (
              <div className="flex items-center justify-between py-2 px-3 bg-white/[0.03] rounded-lg">
                <div className="flex items-center gap-2">
                  <Bot size={14} className="text-zinc-400" />
                  <div>
                    <p className="text-sm font-medium text-zinc-300">AI Managed</p>
                    <p className="text-xs text-zinc-500">Let Ashley automate this task</p>
                  </div>
                </div>
                <button
                  onClick={() => updateTask(task.id, { ai_managed: !task.ai_managed })}
                  className={`relative w-10 h-[22px] rounded-full transition-colors ${
                    task.ai_managed ? 'bg-brand-600' : 'bg-zinc-300'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-[18px] h-[18px] bg-surface-raised rounded-full shadow transition-transform ${
                      task.ai_managed ? 'translate-x-[18px]' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>
            )}

            {/* Description */}
            {task.description && (
              <div className="space-y-2">
                <h3 className="text-sm font-medium text-zinc-300">Description</h3>
                <p className="text-sm text-zinc-300 whitespace-pre-wrap leading-relaxed">{task.description}</p>
              </div>
            )}

            {/* Subtasks Section */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium text-zinc-300 flex items-center gap-2">
                  <CheckSquare size={14} />
                  Subtasks
                  {task.subtasks.length > 0 && (
                    <span className="text-xs text-zinc-400 font-normal">
                      ({completedSubtasks}/{task.subtasks.length})
                    </span>
                  )}
                </h3>
              </div>

              {/* Progress bar */}
              {task.subtasks.length > 0 && (
                <div className="h-1.5 bg-white/[0.06] rounded-full overflow-hidden">
                  <div
                    className="h-full bg-emerald-500 rounded-full transition-all duration-300"
                    style={{ width: `${(completedSubtasks / task.subtasks.length) * 100}%` }}
                  />
                </div>
              )}

              {/* Subtask list */}
              <div className="space-y-1">
                {(dragSubtaskOrder
                  ? dragSubtaskOrder
                      .map(id => task.subtasks.find(s => s.id === id))
                      .filter((s): s is NonNullable<typeof s> => !!s)
                  : task.subtasks
                ).map((subtask) => (
                  <div
                    key={subtask.id}
                    draggable
                    onDragStart={() => {
                      setDraggedSubtaskId(subtask.id);
                      setDragSubtaskOrder(task.subtasks.map(s => s.id));
                    }}
                    onDragEnd={() => {
                      // Persist the final order once, only if it changed
                      if (dragSubtaskOrder) {
                        const original = task.subtasks.map(s => s.id);
                        if (dragSubtaskOrder.join() !== original.join()) {
                          reorderSubtasks(task.id, dragSubtaskOrder);
                        }
                      }
                      setDraggedSubtaskId(null);
                      setDragSubtaskOrder(null);
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      if (draggedSubtaskId && draggedSubtaskId !== subtask.id) {
                        setDragSubtaskOrder(order => {
                          const ids = [...(order ?? task.subtasks.map(s => s.id))];
                          const fromIdx = ids.indexOf(draggedSubtaskId);
                          const toIdx = ids.indexOf(subtask.id);
                          if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return order;
                          ids.splice(fromIdx, 1);
                          ids.splice(toIdx, 0, draggedSubtaskId);
                          return ids;
                        });
                      }
                    }}
                    className={`flex items-center gap-2 p-2 rounded-lg hover:bg-white/[0.03] group cursor-grab active:cursor-grabbing ${
                      draggedSubtaskId === subtask.id ? 'opacity-50' : ''
                    }`}
                  >
                    <button
                      onClick={() => toggleSubtask(task.id, subtask.id)}
                      className={`flex-shrink-0 w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${
                        subtask.completed
                          ? 'bg-emerald-500 border-emerald-500'
                          : 'border-white/[0.12] hover:border-emerald-400'
                      }`}
                    >
                      {subtask.completed && <CheckSquare size={12} className="text-white" />}
                    </button>
                    {editingSubtaskId === subtask.id ? (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          if (editingSubtaskTitle.trim()) {
                            updateSubtask(task.id, subtask.id, editingSubtaskTitle.trim());
                          }
                          setEditingSubtaskId(null);
                        }}
                        className="flex-1"
                      >
                        <TextInput
                          value={editingSubtaskTitle}
                          onChange={setEditingSubtaskTitle}
                          onBlur={() => {
                            if (editingSubtaskTitle.trim()) {
                              updateSubtask(task.id, subtask.id, editingSubtaskTitle.trim());
                            }
                            setEditingSubtaskId(null);
                          }}
                          autoFocus
                          size="sm"
                        />
                      </form>
                    ) : (
                      <Tooltip content="Double-click to edit" delay={500}>
                        <span
                          className={`flex-1 text-sm cursor-pointer ${subtask.completed ? 'text-zinc-500 line-through' : 'text-zinc-300'}`}
                          onDoubleClick={() => {
                            setEditingSubtaskId(subtask.id);
                            setEditingSubtaskTitle(subtask.title);
                          }}
                        >
                          {subtask.title}
                        </span>
                      </Tooltip>
                    )}
                    <div className="flex items-center gap-0.5 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100 transition-all">
                      <button
                        onClick={() => {
                          setEditingSubtaskId(subtask.id);
                          setEditingSubtaskTitle(subtask.title);
                        }}
                        className="p-1 text-zinc-500 hover:text-brand-500"
                      >
                        <Edit size={12} />
                      </button>
                      <button
                        onClick={() => setDeleteSubtaskTarget(subtask.id)}
                        className="p-1 text-zinc-500 hover:text-red-500"
                      >
                        <X size={14} />
                      </button>
                      <GripVertical size={14} className="text-zinc-600 flex-shrink-0 cursor-grab active:cursor-grabbing" />
                    </div>
                  </div>
                ))}
              </div>

              {/* Add subtask */}
              <form onSubmit={handleAddSubtask} className="flex items-center gap-2 pl-[22px]">
                <TextInput
                  value={newSubtask}
                  onChange={setNewSubtask}
                  placeholder="Add a subtask..."
                  size="sm"
                  className="flex-1"
                />
                <button
                  type="submit"
                  className="p-1 rounded text-zinc-500 hover:text-brand-300 hover:bg-brand-500/15 transition-colors flex-shrink-0"
                >
                  <Plus size={16} />
                </button>
              </form>
            </div>

            {/* Comments Section */}
            <div className="space-y-3">
              <h3 className="text-sm font-medium text-zinc-300 flex items-center gap-2">
                <MessageSquare size={14} />
                Comments
                {task.comments.length > 0 && (
                  <span className="text-xs text-zinc-400 font-normal">
                    ({task.comments.length})
                  </span>
                )}
              </h3>

              {/* Comment thread */}
              <div className="space-y-3">
                {task.comments.map((comment) => {
                  const author = getTeamMember(comment.user_id);
                  const isOwn = comment.user_id === teamMemberId;
                  return (
                    <div key={comment.id} className="flex gap-3 group">
                      <Avatar name={author?.name || '?'} src={author?.avatar || undefined} size="sm" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-medium text-white">{author?.name || 'Unknown'}</p>
                            <p className="text-xs text-zinc-500">
                              {new Date(comment.created_at).toLocaleDateString('en-US', {
                                month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
                              })}
                            </p>
                          </div>
                          <div className="flex items-center gap-0.5 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100 transition-all">
                            {isOwn && (
                              <button
                                onClick={() => {
                                  setEditingCommentId(comment.id);
                                  setEditingCommentText(comment.text);
                                }}
                                className="p-1 text-zinc-500 hover:text-brand-500"
                              >
                                <Edit size={12} />
                              </button>
                            )}
                            <button
                              onClick={() => setDeleteCommentTarget(comment.id)}
                              className="p-1 text-zinc-500 hover:text-red-500"
                            >
                              <X size={14} />
                            </button>
                          </div>
                        </div>
                        {editingCommentId === comment.id ? (
                          <form
                            onSubmit={(e) => {
                              e.preventDefault();
                              if (editingCommentText.trim()) {
                                updateComment(task.id, comment.id, editingCommentText.trim());
                              }
                              setEditingCommentId(null);
                            }}
                            className="mt-1 space-y-1.5"
                          >
                            <Textarea
                              value={editingCommentText}
                              onChange={setEditingCommentText}
                              autoFocus
                              rows={2}
                              size="sm"
                            />
                            <div className="flex gap-1.5">
                              <button
                                type="submit"
                                className="px-2.5 py-1 text-xs text-white bg-brand-600 hover:bg-brand-700 rounded-md transition-colors"
                              >
                                Save
                              </button>
                              <button
                                type="button"
                                onClick={() => setEditingCommentId(null)}
                                className="px-2.5 py-1 text-xs text-zinc-300 hover:bg-white/[0.06] rounded-md transition-colors"
                              >
                                Cancel
                              </button>
                            </div>
                          </form>
                        ) : (
                          <p className="text-sm text-zinc-300 mt-0.5">{comment.text}</p>
                        )}
                      </div>
                    </div>
                  );
                })}
                {task.comments.length === 0 && (
                  <div className="flex flex-col items-center justify-center p-8 text-center">
                    <div className="w-10 h-10 rounded-full bg-white/[0.06] flex items-center justify-center mb-3">
                      <MessageSquare size={18} className="text-zinc-500" />
                    </div>
                    <p className="text-sm font-medium text-zinc-400">No comments yet</p>
                    <p className="text-xs text-zinc-500 mt-1">Add a comment below</p>
                  </div>
                )}
              </div>

              {/* Add comment */}
              <form onSubmit={handleAddComment} className="flex items-center gap-2">
                <TextInput
                  value={newComment}
                  onChange={setNewComment}
                  placeholder="Write a comment..."
                  size="sm"
                  className="flex-1"
                />
                <button
                  type="submit"
                  className="p-1 rounded text-zinc-500 hover:text-brand-300 hover:bg-brand-500/15 transition-colors flex-shrink-0"
                >
                  <MessageSquare size={16} />
                </button>
              </form>
            </div>
          </div>
        </div>
      </div>

      <ConfirmDialog
        isOpen={!!deleteSubtaskTarget}
        onClose={() => setDeleteSubtaskTarget(null)}
        onConfirm={() => { if (deleteSubtaskTarget) deleteSubtask(task.id, deleteSubtaskTarget); }}
        title="Delete Subtask"
        message="Are you sure you want to delete this subtask?"
        confirmLabel="Delete"
        variant="danger"
      />

      <ConfirmDialog
        isOpen={!!deleteCommentTarget}
        onClose={() => setDeleteCommentTarget(null)}
        onConfirm={() => { if (deleteCommentTarget) deleteComment(task.id, deleteCommentTarget); }}
        title="Delete Comment"
        message="Are you sure you want to delete this comment?"
        confirmLabel="Delete"
        variant="danger"
      />

      <style jsx>{`
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes slideIn {
          from { transform: translateX(100%); }
          to { transform: translateX(0); }
        }
        .animate-fadeIn {
          animation: fadeIn 0.2s ease-out;
        }
        .animate-slideIn {
          animation: slideIn 0.25s ease-out;
        }
      `}</style>
    </div>
  );
}
