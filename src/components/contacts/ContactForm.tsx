'use client';

import { useState, useEffect } from 'react';
import { Plus, X } from 'lucide-react';
import { Contact, ContactEmailDraft } from '@/lib/types';
import { useApp } from '@/lib/store';
import { useDemo } from '@/lib/demo-context';
import { createClient } from '@/lib/supabase/client';
import Modal from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { AvatarUpload } from '@/components/ui/AvatarUpload';
import { toast } from '@/components/ui/Toast';
import { Textarea } from '@/components/ui/inputs/Textarea';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { fieldLabelClass } from '@/components/ui/inputs/_shared';
import { formatPhone } from '@/lib/format-phone';
import { siteConfig } from '@/site-config';


const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** One editable address row. `key` is local only; `id` is the saved row, if any. */
interface EmailRow {
  key: string;
  id?: string;
  email: string;
  label: string;
  is_primary: boolean;
}

let rowSeq = 0;
const newRowKey = () => `email-row-${++rowSeq}`;

const blankRow = (isPrimary: boolean): EmailRow => ({ key: newRowKey(), email: '', label: '', is_primary: isPrimary });

/** A stable fingerprint of the list, so dirty checks ignore local row keys. */
const fingerprint = (rows: EmailRow[]) =>
  JSON.stringify(rows.map(row => [row.id ?? '', row.email.trim().toLowerCase(), row.label.trim(), row.is_primary]));

/** The rows worth saving: blanks dropped, exactly one primary. */
function toDrafts(rows: EmailRow[]): ContactEmailDraft[] {
  const filled = rows.filter(row => row.email.trim());
  const primaryKey = filled.find(row => row.is_primary)?.key ?? filled[0]?.key;
  return filled.map(row => ({
    ...(row.id ? { id: row.id } : {}),
    email: row.email.trim().toLowerCase(),
    label: row.label.trim() || null,
    is_primary: row.key === primaryKey,
  }));
}

interface ContactFormProps {
  isOpen: boolean;
  onClose: () => void;
  contact?: Contact | null;
}

