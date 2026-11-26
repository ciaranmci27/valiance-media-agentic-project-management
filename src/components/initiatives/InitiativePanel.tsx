'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Calendar, FileText, Users, X, type LucideIcon } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { useRead } from '@/lib/query-cache';
import { allGroupsRead } from '@/lib/reads';
import { INITIATIVE_HEALTHS, INITIATIVE_STATUSES, type InitiativeHealth, type InitiativeStatus } from '@/lib/types';
import {
  createInitiativeSchema, INITIATIVE_DESCRIPTION_MAX, INITIATIVE_HEALTH_LABELS, INITIATIVE_LABEL, INITIATIVE_NAME_MAX, INITIATIVE_STATUS_LABELS,
  type CreateInitiativeInput, type InitiativeView, type UpdateInitiativeInput,
} from '@/lib/initiatives';
import { Button } from '@/components/ui/Button';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { Textarea } from '@/components/ui/inputs/Textarea';
import { Select, type SelectOption } from '@/components/ui/inputs/Select';
import { DateInput } from '@/components/ui/inputs/DateInput';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { toast } from '@/components/ui/Toast';
import { TaskPanelShell } from '@/components/tasks/TaskPanelShell';
import { createInitiative, updateInitiative, writeError } from './initiative-actions';

const FORM_ID = 'initiative-form';

interface Fields {
  name: string;
  description: string;
  /** "m:<id>", "g:<id>", or "" for no owner. */
  owner: string;
  status: InitiativeStatus;
  health: InitiativeHealth | '';
  startDate: string;
  targetDate: string;
}

const fieldsOf = (initiative: InitiativeView | null): Fields => ({
  name: initiative?.name ?? '',
  description: initiative?.description ?? '',
  owner: initiative?.owner_member_id ? `m:${initiative.owner_member_id}` : initiative?.owner_group_id ? `g:${initiative.owner_group_id}` : '',
  status: initiative?.status ?? 'planned',
  health: initiative?.health ?? '',
  startDate: initiative?.start_date ?? '',
  targetDate: initiative?.target_date ?? '',
});

function payloadOf(fields: Fields): CreateInitiativeInput {
  return {
    name: fields.name.trim(),
    description: fields.description.trim(),
    owner_member_id: fields.owner.startsWith('m:') ? fields.owner.slice(2) : null,
    owner_group_id: fields.owner.startsWith('g:') ? fields.owner.slice(2) : null,
    status: fields.status,
    // Health is for an active initiative only.
    health: fields.status === 'active' && fields.health ? fields.health : null,
    start_date: fields.startDate || null,
    target_date: fields.targetDate || null,
  };
}

