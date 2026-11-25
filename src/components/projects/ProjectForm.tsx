'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Calendar, ChevronDown, Clock, FileText, History, Plus, Receipt, Users, X, type LucideIcon } from 'lucide-react';
import { Project, ProjectBudgetHistoryEntry } from '@/lib/types';
import { useApp } from '@/lib/store';
import { Button } from '@/components/ui/Button';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { Select } from '@/components/ui/inputs/Select';
import { Textarea } from '@/components/ui/inputs/Textarea';
import { MultiSelect } from '@/components/ui/inputs/MultiSelect';
import { DateInput } from '@/components/ui/inputs/DateInput';
import { Toggle } from '@/components/ui/inputs/Toggle';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { ContactForm } from '@/components/contacts/ContactForm';
import { TaskPanelShell } from '@/components/tasks/TaskPanelShell';
import { useBrand } from '@/lib/brand/context';
import { useAuth } from '@/lib/auth-context';
import { hasPermission, isModuleEnabled } from '@/lib/access-control';
import { formatMoney, formatNumber, moneyAffix } from '@/lib/format';
import { appLocale } from '@/lib/region';
import { useRegion } from '@/lib/region/context';
import {
  projectPayload, projectUpdatePayload, validateProjectBasics, PROJECT_DESCRIPTION_MAX,
  type ProjectBasics, type ProjectFormRights,
} from '@/lib/project-form';

const DEFAULT_PROJECT_COLOR = '';
const OTHER_COLORS = ['#8B5CF6', '#EC4899', '#EF4444', '#F59E0B', '#10B981', '#06B6D4', '#3B82F6'];
const FORM_ID = 'edit-project-form';

const STATUS_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'completed', label: 'Completed' },
  { value: 'archived', label: 'Archived' },
];

function formatBudgetDisplay(val: string): string {
  if (!val) return '';
  const [intPart, decPart] = val.split('.');
  const formattedInt = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return decPart !== undefined ? `${formattedInt}.${decPart}` : formattedInt;
}

function sanitizeBudgetInput(val: string): string {
  const stripped = val.replace(/[^0-9.]/g, '');
  const parts = stripped.split('.');
  if (parts.length > 2) return parts[0] + '.' + parts.slice(1).join('');
  return stripped;
}

function formatBudgetSnapshot(type: 'hours' | 'amount' | null, value: number | null): string {
  // A budget is only meaningful when BOTH type and value are set.
  // If either is missing, treat the snapshot as "no budget".
  if (type == null || value == null) return 'None';
  if (type === 'amount') return formatMoney(value);
  return `${formatNumber(value, { maximumFractionDigits: 2 })} hrs`;
}

