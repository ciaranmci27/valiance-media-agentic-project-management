'use client';

import { useEffect, useState } from 'react';
import { User } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { createClient } from '@/lib/supabase/client';
import { useDemo } from '@/lib/demo-context';
import { Button } from '@/components/ui/Button';
import { useDiscardGuard } from '@/components/ui/useDiscardGuard';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import { SettingsSaveBar } from '@/components/settings/SettingsSaveBar';
import { Input } from '@/components/ui/Input';
import { AvatarUpload } from '@/components/ui/AvatarUpload';
import Modal from '@/components/ui/Modal';
import { PasswordInput } from '@/components/ui/inputs/PasswordInput';
import { toast } from '@/components/ui/Toast';
import { pmStorage } from '@/lib/supabase/storage';
import { BUCKETS } from '@/lib/supabase/schema';
import { checkMemberName } from '@/lib/member-profile';
import { useRead } from '@/lib/query-cache';
import { mySignInRead } from '@/lib/reads';

/** Avatar, display name and login email (an email change asks first). */
export function ProfileSection() {
  const { team, updateTeamMember } = useApp();
  const { user, teamMemberId, signOut } = useAuth();
  const { isDemoMode } = useDemo();
  const supabase = createClient();

  const currentMember = team.find((m) => m.id === teamMemberId);

  const [userName, setUserName] = useState('');
  const [userEmail, setUserEmail] = useState('');
  const [originalEmail, setOriginalEmail] = useState('');
  const [emailError, setEmailError] = useState('');
  const [nameError, setNameError] = useState('');
  const [showEmailConfirm, setShowEmailConfirm] = useState(false);
  // Your own sign-in email needs your current password, or a recent sign-in without one (account-security.ts).
  const [currentPassword, setCurrentPassword] = useState('');
  const [proofError, setProofError] = useState<{ message: string; signInAgain: boolean } | null>(null);
  const signIn = useRead(mySignInRead(isDemoMode)).data;
  const hasPassword = signIn?.has_password !== false;
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
        const { error: uploadError } = await pmStorage(supabase)
          .from(BUCKETS.avatars)
          .upload(path, blob, { upsert: true, contentType: 'image/jpeg' });
        if (uploadError) throw uploadError;

        const {
          data: { publicUrl },
        } = pmStorage(supabase).from(BUCKETS.avatars).getPublicUrl(path);
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
    // A name is required (the server says the same): a blank one left a nameless row on Team.
    const checked = checkMemberName(userName);
    if (!checked.ok) {
      setNameError(checked.error);
      document.getElementById('profile-display-name')?.focus();
      return;
    }
    setUserName(checked.name);

    if (emailChanged) {
      setShowEmailConfirm(true);
      return;
    }

    setProfileLoading(true);
    try {
      // The store says why when the save fails; only a saved profile says so.
      if (await updateTeamMember(teamMemberId, { name: checked.name })) toast('success', 'Profile saved');
    } catch {
      toast('error', 'Failed to save profile');
    } finally {
      setProfileLoading(false);
    }
  };

  // What the form holds against what is saved: the bar shows only while they differ.
  const savedName = currentMember?.name ?? user?.user_metadata?.display_name ?? '';
  const emailChanged = userEmail.trim().toLowerCase() !== originalEmail.toLowerCase();
  const dirty = userName.trim() !== savedName.trim() || emailChanged;
  const discard = () => {
    setUserName(savedName);
    setUserEmail(originalEmail);
    setNameError('');
    setEmailError('');
  };
  // Leaving with unsaved edits asks first (the browser's own prompt; Settings has no close button to guard).
  const guard = useDiscardGuard(dirty, discard);

  const handleConfirmEmailChange = async () => {
    if (!teamMemberId) return;
    const checked = checkMemberName(userName);
    if (!checked.ok) {
      setShowEmailConfirm(false);
      setNameError(checked.error);
      return;
    }
    if (hasPassword && !currentPassword) {
      setProofError({ message: 'Enter your current password.', signInAgain: false });
      return;
    }
    setProfileLoading(true);
    setEmailError('');
    setProofError(null);

    try {
      const res = await fetch('/api/team-members/update-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          team_member_id: teamMemberId,
          new_email: userEmail.trim().toLowerCase(),
          ...(hasPassword ? { current_password: currentPassword } : {}),
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const reason = data?.details?.reason as string | undefined;
        if (reason === 'wrong_password' || reason === 'current_password_required' || reason === 'fresh_sign_in_required') {
          // Stay in the dialog: the person fixes the password or signs in again.
          setProofError({ message: data.error, signInAgain: reason === 'fresh_sign_in_required' });
          setProfileLoading(false);
          return;
        }
        setShowEmailConfirm(false);
        setCurrentPassword('');
        setEmailError(data.error || 'Failed to update email');
        setProfileLoading(false);
        return;
      }

      setShowEmailConfirm(false);
      setCurrentPassword('');
      setOriginalEmail(userEmail.trim().toLowerCase());
      updateTeamMember(teamMemberId, { name: checked.name, email: userEmail.trim().toLowerCase() });
      toast('success', 'Profile and email updated');
    } catch {
      toast('error', 'Failed to update email');
    } finally {
      setProfileLoading(false);
    }
  };

  return (
    <>
      <section id="profile" className="glass-card rounded-xl p-4 lg:p-5 scroll-mt-6">
        <SettingsSectionHeader icon={User} title="Profile" description="Your photo, name and the email you sign in with." />

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
            <p className="font-medium text-white truncate">{userName || 'Your name'}</p>
            <p className="text-sm text-zinc-400 truncate">{userEmail || 'your@email.com'}</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Input
            id="profile-display-name"
            label="Display name"
            value={userName}
            onChange={(e) => {
              setUserName(e.target.value);
              setNameError('');
            }}
            placeholder="Your name"
            error={nameError}
            required
            maxLength={100}
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

        <SettingsSaveBar
          dirty={dirty}
          saving={profileLoading}
          onDiscard={discard}
          onSave={() => { void handleSaveProfile(); }}
          message={emailChanged ? 'New email not saved' : undefined}
        />
        {guard.dialog}
      </section>

      <Modal
        isOpen={showEmailConfirm}
        onClose={() => { if (!profileLoading) { setShowEmailConfirm(false); setCurrentPassword(''); setProofError(null); } }}
        title="Change your email?"
        size="sm"
        primaryAction={{ label: 'Change email', form: 'profile-email-confirm', busy: profileLoading }}
      >
        <form
          id="profile-email-confirm"
          className="space-y-4"
          noValidate
          onSubmit={(event) => { event.preventDefault(); void handleConfirmEmailChange(); }}
        >
          <p className="text-sm text-zinc-300">
            You will sign in with <span className="break-all font-medium text-zinc-100">{userEmail.trim().toLowerCase()}</span>. We will let <span className="break-all">{originalEmail}</span> know.
          </p>
          {hasPassword ? (
            <PasswordInput
              label="Current password"
              value={currentPassword}
              onChange={(value) => { setCurrentPassword(value); setProofError(null); }}
              placeholder="Your password now"
              autoComplete="current-password"
              autoFocus
              showIcon={false}
              error={proofError && !proofError.signInAgain ? proofError.message : undefined}
              disabled={profileLoading}
            />
          ) : !proofError ? (
            <p className="text-xs text-zinc-400">You signed in with Google, so this works for 10 minutes after you sign in.</p>
          ) : null}
          {proofError?.signInAgain && (
            <div role="alert" className="flex flex-col gap-2 rounded-lg bg-amber-500/[0.14] px-3 py-2.5 text-sm text-amber-300">
              <span>{proofError.message}</span>
              <Button type="button" variant="secondary" size="sm" onClick={() => void signOut()} className="self-start">Sign in again</Button>
            </div>
          )}
        </form>
      </Modal>
    </>
  );
}
