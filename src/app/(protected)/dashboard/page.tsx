'use client';

import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { Header } from '@/components/layout/Header';
import { Avatar } from '@/components/ui/Avatar';
import { StatusBadge, PriorityBadge } from '@/components/ui/Badge';
import Link from 'next/link';
import { FolderKanban, CheckCircle, Clock, AlertTriangle, Plus, ArrowRight, TrendingUp, Calendar, Users, Target } from 'lucide-react';

export default function DashboardPage() {
  const { projects, tasks, team, leads } = useApp();
  const { user } = useAuth();

  const activeProjects = projects.filter(p => p.status === 'active');
  const completedProjects = projects.filter(p => p.status === 'completed');

  const todoTasks = tasks.filter(t => t.status === 'todo');
  const inProgressTasks = tasks.filter(t => t.status === 'in_progress');
  const doneTasks = tasks.filter(t => t.status === 'done');

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const thisWeek = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);

  const dueThisWeek = tasks.filter(t => {
    if (!t.due_date || t.status === 'done') return false;
    const due = new Date(t.due_date);
    due.setHours(0, 0, 0, 0);
    return due >= today && due <= thisWeek;
  });

  const overdue = tasks.filter(t => {
    if (!t.due_date || t.status === 'done') return false;
    const due = new Date(t.due_date);
    due.setHours(0, 0, 0, 0);
    return due < today;
  });

  const recentTasks = [...tasks]
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
    .slice(0, 6);

  const displayName = user?.user_metadata?.display_name || user?.email?.split('@')[0] || 'there';

  const activeLeads = leads.filter(l => l.status !== 'won' && l.status !== 'lost');

  const stats = [
    {
      label: 'Active Projects',
      value: activeProjects.length,
      icon: FolderKanban,
      color: 'text-indigo-600',
      bg: 'bg-indigo-50',
    },
    {
      label: 'In Progress',
      value: inProgressTasks.length,
      icon: Clock,
      color: 'text-amber-600',
      bg: 'bg-amber-50',
    },
    {
      label: 'Completed',
      value: doneTasks.length,
      icon: CheckCircle,
      color: 'text-emerald-600',
      bg: 'bg-emerald-50',
    },
    {
      label: 'Active Leads',
      value: activeLeads.length,
      icon: Target,
      color: activeLeads.length > 0 ? 'text-violet-600' : 'text-zinc-400',
      bg: activeLeads.length > 0 ? 'bg-violet-50' : 'bg-zinc-50',
    },
  ];

  return (
    <div className="animate-fadeIn min-h-screen bg-zinc-50">
      <Header
        title="Dashboard"
      />

      <div className="p-4 lg:p-6 space-y-4 lg:space-y-6">
        {/* Welcome message */}
        <div className="bg-gradient-to-r from-indigo-600 to-violet-600 rounded-xl p-4 lg:p-6 text-white">
          <h2 className="text-xl lg:text-2xl font-bold mb-2">
            Welcome back, {displayName.split(' ')[0]}!
          </h2>
          <p className="text-indigo-100 text-sm lg:text-base">
            You have {inProgressTasks.length} tasks in progress and {dueThisWeek.length} tasks due this week.
          </p>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 lg:gap-4">
          {stats.map((stat) => (
            <div
              key={stat.label}
              className="bg-white rounded-xl border border-zinc-200 p-3 lg:p-5 hover:shadow-md transition-shadow"
            >
              <div className="flex items-center justify-between mb-2 lg:mb-3">
                <div className={`p-2 lg:p-2.5 rounded-lg ${stat.bg}`}>
                  <stat.icon className={stat.color} size={20} />
                </div>
              </div>
              <p className="text-xl lg:text-2xl font-bold text-zinc-900">{stat.value}</p>
              <p className="text-xs lg:text-sm text-zinc-500">{stat.label}</p>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 lg:gap-6">
          {/* Recent Tasks */}
          <div className="lg:col-span-2 bg-white rounded-xl border border-zinc-200 overflow-hidden">
            <div className="flex items-center justify-between p-4 border-b border-zinc-100">
              <h2 className="font-semibold text-zinc-900">Recent Tasks</h2>
              <Link
                href="/projects"
                className="text-sm text-indigo-600 hover:text-indigo-700 flex items-center gap-1"
              >
                View all <ArrowRight size={14} />
              </Link>
            </div>

            <div className="divide-y divide-zinc-100">
              {recentTasks.length > 0 ? recentTasks.map((task) => {
                const project = projects.find(p => p.id === task.project_id);
                return (
                  <div
                    key={task.id}
                    className="flex items-center gap-3 p-3 lg:p-4 hover:bg-zinc-50 transition-colors"
                  >
                    <div className={`w-2 h-2 rounded-full flex-shrink-0 ${
                      task.status === 'done' ? 'bg-emerald-500' :
                      task.status === 'in_progress' ? 'bg-indigo-500' :
                      task.status === 'in_review' ? 'bg-amber-500' :
                      'bg-zinc-300'
                    }`} />
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-zinc-900 text-sm lg:text-base truncate">{task.title}</p>
                      <p className="text-xs lg:text-sm text-zinc-500 truncate">{project?.name}</p>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <PriorityBadge priority={task.priority} />
                    </div>
                  </div>
                );
              }) : (
                <div className="p-8 text-center text-zinc-500">
                  <Clock className="mx-auto mb-2" size={24} />
                  <p>No tasks yet</p>
                </div>
              )}
            </div>
          </div>

          {/* Quick Actions & Due Soon */}
          <div className="space-y-4 lg:space-y-6">
            {/* Quick Actions */}
            <div className="bg-white rounded-xl border border-zinc-200 p-4 lg:p-5">
              <h2 className="font-semibold text-zinc-900 mb-4">Quick Actions</h2>
              <div className="space-y-2">
                <Link
                  href="/projects?new=true"
                  className="flex items-center gap-3 p-3 rounded-lg bg-indigo-50 text-indigo-700 hover:bg-indigo-100 transition-colors"
                >
                  <Plus size={18} />
                  <span className="font-medium text-sm lg:text-base">New Project</span>
                </Link>
                {activeProjects[0] && (
                  <Link
                    href={`/projects/${activeProjects[0].id}`}
                    className="flex items-center gap-3 p-3 rounded-lg bg-zinc-50 text-zinc-700 hover:bg-zinc-100 transition-colors"
                  >
                    <FolderKanban size={18} />
                    <span className="font-medium text-sm lg:text-base">Add Task</span>
                  </Link>
                )}
                <Link
                  href="/team"
                  className="flex items-center gap-3 p-3 rounded-lg bg-zinc-50 text-zinc-700 hover:bg-zinc-100 transition-colors"
                >
                  <Users size={18} />
                  <span className="font-medium text-sm lg:text-base">Manage Team</span>
                </Link>
              </div>
            </div>

            {/* Due This Week */}
            <div className="bg-white rounded-xl border border-zinc-200 overflow-hidden">
              <div className="p-4 border-b border-zinc-100">
                <h2 className="font-semibold text-zinc-900">Due This Week</h2>
                <p className="text-sm text-zinc-500">{dueThisWeek.length} tasks</p>
              </div>

              <div className="divide-y divide-zinc-100 max-h-64 overflow-y-auto">
                {dueThisWeek.length > 0 ? dueThisWeek.slice(0, 5).map((task) => {
                  const project = projects.find(p => p.id === task.project_id);
                  return (
                    <div
                      key={task.id}
                      className="p-3 lg:p-4 hover:bg-zinc-50 transition-colors"
                    >
                      <p className="font-medium text-zinc-900 text-sm">{task.title}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <p className="text-xs text-zinc-500">{project?.name}</p>
                        {task.due_date && (
                          <span className="text-xs text-zinc-400">• {new Date(task.due_date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</span>
                        )}
                      </div>
                    </div>
                  );
                }) : (
                  <p className="p-4 text-sm text-zinc-500 text-center">No tasks due this week</p>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Leads Pipeline */}
        {leads.length > 0 && (
          <div className="bg-white rounded-xl border border-zinc-200 overflow-hidden">
            <div className="flex items-center justify-between p-4 border-b border-zinc-100">
              <h2 className="font-semibold text-zinc-900">Leads Pipeline</h2>
              <Link
                href="/leads"
                className="text-sm text-indigo-600 hover:text-indigo-700 flex items-center gap-1"
              >
                View all <ArrowRight size={14} />
              </Link>
            </div>

            <div className="grid grid-cols-3 lg:grid-cols-6 divide-x divide-zinc-100">
              {([
                { status: 'new', label: 'New', color: 'text-blue-600' },
                { status: 'contacted', label: 'Contacted', color: 'text-violet-600' },
                { status: 'qualified', label: 'Qualified', color: 'text-amber-600' },
                { status: 'proposal', label: 'Proposal', color: 'text-zinc-600' },
                { status: 'won', label: 'Won', color: 'text-emerald-600' },
                { status: 'lost', label: 'Lost', color: 'text-red-600' },
              ] as const).map((stage) => {
                const count = leads.filter(l => l.status === stage.status).length;
                return (
                  <div key={stage.status} className="p-4 text-center">
                    <p className={`text-xl lg:text-2xl font-bold ${stage.color}`}>{count}</p>
                    <p className="text-xs text-zinc-500 mt-1">{stage.label}</p>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Projects Overview */}
        <div className="bg-white rounded-xl border border-zinc-200 overflow-hidden">
          <div className="flex items-center justify-between p-4 border-b border-zinc-100">
            <h2 className="font-semibold text-zinc-900">Projects Overview</h2>
            <Link
              href="/projects"
              className="text-sm text-indigo-600 hover:text-indigo-700 flex items-center gap-1"
            >
              View all <ArrowRight size={14} />
            </Link>
          </div>

          {projects.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 divide-x divide-zinc-100">
              {projects.slice(0, 6).map((project) => {
                const projectTasks = tasks.filter(t => t.project_id === project.id);
                const done = projectTasks.filter(t => t.status === 'done').length;
                const progress = projectTasks.length > 0 ? Math.round((done / projectTasks.length) * 100) : 0;

                return (
                  <Link
                    key={project.id}
                    href={`/projects/${project.id}`}
                    className="p-4 hover:bg-zinc-50 transition-colors"
                  >
                    <div className="flex items-center gap-2 mb-2">
                      <div
                        className="w-3 h-3 rounded-full"
                        style={{ backgroundColor: project.color }}
                      />
                      <h3 className="font-medium text-zinc-900 truncate">{project.name}</h3>
                    </div>
                    <div className="flex items-center justify-between text-xs lg:text-sm text-zinc-500 mb-2">
                      <span>{projectTasks.length} tasks</span>
                      <span>{progress}% done</span>
                    </div>
                    <div className="h-1.5 bg-zinc-100 rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all"
                        style={{ width: `${progress}%`, backgroundColor: project.color }}
                      />
                    </div>
                  </Link>
                );
              })}
            </div>
          ) : (
            <div className="p-8 text-center text-zinc-500">
              <FolderKanban className="mx-auto mb-2" size={32} />
              <p>No projects yet</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
