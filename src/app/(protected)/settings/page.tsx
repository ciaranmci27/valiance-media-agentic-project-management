'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { createClient } from '@/lib/supabase/client';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { AvatarUpload } from '@/components/ui/AvatarUpload';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { User, Lock, FlaskConical, Key, Copy, Check, Plus, Ban, BookOpen, Bell, Globe, Mail } from 'lucide-react';
import { toast } from '@/components/ui/Toast';
import { useDemo } from '@/lib/demo-context';
import { SmtpSection } from '@/components/settings/SmtpSection';
import { Tooltip } from '@/components/ui/Tooltip';
import Link from 'next/link';
import { hashApiKey, generateApiKey } from '@/lib/api/crypto';
import type { ApiKey, NotificationCategory, NotificationPreferences } from '@/lib/types';

const NOTIF_GROUPS: { group: string; adminOnly?: boolean; agentOnly?: boolean; items: { key: NotificationCategory; label: string; desc: string }[] }[] = [
  {
    group: 'Tasks',
    items: [
      { key: 'task_created', label: 'Task created', desc: 'A new task is created' },
      { key: 'task_deleted', label: 'Task deleted', desc: 'A task is deleted' },
      { key: 'task_status', label: 'Status changes', desc: 'Task moved to In Progress, Done, etc.' },
      { key: 'task_assignments', label: 'Assignments', desc: 'Someone is assigned to a task' },
      { key: 'task_updates', label: 'General updates', desc: 'Priority, title, and other task changes' },
      { key: 'task_subtasks', label: 'Subtasks', desc: 'Subtasks added, completed, or removed' },
      { key: 'task_comments', label: 'Comments', desc: 'Comments added, edited, or removed' },
    ],
  },
  {
    group: 'Projects',
    items: [
      { key: 'project_created', label: 'Project created', desc: 'A new project is created' },
      { key: 'project_deleted', label: 'Project archived', desc: 'A project is archived or deleted' },
      { key: 'project_updates', label: 'Project updates', desc: 'Project details changed' },
      { key: 'project_contacts', label: 'Project contacts', desc: 'Contacts linked or removed' },
      { key: 'portal_settings', label: 'Portal settings', desc: 'Portal enabled, disabled, or configured' },
      { key: 'portal_updates', label: 'Portal updates', desc: 'Timeline updates posted, edited, or removed' },
      { key: 'time_entries', label: 'Time tracking', desc: 'Time entries logged, updated, or deleted' },
      { key: 'entity_files', label: 'File attachments', desc: 'Files attached or removed from entities' },
    ],
  },
  {
    group: 'Contacts',
    items: [
      { key: 'contact_created', label: 'Contact created', desc: 'A new contact is added' },
      { key: 'contact_deleted', label: 'Contact deleted', desc: 'A contact is removed' },
      { key: 'contact_updates', label: 'Contact updates', desc: 'Contact details changed' },
    ],
  },
  {
    group: 'Team',
    items: [
      { key: 'team_members', label: 'Team changes', desc: 'Members added, invited, or removed' },
      { key: 'api_keys', label: 'API keys', desc: 'API keys created or revoked' },
    ],
  },
  {
    group: 'Leads',
    items: [
      { key: 'lead_created', label: 'Lead created', desc: 'A new lead is created' },
      { key: 'lead_deleted', label: 'Lead archived', desc: 'A lead is archived or deleted' },
      { key: 'lead_status', label: 'Status changes', desc: 'Lead moved between pipeline stages' },
      { key: 'lead_updates', label: 'General updates', desc: 'Field changes and detail updates' },
      { key: 'lead_interactions', label: 'Interactions', desc: 'Calls, emails, meetings added or updated' },
      { key: 'lead_proposals', label: 'Proposals', desc: 'Proposals added, updated, or removed' },
      { key: 'lead_contacts', label: 'Contacts', desc: 'Contacts linked or removed from leads' },
      { key: 'lead_conversions', label: 'Conversions', desc: 'Lead converted to a project' },
    ],
  },
  {
    group: 'Agent',
    adminOnly: true,
    agentOnly: true,
    items: [
      { key: 'agent_suggestions' as NotificationCategory, label: 'Suggestions', desc: 'AI agent submits or resubmits suggestions' },
      { key: 'agent_goals' as NotificationCategory, label: 'Goals', desc: 'Agent goals created, updated, or archived' },
      { key: 'agent_autonomous' as NotificationCategory, label: 'Autonomous toggle', desc: 'Autonomous agents enabled or disabled on a project' },
      { key: 'agent_activity' as NotificationCategory, label: 'Activity', desc: 'General AI agent activity and status updates' },
    ],
  },
];

