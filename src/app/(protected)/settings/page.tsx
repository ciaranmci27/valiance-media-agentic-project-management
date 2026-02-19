'use client';

import { useState, useEffect } from 'react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { createClient } from '@/lib/supabase/client';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { AvatarUpload } from '@/components/ui/AvatarUpload';
import { User, Lock, FlaskConical } from 'lucide-react';
import { toast } from '@/components/ui/Toast';
import { useDemo } from '@/lib/demo-context';

export default function SettingsPage() {
  const { team, updateTeamMember } = useApp();
  const { user, teamMemberId } = useAuth();
  const supabase = createClient();

  const { isDemoMode, isEnvForcedDemo, toggleDemoMode } = useDemo();

  const currentMember = team.find(m => m.id === teamMemberId);
  const isAdmin = currentMember?.role === 'admin';

  const [userName, setUserName] = useState('');
  const [userEmail, setUserEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [profileLoading, setProfileLoading] = useState(false);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarSrc, setAvatarSrc] = useState<string | undefined>(undefined);

  // Derive current avatar src from member data or local override
  const currentAvatarSrc = avatarSrc ?? (
    currentMember?.avatar && (currentMember.avatar.startsWith('http') || currentMember.avatar.startsWith('blob:'))
      ? currentMember.avatar
      : undefined
  );

  useEffect(() => {
    if (currentMember) {
      setUserName(currentMember.name || '');
      setUserEmail(currentMember.email || '');
    } else if (user) {
      setUserName(user.user_metadata?.display_name || '');
      setUserEmail(user.email || '');
    }
  }, [currentMember?.id, user?.id]);

  const handleAvatarCropped = async (blob: Blob) => {
    if (!teamMemberId) return;
    setAvatarUploading(true);
    try {
      if (isDemoMode) {
        const blobUrl = URL.createObjectURL(blob);
        setAvatarSrc(blobUrl);
        updateTeamMember(teamMemberId, { avatar: blobUrl });
        toast('success', 'Avatar updated');
      } else {
        // Fixed path per member — upsert replaces previous file, no storage bloat
        const path = `team/${teamMemberId}.jpg`;
        const { error: uploadError } = await supabase.storage
          .from('avatars')
          .upload(path, blob, { upsert: true, contentType: 'image/jpeg' });
        if (uploadError) throw uploadError;

        const { data: { publicUrl } } = supabase.storage.from('avatars').getPublicUrl(path);
        const url = `${publicUrl}?t=${Date.now()}`;
        setAvatarSrc(url);
        await updateTeamMember(teamMemberId, { avatar: url });
        toast('success', 'Avatar updated');
      }
    } catch {
      toast('error', 'Failed to upload avatar');
    } finally {
      setAvatarUploading(false);
    }
  };

  const handleRemoveAvatar = () => {
    if (!teamMemberId) return;
    setAvatarSrc(undefined);
    updateTeamMember(teamMemberId, { avatar: '' });
    toast('success', 'Avatar removed');
  };

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

  return (
    <div className="animate-fadeIn min-h-screen bg-zinc-50">
      <Header title="Settings" />

      <div className="p-4 lg:p-6 space-y-6 max-w-3xl mx-auto">
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
            <AvatarUpload
              name={userName || 'User'}
              currentSrc={currentAvatarSrc}
              size="lg"
              onCropped={handleAvatarCropped}
              uploading={avatarUploading}
              onRemove={currentAvatarSrc ? handleRemoveAvatar : undefined}
            />
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

        {/* Demo Mode Section — admin only, hidden when env-forced */}
        {isAdmin && !isEnvForcedDemo && (
          <section className="bg-white rounded-xl border border-zinc-200 p-4 lg:p-6">
            <div className="flex items-center gap-3 mb-6">
              <div className="p-2 bg-amber-50 rounded-lg">
                <FlaskConical className="text-amber-600" size={20} />
              </div>
              <div>
                <h2 className="font-semibold text-zinc-900">Demo Mode</h2>
                <p className="text-sm text-zinc-500">View the app with sample data</p>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-zinc-700">Enable demo mode</p>
                <p className="text-xs text-zinc-500 mt-0.5">Replaces live data with sample data. Changes won&apos;t be saved.</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={isDemoMode}
                onClick={toggleDemoMode}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  isDemoMode ? 'bg-amber-500' : 'bg-zinc-200'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    isDemoMode ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>
          </section>
        )}

        {/* Change Password Section */}
        {!isDemoMode && (
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
        )}
      </div>
    </div>
  );
}
