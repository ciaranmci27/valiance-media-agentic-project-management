'use client';

import Link from 'next/link';
import { Calendar, Users, MoreVertical, Edit, Trash2 } from 'lucide-react';
import { Project } from '@/lib/types';
import { useApp } from '@/lib/store';
import { StatusBadge } from '@/components/ui/Badge';
import { AvatarGroup } from '@/components/ui/Avatar';
import { useState } from 'react';

interface ProjectCardProps {
  project: Project;
  onEdit?: (project: Project) => void;
  onDelete?: (id: string) => void;
}

export function ProjectCard({ project, onEdit, onDelete }: ProjectCardProps) {
  const { team, getTasksByProject, getPrimaryClient } = useApp();
  const [showMenu, setShowMenu] = useState(false);

  const projectTasks = getTasksByProject(project.id);
  const completedTasks = projectTasks.filter(t => t.status === 'done').length;
  const progress = projectTasks.length > 0 ? Math.round((completedTasks / projectTasks.length) * 100) : 0;

  const members = team.filter(m => project.member_ids.includes(m.id));
  const primaryClient = getPrimaryClient(project.id);

  const formatDate = (date: string | null) => {
    if (!date) return null;
    return new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  return (
    <Link
      href={`/projects/${project.id}`}
      className="block bg-white rounded-xl border border-zinc-200 p-4 lg:p-5 hover:shadow-lg hover:border-zinc-300 transition-all duration-200 group cursor-pointer"
    >
      <div className="flex items-start justify-between mb-3 lg:mb-4">
        <div className="flex items-center gap-2 lg:gap-3 min-w-0 flex-1">
          <div
            className="w-2.5 lg:w-3 h-2.5 lg:h-3 rounded-full flex-shrink-0"
            style={{ backgroundColor: project.color }}
          />
          <div className="min-w-0 flex-1">
            <span className="font-semibold text-zinc-900 group-hover:text-indigo-600 transition-colors block truncate text-sm lg:text-base">
              {project.name}
            </span>
            <div className="mt-1 flex items-center gap-1.5 flex-wrap">
              <StatusBadge status={project.status} />
              {primaryClient?.contact && (
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-violet-100 text-violet-700">
                  {primaryClient.contact.name}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="relative flex-shrink-0">
          <button
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); setShowMenu(!showMenu); }}
            className="lg:opacity-0 group-hover:opacity-100 p-1.5 rounded-lg text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 transition-all"
          >
            <MoreVertical size={16} />
          </button>

          {showMenu && (
            <>
              <div className="fixed inset-0 z-10 cursor-default" onClick={(e) => { e.preventDefault(); e.stopPropagation(); setShowMenu(false); }} />
              <div className="absolute right-0 top-10 bg-white rounded-lg shadow-xl border border-zinc-200 py-1 z-20 min-w-[140px] cursor-pointer">
                <button
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); onEdit?.(project); setShowMenu(false); }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
                >
                  <Edit size={14} />
                  Edit
                </button>
                <button
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); onDelete?.(project.id); setShowMenu(false); }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-600 hover:bg-red-50"
                >
                  <Trash2 size={14} />
                  Delete
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {project.description && (
        <p className="text-xs lg:text-sm text-zinc-500 mb-3 lg:mb-4 line-clamp-2">{project.description}</p>
      )}

      {/* Progress bar */}
      <div className="mb-3 lg:mb-4">
        <div className="flex items-center justify-between text-xs text-zinc-500 mb-1.5">
          <span>Progress</span>
          <span>{completedTasks}/{projectTasks.length}</span>
        </div>
        <div className="h-1.5 bg-zinc-100 rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{ width: `${progress}%`, backgroundColor: project.color }}
          />
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between pt-3 border-t border-zinc-100">
        <div className="flex items-center gap-3 lg:gap-4 text-xs text-zinc-500">
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
