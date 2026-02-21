'use client';

import { useState, useEffect } from 'react';
import { Lead } from '@/lib/types';
import { useApp } from '@/lib/store';
import Modal from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { siteConfig } from '@/site-config';

const PROJECT_COLORS = [
  siteConfig.colors.brand[500], '#8B5CF6', '#EC4899', '#EF4444',
  '#F59E0B', '#10B981', '#06B6D4', '#3B82F6',
];

interface ConvertLeadModalProps {
  isOpen: boolean;
  onClose: () => void;
  lead: Lead | null;
}

export function ConvertLeadModal({ isOpen, onClose, lead }: ConvertLeadModalProps) {
  const { convertLead } = useApp();

  const [projectName, setProjectName] = useState('');
  const [projectColor, setProjectColor] = useState(PROJECT_COLORS[0]);
  const [projectDescription, setProjectDescription] = useState('');

  useEffect(() => {
    if (lead && isOpen) {
      setProjectName(lead.company || lead.name || '');
      setProjectColor(PROJECT_COLORS[0]);
      setProjectDescription('');
    }
  }, [lead, isOpen]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!lead || !projectName.trim()) return;

    convertLead(lead.id, projectName.trim(), projectColor, projectDescription.trim());
    setProjectName('');
    setProjectColor(PROJECT_COLORS[0]);
    setProjectDescription('');
    onClose();
  };

  if (!lead) return null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Convert Lead to Project"
      size="lg"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="bg-zinc-50 rounded-lg p-4 border border-zinc-200">
          <h3 className="text-sm font-medium text-zinc-700 mb-2">Lead Info</h3>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div>
              <span className="text-zinc-500">Name:</span>{' '}
              <span className="text-zinc-900">{lead.name}</span>
            </div>
            <div>
              <span className="text-zinc-500">Company:</span>{' '}
              <span className="text-zinc-900">{lead.company || '—'}</span>
            </div>
            <div>
              <span className="text-zinc-500">Email:</span>{' '}
              <span className="text-zinc-900">{lead.email || '—'}</span>
            </div>
            <div>
              <span className="text-zinc-500">Phone:</span>{' '}
              <span className="text-zinc-900">{lead.phone || '—'}</span>
            </div>
          </div>
        </div>

        <Input
          label="Project Name"
          value={projectName}
          onChange={(e) => setProjectName(e.target.value)}
          placeholder="Enter project name"
          required
        />

        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-zinc-700">Project Color</label>
          <div className="flex gap-2">
            {PROJECT_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setProjectColor(c)}
                className={`w-8 h-8 rounded-lg transition-all ${
                  projectColor === c ? 'ring-2 ring-offset-2 ring-brand-500 scale-110' : 'hover:scale-105'
                }`}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-zinc-700">Project Description (optional)</label>
          <textarea
            value={projectDescription}
            onChange={(e) => setProjectDescription(e.target.value)}
            placeholder="Describe the project..."
            rows={3}
            className="w-full px-3 py-2 text-sm bg-white border border-zinc-200 rounded-lg outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 transition-all resize-none"
          />
        </div>

        <div className="flex justify-end gap-3 pt-4">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit">
            Convert
          </Button>
        </div>
      </form>
    </Modal>
  );
}
