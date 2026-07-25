'use client';

import Link from 'next/link';
import { Calendar, Users, MoreVertical, Edit, Trash2, Bot } from 'lucide-react';
import { Project } from '@/lib/types';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { hasPermission } from '@/lib/access-control';
import { StatusBadge } from '@/components/ui/Badge';
import { AvatarGroup } from '@/components/ui/Avatar';
import { Tooltip } from '@/components/ui/Tooltip';
import { useState } from 'react';
import { parseDateOnly } from '@/lib/date-utils';

interface ProjectCardProps {
  project: Project;
  onEdit?: (project: Project) => void;
  onDelete?: (id: string) => void;
}

export function ProjectCard({ project, onEdit, onDelete }: ProjectCardProps) {
  const { team, getTasksByProject, getPrimaryClient } = useApp();
  const { access } = useAuth();
  const [showMenu, setShowMenu] = useState(false);

  const isAgentsEnabled = process.env.NEXT_PUBLIC_ENABLE_AGENTS === 'true';
  const canManageAgents = hasPermission(access, 'agents.manage');

  const projectTasks = getTasksByProject(project.id);
  const completedTasks = projectTasks.filter(t => t.status === 'done').length;
  const progress = projectTasks.length > 0 ? Math.round((completedTasks / projectTasks.length) * 100) : 0;

  const members = team.filter(m => project.member_ids.includes(m.id));
  const primaryClient = getPrimaryClient(project.id);

  const formatDate = (date: string | null) => {
    if (!date) return null;
    return parseDateOnly(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  return (
    <Link
      href={`/projects/${project.id}`}
      className="flex flex-col glass-card-interactive rounded-xl p-4 lg:p-5 group cursor-pointer h-full"
    >
      <div className="flex items-start justify-between mb-3 lg:mb-4">
        <div className="min-w-0 flex-1">
          <span className="font-semibold text-white group-hover:text-brand-300 transition-colors inline-flex items-center gap-1.5 lg:gap-2 truncate text-sm lg:text-base">
            {project.name}
            {project.color && (
              <span
                className="w-2 h-2 lg:w-2.5 lg:h-2.5 rounded-full flex-shrink-0 inline-block"
                style={{ backgroundColor: project.color }}
              />
            )}
          </span>
          <div className="mt-1 flex items-center gap-1.5 flex-wrap">
            <StatusBadge status={project.status} />
            {isAgentsEnabled && canManageAgents && project.autonomous_enabled && (
              <Tooltip content="Autonomous agents enabled">
                <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-medium bg-white/[0.06] text-zinc-300">
                  <Bot size={12} />
                </span>
              </Tooltip>
            )}
            {primaryClient?.contact && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-white/[0.06] text-zinc-300">
                {primaryClient.contact.name}
              </span>
            )}
          </div>
        </div>

        {(onEdit || onDelete) && <div className="relative flex-shrink-0">
          <button
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); setShowMenu(!showMenu); }}
            className="lg:opacity-0 group-hover:opacity-100 p-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.06] transition-all"
          >
            <MoreVertical size={16} />
          </button>

          {showMenu && (
            <>
              <div className="fixed inset-0 z-10 cursor-default" onClick={(e) => { e.preventDefault(); e.stopPropagation(); setShowMenu(false); }} />
              <div className="absolute right-0 top-10 bg-surface-raised rounded-lg shadow-xl border border-white/[0.08] py-1 z-20 min-w-[140px] cursor-pointer">
                <button
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); onEdit?.(project); setShowMenu(false); }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-zinc-300 hover:bg-white/[0.06]"
                >
                  <Edit size={14} />
                  Edit
                </button>
                <button
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); onDelete?.(project.id); setShowMenu(false); }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-400 hover:bg-red-500/15"
                >
                  <Trash2 size={14} />
                  Delete
                </button>
              </div>
            </>
          )}
        </div>}
      </div>

      <p className="text-xs lg:text-sm text-zinc-400 mb-3 lg:mb-4 line-clamp-2">
        {project.description || <span className="text-zinc-600 italic">No description</span>}
      </p>

      {/* Footer */}
      <div className="mt-auto flex items-center justify-between pt-3 border-t border-white/[0.06]">
        <div className="flex items-center gap-3 lg:gap-4 text-xs text-zinc-400">
          {project.due_date && (
            <div className="flex items-center gap-1">
              <Calendar size={14} />
              <span>{formatDate(project.due_date)}</span>
            </div>
          )}
          {members.length > 0 && (
            <div className="flex items-center gap-1">
              <Users size={14} />
              <span>{members.length}</span>
            </div>
          )}
        </div>

        {members.length > 0 && (
          <AvatarGroup users={members} max={3} size="xs" />
        )}
      </div>
    </Link>
  );
}
