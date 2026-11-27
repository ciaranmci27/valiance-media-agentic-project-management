'use client';

import { updateDelivers } from '@/lib/notification-defaults';

import { Bell, Mail, MessageCircle, Zap } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { isModuleEnabled } from '@/lib/access-control';
import { peekRead, setReadData, useRead } from '@/lib/query-cache';
import { notificationPreferencesRead } from '@/lib/reads';
import { sendJson } from '@/lib/needs-you-actions';
import { demoUpdateNotificationPreferences } from '@/lib/demo-notifications';
import { AI_SECTION_HREFS } from '@/lib/ai-home';
import { Toggle } from '@/components/ui/inputs/Toggle';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { toast } from '@/components/ui/Toast';
import { GroupLabel } from '@/components/projects/TabLayout';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import type { NotificationPreferencesPatch, NotificationPreferencesView } from '@/lib/api/notification-preferences';
import type { DeliveryKey } from '@/lib/notification-defaults';
import type { NotificationCategory } from '@/lib/types';
import type { ModuleId } from '@/lib/modules/registry';

/**
 * The module each category belongs to; one missing here is core. A category
 * of a switched-off module has nothing to notify about, so its row is hidden,
 * and a group left with no rows goes with it. Stored choices stay as they are.
 */
const CATEGORY_MODULE: Partial<Record<NotificationCategory, ModuleId>> = {
  project_contacts: 'contacts',
  portal_settings: 'portal',
  portal_updates: 'portal',
  time_entries: 'time',
  invoice_drafts: 'billing',
  contact_created: 'contacts',
  contact_deleted: 'contacts',
  contact_updates: 'contacts',
  lead_created: 'sales',
  lead_deleted: 'sales',
  lead_status: 'sales',
  lead_updates: 'sales',
  lead_interactions: 'sales',
  lead_proposals: 'sales',
  lead_contacts: 'sales',
  lead_conversions: 'sales',
  agent_suggestions: 'agents',
  agent_goals: 'agents',
  agent_autonomous: 'agents',
  agent_activity: 'agents',
};

