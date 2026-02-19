'use client';

import { useState, useEffect } from 'react';
import { Lead } from '@/lib/types';
import { useApp } from '@/lib/store';
import Modal from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { RichTextEditor } from '@/components/ui/RichTextEditor';

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
  const [value, setValue] = useState('');
  const [equity, setEquity] = useState('');
  const [notes, setNotes] = useState('');
  const [memberIds, setMemberIds] = useState<string[]>([]);
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
      setEquity(lead.equity != null ? String(lead.equity) : '');
      setNotes(lead.notes);
      setMemberIds(lead.member_ids || []);
    } else {
      setName('');
      setEmail('');
      setPhone('');
      setCompany('');
      setSource('');
      setStatus('');
      setValue('');
      setEquity('');
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
    if (value && isNaN(parseFloat(value))) {
      errs.value = 'Invalid amount';
    }
    if (equity && isNaN(parseFloat(equity))) {
      errs.equity = 'Invalid percentage';
    } else if (equity && (parseFloat(equity) < 0 || parseFloat(equity) > 100)) {
      errs.equity = 'Must be 0-100';
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
        value: value ? parseFloat(value) : null,
        equity: equity ? parseFloat(equity) : null,
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
      value: value ? parseFloat(value) : null,
      equity: equity ? parseFloat(equity) : null,
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
            onChange={(e) => setPhone(e.target.value)}
            placeholder="Phone number"
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

        <div className="grid grid-cols-2 gap-4">
          <Input
            label="Value ($)"
            type="number"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="0"
            min="0"
            step="0.01"
            error={errors.value}
          />
          <Input
            label="Equity (%)"
            type="number"
            value={equity}
            onChange={(e) => setEquity(e.target.value)}
            placeholder="0"
            min="0"
            max="100"
            step="0.01"
            error={errors.equity}
          />
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label className="block text-sm font-medium text-zinc-700">Team Members</label>
            <button
              type="button"
              onClick={() => setMemberIds(memberIds.length === team.length ? [] : team.map(m => m.id))}
              className="text-xs text-indigo-600 hover:text-indigo-700 transition-colors"
            >
              {memberIds.length === team.length ? 'Deselect All' : 'Select All'}
            </button>
          </div>
          <div className="flex flex-wrap gap-2 p-2 bg-zinc-50 border border-zinc-200 rounded-lg max-h-24 overflow-y-auto">
            {team.map((member) => (
              <button
                key={member.id}
                type="button"
                onClick={() => setMemberIds(prev =>
                  prev.includes(member.id)
                    ? prev.filter(id => id !== member.id)
                    : [...prev, member.id]
                )}
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

        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-zinc-700">Notes</label>
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
