'use client';

import { useState, useEffect } from 'react';
import { Contact } from '@/lib/types';
import { useApp } from '@/lib/store';
import { useDemo } from '@/lib/demo-context';
import { createClient } from '@/lib/supabase/client';
import Modal from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { AvatarUpload } from '@/components/ui/AvatarUpload';
import { toast } from '@/components/ui/Toast';
import { siteConfig } from '@/site-config';


interface ContactFormProps {
  isOpen: boolean;
  onClose: () => void;
  contact?: Contact | null;
}

export function ContactForm({ isOpen, onClose, contact }: ContactFormProps) {
  const { addContact, updateContact } = useApp();
  const { isDemoMode } = useDemo();
  const supabase = createClient();

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [company, setCompany] = useState('');
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [avatarBlob, setAvatarBlob] = useState<Blob | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | undefined>(undefined);
  const [avatarUploading, setAvatarUploading] = useState(false);

  const isDirty = name !== (contact?.name || '') || email !== (contact?.email || '') ||
    phone !== (contact?.phone || '') || company !== (contact?.company || '') ||
    notes !== (contact?.notes || '');

  useEffect(() => {
    if (!isOpen || !isDirty) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isOpen, isDirty]);

  useEffect(() => {
    if (contact) {
      setName(contact.name);
      setEmail(contact.email);
      setPhone(contact.phone);
      setCompany(contact.company);
      setNotes(contact.notes);
      setAvatarPreview(contact.avatar_url || undefined);
    } else {
      setName('');
      setEmail('');
      setPhone('');
      setCompany('');
      setNotes('');
      setAvatarPreview(undefined);
    }
    setAvatarBlob(null);
  }, [contact?.id, isOpen]);

  const validate = () => {
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = 'Name is required';
    if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      errs.email = 'Invalid email format';
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
          // Fixed path per contact — upsert replaces previous file, no storage bloat
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
    const contactData = {
      name: name.trim(),
      email: email.trim(),
      phone: phone.trim(),
      company: company.trim(),
      notes: notes.trim(),
      color: contact?.color || siteConfig.colors.brand[500],
      avatar_url: contact?.avatar_url || '',
    };

    if (contact) {
      await updateContact(contact.id, contactData);
    } else {
      const newContact = await addContact(contactData);
      // Upload avatar for newly created contact
      if (newContact && avatarBlob) {
        try {
          if (isDemoMode) {
            const blobUrl = URL.createObjectURL(avatarBlob);
            await updateContact(newContact.id, { avatar_url: blobUrl });
          } else {
            // Fixed path per contact — upsert replaces previous file, no storage bloat
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
          // Non-critical — contact was created, avatar upload failed
        }
      }
    }

    setSaving(false);
    onClose();
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

        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-zinc-700">Notes</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Additional notes..."
            rows={3}
            className="w-full px-3 py-2 text-sm bg-white border border-zinc-200 rounded-lg outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 transition-all resize-none"
          />
        </div>

        <div className="flex justify-end gap-3 pt-4">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? 'Saving...' : contact ? 'Save Changes' : 'Add Contact'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
