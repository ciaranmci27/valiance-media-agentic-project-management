'use client';

import { useState, useEffect } from 'react';
import { Lead } from '@/lib/types';
import { useApp } from '@/lib/store';
import Modal from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/inputs/Textarea';
import { siteConfig } from '@/site-config';
import { formatPhone } from '@/lib/format-phone';

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
  const { convertLead, updateLead } = useApp();

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

  const handleSkip = () => {
    if (!lead) return;
    updateLead(lead.id, { status: 'won' });
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
        <div className="bg-white/[0.03] rounded-lg p-4 border border-white/[0.08]">
          <h3 className="text-sm font-medium text-zinc-300 mb-2">Lead Info</h3>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div>
              <span className="text-zinc-400">Name:</span>{' '}
              <span className="text-white">{lead.name}</span>
            </div>
            <div>
              <span className="text-zinc-400">Company:</span>{' '}
              <span className="text-white">{lead.company || '—'}</span>
            </div>
            <div>
              <span className="text-zinc-400">Email:</span>{' '}
              <span className="text-white">{lead.email || '—'}</span>
            </div>
            <div>
              <span className="text-zinc-400">Phone:</span>{' '}
              <span className="text-white">{lead.phone ? formatPhone(lead.phone) : '—'}</span>
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
          <label className="block text-sm font-medium text-zinc-300">Project Color</label>
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

        <Textarea
          label="Project Description (optional)"
          value={projectDescription}
          onChange={setProjectDescription}
          placeholder="Describe the project..."
          rows={3}
        />

        <div className="flex items-center justify-between pt-4">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <div className="flex gap-3">
            <Button type="button" variant="secondary" onClick={handleSkip}>
              Skip
            </Button>
            <Button type="submit">
              Convert to Project
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
