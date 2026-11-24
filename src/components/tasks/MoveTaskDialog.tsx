'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { FolderInput, UserMinus, UserPlus } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Avatar } from '@/components/ui/Avatar';
import { Select } from '@/components/ui/inputs/Select';
import { toast } from '@/components/ui/Toast';
import type { RowAction } from '@/components/ui/RowActionsMenu';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { hasPermission, type AccessContext } from '@/lib/access-control';
import type { Task } from '@/lib/types';

/** Someone on the task who could not open the new project (task-move.ts). */
export interface MoveLosingMember {
  id: string;
  name: string;
  on: ('assigned' | 'claimed')[];
  can_be_added: boolean;
}

export type LostAccessChoice = 'refuse' | 'unassign' | 'add_to_project';

/** What the dialog asks before moving: who would lose the work, and which tasks cannot go at all. */
export interface MovePlan {
  losing: MoveLosingMember[];
  can_unassign: boolean;
  can_add_members: boolean;
  refused: { title: string; reason: string }[];
}

export interface MoveOutcome {
  moved: number;
  failed: { title: string; reason: string }[];
}

/** How the dialog moves: one task at a time from the task routes, or a thread's tasks in one call. */
export interface MoveRunner {
  plan: (projectId: string) => Promise<MovePlan>;
  move: (projectId: string, lostAccess: LostAccessChoice) => Promise<MoveOutcome>;
}

export interface MovableTask {
  id: string;
  title: string;
  project_id: string;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'That did not work');
  return payload.data as T;
}

/** Moves tasks through /api/workspace/tasks/{id}/move, and shows each where it went at once. */
export function useTaskMoveRunner(tasks: MovableTask[]): MoveRunner {
  const { applyTaskMove } = useApp();
  return useMemo(() => ({
    async plan(projectId) {
      const plans = await Promise.all(tasks.map(async (task) => {
        try {
          return { task, plan: await postJson<{ losing: MoveLosingMember[]; can_unassign: boolean; can_add_members: boolean }>(`/api/workspace/tasks/${encodeURIComponent(task.id)}/move`, { project_id: projectId, dry_run: true }) };
        } catch (error) {
          return { task, error: error instanceof Error ? error.message : 'That did not work' };
        }
      }));
      const losing = new Map<string, MoveLosingMember>();
      let canUnassign = false;
      let canAddMembers = false;
      const refused: MovePlan['refused'] = [];
      for (const entry of plans) {
        if ('error' in entry) { refused.push({ title: entry.task.title, reason: entry.error ?? '' }); continue; }
        canUnassign = entry.plan.can_unassign;
        canAddMembers = entry.plan.can_add_members;
        for (const member of entry.plan.losing) {
          const known = losing.get(member.id);
          losing.set(member.id, known ? { ...known, on: [...new Set([...known.on, ...member.on])] } : member);
        }
      }
      return { losing: [...losing.values()], can_unassign: canUnassign, can_add_members: canAddMembers, refused };
    },
    async move(projectId, lostAccess) {
      let moved = 0;
      const failed: MoveOutcome['failed'] = [];
      for (const task of tasks) {
        try {
          const result = await postJson<{ removed: string[] }>(`/api/workspace/tasks/${encodeURIComponent(task.id)}/move`, { project_id: projectId, lost_access: lostAccess });
          applyTaskMove(task.id, projectId, result.removed);
          moved++;
        } catch (error) {
          failed.push({ title: task.title, reason: error instanceof Error ? error.message : 'That did not work' });
        }
      }
      return { moved, failed };
    },
  }), [tasks, applyTaskMove]);
}

/** Who may move a task: someone who can edit it and create tasks elsewhere. A subtask moves with its parent. */
export function canMoveTask(access: AccessContext | null | undefined, task: Pick<Task, 'parent_task_id'>, canEdit: boolean): boolean {
  return canEdit && !task.parent_task_id && hasPermission(access, 'tasks.create');
}

const ROLE_WORDS: Record<MoveLosingMember['on'][number], string> = { assigned: 'Assigned', claimed: 'Holds a claim' };

/**
 * Moves one or more tasks to another project. A searchable list of the
 * projects the member can move to (or a fixed one, when a thread moved
 * there), then, when someone on the work could not open that project, who
 * they are and what to do about it: take them off, or add them to the
 * project (for someone who may manage its members). Access is never granted
 * without asking.
 */
