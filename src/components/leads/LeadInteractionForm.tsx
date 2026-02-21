'use client';

import { useState, useEffect } from 'react';
import { LeadInteraction, LEAD_INTERACTION_TYPES } from '@/lib/types';
import { useApp } from '@/lib/store';
import Modal from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';

interface LeadInteractionFormProps {
  isOpen: boolean;
  onClose: () => void;
  leadId: string;
  interaction?: LeadInteraction | null;
}

const typeOptions = [
  { value: 'call', label: 'Call' },
  { value: 'email', label: 'Email' },
  { value: 'meeting', label: 'Meeting' },
  { value: 'note', label: 'Note' },
  { value: 'follow_up', label: 'Follow-up' },
];

export function LeadInteractionForm({ isOpen, onClose, leadId, interaction }: LeadInteractionFormProps) {
  const { addLeadInteraction, updateLeadInteraction } = useApp();

  const [type, setType] = useState<LeadInteraction['type']>('note');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [occurredAt, setOccurredAt] = useState('');
  const [scheduledAt, setScheduledAt] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (interaction) {
      setType(interaction.type);
      setTitle(interaction.title);
      setDescription(interaction.description);
      setOccurredAt(interaction.occurred_at ? new Date(interaction.occurred_at).toISOString().slice(0, 16) : '');
      setScheduledAt(interaction.scheduled_at ? new Date(interaction.scheduled_at).toISOString().slice(0, 16) : '');
    } else {
      setType('note');
      setTitle('');
      setDescription('');
      setOccurredAt(new Date().toISOString().slice(0, 16));
      setScheduledAt('');
    }
    setErrors({});
  }, [interaction, isOpen]);

  const validate = () => {
    const errs: Record<string, string> = {};
    if (!title.trim()) errs.title = 'Title is required';
    if (type === 'follow_up' && !scheduledAt) errs.scheduledAt = 'Scheduled date is required for follow-ups';
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;

    setSaving(true);
    const data = {
      lead_id: leadId,
      type,
      title: title.trim(),
      description: description.trim(),
      occurred_at: occurredAt ? new Date(occurredAt).toISOString() : new Date().toISOString(),
      scheduled_at: scheduledAt ? new Date(scheduledAt).toISOString() : null,
      completed: interaction?.completed ?? false,
    };

    if (interaction) {
      await updateLeadInteraction(interaction.id, data);
    } else {
      await addLeadInteraction(data);
    }

    setSaving(false);
    onClose();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={interaction ? 'Edit Interaction' : 'Add Interaction'}
      size="lg"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <Select
          label="Type"
          value={type}
          onChange={(value) => setType(value as LeadInteraction['type'])}
          options={typeOptions}
        />

        <Input
          label="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Interaction title"
          required
          error={errors.title}
        />

        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-zinc-700">Description</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Details about this interaction..."
            rows={3}
            className="w-full px-3 py-2 text-sm bg-white border border-zinc-200 rounded-lg outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 transition-all resize-none"
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Input
            label="Occurred At"
            type="datetime-local"
            value={occurredAt}
            onChange={(e) => setOccurredAt(e.target.value)}
          />
          {type === 'follow_up' && (
            <Input
              label="Scheduled For"
              type="datetime-local"
              value={scheduledAt}
              onChange={(e) => setScheduledAt(e.target.value)}
              error={errors.scheduledAt}
            />
          )}
        </div>

        <div className="flex justify-end gap-3 pt-4">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? 'Saving...' : interaction ? 'Save Changes' : 'Add Interaction'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
