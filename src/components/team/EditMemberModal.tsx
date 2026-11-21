'use client';

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Check, Globe } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { createClient } from '@/lib/supabase/client';
import { hasPermission, isModuleEnabled } from '@/lib/access-control';
import { canChangeSignInEmail } from '@/lib/team/invite-rules';
import { AGENT_PROFILES, type AgentProfile } from '@/lib/mcp/profiles';
import type { TeamMember } from '@/lib/types';
import { AvatarUpload } from '@/components/ui/AvatarUpload';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/inputs/Select';
import { NumberInput } from '@/components/ui/inputs/NumberInput';
import Modal from '@/components/ui/Modal';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { toast } from '@/components/ui/Toast';

/**
 * Edit a team member: name, title, email, role (Owner only), account status
 * (team.manage, never yourself), agent settings and timezone. The Team page
 * and the member profile both open this one form, so the rules live once.
 */
export function EditMemberModal({ member, onClose }: { member: TeamMember | null; onClose: () => void }) {
  // Keyed by person, so the form always starts from the member it opened for.
  return member ? <EditMemberForm key={member.id} member={member} onClose={onClose} /> : null;
}

const isUploadedAvatar = (src: string | undefined | null): src is string =>
  !!src && (src.startsWith('http') || src.startsWith('blob:'));

