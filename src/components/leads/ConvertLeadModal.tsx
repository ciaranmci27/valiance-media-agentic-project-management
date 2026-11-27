'use client';

import { useState, useEffect } from 'react';
import { Lead } from '@/lib/types';
import { useApp } from '@/lib/store';
import Modal, { ModalAdvanced } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/inputs/Textarea';
import { useBrand } from '@/lib/brand/context';

const OTHER_COLORS = ['#8B5CF6', '#EC4899', '#EF4444', '#F59E0B', '#10B981', '#06B6D4', '#3B82F6'];

interface ConvertLeadModalProps {
  isOpen: boolean;
  onClose: () => void;
  lead: Lead | null;
}

export function ConvertLeadModal({ isOpen, onClose, lead }: ConvertLeadModalProps) {
  const { convertLead, updateLead } = useApp();
  const brand = useBrand();
  // The brand color first; a brand color that matches another swatch shows once.
  const projectColors = [...new Set([brand.colors.brand[500], ...OTHER_COLORS])];

  const [projectName, setProjectName] = useState('');
  const [projectColor, setProjectColor] = useState(projectColors[0]);
  const [projectDescription, setProjectDescription] = useState('');

  useEffect(() => {
    if (lead && isOpen) {
      setProjectName(lead.company || lead.name || '');
      setProjectColor(brand.colors.brand[500]);
      setProjectDescription('');
    }
  }, [lead, isOpen, brand.colors.brand]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!lead || !projectName.trim()) return;

    convertLead(lead.id, projectName.trim(), projectColor, projectDescription.trim());
    setProjectName('');
    setProjectColor(projectColors[0]);
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
      title="Convert to project"
      size="lg"
      primaryAction={{ label: 'Create project', form: 'convert-lead-form', disabled: !projectName.trim() }}
    >
      <form id="convert-lead-form" onSubmit={handleSubmit} className="space-y-4">
        <Input
          label="Project name"
          value={projectName}
          onChange={(e) => setProjectName(e.target.value)}
          placeholder="Project name"
          required
        />

        <ModalAdvanced label="Color and description">
        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-zinc-300">Project color</label>
          <div className="flex gap-2">
            {projectColors.map((c) => (
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
          label="Project description"
          value={projectDescription}
          onChange={setProjectDescription}
          placeholder="Describe the project"
          rows={3}
        />

        </ModalAdvanced>

        <p className="text-xs text-zinc-400">
          No project needed?{' '}
          <button type="button" onClick={handleSkip} className="rounded font-medium text-brand-300 underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500">
            Mark it won
          </button>
        </p>
      </form>
    </Modal>
  );
}