export function ContactForm({ isOpen, onClose, contact }: ContactFormProps) {
  const { addContact, updateContact, getContactEmails, saveContactEmails } = useApp();
  const { isDemoMode } = useDemo();
  const supabase = createClient();

  const [name, setName] = useState('');
  const [emailRows, setEmailRows] = useState<EmailRow[]>(() => [blankRow(true)]);
  const [initialEmails, setInitialEmails] = useState('');
  const [phone, setPhone] = useState('');
  const [company, setCompany] = useState('');
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [avatarBlob, setAvatarBlob] = useState<Blob | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | undefined>(undefined);
  const [avatarUploading, setAvatarUploading] = useState(false);
  // A new contact whose addresses failed to save: a retry saves them on it
  // instead of creating the contact twice.
  const [createdId, setCreatedId] = useState<string | null>(null);

  const emailsDirty = fingerprint(emailRows) !== initialEmails;
  const isDirty = name !== (contact?.name || '') || emailsDirty ||
    phone !== (contact?.phone || '') || company !== (contact?.company || '') ||
    notes !== (contact?.notes || '');

  useEffect(() => {
    if (!isOpen || !isDirty) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isOpen, isDirty]);

  // Reset when the form opens or switches contact, never when the contact
  // merely refreshes (live sync), which would wipe edits in progress.
  const formKey = `${isOpen ? 'open' : 'closed'}:${contact?.id ?? 'new'}`;
  const [preparedFor, setPreparedFor] = useState<string | null>(null);
  if (formKey !== preparedFor) {
    setPreparedFor(formKey);
    if (contact) {
      const saved = getContactEmails(contact.id);
      const rows: EmailRow[] = saved.length > 0
        ? saved.map(row => ({ key: newRowKey(), id: row.id, email: row.email, label: row.label ?? '', is_primary: row.is_primary }))
        : [{ ...blankRow(true), email: contact.email }];
      if (!rows.some(row => row.is_primary)) rows[0] = { ...rows[0], is_primary: true };
      setEmailRows(rows);
      setInitialEmails(fingerprint(rows));
      setName(contact.name);
      setPhone(formatPhone(contact.phone));
      setCompany(contact.company);
      setNotes(contact.notes);
      setAvatarPreview(contact.avatar_url || undefined);
    } else {
      const rows = [blankRow(true)];
      setEmailRows(rows);
      setInitialEmails(fingerprint(rows));
      setName('');
      setPhone('');
      setCompany('');
      setNotes('');
      setAvatarPreview(undefined);
    }
    setAvatarBlob(null);
    setErrors({});
    setCreatedId(null);
  }

  const updateRow = (key: string, patch: Partial<EmailRow>) => {
    setEmailRows(prev => prev.map(row => (row.key === key ? { ...row, ...patch } : row)));
    setErrors(prev => {
      if (!prev[`email:${key}`]) return prev;
      const next = { ...prev };
      delete next[`email:${key}`];
      return next;
    });
  };

  const makePrimary = (key: string) => {
    setEmailRows(prev => prev.map(row => ({ ...row, is_primary: row.key === key })));
  };

  const addRow = () => {
    setEmailRows(prev => [...prev, blankRow(prev.length === 0)]);
  };

  const removeRow = (key: string) => {
    setEmailRows(prev => {
      const removed = prev.find(row => row.key === key);
      const rest = prev.filter(row => row.key !== key);
      if (rest.length === 0) return [blankRow(true)];
      if (removed?.is_primary) rest[0] = { ...rest[0], is_primary: true };
      return rest;
    });
  };

  const validate = () => {
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = 'Name is required';
    const seen = new Set<string>();
    for (const row of emailRows) {
      const value = row.email.trim().toLowerCase();
      if (!value) continue;
      if (!EMAIL_PATTERN.test(value)) errs[`email:${row.key}`] = 'Invalid email format';
      else if (seen.has(value)) errs[`email:${row.key}`] = 'Already listed';
      seen.add(value);
    }
    if (phone.trim() && !/^[+\d\s\-().]{7,20}$/.test(phone.trim())) {
      errs.phone = 'Invalid phone number';
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleAvatarCropped = async (blob: Blob) => {
    setAvatarBlob(blob);
    // If editing, upload immediately
    if (contact) {
      setAvatarUploading(true);
      try {
        if (isDemoMode) {
          const blobUrl = URL.createObjectURL(blob);
          setAvatarPreview(blobUrl);
          await updateContact(contact.id, { avatar_url: blobUrl });
          toast('success', 'Avatar updated');
        } else {
          // Fixed path per contact: upsert replaces previous file, no storage bloat
          const path = `contacts/${contact.id}.jpg`;
          const { error: uploadError } = await supabase.storage
            .from('avatars')
            .upload(path, blob, { upsert: true, contentType: 'image/jpeg' });
          if (uploadError) throw uploadError;

          const { data: { publicUrl } } = supabase.storage.from('avatars').getPublicUrl(path);
          const url = `${publicUrl}?t=${Date.now()}`;
          setAvatarPreview(url);
          await updateContact(contact.id, { avatar_url: url });
          toast('success', 'Avatar updated');
        }
      } catch {
        toast('error', 'Failed to upload avatar');
      } finally {
        setAvatarUploading(false);
      }
    } else {
      // Creating: show preview, upload after contact is created
      if (avatarPreview?.startsWith('blob:')) URL.revokeObjectURL(avatarPreview);
      const blobUrl = URL.createObjectURL(blob);
      setAvatarPreview(blobUrl);
    }
  };

  const handleRemoveAvatar = async () => {
    setAvatarPreview(undefined);
    setAvatarBlob(null);
    if (contact) {
      await updateContact(contact.id, { avatar_url: '' });
      toast('success', 'Avatar removed');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;

    setSaving(true);
    const drafts = toDrafts(emailRows);
    const primaryEmail = drafts.find(draft => draft.is_primary)?.email ?? '';
    const contactData = {
      name: name.trim(),
      phone: phone.trim(),
      company: company.trim(),
      notes: notes.trim(),
      color: contact?.color || siteConfig.colors.brand[500],
    };

    // Stays open when the addresses fail to save (the store says why), so nothing typed is lost.
    let emailsSaved = true;
    const existingId = contact?.id ?? createdId;
    if (existingId) {
      // contacts.email mirrors the primary address, so saveContactEmails owns it.
      // A retry on a just-created contact leaves its avatar (already uploaded) alone.
      await updateContact(existingId, contact ? { ...contactData, avatar_url: contact.avatar_url || '' } : contactData);
      if (emailsDirty || createdId) emailsSaved = await saveContactEmails(existingId, drafts);
    } else {
      const newContact = await addContact({ ...contactData, avatar_url: '', email: primaryEmail });
      if (!newContact) {
        setSaving(false);
        return;
      }
      // The database creates the primary row itself; extra addresses and labels need a save.
      if (drafts.length > 1 || drafts.some(draft => draft.label)) {
        emailsSaved = await saveContactEmails(newContact.id, drafts);
        if (!emailsSaved) setCreatedId(newContact.id);
      }
      // Upload avatar for newly created contact
      if (newContact && avatarBlob) {
        try {
          if (isDemoMode) {
            const blobUrl = URL.createObjectURL(avatarBlob);
            await updateContact(newContact.id, { avatar_url: blobUrl });
          } else {
            // Fixed path per contact: upsert replaces previous file, no storage bloat
            const path = `contacts/${newContact.id}.jpg`;
            const { error: uploadError } = await supabase.storage
              .from('avatars')
              .upload(path, avatarBlob, { upsert: true, contentType: 'image/jpeg' });
            if (!uploadError) {
              const { data: { publicUrl } } = supabase.storage.from('avatars').getPublicUrl(path);
              await updateContact(newContact.id, { avatar_url: `${publicUrl}?t=${Date.now()}` });
            }
          }
        } catch {
          // Non-critical: the contact was created, avatar upload failed
        }
      }
    }

    setSaving(false);
    if (emailsSaved) onClose();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={contact ? 'Edit Contact' : 'New Contact'}
      size="lg"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="flex justify-center">
          <AvatarUpload
            name={name || 'Contact'}
            currentSrc={avatarPreview}
            size="lg"
            onCropped={handleAvatarCropped}
            uploading={avatarUploading}
            onRemove={avatarPreview ? handleRemoveAvatar : undefined}
          />
        </div>

        <Input
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Contact name"
          required
          error={errors.name}
        />

        <fieldset className="space-y-2">
          <legend className={`${fieldLabelClass()} mb-1.5`}>Email addresses</legend>
          <ul className="space-y-2">
            {emailRows.map((row, index) => {
              const position = index + 1;
              return (
                <li key={row.key} className="flex flex-wrap sm:flex-nowrap items-start gap-2">
                  <TextInput
                    type="email"
                    aria-label={`Email address ${position}`}
                    value={row.email}
                    onChange={(value) => updateRow(row.key, { email: value })}
                    placeholder="name@company.com"
                    autoComplete="off"
                    error={errors[`email:${row.key}`]}
                    className="w-full sm:w-auto sm:flex-1 sm:min-w-0"
                  />
                  <TextInput
                    aria-label={`Label for email address ${position}`}
                    value={row.label}
                    onChange={(value) => updateRow(row.key, { label: value })}
                    placeholder="Label, e.g. Work"
                    maxLength={60}
                    className="flex-1 min-w-0 sm:flex-none sm:w-36"
                  />
                  <button
                    type="button"
                    aria-pressed={row.is_primary}
                    onClick={() => makePrimary(row.key)}
                    className={`h-9 w-[104px] px-2 flex-shrink-0 rounded-lg text-xs font-medium whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
                      row.is_primary
                        ? 'bg-brand-500/15 text-brand-300'
                        : 'text-zinc-400 hover:text-white hover:bg-white/[0.06]'
                    }`}
                  >
                    {row.is_primary ? 'Primary' : 'Make primary'}
                    <span className="sr-only">{`, email address ${position}`}</span>
                  </button>
                  <button
                    type="button"
                    aria-label="Remove email address"
                    onClick={() => removeRow(row.key)}
                    className="h-9 w-9 flex-shrink-0 inline-flex items-center justify-center rounded-lg text-zinc-400 hover:text-red-400 hover:bg-red-500/15 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                  >
                    <X size={16} aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
          <Button type="button" variant="ghost" size="sm" onClick={addRow} icon={<Plus size={14} aria-hidden="true" />}>
            Add email address
          </Button>
        </fieldset>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input
            label="Phone"
            value={phone}
            onChange={(e) => setPhone(formatPhone(e.target.value))}
            placeholder="(555) 555-5555"
            error={errors.phone}
          />
          <Input
            label="Company"
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            placeholder="Company name"
          />
        </div>

        <Textarea
          label="Notes"
          value={notes}
          onChange={setNotes}
          placeholder="Additional notes..."
          rows={3}
        />

        <div className="flex justify-end gap-3 pt-4">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? 'Saving...' : contact || createdId ? 'Save Changes' : 'Add Contact'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
