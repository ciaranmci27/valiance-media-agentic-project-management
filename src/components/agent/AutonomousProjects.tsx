'use client';

import { useRouter } from 'next/navigation';
import { useApp } from '@/lib/store';
import { Tooltip } from '@/components/ui/Tooltip';
import Modal from '@/components/ui/Modal';
import { useState } from 'react';
import {
  Plus, Pause, Play, FolderKanban, ChevronRight, Settings,
} from 'lucide-react';
import { toast } from '@/components/ui/Toast';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';

export function AutonomousProjects() {
  const { projects, projectGoals, taskSuggestions, updateProject } = useApp();
  const router = useRouter();
  const [showAddModal, setShowAddModal] = useState(false);
  const [pauseTarget, setPauseTarget] = useState<string | null>(null);

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
    if (currentEnabled) {
      setPauseTarget(projectId);
      return;
    }
    updateProject(projectId, { autonomous_enabled: true });
    toast('success', 'Autonomous agents enabled');
  };

  const handleConfirmPause = () => {
    if (!pauseTarget) return;
    updateProject(pauseTarget, { autonomous_enabled: false });
    toast('success', 'Autonomous agents paused');
    setPauseTarget(null);
  };

  const handleEnable = (projectId: string) => {
    updateProject(projectId, { autonomous_enabled: true });
    toast('success', 'Project enabled for autonomous agents');
    setShowAddModal(false);
  };

  return (
    <>
      <div className="glass-card rounded-xl overflow-hidden flex flex-col">
        <div className="p-4 border-b border-white/[0.06] flex items-center justify-between flex-shrink-0">
          <h2 className="font-semibold text-white">Active Projects</h2>
          <button
            onClick={() => setShowAddModal(true)}
            aria-label="Enable agents on a project"
            className="p-1.5 rounded-lg text-zinc-500 hover:text-brand-300 hover:bg-brand-500/15 transition-colors"
          >
            <Plus size={16} />
          </button>
        </div>

        <div className="divide-y divide-white/[0.06] overflow-y-auto board-column-scroll max-h-[200px]">
          {autonomousProjects.map((project) => {
            const goalCount = getGoalCount(project.id);
            const pendingCount = getPendingCount(project.id);

            return (
              <div
                key={project.id}
                role="button"
                tabIndex={0}
                onClick={() => router.push(`/agent/projects/${project.id}`)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    router.push(`/agent/projects/${project.id}`);
                  }
                }}
                className="p-3 lg:p-4 hover:bg-white/[0.03] transition-colors group cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500 focus-visible:-outline-offset-2"
              >
                <div className="flex items-center gap-3">
                  {project.color && (
                    <div
                      className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                      style={{ backgroundColor: project.color }}
                    />
                  )}

                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-white truncate">
                      {project.name}
                    </p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-xs text-zinc-500">
                        {goalCount} goal{goalCount !== 1 ? 's' : ''}
                      </span>
                      {pendingCount > 0 && (
                        <>
                          <span className="text-xs text-zinc-600">&middot;</span>
                          <span className="text-xs text-amber-400 font-medium">
                            {pendingCount} pending
                          </span>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-0.5 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100 transition-opacity flex-shrink-0">
                    <Tooltip content="Agent settings">
                      <button
                        onClick={(e) => { e.stopPropagation(); router.push(`/agent/projects/${project.id}`); }}
                        aria-label={`Agent settings for ${project.name}`}
                        className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.06] transition-colors"
                      >
                        <Settings size={14} aria-hidden="true" />
                      </button>
                    </Tooltip>
                    <Tooltip content={project.autonomous_enabled ? 'Pause agents' : 'Resume agents'}>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleToggle(project.id, project.autonomous_enabled); }}
                        aria-label={project.autonomous_enabled ? `Pause agents on ${project.name}` : `Resume agents on ${project.name}`}
                        className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.06] transition-colors"
                      >
                        {project.autonomous_enabled ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
                      </button>
                    </Tooltip>
                  </div>
                </div>
              </div>
            );
          })}

          {autonomousProjects.length === 0 && (
            <div className="py-8 text-center">
              <FolderKanban className="mx-auto mb-2 text-zinc-600" size={24} />
              <p className="text-sm text-zinc-500">No autonomous projects</p>
              <button
                onClick={() => setShowAddModal(true)}
                className="text-sm text-brand-300 hover:text-brand-300 mt-1"
              >
                Add a project
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Inactive Projects */}
      {availableProjects.length > 0 && (
        <div className="glass-card rounded-xl overflow-hidden flex flex-col">
          <div className="p-4 border-b border-white/[0.06] flex-shrink-0">
            <h2 className="font-semibold text-white">Inactive Projects</h2>
          </div>
          <div className="divide-y divide-white/[0.06] overflow-y-auto board-column-scroll max-h-[200px]">
            {availableProjects.map((project) => {
              const goalCount = getGoalCount(project.id);

              return (
                <div
                  key={project.id}
                  role="button"
                  tabIndex={0}
                  className="p-3 lg:p-4 hover:bg-white/[0.03] transition-colors group cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500 focus-visible:-outline-offset-2"
                  onClick={() => router.push(`/agent/projects/${project.id}`)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      router.push(`/agent/projects/${project.id}`);
                    }
                  }}
                >
                  <div className="flex items-center gap-3">
                    {project.color && (
                      <div
                        className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                        style={{ backgroundColor: project.color }}
                      />
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-white truncate">{project.name}</p>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-xs text-zinc-500">
                          {goalCount} goal{goalCount !== 1 ? 's' : ''}
                        </span>
                        <span className="text-xs text-zinc-600">&middot;</span>
                        <span className="text-[10px] font-semibold uppercase text-zinc-500">
                          Not enabled
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-0.5 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100 transition-opacity flex-shrink-0">
                      <Tooltip content="Agent settings">
                        <button
                          onClick={(e) => { e.stopPropagation(); router.push(`/agent/projects/${project.id}`); }}
                          aria-label={`Agent settings for ${project.name}`}
                          className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.06] transition-colors"
                        >
                          <Settings size={14} aria-hidden="true" />
                        </button>
                      </Tooltip>
                      <Tooltip content="Enable agents">
                        <button
                          onClick={(e) => { e.stopPropagation(); handleEnable(project.id); }}
                          aria-label={`Enable agents on ${project.name}`}
                          className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.06] transition-colors"
                        >
                          <Play size={14} aria-hidden="true" />
                        </button>
                      </Tooltip>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Add Project Modal */}
      <Modal isOpen={showAddModal} onClose={() => setShowAddModal(false)} title="Enable Autonomous Agents" size="sm">
        <div className="space-y-1">
          <p className="text-sm text-zinc-400 mb-4">
            Select a project to enable autonomous AI agents. Agents will analyze goals and suggest tasks.
          </p>

          {availableProjects.length > 0 ? (
            <div className="divide-y divide-white/[0.06] border border-white/[0.08] rounded-lg overflow-hidden">
              {availableProjects.map((project) => (
                <button
                  key={project.id}
                  onClick={() => handleEnable(project.id)}
                  className="w-full flex items-center gap-3 px-4 py-3 hover:bg-white/[0.03] transition-colors text-left"
                >
                  {project.color && (
                    <div
                      className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                      style={{ backgroundColor: project.color }}
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-white truncate">{project.name}</p>
                    {project.description && (
                      <p className="text-xs text-zinc-500 truncate">{project.description}</p>
                    )}
                  </div>
                  <ChevronRight size={14} className="text-zinc-600" />
                </button>
              ))}
            </div>
          ) : (
            <div className="text-center py-6">
              <p className="text-sm text-zinc-500">All projects are already autonomous</p>
            </div>
          )}
        </div>
      </Modal>

      <ConfirmDialog
        isOpen={pauseTarget !== null}
        onClose={() => setPauseTarget(null)}
        onConfirm={handleConfirmPause}
        title="Pause Autonomous Agents"
        message="If you pause, your agent may stop working on this project entirely depending on how it was integrated. Existing suggestions will be preserved in your database but won't be visible in the interface, and no new suggestions will be generated. Are you sure you want to continue?"
        confirmLabel="Pause"
        variant="default"
      />
    </>
  );
}
