'use client';

import { useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { Select } from '@/components/ui/inputs/Select';
import { OutcomeLine } from '@/components/settings/workspace/OutcomeLine';
import { CopyLinkField } from '@/components/team/CopyLinkField';
import { RoleChip } from '@/components/team/member-chips';
import { deliveryLine, sendInvite, type InviteDelivery, type InviteRole } from '@/components/team/invites';
import { StepFrame, type WizardStepProps } from '../StepFrame';

interface Row {
  key: number;
  name: string;
  email: string;
  role: InviteRole;
  state: 'draft' | 'sending' | 'sent';
  error?: { field?: 'name' | 'email' | 'role'; message: string };
  invite?: InviteDelivery | null;
}

const ROLE_OPTIONS = [
  { value: 'member', label: 'Member', detail: 'Their assigned projects and tasks.' },
  { value: 'admin', label: 'Admin', detail: 'The team and every project, not workspace settings.' },
  { value: 'guest', label: 'Guest', detail: 'Shared projects only, to read and comment.' },
  { value: 'owner', label: 'Owner', detail: 'Everything, including billing and settings.' },
];

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Step 5: invite the team. A short list of name, email and role; Continue
 * sends every filled row. Each invite says what happened in one line, and
 * when email is not set up it shows the link to copy, so the step waits
 * for the Owner to pass the links on before moving ahead.
 */
export function TeamStep({ onNext, onSkip, onBack }: WizardStepProps) {
  const { team, upsertLocalTeamMember } = useApp();
  const { teamMemberId } = useAuth();
  const nextKey = useRef(1);
  const [rows, setRows] = useState<Row[]>([{ key: 0, name: '', email: '', role: 'member', state: 'draft' }]);
  const [busy, setBusy] = useState(false);

  const already = team.filter((member) => member.id !== teamMemberId && member.role !== 'agent');
  const sentEmails = new Set(rows.filter((row) => row.state === 'sent').map((row) => row.email.trim().toLowerCase()));
  const earlier = already.filter((member) => !sentEmails.has((member.email ?? '').toLowerCase()));

  const update = (key: number, patch: Partial<Row>) => setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  const addRow = () => setRows((current) => [...current, { key: nextKey.current++, name: '', email: '', role: 'member', state: 'draft' }]);
  const removeRow = (key: number) => setRows((current) => {
    const left = current.filter((row) => row.key !== key);
    return left.some((row) => row.state === 'draft') ? left : [...left, { key: nextKey.current++, name: '', email: '', role: 'member', state: 'draft' }];
  });

  const filled = (row: Row) => row.state === 'draft' && (row.name.trim() !== '' || row.email.trim() !== '');
  const pendingLinks = rows.some((row) => row.state === 'sent' && row.invite && !row.invite.emailed && row.invite.link);

  const submit = async () => {
    const drafts = rows.filter(filled);
    if (drafts.length === 0) {
      onNext();
      return;
    }
    // Check every filled row first, so all problems show at once.
    let valid = true;
    for (const row of drafts) {
      const error = !row.name.trim()
        ? { field: 'name' as const, message: 'Add their name.' }
        : !EMAIL.test(row.email.trim())
          ? { field: 'email' as const, message: 'Check the email address.' }
          : undefined;
      update(row.key, { error });
      if (error) valid = false;
    }
    if (!valid) return;

    setBusy(true);
    drafts.forEach((row) => update(row.key, { state: 'sending', error: undefined }));
    const results = await Promise.all(drafts.map(async (row) => ({ row, result: await sendInvite(row) })));
    setBusy(false);

    let needsAttention = false;
    for (const { row, result } of results) {
      if (result.ok) {
        upsertLocalTeamMember(result.member);
        update(row.key, { state: 'sent', invite: result.invite });
        if (!result.invite?.emailed) needsAttention = true;
      } else {
        update(row.key, { state: 'draft', error: { field: result.field, message: result.message } });
        needsAttention = true;
      }
    }
    // Everyone emailed: nothing left to do here.
    if (!needsAttention) onNext();
    else setRows((current) => current.some((row) => row.state === 'draft') ? current : [...current, { key: nextKey.current++, name: '', email: '', role: 'member', state: 'draft' }]);
  };

  const draftsFilled = rows.some(filled);
  const sentRows = rows.filter((row) => row.state === 'sent');
  const draftRows = rows.filter((row) => row.state !== 'sent');

  return (
    <StepFrame
      title="Invite your team"
      description="Each person gets a link to choose their own password. You can invite more people any time from the Team page."
      onSubmit={() => { void submit(); }}
      onBack={onBack}
      onSkip={sentRows.length ? undefined : onSkip}
      busy={busy}
      busyLabel="Sending invites"
      primaryLabel={draftsFilled ? 'Send invites' : 'Continue'}
    >
      {earlier.length > 0 && (
        <div className="mb-8">
          <h2 className="text-xs font-medium uppercase tracking-wide text-zinc-400">Already on your team</h2>
          <ul className="mt-3 flex flex-wrap gap-2">
            {earlier.slice(0, 12).map((member) => (
              <li key={member.id} className="inline-flex items-center gap-2 rounded-full bg-white/[0.04] py-1 pl-1 pr-3 text-xs text-zinc-300">
                <Avatar name={member.name} src={member.avatar || undefined} size="xs" />
                {member.name}
              </li>
            ))}
            {earlier.length > 12 && <li className="px-2 py-1 text-xs text-zinc-400">and {earlier.length - 12} more</li>}
          </ul>
        </div>
      )}

      {sentRows.length > 0 && (
        <div className="mb-8">
          <h2 className="text-xs font-medium uppercase tracking-wide text-zinc-400">Invited</h2>
          <ul className="mt-3 divide-y divide-white/[0.06]">
            {sentRows.map((row) => (
              <li key={row.key} className="py-4 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <Avatar name={row.name} size="sm" />
                  <span className="text-sm font-medium text-zinc-100">{row.name}</span>
                  <span className="min-w-0 truncate text-xs text-zinc-400">{row.email}</span>
                  <RoleChip role={row.role} />
                </div>
                {row.invite ? (
                  <>
                    <OutcomeLine outcome={{ tone: row.invite.emailStatus === 'failed' ? 'error' : 'done', text: deliveryLine(row.name.split(' ')[0], row.invite) }} className="mt-2.5" />
                    {row.invite.link && !row.invite.emailed && <CopyLinkField link={row.invite.link} label={`Invite link for ${row.name}`} className="mt-2" />}
                  </>
                ) : null}
              </li>
            ))}
          </ul>
          {pendingLinks && (
            <p className="mt-4 text-xs text-zinc-400">Copy each link and send it the way you usually would. Links also stay on the Team page under Copy invite link.</p>
          )}
        </div>
      )}

      <div>
        {sentRows.length > 0 && <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-zinc-400">Invite someone else</h2>}
        <ul className="space-y-4">
          {draftRows.map((row, index) => (
            <li key={row.key} className="grid grid-cols-1 gap-3 rounded-xl bg-white/[0.02] p-3 ring-1 ring-inset ring-white/[0.06] sm:grid-cols-[1fr_1.3fr_9rem_auto] sm:items-start sm:bg-transparent sm:p-0 sm:ring-0">
              <TextInput
                label={index === 0 ? 'Name' : undefined}
                aria-label={index === 0 ? undefined : 'Name'}
                value={row.name}
                onChange={(name) => update(row.key, { name, error: row.error?.field === 'name' ? undefined : row.error })}
                placeholder="Full name"
                autoComplete="off"
                disabled={row.state === 'sending'}
                error={row.error?.field === 'name' ? row.error.message : undefined}
              />
              <TextInput
                label={index === 0 ? 'Email' : undefined}
                aria-label={index === 0 ? undefined : 'Email'}
                type="email"
                value={row.email}
                onChange={(email) => update(row.key, { email, error: row.error?.field === 'email' ? undefined : row.error })}
                placeholder="name@company.com"
                autoComplete="off"
                disabled={row.state === 'sending'}
                error={row.error?.field === 'email' ? row.error.message : undefined}
              />
              <Select
                label={index === 0 ? 'Role' : undefined}
                ariaLabel="Role"
                value={row.role}
                onChange={(role) => update(row.key, { role: role as InviteRole })}
                options={ROLE_OPTIONS}
                disabled={row.state === 'sending'}
              />
              <div className={index === 0 ? 'sm:pt-[26px]' : ''}>
                <Button
                  type="button"
                  variant="ghost"
                  aria-label={`Remove ${row.name.trim() || 'this person'}`}
                  onClick={() => removeRow(row.key)}
                  disabled={row.state === 'sending' || (draftRows.length === 1 && !filled(row))}
                  className="!px-2.5"
                >
                  <X size={15} aria-hidden="true" />
                  <span className="sm:hidden">Remove</span>
                </Button>
              </div>
              {row.error && !row.error.field && (
                <div className="sm:col-span-4"><OutcomeLine outcome={{ tone: 'error', text: row.error.message }} /></div>
              )}
            </li>
          ))}
        </ul>
        <Button type="button" variant="ghost" size="sm" className="mt-3 -ml-2.5" onClick={addRow} disabled={busy} icon={<Plus size={13} aria-hidden="true" />}>
          Add another person
        </Button>
      </div>
    </StepFrame>
  );
}
