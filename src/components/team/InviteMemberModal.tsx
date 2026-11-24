'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Loader2 } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/inputs/Select';
import { Button } from '@/components/ui/Button';
import { OutcomeLine } from '@/components/settings/workspace/OutcomeLine';
import { CopyLinkField } from '@/components/team/CopyLinkField';
import { deliveryLine, sendInvite, type InviteDelivery, type InviteRole } from '@/components/team/invites';
import { TeamMember } from '@/lib/types';

interface InviteMemberModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (member: TeamMember) => void;
  /** Owners only: may invite an Owner or an Admin. */
  canAssignOwner?: boolean;
}

/**
 * Invite someone: name, email and role. They get an email with a link to
 * choose their own password (or, with email not set up, the inviter copies
 * the link and sends it). Nobody types a password for someone else.
 */
export default function InviteMemberModal({
  isOpen,
  onClose,
  onSuccess,
  canAssignOwner = false,
}: InviteMemberModalProps) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<InviteRole>('member');
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [sent, setSent] = useState<{ name: string; invite: InviteDelivery | null } | null>(null);

  const reset = () => {
    setName('');
    setEmail('');
    setRole('member');
    setErrors({});
    setSent(null);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const validate = (): boolean => {
    const e: Record<string, string> = {};
    if (!name.trim()) e.name = 'Name is required';
    if (!email.trim()) e.email = 'Email is required';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) e.email = 'Invalid email address';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading || !validate()) return;
    setLoading(true);
    const result = await sendInvite({ name, email, role });
    setLoading(false);
    if (!result.ok) {
      setErrors({ [result.field ?? 'form']: result.message });
      return;
    }
    onSuccess(result.member);
    setSent({ name: result.member.name, invite: result.invite });
  };

  const firstName = (sent?.name ?? '').split(' ')[0] || sent?.name || '';

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title={sent ? `${sent.name} is invited` : 'Invite to the team'} size="md">
      {sent ? (
        <div className="space-y-4">
          {sent.invite ? (
            <>
              <OutcomeLine outcome={{ tone: sent.invite.emailStatus === 'failed' ? 'error' : 'done', text: deliveryLine(firstName, sent.invite) }} />
              {sent.invite.link && (
                <div>
                  <p className="mb-1.5 text-xs text-zinc-400">
                    {sent.invite.emailed ? 'The same link, if you want to send it yourself:' : `They open it, choose a password and are signed in.`}
                  </p>
                  <CopyLinkField link={sent.invite.link} />
                </div>
              )}
            </>
          ) : (
            <OutcomeLine outcome={{ tone: 'done', text: `${sent.name} can sign in now.` }} />
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={reset}>Invite another</Button>
            <Button onClick={handleClose}>Done</Button>
          </div>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          {errors.form && <OutcomeLine outcome={{ tone: 'error', text: errors.form }} />}

          <Input
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Full name"
            error={errors.name}
            disabled={loading}
            autoFocus
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

          <Select
            label="Role"
            value={role}
            onChange={(value) => setRole(value as InviteRole)}
            options={[
              ...(canAssignOwner ? [{ value: 'owner', label: 'Owner' }, { value: 'admin', label: 'Admin' }] : []),
              { value: 'member', label: 'Member' },
              { value: 'guest', label: 'Guest' },
            ]}
          />

          {role === 'owner' && (
            <p className="rounded-lg bg-amber-500/[0.12] px-3 py-2 text-xs leading-5 text-amber-200">
              Owners have unrestricted access to billing, credentials, permissions, API scopes and team management.
            </p>
          )}

          <p className="text-xs text-zinc-400">
            They get an email with a link to choose their own password. If email is not set up, you get the link to send yourself.
          </p>

          {/* Agents are hired, not invited: their own guided setup (template, projects, powers, a key). */}
          {canAssignOwner && (
            <p className="text-xs text-zinc-400">
              Adding an AI agent? <Link href="/agent/new" className="font-medium text-brand-300 hover:text-brand-200" onClick={handleClose}>Hire one</Link> instead.
            </p>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="ghost" onClick={handleClose} disabled={loading}>
              Cancel
            </Button>
            <Button type="submit" disabled={loading} icon={loading ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : undefined}>
              {loading ? 'Sending invite' : 'Send invite'}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
