'use client';

import { useState, useEffect } from 'react';
import { Select } from '@/components/ui/Select';
import { Input } from '@/components/ui/Input';
import { NumberInput } from '@/components/ui/inputs/NumberInput';
import { Tooltip } from '@/components/ui/Tooltip';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { toast } from '@/components/ui/Toast';
import { Settings, Pause, Play } from 'lucide-react';
import { Project } from '@/lib/types';

interface AgentSettingsCardProps {
  project: Project;
  onUpdate: (updates: Partial<Project>) => void;
}

export function AgentSettingsCard({ project, onUpdate }: AgentSettingsCardProps) {
  const [repoPathDraft, setRepoPathDraft] = useState(project.repo_path ?? '');
  const [showPauseConfirm, setShowPauseConfirm] = useState(false);

  useEffect(() => {
    setRepoPathDraft(project.repo_path ?? '');
  }, [project.id]);

  return (
    <div className="bg-white rounded-xl border border-zinc-200 overflow-hidden flex flex-col">
      {/* Header */}
      <div className="px-5 py-4 flex items-center justify-between flex-shrink-0 border-b border-zinc-100">
        <div className="flex items-center gap-2">
          <Settings size={18} className="text-zinc-500" />
          <h2 className="font-semibold text-zinc-900">Configuration</h2>
        </div>
        <Tooltip content={project.autonomous_enabled ? 'Pause agents' : 'Resume agents'}>
          <button
            type="button"
            onClick={() => {
              if (project.autonomous_enabled) {
                setShowPauseConfirm(true);
              } else {
                onUpdate({ autonomous_enabled: true });
                toast('success', 'Autonomous agents enabled');
              }
            }}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 transition-colors"
          >
            {project.autonomous_enabled ? <Pause size={16} /> : <Play size={16} />}
          </button>
        </Tooltip>
      </div>

      {/* Content */}
      <div className="p-5 space-y-5">
        <div className="space-y-1.5">
          <Select
            label="Deployment Policy"
            value={project.deployment_policy ?? 'production'}
            onChange={(value) => onUpdate({ deployment_policy: value as Project['deployment_policy'] })}
            options={[
              { value: 'production', label: 'Production: Feature branches and PRs' },
              { value: 'playground', label: 'Playground: Commits to main directly' },
            ]}
          />
          <p className="text-[11px] text-zinc-400 leading-relaxed">
            {project.deployment_policy === 'playground'
              ? 'AI agents can commit directly to main and trigger deployments.'
              : 'AI agents create feature branches and open pull requests for review.'}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <NumberInput
            label="Max Concurrent Tasks"
            min={1}
            value={project.max_concurrent_tasks ?? 2}
            onChange={(v) => onUpdate({ max_concurrent_tasks: Math.max(1, typeof v === 'number' ? v : 1) })}
          />
          <NumberInput
            label="Suggestions Per Cycle"
            min={1}
            value={project.suggestions_per_cycle ?? 2}
            onChange={(v) => onUpdate({ suggestions_per_cycle: Math.max(1, typeof v === 'number' ? v : 1) })}
          />
        </div>

        <Input
          label="Repository Path"
          value={repoPathDraft}
          onChange={(e) => setRepoPathDraft(e.target.value)}
          onBlur={() => {
            const value = repoPathDraft.trim() || null;
            if (value !== (project.repo_path ?? null)) {
              onUpdate({ repo_path: value });
            }
          }}
          placeholder="/home/user/Projects/my-project"
        />

        {/* Status */}
        <div className="flex items-center justify-between pt-4 border-t border-zinc-100">
          <p className="text-xs text-zinc-400">
            {project.autonomous_enabled
              ? 'Agents are actively generating suggestions for this project.'
              : 'Autonomous agents are paused. Click the play button above to resume.'}
          </p>
        </div>
      </div>

      <ConfirmDialog
        isOpen={showPauseConfirm}
        onClose={() => setShowPauseConfirm(false)}
        onConfirm={() => {
          onUpdate({ autonomous_enabled: false });
          toast('success', 'Autonomous agents paused');
          setShowPauseConfirm(false);
        }}
        title="Pause Autonomous Agents"
        message="If you pause, your agent may stop working on this project entirely depending on how it was integrated. Existing suggestions will be preserved in your database but won't be visible in the interface, and no new suggestions will be generated. Are you sure you want to continue?"
        confirmLabel="Pause"
        variant="default"
      />
    </div>
  );
}
