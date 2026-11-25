'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Ban } from 'lucide-react';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { MemberStatusChip, RoleChip } from '@/components/team/member-chips';
import { AGENT_PROFILES } from '@/lib/mcp/profiles';
import { useRead } from '@/lib/query-cache';
import { agentProfilesRead } from '@/lib/reads';
import { timeAgo } from '@/lib/task-times';
import type { ProfileMember } from '@/lib/team/profile';
import { formatDate, localClock } from './format';

/** The person's time now, ticking each half minute. */
function LocalTime({ timezone }: { timezone: string }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const { time, offset } = localClock(timezone, now);
  return (
    <span className="tabular-nums">
      {time}
      <span className="text-zinc-500"> {timezone.replace(/_/g, ' ')}{offset ? `, ${offset}` : ''}</span>
    </span>
  );
}

/**
 * One fact. On phones the facts are a label and value list, like a stat
 * strip; wider, they sit in one row, label over value.
 */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 flex items-baseline justify-between gap-4 py-2.5 first:pt-0 last:pb-0 sm:block sm:py-0">
      <dt className="flex-shrink-0 text-xs font-medium text-zinc-500">{label}</dt>
      <dd className="min-w-0 truncate text-right text-sm text-zinc-200 sm:mt-1 sm:text-left">{children}</dd>
    </div>
  );
}

/**
 * Who the person is: avatar, title, role and status, then the facts the
 * viewer may see (email, local time, joined, last active). A suspended
 * person gets a banner with Reactivate for whoever may undo it.
 */
export function ProfileIdentity({
  member,
  lastActiveAt,
  isSelf,
  onReactivate,
}: {
  member: ProfileMember;
  lastActiveAt?: string | null;
  isSelf: boolean;
  /** Present when the viewer may reactivate this person. */
  onReactivate?: () => void;
}) {
  const profiles = useRead(member.agent_profile && !AGENT_PROFILES.some((profile) => profile.value === member.agent_profile) ? agentProfilesRead : null).data;
  const agentProfile = member.agent_profile
    ? [...AGENT_PROFILES, ...(profiles ?? [])].find((profile) => profile.value === member.agent_profile)?.label ?? member.agent_profile
    : null;
  const facts: { label: string; value: ReactNode }[] = [];
  if (member.email) {
    facts.push({
      label: 'Email',
      value: (
        <a href={`mailto:${member.email}`} className="hover:text-brand-300 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 rounded">
          {member.email}
        </a>
      ),
    });
  }
  if (member.timezone) facts.push({ label: 'Local time', value: <LocalTime timezone={member.timezone} /> });
  if (member.joined_at) facts.push({ label: 'Joined', value: formatDate(member.joined_at) });
  if (lastActiveAt !== undefined) facts.push({ label: 'Last active', value: lastActiveAt ? timeAgo(lastActiveAt) : 'Not yet' });

  return (
    <section aria-label="Profile" className="space-y-3">
      {member.status === 'suspended' && (
        <div role="status" className="rounded-xl bg-red-500/[0.10] px-4 py-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          <Ban size={16} className="text-red-300 flex-shrink-0" aria-hidden="true" />
          <p className="flex-1 min-w-[200px] text-sm text-red-200">
            {isSelf ? 'Your account is suspended.' : 'Suspended'}
            {member.suspended_at ? ` since ${formatDate(member.suspended_at)}` : ''}
            {isSelf ? '' : '. They cannot sign in or be assigned work, and their history stays.'}
          </p>
          {onReactivate && (
            <Button size="sm" variant="secondary" onClick={onReactivate}>
              Reactivate
            </Button>
          )}
        </div>
      )}

      <div className="glass-card rounded-xl p-5">
        <div className="flex items-center gap-4 min-w-0">
          <Avatar name={member.name} src={member.avatar || undefined} size="lg" className="!w-14 !h-14 !text-lg flex-shrink-0" />
          <div className="min-w-0">
            {member.title?.trim() ? (
              <p className="text-sm text-zinc-300 break-words">{member.title}</p>
            ) : null}
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <RoleChip role={member.role} />
              <MemberStatusChip status={member.status} />
              {agentProfile && <Badge>{`${agentProfile} profile`}</Badge>}
              {isSelf && <Badge variant="info">You</Badge>}
            </div>
          </div>
        </div>

        {facts.length > 0 && (
          <dl className="mt-5 pt-5 border-t border-white/[0.06] flex flex-col divide-y divide-white/[0.06] sm:flex-row sm:flex-wrap sm:divide-y-0 sm:gap-x-10 sm:gap-y-4">
            {facts.map((fact) => (
              <Fact key={fact.label} label={fact.label}>{fact.value}</Fact>
            ))}
          </dl>
        )}
      </div>
    </section>
  );
}
