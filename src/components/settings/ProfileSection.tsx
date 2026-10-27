'use client';

import { useEffect, useState } from 'react';
import { User } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { createClient } from '@/lib/supabase/client';
import { useDemo } from '@/lib/demo-context';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { AvatarUpload } from '@/components/ui/AvatarUpload';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { toast } from '@/components/ui/Toast';

/** Avatar, display name and login email (an email change asks first). */
export function ProfileSection() {
  const { team, updateTeamMember } = useApp();
  const { user, teamMemberId } = useAuth();
  const { isDemoMode } = useDemo();
  const supabase = createClient();

  const currentMember = team.find((m) => m.id === teamMemberId);

  const [userName, setUserName] = useState('');
  const [userEmail, setUserEmail] = useState('');
  const [originalEmail, setOriginalEmail] = useState('');
  const [emailError, setEmailError] = useState('');
  const [showEmailConfirm, setShowEmailConfirm] = useState(false);
  const [profileLoading, setProfileLoading] = useState(false);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarSrc, setAvatarSrc] = useState<string | undefined>(undefined);

  // Derive current avatar src from member data or local override
  const currentAvatarSrc =
    avatarSrc ??
    (currentMember?.avatar &&
    (currentMember.avatar.startsWith('http') || currentMember.avatar.startsWith('blob:'))
      ? currentMember.avatar
      : undefined);

  // Hydrate once per member, so a store refresh never overwrites unsaved edits.
  useEffect(() => {
    if (currentMember) {
      setUserName(currentMember.name || '');
      setUserEmail(currentMember.email || '');
      setOriginalEmail(currentMember.email || '');
    } else if (user) {
      setUserName(user.user_metadata?.display_name || '');
      setUserEmail(user.email || '');
      setOriginalEmail(user.email || '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        // Fixed path per member ; upsert replaces previous file, no storage bloat
        const path = `team/${teamMemberId}.jpg`;
        const { error: uploadError } = await supabase.storage
          .from('avatars')
          .upload(path, blob, { upsert: true, contentType: 'image/jpeg' });
        if (uploadError) throw uploadError;

        const {
          data: { publicUrl },
        } = supabase.storage.from('avatars').getPublicUrl(path);
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

    const emailChanged = userEmail.trim().toLowerCase() !== originalEmail.toLowerCase();

    if (emailChanged) {
      setShowEmailConfirm(true);
      return;
    }

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

  const handleConfirmEmailChange = async () => {
    if (!teamMemberId) return;
    setShowEmailConfirm(false);
    setProfileLoading(true);
    setEmailError('');

    try {
      const res = await fetch('/api/team-members/update-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          team_member_id: teamMemberId,
          new_email: userEmail.trim().toLowerCase(),
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        setEmailError(data.error || 'Failed to update email');
        setProfileLoading(false);
        return;
      }

      setOriginalEmail(userEmail.trim().toLowerCase());
      updateTeamMember(teamMemberId, { name: userName, email: userEmail.trim().toLowerCase() });
      toast('success', 'Profile and email updated');
    } catch {
      toast('error', 'Failed to update email');
    } finally {
      setProfileLoading(false);
    }
  };

  return (
    <>
      <section id="profile" className="glass-card rounded-xl p-4 lg:p-6 scroll-mt-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="p-2 bg-brand-500/15 rounded-lg">
            <User className="text-brand-300" size={20} />
          </div>
          <div>
            <h2 className="font-semibold text-white">Profile</h2>
            <p className="text-sm text-zinc-400">Manage your account settings</p>
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
          <div className="min-w-0 flex-1">
            <p className="font-medium text-white truncate">{userName || 'Your Name'}</p>
            <p className="text-sm text-zinc-400 truncate">{userEmail || 'your@email.com'}</p>
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
            onChange={(e) => {
              setUserEmail(e.target.value);
              setEmailError('');
            }}
            placeholder="your@email.com"
            error={emailError}
            disabled={isDemoMode}
          />
        </div>

        <div className="mt-4">
          <Button onClick={handleSaveProfile} disabled={profileLoading}>
            {profileLoading ? 'Saving...' : 'Save Changes'}
          </Button>
        </div>
      </section>

      <ConfirmDialog
        isOpen={showEmailConfirm}
        onClose={() => setShowEmailConfirm(false)}
        onConfirm={handleConfirmEmailChange}
        title="Change Email Address"
        message={`This will change your login email from "${originalEmail}" to "${userEmail.trim().toLowerCase()}". You'll need to use the new email to sign in.`}
        confirmLabel="Update Email"
        variant="default"
        doubleConfirm={false}
      />
    </>
  );
}
