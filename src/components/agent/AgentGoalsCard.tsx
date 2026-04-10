'use client';

import { useState } from 'react';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/inputs/Textarea';
import { Tooltip } from '@/components/ui/Tooltip';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Target, Plus, Pencil, Trash2, X, CalendarDays, Lightbulb, Zap, CheckCircle2 } from 'lucide-react';
import { toast } from '@/components/ui/Toast';
import { ProjectGoal, TaskSuggestion, Task } from '@/lib/types';

interface AgentGoalsCardProps {
  projectId: string;
  goals: ProjectGoal[];
  taskSuggestions: TaskSuggestion[];
  tasks: Task[];
  onAdd: (goal: { project_id: string; title: string; description?: string; target_date?: string | null; status?: string }) => Promise<ProjectGoal | undefined>;
  onUpdate: (id: string, updates: Partial<ProjectGoal>) => void;
  onArchive: (id: string) => void;
}

const STATUS_CONFIG: Record<string, { label: string; bg: string; text: string }> = {
  active: { label: 'Active', bg: 'bg-emerald-50', text: 'text-emerald-700' },
  achieved: { label: 'Achieved', bg: 'bg-blue-50', text: 'text-blue-700' },
  paused: { label: 'Paused', bg: 'bg-amber-50', text: 'text-amber-700' },
  abandoned: { label: 'Abandoned', bg: 'bg-zinc-100', text: 'text-zinc-500' },
};

