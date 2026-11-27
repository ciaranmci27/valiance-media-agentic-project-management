'use client';

import { useState, useEffect, Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import { useApp, defaultFilters } from '@/lib/store';
import { Header } from '@/components/layout/Header';
import { ProjectForm } from '@/components/projects/ProjectForm';
import { CustomProjectBadges } from '@/components/projects/CustomProjectBadges';
import { projectTrashedLine } from '@/components/projects/trash-message';
import { useUndoTrash } from '@/components/projects/useUndoTrash';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { AvatarGroup } from '@/components/ui/Avatar';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { RowActionsMenu, type RowAction } from '@/components/ui/RowActionsMenu';
import { Plus, FolderKanban, Calendar, Users, Edit, Trash2 } from 'lucide-react';
import { Project } from '@/lib/types';
import { useAuth } from '@/lib/auth-context';
import { hasPermission } from '@/lib/access-control';
import { parseDateOnly } from '@/lib/date-utils';
import { useUnreadByProject } from '@/components/tasks/TaskUnread';
import { useWarmProject } from '@/lib/reads';
import { CountBadge } from '@/components/ui/CountBadge';
import { appLocale } from '@/lib/region';

function ProjectsContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { projects, team, deleteProject, getTasksByProject, getPrimaryClient, filters, setFilters } = useApp();
  const { access } = useAuth();
  const unreadByProject = useUnreadByProject();
  const warmProject = useWarmProject();
  const canManageProjects = hasPermission(access, 'projects.manage');
  const canReadContacts = hasPermission(access, 'contacts.read') || hasPermission(access, 'contacts.read_all');
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const undoTrash = useUndoTrash();

  useEffect(() => { setFilters(defaultFilters); }, []);

  // New projects are set up in the guided flow; an old ?new=true link goes there.
  useEffect(() => {
    if (canManageProjects && searchParams.get('new') === 'true') router.replace('/projects/new');
  }, [canManageProjects, searchParams, router]);

  const handleEdit = (project: Project) => {
    setEditingProject(project);
    setIsFormOpen(true);
  };

  // Moving to Trash acts at once and offers Undo (DESIGN.md Rule 6).
  const trashProject = async (project: Project) => {
    if (await deleteProject(project.id)) undoTrash('projects', project.id, { message: projectTrashedLine(project.name, access) });
  };

  const handleCloseForm = () => {
    setIsFormOpen(false);
    setEditingProject(null);
  };

  const searchLower = filters.search.toLowerCase();
  const filtered = filters.search
    ? projects.filter(p =>
        p.name.toLowerCase().includes(searchLower) ||
        p.description.toLowerCase().includes(searchLower))
    : projects;

  const activeProjects = filtered.filter(p => p.status === 'active');
  const completedProjects = filtered.filter(p => p.status === 'completed');
  const archivedProjects = filtered.filter(p => p.status === 'archived');

  const getProgress = (project: Project) => {
    const tasks = getTasksByProject(project.id);
    const done = tasks.filter(t => t.status === 'done').length;
    return { pct: tasks.length > 0 ? Math.round((done / tasks.length) * 100) : 0, total: tasks.length };
  };

  const buildActions = (p: Project): RowAction[] => [
    { label: 'Edit', icon: <Edit size={14} />, onClick: () => handleEdit(p) },
    { label: 'Move to Trash', icon: <Trash2 size={14} />, variant: 'danger', onClick: () => void trashProject(p) },
  ];

  // A project's unread tasks, the same badge as beside it in the sidebar.
  const unreadBadge = (project: Project) => {
    const count = unreadByProject.get(project.id) ?? 0;
    return <CountBadge count={count} label={`${count} unread task${count === 1 ? '' : 's'}`} />;
  };

  const mobileCard = (p: Project) => {
    const { pct, total } = getProgress(p);
    const members = team.filter(m => p.member_ids.includes(m.id));
    const client = canReadContacts ? getPrimaryClient(p.id) : undefined;
    return (
      <div className="glass-card rounded-xl p-4 hover:border-white/[0.12] transition-colors">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <Link
                href={`/projects/${p.id}`}
                onClick={(e) => e.stopPropagation()}
                onMouseEnter={() => warmProject(p.id)}
                onFocus={() => warmProject(p.id)}
                className="font-semibold text-white inline-flex items-center gap-2 truncate focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 rounded"
              >
                {p.color && <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: p.color }} />}
                <span className="truncate">{p.name}</span>
              </Link>
              {unreadBadge(p)}
              <CustomProjectBadges project={p} />
            </div>
            {client?.contact && (
              <p className="mt-1 text-xs text-zinc-400 truncate">{client.contact.name}</p>
            )}
          </div>
          {canManageProjects && <RowActionsMenu actions={buildActions(p)} label={`Actions for ${p.name}`} />}
        </div>

        <p className="mt-3 text-sm text-zinc-400 line-clamp-2">
          {p.description || <span className="text-zinc-500">No description</span>}
        </p>

        {total > 0 && (
          <div className="mt-3 flex items-center gap-2">
            <div className="flex-1 h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
              <div className="h-full rounded-full bg-brand-500" style={{ width: `${pct}%` }} />
            </div>
            <span className="text-xs text-zinc-400 tabular-nums">{pct}%</span>
          </div>
        )}

        <div className="mt-3 flex items-center justify-between pt-3 border-t border-white/[0.06] text-xs text-zinc-400">
          <div className="flex items-center gap-3">
            {p.due_date && (
              <span className="inline-flex items-center gap-1"><Calendar size={13} className="text-zinc-500" />{parseDateOnly(p.due_date).toLocaleDateString(appLocale(), { month: 'short', day: 'numeric' })}</span>
            )}
            {members.length > 0 && <span className="inline-flex items-center gap-1"><Users size={13} className="text-zinc-500" />{members.length}</span>}
          </div>
          {members.length > 0 && <AvatarGroup users={members} max={3} size="xs" />}
        </div>
      </div>
    );
  };

  const showClientColumn = canReadContacts && projects.some(p => !!getPrimaryClient(p.id)?.contact);

  const columns: Column<Project>[] = [
    {
      key: 'name',
      header: 'Name',
      width: 'w-[24%]',
      sortValue: (p) => p.name.toLowerCase(),
      render: (p) => (
        <div className="flex items-center gap-2 min-w-0">
          {p.color && (
            <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: p.color }} />
          )}
          <Link
            href={`/projects/${p.id}`}
            onClick={(e) => e.stopPropagation()}
            onMouseEnter={() => warmProject(p.id)}
            onFocus={() => warmProject(p.id)}
            className="font-semibold text-white hover:text-brand-300 transition-colors truncate focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 rounded"
          >
            {p.name}
          </Link>
          {unreadBadge(p)}
          <CustomProjectBadges project={p} />
        </div>
      ),
    },
    // Without contacts, or when no project has a client yet, there is no
    // client to show: no column of empty cells, Description takes its width.
    ...(showClientColumn ? [{
      key: 'client',
      header: 'Client',
      width: 'w-[14%]',
      className: 'hidden md:table-cell',
      render: (p) => {
        const client = getPrimaryClient(p.id);
        return client?.contact
          ? <span className="text-zinc-300 truncate block">{client.contact.name}</span>
          : <span className="text-zinc-500">No client</span>;
      },
    } satisfies Column<Project>] : []),
    {
      key: 'description',
      header: 'Description',
      width: showClientColumn ? 'w-[24%]' : 'w-[38%]',
      className: 'hidden lg:table-cell',
      render: (p) => p.description
        ? <span className="text-zinc-400 truncate block">{p.description}</span>
        : <span className="text-zinc-500">No description</span>,
    },
    {
      key: 'progress',
      header: 'Progress',
      width: 'w-[16%]',
      className: 'hidden sm:table-cell',
      sortValue: (p) => getProgress(p).pct,
      render: (p) => {
        const { pct, total } = getProgress(p);
        if (total === 0) return <span className="text-zinc-500 text-xs">No tasks</span>;
        return (
          <div className="flex items-center gap-2 min-w-[120px]">
            <div className="flex-1 h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
              <div className="h-full rounded-full bg-brand-500 transition-all" style={{ width: `${pct}%` }} />
            </div>
            <span className="text-xs text-zinc-400 tabular-nums w-8 text-right">{pct}%</span>
          </div>
        );
      },
    },
    {
      key: 'due',
      header: 'Due',
      width: 'w-[10%]',
      className: 'hidden sm:table-cell',
      sortValue: (p) => p.due_date ? parseDateOnly(p.due_date).getTime() : Infinity,
      render: (p) => p.due_date
        ? (
          <span className="inline-flex items-center gap-1 text-zinc-300 whitespace-nowrap">
            <Calendar size={14} className="text-zinc-500" />
            {parseDateOnly(p.due_date).toLocaleDateString(appLocale(), { month: 'short', day: 'numeric' })}
          </span>
        )
        : <span className="text-zinc-500">No date</span>,
    },
    {
      key: 'team',
      header: 'Team',
      width: 'w-[12%]',
      render: (p) => {
        const members = team.filter(m => p.member_ids.includes(m.id));
        // The faces carry the count (+N past three), so no separate number squeezes them.
        return members.length > 0
          ? <AvatarGroup users={members} max={3} size="xs" />
          : <span className="text-zinc-500 text-xs">No one yet</span>;
      },
    },
    ...(canManageProjects ? [{
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right' as const,
      width: 'w-12',
      render: (p: Project) => <RowActionsMenu actions={buildActions(p)} label={`Actions for ${p.name}`} />,
    }] : []),
  ];

  const renderSection = (key: string, label: string, rows: Project[]) => (
    <section key={key}>
      <SectionHeader label={label} count={rows.length} />
      <DataTable
        columns={columns}
        data={rows}
        keyExtractor={(p) => p.id}
        onRowClick={(p) => router.push(`/projects/${p.id}`)}
        stickyHeader={false}
        fixedLayout
        mobileCard={mobileCard}
      />
    </section>
  );

  return (
    <>
      <Header
        title="Projects"
        subtitle={<span className="hidden sm:inline">{projects.length} {projects.length === 1 ? 'project' : 'projects'}</span>}
        searchPlaceholder="Search projects"
        // One primary action; Trash sits in the page menu so a phone keeps one header row (Rule 17).
        actions={canManageProjects ? (
          <div className="flex items-center gap-2">
            <Button href="/projects/new" icon={<Plus size={16} aria-hidden="true" />}>
              New project
            </Button>
            <RowActionsMenu
              label="More project actions"
              triggerClassName="liquid-glass !p-0 w-9 h-9 flex items-center justify-center !text-zinc-300"
              actions={[{ label: 'Projects in Trash', icon: <Trash2 size={14} />, onClick: () => router.push('/settings/trash?group=projects') }]}
            />
          </div>
        ) : undefined}
      />

      <div className="p-4 lg:p-6 space-y-6">
        {projects.length === 0 ? (
          <EmptyState
            framed
            icon={<FolderKanban />}
            title="No projects yet"
            description={canManageProjects ? 'Set one up and its tasks, time and files live in it.' : 'Projects you are added to show here.'}
            action={canManageProjects ? <Button href="/projects/new" icon={<Plus size={16} aria-hidden="true" />}>Set up a project</Button> : undefined}
          />
        ) : filtered.length === 0 ? (
          <EmptyState framed variant="filtered" title="No projects match your search" onClearFilters={() => setFilters({ ...filters, search: '' })} />
        ) : (
          <>
            {activeProjects.length > 0 && renderSection('active', 'Active', activeProjects)}
            {completedProjects.length > 0 && renderSection('completed', 'Completed', completedProjects)}
            {archivedProjects.length > 0 && renderSection('archived', 'Archived', archivedProjects)}
          </>
        )}
      </div>

      {canManageProjects && <ProjectForm
        isOpen={isFormOpen}
        onClose={handleCloseForm}
        project={editingProject}
      />}

    </>
  );
}

export default function ProjectsPage() {
  return (
    <Suspense fallback={null}>
      <ProjectsContent />
    </Suspense>
  );
}
