'use client';

import { useState } from 'react';
import { useApp } from '@/lib/store';
import { useRouter } from 'next/navigation';
import { Tooltip } from '@/components/ui/Tooltip';
import Modal from '@/components/ui/Modal';
import {
  Plus, Pause, Play, FolderKanban, ChevronRight,
} from 'lucide-react';
import { toast } from '@/components/ui/Toast';

export function AutonomousProjects() {
  const { projects, projectGoals, taskSuggestions, updateProject } = useApp();
  const router = useRouter();
  const [showAddModal, setShowAddModal] = useState(false);

  const autonomousProjects = projects
    .filter(p => p.autonomous_enabled && !p.archived_at)
    .sort((a, b) => a.name.localeCompare(b.name));

  const availableProjects = projects
    .filter(p => !p.autonomous_enabled && !p.archived_at && p.status === 'active')
    .sort((a, b) => a.name.localeCompare(b.name));

  const getGoalCount = (projectId: string) =>
    projectGoals.filter(g => g.project_id === projectId && !g.archived_at).length;

  const getPendingCount = (projectId: string) =>
    taskSuggestions.filter(s => s.project_id === projectId && s.status === 'pending').length;

  const handleToggle = (projectId: string, currentEnabled: boolean) => {
    updateProject(projectId, { autonomous_enabled: !currentEnabled });
    toast('success', currentEnabled ? 'Autonomous agents paused' : 'Autonomous agents enabled');
  };

  const handleEnable = (projectId: string) => {
    updateProject(projectId, { autonomous_enabled: true });
    toast('success', 'Project enabled for autonomous agents');
    setShowAddModal(false);
  };

  return (
    <>
      <div className="bg-white rounded-xl border border-zinc-200 overflow-hidden flex flex-col">
        <div className="p-4 border-b border-zinc-100 flex items-center justify-between flex-shrink-0">
          <h2 className="font-semibold text-zinc-900">Projects</h2>
          <button
            onClick={() => setShowAddModal(true)}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-brand-600 hover:bg-brand-50 transition-colors"
          >
            <Plus size={16} />
          </button>
        </div>

        <div className="divide-y divide-zinc-100 overflow-y-auto board-column-scroll max-h-[250px]">
          {autonomousProjects.map((project) => {
            const goalCount = getGoalCount(project.id);
            const pendingCount = getPendingCount(project.id);

            return (
              <div
                key={project.id}
                className="p-3 lg:p-4 hover:bg-zinc-50 transition-colors group"
              >
                <div className="flex items-center gap-3">
                  {/* Project color dot */}
                  {project.color && (
                    <div
                      className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                      style={{ backgroundColor: project.color }}
                    />
                  )}

                  {/* Project info */}
                  <button
                    onClick={() => router.push(`/projects/${project.id}`)}
                    className="flex-1 min-w-0 text-left"
                  >
                    <p className="text-sm font-medium text-zinc-900 truncate group-hover:text-brand-600 transition-colors">
                      {project.name}
                    </p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-xs text-zinc-400">
                        {goalCount} goal{goalCount !== 1 ? 's' : ''}
                      </span>
                      {pendingCount > 0 && (
                        <>
                          <span className="text-xs text-zinc-300">&middot;</span>
                          <span className="text-xs text-amber-600 font-medium">
                            {pendingCount} pending
                          </span>
                        </>
                      )}
                      <span className="text-xs text-zinc-300">&middot;</span>
                      <span className={`text-[10px] font-semibold uppercase ${
                        project.deployment_policy === 'playground'
                          ? 'text-violet-600'
                          : 'text-zinc-400'
                      }`}>
                        {project.deployment_policy === 'playground' ? 'Playground' : 'Production'}
                      </span>
                    </div>
                  </button>

                  {/* Pause/Play toggle */}
                  <Tooltip content={project.autonomous_enabled ? 'Pause agents' : 'Resume agents'}>
                    <button
                      onClick={() => handleToggle(project.id, project.autonomous_enabled)}
                      className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 transition-colors opacity-0 group-hover:opacity-100 flex-shrink-0"
                    >
                      {project.autonomous_enabled ? <Pause size={14} /> : <Play size={14} />}
                    </button>
                  </Tooltip>
                </div>
              </div>
            );
          })}

          {autonomousProjects.length === 0 && (
            <div className="py-8 text-center">
              <FolderKanban className="mx-auto mb-2 text-zinc-300" size={24} />
              <p className="text-sm text-zinc-400">No autonomous projects</p>
              <button
                onClick={() => setShowAddModal(true)}
                className="text-sm text-brand-600 hover:text-brand-700 mt-1"
              >
                Add a project
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Add Project Modal */}
      <Modal isOpen={showAddModal} onClose={() => setShowAddModal(false)} title="Enable Autonomous Agents" size="sm">
        <div className="space-y-1">
          <p className="text-sm text-zinc-500 mb-4">
            Select a project to enable autonomous AI agents. Agents will analyze goals and suggest tasks.
          </p>

          {availableProjects.length > 0 ? (
            <div className="divide-y divide-zinc-100 border border-zinc-200 rounded-lg overflow-hidden">
              {availableProjects.map((project) => (
                <button
                  key={project.id}
                  onClick={() => handleEnable(project.id)}
                  className="w-full flex items-center gap-3 px-4 py-3 hover:bg-zinc-50 transition-colors text-left"
                >
                  {project.color && (
                    <div
                      className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                      style={{ backgroundColor: project.color }}
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-zinc-900 truncate">{project.name}</p>
                    {project.description && (
                      <p className="text-xs text-zinc-400 truncate">{project.description}</p>
                    )}
                  </div>
                  <ChevronRight size={14} className="text-zinc-300" />
                </button>
              ))}
            </div>
          ) : (
            <div className="text-center py-6">
              <p className="text-sm text-zinc-400">All projects are already autonomous</p>
            </div>
          )}
        </div>
      </Modal>
    </>
  );
}
