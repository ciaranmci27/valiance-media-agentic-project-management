'use client';

import { useState } from 'react';
import { useApp } from '@/lib/store';
import { Header } from '@/components/layout/Header';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import Modal from '@/components/ui/Modal';
import { Plus, Mail, MoreVertical, Edit, Trash2, Shield, User, UserMinus } from 'lucide-react';
import { TeamMember } from '@/lib/types';
import { toast } from '@/components/ui/Toast';

export default function TeamPage() {
  const { team, addTeamMember, updateTeamMember, deleteTeamMember, tasks } = useApp();
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingMember, setEditingMember] = useState<TeamMember | null>(null);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<TeamMember['role']>('member');

  const resetForm = () => {
    setName('');
    setEmail('');
    setRole('member');
    setEditingMember(null);
  };

  const handleOpenForm = (member?: TeamMember) => {
    if (member) {
      setEditingMember(member);
      setName(member.name);
      setEmail(member.email);
      setRole(member.role);
    } else {
      resetForm();
    }
    setIsFormOpen(true);
  };

  const handleCloseForm = () => {
    setIsFormOpen(false);
    resetForm();
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (!name.trim() || !email.trim()) return;

    const avatar = name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);

    if (editingMember) {
      updateTeamMember(editingMember.id, { name: name.trim(), email: email.trim(), role });
      toast('success', 'Team member updated');
    } else {
      addTeamMember({ name: name.trim(), email: email.trim(), role, avatar });
      toast('success', 'Team member added');
    }

    handleCloseForm();
  };

  const handleDelete = (id: string) => {
    if (confirm('Are you sure you want to remove this team member?')) {
      deleteTeamMember(id);
      toast('success', 'Team member removed');
    }
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
                <div className="fixed inset-0 z-10" onClick={() => setShowMenu(false)} />
                <div className="absolute right-0 top-10 bg-white rounded-lg shadow-xl border border-zinc-200 py-1 z-20 min-w-[140px]">
                  <button
                    onClick={() => { handleOpenForm(member); setShowMenu(false); }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
                  >
                    <Edit size={14} />
                    Edit
                  </button>
                  <button
                    onClick={() => { handleDelete(member.id); setShowMenu(false); }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-600 hover:bg-red-50"
                  >
                    <Trash2 size={14} />
                    Remove
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${roleColors[member.role]}`}>
            <RoleIcon size={12} />
            {member.role.charAt(0).toUpperCase() + member.role.slice(1)}
          </span>
        </div>

        <div className="pt-3 border-t border-zinc-100 flex items-center justify-between text-xs lg:text-sm text-zinc-500">
          <div className="flex items-center gap-1">
            <Mail size={14} />
            <span>{taskCount} task{taskCount !== 1 ? 's' : ''}</span>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="animate-fadeIn min-h-screen bg-zinc-50">
      <Header
        title="Team"
        subtitle={`${team.length} team members`}
        actions={
          <Button onClick={() => handleOpenForm()} icon={<Plus size={16} />}>
            Add Member
          </Button>
        }
      />

      <div className="p-4 lg:p-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {team.map((member) => (
            <MemberCard key={member.id} member={member} />
          ))}
        </div>

        {team.length === 0 && (
          <div className="text-center py-12 bg-white rounded-xl border border-zinc-200">
            <User className="mx-auto mb-3 text-zinc-400" size={40} />
            <h3 className="font-medium text-zinc-700 mb-1">No team members yet</h3>
            <p className="text-sm text-zinc-500 mb-4">Add your first team member to get started</p>
            <Button onClick={() => handleOpenForm()} icon={<Plus size={16} />}>
              Add Member
            </Button>
          </div>
        )}
      </div>

      {/* Add/Edit Member Modal */}
      <Modal
        isOpen={isFormOpen}
        onClose={handleCloseForm}
        title={editingMember ? 'Edit Team Member' : 'Add Team Member'}
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

          <Input
            label="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Enter email address"
            required
          />

          <Select
            label="Role"
            value={role}
            onChange={(e) => setRole(e.target.value as TeamMember['role'])}
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
              {editingMember ? 'Save Changes' : 'Add Member'}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
