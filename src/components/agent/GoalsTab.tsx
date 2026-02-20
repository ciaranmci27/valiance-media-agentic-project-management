'use client';

import { useState } from 'react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { ProjectGoal } from '@/lib/types';
import Modal from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Target, Plus, Edit, Archive, ChevronRight } from 'lucide-react';
import { toast } from '@/components/ui/Toast';

export function GoalsTab() {
  const {
    projectGoals, projects, taskSuggestions, tasks,
    addGoal, updateGoal, archiveGoal,
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

  const handleOpenCreate = () => {
    resetForm();
    if (projects.length > 0) setFormProjectId(projects[0].id);
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

  const statusColors: Record<string, string> = {
    active: 'bg-emerald-100 text-emerald-700',
    achieved: 'bg-blue-100 text-blue-700',
    paused: 'bg-amber-100 text-amber-700',
    abandoned: 'bg-zinc-100 text-zinc-500',
  };

  // Group goals by project
  const goalsByProject = projects.reduce<Record<string, ProjectGoal[]>>((acc, project) => {
    const goals = projectGoals.filter(g => g.project_id === project.id);
    if (goals.length > 0) acc[project.id] = goals;
    return acc;
  }, {});

  // Include goals for projects not in the list (edge case)
  const orphanGoals = projectGoals.filter(g => !projects.find(p => p.id === g.project_id));

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={handleOpenCreate}>
          <Plus size={16} className="mr-1" />
          New Goal
        </Button>
      </div>

      {Object.entries(goalsByProject).map(([projectId, goals]) => {
        const project = projects.find(p => p.id === projectId);
        if (!project) return null;

        return (
          <div key={projectId} className="space-y-2">
            <div className="flex items-center gap-2 px-1">
              <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: project.color }} />
              <h3 className="text-sm font-semibold text-zinc-700">{project.name}</h3>
            </div>

            {goals.map((goal) => {
              const pendingSuggestions = taskSuggestions.filter(s => s.goal_id === goal.id && s.status === 'pending').length;
              const inProgressTasks = tasks.filter(t => t.project_goal_id === goal.id && t.status === 'in_progress').length;
              const completedTasks = tasks.filter(t => t.project_goal_id === goal.id && t.status === 'done').length;

              return (
                <div
                  key={goal.id}
                  className="bg-white rounded-xl border border-zinc-200 p-4 lg:p-5 hover:shadow-md transition-shadow"
                >
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h4 className="font-semibold text-zinc-900">{goal.title}</h4>
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusColors[goal.status]}`}>
                          {goal.status}
                        </span>
                      </div>
                      {goal.description && (
                        <p className="text-sm text-zinc-600 mt-1 line-clamp-2">{goal.description}</p>
                      )}
                      {goal.target_date && (
                        <p className="text-xs text-zinc-400 mt-1">Target: {goal.target_date}</p>
                      )}
                    </div>

                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button
                        onClick={() => handleOpenEdit(goal)}
                        className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 transition-colors"
                        title="Edit"
                      >
                        <Edit size={14} />
                      </button>
                      <button
                        onClick={() => handleArchive(goal.id)}
                        className="p-1.5 rounded-lg text-zinc-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                        title="Archive"
                      >
                        <Archive size={14} />
                      </button>
                    </div>
                  </div>

                  <div className="flex items-center gap-3 text-xs text-zinc-500 mt-3">
                    {pendingSuggestions > 0 && (
                      <span className="flex items-center gap-1 bg-amber-50 text-amber-700 px-2 py-1 rounded-full font-medium">
                        {pendingSuggestions} pending
                      </span>
                    )}
                    {inProgressTasks > 0 && (
                      <span className="flex items-center gap-1 bg-blue-50 text-blue-700 px-2 py-1 rounded-full font-medium">
                        {inProgressTasks} in progress
                      </span>
                    )}
                    {completedTasks > 0 && (
                      <span className="flex items-center gap-1 bg-emerald-50 text-emerald-700 px-2 py-1 rounded-full font-medium">
                        {completedTasks} done
                      </span>
                    )}
                    {pendingSuggestions === 0 && inProgressTasks === 0 && completedTasks === 0 && (
                      <span className="text-zinc-400">No suggestions or tasks yet</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}

      {projectGoals.length === 0 && (
        <div className="text-center py-12 bg-white rounded-xl border border-zinc-200">
          <Target className="mx-auto mb-3 text-zinc-400" size={40} />
          <h3 className="font-medium text-zinc-700 mb-1">No goals yet</h3>
          <p className="text-sm text-zinc-500">Create goals for your projects. AI agents will suggest tasks to achieve them.</p>
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

          <div>
            <label className="block text-sm font-medium text-zinc-700 mb-1">Description</label>
            <textarea
              value={formDescription}
              onChange={(e) => setFormDescription(e.target.value)}
              placeholder="Describe the goal..."
              className="w-full px-3 py-2 text-sm border border-zinc-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 min-h-[80px] resize-y"
            />
          </div>

          <Input
            label="Target Date"
            type="date"
            value={formTargetDate}
            onChange={(e) => setFormTargetDate(e.target.value)}
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
