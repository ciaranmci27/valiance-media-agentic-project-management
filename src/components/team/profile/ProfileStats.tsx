import { AlertCircle, CalendarCheck, CheckCircle2, Clock, ListTodo, LogIn, MousePointerClick, Timer } from 'lucide-react';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { StatStrip } from '@/components/ui/StatStrip';
import { timeAgo } from '@/lib/task-times';
import type { ProfileTime as Time, ProfileUsage as Usage, ProfileWork as Work } from '@/lib/team/profile';
import { formatDate, formatHours } from './format';

/**
 * The person's headline numbers in one strip under their identity: open,
 * overdue and recently done work, then hours this week and over the last
 * 30 days. Each part shows only when the viewer may see it.
 */
export function ProfileNumbers({ work, time, shared }: { work?: Work; time?: Time; shared: boolean }) {
  if (!work && !time) return null;
  return (
    <StatStrip
      label="At a glance"
      stats={[
        work && { label: 'Open tasks', value: work.open, icon: ListTodo, context: shared ? 'In shared projects' : 'Assigned, not done' },
        work && {
          label: 'Overdue',
          value: work.overdue,
          icon: AlertCircle,
          tone: work.overdue > 0 ? 'warning' : 'default',
          context: 'Past the due date',
        },
        work && { label: 'Done', value: work.done_last_30, icon: CheckCircle2, context: 'Last 30 days' },
        time && {
          label: 'Hours this week',
          value: formatHours(time.week_hours),
          icon: time.running ? Timer : Clock,
          context: time.running ? <span className="text-emerald-300">Timer running now</span> : 'Logged since Monday',
        },
        time && { label: 'Hours, last 30 days', value: formatHours(time.last_30_hours), icon: Clock, context: 'All logged time' },
      ]}
    />
  );
}

/** How much the person uses the app: active days, actions this month, last sign-in. */
export function ProfileUsage({ usage }: { usage: Usage }) {
  const month = new Date().toLocaleDateString('en-US', { month: 'long' });
  return (
    <section aria-labelledby="profile-usage">
      <SectionHeader label={<span id="profile-usage">Usage</span>} />
      <StatStrip
        stats={[
          { label: 'Active days', value: usage.active_days, icon: CalendarCheck, context: 'Of the last 30' },
          { label: 'Actions', value: usage.actions_this_month, icon: MousePointerClick, context: `In ${month}` },
          {
            label: 'Last sign-in',
            value: usage.last_sign_in_at ? timeAgo(usage.last_sign_in_at) : 'Never',
            icon: LogIn,
            context: usage.last_sign_in_at ? formatDate(usage.last_sign_in_at) : 'Has not signed in yet',
          },
        ]}
      />
    </section>
  );
}
