'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { BookOpen, Calendar, CalendarCog, ChevronLeft, CircleAlert, Edit, LayoutGrid, Layers, ScrollText, Trash2, Users } from 'lucide-react';
import { useApp, defaultFilters } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { hasPermission, isModuleEnabled } from '@/lib/access-control';
import { useRead } from '@/lib/query-cache';
import { initiativeRead } from '@/lib/reads';
import { INITIATIVE_LABEL, inInitiative, initiativeProgress } from '@/lib/initiatives';
import { isDateOverdue } from '@/lib/date-utils';
import { useTaskUrlParam } from '@/lib/use-task-url';
import { Header } from '@/components/layout/Header';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { RowActionsMenu } from '@/components/ui/RowActionsMenu';
import { toast } from '@/components/ui/Toast';
import { LinkedText } from '@/components/ui/LinkedText';
import { TaskDetailPanel } from '@/components/tasks/TaskDetailPanel';
import { Bone, EmptyCard, Skeleton, SubNav, useKeptViews } from '@/components/projects/TabLayout';
import { ProjectTaskViews } from '@/components/projects/ProjectTaskViews';
import { ContextBrief } from '@/components/projects/BriefTab';
import { InitiativePanel } from '@/components/initiatives/InitiativePanel';
import { InitiativeLog } from '@/components/initiatives/InitiativeLog';
import { InitiativeTemplateStrip } from '@/components/initiatives/InitiativeTemplateStrip';
import { ChangeDatesPanel } from '@/components/templates/ChangeDatesPanel';
import { InitiativeProgressBar, InitiativeStatusPill, initiativeDatesLabel } from '@/components/initiatives/InitiativeBits';
import { leaveTrashNotice, trashInitiative, writeError } from '@/components/initiatives/initiative-actions';

type Segment = 'board' | 'log' | 'brief';

const CHIP = 'inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full bg-white/[0.04] px-2.5 py-1 text-xs text-zinc-300';

/**
 * One initiative: its header (status and health, owner, dates, progress,
 * open issues), then Board (the project's task views kept to its tasks; a
 * new task starts in it), Log (the dated record) and Brief (standing
 * knowledge, with the agents module). Guests read the board, not the log.
 */
