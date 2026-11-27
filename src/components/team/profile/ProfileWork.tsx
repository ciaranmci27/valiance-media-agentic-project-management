import Link from 'next/link';
import { CheckCircle2, FolderKanban, ListTodo } from 'lucide-react';
import { Badge, StatusBadge } from '@/components/ui/Badge';
import { Card, CardRow } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import type { ProfileProject, ProfileWork as Work } from '@/lib/team/profile';
import { formatDueDate } from './format';

/** A card title's count, the calm way (as on /design). */
const count = (n: number) => <span className="text-xs font-normal tabular-nums text-zinc-500">{n}</span>;

const PROJECT_STATUS: Record<string, string> = { completed: 'Completed', archived: 'Archived' };

const ROW = 'px-4 py-2.5 lg:px-5 hover:bg-white/[0.03] transition-colors focus:outline-none focus-visible:bg-white/[0.04] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500';

/**
 * The person's projects the viewer can open. `fill` when it sits beside
 * their open tasks: the card takes the row's height and its list scrolls.
 */
export function ProfileProjects({ projects, shared, fill = false }: { projects: ProfileProject[]; shared: boolean; fill?: boolean }) {
  return (
    <Card
      title={shared ? 'Shared projects' : 'Projects'}
      icon={<FolderKanban />}
      afterTitle={count(projects.length)}
      id="profile-projects"
      fill={fill}
      className="overflow-hidden"
      bodyClassName="pb-1"
    >
      {projects.length === 0 ? (
        <EmptyState
          compact
          icon={<FolderKanban />}
          title={shared ? 'No shared projects' : 'Not on any projects'}
          description={shared ? 'You are not on any of the same projects.' : 'Projects they join show up here.'}
        />
      ) : (
        <ul className={`divide-y divide-white/[0.05] border-t border-white/[0.06] ${fill ? 'card-scroll' : ''}`}>
          {projects.map((project) => (
            <li key={project.id}>
              <Link href={`/projects/${project.id}`} className={`flex items-center gap-3 ${ROW}`}>
                <span className="h-2 w-2 rounded-full flex-shrink-0" style={{ backgroundColor: project.color }} aria-hidden="true" />
                <span className="flex-1 min-w-0 text-sm text-zinc-200 truncate">{project.name}</span>
                {PROJECT_STATUS[project.status] && <Badge className="flex-shrink-0">{PROJECT_STATUS[project.status]}</Badge>}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/**
 * What the person is working on: their open tasks (soonest due first) beside
 * their projects, all within the projects the viewer can open. The two cards
 * share one height (DESIGN.md Rule 14), the projects list scrolling in its
 * own area. The counts sit in the profile's number strip (ProfileNumbers).
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
    <CardRow className="lg:grid-cols-[minmax(0,1fr)_340px]">
      <Card
        title="Open tasks"
        icon={<ListTodo />}
        afterTitle={count(work.open)}
        id="profile-tasks"
        fill
        className="overflow-hidden"
        bodyClassName="pb-1"
      >
        {work.tasks.length === 0 ? (
          <EmptyState compact icon={<CheckCircle2 />} title="No open tasks" description={`Nothing is assigned to ${name} right now.`} className="flex-1" />
        ) : (
          <ul className="divide-y divide-white/[0.05] border-t border-white/[0.06]">
            {work.tasks.map((task) => {
              const overdue = !!task.due_date && task.due_date < today;
              return (
                <li key={task.id}>
                  <Link
                    href={`/projects/${task.project_id}?task=${task.id}`}
                    className={`flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3 ${ROW}`}
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
          <p className="card-foot px-4 pt-2.5 pb-1.5 text-xs text-zinc-500 lg:px-5">
            Showing the {work.tasks.length} due soonest of {work.open} open tasks.
          </p>
        )}
      </Card>
      <ProfileProjects projects={projects} shared={shared} fill />
    </CardRow>
  );
}
