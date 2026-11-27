'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Building2, Sparkles, UserRound } from 'lucide-react';
import type { HireKind } from '@/lib/agent-access-ui';
import { useAuth } from '@/lib/auth-context';
import { useRead } from '@/lib/query-cache';
import { assistantSettingsReadFor } from '@/lib/reads';
import { ASSISTANTS_SETUP_HREF } from '@/lib/assistant';
import { Button } from '@/components/ui/Button';
import { ChoiceCard, ChoiceGroup, FlowShell, StepFooter, StepPanel } from '@/components/ui/Stepper';

export type HireMode = 'ai' | 'manual';

/** How to lay out an agent team, for anyone unsure which to pick. */
export const STRUCTURE_DOC_HREF = 'https://github.com/ciaranmci27/valiance-media-agentic-project-management/blob/main/docs/agents/structure-your-team.md';

/**
 * The first screen of Hire: "Personal assistant or company agent?". A
 * company agent works for the company (it joins the agent team, under an
 * orchestrator); a personal assistant works for one person. Set it up with
 * AI stays the other way in, for a company agent. With assistants off for
 * the workspace the personal choice stays in view, dimmed, saying so, with
 * the way to turn them on for an Owner: never a path that ends in a refusal.
 */
export function HireStart({ exitHref, onPick, onAi, isDemo }: { exitHref: string; onPick: (kind: HireKind) => void; onAi: () => void; isDemo: boolean }) {
  const [picked, setKind] = useState<HireKind>('company');
  const { access } = useAuth();
  const settings = useRead(assistantSettingsReadFor(isDemo)).data;
  const assistantsOff = settings ? !settings.enabled : false;
  const kind: HireKind = assistantsOff ? 'company' : picked;
  return (
    <FlowShell
      title="Hire"
      subtitle={isDemo ? 'Every path works in the demo; nothing is saved.' : 'An agent that works alongside your team.'}
      exitHref={exitHref}
      stepper={null}
    >
      <StepPanel stepKey="kind" title="Personal assistant or company agent?" description="One assistant per person, and company agents for the work everyone shares.">
        <ChoiceGroup label="What to hire" className="grid gap-3 sm:grid-cols-2">
          <ChoiceCard
            id="kind-company"
            focusable={kind === 'company'}
            selected={kind === 'company'}
            onSelect={() => setKind('company')}
            icon={<Building2 size={18} />}
            title="Company agent"
            description="Works for the company: takes work, joins the agent team under an orchestrator, and asks people only for real decisions."
            meta="A builder, a reviewer, an orchestrator"
          />
          <div className="relative">
            <ChoiceCard
              id="kind-personal"
              focusable={kind === 'personal'}
              selected={kind === 'personal'}
              onSelect={() => setKind('personal')}
              icon={<UserRound size={18} />}
              title="Personal assistant"
              description="Works for one person, within what they can see: their tasks, reminders and inbox, from their own chat."
              meta={assistantsOff ? 'Assistants are off.' : 'One per person'}
              disabled={assistantsOff}
            />
            {/* Beside the card's meta line, outside its button (a link cannot sit in one). */}
            {assistantsOff && access?.role === 'owner' && (
              <Link href={ASSISTANTS_SETUP_HREF} className="absolute bottom-5 right-5 text-xs font-medium text-brand-300 underline-offset-2 hover:underline">
                Turn on in Setup
              </Link>
            )}
          </div>
        </ChoiceGroup>
        <p className="mt-4 text-xs text-zinc-400">
          Not sure how to lay out your agents?{' '}
          <a href={STRUCTURE_DOC_HREF} target="_blank" rel="noopener noreferrer" className="font-medium text-brand-300 underline-offset-2 hover:underline">How to structure your agent team</a>
        </p>
        <StepFooter
          onNext={() => onPick(kind)}
          nextLabel={kind === 'company' ? 'Hire a company agent' : 'Give someone an assistant'}
          extra={kind === 'company' ? <Button variant="ghost" icon={<Sparkles size={14} aria-hidden="true" />} onClick={onAi}>Set it up with AI</Button> : undefined}
        />
      </StepPanel>
    </FlowShell>
  );
}
