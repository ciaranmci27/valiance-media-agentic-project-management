'use client';

import { useEffect, useState } from 'react';
import { Bell, Mail } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { Toggle } from '@/components/ui/inputs/Toggle';
import { toast } from '@/components/ui/Toast';
import { emailCategoryEnabled } from '@/lib/notification-defaults';
import type { NotificationCategory, NotificationPreferences } from '@/lib/types';

const NOTIF_GROUPS: {
  group: string;
  adminOnly?: boolean;
  agentOnly?: boolean;
  items: { key: NotificationCategory; label: string; desc: string }[];
}[] = [
  {
    group: 'Tasks',
    items: [
      { key: 'task_created', label: 'Task created', desc: 'A new task is created' },
      { key: 'task_deleted', label: 'Task deleted', desc: 'A task is deleted' },
      {
        key: 'task_status',
        label: 'Status changes',
        desc: 'Task moved to In Progress, Done, etc.',
      },
      { key: 'task_assignments', label: 'Assignments', desc: 'Someone is assigned to a task' },
      {
        key: 'task_updates',
        label: 'General updates',
        desc: 'Priority, title, and other task changes',
      },
      { key: 'task_subtasks', label: 'Subtasks', desc: 'Subtasks added, completed, or removed' },
      { key: 'task_comments', label: 'Comments', desc: 'Comments added, edited, or removed' },
    ],
  },
  {
    group: 'Projects',
    items: [
      { key: 'project_created', label: 'Project created', desc: 'A new project is created' },
      {
        key: 'project_deleted',
        label: 'Project archived',
        desc: 'A project is archived or deleted',
      },
      { key: 'project_updates', label: 'Project updates', desc: 'Project details changed' },
      { key: 'project_contacts', label: 'Project contacts', desc: 'Contacts linked or removed' },
      {
        key: 'portal_settings',
        label: 'Portal settings',
        desc: 'Portal enabled, disabled, or configured',
      },
      {
        key: 'portal_updates',
        label: 'Portal updates',
        desc: 'Timeline updates posted, edited, or removed',
      },
      {
        key: 'time_entries',
        label: 'Time tracking',
        desc: 'Time entries logged, updated, or deleted',
      },
      {
        key: 'invoice_drafts',
        label: 'Invoice drafts',
        desc: 'An invoice was drafted for you to review and send (retainers and scheduled hours). Email is a morning summary.',
      },
      {
        key: 'entity_files',
        label: 'File attachments',
        desc: 'Files attached or removed from entities',
      },
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
      { key: 'api_keys', label: 'API keys', desc: 'API keys created, edited or revoked' },
    ],
  },
  {
    group: 'Leads',
    items: [
      { key: 'lead_created', label: 'Lead created', desc: 'A new lead is created' },
      { key: 'lead_deleted', label: 'Lead archived', desc: 'A lead is archived or deleted' },
      { key: 'lead_status', label: 'Status changes', desc: 'Lead moved between pipeline stages' },
      { key: 'lead_updates', label: 'General updates', desc: 'Field changes and detail updates' },
      {
        key: 'lead_interactions',
        label: 'Interactions',
        desc: 'Calls, emails, meetings added or updated',
      },
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
      {
        key: 'agent_suggestions' as NotificationCategory,
        label: 'Suggestions',
        desc: 'AI agent submits or resubmits suggestions',
      },
      {
        key: 'agent_goals' as NotificationCategory,
        label: 'Goals',
        desc: 'Agent goals created, updated, or archived',
      },
      {
        key: 'agent_autonomous' as NotificationCategory,
        label: 'Autonomous toggle',
        desc: 'Autonomous agents enabled or disabled on a project',
      },
      {
        key: 'agent_activity' as NotificationCategory,
        label: 'Activity',
        desc: 'General AI agent activity and status updates',
      },
    ],
  },
];

