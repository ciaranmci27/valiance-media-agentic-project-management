'use client';

import { useState } from 'react';

import { useParams, useRouter } from 'next/navigation';
import { useApp } from '@/lib/store';
import { Header } from '@/components/layout/Header';
import { ProjectCard } from '@/components/projects/ProjectCard';
import { ProjectForm } from '@/components/projects/ProjectForm';
import { ContactForm } from '@/components/contacts/ContactForm';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Avatar } from '@/components/ui/Avatar';
import { FileAttachments } from '@/components/ui/FileAttachments';
import { Edit, Mail, Phone, Building2, StickyNote, Plus, FolderKanban, Target, UserCircle, Receipt } from 'lucide-react';
import { Project } from '@/lib/types';
import { formatPhone } from '@/lib/format-phone';
import { toast } from '@/components/ui/Toast';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';

export default function ContactDetailPage() {
  const params = useParams();
  const router = useRouter();
  const { getContact, getProjectsByContact, getInvoicesByContact, getProject, leads, deleteProject, addProjectContact, updateContact } = useApp();

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
            className="text-sm text-brand-600 hover:text-brand-700"
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
      <Header
        title="Contact Details"
        actions={
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => setIsEditOpen(true)} icon={<Edit size={16} />}>
              <span className="hidden [@media(min-width:400px)]:inline">Edit</span>
            </Button>
          </div>
        }
      />

      <div className="p-4 lg:p-6 space-y-6">
        {/* Contact Info + Leads row */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch">
        <div className="bg-white rounded-xl border border-zinc-200 overflow-hidden flex flex-col max-h-[300px]">
          <div className="flex-shrink-0 px-6 lg:px-7 pt-6 lg:pt-7">
            <div className="flex items-center gap-4 pb-5 border-b border-zinc-100">
              <Avatar name={contact.name} src={contact.avatar_url || undefined} size="lg" />
              <div className="min-w-0">
                <div className="flex flex-col lg:flex-row lg:items-center lg:gap-5">
                  <h2 className="text-lg font-semibold text-zinc-900 truncate">{contact.name}</h2>
                  {contact.company && (
                    <p className="text-sm text-zinc-500 mt-0.5 truncate lg:hidden">{contact.company}</p>
                  )}
                  <div className="flex items-center gap-4 text-sm mt-1 lg:mt-0">
                    {contact.email ? (
                      <a href={`mailto:${contact.email}`} className="flex items-center gap-1.5 text-zinc-600 hover:text-brand-600 transition-colors">
                        <Mail size={14} className="text-zinc-400" />
                        <span>{contact.email}</span>
                      </a>
                    ) : (
                      <span className="flex items-center gap-1.5 text-zinc-300 italic">
                        <Mail size={14} />
                        <span>No email</span>
                      </span>
                    )}
                    {contact.phone ? (
                      <a href={`tel:${contact.phone}`} className="flex items-center gap-1.5 text-zinc-600 hover:text-brand-600 transition-colors">
                        <Phone size={14} className="text-zinc-400" />
                        <span>{formatPhone(contact.phone)}</span>
                      </a>
                    ) : (
                      <span className="flex items-center gap-1.5 text-zinc-300 italic">
                        <Phone size={14} />
                        <span>No phone</span>
                      </span>
                    )}
                  </div>
                </div>
                {contact.company && (
                  <p className="text-sm text-zinc-500 mt-0.5 truncate hidden lg:block">{contact.company}</p>
                )}
              </div>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-6 lg:px-7 py-5">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2 text-zinc-500 text-sm">
                <StickyNote size={14} />
                <span>Notes</span>
              </div>
              {!isEditingNotes && (
                <button
                  onClick={() => { setNotesValue(contact.notes || ''); setIsEditingNotes(true); }}
                  className="text-xs text-brand-600 hover:text-brand-700 transition-colors"
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
                  rows={4}
                  autoFocus
                  className="w-full px-3 py-2 text-sm bg-white border border-zinc-200 rounded-lg outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 resize-none"
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
                    className="px-3 py-1.5 text-xs text-white bg-brand-600 hover:bg-brand-700 rounded-lg transition-colors"
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

        {/* Linked Leads */}
        <div className="bg-white rounded-xl border border-zinc-200 overflow-hidden flex flex-col max-h-[300px]">
          <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-200 flex-shrink-0">
            <div className="flex items-center gap-2">
              <Target size={18} className="text-zinc-500" />
              <h2 className="font-semibold text-zinc-900">
                Leads ({linkedLeads.length})
              </h2>
            </div>
          </div>

          {linkedLeads.length > 0 ? (
            <div className="flex-1 overflow-y-auto divide-y divide-zinc-100">
              {linkedLeads.map((lead) => {
                const statusCfg = STATUS_CONFIG[lead.status] || STATUS_CONFIG.new;
                return (
                  <div key={lead.id} className="px-5 py-4 flex items-center justify-between">
                    <div>
                      <p className="font-medium text-zinc-900 text-sm">{lead.name}</p>
                      <p className="text-xs text-zinc-500">{lead.company}</p>
                    </div>
                    <Badge variant={statusCfg.variant}>{statusCfg.label}</Badge>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
              <div className="w-10 h-10 rounded-full bg-zinc-100 flex items-center justify-center mb-3">
                <Target size={18} className="text-zinc-400" />
              </div>
              <p className="text-sm font-medium text-zinc-500">No leads yet</p>
              <p className="text-xs text-zinc-400 mt-1">Leads linked to this contact will appear here</p>
            </div>
          )}
        </div>
        </div>

        {/* Invoices */}
        {(() => {
          const contactInvoices = getInvoicesByContact(contactId);
          if (contactInvoices.length === 0) return null;
          const statusColors: Record<string, string> = {
            draft: 'bg-zinc-100 text-zinc-600',
            sent: 'bg-blue-50 text-blue-700',
            paid: 'bg-emerald-50 text-emerald-700',
            overdue: 'bg-red-50 text-red-700',
            cancelled: 'bg-zinc-100 text-zinc-400',
          };
          const fmtDate = (dateStr: string) => {
            const [y, m, d] = dateStr.split('-').map(Number);
            const date = new Date(y, m - 1, d);
            const month = date.toLocaleString('en-US', { month: 'short' });
            return y !== new Date().getFullYear() ? `${month} ${d}, ${y}` : `${month} ${d}`;
          };
          const totalPaid = contactInvoices.filter(i => i.status === 'paid').reduce((s, i) => s + i.amount, 0);
          const totalOutstanding = contactInvoices.filter(i => i.status !== 'paid' && i.status !== 'cancelled' && i.status !== 'draft').reduce((s, i) => s + i.amount, 0);
          return (
            <div className="bg-white rounded-xl border border-zinc-200 overflow-hidden flex flex-col">
              <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-200 flex-shrink-0">
                <div className="flex items-center gap-2">
                  <Receipt size={18} className="text-zinc-500" />
                  <h2 className="font-semibold text-zinc-900">Invoices ({contactInvoices.length})</h2>
                </div>
                <div className="flex items-center gap-4 text-xs">
                  <div>
                    <span className="text-zinc-400">Paid</span>
                    <span className="ml-1.5 font-semibold text-emerald-600">${totalPaid.toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
                  </div>
                  <div>
                    <span className="text-zinc-400">Outstanding</span>
                    <span className="ml-1.5 font-semibold text-zinc-900">${totalOutstanding.toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
                  </div>
                </div>
              </div>
              {/* Invoice cards */}
              <div className="flex-1 overflow-y-auto p-4 space-y-2" style={{ maxHeight: '250px' }}>
                {contactInvoices.map((invoice) => {
                  const project = getProject(invoice.project_id);
                  return (
                    <div key={invoice.id} className="p-3 rounded-lg border border-zinc-200 hover:border-zinc-300 transition-colors">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <span className={`inline-flex items-center px-2 py-0.5 text-xs font-medium rounded-full ${statusColors[invoice.status] || 'bg-zinc-100 text-zinc-600'}`}>
                            {invoice.status.charAt(0).toUpperCase() + invoice.status.slice(1)}
                          </span>
                          <span className="text-sm font-semibold text-zinc-900">{invoice.invoice_number}</span>
                        </div>
                        <span className="text-sm font-semibold text-zinc-900">
                          ${invoice.amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-zinc-500">
                        <span>Issued: {fmtDate(invoice.date)}</span>
                        {invoice.due_date && invoice.due_date !== invoice.date && <span>Due: {fmtDate(invoice.due_date)}</span>}
                        {invoice.paid_date && <span className="text-emerald-600">Paid: {fmtDate(invoice.paid_date)}</span>}
                      </div>
                      {project && (
                        <p className="mt-1.5 text-xs text-zinc-400">{project.name}</p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })()}

        {/* Linked Projects + Files row */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch">
          {/* Linked Projects */}
          <div className="bg-white rounded-xl border border-zinc-200 overflow-hidden flex flex-col max-h-[600px]">
            <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-200 flex-shrink-0">
              <div className="flex items-center gap-2">
                <FolderKanban size={18} className="text-zinc-500" />
                <h2 className="font-semibold text-zinc-900">
                  Projects ({linkedProjects.length})
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
              <div className="flex-1 overflow-y-auto p-5">
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                  {linkedProjects.map((project) => (
                    <ProjectCard
                      key={project.id}
                      project={project}
                      onEdit={handleEditProject}
                      onDelete={handleDeleteProject}
                    />
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
                <div className="w-10 h-10 rounded-full bg-zinc-100 flex items-center justify-center mb-3">
                  <FolderKanban size={18} className="text-zinc-400" />
                </div>
                <p className="text-sm font-medium text-zinc-500">No projects linked yet</p>
                <p className="text-xs text-zinc-400 mt-1">Create a project to link it to this contact</p>
              </div>
            )}
          </div>

          <FileAttachments entityType="contact" entityId={contactId} />
        </div>

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