export default function InitiativePage() {
  const params = useParams();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const projectId = params.id as string;
  const initiativeId = params.initiativeId as string;
  const { isDemoMode } = useDemo();
  const { access } = useAuth();
  const { getProject, tasks, team, deleteTask, setFilters, loading } = useApp();
  const read = useRead(initiativeRead(projectId, initiativeId, isDemoMode));
  const [editing, setEditing] = useState(false);
  const [changingDates, setChangingDates] = useState(false);
  const [confirmDeleteTask, setConfirmDeleteTask] = useState<string | null>(null);

  useEffect(() => { setFilters(defaultFilters); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const project = getProject(projectId);
  const detail = read.data;
  const initiative = detail?.initiative;
  const backHref = `/projects/${encodeURIComponent(projectId)}?tab=initiatives`;

  // The open task is the URL's ?task=, as on the project page.
  const { taskId: viewingTaskId, openTask, closeTask } = useTaskUrlParam();
  const viewingTask = viewingTaskId ? tasks.find((t) => t.id === viewingTaskId && t.project_id === projectId) ?? null : null;
  useEffect(() => {
    if (!viewingTaskId || loading || viewingTask) return;
    toast('error', 'That task no longer exists, or you do not have access to it');
    closeTask();
  }, [viewingTaskId, loading, viewingTask, closeTask]);

  const board = useMemo(() => inInitiative(initiativeId), [initiativeId]);
  const progress = initiativeProgress(tasks.filter((t) => t.project_id === projectId), initiativeId);
  const linkableTasks = tasks.filter((t) => t.project_id === projectId && t.initiative_id === initiativeId);

  // Guests read no log; the brief is the agents module's and needs its own grant (as the project's Brief tab).
  const canReadLog = !!detail && detail.recent_entries !== null;
  const canReadBrief = !!detail && isModuleEnabled(access, 'agents') && hasPermission(access, 'project_context.read')
    && detail.can.read_brief && !isDemoMode;
  const segments: { key: Segment; label: string; icon: typeof LayoutGrid; count?: number }[] = [
    { key: 'board', label: 'Tasks', icon: LayoutGrid },
    ...(canReadLog ? [{ key: 'log' as const, label: 'Log', icon: ScrollText }] : []),
    ...(canReadBrief ? [{ key: 'brief' as const, label: 'Brief', icon: BookOpen }] : []),
  ];
  const requested = searchParams.get('view');
  const segment: Segment = segments.find((s) => s.key === requested)?.key ?? 'board';
  const kept = useKeptViews(segment);
  const setSegment = (key: Segment) => {
    const next = new URLSearchParams(searchParams.toString());
    if (key === 'board') next.delete('view');
    else next.set('view', key);
    const query = next.toString();
    window.history.pushState(null, '', query ? `${pathname}?${query}` : pathname);
  };

  const back = (
    <Link
      href={backHref}
      className="inline-flex max-w-full items-center gap-1 text-zinc-400 hover:text-white transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 rounded"
    >
      <ChevronLeft size={14} className="flex-shrink-0" aria-hidden="true" />
      <span className="truncate">{project ? `${project.name}, ${INITIATIVE_LABEL.plural}` : INITIATIVE_LABEL.plural}</span>
    </Link>
  );

  if (!detail) {
    return (
      <div className="animate-fadeIn min-h-screen">
        <Header
          title={read.failed ? `${INITIATIVE_LABEL.singular} not found` : (
            <span className="inline-block h-7 w-56 max-w-full rounded bg-white/[0.06] motion-safe:animate-pulse align-middle">
              <span className="sr-only">Loading</span>
            </span>
          )}
          subtitle={back}
        />
        <div className="px-4 lg:px-6 pt-5 pb-6">
          {read.failed ? (
            <EmptyCard
              icon={<Layers />}
              title={`This ${INITIATIVE_LABEL.lower} isn't here`}
              description="It may have moved to Trash, or you may not have access to its project."
              action={<Link href={backHref}><Button size="sm" variant="secondary">Back to {INITIATIVE_LABEL.lowerPlural}</Button></Link>}
            />
          ) : (
            <Skeleton label={`Loading the ${INITIATIVE_LABEL.lower}`} className="glass-card rounded-xl p-5 space-y-3">
              <Bone className="h-4 w-1/3" />
              <Bone className="h-3 w-2/3" />
              <Bone className="h-1.5 w-1/2 mt-4" />
            </Skeleton>
          )}
        </div>
      </div>
    );
  }

  const live = initiative!;
  const ownerMember = live.owner?.kind === 'member' ? team.find((m) => m.id === live.owner?.id) : undefined;
  const dates = initiativeDatesLabel(live);
  const overdue = !!live.target_date && live.status !== 'done' && isDateOverdue(live.target_date);
  const openIssues = live.open_issue_count;

  // Acts at once: the Initiatives tab it lands on offers Undo in place.
  const doTrash = async () => {
    try {
      await trashInitiative(projectId, live.id, isDemoMode);
      leaveTrashNotice({ projectId, id: live.id, name: live.name });
      router.push(backHref);
    } catch (error) {
      toast('error', writeError(error, `Couldn't move the ${INITIATIVE_LABEL.lower} to Trash`));
    }
  };

  const menu = [
    ...(detail.can.edit ? [{ label: `Edit ${INITIATIVE_LABEL.lower}`, icon: <Edit size={14} />, onClick: () => setEditing(true) }] : []),
    ...(detail.can.trash ? [{ label: 'Move to Trash', icon: <Trash2 size={14} />, variant: 'danger' as const, divider: detail.can.edit, onClick: () => void doTrash() }] : []),
  ];

  return (
    <div className="animate-fadeIn min-h-screen">
      <Header
        title={live.name}
        subtitle={back}
        actions={(
          <div className="flex items-center gap-2">
            {detail.can.edit && (
              <Button variant="secondary" size="sm" icon={<Edit size={14} aria-hidden="true" />} onClick={() => setEditing(true)} className="max-sm:hidden">
                Edit
              </Button>
            )}
            {menu.length > 0 && (
              <RowActionsMenu
                label={`${INITIATIVE_LABEL.singular} actions`}
                triggerClassName="liquid-glass !p-0 w-9 h-9 flex items-center justify-center !text-zinc-300"
                actions={menu}
              />
            )}
          </div>
        )}
      />

      <div className="px-4 lg:px-6 pt-4 space-y-5 pb-4 lg:pb-6">
        {/* A template run made it: which template, the run's key dates, and Change dates for whoever may create tasks here. */}
        {detail.template_run && (
          <InitiativeTemplateStrip
            run={detail.template_run}
            action={detail.can.edit ? (
              <Button variant="ghost" size="sm" icon={<CalendarCog size={14} aria-hidden="true" />} onClick={() => setChangingDates(true)}>
                Change dates
              </Button>
            ) : undefined}
          />
        )}
        {changingDates && detail.template_run && (
          <ChangeDatesPanel
            run={detail.template_run}
            initiativeId={live.id}
            initiativeName={live.name}
            onClose={() => setChangingDates(false)}
            onRefresh={read.reload}
          />
        )}

        {/* What it is and where it stands. */}
        <section className="glass-card rounded-xl px-4 py-4 sm:px-5" aria-label={`About this ${INITIATIVE_LABEL.lower}`}>
          <div className="flex flex-wrap items-center gap-2">
            <InitiativeStatusPill initiative={live} size="md" />
            <span className={CHIP}>
              {live.owner ? (
                <>
                  {live.owner.kind === 'member'
                    ? <Avatar name={live.owner.name} src={ownerMember?.avatar || undefined} size="xs" />
                    : <Users size={13} className="flex-shrink-0 text-zinc-400" aria-hidden="true" />}
                  <span className="sr-only">Owner: </span>
                  <span className="truncate">{live.owner.name}</span>
                </>
              ) : <span className="text-zinc-400">No owner</span>}
            </span>
            {dates && (
              <span className={`${CHIP} ${overdue ? '!text-red-300' : ''}`}>
                <Calendar size={13} className="flex-shrink-0" aria-hidden="true" />
                <span className="truncate">{dates}{overdue ? ', past target' : ''}</span>
              </span>
            )}
            {openIssues !== null && openIssues > 0 && (
              <button
                type="button"
                onClick={() => setSegment('log')}
                className={`${CHIP} !bg-amber-500/[0.14] !text-amber-300 hover:!bg-amber-500/20 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500`}
              >
                <CircleAlert size={13} aria-hidden="true" />
                {openIssues} open {openIssues === 1 ? 'issue' : 'issues'}
              </button>
            )}
          </div>
          {live.description ? (
            <p className="mt-3 max-w-3xl text-sm leading-relaxed text-zinc-300 whitespace-pre-wrap break-words">
              <LinkedText text={live.description} />
            </p>
          ) : detail.can.edit ? (
            <button type="button" onClick={() => setEditing(true)} className="mt-3 text-sm text-zinc-500 hover:text-zinc-300 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
              Add a description
            </button>
          ) : null}
          <InitiativeProgressBar progress={progress} done={live.status === 'done'} className="mt-4 max-w-md" />
        </section>

        {segments.length > 1 && (
          <SubNav
            label={`${INITIATIVE_LABEL.singular} view`}
            active={segment}
            onChange={setSegment}
            items={segments.map((s) => ({ key: s.key, label: s.label, icon: s.icon }))}
          />
        )}

        {kept.has('board') && (
          <div hidden={segment !== 'board'}>
            <ProjectTaskViews
              projectId={projectId}
              taskFilter={board}
              newTaskInitiativeId={initiativeId}
              emptyTitle={`No tasks in this ${INITIATIVE_LABEL.lower} yet`}
              emptyDescription={{
                canCreate: `Use Add task, or pick this ${INITIATIVE_LABEL.lower} on any task in the project.`,
                cannot: `Tasks in this ${INITIATIVE_LABEL.lower} will show here.`,
              }}
              onOpenTask={openTask}
              onDeleteTask={setConfirmDeleteTask}
            />
          </div>
        )}

        {canReadLog && kept.has('log') && (
          <div hidden={segment !== 'log'}>
            <InitiativeLog
              projectId={projectId}
              initiativeId={initiativeId}
              canLog={detail.can.log}
              openIssueCount={openIssues ?? 0}
              linkableTasks={linkableTasks}
              onOpenTask={openTask}
            />
          </div>
        )}

        {canReadBrief && kept.has('brief') && (
          <div hidden={segment !== 'brief'}>
            <section className="glass-card rounded-xl px-4 py-4 sm:px-5" aria-labelledby="initiative-brief">
              <h2 id="initiative-brief" className="text-[15px] font-semibold text-white">{INITIATIVE_LABEL.singular} brief</h2>
              <p className="mt-0.5 mb-4 text-xs text-zinc-400">
                What every agent and person working on it should know. Pinned entries go into the context of agents on its tasks.
              </p>
              <ContextBrief
                scope={{ scope_type: 'initiative', scope_id: initiativeId }}
                label={`${INITIATIVE_LABEL.lower} brief`}
                emptyText={`Nothing here yet. Add what someone joining this ${INITIATIVE_LABEL.lower} should know.`}
              />
            </section>
          </div>
        )}
      </div>

      {editing && (
        <InitiativePanel projectId={projectId} initiative={live} onClose={() => setEditing(false)} />
      )}

      <TaskDetailPanel task={viewingTask} onClose={closeTask} onDelete={setConfirmDeleteTask} />

      <ConfirmDialog
        isOpen={!!confirmDeleteTask}
        onClose={() => setConfirmDeleteTask(null)}
        onConfirm={() => { if (confirmDeleteTask) deleteTask(confirmDeleteTask); }}
        title="Move task to Trash?"
        message="The task goes to Trash with its subtasks and comments."
        variant="danger"
        trash
      />

    </div>
  );
}
