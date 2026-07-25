'use client';

import { useState, useEffect } from 'react';
import { Lead } from '@/lib/types';
import { useApp } from '@/lib/store';
import Modal from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { RichTextEditor } from '@/components/ui/RichTextEditor';
import { MultiSelect } from '@/components/ui/inputs/MultiSelect';
import { formatPhone } from '@/lib/format-phone';

interface LeadFormProps {
  isOpen: boolean;
  onClose: () => void;
  lead?: Lead | null;
  onConvertRequested?: (lead: Lead) => void;
}

const sourceOptions = [
  { value: 'referral', label: 'Referral' },
  { value: 'website', label: 'Website' },
  { value: 'social', label: 'Social' },
  { value: 'cold_outreach', label: 'Cold Outreach' },
  { value: 'event', label: 'Event' },
  { value: 'network', label: 'Network' },
  { value: 'other', label: 'Other' },
];

const statusOptions = [
  { value: 'new', label: 'New' },
  { value: 'contacted', label: 'Contacted' },
  { value: 'qualified', label: 'Qualified' },
  { value: 'proposal', label: 'Proposal' },
  { value: 'won', label: 'Won' },
  { value: 'lost', label: 'Lost' },
];

export function LeadForm({ isOpen, onClose, lead, onConvertRequested }: LeadFormProps) {
  const { team, addLead, updateLead } = useApp();

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [company, setCompany] = useState('');
  const [source, setSource] = useState('');
  const [status, setStatus] = useState('');
  const [notes, setNotes] = useState('');
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (lead) {
      setName(lead.name);
      setEmail(lead.email);
      setPhone(formatPhone(lead.phone));
      setCompany(lead.company);
      setSource(lead.source);
      setStatus(lead.status);
      setNotes(lead.notes);
      setMemberIds(lead.member_ids || []);
    } else {
      setName('');
      setEmail('');
      setPhone('');
      setCompany('');
      setSource('');
      setStatus('');
      setNotes('');
      setMemberIds([]);
    }
  }, [lead, isOpen]);

  const validate = () => {
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = 'Name is required';
    if (!source) errs.source = 'Source is required';
    if (!status) errs.status = 'Status is required';
    if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      errs.email = 'Invalid email format';
    }
    if (phone.trim() && !/^[+\d\s\-().]{7,20}$/.test(phone.trim())) {
      errs.phone = 'Invalid phone number';
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;

    // If editing an existing lead and status changed to "won", redirect to Convert flow
    if (lead && status === 'won' && lead.status !== 'won' && onConvertRequested) {
      // Save any other field changes first (without the won status)
      const leadData = {
        name: name.trim(),
        email: email.trim(),
        phone: phone.trim(),
        company: company.trim(),
        source: source as Lead['source'],
        status: lead.status,
        notes,
        assigned_to: memberIds.length > 0 ? memberIds[0] : null,
        member_ids: memberIds,
        contact_id: lead.contact_id || null,
      };
      await updateLead(lead.id, leadData);
      onClose();
      onConvertRequested({ ...lead, ...leadData });
      return;
    }

    setSaving(true);
    const leadData = {
      name: name.trim(),
      email: email.trim(),
      phone: phone.trim(),
      company: company.trim(),
      source: source as Lead['source'],
      status: status as Lead['status'],
      notes,
      assigned_to: memberIds.length > 0 ? memberIds[0] : null,
      member_ids: memberIds,
      contact_id: lead?.contact_id || null,
    };

    if (lead) {
      await updateLead(lead.id, leadData);
    } else {
      await addLead(leadData);
    }

    setSaving(false);
    onClose();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={lead ? 'Edit Lead' : 'New Lead'}
      size="lg"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <Input
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Contact name"
            required
            error={errors.name}
          />
          <Input
            label="Company"
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            placeholder="Company name"
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Input
            label="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email address"
            error={errors.email}
          />
          <Input
            label="Phone"
            value={phone}
            onChange={(e) => setPhone(formatPhone(e.target.value))}
            placeholder="(555) 555-5555"
            error={errors.phone}
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Select
            label="Source"
            value={source}
            onChange={(value) => setSource(value)}
            options={sourceOptions}
            placeholder="Select source..."
            error={errors.source}
          />
          <Select
            label="Status"
            value={status}
            onChange={(value) => setStatus(value)}
            options={statusOptions}
            placeholder="Select status..."
            error={errors.status}
          />
        </div>

        <MultiSelect
          label="Team Members"
          options={team.map(m => ({ value: m.id, label: m.name }))}
          value={memberIds}
          onChange={setMemberIds}
          placeholder="Select team members..."
          selectAll
          searchable={team.length > 4}
        />

        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-zinc-300">Notes</label>
          <RichTextEditor
            value={notes}
            onChange={setNotes}
            placeholder="Additional notes..."
            rows={3}
          />
        </div>

        <div className="flex justify-end gap-3 pt-4">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? 'Saving...' : lead ? 'Save Changes' : 'Add Lead'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