const NOTIF_GROUPS: {
  group: string;
  adminOnly?: boolean;
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
        desc: 'A task moves to In progress, Done or another status',
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

type Channel = 'in_app' | 'email' | 'chat';

/** A change shown at once, saved, and put back if the server refuses. */
function useSaveChoice() {
  const { isDemoMode } = useDemo();
  return async (patch: NotificationPreferencesPatch, words: string) => {
    const read = notificationPreferencesRead(isDemoMode);
    const before = peekRead(read);
    if (before) {
      setReadData(read, () => ({
        ...before,
        in_app: { ...before.in_app, ...(patch.in_app ?? {}) },
        email: { ...before.email, ...(patch.email ?? {}) },
        chat: { ...before.chat, ...(patch.chat ?? {}) },
        email_enabled: patch.email_enabled ?? before.email_enabled,
        chat_enabled: patch.chat_enabled ?? before.chat_enabled,
      }));
    }
    try {
      const after = isDemoMode
        ? demoUpdateNotificationPreferences(patch)
        : await sendJson<NotificationPreferencesView>('/api/workspace/notification-preferences', patch, 'PATCH');
      setReadData(read, () => after);
      toast('success', words);
    } catch (error) {
      if (before) setReadData(read, () => before);
      toast('error', error instanceof Error && error.message ? error.message : 'Could not save that');
    }
  };
}

/**
 * Settings > Notifications: everything shows in the app; each person chooses
 * what also reaches them by email or in their own chat. Needs you (questions,
 * approvals, stuck agents) leads, on for both by default once a channel is
 * on; then each kind of update. Switches save at once (Rule 8).
 */
export function NotificationPreferencesSection({ canManageAgents }: { canManageAgents: boolean }) {
  const { access } = useAuth();
  const { isDemoMode } = useDemo();
  const prefs = useRead(notificationPreferencesRead(isDemoMode));
  const save = useSaveChoice();

  if (prefs.failed) {
    return <EmptyState framed variant="error" title="Could not load your notification settings" description="Check your connection, then try again." onRetry={prefs.reload} />;
  }
  const view = prefs.data;
  if (!view) {
    return <div className="glass-card h-64 animate-pulse rounded-xl motion-reduce:animate-none" role="status" aria-label="Loading notification settings" />;
  }

  const emailOn = view.email_enabled && view.email_available;
  const chatOn = view.chat_enabled && view.chat_available;
  const flip = (channel: Channel, key: DeliveryKey, label: string) => {
    const now = channel === 'in_app' ? view.in_app[key as NotificationCategory] : view[channel][key];
    const where = channel === 'in_app' ? 'in the app' : channel === 'email' ? 'by email' : 'in chat';
    void save({ [channel]: { [key]: !now } } as NotificationPreferencesPatch, `${label} ${now ? 'off' : 'on'} ${where}`);
  };
  const groups = NOTIF_GROUPS.filter((g) => !g.adminOnly || canManageAgents).map((g) => ({
    ...g,
    items: g.items.filter(({ key }) => {
      const mod = CATEGORY_MODULE[key];
      return !mod || isModuleEnabled(access, mod);
    }),
  })).filter((g) => g.items.length > 0);

  const columns = (
    <div className="flex flex-shrink-0 items-center gap-3 text-[11px] text-zinc-500" aria-hidden="true">
      <span className="w-11 text-center">App</span>
      <span className={`w-11 text-center ${emailOn ? '' : 'text-zinc-600'}`}>Email</span>
      <span className={`w-11 text-center ${chatOn ? '' : 'text-zinc-600'}`}>Chat</span>
    </div>
  );

  return (
    <div className="space-y-6">
      <section id="notifications" className="glass-card scroll-mt-6 rounded-xl p-4 lg:p-5">
        <SettingsSectionHeader icon={Bell} title="How you hear" description="Everything shows here in the app. Choose what also reaches you by email or in your chat." />
        <div className="divide-y divide-white/[0.06]">
          <ChannelRow
            icon={<Mail size={16} />}
            title="Email"
            line={view.email_available ? 'To the address you sign in with.' : 'Email sending is not set up yet. An Owner sets it up in Settings > Email.'}
            checked={emailOn}
            disabled={!view.email_available}
            onChange={() => void save({ email_enabled: !view.email_enabled }, view.email_enabled ? 'Email notifications off' : 'Email notifications on')}
          />
          <ChannelRow
            icon={<MessageCircle size={16} />}
            title="Chat"
            line={view.chat_available
              ? 'A message from your workspace bot on your linked account, with a link back here.'
              : 'Link a chat account first, so the bot can reach you.'}
            action={view.chat_available ? undefined : <Button size="sm" variant="secondary" href={AI_SECTION_HREFS['chat-accounts']}>Link an account</Button>}
            checked={chatOn}
            disabled={!view.chat_available}
            onChange={() => void save({ chat_enabled: !view.chat_enabled }, view.chat_enabled ? 'Chat notifications off' : 'Chat notifications on')}
          />
        </div>
      </section>

      <section className="glass-card rounded-xl p-4 lg:p-5" aria-labelledby="needs-you-delivery">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-amber-500/[0.14] text-amber-300"><Zap size={16} aria-hidden="true" /></span>
          <div className="min-w-0">
            <p id="needs-you-delivery" className="text-sm font-semibold text-white">Needs you</p>
            <p className="mt-0.5 text-xs text-zinc-400">Questions, approvals and agents stuck on your work. Always in the app; on by email and chat once those are on.</p>
          </div>
        </div>
        <div className="mt-4 flex justify-end">{columns}</div>
        <div className="mt-2 flex items-center justify-between gap-4">
          <p className="min-w-0 text-sm text-zinc-300">Everything waiting on you</p>
          <div className="flex flex-shrink-0 items-center gap-3">
            {/* Always on in the app: shown as an on switch that cannot be turned off. */}
            <span className="flex w-11 justify-center"><Toggle checked disabled onChange={() => undefined} aria-label="Needs you in the app, always on" /></span>
            <span className="flex w-11 justify-center">
              <Toggle checked={emailOn && view.email.needs_you} disabled={!emailOn} onChange={() => flip('email', 'needs_you', 'Needs you')} aria-label="Needs you by email" />
            </span>
            <span className="flex w-11 justify-center">
              <Toggle checked={chatOn && view.chat.needs_you} disabled={!chatOn} onChange={() => flip('chat', 'needs_you', 'Needs you')} aria-label="Needs you in chat" />
            </span>
          </div>
        </div>
      </section>

      <section className="glass-card rounded-xl p-4 lg:p-5" aria-labelledby="updates-delivery">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p id="updates-delivery" className="text-sm font-semibold text-white">Updates</p>
            <p className="mt-0.5 text-xs text-zinc-400">What happened on your work, by kind.</p>
          </div>
          {columns}
        </div>
        <div className="space-y-6">
          {groups.map(({ group, items }) => (
            <div key={group}>
              <GroupLabel as="h3" className="mb-2">{group}</GroupLabel>
              <div className="divide-y divide-white/[0.06]">
                {items.map(({ key, label, desc }) => (
                  <div key={key} className="flex items-center justify-between gap-4 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-zinc-300">{label}</p>
                      <p className="mt-0.5 text-xs text-zinc-400">{view.in_app[key] ? desc : 'Off in the app, so it is not sent anywhere.'}</p>
                    </div>
                    <div className="flex flex-shrink-0 items-center gap-3">
                      <span className="flex w-11 justify-center"><Toggle checked={view.in_app[key]} onChange={() => flip('in_app', key, label)} aria-label={`${label} in the app`} /></span>
                      <span className="flex w-11 justify-center"><Toggle checked={updateDelivers({ inApp: view.in_app[key], channelOn: emailOn, choice: view.email[key] })} disabled={!emailOn || !view.in_app[key]} onChange={() => flip('email', key, label)} aria-label={`${label} by email`} /></span>
                      <span className="flex w-11 justify-center"><Toggle checked={updateDelivers({ inApp: view.in_app[key], channelOn: chatOn, choice: view.chat[key] })} disabled={!chatOn || !view.in_app[key]} onChange={() => flip('chat', key, label)} aria-label={`${label} in chat`} /></span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

/** One way to hear: what it is, where it goes (or the step to set it up), and its switch. */
function ChannelRow({ icon, title, line, action, checked, disabled, onChange }: {
  icon: React.ReactNode; title: string; line: string; action?: React.ReactNode; checked: boolean; disabled: boolean; onChange: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
      <div className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-white/[0.06] text-zinc-300" aria-hidden="true">{icon}</span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-zinc-200">{title}</p>
          <p className="mt-0.5 text-xs text-zinc-400">{line}</p>
          {action && <div className="mt-2">{action}</div>}
        </div>
      </div>
      <Toggle checked={checked} disabled={disabled} onChange={onChange} aria-label={`${title} notifications`} />
    </div>
  );
}
