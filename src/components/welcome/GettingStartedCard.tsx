'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Check, X } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { useBrand } from '@/lib/brand/context';
import { DEFAULT_BRAND } from '@/lib/brand';
import { gettingStartedLeft, type GettingStartedItem } from '@/lib/setup/gate';
import { useModuleSwitch } from '@/components/settings/workspace/workspace-modules';

const ITEMS: Record<GettingStartedItem, { label: string; line: string; href: string }> = {
  brand: { label: 'Add your brand', line: 'Your name, logo and color.', href: '/settings/workspace#brand' },
  team: { label: 'Invite your team', line: 'Each person chooses their own password.', href: '/team' },
  project: { label: 'Create a project', line: 'One per client, brand or piece of work.', href: '/projects' },
  billing: { label: 'Add billing details', line: 'Who invoices are from and when they are due.', href: '/settings/billing' },
};

/** Shown for a month after setup; older workspaces never see it appear. */
const SHOW_FOR_MS = 30 * 24 * 60 * 60 * 1000;

const dismissKey = (memberId: string | null) => `getting-started-dismissed:${memberId ?? 'me'}`;

/**
 * After the setup wizard: what the Owner skipped, as a short checklist at
 * the top of the Dashboard. Each item checks itself off from the workspace
 * (a brand, someone besides the Owners, a project, billing details with
 * Client invoicing on), the card leaves once all are done, and Hide puts
 * it away for good on this device.
 */
export function GettingStartedCard() {
  const { enabled, read, isOwner, isDemoMode } = useModuleSwitch();
  const { team, projects, businessSettings } = useApp();
  const { teamMemberId } = useAuth();
  const brand = useBrand();
  // Read in the browser after mount: the hidden flag lives in this device's storage, and the clock is now.
  const [local, setLocal] = useState<{ dismissed: boolean; now: number } | null>(null);

  useEffect(() => {
    let dismissed = false;
    try {
      dismissed = window.localStorage.getItem(dismissKey(teamMemberId)) === '1';
    } catch {
      // Storage blocked: shown until hidden for this visit.
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLocal({ dismissed, now: Date.now() });
  }, [teamMemberId]);

  if (!isOwner || isDemoMode || !local || local.dismissed) return null;
  const state = read.data?.status === 'ready' ? read.data : null;
  if (!state?.setupCompleted || !state.setupCompletedAt) return null;
  if (local.now - new Date(state.setupCompletedAt).getTime() > SHOW_FOR_MS) return null;

  const billingOn = enabled.includes('billing');
  const input = {
    brandSet: brand.name !== DEFAULT_BRAND.name || !!brand.logos.light,
    teamInvited: team.some((member) => member.role !== 'owner' && member.role !== 'agent'),
    hasProject: projects.some((project) => !project.archived_at),
    billingOn,
    billingDetailsSet: !!businessSettings?.business_name?.trim(),
  };
  const left = new Set(gettingStartedLeft(input));
  if (left.size === 0) return null;
  const all: GettingStartedItem[] = ['brand', 'team', 'project', ...(billingOn ? ['billing' as const] : [])];
  const doneCount = all.length - left.size;

  const hide = () => {
    setLocal({ ...local, dismissed: true });
    try {
      window.localStorage.setItem(dismissKey(teamMemberId), '1');
    } catch {
      // Hidden for this visit only.
    }
  };

  return (
    <section aria-labelledby="getting-started-title" className="glass-card rounded-xl p-4 lg:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="getting-started-title" className="font-semibold text-white">Getting started</h2>
          <p className="mt-0.5 text-sm text-zinc-400">{doneCount} of {all.length} done. Finish setting up your workspace.</p>
        </div>
        <button
          type="button"
          onClick={hide}
          className="-mr-1 -mt-1 flex-shrink-0 rounded-lg p-1.5 text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          aria-label="Hide Getting started"
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <ul className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {all.map((id) => {
          const item = ITEMS[id];
          const done = !left.has(id);
          return (
            <li key={id}>
              {done ? (
                <div className="flex h-full items-start gap-2.5 rounded-lg bg-white/[0.02] p-3">
                  <span role="img" aria-label="Done" className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-emerald-500/[0.14] text-emerald-300">
                    <Check size={12} />
                  </span>
                  <span className="text-sm text-zinc-400 line-through decoration-zinc-600">{item.label}</span>
                </div>
              ) : (
                <Link
                  href={item.href}
                  className="group flex h-full items-start gap-2.5 rounded-lg bg-white/[0.04] p-3 ring-1 ring-inset ring-white/[0.06] transition-colors hover:bg-white/[0.06] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                >
                  <span aria-hidden="true" className="mt-0.5 h-5 w-5 flex-shrink-0 rounded-full ring-1 ring-inset ring-white/[0.2]" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1 text-sm font-medium text-zinc-100">
                      {item.label}
                      <ArrowRight size={13} className="text-zinc-400 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" aria-hidden="true" />
                    </span>
                    <span className="mt-0.5 block text-xs text-zinc-400">{item.line}</span>
                  </span>
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
