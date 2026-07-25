'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { ChevronDown, History } from 'lucide-react';
import { Project, ProjectBudgetHistoryEntry } from '@/lib/types';
import { useApp } from '@/lib/store';
import Modal from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { ContactForm } from '@/components/contacts/ContactForm';
import { Textarea } from '@/components/ui/inputs/Textarea';
import { MultiSelect } from '@/components/ui/inputs/MultiSelect';
import { DateInput } from '@/components/ui/inputs/DateInput';
import { siteConfig } from '@/site-config';
import { useAuth } from '@/lib/auth-context';
import { hasPermission } from '@/lib/access-control';

const DEFAULT_PROJECT_COLOR = '';
const PROJECT_COLORS = [
  '#8B5CF6', '#EC4899', '#EF4444', '#F59E0B',
  '#10B981', '#06B6D4', '#3B82F6', siteConfig.colors.brand[500],
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
  if (type === 'amount') {
    return `$${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  }
  return `${value.toLocaleString('en-US', { maximumFractionDigits: 2 })} hrs`;
}

function formatHistoryDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

interface ProjectFormProps {
  isOpen: boolean;
  onClose: () => void;
  project?: Project | null;
}

export function ProjectForm({ isOpen, onClose, project }: ProjectFormProps) {
  const { team, contacts, addProject, updateProject, addProjectContact, getPrimaryClient } = useApp();
  const { access, teamMemberId } = useAuth();
  const canManageBilling = hasPermission(access, 'billing.manage');
  const canManageProjectMembers = hasPermission(access, 'project_members.manage');
  const canManageContacts = hasPermission(access, 'contacts.manage');
  const canManageAgents = hasPermission(access, 'agents.manage');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState(DEFAULT_PROJECT_COLOR);
  const [status, setStatus] = useState<Project['status']>('active');
  const [startDate, setStartDate] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [hourlyTracking, setHourlyTracking] = useState(false);
  const [clientTimeBilling, setClientTimeBilling] = useState<'hourly' | 'included'>('included');
  const [budgetType, setBudgetType] = useState<'hours' | 'amount' | ''>('');
  const [budgetValue, setBudgetValue] = useState('');
  const [billingAddress, setBillingAddress] = useState('');
  const [billingEmail, setBillingEmail] = useState('');
  const [taxRate, setTaxRate] = useState('');
  const [autonomousEnabled, setAutonomousEnabled] = useState(false);
  const [deploymentPolicy, setDeploymentPolicy] = useState<'playground' | 'production'>('production');
  const [maxConcurrentTasks, setMaxConcurrentTasks] = useState(2);
  const [suggestionsPerCycle, setSuggestionsPerCycle] = useState(3);
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [confirmStatusChange, setConfirmStatusChange] = useState(false);
  const [selectedContactId, setSelectedContactId] = useState('');
  const [contactSearch, setContactSearch] = useState('');
  const [contactDropdownOpen, setContactDropdownOpen] = useState(false);
  const [contactSearchVisible, setContactSearchVisible] = useState(false);
  const [clientError, setClientError] = useState(false);
  const [showNewContactForm, setShowNewContactForm] = useState(false);
  const [showBudgetHistory, setShowBudgetHistory] = useState(false);
  const [budgetHistory, setBudgetHistory] = useState<ProjectBudgetHistoryEntry[] | null>(null);
  const contactsCountBeforeRef = useRef(contacts.length);
  const contactDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (project) {
      setName(project.name);
      setDescription(project.description);
      setColor(project.color);
      setStatus(project.status);
      setStartDate(project.start_date || '');
      setDueDate(project.due_date || '');
      setHourlyTracking(project.time_tracking_enabled ?? project.hourly_tracking ?? false);
      setClientTimeBilling(project.client_time_billing ?? (project.hourly_tracking ? 'hourly' : 'included'));
      setBudgetType(project.budget_type ?? '');
      setBudgetValue(project.budget_value != null ? String(project.budget_value) : '');
      setBillingAddress(project.billing_address ?? '');
      setBillingEmail(project.billing_email ?? '');
      setTaxRate(project.tax_rate != null ? String(project.tax_rate) : '');
      setAutonomousEnabled(project.autonomous_enabled ?? false);
      setDeploymentPolicy(project.deployment_policy ?? 'production');
      setMaxConcurrentTasks(project.max_concurrent_tasks ?? 2);
      setSuggestionsPerCycle(project.suggestions_per_cycle ?? 2);
      setMemberIds(project.member_ids);
      const primaryClient = getPrimaryClient(project.id);
      setSelectedContactId(primaryClient?.contact_id || '');
    } else {
      setName('');
      setDescription('');
      setColor(DEFAULT_PROJECT_COLOR);
      setStatus('active');
      setStartDate('');
      setDueDate('');
      setHourlyTracking(false);
      setClientTimeBilling('included');
      setBudgetType('');
      setBudgetValue('');
      setBillingAddress('');
      setBillingEmail('');
      setTaxRate('');
      setAutonomousEnabled(false);
      setDeploymentPolicy('production');
      setMaxConcurrentTasks(2);
      setSuggestionsPerCycle(3);
      setMemberIds([]);
      setSelectedContactId('');
    }
    setContactSearch('');
    setClientError(false);
    setContactDropdownOpen(false);
    setContactSearchVisible(false);
    setShowBudgetHistory(false);
    setBudgetHistory(null);
  }, [project, isOpen]);

  useEffect(() => {
    if (!isOpen || !project || !canManageBilling) return;
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
    return () => { cancelled = true; };
  }, [canManageBilling, isOpen, project]);

  const doSave = async () => {
    setSaving(true);
    const projectData = {
      name: name.trim(),
      description: description.trim(),
      color,
      status,
      start_date: startDate || null,
      due_date: dueDate || null,
      hourly_tracking: hourlyTracking,
      time_tracking_enabled: hourlyTracking,
      member_ids: canManageProjectMembers ? memberIds : (project?.member_ids || (teamMemberId ? [teamMemberId] : [])),
      ...(canManageBilling ? {
        client_time_billing: clientTimeBilling,
        hourly_rate: project?.hourly_rate ?? null,
        budget_type: budgetType || null,
        budget_value: budgetValue && !isNaN(parseFloat(budgetValue)) ? parseFloat(budgetValue) : null,
        billing_address: billingAddress.trim() || null,
        billing_email: billingEmail.trim() || null,
        tax_rate: taxRate && !isNaN(parseFloat(taxRate)) ? parseFloat(taxRate) : null,
      } : {}),
      ...(canManageAgents ? {
        autonomous_enabled: autonomousEnabled,
        deployment_policy: deploymentPolicy,
        max_concurrent_tasks: maxConcurrentTasks,
        suggestions_per_cycle: suggestionsPerCycle,
        repo_path: project?.repo_path ?? null,
      } : {}),
    } as Omit<Project, 'id' | 'created_at' | 'updated_at'>;

    if (project) {
      const updateData: Partial<Project> = { ...projectData };
      if (!canManageProjectMembers) delete updateData.member_ids;
      await updateProject(project.id, updateData);
      if (canManageContacts && selectedContactId) {
        const currentPrimary = getPrimaryClient(project.id);
        if (currentPrimary?.contact_id !== selectedContactId) {
          await addProjectContact(project.id, selectedContactId, 'Client', null, true);
        }
      }
    } else {
      const newProject = await addProject(projectData);
      if (newProject && canManageContacts && selectedContactId) {
        await addProjectContact(newProject.id, selectedContactId, 'Client', null, true);
      }
    }

    setSaving(false);
    onClose();
  };

  const handleToggleBudgetHistory = () => {
    setShowBudgetHistory(prev => !prev);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    if (!project && canManageContacts && !selectedContactId) {
      setClientError(true);
      return;
    }

    // Confirm when changing an existing project's status to completed/archived
    if (project && project.status === 'active' && status !== 'active') {
      setConfirmStatusChange(true);
      return;
    }

    await doSave();
  };


  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (contactDropdownRef.current && !contactDropdownRef.current.contains(e.target as Node)) {
        setContactDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const filteredContacts = contacts
    .filter(c => {
      const q = contactSearch.toLowerCase();
      return c.name.toLowerCase().includes(q) || c.company?.toLowerCase().includes(q);
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const selectedContact = contacts.find(c => c.id === selectedContactId);

  const statusOptions = [
    { value: 'active', label: 'Active' },
    { value: 'completed', label: 'Completed' },
    { value: 'archived', label: 'Archived' },
  ];

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={project ? 'Edit Project' : 'New Project'}
      size="lg"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <Input
            label="Project Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Enter project name"
            required
          />
          <Select
            label="Status"
            value={status}
            onChange={(value) => setStatus(value as Project['status'])}
            options={statusOptions}
          />
        </div>

        <Textarea
          label="Description"
          value={description}
          onChange={v => setDescription(v.slice(0, 100))}
          placeholder="Describe the project..."
          rows={2}
          maxLength={100}
          showCharCount
        />

        {canManageContacts && <div className="space-y-1.5" ref={contactDropdownRef}>
          <label className="block text-sm font-medium text-zinc-300">
            Primary Client {!project && <span className="text-red-500">*</span>}
          </label>
          <div className="relative">
            <button
              type="button"
              onClick={() => {
                setContactDropdownOpen(!contactDropdownOpen);
                setContactSearch('');
              }}
              className={`w-full px-3 py-2 text-sm text-left bg-surface-raised border rounded-lg outline-none transition-all ${
                clientError && !selectedContactId
                  ? 'border-red-400 focus:border-red-500 focus:ring-2 focus:ring-red-500/30'
                  : 'border-white/[0.08] focus:border-brand-500 focus:ring-2 focus:ring-brand-500/30'
              }`}
            >
              {selectedContact ? (
                <span className="flex items-center gap-2">
                  <span className="w-5 h-5 rounded-full bg-brand-500/15 text-brand-300 flex items-center justify-center text-[10px] font-semibold shrink-0">
                    {selectedContact.name.charAt(0).toUpperCase()}
                  </span>
                  <span className="truncate">{selectedContact.name}</span>
                  {selectedContact.company && (
                    <span className="text-zinc-500 truncate">- {selectedContact.company}</span>
                  )}
                </span>
              ) : (
                <span className="text-zinc-500">Select primary client...</span>
              )}
            </button>
            {contactDropdownOpen && (
              <div className="absolute z-50 mt-1 w-full bg-surface-raised border border-white/[0.08] rounded-lg shadow-lg flex flex-col max-h-60">
                {contactSearchVisible && (
                  <div className="p-2 border-b border-white/[0.06] shrink-0">
                    <input
                      type="text"
                      value={contactSearch}
                      onChange={(e) => setContactSearch(e.target.value)}
                      placeholder="Search contacts..."
                      className="w-full px-2 py-1.5 text-sm bg-white/[0.03] border border-white/[0.08] rounded-md outline-none focus:border-brand-500"
                      autoFocus
                    />
                  </div>
                )}
                <div className="overflow-y-auto min-h-0 flex-1">
                  {filteredContacts.length === 0 ? (
                    <div className="px-3 py-2 text-sm text-zinc-500">No contacts found</div>
                  ) : (
                    filteredContacts.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => {
                          setSelectedContactId(c.id);
                          setContactDropdownOpen(false);
                          setClientError(false);
                        }}
                        className={`w-full px-3 py-2 text-sm text-left hover:bg-brand-500/15 flex items-center gap-2 transition-colors ${
                          c.id === selectedContactId ? 'bg-brand-500/15 text-brand-300' : 'text-zinc-300'
                        }`}
                      >
                        <span className="w-5 h-5 rounded-full bg-brand-500/15 text-brand-300 flex items-center justify-center text-[10px] font-semibold shrink-0">
                          {c.name.charAt(0).toUpperCase()}
                        </span>
                        <span className="truncate">{c.name}</span>
                        {c.company && (
                          <span className="text-zinc-500 text-xs truncate">- {c.company}</span>
                        )}
                      </button>
                    ))
                  )}
                </div>
                <div className="shrink-0 border-t border-white/[0.06]">
                  <button
                    type="button"
                    onClick={() => {
                      setContactSearchVisible(!contactSearchVisible);
                      if (contactSearchVisible) setContactSearch('');
                    }}
                    className="w-full px-3 py-2 text-sm text-left text-brand-300 hover:bg-brand-500/15 flex items-center gap-2 transition-colors font-medium"
                  >
                    <span className="w-4 h-4 rounded-full bg-brand-500/15 text-brand-300 flex items-center justify-center shrink-0">
                      <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                      </svg>
                    </span>
                    {contactSearchVisible ? 'Hide search' : 'Search contacts'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      contactsCountBeforeRef.current = contacts.length;
                      setContactDropdownOpen(false);
                      setShowNewContactForm(true);
                    }}
                    className="w-full px-3 py-2 text-sm text-left text-brand-300 hover:bg-brand-500/15 flex items-center gap-2 transition-colors font-medium"
                  >
                    <span className="w-4 h-4 rounded-full bg-brand-500/15 text-brand-300 flex items-center justify-center text-xs shrink-0">+</span>
                    Create new contact
                  </button>
                </div>
              </div>
            )}
          </div>
          {clientError && !selectedContactId && (
            <p className="text-xs text-red-500">Please select a primary client for this project</p>
          )}
        </div>}

        {canManageProjectMembers && <MultiSelect
          label="Team Members"
          options={team.map(m => ({ value: m.id, label: m.name }))}
          value={memberIds}
          onChange={setMemberIds}
          placeholder="Select team members..."
          selectAll
          searchable={team.length > 4}
        />}

        <div className="grid grid-cols-2 gap-4">
          <DateInput
            label="Start Date"
            value={startDate}
            onChange={setStartDate}
            clearable
          />
          <DateInput
            label="Due Date"
            value={dueDate}
            onChange={setDueDate}
            minDate={startDate || undefined}
            clearable
          />
        </div>

        <div className="flex items-center justify-between py-1">
          <div>
            <label className="block text-sm font-medium text-zinc-300">Time Tracking</label>
            <p className="text-xs text-zinc-500">Enable time tracking for this project</p>
          </div>
          <button
            type="button"
            onClick={() => setHourlyTracking(!hourlyTracking)}
            className={`relative w-10 h-[22px] rounded-full transition-colors ${
              hourlyTracking ? 'bg-brand-600' : 'bg-zinc-300'
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-[18px] h-[18px] bg-surface-raised rounded-full shadow transition-transform ${
                hourlyTracking ? 'translate-x-[18px]' : 'translate-x-0'
              }`}
            />
          </button>
        </div>
        {hourlyTracking && canManageBilling && (
          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-1.5">Client billing treatment</label>
            <Select value={clientTimeBilling} onChange={(value) => setClientTimeBilling(value as 'hourly' | 'included')} options={[{ value: 'hourly', label: 'Bill tracked time to client' }, { value: 'included', label: 'Time is included in project price' }]} />
            <p className="text-xs text-zinc-500 mt-1">Employee compensation is calculated either way. Included time never enters the client invoice queue.</p>
          </div>
        )}

        {/* Budget */}
        {canManageBilling && <><div className="space-y-2">
          <label className="block text-sm font-medium text-zinc-300">Budget <span className="font-normal text-zinc-500">(optional)</span></label>
          <div className="flex gap-2">
            <div className="flex rounded-lg border border-white/[0.08] overflow-hidden">
              <button
                type="button"
                onClick={() => setBudgetType(budgetType === 'amount' ? '' : 'amount')}
                className={`px-3 py-1.5 text-sm font-medium transition-colors ${
                  budgetType === 'amount' ? 'bg-brand-600 text-white' : 'bg-surface-raised text-zinc-400 hover:bg-white/[0.03]'
                }`}
              >
                Amount
              </button>
              <button
                type="button"
                onClick={() => setBudgetType(budgetType === 'hours' ? '' : 'hours')}
                className={`px-3 py-1.5 text-sm font-medium transition-colors border-l border-white/[0.08] ${
                  budgetType === 'hours' ? 'bg-brand-600 text-white' : 'bg-surface-raised text-zinc-400 hover:bg-white/[0.03]'
                }`}
              >
                Hours
              </button>
            </div>
            {budgetType && (
              <div className="relative flex-1">
                {budgetType === 'amount' && (
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-zinc-400 z-10">
                    $
                  </span>
                )}
                <Input
                  type="text"
                  inputMode="decimal"
                  value={formatBudgetDisplay(budgetValue)}
                  onChange={(e) => setBudgetValue(sanitizeBudgetInput(e.target.value))}
                  placeholder={budgetType === 'amount' ? '5,000' : '40'}
                  className={budgetType === 'amount' ? 'pl-7' : ''}
                />
              </div>
            )}
          </div>
          {budgetType && (
            <p className="text-xs text-zinc-500">
              {budgetType === 'amount' ? 'Total dollar budget for this project' : 'Total hours allocated for this project'}
            </p>
          )}

          {project && budgetHistory && budgetHistory.length >= 2 && (
            <div className="pt-1">
              <button
                type="button"
                onClick={handleToggleBudgetHistory}
                className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-300 transition-colors"
                aria-expanded={showBudgetHistory}
              >
                <History size={12} />
                {showBudgetHistory ? 'Hide budget history' : 'View budget history'}
                <ChevronDown
                  size={12}
                  className={`transition-transform ${showBudgetHistory ? 'rotate-180' : ''}`}
                />
              </button>
              {showBudgetHistory && (
                <div className="mt-2 rounded-md border border-white/[0.08] bg-white/[0.03] overflow-hidden">
                  <ul className="divide-y divide-white/[0.08]">
                    {budgetHistory.map((entry) => {
                      const changer = entry.changed_by
                        ? team.find(m => m.id === entry.changed_by)?.name ?? 'Unknown'
                        : 'System';
                      return (
                        <li key={entry.id} className="px-3 py-2 flex items-center justify-between gap-3 text-xs">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-zinc-400 whitespace-nowrap">{formatHistoryDate(entry.created_at)}</span>
                            <span className="text-zinc-300 truncate">
                              <span className="text-zinc-500">{formatBudgetSnapshot(entry.old_type, entry.old_value)}</span>
                              <span className="mx-1.5 text-zinc-500">→</span>
                              <span className="font-medium">{formatBudgetSnapshot(entry.new_type, entry.new_value)}</span>
                            </span>
                          </div>
                          <span className="text-zinc-500 whitespace-nowrap">by {changer}</span>
                        </li>
                      );
                    })}
                  </ul>
                  <div className="px-3 py-1.5 text-[10px] text-zinc-500 border-t border-white/[0.08] bg-surface-raised">
                    {budgetHistory.length} change{budgetHistory.length === 1 ? '' : 's'} total
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Billing — used on the invoice PDF for this project */}
        <div className="space-y-3 rounded-lg border border-white/[0.08] bg-white/[0.03] p-3">
          <div>
            <label className="block text-sm font-medium text-zinc-300">Billing <span className="font-normal text-zinc-500">(optional)</span></label>
            <p className="text-xs text-zinc-500">Shown on invoice PDFs. Falls back to the primary client&apos;s contact info when blank.</p>
          </div>
          <Textarea
            label="Bill To Address"
            value={billingAddress}
            onChange={(v) => setBillingAddress(v.slice(0, 300))}
            placeholder={'Client name or company\nStreet address\nCity, State 12345'}
            rows={3}
            maxLength={300}
            showCharCount
          />
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Bill To Email"
              type="email"
              value={billingEmail}
              onChange={(e) => setBillingEmail(e.target.value)}
              placeholder="billing@client.com"
            />
            <div className="relative">
              <Input
                label="Tax Rate (%)"
                type="text"
                inputMode="decimal"
                value={taxRate}
                onChange={(e) => setTaxRate(e.target.value.replace(/[^0-9.]/g, ''))}
                placeholder="0"
              />
            </div>
          </div>
        </div></>}

        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-zinc-300">Color <span className="font-normal text-zinc-500">(optional)</span></label>
          <div className="flex gap-2">
            {PROJECT_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(color === c ? DEFAULT_PROJECT_COLOR : c)}
                className={`w-8 h-8 rounded-lg transition-all ${
                  color === c ? 'ring-2 ring-offset-2 ring-brand-500 scale-110' : 'hover:scale-105'
                }`}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        </div>

        <div className="flex justify-end gap-3 pt-4">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? 'Saving...' : project ? 'Save Changes' : 'Create Project'}
          </Button>
        </div>
      </form>

      {canManageContacts && <ContactForm
        isOpen={showNewContactForm}
        onClose={() => {
          setShowNewContactForm(false);
          // Auto-select the newly created contact if one was added
          if (contacts.length > contactsCountBeforeRef.current) {
            const newest = contacts[0]; // store prepends new contacts
            if (newest) {
              setSelectedContactId(newest.id);
              setClientError(false);
            }
          }
        }}
      />}

      <ConfirmDialog
        isOpen={confirmStatusChange}
        onClose={() => setConfirmStatusChange(false)}
        onConfirm={doSave}
        title={status === 'archived' ? 'Archive Project' : 'Complete Project'}
        message={
          status === 'archived'
            ? `Are you sure you want to archive "${name}"? It will be hidden from the sidebar and active views.`
            : `Are you sure you want to mark "${name}" as completed? It will be moved to the completed section.`
        }
        confirmLabel={status === 'archived' ? 'Archive' : 'Complete'}
        variant="default"
      />
    </Modal>
  );
}
