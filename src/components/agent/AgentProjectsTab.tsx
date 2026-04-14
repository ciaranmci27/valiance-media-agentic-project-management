'use client';

import { useState } from 'react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { ProjectGoal } from '@/lib/types';
import Modal from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/inputs/Textarea';
import { DateInput } from '@/components/ui/inputs/DateInput';
import { Tooltip } from '@/components/ui/Tooltip';
import { FolderKanban, Plus, Edit, Archive, Bot } from 'lucide-react';
import { toast } from '@/components/ui/Toast';

export function AgentProjectsTab() {
  const {
    projects, projectGoals, taskSuggestions, tasks,
    addGoal, updateGoal, archiveGoal, updateProject,
  } = useApp();
  const { teamMemberId } = useAuth();

  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingGoal, setEditingGoal] = useState<ProjectGoal | null>(null);

  // Form state
  const [formProjectId, setFormProjectId] = useState('');
  const [formTitle, setFormTitle] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formTargetDate, setFormTargetDate] = useState('');
  const [formStatus, setFormStatus] = useState<ProjectGoal['status']>('active');

  const resetForm = () => {
    setFormProjectId('');
    setFormTitle('');
    setFormDescription('');
    setFormTargetDate('');
    setFormStatus('active');
    setEditingGoal(null);
  };

  const handleOpenCreate = (projectId: string) => {
    resetForm();
    setFormProjectId(projectId);
    setIsFormOpen(true);
  };

  const handleOpenEdit = (goal: ProjectGoal) => {
    setEditingGoal(goal);
    setFormProjectId(goal.project_id);
    setFormTitle(goal.title);
    setFormDescription(goal.description);
    setFormTargetDate(goal.target_date || '');
    setFormStatus(goal.status);
    setIsFormOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formTitle.trim() || !formProjectId) return;

    if (editingGoal) {
      updateGoal(editingGoal.id, {
        title: formTitle.trim(),
        description: formDescription.trim(),
        target_date: formTargetDate || null,
        status: formStatus,
      });
      toast('success', 'Goal updated');
    } else {
      await addGoal({
        project_id: formProjectId,
        title: formTitle.trim(),
        description: formDescription.trim(),
        target_date: formTargetDate || null,
        status: formStatus,
      });
      toast('success', 'Goal created');
    }

    setIsFormOpen(false);
    resetForm();
  };

  const handleArchive = (id: string) => {
    archiveGoal(id);
    toast('success', 'Goal archived');
  };

  const handleToggleAutonomous = (projectId: string, current: boolean) => {
    updateProject(projectId, { autonomous_enabled: !current });
    toast('success', !current ? 'Autonomous agents enabled' : 'Autonomous agents disabled');
  };

  const statusColors: Record<string, string> = {
    active: 'bg-emerald-100 text-emerald-700',
    achieved: 'bg-blue-100 text-blue-700',
    paused: 'bg-amber-100 text-amber-700',
    abandoned: 'bg-zinc-100 text-zinc-500',
  };

  // Show all active (non-archived) projects, sorted: autonomous first, then alphabetically
  const activeProjects = projects
    .filter(p => p.status !== 'archived')
    .sort((a, b) => {
      if (a.autonomous_enabled !== b.autonomous_enabled) {
        return a.autonomous_enabled ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      {activeProjects.map((project) => {
        const goals = projectGoals.filter(g => g.project_id === project.id);
        const projectSuggestions = taskSuggestions.filter(s => s.project_id === project.id && s.status === 'pending');
        const projectActiveTasks = tasks.filter(t => t.project_id === project.id && (t.status === 'todo' || t.status === 'in_progress'));

        return (
          <div
            key={project.id}
            className="bg-white rounded-xl border border-zinc-200 p-4 lg:p-5"
          >
            {/* Project header */}
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                {project.color && <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: project.color }} />}
                <h3 className="font-semibold text-zinc-900 truncate">{project.name}</h3>
              </div>

              <div className="flex items-center gap-2 flex-shrink-0">
                <Bot size={14} className={project.autonomous_enabled ? 'text-brand-600' : 'text-zinc-400'} />
                <Tooltip content={project.autonomous_enabled ? 'Disable autonomous agents' : 'Enable autonomous agents'}>
                  <button
                    type="button"
                    onClick={() => handleToggleAutonomous(project.id, project.autonomous_enabled)}
                    className={`relative w-10 h-[22px] rounded-full transition-colors ${
                      project.autonomous_enabled ? 'bg-brand-600' : 'bg-zinc-300'
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 left-0.5 w-[18px] h-[18px] bg-white rounded-full shadow transition-transform ${
                        project.autonomous_enabled ? 'translate-x-[18px]' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </Tooltip>
              </div>
            </div>

            {project.description && (
              <p className="text-sm text-zinc-500 mb-4 line-clamp-1">{project.description}</p>
            )}

            {/* Goals */}
            <div className="space-y-2">
              {goals.length > 0 && (
                <p className="text-xs font-medium text-zinc-500 uppercase tracking-wider">Goals</p>
              )}

              {goals.map((goal) => {
                const pendingSuggestions = taskSuggestions.filter(s => s.goal_id === goal.id && s.status === 'pending').length;
                const inProgressTasks = tasks.filter(t => t.project_goal_id === goal.id && t.status === 'in_progress').length;
                const completedTasks = tasks.filter(t => t.project_goal_id === goal.id && t.status === 'done').length;

                return (
                  <div
                    key={goal.id}
                    className="bg-zinc-50 rounded-lg border border-zinc-100 p-3"
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h4 className="font-medium text-sm text-zinc-900">{goal.title}</h4>
                          <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${statusColors[goal.status]}`}>
                            {goal.status}
                          </span>
                        </div>
                        {goal.description && (
                          <p className="text-xs text-zinc-500 mt-1 line-clamp-1">{goal.description}</p>
                        )}
                        {goal.target_date && (
                          <p className="text-[10px] text-zinc-400 mt-1">Target: {goal.target_date}</p>
                        )}
                      </div>

                      <div className="flex items-center gap-1 flex-shrink-0 ml-2">
                        <Tooltip content="Edit">
                          <button
                            onClick={() => handleOpenEdit(goal)}
                            className="p-1 rounded text-zinc-400 hover:text-zinc-600 hover:bg-zinc-200 transition-colors"
                          >
                            <Edit size={13} />
                          </button>
                        </Tooltip>
                        <Tooltip content="Archive">
                          <button
                            onClick={() => handleArchive(goal.id)}
                            className="p-1 rounded text-zinc-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                          >
                            <Archive size={13} />
                          </button>
                        </Tooltip>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 mt-2 flex-wrap">
                      {pendingSuggestions > 0 && (
                        <span className="text-[10px] font-medium bg-amber-50 text-amber-700 px-1.5 py-0.5 rounded-full">
                          {pendingSuggestions} pending
                        </span>
                      )}
                      {inProgressTasks > 0 && (
                        <span className="text-[10px] font-medium bg-blue-50 text-blue-700 px-1.5 py-0.5 rounded-full">
                          {inProgressTasks} in progress
                        </span>
                      )}
                      {completedTasks > 0 && (
                        <span className="text-[10px] font-medium bg-emerald-50 text-emerald-700 px-1.5 py-0.5 rounded-full">
                          {completedTasks} done
                        </span>
                      )}
                      {pendingSuggestions === 0 && inProgressTasks === 0 && completedTasks === 0 && (
                        <span className="text-[10px] text-zinc-400">No suggestions or tasks yet</span>
                      )}
                    </div>
                  </div>
                );
              })}

              {goals.length === 0 && (
                <p className="text-sm text-zinc-400 py-2">
                  No goals yet — add one to start receiving agent suggestions
                </p>
              )}

              <button
                onClick={() => handleOpenCreate(project.id)}
                className="flex items-center gap-1.5 text-sm text-brand-600 hover:text-brand-700 font-medium mt-1 transition-colors"
              >
                <Plus size={14} />
                Add Goal
              </button>
            </div>

            {/* Project-level stats */}
            <div className="flex items-center gap-3 mt-4 pt-3 border-t border-zinc-100 text-xs text-zinc-500">
              {projectSuggestions.length > 0 && (
                <span>{projectSuggestions.length} pending suggestion{projectSuggestions.length !== 1 ? 's' : ''}</span>
              )}
              {projectActiveTasks.length > 0 && (
                <span>{projectActiveTasks.length} active task{projectActiveTasks.length !== 1 ? 's' : ''}</span>
              )}
              {projectSuggestions.length === 0 && projectActiveTasks.length === 0 && (
                <span>No active suggestions or tasks</span>
              )}
            </div>
          </div>
        );
      })}

      {activeProjects.length === 0 && (
        <div className="bg-white rounded-xl border border-zinc-200 flex flex-col items-center justify-center p-8 text-center lg:col-span-2">
          <div className="w-10 h-10 rounded-full bg-zinc-100 flex items-center justify-center mb-3">
            <FolderKanban size={18} className="text-zinc-400" />
          </div>
          <p className="text-sm font-medium text-zinc-500">No projects</p>
          <p className="text-xs text-zinc-400 mt-1">Create projects and add goals to start using agent workflows</p>
        </div>
      )}

      {/* Create/Edit Goal Modal */}
      <Modal
        isOpen={isFormOpen}
        onClose={() => { setIsFormOpen(false); resetForm(); }}
        title={editingGoal ? 'Edit Goal' : 'New Goal'}
        size="md"
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          <Select
            label="Project"
            value={formProjectId}
            onChange={setFormProjectId}
            options={projects.map(p => ({ value: p.id, label: p.name }))}
          />

          <Input
            label="Title"
            value={formTitle}
            onChange={(e) => setFormTitle(e.target.value)}
            placeholder="Goal title"
            required
          />

          <Textarea
            label="Description"
            value={formDescription}
            onChange={setFormDescription}
            placeholder="Describe the goal..."
            rows={3}
          />

          <DateInput
            label="Target Date"
            value={formTargetDate}
            onChange={setFormTargetDate}
            clearable
          />

          <Select
            label="Status"
            value={formStatus}
            onChange={(v) => setFormStatus(v as ProjectGoal['status'])}
            options={[
              { value: 'active', label: 'Active' },
              { value: 'achieved', label: 'Achieved' },
              { value: 'paused', label: 'Paused' },
              { value: 'abandoned', label: 'Abandoned' },
            ]}
          />

          <div className="flex justify-end gap-3 pt-4">
            <Button type="button" variant="ghost" onClick={() => { setIsFormOpen(false); resetForm(); }}>
              Cancel
            </Button>
            <Button type="submit">
              {editingGoal ? 'Save Changes' : 'Create Goal'}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
