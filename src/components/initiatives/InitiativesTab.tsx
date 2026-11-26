'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Calendar, CircleAlert, Eye, EyeOff, History, Layers, Plus, RefreshCw, Users } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { hasPermission } from '@/lib/access-control';
import { useRead, warmRead } from '@/lib/query-cache';
import { initiativeRead, projectInitiativesRead } from '@/lib/reads';
import {
  INITIATIVE_LABEL, isOpenInitiative, progressByInitiative, sortInitiatives, type InitiativeView,
} from '@/lib/initiatives';
import { isDateOverdue } from '@/lib/date-utils';
import { timeAgo } from '@/lib/task-times';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Tooltip } from '@/components/ui/Tooltip';
import { toast } from '@/components/ui/Toast';
import { Bone, EmptyCard, Skeleton, TabToolbar, ToolbarButton } from '@/components/projects/TabLayout';
import { NeedsApprovalDrafts } from '@/components/templates/TemplateDraftCards';
import { InitiativePanel } from './InitiativePanel';
import { InitiativeProgressBar, InitiativeStatusPill, shortDay } from './InitiativeBits';
import { clearTrashNotice, peekTrashNotice, restoreInitiative, writeError } from './initiative-actions';

export const initiativeHref = (projectId: string, initiativeId: string) =>
  `/projects/${encodeURIComponent(projectId)}/initiatives/${encodeURIComponent(initiativeId)}`;

/**
 * A project's initiatives as cards: name, description, owner, status (and
 * health while active), target date, progress from the tasks on screen and
 * the log's last update. Done ones wait behind "Show done". Anyone who may
 * create tasks here starts a new one in the side panel. Template runs an
 * agent drafted here wait above them, under "Needs approval".
 */
export function InitiativesTab({ projectId }: { projectId: string }) {
  const router = useRouter();
  const { isDemoMode } = useDemo();
  const { access } = useAuth();
  const { tasks } = useApp();
  const canCreate = hasPermission(access, 'tasks.create');
  const read = useRead(projectInitiativesRead(projectId, isDemoMode));
  const [showDone, setShowDone] = useState(false);
  const [creating, setCreating] = useState(false);
  // An initiative just moved to Trash from its page: one line with Undo.
  const [trashed, setTrashed] = useState(() => peekTrashNotice(projectId));
  const [undoing, setUndoing] = useState(false);
  useEffect(() => { if (trashed) clearTrashNotice(trashed.id); }, [trashed]);

  // Progress counts the project's top-level tasks the store holds (what this person can see).
  const progress = useMemo(() => progressByInitiative(tasks.filter((task) => task.project_id === projectId)), [tasks, projectId]);
  const all = useMemo(() => sortInitiatives(read.data ?? []), [read.data]);
  const open = all.filter(isOpenInitiative);
  const done = all.filter((initiative) => !isOpenInitiative(initiative));
  const shown = showDone ? [...open, ...done] : open;

  const undo = async () => {
    if (!trashed) return;
    setUndoing(true);
    try {
      await restoreInitiative(projectId, trashed.id, isDemoMode);
      setTrashed(null);
    } catch (error) {
      toast('error', writeError(error, `Couldn't restore the ${INITIATIVE_LABEL.lower}`));
    } finally {
      setUndoing(false);
    }
  };

  const panel = creating && (
    <InitiativePanel
      projectId={projectId}
      onClose={() => setCreating(false)}
      onSaved={(id) => router.push(initiativeHref(projectId, id))}
    />
  );

  const notice = trashed && (
    <p role="status" className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-white/[0.04] px-4 py-2.5 text-sm text-zinc-300">
      <span className="min-w-0 break-words">Moved {trashed.name} to Trash.</span>
      <button
        type="button"
        onClick={() => void undo()}
        disabled={undoing}
        className="font-medium text-brand-300 hover:text-brand-200 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 rounded"
      >
        {undoing ? 'Restoring' : 'Undo'}
      </button>
    </p>
  );

  if (read.loading) {
    return (
      <Skeleton label={`Loading ${INITIATIVE_LABEL.lowerPlural}`} className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="glass-card rounded-xl p-5 space-y-3">
            <Bone className="h-4 w-2/3" />
            <Bone className="h-3 w-full" />
            <Bone className="h-3 w-4/5" />
            <Bone className="h-1.5 w-full mt-4" />
          </div>
        ))}
      </Skeleton>
    );
  }

  if (read.failed) {
    return (
      <EmptyCard
        icon={<Layers />}
        title={`Couldn't load ${INITIATIVE_LABEL.lowerPlural}`}
        description="Check your connection and try again."
        action={<Button size="sm" variant="secondary" icon={<RefreshCw size={14} aria-hidden="true" />} onClick={read.reload}>Try again</Button>}
      />
    );
  }

  if (all.length === 0) {
    return (
      <>
        {notice}
        <NeedsApprovalDrafts projectId={projectId} />
        <EmptyCard
          icon={<Layers />}
          title={`No ${INITIATIVE_LABEL.lowerPlural} yet`}
          description={`An ${INITIATIVE_LABEL.lower} is a body of work inside this project, with an owner, its own board of tasks and a log of updates and decisions.`}
          action={canCreate ? (
            <Button size="sm" icon={<Plus size={14} aria-hidden="true" />} onClick={() => setCreating(true)}>
              New {INITIATIVE_LABEL.lower}
            </Button>
          ) : undefined}
        />
        {panel}
      </>
    );
  }

  return (
    <>
      <TabToolbar
        extra={(
          <p className="text-sm text-zinc-400">
            {open.length} open
            {done.length > 0 && <span className="text-zinc-500">, {done.length} done</span>}
          </p>
        )}
        actions={done.length > 0 && (
          <ToolbarButton
            variant="secondary"
            icon={showDone ? <EyeOff /> : <Eye />}
            label={showDone ? 'Hide done' : `Show done (${done.length})`}
            onClick={() => setShowDone((v) => !v)}
            aria-pressed={showDone}
          />
        )}
        primary={canCreate && (
          <ToolbarButton icon={<Plus />} label={`New ${INITIATIVE_LABEL.lower}`} onClick={() => setCreating(true)} />
        )}
      />

      {notice}

      <NeedsApprovalDrafts projectId={projectId} />

      {shown.length === 0 ? (
        <EmptyCard
          icon={<Layers />}
          title={`Every ${INITIATIVE_LABEL.lower} is done`}
          description={`Show done to see them, or start a new ${INITIATIVE_LABEL.lower}.`}
        />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label={INITIATIVE_LABEL.plural}>
          {shown.map((initiative) => (
            <li key={initiative.id} className="min-w-0">
              <InitiativeCard
                initiative={initiative}
                progress={progress.get(initiative.id) ?? { done: 0, total: 0 }}
                onWarm={() => void warmRead(initiativeRead(projectId, initiative.id, isDemoMode))}
              />
            </li>
          ))}
        </ul>
      )}

      {panel}
    </>
  );
}

