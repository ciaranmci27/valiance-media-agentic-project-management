'use client';

import { useState } from 'react';
import { AlignLeft, Bot, Briefcase, Calendar, CircleDot, Flag, LayoutTemplate, Lock, Tag, Users } from 'lucide-react';
import { TASK_TYPES, type AiReadiness, type Task, type TaskType } from '@/lib/types';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { canBeAssignedInProject, hasPermission, isModuleEnabled } from '@/lib/access-control';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { DateInput } from '@/components/ui/inputs/DateInput';
import { toast } from '@/components/ui/Toast';
import { TaskPanelShell } from './TaskPanelShell';
import { PanelHeader } from '@/components/ui/PanelHeader';
import { TemplatePicker } from '@/components/templates/UseTemplateButton';
import { UseTemplatePanel } from '@/components/templates/UseTemplatePanel';
import { InitiativeField } from '@/components/initiatives/InitiativeField';
import {
  DescriptionField, DetailRow, INLINE_DATE_CLASS, PeopleChips, PickField, PRIORITY_OPTIONS, STATUS_OPTIONS, TagsField, TitleField,
  taskTypeLabel, WHO_DOES_IT,
} from './TaskFields';

interface Draft {
  title: string;
  description: string;
  status: Task['status'];
  priority: Task['priority'];
  due_date: string;
  assignee_ids: string[];
  tags: string[];
  blocked_by_ids: string[];
  task_type: TaskType | null;
  ai_readiness: AiReadiness | null;
  initiative_id: string | null;
}

const dot = (color: string) => <span className={`h-2 w-2 flex-shrink-0 rounded-full ${color}`} aria-hidden="true" />;

/**
 * A new task, drafted where tasks are read: the side panel, every field
 * there to fill in, the title first. Enter on the title (or Create task)
 * makes it, and the panel turns into the task itself. Closing a draft with a
 * title keeps it as a task; closing one without a title throws it away, so
 * no empty task is ever left behind. Without managing every task, a new task
 * is yours, as the API makes it.
 */
