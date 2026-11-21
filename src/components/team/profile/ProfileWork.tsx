import Link from 'next/link';
import { CheckCircle2, FolderKanban, type LucideIcon } from 'lucide-react';
import { Badge, StatusBadge } from '@/components/ui/Badge';
import { SectionHeader } from '@/components/ui/SectionHeader';
import type { ProfileProject, ProfileWork as Work } from '@/lib/team/profile';
import { formatDueDate } from './format';

function EmptyRow({ icon: Icon, title, detail }: { icon: LucideIcon; title: string; detail: string }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
      <div className="w-10 h-10 rounded-full bg-white/[0.06] flex items-center justify-center mb-3">
        <Icon size={18} className="text-zinc-500" aria-hidden="true" />
      </div>
      <p className="text-sm font-medium text-zinc-300">{title}</p>
      <p className="text-xs text-zinc-500 mt-1">{detail}</p>
    </div>
  );
}

const PROJECT_STATUS: Record<string, string> = { completed: 'Completed', archived: 'Archived' };

/** The person's projects the viewer can open. */
export function ProfileProjects({ projects, shared }: { projects: ProfileProject[]; shared: boolean }) {
  return (
    <section aria-labelledby="profile-projects" className="min-w-0">
      <SectionHeader label={<span id="profile-projects">{shared ? 'Shared projects' : 'Projects'}</span>} count={projects.length} />
      <div className="glass-card rounded-xl overflow-hidden">
        {projects.length === 0 ? (
          <EmptyRow
            icon={FolderKanban}
            title={shared ? 'No shared projects' : 'Not on any projects'}
            detail={shared ? 'You are not on any of the same projects.' : 'Projects they join show up here.'}
          />
        ) : (
          <ul className="divide-y divide-white/[0.05]">
            {projects.map((project) => (
              <li key={project.id}>
                <Link
                  href={`/projects/${project.id}`}
                  className="flex items-center gap-3 px-5 py-2.5 hover:bg-white/[0.03] transition-colors focus:outline-none focus-visible:bg-white/[0.04] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500"
                >
                  <span className="h-2 w-2 rounded-full flex-shrink-0" style={{ backgroundColor: project.color }} aria-hidden="true" />
                  <span className="flex-1 min-w-0 text-sm text-zinc-200 truncate">{project.name}</span>
                  {PROJECT_STATUS[project.status] && <Badge className="flex-shrink-0">{PROJECT_STATUS[project.status]}</Badge>}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/**
 * What the person is working on: their open tasks (soonest due first) beside
 * their projects, all within the projects the viewer can open. The counts
 * sit in the profile's number strip (ProfileNumbers).
 */
export function ProfileWork({
  work,
  projects,
  today,
  shared,
  name,
}: {
  work: Work;
  projects: ProfileProject[];
  today: string;
  shared: boolean;
  name: string;
}) {
  const hidden = work.open - work.tasks.length;
  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_340px] gap-6 items-start">
      <section aria-labelledby="profile-tasks" className="min-w-0">
        <SectionHeader label={<span id="profile-tasks">Open tasks</span>} count={work.open} />
        <div className="glass-card rounded-xl overflow-hidden">
          {work.tasks.length === 0 ? (
            <EmptyRow icon={CheckCircle2} title="No open tasks" detail={`Nothing is assigned to ${name} right now.`} />
          ) : (
            <ul className="divide-y divide-white/[0.05]">
              {work.tasks.map((task) => {
                const overdue = !!task.due_date && task.due_date < today;
                return (
                  <li key={task.id}>
                    <Link
                      href={`/projects/${task.project_id}?task=${task.id}`}
                      className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3 px-5 py-2.5 hover:bg-white/[0.03] transition-colors focus:outline-none focus-visible:bg-white/[0.04] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500"
                    >
                      <span className="flex-1 min-w-0">
                        <span className="block text-sm text-zinc-100 truncate">{task.title}</span>
                        <span className="flex items-center gap-1.5 text-[11px] text-zinc-500 min-w-0">
                          <span className="h-1.5 w-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: task.project_color }} aria-hidden="true" />
                          <span className="truncate">{task.project_name}{task.is_subtask ? ', subtask' : ''}</span>
                        </span>
                      </span>
                      <span className="flex items-center gap-2 flex-shrink-0">
                        {task.due_date && (
                          <span className={`text-xs tabular-nums ${overdue ? 'text-amber-300' : 'text-zinc-400'}`}>
                            {overdue ? 'Overdue, ' : 'Due '}{formatDueDate(task.due_date)}
                          </span>
                        )}
                        <StatusBadge status={task.status} tooltip={false} />
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
          {hidden > 0 && (
            <p className="px-5 py-2.5 text-xs text-zinc-500 border-t border-white/[0.06]">
              Showing the {work.tasks.length} due soonest of {work.open} open tasks.
            </p>
          )}
        </div>
      </section>
      <ProfileProjects projects={projects} shared={shared} />
    </div>
  );
}
