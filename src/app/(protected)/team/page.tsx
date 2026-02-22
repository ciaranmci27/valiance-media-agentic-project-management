'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { useApp, defaultFilters } from '@/lib/store';
import { Header } from '@/components/layout/Header';
import { Avatar } from '@/components/ui/Avatar';
import { AvatarUpload } from '@/components/ui/AvatarUpload';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import Modal from '@/components/ui/Modal';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { MoreVertical, Edit, Shield, User, UserMinus, Bot, UserPlus, Globe, Check } from 'lucide-react';
import { TeamMember } from '@/lib/types';
import { toast } from '@/components/ui/Toast';
import { createClient } from '@/lib/supabase/client';
import { useDemo } from '@/lib/demo-context';
import { useAuth } from '@/lib/auth-context';
import InviteMemberModal from '@/components/team/InviteMemberModal';

export default function TeamPage() {
  const { team, updateTeamMember, upsertLocalTeamMember, tasks, filters, setFilters, getTeamMember } = useApp();
  const { teamMemberId: currentTeamMemberId } = useAuth();
  const { isDemoMode } = useDemo();
  const supabase = createClient();
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isInviteOpen, setIsInviteOpen] = useState(false);
  const [editingMember, setEditingMember] = useState<TeamMember | null>(null);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [showEmailConfirm, setShowEmailConfirm] = useState(false);

  const currentMember = getTeamMember(currentTeamMemberId || '');
  const isAdmin = currentMember?.role === 'admin';

  useEffect(() => { setFilters(defaultFilters); }, []);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState('');
  const [role, setRole] = useState<TeamMember['role']>('member');
  const [memberTz, setMemberTz] = useState('UTC');
  const [tzSearch, setTzSearch] = useState('');
  const [tzOpen, setTzOpen] = useState(false);
  const [formLoading, setFormLoading] = useState(false);
  const tzDropdownRef = useRef<HTMLDivElement>(null);

  const tzEntries = useMemo(() => {
    let zones: string[];
    try { zones = Intl.supportedValuesOf('timeZone'); } catch { zones = ['UTC']; }
    const now = Date.now();
    return zones.map(tz => {
      try {
        const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(now);
        const raw = parts.find(p => p.type === 'timeZoneName')?.value || 'GMT';
        const label = raw === 'GMT' ? 'UTC+0' : raw.replace('GMT', 'UTC');
        const match = label.match(/UTC([+-])(\d+)(?::(\d+))?/);
        const offsetMin = match ? (match[1] === '+' ? 1 : -1) * (parseInt(match[2]) * 60 + parseInt(match[3] || '0')) : 0;
        return { id: tz, label, offsetMin };
      } catch { return { id: tz, label: 'UTC+0', offsetMin: 0 }; }
    }).sort((a, b) => a.offsetMin - b.offsetMin || a.id.localeCompare(b.id));
  }, []);

  const filteredTz = useMemo(() => {
    const list = tzSearch
      ? tzEntries.filter(e => e.id.toLowerCase().includes(tzSearch.toLowerCase()) || e.label.toLowerCase().includes(tzSearch.toLowerCase()))
      : tzEntries;
    const groups: { label: string; items: typeof list }[] = [];
    let cur = '';
    for (const e of list) { if (e.label !== cur) { cur = e.label; groups.push({ label: cur, items: [] }); } groups[groups.length - 1].items.push(e); }
    return groups;
  }, [tzEntries, tzSearch]);

  useEffect(() => {
    if (!tzOpen) return;
    const handler = (e: MouseEvent) => { if (tzDropdownRef.current && !tzDropdownRef.current.contains(e.target as Node)) { setTzOpen(false); setTzSearch(''); } };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [tzOpen]);

  const resetForm = () => {
    setName('');
    setEmail('');
    setEmailError('');
    setRole('member');
    setMemberTz('UTC');
    setTzSearch('');
    setTzOpen(false);
    setFormLoading(false);
    setEditingMember(null);
  };

  const handleOpenForm = (member: TeamMember) => {
    setEditingMember(member);
    setName(member.name);
    setEmail(member.email);
    setEmailError('');
    setRole(member.role);
    setMemberTz(member.timezone || 'UTC');
    setIsFormOpen(true);
  };

  const handleCloseForm = () => {
    setIsFormOpen(false);
    resetForm();
  };

  const handleAvatarCropped = async (blob: Blob) => {
    if (!editingMember) return;
    setAvatarUploading(true);
    try {
      if (isDemoMode) {
        const blobUrl = URL.createObjectURL(blob);
        updateTeamMember(editingMember.id, { avatar: blobUrl });
        setEditingMember(prev => prev ? { ...prev, avatar: blobUrl } : null);
        toast('success', 'Avatar updated');
      } else {
        // Fixed path per member — upsert replaces previous file, no storage bloat
        const path = `team/${editingMember.id}.jpg`;
        const { error: uploadError } = await supabase.storage
          .from('avatars')
          .upload(path, blob, { upsert: true, contentType: 'image/jpeg' });
        if (uploadError) throw uploadError;

        const { data: { publicUrl } } = supabase.storage.from('avatars').getPublicUrl(path);
        const url = `${publicUrl}?t=${Date.now()}`;
        updateTeamMember(editingMember.id, { avatar: url });
        setEditingMember(prev => prev ? { ...prev, avatar: url } : null);
        toast('success', 'Avatar updated');
      }
    } catch {
      toast('error', 'Failed to upload avatar');
    } finally {
      setAvatarUploading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !editingMember) return;

    const emailChanged = email.trim().toLowerCase() !== editingMember.email.toLowerCase();

    if (emailChanged) {
      setShowEmailConfirm(true);
      return;
    }

    updateTeamMember(editingMember.id, { name: name.trim(), role, timezone: memberTz });
    toast('success', 'Team member updated');
    handleCloseForm();
  };

  const handleConfirmEmailChange = async () => {
    if (!editingMember) return;
    setShowEmailConfirm(false);
    setEmailError('');
    setFormLoading(true);

    try {
      const res = await fetch('/api/team-members/update-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ team_member_id: editingMember.id, new_email: email.trim().toLowerCase() }),
      });

      if (!res.ok) {
        const data = await res.json();
        setEmailError(data.error || 'Failed to update email');
        return;
      }

      updateTeamMember(editingMember.id, { name: name.trim(), role, timezone: memberTz, email: email.trim().toLowerCase() });
      toast('success', 'Team member updated');
      handleCloseForm();
    } catch {
      toast('error', 'Failed to update email');
    } finally {
      setFormLoading(false);
    }
  };

  const roleIcons: Record<string, any> = {
    admin: Shield,
    member: User,
    guest: UserMinus,
    agent: Bot,
  };

  const roleColors: Record<string, string> = {
    admin: 'bg-brand-100 text-brand-700',
    member: 'bg-zinc-100 text-zinc-700',
    guest: 'bg-amber-100 text-amber-700',
    agent: 'bg-purple-100 text-purple-700',
  };

  const getTaskCount = (memberId: string) => {
    return tasks.filter(t => t.assignee_ids.includes(memberId)).length;
  };

  const searchLower = filters.search.toLowerCase();
  const filtered = filters.search
    ? team.filter(m =>
        m.name.toLowerCase().includes(searchLower) ||
        m.email.toLowerCase().includes(searchLower))
    : team;

  const MemberCard = ({ member }: { member: TeamMember }) => {
    const [showMenu, setShowMenu] = useState(false);
    const RoleIcon = roleIcons[member.role];
    const taskCount = getTaskCount(member.id);

    return (
      <div className="bg-white rounded-xl border border-zinc-200 p-4 lg:p-5 hover:shadow-md transition-shadow group">
        <div className="flex items-start justify-between mb-3 lg:mb-4">
          <div className="flex items-center gap-3">
            <Avatar name={member.name} src={member.avatar || undefined} size="lg" />
            <div className="min-w-0">
              <h3 className="font-semibold text-zinc-900 truncate text-sm lg:text-base">{member.name}</h3>
              <p className="text-xs lg:text-sm text-zinc-500 truncate">{member.email}</p>
            </div>
          </div>

          {(isAdmin || member.id === currentTeamMemberId) && (
            <div className="relative">
              <button
                onClick={() => setShowMenu(!showMenu)}
                className="lg:opacity-0 group-hover:opacity-100 p-1.5 rounded-lg text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 transition-all"
              >
                <MoreVertical size={16} />
              </button>

              {showMenu && (
                <>
                  <div className="fixed inset-0 z-10 cursor-default" onClick={(e) => { e.stopPropagation(); setShowMenu(false); }} />
                  <div className="absolute right-0 top-10 bg-white rounded-lg shadow-xl border border-zinc-200 py-1 z-20 min-w-[140px] cursor-pointer">
                    <button
                      onClick={() => { handleOpenForm(member); setShowMenu(false); }}
                      className="w-full flex items-center gap-2 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
                    >
                      <Edit size={14} />
                      Edit
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${roleColors[member.role]}`}>
            <RoleIcon size={12} />
            {member.role.charAt(0).toUpperCase() + member.role.slice(1)}
          </span>
          <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-zinc-100 text-zinc-700">
            {taskCount} task{taskCount !== 1 ? 's' : ''}
          </span>
        </div>
      </div>
    );
  };

  return (
    <div className="animate-fadeIn min-h-screen bg-zinc-50">
      <Header
        title="Team"
        subtitle={<span className="hidden sm:inline">{team.length} team members</span>}
        searchPlaceholder="Search team members..."
        actions={isAdmin && !isDemoMode ? (
          <Button icon={<UserPlus size={16} />} onClick={() => setIsInviteOpen(true)}>
            Invite
          </Button>
        ) : undefined}
      />

      <div className="p-4 lg:p-6 space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filtered.map((member) => (
            <MemberCard key={member.id} member={member} />
          ))}
        </div>

        {team.length === 0 && (
          <div className="text-center py-12 bg-white rounded-xl border border-zinc-200">
            <User className="mx-auto mb-3 text-zinc-400" size={40} />
            <h3 className="font-medium text-zinc-700 mb-1">No team members yet</h3>
            <p className="text-sm text-zinc-500">Team members are managed through Supabase</p>
          </div>
        )}
      </div>

      {/* Invite Member Modal */}
      <InviteMemberModal
        isOpen={isInviteOpen}
        onClose={() => setIsInviteOpen(false)}
        onSuccess={(member) => {
          upsertLocalTeamMember(member);
          toast('success', `${member.name} has been invited`);
        }}
        showAgentRole={isAdmin && process.env.NEXT_PUBLIC_ENABLE_AGENTS === 'true'}
      />

      {/* Edit Member Modal */}
      <Modal
        isOpen={isFormOpen}
        onClose={handleCloseForm}
        title="Edit Team Member"
        size="md"
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="flex justify-center">
            <AvatarUpload
              name={editingMember?.name || ''}
              currentSrc={editingMember?.avatar && (editingMember.avatar.startsWith('http') || editingMember.avatar.startsWith('blob:')) ? editingMember.avatar : undefined}
              size="lg"
              onCropped={handleAvatarCropped}
              uploading={avatarUploading}
              onRemove={editingMember?.avatar && (editingMember.avatar.startsWith('http') || editingMember.avatar.startsWith('blob:')) ? () => {
                if (editingMember) {
                  updateTeamMember(editingMember.id, { avatar: '' });
                  setEditingMember(prev => prev ? { ...prev, avatar: '' } : null);
                  toast('success', 'Avatar removed');
                }
              } : undefined}
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
            label="Email"
            type="email"
            value={email}
            onChange={(e) => { setEmail(e.target.value); setEmailError(''); }}
            placeholder="name@example.com"
            error={emailError}
            disabled={formLoading}
          />

          <Select
            label="Role"
            value={role}
            onChange={(value) => setRole(value as TeamMember['role'])}
            disabled={!isAdmin}
            options={[
              { value: 'admin', label: 'Admin' },
              { value: 'member', label: 'Member' },
              { value: 'guest', label: 'Guest' },
              ...(isAdmin && process.env.NEXT_PUBLIC_ENABLE_AGENTS === 'true'
                ? [{ value: 'agent', label: 'Agent' }]
                : []),
            ]}
          />

          <div>
            <label className="block text-sm font-medium text-zinc-700 mb-1.5">Timezone</label>
            <div className="relative" ref={tzDropdownRef}>
              <button
                type="button"
                onClick={() => setTzOpen(!tzOpen)}
                className="w-full flex items-center justify-between px-3 py-2 text-sm bg-white border border-zinc-200 rounded-lg hover:border-zinc-300 transition-colors text-left"
              >
                <span className="flex items-center gap-2 text-zinc-900">
                  <Globe size={14} className="text-zinc-400" />
                  {memberTz.replace(/_/g, ' ')}
                </span>
                <span className="text-zinc-400 text-xs font-mono">
                  {tzEntries.find(e => e.id === memberTz)?.label || 'UTC+0'}
                </span>
              </button>
              {tzOpen && (
                <div className="absolute z-50 mt-1 w-full bg-white border border-zinc-200 rounded-lg shadow-lg">
                  <div className="p-2 border-b border-zinc-100">
                    <input
                      type="text"
                      value={tzSearch}
                      onChange={e => setTzSearch(e.target.value)}
                      placeholder="Search timezones..."
                      className="w-full px-3 py-1.5 text-sm bg-zinc-50 border border-zinc-200 rounded-md outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-100"
                      autoFocus
                    />
                  </div>
                  <div className="max-h-48 overflow-y-auto">
                    {filteredTz.length === 0 ? (
                      <p className="px-3 py-2 text-sm text-zinc-400">No matching timezones</p>
                    ) : filteredTz.map(group => (
                      <div key={group.label}>
                        <div className="sticky top-0 bg-zinc-50 px-3 py-1 text-[11px] font-semibold text-zinc-400 uppercase tracking-wide font-mono border-b border-zinc-100">
                          {group.label}
                        </div>
                        {group.items.map(entry => (
                          <button
                            key={entry.id}
                            type="button"
                            onClick={() => { setMemberTz(entry.id); setTzOpen(false); setTzSearch(''); }}
                            className={`w-full text-left px-3 py-1.5 text-sm hover:bg-zinc-50 transition-colors flex items-center justify-between ${
                              entry.id === memberTz ? 'text-brand-600 font-medium bg-brand-50/50' : 'text-zinc-700'
                            }`}
                          >
                            <span>{entry.id.replace(/_/g, ' ')}</span>
                            {entry.id === memberTz && <Check size={14} className="text-brand-600 flex-shrink-0" />}
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-4">
            <Button type="button" variant="ghost" onClick={handleCloseForm} disabled={formLoading}>
              Cancel
            </Button>
            <Button type="submit" disabled={formLoading}>
              {formLoading ? 'Saving...' : 'Save Changes'}
            </Button>
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        isOpen={showEmailConfirm}
        onClose={() => setShowEmailConfirm(false)}
        onConfirm={handleConfirmEmailChange}
        title="Change Email Address"
        message={`This will change the login email for ${editingMember?.name || 'this member'} from "${editingMember?.email}" to "${email.trim().toLowerCase()}". They'll need to use the new email to sign in.`}
        confirmLabel="Update Email"
        variant="default"
        doubleConfirm={false}
      />
    </div>
  );
}
