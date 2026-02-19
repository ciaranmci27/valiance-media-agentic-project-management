'use client';

import { useState, useEffect } from 'react';
import { useApp, defaultFilters } from '@/lib/store';
import { Header } from '@/components/layout/Header';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import Modal from '@/components/ui/Modal';
import { MoreVertical, Edit, Shield, User, UserMinus } from 'lucide-react';
import { TeamMember } from '@/lib/types';
import { toast } from '@/components/ui/Toast';

export default function TeamPage() {
  const { team, updateTeamMember, tasks, filters, setFilters } = useApp();
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingMember, setEditingMember] = useState<TeamMember | null>(null);

  useEffect(() => { setFilters(defaultFilters); }, []);

  const [name, setName] = useState('');
  const [role, setRole] = useState<TeamMember['role']>('member');

  const resetForm = () => {
    setName('');
    setRole('member');
    setEditingMember(null);
  };

  const handleOpenForm = (member: TeamMember) => {
    setEditingMember(member);
    setName(member.name);
    setRole(member.role);
    setIsFormOpen(true);
  };

  const handleCloseForm = () => {
    setIsFormOpen(false);
    resetForm();
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !editingMember) return;

    updateTeamMember(editingMember.id, { name: name.trim(), role });
    toast('success', 'Team member updated');
    handleCloseForm();
  };

  const roleIcons = {
    admin: Shield,
    member: User,
    guest: UserMinus,
  };

  const roleColors = {
    admin: 'bg-indigo-100 text-indigo-700',
    member: 'bg-zinc-100 text-zinc-700',
    guest: 'bg-amber-100 text-amber-700',
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
            <Avatar name={member.name} size="lg" />
            <div className="min-w-0">
              <h3 className="font-semibold text-zinc-900 truncate text-sm lg:text-base">{member.name}</h3>
              <p className="text-xs lg:text-sm text-zinc-500 truncate">{member.email}</p>
            </div>
          </div>

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

      {/* Edit Member Modal */}
      <Modal
        isOpen={isFormOpen}
        onClose={handleCloseForm}
        title="Edit Team Member"
        size="md"
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Enter full name"
            required
          />

          <div>
            <label className="block text-sm font-medium text-zinc-700 mb-1">Email</label>
            <p className="px-3 py-2 text-sm text-zinc-500 bg-zinc-50 border border-zinc-200 rounded-lg">{editingMember?.email}</p>
            <p className="text-xs text-zinc-400 mt-1">Email is managed through Supabase</p>
          </div>

          <Select
            label="Role"
            value={role}
            onChange={(value) => setRole(value as TeamMember['role'])}
            options={[
              { value: 'admin', label: 'Admin' },
              { value: 'member', label: 'Member' },
              { value: 'guest', label: 'Guest' },
            ]}
          />

          <div className="flex justify-end gap-3 pt-4">
            <Button type="button" variant="ghost" onClick={handleCloseForm}>
              Cancel
            </Button>
            <Button type="submit">
              Save Changes
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