export default function SettingsPage() {
  const { team, updateTeamMember, apiKeys, addApiKey, revokeApiKey } = useApp();
  const { user, teamMemberId } = useAuth();
  const supabase = createClient();

  const { isDemoMode, isEnvForcedDemo, toggleDemoMode } = useDemo();

  const currentMember = team.find(m => m.id === teamMemberId);
  const isAdmin = currentMember?.role === 'admin';

  const [userName, setUserName] = useState('');
  const [userEmail, setUserEmail] = useState('');
  const [originalEmail, setOriginalEmail] = useState('');
  const [emailError, setEmailError] = useState('');
  const [showEmailConfirm, setShowEmailConfirm] = useState(false);
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

  // Notification prefs state
  const [notifPrefs, setNotifPrefs] = useState<NotificationPreferences>({});
  const [emailEnabled, setEmailEnabled] = useState(false);
  const [emailNotifPrefs, setEmailNotifPrefs] = useState<NotificationPreferences>({});
  const [hasSmtp, setHasSmtp] = useState<boolean | null>(null);

  // Timezone state
  const [timezone, setTimezone] = useState('UTC');
  const [tzSearch, setTzSearch] = useState('');
  const [tzDropdownOpen, setTzDropdownOpen] = useState(false);

  const tzEntries = useMemo(() => {
    let zones: string[];
    try {
      zones = Intl.supportedValuesOf('timeZone');
    } catch {
      zones = ['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu', 'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Kolkata', 'Australia/Sydney'];
    }

    const now = Date.now();
    return zones.map(tz => {
      // Extract the UTC offset label (e.g. "GMT-7", "GMT+5:30")
      try {
        const parts = new Intl.DateTimeFormat('en-US', {
          timeZone: tz,
          timeZoneName: 'shortOffset',
        }).formatToParts(now);
        const raw = parts.find(p => p.type === 'timeZoneName')?.value || 'GMT';
        // Convert "GMT" → "UTC+0", "GMT-7" → "UTC-7", "GMT+5:30" → "UTC+5:30"
        const label = raw === 'GMT' ? 'UTC+0' : raw.replace('GMT', 'UTC');
        // Parse offset to minutes for sorting
        const match = label.match(/UTC([+-])(\d+)(?::(\d+))?/);
        const offsetMin = match
          ? (match[1] === '+' ? 1 : -1) * (parseInt(match[2]) * 60 + parseInt(match[3] || '0'))
          : 0;
        return { id: tz, label, offsetMin };
      } catch {
        return { id: tz, label: 'UTC+0', offsetMin: 0 };
      }
    }).sort((a, b) => a.offsetMin - b.offsetMin || a.id.localeCompare(b.id));
  }, []);

  const filteredTzEntries = useMemo(() => {
    const entries = tzSearch
      ? tzEntries.filter(e => {
          const q = tzSearch.toLowerCase();
          return e.id.toLowerCase().includes(q) || e.label.toLowerCase().includes(q);
        })
      : tzEntries;

    // Group by offset label
    const groups: { label: string; items: typeof entries }[] = [];
    let currentLabel = '';
    for (const entry of entries) {
      if (entry.label !== currentLabel) {
        currentLabel = entry.label;
        groups.push({ label: currentLabel, items: [] });
      }
      groups[groups.length - 1].items.push(entry);
    }
    return groups;
  }, [tzEntries, tzSearch]);

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
      setOriginalEmail(currentMember.email || '');
    } else if (user) {
      setUserName(user.user_metadata?.display_name || '');
      setUserEmail(user.email || '');
      setOriginalEmail(user.email || '');
    }
  }, [currentMember?.id, user?.id]);

  useEffect(() => {
    if (currentMember?.notification_prefs) {
      setNotifPrefs(currentMember.notification_prefs);
    }
    if (currentMember?.email_notification_prefs) {
      setEmailNotifPrefs(currentMember.email_notification_prefs);
    }
    if (currentMember?.email_notifications_enabled !== undefined) {
      setEmailEnabled(currentMember.email_notifications_enabled);
    }
    if (currentMember?.timezone) {
      setTimezone(currentMember.timezone);
    }
  }, [currentMember?.id]);

  // Check if any SMTP accounts are configured
  useEffect(() => {
    fetch('/api/smtp').then(res => res.ok ? res.json() : null).then((data) => {
      const accounts = data?.accounts;
      setHasSmtp(Array.isArray(accounts) && accounts.length > 0);
    }).catch(() => setHasSmtp(false));
  }, []);

  const handleToggleNotif = (category: NotificationCategory) => {
    if (!teamMemberId) return;
    const isCurrentlyEnabled = notifPrefs[category] !== false;
    const newPrefs = { ...notifPrefs };
    if (isCurrentlyEnabled) {
      newPrefs[category] = false;
    } else {
      delete newPrefs[category];
    }
    setNotifPrefs(newPrefs);
    updateTeamMember(teamMemberId, { notification_prefs: newPrefs });
    toast('success', isCurrentlyEnabled ? 'Notification disabled' : 'Notification enabled');
  };

  const handleToggleEmailEnabled = () => {
    if (!teamMemberId || hasSmtp === false) return;
    const newValue = !emailEnabled;
    setEmailEnabled(newValue);
    updateTeamMember(teamMemberId, { email_notifications_enabled: newValue });
    toast('success', newValue ? 'Email notifications enabled' : 'Email notifications disabled');
  };

  const handleToggleEmailNotif = (category: NotificationCategory) => {
    if (!teamMemberId || !emailEnabled) return;
    const isCurrentlyEnabled = emailNotifPrefs[category] === true;
    const newPrefs = { ...emailNotifPrefs };
    if (isCurrentlyEnabled) {
      delete newPrefs[category];
    } else {
      newPrefs[category] = true;
    }
    setEmailNotifPrefs(newPrefs);
    updateTeamMember(teamMemberId, { email_notification_prefs: newPrefs });
    toast('success', isCurrentlyEnabled ? 'Email notification disabled' : 'Email notification enabled');
  };

  const handleTimezoneChange = (tz: string) => {
    if (!teamMemberId) return;
    setTimezone(tz);
    setTzDropdownOpen(false);
    setTzSearch('');
    updateTeamMember(teamMemberId, { timezone: tz });
    toast('success', `Timezone set to ${tz}`);
  };

  // Close timezone dropdown when clicking outside
  const tzRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!tzDropdownOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (tzRef.current && !tzRef.current.contains(e.target as Node)) {
        setTzDropdownOpen(false);
        setTzSearch('');
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [tzDropdownOpen]);

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
        body: JSON.stringify({ team_member_id: teamMemberId, new_email: userEmail.trim().toLowerCase() }),
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

      const result = await addApiKey(keyName.trim(), keyHash, keyPrefix, keyPermissions, teamMemberId);
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
            <div className="p-2 bg-brand-50 rounded-lg">
              <User className="text-brand-600" size={20} />
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
            <div className="min-w-0 flex-1">
              <p className="font-medium text-zinc-900 truncate">{userName || 'Your Name'}</p>
              <p className="text-sm text-zinc-500 truncate">{userEmail || 'your@email.com'}</p>
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
              onChange={(e) => { setUserEmail(e.target.value); setEmailError(''); }}
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

        {/* Timezone Section */}
        <section className={`rounded-xl border p-4 lg:p-6 ${
          timezone === 'UTC' ? 'bg-amber-50/50 border-amber-300' : 'bg-white border-zinc-200'
        }`}>
          <div className="flex items-center gap-3 mb-4">
            <div className={`p-2 rounded-lg ${timezone === 'UTC' ? 'bg-amber-100' : 'bg-emerald-50'}`}>
              <Globe className={timezone === 'UTC' ? 'text-amber-600' : 'text-emerald-600'} size={20} />
            </div>
            <div className="flex-1">
              <h2 className="font-semibold text-zinc-900">Timezone</h2>
              <p className="text-sm text-zinc-500">All times in the app will be shown in this timezone</p>
            </div>
          </div>

          {timezone === 'UTC' && (
            <div className="flex items-start gap-2.5 mb-4 px-3 py-2.5 bg-amber-100/70 border border-amber-200 rounded-lg">
              <span className="text-amber-600 mt-0.5 flex-shrink-0">&#9888;</span>
              <p className="text-sm text-amber-800">
                Your timezone is set to <span className="font-semibold">UTC</span>. Times may appear incorrect. Select your local timezone below so all dates and times display accurately.
              </p>
            </div>
          )}

          <div className="relative" ref={tzRef}>
            <button
              type="button"
              onClick={() => setTzDropdownOpen(!tzDropdownOpen)}
              className={`w-full md:w-96 flex items-center justify-between px-3 py-2 text-sm border rounded-lg hover:border-zinc-300 transition-colors text-left ${
                timezone === 'UTC' ? 'bg-white border-amber-300' : 'bg-white border-zinc-200'
              }`}
            >
              <span className="text-zinc-900">{timezone.replace(/_/g, ' ')}</span>
              <span className="text-zinc-400 text-xs font-mono">
                {tzEntries.find(e => e.id === timezone)?.label || 'UTC+0'}
              </span>
            </button>

            {tzDropdownOpen && (
              <div className="absolute z-50 mt-1 w-full md:w-96 bg-white border border-zinc-200 rounded-lg shadow-lg">
                <div className="p-2 border-b border-zinc-100">
                  <input
                    type="text"
                    value={tzSearch}
                    onChange={e => setTzSearch(e.target.value)}
                    placeholder="Search timezones or offset (e.g. UTC-7)..."
                    className="w-full px-3 py-1.5 text-sm bg-zinc-50 border border-zinc-200 rounded-md outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-100"
                    autoFocus
                  />
                </div>
                <div className="max-h-72 overflow-y-auto">
                  {filteredTzEntries.length === 0 ? (
                    <p className="px-3 py-2 text-sm text-zinc-400">No matching timezones</p>
                  ) : (
                    filteredTzEntries.map(group => (
                      <div key={group.label}>
                        <div className="sticky top-0 bg-zinc-50 px-3 py-1 text-[11px] font-semibold text-zinc-400 uppercase tracking-wide font-mono border-b border-zinc-100">
                          {group.label}
                        </div>
                        {group.items.map(entry => (
                          <button
                            key={entry.id}
                            onClick={() => handleTimezoneChange(entry.id)}
                            className={`w-full text-left px-3 py-1.5 text-sm hover:bg-zinc-50 transition-colors flex items-center justify-between ${
                              entry.id === timezone ? 'text-brand-600 font-medium bg-brand-50/50' : 'text-zinc-700'
                            }`}
                          >
                            <span>{entry.id.replace(/_/g, ' ')}</span>
                            {entry.id === timezone && <Check size={14} className="text-brand-600 flex-shrink-0" />}
                          </button>
                        ))}
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        </section>

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

        {/* Notification Preferences Section */}
        <section className="bg-white rounded-xl border border-zinc-200 p-4 lg:p-6">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 bg-blue-50 rounded-lg">
              <Bell className="text-blue-600" size={20} />
            </div>
            <div>
              <h2 className="font-semibold text-zinc-900">Notification Preferences</h2>
              <p className="text-sm text-zinc-500">Choose which notifications you receive</p>
            </div>
          </div>

          {/* Email master toggle */}
          <div className={`flex items-center justify-between p-3 mb-6 rounded-lg border ${hasSmtp === false ? 'bg-zinc-50/50 border-zinc-100 opacity-60' : 'bg-zinc-50 border-zinc-200'}`}>
            <div className="flex items-center gap-3">
              <Mail className="text-zinc-500" size={18} />
              <div>
                <p className="text-sm font-medium text-zinc-700">Email notifications</p>
                <p className="text-xs text-zinc-500">
                  {hasSmtp === false
                    ? 'Configure an SMTP account below to enable email notifications.'
                    : 'Receive email alerts for important updates.'}
                </p>
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={emailEnabled}
              disabled={hasSmtp === false}
              onClick={handleToggleEmailEnabled}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors flex-shrink-0 ${
                hasSmtp === false
                  ? 'bg-zinc-100 cursor-not-allowed'
                  : emailEnabled ? 'bg-teal-600' : 'bg-zinc-200'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  emailEnabled && hasSmtp !== false ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>

          <div className="space-y-6">
            {NOTIF_GROUPS.filter(g => {
              if (g.agentOnly && process.env.NEXT_PUBLIC_ENABLE_AGENTS !== 'true') return false;
              if (g.adminOnly && !isAdmin) return false;
              return true;
            }).map(({ group, items }) => (
              <div key={group}>
                {/* Group header with column labels */}
                <div className="flex items-center justify-between mb-3">
                  <p className="text-xs font-medium text-zinc-400 uppercase tracking-wide">{group}</p>
                  <div className="flex items-center gap-3">
                    <span className="text-[10px] font-medium text-zinc-400 uppercase tracking-wide w-11 text-center">In-App</span>
                    <span className={`text-[10px] font-medium uppercase tracking-wide w-11 text-center ${emailEnabled && hasSmtp !== false ? 'text-zinc-400' : 'text-zinc-300'}`}>Email</span>
                  </div>
                </div>
                <div className="space-y-3">
                  {items.map(({ key, label, desc }) => {
                    const inAppEnabled = notifPrefs[key] !== false;
                    const emailCatEnabled = emailNotifPrefs[key] === true;
                    return (
                      <div key={key} className="flex items-center justify-between">
                        <div className="min-w-0 flex-1 mr-4">
                          <p className="text-sm text-zinc-700">{label}</p>
                          <p className="text-xs text-zinc-500 mt-0.5">{desc}</p>
                        </div>
                        <div className="flex items-center gap-3 flex-shrink-0">
                          {/* In-App toggle */}
                          <button
                            type="button"
                            role="switch"
                            aria-checked={inAppEnabled}
                            aria-label={`${label} in-app notification`}
                            onClick={() => handleToggleNotif(key)}
                            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                              inAppEnabled ? 'bg-blue-500' : 'bg-zinc-200'
                            }`}
                          >
                            <span
                              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                                inAppEnabled ? 'translate-x-6' : 'translate-x-1'
                              }`}
                            />
                          </button>
                          {/* Email toggle */}
                          <button
                            type="button"
                            role="switch"
                            aria-checked={emailCatEnabled}
                            aria-label={`${label} email notification`}
                            disabled={!emailEnabled}
                            onClick={() => handleToggleEmailNotif(key)}
                            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                              !emailEnabled
                                ? 'bg-zinc-100 cursor-not-allowed'
                                : emailCatEnabled
                                  ? 'bg-teal-600'
                                  : 'bg-zinc-200'
                            }`}
                          >
                            <span
                              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                                emailCatEnabled && emailEnabled ? 'translate-x-6' : 'translate-x-1'
                              }`}
                            />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* API Keys Section — admin and agent only */}
        {(isAdmin || currentMember?.role === 'agent') && !isDemoMode && (
          <section className="bg-white rounded-xl border border-zinc-200 p-4 lg:p-6">
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-violet-50 rounded-lg">
                  <Key className="text-violet-600" size={20} />
                </div>
                <div>
                  <h2 className="font-semibold text-zinc-900">API Keys</h2>
                  <p className="text-sm text-zinc-500 hidden sm:block">Manage keys for external integrations</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Link href="/api/docs">
                  <Button size="sm" variant="secondary" icon={<BookOpen size={14} />}>
                    Docs
                  </Button>
                </Link>
                {!showKeyForm && !revealedKey && (
                  <Button
                    size="sm"
                    onClick={() => setShowKeyForm(true)}
                    icon={<Plus size={14} />}
                  >
                    <span className="sm:hidden">New</span>
                    <span className="hidden sm:inline">Generate New Key</span>
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
                          ? 'bg-brand-50 border-brand-200 text-brand-700'
                          : 'bg-white border-zinc-200 text-zinc-600 hover:border-zinc-300'
                      }`}
                    >
                      Full Access
                    </button>
                    <button
                      onClick={() => setKeyPermissions('read_only')}
                      className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
                        keyPermissions === 'read_only'
                          ? 'bg-brand-50 border-brand-200 text-brand-700'
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
                  <div key={key.id} className="px-4 py-3">
                    <div className="flex items-start gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium text-zinc-900 truncate">{key.name}</p>
                          <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0 ${
                            key.permissions === 'full'
                              ? 'bg-brand-50 text-brand-600'
                              : 'bg-zinc-100 text-zinc-500'
                          }`}>
                            {key.permissions === 'full' ? 'Full' : 'Read Only'}
                          </span>
                        </div>
                        <code className="text-xs text-zinc-500 font-mono mt-0.5 block">{key.key_prefix}...****</code>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-xs text-zinc-400">Last used: {formatRelativeTime(key.last_used_at)}</span>
                          {key.team_member_id && (() => {
                            const linked = team.find(m => m.id === key.team_member_id);
                            return linked ? (
                              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-violet-50 text-violet-600">
                                {linked.name}
                              </span>
                            ) : null;
                          })()}
                        </div>
                      </div>
                      <Tooltip content="Revoke key">
                        <button
                          onClick={() => setRevokeTarget(key)}
                          className="p-1.5 text-zinc-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors flex-shrink-0"
                        >
                          <Ban size={14} />
                        </button>
                      </Tooltip>
                    </div>
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

        {/* SMTP Email Section — admin only, hidden in demo mode */}
        {isAdmin && !isDemoMode && <SmtpSection />}

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
    </div>
  );
}
