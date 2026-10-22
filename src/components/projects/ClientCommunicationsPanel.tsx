'use client';

import { useState } from 'react';
import {
  Bell,
  BellOff,
  X as XIcon,
  Plus,
  AlertCircle,
  FileText,
  Sparkles,
} from 'lucide-react';
import { useApp } from '@/lib/store';
import { useDemo } from '@/lib/demo-context';
import { toast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/inputs/Select';
import { NumberInput } from '@/components/ui/inputs/NumberInput';
import { Toggle } from '@/components/ui/inputs/Toggle';
import { RailCard } from '@/components/projects/TabLayout';
import { COMM_TYPE_LABELS } from './ClientCommunicationsLogPanel';
import ClientEmailPreviewModal from './ClientEmailPreviewModal';
import type { ClientCommType, AlertMode } from '@/lib/types';

const SEND_ACTIONS: { type: ClientCommType; label: string; hint: string; icon: typeof Sparkles }[] = [
  { type: 'portal_welcome', label: 'Send portal welcome', hint: 'Introduce the portal to the primary client', icon: Sparkles },
  { type: 'project_summary', label: 'Send project summary', hint: 'Share a status update and current balance', icon: FileText },
];

const ALERT_MODE_OPTIONS: { value: AlertMode; label: string }[] = [
  { value: 'percentage', label: 'Percentage of budget' },
  { value: 'dollar_interval', label: 'Every N dollars tracked' },
  { value: 'none', label: 'No automated alerts' },
];

/**
 * The emails a person sends by hand (portal welcome, project summary), as the
 * Communication tab's toolbar buttons. Each opens the preview before sending.
 */
export function SendClientEmailButtons({ projectId, onSent }: { projectId: string; onSent?: () => void }) {
  const { getPrimaryClient } = useApp();
  const { isDemoMode } = useDemo();
  const hasPrimaryEmail = !!getPrimaryClient(projectId)?.contact?.email;
  const [manualType, setManualType] = useState<ClientCommType | null>(null);

  // Kept clickable without a primary email so the reason is said, not hidden.
  const open = (type: ClientCommType) => {
    if (!hasPrimaryEmail) {
      toast('error', 'Set a primary client contact with an email first');
      return;
    }
    if (isDemoMode) {
      toast('success', `${COMM_TYPE_LABELS[type]} email sent (demo)`);
      return;
    }
    setManualType(type);
  };

  return (
    <>
      {SEND_ACTIONS.map(({ type, label, hint, icon: Icon }) => (
        <Button key={type} variant="secondary" icon={<Icon size={16} aria-hidden="true" />} onClick={() => open(type)} title={hint}>
          {label}
        </Button>
      ))}
      {manualType && (
        <ClientEmailPreviewModal
          open
          onClose={() => setManualType(null)}
          projectId={projectId}
          manual={{ type: manualType }}
          onCompleted={onSent}
        />
      )}
    </>
  );
}

/**
 * Budget alert automation, set once per project. Lives in the Sent view's
 * rail; the settings are portal settings, so it asks for the portal first.
 */
export function CommunicationAutomationCard({ projectId, onOpenPortal }: { projectId: string; onOpenPortal?: () => void }) {
  const { getPortalSettings, getProject, upsertPortalSettings } = useApp();

  const project = getProject(projectId);
  const settings = getPortalSettings(projectId);

  const [newThreshold, setNewThreshold] = useState<number | ''>('');
  const [dollarIntervalInput, setDollarIntervalInput] = useState<number | ''>(settings?.dollar_interval ?? '');
  // A saved change (here or elsewhere) resets the field, adjusted during render.
  const [syncedInterval, setSyncedInterval] = useState(settings?.dollar_interval);
  if (settings?.dollar_interval !== syncedInterval) {
    setSyncedInterval(settings?.dollar_interval);
    setDollarIntervalInput(settings?.dollar_interval ?? '');
  }

  const alertMode: AlertMode = settings?.alert_mode ?? 'percentage';
  const requireApproval = settings?.require_alert_approval ?? true;
  const rearmOnBudgetChange = settings?.rearm_thresholds_on_budget_change ?? false;
  const thresholds = settings?.notification_thresholds ?? [50, 75, 90, 100];
  const hasBudget = !!(project?.budget_type && project?.budget_value);

  const handleAddThreshold = () => {
    const val = typeof newThreshold === 'number' ? Math.round(newThreshold) : NaN;
    if (isNaN(val) || val < 1 || val > 100) {
      toast('error', 'Enter a number between 1 and 100');
      return;
    }
    if (thresholds.includes(val)) {
      toast('error', 'Threshold already exists');
      setNewThreshold('');
      return;
    }
    upsertPortalSettings(projectId, { notification_thresholds: [...thresholds, val].sort((a, b) => a - b) });
    setNewThreshold('');
  };

  const handleDollarIntervalCommit = () => {
    if (dollarIntervalInput === '') {
      if (settings?.dollar_interval != null) upsertPortalSettings(projectId, { dollar_interval: null });
      return;
    }
    if (dollarIntervalInput <= 0) {
      setDollarIntervalInput(settings?.dollar_interval ?? '');
      toast('error', 'Enter a positive dollar amount');
      return;
    }
    if (dollarIntervalInput !== settings?.dollar_interval) {
      upsertPortalSettings(projectId, { dollar_interval: dollarIntervalInput });
    }
  };

  return (
    <RailCard title="Automation" icon={<Bell size={16} className="text-zinc-400" aria-hidden="true" />}>
      {!settings?.enabled ? (
        <div className="space-y-3">
          <p className="text-sm text-zinc-400">
            Budget alerts go out through the client portal. Turn the portal on to set them up.
          </p>
          {onOpenPortal && (
            <Button variant="secondary" size="sm" onClick={onOpenPortal}>Open client portal</Button>
          )}
        </div>
      ) : (
        <div className="space-y-5">
          <div className="space-y-2">
            <Select
              label="Budget alerts"
              options={ALERT_MODE_OPTIONS}
              value={alertMode}
              onChange={(mode) => upsertPortalSettings(projectId, { alert_mode: mode as AlertMode })}
              size="sm"
            />
          </div>

          {alertMode === 'percentage' && (
            <div className="space-y-3">
              <p className="text-xs text-zinc-400">
                An alert goes out when tracked work reaches each percentage of the budget.
              </p>
              {hasBudget ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  {thresholds.map((t) => (
                    <span
                      key={t}
                      className="inline-flex items-center gap-1 pl-2 pr-1 py-1 rounded-md bg-brand-500/15 border border-brand-500/30 text-brand-300 text-xs font-medium"
                    >
                      {t}%
                      <button
                        type="button"
                        onClick={() => upsertPortalSettings(projectId, { notification_thresholds: thresholds.filter((x) => x !== t) })}
                        className="p-0.5 rounded text-brand-400 hover:text-red-400 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                        aria-label={`Remove ${t}% threshold`}
                      >
                        <XIcon size={11} />
                      </button>
                    </span>
                  ))}
                  <div className="flex items-center gap-1">
                    <div className="w-20">
                      <NumberInput
                        size="sm"
                        aria-label="New threshold percentage"
                        value={newThreshold}
                        onChange={setNewThreshold}
                        onKeyDown={(e) => e.key === 'Enter' && handleAddThreshold()}
                        min={1}
                        max={100}
                        placeholder="%"
                        suffix="%"
                        showButtons={false}
                      />
                    </div>
                    <button
                      type="button"
                      onClick={handleAddThreshold}
                      className="p-1.5 rounded-md text-zinc-400 hover:text-white hover:bg-white/[0.06] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                      aria-label="Add threshold"
                    >
                      <Plus size={14} />
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-2 px-3 py-2 rounded-md bg-amber-500/15 border border-amber-500/30 text-xs text-amber-300">
                  <AlertCircle size={12} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
                  Set a project budget to enable threshold alerts.
                </div>
              )}

              <SettingRow
                title="Rearm after budget changes"
                body={rearmOnBudgetChange
                  ? 'A budget change starts a new period; thresholds can fire again.'
                  : 'Each threshold fires once per project, whatever the budget does.'}
                checked={rearmOnBudgetChange}
                onChange={(next) => upsertPortalSettings(projectId, { rearm_thresholds_on_budget_change: next })}
              />
            </div>
          )}

          {alertMode === 'dollar_interval' && (
            <div className="space-y-2">
              <p className="text-xs text-zinc-400">
                An alert goes out each time tracked work crosses another multiple of this amount.
              </p>
              <NumberInput
                size="sm"
                aria-label="Dollar amount per alert"
                value={dollarIntervalInput}
                onChange={setDollarIntervalInput}
                onBlur={handleDollarIntervalCommit}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                }}
                min={1}
                placeholder="500"
                prefix="$"
                suffix="per alert"
                showButtons={false}
              />
            </div>
          )}

          {alertMode === 'none' && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-md bg-white/[0.03] border border-white/[0.08] text-xs text-zinc-300">
              <BellOff size={12} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
              Automated budget alerts are off. The Send buttons above still work any time.
            </div>
          )}

          <div className="pt-4 border-t border-white/[0.06]">
            <SettingRow
              title="Approve alerts before they send"
              body={requireApproval
                ? 'Alerts wait at the top of Sent until you approve or dismiss them.'
                : 'Alerts send the moment they fire, with no review.'}
              checked={requireApproval}
              onChange={(next) => upsertPortalSettings(projectId, { require_alert_approval: next })}
            />
          </div>
        </div>
      )}
    </RailCard>
  );
}

/** A setting with its explanation on the left and the switch on the right. */
function SettingRow({ title, body, checked, onChange }: { title: string; body: string; checked: boolean; onChange: (next: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm text-zinc-100">{title}</p>
        <p className="text-xs text-zinc-400 mt-0.5">{body}</p>
      </div>
      <Toggle size="sm" checked={checked} onChange={onChange} aria-label={title} className="flex-shrink-0 pt-0.5" />
    </div>
  );
}
