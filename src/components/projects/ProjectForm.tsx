'use client';

import { useState, useEffect } from 'react';
import { Project } from '@/lib/types';
import { useApp } from '@/lib/store';
import Modal from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';

const PROJECT_COLORS = [
  '#6366F1', '#8B5CF6', '#EC4899', '#EF4444',
  '#F59E0B', '#10B981', '#06B6D4', '#3B82F6',
];

interface ProjectFormProps {
  isOpen: boolean;
  onClose: () => void;
  project?: Project | null;
  defaultClientId?: string;
}

export function ProjectForm({ isOpen, onClose, project, defaultClientId }: ProjectFormProps) {
  const { team, clients, addProject, updateProject } = useApp();
  
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState(PROJECT_COLORS[0]);
  const [status, setStatus] = useState<Project['status']>('active');
  const [startDate, setStartDate] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [clientId, setClientId] = useState('');

  useEffect(() => {
    if (project) {
      setName(project.name);
      setDescription(project.description);
      setColor(project.color);
      setStatus(project.status);
      setStartDate(project.start_date || '');
      setDueDate(project.due_date || '');
      setMemberIds(project.member_ids);
      setClientId(project.client_id || '');
    } else {
      setName('');
      setDescription('');
      setColor(PROJECT_COLORS[0]);
      setStatus('active');
      setStartDate('');
      setDueDate('');
      setMemberIds([]);
      setClientId(defaultClientId || '');
    }
  }, [project, isOpen, defaultClientId]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!name.trim()) return;

    const projectData = {
      name: name.trim(),
      description: description.trim(),
      color,
      status,
      start_date: startDate || null,
      due_date: dueDate || null,
      member_ids: memberIds,
      client_id: clientId || null,
    };

    if (project) {
      updateProject(project.id, projectData);
    } else {
      addProject(projectData);
    }

    onClose();
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
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Describe the project..."
            rows={3}
            className="w-full px-3 py-2 text-sm bg-white border border-zinc-200 rounded-lg outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 transition-all resize-none"
          />
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
            onChange={(e) => setStatus(e.target.value as Project['status'])}
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

        <Select
          label="Client (optional)"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          options={[
            { value: '', label: 'No client' },
            ...clients.map(c => ({ value: c.id, label: c.name })),
          ]}
        />

        <div className="flex justify-end gap-3 pt-4">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit">
            {project ? 'Save Changes' : 'Create Project'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