function formatDate(dateStr: string): string {
  const date = new Date(dateStr + 'T00:00:00');
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function getDaysUntil(dateStr: string): { label: string; urgent: boolean } {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const target = new Date(dateStr + 'T00:00:00');
  const diff = Math.ceil((target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

  if (diff < 0) return { label: `${Math.abs(diff)}d overdue`, urgent: true };
  if (diff === 0) return { label: 'Due today', urgent: true };
  if (diff <= 7) return { label: `${diff}d left`, urgent: true };
  if (diff <= 30) return { label: `${diff}d left`, urgent: false };
  return { label: formatDate(dateStr), urgent: false };
}

export function AgentGoalsCard({ projectId, goals, taskSuggestions, tasks, onAdd, onUpdate, onArchive }: AgentGoalsCardProps) {
  const [showForm, setShowForm] = useState(false);
  const [editingGoal, setEditingGoal] = useState<ProjectGoal | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [targetDate, setTargetDate] = useState('');
  const [status, setStatus] = useState<ProjectGoal['status']>('active');

  const resetForm = () => {
    setTitle('');
    setDescription('');
    setTargetDate('');
    setStatus('active');
    setEditingGoal(null);
    setShowForm(false);
  };

  const handleOpenCreate = () => {
    resetForm();
    setShowForm(true);
  };

  const handleOpenEdit = (goal: ProjectGoal) => {
    setEditingGoal(goal);
    setTitle(goal.title);
    setDescription(goal.description);
    setTargetDate(goal.target_date || '');
    setStatus(goal.status);
    setShowForm(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !description.trim()) return;

    if (editingGoal) {
      onUpdate(editingGoal.id, {
        title: title.trim(),
        description: description.trim(),
        target_date: targetDate || null,
        status,
      });
      toast('success', 'Goal updated');
    } else {
      await onAdd({
        project_id: projectId,
        title: title.trim(),
        description: description.trim(),
        target_date: targetDate || null,
        status,
      });
      toast('success', 'Goal created');
    }
    resetForm();
  };

  const executeArchive = () => {
    if (archiveTarget) {
      onArchive(archiveTarget);
      toast('success', 'Goal archived');
    }
  };

  const activeGoals = goals.filter(g => !g.archived_at);
  const isFormValid = title.trim() && description.trim();

  return (
    <div className={`bg-white rounded-xl border border-zinc-200 overflow-hidden flex flex-col ${showForm ? '' : 'max-h-[420px]'}`}>
      {/* Header */}
      <div className="px-5 py-4 flex items-center justify-between flex-shrink-0 border-b border-zinc-100">
        <div className="flex items-center gap-2">
          <Target size={18} className="text-zinc-500" />
          <h2 className="font-semibold text-zinc-900">
            {showForm
              ? (editingGoal ? 'Edit Goal' : 'New Goal')
              : <>Goals{activeGoals.length > 0 && <span className="ml-1.5 text-xs font-medium text-zinc-400">({activeGoals.length})</span>}</>
            }
          </h2>
        </div>
        {showForm ? (
          <button
            onClick={resetForm}
            className="p-1.5 text-zinc-400 hover:text-zinc-600 transition-colors rounded-md hover:bg-zinc-100"
          >
            <X size={16} />
          </button>
        ) : (
          <button
            onClick={handleOpenCreate}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg transition-colors"
          >
            <Plus size={14} />
            Add
          </button>
        )}
      </div>

      {/* Form Mode */}
      {showForm ? (
        <div className="p-5">
          <form onSubmit={handleSubmit} className="space-y-4">
            <Input
              label="Goal *"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Launch MVP by end of quarter"
              required
            />
            <Textarea
              label="Success Criteria *"
              value={description}
              onChange={setDescription}
              placeholder="How should the AI know this goal is done? What outcomes matter?"
              rows={3}
              required
            />
            <div className="grid grid-cols-2 gap-4">
              <Input
                label="Target Date"
                type="date"
                value={targetDate}
                onChange={(e) => setTargetDate(e.target.value)}
              />
              <Select
                label="Status"
                value={status}
                onChange={(v) => setStatus(v as ProjectGoal['status'])}
                options={[
                  { value: 'active', label: 'Active' },
                  { value: 'achieved', label: 'Achieved' },
                  { value: 'paused', label: 'Paused' },
                  { value: 'abandoned', label: 'Abandoned' },
                ]}
              />
            </div>
            <div className="flex items-center gap-2 justify-end pt-2">
              <button
                type="button"
                onClick={resetForm}
                className="px-3 py-1.5 text-sm text-zinc-500 hover:text-zinc-700 transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!isFormValid}
                className="inline-flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {editingGoal ? 'Save Changes' : 'Create Goal'}
              </button>
            </div>
          </form>
        </div>
      ) : (
        /* List Mode */
        <div className="flex-1 flex flex-col overflow-y-auto">
          {activeGoals.length > 0 ? (
            <div className="p-5 space-y-3">
              {activeGoals.map((goal) => {
                const cfg = STATUS_CONFIG[goal.status];
                const dateInfo = goal.target_date ? getDaysUntil(goal.target_date) : null;
                const pendingSuggestions = taskSuggestions.filter(s => s.goal_id === goal.id && s.status === 'pending').length;
                const activeTasks = tasks.filter(t => t.project_goal_id === goal.id && (t.status === 'in_progress' || t.status === 'in_review')).length;
                const completedTasks = tasks.filter(t => t.project_goal_id === goal.id && t.status === 'done').length;

                return (
                  <div
                    key={goal.id}
                    className="group rounded-lg border border-zinc-100 bg-zinc-50 hover:border-zinc-200 transition-colors"
                  >
                    <div className="p-3.5">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="text-sm font-medium text-zinc-900">{goal.title}</p>
                            <span className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-semibold rounded ${cfg.bg} ${cfg.text}`}>
                              {cfg.label}
                            </span>
                          </div>

                          {goal.description && (
                            <p className="text-xs text-zinc-500 mt-1.5 leading-relaxed line-clamp-2">{goal.description}</p>
                          )}

                          {/* Stats + date row */}
                          <div className="flex items-center gap-3 mt-2 flex-wrap">
                            {pendingSuggestions > 0 && (
                              <div className="flex items-center gap-1 text-[11px] text-amber-600 font-medium">
                                <Lightbulb size={12} />
                                <span>{pendingSuggestions} pending</span>
                              </div>
                            )}
                            {activeTasks > 0 && (
                              <div className="flex items-center gap-1 text-[11px] text-blue-600 font-medium">
                                <Zap size={12} />
                                <span>{activeTasks} in progress</span>
                              </div>
                            )}
                            {completedTasks > 0 && (
                              <div className="flex items-center gap-1 text-[11px] text-emerald-600">
                                <CheckCircle2 size={12} />
                                <span>{completedTasks} done</span>
                              </div>
                            )}
                            {dateInfo && (
                              <div className={`flex items-center gap-1 text-[11px] ${dateInfo.urgent ? 'text-amber-600 font-medium' : 'text-zinc-400'}`}>
                                <CalendarDays size={12} />
                                <span>{dateInfo.label}</span>
                              </div>
                            )}
                            {pendingSuggestions === 0 && activeTasks === 0 && completedTasks === 0 && !dateInfo && (
                              <span className="text-[11px] text-zinc-400">No activity yet</span>
                            )}
                          </div>
                        </div>

                        {/* Actions */}
                        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                          <Tooltip content="Edit">
                            <button
                              onClick={() => handleOpenEdit(goal)}
                              className="p-1.5 text-zinc-400 hover:text-brand-600 transition-colors rounded-md hover:bg-zinc-100"
                            >
                              <Pencil size={13} />
                            </button>
                          </Tooltip>
                          <Tooltip content="Archive">
                            <button
                              onClick={() => setArchiveTarget(goal.id)}
                              className="p-1.5 text-zinc-400 hover:text-red-500 transition-colors rounded-md hover:bg-zinc-100"
                            >
                              <Trash2 size={13} />
                            </button>
                          </Tooltip>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
              <div className="w-10 h-10 rounded-full bg-zinc-100 flex items-center justify-center mb-3">
                <Target size={18} className="text-zinc-400" />
              </div>
              <p className="text-sm font-medium text-zinc-500">No goals yet</p>
              <p className="text-xs text-zinc-400 mt-1">Add a goal to start receiving agent suggestions</p>
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        isOpen={!!archiveTarget}
        onClose={() => setArchiveTarget(null)}
        onConfirm={executeArchive}
        title="Archive Goal"
        message="This goal will be archived and agents will stop generating suggestions for it. Are you sure?"
        confirmLabel="Archive"
        variant="danger"
      />
    </div>
  );
}
