'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Project } from '@/lib/types';
import { useApp } from '@/lib/store';
import Modal from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { ContactForm } from '@/components/contacts/ContactForm';
import { siteConfig } from '@/site-config';

const DEFAULT_PROJECT_COLOR = '';
const PROJECT_COLORS = [
  '#8B5CF6', '#EC4899', '#EF4444', '#F59E0B',
  '#10B981', '#06B6D4', '#3B82F6', siteConfig.colors.brand[500],
];

interface ProjectFormProps {
  isOpen: boolean;
  onClose: () => void;
  project?: Project | null;
}

export function ProjectForm({ isOpen, onClose, project }: ProjectFormProps) {
  const { team, contacts, addProject, updateProject, addProjectContact, getPrimaryClient } = useApp();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState(DEFAULT_PROJECT_COLOR);
  const [status, setStatus] = useState<Project['status']>('active');
  const [startDate, setStartDate] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [hourlyTracking, setHourlyTracking] = useState(false);
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
      setHourlyTracking(project.hourly_tracking ?? false);
      setAutonomousEnabled(project.autonomous_enabled ?? false);
      setDeploymentPolicy(project.deployment_policy ?? 'production');
      setMaxConcurrentTasks(project.max_concurrent_tasks ?? 2);
      setSuggestionsPerCycle(project.suggestions_per_cycle ?? 3);
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
  }, [project, isOpen]);

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
      hourly_rate: project?.hourly_rate ?? null,
      fixed_price: project?.fixed_price ?? null,
      autonomous_enabled: autonomousEnabled,
      deployment_policy: deploymentPolicy,
      max_concurrent_tasks: maxConcurrentTasks,
      suggestions_per_cycle: suggestionsPerCycle,
      member_ids: memberIds,
    };

    if (project) {
      await updateProject(project.id, projectData);
      if (selectedContactId) {
        const currentPrimary = getPrimaryClient(project.id);
        if (currentPrimary?.contact_id !== selectedContactId) {
          await addProjectContact(project.id, selectedContactId, 'Client', null, true);
        }
      }
    } else {
      const newProject = await addProject(projectData);
      if (newProject && selectedContactId) {
        await addProjectContact(newProject.id, selectedContactId, 'Client', null, true);
      }
    }

    setSaving(false);
    onClose();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    if (!project && !selectedContactId) {
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

  const toggleMember = (userId: string) => {
    setMemberIds(prev =>
      prev.includes(userId)
        ? prev.filter(id => id !== userId)
        : [...prev, userId]
    );
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

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label className="block text-sm font-medium text-zinc-700">Description</label>
            <span className="text-xs text-zinc-400">{description.length}/100</span>
          </div>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value.slice(0, 100))}
            placeholder="Describe the project..."
            rows={2}
            maxLength={100}
            className="w-full px-3 py-2 text-sm bg-white border border-zinc-200 rounded-lg outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 transition-all resize-none"
          />
        </div>

        <div className="space-y-1.5" ref={contactDropdownRef}>
          <label className="block text-sm font-medium text-zinc-700">
            Primary Client {!project && <span className="text-red-500">*</span>}
          </label>
          <div className="relative">
            <button
              type="button"
              onClick={() => {
                setContactDropdownOpen(!contactDropdownOpen);
                setContactSearch('');
              }}
              className={`w-full px-3 py-2 text-sm text-left bg-white border rounded-lg outline-none transition-all ${
                clientError && !selectedContactId
                  ? 'border-red-400 focus:border-red-500 focus:ring-2 focus:ring-red-100'
                  : 'border-zinc-200 focus:border-brand-500 focus:ring-2 focus:ring-brand-100'
              }`}
            >
              {selectedContact ? (
                <span className="flex items-center gap-2">
                  <span className="w-5 h-5 rounded-full bg-brand-100 text-brand-700 flex items-center justify-center text-[10px] font-semibold shrink-0">
                    {selectedContact.name.charAt(0).toUpperCase()}
                  </span>
                  <span className="truncate">{selectedContact.name}</span>
                  {selectedContact.company && (
                    <span className="text-zinc-400 truncate">- {selectedContact.company}</span>
                  )}
                </span>
              ) : (
                <span className="text-zinc-400">Select primary client...</span>
              )}
            </button>
            {contactDropdownOpen && (
              <div className="absolute z-50 mt-1 w-full bg-white border border-zinc-200 rounded-lg shadow-lg flex flex-col max-h-60">
                {contactSearchVisible && (
                  <div className="p-2 border-b border-zinc-100 shrink-0">
                    <input
                      type="text"
                      value={contactSearch}
                      onChange={(e) => setContactSearch(e.target.value)}
                      placeholder="Search contacts..."
                      className="w-full px-2 py-1.5 text-sm bg-zinc-50 border border-zinc-200 rounded-md outline-none focus:border-brand-500"
                      autoFocus
                    />
                  </div>
                )}
                <div className="overflow-y-auto min-h-0 flex-1">
                  {filteredContacts.length === 0 ? (
                    <div className="px-3 py-2 text-sm text-zinc-400">No contacts found</div>
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
                        className={`w-full px-3 py-2 text-sm text-left hover:bg-brand-50 flex items-center gap-2 transition-colors ${
                          c.id === selectedContactId ? 'bg-brand-50 text-brand-700' : 'text-zinc-700'
                        }`}
                      >
                        <span className="w-5 h-5 rounded-full bg-brand-100 text-brand-700 flex items-center justify-center text-[10px] font-semibold shrink-0">
                          {c.name.charAt(0).toUpperCase()}
                        </span>
                        <span className="truncate">{c.name}</span>
                        {c.company && (
                          <span className="text-zinc-400 text-xs truncate">- {c.company}</span>
                        )}
                      </button>
                    ))
                  )}
                </div>
                <div className="shrink-0 border-t border-zinc-100">
                  <button
                    type="button"
                    onClick={() => {
                      setContactSearchVisible(!contactSearchVisible);
                      if (contactSearchVisible) setContactSearch('');
                    }}
                    className="w-full px-3 py-2 text-sm text-left text-brand-600 hover:bg-brand-50 flex items-center gap-2 transition-colors font-medium"
                  >
                    <span className="w-4 h-4 rounded-full bg-brand-100 text-brand-700 flex items-center justify-center shrink-0">
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
                    className="w-full px-3 py-2 text-sm text-left text-brand-600 hover:bg-brand-50 flex items-center gap-2 transition-colors font-medium"
                  >
                    <span className="w-4 h-4 rounded-full bg-brand-100 text-brand-700 flex items-center justify-center text-xs shrink-0">+</span>
                    Create new contact
                  </button>
                </div>
              </div>
            )}
          </div>
          {clientError && !selectedContactId && (
            <p className="text-xs text-red-500">Please select a primary client for this project</p>
          )}
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label className="block text-sm font-medium text-zinc-700">Team Members</label>
            <button
              type="button"
              onClick={() => setMemberIds(memberIds.length === team.length ? [] : team.map(m => m.id))}
              className="text-xs text-brand-600 hover:text-brand-700 transition-colors"
            >
              {memberIds.length === team.length ? 'Deselect All' : 'Select All'}
            </button>
          </div>
          <div className="flex flex-wrap gap-2 p-2 bg-zinc-50 border border-zinc-200 rounded-lg max-h-24 overflow-y-auto">
            {team.map((member) => (
              <button
                key={member.id}
                type="button"
                onClick={() => toggleMember(member.id)}
                className={`px-2 py-1 text-xs rounded-full transition-all ${
                  memberIds.includes(member.id)
                    ? 'bg-brand-100 text-brand-700 border border-brand-300'
                    : 'bg-white text-zinc-600 border border-zinc-200 hover:border-zinc-300'
                }`}
              >
                {member.name}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Input
            label="Start Date"
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
          <Input
            label="Due Date"
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
          />
        </div>

        <div className="flex items-center justify-between py-1">
          <div>
            <label className="block text-sm font-medium text-zinc-700">Hourly Tracking</label>
            <p className="text-xs text-zinc-400">Enable time tracking for this project</p>
          </div>
          <button
            type="button"
            onClick={() => setHourlyTracking(!hourlyTracking)}
            className={`relative w-10 h-[22px] rounded-full transition-colors ${
              hourlyTracking ? 'bg-brand-600' : 'bg-zinc-300'
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-[18px] h-[18px] bg-white rounded-full shadow transition-transform ${
                hourlyTracking ? 'translate-x-[18px]' : 'translate-x-0'
              }`}
            />
          </button>
        </div>


        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-zinc-700">Color <span className="font-normal text-zinc-400">(optional)</span></label>
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

      <ContactForm
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
      />

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
