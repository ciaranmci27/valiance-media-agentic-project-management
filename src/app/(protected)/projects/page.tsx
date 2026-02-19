'use client';

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { useApp } from '@/lib/store';
import { Header } from '@/components/layout/Header';
import { ProjectCard } from '@/components/projects/ProjectCard';
import { ProjectForm } from '@/components/projects/ProjectForm';
import { Button } from '@/components/ui/Button';
import { Plus, FolderKanban, Search } from 'lucide-react';
import { Project } from '@/lib/types';
import { toast } from '@/components/ui/Toast';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';

function ProjectsContent() {
  const searchParams = useSearchParams();
  const { projects, deleteProject } = useApp();
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [search, setSearch] = useState('');
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null);

  // Check for ?new=true in URL
  useEffect(() => {
    if (searchParams.get('new') === 'true') {
      setIsFormOpen(true);
    }
  }, [searchParams]);

  const handleEdit = (project: Project) => {
    setEditingProject(project);
    setIsFormOpen(true);
  };

  const handleDelete = (id: string) => {
    setDeletingProjectId(id);
  };

  const executeDelete = () => {
    if (!deletingProjectId) return;
    deleteProject(deletingProjectId);
    toast('success', 'Project deleted');
  };

  const handleCloseForm = () => {
    setIsFormOpen(false);
    setEditingProject(null);
  };

  const searchLower = search.toLowerCase();
  const filtered = search
    ? projects.filter(p =>
        p.name.toLowerCase().includes(searchLower) ||
        p.description.toLowerCase().includes(searchLower))
    : projects;

  const activeProjects = filtered.filter(p => p.status === 'active');
  const completedProjects = filtered.filter(p => p.status === 'completed');
  const archivedProjects = filtered.filter(p => p.status === 'archived');

  return (
    <>
      <Header 
        title="Projects" 
        subtitle={`${projects.length} total projects`}
        actions={
          <Button onClick={() => setIsFormOpen(true)} icon={<Plus size={16} />}>
            New Project
          </Button>
        }
      />

      <div className="p-4 lg:p-6 space-y-6 lg:space-y-8">
        {projects.length > 0 && (
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search projects..."
              className="w-full pl-10 pr-4 py-2.5 bg-white border border-zinc-200 rounded-lg text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            />
          </div>
        )}

        {projects.length === 0 ? (
          <div className="text-center py-16 bg-white rounded-xl border border-zinc-200">
            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-zinc-100 flex items-center justify-center">
              <FolderKanban className="text-zinc-400" size={32} />
            </div>
            <h3 className="text-lg font-semibold text-zinc-900 mb-2">No projects yet</h3>
            <p className="text-zinc-500 mb-4">Create your first project to get started</p>
            <Button onClick={() => setIsFormOpen(true)}>
              Create Project
            </Button>
          </div>
        ) : (
          <>
            {activeProjects.length > 0 && (
              <section>
                <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wider mb-4">
                  Active ({activeProjects.length})
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-2 xl:grid-cols-3 gap-4">
                  {activeProjects.map((project) => (
                    <ProjectCard
                      key={project.id}
                      project={project}
                      onEdit={handleEdit}
                      onDelete={handleDelete}
                    />
                  ))}
                </div>
              </section>
            )}

            {completedProjects.length > 0 && (
              <section>
                <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wider mb-4">
                  Completed ({completedProjects.length})
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-2 xl:grid-cols-3 gap-4">
                  {completedProjects.map((project) => (
                    <ProjectCard
                      key={project.id}
                      project={project}
                      onEdit={handleEdit}
                      onDelete={handleDelete}
                    />
                  ))}
                </div>
              </section>
            )}

            {archivedProjects.length > 0 && (
              <section>
                <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wider mb-4">
                  Archived ({archivedProjects.length})
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-2 xl:grid-cols-3 gap-4">
                  {archivedProjects.map((project) => (
                    <ProjectCard
                      key={project.id}
                      project={project}
                      onEdit={handleEdit}
                      onDelete={handleDelete}
                    />
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>

      <ProjectForm
        isOpen={isFormOpen}
        onClose={handleCloseForm}
        project={editingProject}
      />

      <ConfirmDialog
        isOpen={!!deletingProjectId}
        onClose={() => setDeletingProjectId(null)}
        onConfirm={executeDelete}
        title="Delete Project"
        message="This will permanently delete the project and all its tasks. This action cannot be undone."
        confirmLabel="Delete"
        variant="danger"
      />
    </>
  );
}

export default function ProjectsPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-zinc-50 flex items-center justify-center">
        <div className="text-zinc-500">Loading...</div>
      </div>
    }>
      <ProjectsContent />
    </Suspense>
  );
}
