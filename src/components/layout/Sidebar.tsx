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
} from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { Avatar } from '@/components/ui/Avatar';

export function Sidebar() {
  const pathname = usePathname();
  const { projects, tasks, team } = useApp();
  const { user, teamMemberId, signOut } = useAuth();
  const { isEnvForcedDemo } = useDemo();
  const [isOpen, setIsOpen] = useState(false);

  // Listen for the Header's hamburger button event
  useEffect(() => {
    const open = () => setIsOpen(true);
    window.addEventListener('open-sidebar', open);
    return () => window.removeEventListener('open-sidebar', open);
  }, []);

  const currentMember = team.find(m => m.auth_user_id === user?.id);
  const displayName = currentMember?.name || user?.user_metadata?.display_name || user?.email?.split('@')[0] || 'User';
  const displayRole = currentMember?.role || 'Member';

  const navItems = [
    { href: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
    ...(tasks.length > 0 ? [{ href: '/my-tasks', icon: CheckSquare, label: 'My Tasks' }] : []),
    ...(projects.length > 0 ? [{ href: '/projects', icon: FolderKanban, label: 'Projects' }] : []),
    { href: '/leads', icon: Target, label: 'Leads' },
    { href: '/contacts', icon: UserCircle, label: 'Contacts' },
    { href: '/team', icon: Users, label: 'Team' },
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
            <svg preserveAspectRatio="xMidYMid meet" viewBox="8.36 17.58 283.3 237.13" xmlns="http://www.w3.org/2000/svg" className="h-9 w-full" fill="white" aria-label="ProjectEM">
              <g>
                <path d="M150 32.58c37.6 0 69.34 24.4 75.83 56.87h-.14v15h18.43l-.55-7.96c-3.05-44.25-44.15-78.91-93.58-78.91S59.46 52.25 56.42 96.49l-.55 7.96h18.42V89.83c0-.14.02-.26.04-.38h-.16C80.66 56.98 112.4 32.58 150 32.58" />
                <path d="M129.73 129.3c-2.63-9.26-7.25-17.38-13.48-23.94-11.08-11.73-27.23-18.62-46.39-18.62-35.77 0-61.5 24.11-61.5 61.76v95.1c0 6.14 4.97 11.11 11.11 11.11s11.11-4.97 11.11-11.11v-32.2c0-8.51 9.2-13.91 16.57-9.67 7.6 4.37 16.66 6.69 26.48 6.69 30.18 0 58.71-21.77 58.71-60.14 0-6.73-.88-13.09-2.6-18.97Zm-59.62 58.52c-23.65 0-39.54-16.83-39.54-40.22s15.89-40.25 39.54-40.25 39.77 16.83 39.77 40.25-15.92 40.22-39.77 40.22" />
                <path d="M291.65 139.99v103.73c0 6.07-4.92 10.99-10.99 10.99h-.24c-6.07 0-10.99-4.92-10.99-10.99V139.99c0-21.54-11.47-31.12-27.62-31.12s-27.39 10.07-27.39 31.12v55.91c0 6.07-4.92 10.99-10.99 10.99h-.24c-6.07 0-10.99-4.92-10.99-10.99v-55.91c0-21.05-11.92-31.12-27.58-31.12-13.19 0-23.2 6.4-26.45 20.44-2.63-9.26-7.25-17.38-13.48-23.94 8.58-11.53 22.06-17.09 37.82-17.09 13.08 0 24.65 4.31 33.01 12.56 4.26 4.2 11.13 4.18 15.38-.03 8.31-8.23 19.77-12.53 33.03-12.53 27.13 0 47.73 16.37 47.73 51.72Z" />
                <path d="M83.67 147.58c0 7.428-6.022 13.45-13.45 13.45s-13.45-6.022-13.45-13.45 6.022-13.45 13.45-13.45 13.45 6.022 13.45 13.45" />
              </g>
            </svg>
            <span className="text-white font-semibold text-[7px] tracking-[0.2em] uppercase w-full text-center">Projectem</span>
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
                <span className="text-sm font-medium">{item.label}</span>
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
