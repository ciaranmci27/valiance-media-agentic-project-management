'use client';

import { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  FolderKanban,
  Users,
  Plus,
  X,
  LogOut,
  Target,
  UserCircle,
  CheckSquare,
  ListTodo,
  Bot,
  Bell,
  ChevronDown,
  DollarSign,
  Inbox,
} from 'lucide-react';
import { useApp } from '@/lib/store';
import { computeNeedsYou } from '@/lib/autonomy';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { Avatar } from '@/components/ui/Avatar';
import { Logo } from '@/components/ui/Logo';
import { Tooltip } from '@/components/ui/Tooltip';
import { LivePulse } from '@/components/ui/LivePulse';
import { useUnreadByProject } from '@/components/tasks/TaskUnread';
import { inboxAttentionRead, inboxLandingRead, unreadNotificationsRead, useIntent, useWarmActiveProjects, useWarmProject } from '@/lib/reads';
import { invalidateTables, useRead, warmRead } from '@/lib/query-cache';
import { CountBadge, type CountBadgeTone } from '@/components/ui/CountBadge';
import { isRunning } from '@/lib/time-entry-utils';
import { siteConfig } from '@/site-config';
import { hasPermission } from '@/lib/access-control';
import { prefetchAgentAnalytics } from '@/lib/use-agent-analytics-events';
import { defaultAgentAnalyticsRange } from '@/lib/agent-range';
import { reminderGroup } from '@/lib/reminders';
import type { InboxAttention } from '@/lib/communications/inbox-view';

