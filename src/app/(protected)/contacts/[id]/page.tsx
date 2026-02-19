'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useApp } from '@/lib/store';
import { Header } from '@/components/layout/Header';
import { ProjectCard } from '@/components/projects/ProjectCard';
import { ProjectForm } from '@/components/projects/ProjectForm';
import { ContactForm } from '@/components/contacts/ContactForm';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Edit, Mail, Phone, Building2, StickyNote, Plus, FolderKanban, Target, UserCircle, ChevronRight } from 'lucide-react';
import { Project } from '@/lib/types';
import { toast } from '@/components/ui/Toast';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';

export default function ContactDetailPage() {
  const params = useParams();
  const router = useRouter();
  const { getContact, getProjectsByContact, leads, deleteProject, addProjectContact, updateContact } = useApp();

  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isProjectFormOpen, setIsProjectFormOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null);
  const [isEditingNotes, setIsEditingNotes] = useState(false);
  const [notesValue, setNotesValue] = useState('');

  const contactId = params.id as string;
  const contact = getContact(contactId);

  if (!contact) {
    return (
      <div className="animate-fadeIn min-h-screen bg-zinc-50 flex items-center justify-center">
        <div className="text-center">
          <UserCircle className="mx-auto mb-3 text-zinc-400" size={40} />
          <h3 className="font-medium text-zinc-700 mb-1">Contact not found</h3>
          <button
            onClick={() => router.push('/contacts')}
            className="text-sm text-indigo-600 hover:text-indigo-700"
          >
            Back to contacts
          </button>
        </div>
      </div>
    );
  }

  const linkedProjects = getProjectsByContact(contactId);
  const linkedLeads = leads.filter(l => l.contact_id === contactId);

  const handleEditProject = (project: Project) => {
    setEditingProject(project);
    setIsProjectFormOpen(true);
  };

  const handleDeleteProject = (id: string) => {
    setDeletingProjectId(id);
  };

  const executeDeleteProject = () => {
    if (!deletingProjectId) return;
    deleteProject(deletingProjectId);
    toast('success', 'Project deleted');
  };

  const handleCloseProjectForm = () => {
    setIsProjectFormOpen(false);
    setEditingProject(null);
  };

  const STATUS_CONFIG: Record<string, { label: string; variant: 'default' | 'success' | 'warning' | 'danger' | 'info' | 'purple' }> = {
    new: { label: 'New', variant: 'info' },
    contacted: { label: 'Contacted', variant: 'purple' },
    qualified: { label: 'Qualified', variant: 'warning' },
    proposal: { label: 'Proposal', variant: 'default' },
    won: { label: 'Won', variant: 'success' },
    lost: { label: 'Lost', variant: 'danger' },
  };

  return (
    <div className="animate-fadeIn min-h-screen bg-zinc-50">
      {/* Breadcrumb */}
      <div className="bg-white border-b border-zinc-100 px-4 lg:px-6 py-2">
        <nav className="flex items-center gap-1.5 text-sm pl-12 lg:pl-0">
          <Link href="/contacts" className="text-zinc-400 hover:text-indigo-600 transition-colors">Contacts</Link>
          <ChevronRight size={14} className="text-zinc-300" />
          <span className="text-zinc-700 font-medium truncate">{contact.name}</span>
        </nav>
      </div>

      <Header
        title={contact.name}
        subtitle={contact.company || undefined}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => setIsEditOpen(true)} icon={<Edit size={16} />}>
              Edit
            </Button>
          </div>
        }
      />

      <div className="p-4 lg:p-6 space-y-6">
        {/* Contact Info Card */}
        <div className="bg-white rounded-xl border border-zinc-200 p-5 lg:p-6">
          <div className="flex items-center gap-3 mb-4">
            <div
              className="w-4 h-4 rounded-full"
              style={{ backgroundColor: contact.color }}
            />
            <h2 className="text-lg font-semibold text-zinc-900">{contact.name}</h2>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-sm">
            {contact.company && (
              <div className="flex items-center gap-2 text-zinc-600">
                <Building2 size={16} className="text-zinc-400" />
                <span>{contact.company}</span>
              </div>
            )}
            {contact.email && (
              <a href={`mailto:${contact.email}`} className="flex items-center gap-2 text-zinc-600 hover:text-indigo-600 transition-colors">
                <Mail size={16} className="text-zinc-400" />
                <span>{contact.email}</span>
              </a>
            )}
            {contact.phone && (
              <a href={`tel:${contact.phone}`} className="flex items-center gap-2 text-zinc-600 hover:text-indigo-600 transition-colors">
                <Phone size={16} className="text-zinc-400" />
                <span>{contact.phone}</span>
              </a>
            )}
          </div>

          <div className="mt-4 pt-4 border-t border-zinc-100">
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2 text-zinc-500 text-sm">
                <StickyNote size={14} />
                <span>Notes</span>
              </div>
              {!isEditingNotes && (
                <button
                  onClick={() => { setNotesValue(contact.notes || ''); setIsEditingNotes(true); }}
                  className="text-xs text-indigo-600 hover:text-indigo-700 transition-colors"
                >
                  {contact.notes ? 'Edit' : 'Add notes'}
                </button>
              )}
            </div>
            {isEditingNotes ? (
              <div className="space-y-2">
                <textarea
                  value={notesValue}
                  onChange={(e) => setNotesValue(e.target.value)}
                  rows={3}
                  autoFocus
                  className="w-full px-3 py-2 text-sm bg-white border border-zinc-200 rounded-lg outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 resize-none"
                  placeholder="Add notes about this contact..."
                />
                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => setIsEditingNotes(false)}
                    className="px-3 py-1.5 text-xs text-zinc-600 hover:bg-zinc-100 rounded-lg transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => {
                      updateContact(contact.id, { notes: notesValue });
                      setIsEditingNotes(false);
                      toast('success', 'Notes updated');
                    }}
                    className="px-3 py-1.5 text-xs text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors"
                  >
                    Save
                  </button>
                </div>
              </div>
            ) : (
              contact.notes ? (
                <p className="text-sm text-zinc-700 whitespace-pre-wrap">{contact.notes}</p>
              ) : (
                <p className="text-sm text-zinc-400 italic">No notes yet</p>
              )
            )}
          </div>
        </div>

        {/* Linked Projects */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <FolderKanban size={18} className="text-zinc-500" />
              <h2 className="font-semibold text-zinc-900">
                Linked Projects ({linkedProjects.length})
              </h2>
            </div>
            <Button
              size="sm"
              onClick={() => setIsProjectFormOpen(true)}
              icon={<Plus size={14} />}
            >
              New Project
            </Button>
          </div>

          {linkedProjects.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-2 xl:grid-cols-3 gap-4">
              {linkedProjects.map((project) => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  onEdit={handleEditProject}
                  onDelete={handleDeleteProject}
                />
              ))}
            </div>
          ) : (
            <div className="bg-white rounded-xl border border-zinc-200 p-8 text-center text-zinc-500">
              <FolderKanban className="mx-auto mb-2" size={24} />
              <p>No projects linked to this contact</p>
            </div>
          )}
        </div>

        {/* Linked Leads (conversion history) */}
        {linkedLeads.length > 0 && (
          <div>
            <div className="flex items-center gap-2 mb-4">
              <Target size={18} className="text-zinc-500" />
              <h2 className="font-semibold text-zinc-900">
                Leads ({linkedLeads.length})
              </h2>
            </div>

            <div className="bg-white rounded-xl border border-zinc-200 divide-y divide-zinc-100">
              {linkedLeads.map((lead) => {
                const statusCfg = STATUS_CONFIG[lead.status] || STATUS_CONFIG.new;
                return (
                  <div key={lead.id} className="p-4 flex items-center justify-between">
                    <div>
                      <p className="font-medium text-zinc-900 text-sm">{lead.name}</p>
                      <p className="text-xs text-zinc-500">{lead.company}</p>
                    </div>
                    <Badge variant={statusCfg.variant}>{statusCfg.label}</Badge>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <ContactForm
        isOpen={isEditOpen}
        onClose={() => setIsEditOpen(false)}
        contact={contact}
      />

      <ProjectForm
        isOpen={isProjectFormOpen}
        onClose={handleCloseProjectForm}
        project={editingProject}
      />

      <ConfirmDialog
        isOpen={!!deletingProjectId}
        onClose={() => setDeletingProjectId(null)}
        onConfirm={executeDeleteProject}
        title="Delete Project"
        message="This will permanently delete the project and all its tasks. This action cannot be undone."
        confirmLabel="Delete"
        variant="danger"
      />
    </div>
  );
}
