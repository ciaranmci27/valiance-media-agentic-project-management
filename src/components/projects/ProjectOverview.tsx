'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
  ArrowRight, Bell, CircleDot, Clock, Copy, Eye, Globe, Info, Mail, Receipt, Users,
} from 'lucide-react';
import { useApp } from '@/lib/store';
import { useDemo } from '@/lib/demo-context';
import { createClient } from '@/lib/supabase/client';
import { fetchBillingForecast } from '@/lib/supabase/queries';
import { compareReminders, nextReminderFor, reminderGroup, whenLabel } from '@/lib/reminders';
import { invoiceOutstanding } from '@/lib/invoice-payments';
import { computeInvoiceSummary } from '@/lib/invoice-summary';
import { getWorkedHours } from '@/lib/time-entry-utils';
import { parseDateOnly } from '@/lib/date-utils';
import { inboxClient } from '@/lib/inbound-email/inbox-client';
import type { InboxThreadSummary } from '@/lib/inbound-email/inbox-types';
import { useInboxUpdates } from '@/components/inbox/use-inbox-updates';
import { formatListTime } from '@/components/inbox/inbox-badges';
import { ReminderRow } from '@/components/reminders/ReminderRow';
import { ActivityTimeline } from '@/components/agent/ActivityTimeline';
import { Avatar, AvatarGroup } from '@/components/ui/Avatar';
import { PriorityBadge, StatusBadge } from '@/components/ui/Badge';
import { DateInput } from '@/components/ui/inputs/DateInput';
import { toast } from '@/components/ui/Toast';
import type { BillingForecastItem, Task, TeamMember } from '@/lib/types';

/** The tabs the Overview can send the viewer to. */
export type OverviewTarget = 'tasks' | 'time' | 'communication' | 'portal' | 'billing';

interface ProjectOverviewProps {
  projectId: string;
  onOpenTask: (taskId: string) => void;
  onOpenTab: (tab: OverviewTarget, view?: string) => void;
  onOpenContacts: () => void;
  /** Opens the project form (description, members and the rest). */
  onEditProject: () => void;
  can: {
    /** Edits the project's dates in place and opens the project form. */
    manageProject: boolean;
    time: boolean;
    inbox: boolean;
    invoices: boolean;
    portal: boolean;
    contacts: boolean;
  };
}

const IN_PROGRESS_LIMIT = 6;
const EMAIL_LIMIT = 5;

