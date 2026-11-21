'use client';

import { Check, Minus } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { useBrand } from '@/lib/brand/context';
import { DEFAULT_BRAND } from '@/lib/brand';
import { useRead } from '@/lib/query-cache';
import { MODULE_IDS, PRESETS, presetFor } from '@/lib/modules/registry';
import { useModuleSwitch } from '@/components/settings/workspace/workspace-modules';
import { setupChecksRead } from '../setup-checks';
import { StepFrame } from '../StepFrame';

function SummaryRow({ done, title, detail }: { done: boolean; title: string; detail: string }) {
  return (
    <li className="flex items-start gap-3 py-3.5 first:pt-0 last:pb-0">
      <span
        className={`mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full ${done ? 'bg-emerald-500/[0.14] text-emerald-300' : 'bg-white/[0.05] text-zinc-400'}`}
        role="img"
        aria-label={done ? 'Done' : 'Not yet'}
      >
        {done ? <Check size={13} /> : <Minus size={13} />}
      </span>
      <div className="min-w-0">
        <p className="text-sm font-medium text-zinc-100">{title}</p>
        <p className="mt-0.5 text-xs text-zinc-400">{detail}</p>
      </div>
    </li>
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The last step: what is set up and what is not, read from the workspace
 * itself (so it is right after a resume too). Anything left shows on the
 * Dashboard's Getting started list.
 */
export function DoneStep({ onFinish, onBack, finishing, error }: {
  onFinish: () => void;
  onBack: () => void;
  finishing: boolean;
  error: string | null;
}) {
  const brand = useBrand();
  const { team, projects, businessSettings } = useApp();
  const { teamMemberId } = useAuth();
  const { enabled } = useModuleSwitch();
  const checks = useRead(setupChecksRead);

  const preset = presetFor(enabled);
  const people = team.filter((member) => member.id !== teamMemberId && member.role !== 'agent').length;
  const liveProjects = projects.filter((project) => !project.archived_at).length;
  const branded = brand.name !== DEFAULT_BRAND.name || !!brand.logos.light;
  const billingOn = enabled.includes('billing');
  const billingName = businessSettings?.business_name?.trim();
  const leftCount = [!branded, people === 0, liveProjects === 0, billingOn && !billingName].filter(Boolean).length;

  return (
    <StepFrame
      title="You're all set"
      description={leftCount
        ? 'Here is what you set up. What is left waits on your Dashboard, under Getting started.'
        : 'Here is what you set up. Your workspace is ready.'}
      onSubmit={onFinish}
      onBack={onBack}
      busy={finishing}
      busyLabel="Opening"
      primaryLabel="Go to your Dashboard"
      error={error}
    >
      <ul className="divide-y divide-white/[0.06]">
        <SummaryRow done={branded} title="Your workspace" detail={branded ? `Named ${brand.name}${brand.logos.light ? ', with your logo' : ''}.` : 'Default name and color for now.'} />
        <SummaryRow
          done
          title="Features"
          detail={preset ? `${PRESETS[preset].label}: ${enabled.length === MODULE_IDS.length ? 'everything on' : `${enabled.length} of ${MODULE_IDS.length} parts on`}.` : `${enabled.length} of ${MODULE_IDS.length} parts on.`}
        />
        {billingOn && (
          <SummaryRow done={!!billingName} title="Billing details" detail={billingName ? `Invoices come from ${billingName}.` : 'Not added yet.'} />
        )}
        <SummaryRow
          done={!!checks.data?.emailConfigured}
          title="Email"
          detail={checks.data?.emailConfigured ? 'Invites and notifications go out by email.' : 'Not set up. Invites use links you send yourself.'}
        />
        <SummaryRow done={people > 0} title="Team" detail={people > 0 ? `${plural(people, 'person', 'people')} besides you.` : 'Just you for now.'} />
        <SummaryRow done={liveProjects > 0} title="Projects" detail={liveProjects > 0 ? `${plural(liveProjects, 'project')} ready.` : 'None yet.'} />
      </ul>
    </StepFrame>
  );
}
