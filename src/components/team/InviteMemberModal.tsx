'use client';

import { useState } from 'react';
import Modal from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import { PasswordInput } from '@/components/ui/inputs/PasswordInput';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { TeamMember } from '@/lib/types';

interface InviteMemberModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (member: TeamMember) => void;
  canAssignOwner?: boolean;
}

export default function InviteMemberModal({ isOpen, onClose, onSuccess, canAssignOwner = false }: InviteMemberModalProps) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<TeamMember['role']>('member');
  const [generatedPassword, setGeneratedPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const reset = () => {
    setName('');
    setEmail('');
    setPassword('');
    setRole('member');
    setGeneratedPassword(false);
    setErrors({});
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const validate = (): boolean => {
    const e: Record<string, string> = {};
    if (!name.trim()) e.name = 'Name is required';
    if (!email.trim()) e.email = 'Email is required';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) e.email = 'Invalid email address';
    if (!password) e.password = 'Password is required';
    else if (password.length < 6) e.password = 'Must be at least 6 characters';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;

    setLoading(true);
    setErrors({});

    try {
      const res = await fetch('/api/team-members/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), email: email.trim().toLowerCase(), password, role }),
      });

      const data = await res.json();

      if (!res.ok) {
        if (res.status === 409) {
          setErrors({ email: 'A user with this email already exists' });
        } else if (res.status === 422) {
          if (data.details) {
            const fieldErrors: Record<string, string> = {};
            for (const [key, msgs] of Object.entries(data.details)) {
              fieldErrors[key] = Array.isArray(msgs) ? msgs[0] : String(msgs);
            }
            setErrors(fieldErrors);
          } else {
            setErrors({ password: data.error || 'Validation failed' });
          }
        } else {
          setErrors({ form: data.error || 'Something went wrong' });
        }
        return;
      }

      onSuccess(data as TeamMember);
      handleClose();
    } catch {
      setErrors({ form: 'Network error — please try again' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Invite Team Member" size="md">
      <form onSubmit={handleSubmit} className="space-y-4">
        {errors.form && (
          <div className="p-3 rounded-lg bg-red-500/15 border border-red-500/30 text-sm text-red-300">
            {errors.form}
          </div>
        )}

        <Input
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Full name"
          error={errors.name}
          disabled={loading}
        />

        <Input
          label="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="name@example.com"
          error={errors.email}
          disabled={loading}
        />

        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-sm font-medium text-zinc-300">Password</label>
            <button
              type="button"
              onClick={() => {
                const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%&*';
                let pw = '';
                const array = new Uint32Array(16);
                crypto.getRandomValues(array);
                for (let i = 0; i < 16; i++) pw += chars[array[i] % chars.length];
                setPassword(pw);
                setGeneratedPassword(true);
              }}
              disabled={loading}
              className="text-xs text-brand-300 hover:text-brand-300 font-medium disabled:opacity-50"
            >
              Generate
            </button>
          </div>
          {generatedPassword ? (
            <TextInput
              value={password}
              onChange={(v) => { setPassword(v); if (!v) setGeneratedPassword(false); }}
              placeholder="Min 6 characters"
              disabled={loading}
              error={errors.password}
            />
          ) : (
            <PasswordInput
              value={password}
              onChange={setPassword}
              placeholder="Min 6 characters"
              disabled={loading}
              error={errors.password}
            />
          )}
        </div>

        <Select
          label="Role"
          value={role}
          onChange={(value) => setRole(value as TeamMember['role'])}
          options={[
            ...(canAssignOwner ? [{ value: 'owner', label: 'Owner' }] : []),
            { value: 'admin', label: 'Admin' },
            { value: 'member', label: 'Member' },
            { value: 'guest', label: 'Guest' },
            { value: 'agent', label: 'Agent' },
          ]}
        />

        {role === 'owner' && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/15 px-3 py-2 text-xs leading-5 text-amber-300">
            Owners have unrestricted access to billing, credentials, permissions, API scopes, and team management.
          </div>
        )}

        <div className="flex justify-end gap-3 pt-4">
          <Button type="button" variant="ghost" onClick={handleClose} disabled={loading}>
            Cancel
          </Button>
          <Button type="submit" disabled={loading}>
            {loading ? 'Creating...' : 'Create & Invite'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
