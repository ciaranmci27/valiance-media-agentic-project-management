'use client';

import Link from 'next/link';
import { Calendar, Users, Edit, Trash2 } from 'lucide-react';
import { Project } from '@/lib/types';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { hasPermission } from '@/lib/access-control';
import { StatusBadge } from '@/components/ui/Badge';
import { AvatarGroup } from '@/components/ui/Avatar';
import { RowActionsMenu } from '@/components/ui/RowActionsMenu';
import { parseDateOnly } from '@/lib/date-utils';
import { appLocale } from '@/lib/region';
import { CustomProjectBadges } from './CustomProjectBadges';

interface ProjectCardProps {
  project: Project;
  onEdit?: (project: Project) => void;
  onDelete?: (id: string) => void;
}

export function ProjectCard({ project, onEdit, onDelete }: ProjectCardProps) {
  const { team, getTasksByProject, getPrimaryClient } = useApp();
  const { access } = useAuth();

  const canReadContacts = hasPermission(access, 'contacts.read') || hasPermission(access, 'contacts.read_all');

  const projectTasks = getTasksByProject(project.id);
  const completedTasks = projectTasks.filter(t => t.status === 'done').length;
  const progress = projectTasks.length > 0 ? Math.round((completedTasks / projectTasks.length) * 100) : 0;

  const members = team.filter(m => project.member_ids.includes(m.id));
  const primaryClient = canReadContacts ? getPrimaryClient(project.id) : undefined;

  const formatDate = (date: string | null) => {
    if (!date) return null;
    return parseDateOnly(date).toLocaleDateString(appLocale(), { month: 'short', day: 'numeric' });
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
            <CustomProjectBadges project={project} />
            {primaryClient?.contact && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-white/[0.06] text-zinc-300">
                {primaryClient.contact.name}
              </span>
            )}
          </div>
        </div>

        {(onEdit || onDelete) && (
          // Inside the card's link: the menu must not open the project.
          <div className="flex-shrink-0" onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}>
            <RowActionsMenu
              label={`Actions for ${project.name}`}
              actions={[
                ...(onEdit ? [{ label: 'Edit', icon: <Edit size={14} />, onClick: () => onEdit(project) }] : []),
                ...(onDelete ? [{ label: 'Move to Trash', icon: <Trash2 size={14} />, variant: 'danger' as const, divider: !!onEdit, onClick: () => onDelete(project.id) }] : []),
              ]}
            />
          </div>
        )}
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
