'use client';

import { useState, useEffect } from 'react';
import { LeadInteraction, LEAD_INTERACTION_TYPES } from '@/lib/types';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { toLocalDatetimeString } from '@/lib/date-utils';
import Modal from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/inputs/Textarea';
import { DateInput } from '@/components/ui/inputs/DateInput';
import { TimeInput } from '@/components/ui/inputs/TimeInput';

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
  const { addLeadInteraction, updateLeadInteraction, team } = useApp();
  const { teamMemberId } = useAuth();
  const tz = team.find(m => m.id === teamMemberId)?.timezone;

  const [type, setType] = useState<LeadInteraction['type']>('note');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [occurredDate, setOccurredDate] = useState('');
  const [occurredTime, setOccurredTime] = useState('');
  const [scheduledDate, setScheduledDate] = useState('');
  const [scheduledTime, setScheduledTime] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const splitDateTime = (iso: string | null | undefined): [string, string] => {
    if (!iso) return ['', ''];
    const local = toLocalDatetimeString(iso, tz);
    const [d, t] = local.split('T');
    return [d || '', t || ''];
  };

  const joinDateTime = (date: string, time: string): string | null => {
    if (!date) return null;
    return `${date}T${time || '09:00'}`;
  };

  useEffect(() => {
    if (interaction) {
      setType(interaction.type);
      setTitle(interaction.title);
      setDescription(interaction.description);
      const [od, ot] = splitDateTime(interaction.occurred_at);
      setOccurredDate(od);
      setOccurredTime(ot);
      const [sd, st] = splitDateTime(interaction.scheduled_at);
      setScheduledDate(sd);
      setScheduledTime(st);
    } else {
      setType('note');
      setTitle('');
      setDescription('');
      const [od, ot] = splitDateTime(new Date().toISOString());
      setOccurredDate(od);
      setOccurredTime(ot);
      setScheduledDate('');
      setScheduledTime('');
    }
    setErrors({});
  }, [interaction, isOpen]);

  const validate = () => {
    const errs: Record<string, string> = {};
    if (!title.trim()) errs.title = 'Title is required';
    if (type === 'follow_up' && !scheduledDate) errs.scheduledAt = 'Scheduled date is required for follow-ups';
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;

    setSaving(true);
    const occurredLocal = joinDateTime(occurredDate, occurredTime);
    const scheduledLocal = joinDateTime(scheduledDate, scheduledTime);
    const data = {
      lead_id: leadId,
      type,
      title: title.trim(),
      description: description.trim(),
      occurred_at: occurredLocal ? new Date(occurredLocal).toISOString() : new Date().toISOString(),
      scheduled_at: scheduledLocal ? new Date(scheduledLocal).toISOString() : null,
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

        <Textarea
          label="Description"
          value={description}
          onChange={setDescription}
          placeholder="Details about this interaction..."
          rows={3}
        />

        <div>
          <label className="block text-sm font-medium text-input-text-label mb-1.5">Occurred At</label>
          <div className="grid grid-cols-2 gap-2">
            <DateInput
              value={occurredDate}
              onChange={setOccurredDate}
              clearable
            />
            <TimeInput
              value={occurredTime}
              onChange={setOccurredTime}
              minuteStep={5}
            />
          </div>
        </div>

        {type === 'follow_up' && (
          <div>
            <label className="block text-sm font-medium text-input-text-label mb-1.5">Scheduled For</label>
            <div className="grid grid-cols-2 gap-2">
              <DateInput
                value={scheduledDate}
                onChange={setScheduledDate}
                clearable
              />
              <TimeInput
                value={scheduledTime}
                onChange={setScheduledTime}
                minuteStep={5}
              />
            </div>
            {errors.scheduledAt && (
              <p className="text-xs text-red-500 mt-1">{errors.scheduledAt}</p>
            )}
          </div>
        )}

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
