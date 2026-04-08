'use client';

import { useState, useEffect } from 'react';
import { LeadProposal, LEAD_PROPOSAL_STATUSES } from '@/lib/types';
import { useApp } from '@/lib/store';
import Modal from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/inputs/Textarea';

interface LeadProposalFormProps {
  isOpen: boolean;
  onClose: () => void;
  leadId: string;
  proposal?: LeadProposal | null;
}

const statusOptions = [
  { value: 'draft', label: 'Draft' },
  { value: 'sent', label: 'Sent' },
  { value: 'accepted', label: 'Accepted' },
  { value: 'rejected', label: 'Rejected' },
];

export function LeadProposalForm({ isOpen, onClose, leadId, proposal }: LeadProposalFormProps) {
  const { addLeadProposal, updateLeadProposal } = useApp();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [estimatedValue, setEstimatedValue] = useState('');
  const [status, setStatus] = useState<LeadProposal['status']>('draft');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (proposal) {
      setTitle(proposal.title);
      setDescription(proposal.description);
      setEstimatedValue(proposal.estimated_value != null ? String(proposal.estimated_value) : '');
      setStatus(proposal.status);
    } else {
      setTitle('');
      setDescription('');
      setEstimatedValue('');
      setStatus('draft');
    }
    setErrors({});
  }, [proposal, isOpen]);

  const validate = () => {
    const errs: Record<string, string> = {};
    if (!title.trim()) errs.title = 'Title is required';
    if (estimatedValue && isNaN(parseFloat(estimatedValue))) errs.estimatedValue = 'Invalid amount';
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;

    setSaving(true);
    const data = {
      lead_id: leadId,
      title: title.trim(),
      description: description.trim(),
      estimated_value: estimatedValue ? parseFloat(estimatedValue) : null,
      status,
      sent_at: status === 'sent' && !proposal?.sent_at ? new Date().toISOString() : proposal?.sent_at || null,
    };

    if (proposal) {
      await updateLeadProposal(proposal.id, data);
    } else {
      await addLeadProposal(data);
    }

    setSaving(false);
    onClose();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={proposal ? 'Edit Proposal' : 'Add Proposal'}
      size="lg"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input
          label="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Proposal title"
          required
          error={errors.title}
        />

        <Textarea
          label="Description"
          value={description}
          onChange={setDescription}
          placeholder="Proposal details..."
          rows={3}
        />

        <div className="grid grid-cols-2 gap-4">
          <Input
            label="Estimated Value ($)"
            type="number"
            value={estimatedValue}
            onChange={(e) => setEstimatedValue(e.target.value)}
            placeholder="0"
            min="0"
            step="0.01"
            error={errors.estimatedValue}
          />
          <Select
            label="Status"
            value={status}
            onChange={(value) => setStatus(value as LeadProposal['status'])}
            options={statusOptions}
          />
        </div>

        <div className="flex justify-end gap-3 pt-4">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? 'Saving...' : proposal ? 'Save Changes' : 'Add Proposal'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
