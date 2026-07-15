'use client';

import { useState } from 'react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { Header } from '@/components/layout/Header';
import { Avatar } from '@/components/ui/Avatar';
import { StatusBadge, PriorityBadge } from '@/components/ui/Badge';
import { TaskForm } from '@/components/tasks/TaskForm';
import Link from 'next/link';
import Modal from '@/components/ui/Modal';
import { FolderKanban, CheckCircle, Clock, AlertTriangle, Plus, ArrowRight, TrendingUp, Calendar, Users, Target, UserCircle, Activity } from 'lucide-react';
import { parseDateOnly } from '@/lib/date-utils';

function getTimeAgo(dateStr: string): string {
  const now = new Date();
  const date = new Date(dateStr);
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function DashboardPage() {
  const { projects, tasks, team, contacts, leads, activities, getTeamMember } = useApp();
  const { user, teamMemberId } = useAuth();
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  const [quickAddProjectId, setQuickAddProjectId] = useState<string | null>(null);

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
    const due = parseDateOnly(t.due_date);
    return due >= today && due <= thisWeek;
  });

  const overdue = tasks.filter(t => {
    if (!t.due_date || t.status === 'done') return false;
    return parseDateOnly(t.due_date) < today;
  });

  const recentTasks = [...tasks]
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
    .slice(0, 6);

  const currentMember = teamMemberId ? getTeamMember(teamMemberId) : null;
  const displayName = currentMember?.name || user?.user_metadata?.display_name || user?.email?.split('@')[0] || 'there';

  const activeLeads = leads.filter(l => l.status !== 'won' && l.status !== 'lost');

  const stats = [
    {
      label: 'Active Projects',
      value: activeProjects.length,
      icon: FolderKanban,
      color: 'text-brand-600',
      bg: 'bg-brand-50',
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
      label: 'Contacts',
      value: contacts.length,
      icon: UserCircle,
      color: contacts.length > 0 ? 'text-cyan-600' : 'text-zinc-400',
      bg: contacts.length > 0 ? 'bg-cyan-50' : 'bg-zinc-50',
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
        <div className="bg-gradient-to-r from-brand-600 to-accent rounded-xl p-4 lg:p-6 text-white">
          <h2 className="text-xl lg:text-2xl font-bold mb-2">
            Welcome back, {displayName.split(' ')[0]}!
          </h2>
          <p className="text-brand-100 text-sm lg:text-base">
            You have {inProgressTasks.length} tasks in progress{dueThisWeek.length > 0 && <>, {dueThisWeek.length} due this week</>}
            {overdue.length > 0 && <>, and <span className="text-red-200 font-semibold">{overdue.length} overdue</span></>}.
          </p>
        </div>

        {/* Stats Grid */}
        <div className="flex overflow-x-auto gap-3 lg:grid lg:grid-cols-5 lg:gap-4 -mx-4 px-4 lg:mx-0 lg:px-0 scrollbar-none">
          {stats.map((stat) => (
            <div
              key={stat.label}
              className="min-w-[140px] flex-shrink-0 lg:min-w-0 bg-white rounded-xl border border-zinc-200 p-3 lg:p-5 hover:shadow-md transition-shadow"
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

        {/* Overdue Tasks Alert */}
        {overdue.length > 0 && (
          <div className="bg-red-50 rounded-xl border border-red-200 overflow-hidden">
            <div className="flex items-center gap-3 p-4 border-b border-red-100">
              <div className="p-2 bg-red-100 rounded-lg">
                <AlertTriangle size={18} className="text-red-600" />
              </div>
              <div>
                <h2 className="font-semibold text-red-900">Overdue Tasks</h2>
                <p className="text-sm text-red-600">{overdue.length} task{overdue.length !== 1 ? 's' : ''} past due date</p>
              </div>
            </div>

            <div className="divide-y divide-red-100">
              {overdue.slice(0, 5).map((task) => {
                const project = projects.find(p => p.id === task.project_id);
                const daysOverdue = Math.floor((today.getTime() - parseDateOnly(task.due_date!).getTime()) / (1000 * 60 * 60 * 24));
                return (
                  <Link
                    key={task.id}
                    href={`/projects/${task.project_id}`}
                    className="flex items-center gap-3 p-3 lg:p-4 hover:bg-red-100/50 transition-colors"
                  >
                    <div className="w-2 h-2 rounded-full bg-red-500 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-red-900 text-sm lg:text-base truncate">{task.title}</p>
                      <p className="text-xs text-red-600 truncate">{project?.name}</p>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <span className="text-xs font-medium text-red-700 bg-red-100 px-2 py-0.5 rounded-full">
                        {daysOverdue}d overdue
                      </span>
                      <PriorityBadge priority={task.priority} />
                    </div>
                  </Link>
                );
              })}
              {overdue.length > 5 && (
                <div className="p-3 text-center">
                  <span className="text-xs text-red-600">+{overdue.length - 5} more overdue tasks</span>
                </div>
              )}
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 lg:gap-6">
          {/* Recent Tasks */}
          <div className="lg:col-span-2 bg-white rounded-xl border border-zinc-200 overflow-hidden flex flex-col">
            <div className="flex items-center justify-between p-4 border-b border-zinc-100 flex-shrink-0">
              <h2 className="font-semibold text-zinc-900">Recent Tasks</h2>
              <Link
                href="/projects"
                className="text-sm text-brand-600 hover:text-brand-700 flex items-center gap-1"
              >
                View all <ArrowRight size={14} />
              </Link>
            </div>

            <div className="divide-y divide-zinc-100 flex-1 flex flex-col">
              {recentTasks.length > 0 ? recentTasks.map((task) => {
                const project = projects.find(p => p.id === task.project_id);
                return (
                  <Link
                    key={task.id}
                    href={`/projects/${task.project_id}`}
                    className="flex items-center gap-3 p-3 lg:p-4 hover:bg-zinc-50 transition-colors"
                  >
                    <div className={`w-2 h-2 rounded-full flex-shrink-0 ${
                      task.status === 'done' ? 'bg-emerald-500' :
                      task.status === 'in_progress' ? 'bg-brand-500' :
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
                  </Link>
                );
              }) : (
                <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
                  <div className="w-10 h-10 rounded-full bg-zinc-100 flex items-center justify-center mb-3">
                    <CheckCircle size={18} className="text-zinc-400" />
                  </div>
                  <p className="text-sm font-medium text-zinc-500">No tasks yet</p>
                  <p className="text-xs text-zinc-400 mt-1">Tasks will appear here as they&apos;re created</p>
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
                  className="flex items-center gap-3 p-3 rounded-lg bg-brand-50 text-brand-700 hover:bg-brand-100 transition-colors"
                >
                  <Plus size={18} />
                  <span className="font-medium text-sm lg:text-base">New Project</span>
                </Link>
                {activeProjects.length > 0 && (
                  <button
                    onClick={() => setShowProjectPicker(true)}
                    className="w-full flex items-center gap-3 p-3 rounded-lg bg-zinc-50 text-zinc-700 hover:bg-zinc-100 transition-colors"
                  >
                    <FolderKanban size={18} />
                    <span className="font-medium text-sm lg:text-base">Add Task</span>
                  </button>
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
                    <Link
                      key={task.id}
                      href={`/projects/${task.project_id}`}
                      className="block p-3 lg:p-4 hover:bg-zinc-50 transition-colors"
                    >
                      <p className="font-medium text-zinc-900 text-sm">{task.title}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <p className="text-xs text-zinc-500">{project?.name}</p>
                        {task.due_date && (
                          <span className="text-xs text-zinc-400">
                            &bull; {parseDateOnly(task.due_date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                          </span>
                        )}
                      </div>
                    </Link>
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
                className="text-sm text-brand-600 hover:text-brand-700 flex items-center gap-1"
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

        {/* Recent Activity */}
        {activities.length > 0 && (
          <div className="bg-white rounded-xl border border-zinc-200 overflow-hidden">
            <div className="flex items-center gap-2 p-4 border-b border-zinc-100">
              <Activity size={16} className="text-brand-600" />
              <h2 className="font-semibold text-zinc-900">Recent Activity</h2>
            </div>

            <div className="divide-y divide-zinc-100 max-h-72 overflow-y-auto">
              {activities.slice(0, 10).map((activity) => {
                const member = getTeamMember(activity.user_id);
                const timeAgo = getTimeAgo(activity.created_at);

                return (
                  <div
                    key={activity.id}
                    className="flex items-start gap-3 p-3 lg:p-4"
                  >
                    <Avatar name={member?.name || 'System'} src={member?.avatar || undefined} size="sm" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-zinc-700">
                        <span className="font-medium text-zinc-900">{member?.name || 'System'}</span>
                        {' '}{activity.description}
                      </p>
                      <p className="text-xs text-zinc-400 mt-0.5">{timeAgo}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Projects Overview */}
        {projects.length > 0 && (
        <div className="bg-white rounded-xl border border-zinc-200 overflow-hidden">
          <div className="flex items-center justify-between p-4 border-b border-zinc-100">
            <h2 className="font-semibold text-zinc-900">Projects Overview</h2>
            <Link
              href="/projects"
              className="text-sm text-brand-600 hover:text-brand-700 flex items-center gap-1"
            >
              View all <ArrowRight size={14} />
            </Link>
          </div>

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
                    {project.color && (
                      <div
                        className="w-3 h-3 rounded-full"
                        style={{ backgroundColor: project.color }}
                      />
                    )}
                    <h3 className="font-medium text-zinc-900 truncate">{project.name}</h3>
                  </div>
                  <div className="flex items-center justify-between text-xs lg:text-sm text-zinc-500 mb-2">
                    <span>{projectTasks.length} tasks</span>
                    <span>{progress}% done</span>
                  </div>
                  <div className="h-1.5 bg-zinc-100 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all"
                      style={{ width: `${progress}%`, backgroundColor: project.color || '#A1A1AA' }}
                    />
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
        )}
      </div>

      {/* Project Picker Modal */}
      <Modal
        isOpen={showProjectPicker}
        onClose={() => setShowProjectPicker(false)}
        title="Add Task to Project"
        size="sm"
      >
        <p className="text-sm text-zinc-500 mb-4">Select a project to add a task to:</p>
        <div className="space-y-1 max-h-64 overflow-y-auto">
          {activeProjects.map((p) => (
            <button
              key={p.id}
              onClick={() => {
                setShowProjectPicker(false);
                setQuickAddProjectId(p.id);
              }}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left hover:bg-zinc-50 transition-colors"
            >
              {p.color && <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: p.color }} />}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-zinc-900 truncate">{p.name}</p>
                {p.description && (
                  <p className="text-xs text-zinc-500 truncate">{p.description}</p>
                )}
              </div>
              <ArrowRight size={14} className="text-zinc-400 flex-shrink-0" />
            </button>
          ))}
        </div>
      </Modal>

      {/* Quick Add Task Form */}
      {quickAddProjectId && (
        <TaskForm
          isOpen={!!quickAddProjectId}
          onClose={() => setQuickAddProjectId(null)}
          projectId={quickAddProjectId}
        />
      )}
    </div>
  );
}
