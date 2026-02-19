'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  FolderKanban,
  Users,
  Plus,
  Menu,
  X,
  LogOut,
  Target,
  UserCircle,
  CheckSquare,
} from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { Avatar } from '@/components/ui/Avatar';

export function Sidebar() {
  const pathname = usePathname();
  const { projects, tasks, team } = useApp();
  const { user, teamMemberId, signOut } = useAuth();
  const [isOpen, setIsOpen] = useState(false);

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
      {/* Mobile menu button */}
      <button
        onClick={() => setIsOpen(true)}
        className="lg:hidden fixed top-4 left-4 z-50 p-2 bg-white border border-zinc-200 rounded-lg"
      >
        <Menu size={20} className="text-zinc-700" />
      </button>

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
        <div className="h-16 flex items-center justify-between px-5 border-b border-white/5">
          <Link href="/dashboard" className="flex items-center" onClick={closeSidebar}>
            <span className="text-white font-semibold text-lg tracking-tight">ProjectEM</span>
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
            <Avatar name={displayName} size="sm" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-zinc-200 truncate">{displayName}</p>
              <p className="text-xs text-zinc-500 truncate capitalize">{displayRole}</p>
            </div>
          </Link>
          <button
            onClick={signOut}
            className="w-full flex items-center gap-3 px-2 py-2 mt-1 rounded-lg text-zinc-400 hover:bg-white/5 hover:text-zinc-200 transition-colors"
          >
            <LogOut size={16} />
            <span className="text-sm">Sign out</span>
          </button>
        </div>
      </aside>
    </>
  );
}
