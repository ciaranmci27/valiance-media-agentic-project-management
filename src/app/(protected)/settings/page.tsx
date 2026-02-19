'use client';

import { useState, useEffect } from 'react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { createClient } from '@/lib/supabase/client';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { AvatarUpload } from '@/components/ui/AvatarUpload';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { User, Lock, FlaskConical, Key, Copy, Check, Plus, Ban, ExternalLink } from 'lucide-react';
import { toast } from '@/components/ui/Toast';
import { useDemo } from '@/lib/demo-context';
import { hashApiKey, generateApiKey } from '@/lib/api/crypto';
import type { ApiKey } from '@/lib/types';

export default function SettingsPage() {
  const { team, updateTeamMember, apiKeys, addApiKey, revokeApiKey } = useApp();
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

  // API Key state
  const [showKeyForm, setShowKeyForm] = useState(false);
  const [keyName, setKeyName] = useState('');
  const [keyPermissions, setKeyPermissions] = useState<'full' | 'read_only'>('full');
  const [generatingKey, setGeneratingKey] = useState(false);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<ApiKey | null>(null);

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

  const handleGenerateKey = async () => {
    if (!keyName.trim()) {
      toast('error', 'Please enter a name for this key');
      return;
    }

    setGeneratingKey(true);
    try {
      const fullKey = generateApiKey();
      const keyHash = await hashApiKey(fullKey);
      const keyPrefix = fullKey.slice(0, 15);

      const result = await addApiKey(keyName.trim(), keyHash, keyPrefix, keyPermissions);
      if (result) {
        setRevealedKey(fullKey);
        setKeyName('');
        setKeyPermissions('full');
        setShowKeyForm(false);
      }
    } catch {
      toast('error', 'Failed to generate API key');
    } finally {
      setGeneratingKey(false);
    }
  };

  const handleCopyKey = () => {
    if (!revealedKey) return;
    navigator.clipboard.writeText(revealedKey);
    setCopiedKey(true);
    toast('success', 'API key copied to clipboard');
    setTimeout(() => setCopiedKey(false), 2000);
  };

  const handleRevokeKey = () => {
    if (!revokeTarget) return;
    revokeApiKey(revokeTarget.id);
    toast('success', 'API key revoked');
    setRevokeTarget(null);
  };

  const formatRelativeTime = (dateStr: string | null) => {
    if (!dateStr) return 'Never';
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'Just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDays = Math.floor(diffHr / 24);
    if (diffDays < 30) return `${diffDays}d ago`;
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  const activeKeys = apiKeys.filter(k => !k.revoked_at);
  const revokedKeys = apiKeys.filter(k => k.revoked_at);

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

        {/* API Keys Section — admin only */}
        {isAdmin && !isDemoMode && (
          <section className="bg-white rounded-xl border border-zinc-200 p-4 lg:p-6">
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-violet-50 rounded-lg">
                  <Key className="text-violet-600" size={20} />
                </div>
                <div>
                  <h2 className="font-semibold text-zinc-900">API Keys</h2>
                  <p className="text-sm text-zinc-500">Manage keys for external integrations</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <a
                  href="/api/docs"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-violet-600 hover:bg-violet-50 rounded-lg transition-colors"
                >
                  <ExternalLink size={14} />
                  View Docs
                </a>
                {!showKeyForm && !revealedKey && (
                  <Button
                    size="sm"
                    onClick={() => setShowKeyForm(true)}
                    icon={<Plus size={14} />}
                  >
                    Generate New Key
                  </Button>
                )}
              </div>
            </div>

            {/* One-time key display */}
            {revealedKey && (
              <div className="mb-6 p-4 bg-emerald-50 border border-emerald-200 rounded-lg space-y-3">
                <div className="flex items-center gap-2">
                  <Check size={16} className="text-emerald-600" />
                  <p className="text-sm font-medium text-emerald-800">API key generated successfully</p>
                </div>
                <p className="text-xs text-emerald-700">
                  Copy this key now. It will only be shown once and cannot be retrieved later.
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 px-3 py-2 bg-white border border-emerald-200 rounded-lg text-sm font-mono text-zinc-800 break-all select-all">
                    {revealedKey}
                  </code>
                  <button
                    onClick={handleCopyKey}
                    className="p-2 text-emerald-600 hover:bg-emerald-100 rounded-lg transition-colors flex-shrink-0"
                  >
                    {copiedKey ? <Check size={16} /> : <Copy size={16} />}
                  </button>
                </div>
                <Button size="sm" variant="secondary" onClick={() => setRevealedKey(null)}>
                  Done
                </Button>
              </div>
            )}

            {/* Generate key form */}
            {showKeyForm && (
              <div className="mb-6 p-4 bg-zinc-50 border border-zinc-200 rounded-lg space-y-3">
                <h4 className="text-sm font-medium text-zinc-900">New API Key</h4>
                <Input
                  label="Name"
                  value={keyName}
                  onChange={(e) => setKeyName(e.target.value)}
                  placeholder='e.g. "Zapier Integration"'
                />
                <div>
                  <label className="block text-sm font-medium text-zinc-700 mb-1.5">Permissions</label>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setKeyPermissions('full')}
                      className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
                        keyPermissions === 'full'
                          ? 'bg-indigo-50 border-indigo-200 text-indigo-700'
                          : 'bg-white border-zinc-200 text-zinc-600 hover:border-zinc-300'
                      }`}
                    >
                      Full Access
                    </button>
                    <button
                      onClick={() => setKeyPermissions('read_only')}
                      className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
                        keyPermissions === 'read_only'
                          ? 'bg-indigo-50 border-indigo-200 text-indigo-700'
                          : 'bg-white border-zinc-200 text-zinc-600 hover:border-zinc-300'
                      }`}
                    >
                      Read Only
                    </button>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button onClick={handleGenerateKey} disabled={generatingKey || !keyName.trim()}>
                    {generatingKey ? 'Generating...' : 'Generate'}
                  </Button>
                  <Button variant="secondary" onClick={() => { setShowKeyForm(false); setKeyName(''); }}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}

            {/* Keys table */}
            {activeKeys.length > 0 && (
              <div className="border border-zinc-200 rounded-lg divide-y divide-zinc-100">
                {activeKeys.map(key => (
                  <div key={key.id} className="flex items-center gap-3 px-4 py-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-zinc-900">{key.name}</p>
                      <div className="flex items-center gap-2 mt-0.5">
                        <code className="text-xs text-zinc-500 font-mono">{key.key_prefix}...****</code>
                        <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${
                          key.permissions === 'full'
                            ? 'bg-indigo-50 text-indigo-600'
                            : 'bg-zinc-100 text-zinc-500'
                        }`}>
                          {key.permissions === 'full' ? 'Full' : 'Read Only'}
                        </span>
                      </div>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <p className="text-xs text-zinc-400">Last used</p>
                      <p className="text-xs text-zinc-600">{formatRelativeTime(key.last_used_at)}</p>
                    </div>
                    <button
                      onClick={() => setRevokeTarget(key)}
                      className="p-1.5 text-zinc-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors flex-shrink-0"
                      title="Revoke key"
                    >
                      <Ban size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {activeKeys.length === 0 && !showKeyForm && !revealedKey && (
              <div className="text-center py-6 text-zinc-500">
                <Key className="mx-auto mb-2" size={24} />
                <p className="text-sm">No API keys yet</p>
                <p className="text-xs mt-1">Generate a key to enable external integrations</p>
              </div>
            )}

            {/* Revoked keys */}
            {revokedKeys.length > 0 && (
              <div className="mt-4">
                <p className="text-xs font-medium text-zinc-400 uppercase tracking-wide mb-2">Revoked</p>
                <div className="border border-zinc-100 rounded-lg divide-y divide-zinc-50">
                  {revokedKeys.map(key => (
                    <div key={key.id} className="flex items-center gap-3 px-4 py-2.5 opacity-50">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-zinc-500 line-through">{key.name}</p>
                        <code className="text-xs text-zinc-400 font-mono">{key.key_prefix}...****</code>
                      </div>
                      <span className="text-xs text-red-400">Revoked</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
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

      <ConfirmDialog
        isOpen={!!revokeTarget}
        onClose={() => setRevokeTarget(null)}
        onConfirm={handleRevokeKey}
        title="Revoke API Key"
        message={`This will permanently revoke "${revokeTarget?.name}". Any integrations using this key will stop working immediately.`}
        confirmLabel="Revoke"
        variant="danger"
      />
    </div>
  );
}
