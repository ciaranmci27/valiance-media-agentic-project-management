'use client';

import { useState } from 'react';
import Modal from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import { Eye, EyeOff } from 'lucide-react';
import { TeamMember } from '@/lib/types';

interface InviteMemberModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (member: TeamMember) => void;
  showAgentRole?: boolean;
}

export default function InviteMemberModal({ isOpen, onClose, onSuccess, showAgentRole }: InviteMemberModalProps) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<TeamMember['role']>('member');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const reset = () => {
    setName('');
    setEmail('');
    setPassword('');
    setRole('member');
    setShowPassword(false);
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
          <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
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
            <label className="text-sm font-medium text-zinc-700">Password</label>
            <button
              type="button"
              onClick={() => {
                const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%&*';
                let pw = '';
                const array = new Uint32Array(16);
                crypto.getRandomValues(array);
                for (let i = 0; i < 16; i++) pw += chars[array[i] % chars.length];
                setPassword(pw);
                setShowPassword(true);
              }}
              disabled={loading}
              className="text-xs text-indigo-600 hover:text-indigo-700 font-medium disabled:opacity-50"
            >
              Generate
            </button>
          </div>
          <div className="relative">
            <input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Min 6 characters"
              disabled={loading}
              className={`w-full px-3 py-2 pr-10 text-sm border rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-offset-0 ${
                errors.password
                  ? 'border-red-300 focus:ring-red-500/20 focus:border-red-500'
                  : 'border-zinc-300 focus:ring-indigo-500/20 focus:border-indigo-500'
              } disabled:opacity-50`}
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600"
              tabIndex={-1}
            >
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
          {errors.password && <p className="mt-1 text-xs text-red-600">{errors.password}</p>}
        </div>

        <Select
          label="Role"
          value={role}
          onChange={(value) => setRole(value as TeamMember['role'])}
          options={[
            { value: 'admin', label: 'Admin' },
            { value: 'member', label: 'Member' },
            { value: 'guest', label: 'Guest' },
            ...(showAgentRole ? [{ value: 'agent', label: 'Agent' }] : []),
          ]}
        />

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
