'use client';

import { useState } from 'react';
import { ListChecks, Sparkles } from 'lucide-react';
import { ChoiceCard, ChoiceGroup, FlowShell, StepFooter, StepPanel } from '@/components/ui/Stepper';

export type HireMode = 'ai' | 'manual';

/**
 * The first screen of Hire an agent: set it up with your own AI tool
 * (recommended: describe it in a sentence and watch), or step by step.
 */
export function HireStart({ exitHref, onPick, isDemo }: { exitHref: string; onPick: (mode: HireMode) => void; isDemo: boolean }) {
  const [mode, setMode] = useState<HireMode>('ai');
  return (
    <FlowShell
      title="Hire an agent"
      subtitle={isDemo ? 'A teammate that works alongside you. In the demo, both ways work and nothing is saved.' : 'A teammate that works alongside you.'}
      exitHref={exitHref}
      stepper={null}
    >
      <StepPanel stepKey="mode" title="How do you want to set it up?" description="Both end in the same place: an agent on the team with its own projects, rules and powers, which you can change any time.">
        <ChoiceGroup label="How to set it up" className="grid gap-3 sm:grid-cols-2">
          <ChoiceCard
            id="mode-ai"
            focusable={mode === 'ai'}
            selected={mode === 'ai'}
            onSelect={() => setMode('ai')}
            icon={<Sparkles size={18} />}
            title="Set it up with AI"
            description="Describe the agent in a sentence. Your AI tool asks what it needs, then hires and sets it up here while you watch."
            meta="Recommended · Claude, ChatGPT or any MCP tool"
          />
          <ChoiceCard
            id="mode-manual"
            focusable={mode === 'manual'}
            selected={mode === 'manual'}
            onSelect={() => setMode('manual')}
            icon={<ListChecks size={18} />}
            title="Step by step"
            description="Pick a template, name it, and choose its projects, rules and powers yourself, one screen at a time."
            meta="About three minutes"
          />
        </ChoiceGroup>
        <StepFooter onNext={() => onPick(mode)} nextLabel={mode === 'ai' ? 'Set it up with AI' : 'Start step by step'} />
      </StepPanel>
    </FlowShell>
  );
}
