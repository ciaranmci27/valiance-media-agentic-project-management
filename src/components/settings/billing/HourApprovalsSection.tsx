'use client';

import { useState } from 'react';
import { ClipboardCheck } from 'lucide-react';
import { useApp } from '@/lib/store';
import { Toggle } from '@/components/ui/inputs/Toggle';
import { toast } from '@/components/ui/Toast';
import { useDemo } from '@/lib/demo-context';
import { useAuth } from '@/lib/auth-context';
import { isModuleEnabled } from '@/lib/access-control';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';

/**
 * Settings > Billing > Hour approvals, shown while Client invoicing or Team
 * pay is on: whether people's finished hours count at once or wait for a
 * reviewer. With both off no money rides on hours, so every finished entry
 * is approved as it is logged and there is no policy to set. The switch
 * saves on change; switching it back is the undo.
 */
export function HourApprovalsSection() {
  const { businessSettings, updateBusinessSettings } = useApp();
  const { isDemoMode } = useDemo();
  const { access } = useAuth();
  const isInvoicingOn = isModuleEnabled(access, 'billing');
  const isPayOn = isModuleEnabled(access, 'team_pay');
  const isAgentsOn = isModuleEnabled(access, 'agents');

  const autoApprove = businessSettings?.auto_approve_human_hours ?? true;
  const [saving, setSaving] = useState(false);
  const toggle = async (next: boolean) => {
    if (saving) return;
    setSaving(true);
    try {
      await updateBusinessSettings({ auto_approve_human_hours: next });
      toast('success', next ? 'Hours now approve as logged' : 'Hours now wait for review');
    } finally {
      setSaving(false);
    }
  };

  const countsToward = isInvoicingOn && isPayOn ? 'invoices and pay' : isInvoicingOn ? 'invoices' : 'pay';

  return (
    <section className="glass-card rounded-xl p-4 lg:p-5">
      <SettingsSectionHeader
        icon={ClipboardCheck}
        title="Hour approvals"
        description={`Whether finished hours count toward ${countsToward} at once, or wait for someone who approves time.`}
      />
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-white">Auto-approve people&apos;s hours</p>
          <p className="mt-1 text-xs leading-relaxed text-zinc-400">
            On, your team&apos;s finished sessions are approved as they are logged. Off, they wait for review
            on the Time tab in Finances. An Owner&apos;s own hours never wait.
          </p>
          {isAgentsOn && (
            <p className="mt-1 text-xs leading-relaxed text-zinc-400">
              {isInvoicingOn
                ? 'AI agent hours always wait for review, since their billed time is converted with the agent’s multiplier.'
                : 'AI agent hours always wait for review.'}
            </p>
          )}
        </div>
        <Toggle
          checked={autoApprove}
          onChange={toggle}
          disabled={saving || isDemoMode || !businessSettings}
          aria-label="Auto-approve people's hours"
          className="mt-0.5 flex-shrink-0"
        />
      </div>
    </section>
  );
}