function formatHistoryDate(iso: string): string {
  return new Date(iso).toLocaleDateString(appLocale(), {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** One group of fields in the panel, set off by a hairline like the task panel's sections. */
function Section({ icon: Icon, title, description, children }: {
  icon: LucideIcon;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="px-5 py-5 border-t border-white/[0.06] first:border-t-0 first:pt-2">
      <h3 className={`flex items-center gap-2 text-sm font-semibold text-white ${description ? 'mb-1' : 'mb-4'}`}>
        <Icon size={16} className="text-zinc-400" aria-hidden="true" />
        {title}
      </h3>
      {description && <p className="mb-4 text-xs text-zinc-400">{description}</p>}
      <div className="space-y-4">{children}</div>
    </section>
  );
}

/** The panel header: what it is, the project's saved name, and a way out. */
function PanelHeader({ eyebrow, title, onClose }: { eyebrow: string; title: string; onClose: () => void }) {
  return (
    <div className="flex items-start gap-3 px-5 pt-4 pb-3 flex-shrink-0">
      <div className="min-w-0 flex-1">
        <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-zinc-400">{eyebrow}</p>
        <h2 id="edit-project-title" className="pt-0.5 text-base font-semibold text-white leading-snug break-words">
          {title}
        </h2>
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.06] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        <X size={18} aria-hidden="true" />
      </button>
    </div>
  );
}

/** The save bar pinned under the panel's scrolling body. */
function PanelFooter({ dirty, saving, saveLabel, onCancel }: {
  dirty: boolean;
  saving: boolean;
  saveLabel: string;
  onCancel: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-white/[0.06] px-5 py-3">
      <p className="text-xs text-zinc-400" aria-live="polite">{dirty ? 'Unsaved changes' : ''}</p>
      <div className="flex items-center gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button type="submit" form={FORM_ID} size="sm" disabled={!dirty || saving}>
          {saving ? 'Saving' : saveLabel}
        </Button>
      </div>
    </div>
  );
}

interface ProjectFormProps {
  isOpen: boolean;
  onClose: () => void;
  project: Project | null | undefined;
}

/**
 * Editing a project, in the same side panel a task opens in. New projects
 * are set up in the guided flow (/projects/new), so this only edits. The
 * panel mounts fresh on open, so a live refresh of the project never wipes
 * edits in progress.
 */
export function ProjectForm({ isOpen, onClose, project }: ProjectFormProps) {
  if (!isOpen || !project) return null;
  return <ProjectEditPanel key={project.id} project={project} onClose={onClose} />;
}

function ProjectEditPanel({ project, onClose }: { project: Project; onClose: () => void }) {
  const { access } = useAuth();
  const canManageProject = hasPermission(access, 'projects.manage');
  const canManageProjectMembers = hasPermission(access, 'project_members.manage');

  // Someone who may change who is on the project, but not the project itself,
  // gets only that: the server accepts a membership-only save from them and
  // nothing else, so offering the other fields would only fail on save.
  if (!canManageProject && canManageProjectMembers) {
    return <ProjectMembersPanel project={project} onClose={onClose} />;
  }
  return <ProjectDetailsPanel project={project} onClose={onClose} />;
}

/**
 * Closing with unsaved edits asks first: the edits are only in the form, so
 * they cannot be brought back. Leaving the page warns too.
 */
function useDiscardGuard(dirty: boolean, onClose: () => void) {
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

  const dialog = (
    <ConfirmDialog
      isOpen={confirmDiscard}
      onClose={() => setConfirmDiscard(false)}
      onConfirm={onClose}
      title="Discard changes?"
      message="Your edits to this project are not saved. Discarding them cannot be undone."
      confirmLabel="Discard"
      doubleConfirm={false}
    />
  );

  return { requestClose, dialog };
}

function ProjectMembersPanel({ project, onClose }: { project: Project; onClose: () => void }) {
  const { team, updateProject } = useApp();
  const [memberIds, setMemberIds] = useState<string[]>(project.member_ids);
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(memberIds) !== JSON.stringify(project.member_ids);
  const { requestClose, dialog } = useDiscardGuard(dirty, onClose);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    const saved = await updateProject(project.id, { member_ids: memberIds });
    setSaving(false);
    if (saved) onClose();
  };

  return (
    <TaskPanelShell
      labelledBy="edit-project-title"
      onClose={requestClose}
      after={dialog}
      header={<PanelHeader eyebrow="Project members" title={project.name} onClose={requestClose} />}
      footer={<PanelFooter dirty={dirty} saving={saving} saveLabel="Save members" onCancel={requestClose} />}
    >
      <form id={FORM_ID} onSubmit={save}>
        <Section icon={Users} title="People">
          <MultiSelect
            label="Team members"
            options={team.map((m) => ({ value: m.id, label: m.name }))}
            value={memberIds}
            onChange={setMemberIds}
            placeholder="Select team members"
            selectAll
            searchable={team.length > 4}
          />
        </Section>
      </form>
    </TaskPanelShell>
  );
}

function ProjectDetailsPanel({ project, onClose }: { project: Project; onClose: () => void }) {
  const { team, contacts, updateProject, addProjectContact, getPrimaryClient } = useApp();
  const { access, teamMemberId } = useAuth();
  const brand = useBrand();
  // A budget is in the workspace currency; the symbol sits on the side its locale puts it.
  const region = useRegion();
  const budgetAffix = moneyAffix({ currency: region.currency, locale: region.locale });
  // The brand color last; a brand color that matches another swatch shows once.
  const projectColors = [...new Set([...OTHER_COLORS, brand.colors.brand[500]])];
  const rights: ProjectFormRights = {
    manageBilling: hasPermission(access, 'billing.manage'),
    manageMembers: hasPermission(access, 'project_members.manage'),
    manageContacts: hasPermission(access, 'contacts.manage'),
    // Time tracking is a module: switched off, its toggle is hidden and a save
    // leaves the project's stored setting as it was.
    timeOn: isModuleEnabled(access, 'time'),
  };

  const [initial] = useState<ProjectBasics>(() => ({
    name: project.name,
    description: project.description,
    color: project.color,
    status: project.status,
    startDate: project.start_date || '',
    dueDate: project.due_date || '',
    timeTracking: project.time_tracking_enabled ?? project.hourly_tracking ?? false,
    clientTimeBilling: project.client_time_billing ?? (project.hourly_tracking ? 'hourly' : 'included'),
    budgetType: project.budget_type ?? '',
    budgetValue: project.budget_value != null ? String(project.budget_value) : '',
    billingAddress: project.billing_address ?? '',
    billingEmail: project.billing_email ?? '',
    taxRate: project.tax_rate != null ? String(project.tax_rate) : '',
    memberIds: project.member_ids,
    clientId: getPrimaryClient(project.id)?.contact_id || '',
  }));
  const [fields, setFields] = useState<ProjectBasics>(initial);
  const set = (patch: Partial<ProjectBasics>) => setFields((current) => ({ ...current, ...patch }));
  const dirty = JSON.stringify(fields) !== JSON.stringify(initial);

  const [saving, setSaving] = useState(false);
  // Problems show once a save was tried, then follow every change.
  const [showErrors, setShowErrors] = useState(false);
  const errors = showErrors ? validateProjectBasics(fields, { creating: false, rights }) : {};
  const [confirmStatusChange, setConfirmStatusChange] = useState(false);
  const [showNewContactForm, setShowNewContactForm] = useState(false);
  const [contactsCountBefore, setContactsCountBefore] = useState(contacts.length);
  // ContactForm closes from inside its own submit, so read the store's latest list, not this render's.
  const contactsRef = useRef(contacts);
  useEffect(() => {
    contactsRef.current = contacts;
  }, [contacts]);
  const formRef = useRef<HTMLFormElement>(null);
  // The panel scrolls and the save bar is pinned: after a blocked save, bring the
  // first error into view once it has rendered.
  const [errorTick, setErrorTick] = useState(0);
  useEffect(() => {
    if (!errorTick) return;
    const first = formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"], [role="alert"]');
    first?.scrollIntoView({ block: 'center' });
    if (first?.matches('input, textarea, select')) first.focus({ preventScroll: true });
  }, [errorTick]);
  const [showBudgetHistory, setShowBudgetHistory] = useState(false);
  const [budgetHistory, setBudgetHistory] = useState<ProjectBudgetHistoryEntry[] | null>(null);
  const { requestClose, dialog: discardDialog } = useDiscardGuard(dirty, onClose);

  useEffect(() => {
    if (!rights.manageBilling) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/projects/${project.id}/budget-history`);
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setBudgetHistory(data.entries ?? []);
      } catch {
        // Silent fail: the toggle will just stay hidden.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rights.manageBilling, project.id]);

  const doSave = async () => {
    setSaving(true);
    // One mapping for this panel and the guided setup (lib/project-form).
    const projectData = projectPayload(fields, rights, project, teamMemberId || null);
    const saved = await updateProject(project.id, projectUpdatePayload(projectData, rights));
    if (saved && rights.manageContacts && fields.clientId) {
      const currentPrimary = getPrimaryClient(project.id);
      if (currentPrimary?.contact_id !== fields.clientId) {
        await addProjectContact(project.id, fields.clientId, 'Client', null, true);
      }
    }
    setSaving(false);
    // On failure the store has toasted and rolled back; keep the panel open
    // so nothing typed is lost.
    if (saved) onClose();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setShowErrors(true);
    if (Object.keys(validateProjectBasics(fields, { creating: false, rights })).length > 0) {
      setErrorTick((t) => t + 1);
      return;
    }

    // Confirm when moving an active project to completed or archived.
    if (project.status === 'active' && fields.status !== 'active') {
      setConfirmStatusChange(true);
      return;
    }

    await doSave();
  };

  const clientOptions = [...contacts]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => ({ value: c.id, label: c.name, keywords: c.company ?? undefined, detail: c.company || undefined }));
  const showTimeAndBudget = rights.timeOn || rights.manageBilling;
  const displayName = fields.name.trim() || project.name;

  return (
    <TaskPanelShell
      labelledBy="edit-project-title"
      onClose={requestClose}
      header={<PanelHeader eyebrow="Edit project" title={project.name} onClose={requestClose} />}
      footer={<PanelFooter dirty={dirty} saving={saving} saveLabel="Save changes" onCancel={requestClose} />}
      after={
        <>
          {discardDialog}
          {rights.manageContacts && (
            <ContactForm
              isOpen={showNewContactForm}
              onClose={() => {
                setShowNewContactForm(false);
                // Pick the new contact if one was added: the store puts new contacts first.
                const latest = contactsRef.current;
                if (latest.length > contactsCountBefore && latest[0]) set({ clientId: latest[0].id });
              }}
            />
          )}
          <ConfirmDialog
            isOpen={confirmStatusChange}
            onClose={() => setConfirmStatusChange(false)}
            onConfirm={doSave}
            title={fields.status === 'archived' ? 'Archive project' : 'Complete project'}
            message={
              fields.status === 'archived'
                ? `Archive "${displayName}"? It will be hidden from the sidebar and active views.`
                : `Mark "${displayName}" as completed? It will move to the completed section.`
            }
            confirmLabel={fields.status === 'archived' ? 'Archive' : 'Complete'}
            variant="default"
          />
        </>
      }
    >
      <form id={FORM_ID} ref={formRef} onSubmit={handleSubmit} noValidate>
        <Section icon={FileText} title="Basics">
          <TextInput
            label="Project name *"
            value={fields.name}
            onChange={(name) => set({ name })}
            placeholder="Website refresh"
            error={errors.name}
          />
          <Select
            label="Status"
            value={fields.status}
            onChange={(status) => set({ status: status as Project['status'] })}
            options={STATUS_OPTIONS}
          />
          <Textarea
            label="Description"
            value={fields.description}
            onChange={(v) => set({ description: v.slice(0, PROJECT_DESCRIPTION_MAX) })}
            placeholder="One line on what this project is."
            rows={2}
            maxLength={PROJECT_DESCRIPTION_MAX}
            showCharCount
            error={errors.description}
          />
          <fieldset>
            <legend className="mb-2 text-sm font-medium text-input-text-label">
              Color <span className="font-normal text-zinc-500">(optional)</span>
            </legend>
            <div className="flex flex-wrap gap-2">
              {projectColors.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Color ${c}`}
                  aria-pressed={fields.color === c}
                  onClick={() => set({ color: fields.color === c ? DEFAULT_PROJECT_COLOR : c })}
                  className={`h-8 w-8 rounded-full transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface-raised)] ${fields.color === c ? 'scale-110 ring-2 ring-white/70 ring-offset-2 ring-offset-[var(--color-surface-raised)]' : 'hover:scale-105'}`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          </fieldset>
        </Section>

        {(rights.manageContacts || rights.manageMembers) && (
          <Section icon={Users} title="People">
            {rights.manageContacts && (
              <div>
                <Select
                  label="Primary client"
                  visibleLabel="Primary client"
                  value={fields.clientId}
                  onChange={(clientId) => set({ clientId })}
                  searchable
                  placeholder="Find a contact"
                  options={clientOptions}
                  emptyText="No contacts match."
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="mt-1.5 -ml-2.5"
                  icon={<Plus size={13} aria-hidden="true" />}
                  onClick={() => {
                    setContactsCountBefore(contacts.length);
                    setShowNewContactForm(true);
                  }}
                >
                  New contact
                </Button>
              </div>
            )}
            {rights.manageMembers && (
              <MultiSelect
                label="Team members"
                options={team.map((m) => ({ value: m.id, label: m.name }))}
                value={fields.memberIds}
                onChange={(memberIds) => set({ memberIds })}
                placeholder="Select team members"
                selectAll
                searchable={team.length > 4}
              />
            )}
          </Section>
        )}

        <Section icon={Calendar} title="Schedule">
          <DateInput label="Start date" value={fields.startDate} onChange={(startDate) => set({ startDate })} clearable />
          <div>
            <DateInput
              label="Due date"
              value={fields.dueDate}
              onChange={(dueDate) => set({ dueDate })}
              minDate={fields.startDate || undefined}
              clearable
            />
            {errors.dueDate && <p role="alert" className="mt-1.5 text-xs text-input-error">{errors.dueDate}</p>}
          </div>
        </Section>

        {showTimeAndBudget && (
          <Section icon={Clock} title={rights.timeOn && rights.manageBilling ? 'Time and budget' : rights.timeOn ? 'Time' : 'Budget'}>
            {rights.timeOn && (
              <Toggle
                checked={fields.timeTracking}
                onChange={(timeTracking) => set({ timeTracking })}
                label="Track time on this project"
                description="People log hours here; billing can draft invoices from them."
              />
            )}
            {rights.timeOn && fields.timeTracking && rights.manageBilling && (
              <Select
                label="Client billing"
                value={fields.clientTimeBilling}
                onChange={(value) => set({ clientTimeBilling: value as ProjectBasics['clientTimeBilling'] })}
                options={[
                  { value: 'hourly', label: 'Bill tracked time to client' },
                  { value: 'included', label: 'Time is included in project price' },
                ]}
                helperText="Employee pay is worked out either way. Included time never enters the client invoice queue."
              />
            )}
            {rights.manageBilling && (
              <div className="space-y-4">
                <Select
                  label="Budget"
                  value={fields.budgetType}
                  onChange={(v) => set({ budgetType: v as ProjectBasics['budgetType'] })}
                  options={[{ value: '', label: 'No budget' }, { value: 'amount', label: 'Amount' }, { value: 'hours', label: 'Hours' }]}
                />
                {fields.budgetType && (
                  <TextInput
                    label={fields.budgetType === 'amount' ? 'Budget amount' : 'Budget hours'}
                    inputMode="decimal"
                    value={formatBudgetDisplay(fields.budgetValue)}
                    onChange={(v) => set({ budgetValue: sanitizeBudgetInput(v) })}
                    placeholder={fields.budgetType === 'amount' ? '5,000' : '40'}
                    prefix={fields.budgetType === 'amount' && budgetAffix.position === 'prefix' ? budgetAffix.symbol : undefined}
                    suffix={fields.budgetType === 'amount' ? (budgetAffix.position === 'suffix' ? budgetAffix.symbol : undefined) : 'hrs'}
                  />
                )}
                {budgetHistory && budgetHistory.length >= 2 && (
                  <div>
                    <button
                      type="button"
                      onClick={() => setShowBudgetHistory((prev) => !prev)}
                      className="inline-flex items-center gap-1 rounded text-xs text-zinc-400 hover:text-zinc-300 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                      aria-expanded={showBudgetHistory}
                    >
                      <History size={12} aria-hidden="true" />
                      {showBudgetHistory ? 'Hide budget history' : 'View budget history'}
                      <ChevronDown
                        size={12}
                        aria-hidden="true"
                        className={`transition-transform ${showBudgetHistory ? 'rotate-180' : ''}`}
                      />
                    </button>
                    {showBudgetHistory && (
                      <div className="mt-2 rounded-lg bg-white/[0.03] overflow-hidden">
                        <ul className="divide-y divide-white/[0.06]">
                          {budgetHistory.map((entry) => {
                            const changer = entry.changed_by
                              ? (team.find((m) => m.id === entry.changed_by)?.name ?? 'Unknown')
                              : 'System';
                            return (
                              <li key={entry.id} className="px-3 py-2 text-xs">
                                <div className="flex items-center justify-between gap-3">
                                  <span className="text-zinc-300 truncate">
                                    <span className="text-zinc-500">
                                      {formatBudgetSnapshot(entry.old_type, entry.old_value)}
                                    </span>
                                    <span className="mx-1.5 text-zinc-500" aria-hidden="true">→</span>
                                    <span className="sr-only">to</span>
                                    <span className="font-medium">
                                      {formatBudgetSnapshot(entry.new_type, entry.new_value)}
                                    </span>
                                  </span>
                                  <span className="text-zinc-400 whitespace-nowrap tabular-nums">
                                    {formatHistoryDate(entry.created_at)}
                                  </span>
                                </div>
                                <p className="mt-0.5 text-zinc-500">by {changer}</p>
                              </li>
                            );
                          })}
                        </ul>
                        <p className="px-3 py-1.5 text-[11px] text-zinc-500 border-t border-white/[0.06]">
                          {budgetHistory.length} change{budgetHistory.length === 1 ? '' : 's'} total
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </Section>
        )}

        {rights.manageBilling && (
          <Section
            icon={Receipt}
            title="Billing"
            description="Shown on invoice PDFs. Uses the primary client's details when blank."
          >
            <Textarea
              label="Bill to address"
              value={fields.billingAddress}
              onChange={(v) => set({ billingAddress: v.slice(0, 300) })}
              placeholder={'Client name or company\nStreet address\nCity, State 12345'}
              rows={3}
              maxLength={300}
              showCharCount
            />
            <TextInput
              label="Bill to email"
              type="email"
              value={fields.billingEmail}
              onChange={(billingEmail) => set({ billingEmail })}
              placeholder="billing@client.com"
              error={errors.billingEmail}
            />
            <TextInput
              label="Tax rate"
              inputMode="decimal"
              value={fields.taxRate}
              onChange={(v) => set({ taxRate: v.replace(/[^0-9.]/g, '') })}
              placeholder="0"
              suffix="%"
            />
          </Section>
        )}
      </form>
    </TaskPanelShell>
  );
}
