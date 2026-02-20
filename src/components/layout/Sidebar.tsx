'use client';

import { useState, useEffect } from 'react';
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
  Bot,
} from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { Avatar } from '@/components/ui/Avatar';
import { Logo } from '@/components/ui/Logo';
import { siteConfig } from '@/site-config';

export function Sidebar() {
  const pathname = usePathname();
  const { projects, tasks, team, getPendingSuggestionCount } = useApp();
  const { user, teamMemberId, signOut } = useAuth();
  const { isEnvForcedDemo } = useDemo();
  const [isOpen, setIsOpen] = useState(false);

  // Listen for the Header's hamburger button event
  useEffect(() => {
    const open = () => setIsOpen(true);
    window.addEventListener('open-sidebar', open);
    return () => window.removeEventListener('open-sidebar', open);
  }, []);

  const currentMember = team.find(m => m.id === teamMemberId);
  const displayName = currentMember?.name || user?.user_metadata?.display_name || user?.email?.split('@')[0] || 'User';
  const displayRole = currentMember?.role || 'Member';

  const isAgentsEnabled = process.env.NEXT_PUBLIC_ENABLE_AGENTS === 'true';
  const isAdmin = currentMember?.role === 'admin';
  const pendingSuggestionCount = isAgentsEnabled && isAdmin ? getPendingSuggestionCount() : 0;

  const navItems = [
    { href: '/dashboard', icon: LayoutDashboard, label: 'Dashboard', badge: 0 },
    ...(tasks.length > 0 ? [{ href: '/my-tasks', icon: CheckSquare, label: 'My Tasks', badge: 0 }] : []),
    ...(projects.length > 0 ? [{ href: '/projects', icon: FolderKanban, label: 'Projects', badge: 0 }] : []),
    { href: '/leads', icon: Target, label: 'Leads', badge: 0 },
    { href: '/contacts', icon: UserCircle, label: 'Contacts', badge: 0 },
    { href: '/team', icon: Users, label: 'Team', badge: 0 },
    ...(isAgentsEnabled && isAdmin ? [{ href: '/agent', icon: Bot, label: 'Agent', badge: pendingSuggestionCount }] : []),
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

      {/* Sidebar */}
      <aside className={`
        fixed top-0 left-0 h-full w-60 bg-[#0F0F12] flex flex-col z-50
        transform transition-transform duration-200 ease-out
        lg:translate-x-0 ${isOpen ? 'translate-x-0' : '-translate-x-full'}
      `}>
        {/* Logo */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/5">
          <Link href="/dashboard" className="flex flex-col" onClick={closeSidebar}>
            <Logo className="h-9 w-full invert" />
            <span className="text-white font-semibold text-[7px] tracking-[0.2em] uppercase w-full text-center">{siteConfig.name}</span>
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
                    ? 'bg-indigo-600 text-white'
                    : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200'
                }`}
              >
                <item.icon size={18} />
                <span className="text-sm font-medium flex-1">{item.label}</span>
                {item.badge > 0 && (
                  <span className="min-w-[20px] h-5 flex items-center justify-center rounded-full bg-indigo-500 text-white text-xs font-medium px-1.5">
                    {item.badge}
                  </span>
                )}
              </Link>
            );
          })}

          {/* Projects section */}
          {projects.length > 0 && (
          <div className="pt-4">
            <div className="flex items-center justify-between px-3 mb-2">
              <p className="text-xs text-zinc-600 uppercase tracking-wider font-medium">Projects</p>
              <Link
                href="/projects?new=true"
                onClick={closeSidebar}
                className="p-1 rounded text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors"
              >
                <Plus size={14} />
              </Link>
            </div>

            <div className="space-y-0.5">
              {projects.filter(p => p.status === 'active').slice(0, 5).map((project) => (
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
                  <div
                    className="w-2 h-2 rounded-full flex-shrink-0"
                    style={{ backgroundColor: project.color }}
                  />
                  <span className="text-sm truncate">{project.name}</span>
                </Link>
              ))}

              {projects.filter(p => p.status === 'active').length > 5 && (
                <Link
                  href="/projects"
                  onClick={closeSidebar}
                  className="flex items-center gap-2.5 px-3 py-2 text-sm text-zinc-500 hover:text-zinc-300 transition-colors"
                >
                  <span>+{projects.filter(p => p.status === 'active').length - 5} more</span>
                </Link>
              )}
            </div>
          </div>
          )}
        </nav>

        {/* User section */}
        <div className="p-3 border-t border-white/5">
          <Link
            href="/settings"
            onClick={closeSidebar}
            className="flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-white/5 transition-colors"
          >
            <Avatar name={displayName} src={currentMember?.avatar || undefined} size="sm" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-zinc-200 truncate">{displayName}</p>
              <p className="text-xs text-zinc-500 truncate capitalize">{displayRole}</p>
            </div>
          </Link>
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
