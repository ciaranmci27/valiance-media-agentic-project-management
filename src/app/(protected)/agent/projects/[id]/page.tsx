'use client';

import { useParams, useRouter } from 'next/navigation';
import { useApp } from '@/lib/store';
import { Header } from '@/components/layout/Header';
import { AgentSettingsCard } from '@/components/agent/AgentSettingsCard';
import { ProjectPipelineStrip } from '@/components/agent/ProjectPipelineStrip';
import { AuditQuestionsCard } from '@/components/agent/AuditQuestionsCard';
import { ActivityTimeline } from '@/components/agent/ActivityTimeline';
import { AgentGoalsCard } from '@/components/agent/AgentGoalsCard';
import { ProjectContextPanel } from '@/components/projects/ProjectContextPanel';
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
      <div className="animate-fadeIn min-h-screen flex items-center justify-center">
        <div className="text-center">
          <Bot className="mx-auto mb-3 text-zinc-500" size={40} />
          <h3 className="font-medium text-zinc-300 mb-1">Project Not Found</h3>
          <p className="text-sm text-zinc-400 mb-4">This project may have been archived or deleted.</p>
          <button
            onClick={() => router.push('/agent')}
            className="text-sm text-brand-300 hover:text-brand-300 font-medium"
          >
            Back to Agent Dashboard
          </button>
        </div>
      </div>
    );
  }

  const goals = projectGoals.filter(g => g.project_id === projectId);

  return (
    <div className="animate-fadeIn min-h-screen">
      <Header
        title={project.name}
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
        {/* This project's pipeline heartbeat: queue, audits, build, merges */}
        <ProjectPipelineStrip project={project} />

        {/* Settings on the left; the right rail stacks Goals and the question
            selection so both columns fill, instead of one tall card facing one
            short card across a stretched grid. */}
        {/* No cross-column height coupling: a shared fixed band breaks the
            moment any card's natural height shifts with viewport width (it
            starved the activity feed at one width and the context entries at
            another). Instead the two cards that can grow without limit carry
            their own generous fixed windows and scroll internally; everything
            else sits at natural height. Columns end within a card-gap of each
            other at common widths, and nothing on the page ever reflows. */}
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 items-start">
          <div className="lg:col-span-3 space-y-6">
            <AgentSettingsCard
              project={project}
              onUpdate={(updates) => updateProject(projectId, updates)}
            />
            <ActivityTimeline projectId={projectId} listMaxHeightClass="max-h-[500px]" />
          </div>
          <div className="lg:col-span-2 space-y-6">
            <AgentGoalsCard
              projectId={projectId}
              goals={goals}
              taskSuggestions={taskSuggestions}
              tasks={tasks}
              onAdd={addGoal}
              onUpdate={updateGoal}
              onArchive={archiveGoal}
            />
            <AuditQuestionsCard projectId={projectId} />
            <ProjectContextPanel projectId={projectId} />
          </div>
        </div>
      </div>
    </div>
  );
}