export function Sidebar() {
  const pathname = usePathname();
  // The profile row opens Settings, so it reads active anywhere in that area.
  const inSettings = pathname === '/settings' || pathname.startsWith('/settings/');
  const { projects, team, loading, getPendingSuggestionCount, timeEntries, tasks, taskSuggestions, agentActivity, reminders } = useApp();
  const { user, teamMemberId, access, signOut } = useAuth();

  const unreadByProject = useUnreadByProject();
  // Active projects open instantly: their Overview reads are warmed after
  // boot, and again on pointing at a project here.
  const warmProject = useWarmProject();
  const activeProjectIds = useMemo(() => projects.filter(p => p.status === 'active').map(p => p.id), [projects]);
  useWarmActiveProjects(activeProjectIds, !loading);

  // Project IDs where the current user has an actively-running timer. Used
  // to surface a green pulse next to the project's row in the sidebar so the
  // user can see at a glance which projects they're clocked into.
  const myRunningProjectIds = useMemo(() => {
    if (!teamMemberId) return new Set<string>();
    const ids = new Set<string>();
    for (const te of timeEntries) {
      if (te.member_id === teamMemberId && isRunning(te)) ids.add(te.project_id);
    }
    return ids;
  }, [timeEntries, teamMemberId]);
  const { isEnvForcedDemo, isDemoMode } = useDemo();
  const [isOpen, setIsOpen] = useState(false);
  // The Agent item expands into its three surfaces. null = follow the route
  // (auto-expand while on an /agent page); a manual toggle always wins.
  const [agentOpen, setAgentOpen] = useState<boolean | null>(null);

  // Listen for the Header's hamburger button event
  useEffect(() => {
    const open = () => setIsOpen(true);
    window.addEventListener('open-sidebar', open);
    return () => window.removeEventListener('open-sidebar', open);
  }, []);

  // The tabs' counts are cached reads (reads.ts): live sync refreshes them as
  // notifications and inbox rows change, never a refetch per route change.
  // The notifications page's own marks (no realtime echo needed) say so too.
  const unreadNotifications = useRead(unreadNotificationsRead(isDemoMode)).data ?? 0;
  useEffect(() => {
    const handler = () => invalidateTables(['team_member_notifications']);
    window.addEventListener('notifications-updated', handler);
    return () => window.removeEventListener('notifications-updated', handler);
  }, []);
  const canReadInbox = hasPermission(access, 'inbound_email.read') || hasPermission(access, 'inbound_email.manage');
  const inboxAttention = useRead(canReadInbox ? inboxAttentionRead(isDemoMode) : null).data ?? NO_ATTENTION;
  // Pointing at a tab warms its landing screen.
  const intent = useIntent();
  const warmTab = (href: string) => (href === '/inbox' && canReadInbox
    ? intent(() => void warmRead(inboxLandingRead(null, isDemoMode)))
    : {});

  const currentMember = team.find(m => m.id === teamMemberId);
  const displayName = currentMember?.name || user?.user_metadata?.display_name || user?.email?.split('@')[0] || 'User';
  const displayRole = access?.role || currentMember?.role || 'member';

  const isAgentsEnabled = process.env.NEXT_PUBLIC_ENABLE_AGENTS === 'true';
  const canManageAgents = hasPermission(access, 'agents.manage');
  const pendingSuggestionCount = isAgentsEnabled && canManageAgents ? getPendingSuggestionCount() : 0;

  // Radar's badge answers "does anything need me?" before the click. Same
  // computation as the page's top band, imported so they cannot disagree.
  // Suggestions are excluded here on purpose: the Agent tab's own badge
  // already counts them, and one signal per fact is the rule.
  const radarCount = computeNeedsYou({
    tasks,
    suggestions: taskSuggestions,
    projects,
    teamMemberId: teamMemberId || null,
    includeSuggestions: false,
    oversight: canManageAgents,
    agentActivity,
  }).length;

  // Your reminders that want you now (overdue or due today): rows in My
  // Tasks' Needs you now, so they count toward its badge.
  const remindersDue = reminders.filter(r =>
    r.owner_id === teamMemberId && ['overdue', 'today'].includes(reminderGroup(r))).length;

  // Each tab's count: the number, what it means, and its tone (CountBadge).
  // Notifications are danger: since the notification pruning, one firing
  // means an agent is blocked on a decision only Ciaran can make. The Inbox
  // takes the tone of its most pressing thread.
  const myTasksCount = radarCount + remindersDue;
  const unreadTasks = [...unreadByProject.values()].reduce((sum, n) => sum + n, 0);
  const navItems: { href: string; icon: typeof LayoutDashboard; label: string; count?: NavCount }[] = [
    { href: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
    { href: '/my-tasks', icon: ListTodo, label: 'My Tasks',
      count: { value: myTasksCount, label: `${myTasksCount} ${myTasksCount === 1 ? 'thing needs' : 'things need'} you`, tone: 'brand' } },
    ...(canReadInbox ? [{ href: '/inbox', icon: Inbox, label: 'Inbox', count: inboxCount(inboxAttention) }] : []),
    ...(hasPermission(access, 'projects.read') || hasPermission(access, 'projects.read_all')
      ? [{ href: '/projects', icon: FolderKanban, label: 'Projects',
          count: { value: unreadTasks, label: `${plural(unreadTasks, 'unread task')} across your projects`, tone: 'brand' as const } }] : []),
    ...(hasPermission(access, 'leads.read') || hasPermission(access, 'leads.read_all') || hasPermission(access, 'leads.manage')
      ? [{ href: '/leads', icon: Target, label: 'Leads' }] : []),
    ...(hasPermission(access, 'contacts.read') || hasPermission(access, 'contacts.read_all')
      ? [{ href: '/contacts', icon: UserCircle, label: 'Contacts' }] : []),
    ...(hasPermission(access, 'team.read') || hasPermission(access, 'team.manage')
      ? [{ href: '/team', icon: Users, label: 'Team' }] : []),
    ...(hasPermission(access, 'finance.company.read') || hasPermission(access, 'earnings.own.read') || hasPermission(access, 'time.approve')
      ? [{ href: '/finances', icon: DollarSign, label: 'Finances' }] : []),
    ...(isAgentsEnabled && canManageAgents ? [{ href: '/agent', icon: Bot, label: 'Agent',
      count: { value: pendingSuggestionCount, label: `${plural(pendingSuggestionCount, 'agent suggestion')} to review`, tone: 'brand' as const } }] : []),
    { href: '/notifications', icon: Bell, label: 'Notifications',
      count: { value: unreadNotifications, label: plural(unreadNotifications, 'unread notification'), tone: 'danger' } },
  ];

  const closeSidebar = () => setIsOpen(false);

  return (
    <>
      {/* Overlay */}
      {isOpen && (
        <div
          className="lg:hidden fixed inset-0 bg-black/50 z-40"
          onClick={closeSidebar}
        />
      )}

      {/* Sidebar — always dark chrome, even in light mode (data-theme="dark" re-asserts
          the dark neutral tokens for this subtree). */}
      <aside
        data-theme="dark"
        className={`
        fixed top-0 left-0 h-full w-60 glass-sidebar flex flex-col z-50
        transform transition-transform duration-200 ease-out
        lg:translate-x-0 ${isOpen ? 'translate-x-0' : '-translate-x-full'}
      `}>
        {/* Logo — pinned to h-16 so its bottom border aligns with the header's */}
        <div className="flex items-center justify-between h-16 px-5 border-b border-white/[0.06]">
          <Link href="/dashboard" className="flex flex-col" onClick={closeSidebar}>
            <Logo variant="dark" className={`h-9 w-full${siteConfig.invertLogoInSidebar ? ' invert' : ''}`} />
            {siteConfig.showNameUnderLogo && (
              <span className="text-white font-semibold text-[7px] tracking-[0.2em] uppercase w-full text-center">{siteConfig.name}</span>
            )}
          </Link>
          <button
            onClick={closeSidebar}
            className="lg:hidden p-1 text-zinc-400 hover:text-white"
          >
            <X size={20} />
          </button>
        </div>

        {/* Main nav */}
        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto sidebar-scroll">
          {navItems.map((item) => {
            const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
            // Agent is the one expandable group: the row toggles a sub-list of
            // the three agent surfaces instead of navigating, so the pages'
            // headers no longer need their own switcher.
            if (item.href === '/agent') {
              const agentExpanded = agentOpen ?? pathname.startsWith('/agent');
              const agentLinks = [
                // Project detail pages belong to the dashboard flow.
                { href: '/agent', label: 'Dashboard', active: pathname === '/agent' || pathname.startsWith('/agent/projects') },
                { href: '/agent/analytics', label: 'Analytics', active: pathname === '/agent/analytics' },
                { href: '/agent/live', label: 'Live', active: pathname === '/agent/live' },
              ];
              // The parent row reads active only while one of its tabs is the
              // current route; opening the dropdown alone does not color it.
              // The child list stays a quiet rail so the two never compete as
              // twin pills.
              return (
                <div key={item.href}>
                  <button
                    type="button"
                    onClick={() => setAgentOpen(!agentExpanded)}
                    aria-expanded={agentExpanded}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
                      isActive
                        ? 'bg-brand-500/15 text-brand-300 glow-brand-soft'
                        : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200'
                    }`}
                  >
                    <span className="relative flex-shrink-0 leading-none">
                      <item.icon size={18} aria-hidden="true" />
                      {item.count && <CountBadge {...badgeProps(item.count)} placement="icon" />}
                    </span>
                    <span className="text-sm font-medium flex-1 text-left">{item.label}</span>
                    <ChevronDown
                      size={14}
                      className={`flex-shrink-0 transition-transform ${agentExpanded ? '' : '-rotate-90'}`}
                      aria-hidden="true"
                    />
                  </button>
                  {agentExpanded && (
                    /* Rail list, not pills: one hairline centered under the
                       parent icon (row px-3 = 12px + half the 18px icon =
                       21px), labels indented to meet the parent label at
                       42px. The active surface reads as brand text plus a
                       short brand tick on the rail. */
                    <div className="relative ml-[20.5px] mt-0.5 mb-1 animate-slideDown">
                      <span className="absolute left-0 top-1 bottom-1 w-px bg-white/[0.08]" aria-hidden="true" />
                      {agentLinks.map(link => (
                        <Link
                          key={link.href}
                          href={link.href}
                          onClick={closeSidebar}
                          // Warm the report on intent. Pointing at the link is a
                          // reliable signal a moment before the click, and the
                          // query is cached by range, so arriving costs nothing:
                          // the page opens with its figures already measured.
                          onMouseEnter={link.href === '/agent/analytics'
                            ? () => prefetchAgentAnalytics(defaultAgentAnalyticsRange(currentMember?.timezone))
                            : undefined}
                          onFocus={link.href === '/agent/analytics'
                            ? () => prefetchAgentAnalytics(defaultAgentAnalyticsRange(currentMember?.timezone))
                            : undefined}
                          aria-current={link.active ? 'page' : undefined}
                          className={`relative flex items-center pl-[21.5px] pr-3 py-1.5 rounded-md text-[13px] font-medium transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
                            link.active ? 'text-brand-300' : 'text-zinc-500 hover:text-zinc-200'
                          }`}
                        >
                          {link.active && (
                            <span className="absolute -left-[0.5px] top-1/2 -translate-y-1/2 h-4 w-[2px] rounded-full bg-brand-400" aria-hidden="true" />
                          )}
                          {link.label}
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              );
            }
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={closeSidebar}
                {...warmTab(item.href)}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-150 ${
                  isActive
                    ? 'bg-brand-500/15 text-brand-300 glow-brand-soft'
                    : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200'
                }`}
              >
                <span className="relative flex-shrink-0 leading-none">
                  <item.icon size={18} aria-hidden="true" />
                  {item.count && <CountBadge {...badgeProps(item.count)} placement="icon" />}
                </span>
                <span className="text-sm font-medium flex-1">{item.label}</span>
              </Link>
            );
          })}

          {/* Projects section */}
          {(loading || projects.length > 0) && (
          <div className="pt-4">
            <div className="flex items-center justify-between px-3 mb-2">
              <p className="text-xs text-zinc-600 uppercase tracking-wider font-medium">Projects</p>
              {hasPermission(access, 'projects.manage') && (
                <Link
                  href="/projects?new=true"
                  onClick={closeSidebar}
                  className="p-1 rounded text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors"
                >
                  <Plus size={14} />
                </Link>
              )}
            </div>

            <div className="space-y-0.5">
              {loading && projects.length === 0 ? (
                <>
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="flex items-center gap-2.5 px-3 py-2">
                      <div className="w-2 h-2 rounded-full bg-white/10 animate-pulse" />
                      <div className="h-4 rounded bg-white/10 animate-pulse" style={{ width: `${60 + i * 15}px` }} />
                    </div>
                  ))}
                </>
              ) : (
                <>
                  {projects.filter(p => p.status === 'active').slice(0, 5).map((project) => {
                    const isClockedIn = myRunningProjectIds.has(project.id);
                    return (
                      <Link
                        key={project.id}
                        href={`/projects/${project.id}`}
                        onClick={closeSidebar}
                        onMouseEnter={() => warmProject(project.id)}
                        onFocus={() => warmProject(project.id)}
                        className={`flex items-center gap-2.5 px-3 py-2 rounded-lg transition-all duration-150 ${
                          pathname === `/projects/${project.id}`
                            ? 'bg-white/10 text-white'
                            : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200'
                        }`}
                      >
                        {project.color && (
                          <div
                            className="w-2 h-2 rounded-full flex-shrink-0"
                            style={{ backgroundColor: project.color }}
                          />
                        )}
                        <span className="text-sm truncate flex-1 min-w-0">{project.name}</span>
                        {isClockedIn && (
                          <Tooltip content="Time tracker is active" position="right">
                            <LivePulse label="Time tracker is active for this project" />
                          </Tooltip>
                        )}
                      </Link>
                    );
                  })}

                  {projects.filter(p => p.status === 'active').length > 5 && (
                    <Link
                      href="/projects"
                      onClick={closeSidebar}
                      className="flex items-center gap-2.5 px-3 py-2 text-sm text-zinc-500 hover:text-zinc-300 transition-colors"
                    >
                      <span>+{projects.filter(p => p.status === 'active').length - 5} more</span>
                    </Link>
                  )}
                </>
              )}
            </div>
          </div>
          )}
        </nav>

        {/* User section */}
        <div className="p-3 border-t border-white/5">
          {loading ? (
            <div className="flex items-center gap-3 px-2 py-2">
              <div className="w-8 h-8 rounded-full bg-white/10 animate-pulse flex-shrink-0" />
              <div className="flex-1 min-w-0 space-y-1.5">
                <div className="h-3.5 w-24 rounded bg-white/10 animate-pulse" />
                <div className="h-3 w-16 rounded bg-white/10 animate-pulse" />
              </div>
            </div>
          ) : (
            <Link
              href="/settings/account"
              onClick={closeSidebar}
              className={`flex items-center gap-3 px-2 py-2 rounded-lg transition-colors ${
                inSettings ? 'bg-brand-500/15 glow-brand-soft' : 'hover:bg-white/5'
              }`}
            >
              <Avatar name={displayName} src={currentMember?.avatar || undefined} size="sm" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-zinc-200 truncate">{displayName}</p>
                <p className={`text-xs truncate capitalize ${inSettings ? 'text-brand-300' : 'text-zinc-500'}`}>{displayRole}</p>
              </div>
            </Link>
          )}
          {!isEnvForcedDemo && (
            <button
              onClick={signOut}
              className="w-full flex items-center gap-3 px-2 py-2 mt-1 rounded-lg text-zinc-400 hover:bg-white/5 hover:text-zinc-200 transition-colors"
            >
              <LogOut size={16} />
              <span className="text-sm">Sign out</span>
            </button>
          )}
        </div>
      </aside>
    </>
  );
}

type NavCount = { value: number; label: string; tone: CountBadgeTone };

const NO_ATTENTION: InboxAttention = { total: 0, urgent: 0, decide: 0, reply: 0 };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

const badgeProps = (count: NavCount) => ({ count: count.value, label: count.label, tone: count.tone });

/** The Inbox count: danger for something urgent, warning for a decision, neutral for replies only. */
function inboxCount(attention: InboxAttention): NavCount {
  const waiting = `${plural(attention.total, 'thread')} waiting on you`;
  if (attention.urgent > 0) return { value: attention.total, label: `${waiting}, ${attention.urgent} urgent`, tone: 'danger' };
  if (attention.decide > 0) return { value: attention.total, label: `${waiting}, ${attention.decide} to decide`, tone: 'warning' };
  return { value: attention.total, label: `${plural(attention.total, 'thread')} waiting for your reply`, tone: 'neutral' };
}
