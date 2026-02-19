'use client';

import { useState, useEffect, useCallback } from 'react';
import { Project } from '@/lib/types';
import { useApp } from '@/lib/store';
import Modal from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';

const PROJECT_COLORS = [
  '#6366F1', '#8B5CF6', '#EC4899', '#EF4444',
  '#F59E0B', '#10B981', '#06B6D4', '#3B82F6',
];

interface ProjectFormProps {
  isOpen: boolean;
  onClose: () => void;
  project?: Project | null;
}

export function ProjectForm({ isOpen, onClose, project }: ProjectFormProps) {
  const { team, addProject, updateProject } = useApp();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState(PROJECT_COLORS[0]);
  const [status, setStatus] = useState<Project['status']>('active');
  const [startDate, setStartDate] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [confirmStatusChange, setConfirmStatusChange] = useState(false);

  useEffect(() => {
    if (project) {
      setName(project.name);
      setDescription(project.description);
      setColor(project.color);
      setStatus(project.status);
      setStartDate(project.start_date || '');
      setDueDate(project.due_date || '');
      setMemberIds(project.member_ids);
    } else {
      setName('');
      setDescription('');
      setColor(PROJECT_COLORS[0]);
      setStatus('active');
      setStartDate('');
      setDueDate('');
      setMemberIds([]);
    }
  }, [project, isOpen]);

  const doSave = async () => {
    setSaving(true);
    const projectData = {
      name: name.trim(),
      description: description.trim(),
      color,
      status,
      start_date: startDate || null,
      due_date: dueDate || null,
      member_ids: memberIds,
    };

    if (project) {
      await updateProject(project.id, projectData);
    } else {
      await addProject(projectData);
    }

    setSaving(false);
    onClose();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    // Confirm when changing an existing project's status to completed/archived
    if (project && project.status === 'active' && status !== 'active') {
      setConfirmStatusChange(true);
      return;
    }

    await doSave();
  };

  const toggleMember = (userId: string) => {
    setMemberIds(prev =>
      prev.includes(userId)
        ? prev.filter(id => id !== userId)
        : [...prev, userId]
    );
  };

  const statusOptions = [
    { value: 'active', label: 'Active' },
    { value: 'completed', label: 'Completed' },
    { value: 'archived', label: 'Archived' },
  ];

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={project ? 'Edit Project' : 'New Project'}
      size="lg"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input
          label="Project Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Enter project name"
          required
        />

        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-zinc-700">Description</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value.slice(0, 100))}
            placeholder="Describe the project..."
            rows={2}
            maxLength={100}
            className="w-full px-3 py-2 text-sm bg-white border border-zinc-200 rounded-lg outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 transition-all resize-none"
          />
          <p className="text-xs text-zinc-400 text-right">{description.length}/100</p>
        </div>

        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-zinc-700">Color</label>
          <div className="flex gap-2">
            {PROJECT_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                className={`w-8 h-8 rounded-lg transition-all ${
                  color === c ? 'ring-2 ring-offset-2 ring-indigo-500 scale-110' : 'hover:scale-105'
                }`}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Select
            label="Status"
            value={status}
            onChange={(value) => setStatus(value as Project['status'])}
            options={statusOptions}
          />

          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-zinc-700">Team Members</label>
            <div className="flex flex-wrap gap-2 p-2 bg-zinc-50 border border-zinc-200 rounded-lg max-h-24 overflow-y-auto">
              {team.map((member) => (
                <button
                  key={member.id}
                  type="button"
                  onClick={() => toggleMember(member.id)}
                  className={`px-2 py-1 text-xs rounded-full transition-all ${
                    memberIds.includes(member.id)
                      ? 'bg-indigo-100 text-indigo-700 border border-indigo-300'
                      : 'bg-white text-zinc-600 border border-zinc-200 hover:border-zinc-300'
                  }`}
                >
                  {member.name}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Input
            label="Start Date"
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
          <Input
            label="Due Date"
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
          />
        </div>

        <div className="flex justify-end gap-3 pt-4">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? 'Saving...' : project ? 'Save Changes' : 'Create Project'}
          </Button>
        </div>
      </form>

      <ConfirmDialog
        isOpen={confirmStatusChange}
        onClose={() => setConfirmStatusChange(false)}
        onConfirm={doSave}
        title={status === 'archived' ? 'Archive Project' : 'Complete Project'}
        message={
          status === 'archived'
            ? `Are you sure you want to archive "${name}"? It will be hidden from the sidebar and active views.`
            : `Are you sure you want to mark "${name}" as completed? It will be moved to the completed section.`
        }
        confirmLabel={status === 'archived' ? 'Archive' : 'Complete'}
        variant="default"
      />
    </Modal>
  );
}