function InitiativeCard({ initiative, progress, onWarm }: {
  initiative: InitiativeView;
  progress: { done: number; total: number };
  onWarm: () => void;
}) {
  const { team } = useApp();
  const ownerMember = initiative.owner?.kind === 'member' ? team.find((member) => member.id === initiative.owner?.id) : undefined;
  const isDone = initiative.status === 'done';
  const overdue = !!initiative.target_date && !isDone && isDateOverdue(initiative.target_date);
  const openIssues = initiative.open_issue_count ?? 0;

  return (
    <Link
      href={initiativeHref(initiative.project_id, initiative.id)}
      onMouseEnter={onWarm}
      onFocus={onWarm}
      className="group flex h-full flex-col rounded-xl p-4 lg:p-5 glass-card-interactive focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="min-w-0 text-sm lg:text-base font-semibold leading-snug text-white transition-colors group-hover:text-brand-300 line-clamp-2 break-words">
          {initiative.name}
        </h3>
        <InitiativeStatusPill initiative={initiative} />
      </div>

      <p className="mt-1.5 text-xs lg:text-sm leading-relaxed text-zinc-400 line-clamp-2 break-words">
        {initiative.description || <span className="text-zinc-500">No description</span>}
      </p>

      <InitiativeProgressBar progress={progress} done={isDone} className="mt-4" />

      <div className="mt-auto pt-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-white/[0.06] pt-3 text-xs text-zinc-400">
          <span className="flex min-w-0 max-w-full items-center gap-1.5">
            {initiative.owner ? (
              <>
                {initiative.owner.kind === 'member'
                  ? <Avatar name={initiative.owner.name} src={ownerMember?.avatar || undefined} size="xs" />
                  : <Users size={14} aria-hidden="true" />}
                <span className="sr-only">Owner: </span>
                <span className="truncate text-zinc-300">{initiative.owner.name}</span>
              </>
            ) : (
              <span className="text-zinc-500">No owner</span>
            )}
          </span>
          {initiative.target_date && (
            <Tooltip content={overdue ? 'Past its target date' : 'Target date'}>
              <span className={`flex items-center gap-1 whitespace-nowrap ${overdue ? 'text-red-300' : ''}`}>
                <Calendar size={14} aria-hidden="true" />
                <span className="sr-only">Target date: </span>
                {shortDay(initiative.target_date)}
              </span>
            </Tooltip>
          )}
          {openIssues > 0 && (
            <span className="flex items-center gap-1 whitespace-nowrap text-amber-300">
              <CircleAlert size={14} aria-hidden="true" />
              {openIssues} open {openIssues === 1 ? 'issue' : 'issues'}
            </span>
          )}
          {initiative.last_entry_at && (
            <span className="ml-auto flex items-center gap-1 whitespace-nowrap">
              <History size={14} aria-hidden="true" />
              <span className="sr-only">Last update </span>
              <time dateTime={initiative.last_entry_at}>{timeAgo(initiative.last_entry_at)}</time>
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}