function EditMemberForm({ member, onClose }: { member: TeamMember; onClose: () => void }) {
  const { updateTeamMember } = useApp();
  const { teamMemberId: currentTeamMemberId, access } = useAuth();
  const { isDemoMode } = useDemo();
  const supabase = createClient();

  const isOwner = access?.role === 'owner';
  // Same rule as the server: someone else's sign-in email is Owner only.
  const canEditEmail = canChangeSignInEmail(access?.role ?? '', member.id === currentTeamMemberId);
  const canManageTeam = hasPermission(access, 'team.manage');
  const canManageBilling = hasPermission(access, 'billing.manage');
  // The agent role stays with agents off; only its agent-only settings go.
  const isAgentsEnabled = isModuleEnabled(access, 'agents');

  const [avatar, setAvatar] = useState(member.avatar);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [showEmailConfirm, setShowEmailConfirm] = useState(false);
  const [name, setName] = useState(member.name);
  const [email, setEmail] = useState(member.email);
  const [emailError, setEmailError] = useState('');
  const [role, setRole] = useState<TeamMember['role']>(member.role);
  const [title, setTitle] = useState(member.title ?? '');
  const [memberStatus, setMemberStatus] = useState<'active' | 'suspended'>(member.status || 'active');
  const [billingMultiplier, setBillingMultiplier] = useState<number | ''>(
    member.role === 'agent' ? Number(member.billing_multiplier ?? 1) : '',
  );
  const [agentProfile, setAgentProfile] = useState<AgentProfile>(member.agent_profile ?? 'generic');
  const [memberTz, setMemberTz] = useState(member.timezone || 'UTC');
  const [tzSearch, setTzSearch] = useState('');
  const [tzOpen, setTzOpen] = useState(false);
  const [tzDropdownPos, setTzDropdownPos] = useState({
    top: 0,
    left: 0,
    width: 0,
    maxHeight: 240,
    openAbove: false,
  });
  const [formLoading, setFormLoading] = useState(false);
  const tzTriggerRef = useRef<HTMLDivElement>(null);
  const tzDropdownRef = useRef<HTMLDivElement>(null);

  const tzEntries = useMemo(() => {
    let zones: string[];
    try {
      zones = Intl.supportedValuesOf('timeZone');
    } catch {
      zones = ['UTC'];
    }
    const now = Date.now();
    return zones
      .map((tz) => {
        try {
          const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: tz,
            timeZoneName: 'shortOffset',
          }).formatToParts(now);
          const raw = parts.find((p) => p.type === 'timeZoneName')?.value || 'GMT';
          const label = raw === 'GMT' ? 'UTC+0' : raw.replace('GMT', 'UTC');
          const match = label.match(/UTC([+-])(\d+)(?::(\d+))?/);
          const offsetMin = match
            ? (match[1] === '+' ? 1 : -1) * (parseInt(match[2]) * 60 + parseInt(match[3] || '0'))
            : 0;
          return { id: tz, label, offsetMin };
        } catch {
          return { id: tz, label: 'UTC+0', offsetMin: 0 };
        }
      })
      .sort((a, b) => a.offsetMin - b.offsetMin || a.id.localeCompare(b.id));
  }, []);

  const filteredTz = useMemo(() => {
    const list = tzSearch
      ? tzEntries.filter(
          (e) =>
            e.id.toLowerCase().includes(tzSearch.toLowerCase()) ||
            e.label.toLowerCase().includes(tzSearch.toLowerCase()),
        )
      : tzEntries;
    const groups: { label: string; items: typeof list }[] = [];
    let cur = '';
    for (const e of list) {
      if (e.label !== cur) {
        cur = e.label;
        groups.push({ label: cur, items: [] });
      }
      groups[groups.length - 1].items.push(e);
    }
    return groups;
  }, [tzEntries, tzSearch]);

  const updateTimezoneDropdownPosition = useCallback(() => {
    if (!tzTriggerRef.current) return;
    const rect = tzTriggerRef.current.getBoundingClientRect();
    const desiredHeight = 288;
    const spaceBelow = window.innerHeight - rect.bottom - 16;
    const spaceAbove = rect.top - 16;
    const openAbove = spaceBelow < desiredHeight && spaceAbove > spaceBelow;
    setTzDropdownPos({
      top: openAbove ? rect.top - 4 : rect.bottom + 4,
      left: rect.left,
      width: rect.width,
      maxHeight: Math.max(160, Math.min(desiredHeight, openAbove ? spaceAbove : spaceBelow)),
      openAbove,
    });
  }, []);

  useEffect(() => {
    if (!tzOpen) return;
    updateTimezoneDropdownPosition();
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!tzTriggerRef.current?.contains(target) && !tzDropdownRef.current?.contains(target)) {
        setTzOpen(false);
        setTzSearch('');
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('resize', updateTimezoneDropdownPosition);
    window.addEventListener('scroll', updateTimezoneDropdownPosition, true);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('resize', updateTimezoneDropdownPosition);
      window.removeEventListener('scroll', updateTimezoneDropdownPosition, true);
    };
  }, [tzOpen, updateTimezoneDropdownPosition]);

  const handleAvatarCropped = async (blob: Blob) => {
    setAvatarUploading(true);
    try {
      if (isDemoMode) {
        const blobUrl = URL.createObjectURL(blob);
        updateTeamMember(member.id, { avatar: blobUrl });
        setAvatar(blobUrl);
        toast('success', 'Avatar updated');
      } else {
        // Fixed path per member ; upsert replaces previous file, no storage bloat
        const path = `team/${member.id}.jpg`;
        const { error: uploadError } = await supabase.storage
          .from('avatars')
          .upload(path, blob, { upsert: true, contentType: 'image/jpeg' });
        if (uploadError) throw uploadError;

        const {
          data: { publicUrl },
        } = supabase.storage.from('avatars').getPublicUrl(path);
        const url = `${publicUrl}?t=${Date.now()}`;
        updateTeamMember(member.id, { avatar: url });
        setAvatar(url);
        toast('success', 'Avatar updated');
      }
    } catch {
      toast('error', 'Failed to upload avatar');
    } finally {
      setAvatarUploading(false);
    }
  };

  // The multiplier only travels when it is editable here (agent member,
  // billing permission) and valid; the API enforces the same rules again.
  const multiplierUpdate = (): { billing_multiplier?: number } => {
    if (role !== 'agent' || !canManageBilling || billingMultiplier === '') return {};
    if (!Number.isFinite(billingMultiplier) || billingMultiplier < 0.1 || billingMultiplier > 10)
      return {};
    return { billing_multiplier: billingMultiplier };
  };

  // Sent only when it changed, by the Owner, for an agent; the API checks
  // the same and only the Owner may change it.
  const profileUpdate = (): { agent_profile?: AgentProfile } => {
    if (role !== 'agent' || !isOwner || !isAgentsEnabled) return {};
    if (agentProfile === (member.agent_profile ?? 'generic')) return {};
    return { agent_profile: agentProfile };
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    const emailChanged = email.trim().toLowerCase() !== member.email.toLowerCase();

    if (emailChanged) {
      setShowEmailConfirm(true);
      return;
    }

    onClose();
    const saved = await updateTeamMember(member.id, {
      name: name.trim(),
      title: title.trim() || null,
      role,
      status: memberStatus,
      timezone: memberTz,
      ...multiplierUpdate(),
      ...profileUpdate(),
    });
    if (saved) toast('success', 'Team member updated');
  };

  const handleConfirmEmailChange = async () => {
    setShowEmailConfirm(false);
    setEmailError('');
    setFormLoading(true);

    try {
      const res = await fetch('/api/team-members/update-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          team_member_id: member.id,
          new_email: email.trim().toLowerCase(),
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        setEmailError(data.error || 'Failed to update email');
        return;
      }

      onClose();
      const saved = await updateTeamMember(member.id, {
        name: name.trim(),
        role,
        status: memberStatus,
        timezone: memberTz,
        email: email.trim().toLowerCase(),
        ...multiplierUpdate(),
        ...profileUpdate(),
      });
      if (saved) toast('success', 'Team member updated');
    } catch {
      toast('error', 'Failed to update email');
    } finally {
      setFormLoading(false);
    }
  };

  return (
    <>
      <Modal isOpen onClose={onClose} title="Edit Team Member" size="md">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="flex justify-center">
            <AvatarUpload
              name={member.name}
              currentSrc={isUploadedAvatar(avatar) ? avatar : undefined}
              size="lg"
              onCropped={handleAvatarCropped}
              uploading={avatarUploading}
              onRemove={
                isUploadedAvatar(avatar)
                  ? () => {
                      updateTeamMember(member.id, { avatar: '' });
                      setAvatar('');
                      toast('success', 'Avatar removed');
                    }
                  : undefined
              }
            />
          </div>

          <Input
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Enter full name"
            required
          />

          <Input
            label="Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={'e.g. "Developer", "Auditor"'}
          />

          <Input
            label="Email"
            type="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setEmailError('');
            }}
            placeholder="name@example.com"
            error={emailError}
            disabled={formLoading || !canEditEmail}
          />
          {!canEditEmail && (
            <p className="-mt-2 text-xs text-zinc-400">Only an Owner can change this person&apos;s sign-in email.</p>
          )}

          <Select
            label="Role"
            value={role}
            onChange={(value) => setRole(value as TeamMember['role'])}
            disabled={!isOwner || member.id === currentTeamMemberId}
            options={[
              { value: 'owner', label: 'Owner' },
              { value: 'admin', label: 'Admin' },
              { value: 'member', label: 'Member' },
              { value: 'guest', label: 'Guest' },
              { value: 'agent', label: 'Agent' },
            ]}
          />

          {canManageTeam && member.id !== currentTeamMemberId && (
            <Select
              label="Account status"
              value={memberStatus}
              onChange={(value) => setMemberStatus(value as 'active' | 'suspended')}
              options={[
                { value: 'active', label: 'Active' },
                { value: 'suspended', label: 'Suspended' },
              ]}
            />
          )}

          {role === 'agent' && isOwner && isAgentsEnabled && (
            <Select
              label="Agent profile"
              description="Which MCP tools this agent sees. Its key and permissions still decide what each tool may do."
              value={agentProfile}
              onChange={(value) => setAgentProfile(value as AgentProfile)}
              options={AGENT_PROFILES.map((profile) => ({
                value: profile.value,
                label: profile.label,
                detail: profile.description,
              }))}
            />
          )}

          {role === 'agent' && canManageBilling && (
            <NumberInput
              label="Billing multiplier"
              description="Scales the agent's worked time into the billed session when a timer stops (1.0 bills actual time). Applies to future sessions only; each session snapshots the value at start."
              value={billingMultiplier}
              onChange={setBillingMultiplier}
              min={0.1}
              max={10}
              step={0.1}
            />
          )}

          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-1.5">Timezone</label>
            <div className="relative" ref={tzTriggerRef}>
              <button
                type="button"
                aria-expanded={tzOpen}
                aria-haspopup="dialog"
                onClick={() => {
                  if (!tzOpen) updateTimezoneDropdownPosition();
                  setTzOpen(!tzOpen);
                }}
                className="w-full flex items-center justify-between px-3 py-2 text-sm bg-surface-raised border border-white/[0.08] rounded-lg hover:border-white/[0.12] transition-colors text-left"
              >
                <span className="flex items-center gap-2 text-white">
                  <Globe size={14} className="text-zinc-500" />
                  {memberTz.replace(/_/g, ' ')}
                </span>
                <span className="text-zinc-500 text-xs font-mono">
                  {tzEntries.find((e) => e.id === memberTz)?.label || 'UTC+0'}
                </span>
              </button>
              {tzOpen &&
                createPortal(
                  <div
                    ref={tzDropdownRef}
                    role="dialog"
                    aria-label="Choose timezone"
                    className="fixed z-[9999] flex flex-col overflow-hidden bg-surface-raised border border-white/[0.08] rounded-lg shadow-lg"
                    style={{
                      top: tzDropdownPos.top,
                      left: tzDropdownPos.left,
                      width: tzDropdownPos.width,
                      maxHeight: tzDropdownPos.maxHeight,
                      transform: tzDropdownPos.openAbove ? 'translateY(-100%)' : undefined,
                    }}
                  >
                    <div className="p-2 border-b border-white/[0.06]">
                      <Input
                        type="text"
                        value={tzSearch}
                        onChange={(e) => setTzSearch(e.target.value)}
                        placeholder="Search timezones..."
                        className="bg-white/[0.03] py-1.5 rounded-md"
                        autoFocus
                      />
                    </div>
                    <div className="min-h-0 flex-1 overflow-y-auto">
                      {filteredTz.length === 0 ? (
                        <p className="px-3 py-2 text-sm text-zinc-500">No matching timezones</p>
                      ) : (
                        filteredTz.map((group) => (
                          <div key={group.label}>
                            <div className="sticky top-0 bg-white/[0.03] px-3 py-1 text-[11px] font-semibold text-zinc-500 uppercase tracking-wide font-mono border-b border-white/[0.06]">
                              {group.label}
                            </div>
                            {group.items.map((entry) => (
                              <button
                                key={entry.id}
                                type="button"
                                onClick={() => {
                                  setMemberTz(entry.id);
                                  setTzOpen(false);
                                  setTzSearch('');
                                }}
                                className={`w-full text-left px-3 py-1.5 text-sm hover:bg-white/[0.03] transition-colors flex items-center justify-between ${
                                  entry.id === memberTz
                                    ? 'text-brand-300 font-medium bg-brand-500/15'
                                    : 'text-zinc-300'
                                }`}
                              >
                                <span>{entry.id.replace(/_/g, ' ')}</span>
                                {entry.id === memberTz && (
                                  <Check size={14} className="text-brand-300 flex-shrink-0" />
                                )}
                              </button>
                            ))}
                          </div>
                        ))
                      )}
                    </div>
                  </div>,
                  document.body,
                )}
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-4">
            <Button type="button" variant="ghost" onClick={onClose} disabled={formLoading}>
              Cancel
            </Button>
            <Button type="submit" disabled={formLoading}>
              {formLoading ? 'Saving...' : 'Save changes'}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Outside the modal: a fixed dialog inside its transformed panel would be trapped there. */}
      <ConfirmDialog
        isOpen={showEmailConfirm}
        onClose={() => setShowEmailConfirm(false)}
        onConfirm={handleConfirmEmailChange}
        title="Change Email Address"
        message={`This will change the login email for ${member.name || 'this member'} from "${member.email}" to "${email.trim().toLowerCase()}". They'll need to use the new email to sign in.`}
        confirmLabel="Update Email"
        variant="default"
        doubleConfirm={false}
      />
    </>
  );
}