function formatMoney(value: number): string {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatHours(hours: number): string {
  return hours.toLocaleString('en-US', { maximumFractionDigits: 1 });
}

function shortDate(value: string): string {
  return parseDateOnly(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Monday 00:00 of this week, local time: the Time tab's "This week" boundary. */
function startOfWeek(now = new Date()): Date {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  return start;
}

function Card({ icon, title, action, children }: { icon: ReactNode; title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="glass-card rounded-xl overflow-hidden">
      <div className="px-5 py-4 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 font-semibold text-white">
          {icon}
          {title}
        </h2>
        {action}
      </div>
      <div className="px-5 pb-5">{children}</div>
    </section>
  );
}

function CardLink({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1 text-xs text-zinc-400 hover:text-brand-300 transition-colors rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
    >
      {children}
      <ArrowRight size={12} aria-hidden="true" />
    </button>
  );
}

function GroupLabel({ children }: { children: ReactNode }) {
  return <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500 mb-1.5">{children}</p>;
}

const ROW_CLASS = 'w-full flex items-center gap-3 px-2.5 py-2 -mx-2.5 rounded-lg text-left hover:bg-white/[0.04] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500';

/** One line in an Overview list: icon, title, a muted detail, and an end slot. */
function RowBody({ icon, title, detail, end }: { icon: ReactNode; title: string; detail?: ReactNode; end?: ReactNode }) {
  return (
    <>
      <span className="flex-shrink-0 text-zinc-500" aria-hidden="true">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-zinc-200 truncate">{title}</span>
        {detail && <span className="block text-xs text-zinc-500 truncate">{detail}</span>}
      </span>
      {end && <span className="flex-shrink-0 flex items-center gap-2">{end}</span>}
    </>
  );
}

// The Details card's dates edit in place, so they shed the input chrome.
const INLINE_DATE_CLASS = '!w-fit !justify-start !gap-1 !border-transparent !bg-transparent !shadow-none hover:!bg-white/[0.06] focus:!ring-0 focus:!border-transparent !px-1.5 !-mx-1.5 !py-0.5 !rounded-md';

const PERSON_CHIP = 'inline-flex items-center gap-1.5 max-w-full pl-1 pr-2.5 py-1 rounded-full bg-white/[0.04] border border-white/[0.06] text-sm text-zinc-200';

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'warn' }) {
  return (
    <div>
      <p className="text-xs text-zinc-500">{label}</p>
      <p className={`text-xl font-semibold tabular-nums ${tone === 'warn' ? 'text-amber-300' : 'text-white'}`}>{value}</p>
    </div>
  );
}

/**
 * The project at a glance: what needs the viewer now, what is moving, and a
 * rail of time, billing, portal and people. Every list links into the tab
 * that owns it, so the Overview stays a summary and never a second editor.
 */
export function ProjectOverview({ projectId, onOpenTask, onOpenTab, onOpenContacts, onEditProject, can }: ProjectOverviewProps) {
  const {
    getProject, getTasksByProject, getTeamMember, getContactsByProject, reminders, updateProject,
    getInvoicesByProject, getTimeEntriesByProject, getPortalSettings, getPortalUpdates,
  } = useApp();
  const { isDemoMode } = useDemo();
  const project = getProject(projectId);
  const tasks = getTasksByProject(projectId);

  // ── Needs you ──
  const dueReminders = reminders
    .filter(r => r.project_id === projectId && r.status === 'open' && ['overdue', 'today'].includes(reminderGroup(r)))
    .sort(compareReminders);
  // The project's own reminders (no task) that are not due yet. Shown under
  // Needs you as Later, never counted: a task's reminders already show as
  // its next step in In progress.
  const laterReminders = reminders
    .filter(r => r.project_id === projectId && r.task_id === null && r.status === 'open'
      && ['upcoming', 'no_date'].includes(reminderGroup(r)))
    .sort(compareReminders);
  const inReview = tasks.filter(t => t.status === 'in_review');

  const invoices = can.invoices ? getInvoicesByProject(projectId) : [];
  const taxRate = project?.tax_rate;
  const unpaid = invoices
    .filter(inv => (inv.status === 'sent' || inv.status === 'overdue') && invoiceOutstanding(inv, taxRate) > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  // The Billing tab's own totals, so Outstanding reads the same in both places.
  const billing = can.invoices
    ? computeInvoiceSummary(project, invoices, getTimeEntriesByProject(projectId))
    : null;

  // Client emails waiting on a person. Fetched, as the inbox is, and refreshed
  // on the same realtime ping the inbox listens to.
  const [emails, setEmails] = useState<{ threads: InboxThreadSummary[]; total: number } | null>(null);
  const loadEmails = useCallback(() => {
    if (!can.inbox) return;
    inboxClient(isDemoMode)
      .listThreads({ inboxId: null, projectId, tab: 'needs_you', search: '', limit: EMAIL_LIMIT, offset: 0 })
      .then(data => setEmails({ threads: data.threads, total: data.counts.needs_you }))
      .catch(() => setEmails(null));
  }, [can.inbox, isDemoMode, projectId]);
  useEffect(() => { loadEmails(); }, [loadEmails]);
  useInboxUpdates(loadEmails);

  const emailThreads = emails?.threads ?? [];
  const needsYouCount = dueReminders.length + inReview.length + (emails?.total ?? 0) + unpaid.length;

  // ── Details ──
  const doneCount = tasks.filter(t => t.status === 'done').length;
  const progressPercent = tasks.length > 0 ? Math.round((doneCount / tasks.length) * 100) : 0;

  // ── In progress ──
  const inProgress = tasks
    .filter(t => t.status === 'in_progress')
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));

  // ── Time ──
  // Finished sessions only, as the Time tab counts them, so the two agree.
  const timeStats = useMemo(() => {
    if (!can.time) return null;
    const entries = getTimeEntriesByProject(projectId).filter(e => e.end_time !== null);
    const weekStart = startOfWeek().getTime();
    let total = 0;
    let week = 0;
    for (const entry of entries) {
      const hours = getWorkedHours(entry);
      total += hours;
      if (new Date(entry.start_time).getTime() >= weekStart) week += hours;
    }
    return { total, week };
  }, [can.time, getTimeEntriesByProject, projectId]);

  // ── Next invoice draft (same read the Billing tab's banner uses) ──
  const [nextDraft, setNextDraft] = useState<BillingForecastItem | null>(null);
  useEffect(() => {
    if (!can.invoices || isDemoMode) return;
    let cancelled = false;
    const until = new Date();
    until.setDate(until.getDate() + 62);
    fetchBillingForecast(createClient(), projectId, { until: until.toISOString().slice(0, 10) })
      .then(forecast => { if (!cancelled) setNextDraft(forecast.find(item => item.status === 'upcoming') ?? null); })
      .catch(() => { if (!cancelled) setNextDraft(null); });
    return () => { cancelled = true; };
  }, [can.invoices, isDemoMode, projectId]);

  // ── Portal ──
  const portal = can.portal ? getPortalSettings(projectId) : undefined;
  const portalUpdates = can.portal ? getPortalUpdates(projectId) : [];
  const lastUpdate = portalUpdates.reduce<string | null>(
    (latest, u) => (!latest || u.created_at > latest ? u.created_at : latest), null);
  const portalUrl = portal?.token && typeof window !== 'undefined'
    ? `${window.location.origin}/portal/${portal.token}`
    : '';

  const copyPortalLink = async () => {
    try {
      await navigator.clipboard.writeText(portalUrl);
      toast('success', 'Portal link copied');
    } catch {
      toast('error', 'Couldn\'t copy the link');
    }
  };

  // ── People ──
  const members = (project?.member_ids || []).map(id => getTeamMember(id)).filter(Boolean) as TeamMember[];
  const contacts = can.contacts ? getContactsByProject(projectId) : [];

  const assignees = (task: Task) =>
    task.assignee_ids.map(id => getTeamMember(id)).filter(Boolean) as TeamMember[];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
      <div className="lg:col-span-2 space-y-6 min-w-0">
        <Card
          icon={<Bell size={18} className="text-zinc-400" aria-hidden="true" />}
          title="Needs you"
          action={needsYouCount > 0 ? (
            <span className="text-xs font-mono tabular-nums text-zinc-400">{needsYouCount}</span>
          ) : undefined}
        >
          {needsYouCount === 0 ? (
            <p className="text-sm text-zinc-500">Nothing is waiting on you here.</p>
          ) : (
            <div className="space-y-4">
              {dueReminders.length > 0 && (
                <div>
                  <GroupLabel>Reminders due</GroupLabel>
                  <div className="-mx-2">
                    {dueReminders.map(r => (
                      <ReminderRow key={r.id} reminder={r} showContext withinProjectId={projectId} onOpenTask={onOpenTask} />
                    ))}
                  </div>
                </div>
              )}

              {emailThreads.length > 0 && (
                <div>
                  <GroupLabel>Client emails</GroupLabel>
                  {emailThreads.map(thread => (
                    <Link key={thread.id} href={`/inbox?thread=${thread.id}`} className={ROW_CLASS}>
                      <RowBody
                        icon={<Mail size={15} />}
                        title={thread.subject || '(no subject)'}
                        detail={thread.sender?.name || thread.sender?.address}
                        end={<span className="text-xs text-zinc-500">{formatListTime(thread.last_message_at)}</span>}
                      />
                    </Link>
                  ))}
                  {(emails?.total ?? 0) > emailThreads.length && (
                    <div className="mt-1.5">
                      <CardLink onClick={() => onOpenTab('communication', 'inbox')}>
                        {(emails?.total ?? 0) - emailThreads.length} more in Communication
                      </CardLink>
                    </div>
                  )}
                </div>
              )}

              {inReview.length > 0 && (
                <div>
                  <GroupLabel>Waiting for review</GroupLabel>
                  {inReview.map(task => (
                    <button key={task.id} type="button" onClick={() => onOpenTask(task.id)} className={ROW_CLASS}>
                      <RowBody icon={<Eye size={15} />} title={task.title} end={<PriorityBadge priority={task.priority} tooltip={false} />} />
                    </button>
                  ))}
                </div>
              )}

              {unpaid.length > 0 && (
                <div>
                  <GroupLabel>Unpaid invoices</GroupLabel>
                  {unpaid.map(inv => (
                    <button key={inv.id} type="button" onClick={() => onOpenTab('billing')} className={ROW_CLASS}>
                      <RowBody
                        icon={<Receipt size={15} />}
                        title={inv.invoice_number}
                        detail={inv.due_date ? `Due ${shortDate(inv.due_date)}` : `Sent ${shortDate(inv.date)}`}
                        end={
                          <span className={`text-sm tabular-nums ${inv.status === 'overdue' ? 'text-amber-300' : 'text-zinc-200'}`}>
                            {formatMoney(invoiceOutstanding(inv, taxRate))}
                          </span>
                        }
                      />
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {laterReminders.length > 0 && (
            <div className="mt-4">
              <GroupLabel>Later</GroupLabel>
              <div className="-mx-2">
                {laterReminders.map(r => (
                  <ReminderRow key={r.id} reminder={r} showContext withinProjectId={projectId} onOpenTask={onOpenTask} />
                ))}
              </div>
            </div>
          )}
        </Card>

        <Card
          icon={<CircleDot size={18} className="text-zinc-400" aria-hidden="true" />}
          title="In progress"
          action={<CardLink onClick={() => onOpenTab('tasks')}>Board</CardLink>}
        >
          {inProgress.length === 0 ? (
            <p className="text-sm text-zinc-500">Nothing is in progress right now.</p>
          ) : (
            <>
              {inProgress.slice(0, IN_PROGRESS_LIMIT).map(task => {
                const people = assignees(task);
                const next = nextReminderFor(reminders, task.id)?.next;
                const nextWhen = next ? whenLabel(next) : null;
                const nextOverdue = next ? reminderGroup(next) === 'overdue' : false;
                const due = task.due_date ? `Due ${shortDate(task.due_date)}` : null;
                return (
                  <button key={task.id} type="button" onClick={() => onOpenTask(task.id)} className={ROW_CLASS}>
                    <RowBody
                      icon={<CircleDot size={15} />}
                      title={task.title}
                      detail={next ? (
                        <>
                          Next: {next.title}
                          {nextWhen && <span className={nextOverdue ? 'text-red-400' : undefined}> · {nextOverdue ? `Overdue ${nextWhen}` : nextWhen}</span>}
                          {due && ` · ${due}`}
                        </>
                      ) : due ?? undefined}
                      end={
                        <>
                          <PriorityBadge priority={task.priority} tooltip={false} />
                          {people.length > 0 && (
                            <AvatarGroup users={people.map(m => ({ id: m.id, name: m.name, avatar: m.avatar }))} max={2} size="xs" />
                          )}
                        </>
                      }
                    />
                  </button>
                );
              })}
              {inProgress.length > IN_PROGRESS_LIMIT && (
                <div className="mt-1.5">
                  <CardLink onClick={() => onOpenTab('tasks')}>
                    {inProgress.length - IN_PROGRESS_LIMIT} more on the board
                  </CardLink>
                </div>
              )}
            </>
          )}
        </Card>

        <ActivityTimeline projectId={projectId} listMaxHeightClass="" />
      </div>

      <div className="space-y-6 min-w-0">
        <Card
          icon={<Info size={18} className="text-zinc-400" aria-hidden="true" />}
          title="Details"
          action={can.manageProject ? <CardLink onClick={onEditProject}>Edit</CardLink> : undefined}
        >
          <div className="space-y-4">
            {project?.description ? (
              <p className="text-sm text-zinc-300 leading-relaxed whitespace-pre-wrap break-words">{project.description}</p>
            ) : can.manageProject ? (
              <button
                type="button"
                onClick={onEditProject}
                className="text-sm text-zinc-500 hover:text-brand-300 transition-colors rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                Add a description
              </button>
            ) : null}
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-2.5 text-sm">
              <dt className="text-xs text-zinc-500">Status</dt>
              <dd><StatusBadge status={project?.status ?? 'active'} tooltip={false} /></dd>
              {(['start_date', 'due_date'] as const).map(field => (
                <div key={field} className="contents">
                  <dt className="text-xs text-zinc-500">{field === 'start_date' ? 'Start' : 'Due'}</dt>
                  <dd className="min-w-0">
                    {can.manageProject ? (
                      <DateInput
                        value={project?.[field] || ''}
                        onChange={(v) => updateProject(projectId, { [field]: v || null })}
                        placeholder="Not set"
                        ariaLabel={field === 'start_date' ? 'Start date' : 'Due date'}
                        size="sm"
                        clearable
                        minDate={field === 'due_date' ? project?.start_date || undefined : undefined}
                        inputClassName={INLINE_DATE_CLASS}
                      />
                    ) : project?.[field] ? (
                      <span className="text-zinc-200">{shortDate(project[field] as string)}</span>
                    ) : (
                      <span className="text-zinc-500">Not set</span>
                    )}
                  </dd>
                </div>
              ))}
              {tasks.length > 0 && (
                <>
                  <dt className="text-xs text-zinc-500">Progress</dt>
                  <dd className="flex items-center gap-2 min-w-0">
                    <span
                      className="flex-1 max-w-[8rem] h-1.5 bg-white/[0.06] rounded-full overflow-hidden"
                      role="progressbar"
                      aria-valuenow={progressPercent}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-label="Tasks done"
                    >
                      <span
                        className="block h-full rounded-full transition-all duration-500"
                        style={{ width: `${progressPercent}%`, backgroundColor: project?.color || '#A1A1AA' }}
                      />
                    </span>
                    <span className="text-xs text-zinc-400 font-mono tabular-nums">{doneCount}/{tasks.length} done</span>
                  </dd>
                </>
              )}
            </dl>
          </div>
        </Card>

        <Card
          icon={<Users size={18} className="text-zinc-400" aria-hidden="true" />}
          title="People"
          action={can.contacts ? <CardLink onClick={onOpenContacts}>Contacts</CardLink> : undefined}
        >
          {members.length === 0 && contacts.length === 0 ? (
            <div className="space-y-2">
              <p className="text-sm text-zinc-500">No one is on this project yet.</p>
              <div className="flex flex-wrap gap-3">
                {can.manageProject && <CardLink onClick={onEditProject}>Add members</CardLink>}
                {can.contacts && <CardLink onClick={onOpenContacts}>Add contacts</CardLink>}
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {members.length > 0 && (
                <div>
                  <GroupLabel>Team</GroupLabel>
                  <ul className="flex flex-wrap gap-1.5">
                    {members.map(m => (
                      <li key={m.id} className={PERSON_CHIP}>
                        <Avatar name={m.name} src={m.avatar || undefined} size="xs" />
                        <span className="truncate">{m.name}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {contacts.length > 0 && (
                <div>
                  <GroupLabel>Client</GroupLabel>
                  <ul className="flex flex-wrap gap-1.5">
                    {contacts.map(pc => {
                      const role = pc.custom_role || (pc.role && pc.role.toLowerCase() !== 'client' ? pc.role : null);
                      return (
                        <li key={pc.id} className={PERSON_CHIP}>
                          <Avatar name={pc.contact?.name || '?'} src={pc.contact?.avatar_url || undefined} size="xs" />
                          <span className="truncate">{pc.contact?.name || 'Contact'}</span>
                          {role && <span className="text-xs text-zinc-500 truncate">{role}</span>}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </div>
          )}
        </Card>

        {timeStats && (
          <Card
            icon={<Clock size={18} className="text-zinc-400" aria-hidden="true" />}
            title="Time"
            action={<CardLink onClick={() => onOpenTab('time')}>Open</CardLink>}
          >
            <div className="grid grid-cols-2 gap-4">
              <Stat label="This week" value={`${formatHours(timeStats.week)}h`} />
              <Stat label="All time" value={`${formatHours(timeStats.total)}h`} />
            </div>
          </Card>
        )}

        {can.invoices && (
          <Card
            icon={<Receipt size={18} className="text-zinc-400" aria-hidden="true" />}
            title="Billing"
            action={<CardLink onClick={() => onOpenTab('billing')}>Open</CardLink>}
          >
            {billing && (
              <Stat
                label="Outstanding"
                value={formatMoney(billing.outstanding)}
                tone={billing.outstanding > 0 ? 'warn' : undefined}
              />
            )}
            <p className="text-xs text-zinc-500 mt-1">
              {billing?.isHourly ? 'Includes hours not yet invoiced' : 'Invoiced and not yet paid'}
            </p>
            {nextDraft && (
              <div className="mt-4 pt-4 border-t border-white/[0.06]">
                <p className="text-xs text-zinc-500">Next draft</p>
                <p className="text-sm text-zinc-200">
                  {shortDate(nextDraft.date)}
                  <span className="text-zinc-500"> · </span>
                  <span className="tabular-nums">{formatMoney(nextDraft.exact + nextDraft.estimated)}</span>
                  {nextDraft.estimated > 0 && <span className="text-zinc-500"> so far</span>}
                </p>
              </div>
            )}
          </Card>
        )}

        {can.portal && (
          <Card
            icon={<Globe size={18} className="text-zinc-400" aria-hidden="true" />}
            title="Client portal"
            action={<CardLink onClick={() => onOpenTab('portal')}>Open</CardLink>}
          >
            <div className="flex items-center justify-between gap-3">
              <p className="flex items-center gap-2 text-sm text-zinc-200">
                <span aria-hidden="true" className={`w-1.5 h-1.5 rounded-full ${portal?.enabled ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
                {portal?.enabled ? 'Live' : 'Off'}
              </p>
              {portal?.enabled && portalUrl && (
                <button
                  type="button"
                  onClick={copyPortalLink}
                  className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-brand-300 transition-colors rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                >
                  <Copy size={12} aria-hidden="true" />
                  Copy link
                </button>
              )}
            </div>
            <p className="mt-2 text-xs text-zinc-500">
              {lastUpdate
                ? `${portalUpdates.length} ${portalUpdates.length === 1 ? 'update' : 'updates'}, last on ${new Date(lastUpdate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
                : 'No updates posted yet'}
            </p>
          </Card>
        )}

      </div>
    </div>
  );
}
