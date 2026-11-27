'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, MessageSquare, PartyPopper } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { invalidateTables, useRead } from '@/lib/query-cache';
import { assistantSettingsReadFor, assistantStatusReadFor } from '@/lib/reads';
import { PERSONAL_HIRE_STEPS, personalHireState } from '@/lib/agent-access-ui';
import { WorkspaceApiError, workspaceApi } from '@/lib/agent-workspace';
import type { HirePersonalResult } from '@/lib/api/personal-hire';
import { assistantNameFor } from '@/lib/personal-agents';
import { ASSISTANTS_SETUP_HREF } from '@/lib/assistant';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/inputs/Select';
import { FlowShell, StepFooter, StepPanel, Stepper } from '@/components/ui/Stepper';
import { AgentAvatar } from '@/components/agent/AgentAvatar';

/**
 * Hire's personal path, one thing per screen (DESIGN.md Rule 18): for whom
 * (anyone who has none yet; one per person), connect their chat (optional,
 * on Your assistant, where only they link their own account), then "It
 * works, try it" with the one action that proves it. Owner only, like the
 * hire it sits in; the assistant is made by POST /api/workspace/agents/personal.
 */
const YOUR_ASSISTANT_HREF = '/ai?tab=assistant';

export function PersonalHireFlow({ exitHref, onBack }: { exitHref: string; onBack: () => void }) {
  const { team } = useApp();
  const { teamMemberId } = useAuth();
  const { isDemoMode } = useDemo();
  const settings = useRead(assistantSettingsReadFor(isDemoMode)).data;
  const status = useRead(assistantStatusReadFor(isDemoMode));
  const people = useMemo(() => team.filter((m) => m.role !== 'agent' && m.status !== 'suspended').sort((a, b) => a.name.localeCompare(b.name)), [team]);
  // Until someone is picked: you, or the first person without an assistant once you have one.
  const [picked, setPersonId] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<HirePersonalResult | null>(null);
  const existing = (status.data ?? []).map((row) => ({ id: row.id, name: row.name, delegate_of: row.person.id }));
  const hasOne = (id: string) => existing.some((row) => row.delegate_of === id);
  const personId = picked ?? (teamMemberId && !hasOne(teamMemberId) ? teamMemberId : people.find((p) => !hasOne(p.id))?.id ?? teamMemberId ?? '');
  const person = people.find((p) => p.id === personId) ?? null;
  const state = personalHireState(person?.id ?? null, person?.name ?? null, existing);
  const forMe = personId === teamMemberId;
  const firstName = person?.name.split(' ')[0] ?? 'them';
  const assistantsOff = settings ? !settings.enabled : false;
  // Until the switch is known, the hire waits: with assistants off it would be refused.
  const settingsKnown = !!settings;

  const hire = async () => {
    if (!person || !state.ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = isDemoMode
        ? { agent: { id: `demo-assistant-${person.id.slice(-4)}`, name: assistantNameFor(person.name) }, person: { id: person.id, name: person.name }, created: true }
        : await workspaceApi<HirePersonalResult>('/api/workspace/agents/personal', { method: 'POST', body: { person_id: person.id } });
      if (!isDemoMode) invalidateTables(['team_members']);
      setMade(result);
      setStep(1);
    } catch (failure) {
      // Turned off since this screen read the switch: read it again, so the screen says so.
      if (failure instanceof WorkspaceApiError && (failure.details as { reason?: string } | undefined)?.reason === 'assistants_off') {
        invalidateTables(['business_settings']);
        return;
      }
      setError(failure instanceof Error ? failure.message : 'Could not make the assistant');
    } finally {
      setBusy(false);
    }
  };

  return (
    <FlowShell
      title="Give someone an assistant"
      subtitle={isDemoMode ? 'Every step works in the demo; nothing is saved.' : 'A personal assistant works only for its person.'}
      exitHref={exitHref}
      exitLabel={made ? 'Close' : 'Cancel'}
      stepper={<Stepper steps={PERSONAL_HIRE_STEPS} current={step} reached={step} label="Assistant steps" />}
    >
      {step === 0 && (
        <StepPanel stepKey="person" title="Who is it for?" description="It sees only what they can see, and only they talk to it.">
          <div className="space-y-4">
            <Select
              label="Person"
              value={personId}
              onChange={(id) => { setPersonId(id); setError(null); }}
              options={people.map((p) => ({ value: p.id, label: p.id === teamMemberId ? `${p.name} (you)` : p.name }))}
              searchable={people.length > 8}
              placeholder="Pick a person"
            />
            {person && (
              <p role="status" className="text-sm text-zinc-300">
                {state.existing
                  ? <>{state.words} <Link href={`/ai/agents/${state.existing.id}`} className="font-medium text-brand-300 underline-offset-2 hover:underline">Open it</Link></>
                  : state.words}
              </p>
            )}
            {assistantsOff && (
              <p role="status" className="rounded-xl bg-amber-500/[0.10] px-4 py-3 text-sm text-amber-300">
                Assistants are off. <Link href={ASSISTANTS_SETUP_HREF} className="font-medium underline-offset-2 hover:underline">Turn on in Setup</Link>
              </p>
            )}
          </div>
          <StepFooter
            onBack={onBack}
            onNext={() => void hire()}
            nextLabel={forMe ? 'Make my assistant' : `Give ${firstName} an assistant`}
            nextDisabled={!state.ready || assistantsOff || !settingsKnown}
            busy={busy}
            busyLabel="Making it"
            error={error}
          />
        </StepPanel>
      )}

      {step === 1 && made && (
        <StepPanel stepKey="chat" title={forMe ? 'Connect your chat' : `${firstName} connects their chat`} description="Optional. With a chat linked, the assistant answers in Slack or Telegram as well as here.">
          <div className="flex items-start gap-4 rounded-2xl bg-white/[0.025] p-4 ring-1 ring-inset ring-white/[0.06] sm:p-5">
            <MessageSquare size={18} className="mt-0.5 flex-shrink-0 text-zinc-400" aria-hidden="true" />
            <p className="min-w-0 flex-1 text-sm text-zinc-300">
              {forMe
                ? <>Open Your assistant and pick Slack or Telegram. The bot sends you a link to finish linking your account.</>
                : <>Only {firstName} can link their own chat account. They find it on Your assistant the next time they open the app.</>}
            </p>
            {forMe && <Button size="sm" variant="secondary" href={`${YOUR_ASSISTANT_HREF}#chat-accounts`}>Connect my chat</Button>}
          </div>
          <StepFooter onNext={() => setStep(2)} nextLabel={forMe ? 'Skip for now' : 'Next'} />
        </StepPanel>
      )}

      {step === 2 && made && (
        <StepPanel stepKey="done" title="It works, try it" description={forMe ? 'Ask it something: what is due this week, or to remind you tomorrow.' : `${made.agent.name} is ready for ${firstName}.`}>
          <div className="flex flex-col items-start gap-6 rounded-2xl bg-white/[0.025] p-6 ring-1 ring-inset ring-white/[0.06] sm:flex-row sm:items-center">
            <AgentAvatar id={made.agent.id} name={made.agent.name} presence="idle" size="xl" />
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 text-lg font-semibold text-white"><PartyPopper size={18} className="text-brand-300" aria-hidden="true" />{made.created ? made.agent.name : `${made.agent.name} was already there`}</p>
              <p className="mt-1 text-sm text-zinc-400">{forMe ? 'Your personal assistant.' : `${made.person.name}'s personal assistant.`}</p>
            </div>
          </div>
          <div className="mt-8 flex flex-wrap gap-3">
            {forMe
              ? <Button href={YOUR_ASSISTANT_HREF} icon={<ArrowRight size={15} aria-hidden="true" />}>Send it a message</Button>
              : !isDemoMode && <Button href={`/ai/agents/${made.agent.id}`} icon={<ArrowRight size={15} aria-hidden="true" />}>Open its page</Button>}
            <Button variant="ghost" href={exitHref}>Done</Button>
          </div>
        </StepPanel>
      )}
    </FlowShell>
  );
}