export function NewTaskPanel({ projectId, initialDueDate, initialInitiativeId = null, onClose, onCreated }: {
  projectId: string;
  /** A calendar day's click. */
  initialDueDate?: string;
  /** The initiative it starts in (made from an initiative's board). */
  initialInitiativeId?: string | null;
  onClose: () => void;
  /** The task it became; the caller opens it. */
  onCreated: (task: Task) => void;
}) {
  const { team, tasks, getProject, addTask } = useApp();
  const { teamMemberId, access } = useAuth();
  const project = getProject(projectId);
  const canAssignOthers = hasPermission(access, 'tasks.manage_all');
  const showAgentFields = isModuleEnabled(access, 'agents') && hasPermission(access, 'agents.manage');
  const [draft, setDraft] = useState<Draft>(() => ({
    title: '',
    description: '',
    status: 'todo',
    priority: 'medium',
    due_date: initialDueDate ?? '',
    assignee_ids: !canAssignOthers && teamMemberId ? [teamMemberId] : [],
    tags: [],
    blocked_by_ids: [],
    task_type: null,
    ai_readiness: null,
    initiative_id: initialInitiativeId,
  }));
  const [creating, setCreating] = useState(false);
  // A template picked instead: its Use panel takes this one's place, and closing it comes back here.
  const [usingTemplate, setUsingTemplate] = useState<string | null>(null);
  // The title as typed so far: it is saved to the draft only on Enter or leaving the field.
  const [typed, setTyped] = useState('');
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => ({ ...current, [key]: value }));

  const create = async (title = typed.trim() || draft.title) => {
    const name = title.trim();
    if (!name || creating) return;
    setCreating(true);
    const created = await addTask({
      title: name,
      description: draft.description,
      status: draft.status,
      priority: draft.priority,
      due_date: draft.due_date || null,
      tags: draft.tags,
      project_id: projectId,
      assignee_ids: draft.assignee_ids,
      blocked_by_ids: draft.blocked_by_ids,
      ...(draft.initiative_id ? { initiative_id: draft.initiative_id } : {}),
      ...(showAgentFields ? { task_type: draft.task_type, ai_readiness: draft.ai_readiness } : {}),
      comments: [],
      acceptance_criteria: [],
    } as unknown as Omit<Task, 'id' | 'created_at' | 'updated_at'>);
    setCreating(false);
    // On failure the store has said why; the draft stays, nothing typed is lost.
    if (created) onCreated(created);
  };

  // A titled draft is kept as a task; an untitled one is thrown away.
  const close = () => {
    if ((typed || draft.title).trim()) void create();
    else onClose();
  };

  const assignable = team.filter((member) => !project || canBeAssignedInProject(member, project));
  const assignees = team.filter((member) => draft.assignee_ids.includes(member.id));
  const blockers = tasks.filter((t) => draft.blocked_by_ids.includes(t.id));
  const blockerChoices = tasks
    .filter((t) => t.project_id === projectId)
    .sort((a, b) => Number(a.status === 'done') - Number(b.status === 'done'));
  const status = STATUS_OPTIONS.find((option) => option.value === draft.status)!;
  const priority = PRIORITY_OPTIONS.find((option) => option.value === draft.priority)!;

  if (usingTemplate) {
    return <UseTemplatePanel templateId={usingTemplate} projectId={projectId} onClose={() => setUsingTemplate(null)} onDone={() => onClose()} />;
  }

  return (
    <TaskPanelShell
      labelledBy="new-task-title"
      onClose={close}
      header={
        <PanelHeader
          detail={project ? `In ${project.name}` : undefined}
          title={(
            <TitleField
              as="h2"
              id="new-task-title"
              value={draft.title}
              onChange={(title) => set('title', title)}
              onSubmit={(title) => void create(title)}
              onTyping={setTyped}
              canEdit
              autoFocus
              placeholder="What needs doing?"
              className="pt-0.5 text-base font-semibold text-white leading-snug break-words"
            />
          )}
          onClose={onClose}
          closeLabel="Discard new task"
        />
      }
      footer={
        <div className="flex items-center justify-between gap-3 border-t border-white/[0.06] px-5 py-3">
          <div className="flex min-w-0 items-center gap-3">
            {/* Tasks from a template land in no initiative, so an initiative's board leaves it out. */}
            {!initialInitiativeId && <TemplatePicker
              projectId={projectId}
              onPick={(template) => setUsingTemplate(template.id)}
              trigger={({ open, toggle }) => (
                <button
                  type="button"
                  onClick={toggle}
                  aria-expanded={open}
                  aria-haspopup="listbox"
                  className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 -mx-1.5 text-xs font-medium text-zinc-300 transition-colors hover:bg-white/[0.06] hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                >
                  <LayoutTemplate size={13} aria-hidden="true" />
                  From a template
                </button>
              )}
            />}
            <p className="hidden truncate text-xs text-zinc-400 sm:block">Enter in the title creates it.</p>
          </div>
          <Button size="sm" onClick={() => void create()} disabled={!(typed || draft.title).trim() || creating}>
            {creating ? 'Creating' : 'Create task'}
          </Button>
        </div>
      }
    >
      <div className="px-5 pb-5">
        <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
          <DetailRow icon={CircleDot} label="Status">
            <PickField
              label="Status"
              multiple={false}
              canEdit
              display={<span className="inline-flex items-center gap-2 text-zinc-200">{dot(status.color)}{status.label}</span>}
              selected={[draft.status]}
              options={STATUS_OPTIONS.map((option) => ({ value: option.value, label: option.label, leading: dot(option.color) }))}
              onChange={([next]) => next && set('status', next as Task['status'])}
            />
          </DetailRow>
          <DetailRow icon={Flag} label="Priority">
            <PickField
              label="Priority"
              multiple={false}
              canEdit
              display={<span className="inline-flex items-center gap-2 text-zinc-200">{dot(priority.color)}{priority.label}</span>}
              selected={[draft.priority]}
              options={PRIORITY_OPTIONS.map((option) => ({ value: option.value, label: option.label, leading: dot(option.color) }))}
              onChange={([next]) => next && set('priority', next as Task['priority'])}
            />
          </DetailRow>
          <InitiativeField
            projectId={projectId}
            value={draft.initiative_id}
            onChange={(initiativeId) => set('initiative_id', initiativeId)}
            canEdit
          />
          <DetailRow icon={Users} label="Assignees">
            <PickField
              label="Assignees"
              multiple
              canEdit={canAssignOthers}
              display={assignees.length > 0 ? <PeopleChips people={assignees} /> : null}
              emptyText="Unassigned"
              selected={draft.assignee_ids}
              options={assignable.map((member) => ({
                value: member.id,
                label: member.name,
                leading: <Avatar name={member.name} src={member.avatar || undefined} size="xs" />,
              }))}
              onChange={(ids) => set('assignee_ids', ids)}
            />
          </DetailRow>
          <DetailRow icon={Calendar} label="Due">
            <DateInput
              value={draft.due_date}
              onChange={(value) => set('due_date', value)}
              placeholder="Not set"
              ariaLabel="Due date"
              size="sm"
              clearable
              inputClassName={INLINE_DATE_CLASS}
            />
          </DetailRow>
          <DetailRow icon={Tag} label="Tags">
            <TagsField value={draft.tags} onChange={(next) => set('tags', next)} canEdit />
          </DetailRow>
          <DetailRow icon={Lock} label="Blocked by">
            <PickField
              label="Blocked by"
              multiple
              canEdit
              display={blockers.length > 0 ? (
                <span className="text-zinc-300">{blockers.length === 1 ? blockers[0].title : `${blockers.length} tasks`}</span>
              ) : null}
              selected={draft.blocked_by_ids}
              options={blockerChoices.map((t) => ({
                value: t.id,
                label: t.title,
                hint: STATUS_OPTIONS.find((option) => option.value === t.status)?.label,
              }))}
              onChange={(ids) => set('blocked_by_ids', ids)}
            />
          </DetailRow>
          {showAgentFields && (
            <>
              <DetailRow icon={Bot} label="Who does it">
                <PickField
                  label="Who does it"
                  multiple={false}
                  canEdit
                  display={<span className="text-zinc-200">{WHO_DOES_IT.find((option) => option.value === (draft.ai_readiness ?? ''))?.label}</span>}
                  selected={[draft.ai_readiness ?? '']}
                  options={WHO_DOES_IT.map((option) => ({ value: option.value, label: option.label }))}
                  onChange={([next = '']) => {
                    // A new task has no acceptance criteria yet, and the dev agent refuses a task without them.
                    if (next === 'ai_ready') {
                      toast('error', 'Add acceptance criteria before marking this AI Ready');
                      return;
                    }
                    set('ai_readiness', (next || null) as AiReadiness | null);
                  }}
                />
              </DetailRow>
              <DetailRow icon={Briefcase} label="Task type">
                <PickField
                  label="Task type"
                  multiple={false}
                  canEdit
                  display={draft.task_type ? <span className="text-zinc-200">{taskTypeLabel(draft.task_type)}</span> : null}
                  selected={draft.task_type ? [draft.task_type] : []}
                  options={TASK_TYPES.map((type) => ({ value: type, label: taskTypeLabel(type) }))}
                  onChange={([next]) => set('task_type', (next as TaskType | undefined) ?? null)}
                />
              </DetailRow>
            </>
          )}
        </dl>
      </div>
      <section className="px-5 py-5 border-t border-white/[0.06]">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-white">
          <AlignLeft size={16} className="text-zinc-400" aria-hidden="true" />
          Description
        </h3>
        <DescriptionField value={draft.description} onChange={(description) => set('description', description)} canEdit />
      </section>
      <p className="px-5 pb-5 text-xs text-zinc-400">Subtasks, files, reminders and comments can be added once the task is created.</p>
    </TaskPanelShell>
  );
}
