'use client';

import { useParams, useRouter } from 'next/navigation';
import { useApp } from '@/lib/store';
import { Header } from '@/components/layout/Header';
import { AgentSettingsCard } from '@/components/agent/AgentSettingsCard';
import { AgentGoalsCard } from '@/components/agent/AgentGoalsCard';
import { ProjectContextPanel } from '@/components/projects/ProjectContextPanel';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ArrowLeft, Bot } from 'lucide-react';

export default function AgentProjectSettingsPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;

  const {
    projects, projectGoals, taskSuggestions, tasks, updateProject,
    addGoal, updateGoal, archiveGoal,
  } = useApp();

  const project = projects.find(p => p.id === projectId);

  if (!project) {
    return (
      <div className="animate-fadeIn min-h-screen bg-zinc-50 flex items-center justify-center">
        <div className="text-center">
          <Bot className="mx-auto mb-3 text-zinc-400" size={40} />
          <h3 className="font-medium text-zinc-700 mb-1">Project Not Found</h3>
          <p className="text-sm text-zinc-500 mb-4">This project may have been archived or deleted.</p>
          <button
            onClick={() => router.push('/agent')}
            className="text-sm text-brand-600 hover:text-brand-700 font-medium"
          >
            Back to Agent Dashboard
          </button>
        </div>
      </div>
    );
  }

  const goals = projectGoals.filter(g => g.project_id === projectId);
  const activeGoalCount = goals.filter(g => !g.archived_at).length;

  return (
    <div className="animate-fadeIn min-h-screen bg-zinc-50">
      <Header
        title={project.name}
        subtitle={
          <div className="flex items-center gap-2.5">
            {project.color && (
              <span
                className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                style={{ backgroundColor: project.color }}
              />
            )}
            <Badge variant={project.deployment_policy === 'playground' ? 'purple' : 'default'}>
              {project.deployment_policy === 'playground' ? 'Playground' : 'Production'}
            </Badge>
            <span className="text-xs text-zinc-400">
              {activeGoalCount} goal{activeGoalCount !== 1 ? 's' : ''}
            </span>
          </div>
        }
        actions={
          <Button
            variant="secondary"
            icon={<ArrowLeft size={16} />}
            onClick={() => router.push('/agent')}
          >
            <span className="hidden sm:inline">Dashboard</span>
          </Button>
        }
      />

      <div className="p-4 lg:p-6 space-y-6">
        {/* Settings + Goals */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch">
          <AgentSettingsCard
            project={project}
            onUpdate={(updates) => updateProject(projectId, updates)}
          />
          <AgentGoalsCard
            projectId={projectId}
            goals={goals}
            taskSuggestions={taskSuggestions}
            tasks={tasks}
            onAdd={addGoal}
            onUpdate={updateGoal}
            onArchive={archiveGoal}
          />
        </div>

        {/* Project Context */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="font-semibold text-zinc-900">Project Context</h2>
              <p className="text-xs text-zinc-400 mt-0.5">
                Help AI agents understand this project by adding context entries.
              </p>
            </div>
          </div>
          <ProjectContextPanel projectId={projectId} />
        </div>
      </div>
    </div>
  );
}
