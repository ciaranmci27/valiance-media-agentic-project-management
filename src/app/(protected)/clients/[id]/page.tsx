'use client';

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useApp } from '@/lib/store';
import { Header } from '@/components/layout/Header';
import { ProjectCard } from '@/components/projects/ProjectCard';
import { ProjectForm } from '@/components/projects/ProjectForm';
import { ClientForm } from '@/components/clients/ClientForm';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Edit, Mail, Phone, Building2, StickyNote, Plus, ArrowLeft, FolderKanban, Target } from 'lucide-react';
import { Project } from '@/lib/types';
import { toast } from '@/components/ui/Toast';

export default function ClientDetailPage() {
  const params = useParams();
  const router = useRouter();
  const { getClient, getProjectsByClient, leads, deleteProject } = useApp();

  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isProjectFormOpen, setIsProjectFormOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);

  const clientId = params.id as string;
  const client = getClient(clientId);

  if (!client) {
    return (
      <div className="animate-fadeIn min-h-screen bg-zinc-50 flex items-center justify-center">
        <div className="text-center">
          <Building2 className="mx-auto mb-3 text-zinc-400" size={40} />
          <h3 className="font-medium text-zinc-700 mb-1">Client not found</h3>
          <button
            onClick={() => router.push('/clients')}
            className="text-sm text-indigo-600 hover:text-indigo-700"
          >
            Back to clients
          </button>
        </div>
      </div>
    );
  }

  const linkedProjects = getProjectsByClient(clientId);
  const linkedLeads = leads.filter(l => l.client_id === clientId);

  const handleEditProject = (project: Project) => {
    setEditingProject(project);
    setIsProjectFormOpen(true);
  };

  const handleDeleteProject = (id: string) => {
    if (confirm('Are you sure you want to delete this project?')) {
      deleteProject(id);
      toast('success', 'Project deleted');
    }
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
        title={client.name}
        subtitle={client.company || undefined}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => router.push('/clients')} icon={<ArrowLeft size={16} />}>
              Back
            </Button>
            <Button variant="secondary" onClick={() => setIsEditOpen(true)} icon={<Edit size={16} />}>
              Edit
            </Button>
          </div>
        }
      />

      <div className="p-4 lg:p-6 space-y-6">
        {/* Client Info Card */}
        <div className="bg-white rounded-xl border border-zinc-200 p-5 lg:p-6">
          <div className="flex items-center gap-3 mb-4">
            <div
              className="w-4 h-4 rounded-full"
              style={{ backgroundColor: client.color }}
            />
            <h2 className="text-lg font-semibold text-zinc-900">{client.name}</h2>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-sm">
            {client.company && (
              <div className="flex items-center gap-2 text-zinc-600">
                <Building2 size={16} className="text-zinc-400" />
                <span>{client.company}</span>
              </div>
            )}
            {client.email && (
              <div className="flex items-center gap-2 text-zinc-600">
                <Mail size={16} className="text-zinc-400" />
                <span>{client.email}</span>
              </div>
            )}
            {client.phone && (
              <div className="flex items-center gap-2 text-zinc-600">
                <Phone size={16} className="text-zinc-400" />
                <span>{client.phone}</span>
              </div>
            )}
          </div>

          {client.notes && (
            <div className="mt-4 pt-4 border-t border-zinc-100">
              <div className="flex items-center gap-2 text-zinc-500 text-sm mb-1">
                <StickyNote size={14} />
                <span>Notes</span>
              </div>
              <p className="text-sm text-zinc-700 whitespace-pre-wrap">{client.notes}</p>
            </div>
          )}
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
              <p>No projects linked to this client</p>
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

      <ClientForm
        isOpen={isEditOpen}
        onClose={() => setIsEditOpen(false)}
        client={client}
      />

      <ProjectForm
        isOpen={isProjectFormOpen}
        onClose={handleCloseProjectForm}
        project={editingProject}
        defaultClientId={clientId}
      />
    </div>
  );
}