/** In-app and email toggles per notification category, plus the email master switch. */
export function NotificationPreferencesSection({ canManageAgents }: { canManageAgents: boolean }) {
  const { team, updateTeamMember } = useApp();
  const { teamMemberId } = useAuth();
  const currentMember = team.find((m) => m.id === teamMemberId);

  const [notifPrefs, setNotifPrefs] = useState<NotificationPreferences>({});
  const [emailEnabled, setEmailEnabled] = useState(false);
  const [emailNotifPrefs, setEmailNotifPrefs] = useState<NotificationPreferences>({});
  const [hasSmtp, setHasSmtp] = useState<boolean | null>(null);

  // Hydrate once per member, so a store refresh never overwrites a toggle mid-flight.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentMember?.id]);

  // Check if any SMTP accounts are configured. Uses the status endpoint
  // (member-accessible) rather than /api/smtp, which is admin-only.
  useEffect(() => {
    fetch('/api/smtp/status')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        setHasSmtp(data?.hasAccounts === true);
      })
      .catch(() => setHasSmtp(false));
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
    const isCurrentlyEnabled = emailCategoryEnabled(emailNotifPrefs, category);
    // Explicit either way: some categories are on by default, so "absent"
    // no longer means off for all of them.
    const newPrefs = { ...emailNotifPrefs, [category]: !isCurrentlyEnabled };
    setEmailNotifPrefs(newPrefs);
    updateTeamMember(teamMemberId, { email_notification_prefs: newPrefs });
    toast(
      'success',
      isCurrentlyEnabled ? 'Email notification disabled' : 'Email notification enabled',
    );
  };

  return (
    <section id="notifications" className="glass-card rounded-xl p-4 lg:p-6 scroll-mt-6">
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2 bg-brand-500/15 rounded-lg">
          <Bell className="text-brand-300" size={20} />
        </div>
        <div>
          <h2 className="font-semibold text-white">Notification Preferences</h2>
          <p className="text-sm text-zinc-400">Choose which notifications you receive</p>
        </div>
      </div>

      {/* Email master toggle */}
      <div
        className={`flex items-center justify-between p-3 mb-6 rounded-lg border ${hasSmtp === false ? 'bg-white/[0.03] border-white/[0.06] opacity-60' : 'bg-white/[0.03] border-white/[0.08]'}`}
      >
        <div className="flex items-center gap-3">
          <Mail className="text-zinc-400" size={18} />
          <div>
            <p className="text-sm font-medium text-zinc-300">Email notifications</p>
            <p className="text-xs text-zinc-400">
              {hasSmtp === false
                ? 'Configure an SMTP account in Email settings to enable email notifications.'
                : 'Receive email alerts for important updates.'}
            </p>
          </div>
        </div>
        <Toggle
          checked={emailEnabled && hasSmtp !== false}
          disabled={hasSmtp === false}
          onChange={handleToggleEmailEnabled}
          aria-label="Email notifications"
        />
      </div>

      <div className="space-y-6">
        {NOTIF_GROUPS.filter((g) => {
          if (g.agentOnly && process.env.NEXT_PUBLIC_ENABLE_AGENTS !== 'true') return false;
          if (g.adminOnly && !canManageAgents) return false;
          return true;
        }).map(({ group, items }) => (
          <div key={group}>
            {/* Group header with column labels */}
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs font-medium text-zinc-500 uppercase tracking-wide">
                {group}
              </p>
              <div className="flex items-center gap-3">
                <span className="text-[10px] font-medium text-zinc-500 uppercase tracking-wide w-11 text-center">
                  In-App
                </span>
                <span
                  className={`text-[10px] font-medium uppercase tracking-wide w-11 text-center ${emailEnabled && hasSmtp !== false ? 'text-zinc-500' : 'text-zinc-600'}`}
                >
                  Email
                </span>
              </div>
            </div>
            <div className="space-y-3">
              {items.map(({ key, label, desc }) => {
                const inAppEnabled = notifPrefs[key] !== false;
                const emailCatEnabled = emailCategoryEnabled(emailNotifPrefs, key);
                return (
                  <div key={key} className="flex items-center justify-between">
                    <div className="min-w-0 flex-1 mr-4">
                      <p className="text-sm text-zinc-300">{label}</p>
                      <p className="text-xs text-zinc-400 mt-0.5">{desc}</p>
                    </div>
                    <div className="flex items-center gap-3 flex-shrink-0">
                      {/* In-App toggle */}
                      <Toggle
                        checked={inAppEnabled}
                        onChange={() => handleToggleNotif(key)}
                        aria-label={`${label} in-app notification`}
                      />
                      {/* Email toggle */}
                      <Toggle
                        checked={emailCatEnabled && emailEnabled}
                        disabled={!emailEnabled}
                        onChange={() => handleToggleEmailNotif(key)}
                        aria-label={`${label} email notification`}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
