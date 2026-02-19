'use client';

import { useState, useEffect } from 'react';
import { Lead } from '@/lib/types';
import { useApp } from '@/lib/store';
import Modal from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';

interface LeadFormProps {
  isOpen: boolean;
  onClose: () => void;
  lead?: Lead | null;
}

const sourceOptions = [
  { value: 'referral', label: 'Referral' },
  { value: 'website', label: 'Website' },
  { value: 'social', label: 'Social' },
  { value: 'cold_outreach', label: 'Cold Outreach' },
  { value: 'event', label: 'Event' },
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

export function LeadForm({ isOpen, onClose, lead }: LeadFormProps) {
  const { team, addLead, updateLead } = useApp();

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [company, setCompany] = useState('');
  const [source, setSource] = useState<Lead['source']>('other');
  const [status, setStatus] = useState<Lead['status']>('new');
  const [value, setValue] = useState('');
  const [notes, setNotes] = useState('');
  const [assignedTo, setAssignedTo] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (lead) {
      setName(lead.name);
      setEmail(lead.email);
      setPhone(lead.phone);
      setCompany(lead.company);
      setSource(lead.source);
      setStatus(lead.status);
      setValue(lead.value != null ? String(lead.value) : '');
      setNotes(lead.notes);
      setAssignedTo(lead.assigned_to || '');
    } else {
      setName('');
      setEmail('');
      setPhone('');
      setCompany('');
      setSource('other');
      setStatus('new');
      setValue('');
      setNotes('');
      setAssignedTo('');
    }
  }, [lead, isOpen]);

  const validate = () => {
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = 'Name is required';
    if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      errs.email = 'Invalid email format';
    }
    if (phone.trim() && !/^[+\d\s\-().]{7,20}$/.test(phone.trim())) {
      errs.phone = 'Invalid phone number';
    }
    if (value && isNaN(parseFloat(value))) {
      errs.value = 'Invalid amount';
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;

    setSaving(true);
    const leadData = {
      name: name.trim(),
      email: email.trim(),
      phone: phone.trim(),
      company: company.trim(),
      source,
      status,
      value: value ? parseFloat(value) : null,
      notes: notes.trim(),
      assigned_to: assignedTo || null,
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

  const assigneeOptions = [
    { value: '', label: 'Unassigned' },
    ...team.map(m => ({ value: m.id, label: m.name })),
  ];

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={lead ? 'Edit Lead' : 'New Lead'}
      size="lg"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Contact name"
          required
          error={errors.name}
        />

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
            onChange={(e) => setPhone(e.target.value)}
            placeholder="Phone number"
            error={errors.phone}
          />
        </div>

        <Input
          label="Company"
          value={company}
          onChange={(e) => setCompany(e.target.value)}
          placeholder="Company name"
        />

        <div className="grid grid-cols-3 gap-4">
          <Select
            label="Source"
            value={source}
            onChange={(value) => setSource(value as Lead['source'])}
            options={sourceOptions}
          />
          <Select
            label="Status"
            value={status}
            onChange={(value) => setStatus(value as Lead['status'])}
            options={statusOptions}
          />
          <Input
            label="Value ($)"
            type="number"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="0"
            min="0"
            step="0.01"
          />
        </div>

        <Select
          label="Assigned To"
          value={assignedTo}
          onChange={(value) => setAssignedTo(value)}
          options={assigneeOptions}
        />

        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-zinc-700">Notes</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Additional notes..."
            rows={3}
            className="w-full px-3 py-2 text-sm bg-white border border-zinc-200 rounded-lg outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 transition-all resize-none"
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