/** One group of fields, set off by a hairline like the project form's sections. */
function Section({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children: ReactNode }) {
  return (
    <section className="px-5 py-5 border-t border-white/[0.06] first:border-t-0 first:pt-2">
      <h3 className="mb-4 flex items-center gap-2 text-sm font-semibold text-white">
        <Icon size={16} className="text-zinc-400" aria-hidden="true" />
        {title}
      </h3>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

/**
 * A new initiative, or editing one, in the side panel a task opens in. The
 * panel mounts fresh on open, so a live refresh never wipes edits in
 * progress; closing with unsaved edits asks first.
 */
export function InitiativePanel({ projectId, initiative = null, onClose, onSaved }: {
  projectId: string;
  /** The one being edited; a new one when left out. */
  initiative?: InitiativeView | null;
  onClose: () => void;
  /** After a save: the initiative's id. */
  onSaved?: (initiativeId: string) => void;
}) {
  const { team, getProject } = useApp();
  const { teamMemberId } = useAuth();
  const { isDemoMode } = useDemo();
  const groups = useRead(allGroupsRead(isDemoMode));
  const project = getProject(projectId);
  const editing = !!initiative;

  const [initial] = useState<Fields>(() => fieldsOf(initiative));
  const [fields, setFields] = useState<Fields>(initial);
  const set = (patch: Partial<Fields>) => setFields((current) => ({ ...current, ...patch }));
  const dirty = JSON.stringify(fields) !== JSON.stringify(initial);
  const [saving, setSaving] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const requestClose = () => {
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };

  const parsed = createInitiativeSchema.safeParse(payloadOf(fields));
  const errors: Partial<Record<'name' | 'target_date' | 'owner_group_id', string>> = {};
  if (showErrors && !parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = issue.path[0] as keyof typeof errors;
      if (!errors[key]) errors[key] = issue.message;
    }
  }

  // Active people first by name, then the workspace's groups.
  const ownerOptions = useMemo<SelectOption[]>(() => {
    const people = team
      .filter((member) => member.status !== 'suspended' || `m:${member.id}` === initial.owner)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((member) => ({ value: `m:${member.id}`, label: member.name, group: 'People' }));
    const groupRows = (groups.data ?? []).map((group) => ({ value: `g:${group.id}`, label: group.name, group: 'Groups' }));
    return [{ value: '', label: 'No owner' }, ...people, ...groupRows];
  }, [team, groups.data, initial.owner]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setShowErrors(true);
    if (!parsed.success || saving) return;
    setSaving(true);
    try {
      if (initiative) {
        // Only what changed.
        const before = payloadOf(initial);
        const after = parsed.data;
        const changes = Object.fromEntries(
          (Object.keys(after) as (keyof CreateInitiativeInput)[])
            .filter((key) => JSON.stringify(after[key] ?? null) !== JSON.stringify(before[key] ?? null))
            .map((key) => [key, after[key]]),
        ) as UpdateInitiativeInput;
        // Changing one owner kind clears the other, so both travel together.
        if ('owner_member_id' in changes || 'owner_group_id' in changes) {
          changes.owner_member_id = after.owner_member_id ?? null;
          changes.owner_group_id = after.owner_group_id ?? null;
        }
        if (Object.keys(changes).length > 0) await updateInitiative(projectId, initiative.id, changes, isDemoMode);
        toast('success', 'Saved');
        onSaved?.(initiative.id);
      } else {
        const created = await createInitiative(projectId, parsed.data, { isDemo: isDemoMode, memberId: teamMemberId ?? null });
        toast('success', `${INITIATIVE_LABEL.singular} created`);
        onSaved?.(created.id);
      }
      onClose();
    } catch (error) {
      toast('error', writeError(error, editing ? `Couldn't save the ${INITIATIVE_LABEL.lower}` : `Couldn't create the ${INITIATIVE_LABEL.lower}`));
    } finally {
      setSaving(false);
    }
  };

  const title = editing ? initiative.name : `New ${INITIATIVE_LABEL.lower}`;

  return (
    <TaskPanelShell
      labelledBy="initiative-panel-title"
      onClose={requestClose}
      after={(
        <ConfirmDialog
          isOpen={confirmDiscard}
          onClose={() => setConfirmDiscard(false)}
          onConfirm={onClose}
          title="Discard changes?"
          message={`Your edits to this ${INITIATIVE_LABEL.lower} are not saved. Discarding them cannot be undone.`}
          confirmLabel="Discard"
          doubleConfirm={false}
        />
      )}
      header={(
        <div className="flex items-start gap-3 px-5 pt-4 pb-3 flex-shrink-0">
          <div className="min-w-0 flex-1">
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-zinc-400">
              {editing ? `Edit ${INITIATIVE_LABEL.lower}` : `${INITIATIVE_LABEL.singular}${project ? ` in ${project.name}` : ''}`}
            </p>
            <h2 id="initiative-panel-title" className="pt-0.5 text-base font-semibold text-white leading-snug break-words">{title}</h2>
          </div>
          <button
            type="button"
            onClick={requestClose}
            aria-label="Close"
            className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.06] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
      )}
      footer={(
        <div className="flex items-center justify-between gap-3 border-t border-white/[0.06] px-5 py-3">
          <p className="text-xs text-zinc-400" aria-live="polite">{editing && dirty ? 'Unsaved changes' : ''}</p>
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={requestClose}>Cancel</Button>
            <Button type="submit" form={FORM_ID} size="sm" disabled={(editing && !dirty) || saving}>
              {saving ? 'Saving' : editing ? 'Save changes' : `Create ${INITIATIVE_LABEL.lower}`}
            </Button>
          </div>
        </div>
      )}
    >
      <form id={FORM_ID} onSubmit={save} noValidate>
        <Section icon={FileText} title="Basics">
          <TextInput
            label="Name *"
            value={fields.name}
            onChange={(name) => set({ name: name.slice(0, INITIATIVE_NAME_MAX) })}
            placeholder="Website relaunch"
            error={errors.name}
            autoFocus={!editing}
          />
          <Textarea
            label="Description"
            value={fields.description}
            onChange={(description) => set({ description: description.slice(0, INITIATIVE_DESCRIPTION_MAX) })}
            placeholder="What this work is for, and what done looks like."
            rows={3}
            autoResize
            maxHeight={320}
            maxLength={INITIATIVE_DESCRIPTION_MAX}
          />
        </Section>

        <Section icon={Users} title="Owner and status">
          <Select
            label="Owner"
            visibleLabel="Owner"
            value={fields.owner}
            onChange={(owner) => set({ owner })}
            options={ownerOptions}
            searchable={ownerOptions.length > 8}
            placeholder="No owner"
            emptyText="Nobody matches."
            helperText="A person or a group answers for it."
            error={errors.owner_group_id}
          />
          <Select
            label="Status"
            value={fields.status}
            onChange={(status) => set({ status: status as InitiativeStatus })}
            options={INITIATIVE_STATUSES.map((status) => ({ value: status, label: INITIATIVE_STATUS_LABELS[status] }))}
          />
          {fields.status === 'active' && (
            <Select
              label="Health"
              value={fields.health}
              onChange={(health) => set({ health: health as InitiativeHealth | '' })}
              options={[
                { value: '', label: 'Not set' },
                ...INITIATIVE_HEALTHS.map((health) => ({ value: health, label: INITIATIVE_HEALTH_LABELS[health] })),
              ]}
              helperText="How the work is going right now."
            />
          )}
        </Section>

        <Section icon={Calendar} title="Schedule">
          <DateInput label="Start date" value={fields.startDate} onChange={(startDate) => set({ startDate })} clearable />
          <div>
            <DateInput
              label="Target date"
              value={fields.targetDate}
              onChange={(targetDate) => set({ targetDate })}
              minDate={fields.startDate || undefined}
              clearable
            />
            {errors.target_date && <p role="alert" className="mt-1.5 text-xs text-input-error">{errors.target_date}</p>}
          </div>
        </Section>
      </form>
    </TaskPanelShell>
  );
}
