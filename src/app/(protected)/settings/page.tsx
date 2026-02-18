'use client';

import { useState, useEffect } from 'react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { createClient } from '@/lib/supabase/client';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Avatar } from '@/components/ui/Avatar';
import { User, Palette, Database, Download, Lock } from 'lucide-react';
import { toast } from '@/components/ui/Toast';

export default function SettingsPage() {
  const { team, projects, tasks, updateTeamMember } = useApp();
  const { user, teamMemberId } = useAuth();
  const supabase = createClient();

  const currentMember = team.find(m => m.id === teamMemberId);

  const [userName, setUserName] = useState('');
  const [userEmail, setUserEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [profileLoading, setProfileLoading] = useState(false);

  useEffect(() => {
    if (currentMember) {
      setUserName(currentMember.name || '');
      setUserEmail(currentMember.email || '');
    } else if (user) {
      setUserName(user.user_metadata?.display_name || '');
      setUserEmail(user.email || '');
    }
  }, [currentMember, user]);

  const handleSaveProfile = async () => {
    if (!teamMemberId) return;
    setProfileLoading(true);
    try {
      await updateTeamMember(teamMemberId, { name: userName });
      toast('success', 'Profile saved');
    } catch {
      toast('error', 'Failed to save profile');
    } finally {
      setProfileLoading(false);
    }
  };

  const handleExportData = () => {
    const data = { projects, tasks, team };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `projectem-backup-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    toast('success', 'Data exported successfully');
  };

  const handleChangePassword = async () => {
    if (newPassword.length < 6) {
      toast('error', 'Password must be at least 6 characters');
      return;
    }
    if (newPassword !== confirmPassword) {
      toast('error', 'Passwords do not match');
      return;
    }

    setPasswordLoading(true);
    try {
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) throw error;
      setNewPassword('');
      setConfirmPassword('');
      toast('success', 'Password updated successfully');
    } catch (err: any) {
      toast('error', err.message || 'Failed to update password');
    } finally {
      setPasswordLoading(false);
    }
  };

  const stats = [
    { label: 'Projects', value: projects.length },
    { label: 'Tasks', value: tasks.length },
    { label: 'Team Members', value: team.length },
  ];

  return (
    <div className="animate-fadeIn min-h-screen bg-zinc-50">
      <Header title="Settings" />

      <div className="p-4 lg:p-6 space-y-6 max-w-3xl">
        {/* Profile Section */}
        <section className="bg-white rounded-xl border border-zinc-200 p-4 lg:p-6">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 bg-indigo-50 rounded-lg">
              <User className="text-indigo-600" size={20} />
            </div>
            <div>
              <h2 className="font-semibold text-zinc-900">Profile</h2>
              <p className="text-sm text-zinc-500">Manage your account settings</p>
            </div>
          </div>

          <div className="flex items-center gap-4 mb-6">
            <Avatar name={userName || 'User'} size="lg" />
            <div>
              <p className="font-medium text-zinc-900">{userName || 'Your Name'}</p>
              <p className="text-sm text-zinc-500">{userEmail || 'your@email.com'}</p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Input
              label="Display Name"
              value={userName}
              onChange={(e) => setUserName(e.target.value)}
              placeholder="Your name"
            />
            <Input
              label="Email"
              type="email"
              value={userEmail}
              disabled
              placeholder="your@email.com"
            />
          </div>

          <div className="mt-4">
            <Button onClick={handleSaveProfile} disabled={profileLoading}>
              {profileLoading ? 'Saving...' : 'Save Changes'}
            </Button>
          </div>
        </section>

        {/* Change Password Section */}
        <section className="bg-white rounded-xl border border-zinc-200 p-4 lg:p-6">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 bg-rose-50 rounded-lg">
              <Lock className="text-rose-600" size={20} />
            </div>
            <div>
              <h2 className="font-semibold text-zinc-900">Change Password</h2>
              <p className="text-sm text-zinc-500">Update your account password</p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Input
              label="New Password"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Min. 6 characters"
            />
            <Input
              label="Confirm Password"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Re-enter password"
            />
          </div>

          <div className="mt-4">
            <Button onClick={handleChangePassword} disabled={passwordLoading}>
              {passwordLoading ? 'Updating...' : 'Update Password'}
            </Button>
          </div>
        </section>

        {/* Data Management Section */}
        <section className="bg-white rounded-xl border border-zinc-200 p-4 lg:p-6">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 bg-emerald-50 rounded-lg">
              <Database className="text-emerald-600" size={20} />
            </div>
            <div>
              <h2 className="font-semibold text-zinc-900">Data Management</h2>
              <p className="text-sm text-zinc-500">Manage your project data</p>
            </div>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-3 gap-4 mb-6 p-4 bg-zinc-50 rounded-lg">
            {stats.map((stat) => (
              <div key={stat.label} className="text-center">
                <p className="text-2xl font-bold text-zinc-900">{stat.value}</p>
                <p className="text-xs text-zinc-500">{stat.label}</p>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap gap-3">
            <Button variant="secondary" icon={<Download size={16} />} onClick={handleExportData}>
              Export Data
            </Button>
          </div>
        </section>

        {/* About Section */}
        <section className="bg-white rounded-xl border border-zinc-200 p-4 lg:p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 bg-violet-50 rounded-lg">
              <Palette className="text-violet-600" size={20} />
            </div>
            <div>
              <h2 className="font-semibold text-zinc-900">About</h2>
              <p className="text-sm text-zinc-500">Project Management</p>
            </div>
          </div>

          <div className="text-sm text-zinc-500 space-y-1">
            <p>Version 1.0.0</p>
            <p>Built by ProjectEM</p>
            <p className="pt-2">&copy; 2026 ProjectEM. All rights reserved.</p>
          </div>
        </section>
      </div>
    </div>
  );
}