export function MoveTaskDialog({ tasks, isOpen, onClose, runner, targetProjectId, title, intro, onMoved }: {
  tasks: MovableTask[];
  isOpen: boolean;
  onClose: () => void;
  runner: MoveRunner;
  /** Fixed destination: the dialog only confirms the list. */
  targetProjectId?: string;
  title?: string;
  intro?: ReactNode;
  onMoved?: (projectId: string) => void;
}) {
  const { projects, team } = useApp();
  const [projectId, setProjectId] = useState(targetProjectId ?? '');
  const [plan, setPlan] = useState<MovePlan | null>(null);
  const [working, setWorking] = useState<LostAccessChoice | 'plan' | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  const projectName = (id: string) => projects.find((project) => project.id === id)?.name ?? 'the project';
  // Live projects other than the one they are all in already.
  const options = useMemo(() => {
    const current = new Set(tasks.map((task) => task.project_id));
    return projects
      .filter((project) => project.status !== 'archived' && !(current.size === 1 && current.has(project.id)))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((project) => ({ value: project.id, label: project.name }));
  }, [projects, tasks]);
  const target = projectId ? projectName(projectId) : null;
  const one = tasks.length === 1;

  const close = () => {
    setPlan(null);
    setRefusal(null);
    setWorking(null);
    if (!targetProjectId) setProjectId('');
    onClose();
  };

  const finish = async (choice: LostAccessChoice) => {
    setWorking(choice);
    const outcome = await runner.move(projectId, choice);
    setWorking(null);
    if (outcome.moved > 0) {
      toast('success', outcome.moved === 1 && one ? `Moved to ${target}` : `Moved ${outcome.moved} ${outcome.moved === 1 ? 'task' : 'tasks'} to ${target}`);
      onMoved?.(projectId);
    }
    if (outcome.failed.length) {
      toast('error', outcome.failed.length === 1 ? `"${outcome.failed[0].title}" stayed: ${outcome.failed[0].reason}` : `${outcome.failed.length} tasks stayed where they were`);
    }
    if (outcome.failed.length === 0 || outcome.moved > 0) close();
  };

  const start = async () => {
    if (!projectId) return;
    setWorking('plan');
    setRefusal(null);
    try {
      const next = await runner.plan(projectId);
      if (next.refused.length === tasks.length) {
        setWorking(null);
        setRefusal(next.refused.length === 1 ? next.refused[0].reason : 'None of these can move. Open each task to see why.');
        return;
      }
      if (next.losing.length > 0 || next.refused.length > 0) {
        setWorking(null);
        setPlan(next);
        return;
      }
      await finish('refuse');
    } catch (error) {
      setWorking(null);
      setRefusal(error instanceof Error ? error.message : 'That did not work');
    }
  };

  const avatarOf = (id: string) => team.find((member) => member.id === id)?.avatar || undefined;
  const allAddable = !!plan && plan.losing.every((member) => member.can_be_added);
  const busy = working !== null;

  return (
    <Modal isOpen={isOpen} onClose={close} title={title ?? (one ? 'Move to another project' : `Move ${tasks.length} tasks`)} size="lg">
      <div className="space-y-5">
        {!plan ? (
          <>
            {intro ?? (
              <p className="text-sm text-zinc-300">
                {one ? <>&ldquo;{tasks[0].title}&rdquo; moves</> : <>These tasks move</>} with {one ? 'its' : 'their'} subtasks, comments, files and reminders.
              </p>
            )}
            {targetProjectId ? (
              <ul className="divide-y divide-white/[0.05] overflow-hidden rounded-lg border border-white/[0.06] bg-white/[0.02]" aria-label="Tasks to move">
                {tasks.map((task) => (
                  <li key={task.id} className="flex min-w-0 items-center gap-2.5 px-3 py-2">
                    <FolderInput size={13} className="flex-shrink-0 text-zinc-400" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-zinc-100">{task.title}</span>
                    <span className="flex-shrink-0 text-[11px] text-zinc-400">{projectName(task.project_id)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <Select
                label="Project"
                visibleLabel="Move to"
                value={projectId}
                onChange={(value) => { setProjectId(value); setRefusal(null); }}
                options={options}
                searchable
                placeholder={options.length ? 'Search projects' : 'No other project to move to'}
                emptyText="No matching projects."
                helperText="Projects you can add tasks to."
              />
            )}
            {refusal && <p role="alert" className="rounded-lg bg-red-500/[0.1] px-3 py-2 text-xs text-red-200">{refusal}</p>}
            <div className="flex justify-end gap-2 border-t border-white/[0.08] pt-4">
              <Button variant="ghost" onClick={close}>Cancel</Button>
              <Button onClick={() => void start()} disabled={busy || !projectId}>
                {busy ? 'Moving...' : target ? `Move to ${target}` : 'Move'}
              </Button>
            </div>
          </>
        ) : (
          <>
            {plan.losing.length > 0 && (
              <div className="space-y-2.5">
                <p className="text-sm text-zinc-300">
                  {plan.losing.length === 1 ? 'This person cannot' : 'These people cannot'} open {target}. Moving takes the work out of their reach.
                </p>
                <ul className="divide-y divide-white/[0.05] overflow-hidden rounded-lg border border-white/[0.06] bg-white/[0.02]" aria-label="Who would lose it">
                  {plan.losing.map((member) => (
                    <li key={member.id} className="flex min-w-0 items-center gap-2.5 px-3 py-2">
                      <Avatar name={member.name} src={avatarOf(member.id)} size="xs" />
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-zinc-100">{member.name}</span>
                      <span className="flex-shrink-0 text-[11px] text-zinc-400">{member.on.map((role) => ROLE_WORDS[role]).join(', ')}</span>
                    </li>
                  ))}
                </ul>
                {!plan.can_unassign && !(plan.can_add_members && allAddable) && (
                  <p className="text-xs text-zinc-400">Someone who manages every task, or the project&apos;s members, can move it.</p>
                )}
                {plan.can_add_members && !allAddable && (
                  <p className="text-xs text-zinc-400">Not everyone here can open projects as a member, so adding them is not offered.</p>
                )}
              </div>
            )}
            {plan.refused.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-zinc-400">{plan.refused.length === 1 ? 'This one stays where it is' : 'These stay where they are'}</p>
                <ul className="space-y-1 text-xs text-zinc-300">
                  {plan.refused.map((item, index) => (
                    <li key={index} className="break-words [overflow-wrap:anywhere]"><span className="text-zinc-100">{item.title}</span>: {item.reason}</li>
                  ))}
                </ul>
              </div>
            )}
            <div className="flex flex-wrap justify-end gap-2 border-t border-white/[0.08] pt-4">
              <Button variant="ghost" onClick={() => setPlan(null)} disabled={busy}>Back</Button>
              {plan.losing.length === 0 ? (
                <Button onClick={() => void finish('refuse')} disabled={busy}>{busy ? 'Moving...' : `Move the rest to ${target}`}</Button>
              ) : (
                <>
                  {plan.can_add_members && allAddable && (
                    <Button variant="secondary" onClick={() => void finish('add_to_project')} disabled={busy} icon={<UserPlus size={14} aria-hidden="true" />}>
                      {working === 'add_to_project' ? 'Adding...' : 'Add them to the project'}
                    </Button>
                  )}
                  {plan.can_unassign && (
                    <Button onClick={() => void finish('unassign')} disabled={busy} icon={<UserMinus size={14} aria-hidden="true" />}>
                      {working === 'unassign' ? 'Moving...' : 'Remove them'}
                    </Button>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

/**
 * The task menu's "Move to project...", with the dialog it opens. Offered to
 * whoever may edit the task and create tasks; a subtask moves with its parent.
 */
export function useMoveTaskMenuAction(task: Task, canEdit: boolean): { actions: RowAction[]; dialog: ReactNode } {
  const { access } = useAuth();
  const [open, setOpen] = useState(false);
  if (!canMoveTask(access, task, canEdit)) return { actions: [], dialog: null };
  return {
    actions: [{ label: 'Move to project...', icon: <FolderInput size={14} aria-hidden="true" />, onClick: () => setOpen(true) }],
    // Mounted only while open: every board card carries this hook.
    dialog: open ? <TaskMoveDialog tasks={[task]} onClose={() => setOpen(false)} /> : null,
  };
}

/** The dialog for tasks moved from their own menus (a row, the panel, bulk, the agent's receipt). */
export function TaskMoveDialog({ tasks, onClose, onMoved }: { tasks: MovableTask[]; onClose: () => void; onMoved?: (projectId: string) => void }) {
  const runner = useTaskMoveRunner(tasks);
  return <MoveTaskDialog tasks={tasks} isOpen onClose={onClose} runner={runner} onMoved={onMoved} />;
}
