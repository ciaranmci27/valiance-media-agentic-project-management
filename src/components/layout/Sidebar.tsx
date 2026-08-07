'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
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
  DollarSign,
} from 'lucide-react';
import { useApp } from '@/lib/store';
import { computeNeedsYou } from '@/lib/autonomy';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { Avatar } from '@/components/ui/Avatar';
import { Logo } from '@/components/ui/Logo';
import { Tooltip } from '@/components/ui/Tooltip';
import { createClient } from '@/lib/supabase/client';
import { demoNotifications } from '@/lib/demo-data';
import { isRunning } from '@/lib/time-entry-utils';
import { siteConfig } from '@/site-config';
import { hasPermission } from '@/lib/access-control';

export function Sidebar() {
  const pathname = usePathname();
  const { projects, team, loading, getPendingSuggestionCount, timeEntries, tasks, taskSuggestions, agentActivity } = useApp();
  const { user, teamMemberId, access, signOut } = useAuth();

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
  const [unreadNotifications, setUnreadNotifications] = useState(0);

  // Listen for the Header's hamburger button event
  useEffect(() => {
    const open = () => setIsOpen(true);
    window.addEventListener('open-sidebar', open);
    return () => window.removeEventListener('open-sidebar', open);
  }, []);

  // Unread notification count, shown as an overlay badge on the Notifications tab.
  const fetchUnreadNotifications = useCallback(async () => {
    if (isDemoMode) {
      setUnreadNotifications(demoNotifications.filter(n => !n.is_read).length);
      return;
    }
    try {
      const { count } = await createClient()
        .from('team_member_notifications')
        .select('*', { count: 'exact', head: true })
        .eq('is_read', false);
      if (count !== null) setUnreadNotifications(count);
    } catch (error) {
      console.error('Error fetching unread notifications:', error);
    }
  }, [isDemoMode]);

  // Refresh on navigation and whenever the notifications page reports a change.
  useEffect(() => { fetchUnreadNotifications(); }, [fetchUnreadNotifications, pathname]);
  useEffect(() => {
    const handler = () => fetchUnreadNotifications();
    window.addEventListener('notifications-updated', handler);
    return () => window.removeEventListener('notifications-updated', handler);
  }, [fetchUnreadNotifications]);

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
    agentActivity,
  }).length;

  const navItems = [
    { href: '/dashboard', icon: LayoutDashboard, label: 'Dashboard', badge: 0, overlay: false },
    { href: '/my-tasks', icon: ListTodo, label: 'My Tasks', badge: radarCount, overlay: true },
    ...(hasPermission(access, 'projects.read') || hasPermission(access, 'projects.read_all')
      ? [{ href: '/projects', icon: FolderKanban, label: 'Projects', badge: 0, overlay: false }] : []),
    ...(hasPermission(access, 'leads.read') || hasPermission(access, 'leads.read_all') || hasPermission(access, 'leads.manage')
      ? [{ href: '/leads', icon: Target, label: 'Leads', badge: 0, overlay: false }] : []),
    ...(hasPermission(access, 'contacts.read') || hasPermission(access, 'contacts.read_all')
      ? [{ href: '/contacts', icon: UserCircle, label: 'Contacts', badge: 0, overlay: false }] : []),
    ...(hasPermission(access, 'team.read') || hasPermission(access, 'team.manage')
      ? [{ href: '/team', icon: Users, label: 'Team', badge: 0, overlay: false }] : []),
    ...(hasPermission(access, 'finance.company.read') || hasPermission(access, 'earnings.own.read')
      ? [{ href: '/finances', icon: DollarSign, label: 'Finances', badge: 0, overlay: false }] : []),
    ...(isAgentsEnabled && canManageAgents ? [{ href: '/agent', icon: Bot, label: 'Agent', badge: pendingSuggestionCount, overlay: true }] : []),
    { href: '/notifications', icon: Bell, label: 'Notifications', badge: unreadNotifications, overlay: true },
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
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={closeSidebar}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-150 ${
                  isActive
                    ? 'bg-brand-500/15 text-brand-300 glow-brand-soft'
                    : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200'
                }`}
              >
                <span className="relative flex-shrink-0 leading-none">
                  <item.icon size={18} />
                  {item.overlay && item.badge > 0 && (
                    /* Notifications alone go red: since the notification pruning,
                       one firing means an agent is blocked on a decision only
                       Ciaran can make. The Agent badge stays brand because it is
                       a review queue, not a blocker. */
                    <span className={`absolute -top-1.5 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold text-white ${
                      item.href === '/notifications' ? 'bg-red-600' : 'bg-brand-500'
                    }`}>
                      {item.badge > 9 ? '9+' : item.badge}
                    </span>
                  )}
                </span>
                <span className="text-sm font-medium flex-1">{item.label}</span>
                {!item.overlay && item.badge > 0 && (
                  <span className="min-w-[20px] h-5 flex items-center justify-center rounded-full bg-brand-500 text-white text-xs font-medium px-1.5">
                    {item.badge}
                  </span>
                )}
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
                            <span
                              role="status"
                              aria-label="Time tracker is active for this project"
                              className="relative inline-flex h-2 w-2 flex-shrink-0"
                            >
                              <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 motion-safe:animate-ping" aria-hidden="true" />
                              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" aria-hidden="true" />
                            </span>
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
              href="/settings"
              onClick={closeSidebar}
              className={`flex items-center gap-3 px-2 py-2 rounded-lg transition-colors ${
                pathname === '/settings' ? 'bg-brand-500/15 glow-brand-soft' : 'hover:bg-white/5'
              }`}
            >
              <Avatar name={displayName} src={currentMember?.avatar || undefined} size="sm" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-zinc-200 truncate">{displayName}</p>
                <p className={`text-xs truncate capitalize ${pathname === '/settings' ? 'text-brand-300' : 'text-zinc-500'}`}>{displayRole}</p>
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
