'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import { Plus, Edit, Trash2, Star, UserCircle, ExternalLink, Search, X } from 'lucide-react';
import { useApp } from '@/lib/store';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { ContactForm } from '@/components/contacts/ContactForm';
import Modal from '@/components/ui/Modal';
import { ProjectContact, CONTACT_ROLES } from '@/lib/types';

interface ProjectContactsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
}

export function ProjectContactsPanel({ isOpen, onClose, projectId }: ProjectContactsPanelProps) {
  const { contacts, getContactsByProject, getPrimaryClient, addProjectContact, updateProjectContact, removeProjectContact } = useApp();

  const [removeTarget, setRemoveTarget] = useState<string | null>(null);

  // Edit state
  const [editingPcId, setEditingPcId] = useState<string | null>(null);
  const [editRole, setEditRole] = useState('');
  const [editCustomRole, setEditCustomRole] = useState('');
  const [editIsPrimary, setEditIsPrimary] = useState(false);

  // Add state
  const [showAddForm, setShowAddForm] = useState(false);
  const [addContactId, setAddContactId] = useState('');
  const [addRole, setAddRole] = useState<string>('');
  const [addCustomRole, setAddCustomRole] = useState('');
  const [addIsPrimary, setAddIsPrimary] = useState(false);
  const [addSearch, setAddSearch] = useState('');
  const [showNewContactForm, setShowNewContactForm] = useState(false);

  const projectContactsList = getContactsByProject(projectId);
  const existingContactIds = projectContactsList.map(pc => pc.contact_id);
  const hasPrimaryClient = !!getPrimaryClient(projectId);

  const availableContacts = useMemo(() => {
    return contacts.filter(c => {
      if (existingContactIds.includes(c.id)) return false;
      if (!addSearch) return true;
      const s = addSearch.toLowerCase();
      return c.name.toLowerCase().includes(s) ||
        c.email.toLowerCase().includes(s) ||
        c.company.toLowerCase().includes(s);
    });
  }, [contacts, existingContactIds, addSearch]);

  const roleOptions = CONTACT_ROLES.map(r => ({ value: r, label: r }));

  // Edit handlers
  const handleStartEdit = (pc: ProjectContact) => {
    setEditingPcId(pc.id);
    setEditRole(pc.role);
    setEditCustomRole(pc.custom_role || '');
    setEditIsPrimary(pc.is_primary_client);
  };

  const handleSaveEdit = (pcId: string) => {
    updateProjectContact(pcId, projectId, {
      role: editRole,
      custom_role: editRole === 'Other' ? editCustomRole : null,
      is_primary_client: editIsPrimary,
    });
    setEditingPcId(null);
  };

  const handleRemove = (pcId: string) => {
    setRemoveTarget(pcId);
  };

  const executeRemove = () => {
    if (removeTarget) {
      removeProjectContact(removeTarget, projectId);
    }
  };

  // Add handlers
  const resetAddForm = () => {
    setAddContactId('');
    setAddRole('');
    setAddCustomRole('');
    setAddIsPrimary(false);
    setAddSearch('');
    setShowAddForm(false);
  };

  const handleAddSubmit = () => {
    if (!addContactId) return;

    addProjectContact(
      projectId,
      addContactId,
      addRole,
      addRole === 'Other' ? addCustomRole : null,
      addIsPrimary
    );

    resetAddForm();
  };

  const handleAddRoleChange = (newRole: string) => {
    setAddRole(newRole);
    if (newRole === 'Client' && !hasPrimaryClient) {
      setAddIsPrimary(true);
    } else if (newRole !== 'Client') {
      setAddIsPrimary(false);
    }
  };

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={() => { onClose(); resetAddForm(); setEditingPcId(null); }}
        title={`Project Contacts (${projectContactsList.length})`}
        size="lg"
      >
        <div className="space-y-3">
          {/* Existing contacts list */}
          {projectContactsList.length > 0 ? (
            <div className="divide-y divide-zinc-100 border border-zinc-200 rounded-lg">
              {projectContactsList.map((pc) => {
                const contact = pc.contact;
                if (!contact) return null;

                const isEditing = editingPcId === pc.id;
                const displayRole = pc.role === 'Other' && pc.custom_role ? pc.custom_role : pc.role;

                return (
                  <div key={pc.id} className="p-3 lg:p-4">
                    <div className="flex items-center gap-3">
                      <Avatar name={contact.name} src={contact.avatar_url || undefined} size="md" />

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <Link
                            href={`/contacts/${contact.id}`}
                            className="font-medium text-zinc-900 text-sm hover:text-indigo-600 transition-colors truncate inline-flex items-center gap-1"
                          >
                            {contact.name}
                            <ExternalLink size={11} className="flex-shrink-0 opacity-50" />
                          </Link>
                          {pc.is_primary_client && (
                            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700 flex-shrink-0">
                              <Star size={10} />
                              Primary
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 text-xs text-zinc-500">
                          {contact.email && <span className="truncate">{contact.email}</span>}
                          {contact.email && contact.company && <span>·</span>}
                          {contact.company && <span className="truncate">{contact.company}</span>}
                        </div>
                      </div>

                      {!isEditing && (
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <Badge variant="default">{displayRole}</Badge>
                          <button
                            onClick={() => handleStartEdit(pc)}
                            className="p-1 rounded text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 transition-all"
                          >
                            <Edit size={14} />
                          </button>
                          <button
                            onClick={() => handleRemove(pc.id)}
                            className="p-1 rounded text-zinc-400 hover:text-red-600 hover:bg-red-50 transition-all"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      )}
                    </div>

                    {isEditing && (
                      <div className="mt-3 pt-3 border-t border-zinc-100 flex flex-wrap items-center gap-2">
                        <Select
                          value={editRole}
                          onChange={(value) => setEditRole(value)}
                          options={roleOptions}
                        />
                        {editRole === 'Other' && (
                          <input
                            type="text"
                            value={editCustomRole}
                            onChange={(e) => setEditCustomRole(e.target.value)}
                            placeholder="Custom role"
                            className="px-2 py-1.5 text-sm border border-zinc-200 rounded-lg w-32 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
                          />
                        )}
                        {editRole === 'Client' && (
                          <label className="flex items-center gap-1.5 cursor-pointer">
                            <button
                              type="button"
                              role="switch"
                              aria-checked={editIsPrimary}
                              onClick={() => setEditIsPrimary(!editIsPrimary)}
                              className={`relative inline-flex w-8 h-[18px] rounded-full transition-colors flex-shrink-0 ${editIsPrimary ? 'bg-amber-500' : 'bg-zinc-300'}`}
                            >
                              <span className={`absolute top-[2px] left-[2px] w-[14px] h-[14px] rounded-full bg-white shadow-sm transition-transform ${editIsPrimary ? 'translate-x-[14px]' : 'translate-x-0'}`} />
                            </button>
                            <span className={`text-xs whitespace-nowrap ${editIsPrimary ? 'text-amber-700' : 'text-zinc-600'}`}>Primary</span>
                          </label>
                        )}
                        <div className="flex items-center gap-1 ml-auto">
                          <Button size="sm" onClick={() => handleSaveEdit(pc.id)}>
                            Save
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setEditingPcId(null)}>
                            Cancel
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : !showAddForm ? (
            <div className="text-center py-8 text-zinc-500">
              <UserCircle className="mx-auto mb-2" size={28} />
              <p className="text-sm">No contacts linked to this project yet</p>
            </div>
          ) : null}

          {/* Inline add contact form */}
          {showAddForm ? (
            <div className="border border-zinc-200 rounded-lg p-4 bg-zinc-50 space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-medium text-zinc-900">Add Contact</h4>
                <button
                  onClick={resetAddForm}
                  className="p-1 rounded text-zinc-400 hover:text-zinc-600 hover:bg-zinc-200 transition-all"
                >
                  <X size={16} />
                </button>
              </div>

              {/* Contact search */}
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" size={14} />
                <input
                  type="text"
                  value={addSearch}
                  onChange={(e) => setAddSearch(e.target.value)}
                  placeholder="Search contacts..."
                  className="w-full pl-9 pr-3 py-2 text-sm bg-white border border-zinc-200 rounded-lg outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 transition-all"
                />
              </div>

              {/* Contact list */}
              <div className="max-h-36 overflow-y-auto border border-zinc-200 rounded-lg bg-white">
                {availableContacts.length === 0 ? (
                  <div className="p-3 text-sm text-zinc-500 text-center">
                    {addSearch ? 'No contacts match your search' : 'All contacts are already linked'}
                  </div>
                ) : (
                  availableContacts.map(c => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => setAddContactId(c.id)}
                      className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left transition-colors ${
                        addContactId === c.id
                          ? 'bg-indigo-50 text-indigo-700'
                          : 'text-zinc-700 hover:bg-zinc-50'
                      }`}
                    >
                      <div
                        className="w-6 h-6 rounded-full flex items-center justify-center text-white text-xs font-medium flex-shrink-0"
                        style={{ backgroundColor: c.color }}
                      >
                        {c.name.charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0 flex-1">
                        <span className="font-medium truncate block">{c.name}</span>
                        {c.company && <span className="text-xs text-zinc-500">{c.company}</span>}
                      </div>
                    </button>
                  ))
                )}
              </div>

              <button
                type="button"
                onClick={() => setShowNewContactForm(true)}
                className="text-sm text-indigo-600 hover:text-indigo-700 font-medium"
              >
                + Create new contact
              </button>

              {/* Role & primary client */}
              <div className="flex flex-wrap items-end gap-3">
                <div className="flex-1 min-w-[140px]">
                  <Select
                    label="Role"
                    value={addRole}
                    onChange={(value) => handleAddRoleChange(value)}
                    options={roleOptions}
                    placeholder="Select a role..."
                  />
                </div>
                {addRole === 'Other' && (
                  <div className="flex-1 min-w-[140px]">
                    <Input
                      label="Custom Role"
                      value={addCustomRole}
                      onChange={(e) => setAddCustomRole(e.target.value)}
                      placeholder="Enter custom role..."
                    />
                  </div>
                )}
                {addRole === 'Client' && (
                  <label className="flex items-center gap-2 py-2 cursor-pointer">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={addIsPrimary}
                      onClick={() => setAddIsPrimary(!addIsPrimary)}
                      className={`relative inline-flex w-9 h-5 rounded-full transition-colors flex-shrink-0 ${addIsPrimary ? 'bg-amber-500' : 'bg-zinc-300'}`}
                    >
                      <span className={`absolute top-[2px] left-[2px] w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${addIsPrimary ? 'translate-x-4' : 'translate-x-0'}`} />
                    </button>
                    <span className={`text-sm whitespace-nowrap ${addIsPrimary ? 'text-amber-700' : 'text-zinc-600'}`}>Primary</span>
                  </label>
                )}
              </div>

              <div className="flex justify-end">
                <Button onClick={handleAddSubmit} disabled={!addContactId || !addRole} size="sm">
                  Add to Project
                </Button>
              </div>
            </div>
          ) : (
            <Button
              onClick={() => setShowAddForm(true)}
              icon={<Plus size={14} />}
              className="w-full"
              variant="secondary"
            >
              Add Contact
            </Button>
          )}
        </div>
      </Modal>

      {/* Create new contact form (only extra modal needed) */}
      <ContactForm
        isOpen={showNewContactForm}
        onClose={() => setShowNewContactForm(false)}
      />

      <ConfirmDialog
        isOpen={!!removeTarget}
        onClose={() => setRemoveTarget(null)}
        onConfirm={executeRemove}
        title="Remove Contact"
        message="Remove this contact from the project?"
        confirmLabel="Remove"
        variant="danger"
      />
    </>
  );
}
